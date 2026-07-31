# Terrain textures

Active shallow-terrain PBR set:

- `coast_land_rocks_01_diff_1k.jpg` — base colour / albedo (sRGB)
- `coast_land_rocks_01_nor_gl_1k.exr` — OpenGL normal map (linear)
- `coast_land_rocks_01_rough_1k.exr` — roughness map (linear)
- `coast_land_rocks_01_disp_1k.png` — height/displacement source (linear)

The current WebXR terrain material loads the EXR normal and roughness maps directly with Three.js `EXRLoader`, so no phone-side conversion is required.

The displacement map is currently used only for restrained micro-relief shading. It does **not** physically displace or tessellate the terrain mesh; that would be far too expensive for the standalone Quest terrain budget.

The old generated PBR sand texture set has been removed from the terrain material. These scanned maps are world-space projected onto shallow, upward-facing terrain and fade out on steep/deep surfaces.
