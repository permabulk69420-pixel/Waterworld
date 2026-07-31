import {
  Box3,
  DynamicDrawUsage,
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
import { DEFAULT_WORLD_CONFIG, type WorldConfig } from '../config/worldConfig.ts';
import { Rng, deriveSeed } from '../math/rng.ts';
import type { DensityField } from '../world/density.ts';

const ASSET_URLS = Object.freeze([
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_v1.glb',
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_var_b_v1.glb',
]);

const UP = new Vector3(0, 1, 0);

// The current Safe Shallows is still the only registered biome, so this is an
// authored transition belt placed just inside the original ~400 m prototype edge.
// When real neighbouring biome regions arrive this half-extent can be replaced by
// the registry's actual border distance without changing the renderer.
const BASE_HALF_CHUNKS = DEFAULT_WORLD_CONFIG.playableBounds?.halfChunksX ?? 3;
const BIOME_EDGE_HALF_EXTENT = DEFAULT_WORLD_CONFIG.chunkSize * BASE_HALF_CHUNKS - 8;
const FOREST_BAND_WIDTH = 29;
const FOREST_INNER_HALF_EXTENT = BIOME_EDGE_HALF_EXTENT - FOREST_BAND_WIDTH;

// Dense enough to read as a wall rather than scatter vegetation. The patches are
// low-poly and instanced; only the subset close to the player is submitted.
const GRID_SPACING = 2.85;
const JITTER = 1.05;
const CELL_OCCUPANCY = 0.91;
const MIN_DEPTH = 3.2;
const MAX_DEPTH = 49;
const MIN_TARGET_HEIGHT = 7.0;
const MAX_TARGET_HEIGHT = 11.0;
const SURFACE_CLEARANCE = 0.45;
const BASE_SINK = 0.06;

const RENDER_DISTANCE = 92;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;
const CULL_REBUILD_DISTANCE = 2.75;
const CULL_REBUILD_DISTANCE_SQ = CULL_REBUILD_DISTANCE * CULL_REBUILD_DISTANCE;
const MAX_VISIBLE_PER_VARIANT = 1100;

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
 * Dense ribbon-kelp transition forest around the current Safe Shallows edge.
 *
 * Every source GLB mesh becomes an InstancedMesh layer, so even if an asset uses a
 * couple of material/mesh parts we still pay only a handful of draw calls for the
 * entire visible forest. Source mesh transforms are baked into cloned geometry;
 * each runtime instance is then just one matrix + one phase float.
 *
 * Sway is vertex-shader driven and weighted from root to tip. No bones, mixers or
 * per-plant CPU animation are used. The instance lists are rebuilt only after the
 * player moves a few metres and standard frustum culling is retained on the compact
 * nearby batches.
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
        `[kelp] ribbon forest ready: ${this.placementCount} patches around biome edge; ` +
          `${this.variants.map((variant, index) => `v${index + 1}=${variant.triangleCount} tris/${variant.layers.length} draw layer(s)/${variant.authoredHeight.toFixed(2)}m authored`).join(', ')}; ` +
          `target ${MIN_TARGET_HEIGHT}-${MAX_TARGET_HEIGHT}m; ${RENDER_DISTANCE}m submit radius`,
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

      const indexCount = geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0;
      triangleCount += Math.floor(indexCount / 3);

      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const materials = sourceMaterials.map((source, materialIndex) => {
        const material = source.clone();
        if (material instanceof MeshStandardMaterial) {
          this.installSwayShader(material, authoredHeight, variantIndex, layers.length, materialIndex);
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

  private installSwayShader(
    material: MeshStandardMaterial,
    authoredHeight: number,
    variantIndex: number,
    layerIndex: number,
    materialIndex: number,
  ): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRibbonKelpTime = this.swayTime;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nattribute float instanceKelpPhase;\nuniform float uRibbonKelpTime;',
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n\
        float kelpHeight01 = clamp(position.y / ${Math.max(0.05, authoredHeight).toFixed(5)}, 0.0, 1.0);\n\
        float kelpBend = kelpHeight01 * kelpHeight01 * (3.0 - 2.0 * kelpHeight01);\n\
        float kelpPhase = uRibbonKelpTime * 0.72 + instanceKelpPhase;\n\
        float kelpBroadWave = sin(kelpPhase + position.y * 0.42);\n\
        float kelpFineWave = sin(kelpPhase * 1.37 + position.y * 0.91 + position.x * 0.22);\n\
        transformed.x += (kelpBroadWave * 0.18 + kelpFineWave * 0.055) * kelpBend;\n\
        transformed.z += cos(kelpPhase * 0.83 + position.y * 0.36) * 0.13 * kelpBend;`,
      );
    };
    material.customProgramCacheKey = () =>
      `waterworld-ribbon-kelp-sway-v1-${variantIndex}-${layerIndex}-${materialIndex}`;
    material.needsUpdate = true;
  }

  private buildForestPlacements(): void {
    if (this.variants.length === 0) return;

    const rng = new Rng(deriveSeed(this.worldConfig.seed, 'safe-shallows-ribbon-kelp-border-v1'));
    const edge = BIOME_EDGE_HALF_EXTENT;
    const start = -edge + GRID_SPACING * 0.5;
    const end = edge - GRID_SPACING * 0.5;

    for (let gz = start; gz <= end; gz += GRID_SPACING) {
      for (let gx = start; gx <= end; gx += GRID_SPACING) {
        if (!rng.chance(CELL_OCCUPANCY)) continue;

        const x = MathUtils.clamp(gx + rng.range(-JITTER, JITTER), -edge + 0.4, edge - 0.4);
        const z = MathUtils.clamp(gz + rng.range(-JITTER, JITTER), -edge + 0.4, edge - 0.4);
        const squareRadius = Math.max(Math.abs(x), Math.abs(z));
        if (squareRadius < FOREST_INNER_HALF_EXTENT || squareRadius > edge) continue;

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
        const widthScale = heightScale * rng.range(0.82, 1.12);

        this.dummy.position.set(x, seabed - BASE_SINK, z);
        this.dummy.quaternion.setFromUnitVectors(UP, _normal);
        this.dummy.rotateY(rng.range(0, Math.PI * 2));
        this.dummy.scale.set(widthScale, heightScale, widthScale);
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
        // Keep ordinary Three.js view-frustum rejection on top of our much more
        // important short-distance instance cull. Rebuilding a ~1000-instance
        // sphere every few metres is cheap compared with drawing the whole ring.
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
