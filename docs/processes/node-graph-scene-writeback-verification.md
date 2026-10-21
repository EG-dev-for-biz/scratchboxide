# Process: Node-Graph ⇄ 3D Scene Write-Back Loop — Live UI Verification

> **Recorded:** 2026-10-20 (updated same day — see §6, §7 and §8 addenda)
> **Status:** Verified — reachability gap closed, GLB decomposition gap closed, operator-history DAG added; all mechanisms unit-tested against real operator dispatches, decomposition live-tested on real generated scenes
> **Tags:** `operate-scratchbox` `node-graph` `3d-scene` `primitive-transformer-engine` `direct-dispatch-operator-engine` `morph-canvas-primitive` `glb-parsing` `operator-stack-dag`
> **Target Domain:** Generative Canvas — 3D Scene ⇄ Node Graph Primitive Morphing

---

## 1. Session Context

* **What prompted this session:** Implemented `morphScene3DToNodeGraph` (real per-mesh decomposition, replacing a hardcoded 5-node stub) and `morphNodeGraphToScene3D(graph, baseScene?)` (real write-back via `DirectDispatchOperatorEngine.dispatch()`, replacing a decorative sphere-ring synthesizer) in `packages/core/src/browser/generative-canvas/primitive-transformer-engine.ts`. Both passed new vitest coverage (`packages/core/test/contextual-multi-primitive-canvas.test.ts`) against a real synthesized scene. This session was to verify the same loop works through the actual live app UI, not just the test harness.
* **Instance used:** web port `3070`, API port `3071`, tools port `3072` (new `scratchbox-node-graph-writeback` entry in `.claude/launch.json`, pointed at this checkout — **not** the user's `scratchbox-dev` entry/ports 3060–3062, per standing instruction to never touch those).
* **Scope tested:** Generating a multi-mesh procedural 3D scene, then attempting to view that scene as a node graph (both via the viewport's "More Actions" menu and via a direct chat request to the agent), to see whether the new `morphScene3DToNodeGraph`/`morphNodeGraphToScene3D` code is reachable from anywhere a real user would click or type.

---

## 2. What Was Tested & What Worked (Verified)

* **Isolated dev instance bring-up** — added a new launch entry at fresh ports, confirmed no collision with the user's own running `scratchbox-dev` instance (ports 3060–3062, worktree `latest-main`), booted clean, navigated with the printed token. Evidence: `read_console_messages({onlyErrors:true})` → "No console logs."; clean boot log in `preview_logs` ending in the three expected "listening" lines.
* **Multi-mesh procedural scene generation** — prompted "build a simple procedural 3D scene with 3 separate box meshes arranged in a row" → agent ran `load_skill` → `execute_3d_python_script` (8552ms) → `audit_3d_scene_viewport` (4319ms) and returned a real scene: 3 named submeshes (`Box_1`, `Box_2`, `Box_3`), 16,995 vertices / 33,792 triangles, saved to `scene_1792515532610_mnohi9.glb`, rendered correctly in the 3D viewport. This is the real scene the write-back logic was implemented against (it has genuine `customMeshes` entries, unlike a Google-3D-Tiles-clay scene which has no `customMeshes` array).
* **Original scene integrity after the failed node-graph request** — confirmed the original 3-box scene tab is completely unaffected (same geometry, same materials) after the subsequent (failed) node-graph request below. No corruption, no silent mutation.
* **Backend logic (prior session, not re-verified here)** — `morphScene3DToNodeGraph`/`morphNodeGraphToScene3D` unit-tested against `synthesizeContextual3DScene(...)` output; `tsc --noEmit` clean (one pre-existing unrelated error in `scratchbox-mcp-server.ts`, not touched by this work).

---

## 3. What Broke / Didn't Work

* **No manual UI control to morph a 3D scene into node-graph view** — clicked the viewport's "More Actions" button (`ref_489`) on the 3-box scene multiple times; no menu/dropdown with a node-graph (or any primitive-conversion) option ever appeared in the accessibility tree (`find({query:"node"})` found no match after the click). The only actions surfaced there are texture/staging follow-ups (PBR materials, 2DGS surfels, 3DGS splats, micro-texture synthesis) — nothing related to primitive type switching.
  - Console evidence: none — no error, the menu simply has no such entry.
  - Suspected cause: `morphArtifact`/`morphScene3DToNodeGraph` are pure functions in `primitive-transformer-engine.ts` with no UI component wired to call them on a 3D-scene artifact's toolbar.
* **Asking the chat agent directly ("show this scene as a node graph") does not invoke the morph either** — the agent thought for ~75s, then called `mount_canvas_primitive` to create an entirely new, unrelated 3D scene (titled "Procedural 3D Scene Graph: Three Separate Box Meshes in a Row", type tag confirmed as `(3d-scene)` not `(node-graph)`) depicting a mismatched creature with legs/antennae — nothing resembling the original 3 boxes, and definitely not a node-graph primitive.
  - Console evidence: none — no error; the agent simply picked the wrong tool/interpretation.
  - Network evidence: `POST /gemini/generate-stream → 200 OK`, followed by a tool-call to `mount_canvas_primitive` (115ms) — never any call resembling `morph_artifact` or `convert_primitive`.
  - Suspected cause: there is no agent-exposed tool (in `packages/core/src/node/gemini/tools/*`) that wraps `morphArtifact(artifact, 'node-graph')`/`morphScene3DToNodeGraph`. The agent has no way to invoke this code path, so "show this as a node graph" gets reinterpreted as a fresh generation request instead.

**Bottom line:** the write-back logic itself (Phases 1–2 of the node-graph scoping work) is correct and verified at the unit level against real synthesized scenes. But as of this session, it is **dead code from a live-usage perspective** — no button, menu, or chat-agent tool path reaches it. A user cannot currently open the node-graph view of a 3D scene at all, through any input method tested.

---

## 4. Candidate Tool/Service Ideas

* **`morph_canvas_primitive` agent tool** — a Gemini agent tool (in `packages/core/src/node/gemini/tools/canvas-tools.ts`) that wraps `morphArtifact(artifact, targetType)`, letting the agent actually call `morphScene3DToNodeGraph`/`morphNodeGraphToScene3D` when a user asks to view/convert a primitive, instead of silently reinterpreting the request as a new generation. Would have made "show this scene as a node graph" work as asked, rather than mounting an unrelated creature.
* **Viewport toolbar "View As" menu** — a manual UI control (in the 3D-scene viewport's "More Actions" menu, alongside the existing texture/staging options) listing the other primitive projections available for the current artifact (node-graph, metrics, kanban, doc), calling `morphArtifact` directly without needing the chat agent at all. Would have let this session (and any future user) reach the node-graph view deterministically instead of depending on agent tool-selection, which this session found to be unreliable for this exact intent.

---

## 6. Addendum (2026-10-20, same day): Reachability Gap Closed, New Deeper Finding

Following this report, built and verified the two missing pieces:

* **`morph_canvas_primitive` Gemini agent tool** (`packages/core/src/node/gemini/tools/canvas-tools.ts`) — wraps `morphArtifact(activeArtifact, targetType)`, mirroring `mount_canvas_primitive`'s declaration/handler/return-shape pattern. Registered title-mapping entries in `tool-registry.ts`. Unit-tested (`packages/core/test/morph-canvas-primitive-tool.test.ts`): converts a real synthesized scene into a node-graph with one real node per mesh, and fails cleanly (no crash, no fake success) when there's no active artifact.
* **"View As" UI menu** on the 3D viewport (`Scene3DPrimitive.tsx`, wired through `CanvasCardBody.tsx`) — a real dropdown next to the "3D Scene" badge listing Node Graph / Document / Kanban Board / Metric Dashboard / Code Sandbox, each calling `morphArtifact` + the existing `handleMorphArtifact` commit path. Fixed a pre-existing signature mismatch in `CanvasCardBody.tsx` where `Scene3DPrimitive`'s `onMorphArtifact={handleMorphArtifact}` was wired with the wrong arity (that prop takes `(artifact, targetType)`, not a single pre-morphed artifact) — this had never been exercised before since nothing called it.
* **Fixed a correctness bug in `morphArtifact` itself**: the node-graph → 3d-scene branch never passed a `baseScene` to the Phase-2 write-back function, so even once reachable, round-tripping through the generic `morphArtifact` path would have silently fallen into the exploratory sphere-ring fallback instead of real write-back. Fixed by having `morphScene3DToNodeGraph` embed `sourceArtifact: { type: '3d-scene', data: scene }` on the graph it produces, and having `morphArtifact` read it back automatically. Unit-tested (`contextual-multi-primitive-canvas.test.ts`): full round trip with no explicit `baseScene` argument needed at any call site.

**Live-verified "View As → Node Graph" on two real generated scenes** (Flatiron Google-3D-Tiles scene, and a freshly generated 2-sphere procedural scene): the button and dropdown render and work exactly as built, confirmed by the exact subtitle text produced by the real code (`"N mesh node(s) projected from the live scene"`).

**New finding — both live-tested scenes showed "0 mesh nodes", and this is correct, not a bug:** the default live-chat 3D generation path is the `execute_3d_python_script` tool (`packages/core/src/node/gemini/tools/python-3d-tools.ts` — confirmed zero references to `customMeshes` anywhere in that file), which authors geometry via a Python script compiled to native C++20 and streams a single compiled `.glb` blob, updating only `Scene3DData.pythonGenerator.{glbPath,glbBase64,sourceCode}`. It never populates the `Scene3DData.customMeshes` JS array that `morphScene3DToNodeGraph` decomposes. So **today, the node-graph view only shows real content for scenes whose geometry lives in `customMeshes`** (e.g. scenes built/edited through `DirectDispatchOperatorEngine` operator calls, or test fixtures like `synthesizeContextual3DScene`) — for the much more common Python-script-generated scenes, it correctly shows an empty graph rather than fabricating fake nodes, but that means it isn't yet useful for most scenes a real user generates through chat today.

A path forward exists without touching C++ source parsing (still out of scope, per the original non-goal): glTF binary `.glb` files are themselves a node graph — named mesh/node hierarchies are part of the format even when authored via a script. A future pass could parse the compiled `.glb`'s own scene graph (via a glTF parser, not C++ source analysis) to populate real per-mesh nodes even when `customMeshes` is empty, closing this gap for the common case. Not attempted in this session — flagged for scoping, not started.

## 7. Addendum (2026-10-20, same day): GLB Decomposition Gap Closed

Implemented `parseGlbNodeHierarchy` (`primitive-transformer-engine.ts`) — a small, dependency-free binary glTF parser that reads only the `.glb` container's JSON chunk (magic/version/length header, then the `JSON`-typed chunk; the binary mesh/texture chunk is never touched) to recover the compiled scene's own node names, transforms, and parent/child hierarchy. glTF is itself a node graph, so this needed no C++ source parsing — consistent with the original non-goal.

`morphScene3DToNodeGraph` now falls back to this parser when `customMeshes` is empty but `pythonGenerator.glbBase64` exists (the actual shape of scenes from `execute_3d_python_script` — confirmed real: `NativePythonRunnerService` always base64-encodes the compiled `.glb` into this field). These nodes get a `glb-node-` id prefix (not `mesh-`) and `parameters.readOnly: true`, which makes `morphNodeGraphToScene3D`'s existing write-back loop naturally skip them — editing one currently has no effect, since there's no JS structure to mutate yet (the geometry lives in the compiled binary). This is called out explicitly in the node's own subtitle ("view-only — not backed by customMeshes"), not left as a silent no-op.

**Live-verified on the same real 2-sphere scene that previously showed "0 mesh nodes":** re-ran "View As → Node Graph" after this change — now shows exactly 2 real nodes, titled from the `.glb`'s own node names, with the subtitle "2 mesh nodes read from the compiled .glb (view-only — not backed by customMeshes)". Screenshot sent to the user.

Unit-tested (`packages/core/test/glb-node-graph-decomposition.test.ts`): hand-built a minimal valid `.glb` binary (correct magic/chunk headers, no mocking of the parser itself) with a 2-node named hierarchy (`Hull` → `Turret`), verified the parser extracts both nodes and the hierarchy edge, and verified `morphScene3DToNodeGraph` produces real labeled nodes (not a placeholder count) when given a scene with empty `customMeshes` and that `.glb` attached.

**Explicitly still out of scope:** write-back for `.glb`-sourced nodes (actually moving the compiled geometry when a node's position is edited). That would require re-encoding the `.glb`'s JSON chunk with updated transforms and reloading it — a real, bounded next step, but a different problem from decomposition and not attempted here.

## 8. Addendum (2026-10-20, same day): Generalized to Kanban Board (Phase A/B)

Extracted the "View As" dropdown out of `Scene3DPrimitive.tsx` into a shared `<ViewAsMenu>` component (`primitives/shared/ViewAsMenu.tsx`), driven by a new `MORPH_TARGETS` map (`primitive-transformer-engine.ts`) built by reading `morphArtifact`'s actual branches — the menu can never offer a target `morphArtifact` doesn't implement. Added a regression test (`morph-targets-regression.test.ts`) that calls `morphArtifact` for all 36 listed source×target pairs against minimal real fixtures — this is new coverage the function never had.

Wired the same pattern into `KanbanBoardPrimitive.tsx` as the second primitive (via a new `onMorphWholeBoard` prop, kept separate from the existing per-card `onMorphArtifact` used by the "Code & Test" 1-click feature — these have different arities and serve different purposes, confirmed by reading each primitive's actual usage rather than assuming the Scene3D pattern generalized uniformly).

**Found and fixed the same severity of fabrication bug in kanban that we'd already fixed in 3D scenes:** `morphKanbanToNodeGraph` only decomposed at column granularity (`"${count} active items"`, no real card data) and `morphNodeGraphToKanban` fabricated fake task descriptions (`"Build and verify ${node.subtitle} with integration contracts"`) instead of reading real card data back. Rewrote both for real per-card decomposition/write-back, added `sourceArtifact` so round-trips recover the base board automatically, and removed a fake 3-placeholder-node fallback for empty boards (now honestly reports 0 real card nodes instead).

**Live-verified:** generated a real kanban board through chat ("Mobile App Launch Roadmap", 3 columns × 2 cards), clicked View As → Node Graph, got the exact real count: "6 cards across 3 stages, projected from the live board." Screenshot sent to the user.

4 new unit tests (`kanban-node-graph-writeback.test.ts`) cover: real per-card decomposition, honest zero-node output for an empty board, write-back editing one card without perturbing others, and the full `morphArtifact` round trip recovering the base board automatically via `sourceArtifact`. 12 tests total across 5 files, all passing; `tsc --noEmit` clean.

## 9. Addendum (2026-10-20, same day): Phase 3 — Operator-History DAG

Audited `operatorStack` population before building anything: `execute_3d_python_script` (`packages/core/src/node/gemini/tools/python-3d-tools.ts`, confirmed zero references to `operatorStack`/`actionLog`) never touches it. This is the dominant real path for **both** initial generation and — a new finding, confirmed live — natural-language edits too: asking the chat agent to "translate the first box 2 units to the left" re-ran `execute_3d_python_script` with recomputed coordinates rather than dispatching `sb_translate` through `DirectDispatchOperatorEngine`. So a Houdini-style "every edit as a DAG node" feature would be empty for both generation and ordinary chat-driven editing of a scene — not just generation, as assumed when this phase was first scoped.

Built it anyway, scoped to what's real: `buildOperatorHistoryNodes` (`primitive-transformer-engine.ts`) projects `Scene3DData.operatorStack` — which **does** reliably fill once a scene is edited through the operator engine directly (the viewport's own transform/material tools, or an explicit operator-dispatch tool call) — into a real chronological DAG: one node per operator actually dispatched, chained `op[i] → op[i+1]` in true execution order, linked back to the mesh node it targeted. Nodes are marked `readOnly: true` with an `op-` id prefix (not `mesh-`), so the existing write-back loop in `morphNodeGraphToScene3D` naturally skips them — replaying an edited history entry would need a real undo/redo-aware re-execution model, explicitly out of scope.

3 new tests (`operator-history-dag.test.ts`), all against real `DirectDispatchOperatorEngine.dispatch()` calls, no mocks: a scene with no `operatorStack` field shows zero operator nodes; two real dispatches (`sb_translate`, `sb_rotate`) produce a correctly chained and mesh-linked DAG with the right subtitle count; history nodes are confirmed read-only via the same id-prefix rule the write-back loop already uses. Along the way, discovered `synthesizeContextual3DScene` (the test-fixture synthesizer) dispatches operators internally during its own construction — a real non-empty baseline history, not a bug — which required fixing a stale node-count assertion in the original Phase 1 test (`contextual-multi-primitive-canvas.test.ts`) that didn't anticipate it.

**Live-tested partially, not fully:** generated a real 2-box scene, asked the agent to translate one box via chat, confirmed (as predicted by the audit) that `operatorStack` stayed empty and the node graph correctly showed zero edit-history nodes rather than fabricating any. Did not complete a live test of the one path that *should* populate it (the viewport's own Translate/Move gizmo tool) — mechanism is proven correct by the 3 unit tests against the real engine, but that specific UI gesture is unconfirmed live.

## 5. Reproduction Steps

1. In this checkout, ensure `.claude/launch.json` has the `scratchbox-node-graph-writeback` entry (web 3070 / API 3071 / tools 3072), then `preview_start({name: "scratchbox-node-graph-writeback"})`.
2. Read the token from `preview_logs` and navigate to `http://127.0.0.1:3070/?token=<TOKEN>`.
3. Start a new chat, prompt: `build a simple procedural 3D scene with 3 separate box meshes arranged in a row`. Wait for `audit_3d_scene_viewport` to complete (~15–20s).
4. Click the viewport's "More Actions" (⋮) button — observe no node-graph option appears.
5. In the same chat's edit box, prompt: `show this scene as a node graph` — observe the agent calls `mount_canvas_primitive` with an unrelated new 3D scene rather than converting the existing one.
6. Confirm the original 3-box scene tab is unaffected by switching back to it.
