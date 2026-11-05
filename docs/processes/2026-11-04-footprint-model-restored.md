# The footprint model restored: K's footprint judged against the tiles (2026-11-04)

Branch `claude/footprint-model-restore`, on top of MAIN's `claude/k-modelled-footprint` (`0f1d3420`). It restores the
tiles-only footprint model from branch `nyc-truth` (2026-10-31 to 11-02; findings in that branch's
`docs/processes/nyc_truth_benchmark_2026-10-31.md`, backed up at
`/Volumes/G-RAID MIRROR/scratchbox-backups/nyc-truth-2026-11-03/`). The model uses it to judge, per building, whether
the tiles confirm Google's outline.

## What it does

- **The model** (`footprint-model.ts`, `scripts/topdown_window.cpp` over `scratchbox_topdown_window.hpp`,
  `tools/footprint/footprint_model.py`): a U-Net reads the building's outline from the tiles' top-down height and
  photo colour.
  - Its window is 64 m at 0.25 m cells.
  - Weights are `unet_footprint_2026-11-02.pt` in the gitignored `.model-cache/footprint/`. The main checkout's copy is a
    symlink to `/Volumes/3DTESTING/scratchbox-ide/models/footprint/`.
  - Without the weights or its Python environment it is unavailable, the run notes say why, and K stands on Google's
    outline as on `claude/k-modelled-footprint`.
- **Read window by window** (`growFootprintModel`, new): Penn 2 and the ESB are larger than one window.
  - Where an outline meets its window's edge, another window is read 6 m inside it.
  - The outlines are joined on the model's cells, up to 16 windows. Both buildings took 11.
- **Asked at the place** (`modelSeed`, new): the model is asked where the place geocodes, unless that point is within
  3 m of the edge of Google's outline or outside it. Then it is asked at the outline's most interior point.
  - 2 Penn Plaza geocodes onto the edge of its neighbour.
  - The structure picker's seed outlined neighbours in SoHo (nyc-truth Part 3).
- **The decision** (`decideFootprint`, fitted on the SoHo benchmark, unchanged): the model's outline is used where
  Google's footprint is missing, merges the neighbours or covers only part of the building. That applies to every
  pipeline, labelled photo-inferred. The decision is written to the run note `footprint_model.json`.
- **K's footprint** (`kFootprint`, new):

  | Case | K stands on | Trusted |
  |---|---|---|
  | The model confirms Google's outline (overlap ≥ 0.6) | Google's outline, traced from above for a modelled building | Yes |
  | `decideFootprint` takes the model | The model's outline | Yes |
  | The tiles do not confirm Google's outline | The scan's outline, as before MAIN's change | No |
  | No sure reading | Google's outline as it is | No |

- **Trusted, but not cut by default.** A trusted footprint skips the base cleanup's misfit test. With the scan
  sticking out past it (the isolate took in the neighbours), that cuts the neighbours away. With the party wall off
  (user decision 2026-10-28) the cut sides stay open. That cut is opt-in, `SCRATCHBOX_K_CUT_CONFIRMED=1` (measured
  below).
- **The clip never cuts a rebuilt facade** (`FacadeLattice_*` nodes). This is the same rule as MAIN's uncommitted change on
  `claude/k-modelled-footprint`.
- **Not ported from nyc-truth:**
  - the generated party wall (off since 2026-10-28);
  - the de-light's red-brick fix;
  - the benchmark, training and vector-layer scripts.

## Measured

Uncached builds, 2026-11-04. Origin/main `7e96dc8f` against this branch.

- Each building ran on the same tiles in both arms: the branch build was seeded from the main arm's tile cache.
- Builds ran headless through the staged tool entry (`scripts/dev/staged-replay.ts`), with
  `SCRATCHBOX_CACHE_RESTORE=off` and a fresh workspace each.
- Holes is the share of the building seen through holes from 12 views (`pipeline_k_visible_defects`), on the layer
  the build ends on.
- Runs and logs are in `/Volumes/3DTESTING/scratchbox-ide/fpm/`.

| Building | Query | Main: holes, footprint | Branch: holes, footprint | Model vs Google overlap (model sure) |
|---|---|---|---|---|
| 2 Penn Plaza | `2 Penn Plaza, New York` | **2.11%**, scan outline (run 91b614c4) | **2.11%**, scan outline: tiles do not confirm Google's (78462b4d) | 0.59 (0.87), 11 windows |
| Empire State Building | `Empire State Building, New York` | 0.74%, scan outline (189444c4) | 0.73%, Google's traced outline, confirmed (e0913cf0) | 0.80 (0.87), 11 windows |
| SoHo 1007227 (E.V. Haughwout) | `40.72183, -73.99949` | 19.54%, Google (124a3300) | **16.70%**, Google, confirmed (5dc993ba) | 0.94 (0.94) |
| SoHo 1079536 | `40.71767, -73.99746` | 19.03%, Google, not fitting: district whole (005b1b14) | 19.03%, model's outline, not cut (431ca4ad) | 0.48 (0.98): Google's merges the neighbours, 2.0x |
| SoHo 1007492 | `40.72286, -73.99566` | 17.08%, Google, not fitting: district whole (ac993e9c) | 17.17%, Google, confirmed, not cut (215c43b7) | 0.90 (0.94) |

With `SCRATCHBOX_K_CUT_CONFIRMED=1` (the first branch builds, kept in `fpm/branchcut/`):

| Building | Holes when cut | Main |
|---|---|---|
| SoHo 1079536 (08fdba65) | 44.29% | 19.03% |
| SoHo 1007492 (2f1eef17) | 46.43% | 17.08% |

In both, the building is the right one: the district fallback is cut to the footprint. Their shared walls stay open.
That is why the cut is opt-in.

- **Penn 2:** MAIN's 2.62% with Google's traced outline (run 4ed9fd63) came from standing on an outline the tiles do
  not confirm. Judged per building, Penn 2 goes back to the scan's outline and main's 2.11%.
  - Its overlap, 0.59, is one hundredth under the bar. The model's joined outline runs past Google's on the west and
    south, over the low Penn Station and Madison Square Garden roofs.
  - A small change in the reading could flip it. On the SoHo benchmark, Google's outline was under 50% right in a
    quarter of the 0.5 to 0.6 band.
- **ESB:** confirmed. K stands on Google's traced outline, trusted, with no change in holes. The scan already fits it
  (misfit 0).
- **1007227:** confirmed, 19.5% → 16.7%.

Sheet (gitignored): `docs/screenshots/footprint-model-2026-11-04/sheet.png`. Also in MAIN's notes folder as
`footprint-model-restored-sheet.png`.

Cost: 1,008 model calls over 12 builds, about $1.24 at the listed prices. The `gemini-4-argon` calls (around 37 per
build) are unpriced in the run records. The footprint model itself runs locally.

## Every plane kept

A check, at the user's ask, that no plane of the building is lost. For each build, take the isolated scan's surface
above 3 m and measure how much of it has no finished surface within a given distance. The scripts are in MAIN's notes
folder, `footprint-model-scripts/`.

| Building | Arm | Scan surface | Nothing within 0.5 m | 1 m | 2 m | 5 m |
|---|---|---|---|---|---|---|
| 2 Penn Plaza | main and branch, identical | 71,287 m² | 1.3% | 0.35% | 0.11% | **0** |
| Empire State Building | main | 305,341 m² | 33.8% | 28.4% | 21.6% | 10.0% |
| Empire State Building | branch | 305,341 m² | 33.9% | | | |
| SoHo 1007227 | main → branch | about 3,070 m² | 10.0% → 9.2% (inside the footprint: 0.15% → 0.08%) | | | |

- **Penn 2:** nothing more than 5 m away. Within 1 m to 5 m is the facades straightened onto their fitted planes.
- **ESB:** the 30,400 m² more than 5 m away is all a narrow core *inside* the tower: 3,827 large triangles, mostly
  walls at 0–100 m and ceilings. Drawn in red over the scan, none of it shows from any of four views from outside
  (`docs/screenshots/footprint-model-2026-11-04/esb-lost.png`, `esb-lost-only.png`). No outside plane is lost.
- **Not checked:** the two district-fallback builds (1079536, 1007492). Their district remesh keeps no isolated raw scan
  to compare with.

## Open

- **SoHo holes are high in both arms (17–20%).** The cut sides are open. A footprint that cuts neighbours away needs its
  shared walls closed before `SCRATCHBOX_K_CUT_CONFIRMED` can go on. PR #128's inner core is the candidate; measure
  1079536 and 1007492 with it.
- **Penn 2 sits on the bar** (0.59 against 0.6). Score the confirmation rule against NYC's survey outlines for large
  buildings before trusting it near the bar there. The 0.6 was fitted on SoHo buildings that each fit one window.
- **Only NYC and Amsterdam are measured** (the model's training cities).
