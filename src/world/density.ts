/**
 * The density field - the single source of truth for the shape of the world.
 *
 * Sign convention: density > 0 is solid rock, density < 0 is water, and the
 * isosurface at 0 is the seabed. The value is roughly "metres of material",
 * which keeps the surface-nets edge interpolation well conditioned.
 *
 * Everything is a pure function of (worldSeed, world position, biome params).
 * No call ordering, no mutable state that affects output, no dependency on
 * chunk size - so a chunk regenerates identically whenever and wherever it is
 * requested, including inside a worker.
 */

import { Noise } from '../math/noise.ts';
import { deriveSeed } from '../math/rng.ts';
import { clamp, lerp, saturate, smoothMax, smoothMin, smoothstep } from '../math/mathUtils.ts';
import type { BiomeConfig } from '../config/biomes/types.ts';
import { BiomeRegistry } from '../config/biomes/index.ts';
import { CaveField, type CaveSystem } from './caves.ts';
import { LandmarkField, applyLandmark, type Landmark } from './landmarks.ts';

/**
 * Per-column cached data. The expensive 2D work (seabed height, cave/landmark
 * lookups) happens once per (x,z) and is reused for every y sample in that
 * column - which is where most of the generation budget is saved.
 */
export interface Column {
  x: number;
  z: number;
  biome: BiomeConfig;
  /** Seabed height before 3D warping, caves and landmarks. */
  height: number;
  /** Highest y at which anything solid can exist in this column. */
  topY: number;
  /** Lowest y at which anything non-solid can exist in this column. */
  bottomY: number;
  /** 0..1 strength of the overhang warp here. */
  overhang: number;
  caves: CaveSystem[];
  landmarks: Landmark[];
}

export class DensityField {
  private readonly base: Noise;
  private readonly detail: Noise;
  private readonly ridge: Noise;
  private readonly mask: Noise;
  private readonly warp: Noise;

  readonly caveField: CaveField;
  readonly landmarkField: LandmarkField;

  constructor(
    readonly seed: number,
    private readonly biomes: BiomeRegistry,
  ) {
    this.base = new Noise(deriveSeed(seed, 'base'));
    this.detail = new Noise(deriveSeed(seed, 'detail'));
    this.ridge = new Noise(deriveSeed(seed, 'ridge'));
    this.mask = new Noise(deriveSeed(seed, 'mask'));
    this.warp = new Noise(deriveSeed(seed, 'warp'));

    // Cave and landmark placement needs the raw seabed height, which must not
    // itself depend on caves or landmarks - hence the bound method here.
    const h = (x: number, z: number) => this.seabedHeight(x, z, this.biomes.biomeAt(x, z));
    this.caveField = new CaveField(deriveSeed(seed, 'caves'), h);
    this.landmarkField = new LandmarkField(deriveSeed(seed, 'landmarks'), h);
  }

  /**
   * Raw seabed height (world y, negative below sea level), ignoring caves,
   * overhangs and landmarks. Useful on its own for placement queries.
   */
  seabedHeight(x: number, z: number, biome: BiomeConfig): number {
    const t = biome.terrain;

    // Broad rolling seabed.
    const fx = x / t.featureScale;
    const fz = z / t.featureScale;
    let h = -t.baseDepth + this.base.fbm2(fx, fz, 4) * t.heightVariation;

    // Shelves / plateaus - terraced in patches, giving flat seabed areas
    // separated by short steps.
    const shelfMask = saturate(this.mask.noise2(x / 260 + 11.3, z / 260 - 7.1) * 0.5 + 0.5);
    const shelfWeight = t.shelfAmount * smoothstep(0.35, 0.75, shelfMask);
    if (shelfWeight > 0.001) {
      const s = h / t.shelfStep;
      const fl = Math.floor(s);
      const terraced = (fl + smoothstep(0.32, 0.68, s - fl)) * t.shelfStep;
      h = lerp(h, terraced, shelfWeight);
    }

    // Ridges, restricted to bands so they read as features rather than noise.
    if (t.ridgeStrength > 0) {
      const ridgeMask = smoothstep(
        0.1,
        0.55,
        this.mask.noise2(x / 340 - 4.7, z / 340 + 9.2) * 0.5 + 0.5,
      );
      if (ridgeMask > 0.001) {
        const r = this.ridge.ridged2(x / t.ridgeScale, z / t.ridgeScale, 3);
        h += (r - 0.45) * 2 * t.ridgeStrength * ridgeMask * 11;
      }
    }

    // Small valleys - inverted ridges at a shorter wavelength.
    const valleyMask = smoothstep(
      0.2,
      0.65,
      this.mask.noise2(x / 200 + 51.9, z / 200 + 23.4) * 0.5 + 0.5,
    );
    if (valleyMask > 0.001) {
      const v = this.ridge.ridged2(x / 74 + 100.5, z / 74 - 60.25, 2);
      h -= v * valleyMask * 6;
    }

    // Basins / depressions - the deeper pockets in an otherwise shallow biome.
    // `basinFrequency` lowers the threshold the basin noise has to clear, so a
    // biome can go from "a couple of pockets" to "mostly trench" from data.
    if (t.basinFrequency > 0) {
      const b = this.base.fbm2(x / t.basinScale + 300.1, z / t.basinScale - 210.7, 2);
      const threshold = 0.34 - t.basinFrequency * 0.85;
      const basin = smoothstep(threshold, threshold + 0.17, b);
      if (basin > 0) h -= basin * t.basinDepth;
    }

    // Fine detail.
    h += this.detail.fbm2(x / t.detailScale, z / t.detailScale, 3) * t.roughness * 4.5;

    // Soft depth limits so the biome stays inside its declared range without
    // hard creases at the clamp.
    h = smoothMin(h, -t.minDepth, 2.5);
    h = smoothMax(h, -t.maxDepth, 3);
    return h;
  }

  /** Builds (or refreshes) the cached column data for a world XZ position. */
  column(x: number, z: number, out?: Column): Column {
    // Biome blending for future border regions would happen here: sample the
    // registry, then lerp the TerrainParams before evaluating the height.
    const biome = this.biomes.biomeAt(x, z);
    const height = this.seabedHeight(x, z, biome);
    const t = biome.terrain;

    const col: Column =
      out ??
      ({
        x,
        z,
        biome,
        height,
        topY: 0,
        bottomY: 0,
        overhang: 0,
        caves: [],
        landmarks: [],
      } as Column);

    col.x = x;
    col.z = z;
    col.biome = biome;
    col.height = height;

    // Overhang zones: only a fraction of the biome warps enough to fold over.
    const om = this.mask.noise2(x / 150 - 88.2, z / 150 + 34.6) * 0.5 + 0.5;
    col.overhang = smoothstep(1 - t.overhangCoverage, 1 - t.overhangCoverage * 0.35, om);

    this.caveField.near(x, z, biome.caves, col.caves);
    this.landmarkField.near(x, z, biome.landmarks, col.landmarks);

    const warpAmp = t.overhangStrength * col.overhang;
    let topY = height + warpAmp + 2;
    let bottomY = height - warpAmp - 2;

    if (col.caves.length > 0) {
      bottomY = Math.min(bottomY, this.caveField.floorFor(height, biome.caves) - 4);
    }
    for (let i = 0; i < col.landmarks.length; i++) {
      topY = Math.max(topY, col.landmarks[i].topY);
      bottomY = Math.min(bottomY, col.landmarks[i].bottomY);
    }

    col.topY = topY;
    col.bottomY = bottomY;
    return col;
  }

  /**
   * Density at a point. Pass the matching column to avoid redoing the 2D work.
   * Returns > 0 inside terrain.
   */
  densityAt(x: number, y: number, z: number, col: Column): number {
    // Outside the column's active band the answer is trivially known, which is
    // what makes full-height chunks affordable.
    if (y > col.topY) return -20;
    if (y < col.bottomY) return 20;

    const t = col.biome.terrain;
    let d = col.height - y;

    // 3D warp -> overhangs and undercut rock faces.
    if (col.overhang > 0.001) {
      const near = smoothstep(14, 3, Math.abs(col.height - y));
      if (near > 0.001) {
        const w = this.warp.fbm3(x / 34, y / 15, z / 34, 2);
        d += w * t.overhangStrength * col.overhang * near;
      }
    }

    for (let i = 0; i < col.landmarks.length; i++) {
      d = applyLandmark(d, col.landmarks[i], x, y, z);
    }

    if (col.caves.length > 0) {
      const carve = this.caveField.carveAmount(x, y, z, col.height, col.caves, col.biome.caves);
      if (carve > 0.002) {
        d = smoothMin(d, (0.42 - carve) * 48, 2.5);
      }
    }

    return d;
  }

  /** Convenience single-shot sample (allocates a column - avoid in hot loops). */
  sample(x: number, y: number, z: number): number {
    return this.densityAt(x, y, z, this.column(x, z));
  }

  /**
   * Finds the water/seabed interface directly below a point by bisection.
   * Used for spawn placement and by content-placement helpers.
   * Returns null when the column is solid or empty over the whole range.
   */
  surfaceBelow(x: number, z: number, fromY: number, toY: number, steps = 48): number | null {
    const col = this.column(x, z);
    let prevY = fromY;
    if (this.densityAt(x, fromY, z, col) > 0) return null; // starting inside rock

    const step = (fromY - toY) / steps;
    for (let i = 1; i <= steps; i++) {
      const y = fromY - i * step;
      const d = this.densityAt(x, y, z, col);
      if (d > 0) {
        // Bisect for a tighter hit.
        let lo = y;
        let hi = prevY;
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          if (this.densityAt(x, mid, z, col) > 0) lo = mid;
          else hi = mid;
        }
        return (lo + hi) * 0.5;
      }
      prevY = y;
    }
    return null;
  }

  /**
   * First open water at or above `fromY` in this column, or null if the
   * column is solid for the whole search range. Used by the stuck-recovery
   * guard, which needs somewhere safe to lift a buried player to.
   */
  firstOpenAbove(x: number, y: number, z: number, maxRise = 50, step = 0.5): number | null {
    const col = this.column(x, z);
    for (let h = 0; h <= maxRise; h += step) {
      const sampleY = y + h;
      if (this.densityAt(x, sampleY, z, col) < 0) {
        // Climb a little further so the whole capsule clears the surface.
        return sampleY;
      }
    }
    return null;
  }

  /** Clamped helper used by the debug HUD and spawn logic. */
  seabedAt(x: number, z: number): number {
    return clamp(this.seabedHeight(x, z, this.biomes.biomeAt(x, z)), -1000, 1000);
  }

  /**
   * Terrain vertex-colour palette for a world position, as linear-friendly
   * 0..1 sRGB triples. Cached per biome - this runs once per terrain vertex.
   */
  visualsAt(x: number, z: number): TerrainPalette {
    const biome = this.biomes.biomeAt(x, z);
    let palette = this.paletteCache.get(biome.id);
    if (!palette) {
      palette = {
        shallow: unpackColor(biome.visuals.terrainShallowColor),
        deep: unpackColor(biome.visuals.terrainDeepColor),
        slope: unpackColor(biome.visuals.terrainSlopeColor),
      };
      this.paletteCache.set(biome.id, palette);
    }
    return palette;
  }

  private readonly paletteCache = new Map<string, TerrainPalette>();
}

export interface TerrainPalette {
  shallow: [number, number, number];
  deep: [number, number, number];
  slope: [number, number, number];
}

function unpackColor(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
