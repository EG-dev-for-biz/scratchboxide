# Process: Auto focus and focus-point tracking in the 3D viewport camera panel

> **Recorded:** 2026-10-19
> **Status:** Verified (85 mm f/1.4 auto focus following a pan from a 26.7 m column to a 10.6 m column one column at a time; a tracked column point staying at the focus distance through three orbits; Manual / Auto / Track from the panel and from the chat agent; reload kept the tracked point; undo walked back through the modes)
> **Tags:** `operate-scratchbox` `camera` `lens` `depth-of-field` `auto-focus` `viewport-toolbar`
> **Target Domain:** Generative Canvas / 3D Viewport, Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** the camera panel's Depth of field section had only a static focus distance (and Alt-click to track a whole object). Two new options: continuous auto focus on the centre of the frame, and focus locked onto a clicked surface point that follows the camera and the object.
* **Code:** `scene3d/viewportFocus.ts` (new: `ViewportFocusController`, the AF depth read, the focus pull, point tracking), `scene3d/viewportOptics.ts` (only a `measureFocus` hook, and measured focus counts as a focus source), `scene3d/CameraSettingsControl.tsx` (mode selector, AF area, pull time, reticle toggle), `Scene3DPrimitive.tsx` (controller, reticle, Track pick), `scene3d/ViewportNotice.tsx` ("Focus held" status), `lighting-camera-operators.ts` (`sb_set_camera_lens` focus fields, world-to-local point conversion), `spatial-tools.ts` (`configure_physical_camera`), `canvas-types.ts` (`SceneCameraLens.focusMode`, `autoFocusAreaFraction`, `focusPullSeconds`, `focusPoint`).
* **Instance used:** web `3660`, API `3661`, tools `3662`, started from the worktree with `npm run dev` (not `.claude/launch.json`). Browser pane emulated at 1440 x 900.
* **Scope tested:** a colonnade generated in this session (two rows of 12 fluted square columns at x = ±2 m, 3.2 m bay pitch, 109,656 vertices).

### How focus is measured

* **Auto:** every 100 ms the scene's own depth buffer (the depth texture depth of field blurs from) is read at 5 x 5 points over a centred square AF area (`autoFocusAreaFraction` of the frame height, default 0.10) by a 5 x 5 pass and `readRenderTargetPixels`. The nearest robust depth is the 20th percentile of the samples that hit geometry (one stray near pixel does not grab focus). The focus glides toward it with an exponential time constant `focusPullSeconds` (default 0.3 s) in dioptres (1 / distance), the way a focus ring travels; 0 snaps. Samples at the cleared far plane (sky) are left out; if none hit, the last focus is held.
* **Track:** a click stores the hit point in the local frame of the object its id resolves to (`focusPoint: { objectId, localPosition }`, the generated model saved as its hero object id). Each frame the point goes through the object's current world matrix and its depth along the view axis is the focus distance, so it follows camera moves and object animation. A point without `objectId` is a fixed world point (what the agent gets for a bare world position). Alt-click in Track (or Manual) tracks the whole object, as before (`focusObjectId`): both are "follow something in the scene", one gesture with a modifier, and stored scenes with `focusObjectId` keep working (read as Track).
* **Lost target:** the last distance is held and depth of field is still drawn. A tracked point whose object is gone shows "Focus held" over the viewport (a status, not the red "Lens optics not fully drawn") and in the panel; auto focus seeing only sky shows on the reticle (amber) and in the panel only, since that happens every time the camera looks up.
* **Reticle:** a DOM element over the canvas (corner brackets for the AF area, a ring for a tracked point; green locked, amber held), never drawn into the WebGL frame, so `__scratchbox_capture_active_3d_scene`, exports and the agent's visual check never contain it. Browser-pane screenshots of the UI do show it. A panel checkbox hides it (a per-viewer preference in localStorage). It does not test occlusion: a tracked point behind a nearer column still shows its ring.

---

## 2. What Was Tested & What Worked (Verified)

* **Agent sets auto focus** — "Move the camera to [-1.5, 1.7, 26] looking at [2.5, 1.7, -20], then give it an 85 mm lens at f/1.4 with continuous auto focus (AF area 8 %, 0.4 s focus pull)": `configure_physical_camera` applied, the viewport's controller in mode `auto`, FOV 16.071°, passes `depth-of-field, output`, focus 37.04 m on the column under the centre.
* **Near column** — camera [-1, 1.7, 22] toward [12, 1.7, -30]: focus 10.86 m on the column under the AF brackets; it is sharp, the far columns soft (`live_01_...`).
* **Pan far to near (frame sequence)** — camera [0, 1.7, 22] toward [3, 1.7, -30], focused 26.69 m (`live_08_...`, `live_10_...`); a shift-drag truck of 60 px over 1.2 s. The AF target stepped one column at a time, 26.54 → 23.39 → 20.17 → 16.97 → 13.78 → 10.59 m (the 3.2 m bay pitch along the oblique line of sight), and the drawn focus glided behind it: 26.66, 25.86, 25.26, 24.81, 23.64, 22.84, 21.37, 20.21, 18.93, 17.48, 15.98, 14.36, 13.31, 12.59, 12.09, 11.72, 11.45, 11.25, 11.09, 10.98 m at 100 ms steps (`live_10_` → `live_11_` → `live_12_` → `live_13_...`: near column sharp, far rows soft at the end). Earlier pan: 10.86 → 8.59 → … → 12.78 m (`live_02_` to `live_05_`).
* **Sky** — a truck out of the colonnade left only sky under the AF area: focus held at 14.07 m, the brackets turned amber, no banner (`live_07_...`, after the notice change below). Moving fast through a near column at 26.7 m focus shows it heavily blurred (`live_09_...`).
* **Track a point** — Track, click a column face: `focusPoint` on `hero-1792449171206` at world [1.82, 1.90, 11.50], label "Camera: track focus point on hero-…" in the undo button (`live_14_...`). Orbiting with the camera at [-1, 2.2, 37] → [5.9, 1.05, 36.8] → [-7.7, 3.35, 35.3], the drawn focus distance equalled the point's view-axis depth each time (25.6585 / 25.6600 m) and the ring stayed on the point (`live_15_` to `live_17_`). With the orbit target far away, an orbit can swing the point out of frame; the focus still follows it (10.636 m = point depth) while the ring hides.
* **Agent and Track** — "Move the camera … Do not change the lens or the focus tracking": the agent's step kept `focusMode: 'track'` and the point.
* **Reload** — navigate to the token URL again: while the hero GLB loads the viewport says "Focus held: the tracked point's object 'hero-…' is not in the viewport; holding the last focus distance 25.66 m" (`live_18_...`); once loaded the point resolves to the hero file's object at exactly [1.82306, 1.90042, 11.49823], focus 25.6593 m, pose [-1, 2.2, 37] kept, no notice (`live_19_...`).
* **Panel modes** — Auto (AF area 8 %, pull 0.4 s, sliders, readout, reticle toggle; `live_20_...`), Manual (distance field takes the 25.659 m the viewport was focused at; reticle hidden; `live_21_...`). Undo twice: manual → auto → track, the same point back.
* **Console** — no errors.

Automated: `camera-focus-modes.test.ts` (operators and undo, refusals, world-to-local conversion, JSON round trip, AF pick, focus pull, depth unpacking, the real controller following a moving camera and object, lost target, notices, the agent tool in each mode) and `viewport-camera-focus.test.ts` (real Scene3DPrimitive in headless Chrome on a frame clock: the glide matches one exponential step per frame within 0.2 %, near → far column, 0 s pull snaps, sky holds, Track pick, orbit, moving and removed object, undo/redo, reticle toggle, remount, agent → panel). Screenshots: `test-results/screenshots/camera_focus/` (`live/` for this session).

---

## 3. What Broke / Didn't Work

* **"Lens optics not fully drawn" for a held focus (fixed in this session)** — the first build pushed the focus notices into the optics notice, so looking at the sky put a red "Lens optics not fully drawn" banner over the viewport though depth of field was drawn. Focus notices now go to their own "Focus held" status (lost tracked point) or to the reticle and panel only (auto focus on sky).
* **Track chip and Auto chip both lit while picking (fixed)** — while a Track pick was pending, the current mode's chip stayed lit too.
* **Orbit is a poor pan for auto-focus checks** — orbit turns about the stored target (25-50 m away here), so 8 px of drag moved the camera metres; shift-drag (truck) was used for the frame sequences.
* **A pose closer to its target than 1.15 scene radii is re-framed** (existing `calculateStandoffCamera` rule): close-up poses had to use a far look-at target on the same ray. Not changed here.
* **One mode change was overwritten once** — a Track pick reverted to Auto a few seconds later without an undo step, while the agent's previous turn ("keep the lens and its auto focus") was apparently still writing its artifact; not reproduced afterwards.

---

## 4. Candidate Tool/Service Ideas

* **Viewport pan/turn API for checks** — a `__scratchbox_view(position, target)` (or an operator that moves the live view without storing a pose) would make camera-motion checks reproducible without the chat agent or synthetic mouse events.
* **Focus status for the agent** — expose `ViewportFocusController.status` (mode, drawn distance, AF target, notice) to the agent's visual check, so it can say what the camera focused on.
* **Occlusion-aware reticle** — test the tracked point against the depth buffer and draw the ring dashed when it is hidden.

---

## 5. Reproduction Steps

1. Start the app from the worktree on free ports with the token URL.
2. "Build a 3D scene of a long colonnade: two straight rows of 12 square stone columns, 4 m apart, receding away from the camera along a flat paved floor with a regular grid of paving joints, and a straight entablature beam on top of each row."
3. "Move the camera to position [0, 1.7, 22] looking at [3, 1.7, -30], then give it an 85 mm lens at f/1.4 with continuous auto focus."
4. Shift-drag sideways a little: the AF target steps column by column, the focus glides (`window.__SB_3D_FOCUS__.status`).
5. Camera icon → Focus: Track → click a column → orbit: the column stays sharp, the ring stays on it.
6. Reload: Track and the point are kept.
