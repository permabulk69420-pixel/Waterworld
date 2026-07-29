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

export interface OceanOptions {
  seaLevel: number;
  /** How far the surface extends from the player, in metres. */
  radius: number;
  /** Radial rings. Spacing grows toward the edge, so detail stays near you. */
  rings: number;
  /** Segments around the disc. */
  segments: number;
}

/**
 * The ocean surface.
 *
 * A camera-following radial disc, dense near the player and coarse toward the
 * horizon, so a single draw call covers the whole visible sea at any distance.
 * Waves are three cheap sine waves evaluated in *world* space, so the surface
 * does not slide when the disc follows the player.
 *
 * The shader shades both faces:
 *  - from above: sky-tinted fresnel over deep water, plus a sun highlight
 *  - from below: Snell's window - you see the sky in a cone overhead and a
 *    mirror-like murk beyond the critical angle
 *
 * Nothing here is the final water shader; it is the cheapest thing that still
 * makes crossing the surface unmistakable.
 */
export class Ocean {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  readonly seaLevel: number;

  constructor(options: OceanOptions) {
    this.seaLevel = options.seaLevel;

    this.material = new ShaderMaterial({
      side: DoubleSide,
      fog: true,
      transparent: false,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCenter: { value: new Vector2() },
          uSurfaceColor: { value: new Color(0x2c6b80) },
          uDeepColor: { value: new Color(0x0b2a3a) },
          uSkyColor: { value: new Color(0xb9c9cd) },
          uSunColor: { value: new Color(0xfff4e2) },
          uSunDirection: { value: new Vector3(0.4, 0.8, 0.25).normalize() },
          uWaveAmplitude: { value: 0.24 },
          uUnderwater: { value: 0 },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>

        uniform float uTime;
        uniform vec2 uCenter;
        uniform float uWaveAmplitude;

        varying vec3 vWorldPosition;
        varying vec3 vNormal;

        // Three cheap trochoid-ish waves. Amplitude falls off with distance so
        // the coarse outer rings never alias.
        void waves(vec2 p, out float height, out vec2 slope) {
          height = 0.0;
          slope = vec2(0.0);

          vec2 d1 = normalize(vec2(0.86, 0.51));
          vec2 d2 = normalize(vec2(-0.42, 0.91));
          vec2 d3 = normalize(vec2(0.63, -0.78));

          float k1 = 0.115, k2 = 0.061, k3 = 0.245;
          float a1 = 1.0,   a2 = 0.62,  a3 = 0.28;
          float s1 = 1.05,  s2 = 0.72,  s3 = 1.6;

          float p1 = dot(p, d1) * k1 + uTime * s1;
          float p2 = dot(p, d2) * k2 + uTime * s2;
          float p3 = dot(p, d3) * k3 + uTime * s3;

          height = sin(p1) * a1 + sin(p2) * a2 + sin(p3) * a3;
          slope  = cos(p1) * a1 * k1 * d1
                 + cos(p2) * a2 * k2 * d2
                 + cos(p3) * a3 * k3 * d3;
        }

        void main() {
          vec3 pos = position;
          vec2 world = pos.xz + uCenter;

          float dist = length(pos.xz);
          float detail = 1.0 - smoothstep(60.0, 420.0, dist);

          float h;
          vec2 slope;
          waves(world, h, slope);

          float amp = uWaveAmplitude * mix(0.25, 1.0, detail);
          pos.y += h * amp;

          vNormal = normalize(vec3(-slope.x * amp, 1.0, -slope.y * amp));
          vWorldPosition = vec3(world.x, pos.y, world.y);

          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;

          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>

        uniform vec3 uSurfaceColor;
        uniform vec3 uDeepColor;
        uniform vec3 uSkyColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uUnderwater;

        varying vec3 vWorldPosition;
        varying vec3 vNormal;

        void main() {
          vec3 N = normalize(vNormal);
          vec3 V = normalize(cameraPosition - vWorldPosition);
          vec3 L = normalize(uSunDirection);
          float facing = dot(V, N);

          vec3 col;

          if (gl_FrontFacing) {
            // --- seen from above ---
            float fresnel = pow(1.0 - clamp(abs(facing), 0.0, 1.0), 4.0);
            col = mix(uDeepColor, uSurfaceColor, 0.55);
            col = mix(col, uSkyColor, 0.25 + 0.7 * fresnel);

            vec3 H = normalize(L + V);
            col += uSunColor * pow(max(dot(N, H), 0.0), 220.0) * 1.6;
          } else {
            // --- seen from below: Snell's window ---
            // Total internal reflection past ~48.6 degrees from vertical.
            float c = clamp(abs(facing), 0.0, 1.0);
            float window = smoothstep(0.58, 0.78, c);
            vec3 mirror = mix(uDeepColor, uSurfaceColor, 0.35);
            col = mix(mirror, uSkyColor * 1.15, window);

            // Sun seen through the window.
            float sun = max(dot(reflect(-V, -N), L), 0.0);
            col += uSunColor * pow(sun, 60.0) * window * 1.2;
          }

          gl_FragColor = vec4(col, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
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

  /** Keeps the disc centred under the player and advances the waves. */
  update(elapsed: number, cameraPosition: Vector3, underwater: boolean): void {
    this.material.uniforms.uTime.value = elapsed;
    (this.material.uniforms.uCenter.value as Vector2).set(cameraPosition.x, cameraPosition.z);
    this.material.uniforms.uUnderwater.value = underwater ? 1 : 0;
    this.mesh.position.set(cameraPosition.x, this.seaLevel, cameraPosition.z);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  setColors(surface: Color, deep: Color, sky: Color): void {
    (this.material.uniforms.uSurfaceColor.value as Color).copy(surface);
    (this.material.uniforms.uDeepColor.value as Color).copy(deep);
    (this.material.uniforms.uSkyColor.value as Color).copy(sky);
  }

  setSunDirection(dir: Vector3): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(dir).normalize();
  }

  /** Surface height at a world position, matching the vertex shader waves. */
  heightAt(x: number, z: number, elapsed: number): number {
    const amp = this.material.uniforms.uWaveAmplitude.value as number;
    const d1x = 0.86 / Math.hypot(0.86, 0.51);
    const d1z = 0.51 / Math.hypot(0.86, 0.51);
    const d2x = -0.42 / Math.hypot(0.42, 0.91);
    const d2z = 0.91 / Math.hypot(0.42, 0.91);
    const d3x = 0.63 / Math.hypot(0.63, 0.78);
    const d3z = -0.78 / Math.hypot(0.63, 0.78);

    const h =
      Math.sin((x * d1x + z * d1z) * 0.115 + elapsed * 1.05) * 1.0 +
      Math.sin((x * d2x + z * d2z) * 0.061 + elapsed * 0.72) * 0.62 +
      Math.sin((x * d3x + z * d3z) * 0.245 + elapsed * 1.6) * 0.28;

    return this.seaLevel + h * amp;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Disc with exponentially growing ring spacing: dense where the player is,
 * coarse at the horizon. ~10k vertices covers several kilometres.
 */
function createRadialDisc(radius: number, rings: number, segments: number): BufferGeometry {
  const vertexCount = 1 + rings * segments;
  const positions = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  // Centre vertex.
  positions[0] = 0;
  positions[1] = 0;
  positions[2] = 0;

  // Exponential ring spacing: ~0.5 m near the player, kilometres at the edge.
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

  // Wound so front faces point +Y (up). The shader branches on
  // gl_FrontFacing to tell "looking down at the sea" from "looking up at the
  // underside", so getting this backwards silently swaps the two looks.
  for (let s = 0; s < segments; s++) {
    indices.push(0, 1 + ((s + 1) % segments), 1 + s);
  }
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
