# Pipeline K: measured relief the lattice cannot draw keeps the scan (crowns, fins, setback edges)

**Date:** 2026-11-07 · **Branch:** `feat/k-keep-measured-relief` (on `feat/k-glass-openings` at 332cbc25) · **Status:** Verified on Penn 2, the ESB and 30 Rock (uncached builds); PR after the glass PR

## Ask (the user, 2026-11-07, from the Penn 2 clay sheet)

On a sheet of Penn 2 clay renders the raw tile_refine output (the scan with its walls flattened, the crown's mechanical fins
kept as proud blocks) read better at the top floor than the polished build, where the crown band had become flat lattice
cells with window recesses and the infill had capped the rest. The user asked for the logic that keeps that structure.

## The rule (`facade-lattice.ts` `KEEP_MEASURED`, TypeScript and native alike)

Per rebuilt wall cell at least a metre each way (a narrow pier cell between window columns cannot hold structure finer than
itself and its sub-grid reads the windows beside it: the third Penn 2 build kept 245 such slivers on the broad face, each
pulling whole scan triangles back over the lattice as diagonal seams; not a window or strip cell: a window's scan is glass, and photogrammetry doubles it with the interior
slab behind the pane, two plateaus that are no relief; the second Penn 2 build without this kept 1,440 cells, most of them
windows on the curtain wall), the raw isolate the polish already receives (`rawScan`, the scan before tile_refine flattened its walls, the
same samples the pier-to-bay depth is read from) is read on a 4 x 4 sub-grid inside the cell, a metre in from the facade's
rectangle (a neighbouring wall's reveals and fins lie inside the depth band at the corner and are not this wall's relief).
Each sub-cell with at least 3 samples gives its median depth; with at least 6 of them the cell's relief is the range of those
medians. A cell whose relief reaches 0.6 m, the deep and the proud sub-cells each spanning two sub-columns and two sub-rows
(fins or a setback edge run across the cell; a leak fills one sub-column), and the relief a step and not a slope (the
sorted medians jump by at least half the range somewhere: fins, louvres and a setback edge stand on two plateaus, while the
bulges photogrammetry leaves on a glass wall slope through every depth between; the first Penn 2 build without this test
kept 1,572 cells, 2,987 m², most of them on the curtain wall's body), holds structure deeper than any recess a cell
draws (`PHOTO_RECESS` at most 0.25 m; a deep reveal with the scan's noise stays under 0.5 m) or finer than the cell. It is
not rebuilt (`built` 0, so the claim rule never removes the scan under it and the tear audit sees it as scan), no window or
recess is drawn on it, a fitted window whose centre lies in it leaves the facade's window extras (no glass on kept scan),
and it stays `measured`: `sbFacadeLattice.scanKept` (cells, area, median relief, label, why) in the GLB extras, the polish
stats' `scanKeptCells` / `scanKeptM2` (total and per facade) and a clause in the polish summary.

The decision is made where the cells are decided, before the mesh is built, so chamfers, reveals and the stitch are unchanged;
the native lattice takes the five `KEEP_MEASURED` values at the end of its parameter vector and returns the kept cells in
its output (SBLF v3). Tests: `facade-lattice.test.ts` (a band of fins mid-facade is left to the scan, its windows undrawn; the
same walls without the band keep every cell) and the native parity case (`facade-lattice-native.test.ts`: the right wall's
top storey a crown of fins, kept on both sides, stats and GLBs byte for byte).

## Results (uncached builds, `benchmarks/2026-11-07-relief/feat/`, the reader answers kept from the glass bench; before = the glass bench's round four at 332cbc25, the branch's base)

| Building | side | commit | holes % | largest hole m² | cells | triangles | cells left to the scan | m² | where |
|---|---|---|---|---|---|---|---|---|---|
| Penn 2 | before | 332cbc25 | 1.33 | 86 | 74,698 | 444,640 | – | – | – |
| | after | 9b639bb5 | 1.29 | 86 | 74,498 | 451,011 | 200 | 673 | facade 16 (the broad face) 78 cells / 266 m²: the crown's fin band and the mechanical row; 34: 16; 14: 12 |
| ESB | before | 332cbc25 | 0.71 | 56 | 160,868 | 922,798 | – | – | – |
| | after | 9b639bb5 | 0.65 | 56 | 160,724 | 926,361 | 776 | 2,790 | the setback faces' lowest rows where they meet the terraces (15: 20 cells, 18: 14, 57: 12, 6: 15, 41: 5, ...) |
| 30 Rock | before | 332cbc25 | 0.51 | 72 | 246,450 | 1,203,880 | – | – | – |
| | after | 9b639bb5 | 0.52 | 65 | 246,273 | 1,204,154 | 177 | 1,318 | spread over the setback faces (26: 8, 21: 8, 15: 6, 0: 3, ...) |

Penn 2's crown is kept: the polished build now shows the fin band as the scan has it, where before the band was flat cells
with window recesses (`docs/screenshots/2026-11-07-k-keep-measured-relief/penn2-crown-before-after.jpg`, rows before /
after at 180°, 225°, 270°; `penn2-facade16-kept-cells.jpg` marks the kept cells on the facade photo: the top row and the
mechanical row). The body of the tower is unchanged (`penn2-full-before-after.jpg`); holes are within a few hundredths of
a point of the build before on all three, so the kept cells open nothing (the claim rule never removes scan under an
unbuilt cell, and the tear audit sees it as scan).

Three earlier forms of the rule, each rebuilt on Penn 2 and judged by eye, are why the rule has its four conditions:

1. Range alone at 0.6 m (fb410efd): 1,572 cells, 2,987 m², most of them on the curtain wall's body, as diagonal seams
   across the face (an unbuilt cell anywhere brings whole scan triangles back over the lattice). Holes 0.89%.
2. With the step test (ce7fe3b1): 1,440 cells: on glass, photogrammetry doubles the surface with the interior slab behind
   the pane, two plateaus that pass a step test. Holes 0.99%.
3. On wall cells only (f64ef616): 1,096 cells, 245 of them narrow pier cells between window columns on the broad face,
   whose sub-grid reads the windows beside them (`penn2-full-wallcells-only-seams.jpg`, right). Holes 1.16%.
4. On wall cells at least a metre each way (9b639bb5, above): 200 cells, the crown and the mechanical row. Holes 1.29%,
   against 1.33% before.

Cost: four Penn 2 builds and one each of the ESB and 30 Rock, about $1.20 in model calls (the reader answers reused).

**Open.** A kept cell's scan keeps the tile photo; the twin's material regions read it as a scan piece (the sets' mean
finish), which is right for a crown but leaves the kept band's texture as photographed. The rule reads the raw isolate
only where `rawScan` is given (pipeline K); the plain remesh polish builds as before. The branch is based on
`feat/k-glass-openings` at 332cbc25 and comes after the glass PR (MAIN, 2026-11-07); it needs a rebase onto the glass
branch's later commits (the perpendicular-sliver claim and the end-cell rule, b34b0c77 and a9d558f1, change the same
claim and cell rules) before its own PR.

## Files

- `packages/core/src/node/3d-engine/staged-location/facade-lattice.ts` (`KEEP_MEASURED`, the rule in `latticeFacade`, the extras, the stats)
- `packages/core/src/native/3d-engine/include/scratchbox_facade_lattice.hpp`, `scripts/remesh_polish_native.cpp`, `remesh-polish-native.ts` (the native rule and its protocol)
- `remesh-polish.ts` (the stats type and summary), `AGENTS.md`
- benchmark: `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-07-relief/` (after) against `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-06-glass/feat/` (round four, before)

## After the rebase onto main 9f11026c (2026-11-08)

The branch was squashed to one commit and rebased onto main after the glass PR (#182) merged (main now cuts the scan at
the rebuilt cells, follows the wall at a lattice's end cells, snaps a window's lines to its strip, and zips the tile
seams), then Penn 2 and the ESB were rebuilt uncached on both sides (`benchmarks/2026-11-07-relief/main/` at 9f11026c,
`feat/` at 7d0f5591; the reader answers kept). The close-ups use the glass benchmark's cameras; dark lines as there.

| Building | side | holes % | largest hole m² | cells | triangles | cells left to the scan | m² | dark lines % (glass close-up) |
|---|---|---|---|---|---|---|---|---|
| Penn 2 | main 9f11026c | 0.99 | 83 | 35,174 | 657,634 | – | – | 2.68 |
| | branch 7d0f5591 | **0.96** | 84 | 33,408 | 545,476 | 182 | 568 | **1.26** |
| ESB | main 9f11026c | 0.55 | 35 | 82,288 | 1,484,619 | – | – | 2.92 |
| | branch 7d0f5591 | 0.59 | 37 | 86,152 | 1,560,591 | 614 | 2,436 | **2.52** |

Penn 2's crown is kept on the branch where main still draws it as flat cells (`penn2-crown-main-vs-branch-9f11026c.jpg`,
rows main / branch at 180°, 225°, 270°); the body differs only by the reads (the branch's reader voted the columns as
strips this run). The ESB is unchanged to the eye (`esb-main-vs-branch-9f11026c.jpg`); its 614 kept cells lie on the
setback faces where they meet the terraces; its holes are 0.04 points above main's, the same regions on both sides
(`FacadeLattice_10020` 35 → 37 m², `relief_m82` 26 m² both), within the run-to-run spread seen on every building.
