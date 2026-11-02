# Preregistration 2: pipeline K with its de-light and reveals fixed, against the raw scan at the benchmark places

Date: 2026-11-02. Status: **written before any build or paid call of this run.** Nothing below changes after this line
except the run record and the report. A bar, arm, place or view changed after a paid call is a new preregistration that
names this one.

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

(none yet)

## Report

(after the paid calls)
