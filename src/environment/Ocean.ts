import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
} from 'three';
import { SKY_RADIANCE_GLSL } from './shaderChunks.ts';

export interface OceanOptions {
  seaLevel: number;
  radius: number;
  rings: number;
  segments: number;
}

interface Wave {
  /** Unit direction of travel in world XZ. */
  dx: number;
  dz: number;
  /** Angular wavenumber, rad/m. Wavelength = 2*PI/k. */
  k: number;
  /** Relative amplitude, scaled by uWaveAmplitude. */
  a: number;
  /** Phase speed. Deep-water gravity waves: sqrt(g*k). */
  s: number;
  /** True for waves short enough that the disc can only carry them nearby. */
  near?: boolean;
}

const GRAVITY = 9.81;

function wave(dx: number, dz: number, k: number, a: number, near = false): Wave {
  const len = Math.hypot(dx, dz);
  return { dx: dx / len, dz: dz / len, k, a, s: Math.sqrt(GRAVITY * k), near };
}

/**
 * The long swell. These are the only waves that exist as geometry, and they are
 * the only ones `heightAt` knows about - so locomotion, buoyancy and the shader
 * can never disagree about where the surface is.
 *
 * Everything shorter lives in the fragment shader as normal detail only, which
 * means arbitrarily fine surface structure costs the physics nothing.
 */
const SWELL: Wave[] = [
  wave(0.86, 0.51, 0.115, 1.0),
  wave(-0.42, 0.91, 0.061, 0.62),
  wave(0.63, -0.78, 0.245, 0.28),
  wave(0.94, 0.34, 0.52, 0.15, true),
];

/**
 * Per-pixel ripple spectrum. Slope amplitude (a*k) stays near constant across
 * octaves, which is what a wind-driven surface actually does and what makes the
 * sun glitter break up into individual points instead of a smear.
 *
 * Directions fan out much further than a real wind sea would justify, and each
 * octave warps the domain for the ones after it (see `rippleGlsl`). Plain summed
 * sines pointing the same way produce dead-straight parallel crests - the water
 * ends up looking like corduroy, which is worse than looking flat.
 */
const RIPPLES: Wave[] = [
  wave(0.98, 0.2, 0.7, 0.1),
  wave(0.55, -0.84, 1.21, 0.055),
  wave(0.86, 0.51, 2.03, 0.03),
  wave(-0.31, -0.95, 3.7, 0.015),
  wave(0.68, -0.73, 6.98, 0.0075),
  wave(-0.75, 0.66, 13.96, 0.0038),
];

/** GLSL float literal - `String(0.1)` is fine but integers need the decimal. */
function f(n: number): string {
  const s = n.toPrecision(8);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

function swellGlsl(waves: Wave[]): string {
  return waves
    .map((w) => {
      const weight = w.near ? 'nearFade' : '1.0';
      return `
        {
          vec2 d = vec2(${f(w.dx)}, ${f(w.dz)});
          float ph = dot(p, d) * ${f(w.k)} + t * ${f(w.s)};
          float w = ${weight};
          h += sin(ph) * (${f(w.a)} * w);
          slope += cos(ph) * d * (${f(w.k * w.a)} * w);
        }`;
    })
    .join('');
}

/**
 * Each octave shifts the sample point for every octave after it, by its own
 * value, perpendicular to its own travel direction and scaled to its own
 * wavelength. That one line is what bends the crests: without it six summed
 * sines give perfectly straight, perfectly parallel ridges.
 *
 * The displacement reuses the cosine the slope already needed, so the whole
 * effect costs two multiply-adds per octave and no extra transcendentals.
 */
function rippleGlsl(waves: Wave[]): string {
  return waves
    .map(
      (w) => `
        {
          vec2 d = vec2(${f(w.dx)}, ${f(w.dz)});
          float fade = 1.0 / (1.0 + footprint * ${f(w.k)});
          float c = cos(dot(q, d) * ${f(w.k)} + t * ${f(w.s)});
          slope += c * d * (${f(w.k * w.a)} * fade);
          lost += ${f(w.k * w.a)} * (1.0 - fade);
          q += vec2(-d.y, d.x) * (c * ${f(0.5 / w.k)});
        }`,
    )
    .join('');
}

/** Sum of swell amplitudes, used to normalise the crest term to roughly -1..1. */
const SWELL_SUM = SWELL.reduce((total, w) => total + w.a, 0);

/**
 * Swell evaluation, compiled into *both* stages.
 *
 * The vertex stage needs the height to displace by; the fragment stage needs
 * the slope, and has to derive it itself rather than interpolating a varying.
 * The disc's outer rings are hundreds of metres across, so an interpolated
 * normal is piecewise-linear over those spans - which is invisible in diffuse
 * shading but turns every sharp threshold (Snell's window, the specular lobe)
 * into a staircase along the triangle edges.
 *
 * Both stages derive the distance weights from the same radial distance, so the
 * per-pixel normal always describes the geometry that was actually displaced.
 */
const SWELL_GLSL = /* glsl */ `
  void swellWeights(float discDist, out float nearFade, out float amp) {
    // The shortest swell is dropped once the ring spacing can no longer carry
    // it, and the whole swell flattens towards the disc edge so the horizon
    // line stays clean.
    nearFade = 1.0 - smoothstep(20.0, 80.0, discDist);
    amp = uWaveAmplitude * mix(0.3, 1.0, 1.0 - smoothstep(120.0, 620.0, discDist));
  }

  void swell(vec2 p, float t, float nearFade, out float h, out vec2 slope) {
    h = 0.0;
    slope = vec2(0.0);
    ${swellGlsl(SWELL)}
  }
`;

export class Ocean {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  readonly seaLevel: number;

  constructor(options: OceanOptions) {
    this.seaLevel = options.seaLevel;

    this.material = new ShaderMaterial({
      side: DoubleSide,
      fog: true,
      dithering: true,
      transparent: false,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCenter: { value: new Vector2() },
          uSurfaceColor: { value: new Color(0x2c6b80) },
          uDeepColor: { value: new Color(0x0b2a3a) },
          uScatterColor: { value: new Color(0x72b5ae) },
          uZenith: { value: new Color(0x3f7ba8) },
          uHorizon: { value: new Color(0xb9c9cd) },
          uSunColor: { value: new Color(0xfff4e2) },
          uSunDirection: { value: new Vector3(0.4, 0.8, 0.25).normalize() },
          uWaveAmplitude: { value: 0.3 },
          uDaylight: { value: 1 },
          // Strength of the fragment-shader ripple slopes.
          uDetailStrength: { value: 0.85 },
          // Approximate angular pixel size. Drives how early each ripple octave
          // is faded out; raise it if the surface ever shimmers on device.
          uDetailFalloff: { value: 0.0018 },
          uBaseRoughness: { value: 0.055 },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        uniform float uTime;
        uniform vec2 uCenter;
        uniform float uWaveAmplitude;
        varying vec3 vWorldPosition;

        ${SWELL_GLSL}

        void main() {
          vec3 pos = position;
          vec2 world = pos.xz + uCenter;

          float nearFade;
          float amp;
          swellWeights(length(pos.xz), nearFade, amp);

          float h;
          vec2 slope;
          swell(world, uTime, nearFade, h, slope);

          pos.y += h * amp;
          vWorldPosition = vec3(world.x, pos.y, world.y);

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        #include <dithering_pars_fragment>
        uniform float uTime;
        uniform vec2 uCenter;
        uniform float uWaveAmplitude;
        uniform vec3 uSurfaceColor;
        uniform vec3 uDeepColor;
        uniform vec3 uScatterColor;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uDaylight;
        uniform float uDetailStrength;
        uniform float uDetailFalloff;
        uniform float uBaseRoughness;
        varying vec3 vWorldPosition;

        ${SKY_RADIANCE_GLSL}
        ${SWELL_GLSL}

        /**
         * Ripple slopes, with each octave faded out once its wavelength drops
         * below what this pixel can resolve. \`lost\` collects the slope energy
         * that was removed so the specular lobe can widen by exactly as much as
         * the normal flattened - detail leaves the geometry and reappears as
         * roughness instead of turning into aliasing.
         */
        void ripples(vec2 p, float t, float footprint, out vec2 slope, out float lost) {
          slope = vec2(0.0);
          lost = 0.0;
          vec2 q = p;
          ${rippleGlsl(RIPPLES)}
        }

        void main() {
          vec3 toEye = cameraPosition - vWorldPosition;
          float dist = max(length(toEye), 0.001);
          vec3 V = toEye / dist;
          vec3 L = normalize(uSunDirection);

          // A pixel's footprint on a near-horizontal plane stretches as
          // 1 / sin(view angle), so grazing water needs far more filtering than
          // water underfoot even at the same distance.
          float grazing = max(abs(V.y), 0.015);
          float footprint = dist * uDetailFalloff / grazing;

          // Swell slope, re-derived here rather than interpolated - see SWELL_GLSL.
          float nearFade;
          float amp;
          swellWeights(length(vWorldPosition.xz - uCenter), nearFade, amp);
          float crestHeight;
          vec2 swellSlope;
          swell(vWorldPosition.xz, uTime, nearFade, crestHeight, swellSlope);

          vec2 dslope;
          float lost;
          ripples(vWorldPosition.xz, uTime, footprint, dslope, lost);

          vec3 N = normalize(vec3(
            -swellSlope.x * amp - dslope.x * uDetailStrength,
            1.0,
            -swellSlope.y * amp - dslope.y * uDetailStrength
          ));

          float rough = clamp(uBaseRoughness + lost * uDetailStrength * 0.9, 0.02, 0.8);
          float expo = clamp(2.0 / (rough * rough) - 2.0, 6.0, 4000.0);
          vec3 H = normalize(L + V);
          float glint = pow(max(dot(N, H), 0.0), expo) * (0.35 + min(expo * 0.006, 3.2));

          vec3 col;

          if (gl_FrontFacing) {
            // --- seen from the air -------------------------------------------
            float ndotv = clamp(dot(N, V), 0.0, 1.0);
            // Schlick, reaching 1 at grazing incidence. This is the whole reason
            // the horizon dissolves into the sky instead of ending in a seam.
            float m = 1.0 - ndotv;
            float m2 = m * m;
            float fresnel = 0.02 + 0.98 * (m2 * m2 * m);

            vec3 R = reflect(-V, N);
            vec3 reflected = skyRadiance(R, uZenith, uHorizon, uSunColor, L);

            // What comes back out of the water. There is no scene refraction to
            // sample, so this is a fixed extinction mix, lifted on wave crests
            // where sunlight is coming through the back of the wave.
            vec3 body = mix(uDeepColor, uSurfaceColor, 0.55);
            float crest = smoothstep(-0.1, 0.9, crestHeight / ${f(SWELL_SUM)});
            float through = pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 2.5);
            body += uScatterColor * crest * through * 0.4 * uDaylight;

            col = mix(body, reflected, fresnel);
            col += uSunColor * glint * (0.08 + 0.92 * fresnel) * uDaylight;
          } else {
            // --- seen from below ---------------------------------------------
            vec3 Nd = -N;
            float c = clamp(dot(V, Nd), 0.0, 1.0);

            // Snell's window. Past the critical angle (~48.6 deg) the surface
            // turns into a mirror of the water below it.
            vec3 refr = refract(-V, Nd, 1.333);
            vec3 rd = normalize(refr + vec3(0.0, 0.0001, 0.0));
            vec3 windowCol = skyRadiance(rd, uZenith, uHorizon, uSunColor, L);
            windowCol += uSunColor * smoothstep(0.99930, 0.99975, dot(rd, L)) * 7.0;

            // The physical transition is instant, but a razor edge here lands on
            // the disc's own triangle facets and staircases along them. Real
            // water is smeared by capillary ripple anyway, so soften it.
            float open = smoothstep(0.60, 0.72, c);
            float edge = (c - 0.661) / 0.055;
            float rim = exp(-edge * edge);
            vec3 mirrored = mix(uDeepColor, uSurfaceColor, 0.3) * (0.35 + 0.65 * c);

            col = mix(mirrored, windowCol, open);
            col += uSunColor * rim * 0.22 * uDaylight;
            col += uSunColor * glint * open * 0.45 * uDaylight;
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
          #include <dithering_fragment>
        }
      `,
    });

    this.mesh = new Mesh(createRadialDisc(options.radius, options.rings, options.segments), this.material);
    this.mesh.name = 'ocean';
    this.mesh.position.y = options.seaLevel;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 1;
    this.mesh.updateMatrix();
  }

  update(elapsed: number, cameraPosition: Vector3): void {
    this.material.uniforms.uTime.value = elapsed;
    (this.material.uniforms.uCenter.value as Vector2).set(cameraPosition.x, cameraPosition.z);
    this.mesh.position.set(cameraPosition.x, this.seaLevel, cameraPosition.z);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  /**
   * @param scatter colour of sunlight scattering through a wave crest
   */
  setColors(surface: Color, deep: Color, zenith: Color, horizon: Color, scatter: Color): void {
    (this.material.uniforms.uSurfaceColor.value as Color).copy(surface);
    (this.material.uniforms.uDeepColor.value as Color).copy(deep);
    (this.material.uniforms.uZenith.value as Color).copy(zenith);
    (this.material.uniforms.uHorizon.value as Color).copy(horizon);
    (this.material.uniforms.uScatterColor.value as Color).copy(scatter);
  }

  setSunDirection(dir: Vector3): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(dir).normalize();
  }

  setSunColor(color: Color): void {
    (this.material.uniforms.uSunColor.value as Color).copy(color);
  }

  setDaylight(value: number): void {
    this.material.uniforms.uDaylight.value = value;
  }

  /**
   * Surface height used by locomotion and buoyancy.
   *
   * Only ever evaluated at the player's own XZ, which is the centre of the disc
   * and therefore the one place every swell term is at full strength - so this
   * matches the rendered surface exactly.
   */
  heightAt(x: number, z: number, elapsed: number): number {
    const amp = this.material.uniforms.uWaveAmplitude.value as number;
    let h = 0;
    for (const w of SWELL) {
      h += Math.sin((x * w.dx + z * w.dz) * w.k + elapsed * w.s) * w.a;
    }
    return this.seaLevel + h * amp;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

function createRadialDisc(radius: number, rings: number, segments: number): BufferGeometry {
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;
  const k = 5.5;
  const denom = Math.exp(k) - 1;
  for (let r = 0; r < rings; r++) {
    const t = (r + 1) / rings;
    const dist = (radius * (Math.exp(k * t) - 1)) / denom;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const i = (1 + r * segments + s) * 3;
      positions[i] = Math.cos(a) * dist;
      positions[i + 1] = 0;
      positions[i + 2] = Math.sin(a) * dist;
    }
  }
  for (let s = 0; s < segments; s++) indices.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 0; r < rings - 1; r++) {
    const a0 = 1 + r * segments;
    const b0 = 1 + (r + 1) * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      indices.push(a0 + s, b0 + s1, b0 + s);
      indices.push(a0 + s, a0 + s1, b0 + s1);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}
