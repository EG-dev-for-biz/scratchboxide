# Process: Crown breakup for distant trees (holes, clumps, far-level limbs)

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `shading`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** at the staging view (about 280 m), the far tree crowns read as smooth white cotton balls.
* **Changes:**
  * **Holes and ragged silhouettes** (`treeLod/treeCrownShading.ts`, `CrownBreakupOptions`). The leaf and mass shaders discard fragments where a band-limited world-space value noise falls below a hole share. The share is weighted toward the crown's rim (from the crown field) and adds a few pockets. The noise has two octaves, at the clump scale and 2.7 times it. Each octave fades out as the pixel footprint reaches its period. Hole edges are dithered.
  * **The shadow pass draws holes too.** Leaf meshes with a crown get `customDepthMaterial` and `customDistanceMaterial`, which apply the same noise field (coarse octave and pockets). The field is sampled where each point's light ray crosses the plane through the crown's centre, so a hole runs through the whole crown. Without that, rim holes never reached the ground.
  * **Clump value.** Cellular noise at the clump scale makes clump tops brighter and the crevices between clumps darker. A lobe-scale noise and a per-tree value vary the grey. This multiplies the diffuse colour together with the occlusion, so it works in clay and textured modes.
  * **Far-level limbs** (native, `scratchbox_tree_lod.hpp` `farWoodBudgetFor`). The far level now carries its own wood: the trunk and main limbs, `clamp(24 x height, 160, 600)` triangles. It used to reuse the near level's whole wood. The schema is now `scratchbox.trees-lod/3`, and `trees-lod/2` and `/1` files still load. Triangle reports, `estimateLodFrames` and the budget accounting count the new far level.
  * **Toggle:** `lod.setCrownShading({ breakup: { enabled: false } })`, or the scene data field `treeCrownShading.breakup`. Every factor is continuous and live (shared uniforms).
* **Defaults** (slots: near, near-mid, mid, far):
  * Holes: `holes [0, 0, 0.5, 0.55]` and `pockets [0, 0, 0.18, 0.2]`.
  * Value: `clump [0, 0, 1, 1]` and `tone [0, 1, 1, 1]`.
  * Clump scale: `clumpPerCrownRadius 0.28` (within 0.8–1.5 m). `coarseOctave 2.7`.
  * Hole shape and filtering: `rimWidth 0.9` mean lobe radii, `edgeSoftness 0.05`, `filterStart 0.25` and `filterEnd 0.6` of the period.
  * Value amounts: `gapDarkening 0.55`, `clumpTop 0.2`, `clumpCrevice 0.22`, `lobeVariation 0.1`, `treeVariation 0.07`.
  * Shadows: `shadowHoles 1`.
* **Instance used:** worktree `.claude/worktrees/tree-breakup`, with web port 3261, API port 3262 and tools port 3263, plus a PNG receiver on 3264. The app was started with `npm run dev` and stopped by PID. The canvas was 1434×949.
* **Scope tested:** the prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`, which gave 591 trees.
  * **Before:** the native sources at 6ebb6a7d, giving a `trees-lod/2` file. It was rendered with the breakup off.
  * **After:** a `trees-lod/3` file.

## 2. What Was Tested & What Worked (Verified)

Screenshots are in `test-results/screenshots/tree_breakup/` (gitignored). Cameras were set with `__SB_SET_CAMERA_VIEW__` as (target, theta, phi, distance):

| View | Target | theta | phi | Distance |
|---|---|---|---|---|
| Staging | [0,0,0] | 0.6 | 0.85 | 330 |
| Intermediate, about 65 m | [-15,8,-20] | 0.6 | 1.2 | 70 |
| Mid, about 110 m | [0,6,0] | 0.6 | 1.12 | 125 |
| Ground, eye height 2.5 m, looking across the park | [5,3.2,115] | π+0.1 | acos(-0.7/85) | 85 |
| Sun-lit | [-20,2,40] | 2.4 | 0.95 | 75 |

The sun-lit view used a test directional light with a 4096² shadow map.

* **Staging** (`before_staging.png`, `after_staging.png`): the smooth balloons become clumped crowns with dark gaps and ragged edges.
* **Mid and intermediate** (`after_mid110.png`, `after_breakupoff_mid110.png`): the far masses now match the leafy near-mid trees in front of them much better.
* **Dappled shadows** (`after_sun_dappled.png` against `after_sun_solidshadow.png` and `before_sun.png`): light comes through the holes, and the shadows of the far trunks and limbs show inside the crown shadows.
* **Motion** (`motion_f60_d225.png` / `motion_f61_d224.png`, `motion_f180_d155.png` / `motion_f181_d154.png`): consecutive frames of a 240-frame dolly show the same holes and clumps, with no visible shimmer.
* **Performance:** each frame is `lod.update` + render + a 1-pixel readback, median of 40 frames, run twice. The GPU was shared, so runs vary by about ±1 ms. The before run was a separate page load.

  | View | Estimated triangles, before → after | Drawn triangles, before → after | Before (ms) | After, breakup off (ms) | After, breakup on (ms) |
  |---|---|---|---|---|---|
  | Staging | 1,156,140 → 658,517 | 1,946,939 → 1,448,899 | 16.4 | 16.0 | 17.2 |
  | Intermediate, 65 m | 5,651,723 → 5,457,331 | 6,082,270 → 5,888,198 | 15.6 | 15.4 | 17.2 |
  | Mid, 110 m | 7,051,182 → 6,739,670 | 7,347,512 → 7,036,513 | 18.3 | 18.6 | 20.2 |
  | Ground | 7,949,873 → 7,947,647 | 6,862,290 → 6,859,554 | 14.1 | 14.8 | 16.3 |
  | Sun, 4096² shadow | shadow pass 3,973,593 → 3,745,987 | — | 20.3 | 20.4 | 24.7 (22.7 with `shadowHoles: 0`) |

* **Native, park tile (CLI, 609 trees):** the far level's triangles fell from 1,250,664 to 707,437. Far wood now has a median of 352 triangles per tree (range 40–599), against 902 for the whole wood.

## 3. What Broke / Didn't Work

* **First version was too slow.** It cost 3–4 ms: a 27-cell Worley, a 3-noise domain warp, and holes and clumps at near-mid. Changes:
  * Worley now searches 2×2×2 cells, with feature points jittered within the middle half of each cell.
  * The warp was dropped.
  * Near-mid has no holes or clumps.
  * The noise is skipped where its share is 0.
  * The shadow pass uses the coarse octave only.
* **Rim holes alone left the shadows solid.** The inner blobs still blocked the light. Sampling on the crown's mid-plane fixed this (see §1).
* **Ground-level canopy looks bare.** Coordinator check: the user reported that trees look bare from the ground. The near-mid level is not the cause. Leaf pixels covering the far mass's silhouette (breakup off):

  | View | Near | Near-mid | Mid |
  |---|---|---|---|
  | Ground | 0.762 | 0.773 | 0.819 |
  | Intermediate, 65 m | 0.718 | 0.699 | 0.760 |
  | Mid, 110 m | 0.756 | 0.740 | 0.798 |

  Forced-level ground shots (`ground_forced_level0.png`, `ground_forced_level1.png`) look equally bare. The near level itself shows bare inner wood from below: its leaves are on the crown shell. In clay, the leaves are also the same value as the sky. Near-mid needed no change.

## 4. Candidate Tool/Service Ideas

* **`__SB_TREE_LOD__` debug hook.** Its absence was felt again. Each page reload needed a 40-line console harness to rebuild captures and timings.
* **Capture endpoint in the dev server.** It would save a viewport PNG to `test-results/`, so no separate receiver is needed.
* **Near-level canopy density from below.** Leaves inside the crown and on its underside, not only on the shell. This is a native follow-up, with the triangle cost to be measured.

## 5. Reproduction Steps

1. Start the app from the worktree and stage the prompt above.
2. Get the controller: `const lod = [...__SB_3D_EXTERNAL_OBJECTS__.values()].find(m => m.userData.sbTreeLod && m.parent).userData.sbTreeLod`.
3. Compare with `lod.setCrownShading({ breakup: { enabled: false } })` and `lod.setCrownShading(null)`. Tune live with, for example, `lod.setCrownShading({ breakup: { holes: [0, 0, 0.7, 0.7], clumpPerCrownRadius: 0.35 } })`.
4. Tests:
   * `packages/core/test/tree-crown-breakup.test.ts` covers the chunks in every variant and shadow material, world-space stability across levels, and GLSL against the TypeScript mirror in WebGL, with screenshots.
   * `tile-vegetation-lod.test.ts` covers the far-level limbs and the triangle counts.
