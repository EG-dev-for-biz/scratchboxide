# Process: Why SB-Veggie's mid and far tree levels look sparser than the near level, and a coverage report that counts what each level draws

> **Recorded:** 2026-11-02
> **Status:** Diagnosed and the report fixed (each level's report now counts every triangle it draws, the far level included, and lands within 0.07 of the screen; vitest and typecheck pass). Not fixed: the mid level's sparseness comes from the viewer's crown holes and the far level's from its triangle budget; neither was changed.
> **Tags:** `sb-veggie` `tree-lod` `coverage` `vegetation`
> **Target Domain:** native tree LOD (`packages/core/src/native/3d-engine/include/scratchbox_tree_lod.hpp`, `scratchbox_tile_vegetation.hpp`) and the viewer's crown holes (`treeCrownShading.ts`)

---

## 1. Session Context

* **What prompted this session:** a review of [threejs-nanites](https://github.com/VictorZakharov/threejs-nanites), whose leaf levels are thinned so that each coarser level covers what the finer one did. The first question was whether our farther levels cover *too much*. They do not on screen (see section 3). The user then asked why the mid and far levels look *sparser* than the near level, especially on small trees, and asked that the coverage report count everything each level draws.
* **Instance used:** no app instance. Trees rendered headless with the app's own `TreeLodController` and clay pass, from a copy of `packages/core/test/tree-lod-harness` that loads one tree at a time (scratch files in the gitignored `test-results/tree-lod-coverage/`). Crowns from the forest demo's generator (`scripts/generate_forest_procedural_3d.cpp`, the version on PR #20's branch, with its `coast_redwood` species entry), run against this branch's headers.
* **Screenshots:** `docs/screenshots/tree_lod_coverage_2026-11-02/` (gitignored): `tree_lod_level_coverage_proof.png` (the reverted trial below) and `tree_lod_drawn_coverage_proof.png` (this change).

---

## 2. What Was Tested & What Worked (Verified)

* **Screen coverage per level** (the share of a 1280 x 800 frame the tree covers, as a multiple of its near level; mean of 4 sides, no anti-aliasing; each level forced):

  | Level | Redwood 36.5 m, from 45 m: holes off / on | Understory 5.4 m, from 9 m: holes off / on |
  | :--- | ---: | ---: |
  | near-mid | 1.03 / 1.03 | 1.04 / 1.04 |
  | mid (crown cards) | 0.96 / 0.90 | 1.07 / 0.74 |
  | far (blob masses) | 0.81 / 0.72 | 0.58 / 0.40 |

* **The report counts what each level draws** (`CoverageReport::drawnLevel0`, `drawnNearMid`, `drawnMid`, `drawnFar` and their `...Cutout` twins; GLB extras `lod.coverage.drawn`):
  - The near level counts its wood, its twigs and every triangle of its leaf clusters (blades, both sides, petioles, sub-shoots).
  - The near-mid and mid levels count their wood and their clusters or crown cards.
  - The far level counts its trunk and main limbs and its leaf masses (`TreeLodInput::farFoliage`, set by `tile_vegetation` before `buildTreeLod`).
  - Cut-out: blades and cards are cut out as the chosen leaf texture is; petioles, sub-shoots, twigs, wood and the far masses stay solid, as the viewer draws them.
  - The blade-only fields (`level0` .. `midClusters`, `cutout`) are kept unchanged. The fill still aims the blades at the Beer-Lambert target.
* **The new figures against the screen** (holes off), on the two trees:
  - near-mid: `drawn` 1.01x / 1.03x, screen 1.03x / 1.04x;
  - mid: 1.02x / 1.14x, screen 0.96x / 1.07x;
  - far: 0.86x / 0.62x, screen 0.81x / 0.58x.

  The old blade-only figures said near-mid 1.07x / 1.28x and mid 1.09x / 1.44x, and did not measure the far level.
* **All 49 crowns, median of `drawn`:** near-mid 1.03x, mid 1.06x, far 0.91x (least 0.51x).
* **Geometry is unchanged:** every blade-only figure is identical with and without the new measure (49 trees).
* **Cost:** the forest's 49 trees take 4.8-4.9 s against 2.8-3.1 s without it (two runs each).
* **Tests** (vitest with an empty HOME and no environment):
  - `tree-crown-density` has a new probe: a closed plain mesh covers the whole silhouette; a blade card is cut out to 0.6 of the solid one; a petiole card is not. Its planted crowns check that each `drawn` level covers at least its blades and that the far level is measured.
  - Also run: `tree-mid-lod-cards`, `tile-vegetation-lod`, `sb-veggie-lockdown`, `tile-vegetation-species`, `tile-vegetation-textures`, and `npm run typecheck`.

---

## 3. What Broke / Didn't Work

* **Matching the coarser levels' leaf size to the near level's blade coverage (tried, reverted).** Each shared cluster's near-mid and mid leaf-area gain was bisected until its projected blade area matched the near cluster's, and the crown cards were aimed at the near level's coverage. The blade-only report then read 1.00x everywhere, but on screen every farther level got sparser: understory near-mid 0.86x, mid 0.50x with holes. The blade-only measure leaves out the near level's petioles, sub-shoots and twigs, which add 15-50% to a near cluster's projected area. The fixed gains (1.7, 2.6) were already within 5% on screen at the near-mid level. Nothing was committed.
* **The mid level's sparseness is the viewer's crown holes, not its geometry.**
  - The setting: `DEFAULT_CROWN_BREAKUP` holes 0.5 and pockets 0.18 at the mid slot, weighted to a rim 0.9 mean lobe radii deep, with a hole scale of `clamp(0.28 x crown radius, 0.8, 1.5)` m.
  - The understory crown is one lobe of 2.18 m, so the rim band reaches its centre and the 0.8 m holes go through the whole crown: they take 31% of its mid level.
  - The redwood's 6 lobes over 21 m of crown keep leaves behind its holes: 6%.
  - Not changed.
* **The far level's sparseness is its geometry.**
  - The blob masses' number follows the tree's triangle budget, with no coverage target: the redwood gets 61 masses in 2,063 triangles, the understory tree 10 in 334. They cover 0.62x of the near level, and the holes take the screen to 0.40x.
  - Not changed.
* **Seen in passing: the grown trunk climbs one side of the crown.**
  - On the redwoods the stem above the crown base runs 0.8-2.0 m off the stem axis (40-73% of the crown radius) while the leaf masses stay within 0.13 m of it. The user pointed it out on the proof sheet.
  - Traced from the far-level wood by height band (`leader.py`, session scratchpad).
  - Proposed as a session of its own ("Make SB-Veggie trunks rise through the crown").

---

## 4. Candidate Tool/Service Ideas

* **The harness's one-tree mode.** `packages/core/test/tree-lod-harness/harness.ts` hero-shots a tree with every other tree drawn, so a forest's neighbours fill the frame. An `only` crown id in `init` (removing the other tree nodes before the controller is built) and a no-anti-aliasing switch made the level-by-level screen coverage measurable. Both belong in the harness.
* **A screen-coverage probe per level** returning the share of the frame per level, with the holes on and off, so the `drawn` report can be checked against the viewer on any trees GLB.
* **A coverage target for the far masses** (grow or add masses until `drawnFar` reaches the near level's) and **hole shares scaled to how much of a crown lies in the rim band** would close the two gaps above.

---

## 5. Reproduction Steps

1. Build the forest generator from PR #20's branch against this branch's headers, and run it from a folder whose `assets/vegetation/species/index.json` holds the `coast_redwood` entry: `clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/generate_forest_procedural_3d.cpp -o gen -lz && ./gen out/forest.glb`.
2. Read `lod.coverage.drawn` on each tree node of `out/forest_trees.glb` (`level0`, `nearMid`, `mid`, `far`, and `cutout`).
3. For the screen figures: load the trees GLB in the tree LOD harness one tree at a time, hide the ground, force each level and count the pixels that differ from the background, with the crown holes on and off (`setBreakup`).
