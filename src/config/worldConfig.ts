/**
 * Global world / engine configuration.
 *
 * NOTE: nothing here assumes a 400x400m world. `playableBounds` is only a
 * temporary limit on which chunks the streamer is allowed to create; set it to
 * `null` and the world extends indefinitely in every direction.
 */

export interface WorldConfig {
  /** Master seed. Every generator derives its own sub-seed from this. */
  seed: number;

  /** Chunk footprint in metres (square, XZ). */
  chunkSize: number;
  /** Voxel cells per chunk axis. Voxel size = chunkSize / chunkResolution. */
  chunkResolution: number;

  /** Vertical extent of the voxel volume, in metres. Water surface is y = 0. */
  worldMinY: number;
  worldMaxY: number;

  /**
   * Half-extent of the currently generated region, in chunks.
   * 3 -> 7x7 chunks -> 448 x 448 m with a 64 m chunk. `null` = unbounded.
   */
  playableBounds: { halfChunksX: number; halfChunksZ: number } | null;

  /** Chunks within this radius (in chunks) of the player are kept resident. */
  viewDistanceChunks: number;
  /** Extra hysteresis before a chunk outside the view radius is discarded. */
  unloadPaddingChunks: number;

  /** Max chunk meshes uploaded to the GPU per frame (avoids hitching). */
  maxChunkUploadsPerFrame: number;
  /** Terrain generation workers. 0 forces synchronous main-thread generation. */
  workerCount: number;

  /** Water surface height in metres. */
  seaLevel: number;

  /** Where the player is placed on load, before the seabed clamp. */
  spawn: { x: number; y: number; z: number };
}

export const DEFAULT_WORLD_CONFIG: WorldConfig = {
  seed: 1337,

  chunkSize: 64,
  chunkResolution: 32, // 2 m voxels

  worldMinY: -80,
  worldMaxY: 12,

  playableBounds: { halfChunksX: 3, halfChunksZ: 3 }, // 7x7 chunks = 448 m

  viewDistanceChunks: 3,
  unloadPaddingChunks: 1,

  maxChunkUploadsPerFrame: 1,
  workerCount: 3,

  seaLevel: 0,

  spawn: { x: 0, y: -6, z: 0 },
};

/** Voxel edge length in metres. */
export function voxelSize(config: WorldConfig): number {
  return config.chunkSize / config.chunkResolution;
}

/** Vertical voxel cell count. */
export function verticalCells(config: WorldConfig): number {
  return Math.round((config.worldMaxY - config.worldMinY) / voxelSize(config));
}

/** True when a chunk coordinate is inside the currently authored region. */
export function isChunkInBounds(config: WorldConfig, cx: number, cz: number): boolean {
  const b = config.playableBounds;
  if (!b) return true;
  return Math.abs(cx) <= b.halfChunksX && Math.abs(cz) <= b.halfChunksZ;
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

export function worldToChunk(config: WorldConfig, x: number, z: number): { cx: number; cz: number } {
  return {
    cx: Math.floor(x / config.chunkSize),
    cz: Math.floor(z / config.chunkSize),
  };
}
