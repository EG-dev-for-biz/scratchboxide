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

## 7. The seam stage on the extraction (2026-10-28)

**Status: Measured offline on the Washington Square Park extraction; not yet verified in a live build.**

The weld now runs on the tile extraction as it arrives, before any stage reads it (orchestrator, `deps.tileSeams` → `runTileSeamWeld`, cached beside the extraction as `textured_tile_seams_2.glb`, `geometry_tile_seams_2.glb` and `seams_tile_seams_2.json`; `SCRATCHBOX_TILE_SEAMS=0` off). Every stage, the tiles layer shown included, reads the welded files, and the tiles key carries the stage's version. `weld-tiles.ts` (a 1 cm weld for the shown clay only) is retired. Two passes were added to `scratchbox_tile_seam_weld.hpp`:

- **Overlap trim** (`trimOverlaps`, before the weld): a border triangle whose probes all lie within 3 cm of a lower piece's surface facing the same way is dropped, ring by ring.
- **T-junction closure** (`closeTJunctions`, after the weld): a border position on the interior of another piece's border edge, within 3 cm, moves onto it and that edge's triangle is split there (UVs interpolated). Which piece a position or edge belongs to is taken before the weld joins pieces. In a round only the higher piece's positions move (as in the weld); the lower piece's points are split into the moved edges the next round without moving. A move onto an edge whose ends move waits a round. A move that would turn a triangle inside out is taken back.

Census (`seams.ts` in the session scratchpad, by tile material: 689 tiles, 1.62 M triangles), raw extraction against the stage's output:

| | raw | seam stage |
|---|---|---|
| gaps 0.1 mm–3 cm | 119,088 | 2,472 |
| T-junctions within 3 cm | 35,120 | 4,721 |
| steps 1–3 cm | 99,394 | 43,615 |
| gaps 3–50 cm | 148,191 | 147,600 |
| overlap (two tiles' up-facing surfaces within 1 m) | 10,911 m² | 10,309 m² |

The stage: 51,550 positions welded (largest move 2.2 cm), 24,918 T-junctions split (largest move 3.0 cm, 20 reverted), 640 m² of overlap trimmed, 1,619,782 → 1,642,565 triangles, 55 s.

What it does not close: gaps over 3 cm (tree crowns and roofs against the ground tiles), and most overlap. The trim only drops triangles lying wholly over the other tile, and most overlapping strips are crossed by larger, partly covered triangles. Closing those needs a cut along the other tile's rim. Steps, grooves and colour jumps across seams are not touched yet.

Tests: `tile-seam-weld.test.ts` adds interleaved border points closed into each other's edges (no seam edge left open; 6 splits) and the overlap trim (a 10 cm column lying 1 cm over the neighbour dropped, then welded).

## 8. Seam audit by source tile, adaptive close and strip fill (tile-seams/4, 2026-11-05)

**Status: measured offline on three extractions and in uncached benchmark builds (ESB, Penn 2). The audit always runs; the adaptive close and strip fill are off by default (`SCRATCHBOX_TILE_SEAM_ADAPTIVE=1` on).**

What was added (`scratchbox_tile_seam_weld.hpp`, `scripts/tile_seam_weld.cpp`, `tile-seam-weld-service.ts`):

- **Source tiles.** Each triangle's tile (its node's leaf id; the reader now keeps each triangle's glTF node) is carried through every pass. The crawler writes each leaf's stated geometric error into its node (`extras.sb.tile.geometricErrorM`); the service passes node → tile and error to the CLI (`--tiles`).
- **Seam audit** (`auditSeams`): open edge length inside the extraction's cut border (an edge whose plan neighbourhood, 2 m, has a cell no triangle covers is the cut, not a seam), by the gap from its midpoint to the nearest open edge of a different tile: under 3 cm, 3–10, 10–30, 30–100 cm, none within 1 m. Measured before, after the fixed passes and after all of them; written to the run's `tile_seams` note and its run note.
- **Adaptive close** (`closeAdaptive`): a border position and the nearest open border of another tile close up to the smaller of the two tiles' stated errors, capped at 30 cm, only where the surfaces agree (normals within 8°, borders parallel within 20°, each surface carried across the seam meets the other within 3 cm + 5% of the distance). Position rounds move the higher-ranked tile; split rounds split the other tile's edge at the point. A close that turns a triangle by more than 25° is taken back.
- **Strip fill** (`fillStrips`): agreed gaps no close may move are bridged by thin triangles in a copy of the tile's material labelled `generated` (`extras.scratchbox.provenance`, `photoInferredFill`).

### What the audit found

Open seam length (km) by gap band (under 3 cm / 3–10 / 10–30 / 30–100 cm / none within 1 m):

| Extraction | Raw | After the 3 cm passes (tile-seams/3) | After the adaptive close |
|---|---|---|---|
| ESB (198 k triangles, 136 tiles) | 25.4 / 13.1 / 10.6 / 9.1 / 54.5 | 8.3 / 12.4 / 10.7 / 8.3 / 56.0 | 8.4 / 12.5 / 10.6 / 8.3 / 56.0 |
| Penn 2 (266 k triangles) | 41.0 / 19.7 / 14.3 / 12.9 / 59.6 | 12.2 / 18.8 / 14.9 / 13.6 / 61.7 | 12.2 / 18.8 / 14.9 / 13.6 / 61.7 |
| Penn district, 7th Ave & W 33rd, r210 (780 k triangles, 581 tiles) | 105.1 / 49.6 / 37.0 / 29.2 / 143.2 | 31.3 / 47.5 / 37.9 / 29.4 / 148.0 | 31.3 / 47.5 / 37.8 / 29.4 / 148.1 |

The adaptive close changes almost nothing (30, 75 and 142 points closed; nothing for the strip fill). The reason is what the remaining seams are:

- **Every tile arrives cut along its box and capped.** Where two tiles meet, each carries a strip lying in the shared cut plane, back to back with the other's (the ESB's horizontal cuts every 36.46 m up the tower; vertical cuts 29 and 38 m apart). Of the district's 56,010 border contacts within 30 cm, 22,988 have surfaces facing 150–180° apart and 26,863 more 30–150° (cap against wall); about 1,000 are within 8°. A seam between two tiles' walls runs wall → cap → cap → wall; of the edges two tiles share, 84% fold by more than 20° (median 90°), against 39% inside a tile.
- **They are not holes.** The outside check of the ESB tower above 100 m at 3 cm pixels: see-through 0.715% raw, 0.714% after the 3 cm passes (the rest is the crop line).
- **Removing the caps does not help yet.** Caps lie within 2 m of their tile's box face (12,093 of 14,848 m² within 10 cm), so they can be removed exactly by the leaves' boxes (tried offline: 14,629 m² removed). Renders at the band cuts look the same, the open seam length moves between bands, and tower holes rise to 0.726%. Not built.
- **What a facade seam actually shows is the photo.** At each cut the two tiles' photos do not line up (piers step sideways by tens of centimetres, window rows break) and their tone differs: the median CIELAB step across a seam is 5.6 (ESB) / 4.9 (district), against 2.2–2.3 between neighbouring triangles inside a tile. Lining the photos up and levelling the tone across tile seams is the next step.

### Chunk borders

A leaf straddling a district chunk line is extracted by both chunks and cut exactly at the line (`district-seams.ts`, the later chunk's cut snapped within 25 cm onto the earlier one's): an ownership cut of one geometry, not a tile seam, so it needs none of this.

### Benchmark builds (uncached, pipeline K, `scripts/benchmark_buildings.ts`, main f4989130 against this branch with the adaptive close on)

| | main | branch |
|---|---|---|
| ESB | complete, holes 0.716%, untextured 0.37%, 13.4 min | complete, holes 0.715%, untextured 0.37%, 13.2 min |
| Penn 2 | degraded, holes 1.28%, untextured 1.56%, 8.7 min | degraded, holes 1.32%, untextured 1.59%, 6.7 min |

No difference a build shows. A full chunked district (pipeline K-D) was not built; the district figures above are the stage run on its own on an existing Penn extraction.

### Cost

On the district extraction: the fixed passes 50 s, the adaptive close 115 s, the fill 7 s, the audits about a second each (with other builds loading the machine). With the adaptive close off by default, the stage costs what tile-seams/3 did plus the audit.

## 9. Seam tone feather (tile-seams/5, 2026-11-05)

**Status: measured offline on the ESB and the Penn district extraction, rendered before and after; on by default (`SCRATCHBOX_TILE_SEAM_TONE=0` off), for extractions whose leaves carry their boxes (the crawler now writes each leaf's tileset box into its node, `extras.sb.tile.box`).**

What a facade seam shows (§8) is the two tiles' photos. Three things were tried; one ships.

- **Tone feather (shipped, `featherSeamTone`).** The cuts are the planes where two leaves' boxes share a face (neighbouring faces lie 5–10 cm apart; 808 cuts on the ESB, 1,602 on the district). On the surfaces crossing a cut (never a cap lying in it), each tile's photo is read within 1 m of the cut in 2 m bins along it, by facing; where both sides read a bin the two mean colours are levelled toward their geometric mean, half the step each, smoothed over neighbouring bins, interpolated between bin centres, faded out over 2.5 m, capped at 1.6x per channel. Texels an atlas draws at two places more than 0.5 m apart are never touched. The photos are written back in their own format (a native baseline JPEG encoder, `jpeg::encode`, keeps them JPEG; as PNG the ESB scan grew 18 → 46 MB, as JPEG 18 → 22 MB). Labelled `generated` on the material (`extras.scratchbox.method`).

| | median / p90 CIELAB step across the seam, before → after | photos changed | time |
|---|---|---|---|
| ESB (136 tiles) | 4.14 / 18.6 → 2.12 / 9.6 | 187 | 1.0 s |
| Penn district r210 (234 boxed tiles) | 3.35 / 15.0 → 1.61 / 7.9 | 303 | 1.1 s |

  In renders the change is modest: a softer tone change at the cuts, 2–10% of a facade view's pixels moved by more than 3 levels.

- **Sideways registration (tried, not shipped).** Grey profiles parallel to each cut, either side, cross-correlated per 4 m of seam: the two sides already correlate at 0.89–0.99 at no shift on the ESB's walls; 27 of 236 segments had a clear peak elsewhere. Rendered, nothing visible changed.
- **Row phase across the cut (tried, not shipped).** Each side's rhythm perpendicular to the cut (storeys, bays) read out to 12 m, the period from both sides' autocorrelation, each side's phase at it, and half the phase difference moved into each side over a band four times the move. On the ESB 86 wall segments had a rhythm on both sides; the tile photos (256–512 texels for ~30 m) are too soft and too different in viewpoint for it to be reliable: rendered, moves landed in triangle-shaped patches and swapped window content rather than continuing it. What still reads as a seam is the two photos themselves (different sharpness, different viewpoint), which no levelling or shift of either photo fixes.
