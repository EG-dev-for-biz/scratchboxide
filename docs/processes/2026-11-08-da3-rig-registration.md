# Street View registration from multi-view depth (Depth Anything 3 Small and Base) at 7th Ave & W 32nd St

**Status: Refused on real data** (the module works on a synthetic drive; on the six 7th Ave panoramas neither DA3 Small's nor DA3 Base's poses hold together, so the registration declines and the stated poses stand). Proof sheets: `docs/screenshots/da3_rig_registration_2026-11-08/proof_sheet_da3_small.png` and `proof_sheet_da3_base.png` (gitignored).

## What was asked

The user asked (2026-11-08) to test the registration logic of the streetview-to-3d / panoramic-da3 projects (YellowO2, MIT) with Depth Anything 3 Small, rebuilt for this codebase, with the panoramas fetched through Maps Imagery Grounding.

## What was built

- `packages/core/src/node/spatial/rig-depth-registration.ts`: their logic rewritten as ours: per-panorama pose consensus and view filter (0.2 units, 1 degree), back-projection, one similarity onto the stated cameras (2-D Umeyama scale, Horn rotation with each panorama's heading as a prior), their coarse-to-fine count search (7 x 7 x 7 at 1.0 / 0.3 / 0.1 m, samples within 15 m of the cameras, 0.3 m), their sight-line agreement metric. Two additions of ours:
  - **refinement:** their count is flat across about 0.6 m (every move in the band scores the same; on a synthetic street the search stopped 0.3 m off), so the move is finished by translation-only nearest-point iterations (synthetic offset recovered within 5 cm);
  - **refusal:** fewer than two panoramas with 60% of their views agreeing (their keep-rate bar) throws `RigRegistrationRefused('views_disagree')` instead of returning a move.
- `packages/core/src/node/spatial/Da3RigDepthService.ts` + `tools/depth/rig_depth_da3.py`: a persistent-worker sidecar running DA3 Small (or Base) jointly over a drive's views. The views travel inline in the request (Street View imagery is never written to disk); only derived depth comes back through a temporary file. Interpreter: `SCRATCHBOX_DA3_PYTHON` (depth_anything_3 installed with `--no-deps`: its xformers dependency is CUDA-only and unused).
- `MapsImageryGroundingService.fetchPanoViewsInMemory`: a panorama's level views at chosen headings, in memory, resolved from a pano id or (through Maps Imagery Grounding) a prompt.
- `packages/core/test/rig-depth-registration.test.ts`: 9 formula tests on a synthetic street canyon with known poses (consensus drops a bad view, placement recovers the scale, the refined move recovers a 0.7 / 0.4 m offset, refusal when views disagree). Passing; core typecheck clean.

## The run (2026-11-08)

- Six panoramas of one drive (captured 2026-04), the same as the 7th Ave splat world; 12 views each (30 degree steps, 90 degree fov, 640 px) from `fetchPanoViewsInMemory`: 72 views in 6 s.
- DA3 Small on 72 views: 27 s on the Mac's GPU (mps).
- Their consensus filter kept 0, 0, 1, 1, 0 and 0 of 12 views. Each view's rotation disagrees with its panorama's consensus by 0.8 to 17.7 degrees (limit 1), and the estimated centres of one panorama's views (all taken from one camera point) spread up to 30 m.
- Forced on (to see what it would do): the drive placed 1.6 to 6.1 m off the stated cameras, turned up to 7.3 degrees; the scan move 4.23 m east, 2.65 m up, 3.70 m south, which would move the cameras 2.1 to 12.0 m and 2.65 m down to street level (one camera 0.32 m from a surface). Not plausible: Street View positions are good to a few metres, and in the proof sheet the stated poses already put the photo's building edges near the scan's.
- With the refusal in place the module now declines this case itself.

## DA3 Base, with and without the known intrinsics

The user asked for DA3 Base next (2026-11-08). Same 72 views, same code.

- Without intrinsics: 39 s on mps. Kept 0, 0, 1, 0, 2 and 1 of 12 views. Rotation disagreement mostly 2 to 6 degrees (Small: 5 to 15), but one view 50.5 degrees off and the views at yaw 240-270 about 10-12 degrees off in every panorama. Forced: drive placed 2.9 to 6.9 m off, turned up to 9.4 degrees; the cameras would move 2.2 to 10.6 m and 2.59 m down.
- With the known intrinsics (90 degree views, `horizontalFovDeg` on each view, an option ours adds; their code never passes intrinsics): 44 s. The same within centimetres and a tenth of a degree: the direction-dependent error is the model's pose, not a focal length it misjudged. Refused.

## What of theirs is and is not here

- **Their shift search** (tiles slid onto the depth points): yes, `shiftSearch`, then our refinement.
- **Their per-direction bend** (bent.py: the depth points reshaped per compass slice to the tiles): not built. It runs after the shift and only reshapes the depth model's points for their merged scene; it moves no camera, so it cannot change a registration, and our depth points never become geometry. Its distance measure is here (`sightAgreement`).
- **COLMAP**: not used by them for poses (DA3's joint estimate gives every pose; DA3 imports pycolmap only for its export, which streetview-to-3d stubs out as unused) and not used here.

## Why

DA3 Small is the smallest any-view model (0.08 B parameters, no metric head); the projects this logic comes from run DA3 Nested Giant Large 1.1 (CC BY-NC 4.0, not usable here) and found even the non-nested Large model's pieces came out at different scales. Their thresholds were set for the Giant model.

## Still open

1. The edge score used here (median distance from scan edges to photo edges) is too loose to judge a pose: it improved under the implausible forced move. The judge's registration or the research report's render-and-match is the measure to use.
2. Pano `iUK9l3Uh` is stated 5 m higher than its neighbours (5.1 m above the nearest scan surface): its stated elevation looks wrong, independently of this test.

## Candidate tool/service ideas

- A `streetview_register_drive` tool over `registerRigOnScan` once a depth model passes the consensus on real data.
