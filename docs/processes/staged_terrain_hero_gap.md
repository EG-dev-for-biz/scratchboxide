# The surrounding terrain leaves a clear gap around the tiles' ground

**Date:** 2026-10-21 · **Status:** Verified (offline measurement on a real extraction, unit tests, live build)

## The problem

The surrounding terrain (`terrain-surround.ts`, a Google Elevation API heightfield out to 4 km) left out only the
triangles whose **three** corners all lay within `coveredRadiusM − 25 m` of the place. Two things made that ring
overlap the tiles' own ground:

- Leaf tiles are kept whole (atomic building integrity), so the tiles reach past the covered radius by up to a leaf.
- On the 50 m inner grid, a triangle with one corner outside the disc survived with its other two corners on the
  tiles' ground.

Two ground surfaces then shared the same patch of ground and fought there (interleaving, flicker at the tile edge).

Measured on the Plaza de Cibeles extraction as published (`public/models/plaza_de_cibeles_madrid_tiles_168476aa.glb`,
1,153,433 vertices, farthest 296 m from the place; terrain `..._terrain_a9b34932.glb`, 12,692 triangles): **46
terrain vertices on the tiles' ground, nearest 0 m**.

## The fix (`c0e57ea1`)

The hole is the ground the tiles **actually occupy**, measured from the extraction's own vertices
(`coverageHoleFromGlb` on the geometry GLB, 10 m ground cells), grown by a continuous gap
(`TERRAIN_HERO_GAP_M = 15`, `SCRATCHBOX_TERRAIN_HERO_GAP_M` overrides it, never negative), and a terrain triangle is
left out when **any** corner or its centre lies in the hole. The hole follows the tiles' real outline, not a disc:
where the tiles do not reach, the terrain still does. `radialHole(radiusM, gapM)` remains for callers that only have
a radius (a plain number still works), with the same any-corner rule.

The stage key is `terrain/v2` (keyed on the extraction key and the gap, so an old cached terrain is never reused);
the GLB extras (`sbTerrain.hole`) and the stage's commit record the hole's measurements (`kind`, `cellM`, `gapM`,
`tileVertices`, `occupiedCells`, `coveredCells`) and `heroGapM`.

## Measured

| | triangles | terrain vertices on the tiles' ground | within 15 m | nearest |
|---|---|---|---|---|
| before (disc, all-corner rule) | 12,692 | 46 | 62 | 0 m |
| after (coverage hole + 15 m gap, any-corner rule) | 12,539 | 0 | 0 | 26 m |

(scratch: `terrain-gap-measure.ts`, 2 m occupancy of the tile vertices; terrain vertices within 100 m of the
tiles' reach.) The live build reproduced this: the terrain stage committed `l0 12539 tris` in 3.2 s, and in the
viewport (`__SB_3D_SCENE__`), against the district remesh (819,732 vertices, x −265…260, z −272…262): **0 terrain
vertices on the district ground, nearest 26 m** (144 terrain vertices checked within 450 m).

A test shows why a disc cannot do this: for a 100 × 200 m block of tiles offset east of the place, a disc reaching
the block's far corner removes more than 1.5× the terrain the coverage hole does, all of it west of the place where
there are no tiles.

## Screenshots

`test-results/screenshots/terrain_gap/` (gitignored): `01_plaza_de_cibeles_far_terrain_island.jpg` (the district on
the terrain, zoomed far out), `02_plaza_de_cibeles_street.jpg`.

## Verification

- `packages/core/test/staged-terrain-surround.test.ts` (5, two new), `terrain-ground-snapping` (2), and the staged
  suites that fake the Elevation API (`staged-into-active-scene`, `staged-texture-viewport-lighting`,
  `staged-tile-extraction`, 10) pass with credentials unreachable. `staged-fast-first` has one pre-existing failure
  in `tileRefineTwin` rung shares (texture pass), untouched by this change.
- `npm run typecheck`, `npm run lint` (0 errors), `npm run lint:primitives` clean.
- Live: own launch entry `scratchbox-terrain-gap` (3920-3922) on the main checkout, "Stage Plaza de Cibeles, Madrid";
  no console errors.

## Candidate tool/service ideas

- A viewport probe that reports, per staged layer pair, the nearest distance between two ground surfaces (the
  check above was hand-rolled in `javascript_tool`); `?sbViewportCost=1` is the natural home.
