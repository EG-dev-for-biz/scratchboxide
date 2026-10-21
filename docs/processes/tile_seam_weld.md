# Staged Location Builds: Tile-Chunk Seam Weld (a native pre-pass before the wall-direction stages)

> **Recorded:** 2026-10-21.
> **Status:** Verified in the live app (the remesh stage runs it on every staged location, 14 ms on a 25 m isolate) and measured on the Haughwout Building; the direction vote it was meant to protect turned out not to be skewed by the seams (see §3), the seam gaps themselves are closed.
> **Tags:** `operate-scratchbox` `staged-build` `tile-refine` `scan-rectifier` `measured`
> **Target Domain:** Real-world 3D locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. What it does

Adjacent Google 3D Tiles chunks do not share vertices. On a leaf-LOD extraction their borders sit 1-3 cm apart (position quantisation differs per chunk), so every stage that reads adjacency, planes or directions out of the scan sees each wall cut into chunk-sized pieces along those lines. `scratchbox_tile_seam_weld.hpp` closes those gaps as the very first thing `tile_refine` does to a loaded scan, before isolation, the raw clay write (what `scan_fit` reads) and `scan_rectifier`'s own D4 orientation vote.

1. **Position groups.** Vertices at the same position (bit-identical float3) are one group. The GLB reader splits a chunk into UV islands, and a chunk's own skirt shares the chunk's border vertices, so a border point is usually several vertex ids. A group moves as one: a weld never tears a chunk away from its own skirt or UV neighbour. (The first version of the kernel moved single vertices; on Haughwout that found 3,215 moves and 196,540 "contacts" of which 97 % were a vertex and its own coincident twin, so most real seam partners were hidden behind a zero-distance twin.)
2. **Pieces.** Connected components of groups through triangle edges: a chunk with all its islands and skirts is one piece. Haughwout's 79 m extraction (85 primitives, 198,710 triangles) is 222 pieces; the live 25 m isolate is 44.
3. **Strip pieces.** A piece every triangle of which is a sliver (altitude ≤ the tolerance, aspect ≥ 4) is a strip no wider than a seam: dropped whole, not repositioned (1 such piece, 1 triangle, on the 79 m extraction).
4. **Contacts and the weld.** For every boundary group (an edge used by exactly one remaining triangle), the nearest boundary group of a *different* piece within the tolerance (0.03 m; the same figure `scan_rectifier`'s D8 already calls closeable). Of a pair, the group of the higher piece id moves onto the other group's original position; targets are read from original positions, so welds never cascade. Where three pieces meet, a short target chain is followed while the total move stays within the tolerance (59 chained welds on the 79 m extraction).
5. **Guard.** A move that would turn a kept triangle inside out is taken back and counted (0 on both real inputs; the synthetic test exercises it).
6. **Slivers.** A triangle a move touched whose remaining altitude is ≤ 0.5 × tolerance and aspect ≥ 4 is dropped: the strip that bridged the gap collapses when the gap closes. Measured on the 79 m extraction: 2 dropped at fraction 0.5, 23 at 1.0, 220 at 2.0 (the extra ones are ordinary thin geometry that merely touches a seam), so 0.5 stands.

Every tolerance is a continuous metric; the file knows nothing about buildings, tiles or skirts.

**Where it runs (the live call path, confirmed in the app's own cache entry).** `orchestrator.ts` → `remesh` stage → `TileRefineService` → `scripts/tile_refine.cpp` → `TileRefine::runFile`, whose stage list is now `load → seam_weld → isolate → write_raw_clay → visibility → rectify (scan_rectifier D1…D8) → facade_flatten → proud_feature_audit → relief → write`. The pipeline-E path that the app runs today skips `scan_fit`'s fit stage, but `scan_fit` (when used: `fit`, `flatten`) reads `raw_clay.glb`, which is written after the weld. `glb-geometry-patcher.ts` only applies SBRX sidecars; it estimates nothing. The kernel is also available on its own: `scripts/tile_seam_weld.cpp` (textured and clay GLB out, JSON stats, `--contacts-csv` for inspection) behind `TileSeamWeldService` (`tile-seam-weld-service.ts`, built through the native build cache). `TileRefineRequest.seamWeld` turns it off or sets the tolerance; `--no-seam-weld` / `--seam-weld-tolerance` on the CLI.

## 2. Measured seam characteristics (Haughwout Building, 488 Broadway)

Leaf-LOD extraction `e_v_haughwout_building_488_broadway_new__40.72181_-73.99949_r79_textured.glb` (79 m, 240,205 vertices, 198,710 triangles, 85 primitives):

| | |
|---|---|
| distinct positions / pieces | 112,306 / 222 |
| boundary groups | 45,129 |
| cross-piece contacts within 4 cm | 8,630, **all** in the 1-3 cm bucket (histogram `[0, 0, 0, 8630, 0, 0]` over `[0, 1 mm, 5 mm, 1 cm, 3 cm, 10 cm)`) |
| gap | mean 1.57 cm, max 2.21 cm (the quantisation step of the tile positions) |
| groups / vertices welded | 4,350 / 6,012; 59 through a chain; 0 reverted |
| dropped | 1 strip piece (1 triangle) + 2 collapsed = 3 triangles |
| cost | 54-58 ms (10 threads) |

Thin triangles (aspect ≥ 8, altitude ≤ 3 cm) in the raw isolate: 328 of 51,259, and no more of them next to seams than elsewhere. The "thin vertical sliver strips along the seams" the report describes are not in the raw tiles; they appear downstream (§3).

The live 25 m isolate the app actually processed (`devegetated.glb`, 30,659 triangles → 8,017 kept): 44 pieces, 990 contacts, 498 groups / 684 vertices welded, mean 1.56 cm, max 2.20 cm, 0 dropped, 14 ms.

## 3. Before / after

Same binary, `--no-seam-weld` against the default, same arguments. "raw clay" is what `scan_fit` reads; "output" is the textured result after rectify, flatten (and relief on the 79 m runs).

| measure | 79 m, isolate (51 k tris) | 79 m, whole tile (199 k) | live 25 m isolate (8 k), app arguments |
|---|---|---|---|
| raw clay: boundary near-gaps ≤ 3 cm (vertex-vertex) | 2,172 → **71** (−97 %) | — | 356 → **24** (−93 %) |
| raw clay: distinct positions | 29,189 → 28,148 | 112,306 → 107,956 | 4,671 → 4,501 |
| rectifier D8 seam contacts (its own count) | 2,929 → 2,312 | 12,161 → 9,463 | 545 → 346 |
| rectifier contacts in [1 cm, 3 cm) before D8 | 1,563 → 993 | 6,474 → 4,017 | 320 → 121 |
| flatten T-junctions | 3,031 → 2,179 | 11,677 → 8,682 | 600 → 289 |
| flatten groups merged by position | 25 → 10 | 131 → 48 | 7 → 0 |
| **D4 orientation families (azimuth °, weight)** | 32.692/1892, 38.672/600, 44.491/364, 24.354/338 → 32.693/1892, 38.671/600, 44.491/364, 24.354/338 | 32.673/8597 → 32.674/8597 | 31.39/128, 0.14/80, 44.82/68 → 31.39/128, 0.18/82, 44.82/68 |
| rectifier wall regions | 43 → 42 | 169 → 170 | 11 → 11 |
| flatten planes | 26 → 24 | 51 → 53 | 5 → 5 |
| proud-feature audit: planes / features | 31 / 407 → 30 / 395 | 50 / 1162 → 50 / 1149 | 3 / 24 → **1 / 10** |
| output: near-gaps ≤ 3 cm | 387 → 159 | 1,951 → 549 | 260 → 62 |
| output: thin triangles (aspect ≥ 8, alt ≤ 3 cm) | 2,707 → 2,621 | 7,776 → 8,130 | 100 → 93 |
| rectifier guard reverts | — | — | 388 → 273 |
| wall time | 1,471 → 1,452 ms | 4,832 → 5,215 ms | 402 → 420 ms |

What this says, plainly:

- **The seams are closed.** 93-97 % of the vertex-vertex near-gaps in the raw clay are gone; the rectifier's own seam stage has a third fewer contacts to solve and the flatten stage a third to a half fewer T-junctions.
- **The direction vote was not being skewed by them.** `scan_rectifier`'s D4 families are identical to 0.01° before and after, on all three inputs, and its wall-region count does not move. The report's premise ("the measured cause of … the wall-direction estimate being skewed") does not reproduce on this building: 1-3 cm offsets between chunks are far below what a 1 m-edge triangle's normal notices. The pre-pass is still the right place for a seam fix, it just does not change that number.
- **The sliver strips are made downstream, not by the tiles.** Thin near-vertical triangles on the isolate: 208 in the raw scan, 318 after rectify alone, 372 after flatten, 2,049 after relief (window reveals are legitimately thin). The pre-pass trims the rectifier's share slightly (318 → 303) and cannot touch the rest.
- **One real downstream change the numbers do not explain on their own:** on the live 25 m isolate the proud-feature audit (`detectWallPlanes` on the raw scan) finds 1 plane / 10 features instead of 3 / 24. The flatten planes of the same run are unchanged (5, none a near-duplicate of another), so this is the raw-scan density-mode detection seeing fewer modes once the chunks coincide; whether the two planes it no longer finds were the same wall split by a seam is not proven here (the audit does not list its planes).
- **What vertex-to-vertex cannot do:** a border vertex whose partner is the *interior of a foreign edge* (a T-junction, the rectifier's D8 case) is not moved; 71 near-gaps remain on the isolate. Where the two chunks' border tessellations differ, snapping B's vertices onto A's nearest vertices leaves sub-millimetre wedges between the welded points (visible as a 1-px line at a 0.37 m-wide close-up, §4). Splitting the foreign edge would fix both and is the next step if it matters; it changes topology, which this pass deliberately does not.

`scan_fit` was not compared with its live footprint prior: the app's pipeline-E path skips the fit stage, and without a prior `scan_fit` keeps only the anchor's tile piece, so an unwelded run fits one chunk (2,432 triangles, 4 primitives) and a welded run the whole building (51,299 triangles, 206 primitives), which is not a like-for-like pair. (A previous session read that pair as "the weld fragments the fit"; it is the component selection, not fragmentation.)

## 4. Screenshots (`test-results/screenshots/tile_seam_weld/`, copies in the session scratchpad)

- `app_haughwout_staged_after_weld_live.jpg` — the live app (branch build, ports 3210-3212) staging Haughwout with the weld in the remesh stage; textured, facade grammar running. Console: one pre-existing 403 from the viewport's streamed `tile.googleapis.com/v1/3dtiles/root.json` (the TilesRenderer context layer; not this change).
- `south_facade_before_raw_clay_fov40.jpg` — the raw clay the app produced (`live_off`), south facade; the chunk seam runs through x = 4.
- `seam_south_x4_{before,after}_raw_clay_fov6.jpg` — the same seam at a 0.6 m-wide close-up: indistinguishable (the offset at this seam is along the wall; 0 background pixels show through in either).
- `seam_east_zm5_{before,after}_{wire_fov8,raw_clay_fov3}.jpg` — the z = −5 seam: before, two border polylines ~1.5 cm apart (wire view); after, one, with the sub-millimetre wedge of §3 visible as a thin line at the 0.37 m close-up.

## 5. Tests (`packages/core/test/tile-seam-weld.test.ts`, 5 tests, 6.6 s; the driver compiled by the test)

1. A 2 cm gap between two wall chunks: 14 contacts, exactly one side's 7 border points move 0.020 m onto the other's, nothing else moves, 96 triangles in and out, the texture and UVs pass through, the output is a GLB.
2. A separate 1.8 cm strip lying in the seam: dropped whole (1 piece, 12 triangles), then the walls weld (7 moves); no point left in the gap.
3. Distinct nearby surfaces: a parallel patch 5 cm in front, a shelf whose edge stands 1 cm in front of the wall's interior, a closed box 1 cm away — 0 contacts, 0 moves, every input position still present.
4. A move that would turn a kept triangle: reverted (1), the other 6 welds stand.
5. Dropping off keeps the strip (14 moves, 108 triangles); a 1 cm tolerance sees the 14 contacts and moves none; tolerance 0 and a missing input are `bad_request`.

Also run: every tile-refine, scan-rectifier, scan-fit, facade-grammar and staged-remesh suite (all pass; `tile-refine.test.ts` skips without its asset). `npm run typecheck`, `npm run lint`, `npm run lint:primitives` clean (typecheck needs `desktop-app/node_modules/electron` reachable from a worktree).

## 6. Candidate Tool/Service Ideas

- **T-junction closure in the pre-pass** (split the foreign edge at the snapped point): would take the remaining 71 near-gaps on the isolate and the wedges of §3; needs a topology change and a test that the split keeps UVs.
- **Proud-feature audit plane list in `stats.json`**: without it the 3 → 1 plane change on the live input cannot be attributed (same wall split by a seam, or two walls lost).
- **A seam-contact overlay in the viewport's provenance view** from `--contacts-csv`: the app has no way to show where chunks meet.
