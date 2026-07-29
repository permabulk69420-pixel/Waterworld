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

  // Hooks only - no content is spawned in this pass.
  spawnDensity: {
    vegetation: 0,
    rocks: 0,
    resources: 0,
    creatures: 0,
    structures: 0,
    caveProps: 0,
  },

  visuals: {
    terrainShallowColor: 0xbdb49a,
    terrainDeepColor: 0x6d7b7d,
    terrainSlopeColor: 0x8a8d8c,
    waterShallowColor: 0x2f7f92,
    waterDeepColor: 0x0a2b3d,
    fogDensityShallow: 0.016,
    fogDensityDeep: 0.038,
  },
};
