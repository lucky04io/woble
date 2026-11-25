import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type {
  DynamicBlockInstance,
  GrabTargetMetadata,
  HandInteractionMode,
  HandSide,
  HandTargetingHudSnapshot,
  HandTargetState,
  InteractiveSurfaceKind,
} from '../types';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { PlayerCharacter } from '../character/PlayerCharacter';
import type { ThirdPersonCamera } from '../camera/ThirdPersonCamera';
import type { ProceduralAudio } from '../audio';

export const MAX_INTERACTION_DISTANCE = 2.65;
const AIM_RAY_MAX_DISTANCE = 24;

const COLOR_LEFT_LOCK = 0x2563eb; // Alpine sky blue
const COLOR_RIGHT_LOCK = 0xea580c; // Warm coral amber
const COLOR_BOTH_LOCK = 0x10b981; // Emerald teal
const COLOR_HOVER_REACH = 0xf59e0b; // Soft luminous amber
const COLOR_SEARCHING = 0x94a3b8; // Neutral slate

// Pre-allocated scratch helpers (zero GC per frame)
const _ndc = new THREE.Vector2();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _aimPlane = new THREE.Plane();
const _aimPlaneNormal = new THREE.Vector3();
const _aimPlaneAnchor = new THREE.Vector3();
const _planeHit = new THREE.Vector3();
const _toHit = new THREE.Vector3();
const _worldNormal = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _zAxis = new THREE.Vector3(0, 0, 1);
const _ringQuat = new THREE.Quaternion();
const _camForward = new THREE.Vector3();

const _cannonFrom = new CANNON.Vec3();
const _cannonTo = new CANNON.Vec3();
const _cannonHitPoint = new CANNON.Vec3();
const _cannonLocalAnchor = new CANNON.Vec3();
const _ledgeHitPoint = new THREE.Vector3();
const _ledgeHitNormal = new THREE.Vector3();
const _ledgeWallNormal = new THREE.Vector3();
const _ledgeTangent = new THREE.Vector3();
const _ledgeRayOrigin = new THREE.Vector3();
const _ledgeRayDir = new THREE.Vector3();
const _ledgeClearPoint = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _barQuat = new THREE.Quaternion();

interface BlockHighlightVisual {
  block: DynamicBlockInstance;
  coreMesh: THREE.Mesh;
  coreMaterial: THREE.MeshStandardMaterial | null;
  outlineLines: THREE.LineSegments;
  outlineMaterial: THREE.LineBasicMaterial;
  emissiveBlend: number;
}

interface HandVisualIndicator {
  markerGroup: THREE.Group;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  dotMesh: THREE.Mesh;
  dotMat: THREE.MeshBasicMaterial;
  tetherLine: THREE.Line;
  tetherPositions: Float32Array;
  tetherMat: THREE.LineBasicMaterial;
  lockPopScale: number;
}

interface RawBlockHit {
  block: DynamicBlockInstance;
  worldPoint: THREE.Vector3;
  worldNormal: THREE.Vector3;
  cameraDistance: number;
}

interface RawLedgeHit {
  body: CANNON.Body | null;
  ledgeId: string;
  worldPoint: THREE.Vector3;
  worldNormal: THREE.Vector3;
  wallNormal: THREE.Vector3;
  ledgeTopY: number;
}

function createEmptyHandState(side: HandSide): HandTargetState {
  return {
    side,
    isAiming: false,
    isTargetingBlock: false,
    isTargetingLedge: false,
    isInReach: false,
    isLockedOn: false,
    shoulderWorldPos: new THREE.Vector3(),
    handTipWorldPos: new THREE.Vector3(),
    aimWorldPoint: new THREE.Vector3(),
    target: null,
  };
}

export class HandTargetingSystem {
  public readonly visualRoot = new THREE.Group();

  private readonly domElement: HTMLElement;
  private readonly cameraRig: ThirdPersonCamera;
  private readonly player: PlayerCharacter;
  private readonly physics: PhysicsWorld;
  private readonly audio: ProceduralAudio;
  private readonly onHudChange?: (snapshot: HandTargetingHudSnapshot) => void;

  private readonly raycaster = new THREE.Raycaster();
  private readonly blockCoreMeshes: THREE.Mesh[] = [];
  private readonly meshToBlock = new Map<THREE.Object3D, DynamicBlockInstance>();
  private readonly blockVisuals = new Map<string, BlockHighlightVisual>();
  private readonly disposables: Array<{ dispose: () => void }> = [];

  private readonly leftState: HandTargetState = createEmptyHandState('left');
  private readonly rightState: HandTargetState = createEmptyHandState('right');
  private readonly leftTargetStorage: GrabTargetMetadata;
  private readonly rightTargetStorage: GrabTargetMetadata;
  private readonly leftVisual: HandVisualIndicator;
  private readonly rightVisual: HandVisualIndicator;

  // Independent mouse & keyboard aim inputs
  private readonly mouseNdc = new THREE.Vector2(0, 0);
  private hasMousePosition = false;
  private leftMouseHeld = false;
  private rightMouseHeld = false;
  private leftKeyHeld = false;
  private rightKeyHeld = false;

  // Held block state synced from HandGrabSystem (Steps 2 & 3)
  private heldLeftBlock: DynamicBlockInstance | null = null;
  private heldRightBlock: DynamicBlockInstance | null = null;
  private heldLeftMode: 'carry' | 'push' | 'pull' = 'carry';
  private heldRightMode: 'carry' | 'push' | 'pull' = 'carry';
  private readonly heldLeftAnchor = new THREE.Vector3();
  private readonly heldRightAnchor = new THREE.Vector3();

  // Active ledge grab state synced from LedgeClimbSystem (Step 4)
  private ledgeLeftActive = false;
  private ledgeRightActive = false;
  private ledgeLeftBody: CANNON.Body | null = null;
  private ledgeRightBody: CANNON.Body | null = null;
  private ledgeLeftId: string | null = null;
  private ledgeRightId: string | null = null;
  private ledgeLeftMode: 'hang' | 'climb' = 'hang';
  private ledgeRightMode: 'hang' | 'climb' = 'hang';
  private ledgeLeftTopY = 0;
  private ledgeRightTopY = 0;
  private readonly ledgeLeftAnchor = new THREE.Vector3();
  private readonly ledgeRightAnchor = new THREE.Vector3();
  private readonly ledgeLeftWallNormal = new THREE.Vector3(0, 0, 1);
  private readonly ledgeRightWallNormal = new THREE.Vector3(0, 0, 1);

  // Subtle 3D ledge highlight bar along targeted/grabbed ledge lip
  private readonly ledgeBarMesh: THREE.Mesh;
  private readonly ledgeBarMat: THREE.MeshBasicMaterial;

  // Previous lock state for crisp rising-edge audio & HUD deduplication
  private prevLeftLockedKey: string | null = null;
  private prevRightLockedKey: string | null = null;
  private lastHudKey = '';

  // Reusable raw hit containers
  private readonly rawHit: RawBlockHit = {
    block: null as unknown as DynamicBlockInstance,
    worldPoint: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(0, 1, 0),
    cameraDistance: Infinity,
  };
  private readonly rawLedgeHit: RawLedgeHit = {
    body: null,
    ledgeId: '',
    worldPoint: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(0, 1, 0),
    wallNormal: new THREE.Vector3(0, 0, 1),
    ledgeTopY: 0,
  };
  private readonly probeLedgeHit: RawLedgeHit = {
    body: null,
    ledgeId: '',
    worldPoint: new THREE.Vector3(),
    worldNormal: new THREE.Vector3(0, 1, 0),
    wallNormal: new THREE.Vector3(0, 0, 1),
    ledgeTopY: 0,
  };

  constructor(
    scene: THREE.Scene,
    domElement: HTMLElement,
    cameraRig: ThirdPersonCamera,
    player: PlayerCharacter,
    physics: PhysicsWorld,
    dynamicBlocks: DynamicBlockInstance[],
    audio: ProceduralAudio,
    onHudChange?: (snapshot: HandTargetingHudSnapshot) => void,
  ) {
    this.domElement = domElement;
    this.cameraRig = cameraRig;
    this.player = player;
    this.physics = physics;
    this.audio = audio;
    this.onHudChange = onHudChange;

    this.raycaster.near = 0.1;
    this.raycaster.far = AIM_RAY_MAX_DISTANCE;

    scene.add(this.visualRoot);

    const firstBlock = dynamicBlocks[0];
    this.leftTargetStorage = {
      block: firstBlock ?? null,
      body: firstBlock?.body,
      worldPoint: new THREE.Vector3(),
      localAnchor: new CANNON.Vec3(),
      worldNormal: new THREE.Vector3(0, 1, 0),
      wallNormal: new THREE.Vector3(0, 0, 1),
      ledgeTopY: 0,
      ledgeId: null,
      distanceFromShoulder: 0,
      surfaceKind: 'block',
    };
    this.rightTargetStorage = {
      block: firstBlock ?? null,
      body: firstBlock?.body,
      worldPoint: new THREE.Vector3(),
      localAnchor: new CANNON.Vec3(),
      worldNormal: new THREE.Vector3(0, 1, 0),
      wallNormal: new THREE.Vector3(0, 0, 1),
      ledgeTopY: 0,
      ledgeId: null,
      distanceFromShoulder: 0,
      surfaceKind: 'block',
    };

    this.buildBlockHighlights(dynamicBlocks);
    this.leftVisual = this.buildHandIndicator(COLOR_LEFT_LOCK);
    this.rightVisual = this.buildHandIndicator(COLOR_RIGHT_LOCK);

    const barGeo = new THREE.BoxGeometry(0.92, 0.042, 0.042);
    this.ledgeBarMat = new THREE.MeshBasicMaterial({
      color: COLOR_HOVER_REACH,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    this.ledgeBarMesh = new THREE.Mesh(barGeo, this.ledgeBarMat);
    this.ledgeBarMesh.visible = false;
    this.ledgeBarMesh.renderOrder = 5;
    this.visualRoot.add(this.ledgeBarMesh);
    this.disposables.push(barGeo, this.ledgeBarMat);

    this.bindEvents();
  }

  private buildBlockHighlights(dynamicBlocks: DynamicBlockInstance[]): void {
    for (const block of dynamicBlocks) {
      const coreMesh = block.mesh.children[0] as THREE.Mesh | undefined;
      if (!coreMesh) continue;

      this.blockCoreMeshes.push(coreMesh);
      this.meshToBlock.set(coreMesh, block);

      const coreMaterial =
        coreMesh.material instanceof THREE.MeshStandardMaterial ? coreMesh.material : null;

      const [w, h, d] = block.spec.size;
      const boxGeo = new THREE.BoxGeometry(w + 0.032, h + 0.032, d + 0.032);
      const edgesGeo = new THREE.EdgesGeometry(boxGeo);
      boxGeo.dispose();

      const outlineMaterial = new THREE.LineBasicMaterial({
        color: COLOR_HOVER_REACH,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });

      const outlineLines = new THREE.LineSegments(edgesGeo, outlineMaterial);
      outlineLines.visible = false;
      outlineLines.renderOrder = 4;
      this.visualRoot.add(outlineLines);

      this.disposables.push(edgesGeo, outlineMaterial);
      this.blockVisuals.set(block.spec.id, {
        block,
        coreMesh,
        coreMaterial,
        outlineLines,
        outlineMaterial,
        emissiveBlend: 0,
      });
    }
  }

  private buildHandIndicator(accentColor: number): HandVisualIndicator {
    const markerGroup = new THREE.Group();
    markerGroup.visible = false;
    markerGroup.renderOrder = 6;

    const ringGeo = new THREE.RingGeometry(0.085, 0.125, 28);
    const ringMat = new THREE.MeshBasicMaterial({
      color: accentColor,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    markerGroup.add(ringMesh);

    const dotGeo = new THREE.CircleGeometry(0.036, 18);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    const dotMesh = new THREE.Mesh(dotGeo, dotMat);
    dotMesh.position.z = 0.004;
    markerGroup.add(dotMesh);

    this.visualRoot.add(markerGroup);

    const tetherPositions = new Float32Array(6);
    const tetherGeo = new THREE.BufferGeometry();
    tetherGeo.setAttribute('position', new THREE.BufferAttribute(tetherPositions, 3));
    const tetherMat = new THREE.LineBasicMaterial({
      color: accentColor,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    const tetherLine = new THREE.Line(tetherGeo, tetherMat);
    tetherLine.visible = false;
    tetherLine.frustumCulled = false;
    tetherLine.renderOrder = 5;
    this.visualRoot.add(tetherLine);

    this.disposables.push(ringGeo, ringMat, dotGeo, dotMat, tetherGeo, tetherMat);

    return {
      markerGroup,
      ringMesh,
      ringMat,
      dotMesh,
      dotMat,
      tetherLine,
      tetherPositions,
      tetherMat,
      lockPopScale: 1,
    };
  }

  private updateMouseNdc(clientX: number, clientY: number): void {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    this.mouseNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.mouseNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.hasMousePosition = true;
  }

  private readonly handlePointerMove = (e: PointerEvent): void => {
    this.updateMouseNdc(e.clientX, e.clientY);
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.updateMouseNdc(e.clientX, e.clientY);
    if (e.altKey) return; // Alt+Drag is reserved for unlocked camera orbit

    if (e.button === 0) {
      this.leftMouseHeld = true;
      this.audio.unlock();
    } else if (e.button === 2) {
      this.rightMouseHeld = true;
      this.audio.unlock();
    }
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (e.button === 0) {
      this.leftMouseHeld = false;
    } else if (e.button === 2) {
      this.rightMouseHeld = false;
    }
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }
    if (e.code === 'KeyQ') {
      this.leftKeyHeld = true;
      this.audio.unlock();
    } else if (e.code === 'KeyE') {
      this.rightKeyHeld = true;
      this.audio.unlock();
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyQ') {
      this.leftKeyHeld = false;
    } else if (e.code === 'KeyE') {
      this.rightKeyHeld = false;
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.leftMouseHeld = false;
    this.rightMouseHeld = false;
    this.leftKeyHeld = false;
    this.rightKeyHeld = false;
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden) {
      this.handleWindowBlur();
    }
  };

  private bindEvents(): void {
    window.addEventListener('pointermove', this.handlePointerMove);
    this.domElement.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private raycastSceneFromCamera(): 'none' | 'block' | 'ledge' {
    this.cameraRig.camera.updateMatrixWorld(true);
    for (const vis of this.blockVisuals.values()) {
      vis.block.mesh.updateMatrixWorld(true);
    }

    if (this.cameraRig.isPointerLocked()) {
      _ndc.set(0, 0);
    } else if (this.hasMousePosition) {
      _ndc.copy(this.mouseNdc);
    } else {
      _ndc.set(0, 0);
    }

    this.raycaster.setFromCamera(_ndc, this.cameraRig.camera);
    const hits = this.raycaster.intersectObjects(this.blockCoreMeshes, false);

    let hasBlockHit = false;
    this.rawHit.cameraDistance = Infinity;
    if (hits.length > 0) {
      const first = hits[0];
      const block = this.meshToBlock.get(first.object);
      if (block) {
        hasBlockHit = true;
        this.rawHit.block = block;
        this.rawHit.worldPoint.copy(first.point);
        this.rawHit.cameraDistance = first.distance;
        if (first.face) {
          _normalMatrix.getNormalMatrix(first.object.matrixWorld);
          _worldNormal.copy(first.face.normal).applyMatrix3(_normalMatrix).normalize();
          this.rawHit.worldNormal.copy(_worldNormal);
        } else {
          this.rawHit.worldNormal.set(0, 1, 0);
        }
      }
    }

    // Physics raycast along camera ray to detect static ledges & prevent targeting blocks through walls
    _ledgeRayOrigin.copy(this.raycaster.ray.origin);
    _ledgeRayDir.copy(this.raycaster.ray.direction);
    _cannonFrom.set(_ledgeRayOrigin.x, _ledgeRayOrigin.y, _ledgeRayOrigin.z);
    _cannonTo.set(
      _ledgeRayOrigin.x + _ledgeRayDir.x * AIM_RAY_MAX_DISTANCE,
      _ledgeRayOrigin.y + _ledgeRayDir.y * AIM_RAY_MAX_DISTANCE,
      _ledgeRayOrigin.z + _ledgeRayDir.z * AIM_RAY_MAX_DISTANCE,
    );

    let closestStaticDist = Infinity;
    let closestStaticBody: CANNON.Body | null = null;
    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (result: CANNON.RaycastResult) => {
        if (!result.hasHit || !result.body || result.body === this.player.body) return;
        if (result.body.type !== CANNON.Body.STATIC) return;
        if (result.distance < closestStaticDist) {
          closestStaticDist = result.distance;
          closestStaticBody = result.body;
          _ledgeHitPoint.set(
            result.hitPointWorld.x,
            result.hitPointWorld.y,
            result.hitPointWorld.z,
          );
          _ledgeHitNormal.set(
            result.hitNormalWorld.x,
            result.hitNormalWorld.y,
            result.hitNormalWorld.z,
          );
        }
      },
    );

    // Prioritize dynamic wooden blocks when they are in front of (or flush with) any static geometry
    if (hasBlockHit && this.rawHit.cameraDistance <= closestStaticDist + 0.14) {
      return 'block';
    }

    if (closestStaticBody) {
      if (
        this.resolveStaticHitToLedge(
          closestStaticBody,
          _ledgeHitPoint,
          _ledgeHitNormal,
          this.rawLedgeHit,
        )
      ) {
        return 'ledge';
      }
    }

    // Fallback to dynamic block if static geometry wasn't a ledge (LOS check still rejects occluded blocks)
    return hasBlockHit ? 'block' : 'none';
  }

  /**
   * Resolves a physics raycast hit on a static body (parapet, stone wall, bench, pillar, cliff edge)
   * into an exact reachable ledge lip point + outward horizontal wall normal using Cannon-es raycasts.
   */
  private resolveStaticHitToLedge(
    hitBody: CANNON.Body,
    hitPoint: THREE.Vector3,
    hitNormal: THREE.Vector3,
    out: RawLedgeHit,
  ): boolean {
    const playerY = this.player.body.position.y;
    const playerGroundY = this.player.getGroundSurfaceY();
    const isGrounded = this.player.isGrounded();

    const isElevatedOrDropEdge = (topY: number): boolean => {
      if (topY > playerGroundY + 0.3) return true;
      if (!isGrounded && playerY < topY + 0.55) return true;
      return false;
    };

    // Case 1: Vertical/steep wall face hit -> probe inward & downward for the top ledge surface
    if (Math.abs(hitNormal.y) < 0.45) {
      _ledgeWallNormal.set(hitNormal.x, 0, hitNormal.z);
      const wnLen = _ledgeWallNormal.length();
      if (wnLen < 0.05) return false;
      _ledgeWallNormal.divideScalar(wnLen);

      const inset = 0.16;
      const probeX = hitPoint.x - _ledgeWallNormal.x * inset;
      const probeZ = hitPoint.z - _ledgeWallNormal.z * inset;
      const searchTopY = Math.max(hitPoint.y, playerY + 0.3) + 1.85;
      const searchBottomY = hitPoint.y - 0.35;

      let topBody: CANNON.Body | null = null;
      let topY = -Infinity;
      _cannonFrom.set(probeX, searchTopY, probeZ);
      _cannonTo.set(probeX, searchBottomY, probeZ);
      this.physics.world.raycastAll(
        _cannonFrom,
        _cannonTo,
        { skipBackfaces: true },
        (res: CANNON.RaycastResult) => {
          if (!res.hasHit || !res.body || res.body.type !== CANNON.Body.STATIC) return;
          if (res.hitNormalWorld.y <= 0.72) return;
          if (res.hitPointWorld.y > topY) {
            topY = res.hitPointWorld.y;
            topBody = res.body;
          }
        },
      );

      if (!topBody || !Number.isFinite(topY) || !isElevatedOrDropEdge(topY)) {
        return false;
      }

      // Refine exact outer lip edge just below topY (handles coping overhangs like East Windbreak Wall)
      let lipX = hitPoint.x;
      let lipZ = hitPoint.z;
      let lipBody: CANNON.Body = topBody;
      let lipNormalX = _ledgeWallNormal.x;
      let lipNormalZ = _ledgeWallNormal.z;

      _cannonFrom.set(
        hitPoint.x + _ledgeWallNormal.x * 0.42,
        topY - 0.08,
        hitPoint.z + _ledgeWallNormal.z * 0.42,
      );
      _cannonTo.set(
        hitPoint.x - _ledgeWallNormal.x * 0.32,
        topY - 0.08,
        hitPoint.z - _ledgeWallNormal.z * 0.32,
      );
      let minLipDist = Infinity;
      this.physics.world.raycastAll(
        _cannonFrom,
        _cannonTo,
        { skipBackfaces: true },
        (res: CANNON.RaycastResult) => {
          if (!res.hasHit || !res.body || res.body.type !== CANNON.Body.STATIC) return;
          if (Math.abs(res.hitNormalWorld.y) > 0.45) return;
          if (res.distance < minLipDist) {
            minLipDist = res.distance;
            lipX = res.hitPointWorld.x;
            lipZ = res.hitPointWorld.z;
            lipBody = res.body;
            const nl = Math.hypot(res.hitNormalWorld.x, res.hitNormalWorld.z);
            if (nl > 0.05) {
              lipNormalX = res.hitNormalWorld.x / nl;
              lipNormalZ = res.hitNormalWorld.z / nl;
            }
          }
        },
      );

      if (!this.hasLedgeHeadroom(lipX - lipNormalX * 0.22, topY, lipZ - lipNormalZ * 0.22)) {
        return false;
      }

      out.body = lipBody;
      out.ledgeId = `ledge-${lipBody.id}`;
      out.worldPoint.set(lipX, topY, lipZ);
      out.worldNormal.set(0, 1, 0);
      out.wallNormal.set(lipNormalX, 0, lipNormalZ);
      out.ledgeTopY = topY;
      return true;
    }

    // Case 2: Elevated top surface hit -> find the near vertical lip facing the player via horizontal raycast
    if (hitNormal.y > 0.72) {
      const topY = hitPoint.y;
      if (!isElevatedOrDropEdge(topY)) return false;

      const fromX = this.player.body.position.x;
      const fromZ = this.player.body.position.z;
      const horizDist = Math.hypot(hitPoint.x - fromX, hitPoint.z - fromZ);
      if (horizDist < 0.12) return false;

      const dirX = (hitPoint.x - fromX) / horizDist;
      const dirZ = (hitPoint.z - fromZ) / horizDist;

      // Cast horizontal physics ray just below the top surface from player toward the hit point
      _cannonFrom.set(fromX, topY - 0.11, fromZ);
      _cannonTo.set(hitPoint.x + dirX * 0.25, topY - 0.11, hitPoint.z + dirZ * 0.25);

      let edgeDist = Infinity;
      let edgeBody: CANNON.Body | null = null;
      let edgeX = hitPoint.x;
      let edgeZ = hitPoint.z;
      let edgeNormalX = -dirX;
      let edgeNormalZ = -dirZ;

      this.physics.world.raycastAll(
        _cannonFrom,
        _cannonTo,
        { skipBackfaces: true },
        (res: CANNON.RaycastResult) => {
          if (!res.hasHit || !res.body || res.body.type !== CANNON.Body.STATIC) return;
          if (Math.abs(res.hitNormalWorld.y) > 0.45) return;
          if (res.distance < edgeDist) {
            edgeDist = res.distance;
            edgeBody = res.body;
            edgeX = res.hitPointWorld.x;
            edgeZ = res.hitPointWorld.z;
            const nl = Math.hypot(res.hitNormalWorld.x, res.hitNormalWorld.z);
            if (nl > 0.05) {
              edgeNormalX = res.hitNormalWorld.x / nl;
              edgeNormalZ = res.hitNormalWorld.z / nl;
            }
          }
        },
      );

      const resolvedEdgeBody = edgeBody as CANNON.Body | null;
      if (!resolvedEdgeBody) return false;
      // Ensure the found front wall face belongs to the aimed elevated ledge (not a nearer separate wall)
      if (resolvedEdgeBody !== hitBody && Math.hypot(edgeX - hitPoint.x, edgeZ - hitPoint.z) > 1.35) {
        return false;
      }

      if (!this.hasLedgeHeadroom(edgeX - edgeNormalX * 0.22, topY, edgeZ - edgeNormalZ * 0.22)) {
        return false;
      }

      out.body = resolvedEdgeBody;
      out.ledgeId = `ledge-${resolvedEdgeBody.id}`;
      out.worldPoint.set(edgeX, topY, edgeZ);
      out.worldNormal.set(0, 1, 0);
      out.wallNormal.set(edgeNormalX, 0, edgeNormalZ);
      out.ledgeTopY = topY;
      return true;
    }

    return false;
  }

  private hasLedgeHeadroom(x: number, topY: number, z: number): boolean {
    _cannonFrom.set(x, topY + 0.08, z);
    _cannonTo.set(x, topY + 0.78, z);
    let blocked = false;
    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (res: CANNON.RaycastResult) => {
        if (res.hasHit && res.body && res.body.type === CANNON.Body.STATIC) {
          blocked = true;
        }
      },
    );
    return !blocked;
  }

  /**
   * Forward physics ledge probe used while actively holding grab (e.g. jumping toward a parapet or wall)
   * so midair ledge catching is responsive without allowing grabs through walls.
   */
  private detectForwardLedgeForHand(
    shoulderWorldPos: THREE.Vector3,
    out: RawLedgeHit,
  ): boolean {
    this.cameraRig.getForwardXZ(_camForward);
    const probeHeights = [0.55, 0.1, -0.35];

    for (const dy of probeHeights) {
      const oy = shoulderWorldPos.y + dy;
      _cannonFrom.set(shoulderWorldPos.x, oy, shoulderWorldPos.z);
      _cannonTo.set(
        shoulderWorldPos.x + _camForward.x * (MAX_INTERACTION_DISTANCE - 0.15),
        oy,
        shoulderWorldPos.z + _camForward.z * (MAX_INTERACTION_DISTANCE - 0.15),
      );

      let closestDist = Infinity;
      let hitBody: CANNON.Body | null = null;
      this.physics.world.raycastAll(
        _cannonFrom,
        _cannonTo,
        { skipBackfaces: true },
        (res: CANNON.RaycastResult) => {
          if (!res.hasHit || !res.body || res.body === this.player.body) return;
          if (res.body.type !== CANNON.Body.STATIC) return;
          if (res.distance < closestDist) {
            closestDist = res.distance;
            hitBody = res.body;
            _ledgeHitPoint.set(res.hitPointWorld.x, res.hitPointWorld.y, res.hitPointWorld.z);
            _ledgeHitNormal.set(res.hitNormalWorld.x, res.hitNormalWorld.y, res.hitNormalWorld.z);
          }
        },
      );

      if (hitBody && this.resolveStaticHitToLedge(hitBody, _ledgeHitPoint, _ledgeHitNormal, out)) {
        const dist = shoulderWorldPos.distanceTo(out.worldPoint);
        if (
          dist <= MAX_INTERACTION_DISTANCE &&
          out.body &&
          this.verifyLedgeLineOfSight(shoulderWorldPos, out.worldPoint, out.wallNormal, out.body)
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Verifies direct unobstructed line-of-sight from the hand's shoulder to the front/top clearance
   * of a ledge lip, preventing grabbing ledges through walls or from behind a wall.
   */
  private verifyLedgeLineOfSight(
    shoulderWorldPos: THREE.Vector3,
    ledgePoint: THREE.Vector3,
    wallNormal: THREE.Vector3,
    expectedBody: CANNON.Body,
  ): boolean {
    // Reject grabbing a ledge from behind its wall face
    const relX = shoulderWorldPos.x - ledgePoint.x;
    const relZ = shoulderWorldPos.z - ledgePoint.z;
    const sideDot = relX * wallNormal.x + relZ * wallNormal.z;
    if (sideDot < -0.18) {
      return false;
    }

    // Cast to a clearance point just outside and slightly above the exact lip corner
    _ledgeClearPoint.set(
      ledgePoint.x + wallNormal.x * 0.08,
      ledgePoint.y + 0.06,
      ledgePoint.z + wallNormal.z * 0.08,
    );
    _toHit.copy(_ledgeClearPoint).sub(shoulderWorldPos);
    const dist = _toHit.length();
    if (dist < 0.06) return true;
    _toHit.divideScalar(dist);

    const startOffset = Math.min(0.14, dist * 0.25);
    const checkLen = Math.max(0.01, dist - startOffset);
    _cannonFrom.set(
      shoulderWorldPos.x + _toHit.x * startOffset,
      shoulderWorldPos.y + _toHit.y * startOffset,
      shoulderWorldPos.z + _toHit.z * startOffset,
    );
    _cannonTo.set(_ledgeClearPoint.x, _ledgeClearPoint.y, _ledgeClearPoint.z);

    let obstructed = false;
    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (result: CANNON.RaycastResult) => {
        if (!result.hasHit || !result.body || result.body === this.player.body) return;
        // Any intervening wall (including the same wall if trying to reach through it) blocks the grab
        if (result.distance < checkLen - 0.06) {
          obstructed = true;
        }
      },
    );

    void expectedBody;
    return !obstructed;
  }

  /**
   * Verifies line-of-sight from the hand's shoulder to the block's existing Cannon-es body,
   * ensuring static walls/obstacles block grabs and computing the exact local body anchor
   * needed for pickup, pulling, and climbing constraints.
   */
  private verifyPhysicsLineOfSight(
    shoulderWorldPos: THREE.Vector3,
    targetWorldPoint: THREE.Vector3,
    expectedBody: CANNON.Body,
  ): boolean {
    _toHit.copy(targetWorldPoint).sub(shoulderWorldPos);
    const dist = _toHit.length();
    if (dist < 0.05) return true;

    _toHit.divideScalar(dist);
    // Start slightly clear of the player's own torso collider and extend slightly past the hit face
    const startOffset = Math.min(0.16, dist * 0.25);
    const endDist = dist + 0.22;

    _cannonFrom.set(
      shoulderWorldPos.x + _toHit.x * startOffset,
      shoulderWorldPos.y + _toHit.y * startOffset,
      shoulderWorldPos.z + _toHit.z * startOffset,
    );
    _cannonTo.set(
      shoulderWorldPos.x + _toHit.x * endDist,
      shoulderWorldPos.y + _toHit.y * endDist,
      shoulderWorldPos.z + _toHit.z * endDist,
    );

    let closestDist = Infinity;
    let closestBody: CANNON.Body | null = null;

    this.physics.world.raycastAll(
      _cannonFrom,
      _cannonTo,
      { skipBackfaces: true },
      (result: CANNON.RaycastResult) => {
        if (!result.hasHit || !result.body || result.body === this.player.body) {
          return;
        }
        if (result.distance < closestDist) {
          closestDist = result.distance;
          closestBody = result.body;
        }
      },
    );

    // Valid if unobstructed and the first non-player physics body hit is the targeted block body
    return closestBody === expectedBody || closestBody === null;
  }

  private computeOpenAirAimPoint(shoulderWorldPos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.cameraRig.camera.getWorldDirection(_camForward);
    _aimPlaneNormal.copy(_camForward).negate();
    _aimPlaneAnchor
      .copy(shoulderWorldPos)
      .addScaledVector(_camForward, MAX_INTERACTION_DISTANCE * 0.72);
    _aimPlane.setFromNormalAndCoplanarPoint(_aimPlaneNormal, _aimPlaneAnchor);

    _rayOrigin.copy(this.raycaster.ray.origin);
    _rayDir.copy(this.raycaster.ray.direction);

    const hit = this.raycaster.ray.intersectPlane(_aimPlane, _planeHit);
    if (!hit) {
      out.copy(shoulderWorldPos).addScaledVector(_camForward, MAX_INTERACTION_DISTANCE * 0.75);
      return out;
    }

    // Clamp aim point to maximum interaction distance from shoulder
    _toHit.copy(_planeHit).sub(shoulderWorldPos);
    const len = _toHit.length();
    if (len > MAX_INTERACTION_DISTANCE) {
      _toHit.multiplyScalar(MAX_INTERACTION_DISTANCE / len);
      out.copy(shoulderWorldPos).add(_toHit);
    } else {
      out.copy(_planeHit);
    }
    return out;
  }

  private updateSingleHand(
    side: HandSide,
    isAiming: boolean,
    cameraHitKind: 'none' | 'block' | 'ledge',
    state: HandTargetState,
    storage: GrabTargetMetadata,
    visual: HandVisualIndicator,
    dt: number,
    elapsedSeconds: number,
  ): void {
    state.isAiming = isAiming;
    this.player.getShoulderWorldPosition(side, state.shoulderWorldPos);
    this.player.getHandTipWorldPosition(side, state.handTipWorldPos);

    const heldBlock = side === 'left' ? this.heldLeftBlock : this.heldRightBlock;
    const heldAnchor = side === 'left' ? this.heldLeftAnchor : this.heldRightAnchor;

    if (heldBlock) {
      // Hand is actively holding a dynamic block: keep arm and visual feedback locked onto live anchor
      state.isAiming = true;
      state.isTargetingBlock = true;
      state.isTargetingLedge = false;
      state.isInReach = true;
      state.isLockedOn = true;
      state.aimWorldPoint.copy(heldAnchor);

      storage.block = heldBlock;
      storage.body = heldBlock.body;
      storage.worldPoint.copy(heldAnchor);
      storage.distanceFromShoulder = state.shoulderWorldPos.distanceTo(heldAnchor);
      storage.surfaceKind = 'block';
      storage.ledgeId = null;
      state.target = storage;

      this.player.setHandAimDirective(side, true, true, heldAnchor);

      const accent = side === 'left' ? COLOR_LEFT_LOCK : COLOR_RIGHT_LOCK;
      visual.lockPopScale = THREE.MathUtils.damp(visual.lockPopScale, 1.08, 14, dt);

      visual.markerGroup.visible = true;
      visual.markerGroup.position.copy(heldAnchor);
      visual.markerGroup.quaternion.copy(this.cameraRig.camera.quaternion);
      visual.markerGroup.scale.setScalar(visual.lockPopScale);
      visual.ringMat.color.setHex(accent);
      visual.ringMat.opacity = 0.96;
      visual.dotMesh.visible = true;
      visual.dotMat.opacity = 0.98;

      visual.tetherLine.visible = true;
      visual.tetherMat.color.setHex(accent);
      visual.tetherMat.opacity = 0.78;
      visual.tetherPositions[0] = state.handTipWorldPos.x;
      visual.tetherPositions[1] = state.handTipWorldPos.y;
      visual.tetherPositions[2] = state.handTipWorldPos.z;
      visual.tetherPositions[3] = heldAnchor.x;
      visual.tetherPositions[4] = heldAnchor.y;
      visual.tetherPositions[5] = heldAnchor.z;
      const posAttr = visual.tetherLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      return;
    }

    const ledgeActive = side === 'left' ? this.ledgeLeftActive : this.ledgeRightActive;
    const ledgeBody = side === 'left' ? this.ledgeLeftBody : this.ledgeRightBody;
    const ledgeAnchor = side === 'left' ? this.ledgeLeftAnchor : this.ledgeRightAnchor;
    const ledgeWallNormal =
      side === 'left' ? this.ledgeLeftWallNormal : this.ledgeRightWallNormal;
    const ledgeTopY = side === 'left' ? this.ledgeLeftTopY : this.ledgeRightTopY;
    const ledgeId = side === 'left' ? this.ledgeLeftId : this.ledgeRightId;

    if (ledgeActive && ledgeBody) {
      // Hand is actively gripping a ledge (hanging / climbing): keep arm extended to the live ledge anchor
      state.isAiming = true;
      state.isTargetingBlock = false;
      state.isTargetingLedge = true;
      state.isInReach = true;
      state.isLockedOn = true;
      state.aimWorldPoint.copy(ledgeAnchor);

      storage.block = null;
      storage.body = ledgeBody;
      storage.worldPoint.copy(ledgeAnchor);
      storage.worldNormal.set(0, 1, 0);
      storage.wallNormal.copy(ledgeWallNormal);
      storage.ledgeTopY = ledgeTopY;
      storage.ledgeId = ledgeId;
      storage.distanceFromShoulder = state.shoulderWorldPos.distanceTo(ledgeAnchor);
      storage.surfaceKind = 'ledge';
      state.target = storage;

      this.player.setHandAimDirective(side, true, true, ledgeAnchor);

      const accent = side === 'left' ? COLOR_LEFT_LOCK : COLOR_RIGHT_LOCK;
      visual.lockPopScale = THREE.MathUtils.damp(visual.lockPopScale, 1.1, 14, dt);

      visual.markerGroup.visible = true;
      visual.markerGroup.position.copy(ledgeAnchor).addScaledVector(ledgeWallNormal, 0.02);
      visual.markerGroup.quaternion.copy(this.cameraRig.camera.quaternion);
      visual.markerGroup.scale.setScalar(visual.lockPopScale);
      visual.ringMat.color.setHex(accent);
      visual.ringMat.opacity = 0.96;
      visual.dotMesh.visible = true;
      visual.dotMat.opacity = 0.98;

      visual.tetherLine.visible = true;
      visual.tetherMat.color.setHex(accent);
      visual.tetherMat.opacity = 0.8;
      visual.tetherPositions[0] = state.handTipWorldPos.x;
      visual.tetherPositions[1] = state.handTipWorldPos.y;
      visual.tetherPositions[2] = state.handTipWorldPos.z;
      visual.tetherPositions[3] = ledgeAnchor.x;
      visual.tetherPositions[4] = ledgeAnchor.y;
      visual.tetherPositions[5] = ledgeAnchor.z;
      const posAttr = visual.tetherLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
      return;
    }

    state.isTargetingBlock = false;
    state.isTargetingLedge = false;
    state.isInReach = false;
    state.isLockedOn = false;
    state.target = null;

    if (cameraHitKind === 'block') {
      const dist = state.shoulderWorldPos.distanceTo(this.rawHit.worldPoint);
      state.isTargetingBlock = true;

      if (dist <= MAX_INTERACTION_DISTANCE) {
        const clearLineOfSight = this.verifyPhysicsLineOfSight(
          state.shoulderWorldPos,
          this.rawHit.worldPoint,
          this.rawHit.block.body,
        );

        if (clearLineOfSight) {
          state.isInReach = true;
          storage.block = this.rawHit.block;
          storage.body = this.rawHit.block.body;
          storage.worldPoint.copy(this.rawHit.worldPoint);
          storage.worldNormal.copy(this.rawHit.worldNormal);
          storage.wallNormal.set(0, 0, 1);
          storage.ledgeTopY = 0;
          storage.ledgeId = null;
          storage.distanceFromShoulder = dist;
          storage.surfaceKind = 'block';

          _cannonHitPoint.set(
            this.rawHit.worldPoint.x,
            this.rawHit.worldPoint.y,
            this.rawHit.worldPoint.z,
          );
          this.rawHit.block.body.pointToLocalFrame(_cannonHitPoint, _cannonLocalAnchor);
          storage.localAnchor.copy(_cannonLocalAnchor);

          state.target = storage;
        }
      }
    } else if (cameraHitKind === 'ledge' && this.rawLedgeHit.body) {
      const dist = state.shoulderWorldPos.distanceTo(this.rawLedgeHit.worldPoint);
      state.isTargetingLedge = true;

      if (dist <= MAX_INTERACTION_DISTANCE) {
        const clearLineOfSight = this.verifyLedgeLineOfSight(
          state.shoulderWorldPos,
          this.rawLedgeHit.worldPoint,
          this.rawLedgeHit.wallNormal,
          this.rawLedgeHit.body,
        );

        if (clearLineOfSight) {
          this.assignLedgeTarget(state, storage, this.rawLedgeHit, dist);
        }
      }
    }

    // Mid-jump / close-quarters forward physics ledge probe when actively pressing grab
    if (!state.target && isAiming && cameraHitKind !== 'block') {
      if (this.detectForwardLedgeForHand(state.shoulderWorldPos, this.probeLedgeHit)) {
        const dist = state.shoulderWorldPos.distanceTo(this.probeLedgeHit.worldPoint);
        state.isTargetingLedge = true;
        this.assignLedgeTarget(state, storage, this.probeLedgeHit, dist);
      }
    }

    if (isAiming) {
      if (state.isInReach && state.target) {
        state.isLockedOn = true;
        state.aimWorldPoint.copy(state.target.worldPoint);
      } else if (cameraHitKind === 'block') {
        // Aim toward the out-of-reach block, clamped strictly to MAX_INTERACTION_DISTANCE
        _toHit.copy(this.rawHit.worldPoint).sub(state.shoulderWorldPos);
        const len = _toHit.length();
        if (len > 0.001) {
          _toHit.multiplyScalar(Math.min(len, MAX_INTERACTION_DISTANCE) / len);
          state.aimWorldPoint.copy(state.shoulderWorldPos).add(_toHit);
        } else {
          this.computeOpenAirAimPoint(state.shoulderWorldPos, state.aimWorldPoint);
        }
      } else if (cameraHitKind === 'ledge') {
        // Aim toward the out-of-reach ledge, clamped strictly to MAX_INTERACTION_DISTANCE
        _toHit.copy(this.rawLedgeHit.worldPoint).sub(state.shoulderWorldPos);
        const len = _toHit.length();
        if (len > 0.001) {
          _toHit.multiplyScalar(Math.min(len, MAX_INTERACTION_DISTANCE) / len);
          state.aimWorldPoint.copy(state.shoulderWorldPos).add(_toHit);
        } else {
          this.computeOpenAirAimPoint(state.shoulderWorldPos, state.aimWorldPoint);
        }
      } else {
        this.computeOpenAirAimPoint(state.shoulderWorldPos, state.aimWorldPoint);
      }
    } else if (state.isInReach && state.target) {
      state.aimWorldPoint.copy(state.target.worldPoint);
    } else {
      state.aimWorldPoint.copy(state.handTipWorldPos);
    }

    // Feed directive to PlayerCharacter's arm aiming blend
    this.player.setHandAimDirective(side, state.isAiming, state.isLockedOn, state.aimWorldPoint);

    // Rising-edge audio + ring pop feedback when targeting locks onto a reachable block or ledge
    const currentLockedKey =
      state.isLockedOn && state.target
        ? state.target.surfaceKind === 'block'
          ? (state.target.block?.spec.id ?? null)
          : state.target.ledgeId
        : null;
    const prevLockedKey =
      side === 'left' ? this.prevLeftLockedKey : this.prevRightLockedKey;

    if (currentLockedKey && currentLockedKey !== prevLockedKey) {
      this.audio.playTargetLock(side);
      visual.lockPopScale = 1.42;
    }

    if (side === 'left') {
      this.prevLeftLockedKey = currentLockedKey;
    } else {
      this.prevRightLockedKey = currentLockedKey;
    }

    // Update 3D target reticle & subtle hand-to-target guide line
    visual.lockPopScale = THREE.MathUtils.damp(visual.lockPopScale, 1, 14, dt);

    if (state.isAiming) {
      const accent = side === 'left' ? COLOR_LEFT_LOCK : COLOR_RIGHT_LOCK;

      visual.markerGroup.visible = true;
      if (state.isLockedOn && state.target) {
        if (state.target.surfaceKind === 'ledge') {
          visual.markerGroup.position
            .copy(state.target.worldPoint)
            .addScaledVector(state.target.wallNormal, 0.025);
          visual.markerGroup.quaternion.copy(this.cameraRig.camera.quaternion);
        } else {
          visual.markerGroup.position
            .copy(state.target.worldPoint)
            .addScaledVector(state.target.worldNormal, 0.018);
          _ringQuat.setFromUnitVectors(_zAxis, state.target.worldNormal);
          visual.markerGroup.quaternion.copy(_ringQuat);
        }

        const breathe = 1 + Math.sin(elapsedSeconds * 7.5) * 0.06;
        visual.markerGroup.scale.setScalar(visual.lockPopScale * breathe);
        visual.ringMat.color.setHex(accent);
        visual.ringMat.opacity = 0.92;
        visual.dotMesh.visible = true;
        visual.dotMat.opacity = 0.96;

        visual.tetherMat.color.setHex(accent);
        visual.tetherMat.opacity = 0.62;
      } else {
        // Out of reach or empty air: show subtle face-camera marker at clamped max-reach point
        visual.markerGroup.position.copy(state.aimWorldPoint);
        visual.markerGroup.quaternion.copy(this.cameraRig.camera.quaternion);
        visual.markerGroup.scale.setScalar(0.68);
        visual.ringMat.color.setHex(COLOR_SEARCHING);
        visual.ringMat.opacity = 0.42;
        visual.dotMesh.visible = false;

        visual.tetherMat.color.setHex(COLOR_SEARCHING);
        visual.tetherMat.opacity = 0.24;
      }

      visual.tetherLine.visible = true;
      visual.tetherPositions[0] = state.handTipWorldPos.x;
      visual.tetherPositions[1] = state.handTipWorldPos.y;
      visual.tetherPositions[2] = state.handTipWorldPos.z;
      visual.tetherPositions[3] = state.aimWorldPoint.x;
      visual.tetherPositions[4] = state.aimWorldPoint.y;
      visual.tetherPositions[5] = state.aimWorldPoint.z;
      const posAttr = visual.tetherLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.needsUpdate = true;
    } else {
      visual.markerGroup.visible = false;
      visual.tetherLine.visible = false;
    }
  }

  private assignLedgeTarget(
    state: HandTargetState,
    storage: GrabTargetMetadata,
    hit: RawLedgeHit,
    dist: number,
  ): void {
    if (!hit.body) return;
    state.isInReach = true;
    storage.block = null;
    storage.body = hit.body;
    storage.worldPoint.copy(hit.worldPoint);
    storage.worldNormal.copy(hit.worldNormal);
    storage.wallNormal.copy(hit.wallNormal);
    storage.ledgeTopY = hit.ledgeTopY;
    storage.ledgeId = hit.ledgeId;
    storage.distanceFromShoulder = dist;
    storage.surfaceKind = 'ledge';

    _cannonHitPoint.set(hit.worldPoint.x, hit.worldPoint.y, hit.worldPoint.z);
    hit.body.pointToLocalFrame(_cannonHitPoint, _cannonLocalAnchor);
    storage.localAnchor.copy(_cannonLocalAnchor);

    state.target = storage;
  }

  private updateBlockHighlights(
    dt: number,
    elapsedSeconds: number,
  ): { hoverInReach: boolean; hoverKind: InteractiveSurfaceKind | null } {
    const leftHeldId = this.heldLeftBlock?.spec.id ?? null;
    const rightHeldId = this.heldRightBlock?.spec.id ?? null;

    const leftLockedId =
      leftHeldId ??
      (this.leftState.isLockedOn &&
      this.leftState.target?.surfaceKind === 'block' &&
      this.leftState.target.block
        ? this.leftState.target.block.spec.id
        : null);
    const rightLockedId =
      rightHeldId ??
      (this.rightState.isLockedOn &&
      this.rightState.target?.surfaceKind === 'block' &&
      this.rightState.target.block
        ? this.rightState.target.block.spec.id
        : null);

    // Passive hover highlight when cursor is over a free block reachable by at least one free hand
    let hoverBlockId: string | null = null;
    if (
      !leftHeldId &&
      !this.ledgeLeftActive &&
      !this.leftState.isAiming &&
      this.leftState.isInReach &&
      this.leftState.target?.surfaceKind === 'block' &&
      this.leftState.target.block
    ) {
      hoverBlockId = this.leftState.target.block.spec.id;
    } else if (
      !rightHeldId &&
      !this.ledgeRightActive &&
      !this.rightState.isAiming &&
      this.rightState.isInReach &&
      this.rightState.target?.surfaceKind === 'block' &&
      this.rightState.target.block
    ) {
      hoverBlockId = this.rightState.target.block.spec.id;
    }
    if (hoverBlockId && (hoverBlockId === leftLockedId || hoverBlockId === rightLockedId)) {
      hoverBlockId = null;
    }

    const pulse = 0.85 + Math.sin(elapsedSeconds * 6.5) * 0.15;

    for (const [blockId, vis] of this.blockVisuals) {
      const isLeftHeld = blockId === leftHeldId;
      const isRightHeld = blockId === rightHeldId;
      const isLeft = blockId === leftLockedId;
      const isRight = blockId === rightLockedId;
      const isHover = blockId === hoverBlockId;

      const isActive = isLeft || isRight || isHover;

      if (isActive) {
        vis.outlineLines.visible = true;
        vis.outlineLines.position.copy(vis.block.mesh.position);
        vis.outlineLines.quaternion.copy(vis.block.mesh.quaternion);

        if (isLeft && isRight) {
          vis.outlineMaterial.color.setHex(COLOR_BOTH_LOCK);
          vis.outlineMaterial.opacity = 0.96;
        } else if (isLeft) {
          vis.outlineMaterial.color.setHex(COLOR_LEFT_LOCK);
          vis.outlineMaterial.opacity = isLeftHeld ? 0.98 : 0.9;
        } else if (isRight) {
          vis.outlineMaterial.color.setHex(COLOR_RIGHT_LOCK);
          vis.outlineMaterial.opacity = isRightHeld ? 0.98 : 0.9;
        } else {
          vis.outlineMaterial.color.setHex(COLOR_HOVER_REACH);
          vis.outlineMaterial.opacity = 0.65;
        }
      } else {
        vis.outlineLines.visible = false;
      }

      if (vis.coreMaterial) {
        const isHeld = isLeftHeld || isRightHeld;
        const targetIntensity = isHeld
          ? 0.36
          : isLeft && isRight
            ? 0.34
            : isLeft || isRight
              ? 0.26
              : isHover
                ? 0.12
                : 0;
        vis.emissiveBlend = THREE.MathUtils.damp(vis.emissiveBlend, targetIntensity, 14, dt);

        if (vis.emissiveBlend > 0.004) {
          if (isLeft && isRight) {
            vis.coreMaterial.emissive.setHex(0x10b981);
          } else if (isLeft) {
            vis.coreMaterial.emissive.setHex(0x2563eb);
          } else if (isRight) {
            vis.coreMaterial.emissive.setHex(0xea580c);
          } else if (isHover) {
            vis.coreMaterial.emissive.setHex(0xd97706);
          }
          vis.coreMaterial.emissiveIntensity = isHeld
            ? vis.emissiveBlend * (0.92 + Math.sin(elapsedSeconds * 4.5) * 0.08)
            : vis.emissiveBlend * pulse;
        } else {
          vis.coreMaterial.emissive.setHex(0x000000);
          vis.coreMaterial.emissiveIntensity = 0;
        }
      }
    }

    // Update subtle 3D ledge highlight bar when hovering, locking, or gripping a reachable ledge
    let ledgeBarPoint: THREE.Vector3 | null = null;
    let ledgeBarNormal: THREE.Vector3 | null = null;
    let ledgeBarColor = COLOR_HOVER_REACH;
    let ledgeBarOpacity = 0.72;
    let hoverLedge = false;

    if (this.ledgeLeftActive && this.ledgeRightActive) {
      _ledgeClearPoint.addVectors(this.ledgeLeftAnchor, this.ledgeRightAnchor).multiplyScalar(0.5);
      ledgeBarPoint = _ledgeClearPoint;
      ledgeBarNormal = this.ledgeLeftWallNormal;
      ledgeBarColor = COLOR_BOTH_LOCK;
      ledgeBarOpacity = 0.94;
    } else if (this.ledgeLeftActive) {
      ledgeBarPoint = this.ledgeLeftAnchor;
      ledgeBarNormal = this.ledgeLeftWallNormal;
      ledgeBarColor = COLOR_LEFT_LOCK;
      ledgeBarOpacity = 0.92;
    } else if (this.ledgeRightActive) {
      ledgeBarPoint = this.ledgeRightAnchor;
      ledgeBarNormal = this.ledgeRightWallNormal;
      ledgeBarColor = COLOR_RIGHT_LOCK;
      ledgeBarOpacity = 0.92;
    } else {
      const leftLedgeTarget =
        this.leftState.isInReach && this.leftState.target?.surfaceKind === 'ledge'
          ? this.leftState.target
          : null;
      const rightLedgeTarget =
        this.rightState.isInReach && this.rightState.target?.surfaceKind === 'ledge'
          ? this.rightState.target
          : null;
      const activeLedgeTarget = leftLedgeTarget ?? rightLedgeTarget;
      if (activeLedgeTarget) {
        ledgeBarPoint = activeLedgeTarget.worldPoint;
        ledgeBarNormal = activeLedgeTarget.wallNormal;
        const leftLock = this.leftState.isLockedOn && Boolean(leftLedgeTarget);
        const rightLock = this.rightState.isLockedOn && Boolean(rightLedgeTarget);
        if (leftLock && rightLock) {
          ledgeBarColor = COLOR_BOTH_LOCK;
          ledgeBarOpacity = 0.92;
        } else if (leftLock) {
          ledgeBarColor = COLOR_LEFT_LOCK;
          ledgeBarOpacity = 0.88;
        } else if (rightLock) {
          ledgeBarColor = COLOR_RIGHT_LOCK;
          ledgeBarOpacity = 0.88;
        } else {
          hoverLedge = true;
          ledgeBarColor = COLOR_HOVER_REACH;
          ledgeBarOpacity = 0.65 * pulse;
        }
      }
    }

    if (ledgeBarPoint && ledgeBarNormal) {
      this.ledgeBarMesh.visible = true;
      this.ledgeBarMesh.position
        .copy(ledgeBarPoint)
        .addScaledVector(ledgeBarNormal, 0.028);
      this.ledgeBarMesh.position.y += 0.015;
      _ledgeTangent.set(ledgeBarNormal.z, 0, -ledgeBarNormal.x);
      if (_ledgeTangent.lengthSq() > 0.0001) {
        _ledgeTangent.normalize();
        _barQuat.setFromUnitVectors(_xAxis, _ledgeTangent);
        this.ledgeBarMesh.quaternion.copy(_barQuat);
      }
      this.ledgeBarMat.color.setHex(ledgeBarColor);
      this.ledgeBarMat.opacity = ledgeBarOpacity;
    } else {
      this.ledgeBarMesh.visible = false;
    }

    if (hoverBlockId || leftLockedId || rightLockedId) {
      return { hoverInReach: true, hoverKind: 'block' };
    }
    if (hoverLedge || this.ledgeLeftActive || this.ledgeRightActive || Boolean(ledgeBarPoint)) {
      return { hoverInReach: true, hoverKind: 'ledge' };
    }
    return { hoverInReach: false, hoverKind: null };
  }

  private emitHudSnapshotIfChanged(
    hoverInReach: boolean,
    hoverKind: InteractiveSurfaceKind | null,
  ): void {
    if (!this.onHudChange) return;

    const leftHeld = Boolean(this.heldLeftBlock) || this.ledgeLeftActive;
    const rightHeld = Boolean(this.heldRightBlock) || this.ledgeRightActive;

    const leftMode: HandInteractionMode = this.ledgeLeftActive
      ? this.ledgeLeftMode
      : this.heldLeftBlock
        ? this.heldLeftMode
        : this.leftState.isAiming
          ? 'aiming'
          : 'idle';
    const rightMode: HandInteractionMode = this.ledgeRightActive
      ? this.ledgeRightMode
      : this.heldRightBlock
        ? this.heldRightMode
        : this.rightState.isAiming
          ? 'aiming'
          : 'idle';

    const leftSurfaceKind: InteractiveSurfaceKind | null = this.ledgeLeftActive
      ? 'ledge'
      : this.heldLeftBlock
        ? 'block'
        : this.leftState.isLockedOn && this.leftState.target
          ? this.leftState.target.surfaceKind
          : null;
    const rightSurfaceKind: InteractiveSurfaceKind | null = this.ledgeRightActive
      ? 'ledge'
      : this.heldRightBlock
        ? 'block'
        : this.rightState.isLockedOn && this.rightState.target
          ? this.rightState.target.surfaceKind
          : null;

    const leftBlockId =
      this.heldLeftBlock?.spec.id ??
      this.ledgeLeftId ??
      (this.leftState.isLockedOn
        ? (this.leftState.target?.block?.spec.id ?? this.leftState.target?.ledgeId ?? null)
        : null);
    const rightBlockId =
      this.heldRightBlock?.spec.id ??
      this.ledgeRightId ??
      (this.rightState.isLockedOn
        ? (this.rightState.target?.block?.spec.id ?? this.rightState.target?.ledgeId ?? null)
        : null);

    const leftOutOfReach =
      !leftHeld &&
      this.leftState.isAiming &&
      (this.leftState.isTargetingBlock || this.leftState.isTargetingLedge) &&
      !this.leftState.isInReach;
    const rightOutOfReach =
      !rightHeld &&
      this.rightState.isAiming &&
      (this.rightState.isTargetingBlock || this.rightState.isTargetingLedge) &&
      !this.rightState.isInReach;

    const key = [
      this.leftState.isAiming,
      this.leftState.isLockedOn,
      leftHeld,
      leftMode,
      leftSurfaceKind ?? '',
      leftOutOfReach,
      leftBlockId ?? '',
      this.rightState.isAiming,
      this.rightState.isLockedOn,
      rightHeld,
      rightMode,
      rightSurfaceKind ?? '',
      rightOutOfReach,
      rightBlockId ?? '',
      hoverInReach,
      hoverKind ?? '',
    ].join('|');

    if (key === this.lastHudKey) return;
    this.lastHudKey = key;

    this.onHudChange({
      left: {
        active: this.leftState.isAiming || leftHeld,
        locked: this.leftState.isLockedOn || leftHeld,
        held: leftHeld,
        mode: leftMode,
        surfaceKind: leftSurfaceKind,
        outOfReach: leftOutOfReach,
        blockId: leftBlockId,
      },
      right: {
        active: this.rightState.isAiming || rightHeld,
        locked: this.rightState.isLockedOn || rightHeld,
        held: rightHeld,
        mode: rightMode,
        surfaceKind: rightSurfaceKind,
        outOfReach: rightOutOfReach,
        blockId: rightBlockId,
      },
      hoverInReach,
      hoverKind,
    });
  }

  public update(dt: number, elapsedSeconds: number): void {
    const safeDt = Math.min(dt, 0.05);

    // Ensure player transforms are current so shoulder & mitten world positions are exact
    this.player.root.updateMatrixWorld(true);

    const cameraHitKind = this.raycastSceneFromCamera();
    const leftAiming = this.leftMouseHeld || this.leftKeyHeld;
    const rightAiming = this.rightMouseHeld || this.rightKeyHeld;

    this.updateSingleHand(
      'left',
      leftAiming,
      cameraHitKind,
      this.leftState,
      this.leftTargetStorage,
      this.leftVisual,
      safeDt,
      elapsedSeconds,
    );

    this.updateSingleHand(
      'right',
      rightAiming,
      cameraHitKind,
      this.rightState,
      this.rightTargetStorage,
      this.rightVisual,
      safeDt,
      elapsedSeconds,
    );

    const { hoverInReach, hoverKind } = this.updateBlockHighlights(safeDt, elapsedSeconds);
    this.emitHudSnapshotIfChanged(hoverInReach, hoverKind);
  }

  /**
   * Read-only state for block grab, push/pull, climbing & diagnostics.
   */
  public getHandState(side: HandSide): Readonly<HandTargetState> {
    return side === 'left' ? this.leftState : this.rightState;
  }

  /**
   * Returns verified existing physics body + local anchor point when a hand is locked onto a target.
   */
  public getGrabAnchorForPhysics(side: HandSide): GrabTargetMetadata | null {
    const state = side === 'left' ? this.leftState : this.rightState;
    return state.isLockedOn && state.target ? state.target : null;
  }

  public isHandInputHeld(side: HandSide): boolean {
    return side === 'left'
      ? this.leftMouseHeld || this.leftKeyHeld
      : this.rightMouseHeld || this.rightKeyHeld;
  }

  public getMouseNdc(out: THREE.Vector2): THREE.Vector2 {
    if (this.cameraRig.isPointerLocked() || !this.hasMousePosition) {
      return out.set(0, 0);
    }
    return out.copy(this.mouseNdc);
  }

  /**
   * Syncs active held-object visual & interaction mode state from HandGrabSystem (Steps 2 & 3)
   * without duplicating highlights, markers, or arm aiming logic.
   */
  public setHeldState(
    side: HandSide,
    block: DynamicBlockInstance | null,
    worldAnchor?: THREE.Vector3,
    mode: 'carry' | 'push' | 'pull' = 'carry',
  ): void {
    if (side === 'left') {
      this.heldLeftBlock = block;
      this.heldLeftMode = mode;
      if (block && worldAnchor) {
        this.heldLeftAnchor.copy(worldAnchor);
      } else if (!block) {
        this.prevLeftLockedKey = null;
      }
    } else {
      this.heldRightBlock = block;
      this.heldRightMode = mode;
      if (block && worldAnchor) {
        this.heldRightAnchor.copy(worldAnchor);
      } else if (!block) {
        this.prevRightLockedKey = null;
      }
    }
  }

  /**
   * Syncs active ledge-grab visual & interaction mode state from LedgeClimbSystem (Step 4).
   */
  public setLedgeGrabState(
    side: HandSide,
    active: boolean,
    body: CANNON.Body | null = null,
    ledgeId: string | null = null,
    worldAnchor?: THREE.Vector3,
    wallNormal?: THREE.Vector3,
    ledgeTopY = 0,
    mode: 'hang' | 'climb' = 'hang',
  ): void {
    if (side === 'left') {
      this.ledgeLeftActive = active;
      this.ledgeLeftBody = active ? body : null;
      this.ledgeLeftId = active ? ledgeId : null;
      this.ledgeLeftMode = mode;
      this.ledgeLeftTopY = ledgeTopY;
      if (active && worldAnchor) {
        this.ledgeLeftAnchor.copy(worldAnchor);
      }
      if (active && wallNormal) {
        this.ledgeLeftWallNormal.copy(wallNormal);
      }
      if (!active) {
        this.prevLeftLockedKey = null;
      }
    } else {
      this.ledgeRightActive = active;
      this.ledgeRightBody = active ? body : null;
      this.ledgeRightId = active ? ledgeId : null;
      this.ledgeRightMode = mode;
      this.ledgeRightTopY = ledgeTopY;
      if (active && worldAnchor) {
        this.ledgeRightAnchor.copy(worldAnchor);
      }
      if (active && wallNormal) {
        this.ledgeRightWallNormal.copy(wallNormal);
      }
      if (!active) {
        this.prevRightLockedKey = null;
      }
    }
  }

  public getMaxInteractionDistance(): number {
    return MAX_INTERACTION_DISTANCE;
  }

  public dispose(): void {
    window.removeEventListener('pointermove', this.handlePointerMove);
    this.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    // Restore block emissive colors cleanly
    for (const vis of this.blockVisuals.values()) {
      if (vis.coreMaterial) {
        vis.coreMaterial.emissive.setHex(0x000000);
        vis.coreMaterial.emissiveIntensity = 0;
      }
    }

    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
