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

## 13. Textured from the texture library

* **Asked:** a better-textured Empire State Building in the app, using the texture library bucket (gs://scratchbox-library-training-textures: about 2,500 ambientCG and Poly Haven PBR sets, mostly 8K, no index).
* **Built:**
  - **`librarySets` on `execute_3d_python_script`** (`texture-library.ts`): fetches the named sets with the app's service account, downloading only the maps a GLB uses (colour, OpenGL normal, roughness, occlusion, metalness or a packed ARM map) into `build/texture-library/`. Set names come from the bucket's folder listing (2,532 sets, cached a week). A missing name, or a set with no colour map (Poly Haven `granite_wall` has none), is reported with the closest names.
  - **Native map preparation** (`scratchbox_material_maps.hpp`, `sb._native.surface.prepare_material_maps` / `remap_png_channels`): decodes, area-resamples to at most `max_size` (colour in linear light, normals renormalised), packs ORM and returns the mean colour and roughness. The PNG decoder now reads 16-bit samples (library normals and displacement) and 1-, 2- and 4-bit greys and palettes (Facade001's metalness is 4-bit). Decodes checked against Pillow on the source maps.
  - **`sb.library_surface(candidates, tile_m, target_color, target_roughness)`:** picks the candidate nearest the measured colour and finish, then bakes the colour (linear light) and roughness into its maps. glTF factors can only lower a map's values, so both are baked rather than set as factors. The surface is labelled `generated`, and the tile size is reported as an estimate.
  - **Roughness matters:** by colour alone, the polished travertine sets won (Travertine001 mean roughness 0.03, a flat normal map), which would put mirror-finish stone on a matte limestone facade. Ranking now weighs colour and roughness together.
* **In the app** (fresh chat: matte stone for the walls matched to the read colour, a darker stone for the base, metal for frames and spandrels):
  - The agent named exactly the example sets from the tool description (Travertine003, PaintedPlaster012, Concrete034, Granite004A, Marble012, Metal032, PavingStones070, Rock030). They are reasonable, but they come from the description, not a search of the library.
  - **Chosen:**
    - walls: **Concrete034** (distance 0.35; Travertine003 lost as polished, roughness 0.03), tinted to the read wall colour and remapped to roughness 0.82;
    - base: **Rock030** (distance 0.08; Granite004A lost as warm and polished);
    - frames: **Metal032** (distance 0.09).
  - Its first script failed: a 249 MB GLB from moulding profiles, over the viewport's 96 MB limit. The retry (1K maps, no mouldings) built at 819,792 vertices and 68 MB, of which the 9 library maps are about 10 MB. The scan score is unchanged: 0.990 / 0.913, explains.
  - **Viewport:** up close the piers show a stone grain and the spandrels read light (`docs/screenshots/esb_library_textures_closeup.png`). From a distance the tower still reads as an even grey (`docs/screenshots/esb_library_textures_tower.png`); tile-scale texture does not show at that range.
* **Open:**
  - A searchable index (colour, roughness and real tile sizes per set) so the agent searches the library instead of using the description's examples.
  - The tile sizes are the agent's estimates.
  - The visual check's 413 is still open.

## 14. Our colours against the 3D tiles' photo colours

* **Method** (development analysis, scratch script `scan_colour_compare.py`):
  - The scan side is the staged extraction's textured tiles (198 leaves, JPEG, unlit), shifted to the street at y = 0.
  - About 738,000 photo samples lie within 3 m of the build. Each takes the tier and part of the nearest built surface and its facing: walls by compass side, or up-facing (roofs and setback terraces).
  - Per region, the tiles' lit colour (the `litColour` method: an Otsu split of sun and shade, lit side kept) is compared with what our model shows at the same points, as CIELAB ΔE with the lightness and chroma split.
  - Builds compared: the in-app procedural-courses build and the library-texture build.
* **Picture:** `docs/screenshots/esb_scan_vs_build_colour.png`, the long west elevation: tiles, library build, procedural build.
* **Findings:**
  1. **The tiles' facade is warmer and darker than the Street View wall colour we used everywhere.** Tiles walls average about sRGB (0.52, 0.47, 0.45), a warm tan. The Street View reading was (0.65, 0.63, 0.59), so our wall part sits about 15 L* lighter (ΔE 15).
  2. **The facade reads as vertical stripes in the tiles** (light piers, dark window columns), not as one stone colour. Our builds show neither the contrast nor the warmth.
  3. **"foundation" is not a base.** In the generator it holds the plinth and every horizontal trim piece (sills, lintels, string courses, cornices) on every floor; each tier's foundation spans its full height (T4: 113 to 264 m, 137k vertices). The agent's "dark granite for the base" therefore put dark stone on every sill and cornice of the tower, which is why the library build reads dark grey everywhere (ΔE 11–18 for that part).
  4. **Colour changes with height.** T2/T3 are lighter (about 0.61–0.66), the shaft darker (more window per metre), and the observatory tiers T8/T9 bright and slightly cool (about 0.68–0.75, the metal and glass of the 86th floor). One wall colour cannot match all of these; our upper tiers are 12–30 L* too dark.
  5. **Setback terraces:** their surfaces are tiny untextured "roof" parts in a bluish grey (0.57, 0.58, 0.60) the agent never set. The tiles' terraces are warm, close to the walls below them, and bright on the observatory decks.
  6. **Glass:** ours is light blue (0.54, 0.63, 0.67). Where the tiles see windows they are warm dark grey (ΔE 17–18).
  7. **What matched:** the frame and spandrel metal (ΔE 2.7) and the crown (ΔE 3.6), both tinted to the Street View trim colour.

## 15. A searchable texture library index (texture_library_search)

* **Asked:** finish the index of the texture library bucket and make the in-app agent search it instead of copying the example set names from the `librarySets` description (section 13).
* **Built:**
  - **Index** (`assets/textures/library/index.json`, schema `scratchbox.texture-library/1`, `scripts/build_texture_library_index.ts`): one entry per bucket set with the publishers' metadata only (real tile size, tags, description, preview links) and the bucket's map names. It builds in about 17 s and downloads no images. 2,532 sets, 2,508 with a colour map (24 without, e.g. `granite_tile_02`, `granite_wall`; never offered), 875 with a publisher-measured real size, plus 2 with only a width, whose height is derived from the preview's aspect once measured. The other 1,655 have no size because their publisher gives none: the ambientCG API returns 0 x 0 cm for them (checked for Asphalt001). They stay unknown, with a note.
  - **Measured on demand, not for the whole library** (user decision, 2026-10-26: "only the textures we need"). A first build had measured every set's previews: 4.5 GB of previews for 2,479 sets. That cache was deleted. Now `texture_library_search` measures colour (linear sRGB and CIELAB mean and spread), roughness and metalness with the engine (`prepare_material_maps`) only for the not-yet-measured sets in its own pool: at most 40 per search, nearest the wanted tile size first. It caches a small stats file per set under `build/texture-library/stats/` and deletes the previews. After both runs below, 430 sets were measured (1.7 MB). A cold search took 4 to 52 s; a cached one takes milliseconds.
  - **`texture_library_search`** (`tools/texture-library-tools.ts`, its own pack): arguments `colorSrgb`, `roughness`, `metallic`, `tileSizeM`, `text`, `limit`. It returns set names with real size and `sizeSource`, mean colour, roughness, metalness and appearance text. Quantities the set lacks are listed as `unmeasured`, never guessed. Text words are alternatives (any one matches); they were all-must-match until the first run showed the agent writing "metal steel aluminum iron" as alternatives, which then matched nothing.
  - **`librarySets` description:** the example names are gone; it points to `texture_library_search`.
  - **`sb.library_surface`:** each fetched set carries its index entry. `tile_m` defaults to the set's real size, and `tile_m_source` reports where it came from. It is still required, as the script's estimate, when the size is unknown.
* **In the app** (127.0.0.1:3460, same prompt both times: the ESB from site, siteFacade and siteCrown, with walls, stone base and frames/spandrels from library materials matched to the read facade colours):
  - **Run 1** (index with full statistics): the agent first ran a script to read the facade colours (wall sRGB 0.65, 0.626, 0.593; trim 0.566, 0.547, 0.527), then made 7 searches with those colours. It then fetched and chose **concrete_wall_009** for the walls (1.805 m, Poly Haven metadata), **PavingStones104** for the base (2.0 m, ambientCG metadata) and **MetalPlates014** for the frames (1.6 m, metallic 1.0). Every name came from a search result; none came from the description. Two of the three scripts failed before the third built (823k vertices; scan score coverage 0.930 / precision 0.598). The failure text was not shown in the chat card or the server log, so the cause was not captured.
  - **Run 2** (metadata index, measured on demand, after a server restart and a cleared stats cache): 8 searches, measuring on demand. The agent chose **concrete_brick_wall_001** for the walls (3.0 m, Poly Haven metadata), **castle_wall_slates** for the base and roof (2.5 m) and **Metal010** for the frames. Metal010's size is unknown, so the agent gave tile_m 1.6 m and reported it as "estimated by the script". The second script built (71 MB GLB, 9 library images).
  - **Weakness:** in run 2 the agent searched with colours it chose itself (walls sRGB 0.76, 0.72, 0.65) before any script had read the facade. `sb.library_surface` then ranked the candidates against the read colours, but the search pool itself came from a guess. Run 1 did it in the right order.
  - **Sense check of the choices:** run 1's walls (a matte, near-colour concrete) and both metals fit. In run 2, "slates" for the ESB's granite base and roof is a stretch, and an unfiltered colour search can rank ground sets (pebbles, gravel) for walls. The text words are what keep a search to wall materials.
  - **Viewport:** run 2's tower shows the library textures (a faint warm tint), but from tower distance it reads as an even pale grey and the stone grain is not visible. This is the same as section 13; colour against the tiles is section 14's subject.
* **Colour distribution, not one tint** (same day, after the de-lighting review):
  - **Search:** a set with no hue variation of its own (CIELAB a/b spread under about 1 ΔE: a greyscale map) now pays a coloured target's chroma, because tinting it gives one flat hue. An optional `colorSpreadLab` takes a measured spread and ranks by it. For the ESB wall colour with "concrete", Concrete034 (greyscale; it won the walls in section 13) dropped out of the top 40.
  - **Bake** (`transfer_lab_png`, native, in `scratchbox_material_maps.hpp`): `sb.library_surface` now moves the set's CIELAB distribution instead of multiplying each channel. The mean goes to a neutral grey, the set's own colour variation is kept, or scaled to a measured `target_spread`, and the parent session's base-colour factor carries the target colour. Checked on real maps:
    - Concrete034 stays greyscale (a/b spread 0 cannot be scaled up) and is labelled `greyscale_set`.
    - A requested spread of (6, 1.5, 3.5) on concrete_wall_009 came out as (5.99, 1.41, 3.48).
    - Bricks065 keeps its lightness spread of 12.1. Under the old fixed 0.8-linear bake it clipped to 9.6; the bake's lightness now leaves 2.5 spreads of headroom below white.
    - One bake is shared by every tier colour it is bright enough for. Three tier colours share one image; a near-white target gets its own bake at L 97.
  - **Run 3 in the app:** the agent read the colours first this time (`sb.site_colors`, per tier), then searched. It chose concrete_brick_wall_001 (3.0 m) for the walls and trim, concrete_slab_wall for the top tier, Tiles140 (2.0 m) for the base, and Metal010, Metal024 and MetalPlates014 for the frames, with the metals' tile size "estimated by the script". It reported `greyscale_set` where it applied (concrete_wall_009 on roofs, Metal010 on the lower frames). The tower now reads warm tan with per-tier tones, and close up the walls keep a slight tonal variation; runs 1 and 2 read near-white. The per-tier colour itself comes from `sb.site_colors`; this change keeps each set's variation under it. Three of its six scripts failed before the last built, with no failure text in the chat card or the server log.
  - **Measured spread (later the same day):** `sb.site_colors` now reports `wall_spread_lab` / `terrace_spread_lab` per tier (parent session; ESB T0 wall [6.73, 2.36, 3.51]). Its lightness part mixes windows into the stone at tile resolution, so the guide passes only the hue part, `[-1, *wall_spread_lab[1:]]`; a negative channel keeps the set's own spread. On concrete_wall_009 this gave a hue spread of (1.42, 3.44) against (2.36, 3.51) wanted: a is held by the ×4 cap, and lightness stays the set's own 2.5. The search's spread term is weighted lightly (hue difference / 6), since the measured hue spread also holds window mixing. With a spread given, ground sets matching "stone" (cobbles, pebbles) still rank near wall sets; the text words decide that. Not yet run in the app with a measured spread.
* **Open:**
  - The agent should read the facade colours before searching (or search again once they are read). The guide says so, but run 2 did not.
  - The index does not record which sets are cut-outs: fence sets (Fence007A, with an opacity map) rank high for "metal".
  - The search ranks by mean colour only, so a greyscale set (298 of 2,479 sets measured in the first full build have no chroma spread, Concrete034 among them) can win a coloured target and give one flat hue. See the de-lighting review: compare colour spread too, and transfer a distribution rather than one tint.
  - The visual check's 413 is still open.

## 16. Tile-photo colours per tier, a trim slot, and weathering by default

* **Asked:** read colour targets per tier and facing (walls, setback terraces, glass) from the 3D tiles' photos for scripts to tint library surfaces to; split the generator's horizontal trim out of the foundation slot; tested at the ESB in the app. Then: weathering on by default for anything built from the real world.
* **Trim slot** (`scratchbox_architecture.hpp`):
  - `foundation` is now the plinth alone. A new `trim` slot holds sills, ledges, belt and string courses, cornices, mouldings and the floor-slab edges on every floor.
  - Each tier's top slab, the setback terrace the next tier stands on, moved to `roof`.
  - Before, "dark granite for the base" covered every sill and cornice of the tower.
* **`sb.site_colors(plan)`:**
  - native `scan_colours` samples the extraction's photo-textured tiles inside the building outline every 0.5 m (1.3M samples on the ESB in 0.2 s);
  - per tier: "wall" (the sunlit sides' lit colour), "wall_shade", "sides", "glass" (the dark population), "terrace" (up-facing within ±3 m of the tier's top: scan-measured tops include the parapet, and the terraces sit about 2 m lower), CIELAB spreads, and "crown";
  - provenance photo-inferred.
  - The site's scan now carries `photoGlbPath` and `photoGroundY` (`site-scan.ts`).
* **Per-tier surfaces:**
  - `write_textured_building` takes a part's full name as a surfaces key (`"EmpireT4_wall"`), which wins over its slot.
  - Surfaces can be a flat `{"color": ...}` (glass).
  - `library_surface` bakes each set once and returns the measured colour as the base-colour factor, so eleven tiers share one image; its default map size is now 1024.
* **In the app** (fresh chat, per-tier tile colours):
  - The agent read the colours first, searched the library per surface, and tinted each tier's wall, trim, roof and glass.
  - Its first script wrote 222 MB (2K maps and an overlay weathering shell); it recovered on its own with 1K maps (86 MB, mounted).
  - Against the tiles (`scan_colour_compare.py`): walls ΔE 9.1 → 4.4, terraces 9.4 → 7.2, all 9.2 → 5.3. Per tier, walls: T0 15 → 3, T6 13 → 3, T7 17 → 5. Picture: `docs/screenshots/esb_tile_colours_per_tier_inapp.png`; development elevation `docs/screenshots/esb_scan_vs_build_colour_after.png`.
  - The agent's chat reply did not survive a reload (twice): its final turn returned no text, and the whole message disappeared from the transcript.
* **Weathering as a layer, on by default:**
  - The bake can carry its atlas on the receivers' own second UV set (`Vertex.uv1`, `TEXCOORD_1`) instead of an overlay shell. The GLB marks it with `SB_material_weathering`, and the viewer blends it over the surfaces (`scene3d/weatheringLayer.ts`).
  - ESB, development: 714k vertices and 66 MB against the overlay's 1.08M and 86 MB.
  - `write_textured_building` weathers by default when the script has a site, and `weathering=False` turns it off. Trim is no longer a default receiver: its moulding faces cross many charts, which split the second UV set into 1M+ vertices in one in-app run.
  - A size guard: if the layer would push the file over the viewport's limits, it halves the atlas, then leaves default weathering out with the reason (asked-for weathering stops with the numbers).
  - In the app, the default-weathered ESB built at 63 MB / 598k vertices (unweathered 41 MB / 562k), and the viewer logged "weathering layer blended on 50 material(s)".
  - A bug the first run showed, now fixed: the atlas was attached by the first tier's name, so only tier 0's materials carried it.
* **Open:**
  - The weathering marks are subtle at 0.46 m texels: the atlas is about 10% used, its charts mostly holding window-reveal strips. Charting connected faces instead of 4 m cells would fix that.
  - The narrow viewport pane did not allow a convincing before/after close-up.
  - The chat request itself hit the server's 50 MB JSON limit (413) once a conversation held several builds; the visual check hits the same limit on every build.

## 17. A sharper weathering atlas, and a before/after in the app

* **Charting** (`scratchbox_weathering.hpp`): charts are now connected surfaces facing one axis (triangles sharing an edge, same dominant axis, within 0.75 m of depth), cut by a grid only when one outgrows half the atlas. Before, they were 4 m grid cells, mostly empty around thin window reveals. ESB, same receivers and atlas limit:

  | | Texel | Atlas filled | Charts | Build vertices |
  |---|---|---|---|---|
  | 4 m cells | 0.46 m | 10% | 72,210 | 714k |
  | connected faces | **0.20 m** | 23% | 53,400 | 662k |

  That is 5.4× the texels per square metre, and fewer vertices, because connected charts split the second UV set at fewer seams. The rest of the atlas is mostly window openings inside facade charts.
* **Three bugs the in-app test found, fixed:**
  - The default-weathering size guard counted every part's copy of the shared library images (115 MB estimated against 80 MB real), so it left weathering out. It now counts each image once, as the writer stores them.
  - The viewer applied the layer only to models loaded by URL; a script's model is loaded from the generator's bytes, so it was never blended. The hook now runs on both loaders (`Scene3DPrimitive.tsx`).
  - Any chat holding a built model failed its next turn with 413: the scene's `pythonGenerator.glbBase64` (83 MB of base64 for a 62 MB GLB) rode along with every chat and visual-check request, over the server's 50 MB limit. `gemini-client.ts` now replaces large `glbBase64` strings with a short note in those requests; the field stays, so nothing takes the scene for an uncompiled script. The visual check passes again ("72/100").
* **In the app:**
  - A fresh chat built the ESB with `weathering=False` (62 MB, 618k vertices), then reran the same script with the default (81 MB, 620k vertices, 50 weathered parts, 0.196 m texels).
  - Before/after shots are the same build, layout and camera, with the viewer's blend off then on: `docs/screenshots/esb_weathering_before_after.png` and `_close.png`.
  - With weathering the stone turns from clean warm tan to a greyer, dirtier tone, with darker grime under each floor's ledge.
  - The tiles' photos show long vertical run-off down the piers, which the default parameters do not reproduce: measured weathering (fitting the bake's parameters to the photos) is the step that would.

## 18. Retextured from pipeline K's photos: the lattice and the building's own textures

* **Asked:** use pipeline K's straightened facade photos as a guide to retexture the procedural ESB: lattice registration, per-element colours, repeat-residual stains; then, instead of the texture library, the building's own textures made from those photos. Tested at the ESB in the app.
* **The guides** (`site-guides.ts`, `sb.site_guides`): the newest pipeline K run within 60 m of the site (here run `d0832981`, 87 rectified facade photos at 0.077 m a pixel), moved into the script's frame through both GLBs' `localToEcef` (agrees to 1-4 cm). Without a K run the script is told to run the 3D Building first.
* **The lattice** (`scratchbox_facade_guide.hpp` `measureLattice`, `sb.site_lattice(plan)`): each photo's column profile is split (Otsu) into light pier columns and dark infill. A tier takes the width-weighted median over the photos that cross it with a clear lattice (4+ piers, light/dark 1.3x+, piers under 60% of the pitch). It sets `bay_width`, a pilaster of the pier's width at every bay and the window width between.

  | Tier | Pitch | Pier | Storey (photos) | Repeats in the median (piers / bays) |
  |---|---|---|---|---|
  | T0 (street, shops) | 3.72 m | 1.46 m | 3.50 m | 1,443 / 697 |
  | T1 | 5.53 m | 1.46 m | 3.51 m | 1,890 / 828 |
  | T4 (main shaft) | 5.55 m | 1.39 m | 3.48 m | 3,863 / 2,166 |
  | T7 | 5.69 m | 1.77 m | 3.46 m | 14 / 8 |
  | T8-T10 | no photo with a clear lattice: T7's, labelled generated | | | |

  The tower's 5.5-5.7 m pitch and 1.4 m piers match the K photo (light piers, about 4 m dark bays).
* **Own textures** (`elementTextures`, `sb.site_textures(plan)`): per tier, every pier (storey by storey, phase-aligned on each facade by its brightest infill row) is stacked into one pier tile and every bay into one infill cell; each pixel is the median over all repeats, so stone, spandrels and frames stay and stains and smears drop out. The spandrel is the cell's band between windows; glass is the darkest fifth of the window rows. Stone joints (0.6 m courses, 1.2 m blocks, half-bond) and ±5% block tones are drawn on at 64 px/m, generated, since the photos' 8 cm pixel and the median leave the stone smooth. `_trim` gets the pier tile, `_wall` the spandrel, `_glass` the colour; labelled photo-inferred (joints generated). 0.1-0.3 s a tier.
* **Stains:** the weathering bake reads each photo's residual against its own repeats one and two bays away; in the app 701,776 texels came from the facade guides (1.53M measured in all).
* **In the app** (web 3070, fresh chat, no library): the agent read the guides, called `site_lattice` and `site_textures`, and built in 40 s with no downloads (the library run before it spent over 10 minutes downloading 8K maps and was stopped). 448k vertices; weathering blended on 50 materials; scan score 99.0% / 91.1% banded (explains); visual check 72/100. It reported every tier's sizes, sample counts and the repeated tiers honestly.
  - Screenshots: `docs/screenshots/esb_own_textures_full_inapp.jpg`, `_shaft_inapp.png`, `_close_inapp.png`, and against the K photo `esb_own_textures_vs_k.png`.
* **What reads right:** continuous light piers at the real pitch with stone joints, dark bays, dark glass.
* **What still reads wrong** (from the side-by-side):
  - Light horizontal lines cross every bay: the sills, ledges and slab edges are trim, so they take the pier stone. The real bays have no light sills; the vertical piers run unbroken.
  - One large window per bay where the real one shows a pair with a mullion.
  - The stone looks whiter and greyer than the photo's tan under the viewport's light.
  - Spandrel heights read noisily per tier (0.31-2.09 m), as the window/spandrel split of a dark cell is weak.

## 19. Read from pipeline K's finished model: paired windows, no sills, and three bugs

* **Asked:** give the sills and ledges the infill colour or drop them where the photo shows none; split each bay into paired windows with a mullion; then (mid-task) use pipeline K's finished model, not the viewport output, as the guide. Retested at the ESB in the app.
* **K's finished model as the guide** (`site-guides.ts`, `renderFromModel` in `scratchbox_facade_guide.hpp`):
  - The guides now render K's finished model (its straightened, de-lit, harmonised textured twin) straight on at each of K's facade planes, at the planes' own 0.077 m pixel. Lattice, textures and stains are read from those renders; the orthos are only the fallback.
  - The model sits in K's frame, so the transform used for the planes carries it.
  - Within 6 m of the plane (K's recessed centre bays lie several metres behind its fitted plane), only 4.8% of facade 0 is uncovered, against 25% at 2 m.
  - The run now notes its model (`pipeline_k_model.json`, written by the orchestrator). Older runs are matched to their textures cache entry by the harmonise report. The newest run that has a model wins, and a run still in progress is skipped.
  - Observed: K's de-lit model reads flatter than the orthos (dark bays lifted to mid-grey). That is K's look, and it lightens the infill.
* **Bays read from the photos** (`elementTextures`, applied by `sb.site_lattice`):
  - **Windows per bay:** the window rows' column profile of the median bay is read for the extreme that repeats, light or dark. On the ESB the glass reads lighter than its aluminium strips, so "glass is dark" counted one 3.9 m window. Only extremes standing out by over 35% of the bay's range count.
  - **Light band:** the brightest row across the bay against the pier. Under 0.8, the tier gets no sills, belts or string courses (`belt_projection_m` 0, rule `sill: False`).
  - **In the app:**

    | Tier | Windows / bay | Width, wall between | Light band | Sills and belts |
    |---|---|---|---|---|
    | T0 | 1 | 3.69 m | 0.97 | kept |
    | T1 | 3 | 0.67 m, 0.84 m | 0.46 | dropped |
    | T2 | 2 | 1.50 m, 0.77 m | 0.46 | dropped |
    | T4 (shaft) | 2 | 1.43 m, 0.85 m | 0.40 | dropped |
    | T5-T6 | 2 | 1.64-1.79 m | 0.52-0.63 | dropped |
    | T7 | 2 | 1.99 m, 0.31 m | 0.98 | kept |
    | T8-T10 | as T7, labelled generated | | | |

    T1 and T3 (lower setbacks) read 3 or 1 windows from run to run: their medians are weak.
* **Generator:**
  - `windows_per_bay` / `window_gap`: the bay is split into one cell per opening; sills and hoods are drawn per opening, and the pilaster fit uses the openings' full span.
  - `belt_projection_m`: 0 removes the box belt course on every floor line.
* **Bug: floor caps across the notches** (`triangulatePolygon`). On squared outlines a notch corner lies exactly on the line between two other corners. In float32 the ear test let that corner fall a hair outside an ear, so the ear's diagonal ran through it, and a later triangle spanned the notch: 51.6 m² of light trim at every floor of T4, outside the walls.
  - Fix: the on-edge tolerance is now relative to the plan's size, with a strict second pass before the no-ear fallback.
  - Verified: every tier's caps lie inside its outline, and triangle area equals outline area. In the app the slabs are gone and the scan score rose: banded precision 90.6% → 91.3%, overall 87.9% → 88.8%.
* **Bug: speckle in the weathering layer.** A/B with the viewer's blend off showed the light speckle in the bays is the weathering.
  - Measured texels that read clean (window glints, residual around zero) used to replace the darker fill with a clear texel. Now only a found stain (alpha ≥ 0.05) replaces it.
  - The per-band scale, a darkening measure (1.3-2.8 here), multiplied the light exposure wash as well. Now it scales only darkening texels: light texels above alpha 60 in the atlas fell from 363k to 100k (development build).
  - The in-app check of the second fix was stopped before the run finished: unverified in the app.
* **Test:** `building-outline.test.ts` expected the slot list from before the trim slot; updated (3/3 pass, credentials unreachable).
* **Screenshots:**
  - Before: `docs/screenshots/esb_paired_windows_notch_slabs_before.png`, `esb_notch_slabs_before.png`.
  - After the cap fix: `esb_notch_after_cap_fix.png`.
  - Full: `esb_k_model_guided_full.jpg`.
