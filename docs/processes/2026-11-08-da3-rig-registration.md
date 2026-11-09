# Street View registration from multi-view depth (Depth Anything 3 Small and Base) at 7th Ave & W 32nd St

**Status: DA3 refused on real data; drive-first registration aligns most views (2026-11-09)** (the module works on a synthetic drive; on the six 7th Ave panoramas neither DA3 Small's nor DA3 Base's poses hold together, so the registration declines and the stated poses stand). Proof sheets: `docs/screenshots/da3_rig_registration_2026-11-08/proof_sheet_da3_small.png` and `proof_sheet_da3_base.png` (gitignored).

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

## Our own registrar, then learned matching (2026-11-09)

The user asked to get the panoramas aligned. Both tried against a fresh photo-textured extraction of the same crawl (same triangles as the clay scan, but 5.08 m higher: shifted down onto the clay frame the stated poses use). Photos in memory only; proof sheet `proof_sheet_learned_matching.png`.

- **StreetViewFeatureRegistrar as it is** (dense alignment, block matching, RANSAC-PnP, edge refinement): one panorama took 63 minutes and accepted 0 of 12 views (0-8 point matches per view, gate 12; interior edges 3-4 px, gate 2; orientation NCC 0.03-0.13). Not run on the rest.
- **DISK + LightGlue** (kornia, Apache-2.0) between each photo and the textured render at the stated pose: 25-624 matches per view, about 1 s each on mps (LoFTR outdoor: 0-89). Render keypoints lifted through the render depth (off depth steps), then the registrar's own robustSolve + refine, one pose per panorama; a second pass re-rendered at the first solution.
- **Held-out** (each view under the pose fitted to the other 11): in 5 of 6 panoramas 2-5 views land within 1.1-2.5 px (stated: 5-56 px). But they face one sector each; the other views stay 20-40 px off, and the moves (1.4-6.7 m) disagree along the drive: one correction shared by all six explains 1,038 of 14,916 matches (the six separate fits: 3,549). Not applied.
- Likely causes: matches on one facade let a pose shift and turn to fit it; views toward changed places (the 2026 canopy and plaza) and transients (a parked police car) match wrongly.
- Next: same-date photo-to-photo matches tie the six panoramas into one rigid drive first, then the drive is fitted to the scan with all its views at once.

## Drive-first registration (2026-11-09)

The user asked to build it. `packages/core/src/node/spatial/street-view-drive-registration.ts` (`registerDriveOnScan`): every panorama's six pose parameters in one robust least squares (Cauchy loss in pixels; two-view tie points eliminated by the Schur complement), in three stages: **drive** (photo-to-photo ties only, each pose held loosely to its stated one: 5 m, 3 m up, 3 degrees), **rigid** (the tied drive moved as one body onto the scan matches: coarse search over shift and turn, then robust refinement), **joint** (ties, scan matches and the loose priors). Tests: `packages/core/test/street-view-drive-registration.test.ts`, a synthetic canyon where each panorama's scan matches lie on one wall only, 15% wrong: every pose recovered within 0.1 m and 0.1 degree; a panorama with no scan matches placed within 0.2 m from its ties.

The 7th Ave run (proof sheet `proof_sheet_drive_first.png`):

- Ties: 141 co-visible view pairs between panoramas (chosen by lifting each view through its scan depth at the stated pose), DISK + LightGlue, kept by an essential-matrix check (MAGSAC, 1 px): 23,639 matches, 17,707 meeting at 1 degree or more. Photos fetched into memory only.
- The stated poses fit 3,871 of the ties within 2 px; the tied drive 16,683: the stated poses disagree with each other, not only with the scan.
- Rigid move of the drive: 6.7 m east, 2.5 m down, 2.1 m south, 1.2 degrees. Joint: scan matches within 3 px 11 -> 4,875 of 14,095; cameras moved 1.1-8.9 m (pano iUK9l3Uh 6.9 m down: the 5 m high elevation noted below).
- **Leave one panorama out** (its scan matches removed, its pose from ties alone): lands 0.10-1.34 m from the full fit; its own scan matches then fit as well as in the full run (e.g. VVmScUGc views 30-180 degrees: 72-82% within 3 px, medians 1.7-3.5 px; stated 0%).
- **Plausibility check** (not ground truth): the solver knows nothing of the ground, and every camera ends 2.04-2.19 m above the street surface below it (stated: 2.50-9.09 m).
- Still off: views toward 120 and 300-330 degrees (medians 60-240 px in every panorama); the cause is not established. Views at 180 degrees improve but stay 3-11 px.
- Not yet applied anywhere: no tool or stage consumes these poses. Next: find why the 300-degree views fail (wrong matches vs a scan surface missing, e.g. the canopy), then wire the drive registration into the Street View pose path.

## Still open

1. The edge score used here (median distance from scan edges to photo edges) is too loose to judge a pose: it improved under the implausible forced move. The judge's registration or the research report's render-and-match is the measure to use.
2. Pano `iUK9l3Uh` is stated 5 m higher than its neighbours (5.1 m above the nearest scan surface): its stated elevation looks wrong, independently of this test.

## Candidate tool/service ideas

- A `streetview_register_drive` tool over `registerRigOnScan` once a depth model passes the consensus on real data.
