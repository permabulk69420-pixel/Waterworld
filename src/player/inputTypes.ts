/**
 * Device-independent movement intent.
 *
 * Both the XR controllers and the desktop keyboard/mouse produce one of these,
 * so the locomotion solver has exactly one code path to be correct in.
 * All axes are already deadzoned and clamped to -1..1.
 */
export interface MoveIntent {
  /** +1 = swim the way the head is pointing. */
  forward: number;
  /** +1 = strafe right. */
  strafe: number;
  /** +1 = ascend. */
  vertical: number;
  /** +1 = turn right (clockwise seen from above). */
  turn: number;
  /** 0..1 boost / sprint. */
  boost: number;
}

export function createMoveIntent(): MoveIntent {
  return { forward: 0, strafe: 0, vertical: 0, turn: 0, boost: 0 };
}

export function resetMoveIntent(intent: MoveIntent): MoveIntent {
  intent.forward = 0;
  intent.strafe = 0;
  intent.vertical = 0;
  intent.turn = 0;
  intent.boost = 0;
  return intent;
}
