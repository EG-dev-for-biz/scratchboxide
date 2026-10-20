# Photo-match trees as the viewport draws them; what buildings cost in the viewport

* **Date:** 2026-10-19
* **Branch:** `eval-trees-building-cost` (from origin/main 1deb842f)
* **Status:** Verified (evaluator fix: tests, two real-call reruns); Verified (cost measurements in the live app, M1 Ultra)

## 1. Photo-match evaluator: one tree level per view

**Problem.** The SB-Veggie trees GLB (`trees-lod/2` and `/3`) holds every level of every tree (near, near-mid, mid, far) and its leaf clusters as `EXT_mesh_gpu_instancing` nodes. The evaluator's software renderer (`readTileTriangles` + `renderTriangles`) drew every level at once, and drew each leaf-cluster mesh once at its node instead of once per instance. The far level's blob masses therefore stood in front of the facades as grey hulls, and round 6 (staged_location_pipeline_e.md §9) left the regrown trees out of every arm.

**Change.**
* `common/spatial/tree-lod-math.ts`: the tree LOD arithmetic moved from `browser/.../treeLod/treeLodMath.ts` (which now re-exports it). Added: the view options and defaults (`DEFAULT_TREE_LOD_VIEW`, `resolveTreeLodView`), `dominantLevel`, `sphereFovealRadius` and `treeLevelForView`. `TreeLodController` uses the same functions, so the viewport and the evaluator share one rule.
* `tile-texture-transfer.ts` `readTileTriangles` now expands `EXT_mesh_gpu_instancing`: one copy of the mesh per instance, using the instance's TRS inside the node's frame, as glTF specifies. With `{ nodeTags: true }` it also returns each triangle's node. `selectTriangles` is a new helper.
* `tree-lod-view.ts` (new): `readTreesLodGlb` reads the trees GLB once. `treesForView(glb, pinholeCamera)` keeps one level per tree, chosen the way `TreeLodController` settles for a still camera:
  1. the range to the nearest point of the tree's bounding sphere;
  2. the foveal weight from the tree's place in the frame;
  3. the reference-lens distance with the same on-screen size;
  4. the target edges at that distance;
  5. the level with the largest share.

  It draws that level whole. Depth of field and the triangle budget are not applied.
* `photo-match-eval.ts`: added `loadArmLayer(glb, { treeLod })` (on by default), `armMeshesForView` and `armLayerTriangles`. The dev driver `scripts/dev/photo-match-eval.ts` reads the manifest key `"treeLod"` (default true) and writes `views[].trees` (trees per level, triangles drawn against all levels). The `photo_match_evaluate` tool gains `trees` (default true): the run's trees layer is drawn per view, and the strip's `removed_trees.glb` is cut from the street, so scanned trees are not drawn a second time. `trees: false` restores the old behaviour.

**Tests** (`guarded-vitest.sh`, no billed calls): `photo-match-eval-trees.test.ts` (new, 3 tests):
* Instances expand at their exact translations.
* On a 3-tree synthetic GLB at about 20, 130 and 460 m, the evaluator picks levels 0, 1 and 3. These match `TreeLodController.explain(i).level` on the same GLB, camera and frame height, and the equivalent distances agree to 1e-3.
* Drawn triangles equal the sum of the chosen levels; the near tree draws 12 wood + 6 leaf triangles.
* With `treeLod: false` the far blob covers more than 4x the pixels.

Screenshot: `test-results/screenshots/eval_trees/eval_trees_one_level_per_tree.png`. Also passing: `photo-match-eval.test.ts` (10), `photo-match-evaluate-tool.test.ts` (8, now also checks that the trees layer is opt-in), and `tree-lod-{contract,controller,math,screen,viewport}` (68). `npm run typecheck` and `npm run lint:primitives` pass; eslint reports 0 errors on the changed files.

**Rerun with trees (real `gemini-4-argon` calls, 1 view per place, 3 runs, textured and clay).** Arms: A raw tile; D, E and Eh, each with its regrown trees. The context is cut by the isolate and the strip's removed trees. Haughwout has no trees layer in any arm, so St. Mark's replaces it.

| View | A | D + trees | E + trees | Eh + trees | Trees drawn (E) |
|---|---|---|---|---|---|
| Jefferson `xf-y97` 43 m | 5.0 (clay 2.7) | 4.0 (3.7) | 4.7 (5.3) | 5.0 (5.3) | 2 trees: level 0 at 35 m, level 1 at 57 m; 209 k of 530 k triangles |
| St. Mark's `nBGqmk` 53 m | 5.0 (3.7) | 4.0 (2.7) | 3.0 (6.0) | 3.0 (6.0) | 2 trees, both near-mid at 72 and 77 m; 84 k of 406 k triangles |

Grids: `test-results/screenshots/eval_trees/after/` (judged) and `before/` (same arms with every level drawn, not judged).
* At Jefferson, the solid white hull in front of the west facade (`before/`) becomes a speckled leaf crown (`after/`).
* At St. Mark's, the two regrown trees stand behind the church from this pose, so before and after render the same.
* St. Mark's finding, not fixed here: the strip removed the scanned trees in front of the church (19 k triangles) but regrew only 2 trees, both behind it. The photo's foreground canopy is therefore absent in every built arm. That is a planting issue, not an evaluator one.

## 2. What buildings cost in the viewport

**Setup.**
* App started from this worktree: web 3291, API 3292, tools 3293, `SCRATCHBOX_STAGED_PIPELINE=e`, opened with `?sbViewportCost=1`.
* Apple M1 Ultra (ANGLE Metal). The drawing buffer is 808 × 943 (0.76 MP, DPR 1, the pane's viewport).
* GPU time is whole-frame `EXT_disjoint_timer_query_webgl2`, mean of 30 frames after 8 warm-up frames, with tree levels updated each frame.
* "Hide X" means the same frames with that group's meshes invisible, so the building and tree shares are differences.
* Clay, no shadows. Lens: full frame, `fov = 2 atan(12 / f)`.
* Poses:
  * elevated: 220 m from the target, 100 m up (160 m and 90 m for the lone hero);
  * street: 60–70 m from the target, eye at 1.7 m.

**New dev-only probe** (`scene3d/viewportCost.ts`, kept): opt in with `?sbViewportCost=1` or `localStorage['sb.viewportCost']='1'`. It exposes `window.__SB_VIEWPORT_COST__` with these calls:
* `breakdown()`: triangles, draw calls, instances, geometry MB and texture MB per staged layer and per node provenance, and trees per level. Its totals matched `renderer.info`.
* `measure({ frames, hide })`
* `setLens(mm)`

Raw JSON is in `test-results/screenshots/building_cost/*.json`.

### Cost table

| Scene / view | Buildings (tri / calls) | Trees (tri / calls; levels near/nm/mid/far) | GPU ms all | GPU ms trees hidden (≈ buildings + ground) | GPU ms buildings hidden |
|---|---|---|---|---|---|
| **Haughwout block** (district, not isolated): elevated 24 mm | 1.25 M / 1 | 48 k / 111; 0/0/1/54 | 1.96 | 1.75 | 0.62 |
| same, elevated 85 mm | 1.25 M / 1 | 149 k / 62; 0/2/3/1 | 1.12 | 1.16 | 0.83 |
| same, street 24 mm | 1.25 M / 1 | 107 k / 83; 0/0/0/26 | 1.03 | 1.13 | 0.53 |
| same, street 85 mm | 1.25 M / 1 | 326 k / 90; 0/1/0/2 | 1.17 | 1.06 | 1.43 |
| **Washington Square Arch district**: elevated 24 mm | 0.79 M / 1 | 5.73 M / 739; 0/0/6/305 | 9.16 | 1.07 | 8.59 |
| same, elevated 85 mm | 0.79 M / 1 | 7.86 M / 387; 0/25/14/19 | 6.78 | 0.82 | 7.76 |
| same, street 24 mm | 0.79 M / 1 | 6.83 M / 501; 6/13/9/115 | 6.63 | 0.77 | 7.32 |
| same, street 85 mm | 0.79 M / 1 | 3.04 M / 310; 9/8/24/18 | 5.41 | 0.82 | 4.57 |
| **Haughwout, pipeline E hero alone** (isolated, clay), 4 views | 3.6 k / 75–99 | none | 0.23–0.31 | n/a | n/a |
| same, real textures | 3.6 k / 75–99 | none | 0.22–0.34 | n/a | n/a |

* **Hero vs context, massing vs relief.**
  * Pipeline E only builds an isolated structure: the hero's tile is cut 26 m around it, and a non-isolated build skips relief ("not an isolated structure"). The hero (relief layer `l2r`) splits as:
    * vector massing: 406 triangles, 11 calls;
    * measured relief and openings: 866 triangles, 48 calls;
    * photo-inferred: 78 triangles, 25 calls;
    * generated bands: 90 triangles, 5 calls;
    * scan residual: 2,153 triangles, 10 calls.
  * The context of a dense block is the remeshed district scan: 0.8–1.25 M triangles in **one** mesh and one draw call. It cannot be frustum-culled or LODed per building.
  * A pipeline E hero costs about 1/350 of its block's context in triangles. It costs about 100x the context in draw calls (75–99 against 1), because every relief element is its own mesh.
* **Ground and streets** inside the district mesh (up-facing triangles within 2.5 m of the ground):
  * Haughwout: 53 k of 1.25 M (4 %); flat roofs 284 k; walls and other 917 k.
  * Washington Square: 78 k of 0.79 M (10 %); flat roofs 158 k; walls 556 k.
* **Memory.**
  * Haughwout block: district buildings 89 MB of geometry, **plus the superseded remesh layer (`l2`, 88 MB) still resident and hidden**. Trees 17 MB. JS heap 345 MB.
  * Washington Square: buildings 56 MB plus the superseded remesh 55 MB. Trees 157 MB (near 73, near-mid 35, mid 35, far 14). JS heap 530–550 MB.
  * E hero: 2 MB of geometry; its textured twin adds 26.6 MB of textures.

Screenshots in `test-results/screenshots/building_cost/`:
* `haughwout_block_clay_{elevated_24mm,street_85mm}.jpg`
* `wsa_district_clay_{elevated_24mm,street_24mm,street_85mm}.jpg`
* `haughwout_E_hero_clay_elevated_24mm.jpg`
* `haughwout_E_hero_textured_street_85mm.jpg`

### Reading

* **Buildings are cheap; trees are the frame.**
  * A 1.25 M-triangle dense block draws in about 1–1.75 ms. Hiding the trees leaves 0.8–1.1 ms at Washington Square.
  * With trees, Washington Square costs 5.4–9.2 ms, of which trees are about 85–90 %. Tree triangles stay near the controller's 8 M budget, and a tree draw call costs much more than a building one.
  * Hiding the buildings sometimes makes a frame *slower* (Haughwout street 85 mm: 1.17 → 1.43 ms; Washington Square elevated 85 mm: 6.78 → 7.76 ms). The buildings occlude trees behind them, and early depth rejection is worth more than the buildings' own cost.
* **Fragment cost scales with pixels; triangle cost does not.** These frames are 0.76 MP. At 1080p (2.07 MP) the per-pixel share grows about 2.7x. The building share is mostly vertex and triangle work, so it grows much less.
* **A pipeline E hero is negligible** (about 3.6 k triangles, under 0.35 ms whole-frame). Only its 75–99 draw calls per building would matter, if a scene held dozens of E heroes.

### Recommendation

Building LOD plus a shared budget is **not worth building now**. At today's sizes the buildings in view stay near 1 M triangles and about 1 ms, and their single mesh is the cheapest thing in the frame. A building LOD would save at most about 1 ms. The trees take 5–8 ms and already have their own LOD. Do these simpler things first, in this order:

1. **Free superseded layers.** The remesh `l2` stays resident under the grammar `l2g`: 55–88 MB of duplicate geometry per district. Dispose a layer's geometry when it is superseded and is not a kept variant.
2. **Count buildings in the tree budget**, the cheap form of a shared budget. Pass the static triangles drawn this frame (`renderer.info`, or the probe's building total) to `TreeLodController` as a reserved share of `triangleBudget`. Trees then give up levels when the city is heavy, with no building LOD at all.
3. **Merge a pipeline E hero's meshes per material at load** (99 → about 5 draw calls). This matters only with many heroes.
4. **If districts grow** (larger extraction radii, several blocks), the trigger is buildings in view above about 3 M triangles or 2 ms, about 2.5x today's dense block. Then a simple rule is enough:
   * split the district mesh into roughly 64 m cells at extraction, so they frustum-cull;
   * drop cells whose projected size is under about 2 % of the frame height (or beyond about 600 m at the 45° reference lens) to a decimated copy made once, at about 1/8 of the triangles.

   That is one distance or screen-size threshold and two levels. A full multi-level building LOD with a shared importance budget can wait until a measured scene needs it.

## 3. Candidate Tool/Service Ideas

* A viewport capture endpoint on the API port. The pane refuses connections to ports it did not open, so saving frames needed a receiver plus a `preview_start` on its port.
* A `staged_layer_memory` field in the stage overlay: resident MB per layer, superseded layers included. It would make finding 1 visible without the probe.

## 4. Reproduction

* Evaluator:

  ```
  node -r ts-node/register scripts/dev/photo-match-eval.ts <manifest.json>
  ```

  Use the manifest keys `"treeLod": true|false` and `context.cut: [isolate, removed_trees.glb]`, with the ts-node options from staged-replay.ts.
* Cost: open the app with `&sbViewportCost=1`, stage the build, then call:
  * `__SB_VIEWPORT_COST__.breakdown()`
  * `await __SB_VIEWPORT_COST__.measure({ frames: 30, hide: ['trees/'] })`
  * `__SB_VIEWPORT_COST__.setLens(85)`

  Place the camera with `__SB_SET_CAMERA_VIEW__(target, { theta, phi, distance })`.
* Builds:
  * `Haughwout Building, 488 Broadway, New York: stage the whole dense block around it (not isolated), with its neighbouring buildings and trees`
  * `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`
  * the isolated E hero (`isolate: true`)
