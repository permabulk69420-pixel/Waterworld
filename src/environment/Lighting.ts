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
  private readonly nightSkyColor = new Color(0x07111d);
  private readonly surfaceGroundColor = new Color(0x81755d);
  private readonly nightGroundColor = new Color(0x05090d);
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

    // Warm the directional light around sunrise/sunset, then let it collapse almost
    // completely at night. A tiny floor avoids pitch-black geometry while testing.
    this.daySun.copy(this.sunsetSunColor).lerp(this.surfaceSunColor, daylight);
    this.sun.color.copy(this.daySun).lerp(this.deepSunColor, submergence * 0.7);
    const sunDayIntensity = (2.4 * (1 - submergence) + 1.75 * submergence) * attenuation;
    this.sun.intensity = 0.025 + sunDayIntensity * daylight;

    this.daySky.copy(this.nightSkyColor).lerp(this.surfaceSkyColor, twilight);
    this.hemisphere.color.copy(this.daySky).lerp(shallowWater, submergence * 0.72 * twilight);

    this.dayGround.copy(this.nightGroundColor).lerp(this.surfaceGroundColor, twilight);
    this.caveFill.copy(deepWater).lerp(shallowWater, 0.46);
    this.hemisphere.groundColor
      .copy(this.dayGround)
      .lerp(this.caveFill, submergence * 0.72 * twilight);

    const hemiDayIntensity = (1.1 * (1 - submergence) + 0.92 * submergence) * attenuation;
    this.hemisphere.intensity = 0.045 + hemiDayIntensity * (0.12 + 0.88 * twilight);

    this.ambient.color.copy(this.caveFill);
    // Keep a very small underwater readability floor, but night should still create
    // a meaningful reason to carry a torch or move to a vehicle with headlights.
    this.ambient.intensity = submergence * attenuation * (0.035 + 0.485 * daylight);
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
