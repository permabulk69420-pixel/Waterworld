/// <reference lib="webworker" />
/**
 * Terrain generation worker.
 *
 * Chunk meshing costs 10-30ms; doing it on the render thread would drop frames
 * every time a chunk streams in. The worker owns its own DensityField, built
 * from the same seed and the same serialised biome data as the main thread, so
 * its output is identical to what the main thread would have produced.
 */

import { DensityField } from '../density.ts';
import { ChunkMesher, type ChunkGeometryRequest } from '../chunkGeometry.ts';
import { BiomeRegistry } from '../../config/biomes/index.ts';
import type { BiomeConfig } from '../../config/biomes/types.ts';

export interface WorkerInitMessage {
  type: 'init';
  seed: number;
  biomes: BiomeConfig[];
  defaultBiomeId: string;
}

export interface WorkerGenerateMessage {
  type: 'generate';
  jobId: number;
  request: ChunkGeometryRequest;
}

export type WorkerInMessage = WorkerInitMessage | WorkerGenerateMessage;

export interface WorkerResultMessage {
  type: 'result';
  jobId: number;
  cx: number;
  cz: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
  generateMs: number;
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export type WorkerOutMessage = WorkerResultMessage | WorkerReadyMessage;

let mesher: ChunkMesher | null = null;

self.onmessage = (event: MessageEvent<WorkerInMessage>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    const registry = new BiomeRegistry(msg.biomes, msg.defaultBiomeId);
    const density = new DensityField(msg.seed, registry);
    mesher = new ChunkMesher(density, msg.seed);
    const ready: WorkerReadyMessage = { type: 'ready' };
    self.postMessage(ready);
    return;
  }

  if (msg.type === 'generate') {
    if (!mesher) throw new Error('terrain worker used before init');
    const r = mesher.generate(msg.request);
    const result: WorkerResultMessage = {
      type: 'result',
      jobId: msg.jobId,
      cx: r.cx,
      cz: r.cz,
      positions: r.positions,
      normals: r.normals,
      colors: r.colors,
      indices: r.indices,
      min: r.min,
      max: r.max,
      generateMs: r.generateMs,
    };
    self.postMessage(result, [
      r.positions.buffer,
      r.normals.buffer,
      r.colors.buffer,
      r.indices.buffer,
    ]);
  }
};
