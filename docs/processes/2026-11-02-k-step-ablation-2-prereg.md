# Preregistration 2: pipeline K with its de-light and reveals fixed, against the raw scan at the benchmark places

Date: 2026-11-02. Status: **written before any build or paid call of this run.** Nothing below changes after this line
except the run record and the report. A bar, arm, place or view changed after a paid call is a new preregistration that
names this one.

**Result (2026-11-02):** the ESB is not judged (2 views register). The Haughwout and the Ferry are indicative
(`matchedShare` under 0.99). Nothing is named.
- The de-light now costs nothing: turning it off changes no score.
- K is 0.27 below the raw scan at the Haughwout, where lattice off or window fit off reads level.
- K is 1.20 below at the Ferry, where the loss is geometry none of these arms isolates.
- See "Report".

## The first run, and why this one is made

- **What the first found.** [The first preregistration](./2026-11-02-k-step-ablation-prereg.md) made one paid call at the
  ESB (eval `..._20261102T192257_597f`).
  - Only 2 of its 8 fetched views registered, so by its amendment 1 it was indicative only and named nothing.
  - Indicatively, its stage cuts put 1.17 of K's 1.83 overall gap to the raw scan in the twin's de-light, a step with no off
    switch, and most of the rest in the facade rebuild.
  - Two of its arms were the only ones to move K: lattice off and window fit off (+0.67 each).
- **What changed since.** Branch `fix/k-twin-delight` ([the fixes' record](./pipeline_k_delight_chroma_and_reveal_unfold.md)):
  - the de-light lifts no shadow, and harmonising compares in logs over a floor. Picked from the session that first fixed
    it, these keep the photo's chroma within 0.1% and its hue within 0.3° on the ESB's wall texels, where the old lift took
    58% of the chroma;
  - the de-light has an off switch (`twin.delight`, `SCRATCHBOX_K_DELIGHT=0`);
  - the lattice's reveals take the proud side's photo, so a window is no longer drawn twice.
- **Why it runs again.** The parent session relayed the user's "Do what you think is best" and asked for this second
  preregistration:
  - views from the list the paid call will actually fetch, era-checked, at least 3 registering per place;
  - the ESB, the Haughwout and the Ferry;
  - arms for de-light off, the fixed de-light, lattice off and window fit off.

  The first run's two judged views cannot settle anything, and its K is not the K the fixes make.

## Question

On the fixed code, **is K level with or above the raw scan** at the benchmark places? And does turning off the de-light,
the lattice or the window fit move K?
- **K level or above at a place:** the de-light and reveal fixes stand as the answer to the first run's question there.
- **K still below:** the arms that move it name what is left. The next fix, as a task of its own, is the one whose removal
  brings K level.
- **Nothing moves and K is below:** the loss is in a step none of these arms isolates. The report says which stage cut it
  points at.

## Arms

All arms at a place are built fresh on `fix/k-twin-delight` at the commit this preregistration is committed with, through
the app's tool endpoint (`google_3d_tiles_get_clay`), on this worktree's own app instance with
`SCRATCHBOX_CACHE_RESTORE=off`.
- **Fresh.** The worktree's stage caches are deleted before each place's first build (the run records are kept), and the
  server is restarted.
- **The same caching design as the first run.** K default builds first and computes every stage. The arms then reuse only
  the stages upstream of their own switch, which K default computed minutes earlier; each switch is in its stage's cache
  key (checked in the first preregistration).
- **Retries.** A transient time limit is finished by the app's own retry of the stage the result names, at most twice.

| Id | Label (reports only) | Built |
|---|---|---|
| K | K, FIXED DE-LIGHT (the default) | `{ query, isolate: true, trees: true, pipeline: 'k', stageIntoActiveScene: false }`, named first: the reference |
| raw | RAW SCAN (CUT TO TARGET) | `baseline: true` |
| noDelight | K WITHOUT THE DE-LIGHT | as K, `steps: {'twin.delight': false}` |
| noLattice | K WITHOUT LATTICE | as K, `steps: {'polish.lattice': false}`; material regions go with it: they read the rebuilt facades |
| noFit | K WITHOUT WINDOW FIT | as K, `steps: {'remesh.windowFit': false}`; the wall grammar and sheets go with it |
| X2 | DECOY MOVED 4 M | K's twin, root nodes translated [4, 0, 0] (the first run's `make_decoys.py`) |
| X3 | DECOY FLAT COLOUR | K's twin, every base-colour image one colour, the pixel-weighted mean |

The queries are M1's:

| Place | Query |
|---|---|
| ESB | "Empire State Building, New York" |
| Haughwout | "Haughwout Building, 488 Broadway, New York" |
| Ferry | "Ferry Building, San Francisco" |

The judge sees 7 renders per call, raw included, which is close to the 5 to 7 M1 was checked with.

## Places and views

**The view probe, per place, after the builds.** It is one paid `photo_match_evaluate` call that only finds the views.
- **Its arguments:** the paid call's own arms (so the same panos are excluded), `views: 6` (which fetches 12), `runs: 1`,
  `clay: false`, `judgeRegions: false`, `trees: true`, `baseline: true`.
- **What it gives:** the real pano lookup, the fetch and the registration.
- **It decides nothing.** Its judge scores are discarded and never quoted. It is not a comparison: no bar reads it.

**The era check.** Every view the probe registers is set beside the tile at its pose, by M1's amendment 7 method. A view of
another era, or one whose photo does not show the target, is dropped.

**The paid call's views** are fixed poses: the probe's registered, era-checked views, each by `panoId`, `headingDeg`,
`pitchDeg` and `fovDeg` as the probe used them.
- **How many:** at most 6, nearest first; `views` equals their number.
- **A pose that does not register again,** or that a build has since used, drops out, as the tool reports.
- **A place with fewer than 3 such views is not judged,** and is reported.

**`matchedShare`.** In M1 the Haughwout (0.875) and the Ferry (0.862) were under the 0.99 that bar V4 needs. If a fresh
build is under it again, that place's result is indicative, and the report says so.

## Bars

The first preregistration's bars, unchanged, with its amendment 1:

| # | What it checks | Bar |
|---|---|---|
| V1 | judge spread, mean over all arms | at most 0.75 |
| V2 | X2 against K, placement | X2 at least D above K (D = half X2 − K in this place's dry run, at least 2 px), over at least 2 views with a placement |
| V3 | X3 against K, materials and overall | each at least 1.0 below K |
| V4 | raw frame agreement; `matchedShare` | 1.00; at least 0.99 |
| P | raw against K, overall | raw above K by more than both arms' spread, at three quarters of the judged views and at least 3 |

- **Per arm:** "moves K", "level with or above raw" and "gap share", as defined there.
- **Two readings at each place:**
  - **K level:** K is at least raw − (the larger of K's and raw's spread) on overall, at three quarters of the judged views
    and at least 3, with V1 to V4 met. This reading does not need P, which presumes K below.
  - **A step named:** an arm moves K up **and** is level with or above raw on overall.
- **Secondary, deciding nothing:** shape, clay shape, placement, materials, detail, the region scores, and the first run's
  numbers set beside these.

## Decoys

X2 (moved 4 m) must lose on placement by D (V2). X3 (one flat colour) must lose by 1.0 on materials and overall (V3). Both
are made locally from each place's K twin, free.

## Stop rules

- **Spend:** stop when this run's total passes **$60**, and on any 403 or spend-cap error.
- **Disk:** no build starts under 10 GB free.
- **A build that is not what its arm says:** its record shows a failed stage, a stage downstream of its switch cached, or a
  degradation K's record lacks and its switch does not explain. Such an arm is not judged.
- **The dry run, per place, before the paid call:** an empty or black render, an arm with 0 triangles, `frame_mismatch`,
  `liftedM` over 1 m, or a used pano not excluded stops that place.
- **Fewer than 3 registered, era-checked views** at a place: not judged.
- **V1 to V3 missed:** nothing is named at that place.
- **V4 missed:** that place is indicative, and the report says so.
- **One paid call per place,** the probe aside, and no re-run.

## Exposure

- **Panos any arm's build used** are excluded by the tool, from every arm's runId.
- **Panos the earlier comparisons judged:**
  - **ESB:** the first run's VqOxFz9R and uPcMge9M, and M1's.
  - **Haughwout:** M1's hN4AIglX, dXtEY_Zc, iqiqiEgp and uHC_00kK.
  - **Ferry:** M1's ZR9VHLtY, z6iR0rUI, 4sXa5k8s and nF68xO_p.

  These are not excluded: the judge does not learn from them (M1's decision, kept). Any that the probe registers are named
  in the run record.

## The free dry run, per place

M1's driver under vitest, credentials unreachable (empty HOME), with the paid call's fixed poses as `poses`:
- every arm renders at every pose;
- the call count is views x 3 x 2;
- D for V2.

Its discovery reads only the build's metadata cache, so its automatic views can differ from the paid call's (the first
run's finding). With fixed poses only, the views are the same.

## Cost, estimated before any of it

Prices as in the first preregistration: Argon $2 / $10 per million through 2026-11-30, Flash $0.75 / $3.75, Street View
about $7 per 1,000.

| Item | Basis | Low | High |
|---|---|---|---|
| Builds: 4 per place, 12 in all | the first run measured $5.69 of vision calls over 19 ESB builds (at most $1.20 for a fresh K); at most 16 survey images per build | $6 | $18 |
| View probes: 3 | 12 photos and 6 single-run calls of 8 images, per place | $0.40 | $1.50 |
| Era checks | the probes' photos are the ones checked; swaps up to 6 photos per place | $0 | $0.15 |
| Judge: 3 places, up to 6 views x 3 runs x 2 | up to 108 calls of 8 images, about 10k tokens in; the first run measured $0.07 a call at 23 images (thinking about 1.4k) | $3 | $30 |
| Judge photos, footprint fetch | at most 6 photos and 4 vector tiles per place | $0.15 | $0.30 |
| **In all** | | **about $10** | **about $50**, against the $60 stop |

Under the user's $100, so no approval is needed. The actual spend is reported after.

## Order

1. Commit this preregistration.
2. Per place, ESB first:
   - delete the stage caches and restart;
   - build K, then noDelight, noLattice and noFit;
   - check every record; make X2 and X3;
   - run the view probe; era-check; commit the views;
   - run the dry run with them as fixed poses; set D;
   - make the paid call; record.
3. Report against the bars, with a labelled proof sheet.

## Run record

Values written as they are fixed.

- **The code:** `fix/k-twin-delight` at 0526929f, the commit this preregistration was committed with (PR #17).
- **The app:** launch entry `scratchbox-k-step-ablation`, web 3740, API 3741, tools 3742, `SCRATCHBOX_CACHE_RESTORE=off`,
  restarted at 12:36.
- **Fresh caches.** At 12:35 this worktree's stage caches (9.9 GB: tile_refine, scan_fit, tile_vegetation and every
  staged_location stage) were deleted, keeping the run records, the judge's earlier outputs and the first run's published
  GLBs. There were 27 GB free after.
- **The builds:** the three places' K builds together, then their nine arms at most four at a time (a working limit, unlike
  the first run's), each finished through the app's retry of a transient time limit, at most twice.
- **All 12 built from 12:36 to 12:55**, the machine quiet (load 3 to 10). Each was checked (`check2.py`, the session's
  scratchpad):
  - its switch's step was skipped, and K ran it;
  - its twin was not served from the cache, and it has one twin;
  - it carries no degradation beyond its K's.

  | Place | K | noDelight | noLattice | noFit | K's degradations (every arm carries the same) |
  |---|---|---|---|---|---|
  | ESB | b1729e53 (twin 44f4179b) | 74e6d96a (13190436) | 2c1e8b70 (a78f689b) | fa85ab32 (ebfd7acc) | one face not surveyed (transient: its image timed out); the arms have none |
  | Haughwout | d63567da (47b4e5cb) | 20fa91b0 (472f459c) | 5ed1256c (2a22484e) | 2735d954 (dbc5f36e) | 3 faces no pano looks at; visible holes 18.2% (M1's f4f25a8e: 18.2%) |
  | Ferry | 345e37dd (411b6d88) | 8d29135e (e0ee8185) | 1080eb5d (d2423751) | bfdfdfbe (d49cc16d) | 3 faces no pano looks at; visible holes 29.7% (M1's cdbda9bb: 29.8%); ownership vote not used |

  - **The Haughwout's and the Ferry's degradations are the places' own.** M1's K builds there carried the same, to the
    tenth of a percent.
  - **The ESB's K survey.** A retry of its survey (run d6a673a6) did worse under the load of the arms: four readings timed
    out at 240 s. It served the same remesh and twin from the cache, so the model is K's either way.
    - K stays b1729e53.
    - The survey feeds only K's notes and the judge's exclusions, and the three arms surveyed all 16 faces, so the
      excluded panos are complete.
  - **The lattice off again leaves material regions out** (`twin.materials` failed at once at every place: no rebuilt
    facades to read).
- **The view probes** (12:56 to 13:15; one call each, scores discarded and not quoted):

  | Place | Fetched | Registered | Probe's judged views | `matchedShare` |
  |---|---|---|---|---|
  | ESB | 11 | **2**: VqOxFz9R (2024-09, 83 m), uPcMge9M (2026-04, 92 m) | 2 | 0.996 |
  | Haughwout | 12 | 7 | 6 | **0.875** |
  | Ferry | 11 | 5 | 5 | **0.862** |

  - At the ESB nine of the eleven did not register: "the edge search did not lock onto the scan", 12 → 12 px, and
    G8sOFZp8 12 → 6.35 px. These were the same podium-side panos as the first run's paid call (reported to the M1 session).
  - **So the ESB is not judged** (fewer than 3 views, this preregistration's rule).
  - **The Haughwout's and the Ferry's results are indicative** (V4: `matchedShare` under 0.99, as in M1).
  - Their paid calls are still made, as this preregistration says, for what they show as information.
- **The era check** (amendment 7's method), on the probes' own grids, which set each real photo beside the raw tile at its
  registered pose (`docs/screenshots/k_step_ablation_2026-11-02/run2_era/`). **Every view is kept.**

  | Place | Views (pano, photo date, distance, heading) | Kept, and why |
  |---|---|---|
  | Haughwout | 4rnMoRUG 2026-04 25 m h58; n_1JJ5Vm 2026-04 28 m h97; hN4AIglX 2026-04 37 m h334; dXtEY_Zc 2026-04 39 m h63; iqiqiEgp 2026-04 43 m h183; nygqgDGF 2026-04 43 m h98 (p15.5, f52) | the cast-iron arcades and the corner clock the tile holds; the storefront signs differ; hN4AIglX, dXtEY_Zc and iqiqiEgp are M1's |
  | Ferry | 8UfT-51p 2025-05 54 m h46 (p18.5, f50); 4sXa5k8s 2026-09 57 m h121; A62bPfiJ 2026-09 71 m h342; XL-oDO4u 2026-09 110 m h334; GOgaHhj9 2026-09 116 m h133 (the last four p9 to p18, f50) | the clock tower and the arcade as the tile holds them; XL-oDO4u's construction fence is temporary (as M1 found); 4sXa5k8s and XL-oDO4u are M1's |

- **The paid calls' views**, fixed here: these 6 and 5 views as fixed poses (`panoId`, `headingDeg`, `pitchDeg`,
  `fovDeg` as the probes used them).
  - Haughwout: `views: 6`. Ferry: `views: 5`.
  - `runs: 3`, `clay: true`, `judgeRegions: true`, `trees: true`, `baseline: true`.
- **The free dry runs** (13:21 to 13:34, the server stopped, credentials unreachable, the fixed poses as `poses`). Out:
  `docs/screenshots/k_step_ablation_2026-11-02/run2_{hw,ferry}_dryrun/`.

  | Place | Poses judged | Stand-in calls | Build panos excluded | Placement (stand-in; raw / K / X2) | **D** |
  |---|---|---|---|---|---|
  | Haughwout | 6 of 6 | 36 | 1 | 2.50 / 6.21 / 20.71 | **7.25 px** |
  | Ferry | 5 of 5 | 30 | 5 | 2.13 / 6.33 / 16.65 (3 views with a placement) | **5.16 px** |

  Every arm drew at every pose. The renders with the de-light fixed take the raw scan's colour, not the first run's grey.
- **The paid calls:** made from 13:36 on the restarted server, the Haughwout then the Ferry, with the arguments above.
- **The decoys** (`make_decoys.py`) are in `public/models/k_ablation2/`. Their flat colours: ESB sRGB (90, 79, 76), against
  the old K's (123, 119, 117), so darker and warmer with the de-light fixed; Haughwout (87, 80, 90); Ferry (67, 72, 76).

## Report

### The result (2026-11-02): the ESB not judged; the Haughwout and the Ferry indicative; nothing named

- **The paid calls.**

  | Place | Eval | Time | Calls | Views judged |
  |---|---|---|---|---|
  | Haughwout | `e_v_haughwout_building_488_broad_20261102T212027_a78c` | 13:20 to 13:32 | 36 | 6 of 6 fixed poses |
  | Ferry | `1_ferry_building_san_francisco_c_20261102T213308_f286` | 13:33 to 13:44 | 30 | 5 of 5 |

  Every call was answered by `gemini-4-argon`, with no retry, 403 or failure.
- **The ESB is not judged.** Its probe registered 2 views, fewer than 3.
- **The two judged places are indicative only.** Both miss V4 (`matchedShare` 0.875 and 0.862, as in M1). So nothing is
  named, as this preregistration says.
- Every other judge bar is met at both places: the judge repeats itself (V1), and the decoys lose by their margins (V2,
  V3). These are the first runs in which the flat-colour decoy lost by its bar: K's texture now reads as texture.

**Against the bars.**

| Bar | Haughwout | Ferry |
|---|---|---|
| V1 run spread, mean | 0.136, met | 0.133, met |
| V2 X2 placement − K (D) | +9.89 px (7.25), met | +8.99 px (5.16), met |
| V3 K − X3, materials / overall | 1.50 / 1.00, met | 1.54 / 1.46, met |
| V4 frame agreement; `matchedShare` | 1.00 in every view; **0.875, missed** | 1.00; **0.862, missed** |
| P raw above K | raw 4.22 ± 0.16, K 3.95 ± 0.08 (0.27), raw ahead in 4 of 6: missed | raw 5.93 ± 0.09, K 4.73 ± 0.09 (1.20), raw ahead in 5 of 5: met |
| K level with raw (bar: raw − spread) | 3.95 against 4.06: not level, 0.11 short; level in 2 of 6 views | 4.73 against 5.84: not level; 0 of 5 views |

**Every arm** (building mask; judge mean ± run spread; placement in px, lower is better):

| Arm | Haughwout overall | shape | clay shape | placement | Ferry overall | shape | clay shape | placement |
|---|---|---|---|---|---|---|---|---|
| raw | 4.22 ± 0.16 | 4.44 | 4.67 | 4.77 | 5.93 ± 0.09 | 6.60 | 6.00 | 3.05 |
| **K, fixed de-light** | **3.95 ± 0.08** | 4.50 | 4.89 | 7.33 | **4.73 ± 0.09** | 5.47 | 4.07 | 6.50 |
| K without the de-light | 3.95 ± 0.08 | 4.50 | 4.89 | 7.33 | 4.73 ± 0.09 | 5.47 | 4.07 | 6.50 |
| K without lattice | 4.17 ± 0.16 | 4.67 | 3.22 | 7.33 | 5.07 ± 0.19 | 5.53 | 4.67 | 6.87 |
| K without window fit | 4.11 ± 0.08 | 4.72 | 3.94 | 7.39 | 5.07 ± 0.19 | 5.60 | 4.33 | 6.87 |
| X2 moved 4 m | 3.89 ± 0.31 | 4.11 | 4.39 | 17.22 | 4.27 ± 0.19 | 4.60 | 3.53 | 15.49 |
| X3 flat colour | 2.95 ± 0.08 | 4.00 | 4.89 | 7.33 | 3.27 ± 0.09 | 4.73 | 4.07 | 6.50 |

- **No arm moves K** by the sign rule (three quarters of the views and at least 3).
  - Lattice off and window fit off score above K by more than both spreads at both places.
  - But they are ahead in only 2 or 3 views, tying K in the rest (Haughwout 3 of 6 and 2 of 6, Ferry 2 of 5 each).
- **At the Haughwout, lattice off and window fit off read level with raw** (4.17 and 4.11 against a bar of 4.06), with gap
  shares 0.81 and 0.59. At the Ferry they recover 0.28 of the gap.
- **The de-light off arm scores exactly K's** at both places, on every metric. Its renders differ from K's only by the
  highlight compression.

### What it points at

Information only, not findings of this run.

1. **The de-light costs nothing now.** The first run's stage cuts put 1.17 of K's gap in it at the ESB. Here, with the fix,
   turning it off changes no score at either place. Its colour loss is gone (the flat-colour decoy now loses on materials,
   V3), and the de-light no longer separates K from anything.
2. **What is left at the Haughwout is small and sits in the facade rebuild.**
   - K is 0.27 below the raw scan, a quarter of M1's gap there (raw 3.92, K 3.50, on other views and the old code).
   - Lattice off or window fit off bring it level, but not in enough views to name either.
   - In clay, K's rebuilt geometry still beats the scan (4.89 against 4.67) and the lattice off loses most (3.22). So the
     rebuild helps the shape and costs a little in texture.
3. **The Ferry's loss is geometry, and none of these arms isolates it.**
   - K is 1.20 below raw overall, 1.93 below in clay shape (4.07 against 6.00), and 3.45 px further from the photo's
     silhouette (6.50 against 3.05).
   - Lattice off and window fit off recover only 0.28 of it.
   - The rest lies before or after the lattice. The outline diagnosis (2026-11-01) named two candidates: tile_refine
     snapping the isolate's ragged cut end into a flush slab beside the tower, and the base skirt's spikes along the arcade.
   - The next step is a stage-cut look at the Ferry. K's own snapshots, after tile_refine and after the polish, can be
     judged without a build, as the first run's were at the ESB.
4. **The ESB cannot be judged with these views.** Of its 11 nearest held-out panos, 9 do not register (12 → 12 px), all
   podium-side close-ups. This is the judge's (reported to the M1 session). Until it is fixed, or the ESB is judged from
   views that do register, the benchmark the first run asked about has only 2 views.

### Cost

| Part | Basis | Cost |
|---|---|---|
| Builds | 12 builds' vision calls (their reply cache since 12:35): 57 Argon (97k in, 60k out) and 532 Flash (845k in, 189k out) | $2.14 |
| Builds' Street View | at most 16 survey images each | at most about $1.34 |
| View probes | 13 judge calls of 8 images (from the server log) | about $0.42 |
| Probes' photos | 34 | about $0.24 |
| Paid calls | 66 judge calls, 9.2k to 9.5k tokens in and about 1.2k out each (server log) | about $2.00 |
| Their photos, footprint fetches | 11 photos and a few vector tiles | about $0.10 |
| **This run** | | **about $4.50 to $6.30**, against the estimate of $10 to $50 and the $60 stop |
| **With the first run** | | **about $11.50 to $16** in all |

### Follow-ups

- **A stage-cut judgement at the Ferry.** K's tile_refine and polish snapshots, judged beside raw and K, would show which
  stage holds its geometry loss, at no build cost.
- **The ESB's registration** (the M1 session's judge). Until more than 2 views register there, no comparison at the
  benchmark can be read.
- **`matchedShare` at the Haughwout and the Ferry.** While it stays under 0.99, every building bar there is indicative.
  Whether the 0.99 bar or the isolates should change is a decision for the M1 session and the user.
