import { Box3, Group, Object3D, Vector3 } from 'three';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { DensityField } from '../world/density.ts';
import { Rng, hashInts } from '../math/rng.ts';

/**
 * Content placement hooks.
 *
 * Nothing is populated in this pass - this exists so that vegetation, rocks,
 * resources, creatures, structures and cave dressing can be added later
 * without touching the terrain engine. A populator is called once per chunk
 * load with a context that already knows how to answer the questions placement
 * code actually asks ("give me N points on the seabed that are not too steep",
 * "give me N points inside cave voids"), and everything it adds to the chunk
 * group is disposed automatically when the chunk unloads.
 *
 * Determinism rule: populators must only use `ctx.rng` (seeded from world seed
 * + chunk coords + populator id) so a chunk repopulates identically every time
 * it streams back in.
 */

export type ContentLayer =
  | 'vegetation'
  | 'rocks'
  | 'resources'
  | 'creatures'
  | 'structures'
  | 'caveProps';

export const CONTENT_LAYERS: readonly ContentLayer[] = [
  'vegetation',
  'rocks',
  'resources',
  'creatures',
  'structures',
  'caveProps',
];

export interface ContentVisibilityDistances {
  /** Reference distance for ordinary vegetation, rocks and world props. */
  detailDistance: number;
  /** Reference distance for ordinary creature content. */
  faunaDistance: number;
}

interface ChunkVisibilityRecord {
  root: Group;
  bounds: Box3;
}

export interface SurfacePoint {
  position: Vector3;
  normal: Vector3;
  /** Depth below sea level, in metres. */
  depth: number;
}

export interface ChunkContentContext {
  readonly key: string;
  readonly cx: number;
  readonly cz: number;
  /** World-space chunk footprint (full vertical extent of the mesh). */
  readonly bounds: Box3;
  readonly origin: Vector3;
  readonly biome: BiomeConfig;
  readonly worldSeed: number;

  /** Deterministic RNG, unique per (chunk, populator). */
  readonly rng: Rng;
  /** Group this populator should attach objects to. Disposed on unload. */
  readonly group: Group;

  /** Raw seabed height at a world XZ (ignores caves and overhangs). */
  seabedAt(x: number, z: number): number;
  /** Density at a world position; > 0 is inside terrain. */
  densityAt(x: number, y: number, z: number): number;

  /**
   * Candidate seabed points inside this chunk. `maxSlope` is the minimum
   * accepted surface normal Y (1 = flat only, 0 = anything).
   */
  sampleSeabedPoints(count: number, minNormalY?: number): SurfacePoint[];
  /** Candidate points inside cave voids in this chunk, if any exist. */
  sampleCavePoints(count: number): Vector3[];
}

export interface ContentPopulator {
  /** Stable id - also seeds this populator's RNG. */
  readonly id: string;
  readonly layer: ContentLayer;
  /**
   * Keep this populator's empty group attached to a loaded chunk. Useful for
   * content that records cheap placements at chunk-load time but only creates
   * expensive meshes when the player gets close.
   */
  readonly keepsEmptyGroup?: boolean;
  /** Skip chunks whose biome does not want this content. */
  appliesTo?(biome: BiomeConfig): boolean;
  populate(ctx: ChunkContentContext): void;
  /** Optional per-frame update for distance culling, animation, AI, etc. */
  update?(dt: number, playerPosition: Vector3): void;
  /** Optional extra teardown; the chunk group itself is always disposed. */
  dispose?(key: string): void;
}

const VISIBILITY_REBUILD_DISTANCE = 2.5;
const VISIBILITY_REBUILD_DISTANCE_SQ = VISIBILITY_REBUILD_DISTANCE * VISIBILITY_REBUILD_DISTANCE;

export class ContentRegistry {
  private readonly populators: ContentPopulator[] = [];
  private readonly chunkVisibility = new Map<string, ChunkVisibilityRecord>();
  private readonly lastVisibilityPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private visibilityDirty = true;
  private detailDistance = Number.POSITIVE_INFINITY;
  private faunaDistance = Number.POSITIVE_INFINITY;

  constructor(
    private readonly density: DensityField,
    private readonly worldSeed: number,
  ) {}

  register(populator: ContentPopulator): void {
    if (this.populators.some((p) => p.id === populator.id)) {
      throw new Error(`Content populator "${populator.id}" is already registered`);
    }
    this.populators.push(populator);
  }

  unregister(id: string): void {
    const i = this.populators.findIndex((p) => p.id === id);
    if (i >= 0) this.populators.splice(i, 1);
  }

  get count(): number {
    return this.populators.length;
  }

  /**
   * Sets the shared world-content distance budget.
   *
   * Individual systems may still use a shorter internal distance for extremely
   * dense micro-detail. This layer is the authoritative upper bound for chunked
   * content and means new rocks/plants/creatures automatically inherit sensible
   * culling without each asset inventing another performance setting.
   */
  setVisibilityDistances(distances: ContentVisibilityDistances): void {
    this.detailDistance = Math.max(1, distances.detailDistance);
    this.faunaDistance = Math.max(1, distances.faunaDistance);
    this.visibilityDirty = true;
  }

  /** Update runtime content once from the game's existing frame loop. */
  update(dt: number, playerPosition: Vector3): void {
    // Let specialised systems perform animation / local instance streaming first.
    // Shared layer visibility runs last so the user's distance budget remains an
    // upper bound even when a populator has its own internal culling policy.
    for (const populator of this.populators) populator.update?.(dt, playerPosition);
    this.updateLayerVisibility(playerPosition);
  }

  /**
   * Runs every populator for a chunk. Returns the group to parent under the
   * chunk mesh, or null when nothing was added.
   */
  populate(
    key: string,
    cx: number,
    cz: number,
    chunkSize: number,
    bounds: Box3,
    biome: BiomeConfig,
  ): Group | null {
    if (this.populators.length === 0) return null;

    const root = new Group();
    root.name = `content:${key}`;
    const origin = new Vector3(cx * chunkSize, 0, cz * chunkSize);

    for (const populator of this.populators) {
      if (populator.appliesTo && !populator.appliesTo(biome)) continue;

      const layerGroup = new Group();
      layerGroup.name = populator.layer;
      const ctx = this.createContext(
        key,
        cx,
        cz,
        chunkSize,
        bounds,
        biome,
        origin,
        populator,
        layerGroup,
      );
      populator.populate(ctx);
      if (layerGroup.children.length > 0 || populator.keepsEmptyGroup) root.add(layerGroup);
    }

    if (root.children.length === 0) return null;

    this.chunkVisibility.set(key, { root, bounds: bounds.clone() });
    this.visibilityDirty = true;
    return root;
  }

  /** Called by the chunk manager when a chunk unloads. */
  release(key: string, group: Group | null): void {
    this.chunkVisibility.delete(key);
    this.visibilityDirty = true;
    for (const populator of this.populators) populator.dispose?.(key);
    if (group) disposeSubtree(group);
  }

  private updateLayerVisibility(playerPosition: Vector3): void {
    const dx = playerPosition.x - this.lastVisibilityPosition.x;
    const dz = playerPosition.z - this.lastVisibilityPosition.z;
    if (!this.visibilityDirty && dx * dx + dz * dz < VISIBILITY_REBUILD_DISTANCE_SQ) return;

    for (const { root, bounds } of this.chunkVisibility.values()) {
      const nearestX = Math.max(bounds.min.x, Math.min(bounds.max.x, playerPosition.x));
      const nearestZ = Math.max(bounds.min.z, Math.min(bounds.max.z, playerPosition.z));
      const ddx = playerPosition.x - nearestX;
      const ddz = playerPosition.z - nearestZ;
      const distanceSq = ddx * ddx + ddz * ddz;

      for (const layerGroup of root.children) {
        const layer = layerGroup.name as ContentLayer;
        const distance = this.distanceForLayer(layer);
        if (!Number.isFinite(distance)) continue;

        // Small hysteresis prevents a whole chunk layer flickering if the player
        // hovers right on the cutoff while swimming or bobbing at the surface.
        const threshold = layerGroup.visible ? distance * 1.04 : distance * 0.96;
        layerGroup.visible = distanceSq <= threshold * threshold;
      }
    }

    this.lastVisibilityPosition.copy(playerPosition);
    this.visibilityDirty = false;
  }

  private distanceForLayer(layer: ContentLayer): number {
    switch (layer) {
      case 'creatures':
        return this.faunaDistance;
      case 'resources':
        return this.detailDistance * 0.9;
      case 'caveProps':
        return this.detailDistance * 0.82;
      case 'structures':
        // Buildings/wreck pieces have a much larger silhouette than grass or rocks.
        return Math.max(this.detailDistance * 1.3, this.detailDistance + 36);
      case 'vegetation':
      case 'rocks':
        return this.detailDistance;
      default:
        return Number.POSITIVE_INFINITY;
    }
  }

  private createContext(
    key: string,
    cx: number,
    cz: number,
    chunkSize: number,
    bounds: Box3,
    biome: BiomeConfig,
    origin: Vector3,
    populator: ContentPopulator,
    group: Group,
  ): ChunkContentContext {
    const density = this.density;
    const rng = new Rng(hashInts(this.worldSeed, cx, cz, stringHash(populator.id)));

    return {
      key,
      cx,
      cz,
      bounds,
      origin,
      biome,
      worldSeed: this.worldSeed,
      rng,
      group,

      seabedAt: (x, z) => density.seabedAt(x, z),
      densityAt: (x, y, z) => density.sample(x, y, z),

      sampleSeabedPoints(count, minNormalY = 0): SurfacePoint[] {
        const out: SurfacePoint[] = [];
        const attempts = count * 6;
        for (let i = 0; i < attempts && out.length < count; i++) {
          const x = origin.x + rng.float() * chunkSize;
          const z = origin.z + rng.float() * chunkSize;
          const h = density.seabedAt(x, z);
          const y = density.surfaceBelow(x, z, Math.min(0, h + 12), h - 30);
          if (y === null) continue;
          const e = 0.6;
          const nx = density.seabedAt(x - e, z) - density.seabedAt(x + e, z);
          const nz = density.seabedAt(x, z - e) - density.seabedAt(x, z + e);
          const normal = new Vector3(nx, 2 * e, nz).normalize();
          if (normal.y < minNormalY) continue;
          out.push({ position: new Vector3(x, y, z), normal, depth: -y });
        }
        return out;
      },

      sampleCavePoints(count): Vector3[] {
        const out: Vector3[] = [];
        const attempts = count * 20;
        for (let i = 0; i < attempts && out.length < count; i++) {
          const x = origin.x + rng.float() * chunkSize;
          const z = origin.z + rng.float() * chunkSize;
          const col = density.column(x, z);
          if (col.caves.length === 0) continue;
          const y = col.height - rng.range(3, biome.caves.maxDepthBelowSeabed);
          if (density.densityAt(x, y, z, col) < 0) out.push(new Vector3(x, y, z));
        }
        return out;
      },
    };
  }
}

function stringHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Frees the GPU resources of everything under `root`. */
export function disposeSubtree(root: Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as Object3D & {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (const m of mesh.material) m.dispose();
    } else {
      mesh.material?.dispose();
    }
  });
  root.removeFromParent();
}
