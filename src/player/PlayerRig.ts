import { Group, PerspectiveCamera, Quaternion, Vector3, type WebGLRenderer } from 'three';

const _q = new Quaternion();
const _v = new Vector3();
const _offset = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * The player rig.
 *
 * `group` is the thing locomotion moves; the camera lives inside it. In an XR
 * session three.js writes the tracked headset transform into the user camera's
 * matrixWorld. Do not use Object3D.getWorldPosition/getWorldQuaternion while XR
 * is presenting: those helpers may recompute the camera matrix from the normal
 * scene graph and lose the tracked XR pose. Read matrixWorld directly instead.
 */
export class PlayerRig {
  readonly group = new Group();
  readonly camera: PerspectiveCamera;

  constructor(
    camera: PerspectiveCamera,
    private readonly renderer: WebGLRenderer,
  ) {
    this.camera = camera;
    this.group.name = 'player';
    this.group.add(camera);
  }

  /**
   * World-space position of the player's eyes.
   *
   * While presenting, WebXRManager has already composed the tracked HMD pose
   * with the application's camera/rig transform into camera.matrixWorld. Reading
   * the matrix directly is important: getWorldPosition() can recalculate it from
   * the ordinary Object3D hierarchy and effectively turn a local XR pose into a
   * bogus world-space pivot.
   */
  getHeadPosition(target: Vector3): Vector3 {
    if (!this.renderer.xr.isPresenting) this.camera.updateWorldMatrix(true, false);
    return target.setFromMatrixPosition(this.camera.matrixWorld);
  }

  /** World-space orientation of the player's head. */
  getHeadQuaternion(target: Quaternion): Quaternion {
    if (!this.renderer.xr.isPresenting) this.camera.updateWorldMatrix(true, false);
    return target.setFromRotationMatrix(this.camera.matrixWorld);
  }

  /** Unit vector the player is looking along. */
  getHeadForward(target: Vector3): Vector3 {
    this.getHeadQuaternion(_q);
    return target.set(0, 0, -1).applyQuaternion(_q);
  }

  /**
   * Head-right, kept horizontal so strafing stays predictable when the player
   * looks straight up or down. Falls back to the head's own right vector at
   * the poles where the horizontal projection is undefined.
   */
  getHeadRight(target: Vector3): Vector3 {
    this.getHeadForward(_v);
    target.crossVectors(_v, WORLD_UP);
    if (target.lengthSq() < 1e-6) {
      this.getHeadQuaternion(_q);
      target.set(1, 0, 0).applyQuaternion(_q);
      target.y = 0;
    }
    return target.normalize();
  }

  /** Moves the whole rig by a world-space delta. */
  translate(delta: Vector3): void {
    this.group.position.add(delta);
    this.group.updateMatrixWorld(true);
  }

  /** Teleports the rig so the player's eyes end up at `worldPosition`. */
  setHeadPosition(worldPosition: Vector3): void {
    this.getHeadPosition(_v);
    _offset.subVectors(worldPosition, _v);
    this.translate(_offset);
  }

  /**
   * Yaws the rig about the vertical axis running through the player's current
   * head position. Using the real tracked matrixWorld position keeps smooth
   * turning in-place instead of orbiting the rig around the XR reference origin.
   */
  rotateAroundHead(angleRadians: number): void {
    if (angleRadians === 0) return;

    this.getHeadPosition(_v);
    _q.setFromAxisAngle(WORLD_UP, angleRadians);

    // Orbit the rig origin about the *actual world-space HMD position*, then
    // apply the same yaw to the rig. This keeps the eyes fixed while turning.
    _offset.subVectors(this.group.position, _v).applyQuaternion(_q);
    this.group.position.copy(_v).add(_offset);
    this.group.quaternion.premultiply(_q);
    this.group.updateMatrixWorld(true);
  }

  get position(): Vector3 {
    return this.group.position;
  }
}
