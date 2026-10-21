# Tree LOD: high-quality distance extended, and depth-of-field focus-plane flicker fixed

> **Recorded:** 2026-10-21
> **Status:** Verified (the native triangle-ceiling measurement; unit tests with a reproduced-then-fixed regression). Not re-profiled live in the app for GPU frame time — that needs the full `operate-scratchbox` live-measurement pass this doc's own methodology (`tree_budget_tune.md`) used, not run this session.
> **Tags:** `tile-vegetation`, `tree-lod`, `viewport-cost`, `depth-of-field`
> **Follows:** [tree_lod_bands_live.md](./tree_lod_bands_live.md), [tree_budget_tune.md](./tree_budget_tune.md)

## 1. Request

The user asked for two things: (1) high-quality (near/near-mid) trees visible across more of a typical scene, not just close up, and (2) the flicker high-detail trees showed when the camera's depth-of-field focus was engaged.

## 2. High-quality distance: `scratchbox_tile_vegetation.hpp`'s `PlantParams`

**Before → after** (metres; each level's max is `clamp(perHeight × tree height, min, max)`):

| | perHeight | min | max |
|---|---|---|---|
| near (full detail, twigs + instanced leaf clusters) | 1.0 → 1.15 | 12 → 14 | 30 → 35 |
| near-mid (same wood/clusters, fewer larger leaves) | 6.0 → 6.5 | 25 → 30 | 100 → 120 |
| mid/far handover | 8.0 → 9.0 | 60 → 100 | 140 → 190 |
| `lodFadeM` | 6 → 7 | | |

**Why these numbers, not bigger ones.** `tree_lod_bands_live.md` and `tree_budget_tune.md` already measured that widening these bands costs real GPU time, and `tree_budget_tune.md` added `SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME = 20,000,000` specifically as an unbudgeted ceiling test to catch a band stretch before it ships ("a band that reaches farther shows up here"). A first attempt at this change (near-max 90 m, near-mid-max 220 m, far-max 320 m — roughly 3×) was checked against that live test (`location-clay-pipeline.test.ts`, "SCENE_TREE_DRAWN_TRIANGLES_PER_FRAME on a park", 372-tree synthetic Washington-Square-scale park, 576 camera poses) and **failed it**: max 21.48 M > the 20 M ceiling. A more conservative stretch was tried next and measured clean:

| | park median | p95 | max | ceiling |
|---|---|---|---|---|
| before (baseline bands) | 9.8 M | 12.9 M | 14.4 M | 20 M |
| after (this change) | 11.0 M | 14.9 M | 16.4 M | 20 M |
| rejected first attempt (~3×) | 13.1 M | 19.9 M | **21.5 M** | 20 M (broke it) |

The shipped numbers lean on the near-mid and mid (crown-card) levels — already much cheaper than near — to carry the extended range, and hold the true high-poly near level to a smaller stretch, so the park-scale max stays at 82 % of the ceiling (about the same headroom the original bands had, 72 %). `DEFAULT_TREE_TRIANGLE_BUDGET` (14 M, GPU-adaptive) is unchanged: it is the real per-frame draw cap and keeps demoting trees gracefully under load regardless of how far the authored bands reach, exactly as before.

**Not done, and why:** a live GPU frame-time profile (the `tree_budget_tune.md` methodology: real app, real camera positions, `EXT_disjoint_timer_query_webgl2`) was not run this session. The triangle-count ceiling is a real, already-measured proxy and the change passes it with similar headroom to the original bands, but if a future session wants to push further, re-run that live methodology first rather than assuming triangle count alone tells the whole story.

## 3. Depth-of-field focus flicker: `TreeLodController.ts`

**Cause.** A tree's depth-of-field blur demotion is suppressed ("focus-protected") while the camera's measured focus distance falls inside the tree's bounding sphere (`dof.focusM` between `zc - sphere.radius` and `zc + sphere.radius`). That membership test was a hard binary edge with **no hysteresis of its own** — unlike every other LOD decision in this file (distance, blur-level dead band), which are all hysteresed on purpose. Continuous autofocus (`viewportFocus.ts`) resamples a small depth-buffer grid every 100 ms and glides toward it; the resampled distance can step by centimetres even when nothing in the scene moved. A tree sitting right at its sphere's edge relative to the focus plane flipped `protectedByFocus` on exactly that kind of step, and the flip forced an **immediate, unhysteresed snap** of the tree's blur-demotion level (`t.blurLevels = Math.round(blurWant)`), popping it between full detail and a demoted level every time the boundary was crossed.

**Fix:** once a tree is focus-protected, the plane of focus must clear its sphere by a margin — not just reach the edge — before protection lifts (`Math.max(0.15 × sphere.radius, hysteresisM)`, the same floor already used for the controller's distance hysteresis). Entering protection is unchanged (still the exact sphere edge, so a genuine rack focus picks up a tree as soon as it reaches it); only leaving it is sticky. This is the same asymmetric-hysteresis pattern `hysteresisDistance`/`hysteresisDistanceRelative` already use elsewhere in this LOD system, applied to the one membership test that didn't have it.

**Verified:** a new regression test (`tree-lod-screen.test.ts`, "focus-plane protection does not flicker...") drives the measured focus distance back and forth 2 cm either side of a tree's sphere edge for 20 frames. Reverted to a `margin = 0` build, it flips 19 of 20 frames (confirmed, then reverted back); with the fix, zero flips, and a real sustained focus pull still correctly lifts protection. The existing depth-of-field demotion/rack-focus tests in the same file (which exercise the entering-protection edge directly) still pass unchanged.

## 4. Files changed

* `packages/core/src/native/3d-engine/include/scratchbox_tile_vegetation.hpp` — `PlantParams` LOD distance defaults.
* `packages/core/src/node/3d-engine/tile-vegetation-service.ts` — mirrored doc comment only (the TS `params` fields are overrides; unset, they fall through to the header defaults above).
* `packages/core/src/browser/generative-canvas/primitives/scene3d/treeLod/TreeLodController.ts` — focus-protection hysteresis margin.
* `packages/core/test/tree-lod-screen.test.ts` — new flicker regression test.
