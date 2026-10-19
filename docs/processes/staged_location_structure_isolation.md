# Staged Location Builds — Structure Isolation (vector footprints, walkable terrain, one shared rule)

**Date:** 2026-10-18 · **Target:** `google_3d_tiles_get_clay` with `isolate: true` · **Status:** Verified (live builds; Pulteney Bridge falls back to the district)

## What changed
- **Terrain** (`buildGroundModel`, StreetViewSurveyPlanner.ts): measured on the walkable street surface (the open surface the most structure rises from, plus Google vector road cells), not a low percentile. Google vector water cells never join it.
- **Structure pick** (`pickStructure`, extraction-sizing.ts): the building footprint from Google vector data (vectortiles.featuretiles, `vector-footprints.ts`) under the place, when at least half of it stands raised in the scan, limits the pick to the scan's raised cells within 2 m of it (grown into the open only). Otherwise a geometric rule: a morphological opening scaled to the mass, then parts across height discontinuities. The result records `footprintSource` and the IoU with the footprint, and the run notes "footprint from Google vector data" or why not.
- **tile_refine** takes the pick (`--isolate-pick`, SBIP v1) instead of its own footprint rule, so the two cannot disagree; other masses and canopy stop its closure.
- **Check** (`checkIsolate`): the isolate must hold the seed, lie on the pick (70%), be roofed (60%) and cover half the pick. If it fails, the district is remeshed whole and shown, labelled `isolate_mismatch`, never fragments.
- **Trees** (`scratchbox_tile_vegetation.hpp`): a crown at roof level whose roof the scan replaced, over a hollow building, is kept as scanned (`raised_level_not_under_it`) and not regrown from the street.

## Live results (headless tool entry and the app, ports 3170/3171/3172, isolated worktree)
| Place | Before (main) | After | Source | Fit | Textures |
|---|---|---|---|---|---|
| Puck Building | 20,477 m², containment_failed | 2,066 m², isolated | vector footprint (IoU 0.84) | rejected by gates | tile photo transfer (rung 3) |
| St. Mark's Church in-the-Bowery | 13,161 m², containment_failed | 967 m², isolated | vector footprint (IoU 0.73) | rejected by gates | tile photo transfer |
| Haughwout Building | not surveyed | 694 m², isolated | vector footprint (IoU 0.87) | rejected by gates | tile photo transfer (rung 2) |
| Pulteney Bridge | 32,349 m², containment_failed | 216 m² pick; isolate grew to both shop rows → district fallback | scan geometry (no footprint) | — | — |
| Washington Square Arch | 187 m², isolated | 187 m², isolated | scan geometry | accepted | Street View projection; leave-one-pano-out chamfer 7.3 px (clay 8.6) on l2 |

## Candidate Tool/Service Ideas
- A `staged_location_pick_preview` tool that returns the pick (cells, source, IoU) and an ortho overlay without running the build. This replaces hand-rolled scripts.
- Bridge decks: recognise a walkable surface standing over water between two shop rows as part of one structure.
