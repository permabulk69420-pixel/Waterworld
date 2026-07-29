import {
  DoubleSide,
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
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const UP = new Vector3(0, 1, 0);
const ASSET_URL = './assets/biomes/safe-shallows/tropical_seagrass_dense_quest3.glb';

const DEFAULT_RENDER_DISTANCE = 46;
const MIN_RENDER_DISTANCE = 10;
const MAX_RENDER_DISTANCE = 100;
const MAX_VISIBLE_INSTANCES = 8192;
const CULL_REBUILD_DISTANCE = 2;
const CULL_REBUILD_DISTANCE_SQ = CULL_REBUILD_DISTANCE * CULL_REBUILD_DISTANCE;

export interface SeaGrassOptions {
  /** Multiplies the biome's base vegetation density. 1 = authored density. */
  densityMultiplier?: number;
  /** Distance in metres at which grass instances are submitted to the GPU. */
  renderDistance?: number;
}

interface GrassPlacement {
  position: Vector3;
  matrix: Matrix4;
  phase: number;
}

/**
 * Dense Safe Shallows vegetation renderer.
 *
 * The source GLB is deliberately tiny: one 512-triangle mesh, one material and
 * no baked animation. Every visible patch is therefore rendered through one
 * InstancedMesh, while a vertex shader supplies the underwater sway on the GPU.
 *
 * Loaded terrain chunks only keep cheap placement records. The instance buffer
 * is rebuilt after the player moves a couple of metres or chunks stream in/out,
 * so terrain can remain visible much farther away than vegetation without paying
 * per-frame object, material, morph-target or AnimationMixer costs.
 */
export class SeaGrassSystem implements ContentPopulator {
  readonly id = 'safe-shallows-seagrass-v2-instanced';
  readonly layer = 'vegetation' as const;
  readonly ready: Promise<void>;

  private readonly chunks = new Map<string, GrassPlacement[]>();
  private readonly densityMultiplier: number;
  private readonly renderDistanceSq: number;
  private readonly parent: Object3D;
  private readonly dummy = new Object3D();
  private readonly lastCullPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly swayTime = { value: 0 };

  private geometry: BufferGeometry | null = null;
  private material: MeshStandardMaterial | null = null;
  private instances: InstancedMesh | null = null;
  private phaseAttribute: InstancedBufferAttribute | null = null;
  private layoutDirty = true;
  private loadFailed = false;
  private warnedCapacity = false;

  constructor(parent: Object3D, options: SeaGrassOptions = {}) {
    this.parent = parent;
    this.densityMultiplier = MathUtils.clamp(options.densityMultiplier ?? 1, 0, 4);

    const renderDistance = MathUtils.clamp(
      options.renderDistance ?? DEFAULT_RENDER_DISTANCE,
      MIN_RENDER_DISTANCE,
      MAX_RENDER_DISTANCE,
    );
    this.renderDistanceSq = renderDistance * renderDistance;
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return (
      this.densityMultiplier > 0 &&
      biome.id === 'SAFE_SHALLOWS' &&
      biome.spawnDensity.vegetation > 0
    );
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      let sourceMesh: Mesh | null = null;

      gltf.scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!sourceMesh && mesh.isMesh) sourceMesh = mesh;
      });

      if (!sourceMesh) throw new Error('GLB contains no mesh');
      if (Array.isArray(sourceMesh.material)) {
        throw new Error('Seagrass asset must use one material');
      }
      if (!(sourceMesh.material instanceof MeshStandardMaterial)) {
        throw new Error('Seagrass material is not MeshStandardMaterial-compatible');
      }

      this.geometry = sourceMesh.geometry.clone();
      this.material = sourceMesh.material.clone();
      this.material.side = DoubleSide;
      this.material.vertexColors = this.geometry.getAttribute('color') !== undefined;

      // One phase value per patch lets every instance sway differently while the
      // entire field still shares one shader and one draw call.
      this.phaseAttribute = new InstancedBufferAttribute(
        new Float32Array(MAX_VISIBLE_INSTANCES),
        1,
      );
      this.geometry.setAttribute('instancePhase', this.phaseAttribute);

      this.material.onBeforeCompile = (shader) => {
        shader.uniforms.uSeaGrassTime = this.swayTime;
        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          `#include <common>\nattribute float instancePhase;\nuniform float uSeaGrassTime;`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\n\
          float grassHeight = clamp(position.y / 1.18, 0.0, 1.0);\n\
          float bendWeight = grassHeight * grassHeight;\n\
          float swayPhase = uSeaGrassTime * 1.15 + instancePhase;\n\
          transformed.x += sin(swayPhase + position.y * 1.7) * 0.075 * bendWeight;\n\
          transformed.z += cos(swayPhase * 0.83 + position.y * 1.3) * 0.035 * bendWeight;`,
        );
      };
      this.material.customProgramCacheKey = () => 'waterworld-seagrass-instanced-sway-v2';
      this.material.needsUpdate = true;

      this.instances = new InstancedMesh(
        this.geometry,
        this.material,
        MAX_VISIBLE_INSTANCES,
      );
      this.instances.name = 'seagrass:instanced-field';
      this.instances.count = 0;
      this.instances.castShadow = false;
      this.instances.receiveShadow = false;
      // The buffer only changes when culling is rebuilt, not for the sway itself.
      this.instances.instanceMatrix.setUsage(DynamicDrawUsage);
      // All submitted instances are already inside the short grass radius. Keeping
      // this as one draw call is cheaper and safer than recomputing a giant dynamic
      // bounding sphere every time the player crosses the cull threshold.
      this.instances.frustumCulled = false;
      this.parent.add(this.instances);
    } catch (error) {
      this.loadFailed = true;
      console.warn(
        `[vegetation] optimized seagrass asset failed to load at ${ASSET_URL}; shallow scatter disabled`,
        error,
      );
    }
  }

  populate(ctx: ChunkContentContext): void {
    if (!this.instances || this.loadFailed) return;

    const density = ctx.biome.spawnDensity.vegetation * this.densityMultiplier;
    const chunkWidth = ctx.bounds.max.x - ctx.bounds.min.x;
    const chunkDepth = ctx.bounds.max.z - ctx.bounds.min.z;
    const targetCount = Math.max(0, Math.round((chunkWidth * chunkDepth * density) / 100));
    const placements: GrassPlacement[] = [];

    if (targetCount > 0) {
      const candidates = ctx.sampleSeabedPoints(targetCount * 5, 0.82);

      for (const point of candidates) {
        if (placements.length >= targetCount) break;
        if (point.depth < 3 || point.depth > 18) continue;

        const position = point.position.clone().addScaledVector(point.normal, 0.015);
        this.dummy.position.copy(position);
        this.dummy.quaternion.setFromUnitVectors(UP, point.normal);
        this.dummy.rotateY(ctx.rng.range(0, Math.PI * 2));
        this.dummy.scale.setScalar(ctx.rng.range(0.82, 1.22));
        this.dummy.updateMatrix();

        placements.push({
          position,
          matrix: this.dummy.matrix.clone(),
          phase: ctx.rng.range(0, Math.PI * 2),
        });
      }
    }

    this.chunks.set(ctx.key, placements);
    this.layoutDirty = true;
  }

  update(dt: number, playerPosition: Vector3): void {
    if (!this.instances || !this.phaseAttribute || this.loadFailed) return;

    this.swayTime.value += MathUtils.clamp(dt, 0, 0.05);

    const dx = playerPosition.x - this.lastCullPosition.x;
    const dz = playerPosition.z - this.lastCullPosition.z;
    if (!this.layoutDirty && dx * dx + dz * dz < CULL_REBUILD_DISTANCE_SQ) return;

    this.rebuildVisibleInstances(playerPosition);
  }

  private rebuildVisibleInstances(playerPosition: Vector3): void {
    if (!this.instances || !this.phaseAttribute) return;

    let visible = 0;

    outer: for (const placements of this.chunks.values()) {
      for (const placement of placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        if (dx * dx + dz * dz > this.renderDistanceSq) continue;

        if (visible >= MAX_VISIBLE_INSTANCES) {
          if (!this.warnedCapacity) {
            this.warnedCapacity = true;
            console.warn(
              `[vegetation] visible seagrass exceeded ${MAX_VISIBLE_INSTANCES} instances; extra patches are culled`,
            );
          }
          break outer;
        }

        this.instances.setMatrixAt(visible, placement.matrix);
        this.phaseAttribute.setX(visible, placement.phase);
        visible++;
      }
    }

    this.instances.count = visible;
    this.instances.instanceMatrix.needsUpdate = true;
    this.phaseAttribute.needsUpdate = true;
    this.lastCullPosition.copy(playerPosition);
    this.layoutDirty = false;
  }

  dispose(key?: string): void {
    if (key !== undefined) {
      this.chunks.delete(key);
      this.layoutDirty = true;
      return;
    }

    this.chunks.clear();
    this.instances?.removeFromParent();
    this.geometry?.dispose();
    this.material?.dispose();
    this.instances = null;
    this.geometry = null;
    this.material = null;
    this.phaseAttribute = null;
  }
}
