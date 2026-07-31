import { Color, MeshStandardMaterial } from 'three';

/**
 * Adds cheap animated sunlight caustics to the shared terrain material.
 *
 * This deliberately avoids textures and extra draw calls. The pattern is generated in the
 * terrain fragment shader, fades with depth and camera distance, and mostly affects
 * upward-facing surfaces. Caustics brighten the terrain that is already there instead of
 * painting a cyan overlay across it, so the actual PBR seabed remains readable in VR.
 *
 * Important: terrain can already have shader extensions (sand, biome layers, etc). Never
 * replace those hooks; chain after them so every terrain effect survives compilation.
 */
export class TerrainCaustics {
  private readonly timeUniform = { value: 0 };
  private readonly strengthUniform = { value: 0.17 };
  private readonly seaLevelUniform: { value: number };
  private readonly colorUniform = { value: new Color(0xe7fff5) };

  constructor(material: MeshStandardMaterial, seaLevel: number) {
    this.seaLevelUniform = { value: seaLevel };

    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousProgramCacheKey = material.customProgramCacheKey;

    material.onBeforeCompile = (shader, renderer) => {
      // Preserve the base terrain shader first (currently projected coastal PBR terrain).
      previousOnBeforeCompile.call(material, shader, renderer);

      shader.uniforms.uCausticTime = this.timeUniform;
      shader.uniforms.uCausticStrength = this.strengthUniform;
      shader.uniforms.uCausticSeaLevel = this.seaLevelUniform;
      shader.uniforms.uCausticColor = this.colorUniform;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>\nvarying vec3 vCausticWorld;\nvarying float vCausticUp;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>\n  vCausticWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vCausticUp = max(normal.y, 0.0);`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vCausticWorld;
          varying float vCausticUp;
          uniform float uCausticTime;
          uniform float uCausticStrength;
          uniform float uCausticSeaLevel;
          uniform vec3 uCausticColor;

          float causticBand(float x) {
            // Softer, broader folds. Very narrow folds were reading like neon wireframes
            // once fog and distance removed the underlying terrain detail.
            float d = abs(fract(x) - 0.5) * 2.0;
            float fold = max(0.0, 1.0 - d);
            return fold * fold * fold * fold;
          }

          float causticPattern(vec2 p, float t) {
            // Larger-scale overlapping fields keep some broken sunlight motion without
            // turning the distant seabed into a high-frequency grid.
            float a = causticBand((p.x * 0.061 + p.y * 0.043) + sin(p.y * 0.105 + t * 0.55) * 0.27 + t * 0.032);
            float b = causticBand((p.x * -0.039 + p.y * 0.069) + sin(p.x * 0.092 - t * 0.47) * 0.24 - t * 0.028);
            float c = causticBand((p.x * 0.082 - p.y * 0.031) + sin((p.x + p.y) * 0.071 + t * 0.39) * 0.17 + t * 0.020);
            return min(1.0, a * 0.56 + b * 0.50 + c * 0.26);
          }`,
        )
        .replace(
          '#include <dithering_fragment>',
          `
          float causticDepth = max(0.0, uCausticSeaLevel - vCausticWorld.y);
          // Strongest right under the surface, already mostly gone in mid-depth water.
          float causticDepthFade = 1.0 - smoothstep(3.0, 25.0, causticDepth);
          float causticFacing = smoothstep(0.24, 0.86, vCausticUp);

          // Caustics should be a nearby lighting detail, not a glowing map-wide pattern.
          float causticViewDistance = distance(cameraPosition.xz, vCausticWorld.xz);
          float causticDistanceFade = 1.0 - smoothstep(28.0, 105.0, causticViewDistance);

          float caustic = causticPattern(vCausticWorld.xz, uCausticTime);
          float causticAmount =
            caustic *
            causticDepthFade *
            causticDistanceFade *
            causticFacing *
            uCausticStrength;

          // Preserve the material underneath: mostly brighten its existing colour with
          // only a tiny near-white aquatic tint rather than adding cyan light outright.
          vec3 causticLight = mix(gl_FragColor.rgb, uCausticColor, 0.10);
          gl_FragColor.rgb += causticLight * causticAmount;
          #include <dithering_fragment>`,
        );
    };

    // Keep the earlier terrain program identity too; otherwise Three can reuse a shader
    // compiled before one of the chained extensions was attached.
    material.customProgramCacheKey = () =>
      `${previousProgramCacheKey.call(material)}|waterworld-terrain-caustics-v3`;
    material.needsUpdate = true;
  }

  update(elapsed: number): void {
    this.timeUniform.value = elapsed;
  }

  setStrength(strength: number): void {
    this.strengthUniform.value = Math.max(0, strength);
  }

  setColor(hex: number): void {
    this.colorUniform.value.setHex(hex);
  }
}
