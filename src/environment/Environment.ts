import { Color, FogExp2, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import { Sky } from './Sky.ts';
import { Ocean } from './Ocean.ts';
import { Lighting } from './Lighting.ts';
import { LightShafts } from './LightShafts.ts';
import { TerrainCaustics } from './TerrainCaustics.ts';
import type { WorldConfig } from '../config/worldConfig.ts';
import type { BiomeRegistry } from '../config/biomes/index.ts';
import { saturate, smoothstep } from '../math/mathUtils.ts';

// Fast enough to test in VR without turning normal play into a strobe-show calendar.
// 0 = midnight, .25 = sunrise, .5 = noon, .75 = sunset.
const DAY_LENGTH_SECONDS = 12 * 60;
const START_TIME_OF_DAY = 10 / 24;

/**
 * Above-water haze. Low enough that open sea still reads as sea a few hundred
 * metres out, dense enough that the ocean disc's 2.4 km rim is long gone before
 * it could ever be seen as an edge.
 */
const AIR_FOG_DENSITY = 0.0012;

/** Ties sky, ocean, lighting, fog, day/night and cheap volumetric cues together. */
export class Environment {
  readonly sky: Sky;
  readonly ocean: Ocean;
  readonly lighting: Lighting;
  readonly shafts: LightShafts;

  /** 0 = fully above water, 1 = fully submerged. */
  submergence = 0;
  /** Depth of the camera below the water surface, in metres (>= 0). */
  depth = 0;
  /** 0 midnight, .25 sunrise, .5 noon, .75 sunset. */
  timeOfDay = START_TIME_OF_DAY;
  /** 0 at full night, 1 in strong daylight. */
  daylight = 1;

  private readonly fog: FogExp2;
  private readonly nightWater = new Color(0x000204);
  // Keep underwater night haze almost black, but leave a tiny blue-green residue so
  // silhouettes still read as submerged rather than disappearing into a flat void.
  private readonly nightUnderwaterFog = new Color(0x00070b);
  // A deeper zenith than the old near-grey: the whole point of the horizon haze
  // in the sky shader is that it has something to fade *from*.
  private readonly dayZenith = new Color(0x3d78ab);
  private readonly dayHorizon = new Color(0xbdcbcc);
  private readonly nightZenith = new Color(0x000208);
  private readonly nightHorizon = new Color(0x030811);
  private readonly duskHorizon = new Color(0xd07858);
  private readonly daySunColor = new Color(0xfff4e2);
  private readonly duskSunColor = new Color(0xff8b52);
  private readonly blackSun = new Color(0x000000);
  private readonly dayCloudLit = new Color(0xfdfaf4);
  private readonly dayCloudDark = new Color(0x93a8b8);
  private readonly duskCloudLit = new Color(0xffbc93);
  private readonly duskCloudDark = new Color(0x6a5570);
  private readonly nightCloud = new Color(0x070c14);
  private readonly shallowWater = new Color();
  private readonly deepWater = new Color();
  private readonly sunlitWater = new Color(0x72b5ae);
  private readonly tmpColor = new Color();
  private readonly tmpAir = new Color();
  private readonly tmpZenith = new Color();
  private readonly tmpHorizon = new Color();
  private readonly tmpSun = new Color();
  private readonly tmpScatter = new Color();
  private readonly tmpCloudLit = new Color();
  private readonly tmpCloudDark = new Color();
  private readonly tmpOceanSurface = new Color();
  private readonly tmpOceanDeep = new Color();
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
      // ~21k triangles for the entire ocean, which is noise next to the terrain
      // budget. Worth spending: the surface is shaded with an analytic normal,
      // so anywhere the geometry is too coarse to match it, the facets show -
      // most visibly along the edge of Snell's window a few metres overhead.
      rings: 72,
      segments: 144,
    });
    this.shafts = new LightShafts(config.seaLevel, this.lighting.sunDirection);

    this.fog = new FogExp2(this.dayHorizon.getHex(), AIR_FOG_DENSITY);
    scene.fog = this.fog;
    scene.background = this.dayHorizon.clone();

    scene.add(this.sky.mesh);
    scene.add(this.lighting.root);
    scene.add(this.ocean.mesh);
    scene.add(this.shafts.root);

    this.applyBiome(biomes);
    this.updateTimeOfDay(0);
  }

  applyBiome(biomes: BiomeRegistry, x = 0, z = 0): void {
    const biome = biomes.biomeAt(x, z);
    const v = biome.visuals;
    this.shallowWater.setHex(v.waterShallowColor);
    this.deepWater.setHex(v.waterDeepColor);
    this.fogDensityShallow = v.fogDensityShallow;
    this.fogDensityDeep = v.fogDensityDeep;
    this.maxDepth = biome.terrain.maxDepth;
  }

  /**
   * @param cameraPosition world position of the player's eyes
   * @param elapsed        seconds since start, for waves, sun motion and effects
   */
  update(cameraPosition: Vector3, elapsed: number): void {
    if (!this.terrainCaustics) this.tryAttachTerrainCaustics();
    this.updateTimeOfDay(elapsed);
    this.terrainCaustics?.update(elapsed);
    this.terrainCaustics?.setStrength(0.52 * this.daylight);

    const surfaceY = this.ocean.heightAt(cameraPosition.x, cameraPosition.z, elapsed);
    this.depth = Math.max(0, surfaceY - cameraPosition.y);
    this.submergence = smoothstep(surfaceY + 0.22, surfaceY - 0.28, cameraPosition.y);

    const depthT = saturate(this.depth / this.maxDepth);
    const depthColorT = Math.pow(depthT, 1.45);
    const twilight = this.currentTwilight();
    const underwaterNight = this.submergence * Math.pow(1 - twilight, 0.82);

    // Daytime keeps the biome/depth water colour, but night must darken the water
    // volume itself. The old behaviour kept Safe Shallows cyan in the fog/background
    // at midnight, which made darkness feel like a self-illuminated blue wall.
    this.tmpColor.copy(this.shallowWater);
    this.tmpColor.lerp(this.sunlitWater, (1 - depthT) * 0.24);
    this.tmpColor.lerp(this.deepWater, depthColorT);
    this.tmpColor.lerp(this.nightUnderwaterFog, underwaterNight * 0.96);
    this.tmpColor.lerp(this.tmpAir, 1 - this.submergence);
    this.fog.color.copy(this.tmpColor);
    if (this.scene.background instanceof Color) this.scene.background.copy(this.tmpColor);

    const waterDensity =
      this.fogDensityShallow +
      (this.fogDensityDeep - this.fogDensityShallow) * Math.pow(depthT, 1.2);
    // Daytime shallow water stays a little clearer. At full night also relax the
    // density slightly: distance should disappear primarily because there is no light,
    // not because a dense coloured fog curtain blocks the view.
    const shallowDayClarity = this.submergence * this.daylight * Math.pow(1 - depthT, 1.6);
    const nightDensityEase = 1 - 0.16 * underwaterNight;
    const adjustedWaterDensity = waterDensity * (1 - 0.2 * shallowDayClarity) * nightDensityEase;
    this.fog.density =
      AIR_FOG_DENSITY + (adjustedWaterDensity - AIR_FOG_DENSITY) * this.submergence;

    this.lighting.update(
      this.submergence,
      depthT,
      this.shallowWater,
      this.deepWater,
      this.daylight,
      twilight,
    );
    this.lighting.follow(cameraPosition);

    this.sky.setExposure((0.08 + 0.92 * twilight) * (1 - 0.5 * this.submergence));
    this.sky.setFogBlend(this.tmpColor, this.submergence);
    this.sky.setTime(elapsed);
    this.sky.followCamera(cameraPosition);

    this.ocean.update(elapsed, cameraPosition);
    this.shafts.update(
      elapsed,
      cameraPosition,
      this.submergence,
      this.depth,
      this.shallowWater,
      this.lighting.sunDirection,
      this.daylight,
    );
  }

  private updateTimeOfDay(elapsed: number): void {
    this.timeOfDay = (START_TIME_OF_DAY + elapsed / DAY_LENGTH_SECONDS) % 1;
    const solarAngle = (this.timeOfDay - 0.25) * Math.PI * 2;
    const rawAltitude = Math.sin(solarAngle);

    this.lighting.sunDirection
      .set(Math.cos(solarAngle) * 0.82, rawAltitude, 0.28)
      .normalize();

    this.daylight = smoothstep(-0.03, 0.22, rawAltitude);
    const twilight = this.currentTwilight(rawAltitude);
    const horizonBand = 1 - smoothstep(0.04, 0.42, Math.abs(rawAltitude));
    const duskAmount = horizonBand * twilight;

    this.tmpZenith.copy(this.nightZenith).lerp(this.dayZenith, twilight);
    this.tmpHorizon.copy(this.nightHorizon).lerp(this.dayHorizon, twilight);
    this.tmpHorizon.lerp(this.duskHorizon, duskAmount * 0.72);

    // Above-water fog is locked to the sky's horizon colour. The ocean disc ends
    // 2.4 km out, and this is what makes that edge land on exactly the colour
    // the dome is already painting behind it instead of showing as a seam.
    this.tmpAir.copy(this.tmpHorizon);

    this.tmpSun.copy(this.duskSunColor).lerp(this.daySunColor, this.daylight);
    this.tmpSun.lerp(this.blackSun, 1 - twilight);

    this.tmpCloudLit.copy(this.nightCloud).lerp(this.dayCloudLit, twilight);
    this.tmpCloudLit.lerp(this.duskCloudLit, duskAmount * 0.8);
    this.tmpCloudDark.copy(this.nightCloud).lerp(this.dayCloudDark, twilight);
    this.tmpCloudDark.lerp(this.duskCloudDark, duskAmount * 0.7);

    this.sky.setSunDirection(this.lighting.sunDirection);
    this.sky.setPalette(this.tmpZenith, this.tmpHorizon, this.tmpSun);
    this.sky.setClouds(this.tmpCloudLit, this.tmpCloudDark, 0.7);
    // Stars fade in as the sun drops below the twilight band.
    this.sky.setStarStrength(Math.pow(1 - twilight, 1.5));

    this.tmpOceanSurface.copy(this.shallowWater).lerp(this.nightWater, (1 - twilight) * 0.92);
    this.tmpOceanDeep.copy(this.deepWater).lerp(this.nightWater, (1 - twilight) * 0.96);
    this.tmpScatter.copy(this.sunlitWater).lerp(this.nightWater, 1 - twilight);
    this.ocean.setColors(
      this.tmpOceanSurface,
      this.tmpOceanDeep,
      this.tmpZenith,
      this.tmpHorizon,
      this.tmpScatter,
    );
    this.ocean.setSunDirection(this.lighting.sunDirection);
    this.ocean.setSunColor(this.tmpSun);
    this.ocean.setDaylight(this.daylight);
  }

  private currentTwilight(rawAltitude?: number): number {
    const altitude = rawAltitude ?? Math.sin((this.timeOfDay - 0.25) * Math.PI * 2);
    return smoothstep(-0.22, 0.06, altitude);
  }

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
