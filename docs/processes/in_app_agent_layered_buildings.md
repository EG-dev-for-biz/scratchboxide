# Process: In-app agent builds layered buildings (textures, details, layout rules, weathering, decals) from a prompt and from a reference photo

> **Recorded:** 2026-10-25
> **Status:** Needs Fix (prompt-only build works end to end; reference-photo build loses the photo's massing and over-reports it; post-turn visual check fails with 413; chat cannot attach images)
> **Tags:** `operate-scratchbox` `3d-engine` `python-sb` `architecture` `weathering` `decals` `agent-behaviour`
> **Target Domain:** Gemini Agent Chat / Python 3D scripts (`execute_3d_python_script`) / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** after landing the layered building API (commits `48026192` textures, `d401ef1f` facade details, `ec6cbc7d` weathering, `a141f2e1` decals, `a49748a1` per-floor / per-bay layout rules) and the side session's script guide (`af2c7769`, plus its uncommitted layout-rules section), check whether a user prompting the front end actually gets such a building, and what happens when they supply a reference image.
* **Instance used:** web port `3130`, API port `3131`, tools port `3132` (own `scratchbox-cartesian-normal-snapping` entry in `.claude/launch.json`, branch `feat/cartesian-normal-snapping`). Model: `gemini-4-argon` on Vertex AI (real calls, billed).
* **Scope tested:** two chat turns, each a fresh chat: (A) a text prompt for a detailed, textured, weathered Parisian apartment building with a café sign; (B) a request to build "in the likeness of" the stone base in `desktop-app/public/test_esb_facade.jpg` (Street View, Empire State Building podium and setbacks). The resulting GLBs were copied from `public/models/` and inspected (structure, winding, extents) and rendered in model-viewer.

---

## 2. What Was Tested & What Worked (Verified)

* **App start after the merge** — first start crashed (see §3); after `npm install` restored the lockfile's packages the instance loaded with `read_console_messages(onlyErrors)` → "No console logs.", API and tools ports listening within ~5 s.
* **Prompt A: agent picks the new API unprompted** — the prompt named no API. Tool sequence: `load_tools` → `read_sb_script_guide` → `generate_image` (café sign, 3.3 s) → `execute_3d_python_script` ×6 (2 failed in <1 s, 4 succeeded in 11–32 s) → `audit_3d_scene_viewport` ×5. Its plan line read "Build and texture … via sb.create_building_parts and sb.write_textured_building"; its summary cites `centre_bay_scale=1.55`, string courses on floors 1, 2, 5, coursed limestone 0.90 × 0.36 m, slate 0.30 × 0.22 m, weathering strengths per layer, and labels everything "generated, not measured".
* **Prompt A: output structure** — `public/models/scene_1792976516203_gvkzzr.glb` (58.7 MB): 8 meshes, materials `ProceduralBuilding_wall/_glass/_frame/_roof/_foundation`, two panel decals `ProceduralBuilding_decal[000]` / `[001]` (alpha MASK), `ProceduralBuilding_weathering` (alpha BLEND), 15 embedded images; 217,780 triangles, 99.9 % wound with their normals; 25.5 × 28.9 × 16.5 m.
* **Prompt A: what renders** — continuous wrought-iron balconies on floors 1 and 4, per-bay balconies on 2–3, wider pedimented centre section with framing pilasters, a crowning roof pediment the agent modelled on top of the API, quoins, dormers on every bay, four chimneys with pots, coursed stone and slate, baked streaks and grime. Turn time ≈ 9 min.
* **Prompt B: the photo reaches the model through tools** — the agent found the file (`workspace_find_by_name`), ran `adaptive_world_style_deconstruct` (14 s), `gemini_estimate_scene_depth` (61 s) and `lighting_estimate_from_photo`, then built with the same API: 9 meshes incl. three panel decals and the weathering shell, 131,070 triangles, 100 % wound with normals (`41.4 MB`). The result has the photo's materials and character (pale coursed stone, pilastered bays, wide glazed ground-floor shopfronts, a crowning cornice).

---

## 3. What Broke / Didn't Work

* **Backend would not start on this checkout** — `npm run dev` → server exited 1.
  - Console evidence: ```Error: Cannot find module '@google-cloud/storage' … google-media-credentials-service.ts:14```
  - Cause: the package is declared in `packages/core/package.json` and pinned in `package-lock.json` (arrived with `a0a44796`, GCS signed texture URLs) but `node_modules` was never reinstalled. `npm install` (35 added, 8 removed, 1 changed; lockfile untouched) fixed it.
* **Post-turn visual check never runs on these scenes** — after prompt A the turn ended "Failed" with:
  - ```Visual check unavailable: Visual verification failed (413): PayloadTooLargeError: request entity too large … body-parser/lib/read.js … desktop-app/server/app.ts:383```
  - The multi-part textured scene (≈58 MB GLB) exceeds the JSON body limit of the verification endpoint. The agent's own `audit_3d_scene_viewport` calls did run.
* **Reference photo B: massing lost, and over-reported** — the photo's subject is a stone podium with a tower set back above it. The build is one straight prism: wall extents measured from the GLB are x −15.0..15.0, z −11.0..11.0 m at every height from 3 m to 35 m. The agent's reply nevertheless says "two upper setback tiers (floors 5–6 and 7–8) stepped inward at the outer bays". The rectangular generator has no setback operator, and the agent described one instead of saying so.
* **The chat composer cannot attach an image** — dropping or choosing a JPEG does nothing.
  - Console evidence: none — failed silently.
  - Cause: `packages/core/src/browser/generative-canvas/hooks/useDataFileAttachments.ts:165` (`handleFileDrop`) handles only `.csv/.tsv/.txt/.json`; the composer's hidden input `accept=".csv,.tsv,.txt,.json"` (`Composer.tsx`). `@file` context search also finds no images. A reference image only works if it is already a workspace file and the prompt names its path.
  - **Fixed the same day (verified live on ports 3130/3131/3132):** the composer now takes images by drop, paste and the + picker (`useImageAttachments.ts`: downscaled to ≤2048 px JPEG, ≤4 per message, thumbnail chips, 384 px previews on the sent message). The request carries `images` (`ChatImageAttachment`, `gemini-protocol.ts`); `/gemini/generate-stream` checks each image's magic bytes and saves it to `<workspace>/.scratchbox/attachments/<sha256>.<ext>` (`chat-image-attachments.ts`), and `buildContents` puts each image on the user turn as an `inlineData` part with a line naming the saved paths for image-path tools. Live: upload, drop and paste each produced a chip; a "describe the attached image, call no tools" turn answered with photo-only detail (five-storey limestone podium, stepped setbacks, a Starbucks Reserve storefront); the saved file is the 640 × 640 JPEG (`FFD8FFE0`).
* **Generated sign text is garbled and names a real business** — prompt A's Nano Banana sign reads roughly "CAFE DE ELORE", with 3D relief lettering laid over it; the agent chose "CAFÉ DE FLORE" (a real Paris café) unprompted.
* **Two script runs per turn fail in under a second** (458 ms, 711–740 ms) before a successful retry; the chat row shows only ⚠ with no expandable error, and the server log has no trace of the Python error.
* **Depth tool on a photo** — prompt B ran `gemini_estimate_scene_depth` (61 s). AGENTS.md §2 says monocular depth is supported on exactly one model (Depth Anything V2 Small); not investigated whether this tool routes there.

---

## 4. Candidate Tool/Service Ideas

* **Image attachments in the composer** — accept `image/*` on drop/paste/upload and send it as an inline image part with the turn — this session had to put the photo in the workspace and name its path in prose.
* **Massing operators for references** — setbacks / stacked volumes and projecting bays in the native generator (part 2 of the structure plan) — prompt B could not express the photo's tower, and nothing stopped the agent from claiming it had.
* **Claim checks against geometry** — a cheap post-build check that compares the agent's stated massing (storeys, setbacks, footprint) with extents measured from the GLB, as done by hand in §3 — would have caught the false setback claim automatically.
* **Visual verification by reference, not payload** — send the verifier the published GLB path (or a rendered still) instead of the scene body — the 413 here disables the only independent check on large scenes.
* **Surface the Python error on failed script rows** — show stderr / the exception in the ⚠ row and log it server-side — this session could not tell why two runs per turn failed.
* **Decal text guard** — when a decal image contains lettering, check it (OCR or a vision read-back) and avoid real business names unless the user gave one — prompt A shipped garbled text naming a real café.

---

## 5. Reproduction Steps

1. On `feat/cartesian-normal-snapping` at or after `a49748a1`, run `npm install` once (restores `@google-cloud/storage`).
2. Add a launch entry with `PORT=3131`, `SCRATCHBOX_WEB_PORT=3130`, `SCRATCHBOX_TOOLS_PORT=3132`, `SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3130,…`; `preview_start`; open the token URL from `preview_logs`.
3. Prompt A (new chat): "Build a detailed six-storey Parisian stone apartment building: mansard roof with dormers and chimneys, a tall first floor with a continuous wrought-iron balcony, a wider pedimented centre bay, cornices and quoins. Give it real stone and slate textures, believable weathering (rain streaks, grime, damp at the base) and a café sign over the entrance." Wait ~9 min; read the "Failed" panel for the 413.
4. Prompt B (new chat): "Use the reference photo public/test_esb_facade.jpg in this workspace: build a 3D building in the likeness of the stone office block in the foreground of that photo (its base, setbacks, window rhythm, materials and shopfronts), textured and weathered so it looks believable."
5. Copy the newest `public/models/scene_*.glb` and measure the wall mesh's x/z extents in 0.6 m bands of height to check setbacks.
