import { Group, Object3D, Vector3, type Scene } from 'three';
import type { PlayerRig } from '../player/PlayerRig.ts';

const _player = new Vector3();
const _world = new Vector3();

interface FaunaCullEntry {
  root: Object3D;
  wrapper: Group;
}

/**
 * Distance cap for fauna systems that live directly under the scene rather than
 * inside streamed chunk content.
 *
 * Normal fish use the user-selected fauna range. Tiny seabed creatures use a
 * shorter size-aware fraction, large predators get a longer range, and huge
 * aerial/landmark fauna are deliberately exempt so their silhouettes do not pop.
 *
 * Each managed creature gets an identity wrapper that owns only distance
 * visibility. The fauna system keeps full ownership of the creature root's own
 * `visible` state, so a pooled/dead fish can never be accidentally resurrected
 * when the player swims back inside the distance threshold.
 */
export class FaunaDistanceCuller {
  private readonly entries: FaunaCullEntry[] = [];
  private readonly wrappers = new WeakMap<Object3D, Group>();
  private rescanTimer = 0;

  constructor(
    private readonly scene: Scene,
    private readonly rig: PlayerRig,
    private readonly faunaDistance: number,
  ) {}

  update(dt: number): void {
    this.rescanTimer -= Math.max(0, dt);
    if (this.rescanTimer <= 0) {
      this.rescanTimer = 0.4;
      this.rescan();
    }

    this.rig.getHeadPosition(_player);

    for (const { root, wrapper } of this.entries) {
      const distance = this.distanceFor(root);
      if (!Number.isFinite(distance)) continue;

      root.getWorldPosition(_world);
      const distanceSq = _world.distanceToSquared(_player);
      // A little hysteresis prevents a fish flickering while it circles the cutoff.
      const threshold = wrapper.visible ? distance * 1.04 : distance * 0.93;
      wrapper.visible = distanceSq <= threshold * threshold;
    }
  }

  private rescan(): void {
    const candidates: Object3D[] = [];
    this.scene.traverse((object) => {
      if (!object.name.startsWith('fauna:')) return;
      if (this.isLandmarkFauna(object)) return;
      candidates.push(object);
    });

    this.entries.length = 0;
    for (const root of candidates) {
      const wrapper = this.ensureWrapper(root);
      if (wrapper) this.entries.push({ root, wrapper });
    }
  }

  private ensureWrapper(root: Object3D): Group | null {
    const existing = this.wrappers.get(root);
    if (existing) return existing;

    const parent = root.parent;
    if (!parent) return null;

    const wrapper = new Group();
    wrapper.name = `distance-cull:${root.name}`;
    wrapper.userData.distanceCullWrapper = true;
    parent.add(wrapper);
    // Preserve the root's world transform while inserting an identity parent.
    wrapper.attach(root);
    this.wrappers.set(root, wrapper);
    return wrapper;
  }

  private isLandmarkFauna(root: Object3D): boolean {
    if (root.userData.distanceCullClass === 'landmark') return true;
    const name = root.name.toLowerCase();
    return name.includes('lumenveil') || name.includes('sky-jelly') || name.includes('skyjelly');
  }

  private distanceFor(root: Object3D): number {
    const override = Number(root.userData.renderDistance);
    if (Number.isFinite(override) && override > 0) return override;

    const name = root.name.toLowerCase();

    // A 30 cm seabed crab stops contributing to the image much sooner than fish.
    if (name.includes('octopus') || name.includes('crab')) {
      return Math.max(24, Math.min(48, this.faunaDistance * 0.42));
    }

    // The ~5 m Riftmaw is readable at much greater range and should loom around
    // the Colossus before the player is close enough to trigger its encounter AI.
    if (name.includes('riftmaw')) {
      return Math.max(150, Math.min(240, this.faunaDistance * 2.1));
    }

    return this.faunaDistance;
  }
}
