# Hand motor asset

Drop the generated reusable handheld underwater motor here as:

`hand_motor.glb`

Runtime path:

`./assets/player/motors/hand_motor.glb`

Expected orientation:
- real-world metres
- Y up
- origin at the hand grip / GripPoint
- local -Z = forward travel direction
- local +Z = exhaust direction
- root rotation 0,0,0
- root scale 1,1,1

The same GLB is cloned onto both tracked hands. The propulsion physics already uses each hand's live tracked orientation, so the visual can be uploaded later without changing locomotion code.
