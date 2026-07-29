import { Camera, Group, PerspectiveCamera, Quaternion, Vector3, type WebGLRenderer } from 'three';

const _q = new Quaternion();
const _v = new Vector3();
const _offset = new Vector3();
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * The player rig.
 *
 * `group` is the thing locomotion moves; the camera lives inside it. In an XR
 * session three.js overwrites the camera's transform with the headset pose
 * every frame, so the rig never touches the camera's local transform - and the
 * player's view orientation is never forced, which is both a comfort
 * requirement and a WebXR one.
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

  /** The camera three is actually rendering with (an ArrayCamera in XR). */
  private activeCamera(): Camera {
    return this.renderer.xr.isPresenting ? this.renderer.xr.getCamera() : this.camera;
  }

  /** World-space position of the player's eyes. */
  getHeadPosition(target: Vector3): Vector3 {
    return this.activeCamera().getWorldPosition(target);
  }

  /** World-space orientation of the player's head. */
  getHeadQuaternion(target: Quaternion): Quaternion {
    return this.activeCamera().getWorldQuaternion(target);
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
   * Yaws the rig about the vertical axis running through the player's *current
   * head position*. Rotating about the rig origin instead would swing the
   * player through an arc whenever they are standing away from rig centre,
   * which is a classic source of VR nausea.
   */
  rotateAroundHead(angleRadians: number): void {
    if (angleRadians === 0) return;

    this.getHeadPosition(_v);
    _q.setFromAxisAngle(WORLD_UP, angleRadians);

    // Orbit the rig origin about the head, then apply the same yaw to the rig.
    _offset.subVectors(this.group.position, _v).applyQuaternion(_q);
    this.group.position.copy(_v).add(_offset);
    this.group.quaternion.premultiply(_q);
    this.group.updateMatrixWorld(true);
  }

  get position(): Vector3 {
    return this.group.position;
  }
}
