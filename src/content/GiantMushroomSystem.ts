import { Box3, Group, Mesh, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const ASSET_URL = './assets/biomes/safe-shallows/giant_alien_mushroom_10m.glb';
const UP = new Vector3(0, 1, 0);

// Keep these as occasional landmarks rather than carpeting the biome. The second
// roll allows rare little pairs without turning every occupied chunk into a grove.
const CHUNK_SPAWN_CHANCE = 0.45;
const SECOND_MUSHROOM_CHANCE = 0.12;
const MIN_HEIGHT = 1;
const MAX_HEIGHT = 20;
const SURFACE_HEADROOM = 0.8;
const START_AREA_CLEAR_RADIUS = 20;
const START_AREA_CLEAR_RADIUS_SQ = START_AREA_CLEAR_RADIUS * START_AREA_CLEAR_RADIUS;
const RENDER_DISTANCE = 190;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;

interface MushroomPlacement {
  root: Group;
  position: Vector3;
  height: number;
}

/**
 * Sparse, highly size-varied giant alien mushrooms for the Safe Shallows.
 *
 * The supplied GLB is authored Z-up, so a wrapper rotates it into the game's
 * Y-up world once at load time. Per-chunk placement then reuses the same static
 * geometry/material resources through cheap scene clones; only transforms differ.
 */
export class GiantMushroomSystem implements ContentPopulator {
  readonly id = 'safe-shallows-giant-mushrooms-v1';
  readonly layer = 'vegetation' as const;
  readonly keepsEmptyGroup = true;
  readonly ready: Promise<void>;

  private readonly chunks = new Map<string, MushroomPlacement[]>();
  private template: Group | null = null;
  private authoredHeight = 1;
  private loadFailed = false;

  constructor(private readonly parent: Object3D) {
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return biome.id === 'SAFE_SHALLOWS' && biome.spawnDensity.vegetation > 0;
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);

      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
      });

      // This asset's raw stem grows along +Z. Keep the authored scene untouched
      // under a wrapper so any internal transforms/materials remain intact.
      const axisFix = new Group();
      axisFix.rotation.x = -Math.PI / 2;
      axisFix.add(gltf.scene);

      const template = new Group();
      template.name = 'flora:giant-alien-mushroom-template';
      template.add(axisFix);
      template.updateMatrixWorld(true);

      const bounds = new Box3().setFromObject(template);
      const height = bounds.max.y - bounds.min.y;
      if (!Number.isFinite(height) || height <= 0.001) {
        throw new Error('giant mushroom GLB has invalid bounds');
      }

      // Move the lowest authored point to local ground level after the axis fix.
      axisFix.position.y -= bounds.min.y;
      template.updateMatrixWorld(true);

      this.authoredHeight = height;
      this.template = template;

      console.info(
        `[flora] giant mushroom loaded: authored height ${height.toFixed(2)} m; ` +
          `scatter range ${MIN_HEIGHT}-${MAX_HEIGHT} m (depth capped)`,
      );
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[flora] failed to load giant mushroom at ${ASSET_URL}`, error);
    }
  }

  populate(ctx: ChunkContentContext): void {
    this.removeChunk(ctx.key);

    if (!this.template || this.loadFailed || ctx.rng.float() > CHUNK_SPAWN_CHANCE) {
      this.chunks.set(ctx.key, []);
      return;
    }

    const desiredCount = 1 + (ctx.rng.float() < SECOND_MUSHROOM_CHANCE ? 1 : 0);
    const candidates = ctx.sampleSeabedPoints(desiredCount * 10, 0.64);
    const placements: MushroomPlacement[] = [];

    for (const point of candidates) {
      if (placements.length >= desiredCount) break;

      const originDistanceSq =
        point.position.x * point.position.x + point.position.z * point.position.z;
      if (originDistanceSq < START_AREA_CLEAR_RADIUS_SQ) continue;

      const maximumFittingHeight = Math.min(MAX_HEIGHT, point.depth - SURFACE_HEADROOM);
      if (maximumFittingHeight < MIN_HEIGHT) continue;

      // Bias toward smaller/medium specimens, while still allowing occasional
      // 15-20 m hero mushrooms in sufficiently deep water.
      const requestedHeight =
        MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.pow(ctx.rng.float(), 1.35);
      const height = Math.min(requestedHeight, maximumFittingHeight);
      const scale = height / this.authoredHeight;

      const root = new Group();
      root.name = `flora:giant-mushroom:${ctx.key}:${placements.length}`;
      root.position.copy(point.position).addScaledVector(point.normal, -Math.min(0.35, height * 0.018));
      root.quaternion.setFromUnitVectors(UP, point.normal);
      root.rotateY(ctx.rng.range(0, Math.PI * 2));

      const visual = this.template.clone(true);
      visual.scale.setScalar(scale);
      root.add(visual);
      root.visible = false;
      this.parent.add(root);

      placements.push({
        root,
        position: root.position.clone(),
        height,
      });
    }

    this.chunks.set(ctx.key, placements);
  }

  update(_dt: number, playerPosition: Vector3): void {
    if (this.loadFailed) return;

    for (const placements of this.chunks.values()) {
      for (const placement of placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        placement.root.visible = dx * dx + dz * dz <= RENDER_DISTANCE_SQ;
      }
    }
  }

  dispose(key: string): void {
    this.removeChunk(key);
  }

  private removeChunk(key: string): void {
    const placements = this.chunks.get(key);
    if (!placements) return;

    for (const placement of placements) placement.root.removeFromParent();
    this.chunks.delete(key);
  }
}
