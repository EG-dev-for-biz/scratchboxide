# Process: Every chat tool as a runnable node on the canvas node graph

> **Recorded:** 2026-10-24
> **Status:** Verified (catalog, single run, chained run); one tool's own failure noted
> **Tags:** `operate-scratchbox` `node-graph` `tool-nodes` `canvas`
> **Target Domain:** Generative Canvas / Node Graph

---

## 1. Session Context

* **What prompted this session:** the user asked for all tools to be available as nodes in the canvas view. Before this, the node graph had a fixed palette of about 30 kinds, only image and video nodes ran, the 3D node sent a job the server rejects, and "Play Flow" only animated.
* **Instance used:** web port `3170`, API port `3171`, tools port `3172` (own `scratchbox-tool-nodes` entry, `HOME`/`SCRATCHBOX_HOME` pointed at a scratch folder; the browser origin still restored existing sessions, so testing ran in a new chat).
* **Scope tested:** the library's tool sections, the generated input form, a single tool run, the required-input check, and "Run tools" across two connected tool nodes.

## 2. What Was Tested & What Worked (Verified)

* **Catalog** — `GET /gemini/tools/catalog` → 200, 188 tools, grouped by the declaration list each comes from (only `load_tools` falls in "Other tools").
* **Library** — searching `mesh_inspect` shows "Tools: Mesh Shaping › Mesh inspect"; clicking adds a node with the tool name, a Run button and a "Needs inputGlbPath" hint.
* **Required-input check** — Run with no input → card error "Needs inputGlbPath: set it in the node or connect a node whose output has it"; no request sent.
* **Form** — the double-click editor lists the declared parameters (`inputGlbPath *` string, `sharpAngleDeg` number; for the solar tool `latitude *`, `longitude *`, `isoDate *`).
* **Single run (real)** — `mesh_inspect` on the Haughwout GLB → `POST /gemini/tools/run` 200, and the tool's own error shown on the card (see 3).
* **Chained run (real)** — `atmosphere_calculate_solar_position` (40.72181, −73.99949, 2026-10-24T15:00Z) → `atmosphere_get_diurnal_profile` with no inputs set. "Run tools" ran both in order: elevation 32.51°, azimuth 150.58°; then "From upstream: elevationDeg", 80,152 lx at 4712 K. Console: no errors. Screenshot: `docs/screenshots/tool_nodes_chain_live.png`.

* **Chat build → tool calls as nodes (real model)** — asked the chat (gemini-4-argon) for the solar position and then the diurnal profile. The reply's record kept every call's arguments and short result fields (`load_tools`, `atmosphere_calculate_solar_position`, `atmosphere_get_diurnal_profile`). "Open tool calls as nodes" opened "Chat build — tool calls": 2 nodes in call order, `load_tools` left out, edge `elevationDeg`. "Run tools" re-ran both (two `POST /gemini/tools/run`, 200); node 2 then held the fresh 32.510201644520116 from node 1 instead of the recorded 32.5102016445201. Screenshot: `docs/screenshots/tool_calls_as_nodes_live.png`.
  - Found live: the model passes returned numbers back rounded (15 digits), so links matched by exact value were missed; numbers now match to about 9 significant digits.

* **3D Building stage view (real build)** — "Build the Haughwout Building at 488 Broadway, New York in 3D" started staged run 02538de5. Mid-run, View As → Node Graph on the scene showed "… — build stages": a runnable `google_3d_tiles_get_clay` node (query + isolate), then read-only stages Place, Google vector massing, Google 3D Tiles, Remeshed scan (committed) and Facade grammar (pending), with "replaces layer" edges vector → tiles → remesh read from the layers. Subtitle: "Run 02538de5 (running): 5 stages, 1 pending, 4 committed". Screenshot: `docs/screenshots/staged_build_stage_view_live.png`. The view is a snapshot: it does not update as the run goes on (open it again). The test server was stopped mid-run, so the finished-run view was not seen live.

* **Chat, canvas and viewport in sync (real build)** — the stage view's build node (query + isolate + `stageIntoActiveScene`, run against its scene `scene-stg-02538de5`) streamed over `POST /gemini/tools/run-stream` (one held request). Before the run the viewport showed the clay massing (layer GLBs 200). During the run the stage view redrew itself from each streamed scene (run 7dea885b, then cef5da30) and the card showed live progress ("Ownership vote: skipped"). Mid-run the scene tab was opened: the graph left the stage, the run went on (facade grammar 32 s → 3 min 38 s, committed), focus stayed on the scene, and the scene's build panel followed the node's run. On finish the scene held run cef5da30 with real textures; the chat had a reply "Ran `google_3d_tiles_get_clay` from the node graph … completed" with a ✓ Done tool card; back on the graph, the build node showed Done (written into the saved graph while off stage) and the stages "Run cef5da30 (finished): 5 stages, 5 committed". Screenshot: `docs/screenshots/tool_node_sync_live.png`.
  - Found live, fixed: node updates went through `handleUpdateArtifact`, which makes the graph the active artifact (focus jumped back, a version per progress line), and the graph's unmount aborted its runs (a tab switch stopped the build; seen once, via a hot reload: "Stopped"). Progress now stays in component state; runs live outside the component; a result that lands off stage is written into the saved graph without taking the stage. `sanitizeGraph` dropped `sourceArtifact`/`stageViewOf` on the first edit; it keeps them now.
  - Seen, not changed: the existing per-reply visual check also runs on the node-run replies (one Gemini vision call each; it scored these 45–55/100, "building distant and undersized").

* **Scene nodes, real controls, 3D toolbar** — scene graphs now carry one `obj-<id>` node per scene object (the demo scene showed "vector-world-stage", category object). Node parameters are typed controls that write back to the scene (`scene-node-params.ts`, `ParamControls.tsx`): camera FOV slider plus position/target xyz; environment atmosphere toggle, skybox and lighting dropdowns, ground/fog toggles, ambient and kelvin sliders; Output render-mode dropdown (staged: clay/textured); mesh position/rotation/scale/colour/roughness/metalness; object position/heading/colour/roughness overrides. Live: the environment's Atmosphere on plus skybox sunset drew the sunset sky in pbr; the object's Heading set to 35 read back as 35 from the scene after reselecting. The viewport turn could not be seen: this demo's GLB is missing on disk. Tool inputs that name a file type get a Browse picker over the bounded `GET /workspace/find-files` (1.2 s, 300 results on this repo); it listed the workspace `.glb` files and the pick filled `inputGlbPath`, which reached the run. 3D graphs hide the automation quick-add row and the simulation controls; their toolbar shows tool-run status plus Run / Step / Reset, and "Add a tool node" lists the tools by task group.
  - Seen while testing, not a product fault: with eight app tabs open in the test browser, the six per-origin connections were all held (one file-change stream per tab), so the catalog and file search stalled ("not in the catalog"). Closing the extra tabs freed them; requests then took 7 ms.

## 3. What Broke / Didn't Work

* **`mesh_inspect` in a `desktop-app/` workspace (fixed)** — the tool failed: "neither the pipeline binary …/desktop-app/build/3d-native/run_mesh_edit_pipeline nor its source …/desktop-app/scripts/run_mesh_edit_pi…". Cause found: `NativeMeshEditService` resolves `build/3d-native/run_mesh_edit_pipeline` and `scripts/run_mesh_edit_pipeline.cpp` against `process.cwd()`, which is `desktop-app/` for the server, while the source is in the repo's `scripts/`. Fixed: it and `NativeMeshReshaperService` now resolve from the repo root (`repoPath`); run from `desktop-app/`, inspect compiled the driver and read the GLB (310 triangles, 84 open edges), so it fails the same way from chat in that workspace. Not a node-graph fault; not investigated further.
* **Fixed during the session:** the quick-inspector popover offered a category dropdown (showing "Input Trigger") and "Dry Run" on tool nodes. It now shows "Edit <tool> inputs" and "Run tool". The "needs" hint also stayed after upstream filled the input; fixed.

## 4. Candidate Tool/Service Ideas

* **Output-to-input name mapping on edges** — inputs fill only by matching field names (`elevationDeg` → `elevationDeg`). Many tools output `glbPath` but take `inputGlbPath`, so those chains need the path typed in by hand. An optional per-edge mapping (`glbPath → inputGlbPath`) would cover it without per-tool code.
* **Run-progress on the card** — tool handlers report progress (`ctx.report`), but `/gemini/tools/run` is a single request/response, so long tools show only "running". A streamed variant would show the progress.
* **Chat-only tools** — canvas tools such as `ask_user_question` and `update_task_list` run from a node but only return their payload; nothing on the canvas acts on it.

## 5. Reproduction Steps

1. Start an instance (`operate-scratchbox`), open it with the token, start a new chat and ask for an empty node graph.
2. In the node library search `atmosphere_calculate_solar`, click it; then `atmosphere_get_diurnal`, click it (it auto-connects after the first).
3. Double-click the solar node; set latitude, longitude, isoDate; close.
4. Click "Run tools"; both cards show Done, the second with "From upstream: elevationDeg".
