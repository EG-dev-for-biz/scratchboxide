# Live Frontend Agentic 3D & VFX UX Audit and Antigravity Parity Blueprint

**Date Recorded**: 2026-10-29  
**Category**: Troubleshooting / Architecture / DevOps  
**Tags**: `#chrome-devtools-mcp`, `#frontend-audit`, `#3d-vfx-pipeline`, `#agent-ux`, `#streaming-sse`, `#closed-loop-verification`, `#world-lens`

---

## 1. Problem Statement & Context

### Symptom / Goal
Evaluate the live Scratchbox IDE frontend (`http://127.0.0.1:3490/`) by driving real 3D and VFX agentic workflows end-to-end (staged Google 3D Tiles rebuilds, procedural Python C++20 3D asset generation, PBR-to-clay material switching, NOAA solar atmosphere configuration, 5-second camera orbit animation tracks, companion `Build Stages` DAG graphs, `Scene Graph` lenses, and `Tool Call Graph` conversion), and produce an actionable engineering blueprint to bring the interactive agent UX to parity with Google Antigravity for long-running, multi-stage 3D and VFX production tasks.

### Root Cause / Motivation
While Scratchbox IDE already has a deep native C++20 3D engine (`scratchbox_engine.hpp`), staged location rebuild pipelines (`google_3d_tiles_get_clay`), 5-lens `Scene3DWorldLens` synchronization, and a rich tool ecosystem, live interactive testing revealed 7 concrete UX and architectural gaps between the current request-bound chat loop and an Antigravity-grade agentic workstation:
1. **Request-bound SSE streaming & locked composer**: Multi-minute 3D builds (`380,263 ms` on `google_3d_tiles_get_clay`) hold open a single HTTP POST response (`POST /api/gemini/stream`). Socket timeouts surface as `The connection dropped mid-reply: network error`, and `Composer.tsx` locks out user input (`disabled={isGenerating}`) instead of supporting non-blocking message queuing.
2. **Passive post-turn visual verification**: `streaming.ts` only runs `AgentVerificationService.verify()` (`tsc --noEmit`) when code files are modified (`modifiedFiles.size > 0`), never invoking `AgentVerificationService.verifyGeometry()`. Meanwhile, the client-side visual check (`MessageNotices.tsx`) runs *after* the turn finishes, fails with `No frame of the canvas could be captured` if the 3D tab isn't open, and when it *does* score a render (`58/100` or `62/100`: *"framing is distant and material contrast remains flat"*), it only displays a passive footnote instead of feeding back into the ReAct loop for self-healing.
3. **Code-only `@` context mentions & empty GLB scene hierarchy**: `context-mention-engine.ts` only indexes code/workspace entities (`@file`, `@folder`, `@git`, `@terminal`, `@web`, `@docs`, `@mcp`, `@skill`), and `Studio Inspector` shows `Hierarchy (0)` on compiled GLBs because sub-parts are not exported as named glTF nodes (`tier_0_base`, `facade_north`, `spire_mast`) that can be raycast-pinned into the composer.
4. **Non-incremental node graphs & filtered Canvas operator nodes**: Toggling a stage in the 31-step companion `Build Stages` graph (`scene-node-graph.ts`) queues a full rebuild from scratch (`Off for the next build`) instead of dirty-subgraph execution from cached intermediate `.glb` artifacts. Additionally, `buildToolCallGraphArtifact` (`tool-call-graph-artifact.ts`) filters out `t.pack === 'Canvas'`, dropping `scene_3d_dispatch_operators` calls (`"1 tool call from the chat, as runnable nodes (2 left out)"`).
5. **Stateless tool-call pause/resume & 200-char history truncation**: `ask_user_question` and `present_execution_plan` break out of `executeVertexGeneration` (`streaming.ts`) and resume via string-stitched prompts in `useSendMessage.ts`, where prior `toolExecutions` in `chatHistory` are truncated to 200 characters (`summaryResult.slice(0, 200)`), losing camera matrices, bounding boxes, and asset paths across turns.
6. **One-way `Scene3DWorldLens` synchronization**: Direct viewport/inspector/node-graph edits recorded in `Scene3DWorldLens.getActionLog()` and `getOperatorStack()` are not serialized into `activeArtifactContext` before the next chat turn, leaving the agent blind to manual user tweaks.
7. **Composer `/` skill menu submit bug & duplicate tool step pills**: Pressing `Enter` or clicking `Send` while the `/` skill menu is open submits a bare `"/"` message to the LLM, and `MessageItem.tsx` renders tool executions twice (top `AgentExecutionStepper` + bottom `GroupedMcpExecutions`) while marking the bottom summary pill `Failed` if *any* intermediate attempt failed before a successful retry.

---

## 2. Prerequisites & Environment

- **Operating System**: macOS (Darwin)
- **Active Services**:
  - Frontend Vite server: `http://127.0.0.1:3490/`
  - Standalone backend API: `http://127.0.0.1:3491/`
  - Tools / MCP server: `http://127.0.0.1:3492/`
- **Browser Automation**:
  - Google Chrome launched with `--remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-9222`
  - `chrome-devtools-mcp` server connected to `127.0.0.1:9222`

---

## 3. Step-by-Step Resolution Procedure

### Step 1: Verify Running Frontend/Backend Ports & Launch Debuggable Chrome Session
Verify active listeners on ports `3490`, `3491`, and `3492`, and launch a dedicated Chrome instance with remote debugging enabled on port `9222` so `chrome-devtools-mcp` can inspect live DOM state, WebGL viewports, and network streams:

```bash
lsof -iTCP -sTCP:LISTEN -P -n | grep -E '3490|3491|3492|9222'
```

Launch Chrome as a background daemon pointing to `http://127.0.0.1:3490/`:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-debug-9222 \
  --no-first-run \
  --no-default-browser-check \
  http://127.0.0.1:3490/
```

### Step 2: Audit Composer Affordances (`@` Context Mentions & `/` Skills Menu)
1. Use `chrome-devtools-mcp` (`list_pages`, `take_snapshot`, `take_screenshot` with `pageId: 1`) to inspect the home screen composer (`packages/core/src/browser/generative-canvas/chat/Composer.tsx`).
2. Click the `@` button (`uid="1_25"`) to inspect `ContextMentionPopover.tsx` and verify available categories against `packages/core/src/node/agent/context-mention-engine.ts`.
3. Click the `/` button (`uid="1_26"`) to inspect the `/SKILL` popover (`86 skills` across `3D & World`, `Image & Design`, `Video & Motion`, `Audio & Voice`, `Location & Geo`, `Code & System`).

### Step 3: Audit Long-Running Staged Location Rebuild (`google_3d_tiles_get_clay`)
1. Open the staged Empire State Building session in the left session rail and inspect both the chat log and the companion canvas tabs.
2. Observe the 380-second `google_3d_tiles_get_clay` execution in the chat transcript (`The connection dropped mid-reply: network error`), followed by the `No frame of the canvas could be captured, so the visual check did not run` notice.
3. Click `Open on canvas` to inspect the 3D WebGL viewport (`Clay` / `Textured` / `Wireframe` / `Matcap` / `Normals` / `UV Checker` / `Provenance`), `Studio Inspector` (`Hierarchy (0)`), `3D Animation Sequencer`, and the 31-step companion `Build Stages` DAG node graph (`packages/core/src/browser/generative-canvas/scene-node-graph.ts`).

### Step 4: Drive Live Multi-Turn 3D & VFX Prompts Through the React Composer
1. Switch to the procedural Empire State Building session (`execute_3d_python_script`, `Active (v1)`).
2. Inspect the `View As -> Node Graph` (`Scene Graph` lens: `Environment`, `Weather`, `Procedural C++`, `Post-FX`, `Viewport`) and `View As -> Interactive`.
3. Focus the React `<textarea>` in `Composer.tsx` via `click` and use `type_text` with `submitKey: "Enter"` (rather than `fill`, which does not trigger React's controlled `onChange` state update) to run two live multi-turn 3D/VFX prompts:
   - **Prompt 1 (Material Switch)**: `"Switch the Empire State Building scene to 18% studio grey clay mode so we can inspect the massing and setbacks."` -> Triggers `scene_3d_dispatch_operators`, updates viewport to `Active (v2)` in clay mode, and triggers client visual check (`58/100`).
   - **Prompt 2 (Atmosphere + Keyframed Camera Orbit)**: `"Add a golden hour physical sun and sky atmosphere to this Empire State Building scene, and add a 5-second camera turntable orbit animation track around the building."` -> Chains `atmosphere_configure_scene` + `scene_3d_dispatch_operators`, advances viewport to `Active (v5)`, populates the `Camera Orbit` track in `3D Animation Sequencer`, and scores `62/100` on the client visual check.
4. Click `Open tool calls as nodes` on the completed turn to inspect `buildToolCallGraphArtifact` (`packages/core/src/browser/generative-canvas/tool-call-graph-artifact.ts`).

### Step 5: Map Codebase Root Causes to the 7-Pillar Antigravity Parity Blueprint
Cross-reference every observed frontend behavior with its exact backend and browser implementation:
- **Pillar 1 (Durable Task Daemon & Message Queue)**: `packages/core/src/node/gemini/streaming.ts`, `packages/core/src/browser/generative-canvas/hooks/useSendMessage.ts`, `packages/core/src/browser/generative-canvas/chat/Composer.tsx`
- **Pillar 2 (Closed-Loop 3D/VFX Verification Gate)**: `packages/core/src/node/gemini/agent-verification-service.ts`, `packages/core/src/node/gemini/streaming.ts`, `packages/core/src/browser/generative-canvas/chat/MessageNotices.tsx`
- **Pillar 3 (Spatial/Temporal `@` Mentions & Named glTF Sub-Parts)**: `packages/core/src/node/agent/context-mention-engine.ts`, `packages/core/src/browser/generative-canvas/chat/ContextMentionPopover.tsx`
- **Pillar 4 (Incremental DAG Execution & Canvas Operator Nodes)**: `packages/core/src/browser/generative-canvas/scene-node-graph.ts`, `packages/core/src/browser/generative-canvas/tool-call-graph-artifact.ts`
- **Pillar 5 (Stateful Tool-Call Pause/Resume & Structured Context Ledger)**: `packages/core/src/node/gemini/streaming.ts`, `packages/core/src/browser/generative-canvas/hooks/useSendMessage.ts`
- **Pillar 6 (Bidirectional `Scene3DWorldLens` Context Sync)**: `packages/core/src/browser/generative-canvas/lenses/Scene3DWorldLens.ts`, `packages/core/src/browser/generative-canvas/GenerativeCanvasWidget.tsx`
- **Pillar 7 (Chat Stepper Deduplication & `/` Skill Menu Guard)**: `packages/core/src/browser/generative-canvas/chat/Composer.tsx`, `packages/core/src/browser/generative-canvas/chat/MessageItem.tsx`, `packages/core/src/browser/generative-canvas/chat/AgentExecutionStepper.tsx`

---

## 4. Verification & Validation

- **Live Multi-Turn Execution Verified**: Both live prompts submitted through the browser UI completed end-to-end, advancing the scene artifact from `Active (v1)` -> `Active (v2)` -> `Active (v5)`, updating the WebGL viewport materials and lighting, and adding a playable `Camera Orbit` track (`00:00.00 / 00:05.00`) in the `3D Animation Sequencer`.
- **Visual & DOM Evidence**: Captured full-viewport screenshots and accessibility snapshots at each stage (home `@` and `/` popovers, 380s staged build drop, 31-step `Build Stages` DAG, `Provenance` view, `Scene Graph` lens, `Active (v2)` clay switch, `Active (v5)` golden hour + camera orbit, and `Tool Call Graph`).

---

## 5. Pitfalls, Edge Cases & Rollback

- **Pitfall 1 — React Controlled `<textarea>` Ignore on `fill`**: Calling `chrome-devtools-mcp` `fill` on the chat `<textarea>` in `Composer.tsx` mutates `.value` without firing React's synthetic input event cleanly when the `/` popover is active. **Fix**: Click the `<textarea>` element first and use `type_text` with `submitKey: "Enter"`.
- **Pitfall 2 — Bare `"/"` Submission When Inspecting `/SKILL` Menu**: Clicking the `/` button in `Composer.tsx` inserts `"/"` into `inputValue`; pressing `Enter` without selecting a skill sends `"/"` as a user prompt. **Fix**: Guard `handleSend` in `Composer.tsx` so a bare `"/"` or active skill filter selects/closes the popover instead of submitting.
- **Pitfall 3 — `take_screenshot` Sandbox Path Restrictions**: `chrome-devtools-mcp` `take_screenshot` only writes to system temp when `filePath` is omitted, returning the saved screenshot directly in the tool response media (`steps/<N>/media_0.png`). Always pass `pageId: 1` and omit `filePath`.

---

## 6. Reusability & Future Automation

- **Repeatable Live Frontend Audit**: Any future 3D/VFX UI feature can be verified end-to-end by attaching `chrome-devtools-mcp` to Chrome on port `9222` against `http://127.0.0.1:3490/` and driving both the chat composer and the 3D viewport lenses (`3D Viewport`, `Build Stages`, `Scene Graph`, `Studio Inspector`, `3D Animation Sequencer`, `Code / JSON`).
- **Implementation Roadmap**: The 7-Pillar Blueprint in this document serves as the direct specification for upgrading Scratchbox IDE's agent loop (`streaming.ts`, `useSendMessage.ts`, `AgentVerificationService`, `context-mention-engine.ts`, `Scene3DWorldLens.ts`, `tool-call-graph-artifact.ts`, and `Composer.tsx`).
