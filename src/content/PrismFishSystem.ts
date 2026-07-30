import {
  AnimationMixer,
  Box3,
  Color,
  Group,
  LoopRepeat,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
  type AnimationClip,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { DensityField } from '../world/density.ts';
import type { Environment } from '../environment/Environment.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';

const ASSET_URL = './assets/fauna/prism_disc_glow_fish_animated.glb';

// The supplied GLB is roughly 0.76 m on its longest axis. Keep this species
// firmly in the little tropical-fish range even if a later export changes scale.
const TARGET_MAX_DIMENSION = 0.25;
const MAX_RANDOM_SCALE = 1.06;

// Stream schools by world cell rather than keeping a fixed boot-time population.
// The wide hysteresis between the 52 m population bubble and 80 m retirement
// radius is deliberate: old schools linger well behind the player while new
// schools enter far away, making recycling practically impossible to notice.
const CELL_SIZE = 14;
const SPAWN_CHANCE = 0.42;
const INITIAL_SPAWN_MIN_RADIUS = 7;
const STREAM_SPAWN_MIN_RADIUS = 32;
const POPULATION_RADIUS = 52;
const RETIRE_RADIUS = 80;
const LOCAL_TARGET = 15;
const MAX_ACTIVE = 24;
const POPULATION_REFRESH_SECONDS = 0.75;
const SCHOOL_SIZE_MIN = 2;
const SCHOOL_SIZE_MAX = 3;
const SCHOOL_SPREAD = 1.25;

const WANDER_RADIUS = 4.5;
const FLEE_DISTANCE = 1.7;
const CALM_DISTANCE = 3.4;
const MIN_BOTTOM_CLEARANCE = 0.65;
const SURFACE_CLEARANCE = 0.9;

const CRUISE_SPEED_MIN = 0.34;
const CRUISE_SPEED_MAX = 0.52;
const IDLE_SPEED = 0.07;
const FLEE_SPEED = 2.1;

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

type FishState = 'cruise' | 'idle' | 'flee';

interface FishInstance {
  root: Group;
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  currentAction: AnimationAction | null;
  glowMaterials: MeshStandardMaterial[];
  home: Vector3;
  target: Vector3;
  direction: Vector3;
  desiredQuaternion: Quaternion;
  state: FishState;
  stateTimer: number;
  fleeTimer: number;
  cruiseSpeed: number;
  phase: number;
  cellKey: string | null;
}

/**
 * Small animated ambient fish for the Safe Shallows.
 *
 * Schools are streamed from deterministic world cells instead of existing as a
 * fixed set attached to the player. A large retain radius keeps schools alive
 * behind the player, while replacements enter far ahead. Individual fish keep
 * their existing wander, idle, glow and close-range scurry behaviour.
 */
export class PrismFishSystem {
  readonly ready: Promise<void>;

  private readonly activeSchools = new Map<string, FishInstance[]>();
  private readonly pool: FishInstance[] = [];
  private readonly allFish: FishInstance[] = [];
  private readonly lookHelper = new Object3D();
  private readonly glowColor = new Color();
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

      this.template.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(this.template);
      bounds.getSize(_size);
      const rawMaxDimension = Math.max(_size.x, _size.y, _size.z);
      if (!Number.isFinite(rawMaxDimension) || rawMaxDimension <= 0) {
        throw new Error('fish GLB has invalid bounds');
      }

      this.baseScale = TARGET_MAX_DIMENSION / rawMaxDimension;

      console.info(
        `[fauna] prism fish loaded: raw ${_size.x.toFixed(2)} x ${_size.y.toFixed(2)} x ${_size.z.toFixed(2)} m; ` +
          `display max ${(TARGET_MAX_DIMENSION * MAX_RANDOM_SCALE).toFixed(2)} m; streamed population`,
      );
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[fauna] failed to load prism fish at ${ASSET_URL}`, error);
    }
  }

  private createFish(): FishInstance {
    if (!this.template) throw new Error('prism fish template unavailable');

    const model = this.template.clone(true);
    const scaleVariation = MathUtils.lerp(0.88, MAX_RANDOM_SCALE, Math.random());
    model.scale.multiplyScalar(this.baseScale * scaleVariation);

    const glowMaterials: MeshStandardMaterial[] = [];
    model.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.castShadow = false;
      object.receiveShadow = false;

      const original = object.material;
      if (Array.isArray(original)) {
        object.material = original.map((material) => material.clone());
      } else {
        object.material = original.clone();
      }

      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial && material.name === 'MAT_BioGlow') {
          glowMaterials.push(material);
        }
      }
    });

    const root = new Group();
    root.name = `fauna:prism-fish-${this.allFish.length}`;
    root.visible = false;
    root.add(model);
    this.scene.add(root);

    const mixer = new AnimationMixer(model);
    const actions = new Map<string, AnimationAction>();
    for (const clip of this.clips) actions.set(clip.name, mixer.clipAction(clip));

    const fish: FishInstance = {
      root,
      mixer,
      actions,
      currentAction: null,
      glowMaterials,
      home: new Vector3(),
      target: new Vector3(),
      direction: new Vector3(0, 0, 1),
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

  private acquireFish(): FishInstance {
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

    for (const school of this.activeSchools.values()) {
      for (const fish of school) {
        fish.mixer.update(dt);
        this.updateFish(fish, dt, elapsed);
      }
    }
  }

  private refreshPopulation(shouldPopulate: boolean): void {
    if (!shouldPopulate) {
      for (const key of [...this.activeSchools.keys()]) this.releaseSchool(key);
      this.populationInitialized = false;
      return;
    }

    const retireDistanceSq = RETIRE_RADIUS * RETIRE_RADIUS;
    for (const [key, school] of [...this.activeSchools]) {
      if (school.every((fish) => fish.root.position.distanceToSquared(_player) > retireDistanceSq)) {
        this.releaseSchool(key);
      }
    }

    let activeCount = this.activeFishCount();
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
        const centerX = (cx + 0.5) * CELL_SIZE + (hash01(cx, cz, 11) - 0.5) * CELL_SIZE * 0.7;
        const centerZ = (cz + 0.5) * CELL_SIZE + (hash01(cx, cz, 17) - 0.5) * CELL_SIZE * 0.7;
        const distanceSq = (centerX - _player.x) ** 2 + (centerZ - _player.z) ** 2;
        if (distanceSq < minimumRadius ** 2 || distanceSq > POPULATION_RADIUS ** 2) continue;
        if (hash01(cx, cz, 23) > SPAWN_CHANCE) continue;
        const key = `${cx},${cz}`;
        if (this.activeSchools.has(key)) continue;
        candidates.push({ cx, cz, distanceSq });
      }
    }

    // First load fills from nearby cells so there is life around the spawn. Later
    // fills prefer the outer edge, putting replacement schools in before the player
    // reaches them instead of visibly materialising nearby.
    candidates.sort((a, b) =>
      this.populationInitialized ? b.distanceSq - a.distanceSq : a.distanceSq - b.distanceSq,
    );

    for (const candidate of candidates) {
      if (activeCount >= MAX_ACTIVE || localCount >= LOCAL_TARGET) break;
      const spawned = this.spawnCell(candidate.cx, candidate.cz, MAX_ACTIVE - activeCount);
      activeCount += spawned;
      localCount += spawned;
    }

    this.populationInitialized = true;
  }

  private spawnCell(cx: number, cz: number, capacity: number): number {
    if (capacity <= 0) return 0;
    const key = `${cx},${cz}`;
    if (this.activeSchools.has(key)) return 0;

    const centerX = (cx + 0.5) * CELL_SIZE + (hash01(cx, cz, 11) - 0.5) * CELL_SIZE * 0.7;
    const centerZ = (cz + 0.5) * CELL_SIZE + (hash01(cx, cz, 17) - 0.5) * CELL_SIZE * 0.7;
    if (this.biomes.biomeAt(centerX, centerZ).id !== 'SAFE_SHALLOWS') return 0;

    const desiredSize = SCHOOL_SIZE_MIN + Math.floor(hash01(cx, cz, 29) * (SCHOOL_SIZE_MAX - SCHOOL_SIZE_MIN + 1));
    const schoolSize = Math.min(desiredSize, capacity);
    const school: FishInstance[] = [];

    for (let member = 0; member < schoolSize; member++) {
      const angle = hash01(cx, cz, 41 + member * 7) * Math.PI * 2;
      const radius = Math.sqrt(hash01(cx, cz, 43 + member * 7)) * SCHOOL_SPREAD;
      const x = centerX + Math.cos(angle) * radius;
      const z = centerZ + Math.sin(angle) * radius;
      const seabed = this.density.seabedAt(x, z);
      const minY = seabed + 1.0;
      const maxY = Math.min(this.environment.seaLevel - SURFACE_CLEARANCE, seabed + 4.5);
      if (maxY <= minY) continue;

      const y = MathUtils.lerp(minY, maxY, hash01(cx, cz, 47 + member * 7));
      if (this.density.sample(x, y, z) > 0) continue;

      const fish = this.acquireFish();
      fish.cellKey = key;
      fish.root.position.set(x, y, z);
      fish.home.copy(fish.root.position);
      fish.direction
        .set(
          Math.cos(angle + Math.PI * 0.5),
          (hash01(cx, cz, 53 + member * 7) - 0.5) * 0.12,
          Math.sin(angle + Math.PI * 0.5),
        )
        .normalize();
      fish.root.visible = true;
      fish.state = 'cruise';
      fish.stateTimer = MathUtils.lerp(2.5, 5.0, hash01(cx, cz, 59 + member * 7));
      fish.fleeTimer = 0;
      fish.currentAction = null;
      this.pickTarget(fish);
      this.playBest(fish, ['Swim_Cruise', 'Swim_Loop'], 0.05, MathUtils.lerp(0.9, 1.08, Math.random()));
      this.faceDirection(fish, 1);
      school.push(fish);
    }

    if (school.length === 0) return 0;
    this.activeSchools.set(key, school);
    return school.length;
  }

  private releaseSchool(key: string): void {
    const school = this.activeSchools.get(key);
    if (!school) return;
    this.activeSchools.delete(key);

    for (const fish of school) {
      fish.cellKey = null;
      fish.root.visible = false;
      fish.currentAction?.stop();
      fish.currentAction = null;
      this.pool.push(fish);
    }
  }

  private activeFishCount(): number {
    let count = 0;
    for (const school of this.activeSchools.values()) count += school.length;
    return count;
  }

  private localFishCount(): number {
    const localDistanceSq = POPULATION_RADIUS * POPULATION_RADIUS;
    let count = 0;
    for (const school of this.activeSchools.values()) {
      for (const fish of school) {
        if (fish.root.position.distanceToSquared(_player) <= localDistanceSq) count++;
      }
    }
    return count;
  }

  private updateFish(fish: FishInstance, dt: number, elapsed: number): void {
    const playerDistanceSq = fish.root.position.distanceToSquared(_player);
    const playerDistance = Math.sqrt(playerDistanceSq);

    if (playerDistance < FLEE_DISTANCE) {
      fish.fleeTimer = 1.0;
      this.enterState(fish, 'flee');
      _desired.copy(fish.root.position).sub(_player);
      _desired.y *= 0.35;
      if (_desired.lengthSq() < 0.0001) _desired.set(Math.random() - 0.5, 0.1, Math.random() - 0.5);
      _desired.normalize();
      fish.direction.lerp(_desired, 1 - Math.exp(-10 * dt)).normalize();
    } else if (fish.state === 'flee') {
      fish.fleeTimer -= dt;
      if (fish.fleeTimer <= 0 && playerDistance > CALM_DISTANCE) {
        fish.home.copy(fish.root.position);
        this.pickTarget(fish);
        this.enterState(fish, 'cruise');
      }
    } else {
      fish.stateTimer -= dt;

      if (fish.state === 'idle') {
        if (fish.stateTimer <= 0) {
          this.pickTarget(fish);
          this.enterState(fish, 'cruise');
        }
      } else {
        _desired.copy(fish.target).sub(fish.root.position);
        if (_desired.lengthSq() > 0.0001) {
          _desired.normalize();
          _desired.x += Math.sin(elapsed * 1.1 + fish.phase) * 0.035;
          _desired.y += Math.sin(elapsed * 1.45 + fish.phase * 1.7) * 0.018;
          _desired.z += Math.cos(elapsed * 0.95 + fish.phase * 0.8) * 0.035;
          _desired.normalize();
          fish.direction.lerp(_desired, 1 - Math.exp(-2.2 * dt)).normalize();
        }

        if (fish.root.position.distanceToSquared(fish.target) < 0.35 * 0.35 || fish.stateTimer <= 0) {
          if (Math.random() < 0.25) this.enterState(fish, 'idle');
          else {
            this.pickTarget(fish);
            fish.stateTimer = MathUtils.lerp(2.4, 5.2, Math.random());
          }
        }
      }
    }

    const speed = fish.state === 'flee' ? FLEE_SPEED : fish.state === 'idle' ? IDLE_SPEED : fish.cruiseSpeed;
    _next.copy(fish.root.position).addScaledVector(fish.direction, speed * dt);

    const seabed = this.density.seabedAt(_next.x, _next.z);
    const minY = seabed + MIN_BOTTOM_CLEARANCE;
    const maxY = this.environment.seaLevel - SURFACE_CLEARANCE;
    _next.y = MathUtils.clamp(_next.y, minY, maxY);

    if (minY >= maxY || this.density.sample(_next.x, _next.y, _next.z) > 0) {
      fish.direction.multiplyScalar(-1);
      this.pickTarget(fish);
    } else {
      fish.root.position.copy(_next);
    }

    this.faceDirection(fish, dt);
    this.updateGlow(fish, elapsed);
  }

  private pickTarget(fish: FishInstance): void {
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
        fish.home.y + MathUtils.lerp(-1.3, 1.3, Math.random()),
        minY,
        maxY,
      );
      if (this.density.sample(x, y, z) > 0) continue;

      fish.target.set(x, y, z);
      return;
    }

    fish.target.copy(fish.home);
  }

  private enterState(fish: FishInstance, state: FishState): void {
    if (fish.state === state && fish.currentAction) return;
    fish.state = state;

    if (state === 'flee') {
      this.playBest(fish, ['Scurry_Burst', 'Swim_Cruise', 'Swim_Loop'], 0.08, 1.28);
      return;
    }

    if (state === 'idle') {
      fish.stateTimer = MathUtils.lerp(0.8, 2.0, Math.random());
      this.playBest(fish, ['Swim_Idle', 'Swim_Loop'], 0.22, 0.78);
      return;
    }

    fish.stateTimer = MathUtils.lerp(2.4, 5.2, Math.random());
    this.playBest(fish, ['Swim_Cruise', 'Swim_Loop'], 0.18, MathUtils.lerp(0.92, 1.08, Math.random()));
  }

  private playBest(fish: FishInstance, names: readonly string[], fade: number, timeScale: number): void {
    let next: AnimationAction | undefined;
    for (const name of names) {
      next = fish.actions.get(name);
      if (next) break;
    }
    if (!next) return;

    if (next === fish.currentAction) {
      next.timeScale = timeScale;
      return;
    }

    next.enabled = true;
    next.reset();
    next.setLoop(LoopRepeat, Infinity);
    next.timeScale = timeScale;
    next.setEffectiveWeight(1);
    next.play();

    if (fish.currentAction) fish.currentAction.crossFadeTo(next, fade, false);
    else next.fadeIn(Math.max(0.01, fade));

    fish.currentAction = next;
  }

  private faceDirection(fish: FishInstance, dt: number): void {
    if (fish.direction.lengthSq() < 0.0001) return;

    _lookTarget.copy(fish.root.position).add(fish.direction);
    this.lookHelper.position.copy(fish.root.position);
    this.lookHelper.up.set(0, 1, 0);
    // Normal Object3D.lookAt points local +Z at the target, matching this fish GLB.
    this.lookHelper.lookAt(_lookTarget);
    fish.desiredQuaternion.copy(this.lookHelper.quaternion);

    const turnRate = fish.state === 'flee' ? 9 : 4;
    fish.root.quaternion.slerp(fish.desiredQuaternion, 1 - Math.exp(-turnRate * dt));
  }

  private updateGlow(fish: FishInstance, elapsed: number): void {
    if (fish.glowMaterials.length === 0) return;

    const night = 1 - this.environment.daylight;
    const pulse = 0.9 + Math.sin(elapsed * 2.1 + fish.phase) * 0.1;
    const hueWave = 0.5 + 0.5 * Math.sin(elapsed * 0.35 + fish.phase);
    this.glowColor.setHSL(MathUtils.lerp(0.49, 0.72, hueWave), 0.95, 0.56);
    const intensity = MathUtils.lerp(0.12, 2.8, night) * pulse;

    for (const material of fish.glowMaterials) {
      material.emissive.copy(this.glowColor);
      material.emissiveIntensity = intensity;
    }
  }

  dispose(): void {
    this.activeSchools.clear();
    this.pool.length = 0;
    for (const fish of this.allFish) {
      fish.mixer.stopAllAction();
      fish.root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
      fish.root.removeFromParent();
    }
    this.allFish.length = 0;
  }
}
