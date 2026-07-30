import {
  CanvasTexture,
  DynamicDrawUsage,
  InstancedMesh,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferGeometry,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const UP = new Vector3(0, 1, 0);

const ROCK_ASSET_URL = './assets/biomes/safe-shallows/rocks/underwater_river_boulder_01.glb';
const TEXTURE_ROOT = './assets/textures/rocks/wet-mossy-rocks';
const ALBEDO_URL = `${TEXTURE_ROOT}/wet-mossy-rocks_albedo.png`;
const NORMAL_URL = `${TEXTURE_ROOT}/wet-mossy-rocks_normal-ogl.png`;
const AO_URL = `${TEXTURE_ROOT}/wet-mossy-rocks_ao.png`;
const ROUGHNESS_URL = `${TEXTURE_ROOT}/wet-mossy-rocks_roughness.png`;
const METALLIC_URL = `${TEXTURE_ROOT}/wet-mossy-rocks_metallic.png`;

// Keep the authored source PNGs untouched in Git, but never upload more than a
// 1K version of any one rock map to the Quest GPU. If the source is already 1K
// (or smaller) this leaves it alone.
const MAX_TEXTURE_EDGE = 1024;
const MAX_VISIBLE_INSTANCES = 512;
const RENDER_DISTANCE = 118;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;
const CULL_REBUILD_DISTANCE = 3;
const CULL_REBUILD_DISTANCE_SQ = CULL_REBUILD_DISTANCE * CULL_REBUILD_DISTANCE;
const START_AREA_CLEAR_RADIUS = 18;
const START_AREA_CLEAR_RADIUS_SQ = START_AREA_CLEAR_RADIUS * START_AREA_CLEAR_RADIUS;

interface RockPlacement {
  position: Vector3;
  matrix: Object3D['matrix'];
}

/**
 * Large Safe Shallows boulders using one shared, Quest-friendly PBR material.
 *
 * The GLB supplies only silhouette/UVs. At runtime the shared texture set is
 * downsampled to at most 1K and AO + roughness + metallic are packed into one
 * ORM canvas texture (R/G/B respectively). All visible boulders are submitted
 * through one InstancedMesh, so adding more rock shapes later can remain a
 * small family of instanced draw calls rather than hundreds of Mesh objects.
 */
export class RiverRockSystem implements ContentPopulator {
  readonly id = 'safe-shallows-river-rocks-v1-pbr-instanced';
  readonly layer = 'rocks' as const;
  readonly ready: Promise<void>;

  private readonly parent: Object3D;
  private readonly chunks = new Map<string, RockPlacement[]>();
  private readonly dummy = new Object3D();
  private readonly lastCullPosition = new Vector3(Number.POSITIVE_INFINITY, 0, 0);

  private geometry: BufferGeometry | null = null;
  private material: MeshStandardMaterial | null = null;
  private instances: InstancedMesh | null = null;
  private layoutDirty = true;
  private loadFailed = false;
  private warnedCapacity = false;

  constructor(parent: Object3D) {
    this.parent = parent;
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return biome.id === 'SAFE_SHALLOWS' && biome.spawnDensity.rocks > 0;
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ROCK_ASSET_URL);
      gltf.scene.updateMatrixWorld(true);

      let sourceMesh: Mesh | null = null;
      gltf.scene.traverse((object) => {
        const mesh = object as Mesh;
        if (!sourceMesh && mesh.isMesh) sourceMesh = mesh;
      });

      if (!sourceMesh) throw new Error('River-rock GLB contains no mesh');

      const geometry = sourceMesh.geometry.clone();
      geometry.applyMatrix4(sourceMesh.matrixWorld);

      const uv = geometry.getAttribute('uv');
      if (!uv) throw new Error('River-rock GLB has no UVs');
      // AO traditionally uses UV channel 1 in three.js. Our rock uses the same
      // tileable unwrap for every map, so duplicate the authored UVs cheaply.
      if (!geometry.getAttribute('uv1')) geometry.setAttribute('uv1', uv.clone());

      const albedo = await loadReducedTexture(ALBEDO_URL, true);
      albedo.name = 'wet-mossy-rocks:albedo-1k';

      const normal = await loadReducedTexture(NORMAL_URL, false);
      normal.name = 'wet-mossy-rocks:normal-ogl-1k';

      const orm = await buildOrmTexture();
      orm.name = 'wet-mossy-rocks:orm-1k';
      // One texture is reused for all three material slots. Channel 1 selects
      // uv1; uv1 is an exact duplicate of uv, so roughness/metalness still line
      // up while AO also has the UV set expected by MeshStandardMaterial.
      orm.channel = 1;

      const material = new MeshStandardMaterial({
        map: albedo,
        normalMap: normal,
        normalScale: new Vector2(0.9, 0.9),
        aoMap: orm,
        aoMapIntensity: 0.82,
        roughness: 1,
        roughnessMap: orm,
        metalness: 1,
        metalnessMap: orm,
      });
      material.name = 'wet-mossy-rocks:pbr-shared';

      this.geometry = geometry;
      this.material = material;
      this.instances = new InstancedMesh(geometry, material, MAX_VISIBLE_INSTANCES);
      this.instances.name = 'rocks:river-boulder-instanced';
      this.instances.count = 0;
      this.instances.castShadow = false;
      this.instances.receiveShadow = false;
      this.instances.instanceMatrix.setUsage(DynamicDrawUsage);
      // CPU distance culling already keeps this field tight around the player.
      // Avoid rebuilding a giant dynamic bounding sphere every cull refresh.
      this.instances.frustumCulled = false;
      this.parent.add(this.instances);
    } catch (error) {
      this.loadFailed = true;
      console.warn('[rocks] PBR river boulder failed to load; rock scatter disabled', error);
    }
  }

  populate(ctx: ChunkContentContext): void {
    if (!this.instances || this.loadFailed) return;

    const density = ctx.biome.spawnDensity.rocks;
    const chunkWidth = ctx.bounds.max.x - ctx.bounds.min.x;
    const chunkDepth = ctx.bounds.max.z - ctx.bounds.min.z;
    const targetCount = Math.max(0, Math.round((chunkWidth * chunkDepth * density) / 100));
    const placements: RockPlacement[] = [];

    if (targetCount > 0) {
      const candidates = ctx.sampleSeabedPoints(Math.max(targetCount * 6, 8), 0.72);

      for (const point of candidates) {
        if (placements.length >= targetCount) break;
        if (point.depth < 4.5 || point.depth > 40) continue;

        const originDistanceSq =
          point.position.x * point.position.x + point.position.z * point.position.z;
        if (originDistanceSq < START_AREA_CLEAR_RADIUS_SQ) continue;

        // The model's origin is already at its flattened base. Sink it a little
        // so the boulder reads as embedded in sand rather than placed on top.
        const position = point.position
          .clone()
          .addScaledVector(point.normal, -ctx.rng.range(0.12, 0.38));

        this.dummy.position.copy(position);
        this.dummy.quaternion.setFromUnitVectors(UP, point.normal);
        this.dummy.rotateY(ctx.rng.range(0, Math.PI * 2));

        const baseScale = ctx.rng.range(0.78, 1.22);
        this.dummy.scale.set(
          baseScale * ctx.rng.range(0.9, 1.12),
          baseScale * ctx.rng.range(0.84, 1.06),
          baseScale * ctx.rng.range(0.9, 1.12),
        );
        this.dummy.updateMatrix();

        placements.push({
          position,
          matrix: this.dummy.matrix.clone(),
        });
      }
    }

    this.chunks.set(ctx.key, placements);
    this.layoutDirty = true;
  }

  update(_dt: number, playerPosition: Vector3): void {
    if (!this.instances || this.loadFailed) return;

    const dx = playerPosition.x - this.lastCullPosition.x;
    const dz = playerPosition.z - this.lastCullPosition.z;
    if (!this.layoutDirty && dx * dx + dz * dz < CULL_REBUILD_DISTANCE_SQ) return;

    this.rebuildVisibleInstances(playerPosition);
  }

  private rebuildVisibleInstances(playerPosition: Vector3): void {
    if (!this.instances) return;

    let visible = 0;

    outer: for (const placements of this.chunks.values()) {
      for (const placement of placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        if (dx * dx + dz * dz > RENDER_DISTANCE_SQ) continue;

        if (visible >= MAX_VISIBLE_INSTANCES) {
          if (!this.warnedCapacity) {
            this.warnedCapacity = true;
            console.warn(
              `[rocks] visible river boulders exceeded ${MAX_VISIBLE_INSTANCES}; extra instances are culled`,
            );
          }
          break outer;
        }

        this.instances.setMatrixAt(visible, placement.matrix);
        visible++;
      }
    }

    this.instances.count = visible;
    this.instances.instanceMatrix.needsUpdate = true;
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
    this.material?.map?.dispose();
    this.material?.normalMap?.dispose();
    // ao/roughness/metalness all share this texture, so dispose it once.
    this.material?.aoMap?.dispose();
    this.material?.dispose();
    this.instances = null;
    this.geometry = null;
    this.material = null;
  }
}

async function loadReducedTexture(url: string, srgb: boolean): Promise<CanvasTexture> {
  const image = await loadImage(url);
  const { width, height } = reducedSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error(`Could not create canvas context for ${url}`);
  ctx.drawImage(image, 0, 0, width, height);

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  if (srgb) texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

async function buildOrmTexture(): Promise<CanvasTexture> {
  const aoImage = await loadImage(AO_URL);
  const { width, height } = reducedSize(aoImage.naturalWidth, aoImage.naturalHeight);

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) throw new Error('Could not create ORM output canvas');

  const output = outputCtx.createImageData(width, height);
  for (let i = 3; i < output.data.length; i += 4) output.data[i] = 255;

  const scratchCanvas = document.createElement('canvas');
  scratchCanvas.width = width;
  scratchCanvas.height = height;
  const scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
  if (!scratchCtx) throw new Error('Could not create ORM scratch canvas');

  copyGrayscaleIntoChannel(aoImage, scratchCtx, output.data, width, height, 0);

  const roughnessImage = await loadImage(ROUGHNESS_URL);
  copyGrayscaleIntoChannel(roughnessImage, scratchCtx, output.data, width, height, 1);

  const metallicImage = await loadImage(METALLIC_URL);
  copyGrayscaleIntoChannel(metallicImage, scratchCtx, output.data, width, height, 2);

  outputCtx.putImageData(output, 0, 0);

  const texture = new CanvasTexture(outputCanvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function copyGrayscaleIntoChannel(
  image: HTMLImageElement,
  ctx: CanvasRenderingContext2D,
  output: Uint8ClampedArray,
  width: number,
  height: number,
  channel: 0 | 1 | 2,
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  const source = ctx.getImageData(0, 0, width, height).data;

  for (let i = 0; i < source.length; i += 4) {
    output[i + channel] = source[i];
  }
}

function reducedSize(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const scale = Math.min(
    1,
    MAX_TEXTURE_EDGE / Math.max(1, sourceWidth),
    MAX_TEXTURE_EDGE / Math.max(1, sourceHeight),
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load texture image: ${url}`));
    image.src = url;
  });
}
