# Tree LOD: finished dissolves at a still camera, a budget that serves the nearest trees, a real-park ceiling, and a 14 M budget

> **Recorded:** 2026-10-19
> **Status:** Verified (tests; live app on Washington Square, M1 Ultra). One trade-off and one follow-up are open (§6).
> **Tags:** `operate-scratchbox` `tree-lod` `viewport-cost` `tile-vegetation`
> **Target Domain:** Generative Canvas / 3D Viewport
> **Follows:** [tree_lod_bands_live.md](./tree_lod_bands_live.md), [viewport_cheap_steps.md](./viewport_cheap_steps.md)

## 1. Session context

* Branch `tree-budget-tune` from origin/main 6002d7b4, worktree `.claude/worktrees/tree-budget-tune`.
* Live instance: web 3661, API 3662, tools 3663, frame receiver 3664, `npm run dev` with `?sbViewportCost=1`. The scene was the prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees` (591 trees, new bands, trees key `a06891f4`), served from the `tree-bands-live` staged cache (all cache hits). Every process was stopped by PID afterwards.
* Viewport 1600 × 1000 emulated, sidebar collapsed: drawing buffer 969 × 943 in every capture.
* Cameras: **elevated** = target (0, 10, 0), θ −0.25, 220 m out and 100 m up (camera (−54.4, 110, 213.2), the previous doc's); **street** = target (0, 10, 0), θ −0.2, eye at 2.5 m 100 m out. Lens via `__SB_VIEWPORT_COST__.setLens(24 | 85)`.
* **"Before"** is origin/main's `TreeLodController.ts` swapped into the same running app (reload), so both sides share the instance, cache and cameras.
* **Measurement notes (important):**
  * The Browser pane was hidden for the whole session, so the page's `requestAnimationFrame` was throttled or paused. GPU time was therefore measured on frames rendered back to back (`__SB_TREE_LOD__.update()` + `__SB_3D_RENDER_FRAME__()`, one `EXT_disjoint_timer_query_webgl2` query per frame, `gl.finish()`, 90 warm-up frames to bring the GPU clock up, 60 timed frames). rAF-paced numbers taken earlier in the session moved by up to 2× between identical runs (GPU clock drops between sparse frames) and are not used.
  * The pan (the previous doc's: camera turns 1 rad in place over 16 s, street 24 mm) is driven frame by frame the same way at ~60 frames of wall time a second (896–990 frames). A **pop** is a tree in view wholly at one level in one frame and wholly at another the next; a **dissolve start** is whole → shared.
  * The budget sweep ran 3 interleaved rounds (budgets 8, 10, 12, 14 M; order reversed on the middle round).
* Raw JSON and frames: `test-results/screenshots/tree_budget_tune/` (git-ignored): `{before,after8M,b10M,b12M,b14M}_<view>_<lens>.{json,png}`, `*_tint.png`, `sweep.json`, `*_pan.json`, `adaptive_live*.json`, `park_lodframes.json`; side-by-sides `sbs_before_after8M_after14M_<view>[_tint].png`, `sbs_budgets_8_10_12_14M_<view>[_tint].png`, `crop_stipple_before_after_elevated_24mm.png`. Development iterations are in `dev_iterations/`.

## 2. Task 1: crowns stuck mid-dissolve at a still camera

**Cause.** `targetEdges(d)` is continuous in distance by design, so a tree whose (filtered) distance sits inside a band overlap shares the hash between two levels for as long as it stays there. The new near-mid → mid and mid → far fades are up to 20 and 35 m wide, so many trees sit in one at any camera.

**Fix** (`TreeLodController`):
* Still camera: the camera's world matrix, projection and frame height have not changed (1 mm, about 0.0006°) for `settleAfterStillSeconds` (0.5 s; 0 turns it off).
* Then every tree crossfades (the usual rate, `fadeSeconds` 0.35 s for a whole level) to its **dominant level** and holds it.
* While the camera moves, a held level is kept until its own share of the distance crossfade drops below `settleReleaseShare` (0.25): a dead band, so a nudge does not dissolve trees back and forth.
* When the camera comes to rest again, a held level that is no longer dominant (by more than a near tie, 0.4 share) gives way, so a camera jump does not leave trees at the old view's level.
* Overlay: `still: settled N`.
* Native fade shares were left as they are: narrowing them would make moving dissolves shorter in distance and needs a trees rebuild; settling removes the still-frame stipple without either.

**Evidence** (fading crowns once the view has settled, same instance):

| View | Before | After (8 M) |
|---|---|---|
| elevated 24 mm | **28** | **0** |
| elevated 85 mm | 4 | 0 |
| street 24 mm | 4 | 0 |
| street 85 mm | 0 | 0 |

* `crop_stipple_before_after_elevated_24mm.png`: the right of the park, before with half-blob, half-leaf stippled crowns, after clean crowns.
* Pan: **0 pops** before and after (every dissolve a crossfade). Settling does not act while the camera moves.

**Tests** (`tree-lod-settle-budget.test.ts`): settles after 0.5 s within one fade, never faster than the crossfade rate; no redraw over 5 s; holds through a shake inside the dead band; a slow dolly through the overlap leaves the held level without a pop and reaches near; re-checks a level held through a camera jump at rest; `settleAfterStillSeconds: 0` keeps the old behaviour; a grove of 24 trees in overlaps ends with no dissolve, each at its dominant level. Three older controller tests that check the continuous crossfade at a still camera now pass `settleAfterStillSeconds: 0`; the headless handover shot creeps the camera 1 cm a frame so it is not at rest.

## 3. Task 2: near trees held back with budget to spare

**Cause** (confirmed live with `explain()` and per-tree level costs, street 24 mm, before):
* The first budget pass judged each demotion by **this frame's in-flight cost**. A pending promotion counted both levels (current + finer), and a settled tree's demotion looked like a loss (the dissolve draws both levels), so `gain <= 0` skipped it.
* So when over the line, the pass walked past every settled, less important tree and blocked the **pending promotions** instead, most important included. Once that fit, the second (destination) pass never ran.
* Example: tree 511, 2.4 m away, 14 m tall, importance 5,377 (the highest in view), near level 2.44 M, near-mid 0.73 M. Its promotion counted +2.44 M against 0.34 M of slack, so it was held at near-mid while trees of importance 99–500 kept near-mid and mid levels.
* Before, 11 of 13 trees within 40 m were budget-demoted at street 24 mm, and **56 demoted trees' next level up would have fitted** in the 0.57 M left unused (62 trees and 0.55 M at street 85 mm).
* Hysteresis and the shared-budget scene share were not the cause (the scene share is a constant 0.79 M here).

**Fix:** the budget fits **destinations**, starting from where each tree was held last frame, and changes only what it must:
1. Over the budget: the least important trees give up a level a pass (near → near-mid → mid → far).
2. Room under the budget less a 2 % release margin: held trees take levels back, most important first, wherever a level still fits (the last demotion of a pass can free far more than was missing).
3. Order: a held tree more than 10 % more important than a tree keeping a finer level takes a level from the least important such trees when that fits under the margin.
* Hysteresis: the margin and a 10 % stickiness for trees left whole last frame. At a still camera the fit is the same every frame, and a jittering scene share settles after at most one demotion.
* In flight: dissolves draw both levels. When that exceeds the budget by more than `inFlightOvershoot` (10 %), the least important **promotions** wait to start (demotions never wait). With no dissolve running, the most important one always starts.
* `demotedTrees` now counts trees, not demotion steps. Overlay: `(waiting N)`.

**Evidence** (same instance and cameras; GPU from back-to-back frames, two rounds):

| View | Levels n / nm / mid / far, before → after 8 M | Budget-demoted | Trees < 40 m demoted | Demoted trees whose next level fitted the unused budget | GPU ms before → after |
|---|---|---|---|---|---|
| elevated 24 mm | 0/6/11/339 (+28 fading) → 0/10/29/345 | 15 → 0 | – | 13 → 0 | 8.8 → 7.4 |
| elevated 85 mm | 0/5/41/28 → 0/30/6/42 | 59 → 34 | – | 0 → 0 | 6.7 → 5.1 |
| street 24 mm | 2/9/44/152 → 6/15/2/188 | 58 → 45 | **11/13 → 2/13** | **56 (0.57 M) → 0** | 6.9 → 3.2 |
| street 85 mm | 2/16/40/21 → 6/2/7/64 | 66 → 58 | 5/7 → 2/7 | 62 (0.55 M) → 0 | 4.2 → 2.2 |

* Tree 511 (2.4 m) now reaches near, and no tree within 12 m is budget-demoted. One at 8.8 m stays near-mid by its own band, because it sits at the frame edge (foveal weight 0.58).
* The two trees under 40 m still held at street 24 mm are at 25 and 35 m with importance below the trees that keep detail. Their next level does not fit.
* **The trade-off at 8 M is visible.**
  * The six near trees' near levels cost about 5 M of the 7.2 M the trees may use.
  * So at street level the mid-distance trees go to far blobs: `sbs_before_after8M_after14M_street_24mm[_tint].png`, middle panel, red background.
  * Before, the in-flight bug was in effect giving that budget to the mid trees by holding the nearest ones back.
  * This is what "most important first" asks for. At 14 M (task 4) the background stays leafy and the near trees keep near (right panel).
* Elevated 24 mm needs only 5.85 M once settled (dominant levels instead of two levels drawn per stippled crown), so the budget no longer binds there.

**Pan, street 24 mm, 8 M:**

| | Before | After |
|---|---|---|
| pops | 0 | **0** |
| dissolve starts | 201 | 183 |
| trees with ≥ 3 starts | 16 | 20 |
| mean crowns fading per frame | 9.0 | 5.2 |
| GPU ms mean / p95 / max | 6.7 / 8.7 / 14.8 | 3.5 / 5.7 / 7.4 |
| peak tree triangles in flight | 7.66 M (+6 % over the trees' budget) | 10.1 M (**+41 %**) |

* The in-flight peak is higher: demotions start at once and a demoting near tree draws both of its levels for 0.35 s.
* GPU time stayed lower throughout the pan (max 7.4 ms), so the peak is a triangle count, not a frame-time spike, on this GPU.

**Tests** (`tree-lod-settle-budget.test.ts`, contract fixture):
* A near tree whose promotion fits the destination but not the in-flight cost reaches near. Origin/main keeps it at near-mid: the test was run against the old controller and fails.
* When room is short, the least important give up levels first, and everything comes back when the room returns.
* A 40-tree grove under 60 % of what it wants:
  * destinations within the budget and the room filled;
  * in-flight peak within budget × 1.1 + one dissolve;
  * a held tree outranks a keeper only when its next level fits neither the free room nor that keeper's level;
  * no redraw over 5 s.
* A reserved share jittering ±0.5 % settles after at most one demotion, then no tree moves.
* `tree-lod-shared-budget.test.ts` (focus tree never demoted, the shared split) passes unchanged.

## 4. Task 3: `SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME`

* It was 10 M, documented as "at most this many in a park view". The trees build's own `stats.lodFrames` (metre bands, no budget, 80° view on a pose grid) gives p95 10.5 M and max 16.7 M for Washington Square with the new bands.
* Its only test checked it on a 3-tree fixture, which draws a few thousand triangles and could never catch anything.
* Now: **20 M**, documented as a ceiling on the **unbudgeted** estimate (a level that grows or a band that reaches farther shows up here). The viewport's budget (`DEFAULT_TREE_TRIANGLE_BUDGET`) caps actual frames.
* New test in `location-clay-pipeline.test.ts`:
  * plants a synthetic 372-tree park (jittered 12.5 m grid over 250 × 250 m, 9–24 m tall) under `SCENE_TREE_TRIANGLE_CAP`;
  * measured: median 9.8 M, p95 12.9 M, max 14.4 M (`park_lodframes.json`);
  * checks it is park-scale (max > 0.8 × the viewport budget, p95 > half the ceiling) and under the ceiling;
  * checks that **the same park with both bands twice as long (max 44 M) breaks it**, so the check is live;
  * about 24 s.
* Pre-existing, not touched: the first test in that file (`measures the trees, remeshes …`) fails on origin/main too, at line 109 (`expected 2653 to be 4785`, written triangles vs the per-tree wood + foliage sum). So its old `drawnPerFrame` assertion was not being reached anyway.

## 5. Task 4: the budget

**Sweep** (new controller, Washington Square, GPU ms from back-to-back frames, 3 interleaved rounds):

| Budget | View | GPU ms mean (3 rounds) | p95 (worst round) | Tree triangles | Levels n/nm/mid/far | Budget-demoted |
|---|---|---|---|---|---|---|
| **8 M** | elevated 24 mm | 8.5 / 8.1 / 7.9 | 15.4 | 7.00 M | 0/11/35/338 | 0 |
| | elevated 85 mm | 4.9 / 4.8 / 4.8 | 7.4 | 7.12 M | 0/30/6/42 | 34 |
| | street 24 mm | 3.1 / 3.4 / 3.4 | 3.9 | 7.06 M | 6/15/2/188 | 45 |
| | street 85 mm | 2.3 / 2.3 / 2.3 | 2.7 | 7.15 M | 6/2/7/64 | 58 |
| **10 M** | elevated 24 mm | 8.8 / 8.6 / 8.2 | 11.1 | 6.98 M | 0/11/35/338 | 0 |
| | elevated 85 mm | 4.8 / 4.8 / 4.6 | 6.7 | 9.11 M | 0/43/2/33 | 22 |
| | street 24 mm | 4.2 / 4.2 / 4.4 | 5.3 | 9.02 M | 6/22/2/181 | 38 |
| | street 85 mm | 2.5 / 2.5 / 2.5 | 2.9 | 9.13 M | 10/2/3/64 | 56 |
| **12 M** | elevated 24 mm | 8.7 / 8.7 / 8.6 | 12.0 | 6.98 M | 0/11/35/338 | 0 |
| | elevated 85 mm | 5.5 / 5.7 / 5.2 | 8.0 | 10.00 M | 0/45/21/12 | 0 |
| | street 24 mm | 5.2 / 5.0 / 5.1 | 7.1 | 10.98 M | 6/34/4/167 | 26 |
| | street 85 mm | 3.2 / 3.2 / 3.3 | 3.9 | 11.21 M | 13/5/1/60 | 49 |
| **14 M** | elevated 24 mm | 8.8 / 9.1 / 8.7 | 12.7 | 6.98 M | 0/11/35/338 | 0 |
| | elevated 85 mm | 5.6 / 5.3 / 4.8 | 8.2 | 10.00 M | 0/45/21/12 | 0 |
| | street 24 mm | 5.5 / 5.7 / 5.9 | 8.2 | 13.19 M | 6/46/4/155 | 11 |
| | street 85 mm | 3.9 / 4.1 / 4.2 | 5.3 | 13.18 M | 14/14/0/51 | 38 |

* Pan, street 24 mm:

  | Budget | GPU ms mean / p95 / max | Pops | Starts | Mean fading | Peak tri |
  |---|---|---|---|---|---|
  | 8 M | 3.6 / 5.7 / 9.9 | 0 | 189 | 5.1 | 10.2 M |
  | 10 M | 5.1 / 6.7 / 9.9 | 0 | 289 | 6.9 | 11.7 M |
  | 12 M | 6.2 / 8.1 / 12.2 | 0 | 264 | 7.5 | 14.1 M |
  | 14 M | 6.8 / 8.5 / 11.8 | 0 | 317 | 10.0 | 15.7 M |

* Memory does not change with the budget: every level is resident (geometry 212.7 MB in every capture), and JS heap 418–495 MB with no trend.
* The worst view is elevated 24 mm at every budget, near 9 ms, because it does not reach even 8 M once settled. The budget moves the street views from 3–5 to 4–6 ms.
* The single 15.4 ms p95 is one round at 8 M; the other rounds' p95 at that view is 11–13 ms.
* **Chosen: 14 M** (`DEFAULT_TREE_TRIANGLE_BUDGET` in `common/spatial/tree-lod-math.ts`, the controller's default).
  * The worst view's mean is about 9 ms, p95 12.7 ms and pan max 11.8 ms, all inside the ~14 ms aim and well under 16.7 ms on this M1 Ultra.
  * It is the budget at which the street views keep leafy mid-distance crowns while the near trees keep near (`sbs_budgets_8_10_12_14M_street_24mm_tint.png`, `sbs_before_after8M_after14M_*`).
  * 16 M was not measured.
* `tree-lod-viewport.test.ts` (1,000-tree headless grove) now checks against the default budget: estimate median ≤ budget × 1.1 (destinations fit; dissolves in flight add up to 10 %) and drawn max ≤ budget × 1.25. The dense grove's estimate median is 15.2 M at 14 M.

**Weaker GPUs: the budget adapts to measured frame time** (`treeLod/adaptiveTreeBudget.ts`, on by default, off with `?sbAdaptiveTreeBudget=0` or `localStorage['sb.adaptiveTreeBudget']='0'`):
* The viewport times every frame it draws while there are trees with one `EXT_disjoint_timer_query_webgl2` query (at most 4 in flight, read back a few frames later, disjoint results dropped).
* `AdaptiveTreeBudget` smooths the times (EMA 0.1):
  * over **14 ms** for 1 s: the budget scale drops ×0.85, then again each further second over, down to 0.25;
  * under 10 ms for 4 s: it rises ×1.08 up to 1;
  * in between nothing moves.
* Without the extension nothing is measured and the scale stays 1.
* The controller fits to `triangleBudget × TreeLodFrame.budgetScale`. Overlay: `budget 8.60M (GPU-adapted x0.61) = …`.
* `localStorage['sb.adaptiveTreeBudgetTargetMs']` overrides the target, for tuning.
* **Live:**
  * with the target forced to 4 ms, street 24 mm: the scale fell to 0.61 (14 M → 8.6 M) and held with the smoothed GPU time at 3.3 ms (`adaptive_live.json`, `adaptive_live_target4ms_street_24mm.png`);
  * with the default target: scale 1, smoothed 7.8 ms, 489 samples (`adaptive_live_default.json`).
* **Tests** (`tree-lod-adaptive-budget.test.ts`): steps down after a second over and not before, floor, slow raise, hold between the thresholds, a 10-frame hitch ignored, bad samples ignored; the frame timer with a fake GL (lag, order, disjoint dropped, at most N in flight, no extension); the controller fits a 0.5 scale and the levels come back at 1.

## 6. What is open

* **8 M at street level** puts the mid-distance trees to far blobs, because the near trees now get their near levels. The 14 M default resolves it on this GPU. On a GPU the adaptive budget pulls down to about 8 M, the same trade returns.
  * A cost-aware importance (detail per triangle, e.g. dampening a near level that costs a third of the budget for a tree at the frame edge) would be the next step.
  * Not done: the brief asked for importance order.
* **In-flight peak during the pan** is +40 % over the trees' budget for a few frames when near trees demote (both levels drawn for 0.35 s), against +6 % before. GPU time stayed low here.
  * A shorter fade for budget demotions would shorten it, if a weaker GPU shows a spike.
* **Churn while turning:** 20 of about 210 trees started three or more dissolves during the 16 s pan (16 before), as the foveal weight re-ranks trees crossing the frame. No pops.
* Pre-existing `location-clay-pipeline` failure (§4), not from this branch.

## 7. Results

* `npm run typecheck`: exit 0.
* `npm run lint`: 0 errors (2,672 warnings, none new in the changed files).
* `npm run lint:primitives`: passed.
* Via `guarded-vitest.sh` (no billed calls):
  * all `tree-lod-*` suites incl. the headless viewport (9 files, 89 tests), `photo-match-eval-trees`;
  * `staged-build-*`, `staged-layer-eviction`, `staged-merged-parts`, `scene3d-*`, `viewport-*` (33 files, 259 passed, 1 skipped as before);
  * `location-clay-pipeline` park case passes; the file's first case fails on origin/main too.

## 8. Candidate tool/service ideas

* A `__SB_VIEWPORT_COST__.measureHot()` (back-to-back frames with a warm-up) in the probe itself. rAF-paced `measure()` moves up to 2× when the page is hidden or the GPU clock drops.
* A per-tree "dissolve starts" counter in `TreeLodStats` for pan QA (this session counted it from page JavaScript).
* A scripted camera path API (`__SB_CAMERA_PATH__`) that drives frames itself, so pans and flights are measurable in a hidden pane.

## 9. Reproduction

1. Stage the prompt with the cache from `tree-bands-live`, open with `?sbViewportCost=1`, collapse the sidebar (969 × 943).
2. `localStorage['sb.adaptiveTreeBudget']='0'` for budget comparisons. `__SB_SET_TREE_LOD__({ statsOverlay: true, triangleBudget })` sets a budget, and `debugTint: true` tints.
3. Set the camera with `__SB_SET_CAMERA_VIEW__` (the values in §1), settle 2 s, and read `__SB_TREE_LOD__.controllers()[0].stats` / `.explain(i)`.
4. For GPU time, render frames back to back with a timer query around `__SB_3D_RENDER_FRAME__()` after a 90-frame warm-up.
