/**
 * Headless world generation checks. Run with `npm run verify`.
 *
 * These are cheap sanity checks on the parts of the engine that have no
 * dependency on WebGL, so terrain regressions surface without a headset.
 */

import { DEFAULT_WORLD_CONFIG, verticalCells, voxelSize } from '../src/config/worldConfig.ts';
import { createDefaultBiomeRegistry, SAFE_SHALLOWS } from '../src/config/biomes/index.ts';
import { DensityField } from '../src/world/density.ts';
import { ChunkMesher } from '../src/world/chunkGeometry.ts';
import { ChunkCollider } from '../src/physics/ChunkCollider.ts';
import { CollisionWorld } from '../src/physics/CollisionWorld.ts';
import { DEFAULT_PLAYER_CONFIG } from '../src/player/playerConfig.ts';
import { PlayerRig } from '../src/player/PlayerRig.ts';
import { Locomotion } from '../src/player/Locomotion.ts';
import { createMoveIntent } from '../src/player/inputTypes.ts';
import { PerspectiveCamera, Vector3, type WebGLRenderer } from 'three';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok   ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const config = DEFAULT_WORLD_CONFIG;
const biomes = createDefaultBiomeRegistry();
const density = new DensityField(config.seed, biomes);
const mesher = new ChunkMesher(density, config.seed);

const req = (cx: number, cz: number) => ({
  cx,
  cz,
  chunkSize: config.chunkSize,
  resolution: config.chunkResolution,
  worldMinY: config.worldMinY,
  worldMaxY: config.worldMaxY,
});

console.log('\nworld config');
console.log(
  `  chunk ${config.chunkSize}m @ ${config.chunkResolution} cells -> ${voxelSize(config)}m voxels, ` +
    `${verticalCells(config)} vertical cells`,
);

// --- 1. seabed depth distribution ----------------------------------------
console.log('\nseabed');
{
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let samples = 0;
  let inTypicalBand = 0;
  let deepPockets = 0;
  const half = 224;
  for (let x = -half; x <= half; x += 4) {
    for (let z = -half; z <= half; z += 4) {
      const h = density.seabedHeight(x, z, SAFE_SHALLOWS);
      const depth = -h;
      min = Math.min(min, depth);
      max = Math.max(max, depth);
      sum += depth;
      samples++;
      if (depth >= 5 && depth <= 30) inTypicalBand++;
      if (depth >= 35) deepPockets++;
    }
  }
  const mean = sum / samples;
  console.log(
    `  depth min ${min.toFixed(1)}m  mean ${mean.toFixed(1)}m  max ${max.toFixed(1)}m ` +
      `| typical band ${((inTypicalBand / samples) * 100).toFixed(1)}% ` +
      `| >=35m ${((deepPockets / samples) * 100).toFixed(1)}%`,
  );
  check('never breaches the surface', min >= 3.5, `min depth ${min.toFixed(1)}m`);
  check('stays within biome maxDepth', max <= SAFE_SHALLOWS.terrain.maxDepth + 1.5);
  check('mostly 5-30m as specified', inTypicalBand / samples > 0.6);
  check('has 35m+ depressions', deepPockets / samples > 0.005);
}

// --- 2. determinism -------------------------------------------------------
console.log('\ndeterminism');
{
  const a = mesher.generate(req(1, -2));
  const mesher2 = new ChunkMesher(new DensityField(config.seed, createDefaultBiomeRegistry()), config.seed);
  // Generate an unrelated chunk first: output must not depend on call order.
  mesher2.generate(req(-3, 3));
  const b = mesher2.generate(req(1, -2));

  check('vertex counts match', a.positions.length === b.positions.length);
  let identical = a.indices.length === b.indices.length;
  for (let i = 0; identical && i < a.positions.length; i++) {
    if (a.positions[i] !== b.positions[i]) identical = false;
  }
  for (let i = 0; identical && i < a.indices.length; i++) {
    if (a.indices[i] !== b.indices[i]) identical = false;
  }
  check('geometry is bit-identical regardless of generation order', identical);
}

// --- 3. mesh integrity across the playable region -------------------------
console.log('\nmesh');
{
  let totalTris = 0;
  let totalVerts = 0;
  let worstMs = 0;
  let totalMs = 0;
  let chunks = 0;
  let emptyChunks = 0;
  let badNormals = 0;
  let overhangVerts = 0;

  const bounds = config.playableBounds!;
  for (let cx = -bounds.halfChunksX; cx <= bounds.halfChunksX; cx++) {
    for (let cz = -bounds.halfChunksZ; cz <= bounds.halfChunksZ; cz++) {
      const r = mesher.generate(req(cx, cz));
      chunks++;
      totalTris += r.indices.length / 3;
      totalVerts += r.positions.length / 3;
      totalMs += r.generateMs;
      worstMs = Math.max(worstMs, r.generateMs);
      if (r.indices.length === 0) emptyChunks++;

      for (let i = 0; i < r.normals.length; i += 3) {
        const len = Math.hypot(r.normals[i], r.normals[i + 1], r.normals[i + 2]);
        if (!(len > 0.9 && len < 1.1)) badNormals++;
        // A downward facing normal means a ceiling: cave roof or overhang.
        if (r.normals[i + 1] < -0.35) overhangVerts++;
      }
      for (let i = 0; i < r.indices.length; i++) {
        if (r.indices[i] >= r.positions.length / 3) {
          throw new Error(`chunk ${cx},${cz}: index out of range`);
        }
      }
    }
  }

  console.log(
    `  ${chunks} chunks | ${totalTris.toLocaleString()} tris | ${totalVerts.toLocaleString()} verts | ` +
      `${(totalTris / chunks).toFixed(0)} tris/chunk`,
  );
  console.log(`  generation: ${(totalMs / chunks).toFixed(1)}ms avg, ${worstMs.toFixed(1)}ms worst`);
  console.log(`  downward-facing (ceiling) verts: ${overhangVerts.toLocaleString()}`);

  check('every chunk produced geometry', emptyChunks === 0, `${emptyChunks} empty`);
  check('all normals are unit length', badNormals === 0, `${badNormals} bad`);
  check('terrain contains ceilings (caves / overhangs)', overhangVerts > 500);
  check('triangle budget is sane for standalone VR', totalTris / chunks < 25000);
  check('chunk generation fits a streaming budget', totalMs / chunks < 120);
}

// --- 4. caves exist, connect to open water, and fit a swimmer -------------
console.log('\ncaves');
{
  // Voxelise the playable region at 2m, flood fill the water volume from the
  // surface, then ask how much of the flooded volume sits under rock. That is
  // the only honest test of "the player can actually swim into a cave".
  const step = 2;
  const half = 224;
  const nx = Math.floor((half * 2) / step) + 1;
  const nz = nx;
  const yTop = 0;
  const yBottom = -80;
  const ny = Math.floor((yTop - yBottom) / step) + 1;

  const air = new Uint8Array(nx * ny * nz);
  const seabed = new Float32Array(nx * nz);
  const idx = (i: number, j: number, k: number) => (k * nx + i) * ny + j;

  for (let k = 0; k < nz; k++) {
    const z = -half + k * step;
    for (let i = 0; i < nx; i++) {
      const x = -half + i * step;
      const col = density.column(x, z);
      seabed[k * nx + i] = col.height;
      for (let j = 0; j < ny; j++) {
        if (density.densityAt(x, yBottom + j * step, z, col) < 0) air[idx(i, j, k)] = 1;
      }
    }
  }

  // Flood fill from the top water layer.
  const seen = new Uint8Array(air.length);
  const stack: number[] = [];
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const t = idx(i, ny - 1, k);
      if (air[t] && !seen[t]) {
        seen[t] = 1;
        stack.push(i, ny - 1, k);
      }
    }
  }
  while (stack.length > 0) {
    const k = stack.pop()!;
    const j = stack.pop()!;
    const i = stack.pop()!;
    for (let d = 0; d < 6; d++) {
      const ni = i + (d === 0 ? 1 : d === 1 ? -1 : 0);
      const nj = j + (d === 2 ? 1 : d === 3 ? -1 : 0);
      const nk = k + (d === 4 ? 1 : d === 5 ? -1 : 0);
      if (ni < 0 || ni >= nx || nj < 0 || nj >= ny || nk < 0 || nk >= nz) continue;
      const t = idx(ni, nj, nk);
      if (!air[t] || seen[t]) continue;
      seen[t] = 1;
      stack.push(ni, nj, nk);
    }
  }

  // "Under rock" = at least 4m below the local seabed height.
  let voidCells = 0;
  let reachableVoidCells = 0;
  const entranceCells = new Set<string>();
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) {
      const h = seabed[k * nx + i];
      for (let j = 0; j < ny; j++) {
        const y = yBottom + j * step;
        if (y > h - 4) continue;
        const t = idx(i, j, k);
        if (!air[t]) continue;
        voidCells++;
        if (seen[t]) {
          reachableVoidCells++;
          // Group reachable cave volume into 32m buckets to count systems.
          entranceCells.add(`${Math.floor(i / 16)},${Math.floor(k / 16)}`);
        }
      }
    }
  }

  const volume = reachableVoidCells * step ** 3;
  console.log(
    `  sub-seabed void: ${voidCells} cells, ${reachableVoidCells} reachable from open water ` +
      `(${((reachableVoidCells / Math.max(1, voidCells)) * 100).toFixed(0)}%, ~${volume.toLocaleString()} m3)`,
  );
  console.log(`  reachable cave volume spans ${entranceCells.size} distinct 32m regions`);

  check('caves exist below the seabed', voidCells > 500);
  check('caves connect to open water (entrances exist)', reachableVoidCells > 400);
  check('several separate cave areas are reachable', entranceCells.size >= 4);
}

// --- 5. collision --------------------------------------------------------
console.log('\ncollision');
{
  const world = new CollisionWorld();
  const bounds = 1; // 3x3 chunks around the origin is plenty for this test
  for (let cx = -bounds; cx <= bounds; cx++) {
    for (let cz = -bounds; cz <= bounds; cz++) {
      const r = mesher.generate(req(cx, cz));
      if (r.indices.length === 0) continue;
      world.add(
        `${cx},${cz}`,
        new ChunkCollider(
          cx * config.chunkSize,
          cz * config.chunkSize,
          r.positions,
          r.indices,
          r.min,
          r.max,
        ),
      );
    }
  }
  console.log(`  ${world.colliderCount} colliders, ${world.triangleCount.toLocaleString()} triangles`);

  const cfg = DEFAULT_PLAYER_CONFIG;
  const head = new Vector3();

  // Drive the *real* locomotion solver, not a hand-rolled loop: the thing we
  // need to trust is the code the player actually runs, including its
  // substepping and its velocity cancellation.
  const camera = new PerspectiveCamera(72, 1, 0.1, 1000);
  camera.position.set(0, 1.6, 0);
  const fakeRenderer = { xr: { isPresenting: false, getCamera: () => camera } };
  const rig = new PlayerRig(camera, fakeRenderer as unknown as WebGLRenderer);
  const locomotion = new Locomotion(rig, world, cfg);
  const intent = createMoveIntent();

  // Chunk (cx,cz) covers [cx*size, (cx+1)*size), so a -1..1 chunk block spans
  // [-64, 128) on both axes. Stay inside that with a margin.
  const AREA_MIN = -58;
  const AREA_MAX = 120;
  const span = AREA_MAX - AREA_MIN;

  // Drop the player straight down from just under the surface and let the
  // solver stop them. Landing inside a cave is a legitimate outcome; falling
  // out of the world or ending up buried in rock is not.
  let drops = 0;
  let sunk = 0;
  let stuckInRock = 0;
  let worstPenetration = 0;
  let landed = 0;
  let intoCaves = 0;
  let leftArea = 0;

  /**
   * How far the solver would still have to push the player right now. Zero
   * means the capsule is cleanly outside the terrain mesh.
   */
  const residualPenetration = (): number => {
    const probe = locomotion.capsule.clone();
    return world.resolveCapsule(probe, null).correction;
  };

  const inCoveredArea = (p: Vector3) =>
    p.x > AREA_MIN - 4 && p.x < AREA_MAX + 4 && p.z > AREA_MIN - 4 && p.z < AREA_MAX + 4;

  for (let i = 0; i < 240; i++) {
    // Deterministic sweep across the covered area.
    const x = AREA_MIN + (i % 20) * (span / 19);
    const z = AREA_MIN + Math.floor(i / 20) * (span / 11);
    const seabed = density.seabedAt(x, z);

    // Start in open water above the seabed.
    locomotion.teleport(new Vector3(x, Math.max(-2, seabed + cfg.bodyHeight + 2.5), z));

    // Hold "descend" for 12 seconds at 72Hz - the harshest sustained push the
    // player can actually apply to the seabed.
    intent.vertical = -1;
    for (let step = 0; step < 864; step++) locomotion.update(1 / 72, intent);

    rig.getHeadPosition(head);
    drops++;
    if (!inCoveredArea(head)) {
      leftArea++;
      continue; // drifted off the edge of the test's collider block
    }

    const foot = head.y - cfg.bodyHeight;
    const localSeabed = density.seabedAt(head.x, head.z);
    if (foot < config.worldMinY + 6) sunk++;
    else if (foot < localSeabed - 2) intoCaves++;
    else landed++;

    // Residual penetration against the collider the player actually hits.
    // (Comparing against the analytic density field instead would be wrong by
    // up to a voxel, since the mesh is a 2 m approximation of that field.)
    const residual = residualPenetration();
    worstPenetration = Math.max(worstPenetration, residual);
    if (residual > 0.05) stuckInRock++;
  }

  console.log(
    `  ${drops} descents: ${landed} rested on the seabed, ${intoCaves} settled inside caves, ` +
      `${sunk} fell out of the world, ${leftArea} drifted off the test block`,
  );
  console.log(`  worst residual penetration after settling: ${worstPenetration.toFixed(4)}m`);
  check('nobody sinks out of the world', sunk === 0, `${sunk} of ${drops}`);
  check('no residual penetration once settled', stuckInRock === 0, `${stuckInRock}`);
  check('most descents come to rest on terrain', landed + intoCaves > drops * 0.8);

  // Swim flat-out into terrain, boosted, from every direction. Nothing here
  // should end up inside rock - this is the substepping doing its job.
  let tunnelled = 0;
  let sweeps = 0;
  let worstSweep = 0;
  const directions: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let i = 0; i < 48; i++) {
    const x = AREA_MIN + 20 + (i % 8) * ((span - 40) / 7);
    const z = AREA_MIN + 20 + Math.floor(i / 8) * ((span - 40) / 5);
    const seabed = density.seabedAt(x, z);
    const start = new Vector3(x, seabed + 2.2, z);
    if (density.sample(start.x, start.y, start.z) > 0) continue;

    for (const [dx, dz] of directions) {
      locomotion.teleport(start);
      // Aim the rig along the sweep direction and hold forward + boost.
      rig.group.quaternion.set(0, 0, 0, 1);
      rig.rotateAroundHead(Math.atan2(dx, -dz) * -1 + Math.PI);
      intent.vertical = 0;
      intent.forward = 1;
      intent.boost = 1;
      for (let step = 0; step < 500; step++) locomotion.update(1 / 72, intent);

      rig.getHeadPosition(head);
      sweeps++;
      if (!inCoveredArea(head)) continue;
      const residual = residualPenetration();
      worstSweep = Math.max(worstSweep, residual);
      if (residual > 0.05) tunnelled++;
    }
  }
  intent.forward = 0;
  intent.boost = 0;
  console.log(
    `  ${sweeps} boosted sweeps into terrain from 4 directions, ` +
      `worst residual ${worstSweep.toFixed(4)}m`,
  );
  check('boosted sweeps never end up inside rock', tunnelled === 0, `${tunnelled}`);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
