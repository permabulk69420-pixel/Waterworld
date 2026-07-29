# VR hand assets

Drop player hand models here.

Preferred layout:

- `left_hand.glb`
- `right_hand.glb`

Keeping left and right hands separate makes controller attachment, grip offsets,
materials and later hand-specific interaction/animation easier to manage.

If the source tool exports both hands in one model instead, use:

- `vr_hands.glb`

and we can split or address the named nodes when the loader is wired.

## Model expectations

- Real-world scale in metres.
- Neutral/open relaxed hand pose unless the asset already includes a useful rig.
- Local hand origin should ideally sit around the wrist/controller attachment point.
- Root transform: rotation `0,0,0`, scale `1,1,1` when possible.
- Keep textures embedded in the GLB for now unless there is a reason to share them.

The runtime loader/controller attachment code belongs in `src/player/`; these files
are assets only. Environment props and biome vegetation should not go in this folder.
