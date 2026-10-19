# Structure isolation — the tree strip keeps the structure the pick decided; footprints larger than the structure

**Date:** 2026-10-19 · **Target:** `location_isolate_structure` (and `google_3d_tiles_get_clay` with `isolate: true`) · **Status:** Verified (St. Mark's fixed; Puck, Haughwout, Washington Square Arch unchanged)

## What was wrong
St. Mark's Church in-the-Bowery: the pick shrank from 967 m² (sizing, vector IoU 0.73) to 579 m² (IoU 0.54) between the sizing pick and the pick on the devegetated scan that tile_refine isolates. The vector footprint was not too large: 88.8% of it stands raised in the scan as downloaded. tile_vegetation's strip took the church's east aisle roof and walls (9–13 m, not canopy by the classifier) as the drape of a street tree beside it (stem 11.6, 5.2; apex 19.6 m) and opened the roof down to the street, so those cells read as open ground on the scan the isolate was made from. At Puck the strip also punched 5 m² of holes into the roof at 39–41 m.

## What changed
- `StripRoi.keep` (run-length cells, the canopy mask's encoding; `--roi-json`): the structure the caller isolates. tile_vegetation treats every triangle standing on those cells as architecture, so taking a tree out never takes the structure's roof or walls. `stats.json` reports `keepCells` and `keptStructureTriangles`.
- `structureKeepCells` (extraction-sizing.ts): the pick's core — cells raised at least to the low-attachment cut and not canopy. Low things the pick took at its foot (a shed, a crown the classifier missed) are not kept, so the strip can still find them to be trees. Passed by `location_isolate_structure` and the staged build.
- `pickStructure`: a vector footprint under half raised is still used when it encloses the structure (≥ 20% raised, ≤ 20% of the raised mass it holds reaches past it, other buildings' footprints aside). Then only the scan's raised cells are the structure; canopy inside the footprint is not promoted to building. The footprint record reports `openShare`, `canopyShare`, `enclosesStructure`; the tool's footprint reason and the run note give the shares.

## Live results (worktree picker-python, ports 3261/3262/3263, in-app agent, same session before and after)
| Place | Pick (before → after) | Vector IoU | Raised share | Final isolate (mask vote) area / IoU / precision / roofed |
|---|---|---|---|---|
| St. Mark's Church in-the-Bowery | 579 → 964 m² | 0.543 → 0.732 | 0.617 → 0.887 (open 0.001, canopy 0.112) | 855 m² / 0.644 / 0.785 / 0.926 → 1,350 m² / 0.713 / 0.881 / 0.899 |
| Puck Building | 1,876 → 1,886 m² | 0.891 → 0.891 | 0.886 → 0.888 | 2,525 m² / 0.739 / 0.838 / 0.933 → 2,618 m² / 0.720 / 0.829 / 0.941 |
| Haughwout Building | 659 → 659 m² | 0.885 → 0.885 | 1.0 | 917 m² / 0.719 / 0.822 / 0.912 (unchanged; the strip removes nothing there) |
| Washington Square Arch (headless) | 187 → 187 m² | — (scan geometry) | — | not re-run in the app |

Headless (`sizeExtraction` + strip + `pickOnScan`, the tool's own path) agrees: St. Mark's 579 → 964, Puck 1,876 → 1,886, Haughwout 659, the Arch 187 (strip removal unchanged, 6,450 triangles).

## Evidence
`test-results/screenshots/picker_python/`: `live_before_*` and `live_after_*` (chat result; `_3d` the isolate in the viewport, St. Mark's before in `live_before_st_marks.jpg`), `diag_before/` and `diag_keep/` (pick cells over the vector footprint, sizing and remesh scans). Tests: `packages/core/test/structure-isolation.test.ts` — a footprint enclosing a churchyard with trees beside a party-wall neighbour (fails on main: the footprint is rejected and the scan rule is used), a footprint drawn off the building still rejected, and the strip with keep cells (the real tile_vegetation binary).

## Issues seen
- The in-app Browser pane was hidden for most of the run, so screenshots were taken through a headless Chrome over CDP against the same server.
- The final mask-vote isolate for Puck moved within the vote's run-to-run spread (IoU 0.739 → 0.720) while its pick and vector IoU did not change.

## Candidate Tool/Service Ideas
- Report `keptStructureTriangles` in `location_isolate_structure`'s result, so a caller sees when the strip would have cut into the structure.
- A `staged_location_pick_preview` that renders the pick over the vector footprint (the `diag_*` images were hand-rolled).
