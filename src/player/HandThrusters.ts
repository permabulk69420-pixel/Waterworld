import {
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
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
const PICKUP_RADIUS = 0.45;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const GRAB_THRESHOLD = 0.55;
const XR_SPAWN_DELAY_FRAMES = 4;

// Do not use a prop speed that phase-locks to common Quest refresh rates. The old
// 18 rev/s advances almost exactly 90 degrees per frame at 72 Hz; a symmetric
// propeller therefore looks frozen except during throttle transitions. 7.3 rev/s
// gives a clearly moving blade pattern at 72/80/90/120 Hz while still reading fast.
const PROPELLER_MAX_RAD_PER_SECOND = Math.PI * 2 * 7.3;
const PROPELLER_RESPONSE = 18;

// GripPoint in the motor GLB is the point that belongs in the palm. The Quest raw
// controller grip is closer to the wrist, so held motors parent to VRHands.objectGrip,
// which is continuously synced to the rigged b_l_grip / b_r_grip hand bones.
// The asset body currently falls on the anatomical inside of the forearm at its
// authored roll; rolling 180 degrees about local Z keeps local -Z thrust unchanged
// while moving the motor body to the outside of the arm.
const HELD_MOTOR_ROLL = Math.PI;

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
  propeller: Object3D | null;
  throttle: number;
  propellerSpeed: number;
}

/**
 * Two physical handheld propulsion motors.
 *
 * Motors spawn as world props. Squeeze near one to grab it at the visible hand's
 * actual palm/grip bone, release to drop it, and use that hand's trigger to spin
 * the propeller and apply thrust along the held motor's orientation.
 */
export class HandThrusters {
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private readonly motors: MotorPickup[] = [];
  private readonly previousSqueeze: Record<Handedness, number> = { left: 0, right: 0 };
  private disposed = false;
  private wasPresenting = false;
  private spawnDelayFrames = XR_SPAWN_DELAY_FRAMES;
  private spawnedForSession = false;

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

      // Keep the confirmed-visible unlit look for now. It is cheap on Quest and
      // preserves the GLB's authored vertex colours through underwater fog/lighting.
      this.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.visible = true;
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;
        if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();

        const oldMaterials = Array.isArray(object.material) ? object.material : [object.material];
        const useVertexColors = object.geometry.getAttribute('color') !== undefined;
        const replacements = oldMaterials.map(
          () =>
            new MeshBasicMaterial({
              vertexColors: useVertexColors,
              side: DoubleSide,
            }),
        );
        object.material = Array.isArray(object.material) ? replacements : replacements[0]!;
      });

      if (!this.template.getObjectByName('GripPoint')) {
        console.warn('[thrusters] motor has no GripPoint helper; pickup will use scene origin');
      }
      if (!this.template.getObjectByName('Propeller')) {
        console.warn('[thrusters] motor has no Propeller node; thrust will work without visual spin');
      }
    } catch (error) {
      console.warn(`[thrusters] motor visual failed to load at ${MOTOR_URL}`, error);
    }
  }

  /** Called from the game's authoritative frame loop. */
  update(dt = 0): void {
    if (this.disposed) return;

    const presenting = this.renderer.xr.isPresenting;
    if (!presenting) {
      if (this.wasPresenting) this.endSession();
      this.wasPresenting = false;
      this.locomotion.clearPropulsionInput();
      return;
    }

    if (!this.wasPresenting) {
      this.wasPresenting = true;
      this.spawnDelayFrames = XR_SPAWN_DELAY_FRAMES;
      this.spawnedForSession = false;
      this.clearMotors();
    }

    // Give Three/WebXR a few authoritative XR frames to populate camera.matrixWorld,
    // then place the pickups from the actual tracked HMD pose.
    if (!this.spawnedForSession) {
      if (this.spawnDelayFrames > 0) {
        this.spawnDelayFrames--;
      } else {
        this.spawnNearTrackedHead();
        this.spawnedForSession = true;
      }
    }

    const session = this.renderer.xr.getSession();
    if (!session) {
      this.locomotion.clearPropulsionInput();
      return;
    }

    for (const motor of this.motors) motor.throttle = 0;

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
      if (!held) continue;

      held.throttle = trigger;
      if (trigger <= 0.03) continue;

      // The motor root includes the final held mount transform, so using its world
      // quaternion keeps thrust exactly aligned with the model after the outside-arm roll.
      held.root.updateWorldMatrix(true, false);
      held.root.getWorldQuaternion(_worldQuat);
      _direction.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
      _combined.addScaledVector(_direction, trigger);
    }

    for (const handedness of ['left', 'right'] as const) {
      if (seen.has(handedness)) continue;
      if (this.motorHeldBy(handedness)) this.release(handedness);
      this.previousSqueeze[handedness] = 0;
    }

    this.animatePropellers(dt);
    this.locomotion.setPropulsionInput(_combined);
  }

  private animatePropellers(dt: number): void {
    if (dt <= 0) return;
    const blend = 1 - Math.exp(-PROPELLER_RESPONSE * dt);

    for (const motor of this.motors) {
      const targetSpeed = motor.throttle * PROPELLER_MAX_RAD_PER_SECOND;
      motor.propellerSpeed += (targetSpeed - motor.propellerSpeed) * blend;
      if (Math.abs(motor.propellerSpeed) < 0.01) motor.propellerSpeed = 0;

      // Accumulate rotation every XR frame. The deliberately non-refresh-locked
      // speed avoids the 90-degree-per-frame strobe that made full throttle appear stuck.
      if (motor.propeller) {
        motor.propeller.rotation.z =
          (motor.propeller.rotation.z + motor.propellerSpeed * dt) % (Math.PI * 2);
      }
    }
  }

  private spawnNearTrackedHead(): void {
    this.clearMotors();

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

    this.spawnOne(-0.36, 'left');
    this.spawnOne(0.36, 'right');
  }

  private spawnOne(sideOffset: number, label: string): void {
    if (!this.template) return;

    const root = this.createPickupRoot();
    root.name = `world-hand-motor-${label}`;

    _motorPosition
      .copy(_headPosition)
      .addScaledVector(_spawnForward, 0.9)
      .addScaledVector(_spawnRight, sideOffset)
      .addScaledVector(WORLD_UP, -0.22);

    root.position.copy(_motorPosition);
    root.quaternion.setFromUnitVectors(LOCAL_FORWARD, _spawnForward);
    root.scale.set(1, 1, 1);
    this.scene.add(root);

    this.motors.push({
      root,
      heldBy: null,
      propeller: root.getObjectByName('Propeller'),
      throttle: 0,
      propellerSpeed: 0,
    });
  }

  /** Builds a pickup root whose local origin is the GLB's GripPoint helper. */
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

  private tryGrab(handedness: Handedness): void {
    if (this.motorHeldBy(handedness)) return;

    // This is the actual rigged palm grip (b_l_grip / b_r_grip), not the raw Quest
    // controller wrist transform. It is synchronized by VRHands every frame.
    const palmGrip = this.hands.getObjectGrip(handedness);
    if (!palmGrip) return;

    palmGrip.updateWorldMatrix(true, false);
    palmGrip.getWorldPosition(_handPosition);

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

    // GripPoint is already the pickup root origin. Parenting to the hand's true grip
    // socket and zeroing position therefore puts the handle in the palm instead of at
    // the wrist. Roll around local Z only; this flips the body outward while keeping
    // the -Z thrust axis exactly unchanged.
    palmGrip.add(nearest.root);
    nearest.root.position.set(0, 0, 0);
    nearest.root.rotation.set(0, 0, HELD_MOTOR_ROLL);
    nearest.root.scale.set(1, 1, 1);
    nearest.heldBy = handedness;
  }

  private release(handedness: Handedness): void {
    const motor = this.motorHeldBy(handedness);
    if (!motor) return;
    this.scene.attach(motor.root);
    motor.heldBy = null;
    motor.throttle = 0;
  }

  private motorHeldBy(handedness: Handedness): MotorPickup | null {
    return this.motors.find((motor) => motor.heldBy === handedness) ?? null;
  }

  private endSession(): void {
    this.locomotion.clearPropulsionInput();
    for (const handedness of ['left', 'right'] as const) {
      if (this.motorHeldBy(handedness)) this.release(handedness);
      this.previousSqueeze[handedness] = 0;
    }
    this.clearMotors();
    this.spawnedForSession = false;
    this.spawnDelayFrames = XR_SPAWN_DELAY_FRAMES;
  }

  private clearMotors(): void {
    for (const motor of this.motors) motor.root.removeFromParent();
    this.motors.length = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.locomotion.clearPropulsionInput();
    this.clearMotors();

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
