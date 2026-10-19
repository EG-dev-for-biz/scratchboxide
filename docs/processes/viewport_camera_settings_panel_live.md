# Process: Camera settings panel in the 3D viewport tool strip

> **Recorded:** 2026-10-19
> **Status:** Verified (24 mm f/1.4 with a picked focus point and a picked focus object, k1 = -0.15 barrel and its undo, chat agent and panel in sync both ways, camera pose and focus kept across two page reloads)
> **Tags:** `operate-scratchbox` `camera` `lens` `depth-of-field` `viewport-toolbar`
> **Target Domain:** Generative Canvas / 3D Viewport, Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** a camera icon in the viewport's vertical tool strip that opens a panel of camera settings, on top of the lens/DoF work in `viewport_lens_distortion_dof_live.md`; focal range 8-200 mm with a log slider.
* **Code:** `scene3d/CameraSettingsControl.tsx` (button and panel), `scene3d/cameraSettings.ts` (edits as `sb_set_camera` / `sb_set_camera_lens` commands, run through the real operator engine, all or nothing), `Scene3DPrimitive.tsx` (one undoable step per edit with the live pose, pick focus, restore, reload rule), `attachViewportControls.ts` (`pointPick`), `lighting-camera-operators.ts` (`sb_set_camera keepPoseOnLoad`), `browser/style/unified-ui.css` (`.sb-3d-camera-panel`: the app has no utility-class build, so Tailwind class names render unstyled).
* **Instance used:** web `3590`, API `3591`, tools `3592`, started from the worktree with `npm run dev` (not through `.claude/launch.json`, to leave the main checkout alone).
* **Scope tested:** the generated colonnade from `viewport_lens_distortion_dof_live.md` step 2.

---

## 2. What Was Tested & What Worked (Verified)

* **Tool strip** — the camera icon sits under frame/fit (`live_01_toolbar_camera_icon.png`); clicking it opens the panel anchored to its right, focus moves into the panel (`live_02_panel_open.jpg`).
* **Restore saved** — moved the auto-framed view to the stored pose the agent had set ([0, 1.8, 24.5] looking down the colonnade) (`live_03_...`).
* **24 mm** — the quick pick wrote `sb_set_camera {fov: 53.13}` and `sb_set_camera_lens {focalLengthMm: 24, sensor 36 x 24}`; the panel read 53.1° V · 73.7° H and the view widened without moving.
* **Depth of field f/1.4, pick focus** — switch on, f/1.4, "Pick focus in viewport", click on the nearest right column: focus 7.707 m, chain drew `depth-of-field`; the near column is sharp, the far columns and the beam above soft (`live_04_...`, `live_04b_...` zoom). Alt-click focused on the whole model (tracked at 24.51 m, `live_05_...`).
* **Barrel distortion** — k1 = -0.15 typed in the k1 field: drawn `depth-of-field, lens-distortion, output`, overscan 1.17 at 1.34:1, the floor edge and columns bend at the frame edges (`live_06_...`).
* **Undo** — the tool strip's undo reverted k1 (field back to 0, pass gone, history 5/6, redo label "Lens distortion k1 = -0.15") (`live_07_...`).
* **Panel -> agent** — "First tell me the camera's current focal length, f-stop and what it is focused on..." The agent answered 24 mm, f/1.4, the picked focus target, and noted the k1 = -0.15 had been undone (`live_08_...`).
* **Agent -> panel** — the same prompt then changed the lens to 35 mm f/4 through `configure_physical_camera` (`applied: true`); the open panel showed 35 mm, f/4, 37.8° V · 54.4° H, the focus object kept, and the undo button read "Undo: Agent: Set camera, Set camera lens" (`live_09_...`).
* **Reload** — first reload re-framed the view (see section 3). After the fix, reload opened on [0, 1.8, 24.5] with FOV 37.85°. The old focus object name could not be resolved after reload, and the notice said so honestly (`live_10_...`). Picked again, the focus is stored as the hero object `hero-1792444482155`; a second reload kept both the pose and the focus (DoF drawn at 24.51 m, no issues, `live_11_...`).
* **Console** — no errors after the reloads.

Automated: `viewport-camera-settings-panel.test.ts` (real Scene3DPrimitive in headless Chrome) and `camera-settings-commands.test.ts`. Screenshots: `test-results/screenshots/camera_toolbar/` (`live/` for this session).

---

## 3. What Broke / Didn't Work

* **Reload re-framed a saved scene (fixed in this session)** — the first fix kept the stored pose only for the base64 generated model, but a saved scene reloads the model from its hero file (`objects[]`, role `hero`), which `autoFrameIfNeeded(true)` force-framed: the camera came back at [51.8, 41.6, 51.8]. Now the first model of a mount, whether base64 or hero file, keeps a saved pose (`keepPoseOnLoad`) or the pose a lens was set for. `calculateStandoffCamera` still re-frames a pose inside the geometry or at the [15, 12, 15] boilerplate.
* **Focus object name changed across a reload (fixed)** — in-session the generated model is `scratchbox-cpp-generated-root`; after a reload it is the hero external object. Alt-click now stores the hero object's id, and the viewport resolves that id to the base64 root while that is loaded.
* **Browser pane width kept changing** during the session, which closes the panel (outside press) and clears the emulated viewport; not an app issue.

---

## 4. Candidate Tool/Service Ideas

* **Viewport screenshot to file** — the Browser pane's screenshots had to be copied out of the tool-results folder; a `__scratchbox_capture_viewport_with_ui(path)` (or an API route) that writes a PNG of the canvas including overlays would make UI evidence reproducible.
* **Scene data inspector for the active artifact** — reading `camera.lens` from the page needed the panel's own fields; a read-only `window.__SB_ACTIVE_SCENE__` (or a GET route) would let checks compare scene data, viewport and panel directly.

---

## 5. Reproduction Steps

1. Start the app from the worktree on free ports with the token URL.
2. "Build a 3D scene of a long colonnade: two straight rows of 12 square stone columns, 4 m apart, receding away from the camera along a flat paved floor with a regular grid of paving joints, and a straight entablature beam on top of each row."
3. Camera icon -> Restore saved -> 24 -> Depth of field on -> f/1.4 -> Pick focus in viewport -> click a near column (Alt-click for the whole model).
4. Type -0.15 in k1, Enter; then the tool strip's undo.
5. Ask the agent to report the camera's lens and change it to 35 mm f/4; reopen the panel.
6. Reload the page: the view opens on the stored pose with depth of field drawn.
