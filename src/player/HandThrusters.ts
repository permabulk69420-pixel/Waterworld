import {
  BoxGeometry,
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
  proxy: Mesh;
}

/**
 * Two physical handheld propulsion motors.
 *
 * The motors are spawned only after WebXR is actually presenting so their initial
 * position comes from the tracked headset, not the desktop fallback camera. Squeeze
 * grip near a motor to pick it up, release grip to drop it, and use that hand's
 * trigger to apply thrust along the held motor's real orientation.
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

      // The uploaded GLB is tiny and already carries vertex colours. For this first
      // gameplay pass use unlit materials so underwater lighting can never make it
      // appear black/invisible. We can restore PBR once placement is confirmed.
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
    } catch (error) {
      // A visible proxy motor is still spawned even if the GLB fails. That keeps the
      // pickup/gameplay path testable and makes asset-loading failures unambiguous.
      console.warn(`[thrusters] motor visual failed to load at ${MOTOR_URL}`, error);
    }
  }

  /** Called from the game's authoritative frame loop. */
  update(): void {
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

    for (const handedness of ['left', 'right'] as const) {
      if (seen.has(handedness)) continue;
      if (this.motorHeldBy(handedness)) this.release(handedness);
      this.previousSqueeze[handedness] = 0;
    }

    this.locomotion.setPropulsionInput(_combined);
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

    this.spawnOne(-0.36, 'left', 0x00e5ff);
    this.spawnOne(0.36, 'right', 0xffe600);
  }

  private spawnOne(sideOffset: number, label: string, proxyColor: number): void {
    const root = this.createPickupRoot(proxyColor);
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

    const proxy = root.getObjectByName('motor-visible-proxy') as Mesh;
    this.motors.push({ root, heldBy: null, proxy });
  }

  /** Builds a pickup root whose local origin is the GLB's GripPoint helper. */
  private createPickupRoot(proxyColor: number): Group {
    const anchor = new Group();

    if (this.template) {
      const visual = this.template.clone(true);
      visual.name = 'hand-motor-visual';

      const gripPoint = visual.getObjectByName('GripPoint');
      if (gripPoint) {
        visual.updateMatrixWorld(true);
        gripPoint.updateWorldMatrix(true, false);
        _gripLocal.copy(visual.matrixWorld).invert().multiply(gripPoint.matrixWorld).invert();
        _gripLocal.decompose(visual.position, visual.quaternion, visual.scale);
      }
      anchor.add(visual);
    }

    // Loud fallback/locator that is independent of GLB loading and scene lighting.
    // Leave it on for this test; once the user confirms the motors are visible we
    // can remove it in one line.
    const proxy = new Mesh(
      new BoxGeometry(0.22, 0.16, 0.38),
      new MeshBasicMaterial({ color: proxyColor, wireframe: true, depthTest: false }),
    );
    proxy.name = 'motor-visible-proxy';
    proxy.renderOrder = 10000;
    proxy.frustumCulled = false;
    anchor.add(proxy);

    return anchor;
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
    for (const motor of this.motors) {
      motor.root.removeFromParent();
      motor.proxy.geometry.dispose();
      if (Array.isArray(motor.proxy.material)) {
        for (const material of motor.proxy.material) material.dispose();
      } else {
        motor.proxy.material.dispose();
      }
    }
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
