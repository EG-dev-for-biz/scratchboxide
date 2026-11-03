# Preregistration: rectified Street View walls for pipeline K (fusion step 1)

Date: 2026-11-03. Status: **written before any run; nothing built yet.** Branch `feat/k-streetview-rectify` from origin/main
`cd52dcb3`. Owner: the pipeline K lane (session serene-bun). Lane decision: MAIN, 2026-11-03.

Plan: step 1 of `docs/research/2026-11-02-street-view-fusion-for-pipeline-k.md` (§2.1 Stage B, §5 step 1). Uncommitted in
the main checkout, read there.

## Question

Can the Street View photos pipeline K's survey already fetches be resampled onto K's facade planes accurately enough to be
evidence for step 2 (the window fit and wall rhythm reading the stack)? Can the agreement gate keep out a photo that
shows something else on the wall?

- **Yes at the ESB and the Haughwout** (P1, P2 met), with Bradbury and the decoys behaving (C1, C2, D1 met): step 1
  passes and step 2 may be planned (its own preregistration).
- **Any bar missed:** step 2 does not start. A missed P bar means the rectification or the poses are not good enough. A
  missed C1 or D1 means the gate is not safe. A missed C2 means the switch leaks into the build. Each is fixed under a
  new preregistration that names this one.

This step is **report-only**. It writes evidence beside the orthos and changes no geometry, texture, opening or score.

## What the step does (the arm under test)

The arm is **K with the step on**: steps `{"remesh.streetViewWalls": true}` in the request, or
`SCRATCHBOX_K_STREETVIEW_WALLS=1`; off by default. Everything else is K as it is on origin/main.

1. **The views.**
   - The survey's own images (`face-survey.ts` `runFaceSurvey`), from memory as they arrived. No new image request.
   - They are registered against the full tile mesh, edges then jointly. This is the evidence stage's registration job
     (`pano-registration-run.ts`), run on the survey images in its worker. It is CPU only.
   - The registered correction and warp are applied to each camera, as `texture-pass.ts` `projectionViewsFromEvidence`
     does.
   - A view the registration leaves at its nominal pose is rectified and written, but refused by the gate. This is
     pipeline E's rule: a nominal pose (about ±2 m) is never used.
2. **The frame.**
   - For every facade in tile_refine's `facades.json`, every view is resampled into that facade's ortho frame:
     `orthoSMin`, `orthoTMax`, `pixel`, `width`, `height`.
   - Each ortho pixel's centre on the plane is projected through the view's camera and warp, and its colour read
     bilinearly.
3. **Masks per pixel:**

   | Mask | What it means | How |
   |---|---|---|
   | Coverage | The point lands inside the photo | — |
   | Visibility | Nothing nearer stands in the way | The full tile mesh rendered from the view's camera (`renderFrameDepth`, as `reveal-depth.ts` uses it); the depth agrees with the point's within `DEPTH_TOLERANCE_M` 1.2 m (pipeline E's) |
   | Ownership | The pixel shows this building | `streetview-ownership.ts` `ownViews`: the isolated scan as the structure, the full tile mesh as the context, the request's place as the description. A view whose cut-out agrees with the projection under `OWNERSHIP_MIN_IOU` 0.3 owns no pixel |

4. **Per pixel:**
   - Ground resolution: one photo pixel's size on the wall, (distance along the view axis) ÷ fx ÷ cos(angle off the
     normal).
   - The angle off the normal.
5. **The gate, per wall and view.** Pipeline E's rules from `pipeline-e/street-view-texels.ts`, reused, not copied:
   - **Qualifying pixels:** covered, visible and owned, at most `MAX_INCIDENCE_DEG` 70° off the normal, resolving the
     wall at least `MIN_SHARPER` 1.5× finer than the tile ortho; then eroded by `ERODE_M` 0.15 m. At least `MIN_TEXELS`
     400 are needed.
   - **Agreement:** `structuralAgreement` compares band-passed luma NCC against tile_refine's ortho over the covered
     pixels both hold, at the best shift within `MAX_SHIFT_M` 1 m. It needs at least `MIN_AGREEMENT_TEXELS` 1500
     pixels, NCC of at least `MIN_AGREEMENT_NCC` 0.3, and a best shift that is not at the 1 m limit.
   - **The phase check (added here; MAIN may veto it before the first build).** On a repeating facade, a pose one bay
     off agrees with the wall almost as well as the true one at zero shift. E's ±1 m search cannot see that.
     - The agreement is also searched along each axis, out to 6 m or a third of the wall's covered extent, whichever is
       less, at every pixel beyond 1 m.
     - Only shifts that keep at least half the zero-shift overlap, and at least 1500 pixels, count.
     - The view is refused when any of those shifts agrees better than the best shift within 1 m.
     - This is E's own "at the limit" refusal, carried over a longer reach.
   - **Report:** every refusal is recorded with its reason. E's verdict without the phase check is recorded beside it.
6. **Output** (where it goes: see "Fixes after the first ESB build"). Images are written for each wall and view the gate
   judges (at least 400 qualifying points); the others are recorded with their counts and reasons, without images:
   - `sv_<facadeId>_<view>.png` (the rectified photo as projected, alpha 0 where not covered);
   - `sv_<facadeId>_<view>_masks.png` (R coverage, G visibility, B ownership);
   - `sv_<facadeId>_<view>_res.png` (ground resolution, 1 grey level = 0.25 cm/px, capped at 255);
   - one `streetview_walls.json`, also saved as the run note `pipeline_k_streetview_walls`. Per wall and view it holds:
     - the pose method and residual;
     - the ownership status and IoU;
     - the median, 10th and 90th percentile resolution, the median angle, and the qualifying pixels;
     - the gate result, NCC, shift and reason, plus E's verdict without the phase check;
     - the pier-line comparison (below);
     - the decoys.

   Labels:
   - The rectified images are Street View pixels (© Google) on measured planes, labelled `photo-inferred`.
   - Nothing is generated, and nothing is read by any later step.

The step never reads a capture date. The survey's choice of panoramas does weight recency
(`face-survey.ts` `surveyCandidates`, the `recency` factor). That is existing upstream behaviour: it is flagged to MAIN
here and not changed in this step.

## The pier-line measure (P1, P2)

For each wall and view that passes the gate:

1. **The tile:** tile_refine's ortho as written. The ESB's is about 0.077 m per pixel.
2. **The view:** the rectified photo moved by the gate's shift. Pixels outside its qualifying mask are set to the
   uncovered grey, so they are not traced.
3. **Trace:** `ortho-rectify.ts` `traceLines` with `ORTHO_RECTIFY_PARAMS`, vertical lines only (piers and jambs).
4. **Match:** each view line to the tile line whose start is nearest, within 0.5 m. Per matched pair, the offset is the
   median |view − tile| over the samples where both lines carry an edge; a pair needs at least 4 such samples (1 m).
5. **The place's figure:**
   - the median of the matched lines' offsets, in ortho pixels;
   - the number of matched lines, and the share of view lines matched.

The overlays for `screenshot-review` show, per passing wall and view, the tile ortho and the rectified photo side by side,
then blended, with the tile's lines in red and the view's in green.

## Places and views

| Place | Request | Role |
|---|---|---|
| Empire State Building | `Empire State Building, New York` | Benchmark |
| Haughwout Building | `Haughwout Building, 488 Broadway, New York` | Baseline; distinct ground floor |
| Bradbury Building | `Bradbury Building, 304 South Broadway, Los Angeles` | No-photo control: pipeline E's gate passed 0 of its 14 walls (`docs/processes/streetview_value.md`) |

- **The views** are whatever K's survey fetches at each place: up to 16 at the ESB (its banded faces), up to 4 elsewhere.
  None is added, swapped or dropped by hand.
- **Expected numbers:**
  - The last ESB build (44a2509b) surveyed 16 panos.
  - The last Haughwout build (f568c14b) surveyed 1. If that holds, the Haughwout may not reach P2's floor of matched
    lines, and then it cannot answer (see the stop rules). It does not fail.

## Bars

Fixed before the first build:

| Bar | Place | Measure | Met when | A miss means |
|---|---|---|---|---|
| **P1** | ESB | Median pier-line offset over passing walls and views (above) | ≤ 2.0 ortho px, over ≥ 5 matched lines, and the overlays read as aligned under `screenshot-review` | The rectified views are not accurate enough for step 2 at the ESB |
| **P2** | Haughwout | The same | The same | The same, at the Haughwout |
| **C1** | Bradbury | Walls and views passing the gate | 0 | The gate lets photos through that do not resolve or agree with the wall |
| **C2** | Bradbury | Build B (step on) against build A (step off), byte for byte (protocol below) | Identical | The switch leaks into the build |
| **D1** | ESB, Haughwout | Decoys refused by the gate | Every decoy | The gate cannot tell a pose a bay off: **stop** |

Report-only:
- per wall and view, the resolution and angle;
- the registration methods and residuals, and the ownership results;
- the gate's shifts, and E's verdict without the phase check on the real views and the decoys;
- the pier offsets before the shift.

**Cannot answer:** a place with fewer than 5 matched lines on passing walls has no P reading. That is not a pass. It is
reported with its cause: no registered view, no view owned, none sharper than the tile, none agreeing, or too few lines.

### C2 protocol (Bradbury)

1. **Build A:** step off. Every stage cache is set aside first: staged_location `ownership`, `remesh`, `textures` and
   `vision-reply`, and tile_refine's stage folders.
2. **Build B:** step on, right after A. The same stage caches are set aside again, but `vision-reply` is kept from A. The
   model's answers are then A's, so every stage still computes uncached, while the vision models' own run-to-run
   variation cannot make the bytes differ.
3. **Compared byte for byte:** the published clay and textured GLBs, and every run note except the step's own. A field
   that only names the run or its time (run id, timestamps, durations) is listed and does not count. Any other
   difference misses C2.

## Decoys

- **Which:** for every wall and view that passes at the ESB and the Haughwout, two decoys. The view's eye is moved one bay
  along the wall, each way.
  - The bay is the wall's horizontal repeat in the tile ortho (`ortho-rectify.ts` `axisPeriod`, 1.2-10 m).
  - A wall with no measured repeat gets no decoy.
- **How each is gated:**
  - It is rectified again, with the depth rendered from the moved camera, and run through the same gate.
  - It keeps the real view's ownership mask: a pose that converged a bay off would have cut out the same building.
  - Its ownership IoU against the moved projection is recorded, but the agreement gate is judged on its own.
- **Where:** made in the build, in memory, since the photos are never written to disk. Recorded in `decoys`. Nothing
  feeds on them.
- **D1:** every decoy is refused by the gate as shipped. E's verdict without the phase check is reported beside it.
  - If any decoy passes: stop, report, and no step 2. The gate is then fixed under a new preregistration.
  - If no view passes at either place, there is no decoy and D1 cannot be answered.

## The free dry run

Vitest, credentials unreachable, before any build:

- **Synthetic setup:**
  - a facade plane with a repeating pattern, its ortho drawn from the plane;
  - a pinhole camera that sees it obliquely, and the photo rendered from that camera.
- **The test must show:**
  - the rectification puts the photo back on the ortho, with pier-line offsets under 0.5 px;
  - the masks cut where a box in front hides the wall, and where the photo ends;
  - the resolution matches fx/z·cos;
  - the gate passes the true pose and refuses a nominal pose;
  - the gate refuses the pose moved one bay. This is the decoy, and E's rules alone are recorded on it too;
  - the orchestrator wiring writes nothing when the switch is off.

## Stop rules

- **Spend:** stop past $15.
- **Disk:** no build starts under 10 GB free on the worktree's disk. Cold folders go to `/Volumes/Scratchbox`, never live
  builds on the G-RAID.
- **A decoy passes:** stop (D1).
- **A build or the step fails** with an error: report it. If the cause is a bug in this step, fix it and rebuild that
  place only, recorded here as a fix, not as a re-run for a bar. A failure outside the step (tiles, the survey refused)
  is reported and that place cannot answer.
- **No re-run for a missed bar.** No change to bars, parameters, places or protocol once the first build has started.
- **The phase check:** if MAIN vetoes it before the first build, the gate is E's alone, and this section is amended
  before anything runs.

## Exposure

**Fed panos:**
- Every pano the survey fetches at each place is recorded in `streetview_walls.json`, and listed here after the run.
- **Step 2 must hold them out of its held-out set:** its bar scores held-out Street View views with
  `photo_match_evaluate`. PR #23's street probes also come from Street View. A pano fed into the stack must never also be
  held out. Step 2's preregistration lists both sets, disjoint by pano id.

**Panos earlier comparisons judged** (preregistration 4, pinned views):

| Place | Panos |
|---|---|
| ESB | YcgPbg5tsJhWn9FJxrZi2A, iL6aK4K9ZTgfp6Spsw60kQ, 02zHXunYnbfDOD4QxOcVLg, mMKyx5tm9vT92XRehLNIuw, GsL270ixlXyEZKmd7U5hVA, 58DEtdMqDw_0Lz5neqo8lQ |
| Haughwout | 4rnMoRUGsqxjrRzIqcgbsA, n_1JJ5Vm2WOo3H3_EG9jMQ, hN4AIglXrbiGOr18KmYp2g, dXtEY_Zc3Yr8whF63vnqgQ, iqiqiEgpt6QIk-0PFGUz-g, nygqgDGFyoiVESpdb1BvmA |

The last ESB survey's 16 panos (44a2509b) and the last Haughwout survey's 1 (f568c14b, AwPEmOr5ZopPQ0vH73A_Kw) are
disjoint from these. The fresh runs' lists are checked against them again.

## Cost, estimated before any of it

| Item | Estimate |
|---|---|
| ESB K build: vision calls (measured 2026-11-02: $0.93 for the ESB and Haughwout together) and 16 photos at $0.007 | $0.65 |
| Haughwout K build | $0.45 |
| Bradbury A (step off) | $0.45 |
| Bradbury B (step on; vision replayed from A, new photos) | $0.10 |
| The step's ownership calls: the description and occluder cut-outs, about 2-3 flash calls per registered view, up to 24 views | $0.40 |
| **In all** | **about $2**, against the $15 stop |

No new Street View request is made by the step. The registration and the rectification are CPU only. This is under the
user's $100, so no approval is needed; the actual spend is reported after.

## Found while preparing, not changed here

- **Pipeline E projects its "registered" survey views at their nominal poses.**
  - `streetview-registered-views.ts` `registeredSurveyViews` builds each view with `projectionViewFromRegistered`
    without the registration's correction. `texture-pass.ts` `projectionViewsFromEvidence` attaches it.
  - The joint warp is still attached, so it is applied to the wrong pose.
  - This affects pipeline E (not a default) and its users of `streetSurveyFor`. Flagged to MAIN; this step attaches the
    correction itself.
- **The survey weights panoramas by capture date** (`surveyCandidates`, `recency`). The user decided on 2026-10-29 that
  date is not a criterion. Flagged to MAIN.

## Amendments before the first build

Made after the free dry run, before any build. No bar, place or protocol changed.
- **The phase check scans every pixel** beyond 1 m, not 0.25 m steps. On the synthetic wall the steps straddled the true
  alignment: the fine grain decorrelates a shift 1 px off, so the best stepped shift landed a whole repeat past it.
- **Images only for the walls and views the gate judges**, to keep the ESB's output bounded (about 92 facades x 16
  views).
- **A matched pier-line pair needs 4 shared edge samples** (1 m), so one sample cannot make a line.

## Fixes after the first ESB build (run 85817f1e), before any reading

The first ESB build is void. No bar was read from it, and nothing about the bars changed.
- **The step's time.**
  - It ran inside the remesh stage. With the step on, that stage gets 1,200 s more (`STREETVIEW_WALLS_ALLOWANCE_MS`).
  - In 85817f1e the window fit took 350 s. My typecheck and a test run were competing for the CPU during that build. Nothing
    else runs during the builds from now on.
  - The step was still registering 364 s in when the stage's 900 s ran out. The remesh fell to the raw scan.
  - This is the stop rule's case ("a bug in this step: fix it and rebuild that place only").
- **The first isolate only.** The step runs in the remesh stage's pass only. It does not run again when the ownership vote
  re-runs K's facade work on the voted remesh, since that stage has its own 300 s limit.
- **Really uncached.**
  - Since 2026-10-30 (`0ecb8890`), a stage entry the workspace lacks is restored from the training bucket's cache mirror
    before the stage runs. In 85817f1e tile_refine came back in 9 s with every local cache set aside.
  - The server now starts with `SCRATCHBOX_CACHE_RESTORE=off`, for every build here, A and B included.
- **Where the photos go.** The mirror also sends everything under `tile_refine/` to the bucket, so the Street View images
  are not written beside the orthos.
  - The images go to `.scratchbox/cache/streetview_walls/<runId>/`, outside the mirrored roots, in this workspace only.
  - Beside the orthos there is only `streetview_walls.json` (numbers, pano ids and poses, no pixels).
  - Both copies of the JSON, and the run note, are the same file.

## The free dry run (done, 2026-11-03)

`packages/core/test/pipeline-k-streetview-walls.test.ts`, credentials unreachable: 4 of 4 passed.

| Check | Result |
|---|---|
| The rectified photo lands back on the ortho | Median colour difference under 4 levels; pier lines under 0.5 px over at least 5 matched lines |
| The masks | Points behind the panel: covered, not visible, not owned |
| Resolution | fx / z x cos at a clear point, to 3 decimals |
| The true pose | Passes, at a shift within 1 px |
| A nominal pose | Refused |
| **The decoys** (the eye 2 m, one repeat, each way) | **Refused by the phase check.** E's rules alone pass both (NCC 0.93 and 0.94 at zero shift). The farther search finds the true alignment 2 m away (0.99 and 1.00) |
| The record | Images written for the judged pair; 1 passed, 1 refused as nominal; 2 decoys, none passing |
| The switch | Off unless `SCRATCHBOX_K_STREETVIEW_WALLS=1` |

## Result

Not run yet.
