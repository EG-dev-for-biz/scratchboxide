# Process: Longer near-mid and mid tree bands, checked in the live app

> **Recorded:** 2026-10-19
> **Status:** Verified (mid-distance trees read better; the cost is GPU time and a budget that now binds in every view)
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `viewport-cost`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **Change under test:** commit a3961f32, `PlantParams` in `scratchbox_tile_vegetation.hpp`:
  * near-mid now lasts to `lodNearMidPerHeight` 6 × tree height, within [25, 100] m (was 3 × within [25, 60]);
  * mid now lasts to `lodFarPerHeight` 8 × height, within [60, 140] m (was 4 ×).
* **No code was changed in this session.** Only this doc and its README row are committed.
* **Instance:**
  * worktree `.claude/worktrees/tree-bands-live` (branch `tree-bands-live` from origin/main a3961f32);
  * web 3461, API 3462, tools 3463, PNG/video receiver 3464;
  * `npm run dev`, opened with `?sbViewportCost=1`;
  * browser viewport emulated at 1600 × 1000, so the canvas drawing buffer is 969 × 943 in both sessions;
  * every process was stopped by PID afterwards.
* **Scene:** the prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees` (591 trees, four levels, `trees-lod/3`).
  * The staged cache came from the `tree-density` worktree, so tiles (`150c191d`), remesh and grammar were cache hits.
  * The trees were rebuilt by the new binary: strip `99ad58bb`, plant `a06891f4`.

### Two builds from one input

* **New bands (after):** the in-app run, trees cache key `a06891f4`.
* **Old bands (before):** `TileVegetationService.plant` with the same inputs plus `params: { lodNearMidPerHeight: 3, lodNearMidMax: 60, lodFarPerHeight: 4 }`. That gave key `5b69a0f0`.
  * The same inputs are crowns `99ad58bb…/crowns.json`, `sceneTriangleCap` 1.5 M, seed = the first 16 hex digits of sha256(tiles textured GLB), and ground mesh = the remesh.
  * A control call without `params` returned the app's own key `a06891f4` as a cache hit. That proves the inputs are identical.
* **Only the bands differ:**

  | Check | Result |
  |---|---|
  | BIN chunk | byte-identical (sha256 `7b2b2d977b5d…` in both) |
  | JSON outside `sbLod` and the stage key | no differences |
  | trees GLB size before → after | 73,578,408 B → 73,578,736 B (+328 B) |

* **How each build reached the viewport:** the served file `public/models/washington_square_arch_trees_a06891f4.glb` was swapped between the two builds, then the page was reloaded. Before each session, `controller.trees[*].bands` was checked: near-mid `maxDistM` was at most 66 in the old build and at most 110 in the new one. The served file was restored to the new build at the end.

## 2. Baked band edges (591 trees)

Each handover centre is the midpoint of `maxDistM` of level *i* and `minDistM` of level *i*+1, in metres.

| Handover | Old: min / p25 / median / p75 / max | New: min / p25 / median / p75 / max |
|---|---|---|
| near → near-mid | 12.0 / 12.0 / 15.1 / 20.0 / 30.0 | unchanged |
| near-mid → mid | 25.0 / 29.9 / 45.3 / 60.0 / 60.0 (105 trees at 25, 149 at 60) | 25.0 / 59.7 / 90.6 / 100.0 / 100.0 (20 at 25, **248 at the 100 cap**) |
| mid → far | 60.0 / 60.0 / 60.4 / 80.0 / 140.0 (**293 at the 60 floor**) | 60.0 / 79.6 / 120.8 / 140.0 / 140.0 (89 at 60, **222 at the 140 cap**) |

The two levels now spread across their whole ranges. Before, half the trees sat on the 60 m floor of mid → far. Now the caps (100 and 140 m) bind for 40 % of the trees.

## 3. Live results

### How the numbers were taken

* **Same cameras in both sessions** (`__SB_SET_CAMERA_VIEW__`, lens via `__SB_VIEWPORT_COST__.setLens`, full frame):
  * **elevated:** 220 m out and 100 m up from the arch, looking at the arch (0, 10, 0), θ −0.25;
  * **street:** eye at 2.5 m (1.7 m above the ground at about 0.8 m), 100 m south-southwest of the arch, looking at it.
* **Settling:** the levels were read once the stats stayed unchanged for 2 s.
* **Triangle counts:**
  * per-level triangles come from the probe's `breakdown()` (main pass);
  * tree triangles are `TreeLodStats.estimatedTriangles`;
  * the budget line is the stats overlay's.
* **GPU time:** `EXT_disjoint_timer_query_webgl2`, whole frame. Each value is the mean of four 30-frame runs: one in the capture pass, three in a later round. The runs went in the order after → before → after, so drift would show up; the two after sessions agree.

| View | Build | Levels near / near-mid / mid / far (+ in dissolve) | Tree triangles | Per level 0 / 1 / 2 / 3 (M) | Budget line | Budget-demoted | GPU ms mean (range) | GPU ms, trees hidden |
|---|---|---|---|---|---|---|---|---|
| elevated 24 mm | before | 0 / 0 / 4 / 377 (+3) | 1.55 M | 0 / 0 / 1.11 / 0.43 | scene 791.9k + shadow 0 + trees 1.55M (may use 7.21M) | 0 | 6.3 (6.0–6.4) | 1.2 |
| | after | 0 / 6 / 13 / 338 (+27) | **7.15 M** | 0 / 3.49 / 3.26 / 0.39 | trees 7.15M (may use 7.21M): **binding** | 15–23 | **12.8 (11.0–16.7)** | 1.1 |
| elevated 85 mm | before | 0 / 16 / 6 / 50 (+6) | 7.07 M | 1.49 / 3.84 / 0.91 / 0.03 | trees 7.07M: binding | 34 | 7.4 (6.5–8.3) | 0.8 |
| | after | 0 / 5 / 41 / 28 (+4) | 7.09 M | 1.49 / 1.54 / 2.66 / 0.01 | trees 7.09M: binding | 59 | 8.4 (7.7–8.8) | 0.8 |
| street 24 mm | before | 2 / 17 / 10 / 178 (+4) | 5.60 M | 0 / 2.41 / 0.91 / 0.15 | trees 5.60M | 32 | 6.4 (6.1–6.6) | 0.8 |
| | after | 2 / 9 / 44 / 152 (+4) | 6.50 M | 0 / 1.22 / 2.99 / 0.12 | trees 6.50M | 57–58 | 7.3 (6.2–8.5) | 0.9 |
| street 85 mm | before | 2 / 15 / 22 / 39 (+1) | 5.76 M | 0 / 0.90 / 1.35 / 0.02 | trees 5.76M | 59 | 4.5 (4.2–4.8) | 0.8 |
| | after | 2 / 15 / 40 / 20 (+2) | 6.54 M | 0 / 0.90 / 2.04 / 0.01 | trees 6.54M | 64 | 5.4 (5.1–5.9) | 0.8 |

All views have scene 791.9k and shadow 0. The budget is 8.00 M, which leaves 7.21 M for the trees.

* **"Budget-demoted"** is the overlay's count.
* **Below the line:** the street views show demotions even though the tree estimate is 0.7–1.6 M under the line. This happens in both builds, as `viewport_cheap_steps.md` §2 also saw.
  * In both builds, `explain()` shows trees under 40 m budget-demoted at street level: 10 before and 11 after at 24 mm, 5 and 5 at 85 mm.
  * Some are within 2–5 m of the camera, held at near-mid instead of near.
  * This is not new with the bands, but it is the most visible coarse-leaf effect at street level.
* **Raw data:** in `test-results/screenshots/tree_lod_bands/`, as `{before,after}_<view>.json`, `{before,after}_gpu_rounds.json` and `{before,after}_demoted.json` (the per-tree list of budget demotions).

### Stats from the trees build (`stats.lodFrames`, metre bands, 2,448 grid poses at an 80° view, no budget)

| Statistic | Before | After |
|---|---|---|
| median | 0.68 M | 1.66 M |
| p95 | 5.88 M | **10.51 M** |
| max | 10.76 M | **16.66 M** |
| worst trees per level | 6 / 17 / 17 / 141 | 8 / 35 / 30 / 190 |

`SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME` (10 M) is documented as "at most this many in a park view".
* The old bands already broke it at the max.
* The new bands break it at p95 too.
* The viewport's 8 M budget holds the real frame, so nothing breaks. The constant's comment, and the `location-clay-pipeline` test that checks it (on a 3-tree fixture), no longer describe a real park.

## 4. Visual read (honest)

Screenshots are in `test-results/screenshots/tree_lod_bands/`, which is gitignored.

* **Elevated 24 mm: clearly better.**
  * Files: `sbs_before_after_elevated_24mm.png` and `crop_before_after_elevated_24mm_midright.png`.
  * Before, almost every crown in the park (377 of 384) was a far blob mass: lumpy balloons.
  * After, the trees in the foreground and to the right of the arch are leafy near-mid and mid crowns.
  * The left half of the park stays far. The tint (`*_tint.png`) shows this is the budget and foveal weighting at work: the tree triangles sit at 7.15 of 7.21 M.
  * Stippled dissolve dither is visible on several mid-distance crowns. The new near-mid → mid and mid → far fades are wider (20 % and 25 % of a distance up to 100 and 140 m, so up to 20 and 35 m), so more trees sit in a dissolve at any one time: 27 against 3.
  * The cost is real: about +5–6 ms of GPU time in this view, roughly double.
* **Street 24 mm: better in the distance, slightly coarser in parts of the foreground.**
  * Files: `crop_before_after_street_24mm_band.png` and `sbs_before_after_street_24mm_tint.png`.
  * The background row of far blobs on the left (60–120 m) turns into leafy mid crowns, the improvement this change was for.
  * A few near-mid trees on the right (30–60 m) drop to mid: near-mid went from 17 to 9 trees and budget demotions from 32 to 57. The extra mid trees behind now share the budget.
  * In the normal render, the right side looks about the same. The gain in the background is the larger visible change.
* **Elevated 85 mm: a trade, not a pure gain.**
  * Files: `sbs_before_after_elevated_85mm*.png`.
  * Both builds are at the budget.
  * After, the far blobs at the left edge become mid leaves.
  * 11 foreground trees go from near-mid to mid (near-mid 16 → 5, mid 6 → 41, demotions 34 → 59).
  * Normal render: no blobs left in frame, which reads better overall; the foreground canopy is a little less fine.
  * Two small trees in the centre of the frame stay far blobs in both builds. They have the lowest importance under the budget.
* **Street 85 mm: little visible difference.**
  * File: `sbs_before_after_street_85mm*.png`.
  * Near trees dominate the frame, and are the same in both builds.
  * A couple of trees in the far right background go from far to mid.
  * +0.9 ms.
* **Slow pan, street 24 mm, new bands.**
  * The camera turned 1 rad in place over 16 s, at 962 frames (median 17 ms per frame).
  * Files: `after_street24_pan.webm` and `after_street24_pan_tint.webm` (canvas recordings), `after_street24_pan_sheet.png`, `after_street24_pan_tint_sheet.png` and `after_street24_pan_dissolve_closeup.png`.
  * **0 pops:** no tree in view went straight from one whole level to another between two frames. 119–120 dissolves started and ran as crossfades.
  * Budget demotions ranged from 43 to 86 during the pan.
  * The tree estimate peaked at **7.41 M against the 7.21 M tree budget**, a 2.8 % transient overshoot (7.37 M in the untinted run).
  * Looking at the frames, nothing snapped. Dissolving crowns show the stipple pattern for the length of a fade.
* **Frame time.** It rose in every view:

  | View | GPU ms before → after |
  |---|---|
  | elevated 24 mm | 6.3 → 12.8 |
  | elevated 85 mm | 7.4 → 8.4 |
  | street 24 mm | 6.4 → 7.3 |
  | street 85 mm | 4.5 → 5.4 |

  The non-tree part of the frame is unchanged (0.8–1.2 ms with the trees hidden), so all of the increase is trees. On this M1 Ultra the elevated wide view still fits 60 fps with headroom.

## 5. What Broke / Didn't Work

* **Nothing broke.** No console errors, and both builds loaded and drew.
* **The budget now binds in every measured view**, and at the elevated wide view it decides which half of the park gets detail. The trees fill the band up to the budget, so the 8 M budget, not the bands, now decides what the camera sees.
* **`SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME`** (10 M) and its comment are stale for a real park (see §3).
* **Wider dissolves:** more trees sit in a dissolve at a still camera (27 against 3 at the elevated wide view). The stipple shows on those crowns.
* **Harness notes, not product issues:**
  * Calling `__SB_TREE_LOD__.update()` in a loop on top of the app's own frame loop made 15 edge trees flip between demoted and not demoted on every call. Driven by the app's loop alone, the state is stable, so the measurements above use only the app's loop.
  * Capturing a PNG every frame stretches a pan to 1 s per frame. The pan was therefore recorded with `canvas.captureStream` and `MediaRecorder` instead.
* **Layout:** reloading the app re-opened the left sidebar, which shrinks the canvas from 969 to 808 px wide. It was collapsed again before every capture, so all shots are 969 × 943.

## 6. Candidate Tool/Service Ideas

* **A plant option on the staged-location request** (`treeLod: { nearMidPerHeight, farPerHeight, … }`), so an A/B of tree bands is a second prompt run rather than a hand-run service call and a served-file swap.
* **A viewport recording endpoint**, or a `__SB_VIEWPORT_COST__.record(ms)` that returns a WebM through the API. This session hand-rolled `MediaRecorder` plus a local receiver.
* **A budget-state readout in the overlay** giving the first-pass (in-flight) total next to the settled estimate. That would explain why trees are budget-demoted while the estimate sits below the line.
* **`stats.lodFrames` checked against a real-park fixture**, with the 10 M constant revisited, or tied to the viewport's 8 M budget.

## 7. Reproduction Steps

1. Start the app from the worktree with free ports and `?sbViewportCost=1`, then stage the prompt above.
2. Build the old bands with `getTileVegetationService(root).plant({ crownsPath, sceneTriangleCap: 1_500_000, seed, groundMeshPath: <remesh glb>, params: { lodNearMidPerHeight: 3, lodNearMidMax: 60, lodFarPerHeight: 4 } })`, using the strip's crowns and seed. Run the same call without `params` and check it returns the app's trees cache key.
3. Copy that `trees.glb` over the served `public/models/<base>_trees_<key>.glb`, reload, and collapse the sidebar.
4. Place the camera with `__SB_SET_CAMERA_VIEW__(target, { theta, phi, distance })` and `__SB_VIEWPORT_COST__.setLens(24 | 85)`.
5. Turn on the tint and overlay with `__SB_SET_TREE_LOD__({ debugTint: true, statsOverlay: true })`.
6. Measure with `await __SB_VIEWPORT_COST__.measure({ frames: 30 })`.
