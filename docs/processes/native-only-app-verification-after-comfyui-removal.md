# Process: Native-Only App Verification After ComfyUI Removal

> **Recorded:** 2026-10-12
> **Status:** Needs Fix
> **Tags:** `operate-scratchbox` `comfyui-removal` `native-3d` `node-graph` `css-regression` `dev-server`
> **Target Domain:** Generative Canvas / 3D Viewport, Node Graph Primitive, Desktop Dev Server

---

## 1. Session Context

* **What prompted this session:** The ComfyUI / Cloud Run "Tier 2" fallback was removed (branch `remove-comfyui-tier2`). This session confirmed the app still works end to end on the native-only path.
* **Instance used:** web port `3042`, API port `3040`, tools port `3041`, via a separate `scratchbox-remove-comfyui` entry in `.claude/launch.json` that runs `npm --prefix <worktree> run dev`.
* **Scope tested:** dev server boot, capability-resolution endpoints, removed `/api/comfyui` routes, the showcase demo catalog, the node-graph demo, and one live agent 3D prompt.

---

## 2. What Was Tested & What Worked (Verified)

* **Removed ComfyUI routes** — `GET /api/comfyui/status` and `GET /api/comfyui/cloudrun/status` → `404`. Evidence: network log entries for both requests.
* **Capability resolution** — `POST /api/capabilities/resolve` with "procedural mountain terrain with SDF marching cubes" → `200`, `canSolveNatively: true`, `primaryNativeEngine: cpp-3d-engine`. The same call with a Trellis image-to-3D goal → `canSolveNatively: false` and a rationale starting "Not natively supported". `POST /gemini/capability/resolve` → `200`, with no `tier2Fallback` or `recommendedResolutionRoute` fields in the response.
* **Demo catalog** — Settings → Admin & Demos lists "Native 3D Generation Pipeline Graph" (badge NATIVE). The old "Autonomous AI Diffusion Pipeline Graph" (ComfyUI / Cloud Run L4) no longer appears.
* **Node-graph demo** — Launch Stage → renders six styled node cards (Prompt → Capability Resolver / Scene Contract → C++20 Compile → Complexity Gate → glTF Viewport) with edges, status badges, and a working Fit View. This required the CSS fix in section 3.
* **Live 3D prompt** — "build a 3d model of a small stone lighthouse on a rocky outcrop" → the agent called `execute_3d_python_script` (the `scratchbox` engine) → `public/models/scene_1791868289435_aqjafh.glb` (glTF magic, 604 KB, 107 meshes, Y 0–25.7 m) streamed into the 3D viewport. No console errors and no ComfyUI calls in the network log.

---

## 3. What Broke / Didn't Work

* **Dev backend would not boot on committed `main`** — `npm run dev` → server exited with code 1 after 14 s.
  - Console evidence: ```Error: Cannot find module '../3d-engine/gltf-binary-packer.js' … GoogleVectorTileService.ts```
  - Cause: ts-node runs the backend as CommonJS and cannot resolve `./x.js` imports to `x.ts`. Fixed in `cb1f125` by dropping the `.js` extension from relative imports in 7 files. Another session's uncommitted work in `main` makes the identical change.
* **Vite ignored `SCRATCHBOX_WEB_PORT`** — the `vite:dev` script hardcoded `--port 3030`, so Vite drifted to the next free port. Fixed in `e4f9ce6`.
* **Node graph, kanban, diff, MCP, modal, exec-plan and other components rendered unstyled** — the node-graph demo showed bare text and browser-default buttons. Computed styles on `.sb-graph-node-card` were `position: static` with a transparent background.
  - Network evidence: n/a (no rule existed to load).
  - Cause: commit `39352e9` (2026-10-02) rewrote `browser/style/index.css` from 12,632 to 567 lines. That dropped 911 classes, 565 of which are still rendered. Fixed in `998bf72` with a generated `legacy-restored.css` containing only the rules for those still-used classes, imported before `index.css`.
* **3D viewport renders the generated model twice** — after the lighthouse prompt, the viewport showed two stacked copies, the second offset upward by about one scene height. The GLB is correct (a single model), and it was fetched twice, once before and once after `POST /gemini/verify-visual`. Suspected cause: the visual verify/repair pass re-mounts the GLB without removing the first instance. Not fixed in this session.
* **Clay material not applied in the Python engine output** — the script calls `scene.apply_material(sb.PbrMaterial.clay())`, but all 107 meshes in the GLB carry `defaultMaterial` (base color 0.8/0.85/0.9, roughness 0.5) and each has its own duplicate material. Not investigated.

---

## 4. Candidate Tool/Service Ideas

* **`viewport_scene_stats` endpoint** — return the live Three.js scene's object/mesh count and the GLB URLs currently mounted. This session had to infer the double mount from a screenshot plus two GLB fetches in the network log.
* **CSS coverage check in CI** — fail when a `className` token used in TSX has no matching rule in any stylesheet. A 565-class regression shipped unnoticed for 10 days, and the restoring script (class diff via postcss) could be adapted into this check.
* **`/gemini/generate-stream` tool-call log on the server** — the backend logs nothing about which tool ran. Confirming the native path required reading the SSE body from the browser network panel.

---

## 5. Reproduction Steps

1. `git worktree add ../scratchbox-remove-comfyui remove-comfyui-tier2` and run `npm ci` in it.
2. Add a launch entry with `PORT=3040`, `SCRATCHBOX_WEB_PORT=3042`, `SCRATCHBOX_TOOLS_PORT=3041`, and `SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3042,http://localhost:3042`, running `npm --prefix <worktree> run dev`. In this dev mode the Vite proxy injects the API token, so no `?token=` URL is needed.
3. Open `http://127.0.0.1:3042/`, then Demos → "Native 3D Generation Pipeline Graph" → Launch Stage → Fit View.
4. New Chat → "build a 3d model of a small stone lighthouse on a rocky outcrop" → wait about 30 s → Fit to View to see the double mount.
