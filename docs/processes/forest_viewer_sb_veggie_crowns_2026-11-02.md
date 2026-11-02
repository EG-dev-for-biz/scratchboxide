# Process: The forest demo page's crowns regrown with SB-Veggie, its maps read from the GLB

> **Recorded:** 2026-11-02
> **Status:** Verified (wideshot, canopy and hero bookmarks show SB-Veggie crowns, the fern bookmark the fern bank; no 404s or console errors; tests pass). The hero and fern bookmarks were re-framed the same day, out of the fern bank. The Photo-Matched and Forest Path Walk cameras, which stood at or in the fern clumps, were re-framed later the same day ([forest_viewer_library_surfaces_2026-11-02.md](./forest_viewer_library_surfaces_2026-11-02.md) section 10).
> **Tags:** `operate-scratchbox` `demos` `sb-veggie` `vegetation` `forest-viewer`
> **Target Domain:** static demo page `/forest_3d_viewer.html` and its native generator `scripts/generate_forest_procedural_3d.cpp`

---

## 1. Session Context

* **What prompted this session:** item 5 of `app_tour_fixes_2026-11-02.md` (branch `claude/awesome-nobel-5e8080`): the page drew grey spike trunks. Two causes were found there: the model's crowns (straight cylinder limbs, 2,061,948 needle slivers of 1.9 cm² median, invisible from the 32 m wideshot) and 13 `textures/photo_*.png` fetches the server refuses.
* **Instance used:** own launch entry `scratchbox-determined-nightingale`: web `4160`, API `4161`, tools `4162`, run from this worktree. `scratchbox-dev` was not touched. The old 262 MB `forest_hyperreal.glb` was linked in from the main checkout for the "before" shots, then replaced in this worktree's `public/models` by the regenerated files (the main checkout's copy is untouched).
* **Screenshots:** headless Chromium (Playwright, ANGLE on Metal) at 1600 x 1000, the camera set to each bookmark's `pos`, `target` and `fov`; the median of 40 frame times recorded at each. Also checked in the Browser pane (console, network, the Canopy Sunbeams, Hero Redwood and Nurse Log & Ferns buttons).

---

## 2. What Was Tested & What Worked (Verified)

* **The model** (`scripts/generate_forest_procedural_3d.cpp`). The cylinder limbs and needle slivers (`appendConiferBranchesAndCrown`, `appendConiferNeedleFanLimb`, `generateCanopyBoughs`, `generateUnderstoryTree`, `generateOverhangingForegroundCanopy`) are gone. Each redwood keeps its fluted column (now vertical: its crown grows about the vertical through its stem) and every crown is grown by SB-Veggie (`tile_vegetation::growDescribedTrees`, `scratchbox_sb_veggie_grove.hpp`): 45 redwood crowns on their columns and 4 understory crowns, described in metres (height, crown radius shared with the nearest stem's gap, crown base about 0.38 of the height, conical profile, leaf colour), with the species library (`assets/vegetation/species/index.json`) and the tree texture library. The grown trunk is half the column's base radius, inside it. Written beside the forest as `<output>_trees.glb` (four levels of detail per tree, instanced leaf clusters) and `<output>_trees.stats.json`.
  - Before: one GLB, 261,785,912 bytes, 3,552,877 vertices, 2,702,213 triangles.
  - After: `forest_hyperreal.glb` 47,096,692 bytes (602,445 triangles: floor, columns and logs, ferns, undergrowth, god rays; 12 embedded maps) and `forest_hyperreal_trees.glb` 15,745,676 bytes, 49 trees, every crown filled (crownSurfaceReached 1, shortOfCrown 0). Generation takes 4 to 9 s.
  - Species chosen by measurement: spruce 23, coast redwood 20, olive 3, Italian cypress 2, honey locust 1. `coast_redwood` is a new species library entry (data, labels only).
  - Sword ferns at real size: clump radius 1.05 / 0.95 / 0.85 m (was 2.35 / 1.85 / 1.45), fronds 1.1 to 1.3 m long arching 0.6 to 1.1 m high; before, fronds 3 m long arched 2.7 m high over every ground-level camera.
* **The page** (`public/demos/showcase/forest_3d_viewer.html`; `public/forest_3d_viewer.html` and `desktop-app/public/forest_3d_viewer.html` are links to it).
  - Reads the maps embedded in the GLB's materials, tiled per surface; no `/textures` request is made. Before: 13 requests, each `404`.
  - Loads `models/forest_hyperreal_trees.glb` after the forest and draws one level of detail per tree: the level whose band (`extras.sbLod`) holds the tree's distance read through the lens as the app's viewport reads it (`tree-lod-math.ts` `screenEquivalentDistance`: 45 degree reference), the farthest trees stepping down first while the crowns ask for more than 14,000,000 triangles (the app's `DEFAULT_TREE_TRIANGLE_BUDGET`). The mid level's crown cards need the leaf atlas the app's viewer bakes, so the page draws the near-mid clusters over that range instead. Leaves take the tree's described colour; wood takes the GLB's bark map in its own bark-tile UVs.
  - The shader injectors read world position and normal through `instanceMatrix`, so the instanced leaves are lit where they stand.
  - The bark shader's crevice term varied with height (`sin(y × 24)`), drawing rings every 0.26 m on every column and contour lines on the floor; it now varies around the column.
  - `maxPolarAngle` was π/2 + 0.06, so any view from below its target was clamped level: the Canopy Sunbeams bookmark ended at [1.4, 13.8, 7.0] instead of (0.1, 1.5, 1.8). It is now π − 0.05, with the camera kept above 0.8 m in every frame; clicking Canopy Sunbeams in the Browser pane lands on (0.1, 1.5, 1.8) looking at (−3.5, 15, −12).
  - A missing model says so in the HUD ("MODEL NOT FOUND" / "CROWNS NOT FOUND: run scripts/generate_forest_procedural_3d.cpp").
* **Bookmarks after** (crown triangles at most 14 M; frame time headless):

  | Bookmark | What it shows | Triangles drawn | Frame (ms) |
  | :--- | :--- | ---: | ---: |
  | wideshot | columns with leafy SB-Veggie crowns from 12 m up, every tree at near-mid | 14,172,648 | 33.1 |
  | matched | fern fronds: the camera (0, 1.3, 2.2) stands at the fern bank's edge (not changed: it is matched to the reference photo) | 13,789,310 | 8.8 |
  | hero | the monarch's column rising from the fern bank into its crown and its neighbours' crowns, from 8.4 m off its axis | 14,384,364 | 16.7 |
  | ferns | the fern bank from a crouch, 2 m off its front edge, the columns behind; the nurse log stays hidden behind the front clumps (its top is no higher than their fronds) | 13,623,055 | 8.5 |
  | canopy | the far-left column's fluted base rising into crowns overhead | 14,124,301 | 16.7 |
  | walk | a buttress and a fern frond: the camera (−0.5, 1.35, −1.2) stands in the clumps behind the nurse log (not changed) | 13,908,520 | 8.3 |

* **Live checks** (Browser pane, port 4160): no console errors; `GET /models/forest_hyperreal.glb` and `/models/forest_hyperreal_trees.glb` `200`; 49 crowns loaded; no resource under `/textures/`.
* **Tests** (vitest with an empty HOME and no environment: credentials unreachable): `forest-hyperrealistic-3d-reconstruction.test.ts` (with a new case on the crowns GLB: 49 trees, four levels each, instanced, species library named, redwood trunks inside their columns), `tile-vegetation-species.test.ts`, `sb-veggie-lockdown.test.ts`.

---

## 3. What Broke / Didn't Work

* **Re-framed the same day: the hero and fern bookmarks (the next item).** Both now stand in the clearing in front of the fern bank (its fronds reach z = 2.5 m), placed from a 0.5 m map of where fern fronds and trunks stand: hero (2.4, 2.0, 6.2) looking at (0.95, 6.5, −2.1), fov 70; ferns (−0.8, 1.85, 4.3) looking at (−0.3, 0.6, −0.4), fov 52. Photo-Matched (at the bank's edge) and Forest Path Walk (in the clumps behind the log) still frame fronds and a buttress; they were left as they are.
* **Hero and fern bookmarks show fern fronds, not trees.** The hero camera (0.2, 1.15, −0.4) is 1.86 m from the monarch's axis, inside its buttress flare (up to about 3 m at 1.15 m high), and 0.55 m from a fern clump's centre; the fern camera sits in the clumps around the nurse log. These framings were drawn for a different layout; re-framing them is a page change of its own (not done).
* **The "photo PBR" maps are crops of the reference photograph**, not tileable material swatches (`photo_redwood_bark_albedo` is two trunks and the forest between them; `photo_forest_floor_albedo` has ferns and moss in it). Tiled on surfaces they read as noise or painted scenery. Choosing floor, moss and fern surfaces from a material library by appearance and real-world scale would fix it (done the same day: `forest_viewer_library_surfaces_2026-11-02.md`).
* **The ferns' pinnules are single large triangles**, flat green in close-up.
* **The crowns read as broadleaf trees.** SB-Veggie's crown is grown from the crown break by space colonisation with leaf-blade clusters; the redwood entry gives more, level scaffold limbs, but the foliage is blades, not flat needle sprays. A needle-spray leaf set in the tree texture library (and the page reading it) would get closer.
* **The page's haze washes the crowns pale** (fog `0xc8c0a8` at 0.015, the airlight term toward the sun, the post pass). Unchanged.

---

## 4. Candidate Tool/Service Ideas

* **Hydration by producer, not placeholder.** The GLBs are not added to `manifests/demos_asset_manifest.json`: no mirror holds them, and the hydrator's only offline answer for a `.glb` is a pyramid placeholder (`createProceduralGlb`), which the page would draw as a forest. A `native_generator` strategy that compiles and runs the asset's committed producer (here, about 10 s) would make the demo self-hydrating without a placeholder.
* **Shared tree LOD for static pages.** The page re-implements a small part of `TreeLodController` (band choice and budget). A small browser module from `common/spatial/tree-lod-math.ts` that static demos can load would keep them in step with the viewport, including the crown cards' atlas.
* **A paid-call-free bookmark shooter.** This session hand-rolled a Playwright script that sets each bookmark and records frame time; the same for every demo page would let a tour check them all.

---

## 5. Reproduction Steps

1. From the repository root: `clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/generate_forest_procedural_3d.cpp -o build/3d-native/generate_forest_procedural_3d -lz`, then `build/3d-native/generate_forest_procedural_3d public/models/forest_hyperreal.glb` (writes the forest, `forest_hyperreal_trees.glb` and its stats).
2. Start an instance on free ports (`operate-scratchbox`) and open `http://127.0.0.1:<web>/forest_3d_viewer.html`.
3. Network shows the two GLBs and nothing under `/textures/`; the HUD reads "RENDERED (60 FPS)".
4. Press Forest Wideshot and Canopy Sunbeams: crowns from 12 m up; the canopy view looks up the far-left column into them.
