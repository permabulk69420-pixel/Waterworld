import {
  AnimationMixer,
  MathUtils,
  Vector3,
  type AnimationClip,
  type Group,
  type Mesh,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const UP = new Vector3(0, 1, 0);
const ASSET_URL = './assets/biomes/safe-shallows/tropical_seagrass_lush_animated.glb';

const DEFAULT_RENDER_DISTANCE = 46;
const MIN_RENDER_DISTANCE = 10;
const MAX_RENDER_DISTANCE = 100;

export interface SeaGrassOptions {
  /** Multiplies the biome's base vegetation density. 1 = current authored density. */
  densityMultiplier?: number;
  /** Distance in metres at which grass is visible/created. */
  renderDistance?: number;
}

interface ActivePatch {
  object: Object3D;
  mixer: AnimationMixer | null;
}

interface GrassPlacement {
  position: Vector3;
  normal: Vector3;
  rotationY: number;
  scale: number;
  phase: number;
  timeScale: number;
  active: ActivePatch | null;
}

interface ChunkGrassState {
  group: Group;
  placements: GrassPlacement[];
}

/**
 * First vegetation pass for the Safe Shallows.
 *
 * Chunk loading only calculates cheap deterministic placement records. The GLB
 * itself is cloned on demand when the player gets close, so vegetation no longer
 * inherits the terrain's much larger streaming distance.
 */
export class SeaGrassSystem implements ContentPopulator {
  readonly id = 'safe-shallows-seagrass-v1';
  readonly layer = 'vegetation' as const;
  readonly keepsEmptyGroup = true;
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private swayClip: AnimationClip | null = null;
  private readonly chunks = new Map<string, ChunkGrassState>();
  private readonly densityMultiplier: number;
  private readonly renderDistanceSq: number;
  private readonly unloadDistanceSq: number;
  private readonly animationDistanceSq: number;
  private loadFailed = false;

  constructor(options: SeaGrassOptions = {}) {
    this.densityMultiplier = MathUtils.clamp(options.densityMultiplier ?? 1, 0, 4);

    const renderDistance = MathUtils.clamp(
      options.renderDistance ?? DEFAULT_RENDER_DISTANCE,
      MIN_RENDER_DISTANCE,
      MAX_RENDER_DISTANCE,
    );
    const unloadDistance = renderDistance + Math.max(10, renderDistance * 0.35);
    const animationDistance = Math.min(26, renderDistance * 0.6);

    this.renderDistanceSq = renderDistance * renderDistance;
    this.unloadDistanceSq = unloadDistance * unloadDistance;
    this.animationDistanceSq = animationDistance * animationDistance;
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
      this.template = gltf.scene;
      this.swayClip = gltf.animations.find((clip) => clip.name === 'SeaGrass_Sway') ?? gltf.animations[0] ?? null;

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

    const density = ctx.biome.spawnDensity.vegetation * this.densityMultiplier;
    const chunkWidth = ctx.bounds.max.x - ctx.bounds.min.x;
    const chunkDepth = ctx.bounds.max.z - ctx.bounds.min.z;
    const targetCount = Math.max(0, Math.round((chunkWidth * chunkDepth * density) / 100));
    const placements: GrassPlacement[] = [];

    if (targetCount > 0) {
      // Ask for extra candidates because this species only likes the brighter,
      // gentler upper shallows. Rejected sites remain available for later plants.
      const candidates = ctx.sampleSeabedPoints(targetCount * 5, 0.82);

      for (const point of candidates) {
        if (placements.length >= targetCount) break;
        if (point.depth < 3 || point.depth > 18) continue;

        placements.push({
          position: point.position.clone().addScaledVector(point.normal, 0.015),
          normal: point.normal.clone(),
          rotationY: ctx.rng.range(0, Math.PI * 2),
          scale: ctx.rng.range(0.82, 1.22),
          phase: this.swayClip
            ? ctx.rng.range(0, Math.max(0.001, this.swayClip.duration))
            : 0,
          timeScale: ctx.rng.range(0.88, 1.12),
          active: null,
        });
      }
    }

    this.chunks.set(ctx.key, { group: ctx.group, placements });
  }

  update(dt: number, playerPosition: Vector3): void {
    if (!this.template || this.loadFailed) return;

    const safeDt = MathUtils.clamp(dt, 0, 0.05);

    for (const chunk of this.chunks.values()) {
      for (const placement of chunk.placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        const distanceSq = dx * dx + dz * dz;

        if (!placement.active) {
          if (distanceSq <= this.renderDistanceSq) {
            placement.active = this.createPatch(chunk.group, placement);
          }
          continue;
        }

        if (distanceSq > this.unloadDistanceSq) {
          this.destroyPatch(placement.active);
          placement.active = null;
          continue;
        }

        // Hysteresis keeps a patch alive a little beyond the creation distance so
        // swimming around the cutoff does not repeatedly allocate/free GLB clones.
        placement.active.object.visible = distanceSq <= this.renderDistanceSq;

        // Morph animation is relatively CPU-heavy. Scale the animation radius down
        // with the render setting and never animate beyond 26 m.
        if (placement.active.mixer && distanceSq <= this.animationDistanceSq) {
          placement.active.mixer.update(safeDt);
        }
      }
    }
  }

  private createPatch(group: Group, placement: GrassPlacement): ActivePatch {
    if (!this.template) throw new Error('Seagrass template is not loaded');

    const patch = this.template.clone(true);
    patch.position.copy(placement.position);
    patch.quaternion.setFromUnitVectors(UP, placement.normal);
    patch.rotateY(placement.rotationY);
    patch.scale.setScalar(placement.scale);

    // The current generic chunk disposer assumes content owns its GPU resources.
    // Clone them only for nearby active patches; distant chunks hold placement
    // records instead of invisible GLB copies.
    patch.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.geometry = mesh.geometry.clone();
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((material) => material.clone());
      } else {
        mesh.material = mesh.material.clone();
      }
    });

    group.add(patch);

    let mixer: AnimationMixer | null = null;
    if (this.swayClip) {
      mixer = new AnimationMixer(patch);
      const action = mixer.clipAction(this.swayClip);
      action.play();
      action.time = placement.phase;
      action.timeScale = placement.timeScale;
    }

    return { object: patch, mixer };
  }

  private destroyPatch(active: ActivePatch): void {
    active.mixer?.stopAllAction();
    active.object.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) material.dispose();
      } else {
        mesh.material.dispose();
      }
    });
    active.object.removeFromParent();
  }

  dispose(key?: string): void {
    if (key !== undefined) {
      const chunk = this.chunks.get(key);
      if (chunk) {
        for (const placement of chunk.placements) {
          if (placement.active) this.destroyPatch(placement.active);
          placement.active = null;
        }
      }
      this.chunks.delete(key);
      return;
    }

    for (const chunk of this.chunks.values()) {
      for (const placement of chunk.placements) {
        if (placement.active) this.destroyPatch(placement.active);
      }
    }
    this.chunks.clear();

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
