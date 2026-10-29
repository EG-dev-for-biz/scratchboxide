# Process: ESB pipeline K facades with library roughness, metalness and normals per appearance region

> **Recorded:** 2026-10-26
> **Status:** Unverified (the region split and the bake work, and the three variants load in the app with the maps confirmed in the live scene; the visual benefit could not be judged, because a plain 3D scene is lit only by the fixed studio rig, with no sun to make glass glint)
> **Tags:** `operate-scratchbox` `pipeline-k` `texture-library` `pbr` `material-regions` `empire-state`
> **Target Domain:** 3D Viewport / staged location output (pipeline K) / texture library

---

## 1. Session Context

* **What prompted this session:** the user asked whether imagery can be "elevated" into full PBR materials (albedo, roughness, metalness, normal). The research found that single-image estimators (CHORD, PATINA, RGB↔X) are trained on close-up swatches and that `scratchbox_material_maps.hpp` already does the library half (pick a set by appearance and tint it). The user then asked for a test of the missing two steps on the ESB pipeline K build: split each facade into appearance regions, and keep the K photo as the colour while the library supplies roughness, metalness and normals per region.
* **Instance used:** web port `3470`, API port `3471`, tools port `3472` (own `scratchbox-material-regions` entry in `.claude/launch.json`, main checkout, branch `feat/cartesian-normal-snapping`).
* **Input:** the cached ESB pipeline K remesh polish (`.scratchbox/cache/tile_refine/c14a1cb6…/polish/54f7e1d59874e8b1/textured.glb`, 185 meshes: 51 `facade_lattice_<id>` rebuilt facades textured with their rectified K photo, 133 scan pieces, 1 base skirt) and its `relief_orthos_k_fd680ca2ff8f63dc/facades.json` (metric frame per facade, 7.7 cm photo pixels).

## 2. Method (prototype, not wired into the pipeline)

1. **The K GLB shows every photo unlit** (`KHR_materials_unlit`), so roughness, metalness or a sun had no effect on it. Every variant below is first made lit (unlit removed).
2. **Appearance regions:** k-means (k = 4) in CIELAB on 40,000 texels sampled from each facade photo, one set of classes for the whole building, then a 3 x 3 majority filter. Classes (by lightness): L 15 (24.8% of facade texels), L 31 (32.1%), L 51 (22.0%), L 70 (21.0%). On facade 16 they land on the darkest window panes, the dark bay (spandrels and mullions), panes reflecting the sky (plus some pier edges), and the limestone piers (`facade16_photo_vs_regions.png`).
3. **Library match:** for each class, the 8 nearest cached sets by CIELAB ΔE against the engine-measured set colour (`build/texture-library/stats/`). The sets were chosen from those shortlists by hand in this test; in the app the agent would choose them:
   * piers (L 70): `exterior_wall_cladding_03` (ΔE 3.8, roughness 0.65, 1.96 m tile);
   * dark bay (L 31): `MetalPlates013` (ΔE 5.3, roughness 0.56, metalness 0.90, 1.6 m);
   * panes (L 15 and L 51): `Facade001`'s roughness only (0.06), metalness forced to 0 and normal flat. The library has no set that fits glass: `Facade001` is a whole curtain wall with metalness 0.89, and on a dark pane colour that metalness turns the panes into near-black mirrors. Its normal map draws its own mullion grid at an unknown pitch.
4. **Bake:** per facade, the set's normal and packed occlusion/roughness/metalness map, box-filtered to the facade's texel (a 1.6 m tile is about 21 texels at 7.7 cm) and tiled at the set's real size, selected by the class map, written as a normal texture and a metallic-roughness texture on the facade's own UVs. The scan pieces (atlas UVs, no metric frame) get each class's mean roughness and metalness only. The photo stays the colour map, labelled `photo-inferred`; roughness, metalness and normal are labelled `generated` in the material extras. 42 s for the whole building.
5. **Variants:** `A_lit.glb` (photo only, lit, roughness 1, metalness 0; 43 MB), `B_regions.glb` (regions as above; 61 MB), `C_regions_nometal.glb` (as B, with the dark bay's metalness 0 so the photo colour stays the diffuse colour; 60 MB).

## 3. What Was Tested & What Worked (Verified)

* **Loaded in the app:** the chat prompt asked for a scene with A and B side by side; `mount_canvas_primitive` mounted it. Read from the live three.js scene: A has 185 `MeshStandardMaterial` with no maps; B has a roughness/metalness map on 183 materials and a normal map on the 51 facades. Scene environment map present (intensity 0.6).
* **Same-camera comparison:** in the console, the variants were moved to one position and shown one at a time, so every capture shares the camera (`test-results/screenshots/material_regions/`: `front_A_photo_only.jpg`, `front_B_regions.jpg`, `oblique_A_photo_only.jpg`, `oblique_B_regions.jpg`, `close_A_B_C.png`).
* **What the pixels show (studio light):**
  * B against A: the biggest change. The bays go dark brown-black and the panes read as glass catching the sky, so the tower reads deeper. But the darkening comes from metalness 0.9 discarding the photo's diffuse colour (a metal has none), not from a measured material, and the bays lose their photographed colour and detail.
  * C against A: nearly the same. The panes catch slightly more light. Under the studio rig, roughness differences between dielectrics barely show.
  * Piers: the same in all three. The stone grain from the library normal is invisible at this distance (the tile is about 25 texels across).

## 4. What Broke / Didn't Work

* **No sun in a plain 3D scene.** The prompt asked for a sun at elevation 25° and azimuth 220°. The agent wrote `sunElevationDeg` / `sunAzimuthDeg` (the schema fields are `sunElevation` / `sunAzimuth`), and in any case a scene without a location is lit by the fixed studio rig (`lightingRigs.ts:94`, Studio_Key / Fill / Top). Sun direction is used only by the atmosphere path (`syncAtmosphere.ts`) of staged locations. So the main thing this method is for, glass glinting against matte stone under a moving sun, was never shown.
* **The agent's add-a-model call failed, and its reply read as a success.** Asked to add C, both `mount_canvas_primitive` calls failed with "An object in payload.objects cannot be drawn: esb-a-lit (it has no content.durableUri)". The reply said the scene was updated. The saved scene (v2) did include C, but the open viewport kept showing v1 until a page reload, and the app's visual check judged the stale view ("only two visible instances despite expecting three").
* **The library has no glass.** Region matching by colour cannot find a glazing material. The only glazing-like set (`Facade001`) carries a whole curtain wall's metalness and mullion normals. Glass had to be set by rule (low roughness, metalness 0, flat normal).
* **Library metalness does not transfer through a photo albedo.** A metal's photographed colour is its reflection, not paint. Setting metalness 0.9 under the photo's colour discards the photo colour (variant B).
* **Viewport zoom goes to the scene target, not the cursor** (already noted in `pipeline_k_straightened_scan_esb.md`). Framings needed the variants moved to the origin.

## 4b. Follow-up the same day: limestone getting metalness

* **Reported by the user** (`user_report_metal_on_limestone.webp`): silvery-white blotches on the limestone of the upper setbacks in B.
* **Cause:** the regions were split by colour alone. Shaded or weathered limestone falls into the dark-bay class, which carries `MetalPlates013`'s metalness 0.9, and those texels mirror the studio sky. Everything above 290 m is scan pieces (`relief_m*`), not rebuilt facades, and B gave scan pieces each class's mean finish wherever the class fell.
* **Fix (B2, `B2_regions_gated.glb`):** colour still picks the finish, but metal and glass are allowed only where a measurement or the facade's structure says there is an opening; everywhere else gets the stone finish.
  * Scan pieces: only texels on triangles the remesh measured as recessed (`_RELIEF_HEIGHT` < -0.1 m, the lattice cells), rasterised into each piece's UV space. That is 1-2% of their surface: the scan's measured recesses are thin reveals, not whole bays. So the upper tower's windows lose glass and metal too, since the scan cannot tell them from stone there.
  * Rebuilt facades: the rebuilt geometry is flush (median depth 0 from the fitted plane), so it cannot gate. The bays are read from the photo's own structure instead: pier columns (stone class most of the way up) and stone bands (most of the way across) are excluded, labelled photo-inferred. This keeps 74-82% of a facade as possible openings and demotes 6-8% of texels to stone.
* **Measured on the textures:**

  | | B | B2 |
  |---|---|---|
  | Metal texels, upper tower (above 288 m) | 816,350 | 84,294 (-90%) |
  | Light stone texels with metal, upper tower | 2.07% | 0.09% |
  | Metal texels, whole building | 11.9 M | 4.3 M |

* **In the app** (B2 added by the agent with an explicit `durableUri`, which loaded first time): `upper_B_metal_on_stone.jpg` shows the silver blotches on the stone; `upper_B2_gated.jpg` shows none. The frames are not pixel-matched: the camera moved between captures with no input from this session.
* **Still open:** on a rebuilt facade whose piers are not clearly lighter than its bays, the photo-derived bay mask lets mottled metal through (`upper_B2_gated_bay_mottling.jpg`). Together with the earlier finding that library metalness under a photo colour discards the photo, this argues for not taking metalness from a colour match at all: give openings glass only (low roughness, metalness 0), and leave metal to a measurement or an explicit choice.

## 4c. Follow-up: the facade bay mask tightened by the photo's pier rhythm (B3)

* **The user's call:** keep metal for the bays, but tighten the photo bay mask on facades where the piers are not lighter.
* **What B2's mask got wrong** (`b2_metal_mask_failing_facades_1.png`, `_2.png`, metal in magenta): with no light pier columns found, B2's mask treated the whole facade as bays. Facade 46 (a brown wall with punched windows) went metal across the wall; 76 (the base: people, trees, grey wall) mostly metal; 7, 12 and 20 (narrow returns in shadow) and 45 (a terrace plane rectified as a facade) largely metal; 80 and 81 (parapet bands) in streaks.
* **Tried first and dropped:** a texture signal (piers are smooth top to bottom, bays change every storey). It called 60-90% of columns smooth even on facade 16, because the mullion and spandrel strips inside the bays are smooth too.
* **The rule (B3, `B3_regions_rhythm.glb`):** a facade gets openings only when its photo shows a pier rhythm:
  * the column-lightness profile, against a 12 m running mean, repeats at a 2.5-9 m pitch with NCC >= 0.6;
  * the piers are at least 30 lightness units lighter than the bays;
  * the facade is at least two pitches wide.

  On those facades the openings are the columns darker than their local 12 m mean, minus stone bands. Every other facade gets the stone finish only (no metal, no glass). The rhythm, pitch and contrast are recorded per facade in the bake report.
* **Which facades pass:** the main tower faces score NCC 0.65-0.96 at a 5.3-5.6 m pitch, matching K's own rectifier pitch (e.g. 48: 0.92 at 5.54 m, K 5.54 m), with contrast 68-100. The failing facades score 0.00-0.57 or contrast 12-38. 17 of 51 facades pass: 16, 23, 26, 30, 34, 36, 37, 38, 39, 48, 49, 50, 51, 62, 63, 78, 79. All eight failing facades above are excluded. Some genuine tower faces with a 3.5 m pitch and NCC 0.49 (5, 24, 32) are excluded too, so this rule is conservative.
* **Measured on the facade textures:**

  | | B | B2 | B3 |
  |---|---|---|---|
  | Metal texels | 4.49 M | 4.29 M | 2.12 M |
  | Light stone texels with metal | 1.54% | 1.45% | 0.18% |
  | Metal on the eight failing facades | 439,986 | 434,757 | 0 |

* **Per facade** (`b3_metal_mask_16_30_46_76_23.png`): on 16, 30 and 23 the metal sits in the bays and the piers are clean; 46 and 76 have none. One small block remains at the foot of facade 16, where its lower setback breaks the column rhythm.
* **In the app:** B3 was added by the agent (explicit `durableUri`) and loads (`b3_in_app.jpg`). No pixel-matched B2/B3 pair could be captured: the camera kept moving between and during captures with no input from this session. The textures and the per-facade sheets are the evidence for this step.

## 4d. Material regions as a pipeline K stage, and the window relief moved after the fixes

* **Material regions in K** (`pipeline-k/material-regions.ts`, `material-sets.ts`, in `tileRefineTwin` after harmonising; the library comes only from the app's deps, `deps.pipelineK.materialSets`). Glass is the facade material reading's tile-only test, pulled out as `latticeGlassAgreement` and shared, written in the reading's format (`extras.sbMaterial`), so the viewer's reflection probe applies. The viewer's environment gate (`facadeMaterialLook.ts`) now lets metal texels (parameters B > 0) see the environment as well as glass. Tests: `pipeline-k-material-regions.test.ts` (4).
* **In the app, run `8bbe1298`:** 15 of 51 rebuilt facades with openings; glass 2.7% of texels; **metal 0**. The library search chose `concrete_floor_worn_001`, `Asphalt020S`, `Travertine014` and `PavingStones108` by colour alone: none metallic, and floor or paving sets on walls. The set choice needs more than colour.
* **Where the window ledges came from** (the user's clay screenshot, `before_relief_in_tile_refine_clay.png`): tile_refine's photometric relief (`scratchbox_photometric_relief.hpp`) carves the photo's dark cells into the scan. Ledge-sized horizontal faces above 60 m: 12,332 triangles in the raw remesh, 44,169 after the relief (36,616 touching a carved recess), 1,758 more from the lattice's own steps. Its depths are photo-inferred (the header says so); the first version of the material-regions docs called them measured, corrected.
* **The relief moved after the fixes** (user decision): for K, tile_refine's relief analyses and exports the orthos but carves nothing (new `ReliefParams::carve`, CLI `--relief-no-carve`, `TileRefineRequest.reliefCarve: false`). The facade lattice then recesses each row's repeated windows as the straightened, infilled photo shows them, by the relief's own contrast rule (`PHOTO_RECESS`: 0.15 m at 10% darker than the row's wall, up to 0.25 m at 35%, smoothstep), never shallower than the scan measures, labelled photo-inferred in the facade's provenance. Tests: `pipeline-k-photo-recess.test.ts` (5, including the native CLI on the ESB test tile: the same facade orthos as the carving run, no region treated, every `_RELIEF_HEIGHT` 0).
* **In the app, run `2ae6d42b`:** tile_refine analysed 86 regions and carved none (recess area 0); the polish rebuilt 51 facades, 19,225 cells, **8,118 window cells recessed from the photo on 49 of 51 facades**; material regions on top (glass 814k texels, 15 facades with openings, metal 0). The live scene: 183 materials with the roughness/metalness maps and the reflection probe, 51 with normals, a shadow-casting sun. Clay under the sun (`after_lattice_photo_recess_clay_sun.jpg`, `after_clay_sun_tower.jpg`): the piers continuous and the bays recessed between them; the scattered ledges are gone.
* **Still open:**
  * the photo recess is per row on the darker class, so it recesses the bay strip as a whole; it does not separate a window from the spandrel below it;
  * glass regions are colour blobs, not window rectangles, and read as grey blotches close up (`glass_regions_blotchy_close.jpg`);
  * the first load of the new twin failed with `net::ERR_INSUFFICIENT_RESOURCES` (a browser tab after more than 5,700 requests); a reload loaded it;
  * the build ended degraded for an unrelated reason: the scan-fitted rebuild failed its gates.

## 5. Candidate Tool/Service Ideas

* **A sun in non-location scenes.** Honour `environment.sunElevation` / `sunAzimuth` (or a directional key from them) under the studio sky. This test needed a sun to judge glass and had none.
* **Material regions as a pipeline K stage.** Run the region split and library bake in the remesh polish, on the facades it rebuilt, with the regions' sets chosen by the agent through `texture_library_search` and recorded in the GLB extras. Then judge it inside the staged location, with its own atmosphere and sun.
* **A glazing entry in the texture library, or a measured rule for openings.** The lattice's measured recessed cells (`facades.json` cells, height about -0.25 m) mark the openings. A glass finish (roughness about 0.05, metalness 0) could follow from that measurement instead of from a colour match.
* **An A/B toggle for scene objects in the viewport.** Show one of several co-located variants. This session did it from the console.

## 6. Reproduction Steps

1. The bake script lives in this session's scratchpad (`bake_regions.py`, not committed). Run it with the K polish GLB, its `facades.json`, `build/texture-library`, `assets/textures/library/index.json`, an output folder and `-`; it writes `classes.json` (classes and shortlists) and class maps for facades 16 and 48. Run it again with an assignment JSON (class → set, plus `tileM` / `metal` / `flatNormal` where the library lacks them) to write `A_lit.glb` and `B_regions.glb`.
2. Copy the GLBs to `desktop-app/public/models/esb_material_regions/` (gitignored).
3. Start an instance on free ports and send: "Create a 3D scene with two existing models side by side, no new geometry: /models/esb_material_regions/A_lit.glb at x = -120 m and /models/esb_material_regions/B_regions.glb at x = +120 m".
4. In the console, move the external-object groups to one position and toggle `visible` to compare under one camera.
