import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { HandSide, HeldBlockState } from '../types';
import type { PlayerCharacter } from '../character/PlayerCharacter';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import type { ProceduralAudio } from '../audio';
import { HandTargetingSystem, MAX_INTERACTION_DISTANCE } from './HandTargetingSystem';

// Carry spring tuning (Step 2 — calibrated for 1.6 - 2.8 kg wooden blocks at 60 Hz)
const CARRY_SPRING_STIFFNESS = 115; // N/m — heavier blocks sag naturally more
const CARRY_DAMPING_RATIO = 0.72;
const CARRY_GRAVITY_ASSIST = 0.65;
const CARRY_LEVER_ARM = 0.55;
const CARRY_ANGULAR_DAMPING_PER_KG = 1.65;

// Push & pull tuning (Step 3 — mass-aware damped contact forces)
const PUSH_SINGLE_MAX_FORCE = 30; // N (noticeable effort vs 13.7 N heavy block friction)
const PUSH_DUAL_MAX_FORCE = 48; // N (coordinated two-hand effort)
const PUSH_LEVER_ARM = 0.72; // Off-center contact produces natural yaw rotation & wobble
const PUSH_ANGULAR_DAMPING_PER_KG = 1.1;

const PULL_SINGLE_STIFFNESS = 56; // N/m
const PULL_DUAL_STIFFNESS = 84; // N/m
const PULL_DAMPING_RATIO = 0.78;
const PULL_SINGLE_MAX_FORCE = 34; // N
const PULL_DUAL_MAX_FORCE = 52; // N
const PULL_GRAVITY_RELIEF = 0.16; // Keeps pulled blocks grounded while avoiding floor snagging
const PULL_LEVER_ARM = 0.68;

const LIFT_CARRY_THRESHOLD = 0.52;
const MAX_HOLD_VELOCITY = 8.5;
const MAX_HOLD_STRETCH = 3.6;
const PLAYER_COUNTER_FORCE_CARRY = 0.12;
const PLAYER_COUNTER_FORCE_PUSH_PULL = 0.3;
const PLAYER_MAX_COUNTER_FORCE = 24;

// Reusable scratch objects (zero GC in physics & render loops)
const _camFwdXZ = new THREE.Vector3();
const _camRightXZ = new THREE.Vector3();
const _camLookDir = new THREE.Vector3();
const _mouseNdc = new THREE.Vector2();
const _shoulderPos = new THREE.Vector3();
const _leftShoulderPos = new THREE.Vector3();
const _rightShoulderPos = new THREE.Vector3();
const _midShoulderPos = new THREE.Vector3();
const _desiredTarget = new THREE.Vector3();
const _prevTarget = new THREE.Vector3();
const _toDesired = new THREE.Vector3();
const _moveDirNorm = new THREE.Vector3();
const _toBlockXZ = new THREE.Vector3();
const _pushDir = new THREE.Vector3();
const _pullGoal = new THREE.Vector3();
const _midAnchor = new THREE.Vector3();

const _worldAnchorCannon = new CANNON.Vec3();
const _worldAnchorCannonB = new CANNON.Vec3();
const _pointVel = new CANNON.Vec3();
const _pointVelB = new CANNON.Vec3();
const _springForce = new CANNON.Vec3();
const _halfForce = new CANNON.Vec3();
const _applyPoint = new CANNON.Vec3();
const _applyPointB = new CANNON.Vec3();
const _counterForce = new CANNON.Vec3();

export class HandGrabSystem {
  private readonly targeting: HandTargetingSystem;
  private readonly player: PlayerCharacter;
  private readonly cameraRig: ThirdPersonCamera;
  private readonly audio: ProceduralAudio;
  private isHandBusyWithLedge?: (side: HandSide) => boolean;

  private leftHeld: HeldBlockState | null = null;
  private rightHeld: HeldBlockState | null = null;

  // Accumulated body lean & wobble fed cleanly into PlayerCharacter's PD upright controller
  private leanAccumX = 0;
  private leanAccumZ = 0;
  private wobbleAccum = 0;
  private leanSamples = 0;

  constructor(
    targeting: HandTargetingSystem,
    player: PlayerCharacter,
    cameraRig: ThirdPersonCamera,
    audio: ProceduralAudio,
  ) {
    this.targeting = targeting;
    this.player = player;
    this.cameraRig = cameraRig;
    this.audio = audio;
  }

  public setLedgeBusyCheck(fn: (side: HandSide) => boolean): void {
    this.isHandBusyWithLedge = fn;
  }

  private getHeldSlot(side: HandSide): HeldBlockState | null {
    return side === 'left' ? this.leftHeld : this.rightHeld;
  }

  private setHeldSlot(side: HandSide, state: HeldBlockState | null): void {
    if (side === 'left') {
      this.leftHeld = state;
    } else {
      this.rightHeld = state;
    }
  }

  private getLiftAndSteer(): { liftNorm: number; steerX: number } {
    this.cameraRig.camera.getWorldDirection(_camLookDir);
    if (this.cameraRig.isPointerLocked()) {
      return {
        liftNorm: THREE.MathUtils.clamp((_camLookDir.y + 0.45) / 1.0, 0, 1),
        steerX: 0,
      };
    }
    this.targeting.getMouseNdc(_mouseNdc);
    return {
      liftNorm: THREE.MathUtils.clamp((_mouseNdc.y + 0.72) / 1.44, 0, 1),
      steerX: THREE.MathUtils.clamp(_mouseNdc.x, -0.85, 0.85) * 0.55,
    };
  }

  private computeDesiredCarryPosition(
    shoulderOrigin: THREE.Vector3,
    lateralBase: number,
    liftNorm: number,
    steerX: number,
    out: THREE.Vector3,
  ): THREE.Vector3 {
    this.cameraRig.getForwardXZ(_camFwdXZ);
    this.cameraRig.getRightXZ(_camRightXZ);

    const lateralOffset = lateralBase + steerX;
    const overheadBlend = THREE.MathUtils.smoothstep(liftNorm, 0.62, 1.0);
    const forwardDist = THREE.MathUtils.lerp(1.48, 0.88, overheadBlend);
    const heightOffset = THREE.MathUtils.lerp(-0.22, 1.24, liftNorm);

    out
      .copy(shoulderOrigin)
      .addScaledVector(_camFwdXZ, forwardDist)
      .addScaledVector(_camRightXZ, lateralOffset);
    out.y = shoulderOrigin.y + heightOffset;

    const minCarryY = this.player.body.position.y - 0.35;
    if (out.y < minCarryY) {
      out.y = minCarryY;
    }

    const maxCarryRadius = MAX_INTERACTION_DISTANCE - 0.32;
    _toDesired.copy(out).sub(shoulderOrigin);
    const dist = _toDesired.length();
    if (dist > maxCarryRadius) {
      _toDesired.multiplyScalar(maxCarryRadius / dist);
      out.copy(shoulderOrigin).add(_toDesired);
    }

    return out;
  }

  private determineInteractionMode(
    body: CANNON.Body,
    liftNorm: number,
    moveDirWorldXZ: THREE.Vector3,
  ): 'carry' | 'push' | 'pull' {
    const moveLenSq = moveDirWorldXZ.x * moveDirWorldXZ.x + moveDirWorldXZ.z * moveDirWorldXZ.z;
    const isAirborneJump =
      !this.player.isGrounded() &&
      (this.player.body.velocity.y > 1.2 || this.player.body.position.y > 1.45);
    if (isAirborneJump || liftNorm >= LIFT_CARRY_THRESHOLD || moveLenSq <= 0.04) {
      return 'carry';
    }

    const invMoveLen = 1 / Math.sqrt(moveLenSq);
    _moveDirNorm.set(moveDirWorldXZ.x * invMoveLen, 0, moveDirWorldXZ.z * invMoveLen);

    _toBlockXZ.set(
      body.position.x - this.player.body.position.x,
      0,
      body.position.z - this.player.body.position.z,
    );
    const toBlockLenSq = _toBlockXZ.lengthSq();
    if (toBlockLenSq < 0.01) {
      return 'carry';
    }
    _toBlockXZ.divideScalar(Math.sqrt(toBlockLenSq));

    const alignment = _moveDirNorm.x * _toBlockXZ.x + _moveDirNorm.z * _toBlockXZ.z;
    if (alignment > 0.22) {
      return 'push';
    }
    // Walking backward away from the block (alignment < -0.22) or strafing sideways pulls/drags it
    return 'pull';
  }

  private addInteractionLean(leanX: number, leanZ: number, wobbleAmp: number): void {
    this.leanAccumX += leanX;
    this.leanAccumZ += leanZ;
    this.wobbleAccum = Math.max(this.wobbleAccum, wobbleAmp);
    this.leanSamples++;
  }

  private applyPlayerCounterForce(fx: number, fy: number, fz: number, factor: number): void {
    let cfx = -fx * factor;
    let cfy = -fy * factor * 0.35;
    let cfz = -fz * factor;
    const cfMag = Math.hypot(cfx, cfy, cfz);
    if (cfMag > PLAYER_MAX_COUNTER_FORCE) {
      const cScale = PLAYER_MAX_COUNTER_FORCE / cfMag;
      cfx *= cScale;
      cfy *= cScale;
      cfz *= cScale;
    }
    _counterForce.set(cfx, cfy, cfz);
    this.player.body.applyForce(_counterForce, this.player.body.position);
  }

  private tryAcquireGrab(side: HandSide): void {
    if (this.getHeldSlot(side)) return;
    if (this.isHandBusyWithLedge?.(side)) return;
    if (!this.targeting.isHandInputHeld(side)) return;

    const anchor = this.targeting.getGrabAnchorForPhysics(side);
    if (!anchor || anchor.surfaceKind !== 'block' || !anchor.block) return;
    if (anchor.distanceFromShoulder > MAX_INTERACTION_DISTANCE) return;

    const localAnchorCopy = anchor.localAnchor.clone();
    anchor.body.pointToWorldFrame(localAnchorCopy, _worldAnchorCannon);

    const worldAnchor = new THREE.Vector3(
      _worldAnchorCannon.x,
      _worldAnchorCannon.y,
      _worldAnchorCannon.z,
    );

    const heldState: HeldBlockState = {
      side,
      block: anchor.block,
      body: anchor.body,
      localAnchor: localAnchorCopy,
      worldAnchor,
      holdTarget: worldAnchor.clone(),
      holdVelocity: new THREE.Vector3(),
      mode: 'carry',
    };

    this.setHeldSlot(side, heldState);
    anchor.body.wakeUp();
    this.targeting.setHeldState(side, anchor.block, worldAnchor, 'carry');
    this.audio.playGrabAttach(side);
  }

  public releaseHand(side: HandSide, playAudio = true): void {
    const held = this.getHeldSlot(side);
    if (!held) return;

    // Release smoothly: never freeze, zero, or overwrite held.body.velocity / angularVelocity
    held.body.wakeUp();
    this.setHeldSlot(side, null);
    this.targeting.setHeldState(side, null);

    if (playAudio) {
      this.audio.playGrabRelease(side);
    }
  }

  public releaseAll(playAudio = false): void {
    this.releaseHand('left', playAudio);
    this.releaseHand('right', playAudio);
    this.player.setInteractionLean(0, 0, 0);
  }

  private validateHeldSlot(side: HandSide): HeldBlockState | null {
    const held = this.getHeldSlot(side);
    if (!held) return null;

    if (!this.targeting.isHandInputHeld(side)) {
      this.releaseHand(side, true);
      return null;
    }

    held.body.pointToWorldFrame(held.localAnchor, _worldAnchorCannon);
    held.worldAnchor.set(_worldAnchorCannon.x, _worldAnchorCannon.y, _worldAnchorCannon.z);

    this.player.getShoulderWorldPosition(side, _shoulderPos);
    const stretch = _shoulderPos.distanceTo(held.worldAnchor);
    if (stretch > MAX_HOLD_STRETCH) {
      this.releaseHand(side, true);
      return null;
    }

    return held;
  }

  /**
   * Called inside the fixed 60 Hz Cannon-es physics substep.
   * Coordinates Step 2 spring carrying and Step 3 physics-based pushing, pulling, and two-hand interaction.
   */
  public applyPreStepForces(
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
  ): void {
    this.leanAccumX = 0;
    this.leanAccumZ = 0;
    this.wobbleAccum = 0;
    this.leanSamples = 0;

    const left = this.validateHeldSlot('left');
    const right = this.validateHeldSlot('right');

    const { liftNorm, steerX } = this.getLiftAndSteer();

    if (left && right && left.body === right.body) {
      // Coordinated two-hand interaction on one shared block (zero conflicting forces)
      this.applyCoordinatedDualForces(
        left,
        right,
        fixedDt,
        moveDirWorldXZ,
        isRunning,
        liftNorm,
        steerX,
      );
    } else {
      if (left) {
        this.applySingleHandForces(left, fixedDt, moveDirWorldXZ, isRunning, liftNorm, steerX);
      }
      if (right) {
        this.applySingleHandForces(right, fixedDt, moveDirWorldXZ, isRunning, liftNorm, steerX);
      }
    }

    if (this.leanSamples > 0) {
      this.player.setInteractionLean(
        this.leanAccumX / this.leanSamples,
        this.leanAccumZ / this.leanSamples,
        this.wobbleAccum,
      );
    } else {
      this.player.setInteractionLean(0, 0, 0);
    }
  }

  private applySingleHandForces(
    held: HeldBlockState,
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
    liftNorm: number,
    steerX: number,
  ): void {
    const mode = this.determineInteractionMode(held.body, liftNorm, moveDirWorldXZ);
    held.mode = mode;

    if (mode === 'push') {
      this.applyPushForces(held, null, fixedDt, moveDirWorldXZ, isRunning);
    } else if (mode === 'pull') {
      this.applyPullForces(held, null, fixedDt, moveDirWorldXZ, isRunning);
    } else {
      this.applySingleCarrySpring(held, fixedDt, liftNorm, steerX);
    }
  }

  private applyCoordinatedDualForces(
    left: HeldBlockState,
    right: HeldBlockState,
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
    liftNorm: number,
    steerX: number,
  ): void {
    const mode = this.determineInteractionMode(left.body, liftNorm, moveDirWorldXZ);
    left.mode = mode;
    right.mode = mode;

    if (mode === 'push') {
      this.applyPushForces(left, right, fixedDt, moveDirWorldXZ, isRunning);
    } else if (mode === 'pull') {
      this.applyPullForces(left, right, fixedDt, moveDirWorldXZ, isRunning);
    } else {
      this.applyDualCarrySpring(left, right, fixedDt, liftNorm, steerX);
    }
  }

  private applySingleCarrySpring(
    held: HeldBlockState,
    fixedDt: number,
    liftNorm: number,
    steerX: number,
  ): void {
    const body = held.body;
    const sideSign = held.side === 'left' ? -1 : 1;
    this.player.getShoulderWorldPosition(held.side, _shoulderPos);
    this.computeDesiredCarryPosition(_shoulderPos, sideSign * 0.46, liftNorm, steerX, _desiredTarget);

    _prevTarget.copy(held.holdTarget);
    held.holdTarget.x = THREE.MathUtils.damp(held.holdTarget.x, _desiredTarget.x, 12, fixedDt);
    held.holdTarget.y = THREE.MathUtils.damp(held.holdTarget.y, _desiredTarget.y, 12, fixedDt);
    held.holdTarget.z = THREE.MathUtils.damp(held.holdTarget.z, _desiredTarget.z, 12, fixedDt);

    const invDt = 1 / Math.max(fixedDt, 0.001);
    held.holdVelocity.copy(held.holdTarget).sub(_prevTarget).multiplyScalar(invDt);
    const hvLen = held.holdVelocity.length();
    if (hvLen > MAX_HOLD_VELOCITY) {
      held.holdVelocity.multiplyScalar(MAX_HOLD_VELOCITY / hvLen);
    }

    _worldAnchorCannon.set(held.worldAnchor.x, held.worldAnchor.y, held.worldAnchor.z);
    body.getVelocityAtWorldPoint(_worldAnchorCannon, _pointVel);

    const mass = Math.max(0.5, body.mass);
    const damping = CARRY_DAMPING_RATIO * 2 * Math.sqrt(CARRY_SPRING_STIFFNESS * mass);

    let fx =
      (held.holdTarget.x - _worldAnchorCannon.x) * CARRY_SPRING_STIFFNESS +
      (held.holdVelocity.x - _pointVel.x) * damping;
    let fy =
      (held.holdTarget.y - _worldAnchorCannon.y) * CARRY_SPRING_STIFFNESS +
      (held.holdVelocity.y - _pointVel.y) * damping +
      mass * 9.81 * CARRY_GRAVITY_ASSIST;
    let fz =
      (held.holdTarget.z - _worldAnchorCannon.z) * CARRY_SPRING_STIFFNESS +
      (held.holdVelocity.z - _pointVel.z) * damping;

    const maxForce = Math.max(85, mass * 52);
    const fMag = Math.hypot(fx, fy, fz);
    if (fMag > maxForce) {
      const scale = maxForce / fMag;
      fx *= scale;
      fy *= scale;
      fz *= scale;
    }

    _springForce.set(fx, fy, fz);
    _applyPoint.set(
      body.position.x + (_worldAnchorCannon.x - body.position.x) * CARRY_LEVER_ARM,
      body.position.y + (_worldAnchorCannon.y - body.position.y) * CARRY_LEVER_ARM,
      body.position.z + (_worldAnchorCannon.z - body.position.z) * CARRY_LEVER_ARM,
    );
    body.applyForce(_springForce, _applyPoint);

    const angDamp = CARRY_ANGULAR_DAMPING_PER_KG * mass;
    body.torque.x -= body.angularVelocity.x * angDamp;
    body.torque.y -= body.angularVelocity.y * angDamp;
    body.torque.z -= body.angularVelocity.z * angDamp;
    body.wakeUp();

    this.applyPlayerCounterForce(fx, fy, fz, PLAYER_COUNTER_FORCE_CARRY);
  }

  private applyDualCarrySpring(
    left: HeldBlockState,
    right: HeldBlockState,
    fixedDt: number,
    liftNorm: number,
    steerX: number,
  ): void {
    const body = left.body;
    this.player.getShoulderWorldPosition('left', _leftShoulderPos);
    this.player.getShoulderWorldPosition('right', _rightShoulderPos);
    _midShoulderPos.addVectors(_leftShoulderPos, _rightShoulderPos).multiplyScalar(0.5);

    this.computeDesiredCarryPosition(_midShoulderPos, 0, liftNorm, steerX, _desiredTarget);

    _prevTarget.copy(left.holdTarget);
    left.holdTarget.x = THREE.MathUtils.damp(left.holdTarget.x, _desiredTarget.x, 12, fixedDt);
    left.holdTarget.y = THREE.MathUtils.damp(left.holdTarget.y, _desiredTarget.y, 12, fixedDt);
    left.holdTarget.z = THREE.MathUtils.damp(left.holdTarget.z, _desiredTarget.z, 12, fixedDt);
    right.holdTarget.copy(left.holdTarget);

    const invDt = 1 / Math.max(fixedDt, 0.001);
    left.holdVelocity.copy(left.holdTarget).sub(_prevTarget).multiplyScalar(invDt);
    const hvLen = left.holdVelocity.length();
    if (hvLen > MAX_HOLD_VELOCITY) {
      left.holdVelocity.multiplyScalar(MAX_HOLD_VELOCITY / hvLen);
    }
    right.holdVelocity.copy(left.holdVelocity);

    // Pull the midpoint of both contact anchors toward one shared target (zero internal fighting)
    _midAnchor.addVectors(left.worldAnchor, right.worldAnchor).multiplyScalar(0.5);
    _worldAnchorCannon.set(left.worldAnchor.x, left.worldAnchor.y, left.worldAnchor.z);
    _worldAnchorCannonB.set(right.worldAnchor.x, right.worldAnchor.y, right.worldAnchor.z);
    body.getVelocityAtWorldPoint(_worldAnchorCannon, _pointVel);
    body.getVelocityAtWorldPoint(_worldAnchorCannonB, _pointVelB);

    const midVelX = (_pointVel.x + _pointVelB.x) * 0.5;
    const midVelY = (_pointVel.y + _pointVelB.y) * 0.5;
    const midVelZ = (_pointVel.z + _pointVelB.z) * 0.5;

    const mass = Math.max(0.5, body.mass);
    const stiffness = CARRY_SPRING_STIFFNESS * 1.35;
    const damping = CARRY_DAMPING_RATIO * 2 * Math.sqrt(stiffness * mass);

    let fx =
      (left.holdTarget.x - _midAnchor.x) * stiffness +
      (left.holdVelocity.x - midVelX) * damping;
    let fy =
      (left.holdTarget.y - _midAnchor.y) * stiffness +
      (left.holdVelocity.y - midVelY) * damping +
      mass * 9.81 * Math.min(0.82, CARRY_GRAVITY_ASSIST * 1.15);
    let fz =
      (left.holdTarget.z - _midAnchor.z) * stiffness +
      (left.holdVelocity.z - midVelZ) * damping;

    const maxForce = Math.max(115, mass * 68);
    const fMag = Math.hypot(fx, fy, fz);
    if (fMag > maxForce) {
      const scale = maxForce / fMag;
      fx *= scale;
      fy *= scale;
      fz *= scale;
    }

    // Distribute coordinated force evenly across both hands' contact points
    _halfForce.set(fx * 0.5, fy * 0.5, fz * 0.5);
    _applyPoint.set(
      body.position.x + (left.worldAnchor.x - body.position.x) * CARRY_LEVER_ARM,
      body.position.y + (left.worldAnchor.y - body.position.y) * CARRY_LEVER_ARM,
      body.position.z + (left.worldAnchor.z - body.position.z) * CARRY_LEVER_ARM,
    );
    _applyPointB.set(
      body.position.x + (right.worldAnchor.x - body.position.x) * CARRY_LEVER_ARM,
      body.position.y + (right.worldAnchor.y - body.position.y) * CARRY_LEVER_ARM,
      body.position.z + (right.worldAnchor.z - body.position.z) * CARRY_LEVER_ARM,
    );
    body.applyForce(_halfForce, _applyPoint);
    body.applyForce(_halfForce, _applyPointB);

    const angDamp = CARRY_ANGULAR_DAMPING_PER_KG * 1.25 * mass;
    body.torque.x -= body.angularVelocity.x * angDamp;
    body.torque.y -= body.angularVelocity.y * angDamp;
    body.torque.z -= body.angularVelocity.z * angDamp;
    body.wakeUp();

    this.applyPlayerCounterForce(fx, fy, fz, PLAYER_COUNTER_FORCE_CARRY);
  }

  private applyPushForces(
    primary: HeldBlockState,
    secondary: HeldBlockState | null,
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
  ): void {
    const body = primary.body;
    const isDual = secondary !== null;
    const mass = Math.max(0.5, body.mass);
    const effortPower = isDual ? 1.65 : 1.0;
    const runBoost = isRunning ? 1.25 : 1.0;

    // Keep holdTarget synced to live anchor so transitioning back to carry never jumps
    primary.holdTarget.copy(primary.worldAnchor);
    primary.holdVelocity.set(0, 0, 0);
    if (secondary) {
      secondary.holdTarget.copy(secondary.worldAnchor);
      secondary.holdVelocity.set(0, 0, 0);
    }

    // Blend player travel direction with player-to-block horizontal axis
    _moveDirNorm.set(moveDirWorldXZ.x, 0, moveDirWorldXZ.z);
    if (_moveDirNorm.lengthSq() > 0.0001) {
      _moveDirNorm.normalize();
    }
    _toBlockXZ.set(
      body.position.x - this.player.body.position.x,
      0,
      body.position.z - this.player.body.position.z,
    );
    if (_toBlockXZ.lengthSq() > 0.0001) {
      _toBlockXZ.normalize();
    } else {
      _toBlockXZ.copy(_moveDirNorm);
    }

    _pushDir.set(
      _moveDirNorm.x * 0.78 + _toBlockXZ.x * 0.22,
      0,
      _moveDirNorm.z * 0.78 + _toBlockXZ.z * 0.22,
    );
    if (_pushDir.lengthSq() > 0.0001) {
      _pushDir.normalize();
    }

    // Mass-respecting target push velocity: heavier blocks require noticeably more effort
    const massRatio = mass / 1.6;
    const targetPushSpeed = THREE.MathUtils.clamp(
      (3.35 * effortPower * runBoost) / Math.pow(massRatio, 0.72),
      1.35,
      4.5,
    );

    // Measure contact velocity along push direction
    _worldAnchorCannon.set(primary.worldAnchor.x, primary.worldAnchor.y, primary.worldAnchor.z);
    body.getVelocityAtWorldPoint(_worldAnchorCannon, _pointVel);
    let vx = _pointVel.x;
    let vz = _pointVel.z;

    if (secondary) {
      _worldAnchorCannonB.set(
        secondary.worldAnchor.x,
        secondary.worldAnchor.y,
        secondary.worldAnchor.z,
      );
      body.getVelocityAtWorldPoint(_worldAnchorCannonB, _pointVelB);
      vx = (vx + _pointVelB.x) * 0.5;
      vz = (vz + _pointVelB.z) * 0.5;
    }

    const vAlong = vx * _pushDir.x + vz * _pushDir.z;
    const vLatX = vx - _pushDir.x * vAlong;
    const vLatZ = vz - _pushDir.z * vAlong;

    const maxPushForce = (isDual ? PUSH_DUAL_MAX_FORCE : PUSH_SINGLE_MAX_FORCE) * runBoost;
    const speedErr = Math.max(0, targetPushSpeed - vAlong);
    const pushGain = 14.5 * mass * effortPower;
    const alongForce = THREE.MathUtils.clamp(speedErr * pushGain, 0, maxPushForce);

    // Mild lateral velocity damping prevents erratic sideways skating while preserving rotation
    const latDamp = 3.2 * mass;
    let fx = _pushDir.x * alongForce - vLatX * latDamp;
    let fz = _pushDir.z * alongForce - vLatZ * latDamp;

    const totalMag = Math.hypot(fx, fz);
    if (totalMag > maxPushForce) {
      const s = maxPushForce / totalMag;
      fx *= s;
      fz *= s;
    }

    // Apply physical push force at the body-relative contact point(s)
    // Off-center single-hand contact generates natural yaw rotation & wobble;
    // dual-hand splits force evenly across both contacts with zero conflicting forces.
    if (secondary) {
      _halfForce.set(fx * 0.5, 0, fz * 0.5);
      _applyPoint.set(
        body.position.x + (primary.worldAnchor.x - body.position.x) * PUSH_LEVER_ARM,
        body.position.y + (primary.worldAnchor.y - body.position.y) * PUSH_LEVER_ARM,
        body.position.z + (primary.worldAnchor.z - body.position.z) * PUSH_LEVER_ARM,
      );
      _applyPointB.set(
        body.position.x + (secondary.worldAnchor.x - body.position.x) * PUSH_LEVER_ARM,
        body.position.y + (secondary.worldAnchor.y - body.position.y) * PUSH_LEVER_ARM,
        body.position.z + (secondary.worldAnchor.z - body.position.z) * PUSH_LEVER_ARM,
      );
      body.applyForce(_halfForce, _applyPoint);
      body.applyForce(_halfForce, _applyPointB);
    } else {
      _springForce.set(fx, 0, fz);
      _applyPoint.set(
        body.position.x + (primary.worldAnchor.x - body.position.x) * PUSH_LEVER_ARM,
        body.position.y + (primary.worldAnchor.y - body.position.y) * PUSH_LEVER_ARM,
        body.position.z + (primary.worldAnchor.z - body.position.z) * PUSH_LEVER_ARM,
      );
      body.applyForce(_springForce, _applyPoint);
    }

    // Gentle rotational damping so blocks slide, rotate & wobble naturally without spinning wildly
    const angDamp = PUSH_ANGULAR_DAMPING_PER_KG * mass;
    body.torque.x -= body.angularVelocity.x * angDamp;
    body.torque.y -= body.angularVelocity.y * angDamp * 0.65;
    body.torque.z -= body.angularVelocity.z * angDamp;
    body.wakeUp();

    // Character leans forward into the push; heavier objects induce deeper lean & subtle effort wobble
    const weightFactor = THREE.MathUtils.clamp(mass / 2.8, 0.4, 1.25);
    const leanMag = THREE.MathUtils.clamp(
      (0.095 + weightFactor * 0.065) * (isDual ? 1.12 : 1.0),
      0.09,
      0.18,
    );
    const wobbleAmp = THREE.MathUtils.clamp(0.015 + weightFactor * 0.028, 0.015, 0.048);
    this.addInteractionLean(_pushDir.x * leanMag, _pushDir.z * leanMag, wobbleAmp);

    // Reciprocal resistance on player body so heavy blocks feel physically substantial
    this.applyPlayerCounterForce(fx, 0, fz, PLAYER_COUNTER_FORCE_PUSH_PULL);
    void fixedDt;
  }

  private applyPullForces(
    primary: HeldBlockState,
    secondary: HeldBlockState | null,
    fixedDt: number,
    moveDirWorldXZ: THREE.Vector3,
    isRunning: boolean,
  ): void {
    const body = primary.body;
    const isDual = secondary !== null;
    const mass = Math.max(0.5, body.mass);
    const runBoost = isRunning ? 1.2 : 1.0;

    this.cameraRig.getForwardXZ(_camFwdXZ);
    this.cameraRig.getRightXZ(_camRightXZ);

    // Pull goal tracks in front of the player so walking backward pulls the block toward the character
    // and walking sideways drags/pivots the block smoothly sideways.
    const lateralOffset = isDual ? 0 : primary.side === 'left' ? -0.34 : 0.34;
    _pullGoal.set(
      this.player.body.position.x + _camFwdXZ.x * 1.18 + _camRightXZ.x * lateralOffset,
      primary.worldAnchor.y,
      this.player.body.position.z + _camFwdXZ.z * 1.18 + _camRightXZ.z * lateralOffset,
    );

    // Smoothly advance holdTarget toward pullGoal (zero snapping or teleportation)
    _prevTarget.copy(primary.holdTarget);
    primary.holdTarget.x = THREE.MathUtils.damp(primary.holdTarget.x, _pullGoal.x, 10, fixedDt);
    primary.holdTarget.y = primary.worldAnchor.y;
    primary.holdTarget.z = THREE.MathUtils.damp(primary.holdTarget.z, _pullGoal.z, 10, fixedDt);
    if (secondary) {
      secondary.holdTarget.copy(primary.holdTarget);
    }

    // Measure current contact point (or midpoint for coordinated dual pull) and relative velocity
    _midAnchor.copy(primary.worldAnchor);
    _worldAnchorCannon.set(primary.worldAnchor.x, primary.worldAnchor.y, primary.worldAnchor.z);
    body.getVelocityAtWorldPoint(_worldAnchorCannon, _pointVel);
    let vx = _pointVel.x;
    let vz = _pointVel.z;

    if (secondary) {
      _midAnchor.add(secondary.worldAnchor).multiplyScalar(0.5);
      _worldAnchorCannonB.set(
        secondary.worldAnchor.x,
        secondary.worldAnchor.y,
        secondary.worldAnchor.z,
      );
      body.getVelocityAtWorldPoint(_worldAnchorCannonB, _pointVelB);
      vx = (vx + _pointVelB.x) * 0.5;
      vz = (vz + _pointVelB.z) * 0.5;
    }

    const stiffness = isDual ? PULL_DUAL_STIFFNESS : PULL_SINGLE_STIFFNESS;
    const damping = PULL_DAMPING_RATIO * 2 * Math.sqrt(stiffness * mass);

    const targetVelX = THREE.MathUtils.clamp(this.player.body.velocity.x, -MAX_HOLD_VELOCITY, MAX_HOLD_VELOCITY);
    const targetVelZ = THREE.MathUtils.clamp(this.player.body.velocity.z, -MAX_HOLD_VELOCITY, MAX_HOLD_VELOCITY);

    let fx = (primary.holdTarget.x - _midAnchor.x) * stiffness + (targetVelX - vx) * damping;
    let fz = (primary.holdTarget.z - _midAnchor.z) * stiffness + (targetVelZ - vz) * damping;

    const maxPullForce = (isDual ? PULL_DUAL_MAX_FORCE : PULL_SINGLE_MAX_FORCE) * runBoost;
    const fHoriz = Math.hypot(fx, fz);
    if (fHoriz > maxPullForce) {
      const s = maxPullForce / fHoriz;
      fx *= s;
      fz *= s;
    }

    // Minimal vertical snag relief so block slides realistically on the terrace under gravity
    const fy = mass * 9.81 * PULL_GRAVITY_RELIEF;

    if (secondary) {
      _halfForce.set(fx * 0.5, fy * 0.5, fz * 0.5);
      _applyPoint.set(
        body.position.x + (primary.worldAnchor.x - body.position.x) * PULL_LEVER_ARM,
        body.position.y + (primary.worldAnchor.y - body.position.y) * PULL_LEVER_ARM,
        body.position.z + (primary.worldAnchor.z - body.position.z) * PULL_LEVER_ARM,
      );
      _applyPointB.set(
        body.position.x + (secondary.worldAnchor.x - body.position.x) * PULL_LEVER_ARM,
        body.position.y + (secondary.worldAnchor.y - body.position.y) * PULL_LEVER_ARM,
        body.position.z + (secondary.worldAnchor.z - body.position.z) * PULL_LEVER_ARM,
      );
      body.applyForce(_halfForce, _applyPoint);
      body.applyForce(_halfForce, _applyPointB);
    } else {
      _springForce.set(fx, fy, fz);
      _applyPoint.set(
        body.position.x + (primary.worldAnchor.x - body.position.x) * PULL_LEVER_ARM,
        body.position.y + (primary.worldAnchor.y - body.position.y) * PULL_LEVER_ARM,
        body.position.z + (primary.worldAnchor.z - body.position.z) * PULL_LEVER_ARM,
      );
      body.applyForce(_springForce, _applyPoint);
    }

    const angDamp = PUSH_ANGULAR_DAMPING_PER_KG * 1.15 * mass;
    body.torque.x -= body.angularVelocity.x * angDamp;
    body.torque.y -= body.angularVelocity.y * angDamp * 0.7;
    body.torque.z -= body.angularVelocity.z * angDamp;
    body.wakeUp();

    // Character leans back/sideways into the pull direction as a counterweight
    _moveDirNorm.set(moveDirWorldXZ.x, 0, moveDirWorldXZ.z);
    if (_moveDirNorm.lengthSq() > 0.0001) {
      _moveDirNorm.normalize();
      const weightFactor = THREE.MathUtils.clamp(mass / 2.8, 0.4, 1.25);
      const leanMag = THREE.MathUtils.clamp(
        (0.085 + weightFactor * 0.065) * (isDual ? 1.1 : 1.0),
        0.08,
        0.16,
      );
      const wobbleAmp = THREE.MathUtils.clamp(0.012 + weightFactor * 0.022, 0.012, 0.04);
      this.addInteractionLean(_moveDirNorm.x * leanMag, _moveDirNorm.z * leanMag, wobbleAmp);
    }

    this.applyPlayerCounterForce(fx, 0, fz, PLAYER_COUNTER_FORCE_PUSH_PULL);
  }

  /**
   * Synchronizes grab acquisition, release checks, live anchor positions, and push/pull/carry
   * interaction modes with Step 1's HandTargetingSystem visuals each frame.
   */
  public syncAfterTargeting(): void {
    this.syncSingleHand('left');
    this.syncSingleHand('right');
  }

  private syncSingleHand(side: HandSide): void {
    const held = this.getHeldSlot(side);
    if (held) {
      if (!this.targeting.isHandInputHeld(side)) {
        this.releaseHand(side, true);
        return;
      }
      held.body.pointToWorldFrame(held.localAnchor, _worldAnchorCannon);
      held.worldAnchor.set(_worldAnchorCannon.x, _worldAnchorCannon.y, _worldAnchorCannon.z);
      this.targeting.setHeldState(side, held.block, held.worldAnchor, held.mode);
    } else {
      this.tryAcquireGrab(side);
    }
  }

  public getHeldState(side: HandSide): Readonly<HeldBlockState> | null {
    return this.getHeldSlot(side);
  }

  public isHolding(side: HandSide): boolean {
    return this.getHeldSlot(side) !== null;
  }

  public isTwoHandCoordinated(): boolean {
    return Boolean(this.leftHeld && this.rightHeld && this.leftHeld.body === this.rightHeld.body);
  }

  public dispose(): void {
    this.releaseAll(false);
  }
}
