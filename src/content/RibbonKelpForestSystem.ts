import {
  Box3,
  DynamicDrawUsage,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type BufferGeometry,
  type Material,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WorldConfig } from '../config/worldConfig.ts';
import { Rng, deriveSeed } from '../math/rng.ts';
import type { DensityField } from '../world/density.ts';

const ASSET_URLS = Object.freeze([
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_v1.glb',
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_var_b_v1.glb',
]);

const UP = new Vector3(0, 1, 0);

// This is an actual map-edge transition forest, not a decorative ring around the
// centre. The rectangle is derived from the runtime playable chunk bounds so a
// larger load-distance setting moves the kelp outward with the real world edge.
const FOREST_BAND_WIDTH = 29;
const EDGE_INSET = 0.45;

// Dense enough to read as a wall rather than scatter vegetation. The source assets
// recommend 1.7-3.4 m patch spacing; this sits near the dense end while still leaving
// irregular little channels a player can physically push through.
const GRID_SPACING = 2.85;
const JITTER = 1.05;
const CELL_OCCUPANCY = 0.91;
const MIN_DEPTH = 3.2;
const MAX_DEPTH = 49;
const MIN_TARGET_HEIGHT = 7.0;
const MAX_TARGET_HEIGHT = 11.0;
const SURFACE_CLEARANCE = 0.45;
const BASE_SINK = 0.06;

// The old 92 m submit radius made the border appear late and exaggerated the sense
// that it was an isolated ring. 240 m lets the dense wall establish itself as a
// distant biome boundary while still submitting only a local slice of the forest.
const RENDER_DISTANCE = 240;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;
const CULL_REBUILD_DISTANCE = 3.5;
const CULL_REBUILD_DISTANCE_SQ = CULL_REBUILD_DISTANCE * CULL_REBUILD_DISTANCE;
const MAX_VISIBLE_PER_VARIANT = 2400;

const _normal = new Vector3();
const _size = new Vector3();
const _grounding = new Matrix4();

interface KelpPlacement {
  position: Vector3;
  matrix: Matrix4;
  phase: number;
}

interface KelpLayer {
  mesh: InstancedMesh;
  phase: InstancedBufferAttribute;
  geometry: BufferGeometry;
  materials: Material[];
}

interface KelpVariant {
  authoredHeight: number;
  layers: KelpLayer[];
  placements: KelpPlacement[];
  triangleCount: number;
}

/**
 * Dense ribbon-kelp transition forest hugging the current playable-map edge.
 *
 * Every source GLB mesh becomes an InstancedMesh layer, so even if a future asset
 * grows a couple of material/mesh parts we still pay only a handful of draw calls
 * for the entire visible forest. Source mesh transforms are baked into cloned
 * geometry; each runtime instance is then just one matrix + one phase float.
 *
 * Sway is vertex-shader driven using the GLBs' authored _SWAY weights when present,
 * with a height-derived fallback. No bones, mixers or per-plant CPU animation are
 * used. Nearby instance lists rebuild only after the player moves a few metres and
 * ordinary Three.js view-frustum culling stays enabled on those compact batches.
 */
export class RibbonKelpForestSystem {
  readonly ready: Promise<void>;

  private readonly variants: KelpVariant[] = [];
  private readonly dummy = new Object3D();
  private readonly lastCullPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly swayTime = { value: 0 };
  private disposed = false;
  private warnedCapacity = false;

  constructor(
    private readonly scene: Scene,
    private readonly density: DensityField,
    private readonly worldConfig: WorldConfig,
  ) {
    this.ready = this.load();
  }

  get placementCount(): number {
    let count = 0;
    for (const variant of this.variants) count += variant.placements.length;
    return count;
  }

  private async load(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const loaded = await Promise.all(ASSET_URLS.map((url) => loader.loadAsync(url)));
      if (this.disposed) return;

      for (let index = 0; index < loaded.length; index++) {
        this.variants.push(this.buildVariant(loaded[index].scene, index));
      }

      this.buildForestPlacements();
      this.rebuildVisibleInstances(new Vector3(0, 0, 0));

      console.info(
        `[kelp] ribbon forest ready: ${this.placementCount} patches on actual map edge; ` +
          `${this.variants.map((variant, index) => `v${index + 1}=${variant.triangleCount} tris/${variant.layers.length} draw layer(s)/${variant.authoredHeight.toFixed(2)}m authored`).join(', ')}; ` +
          `band ${FOREST_BAND_WIDTH}m; target ${MIN_TARGET_HEIGHT}-${MAX_TARGET_HEIGHT}m; ${RENDER_DISTANCE}m submit radius`,
      );
    } catch (error) {
      console.warn('[kelp] failed to load ribbon-kelp forest assets', error);
      this.dispose();
    }
  }

  private buildVariant(root: Object3D, variantIndex: number): KelpVariant {
    root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(root);
    bounds.getSize(_size);
    const authoredHeight = _size.y;
    if (!Number.isFinite(authoredHeight) || authoredHeight <= 0.05) {
      throw new Error(`ribbon kelp variant ${variantIndex + 1} has invalid bounds`);
    }

    // Geometry gets grounded after all authored node transforms are baked in.
    _grounding.makeTranslation(0, -bounds.min.y, 0);

    const layers: KelpLayer[] = [];
    let triangleCount = 0;

    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;

      const geometry = object.geometry.clone();
      geometry.applyMatrix4(object.matrixWorld);
      geometry.applyMatrix4(_grounding);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      this.installSwayWeightAttribute(geometry, authoredHeight);

      const indexCount = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
      triangleCount += Math.floor(indexCount / 3);

      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const materials = sourceMaterials.map((source, materialIndex) => {
        const material = source.clone();
        if (material instanceof MeshStandardMaterial) {
          this.installSwayShader(material, variantIndex, layers.length, materialIndex);
        }
        return material;
      });

      const phase = new InstancedBufferAttribute(
        new Float32Array(MAX_VISIBLE_PER_VARIANT),
        1,
      );
      geometry.setAttribute('instanceKelpPhase', phase);

      const mesh = new InstancedMesh(
        geometry,
        Array.isArray(object.material) ? materials : materials[0],
        MAX_VISIBLE_PER_VARIANT,
      );
      mesh.name = `kelp:ribbon:v${variantIndex + 1}:layer:${layers.length + 1}`;
      mesh.count = 0;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      this.scene.add(mesh);

      layers.push({ mesh, phase, geometry, materials });
    });

    if (layers.length === 0) {
      throw new Error(`ribbon kelp variant ${variantIndex + 1} contains no meshes`);
    }

    return {
      authoredHeight,
      layers,
      placements: [],
      triangleCount,
    };
  }

  private installSwayWeightAttribute(geometry: BufferGeometry, authoredHeight: number): void {
    // THREE's GLTFLoader currently preserves custom semantics with their authored
    // name, but accept either casing so this remains robust if the loader changes.
    const authored = geometry.getAttribute('_sway') ?? geometry.getAttribute('_SWAY');
    if (authored) {
      geometry.setAttribute('kelpSwayWeight', authored);
      return;
    }

    const position = geometry.getAttribute('position');
    const weights = new Float32Array(position.count);
    const inverseHeight = 1 / Math.max(0.05, authoredHeight);
    for (let index = 0; index < position.count; index++) {
      const height01 = MathUtils.clamp(position.getY(index) * inverseHeight, 0, 1);
      weights[index] = height01 * height01 * (3 - 2 * height01);
    }
    geometry.setAttribute('kelpSwayWeight', new Float32BufferAttribute(weights, 1));
  }

  private installSwayShader(
    material: MeshStandardMaterial,
    variantIndex: number,
    layerIndex: number,
    materialIndex: number,
  ): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRibbonKelpTime = this.swayTime;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nattribute float instanceKelpPhase;\nattribute float kelpSwayWeight;\nuniform float uRibbonKelpTime;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n\
        float kelpBend = clamp(kelpSwayWeight, 0.0, 1.0);\n\
        float kelpPhase = uRibbonKelpTime * 1.0 + instanceKelpPhase;\n\
        float kelpBroadWave = sin(kelpPhase + position.y * 0.42);\n\
        float kelpFineWave = sin(kelpPhase * 1.37 + position.y * 0.91 + position.x * 0.22);\n\
        transformed.x += (kelpBroadWave * 0.19 + kelpFineWave * 0.055) * kelpBend;\n\
        transformed.z += cos(kelpPhase * 0.83 + position.y * 0.36) * 0.13 * kelpBend;`,
      );
    };
    material.customProgramCacheKey = () =>
      `waterworld-ribbon-kelp-sway-v2-${variantIndex}-${layerIndex}-${materialIndex}`;
    material.needsUpdate = true;
  }

  private buildForestPlacements(): void {
    if (this.variants.length === 0) return;

    const bounds = this.worldConfig.playableBounds;
    const halfChunksX = bounds?.halfChunksX ?? 3;
    const halfChunksZ = bounds?.halfChunksZ ?? 3;
    const chunkSize = this.worldConfig.chunkSize;

    // Chunk coordinates run from -half..+half inclusive. That means the physical
    // world footprint is not +/- half*chunkSize: the positive edge includes the
    // full +half chunk. Derive the exact rectangle used by ChunkManager.
    const mapMinX = -halfChunksX * chunkSize;
    const mapMaxX = (halfChunksX + 1) * chunkSize;
    const mapMinZ = -halfChunksZ * chunkSize;
    const mapMaxZ = (halfChunksZ + 1) * chunkSize;

    const plantMinX = mapMinX + EDGE_INSET;
    const plantMaxX = mapMaxX - EDGE_INSET;
    const plantMinZ = mapMinZ + EDGE_INSET;
    const plantMaxZ = mapMaxZ - EDGE_INSET;

    const rng = new Rng(deriveSeed(this.worldConfig.seed, 'safe-shallows-ribbon-kelp-border-v2'));

    // Fill only the outer FOREST_BAND_WIDTH metres of the actual runtime map. Using
    // distance-to-rectangle-edge avoids the previous centred square-radius ring and
    // guarantees the kelp reaches every side and corner of the playable boundary.
    for (let gz = plantMinZ; gz <= plantMaxZ; gz += GRID_SPACING) {
      for (let gx = plantMinX; gx <= plantMaxX; gx += GRID_SPACING) {
        if (!rng.chance(CELL_OCCUPANCY)) continue;

        const x = MathUtils.clamp(gx + rng.range(-JITTER, JITTER), plantMinX, plantMaxX);
        const z = MathUtils.clamp(gz + rng.range(-JITTER, JITTER), plantMinZ, plantMaxZ);
        const distanceToMapEdge = Math.min(
          x - mapMinX,
          mapMaxX - x,
          z - mapMinZ,
          mapMaxZ - z,
        );
        if (distanceToMapEdge < 0 || distanceToMapEdge > FOREST_BAND_WIDTH) continue;

        const seabed = this.density.seabedAt(x, z);
        const depth = this.worldConfig.seaLevel - seabed;
        if (depth < MIN_DEPTH || depth > MAX_DEPTH) continue;

        const e = 0.75;
        _normal
          .set(
            this.density.seabedAt(x - e, z) - this.density.seabedAt(x + e, z),
            2 * e,
            this.density.seabedAt(x, z - e) - this.density.seabedAt(x, z + e),
          )
          .normalize();
        if (_normal.y < 0.48) continue;

        const variantIndex = rng.chance(0.5) ? 0 : Math.min(1, this.variants.length - 1);
        const variant = this.variants[variantIndex];

        const requestedHeight = rng.range(MIN_TARGET_HEIGHT, MAX_TARGET_HEIGHT);
        const height = Math.min(requestedHeight, Math.max(2.8, depth - SURFACE_CLEARANCE));
        const heightScale = height / variant.authoredHeight;
        const horizontalScale = rng.range(0.86, 1.16);

        this.dummy.position.set(x, seabed - BASE_SINK, z);
        this.dummy.quaternion.setFromUnitVectors(UP, _normal);
        this.dummy.rotateY(rng.range(0, Math.PI * 2));
        this.dummy.scale.set(horizontalScale, heightScale, horizontalScale);
        this.dummy.updateMatrix();

        variant.placements.push({
          position: new Vector3(x, seabed, z),
          matrix: this.dummy.matrix.clone(),
          phase: rng.range(0, Math.PI * 2),
        });
      }
    }
  }

  update(dt: number, playerPosition: Vector3): void {
    if (this.disposed || this.variants.length === 0) return;
    this.swayTime.value += MathUtils.clamp(dt, 0, 0.05);

    const dx = playerPosition.x - this.lastCullPosition.x;
    const dz = playerPosition.z - this.lastCullPosition.z;
    if (dx * dx + dz * dz < CULL_REBUILD_DISTANCE_SQ) return;

    this.rebuildVisibleInstances(playerPosition);
  }

  private rebuildVisibleInstances(playerPosition: Vector3): void {
    for (const variant of this.variants) {
      let visible = 0;

      for (const placement of variant.placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        if (dx * dx + dz * dz > RENDER_DISTANCE_SQ) continue;

        if (visible >= MAX_VISIBLE_PER_VARIANT) {
          if (!this.warnedCapacity) {
            this.warnedCapacity = true;
            console.warn(
              `[kelp] visible ribbon forest exceeded ${MAX_VISIBLE_PER_VARIANT} instances for one variant; farther patches are culled`,
            );
          }
          break;
        }

        for (const layer of variant.layers) {
          layer.mesh.setMatrixAt(visible, placement.matrix);
          layer.phase.setX(visible, placement.phase);
        }
        visible++;
      }

      for (const layer of variant.layers) {
        layer.mesh.count = visible;
        layer.mesh.instanceMatrix.needsUpdate = true;
        layer.phase.needsUpdate = true;
        layer.mesh.computeBoundingSphere();
      }
    }

    this.lastCullPosition.copy(playerPosition);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const variant of this.variants) {
      variant.placements.length = 0;
      for (const layer of variant.layers) {
        layer.mesh.removeFromParent();
        layer.geometry.dispose();
        for (const material of layer.materials) material.dispose();
      }
      variant.layers.length = 0;
    }
    this.variants.length = 0;
  }
}
