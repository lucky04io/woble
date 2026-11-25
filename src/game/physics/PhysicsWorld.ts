import * as CANNON from 'cannon-es';
import type { StaticBoxSpec } from '../types';

export const PHYSICS_FIXED_TIME_STEP = 1 / 60;
const MAX_SUB_STEPS = 4;

export class PhysicsWorld {
  public readonly world: CANNON.World;
  public readonly stoneMaterial: CANNON.Material;
  public readonly playerMaterial: CANNON.Material;
  public readonly blockMaterial: CANNON.Material;

  private accumulator = 0;

  constructor() {
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.81, 0),
    });

    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = false;

    const solver = this.world.solver as CANNON.GSSolver;
    solver.iterations = 10;
    solver.tolerance = 0.001;

    this.stoneMaterial = new CANNON.Material('stone');
    this.playerMaterial = new CANNON.Material('player');
    this.blockMaterial = new CANNON.Material('block');

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.playerMaterial, this.stoneMaterial, {
        // Zero passive contact friction avoids Cannon-es wall sticking and foot-snag torque;
        // PlayerCharacter applies active grounded traction and braking forces.
        friction: 0,
        restitution: 0.04,
        contactEquationStiffness: 1e7,
        contactEquationRelaxation: 3,
      }),
    );

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.blockMaterial, this.stoneMaterial, {
        friction: 0.5,
        restitution: 0.24,
        contactEquationStiffness: 1e7,
        contactEquationRelaxation: 3,
      }),
    );

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.playerMaterial, this.blockMaterial, {
        friction: 0.42,
        restitution: 0.22,
      }),
    );

    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.blockMaterial, this.blockMaterial, {
        friction: 0.48,
        restitution: 0.22,
      }),
    );
  }

  public addStaticBox(spec: StaticBoxSpec): CANNON.Body {
    const [w, h, d] = spec.size;
    const [x, y, z] = spec.position;
    const body = new CANNON.Body({
      type: CANNON.Body.STATIC,
      material: this.stoneMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(w * 0.5, h * 0.5, d * 0.5)),
      position: new CANNON.Vec3(x, y, z),
    });
    if (spec.rotationY) {
      body.quaternion.setFromEuler(0, spec.rotationY, 0);
    }
    this.world.addBody(body);
    return body;
  }

  public addDynamicBox(
    size: [number, number, number],
    position: [number, number, number],
    mass: number,
    rotationY = 0,
  ): CANNON.Body {
    const [w, h, d] = size;
    const [x, y, z] = position;
    const body = new CANNON.Body({
      mass,
      material: this.blockMaterial,
      shape: new CANNON.Box(new CANNON.Vec3(w * 0.5, h * 0.5, d * 0.5)),
      position: new CANNON.Vec3(x, y, z),
      linearDamping: 0.14,
      angularDamping: 0.24,
    });
    if (rotationY) {
      body.quaternion.setFromEuler(0, rotationY, 0);
    }
    this.world.addBody(body);
    return body;
  }

  public step(deltaSeconds: number, onSubStep?: (dt: number) => void): void {
    const clampedDelta = Math.min(deltaSeconds, 0.1);
    this.accumulator += clampedDelta;

    let steps = 0;
    while (this.accumulator >= PHYSICS_FIXED_TIME_STEP && steps < MAX_SUB_STEPS) {
      if (onSubStep) {
        onSubStep(PHYSICS_FIXED_TIME_STEP);
      }
      this.world.step(PHYSICS_FIXED_TIME_STEP);
      this.accumulator -= PHYSICS_FIXED_TIME_STEP;
      steps++;
    }

    if (steps === MAX_SUB_STEPS) {
      this.accumulator = 0;
    }
  }
}
