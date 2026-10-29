# SB-Fenestra: windows fitted to a facade, one model for geometry and materials

Date: 2026-10-27. Status: shipped as `window-fit.ts` (commits 68787d84, 9284a058, d1c8c91a, 415927dc, a3f2027f,
2026-10-27/28); the lattice and material regions read its fit per §11.16's close. This doc is kept as the record of how
that model was reached — read §11 for what's already in the repo before adding a new heuristic. Scope: staged-location
building rebuilds (pipeline K first); the model is generic (any facade with repeated openings), not ESB-specific.

## 1. Problem

Pipeline K answers "where is a window" four times, with four unrelated heuristics, and they disagree:

| Where | Heuristic | What it actually finds |
|---|---|---|
| `tile_refine` photometric relief (`scratchbox_photometric_relief.hpp`) | dark cells confirmed by repetition (`facades.json` `cells`, `latticeConfirmation`) | dark rectangles, used for analysis only in K (`reliefCarve: false`) |
| lattice lines (`facade-lattice.ts` `photoLattice`) | peaks of edge energy along s and t | pier edges, cornices, stains as often as window edges |
| lattice windows and recesses (`windowGrid`, `PHOTO_RECESS`) | a cell where a darker column crosses a darker row, darker than the wall | cells of a grid whose lines are not window edges, so windows come out offset or half-filled |
| material regions (`material-regions.ts`) | pier rhythm per wall face and height band; glass = CIELAB k-means regions accepted by a lattice test | bays as full-height columns; glass as colour blobs |

Seen on the ESB (uncached runs 6dfc7344 and 2508d55f): base glass panes sit beside the dark windows of the photo, some
half-filled or triangular; white blotches near the crown where glass blobs were drawn; a pale glass sliver in the tower's
slot. Each fix to one heuristic exposed the next. Nothing in the pipeline says what a window is.

## 2. Idea

A native module, like SB-Veggie for vegetation, whose output is a **parametric description of a facade's openings fitted
to the evidence**, from which every later step reads: the lattice's lines and recesses, the material regions' glass and
frame, generated detail where the photo is missing. Fitting replaces guessing; one model replaces four.

## 3. The model (continuous parameters only)

Per wall band (a wall face's height band, as material regions already groups them: coplanar walls overlapping in height):

- **Grid** (operator 3, the affine metric replicator): horizontal pitch `ps` and phase `φs`, storey pitch `pt` and phase
  `φt`, the band's extent in s and t. Optionally a second interleaved column set (paired windows in a bay) as a second
  phase within the pitch.
- **Opening profile** (one per band, shared by its cells): width `w`, height `h`, sill offset within the storey `sill`, head
  rise `r` (0 flat, rising for segmental or round heads), corner radius `ρ`, frame width `fw`, mullion count and transom
  position, reveal depth `d`.
- **Per cell**: `present` (blind bays, missing windows, a shopfront in the grid) and small offsets `(δs, δt, δw, δh)`
  bounded to a fraction of the pitch.

No window-type enum: an arched window, a ribbon window, a square punched window and a curtain-wall mullion grid are all
points in this space (ADA, AGENTS.md section 1).

## 4. Evidence

All per facade, in its straightened ortho frame (metres along s and t):

1. **Darkness** of the straightened, de-lit photo (openings read darker than wall).
2. **Edge energy** along s and t (window jambs and sills).
3. **Uncovered mask**: texels the photo never reached are no evidence (filled texels excluded).
4. **Relief cells** from `tile_refine` (`facades.json` `cells`: s/t bounds, contrast, the relief's lattice confirmation):
   an independent detection, used as a prior and a check, not as truth.
5. **Scan depth** where the scan resolves a recess (rarely at 1 m geometric error, but free).
6. Optional, off by default: open-vocabulary segmentation of the ortho ("windows", `vfx_segment_subject`), as one more
   evidence map. Bills per call; never in tests.

## 5. Fitting

1. **Grid**: 2D autocorrelation of the darkness map over the band: the strongest repeat in s within a plausible pitch
   range, and in t within a storey range; phases by matching a box comb. Scored by the normalised peak height.
2. **Opening profile**: render the candidate opening at every grid node and maximise the correlation with darkness plus the
   alignment of its edges with edge energy, over all repeats at once (a stained or open window does not move the shared
   profile). Coarse grid search, then a few refinement steps.
3. **Per cell**: `present` by the cell's own match score against the band's distribution; offsets by 1D edge profiles
   inside the cell, bounded.
4. **Validation**: per band, the IoU of the fitted openings against the photo's dark-opening mask (threshold from the
   band's own histogram), the grid's repeat score, and the agreement with the relief cells. Below thresholds, the band has
   **no fitted windows** (and says why), rather than wrong ones.

## 6. Output and consumers

Window instances per facade: rectangles (with head rise, frame, mullions) in the facade frame and in the photo's UVs,
each with a confidence and provenance (`photo-inferred`; `generated` where the grid is carried into texels the photo never
reached, with that reason). Written once, into the rebuilt facade's extras, read by:

- **Lattice** (`facade-lattice.ts`): its s/t lines at window edges; the recess on exactly the window rectangles, with sill
  and head reveals. UVs stay linear in s/t (the seal's requirement).
- **Material regions**: glass inside the frame, the frame as metal, everything else wall finish. Replaces CIELAB glass blobs
  and the per-cell window drawing. Bays (pier rhythm) stay for curtain-like walls where the fit is a full-height ribbon.
- **Native geometry** (phase 2): frames and mullions as swept profiles (operator 1), reveals as relief fields (operator 4),
  compiled in C++ (AGENTS.md section 3.1), never JS primitives.
- **Believable fill**: in a facade's uncovered or occluded texels, the fitted grid continues, labelled generated.

## 7. Risks

- **Not every wall is a grid.** Shopfronts, entrances, setback crowns. `present` and per-band fits absorb some; the rest
  must fail honestly (no windows) and be reported.
- **Resolution.** About 0.08 m per ortho texel on the ESB (0.15 m for the tile photo): an ESB window is 12-16 texels wide.
  Enough for position and size; mullions and frames are near the limit and will often be generated (labelled).
- **Overfitting.** A matcher finds grids in noise. Phase 0 must measure false fits on bands known to be blank.
- **Ownership.** The lattice is the straightening session's code; the change replaces its line finding and recess rule.
  Agree before phase 1.
- **Cost.** Fitting is CPU only; the server's main thread already blocks 30 s while texturing, so the fit belongs in the
  native module or a worker.

## 8. Plan

- **Phase 0 (prototype, offline, no pipeline change):** fit grid and opening profile per facade on the ESB's straightened
  orthos; overlays for base (facades 17, 4, 46, 3), tower (0, 11, 49) and crown (70, 74); per-band scores; false-fit check
  on blank bands. Decide go/no-go from the overlays.
- **Phase 1:** window instances in the facade extras; lattice and material regions read them; the four heuristics retired.
- **Phase 2:** native frames, mullions and reveals; generated continuation into uncovered texels.

## 9. Phase 0 results (2026-10-27, ESB, run 2508d55f's straightened orthos)

Prototype: a Python script outside the repo (numpy only, about 6 s for 11 facades), one band per facade:

- grid pitch by autocorrelation of column and row darkness;
- the darkness folded onto one grid tile (all repeats averaged), and up to two rectangles fitted in the tile by
  contrast × the edge strength along their boundary;
- each grid node present or absent by its own contrast against a surround band;
- IoU against an Otsu dark mask.

Overlays: `docs/screenshots/2026-10-27-fenestra-p0-*.png` (gitignored).

Three iterations, each telling:

1. **Darkness only (contrast per rectangle).** Fits the darkest band of the storey, not the window: on base facade 17, a
   4.3 x 1.8 m box over the head of each window pair.
2. **Plus edge strength along the boundary (jambs, head, sill).** Single windows found, 1.1 x 1.8 m, but one of each pair,
   and the grid smeared by the base's sections, whose groupings differ along the wall.
3. **Darkness against the local wall (a 4 m box mean) instead of the facade's.** Darkness alone had marked 36-64% of each
   facade dark; this brings it to 28-46%, and base facade 17 fits one 3.9 x 2.3 m opening per window pair, on the pairs.

| Facade | Pitch s x t (m) | Opening (m) | Present / absent | IoU | Verdict |
|---|---|---|---|---|---|
| 17 base | 5.72 x 4.10 | 3.87 x 2.32 | 58 / 72 | 0.27 | on the window pairs; absent where the base's sections change |
| 4 base | 3.32 x 4.09 | 2.62 x 0.62 | 68 / 62 | 0.13 | a sill band, not windows |
| 46 base | 5.72 x 4.18 | 1.55 / 1.86 x 1.31 (pair) | 89 / 30 | 0.28 | pair found, short |
| 0 tower | 5.70 x 3.47 | 1.23 x 2.31-2.39 (pair) | 268 / 798 | 0.15 | windows in the bays, central slot and piers left |
| 11 tower | 5.80 x 3.48 | 1.01 x 3.09 | 118 / 329 | 0.06 | thin |
| 49 tower | 5.55 x 3.47 | 0.62 x 3.08 | 335 / 47 | 0.17 | iteration 1 gave 3.78 x 3.08, IoU 0.76 (the whole bay) |
| 74 crown | 2.85 x 6.48 | 0.77 x 4.55 | 5 / 14 | 0.21 | weak |
| 2 ground | 8.26 x 6.48 | 0.77 x 5.79 | 0 / 10 | 0.00 | correctly no windows |

What it shows:

- **Grids are real and found.** The pitches agree across facades and with the material regions' bay pitch: about
  5.7-5.9 m bays and 3.5 m tower storeys, 4.1 m base storeys. The ground floor (2) gets none.
- **One band per facade is too coarse.** The base changes its window grouping along the wall, so one fold averages
  different groupings. The model needs bands along s as well as t: change points in the column profile.
- **"Punched window" and "bay" are one continuum, and the fit must choose by evidence.** On the tower, iteration 1's
  full-bay box (IoU 0.76 on 49) matches better than single windows, because the tower's bays are window-and-spandrel
  ribbons. The profile already allows it (opening height up to the storey pitch); the fit should score both and keep the
  better, not prefer one by construction.
- **Darkness is weak evidence on its own; edges and the local wall matter.** The relief cells (`facades.json`) and a
  segmentation map are the next evidence to add.
- **Not yet good enough to drive geometry.** Base IoUs of 0.13-0.28 would still place glass beside windows. Phase 1 should
  wait for:
  1. bands along s;
  2. a ribbon-or-punched choice scored by evidence;
  3. the relief cells as a prior.

  Then re-measure on the same overlays.

### 9.1 Second pass: bands, punched or bay, relief prior

Changes (the second prototype script):

1. **Bands along the wall, then up it.** Change points by binary segmentation of the column profiles: each column is a
   vector of row darkness, smoothed over one bay so the rhythm itself does not split. Then the same within each band
   along t. Minimum 8 m along s, 10 m up.
2. **Punched or bay per band.** Two hypotheses fitted on the band's folded tile: punched (up to two rectangles,
   contrast × boundary edges) or bay (a full-storey-height opening, contrast × jamb edges). The one scoring higher on
   the evidence is kept; a band scoring under 0.12 gets no windows.
3. **Relief cells as a prior.** `facades.json` `cells` rasterised into the photo: 25% of the darkness the fit reads,
   and 40% of a band's score (IoU with the relief cells) where they cover over 2% of it.

Overlays: `docs/screenshots/2026-10-27-fenestra-p0b-*.png`.

| Facade | IoU, first pass | IoU now | Bands | Mostly |
|---|---|---|---|---|
| 17 base | 0.27 | **0.35** | 18 | punched; boxes on single windows of the pairs |
| 4 base | 0.13 | **0.27** | 2 | punched upper floors on the windows; the ground band fitted as bays (wrong: a shopfront zone) |
| 46 base | 0.28 | **0.33** | 9 | punched |
| 0 tower | 0.15 | **0.41** | 52 | bays on the window columns; fragments at the setback |
| 11 tower | 0.06 | **0.41** | 43 | bays |
| 49 tower | 0.17 | **0.40** | 14 | bays and punched |
| 74 crown | 0.21 | 0.17 | 3 | one bay band, the rest no grid |
| 2 ground | none | none | 4 | no windows (correct) |

Findings:

- **The evidence-scored choice works.** The tower chooses bays and the base punched windows, with no rule saying which.
  Upper base floors now sit on the punched windows.
- **Over-segmentation.** 52 bands on a 56 m tower facade, many with too little photo; the 18 on base facade 17 are partly
  real (the base changes its grouping), partly noise. Next: a minimum band score, and merging neighbours whose fitted
  grids agree, rather than a fixed split gain.
- **Ground floors need a third hypothesis.** Shopfront and entrance zones are not punched or bay; they should come out as
  no fit (or one large opening scored on its own), not as forced bays.
- **The relief prior helps little.** `tile_refine`'s cells cover 1-11% of a facade (dark-cell lattice confirmed only
  where it repeats), so they rarely move a fit. Keep them as a check, not a driver.
- **Still short of phase 1.** IoU against the dark mask tops out around 0.4, partly because the mask itself includes
  dark stone and shadow, so it is an imperfect yardstick. Phase 1 needs a better judge: a held-out set of a few facades
  with hand-checked windows, or segmentation masks as ground truth for scoring (not in tests).

### 9.2 Third pass: merged bands, a no-fit test, scored against checked windows

**Ground truth.** Three crops of about 300 x 300 texels (23 x 23 m):

- base facade 4: 30 punched windows in four rows and a central group; the shopfront band has none;
- base facade 17: 33 windows in pairs; its ground band has none;
- tower facade 0: 4 bays of window and spandrel down to the setback roof.

They were made by accepting or rejecting strongly dark connected components on enlarged crops and adding the missed
windows by eye. They were **checked by the agent, not by a person**, so treat them as a working yardstick.

**Changes:**

- **Merging:** neighbouring bands whose fitted grids agree (same hypothesis, pitches within 10%) are merged, and the merge
  is kept when its score holds. Base facade 17 went from 18 bands to 13, tower 11 from 43 to 37, tower 0 from 52 to 50.
- **No-fit test:** a hypothesis must beat the same openings moved half a pitch off its grid by 1.5x, as well as 0.12.

Window-level scores: a checked window is found when a fitted opening overlaps it by IoU 0.3 or covers half of it.

| Crop | Pass 2 (pixel IoU, found, correct) | Pass 3 |
|---|---|---|
| 4 base | 0.37, 23/30 found, 23/26 correct | same |
| 17 base | 0.18, 9/33, 9/30 | **0.25, 13/33, 13/39** |
| 0 tower | 0.30, 2/4, 2/11 | same |

Overlays: `docs/screenshots/2026-10-27-fenestra-p0c-*.png`.

What the checked windows show:

- **Facade 4 is close to usable:** 77% of windows found, 88% of fitted openings real. The misses are the irregular central
  group.
- **Facade 17's fits sit on the right windows but are too small.** They cover the darker upper part of each window only
  (its lower panes read lighter), so most fall under the match threshold. Position is right; size is the problem.
- **Snapping each opening's edges to the strongest step in the folded tile made it worse** (facade 17: 13 found, then 4):
  the folded profile's strongest steps are mullions and pane divisions, not the window's outer edge. Reverted. Snapping
  has to happen per window on the photo itself, or the template has to model a window as frame plus panes.
- **The no-fit test is too weak for shopfronts:** facade 4's ground band still fits as bays. Half a pitch off a blank band
  scores as well as on it only when the band is truly blank; a dark band of signage passes. That needs its own
  hypothesis (one large opening, or none) scored against the band above.
- **The tower is under-detected:** 2 of 4 bays, as narrow strips. The bays have lighter windows on dark spandrels, so
  darkness marks the spandrels, not the bay. The bay hypothesis should read the piers (the light columns) and take the
  space between them.

**Verdict:** the grid and position parts work (facade 4 at 77% recall and 88% precision); opening size and the tower's
bays need different evidence (per-window edge snapping, a pier-reading bay, a frame-and-pane template) before phase 1.

## 10. Reuse: most of SB-Fenestra already exists in the repo

A survey of the existing facade code (2026-10-27) finds the pieces the prototype was rebuilding.

| Piece of the design | Already in the repo | State on the ESB |
|---|---|---|
| Grid by autocorrelation, unit cell from the folded photo, punched-or-bay choice | `scratchbox_photometric_relief.hpp` (C++, runs inside `tile_refine` in pipeline K): `periodS`/`periodT` (pitch, periodicity, harmonics), `phaseS`/`phaseT`, `pattern` = `cells` or `strips-along-s`/`-t`, and cells kept where the lattice repeats (`minLatticeConfirmation`, `latticeFill`) | runs (analysis only in K); patterns over 90 facades: 56 cells, 13 strips along s, 4 along t, 17 none; cells sparse (1-11% of a facade) because only confirmed cells are written |
| Tiers of openings per band, bands spanning part of the width | `facade-grammar.ts` `FacadeGrammar` (`tiers: { t0, t1, cols: [s0, s1][] }`, storey heights, per-tier opening size and bay pitch), read by a vision model from the same orthos; `tile_refine --facade-grammar FILE` snaps the relief's cells to it | skipped in K; in earlier pipeline E runs (0bb75ce2, 1151b78d) **0 of 12 ESB facades accepted**: the model read no openings on the 250 m tower photos, and the smaller facades failed the held-out folds |
| Validation: held-out folds and a control off the grid by half a bay and a storey | `facade-grammar.ts` gates (stripes and bands hidden, edge chamfer and gradient NCC against the relief's lattice, the half-shifted control) | works as a judge; the prototype's 1.5x null test is a weaker copy of it |
| Registration of a built facade on the photo (glass on dark windows, walls on light) | `scratchbox_facade_guide.hpp` (slides within one bay and one storey, scores walls' brightness minus glass's) | used by procedural guides; the per-window snapping the prototype failed at |
| Openings of a group co-registered and averaged | `scratchbox_relief_average.hpp` (lattice units: openings scaled to the group's median, shift search, averaged per texel) | pipeline E; the opening-profile fit the prototype does by folding |
| Glass panes as an evidence mask | `facade-material-evidence.ts` + `facade-materials.ts` (open-vocabulary segmentation of Street View and tile renders, voted per region) | bills per call; pane-level, not window-level |

**Revised plan.** Do not write a new fitter. Compose these:

1. **Grid and unit cell:** the photometric relief, already run in K. Write its per-facade grid (pitches, phases, unit cell, pattern) into `facades.json` next to `cells`, and let it emit the full lattice (not only confirmed cells) with each cell's confirmation, so the consumer decides.
2. **Bands:** the grammar's tier structure (bands up the wall, each with its own columns) as the schema. It can be filled from the relief's per-band analysis (the relief's grid run on bands, as the prototype's change points split them) instead of the vision model where the model reads nothing, as on the ESB tower.
3. **Placement:** `scratchbox_facade_guide.hpp`'s registration slides each band's openings onto the photo within one bay and one storey.
4. **Opening size and profile:** `scratchbox_relief_average.hpp`'s co-registered average of the band's openings.
5. **Validation:** the grammar's held-out folds and half-shifted control, unchanged.
6. **Consumers:** the lattice's window cells and recess, and material regions' glass. Write the result once, as a `FacadeGrammar` per facade, so `tile_refine --facade-grammar` and pipeline E read the same thing.

New code is then mostly glue: the band split, running the relief and guide per band, and writing grammars. The
prototype stays as the yardstick: the checked windows (section 9.2) score each step.

## 11. Composing the existing pieces (2026-10-27)

### 11.1 The relief's grid, exported

`scratchbox_photometric_relief.hpp` `writeOrthoIndex` now writes a `grid` per facade into `facades.json`, beside `cells`:

- `periodS` / `periodT`: found, pitch, periodicity, harmonics;
- `cell`: foundS/T, s0, widthS, t0, heightT, phases, contrasts, and every dark run per period, `runsS` / `runsT`;
- `latticeRows`, `latticeCols`, `rowPitch`, `cellsTested`, `cellsAccepted`.

It is analysis output only; geometry is unchanged. Uncached ESB run b4c2e4e6. Base facade 4, for example: pitch
3.34 x 4.15 m, folded cell 1.31 x 0.82 m, longest run up the wall 1.91 m, 148 of 220 cells confirmed.

### 11.2 Scored on the checked windows

| Reading | 4 base | 17 base | 0 tower (bays) |
|---|---|---|---|
| Prototype, pass 3 | 23/30 found, 23/26 correct | 13/33, 13/39 | 2/4, 2/11 |
| Relief's confirmed cells (what K writes today) | 0/30 | 14/33, 14/34 | 0/4 |
| Relief's full lattice, folded cell size | 3/30, 3/42 | 12/33, 12/28 | 0/4 |
| Relief's full lattice, longest dark runs | 22/30, 22/42 | 16/33, 16/28 | 0/4 (pixel IoU 0.53: its cells are the windows inside the bays) |
| **Tiers from the relief's grid: every run at least half the longest, each cell present by its own contrast** | 19/30, 19/32 | **32/33, 32/39** (pixel IoU 0.56) | 0/4 |

Overlays: `docs/screenshots/2026-10-27-fenestra-relief-tiers-*.png`.

The tiers are written in the `FacadeGrammar` shape (`tiers: { t0, t1, cols }`), one tier per lattice row of present cells.

### 11.3 What it shows

- **The relief's native grid is as good as the prototype at finding windows, and better with all its runs.** Facade 17's
  pairs are two dark runs per bay; laying out every run finds 32 of 33 windows at 82% precision, against 13/33 at 33%
  for the prototype. The prototype's fitting code is not needed: the relief already finds the grid.
- **Facade 4 needs bands along the wall.** Its grid is right on the left section and drifts off the windows in the right
  section, whose grouping differs; and its shopfront band gets a false row. The next step is the relief run per band
  along s and t (the change points of section 9.1), or the relief's own grid re-phased per band.
- **The tower needs the bay reading.** Its windows are lighter than the dark spandrels around them, so the relief's
  dark cells sit on the spandrels and the presence test rejects the windows. Its `strips` pattern (light piers, dark
  bays) is the right reading there. On facade 0 the relief chose `cells`; the band's choice should be scored, as the
  prototype's punched-or-bay choice was.

### 11.4 Next

1. The relief per band (along s and t), each band re-phased and scored.
2. Cells or strips chosen per band by the checked-window score's evidence (darkness and edges), not by the relief's
   facade-wide pattern.
3. The grammar's held-out folds and half-shifted control as the gate on each band's tiers.
4. Then phase 1: the lattice and material regions read the tiers.

### 11.5 The relief per band (offline driver)

A small driver runs the relief's `analyzeOrthophoto` on any rectangle of a straightened facade photo (the header
unchanged; the driver lives with the prototype, outside the repo). Per band: the band's own grid (re-phased by
construction), two layouts (cells: every significant dark run of the band's period, each cell present by its contrast;
strips: the band's folded column profile, the darker part as a full-height bay), the better by the evidence, and a gate
taken from the grammar: alternate 8 m stripes hidden, the relief re-run on the rest, its layout predicting the hidden
stripes better than the same layout half a pitch off, in both folds.

| Reading | 4 base | 17 base | 0 tower (bays) |
|---|---|---|---|
| Facade-wide tiers (11.2) | 19/30 found, 19/32 correct | **32/33, 32/39** | 0/4 |
| Per band, bands from 8 m | 17/30, 17/29 | 5/33, 5/7 | 0/4 (0 of 40 bands accepted) |
| Per band, bands from 20 m, facade grid where a band finds none | **21/30, 21/33** | 26/33, 26/82 | 0/4 (12 of 18 accepted, 9 as strips; pixel IoU 0.31) |

Overlays: `docs/screenshots/2026-10-27-fenestra-relief-bands-*.png`.

What it shows:

- **The relief needs at least two periods.** Bands under about 20 m along the wall (two bays on the ESB) lose their
  period. On facade 17 they read a 2.5 m window pitch; on the tower, no period at all. The held-out stripes on such a
  band leave one stripe to read, so the gate rejects nearly everything.
- **On facade 17 per band is worse than facade-wide.**
  - The upper three storeys are close to exact.
  - The lowest storey splits into slivers: its band reads different runs.
  - The ground band gets false openings: the presence test passes on shopfront and signage.
  - The facade-wide grid with all runs (32/33 at 82%) remains the best reading of this facade.
- **On the tower the strips are in the right place but half the width.** The fold's darker half is one window column of
  each bay, not the bay; and a band that includes the setback roof carries its strips across it.

Next fixes, each general:

1. **A band of one storey gets no lattice.** A grid needs at least two rows (storeys) to repeat in; the ground band then
   comes out as no fit, with its reason. This is the shopfront hypothesis by evidence.
2. **A bay is the complement of the light piers.** The lightest contiguous run of the folded columns is the pier; the
   rest of the period is the bay. Not the darker half of the fold.
3. **The held-out gate by storeys as well as stripes** (the grammar hides bands too), so a narrow band can still be
   judged.
4. **Facade-wide first, bands only where they disagree.** Use the facade's grid, and split a band out only where its
   own reading scores clearly better.

### 11.6 Facade grid first, storeys that repeat, bays from the piers, gate by storeys too

Changes (the per-band prototype):

1. **Facade-wide grid first.** Each band is laid out from the facade's grid. Its own grid replaces it only when it scores
   1.2x better.
2. **Bays from the light piers.** The pier is the lightest contiguous run of the folded columns; the bay is the rest of
   the period.
3. **Held-out gate by storeys as well as stripes.** Four folds as in the grammar (alternate 8 m stripes, alternate 8 m
   bands); a layout passes when it beats its half-pitch shift in all but one judged fold.
4. **Storeys that do not repeat get no openings.** A first try, one-storey bands (bands down to 4 m), split every storey
   into its own band and rejected them all. In its place, per row: a storey whose darkness profile along the wall
   correlates under 0.3 with the band's median storey gets no openings. Bands stay at least 10 m tall.

| Crop | Found | Correct | Pixel IoU |
|---|---|---|---|
| 4 base | 23/30 | 22/27 | 0.27 |
| 17 base | **33/33** | **28/28** | 0.42 |
| 0 tower (bays) | 3/4 | 5/16 | 0.55 |

Overlay: `docs/screenshots/2026-10-27-fenestra-composed-final.png` (4, 17, 0 left to right).

**The overlay corrects the table.**

- **Right:** the upper storeys of both base facades sit on the windows; the tower's bays now span the full bay between
  piers.
- **Wrong, and over-credited by the window score:**
  - **Base:** the lowest band of both base facades chose **strips**, which run the full band height over the lowest
    storey **and the shopfront band** below it. The checked windows of that storey sit inside them, so they count as
    found and correct.
  - **Tower:** the strips continue across the red setback roof, and one extra strip lies on a pier.

  The instance score needs a pixel-precision term (share of the fitted area that is window), and the strip hypothesis a
  general rule:

  - **A bay must be darker than the piers along most of its height.** Per strip, the share of its rows darker than the
    pier columns beside it must be at least about 0.8, else it ends where that stops. This stops strips crossing
    shopfronts, signage and roofs.
  - **Storey rows apply to strips too.** A strip is cut at the rows that do not repeat the band's storeys, as cells are.

**Where this stands:** with the facade's own relief grid, every dark run, presence per cell and non-repeating storeys
dropped, the punched-window storeys are right on both checked base facades. The remaining work is the bay (strip) side:
its vertical extent, and a score that does not reward it for covering too much.

### 11.7 Strips end where they stop being darker than the piers; pixel precision

Changes:

- **Strips per storey.** A strip is kept over a storey (the band cut at its storey pitch) only where, on at least 80% of
  that storey's rows, it is 0.03 darker than the piers beside it. It is also dropped over any storey that does not repeat
  the band's (the row test of 11.6, now applied to strips as well as cells).
- **Pixel precision and recall in the score**, beside the window counts that over-credited strips.

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | 0.33 | 0.63 | 0.42 | 19/30 | 19/31 |
| 17 base | 0.59 | 0.78 | 0.70 | 26/33 | 26/66 |
| 0 tower | **0.60** | **0.88** | 0.65 | 3/4 | 4/9 |

Overlay: `docs/screenshots/2026-10-27-fenestra-composed-strips.png`.

- **Fixed:**
  - the tower's strips stop at the setback roof (pixel precision 0.88), two bays whole, two in part;
  - the oversized base strips are gone, the base choosing cells.
- **Still wrong: the ground floor.**
  - Facade 4: a row of false openings in its shopfront band. That row's darkness profile along the wall follows the
    piers above it, so the repeating-storey test passes it.
  - Facade 17: its lowest storey breaks into slivers (the band's dark runs up the wall are several short ones), and its
    ground band keeps fragments.

  A ground floor differs from the storeys above in the height and darkness of its openings, not in its column rhythm.
  Next test: a storey's cells must match the band's opening height (their dark run up the wall) as well as its columns.

### 11.8 Cells keep only the band's opening height

- **Each cell measured up the wall.** The darkness profile of the cell's columns through the band, cut halfway between
  the cell's darkness and the band's wall level, gives the cell's own dark run (gaps of one or two rows bridged). The cell
  takes that extent.
- **Height test.** Cells whose run is under 0.65 or over 1.5 times the band's median opening height are dropped: a ground
  floor's openings and a pane's sliver differ from the storeys above in height, not in column rhythm. Overlapping cells
  (IoU over 0.5) join. Strips are unchanged (11.7).

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | 0.36 (0.33) | **0.87** (0.63) | 0.38 (0.42) | 14/30 (19/30) | **14/17** (19/31) |
| 17 base | **0.69** (0.59) | 0.79 (0.78) | **0.85** (0.70) | **33/33** (26/33) | **28/28** (26/66) |
| 0 tower | 0.60 | 0.88 | 0.65 | 3/4 | 4/9 |

(11.7 in brackets.) Overlays: `docs/screenshots/2026-10-27-fenestra-height-{4,17,0}.png`.

- **Fixed:**
  - facade 4's false shopfront row is gone; every cell left lies on a window (14/17 correct, the 3 others overhang the
    sill cornice above the top row);
  - facade 17's slivers are gone: every window found, every cell placed correct.
- **Cost:** facade 4's recall fell. Its lowest checked storey (taller, darker openings) is now dropped as well as the
  shopfront: the height test is per band, and that storey shares the band with shorter ones above. Its fourth column and
  its paired centre windows were already missed (the band's grid pitch does not fit them).
- **Still wrong:**
  - facade 17's lowest storey is held as broad strips (the band chose strips there), which covers the piers between
    paired windows;
  - facade 4's top-row cells reach up into the cornice (the run bridges into the dark shadow line above).
- **Next:** take the height test per storey rather than per band (a storey whose openings are consistently taller is a
  storey of its own, kept, not dropped); stop a run at a light horizontal line (the sill or cornice) as strips stop at
  light piers.

### 11.9 Height per storey, runs against the piers, evidence against the row

Asked for: the height test per storey, and a cell's run stopped at a light horizontal line. Each change was measured on
its own (flags in the prototype), as follows.

- **Light-line stop: no effect, dropped.** Gaps were already rare; the overhang above facade 4's top row is the cornice's
  shadow, dark and contiguous with the window, so there is no light line to stop at.
- **Per storey alone: worse** (4: IoU 0.33, precision 0.75; 17: 0.62, 30/33). Facade 4's shopfront row is as consistent
  in height (about 22 px, small spread) as a real storey, so it came back. Height cannot tell a shopfront from a storey.
- **Pier test (replaces the light-line stop).** A cell's run up the wall counts only rows darker than the piers beside it
  (half a cell each side), the strips' rule from 11.7 applied to cells; a cell whose rows are not on average 0.03 darker
  than its piers is no opening. A shadow line or a shopfront dark from pier to pier ends the run or drops the cell.
- **The gate's evidence, against the row.** Facade 4's lower band (the lowest storey above the shopfront) was rejected
  in every earlier run, not by the cell tests but by the fit floor (score 0.06-0.10 under 0.12, with 3/4 folds passed):
  the facade-wide Otsu darkness mask fills the whole shopfront, so even right cells score low. Opening evidence now also
  has to be 0.03 darker than its row's local mean along the wall (6 m; 10-24 m gave identical results).

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | **0.46** (0.36) | 0.83 (0.87) | **0.51** (0.38) | **17/30** (14/30) | 17/21 (14/17) |
| 17 base | 0.69 | 0.80 | 0.83 (0.85) | 33/33 | 28/28 |
| 0 tower | 0.42 (**0.60**) | 0.90 | 0.44 (0.65) | 3/4 | 3/6 (4/9) |

(11.8 in brackets.) Overlays: `docs/screenshots/2026-10-27-fenestra-storey-{4,17,0}.png`.

- **Fixed:** facade 4's lowest storey is kept and its shopfront stays clear: the per-storey height test now helps
  (17/30 found with it, 16/30 without), because the shopfront no longer passes the pier test.
- **Regressed: facade 0.** One tower band (rows 2099-2228, inside the checked crop) flips from 3/4 to 2/4 held-out folds,
  its score moving only 0.32 to 0.30, and is rejected; the bays through that stretch are lost. The windows did not get
  worse: the four-fold gate sits on its threshold. The evidence change is the cause (with it off, facade 0 is back at 0.60).
- **Still wrong:**
  - facade 4: column 4 is shifted half a bay on the upper storeys, and one tall false cell sits on the pier between the
    wings (the band grid's pitch does not fit the paired centre windows, as in 11.8);
  - facade 0: the right bays run past the setback roof into the red roof below.
- **Next:**
  - the gate: score each fold by its margin over the half-pitch control (summed) rather than by win counts, so a band
    whose prediction beats the control on average is not rejected by one fold's coin toss;
  - the strips' end test (11.7) applied against the row evidence too, so bays stop at the setback roof.

### 11.10 The gate by summed margin; strips against the row (dropped)

- **Correction to 11.9.** "Facade 0: the right bays run past the setback roof into the red roof" was a misread. The red
  roof is the left setback only. The right-hand tower bays continue down past it (`f0_low` crop, rows 2150-2450), and the
  checked windows run to the bottom of the crop there. Those strips were right, and the left bays already stopped at
  the roof.
- **Gate by margin.** Each held-out fold's IoU minus its half-pitch control's IoU, summed over the folds; a band passes
  when the sum is positive (with the 0.12 fit floor and at least two folds judged, as before). This replaces "wins ≥ judged
  − 1".
- **Strips against the row (flag `STRIP_ROW`, off).** The strips' end test of 11.7, also requiring a row to be 0.03
  darker than the row's local mean (the 11.9 evidence).

| Gate | Strips vs row | 4: IoU / found | 17: IoU / found | 0: IoU / found |
|---|---|---|---|---|
| wins | off | 0.46 / 17 of 30 | 0.69 / 33 of 33 | 0.42 / 3 of 4 |
| wins | on | 0.46 / 17 | 0.65 / 30 | 0.18 / 0 |
| **margin** | **off** | **0.46 / 17** | **0.69 / 33** | **0.60 / 3** |
| margin | on | 0.46 / 17 | 0.65 / 30 | 0.22 / 0 |

Chosen (margin, strips not against the row):

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | 0.46 | 0.83 | 0.51 | 17/30 | 17/21 |
| 17 base | 0.69 | 0.80 | 0.83 | 33/33 | 28/28 |
| 0 tower | 0.60 | 0.88 | 0.65 | 3/4 | 4/9 |

Overlays: `docs/screenshots/2026-10-27-fenestra-margin-{4,17,0}.png`.

- **The margin gate** restores facade 0 (16 bands accepted, against 14 under the wins gate). Two of those pass 2/4 folds
  but by a clearly positive summed margin (0.30, 0.70): the folds the band loses, it loses narrowly. Facades 4 and 17 are
  unchanged.
- **Strips against the row: harmful.** A tower bay is nearly as wide as the 6 m row window, so the row's local mean is the
  bay's own darkness and real bay rows fail. The bay's end is already decided by its piers (11.7). Left off.
- **Still wrong:**
  - facade 0: the third bay is missed above the right setback, inside an accepted band (every band over the crop is
    accepted; the two rejected are above it, with no evidence), so the strip layout or its end test drops that column;
    the second bay is narrowed on its right; the first bay overhangs the roof edge by a few rows;
  - facade 4: column 4 shifted half a bay on the upper storeys; one tall false cell on the pier between the wings.
- **Next:** these are now placement errors inside accepted bands (phase and width per column), not acceptance errors:
  per-column re-phasing of each cell or strip to its own dark run along the wall, as 11.8 does up the wall.

### 11.11 Each column measured along the wall

- **Re-phasing (`rephase_columns`).** Each cell (after it is measured up the wall, 11.8) and each strip (before its storey
  ends are decided, 11.7) is measured along the wall. The procedure:
  - take the darkness profile across its rows, searched half a width either side;
  - move the column to the darkest point within its grid cell (smoothed over a quarter width);
  - take the dark run there: darker than halfway between that point's level and the lightest piers nearby (15th
    percentile), with gaps of up to four columns bridged (a mullion inside a bay);
  - a run outside 0.6-1.6 times the grid's width keeps the grid's placement; overlapping columns join.
- **Short storeys.** Re-phased cells changed facade 17's lower band from strips to cells. Its ground row (the grille,
  cells about 8-10 px against 45 px windows) agreed with itself in height, so the per-storey test of 11.9 kept it. A storey
  whose median opening is under 0.4 of the band's tallest storey's is now dropped: a grille, a sill line or a sign course.
  This is the counterpart of keeping taller storeys.
- **Tried and dropped:**
  - measuring cells up the wall again after re-phasing (their measured rows no longer group into storeys, so every
    storey had one cell and was dropped: facade 4 fell to 0.10);
  - a pier check on the moved column (no effect: the ground fragments are darker than their sides).

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | **0.49** (0.46) | **0.93** (0.83) | 0.51 | **18/30** (17/30) | 18/21 |
| 17 base | 0.67 (0.69) | 0.80 | 0.80 (0.83) | 33/33 | 28/28 |
| 0 tower | **0.67** (0.60) | 0.90 (0.88) | **0.72** (0.65) | 3/4 | 4/11 |

(11.10 in brackets.) By kind: re-phasing strips alone raises facade 0 (0.60 → 0.67) and leaves 4 and 17 as they were;
re-phasing cells raises facade 4 (0.46 → 0.49, precision 0.93). Overlays:
`docs/screenshots/2026-10-27-fenestra-rephase-{4,17,0}.png`.

- **Fixed:**
  - facade 4's upper-storey column 4 and its lowest storey's left column sit on their windows;
  - facade 0's third bay is found in part (its right half).
- **Still wrong:**
  - facade 17: the lowest storey is held as broad strips again (covering the piers between pairs), and several upper
    cells are narrower than their window (the dark run stops at the pane's lighter frame);
  - facade 4: the false cell on the pier between the wings; the centre wing's paired windows (the band grid's pitch
    does not fit them);
  - facade 0: the second bay is still one window column of two wide.
- **Next:** a bay of two window columns and a pair of windows is one structure at two scales. Read the pier rhythm and
  the window rhythm inside the bay as a nested grid (bay pitch, then panes within), rather than one pitch per band.

### 11.12 The nested grid: bay pitch, then panes

- **`nested_columns`.** How a band is read as a nested grid:
  - its column profile is folded at the bay pitch, binned in metres so a pitch that isn't a whole number of pixels
    doesn't drift across the facade;
  - the fold's lightest run is the pier and the rest the bay;
  - inside the bay, a run that rises more than `MULLION` of the way from the bay's darkness (75th percentile) to the
    pier's lightness is a mullion, and splits the bay into panes (runs under half the longest pane are dropped).
- **Cells and strips are placed per pane at the bay pitch:**
  - nested cells: each pane column, on the relief's rows;
  - nested strips: one per pane, so a bay with a light mullion is two strips and a dark-ribbon bay one.
  - Both then take the measuring of 11.8-11.11 (up the wall, along the wall, storey ends).
- **Replacing the single-pitch reading did not work.** It raised facade 17 (IoU 0.73, 32/32 correct) but facade 0 fell
  to 0.22-0.43 at every threshold tried. The tower's piers stand about 70, 100 and 70 px apart (a wider middle bay, with
  a half-light mullion inside it): its bays are not periodic. A single folded bay is the wrong model there, and the
  window columns inside each bay read as panes.
- **So the nested readings are candidates.** `nested-cells` and `nested-strips` sit beside `cells` and `strips`; each
  band takes the reading with the best evidence score, and the held-out gate (11.10) judges that reading.

| `MULLION` | 4: IoU / precision / found | 17: IoU / precision / found / correct | 0: IoU / found |
|---|---|---|---|
| (no nested; 11.11) | 0.49 / 0.93 / 18 | 0.67 / 0.80 / 33 / 28 of 28 | 0.67 / 3 |
| 0.5 | 0.49 / 0.93 / 18 | 0.72 / 0.95 / 33 / 32 of 32 | 0.52 / 2 |
| **0.8** | **0.50 / 0.93 / 18** | **0.73 / 0.95 / 33 / 32 of 32** | **0.67 / 3** |

At 0.5, six tower bands chose nested strips and split their bays; at 0.8, one does. `MULLION` is chosen on these three
crops only, so it needs checking on other facades before it is trusted.

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct | Readings chosen (accepted bands) |
|---|---|---|---|---|---|---|
| 4 base | 0.50 (0.49) | 0.93 | 0.51 | 18/30 | 18/21 | cells 1, nested cells 1 |
| 17 base | **0.73** (0.67) | **0.95** (0.80) | 0.77 (0.80) | 33/33 | **32/32** (28/28) | nested cells 5, nested strips 2, cells 1 |
| 0 tower | 0.67 | 0.90 | 0.72 | 3/4 | 4/11 | strips 15, nested strips 1 |

(11.11 in brackets.) Overlays: `docs/screenshots/2026-10-27-fenestra-nested-{4,17,0}.png`.

- **Fixed:** facade 17's lowest storey is read as pairs of windows, no longer broad strips over the piers between them;
  every cell placed on facade 17 is a checked window.
- **Unchanged:**
  - facade 4: the centre wing's paired windows and the false cell on the pier between the wings. The centre wing is a
    different rhythm from the side wings in the same band, and the band is too narrow (under 20 m) to split out;
  - facade 0: the second (wider) bay is still one window column of two.
- **Next:** both remaining errors are rhythms that change along the band (a centre wing, a wider bay). Read bays from
  the piers themselves (each light run of the column profile that is as light as the fold's pier is a pier), rather
  than from one pitch, so unequal bays and a wing of another rhythm are placed as they stand.

### 11.13 Bays read from the piers

- **`pier_columns`.** How a band's bays are read from its piers:
  - the nested fold (11.12) gives the pier's lightness and width;
  - every run of the band's own column profile at least that light, and at least half the fold's pier width, is a pier;
  - each span between neighbouring piers is a bay as it stands, from 0.4 to 2.5 bay pitches wide (a wider bay, a
    wing of another rhythm);
  - inside each bay, its own profile splits at mullions (`MULLION`, as 11.12).
- **Two new candidate readings:**
  - `pier-cells`: each pane on the relief's rows, present by its own contrast, then measured up the wall (11.8-11.9);
  - `pier-strips`: each pane full height, ending at storeys that are not darker than their piers (11.7).

  They sit beside the four readings of 11.12; each band takes the best by evidence, and the margin gate judges it.

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct | Readings chosen |
|---|---|---|---|---|---|---|
| 4 base | **0.62** (0.50) | **0.98** (0.93) | **0.63** (0.51) | **22/30** (18/30) | 22/24 (18/21) | pier cells 2 |
| 17 base | 0.73 | 0.95 | 0.77 | 33/33 | 32/32 | nested cells 5, nested strips 2, cells 1 |
| 0 tower | **0.75** (0.67) | 0.92 (0.90) | **0.80** (0.72) | 2/4 (3/4) | 3/15 (4/11) | pier strips 9, strips 6, nested strips 1, pier cells 1 |

(11.12 in brackets.) Overlays: `docs/screenshots/2026-10-27-fenestra-piers-{4,17,0}.png`.

- **Fixed:**
  - facade 4: the false cell on the pier between the wings is gone, column 4 is found on the upper storeys and the
    lowest storey, and the centre wing's top row is placed;
  - facade 0: the wider second bay and the third bay are covered across their width over most of the crop.
- **Facade 0's window count fell while its pixels rose.** Pier strips split each tower bay into its two window columns
  at the mullion between them, with a dark gap left uncovered. The checked set counts each tower bay as one opening
  (window and spandrel ribbon), so a half-bay strip neither covers half the bay nor overlaps it by 0.3. Whether a
  tower bay is one opening or two window columns is a question for the checked set's convention: the pixels say the
  split reading fits better.
- **Still wrong:**
  - facade 4: the centre wing's two lower storeys and its middle windows (its openings are taller, darker and set in
    a recessed frame, and are not present by the cell contrast test against that dark frame);
  - facade 0: one false strip on the lower setback below the roof (bottom of the crop), and the left bay's upper part
    is held as one window column.
- **Next:** settle the tower convention (one opening per bay, or per window column) with a human check on the crop;
  then test pier reading on facades outside the checked set before trusting `MULLION` and the pier rules.

### 11.14 Tower window columns as openings; pier reading off the checked set

- **Checked set, facade 0 (user decision, 2026-10-27).** Each tower window column (window and spandrel ribbon) is its own
  opening, split at the mullions between them. That gives 8 openings in the crop where there were 4 bays: two in bay 1,
  three in bay 2, two in bay 3, and one in bay 4 (cut by the crop's edge). The columns are read from the luminance
  profile across rows 0-213 (the panes are lighter than the dark frames and mullions) and a ruled crop; checked by the
  agent, not by a person. The bay version is kept as `gt_0_bays.json`.

| Facade 0 (columns) | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| without pier reading | 0.50 | 0.62 | 0.73 | 4/8 | 3/11 |
| **with pier reading** | **0.56** | **0.64** | **0.81** | **7/8** | **11/15** |

  Precision is lower than under the bay convention, because the strips still cover some of the mullions between
  columns.

- **Six facades outside the checked set,** judged by eye on a 300 px crop, side by side without and with pier reading
  (`docs/screenshots/2026-10-27-fenestra-unchecked-{id}.png`; left without, right with):

| Facade | What it is | Readings chosen with piers | Without → with |
|---|---|---|---|
| 13 | narrow tower face, 22 m | pier cells 3, pier strips 3 | **Better.** Without: thin strips along the bay edges, partly on the piers. With: each bay covered between its piers, broken at the storey lines; one bay split at a mullion. |
| 11 | tower, opposite face to 0 | pier strips 4, pier cells 1, strips 8, ... | **Better.** Two false patches on a pier are gone. The dark, recessed bay at the right is uncovered in both. |
| 49 | tower, side face | pier strips 1, strips 3 | Same. |
| 22 | mid setback | pier strips 1, strips 1 | Same. |
| 12 | base, other side | nested cells 4, strips 1 | Identical (pier readings not chosen). |
| 29 | base, side | nested cells 4 | Identical. |

- **Nothing got worse off the checked set.** Pier reading is chosen only where it reads better, and on the two
  facades where it changes the picture it is a clear improvement.
- **The column convention is not met on the other tower faces.** On facades 49 and 22 (and most of 11) each bay is
  still one strip over both window columns. The mullion between columns there is about as dark as the windows, so
  `MULLION` 0.8 does not split it; on facade 0 the mullions are lighter. Splitting by darkness alone cannot give the
  column convention everywhere.
- **Next:** split a bay at the window-column rhythm inside it rather than at a light mullion. Read the bay's own
  profile period (two or three columns per bay is a sub-pitch the autocorrelation finds, as the relief finds the bay
  pitch), and make the gate pass the split only when that sub-pitch is found on most bays of the band.

### 11.15 Bays split at their window-column rhythm

- **The cue (`bay_columns`).** Up the wall a window column alternates pane and spandrel; a mullion does not. A bay's
  per-column variation (the standard deviation of darkness over its rows) is high on window columns and low on mullions
  and frames, whether the mullion is light (facade 0) or dark (facade 49).
  - Probe: every tower bay on facades 0 and 49 has an autocorrelation peak of this profile at about 24 px (0.43-0.51);
    facade 0's wider bay gives three columns at the same sub-pitch.
  - How it splits: the sub-pitch is the strongest autocorrelation peak (at least 0.3) between a quarter and 0.6 of the
    bay's width. The bay splits into round(width / sub-pitch) columns at the profile's minima near each division. Each
    column is trimmed to where the variation rises above halfway between the mullion and the column, so the bay's outer
    frames drop out too.
- **The band gate (`split_bays`).** Applied after a band's reading is chosen and accepted, to strips only. A bay is the
  set of strips sharing columns. The split passes when at least 60% of the band's bays find their sub-pitch; then each
  bay that found one splits, and the others stay whole.
- **Why after the choice, not as a candidate:** the mullions between columns are dark, so they count as opening
  evidence, and a split reading would always lose to the whole bay on the evidence score.

**Checked facades:**

| Crop | Pixel IoU | Pixel precision | Pixel recall | Found | Correct |
|---|---|---|---|---|---|
| 4 base | 0.62 | 0.98 | 0.63 | 22/30 | 22/24 |
| 17 base | 0.73 | 0.95 | 0.77 | 33/33 | 32/32 |
| 0 tower (columns) | 0.56 | 0.65 (0.64) | 0.80 (0.81) | 7/8 | 11/15 |

Facade 0 hardly changes: its pier strips are already window columns (11.13), so they find no sub-pitch inside, as they
should not. The bays left whole there are in bands read as plain strips. Facades 4 and 17 have no strip bands that split.

**Unchecked facades** (`docs/screenshots/2026-10-27-fenestra-subpitch-{id}.png`; left: pier reading, 11.14; right: with
the split):

| Facade | Bays finding the sub-pitch, per strip band | Opening share of facade | By eye |
|---|---|---|---|
| 22 mid setback | 7/7, 7/7 | 0.64 → 0.42 | **Split as wanted:** every bay into its two window columns, mullions and frames clear. |
| 11 tower | 3/5, 3/3, 3/3, 6/6, 3/5, 3/5, 4/6, 3/3, 1/1 ×5 | 0.45 → 0.31 | **Split as wanted:** two-column bays into two, the wider bay into three; the lower right bay too. |
| 49 tower side | 3/5, 0/2, 3/5, 1/4 | 0.55 → 0.38 | **Mostly:** three of the four bays in the crop split; the rightmost stays whole (its band fails the gate at 1/4). |
| 13 narrow tower face | 0/5, 0/6, 0/6 | unchanged | **Correct to stay:** its bays are one window column each. The one two-column bay was already split at a light mullion (pier reading); below the storey line it is held whole, as a minority bay in a band that does not pass. |
| 12 base | 0/8 | unchanged | **Correct to stay:** base strips, no column rhythm. |
| 29 base | (no strip bands) | unchanged | — |

- **Fixed:** the tower faces where darkness could not split the columns (11.14: 49, 22 and most of 11) now give one
  opening per window column, as the convention asks, and nothing that has one column per bay was split.
- **Still wrong:**
  - a bay that finds its sub-pitch in a band that does not pass stays whole (49's right bay, 13's lower centre bay);
  - the split is on strips only. Cells that span two window columns would not be split, though none were seen in
    these crops.
- **Not yet checked:** a checked column set for a second tower face (49 or 22), to put numbers on what the eye sees
  here.

### 11.16 Two more tower faces checked by column; every step re-measured

- **Checked sets, facades 22 and 49** (`gt/gt_22.json`, `gt/gt_49.json` in the prototype). Each crop is 300 x 300 px:
  facade 22 rows 284-584, facade 49 rows 1354-1654.
  - Each has 8 window columns, each running the full crop height, read by eye on a 3x ruled crop at the pane-frame
    edges.
  - The vertical-variation profile agrees within about 2 px. That profile is the cue the bay split (11.15) uses, so
    these sets are not independent of it. Reading the frame edges by eye (slightly wider than the profile's columns)
    softens this but does not remove it. Checked by the agent, not by a person.
- **Every step re-measured.** Steps 11.8 to 11.15 are reproduced by the prototype's switches (each step's switch off
  gives the step before it; `steps.sh`). For 11.8 this approximates the code of that time, whose run-growing rule
  differed slightly.

| Step | 22: IoU / precision / recall | 22: correct | 49: IoU / precision / recall | 49: correct | 0 (columns): IoU / precision / recall | 0: found / correct |
|---|---|---|---|---|---|---|
| 11.8 height per band | 0.65 / 0.65 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.44 / 0.59 / 0.63 | 3/8, 2/9 |
| 11.9 storey, pier, evidence | 0.65 / 0.65 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.33 / 0.60 / 0.43 | 1/8, 1/6 |
| 11.10 margin gate | 0.65 / 0.65 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.44 / 0.59 / 0.63 | 3/8, 2/9 |
| 11.11 re-phase | 0.66 / 0.66 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.50 / 0.62 / 0.73 | 4/8, 3/11 |
| 11.12 nested | 0.66 / 0.66 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.50 / 0.62 / 0.73 | 4/8, 3/11 |
| 11.13 piers | 0.66 / 0.66 / 1.00 | 4/4 | 0.70 / 0.70 / 1.00 | 5/6 | 0.56 / 0.64 / 0.81 | 7/8, 11/15 |
| **11.15 bay split** | **0.91 / 0.98 / 0.93** | **8/8** | **0.78 / 0.87 / 0.88** | **8/9** | 0.56 / 0.65 / 0.80 | 7/8, 11/15 |

(All 8 columns are "found" at every step on 22 and 49: a whole-bay strip covers both of its columns, so the instance
count cannot tell the steps apart there. Pixel precision can.) Overlays of the last step:
`docs/screenshots/2026-10-27-fenestra-columns-{0,22,49}.png`.

- **What each step bought on the tower faces:**
  - 11.8 to 11.13 made no difference on 22 and 49: every step reads whole bays, covering the mullion between columns
    (precision 0.65-0.70);
  - the bay split takes facade 22 to 0.91 (precision 0.98) and facade 49 to 0.78. On 49 the rightmost bay stays whole:
    its band's gate fails at 1 of 4 bays;
  - on facade 0, pier reading (11.13) is the step that counts (0.50 to 0.56, 4 to 7 columns found); the split adds
    nothing there, because its pier strips are already columns.
- **11.9 is the one step that hurt facade 0** (0.44 to 0.33). The margin gate (11.10) brought the lost band back, as
  11.10 reported.
- **Facade 0 is the weakest at 0.56 / 0.65.** From the overlay:
  - bay 2's middle column is missed over its whole height (its panes are darker than its neighbours'), and bay 1's
    left column above row 100;
  - the left bays overrun the roof edge by about 15 rows;
  - a false strip on the lower setback below the roof;
  - the right bays' strips are a few pixels wider than their columns.
- **Next:**
  - a human check of the three column sets (0, 22, 49), since they were read by the agent and two share the split's
    cue;
  - then move the method into the app: the relief's grid export (in the header now), the readings and gates into
    `facade-lattice.ts` behind its window-cell extras, and an uncached ESB build reviewed stage by stage.
