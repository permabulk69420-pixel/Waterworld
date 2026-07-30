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
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Environment } from '../environment/Environment.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { DensityField } from '../world/density.ts';
import type { ColossusMushroomSystem } from './ColossusMushroomSystem.ts';

const ASSET_URL = './assets/fauna/riftmaw_hunter_alien_shark_4_8m_v1.glb';

// One territorial specimen for now. It patrols the Colossus rather than joining
// the normal streamed fauna population, which keeps the encounter memorable and cheap.
const PATROL_RADIUS_MIN = 18;
const PATROL_RADIUS_MAX = 27;
const PATROL_SPEED = 1.55;
const PATROL_TURN_RATE = 1.7;
const DETECTION_DISTANCE = 18;
const ABANDON_CHASE_DISTANCE = 34;
const BITE_DISTANCE = 2.8;
const CHARGE_SPEED = 6.6;
const CHARGE_TURN_RATE = 4.6;
const RECOVER_SPEED = 3.3;
const TERRITORY_RADIUS = 40;
const BOTTOM_CLEARANCE = 2.4;
const SURFACE_CLEARANCE = 2.0;
const RENDER_DISTANCE = 190;

const _player = new Vector3();
const _anchorBase = new Vector3();
const _target = new Vector3();
const _desired = new Vector3();
const _next = new Vector3();
const _lookTarget = new Vector3();
const _size = new Vector3();

type RiftmawState = 'patrol' | 'alert' | 'charge' | 'bite' | 'recover';

/**
 * First hostile-fauna encounter: one Riftmaw that treats the Colossus mushroom
 * as its territory.
 *
 * The source asset is authored +Y up, local -Z forward and at metre scale, so no
 * orientation or size correction is applied. Its baked clips drive the visible
 * behaviour while simple kinematic steering keeps the prototype deterministic
 * and avoids introducing a physics engine just for one predator.
 *
 * Player health does not exist yet, so Attack_Bite is intentionally visual only.
 */
export class RiftmawHunterSystem {
  readonly ready: Promise<void>;

  private readonly root = new Group();
  private readonly anchor = new Vector3();
  private readonly direction = new Vector3(0, 0, -1);
  private readonly desiredQuaternion = new Quaternion();
  private readonly lookHelper = new Object3D();
  private readonly actions = new Map<string, AnimationAction>();

  private model: Object3D | null = null;
  private mixer: AnimationMixer | null = null;
  private currentAction: AnimationAction | null = null;
  private state: RiftmawState = 'patrol';
  private stateTimer = 0;
  private patrolAngle = 0;
  private patrolRadius = 22;
  private loadFailed = false;

  constructor(
    private readonly scene: Scene,
    private readonly density: DensityField,
    private readonly environment: Environment,
    private readonly rig: PlayerRig,
    private readonly colossus: ColossusMushroomSystem,
  ) {
    this.root.name = 'fauna:riftmaw-hunter-colossus';
    this.root.visible = false;
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const gltf = await new GLTFLoader().loadAsync(ASSET_URL);
      this.model = gltf.scene;
      this.model.updateMatrixWorld(true);

      this.model.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.castShadow = false;
        object.receiveShadow = false;
      });

      const bounds = new Box3().setFromObject(this.model);
      bounds.getSize(_size);
      if (_size.lengthSq() <= 0.001) throw new Error('Riftmaw GLB has invalid bounds');

      this.mixer = new AnimationMixer(this.model);
      for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));

      const requiredClips = [
        'Idle_Hover',
        'Patrol_Swim',
        'Charge_Loop',
        'Alert_Display',
        'Attack_Bite',
        'Hit_Recoil',
        'Death_Sink',
      ];
      const missingClips = requiredClips.filter((name) => !this.actions.has(name));

      if (!this.colossus.getWorldPosition(_anchorBase)) {
        throw new Error('Colossus landmark position unavailable for Riftmaw territory');
      }

      const seabed = this.density.seabedAt(_anchorBase.x, _anchorBase.z);
      const maxY = this.environment.seaLevel - SURFACE_CLEARANCE;
      const preferredY = seabed + 8.5;
      this.anchor.set(_anchorBase.x, Math.min(maxY, Math.max(seabed + BOTTOM_CLEARANCE, preferredY)), _anchorBase.z);

      this.patrolAngle = 0.75;
      this.patrolRadius = MathUtils.lerp(PATROL_RADIUS_MIN, PATROL_RADIUS_MAX, 0.56);
      this.root.position.set(
        this.anchor.x + Math.cos(this.patrolAngle) * this.patrolRadius,
        this.anchor.y,
        this.anchor.z + Math.sin(this.patrolAngle) * this.patrolRadius,
      );
      this.direction.set(-Math.sin(this.patrolAngle), 0, Math.cos(this.patrolAngle)).normalize();
      this.faceDirection(1, PATROL_TURN_RATE);

      this.root.add(this.model);
      this.scene.add(this.root);
      this.root.visible = true;
      this.enterState('patrol');

      const attackOrigin = this.model.getObjectByName('AttackOrigin_Mouth');
      console.info(
        `[fauna] Riftmaw hunter loaded: ${_size.x.toFixed(2)} x ${_size.y.toFixed(2)} x ${_size.z.toFixed(2)} m; ` +
          `clips ${gltf.animations.map((clip) => clip.name).join(', ') || 'none'}; ` +
          `mouth origin ${attackOrigin ? 'yes' : 'no'}; missing clips ${missingClips.join(', ') || 'none'}; ` +
          `territory (${this.anchor.x.toFixed(1)}, ${this.anchor.z.toFixed(1)})`,
      );
    } catch (error) {
      this.loadFailed = true;
      console.warn(`[fauna] failed to load Riftmaw hunter at ${ASSET_URL}`, error);
    }
  }

  update(dt: number, elapsed: number): void {
    if (this.loadFailed || !this.model || !this.mixer) return;

    dt = Math.min(Math.max(dt, 0), 0.05);
    this.mixer.update(dt);
    this.rig.getHeadPosition(_player);

    this.root.visible = this.root.position.distanceToSquared(_player) <= RENDER_DISTANCE * RENDER_DISTANCE;

    const playerDistance = this.root.position.distanceTo(_player);
    const playerUnderwater = this.environment.underwater;

    if (this.state === 'patrol') {
      if (playerUnderwater && playerDistance <= DETECTION_DISTANCE) {
        this.enterState('alert');
      } else {
        this.updatePatrol(dt, elapsed);
      }
    } else if (this.state === 'alert') {
      this.stateTimer -= dt;
      this.steerToward(_player, dt, 3.4);
      this.move(dt, 0.35);
      if (this.stateTimer <= 0) {
        if (playerUnderwater && playerDistance <= ABANDON_CHASE_DISTANCE) this.enterState('charge');
        else this.enterState('patrol');
      }
    } else if (this.state === 'charge') {
      this.steerToward(_player, dt, CHARGE_TURN_RATE);
      this.move(dt, CHARGE_SPEED);

      const territoryDistance = Math.hypot(this.root.position.x - this.anchor.x, this.root.position.z - this.anchor.z);
      if (!playerUnderwater || playerDistance > ABANDON_CHASE_DISTANCE || territoryDistance > TERRITORY_RADIUS) {
        this.enterState('recover');
      } else if (playerDistance <= BITE_DISTANCE) {
        this.enterState('bite');
      }
    } else if (this.state === 'bite') {
      this.stateTimer -= dt;
      this.steerToward(_player, dt, 5.2);
      this.move(dt, 2.2);
      if (this.stateTimer <= 0) this.enterState('recover');
    } else {
      this.stateTimer -= dt;
      _target.copy(this.anchor);
      const distanceFromAnchor = this.root.position.distanceTo(this.anchor);
      if (distanceFromAnchor > PATROL_RADIUS_MAX + 2) {
        this.steerToward(_target, dt, 2.8);
      } else {
        _desired.copy(this.root.position).sub(_player);
        _desired.y *= 0.25;
        if (_desired.lengthSq() > 0.001) {
          _target.copy(this.root.position).add(_desired.normalize().multiplyScalar(8));
          this.steerToward(_target, dt, 2.4);
        }
      }
      this.move(dt, RECOVER_SPEED);
      if (this.stateTimer <= 0) this.enterState('patrol');
    }

    this.faceDirection(dt, this.state === 'charge' || this.state === 'bite' ? CHARGE_TURN_RATE : PATROL_TURN_RATE);
  }

  private updatePatrol(dt: number, elapsed: number): void {
    this.patrolAngle += (PATROL_SPEED / this.patrolRadius) * dt;

    _target.set(
      this.anchor.x + Math.cos(this.patrolAngle) * this.patrolRadius,
      this.anchor.y + Math.sin(elapsed * 0.42) * 1.35,
      this.anchor.z + Math.sin(this.patrolAngle) * this.patrolRadius,
    );
    this.steerToward(_target, dt, PATROL_TURN_RATE);
    this.move(dt, PATROL_SPEED);
  }

  private steerToward(target: Vector3, dt: number, turnRate: number): void {
    _desired.copy(target).sub(this.root.position);
    if (_desired.lengthSq() <= 0.0001) return;
    _desired.normalize();
    this.direction.lerp(_desired, 1 - Math.exp(-turnRate * dt)).normalize();
  }

  private move(dt: number, speed: number): void {
    _next.copy(this.root.position).addScaledVector(this.direction, speed * dt);

    const seabed = this.density.seabedAt(_next.x, _next.z);
    const minY = seabed + BOTTOM_CLEARANCE;
    const maxY = this.environment.seaLevel - SURFACE_CLEARANCE;

    if (maxY <= minY) {
      this.direction.x *= -1;
      this.direction.z *= -1;
      return;
    }

    _next.y = MathUtils.clamp(_next.y, minY, maxY);

    if (this.density.sample(_next.x, _next.y, _next.z) > 0) {
      _desired.copy(this.anchor).sub(this.root.position);
      _desired.y *= 0.25;
      if (_desired.lengthSq() > 0.001) this.direction.lerp(_desired.normalize(), 0.55).normalize();
      return;
    }

    this.root.position.copy(_next);
  }

  private enterState(state: RiftmawState): void {
    this.state = state;

    if (state === 'patrol') {
      this.stateTimer = 0;
      this.playClip('Patrol_Swim', true, 1, 0.16);
      return;
    }

    if (state === 'alert') {
      this.stateTimer = this.playClip('Alert_Display', false, 1, 0.1, 1.35);
      return;
    }

    if (state === 'charge') {
      this.stateTimer = 0;
      this.playClip('Charge_Loop', true, 1.08, 0.08);
      return;
    }

    if (state === 'bite') {
      this.stateTimer = this.playClip('Attack_Bite', false, 1.05, 0.04, 0.9);
      return;
    }

    this.stateTimer = 2.4;
    this.playClip('Patrol_Swim', true, 1.15, 0.12);
  }

  private playClip(
    name: string,
    repeat: boolean,
    timeScale: number,
    fade: number,
    fallbackDuration = 1,
  ): number {
    const next = this.actions.get(name) ?? this.findActionCaseInsensitive(name);
    if (!next) {
      console.warn(`[fauna] Riftmaw clip missing: ${name}`);
      return fallbackDuration;
    }

    if (next === this.currentAction && repeat) {
      next.timeScale = timeScale;
      return next.getClip().duration / Math.max(0.01, Math.abs(timeScale));
    }

    next.enabled = true;
    next.reset();
    next.setLoop(repeat ? LoopRepeat : LoopOnce, repeat ? Infinity : 1);
    next.clampWhenFinished = !repeat;
    next.timeScale = timeScale;
    next.setEffectiveWeight(1);
    next.play();

    if (this.currentAction && this.currentAction !== next) this.currentAction.crossFadeTo(next, fade, false);
    else next.fadeIn(Math.max(0.01, fade));

    this.currentAction = next;
    return next.getClip().duration / Math.max(0.01, Math.abs(timeScale));
  }

  private findActionCaseInsensitive(name: string): AnimationAction | undefined {
    const wanted = name.toLowerCase();
    for (const [clipName, action] of this.actions) {
      if (clipName.toLowerCase() === wanted) return action;
    }
    return undefined;
  }

  private faceDirection(dt: number, turnRate: number): void {
    if (this.direction.lengthSq() <= 0.0001) return;

    _lookTarget.copy(this.root.position).add(this.direction);
    this.lookHelper.position.copy(this.root.position);
    this.lookHelper.up.set(0, 1, 0);
    this.lookHelper.lookAt(_lookTarget);

    // The Riftmaw is authored forward along local -Z. Object3D.lookAt points +Z.
    this.lookHelper.rotateY(Math.PI);
    this.desiredQuaternion.copy(this.lookHelper.quaternion);
    this.root.quaternion.slerp(this.desiredQuaternion, 1 - Math.exp(-turnRate * dt));
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    this.root.removeFromParent();

    this.model?.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });

    this.actions.clear();
    this.currentAction = null;
    this.model = null;
    this.mixer = null;
  }
}
