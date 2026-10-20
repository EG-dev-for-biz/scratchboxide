# Process: Tree levels chosen by what the camera sees

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `camera` `depth-of-field`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:**
  * Tree levels were chosen by distance in metres only. A long lens showed distant trees as solid far masses, and a wide lens kept leaves on trees that were a few pixels tall.
  * The user asked for tree detail that emphasises the field of view: trees toward the centre of the view keep detail farther away than trees at the left and right edges.
  * Depth of field blurred trees whose leaves still cost full triangles.
* **Changes** (`treeLod/TreeLodController.ts`, `treeLod/treeLodMath.ts`, `viewportOptics.ts`, `Scene3DPrimitive.tsx`, `canvas-types.ts`):
  * **On-screen size.** A tree's distance is mapped to the reference-lens distance that gives the same projected height: `d_ref = r · tan(fov/2) / tan(fov_ref/2) · (H_ref/H)^e / w`. The file's metre bands (`lodBandsFor`) are read there, so they act as pixel thresholds at a 45° reference lens. With `w = 1` and the 45° lens, the levels are exactly the old ones (unit test). `explain(i).thresholdsPx` gives the thresholds per tree.
  * **Foveal weight `w`.** The weight falls off with the tree's distance from the view centre, normalised by the half field of view on each axis. It is an ellipse matching the frame's aspect, squashed toward horizontal bands by `verticalWeight` 0.5. The radius is measured to the nearest edge of the tree's projected sphere, so a big near tree that reaches toward the centre is not treated as an edge tree. With depth of field on, the centre follows the focus object. The weight changes the levels themselves, with or without budget pressure.
  * **Depth-of-field demotion.** The blur radius is computed with the same thin-lens circle of confusion the viewport draws (`circleOfConfusionPx`, imported, not copied), at the tree's depth nearest the plane of focus. Between `startPx` and `fullPx` it demotes the tree by up to `maxLevels`. The demotion is held at whole levels with a 0.15-level dead band, so a blurred tree does not dither between two levels forever. Changes of level go through the usual rate-limited crossfade. The focus object and any tree whose depth span contains the focus distance are never demoted.
  * **Budget by importance.** When over budget, the trees with the lowest importance give up levels first. Importance is the projected height × the foveal weight, read from the filtered distance so the order does not churn. Shadow-only trees go first, as before. The budget now counts what the crossfades in flight will draw this frame. Before this change, a moving dense grove overshot the 8 M budget by up to 7 %.
  * **Distortion overscan.** Trees in the widened render margin are no longer culled, because barrel distortion pulls that margin into the frame.
  * **Hysteresis.** The dead band is now `max(hysteresisM, 3 % of the distance)`, so it acts in log space and also absorbs small weight changes while the camera turns.
  * **Stats and debug.** `explain(i)` reports, per tree: range, size, projected px, foveal weight, importance, equivalent distance, thresholds, blur px, blur demotion (wanted and applied), focus protection, budget demotions and level. The stats add `blurDemotedTrees`, `focusProtectedTrees`, `fovealCentreNdc`, `frameHeightPx` and `fovDeg`.
    * `treeLod.statsOverlay` shows a 4-line stats box in the viewport.
    * `treeLod.debugTint` tints each level: near green, near-mid yellow, mid orange, far red.
    * The debug hooks are `__SB_TREE_LOD__` (controllers, last frame, one update) and `__SB_SET_TREE_LOD__(value)` (sets scene data `treeLod`, view-only).
  * **Scene data `treeLod`.** It holds the `screen`, `foveal` and `blur` parameter groups plus `triangleBudget`, `debugTint` and `statsOverlay`. Every parameter is continuous apart from the switches. `screen.enabled: false` gives the old metre bands for comparison.
* **Defaults:**
  * `screen`: `referenceFovDeg` 45, `referenceHeightPx` 1080, `resolutionExponent` 0 (the share of the frame height decides, so window size does not change levels), `hysteresisShare` 0.03.
  * `foveal`: `centreWeight` 2, `edgeWeight` 0.55, `centreRadius` 0.2, `edgeRadius` 1.0 (frame half-widths), `curve` 1, `verticalWeight` 0.5, `followFocus` true.
  * `blur`: `startPx` 1.5, `fullPx` 6, `maxLevels` 2, `levelHysteresis` 0.15.
  * `triangleBudget` stays at 8 M.
* **Instance used:** worktree `.claude/worktrees/tree-lod-screen`, web port 3291, API 3292, tools 3293, and a PNG receiver on 3294. The app was started with `npm run dev`, and all processes were stopped by PID. The canvas was 808×843 for most cases; the depth-of-field and rack-focus runs used 1527×872 after the pane was resized.
* **Scope tested:** the prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`. It gave 591 trees with four levels. This staged scene's camera is 60°, not the 45° default.

## 2. What Was Tested & What Worked (Verified)

Every frame is `__SB_TREE_LOD__.update()`, then the viewport's own frame draw, then a 1-pixel `readPixels`, timed as the median of 60 frames. "before" means metre bands with blur demotion off (`{ screen: { enabled: false }, blur: { enabled: false } }`); "after" means the defaults. Each case was measured twice, interleaved. Triangles are the controller's estimate (main pass plus shadow pass). Screenshots are in `test-results/screenshots/tree_lod_screen/` (gitignored).

| Case | Levels near / near-mid / mid / far before → after | Triangles before → after | Frame ms before → after |
|---|---|---|---|
| Elevated, 40 m up across the park toward the arch, 60° | 4/6/2/240 → 4/10/6/242 | 7.97 M → 7.96 M (both at the 8 M budget) | 18.2 / 33.2 → 18.1 / 34.1 (shared GPU; pairs agree) |
| Same pose, 24 mm (53.1°) | 4/6/0/204 → 4/16/4/200 | 7.99 M → 7.82 M | 16.9 / 16.6 → 16.8 / 16.9 |
| Same pose, 85 mm (16.1°) | 2/3/0/72 → 10/10/22/45 | 4.14 M → 7.81 M | 15.9 / 15.4 → 16.5 / 16.8 |
| Eye height 1.7 m across the park, 60° | 5/15/1/177 → 5/15/5/169 | 5.83 M → 6.10 M | 16.7 / 16.9 → 16.8 / 17.1 |
| 85 mm f/1.4 focused on a near tree (26 m), 1527×872 | before 8/11/0/38, screen without blur 8/26/14/19, after 7/27/9/25 (12 blur-demoted, 7 kept as in focus) | 6.64 M, 7.61 M, 7.14 M | 18–20, 18–19, 17.5–18.1 |

* **85 mm** (`lens85_before.png`, `lens85_after.png`, `lens85_after_tint.png`): before, the trees around the arch are lumpy far masses. After, they are leafy near-mid and mid trees. The budget is reached, and the edge trees give up first (45 budget demotions).
* **Elevated, user-like view** (`elevated_before_tint.png`, `elevated_after_tint.png`): after, the yellow near-mid trees reach farther in the centre band. The left and right edges and the far background stay red.
* **Slow pan** (`pan_elevated_tint.mp4`, `pan_series_sheet.png`): the camera turns 1 rad over 240 frames from the same elevated pose with the tint on. The detailed patch follows the centre of the view. Every per-frame edge change of a tree that was visible in both frames stayed within 1.16× of the rate limit measured from wall-clock time. The 16 % is the offset between the controller's clock read and the harness's. Nothing snapped. The per-update bound itself is asserted in the unit tests.
* **Rack focus** (`rack_focus_25m_to_150m.mp4`, `rack_series_sheet.png`): focus moved from 25.8 m to 150 m over 90 frames at 85 mm f/1.4. Blur-demoted trees went from 12 to 2. No tree changed by more than a crossfade step, and the levels were steady while focus was held.
* **Stats overlay** (`stats_overlay_viewport.jpg`): set through `__SB_SET_TREE_LOD__({ statsOverlay: true, debugTint: true })`. It shows trees seen, shadow-only and culled; levels; triangles plus shadow; budget-demoted, blur-demoted and in-focus counts; lens and frame; fovea; update time.
* **Unit tests:**
  * `tree-lod-screen.test.ts` (14 tests): thresholds equal the metre bands at 45°; 85 mm keeps the near level at 120 m and 14 mm drops to far; foveal levels with room in the budget; centre-weighted budget; culled and shadow-only trees stay minimal; overscan margin kept; blur demotion with the shared formula, the focus tree and the in-focus band protected; rack-focus crossfade bounded and tiling; pan crossfade.
  * The `tree-lod-*`, `tree-crown-*` and `viewport-lens-optics` suites pass (100 tests), with the 1,000-tree harness inside its triangle and frame targets.

## 3. What Broke / Didn't Work

* **This scene's 60° camera.** At the 45° reference lens, a 60° camera reads every tree 1.39× farther. With `centreWeight` 1, the elevated view lost detail everywhere compared with before. `centreWeight` 2 makes centre trees finer than before and edge trees coarser. Most park views here are budget-bound, so the change mostly moves triangles from the edges to the centre instead of adding them.
* **Depth-of-field demotion is conservative on this district.** Tree bounding spheres are large (11–20 m radius), and the blur is taken at the sphere's depth nearest the focus. Trees within a sphere radius of the plane of focus are kept. On this district only 12 trees were demoted at f/1.4 with focus at 26 m. At focus 50 m with 50 mm, the background blurs under 1 px, which is optically right, and nothing is demoted.
* **Harness artifact, not product:** calling `ViewportOpticsChain.configure` every frame resets `status.focusDistanceMeters` until the next draw. A first rack-focus run therefore alternated between frames with and without depth of field. Drawing once after each configure fixed the harness.
* **Fractional blur demotion dithered permanently.** The first version applied the continuous demotion, which left 11 trees fading at a held focus and drawing both levels. The whole-level hold with a dead band fixed it: 1 tree fading.
* **Stats overlay classes.** The Tailwind arbitrary classes (`bg-black/70`, `whitespace-pre`) did not apply in this build, so the box was transparent and on one line. It now uses inline styles.
* `public/glass_shatter_demo.html` appeared as an untracked file in the worktree while the app ran. It is not part of this change and was not committed.

## 4. Candidate Tool/Service Ideas

* **A viewport capture endpoint**, so a frame series or video saves to `test-results/` without a separate PNG receiver.
* **An agent tool for scene data `treeLod`** (or a field on an existing viewport operator), so the stats overlay and level tint can be switched from chat rather than through the debug hook.
* **Per-cluster bounds for the blur test.** Tight bounds would let the depth-of-field demotion act on the parts of large trees away from the plane of focus.

## 5. Reproduction Steps

1. Start the app from the worktree and stage the prompt above.
2. Run `__SB_SET_TREE_LOD__({ statsOverlay: true, debugTint: true })` to see the level pattern, and `__SB_SET_TREE_LOD__({ screen: { enabled: false } })` for the metre bands.
3. Read `__SB_TREE_LOD__.controllers()[0].explain(i)` for one tree's reasons.
4. Set the camera's FOV to 2·atan(12/f) for a full-frame lens of focal length f. For depth of field, run `__SB_3D_OPTICS__.configure({ focalLengthMm: 85, apertureFStop: 1.4, focusObjectId: '<tree node name>' })`.
