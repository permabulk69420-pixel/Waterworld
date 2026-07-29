import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

/**
 * Neutral placeholder sky.
 *
 * Deliberately boring: a plain zenith-to-horizon gradient with a soft sun.
 * No alien art direction - that is a later pass. This exists so the world has
 * a believable "up" and a light source that matches the directional light.
 */
export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(radius = 4000) {
    this.material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uZenith: { value: new Color(0x5d86a4) },
        uHorizon: { value: new Color(0xb9c9cd) },
        uSunDirection: { value: new Vector3(0.4, 0.8, 0.25).normalize() },
        uSunColor: { value: new Color(0xfff4e2) },
        uExposure: { value: 1.0 },
        uFogColor: { value: new Color(0xb9c9cd) },
        uFogAmount: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDirection;
        void main() {
          vWorldDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_Position.z = gl_Position.w; // always at the far plane
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform float uExposure;
        uniform vec3 uFogColor;
        uniform float uFogAmount;
        varying vec3 vWorldDirection;

        void main() {
          vec3 dir = normalize(vWorldDirection);
          float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
          float t = pow(clamp(dir.y, 0.0, 1.0), 0.55);
          vec3 col = mix(uHorizon, uZenith, t);

          // Slightly darker below the horizon so the waterline reads clearly
          // from above the surface.
          col *= mix(0.72, 1.0, smoothstep(0.42, 0.55, h));

          float sun = max(dot(dir, normalize(uSunDirection)), 0.0);
          col += uSunColor * pow(sun, 900.0) * 12.0;      // disc
          col += uSunColor * pow(sun, 12.0) * 0.10;       // haze around it

          col *= uExposure;

          // The dome sits at infinity and carries no scene fog of its own, so
          // underwater it has to be blended out by hand - otherwise it shows
          // through wherever the ocean disc does not cover the horizon.
          col = mix(col, uFogColor, uFogAmount);

          gl_FragColor = vec4(col, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.mesh = new Mesh(new SphereGeometry(radius, 24, 16), this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.matrixAutoUpdate = false;
  }

  get horizonColor(): Color {
    return this.material.uniforms.uHorizon.value as Color;
  }

  setSunDirection(dir: Vector3): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(dir).normalize();
  }

  /** Dim the sky as the player descends so the surface stays a strong cue. */
  setExposure(value: number): void {
    this.material.uniforms.uExposure.value = value;
  }

  /** Blends the dome toward the scene fog colour (1 = fully replaced). */
  setFogBlend(color: Color, amount: number): void {
    (this.material.uniforms.uFogColor.value as Color).copy(color);
    this.material.uniforms.uFogAmount.value = amount;
  }

  /** Keeps the dome centred on the camera without any matrix maths per vertex. */
  followCamera(position: Vector3): void {
    this.mesh.position.copy(position);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld(true);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
