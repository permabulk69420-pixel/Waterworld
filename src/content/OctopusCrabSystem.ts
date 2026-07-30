import {
  AnimationMixer,
  Box3,
  Group,
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
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { Environment } from '../environment/Environment.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { DensityField } from '../world/density.ts';

const ASSET_URL = './assets/fauna/octopus_crab_bilateral_scuttler.glb';

// The asset prompt asked for a roughly 25-35 cm creature. Normalize the loaded
// GLB to that range so a future re-export cannot accidentally create giant crabs.
const TARGET_MAX_DIMENSION = 0.30;
const SCALE_MIN = 0.85;
const SCALE_MAX = 1.15;

// Cell streaming means the creatures are not a fixed immortal boot-time set.
// Nearby cells deterministically decide whether this species lives there; cells
// outside the local bubble are returned to a small reusable pool.
const CELL_SIZE = 8;
const SPAWN_CHANCE = 0.46;
const SPAWN_MIN_RADIUS = 6;
const SPAWN_RADIUS = 23;
const DESPAWN_RADIUS = 31;
const MAX_ACTIVE = 14;
const POPULATION_REFRESH_SECONDS = 0.65;

const GROUND_CLEARANCE = 0.035;
const WANDER_RADIUS = 2.8;
const CRAWL_SPEED_MIN = 0.16;
const CRAWL_SPEED_MAX = 0.28;
const SCURRY_SPEED = 1.15;
const THREAT_DISTANCE = 2.2;
const FLEE_DISTANCE = 1.35;
const CALM_DISTANCE = 3.2;

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

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

type CrabState = 'crawl' | 'idle' | 'feed' | 'threat' | 'scurry';

interface CrabInstance {
  root: Group;
  model: Object3D;
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  currentAction: AnimationAction | null;
  home: Vector3;
  target: Vector3;
  direction: Vector3;
  desiredQuaternion: Quaternion;
  state: CrabState;
  stateTimer: number;
  fleeTimer: number;
  crawlSpeed: number;
  cellKey: string | null;
}

/** Animated alien seabed scavengers with lightweight streamed population logic. */
export class OctopusCrabSystem {
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private clips: AnimationClip[] = [];
  private baseScale = 1;
  private loadFailed = false;
  private populationTimer = 0;

  private readonly active = new Map<string, CrabInstance>();
  private readonly pool: CrabInstance[] = [];
  private readonly all: CrabInstance[] = [];
  private readonly lookHelper = new Object3D();

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
        throw new Error('octopus crab GLB has invalid bounds');
      }
      this.baseScale = TARGET_MAX_DIMENSION / rawMaxDimension;

      console.info(
        `[fauna] octopus crab loaded: raw ${_size.x.toFixed(2)} x ${_size.y.toFixed(2)} x ${_size.z.toFixed(2)} m; ` +
          `clips [${this.clips.map((clip) => clip.name).join(', ')}]`,
      );
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[fauna] failed to load octopus crab at ${ASSET_URL}`, error);
    }
  }

  update(dt: number): void {
    if (this.loadFailed || !this.template) return;

    dt = Math.min(Math.max(dt, 0), 0.05);
    this.rig.getHeadPosition(_player);

    const inBiome = this.biomes.biomeAt(_player.x, _player.z).id === 'SAFE_SHALLOWS';
    const shouldPopulate = inBiome && this.environment.underwater;

    this.populationTimer -= dt;
    if (this.populationTimer <= 0) {
      this.populationTimer = POPULATION_REFRESH_SECONDS;
      this.refreshPopulation(shouldPopulate);
    }

    for (const crab of this.active.values()) {
      crab.mixer.update(dt);
      this.updateCrab(crab, dt);
    }
  }

  private refreshPopulation(shouldPopulate: boolean): void {
    if (!shouldPopulate) {
      for (const crab of [...this.active.values()]) this.release(crab);
      return;
    }

    for (const crab of [...this.active.values()]) {
      if (crab.root.position.distanceToSquared(_player) > DESPAWN_RADIUS * DESPAWN_RADIUS) this.release(crab);
    }

    if (this.active.size >= MAX_ACTIVE) return;

    const pcx = Math.floor(_player.x / CELL_SIZE);
    const pcz = Math.floor(_player.z / CELL_SIZE);
    const cellRadius = Math.ceil(SPAWN_RADIUS / CELL_SIZE);
    const candidates: Array<{ cx: number; cz: number; distanceSq: number }> = [];

    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      for (let dx = -cellRadius; dx <= cellRadius; dx++) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        const jitterX = (hash01(cx, cz, 11) - 0.5) * CELL_SIZE * 0.7;
        const jitterZ = (hash01(cx, cz, 17) - 0.5) * CELL_SIZE * 0.7;
        const x = (cx + 0.5) * CELL_SIZE + jitterX;
        const z = (cz + 0.5) * CELL_SIZE + jitterZ;
        const distanceSq = (x - _player.x) ** 2 + (z - _player.z) ** 2;
        if (distanceSq < SPAWN_MIN_RADIUS ** 2 || distanceSq > SPAWN_RADIUS ** 2) continue;
        if (hash01(cx, cz, 23) > SPAWN_CHANCE) continue;
        const key = `${cx},${cz}`;
        if (this.active.has(key)) continue;
        candidates.push({ cx, cz, distanceSq });
      }
    }

    candidates.sort((a, b) => a.distanceSq - b.distanceSq);
    for (const candidate of candidates) {
      if (this.active.size >= MAX_ACTIVE) break;
      this.spawnCell(candidate.cx, candidate.cz);
    }
  }

  private spawnCell(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    if (this.active.has(key)) return;

    const x = (cx + 0.5) * CELL_SIZE + (hash01(cx, cz, 11) - 0.5) * CELL_SIZE * 0.7;
    const z = (cz + 0.5) * CELL_SIZE + (hash01(cx, cz, 17) - 0.5) * CELL_SIZE * 0.7;
    if (this.biomes.biomeAt(x, z).id !== 'SAFE_SHALLOWS') return;

    const seabed = this.density.seabedAt(x, z);
    const y = seabed + GROUND_CLEARANCE;
    if (y >= this.environment.seaLevel - 0.25) return;
    if (this.density.sample(x, y + 0.12, z) > 0) return;

    const crab = this.acquire();
    crab.cellKey = key;
    crab.root.position.set(x, y, z);
    crab.home.copy(crab.root.position);
    crab.direction
      .set(hash01(cx, cz, 31) - 0.5, 0, hash01(cx, cz, 37) - 0.5)
      .normalize();
    if (crab.direction.lengthSq() < 0.001) crab.direction.set(0, 0, 1);
    crab.stateTimer = MathUtils.lerp(1.2, 3.2, hash01(cx, cz, 41));
    crab.fleeTimer = 0;
    crab.root.visible = true;
    this.pickTarget(crab);
    this.enterState(crab, hash01(cx, cz, 43) < 0.28 ? 'idle' : 'crawl');
    this.faceDirection(crab, 1);
    this.active.set(key, crab);
  }

  private acquire(): CrabInstance {
    const pooled = this.pool.pop();
    if (pooled) return pooled;
    if (!this.template) throw new Error('octopus crab template unavailable');

    const model = cloneSkeleton(this.template);
    const scaleVariation = MathUtils.lerp(SCALE_MIN, SCALE_MAX, Math.random());
    model.scale.multiplyScalar(this.baseScale * scaleVariation);

    const root = new Group();
    root.name = `fauna:octopus-crab-${this.all.length}`;
    root.add(model);
    this.scene.add(root);

    const mixer = new AnimationMixer(model);
    const actions = new Map<string, AnimationAction>();
    for (const clip of this.clips) actions.set(normalizeName(clip.name), mixer.clipAction(clip));

    const crab: CrabInstance = {
      root,
      model,
      mixer,
      actions,
      currentAction: null,
      home: new Vector3(),
      target: new Vector3(),
      direction: new Vector3(0, 0, 1),
      desiredQuaternion: new Quaternion(),
      state: 'crawl',
      stateTimer: 0,
      fleeTimer: 0,
      crawlSpeed: MathUtils.lerp(CRAWL_SPEED_MIN, CRAWL_SPEED_MAX, Math.random()),
      cellKey: null,
    };
    this.all.push(crab);
    return crab;
  }

  private release(crab: CrabInstance): void {
    if (crab.cellKey) this.active.delete(crab.cellKey);
    crab.cellKey = null;
    crab.root.visible = false;
    crab.currentAction?.stop();
    crab.currentAction = null;
    this.pool.push(crab);
  }

  private updateCrab(crab: CrabInstance, dt: number): void {
    const playerDistance = crab.root.position.distanceTo(_player);

    if (playerDistance < FLEE_DISTANCE) {
      crab.fleeTimer = 1.25;
      this.enterState(crab, 'scurry');
      _desired.copy(crab.root.position).sub(_player);
      _desired.y = 0;
      if (_desired.lengthSq() < 0.0001) _desired.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _desired.normalize();
      crab.direction.lerp(_desired, 1 - Math.exp(-12 * dt)).normalize();
    } else if (crab.state === 'scurry') {
      crab.fleeTimer -= dt;
      if (crab.fleeTimer <= 0 && playerDistance > CALM_DISTANCE) {
        crab.home.copy(crab.root.position);
        this.pickTarget(crab);
        this.enterState(crab, 'crawl');
      }
    } else if (playerDistance < THREAT_DISTANCE) {
      if (crab.state !== 'threat') this.enterState(crab, 'threat');
      crab.stateTimer -= dt;
    } else {
      crab.stateTimer -= dt;
      if (crab.state === 'threat' && crab.stateTimer <= 0) {
        this.pickTarget(crab);
        this.enterState(crab, 'crawl');
      } else if (crab.state === 'idle' || crab.state === 'feed') {
        if (crab.stateTimer <= 0) {
          this.pickTarget(crab);
          this.enterState(crab, 'crawl');
        }
      } else if (crab.state === 'crawl') {
        _desired.copy(crab.target).sub(crab.root.position);
        _desired.y = 0;
        if (_desired.lengthSq() > 0.0001) {
          _desired.normalize();
          crab.direction.lerp(_desired, 1 - Math.exp(-4 * dt)).normalize();
        }

        if (crab.root.position.distanceToSquared(crab.target) < 0.22 * 0.22 || crab.stateTimer <= 0) {
          const roll = Math.random();
          if (roll < 0.20) this.enterState(crab, 'feed');
          else if (roll < 0.42) this.enterState(crab, 'idle');
          else {
            this.pickTarget(crab);
            crab.stateTimer = MathUtils.lerp(2.5, 5.5, Math.random());
          }
        }
      }
    }

    const moving = crab.state === 'crawl' || crab.state === 'scurry';
    if (moving) {
      const speed = crab.state === 'scurry' ? SCURRY_SPEED : crab.crawlSpeed;
      _next.copy(crab.root.position).addScaledVector(crab.direction, speed * dt);
      const seabed = this.density.seabedAt(_next.x, _next.z);
      _next.y = seabed + GROUND_CLEARANCE;

      if (
        _next.y >= this.environment.seaLevel - 0.2 ||
        this.density.sample(_next.x, _next.y + 0.12, _next.z) > 0
      ) {
        crab.direction.multiplyScalar(-1);
        this.pickTarget(crab);
      } else {
        crab.root.position.copy(_next);
      }
    }

    this.faceDirection(crab, dt);
  }

  private pickTarget(crab: CrabInstance): void {
    for (let attempt = 0; attempt < 10; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = WANDER_RADIUS * Math.sqrt(Math.random());
      const x = crab.home.x + Math.cos(angle) * radius;
      const z = crab.home.z + Math.sin(angle) * radius;
      const y = this.density.seabedAt(x, z) + GROUND_CLEARANCE;
      if (y >= this.environment.seaLevel - 0.2) continue;
      if (this.density.sample(x, y + 0.12, z) > 0) continue;
      crab.target.set(x, y, z);
      return;
    }
    crab.target.copy(crab.home);
  }

  private enterState(crab: CrabInstance, state: CrabState): void {
    if (crab.state === state && crab.currentAction) return;
    crab.state = state;

    if (state === 'scurry') {
      crab.stateTimer = 1.25;
      this.playBest(crab, ['Scurry', 'ScurryBurst', 'Run', 'Crawl'], 0.06, 1.18);
      return;
    }
    if (state === 'threat') {
      crab.stateTimer = MathUtils.lerp(0.45, 0.8, Math.random());
      this.playBest(crab, ['Threat', 'Defend', 'Idle'], 0.08, 1.0);
      return;
    }
    if (state === 'feed') {
      crab.stateTimer = MathUtils.lerp(1.4, 3.0, Math.random());
      this.playBest(crab, ['Feed', 'Feeding', 'Idle'], 0.16, MathUtils.lerp(0.88, 1.05, Math.random()));
      return;
    }
    if (state === 'idle') {
      crab.stateTimer = MathUtils.lerp(1.0, 2.8, Math.random());
      this.playBest(crab, ['Idle', 'Rest', 'Crawl'], 0.16, MathUtils.lerp(0.82, 1.0, Math.random()));
      return;
    }

    crab.stateTimer = MathUtils.lerp(2.5, 5.5, Math.random());
    this.playBest(crab, ['Crawl', 'Scuttle', 'Walk', 'Idle'], 0.12, MathUtils.lerp(0.9, 1.08, Math.random()));
  }

  private playBest(crab: CrabInstance, names: readonly string[], fade: number, timeScale: number): void {
    let next: AnimationAction | undefined;
    for (const name of names) {
      next = crab.actions.get(normalizeName(name));
      if (next) break;
    }
    if (!next && crab.actions.size > 0) next = crab.actions.values().next().value;
    if (!next) return;

    if (next === crab.currentAction) {
      next.timeScale = timeScale;
      return;
    }

    next.enabled = true;
    next.reset();
    next.setLoop(LoopRepeat, Infinity);
    next.timeScale = timeScale;
    next.setEffectiveWeight(1);
    next.play();

    if (crab.currentAction) crab.currentAction.crossFadeTo(next, fade, false);
    else next.fadeIn(Math.max(0.01, fade));
    crab.currentAction = next;
  }

  private faceDirection(crab: CrabInstance, dt: number): void {
    if (crab.direction.lengthSq() < 0.0001) return;
    _lookTarget.copy(crab.root.position).add(crab.direction);
    this.lookHelper.position.copy(crab.root.position);
    this.lookHelper.up.set(0, 1, 0);
    this.lookHelper.lookAt(_lookTarget);
    crab.desiredQuaternion.copy(this.lookHelper.quaternion);
    const turnRate = crab.state === 'scurry' ? 12 : 6;
    crab.root.quaternion.slerp(crab.desiredQuaternion, 1 - Math.exp(-turnRate * dt));
  }

  dispose(): void {
    for (const crab of this.all) {
      crab.mixer.stopAllAction();
      crab.root.removeFromParent();
    }
    this.active.clear();
    this.pool.length = 0;
    this.all.length = 0;
  }
}
