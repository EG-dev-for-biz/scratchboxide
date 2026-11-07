# Pipeline K: a window array per facade, inferred from the boxes (2026-11-06)

**Question.** The user looked at the Seagram Building's facade 6 (the window boxes from `sbFacadeLattice.windows.uv` over the
straightened photo) and said: with this much pattern input we should be able to infer an array. The upper half of that
facade is one clean grid (one column pitch, one storey pitch, one box size); the lower half's boxes sit off that grid and
oversized, because the window fit reads each band on its own from a dimmer part of the photo, the middle is read as
strips, and nothing afterwards checks a band's grid against the facade's. Then, on the first version: "we could do much
better at inferring patterns" — a site-by-site test left the dim bottom third patchy though the facade's pattern is obvious.

**Answer.** A new step, `pipeline-k/window-array.ts`, after the window fit and the facade reader's merge and before the
wall grammar, wall sheets and lattice. It fits one lattice per facade by consensus over every box, folds strips on
lattice columns into the array's cells, judges every lattice row and column by its sites together, and inside the rows and
columns that hold the array fills every empty site unless the photo contradicts a window there. On the Seagram's facade 6
every arrayed facade now reads 1.38 m columns and 3.65 m storeys from top to bottom; the lobby and the crown, where the
evidence stops, stay as read.

## 1. What the step does

- **The lattice.** The column pitch and phase from every box's centre (strips included: a strip stands in its column), the
  storey pitch and phase from the rows the single-site boxes form (rows weighted by their boxes). A pitch is found by a
  spacing histogram over the pairwise distances: each candidate pitch (1% steps, 0.8–12 m, never under the boxes' own size)
  scores the distances that are a whole number of it within a tolerance of 15% of the boxes' own size (their centres
  jitter by a fraction of a box, whatever the pitch), farther multiples counting less (`1/k`), and the smallest pitch that
  reaches three quarters of the best score is taken at its local peak: a multiple of the pitch scores about as much, its
  half about half, so the pitch itself is the smallest to reach the bar. The phase is the densest bin of the centres modulo
  the pitch, then the mean of that bin's members. The pitch is refined by least squares over the distances that fit it, the
  nearer multiples first, the farther ones as the estimate sharpens (`consensusPitch`, `consensusPhase`).
- **Tiers.** A contiguous run of at least 3 rows off the facade's row lattice (centre farther than 0.25 pitch from a site,
  or boxes of another size) is tried as a tier of its own: its own pitch and phase, kept only when its fit is clean (RMS
  under 0.12 pitch), its pitch differs from the facade's by more than 5% (else it is a drifted band, snapped instead), and
  the photo separates window from wall more clearly under it than under the facade's lattice over those rows (CIELAB
  distance between each site and the wall beside it, averaged; the tier must gain 10%). Numbers decide, never a name for
  what the tier is.
- **Each box.** By its distance to its nearest site (in pitches) and its size against the lattice box (the median of the
  boxes on a site): left as read only when it sits within 0.08 pitch of its site and within 15% of the lattice box's size;
  else moved onto its site as the lattice's box (snapped, its panes carried along) or, when its size was off by more than
  35%, replaced; both photo-inferred, since the photo had a box there (user direction, 2026-11-07: one array has one box,
  so the dim rows do not keep the varying heights of a bad reading). A second box on a taken site is dropped; a lattice
  that would drop a fifth of the boxes that way does not explain the facade, which is left as fitted. A box whose area is
  under 0.4 or over 3 times the lattice box's is not of the array: kept as read, taking no site (a small opening on a
  facade of strips, a doorway among windows). A box spanning more than 1.6 sites on an axis is a strip or a
  bay: on a facade read mostly as cells, a strip one column wide standing on a lattice column is folded into the cells it
  covers (photo-inferred; its panes go to the cell they lie in); a wider bay, or a strip on a facade read mostly as strips,
  is kept whole and its sites are taken.
- **The majority.** A facade holds an array only when at least 12 single-site boxes, and half of those of the array's
  size, sit on the lattice at its size. Else it is left exactly as fitted, with the reason in the note.
- **The extent and the empty sites.** Every lattice row and column the photo spans is judged by its sites together: it
  holds the array when a quarter of its sites hold a box, or, within 2 rows or columns of the boxes' own extent, when
  its sites on average show the contrast the neighbouring
  windows (within 3 rows) show against the wall beside them — a relative CIELAB test (the site's look less the wall's just
  left and right of it, projected on the members' contrast vector), so a dim part of the photo reads like a bright one.
  Inside the rows and columns that hold the array every empty site takes the lattice's box (generated): a site too dim to
  confirm on its own, or one the photo never reached, is filled on the array's evidence (user direction, 2026-11-07: "we
  are not using our abilities if we cannot infer that this is an array of evenly spaced windows all the same size"); a site
  is withheld only where the photo reads the opposite of a window (that contrast under minus a quarter of the windows'),
  something stood in front of it (occlusion mask, over 35%) or a bay covers it. Outside those rows and columns nothing is
  added. The confidence of an added site is its contrast share; of a moved one, its distance.
- **Blank bands** (user direction, 2026-11-07, relayed by the materials session: Penn 2's top storeys under the mechanical
  roof came out as a blank box with smeared window shapes while the grid below was clean). From a row or column that holds
  the array it steps on through contiguous blank rows and columns — their sites' texels mostly unreached (the uncovered
  mask) or featureless (`facade_<id>_featureless.png`: a smear its own repeats did not refill) — at its pitch and phase,
  each site `continued` (generated, with the reason in `array.continued.reason` and the extras), until a row or column the
  photo reads that does not hold the array (a louvre screen, a setback: the evidence changes), or the photo's edge. An
  unreached band at a photo's top edge is entered only below the structure's roof line (`groundY + heightM`, passed from
  the orchestrator as `envelopeTopY` and turned into the photo's first allowed row through the plane frame), never above
  it; a blank column is never continued sideways past the photo's reach, where no envelope says the wall goes on.
- **Panes.** A snapped box's own panes move with it; a replaced, folded or added box takes the pane layout of the nearest
  box on the lattice with panes.
- **Provenance and repeatability.** Snapped, replaced and folded boxes are photo-inferred; added ones are generated, in
  the window fit's `generated` list (so `sbFacadeLattice.windows.generated` carries them) and in
  `sbFacadeLattice.windows.array` (the lattice, the counts, the moved, replaced and folded boxes' UVs). The pre-array boxes
  stay in `window_fit.json` under `array.in` with every site's box, kind, confidence and residual (`array.sites`), so the
  step is repeatable: an entry already carrying this version is not inferred again, one carrying another is restored first.
  The run note `pipeline_k_window_array` reports per facade: boxes in, pitches and phases per tier, on, moved, replaced,
  folded, kept, added, dropped, the rows and columns holding the array, the input and output RMS in pitches, and why each
  empty site was not filled. On unless `SCRATCHBOX_K_WINDOW_ARRAY=0` or the node graph's `remesh.windowArray` is off.
- **Not done.** One column lattice per facade (a tier may have its own storey pitch, not its own column pitch); a wall sheet
  built from several facades carries no `array` extras (its windows come from the arrayed fit, but the sheet's node names
  no array); nothing is folded on a facade read mostly as strips.

## 2. Offline, on kept caches (the step alone, before any build)

Seagram, the window fit's boxes from the 2026-11-06 glass benchmark's main-side cache (`relief_orthos_k_dd7178e1f54a7a3d`):

| Facade | Boxes in | Column / storey pitch | On | Moved | Replaced | Strips folded | Kept as read | Dropped | Added | RMS in → out (pitches) |
|---|---|---|---|---|---|---|---|---|---|---|
| 6 (the user's) | 487 (71 strips) | 1.38 m / 3.66 m | 220 | 58 | 120 | 69 | 4 | 14 | 92 | 0.107 → 0.032 |
| 3 | 108 | 1.41 m / 3.66 m | 86 | 7 | 11 | 1 | 0 | 0 | 14 | 0.063 → 0.031 |
| 10 | 204 (58 strips) | 1.42 m / 3.63 m | 108 | 14 | 20 | 36 | 0 | 4 | 46 | 0.147 → 0.028 |
| 14 | 80 (19 strips) | 1.39 m / 3.66 m | 28 | 10 | 12 | 13 | 11 | 0 | 14 | 0.136 → 0.024 |
| 15 | 84 (17 strips) | 1.42 m / 3.56 m | 32 | 13 | 15 | 17 | 7 | 0 | 59 | 0.237 → 0.025 |

The other twelve facades are left as fitted: fewer than 12 boxes, or no majority (facade 0, read as 243 strips of many
heights; facade 8, 10 of 13 on the lattice).

30 Rock's low block (facade 0, 131 x 48 m, an ortho that merges several surfaces): 127 boxes of which 42 small ones are kept
as read (not of the 1.39 x 11.4 m strip array), 45 strips snapped, 18 replaced, 10 folded, 5 added; a narrow face (54, 6.7 m
wide, rows jittering 3.1–5.1 m apart) is left as fitted, "24 of 51 on the lattice: no majority".

Three things the first version got wrong, found on these caches and fixed before the builds:

1. A sloped scoring kernel let a doubled or tripled pitch, with a proportionally larger tolerance, outscore the pitch
   itself on jittery rows (facade 14 at 7.4 m, facade 3 at 11.6 m). Now a flat kernel and the smallest pitch at three
   quarters of the best score.
2. A site-by-site colour test (nearer the windows' colour than the wall's) rejected most empty sites on a curtain wall whose
   dark glass and bronze mullions are near one another in colour, and left the dim bottom third patchy. Now the relative
   contrast test and the row-and-column judgement above.
3. A run of rows with the facade's own pitch but a shifted phase passed as a tier (30 Rock facade 54); a small box was
   replaced by a full strip (30 Rock facade 0). Now a same-pitch run is drift, and a box far from the array's size is kept.
4. A tolerance proportional to the candidate pitch let a large pitch sweep up two or three of Lever House's 1.15 m rows at
   every multiple and outscore the true pitch (facade 11, the slab: 754 reader boxes on a perfect 1.16 x 1.46 m lattice,
   given 8.1 m rows and left as fitted for dropping 209). Now the tolerance is a share of the boxes' own size: the slab
   reads 1.159 m x 1.464 m, 689 boxes on the lattice, 59 moved, 12 added.
5. A blank band was entered sideways and above the array wherever it was featureless, which on the Seagram's facade 15 (an
   ortho that merges the tower with a neighbour's smeared wall) placed 524 sites on the neighbour. Now a blank run is
   entered only between two rows (columns) that hold the array, or up to the roof line.
6. A lattice read at a crown alone was carried down the whole facade: Lever House's long face (facade 4) had 85 reader
   boxes, 0.54 m tall, in the top 6 m of a 92 m slab, and every row below held the array on its contrast alone (glass
   bands do read as windows), giving 527 added sites at 0.83 m rows in tidy clusters that are nothing like the slab's
   3.7 m bands. Now a row or column holds the array on its contrast alone only within 2 rows (columns) of the boxes' own
   extent; farther away only its boxes count. Rows are also never nearer than the boxes are tall.
7. The facade reader's boxes come at fractional pixels, and a texel loop over a fractional box reads nothing (its indices
   fall between texels): every reader box's contrast was silently unread, so the rows held on occupancy alone and the
   empty sites were filled as "unreached". Now every box is rounded to whole texels on input (the overlay tool too, whose
   fractional strokes had been landing on the wrong colour channels).

## 3. Builds

| Building | Build | Facades arrayed | Boxes in | On | Moved | Replaced | Strips folded | Kept as read | Dropped | Added | Stepped into blank bands | Step time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Seagram Building | degraded, 10.6 min, run 4c52fba5 | 5 of 21 | 1159 | 1061 | 31 | 17 | 29 | 3 | 0 | 135 | 682 | 978 ms |
| 30 Rockefeller Plaza | degraded, 8.0 min, run 04ad2d4c | 23 of 68 | 1640 | 1109 | 469 | 12 | 28 | 3 | 8 | 54 | 14 | 1705 ms |
| Lever House | degraded, 6.3 min, run 7ed3094e | 5 of 19 | 171 | 104 | 42 | 10 | 4 | 3 | 3 | 73 | 24 | 294 ms |
| Penn 2 | degraded, 4.9 min, run 9841ff38 | 6 of 41 | 916 | 665 | 88 | 114 | 12 | 23 | 9 | 174 | 121 | 1543 ms |

All four built uncached on `feat/k-glass-openings` at 79356a68 plus this branch, run8 of 2026-11-07 (the branch was then
rebased onto that branch's tip cb53ba08, whose five commits key the reader's answers by the straightened photo, vote the
reader's windows as strips in the wall grammar and name the windows' source in the lattice extras; none touches the array
step) (the facade reader's accepted boxes merged into the window fit, then the array step), in `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-06-window-array-glass/glass-array/<place>/` (kept caches, run notes, models). The runner's `result.json` carries a stale commit and run id from an earlier row of the checkout's ledger (a runner quirk, not fixed here); the run ids above are from each `tool_result.json`, the times from `run8.log`. Every build is degraded for the reasons the outside check and the survey already report on main (holes, an unsurveyed face), not for the array step. The busiest facades:

- Seagram Building facade 9: 630 boxes in, 1.534 m columns, storeys 3.645 m; on 592, moved 0, replaced 1, folded 16, kept 3, dropped 0, added 0, continued 0; rows holding 40, columns 16; RMS 0.037 → 0.022 pitches.
- Seagram Building facade 12: 279 boxes in, 1.699 m columns, storeys 3.646 m; on 279, moved 0, replaced 0, folded 0, kept 0, dropped 0, added 29, continued 0; rows holding 31, columns 10; RMS 0.014 → 0.014 pitches.
- Seagram Building facade 15: 126 boxes in, 1.669 m columns, storeys 3.624 m; on 125, moved 0, replaced 1, folded 0, kept 0, dropped 0, added 31, continued 0; rows holding 32, columns 5; RMS 0.033 → 0.02 pitches.
- 30 Rockefeller Plaza facade 18: 303 boxes in, 2.484 m columns, storeys 3.503 m; on 171, moved 126, replaced 3, folded 0, kept 0, dropped 1, added 4, continued 0; rows holding 58, columns 6; RMS 0.259 → 0.006 pitches.
- 30 Rockefeller Plaza facade 13: 275 boxes in, 2.531 m columns, storeys 3.504 m; on 164, moved 110, replaced 0, folded 0, kept 0, dropped 0, added 1, continued 0; rows holding 55, columns 6; RMS 0.194 → 0.011 pitches.
- 30 Rockefeller Plaza facade 14: 123 boxes in, 2.045 m columns, storeys 3.504 m; on 112, moved 3, replaced 1, folded 6, kept 0, dropped 1, added 0, continued 0; rows holding 57, columns 2; RMS 0.106 → 0.013 pitches.
- Lever House facade 16: 60 boxes in, 1.351 m columns, storeys 2.63 m; on 58, moved 0, replaced 0, folded 0, kept 0, dropped 0, added 34, continued 0; rows holding 34, columns 3; RMS 0.008 → 0.009 pitches.
- Lever House facade 7: 51 boxes in, 2.889 m columns, storeys 0.857 m; on 9, moved 31, replaced 8, folded 0, kept 2, dropped 1, added 26, continued 0; rows holding 7, columns 11; RMS 0.248 → 0.035 pitches.
- Lever House facade 3: 21 boxes in, 3.216 m columns, storeys 3.686 m; on 18, moved 3, replaced 0, folded 0, kept 0, dropped 0, added 0, continued 0; rows holding 3, columns 6; RMS 0.068 → 0.024 pitches.
- Penn 2 facade 16: 428 boxes in, 5.943 m columns, storeys 3.281 m; on 420, moved 0, replaced 0, folded 0, kept 5, dropped 0, added 22, continued 54; rows holding 26, columns 18; RMS 0.033 → 0.009 pitches.
- Penn 2 facade 9: 147 boxes in, 2.92 m columns, storeys 3.591 m, 0.952 m; on 45, moved 34, replaced 60, folded 0, kept 7, dropped 0, added 60, continued 39; rows holding 20, columns 11; RMS 0.168 → 0.024 pitches.
- Penn 2 facade 34: 112 boxes in, 6.007 m columns, storeys 7.18 m; on 78, moved 8, replaced 13, folded 0, kept 8, dropped 5, added 0, continued 14; rows holding 14, columns 7; RMS 0.122 → 0.019 pitches.

## 4. Sheet

![Window arrays: Seagram, 30 Rock, Lever House, Penn 2](./k-window-array/2026-11-06-sheet.jpg)

Sheet: [k-window-array/2026-11-06-sheet.jpg](./k-window-array/2026-11-06-sheet.jpg) (also in the session notes folder as
`k-window-array-sheet.jpg`, with the per-facade overlays `k-window-array-<place>_<facade>.png`). The builds, their kept
caches and the overlays: `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-06-window-array-glass/` (the main-base
builds of the first version, for comparison: `.../2026-11-06-window-array/`).

Left of each pair: the boxes as the window fit and the facade reader read them (magenta). Right: after the step — on their
site or kept as read (magenta), moved or replaced (cyan), strips folded into cells (orange), added (yellow), bays kept whole
(green).

**Spot counts** (a small vision model, Claude Haiku, counting on clean crops of the straightened photo against the boxed
result, told nothing about what the step should do; its counts are visual estimates):

- Seagram facade 9, four storeys mid-tower: 15 to 16 openings per storey read in the photo, 16 boxes per row drawn, the
  box edges on the mullion lines (the boxes sit on the glass, none on a pier); the boxes may start 15 to 30 px above each
  cell's top, reaching into the bronze band (low confidence at the crop's resolution).
- 30 Rock facade 18, seven storeys of a narrow stone face: 7 openings per storey, 7 rows of boxes; the three left columns
  on their openings; two columns (moved, cyan) about 37 px (0.6 m) left of their windows, two thirds on the pier: this face
  has a wider pier between its third and fourth window columns, and one translational lattice cannot hold both groups
  (a known limit: a second column phase per group would). One column is a strip the reader read whole, not split by storey.
- Penn 2 facade 16, the top: the washed-out storey under the parapet carries boxes at the same 12 columns as the storeys
  below (the direction's case); the top continued row starts about 25 px (1.9 m) inside the pale parapet strip, so the
  structure's scan height sits a little above the parapet line; the washed zone is split into three rows at the lattice's
  3.28 m pitch, with no edge in the photo to confirm the split (it is the array's, as intended).

Open items from these counts: an irregular pier breaks the single column lattice on a stone face (30 Rock 18); the
envelope is the scan's height, not the vector's, so a continued row can start inside the parapet (Penn 2 16); a facade
whose reader boxes cover only the crown (Lever House 7, the slab's long face read as 51 small boxes at the mechanical
band) stays at the crown, so the slab's bands are not boxed at all on that run — the reader's reading, not the array's.

## 5. Tests

`packages/core/test/pipeline-k-window-array.test.ts` (synthetic 30 x 60 m facades at a 3 x 4 m grid): the consensus pitch
against a noisy minority; a drifting, oversized lower half brought onto the upper half's array with the empty sites filled
(150 of 150, RMS under 0.03 pitch); two genuine tiers (4 m and 6 m storeys) kept, the base's own pitch winning on the photo;
an occluded span and unreached rows getting nothing, three flanked sites in a row filled; strips on lattice columns folded
and a faint row filled from the rows around it; a box of another size kept as read and a site that reads as wall left
empty; a facade with no majority grid left exactly as it was; `window_fit.json` rewritten once and not inferred twice.
With `staged-build-steps-graph`, `window-fit`, `pipeline-k-facade-reader`, `pipeline-k-twin-reader`,
`pipeline-k-material-regions` and `instruction-tool-drift`: 163 tests pass on Node 22.18; `npm run typecheck` clean.

## 6. Files

- `packages/core/src/node/3d-engine/staged-location/pipeline-k/window-array.ts` (new), its test, and
  `scripts/window_array_overlay.ts` (the before/after overlay from `window_fit.json` or a model's extras; `--infer` runs
  the step on a copy of a kept cache).
- `orchestrator.ts`: the step after the window fit and the reader's merge; `facade-lattice.ts`: `windows.array` in the
  extras; `window-fit.ts`: `regionLook` exported; `staged-build-steps.ts`: the step and its switch.
