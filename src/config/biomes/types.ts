/**
 * Biome definition schema.
 *
 * A biome is pure data: it parameterises the shared terrain engine rather than
 * providing its own generation code. Adding a neighbouring biome later should
 * mean adding one of these objects and a rule in the biome map - never editing
 * the density field or the chunk streamer.
 */

export interface TerrainParams {
  /** Mean seabed depth below sea level, in metres (positive = deeper). */
  baseDepth: number;
  /** Peak-to-peak amplitude of the broad seabed undulation, in metres. */
  heightVariation: number;
  /** Horizontal wavelength of the broad undulation, in metres. */
  featureScale: number;

  /** Shallowest the seabed is allowed to get, in metres below sea level. */
  minDepth: number;
  /** Deepest the seabed is allowed to get, in metres below sea level. */
  maxDepth: number;

  /** 0..1 - amount of high frequency detail layered on the seabed. */
  roughness: number;
  /** Wavelength of the fine detail, in metres. */
  detailScale: number;

  /** 0..1 - strength of ridge formations. */
  ridgeStrength: number;
  /** Wavelength of ridges, in metres. */
  ridgeScale: number;

  /** 0..1 - how much of the seabed collapses into flat shelves / plateaus. */
  shelfAmount: number;
  /** Vertical spacing of shelf steps, in metres. */
  shelfStep: number;

  /** 0..1 - frequency of the deeper basins / depressions. */
  basinFrequency: number;
  /** Extra depth added inside a basin, in metres. */
  basinDepth: number;
  /** Wavelength of basins, in metres. */
  basinScale: number;

  /** Vertical amplitude of the 3D warp that produces overhangs, in metres. */
  overhangStrength: number;
  /** 0..1 - fraction of the biome where overhangs are allowed to appear. */
  overhangCoverage: number;
}

export interface CaveParams {
  /** 0..1 - probability that a given cave-grid cell hosts a cave system. */
  frequency: number;
  /** Size of the cave placement grid, in metres. */
  cellSize: number;
  /** Radius of a single cave system's influence, in metres. */
  systemRadius: [min: number, max: number];
  /** Tunnel radius control - larger = wider passages. */
  tunnelWidth: number;
  /** Horizontal wavelength of the tunnel noise, in metres. */
  tunnelScale: number;
  /** How far below the seabed surface caves may reach, in metres. */
  maxDepthBelowSeabed: number;
  /** Chambers carved per system. */
  chambersPerSystem: [min: number, max: number];
  /** Chamber radius range, in metres. */
  chamberRadius: [min: number, max: number];
}

export interface LandmarkParams {
  /** Size of the landmark placement grid, in metres. */
  cellSize: number;
  /** 0..1 - probability that a cell hosts a landmark. */
  frequency: number;
  /** Relative weights for the landmark archetypes. */
  weights: { pinnacle: number; arch: number; sinkhole: number; mound: number };
}

/**
 * Hooks for future content passes. Nothing reads these as spawn instructions
 * yet - the content registry simply forwards them to registered populators.
 */
export interface SpawnDensityHooks {
  /** Instances per 100 m^2 of seabed. All currently unused. */
  vegetation: number;
  rocks: number;
  resources: number;
  creatures: number;
  structures: number;
  caveProps: number;
}

export interface BiomeVisuals {
  /** Neutral terrain tint at the shallow end, hex. */
  terrainShallowColor: number;
  /** Neutral terrain tint at the deep end, hex. */
  terrainDeepColor: number;
  /** Tint applied to steep faces (rock vs sediment), hex. */
  terrainSlopeColor: number;
  /** Underwater fog colour near the surface, hex. */
  waterShallowColor: number;
  /** Underwater fog colour at depth, hex. */
  waterDeepColor: number;
  /** Underwater fog density near the surface. */
  fogDensityShallow: number;
  /** Underwater fog density at `maxDepth`. */
  fogDensityDeep: number;
}

export interface BiomeConfig {
  id: string;
  label: string;
  terrain: TerrainParams;
  caves: CaveParams;
  landmarks: LandmarkParams;
  spawnDensity: SpawnDensityHooks;
  visuals: BiomeVisuals;
}
