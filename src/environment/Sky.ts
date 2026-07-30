import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { NOISE_GLSL, SKY_RADIANCE_GLSL } from './shaderChunks.ts';

/**
 * Procedural sky dome.
 *
 * Environment owns the time-of-day state and feeds this dome a moving sun plus
 * a continuously blended zenith/horizon palette. Keeping it shader-only is
 * cheap on Quest while still giving sunrise, daylight, dusk and a properly dark
 * night.
 *
 * Three things earn their keep on top of the base gradient:
 *
 *  - a thin drifting cirrus sheet, because an unbroken gradient is what makes a
 *    sky read as "flat" no matter how well the colours are chosen;
 *  - a hash-based star field that only costs anything once the sun is down;
 *  - dithering, because a full-screen gradient on a headset panel bands badly.
 *
 * The dome renders *last* among opaque objects with depth testing on (the
 * vertex shader pins it to the far plane). Nothing that ends up behind terrain,
 * the ocean or the ship is ever shaded, so the extra cloud maths is only paid
 * for on pixels that are actually sky - and underwater, where the ocean surface
 * covers the whole upper hemisphere, it costs essentially nothing.
 */
export class Sky {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(radius = 4000) {
    this.material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      depthTest: true,
      dithering: true,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uZenith: { value: new Color(0x3f7ba8) },
        uHorizon: { value: new Color(0xb9c9cd) },
        uSunDirection: { value: new Vector3(0.4, 0.8, 0.25).normalize() },
        uSunColor: { value: new Color(0xfff4e2) },
        uExposure: { value: 1.0 },
        uFogColor: { value: new Color(0xb9c9cd) },
        uFogAmount: { value: 0 },
        uCloudCoverage: { value: 0.52 },
        uCloudStrength: { value: 0.75 },
        uCloudLit: { value: new Color(0xfdfaf4) },
        uCloudDark: { value: new Color(0x8ea4b4) },
        uStarStrength: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDirection;
        void main() {
          vWorldDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          // Pin to the far plane so depth testing rejects every pixel that
          // already has geometry in it.
          gl_Position.z = gl_Position.w;
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <dithering_pars_fragment>
        uniform float uTime;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform float uExposure;
        uniform vec3 uFogColor;
        uniform float uFogAmount;
        uniform float uCloudCoverage;
        uniform float uCloudStrength;
        uniform vec3 uCloudLit;
        uniform vec3 uCloudDark;
        uniform float uStarStrength;
        varying vec3 vWorldDirection;

        ${SKY_RADIANCE_GLSL}
        ${NOISE_GLSL}

        /**
         * Flat-plane cirrus sheet. Projecting the view ray onto a plane costs
         * one divide and gives correct perspective compression towards the
         * horizon for free; the fade hides the singularity where the ray runs
         * parallel to the sheet.
         */
        vec3 applyClouds(vec3 col, vec3 dir, float mu) {
          float band = smoothstep(0.015, 0.19, dir.y);
          if (band <= 0.0 || uCloudStrength <= 0.0) return col;

          vec2 uv = dir.xz / max(dir.y, 0.05) * 0.075;
          uv += vec2(uTime * 0.0032, uTime * 0.0011);
          float n = fbm2(uv);

          float cover = smoothstep(uCloudCoverage, uCloudCoverage + 0.26, n) * band;
          if (cover <= 0.0) return col;

          // Thicker cores go darker; the thin edges keep the lit tone, which is
          // most of what sells a cloud without any lighting model behind it.
          float thick = smoothstep(uCloudCoverage, uCloudCoverage + 0.5, n);
          vec3 cloud = mix(uCloudLit, uCloudDark, thick * 0.72);
          // Silver lining: thin cloud in front of the sun scatters forward.
          cloud += uSunColor * pow(max(mu, 0.0), 10.0) * (1.0 - thick) * 0.55;

          return mix(col, cloud, cover * uCloudStrength);
        }

        /** Sparse cell-hashed stars. Skipped whole while the sun is up. */
        vec3 starField(vec3 dir) {
          vec3 p = dir * 190.0;
          vec3 cell = floor(p);
          float h = hash31(cell);
          if (h < 0.992) return vec3(0.0);

          vec3 centre = vec3(hash31(cell + 11.7), hash31(cell + 23.3), hash31(cell + 37.1));
          float d = length((p - cell) - centre);
          float spark = smoothstep(0.26, 0.0, d);
          // Twinkle, plus a slight colour spread so the field is not pure white.
          spark *= 0.55 + 0.45 * sin(uTime * 2.1 + h * 431.0);
          spark *= (h - 0.992) / 0.008;
          vec3 tint = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.92, 0.78), hash31(cell + 5.2));
          return tint * spark * 1.4;
        }

        void main() {
          vec3 dir = normalize(vWorldDirection);
          vec3 sunDir = normalize(uSunDirection);
          vec3 col = uFogColor;

          // Underwater the dome is pure fog colour, so skip every bit of it.
          if (uFogAmount < 0.996) {
            float mu = dot(dir, sunDir);
            vec3 sky = skyRadiance(dir, uZenith, uHorizon, uSunColor, sunDir);
            sky = applyClouds(sky, dir, mu);

            // Sun disc, deliberately a few times its real angular size so it
            // still reads as a sun through headset optics.
            sky += uSunColor * smoothstep(0.99965, 0.99985, mu) * 9.0;

            sky *= uExposure;
            if (uStarStrength > 0.002) sky += starField(dir) * uStarStrength;

            col = sky;
          }

          gl_FragColor = vec4(col, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>

          // Fog is blended here, not before tone mapping, because that is where
          // three blends it for every other material - and with an already
          // encoded fog colour, not a linear one. Doing it the intuitive way
          // instead pushes the dome's "fog colour" through ACES (which brightens
          // mid tones by 1/0.6) while the ocean's stays untouched, so the two
          // converge on visibly different colours. Underwater that shows up as a
          // hard line along the rim of the ocean disc.
          gl_FragColor.rgb = mix(
            gl_FragColor.rgb,
            linearToOutputTexel(vec4(uFogColor, 1.0)).rgb,
            uFogAmount
          );

          #include <dithering_fragment>
        }
      `,
    });

    this.mesh = new Mesh(new SphereGeometry(radius, 32, 20), this.material);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    // Draw after every other opaque object so depth rejects occluded sky.
    this.mesh.renderOrder = 1000;
    this.mesh.matrixAutoUpdate = false;
  }

  get horizonColor(): Color {
    return this.material.uniforms.uHorizon.value as Color;
  }

  setTime(elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;
  }

  setSunDirection(dir: Vector3): void {
    (this.material.uniforms.uSunDirection.value as Vector3).copy(dir).normalize();
  }

  setPalette(zenith: Color, horizon: Color, sun: Color): void {
    (this.material.uniforms.uZenith.value as Color).copy(zenith);
    (this.material.uniforms.uHorizon.value as Color).copy(horizon);
    (this.material.uniforms.uSunColor.value as Color).copy(sun);
  }

  setExposure(value: number): void {
    this.material.uniforms.uExposure.value = value;
  }

  /**
   * @param lit    cloud colour where the sheet is thin
   * @param dark   cloud colour in the thick cores
   * @param amount 0 removes the sheet entirely (and skips the noise)
   */
  setClouds(lit: Color, dark: Color, amount: number): void {
    (this.material.uniforms.uCloudLit.value as Color).copy(lit);
    (this.material.uniforms.uCloudDark.value as Color).copy(dark);
    this.material.uniforms.uCloudStrength.value = amount;
  }

  setStarStrength(value: number): void {
    this.material.uniforms.uStarStrength.value = value;
  }

  setFogBlend(color: Color, amount: number): void {
    (this.material.uniforms.uFogColor.value as Color).copy(color);
    this.material.uniforms.uFogAmount.value = amount;
  }

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
