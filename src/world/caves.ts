/**
 * Cave systems.
 *
 * Caves are carved out of the same density field as the seabed, so they are
 * part of the terrain mesh and part of the terrain collider - there is no
 * separate "cave level geometry" to keep in sync.
 *
 * A system is a deterministic point on a coarse grid with a radius of
 * influence. Inside it, material is removed where two ridged noise fields are
 * simultaneously near zero. The intersection of two such fields naturally
 * produces branching tubes rather than blobs, and where a tube happens to run
 * close to the seabed it breaks the surface and becomes an entrance.
 * A few spherical chambers are carved along the way to give the systems
 * somewhere to open out.
 */

import { Noise } from '../math/noise.ts';
import { Rng, hashInts } from '../math/rng.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';
import type { CaveParams } from '../config/biomes/types.ts';

export interface Chamber {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface CaveSystem {
  x: number;
  z: number;
  radius: number;
  /** Seabed height at the system centre. */
  seabedY: number;
  chambers: Chamber[];
}

export class CaveField {
  private readonly cache = new Map<string, CaveSystem | null>();
  private readonly noiseA: Noise;
  private readonly noiseB: Noise;

  constructor(
    private readonly seed: number,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.noiseA = new Noise(seed ^ 0x5eed01);
    this.noiseB = new Noise(seed ^ 0x5eed02);
  }

  /** Systems whose influence may cover (x,z). */
  near(x: number, z: number, params: CaveParams, out: CaveSystem[]): CaveSystem[] {
    out.length = 0;
    const cs = params.cellSize;
    const ci = Math.floor(x / cs);
    const cj = Math.floor(z / cs);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const sys = this.cell(i, j, params);
        if (!sys) continue;
        const dx = x - sys.x;
        const dz = z - sys.z;
        if (dx * dx + dz * dz <= sys.radius * sys.radius) out.push(sys);
      }
    }
    return out;
  }

  /**
   * 0..1 amount of material to remove at a point.
   * `seabedY` is the local seabed height, used to keep caves underground and
   * to let them breach the surface at entrances.
   */
  carveAmount(
    x: number,
    y: number,
    z: number,
    seabedY: number,
    systems: readonly CaveSystem[],
    params: CaveParams,
  ): number {
    if (systems.length === 0) return 0;

    // Vertical band: from just above the seabed (entrances) down to the
    // system's maximum depth.
    const floorY = seabedY - params.maxDepthBelowSeabed;
    const vertical =
      smoothstep(floorY, floorY + 7, y) * smoothstep(seabedY + 2.5, seabedY - 3.5, y);
    if (vertical <= 0) return 0;

    let best = 0;

    for (let i = 0; i < systems.length; i++) {
      const sys = systems[i];
      const dx = x - sys.x;
      const dz = z - sys.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= sys.radius) continue;

      const falloff = smoothstep(sys.radius, sys.radius * 0.5, dist);
      if (falloff <= 0) continue;

      // Tube field: both ridged fields near zero => we are on a tunnel axis.
      const fs = 1 / params.tunnelScale;
      const nx = x * fs;
      const ny = y * fs * 2.1; // squash vertically -> flatter, more walkable tunnels
      const nz = z * fs;
      const a = Math.abs(this.noiseA.noise3(nx, ny, nz));
      const b = Math.abs(this.noiseB.noise3(nx + 31.7, ny - 12.3, nz + 57.1));
      const m = Math.max(a, b);
      const tw = params.tunnelWidth;
      let amount = smoothstep(tw, tw * 0.3, m) * falloff * vertical;

      // Chambers - always fully open, so systems have somewhere to widen out.
      for (let c = 0; c < sys.chambers.length; c++) {
        const ch = sys.chambers[c];
        const cd = Math.hypot(x - ch.x, y - ch.y, z - ch.z);
        if (cd < ch.r) {
          amount = Math.max(amount, smoothstep(ch.r, ch.r * 0.72, cd));
        }
      }

      if (amount > best) best = amount;
      if (best >= 1) break;
    }

    return saturate(best);
  }

  /** Lowest y any cave in this biome can reach below the given seabed height. */
  floorFor(seabedY: number, params: CaveParams): number {
    return seabedY - params.maxDepthBelowSeabed;
  }

  private cell(i: number, j: number, params: CaveParams): CaveSystem | null {
    const key = `${i},${j}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const sys = this.build(i, j, params);
    this.cache.set(key, sys);
    return sys;
  }

  private build(i: number, j: number, params: CaveParams): CaveSystem | null {
    const rng = new Rng(hashInts(this.seed, i, j, 0xca7e));
    if (!rng.chance(params.frequency)) return null;

    const cs = params.cellSize;
    const x = (i + 0.25 + rng.float() * 0.5) * cs;
    const z = (j + 0.25 + rng.float() * 0.5) * cs;
    const radius = rng.range(params.systemRadius[0], params.systemRadius[1]);
    const seabedY = this.heightAt(x, z);

    const count = rng.int(params.chambersPerSystem[0], params.chambersPerSystem[1]);
    const chambers: Chamber[] = [];
    for (let c = 0; c < count; c++) {
      const ang = rng.range(0, Math.PI * 2);
      const rad = rng.range(0, radius * 0.6);
      const cx = x + Math.cos(ang) * rad;
      const cz = z + Math.sin(ang) * rad;
      const localSeabed = this.heightAt(cx, cz);
      const r = rng.range(params.chamberRadius[0], params.chamberRadius[1]);
      // Keep the chamber roof under the seabed so chambers do not blow the
      // seafloor open; entrances come from the tunnels instead.
      const maxOffset = Math.max(2.5, params.maxDepthBelowSeabed - r - 2);
      const cy = localSeabed - r - rng.range(2, maxOffset);
      chambers.push({ x: cx, y: cy, z: cz, r });
    }

    return { x, z, radius, seabedY, chambers };
  }
}
