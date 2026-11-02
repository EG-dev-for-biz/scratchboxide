# Preregistration 3: which stage of pipeline K loses the Ferry Building's geometry

Date: 2026-11-02. Status: **written before its paid call.** Nothing below changes after this line except the run record and
the report. A bar, arm or view changed after the paid call is a new preregistration that names this one.

## The two earlier runs, and why this one is made

- **The first** ([its preregistration](./2026-11-02-k-step-ablation-prereg.md)) asked, at the ESB, which K step scores
  worse than the raw scan.
  - It was indicative (2 views registered).
  - It put 1.17 of K's 1.83 overall gap in the twin's de-light, since fixed in PR #17.
- **The second** ([its preregistration](./2026-11-02-k-step-ablation-2-prereg.md)) judged the fixed K at the Haughwout and
  the Ferry. It was indicative (`matchedShare` under 0.99), and the ESB was not judged.
  - At the Ferry, K stays 1.20 below the raw scan overall.
  - The loss is geometry: clay shape 4.07 against 6.00, placement 6.50 px against 3.05.
  - Lattice off and window fit off recover only 0.28 of it, so it lies in a step none of its arms isolated.
- **This run judges K's own stage cuts at the Ferry,** the way the first did at the ESB. The parent session relayed the
  user's "Do what you think is best" and asked for it.

## Question

Which stage of K's build at the Ferry, between the raw scan and K, loses the geometry? The ladder is raw, then
tile_refine, then each polish step, then the twin.
- **A stage named:** it is the next thing to fix there.
- **None named:** the loss is spread over the stages, or the judge cannot tell them apart. The report says which.

## Arms

None is built: every stage cut is a file K's own build (run 345e37dd, on `fix/k-twin-delight` at 0526929f) wrote. They are
in this worktree's cache, `tile_refine/f6374723.../`, and its polish `polish/fecb1237a523e475/`. That polish is K's: it was
written at 12:37, inside K's build, and the other two polish folders there are the lattice-off arm's (no lattice step) and
the window-fit-off arm's, written at 12:52 and 12:53.

| Id | Label (reports only) | File | Triangles |
|---|---|---|---|
| K | K | the K twin `..._l2_tex_411b6d88.glb`, `runId` 345e37dd: the reference | 8,353 |
| raw | RAW SCAN (CUT TO TARGET) | `baseline: true` | |
| C1 | STAGE CUT A | tile_refine's `textured.glb` | 5,796 |
| C2 | STAGE CUT B | `step_cleanup.glb` | 5,796 |
| C3 | STAGE CUT C | `step_lattice.glb` | 7,230 |
| C4 | STAGE CUT D | `step_base.glb` | 7,280 |
| C5 | STAGE CUT E | `step_clip.glb` | 7,997 |
| C6 | STAGE CUT F | `step_infill.glb` | 8,353 |
| C7 | STAGE CUT G | `step_orient.glb`: K's geometry before the twin (its bytes are the polish's `textured.glb`) | 8,353 |
| X2 | DECOY MOVED 4 M | K's twin moved [4, 0, 0] (run 2's) | |
| X3 | DECOY FLAT COLOUR | K's twin in one colour (run 2's) | |

- **The files.** Every file is textured (9 or 10 photos; the twin 43), and their sha256 differ step to step.
- **What each step did** (the polish's `stats.json`):
  - **Cleanup:** removed 38 pieces (75 triangles).
  - **Lattice:** rebuilt 1 facade in 253 cells.
  - **Base:** an apron of 298 m² and a skirt of 9.9 m².
  - **Clip:** removed 588 m².
  - **Infill:** filled 217 loops.
- **Scope:** every arm is `target`, drawn in K's tile with the target cut out.
- **Labels:** the labels say "stage cut" and a letter only, so the judge sees nothing of the order.

## Views

The second run's five Ferry views, as fixed poses, unchanged. They were registered there, era-checked and kept:
- 8UfT-51p h46.1 p18.5 f50;
- 4sXa5k8s h121.4 p17.8 f50;
- A62bPfiJ h341.7 p14.2 f50;
- XL-oDO4u h333.7 p9.4 f50;
- GOgaHhj9 h133 p9.1 f50.

Arguments: `views: 5`, `runs: 3`, `clay: true`, `judgeRegions: true`, `trees: true`, `baseline: true`. A pose that does
not register again drops out, as the tool reports. With fewer than 3 judged views the run is not read.

## Bars

The judge must be able to answer: V1, V2, V3 and V4, as in the first two runs. D for V2 is set by this run's dry run.
- V4 is expected to miss again (`matchedShare` 0.862), which makes the run indicative.
- It is kept, so that this run reads like the others.

**A stage loses the geometry** when its cut scores below the cut before it:
- on **clay shape**, by more than both cuts' spreads, at three quarters of the judged views and at least 3;
- or on **placement**, by at least 0.25 px, the same sign at every view with a placement and at least 2.

Overall and shape are read the same way and reported. The stage named is the one whose drop on clay shape is largest,
with placement beside it. Only one read: the stage cuts.

## Stop rules

- **Spend:** stop past **$20** and on any 403 or spend cap.
- **The dry run:** an empty or black render, an arm with 0 triangles, or `frame_mismatch` stops it.
- **V1 to V3 missed:** nothing is named. **V4 missed:** indicative, as written above.
- **One paid call, no re-run.**

## Exposure

The five views were judged in the second run. They are not excluded, by the M1 rule kept in both earlier runs. The panos
K's build used are excluded by the tool.

## Cost, estimated before the call

| Item | Basis | Low | High |
|---|---|---|---|
| Judge | 30 calls (5 views x 3 runs x 2) of 12 images, about 13.5k tokens in; out 1.5k measured in run 2, up to 26k thinking | $1.30 | $8.60 |
| Photos | 5 Street View images | $0.04 | $0.04 |
| Builds | none | $0 | $0 |
| **In all** | | **about $1.35** | **about $8.65**, against the $20 stop |

Under the user's $100, so no approval is needed. The actual spend is reported after.

## Order

1. Commit this.
2. Run the free dry run (server stopped, credentials unreachable) and set D.
3. Make the paid call on the restarted server.
4. Report against the bars, with a labelled proof sheet.

## Run record

(none yet)

## Report

(after the paid call)
