import {
  BoxGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Locomotion } from './Locomotion.ts';
import type { Handedness, VRHands } from './VRHands.ts';

/**
 * Reusable handheld motor uploaded for both tracked hands.
 * Local -Z is forward/travel direction and local +Z is exhaust.
 */
const MOTOR_URL = './assets/player/motors/handheld_underwater_thruster.glb';
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const _worldQuat = new Quaternion();
const _direction = new Vector3();
const _combined = new Vector3();
const _gripLocal = new Matrix4();

interface MotorVisual {
  root: Object3D;
  grip: Group;
  debug: Mesh;
}

/**
 * Two independent tracked-hand underwater motors.
 *
 * For this integration pass the visuals deliberately attach directly to the raw
 * WebXR controller grips rather than the animated hand-bone socket. That removes
 * an entire transform chain while we verify placement and propulsion direction.
 * A bright wireframe debug body is kept around each motor temporarily so a missing
 * or badly shaded GLB can never masquerade as an attachment/tracking failure.
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
      this.template.visible = true;
      this.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.visible = true;
        object.castShadow = false;
        object.receiveShadow = false;
        object.frustumCulled = false;

        // The uploaded GLB does not carry vertex normals. Generate them once so
        // its default/PBR material cannot disappear into nearly black underwater lighting.
        if (!object.geometry.getAttribute('normal')) object.geometry.computeVertexNormals();

        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          material.side = DoubleSide;
          material.needsUpdate = true;
        }
      });

      if (!this.template.getObjectByName('GripPoint')) {
        console.warn('[thrusters] motor has no GripPoint helper; falling back to its scene origin');
      }
    } catch (error) {
      // Propulsion and the bright debug anchors still work even if the GLB itself fails.
      console.warn(`[thrusters] motor visual failed to load at ${MOTOR_URL}`, error);
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
    // Use the mounted motor when available; otherwise use the raw XR grip. Both are
    // direct children of the tracked grip now, so hand animation cannot alter thrust.
    const visual = this.visuals[handedness];
    const source = visual?.root ?? this.hands.getControllerGrip(handedness);
    if (!source) return false;

    source.updateWorldMatrix(true, false);
    source.getWorldQuaternion(_worldQuat);
    target.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
    return true;
  }

  private syncVisual(handedness: Handedness): void {
    const grip = this.hands.getControllerGrip(handedness);
    const current = this.visuals[handedness];

    if (!grip) {
      if (current) this.removeVisual(current);
      this.visuals[handedness] = null;
      return;
    }

    if (current?.grip === grip) return;
    if (current) this.removeVisual(current);

    // Loud temporary diagnostic: if WebXR has supplied a tracked grip, this marker
    // must be visible even when the uploaded GLB is missing, black, tiny or malformed.
    const debug = new Mesh(
      new BoxGeometry(0.14, 0.12, 0.34),
      new MeshBasicMaterial({
        color: handedness === 'left' ? 0xff6a00 : 0xff00cc,
        wireframe: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    debug.name = `${handedness}-thruster-debug`;
    debug.position.set(0, 0, -0.02);
    debug.renderOrder = 10000;
    debug.frustumCulled = false;
    grip.add(debug);

    // Keep a real Object3D even when the GLB failed, so propulsion orientation and
    // visual diagnosis still share the exact same tracked transform.
    const root = this.template ? this.template.clone(true) : new Group();
    root.name = `${handedness}-hand-motor`;
    root.visible = true;

    if (this.template) {
      // GripPoint in the uploaded model is offset from the scene origin. Invert its
      // local transform so that helper lands exactly at the controller grip origin.
      const gripPoint = root.getObjectByName('GripPoint');
      if (gripPoint) {
        root.updateMatrixWorld(true);
        gripPoint.updateWorldMatrix(true, false);
        _gripLocal.copy(root.matrixWorld).invert().multiply(gripPoint.matrixWorld).invert();
        _gripLocal.decompose(root.position, root.quaternion, root.scale);
      } else {
        root.position.set(0, 0, 0);
        root.quaternion.identity();
        root.scale.set(1, 1, 1);
      }
    }

    grip.add(root);
    this.visuals[handedness] = { root, grip, debug };
  }

  private removeVisual(visual: MotorVisual): void {
    visual.root.removeFromParent();
    visual.debug.removeFromParent();
    visual.debug.geometry.dispose();
    if (Array.isArray(visual.debug.material)) {
      for (const material of visual.debug.material) material.dispose();
    } else {
      visual.debug.material.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.locomotion.clearPropulsionInput();

    for (const handedness of ['left', 'right'] as const) {
      const visual = this.visuals[handedness];
      if (visual) this.removeVisual(visual);
      this.visuals[handedness] = null;
    }

    // Both visible copies share resources with this source scene, so dispose once.
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
