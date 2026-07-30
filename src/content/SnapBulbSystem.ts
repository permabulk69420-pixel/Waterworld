import {
  AnimationMixer,
  LoopOnce,
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

// These mirror the metadata baked into snap_bulb_FINAL_verified.glb.
const BASE_TRIGGER_RADIUS = 0.28;
const PEARL_GRAB_RADIUS = 0.065;
const REOPEN_RADIUS_MULTIPLIER = 1.35;
const WARNING_SECONDS = 0.16;
const REOPEN_DELAY_SECONDS = 1.35;
const GRIP_THRESHOLD = 0.55;

type SnapState = 'open' | 'closing' | 'closed' | 'opening';

interface BulbRuntime {
  root: Object3D;
  pearl: Object3D | null;
  mixer: AnimationMixer;
  closeAction: AnimationAction | null;
  openAction: AnimationAction | null;
  state: SnapState;
  threatTime: number;
  safeTime: number;
  collected: boolean;
}

const _leftTip = new Vector3();
const _rightTip = new Vector3();
const _pearlPosition = new Vector3();
const _worldScale = new Vector3();

/**
 * Story-mode behaviour for hand-authored snap bulbs.
 *
 * BuildSystem owns placement. This system simply discovers placed:snap-bulb:*
 * roots, attaches the GLB's baked open/close clips, watches both fingertips and
 * lets a close grip collect SnapPearl before the lid completes its ambush.
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

    this.bulbs.set(root, {
      root,
      pearl,
      mixer,
      closeAction,
      openAction,
      state: 'open',
      threatTime: 0,
      safeTime: 0,
      collected: false,
    });
  }

  private updateBulb(bulb: BulbRuntime, dt: number): void {
    const pearl = bulb.pearl;
    if (!pearl) return;

    pearl.updateWorldMatrix(true, false);
    pearl.getWorldPosition(_pearlPosition);
    bulb.root.getWorldScale(_worldScale);
    const scale = Math.max(Math.abs(_worldScale.x), Math.abs(_worldScale.y), Math.abs(_worldScale.z));
    const triggerRadius = BASE_TRIGGER_RADIUS * Math.max(scale, 0.02);
    const reopenRadius = triggerRadius * REOPEN_RADIUS_MULTIPLIER;
    const grabRadius = PEARL_GRAB_RADIUS * Math.max(scale, 0.02);

    const hasLeft = this.hands.getIndexTipWorldPosition('left', _leftTip);
    const hasRight = this.hands.getIndexTipWorldPosition('right', _rightTip);
    const leftDistance = hasLeft ? _leftTip.distanceTo(_pearlPosition) : Number.POSITIVE_INFINITY;
    const rightDistance = hasRight ? _rightTip.distanceTo(_pearlPosition) : Number.POSITIVE_INFINITY;
    const nearest = Math.min(leftDistance, rightDistance);

    if (!bulb.collected) {
      if (leftDistance <= grabRadius && this.gripHeld('left')) this.collectPearl(bulb);
      else if (rightDistance <= grabRadius && this.gripHeld('right')) this.collectPearl(bulb);
    }

    if (bulb.state === 'open') {
      if (nearest <= triggerRadius) {
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
      if (nearest > reopenRadius) {
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

  private collectPearl(bulb: BulbRuntime): void {
    if (bulb.collected || !bulb.pearl) return;
    bulb.collected = true;
    bulb.pearl.visible = false;
    this.collectedPearls += 1;
    console.info(`[snap-bulb] pearl collected (${this.collectedPearls})`);
    this.close(bulb);
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
      runtime.mixer.stopAllAction();
      runtime.mixer.uncacheRoot(runtime.root);
    }
    this.bulbs.clear();
  }
}
