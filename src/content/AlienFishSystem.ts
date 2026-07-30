import {
  AnimationMixer,
  Box3,
  Group,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { Environment } from '../environment/Environment.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { DensityField } from '../world/density.ts';

const ASSET_URL = './assets/fauna/alien_fish.glb';

// The authored fish is about 0.40 m long. Make this species visibly larger than
// the 0.25 m prism fish while keeping it believable as shallow-water fauna.
const TARGET_MAX_DIMENSION = 0.74;
const MIN_RANDOM_SCALE = 0.9;
const MAX_RANDOM_SCALE = 1.08;

// Solitary and uncommon: roughly three nearby at most, with a few retained just
// outside the population bubble so recycling never happens in the player's face.
const CELL_SIZE = 28;
const SPAWN_CHANCE = 0.24;
const INITIAL_SPAWN_MIN_RADIUS = 10;
const STREAM_SPAWN_MIN_RADIUS = 38;
const POPULATION_RADIUS = 58;
const RETIRE_RADIUS = 86;
const LOCAL_TARGET = 3;
const MAX_ACTIVE = 5;
const POPULATION_REFRESH_SECONDS = 0.85;

const WANDER_RADIUS = 7.5;
const FLEE_DISTANCE = 2.6;
const CALM_DISTANCE = 5.0;
const MIN_BOTTOM_CLEARANCE = 0.9;
const SURFACE_CLEARANCE = 1.2;

const CRUISE_SPEED_MIN = 0.48;
const CRUISE_SPEED_MAX = 0.72;
const IDLE_SPEED = 0.035;
const FLARE_SPEED = 0.02;
const FLEE_SPEED = 3.0;

const _player = new Vector3();
const _desired = new Vector3();
const _next = new Vector3();
const _lookTarget = new Vector3();
const _size = new Vector3();

function hash01(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(salt, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

type AlienFishState = 'cruise' | 'idle' | 'flare' | 'flee';

interface AlienFishInstance {
  root: Group;
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  currentAction: AnimationAction | null;
  home: Vector3;
  target: Vector3;
  direction: Vector3;
  desiredQuaternion: Quaternion;
  state: AlienFishState;
  stateTimer: number;
  fleeTimer: number;
  cruiseSpeed: number;
  phase: number;
  cellKey: string | null;
}

/**
 * Larger, rarer animated alien fish for the Safe Shallows.
 *
 * The GLB is skinned, so every live fish is cloned through SkeletonUtils rather
 * than Object3D.clone(). The authored Idle / Swim / Dart / Flare clips are used
 * as behaviour states while geometry and materials remain shared and cheap.
 */
export class AlienFishSystem {
  readonly ready: Promise<void>;

  private readonly activeFish = new Map<string, AlienFishInstance>();
  private readonly pool: AlienFishInstance[] = [];
  private readonly allFish: AlienFishInstance[] = [];
  private readonly lookHelper = new Object3D();
  private template: Object3D | null = null;
  private clips: AnimationClip[] = [];
  private baseScale = 1;
  private loadFailed = false;
  private populationTimer = 0;
  private populationInitialized = false;

  constructor(
    private readonly scene: Scene,
    private readonly density: DensityField,
    private readonly biomes: BiomeRegistry,
    private readonly environment: Environment,
    private readonly rig: PlayerRig,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      this.template = gltf.scene;
      this.clips = gltf.animations;

      this.template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
      });

      this.template.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(this.template);
      bounds.getSize(_size);
      const rawMaxDimension = Math.max(_size.x, _size.y, _size.z);
      if (!Number.isFinite(rawMaxDimension) || rawMaxDimension <= 0) {
        throw new Error('alien fish GLB has invalid bounds');
      }

      this.baseScale = TARGET_MAX_DIMENSION / rawMaxDimension;

      console.info(
        `[fauna] alien fish loaded: raw ${_size.x.toFixed(2)} x ${_size.y.toFixed(2)} x ${_size.z.toFixed(2)} m; ` +
          `display max ${(TARGET_MAX_DIMENSION * MAX_RANDOM_SCALE).toFixed(2)} m; ` +
          `clips ${this.clips.map((clip) => clip.name).join(', ') || 'none'}`,
      );
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[fauna] failed to load alien fish at ${ASSET_URL}`, error);
    }
  }

  private createFish(): AlienFishInstance {
    if (!this.template) throw new Error('alien fish template unavailable');

    // SkeletonUtils is required here: this GLB contains a SkinnedMesh and each fish
    // needs its own bone hierarchy for independent animation playback.
    const model = SkeletonUtils.clone(this.template);
    const scaleVariation = MathUtils.lerp(MIN_RANDOM_SCALE, MAX_RANDOM_SCALE, Math.random());
    model.scale.multiplyScalar(this.baseScale * scaleVariation);

    const root = new Group();
    root.name = `fauna:alien-fish-${this.allFish.length}`;
    root.visible = false;
    root.add(model);
    this.scene.add(root);

    const mixer = new AnimationMixer(model);
    const actions = new Map<string, AnimationAction>();
    for (const clip of this.clips) actions.set(clip.name, mixer.clipAction(clip));

    const fish: AlienFishInstance = {
      root,
      mixer,
      actions,
      currentAction: null,
      home: new Vector3(),
      target: new Vector3(),
      direction: new Vector3(0, 0, -1),
      desiredQuaternion: new Quaternion(),
      state: 'cruise',
      stateTimer: 0,
      fleeTimer: 0,
      cruiseSpeed: MathUtils.lerp(CRUISE_SPEED_MIN, CRUISE_SPEED_MAX, Math.random()),
      phase: Math.random() * Math.PI * 2,
      cellKey: null,
    };

    this.allFish.push(fish);
    return fish;
  }

  private acquireFish(): AlienFishInstance {
    return this.pool.pop() ?? this.createFish();
  }

  update(dt: number, elapsed: number): void {
    if (this.loadFailed || !this.template) return;

    dt = Math.min(Math.max(dt, 0), 0.05);
    this.rig.getHeadPosition(_player);

    const playerBiome = this.biomes.biomeAt(_player.x, _player.z);
    const shouldBeActive = playerBiome.id === 'SAFE_SHALLOWS' && this.environment.underwater;

    this.populationTimer -= dt;
    if (this.populationTimer <= 0) {
      this.populationTimer = POPULATION_REFRESH_SECONDS;
      this.refreshPopulation(shouldBeActive);
    }

    for (const fish of this.activeFish.values()) {
      fish.mixer.update(dt);
      this.updateFish(fish, dt, elapsed);
    }
  }

  private refreshPopulation(shouldPopulate: boolean): void {
    if (!shouldPopulate) {
      for (const key of [...this.activeFish.keys()]) this.releaseFish(key);
      this.populationInitialized = false;
      return;
    }

    const retireDistanceSq = RETIRE_RADIUS * RETIRE_RADIUS;
    for (const [key, fish] of [...this.activeFish]) {
      if (fish.root.position.distanceToSquared(_player) > retireDistanceSq) this.releaseFish(key);
    }

    let activeCount = this.activeFish.size;
    let localCount = this.localFishCount();
    if (activeCount >= MAX_ACTIVE || localCount >= LOCAL_TARGET) {
      this.populationInitialized = true;
      return;
    }

    const pcx = Math.floor(_player.x / CELL_SIZE);
    const pcz = Math.floor(_player.z / CELL_SIZE);
    const cellRadius = Math.ceil(POPULATION_RADIUS / CELL_SIZE);
    const minimumRadius = this.populationInitialized ? STREAM_SPAWN_MIN_RADIUS : INITIAL_SPAWN_MIN_RADIUS;
    const candidates: Array<{ cx: number; cz: number; distanceSq: number }> = [];

    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const centerX = (cx + 0.5) * CELL_SIZE + (hash01(cx, cz, 101) - 0.5) * CELL_SIZE * 0.72;
        const centerZ = (cz + 0.5) * CELL_SIZE + (hash01(cx, cz, 107) - 0.5) * CELL_SIZE * 0.72;
        const distanceSq = (centerX - _player.x) ** 2 + (centerZ - _player.z) ** 2;
        if (distanceSq < minimumRadius ** 2 || distanceSq > POPULATION_RADIUS ** 2) continue;
        if (hash01(cx, cz, 113) > SPAWN_CHANCE) continue;
        const key = `${cx},${cz}`;
        if (this.activeFish.has(key)) continue;
        candidates.push({ cx, cz, distanceSq });
      }
    }

    candidates.sort((a, b) =>
      this.populationInitialized ? b.distanceSq - a.distanceSq : a.distanceSq - b.distanceSq,
    );

    for (const candidate of candidates) {
      if (activeCount >= MAX_ACTIVE || localCount >= LOCAL_TARGET) break;
      if (!this.spawnCell(candidate.cx, candidate.cz)) continue;
      activeCount++;
      localCount++;
    }

    this.populationInitialized = true;
  }

  private spawnCell(cx: number, cz: number): boolean {
    const key = `${cx},${cz}`;
    if (this.activeFish.has(key)) return false;

    const x = (cx + 0.5) * CELL_SIZE + (hash01(cx, cz, 101) - 0.5) * CELL_SIZE * 0.72;
    const z = (cz + 0.5) * CELL_SIZE + (hash01(cx, cz, 107) - 0.5) * CELL_SIZE * 0.72;
    if (this.biomes.biomeAt(x, z).id !== 'SAFE_SHALLOWS') return false;

    const seabed = this.density.seabedAt(x, z);
    const minY = seabed + 1.35;
    const maxY = Math.min(this.environment.seaLevel - SURFACE_CLEARANCE, seabed + 6.5);
    if (maxY <= minY) return false;

    const y = MathUtils.lerp(minY, maxY, hash01(cx, cz, 127));
    if (this.density.sample(x, y, z) > 0) return false;

    const fish = this.acquireFish();
    fish.cellKey = key;
    fish.root.position.set(x, y, z);
    fish.home.copy(fish.root.position);

    const angle = hash01(cx, cz, 131) * Math.PI * 2;
    fish.direction.set(Math.cos(angle), (hash01(cx, cz, 137) - 0.5) * 0.1, Math.sin(angle)).normalize();
    fish.root.visible = true;
    fish.state = 'cruise';
    fish.stateTimer = MathUtils.lerp(3.5, 7.0, hash01(cx, cz, 139));
    fish.fleeTimer = 0;
    fish.currentAction = null;
    fish.cruiseSpeed = MathUtils.lerp(CRUISE_SPEED_MIN, CRUISE_SPEED_MAX, hash01(cx, cz, 149));
    this.pickTarget(fish);
    this.playBest(fish, ['Swim'], 0.05, MathUtils.lerp(0.88, 1.05, Math.random()), true);
    this.faceDirection(fish, 1);
    this.activeFish.set(key, fish);
    return true;
  }

  private releaseFish(key: string): void {
    const fish = this.activeFish.get(key);
    if (!fish) return;
    this.activeFish.delete(key);

    fish.cellKey = null;
    fish.root.visible = false;
    fish.currentAction?.stop();
    fish.currentAction = null;
    this.pool.push(fish);
  }

  private localFishCount(): number {
    const localDistanceSq = POPULATION_RADIUS * POPULATION_RADIUS;
    let count = 0;
    for (const fish of this.activeFish.values()) {
      if (fish.root.position.distanceToSquared(_player) <= localDistanceSq) count++;
    }
    return count;
  }

  private updateFish(fish: AlienFishInstance, dt: number, elapsed: number): void {
    const playerDistance = fish.root.position.distanceTo(_player);

    if (playerDistance < FLEE_DISTANCE) {
      fish.fleeTimer = 1.1;
      this.enterState(fish, 'flee');
      _desired.copy(fish.root.position).sub(_player);
      _desired.y *= 0.3;
      if (_desired.lengthSq() < 0.0001) _desired.set(Math.random() - 0.5, 0.12, Math.random() - 0.5);
      _desired.normalize();
      fish.direction.lerp(_desired, 1 - Math.exp(-9 * dt)).normalize();
    } else if (fish.state === 'flee') {
      fish.fleeTimer -= dt;
      if (fish.fleeTimer <= 0 && playerDistance > CALM_DISTANCE) {
        fish.home.copy(fish.root.position);
        this.pickTarget(fish);
        this.enterState(fish, 'cruise');
      }
    } else if (fish.state === 'idle' || fish.state === 'flare') {
      fish.stateTimer -= dt;
      if (fish.stateTimer <= 0) {
        this.pickTarget(fish);
        this.enterState(fish, 'cruise');
      }
    } else {
      fish.stateTimer -= dt;
      _desired.copy(fish.target).sub(fish.root.position);
      if (_desired.lengthSq() > 0.0001) {
        _desired.normalize();
        _desired.x += Math.sin(elapsed * 0.72 + fish.phase) * 0.028;
        _desired.y += Math.sin(elapsed * 0.95 + fish.phase * 1.6) * 0.014;
        _desired.z += Math.cos(elapsed * 0.65 + fish.phase * 0.8) * 0.028;
        _desired.normalize();
        fish.direction.lerp(_desired, 1 - Math.exp(-1.8 * dt)).normalize();
      }

      if (fish.root.position.distanceToSquared(fish.target) < 0.55 * 0.55 || fish.stateTimer <= 0) {
        const choice = Math.random();
        if (choice < 0.12) this.enterState(fish, 'flare');
        else if (choice < 0.34) this.enterState(fish, 'idle');
        else {
          this.pickTarget(fish);
          fish.stateTimer = MathUtils.lerp(3.5, 7.0, Math.random());
        }
      }
    }

    const speed =
      fish.state === 'flee'
        ? FLEE_SPEED
        : fish.state === 'idle'
          ? IDLE_SPEED
          : fish.state === 'flare'
            ? FLARE_SPEED
            : fish.cruiseSpeed;

    _next.copy(fish.root.position).addScaledVector(fish.direction, speed * dt);

    const seabed = this.density.seabedAt(_next.x, _next.z);
    const minY = seabed + MIN_BOTTOM_CLEARANCE;
    const maxY = this.environment.seaLevel - SURFACE_CLEARANCE;
    _next.y = MathUtils.clamp(_next.y, minY, maxY);

    if (minY >= maxY || this.density.sample(_next.x, _next.y, _next.z) > 0) {
      fish.direction.multiplyScalar(-1);
      fish.home.copy(fish.root.position);
      this.pickTarget(fish);
    } else {
      fish.root.position.copy(_next);
    }

    this.faceDirection(fish, dt);
  }

  private pickTarget(fish: AlienFishInstance): void {
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = WANDER_RADIUS * Math.sqrt(Math.random());
      const x = fish.home.x + Math.cos(angle) * radius;
      const z = fish.home.z + Math.sin(angle) * radius;
      const seabed = this.density.seabedAt(x, z);
      const minY = seabed + MIN_BOTTOM_CLEARANCE;
      const maxY = this.environment.seaLevel - SURFACE_CLEARANCE;
      if (maxY <= minY) continue;

      const y = MathUtils.clamp(
        fish.home.y + MathUtils.lerp(-1.8, 1.8, Math.random()),
        minY,
        maxY,
      );
      if (this.density.sample(x, y, z) > 0) continue;

      fish.target.set(x, y, z);
      return;
    }

    fish.target.copy(fish.home);
  }

  private enterState(fish: AlienFishInstance, state: AlienFishState): void {
    if (fish.state === state && fish.currentAction) return;
    fish.state = state;

    if (state === 'flee') {
      this.playBest(fish, ['Dart', 'Swim'], 0.06, 1.05, true);
      return;
    }

    if (state === 'flare') {
      fish.stateTimer = 1.8;
      this.playBest(fish, ['Flare', 'Idle'], 0.14, 1, false);
      return;
    }

    if (state === 'idle') {
      fish.stateTimer = MathUtils.lerp(1.1, 2.8, Math.random());
      this.playBest(fish, ['Idle', 'Swim'], 0.2, MathUtils.lerp(0.88, 1.04, Math.random()), true);
      return;
    }

    fish.stateTimer = MathUtils.lerp(3.5, 7.0, Math.random());
    this.playBest(fish, ['Swim', 'Idle'], 0.16, MathUtils.lerp(0.88, 1.06, Math.random()), true);
  }

  private playBest(
    fish: AlienFishInstance,
    names: readonly string[],
    fade: number,
    timeScale: number,
    repeat: boolean,
  ): void {
    let next: AnimationAction | undefined;

    for (const preferred of names) {
      next = fish.actions.get(preferred);
      if (next) break;

      const lower = preferred.toLowerCase();
      for (const [name, action] of fish.actions) {
        if (name.toLowerCase() === lower) {
          next = action;
          break;
        }
      }
      if (next) break;
    }

    next ??= fish.actions.values().next().value;
    if (!next) return;

    if (next === fish.currentAction && repeat) {
      next.timeScale = timeScale;
      return;
    }

    next.enabled = true;
    next.reset();
    next.setLoop(repeat ? LoopRepeat : LoopOnce, repeat ? Infinity : 1);
    next.clampWhenFinished = !repeat;
    next.timeScale = timeScale;
    next.setEffectiveWeight(1);
    next.play();

    if (fish.currentAction && fish.currentAction !== next) fish.currentAction.crossFadeTo(next, fade, false);
    else next.fadeIn(Math.max(0.01, fade));

    fish.currentAction = next;
  }

  private faceDirection(fish: AlienFishInstance, dt: number): void {
    if (fish.direction.lengthSq() < 0.0001) return;

    _lookTarget.copy(fish.root.position).add(fish.direction);
    this.lookHelper.position.copy(fish.root.position);
    this.lookHelper.up.set(0, 1, 0);
    this.lookHelper.lookAt(_lookTarget);

    // This asset's antennae/head sit on the -Z end of the rig, so its swimming
    // forward axis is local -Z. Object3D.lookAt points local +Z at the target.
    this.lookHelper.rotateY(Math.PI);
    fish.desiredQuaternion.copy(this.lookHelper.quaternion);

    const turnRate = fish.state === 'flee' ? 8 : 3.2;
    fish.root.quaternion.slerp(fish.desiredQuaternion, 1 - Math.exp(-turnRate * dt));
  }

  dispose(): void {
    this.activeFish.clear();
    this.pool.length = 0;

    for (const fish of this.allFish) {
      fish.mixer.stopAllAction();
      fish.root.removeFromParent();
    }
    this.allFish.length = 0;

    this.template?.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.template = null;
  }
}
