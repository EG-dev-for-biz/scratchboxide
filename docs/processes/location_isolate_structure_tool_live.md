# location_isolate_structure — the staged-location structure isolation as one agent tool

**Date:** 2026-10-19 · **Target:** in-app Gemini agent, tool `location_isolate_structure` · **Status:** Verified (Puck Building and St. Mark's isolated; Pulteney Bridge falls back to the district with isolate_mismatch)

## What it is
`packages/core/src/node/gemini/tools/location-evidence/isolate-structure.ts` runs the isolation path `google_3d_tiles_get_clay` runs with `isolate: true`, through the same functions and the same staged caches, and stops after the remesh:
`sizeExtraction`/`pickStructure` (vector footprint prior, walkable-surface ground, canopy mask) → tile_vegetation strip around the structure → `pickOnScan` → tile_refine `--isolate-pick` (+ the multi-view mask vote when a vision model is configured) → `checkIsolate` → the district, remeshed whole, on any mismatch. The picker is called, not changed.

Input: `query` and/or `lat`+`lng`, optional `target` (what the vision model outlines), `trees`, `relief`.
Output (`scratchbox.isolate-structure/1`): `outcome` (`isolated` | `containment_failed` | `district_fallback` | `failed`) with `reasonCode`/`reason`; `structure` (textured, clay, raw clay GLBs under /models); `district` on fallbacks; `footprint` (traced polygon in the tile frame and lat/lng, holes, area, `source` vector-footprint | scan-geometry | mask-vote, `iouWithScan`, the vector footprint record, the mask vote, the isolate check); `ground` (height, ellipsoidal height, `walkable-surface` | `low-percentile`, vector roads); `kept` / `removed` (each with `areaKind` plan | surface and a reason code); `rooftopCanopyKeptAsScanned`; timings. It mounts the isolate and its clay twin (or the district) in the viewport.

## Live results (worktree tool-isolate, ports 3250/3251/3252, after merging the TRIANGLE_FAN decoder fix 56cc5fd1)
| Place | Outcome | Pick source | Vector footprint IoU (before fix → after) | Pick area (before → after) | Final source / IoU with scan | Ground | Time |
|---|---|---|---|---|---|---|---|
| Puck Building | isolated | vector-footprint (1,681 m², 88.6% raised) | 0.84 → 0.891 | 2,066 → 1,876 m² | mask-vote, 2,623 m², IoU 0.715 (precision 0.82, recall 1.0, roofed 0.93) | walkable-surface y 0.27 m | 60 s cold, 1.2 s cached |
| St. Mark's Church in-the-Bowery | isolated | vector-footprint (998 m²) | 0.73 → 0.543 | 967 → 579 m² | mask-vote, 840 m², IoU 0.652 (precision 0.79, recall 0.99) | walkable-surface y −1.03 m | 49 s |
| Pulteney Bridge | district_fallback (isolate_mismatch: 62% of the isolate on the pick, 354 vs 216 m²) | scan-geometry (no footprint within 10 m) | — | 216 m² | — | walkable-surface y 9.09 m | 47 s |

Puck: 8 rooftop crowns (90.5 m²) kept as scanned (`raised_level_not_under_it`); the neighbouring block past the party wall removed (`outside_vector_footprint`, 208 m contact). St. Mark's: the corrected footprint (998 m²) is larger than what the scan shows raised within it, so the pick is smaller and the vector IoU lower than with the buggy decoder; the mask vote then joins 3 clusters back.

## Evidence
Screenshots in `test-results/screenshots/tool_isolate/` (live_*.jpg, and the synthetic test renders). Tests: `packages/core/test/location-isolate-structure.test.ts` (real tile_refine and tile_vegetation binaries on synthetic scans).

## Issues seen
- The first Puck scene carried a `geoAnchor`, so the viewport tried to stream Google tiles in the browser and got 403; the scene no longer sets it.
- The vision check rated the first framing 58/100 (clay twin offset by the footprint, not the mesh); it is now placed by the GLB bounds.

## Candidate Tool/Service Ideas
- A `structure` argument taking a pick seed (x, z) so a caller can isolate the second building at a place without re-geocoding.
- Report the mask vote's clusters in plan area as well as triangle surface (tile_refine's stats give only surface).
