# SB-Roadie: road surfaces measured kerb to kerb from two Google sources

**Date:** 2026-10-21 · **Target:** staged location builds (`google_3d_tiles_get_clay`), the `roads` stage and the `sb_roadie` tool · **Status:** Verified on synthetic tiles (unit and orchestrator tests); not yet judged on a real place

## Why
A staged place's streets were only the photogrammetric scan: lumpy, with cars baked in, and the regrown trees sometimes stood in the carriageway (Plaza de Cibeles: a tree row's stems, read as the canopy-weighted centroid of crowns that overhang the street, landed on the road). Two real sources agree on where the streets are: Google's vector road centrelines say which lines are streets; the photo tiles say how wide and how high each one is.

## What it does (`packages/core/src/node/3d-engine/staged-location/road-surfaces.ts`)
1. Stations every 2 m along each centreline inside the extraction's cover. At each, a cross-section of the scan's surface model (0.5 m cells; tree canopy left out through the strip's canopy mask) out to 14 m each side.
2. **Kerbs:** the first sustained rise of ≥ 0.08 m over 0.75 m, placed where the ramp crosses half the rise. Found on both sides → the half-width is `measured`; none within reach (canopy, the scan's edge, a crossing) → 3.5 m and `vector-modelled`, said per station.
3. **Medians:** the centreline standing ≥ 0.08 m above both sides; its edges are the first half-drops outward; the carriageways run from the median to the kerbs and the median is never drivable.
4. **Levels:** the 20th percentile of the samples around five places across the carriageway (cars stand on the road, nothing stands under it), smoothed over three stations; measured camber, not a synthetic crown.
5. **Sidewalks:** from each measured kerb outward at the kerb's level until a building footprint, a further step, or 4 m.
6. **Mesh:** ribbons swept along the centrelines through the five levels (operator 1), vertical kerb faces, flat sidewalk strips; the crossing is built once (the longer street's quads win); lifted 0.04 m above the scan it was read from, so it draws over it (the scan's own road is not carved yet; see below).
7. **Texture:** the tile photo rendered from above (`top-down-photo.ts`: the photo-match rasteriser from a pinhole 3 km up, unlit, 0.1 m texels capped at 4096 px) embedded as a JPEG with planar UVs, so the colour is the photo's own.
8. **Trees:** before the trees are planted, a stem that the road measurement puts on a drivable carriageway is moved to the nearest spot off it within half its crown radius (its crown overhangs the street; the trunk leans toward the measured apex); one with no such spot is not planted and reported.

The layer is `l1r` (stage `roads`, order 2). Its label is `measured` when at least half the kerbs were found, else `vector-modelled`; both labels are listed, the note gives the counts. The texture pass leaves it alone (`selfTextured`).

## The tool
`sb_roadie` (`packages/core/src/node/gemini/tools/sb-roadie-tools.ts`): `action: "report"` reads the measurement back per street (length, median/min/max width, kerbs measured vs defaulted, medians, sidewalks); `action: "rebuild"` measures again with `kerbRiseM`, `defaultHalfWidthM`, `liftM`, `texelM`, `stationM` and replaces the scene's `l1r` layer. It reuses the staged run's tile extraction from the stage cache and needs the vector-tiles service account.

## Evidence
- `packages/core/test/staged-road-surfaces.test.ts` (5 tests): on a synthetic tile with an 8 m street, a 6 m crossing street and a 14 m boulevard with a 1.5 m median, kerbs are found at 4 ± 0.6 m / 3 ± 0.6 m with 70–90 % of stations measured (the gaps are the crossing and the canopy over one kerb), levels read −0.12 + 0.04 m, the median edges at 1.75 ± 0.5 m (the tile's 0.5 m cells), the median undrivable, the crossing built once, a stem on the road moved off it, the written GLB textured and the texel over the street dark and over the ground the ground colour.
- `packages/core/test/staged-location-orchestrator.test.ts`: with vector centrelines the stage commits a textured `l1r` layer on the synthetic district (flat ground → `vector-modelled`); without vector data it is skipped with the reason.
- Typecheck clean; the registry, drift and staged-tool tests pass.

## Known gaps (not done)
- The scan's own road triangles under the ribbon are not carved out; the ribbon stands 4 cm above them. Scan bumps taller than that can show through at grazing angles. (2026-11-03: with `SCRATCHBOX_STAGED_ROAD_KERBS=1` the streets are swept with kerbs and gutters and the scan is carved under them: [Kerbs and gutters as geometry](./2026-11-03-road-kerbs-and-gutters.md).)
- Width class from the vector feature types is not read (only the centreline is used); the default half-width is one number.
- Cars and shadows in the tile photo are in the texture, as they are in the tiles; the de-light pass does not run on it yet.
- Not yet judged by the photo-match judge on a real place.

## Candidate Tool/Service Ideas
- `location_carve_under_layer`: remove scan triangles under a committed layer's footprint within a height band (roads, plazas, water).
- Street furniture and lane markings read from the top-down photo (a measured marking layer), never generated.
