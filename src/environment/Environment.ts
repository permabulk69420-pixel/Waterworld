import { Color, FogExp2, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import { Sky } from './Sky.ts';
import { Ocean } from './Ocean.ts';
import { Lighting } from './Lighting.ts';
import { LightShafts } from './LightShafts.ts';
import { TerrainCaustics } from './TerrainCaustics.ts';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';

/**
 * Ties the sky, ocean, lighting, fog and cheap volumetric cues into one state.
 *
 * Underwater visibility stays on cheap exponential fog for Quest. The shallow
 * colour is deliberately lifted toward a sunlit green-teal rather than using
 * the raw water colour as the entire scene background; otherwise terrain,
 * distant water and shadow all collapse into one blue slab.
 */
export class Environment {
  readonly sky: Sky;
  readonly ocean: Ocean;
  readonly lighting: Lighting;
  readonly shafts: LightShafts;

  /** 0 = fully above water, 1 = fully submerged. */
  submergence = 0;
  /** Depth of the camera below the water surface, in metres (>= 0). */
  depth = 0;

  private readonly fog: FogExp2;
  private readonly airFogColor = new Color(0xb9c9cd);
  private readonly shallowWater = new Color();
  private readonly deepWater = new Color();
  private readonly sunlitWater = new Color(0x72b5ae);
  private readonly tmpColor = new Color();
  private fogDensityShallow = 0.016;
  private fogDensityDeep = 0.038;
  private maxDepth = 50;
  private terrainCaustics: TerrainCaustics | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly config: WorldConfig,
    biomes: BiomeRegistry,
  ) {
    this.sky = new Sky();
    this.lighting = new Lighting();
    this.ocean = new Ocean({
      seaLevel: config.seaLevel,
      radius: 2400,
      rings: 56,
      segments: 96,
    });
    this.shafts = new LightShafts(config.seaLevel, this.lighting.sunDirection);

    this.fog = new FogExp2(this.airFogColor.getHex(), 0.0016);
    scene.fog = this.fog;
    scene.background = this.airFogColor.clone();

    scene.add(this.sky.mesh);
    scene.add(this.lighting.root);
    scene.add(this.ocean.mesh);
    scene.add(this.shafts.root);

    this.sky.setSunDirection(this.lighting.sunDirection);
    this.ocean.setSunDirection(this.lighting.sunDirection);
    this.applyBiome(biomes);
  }

  /** Pulls water colours and fog densities from the biome the player is in. */
  applyBiome(biomes: BiomeRegistry, x = 0, z = 0): void {
    const v = biomes.biomeAt(x, z).visuals;
    this.shallowWater.setHex(v.waterShallowColor);
    this.deepWater.setHex(v.waterDeepColor);
    this.fogDensityShallow = v.fogDensityShallow;
    this.fogDensityDeep = v.fogDensityDeep;
    this.maxDepth = biomes.biomeAt(x, z).terrain.maxDepth;
    this.ocean.setColors(this.shallowWater, this.deepWater, this.sky.horizonColor);
  }

  /**
   * @param cameraPosition world position of the player's eyes
   * @param elapsed        seconds since start, for wave / light animation
   */
  update(cameraPosition: Vector3, elapsed: number): void {
    // ChunkManager owns one shared MeshStandardMaterial. Chunks are loaded after this
    // Environment is constructed, so attach the caustic shader lazily to the first one.
    if (!this.terrainCaustics) this.tryAttachTerrainCaustics();
    this.terrainCaustics?.update(elapsed);

    const surfaceY = this.ocean.heightAt(cameraPosition.x, cameraPosition.z, elapsed);
    this.depth = Math.max(0, surfaceY - cameraPosition.y);

    // Transition band straddling the local (wavy) surface height.
    this.submergence = smoothstep(surfaceY + 0.22, surfaceY - 0.28, cameraPosition.y);

    const depthT = saturate(this.depth / this.maxDepth);
    const depthColorT = Math.pow(depthT, 1.45);

    // Near the surface, borrow a little warm green daylight so the world does
    // not become uniformly cyan. Fade naturally into the biome's deep colour.
    this.tmpColor.copy(this.shallowWater);
    this.tmpColor.lerp(this.sunlitWater, (1 - depthT) * 0.24);
    this.tmpColor.lerp(this.deepWater, depthColorT);
    this.tmpColor.lerp(this.airFogColor, 1 - this.submergence);
    this.fog.color.copy(this.tmpColor);
    if (this.scene.background instanceof Color) this.scene.background.copy(this.tmpColor);

    // Clear starting shallows; deeper water still closes in progressively.
    const waterDensity =
      this.fogDensityShallow +
      (this.fogDensityDeep - this.fogDensityShallow) * Math.pow(depthT, 1.2);
    this.fog.density = 0.0016 + (waterDensity - 0.0016) * this.submergence;

    this.lighting.update(this.submergence, depthT, this.shallowWater, this.deepWater);
    this.lighting.follow(cameraPosition);
    this.sky.setExposure(1 - 0.5 * this.submergence);
    this.sky.setFogBlend(this.tmpColor, this.submergence);
    this.sky.followCamera(cameraPosition);
    this.ocean.update(elapsed, cameraPosition, this.submergence > 0.5);
    this.shafts.update(elapsed, cameraPosition, this.submergence, this.depth, this.shallowWater);
  }

  /** Find one streamed terrain chunk; all chunks share this same material instance. */
  private tryAttachTerrainCaustics(): void {
    const terrain = this.scene.getObjectByName('terrain');
    if (!terrain) return;

    for (const child of terrain.children) {
      if (!(child instanceof Mesh)) continue;
      const material = child.material;
      if (!(material instanceof MeshStandardMaterial)) continue;
      this.terrainCaustics = new TerrainCaustics(material, this.config.seaLevel);
      return;
    }
  }

  get underwater(): boolean {
    return this.submergence > 0.5;
  }

  get seaLevel(): number {
    return this.config.seaLevel;
  }

  dispose(): void {
    this.sky.dispose();
    this.ocean.dispose();
    this.lighting.dispose();
    this.shafts.dispose();
  }
}
