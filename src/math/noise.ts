/**
 * Seeded gradient (Perlin-style) noise, 2D and 3D, plus the fBm / ridged
 * variants the terrain generator is built from.
 *
 * Zero dependencies on purpose: this module is imported by the main thread,
 * by the terrain web worker, and by the Node verification script.
 */

import { hashU32 } from './rng.ts';

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Noise {
  /** 512-entry doubled permutation table. */
  private readonly perm: Uint8Array;

  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    // Deterministic Fisher-Yates driven by the seed hash.
    let h = hashU32(seed);
    for (let i = 255; i > 0; i--) {
      h = hashU32(h);
      const j = h % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }

    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Gradient noise in roughly [-1,1]. */
  noise2(x: number, y: number): number {
    const perm = this.perm;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;

    const u = fade(xf);
    const v = fade(yf);

    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];

    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 1.4142;
  }

  /** Gradient noise in roughly [-1,1]. */
  noise3(x: number, y: number, z: number): number {
    const perm = this.perm;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const a = perm[X] + Y;
    const aa = perm[a] + Z;
    const ab = perm[a + 1] + Z;
    const b = perm[X + 1] + Y;
    const ba = perm[b] + Z;
    const bb = perm[b + 1] + Z;

    const x1 = lerp(grad3(perm[aa], xf, yf, zf), grad3(perm[ba], xf - 1, yf, zf), u);
    const x2 = lerp(grad3(perm[ab], xf, yf - 1, zf), grad3(perm[bb], xf - 1, yf - 1, zf), u);
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(grad3(perm[aa + 1], xf, yf, zf - 1), grad3(perm[ba + 1], xf - 1, yf, zf - 1), u);
    const x4 = lerp(
      grad3(perm[ab + 1], xf, yf - 1, zf - 1),
      grad3(perm[bb + 1], xf - 1, yf - 1, zf - 1),
      u,
    );
    const y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w) * 1.1547;
  }

  /** Fractal brownian motion, 2D. Result is normalised to roughly [-1,1]. */
  fbm2(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Fractal brownian motion, 3D. */
  fbm3(x: number, y: number, z: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal, 2D. Returns [0,1] with sharp crests at 1 - the
   * classic building block for underwater ridges.
   */
  ridged2(x: number, y: number, octaves: number, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

function grad2(hash: number, x: number, y: number): number {
  const h = (hash & 7) * 3;
  return GRAD3[h] * x + GRAD3[h + 1] * y;
}

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = (hash % 12) * 3;
  return GRAD3[h] * x + GRAD3[h + 1] * y + GRAD3[h + 2] * z;
}
