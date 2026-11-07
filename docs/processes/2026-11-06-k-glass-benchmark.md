# Pipeline K glass: the facade reader as the primary source, benchmarked on five buildings

**Date:** 2026-11-06/07 · **Status:** Verified: ten uncached builds (main 70edef82 vs `feat/k-glass-openings` 79356a68), the numbers below from each build's own records · **Branch:** `feat/k-glass-openings` (#140 + #148 rebased onto main plus three commits: the reader as the primary glass source 6af20f5b, the pane wall guard 8588b51d, no set metalness without a read 79356a68)

## Ask (MAIN, 2026-11-06, the user's first priority "Glass assignment")

The facade reader's accepted openings are THE primary source of glass ("I think this is the best way to identify
windows for glass - it should be used as our primary"); the window fit and the colour classes only where the reader did
not read a plane; the wall-colour guard kept as a fallback, its drops reported; the reader's three errors fixed (30 Rock's
doubled storey pitch, Seagram's half-bay phase, the Flatiron's shaded columns); the benchmark side by side, uncached, on
Lever House, Seagram, ESB, 30 Rock and Penn 2 with `--keep-caches`; per building glass %, panes and bays on stone, reader
panes dropped by the guard, reader boxes against a spot count of visible windows, holes, untextured, a labelled sheet.
Targets: Lever House and Seagram glass up several times; panes and bays on stone down 80% or more on the ESB, 30 Rock and
Penn 2; holes and untextured no worse.

## Results (materials on the layer each side drew them on; `numbers.json` beside the benchmark)

| Building | glass % main → feat | panes on stone main → feat | bays on stone main | wall-like texels in feat's panes | holes main → feat | untextured main → feat | reader planes drawn / read (feat) | reader windows (feat) |
|---|---|---|---|---|---|---|---|---|
| Lever House | 1.02 → **9.33** (9x) | 28 → 2 (−93%) | 2 | 0.17% | 3.20 → 2.75 | 4.34 → 3.28 | 6 / 15 | 80 |
| Seagram | 7.83 → **9.77** (1.25x) | 204 → 93 (−54%) | 8 | 0.57% | 2.21 → 2.14 | 2.67 → 3.21 | 10 / 12 | 1,764 |
| ESB | 8.35 → 5.53 | 366 → 43 (−88%) | 105 | 0.13% | 0.73 → 0.66 | 0.39 → 0.34 | 50 / 67 | 5,749 |
| 30 Rock | 10.03 → 6.69 | 500 → 4 (−99%) | 67 | 0.19% | 0.98 → 0.51 | 1.87 → 0.54 | 39 / 63 | 3,991 |
| Penn 2 | 6.57 → **9.31** (1.4x) | 169 → 7 (−96%) | 72 | 0.47% | 1.08 → 1.16 | 1.68 → 1.69 | 9 / 19 | 344 |

Reader boxes against the photo's visible windows, one plane each (spot counts by eye on the feat ortho; the overlays in
`closeups/<slug>/boxes_{main,feat}.png`): Lever House facade 11: 13 strips → 283 boxes of ~380 (right half unboxed);
Seagram facade 6: 487 (window fit, lower half off the grid) → 654, one regular 18 x 36 grid of ~650; ESB facade 39: 17
strips → 587 of ~770; 30 Rock facade 12: 100 column strips → 396 single windows of ~440; Penn 2 facade 16: 457 scattered
sub-panes → 225, one per bay on the 18 x 9 grid of ~200.

**Against the targets.** Lever House glass up 9x and Penn 2 up 1.4x; Seagram up 1.25x, not "several times": the
reader drew 10 of its 12 planes and 1,764 windows, but its bronze wall sits close to the glass colours, so the guard
still leaves 93 panes as stone (down 54%, short of 80%). Panes on stone down 88 to 99% on the ESB, 30 Rock and Penn 2;
main's bays on stone (105, 67, 72) have no counterpart on the branch, which draws no glass in bays. The ESB's and 30
Rock's glass share fell (8.35 → 5.53, 10.03 → 6.69) because main's glass ran over piers and bays (its panes and bays on
stone); the branch's glass is the reader's panes alone, which the close-ups show as windows recessed one by one where
main drew continuous glossy strips. Holes and untextured are no worse on four buildings; Penn 2's are within 0.1 point
and Seagram's untextured is up half a point (3.21 vs 2.67).

## What was found and fixed on the way

1. **The wall guard ate the reader's panes** (8588b51d). Each pane texel was classed among all six appearance classes,
   and the outside k-means always holds a dark class beside the openings' colours (L39.8 against L39.2 on the ESB), so
   3,489 of the ESB's 4,867 reader panes went to stone and glass fell to 1%. Now only the wall's class and the opening
   classes are candidates, TS and native alike (the native test's dangling `else` fixed too). The materials run note
   also keeps a layer's drawn report when a later layer (the vision vote's, with no rebuilt facade) draws none: Penn 2's
   note had said "not drawn".
2. **A set's metalness drew without a reading** (79356a68). With no confident finish read, `finishMaps` passed the
   library set's own maps through, metalness included: the Seagram's three bronze classes (69% of texels) at 0.8 from
   MetalPlates sets, a Lever House class from DiamondPlate, Penn 2's from a fence set and a wood set (0.6). Main drew
   no metal on any of the five. Now an unsure read keeps the set's roughness and draws metalness 0; a confident metal
   read (Penn 2's aluminium curtain wall at 75–80) still draws metal, as designed.
3. **Run-to-run variance of the reader.** The same commit read Lever House's curtain wall as 8 planes / 350 windows in
   one run and 6 / 80 in the next (the facade then folded into a wall sheet); Seagram's facade 6 was unread in one run
   and drawn as a full grid in the next. The numbers above are one run each; a decision on Seagram's target needs a
   repeat.
4. **Layers.** The materials are drawn on the layer the ownership vote picks (l2 or l2v), which differs between sides on
   Lever House (main l2v, feat l2) and runs; the numbers are read from each side's textures cache record for the layer
   it drew on, not from the run note, which the last layer overwrites on main.
5. **Seagram's facade 6 is flat on the branch.** The reader's per-pane windows replaced the window fit's strips on the
   plane, so the wall grammar found no bays and the lattice built no structure: 7,811 cells, 3,384 recessed, 27,784
   triangles, where main's fit-driven lattice had 55,442 cells, 13,787 recessed and the piers proud of the bays
   (165,668 triangles). The close-up shows a flat glossy sheet against main's recessed windows. A real curtain wall is
   nearly flat, but its mullions stand proud and the branch draws none; the reader's windows should feed the wall
   grammar's bay reading (or keep the fit's strips for the structure) so the relief survives. Also: the reader's
   windows carry the window fit's source label (`window-fit/8`) in `sbFacadeLattice.windows.source` after the merge.
6. **Not done:** the evidence row for Lever House's final run has no ortho (a wall sheet), so it shows the previous
   run's facade 11; the close-up camera picker (`closeups.ts`) needs a line-of-sight check (30 Rock's first camera sat
   inside the massing, Seagram's behind its annex) and a facade switch, both added by hand here.

## Files

- Benchmark: `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-06-glass/` (`main/`, `feat/` at 79356a68,
  `superseded/feat-6af20f5b`, `superseded/feat-8588b51d`, `numbers.json`, `closeups/`, `glass-sheet.jpg`).
- Sheet: `glass-sheet.jpg` there and in the side-session notes folder as `k-glass-benchmark-sheet.jpg`.
