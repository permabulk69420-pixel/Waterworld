import { MathUtils, Quaternion, Vector3 } from 'three';
import { Capsule } from '../physics/Capsule.ts';
import type { CollisionWorld } from '../physics/CollisionWorld.ts';
import type { PlayerRig } from './PlayerRig.ts';
import type { PlayerConfig } from './playerConfig.ts';
import type { MoveIntent } from './inputTypes.ts';
import { damp } from '../math/mathUtils.ts';

const _forward = new Vector3();
const _right = new Vector3();
const _target = new Vector3();
const _head = new Vector3();
const _before = new Vector3();
const _delta = new Vector3();
const _step = new Vector3();
const _q = new Quaternion();
const WORLD_UP = new Vector3(0, 1, 0);

export interface LocomotionState {
  speed: number;
  contacts: number;
  grounded: boolean;
  correction: number;
  substeps: number;
}

/**
 * Free-swimming locomotion with terrain collision.
 *
 * Design notes:
 *  - No gravity. The player is neutrally buoyant, so velocity only changes
 *    because of input, drag or a collision.
 *  - Velocity is eased toward the stick target rather than set from it, so
 *    there are no instant velocity changes in either direction.
 *  - Turning is rate-limited and eased for the same reason, and always happens
 *    about the head (see PlayerRig.rotateAroundHead).
 *  - The capsule is rebuilt from the *current* head position every frame, so
 *    physically leaning into a cave wall pushes the rig back out. The player's
 *    view is never rotated or snapped by the solver.
 */
export class Locomotion {
  readonly velocity = new Vector3();
  readonly capsule = new Capsule();

  private turnRate = 0;
  readonly state: LocomotionState = {
    speed: 0,
    contacts: 0,
    grounded: false,
    correction: 0,
    substeps: 1,
  };

  constructor(
    private readonly rig: PlayerRig,
    private readonly collision: CollisionWorld,
    private readonly config: PlayerConfig,
  ) {}

  update(dt: number, intent: MoveIntent, extraYaw = 0): void {
    if (dt <= 0) return;
    const cfg = this.config;

    // --- turning -----------------------------------------------------------
    const targetTurnRate = -intent.turn * MathUtils.degToRad(cfg.turnSpeedDegrees);
    this.turnRate = damp(this.turnRate, targetTurnRate, cfg.turnSmoothing, dt);
    const yaw = this.turnRate * dt + extraYaw;
    if (Math.abs(yaw) > 1e-7) this.rig.rotateAroundHead(yaw);

    // --- desired velocity --------------------------------------------------
    this.rig.getHeadForward(_forward);
    if (!cfg.headRelativeVertical) {
      _forward.y = 0;
      if (_forward.lengthSq() < 1e-6) {
        // Looking straight up or down with vertical movement disabled: fall
        // back to the head's up vector so input never dies completely.
        this.rig.getHeadQuaternion(_q);
        _forward.set(0, 1, 0).applyQuaternion(_q);
        _forward.y = 0;
      }
      _forward.normalize();
    }
    this.rig.getHeadRight(_right);

    const speed = cfg.swimSpeed * (1 + (cfg.boostMultiplier - 1) * intent.boost);
    _target.set(0, 0, 0);
    _target.addScaledVector(_forward, intent.forward * speed);
    _target.addScaledVector(_right, intent.strafe * speed);
    _target.addScaledVector(WORLD_UP, intent.vertical * cfg.verticalSpeed);

    // Diagonal input should not exceed the top speed.
    const targetSpeed = _target.length();
    const maxSpeed = Math.hypot(speed, cfg.verticalSpeed);
    if (targetSpeed > maxSpeed) _target.multiplyScalar(maxSpeed / targetSpeed);

    // --- integrate ---------------------------------------------------------
    const rate = targetSpeed > 0.01 ? cfg.acceleration : cfg.deceleration;
    this.velocity.x = damp(this.velocity.x, _target.x, rate, dt);
    this.velocity.y = damp(this.velocity.y, _target.y, rate, dt);
    this.velocity.z = damp(this.velocity.z, _target.z, rate, dt);
    this.velocity.multiplyScalar(Math.max(0, 1 - cfg.drag * dt));
    if (this.velocity.lengthSq() < 1e-6) this.velocity.set(0, 0, 0);

    this.move(dt);
  }

  /** Sweeps the capsule, resolving collisions, and moves the rig to match. */
  private move(dt: number): void {
    const cfg = this.config;

    this.rig.getHeadPosition(_head);
    this.capsule.setFromHead(_head, cfg.bodyHeight, cfg.bodyRadius);
    _before.copy(this.capsule.end);

    // Substep so a fast swimmer cannot pass through a thin cave wall.
    const distance = this.velocity.length() * dt;
    const maxStep = cfg.bodyRadius * cfg.maxSubstepFraction;
    const substeps = Math.max(1, Math.min(6, Math.ceil(distance / Math.max(0.01, maxStep))));
    const sub = dt / substeps;

    let contacts = 0;
    let correction = 0;
    let grounded = false;

    for (let i = 0; i < substeps; i++) {
      _step.copy(this.velocity).multiplyScalar(sub);
      this.capsule.translate(_step);
      const result = this.collision.resolveCapsule(this.capsule, this.velocity);
      contacts += result.contacts;
      correction += result.correction;
      grounded = grounded || result.grounded;
    }

    _delta.subVectors(this.capsule.end, _before);
    if (_delta.lengthSq() > 0) this.rig.translate(_delta);

    this.state.speed = this.velocity.length();
    this.state.contacts = contacts;
    this.state.correction = correction;
    this.state.grounded = grounded;
    this.state.substeps = substeps;
  }

  /**
   * Places the player at a world position, cancelling momentum. Used for spawn
   * and for the debug teleport.
   */
  teleport(position: Vector3): void {
    this.velocity.set(0, 0, 0);
    this.turnRate = 0;
    this.rig.setHeadPosition(position);
  }

  /**
   * Pushes the player out of terrain without moving them otherwise. Called
   * once after the initial chunk load in case spawn landed inside geometry.
   */
  settle(): void {
    this.rig.getHeadPosition(_head);
    this.capsule.setFromHead(_head, this.config.bodyHeight, this.config.bodyRadius);
    _before.copy(this.capsule.end);
    this.collision.resolveCapsule(this.capsule, null);
    _delta.subVectors(this.capsule.end, _before);
    if (_delta.lengthSq() > 0) this.rig.translate(_delta);
  }
}
