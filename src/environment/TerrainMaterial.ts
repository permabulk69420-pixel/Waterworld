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
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const TERRAIN_TEXTURE_ROOT = `${import.meta.env.BASE_URL}assets/textures/terrain`;
const SAND_BASE_PATH = `${TERRAIN_TEXTURE_ROOT}/coast_land_rocks_01_diff_1k.jpg`;
const SAND_NORMAL_PATH = `${TERRAIN_TEXTURE_ROOT}/coast_land_rocks_01_nor_gl_1k.exr`;
const SAND_ROUGHNESS_PATH = `${TERRAIN_TEXTURE_ROOT}/coast_land_rocks_01_rough_1k.exr`;
const SAND_HEIGHT_PATH = `${TERRAIN_TEXTURE_ROOT}/coast_land_rocks_01_disp_1k.png`;

// Roughly 4.5 metres per repeat. The source is detailed enough to read close-up
// without turning the seabed into an obvious tiny checkerboard at distance.
const SAND_WORLD_SCALE = 0.22;

function configureColorTexture(
  texture: Texture,
  renderer: WebGLRenderer,
  name: string,
): Texture {
  texture.name = name;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return texture;
}

function configureLinearTexture(
  texture: Texture,
  renderer: WebGLRenderer,
  name: string,
  useMipmaps: boolean,
): Texture {
  texture.name = name;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = useMipmaps;
  texture.minFilter = useMipmaps ? LinearMipmapLinearFilter : LinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = useMipmaps
    ? Math.min(4, renderer.capabilities.getMaxAnisotropy())
    : 1;
  return texture;
}

/**
 * Creates the shared terrain material.
 *
 * The density-field terrain has no UVs, so the coastal PBR set is projected in
 * world X/Z space. Flat shallow seabed receives the scanned material; steep faces,
 * caves and deeper terrain smoothly fall back to biome vertex colours.
 *
 * The supplied displacement map is intentionally NOT used for geometric terrain
 * displacement. It only adds restrained height shading, which gives us most of the
 * close-up depth cue without tessellating kilometres of Quest terrain.
 */
export function createTerrainMaterial(renderer: WebGLRenderer, seaLevel: number): MeshStandardMaterial {
  const textureLoader = new TextureLoader();
  const exrLoader = new EXRLoader();

  const sandBase = configureColorTexture(
    textureLoader.load(
      SAND_BASE_PATH,
      undefined,
      undefined,
      (error) => console.warn(`[terrain] could not load coastal base colour: ${SAND_BASE_PATH}`, error),
    ),
    renderer,
    'terrain:coastal-pbr-basecolor',
  );

  // EXRLoader can decode the source OpenEXR maps directly. Keep these linear and
  // non-mipmapped for the moment; this avoids relying on half-float mip generation
  // quirks across Quest browser/WebGL implementations while still giving stable
  // filtering at our relatively large world-space repeat size.
  const sandNormal = configureLinearTexture(
    exrLoader.load(
      SAND_NORMAL_PATH,
      undefined,
      undefined,
      (error) => console.warn(`[terrain] could not load coastal normal map: ${SAND_NORMAL_PATH}`, error),
    ),
    renderer,
    'terrain:coastal-pbr-normal',
    false,
  );

  const sandRoughness = configureLinearTexture(
    exrLoader.load(
      SAND_ROUGHNESS_PATH,
      undefined,
      undefined,
      (error) => console.warn(`[terrain] could not load coastal roughness map: ${SAND_ROUGHNESS_PATH}`, error),
    ),
    renderer,
    'terrain:coastal-pbr-roughness',
    false,
  );

  const sandHeight = configureLinearTexture(
    textureLoader.load(
      SAND_HEIGHT_PATH,
      undefined,
      undefined,
      (error) => console.warn(`[terrain] could not load coastal height map: ${SAND_HEIGHT_PATH}`, error),
    ),
    renderer,
    'terrain:coastal-pbr-height',
    true,
  );

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: false,
    dithering: true,
  });

  material.name = 'terrain';
  material.userData.sandTextures = [sandBase, sandNormal, sandRoughness, sandHeight];

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainSandBase = { value: sandBase };
    shader.uniforms.uTerrainSandNormal = { value: sandNormal };
    shader.uniforms.uTerrainSandRoughness = { value: sandRoughness };
    shader.uniforms.uTerrainSandHeight = { value: sandHeight };
    shader.uniforms.uTerrainSeaLevel = { value: seaLevel };
    shader.uniforms.uTerrainSandScale = { value: SAND_WORLD_SCALE };

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
        `uniform sampler2D uTerrainSandBase;\n        uniform sampler2D uTerrainSandNormal;\n        uniform sampler2D uTerrainSandRoughness;\n        uniform sampler2D uTerrainSandHeight;\n        uniform float uTerrainSeaLevel;\n        uniform float uTerrainSandScale;\n        varying vec3 vTerrainWorldPosition;\n        varying vec3 vTerrainWorldNormal;\n\n        void main() {`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n\n        vec2 sandUv = vTerrainWorldPosition.xz * uTerrainSandScale;\n        vec3 sandColor = texture2D(uTerrainSandBase, sandUv).rgb;\n        vec3 sandNormalTex = texture2D(uTerrainSandNormal, sandUv).xyz * 2.0 - 1.0;\n        float sandRoughness = texture2D(uTerrainSandRoughness, sandUv).r;\n        float sandHeight = texture2D(uTerrainSandHeight, sandUv).r;\n\n        float terrainDepth = max(0.0, uTerrainSeaLevel - vTerrainWorldPosition.y);\n        float flatMask = smoothstep(0.58, 0.84, normalize(vTerrainWorldNormal).y);\n        float depthMask = 1.0 - smoothstep(24.0, 36.0, terrainDepth);\n        float sandMask = flatMask * depthMask;\n\n        // Use the displacement texture only as subtle micro-relief shading. Actual\n        // terrain silhouette still comes entirely from the density-field mesh.\n        float heightShade = mix(0.94, 1.035, smoothstep(0.12, 0.88, sandHeight));\n        sandColor *= heightShade;\n\n        // The scan should dominate while preserving a small amount of the biome's\n        // broad procedural colour so neighbouring terrain still blends naturally.\n        vec3 texturedSand = mix(diffuseColor.rgb, sandColor, 0.96);\n        diffuseColor.rgb = mix(diffuseColor.rgb, texturedSand, sandMask);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n        roughnessFactor = mix(roughnessFactor, clamp(sandRoughness, 0.28, 1.0), sandMask * 0.96);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n\n        // Re-orient the OpenGL normal map from the world-XZ projection onto the\n        // actual seabed surface. A safe tangent seed prevents NaNs on steep walls.\n        vec3 sandWorldUp = normalize(vTerrainWorldNormal);\n        vec3 sandTangentSeed = abs(sandWorldUp.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);\n        vec3 sandTangent = normalize(sandTangentSeed - sandWorldUp * dot(sandWorldUp, sandTangentSeed));\n        vec3 sandBitangent = normalize(cross(sandTangent, sandWorldUp));\n        sandNormalTex.xy *= 0.72;\n        vec3 sandWorldNormal = normalize(\n          sandTangent * sandNormalTex.x +\n          sandBitangent * sandNormalTex.y +\n          sandWorldUp * max(0.20, sandNormalTex.z)\n        );\n        vec3 sandViewNormal = normalize(mat3(viewMatrix) * sandWorldNormal);\n        normal = normalize(mix(normal, sandViewNormal, sandMask * 0.78));`,
      );
  };

  material.customProgramCacheKey = () => 'waterworld-terrain-coastal-pbr-v11';
  return material;
}

/** MeshStandardMaterial.dispose() does not dispose textures assigned only through uniforms. */
export function disposeTerrainMaterial(material: MeshStandardMaterial): void {
  const textures = material.userData.sandTextures as Texture[] | undefined;
  textures?.forEach((texture) => texture.dispose());
  material.dispose();
}
