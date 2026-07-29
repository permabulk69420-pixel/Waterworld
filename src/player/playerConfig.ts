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

  swimSpeed: 4.2,
  boostMultiplier: 1.9,
  verticalSpeed: 3.0,

  acceleration: 3.6,
  deceleration: 2.6,
  drag: 0.35,

  turnSpeedDegrees: 65,
  turnSmoothing: 12,

  moveDeadzone: 0.16,
  turnDeadzone: 0.22,

  headRelativeVertical: true,

  maxSubstepFraction: 0.7,
};
