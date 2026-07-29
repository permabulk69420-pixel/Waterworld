import { Color, FogExp2, Scene, Vector3 } from 'three';
import { Sky } from './Sky.ts';
import { Ocean } from './Ocean.ts';
import { Lighting } from './Lighting.ts';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';

/**
 * Ties the sky, ocean, lighting and fog into one "where am I" state.
 *
 * Underwater visibility is done entirely with exponential fog whose colour and
 * density both track depth - no post-processing pass, which matters because a
 * fullscreen pass on Quest costs more than the entire terrain draw. Crossing
 * the surface swaps fog and lighting over a ~0.5 m band: fast enough to read as
 * a distinct transition, slow enough not to strobe on a wave crest.
 */
export class Environment {
  readonly sky: Sky;
  readonly ocean: Ocean;
  readonly lighting: Lighting;

  /** 0 = fully above water, 1 = fully submerged. */
  submergence = 0;
  /** Depth of the camera below the water surface, in metres (>= 0). */
  depth = 0;

  private readonly fog: FogExp2;
  private readonly airFogColor = new Color(0xb9c9cd);
  private readonly shallowWater = new Color();
  private readonly deepWater = new Color();
  private readonly tmpColor = new Color();
  private fogDensityShallow = 0.016;
  private fogDensityDeep = 0.038;
  private maxDepth = 50;

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

    this.fog = new FogExp2(this.airFogColor.getHex(), 0.0016);
    scene.fog = this.fog;
    scene.background = this.airFogColor.clone();

    scene.add(this.sky.mesh);
    scene.add(this.lighting.root);
    scene.add(this.ocean.mesh);

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
   * @param elapsed        seconds since start, for the wave animation
   */
  update(cameraPosition: Vector3, elapsed: number): void {
    const surfaceY = this.ocean.heightAt(cameraPosition.x, cameraPosition.z, elapsed);
    this.depth = Math.max(0, surfaceY - cameraPosition.y);

    // Transition band straddling the local (wavy) surface height.
    this.submergence = smoothstep(surfaceY + 0.22, surfaceY - 0.28, cameraPosition.y);

    const depthT = saturate(this.depth / this.maxDepth);

    // Fog colour: air -> shallow water -> deep water.
    this.tmpColor.copy(this.shallowWater).lerp(this.deepWater, depthT * depthT);
    this.tmpColor.lerp(this.airFogColor, 1 - this.submergence);
    this.fog.color.copy(this.tmpColor);
    if (this.scene.background instanceof Color) this.scene.background.copy(this.tmpColor);

    // Fog density: near-clear air, progressively murkier water.
    const waterDensity =
      this.fogDensityShallow + (this.fogDensityDeep - this.fogDensityShallow) * depthT;
    this.fog.density = 0.0016 + (waterDensity - 0.0016) * this.submergence;

    this.lighting.update(this.submergence, depthT, this.shallowWater, this.deepWater);
    this.lighting.follow(cameraPosition);
    this.sky.setExposure(1 - 0.55 * this.submergence);
    this.sky.setFogBlend(this.tmpColor, this.submergence);
    this.sky.followCamera(cameraPosition);
    this.ocean.update(elapsed, cameraPosition, this.submergence > 0.5);
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
  }
}
