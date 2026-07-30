import {
  AnimationMixer,
  LoopOnce,
  Quaternion,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import type { VRHands, Handedness } from '../player/VRHands.ts';

const ASSET_URL = './assets/fauna/snap_bulb_FINAL_verified.glb';
const PLACED_NAME_PREFIX = 'placed:snap-bulb:';
const PEARL_NODE_NAME = 'SnapPearl';
const CLOSE_CLIP_NAME = 'Snap_Close';
const OPEN_CLIP_NAME = 'Snap_Open';

// These mirror the metadata baked into snap_bulb_FINAL_verified.glb, with a
// slightly more forgiving physical grab radius for tracked-controller VR.
const BASE_TRIGGER_RADIUS = 0.28;
const PEARL_GRAB_RADIUS = 0.12;
const PEARL_PULL_CLEAR_RADIUS = 0.24;
const REOPEN_RADIUS_MULTIPLIER = 1.35;
const WARNING_SECONDS = 0.16;
const REOPEN_DELAY_SECONDS = 1.35;
const GRIP_THRESHOLD = 0.55;

type SnapState = 'open' | 'closing' | 'closed' | 'opening';

interface BulbRuntime {
  root: Object3D;
  pearl: Object3D | null;
  pearlParent: Object3D | null;
  pearlHomePosition: Vector3;
  pearlHomeQuaternion: Quaternion;
  pearlHomeScale: Vector3;
  pearlHomeWorld: Vector3;
  mixer: AnimationMixer;
  closeAction: AnimationAction | null;
  openAction: AnimationAction | null;
  state: SnapState;
  threatTime: number;
  safeTime: number;
  collected: boolean;
  heldBy: Handedness | null;
  pulledClear: boolean;
}

const _leftTip = new Vector3();
const _rightTip = new Vector3();
const _leftPalm = new Vector3();
const _rightPalm = new Vector3();
const _pearlPosition = new Vector3();
const _worldScale = new Vector3();

/**
 * Story-mode behaviour for hand-authored snap bulbs.
 *
 * BuildSystem owns placement. In Story mode the rooted bulb is a physical VR
 * trap/resource: reach toward the pearl and the lid threatens to snap shut;
 * squeeze close enough to actually attach the pearl to the hand, pull it clear,
 * then release to bank it. The plant itself stays rooted in the authored world.
 */
export class SnapBulbSystem {
  readonly ready: Promise<void>;
  collectedPearls = 0;

  private readonly loader = new GLTFLoader();
  private readonly bulbs = new Map<Object3D, BulbRuntime>();
  private clips: AnimationClip[] = [];
  private loaded = false;
  private lastChildCount = -1;

  constructor(
    private readonly authoredRoot: Object3D,
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly mode: 'story' | 'build',
  ) {
    this.ready = this.loadClips();
  }

  private async loadClips(): Promise<void> {
    try {
      const gltf = await this.loader.loadAsync(ASSET_URL);
      this.clips = gltf.animations;
      this.loaded = true;
      this.syncInstances(true);
    } catch (error) {
      console.warn(`[snap-bulb] failed to load animation clips from ${ASSET_URL}`, error);
    }
  }

  update(dt: number): void {
    if (!this.loaded) return;
    this.syncInstances(false);

    const step = Math.min(Math.max(dt, 0), 0.05);
    for (const bulb of this.bulbs.values()) {
      bulb.mixer.update(step);
      if (this.mode !== 'story') continue;
      this.updateBulb(bulb, step);
    }
  }

  private syncInstances(force: boolean): void {
    if (!force && this.authoredRoot.children.length === this.lastChildCount) return;
    this.lastChildCount = this.authoredRoot.children.length;

    const present = new Set<Object3D>();
    for (const child of this.authoredRoot.children) {
      if (!child.name.startsWith(PLACED_NAME_PREFIX)) continue;
      present.add(child);
      if (!this.bulbs.has(child)) this.attachBulb(child);
    }

    for (const [root, runtime] of this.bulbs) {
      if (present.has(root)) continue;
      if (runtime.heldBy && runtime.pearl) runtime.pearl.removeFromParent();
      runtime.mixer.stopAllAction();
      runtime.mixer.uncacheRoot(root);
      this.bulbs.delete(root);
    }
  }

  private attachBulb(root: Object3D): void {
    const mixer = new AnimationMixer(root);
    const closeClip = this.clips.find((clip) => clip.name === CLOSE_CLIP_NAME) ?? null;
    const openClip = this.clips.find((clip) => clip.name === OPEN_CLIP_NAME) ?? null;
    const closeAction = closeClip ? mixer.clipAction(closeClip) : null;
    const openAction = openClip ? mixer.clipAction(openClip) : null;

    for (const action of [closeAction, openAction]) {
      if (!action) continue;
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
    }

    const pearl = root.getObjectByName(PEARL_NODE_NAME) ?? null;
    if (!pearl) console.warn(`[snap-bulb] ${root.name} is missing ${PEARL_NODE_NAME}`);
    if (!closeAction) console.warn(`[snap-bulb] ${root.name} is missing ${CLOSE_CLIP_NAME}`);
    if (!openAction) console.warn(`[snap-bulb] ${root.name} is missing ${OPEN_CLIP_NAME}`);

    root.updateWorldMatrix(true, true);
    const pearlHomeWorld = new Vector3();
    pearl?.getWorldPosition(pearlHomeWorld);

    this.bulbs.set(root, {
      root,
      pearl,
      pearlParent: pearl?.parent ?? null,
      pearlHomePosition: pearl?.position.clone() ?? new Vector3(),
      pearlHomeQuaternion: pearl?.quaternion.clone() ?? new Quaternion(),
      pearlHomeScale: pearl?.scale.clone() ?? new Vector3(1, 1, 1),
      pearlHomeWorld,
      mixer,
      closeAction,
      openAction,
      state: 'open',
      threatTime: 0,
      safeTime: 0,
      collected: false,
      heldBy: null,
      pulledClear: false,
    });
  }

  private updateBulb(bulb: BulbRuntime, dt: number): void {
    const pearl = bulb.pearl;
    if (!pearl) return;

    bulb.root.getWorldScale(_worldScale);
    const scale = Math.max(Math.abs(_worldScale.x), Math.abs(_worldScale.y), Math.abs(_worldScale.z));
    const safeScale = Math.max(scale, 0.02);
    const triggerRadius = BASE_TRIGGER_RADIUS * safeScale;
    const reopenRadius = triggerRadius * REOPEN_RADIUS_MULTIPLIER;
    const grabRadius = PEARL_GRAB_RADIUS * safeScale;
    const pullClearRadius = PEARL_PULL_CLEAR_RADIUS * safeScale;

    if (bulb.heldBy) {
      pearl.updateWorldMatrix(true, false);
      pearl.getWorldPosition(_pearlPosition);
      if (_pearlPosition.distanceTo(bulb.pearlHomeWorld) >= pullClearRadius) bulb.pulledClear = true;

      if (!this.gripHeld(bulb.heldBy)) this.finishPearlGrab(bulb);
      this.advanceSnapState(bulb, Number.POSITIVE_INFINITY, reopenRadius, dt);
      return;
    }

    const hasLeftTip = this.hands.getIndexTipWorldPosition('left', _leftTip);
    const hasRightTip = this.hands.getIndexTipWorldPosition('right', _rightTip);
    const leftTipDistance = hasLeftTip ? _leftTip.distanceTo(bulb.pearlHomeWorld) : Number.POSITIVE_INFINITY;
    const rightTipDistance = hasRightTip ? _rightTip.distanceTo(bulb.pearlHomeWorld) : Number.POSITIVE_INFINITY;
    const nearestTip = Math.min(leftTipDistance, rightTipDistance);

    const leftGrabDistance = Math.min(leftTipDistance, this.palmDistance('left', bulb.pearlHomeWorld, _leftPalm));
    const rightGrabDistance = Math.min(rightTipDistance, this.palmDistance('right', bulb.pearlHomeWorld, _rightPalm));

    if (!bulb.collected && bulb.state !== 'closed') {
      if (leftGrabDistance <= grabRadius && this.gripHeld('left')) this.beginPearlGrab(bulb, 'left');
      else if (rightGrabDistance <= grabRadius && this.gripHeld('right')) this.beginPearlGrab(bulb, 'right');
    }

    if (bulb.heldBy) return;
    this.advanceSnapState(bulb, nearestTip, reopenRadius, dt);
  }

  private advanceSnapState(bulb: BulbRuntime, nearest: number, reopenRadius: number, dt: number): void {
    if (bulb.state === 'open') {
      if (!bulb.collected && nearest <= BASE_TRIGGER_RADIUS * this.rootScale(bulb.root)) {
        bulb.threatTime += dt;
        if (bulb.threatTime >= WARNING_SECONDS) this.close(bulb);
      } else {
        bulb.threatTime = 0;
      }
      return;
    }

    if (bulb.state === 'closing') {
      if (!bulb.closeAction || !bulb.closeAction.isRunning()) bulb.state = 'closed';
      return;
    }

    if (bulb.state === 'closed') {
      if (!bulb.heldBy && nearest > reopenRadius) {
        bulb.safeTime += dt;
        if (bulb.safeTime >= REOPEN_DELAY_SECONDS) this.open(bulb);
      } else {
        bulb.safeTime = 0;
      }
      return;
    }

    if (bulb.state === 'opening' && (!bulb.openAction || !bulb.openAction.isRunning())) {
      bulb.state = 'open';
      bulb.threatTime = 0;
      bulb.safeTime = 0;
    }
  }

  private beginPearlGrab(bulb: BulbRuntime, handedness: Handedness): void {
    if (bulb.collected || bulb.heldBy || !bulb.pearl) return;
    const grip = this.hands.getObjectGrip(handedness);
    if (!grip) return;

    bulb.pearl.updateWorldMatrix(true, false);
    grip.attach(bulb.pearl);
    bulb.pearl.updateMatrixWorld(true);
    bulb.heldBy = handedness;
    bulb.pulledClear = false;

    // A successful grab immediately commits the trap: the hand now physically owns
    // the pearl while the baked lid animation snaps shut around/behind it.
    this.close(bulb);
  }

  private finishPearlGrab(bulb: BulbRuntime): void {
    if (!bulb.pearl || !bulb.heldBy) return;

    if (bulb.pulledClear) {
      bulb.collected = true;
      bulb.pearl.removeFromParent();
      bulb.pearl.visible = false;
      this.collectedPearls += 1;
      console.info(`[snap-bulb] pearl collected (${this.collectedPearls})`);
    } else {
      this.returnPearlHome(bulb);
    }

    bulb.heldBy = null;
    bulb.pulledClear = false;
  }

  private returnPearlHome(bulb: BulbRuntime): void {
    const pearl = bulb.pearl;
    const parent = bulb.pearlParent;
    if (!pearl || !parent) return;

    parent.add(pearl);
    pearl.position.copy(bulb.pearlHomePosition);
    pearl.quaternion.copy(bulb.pearlHomeQuaternion);
    pearl.scale.copy(bulb.pearlHomeScale);
    pearl.visible = true;
    pearl.updateMatrixWorld(true);
  }

  private close(bulb: BulbRuntime): void {
    if (bulb.state === 'closing' || bulb.state === 'closed') return;
    bulb.openAction?.stop();
    if (bulb.closeAction) {
      bulb.closeAction.reset().play();
      bulb.state = 'closing';
    } else {
      bulb.state = 'closed';
    }
    bulb.threatTime = 0;
    bulb.safeTime = 0;
  }

  private open(bulb: BulbRuntime): void {
    if (bulb.state === 'opening' || bulb.state === 'open') return;
    bulb.closeAction?.stop();
    if (bulb.openAction) {
      bulb.openAction.reset().play();
      bulb.state = 'opening';
    } else {
      bulb.state = 'open';
    }
    bulb.threatTime = 0;
    bulb.safeTime = 0;
  }

  private palmDistance(handedness: Handedness, target: Vector3, scratch: Vector3): number {
    const grip = this.hands.getObjectGrip(handedness);
    if (!grip) return Number.POSITIVE_INFINITY;
    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(scratch);
    return scratch.distanceTo(target);
  }

  private rootScale(root: Object3D): number {
    root.getWorldScale(_worldScale);
    return Math.max(0.02, Math.abs(_worldScale.x), Math.abs(_worldScale.y), Math.abs(_worldScale.z));
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
    for (const runtime of this.bulbs.values()) {
      if (runtime.heldBy && runtime.pearl) runtime.pearl.removeFromParent();
      runtime.mixer.stopAllAction();
      runtime.mixer.uncacheRoot(runtime.root);
    }
    this.bulbs.clear();
  }
}
