import { Box3, Object3D, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';

import type { Locomotion } from './Locomotion.ts';
import type { PlayerRig } from './PlayerRig.ts';
import type { Handedness, VRHands } from './VRHands.ts';

const GRIP_THRESHOLD = 0.55;
const GRAB_DISTANCE = 0.32;
const MAX_PULL_PER_FRAME = 0.28;

const _handWorld = new Vector3();
const _currentLocal = new Vector3();
const _deltaLocal = new Vector3();
const _deltaWorld = new Vector3();
const _rigQuat = new Quaternion();

/**
 * Tiny, deliberately local climbing interaction for the ship's rear grab ledge.
 *
 * Squeeze while either tracked hand is close to RearGrabLedge. While held, the
 * rig moves opposite the real controller motion, so pulling the hand down pulls
 * the body up. This is not a generic world-climbing system and does not turn
 * decorative ladders into climbable objects.
 */
export class RearLedgeClimb {
  private ledge: Object3D | null = null;
  private readonly ledgeBounds = new Box3();
  private activeHand: Handedness | null = null;
  private readonly previousHeld: Record<Handedness, boolean> = { left: false, right: false };
  private readonly lastLocal = new Vector3();

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly rig: PlayerRig,
    private readonly hands: VRHands,
    private readonly locomotion: Locomotion,
  ) {
    this.resolveLedge();
  }

  private resolveLedge(): void {
    const exact = this.scene.getObjectByName('RearGrabLedge');
    if (exact) {
      this.ledge = exact;
      exact.updateWorldMatrix(true, true);
      this.ledgeBounds.setFromObject(exact);
      return;
    }

    let fallback: Object3D | null = null;
    this.scene.traverse((object) => {
      if (fallback) return;
      if (object.name.toLowerCase() === 'reargrabledge') fallback = object;
    });
    if (fallback) {
      this.ledge = fallback;
      fallback.updateWorldMatrix(true, true);
      this.ledgeBounds.setFromObject(fallback);
    }
  }

  private gripHeld(handedness: Handedness): boolean {
    const session = this.renderer.xr.getSession();
    if (!session) return false;
    for (const source of session.inputSources) {
      if (source.handedness !== handedness) continue;
      return (source.gamepad?.buttons[1]?.value ?? 0) > GRIP_THRESHOLD;
    }
    return false;
  }

  private canStart(handedness: Handedness): boolean {
    if (!this.ledge) this.resolveLedge();
    if (!this.ledge) return false;

    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return false;
    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(_handWorld);
    return this.ledgeBounds.distanceToPoint(_handWorld) <= GRAB_DISTANCE;
  }

  private begin(handedness: Handedness): void {
    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return;
    this.activeHand = handedness;
    this.lastLocal.copy(grip.position);
    this.locomotion.velocity.set(0, 0, 0);
    this.locomotion.clearPropulsionInput();
  }

  private end(): void {
    this.activeHand = null;
    this.locomotion.velocity.set(0, 0, 0);
  }

  update(): void {
    if (!this.renderer.xr.isPresenting) {
      this.activeHand = null;
      this.previousHeld.left = false;
      this.previousHeld.right = false;
      return;
    }

    const leftHeld = this.gripHeld('left');
    const rightHeld = this.gripHeld('right');

    if (!this.activeHand) {
      if (leftHeld && !this.previousHeld.left && this.canStart('left')) this.begin('left');
      else if (rightHeld && !this.previousHeld.right && this.canStart('right')) this.begin('right');
    }

    if (this.activeHand) {
      const held = this.activeHand === 'left' ? leftHeld : rightHeld;
      const grip = this.hands.getControllerGrip(this.activeHand);
      if (!held || !grip) {
        this.end();
      } else {
        _currentLocal.copy(grip.position);
        _deltaLocal.subVectors(this.lastLocal, _currentLocal);
        this.lastLocal.copy(_currentLocal);

        if (_deltaLocal.lengthSq() > MAX_PULL_PER_FRAME * MAX_PULL_PER_FRAME) {
          _deltaLocal.setLength(MAX_PULL_PER_FRAME);
        }

        this.rig.group.getWorldQuaternion(_rigQuat);
        _deltaWorld.copy(_deltaLocal).applyQuaternion(_rigQuat);
        if (_deltaWorld.lengthSq() > 1e-8) this.rig.translate(_deltaWorld);

        // Kill ordinary momentum while a hand is anchored to the ledge. The normal
        // locomotion frame still runs afterward, but starts from rest each frame.
        this.locomotion.velocity.set(0, 0, 0);
        this.locomotion.clearPropulsionInput();
      }
    }

    this.previousHeld.left = leftHeld;
    this.previousHeld.right = rightHeld;
  }
}
