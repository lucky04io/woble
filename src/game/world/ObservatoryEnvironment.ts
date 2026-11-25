import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { DynamicBlockInstance, DynamicBlockSpec, StaticBoxSpec } from '../types';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { ProceduralTextureSet } from '../textures';
import type { ProceduralAudio } from '../audio';

const DYNAMIC_BLOCK_SPECS: DynamicBlockSpec[] = [
  // Stack A: East-North plaza pyramid (close to player spawn for immediate nudge/collision testing)
  {
    id: 'block-a1',
    size: [0.85, 0.85, 0.85],
    initialPosition: [2.1, 0.43, -1.6],
    initialRotationY: 0.12,
    color: 0xe8957a, // pastel coral terracotta
    mass: 2.4,
  },
  {
    id: 'block-a2',
    size: [0.85, 0.85, 0.85],
    initialPosition: [3.05, 0.43, -1.48],
    initialRotationY: -0.06,
    color: 0xf3cf7a, // soft butter yellow
    mass: 2.4,
  },
  {
    id: 'block-a3',
    size: [0.85, 0.85, 0.85],
    initialPosition: [2.58, 1.29, -1.54],
    initialRotationY: 0.08,
    color: 0x8ea7d6, // dusty periwinkle
    mass: 2.0,
  },
  {
    id: 'block-a4',
    size: [0.72, 0.72, 0.72],
    initialPosition: [2.58, 2.09, -1.54],
    initialRotationY: -0.18,
    color: 0xa2cba4, // pastel sage
    mass: 1.6,
  },

  // Stack B: West plaza stepped trio
  {
    id: 'block-b1',
    size: [1.1, 0.65, 0.75],
    initialPosition: [-2.6, 0.33, 1.35],
    initialRotationY: 0.25,
    color: 0x95b8d9, // sky slate blue
    mass: 2.8,
  },
  {
    id: 'block-b2',
    size: [0.78, 0.78, 0.78],
    initialPosition: [-2.62, 1.06, 1.34],
    initialRotationY: -0.1,
    color: 0xf0b589, // warm apricot
    mass: 2.0,
  },
  {
    id: 'block-b3',
    size: [0.68, 0.68, 0.68],
    initialPosition: [-1.4, 0.35, 2.1],
    initialRotationY: 0.4,
    color: 0xd9a7c7, // muted pastel lilac
    mass: 1.8,
  },
];

function createBeveledBlockGroup(
  size: [number, number, number],
  color: number,
  woodTexture: THREE.CanvasTexture,
  brassMaterial: THREE.MeshStandardMaterial,
): THREE.Group {
  const [w, h, d] = size;
  const group = new THREE.Group();

  // Primary painted wood cube slightly inset with rounded-feeling edge trim
  const mainMat = new THREE.MeshStandardMaterial({
    color,
    map: woodTexture,
    roughness: 0.66,
    metalness: 0.04,
  });

  const coreGeo = new THREE.BoxGeometry(w, h, d);
  const coreMesh = new THREE.Mesh(coreGeo, mainMat);
  coreMesh.castShadow = true;
  coreMesh.receiveShadow = true;
  group.add(coreMesh);

  // Subtle recessed light-cream side band for toybox craftsmanship
  const bandMat = new THREE.MeshStandardMaterial({
    color: 0xf8f4ec,
    roughness: 0.78,
    metalness: 0.02,
  });
  const bandGeo = new THREE.BoxGeometry(w + 0.015, h * 0.14, d + 0.015);
  const bandMesh = new THREE.Mesh(bandGeo, bandMat);
  bandMesh.castShadow = false;
  bandMesh.receiveShadow = true;
  group.add(bandMesh);

  // Small brass corner studs on top face
  const studGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10);
  const insetX = w * 0.34;
  const insetZ = d * 0.34;
  const offsets: [number, number][] = [
    [-insetX, -insetZ],
    [insetX, -insetZ],
    [-insetX, insetZ],
    [insetX, insetZ],
  ];
  for (const [ox, oz] of offsets) {
    const stud = new THREE.Mesh(studGeo, brassMaterial);
    stud.position.set(ox, h * 0.5 + 0.008, oz);
    stud.receiveShadow = true;
    group.add(stud);
  }

  return group;
}

export class ObservatoryEnvironment {
  public readonly root = new THREE.Group();
  public readonly cameraColliders: THREE.Object3D[] = [];
  public readonly dynamicBlocks: DynamicBlockInstance[] = [];

  private readonly clouds: { group: THREE.Group; baseAngle: number; radius: number; speed: number; y: number }[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(
    scene: THREE.Scene,
    physics: PhysicsWorld,
    textures: ProceduralTextureSet,
    audio: ProceduralAudio,
  ) {
    scene.add(this.root);

    // Horizon-matched alpine mist fog
    scene.fog = new THREE.FogExp2(0xe6eff6, 0.0062);

    this.buildSkyDome(textures);
    const materials = this.createMaterials(textures);

    this.buildTerraceGround(physics, materials, textures);
    this.buildObservatoryPavilion(physics, materials);
    this.buildWallsAndArchways(physics, materials);
    this.buildPerimeterParapets(physics, materials);
    this.buildAlpineFoliageAndRocks();
    this.buildDistantMountainRing();
    this.buildDriftingClouds();
    this.buildDynamicBlocks(physics, textures, materials.brass, audio);
  }

  private createMaterials(textures: ProceduralTextureSet) {
    const limestone = new THREE.MeshStandardMaterial({
      color: 0xf4f0e8,
      map: textures.limestoneTile,
      roughness: 0.82,
      metalness: 0.02,
    });

    const plaster = new THREE.MeshStandardMaterial({
      color: 0xf7f3ec,
      map: textures.mattePlaster,
      roughness: 0.86,
      metalness: 0.02,
    });

    const terracotta = new THREE.MeshStandardMaterial({
      color: 0xe6957c,
      map: textures.mattePlaster,
      roughness: 0.78,
      metalness: 0.03,
    });

    const periwinkle = new THREE.MeshStandardMaterial({
      color: 0x8fa8d6,
      map: textures.mattePlaster,
      roughness: 0.68,
      metalness: 0.08,
    });

    const sageTurf = new THREE.MeshStandardMaterial({
      color: 0xa4c89f,
      roughness: 0.92,
      metalness: 0.0,
    });

    const cliffRock = new THREE.MeshStandardMaterial({
      color: 0xc9c3bb,
      roughness: 0.94,
      metalness: 0.02,
      flatShading: true,
    });

    const brass = new THREE.MeshStandardMaterial({
      color: 0xdcc07b,
      map: textures.brushedBrass,
      roughness: 0.3,
      metalness: 0.82,
    });

    const darkSlate = new THREE.MeshStandardMaterial({
      color: 0x3b4456,
      roughness: 0.45,
      metalness: 0.35,
    });

    this.disposables.push(
      limestone,
      plaster,
      terracotta,
      periwinkle,
      sageTurf,
      cliffRock,
      brass,
      darkSlate,
    );

    return {
      limestone,
      plaster,
      terracotta,
      periwinkle,
      sageTurf,
      cliffRock,
      brass,
      darkSlate,
    };
  }

  private buildSkyDome(textures: ProceduralTextureSet): void {
    const skyGeo = new THREE.SphereGeometry(260, 32, 24);
    const skyMat = new THREE.MeshBasicMaterial({
      map: textures.skyGradient,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    skyMesh.renderOrder = -10;
    this.root.add(skyMesh);

    // Soft warm sun disc glowing gently in the upper sky
    const sunGeo = new THREE.CircleGeometry(14, 32);
    const sunMat = new THREE.MeshBasicMaterial({
      color: 0xfff8e6,
      fog: false,
      transparent: true,
      opacity: 0.85,
    });
    const sunDisc = new THREE.Mesh(sunGeo, sunMat);
    sunDisc.position.set(95, 118, 70);
    sunDisc.lookAt(0, 0, 0);
    this.root.add(sunDisc);

    this.disposables.push(skyGeo, skyMat, sunGeo, sunMat);
  }

  private addStaticSolidBox(
    physics: PhysicsWorld,
    spec: StaticBoxSpec,
    material: THREE.Material,
    registerForCamera = true,
  ): THREE.Mesh {
    const [w, h, d] = spec.size;
    const [x, y, z] = spec.position;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(x, y, z);
    if (spec.rotationY) {
      mesh.rotation.y = spec.rotationY;
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this.disposables.push(geo);

    physics.addStaticBox(spec);
    if (registerForCamera) {
      this.cameraColliders.push(mesh);
    }
    return mesh;
  }

  private buildTerraceGround(
    physics: PhysicsWorld,
    materials: ReturnType<ObservatoryEnvironment['createMaterials']>,
    textures: ProceduralTextureSet,
  ): void {
    // Main solid limestone plaza slab: top sits cleanly at y = 0.0
    const mainGround = this.addStaticSolidBox(
      physics,
      { size: [34, 4, 34], position: [0, -2, 0] },
      materials.limestone,
      true,
    );
    mainGround.castShadow = false;

    // Outer stepped alpine meadow terrace extending naturally beyond the plaza
    const meadowGeo = new THREE.CylinderGeometry(28, 36, 5.5, 16);
    const meadow = new THREE.Mesh(meadowGeo, materials.sageTurf);
    meadow.position.set(0, -3.25, 0);
    meadow.receiveShadow = true;
    this.root.add(meadow);
    this.cameraColliders.push(meadow);
    this.disposables.push(meadowGeo);

    // Lower mountain peak rocky plinth grounding the observatory plateau
    const cliffGeo = new THREE.CylinderGeometry(35, 62, 34, 14);
    const cliff = new THREE.Mesh(cliffGeo, materials.cliffRock);
    cliff.position.set(0, -22.5, 0);
    cliff.receiveShadow = true;
    this.root.add(cliff);
    this.disposables.push(cliffGeo);

    // Decorative brass astronomical compass rose inlay at plaza center (offset +0.025 to avoid Z-fighting)
    const compassGroup = new THREE.Group();
    compassGroup.position.set(0, 0.025, 0);

    const outerRingGeo = new THREE.RingGeometry(4.4, 4.75, 64);
    outerRingGeo.rotateX(-Math.PI / 2);
    const ringMat = materials.brass.clone();
    ringMat.polygonOffset = true;
    ringMat.polygonOffsetFactor = -1;
    ringMat.polygonOffsetUnits = -1;
    const outerRing = new THREE.Mesh(outerRingGeo, ringMat);
    outerRing.receiveShadow = true;
    compassGroup.add(outerRing);

    const innerRingGeo = new THREE.RingGeometry(1.75, 1.95, 48);
    innerRingGeo.rotateX(-Math.PI / 2);
    const innerRing = new THREE.Mesh(innerRingGeo, ringMat);
    innerRing.receiveShadow = true;
    compassGroup.add(innerRing);

    // Subtle pastel terrazzo stone center disc
    const centerDiscGeo = new THREE.CircleGeometry(1.75, 48);
    centerDiscGeo.rotateX(-Math.PI / 2);
    const centerDiscMat = new THREE.MeshStandardMaterial({
      color: 0xe6e0d4,
      map: textures.mattePlaster,
      roughness: 0.78,
      metalness: 0.04,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const centerDisc = new THREE.Mesh(centerDiscGeo, centerDiscMat);
    centerDisc.position.y = -0.005;
    centerDisc.receiveShadow = true;
    compassGroup.add(centerDisc);

    // 4 cardinal compass pointers
    const pointerGeo = new THREE.BoxGeometry(0.18, 0.02, 2.45);
    for (let i = 0; i < 4; i++) {
      const pointer = new THREE.Mesh(pointerGeo, ringMat);
      const angle = (i * Math.PI) / 2;
      pointer.position.set(Math.sin(angle) * 3.15, 0.005, Math.cos(angle) * 3.15);
      pointer.rotation.y = angle;
      pointer.receiveShadow = true;
      compassGroup.add(pointer);
    }

    this.root.add(compassGroup);
    this.disposables.push(outerRingGeo, innerRingGeo, centerDiscGeo, centerDiscMat, pointerGeo, ringMat);
  }

  private buildObservatoryPavilion(
    physics: PhysicsWorld,
    materials: ReturnType<ObservatoryEnvironment['createMaterials']>,
  ): void {
    // Composite multi-part pastel mountain observatory dome on north plaza edge
    const pavilion = new THREE.Group();
    pavilion.position.set(0, 0, -12.6);

    // 1. Stepped octagonal stone plinth
    const plinthGeo = new THREE.CylinderGeometry(5.1, 5.5, 0.7, 16);
    const plinth = new THREE.Mesh(plinthGeo, materials.limestone);
    plinth.position.y = 0.35;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    pavilion.add(plinth);

    // 2. Cylindrical cream plaster rotunda drum
    const drumGeo = new THREE.CylinderGeometry(4.3, 4.45, 4.0, 28);
    const drum = new THREE.Mesh(drumGeo, materials.plaster);
    drum.position.y = 2.7;
    drum.castShadow = true;
    drum.receiveShadow = true;
    pavilion.add(drum);

    // 3. Terracotta cornice ring
    const corniceGeo = new THREE.CylinderGeometry(4.65, 4.45, 0.48, 28);
    const cornice = new THREE.Mesh(corniceGeo, materials.terracotta);
    cornice.position.y = 4.82;
    cornice.castShadow = true;
    cornice.receiveShadow = true;
    pavilion.add(cornice);

    // 4. Brushed brass equatorial rail
    const railGeo = new THREE.TorusGeometry(4.56, 0.09, 12, 36);
    railGeo.rotateX(Math.PI / 2);
    const rail = new THREE.Mesh(railGeo, materials.brass);
    rail.position.y = 5.1;
    pavilion.add(rail);

    // 5. Pastel periwinkle hemispherical observatory dome
    const domeGeo = new THREE.SphereGeometry(4.25, 32, 20, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const dome = new THREE.Mesh(domeGeo, materials.periwinkle);
    dome.position.y = 5.05;
    dome.castShadow = true;
    dome.receiveShadow = true;
    pavilion.add(dome);

    // 6. Dark recessed dome shutter aperture strip
    const shutterGeo = new THREE.BoxGeometry(1.15, 3.6, 1.5);
    const shutter = new THREE.Mesh(shutterGeo, materials.darkSlate);
    shutter.position.set(0, 7.1, 2.75);
    shutter.rotation.x = -0.58;
    pavilion.add(shutter);

    // 7. Protruding brushed-brass telescope assembly
    const telescopeGroup = new THREE.Group();
    telescopeGroup.position.set(0, 7.15, 2.4);
    telescopeGroup.rotation.x = -0.68;

    const mainTubeGeo = new THREE.CylinderGeometry(0.42, 0.52, 3.1, 20);
    mainTubeGeo.rotateX(Math.PI / 2);
    const mainTube = new THREE.Mesh(mainTubeGeo, materials.brass);
    mainTube.position.z = 1.1;
    mainTube.castShadow = true;
    telescopeGroup.add(mainTube);

    const lensHoodGeo = new THREE.CylinderGeometry(0.5, 0.45, 0.65, 20);
    lensHoodGeo.rotateX(Math.PI / 2);
    const lensHood = new THREE.Mesh(lensHoodGeo, materials.darkSlate);
    lensHood.position.z = 2.7;
    lensHood.castShadow = true;
    telescopeGroup.add(lensHood);

    pavilion.add(telescopeGroup);

    // 8. Arched warm wooden entrance facade facing south toward the player
    const doorwayFrameGeo = new THREE.BoxGeometry(2.5, 3.1, 0.8);
    const doorwayFrame = new THREE.Mesh(doorwayFrameGeo, materials.terracotta);
    doorwayFrame.position.set(0, 2.2, 4.15);
    doorwayFrame.castShadow = true;
    doorwayFrame.receiveShadow = true;
    pavilion.add(doorwayFrame);

    const doorPanelGeo = new THREE.BoxGeometry(1.7, 2.55, 0.9);
    const doorPanel = new THREE.Mesh(doorPanelGeo, materials.darkSlate);
    doorPanel.position.set(0, 1.98, 4.18);
    pavilion.add(doorPanel);

    // 9. Decorative radial pilasters around drum
    const pilasterGeo = new THREE.BoxGeometry(0.42, 3.9, 0.42);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const pilaster = new THREE.Mesh(pilasterGeo, materials.limestone);
      pilaster.position.set(Math.sin(a) * 4.35, 2.68, Math.cos(a) * 4.35);
      pilaster.rotation.y = a;
      pilaster.castShadow = true;
      pilaster.receiveShadow = true;
      pavilion.add(pilaster);
    }

    this.root.add(pavilion);
    this.cameraColliders.push(plinth, drum, cornice, dome, doorwayFrame);

    // Physics collider approximation for the observatory rotunda
    physics.addStaticBox({
      size: [8.8, 9.2, 8.8],
      position: [0, 4.6, -12.6],
    });

    this.disposables.push(
      plinthGeo,
      drumGeo,
      corniceGeo,
      railGeo,
      domeGeo,
      shutterGeo,
      mainTubeGeo,
      lensHoodGeo,
      doorwayFrameGeo,
      doorPanelGeo,
      pilasterGeo,
    );
  }

  private buildWallsAndArchways(
    physics: PhysicsWorld,
    materials: ReturnType<ObservatoryEnvironment['createMaterials']>,
  ): void {
    // West Stone Archway + Wall Baffle (ideal for testing third-person camera collision avoidance!)
    // Left pillar
    this.addStaticSolidBox(
      physics,
      { size: [1.3, 4.2, 1.3], position: [-6.4, 2.1, -3.6] },
      materials.plaster,
    );
    // Right pillar
    this.addStaticSolidBox(
      physics,
      { size: [1.3, 4.2, 1.3], position: [-6.4, 2.1, 0.4] },
      materials.plaster,
    );
    // Overhead lintel beam spanning the arch
    this.addStaticSolidBox(
      physics,
      { size: [1.55, 0.9, 5.6], position: [-6.4, 4.55, -1.6] },
      materials.terracotta,
    );
    // Decorative brass finial cap on arch
    const capGeo = new THREE.BoxGeometry(1.75, 0.22, 5.85);
    const capMesh = new THREE.Mesh(capGeo, materials.limestone);
    capMesh.position.set(-6.4, 5.1, -1.6);
    capMesh.castShadow = true;
    capMesh.receiveShadow = true;
    this.root.add(capMesh);
    this.disposables.push(capGeo);

    // East Angled Windbreak Wall (tall pastel periwinkle observatory wall with stone coping)
    this.addStaticSolidBox(
      physics,
      { size: [1.1, 3.6, 5.6], position: [6.8, 1.8, 0.8], rotationY: -0.22 },
      materials.periwinkle,
    );
    this.addStaticSolidBox(
      physics,
      { size: [1.34, 0.34, 5.85], position: [6.8, 3.77, 0.8], rotationY: -0.22 },
      materials.limestone,
    );

    // South-West Low Viewing Bench / Pedestal Block (static obstacle to test step/wall collision)
    this.addStaticSolidBox(
      physics,
      { size: [3.6, 0.72, 1.15], position: [-3.5, 0.36, 7.6], rotationY: 0.14 },
      materials.limestone,
    );

    // South-East Sundial Pedestal
    this.addStaticSolidBox(
      physics,
      { size: [1.4, 1.35, 1.4], position: [5.4, 0.675, 7.4] },
      materials.plaster,
    );
    const dialPlateGeo = new THREE.CylinderGeometry(0.68, 0.72, 0.12, 24);
    const dialPlate = new THREE.Mesh(dialPlateGeo, materials.brass);
    dialPlate.position.set(5.4, 1.41, 7.4);
    dialPlate.castShadow = true;
    this.root.add(dialPlate);

    const gnomonGeo = new THREE.ConeGeometry(0.08, 0.75, 8);
    const gnomon = new THREE.Mesh(gnomonGeo, materials.brass);
    gnomon.position.set(5.4, 1.75, 7.4);
    gnomon.rotation.x = 0.42;
    gnomon.castShadow = true;
    this.root.add(gnomon);
    this.disposables.push(dialPlateGeo, gnomonGeo);
  }

  private buildPerimeterParapets(
    physics: PhysicsWorld,
    materials: ReturnType<ObservatoryEnvironment['createMaterials']>,
  ): void {
    // Low scenic stone parapet walls along the terrace edges (with open scenic vista gaps)
    const parapetSpecs: StaticBoxSpec[] = [
      // South overlooks (two wings with central vista opening)
      { size: [10.5, 1.15, 0.85], position: [-10.2, 0.575, 16.4] },
      { size: [10.5, 1.15, 0.85], position: [10.2, 0.575, 16.4] },
      // East and West overlooks
      { size: [0.85, 1.15, 12.5], position: [-16.4, 0.575, 8.2] },
      { size: [0.85, 1.15, 12.5], position: [-16.4, 0.575, -8.2] },
      { size: [0.85, 1.15, 12.5], position: [16.4, 0.575, 8.2] },
      { size: [0.85, 1.15, 12.5], position: [16.4, 0.575, -8.2] },
      // North side wings flanking the observatory dome
      { size: [8.8, 1.15, 0.85], position: [-11.8, 0.575, -16.4] },
      { size: [8.8, 1.15, 0.85], position: [11.8, 0.575, -16.4] },
    ];

    for (const spec of parapetSpecs) {
      this.addStaticSolidBox(physics, spec, materials.plaster, true);
      // Warm terracotta coping cap on top of parapet
      const capGeo = new THREE.BoxGeometry(spec.size[0] + 0.16, 0.18, spec.size[2] + 0.16);
      const cap = new THREE.Mesh(capGeo, materials.terracotta);
      cap.position.set(spec.position[0], spec.position[1] + spec.size[1] * 0.5 + 0.09, spec.position[2]);
      cap.castShadow = true;
      cap.receiveShadow = true;
      this.root.add(cap);
      this.disposables.push(capGeo);
    }

    // Corner stone lanterns/bollards
    const corners: [number, number][] = [
      [-16.4, 16.4],
      [16.4, 16.4],
      [-16.4, -16.4],
      [16.4, -16.4],
      [-4.6, 16.4],
      [4.6, 16.4],
    ];
    const postGeo = new THREE.BoxGeometry(1.15, 1.65, 1.15);
    const orbGeo = new THREE.SphereGeometry(0.32, 16, 12);
    const orbMat = new THREE.MeshStandardMaterial({
      color: 0xfff3d4,
      emissive: 0xffd78c,
      emissiveIntensity: 0.35,
      roughness: 0.3,
    });
    for (const [cx, cz] of corners) {
      const post = new THREE.Mesh(postGeo, materials.limestone);
      post.position.set(cx, 0.825, cz);
      post.castShadow = true;
      post.receiveShadow = true;
      this.root.add(post);

      const orb = new THREE.Mesh(orbGeo, orbMat);
      orb.position.set(cx, 1.92, cz);
      this.root.add(orb);
    }
    this.disposables.push(postGeo, orbGeo, orbMat);
  }

  private buildAlpineFoliageAndRocks(): void {
    // Stylized pastel alpine pines around the outer meadow terrace using InstancedMesh
    const treePositions: [number, number, number, number][] = [
      [-20.5, -0.7, -14.5, 1.15],
      [-22.2, -0.7, -7.2, 0.92],
      [-21.4, -0.7, 3.8, 1.22],
      [-19.8, -0.7, 13.6, 0.98],
      [-11.5, -0.7, 21.0, 1.1],
      [11.2, -0.7, 21.4, 1.05],
      [20.4, -0.7, 13.2, 1.2],
      [21.6, -0.7, 2.4, 0.95],
      [22.4, -0.7, -8.5, 1.18],
      [19.6, -0.7, -16.2, 0.9],
      [-12.8, -0.7, -21.2, 1.12],
      [13.4, -0.7, -20.8, 1.04],
      [-24.5, -1.2, -1.5, 1.32],
      [24.2, -1.2, -2.8, 1.26],
      [-6.5, -1.1, -23.5, 1.16],
      [6.8, -1.1, -23.2, 1.08],
      [-17.2, -1.0, 19.2, 0.88],
      [17.5, -1.0, 18.8, 0.94],
      [-23.6, -1.1, 9.2, 1.1],
      [23.8, -1.1, 8.6, 1.14],
      [-18.8, -0.9, -19.5, 1.24],
      [18.6, -0.9, -19.2, 1.15],
    ];

    const count = treePositions.length;
    const trunkGeo = new THREE.CylinderGeometry(0.24, 0.34, 1.8, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x9b7e6b, roughness: 0.9 });
    const tier1Geo = new THREE.ConeGeometry(1.75, 3.0, 9);
    const tier2Geo = new THREE.ConeGeometry(1.32, 2.5, 9);
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.84,
      flatShading: true,
    });

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const tier1 = new THREE.InstancedMesh(tier1Geo, foliageMat, count);
    const tier2 = new THREE.InstancedMesh(tier2Geo, foliageMat, count);
    trunks.castShadow = true;
    tier1.castShadow = true;
    tier1.receiveShadow = true;
    tier2.castShadow = true;
    tier2.receiveShadow = true;

    const palette = [0x74a98c, 0x82b69a, 0x6b9e84, 0x8ec0a4];
    const dummy = new THREE.Object3D();
    const tint = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const [x, y, z, scale] = treePositions[i];
      const rot = i * 1.13;

      dummy.position.set(x, y + 0.9 * scale, z);
      dummy.rotation.set(0, rot, 0);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, y + 2.75 * scale, z);
      dummy.updateMatrix();
      tier1.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, y + 4.35 * scale, z);
      dummy.rotation.set(0, rot + 0.45, 0);
      dummy.updateMatrix();
      tier2.setMatrixAt(i, dummy.matrix);

      tint.setHex(palette[i % palette.length]);
      tier1.setColorAt(i, tint);
      tier2.setColorAt(i, tint.clone().offsetHSL(0, 0, 0.04));
    }

    trunks.instanceMatrix.needsUpdate = true;
    tier1.instanceMatrix.needsUpdate = true;
    tier2.instanceMatrix.needsUpdate = true;
    if (tier1.instanceColor) tier1.instanceColor.needsUpdate = true;
    if (tier2.instanceColor) tier2.instanceColor.needsUpdate = true;
    trunks.computeBoundingSphere();
    tier1.computeBoundingSphere();
    tier2.computeBoundingSphere();

    this.root.add(trunks, tier1, tier2);

    // Stylized smooth alpine boulders scattered on outer meadow ring
    const rockGeo = new THREE.DodecahedronGeometry(0.95, 0);
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      flatShading: true,
    });
    const rockCount = 24;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    for (let i = 0; i < rockCount; i++) {
      const angle = (i / rockCount) * Math.PI * 2 + 0.2;
      const dist = 20.5 + (i % 3) * 2.2;
      const sx = 0.75 + (i % 4) * 0.25;
      const sy = 0.55 + (i % 3) * 0.22;
      const sz = 0.8 + ((i + 1) % 3) * 0.24;
      dummy.position.set(Math.cos(angle) * dist, -0.55, Math.sin(angle) * dist);
      dummy.rotation.set(i * 0.4, i * 0.8, i * 0.3);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
      tint.setHex(i % 2 === 0 ? 0xd3cec6 : 0xc2c7cf);
      rocks.setColorAt(i, tint);
    }
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    rocks.computeBoundingSphere();
    this.root.add(rocks);

    this.disposables.push(trunkGeo, trunkMat, tier1Geo, tier2Geo, foliageMat, rockGeo, rockMat);
  }

  private buildDistantMountainRing(): void {
    // Layered pastel mountain peaks surrounding Wobblepeak for rich alpine depth
    const mountainGroup = new THREE.Group();
    const peakGeo = new THREE.ConeGeometry(1, 1, 7);
    const snowCapGeo = new THREE.ConeGeometry(0.42, 0.36, 7);

    const nearPeakMat = new THREE.MeshStandardMaterial({
      color: 0xaabed6,
      roughness: 0.92,
      flatShading: true,
    });
    const farPeakMat = new THREE.MeshStandardMaterial({
      color: 0xc2cfe3,
      roughness: 0.94,
      flatShading: true,
    });
    const snowMat = new THREE.MeshStandardMaterial({
      color: 0xf7f8fb,
      roughness: 0.82,
      flatShading: true,
    });

    const totalPeaks = 18;
    for (let i = 0; i < totalPeaks; i++) {
      const angle = (i / totalPeaks) * Math.PI * 2;
      const isFar = i % 2 === 1;
      const dist = isFar ? 132 + (i % 3) * 14 : 92 + (i % 4) * 10;
      const radius = isFar ? 30 + (i % 3) * 8 : 22 + (i % 3) * 5;
      const height = isFar ? 58 + (i % 4) * 12 : 36 + (i % 3) * 9;

      const peak = new THREE.Mesh(peakGeo, isFar ? farPeakMat : nearPeakMat);
      peak.scale.set(radius, height, radius);
      peak.position.set(Math.cos(angle) * dist, -24 + height * 0.45, Math.sin(angle) * dist);
      peak.rotation.y = i * 0.7;
      mountainGroup.add(peak);

      if (height > 44) {
        const cap = new THREE.Mesh(snowCapGeo, snowMat);
        cap.scale.set(radius * 0.92, height * 0.92, radius * 0.92);
        cap.position.set(
          Math.cos(angle) * dist,
          -24 + height * 0.79,
          Math.sin(angle) * dist,
        );
        cap.rotation.y = i * 0.7;
        mountainGroup.add(cap);
      }
    }

    this.root.add(mountainGroup);
    this.disposables.push(peakGeo, snowCapGeo, nearPeakMat, farPeakMat, snowMat);
  }

  private buildDriftingClouds(): void {
    const puffGeo = new THREE.SphereGeometry(1, 14, 12);
    const cloudMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0.0,
    });
    this.disposables.push(puffGeo, cloudMat);

    for (let i = 0; i < 9; i++) {
      const group = new THREE.Group();
      const baseAngle = (i / 9) * Math.PI * 2;
      const radius = 64 + (i % 3) * 24;
      const y = 26 + (i % 4) * 6.5;

      const puffSpecs: [number, number, number, number][] = [
        [0, 0, 0, 4.2],
        [-3.4, -0.5, 0.6, 3.0],
        [3.3, -0.4, -0.5, 3.2],
        [1.1, 1.3, 0.3, 2.7],
      ];
      for (const [px, py, pz, s] of puffSpecs) {
        const puff = new THREE.Mesh(puffGeo, cloudMat);
        puff.position.set(px, py, pz);
        puff.scale.set(s * 1.3, s * 0.78, s * 0.95);
        group.add(puff);
      }

      group.position.set(Math.cos(baseAngle) * radius, y, Math.sin(baseAngle) * radius);
      group.lookAt(0, y, 0);
      this.root.add(group);
      this.clouds.push({
        group,
        baseAngle,
        radius,
        speed: 0.008 + (i % 3) * 0.004,
        y,
      });
    }
  }

  private buildDynamicBlocks(
    physics: PhysicsWorld,
    textures: ProceduralTextureSet,
    brassMaterial: THREE.MeshStandardMaterial,
    audio: ProceduralAudio,
  ): void {
    for (const spec of DYNAMIC_BLOCK_SPECS) {
      const mesh = createBeveledBlockGroup(
        spec.size,
        spec.color,
        textures.pastelWood,
        brassMaterial,
      );
      mesh.position.set(...spec.initialPosition);
      if (spec.initialRotationY) {
        mesh.rotation.y = spec.initialRotationY;
      }
      this.root.add(mesh);

      const body = physics.addDynamicBox(
        spec.size,
        spec.initialPosition,
        spec.mass,
        spec.initialRotationY ?? 0,
      );

      body.addEventListener('collide', (event: { contact?: CANNON.ContactEquation }) => {
        const impact = event.contact ? Math.abs(event.contact.getImpactVelocityAlongNormal()) : 0;
        if (impact > 1.4) {
          audio.playBlockClack(impact);
        }
      });

      this.dynamicBlocks.push({ spec, mesh, body });
    }
  }

  public syncPhysicsVisuals(elapsedSeconds: number): void {
    for (const item of this.dynamicBlocks) {
      item.mesh.position.set(item.body.position.x, item.body.position.y, item.body.position.z);
      item.mesh.quaternion.set(
        item.body.quaternion.x,
        item.body.quaternion.y,
        item.body.quaternion.z,
        item.body.quaternion.w,
      );
    }

    for (const cloud of this.clouds) {
      const angle = cloud.baseAngle + elapsedSeconds * cloud.speed;
      cloud.group.position.set(
        Math.cos(angle) * cloud.radius,
        cloud.y + Math.sin(elapsedSeconds * 0.4 + cloud.baseAngle) * 0.5,
        Math.sin(angle) * cloud.radius,
      );
      cloud.group.lookAt(0, cloud.y, 0);
    }
  }

  public resetBlocks(): void {
    for (const item of this.dynamicBlocks) {
      const [x, y, z] = item.spec.initialPosition;
      item.body.position.set(x, y, z);
      item.body.velocity.set(0, 0, 0);
      item.body.angularVelocity.set(0, 0, 0);
      item.body.quaternion.setFromEuler(0, item.spec.initialRotationY ?? 0, 0);
      item.body.wakeUp();
    }
  }

  public dispose(): void {
    for (const item of this.dynamicBlocks) {
      item.mesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
