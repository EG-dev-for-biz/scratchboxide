# Preregistration 4: pipeline K, fixed, against the raw scan at the ESB, the Haughwout and the Ferry

Date: 2026-11-02. Status: **done 2026-11-02: the ESB judged validly, K below (in clay above); the Haughwout K below and the Ferry K level, both indicative.** Written before any of its builds, probes or paid calls; nothing below changes after this line
except the run record and the report. A bar, arm, place or view changed after a paid call is a new preregistration that names
this one.

## The earlier runs, and why this one is made

- **[Preregistration 1](./2026-11-02-k-step-ablation-prereg.md)** asked, at the ESB, which K step scores worse than the raw
  scan. It was indicative, with 2 views registered.
  - It put 1.17 of K's 1.83 overall gap in the twin's de-light.
  - That de-light is since fixed (it keeps the photo's chroma).
- **[Preregistration 2](./2026-11-02-k-step-ablation-2-prereg.md)** judged the fixed de-light at the Haughwout and the Ferry.
  - Both were indicative (`matchedShare` under 0.99), and the ESB was not judged.
  - The de-light no longer cost anything.
  - The Ferry stayed 1.20 below raw overall, on geometry.
- **[Preregistration 3](./2026-11-02-k-ferry-stage-cuts-prereg.md)** cut K at the Ferry stage by stage. It was indicative.
  - The cleanup and the footprint clip each lost 2.27 on clay shape.
  - The clip also lost 2.38 px of placement.
- **[The tower fix](./2026-11-02-ferry-tower-vector-tile-copies.md)** traced the clip's tear to the vector evidence: one
  building that two feature tiles carry was kept as two. With that fixed, the Ferry is built whole and the clip removes none
  of its tower.
- **This run** judges K with every fix, against the raw scan, at all three benchmark places. The ESB can be judged again on
  main's #21 views.
  - **Requested by** the parent session, under the user's "Do what you think is best".
  - **Left out:** the sky-visibility de-light (MAIN's uncommitted work, which widens the seams) and the Haughwout's magenta
    white balance. Each is a later arm.

## Question

At each place, does the fixed K score level with the raw scan or above it?
- **Level or above:** K's straightening costs nothing the judge sees there.
- **Below:** the report says on what (shape, clay shape, placement, materials). That is where to look next.

## Arms

Per place, built fresh and uncached on `fix/k-twin-delight` with main merged. Main's merge changes only the judge
(`photo-match-evaluate.ts`) and its skill, not the build. Every switch is at its default.

| Id | Label (reports only) | What |
|---|---|---|
| raw | RAW SCAN (CUT TO TARGET) | `baseline: true` |
| K | PIPELINE K | `google_3d_tiles_get_clay` `{query, isolate: true, trees: true, pipeline: 'k'}`, its twin by `runId` |
| X2 | DECOY MOVED 4 M | K's twin moved [4, 0, 0] (`make_decoys.py`) |
| X3 | DECOY FLAT COLOUR | K's twin in one flat colour (`make_decoys.py`) |

The places' queries are the earlier runs':
- ESB: "Empire State Building, New York";
- Haughwout: "Haughwout Building, 488 Broadway, New York";
- Ferry: "Ferry Building, San Francisco".

The Ferry's fresh K is run 526b7580, built for the tower fix on the same code. It was built before this was written, and
nothing about it was read against the judge.

## Places and views

The procedure is the judge-preregister skill as main has it (#15).
1. **Probe.** One probe call per place, with every arm: `views: 6`, `runs: 1`, `clay: false`, `judgeRegions: false`. Views
   are found for real.
2. **Era check.** Run it on exactly the probe's `heldOut.judgedPoses`. A view is kept when its photo shows the building as
   the scan does: the same massing, and no scaffold or demolition the scan lacks.
3. **Pin.** The kept views become this place's `poses`, with `autoViews: false`. A place needs at least 3. Fewer, and it is
   not judged.
4. **Record.** The poses go into the run record before the dry run.

## Bars

Unchanged from preregistrations 2 and 3:

| # | What it checks | Bar |
|---|---|---|
| V1 | judge spread, mean over all arms | at most 0.75 |
| V2 | X2 against K, placement | X2 at least D above K (D = half X2 − K in this place's dry run, at least 2 px), over at least 2 views with a placement |
| V3 | X3 against K, materials and overall | each at least 1.0 below K |
| V4 | raw frame agreement; `matchedShare` | 1.00; at least 0.99 (a miss makes the place indicative, as before) |

- **The reading, per place:** **K level** when K is at least raw − (the larger of K's and raw's spread) on overall, at three
  quarters of the judged views and at least 3, with V1 to V3 met.
  - **Otherwise K is below.** Its shortfall on shape, clay shape, placement and materials is reported, read the same way.
- **Secondary, deciding nothing:** detail, the region scores, and the earlier runs' numbers set beside these.

## Decoys

- **X2** (moved 4 m) must lose on placement by D (V2).
- **X3** (one flat colour) must lose by 1.0 on materials and on overall (V3).

Both are made locally from each place's K twin, at no cost.

## Stop rules

- **Spend:** stop past **$35** and on any 403 or spend cap.
- **Builds:** a build that fails or degrades on a time limit is finished with the app's retry (`retryRunId` /
  `retryStage`), once. Otherwise the place is not judged.
- **Dry run:** an empty or black render, an arm with 0 triangles, or `frame_mismatch` stops that place.
- **V1 to V3 missed:** nothing is read at that place. **V4 missed:** indicative.
- **One paid call per place, no re-run.**

## Exposure

The panos each build used are excluded by the tool. The Haughwout and Ferry views judged in run 2 may come back from the
probes. They are not excluded, by the M1 rule kept in every earlier run.

## The free dry run, per place

The pinned poses, all four arms, `fakeJudge`, under vitest with credentials unreachable. It must show:
- every arm rendered at every pose;
- no build's pano held out;
- the call count as estimated;
- D set from X2 − K.

## Cost, estimated before any of it

| Item | Basis | Low | High |
|---|---|---|---|
| Builds | ESB and Haughwout K fresh (the Ferry's done): about $0.85 a build in vision calls, measured today | $1.70 | $3.00 |
| Probes | 3 x (6 views x 1 run, 4 arms in one image, about $0.05 a call, plus 12 photos at $0.007) | $1.15 | $2.50 |
| Paid calls | 3 places x up to 6 views x 3 runs x 2 (clay), about $0.05 a call measured in run 3, up to 2x with thinking | $5.40 | $10.80 |
| **In all** | | **about $8** | **about $16**, against the $35 stop |

Under the user's $100, so no approval is needed. The actual spend is reported after.

## Order

1. Commit this; sync main into `fix/k-twin-delight`.
2. Build the ESB and Haughwout K fresh.
3. Probe each place, era-check, and pin the poses in the run record.
4. Make the decoys; dry-run each place and set D.
5. Make the paid calls, one per place.
6. Report against the bars, with a labelled proof sheet.

## Amendment 1 (the ESB's views), before any ESB score

Written after the Ferry's paid call and before the ESB's. No ESB view had been judged. No bar, arm or place changes.
- **Why:** the ESB's probe found a single candidate pano (`uPcMge9M`) in its live search, and registration needs two, so it
  judged nothing (`no_heldout_registered`, 2.5 s).
  - **The dry run's search from the cache** (free) finds MAIN's six #21 views: YcgPbg5t, iL6aK4K9, 02zHXunY, mMKyx5tm,
    GsL270ix and 58DEtdMq. MAIN found 6 of its 7 candidates registering when fetched for real.
  - **The indoor rule does not cause the difference.** On the merged and on the unmerged footprints, it refuses none of the
    seven.
  - **The skill already names this:** a paid call that searches again finds other panos.
- **The ESB's views are therefore the dry run's `heldOut.judgedPoses`.** That is the skill's own method (main, #15) and
  MAIN's advice.
- **They are fetched for real** by a probe pinned to them (`autoViews: false`, one run, no clay, no regions), era-checked on
  that probe's grids, and pinned for the paid call as above. Fewer than 3 kept, and the ESB is not judged.

## Run record

- **The code:** `fix/k-twin-delight` at 043c0c95 (main merged at e40022f6; the tower fix 69773f1f), pushed to PR #17.
  - The checks were clean: core typecheck and 54 tests across the judge and vector suites.
  - The app (`scratchbox-k-step-ablation`, ports 3740-3742) was restarted on the merged code.
- **The K builds:**

  | Place | Run | Twin | How fresh |
  |---|---|---|---|
  | Ferry | 526b7580 | `ferry_building_san_francisco_iso_l2_tex_9e66aad9.glb` | every K stage computed (survey, remesh, ownership, textures uncached) |
  | ESB | 44a2509b | `empire_state_building_new_york_iso_l2_tex_8fcc910b.glb` | after the stage caches were set aside: remesh 223 s and textures 277 s, uncached; complete |
  | Haughwout | f568c14b | `haughwout_building_488_broadway_new_york_iso_l2_tex_dbf3ad5a.glb` | the same; remesh 19 s; three survey faces not surveyed, `visible_defects` |

  - **A first ESB and Haughwout pair was discarded unjudged** (2d5ae29c and 5224be3b). They came back in 85 s and 14 s from
    the stage cache, so they were not uncached builds.
  - **Before the rebuild:** every remesh, textures and ownership entry except the Ferry's remesh, the two places' tile_refine
    entries and the vision-reply cache were moved (1.8 GB) to `.scratchbox/cache/_stale_2026-11-02_prereg4/`. The launch
    entry gained `SCRATCHBOX_CACHE_RESTORE=off`, and the server was restarted.
  - **The picks are unchanged:** both rebuilt places got their earlier tile_refine keys (7e04d520, 67b7f61b).
- **Probes, era check and views:**
  - **Ferry:** probe `1_ferry_..._224922_fd5c`, 6 views. **Every view kept:**
    - s6niaUIA (2026-09), l3F3P-6Q (2025-05), 3TPQcd2t (2025-01) and M931OjLK (2026-09) show the tower and the arcade as the
      tile holds them;
    - GgSwAfFz (2025-05) is a close view of the bay-side annex, and the tile ends inside it, so its regions are not judged;
    - PwVpHerQ (2014-11) is from the water; the building's massing is the tile's.
  - **Haughwout:** probe `e_v_haughwout_..._230819_e9b7`, 6 views. These are run 2's six panos, all 2026-04, with the
    cast-iron facades and the corner clock as the tile holds them (only the storefront signs differ). **Every view kept.**
  - **ESB (amendment 1):**
    - the live probe found one candidate and judged nothing;
    - the dry run's six (MAIN's #21 views) were fetched by a pinned probe, `empire_state_..._231833_96af`, and all 6
      registered (edge residual 0.83 to 2.86 px);
    - YcgPbg5t and 02zHXunY show the podium's street walls, and mMKyx5tm, GsL270ix and 58DEtdMq the tower over it;
    - iL6aK4K9 (2024-09) shows a street-level sidewalk shed in the scan that the photo does not; the massing matches.
    - **Every view kept.**
- **Dry runs** (free, `photo-match-dryrun.test.ts`, credentials unreachable): every arm rendered at all 6 poses at each
  place.
  - D = 4.99 px at the ESB, 7.25 at the Haughwout and 3.48 at the Ferry.
- **Paid calls:** one per place on the pinned poses. Every pose was judged.
  - ESB: `empire_state_building_20_w_34th__20261102T232607_684c`.
  - Haughwout: `e_v_haughwout_building_488_broad_20261102T232103_2261`.
  - Ferry: `1_ferry_building_san_francisco_c_20261102T225745_fcc1`.
- **Records:** the reports, bars, readings and proof sheet are in `docs/screenshots/k_step_ablation_2026-11-02/run4_paid/`
  (gitignored), read by `bars.py` and `read4.py` (this session's scratchpad, `ablation/run4/`).

## Report

| | ESB | Haughwout | Ferry |
|---|---|---|---|
| V1 spread (≤ 0.75) | 0.30 met | 0.39 met | 0.47 met |
| V2 X2 − K placement (≥ D) | 9.09 ≥ 4.99 met | 9.87 ≥ 7.25 met | 6.42 ≥ 3.48 met |
| V3 K − X3 materials / overall (≥ 1.0) | 3.73 / 2.77 met | 2.50 / 1.94 met | 3.62 / 2.84 met |
| V4 `matchedShare` (≥ 0.99) | **0.996 met** | 0.875 missed | 0.953 missed |
| Overall, K / raw (views level) | 4.55 / 6.00 (0/6) | 3.11 / 3.33 (4/6) | 5.34 / 5.50 (5/6) |
| Shape | 5.39 / 7.33 | 4.00 / 3.89 | 6.61 / 6.78 |
| Clay shape | **5.61 / 4.28** | 3.83 / 4.11 | 4.89 / 5.33 |
| Materials | 5.06 / 5.78 | 3.56 / 3.61 | 5.06 / 5.22 |
| Placement px, K / raw | 3.78 / 3.67 | **7.34 / 4.74**, worse at 6/6 | 3.13 / 3.14 |
| **Reading** | **K below** (valid) | K below (indicative) | **K level** (indicative) |

- **The ESB is judged for the first time, and validly.** V1 to V4 are all met.
  - **K is below the raw scan:** 1.45 on overall and 1.94 on shape, at every view.
  - **In clay K beats the scan by 1.33.** The geometry is better; the loss is in how it reads textured.
  - **Materials** lose 0.72.
  - **The worst view is YcgPbg5t:** K 2.33 against the scan's 5.00, from a flat, untextured, light slab at the base, which
    K generates there.
  - On the tower views, K stays within about a point of the scan.
- **The Haughwout: K below, indicatively.**
  - On the mean it is within the tolerance (−0.22 against 0.59), but it is level at only 4 of 6 views.
  - Its placement is 2.6 px worse at every view; materials are level.
- **The Ferry: K level, indicatively.**
  - Overall is within 0.16 of the scan, at 5 of 6 views; placement is level.
  - In the second run, before the tower fix, K was 1.20 below overall and 3.45 px worse on placement.
- **What this points at, deciding nothing yet:**
  1. The ESB's base: the generated light slab, and the rebuilt podium facade that reads warped (view 02zHXunY).
  2. The Haughwout's placement.
  3. The tile photos' blue-purple cast, which every arm shares (the colour-cast note), and the Haughwout's magenta white
     balance. Both wait, as the parent session said, with the sky-visibility de-light, for arms of their own.
- **Cost:** about $5.50, under the $8-16 estimate and the $35 stop.
  - Builds' vision calls $1.25: the Ferry $0.32, the ESB and Haughwout $0.93.
  - The judge about $3.80: 132 calls of about 6k tokens in and 1.4k out, at the estimate's rates.
  - Street View photos about $0.35.

Proof sheet: `run4_paid/proof_sheet_run4.png`.
