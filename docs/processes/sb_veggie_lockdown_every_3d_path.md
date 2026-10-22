# Process: SB-Veggie locked down as the vegetation generator of every 3D path

> **Recorded:** 2026-10-22
> **Status:** Verified (imagined scene through the live chat: 4 SB-Veggie trees grown, textured, under the tree level-of-detail controller); object-spec crowns and doc-to-3D morphs verified by tests only
> **Tags:** `operate-scratchbox` `sb-veggie` `vegetation` `tile-vegetation` `sb-python` `tree-lod` `provenance`
> **Target Domain:** Generative Canvas / 3D Viewport, sb Python engine, Gemini agent tools

---

## 1. Session Context

* **What prompted this session:** the user asked (2026-10-22) that "our sb-veggie method is implemented in 3d scenes, it should be locked down as a solution for any 3d scene": the staged-location tree method (tile_vegetation plant: space-colonisation skeletons inside the crown, SB-Veggie leaf clusters through scratchbox_tree_lod.hpp, the species and tree texture libraries, the four viewport levels of detail) must be what every agent-reachable 3D path uses.
* **Instance used:** own launch entry `scratchbox-sb-veggie-lockdown`, web port `3190`, API port `3191`, tools port `3192` (worktree `.claude/worktrees/sb-veggie-lockdown`; the user's `scratchbox-dev` was not touched).
* **Scope tested:** a chat request for an imagined garden with trees (the sb Python route), the scene it opened, and the viewport's handling of the trees in a generated (script) GLB.

## 2. What changed (one method, enforced in code)

* **One grower for described crowns.** `scratchbox_sb_veggie_grove.hpp` turns trees described by measurements (trunk base, height, crown radii, crown base, where the crown is widest, the top's superellipse exponent, trunk radius, leaf colour, free-text label) into the crowns.json the strip writes and runs the same `plant()` + `writeTreesGlb()` a staged place uses (species library by crown measurements, tree texture library by appearance, four levels). Every such tree is labelled `generated` (measuredGeometry false, confidence = share of the described crown its leaves fill), never "grown to the measured crown". Reached through `tile_vegetation grow` (TS `TileVegetationService.grow`) and the Python binding `scratchbox_native.vegetation.grow_described_trees`.
* **sb Python.** `sb.create_tree(position=, height=, crown_radius=, crown_base_height=, crown_widest_at=, crown_top_exponent=, trunk_radius=, leaf_color=, label=)` returns an `SbVeggieTree`; `scene.merge(tree)`, `world.add(tree)`, `world.scatter(tree, ...)` hold it, moving the holding mesh moves it, and `sb.io.write_glb` / `World.compile_to_glb` grow every held tree natively and merge the trees GLB into the scene GLB (scene extras `sbVeggie`, `sbTrees`). Retired from the module: `nature.generate_tree`, `generate_tree_components`, `generate_lsystem_tree`, `SpaceColonizationConfig`, `LSystemTreeParams`, the `plant` presets submodule, `io.write_botanical_glb`, `sb.PlantPreset` / `sb.Flora`. Old growth knobs (`attractor_count`, ...) raise a TypeError naming the SB-Veggie parameters; the script type check rejects the removed names before a script runs.
* **The vegetation tool.** `botanical_synthesize_tree` grows one tree or a `trees` group through `grow`, opens them as a scene, sits in the core pack and the chat's entry set, and says it is the vegetation generator for any scene.
* **Object specs.** A fifth part operator `crown` (a root part grown as an SB-Veggie tree from its envelope); the build check counts each grown tree as one piece and reads trees at their far level.
* **Refusals.** C++ generator sources that use the retired engine tree symbols are refused by `/3d/compile` (422 `vegetation_outside_sb_veggie`); viewport scripts that call `generateProceduralThreeMeshFromPrompt` are not run, and that helper builds no trees and is no longer in the script scope (`common/spatial/sb-veggie-lockdown.ts`).
* **Doc-to-3D morph.** The nature theme is an sb Python scene (terrain, monolith, five SB-Veggie trees) instead of C++ L-system oaks; the embedded city/architecture/spatial scripts use `sb.create_tree`; the primitive tree stand-ins (cylinder conifers, sphere shade trees) are gone; the placement engine places `SbVeggieTree` actors, not cones.
* **Viewport.** A generated (script) GLB that carries SB-Veggie trees now gets the `TreeLodController` and the tree textures, as staged trees layers did (see 3).

## 3. What Was Tested & What Worked (Verified)

* **Imagined scene through the chat** — typed "An imagined quiet garden: a low stone wall, a gravel path, a bench, and a few trees around it (a broad oak-like tree, two narrow conifers and a small shrub)." → the model loaded the script guide and ran `execute_3d_python_script`; its script called `sb.create_tree(` four times (`broad_oak`, `conifer_tall`, `conifer_second`, `small_shrub`). Evidence: `window.__SB_TREE_LOD__.controllers()` → 1 controller holding 4 trees; renderMode `pbr`; tree texture requests `/assets/textures/trees/leaves/leaves_01/color.jpg`, `bark_02`, `bark_04` ... all 200. Screenshots `docs/screenshots/sb_veggie_lockdown/02_after_lod_textured_garden.jpg`, `03_garden_trees_closeup.png`, `04_garden_trees_orbit.png`: a broad round-crowned tree, two narrow columnar conifers, a small shrub, textured bark and leaves, standing on the lawn beside the wall, bench and path.
* **Unit / integration tests** (credentials unreachable): `sb-veggie-lockdown.test.ts` (10 tests: grove script GLB carries 3 trees, 4 levels each, `generated` provenance with confidence, species and texture choices, stems where described; `execute_3d_python_script` reports `vegetation` and passes its structure check; retired APIs absent; C++ / script refusals; morph scripts; object-spec crown built and measured), plus the updated suites listed in the commit.

## 4. What Broke / Didn't Work

* **Generated GLB trees had no level-of-detail controller (fixed in this session).** First load of the garden: every level of every tree drawn at once, trees white and solid (`01_before_viewport_lod_all_levels_stacked.jpg`); `controllers().length` was 0. Cause: `Scene3DPrimitive.tsx` attached `TreeLodController` only to scene objects loaded by URL, not to the generator GLB (`scratchbox-cpp-generated-root`). Fixed; after a reload the same scene shows textured trees at one level each.
* **Console:** a burst of `Failed to load resource: net::ERR_CONNECTION_REFUSED` after the page reload; not traced (no failed request remained in the network log afterwards).
* **Look, honestly:** the narrow conifers read as sparse columns (bare limbs visible through the crown) rather than dense firs; the species library chose its closest entries for a 0.05 widest-at cone. Not tuned here.

## 5. Not changed (listed, as asked)

* **Staged-location honesty fallbacks stay:** crowns the regrown tree does not fill are kept as scanned (`not_regrowable`, LINES ring), trees outside the region of interest stay scanned (`outside_roi`), trees whose support is undecided stay scanned (`support_undecided`), and when the tree stage fails the scanned trees are put back (`removedTreesGlb`, labelled as scanned).
* **Engine code kept for internals and tests:** `scratchbox_nature.hpp` (L-system, bare space colonisation), `scratchbox_plant_builder.hpp`, `scratchbox_botanical_pipeline.hpp`; not reachable from scripts, generator code or viewport scripts.
* **Unwired services left in place (no production caller):** `BotanicalVegetationService`, `SbVeggieService` (`run_sb_veggie`), `Adaptive3DSceneSynthesizer` (its C++ template uses `SbVeggieModelBuilder`, which the generator check now refuses on `/3d/compile`).
* **Ivy** (`sb.create_ivy`) is not a tree and is not SB-Veggie.

## 6. Candidate Tool/Service Ideas

* **Scene GLB inspector endpoint** — `GET /3d/scene/trees` returning the open scene's tree controllers, their levels and texture choices; this session read them through `window.__SB_TREE_LOD__` in the page.
* **Trees at a real place from a request** — an object spec `crown` part at a location is not wired into placement (the place's own trees come from `google_3d_tiles_get_clay`); a planted-tree placement path would close it.

## 7. Reproduction Steps

1. Add a launch entry on free ports running this worktree (`SCRATCHBOX_NO_ELECTRON=true`, `PORT`, `SCRATCHBOX_WEB_PORT`, `SCRATCHBOX_TOOLS_PORT`, `SCRATCHBOX_ALLOWED_ORIGINS`), start it, open the logged token URL.
2. Prompt: "An imagined quiet garden: a low stone wall, a gravel path, a bench, and a few trees around it (a broad oak-like tree, two narrow conifers and a small shrub)."
3. In the page console: `window.__SB_TREE_LOD__.controllers().map(c => c.stats.trees)` → `[4]`.
4. Tests: `env -i HOME=/tmp/empty-home SCRATCHBOX_HOME=/tmp/sb-test PATH="$PATH" npx vitest run packages/core/test/sb-veggie-lockdown.test.ts`.
