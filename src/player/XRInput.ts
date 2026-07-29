import type { WebGLRenderer } from 'three';
import { applyDeadzone, clamp, deadzone1 } from '../math/mathUtils.ts';
import { createMoveIntent, resetMoveIntent, type MoveIntent } from './inputTypes.ts';
import type { PlayerConfig } from './playerConfig.ts';

/**
 * Quest controller input.
 *
 * Base mapping:
 *   left stick   - swim forward/back and strafe
 *   right stick  - smooth turn (horizontal axis only)
 *   A / X        - ascend
 *   B / Y        - descend
 *   triggers     - temporary analog vertical fallback until hand motors load
 *
 * Once the optional hand-thruster asset is available, triggerVerticalEnabled is
 * disabled and each trigger is reserved for its own tracked-hand motor instead.
 */
export class XRInput {
  private readonly intent = createMoveIntent();
  private triggerVerticalEnabled = true;

  /** Set when at least one usable left/right controller reported a gamepad. */
  connected = false;
  /** Which hands were seen this frame, for the debug HUD. */
  hands = '';
  /** True for one frame when the left thumbstick is clicked. */
  debugTogglePressed = false;
  private debugToggleHeld = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly config: PlayerConfig,
  ) {}

  /** Reserve/release the analog triggers for another locomotion system. */
  setTriggerVerticalEnabled(enabled: boolean): void {
    this.triggerVerticalEnabled = enabled;
  }

  poll(): MoveIntent {
    const intent = resetMoveIntent(this.intent);
    this.connected = false;
    this.hands = '';
    this.debugTogglePressed = false;

    const session = this.renderer.xr.getSession();
    if (!session) return intent;

    let ascend = 0;
    let descend = 0;
    let debugToggle = false;

    for (const source of session.inputSources) {
      // Ignore transient/gaze/unknown sources entirely. Only the actual tracked
      // left and right controllers are allowed to drive locomotion.
      if (source.handedness !== 'left' && source.handedness !== 'right') continue;

      const gamepad = source.gamepad;
      if (!gamepad) continue;

      this.connected = true;
      this.hands += this.hands ? `+${source.handedness}` : source.handedness;

      // xr-standard reserves axes 2/3 for the primary thumbstick. Controllers
      // using a non-standard mapping occasionally expose only one axis pair, so
      // retain a conservative 0/1 fallback for those devices only.
      const useStandardStick = gamepad.mapping === 'xr-standard' || gamepad.axes.length >= 4;
      const ax = useStandardStick ? (gamepad.axes[2] ?? 0) : (gamepad.axes[0] ?? 0);
      const ay = useStandardStick ? (gamepad.axes[3] ?? 0) : (gamepad.axes[1] ?? 0);

      const trigger = gamepad.buttons[0]?.value ?? 0;
      const primary = gamepad.buttons[4]?.pressed ?? false; // A / X
      const secondary = gamepad.buttons[5]?.pressed ?? false; // B / Y

      if (source.handedness === 'right') {
        // Right controller is turn + upward controls only. Vertical stick input
        // is intentionally ignored so accidental diagonal stick motion cannot
        // add translation.
        intent.turn = deadzone1(ax, this.config.turnDeadzone);
        if (primary) ascend = 1;
        if (secondary) descend = 1;
        if (this.triggerVerticalEnabled) ascend = Math.max(ascend, trigger);
      } else {
        // Left controller is translation only.
        const [sx, sy] = applyDeadzone(ax, ay, this.config.moveDeadzone);
        intent.strafe = sx;
        intent.forward = -sy; // xr-standard: stick up reports negative Y

        if (primary) ascend = 1;
        if (secondary) descend = 1;
        if (this.triggerVerticalEnabled) descend = Math.max(descend, trigger);

        if (gamepad.buttons[3]?.pressed) debugToggle = true;
      }
    }

    this.debugTogglePressed = debugToggle && !this.debugToggleHeld;
    this.debugToggleHeld = debugToggle;

    intent.vertical = clamp(ascend - descend, -1, 1);
    intent.forward = clamp(intent.forward, -1, 1);
    intent.strafe = clamp(intent.strafe, -1, 1);
    intent.turn = clamp(intent.turn, -1, 1);
    intent.boost = 0;
    return intent;
  }
}