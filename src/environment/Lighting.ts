import { AmbientLight, Color, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three';

/**
 * Scene lighting.
 *
 * Two lights only - one directional "sun" and one hemisphere fill. No shadow
 * maps and no point lights: on standalone Quest every extra dynamic light is
 * paid for on every terrain vertex, and none of them would survive the fog
 * anyway. Underwater the sun is attenuated and the fill takes over, which is
 * both cheap and roughly what actually happens underwater.
 */
export class Lighting {
  readonly root = new Group();
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  /**
   * Underwater fill. Ambient light is constant irradiance rather than a
   * per-fragment dynamic light, so it costs nothing extra on Quest, and it is
   * the only thing that keeps the inside of a cave legible without shadows or
   * local lights.
   */
  readonly ambient: AmbientLight;
  readonly sunDirection = new Vector3(0.4, 0.85, 0.28).normalize();

  private readonly surfaceSunColor = new Color(0xfff2dc);
  private readonly deepSunColor = new Color(0x9fd0dd);
  private readonly surfaceSkyColor = new Color(0xa9c6d4);
  private readonly surfaceGroundColor = new Color(0x8c8570);
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
    // Light falls off with depth; keep a floor so deep water stays readable.
    const attenuation = 1 - 0.55 * depthT;

    this.sun.intensity = (2.4 * (1 - submergence) + 1.35 * submergence) * attenuation;
    this.sun.color.copy(this.surfaceSunColor).lerp(this.deepSunColor, submergence);

    this.hemisphere.intensity = (1.1 * (1 - submergence) + 1.7 * submergence) * attenuation;
    this.hemisphere.color.copy(this.surfaceSkyColor).lerp(shallowWater, submergence);

    // With no shadows and no point lights, the hemisphere's ground colour is
    // the *only* light reaching a downward-facing surface - so it alone
    // decides how readable cave ceilings and overhangs are. Straight
    // `deepWater` renders them black; lifting it toward the shallow tint keeps
    // caves moody but navigable, which is what this pass needs.
    this.caveFill.copy(deepWater).lerp(shallowWater, 0.7);
    this.hemisphere.groundColor
      .copy(this.surfaceGroundColor)
      .lerp(this.caveFill, submergence * 0.9);

    this.ambient.color.copy(this.caveFill);
    this.ambient.intensity = 1.15 * submergence * attenuation;
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
