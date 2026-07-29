import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  Scene,
  Sphere,
  Vector3,
} from 'three';
import {
  chunkKey,
  isChunkInBounds,
  worldToChunk,
  type WorldConfig,
} from '../config/worldConfig.ts';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { DensityField } from './density.ts';
import type { ChunkGeometryResult } from './chunkGeometry.ts';
import { TerrainGenerationService } from './TerrainGenerationService.ts';
import { ChunkCollider } from '../physics/ChunkCollider.ts';
import type { CollisionWorld } from '../physics/CollisionWorld.ts';
import { ContentRegistry, disposeSubtree } from '../content/ContentRegistry.ts';

type ChunkState = 'pending' | 'ready';

export interface Chunk {
  key: string;
  cx: number;
  cz: number;
  state: ChunkState;
  mesh: Mesh | null;
  content: Group | null;
  bounds: Box3;
}

export interface ChunkManagerStats {
  loaded: number;
  pending: number;
  queued: number;
  triangles: number;
  colliderBytes: number;
  lastGenerateMs: number;
  usingWorkers: boolean;
}

/**
 * Streams terrain chunks around the player.
 *
 * Responsibilities are deliberately narrow: decide *which* chunks should
 * exist, hand generation off to the service, and wire each finished chunk into
 * the scene, the collision world and the content registry. Terrain shape lives
 * in the density field; nothing about chunk size or world extent is baked in
 * here beyond what the config says.
 */
export class ChunkManager {
  readonly root = new Group();
  private readonly chunks = new Map<string, Chunk>();
  /** Finished results waiting for a frame with upload budget left. */
  private readonly uploadQueue: ChunkGeometryResult[] = [];

  private lastCenter = { cx: Number.NaN, cz: Number.NaN };
  private readonly service: TerrainGenerationService;

  /** Emitted the first time every chunk in the initial view radius is ready. */
  private initialTarget = 0;
  private initialDone = false;
  onInitialLoad: (() => void) | null = null;
  onProgress: ((loaded: number, total: number) => void) | null = null;

  constructor(
    private readonly config: WorldConfig,
    private readonly biomes: BiomeRegistry,
    density: DensityField,
    private readonly material: Material,
    private readonly collision: CollisionWorld,
    private readonly content: ContentRegistry,
    scene: Scene,
  ) {
    this.root.name = 'terrain';
    // Chunk meshes are static; skipping the per-frame matrix update on the
    // parent is free performance.
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);

    this.service = new TerrainGenerationService(config.seed, biomes, density, config.workerCount);
  }

  get stats(): ChunkManagerStats {
    let triangles = 0;
    let pending = 0;
    for (const chunk of this.chunks.values()) {
      if (chunk.state === 'pending') pending++;
      const geo = chunk.mesh?.geometry;
      const index = geo?.getIndex();
      if (index) triangles += index.count / 3;
    }
    return {
      loaded: this.chunks.size - pending,
      pending,
      queued: this.service.pending,
      triangles,
      colliderBytes: this.collision.byteSize,
      lastGenerateMs: this.service.lastGenerateMs,
      usingWorkers: this.service.usingWorkers,
    };
  }

  /** Chunk coordinate containing a world position. */
  chunkAt(x: number, z: number): { cx: number; cz: number } {
    return worldToChunk(this.config, x, z);
  }

  /**
   * Requests the chunks around `position` and retires the ones that are far
   * enough away. Call once per frame - it is cheap when nothing changed.
   */
  update(position: Vector3, uploadBudget = this.config.maxChunkUploadsPerFrame): void {
    const { cx, cz } = worldToChunk(this.config, position.x, position.z);

    if (cx !== this.lastCenter.cx || cz !== this.lastCenter.cz) {
      this.lastCenter = { cx, cz };
      this.requestAround(cx, cz);
      this.retireDistant(cx, cz);
      this.service.reprioritise((qx, qz) => (qx - cx) ** 2 + (qz - cz) ** 2);
    }

    // Synchronous fallback path needs an explicit nudge each frame.
    if (!this.service.usingWorkers && this.uploadQueue.length === 0) this.service.step();

    let uploads = 0;
    while (this.uploadQueue.length > 0 && uploads < uploadBudget) {
      const result = this.uploadQueue.shift()!;
      this.commit(result);
      uploads++;
    }
  }

  /**
   * Generates everything inside the view radius up front, awaiting completion.
   * Used for the loading screen so the player never spawns into empty water.
   */
  async preload(position: Vector3): Promise<void> {
    const { cx, cz } = worldToChunk(this.config, position.x, position.z);
    this.lastCenter = { cx, cz };
    this.requestAround(cx, cz);

    while (this.chunks.size > 0 && this.countPending() > 0) {
      if (!this.service.usingWorkers) this.service.step();
      // Drain uploads as they land so progress is visible.
      while (this.uploadQueue.length > 0) this.commit(this.uploadQueue.shift()!);
      await new Promise((r) => setTimeout(r, 4));
    }
    while (this.uploadQueue.length > 0) this.commit(this.uploadQueue.shift()!);
  }

  private countPending(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) if (chunk.state === 'pending') n++;
    return n;
  }

  private requestAround(cx: number, cz: number): void {
    const r = this.config.viewDistanceChunks;
    const wanted: { x: number; z: number; d2: number }[] = [];

    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const z = cz + dz;
        const d2 = dx * dx + dz * dz;
        if (d2 > (r + 0.5) * (r + 0.5)) continue; // round view volume
        if (!isChunkInBounds(this.config, x, z)) continue;
        if (this.chunks.has(chunkKey(x, z))) continue;
        wanted.push({ x, z, d2 });
      }
    }

    wanted.sort((a, b) => a.d2 - b.d2);
    if (!this.initialDone) this.initialTarget = wanted.length;

    for (const { x, z, d2 } of wanted) {
      const key = chunkKey(x, z);
      const chunk: Chunk = {
        key,
        cx: x,
        cz: z,
        state: 'pending',
        mesh: null,
        content: null,
        bounds: new Box3(),
      };
      this.chunks.set(key, chunk);

      void this.service
        .request(
          {
            cx: x,
            cz: z,
            chunkSize: this.config.chunkSize,
            resolution: this.config.chunkResolution,
            worldMinY: this.config.worldMinY,
            worldMaxY: this.config.worldMaxY,
          },
          d2,
        )
        .then((result) => {
          // The chunk may have been retired while it was generating.
          if (this.chunks.get(key) !== chunk) return;
          this.uploadQueue.push(result);
        });
    }
  }

  private retireDistant(cx: number, cz: number): void {
    const limit = this.config.viewDistanceChunks + this.config.unloadPaddingChunks;
    const limitSq = limit * limit;
    for (const [key, chunk] of this.chunks) {
      const d2 = (chunk.cx - cx) ** 2 + (chunk.cz - cz) ** 2;
      if (d2 <= limitSq) continue;
      this.unload(key, chunk);
    }
    // Anything still queued but now out of range is pointless work.
    for (const result of this.uploadQueue.splice(0)) {
      const d2 = (result.cx - cx) ** 2 + (result.cz - cz) ** 2;
      if (d2 <= limitSq && this.chunks.has(chunkKey(result.cx, result.cz))) {
        this.uploadQueue.push(result);
      }
    }
  }

  private unload(key: string, chunk: Chunk): void {
    this.chunks.delete(key);
    this.service.cancel(chunk.cx, chunk.cz);
    this.collision.remove(key);
    this.content.release(key, chunk.content);
    if (chunk.mesh) {
      this.root.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
  }

  private commit(result: ChunkGeometryResult): void {
    const key = chunkKey(result.cx, result.cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return;

    const originX = result.cx * this.config.chunkSize;
    const originZ = result.cz * this.config.chunkSize;

    if (result.indices.length > 0) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(result.positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(result.normals, 3));
      geometry.setAttribute('color', new BufferAttribute(result.colors, 3));
      geometry.setIndex(new BufferAttribute(result.indices, 1));

      // Explicit bounds: cheaper than computeBoundingBox and needed for
      // three's automatic frustum culling to work per chunk.
      geometry.boundingBox = new Box3(
        new Vector3(result.min[0], result.min[1], result.min[2]),
        new Vector3(result.max[0], result.max[1], result.max[2]),
      );
      geometry.boundingSphere = new Sphere();
      geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);

      const mesh = new Mesh(geometry, this.material);
      mesh.name = `chunk:${key}`;
      mesh.position.set(originX, 0, originZ);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      this.root.add(mesh);
      chunk.mesh = mesh;

      chunk.bounds.set(
        new Vector3(result.min[0] + originX, result.min[1], result.min[2] + originZ),
        new Vector3(result.max[0] + originX, result.max[1], result.max[2] + originZ),
      );

      this.collision.add(
        key,
        new ChunkCollider(
          originX,
          originZ,
          result.positions,
          result.indices,
          result.min,
          result.max,
        ),
      );

      chunk.content = this.content.populate(
        key,
        result.cx,
        result.cz,
        this.config.chunkSize,
        chunk.bounds,
        this.biomes.biomeAt(originX + this.config.chunkSize / 2, originZ + this.config.chunkSize / 2),
      );
      if (chunk.content) this.root.add(chunk.content);
    }

    chunk.state = 'ready';

    if (!this.initialDone) {
      const ready = this.chunks.size - this.countPending();
      this.onProgress?.(ready, Math.max(1, this.initialTarget));
      if (this.countPending() === 0) {
        this.initialDone = true;
        this.onInitialLoad?.();
      }
    }
  }

  dispose(): void {
    for (const [key, chunk] of this.chunks) this.unload(key, chunk);
    disposeSubtree(this.root);
    this.service.dispose();
  }
}
