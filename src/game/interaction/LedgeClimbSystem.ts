import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { HandSide, HangingCharacterState, LedgeGrabState } from '../types';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { PlayerCharacter } from '../character/PlayerCharacter';
import type { ProceduralAudio } from '../audio';
import { HandTargetingSystem, MAX_INTERACTION_DISTANCE } from './HandTargetingSystem';

// Hanging & climbing physics calibration (6.5 kg character at 60 Hz fixed timestep)
const HAND_REST_LEN_HANG = 0.5;
const HAND_REST_LEN_CLIMB_MIN = 0.1;
const HANG_WALL_CLEARANCE = 0.45;
const TWO_HAND_MIN_SPACING = 0.24;
const TWO_HAND_TARGET_OFFSET = 0.26;

const ARM_STIFFNESS_SINGLE = 340; // N/m (ωn*dt = 0.12 << 1 at 60 Hz)
const ARM_STIFFNESS_DUAL_EACH = 240; // N/m per hand (480 N/m combined)
const ARM_DAMPING_RATIO = 0.68;
const MAX_ARM_TENSION_SINGLE = 160; // N
const MAX_ARM_TENSION_DUAL_EACH = 125; // N
const ARM_LEVER_SCALE = 0.55; // True COM-relative shoulder lever arm produces authentic pendulum tilt & sway

const SHIMMY_SPEED_SINGLE = 1.55; // m/s
const SHIMMY_SPEED_DUAL = 2.2; // m/s
const SHIMMY_MAX_FORCE = 72; // N

const MANTLE_HOIST_MAX_FORCE_SINGLE = 175; // N
const MANTLE_HOIST_MAX_FORCE_DUAL = 220; // N
const MANTLE_DEFAULT_INSET = 0.42; // Lands cleanly centered on 0.85m parapets & walls
const MANTLE_COOLDOWN_SECONDS = 0.35;
const MAX_HANG_STRETCH = 3.25;

// Pre-allocated scratch objects (zero GC per physics step)
const _attachLocal = new CANNON.Vec3();
const _attachWorld = new CANNON.Vec3();
const _attachVel = new CANNON.Vec3();
const _forceVec = new CANNON.Vec3();
const _applyPoint = new CANNON.Vec3();
const _cannonFrom = new CANNON.Vec3();
const _cannonTo = new CANNON.Vec3();
const _cannonWorldPt = new CANNON.Vec3();
const _cannonLocalPt = new CANNON.Vec3();

const _shoulderPos = new THREE.Vector3();
const _midAnchor = new THREE.Vector3();
const _wallNormal = new THREE.Vector3();
const _intoWall = new THREE.Vector3();
const _ledgeRight = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _probePos = new THREE.Vector3();
const _probeNormal = new THREE.Vector3();
const _nextLeftPos = new THREE.Vector3();
const _nextLeftNorm = new THREE.Vector3();
const _nextRightPos = new THREE.Vector3();
const _nextRightNorm = new THREE.Vector3();

export class LedgeClimbSystem {
  private readonly targeting: HandTargetingSystem;
  private readonly player: PlayerCharacter;
  private readonly physics: PhysicsWorld;
  private readonly audio: ProceduralAudio;
  private readonly isHandBusyWithBlock?: (side: HandSide) => boolean;

  private leftGrab: LedgeGrabState | null = null;
  private rightGrab: LedgeGrabState | null = null;

  private isMantling = false;
  private mantlePhase: 'hoist' | 'vault' = 'hoist';
  private mantleTimer = 0;
  private mantleCooldown = 0;
  private mantleSafeInset = MANTLE_DEFAULT_INSET;
  private readonly mantleAnchor = new THREE.Vector3();
  private readonly mantleWallNormal = new THREE.Vector3(0, 0, 1);
  private mantleTopY = 0;
  private mantleHandCount = 1;

  private climbPullBlend = 0;
  private hangElapsed = 0;
  private currentShimmySpeed = 0;
  private currentStretchAmount = 0;

  private readonly hangingStateOut: HangingCharacterState = {
    isHanging: false,
    isClimbing: false,
    handCount: 0,
    wallNormalX: 0,
    wallNormalZ: 1,
    stretchAmount: 0,
    shimmySpeed: 0,
  };

  constructor(
    targeting: HandTargetingSystem,
    player: PlayerCharacter,
    physics: PhysicsWorld,
    audio: ProceduralAudio,
    isHandBusyWithBlock?: (side: HandSide) => boolean,
  ) {
    this.targeting = targeting;
    this.player = player;
    this.physics = physics;
    this.audio = audio;
    this.isHandBusyWithBlock = isHandBusyWithBlock;
  }

  private getSlot(side: HandSide): LedgeGrabState | null {
    return side === 'left' ? this.leftGrab : this.rightGrab;
  }

  private setSlot(side: HandSide, state: LedgeGrabState | null): void {
    if (side === 'left') {
      this.leftGrab = state;
    } else {
      this.rightGrab = state;
    }
  }

  private getOtherSlot(side: HandSide): LedgeGrabState | null {
    return side === 'left' ? this.rightGrab : this.leftGrab;
  }

  /**
   * Probes whether a candidate point along a ledge continues on solid static geometry,
   * returning the exact refined lip world position and wall normal.
   */
  private probeLedgeAt(
    expectedBody: CANNON.Body,
    candX: number,
    candZ: number,
    refTopY: number,
    refWallNormal: THREE.Vector3,
    outPos: THREE.Vector3,
    outNormal: THREE.Vector3,
  ): boolean {
    // 1. Check top surface slightly inward from the wall edge
    const probeInX = candX - refWallNormal.x * 0.16;
    const probeInZ = candZ - refWallNormal.z * 0.16;
    _cannonFrom.set(probeInX, refTopY + 0.42, probeInZ);
    _cannonTo.set(probeInX, refTopY - 0.35, probeInZ);

    let topY = -Infinity;
    let foundTop = false;
    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (res: CANNON.RaycastResult) => {
        if (!res.hasHit || !res.body || res.body.type !== CANNON.Body.STATIC) return;
        if (res.hitNormalWorld.y <= 0.72) return;
        if (Math.abs(res.hitPointWorld.y - refTopY) > 0.25) return;
        if (res.hitPointWorld.y > topY) {
          topY = res.hitPointWorld.y;
          foundTop = true;
        }
      },
    );
    if (!foundTop) return false;

    // 2. Check outward clearance at shoulder/head height so shimmying never clips into a corner wall
    _cannonFrom.set(
      candX + refWallNormal.x * 0.38,
      topY - 0.08,
      candZ + refWallNormal.z * 0.38,
    );
    _cannonTo.set(
      candX - refWallNormal.x * 0.28,
      topY - 0.08,
      candZ - refWallNormal.z * 0.28,
    );

    let minDist = Infinity;
    let foundEdge = false;
    let edgeX = candX;
    let edgeZ = candZ;
    let nx = refWallNormal.x;
    let nz = refWallNormal.z;

    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (res: CANNON.RaycastResult) => {
        if (!res.hasHit || !res.body || res.body.type !== CANNON.Body.STATIC) return;
        if (Math.abs(res.hitNormalWorld.y) > 0.45) return;
        if (res.distance < minDist) {
          minDist = res.distance;
          foundEdge = true;
          edgeX = res.hitPointWorld.x;
          edgeZ = res.hitPointWorld.z;
          const nl = Math.hypot(res.hitNormalWorld.x, res.hitNormalWorld.z);
          if (nl > 0.05) {
            nx = res.hitNormalWorld.x / nl;
            nz = res.hitNormalWorld.z / nl;
          }
        }
      },
    );

    if (!foundEdge) return false;
    // Reject sudden perpendicular corners (keep shimmying smooth along the current wall face)
    if (nx * refWallNormal.x + nz * refWallNormal.z < 0.75) {
      return false;
    }

    // 3. Verify headroom above the candidate ledge spot
    _cannonFrom.set(edgeX - nx * 0.2, topY + 0.08, edgeZ - nz * 0.2);
    _cannonTo.set(edgeX - nx * 0.2, topY + 0.74, edgeZ - nz * 0.2);
    let blockedAbove = false;
    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (res: CANNON.RaycastResult) => {
        if (res.hasHit && res.body && res.body.type === CANNON.Body.STATIC) {
          blockedAbove = true;
        }
      },
    );
    if (blockedAbove) return false;

    void expectedBody;
    outPos.set(edgeX, topY, edgeZ);
    outNormal.set(nx, 0, nz);
    return true;
  }

  private probeSafeMantleInset(anchor: THREE.Vector3, wallNormal: THREE.Vector3, topY: number): number {
    const candidates = [MANTLE_DEFAULT_INSET, 0.34, 0.26];
    for (const inset of candidates) {
      const testX = anchor.x - wallNormal.x * inset;
      const testZ = anchor.z - wallNormal.z * inset;
      _cannonFrom.set(testX, topY + 0.45, testZ);
      _cannonTo.set(testX, topY - 0.25, testZ);

      let hasSurface = false;
      this.physics.world.raycastAll(
        _cannonFrom,
        _cannonTo,
        { skipBackfaces: true },
        (res: CANNON.RaycastResult) => {
          if (
            res.hasHit &&
            res.body &&
            res.body.type === CANNON.Body.STATIC &&
            res.hitNormalWorld.y > 0.72 &&
            Math.abs(res.hitPointWorld.y - topY) < 0.2
          ) {
            hasSurface = true;
          }
        },
      );

      if (hasSurface) {
        return inset;
      }
    }
    return 0.3;
  }

  private tryAcquireLedgeGrab(side: HandSide): void {
    if (this.mantleCooldown > 0) return;
    if (this.getSlot(side)) return;
    if (this.isHandBusyWithBlock?.(side)) return;
    if (!this.targeting.isHandInputHeld(side)) return;

    const target = this.targeting.getGrabAnchorForPhysics(side);
    if (!target || target.surfaceKind !== 'ledge' || !target.ledgeId) return;
    if (target.distanceFromShoulder > MAX_INTERACTION_DISTANCE) return;

    const worldAnchor = target.worldPoint.clone();
    const wallNormal = target.wallNormal.clone();
    let ledgeTopY = target.ledgeTopY;

    // If the other hand already grips this ledge at nearly the same point, offset slightly along the ledge
    // so both hands form a natural shoulder-width two-hand grip.
    const other = this.getOtherSlot(side);
    if (other && other.body === target.body && worldAnchor.distanceTo(other.worldAnchor) < TWO_HAND_MIN_SPACING) {
      const sideSign = side === 'left' ? -1 : 1;
      // ledgeRight = (wallNormal.z, 0, -wallNormal.x) when facing into wall (-wallNormal)
      const rightX = wallNormal.z;
      const rightZ = -wallNormal.x;
      const candX = other.worldAnchor.x + rightX * sideSign * TWO_HAND_TARGET_OFFSET;
      const candZ = other.worldAnchor.z + rightZ * sideSign * TWO_HAND_TARGET_OFFSET;

      if (
        this.probeLedgeAt(
          target.body,
          candX,
          candZ,
          ledgeTopY,
          wallNormal,
          _probePos,
          _probeNormal,
        )
      ) {
        worldAnchor.copy(_probePos);
        wallNormal.copy(_probeNormal);
        ledgeTopY = _probePos.y;
      }
    }

    _cannonWorldPt.set(worldAnchor.x, worldAnchor.y, worldAnchor.z);
    target.body.pointToLocalFrame(_cannonWorldPt, _cannonLocalPt);

    const grabState: LedgeGrabState = {
      side,
      ledgeId: target.ledgeId,
      body: target.body,
      localAnchor: _cannonLocalPt.clone(),
      worldAnchor,
      wallNormal,
      ledgeTopY,
      mode: this.isMantling ? 'climb' : 'hang',
    };

    this.setSlot(side, grabState);
    this.player.body.wakeUp();
    this.targeting.setLedgeGrabState(
      side,
      true,
      grabState.body,
      grabState.ledgeId,
      grabState.worldAnchor,
      grabState.wallNormal,
      grabState.ledgeTopY,
      grabState.mode,
    );
    this.audio.playLedgeGrab(side);
  }

  public releaseHand(side: HandSide, playAudio = true): void {
    const grab = this.getSlot(side);
    if (!grab) return;

    // Preserve natural momentum on release (never freeze or zero body velocity)
    this.player.body.wakeUp();
    this.setSlot(side, null);
    this.targeting.setLedgeGrabState(side, false);

    if (playAudio) {
      this.audio.playGrabRelease(side);
    }

    // If both hands are released while still below the lip (or hanging), stop climbing & fall naturally
    if (!this.leftGrab && !this.rightGrab && (!this.isMantling || this.mantlePhase === 'hoist')) {
      this.isMantling = false;
      this.mantleTimer = 0;
      this.climbPullBlend = 0;
      this.hangElapsed = 0;
      this.currentShimmySpeed = 0;
      this.currentStretchAmount = 0;
      this.pushHangingStateToPlayer();
    }
  }

  public releaseAll(playAudio = false): void {
    this.releaseHand('left', playAudio);
    this.releaseHand('right', playAudio);
    this.isMantling = false;
    this.mantlePhase = 'hoist';
    this.mantleTimer = 0;
    this.climbPullBlend = 0;
    this.hangElapsed = 0;
    this.currentShimmySpeed = 0;
    this.currentStretchAmount = 0;
    this.pushHangingStateToPlayer();
  }

  private validateGrabSlot(side: HandSide): LedgeGrabState | null {
    const grab = this.getSlot(side);
    if (!grab) return null;

    if (!this.targeting.isHandInputHeld(side)) {
      this.releaseHand(side, true);
      return null;
    }

    // Sync world anchor from static physics body frame
    grab.body.pointToWorldFrame(grab.localAnchor, _cannonWorldPt);
    grab.worldAnchor.set(_cannonWorldPt.x, _cannonWorldPt.y, _cannonWorldPt.z);

    // Measure shoulder-to-anchor stretch directly from live Cannon-es body frame
    const sideSign = side === 'left' ? -1 : 1;
    _attachLocal.set(sideSign * 0.33, 0.25, 0);
    this.player.body.pointToWorldFrame(_attachLocal, _attachWorld);
    _shoulderPos.set(_attachWorld.x, _attachWorld.y, _attachWorld.z);
    const stretch = _shoulderPos.distanceTo(grab.worldAnchor);
    if (stretch > MAX_HANG_STRETCH) {
      this.releaseHand(side, true);
      return null;
    }

    return grab;
  }

  private beginMantle(
    midAnchor: THREE.Vector3,
    wallNormal: THREE.Vector3,
    topY: number,
    handCount: number,
  ): void {
    if (this.isMantling) return;
    this.isMantling = true;
    this.mantlePhase = this.player.body.position.y >= topY + 0.68 ? 'vault' : 'hoist';
    this.mantleTimer = 0;
    this.mantleAnchor.copy(midAnchor);
    this.mantleWallNormal.copy(wallNormal);
    this.mantleTopY = topY;
    this.mantleHandCount = Math.max(1, handCount);
    this.mantleSafeInset = this.probeSafeMantleInset(midAnchor, wallNormal, topY);
    this.player.body.wakeUp();
    this.audio.playClimbEffort();
  }

  private completeMantle(): void {
    this.isMantling = false;
    this.mantlePhase = 'hoist';
    this.mantleTimer = 0;
    this.mantleCooldown = MANTLE_COOLDOWN_SECONDS;
    this.climbPullBlend = 0;
    this.currentShimmySpeed = 0;
    this.currentStretchAmount = 0;
    // Release hand grabs silently so character stands smoothly on top of the platform
    if (this.leftGrab) {
      this.leftGrab = null;
      this.targeting.setLedgeGrabState('left', false);
    }
    if (this.rightGrab) {
      this.rightGrab = null;
      this.targeting.setLedgeGrabState('right', false);
    }
    this.pushHangingStateToPlayer();
  }

  /**
   * Synchronizes current hanging/climbing status into PlayerCharacter BEFORE PlayerCharacter.applyPreStepForces
   * so PlayerCharacter knows whether to soften upright torque and defer Space to ledge pull-up.
   */
  public pushHangingStateToPlayer(): void {
    const left = this.leftGrab;
    const right = this.rightGrab;
    const handCount = (left ? 1 : 0) + (right ? 1 : 0);
    const active = handCount > 0 || this.isMantling;

    if (!active) {
      this.hangingStateOut.isHanging = false;
      this.hangingStateOut.isClimbing = false;
      this.hangingStateOut.handCount = 0;
      this.hangingStateOut.stretchAmount = 0;
      this.hangingStateOut.shimmySpeed = 0;
      this.player.setHangingState(this.hangingStateOut);
      return;
    }

    if (left && right) {
      _wallNormal.addVectors(left.wallNormal, right.wallNormal);
      if (_wallNormal.lengthSq() > 0.0001) {
        _wallNormal.normalize();
      } else {
        _wallNormal.copy(left.wallNormal);
      }
    } else if (left) {
      _wallNormal.copy(left.wallNormal);
    } else if (right) {
      _wallNormal.copy(right.wallNormal);
    } else {
      _wallNormal.copy(this.mantleWallNormal);
    }

    this.hangingStateOut.isHanging = true;
    this.hangingStateOut.isClimbing = this.isMantling || this.climbPullBlend > 0.32;
    this.hangingStateOut.handCount = Math.max(handCount, this.isMantling ? this.mantleHandCount : 0);
    this.hangingStateOut.wallNormalX = _wallNormal.x;
    this.hangingStateOut.wallNormalZ = _wallNormal.z;
    this.hangingStateOut.stretchAmount = this.currentStretchAmount;
    this.hangingStateOut.shimmySpeed = this.currentShimmySpeed;
    this.player.setHangingState(this.hangingStateOut);
  }

  /**
   * Called inside the fixed 60 Hz Cannon-es physics substep.
   * Applies physics-based suspension forces, pendulum swinging, sideways shimmying, and climbing/mantling.
   */
  public applyPreStepForces(
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
    consumeJump: () => boolean,
    isJumpHeld: boolean,
  ): void {
    if (this.mantleCooldown > 0) {
      this.mantleCooldown = Math.max(0, this.mantleCooldown - fixedDt);
    }

    const left = this.validateGrabSlot('left');
    const right = this.validateGrabSlot('right');
    const handCount = (left ? 1 : 0) + (right ? 1 : 0);

    // If neither hand is holding, only finish an already-vaulting mantle (already above the ledge lip)
    if (handCount === 0) {
      if (this.isMantling && this.mantlePhase === 'vault') {
        this.stepMantlePhysics(fixedDt);
        this.pushHangingStateToPlayer();
      } else {
        this.isMantling = false;
        this.climbPullBlend = 0;
        this.hangElapsed = 0;
        this.currentShimmySpeed = 0;
        this.currentStretchAmount = 0;
        this.pushHangingStateToPlayer();
      }
      return;
    }

    this.hangElapsed += fixedDt;

    // Compute combined anchor, normal, and ledge basis vectors
    if (left && right) {
      _midAnchor.addVectors(left.worldAnchor, right.worldAnchor).multiplyScalar(0.5);
      _wallNormal.addVectors(left.wallNormal, right.wallNormal);
      if (_wallNormal.lengthSq() > 0.0001) {
        _wallNormal.normalize();
      } else {
        _wallNormal.copy(left.wallNormal);
      }
    } else {
      const single = (left ?? right)!;
      _midAnchor.copy(single.worldAnchor);
      _wallNormal.copy(single.wallNormal);
    }

    const topY = left && right ? Math.max(left.ledgeTopY, right.ledgeTopY) : (left ?? right)!.ledgeTopY;
    _intoWall.set(-_wallNormal.x, 0, -_wallNormal.z);
    _ledgeRight.set(_wallNormal.z, 0, -_wallNormal.x);

    const tangentInput = THREE.MathUtils.clamp(
      moveDirWorldXZ.x * _ledgeRight.x + moveDirWorldXZ.z * _ledgeRight.z,
      -1,
      1,
    );
    const intoWallInput = THREE.MathUtils.clamp(
      moveDirWorldXZ.x * _intoWall.x + moveDirWorldXZ.z * _intoWall.z,
      -1,
      1,
    );

    // Space triggers smooth physics pull-up / mantle onto the platform
    if ((consumeJump() || isJumpHeld) && !this.isMantling) {
      this.beginMantle(_midAnchor, _wallNormal, topY, handCount);
    }

    // Holding W steadily after establishing hang (or when already pulled above the lip) can also mantle up
    if (
      !this.isMantling &&
      this.hangElapsed > 0.45 &&
      intoWallInput > 0.65 &&
      this.player.body.position.y >= topY + 0.12
    ) {
      this.beginMantle(_midAnchor, _wallNormal, topY, handCount);
    }

    if (this.isMantling) {
      this.mantleHandCount = handCount;
      if (left) left.mode = 'climb';
      if (right) right.mode = 'climb';
      this.currentShimmySpeed = 0;
      this.stepMantlePhysics(fixedDt);
      this.pushHangingStateToPlayer();
      return;
    }

    // --- 1. SIDEWAYS SHIMMY ALONG LEDGE (WASD projected onto ledge tangent) ---
    let shimmyAppliedSpeed = 0;
    if (Math.abs(tangentInput) > 0.08) {
      const runFactor = isRunning ? 1.18 : 1.0;
      const targetSpeed =
        tangentInput * (handCount >= 2 ? SHIMMY_SPEED_DUAL : SHIMMY_SPEED_SINGLE) * runFactor;
      const stepDist = targetSpeed * fixedDt;

      // Validate that all actively gripping hands remain on solid ledge before advancing
      let canAdvance = true;

      if (left) {
        if (
          !this.probeLedgeAt(
            left.body,
            left.worldAnchor.x + _ledgeRight.x * stepDist,
            left.worldAnchor.z + _ledgeRight.z * stepDist,
            left.ledgeTopY,
            left.wallNormal,
            _nextLeftPos,
            _nextLeftNorm,
          )
        ) {
          canAdvance = false;
        }
      }
      if (canAdvance && right) {
        if (
          !this.probeLedgeAt(
            right.body,
            right.worldAnchor.x + _ledgeRight.x * stepDist,
            right.worldAnchor.z + _ledgeRight.z * stepDist,
            right.ledgeTopY,
            right.wallNormal,
            _nextRightPos,
            _nextRightNorm,
          )
        ) {
          canAdvance = false;
        }
      }

      if (canAdvance) {
        if (left) {
          left.worldAnchor.copy(_nextLeftPos);
          left.wallNormal.copy(_nextLeftNorm);
          left.ledgeTopY = _nextLeftPos.y;
          _cannonWorldPt.set(_nextLeftPos.x, _nextLeftPos.y, _nextLeftPos.z);
          left.body.pointToLocalFrame(_cannonWorldPt, left.localAnchor);
        }
        if (right) {
          right.worldAnchor.copy(_nextRightPos);
          right.wallNormal.copy(_nextRightNorm);
          right.ledgeTopY = _nextRightPos.y;
          _cannonWorldPt.set(_nextRightPos.x, _nextRightPos.y, _nextRightPos.z);
          right.body.pointToLocalFrame(_cannonWorldPt, right.localAnchor);
        }

        // Apply gentle tangential drive force at COM so body glides & swings smoothly sideways
        const body = this.player.body;
        const vTan = body.velocity.x * _ledgeRight.x + body.velocity.z * _ledgeRight.z;
        const fTan = THREE.MathUtils.clamp(
          (targetSpeed - vTan) * body.mass * 6.5,
          -SHIMMY_MAX_FORCE,
          SHIMMY_MAX_FORCE,
        );
        _forceVec.set(_ledgeRight.x * fTan, 0, _ledgeRight.z * fTan);
        body.applyForce(_forceVec);
        shimmyAppliedSpeed = targetSpeed;
      }
    }
    this.currentShimmySpeed = THREE.MathUtils.damp(
      this.currentShimmySpeed,
      shimmyAppliedSpeed,
      10,
      fixedDt,
    );

    // --- 2. GRADUAL ARM PULL-UP / LOWERING WITH W / S ---
    const wantsArmPullUp = this.hangElapsed > 0.25 && intoWallInput > 0.45;
    const targetPullBlend = wantsArmPullUp ? 1 : 0;
    const pullRate = wantsArmPullUp ? (handCount >= 2 ? 2.6 : 1.9) : intoWallInput < -0.35 ? 3.5 : 1.8;
    this.climbPullBlend = THREE.MathUtils.damp(this.climbPullBlend, targetPullBlend, pullRate, fixedDt);

    const activeMode: 'hang' | 'climb' =
      this.climbPullBlend > 0.4 || wantsArmPullUp ? 'climb' : 'hang';
    if (left) left.mode = activeMode;
    if (right) right.mode = activeMode;

    // --- 3. PHYSICS-BASED ARM TENSION SPRINGS & NATURAL PENDULUM SWINGING ---
    const armRestLen = THREE.MathUtils.lerp(
      HAND_REST_LEN_HANG,
      HAND_REST_LEN_CLIMB_MIN,
      this.climbPullBlend,
    );
    let maxStretchSeen = 0;

    if (left) {
      maxStretchSeen = Math.max(
        maxStretchSeen,
        this.applyArmTensionForce(left, handCount, armRestLen),
      );
    }
    if (right) {
      maxStretchSeen = Math.max(
        maxStretchSeen,
        this.applyArmTensionForce(right, handCount, armRestLen),
      );
    }

    // Active upward arm-hoist assist when holding W to pull oneself upward while hanging
    const body = this.player.body;
    if (wantsArmPullUp && body.position.y < topY + 0.16) {
      const targetVy = handCount >= 2 ? 2.1 : 1.55;
      const errVy = targetVy - body.velocity.y;
      const hoistForce = THREE.MathUtils.clamp(
        errVy * body.mass * 6.5 + body.mass * 9.81 * 0.42,
        0,
        handCount >= 2 ? 115 : 88,
      );
      _forceVec.set(0, hoistForce, 0);
      body.applyForce(_forceVec);
    } else if (intoWallInput < -0.38) {
      // Gentle lean-back / swing impulse when pressing S while hanging
      const pushOut = 22 * Math.abs(intoWallInput);
      _forceVec.set(_wallNormal.x * pushOut, 0, _wallNormal.z * pushOut);
      body.applyForce(_forceVec);
    }

    // Gentle wall-clearance damper so hanging body settles cleanly outside the wall without bouncing wildly
    const distFromWall =
      (body.position.x - _midAnchor.x) * _wallNormal.x +
      (body.position.z - _midAnchor.z) * _wallNormal.z;
    const velFromWall = body.velocity.x * _wallNormal.x + body.velocity.z * _wallNormal.z;

    if (distFromWall < HANG_WALL_CLEARANCE - 0.04) {
      const pushClear = THREE.MathUtils.clamp(
        (HANG_WALL_CLEARANCE - distFromWall) * 140 - velFromWall * 14,
        0,
        65,
      );
      _forceVec.set(_wallNormal.x * pushClear, 0, _wallNormal.z * pushClear);
      body.applyForce(_forceVec);
    } else if (distFromWall > 0.85) {
      // Subtle pendulum air drag only when swinging far out from the wall
      const pullBack = THREE.MathUtils.clamp((distFromWall - 0.85) * 42 + velFromWall * 6, -45, 45);
      _forceVec.set(-_wallNormal.x * pullBack, 0, -_wallNormal.z * pullBack);
      body.applyForce(_forceVec);
    }

    // Mild angular damping preserves lively pendulum wobble while preventing excessive spinning
    const angDamp = handCount >= 2 ? 2.0 : 1.35;
    body.torque.x -= body.angularVelocity.x * angDamp;
    body.torque.y -= body.angularVelocity.y * angDamp * 0.8;
    body.torque.z -= body.angularVelocity.z * angDamp;
    body.wakeUp();

    this.currentStretchAmount = THREE.MathUtils.clamp(maxStretchSeen / 0.25, 0, 1.2);
    this.pushHangingStateToPlayer();
  }

  private applyArmTensionForce(
    grab: LedgeGrabState,
    handCount: number,
    armRestLen: number,
  ): number {
    const body = this.player.body;
    const sideSign = grab.side === 'left' ? -1 : 1;

    // Shoulder attachment in player body frame
    _attachLocal.set(sideSign * 0.28, 0.32, -0.06);
    body.pointToWorldFrame(_attachLocal, _attachWorld);

    const dx = grab.worldAnchor.x - _attachWorld.x;
    const dy = grab.worldAnchor.y - _attachWorld.y;
    const dz = grab.worldAnchor.z - _attachWorld.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= armRestLen || dist < 0.0001) {
      return 0;
    }

    const dirX = dx / dist;
    const dirY = dy / dist;
    const dirZ = dz / dist;
    const stretch = dist - armRestLen;

    body.getVelocityAtWorldPoint(_attachWorld, _attachVel);
    const velAlong = _attachVel.x * dirX + _attachVel.y * dirY + _attachVel.z * dirZ;

    const stiffness = handCount >= 2 ? ARM_STIFFNESS_DUAL_EACH : ARM_STIFFNESS_SINGLE;
    const effectiveMass = body.mass / Math.max(1, handCount);
    const damping = ARM_DAMPING_RATIO * 2 * Math.sqrt(stiffness * effectiveMass);
    const maxTension = handCount >= 2 ? MAX_ARM_TENSION_DUAL_EACH : MAX_ARM_TENSION_SINGLE;

    const tension = THREE.MathUtils.clamp(
      stretch * stiffness - velAlong * damping,
      0,
      maxTension,
    );

    if (tension <= 0) return 0;

    // Cannon-es body.applyForce takes a COM-relative offset (r = worldPoint - body.position)
    _forceVec.set(dirX * tension, dirY * tension, dirZ * tension);
    _applyPoint.set(
      (_attachWorld.x - body.position.x) * ARM_LEVER_SCALE,
      (_attachWorld.y - body.position.y) * ARM_LEVER_SCALE,
      (_attachWorld.z - body.position.z) * ARM_LEVER_SCALE,
    );
    body.applyForce(_forceVec, _applyPoint);

    return stretch;
  }

  /**
   * Two-phase physics-driven mantle (Hoist Up clear of lip -> Vault Forward onto top surface).
   * Strictly force-driven with damped velocity caps — zero teleportation or snapping.
   */
  private stepMantlePhysics(fixedDt: number): void {
    const body = this.player.body;
    const mass = body.mass;
    this.mantleTimer += fixedDt;

    const isDual = this.mantleHandCount >= 2;
    const maxForce = isDual ? MANTLE_HOIST_MAX_FORCE_DUAL : MANTLE_HOIST_MAX_FORCE_SINGLE;
    const nx = this.mantleWallNormal.x;
    const nz = this.mantleWallNormal.z;

    if (this.mantlePhase === 'hoist') {
      // Phase 1: Pull straight up while staying cleanly outside the lip so boots clear topY smoothly
      _desiredPos.set(
        this.mantleAnchor.x + nx * (HANG_WALL_CLEARANCE + 0.03),
        this.mantleTopY + 1.02,
        this.mantleAnchor.z + nz * (HANG_WALL_CLEARANCE + 0.03),
      );

      if (body.position.y >= this.mantleTopY + 0.66) {
        this.mantlePhase = 'vault';
      }
    }

    if (this.mantlePhase === 'vault') {
      // Phase 2: Step smoothly forward onto the probed solid top platform
      _desiredPos.set(
        this.mantleAnchor.x - nx * this.mantleSafeInset,
        this.mantleTopY + 0.96,
        this.mantleAnchor.z - nz * this.mantleSafeInset,
      );
    }

    const errX = _desiredPos.x - body.position.x;
    const errY = _desiredPos.y - body.position.y;
    const errZ = _desiredPos.z - body.position.z;

    const maxSpeedHoriz = isDual ? 3.2 : 2.55;
    const maxSpeedVert = isDual ? 3.85 : 3.05;
    const desVx = THREE.MathUtils.clamp(errX * 5.2, -maxSpeedHoriz, maxSpeedHoriz);
    const desVy = THREE.MathUtils.clamp(errY * 5.8, -1.8, maxSpeedVert);
    const desVz = THREE.MathUtils.clamp(errZ * 5.2, -maxSpeedHoriz, maxSpeedHoriz);

    let fx = (desVx - body.velocity.x) * mass * 8.5;
    let fy = (desVy - body.velocity.y) * mass * 9.5 + mass * 9.81;
    let fz = (desVz - body.velocity.z) * mass * 8.5;

    const fMag = Math.hypot(fx, fy, fz);
    if (fMag > maxForce) {
      const s = maxForce / fMag;
      fx *= s;
      fy *= s;
      fz *= s;
    }

    _forceVec.set(fx, fy, fz);
    body.applyForce(_forceVec);

    // Gentle angular damping during climb-up for crisp athletic finish
    body.torque.x -= body.angularVelocity.x * 2.2;
    body.torque.y -= body.angularVelocity.y * 1.6;
    body.torque.z -= body.angularVelocity.z * 2.2;
    body.wakeUp();

    this.currentStretchAmount = 0.25;

    // Check smooth mantle completion over the top surface
    const inwardProgress =
      (body.position.x - this.mantleAnchor.x) * -nx +
      (body.position.z - this.mantleAnchor.z) * -nz;

    if (
      (this.mantlePhase === 'vault' &&
        inwardProgress >= this.mantleSafeInset * 0.52 &&
        body.position.y >= this.mantleTopY + 0.72) ||
      this.mantleTimer > 1.45
    ) {
      this.completeMantle();
    }
  }

  /**
   * Synchronizes ledge grab acquisition, releases, and live anchors with HandTargetingSystem each frame.
   */
  public syncAfterTargeting(): void {
    this.syncSingleHand('left');
    this.syncSingleHand('right');
    this.pushHangingStateToPlayer();
  }

  private syncSingleHand(side: HandSide): void {
    const grab = this.getSlot(side);
    if (grab) {
      if (!this.targeting.isHandInputHeld(side)) {
        this.releaseHand(side, true);
        return;
      }
      grab.body.pointToWorldFrame(grab.localAnchor, _cannonWorldPt);
      grab.worldAnchor.set(_cannonWorldPt.x, _cannonWorldPt.y, _cannonWorldPt.z);
      this.targeting.setLedgeGrabState(
        side,
        true,
        grab.body,
        grab.ledgeId,
        grab.worldAnchor,
        grab.wallNormal,
        grab.ledgeTopY,
        grab.mode,
      );
    } else {
      this.tryAcquireLedgeGrab(side);
    }
  }

  public isGrabbingLedge(side: HandSide): boolean {
    return this.getSlot(side) !== null;
  }

  public isGrabbingAnyLedge(): boolean {
    return this.leftGrab !== null || this.rightGrab !== null || this.isMantling;
  }

  public isMantlingLedge(): boolean {
    return this.isMantling;
  }

  public getLedgeGrabState(side: HandSide): Readonly<LedgeGrabState> | null {
    return this.getSlot(side);
  }

  public dispose(): void {
    this.releaseAll(false);
  }
}
