/** Player rig, locomotion and comfort tunables. */
export interface PlayerConfig {
  /** Distance from the floor to the top of the collision capsule, in metres. */
  bodyHeight: number;
  /** Capsule radius. Wide enough not to snag, narrow enough for tunnels. */
  bodyRadius: number;

  /** Top swimming speed, m/s. */
  swimSpeed: number;
  /** Multiplier while boost is held. */
  boostMultiplier: number;
  /** Vertical (ascend/descend) speed, m/s. */
  verticalSpeed: number;

  /** How fast velocity approaches the target, per second. Higher = snappier. */
  acceleration: number;
  /** How fast velocity bleeds off when the stick is released, per second. */
  deceleration: number;
  /** Passive drag applied always, per second - stops endless coasting. */
  drag: number;

  /** Smooth turn rate, degrees per second. */
  turnSpeedDegrees: number;
  /** How fast the turn rate itself ramps, per second (kills stick snap). */
  turnSmoothing: number;

  /** Radial deadzone for the movement stick. */
  moveDeadzone: number;
  /** Deadzone for the turn axis. */
  turnDeadzone: number;

  /**
   * When true, forward follows the full head direction (look down, swim down),
   * which is how underwater movement reads best. When false, forward is
   * projected onto the horizontal plane.
   */
  headRelativeVertical: boolean;

  /** Maximum collision substep length as a fraction of the body radius. */
  maxSubstepFraction: number;
}

export const DEFAULT_PLAYER_CONFIG: PlayerConfig = {
  bodyHeight: 1.75,
  bodyRadius: 0.32,

  // Conservative first-pass VR speeds. It is much easier to increase these once
  // the controls feel right than to diagnose input while flying through the map.
  swimSpeed: 2.35,
  boostMultiplier: 1.5,
  verticalSpeed: 1.8,

  acceleration: 4.8,
  deceleration: 4.5,
  drag: 0.5,

  turnSpeedDegrees: 58,
  turnSmoothing: 14,

  moveDeadzone: 0.2,
  turnDeadzone: 0.24,

  headRelativeVertical: true,

  maxSubstepFraction: 0.7,
};
