import {
  AdditiveBlending,
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

/** Additive optical detail layered over the base Ocean mesh. */
export class SurfaceOptics {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly seaLevel: number;

  constructor(seaLevel: number, radius = 300, rings = 36, segments = 72) {
    this.seaLevel = seaLevel;

    this.material = new ShaderMaterial({
      side: DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
      fog: true,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uCenter: { value: new Vector2() },
          uShallowColor: { value: new Color(0x3695a5) },
          uSkyColor: { value: new Color(0xc8d8d8) },
          uSunColor: { value: new Color(0xfff3d7) },
          uSunDirection: { value: new Vector3(0.4, 0.85, 0.28).normalize() },
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
        varying vec3 vWaveNormal;

        void waves(vec2 p, out float height, out vec2 slope) {
          vec2 d1 = normalize(vec2(0.86, 0.51));
          vec2 d2 = normalize(vec2(-0.42, 0.91));
          vec2 d3 = normalize(vec2(0.63, -0.78));
          float k1 = 0.115, k2 = 0.061, k3 = 0.245;
          float a1 = 1.0, a2 = 0.62, a3 = 0.28;
          float s1 = 1.05, s2 = 0.72, s3 = 1.6;
          float p1 = dot(p, d1) * k1 + uTime * s1;
          float p2 = dot(p, d2) * k2 + uTime * s2;
          float p3 = dot(p, d3) * k3 + uTime * s3;
          height = sin(p1) * a1 + sin(p2) * a2 + sin(p3) * a3;
          slope = cos(p1) * a1 * k1 * d1
                + cos(p2) * a2 * k2 * d2
                + cos(p3) * a3 * k3 * d3;
        }

        void main() {
          vec3 pos = position;
          vec2 world = pos.xz + uCenter;
          float dist = length(pos.xz);
          float detail = 1.0 - smoothstep(80.0, 300.0, dist);
          float h;
          vec2 slope;
          waves(world, h, slope);
          float amp = uWaveAmplitude * mix(0.3, 1.0, detail);
          pos.y += h * amp + 0.018;
          vWaveNormal = normalize(vec3(-slope.x * amp, 1.0, -slope.y * amp));
          vWorldPosition = vec3(world.x, pos.y, world.y);
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform vec3 uShallowColor;
        uniform vec3 uSkyColor;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        uniform float uUnderwater;
        varying vec3 vWorldPosition;
        varying vec3 vWaveNormal;

        vec2 microSlope(vec2 p, float t) {
          vec2 a = normalize(vec2(0.91, 0.41));
          vec2 b = normalize(vec2(-0.36, 0.93));
          vec2 c = normalize(vec2(0.67, -0.74));
          float p1 = dot(p, a) * 1.33 + t * 1.72;
          float p2 = dot(p, b) * 1.91 - t * 1.24;
          float p3 = dot(p, c) * 2.77 + t * 2.03;
          return cos(p1) * a * 0.075 + cos(p2) * b * 0.051 + cos(p3) * c * 0.027;
        }

        void main() {
          vec2 ms = microSlope(vWorldPosition.xz, uTime);
          vec3 N = normalize(vWaveNormal + vec3(-ms.x, 0.0, -ms.y));
          vec3 V = normalize(cameraPosition - vWorldPosition);
          vec3 L = normalize(uSunDirection);
          float c = clamp(abs(dot(V, N)), 0.0, 1.0);
          float ripple = sin(vWorldPosition.x * 0.18 + uTime * 0.72)
                       * sin(vWorldPosition.z * 0.16 - uTime * 0.59);
          float threshold = 0.64 + ripple * 0.035;
          vec3 col = vec3(0.0);
          float alpha = 0.0;

          if (gl_FrontFacing) {
            float fresnel = pow(1.0 - c, 4.2);
            vec3 H = normalize(L + V);
            float glitter = pow(max(dot(N, H), 0.0), 150.0);
            glitter += pow(max(dot(N, H), 0.0), 520.0) * 2.2;
            col = mix(uShallowColor, uSkyColor, 0.75) * fresnel * 0.2 + uSunColor * glitter;
            alpha = fresnel * 0.08 + glitter * 0.18;
          } else {
            float window = smoothstep(threshold - 0.08, threshold + 0.13, c);
            float rim = exp(-pow((c - threshold) / 0.065, 2.0));
            float zenith = smoothstep(0.58, 0.96, c);
            vec3 reflected = uShallowColor * 0.18;
            vec3 refracted = mix(uShallowColor, uSkyColor, 0.76) * (0.72 + zenith * 0.48);
            col = mix(reflected, refracted, window);
            col += uSkyColor * rim * 0.32;
            float sun = max(dot(reflect(-V, -N), L), 0.0);
            float sparkle = pow(sun, 48.0) + pow(sun, 190.0) * 2.0;
            col += uSunColor * sparkle * window * 0.72;
            alpha = (0.055 + window * 0.12 + rim * 0.095 + sparkle * 0.08) * uUnderwater;
          }

          if (alpha < 0.001) discard;
          gl_FragColor = vec4(col * alpha, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    });

    this.mesh = new Mesh(createRadialDisc(radius, rings, segments), this.material);
    this.mesh.name = 'surface-optics';
    this.mesh.position.y = seaLevel;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  update(elapsed: number, cameraPosition: Vector3, underwater: boolean): void {
    this.material.uniforms.uTime.value = elapsed;
    (this.material.uniforms.uCenter.value as Vector2).set(cameraPosition.x, cameraPosition.z);
    this.material.uniforms.uUnderwater.value = underwater ? 1 : 0;
    this.mesh.position.set(cameraPosition.x, this.seaLevel, cameraPosition.z);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  setColors(shallow: Color, sky: Color): void {
    (this.material.uniforms.uShallowColor.value as Color).copy(shallow);
    (this.material.uniforms.uSkyColor.value as Color).copy(sky);
  }

  setSunDirection(dir: Vector3): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(dir).normalize();
  }

  setSunColor(color: Color): void {
    (this.material.uniforms.uSunColor.value as Color).copy(color);
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
  const k = 5.0;
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
