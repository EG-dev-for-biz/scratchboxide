# Process: Empire State Building benchmark in the live app

> **Recorded:** 2026-10-26
> **Status:** Verified (after fixes; see section 6)
> **Tags:** `operate-scratchbox` `benchmark` `empire-state` `3d-engine` `python-sb` `architecture` `weathering` `glb-size`
> **Target Domain:** Gemini Agent Chat / Python 3D scripts / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user made the Empire State Building the benchmark for the building generator, and set the rule that all tests run through the app.
* **Instance used:** web port `3070`, API port `3071`, tools port `3072` (own launch entry `scratchbox-cartesian-normal-snapping`, main checkout, branch `feat/cartesian-normal-snapping` with uncommitted footprint-outline and benchmark fixes).
* **Scope tested:** one plain-language chat prompt, sent three times as fixes landed:
  > Write a Python procedural script that builds the Empire State Building as a standalone model in the studio (not at its real location): the 5-storey base filling its lot, setbacks at the 6th, 21st, 30th, 72nd and 81st floors, the notched corners of the tower, limestone walls with continuous vertical piers, and the mooring mast and antenna, about 443 m to the tip. Textured, with honest provenance.

---

## 2. What Was Tested & What Worked (Verified)

* **The agent uses the new building API unprompted** — every run built six tiers with `create_building_parts(footprint=<12-point notched outline>)` joined by `stack_buildings`, and a ribbed mooring mast with `revolve_harmonic_solid(harmonic_lobe_count=16)` as an add-on, all labelled `generated`. Evidence: `build/3d-python/scene_1793032968062_i9neek.py` and later scripts.
* **The engine side is fast** — a successful script runs in 1.6–6.5 s.
* **Fixes made during the session, each confirmed on the agent's own failing scripts:**
  - *Texture images stored once:* identical images are now stored once per GLB (`scratchbox_io.hpp` multi-mesh writer), so every tier no longer carries its own copy: 81 → 12 images on the agent's model.
  - *Clear weathering skipped:* receiver triangles with no visible weathering are left out of the overlay (`scratchbox_weathering.hpp`). The overlay went from 1.16 M → 0.47 M vertices on the same script, and the result reports `clear_triangles`.
  - *Weathering texel fitted:* when the script did not choose `texel_m`, the weathering texel is coarsened until the atlas fits, and the report says so. Before this, every skyscraper failed with `weathering atlas would be 4096 x 278277 texels`.
  - *Valid names suggested:* unknown surface and weathering keys now list the valid names and suggest the closest one ("did you mean unit_color_variance?").
  - *Tiers without doors:* `entrance=False` stops upper tiers from getting a front door onto their terrace.
* **Script-level render (development check, not the test):** the benchmark script built in the scratchpad shows the stepped massing, notched corners, piers and mast at the right heights (roof deck 320 m, tip 444 m).

---

## 3. What Broke / Didn't Work

* **The viewport crashes on the result (blocker)** — after a successful script, opening the scene crashed the browser tab twice ("The last page load in this tab failed"; the tab became `data:`). The models were 107 MB (1.2 M vertices, 81 images, before the fixes) and 159 MB (2.1 M vertices, 16 images, after them). The L-plan and courtyard buildings (about 0.3 M vertices) load fine.
  - Console evidence: none, because the tab died.
  - Suspected cause: GLB size and GPU memory. Geometry is written as an unindexed triangle soup at 64 bytes per vertex (position, normal, UV, colour, tangent), so 2 M vertices is about 130 MB before textures. The biggest meshes are the weathering overlay (0.67 M), then the shaft's and base's trim (`foundation` slot, 0.4 M and 0.2 M).
* **Agent invents `color_variation`** — it did so in every L-plan and benchmark turn, costing one failed run each. The error now names `unit_color_variance`; recovery in the app is not yet confirmed.
* **A run was cut off by my own edits** — editing engine sources during a turn makes the app rebuild `scratchbox_native`, and the chat lost its server ("Can't reach the Scratchbox server"). Don't edit engine sources while a benchmark turn runs.
* **The agent's reply is lost when the tab crashes** — the saved session held only the user's message.

---

## 4. Candidate Tool/Service Ideas

* **Vertex welding and indexed output for building parts** — merge identical vertices in each part before writing; quads alone would drop vertices by about a third, and the shared edges of runs of trim by more.
* **A size gate before mounting a scene** — have `execute_3d_python_script` report the vertex count and GLB size and refuse to mount above what the viewport can hold, saying why, instead of crashing the tab.
* **Level of detail for tall buildings** — build distant tiers' trim (piers, sills, mouldings) as texture and normal map rather than geometry, so a 100-storey shaft is not hundreds of thousands of swept profiles.
* **Expandable tool errors in the chat** — the tracebacks again had to be read from `build/3d-python/*.py` reruns and session files.

---

## 5. Reproduction Steps

1. Start an isolated instance (operate-scratchbox skill) on this branch.
2. New Chat → send the prompt in section 1; about 5 minutes later the scene opens and the tab crashes.
3. To measure, rerun the newest `build/3d-python/scene_*.py` with `OUTPUT_GLB_PATH` set to a scratch path and count vertices per mesh in the GLB JSON chunk.

---

## 6. Rerun after welding and the size gate (same day)

* **Fixes:**
  - *Vertex welding:* `ScratchboxMesh::weldIdenticalVertices` merges vertices identical in every attribute, losslessly, and `write_textured_building` applies it to every mesh before writing. On the agent's earlier failing script this took 2.1 M → 1.3 M vertices and 159 → 108 MB.
  - *Size gate:* `execute_3d_python_script` refuses to mount a model over 1,000,000 vertices or 96 MB (`viewportSceneLimits`, overridable by `SCRATCHBOX_MAX_SCENE_VERTICES` / `SCRATCHBOX_MAX_SCENE_MB`). It names the heaviest meshes and how to lighten the model, instead of crashing the tab.
  - *Clearer key errors:* unknown facade details and rule fields also suggest the closest valid names.
* **Run in the app** (web 3070 / API 3071 / tools 3072, same prompt; it landed in the earlier cut-off chat, so the agent could see its previous attempt). Five runs:
  1. Python `IndentationError`.
  2. `Unknown facade detail 'pilaster_depth_m'` (no hint yet at that point).
  3. `color_variation`, now answered with "did you mean unit_color_variance?".
  4. The script succeeded at **121 MB**, and the size gate refused to mount it.
  5. The agent lightened the model and it **mounted: 33 MB, 427,428 vertices, 9 images, 443.2 m to the tip** (`build/3d-python/scene_1793034830243_br5g2z.glb`).
* **Viewport:** the tab stayed up. It shows the stepped setbacks, notched corners, continuous vertical piers, and the mast with its crown and antenna. Console: one `ERR_INCOMPLETE_CHUNKED_ENCODING` from the earlier cut-off stream, nothing from this load.
* **Still open:**
  - The agent needs several runs to recover from invented setting names. The hints now name the right key; whether the agent uses a hint on its first retry is not yet confirmed.
  - The 96 MB / 1 M-vertex limit is set from one crash at 107 MB / 1.2 M vertices and one success at 33 MB / 0.43 M. The real limit lies somewhere between, and depends on the machine.

---

## 7. Sized from measured massing (step 1 of the massing and detail plan)

* **What was added:**
  - `execute_3d_python_script` takes `site` (a building name, address or "lat, lng"). Before the script runs, `measureSiteMassing` (`packages/core/src/node/3d-engine/site-massing.ts`) measures the building. A building Google models as a 3D volume is sliced by the native scan analysis (`shape_program mode scan`) into its flat levels. Otherwise there is one tier per vector part, from its min to max height, and the fused (Solar DSM) height fills any missing height.
  - The script reads the measurement with `sb.site()`. `sb.site_tiers()` turns it into `create_building_parts` arguments: measured outline and base per tier; storeys from norms, scaled to land exactly on the measured top and labelled generated; `entrance=False` above the ground tier. Masts and spires (under 200 m²) and the antenna height above the last tier are returned separately for add-ons.
* **What Google's data holds for the Empire State Building:** one modeled volume, 441.09 m high, with an 11-point base hull, 28.4° off north (the Manhattan grid). The Solar DSM roof figure, 77.5 m above the street, is wrong for a tower and is flagged low confidence. The slicing finds the setback stack in 0.4 s:

  | Tier | Base → top (m) | Area (m²) |
  |---|---|---|
  | 0 | 0 → 22.6 | 7,728 |
  | 1 | 22.6 → 25.3 | 5,001 |
  | 2 | 25.3 → 77.6 | 4,190 |
  | 3 | 77.6 → 90.7 | 3,200 |
  | 4 | 90.7 → 110.6 | 2,707 |
  | 5 | 110.6 → 319.9 | 2,079 |
  | 6 | 319.9 → 329.4 | 656 |
  | mast | 329.4 → 380.1 | 106 |

  The antenna reaches 441.1 m. `site_tiers` gives 87 storeys to the 320 m deck; the real building has 86 there.
* **In the app** (web 3070 / API 3071 / tools 3072, a fresh chat). The prompt asked for the building "sized from the real building's measured massing (its actual setbacks and heights, not estimates)" and named no API. The agent:
  - called `location_building_shape`;
  - wrote a script using `sb.site()` and `sb.site_tiers(massing=...)`, building `plan["spires"]` as the mooring mast (329.35–380.10 m) and `above_top_m` as the antenna to 441.09 m.

  Five runs:
  1. Invented `parts.wall` (AttributeError).
  2. `color_variation`. The hint named `unit_color_variance`, and the next run no longer used the invented key: **the hint works**.
  3. Failed in the app after 8.8 s. The same script runs locally, so it most likely hit the viewport size gate (not confirmed).
  4. and 5. Succeeded. The final model is 37 MB, 511,243 vertices.
* **Viewport:** the stepped massing at the measured proportions, the shaft, mast and antenna. No console errors. The reply reports each tier's measured base and top labelled vector-modelled, with the storey split labelled generated, and sets the Solar DSM disagreement side by side rather than averaging it.
* **Still open:**
  - The model stays in the studio, not placed at the address, and the real building is not cut from the tiles (Stage 2).
  - Courtyard holes from extruded vector parts are not passed on yet (stated in the notes).
  - Storey heights are norms. Facade-grammar storey lines (step 2) would replace them where read.

---

## 8. Facade read from the real building (step 2: survey plus AI Beautify)

* **What was added:** `execute_3d_python_script` takes `siteFacade: true` with `site`. `readSiteFacade` (`packages/core/src/node/3d-engine/site-facade.ts`) produces two readings:
  - **Lower floors:** the existing Street View survey (`prepareSurveySite` + `runStreetViewSurvey`, four views), read once with the version-F facade-parameters prompt. Labelled **photo-inferred** and applied up to the height the photos legibly show: their frame top, but no steeper than 55° up.
  - **Upper floors:** the place's 3D tiles rendered square-on to the two longest walls, AI-Beautified (`buildBeautifyPrompt` + `genAiEnhanceClient`, with the Street View views as references), and read with the same prompt. Labelled **generated**, and cross-checked against a reading of the raw render: values more than 30% apart are dropped.
  - **Checks against the measured massing:** storey height must lie in 2.6–6 m, and most short tiers (from 1.5 storeys up, under 25 m) must take a whole number of storeys within 15%. Bay width must fit the longest measured wall at least twice, and the window must fit its bay.
  - **Cache:** readings are kept for 7 days per site, stored before the checks so improved checks still apply. `sb.site_tiers()` applies the readings per tier (storeys, bays, window, sill, recess, ground openings, plinth, parapet, piers as pilasters, cornice as a moulding), lists every value it replaced in the script's settings, and returns `plan["colors"]`.
* **In the app** (web 3070 / API 3071 / tools 3072, fresh chat). The prompt asked for the building "sized from the real building's measured massing and with its facade read from the real building", without naming API functions. The agent passed `site` and `siteFacade: true` itself.
  - **First run of the feature:**
    - **Lower reading, photo-inferred, 0–78 m, confidence 0.78:** ground storey 5.2 m, bays 2.8 m, window 1.4 × 2.2 m (sill 0.9 m), ground openings 2.4 × 3.8 m, plinth 1.2 m, piers and cornice, colours.
    - **Upper reading, generated, 78–380 m:** the cross-check dropped bay width (redraw 2.1 m vs raw 3.8 m), window and piers.
    - **Storey heights wrongly rejected:** 3.70 m failed on the 2.7 m one-storey step, and 3.75 m on the 9.5 m top block. Fixed: tiers under 1.5 storeys no longer vote, and a majority of the rest must fit. The model rendered (772k vertices).
  - **After the fix**, with the app restarted (the backend runs ts-node without a watcher, so TypeScript edits need a restart; Python edits apply live):
    - Lower: storey 3.7 m and bays 2.8 m accepted. Upper (a fresh redraw): storey 3.6 m and bays 2.8 m accepted, now agreeing with the raw render; window dropped by the cross-check.
    - Runs: the first was a script error at 76 s, including the facade reading. The retry took **11 s, reusing the cached reading**. The final model has 822,369 vertices, 0 floating parts, and the GLB loaded (200).
    - The agent's reply lists each tier's measured size, then each facade value with its source, label and confidence, and states the dropped window reading and why.
* **Pictures:** `desktop-app/build/site-facade/<lat_lng>/` (gitignored).
  - The raw tile render of the upper floors is better than expected: the continuous vertical piers and the crown are clear.
  - The redraw keeps the framing and the building, but invents the surrounding city and sky. That is harmless for reading, and confirms the fine detail is the image model's.
* **Still open:**
  - The facade is read for the whole building, not per wall.
  - Vertical strips with recessed spandrels (the look the raw render shows) can't be expressed by the generator yet (plan step 3).
  - The post-turn visual check fails with 413 (payload too large), already noted before.
  - The first facade reading costs about 70–80 s.

---

## 9. The crown fitted to the 3D tiles (spire, fins, drums, antenna)

* **Why:** the agent's spire was a smooth 16-lobe revolve. Google's tiles show a hard-edged stack: stepped deck tiers, four stepped corner wings, a glazed shaft, a drum ring, a narrower drum and a lattice antenna.
* **What was added:** `execute_3d_python_script` takes `siteCrown: true` with `site`. `fitSiteCrown` (`packages/core/src/node/3d-engine/site-crown.ts`) works in four steps:
  1. Crops the structure's tile triangles above the crown's base, the top of the last tier holding 20% of the footprint (319.85 m here; 16,508 triangles).
  2. AI-Beautifies a render of that crop as a reference picture for counts.
  3. Runs the existing shape program (`pipeline-e/shape-stage`, mode program, with a new `referenceImages` input) on the crop. The crown's base stands in for the street, so the height grid and the fit's views frame the crown alone: from the street up, a 120 m crown is a sliver and the silhouette check sees no detail (first try: 17.7% → 11.0% at that framing; reframed: 14.5% → 7.8%).
  4. Returns the native fit's geometry (tile frame, y above the street). Pieces whose sizes the fit moved are labelled **measured**; side counts, repeat counts and unmoved values are **generated**, and the reported silhouette disagreement is the check. Cached 7 days.
  
  `sb.site_crown()` builds the pieces as closed, flat-faced meshes ready for `write_textured_building(extras=...)`.
* **Fit on the Empire State Building** (development run, 82 s; cached afterwards). The model wrote the crown as:
  - prisms for the observation deck and three stepped setback tiers;
  - two pairs of stepped corner wings (prisms);
  - a 16-sided mast revolve, a 32-sided drum and dome, an 8-sided antenna pylon, and a 16-sided antenna.
  
  72 of 88 sizes were fitted to the tiles. Silhouette disagreement went 14.5% → 7.8% (a refit gave 17 pieces at 8.6%: the program varies run to run, the cache holds it).
* **In the app** (web 3070 / API 3071 / tools 3072, fresh chat; prompt asked for the spire "fitted to Google's 3D tiles rather than invented", naming no API):
  - The agent called the tool with `site`, `siteFacade` and `siteCrown`, and used `sb.site_tiers()`, `sb.stack_buildings` and `sb.site_crown()`.
  - The first attempt failed in `sb.site_crown()`: my bug, the native tool writes vertices as `[x, y, z]` triples, not a flat list. Fixed and the cache version bumped.
  - After the fix: one quick script error, then success: 822,941 vertices, 52 submeshes. The model loaded in the viewport, and the agent's own `audit_3d_scene_viewport` ran.
* **Comparison render** (development, clay, same cameras; `docs/screenshots/esb_crown_tiles_vs_fitted.png`, gitignored): the fitted crown matches the tile crown's silhouette (stepped base, tapering shaft with wings, drum, mast, antenna height), with hard edges where the tiles melt. Not captured: the antenna lattice, the shaft's vertical strips, and the wings' finer steps. Those are below the fit's ~0.5 m detail, so they stay with the generator's facade work and generated add-ons.
* **Still open:**
  - The prism caps are fans (fine for the convex plans written here).
  - Prism roof planes are dropped (flat tops).
  - The crown's surface takes the wall's texture, not its own (metal, glass).
  - Zooming the app viewport onto the crown was not practical with the mouse; the close comparison is the development render above.

---

## 10. Scan-led tiers and a measured score (after merging main's sb.massing)

* **Context:**
  - Merged `origin/main` (329 commits) into the branch. It brings main's scan-led massing: `sb.massing`, `scratchbox_scan_massing.hpp` and `massing-choice`, already merged to main though the supertall plan (`docs/plans/supertall-massing-shape-fix.md`) still calls it unmerged.
  - Conflicts: the README rows (both kept) and the generated stubs (regenerated).
* **What was added:**
  - **Scan for scripts:** `site-scan.ts` writes the site's isolated 3D-tiles structure (the cached staged extraction) with the street at y = 0, and the tool hands it to scripts as `site()["scan"]`.
  - **`sb.site_tiers(source=...)`:** `"auto"` takes Google's modeled volume when there is one, else the scan's tiers via `sb.massing.Scan.tiers()` (labelled measured), else the vector extrusions.
    - Scan tiers are cleaned before use. A new tier starts only where the plan area drops more than 15% below the run's smallest area, or grows 30% above its largest: a scan melts a facade's recesses unevenly, so a shaft's area flickers by about 21% while a real setback steps down and stays down.
    - Each outline's cell-grid stair-steps are simplified by Douglas-Peucker, the tolerance rising until the ring no longer crosses itself (raw scan tiers had 92–346-point rings that crossed themselves).
  - **`sb.site_score(..., plan=plan)`:** measures any built meshes against the scan with `sb.massing`'s height-balanced coverage and precision (main's thresholds 0.9 / 0.85). With `plan`, surface more than 2 m inside a tier's outline is left out.
    - Without it, the floor slabs (one per storey, ~160,000 samples here) **inflate coverage from ~0.69 to 0.99**: any scan surface inside the volume lies within the 2.5 m relief of some slab.
    - A first 0.6 m margin wrongly dropped real wall samples (the generator's cleaned outlines and window recesses sit over 0.6 m inside the raw ring in places).
* **Development scores** (same Empire State Building scan, with the fitted crown, interior left out):

  | Tier source | Tiers | Banded coverage | Banded precision | Worst band |
  |---|---|---|---|---|
  | modeled volume | 7 | 0.688 | 0.639 | 0.17 |
  | scan, first merge rule (area within 30%) | 5 | 0.709 | 0.598 | 0.10 |
  | scan, setback rule | 6 | 0.723 | 0.618 | 0.17 |

  Without the crown, the top bands score 0 coverage: the crown fit is what covers the top of the building.
* **In the app** (web 3070 / API 3071 / tools 3072, fresh chats; prompt: tiers "read from the 3D tiles scan (not the vector model)" and "measure how well the result matches the real building's scan and report the coverage and precision honestly"):
  - **First run:** the agent used `source="scan"` and `sb.site_score(..., plan=plan)` unprompted and scored 0.710 / 0.610, `explains: False`. Its own explanation found the merge rule's flaw: it "smooths over intermediate setbacks (25–78 m and 78–111 m)". The real 78 m setback is a 22% drop, the same size as the shaft's noise.
  - **After the setback rule:** 6 tiers (0–23, 23–78, 78–112, 112–296, 296–320, 320–335 m), **banded coverage 0.725, precision 0.632**, worst band 0.169, `explains: False`, 782,538 vertices. The model rendered.
  - **The agent's reading of the remaining gap:** the tiers' simplified outlines do not follow the tower's deep vertical window-court notches.
* **Still open:**
  - Neither tier source meets main's thresholds (0.9 / 0.85). The walls sit more than 2.5 m off the scan in places, likely the notches and light courts, which per-band analysis would confirm.
  - The building's facade details (piers, cornices, balconies) also cost precision.
  - Merging the regularizer from main (`footprint-regularize.ts`) into the scan outlines is not done (it is TypeScript; the Python path uses Douglas-Peucker).

---

## 11. A documented benchmark, robust scan setbacks and square outlines

* **Benchmark file:** `docs/benchmarks/empire_state_building.json` (schema `scratchbox.massing-benchmark/1`; evaluation only, nothing builds from it).
  - **Documented, each with its source** (Wikipedia, Structurae, the NRHP nomination drawn from LPC report LP-2000):
    - footprint 424 × 187 ft (129.2 × 57.0 m); a 5-storey base, then a 60 ft setback on all sides;
    - setbacks at floors 21, 25, 30, 72, 81 and 85;
    - 102 storeys; roof 1,250 ft (381 m); top floor 1,224 ft; antenna tip 1,454 ft (443.2 m); mast 158 ft above the 86th floor.
  - **Estimated, and said so:** storey height = roof ÷ storeys (3.735 m, since no floor-to-floor height is documented); setback heights = floor × storey; tolerance = 2 storeys.
* **`sb.benchmark_massing(plan, path, crown=None)`:** generic, reads any benchmark file. It scores documented setbacks found within tolerance and their errors, extra levels, the base footprint (measured along its minimum-area rectangle) and the heights.
* **Robust scan setbacks:**
  - The scan's fine levels flicker in the shaft (area 1,212 / 1,650 / 2,080 m²; even the convex hull flickers 1,400 / 1,870 / 2,390), because slices lose whole wings, not just notch depth.
  - A new tier now starts where the **largest hull in the next 45 m** falls more than 12% below the current tier's largest. A scan loses parts but rarely adds them. Each tier takes its fullest slice.
* **Square outlines:** the earlier "squaring" did almost nothing (35 → 32 corners). The scan's stair-steps run along its north/east grid, about 28° off the walls, so they read as diagonals.
  - Each outline is now filled on a 1 m grid turned to the walls' direction (the base's minimum-area rectangle, 27.7°), noise up to 2 m is opened and closed away, and the edge is traced back.
  - Short steps between parallel wall runs are folded by moving the shorter run onto the other's line.
  - Result: 8–20 corners per tier (base 122 → 8), every tier squared, all build. Before/after plan: `docs/screenshots/esb_scan_tiers_before_after_square.png`.
* **Development scores** (Empire State Building, scan tiers + fitted crown):

  | Stage | Documented setbacks found | Mean error | Banded coverage | Banded precision | Base footprint |
  |---|---|---|---|---|---|
  | modeled volume | 5 / 7 (misses 72, 81) | 2.2 m | 0.688 | 0.639 | 129.5 × 62.3 |
  | scan, area-merge rule | 5 / 7 | — | 0.709 | 0.598 | — |
  | scan, hull look-ahead, simplified outlines | 7 / 7 | 2.9 m | 0.729 | 0.801 | 131.0 × 65.3 |
  | scan, hull look-ahead, square outlines | **7 / 7** | 2.9 m | **0.734** | **0.818** | **129.0 × 62.0** |

* **In the app** (fresh chat; prompt asked for scan tiers, facade, fitted spire, then a score "against the real building's scan, and against the documented benchmark in docs/benchmarks/empire_state_building.json"):
  - The agent used `source="scan"`, `sb.site_score(..., plan=plan)` and `sb.benchmark_massing(...)` and reported: **7 / 7 documented setbacks, mean error 2.86 m**; **banded coverage 0.733, precision 0.838** (precision 1.2 points under the 0.85 bar), `explains: False`; tier footprints of 8–20 vertices.
  - Its workspace tools could not read `docs/` (the workspace is `desktop-app/`); `sb.benchmark_massing` resolves the path from the repo root itself.
  - **Viewport:** straight setback edges and square terraces, no spikes (the user's screenshot of the previous build showed jagged teeth along every setback).
* **Still open:**
  - Coverage 0.73: the worst band 0.22, the tower's light courts.
  - The base footprint is 62.0 m deep against a documented 57.0 m. The lot is 200 ft (61 m) deep; canopies or sidewalk structures likely sit in the base slices.
  - The setback heights' benchmark values are estimates (floor × average storey); the base estimate runs low because its storeys are tall.

## 12. Where the gaps are, scored shell to shell (step 1 of the generalized massing plan)

* **Asked:** a per-band "where is the gap" report, consensus outlines, walls snapped onto the scan, and outline candidates scored per height band, tested at the ESB in the app.
* **Per-band gap report** (`site_score(...)["gaps"]`): per 10 m band, the share of scan surface the build misses, split into inside and outside the tier's walls (with `plan=`), the share of built surface the scan does not support, and misses by compass side, worst places first.
* **Outline candidates per tier** (`site_tiers(source="scan")`, reported in `report[i]["outline_choice"]`). Each tier tries four outlines and keeps the best F against the scan in its own height band:
  - the weighted consensus of the tier's slices, square to the walls;
  - that consensus with its walls snapped onto the scan;
  - the fullest slice, squared and snapped;
  - Google's modeled volume at that height.

  At the ESB, snapped consensus won 4 tiers, the snapped fullest slice 3, plain consensus 3 and the modeled volume 1. A candidate the generator would refuse (it emulates the generator's tidying, then the crossing check) is never chosen. The generator's own crossing test now uses double precision with a relative tolerance, so walls that are nearly collinear no longer fail it as false crossings.
* **What the gap report found:** the misses were nearly all "inside walls" (48% at 50–60 m). Plots of the scan showed why: the ESB's structure in the tiles is built from **overlapping boxes**, and every box keeps its own walls and floors inside the union (vertical sections show nested shells to 110 m). No exterior massing can lie on those, so they capped coverage whatever was built.
* **Fix, general to any building: score outer shell against outer shell** (`_outer_shell_interior`, used for both sides).
  - Per 1 m slice, air is outside when a flood from the border, or from open sky, reaches it. A sample is on the shell when outside air lies within 2 m, or when it is the highest surface in its column (roofs and setback terraces).
  - Courts open to the sky stay on the shell. The scan's result is cached beside its GLB.
  - Two slips found by plotting and fixed:
    - **False sky:** a 1 m column the roof sampling skipped looked open, so the flood leaked inside. Column tops now take the highest sample within a cell (courts 3 m or wider still read as open).
    - **Hidden terraces:** a terrace filling its whole slice read as interior; the highest-in-column rule restores it.
  - The build side replaces the old plan-based slab filter. That filter missed the roof under the next tier and the next tier's floor slab, which inflated "extra" surface in every setback band.
  - `site_score` now takes building parts directly (it used to need `list(parts)`); `interior_margin` is gone.
* **Development scores** (scan tiers + fitted crown):

  | Stage | Banded coverage | Banded precision | Explains (0.9 / 0.85) |
  |---|---|---|---|
  | before (all scan surface, plan slab filter) | 0.729 | 0.852 | no |
  | scan shell v2 (leaky sky test) | 0.831 | 0.817 | no |
  | scan shell v3/v4 | 0.995 | 0.811 | no |
  | **shell against shell** | **0.990** | **0.905** | **yes** |

  Benchmark unchanged: 7 / 7 documented setbacks, mean error 2.86 m, base 128.8 × 59.3 m (documented 129.2 × 57.0).
* **Negative controls** (the score must still fail wrong massings):

  | Massing | Banded coverage | Banded precision |
  |---|---|---|
  | base outline extruded to the roof | 0.07 | 0.05 |
  | right setbacks, but stops at 113 m | 0.27 | 0.24 |
  | every tier 15% too wide | 0.63 | 0.24 |

* **In the app** (ports 3070 / 3071 / 3072; fresh chat, the same prompt as section 11 plus "including where its gaps are"):
  - The agent used `source="scan"`, `siteFacade`, `siteCrown`, `sb.site_score(parts, extras, plan=plan)` and `sb.benchmark_massing(...)`. It reported **banded coverage 0.990, banded precision 0.913, `explains: true`** (162,250 scan shell samples; 237,749 scan and 243,164 build interior samples set aside), and **7 / 7 setbacks, mean error 2.86 m**, base 128.8 × 59.3 m, antenna tip 441.1 m (documented 443.2).
  - It read the gap report correctly: 39 of 45 bands miss nothing; the largest miss is 8% below street datum (sloping grade), then 1.2% at the 113 m step. It also reported each tier's winning outline candidate.
  - Its first script failed and the second, with weathering dropped, succeeded (819,792 vertices). This is the viewport size limit from section 6, not this change.
  - The post-build visual check failed with HTTP 413 (`PayloadTooLargeError` in `desktop-app/server/app.ts`): the check's upload is over the JSON body limit. Not caused by this change; logged as a candidate fix.
  - **Viewport:** the textured model renders, with square setbacks and the fitted crown.
* **Open:**
  - `worst_band_coverage` stays 0.51. That is a thin band at the ground or the antenna; no 10 m band misses more than 10%.
  - Narrow notches under about 2 m wide can be set aside with the interior. Where the filter slips, it keeps some interior, which lowers the score and never flatters it.
