# Safe Shallows assets

Put the first seagrass test asset in this folder with this exact filename:

`tropical_seagrass_lush_animated.glb`

The runtime expects it at:

`./assets/biomes/safe-shallows/tropical_seagrass_lush_animated.glb`

The current seagrass system expects a Y-up model with its origin on the seabed and will use the `SeaGrass_Sway` animation clip when present. The supplied test GLB already matches those expectations.

## Ribbon-kelp biome edge

The Safe Shallows perimeter forest uses both of these opaque, low-poly patches:

- `alien_ribbon_kelp_patch_lowpoly_v1.glb`
- `alien_ribbon_kelp_patch_lowpoly_var_b_v1.glb`

`RibbonKelpForestSystem` shares their geometry and PBR materials across
chunk-sized `InstancedMesh` clusters. It scales the authored patches taller at
runtime and reads their `_SWAY` vertex attribute for GPU-only current movement.
The clusters retain standard frustum culling and are also hidden beyond the
short vegetation render radius.
