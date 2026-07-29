import { Euler, MathUtils, type PerspectiveCamera } from 'three';
import { clamp } from '../math/mathUtils.ts';
import { createMoveIntent, resetMoveIntent, type MoveIntent } from './inputTypes.ts';

/**
 * Desktop fallback controls, for inspecting terrain and caves without a
 * headset.
 *
 *   WASD           swim (relative to where you are looking)
 *   Space / Ctrl   ascend / descend
 *   Shift          boost
 *   Q / E          turn (same smooth turn path as the right stick)
 *   mouse          look, after clicking to capture the pointer
 *   F3 / F4 / F5   debug HUD / chunk bounds / collision volume
 *
 * Pitch is applied to the camera and yaw to the rig, mirroring how XR splits
 * head pose from rig pose - so the locomotion solver behaves identically in
 * both modes.
 */
export class DesktopInput {
  private readonly intent = createMoveIntent();
  private readonly keys = new Set<string>();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  private yawDelta = 0;
  private pitch = 0;
  private captured = false;

  /** Fires once per key press. */
  onToggleDebug: (() => void) | null = null;
  onToggleChunkBounds: (() => void) | null = null;
  onToggleCollisionVolume: (() => void) | null = null;
  onPointerCaptureChange: ((captured: boolean) => void) | null = null;

  mouseSensitivity = 0.0022;

  private readonly boundKeyDown = (e: KeyboardEvent) => this.onKeyDown(e);
  private readonly boundKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private readonly boundMouseMove = (e: MouseEvent) => this.onMouseMove(e);
  private readonly boundPointerLock = () => this.onPointerLockChange();
  private readonly boundBlur = () => this.keys.clear();

  constructor(
    private readonly domElement: HTMLElement,
    private readonly camera: PerspectiveCamera,
  ) {
    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
    window.addEventListener('blur', this.boundBlur);
    document.addEventListener('mousemove', this.boundMouseMove);
    document.addEventListener('pointerlockchange', this.boundPointerLock);
    domElement.addEventListener('click', () => {
      if (!this.captured) void domElement.requestPointerLock();
    });
  }

  get pointerCaptured(): boolean {
    return this.captured;
  }

  /**
   * Returns this frame's intent. `active` is false while an XR session owns
   * the input, so desktop keys never leak into VR movement.
   */
  poll(active: boolean): MoveIntent {
    const intent = resetMoveIntent(this.intent);
    if (!active) {
      this.yawDelta = 0;
      return intent;
    }

    const k = this.keys;
    const forward = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const strafe = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const vertical =
      (k.has('Space') ? 1 : 0) -
      (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC') ? 1 : 0);
    const turn = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);

    intent.forward = forward;
    intent.strafe = strafe;
    intent.vertical = vertical;
    intent.turn = turn;
    intent.boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : 0;
    return intent;
  }

  /**
   * Mouse-look yaw consumed by the rig this frame, in radians. Pitch has
   * already been applied to the camera.
   */
  consumeYawDelta(): number {
    const delta = this.yawDelta;
    this.yawDelta = 0;
    return delta;
  }

  /** Re-applies the accumulated pitch. Call after the rig has been yawed. */
  applyCameraPitch(): void {
    this.euler.setFromQuaternion(this.camera.quaternion);
    this.euler.x = this.pitch;
    this.euler.y = 0;
    this.euler.z = 0;
    this.camera.quaternion.setFromEuler(this.euler);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
    window.removeEventListener('blur', this.boundBlur);
    document.removeEventListener('mousemove', this.boundMouseMove);
    document.removeEventListener('pointerlockchange', this.boundPointerLock);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'F3') {
      e.preventDefault();
      this.onToggleDebug?.();
      return;
    }
    if (e.code === 'F4') {
      e.preventDefault();
      this.onToggleChunkBounds?.();
      return;
    }
    if (e.code === 'F5' && e.shiftKey) {
      e.preventDefault();
      this.onToggleCollisionVolume?.();
      return;
    }
    this.keys.add(e.code);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.captured) return;
    this.yawDelta -= e.movementX * this.mouseSensitivity;
    this.pitch = clamp(
      this.pitch - e.movementY * this.mouseSensitivity,
      -MathUtils.degToRad(89),
      MathUtils.degToRad(89),
    );
  }

  private onPointerLockChange(): void {
    this.captured = document.pointerLockElement === this.domElement;
    if (!this.captured) this.keys.clear();
    this.onPointerCaptureChange?.(this.captured);
  }
}
