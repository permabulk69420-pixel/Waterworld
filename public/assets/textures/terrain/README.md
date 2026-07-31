# Terrain textures

Drop the replacement Safe Shallows terrain PBR textures directly in this folder.

## Current replacement set

Use these exact filenames:

- `coast_land_rocks_01_diff_1k.jpg` — base colour / albedo
- `coast_land_rocks_01_nor_gl_1k.png` — OpenGL normal map
- `coast_land_rocks_01_rough_1k.png` — roughness map
- `coast_land_rocks_01_disp_1k.png` — displacement / height map (optional for the first pass, but keep it here)

The source normal and roughness textures are EXR files. Convert those two EXRs to PNG before uploading; do not change their colour/data values while converting.

Do not upload the `.blend` file for runtime use.

Once all three required runtime maps (diffuse, normal, roughness) are present, `src/environment/TerrainMaterial.ts` should be changed to load this set and the current procedurally-generated sand PBR textures should be removed completely.

The terrain mesh has no authored UVs, so the replacement texture set should continue to use world-space projection / tiling across streamed terrain chunks.

The displacement map is intentionally not required for true geometry displacement on Quest. It can later be used for subtle material/parallax/detail work if useful without tessellating the terrain.
