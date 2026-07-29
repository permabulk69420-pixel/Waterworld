import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Points,
  Scene,
  ShaderMaterial,
  Vector3,
} from 'three';

import type { Environment } from './Environment.ts';
import type { Locomotion } from '../player/Locomotion.ts';
import type { PlayerRig } from '../player/PlayerRig.ts';
import type { Handedness, VRHands } from '../player/VRHands.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';

const PARTICLE_COUNT = 2400;
const HORIZONTAL_RADIUS = 19;
const VERTICAL_RADIUS = 7;
const PLAYER_WAKE_RADIUS = 3.4;
const HAND_WAKE_RADIUS = 1.25;
const EXCITE_DECAY_PER_SECOND = 0.72;

const _head = new Vector3();
const _left = new Vector3();
const _right = new Vector3();
const _previousLeft = new Vector3();
const _previousRight = new Vector3();

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * One-draw-call cloud of tiny emissive plankton around the player.
 *
 * Particles fade in with the real world night cycle, drift slowly through the
 * water, and retain a short-lived blue flare after the player or either tracked
 * hand disturbs them. No point lights and no per-particle Object3Ds are used.
 */
export class BioluminescentPlankton {
  readonly points: Points<BufferGeometry, ShaderMaterial>;

  private readonly positions = new Float32Array(PARTICLE_COUNT * 3);
  private readonly phases = new Float32Array(PARTICLE_COUNT);
  private readonly sizes = new Float32Array(PARTICLE_COUNT);
  private readonly excite = new Float32Array(PARTICLE_COUNT);
  private readonly drift = new Float32Array(PARTICLE_COUNT * 3);
  private readonly positionAttribute: BufferAttribute;
  private readonly exciteAttribute: BufferAttribute;

  private haveLeft = false;
  private haveRight = false;

  constructor(
    private readonly scene: Scene,
    private readonly environment: Environment,
    private readonly rig: PlayerRig,
    private readonly hands: VRHands,
    private readonly locomotion: Locomotion,
  ) {
    this.rig.getHeadPosition(_head);
    const random = seededRandom(0x4b1f00d);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      const radius = HORIZONTAL_RADIUS * Math.sqrt(random());
      const angle = random() * Math.PI * 2;
      this.positions[i3] = _head.x + Math.cos(angle) * radius;
      // Bootstrap happens before the underwater spawn is applied, so seed the
      // first cloud directly below sea level instead of around the desktop camera.
      this.positions[i3 + 1] = this.environment.seaLevel - 0.1 - random() * VERTICAL_RADIUS * 2;
      this.positions[i3 + 2] = _head.z + Math.sin(angle) * radius;

      this.sizes[i] = 2.2 + random() * 5.4;
      this.phases[i] = random();
      this.drift[i3] = 0.018 + random() * 0.035;
      this.drift[i3 + 1] = (random() - 0.5) * 0.012;
      this.drift[i3 + 2] = -0.012 + random() * 0.026;
    }

    const geometry = new BufferGeometry();
    this.positionAttribute = new BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage(DynamicDrawUsage);
    this.exciteAttribute = new BufferAttribute(this.excite, 1);
    this.exciteAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('aSize', new BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aPhase', new BufferAttribute(this.phases, 1));
    geometry.setAttribute('aExcite', this.exciteAttribute);

    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uVisibility: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aPhase;
        attribute float aExcite;
        uniform float uTime;
        uniform float uVisibility;
        varying float vGlow;
        varying float vPhase;

        void main() {
          vec3 p = position;
          p.x += sin(uTime * 0.19 + aPhase * 11.0) * 0.055;
          p.y += sin(uTime * 0.27 + aPhase * 19.0) * 0.045;
          p.z += cos(uTime * 0.16 + aPhase * 13.0) * 0.05;

          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          float pulse = 0.68 + 0.32 * sin(uTime * (0.72 + aPhase * 0.38) + aPhase * 31.0);
          float distanceScale = clamp(9.0 / max(1.5, -mvPosition.z), 0.48, 2.15);
          gl_PointSize = aSize * distanceScale;
          vGlow = uVisibility * (0.42 + pulse * 0.58) + aExcite * 1.5 * uVisibility;
          vPhase = aPhase;
        }
      `,
      fragmentShader: `
        varying float vGlow;
        varying float vPhase;

        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float r = length(uv) * 2.0;
          if (r >= 1.0) discard;

          float soft = 1.0 - smoothstep(0.18, 1.0, r);
          float core = 1.0 - smoothstep(0.0, 0.34, r);
          vec3 deepBlue = vec3(0.03, 0.34, 1.0);
          vec3 cyanBlue = vec3(0.17, 0.86, 1.0);
          vec3 colour = mix(deepBlue, cyanBlue, 0.45 + 0.35 * vPhase + core * 0.2);
          float alpha = soft * clamp(vGlow, 0.0, 2.2) * 0.72;
          gl_FragColor = vec4(colour * (0.58 + core * 1.55) * vGlow, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, material);
    this.points.name = 'bioluminescent-plankton';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.scene.add(this.points);
  }

  private handPosition(handedness: Handedness, target: Vector3): boolean {
    const grip = this.hands.getControllerGrip(handedness);
    if (!grip) return false;
    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(target);
    return true;
  }

  update(dt: number, elapsed: number): void {
    this.rig.getHeadPosition(_head);

    const night = saturate((0.58 - this.environment.daylight) / 0.58);
    const submerged = smoothstep(0.18, 0.78, this.environment.submergence);
    const visibility = night * submerged;
    this.points.material.uniforms.uTime.value = elapsed;
    this.points.material.uniforms.uVisibility.value = visibility;
    this.points.visible = visibility > 0.008;

    const haveLeft = this.handPosition('left', _left);
    const haveRight = this.handPosition('right', _right);
    const leftSpeed = haveLeft && this.haveLeft && dt > 0 ? _left.distanceTo(_previousLeft) / dt : 0;
    const rightSpeed = haveRight && this.haveRight && dt > 0 ? _right.distanceTo(_previousRight) / dt : 0;
    if (haveLeft) _previousLeft.copy(_left);
    if (haveRight) _previousRight.copy(_right);
    this.haveLeft = haveLeft;
    this.haveRight = haveRight;

    const playerMotion = saturate((this.locomotion.state.speed - 0.22) / 3.5);
    const leftMotion = saturate((leftSpeed - 0.28) / 2.2);
    const rightMotion = saturate((rightSpeed - 0.28) / 2.2);

    const maxY = this.environment.seaLevel - 0.08;
    const minY = Math.min(maxY - 1, _head.y - VERTICAL_RADIUS);
    const desiredMaxY = Math.min(maxY, _head.y + VERTICAL_RADIUS);
    const playerWakeSq = PLAYER_WAKE_RADIUS * PLAYER_WAKE_RADIUS;
    const handWakeSq = HAND_WAKE_RADIUS * HAND_WAKE_RADIUS;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      let x = this.positions[i3] + this.drift[i3] * dt;
      let y = this.positions[i3 + 1] + this.drift[i3 + 1] * dt;
      let z = this.positions[i3 + 2] + this.drift[i3 + 2] * dt;

      let dx = x - _head.x;
      let dz = z - _head.z;
      if (dx > HORIZONTAL_RADIUS) x -= HORIZONTAL_RADIUS * 2;
      else if (dx < -HORIZONTAL_RADIUS) x += HORIZONTAL_RADIUS * 2;
      if (dz > HORIZONTAL_RADIUS) z -= HORIZONTAL_RADIUS * 2;
      else if (dz < -HORIZONTAL_RADIUS) z += HORIZONTAL_RADIUS * 2;

      if (y > desiredMaxY) y = minY;
      else if (y < minY) y = desiredMaxY;

      this.positions[i3] = x;
      this.positions[i3 + 1] = y;
      this.positions[i3 + 2] = z;

      let wake = 0;
      dx = x - _head.x;
      const dy = y - _head.y;
      dz = z - _head.z;
      const playerDistSq = dx * dx + dy * dy + dz * dz;
      if (playerMotion > 0 && playerDistSq < playerWakeSq) {
        wake = Math.max(wake, playerMotion * (1 - Math.sqrt(playerDistSq) / PLAYER_WAKE_RADIUS));
      }

      if (haveLeft && leftMotion > 0) {
        const hx = x - _left.x;
        const hy = y - _left.y;
        const hz = z - _left.z;
        const distSq = hx * hx + hy * hy + hz * hz;
        if (distSq < handWakeSq) wake = Math.max(wake, leftMotion * (1 - Math.sqrt(distSq) / HAND_WAKE_RADIUS));
      }
      if (haveRight && rightMotion > 0) {
        const hx = x - _right.x;
        const hy = y - _right.y;
        const hz = z - _right.z;
        const distSq = hx * hx + hy * hy + hz * hz;
        if (distSq < handWakeSq) wake = Math.max(wake, rightMotion * (1 - Math.sqrt(distSq) / HAND_WAKE_RADIUS));
      }

      this.excite[i] = Math.max(wake, this.excite[i] - EXCITE_DECAY_PER_SECOND * dt);
    }

    this.positionAttribute.needsUpdate = true;
    this.exciteAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
