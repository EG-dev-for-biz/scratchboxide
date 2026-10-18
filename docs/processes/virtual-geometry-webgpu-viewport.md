# Process: WebGPU Virtual Geometry Viewport (streamed cluster LOD DAG) — built, wired, verified live

> **Recorded:** 2026-10-18
> **Status:** Verified (in the running app on WebGPU/SwiftShader; not yet measured on a hardware GPU)
> **Tags:** `operate-scratchbox` `virtual-geometry` `webgpu` `cluster-lod` `cpp20` `3d-viewport`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** The earlier "next-gen" viewport meant to carry far more geometry than a three.js scene (`NextGenAstraViewportEngine`, `WebGpuMeshletCullingPipeline`, `MeshletPipelineService`) did not work and was not mounted anywhere. It was replaced with a working implementation and wired into the app.
* **Instance used:** web port `3032`, API port `3013`, tools port `3014` (the `scratchbox-dev` entry of `.claude/launch.json`), driven by Playwright in **headed** Chromium under Xvfb with `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader`.
* **Scope tested:** A 3d-scene artifact with `data.virtualGeometry.sourceGlbPath` (the Colosseum clay GLB, 170,802 triangles, 79 nodes with transforms). The test covered the build route, streaming, the HUD statistics, orbit and zoom, shading modes, the error-threshold slider, persistence across reloads, and rebuilding a deleted file.

### What was wrong with the old engine (now deleted)

| Claim | Reality |
|---|---|
| "10B+ virtual triangles", "0.08 ms GPU cull", "99.4% quad efficiency", "1.0x overdraw", cache hit rate, "effective FPS" | Hardcoded constants and multipliers (`calculateEffectiveFps` multiplied measured fps by 1.18 × 1.25 × 1.15 …) |
| Hi-Z occlusion, software micro-rasterizer, visibility buffer, TSR, micro-relief | WGSL strings with empty bodies; the flags only changed telemetry |
| WebGPU culling pipeline | Real GPU code, but it drew one 128-triangle cylinder instanced 8,192 times. It could never start through the engine, because `initializeWebGpu()` asked for a `webgpu` context on the canvas the engine had already given to `THREE.WebGLRenderer`. |
| TypeScript cluster DAG (`MeshletPipelineService`) | Each "parent" was the first 32 vertex refs and 16 triangles of one child; the error came from bounding-sphere size |

---

## 2. What Was Tested & What Worked (Verified)

* **Native builder** (`scratchbox_virtual_geometry.hpp`, compiled by `VirtualGeometryBuildService` through `NativeCppCompilerService`).
  - Colosseum (170,802 triangles) → 5,027 clusters, 5 levels, 5.4 MB, built in 2.2 s.
  - Arch of Constantine (88,556 triangles) → 2,350 clusters, 9 levels; the coarsest block is 20 KB.
  - Evidence: the `POST /3d/virtual-geometry/build` response (`stats`, `buildMs: 2215`) and the `packages/core/test/virtual-geometry.test.ts` output.
* **Crack-free LOD.** The tests check every DAG level of a closed bumpy sphere, and every cut the GPU selection rule can pick for several cameras, thresholds and streaming stages. All were closed manifolds: 0 edges with a use count other than 2.
  - Mutation check: with border locking turned off, the same tests fail (2,834 open edges at level 1). The test therefore detects cracks rather than passing vacuously.
* **Build route.** `POST /3d/virtual-geometry/build {sourceGlbPath, workspaceRoot}` → `200 {success, sbvgUrl: "/build/3d-virtual-geometry/b05b60cd….sbvg", stats}`. The file is served statically from `desktop-app/build/3d-virtual-geometry/`.
* **Streaming.** The `.sbvg` GET returned 200 with 5.2 MB. Levels arrived coarsest first (4 → 3 → 2 → 1 → 0), and the HUD read `Streamed 5/5 levels · 5.2 MB of 5.2 MB`.
* **Rendering and stats.** Overview HUD: `Triangles drawn: 78,123 of 170,802 at full detail · Clusters drawn: 1,159 of 5,027 · 1 draw call · GPU cull 0.57 ms · draw 134.84 ms` (SwiftShader). Screenshot: the whole site in clay, centred and filling the panel.
* **Interaction.**
  - Wheel zoom plus drag orbit: 51,399 triangles drawn, close-up of the arena walls. In "LOD levels" shading, the near geometry is level 0.
  - Error slider at 8 px: 26,808 triangles and 330 clusters, for the same view.
* **Persistence.** Saved `virtualGeometry` = `{sourceGlbPath, sbvgUrl, buildStats{…}, shading}`. After a reload: 0 build POSTs and 1 `.sbvg` GET.
* **Missing file.** After deleting the built `.sbvg`, a fresh browser context got `GET … 404` → `POST /build 200` → `GET … 200`, and the scene rendered.
* **Failure is visible.** With a GLB path outside the active workspace, the route returned `404 {"error":"GLB not found …"}` and the viewport showed a red "Virtual geometry viewport unavailable" panel with that message. No fallback renderer was used.
* **Checks.** `tsc` passes on core, the desktop app and Electron. `lint:primitives` passes. eslint reports 0 errors. `docs:mcp:check` is up to date. The tool registry, permission and time-budget tests pass.

---

## 3. What Broke / Didn't Work

* **Headless WebGPU canvas presentation (test environment, not the app).** In headless Linux Chromium, presenting a WebGPU canvas loses the device; offscreen rendering works.
  - Console: ```A valid external Instance reference no longer exists.```
  - Workaround: run Chrome windowed under Xvfb. `packages/core/test/helpers/webgpu-chrome.ts` does this automatically.
* **First layout used Tailwind utility classes.** The desktop app has no Tailwind pipeline, so the canvas stayed at 300×150 and the overlays weren't positioned. Fixed with inline styles; only the existing `sb-segmented-control` classes are used.
* **Workspace root.** With the dev server, the active workspace is `desktop-app/` (the server's working directory), so `deploy/…` paths in the repo root are refused as outside the workspace. That refusal is correct. For the verification run the GLB was copied into the gitignored `desktop-app/build/vgeo-verify/`.
* **Duplicate build POSTs on first open.** The first open sends 3 POSTs: React StrictMode double-mounts, and the workspace path arrives after the first render. The server shares one build among them, so they don't triple the work.
* **Known quality limits.** These were observed, not bugs in the cut:
  - Meshes made of many unconnected pieces (Google tile chunks) stop simplifying early: the Colosseum's coarsest level is still 19.6k triangles, because locked group borders and open tile seams leave little to collapse.
  - The renderer has no textures, UVs or materials; it draws positions and smooth normals in clay.
  - Each storage buffer is limited to the device's binding size (128 MB on SwiftShader, about 5.5M vertices). Larger models need buffer splitting.

---

## 4. Candidate Tool/Service Ideas

* **`virtual_geometry_open_glb` fallback to the repository root.** The tool and the route resolve paths only against the workspace. `tile_refine` already looks in the checkout first (`tileRefineRootFor`), and reusing that here would let the agent open the repo's own assets without copying them.
* **Offscreen capture on the renderer** (`captureFrame()` → RGBA). Tests had to draw the presented canvas into a 2D canvas within the same task. A render-to-texture capture would also give the agent visual verification, as `__scratchbox_capture_active_3d_scene` does for the three.js stage.
* **A route that reports build progress.** Multi-million-triangle builds take minutes and the viewport only says "Building…". The builder could print per-level progress lines for the route to stream as SSE.

---

## 5. Reproduction Steps

1. `npm ci` and make sure `clang++` exists (C++20). On Linux without a display, install `xvfb` for the browser test.
2. `npx vitest run packages/core/test/virtual-geometry.test.ts`. Screenshots go to `test-results/screenshots/virtual_geometry_*.png`.
3. Start the app: `env SCRATCHBOX_NO_ELECTRON=true PORT=3013 SCRATCHBOX_WEB_PORT=3032 SCRATCHBOX_TOOLS_PORT=3014 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3032,http://localhost:3032 npm run dev`. Open the `?token=…` URL from the log, in a browser with WebGPU (Chrome 113+ with a GPU, or Chromium with the SwiftShader flags above and a display).
4. Open a GLB in the viewport, in either of two ways:
   - **Agent:** ask the agent to call `virtual_geometry_open_glb({ glbPath: "<path inside the workspace>" })`.
   - **By hand:** create a 3d-scene artifact whose data is `{ title, virtualGeometry: { sourceGlbPath: "<path inside the workspace>" } }`.

---

## 6. Instructions for an Agent Working on This Viewport

**What it is.** Nanite-style virtual geometry.
- **Offline:** `scratchbox_virtual_geometry.hpp` turns a GLB into a cluster LOD DAG.
  1. It loads every triangle primitive with its node world transform, welds vertices by exact position, and computes area-weighted normals.
  2. It splits the mesh into clusters of at most 128 triangles.
  3. Level by level, it groups 8 adjacent clusters, simplifies each group to half its triangles with the vertices shared with other groups locked, and re-splits the result.
  4. Every cluster stores the LOD sphere and error of the group that produced it (`self`) and of the group it was simplified in (`parent`). It writes `.sbvg`, coarsest level first.
- **At runtime:** `VirtualGeometryRenderer` (WebGPU) streams the file.
  - One compute pass draws cluster *i* iff `projErr(parent) > t && (level == finestLoaded || projErr(self) <= t)`, then applies frustum and normal-cone culling and appends survivors to an indirect draw.
  - The vertex shader pulls cluster triangles from storage buffers.

**Files.**

| Layer | File |
|---|---|
| Builder (C++20) | `packages/core/src/native/3d-engine/include/scratchbox_virtual_geometry.hpp` |
| Build service, served files, builder driver | `packages/core/src/node/3d-engine/virtual-geometry-service.ts` |
| HTTP route | `desktop-app/server/routes/virtualGeometryRoutes.ts` (mounted at `/3d/virtual-geometry`; static `/build/3d-virtual-geometry` in `app.ts`) |
| Agent tool | `packages/core/src/node/gemini/tools/virtual-geometry-tools.ts` (`virtual_geometry_open_glb`) |
| File format reader | `packages/core/src/browser/generative-canvas/services/virtual-geometry/sbvg-format.ts` |
| WebGPU renderer and WGSL | `packages/core/src/browser/generative-canvas/services/virtual-geometry/VirtualGeometryRenderer.ts` |
| React viewport | `packages/core/src/browser/generative-canvas/primitives/VirtualGeometryViewport.tsx` (chosen in `studio/CanvasCardBody.tsx` when `data.virtualGeometry` is set) |
| Tests | `packages/core/test/virtual-geometry.test.ts`, `packages/core/test/helpers/webgpu-chrome.ts` |

**Invariants the tests enforce. Keep them true.**
1. Every DAG level of a closed mesh is closed, and so is every cut the selection rule can pick at every streaming stage. Before trusting a change to grouping or simplification, break the border locking on purpose and check that the tests fail.
2. `parentError >= selfError`, and the parent LOD sphere contains the self sphere.
3. All clusters made from one group share the same `self` values, and all members of a group share the same `parent` values. The per-cluster rule is only consistent because of this.
4. A stream block references only vertices from itself or earlier blocks.
5. Simplification only collapses onto existing vertices, so every level indexes one vertex buffer. Placing collapses at optimal positions would break this and the format.
6. Every statistic shown is measured: GPU readback of the indirect args, timestamp queries, and rAF fps. Never show estimated or multiplied numbers. If a capability is absent (for example timestamp-query), say so.
7. There is no fallback renderer. Missing WebGPU, a failed build or a failed fetch is shown to the user as an error.

**How to verify a change.**
1. `npx tsc --noEmit -p packages/core`
2. `npx vitest run packages/core/test/virtual-geometry.test.ts`
3. Look at the saved screenshots.
4. For UI changes, run the app (section 5) in a browser with WebGPU. In this cloud container that means headed Chromium under `xvfb-run` with the SwiftShader flags; headless presentation crashes. Check the HUD, the console and the network.
5. The C++ header compiles standalone (`clang++ -std=c++20 -O3 -I…/include`). Don't include `scratchbox_io.hpp`: its JSON value type fails to compile with GCC 13's libstdc++ on Linux.

**Next steps, in order of value.**
1. **Hi-Z occlusion culling:** a two-pass scheme that culls against last frame's depth pyramid. It is the biggest remaining win for dense interiors and cities.
2. **On-demand paging.** Today the whole file is streamed and resident. Stream fine levels only for clusters the cut requests (a GPU feedback buffer of wanted groups, pages per group) to go past GPU memory.
3. **Buffer splitting** for models above `maxStorageBufferBindingSize`.
4. **Better simplification across disconnected pieces:** merge spatially adjacent groups and allow locked-border vertices to unlock after a level, so tile-chunk scenes reach a small root.
5. **Attributes:** UVs and material ids per vertex, carried through collapses, then textured shading.
6. **Exact triangle expansion:** compact visible triangles in compute instead of drawing 384 vertex invocations per cluster (coarse clusters average 20–40 triangles).
