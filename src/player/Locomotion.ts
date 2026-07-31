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
 * Swimming / surface / above-water locomotion with terrain collision.
 *
 * Underwater the player is neutrally buoyant and can move freely in 3D. At the
 * ocean surface their eyes are held just above the local animated wave, so the
 * ascend control or looking upward cannot turn swimming into flight. If terrain
 * physically lifts the capsule clear of the sea, movement switches to horizontal
 * walking/falling with gravity. Falling back into the water restores swimming.
 */
export class Locomotion {
  readonly velocity = new Vector3();
  readonly capsule = new Capsule();

  private turnRate = 0;
  private swimming = true;
  private externalClimbActive = false;
  /** 0 = no lift bladder; 1/2 are one or two physically held buoyant bladders. */
  private externalBuoyancy = 0;
  /** Sum of the two tracked hand-motor directions, each weighted 0..1 by trigger. */
  private readonly propulsionInput = new Vector3();

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

  /**
   * Supplies the current handheld-motor thrust vector. A single full trigger has
   * magnitude 1; two aligned full triggers can reach magnitude 2. The vector is
   * intentionally not normalized so two motors really do push harder than one.
   */
  setPropulsionInput(input: Vector3): void {
    this.propulsionInput.copy(input);
    const maxSq = 4;
    if (this.propulsionInput.lengthSq() > maxSq) this.propulsionInput.setLength(2);
  }

  clearPropulsionInput(): void {
    this.propulsionInput.set(0, 0, 0);
  }

  /**
   * Supplies biological upward lift from physically held objects. Strength is
   * intentionally continuous, although the lift-bladder system currently feeds
   * 0, 1 or 2 for the number of occupied hands.
   */
  setExternalBuoyancy(strength: number): void {
    this.externalBuoyancy = MathUtils.clamp(strength, 0, 2);
  }

  clearExternalBuoyancy(): void {
    this.externalBuoyancy = 0;
  }

  /**
   * Used by deliberate hand-over-hand climbing interactions. While active, normal
   * swim/walk acceleration and the ocean-surface head clamp stand down, but the
   * player capsule still resolves against world collision every frame.
   */
  setExternalClimbActive(active: boolean): void {
    this.externalClimbActive = active;
    if (active) {
      this.velocity.set(0, 0, 0);
      this.clearPropulsionInput();
    }
  }

  /**
   * @param surfaceY Local animated ocean height at the player. Omit only for
   * legacy/debug callers that intentionally want unrestricted swimming.
   */
  update(dt: number, intent: MoveIntent, extraYaw = 0, surfaceY?: number): void {
    if (dt <= 0) return;
    const cfg = this.config;

    // --- turning -----------------------------------------------------------
    const targetTurnRate = -intent.turn * MathUtils.degToRad(cfg.turnSpeedDegrees);
    this.turnRate = damp(this.turnRate, targetTurnRate, cfg.turnSmoothing, dt);
    const yaw = this.turnRate * dt + extraYaw;
    if (Math.abs(yaw) > 1e-7) this.rig.rotateAroundHead(yaw);

    // Hand-over-hand climbing owns translation while a hand is anchored. Keep
    // collision alive, but do not let swimming, gravity or the surface clamp undo
    // the physical pull that was applied earlier in the frame.
    if (this.externalClimbActive) {
      this.velocity.set(0, 0, 0);
      this.clearPropulsionInput();
      this.move(dt);
      return;
    }

    this.rig.getHeadPosition(_head);

    const haveSurface = Number.isFinite(surfaceY);
    const localSurface = haveSurface ? (surfaceY as number) : Number.POSITIVE_INFINITY;
    const surfaceHeadCap = localSurface + cfg.surfaceEyeClearance;

    // Falling back into the sea immediately restores neutral-buoyant swimming.
    if (!this.swimming && _head.y <= surfaceHeadCap) {
      this.swimming = true;
      if (this.velocity.y < -cfg.verticalSpeed) this.velocity.y = -cfg.verticalSpeed;
    }

    // A teleport/debug move that leaves us clearly above the ocean should not
    // preserve underwater flight forever. Normal shore exits are handled after
    // collision below so room-scale head movement alone cannot accidentally do it.
    if (this.swimming && haveSurface && _head.y > localSurface + cfg.surfaceExitClearance + 0.5) {
      this.swimming = false;
    }

    if (this.swimming) {
      this.updateSwimmingVelocity(dt, intent, haveSurface ? surfaceHeadCap : undefined);
    } else {
      this.updateAboveWaterVelocity(dt, intent);
    }

    this.applyExternalBuoyancy(dt);
    this.move(dt);

    if (this.swimming && haveSurface) {
      this.rig.getHeadPosition(_head);

      // A lift bladder is deliberately allowed to carry the player through the
      // water/air boundary. Without this branch the ordinary swimmer surface clamp
      // would pin their eyes to the wave and the biological balloon could never be
      // used to reach floating islands.
      if (this.externalBuoyancy > 0) {
        if (_head.y > localSurface + cfg.surfaceEyeClearance + 0.22) {
          this.swimming = false;
        }
      // If collision with real terrain has lifted the body clear of the water,
      // treat that as climbing onto shore instead of yanking the player back down.
      } else if (this.state.grounded && _head.y > localSurface + cfg.surfaceExitClearance) {
        this.swimming = false;
        if (this.velocity.y < 0) this.velocity.y = 0;
      } else {
        this.constrainToSurface(surfaceHeadCap);
      }
    }
  }

  private updateSwimmingVelocity(dt: number, intent: MoveIntent, surfaceHeadCap?: number): void {
    const cfg = this.config;

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

    // Ease ordinary upward swimming away as the player's eyes approach the wave.
    // Biological buoyancy is added later and intentionally bypasses this cap.
    if (surfaceHeadCap !== undefined && _target.y > 0) {
      this.rig.getHeadPosition(_head);
      const remaining = surfaceHeadCap - _head.y;
      const surfaceBand = 0.35;
      const factor = MathUtils.clamp(remaining / surfaceBand, 0, 1);
      _target.y *= factor;
    }

    // Diagonal stick/button input should not exceed the authored swimming speed.
    const targetSpeed = _target.length();
    const maxSpeed = Math.hypot(speed, cfg.verticalSpeed);
    if (targetSpeed > maxSpeed) _target.multiplyScalar(maxSpeed / targetSpeed);

    const rate = targetSpeed > 0.01 ? cfg.acceleration : cfg.deceleration;
    this.velocity.x = damp(this.velocity.x, _target.x, rate, dt);
    this.velocity.y = damp(this.velocity.y, _target.y, rate, dt);
    this.velocity.z = damp(this.velocity.z, _target.z, rate, dt);

    // Hand motors are true acceleration, applied after ordinary swim steering.
    // Pointing the two hands in different directions therefore produces the vector
    // sum you would expect instead of snapping the player onto a canned direction.
    if (this.propulsionInput.lengthSq() > 1e-7) {
      this.velocity.addScaledVector(this.propulsionInput, cfg.propulsionAcceleration * dt);
      const propelledSpeed = this.velocity.length();
      if (propelledSpeed > cfg.propulsionMaxSpeed) {
        this.velocity.multiplyScalar(cfg.propulsionMaxSpeed / propelledSpeed);
      }
    }

    this.velocity.multiplyScalar(Math.max(0, 1 - cfg.drag * dt));
    if (this.velocity.lengthSq() < 1e-6) this.velocity.set(0, 0, 0);
  }

  private updateAboveWaterVelocity(dt: number, intent: MoveIntent): void {
    const cfg = this.config;

    // Out of the water, stick movement is horizontal even if the player looks
    // upward. Vertical swim buttons intentionally do nothing in air. Hand motors
    // are also ignored here; they are underwater propulsion tools, not jetpacks.
    this.rig.getHeadForward(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
    _forward.normalize();
    this.rig.getHeadRight(_right);

    _target.set(0, 0, 0);
    _target.addScaledVector(_forward, intent.forward * cfg.walkSpeed);
    _target.addScaledVector(_right, intent.strafe * cfg.walkSpeed);

    const targetHorizontalSpeed = Math.hypot(_target.x, _target.z);
    if (targetHorizontalSpeed > cfg.walkSpeed) {
      const scale = cfg.walkSpeed / targetHorizontalSpeed;
      _target.x *= scale;
      _target.z *= scale;
    }

    const rate = targetHorizontalSpeed > 0.01 ? cfg.acceleration : cfg.deceleration;
    this.velocity.x = damp(this.velocity.x, _target.x, rate, dt);
    this.velocity.z = damp(this.velocity.z, _target.z, rate, dt);

    // A held lift bladder supports the player's weight. The biological pull is
    // applied immediately after this method, so gravity resumes on the very first
    // frame after the player lets go instead of turning the balloon into a jetpack.
    if (this.externalBuoyancy <= 0) {
      this.velocity.y = Math.max(
        this.velocity.y - cfg.gravity * dt,
        -cfg.terminalFallSpeed,
      );
    }
  }

  private applyExternalBuoyancy(dt: number): void {
    if (this.externalBuoyancy <= 0) return;

    // One bladder is intentionally enough to make the mechanic useful. A second
    // bladder is faster rather than merely redundant, which leaves room for later
    // cargo / giant-bladder variants without changing locomotion again.
    const targetAscentSpeed = 2.2 + (this.externalBuoyancy - 1) * 1.4;
    const pullRate = 5.2 + this.externalBuoyancy * 1.3;
    this.velocity.y = damp(this.velocity.y, targetAscentSpeed, pullRate, dt);
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

  /** Keeps a swimming player's eyes at/below the local animated surface. */
  private constrainToSurface(maxHeadY: number): void {
    this.rig.getHeadPosition(_head);
    if (_head.y <= maxHeadY) return;

    _step.set(0, maxHeadY - _head.y, 0);
    this.rig.translate(_step);
    this.capsule.translate(_step);
    if (this.velocity.y > 0) this.velocity.y = 0;
  }

  /**
   * Places the player at a world position, cancelling momentum. Used for spawn
   * and for the debug teleport.
   */
  teleport(position: Vector3): void {
    this.velocity.set(0, 0, 0);
    this.turnRate = 0;
    this.externalClimbActive = false;
    this.clearPropulsionInput();
    this.clearExternalBuoyancy();
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
