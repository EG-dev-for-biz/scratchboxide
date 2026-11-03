# Process: Why SB-Veggie's mid and far tree levels look sparser than the near level; a coverage report that counts what each level draws; far masses spread to the near level's cover; crown holes scaled to what lies behind the rim

> **Recorded:** 2026-11-02
> **Status:**
> - Verified: the report fixed. Each level's report counts every triangle it draws, the far level included, and lands within 0.07 of the screen.
> - Verified: the far level fixed. Its leaf masses are spread along the crown surface until it covers what the near level draws: report median 1.00x, was 0.85x. On screen with the holes off: redwoods 1.02x and 0.96x, a 5 m tree 0.92x (was 0.58x). Same triangles.
> - Verified: the viewer's crown holes scaled to what lies behind each crown's rim. Screen, holes on: a 5 m tree's mid level 0.74x -> 0.99x and far 0.66x -> 0.82x; the 36 m redwood unchanged (0.91x, 0.87x).
> - Vitest and typecheck pass.
> - Not checked in the live app.
> **Tags:** `sb-veggie` `tree-lod` `coverage` `vegetation`
> **Target Domain:** native tree LOD (`packages/core/src/native/3d-engine/include/scratchbox_tree_lod.hpp`, `scratchbox_tile_vegetation.hpp`) and the viewer's crown holes (`treeCrownShading.ts`)

---

## 1. Session Context

* **What prompted this session:** a review of [threejs-nanites](https://github.com/VictorZakharov/threejs-nanites), whose leaf levels are thinned so that each coarser level covers what the finer one did. The first question was whether our farther levels cover *too much*. They do not on screen (see section 3). The user then asked why the mid and far levels look *sparser* than the near level, especially on small trees, and asked that the coverage report count everything each level draws.
* **Instance used:** no app instance. Trees rendered headless with the app's own `TreeLodController` and clay pass, from a copy of `packages/core/test/tree-lod-harness` that loads one tree at a time (scratch files in the gitignored `test-results/tree-lod-coverage/`). Crowns from the forest demo's generator (`scripts/generate_forest_procedural_3d.cpp`, the version on PR #20's branch, with its `coast_redwood` species entry), run against this branch's headers.
* **Screenshots:** `docs/screenshots/tree_lod_coverage_2026-11-02/` (gitignored):
  - `tree_lod_level_coverage_proof.png`: the reverted trial below;
  - `tree_lod_drawn_coverage_proof.png`: the report;
  - `tree_lod_far_masses_proof.png` and `tree_lod_far_masses_at_switch.png`: the far masses;
  - `tree_lod_crown_holes_proof.png`: the crown holes.

---

## 2. What Was Tested & What Worked (Verified)

* **Screen coverage per level** (the share of a 1280 x 800 frame the tree covers, as a multiple of its near level; mean of 4 sides, no anti-aliasing; each level forced):

  | Level | Redwood 36.5 m, from 45 m: holes off / on | Understory 5.4 m, from 9 m: holes off / on |
  | :--- | ---: | ---: |
  | near-mid | 1.03 / 1.03 | 1.04 / 1.04 |
  | mid (crown cards) | 0.96 / 0.90 | 1.07 / 0.74 |
  | far (blob masses) | 0.81 / 0.72 | 0.58 / 0.40 |

* **The report counts what each level draws** (`CoverageReport::drawnLevel0`, `drawnNearMid`, `drawnMid`, `drawnFar`; GLB extras `lod.coverage.drawn`; every level now also carries `areaM2`, the area covered in a view, inside the crown's silhouette or not):
  - The near level counts its wood, its twigs and every triangle of its leaf clusters (blades, both sides, petioles, sub-shoots).
  - The near-mid and mid levels count their wood and their clusters or crown cards.
  - The far level counts its trunk and main limbs and its leaf masses (`TreeLodInput::farFoliage`, set by `tile_vegetation` before `buildTreeLod`).
  - Solid (clay). Measuring a second time with the blades cut out, as a leaf texture cuts them, moved the ratios between levels by under 0.01 on the 49 crowns, for twice the time, so it was dropped.
  - The blade-only fields (`level0` .. `midClusters`, `cutout`) are kept unchanged. The fill still aims the blades at the Beer-Lambert target.
* **The new figures against the screen** (holes off), on the two trees:
  - near-mid: `drawn` 1.01x / 1.03x, screen 1.03x / 1.04x;
  - mid: 1.02x / 1.14x, screen 0.96x / 1.07x;
  - far: 0.86x / 0.62x, screen 0.81x / 0.58x.

  The old blade-only figures said near-mid 1.07x / 1.28x and mid 1.09x / 1.44x, and did not measure the far level.
* **All 49 crowns, median of `drawn`:** near-mid 1.03x, mid 1.06x, far 0.91x (least 0.51x).
* **Geometry is unchanged:** every blade-only figure is identical with and without the new measure (49 trees).
* **The far masses spread to the near level's cover** (`LodParams::farMassCoverMatch`, `detail::FarMassSpread`; GLB extras `drawn.farBefore`, `drawn.farMassSpread`; `tile_vegetation --far-mass-cover-match 0` turns it off):
  - Each mass (a closed blob; as many as the tree's triangle budget holds) is stretched across the crown's outward normal at its centre, not along it.
  - Any vertex that would end up further out of the fitted crown than the mass, or the near level's leaves (their 98th percentile), reached is pulled back onto that shell, so a mass on the surface wraps along it.
  - One factor per tree, between 0.6 and 3.0, is bisected until the far level covers as much of each view (`areaM2`) as the near level draws, within 1%.
  - Report, 49 crowns: far / near median 0.85x (least 0.49x) before, 1.00x (least 0.92x) after; spread median 1.5x, 2 trees at 3.0x.
  - Unchanged: the far triangles, and the near, near-mid and mid levels.
  - Screen, 4 sides, holes off / on: redwood 36.5 m 0.81x / 0.72x -> 1.02x / 0.87x; redwood 29.5 m 0.67x / 0.57x -> 0.96x / 0.84x; understory 5.4 m 0.58x / 0.40x -> 0.92x / 0.66x.
  - Seen up close (9-45 m) the spread masses are large faceted plates. Where the far level is first drawn (166 m for the redwoods, 87 m for the small tree) they fill the crown's outline as the near level does, with some dark faces on the redwoods.
* **The viewer's crown holes scaled to what lies behind the rim** (`treeCrownShading.ts`):
  - The holes are weighted to a rim band 0.9 mean lobe radii deep.
  - The viewer measures once per mesh how much of a level's leaves lie in that band (`crownRimShareOf`: the mean rim weight at each instance's origin, or at the far masses' vertices) and carries it in the fraction of the mesh's detail slot (`crownRimSlot`; under 0.5, so the slot's selection is unchanged and no vertex attribute is added).
  - The shader takes `(1 - share) / (1 - rimShareFull)` of the slot's holes, capped at 1 (`sbBkRimHoles`; `rimShareFull` 0.45, the share at which the 36 m redwood takes its full holes).
  - When `rimWidth` changes, the controller measures again and the far batch re-reads its copies (`TreeFarBatch.refreshPerMesh`).
  - Measured rim shares, mid / far: redwoods 0.33-0.45 / 0.21-0.37, a slimmer redwood 0.67 / 0.65, the 5 m trees 0.87-0.89 / 0.82-0.83.
  - Screen, holes on, mid / far:

    | Tree | Before | After |
    | :--- | ---: | ---: |
    | 36.5 m redwood | 0.91x / 0.87x | unchanged |
    | 29.5 m redwood | 0.90x / 0.84x | 0.94x / 0.90x |
    | 27.5 m redwood | - | 0.92x / 0.88x |
    | 5 m trees | 0.74x / 0.66x | 0.99x / 0.82x and 0.99x / 0.90x |

  - Before choosing the rule, the hole settings were measured on the 5 m tree, mid / far (holes off 1.07x / 0.92x):
    - default 0.74x / 0.66x;
    - no pockets 0.78x / 0.70x;
    - no rim holes 1.06x / 0.92x;
    - a 0.3 rim band 0.89x / 0.75x;
    - holes no smaller than 0.4 m 0.77x / 0.65x.

    The rim holes were the loss.
  - A share ratio `rimShareFull / share` took the 5 m tree only to 0.90x / 0.78x; the support rule above took it to 0.99x / 0.82x.
* **Cost** (CPU time for the forest's 49 trees, three alternating runs on a loaded machine): 59-61 s against 37-41 s on main. Most of it is measuring every triangle of the near level; the spread adds about 5%.
* **Tests** (vitest with an empty HOME and no environment):
  - `tree-crown-density` has a new probe: a closed plain mesh covers the whole silhouette, its area that of the silhouette; a library mesh's petiole counts as well as its blade. Its planted crowns check that each `drawn` level covers at least its blades, that the far level is measured, and that the spread far level covers the near level's area within 1.1% unless it reached the largest spread.
  - `tree-crown-breakup` has a new case for the hole rule (the share packed in the slot leaves the slot as it was; full holes up to 0.45, half at 0.725, none at 1; a level all in the rim band keeps every fragment), and its GLSL-against-TypeScript check has a packed slot. `tree-crown-shading` and `tree-lod-controller` read the slot as the integer part.
  - Run on Node 22 (as CI does) with credentials unreachable, after the last change:
    - `tree-crown-breakup` 7/7, `tree-crown-shading` 13/13, `tree-lod-controller` 16/16, `tree-far-batch` 4/4, `tree-lod-viewport` 5/5, `tree-lod-screen` 15/15;
    - `tree-lod-settle-budget` 8/8, `tree-lod-adaptive-budget` 6/6, `tree-lod-shared-budget` 4/4, `tree-mid-lod-cards` 3/3, `tree-crown-density` 7/7;
    - `tile-vegetation-lod` 7/7, `tile-vegetation-species` 5/5, `tile-vegetation-textures` 6/6;
    - `sb-veggie-lockdown` 10/10 (its script type check timed out once under the machine's load, then passed alone);
    - `npm run typecheck` exit 0.
  - On Node 20 the WebGL viewport suites cannot start (no global WebSocket); that is the shell, not the change.
  - `staged-build-native-trees` was skipped (no staged trees GLB in its cache), so the staged viewport was not checked.

---

## 3. What Broke / Didn't Work

* **Matching the coarser levels' leaf size to the near level's blade coverage (tried, reverted).** Each shared cluster's near-mid and mid leaf-area gain was bisected until its projected blade area matched the near cluster's, and the crown cards were aimed at the near level's coverage. The blade-only report then read 1.00x everywhere, but on screen every farther level got sparser: understory near-mid 0.86x, mid 0.50x with holes. The blade-only measure leaves out the near level's petioles, sub-shoots and twigs, which add 15-50% to a near cluster's projected area. The fixed gains (1.7, 2.6) were already within 5% on screen at the near-mid level. Nothing was committed.
* **The mid level's sparseness is the viewer's crown holes, not its geometry** (scaled above).
  - The setting: `DEFAULT_CROWN_BREAKUP` holes 0.5 and pockets 0.18 at the mid slot, weighted to a rim 0.9 mean lobe radii deep, with a hole scale of `clamp(0.28 x crown radius, 0.8, 1.5)` m.
  - The understory crown is one lobe of 2.18 m, so the rim band reaches its centre and the 0.8 m holes go through the whole crown: they take 31% of its mid level.
  - The redwood's 6 lobes over 21 m of crown keep leaves behind its holes: 6%.
* **The far level's sparseness was its geometry** (fixed above).
  - The blob masses' number follows the tree's triangle budget, with no coverage target: the redwood gets 61 masses in 2,063 triangles, the understory tree 10 in 334. They covered 0.62x of the near level, and the holes took the screen to 0.40x.
  - A first spread held every mass inside its own farthest reach. Most masses already touch the crown's surface, so the far level only reached 0.95x, with most trees at the largest spread.
  - Matching the share inside the fitted ellipsoid left the screen 0.10 short, because the near level's leaves reach past it. Matching the whole covered area out to the leaves' reach closed most of it.
  - The 5 m tree is still 0.92x on screen against 0.99x in the report: the report's 9 views include 3 at 45 degrees and one from above, the screen check only the sides.
* **Seen in passing: the grown trunk climbs one side of the crown.**
  - On the redwoods the stem above the crown base runs 0.8-2.0 m off the stem axis (40-73% of the crown radius) while the leaf masses stay within 0.13 m of it. The user pointed it out on the proof sheet.
  - Traced from the far-level wood by height band (`leader.py`, session scratchpad).
  - Proposed as a session of its own ("Make SB-Veggie trunks rise through the crown").

---

## 4. Candidate Tool/Service Ideas

* **The harness's one-tree mode.** `packages/core/test/tree-lod-harness/harness.ts` hero-shots a tree with every other tree drawn, so a forest's neighbours fill the frame. An `only` crown id in `init` (removing the other tree nodes before the controller is built) and a no-anti-aliasing switch made the level-by-level screen coverage measurable. Both belong in the harness.
* **A screen-coverage probe per level** returning the share of the frame per level, with the holes on and off, so the `drawn` report can be checked against the viewer on any trees GLB.
* **A live-app check** of a staged location's trees (the viewport's own scene, textured) would confirm the three changes where users meet them; the staged-viewport test skips without a cached staged trees GLB.

---

## 5. Reproduction Steps

1. Build the forest generator from PR #20's branch against this branch's headers, and run it from a folder whose `assets/vegetation/species/index.json` holds the `coast_redwood` entry: `clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/generate_forest_procedural_3d.cpp -o gen -lz && ./gen out/forest.glb`.
2. Read `lod.coverage.drawn` on each tree node of `out/forest_trees.glb` (`level0`, `nearMid`, `mid`, `far`, `farBefore`, `farMassSpread`; `areaM2` in each).
3. For the screen figures: load the trees GLB in the tree LOD harness one tree at a time, hide the ground, force each level and count the pixels that differ from the background, with the crown holes on and off (`setBreakup`).
