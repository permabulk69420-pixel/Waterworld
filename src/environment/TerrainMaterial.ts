import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
  type WebGLRenderer,
} from 'three';

const SAND_TEXTURE_SIZE = 512;
const SAND_WORLD_SCALE = 0.34; // ~2.94 metres per seamless texture repeat.
const TAU = Math.PI * 2;

interface SandPbrTextures {
  baseColor: DataTexture;
  normal: DataTexture;
  orm: DataTexture;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const toByte = (value: number): number => Math.round(clamp01(value) * 255);

/**
 * Generates one small deterministic PBR sand set on startup instead of shipping a
 * single flat colour texture. The functions are periodic at the texture edges, so
 * RepeatWrapping stays seamless across both the texture and streamed terrain chunks.
 *
 * The pattern deliberately uses broad, warped current ripples plus restrained sediment
 * mottling. Fine diagonal micro-lines were avoided because they alias badly in a Quest
 * headset and can make sand read like fabric at distance.
 */
function createSandPbrTextures(renderer: WebGLRenderer): SandPbrTextures {
  const size = SAND_TEXTURE_SIZE;
  const count = size * size;
  const height = new Float32Array(count);
  const mottle = new Float32Array(count);
  const grain = new Float32Array(count);

  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;

      const broad =
        0.5 +
        0.18 * Math.sin(TAU * (u + 2 * v) + 0.55) +
        0.13 * Math.sin(TAU * (2 * u - v) + 1.8) +
        0.09 * Math.sin(TAU * (3 * u + v) + 2.65) +
        0.06 * Math.sin(TAU * (u - 3 * v) + 4.1);

      const warp =
        0.42 * Math.sin(TAU * (u + 2 * v) + 0.45) +
        0.24 * Math.sin(TAU * (2 * u - v) + 1.55) +
        0.11 * Math.sin(TAU * (3 * u + v) + 2.2);

      const primaryRaw = 0.5 + 0.5 * Math.sin(TAU * (5 * u + v) + warp);
      const primary = primaryRaw * primaryRaw * (3 - 2 * primaryRaw);
      const secondary = 0.5 + 0.5 * Math.sin(TAU * (u + 4 * v) + 0.32 * Math.sin(TAU * (2 * u + 2 * v)));

      const micro =
        0.5 +
        0.17 * Math.sin(TAU * (17 * u + 11 * v) + 0.2) +
        0.13 * Math.sin(TAU * (23 * u - 19 * v) + 2.1) +
        0.10 * Math.sin(TAU * (31 * u + 7 * v) + 4.4);

      mottle[index] = clamp01(broad);
      grain[index] = clamp01(micro);
      height[index] = clamp01(0.55 * primary + 0.11 * secondary + 0.27 * broad + 0.07 * micro);
    }
  }

  const baseBytes = new Uint8Array(count * 4);
  const normalBytes = new Uint8Array(count * 4);
  const ormBytes = new Uint8Array(count * 4);

  for (let y = 0; y < size; y += 1) {
    const ym = (y - 1 + size) % size;
    const yp = (y + 1) % size;
    for (let x = 0; x < size; x += 1) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const index = y * size + x;
      const offset = index * 4;
      const h = height[index];
      const broad = mottle[index];
      const micro = grain[index];

      // Warm tropical seabed sand. Most colour variation is broad sediment variation;
      // the actual grains are intentionally low contrast to stay stable under mipmaps.
      const tone = clamp01(0.48 + (broad - 0.5) * 0.36 + (h - 0.5) * 0.15 + (micro - 0.5) * 0.035);
      const darkR = 0.43;
      const darkG = 0.40;
      const darkB = 0.31;
      const lightR = 0.79;
      const lightG = 0.75;
      const lightB = 0.60;
      baseBytes[offset] = toByte(darkR + (lightR - darkR) * tone);
      baseBytes[offset + 1] = toByte(darkG + (lightG - darkG) * tone);
      baseBytes[offset + 2] = toByte(darkB + (lightB - darkB) * tone);
      baseBytes[offset + 3] = 255;

      // OpenGL/glTF-style tangent normal generated from the seamless height field.
      const dx = (height[y * size + xp] - height[y * size + xm]) * 0.5;
      const dy = (height[yp * size + x] - height[ym * size + x]) * 0.5;
      let nx = -dx * 17;
      let ny = -dy * 17;
      let nz = 1;
      const invLength = 1 / Math.hypot(nx, ny, nz);
      nx *= invLength;
      ny *= invLength;
      nz *= invLength;
      normalBytes[offset] = toByte(nx * 0.5 + 0.5);
      normalBytes[offset + 1] = toByte(ny * 0.5 + 0.5);
      normalBytes[offset + 2] = toByte(nz * 0.5 + 0.5);
      normalBytes[offset + 3] = 255;

      // glTF-style ORM packing: R=AO, G=roughness, B=metallic.
      const ao = clamp01(0.89 + h * 0.11);
      const roughness = clamp01(0.86 + (1 - h) * 0.09 + (micro - 0.5) * 0.025);
      ormBytes[offset] = toByte(ao);
      ormBytes[offset + 1] = toByte(roughness);
      ormBytes[offset + 2] = 0;
      ormBytes[offset + 3] = 255;
    }
  }

  const makeTexture = (data: Uint8Array, name: string, srgb: boolean): DataTexture => {
    const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
    texture.name = name;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    if (srgb) texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    baseColor: makeTexture(baseBytes, 'terrain:sand-v10-basecolor', true),
    normal: makeTexture(normalBytes, 'terrain:sand-v10-normal', false),
    orm: makeTexture(ormBytes, 'terrain:sand-v10-orm', false),
  };
}

/**
 * Creates the shared terrain material.
 *
 * The density-field terrain has no UVs, so the PBR sand set is projected in world X/Z
 * space. Flat shallow seabed gets the full material; slopes, caves and deeper terrain
 * smoothly fall back to the existing procedural biome vertex colours.
 */
export function createTerrainMaterial(renderer: WebGLRenderer, seaLevel: number): MeshStandardMaterial {
  const sand = createSandPbrTextures(renderer);

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: false,
    dithering: true,
  });

  material.name = 'terrain';
  material.userData.sandTextures = [sand.baseColor, sand.normal, sand.orm];

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTerrainSandBase = { value: sand.baseColor };
    shader.uniforms.uTerrainSandNormal = { value: sand.normal };
    shader.uniforms.uTerrainSandOrm = { value: sand.orm };
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
        `uniform sampler2D uTerrainSandBase;\n        uniform sampler2D uTerrainSandNormal;\n        uniform sampler2D uTerrainSandOrm;\n        uniform float uTerrainSeaLevel;\n        uniform float uTerrainSandScale;\n        varying vec3 vTerrainWorldPosition;\n        varying vec3 vTerrainWorldNormal;\n\n        void main() {`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>\n\n        vec2 sandUv = vTerrainWorldPosition.xz * uTerrainSandScale;\n        vec3 sandColor = texture2D(uTerrainSandBase, sandUv).rgb;\n        vec3 sandOrm = texture2D(uTerrainSandOrm, sandUv).rgb;\n        vec3 sandNormalTex = texture2D(uTerrainSandNormal, sandUv).xyz * 2.0 - 1.0;\n\n        float terrainDepth = max(0.0, uTerrainSeaLevel - vTerrainWorldPosition.y);\n        float flatMask = smoothstep(0.58, 0.84, normalize(vTerrainWorldNormal).y);\n        float depthMask = 1.0 - smoothstep(24.0, 36.0, terrainDepth);\n        float sandMask = flatMask * depthMask;\n\n        // AO is intentionally subtle here; deep black baked creases look fake underwater.\n        sandColor *= mix(0.94, 1.0, sandOrm.r);\n        vec3 texturedSand = mix(diffuseColor.rgb, sandColor, 0.92);\n        diffuseColor.rgb = mix(diffuseColor.rgb, texturedSand, sandMask);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\n        roughnessFactor = mix(roughnessFactor, sandOrm.g, sandMask * 0.95);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n        metalnessFactor = mix(metalnessFactor, sandOrm.b, sandMask);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n\n        // Re-orient the projected normal map onto the actual seabed normal. Pick\n        // a tangent seed that cannot become parallel to the surface normal so even\n        // non-sandy vertical walls keep finite shader values.\n        vec3 sandWorldUp = normalize(vTerrainWorldNormal);\n        vec3 sandTangentSeed = abs(sandWorldUp.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);\n        vec3 sandTangent = normalize(sandTangentSeed - sandWorldUp * dot(sandWorldUp, sandTangentSeed));\n        vec3 sandBitangent = normalize(cross(sandTangent, sandWorldUp));\n        vec3 sandWorldNormal = normalize(\n          sandTangent * sandNormalTex.x +\n          sandBitangent * sandNormalTex.y +\n          sandWorldUp * max(0.18, sandNormalTex.z)\n        );\n        vec3 sandViewNormal = normalize(mat3(viewMatrix) * sandWorldNormal);\n        normal = normalize(mix(normal, sandViewNormal, sandMask * 0.72));`,
      );
  };

  material.customProgramCacheKey = () => 'waterworld-terrain-sand-pbr-v10';
  return material;
}

/** MeshStandardMaterial.dispose() does not dispose textures assigned only through uniforms. */
export function disposeTerrainMaterial(material: MeshStandardMaterial): void {
  const textures = material.userData.sandTextures as Texture[] | undefined;
  textures?.forEach((texture) => texture.dispose());
  material.dispose();
}
