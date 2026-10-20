# location_split_block — a block split into one scan mesh per vector footprint, as an agent tool

**Date:** 2026-10-19 · **Target:** in-app Gemini agent, tool `location_split_block` · **Status:** Verified (Haight & Ashbury block: 29 buildings; Puck Building block: 1 building, and 8 within 45 m)

## What it is
`packages/core/src/node/gemini/tools/location-evidence/split-block.ts` (pack `location-evidence-tools.ts`), geometry in `3d-engine/staged-location/block-split.ts`, GLB writer `glb-partition.ts`.

1. The place from the staged geocode cache; the buildings around it from `location_building_shape` (footprints joined across vector tiles, vector height, Solar DSM roof; `roofSegments: false`, up to 400 neighbours).
2. Which buildings: within `radiusM` of the place, or (no radius) the block that holds the place's building: the cells the Google vector road lines enclose around it (flooded through non-road cells within 130 m); without roads, the footprints touching it.
3. One extraction holding them all (staged extraction cache, at most 150 m), the canopy mask, the walkable ground model.
4. Per building, `pickStructure` with its vector footprint as the prior. Pick cells past the outline that lie in a raised mass no footprint holds (opened by the 2 m tolerance) are dropped; cells two picks share go to the nearer footprint. Buildings whose footprint disagrees with the scan (raised share, IoU under 0.3, edge of the extraction, no raised scan) are listed in `notSplit` with the reason and never forced.
5. Tree strip around the block with the owned cells kept (its removed triangles go to unassigned). Optional mask vote per building (`maskVote: true`; render, vision outlines, tile_refine isolate with ownership, SBOV votes move raised triangles across party walls).
6. Every triangle labelled: owned-cell walls and raised surfaces; walls in reach that face the building; walls above a roof to the neighbour whose roof they reach; nothing above a roof outside its cells; ground, trees, below-street surfaces and unowned raised scan unassigned. Small detached pieces go back to unassigned. One textured GLB (the scan's own materials and images) and one clay GLB per building, an unassigned pair, and a coloured overview mounted in the viewport.

Result `scratchbox.split-block/1`: `selection`, `extraction`, `buildings[]` (footprint traced + vector parts with holes, `iouWithScan`, heights vector/DSM/scan, ground, GLBs, `partyWalls[]` with segments in tile frame and lat/lng and `decidedBy` per segment, `exterior`, `boundaryDecidedByM`, `plausibility`), `notSplit[]`, `unassigned` (GLBs, triangles, surface, plan area, surface by kind, `unmappedStructures` with `footprintShare`), `partition` (`everyTriangleOnce`), `trees`, `maskVote`, timings, digest.

## Live results (worktree split-block, ports 3460/3461/3462)
| Place | Mode | Buildings split / not split | Owned area (vector) | IoU median (min–max) | Party walls | Unassigned (plan / surface) | Triangles | Tool time |
|---|---|---|---|---|---|---|---|---|
| corner of Haight St and Ashbury St, SF | block (roads do not close within 130 m: SF blocks are longer) | 29 / 0 | 7,823 m² (7,530) | 0.895 (0.50–0.975) | 35 | 85,192 m² / 215,013 m² | 320,484 in, 320,484 out, each once | 3.1 s (extraction cached; split stage 2.0 s; first run's split stage 3.8 s) |
| Puck Building, 295 Lafayette St | block (closed by roads, 3,302 m²) | 1 / 0 (it fills its block) | 2,288 m² (2,297) | 0.959 | 0 | 26,732 m² / 123,152 m² | 188,926, each once | 13.0 s (cold 73 m extraction) |
| Puck Building | radius 45 m | 8 / 0 | 4,454 m² (4,360) | 0.859 (0.698–0.959) | 5 | 25,668 m² / 113,881 m² | 195,547, each once | 5.7 s |

Boundary evidence (Haight block): vector-footprint 2,203 m of edge, height-jump 257 m, scan-geometry 206 m. Trees: 37 crowns (13,860 triangles) unassigned at Haight, 9 crowns at the Puck radius run. No plausibility warnings on any building. Puck radius run: one footprint (17/38594/49274/f38) has a vector height of 8.0 m against a DSM roof of 37.2 m and a scan roof of 41 m: its owned scan is part of a taller mass; reported side by side.

## Evidence
Screenshots in `test-results/screenshots/split_block/`: `live_haight_ashbury_viewport.jpg`, `live_haight_ashbury_result_card.jpg`, `live_puck_block_viewport_and_card.jpg`, `live_puck_r45_viewport_and_card.jpg`, and the synthetic renders (`terrace_melted_alley*.png`, `courtyard_block*.png`, `missing_footprint*.png`). Tests: `packages/core/test/location-split-block.test.ts`.

## Issues seen
- The viewport fits the whole overview GLB (the unassigned scan reaches the extraction edge) rather than the scene camera on the buildings; the vision check scored framing 68–72/100.
- Haight: the road flood reaches the 130 m limit, so the block is the open area reached within it (`block_not_closed` note).
- About 17,000 m² of scan surface at Haight lies more than 0.3 m below the street-level terrain (yards below street on the slope); flat surfaces there are unassigned, walls are judged by where they stand.

## Candidate Tool/Service Ideas
- An option to mount only the split buildings (not the unassigned surroundings) so the viewport frames the block.
- A road-graph block finder (polygonize the road network) instead of a raster flood with a radius limit.
