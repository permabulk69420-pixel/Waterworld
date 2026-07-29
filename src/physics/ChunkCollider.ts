import { Box3, Vector3 } from 'three';

/**
 * Static triangle collider for one terrain chunk.
 *
 * The terrain mesh *is* the collider - there is no second representation to
 * drift out of sync, which is what makes cave walls and overhangs collide
 * correctly for free. Broadphase is a uniform grid; at ~3k triangles per chunk
 * a capsule query touches a couple of dozen of them.
 */
export class ChunkCollider {
  readonly bounds = new Box3();

  private readonly positions: Float32Array;
  private readonly indices: Uint32Array;
  private readonly originX: number;
  private readonly originZ: number;

  private readonly cellSize: number;
  private readonly dims = new Vector3();
  private readonly gridMin = new Vector3();
  /** Prefix-sum offsets into `entries`, one per cell plus a terminator. */
  private readonly cellStart: Int32Array;
  private readonly entries: Int32Array;

  /** Per-triangle stamp so a query never returns the same triangle twice. */
  private readonly stamp: Int32Array;
  private queryId = 0;

  readonly triangleCount: number;

  constructor(
    originX: number,
    originZ: number,
    positions: Float32Array,
    indices: Uint32Array,
    localMin: [number, number, number],
    localMax: [number, number, number],
    cellSize = 4,
  ) {
    this.positions = positions;
    this.indices = indices;
    this.originX = originX;
    this.originZ = originZ;
    this.cellSize = cellSize;
    this.triangleCount = indices.length / 3;

    this.bounds.min.set(localMin[0] + originX, localMin[1], localMin[2] + originZ);
    this.bounds.max.set(localMax[0] + originX, localMax[1], localMax[2] + originZ);

    this.gridMin.copy(this.bounds.min).addScalar(-0.001);
    const size = new Vector3().subVectors(this.bounds.max, this.gridMin);
    this.dims.set(
      Math.max(1, Math.ceil(size.x / cellSize)),
      Math.max(1, Math.ceil(size.y / cellSize)),
      Math.max(1, Math.ceil(size.z / cellSize)),
    );

    const cellCount = this.dims.x * this.dims.y * this.dims.z;
    const counts = new Int32Array(cellCount);

    // Pass 1: count triangle/cell incidences.
    let total = 0;
    total = this.forEachTriangleCell(counts, null);

    // Prefix sum.
    this.cellStart = new Int32Array(cellCount + 1);
    let acc = 0;
    for (let i = 0; i < cellCount; i++) {
      this.cellStart[i] = acc;
      acc += counts[i];
    }
    this.cellStart[cellCount] = acc;

    // Pass 2: fill.
    this.entries = new Int32Array(total);
    const cursor = new Int32Array(cellCount);
    this.forEachTriangleCell(cursor, this.entries);

    this.stamp = new Int32Array(this.triangleCount);
  }

  /**
   * Shared body of the two build passes. When `entries` is null it only counts;
   * otherwise `cursor` holds the per-cell write offset.
   */
  private forEachTriangleCell(counter: Int32Array, entries: Int32Array | null): number {
    const { positions, indices, cellSize } = this;
    const dx = this.dims.x;
    const dy = this.dims.y;
    const dz = this.dims.z;
    let total = 0;

    for (let t = 0; t < this.triangleCount; t++) {
      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;

      for (let v = 0; v < 3; v++) {
        const p = indices[t * 3 + v] * 3;
        const x = positions[p] + this.originX;
        const y = positions[p + 1];
        const z = positions[p + 2] + this.originZ;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }

      const i0 = clampInt((minX - this.gridMin.x) / cellSize, dx);
      const i1 = clampInt((maxX - this.gridMin.x) / cellSize, dx);
      const j0 = clampInt((minY - this.gridMin.y) / cellSize, dy);
      const j1 = clampInt((maxY - this.gridMin.y) / cellSize, dy);
      const k0 = clampInt((minZ - this.gridMin.z) / cellSize, dz);
      const k1 = clampInt((maxZ - this.gridMin.z) / cellSize, dz);

      for (let k = k0; k <= k1; k++) {
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const cell = (k * dy + j) * dx + i;
            if (entries === null) {
              counter[cell]++;
              total++;
            } else {
              entries[this.cellStart[cell] + counter[cell]++] = t;
            }
          }
        }
      }
    }

    return total;
  }

  /** Appends the triangle indices overlapping `box` to `out`. */
  queryBox(box: Box3, out: number[]): void {
    if (!this.bounds.intersectsBox(box)) return;

    const dx = this.dims.x;
    const dy = this.dims.y;
    const dz = this.dims.z;
    const cs = this.cellSize;

    const i0 = clampInt((box.min.x - this.gridMin.x) / cs, dx);
    const i1 = clampInt((box.max.x - this.gridMin.x) / cs, dx);
    const j0 = clampInt((box.min.y - this.gridMin.y) / cs, dy);
    const j1 = clampInt((box.max.y - this.gridMin.y) / cs, dy);
    const k0 = clampInt((box.min.z - this.gridMin.z) / cs, dz);
    const k1 = clampInt((box.max.z - this.gridMin.z) / cs, dz);

    const id = ++this.queryId;
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cell = (k * dy + j) * dx + i;
          const start = this.cellStart[cell];
          const end = this.cellStart[cell + 1];
          for (let e = start; e < end; e++) {
            const tri = this.entries[e];
            if (this.stamp[tri] === id) continue;
            this.stamp[tri] = id;
            out.push(tri);
          }
        }
      }
    }
  }

  /** Writes triangle `t`'s world-space vertices. */
  getTriangle(t: number, a: Vector3, b: Vector3, c: Vector3): void {
    const { positions, indices, originX, originZ } = this;
    const ia = indices[t * 3] * 3;
    const ib = indices[t * 3 + 1] * 3;
    const ic = indices[t * 3 + 2] * 3;
    a.set(positions[ia] + originX, positions[ia + 1], positions[ia + 2] + originZ);
    b.set(positions[ib] + originX, positions[ib + 1], positions[ib + 2] + originZ);
    c.set(positions[ic] + originX, positions[ic + 1], positions[ic + 2] + originZ);
  }

  /** Approximate memory footprint in bytes, for the debug HUD. */
  get byteSize(): number {
    return (
      this.positions.byteLength +
      this.indices.byteLength +
      this.cellStart.byteLength +
      this.entries.byteLength +
      this.stamp.byteLength
    );
  }
}

function clampInt(v: number, max: number): number {
  const i = Math.floor(v);
  return i < 0 ? 0 : i >= max ? max - 1 : i;
}
