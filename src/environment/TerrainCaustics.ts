import { Color, MeshStandardMaterial } from 'three';

/**
 * Adds cheap animated sunlight caustics to the shared terrain material.
 *
 * This deliberately avoids textures and extra draw calls. The pattern is generated in the
 * terrain fragment shader, fades with depth, and mostly affects upward-facing surfaces.
 * It is not physically exact, but it gives the shallows the moving broken-light look that
 * matters perceptually in VR for a very small GPU cost.
 */
export class TerrainCaustics {
  private readonly timeUniform = { value: 0 };
  private readonly strengthUniform = { value: 0.52 };
  private readonly seaLevelUniform: { value: number };
  private readonly colorUniform = { value: new Color(0xa7f0d6) };

  constructor(material: MeshStandardMaterial, seaLevel: number) {
    this.seaLevelUniform = { value: seaLevel };

    material.onBeforeCompile = (shader) => {
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
            // Narrow bright folds with soft shoulders, like focused wave light.
            float d = abs(fract(x) - 0.5) * 2.0;
            return pow(max(0.0, 1.0 - d), 7.0);
          }

          float causticPattern(vec2 p, float t) {
            // Two independently moving interference fields stop the result reading as a grid.
            float a = causticBand((p.x * 0.095 + p.y * 0.071) + sin(p.y * 0.19 + t * 0.73) * 0.34 + t * 0.055);
            float b = causticBand((p.x * -0.064 + p.y * 0.112) + sin(p.x * 0.16 - t * 0.61) * 0.31 - t * 0.047);
            float c = causticBand((p.x * 0.137 - p.y * 0.051) + sin((p.x + p.y) * 0.11 + t * 0.52) * 0.22 + t * 0.031);
            return min(1.0, a * 0.72 + b * 0.68 + c * 0.42);
          }`,
        )
        .replace(
          '#include <dithering_fragment>',
          `
          float causticDepth = max(0.0, uCausticSeaLevel - vCausticWorld.y);
          float causticDepthFade = 1.0 - smoothstep(5.0, 38.0, causticDepth);
          float causticFacing = smoothstep(0.15, 0.82, vCausticUp);
          float caustic = causticPattern(vCausticWorld.xz, uCausticTime);
          float causticAmount = caustic * causticDepthFade * causticFacing * uCausticStrength;
          gl_FragColor.rgb += uCausticColor * causticAmount;
          #include <dithering_fragment>`,
        );
    };

    // Ensure Three does not reuse a program compiled before the injection existed.
    material.customProgramCacheKey = () => 'waterworld-terrain-caustics-v1';
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
