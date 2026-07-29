import {
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  type WebGLRenderer,
} from 'three';

const SAND_TEXTURE_PATH = `${import.meta.env.BASE_URL}assets/textures/terrain/sand_basecolor.png`;

/**
 * Creates the shared terrain material.
 *
 * The generated density-field mesh intentionally has no UVs, so terrain
 * textures are projected in world X/Z space. This keeps the pattern seamless
 * across streamed chunk borders and means regenerated chunks always line up.
 *
 * First art pass:
 *  - shallow, upward-facing surfaces receive the sand base-colour texture
 *  - steep faces, cave walls and ceilings retain the existing biome vertex colour
 *  - sand fades with depth instead of ending at a hard horizontal line
 *
 * Later this same shader hook can grow into biome-controlled sand / rock /
 * sediment layers without changing the terrain mesher.
 */
export function createTerrainMaterial(renderer: WebGLRenderer, seaLevel: number): MeshStandardMaterial {
  const sand = new TextureLoader().load(
    SAND_TEXTURE_PATH,
    undefined,
    undefined,
    (error) => console.warn(`[terrain] could not load sand texture: ${SAND_TEXTURE_PATH}`, error),
  );

  sand.name = 'terrain:sand-basecolor';
  sand.wrapS = RepeatWrapping;
  sand.wrapT = RepeatWrapping;
  sand.colorSpace = SRGBColorSpace;
  sand.generateMipmaps = true;
  sand.minFilter = LinearMipmapLinearFilter;
  sand.magFilter = LinearFilter;
  sand.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: false,
    dithering: true,
  });

  material.name = 'terrain';
  material.userData.sandTexture = sand;

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainSand = { value: sand };
    shader.uniforms.uTerrainSeaLevel = { value: seaLevel };
    // ~6.25 metres per repeat. Easy to tune once we see the source texture in VR.
    shader.uniforms.uTerrainSandScale = { value: 0.16 };

    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `varying vec3 vTerrainWorldPosition;\n        varying vec3 vTerrainWorldNormal;\n\n        void main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n        vTerrainWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;\n        vTerrainWorldNormal = normalize(mat3(modelMatrix) * normal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `uniform sampler2D uTerrainSand;\n        uniform float uTerrainSeaLevel;\n        uniform float uTerrainSandScale;\n        varying vec3 vTerrainWorldPosition;\n        varying vec3 vTerrainWorldNormal;\n\n        void main() {`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n\n        // World-space planar projection is stable across chunk seams. Because\n        // only upward-facing surfaces use it, the usual stretching on vertical\n        // planar projection is hidden by the slope mask.\n        vec2 sandUv = vTerrainWorldPosition.xz * uTerrainSandScale;\n        vec3 sandColor = texture2D(uTerrainSand, sandUv).rgb;\n\n        float terrainDepth = max(0.0, uTerrainSeaLevel - vTerrainWorldPosition.y);\n        // Full sand on fairly flat seabed, then smoothly expose rock on slopes.\n        float flatMask = smoothstep(0.58, 0.84, normalize(vTerrainWorldNormal).y);\n        // Starting-shallows layer: strong through ~24 m, gone by ~36 m.\n        float depthMask = 1.0 - smoothstep(24.0, 36.0, terrainDepth);\n        float sandMask = flatMask * depthMask;\n\n        // Leave a little of the procedural vertex tint underneath so the texture\n        // inherits broad terrain variation instead of looking pasted on.\n        vec3 texturedSand = mix(diffuseColor.rgb, sandColor, 0.88);\n        diffuseColor.rgb = mix(diffuseColor.rgb, texturedSand, sandMask);`,
      );
  };

  material.customProgramCacheKey = () => 'waterworld-terrain-sand-v1';
  return material;
}

/** MeshStandardMaterial.dispose() does not dispose textures assigned through uniforms. */
export function disposeTerrainMaterial(material: MeshStandardMaterial): void {
  const sand = material.userData.sandTexture as Texture | undefined;
  sand?.dispose();
  material.dispose();
}
