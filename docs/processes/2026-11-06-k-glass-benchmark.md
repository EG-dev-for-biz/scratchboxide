# Pipeline K glass: the facade reader as the primary source, benchmarked on five buildings

**Date:** 2026-11-06/07 · **Status:** Verified: ten uncached builds (main 70edef82 vs `feat/k-glass-openings` 79356a68), then MAIN's five fixes at 169f2043 with Seagram and Lever House built twice more with the model answers kept, and the Flatiron added · **Branch:** `feat/k-glass-openings` (#140 + #148 rebased onto main plus: the reader as the primary glass source 6af20f5b, the pane wall guard 8588b51d, no set metalness without a read 79356a68, the reader's windows voting as strips in the wall grammar and the windows' source label 14506bb2, the benchmark's kept model answers 14506bb2 and 4ef7eaf2, the twin reader keyed by the straightened photo 169f2043)

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

## Round two (MAIN's five points, 2026-11-07, the user's go-ahead "Yes, send fixes")

1. **Seagram flat → the reader's windows vote as strips** (14506bb2). The wall grammar's column vote reads bays from
   full-height strips, which the fit gives and the reader does not; the Seagram's shaft read no bay and was built flat.
   Now a plane the reader drew is voted on its windows plus the strips they make (`wall-grammar.ts` `voteRects`,
   `window-strips.ts`), and a wall whose columns still read no bay recesses its window strips (TS and native alike).
   Facade 6 after: 17 strips added to the vote; the column vote still reads no bay there (the bronze piers are as dark
   as the glass, so the luminance split cannot tell them apart), but the fallback builds the structure: 17 bays, piers
   proud (0.10 m, generated), 40,060 triangles against 27,784 before; cells 7,702 (main's 55,442 came from the fit's
   sub-pane rects, which the reader's clean grid does not produce, so that part of the acceptance is not met by this
   route). The close-up high on the shaft shows a bronze curtain wall with its mullions proud and the window strips
   recessed between them, not a blank wall; it is glossier than real bronze (the sets' roughness 0.24–0.32).
2. **Repeatability** (14506bb2, 4ef7eaf2, 169f2043). The reader and the ownership vote were at temperature 0 and kept
   their answers in the model readings store already, but the benchmark gave every build its own store, so nothing was
   reused run to run; the runner now keeps each side's answers under `<out>/model_readings/<side>`
   (`SCRATCHBOX_MODEL_READINGS_DIR`; `--fresh-readings` clears them once per run, `--no-readings` the old way). With
   the store kept, the remesh-stage reads reuse at once (the orthos are byte-identical build to build), but the
   twin-stage reads still missed: 127 of the twin's 210 images differ between two builds of the same inputs by 0.4 to 4
   levels (the texture stage's drift; the harmonise's sample and patch counts differ too), and a pixel hash cannot
   tolerate that. The twin reader now keys a facade's answers by its straightened photo and masks and its own version
   (`readPlanes` `planeKey`); planes photographed from the scan (roofs, terraces) keep their pixels' key.
   - Store cleared, twice (Lever House, 14506bb2): 9 planes / 402 windows, then 7 / 135; same geometry both times
     (holes 2.73%, untextured 2.60%). The variance is the model's.
   - Store kept, old twin keys (Lever House run C): 153 answers kept, 349 windows: the remesh read repeated, the twin
     reads did not.
   - Store kept, new keys (169f2043, runs D then E): **Lever House** 7 planes / 349 windows both runs, twin read 45
     planes / 9 replaced both runs, 259 kept and 11 missed in E; **Seagram** 8 / 1,752 both runs, twin 34 / 7 both,
     105 kept, 5 missed, 0 written in E. Acceptance met (0% difference).
   - Open: the texture stage's drift itself (the same inputs give twins that differ by a few levels on 127 of 210
     images); the ownership and remesh stage cache keys also differ between runs of the same inputs while their
     geometry does not. Both are for the determinism lane, not this branch.
3. **Label** (14506bb2): `sbFacadeLattice.windows.source` now reads e.g. "facade-reader/14: 114 windows read from the
   photo (photo-inferred); window-fit/8: 6 kept outside the zones it drew" (the Flatiron's facade 2); a plane the
   reader did not draw keeps "window-fit/8".
4. **Flatiron** (14506bb2 vs main): glass 8.26 → 11.15%, panes on stone 85 → 6, holes 0.68 → 0.79, untextured 4.05 →
   4.11; reader 5 of 5 planes, 411 windows. Facade 2: main's 110 uneven fit boxes with a block of strips → the branch's
   120, one per window on the whole 6 x 13 grid, the two shaded outer columns included (the column extension), plus the
   arcade and base.
5. **Re-runs and the sheet.** Seagram and Lever House twice each with the store kept (runs D and E above), the Flatiron
   once per side; `numbers.json` and `glass-sheet.jpg` updated (Seagram's close-up after the fix; the Flatiron row).
   The ESB, 30 Rock and Penn 2 rows are still their 79356a68 builds (before the bay fallback and the label). Model
   calls this round: about $3 (12 branch builds, most of them answered from the store).


## Fractional reader rects (the window-array session's note, relayed by MAIN, 2026-11-07)

The reader's accepted boxes come at two decimals (`round2` in `facade-reader.ts`). Every loop over them in the glass branch, audited:

| Consumer | How it reads a rect | Before | Now |
|---|---|---|---|
| wall grammar window mask (`wallEvidence`, TS and `scratchbox_wall_grammar.hpp` `decodeMember`) | fills each row of the rect in the texel index | the fractional top edge was used as the row: `y * W + x0` with `y = 10.6` lands 0.6 of a row further on, so the fill was shifted sideways by a fraction of the row width (TypedArray `fill` and the native `fillIndex` both truncate the index); on a reader plane the column vote saw its windows in the wrong columns | floor at the start, ceil at the end, whole rows; test `marks the window cells of a rect at fractional pixels` |
| pane wall guard (`paneGlass`, TS and native) | `Math.round` at each edge | a pane under a texel each way rounded to nothing and drew no glass | at least one texel each way; test case added |
| `openingMask`, `classRepeatSizes` (material regions, TS and native) | floor at the start, ceil at the end | fine | unchanged |
| repeat texture (`facade-repeat-texture.ts`, native `repeatTexture`) | floor/ceil texel loops, a floored sample position | fine | unchanged |
| `voteRects` | its strips are rounded to pixels; the single rects pass through as they are into the mask above | fine once the mask is | unchanged |
| `windowStrips`, `windowBays`, the lattice's window cells, reveal depth, `lattice-stitch` pitch | continuous geometry in metres or by a cell's centre; no texel loop | fine | unchanged |
| wall sheets' member windows | `Math.round` into the sheet | fine | unchanged |

The native parity fixture (`wall-grammar-native.test.ts`) only ever found its generated bay through the shifted mask: its second facade's windows sat a bay out of phase and its unread span was too narrow for a whole bay. It now gives that facade the windows of its painted bays and an unread span from its u 14, and reads 5 bays on the front wall, the next one generated, native and TypeScript byte for byte. 24 tests in the four touched files pass; typecheck clean.
