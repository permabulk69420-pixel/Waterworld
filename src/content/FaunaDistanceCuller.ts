import { Object3D, Vector3, type Scene } from 'three';
import type { PlayerRig } from '../player/PlayerRig.ts';

const _player = new Vector3();
const _world = new Vector3();

/**
 * Distance cap for fauna systems that live directly under the scene rather than
 * inside streamed chunk content.
 *
 * Normal fish use the user-selected fauna range. Tiny seabed creatures use a
 * shorter size-aware fraction, large predators get a longer range, and huge
 * aerial/landmark fauna are deliberately exempt so their silhouettes do not pop.
 * This only controls visibility; each fauna system remains authoritative for
 * spawning, AI state and whether a pooled creature should exist at all.
 */
export class FaunaDistanceCuller {
  private readonly roots: Object3D[] = [];
  private readonly hiddenByDistance = new WeakSet<Object3D>();
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

    for (const root of this.roots) {
      const distance = this.distanceFor(root);
      if (!Number.isFinite(distance)) continue;

      root.getWorldPosition(_world);
      const distanceSq = _world.distanceToSquared(_player);
      const currentlyDistanceHidden = this.hiddenByDistance.has(root);
      // A little hysteresis prevents a fish flickering while it circles the cutoff.
      const threshold = currentlyDistanceHidden ? distance * 0.93 : distance * 1.04;
      const outside = distanceSq > threshold * threshold;

      if (outside) {
        if (root.visible) {
          root.visible = false;
          this.hiddenByDistance.add(root);
        }
      } else if (currentlyDistanceHidden) {
        // Only restore objects that this class hid. Pooled/dead fauna left hidden
        // by their own system are never accidentally resurrected.
        root.visible = true;
        this.hiddenByDistance.delete(root);
      }
    }
  }

  private rescan(): void {
    this.roots.length = 0;
    this.scene.traverse((object) => {
      if (!object.name.startsWith('fauna:')) return;
      if (this.isLandmarkFauna(object)) return;
      this.roots.push(object);
    });
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
