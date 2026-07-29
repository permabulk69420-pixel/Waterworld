/**
 * Deterministic terrain landmarks.
 *
 * These are *terrain*, not props: each landmark contributes to the density
 * field, so it is meshed and collided exactly like the seabed around it. They
 * exist to make an empty world worth exploring - a handful of memorable
 * silhouettes plus, in the case of arches, genuine overhangs.
 */

import { Rng, hashInts } from '../math/rng.ts';
import { smoothMax, smoothMin } from '../math/mathUtils.ts';
import type { LandmarkParams } from '../config/biomes/types.ts';

export type LandmarkKind = 'pinnacle' | 'arch' | 'sinkhole' | 'mound';

export interface Landmark {
  kind: LandmarkKind;
  x: number;
  z: number;
  /** Seabed height at the landmark centre. */
  baseY: number;
  /** Horizontal radius of influence, in metres. */
  radius: number;
  /** Highest y this landmark can add solid material at. */
  topY: number;
  /** Lowest y this landmark can modify. */
  bottomY: number;
  /** Primary vertical size. */
  height: number;
  /** Secondary size (tube radius / rim radius depending on kind). */
  thickness: number;
  /** Yaw in radians, for the oriented kinds. */
  yaw: number;
}

const KINDS: LandmarkKind[] = ['pinnacle', 'arch', 'sinkhole', 'mound'];

/**
 * Places and caches landmarks on a coarse grid. Purely a function of
 * (seed, cell), so any chunk touching a landmark reproduces it identically.
 */
export class LandmarkField {
  private readonly cache = new Map<string, Landmark | null>();

  constructor(
    private readonly seed: number,
    private readonly heightAt: (x: number, z: number) => number,
  ) {}

  /** All landmarks whose influence radius may cover (x,z). */
  near(x: number, z: number, params: LandmarkParams, out: Landmark[]): Landmark[] {
    out.length = 0;
    const cs = params.cellSize;
    const ci = Math.floor(x / cs);
    const cj = Math.floor(z / cs);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const lm = this.cell(i, j, params);
        if (!lm) continue;
        const dx = x - lm.x;
        const dz = z - lm.z;
        if (dx * dx + dz * dz <= lm.radius * lm.radius) out.push(lm);
      }
    }
    return out;
  }

  private cell(i: number, j: number, params: LandmarkParams): Landmark | null {
    const key = `${i},${j}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const lm = this.build(i, j, params);
    this.cache.set(key, lm);
    return lm;
  }

  private build(i: number, j: number, params: LandmarkParams): Landmark | null {
    const rng = new Rng(hashInts(this.seed, i, j, 0x1a2d));
    if (!rng.chance(params.frequency)) return null;

    const cs = params.cellSize;
    // Keep landmarks away from the cell edge so the 3x3 neighbour scan is enough.
    const x = (i + 0.2 + rng.float() * 0.6) * cs;
    const z = (j + 0.2 + rng.float() * 0.6) * cs;
    const baseY = this.heightAt(x, z);
    const kind = weightedKind(rng, params);

    switch (kind) {
      case 'pinnacle': {
        const height = rng.range(16, 30);
        const thickness = rng.range(4, 8);
        return {
          kind,
          x,
          z,
          baseY,
          radius: thickness * 2.6,
          height,
          thickness,
          yaw: rng.range(0, Math.PI * 2),
          topY: baseY + height + 3,
          bottomY: baseY - height * 0.6,
        };
      }
      case 'arch': {
        const height = rng.range(11, 19); // span radius
        const thickness = rng.range(3, 5.5);
        return {
          kind,
          x,
          z,
          baseY,
          radius: height + thickness * 2.2,
          height,
          thickness,
          yaw: rng.range(0, Math.PI * 2),
          topY: baseY + height + thickness + 3,
          bottomY: baseY - thickness * 2 - 4,
        };
      }
      case 'sinkhole': {
        const radius = rng.range(14, 24);
        const height = rng.range(9, 16); // carve depth
        return {
          kind,
          x,
          z,
          baseY,
          radius: radius * 1.5,
          height,
          thickness: radius,
          yaw: 0,
          topY: baseY + 5,
          bottomY: baseY - height - 8,
        };
      }
      default: {
        const radius = rng.range(16, 30);
        const height = rng.range(7, 14);
        return {
          kind: 'mound',
          x,
          z,
          baseY,
          radius,
          height,
          thickness: radius,
          yaw: 0,
          topY: baseY + height + 3,
          bottomY: baseY - height,
        };
      }
    }
  }
}

function weightedKind(rng: Rng, params: LandmarkParams): LandmarkKind {
  const w = params.weights;
  const total = w.pinnacle + w.arch + w.sinkhole + w.mound;
  let r = rng.float() * total;
  for (const kind of KINDS) {
    r -= w[kind];
    if (r <= 0) return kind;
  }
  return 'mound';
}

/**
 * Applies a landmark to a density sample.
 *
 * Convention: density > 0 is solid, and it is expressed in "metres of
 * material" so the surface nets interpolation stays well behaved.
 */
export function applyLandmark(density: number, lm: Landmark, x: number, y: number, z: number): number {
  const dx = x - lm.x;
  const dz = z - lm.z;

  switch (lm.kind) {
    case 'pinnacle': {
      const r = Math.hypot(dx, dz);
      const t = (y - lm.baseY + 4) / (lm.height + 4); // 0 at foot, 1 at tip
      if (t > 1.05) return density;
      // Tapered, slightly flared column.
      const radiusAtY = lm.thickness * (1.25 - 0.95 * Math.max(0, t)) * (1 + 0.12 * Math.sin(t * 9));
      const solid = radiusAtY - r;
      const capped = Math.min(solid, (lm.baseY + lm.height - y) * 1.4);
      return smoothMax(density, capped, 3);
    }

    case 'arch': {
      // Half torus standing on the seabed: a true overhang you can swim under.
      const c = Math.cos(-lm.yaw);
      const s = Math.sin(-lm.yaw);
      const u = dx * c - dz * s;
      const v = dx * s + dz * c;
      const w = Math.max(0, y - lm.baseY + 1.5);
      const ring = Math.hypot(u, w) - lm.height;
      const solid = lm.thickness - Math.hypot(ring, v);
      return smoothMax(density, solid, 2.5);
    }

    case 'sinkhole': {
      // Bowl carved into the seabed with a modest raised rim.
      const r = Math.hypot(dx, dz);
      const bowlCentreY = lm.baseY + lm.height * 0.55;
      const dy = (y - bowlCentreY) * 1.05;
      const carve = lm.thickness - Math.hypot(r, dy);
      let d = smoothMin(density, -carve, 3);
      const rimDist = Math.hypot(r - lm.thickness * 1.05, y - lm.baseY - 1.5);
      d = smoothMax(d, 3.2 - rimDist, 2.5);
      return d;
    }

    default: {
      // Broad ellipsoidal mound.
      const r = Math.hypot(dx, dz) / lm.radius;
      const dy = (y - lm.baseY + lm.height * 0.35) / lm.height;
      const solid = (1 - Math.hypot(r, dy)) * Math.min(lm.radius, lm.height) * 0.9;
      return smoothMax(density, solid, 3.5);
    }
  }
}
