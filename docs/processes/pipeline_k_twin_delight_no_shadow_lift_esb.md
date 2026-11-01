# Process: Pipeline K's twin de-light greyed the ESB: no shadow lift on any surface, and harmonising over a log floor

> **Recorded:** 2026-11-01
> **Status:** Verified (two fresh uncached ESB builds; renders from M1's four pano poses; tests and typecheck); Unverified (not re-judged: M1 re-judges; not looked at in the live viewport)
> **Tags:** `operate-scratchbox` `pipeline-k` `twin-delight` `texture-harmonize` `photo-match` `empire-state`
> **Target Domain:** Staged locations / pipeline K / twin textures (`tile-refine-twin.ts`, `pipeline-k/texture-harmonize.ts`)

---

## 1. Session Context

* **What prompted this session:** M1's paid photo-match call on 2026-11-01 (eval
  `empire_state_building_20_w_34th__20261101T052223_16e0`, branch `feat/m1-world-judge`) scored K run `0bb20154` 5.08
  overall against the raw scan's 6.34 at the Empire State Building. In its grids K's facade is a washed-out grey where the
  photo and the raw scan show warm limestone with contrast, and K's storefront band is a flat grey slab where the raw scan
  has dark glazing. The task: find the first K stage that loses the tone and the first that loses the glazing, and fix both
  generally.
* **Instance used:** launch entry `scratchbox-hopeful-euler` (web `3730`, API `3731`, tools `3732`), branch
  `claude/hopeful-euler-0e3755` on `feat/m1-run` (the code that built `0bb20154`), `SCRATCHBOX_CACHE_RESTORE=off`,
  `SCRATCHBOX_STAGED_DISTRICT` unset. Builds went through the app's tool endpoint (`POST /gemini/tools/run-stream`,
  `google_3d_tiles_get_clay` with `0bb20154`'s request: "Empire State Building, New York", `isolate`, `trees`,
  `pipeline: 'k'`). Before each build the worktree's stage caches were empty (deleted, run records kept) and the server
  restarted.
* **Coordination:** the main checkout's uncommitted K work was read first: `sky-delight.ts` on the native BVH with its
  sign fixed, `tile-refine-twin.ts` moving the sky step first, `wall-grammar.ts`'s tier grammar and `facade-lattice.ts`'s
  same-facing cut (which the Pipeline K session advised reverting). None of it touches the analytic de-light that caused
  this. The sky de-light stays opt-in (`SCRATCHBOX_K_SKY_DELIGHT=1`) and did not run in `0bb20154`.
* **Cost estimate, written before building:** about $1.20 a fresh K build at the ESB (measured on run 7f594cd6:
  the facade reader on Flash, about 27 Argon calls), plus up to 16 Street View images; at most two builds, about $5. Under
  the $100 the user allows without asking. No judge call was made: M1 re-judges.
* **Cost, after:** build 2's vision replies (its reply cache): 334 calls on `gemini-3.8-flash` (513,234 input, 101,481
  output and thinking tokens: $0.77 at $0.75 / $3.75 per million) and 26 on `gemini-4-argon` (48,282 / 22,756: $0.32 at
  $2 / $10), about $1.09, plus up to 16 Street View images. Build 1's reply cache was cleared with its stage caches; it ran
  the same stages on the same tile, so about the same. Both builds: about $2.20 in vision calls.

---

## 2. What Was Tested & What Worked (Verified)

### The diagnosis (run 0bb20154, offline, its own stage files)

Each stage's GLB rendered by photo_match's own renderer (`renderTriangles`, headlight, as M1's grids) from M1's view v0
(pano VqOxFz9R, the corner with the Starbucks Reserve); mean and spread of luma over the building's pixels (sRGB):

| Stage output | mean luma | sd luma | storefront |
|---|---|---|---|
| raw tile | 56.2 | 30.3 | dark glazing |
| tile_refine | 54.1 | 35.3 | dark glazing |
| polish: cleanup, lattice | 54.0, 53.4 | 35.1, 34.7 | dark glazing |
| polish: base, clip, infill, finished (the twin's input) | 47.4 to 47.5 | 28.8 to 28.9 | dark glazing |
| **twin** (`twin.glb`) | **95.9** | **16.2** | **grey slab** |

The twin rebuilt offline from the run's own polish output (`tileRefineTwin`, no model calls), one step at a time:

| Twin variant | mean luma | sd luma |
|---|---|---|
| no de-light, no harmonise | 47.3 | 29.0 |
| harmonise only | 49.0 | 30.5 |
| **de-light only** | **97.3** | **15.1** |
| de-light and harmonise | 95.6 | 16.2 (= the run's twin) |

* **First stage where the tone drops, and first where the storefront glazing goes: the twin's analytic de-light**
  (`tile-refine-twin.ts` `delightImage`, `PHOTOGRAMMETRIC_DELIGHT.defaults`: `shadowLift 0.60`, `highlightCompress 0.45`).
  Everything before it (tile_refine, the lattice, base cleanup, clip, infill) keeps the tone and the glazing; harmonising,
  the facade reader and the material regions do not change the colour in this view. The lift pulls every texel darker than
  about a third of white toward a grey of `1.6 x luma + 0.14`, uncapped and per texel, so a storefront's glazing is lifted
  to grey and the stone's darks are lifted and desaturated.
* **The photo agrees** (CIELAB over M1's target mask, the photo from M1's grid): in all four views K had half the raw
  scan's contrast and chroma, and a third of the photo's (v0: photo L* 36.7 / sd 21.0 / chroma 6.9, raw 20.9 / 12.8 / 4.3,
  K 41.0 / 6.0 / 2.3).
* **The leaf photos carry almost no cast shadow to lift** (`sky-delight.ts`, measured on the ESB 2026-10-28: no sun
  direction explains more than 1.2 to 1). So on walls the lift removes material contrast, not light; the same reason
  roofs already took none ("a dark roof is a dark material").
* **The storefront step seen in M1's clay grid is the scan's.** The raw scan's clay steps out at the same place by the
  same amount; K keeps it (its clay before and after the fix is identical).

### The fix (general, for every K and K-D twin)

1. **No shadow lift on any surface in pipeline K** (`tile-refine-twin.ts` `PIPELINE_K_SHADOW_LIFT = 0`, passed by the
   orchestrator for every K twin; highlights are still compressed; other twins keep the default lift). Version
   `tile-refine-twin/v3`.
2. **Harmonising compares colours in logs over a floor of 0.03 linear (about sRGB 48)**
   (`texture-harmonize.ts` `logFloor`, was 1e-3; version `texture-harmonize/5`). Found by the stage review of the first
   fixed build: with the photos no longer lifted, the near-black window texels' colour noise (a few sRGB levels, a large
   ratio) steered each photo's per-channel gains and offsets and laid lilac and green patches over the shaft's stone,
   seen from above. The lift had hidden them under its grey; `0bb20154`'s twin shows the same patch, desaturated. Offline
   on the fixed twin, the low-frequency hue change harmonising adds (CIELAB a*b*, 15 px blur, over the building):

   | Harmonise log floor | aerial p50 / p95 | v0 p50 / p95 | v3 p50 / p95 |
   |---|---|---|---|
   | 1e-3 (before) | 1.48 / 4.95 | 0.57 / 1.77 | 0.93 / 2.24 |
   | 0.01 | 1.17 / 3.63 | 0.38 / 1.56 | 0.82 / 1.83 |
   | **0.03** | **0.97 / 2.83** | **0.34 / 1.54** | **0.71 / 1.55** |

   The seams are still levelled at 0.03 (mean patch difference 0.2446 -> 0.2064 in its own log colour; the figures of
   different floors are not comparable, the floor changes the scale).
3. Tests: `pipeline-k-roof-delight.test.ts` (K keeps a dark wall's colour and a storefront's dark glazing and the stone's
   grain and warmth; the default lift still greys them), `pipeline-k-texture-harmonize.test.ts` (two photos whose
   near-black windows differ by a few levels: the stone's hue moves under 1% at the default floor, over 2.5% at 1e-3).

### Fresh build 1, `fdd23ea5` (fix 1 only)

* Committed, 1,471 s, every stage a cache miss (`textures-late` reads "cached", vacuously: no later layers). Its tile
  extraction, fetched fresh, is byte-identical to `0bb20154`'s (`textured_tile_seams_2.glb` sha256 `69027099adf7...`), and
  its remesh and polish render to the same figures (v0: lattice 53.4 / 34.7, finished polish 47.5 / 28.9): the twin is the
  only difference.
* The twin's materials step took 1,034 s: as the first build in a fresh worktree it measured and prepared the texture
  library's sets (`build/texture-library/`, kept beside the library for later builds, outside the stage caches).
* The tone and the glazing were back (see build 2's table, within 1 L* of it), but the stage review found the harmonise
  patches above.

### Fresh build 2, `00a8c298` (fixes 1 and 2, the committed code)

* Committed, 463 s, every stage a cache miss, the same tile (sha256 `69027099adf7...`). The materials step took 44 s,
  reusing the library preparation build 1 made. Published model `/models/empire_state_building_new_york_iso_l2_tex_a015355e.glb`.
* Harmonise `texture-harmonize/5`: 203 photos, 69,445 patch pairs, kept, 0.2452 -> 0.2526 (matched) -> 0.2067 (levelled).
* The GLB's provenance says what was done: "de-lit (highlights compressed (highlightCompress 0.45), no shadow lift (a
  brightness curve cannot tell a shadow from a dark material); 203 of 203 photos)", source `tile-refine-twin/v3`.
* **Renders from M1's four views** (`heldOutViews` on the four panos reproduces M1's headings, pitches and fields of view
  exactly; drawn in context, the tile with the isolate's triangles cut out, by `renderTriangles`; no registration
  correction, M1's was 1 to 3 px). The target's tone over M1's target mask (CIELAB):

  | View | photo L* / sd / chroma | raw scan | K before (`0bb20154`) | **K after (`00a8c298`)** |
  |---|---|---|---|---|
  | v0 VqOxFz (Starbucks Reserve corner) | 36.7 / 21.0 / 6.9 | 19.7 / 12.2 / 4.2 | 40.6 / 5.8 / 2.2 | **20.5 / 12.6 / 4.6** |
  | v1 w4nU8T | 44.7 / 23.3 / 8.1 | 26.8 / 14.5 / 4.6 | 42.0 / 8.5 / 2.6 | **28.2 / 14.7 / 4.8** |
  | v2 uPcMge | 71.3 / 22.6 / 9.9 | 25.2 / 14.0 / 4.5 | 44.1 / 7.7 / 2.0 | **27.1 / 14.4 / 4.8** |
  | v3 hi-cmK | 79.7 / 18.8 / 5.7 | 36.3 / 16.9 / 5.8 | 50.1 / 11.1 / 3.3 | **38.6 / 17.5 / 6.0** |

  In the grids the storefront band is dark glazing again, as in the raw scan, and the stone keeps its warmth and contrast.
  From above (two elevated views) build 2 reads as the scan does, without build 1's lilac and green patches.
* **Stage review, the rest of the twin:** the facade reader read 120 of 253 planes (73 replaced, 44 kept, 3 skipped, 0
  failed; `0bb20154`: 70 / 43 / 6 / 1). The visible-defect and Street View score reports are identical to `0bb20154`'s
  (they are geometry-side).

---

## 3. What Broke / Didn't Work

* **The raw scan and K are both much darker than the Street View photos** (target L* 20 to 39 against 37 to 80). That is
  the leaf photos' own exposure (aerial captures), not a K stage, and this fix does not touch it; K now matches the scan.
* **The roof shadow lift fits more decks and leaves more halo.** With the walls no longer lifted, the wall-class texels
  beside the decks are darker and the sun fits change: 7 of 10 decks matched a sun (4 in `0bb20154`), the large NW podium
  deck is now rejected and the SW podium rim lifted. Its QA from above: lifted 2,754 m² (3,169), halo 333 m² (217), lifted
  lit 436 m² (502), unreferenced 953 m² (1,385). Roofs take no lift in either build, so this is the sun fit reading
  different neighbours, not a change to the roofs' own colour. Not fixed here; for whoever owns `roof-shadow.ts`.
* **Material regions now see the true, darker tones** (class L* 15 / 31 / 48 against 38 / 46 / 57 before), and the
  library ranking now gives the dark spandrel class `asphalt_pit_lane` and the darkest class `Leaking004` (by ranking: the
  chooser picked none), where it gave concrete sets before. Only the roughness and normal under the photo change (the photo
  stays the colour); neither set is a cast-aluminium spandrel. Not fixed here; for whoever owns `material-sets.ts`.
* **The photo-match dry run refuses a fixed pose with no terrain under its pano** ("no ground under pano ... it stands off
  the reference tile") for two of M1's four panos (w4nU8T, hi-cmK), where the automatic views place the eye on the
  structure's base. The renders here used `heldOutViews` directly. `photo-match-evaluate.ts` is the M1 session's; reported,
  not changed.

---

## 4. Candidate Tool/Service Ideas

* **A per-stage render of a staged run from given poses** (each polish step and the twin's steps, by photo_match's
  renderer). This session hand-wrote it (a vite-node script over `renderTriangles` and `tileRefineTwin` with steps
  switched); with it, "which stage first loses X" is one call.
* **The twin's intermediate photos written per step** (after the de-light, the roof lift, harmonising), so a run keeps
  the evidence the twin's stages produced; today only `twin.glb` and the roof audits are kept.
* **Fixed poses that fall back to the structure's base** as the automatic views do, so a held-out pose can be rendered
  again for any build without the judge.

---

## 5. Reproduction Steps

1. Branch `claude/hopeful-euler-0e3755` (on `feat/m1-run`); launch entry `scratchbox-hopeful-euler` (`env -u
   SCRATCHBOX_STAGED_DISTRICT SCRATCHBOX_CACHE_RESTORE=off`, ports 3730/3731/3732) with the worktree's `.scratchbox/cache`
   empty but for `staged_location/runs/`.
2. `POST http://127.0.0.1:3731/gemini/tools/run-stream` with `{"name": "google_3d_tiles_get_clay", "args": {"query":
   "Empire State Building, New York", "isolate": true, "trees": true, "pipeline": "k"}, "workspaceRoot": "<worktree>"}`.
3. Render the run's published GLB, `0bb20154`'s and the tile cut to the isolate from M1's four panos with
   `heldOutViews` (photo-match-evaluate.ts) and `renderTriangles`, in the tile with the isolate's triangles cut out; take
   the photo panel and the target mask from M1's grids (`feat/m1-world-judge`,
   `docs/screenshots/m1_prereg/esb_paid/`).
4. Tests: `pipeline-k-roof-delight.test.ts`, `pipeline-k-texture-harmonize.test.ts` (credential-free); `npm run typecheck`.
