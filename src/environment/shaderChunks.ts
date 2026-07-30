/**
 * GLSL shared between the sky dome and the ocean surface.
 *
 * The water reflects (and, from below, refracts) the *same* function the dome
 * paints, which is what stops the horizon reading as a seam: at grazing angles
 * a Fresnel-correct surface converges on exactly the colour the sky is already
 * drawing behind it. Two shaders each inventing their own "sky colour" is how
 * the previous version ended up with a hard teal/grey join.
 *
 * Everything here is pure ALU - no textures, no render targets, no extra
 * passes - because the whole thing has to survive a standalone Quest 3.
 */

/** Analytic sky colour for a direction. Cheap enough to call per water pixel. */
export const SKY_RADIANCE_GLSL = /* glsl */ `
  vec3 skyRadiance(vec3 dir, vec3 zenith, vec3 horizon, vec3 sunColor, vec3 sunDir) {
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(horizon, zenith, pow(up, 0.45));

    // Haze packed hard against the skyline. Without it the gradient runs out of
    // range well before the horizon and the last few degrees go flat.
    col = mix(col, horizon, exp(-up * 10.0) * 0.62);

    float mu = dot(dir, sunDir);
    float s = max(mu, 0.0);
    float s2 = s * s;
    // Wide forward-scattering lobe, then a tighter glow hugging the disc.
    col += sunColor * (s2 * s2 * s2) * 0.13;
    col += sunColor * pow(s, 80.0) * 0.42;
    // The anti-solar half of the sky sits a little deeper. Reads as depth.
    col *= mix(0.88, 1.0, smoothstep(-0.55, 0.15, mu));

    return col;
  }
`;

/** Hash-based value noise + fbm, used for the cloud sheet and the star field. */
export const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  // Two octaves, not three. The third cost about as much as the first two put
  // together and, once the cloud threshold has been applied, changed almost
  // nothing - the shape of the sheet comes from where it crosses the coverage
  // level, and that is set by the low frequencies.
  float fbm2(vec2 p) {
    float v = valueNoise(p) * 0.62;
    p = p * 2.07 + 19.3;
    v += valueNoise(p) * 0.3;
    return v / 0.92;
  }
`;
