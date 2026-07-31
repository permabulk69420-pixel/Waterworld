import {
  Vector3,
  type AnimationAction,
  type Group,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { PrismFishSystem } from './PrismFishSystem.ts';
import type { Handedness, VRHands } from '../player/VRHands.ts';

const GRAB_RADIUS = 0.28;
const GRAB_RADIUS_SQ = GRAB_RADIUS * GRAB_RADIUS;
const GRIP_THRESHOLD = 0.45;

const _fishWorld = new Vector3();
const _tipWorld = new Vector3();
const _gripWorld = new Vector3();

interface PrismFishInternal {
  root: Group;
  currentAction: AnimationAction | null;
  home: Vector3;
  target: Vector3;
  direction: Vector3;
  state: 'cruise' | 'idle' | 'flee';
  stateTimer: number;
  fleeTimer: number;
  cellKey: string | null;
}

interface PrismFishRuntime {
  activeSchools: Map<string, PrismFishInternal[]>;
}

interface HeldFish {
  fish: PrismFishInternal;
  handedness: Handedness;
}

/**
 * Tiny physical interaction layer for prism fish.
 *
 * A gripped fish is temporarily removed from PrismFishSystem.activeSchools, which
 * means its normal swim/flee AI stops moving it while the tracked hand owns its
 * transform. Releasing grip reattaches it to the world as a one-fish live school;
 * normal AI takes over again on the next PrismFishSystem frame.
 *
 * This deliberately mirrors the direct runtime population access already used by
 * SpeargunSystem for fish hits, avoiding a second competing movement path inside
 * PrismFishSystem itself.
 */
export class PrismFishGrabSystem {
  private readonly heldByHand: Record<Handedness, HeldFish | null> = {
    left: null,
    right: null,
  };

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly scene: Scene,
    private readonly prismFish: PrismFishSystem,
  ) {}

  update(): void {
    this.updateHeld('left');
    this.updateHeld('right');

    if (!this.renderer.xr.isPresenting) return;

    if (!this.heldByHand.left && this.gripHeld('left')) this.tryGrabNearest('left');
    if (!this.heldByHand.right && this.gripHeld('right')) this.tryGrabNearest('right');
  }

  private updateHeld(handedness: Handedness): void {
    const held = this.heldByHand[handedness];
    if (!held) return;
    if (!this.gripHeld(handedness)) this.release(handedness);
  }

  private tryGrabNearest(handedness: Handedness): void {
    const objectGrip = this.hands.getObjectGrip(handedness);
    if (!objectGrip) return;

    // Do not pile a fish into the same palm while a tool/other physical pickup is
    // already parented to this shared held-object socket.
    if (objectGrip.children.length > 0) return;

    const runtime = this.prismFish as unknown as PrismFishRuntime;
    let bestFish: PrismFishInternal | null = null;
    let bestSchoolKey: string | null = null;
    let bestDistanceSq = GRAB_RADIUS_SQ;

    for (const [schoolKey, school] of runtime.activeSchools) {
      for (const fish of school) {
        if (!fish.root.visible || this.isAlreadyHeld(fish)) continue;
        fish.root.updateWorldMatrix(true, false);
        fish.root.getWorldPosition(_fishWorld);
        const distanceSq = this.handDistanceSq(handedness, _fishWorld);
        if (distanceSq > bestDistanceSq) continue;
        bestDistanceSq = distanceSq;
        bestFish = fish;
        bestSchoolKey = schoolKey;
      }
    }

    if (!bestFish || !bestSchoolKey) return;
    this.beginGrab(bestFish, bestSchoolKey, handedness, objectGrip);
  }

  private beginGrab(
    fish: PrismFishInternal,
    schoolKey: string,
    handedness: Handedness,
    objectGrip: Group,
  ): void {
    const runtime = this.prismFish as unknown as PrismFishRuntime;
    const school = runtime.activeSchools.get(schoolKey);
    if (!school) return;

    const index = school.indexOf(fish);
    if (index < 0) return;
    school.splice(index, 1);
    if (school.length === 0) runtime.activeSchools.delete(schoolKey);

    fish.currentAction?.stop();
    fish.currentAction = null;
    fish.cellKey = null;

    // Object3D.attach preserves the exact world-space pose at the instant the hand
    // catches it, so there is no ugly snap to the controller origin.
    objectGrip.attach(fish.root);
    fish.root.visible = true;
    this.heldByHand[handedness] = { fish, handedness };
  }

  private release(handedness: Handedness): void {
    const held = this.heldByHand[handedness];
    if (!held) return;

    const fish = held.fish;
    fish.root.updateWorldMatrix(true, false);
    this.scene.attach(fish.root);
    fish.root.visible = true;

    // Reset its local wander origin to wherever the player released it. Because it
    // is still close to the player, PrismFishSystem will normally enter its existing
    // flee/scurry state immediately on the next frame.
    fish.home.copy(fish.root.position);
    fish.target.copy(fish.root.position);
    fish.state = 'idle';
    fish.stateTimer = 0;
    fish.fleeTimer = 0;
    fish.currentAction = null;

    const runtime = this.prismFish as unknown as PrismFishRuntime;
    let key = `released:${fish.root.uuid}`;
    let suffix = 1;
    while (runtime.activeSchools.has(key)) key = `released:${fish.root.uuid}:${suffix++}`;
    fish.cellKey = key;
    runtime.activeSchools.set(key, [fish]);

    this.heldByHand[handedness] = null;
  }

  private isAlreadyHeld(fish: PrismFishInternal): boolean {
    return this.heldByHand.left?.fish === fish || this.heldByHand.right?.fish === fish;
  }

  private handDistanceSq(handedness: Handedness, target: Vector3): number {
    let best = Number.POSITIVE_INFINITY;

    if (this.hands.getIndexTipWorldPosition(handedness, _tipWorld)) {
      best = _tipWorld.distanceToSquared(target);
    }

    const controllerGrip = this.hands.getControllerGrip(handedness);
    if (controllerGrip) {
      controllerGrip.updateWorldMatrix(true, false);
      controllerGrip.getWorldPosition(_gripWorld);
      best = Math.min(best, _gripWorld.distanceToSquared(target));
    }

    return best;
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

  dispose(): void {
    this.release('left');
    this.release('right');
  }
}
