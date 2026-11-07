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


## Round three (MAIN, 2026-11-07, the user's go-ahead "Yes, rebuild then train")

All six buildings rebuilt uncached on the branch, the reader answers kept from round two (`model_readings/feat`), main
70edef82 reused. Two runs: **3a** at 2a52f50e (the fractional-rect fix), then **3b** at 61870cab after the vision-chain
fix below; the table is 3b. Materials are now read on each build's **final** layer (the voted `l2v` where the ownership
stage published one, else `l2`); the earlier rows read main's retired `l2` on Lever House and 30 Rock, so main's numbers
there change (Lever House cells 36,319 → 17,558; 30 Rock glass 10.03 → 8.00%, panes on stone 500 → 248).

| Building | side | glass % | panes on stone | wall-like in panes % | cells | triangles | bays read + gen | reader planes / windows | holes % | untex % |
|---|---|---|---|---|---|---|---|---|---|---|
| Lever House | main | 1.02 | 28 (+2 bays) | – | 17,558 | 84,373 | 8 + 0 | 9/41 | 3.20 | 4.34 |
| | round 2 | 8.79 | 14 | 0.34 | 10,825 | 78,663 | 11 + 1 | 7/16 / 349 | 2.73 | 2.60 |
| | round 3 | 7.84 | **0** | 0.23 | 12,420 | 84,803 | 11 + 1 | 8/16 / 396 | 2.87 | 2.77 |
| Seagram | main | 7.83 | 204 (+8 bays) | – | 121,412 | 435,685 | 14 + 0 | 8/34 | 2.21 | 2.67 |
| | round 2 | 9.91 | 10 | 0.10 | 48,267 | 250,815 | 2 + 0 | 8/12 / 1,752 | 1.88 | 3.03 |
| | round 3 | 18.45 | 20 | 0.16 | 56,484 | 308,886 | **12 + 0** | 11/12 / 3,373 | 1.73 | 3.23 |
| ESB | main | 8.35 | 366 (+105 bays) | – | 162,605 | 863,633 | 192 + 30 | 59/120 | 0.73 | 0.39 |
| | round 2 | 5.53 | 43 | 0.13 | 136,404 | 728,765 | 58 + 38 | 50/67 / 5,749 | 0.66 | 0.34 |
| | round 3 | 5.99 | 86 | 0.06 | 161,445 | 927,859 | 181 + 66 | 59/67 / 7,227 | 0.70 | 0.35 |
| 30 Rock | main | 8.00 | 248 (+79 bays) | – | 224,797 | 1,098,097 | 328 + 60 | 53/120 | 0.98 | 1.87 |
| | round 2 | 6.69 | 4 | 0.19 | 234,070 | 1,138,661 | 200 + 93 | 39/63 / 3,991 | 0.51 | 0.54 |
| | round 3 | 10.26 | **0** | 0.02 | 268,928 | 1,292,075 | 284 + 45 | 48/63 / 8,454 | 0.50 | 0.53 |
| Penn 2 | main | 6.57 | 169 (+72 bays) | – | 210,018 | 970,509 | 42 + 56 | 8/71 | 1.08 | 1.68 |
| | round 2 | 9.31 | 7 | 0.47 | 150,035 | 756,443 | 23 + 52 | 9/19 / 344 | 1.16 | 1.69 |
| | round 3 (l2v) | 11.61 | 13 | 0.74 | 78,024 | 443,843 | 44 + 16 | 14/22 / 760 | **2.23** | 1.30 |
| Flatiron | main | 8.26 | 85 (+3 bays) | – | 62,296 | 230,456 | 11 + 12 | 6/14 | 0.68 | 4.05 |
| | round 2 | 11.15 | 6 | 0.46 | 92,195 | 323,291 | 4 + 0 | 5/5 / 411 | 0.79 | 4.11 |
| | round 3 | 12.35 | **106** | 0.48 | 47,028 | 207,038 | 11 + 0 | 5/5 / 946 | 0.80 | 4.07 |

**MAIN's two questions.** Lever House's 14 panes on stone went down: 10 in 3a, 0 in 3b. Seagram's bays changed: the
shaft read 2 bays in round two, 10 in 3a and 12 in 3b (the fractional mask fix: the column vote now sees the reader's
windows in their own columns); facade 6 keeps the reader's 681 windows and its structure (8,066 cells, 41,510 triangles).

**Against main**, by MAIN's four numbers:
- glass %: up on five buildings; ESB is below main (5.99 vs 8.35%) because main's share includes its 366 panes and 105
  bays drawn as glass on stone, which the branch refuses (86 panes left as stone, 0.06% wall-like texels in glass).
- panes on stone: down on five buildings (Lever House 28 → 0, Seagram 204 → 20, ESB 366 → 86, 30 Rock 248 → 0, Penn 2
  169 → 13). **Flatiron is up, 85 → 106.** Its facade 6 (Broadway) was not read in full this run: the brief grouped
  planes 3 and 6 into one family, so facade 6 was tiled from plane 3's window by the template (`facade-reader-template.ts`),
  which found 551 matches in 25 columns on a facade with 17 window columns (the template's peaks only need to be half an
  exemplar apart, so the Flatiron's undulating bays match at half-column offsets too); about a hundred of those panes sit
  on the piers and the wall guard refuses them. Main did the same on this facade (625 template matches) with its own
  brief; in round two the brief kept planes 3 and 6 in separate families and facade 6 was read in full (250 openings in 4
  zones, 6 panes on stone). The code is the same on both sides; the number moves with the model's family grouping. The
  fix is in the template, not this branch's glass path: peaks at least an opening apart (openings cannot overlap), not half
  the exemplar's patch.
- cells and triangles: ESB and 30 Rock are at or above main; Lever House (12,420 vs 17,558), Seagram (56,484 vs 121,412),
  Penn 2 (78,024 vs 210,018) and Flatiron (47,028 vs 62,296) are below it, because main's counts come from the window
  fit's sub-pane rects (Seagram's facade 6: 55,442 cells for 487 fit boxes; Penn 2's facade 16: 46,456 cells for 457)
  and the reader's one box per window makes fewer, larger cells. On the compared facades the triangles go up where main
  had strips (ESB 39: 23,104 → 47,582; 30 Rock 12: 30,106 → 42,040) and down where main had the fit's slivers (Seagram 6:
  165,668 → 41,510; Flatiron 2: 43,896 → 14,950); Penn 2's facade ids differ on the voted layer (its broad face is 7
  there, 57,701 cells, 369 windows), so its facade 16 is not comparable.
- **Penn 2's holes 1.08 → 2.23%, the largest hole 84.7 → 474.9 m²**, is a regression in a number MAIN did not list but
  the product rule does ("no tears"). It is the first Penn 2 build with a voted layer: the ownership stage's 12-view vote
  had always failed on Penn 2 ("the voted isolate is not the structure picked; the geometric isolate stands", main and 3a
  alike) because gemini-3.8-flash's outline replies were unusable; with the chain fix the vote fell through to
  gemini-4-argon, passed, and published an `l2v` remesh (443,176 triangles) that supersedes the `l2`. On it the twin reader
  read facade 8 (the 225° face, its ortho now 1,422 x 1,185 instead of 1,383 x 1,533) as one zone with 4 openings, and the
  visible-defect audit sees the back of FacadeLattice_8 through a 48 x 9.9 m hole at 225°/0° (`view_225.png` beside the
  build: the base of that face is open). The `l2` of the same build (retired) reads like 3a: 300 openings on facade 8,
  holes 1.33%. The vote's acceptance on Penn 2 is for the ownership lane; the tear audit should have put the scan back.

**What was fixed on the way** (both commits on the branch):
- 3a lost planes to malformed gemini-3.8-flash replies (`"label": "panes": 1`, fenced arrays, trailing data) that the
  vision chain never handed to the next model and cached: ESB 10 planes, 30 Rock 7 (facade 12 fell back to the fit, as on
  main), Seagram 2, Flatiron 2 (facade 2 fell back to the fit: 103 panes on stone). `VisionModelChain.walk` now walks the
  candidates once and moves on when `valid` refuses a reply, returning the first reply only when every model's is unusable;
  `replay` asks again when the recorded text fails `valid`; the facade reader remembers only usable replies
  (efa6c043; `vision-model-chain.test.ts`). 3b reads 59/67 ESB planes (3a 49), 48/63 on 30 Rock (42), 11/12 Seagram (9),
  14/22 Penn 2 (10), 8/16 Lever House; the fallback model answered 284k prompt and 95k output tokens across the six
  builds (unpriced in the runner's estimate).
- The runner's `sheet` step rewrote every `result.json` under the output folder by side, so the round-three results were
  overwritten with round two's (same run ids); it now writes only the row of the same side and place (61870cab). The 3a
  results were restored from the ledger rows.
- The measuring scripts read the final layer (above).

**Cost.** 3a $2.08 (fresh reads on four buildings); 3b $1.00 priced plus the gemini-4-argon tokens above. Both under
the $10 cap. Reader reuse in 3b: Lever House and Seagram remesh reads from the store (27–28 answers each), the twin reads
re-asked where the chain fix changed the answer.

**Not pushed.** Flatiron's panes on stone and Penn 2's holes are above main, so per MAIN's instruction the branch stays
local (HEAD 61870cab, three commits past the round-two state: 2a52f50e, efa6c043, 61870cab) until MAIN decides.


## Round four (MAIN, 2026-11-07: "fix both on the branch")

Two fixes, then all six rebuilt uncached at 332cbc25 with the reader answers kept ($0.93 priced, plus 234k prompt and 78k
output gemini-4-argon tokens the runner does not price). Builds set aside under `feat-round3b/`.

1. **The template snaps to the plane's own column period** (`facade-reader-template.ts` `templateColumns`,
   `pipeline-k.ts`). The straightening's measured horizontal repeat (`rectify.json` `periodM`, `periodNcc`) now rides in
   `facades.json`; a sibling plane's matches are phased on it (their circular mean at the period), each match goes to
   its nearest column, and when they agree on no phase (circular mean under 0.5: matches half a column apart) the plane
   is read in full. Without a measured period, two columns closer than an opening refuse the template the same way.
   Flatiron's facade 6: read in full (262 openings in 4 zones) instead of 551 on a 25-column grid; panes on stone 106 →
   60 (main 85). Where the template holds it now records the period and the agreement: ESB 39 at 5.54 m (0.99), 13 at
   5.63 m (0.97); Penn 2's 16 and 25 at 5.95 m (0.93, 1.00); 30 Rock's 15 tiled planes at 2.2-2.7 m (0.57-0.99).
2. **The ownership vote may not tear** (`orchestrator.ts` `OWNERSHIP_TEAR_TOLERANCE`): the voted remesh replaces the
   first isolate only when its polished build shows holes on no more of itself (within 0.1 point) and no larger largest
   hole than the first isolate's, else the geometric isolate stands with `ownership_vote_torn`. Penn 2: "the voted build
   is more torn than the first isolate (holes on 2.18% of it against 1.33%, the largest 474.9 m² against 86.5 m²)"; its
   l2v is gone and the build is the first isolate (holes 1.33%, largest 86 m²). Why the vote tore: it took away the
   podium-level scan around the tower's base that no rebuilt facade covered.

| Building | side | glass % | panes on stone | cells | triangles | bays read + gen | reader planes / windows | holes % | untex % |
|---|---|---|---|---|---|---|---|---|---|
| Lever House | main | 1.02 | 28 (+2 bays) | 17,558 | 84,373 | 8 + 0 | 9/41 | 3.20 | 4.34 |
| | round 4 | 9.43 | **1** | 12,528 | 83,597 | 11 + 1 | 8/16 / 362 | **2.95** | 2.77 |
| Seagram | main | 7.83 | 204 (+8 bays) | 121,412 | 435,685 | 14 + 0 | 8/34 | 2.21 | 2.67 |
| | round 4 | 18.45 | **20** | 56,484 | 308,886 | 12 + 0 | 11/12 / 3,373 | **1.73** | 3.23 |
| ESB | main | 8.35 | 366 (+105 bays) | 162,605 | 863,633 | 192 + 30 | 59/120 | 0.73 | 0.39 |
| | round 4 | 6.16 | **88** | 161,500 | 922,798 | 184 + 35 | 59/67 / 7,303 | **0.71** | 0.48 |
| 30 Rock | main | 8.00 | 248 (+79 bays) | 224,797 | 1,098,097 | 328 + 60 | 53/120 | 0.98 | 1.87 |
| | round 4 | 7.95 | **4** | 246,450 | 1,203,880 | 277 + 57 | 49/63 / 6,088 | **0.51** | 0.52 |
| Penn 2 | main | 6.57 | 169 (+72 bays) | 210,018 | 970,509 | 42 + 56 | 8/71 | 1.08 | 1.68 |
| | round 4 | 11.61 | **1** | 74,698 | 444,640 | 48 + 46 | 10/19 / 664 | 1.33 | 1.69 |
| Flatiron | main | 8.26 | 85 (+3 bays) | 62,296 | 230,456 | 11 + 12 | 6/14 | 0.68 | 4.05 |
| | round 4 | 9.79 | **60** | 66,353 | 263,125 | 14 + 4 | 5/5 / 601 | 0.84 | 3.95 |

**Against main.** Panes on stone below main on all six. Holes at or below main on four; Penn 2 (1.33 vs 1.08) and
Flatiron (0.84 vs 0.68) stay above it. The audit's masks (`measureVisibleDefects` with `keepMasks`) show what the
difference is: on Penn 2, 1-pixel (0.15 m) vertical slits along every recessed window strip in the 180° view, the scan's
back faces (`relief_m8`, `relief_m11`) showing through the lattice/scan cut line; main has the same slits on the few
facades where it recesses strips. On Flatiron the extra is a 12 m² region on the wall sheet 10000 at 315° and the corner
joins. Both are the K cut seam at recessed strips, not the glass path; the large regions (Penn 2's 86 and 70 m², Flatiron's
43 m²) are the same on both sides. Reported to MAIN for the push decision; not pushed.


## Rounds five to eight (MAIN, 2026-11-07: "hold, and fix the cut-seam hairline first")

MAIN held the push over Penn 2 and Flatiron's holes above main. The audit's own rays, shot at its red pixels and listing
every surface along the way with its node and facing (`probe.ts`, beside the benchmark), found two causes, neither a
crack to weld:

1. **Scan slivers standing across a rebuilt cell** (b34b0c77). A window reveal or a fin's side in the scan, perpendicular
   to the wall, was never a candidate of the rebuild's claim (`facesFacade` took only triangles facing the facade), so it
   stayed inside the rebuilt cell and showed its back as a 1-pixel line from the side: Penn 2's window strips at 180°.
   A triangle within 0.3 of perpendicular is now the facade's to remove when it lies over built cells, TypeScript and
   native; with `sameFacing` a thin wall's other side, facing away, is still left alone. Round five: Penn 2 holes 1.33 →
   0.93%, Seagram 1.73 → 1.70, Flatiron 0.84 → 0.81 (its cause was another).
2. **A lattice's end cells where the wall turns away** (3e245788, a9d558f1). The Flatiron's Fifth Avenue wall sheet
   (10000) built its last cells on the plane where the rounded prow had already curved 0.3-0.6 m inward (the scan on the
   plane at s 27.0 measures -0.6 m, the sheet's end cell -0.02), so the sheet's end stood proud of the wall and its back
   showed as a 1-pixel column over the whole height from 315° (12 m²). From each end of a row inward, at most three
   cells, a built wall cell whose own scan lies more than `edgeStepM` (0.25 m; 0.4 m missed the prow cell at -0.3) behind
   the row's wall depth now keeps the scan; windows and strips keep their own rules. Rounds six and seven: Flatiron 0.81 →
   0.75 → 0.63%, and the build "complete", not degraded.

Then, on MAIN's note that main had moved (#174's CDT caps, #179's DAG weld, #176's UV unwrap), main 9d282b44 was merged
into the branch (two documentation conflicts) and **all six buildings were rebuilt on both sides**: main at its head
9d282b44 (a fresh baseline, `main/`; the old 70edef82 builds under `main-70edef82/`) and the branch with main merged
(da786449, round eight, `feat/`; the earlier rounds under `feat-round4/` to `feat-round7/`). Three runners at once put the
machine at load 100 and the main ESB hit tile_refine's 900 s limit; it was rebuilt alone. The main runner's sheet step
(main's code) overwrote both sides' `result.json` from the set-aside folders; they were restored from each checkout's
ledger (`restore.py`, rows marked `rebuiltFromLedger`), the numbers below.

| Building | side | glass % | panes on stone | cells | triangles | bays read + gen | reader planes / windows | holes % | untex % |
|---|---|---|---|---|---|---|---|---|---|
| Lever House | main 9d282b44 | 1.37 | 48 (+2 bays) | 22,299 | 94,470 | 6 + 1 | 10/38 | 2.89 | 3.36 |
| | branch da786449 | 9.40 | **1** | 12,498 | 84,074 | 11 + 1 | 8/16 / 362 | 2.91 | 2.91 |
| Seagram | main | 7.83 | 185 (+5 bays) | 121,412 | 435,271 | 14 + 0 | 7/34 | 2.20 | 2.69 |
| | branch | 18.53 | **7** | 56,367 | 309,415 | 12 + 0 | 11/12 / 3,373 | **1.72** | 3.05 |
| ESB | main | 8.35 | 407 (+114 bays) | 162,605 | 861,838 | 192 + 30 | 58/120 | 0.73 | 0.39 |
| | branch | 6.16 | **67** | 160,868 | 920,887 | 184 + 35 | 59/67 / 7,303 | **0.36** | 0.37 |
| 30 Rock | main | 9.98 | 345 (+65 bays) | 216,642 | 1,074,391 | 362 + 52 | 60/120 | 0.53 | 0.53 |
| | branch | 7.95 | **7** | 246,271 | 1,206,475 | 277 + 57 | 49/63 / 6,088 | **0.46** | 0.46 |
| Penn 2 | main | 6.71 | 307 (+71 bays) | 210,018 | 965,120 | 42 + 56 | 11/71 | 1.08 | 1.67 |
| | branch | 11.58 | **0** | 74,411 | 445,684 | 48 + 46 | 10/19 / 664 | **0.92** | 1.51 |
| Flatiron | main | 8.58 | 89 (+3 bays) | 62,296 | 229,779 | 11 + 12 | 5/14 | 0.67 | 4.04 |
| | branch | 10.16 | **27** | 66,217 | 263,633 | 14 + 4 | 5/5 / 601 | **0.62** | 3.97 |

**Against main's head.** Panes on stone below main on all six (main's own numbers moved with its reads: Lever House
28 → 48, ESB 366 → 407, Penn 2 169 → 307 against the 70edef82 builds; the branch's are 0-67). Holes below main on five;
Lever House is 2.91 against 2.89, two hundredths of a point, with the same regions on both sides (the 430 m² region on
its wall sheet 10010 at 180°, 424 m² on the branch; relief_m18, facade 4). The ESB's holes halved (0.73 → 0.36) once the
slivers went. Cost of rounds five to eight and the fresh baseline: about $2.60 in model calls.

**What #165 (the window-array session) would move.** Its step runs after `mergeReadings`, so the template's snapped
boxes feed it: a strip on one lattice column folds into storey cells where the photo's storey pitch agrees (the Seagram
and 30 Rock strips, their cells and triangles), window sizes from the photo folded at the lattice (Seagram 16's window
height 2.26 → 2.49 m, so its glass share), its region model's bands (which planes lay a lattice at all), and generated
windows at occluded sites inside an array (the generated-window counts). The slit fix holds for recessed cells as it
does for strips: it removes slivers over any built cell, whatever the cell's depth.
