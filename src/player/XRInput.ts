import type { WebGLRenderer } from 'three';
import { applyDeadzone, clamp, deadzone1 } from '../math/mathUtils.ts';
import { createMoveIntent, resetMoveIntent, type MoveIntent } from './inputTypes.ts';
import type { PlayerConfig } from './playerConfig.ts';

/**
 * Quest controller input.
 *
 * Mapping (xr-standard gamepad):
 *   left stick   - forward / back / strafe, relative to where you are looking
 *   right stick  - smooth continuous turn (X only; Y is ignored on purpose so
 *                  it cannot fight the head-relative pitch movement)
 *   A / right    - ascend            B / right - descend
 *   right trigger- analog ascend     left trigger - analog descend
 *   either grip  - boost
 *
 * No hand or controller models are attached - that is a later pass. Input is
 * read straight from the WebXR gamepads, so nothing needs to be in the scene
 * graph for movement to work.
 */
export class XRInput {
  private readonly intent = createMoveIntent();

  /** Set when at least one controller reported a gamepad this frame. */
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
      const gamepad = source.gamepad;
      if (!gamepad) continue;
      this.connected = true;
      this.hands += this.hands ? `+${source.handedness}` : source.handedness;

      // xr-standard puts the thumbstick on axes 2/3; fall back to 0/1 for
      // controllers that only expose the legacy touchpad axes.
      const ax = gamepad.axes.length >= 4 ? gamepad.axes[2] : (gamepad.axes[0] ?? 0);
      const ay = gamepad.axes.length >= 4 ? gamepad.axes[3] : (gamepad.axes[1] ?? 0);

      const trigger = gamepad.buttons[0]?.value ?? 0;
      const grip = gamepad.buttons[1]?.value ?? 0;
      const primary = gamepad.buttons[4]?.pressed ?? false; // A / X
      const secondary = gamepad.buttons[5]?.pressed ?? false; // B / Y

      if (grip > 0.5) intent.boost = Math.max(intent.boost, grip);

      if (source.handedness === 'right') {
        // Turn only from the horizontal axis, with its own deadzone.
        intent.turn += deadzone1(ax, this.config.turnDeadzone);
        if (primary) ascend = 1;
        if (secondary) descend = 1;
        ascend = Math.max(ascend, trigger);
      } else {
        const [sx, sy] = applyDeadzone(ax, ay, this.config.moveDeadzone);
        intent.strafe += sx;
        intent.forward += -sy; // stick up is -1 in xr-standard
        // Mirror controls so either hand can drive vertical movement.
        if (primary) ascend = 1;
        if (secondary) descend = 1;
        descend = Math.max(descend, trigger);
        // Left thumbstick click toggles the in-headset debug panel.
        if (gamepad.buttons[3]?.pressed) debugToggle = true;
      }
    }

    this.debugTogglePressed = debugToggle && !this.debugToggleHeld;
    this.debugToggleHeld = debugToggle;

    intent.vertical = clamp(ascend - descend, -1, 1);
    intent.forward = clamp(intent.forward, -1, 1);
    intent.strafe = clamp(intent.strafe, -1, 1);
    intent.turn = clamp(intent.turn, -1, 1);
    return intent;
  }
}
