import { Box3, Matrix4, Object3D, Quaternion, Scene, Vector3, type WebGLRenderer } from 'three';

import type { Locomotion } from './Locomotion.ts';
import type { PlayerRig } from './PlayerRig.ts';
import type { Handedness, VRHands } from './VRHands.ts';

const GRIP_THRESHOLD = 0.45;
const GRAB_DISTANCE = 0.55;
const PULL_SCALE = 2.7;
const MAX_PULL_PER_FRAME = 0.42;

const _handWorld = new Vector3();
const _currentLocal = new Vector3();
const _deltaLocal = new Vector3();
const _deltaWorld = new Vector3();
const _rigQuat = new Quaternion();
const _rigInverse = new Matrix4();

/**
 * Local climbing interaction for the ship's rear grab ledge.
 *
 * Holding squeeze near RearGrabLedge anchors the hand. Physical controller motion
 * then moves the player in the opposite direction, amplified enough that a normal
 * arm pull can actually lift the body from the water onto the cargo deck.
 */
export class RearLedgeClimb {
  private ledge: Object3D | null = null;
  private readonly ledgeBounds = new Box3();
  private activeHand: Handedness | null = null;
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

  private trackedRigLocal(grip: Object3D, target: Vector3): Vector3 {
    grip.updateWorldMatrix(true, false);
    target.setFromMatrixPosition(grip.matrixWorld);
    this.rig.group.updateWorldMatrix(true, false);
    _rigInverse.copy(this.rig.group.matrixWorld).invert();
    return target.applyMatrix4(_rigInverse);
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
    this.lastLocal.copy(this.trackedRigLocal(grip, _currentLocal));
    this.locomotion.setExternalClimbActive(true);
  }

  private end(): void {
    this.activeHand = null;
    this.locomotion.setExternalClimbActive(false);
  }

  update(): void {
    if (!this.renderer.xr.isPresenting) {
      if (this.activeHand) this.end();
      return;
    }

    const leftHeld = this.gripHeld('left');
    const rightHeld = this.gripHeld('right');

    // Do not require a perfectly timed squeeze edge. If grip is already held when
    // the hand reaches the ledge, latch as soon as it enters the grab radius.
    if (!this.activeHand) {
      if (leftHeld && this.canStart('left')) this.begin('left');
      else if (rightHeld && this.canStart('right')) this.begin('right');
    }

    if (!this.activeHand) return;

    const held = this.activeHand === 'left' ? leftHeld : rightHeld;
    const grip = this.hands.getControllerGrip(this.activeHand);
    if (!held || !grip) {
      this.end();
      return;
    }

    this.trackedRigLocal(grip, _currentLocal);
    _deltaLocal.subVectors(this.lastLocal, _currentLocal).multiplyScalar(PULL_SCALE);
    this.lastLocal.copy(_currentLocal);

    if (_deltaLocal.lengthSq() > MAX_PULL_PER_FRAME * MAX_PULL_PER_FRAME) {
      _deltaLocal.setLength(MAX_PULL_PER_FRAME);
    }

    this.rig.group.getWorldQuaternion(_rigQuat);
    _deltaWorld.copy(_deltaLocal).applyQuaternion(_rigQuat);
    if (_deltaWorld.lengthSq() > 1e-8) this.rig.translate(_deltaWorld);

    this.locomotion.velocity.set(0, 0, 0);
    this.locomotion.clearPropulsionInput();
  }
}
