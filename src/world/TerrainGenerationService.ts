/**
 * Chunk generation front-end.
 *
 * Hands chunk requests to a small pool of workers, nearest-first, and falls
 * back to synchronous main-thread generation when workers are unavailable
 * (older browsers, file:// loads, workerCount = 0).
 */

import type { ChunkGeometryRequest, ChunkGeometryResult } from './chunkGeometry.ts';
import { ChunkMesher } from './chunkGeometry.ts';
import { DensityField } from './density.ts';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type {
  WorkerInMessage,
  WorkerOutMessage,
  WorkerResultMessage,
} from './workers/terrainWorker.ts';

interface Job {
  jobId: number;
  request: ChunkGeometryRequest;
  /** Lower is generated first. */
  priority: number;
  resolve: (result: ChunkGeometryResult) => void;
  cancelled: boolean;
}

export class TerrainGenerationService {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<number, Job>();
  private readonly fallbackMesher: ChunkMesher | null = null;
  private nextJobId = 1;

  /** Rolling average of worker-side generation time, for the debug HUD. */
  lastGenerateMs = 0;
  totalGenerated = 0;

  constructor(
    private readonly seed: number,
    biomes: BiomeRegistry,
    density: DensityField,
    workerCount: number,
  ) {
    if (workerCount > 0 && typeof Worker !== 'undefined') {
      for (let i = 0; i < workerCount; i++) {
        try {
          const worker = new Worker(new URL('./workers/terrainWorker.ts', import.meta.url), {
            type: 'module',
            name: `terrain-${i}`,
          });
          worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => this.onMessage(worker, e.data);
          const init: WorkerInMessage = {
            type: 'init',
            seed,
            biomes: biomes.list(),
            defaultBiomeId: biomes.biomeAt(0, 0).id,
          };
          worker.postMessage(init);
          this.workers.push(worker);
        } catch (err) {
          console.warn('[terrain] worker unavailable, falling back to main thread', err);
          break;
        }
      }
    }

    if (this.workers.length === 0) {
      this.fallbackMesher = new ChunkMesher(density, seed);
    }
  }

  get usingWorkers(): boolean {
    return this.workers.length > 0;
  }

  get pending(): number {
    return this.queue.length + this.inFlight.size;
  }

  /** Queues a chunk. `priority` is usually the squared distance to the player. */
  request(request: ChunkGeometryRequest, priority: number): Promise<ChunkGeometryResult> {
    return new Promise((resolve) => {
      const job: Job = { jobId: this.nextJobId++, request, priority, resolve, cancelled: false };
      this.queue.push(job);
      this.pump();
    });
  }

  /** Drops any queued (not yet started) job for a chunk. */
  cancel(cx: number, cz: number): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const job = this.queue[i];
      if (job.request.cx === cx && job.request.cz === cz) {
        job.cancelled = true;
        this.queue.splice(i, 1);
      }
    }
  }

  /** Re-prioritises the queue - called when the player moves between chunks. */
  reprioritise(score: (cx: number, cz: number) => number): void {
    for (const job of this.queue) {
      job.priority = score(job.request.cx, job.request.cz);
    }
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
    this.inFlight.clear();
  }

  private pump(): void {
    if (this.queue.length === 0) return;

    if (!this.usingWorkers) {
      // Synchronous fallback: one chunk per call so the caller keeps control
      // of how much time is spent per frame.
      const job = this.takeNext();
      if (!job || !this.fallbackMesher) return;
      const result = this.fallbackMesher.generate(job.request);
      this.lastGenerateMs = result.generateMs;
      this.totalGenerated++;
      job.resolve(result);
      return;
    }

    while (this.idle.length > 0 && this.queue.length > 0) {
      const job = this.takeNext();
      if (!job) break;
      const worker = this.idle.pop()!;
      this.inFlight.set(job.jobId, job);
      const msg: WorkerInMessage = { type: 'generate', jobId: job.jobId, request: job.request };
      worker.postMessage(msg);
    }
  }

  private takeNext(): Job | undefined {
    let bestIndex = -1;
    let best = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < best) {
        best = this.queue[i].priority;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) return undefined;
    return this.queue.splice(bestIndex, 1)[0];
  }

  private onMessage(worker: Worker, msg: WorkerOutMessage): void {
    if (msg.type === 'ready') {
      this.idle.push(worker);
      this.pump();
      return;
    }

    const result = msg as WorkerResultMessage;
    const job = this.inFlight.get(result.jobId);
    this.inFlight.delete(result.jobId);
    this.idle.push(worker);
    this.lastGenerateMs = result.generateMs;
    this.totalGenerated++;

    if (job && !job.cancelled) {
      job.resolve({
        cx: result.cx,
        cz: result.cz,
        positions: result.positions,
        normals: result.normals,
        colors: result.colors,
        indices: result.indices,
        min: result.min,
        max: result.max,
        generateMs: result.generateMs,
      });
    }
    this.pump();
  }

  /** Drives the synchronous fallback. No-op when workers are in use. */
  step(): void {
    if (!this.usingWorkers) this.pump();
  }

  get seedValue(): number {
    return this.seed;
  }
}
