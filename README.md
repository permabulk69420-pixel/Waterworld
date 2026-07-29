# Waterworld

Technical foundation for a VR alien-ocean survival game. WebXR + Three.js,
targeting standalone Quest 3.

This pass is **only** the foundation: deterministic chunked underwater terrain,
caves, an ocean, neutral placeholder atmosphere, VR swimming locomotion, smooth
turning and collision. There is deliberately no art, no creatures, no
vegetation, no resources, no UI and no gameplay — the content hooks are in
place, but nothing populates them yet.

---

## Running it

```bash
npm install
npm run dev      # then open the printed http://<lan-ip>:5173 URL
```

Desktop works over plain HTTP. **WebXR needs a secure context**, so to enter VR
on the headset the page must be served over HTTPS (or from `localhost`). The
easiest route with no PC in the loop: push to GitHub, enable Pages (Settings →
Pages → Source: GitHub Actions), and the included workflow publishes the build
to an HTTPS URL you can open in the Quest browser and tap **Enter VR**.

### URL parameters

| Parameter    | Effect                               |
| ------------ | ------------------------------------ |
| `?seed=1234` | World seed                           |
| `?debug=1`   | Start with the debug HUD visible     |
| `?view=4`    | View distance in chunks              |
| `?workers=0` | Force main-thread terrain generation |

### Controls

**Quest**

| Input                    | Action                                             |
| ------------------------ | -------------------------------------------------- |
| Left stick               | Swim forward/back and strafe, relative to the head |
| Right stick (horizontal) | Smooth continuous turn                             |
| A / X                    | Ascend                                             |
| B / Y                    | Descend                                            |
| Right trigger            | Ascend (analog)                                    |
| Left trigger             | Descend (analog)                                   |
| Either grip              | Boost                                              |
| Left stick click         | Toggle the in-headset debug panel                  |

Right stick vertical is ignored on purpose — it would fight the head-relative
forward movement. There is no snap turn, no gravity while swimming, and the
solver never rotates or repositions your view.

**Desktop**

`WASD` swim · mouse look (click to capture) · `Space` / `Ctrl` up-down ·
`Shift` boost · `Q` / `E` turn · `F3` debug HUD · `F4` chunk bounds ·
`Shift+F5` collision capsule

---

## How the world is built

Terrain is a **3D density field** meshed with **naive surface nets**, not a
heightmap. That choice is what makes caves, overhangs and arches part of the
same mesh as the seabed rather than separate level geometry bolted on top — and
because collision runs against those same triangles, cave walls and ceilings
collide correctly for free.

```
density field  ──▶  surface nets  ──▶  chunk mesh ──┬─▶ scene
(world/density)     (chunkGeometry)                 └─▶ triangle collider
```

The density field is a pure function of `(seed, world position, biome params)`.
No call ordering, no mutable state, no dependency on chunk size — so a chunk
regenerates identically whenever and wherever it is requested, including inside
a worker. `npm run verify` asserts this bit-for-bit.

**Chunk seams.** Chunks sample two extra rings of density beyond their own
footprint, but a quad is only emitted by the chunk that owns the sample at the
base of its edge (local sample index `0..R-1`). Global samples partition exactly
between chunks, so neighbours produce no gaps and no overlapping geometry.
Vertex normals come from the density gradient — a pure function of world
position — so shading is continuous across borders too.

### Layout

| Path                  | Responsibility                                              |
| --------------------- | ----------------------------------------------------------- |
| `config/worldConfig`  | Seed, chunk size/resolution, view distance, world extent     |
| `config/biomes/`      | Biome schema + `SAFE_SHALLOWS` data + the biome registry     |
| `world/density`       | The density field: seabed, shelves, ridges, valleys, basins  |
| `world/caves`         | Cave system placement and tunnel/chamber carving             |
| `world/landmarks`     | Pinnacles, arches, sinkholes, mounds — as terrain, not props |
| `world/chunkGeometry` | Surface nets mesher (no three.js / DOM — worker safe)        |
| `world/ChunkManager`  | Streaming: what should exist, and wiring it up when it does  |
| `world/workers/`      | Terrain generation worker                                    |
| `physics/`            | Capsule, per-chunk triangle grid, capsule-vs-triangle solver |
| `player/`             | Rig, locomotion, XR input, desktop input                     |
| `environment/`        | Sky, ocean, lighting, fog/underwater state                   |
| `content/`            | Placement hooks for future assets (nothing populated)        |
| `debug/`              | DOM HUD, in-VR panel, chunk-bound and capsule overlays       |

### Current numbers

Measured by `npm run verify` on the default seed, over the 7×7 chunk region:

- 64 m chunks at 2 m voxels, 49 chunks ≈ 448 × 448 m
- ~163k triangles total, ~3.3k per chunk
- ~12 ms to generate a chunk, off the render thread in workers
- Seabed 4.5–48.6 m deep; 94% in the 5–30 m band, 3.9% at 35 m+
- ~120,000 m³ of cave volume, **94% of it reachable from open water**
- 13–25 draw calls
- Sustained descents and boosted sweeps into terrain: **0 m residual penetration**

---

## Extending it

**Add a biome.** Write a `BiomeConfig` (copy `safeShallows.ts`), register it in
`createDefaultBiomeRegistry()`, and make `BiomeRegistry.biomeAt(x, z)` return it
for some region. That is the whole change — the terrain engine is fully driven
by biome data and never needs editing. The one rule: `biomeAt` must stay a pure
deterministic function of position, or chunks stop regenerating identically.
There is a marked blend point in `DensityField.column()` for when biome borders
need smoothing.

**Add content.** Implement `ContentPopulator` and
`game.content.register(populator)`. You get a per-chunk context with a
chunk-seeded RNG, `sampleSeabedPoints(count, minNormalY)` and
`sampleCavePoints(count)`, plus a group that is disposed automatically when the
chunk unloads. Populators must only use `ctx.rng` so chunks repopulate
identically when they stream back in. `BiomeConfig.spawnDensity` already carries
per-biome density hooks for vegetation, rocks, resources, creatures, structures
and cave props; nothing reads them yet.

**Grow the world.** `playableBounds` in `worldConfig` is the *only* thing
limiting the world to 448 m. Set it to `null` and terrain streams indefinitely;
nothing else assumes a fixed world size.

---

## Verification

```bash
npm run typecheck
npm run verify   # headless: terrain, determinism, caves, collision
npm run build
npm run smoke    # headless browser: loads the build and drives the controls
npm run check    # all of the above
```

`verify` runs the real `Locomotion` solver against real chunk colliders — 240
sustained descents onto the seabed and 184 boosted sweeps into terrain from four
directions — and asserts zero residual penetration. Cave connectivity is checked
by voxelising the region and flood-filling from the surface, which is the only
honest test of "the player can actually swim into a cave".

`smoke` needs Chromium; it runs on software GL at a few fps, so it waits on
world state rather than wall-clock time.

---

## Known characteristics

- **The world ends at 448 m.** Terrain outside `playableBounds` simply is not
  generated, so the region edge is a visible drop into empty water. That is the
  temporary bound, not a limit of the system.
- **Cave interiors are dim.** With no shadows and no local lights, the
  hemisphere ground colour plus an ambient fill is all that reaches a
  downward-facing surface. Tunable in one place (`environment/Lighting.ts`) and
  per biome via `BiomeVisuals`.
- **~0.4% of mesh edges are non-manifold.** Naive surface nets places one vertex
  per cell, so a cell containing two surface sheets produces a non-manifold
  junction. It does not create holes — every boundary edge is a chunk border —
  and neither rendering nor triangle collision cares, but it would matter if the
  mesh were ever used for something that requires manifoldness.
- **No LOD.** Underwater visibility is ~60–90 m and chunks beyond the view radius
  are unloaded, which does the same job without LOD seam artifacts. A
  distance-simplification hook would slot into `ChunkManager`.
- **Voxel size is 2 m**, so tunnels are generously sized and fine rock detail is
  smoothed away. `chunkResolution` trades this against generation cost.
- **A stuck-recovery guard** samples the density field once per frame and lifts
  the player to open water if they ever end up fully embedded in terrain — the
  one case a triangle solver cannot dig itself out of.
