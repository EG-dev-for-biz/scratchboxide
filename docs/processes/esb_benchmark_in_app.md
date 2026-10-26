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
