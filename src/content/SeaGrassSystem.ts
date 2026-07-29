import {
  AnimationMixer,
  MathUtils,
  Object3D,
  Vector3,
  type AnimationClip,
  type Mesh,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const UP = new Vector3(0, 1, 0);
const ASSET_URL = './assets/biomes/safe-shallows/tropical_seagrass_lush_animated.glb';

/**
 * First vegetation pass for the Safe Shallows.
 *
 * The GLB is loaded once, then lightweight scene clones are scattered
 * deterministically per chunk. Geometry/material GPU resources are shared between
 * clones, while each patch gets its own morph animation state so the supplied
 * SeaGrass_Sway clip can start at a different phase.
 */
export class SeaGrassSystem implements ContentPopulator {
  readonly id = 'safe-shallows-seagrass-v1';
  readonly layer = 'vegetation' as const;
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private swayClip: AnimationClip | null = null;
  private readonly mixersByChunk = new Map<string, AnimationMixer[]>();
  private loadFailed = false;

  constructor() {
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return biome.id === 'SAFE_SHALLOWS' && biome.spawnDensity.vegetation > 0;
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      this.template = gltf.scene;
      this.swayClip = gltf.animations.find((clip) => clip.name === 'SeaGrass_Sway') ?? gltf.animations[0] ?? null;

      // Clones intentionally share the source GLB's geometry and materials. Tell
      // chunk cleanup not to dispose those shared GPU resources on every unload.
      this.template.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });
    } catch (error) {
      this.loadFailed = true;
      console.warn(
        `[vegetation] seagrass asset not found at ${ASSET_URL}; shallow scatter disabled until the GLB is added`,
        error,
      );
    }
  }

  populate(ctx: ChunkContentContext): void {
    if (!this.template || this.loadFailed) return;

    const density = ctx.biome.spawnDensity.vegetation;
    const chunkArea = ctx.bounds.max.x - ctx.bounds.min.x;
    const chunkDepth = ctx.bounds.max.z - ctx.bounds.min.z;
    const targetCount = Math.max(0, Math.round((chunkArea * chunkDepth * density) / 100));
    if (targetCount === 0) return;

    // Ask for extra candidates because this first grass species only likes the
    // brighter, gentler upper shallows. Later vegetation species can occupy the
    // rejected deeper/steeper points.
    const candidates = ctx.sampleSeabedPoints(targetCount * 5, 0.82);
    const mixers: AnimationMixer[] = [];
    let placed = 0;

    for (const point of candidates) {
      if (placed >= targetCount) break;
      if (point.depth < 3 || point.depth > 18) continue;

      const patch = this.template.clone(true);
      patch.name = `seagrass:${ctx.key}:${placed}`;
      patch.position.copy(point.position).addScaledVector(point.normal, 0.015);

      // Y-up asset -> seabed normal, then spin around its own local up axis so
      // repeated patches never present the same silhouette.
      patch.quaternion.setFromUnitVectors(UP, point.normal);
      patch.rotateY(ctx.rng.range(0, Math.PI * 2));
      const scale = ctx.rng.range(0.82, 1.22);
      patch.scale.setScalar(scale);

      patch.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        object.userData.sharedAssetResources = true;
      });

      ctx.group.add(patch);

      if (this.swayClip) {
        const mixer = new AnimationMixer(patch);
        const action = mixer.clipAction(this.swayClip);
        action.play();
        action.time = ctx.rng.range(0, Math.max(0.001, this.swayClip.duration));
        action.timeScale = ctx.rng.range(0.88, 1.12);
        mixers.push(mixer);
      }

      placed++;
    }

    if (mixers.length > 0) this.mixersByChunk.set(ctx.key, mixers);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    const safeDt = MathUtils.clamp(dt, 0, 0.05);
    for (const mixers of this.mixersByChunk.values()) {
      for (const mixer of mixers) mixer.update(safeDt);
    }
  }

  dispose(key?: string): void {
    if (key !== undefined) {
      const mixers = this.mixersByChunk.get(key);
      if (mixers) {
        for (const mixer of mixers) mixer.stopAllAction();
      }
      this.mixersByChunk.delete(key);
      return;
    }

    for (const mixers of this.mixersByChunk.values()) {
      for (const mixer of mixers) mixer.stopAllAction();
    }
    this.mixersByChunk.clear();

    // The chunk clones shared these resources, so dispose the source exactly once
    // when the whole game shuts down.
    this.template?.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) material.dispose();
      } else {
        mesh.material.dispose();
      }
    });
    this.template = null;
    this.swayClip = null;
  }
}
