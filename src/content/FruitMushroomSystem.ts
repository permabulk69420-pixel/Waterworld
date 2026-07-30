import {
  Box3,
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { BiomeConfig } from '../config/biomes/types.ts';
import type { VRHands, Handedness } from '../player/VRHands.ts';
import type { ChunkContentContext, ContentPopulator } from './ContentRegistry.ts';

const ASSET_URL = './assets/biomes/safe-shallows/alien_mushroom_vines_fruit_10m_v1.glb';
const UP = new Vector3(0, 1, 0);

// Roughly half the frequency of the normal giant mushroom system (0.45).
const CHUNK_SPAWN_CHANCE = 0.225;
const SECOND_MUSHROOM_CHANCE = 0.06;
const MIN_HEIGHT = 1;
const MAX_HEIGHT = 20;
const SURFACE_HEADROOM = 0.8;
const START_AREA_CLEAR_RADIUS = 20;
const START_AREA_CLEAR_RADIUS_SQ = START_AREA_CLEAR_RADIUS * START_AREA_CLEAR_RADIUS;
const RENDER_DISTANCE = 190;
const RENDER_DISTANCE_SQ = RENDER_DISTANCE * RENDER_DISTANCE;

const FRUIT_NAME_HINT = /fruit|berry|pod|harvest|edible/i;
const BASE_FRUIT_GRAB_RADIUS = 0.24;
const BASE_FRUIT_PULL_CLEAR_RADIUS = 0.28;
const GRIP_THRESHOLD = 0.45;

// Placeholder survival values. There is no hunger/thirst system yet; consumeFruit()
// exposes these cleanly for that future system without pretending one already exists.
const FOOD_PER_FRUIT = 8;
const WATER_PER_FRUIT = 12;

interface FruitRuntime {
  id: string;
  node: Object3D;
  homeParent: Object3D | null;
  homePosition: Vector3;
  homeQuaternion: Quaternion;
  homeScale: Vector3;
  homeWorld: Vector3;
  mushroomScale: number;
  heldBy: Handedness | null;
  pulledClear: boolean;
  collected: boolean;
}

interface FruitMushroomPlacement {
  root: Group;
  position: Vector3;
  fruits: FruitRuntime[];
}

const _rawSize = new Vector3();
const _leftTip = new Vector3();
const _rightTip = new Vector3();
const _leftGrip = new Vector3();
const _rightGrip = new Vector3();
const _fruitWorld = new Vector3();

/**
 * Sparse vine-and-fruit mushrooms for the Safe Shallows.
 *
 * They use the same broad 1-20 m size family as the ordinary giant mushrooms but
 * occur about half as often. Named fruit nodes remain individual objects inside each
 * clone, so Story mode can physically grab/pull them from the hanging vines.
 */
export class FruitMushroomSystem implements ContentPopulator {
  readonly id = 'safe-shallows-fruit-mushrooms-v1';
  readonly layer = 'vegetation' as const;
  readonly keepsEmptyGroup = true;
  readonly ready: Promise<void>;

  readonly foodPerFruit = FOOD_PER_FRUIT;
  readonly waterPerFruit = WATER_PER_FRUIT;
  harvestedFruit = 0;

  private readonly chunks = new Map<string, FruitMushroomPlacement[]>();
  private readonly harvestedFruitIds = new Set<string>();
  private readonly heldFruitByHand: Record<Handedness, FruitRuntime | null> = {
    left: null,
    right: null,
  };

  private template: Group | null = null;
  private authoredHeight = 1;
  private loadFailed = false;
  private fruitNodeNames: string[] = [];

  constructor(
    private readonly parent: Object3D,
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly mode: 'story' | 'build',
  ) {
    this.ready = this.load();
  }

  appliesTo(biome: BiomeConfig): boolean {
    return biome.id === 'SAFE_SHALLOWS' && biome.spawnDensity.vegetation > 0;
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      gltf.scene.updateMatrixWorld(true);

      gltf.scene.traverse((object) => {
        if (object instanceof Mesh) {
          object.castShadow = false;
          object.receiveShadow = false;
        }
      });

      const rawBounds = new Box3().setFromObject(gltf.scene);
      rawBounds.getSize(_rawSize);
      if (_rawSize.lengthSq() <= 0.001) throw new Error('fruit mushroom GLB has invalid bounds');

      const axisFix = new Group();
      axisFix.name = 'flora:fruit-mushroom-axis-fix';
      // The current mushroom asset family is authored Z-up, but keep this safe if a
      // later export is corrected to Y-up rather than blindly rotating it again.
      if (_rawSize.z > _rawSize.y * 1.2) axisFix.rotation.x = -Math.PI / 2;
      axisFix.add(gltf.scene);

      const template = new Group();
      template.name = 'flora:fruit-mushroom-template';
      template.add(axisFix);
      template.updateMatrixWorld(true);

      const fixedBounds = new Box3().setFromObject(template);
      const height = fixedBounds.max.y - fixedBounds.min.y;
      if (!Number.isFinite(height) || height <= 0.001) {
        throw new Error('fruit mushroom GLB has invalid corrected height');
      }

      axisFix.position.y -= fixedBounds.min.y;
      template.updateMatrixWorld(true);

      const names = new Set<string>();
      template.traverse((object) => {
        if (object.name && FRUIT_NAME_HINT.test(object.name)) names.add(object.name);
      });
      this.fruitNodeNames = [...names];

      this.authoredHeight = height;
      this.template = template;

      console.info(
        `[flora] fruit mushroom loaded: authored height ${height.toFixed(2)} m; ` +
          `spawn chance ${(CHUNK_SPAWN_CHANCE * 100).toFixed(1)}%; ` +
          `fruit nodes [${this.fruitNodeNames.join(', ')}]`,
      );

      if (this.fruitNodeNames.length === 0) {
        console.warn(
          '[flora] fruit mushroom has no named fruit/berry/pod nodes; plant will spawn but fruit harvesting is disabled',
        );
      }
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[flora] failed to load fruit mushroom at ${ASSET_URL}`, error);
    }
  }

  populate(ctx: ChunkContentContext): void {
    this.removeChunk(ctx.key);

    if (!this.template || this.loadFailed || ctx.rng.float() > CHUNK_SPAWN_CHANCE) {
      this.chunks.set(ctx.key, []);
      return;
    }

    const desiredCount = 1 + (ctx.rng.float() < SECOND_MUSHROOM_CHANCE ? 1 : 0);
    const candidates = ctx.sampleSeabedPoints(desiredCount * 10, 0.64);
    const placements: FruitMushroomPlacement[] = [];

    for (const point of candidates) {
      if (placements.length >= desiredCount) break;

      const originDistanceSq =
        point.position.x * point.position.x + point.position.z * point.position.z;
      if (originDistanceSq < START_AREA_CLEAR_RADIUS_SQ) continue;

      const maximumFittingHeight = Math.min(MAX_HEIGHT, point.depth - SURFACE_HEADROOM);
      if (maximumFittingHeight < MIN_HEIGHT) continue;

      const requestedHeight =
        MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * Math.pow(ctx.rng.float(), 1.35);
      const height = Math.min(requestedHeight, maximumFittingHeight);
      const mushroomScale = height / this.authoredHeight;

      const root = new Group();
      const placementIndex = placements.length;
      root.name = `flora:fruit-mushroom:${ctx.key}:${placementIndex}`;
      root.position
        .copy(point.position)
        .addScaledVector(point.normal, -Math.min(0.35, height * 0.018));
      root.quaternion.setFromUnitVectors(UP, point.normal);
      root.rotateY(ctx.rng.range(0, Math.PI * 2));

      const visual = this.template.clone(true);
      visual.scale.setScalar(mushroomScale);
      root.add(visual);
      root.visible = false;
      this.parent.add(root);
      root.updateMatrixWorld(true);

      const fruits = this.collectFruitNodes(ctx.key, placementIndex, visual, mushroomScale);
      placements.push({ root, position: root.position.clone(), fruits });
    }

    this.chunks.set(ctx.key, placements);
  }

  private collectFruitNodes(
    chunkKey: string,
    placementIndex: number,
    visual: Object3D,
    mushroomScale: number,
  ): FruitRuntime[] {
    const fruits: FruitRuntime[] = [];
    const matchedRoots: Object3D[] = [];

    visual.traverse((object) => {
      if (!object.name || !FRUIT_NAME_HINT.test(object.name)) return;

      // If both a Fruit group and its child Fruit mesh share a fruit-like name, only
      // harvest the outer object so one visible fruit cannot be grabbed twice.
      let ancestor = object.parent;
      while (ancestor && ancestor !== visual) {
        if (ancestor.name && FRUIT_NAME_HINT.test(ancestor.name)) return;
        ancestor = ancestor.parent;
      }
      matchedRoots.push(object);
    });

    matchedRoots.forEach((node, fruitIndex) => {
      const id = `${chunkKey}:${placementIndex}:${node.name || 'fruit'}:${fruitIndex}`;
      const homeWorld = new Vector3();
      node.getWorldPosition(homeWorld);

      const runtime: FruitRuntime = {
        id,
        node,
        homeParent: node.parent,
        homePosition: node.position.clone(),
        homeQuaternion: node.quaternion.clone(),
        homeScale: node.scale.clone(),
        homeWorld,
        mushroomScale,
        heldBy: null,
        pulledClear: false,
        collected: this.harvestedFruitIds.has(id),
      };

      if (runtime.collected) {
        node.visible = false;
        node.removeFromParent();
      }
      fruits.push(runtime);
    });

    return fruits;
  }

  update(_dt: number, playerPosition: Vector3): void {
    if (this.loadFailed) return;

    for (const placements of this.chunks.values()) {
      for (const placement of placements) {
        const dx = placement.position.x - playerPosition.x;
        const dz = placement.position.z - playerPosition.z;
        placement.root.visible = dx * dx + dz * dz <= RENDER_DISTANCE_SQ;

        if (this.mode !== 'story') continue;
        for (const fruit of placement.fruits) {
          if (fruit.collected) continue;
          if (!placement.root.visible && !fruit.heldBy) continue;
          this.updateFruit(fruit);
        }
      }
    }
  }

  private updateFruit(fruit: FruitRuntime): void {
    if (fruit.heldBy) {
      fruit.node.updateWorldMatrix(true, false);
      fruit.node.getWorldPosition(_fruitWorld);
      const pullRadius = BASE_FRUIT_PULL_CLEAR_RADIUS * this.interactionScale(fruit);
      if (_fruitWorld.distanceTo(fruit.homeWorld) >= pullRadius) fruit.pulledClear = true;

      if (!this.gripHeld(fruit.heldBy)) this.finishFruitGrab(fruit);
      return;
    }

    fruit.node.updateWorldMatrix(true, false);
    fruit.node.getWorldPosition(_fruitWorld);
    fruit.homeWorld.copy(_fruitWorld);

    const grabRadius = BASE_FRUIT_GRAB_RADIUS * this.interactionScale(fruit);
    const leftDistance = this.handDistance('left', _fruitWorld, _leftTip, _leftGrip);
    const rightDistance = this.handDistance('right', _fruitWorld, _rightTip, _rightGrip);

    if (
      leftDistance <= grabRadius &&
      this.gripHeld('left') &&
      this.heldFruitByHand.left === null
    ) {
      this.beginFruitGrab(fruit, 'left');
    } else if (
      rightDistance <= grabRadius &&
      this.gripHeld('right') &&
      this.heldFruitByHand.right === null
    ) {
      this.beginFruitGrab(fruit, 'right');
    }
  }

  private interactionScale(fruit: FruitRuntime): number {
    return Math.min(1.8, Math.max(0.65, fruit.mushroomScale));
  }

  private beginFruitGrab(fruit: FruitRuntime, handedness: Handedness): void {
    if (fruit.collected || fruit.heldBy || this.heldFruitByHand[handedness]) return;
    const grip = this.hands.getObjectGrip(handedness);
    if (!grip) return;

    fruit.node.updateWorldMatrix(true, false);
    fruit.node.getWorldPosition(fruit.homeWorld);
    grip.attach(fruit.node);
    fruit.node.updateMatrixWorld(true);
    fruit.heldBy = handedness;
    fruit.pulledClear = false;
    this.heldFruitByHand[handedness] = fruit;
  }

  private finishFruitGrab(fruit: FruitRuntime): void {
    const handedness = fruit.heldBy;
    if (!handedness) return;

    if (fruit.pulledClear) {
      fruit.collected = true;
      this.harvestedFruitIds.add(fruit.id);
      fruit.node.removeFromParent();
      fruit.node.visible = false;
      this.harvestedFruit += 1;
      console.info(
        `[flora] fruit harvested (${this.harvestedFruit} stored); ` +
          `each fruit = ${FOOD_PER_FRUIT} food / ${WATER_PER_FRUIT} water when consumed`,
      );
    } else {
      this.returnFruitHome(fruit);
    }

    fruit.heldBy = null;
    fruit.pulledClear = false;
    this.heldFruitByHand[handedness] = null;
  }

  private returnFruitHome(fruit: FruitRuntime): void {
    if (!fruit.homeParent) return;
    fruit.homeParent.add(fruit.node);
    fruit.node.position.copy(fruit.homePosition);
    fruit.node.quaternion.copy(fruit.homeQuaternion);
    fruit.node.scale.copy(fruit.homeScale);
    fruit.node.visible = true;
    fruit.node.updateMatrixWorld(true);
    fruit.node.getWorldPosition(fruit.homeWorld);
  }

  private handDistance(
    handedness: Handedness,
    target: Vector3,
    tipScratch: Vector3,
    gripScratch: Vector3,
  ): number {
    const hasTip = this.hands.getIndexTipWorldPosition(handedness, tipScratch);
    const tipDistance = hasTip ? tipScratch.distanceTo(target) : Number.POSITIVE_INFINITY;

    const controllerGrip = this.hands.getControllerGrip(handedness);
    if (!controllerGrip) return tipDistance;
    controllerGrip.updateWorldMatrix(true, false);
    controllerGrip.getWorldPosition(gripScratch);
    return Math.min(tipDistance, gripScratch.distanceTo(target));
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

  /**
   * Removes one stored fruit and returns the survival effect for a future player
   * hunger/thirst system. Returns null when the player has no fruit banked.
   */
  consumeFruit(): { food: number; water: number } | null {
    if (this.harvestedFruit <= 0) return null;
    this.harvestedFruit -= 1;
    return { food: FOOD_PER_FRUIT, water: WATER_PER_FRUIT };
  }

  dispose(key: string): void {
    this.removeChunk(key);
  }

  private removeChunk(key: string): void {
    const placements = this.chunks.get(key);
    if (!placements) return;

    for (const placement of placements) {
      for (const fruit of placement.fruits) {
        if (fruit.heldBy) {
          const hand = fruit.heldBy;
          fruit.node.removeFromParent();
          this.heldFruitByHand[hand] = null;
          fruit.heldBy = null;
        }
      }
      placement.root.removeFromParent();
    }
    this.chunks.delete(key);
  }
}
