import type { BiomeConfig } from './types.ts';

/**
 * SAFE_SHALLOWS - the starting region.
 *
 * Broad, gently rolling seabed at 5-30 m with a handful of basins reaching
 * 35-50 m, shelves, ridges and small valleys. Nothing hostile, nothing deep.
 */
export const SAFE_SHALLOWS: BiomeConfig = {
  id: 'SAFE_SHALLOWS',
  label: 'Safe Shallows',

  terrain: {
    baseDepth: 16,
    heightVariation: 13,
    featureScale: 190,

    minDepth: 4,
    maxDepth: 50,

    roughness: 0.42,
    detailScale: 26,

    ridgeStrength: 0.55,
    ridgeScale: 120,

    shelfAmount: 0.35,
    shelfStep: 6,

    basinFrequency: 0.3,
    basinDepth: 26,
    basinScale: 230,

    overhangStrength: 9,
    overhangCoverage: 0.3,
  },

  caves: {
    frequency: 0.45,
    cellSize: 155,
    systemRadius: [34, 52],
    tunnelWidth: 0.3,
    tunnelScale: 74,
    maxDepthBelowSeabed: 24,
    chambersPerSystem: [2, 4],
    chamberRadius: [7, 11],
  },

  landmarks: {
    cellSize: 150,
    frequency: 0.55,
    weights: { pinnacle: 1, arch: 1, sinkhole: 0.8, mound: 1 },
  },

  // Instances per 100 m^2. The first vegetation value is intentionally modest:
  // the test GLB is animated and fairly detailed, so we can judge the look before
  // deciding how dense the final shallow grass fields should be.
  spawnDensity: {
    vegetation: 0.12,
    rocks: 0,
    resources: 0,
    creatures: 0,
    structures: 0,
    caveProps: 0,
  },

  visuals: {
    // Keep the starting biome warm enough to read as sand/stone even through
    // blue-green water. The previous grey palette was getting swallowed by the
    // fog and making every surface converge on the same cyan value.
    terrainShallowColor: 0xc8b98e,
    terrainDeepColor: 0x556c68,
    terrainSlopeColor: 0x747a70,
    waterShallowColor: 0x3695a5,
    waterDeepColor: 0x082d3d,
    // Clearer than the first technical pass so nearby terrain keeps contrast.
    // Deeper biomes can become genuinely murky later.
    fogDensityShallow: 0.0105,
    fogDensityDeep: 0.029,
  },
};
