# Process: Lens distortion and depth of field drawn by the 3D viewport

> **Recorded:** 2026-10-19
> **Status:** Verified (85 mm f/1.4 depth of field and k1 = -0.15 barrel distortion applied from chat and drawn in the live viewport; picking and gizmo follow the bent image)
> **Tags:** `operate-scratchbox` `camera` `lens` `depth-of-field` `tool-honesty`
> **Target Domain:** Generative Canvas / 3D Viewport, Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** `optics_configure_lens_distortion` returned `applied: false` and `configure_physical_camera` labelled depth of field, bokeh and anamorphic squeeze "computed only", because `LensDistortionEffect` and `CinematicBokehPass` were not wired into the viewport (`tools_applied_or_not_applied_live.md`, section 4).
* **Code:** `canvas-types.ts` (`SceneCameraLens`, `SceneLensDistortion` on `camera.lens`), `lighting-camera-operators.ts` (`sb_set_camera_lens`, `mergeCameraLens`), `scene3d/viewportOptics.ts` (`ViewportOpticsChain`, the distortion and circle-of-confusion maths), `Scene3DPrimitive.tsx` (frame draw, capture, notice), `attachViewportControls.ts` (`mapPointerNdc`), `LensDistortionEffect.ts` (`sourceScale` for overscan), `spatial-tools.ts` (both tool handlers), `task-capability-resolver.ts`.
* **Instance used:** web `3571`, API `3572`, tools `3573`, started from the worktree with `npm run dev`.

### How the viewport draws a lens

* `camera.lens` holds continuous fields: Brown-Conrady `k1, k2, k3, p1, p2` in normalized camera coordinates (x = X/Z, the frame `VfxPlateMatchmoveService.distortPoint` and the pose solvers use), focal length, sensor, f-number, focus distance or a focus object, anamorphic squeeze, `depthOfField`. No presets are stored.
* Only when a pass is configured, the frame is drawn: scene (overlays hidden) into a half-float target with a depth texture, with the frustum widened by the overscan the distortion needs; `CinematicBokehPass` with the thin-lens circle of confusion c = f² |d − s| / (N d (s − f)), scaled by the frame height on the sensor and passed as a radius (c / 2); overlays (gizmo, selection box, brush ring) on top, sharp; `LensDistortionEffect` in redistort mode; tone mapping and output colour space, with a flat background composited after tone mapping as a direct draw clears to it.
* Picking maps the pointer back through the inverse distortion. The capture function (`__scratchbox_capture_active_3d_scene`, the agent's visual check) draws through the same chain.
* A focus object is measured every 30 frames (bounding-box centre, depth along the view axis), so focus follows it as the camera moves.
* A lens that folds back (the polynomial has no inverse, detected by a non-positive Jacobian between the centre and the frame edge) inside a square frame is refused by the operator; one that folds only on wide frames is kept and the tool says from which aspect ratio it is not drawn; the viewport then shows a "Lens optics not fully drawn" notice.

---

## 2. What Was Tested & What Worked (Verified)

* **Depth of field from chat** — on a generated colonnade (two rows of 12 columns, paved floor), "Give the camera an 85mm lens at f/1.4 focused on the column pair 17 m in front of the camera" → `configure_physical_camera` returned `applied: true`, operators `sb_set_camera`, `sb_set_camera_lens`, passes `["depth-of-field", "output"]`; `camera.fov` 48° → 16.071°; the chain reported `focusDistanceMeters: 17`, drawn `depth-of-field, output`. The far end of the colonnade and floor go soft, the near columns stay sharp (`live_05_...png`, before `live_04_...png`).
* **Barrel distortion from chat** — "Add barrel distortion k1 = -0.15 to the lens" → `optics_configure_lens_distortion` `applied: true`, `camera.lens.distortion = {k1: -0.15, ...}`, passes `depth-of-field, lens-distortion, output`. At 16° the same k1 is only about a 1 % shift at the corners (overscan 1.007), as the camera-coordinate model says (`live_07_...png`).
* **Wider lens** — "swap to a 24mm lens at f/1.4, focused 6 m in front of the camera, keeping the barrel distortion" → first attempt refused ("fold back inside a 53.1° frame") under the first fold rule (16:9 fixed); the rule was changed to the square/aspect rule above, the server restarted, and the retry applied: FOV 53.13°, overscan 1.225, the floor edge and paving joints bend at the frame edges, and the reply quoted "on frames wider than 1.72:1 ... draws no distortion" (`live_09_...png`, `live_10_...jpg`).
* **Picking** — with k1 = -0.15 at 53°, ray hits for displayed pixels: the left column edge at row 470 is at x = 405 in the drawn image; the mapped ray first hits geometry at x = 405, the unmapped ray at x = 400 (row 20: 363 vs 352). Clicking a column with the move tool selected it; the selection box bends with the columns and the gizmo is drawn sharp on top (`live_11_...png`).
* **Background** — the first DoF frame darkened the flat `#b0b8c4` background (tone-mapped into the target); fixed by drawing over a transparent clear and compositing the background after tone mapping. With aerial perspective active the chain copies its output unchanged (that pass applies no tone mapping on the canvas either).
* **Clay render mode** — every scene in this session was in clay; the passes operate on the drawn frame and the clay materials are untouched.
* **Heavy scene** — the passes on a 2.04 M-vertex staged district (`live_12_...png` off, `live_13_...png` 35 mm f/1.4 at 90 m with k1 = -0.08).
* **Unit tests** — `viewport-lens-optics.test.ts` (shader frame with converted coefficients = `VfxPlateMatchmoveService.distortPoint` to 1e-12; undistort/distort round trip < 1e-9; the GLSL 5-step inverse within 1e-4 frame heights at the corners; overscan; fold detection; circle of confusion against hand values, the shader's formula and `PhysicalCameraModel` DoF limits; passes present only when configured); `tools-apply-or-say-not-applied.test.ts` (both tools apply, undo/redo of `sb_set_camera_lens`, preset conversion, plate modes and folding lenses NOT applied).

### Frame time (passes on vs off)

Measured in the page: 60 frames of the viewport's own frame draw, each followed by a 1-pixel `readPixels` to wait for the GPU, after 5 warm-up frames; Apple Silicon GPU, Chrome in the Browser pane.

Heavy scene: the staged Washington Square Park district (2,043,450 vertices, 1,193,709 triangles, the scan's own trees in the remeshed clay; 10 meshes), canvas 1481 x 949, 35 mm f/2 focused at the target, k1 = -0.08 (overscan 1.135). Median of 8 blocks of 30 frames per configuration, configurations interleaved, two runs:

| Passes | Run 1 (ms/frame) | Run 2 (ms/frame) | Added vs off |
| :--- | ---: | ---: | ---: |
| none (direct draw, as before) | 2.65 | 2.73 | — |
| depth of field | 3.04 | 3.11 | +0.4 |
| lens distortion (1.29x pixels from overscan) | 3.24 | 3.27 | +0.55 |
| both | 3.35 | 3.33 | +0.65 |

Light scene (the colonnade, 1416 x 942, 24 mm, k1 = -0.15, overscan 1.225; 60 consecutive frames): off 1.2-1.4 ms, depth of field 2.3-2.4 ms, distortion 2.9 ms, both 2.9-3.1 ms. With no lens the chain is inactive and the viewport draws straight to the canvas as before (no targets are allocated).

The staged build itself degraded at the tree stage (`trees_not_measured: tile_vegetation strip command failed on the extracted tile mesh, including on retry`), so the district carries the scan's own trees rather than regrown SB-Veggie trees; not investigated here.

Screenshots: `test-results/screenshots/lens_dof/`.

---

## 3. What Broke / Didn't Work

* **Reload re-frames the camera** (existing): after a page reload the generated model is auto-framed with `force: true` at the scene FOV, so the stored pose is lost; with an 85 mm lens focused at 17 m the reframed view stood ~100 m away and everything was out of focus (the agent's visual check called it "blurry due to extreme depth-of-field settings"). The lens is right; the pose is not kept.
* **Physical scale makes depth of field subtle on large scenes**: 85 mm f/1.4 focused at 55 m on the 97 m sci-fi crater gives at most ~2.7 px blur radius on an 843 px frame (the near limit 41 m, far 79 m). The blur is drawn as the thin-lens model gives it; it is not exaggerated.
* **Focus by node name**: generated models are often merged meshes (the colonnade's 12 columns are one `mesh`), so "focus on the third column" can only be a distance; `focusObjectId` resolves a whole node.

---

## 4. Candidate Tool/Service Ideas

* **Keep the stored camera pose on reload** when the scene has one (or when it has a lens), instead of forcing auto-framing; with a lens the reframed distance changes what is in focus.
* **A focus point tool** — "focus where I click" (raycast the displayed pixel through `mapPointerNdc`, store `focusDistanceMeters`), because a merged mesh offers no object to name.
* **Agent-visible optics status** — expose `ViewportOpticsChain.status` (drawn passes, overscan, focus distance, issues) to the agent's visual check, so it knows what the viewport drew.

---

## 5. Reproduction Steps

1. Start the app from the worktree on free ports with the token URL.
2. New chat: "Build a 3D scene of a long colonnade: two straight rows of 12 square stone columns, 4 m apart, receding away from the camera along a flat paved floor with a regular grid of paving joints, and a straight entablature beam on top of each row."
3. "Give the camera an 85mm lens at f/1.4 focused on the column pair 17 m in front of the camera." → `applied: true`, depth of field drawn.
4. "Add barrel distortion k1 = -0.15 to the lens." → `applied: true`, distortion pass drawn.
5. "Swap to a 24mm lens at f/1.4, focused 6 m in front of the camera, keeping the barrel distortion." → lines bend at the edges.
6. In the page: `window.__SB_3D_OPTICS__.status` shows the drawn passes; `__SB_3D_RENDER_FRAME__()` draws one frame through them.
