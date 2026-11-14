# Preregistration: the hybrid twin against pipeline K at the Empire State Building

Date: 2026-11-08. Status: **written before any paid call.** Nothing below changes after this line except the run record
and the report. Branch `feat/measured-procedural-twin` (PR #189), code at c56b7650 + 522cd13f.

## Question

Does the hybrid twin (the procedural twin built with pipeline K's detail stages,
[the plan](../research/2026-11-08-hybrid-twin-plan.md)) look at least as much like the real Empire State Building as
pipeline K's own build, judged blind against held-out Street View photos?

- **Met (bars 1-3):** the hybrid is a candidate for K's role on single buildings; MAIN decides integration (class 1/2/3)
  and the next step is the other cached benchmark buildings and the Penn district.
- **Missed:** the hybrid is not at K's level on this measure; the report names where (shape, materials, detail) and that is
  the next work, not a default change.
- **A decoy passes or the spread swallows the gap:** the judge cannot answer; nothing is concluded.

## Arms

All in the frame of staged run 493d1ee7 (anchor 40.748545, -73.985763, ellipsoidal height -18.657 m), drawn as the target
in its street (`scope: target`, the photo-textured tile with the target cut out).

| id | Label to the judge | Build |
|---|---|---|
| raw | (baseline) | the raw scan cut to the target (`baseline: true`) |
| K | build | pipeline K's twin of run 493d1ee7 (`textures/4518d1e9.../twin.glb`), built uncached in the 2026-11-07 window-array benchmark (main b2a41010, its own readings): today's 3D Building default |
| H | build | the hybrid twin (`hybrid: true`), built cold on 2026-11-08 (empty readings store for its first build; the arm's GLB is the rebuild from those answers with the mast photo patches, out53) |
| I | build | the K-free inferred twin with photometry (`infer: true`, out48) |

Labels shown to the judge are neutral; no arm, pipeline or file is named.

## Places and views

- **Place:** the Empire State Building only (the twin's benchmark). Other places come after, by a new preregistration.
- **Views:** up to 6, held out: chosen by the tool from the cached Street View metadata in the free dry run, then pinned
  for the paid call (`autoViews: false`, the dry run's `heldOut.judgedPoses`), as preregistration 4 of the K ablation did.
- **Never held out:** the 9 panos of the registered Street View plates arm I used for its base band (`excludePanoIds`).
  Arms K and H used no Street View.

## Bars

Means over the judged views, each view's score the mean of its runs. Building criteria only (`judgeRegions` off).

| # | Metric | Bar | A miss means |
|---|---|---|---|
| 1 | Overall, H against K | H ≥ K | the hybrid is not at K's level overall |
| 2 | Shape (textured), H against K | H ≥ K − 0.5 | the twin's shell reads less like the building than K's |
| 3 | Materials, H against K | H ≥ K | the hybrid's texture reads less like the building |
| V1 | Judge spread (mean of per-view run spreads, overall) | ≤ 0.75 for every arm | the judge is too noisy to separate arms |
| V2 | Placement, decoy X2 against H (`placement.mean.errorPx`) | X2 ≥ H + D, D = half X2 − H in the dry run, at least 2 px | placement cannot rank a 4 m move |
| V3 | Materials, H against decoy X3 | H ≥ X3 + 1.0 | the judge cannot see texture |

Reported, deciding nothing: detail, errors, clay shape, SSIM, edge chamfer, CIEDE2000; arm I and the raw scan.

## Decoys

| id | How | Must lose by |
|---|---|---|
| X2 | H with every vertex moved 4 m east (positions baked, not a node transform) | V2 |
| X3 | H with every texture replaced by the building's mean colour (flat; normal map removed) | V3 |

## Stop rules

- A decoy that passes (V2 or V3 missed): the judge cannot answer; report, conclude nothing.
- V1 missed for H or K, or the H − K gap within the larger of their spreads: "the judge cannot tell".
- Fewer than 3 judged views: indicative only.
- Spend cap $15; stop on any 403 or spend-cap error.
- A render that fails or is empty at any pinned pose: stop before the paid call and fix the render.

## Exposure

- Arm I's 9 plate panos (excluded). No other arm used Street View.
- Earlier comparisons at the ESB judged MAIN's #21 views (YcgPbg5t, iL6aK4K9, 02zHXunY, mMKyx5tm, GsL270ix, 58DEtdMq);
  they may return from the cached metadata and are not excluded (the M1 rule kept in every earlier run). mMKyx5tm is one of
  arm I's plate panos and so is excluded here.

## Cost, estimated

6 views x 3 runs x 2 (clay) = 36 judge calls with 6 renders each, about $0.05 a call: about $1.80, up to $3.60 with
thinking; 6 photos about $0.04. **About $2 to $4**, under the $15 cap and the user's $100 (no approval needed).

## Order

1. Commit this.
2. Free dry run (`photo-match-dryrun.test.ts`, stand-ins at the billed edges, credentials unreachable): every arm and decoy
   at every pose; the exclusions; the call count; D from X2 − H.
3. Pin the poses and D in the run record below; commit.
4. One paid call with every arm and decoy.
5. Report against the bars with the grid image.

## Amendment 1 (arm H rebuilt), before any paid call

Written after the free dry run and before any paid call; no score had been read. No bar, place, view rule or decoy rule
changes.
- **Why:** the dry run's view 02zHXunY showed arm H (and arm I) drawing a 72 m x 15 m stretch of the podium wall as one
  flat grey slab. A ray pick found it: a roof-detail block standing in for that wall, its faces each one palette colour,
  because the reserved photo-patch rows overflowed before the roof blocks were drawn.
- **The fix,** a8e266e6: every vertical face of a ledge or roof block of 4 m2 or more takes its own patch of the scan's
  photo (1,536 reserved rows; 504 faces patched, none overflowing; `patchOverflow` reported).
- **Arm H is now** the native pass of that code on out54's spec (same K stages and model answers), `out55`; the decoys X2
  and X3 are remade from it. Arm I is unchanged (reported only; it keeps the slab).

## Run record

- **Code:** `feat/measured-procedural-twin` at a8e266e6 (prereg 34403006).
- **Arms' GLBs** (copied into `.scratchbox/judge_arms/`, gitignored): `k.glb` (K's twin.glb of run 493d1ee7),
  `hybrid_c.glb` (out55), `infer.glb` (out48), `x2_c.glb` (hybrid_c moved 4 m east, positions baked), `x3_c.glb`
  (hybrid_c, every texture replaced by its mean colour, normal map removed); reference tile
  `textured_tile_seams_9.glb` and isolate `raw_clay.glb` of the same run.
- **Free dry run** (`photo-match-dryrun.test.ts`, stand-ins at the billed edges, credentials unreachable): passed. Six
  views, every arm and decoy rendered at every pose, 9 plate panos excluded, 36 stand-in judge calls (18 textured,
  18 clay), as estimated.
- **Pinned poses** (the dry run's `heldOut.judgedPoses`; `autoViews: false` in the paid call):

  | View | Pano | Heading | Pitch | FOV |
  |---|---|---|---|---|
  | v0 | lui1N8rPhV-Uk5on9D2LPQ | 199.3 | 12 | 80 |
  | v1 | iL6aK4K9ZTgfp6Spsw60kQ | 217.8 | 12 | 80 |
  | v2 | 02zHXunYnbfDOD4QxOcVLg | 337.6 | 12 | 80 |
  | v3 | w4nU8TkIWNQjsnulYysjNw | 269 | 12 | 80 |
  | v4 | -qdlw7_XTh6cxO2UYl5WiQ | 102.8 | 12 | 80 |
  | v5 | 6BQ_gXrXCRuOhRoZYeRUpA | 264.6 | 30 | 72 |

- **D for bar V2:** X2 13.71 px, H 5.52 px in the dry run's placement: D = half the gap = **4.10 px**.
- **Era:** the six panos are those the tool's held-out search picks at this place; earlier preregistrations checked
  iL6aK4K9 and 02zHXunY (2024-2026 captures, the tile's massing). The paid call's grids are checked for era before any
  score is read; a view from another era is dropped and said so.

- **Paid call:** `empire_state_building_350_5th_av_20261109T042449_07b9`, the pinned poses, every arm and decoy, run
  through photo_match_evaluate's own code (a ts-node driver in this session's scratchpad, the app's environment; the
  tool unchanged). Three earlier attempts stopped before any photo was fetched or anything judged: a module path the
  driver could not resolve, the Maps key not in the driver's environment, and the driver compiled to a JavaScript target
  that empties a Map's spread (so no pose reached the tool). None produced a score; this is the first and only judged run.
- **Views:** v0 (lui1N8rP), v1 (iL6aK4K9) and v3 (w4nU8TkI) did not register (edge residual), so three views were judged:
  v2 02zHXunY, v4 -qdlw7_X, v5 6BQ_gXrX, all 2026-04 captures whose massing matches the tile (era kept). v2's photo shows a
  street-level scaffold shed on the podium that no arm has. Three views: judged, not indicative.
- **Records:** report and grids in `docs/screenshots/hybrid_vs_k_2026-11-08/` (gitignored).

## Report

Means over the three judged views (each the mean of 3 blind runs); spread = the run spread of the overall score.

| # | Bar | K | H | Met? |
|---|---|---|---|---|
| 1 | Overall, H ≥ K | 4.55 (±0.31) | **5.00** (±0.00) | **met** (+0.45, wider than either spread) |
| 2 | Shape, H ≥ K − 0.5 | 6.00 | **6.33** | **met** |
| 3 | Materials, H ≥ K | 4.00 | **4.89** | **met** |
| V1 | Spread ≤ 0.75, every arm | 0.31 | 0.00 | **met** (largest of any arm 0.31) |
| V2 | Placement X2 ≥ H + 4.10 px | | H 3.71, X2 9.78 | **met** (+6.07) |
| V3 | Materials H ≥ X3 + 1.0 | | H 4.89, X3 3.00 | **met** (+1.89) |

Every arm, all criteria (judge means):

| Arm | Overall | Shape | Materials | Detail | Errors | Realism | Identity | Clay shape | Placement px |
|---|---|---|---|---|---|---|---|---|---|
| raw scan | **6.67** | 6.89 | 6.22 | 5.89 | 6.00 | 5.56 | 7.00 | 3.11 | 2.98 |
| K | 4.55 | 6.00 | 4.00 | 4.33 | 4.56 | 3.89 | 5.22 | **6.11** | 3.70 |
| H (hybrid) | **5.00** | 6.33 | 4.89 | 4.33 | 5.00 | 4.22 | 5.66 | 5.89 | 3.71 |
| I (inferred, K-free) | 4.45 | 6.00 | 4.45 | 4.11 | 4.56 | 3.78 | 5.22 | 4.00 | 3.72 |
| X2 (H moved 4 m) | 4.89 | 5.89 | 4.89 | 4.33 | 4.67 | 4.22 | 5.66 | 5.44 | 9.78 |
| X3 (H flat colour) | 3.11 | 6.33 | 3.00 | 3.22 | 5.67 | 3.00 | 4.22 | 5.89 | 3.71 |

**Decision:** all three bars and both decoy bars are met: on this measure, at the ESB, the hybrid twin is at least at
K's level (overall +0.45, materials +0.89, shape +0.33, identity +0.44, realism +0.33), at a fraction of K's model calls
and size. The hybrid is a candidate for K's role on single buildings, for MAIN to class; next, the other cached
benchmark buildings and the Penn district under a new preregistration.

**What it does not say:**
- Both builds score below the raw scan (6.67 overall), as K did in every earlier ESB comparison.
- In clay (shape alone) K's shell edges the hybrid's (6.11 against 5.89, within the run spreads).
- The judge does not see a 4 m move (X2 overall 4.89 against H 5.00); the placement measure does (bar V2), as designed.
- Three of six views registered; one place. Detail is level (4.33 each).
