# Process: Lobed crowns and a near-mid tree level

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `shading`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:**
  * At the staging view, crowns read as smooth balloons, because each one was shaded with a single ellipsoid.
  * Between full leaves (12–30 m) and the mid cards, trees jumped to coarse kite cards and then to solid masses.
* **Changes:**
  * **Crown lobes.** The native trees writer now groups each tree's leaf clusters into lobes. It writes them as `sbTree.crown.lobes` with `lobeBlendM`. The viewer shades leaves with the gradient of a smooth minimum of these spheres. When a crown has no lobes, it falls back to the ellipsoid.
  * **New near-mid level.** Trees now have four levels (`scratchbox.trees-lod/2`): near, near-mid, mid, far. Near-mid is the wood without twigs plus 35 % of each cluster's leaves, which keep the near outline and are scaled up to the near level's leaf area. Old three-level files (`trees-lod/1`) still load.
* **Instance used:** worktree `.claude/worktrees/tree-lod-step`, with web port `3241`, API port `3242` and tools port `3243`. The app was started with `npm run dev` and stopped by PID.
* **Scope tested:** the prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`.
  * **Before:** the trees came from the old binary (591 trees, three levels).
  * **After:** a second run of the same prompt with the new binary (591 trees, four levels). Every tree carries lobes: 1 lobe on 238 trees, 2–7 lobes on 202 trees, 8 lobes on 151 trees. 10,230 leaf meshes are shaded by lobes, and none fall back.

## 2. What Was Tested & What Worked (Verified)

Shots are rendered from the same camera through `__SB_SET_CAMERA_VIEW__`. Each frame runs `lod.update` and then `renderer.render`. The browser tab was in the background, so the frames were driven from the console. Screenshots are in `test-results/screenshots/tree_lod_step/` (gitignored).

* **Staging view (280 m), all trees far.**
  * `before_staging.png`: each crown is one balloon.
  * `after_staging.png`: crowns show their lobes as soft bulges.
* **Far blend.**
  * `farblend_1_mid.png` (blend 1.0): far blobs on the shadow side flatten into smooth patches.
  * `farblend_0.75_mid.png` (blend 0.75): each blob keeps its roundness.
  * The far default is now 0.75.
* **Intermediate view (about 65 m above the canopy).**
  * `before_inter2.png`: the mid-distance trees are bright, angular kite cards.
  * `after_inter2.png`: they are near-mid leaves with the leaf outline, darker toward each crown's core.
* **Mid view (110 m).**
  * `before_mid.png`: mid cards.
  * `after_mid.png`: near-mid trees in the foreground, lobed far masses behind.
* **Dolly** from 15 m to 260 m over 8 s, above the canopy, 60 frames per second. Frames are `after_above_dolly_{25,40,60,90,140,220}m.png`.
  * Dithered handovers are visible. No tree that stayed in view jumped a level (`levelPops` 0).
  * The largest per-frame change of a cut edge was 0.375. The rate limit allows 0.286, and the edge ordering can add to it when two neighbouring handovers move together.
  * Every dithering leaf mesh wore a crown variant.
* **Performance.** Each frame is `lod.update` + `render` + a 1-pixel readback, median of 60 frames, on a 2265×846 canvas. The GPU was shared with other sessions, so repeated runs vary by about ±2 ms.

  | View | Triangles before → after | Frame before → after (ms) |
  |---|---|---|
  | Staging, 280 m | 1,145,125 → 1,145,125 | 15.0 → 16.4–18.3 |
  | Mid, 110 m | 3,478,392 → 5,450,592 | 16.7 → 20.6–21.8 |
  | Intermediate, 65 m | 5,233,691 → 7,961,046 (5 trees held back by the 8 M budget) | 17.8 → 21.6 |

  In the same session, at the mid view: shading on 20.6 ms, lobes off 20.1 ms, shading off 19.2 ms. The extra time at mid comes from the near-mid triangles.
  * A first version looped over the lobes at every leaf vertex. It cost about 4 ms at the mid view.
  * Clusters now carry the field at their origin, computed once per instance on the CPU in the `sbCrownI` attribute. Only the far blob meshes loop, in one pass.

## 3. What Broke / Didn't Work

* **Leaf plates (fixed first, be44001e).** The crown normals made near leaves read as flat plates. See `tree_crown_normals_live.md` §6.
* **Mid to far handover.** It is unchanged at 60–140 m and is still the most visible step: leaves hand over to solid masses.
* **Shared browser pane.** The pane was shared with other sessions, so this tab stayed in the background. Every frame had to be driven by hand.

## 4. Candidate Tool/Service Ideas

* **`__SB_TREE_LOD__` debug hook:** get the controller, `forceLevel`, `setCrownShading` and stats without searching `__SB_3D_EXTERNAL_OBJECTS__`.
* **A capture helper that renders and saves a frame from a hidden tab:** this session hand-rolled one with `toDataURL` and a local receiver.

## 5. Reproduction Steps

1. Start the app from the worktree and stage the prompt above.
2. Get the controller: `const lod = [...__SB_3D_EXTERNAL_OBJECTS__.values()].find(m => m.userData.sbTreeLod && m.parent).userData.sbTreeLod`. `lod.levelsPerTree` is 4.
3. Compare settings with `lod.setCrownShading({ lobes: false })`, `lod.setCrownShading({ blend: [0, 0.45, 0.9, 1] })` and `lod.setCrownShading(null)` (the defaults).
4. Force a level with `lod.forceLevel(1)` to see the near-mid level everywhere, and with `lod.forceLevel(null)` to go back to distance-driven levels.
