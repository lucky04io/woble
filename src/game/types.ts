import type * as THREE from 'three';
import type * as CANNON from 'cannon-es';

export interface Vec3Tuple {
  x: number;
  y: number;
  z: number;
}

export interface StaticBoxSpec {
  size: [number, number, number];
  position: [number, number, number];
  rotationY?: number;
}

export interface DynamicBlockSpec {
  id: string;
  size: [number, number, number];
  initialPosition: [number, number, number];
  initialRotationY?: number;
  color: number;
  mass: number;
}

export interface DynamicBlockInstance {
  spec: DynamicBlockSpec;
  mesh: THREE.Group;
  body: CANNON.Body;
}

export type HandSide = 'left' | 'right';

export type InteractiveSurfaceKind = 'block' | 'ledge';

export interface GrabTargetMetadata {
  block: DynamicBlockInstance | null;
  body: CANNON.Body;
  worldPoint: THREE.Vector3;
  localAnchor: CANNON.Vec3;
  worldNormal: THREE.Vector3;
  wallNormal: THREE.Vector3;
  ledgeTopY: number;
  ledgeId: string | null;
  distanceFromShoulder: number;
  surfaceKind: InteractiveSurfaceKind;
}

export interface HandTargetState {
  side: HandSide;
  isAiming: boolean;
  isTargetingBlock: boolean;
  isTargetingLedge: boolean;
  isInReach: boolean;
  isLockedOn: boolean;
  shoulderWorldPos: THREE.Vector3;
  handTipWorldPos: THREE.Vector3;
  aimWorldPoint: THREE.Vector3;
  target: GrabTargetMetadata | null;
}

export interface HandAimDirective {
  active: boolean;
  lockedOn: boolean;
  worldTarget: THREE.Vector3;
}

export type HandInteractionMode =
  | 'idle'
  | 'aiming'
  | 'carry'
  | 'push'
  | 'pull'
  | 'hang'
  | 'climb';

export interface HandHudStatus {
  active: boolean;
  locked: boolean;
  held: boolean;
  mode: HandInteractionMode;
  surfaceKind: InteractiveSurfaceKind | null;
  outOfReach: boolean;
  blockId: string | null;
}

export interface HeldBlockState {
  side: HandSide;
  block: DynamicBlockInstance;
  body: CANNON.Body;
  localAnchor: CANNON.Vec3;
  worldAnchor: THREE.Vector3;
  holdTarget: THREE.Vector3;
  holdVelocity: THREE.Vector3;
  mode: 'carry' | 'push' | 'pull';
}

export interface LedgeGrabState {
  side: HandSide;
  ledgeId: string;
  body: CANNON.Body;
  localAnchor: CANNON.Vec3;
  worldAnchor: THREE.Vector3;
  wallNormal: THREE.Vector3;
  ledgeTopY: number;
  mode: 'hang' | 'climb';
}

export interface HangingCharacterState {
  isHanging: boolean;
  isClimbing: boolean;
  handCount: number;
  wallNormalX: number;
  wallNormalZ: number;
  stretchAmount: number;
  shimmySpeed: number;
}

export interface HandTargetingHudSnapshot {
  left: HandHudStatus;
  right: HandHudStatus;
  hoverInReach: boolean;
  hoverKind: InteractiveSurfaceKind | null;
}

export interface GameEngineCallbacks {
  onPointerLockChange: (locked: boolean) => void;
  onWebGLError: (message: string) => void;
  onHandTargetingChange?: (snapshot: HandTargetingHudSnapshot) => void;
}

export interface GameEngineHandle {
  dropCharacterFromSky: () => void;
  nudgeCharacter: () => void;
  resetBlocks: () => void;
  togglePointerLock: () => void;
  dispose: () => void;
}
