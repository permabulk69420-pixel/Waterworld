import {
  Box3,
  Group,
  Matrix4,
  Quaternion,
  Vector3,
  type Object3D,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AlienFishSystem } from '../content/AlienFishSystem.ts';
import type { PrismFishSystem } from '../content/PrismFishSystem.ts';
import type { DensityField } from '../world/density.ts';
import type { PlayerRig } from './PlayerRig.ts';
import type { VRHands } from './VRHands.ts';

const ASSET_URL = './assets/player/motors/alien_onehand_speargun_v4.glb';
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const WORLD_UP = new Vector3(0, 1, 0);

// The authored gun read too large in-hand. Keep the helper alignment intact but make
// the complete tool (including the loaded/fired spear) 40% smaller.
const TOOL_SCALE = 0.6;
// The barrel direction was already correct, but the body hung below the palm. A
// 180-degree roll around local Z preserves local -Z aim while putting the gun above
// the hand instead of underneath it.
const HELD_ROLL = Math.PI;

const PICKUP_RADIUS = 0.5;
const PICKUP_RADIUS_SQ = PICKUP_RADIUS * PICKUP_RADIUS;
const GRIP_THRESHOLD = 0.55;
const FIRE_THRESHOLD = 0.62;
const XR_SPAWN_DELAY_FRAMES = 4;

// A useful VR hunting range rather than a hitscan rifle. Swept collision is used
// between frames, so the projectile cannot tunnel straight through a small fish.
const SPEAR_INITIAL_SPEED = 17.5;
const SPEAR_DRAG_PER_SECOND = 0.42;
const SPEAR_DROP_ACCELERATION = 0.32;
const SPEAR_MAX_RANGE = 24;
const SPEAR_MAX_LIFETIME = 2.3;
const SPEAR_HIT_HOLD_SECONDS = 0.7;
const AUTO_RELOAD_SECONDS = 1.15;
const SPEAR_COLLISION_PADDING = 0.055;
const SPEAR_PENETRATION = 0.07;

// Speared fish are simple kinematic carcasses rather than full rigid bodies. That is
// cheaper and more predictable on Quest: impact carries a little momentum, water drag
// damps it, negative buoyancy pulls the fish down, and the seabed height settles it.
const CARCASS_SINK_ACCELERATION = 0.38;
const CARCASS_WATER_DRAG = 0.7;
const CARCASS_REST_SECONDS = 12;
const CARCASS_MAX_DRIFT_SPEED = 0.55;

// Runtime fish radii follow the actual displayed sizes: ~0.25 m prism fish and
// ~0.74 m larger alien fish. They are deliberately a little generous in VR.
const PRISM_HIT_RADIUS = 0.16 + SPEAR_COLLISION_PADDING;
const ALIEN_HIT_RADIUS = 0.39 + SPEAR_COLLISION_PADDING;
const PRISM_FLOOR_CLEARANCE = 0.13;
const ALIEN_FLOOR_CLEARANCE = 0.32;

const _gripLocal = new Matrix4();
const _worldMatrix = new Matrix4();
const _worldQuat = new Quaternion();
const _headPosition = new Vector3();
const _headQuaternion = new Quaternion();
const _spawnForward = new Vector3();
const _spawnRight = new Vector3();
const _spawnPosition = new Vector3();
const _handPosition = new Vector3();
const _gunPosition = new Vector3();
const _tipBefore = new Vector3();
const _tipAfter = new Vector3();
const _step = new Vector3();
const _segment = new Vector3();
const _pointDelta = new Vector3();
const _closest = new Vector3();
const _fishPosition = new Vector3();
const _impactDirection = new Vector3();

interface FishActionLike {
  stop(): unknown;
}

interface PrismFishInternal {
  root: Object3D;
  currentAction: FishActionLike | null;
  cellKey: string | null;
}

interface PrismFishRuntime {
  activeSchools: Map<string, PrismFishInternal[]>;
  pool: PrismFishInternal[];
}

interface AlienFishInternal {
  root: Object3D;
  currentAction: FishActionLike | null;
  cellKey: string | null;
}

interface AlienFishRuntime {
  activeFish: Map<string, AlienFishInternal>;
  pool: AlienFishInternal[];
}

interface FishHit {
  t: number;
  species: 'prism' | 'alien';
  root: Object3D;
  floorClearance: number;
  detachFromPopulation: () => void;
  recycle: () => void;
}

interface SpeargunPickup {
  root: Group;
  loadedSpear: Object3D | null;
  projectileSpawn: Object3D | null;
  statusLight: Object3D | null;
  held: boolean;
  loaded: boolean;
  reloadTimer: number;
}

interface SpearProjectile {
  root: Object3D;
  velocity: Vector3;
  age: number;
  travelled: number;
  impacted: boolean;
  impactTimer: number;
}

interface SpearedCarcass {
  root: Object3D;
  spear: Object3D;
  velocity: Vector3;
  angularVelocity: Vector3;
  floorClearance: number;
  settled: boolean;
  restTimer: number;
  recycle: () => void;
}

function segmentPointT(point: Vector3, from: Vector3, to: Vector3): { t: number; distanceSq: number } {
  _segment.subVectors(to, from);
  const lengthSq = _segment.lengthSq();
  if (lengthSq <= 1e-8) return { t: 0, distanceSq: point.distanceToSquared(from) };

  _pointDelta.copy(point).sub(from);
  const t = Math.max(0, Math.min(1, _pointDelta.dot(_segment) / lengthSq));
  _closest.copy(from).addScaledVector(_segment, t);
  return { t, distanceSq: point.distanceToSquared(_closest) };
}

/**
 * Physical right-hand one-shot underwater speargun.
 *
 * The GLB provides GripPoint_RH, ProjectileSpawn, ReloadSocket, LineAttachPoint and
 * a distinct Spear_Loaded mesh. The gun aligns from the authored grip helper, fires
 * the authored spear as a swept projectile, and turns a hit live fish into a temporary
 * speared carcass which sinks and settles before returning to that species' pool.
 */
export class SpeargunSystem {
  readonly ready: Promise<void>;
  fishHitCount = 0;

  private template: Object3D | null = null;
  private pickup: SpeargunPickup | null = null;
  private projectile: SpearProjectile | null = null;
  private readonly carcasses: SpearedCarcass[] = [];
  private spearTipLocal = new Vector3(0, 0, -0.69);
  private previousSqueeze = 0;
  private previousTrigger = 0;
  private disposed = false;
  private wasPresenting = false;
  private spawnDelayFrames = XR_SPAWN_DELAY_FRAMES;
  private spawnedForSession = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly hands: VRHands,
    private readonly scene: Scene,
    private readonly rig: PlayerRig,
    private readonly density: DensityField,
    private readonly prismFish: PrismFishSystem,
    private readonly alienFish: AlienFishSystem,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      if (this.disposed) return;

      this.template = gltf.scene;
      this.template.traverse((object) => {
        const mesh = object as Object3D & { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
      });

      const grip = this.template.getObjectByName('GripPoint_RH');
      const spawn = this.template.getObjectByName('ProjectileSpawn');
      const loaded = this.template.getObjectByName('Spear_Loaded');
      const reload = this.template.getObjectByName('ReloadSocket');

      if (!grip) console.warn('[speargun] missing GripPoint_RH; pickup will use scene origin');
      if (!spawn) console.warn('[speargun] missing ProjectileSpawn; firing will use gun origin');
      if (!loaded) console.warn('[speargun] missing Spear_Loaded; gun can fire but projectile has no authored visual');
      if (!reload) console.warn('[speargun] missing ReloadSocket; future physical reload needs a fallback socket');

      if (loaded) {
        this.template.updateMatrixWorld(true);
        const spearBounds = new Box3().setFromObject(loaded);
        if (Number.isFinite(spearBounds.min.z)) {
          this.spearTipLocal.set(
            (spearBounds.min.x + spearBounds.max.x) * 0.5,
            (spearBounds.min.y + spearBounds.max.y) * 0.5,
            spearBounds.min.z,
          );
        }
      }

      const bounds = new Box3().setFromObject(this.template);
      const size = new Vector3();
      bounds.getSize(size);
      console.info(
        `[speargun] loaded ${size.x.toFixed(2)} x ${size.y.toFixed(2)} x ${size.z.toFixed(2)} m; ` +
          `display scale ${TOOL_SCALE.toFixed(2)}; helpers grip=${Boolean(grip)} projectile=${Boolean(spawn)} ` +
          `reload=${Boolean(reload)} spear=${Boolean(loaded)}`,
      );
    } catch (error) {
      console.warn(`[speargun] failed to load ${ASSET_URL}`, error);
    }
  }

  update(dt = 0): void {
    if (this.disposed) return;
    dt = Math.min(Math.max(dt, 0), 0.05);

    this.updateProjectile(dt);
    this.updateCarcasses(dt);
    this.updateReload(dt);

    const presenting = this.renderer.xr.isPresenting;
    if (!presenting) {
      if (this.wasPresenting) this.endSession();
      this.wasPresenting = false;
      return;
    }

    if (!this.wasPresenting) {
      this.wasPresenting = true;
      this.spawnDelayFrames = XR_SPAWN_DELAY_FRAMES;
      this.spawnedForSession = false;
      this.clearPickup();
    }

    if (!this.spawnedForSession) {
      if (this.spawnDelayFrames > 0) this.spawnDelayFrames--;
      else {
        this.spawnNearTrackedHead();
        this.spawnedForSession = true;
      }
    }

    const session = this.renderer.xr.getSession();
    if (!session) return;

    let sawRight = false;
    for (const source of session.inputSources) {
      if (source.handedness !== 'right') continue;
      sawRight = true;

      const squeeze = source.gamepad?.buttons[1]?.value ?? 0;
      const trigger = source.gamepad?.buttons[0]?.value ?? 0;
      const squeezeDown = squeeze >= GRIP_THRESHOLD && this.previousSqueeze < GRIP_THRESHOLD;
      const squeezeUp = squeeze < GRIP_THRESHOLD && this.previousSqueeze >= GRIP_THRESHOLD;
      const triggerDown = trigger >= FIRE_THRESHOLD && this.previousTrigger < FIRE_THRESHOLD;

      if (squeezeDown) this.tryGrab();
      if (squeezeUp) this.release();
      if (triggerDown && this.pickup?.held) this.fire();

      this.previousSqueeze = squeeze;
      this.previousTrigger = trigger;
    }

    if (!sawRight) {
      this.release();
      this.previousSqueeze = 0;
      this.previousTrigger = 0;
    }
  }

  private spawnNearTrackedHead(): void {
    if (!this.template) return;
    this.clearPickup();

    this.rig.getHeadPosition(_headPosition);
    this.rig.getHeadQuaternion(_headQuaternion);

    _spawnForward.copy(LOCAL_FORWARD).applyQuaternion(_headQuaternion);
    _spawnForward.y = 0;
    if (_spawnForward.lengthSq() < 1e-6) _spawnForward.set(0, 0, -1);
    _spawnForward.normalize();

    _spawnRight.set(1, 0, 0).applyQuaternion(_headQuaternion);
    _spawnRight.y = 0;
    if (_spawnRight.lengthSq() < 1e-6) _spawnRight.set(1, 0, 0);
    _spawnRight.normalize();

    const root = this.createPickupRoot();
    root.name = 'world-speargun-right';
    _spawnPosition
      .copy(_headPosition)
      .addScaledVector(_spawnForward, 1.1)
      .addScaledVector(_spawnRight, 0.86)
      .addScaledVector(WORLD_UP, -0.25);
    root.position.copy(_spawnPosition);
    root.quaternion.setFromUnitVectors(LOCAL_FORWARD, _spawnForward);
    root.scale.setScalar(TOOL_SCALE);
    this.scene.add(root);

    const loadedSpear = root.getObjectByName('Spear_Loaded');
    const projectileSpawn = root.getObjectByName('ProjectileSpawn');
    const statusLight = root.getObjectByName('StatusLight');
    if (loadedSpear) loadedSpear.visible = true;
    if (statusLight) statusLight.visible = true;

    this.pickup = {
      root,
      loadedSpear,
      projectileSpawn,
      statusLight,
      held: false,
      loaded: true,
      reloadTimer: 0,
    };
  }

  /** Builds a pickup whose local origin is the authored right-hand grip helper. */
  private createPickupRoot(): Group {
    const anchor = new Group();
    const visual = this.template!.clone(true);
    visual.name = 'speargun-visual';

    const gripPoint = visual.getObjectByName('GripPoint_RH');
    if (gripPoint) {
      visual.updateMatrixWorld(true);
      gripPoint.updateWorldMatrix(true, false);
      _gripLocal.copy(visual.matrixWorld).invert().multiply(gripPoint.matrixWorld).invert();
      _gripLocal.decompose(visual.position, visual.quaternion, visual.scale);
    }

    anchor.add(visual);
    return anchor;
  }

  private tryGrab(): void {
    const pickup = this.pickup;
    if (!pickup || pickup.held) return;

    const palm = this.hands.getObjectGrip('right');
    if (!palm) return;
    palm.updateWorldMatrix(true, false);
    palm.getWorldPosition(_handPosition);
    pickup.root.updateWorldMatrix(true, false);
    pickup.root.getWorldPosition(_gunPosition);
    if (_gunPosition.distanceToSquared(_handPosition) > PICKUP_RADIUS_SQ) return;

    palm.add(pickup.root);
    pickup.root.position.set(0, 0, 0);
    pickup.root.rotation.set(0, 0, HELD_ROLL);
    pickup.root.scale.setScalar(TOOL_SCALE);
    pickup.held = true;
  }

  private release(): void {
    const pickup = this.pickup;
    if (!pickup?.held) return;
    this.scene.attach(pickup.root);
    pickup.held = false;
  }

  private fire(): void {
    const pickup = this.pickup;
    if (!pickup || !pickup.loaded || pickup.reloadTimer > 0 || this.projectile) return;

    const loaded = pickup.loadedSpear;
    if (!loaded) return;

    loaded.updateWorldMatrix(true, false);
    _worldMatrix.copy(loaded.matrixWorld);

    const projectileRoot = loaded.clone(true);
    projectileRoot.name = 'world-speargun-spear-projectile';
    projectileRoot.visible = true;
    this.scene.add(projectileRoot);
    _worldMatrix.decompose(projectileRoot.position, projectileRoot.quaternion, projectileRoot.scale);
    projectileRoot.updateMatrixWorld(true);

    const direction = new Vector3();
    const spawn = pickup.projectileSpawn;
    if (spawn) {
      spawn.updateWorldMatrix(true, false);
      spawn.getWorldQuaternion(_worldQuat);
      direction.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
    } else {
      pickup.root.updateWorldMatrix(true, false);
      pickup.root.getWorldQuaternion(_worldQuat);
      direction.copy(LOCAL_FORWARD).applyQuaternion(_worldQuat).normalize();
    }

    pickup.loaded = false;
    loaded.visible = false;
    if (pickup.statusLight) pickup.statusLight.visible = false;

    this.projectile = {
      root: projectileRoot,
      velocity: direction.multiplyScalar(SPEAR_INITIAL_SPEED),
      age: 0,
      travelled: 0,
      impacted: false,
      impactTimer: 0,
    };
  }

  private updateProjectile(dt: number): void {
    const projectile = this.projectile;
    if (!projectile || dt <= 0) return;

    if (projectile.impacted) {
      projectile.impactTimer -= dt;
      if (projectile.impactTimer <= 0) this.finishProjectile();
      return;
    }

    this.projectileTipWorld(projectile.root, _tipBefore);

    projectile.age += dt;
    projectile.velocity.y -= SPEAR_DROP_ACCELERATION * dt;
    projectile.velocity.multiplyScalar(Math.exp(-SPEAR_DRAG_PER_SECOND * dt));
    _step.copy(projectile.velocity).multiplyScalar(dt);
    projectile.root.position.add(_step);
    projectile.travelled += _step.length();
    projectile.root.updateMatrixWorld(true);

    this.projectileTipWorld(projectile.root, _tipAfter);

    const fishHit = this.findNearestFishHit(_tipBefore, _tipAfter);
    if (fishHit) {
      // Back the projectile up to the swept impact time rather than leaving it one
      // full frame past the fish, then push the spear a few centimetres into the body.
      projectile.root.position.addScaledVector(_step, -(1 - fishHit.t));
      _impactDirection.copy(projectile.velocity);
      if (_impactDirection.lengthSq() > 1e-8) {
        _impactDirection.normalize();
        projectile.root.position.addScaledVector(_impactDirection, SPEAR_PENETRATION);
      }
      projectile.root.updateMatrixWorld(true);

      this.beginSpearedCarcass(fishHit, projectile);
      this.fishHitCount += 1;
      console.info(`[speargun] ${fishHit.species} fish speared (${this.fishHitCount} total)`);
      return;
    }

    if (this.density.sample(_tipAfter.x, _tipAfter.y, _tipAfter.z) > 0) {
      this.impactProjectile();
      return;
    }

    if (projectile.travelled >= SPEAR_MAX_RANGE || projectile.age >= SPEAR_MAX_LIFETIME) {
      this.finishProjectile();
    }
  }

  private projectileTipWorld(root: Object3D, target: Vector3): void {
    root.updateWorldMatrix(true, false);
    target.copy(this.spearTipLocal).applyMatrix4(root.matrixWorld);
  }

  private impactProjectile(): void {
    if (!this.projectile) return;
    this.projectile.impacted = true;
    this.projectile.impactTimer = SPEAR_HIT_HOLD_SECONDS;
    this.projectile.velocity.set(0, 0, 0);
  }

  private beginSpearedCarcass(hit: FishHit, projectile: SpearProjectile): void {
    hit.detachFromPopulation();

    // Attach preserves the spear's world transform, so it remains visibly embedded at
    // the exact angle and depth it hit instead of snapping to a canned socket.
    hit.root.updateWorldMatrix(true, false);
    hit.root.attach(projectile.root);

    const velocity = projectile.velocity.clone().multiplyScalar(0.025);
    if (velocity.length() > CARCASS_MAX_DRIFT_SPEED) velocity.setLength(CARCASS_MAX_DRIFT_SPEED);
    velocity.y = Math.min(velocity.y, -0.08);

    this.carcasses.push({
      root: hit.root,
      spear: projectile.root,
      velocity,
      angularVelocity: new Vector3(
        (Math.random() - 0.5) * 0.24,
        (Math.random() - 0.5) * 0.12,
        (Math.random() - 0.5) * 0.32,
      ),
      floorClearance: hit.floorClearance,
      settled: false,
      restTimer: CARCASS_REST_SECONDS,
      recycle: hit.recycle,
    });

    // The fired spear now belongs to the carcass. Clearing projectile lets the gun
    // reload independently while the previous fish/spear pair continues sinking.
    this.projectile = null;
    if (this.pickup && !this.pickup.loaded) this.pickup.reloadTimer = AUTO_RELOAD_SECONDS;
  }

  private updateCarcasses(dt: number): void {
    for (let index = this.carcasses.length - 1; index >= 0; index--) {
      const carcass = this.carcasses[index]!;

      if (!carcass.settled) {
        carcass.velocity.y -= CARCASS_SINK_ACCELERATION * dt;
        carcass.velocity.multiplyScalar(Math.exp(-CARCASS_WATER_DRAG * dt));
        carcass.root.position.addScaledVector(carcass.velocity, dt);
        carcass.root.rotateX(carcass.angularVelocity.x * dt);
        carcass.root.rotateY(carcass.angularVelocity.y * dt);
        carcass.root.rotateZ(carcass.angularVelocity.z * dt);

        const seabed = this.density.seabedAt(carcass.root.position.x, carcass.root.position.z);
        const floorY = seabed + carcass.floorClearance;
        if (carcass.root.position.y <= floorY) {
          carcass.root.position.y = floorY;
          carcass.velocity.set(0, 0, 0);
          carcass.angularVelocity.set(0, 0, 0);
          carcass.settled = true;
          carcass.restTimer = CARCASS_REST_SECONDS;
        }
        continue;
      }

      carcass.restTimer -= dt;
      if (carcass.restTimer <= 0) this.recycleCarcass(index);
    }
  }

  private recycleCarcass(index: number): void {
    const carcass = this.carcasses[index];
    if (!carcass) return;
    carcass.spear.removeFromParent();
    carcass.recycle();
    this.carcasses.splice(index, 1);
  }

  private finishProjectile(): void {
    if (!this.projectile) return;
    this.projectile.root.removeFromParent();
    this.projectile = null;
    if (this.pickup && !this.pickup.loaded) this.pickup.reloadTimer = AUTO_RELOAD_SECONDS;
  }

  private updateReload(dt: number): void {
    const pickup = this.pickup;
    if (!pickup || pickup.loaded || pickup.reloadTimer <= 0 || this.projectile) return;
    pickup.reloadTimer = Math.max(0, pickup.reloadTimer - dt);
    if (pickup.reloadTimer > 0) return;

    pickup.loaded = true;
    if (pickup.loadedSpear) pickup.loadedSpear.visible = true;
    if (pickup.statusLight) pickup.statusLight.visible = true;
  }

  private findNearestFishHit(from: Vector3, to: Vector3): FishHit | null {
    let best: FishHit | null = null;

    // Keep the weapon adapter isolated here. The fauna systems still own spawning,
    // animation and pooling; a speared fish is merely withheld from its pool until its
    // temporary carcass finishes sinking/resting.
    const prism = this.prismFish as unknown as PrismFishRuntime;
    for (const [schoolKey, school] of prism.activeSchools) {
      for (const fish of school) {
        if (!fish.root.visible) continue;
        fish.root.getWorldPosition(_fishPosition);
        const hit = segmentPointT(_fishPosition, from, to);
        if (hit.distanceSq > PRISM_HIT_RADIUS * PRISM_HIT_RADIUS) continue;
        if (best && hit.t >= best.t) continue;

        let detached = false;
        let recycled = false;
        best = {
          t: hit.t,
          species: 'prism',
          root: fish.root,
          floorClearance: PRISM_FLOOR_CLEARANCE,
          detachFromPopulation: () => {
            if (detached) return;
            const currentSchool = prism.activeSchools.get(schoolKey);
            if (!currentSchool) return;
            const fishIndex = currentSchool.indexOf(fish);
            if (fishIndex < 0) return;
            currentSchool.splice(fishIndex, 1);
            if (currentSchool.length === 0) prism.activeSchools.delete(schoolKey);
            fish.currentAction?.stop();
            fish.currentAction = null;
            fish.cellKey = null;
            fish.root.visible = true;
            detached = true;
          },
          recycle: () => {
            if (recycled) return;
            fish.root.visible = false;
            prism.pool.push(fish);
            recycled = true;
          },
        };
      }
    }

    const alien = this.alienFish as unknown as AlienFishRuntime;
    for (const [cellKey, fish] of alien.activeFish) {
      if (!fish.root.visible) continue;
      fish.root.getWorldPosition(_fishPosition);
      const hit = segmentPointT(_fishPosition, from, to);
      if (hit.distanceSq > ALIEN_HIT_RADIUS * ALIEN_HIT_RADIUS) continue;
      if (best && hit.t >= best.t) continue;

      let detached = false;
      let recycled = false;
      best = {
        t: hit.t,
        species: 'alien',
        root: fish.root,
        floorClearance: ALIEN_FLOOR_CLEARANCE,
        detachFromPopulation: () => {
          if (detached || alien.activeFish.get(cellKey) !== fish) return;
          alien.activeFish.delete(cellKey);
          fish.currentAction?.stop();
          fish.currentAction = null;
          fish.cellKey = null;
          fish.root.visible = true;
          detached = true;
        },
        recycle: () => {
          if (recycled) return;
          fish.root.visible = false;
          alien.pool.push(fish);
          recycled = true;
        },
      };
    }

    return best;
  }

  private clearPickup(): void {
    this.release();
    this.pickup?.root.removeFromParent();
    this.pickup = null;
  }

  private clearProjectile(): void {
    this.projectile?.root.removeFromParent();
    this.projectile = null;
  }

  private clearCarcasses(): void {
    for (let index = this.carcasses.length - 1; index >= 0; index--) this.recycleCarcass(index);
  }

  private endSession(): void {
    this.clearPickup();
    this.clearProjectile();
    this.clearCarcasses();
    this.previousSqueeze = 0;
    this.previousTrigger = 0;
    this.spawnedForSession = false;
  }

  dispose(): void {
    this.disposed = true;
    this.endSession();
    this.template = null;
  }
}
