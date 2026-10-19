# Process: algorithmic_uv_unwrap_rewrap — real UV unwrap and texture rewrap, driven from the chat

> **Recorded:** 2026-10-19
> **Status:** Verified (rewrap of the Puck Building raw textured tile from chat: 72/72 materials, 0 failures, 0 overlapping pairs, rendered with the rebaked atlases in the 3D viewport)
> **Tags:** `operate-scratchbox` `uv-unwrap` `texture-rewrap` `3d-viewport`
> **Target Domain:** Gemini Agent Chat / Generative Canvas 3D Viewport

---

## 1. Session Context

* **What prompted this session:** `AlgorithmicUvEngine.processGlb` threw for every mode but `preserve-100-lock`; modes `unwrap` and `rewrap` were implemented (UvAtlasRewrap.ts, scratchbox_uv_rewrap.hpp) and had to be shown working from the chat.
* **Instance used:** web port `3462`, API port `3461`, tools port `3463`, started from the `uv-rewrap` worktree (`npm --prefix desktop-app run dev` with those ports), credentials from `../integration-behaviour/secrets.json` linked only while running.
* **Scope tested:** a chat request to rewrap a real Google 3D Tiles scan (the Puck Building staged run's `tiles/<key>/textured.glb`, 182,649 triangles, 72 materials, 72 JPEG textures) and show it in a 3D scene.

---

## 2. What Was Tested & What Worked (Verified)

* **Rewrap from chat** — prompt "Rewrap the UVs of …/puck_textured.glb: new non-overlapping UV atlas and rebake its textures into it. Then show the rewrapped model in a 3D scene." → the agent called `algorithmic_uv_unwrap_rewrap` (mode `rewrap`, 10.9 s) and `mount_canvas_primitive`. The answer card reported 72 of 72 materials rewrapped, 0 failures, 0 overlapping triangle pairs, 0 flipped triangles, 15,521,600 texels rebaked into `TEXCOORD_0` in 10,197 ms.
* **Viewport** — after a follow-up the scene loaded the output GLB (16.7 MB) in clay, and on request in PBR mode: the rebaked atlases render on the tile with no visible seams (screenshot `test-results/screenshots/uv_rewrap/inapp_rewrap_viewport_pbr.jpg`). Console after load: only the 404 of the first, wrong URL (below).

---

## 3. What Broke / Didn't Work

* **First scene URL** — the agent mounted `/models/puck_textured_rewrap.glb` while the tool had written the file next to the input (`test-results/…/puck_textured_rewrap.glb`), so the viewport showed "A model failed to load … 404". Asking it to rerun with `outputGlbPath public/models/…` fixed it (the app's workspace root is `desktop-app`, the file landed in `desktop-app/public/models`).
  - Console evidence: `Failed to load resource: the server responded with a status of 404 (Not Found)`
  - Suspected cause: the agent guesses a `/models/` URL for a file outside `public/models`; not a tool fault.
* **Tool payload size** — the first tool result was 317,223 characters (72 atlases with chart details) and was truncated to 200,000 for the model. Fixed in the same change: the payload now carries the 12 largest atlases (worst 3 charts each) and one line per other atlas.

---

## 4. Candidate Tool/Service Ideas

* **Served URL in GLB-writing tools** — tools that write a .glb could return the `/models/...` URL the viewport can load (or copy the file there), so the agent does not guess one; this session needed a second rewrap to get a loadable path.
* **UV checker / UV-layout view in the 3D viewport** — a render mode that shows a checker through a chosen TEXCOORD set (and an atlas layout panel) would let the chat show an unwrap's distortion; this session used the test renderer's checker renders instead.

---

## 5. Reproduction Steps

1. Copy a staged run's `tiles/<key>/textured.glb` somewhere under the workspace.
2. Start the app on free ports (see the operate-scratchbox skill) with credentials available.
3. Ask the chat to rewrap that GLB's UVs and show it in a 3D scene, with `outputGlbPath` under `public/models/`.
4. Ask it to switch the viewport to PBR mode to inspect the rebaked textures.
