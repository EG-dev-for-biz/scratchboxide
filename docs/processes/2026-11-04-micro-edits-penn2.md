# Micro-edits on Penn 2's roof fans: four runs, one small kept edit each, no drift (2026-11-04)

## What was built

- **The plan** (`staged-location/micro-edits.ts`). Each building has a list of micro-edits, kept in the place store at
  `places/v1/<place>/micro-edits/<building id>.json` (`place-store.ts` `loadMicroEditPlan` / `saveMicroEditPlan`).
  - **Writes:** generation-preconditioned, so of two runs that read one plan only one write lands.
  - **An edit** is one primitive, built by one of the universal operators from continuous parameters. The four
    configurations:
    - a solid of revolution;
    - a recess spliced into its top;
    - radial sweeps replicated about the axis;
    - concentric sweeps at a pitch.

    A nudge to one parameter of a kept edit is the other kind of edit.
  - **What each edit records:**
    - its anchor, as WGS-84 latitude, longitude and ellipsoidal height;
    - its evidence: the scan points and their digest, the tile photo's crop key and the measures read from it;
    - a confidence;
    - a label per parameter, and the edit's label (the weakest shown parameter's);
    - the proposing run;
    - its before and after metrics.
- **The geometry** comes from the C++ engine (`scratchbox_micro_edit.hpp`, `scripts/micro_edit_build.cpp`). Each unit is
  built in its own anchor's frame, then hashed, then placed.
- **The loop** (`runMicroEditPass`). Each run:
  1. retires what the new scan contradicts;
  2. replays the kept edits and hashes the replay (drift = the hash differs from the previous run's);
  3. proposes, in order: the next rung for each kept unit (recess, radial sweeps, concentric sweeps), nudges, then new
     units;
  4. verifies each proposal alone;
  5. keeps at most `maxEditsPerRun` (1).
- **What the loop measures** (`micro-edit-evidence.ts`):
  - round units on the roof, from the scan;
  - the photo's ring step, angular period (count, phase, spoke width) and radial period;
  - a held-out score.
- **The driver** is `scripts/micro_edit_run.ts`. Each run is a fresh extraction into an empty tile cache.

## The checks a proposal must pass, alone

- **Bounds:** every vertex inside the vector footprint, and inside the scanned volume. The scanned volume is under the
  scan's own top, or inside a kept, measured unit's walls (a hollow fan shroud reads as its floor in the height map).
- **Size:**
  - A nudge moves at most 10 cm or 10% of its parameter (a count by one).
  - A part that moves surface is held to at most 15 cm, at the 95th percentile.
  - A solid fitted to the scan's own copy is held to 30 cm, its fit residual.
  - A thin added part is held to its thickness.
  - The moved area is at most the larger of 4 m² and half the unit's own surface (see *Open*).
- **The scan:** the RMS distance of the unit's own points to the model must fall. A step below the tiles' resolution
  must not raise the RMS by more than 2 cm.
- **The held-out photo:** a Static Maps satellite image, which no proposal reads. The model is drawn top-down, each
  surface group in its median tile-photo colour. Its luminance SSIM inside the unit's disc, at 10 cm a pixel, must not
  fall. The gradient correlation is recorded, not gated: thin blades at the photo's own count and phase lower it, while
  SSIM rises.
- **The satellite's registration:** the roof leans 22.5 m in the satellite image, measured on a zoom-19 image (±30 m,
  NCC 0.51). Each unit's zoom-21 crop is then registered within 1.5 m (NCC 0.93).

## The four runs (Penn 2, 2 Penn Plaza, the six cooling-fan shrouds)

- **Setup:**
  - fresh extraction each run, radius 60 m;
  - building `building/17/38596/49262/f47`;
  - place store `gs://scoutscan-building-training/places/v1/40.75032_-73.99172` (the Penn district's place);
  - focus on the fan cluster (new units only within 9 m of it);
  - run ids `me-penn2-20261104-r1..r4`.
- **What the scan measures:** each fan is a rough octagonal ring. Outer wall about 3.46 m, inner wall about 3.17 m, rim
  0.93 m over a floor on the roof. Radial RMS of the walls is about 2% of the radius. The six rings touch; a circle vote
  on the raised cells separates them.

| Run | Replay hash (= previous run's) | Kept | Scan RMS before → after | Held-out SSIM before → after | Refused (reason) |
|---|---|---|---|---|---|
| 1 | first run | fan 1 ring (radius 3.462, inner 3.191, height 0.928; measured) | 0.444 → 0.052 m | 0.187 → 0.230 | none |
| 2 | 056825d2… = 056825d2…, no drift | fan 2 ring (3.441 / 3.161 / 0.930; measured) | 0.424 → 0.052 m | 0.168 → 0.209 | fan 1 recess: moves 40.5 m², over its 38.7 m² limit |
| 3 | 737aaef5… = 737aaef5…, no drift | fan 1: 9 radial sweeps, phase −0.034 rad (count, phase, width photo-inferred; pitch generated) | 0.052 → 0.052 m (within resolution) | 0.230 → 0.248 | fan 2 recess: moves 39.7 m², over its 38.4 m² limit |
| 4 | 747c66b6… = 747c66b6…, no drift | fan 2: 9 radial sweeps, phase 0.085 rad | 0.052 → 0.052 m (within resolution) | 0.209 → 0.246 | none (only one edit kept a run) |

- **The blade count:** the tile photo and the satellite agree on 9. Each has its angular power at k = 9 (about 4,000)
  far above every other count (at most about 1,250). The phases agree too: −0.036 rad in both photos, −0.034 rad drawn.
- **Sheets:** each run's sheet is beside its run (`/Volumes/3DTESTING/Scratchbox-drive/micro-edits-20261104/proof/run<N>/sheet.png`).
  They show the tile photo, the held-out satellite, the model from above, and the scan and the edits seen obliquely,
  with the edit list and its metrics.
- **Cost:** no model calls. Per run: one 3D Tiles root session, one vector tile and two or three Static Maps images,
  about $0.01. The four runs cost about $0.05; with the recon runs before them (about 15), the total is under $0.30.
- **Load:** run 4 started at a load average of 176, from other sessions. It is one light process (about 200 s);
  runs 1 to 3 started below 32.

## Open

- **Area bound on large units.** "A few m²" cannot hold for any detail on a 7 m fan: a recess across its floor moves
  about 40 m². The bound used is the larger of 4 m² and half the unit's own surface; recesses there still fail by a
  little. The other option is a bound in m² only, with large units' details split over runs. That choice is the user's.
- **Recess on these fans.** The scan already measures their open top (the floor 0.93 m under the rim). The photo's ring
  inside it is the fan's tip circle, not a bowl, and the held-out SSIM fell on one tried earlier. Refusing it is right.
- **Wiring into a build.** The loop runs from the driver. Wiring it in means pipeline K reading the plan, cutting the
  scan's own copy (`microEditContains`) and adding the layer (`writeMicroEditGlb`), with a switch.
- **Concentric sweeps (the grille).** Not yet tried live: rung 3 comes after both fans' sweeps. The satellite shows
  straight grille bars, not rings, so concentric sweeps would likely be refused. A bar grille (straight sweeps
  replicated at a pitch) is the next operator configuration to add.
