import { AmbientLight, Color, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three';

/**
 * Scene lighting.
 *
 * One directional sun plus cheap hemisphere/ambient fill. The important bit for
 * the starting biome is contrast: the technical pass used enough blue fill to
 * make caves readable, but it also flattened every ridge into the same cyan.
 * This pass lets the sun do more of the modelling while retaining a small fill
 * floor for caves and overhangs.
 */
export class Lighting {
  readonly root = new Group();
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  /** Cheap cave/underhang fill; no extra per-fragment dynamic light. */
  readonly ambient: AmbientLight;
  readonly sunDirection = new Vector3(0.4, 0.85, 0.28).normalize();

  private readonly surfaceSunColor = new Color(0xfff0d2);
  private readonly deepSunColor = new Color(0x8bc8d2);
  private readonly surfaceSkyColor = new Color(0xb7cdd2);
  private readonly surfaceGroundColor = new Color(0x81755d);
  private readonly caveFill = new Color();

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
   */
  update(submergence: number, depthT: number, shallowWater: Color, deepWater: Color): void {
    // Keep useful sunlight deeper than the first pass. This gives slopes a clear
    // light-facing and dark-facing side instead of filling both equally blue.
    const attenuation = 1 - 0.44 * depthT;

    this.sun.intensity = (2.4 * (1 - submergence) + 1.75 * submergence) * attenuation;
    this.sun.color.copy(this.surfaceSunColor).lerp(this.deepSunColor, submergence);

    // Pull the broad blue fill back underwater so vertex colour and terrain
    // shape survive. Ambient below provides the cave readability floor.
    this.hemisphere.intensity = (1.1 * (1 - submergence) + 0.92 * submergence) * attenuation;
    this.hemisphere.color.copy(this.surfaceSkyColor).lerp(shallowWater, submergence * 0.72);

    // A slightly warmer/less saturated underside keeps rock and sand distinct
    // from the surrounding water without introducing another dynamic light.
    this.caveFill.copy(deepWater).lerp(shallowWater, 0.46);
    this.hemisphere.groundColor
      .copy(this.surfaceGroundColor)
      .lerp(this.caveFill, submergence * 0.72);

    this.ambient.color.copy(this.caveFill);
    this.ambient.intensity = 0.52 * submergence * attenuation;
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
