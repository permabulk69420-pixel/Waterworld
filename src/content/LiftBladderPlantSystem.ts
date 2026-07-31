import {
  AnimationMixer,
  Box3,
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type AnimationClip,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { DensityField } from '../world/density.ts';
import type { Locomotion } from '../player/Locomotion.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { Handedness, VRHands } from '../player/VRHands.ts';

const ASSET_URL = './assets/biomes/safe-shallows/lift_bladder_plant_animated_v1.glb';
const BLADDER_NAME = 'LiftBladder';
const GRAB_POINT_NAME = 'GrabPoint_Bladder';
const GROWTH_WRAPPER_NAME = 'Runtime_LiftBladder_Growth';

// Five plants across the current Safe Shallows map. One is deliberately nearer
// the starting area so the mechanic is testable without turning the species into
// common vegetation; the other four sit out toward the biome's corners.
const PLACEMENT_RATIOS: readonly (readonly [number, number])[] = Object.freeze([
  [0.22, -0.19],
  [-0.72, -0.55],
  [0.69, -0.68],
  [-0.66, 0.70],
  [0.74, 0.57],
]);
const INITIAL_CYCLE_AGES = Object.freeze([52, 34, 18, 45, 8]);

const CYCLE_SECONDS = 60;
const REGROW_HIDDEN_SECONDS = 3;
const REGROW_SECONDS = 12;
const READY_GROWTH = 0.92;
const GRAB_RADIUS = 0.55;
const GRAB_RADIUS_SQ = GRAB_RADIUS * GRAB_RADIUS;
const GRIP_THRESHOLD = 0.45;
const PLANT_RENDER_DISTANCE = 155;
const PLANT_RENDER_DISTANCE_SQ = PLANT_RENDER_DISTANCE * PLANT_RENDER_DISTANCE;
const FREE_BLADDER_LIFETIME = 300;
const FREE_BLADDER_MAX_Y = 300;
const WATER_RISE_SPEED = 1.15;
const AIR_RISE_SPEED = 0.72;

const _playerPosition = new Vector3();
const _handPosition = new Vector3();
const _candidatePosition = new Vector3();
const _sourceGrabPosition = new Vector3();
const _localGrabPosition = new Vector3();
const _sourceGrabQuaternion = new Quaternion();
const _localGrabQuaternion = new Quaternion();

interface PlantState {
  root: Group;
  bladder: Object3D;
  growthWrapper: Group;
  grabPoint: Object3D;
  mixer: AnimationMixer;
  cycleAge: number;
  index: number;
}

interface FreeBladder {
  root: Group;
  age: number;
  phase: number;
  heldBy: Handedness | null;
}

function smooth01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function findBladder(root: Object3D): Object3D | null {
  const exact = root.getObjectByName(BLADDER_NAME);
  if (exact) return exact;

  let fallback: Object3D | null = null;
  root.traverse((object) => {
    if (fallback) return;
    const name = object.name.toLowerCase();
    if (!name.includes('bladder')) return;
    if (name.includes('grab') || name.includes('collision') || name.includes('attachment') || name.includes('stem')) return;
    fallback = object;
  });
  return fallback;
}

function findGrabPoint(bladder: Object3D): Object3D {
  return bladder.getObjectByName(GRAB_POINT_NAME) ?? bladder;
}

/**
 * Rare biological lift-bladder plants plus their detached balloon behaviour.
 *
 * The supplied GLB is authored specifically for runtime detachment: LiftBladder
 * contains its membrane, grip lobe, vein network, GrabPoint_Bladder and collision
 * metadata. The rooted plant keeps its authored bladder hidden after release while
 * a cheap clone becomes the independent world balloon; that lets the same plant
 * regrow forever without duplicating or rebuilding the whole GLB.
 */
export class LiftBladderPlantSystem {
  readonly ready: Promise<void>;

  private template: Group | null = null;
  private clips: AnimationClip[] = [];
  private readonly plants: PlantState[] = [];
  private readonly freeBladders: FreeBladder[] = [];
  private readonly heldByHand: Record<Handedness, FreeBladder | null> = {
    left: null,
    right: null,
  };
  private serial = 0;
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly rig: PlayerRig,
    private readonly locomotion: Locomotion,
    private readonly density: DensityField,
    private readonly biomes: BiomeRegistry,
    private readonly worldConfig: WorldConfig,
    private readonly interactionEnabled: boolean,
  ) {
    this.ready = this.load();
  }

  get plantCount(): number {
    return this.plants.length;
  }

  get detachedCount(): number {
    return this.freeBladders.length;
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
      const size = new Vector3();
      bounds.getSize(size);
      if (!Number.isFinite(size.y) || size.y <= 0.01) {
        throw new Error('lift bladder plant GLB has invalid bounds');
      }

      // Preserve the author's metre scale and +Y orientation. Only move the lowest
      // point to local y=0 so procedural seabed placement cannot bury the root plate.
      gltf.scene.position.y -= bounds.min.y;
      const template = new Group();
      template.name = 'flora:lift-bladder-template';
      template.add(gltf.scene);
      template.updateMatrixWorld(true);

      if (!findBladder(template)) {
        throw new Error(`lift bladder GLB is missing ${BLADDER_NAME}`);
      }

      this.template = template;
      this.clips = gltf.animations;
      this.spawnRarePlants();

      console.info(
        `[lift-bladder] loaded ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m; ` +
          `${this.plants.length} rare plants; ${CYCLE_SECONDS}s cycle; clips=${this.clips.map((clip) => clip.name).join(', ') || 'none'}`,
      );
    } catch (error) {
      console.warn(`[lift-bladder] failed to load ${ASSET_URL}`, error);
    }
  }

  private spawnRarePlants(): void {
    if (!this.template) return;

    const bounds = this.worldConfig.playableBounds;
    const halfChunksX = bounds?.halfChunksX ?? 3;
    const halfChunksZ = bounds?.halfChunksZ ?? 3;
    const extentX = this.worldConfig.chunkSize * Math.max(1, halfChunksX);
    const extentZ = this.worldConfig.chunkSize * Math.max(1, halfChunksZ);

    for (let index = 0; index < PLACEMENT_RATIOS.length; index++) {
      const ratio = PLACEMENT_RATIOS[index];
      const x = ratio[0] * extentX;
      const z = ratio[1] * extentZ;
      if (this.biomes.biomeAt(x, z).id !== 'SAFE_SHALLOWS') continue;

      const y = this.density.seabedAt(x, z) - 0.025;
      const root = this.template.clone(true);
      root.name = `flora:lift-bladder-plant:${index + 1}`;
      root.position.set(x, y, z);
      root.rotation.y = (this.worldConfig.seed * 0.0137 + index * 2.399963) % (Math.PI * 2);
      this.scene.add(root);

      const bladder = findBladder(root);
      if (!bladder?.parent) {
        root.removeFromParent();
        continue;
      }

      // Runtime growth happens on a wrapper, leaving the authored LiftBladder node
      // free for its own baked sway/pulse transforms.
      const growthWrapper = new Group();
      growthWrapper.name = `${GROWTH_WRAPPER_NAME}_${index}`;
      bladder.parent.add(growthWrapper);
      growthWrapper.add(bladder);

      const grabPoint = findGrabPoint(bladder);
      const mixer = new AnimationMixer(root);
      const idleClip = this.clips.find((clip) => /idle|sway/i.test(clip.name));
      if (idleClip) mixer.clipAction(idleClip).play();

      const plant: PlantState = {
        root,
        bladder,
        growthWrapper,
        grabPoint,
        mixer,
        cycleAge: INITIAL_CYCLE_AGES[index] ?? index * 9,
        index,
      };
      this.applyGrowthPose(plant);
      this.plants.push(plant);
    }
  }

  update(dt: number, elapsed: number): void {
    if (this.disposed) return;
    dt = Math.min(Math.max(dt, 0), 0.05);
    this.rig.getHeadPosition(_playerPosition);

    this.updatePlants(dt);
    this.updateHeld('left');
    this.updateHeld('right');
    this.updateFreeBladders(dt, elapsed);

    if (this.interactionEnabled && this.renderer.xr.isPresenting) {
      if (!this.heldByHand.left && this.gripHeld('left')) this.tryGrabNearest('left');
      if (!this.heldByHand.right && this.gripHeld('right')) this.tryGrabNearest('right');
    } else {
      this.release('left');
      this.release('right');
    }

    const heldCount = Number(Boolean(this.heldByHand.left)) + Number(Boolean(this.heldByHand.right));
    this.locomotion.setExternalBuoyancy(heldCount);
  }

  private updatePlants(dt: number): void {
    for (const plant of this.plants) {
      const dx = plant.root.position.x - _playerPosition.x;
      const dz = plant.root.position.z - _playerPosition.z;
      const nearby = dx * dx + dz * dz <= PLANT_RENDER_DISTANCE_SQ;
      plant.root.visible = nearby;
      if (!nearby) {
        // Let the biological clock mature while off-screen, but do not manufacture
        // hundreds of unseen sky balloons. It releases as soon as the player enters
        // simulation range again.
        plant.cycleAge = Math.min(CYCLE_SECONDS, plant.cycleAge + dt);
        this.applyGrowthPose(plant);
        continue;
      }

      plant.mixer.update(dt);
      plant.cycleAge += dt;
      this.applyGrowthPose(plant);

      if (plant.cycleAge >= CYCLE_SECONDS) this.detachPlantBladder(plant);
    }
  }

  private applyGrowthPose(plant: PlantState): void {
    if (plant.cycleAge < REGROW_HIDDEN_SECONDS) {
      plant.growthWrapper.visible = false;
      return;
    }

    const growth = smooth01(
      (plant.cycleAge - REGROW_HIDDEN_SECONDS) / REGROW_SECONDS,
    );
    plant.growthWrapper.visible = true;
    // Never collapse fully to zero: tiny scales are friendlier to animated child
    // transforms and avoid a singular matrix while the bladder is budding.
    const scale = 0.055 + growth * 0.945;
    plant.growthWrapper.scale.setScalar(scale);
  }

  private growthFraction(plant: PlantState): number {
    if (!plant.growthWrapper.visible) return 0;
    return Math.max(
      0,
      Math.min(1, (plant.cycleAge - REGROW_HIDDEN_SECONDS) / REGROW_SECONDS),
    );
  }

  private detachPlantBladder(plant: PlantState): FreeBladder | null {
    if (!plant.growthWrapper.visible) return null;

    // Use the authored grab helper as the independent balloon's origin. That makes
    // world pickup and held placement use the exact same point and eliminates the
    // ugly centre-of-sphere snap that generic Object3D.attach would cause.
    plant.grabPoint.updateWorldMatrix(true, false);
    plant.grabPoint.getWorldPosition(_sourceGrabPosition);
    plant.grabPoint.getWorldQuaternion(_sourceGrabQuaternion);

    const visual = plant.bladder.clone(true);
    visual.name = `lift-bladder-visual:${this.serial}`;
    visual.visible = true;
    visual.position.set(0, 0, 0);
    visual.quaternion.identity();
    visual.scale.set(1, 1, 1);
    visual.updateMatrixWorld(true);

    const visualGrab = findGrabPoint(visual);
    visualGrab.updateWorldMatrix(true, false);
    visualGrab.getWorldPosition(_localGrabPosition);
    visualGrab.getWorldQuaternion(_localGrabQuaternion);

    // Rotate/translate the visual so GrabPoint_Bladder becomes local origin with
    // identity orientation. Parenting the resulting root to a palm then behaves
    // exactly like a one-hand weapon/tool socket.
    visual.quaternion.copy(_localGrabQuaternion).invert();
    visual.position
      .copy(_localGrabPosition)
      .applyQuaternion(visual.quaternion)
      .multiplyScalar(-1);

    const root = new Group();
    root.name = `world:lift-bladder:${this.serial}`;
    root.position.copy(_sourceGrabPosition);
    root.quaternion.copy(_sourceGrabQuaternion);
    root.add(visual);
    this.scene.add(root);

    const free: FreeBladder = {
      root,
      age: 0,
      phase: this.serial * 1.731 + plant.index * 0.91,
      heldBy: null,
    };
    this.serial++;
    this.freeBladders.push(free);

    plant.growthWrapper.visible = false;
    plant.growthWrapper.scale.setScalar(0.055);
    plant.cycleAge = 0;
    return free;
  }

  private updateHeld(handedness: Handedness): void {
    const held = this.heldByHand[handedness];
    if (!held) return;
    if (!this.renderer.xr.isPresenting || !this.gripHeld(handedness)) {
      this.release(handedness);
    }
  }

  private tryGrabNearest(handedness: Handedness): void {
    const objectGrip = this.hands.getObjectGrip(handedness);
    if (!objectGrip || objectGrip.children.length > 0) return;

    objectGrip.updateWorldMatrix(true, false);
    objectGrip.getWorldPosition(_handPosition);

    let bestFree: FreeBladder | null = null;
    let bestPlant: PlantState | null = null;
    let bestDistanceSq = GRAB_RADIUS_SQ;

    for (const bladder of this.freeBladders) {
      if (bladder.heldBy) continue;
      bladder.root.updateWorldMatrix(true, false);
      bladder.root.getWorldPosition(_candidatePosition);
      const distanceSq = _handPosition.distanceToSquared(_candidatePosition);
      if (distanceSq > bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      bestFree = bladder;
      bestPlant = null;
    }

    for (const plant of this.plants) {
      if (!plant.root.visible || this.growthFraction(plant) < READY_GROWTH) continue;
      plant.grabPoint.updateWorldMatrix(true, false);
      plant.grabPoint.getWorldPosition(_candidatePosition);
      const distanceSq = _handPosition.distanceToSquared(_candidatePosition);
      if (distanceSq > bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      bestPlant = plant;
      bestFree = null;
    }

    const target = bestFree ?? (bestPlant ? this.detachPlantBladder(bestPlant) : null);
    if (!target) return;
    this.grab(target, handedness, objectGrip);
  }

  private grab(bladder: FreeBladder, handedness: Handedness, objectGrip: Group): void {
    if (bladder.heldBy) return;

    objectGrip.add(bladder.root);
    bladder.root.position.set(0, 0, 0);
    bladder.root.quaternion.identity();
    bladder.root.scale.set(1, 1, 1);
    bladder.heldBy = handedness;
    this.heldByHand[handedness] = bladder;
  }

  private release(handedness: Handedness): void {
    const bladder = this.heldByHand[handedness];
    if (!bladder) return;

    bladder.root.updateWorldMatrix(true, false);
    this.scene.attach(bladder.root);
    bladder.heldBy = null;
    this.heldByHand[handedness] = null;
  }

  private updateFreeBladders(dt: number, elapsed: number): void {
    for (let index = this.freeBladders.length - 1; index >= 0; index--) {
      const bladder = this.freeBladders[index];
      bladder.age += dt;
      if (bladder.heldBy) continue;

      const underwater = bladder.root.position.y < this.worldConfig.seaLevel + 0.15;
      const riseSpeed = underwater ? WATER_RISE_SPEED : AIR_RISE_SPEED;
      bladder.root.position.y += riseSpeed * dt;

      // Very small organic wandering so a released bladder never reads as a rigid
      // elevator. Keep it tiny enough that a player can still predict/catch it.
      const sway = elapsed * 0.58 + bladder.phase;
      bladder.root.position.x += Math.sin(sway) * 0.018 * dt;
      bladder.root.position.z += Math.cos(sway * 0.83) * 0.018 * dt;
      bladder.root.rotateY(0.035 * dt);

      if (bladder.age > FREE_BLADDER_LIFETIME || bladder.root.position.y > FREE_BLADDER_MAX_Y) {
        bladder.root.removeFromParent();
        this.freeBladders.splice(index, 1);
      }
    }
  }

  private gripHeld(handedness: Handedness): boolean {
    const session = this.renderer.xr.getSession();
    if (!session) return false;
    for (const source of session.inputSources) {
      if (source.handedness !== handedness) continue;
      return (source.gamepad?.buttons[1]?.value ?? 0) > GRIP_THRESHOLD;
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.locomotion.clearExternalBuoyancy();
    for (const plant of this.plants) {
      plant.mixer.stopAllAction();
      plant.root.removeFromParent();
    }
    for (const bladder of this.freeBladders) bladder.root.removeFromParent();
    this.plants.length = 0;
    this.freeBladders.length = 0;
    this.heldByHand.left = null;
    this.heldByHand.right = null;
    this.template = null;
    this.clips = [];
  }
}
