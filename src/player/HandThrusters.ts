import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Locomotion } from './Locomotion.ts';
import type { PlayerRig } from './PlayerRig.ts';
import type { Handedness, VRHands } from './VRHands.ts';

const MOTOR_URL = './assets/player/motors/handheld_underwater_thruster.glb';
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const WORLD_UP = new Vector3(0, 1, 0);
const PICKUP_RADIUS = 0.38;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const GRAB_THRESHOLD = 0.55;

const _worldQuat = new Quaternion();
const _direction = new Vector3();
const _combined = new Vector3();
const _gripLocal = new Matrix4();
const _handPosition = new Vector3();
const _headPosition = new Vector3();
const _headQuaternion = new Quaternion();
const _spawnForward = new Vector3();
const _spawnRight = new Vector3();
const _motorPosition = new Vector3();

interface MotorPickup {
  root: Group;
  heldBy: Handedness | null;
}

/**
 * Two physical handheld propulsion motors.
 *
 * The motors begin as ordinary world-space props in front of the player. Squeezing
 * the grip while a tracked hand is close to a free motor snaps that motor into the
 * hand; releasing grip drops it back into the world. The trigger only produces
 * thrust for a motor that is actually being held by that same hand.
 */
export class HandThrusters {
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private readonly motors: MotorPickup[] = [];
  private readonly previousSqueeze: Record<Handedness, number> = { left: 0, right: 0 };
  private disposed = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly locomotion: Locomotion,
    private readonly scene: Scene,
    private readonly rig: PlayerRig,
  ) {
    this.ready = this.loadVisual();
  }

  private async loadVisual(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(MOTOR_URL);
      if (this.disposed) return;

      this.template = gltf.scene;
      this.template.visible = true;
      this.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.visible = true;
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;

        if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();

        const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const materials = sourceMaterials.map((material) => {
          const clone = material.clone();
          clone.side = DoubleSide;
          if (clone instanceof MeshStandardMaterial) {
            // Tiny self-illumination keeps the small pickup readable in blue-green fog
            // without turning it into a glowing sci-fi torch.
            clone.emissive.set(0x07181b);
            clone.emissiveIntensity = 0.45;
          }
          clone.needsUpdate = true;
          return clone;
        });
        object.material = Array.isArray(object.material) ? materials : materials[0];
      });

      if (!this.template.getObjectByName('GripPoint')) {
        console.warn('[thrusters] motor has no GripPoint helper; pickup will use scene origin');
      }
    } catch (error) {
      console.warn(`[thrusters] motor visual failed to load at ${MOTOR_URL}`, error);
    }
  }

  /**
   * Places two obvious physical motors roughly one metre in front of the current
   * player head. Called after Game.start(), once the authoritative spawn is known.
   */
  spawnNearPlayer(): void {
    if (!this.template || this.disposed) return;

    for (const motor of this.motors) motor.root.removeFromParent();
    this.motors.length = 0;

    this.rig.getHeadPosition(_headPosition);
    this.rig.getHeadQuaternion(_headQuaternion);

    _spawnForward.copy(LOCAL_FORWARD).applyQuaternion(_headQuaternion);
    _spawnForward.y = 0;
    if (_spawnForward.lengthSq() < 1e-6) _spawnForward.set(0, 0, -1);
    _spawnForward.normalize();

    _spawnRight.set(1, 0, 0).applyQuaternion(_headQuaternion);
    _spawnRight.y = 0;
    if (_spawnRight.lengthSq() < 1e-6) _spawnRight.set(1, 0, 0);
    _spawnRight.normalize();

    this.spawnOne(-0.42, 'left');
    this.spawnOne(0.42, 'right');
  }

  private spawnOne(sideOffset: number, label: string): void {
    if (!this.template) return;

    const root = this.createPickupRoot();
    root.name = `world-hand-motor-${label}`;

    _motorPosition
      .copy(_headPosition)
      .addScaledVector(_spawnForward, 1.05)
      .addScaledVector(_spawnRight, sideOffset)
      .addScaledVector(WORLD_UP, -0.28);

    root.position.copy(_motorPosition);
    root.quaternion.setFromUnitVectors(LOCAL_FORWARD, _spawnForward);
    root.scale.set(1, 1, 1);
    this.scene.add(root);

    this.motors.push({ root, heldBy: null });
  }

  /** Builds a root whose local origin is exactly the GLB's GripPoint helper. */
  private createPickupRoot(): Group {
    const anchor = new Group();
    const visual = this.template!.clone(true);
    visual.name = 'hand-motor-visual';

    const gripPoint = visual.getObjectByName('GripPoint');
    if (gripPoint) {
      visual.updateMatrixWorld(true);
      gripPoint.updateWorldMatrix(true, false);
      _gripLocal.copy(visual.matrixWorld).invert().multiply(gripPoint.matrixWorld).invert();
      _gripLocal.decompose(visual.position, visual.quaternion, visual.scale);
    }

    anchor.add(visual);
    return anchor;
  }

  update(): void {
    if (this.disposed || !this.renderer.xr.isPresenting) {
      this.locomotion.clearPropulsionInput();
      return;
    }

    const session = this.renderer.xr.getSession();
    if (!session) {
      this.locomotion.clearPropulsionInput();
      return;
    }

    _combined.set(0, 0, 0);
    const seen = new Set<Handedness>();

    for (const source of session.inputSources) {
      if (source.handedness !== 'left' && source.handedness !== 'right') continue;
      const handedness = source.handedness;
      seen.add(handedness);

      const squeeze = source.gamepad?.buttons[1]?.value ?? 0;
      const wasSqueezed = this.previousSqueeze[handedness] >= GRAB_THRESHOLD;
      const isSqueezed = squeeze >= GRAB_THRESHOLD;

      if (isSqueezed && !wasSqueezed) this.tryGrab(handedness);
      if (!isSqueezed && wasSqueezed) this.release(handedness);
      this.previousSqueeze[handedness] = squeeze;

      const held = this.motorHeldBy(handedness);
      const trigger = source.gamepad?.buttons[0]?.value ?? 0;
      if (!held || trigger <= 0.03) continue;

      held.root.updateWorldMatrix(true, false);
      held.root.getWorldQuaternion(_worldQuat);
      _direction.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
      _combined.addScaledVector(_direction, trigger);
    }

    // A controller disappearing while holding a motor should drop it instead of
    // leaving a prop permanently parented to a dead XR grip.
    for (const handedness of ['left', 'right'] as const) {
      if (seen.has(handedness)) continue;
      if (this.motorHeldBy(handedness)) this.release(handedness);
      this.previousSqueeze[handedness] = 0;
    }

    this.locomotion.setPropulsionInput(_combined);
  }

  private tryGrab(handedness: Handedness): void {
    if (this.motorHeldBy(handedness)) return;
    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return;

    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(_handPosition);

    let nearest: MotorPickup | null = null;
    let nearestSq = PICKUP_RADIUS_SQ;
    for (const motor of this.motors) {
      if (motor.heldBy) continue;
      motor.root.updateWorldMatrix(true, false);
      motor.root.getWorldPosition(_motorPosition);
      const distanceSq = _motorPosition.distanceToSquared(_handPosition);
      if (distanceSq >= nearestSq) continue;
      nearest = motor;
      nearestSq = distanceSq;
    }

    if (!nearest) return;

    grip.add(nearest.root);
    nearest.root.position.set(0, 0, 0);
    nearest.root.quaternion.identity();
    nearest.root.scale.set(1, 1, 1);
    nearest.heldBy = handedness;
  }

  private release(handedness: Handedness): void {
    const motor = this.motorHeldBy(handedness);
    if (!motor) return;
    this.scene.attach(motor.root);
    motor.heldBy = null;
  }

  private motorHeldBy(handedness: Handedness): MotorPickup | null {
    return this.motors.find((motor) => motor.heldBy === handedness) ?? null;
  }

  dispose(): void {
    this.disposed = true;
    this.locomotion.clearPropulsionInput();

    for (const motor of this.motors) motor.root.removeFromParent();
    this.motors.length = 0;

    this.template?.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      if (Array.isArray(object.material)) {
        for (const material of object.material) material.dispose();
      } else {
        object.material.dispose();
      }
    });
    this.template = null;
  }
}
