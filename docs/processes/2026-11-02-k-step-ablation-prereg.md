# Preregistration: which step of pipeline K makes it score worse than the raw scan

Date: 2026-11-02. Status: **written before any paid call.** Nothing below changes after this line except the run record
and the report. A bar, arm, place or view changed after a paid call is a new preregistration that names this one.

Branch `feat/k-step-ablation`, cut from `84b54d44` (the tip of `feat/m1-judge-kd`, PR #5). The judge's code
(`photo-match-evaluate.ts`, `photo-match-eval.ts`) is used as it stands there and is not edited here.

## Question

At the Empire State Building, M1's judge scored the raw scan above pipeline K, the default 3D Building pipeline, on the
building ([the rerun](./2026-11-01-m1-fixed-judge-rerun-prereg.md), ESB eval `..._20261101T070440_fd3a`):

| Metric (building mask) | Raw | K |
|---|---|---|
| Overall (judge, 1-10) | 6.75 | 4.75 |
| Shape (judge) | 7.34 | 5.67 |
| Materials (judge, information) | 6.50 | 4.25 |
| Clay shape (judge, untextured) | 4.00 | 5.33 |
| Placement (mean px from the photo's silhouette, amendment 3's measure) | 3.62 | 4.06 |

K starts from that scan. **Which of K's steps makes it score worse?** Each step with an off switch is turned off alone,
and each such build is judged beside raw and K in one blind call.

- **A step is named** when turning it off brings K level with or above raw on the overall score (bars below). The named
  step is then the first thing M2 and M3 fix or turn off; nothing is changed by this run itself.
- **No step named, but a stage cut is:** the loss lies in a step with no off switch, inside that stage. The next step is
  a switch or a fix for that stage, as a separate task.
- **Nothing named and nothing moves:** the loss is spread over several steps, or the judge cannot tell them apart with
  these views. The report says which.

## The steps of K, checked in the code

`stepOn(key, default)` (`orchestrator.ts` 1480) reads the build's `steps` argument for the keys in `TOGGLEABLE_STEPS`
(`common/staged-build-steps.ts`), else the default. Some switches are environment variables only.

### Steps on by default that change the model: one arm each

| Arm | Step | How it is turned off | Where it is read | Stage cache key holds it |
|---|---|---|---|---|
| noSeams | tile seam weld (overlap trim, vertex weld, T-junction split, 3 cm) | `SCRATCHBOX_TILE_SEAMS=0` (environment only) | `orchestrator.ts` 2003 | every stage reads the raw extraction instead: new tile_refine key |
| noOccl | occlusion masks beside the facade orthos | `steps: {'remesh.occlusion': false}` (also `SCRATCHBOX_K_OCCLUSION=0`) | 3885 | tile_refine `keyParams.reliefOcclusion` |
| noInpaint | image-model inpaint of small facade holes | `SCRATCHBOX_K_HOLE_INPAINT=0` (environment only) | 3942 | rectify key `inpaint` (`pipeline-k.ts` 233) |
| noFit | window fit (and with it the wall grammar and wall sheets, which read the fit) | `steps: {'remesh.windowFit': false}` | 3949 | polish key hashes `windowFit`, `wallGrammar`, `walls` |
| noWalls | whole-wall sheets | `SCRATCHBOX_K_WHOLE_WALLS=0` (environment only: `remesh.wallSheets` is not in `TOGGLEABLE_STEPS`) | 3980 | polish key hashes `walls` |
| noRead | the facade reader on the finished exterior (its glass gives way to the window fit's) | `steps: {'remesh.facadeRead': false}` (also `SCRATCHBOX_K_FACADE_READ=0`) | 3071, 3960 | twin key `FACADE_READER_VERSION...` |
| noClean | polish cleanup | `steps: {'polish.cleanup': false}` | 4057 | polish key `cleanup` |
| noLattice | the lattice (facades rebuilt flat on the straightened photos) | `steps: {'polish.lattice': false}` | 4057 | polish key `lattice` |
| noBase | base cleanup and skirt (and with it the clip, which runs only with the base: `remesh-polish.ts` `input.clip && input.base`) | `steps: {'polish.base': false}` | 4057 | polish key `base` |
| noClip | clip at the footprint plus 0.3 m | `steps: {'polish.clip': false}` (also `SCRATCHBOX_K_CLIP=0`) | 4057 | polish key `clip` |
| noInfill | infill of the open loops | `steps: {'polish.infill': false}` (also `SCRATCHBOX_K_INFILL=0`) | 4057 | polish key `infill` |
| noOrient | inward-facing scan pieces turned outward | `steps: {'polish.orient': false}` | 4057 | polish key `orient` |
| noHarm | harmonising (and with it the roof-shadow lift, which a K twin runs only with harmonising) | `steps: {'twin.harmonize': false}` | 3037, 3059 | twin key `TEXTURE_HARMONIZE_VERSION`, `ROOF_SHADOW_VERSION` |
| noShadow | roof-shadow lift | `steps: {'twin.roofShadow': false}` (also `SCRATCHBOX_K_ROOF_SHADOW=0`) | 3059 | twin key `ROOF_SHADOW_VERSION` |
| noMat | material regions (and with them the twin's facade reader, whose planes are handed to material regions: `kOrthos` is read only with material sets) | `steps: {'twin.materials': false}` (also `SCRATCHBOX_K_MATERIAL_REGIONS=0`) | 3046, 3064 | twin key `MATERIAL_REGIONS_VERSION` |

The brief's list held 8 of these. The code adds 7: the window fit, the lattice, the base, the cleanup, the orient,
harmonising and hole inpaint. `SCRATCHBOX_K_WHOLE_WALLS` and `SCRATCHBOX_TILE_SEAMS` have no per-build switch.

**One no-op rule, decided from K default's own record before any arm is built:** if K default's `pipeline_k` note shows
no texel inpainted (no `fromInpaint` in any facade's hole report), noInpaint is not built. Its output would equal K's, and
its row reads "not built: the step did nothing here". (M1's ESB build 0bb20154 inpainted none.) No other arm is pruned:
every polish step's snapshot in 0bb20154 differs from the one before it.

### Checked, and not arms

- **Off by default in K:** seal, reveal depth, view relight, party wall, detail bake, Street View evidence, lattice cut
  (`SCRATCHBOX_K_LATTICE_CUT`), window segmenter (`SCRATCHBOX_K_WINDOW_SEGMENT`), sky de-light (`SCRATCHBOX_K_SKY_DELIGHT`).
- **Measuring only, the model unchanged:** `remesh.streetViewScore` and `remesh.visibleDefects` write run notes and
  degradations, never the GLB.
- **K steps with no off switch:** tile_refine's remesh and wall flattening; the ortho rectify (straightening warp, smear
  levelling, holes filled from repeats); the twin's de-light; material naming. The stage cuts below cover them.

### Stage cuts: free arms from K default's own build

The polish writes the model after each step it ran (`remesh-polish.ts` `snapshots`), textured, and the app publishes them
for the node graph. In M1's ESB build, `step_polish_orient.glb` has the final twin's 975,625 triangles with the scan's
photos as tile_refine transferred them (203 images, none de-lit).

| Arm | What it is | What the gap to its neighbour isolates |
|---|---|---|
| S1 | `step_remesh_tileRefine.glb`: tile_refine's textured remesh, before K's rectify and polish | raw → S1: tile_refine |
| S2 | `step_polish_orient.glb`: K's finished geometry, before the twin | S1 → S2: rectify and polish |
| T0 | built: `steps: {'twin.harmonize': false, 'twin.materials': false}`, the twin with its switchable steps off, so the de-light alone | S2 → T0: the de-light; T0 → K: harmonise, roof shadow, material regions, facade reader |

## Arms

All are judged in one call, scope `target`, drawn in the reference's tile with the target cut out.

| Id | Label (reports only) | Built from |
|---|---|---|
| K | K DEFAULT | `google_3d_tiles_get_clay` `{ query: "Empire State Building, New York", isolate: true, trees: true, pipeline: "k", stageIntoActiveScene: false }`, as M1's run 0bb20154; named first, so it is the reference (tile, masks, views) |
| raw | RAW SCAN (CUT TO TARGET) | `baseline: true`: K's isolate cut from K's welded tile |
| S1, S2 | STAGE CUT | K's own snapshot GLBs, above |
| T0 | TWIN DE-LIGHT ONLY | as K, with the steps above off |
| noSeams ... noMat | K WITHOUT <step> | as K, with the one switch in the table above |
| X2 | DECOY MOVED 4 M | K's twin with its root node translated 4 m along +x (one node translation in the glTF JSON), as M1 |
| X3 | DECOY FLAT COLOUR | K's twin with every base-colour image replaced by one 4 x 4 image of one colour: the pixel-weighted mean of all K's base-colour images. Geometry, UVs and the other maps unchanged |

Each built arm passes `runId` (so its used panos are excluded) and `glbs`: the run's textured twin
(`..._iso_l2_tex_<key>.glb`), as M1's K arm did.

**Fresh and uncached.** This worktree has never written a `.scratchbox` cache, and the server starts with
`SCRATCHBOX_CACHE_RESTORE=off`, so no stage comes back from the Cloud Storage bucket: K default computes every stage. The
other arms then run on the same cache, one after another, on this code:
- each recomputes every stage its switch reaches (each switch is in its stage's cache key, the table above);
- each takes from the cache only stages upstream of its switch that K default computed minutes earlier: the geocode, the
  extraction and its weld, the survey, and for twin and polish arms tile_refine and the rectify;
- the vision-reply cache answers a facade-reader or material-choice call whose inputs are byte-identical to one K default
  made.

This is deliberate. Every arm shares one extraction, so the switch is the only difference. Two extractions of one place
matched only 85% to 97% in M1, which would add noise unrelated to any step. Each arm's record is checked: a stage
downstream of its switch marked cached voids the arm.

The environment-only arms (noSeams, noWalls, noInpaint) run on the same server restarted with that one variable set; the
cache is kept.

## Places and views

- **The ESB first,** with the query above (M1's).
- **Views:** `views: 4`, chosen by the tool from held-out Street View panos round K's isolate, 8 fetched and the nearest 4
  registered judged. The view rule is the code's at `84b54d44`: panos past the tile's edge and sight lines crossing empty
  tile are refused (the M1 rerun's last two changes), so the fetch list will differ from M1's ESB list.
- **Era check before the paid call** (M1's amendment 7 method): fetch the 8 photos the paid call will fetch, set each
  beside the tile at its pose, compare the structure, drop and swap any view of another era (`excludePanoIds`). The
  outcome is written in the run record and committed before the paid call.
- **The Haughwout Building and the Ferry Building only if the ESB names a step** (a clear loser). Then, at each, with
  their M1 queries: raw, K, S2, the named arm or arms, X2 and X3, the same bars, era-checked first. In M1 both had a
  `matchedShare` under 0.99, which keeps a place out of the building bars (the first preregistration's amendment 3). If
  that holds again, their numbers are reported as information.

### Tool arguments (the paid call)

```
photo_match_evaluate {
  arms: [K (first: the reference), S1, S2, T0, noSeams, noOccl, noInpaint (unless pruned), noFit, noWalls, noRead,
         noClean, noLattice, noBase, noClip, noInfill, noOrient, noHarm, noShadow, noMat, X2, X3,
         each { id, label, runId?, glbs, scope: 'target' }],
  views: 4, runs: 3, clay: true, judgeRegions: true, trees: true, baseline: true, includeSatelliteOrtho: false,
  excludePanoIds: [any the era check drops]
}
```

These are M1's arguments with more arms. The judge sees the photo and up to 22 renders per call, shuffled and unlabelled.
M1 judged 5 renders per call at the benchmark places and 7 at Penn 2; whether it still separates this many is what the
decoys and the precondition test.

## Bars

"Spread" is the judge's run spread (`runSd`) as the tool reports it. "Views" are the judged views. Placement is
`placement.mean[arm].errorPx` and `views[].placement`, as the tool computes it at `84b54d44`: Google's footprint fetched
at judging time, 1.5 m margin, holes filled, the street in front.

### The judge can answer (all must hold, or nothing is named)

| # | Metric | Bar | A miss means |
|---|---|---|---|
| V1 | `overall` runSd, mean over all arms | at most 0.75 | the judge does not repeat itself with this many renders |
| V2 | X2 against K, placement errorPx | X2 at least **D** above K, D = half X2 − K in the free dry run, and at least 2 px | placement cannot see a 4 m move here |
| V3 | X3 against K, judge `materials` and `overall` | each at least 1.0 below K | the judge does not see texture with this many renders, so a texture step cannot be told |
| V4 | raw frame agreement; `regions.target.matchedShare` | 1.00 in every view (M1 bar 7); at least 0.99 (M1 bar 8) | the reference or the cut is broken; stop |
| P | raw against K, `overall` | raw above K by more than both arms' spread, and above at 3 or more of the 4 views | K is not shown worse than raw in this call: there is nothing to name |

### Per arm (A is any arm other than raw and K)

| Reading | Judge metrics: overall, shape, clay shape (higher is better) | Placement (lower is better) |
|---|---|---|
| **Moves K** | \|A − K\| wider than both arms' spread, the same sign at 3 or more of the 4 views | \|A − K\| at least 0.25 px, the same sign at 3 or more of the 4 views |
| **Level with or above raw** | A at least raw − (the larger of A's and raw's spread) | A at most raw + 0.25 px |
| **Gap share** (information) | (A − K) / (raw − K) | the same |

- **The answer.** A step is named as making K worse than raw when its arm moves K up **and** is level with or above raw
  on `overall`. Shape, clay shape and placement are read the same way and reported per metric.
- **No single step level.** Then the arms that move K up on `overall` are listed with their gap shares, and so are the
  stage cuts that do, and the report says that no single switch accounts for it.
- **A step whose removal moves K down** is reported as one that helps.
- **The stage cuts** are read with the same rules between neighbours (raw → S1 → S2 → T0 → K).
- **Secondary, deciding nothing:** materials, detail, errors, realism, identity, SSIM, edge chamfer, CIEDE2000, region
  scores.

## Decoys

Both are made locally from K default's twin, at no cost, and judged blind in the same call.

- **X2, moved 4 m along +x:** must lose on placement by D (V2). Its judge numbers are reported and decide nothing (in
  M1 the judge saw the move only 0.75 below K overall).
- **X3, one flat colour:** must lose by 1.0 on materials and overall (V3). Its geometry is K's, so its placement must
  equal K's exactly (a render check), and its clay renders are K's: the gap between their clay scores is the judge's
  noise on two identical images in this call, reported.
- **The raw scan** is not a decoy here: it is the comparator.

## Stop rules

- **Spend:** stop when the running total passes **$60**, and on any 403 or spend-cap error.
- **Disk:** no build starts with less than 10 GB free (the disk had 28 GB free at the start; M1's KD failed on ENOSPC).
- **A build that is not what its arm says:** an arm whose build fails, whose stage downstream of its switch is cached,
  or which carries a failed stage or a degradation K default's record lacks (other than what its switch explains) is not
  judged, and is reported.
- **The dry run, before any paid call:** stop on an empty or black render, an arm with 0 triangles, `frame_mismatch`,
  `liftedM` over 1 m, or a pano any arm's build used that is not excluded.
- **V1 to V4, or P, missed:** nothing is named. The report says the judge cannot answer here (V1 to V3), the reference is
  broken (V4), or K is not worse than raw in this call (P).
- **Spread wider than the gap:** an arm that does not move K reads "the judge cannot tell it from K", not "no effect".
- **One paid call per place.** No re-run until it passes; a second call is a new preregistration that names this one.

## Exposure

- **Panos the builds used** (every arm's survey, which the arms share) are excluded by the tool from the runs' notes.
- **Panos earlier comparisons judged at the ESB:** the M1 rerun judged VqOxFz9R, w4nU8TkI, uPcMge9M and hi-cmKU8 (and
  fetched G8sOFZp8, QcCvIfC8, Q1IjAWuz). They are not excluded: the judge does not learn from them (M1's decision, kept).
  w4nU8T and hi-cmKU8 are refused anyway by the past-edge rule at this commit.
- **The stand-in dry run** judges nothing real.

## Step 2: the free dry run

After the builds, with the server stopped, run M1's driver with credentials unreachable:

```bash
env -i PATH="$PATH" HOME="$(mktemp -d)" PHOTO_MATCH_DRYRUN=<config.json> ./node_modules/.bin/vitest run packages/core/test/photo-match-dryrun.test.ts
```

Config: `{ root: <this worktree>, tile: <K default's welded textured tile>, out: docs/screenshots/k_step_ablation_2026-11-02/esb_dryrun, args: <the tool arguments above> }`.

It must show:
- every arm rendering at every held-out pose, no empty or black render;
- every arm's runId panos excluded;
- the call count: 24 (4 views x 3 runs x textured and clay);
- D for V2, from X2 − K;
- X3's placement equal to K's.

The grids are looked at with the `screenshot-review` skill.

## Cost

Prices as read in [the first M1 preregistration](./2026-10-31-m1-two-modes-prereg.md) ("Price", 2026-10-31): Gemini 4
Argon $2 / $10 per million in / out through 2026-11-30; Flash $0.75 / $3.75; Street View images about $7 per 1,000.

| Item | Basis | Low | High |
|---|---|---|---|
| K default, fresh | measured at the ESB in M1 (run 7f594cd6): $1.20 of vision calls, plus 16 survey images and the library's tile sizes, measured once | $1.30 | $2.40 |
| 18 more ESB builds (15 one-offs, T0, and noInpaint if built) | high: each pays K's $1.20 again; low: the reader's and material choice's replies are reused wherever their inputs are unchanged | $3 | $22 |
| Era check | 8 photos, up to 8 more for swaps | $0.06 | $0.12 |
| Judge, 24 calls | up to 23 images a call at 1,089 tokens (measured), about 27k tokens in; out 2k to 26k (thinking HIGH) | $2.30 | $7.50 |
| Judge photos, footprint fetch | 8 images; 4 vector tiles | $0.06 | $0.15 |
| **The ESB** | | **about $7** | **about $32** |
| The Haughwout and the Ferry, only if a step is named | per place: K, S2's build is K's, up to 2 named arms, judge, era check | $3 each | $6 each |
| **In all** | | **about $7** | **about $44, against the $60 stop** |

Under the user's $100 (2026-10-31): no approval needed. The actual spend is reported after.

**Time.** M1's ESB K build took 26 min, 22 of them in the twin (material regions alone 19 min). About 19 builds at 3 to
25 min each, one or two at a time: about 4 to 7 hours.

## Order

1. Launch entry `scratchbox-k-step-ablation` (web 3740, API 3741, tools 3742) on this worktree, `SCRATCHBOX_CACHE_RESTORE=off`.
2. Build K default. Read its record: every stage a cache miss; apply the no-op rule.
3. Build the `steps` arms and T0 on the same server; then restart with each environment variable for noWalls, noSeams
   and noInpaint (unless pruned). Check each record.
4. Make X2 and X3. Stop the server. Free dry run; review the grids; write D.
5. Start the server. Era check; commit the outcome.
6. The paid call. Record and report against the bars, with the grids.

## Run record

Values written as they are fixed.

(none yet)

## Report

(after the paid call)
