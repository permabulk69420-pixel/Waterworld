/**
 * Chunk meshing - naive surface nets over the density field.
 *
 * Why surface nets rather than marching cubes: it produces smoother terrain
 * from the same voxel budget, emits an indexed mesh (fewer vertices), needs no
 * 256-entry lookup tables, and is naturally watertight - which matters because
 * the same triangles are used for collision.
 *
 * Seam handling: chunks sample two extra rings of density beyond their own
 * footprint, but a quad is only emitted by the chunk that owns the *sample* at
 * the base of its edge (local sample index 0..R-1). Global samples partition
 * exactly between chunks, so neighbouring chunks produce no gaps and no
 * overlapping geometry. Vertex normals come from the density gradient, which
 * is a pure function of world position, so shading is continuous across the
 * border too.
 *
 * This module is imported by the terrain worker AND by the main thread
 * fallback AND by the Node verification script - it must stay free of any
 * three.js / DOM dependency.
 */

import { DensityField, type Column } from './density.ts';
import { Noise } from '../math/noise.ts';
import { deriveSeed } from '../math/rng.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';

export interface ChunkGeometryRequest {
  cx: number;
  cz: number;
  chunkSize: number;
  /** Voxel cells per horizontal chunk axis. */
  resolution: number;
  worldMinY: number;
  worldMaxY: number;
}

export interface ChunkGeometryResult {
  cx: number;
  cz: number;
  /** Vertex positions, local to the chunk origin (cx*size, 0, cz*size). */
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Local-space bounds, for the bounding box / sphere. */
  min: [number, number, number];
  max: [number, number, number];
  generateMs: number;
}

/** Circular ordering of the 4 cells around an axis-aligned edge, per axis. */
const QUAD_CELL_OFFSETS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  // +x edge: circulate in the (y,z) plane
  [
    [0, -1, -1],
    [0, 0, -1],
    [0, 0, 0],
    [0, -1, 0],
  ],
  // +y edge: circulate in the (z,x) plane
  [
    [-1, 0, -1],
    [-1, 0, 0],
    [0, 0, 0],
    [0, 0, -1],
  ],
  // +z edge: circulate in the (x,y) plane
  [
    [-1, -1, 0],
    [0, -1, 0],
    [0, 0, 0],
    [-1, 0, 0],
  ],
];

/** The 12 cube edges as pairs of corner indices (corner = dx + 2*dy + 4*dz). */
const CUBE_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/**
 * Reusable scratch buffers. One instance per worker / per main thread, so a
 * long streaming session does not churn the GC.
 */
export class ChunkMesher {
  private readonly density: DensityField;
  private readonly tintNoise: Noise;

  private samples: Float32Array = new Float32Array(0);
  private cellVertex: Int32Array = new Int32Array(0);
  private cellPos: Float32Array = new Float32Array(0);
  private cellNormal: Float32Array = new Float32Array(0);

  private positions = new Float32Array(3 * 4096);
  private normals = new Float32Array(3 * 4096);
  private colors = new Float32Array(3 * 4096);
  private indices = new Uint32Array(6 * 4096);
  private vertexCount = 0;
  private indexCount = 0;

  private layout = { sx: 0, sy: 0, sz: 0, cx: 0, cy: 0, cz: 0, res: 0 };
  private column: Column | undefined;
  private originX = 0;
  private originZ = 0;

  constructor(density: DensityField, seed: number) {
    this.density = density;
    this.tintNoise = new Noise(deriveSeed(seed, 'tint'));
  }

  generate(req: ChunkGeometryRequest): ChunkGeometryResult {
    const t0 = now();
    const R = req.resolution;
    const vs = req.chunkSize / R;
    const H = Math.round((req.worldMaxY - req.worldMinY) / vs);

    // Sample grid: local sample index -2 .. R+2 horizontally, 0 .. H vertically.
    const sx = R + 5;
    const sy = H + 1;
    const sz = R + 5;
    // Cell grid: local cell index -1 .. R horizontally, 0 .. H-1 vertically.
    const cxCount = R + 2;
    const cyCount = H;
    const czCount = R + 2;

    this.layout = { sx, sy, sz, cx: cxCount, cy: cyCount, cz: czCount, res: R };

    if (this.samples.length < sx * sy * sz) this.samples = new Float32Array(sx * sy * sz);
    const cellTotal = cxCount * cyCount * czCount;
    if (this.cellVertex.length < cellTotal) {
      this.cellVertex = new Int32Array(cellTotal);
      this.cellPos = new Float32Array(cellTotal * 3);
      this.cellNormal = new Float32Array(cellTotal * 3);
    }
    this.cellVertex.fill(-1, 0, cellTotal);

    this.vertexCount = 0;
    this.indexCount = 0;

    this.originX = req.cx * req.chunkSize;
    this.originZ = req.cz * req.chunkSize;

    this.sampleDensity(this.originX, this.originZ, req.worldMinY, vs, sx, sy, sz);
    this.buildCellVertices(vs, req.worldMinY, sy, cxCount, cyCount, czCount);
    this.emitQuads(R, H);

    const positions = this.positions.slice(0, this.vertexCount * 3);
    const normals = this.normals.slice(0, this.vertexCount * 3);
    const colors = this.colors.slice(0, this.vertexCount * 3);
    const indices = this.indices.slice(0, this.indexCount);

    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    if (this.vertexCount === 0) {
      min[0] = min[1] = min[2] = 0;
      max[0] = max[1] = max[2] = 0;
    }

    return {
      cx: req.cx,
      cz: req.cz,
      positions,
      normals,
      colors,
      indices,
      min,
      max,
      generateMs: now() - t0,
    };
  }

  // --- stage 1: sample the density field -----------------------------------

  private sampleDensity(
    originX: number,
    originZ: number,
    minY: number,
    vs: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    const samples = this.samples;
    for (let iz = 0; iz < sz; iz++) {
      const wz = originZ + (iz - 2) * vs;
      for (let ix = 0; ix < sx; ix++) {
        const wx = originX + (ix - 2) * vs;
        // One column of 2D work, reused for the whole vertical span.
        this.column = this.density.column(wx, wz, this.column);
        const col = this.column;
        const base = (iz * sx + ix) * sy;
        for (let iy = 0; iy < sy; iy++) {
          samples[base + iy] = this.density.densityAt(wx, minY + iy * vs, wz, col);
        }
      }
    }
  }

  private sampleIndex(ix: number, iy: number, iz: number): number {
    const { sx, sy } = this.layout;
    return (iz * sx + ix) * sy + iy;
  }

  // --- stage 2: one vertex per cell that straddles the isosurface -----------

  private buildCellVertices(
    vs: number,
    minY: number,
    sy: number,
    cxCount: number,
    cyCount: number,
    czCount: number,
  ): void {
    const samples = this.samples;
    const corner = new Float64Array(8);
    const grad = new Float64Array(24);

    for (let cz = 0; cz < czCount; cz++) {
      // Cell local index -1..R maps to array index 0..R+1; the sample at the
      // cell's low corner is local index cz-1 -> array index cz+1.
      const sz0 = cz + 1;
      for (let cx = 0; cx < cxCount; cx++) {
        const sx0 = cx + 1;
        for (let cy = 0; cy < cyCount; cy++) {
          const sy0 = cy;

          let neg = 0;
          for (let k = 0; k < 8; k++) {
            const dx = k & 1;
            const dy = (k >> 1) & 1;
            const dz = (k >> 2) & 1;
            const d = samples[this.sampleIndex(sx0 + dx, sy0 + dy, sz0 + dz)];
            corner[k] = d;
            if (d < 0) neg++;
          }
          if (neg === 0 || neg === 8) continue;

          // Average of the zero crossings on the 12 cube edges.
          let ax = 0;
          let ay = 0;
          let az = 0;
          let crossings = 0;
          for (let e = 0; e < 12; e++) {
            const a = CUBE_EDGES[e][0];
            const b = CUBE_EDGES[e][1];
            const da = corner[a];
            const db = corner[b];
            if (da < 0 === db < 0) continue;
            const t = da / (da - db);
            const ax0 = a & 1;
            const ay0 = (a >> 1) & 1;
            const az0 = (a >> 2) & 1;
            const bx0 = b & 1;
            const by0 = (b >> 1) & 1;
            const bz0 = (b >> 2) & 1;
            ax += ax0 + (bx0 - ax0) * t;
            ay += ay0 + (by0 - ay0) * t;
            az += az0 + (bz0 - az0) * t;
            crossings++;
          }
          if (crossings === 0) continue;
          ax /= crossings;
          ay /= crossings;
          az /= crossings;

          // Gradient at each corner (central differences on the sample grid),
          // trilinearly interpolated to the vertex.
          for (let k = 0; k < 8; k++) {
            const dx = k & 1;
            const dy = (k >> 1) & 1;
            const dz = (k >> 2) & 1;
            const px = sx0 + dx;
            const py = sy0 + dy;
            const pz = sz0 + dz;
            const yPrev = py > 0 ? py - 1 : py;
            const yNext = py < sy - 1 ? py + 1 : py;
            grad[k * 3] =
              samples[this.sampleIndex(px - 1, py, pz)] -
              samples[this.sampleIndex(px + 1, py, pz)];
            grad[k * 3 + 1] =
              samples[this.sampleIndex(px, yPrev, pz)] - samples[this.sampleIndex(px, yNext, pz)];
            grad[k * 3 + 2] =
              samples[this.sampleIndex(px, py, pz - 1)] -
              samples[this.sampleIndex(px, py, pz + 1)];
          }

          let nx = 0;
          let ny = 0;
          let nz = 0;
          for (let k = 0; k < 8; k++) {
            const dx = k & 1;
            const dy = (k >> 1) & 1;
            const dz = (k >> 2) & 1;
            const w =
              (dx ? ax : 1 - ax) * (dy ? ay : 1 - ay) * (dz ? az : 1 - az);
            nx += grad[k * 3] * w;
            ny += grad[k * 3 + 1] * w;
            nz += grad[k * 3 + 2] * w;
          }
          const len = Math.hypot(nx, ny, nz) || 1;

          const ci = (cz * cxCount + cx) * cyCount + cy;
          this.cellVertex[ci] = -2; // marker: has a vertex, not yet emitted
          this.cellPos[ci * 3] = (cx - 1 + ax) * vs;
          this.cellPos[ci * 3 + 1] = minY + (cy + ay) * vs;
          this.cellPos[ci * 3 + 2] = (cz - 1 + az) * vs;
          this.cellNormal[ci * 3] = nx / len;
          this.cellNormal[ci * 3 + 1] = ny / len;
          this.cellNormal[ci * 3 + 2] = nz / len;
        }
      }
    }
  }

  // --- stage 3: emit the quads this chunk owns -----------------------------

  private emitQuads(R: number, H: number): void {
    const samples = this.samples;

    // Only samples with local index 0..R-1 are owned by this chunk, which makes
    // the global partition exact.
    for (let k = 0; k < R; k++) {
      const sk = k + 2;
      for (let i = 0; i < R; i++) {
        const si = i + 2;
        for (let j = 1; j < H; j++) {
          const d0 = samples[this.sampleIndex(si, j, sk)];
          const solid0 = d0 >= 0;

          for (let axis = 0; axis < 3; axis++) {
            const nix = si + (axis === 0 ? 1 : 0);
            const niy = j + (axis === 1 ? 1 : 0);
            const niz = sk + (axis === 2 ? 1 : 0);
            const d1 = samples[this.sampleIndex(nix, niy, niz)];
            const solid1 = d1 >= 0;
            if (solid0 === solid1) continue;

            const offsets = QUAD_CELL_OFFSETS[axis];
            let v0 = -1;
            let v1 = -1;
            let v2 = -1;
            let v3 = -1;
            for (let q = 0; q < 4; q++) {
              const o = offsets[q];
              const idx = this.resolveVertex(i + o[0], j + o[1], k + o[2]);
              if (idx < 0) {
                v0 = -1;
                break;
              }
              if (q === 0) v0 = idx;
              else if (q === 1) v1 = idx;
              else if (q === 2) v2 = idx;
              else v3 = idx;
            }
            if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;

            // Front face points from solid toward water.
            if (solid0) this.pushQuad(v0, v1, v2, v3);
            else this.pushQuad(v0, v3, v2, v1);
          }
        }
      }
    }
  }

  /**
   * Maps a cell (local cell coordinates, x/z in -1..R, y in 0..H-1) to an
   * output vertex index, appending the vertex on first use so unreferenced
   * boundary cells cost nothing.
   */
  private resolveVertex(cellX: number, cellY: number, cellZ: number): number {
    const { cx: cxCount, cy: cyCount, cz: czCount } = this.layout;
    const ax = cellX + 1;
    const az = cellZ + 1;
    if (ax < 0 || ax >= cxCount || az < 0 || az >= czCount) return -1;
    if (cellY < 0 || cellY >= cyCount) return -1;

    const ci = (az * cxCount + ax) * cyCount + cellY;
    const existing = this.cellVertex[ci];
    if (existing >= 0) return existing;
    if (existing === -1) return -1; // no isosurface in this cell

    const v = this.vertexCount++;
    this.ensureVertexCapacity(this.vertexCount);
    const px = this.cellPos[ci * 3];
    const py = this.cellPos[ci * 3 + 1];
    const pz = this.cellPos[ci * 3 + 2];
    const nx = this.cellNormal[ci * 3];
    const ny = this.cellNormal[ci * 3 + 1];
    const nz = this.cellNormal[ci * 3 + 2];

    this.positions[v * 3] = px;
    this.positions[v * 3 + 1] = py;
    this.positions[v * 3 + 2] = pz;
    this.normals[v * 3] = nx;
    this.normals[v * 3 + 1] = ny;
    this.normals[v * 3 + 2] = nz;
    this.writeColor(v, px, py, pz, ny);

    this.cellVertex[ci] = v;
    return v;
  }

  /**
   * Neutral debug shading: sediment on flat ground, exposed rock on steep
   * faces, gently darker with depth. Deliberately not an art pass - it exists
   * so terrain shape reads clearly in an otherwise empty world.
   */
  private writeColor(v: number, lx: number, y: number, lz: number, normalY: number): void {
    const wx = this.originX + lx;
    const wz = this.originZ + lz;
    const vis = this.density.visualsAt(wx, wz);
    const depthT = saturate((-y - 4) / 46);
    const slopeT = smoothstep(0.82, 0.42, Math.abs(normalY));

    let r = lerpChannel(vis.shallow[0], vis.deep[0], depthT);
    let g = lerpChannel(vis.shallow[1], vis.deep[1], depthT);
    let b = lerpChannel(vis.shallow[2], vis.deep[2], depthT);

    r = r + (vis.slope[0] - r) * slopeT;
    g = g + (vis.slope[1] - g) * slopeT;
    b = b + (vis.slope[2] - b) * slopeT;

    // Low frequency mottling so large flat areas are not perfectly uniform.
    const m = 1 + this.tintNoise.fbm2(wx / 17, wz / 17, 2) * 0.11;
    this.colors[v * 3] = srgbToLinear(saturate(r * m));
    this.colors[v * 3 + 1] = srgbToLinear(saturate(g * m));
    this.colors[v * 3 + 2] = srgbToLinear(saturate(b * m));
  }

  private pushQuad(a: number, b: number, c: number, d: number): void {
    this.ensureIndexCapacity(this.indexCount + 6);
    const idx = this.indices;
    let n = this.indexCount;
    idx[n++] = a;
    idx[n++] = b;
    idx[n++] = c;
    idx[n++] = a;
    idx[n++] = c;
    idx[n++] = d;
    this.indexCount = n;
  }

  private ensureVertexCapacity(count: number): void {
    if (count * 3 <= this.positions.length) return;
    let cap = this.positions.length / 3;
    while (cap < count) cap *= 2;
    this.positions = growFloat(this.positions, cap * 3);
    this.normals = growFloat(this.normals, cap * 3);
    this.colors = growFloat(this.colors, cap * 3);
  }

  private ensureIndexCapacity(count: number): void {
    if (count <= this.indices.length) return;
    let cap = this.indices.length;
    while (cap < count) cap *= 2;
    const next = new Uint32Array(cap);
    next.set(this.indices);
    this.indices = next;
  }
}

function growFloat(src: Float32Array, size: number): Float32Array<ArrayBuffer> {
  const next = new Float32Array(size);
  next.set(src);
  return next;
}

function lerpChannel(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** three.js works in linear space; biome colours are authored in sRGB. */
function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
