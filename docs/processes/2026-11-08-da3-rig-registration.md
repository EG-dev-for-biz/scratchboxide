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
- Views toward 120 and 300-330 degrees score badly on the pixel measure (medians 60-240 px); see below: the scan matches there are wrong. Views at 180 degrees improve but stay 3-11 px.
- Not yet applied anywhere: no tool or stage consumes these poses. Next: find why the 300-degree views fail (wrong matches vs a scan surface missing, e.g. the canopy), then wire the drive registration into the Street View pose path.

### Why the 300-degree views looked wrong (2026-11-09)

The user asked to investigate. Findings:

- **The poses are consistent there:** photo-to-photo ties in the 300- and 330-degree views fit within 2 px for 84-100% of them under the drive poses, as in the views that align.
- **The pixel numbers there came from wrong scan matches,** not from a wrong pose: those views' scan matches mostly pair 2026 cars and the lower storefronts, which changed since the tiles were captured. Looked at directly (`proof_h300_structure.png`, upper part of each view), the photo's edges sit on the canopy truss in all six panoramas under the drive pose. The PENN STATION sign lines up clearly in 2 of 6 (3yGYmP_G, iUK9l3Uh) and partly in 2. The stated pose traces the truss about as well (it is far away and repetitive, so it says little about the pose). A visual check by a separate agent agreed with that reading.
- **Where the photos see behind the scan:** triangulated tie points sit mostly 2-30 m behind the scan's surface along the same ray, in every direction (`diag300.ts` in the scratchpad). Two causes are visible: photogrammetry drapes over recesses (under the Penn canopy the scan surface sits at the canopy edge while the photos see the facade behind it), and objects in the tiles that are gone in 2026. Under the drive pose, VVmScUGc has a scan surface 1.2-2.1 m away across 60-180 degrees (a large vehicle-sized block at the curb; the photo shows open street and a police car there).
- **Not settled: the cameras' lateral positions.** Ties alone move 3yGYmP_G and hx0IwVbv about 10 m west of the other four, even with the stated relative positions held to 0.3 m; the scan matches then agree with that shape (joint and rigid stages nearly equal). The top-down map puts feKTMhN8, VVmScUGc and hFvT5jKC about 6-7 m east of the stated line, toward the east side beside 1-3 m objects in the scan, and the other two near the line: a lateral change of about 8 m over 13 m of travel, implausible for one car on one drive unless these are separate drives (the capture dates are known only to the month). A straight drive past window-grid facades lets a match shifted by one window satisfy the photo-to-photo check, which could bend the tie geometry; nothing here yet rules that in or out.
- Added `drivePriorPosM` and `jointPriorPosM`; the joint stage's prior is now centred on the rigid stage's poses.
- Next: an outside position check (Street View's own per-pano capture dates and links, to tell separate drives apart), and a tie filter that rejects matches whose disparity is ambiguous along a repeating row.

### Two drives, not one (2026-11-09)

The user asked to check. Street View's own metadata (Map Tiles API `streetview/metadata`, no imagery; `pano_meta.py` in the scratchpad) for the six panoramas, proof sheet `proof_two_drives.png`:

- **Drive A:** hFvT5jKC -> VVmScUGc -> feKTMhN8 -> iUK9l3Uh (links), car heading 209, 209, 185, 177 degrees, then a link onward at 119 degrees: a car turning left from southbound 7th Ave onto W 32nd St. Camera roll about -2 degrees.
- **Drive B:** XBym1B4Z -> 3yGYmP_G -> hx0IwVbv, heading 207-209 degrees, straight down the avenue; roll about +0.9 degrees. feKTMhN8 lists a link to 3yGYmP_G, but 3yGYmP_G does not link back. All six are dated 2026-04 (month only).
- **Positions:** the stated positions are Google's metadata positions exactly. Across the avenue (east negative): drive A's straight panoramas -6.6 to -6.8 m, drive A's turning panorama iUK9l3Uh -16.2 m, drive B -7.0 to -7.1 m. Google thus has feKTMhN8 and iUK9l3Uh 9.4 m apart across the avenue but 3.5 m apart along it, which no car does. The drive-first fit puts drive A at -13.8 to -16.4 m (one lane, next to Google's own iUK9l3Uh position, the lane a left turn needs) and drive B at -6.0 m (moved 1.1 and 2.1 m, mostly down to street height); along the avenue every panorama stays within 2.2 m of Google's position.
- So the lateral jump in the fit is two lanes on two passes; Google's positions for drive A's straight panoramas are the ones that are off. This settles the open point above about plausibility; it does not prove the fit to the decimetre. The one-window tie ambiguity is not ruled out, but the fit now agrees with Street View's own link graph, headings and the turning panorama's position, none of which the solver used.
- Each panorama already has its own pose in `registerDriveOnScan`, so separate drives need no change to the solver; drive membership (the link graph) is a candidate for a check on its result: panoramas of one drive should lie on a smooth path along their headings.

### Wired into the Street View pose path (2026-11-09)

The user asked to wire it in. The drive registration is now the last step of the shared pose job (`pano-registration-run.ts` `runPanoRegistrationOffThread`: box, edges, joint, then drive), which the build's evidence stage, `streetview_survey` and `photo_match_evaluate` all use.

- `pano-drive-registration.ts` `registerPanosByDrive`: renders the tiles' texture from each wide view at the poses in force, picks co-visible view pairs between panoramas, asks the learned matcher for photo/render and photo/photo matches, lifts the scan matches through the render depth (training cells only), runs `registerDriveOnScan` and converts the poses back to the path's corrections (`correctionFromPose`, YXZ at reference heading 0; round trip tested against `frameCamera`).
- **Judged like every other step:** kept only when `heldOutFitOfFrames` on the held-out cells is better (`fitIsBetter`). A kept pose is `method: 'drive'` with its residual in metres; `streetview_survey`, the survey detail, the texture views and the ownership trust read it like 'edges' and 'joint'. The joint fit's warps are dropped when the drive replaces the poses they were fitted to.
- `LearnedFeatureMatcherService` + `tools/matching/learned_match.py`: DISK + LightGlue (kornia, Apache-2.0) as a persistent worker, photos inline (never on disk). Interpreter `SCRATCHBOX_MATCH_PYTHON`, else the project's `.venv` (kornia 0.9.0 is in `requirements.txt`, installed in the main checkout's `.venv` 2026-11-09: it added kornia and kornia_rs only); without it the step is skipped with that reason. `SCRATCHBOX_DRIVE_REGISTRATION=0` turns the step off.
- **The run** through `runPanoRegistrationOffThread` itself (worker thread), 72 views of the six 7th Ave panoramas, the photo-textured tiles: edges took no panorama (3 scored, 3 not reached in the time, machine load 15-23), joint did not run in its budget; the drive step made 21,347 photo-to-photo and 7,095 scan matches in 289 s and was **kept: held-out edge chamfer 8.33 -> 6.47 px, gradient NCC 0.142 -> 0.356**. Poses equal the standalone fit within 5 cm. Proof sheets `proof_path_drive.png` and `proof_path_zoom.png` (full-resolution crops: at sheet scale a visual check could not tell the panels apart; in the crops the photo's window edges sit on the rendered windows under the kept pose and beside them under the stated one). The 300-degree views look the same under both poses.
- Tests: `pano-drive-registration.test.ts` (correction round trip, lift, covisibility), `street-view-drive-registration.test.ts`; the existing registration, worker, survey and bake tests pass with the step in place (it skips without the matcher's interpreter).
- Cost: about 5 minutes for six panoramas on this Mac (matching on mps); it runs after the edges and joint steps, whatever their budgets.

### Seen-through removal (2026-11-09)

The user asked for it, after reading that streetview-to-3d drops Google's points "standing in front of what a pano saw" (`merged_world.py`). `packages/core/src/node/3d-engine/staged-location/seen-through.ts`, as the vehicle removal's decision instead of its vision model:

- The drive step now returns its **seen points** (`SeenPoint`): ties within 2 px in both photos whose rays meet at 3 degrees or more, triangulated under the poses in force. Each ends a clear line of sight from two cameras.
- **Evidence** (`seenThroughEvidence`): along every line, the vehicle removal's candidate cells (proud of the measured street, clear of the vector buildings) it passes under the top of and over the street, at least 1.5 m short of the seen point; lines and panoramas counted per cell.
- **Judge** (`seenThroughJudge`): clusters seen through from 2+ panoramas (3+ lines) become readings, boxed in tiles of at most 4 m tight round their own cells (one box round a long cluster on a 29-degree avenue took 367 m²). Not permanent, so `removeTemporary` takes them; no model call.
- **Patch:** the vehicle removal's own (ring-measured street, infill paint), with two changes for this caller only: `keepOverOpenSpace: false` (its awning rule kept a shed's top and left a ramp to the lowered base, across storefronts the photos show) and a height limit of 8 m (`SEEN_THROUGH_MAX_HEIGHT_M`; at 5 m a taller sidewalk structure left a ramp). The vehicle removal's tests pass unchanged (its default keeps awnings).
- A final pass that cut triangles still on clear lines was tried and dropped: it left shards and holes.
- **7th Ave** (standalone, the drive's tie points and poses, textured tiles, vector buildings): 13 regions, 3,340 vertices lowered, 263 m² lowered in the height map, all on the street and sidewalks (the east curb strip beside drive A and the south side of W 32nd St). The block 1-2 m beside VVmScUGc is gone and the building behind it shows, its windows on the photo's edges. Proof sheet `proof_seen_through.png`. Still open: the patch paints the street from its own texture (smooth grey); a few cut edges remain.
- **Wired into the 3D World build** (`Location3DGaussianSplatService`): after the Street View registration, with the textured twin and the vector lookups, the clay GLB the stations are baked on is replaced by the patched one; the result reports `streetView.seenThrough` and `driveSummary`. `SCRATCHBOX_SEEN_THROUGH=0` off.
- **The in-app rebuild** (my instance, the world cache off): the chat ran `location_generate_3dgs` without a street vantage, so the world took 16 survey stations and no Street View station: no registration, drive step or removal ran. Not yet seen in the app.

### SHARP one-panorama trial (2026-11-09)

Status: trial only, outside the repo (a scratch script and a scratch Python environment under `~/.cache/scratchbox-sharp-trial`); nothing in the app calls it. The user asked for it after comparing our world with the reference app (streetview-to-3d), whose splats come from SHARP (Apple's single-image-to-Gaussians model) per panorama slice, scaled to a depth reference.

- **What ran:** panorama `3yGYmP_G` (registered pose, moved 1.07 m by the registration), four level views (yaw 0/90/180/270, hfov 110) and one floor view (pitch -90, hfov 100), 640 px, fetched in memory and never written. SHARP on each view (1,179,648 Gaussians a view). In place of the reference's Depth Anything 3, the scale reference is **the scan's depth rendered at the registered pose**: per view, the median scan / SHARP depth ratio per (log depth x horizontal angle) cell, nearest-filled and smoothed, applied to positions and sizes; the floor view per image cell. Gaussians with no scan surface under their pixel (sky, and buildings above the scan's extraction) are dropped.
- **Result:** 4,387,204 splats in 65 s on this Mac (mps; 11 s a view, 7 s to load the model). About 10 Static Street View fetches a run, three runs: cents.
- **Fit to the scan** (kept Gaussians, |scaled SHARP depth - scan depth|):

| View | Kept | Scan/SHARP ratio p10 / median / p90 | Median residual raw -> scaled | p90 | Within 0.5 m |
|---|---|---|---|---|---|
| level 0 | 853,336 | 0.75 / 1.22 / 2.20 | 1.10 -> 0.31 m | 8.3 m | 54 % |
| level 90 | 797,361 | 0.89 / 1.42 / 1.71 | 1.29 -> 0.09 m | 4.6 m | 59 % |
| level 180 | 890,202 | 0.97 / 1.63 / 1.92 | 1.65 -> 0.53 m | 7.6 m | 50 % |
| level 270 | 983,397 | 0.71 / 1.54 / 2.24 | 1.96 -> 0.83 m | 6.8 m | 45 % |
| floor | 862,908 | 4.03 / 4.42 / 4.88 | 1.65 -> 0.01 m | 0.04 m | (fitted per cell on a flat surface: says little) |

  SHARP's depth is not one scale off the scan: within a view the ratio spreads 2-3x, so the per-cell field is needed, and it filled only 45-52 % of its cells from data. The long tail (p90 4.5-8 m) is partly real disagreement: the photo's vehicles and trees are not the scan's.
- **Proof sheet:** `docs/screenshots/da3_rig_registration_2026-11-08/sharp_one_pano_trial.png`: the scan, the trial and the current world (six panoramas + tile stations) from the same four cameras, none at a pose SHARP was given (3 m beside the panorama, 6 m up and down the avenue, 14 m back and 9 m up).
- **Reading:** near the panorama (3-6 m away) the trial reads as a photograph where the current world reads as flat, torn planes: crosswalk, vehicles, billboards and facades hold together (an independent visual check agreed for rows A-C). Its faults, from the same check: the slices' edges show (a hard diagonal edge on the upper-right building in C, a step in a slab at A's right), a billboard floats in front of the tower behind it in B (its depth is SHARP's, off the scan's), and from above (D) it is streaks and smears, neither clearly better nor worse than the current world's shards and holes. It is one viewpoint: behind vehicles it smears, and the photo's vehicles are baked in as splats (the seen-through and vehicle removals do not apply to them). The current world's panel C is mostly empty on the right: it has no surface there, not a wrong camera.
- **Licence:** SHARP's code is Apple's sample-code licence, but its **weights are under the Apple Machine Learning Research Model License: research use only, not for a product**. The trial is a measurement of what the approach gives; shipping it needs a model with a usable licence (or our own), and AGENTS.md section 2 would need the user's decision either way.

### SHARP street splats in the app: cleanup and hard cells (2026-11-09)

Status: in the app (`SharpStreetSplatService`, `tools/depth/sharp_street_worker.py`), on by default where SHARP is installed. Built through the app's chat (`location_generate_3dgs`, street vantage, own `outDir`, world cache off) at 7th Ave & W 32nd St. The hard-cells default was verified by re-running the worker's merge on the v4 build's own inputs, not by a further in-app build (that rebuild was cut short by a session restart).

- **Cleanup per view** (v3, v4): splats hanging between a near and a far surface dropped (565-5,096 a view), splats behind the scan dropped (up to 207 k a view), a view under half of which lands on the scan keeps only what does (most views; within 10 % of the scan afterwards 0.62-1.0), SHARP kept only to 7 m over the street. One panorama of six (`FS1Y4T`) left out: none of its four level views landed on the scan (fits 0.095 / 0 / 0.008 / 0.043).
- **v4 (cleanup + Depth Anything 3 as the level views' reference):** 8,907,173 splats predicted over the scan; 87,043 dropped in free space another panorama saw through, 236,553 doubled, 2,583,794 thinned to the 6 M budget; base layer 2,577,895 kept, 1,291,647 replaced; 8,577,678 in the world; 366 s on mps.
- **Hard cells** (same SHARP output, the merge only; 5 s): each panorama keeps only what is nearer to it on the plan than to any other: 483,184 dropped outside their cell, 2,337,184 thinned, 8,805,236 in the world.
- **Reading** (four cameras away from every panorama; an independent visual check of v4 against hard cells): hard cells has less smear and doubling on the road and round the buildings in three of four cameras and no real difference in the fourth; it loses a bus the overlap rule showed (smeared), and shows flat grey patches, hard cut lines and card-like panels where the base layer stands behind the cut. Neither reads as a clean street between panoramas or from above. One panorama alone, seen from near its own eye, still reads best: the six predictions are independent and do not agree.
- **Not done:** the proof renders and the merge snapshot were scratch files and were lost with the session's scratch folder; the sheet was sent to the user. Vehicles and people in the photographs are baked in.

### Joint optimisation of the SHARP street splats (trial, 2026-11-09)

Status: trial only, outside the repo (`~/.cache/scratchbox-sharp-trial/joint`: a PyTorch splat renderer written for it, on Metal; nothing in the app calls it). Not adopted. The user asked for it after the question of how apps keep splats consistent: trained scenes fit every photo jointly, ours are five independent predictions.

- **Inputs:** an in-app build (v5: hard cells on by default, scan depth reference, since the scratch Depth Anything 3 environment was lost and its reinstall was refused) with `SCRATCHBOX_STREET_SHARP_KEEP=1`, which keeps each panorama's cleaned splats, the base layer and the poses. v5 in the app: 9,534,241 splats predicted, 776,156 outside their cell, 8,355,500 in the world.
- **Views:** 15 a panorama (the five SHARP views, four more level, four at -25 degrees, two held out), 75 in all, fetched in memory and never written; trained at 320 px. The loss counts only pixels the street set covered to begin with, and penalises new coverage elsewhere.
- **Finding 1, the measurement that explains the mess:** from a panorama's own eye, its own splats alone reproduce its photo at 22-25 dB (33 dB straight down); with the other panoramas' splats added, 13-17 dB. The other panoramas' splats stand in front.
- **Everything optimised** (place, size, turn, colour, opacity; 450 steps, 1.2 s a step): held-out views at the panoramas 14.8 -> 22.7 dB, splats moved 5 cm at the median, mean opacity 0.84 -> 0.82. From cameras between the panoramas it is worse: the road is speckled and the crosswalk softer. The optimiser repainted the splats in front to look right from the five eyes (sparse-view overfit).
- **Votes only** (colour, place and size fixed; the views may only fade a splat, and one under 0.25 goes): 307,550 of 9,534,241 removed, held-out 14.8 -> 18.6 dB. Merged with hard cells, it is nearly indistinguishable from hard cells alone from the proof cameras: the cells already remove most of what the vote removes.
- **Reading:** five eyes on one street are too few to constrain a joint fit; the gain at the panoramas does not carry to the views between them. What would: many more panoramas along the drive (every 3-5 m instead of five), or one consistent geometry under the splats (the scan) instead of five depth predictions.
- **Proof sheet:** `docs/screenshots/da3_rig_registration_2026-11-08/sharp_joint_optimisation_trial.png`.

### Vehicles and people removed before SHARP (2026-11-10)

Status: in the app, on by default (`SharpStreetSplatService.clearViews`, `SHARP_CLEAR_PROMPT`; `SCRATCHBOX_STREET_SHARP_CLEAR=0` off). User decision, 2026-11-10. Built through the app's chat at 7th Ave & W 32nd St (v6, world cache off, scan depth reference).

- **What runs:** each of a panorama's five views goes inline to the world's station image generator (answered by `gemini-3.1-flash-image`, 1K) with a prompt to remove every vehicle and person and change nothing else. The worker then checks the edit against its photograph (`framing_held`: edge strength on a 160-cell grid, correlated over shifts of up to 4 cells; held when the best match is within one cell of no shift, the correlation at no shift is at least 0.2, and the image is square). A held edit is what SHARP draws (`generated`); otherwise the photograph is.
- **v6:** 24 of 24 level views edited and held (edge correlation 0.63-0.95, no shift). All five used panoramas' straight-down views were refused (correlation about 0: a road seen from above has few edges, and the model redrew it) and kept as photographed. 9,423,206 splats predicted, 7,918,607 in the world.
- **Reading** (four cameras away from every panorama, against v5, same poses): the taxis, cars and most pedestrians of v5 are gone in all four cameras and the road under them reads as road. An independent visual check also found: one standing figure and one or two possible vehicle remnants left (far sidewalk, camera D), a painted turn arrow much fainter than in v5, and grey or white flat patches where v5 showed a building at the left edge (the base layer's station images differ between the two builds, so not all of that is the edit's).
- **Proof sheet:** `docs/screenshots/da3_rig_registration_2026-11-08/sharp_no_vehicles.png`.
- **Cost:** 30 image edits a build (six panoramas by five views), on top of the stations'.

### Fidelity: full-resolution tiles, a 2K two-pass removal, no thinning (2026-11-10)

Status: in the app, on by default. Built through the app's chat at 7th Ave & W 32nd St (v7, world cache off, scan depth reference). A first attempt failed four minutes in with ENOSPC: the app's working files go to the 3DTESTING drive, which another session had filled.

- **Sharper source** (`street-view-tiles.ts`, the worker's `tileViews`): the Map Tiles API serves these panoramas at 16,384 x 8,192 px. Each view is drawn from zoom 4 (8,192 px round the horizon, 128 tiles a panorama, in memory only) at 1536 px, SHARP's own working size, where the Static API gives 640. How Google's stated tilt and roll turn the panorama is not documented, so each sign is tried and the one that matches the Static views best is kept; a view is used only where it holds its Static view's framing. On `3yGYmP` the level views matched at 0.95-0.97 edge correlation with no shift (floor 0.71). v7: 30 of 30 views from the tiles.
- **Removal at 2K** on level views only (a straight-down view is not sent: the model redraws it). v7: 24 of 24 edits held (0.64-0.95, no shift).
- **Leftover check:** in v7 it did not run (the first version called a detector that needs a gcloud login this machine does not have, and every view's note says "not checked"). It now asks a vision model (`gemini-3.8-flash`) through the app's own Google credentials; on derived renders from camera A it counts 11 in v5 and 0 in v7. The second pass has therefore not yet been exercised in a build.
- **No thinning:** budget 10 M. v7: 9,427,756 predicted, 803,165 outside their cell, 0 thinned, 8,589,902 street splats, 10,958,745 in the world (v6: 7,918,607).
- **Proof sheet:** `docs/screenshots/da3_rig_registration_2026-11-08/sharp_fidelity.png` (v6, v7, and v7 with the in-between view below).

### One generated in-between view (trial, 2026-11-10)

Status: trial only (`~/.cache/scratchbox-sharp-trial/joint/between.ts`); not adopted as tried. A virtual camera halfway between `3yGYmP` and `XBym1B` (10.4 m apart): v7 rendered from it in five views, each repainted by the image model at 2K, SHARP on the repaints, merged with the five real panoramas by hard cells (1,156,193 splats in the new cell).

- All five repaints held their render's framing (0.25-0.98). That is the weakness: the model sharpened the render's edges and kept its smears, stretched patches and holes where they were, so the new cell carries the old defects at a new position.
- From the proof cameras the merge is nearly indistinguishable from v7 beside the new view, and adds a floating patch on the road in camera A.
- To help, the in-between view would have to bring content the render does not have: the two neighbours' real views as references, or a prompt and check that reward repair over fidelity to the render.

### Depth Anything 3 as the street depth reference (v8, 2026-11-11)

Status: built through the app's chat (v8, world cache off, fresh folder), once the machine's load was below 100. Two earlier v8 attempts stopped: one from the page a minute in, one by the chat's 15-minute no-progress stop at a load of about 340.

- **Depth Anything 3 ran** (a new environment, `~/.cache/scratchbox-da3/venv`, Python 3.12, installed with `--no-deps` plus its working dependencies and `addict`): every level view of every panorama used `photo depth`, scaled by the scan where it agrees. Median residual to the scan 0.05-0.26 m, 75-100 % of each kept view within 10 %. `FS1Y4T` is still left out (fits 0.02-0.09).
- **The second removal pass ran:** 18 of 24 kept level views were edited twice. After it the vision model still counts 0 in 12 views and 1-3 in the other 12.
- v8: 9,279,865 predicted, 763,540 outside their cell, 0 thinned, 8,461,138 street splats, 10,514,761 in the world.
- **Reading** (against v7, the scan reference, same cameras; an independent visual check): v7 reads slightly cleaner in three of four cameras. v8 shows a floating mast fragment beside the signal (A), a blown-out slab where v7 shows a brick facade (B) and a torn hole in the road (D); in C it adds sidewalk planters and trees and is roughly even. Crosswalks are equally sharp. Depth Anything 3 as the reference is therefore not an improvement here.
- **Decision (user, 2026-11-12):** the scan is the default reference; `SCRATCHBOX_STREET_SHARP_DEPTH=photo` turns Depth Anything 3 on.
- **Proof sheet:** `docs/screenshots/da3_rig_registration_2026-11-08/sharp_da3_reference.png`.

## Still open

1. The edge score used here (median distance from scan edges to photo edges) is too loose to judge a pose: it improved under the implausible forced move. The judge's registration or the research report's render-and-match is the measure to use.
2. Pano `iUK9l3Uh` is stated 5 m higher than its neighbours (5.1 m above the nearest scan surface): its stated elevation looks wrong, independently of this test.

## Candidate tool/service ideas

- A `streetview_register_drive` tool over `registerRigOnScan` once a depth model passes the consensus on real data.
- Drive membership from Street View's link graph (Map Tiles `streetview/metadata`) as a check on the drive fit: panoramas of one drive should lie on a smooth path along their headings.
