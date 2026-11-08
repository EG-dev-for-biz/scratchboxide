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

**Status: measured offline on the ESB and the Penn district extraction, rendered before and after; opt-in (`SCRATCHBOX_TILE_SEAM_TONE=1`; the default is the user's decision: on Penn 2 it raised pipeline K's untextured share 1.56% → 1.78%), for extractions whose leaves carry their boxes (the crawler now writes each leaf's tileset box into its node, `extras.sb.tile.box`).**

What a facade seam shows (§8) is the two tiles' photos. Three things were tried; one ships.

- **Tone feather (shipped, `featherSeamTone`).** The cuts are the planes where two leaves' boxes share a face (neighbouring faces lie 5–10 cm apart; 808 cuts on the ESB, 1,602 on the district). On the surfaces crossing a cut (never a cap lying in it), each tile's photo is read within 1 m of the cut in 2 m bins along it, whichever way the surface faces (bins split by facing put a facade's triangles on either side of a bin's edge and levelled them each their own way: hard-edged wedges in the difference map); where both sides read a bin the two mean colours are levelled toward their geometric mean, half the step each, smoothed over neighbouring bins, interpolated between bin centres with a bin that has none counting as none (so it fades out where the read ends instead of stopping), faded out over 2.5 m from the cut, capped at 1.6x per channel. Texels an atlas draws at two places more than 0.5 m apart are never touched. The photos are written back in their own format (a native baseline JPEG encoder, `jpeg::encode`, keeps them JPEG; as PNG the ESB scan grew 18 → 46 MB, as JPEG 18 → 22 MB). Labelled `generated` on the material (`extras.scratchbox.method`).

| | median / p90 CIELAB step across the seam, before → after | photos changed | time |
|---|---|---|---|
| ESB (136 tiles) | 4.40 / 19.6 → 2.62 / 10.9 | 189 | 0.9 s |
| Penn district r210 (234 boxed tiles) | 3.41 / 14.9 → 2.12 / 9.1 | 304 | 1.3 s |

  In renders the change is modest: a softer tone change at the cuts, 4–11% of a facade view's pixels moved by more than 3 levels, as bands fading out either side of each cut (a few triangle-shaped wedges remain where a neighbouring triangle is left out: atlas-shared texels, or a face lying near the cut plane).

- **Sideways registration (tried, not shipped).** Grey profiles parallel to each cut, either side, cross-correlated per 4 m of seam: the two sides already correlate at 0.89–0.99 at no shift on the ESB's walls; 27 of 236 segments had a clear peak elsewhere. Rendered, nothing visible changed.
- **Row phase across the cut (tried, not shipped).** Each side's rhythm perpendicular to the cut (storeys, bays) read out to 12 m, the period from both sides' autocorrelation, each side's phase at it, and half the phase difference moved into each side over a band four times the move. On the ESB 86 wall segments had a rhythm on both sides; the tile photos (256–512 texels for ~30 m) are too soft and too different in viewpoint for it to be reliable: rendered, moves landed in triangle-shaped patches and swapped window content rather than continuing it. What still reads as a seam is the two photos themselves (different sharpness, different viewpoint), which no levelling or shift of either photo fixes.

## 10. The tiles' caps removed (tile-seams/6, 2026-11-05)

**Status: on by default since `tile-seams/9` (2026-11-07, section 14; the service's `caps: false` turns it off), for extractions whose leaves carry their boxes. When this section was written it was opt-in (`SCRATCHBOX_TILE_SEAM_CAPS=1`, a switch that no longer exists). Built and compared in uncached pipeline K builds of the ESB, in clay, against a control of the same code with the caps kept: clean on two of the four tower cuts looked at, a regression on one, unsure on one. Penn 2 is too noisy run to run to say anything.**

Judged in clay, a finished K building shows a row of slots across every bay at each Google tile cut. A ray through a slot hits a scan piece facing straight up, 14 cm in front of the rebuilt bay: the tile's cap, the strip each leaf carries in its cut plane (a ring about a metre wide inside the wall, about 500 m² at each ESB tower cut, half facing up, half down). K recesses the bays behind the scan's wall plane and never removes the cap (it faces up, not the facade), so it stands out across them. On the raw scan the caps are inside the surface and nothing shows (§8).

`trimCapsByBox`, first of the seam stage's passes: a triangle goes when it faces along a box face its leaf shares with another leaf (two faces within 1.2 m: some boxes stand half a metre loose of their cut, so two neighbours' boxes overlap by a metre), lies within 0.75 m of that face, and the neighbour's cap lies behind it within 10 cm, facing the other way, under its centroid.

What was tried on the way:
- **Marking a band along each cut in K's facade photos** (as uncovered, then as occluded), on the theory that K read the photos' meeting line as openings: as uncovered, K kept the scan's wall triangles across the band and with them the scan in place of the rebuild (flat walls); as occluded, the facades were rebuilt and the slots stayed. Reverted.
- **Caps within 15 cm of the box face:** 14,629 m² removed on the ESB scan, but only 14–48% of the cap area at the tower cuts (loose boxes); the west face's slots stayed.
- **Caps within 0.75 m, backed within 30 cm:** the cuts clean, but the ESB build opened a 75 m² hole near its top setbacks (3 x 24.5 m): the two faces of a thin wall standing along a cut, one in each leaf, are back to back like two caps. Backing within 10 cm (two leaves' caps lie centimetres apart; a wall's faces its thickness apart) removes 58 m² less and the hole is gone.

ESB, uncached builds (holes / untextured / largest hole region):

| | caps kept (control) | caps removed |
|---|---|---|
| ESB | 0.70% / 0.38% / 28.5 m², complete | 0.75% / 0.32% / 28.2 m², complete |

ESB scan: 20,448 m² of caps removed; 10–31 m² left at each tower cut (was about 500). In clay (sheet `docs/screenshots/2026-11-05-esb-tile-caps-clay.jpg`), face by face:

- **West and north faces at 215.9 m:** the slots are gone and nothing new appears.
- **East face near 179.5 m: not the cut (traced 2026-11-05).** The dark band there lies about 3.3 m below the cut, at 175.5-176.4 m, on the rebuilt facade (`FacadeLattice`). It is in builds with the caps kept too: main and two branch builds have it at 175.5-176.0 m, 0.52 m deep; the first caps-removed build had none, the second one 0.80 m deep, a build with the caps removed and the step blend none. Pipeline K rebuilds that part of the east face differently on every build, so one pair of builds cannot say what the caps do there (sheet `docs/screenshots/2026-11-05-esb-cuts-clay-four-builds.jpg`).
- **South face at 143 m: pipeline K's sheet edge (traced 2026-11-05).** The scan within 5 m is whole after the caps go (wall 20.3 to 21.4 m², return wall 8.0 to 10.3 m², the caps 10.3 m² to none). In the finished model the near wall's rebuilt sheet has a jagged left edge with scan pieces left on it (`relief_m96`, `relief_m97`). The cause inside pipeline K is not traced.
- **A rougher central recess** at 45° in the caps-removed build (whole-building sheet `2026-11-05-esb-clay-whole-caps.jpg`): not traced.

Holes rise 0.05 pt. The pass stays opt-in: the two faces above are pipeline K's and vary from build to build, so the caps' effect on a finished building is judged on the scan's per-cut scores (section 11) and on two builds an arm, not on one pair.

Penn 2 says nothing either way: with the same code and the caps kept, two builds gave holes 1.37% and 1.66% and a largest hole of 223 and 312 m² (its ownership vote and a standing fault at one corner vary run to run); with the caps removed, 1.31% and 1.79%.

## 11. Per-cut scores, step blend and rim zip (tile-seams/7, 2026-11-05)

**Status: the scores are always in the report (where the extraction gives each leaf's box and stated error); the rim zip, with the weld and the split repeated, is on by default since `tile-seams/9` (section 14; the service's `zip: false` turns it off). The step blend was dropped (2026-11-07): with the zip in rounds it added nothing at the rim (the table below), and its code is gone; its numbers stay here as the record. When this section was written both were opt-in (`SCRATCHBOX_TILE_SEAM_BLEND=1`, `SCRATCHBOX_TILE_SEAM_ZIP=1`, switches that no longer exist). Fresh extractions only (older ones carry no boxes). Scan-level numbers below; the finished-building comparison is section 14.**

- **Scores** (`measureCuts`, in the report as `cutScores`: raw, after the caps, after the blend, after the zip, final, and cut by cut): each tile's rim at a cut (open border of a surface crossing the cut, within 1 m of its plane), how much of it finds the other tile's rim (nearest in space, running parallel, facing the same way, within the smaller of the two tiles' stated errors capped at 50 cm), the step between the two rims in the cut plane and the gap along the cut's normal.
- **Step blend** (`blendCutSteps`): each wall moves half the step at its rim, faded out over 1.5 m.
- **Rim zip** (`zipCutRims`): each rim point moves halfway to the other rim, across it only, when its whole way there is within the pair's tolerance; a move turning a triangle more than 25° is taken back (a triangle no wider than 3 cm is left out of that test: the cut left it and the weld drops it); the report gives the move per cut (`rimZip.perCut`: points, mean and largest move). It runs five rounds, each from the rims as the last left them: where one rim has a point the other has none for, only that point can move, and half its way leaves it half as far off. Over all rounds no point ends further from where it started than the pair's tolerance. The weld and the T-junction split then join the rims, telling pieces apart as they were before the blend and the zip (two rims brought onto the same points are otherwise one piece, and the rest of their border is never welded: the first version left more rim open than no zip at all).

ESB scan (198,462 triangles, 839 cuts with a rim, caps removed in every arm):

| | open rim at the cuts | of it matched | audit: open under 3 cm / 3-10 cm |
|---|---|---|---|
| after the caps, before the weld | 83.6 km | 27.0 km | |
| caps only, final | 38.0 km | 11.0 km | 10.8 / 10.4 km |
| + zip, one round (first version) | 34.6 km | 9.1 km | 12.3 / 8.4 km |
| + zip, five rounds | 26.3 km | 5.2 km | 9.8 / 7.0 km |
| + blend and zip, five rounds | 26.1 km | 5.0 km | 9.2 / 7.1 km |
| + zip, five rounds, weld and split repeated | 17.7 km | 3.2 km | 4.6 / 6.7 km |

The zip moved 15,861 rim points on 306 cuts (largest move 48 cm, inside the 50 cm cap; 2,331 moves taken back over the rounds; 269 points beyond the tiles' error); right after it the matched rims stand 1.7 mm apart (2.4 cm before). With the zip in rounds the blend adds almost nothing at the rim.

**Where the open rim goes, stage by stage** (zip arm, matched rim): 26.9 km after the zip, 18.0 km after the vertex weld, 5.2 km after the T-junction split. The two rims are tessellated differently along the cut (one side's edge runs 10 m where the other has points in between), so the vertex weld alone pairs a third of it and the split does most of the rest; more split rounds change nothing.

**The weld and the split repeated** (with the zip, at most three more passes, while the weld still joins something; `reweld` in the report). The 4.1 km of matched rim left open at points the two tiles already shared was mostly slivers along the cuts and corners where four tiles meet: the first weld pairs such points two by two and leaves the pairs a few millimetres apart, and a sliver's two long edges both count as open rim. On the ESB two more passes weld 287 points, drop 114 slivers and close 16 T-junctions, and the open rim at the cuts falls from 26.3 to 17.7 km. Checked on the written scan apart from the stage's own scores: surface area 434,478 to 434,131 m² (0.08% less), all open edges 96.8 to 87.3 km, edges shared by three or more triangles 15,776 to 15,849. The stage takes 3.0 s (1.7 s without the zip).

**What it does not do yet.** 3.2 km of matched rim is still open (mean gap 2.1 cm, mean step 1.9 cm: mostly moves the zip took back, and points beyond the tiles' error). Telling pieces apart by tile as well was tried and is worse (the split closes fewer); more split rounds alone change nothing. The 14.5 km of unmatched rim has no other tile's rim within reach. No clay sheet was made for this step: a 1-3 cm opening does not show at a building's scale, and a finished building's cuts are pipeline K's to draw; no finished building has been built with the zip.

## 12. Tone balance per tile (tile-seams/8, 2026-11-06)

**Status: not in the code. Built, tested and measured as no help on Google's tiles (the feather, section 9, does the work); kept on the branch `claude/tile-seam-colour` (commit 2d46dd21) and not landed (MAIN's call, 2026-11-07). Scan-level numbers; no finished building.**

One gain per tile and channel for the whole scan, fitted over all the cuts at once and applied to the tile's whole photos, before the feather (`TileSeamToneParams.balance`, inside `featherSeamTone`): each cut's step is the weighted median of its bins' log ratio of the two sides' mean colours (linear RGB); the fit is weighted least squares on g(tile 0) - g(tile 1) = step, refitted six times with each cut's weight cut down by how far it stands from the fit (Huber, 0.05 log gain), with a weak pull of every gain toward none (2% of a tile's cut weight) that pins the scan's overall level; gains capped at 1.6. Labelled generated (`extras.scratchbox.method`). The report gives tiles, cuts in the fit, the largest gain, the mean log gain (the drift) and the step after the balance.

| scan | step at the cuts as it came (ΔE median / 90th) | balance only | feather only | balance, then feather |
|---|---|---|---|---|
| ESB (136 tiles, 808 cuts, 225 in the fit) | 3.59 / 16.13 | 3.59 / 14.68 | 2.44 / 8.74 | 2.45 / 8.49 |
| Penn Station district (234 tiles, 1,602 cuts, 509 in the fit) | 2.82 / 12.08 | 2.78 / 11.52 | 1.96 / 7.90 | 1.96 / 7.90 |

The mean log gain is -0.016 and -0.015 (no drift). Before the fit was made robust (plain means and least squares) it raised the ESB's median to 3.98.

**Reading.** The tiles carry no exposure offset of their own to take out: neighbouring leaves are textured from one source, and the step at a cut is what each side's photo shows there (resolution, where a window falls, a shadow's edge), which one gain per tile cannot move. A tile also holds faces lit differently, so its cuts disagree with each other whatever gain it takes. What the balance does move is a few outlying cuts (the 90th percentile). The remaining colour work is the photo line-up across a cut, not levels.

## 13. Picture offset across the cuts: measured, no line-up built (2026-11-06)

**Status: a measure in every report (`photoOffset`, where the extraction gives each leaf's box); nothing is moved. A second look at the sideways registration of section 9, with the same answer.**

`measureSeamOffsets`: on each wall crossing a cut, a grey profile is read either side along the wall (0.15 m cells, a leaf photo's texel; within 0.2 m of the cut; in 8 m segments by the wall's facing), and the two profiles are correlated at every shift up to 0.8 m, the peak placed between cells by a parabola. A segment counts when both sides read 16 cells in common and each carries a picture (4 grey levels of spread); it is "off" when its best correlation is at least 0.6, 0.05 above the one at no shift, and a cell or more away. Per cut: segments, segments off, correlation at no shift, shift in metres and in texels.

| scan (texel 0.155 m) | segments with a picture | correlation at no shift (median / 10th) | best shift (median / 90th) | segments off |
|---|---|---|---|---|
| ESB | 1,020 | 0.66 / -0.14 | 0.11 m (0.7 texel) / 0.75 m | 189 (19%), median 0.27 m, +0.15 correlation |
| Penn Station district | 1,676 | 0.70 / 0.00 | 0.10 m (0.6 texel) / 0.63 m | 385 (23%), median 0.22 m, +0.14 correlation |

Both rows are with the caps removed; with them kept far fewer segments read both sides (ESB 202, correlation 0.51, shift 0.15 m). The measure adds 0.3 s (ESB) and 0.6 s (district) to the stage.

The strip's width decides what is read: a metre either side the two tiles show different storeys and correlate at 0.25 (ESB) with a best shift anywhere in reach; at 0.35 m 0.58; at 0.2 m 0.66. So the measure reads the strip at the cut only.

**Reading.** The typical cut needs less than a texel: the two photos stand where they should, to the photos' own resolution (15 cm a texel). About a fifth of the segments prefer a shift of one to two texels for a modest gain in correlation; with profiles of 16-53 cells, some of those are a repeat of the wall matching one bay along, not a misplaced photo. Moving a photo by a texel or two cannot sharpen a seam between photos this coarse, and section 9's try (the same shifts applied) changed nothing in renders. No line-up pass is built: the measure stays so a scan with a real offset shows it.


## 14. Caps removed and rims zipped by default: uncached builds against main (tile-seams/9, 2026-11-07)

**Status: the default. Two arms, each an uncached pipeline K build (stage cache emptied first) of the Empire State Building and Two Penn Plaza: `main` = 87a792c4 as it was (caps kept, `tile-seams/4`), `zip` = the caps removed, the rims zipped in rounds and the weld and split repeated (section 10 and 11's code). The zip arm was built twice and came out identical to the last digit (the stage and pipeline K are deterministic; the readings store serves the same model answers); the main arm's second pair did not finish (one tile_refine over its 900 s limit at load 200, one Google Places fetch failure), so main is one build each. Sheets: `docs/screenshots/tile_seams_zip_2026-11-07/seams_{esb,penn2}_main_vs_zip.jpg` (eight cut cameras each, 30 m out: main clay, zip clay, main textured, zip textured; a yellow tick at the cut height). Decided on by the user through MAIN from the ESB sheet.**

Finished building (the tear audit's twelve views):

| place | arm | outcome | holes | untextured | largest hole | triangles |
|---|---|---|---|---|---|---|
| ESB | main | degraded (the largest hole) | 0.73% | 0.39% | 55.4 m² | 861,838 |
| ESB | zip | complete | 0.67% | 0.34% | 30.1 m² | 913,527 |
| Penn 2 | main | degraded | 1.08% | 1.67% | 84.7 m² | 965,120 |
| Penn 2 | zip | degraded | 0.92% | 1.43% | 88.1 m² | 723,312 |

The seam stage on the extraction: ESB 269,243 → 208,906 triangles (62,566 cap triangles, 26,179 m², removed), open edges after the stage 73,023 → 52,828, open length by gap band (0–3 cm / 3–10 / 10–30 / 30–100 / none within 1 m) 10.7 / 16.2 / 13.6 / 10.2 / 68.9 km → 5.6 / 9.1 / 5.1 / 8.8 / 71.9 km, 7.4 → 15.2 s; Penn 2 141,852 → 99,196, 48,469 → 33,781, 6.7 / 10.1 / 8.3 / 7.7 / 36.5 → 3.9 / 6.0 / 4.4 / 7.5 / 38.3 km, 7.7 → 5.3 s. Cut scores (ESB): the rim at the cuts 20.9 km as the scan came (2.5 km of it matched to the other tile's rim) → 105.3 km once the caps are gone (35.0 matched) → after the zip the matched rims 1.4 mm apart (24 mm before) → 21.4 km open at the end (3.7 matched); the zip moved 20,469 rim points on 402 of 1,287 cuts (largest move 48 cm, 445 beyond the tiles' error, 3,007 taken back), the reweld 2 passes, 366 groups, 18 more T-junctions. Penn 2: 44,450 cap triangles, 15,486 points on 318 of 897 cuts, 18.1 km open at the end (21.5 raw).

**In the pictures.** Clay at the cut height: the zip arm cleaner in 9 of the 16 rows (ESB west 216, north 216, east 180, south 143, east 70; Penn 2 north 114, west 114, south 78, east 42), main cleaner in 1 (ESB west 107), the same in 6. The main arm's typical defect is the cap's horizontal slot across the bays, or a wedge, at the cut; what the zip arm still shows is slivers and pipeline K's own rebuild edges. Textured: no visible difference at the cut in 14 of 16 rows; ESB west 107 the zip worse (a stepped edge on the right), Penn 2 north 114 the zip better (low confidence). A separate fast multimodal check, given the claims and not a verdict, read the sheets the same way. Caveat: the arms are separate uncached builds, so K's own rebuild near the cuts differs between the columns too; the per-build variation is of the order of the change.

**What changed in the code** (`tile-seams/9`): the cap trim and the rim zip run whenever the extraction gives each leaf's box (the service's `caps`/`zip` default true; the CLI's `--no-caps`/`--no-zip`); the orchestrator's `SCRATCHBOX_TILE_SEAM_CAPS`, `_ZIP`, `_BLEND` and `_BALANCE` switches are gone (`_TONE` and `_ADAPTIVE` stay opt-in); the step blend (section 11) and the tone balance (section 12) are out of the code; the per-cut scores, the rim zip's per-cut moves, the reweld counts and the picture offset stay in every report and run note. On the finished building, open edges within 0.3 m of a cut plane: ESB 51.1 → 48.7 km, Penn 2 36.9 → 24.0 km (a band that mostly counts K's own node boundaries, so it moves with the triangle count).
