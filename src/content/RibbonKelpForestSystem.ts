import {
  BufferAttribute,
  DoubleSide,
  InstancedMesh,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Sphere,
  StaticDrawUsage,
  Vector3,
  type BufferGeometry,
  type Matrix4,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { CollisionWorld } from '../physics/CollisionWorld.ts';
import { ChunkCollider } from '../physics/ChunkCollider.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const ASSET_URLS = [
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_v1.glb',
  './assets/biomes/safe-shallows/alien_ribbon_kelp_patch_lowpoly_var_b_v1.glb',
] as const;

const UP = new Vector3(0, 1, 0);
const GROWTH_UP = new Vector3();

// The authored patch is only about 5.7 m tall. Shallow kelp stays in the 9-16 m
// range, but deep-edge specimens increasingly scale toward the surface while
// preserving the source asset's original proportions in every axis.
const MIN_TARGET_HEIGHT = 9;
const MAX_TARGET_HEIGHT = 16;
const DEEP_HEIGHT_START = 14;
const DEEP_HEIGHT_FULL = 34;
const DEEP_SURFACE_GAP_MIN = 1.3;
const DEEP_SURFACE_GAP_MAX = 3.8;
const MAX_DEEP_TARGET_HEIGHT = 46;

// Deep water uses fewer, genuinely larger plants. Uniform runtime scaling keeps
// the authored width:height ratio instead of turning giant specimens into poles.
const DEEP_DENSITY_MULTIPLIER = 0.36;
const BASE_SINK = 0.18;
const MAX_BASE_TILT_DEGREES = 12;

// Kelp occupies almost the full outer chunk ring. The final few metres are left
// clear so no instance base hangs over the temporary terrain edge.
const FOREST_INNER_DEPTH = 60;
const FOREST_OUTER_MARGIN = 3;
const PATCHES_PER_SQUARE_METRE = 0.04;

// Chunk clusters outside this range are hidden. Inside it, normal Three.js
// frustum culling rejects clusters behind the player without rebuilding buffers.
const RENDER_DISTANCE = 240;
const CULL_REBUILD_DISTANCE = 4;
const CULL_REBUILD_DISTANCE_SQ = CULL_REBUILD_DISTANCE * CULL_REBUILD_DISTANCE;
const SWAY_BOUNDS_MARGIN = 0.9;

// A single invisible boundary sits near the back of the forest. The plants
// provide the readable wall; four rectangles provide reliable collision.
const BARRIER_INSET = 8;
const BARRIER_KEY_PREFIX = 'kelp-edge-barrier';

interface KelpSource {
  geometry: BufferGeometry;
  material: MeshStandardMaterial;
  height: number;
}

interface KelpCluster {
  group: Object3D;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  meshes: InstancedMesh[];
}

/**
 * Dense ribbon-kelp transition forest around the currently authored biome.
 *
 * Each loaded perimeter chunk owns at most two InstancedMeshes (one per source
 * variation). Geometry and materials are shared across every chunk, sway is
 * performed in the vertex shader, and each chunk keeps a conservative bounding
 * sphere so the renderer's ordinary frustum culling remains useful.
 */
export class RibbonKelpForestSystem implements ContentPopulator {
  readonly id = 'safe-shallows-ribbon-kelp-edge-forest-v1';
  readonly layer = 'vegetation' as const;
  readonly ready: Promise<void>;

  private readonly config: WorldConfig;
  private readonly collision: CollisionWorld;
  private readonly sources: KelpSource[] = [];
  private readonly clusters = new Map<string, KelpCluster>();
  private readonly dummy = new Object3D();
  private readonly lastCullPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);
  private readonly swayTime = { value: 0 };
  private readonly barrierKeys: string[] = [];

  private loadFailed = false;
  private layoutDirty = true;

  constructor(config: WorldConfig, collision: CollisionWorld) {
    this.config = config;
    this.collision = collision;
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return biome.id === 'SAFE_SHALLOWS' && this.config.playableBounds !== null;
  }

  private async load(): Promise<void> {
    try {
      const loader = new GLTFLoader();
      const loaded = await Promise.all(
        ASSET_URLS.map((url, index) => this.loadSource(loader, url, index)),
      );
      this.sources.push(...loaded);
      this.installBoundaryCollision();
    } catch (error) {
      this.loadFailed = true;
      console.warn('[vegetation] ribbon-kelp edge forest failed to load', error);
    }
  }

  private async loadSource(
    loader: GLTFLoader,
    url: string,
    index: number,
  ): Promise<KelpSource> {
    const gltf = await loader.loadAsync(url);
    gltf.scene.updateMatrixWorld(true);

    const meshes: Mesh[] = [];
    gltf.scene.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });

    if (meshes.length !== 1) {
      throw new Error(`${url} must contain exactly one mesh; found ${meshes.length}`);
    }

    const sourceMesh = meshes[0];
    if (Array.isArray(sourceMesh.material)) {
      throw new Error(`${url} must use exactly one material`);
    }
    if (!(sourceMesh.material instanceof MeshStandardMaterial)) {
      throw new Error(`${url} material is not MeshStandardMaterial-compatible`);
    }

    const geometry = sourceMesh.geometry.clone();
    geometry.applyMatrix4(sourceMesh.matrixWorld);
    geometry.computeBoundingBox();

    const bounds = geometry.boundingBox;
    if (!bounds) throw new Error(`${url} has no geometry bounds`);
    const height = Math.max(0.001, bounds.max.y - bounds.min.y);

    // The GLBs carry a custom _SWAY scalar. GLTFLoader lower-cases custom
    // semantics in some releases, so normalise whichever spelling arrived.
    const authoredSway =
      geometry.getAttribute('_sway') ??
      geometry.getAttribute('_SWAY') ??
      geometry.getAttribute('sway');

    if (authoredSway) {
      geometry.setAttribute('kelpSway', authoredSway.clone());
    } else {
      const position = geometry.getAttribute('position');
      const sway = new Float32Array(position.count);
      for (let i = 0; i < position.count; i++) {
        sway[i] = MathUtils.clamp((position.getY(i) - bounds.min.y) / height, 0, 1);
      }
      geometry.setAttribute('kelpSway', new BufferAttribute(sway, 1));
    }

    const material = sourceMesh.material.clone();
    material.name = `ribbon-kelp-edge:${index === 0 ? 'a' : 'b'}`;
    material.side = DoubleSide;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    material.vertexColors = geometry.getAttribute('color') !== undefined;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uRibbonKelpTime = this.swayTime;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
attribute float kelpSway;
uniform float uRibbonKelpTime;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
  float kelpPhase = fract(
    sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453
  ) * 6.2831853;
#else
  float kelpPhase = 0.0;
#endif
  float kelpWeight = clamp(kelpSway, 0.0, 1.0);
  kelpWeight *= kelpWeight;
  float kelpWaveA = sin(
    uRibbonKelpTime * 0.72 + kelpPhase + position.y * 0.16 + position.z * 0.12
  );
  float kelpWaveB = cos(
    uRibbonKelpTime * 0.49 + kelpPhase * 1.37 + position.y * 0.11 + position.x * 0.18
  );
  transformed.x += kelpWaveA * 0.42 * kelpWeight;
  transformed.z += kelpWaveB * 0.29 * kelpWeight;`,
      );
    };
    material.customProgramCacheKey = () => `waterworld-ribbon-kelp-sway-v1-${index}`;
    material.needsUpdate = true;

    return { geometry, material, height };
  }

  populate(ctx: ChunkContentContext): void {
    if (this.loadFailed || this.sources.length !== ASSET_URLS.length) return;
    if (!this.isBoundaryChunk(ctx.cx, ctx.cz)) return;

    const chunkWidth = ctx.bounds.max.x - ctx.bounds.min.x;
    const chunkDepth = ctx.bounds.max.z - ctx.bounds.min.z;
    const candidateCount = Math.ceil(
      chunkWidth * chunkDepth * PATCHES_PER_SQUARE_METRE,
    );
    const candidates = ctx.sampleSeabedPoints(candidateCount, 0.62);
    const matricesByVariant: [Matrix4[], Matrix4[]] = [[], []];
    const maxTilt = MathUtils.degToRad(MAX_BASE_TILT_DEGREES);

    for (const point of candidates) {
      const edgeDistance = this.distanceToOuterEdge(point.position.x, point.position.z);
      if (edgeDistance < FOREST_OUTER_MARGIN || edgeDistance > FOREST_INNER_DEPTH) continue;
      if (point.depth < 3.5 || point.depth > 50) continue;

      const deepLinear = MathUtils.clamp(
        (point.depth - DEEP_HEIGHT_START) / (DEEP_HEIGHT_FULL - DEEP_HEIGHT_START),
        0,
        1,
      );
      const deepFactor = deepLinear * deepLinear * (3 - 2 * deepLinear);
      const keepProbability = MathUtils.lerp(1, DEEP_DENSITY_MULTIPLIER, deepFactor);
      if (!ctx.rng.chance(keepProbability)) continue;

      const variant = ctx.rng.chance(0.5) ? 0 : 1;
      const source = this.sources[variant];

      const shallowHeight = ctx.rng.range(MIN_TARGET_HEIGHT, MAX_TARGET_HEIGHT);
      const nearSurfaceHeight = Math.min(
        MAX_DEEP_TARGET_HEIGHT,
        Math.max(
          shallowHeight,
          point.depth - ctx.rng.range(DEEP_SURFACE_GAP_MIN, DEEP_SURFACE_GAP_MAX),
        ),
      );
      const requestedHeight = MathUtils.lerp(shallowHeight, nearSurfaceHeight, deepFactor);
      const waterLimitedHeight = Math.max(4.2, point.depth - ctx.rng.range(0.35, 0.9));
      const targetHeight = Math.min(requestedHeight, waterLimitedHeight);
      const uniformScale = targetHeight / source.height;

      // The holdfast can attach to a sloping seabed, but the organism itself is
      // buoyant/phototropic and should still grow upward. Limit the whole patch to
      // a small lean instead of rotating it fully onto the terrain normal.
      const horizontalNormal = Math.hypot(point.normal.x, point.normal.z);
      if (horizontalNormal <= 1e-5) {
        GROWTH_UP.copy(UP);
      } else {
        const sourceTilt = Math.atan2(horizontalNormal, Math.max(1e-5, point.normal.y));
        const limitedTilt = Math.min(sourceTilt, maxTilt);
        const horizontalWeight = Math.sin(limitedTilt) / horizontalNormal;
        GROWTH_UP.set(
          point.normal.x * horizontalWeight,
          Math.cos(limitedTilt),
          point.normal.z * horizontalWeight,
        ).normalize();
      }

      // Sink the chunky authored holdfast/base into the seabed so only the organic
      // transition into the ribbons is visible above the terrain.
      this.dummy.position.copy(point.position);
      this.dummy.position.y -= BASE_SINK;
      this.dummy.quaternion.setFromUnitVectors(UP, GROWTH_UP);
      this.dummy.rotateY(ctx.rng.range(0, Math.PI * 2));
      this.dummy.scale.setScalar(uniformScale);
      this.dummy.updateMatrix();
      matricesByVariant[variant].push(this.dummy.matrix.clone());
    }

    const meshes: InstancedMesh[] = [];
    for (let variant = 0; variant < this.sources.length; variant++) {
      const matrices = matricesByVariant[variant];
      if (matrices.length === 0) continue;

      const source = this.sources[variant];
      const instances = new InstancedMesh(
        source.geometry,
        source.material,
        matrices.length,
      );
      instances.name = `ribbon-kelp:${ctx.key}:${variant === 0 ? 'a' : 'b'}`;
      instances.count = matrices.length;
      instances.castShadow = false;
      instances.receiveShadow = false;
      instances.frustumCulled = true;
      instances.instanceMatrix.setUsage(StaticDrawUsage);

      for (let i = 0; i < matrices.length; i++) instances.setMatrixAt(i, matrices[i]);
      instances.instanceMatrix.needsUpdate = true;

      // Three computes an instance-aware cluster bound. Expand it slightly so
      // shader displacement at the frustum edge never clips swaying tips.
      instances.computeBoundingBox();
      instances.boundingBox?.expandByScalar(SWAY_BOUNDS_MARGIN);
      instances.boundingSphere = new Sphere();
      instances.boundingBox?.getBoundingSphere(instances.boundingSphere);

      ctx.group.add(instances);
      meshes.push(instances);
    }

    if (meshes.length === 0) return;

    const cluster: KelpCluster = {
      group: ctx.group,
      minX: ctx.origin.x,
      maxX: ctx.origin.x + chunkWidth,
      minZ: ctx.origin.z,
      maxZ: ctx.origin.z + chunkDepth,
      meshes,
    };
    this.clusters.set(ctx.key, cluster);
    this.layoutDirty = true;
  }

  update(dt: number, playerPosition: Vector3): void {
    if (this.loadFailed) return;
    this.swayTime.value += MathUtils.clamp(dt, 0, 0.05);

    const dx = playerPosition.x - this.lastCullPosition.x;
    const dz = playerPosition.z - this.lastCullPosition.z;
    if (!this.layoutDirty && dx * dx + dz * dz < CULL_REBUILD_DISTANCE_SQ) return;

    for (const cluster of this.clusters.values()) {
      const nearestX = MathUtils.clamp(playerPosition.x, cluster.minX, cluster.maxX);
      const nearestZ = MathUtils.clamp(playerPosition.z, cluster.minZ, cluster.maxZ);
      const cdx = playerPosition.x - nearestX;
      const cdz = playerPosition.z - nearestZ;
      cluster.group.visible = cdx * cdx + cdz * cdz <= RENDER_DISTANCE * RENDER_DISTANCE;
    }

    this.lastCullPosition.copy(playerPosition);
    this.layoutDirty = false;
  }

  dispose(key?: string): void {
    if (key !== undefined) {
      const cluster = this.clusters.get(key);
      if (!cluster) return;

      // ContentRegistry disposes the chunk group after this callback. Detach
      // shared geometry/material users first so one streamed chunk cannot
      // dispose resources still used by every other chunk.
      for (const mesh of cluster.meshes) mesh.removeFromParent();
      this.clusters.delete(key);
      this.layoutDirty = true;
      return;
    }

    for (const cluster of this.clusters.values()) {
      for (const mesh of cluster.meshes) mesh.removeFromParent();
    }
    this.clusters.clear();
    for (const source of this.sources) {
      source.geometry.dispose();
      source.material.dispose();
    }
    this.sources.length = 0;
    for (const keyName of this.barrierKeys) this.collision.remove(keyName);
    this.barrierKeys.length = 0;
  }

  private isBoundaryChunk(cx: number, cz: number): boolean {
    const bounds = this.config.playableBounds;
    if (!bounds) return false;
    return (
      cx === -bounds.halfChunksX ||
      cx === bounds.halfChunksX ||
      cz === -bounds.halfChunksZ ||
      cz === bounds.halfChunksZ
    );
  }

  private distanceToOuterEdge(x: number, z: number): number {
    const bounds = this.config.playableBounds;
    if (!bounds) return Number.POSITIVE_INFINITY;

    const minX = -bounds.halfChunksX * this.config.chunkSize;
    const maxX = (bounds.halfChunksX + 1) * this.config.chunkSize;
    const minZ = -bounds.halfChunksZ * this.config.chunkSize;
    const maxZ = (bounds.halfChunksZ + 1) * this.config.chunkSize;
    return Math.min(x - minX, maxX - x, z - minZ, maxZ - z);
  }

  private installBoundaryCollision(): void {
    const bounds = this.config.playableBounds;
    if (!bounds) return;

    const outerMinX = -bounds.halfChunksX * this.config.chunkSize;
    const outerMaxX = (bounds.halfChunksX + 1) * this.config.chunkSize;
    const outerMinZ = -bounds.halfChunksZ * this.config.chunkSize;
    const outerMaxZ = (bounds.halfChunksZ + 1) * this.config.chunkSize;

    const minX = outerMinX + BARRIER_INSET;
    const maxX = outerMaxX - BARRIER_INSET;
    const minZ = outerMinZ + BARRIER_INSET;
    const maxZ = outerMaxZ - BARRIER_INSET;
    const minY = this.config.worldMinY - 2;
    // Cover the current authored vertical envelope too, so a lift bladder
    // cannot carry the player over the temporary world boundary into empty
    // space. This wall is removed when the system is disposed and can disappear
    // entirely once neighbouring biome chunks replace the temporary edge.
    const maxY = this.config.worldMaxY + 8;

    const walls: readonly (readonly number[])[] = [
      // West: inward normal +X.
      [
        minX, minY, minZ,
        minX, maxY, minZ,
        minX, maxY, maxZ,
        minX, minY, maxZ,
      ],
      // East: inward normal -X.
      [
        maxX, minY, maxZ,
        maxX, maxY, maxZ,
        maxX, maxY, minZ,
        maxX, minY, minZ,
      ],
      // North: inward normal +Z.
      [
        minX, minY, minZ,
        maxX, minY, minZ,
        maxX, maxY, minZ,
        minX, maxY, minZ,
      ],
      // South: inward normal -Z.
      [
        maxX, minY, maxZ,
        minX, minY, maxZ,
        minX, maxY, maxZ,
        maxX, maxY, maxZ,
      ],
    ];

    const suffixes = ['west', 'east', 'north', 'south'] as const;
    for (let i = 0; i < walls.length; i++) {
      const key = `${BARRIER_KEY_PREFIX}:${suffixes[i]}`;
      this.collision.add(key, createWallCollider(walls[i]));
      this.barrierKeys.push(key);
    }
  }
}

function createWallCollider(vertices: readonly number[]): ChunkCollider {
  const positions = new Float32Array(vertices);
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }

  return new ChunkCollider(
    0,
    0,
    positions,
    indices,
    [minX, minY, minZ],
    [maxX, maxY, maxZ],
    8,
  );
}
