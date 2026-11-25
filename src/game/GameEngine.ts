import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { GameEngineCallbacks, GameEngineHandle } from './types';
import { createProceduralTextures } from './textures';
import { ProceduralAudio } from './audio';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { ObservatoryEnvironment } from './world/ObservatoryEnvironment';
import { PlayerCharacter } from './character/PlayerCharacter';
import { ThirdPersonCamera } from './camera/ThirdPersonCamera';
import { KeyboardInput, type MovementInputState } from './input/KeyboardInput';
import { HandTargetingSystem } from './interaction/HandTargetingSystem';
import { HandGrabSystem } from './interaction/HandGrabSystem';
import { LedgeClimbSystem } from './interaction/LedgeClimbSystem';

// Pre-allocated scratch vectors (zero GC in render loop)
const _followTarget = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _moveDirWorld = new THREE.Vector3();
const _inputState: MovementInputState = {
  forward: 0,
  right: 0,
  run: false,
  jumpBuffered: false,
  jumpHeld: false,
};

function detectSoftwareWebGL(): boolean {
  try {
    const probeCanvas = document.createElement('canvas');
    const gl = probeCanvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

export function createGameEngine(
  mountContainer: HTMLElement,
  callbacks: GameEngineCallbacks,
): GameEngineHandle | null {
  const isSoftwareGl = detectSoftwareWebGL();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
  } catch {
    callbacks.onWebGLError('WebGL could not be initialized in this browser.');
    return null;
  }

  const width = Math.max(1, mountContainer.clientWidth || window.innerWidth);
  const height = Math.max(1, mountContainer.clientHeight || window.innerHeight);

  renderer.setSize(width, height);
  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  mountContainer.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd8ebf8);

  // Studio environment reflections (PMREM RoomEnvironment) on every device
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envTarget = pmremGenerator.fromScene(roomEnv, 0.04);
  scene.environment = envTarget.texture;
  scene.environmentIntensity = 0.55;
  roomEnv.dispose();
  pmremGenerator.dispose();

  // Balanced 3-point warm/cool alpine daylight lighting rig
  const hemiLight = new THREE.HemisphereLight(0xb2dcff, 0xd4c3ae, 0.92);
  hemiLight.position.set(0, 45, 0);
  scene.add(hemiLight);

  const sunKeyLight = new THREE.DirectionalLight(0xfff3de, 2.05);
  sunKeyLight.position.set(18, 28, 16);
  sunKeyLight.castShadow = true;
  sunKeyLight.shadow.mapSize.width = 2048;
  sunKeyLight.shadow.mapSize.height = 2048;
  sunKeyLight.shadow.camera.near = 2;
  sunKeyLight.shadow.camera.far = 78;
  const shadowExtent = 21;
  sunKeyLight.shadow.camera.left = -shadowExtent;
  sunKeyLight.shadow.camera.right = shadowExtent;
  sunKeyLight.shadow.camera.top = shadowExtent;
  sunKeyLight.shadow.camera.bottom = -shadowExtent;
  sunKeyLight.shadow.bias = -0.0005;
  sunKeyLight.shadow.normalBias = 0.025;
  sunKeyLight.shadow.radius = 2.5;
  scene.add(sunKeyLight);

  // Soft cool rim light to sculpt the white humanoid silhouette cleanly
  const rimLight = new THREE.DirectionalLight(0xcbe2ff, 0.55);
  rimLight.position.set(-18, 14, -20);
  scene.add(rimLight);

  // Core game subsystems
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const textures = createProceduralTextures(maxAnisotropy);
  const audio = new ProceduralAudio();
  const physics = new PhysicsWorld();
  const environment = new ObservatoryEnvironment(scene, physics, textures, audio);
  const player = new PlayerCharacter(scene, physics, textures, audio);
  const cameraRig = new ThirdPersonCamera(
    width / height,
    renderer.domElement,
    environment.cameraColliders,
    callbacks.onPointerLockChange,
    () => audio.unlock(),
  );
  const keyboard = new KeyboardInput(() => audio.unlock());
  const handTargeting = new HandTargetingSystem(
    scene,
    renderer.domElement,
    cameraRig,
    player,
    physics,
    environment.dynamicBlocks,
    audio,
    callbacks.onHandTargetingChange,
  );
  const handGrab = new HandGrabSystem(handTargeting, player, cameraRig, audio);
  const ledgeClimb = new LedgeClimbSystem(
    handTargeting,
    player,
    physics,
    audio,
    (side) => handGrab.isHolding(side),
  );
  handGrab.setLedgeBusyCheck((side) => ledgeClimb.isGrabbingLedge(side));

  // Initialize camera position on frame 0 so initial render is perfectly framed
  player.getFollowTarget(_followTarget);
  cameraRig.update(_followTarget, 0.016, 0);

  if (!isSoftwareGl) {
    renderer.compile(scene, cameraRig.camera);
  }

  let disposed = false;
  let contextLost = false;
  let frameId = 0;
  let lastTimestamp = performance.now();
  let elapsedSeconds = 0;

  const handleContextLost = (event: Event): void => {
    event.preventDefault();
    contextLost = true;
  };

  const handleContextRestored = (): void => {
    contextLost = false;
    lastTimestamp = performance.now();
    scheduleNextFrame();
  };

  renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
  renderer.domElement.addEventListener('webglcontextrestored', handleContextRestored);

  const handleResize = (): void => {
    if (disposed) return;
    const nextW = Math.max(1, mountContainer.clientWidth || window.innerWidth);
    const nextH = Math.max(1, mountContainer.clientHeight || window.innerHeight);
    cameraRig.setAspect(nextW / nextH);
    renderer.setSize(nextW, nextH);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  };
  window.addEventListener('resize', handleResize);

  function afterDraw(cb: () => void): void {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (disposed) {
        if (sync) gl.deleteSync(sync);
        return;
      }
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        frameId = window.setTimeout(cb, 80);
      }
    };
    frameId = window.setTimeout(poll, 5);
  }

  function scheduleNextFrame(): void {
    if (disposed || contextLost) return;
    if (isSoftwareGl) {
      afterDraw(tick);
    } else {
      frameId = window.requestAnimationFrame(tick);
    }
  }

  const consumeJump = (): boolean => keyboard.consumeJumpBuffer();

  function tick(): void {
    if (disposed || contextLost) return;

    const now = performance.now();
    const rawDelta = (now - lastTimestamp) / 1000;
    lastTimestamp = now;
    const dt = Math.min(Math.max(rawDelta, 0.001), 0.1);
    elapsedSeconds += dt;

    // 0. Sample keyboard input & project onto camera-relative horizontal basis
    keyboard.tick(dt);
    keyboard.getState(_inputState);
    cameraRig.getForwardXZ(_camForward);
    cameraRig.getRightXZ(_camRight);

    _moveDirWorld
      .set(0, 0, 0)
      .addScaledVector(_camForward, _inputState.forward)
      .addScaledVector(_camRight, _inputState.right);
    if (_moveDirWorld.lengthSq() > 1) {
      _moveDirWorld.normalize();
    }

    // 1. Fixed-timestep rigid-body physics step + locomotion + upright stabilization + grab/push/pull + ledge climbing
    physics.step(dt, (fixedDt) => {
      ledgeClimb.pushHangingStateToPlayer();
      player.applyPreStepForces(
        fixedDt,
        physics.world,
        _moveDirWorld,
        _inputState.run,
        consumeJump,
      );
      handGrab.applyPreStepForces(fixedDt, _moveDirWorld, _inputState.run);
      ledgeClimb.applyPreStepForces(
        fixedDt,
        _moveDirWorld,
        _inputState.run,
        consumeJump,
        _inputState.jumpHeld,
      );
    });

    // 2. Sync dynamic meshes & procedural semi-wobbly limbs
    environment.syncPhysicsVisuals(elapsedSeconds);
    player.syncVisualFromBody(dt, elapsedSeconds);

    // 3. Smooth third-person camera tracking & wall collision avoidance
    player.getFollowTarget(_followTarget);
    cameraRig.update(_followTarget, dt, player.getRunRatio());

    // 4. Independent left/right hand raycast targeting, block/ledge grab acquisition & visual feedback
    handTargeting.update(dt, elapsedSeconds);
    handGrab.syncAfterTargeting();
    ledgeClimb.syncAfterTargeting();

    // 5. Render frame
    renderer.render(scene, cameraRig.camera);

    scheduleNextFrame();
  }

  // Kick off simulation loop
  frameId = window.requestAnimationFrame(tick);

  return {
    dropCharacterFromSky() {
      audio.unlock();
      handGrab.releaseAll(false);
      ledgeClimb.releaseAll(false);
      player.dropFromSky();
    },
    nudgeCharacter() {
      audio.unlock();
      cameraRig.getForwardXZ(_camForward);
      player.applyNudge(_camForward);
    },
    resetBlocks() {
      audio.unlock();
      handGrab.releaseAll(false);
      environment.resetBlocks();
    },
    togglePointerLock() {
      cameraRig.togglePointerLock();
    },
    dispose() {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      window.removeEventListener('resize', handleResize);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', handleContextRestored);
      keyboard.dispose();
      ledgeClimb.dispose();
      handGrab.dispose();
      handTargeting.dispose();
      cameraRig.dispose();
      player.dispose();
      environment.dispose();
      textures.dispose();
      audio.dispose();
      envTarget.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === mountContainer) {
        mountContainer.removeChild(renderer.domElement);
      }
    },
  };
}
