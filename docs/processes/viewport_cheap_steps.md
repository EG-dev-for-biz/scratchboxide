# Viewport cheap steps: free superseded layers, one shared triangle budget, merged E heroes

* **Date:** 2026-10-19
* **Branch:** `viewport-cheap-steps` (from origin/main 04a13e98)
* **Status:** Verified (tests, headless Chrome pixel diffs, live app with `SCRATCHBOX_STAGED_PIPELINE=e`, M1 Ultra)
* **Follows:** [eval_trees_and_building_cost.md](./eval_trees_and_building_cost.md), recommendations 1 to 3. Recommendation 4 (district cell decimation) is not built; see §5.

## 1. Free superseded layers (`stagedBuild/layerEviction.ts`)

**Problem.** A layer another layer replaced (`supersedes` or `crossfadeFrom`) was hidden but stayed loaded. On a dense block the remesh `l2` stayed resident under the grammar `l2g`, holding 55–88 MB of duplicate geometry.

**Change.**
* The staged-build hook evicts a layer when all of these hold:
  * it is hidden;
  * a revealed layer that is not a clay/textured swap layer replaced it;
  * it has stayed hidden for `EVICT_AFTER_MS` (2 s);
  * nothing is revealing.
* Eviction does three things:
  * its meshes leave the material registry and the node table;
  * `Scene3DPrimitive`'s loader releases the model (`releaseObject3D`: geometry, textures, CPU arrays);
  * the scene object stays, with its URL and metadata.
* The scheduler treats an evicted layer as ready, so it stays `revealed` and hidden and nothing waits for it.
* An evicted layer is loaded again from its URL when any of these happens:
  * "Show replaced layers" is turned on (it draws as a ghost);
  * "Replay build" runs (it reveals again);
  * the layer that replaced it goes away.
  * Turning the view off frees it again after the delay.
* These are never evicted:
  * a layer that is showing;
  * a clay layer whose textured twin is engaged, so the clay toggle comes back at once;
  * a swap layer;
  * a layer whose file failed to load.
* The cost probe's `breakdown()` lists `evictedLayers`.
* Opt out with `?sbEvictSuperseded=0` or `localStorage['sb.evictSuperseded']='0'`.
* There is no layer picker or viewport "real data" toggle in the app today. The real-data view is a server-side build option (`enhance: false`), so it has nothing to reload here. The provenance view never draws hidden layers.

**Tests.** `staged-layer-eviction.test.ts` (4 tests):
* Pure rules:
  * candidates;
  * the opt-in views, engaged twins, swap layers and failed loads keep a layer;
  * the delay clock.
* Real viewport (headless Chrome), fixture `l2` replacing `l1`:
  * the tiles' geometry bytes go to 0 and the total falls by exactly that amount;
  * the frame is unchanged (same pixel count, mean colour within 0.5);
  * Show replaced layers reloads `l1`, which draws as a ghost with its geometry bytes back;
  * turning it off frees it again;
  * Replay build reloads and reveals it, then it is freed again;
  * no console errors.
* Screenshots: `evict_{before,after,reloaded_ghost,replayed}.png`.

## 2. One triangle budget for the frame (`treeLod/sceneTriangleShare.ts`, `TreeLodController`)

**Change.**
* `countSceneTriangles` counts what everything but the trees draws this frame:
  * main pass: visible meshes in the frustum, triangles times instances;
  * shadow pass: casters in the shadow camera's frustum;
  * the trees GLB roots are skipped (their controllers count them);
  * cost is one walk of the visible non-tree objects.
* The viewport passes that count to each `TreeLodController` as `TreeLodFrame.reservedTriangles`, plus the estimates of the trees GLBs updated before it. The trees then fit into `triangleBudget − reserved`.
* Buildings, the hero and the focus object are never reduced, and the focus tree is never demoted for the budget.
* **Fixed along the way:**
  * The old budget judged a demotion by this frame's in-flight cost.
  * Demoting a settled tree starts a crossfade that draws both levels, so the demotion looked like a loss and was never made.
  * As a result, a budget squeeze on settled trees (the scene's share growing) was never met.
  * A second pass now fits the targets themselves (destination cost) whenever this frame's cost is still over budget.
* The stats overlay (`treeLod.statsOverlay`) gains a line. Live, Washington Square at street level with the 85 mm lens:

  ```
  budget 8.00M = scene 792.0k + shadow 0 + trees 7.18M (trees may use 7.21M)
  ```
* Opt out with `?sbSharedTreeBudget=0` or `localStorage['sb.sharedTreeBudget']='0'`.

**Tests.** `tree-lod-shared-budget.test.ts` (4 tests, real geometry):
* Exact counts for visible, hidden, culled, instanced and shadow-casting meshes, with tree subtrees skipped.
* With room in the budget, nothing is demoted. A reserved share of 10 k plus half the trees makes settled trees give up levels until trees plus reserved fit in the budget. When the share goes, the levels come back.
* The focus tree is never demoted, even with the reserved share at 1e9.
* The overlay line is exact.

Existing tree LOD suites: contract, controller, math, screen and viewport (72 tests) pass. That includes the dense grove (1,000 trees) staying within 8.5 M.

## 3. Merge a pipeline E hero per material (`stagedBuild/mergeStagedParts.ts`)

**Change.**
* At load, a staged layer of plain parts is merged into one mesh per material. "Plain parts" means:
  * every mesh is a staged node (`extras.sb`);
  * no node has per-vertex reveal timing (`_reveal`, `_disp`);
  * there are at least 8 parts, with at most 128 parts per merged mesh.
* Geometry is baked into the parent's frame: same floats, same order.
* Nothing in `node/3d-engine/staged-location/pipeline-e/` was touched.
* **How provenance survives:**
  * Every vertex carries its part (`_sb_part`).
  * The mesh keeps a range table (`userData.sbMergedParts`): per part, its node name, its staged-node extras (provenance, ids, build order) and its triangle and vertex ranges.
  * `useStagedBuild` builds one node per part from the table.
  * The staged materials read per-part fade, presence, degradation mark and provenance colour and pattern from uniform arrays indexed by `_sb_part` (`revealMaterial.ts`, `SB_PARTS`). The reveal, the provenance view, highlights and ghosts therefore draw part by part, as before.
  * A part the build hides (for example a surface a later layer recut) is collapsed to zero-area triangles in the index (`setPartVisibility`). It has no shader cost, casts no shadow and cannot be picked, and the triangle numbering is unchanged.
* **Picking:** `stagedPartOfHit(hit)` resolves a hit to its part by triangle index.
  * `sb_raycast_mesh` returns the part's name as `meshName`, plus `stagedPart` (name, label, ids).
  * A click stores the part on the selection (`userData.sbPickedPart`) and in `window.__SB_LAST_PICK__`.
  * The outliner and selection still select the layer's group, as before.
* The cost probe gives a merged mesh its own group (`<layer>/merged`) and splits its triangles by part label (`<layer>/<label> (merged)`).
* Opt out with `?sbMergeParts=0` or `localStorage['sb.mergeStagedParts']='0'`.
* The staged test harness reads parts like nodes (ID pass per part, mesh states per part). All 19 existing staged viewport test files now run with merging on and pass. Merged in the fixture: tiles `l1` and the fitted body `l3b`. Not merged: `l4` (per-vertex reveal timing) and the trees.

**Tests.** `staged-merged-parts.test.ts` (5 tests):
* Geometry, on the fixture layers and on a real cached Haughwout E hero (relief and AI-enhanced layers):
  * one mesh per material;
  * every part's triangles are its node's, with identical floats in the same order;
  * every triangle maps back to its node through the range table;
  * the provenance label is kept;
  * a ray onto a part names it (at least 90 % of parts; the misses are coplanar overlaps);
  * a hidden part is not hit.
* The real viewport, same camera, merged against unmerged. Pixels differ by more than 2/255 in only the counts below.

| Layer | Draw calls | Clay | Clay, provenance view | Textured twin | Textured, provenance (rungs) |
|---|---|---|---|---|---|
| E hero relief layer (94 parts) | 94 → 1 (clay), 94 → 12 (textured) | 0 px | 0 px | 29 of 788 k px | 18 px |
| E hero AI-enhanced plates (83 parts) | 83 → 1, 83 → 12 | 0 px | 0 px | 14 px | 13 px |
| Fixture `l3b` + `l4` | fewer (1 per merged layer) | < 0.1 % | < 0.1 % | n/a | n/a |

The textured differences are a few pixels where coplanar triangles of different parts now draw in one call, in a different order. Results are in `test-results/screenshots/viewport_cheap_steps/merge_ehero_results.json`, with frames `merge_ehero_*`.

The textured hero has 12 calls, not about 5: one per material. The atlas page plus 10 tile photo pages and the AI-enhanced page each keep their own texture, and merging across textures would need an atlas rebuild.

## 4. Live app

**Setup.**
* App started from this worktree: web 3391, API 3392, tools 3393, `SCRATCHBOX_STAGED_PIPELINE=e`, opened with `?sbViewportCost=1`.
* The staged cache was copied from the previous agent's worktree, so the district builds came from cache (the same outputs as the previous doc).
* Drawing buffer 1244 × 992.
* GPU time is whole-frame `EXT_disjoint_timer_query_webgl2`, mean of 30 frames, measured after a 1.5 s settle and 20 warm-up frames.
* Lens: full frame, 24 mm and 85 mm.
* Poses:
  * elevated: 220 m out and 100 m up (160 m and 90 m for the lone hero);
  * street: 65 m out, eye at 1.7 m.
* "Before" is the same build in the same app after a reload with the three opt-out switches set.
* Raw JSON and frames are in `test-results/screenshots/viewport_cheap_steps/live/`.

### Haughwout block (district, not isolated): `l2` (remesh, 93 MB) freed under `l2g`

| View | GPU ms before → after | Calls | Triangles | Geometry MB | JS heap MB | Trees (est. tri; budget-demoted) |
|---|---|---|---|---|---|---|
| elevated 24 mm | 2.13 → 2.03 | 159 → 159 | 1.37 M | **204.5 → 111.8** | **422 → 233** | 114 k; 0 → 0 |
| elevated 85 mm | 1.33 → 1.31 | 69 | 1.47 M | 204.5 → 111.8 | 429 → 238 | 225 k; 0 |
| street 24 mm | 1.13 → 1.15 | 77 | 1.38 M | 204.5 → 111.8 | 307 → 237 | 132 k; 0 |
| street 85 mm | 1.54 → 1.29 | 103 | 1.67 M | 204.5 → 111.8 | 335 → 231 | 415 k; 0 |

* Frames compared before and after:
  * three views are bit-identical;
  * elevated 24 mm differs on 831 of 1.23 M px (max 108), in tree dissolve pixels; there was no budget change in that view.
* The shared budget reserves 1.25 M (buildings) in this block. That leaves the trees 6.75 M, far above what they draw, so nothing changes.

### Washington Square Arch district: `l2` (remesh, 58 MB) freed

| View | GPU ms before → after | Calls | Geometry MB | JS heap MB | Trees est. before → after (budget-demoted; trees' budget) |
|---|---|---|---|---|---|
| elevated 24 mm | 11.3 → 11.0 | 1062 | **281.2 → 223.0** | **613 → 400** | 4.70 M → 4.70 M (0; 7.21 M) |
| elevated 85 mm | 10.3 → 9.4 | 437 | 281.2 → 223.0 | 619 → 433 | 6.59 M → 6.59 M |
| street 24 mm | 6.15 → 5.44 | 607 | 281.2 → 223.0 | 643 → 456 | 6.08 M → 6.08 M |
| street 85 mm | 5.35 → 5.81 | 284 → 336 | 281.2 → 223.0 | 643 → 415 | **7.97 M → 7.18 M** (99 → 89; trees + scene 0.79 M = 7.97 M ≤ 8 M) |

* Frames: three views are bit-identical.
* Street 85 mm differs on 324 px (max 94). That is the shared budget at work: before, trees (7.97 M) plus buildings (0.79 M) came to 8.76 M; after, they come to 7.97 M.
* That view drew more calls and 0.46 ms more GPU time after. More trees sit at mid level, each an instanced call more than at the far level, and there are 3 trees in a static hash split. The triangle total fell; the call count did not.
* The 47 and 90 demotions in the other two views do not change the trees' estimate. They come from the first, in-flight pass on trees caught in a dissolve. The frames are identical.

### Haughwout Building, pipeline E hero (isolated)

**Build.** This build ran live (not cached):
* about 8 min;
* Facade grammar hit its 420 s limit, so pipeline E inference fell to simpler data; that is a pipeline issue, not this branch's;
* the hero is the relief layer `l2r`, 34 parts, 3,174 triangles (no photo-inferred or generated parts this time);
* `l1` and `l2` (tiles and remesh) were both freed.

| Mode / view | GPU ms before → after | Calls | Geometry MB | Texture MB |
|---|---|---|---|---|
| clay elevated 24 mm | 0.181 → 0.168 | **34 → 1** | 1.6 → 0.3 | 0 |
| clay street 85 mm | 0.232 → 0.280 | 29 → 1 | 1.6 → 0.3 | 0 |
| textured elevated 24 mm | 0.222 → 0.229 | **34 → 12** | 1.9 → 0.7 | 28 |
| textured street 85 mm | 0.376 → 0.274 | 29 → 10 | 1.9 → 0.7 | 28 |

**Frames, same camera, merged vs not merged.**

| Mode | Pixels differing (of 1.23 M) | Largest channel difference |
|---|---|---|
| clay | 6–300 | 21 |
| textured | 10–272 | 46 |
| provenance view | 37 | 12 |

* The "before" session's two elevated clay frames were taken while the session was still auto-framing, so they are not comparable.
* Re-taken with eviction off, they are pixel-identical to the eviction-on frames (0 px).

**Provenance and picking, live.**
* The provenance view shades the merged hero part by part, with measured relief bands, vector massing and the as-scanned residual in their legend colours and patterns (`haughwout_E_hero_provenance_after.png`).
* A ray from the frame centre hits `sb-merged-parts-0` and names the part `sweeprelief_band_2_chain` (`measured`). The same ray in the unmerged session hits the node `sweeprelief_band_2_chain` (`measured`).

**Reading.**
* Step 1 is the large saving: 58–93 MB of geometry per district and 190–210 MB of JS heap.
* Step 2 changes only the views where trees and buildings together exceed the budget (Washington Square, street 85 mm).
* Step 3 cuts the hero's calls by 3–94×, but a lone hero's GPU time is about 0.2 ms either way. As the previous doc said, it only matters with many heroes in one scene.

## 5. District cell decimation (not built): when it would be needed

Build recommendation 4 when **buildings in view exceed about 3 M triangles or about 2 ms of GPU time**. That is about 2.5× today's dense block: 1.25 M triangles and about 1–1.3 ms, with the remesh now freed.

* Triangles in view are `TreeLodStats.reservedTriangles`, or `__SB_TREE_LOD__.sceneShare().main`.
* The time is the probe's `measure({ hide: ['trees/'] })`.

At that point:
* split the district mesh into about 64 m cells at extraction, so they frustum-cull;
* drop cells under about 2 % of the frame height to one copy decimated to about 1/8.

With the shared budget in place, the trees already give way first as buildings grow, so the trigger is the buildings' own time, not the total.

## 6. Results

* `npm run typecheck`: exit 0.
* `npm run lint`: 0 errors, warnings only, all pre-existing.
* `npm run lint:primitives`: passed.
* Tests via `guarded-vitest.sh` (no billed calls), 50 files: 389 passed, 1 skipped (`staged-build-native-trees`, as before). The run covers:
  * every staged viewport test (`staged-build-*`, `staged-texture-viewport*`);
  * the tree LOD suites;
  * the viewport and `scene3d` suites;
  * the provenance suites;
  * `photo-match-eval-trees`;
  * the operator suites;
  * the three new files.

## 7. Candidate Tool/Service Ideas

* A `viewport_cost` agent tool or API route returning `__SB_VIEWPORT_COST__.breakdown()` and `measure()` for a named camera. Today they are driven through page JavaScript, and frames are saved through a separate receiver port.
* A reveal-gate for camera commands (`__SB_SET_CAMERA_VIEW__` after auto-framing has settled). One before/after pair here was spoiled by a late auto-frame.
* An atlas pass at build time (pipeline E) that packs the tile photo pages into one texture. It would take the textured hero from 12 calls to about 2 when many heroes share a scene.

## 8. Reproduction

* Build and serve as in [eval_trees_and_building_cost.md](./eval_trees_and_building_cost.md) §4, with `&sbViewportCost=1`.
* For "before", set `localStorage` `sb.evictSuperseded`, `sb.sharedTreeBudget` and `sb.mergeStagedParts` to `'0'`, then reload.
* Overlay: `__SB_SET_TREE_LOD__({ statsOverlay: true })`.
