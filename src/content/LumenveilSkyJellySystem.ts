import {
  AnimationMixer,
  Box3,
  Color,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type AnimationClip,
  type Material,
  type Object3D,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { Environment } from '../environment/Environment.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { ColossusMushroomSystem } from './ColossusMushroomSystem.ts';

const ASSET_URL = './assets/fauna/lumenveil_sky_jelly_animated_v1.glb';
const LOCAL_FORWARD = new Vector3(0, 0, -1);

// Three creatures wander broadly through the Safe Shallows airspace. A fourth is
// ecologically tied to the colossal mushroom landmark and keeps circling it instead
// of joining the general wander population.
const ROAMING_COUNT = 3;
const TOTAL_COUNT = 4;
const MIN_ALTITUDE = 14;
const MAX_ALTITUDE = 60;
const RENDER_DISTANCE = 340;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;

const RESIDENT_ORBIT_RADIUS = 48;
const RESIDENT_ORBIT_SPEED = 0.075;
const RESIDENT_BASE_HEIGHT_ABOVE_TREE_ROOT = 56;

// Be deliberately strict here. The original pass also matched words such as
// "lumen", "cyan" and "violet", which caused ordinary body membranes to become
// emissive. Only the GLB's explicit vein/organ/tentacle glow geometry gets driven.
const SELECTIVE_GLOW_HINT =
  /DorsalVeinNetwork|GlowOrgans|LiftOrganCluster|GlowNode|GlowTip|BiolumeVein/i;
const CYAN = new Color(0x55eeff);
const VIOLET = new Color(0xaa78ff);

const _size = new Vector3();
const _player = new Vector3();
const _tree = new Vector3();
const _toTarget = new Vector3();
const _desiredVelocity = new Vector3();
const _heading = new Vector3();
const _orbitTarget = new Vector3();
const _targetQuaternion = new Quaternion();

interface GlowMaterialState {
  material: MeshStandardMaterial;
  color: Color;
  dayIntensity: number;
  nightIntensity: number;
}

interface JellyState {
  root: Group;
  mixer: AnimationMixer;
  velocity: Vector3;
  target: Vector3;
  targetTimer: number;
  speed: number;
  phase: number;
  rngState: number;
  resident: boolean;
  glowMaterials: GlowMaterialState[];
  ownedMaterials: Material[];
}

function smoothRate(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Four large aerial Lumenveil organisms for the Safe Shallows.
 *
 * The GLB explicitly declares runtime-controlled world movement, a suggested
 * 4.2 m/s cruise speed and a 14-60 m wander altitude. Its baked animation is used
 * only for local body/tentacle motion while this system supplies the actual flight
 * path. Only explicit bioluminescent vein/organ/tip meshes glow at night; the bell,
 * sails and ordinary body tissue remain conventionally lit PBR surfaces.
 */
export class LumenveilSkyJellySystem {
  readonly ready: Promise<void>;

  private template: Object3D | null = null;
  private clips: AnimationClip[] = [];
  private readonly jellies: JellyState[] = [];
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly environment: Environment,
    private readonly rig: PlayerRig,
    private readonly worldConfig: WorldConfig,
    private readonly colossus: ColossusMushroomSystem,
  ) {
    this.ready = this.load();
  }

  get count(): number {
    return this.jellies.length;
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      if (this.disposed) return;

      gltf.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
      });

      const bounds = new Box3().setFromObject(gltf.scene);
      bounds.getSize(_size);
      if (_size.lengthSq() <= 0.001) throw new Error('Lumenveil GLB has invalid bounds');

      this.template = gltf.scene;
      this.clips = gltf.animations;
      this.spawnPopulation();

      console.info(
        `[lumenveil] loaded ${_size.x.toFixed(2)} x ${_size.y.toFixed(2)} x ${_size.z.toFixed(2)} m; ` +
          `${TOTAL_COUNT} intended / ${this.jellies.length} spawned (${ROAMING_COUNT} roaming + 1 colossus resident); ` +
          `clips=${this.clips.map((clip) => clip.name).join(', ') || 'none'}`,
      );
    } catch (error) {
      console.warn(`[lumenveil] failed to load ${ASSET_URL}`, error);
    }
  }

  private spawnPopulation(): void {
    if (!this.template) return;

    const bounds = this.worldConfig.playableBounds;
    const halfChunksX = bounds?.halfChunksX ?? 3;
    const halfChunksZ = bounds?.halfChunksZ ?? 3;
    const extentX = this.worldConfig.chunkSize * Math.max(1, halfChunksX) * 0.88;
    const extentZ = this.worldConfig.chunkSize * Math.max(1, halfChunksZ) * 0.88;

    const starts: readonly (readonly [number, number, number])[] = [
      [-0.63, 0.31, 0.38],
      [0.16, -0.68, 0.70],
      [0.67, 0.46, 0.52],
    ];

    for (let index = 0; index < ROAMING_COUNT; index++) {
      const start = starts[index];
      const x = start[0] * extentX;
      const z = start[1] * extentZ;
      const y = MathUtils.lerp(MIN_ALTITUDE, MAX_ALTITUDE, start[2]);
      const jelly = this.createJelly(index, false, new Vector3(x, y, z));
      this.pickRoamingTarget(jelly, extentX, extentZ);
      this.jellies.push(jelly);
    }

    this.colossus.getWorldPosition(_tree);
    const residentStart = new Vector3(
      _tree.x + RESIDENT_ORBIT_RADIUS,
      MathUtils.clamp(_tree.y + RESIDENT_BASE_HEIGHT_ABOVE_TREE_ROOT, MIN_ALTITUDE, MAX_ALTITUDE),
      _tree.z,
    );
    this.jellies.push(this.createJelly(ROAMING_COUNT, true, residentStart));
  }

  private createJelly(index: number, resident: boolean, position: Vector3): JellyState {
    const root = new Group();
    root.name = resident ? 'fauna:lumenveil:colossus-resident' : `fauna:lumenveil:roamer:${index + 1}`;
    root.position.copy(position);

    const visual = this.template!.clone(true);
    visual.name = 'lumenveil-visual';
    root.add(visual);
    this.scene.add(root);

    const glowMaterials: GlowMaterialState[] = [];
    const ownedMaterials: Material[] = [];
    visual.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const cloned = source.map((material) => {
        const clone = material.clone();
        ownedMaterials.push(clone);
        if (clone instanceof MeshStandardMaterial) {
          this.prepareGlowMaterial(clone, object.name, glowMaterials);
        }
        return clone;
      });
      object.material = Array.isArray(object.material) ? cloned : cloned[0];
    });

    const mixer = new AnimationMixer(visual);
    const preferred = this.pickFlightClip();
    if (preferred) {
      const action = mixer.clipAction(preferred);
      action.play();
      action.time = preferred.duration > 0 ? (preferred.duration * ((index * 0.271) % 1)) : 0;
      action.timeScale = 0.9 + index * 0.055;
    }

    return {
      root,
      mixer,
      velocity: new Vector3(0, 0, -1).multiplyScalar(3.2 + index * 0.35),
      target: position.clone(),
      targetTimer: 0,
      speed: resident ? 3.6 : 3.35 + index * 0.42,
      phase: 0.7 + index * 1.91,
      rngState: (this.worldConfig.seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0,
      resident,
      glowMaterials,
      ownedMaterials,
    };
  }

  private prepareGlowMaterial(
    material: MeshStandardMaterial,
    meshName: string,
    output: GlowMaterialState[],
  ): void {
    const hint = `${meshName} ${material.name}`;

    // Some authored body materials carry a tiny emissive value for previewing, but
    // that does not mean the whole animal should self-illuminate in-game. Strip all
    // emission from non-biological-glow geometry, including any emissive map.
    if (!SELECTIVE_GLOW_HINT.test(hint)) {
      material.emissive.setRGB(0, 0, 0);
      material.emissiveIntensity = 0;
      material.emissiveMap = null;
      material.needsUpdate = true;
      return;
    }

    const color = material.emissive.clone();
    if (color.r + color.g + color.b < 0.015) {
      color.copy(/violet/i.test(hint) ? VIOLET : CYAN);
    }

    const authored = Math.max(0.1, material.emissiveIntensity || 1);
    const nightIntensity = Math.max(2.2, authored * 2.0);
    material.emissive.copy(color);
    material.emissiveIntensity = 0.01;
    output.push({
      material,
      color,
      dayIntensity: 0.01,
      nightIntensity,
    });
  }

  private pickFlightClip(): AnimationClip | null {
    if (this.clips.length === 0) return null;
    return (
      this.clips.find((clip) => /cruise|flight|fly|hover|idle/i.test(clip.name)) ??
      this.clips[0]
    );
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed || this.jellies.length === 0) return;
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.rig.getHeadPosition(_player);

    const bounds = this.worldConfig.playableBounds;
    const halfChunksX = bounds?.halfChunksX ?? 3;
    const halfChunksZ = bounds?.halfChunksZ ?? 3;
    const extentX = this.worldConfig.chunkSize * Math.max(1, halfChunksX) * 0.88;
    const extentZ = this.worldConfig.chunkSize * Math.max(1, halfChunksZ) * 0.88;

    for (const jelly of this.jellies) {
      if (jelly.resident) this.updateResident(jelly, dt, elapsed);
      else this.updateRoamer(jelly, dt, extentX, extentZ);

      const distanceSq = jelly.root.position.distanceToSquared(_player);
      jelly.root.visible = distanceSq <= RENDER_DISTANCE_SQ;
      if (jelly.root.visible) {
        jelly.mixer.update(dt);
        this.updateGlow(jelly, elapsed);
      }
    }
  }

  private updateRoamer(jelly: JellyState, dt: number, extentX: number, extentZ: number): void {
    jelly.targetTimer -= dt;
    _toTarget.subVectors(jelly.target, jelly.root.position);
    if (jelly.targetTimer <= 0 || _toTarget.lengthSq() < 11 * 11) {
      this.pickRoamingTarget(jelly, extentX, extentZ);
      _toTarget.subVectors(jelly.target, jelly.root.position);
    }

    if (_toTarget.lengthSq() > 1e-5) {
      _desiredVelocity.copy(_toTarget).normalize().multiplyScalar(jelly.speed);
      jelly.velocity.lerp(_desiredVelocity, smoothRate(0.72, dt));
    }

    jelly.root.position.addScaledVector(jelly.velocity, dt);
    this.faceVelocity(jelly, dt);
  }

  private pickRoamingTarget(jelly: JellyState, extentX: number, extentZ: number): void {
    const rx = this.random(jelly);
    const rz = this.random(jelly);
    const ry = this.random(jelly);
    jelly.target.set(
      MathUtils.lerp(-extentX, extentX, rx),
      MathUtils.lerp(MIN_ALTITUDE, MAX_ALTITUDE, 0.16 + ry * 0.84),
      MathUtils.lerp(-extentZ, extentZ, rz),
    );
    jelly.targetTimer = 15 + this.random(jelly) * 15;
  }

  private updateResident(jelly: JellyState, dt: number, elapsed: number): void {
    if (!this.colossus.getWorldPosition(_tree)) return;

    const angle = elapsed * RESIDENT_ORBIT_SPEED + jelly.phase;
    const radius = RESIDENT_ORBIT_RADIUS + Math.sin(elapsed * 0.17 + jelly.phase) * 5.5;
    const y = MathUtils.clamp(
      _tree.y + RESIDENT_BASE_HEIGHT_ABOVE_TREE_ROOT + Math.sin(elapsed * 0.23 + jelly.phase) * 8,
      MIN_ALTITUDE,
      MAX_ALTITUDE,
    );
    _orbitTarget.set(
      _tree.x + Math.cos(angle) * radius,
      y,
      _tree.z + Math.sin(angle) * radius,
    );

    _desiredVelocity.subVectors(_orbitTarget, jelly.root.position);
    const distance = _desiredVelocity.length();
    if (distance > 0.001) {
      _desiredVelocity.multiplyScalar(jelly.speed / Math.max(jelly.speed, distance));
      jelly.velocity.lerp(_desiredVelocity, smoothRate(1.15, dt));
    }
    jelly.root.position.addScaledVector(jelly.velocity, dt);
    this.faceVelocity(jelly, dt);
  }

  private faceVelocity(jelly: JellyState, dt: number): void {
    _heading.copy(jelly.velocity);
    if (_heading.lengthSq() <= 0.02) return;
    _heading.normalize();
    _targetQuaternion.setFromUnitVectors(LOCAL_FORWARD, _heading);
    jelly.root.quaternion.slerp(_targetQuaternion, smoothRate(1.4, dt));
  }

  private updateGlow(jelly: JellyState, elapsed: number): void {
    if (jelly.glowMaterials.length === 0) return;
    const night = Math.pow(MathUtils.clamp(1 - this.environment.daylight, 0, 1), 1.35);
    const pulse = 0.84 + Math.sin(elapsed * 1.08 + jelly.phase) * 0.16;

    for (const state of jelly.glowMaterials) {
      state.material.emissive.copy(state.color);
      state.material.emissiveIntensity = MathUtils.lerp(
        state.dayIntensity,
        state.nightIntensity * pulse,
        night,
      );
    }
  }

  private random(jelly: JellyState): number {
    jelly.rngState = (Math.imul(jelly.rngState, 1664525) + 1013904223) >>> 0;
    return jelly.rngState / 0x100000000;
  }

  dispose(): void {
    this.disposed = true;
    for (const jelly of this.jellies) {
      jelly.mixer.stopAllAction();
      jelly.root.removeFromParent();
      for (const material of jelly.ownedMaterials) material.dispose();
    }
    this.jellies.length = 0;
    this.template = null;
    this.clips = [];
  }
}
