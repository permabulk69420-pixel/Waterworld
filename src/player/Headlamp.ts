import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Scene,
  SpotLight,
  Vector3,
  type WebGLRenderer,
} from 'three';

import type { PlayerRig } from './PlayerRig.ts';
import type { Handedness, VRHands } from './VRHands.ts';

const LAMP_LOCAL_OFFSET = new Vector3(-0.13, -0.025, -0.015);
const LEFT_TEMPLE_LOCAL = new Vector3(-0.16, -0.015, 0);
const RIGHT_TEMPLE_LOCAL = new Vector3(0.16, -0.015, 0);
const TAP_RADIUS = 0.15;
const TAP_MIN_SPEED = 0.32;
const TAP_COOLDOWN = 0.38;

const _head = new Vector3();
const _headQuat = new Quaternion();
const _forward = new Vector3();
const _lampWorld = new Vector3();
const _leftTemple = new Vector3();
const _rightTemple = new Vector3();
const _hand = new Vector3();

interface BatteryState {
  capacity: number;
  charge: number;
}

interface HandTapState {
  previousPosition: Vector3;
  havePrevious: boolean;
  wasInside: boolean;
}

/**
 * Lightweight first-person headlamp.
 *
 * The beam origin sits at the left temple rather than between the player's eyes.
 * Either tracked hand can toggle it by making a quick tap into either temple zone.
 * Battery state is deliberately separate from the lamp so a later inventory/crafting
 * pass can install, remove and drain physical battery items without rewriting this.
 */
export class Headlamp {
  readonly light: SpotLight;
  readonly housing = new Group();

  private readonly target = new Group();
  private readonly lensMaterial: MeshStandardMaterial;
  private readonly tapState: Record<Handedness, HandTapState> = {
    left: { previousPosition: new Vector3(), havePrevious: false, wasInside: false },
    right: { previousPosition: new Vector3(), havePrevious: false, wasInside: false },
  };

  private battery: BatteryState | null = { capacity: 1, charge: 1 };
  private drainPerSecond = 0;
  private cooldown = 0;
  private enabled = false;

  constructor(
    private readonly scene: Scene,
    private readonly renderer: WebGLRenderer,
    private readonly rig: PlayerRig,
    private readonly hands: VRHands,
  ) {
    this.housing.name = 'player-headlamp-housing';

    const bodyMaterial = new MeshStandardMaterial({
      color: 0x20272b,
      roughness: 0.5,
      metalness: 0.35,
    });
    this.lensMaterial = new MeshStandardMaterial({
      color: 0xcfefff,
      emissive: 0xcfefff,
      emissiveIntensity: 0.08,
      roughness: 0.25,
      metalness: 0.05,
    });

    const body = new Mesh(new CylinderGeometry(0.024, 0.027, 0.082, 12), bodyMaterial);
    body.name = 'headlamp-body';
    body.rotation.x = Math.PI / 2;

    const lens = new Mesh(new CylinderGeometry(0.019, 0.019, 0.008, 12), this.lensMaterial);
    lens.name = 'headlamp-lens';
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.044;

    this.housing.add(body, lens);
    this.scene.add(this.housing);

    this.target.name = 'player-headlamp-target';
    this.scene.add(this.target);

    // A fairly soft falloff keeps the near-field brightness useful without making
    // the beam collapse after ~10 m. The finite 60 m range still gives us a hard
    // performance/visual bound while preserving an obvious underwater torch cone.
    this.light = new SpotLight(0xdaf4ff, 64, 60, 0.42, 0.62, 0.65);
    this.light.name = 'player-headlamp-light';
    this.light.castShadow = false;
    this.light.visible = false;
    this.light.target = this.target;
    this.scene.add(this.light);

    this.syncToHead();
  }

  /** Install a later inventory battery without coupling the lamp to inventory code. */
  installBattery(capacity: number, charge = capacity): void {
    const safeCapacity = Math.max(0, capacity);
    this.battery = {
      capacity: safeCapacity,
      charge: Math.min(Math.max(0, charge), safeCapacity),
    };
    if (this.battery.charge <= 0) this.setEnabled(false);
  }

  removeBattery(): BatteryState | null {
    const removed = this.battery ? { ...this.battery } : null;
    this.battery = null;
    this.setEnabled(false);
    return removed;
  }

  /** Keep at zero until the real battery item/crafting pass chooses its balance. */
  setDrainPerSecond(value: number): void {
    this.drainPerSecond = Math.max(0, value);
  }

  get batteryFraction(): number {
    if (!this.battery || this.battery.capacity <= 0) return 0;
    return this.battery.charge / this.battery.capacity;
  }

  isOn(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.setEnabled(!this.enabled);
  }

  private setEnabled(value: boolean): void {
    const canLight = !!this.battery && this.battery.charge > 0;
    this.enabled = value && canLight;
    this.light.visible = this.enabled;
    this.lensMaterial.emissiveIntensity = this.enabled ? 2.2 : 0.08;
  }

  private syncToHead(): void {
    this.rig.getHeadPosition(_head);
    this.rig.getHeadQuaternion(_headQuat);

    _lampWorld.copy(LAMP_LOCAL_OFFSET).applyQuaternion(_headQuat).add(_head);
    this.housing.position.copy(_lampWorld);
    this.housing.quaternion.copy(_headQuat);
    this.light.position.copy(_lampWorld);

    _forward.set(0, 0, -1).applyQuaternion(_headQuat).normalize();
    this.target.position.copy(_lampWorld).addScaledVector(_forward, 10);

    _leftTemple.copy(LEFT_TEMPLE_LOCAL).applyQuaternion(_headQuat).add(_head);
    _rightTemple.copy(RIGHT_TEMPLE_LOCAL).applyQuaternion(_headQuat).add(_head);
  }

  private handInsideTemple(handedness: Handedness, dt: number): { inside: boolean; speed: number } | null {
    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return null;

    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(_hand);

    const state = this.tapState[handedness];
    let speed = 0;
    if (state.havePrevious && dt > 0) speed = state.previousPosition.distanceTo(_hand) / dt;
    state.previousPosition.copy(_hand);
    state.havePrevious = true;

    const inside =
      _hand.distanceToSquared(_leftTemple) <= TAP_RADIUS * TAP_RADIUS ||
      _hand.distanceToSquared(_rightTemple) <= TAP_RADIUS * TAP_RADIUS;

    return { inside, speed };
  }

  private pulseHaptic(handedness: Handedness): void {
    const session = this.renderer.xr.getSession();
    if (!session) return;

    for (const source of session.inputSources) {
      if (source.handedness !== handedness) continue;
      const actuator = (source.gamepad as (Gamepad & {
        vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> };
      }) | null)?.vibrationActuator;
      void actuator?.playEffect?.('dual-rumble', {
        duration: 45,
        strongMagnitude: 0.22,
        weakMagnitude: 0.32,
        startDelay: 0,
      });
      return;
    }
  }

  update(dt: number): void {
    this.syncToHead();
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.enabled && this.battery && this.drainPerSecond > 0) {
      this.battery.charge = Math.max(0, this.battery.charge - this.drainPerSecond * dt);
      if (this.battery.charge <= 0) this.setEnabled(false);
    }

    if (!this.renderer.xr.isPresenting) {
      for (const state of Object.values(this.tapState)) {
        state.havePrevious = false;
        state.wasInside = false;
      }
      return;
    }

    for (const handedness of ['left', 'right'] as const) {
      const state = this.tapState[handedness];
      const sample = this.handInsideTemple(handedness, dt);
      if (!sample) {
        state.havePrevious = false;
        state.wasInside = false;
        continue;
      }

      if (sample.inside && !state.wasInside && sample.speed >= TAP_MIN_SPEED && this.cooldown <= 0) {
        this.toggle();
        this.cooldown = TAP_COOLDOWN;
        this.pulseHaptic(handedness);
      }
      state.wasInside = sample.inside;
    }
  }

  dispose(): void {
    this.light.removeFromParent();
    this.target.removeFromParent();
    this.housing.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    });
    this.housing.removeFromParent();
  }
}