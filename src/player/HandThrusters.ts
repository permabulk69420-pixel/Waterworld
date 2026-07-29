import {
  Group,
  Quaternion,
  Vector3,
  type Mesh,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Locomotion } from './Locomotion.ts';
import type { Handedness, VRHands } from './VRHands.ts';

/**
 * Drop the reusable motor GLB here once it is ready. Its origin should be the
 * hand grip, local -Z should be forward/travel direction, and local +Z exhaust.
 */
const MOTOR_URL = './assets/player/motors/hand_motor.glb';
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const _worldQuat = new Quaternion();
const _direction = new Vector3();
const _combined = new Vector3();

interface MotorVisual {
  root: Object3D;
  grip: Group;
}

/**
 * Two independent tracked-hand underwater motors.
 *
 * Each trigger contributes a force vector along that motor's actual tracked
 * orientation. The two vectors are summed without normalization, so aligned hands
 * genuinely accelerate harder while opposed hands cancel. Locomotion integrates
 * the result as acceleration and handles drag, collision and the surface cap.
 */
export class HandThrusters {
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private readonly visuals: Record<Handedness, MotorVisual | null> = {
    left: null,
    right: null,
  };
  private disposed = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly locomotion: Locomotion,
  ) {
    this.ready = this.loadVisual();
  }

  private async loadVisual(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(MOTOR_URL);
      if (this.disposed) return;

      this.template = gltf.scene;
      this.template.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
    } catch (error) {
      // Propulsion intentionally still works from the tracked hand orientation if
      // the GLB has not been dropped in yet. A reload after upload attaches visuals.
      console.warn(`[thrusters] optional motor visual not found at ${MOTOR_URL}`, error);
    }
  }

  update(): void {
    if (this.disposed || !this.renderer.xr.isPresenting) {
      this.locomotion.clearPropulsionInput();
      return;
    }

    this.syncVisual('left');
    this.syncVisual('right');

    _combined.set(0, 0, 0);
    const session = this.renderer.xr.getSession();
    if (!session) {
      this.locomotion.clearPropulsionInput();
      return;
    }

    for (const source of session.inputSources) {
      if (source.handedness !== 'left' && source.handedness !== 'right') continue;
      const trigger = source.gamepad?.buttons[0]?.value ?? 0;
      if (trigger <= 0.03) continue;

      if (!this.getForward(source.handedness, _direction)) continue;
      _combined.addScaledVector(_direction, trigger);
    }

    this.locomotion.setPropulsionInput(_combined);
  }

  private getForward(handedness: Handedness, target: Vector3): boolean {
    // Once the visual exists, derive thrust from the actual motor orientation so
    // any later attachment rotation automatically changes the physics too.
    const visual = this.visuals[handedness];
    const source = visual?.root ?? this.hands.getObjectGrip(handedness);
    if (!source) return false;

    source.updateWorldMatrix(true, false);
    source.getWorldQuaternion(_worldQuat);
    target.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
    return true;
  }

  private syncVisual(handedness: Handedness): void {
    const grip = this.hands.getObjectGrip(handedness);
    const current = this.visuals[handedness];

    if (!grip) {
      if (current) current.root.removeFromParent();
      this.visuals[handedness] = null;
      return;
    }

    if (current?.grip === grip) return;
    if (current) current.root.removeFromParent();
    if (!this.template) {
      this.visuals[handedness] = null;
      return;
    }

    // The requested GLB convention places its origin directly at GripPoint, so no
    // magic offsets are baked into code. If the first visual test needs a tiny
    // adjustment we can tune one attachment transform here without changing physics.
    const root = this.template.clone(true);
    root.name = `${handedness}-hand-motor`;
    root.position.set(0, 0, 0);
    root.quaternion.identity();
    root.scale.set(1, 1, 1);
    grip.add(root);
    this.visuals[handedness] = { root, grip };
  }

  dispose(): void {
    this.disposed = true;
    this.locomotion.clearPropulsionInput();

    for (const handedness of ['left', 'right'] as const) {
      this.visuals[handedness]?.root.removeFromParent();
      this.visuals[handedness] = null;
    }

    // Both visible copies share resources with this source scene, so dispose once.
    this.template?.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) material.dispose();
      } else {
        mesh.material.dispose();
      }
    });
    this.template = null;
  }
}