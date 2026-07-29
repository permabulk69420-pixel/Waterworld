/** Small shared scalar helpers (no three.js dependency - worker safe). */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function saturate(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite interpolation, matching GLSL smoothstep. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Framerate-independent exponential approach. `rate` is per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Applies a radial deadzone to a 2D stick input and rescales the remainder. */
export function applyDeadzone(x: number, y: number, deadzone: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag <= deadzone) return [0, 0];
  const scaled = (mag - deadzone) / (1 - deadzone) / mag;
  return [x * scaled, y * scaled];
}

/** Applies a deadzone to a single axis and rescales the remainder. */
export function deadzone1(v: number, deadzone: number): number {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  return Math.sign(v) * ((a - deadzone) / (1 - deadzone));
}

/** Smooth minimum - blends two distance/density fields without a hard crease. */
export function smoothMin(a: number, b: number, k: number): number {
  const h = saturate(0.5 + (0.5 * (b - a)) / k);
  return lerp(b, a, h) - k * h * (1 - h);
}

/** Smooth maximum, counterpart to {@link smoothMin}. */
export function smoothMax(a: number, b: number, k: number): number {
  return -smoothMin(-a, -b, k);
}
