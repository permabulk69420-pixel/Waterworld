import { AmbientLight, Color, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three';

/** Scene lighting driven by water depth and time of day. */
export class Lighting {
  readonly root = new Group();
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly ambient: AmbientLight;
  readonly sunDirection = new Vector3(0.4, 0.85, 0.28).normalize();

  private readonly surfaceSunColor = new Color(0xfff0d2);
  private readonly sunsetSunColor = new Color(0xff9b62);
  private readonly deepSunColor = new Color(0x8bc8d2);
  private readonly surfaceSkyColor = new Color(0xb7cdd2);
  private readonly nightSkyColor = new Color(0x020711);
  private readonly surfaceGroundColor = new Color(0x81755d);
  private readonly nightGroundColor = new Color(0x010305);
  private readonly caveFill = new Color();
  private readonly daySun = new Color();
  private readonly daySky = new Color();
  private readonly dayGround = new Color();

  constructor() {
    this.root.name = 'lighting';

    this.sun = new DirectionalLight(this.surfaceSunColor.clone(), 2.4);
    this.sun.position.copy(this.sunDirection).multiplyScalar(200);
    this.sun.castShadow = false;
    this.root.add(this.sun);
    this.root.add(this.sun.target);

    this.hemisphere = new HemisphereLight(
      this.surfaceSkyColor.clone(),
      this.surfaceGroundColor.clone(),
      1.1,
    );
    this.root.add(this.hemisphere);

    this.ambient = new AmbientLight(0x2f7f92, 0);
    this.root.add(this.ambient);
  }

  /**
   * @param submergence 0 above the surface, 1 fully underwater
   * @param depthT      0 at the surface, 1 at the biome's maximum depth
   * @param shallowWater shallow-water biome colour
   * @param deepWater deep-water biome colour
   * @param daylight    0 at full night, 1 in full daylight
   * @param twilight    0 at deep night, 1 once the sun is around/above the horizon
   */
  update(
    submergence: number,
    depthT: number,
    shallowWater: Color,
    deepWater: Color,
    daylight = 1,
    twilight = 1,
  ): void {
    const attenuation = 1 - 0.44 * depthT;
    // Bright tropical shallows need a lot more diffuse skylight than deep water.
    // Fade the boost aggressively with depth so caves/deeper biomes keep contrast.
    const shallowDay = submergence * daylight * Math.pow(1 - depthT, 1.5);

    this.daySun.copy(this.sunsetSunColor).lerp(this.surfaceSunColor, daylight);
    this.sun.color.copy(this.daySun).lerp(this.deepSunColor, submergence * 0.7);
    const sunDayIntensity =
      (2.4 * (1 - submergence) + 1.85 * submergence + 0.18 * shallowDay) * attenuation;
    // Keep a vanishingly small floor only to avoid hard numerical black. Player
    // lights should dominate underwater at full night.
    this.sun.intensity = 0.0015 + sunDayIntensity * daylight;

    this.daySky.copy(this.nightSkyColor).lerp(this.surfaceSkyColor, twilight);
    // Near the surface keep more neutral sky colour in the fill. The previous 72%
    // teal blend made colourful PBR fauna read almost black unless the headlamp hit it.
    const skyWaterTint = submergence * twilight * (0.48 + 0.24 * depthT);
    this.hemisphere.color.copy(this.daySky).lerp(shallowWater, skyWaterTint);

    this.dayGround.copy(this.nightGroundColor).lerp(this.surfaceGroundColor, twilight);
    this.caveFill.copy(deepWater).lerp(shallowWater, 0.46);
    const groundWaterTint = submergence * twilight * (0.5 + 0.22 * depthT);
    this.hemisphere.groundColor
      .copy(this.dayGround)
      .lerp(this.caveFill, groundWaterTint);

    const hemiDayIntensity =
      ((1.1 * (1 - submergence) + 0.98 * submergence) * attenuation) + 0.42 * shallowDay;
    // Full night still collapses almost completely; the extra fill exists only while
    // daylight is actually reaching shallow water.
    this.hemisphere.intensity = 0.004 + hemiDayIntensity * (0.008 + 0.992 * twilight);

    this.ambient.color.copy(this.caveFill).lerp(this.surfaceSkyColor, 0.26 * shallowDay);
    this.ambient.intensity =
      submergence * attenuation * (0.003 + (0.62 + 0.28 * shallowDay) * daylight);
  }

  /** Keeps the directional light centred so it never runs out of range. */
  follow(position: Vector3): void {
    this.sun.position.copy(position).addScaledVector(this.sunDirection, 200);
    this.sun.target.position.copy(position);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void {
    this.sun.dispose();
    this.hemisphere.dispose();
    this.ambient.dispose();
  }
}
