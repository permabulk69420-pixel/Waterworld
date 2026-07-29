/**
 * Debug HUD (DOM).
 *
 * Visible on desktop only - DOM overlays are not composited into an immersive
 * WebXR session, which is exactly why the in-headset panel exists separately.
 * Off by default; F3 toggles it.
 */

export interface DebugStats {
  fps: number;
  frameMs: number;
  position: { x: number; y: number; z: number };
  depth: number;
  biome: string;
  chunk: { cx: number; cz: number };
  chunksLoaded: number;
  chunksPending: number;
  chunksQueued: number;
  triangles: number;
  drawCalls: number;
  generateMs: number;
  workers: boolean;
  speed: number;
  contacts: number;
  colliderMb: number;
  underwater: boolean;
  mode: string;
}

export class DebugHud {
  private readonly element: HTMLElement;
  private visible = false;
  private accumulator = 0;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.element.classList.toggle('visible', visible);
  }

  /** Throttled to ~8Hz: text layout is not free and the numbers do not need it. */
  update(dt: number, stats: DebugStats): void {
    if (!this.visible) return;
    this.accumulator += dt;
    if (this.accumulator < 0.12) return;
    this.accumulator = 0;
    this.element.textContent = formatStats(stats);
  }
}

export function formatStats(s: DebugStats): string {
  const p = s.position;
  return [
    `${s.fps.toFixed(0)} fps   ${s.frameMs.toFixed(1)} ms   [${s.mode}]`,
    `pos    ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`,
    `depth  ${s.depth.toFixed(1)} m   ${s.underwater ? 'submerged' : 'surface'}`,
    `biome  ${s.biome}`,
    `chunk  ${s.chunk.cx}, ${s.chunk.cz}`,
    `chunks ${s.chunksLoaded} loaded  ${s.chunksPending} pending  ${s.chunksQueued} queued`,
    `mesh   ${s.triangles.toLocaleString()} tris   ${s.drawCalls} draws`,
    `gen    ${s.generateMs.toFixed(1)} ms/chunk (${s.workers ? 'workers' : 'main thread'})`,
    `move   ${s.speed.toFixed(2)} m/s   ${s.contacts} contacts`,
    `phys   ${s.colliderMb.toFixed(1)} MB colliders`,
  ].join('\n');
}
