/**
 * Deterministic hashing / PRNG helpers.
 *
 * Everything in the world generator must be reproducible from
 * (worldSeed, coordinates) alone - never from call order or wall clock.
 */

/** 32-bit integer hash (variant of Thomas Wang / murmur finaliser). */
export function hashU32(x: number): number {
  let h = x | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash an arbitrary number of integer components together with a seed. */
export function hashInts(seed: number, ...values: number[]): number {
  let h = hashU32(seed);
  for (let i = 0; i < values.length; i++) {
    h = hashU32((h ^ Math.imul(values[i] | 0, 0x9e3779b1)) >>> 0);
  }
  return h >>> 0;
}

/** Deterministic float in [0,1) from a seed + integer coordinates. */
export function hashFloat(seed: number, ...values: number[]): number {
  return hashInts(seed, ...values) / 4294967296;
}

/** Small fast PRNG. Same seed -> same sequence, on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience wrapper around {@link mulberry32} with a few shaped helpers. */
export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed >>> 0);
  }

  /** [0,1) */
  float(): number {
    return this.next();
  }

  /** [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min,max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }
}

/** Derive a stable child seed from a parent seed and a string tag. */
export function deriveSeed(seed: number, tag: string): number {
  let h = hashU32(seed);
  for (let i = 0; i < tag.length; i++) {
    h = hashU32((h ^ tag.charCodeAt(i)) >>> 0);
  }
  return h >>> 0;
}
