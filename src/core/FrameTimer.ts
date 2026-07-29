/**
 * Minimal frame timer.
 *
 * three.js deprecated `Clock`, and its replacement lives in the addons bundle;
 * this is the ten lines of it the game actually needs, with the delta already
 * clamped so a stalled frame (tab restore, chunk hitch, headset resume) can
 * never teleport the player.
 */
export class FrameTimer {
  private last = 0;
  private started = false;

  /** Seconds since start. */
  elapsed = 0;
  /** Clamped seconds since the previous frame. */
  delta = 0;
  /** Unclamped, for diagnostics. */
  rawDelta = 0;

  constructor(private readonly maxDelta = 0.1) {}

  start(): void {
    this.last = now();
    this.started = true;
  }

  tick(): number {
    const t = now();
    if (!this.started) {
      this.start();
      this.delta = 0;
      this.rawDelta = 0;
      return 0;
    }
    this.rawDelta = (t - this.last) / 1000;
    this.last = t;
    this.delta = Math.min(this.rawDelta, this.maxDelta);
    this.elapsed += this.delta;
    return this.delta;
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
