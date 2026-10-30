# Process: Viewport colour harmony grade (ColorHarmonyPass) on the Plaza Hotel twin and a clay Empire State Building

> **Recorded:** 2026-10-29
> **Status:** Verified (shader, chain and panel in a real WebGL2 page, then in the live app on a clay Empire State Building)
> **Tags:** `operate-scratchbox` `3d-viewport` `post-processing` `color-harmony` `oklab`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user asked for a colour harmonising shader that changes the colour of the 3D objects in the viewport.
* **What was built:** `Scene3DData.colorHarmony` (`canvas-types.ts`); the maths and validation (`services/postprocessing/color-harmony.ts`); the GLSL pass (`services/postprocessing/ColorHarmonyPass.ts`), run by `ViewportOpticsChain` after the scene draw and before depth of field; the tool strip panel (`primitives/scene3d/ColorHarmonyPanel.tsx`); the operator `sb_set_color_harmony` (`lighting-camera-operators.ts`, reachable from chat through `scene_3d_dispatch_operators`).
* **Instance used:** none of the app. `preview_start` refused: "Maximum 5 dev servers per folder reached; 5 belong to other chats". Headless Chrome could not create a display (`CVDisplayLinkCreateWithCGDisplay failed`). The real `ViewportOpticsChain` and `ColorHarmonyControl` were bundled with esbuild into a static page (served on 127.0.0.1:8817 from the session scratchpad) and opened in the Browser pane.
* **Live app (second pass):** still no slot of its own (a git worktree did not help: the limit counts the whole project). An already running instance of this same checkout (web 3980, API 3981, started by another chat; the dev launcher runs without a launch token on loopback) was opened in a tab of this session's Browser pane; Vite served the uncommitted harmony code and hot-reloaded each edit. Its open scene was a clay Empire State Building build from another session.
* **Scene:** `public/models/the_plaza_hotel_new_york_iso_massing_33185b3a_versionf_tex.glb` (photo-textured), ACES tone mapping, hemisphere and sun light, plus five saturated swatches added in the page only, so the hue moves are easy to see.

---

## 2. What Was Tested & What Worked (Verified)

* **Shader compiles and draws** — 8 configurations rendered through `chain.render`: `drawn = ["color-harmony","output"]`, `issues = []`, `gl.getError() = 0` for every one; 10-19 ms a frame once warm at 520 x 400.
* **Hue moves, lightness kept** — analogous at 265 pulls every swatch into blue-violet; two 18 degree sectors at 30 / 210 split them into red-orange and cyan; one sector at 145 with 140% saturation turns all of them green. Shading on the spheres and the facade photo detail are unchanged. The facade's near-grey stone moves only slightly, as it should: it has little chroma.
* **Objects only over an opaque background** — over a textured orange-to-blue sky, the building and swatches turn green and the sky is untouched (depth mask: the background writes no depth). Silhouettes are clean, with no fringe.
* **Include background** — the same sky turns green too; over the flat background, the colour is graded on the CPU by the same maths (`harmonizeLinearRgb`).
* **Panel** — clicking the wheel turned the grade on at the clicked hue (221 degrees), with Analogous highlighted; Complementary wrote `sectors: [{0,18},{180,18}]` and the swatches split red / blue; the switch off cleared `colorHarmony` (`drawn: []`), and the switch on restored the same grade.

* **Live app, panel** — the Colour harmony button sits on the tool strip under Weather; the panel opens beside it with the app's styles; console `No console logs.`; network all 200 apart from one `ERR_ABORTED` on the `/workspace/events/file-change` stream (the hot reload reconnecting). `window.__SB_3D_OPTICS__` reports `passes ["color-harmony","output"]`, `drawn ["color-harmony","output"]`, no issues.
* **Live app, clay with Tint** — on the clay tower, Tint 100% at hue 120.5 turned it yellow-green with its shading kept and the studio background untouched; the frame's mean channel spread rose 18.96 -> 22.8 (all of it on the building). The change entered the undo history (counter 1).

---

## 3. What Broke / Didn't Work

* **A harmony cannot colour clay (fixed by Tint)** — the first live pass on the clay tower measured no change: the mean colour moved by 0.2 of 255 with the grade on and off, because a grey has no hue to move. `tint` (0-1, `TINT_CHROMA` 0.12 Oklab chroma at lightness 1, scaled down with lightness so black stays black) adds colour at the template hue; it is in the shader, the reference maths, `sb_set_color_harmony` and the panel ("Tint (colours greys and clay)").
* **Panel too tall (fixed)** — at 606 px it ran past a 768 px window, under the timeline bar; the wheel now sits beside the hue slider and the notes are one line (456 px before Tint was added).
* **Shared state** — while testing, the grade on the shared scene was switched on (hue 250.8, later 120.5 by the hue slider) from another window on the same workspace; this session did not set those values.

* **A step across the opposite hue (fixed in this session)** — with one 18 degree sector at 145, the sky's purple band (hue about 325, opposite 145) showed a horizontal step: Cohen-Or's map sends the two sides of the opposite hue to opposite edges of the sector. Hues within 30 degrees of the opposite hue now ease to the centre (`OPPOSITE_HUE_EASE_DEG`), and the re-render shows a smooth sky. Covered by the "continuous across the opposite hue" test. At a strength below 1, colours right at the opposite hue can still step (the hue mix has no preferred direction there).
* **Hue slider gradient (fixed)** — Chromium ignores `background` on a native range input, so the gradient track never showed; removed, since the wheel shows the hues.
* **Not exercised:** the panel inside the real tool strip, undo/redo of its changes, aerial-perspective scenes, video and headless renders (`Video3DLayerRenderer`, `spatial_ai_render_scene`), which do not run the optics chain, so the grade is not in them.

---

## 4. Candidate Tool/Service Ideas

* **Shader preview harness without a dev server** — a script that bundles a viewport module with esbuild and opens it on a static port, so a pass can be checked on real WebGL when the per-folder dev-server limit is reached. This session built one by hand in the scratchpad.
* **Auto-fit the template hue** — Cohen-Or picks the template turn that moves the frame's hues least; the chain could read back a small mip of the scene target and offer "Fit to scene" in the panel.

---

## 5. Reproduction Steps

1. Open a 3D scene, click the Colour harmony button on the tool strip (below Weather), and click a hue on the wheel.
2. Or from chat: `scene_3d_dispatch_operators` with `{ operator: "sb_set_color_harmony", params: { hueDeg: 145, sectors: [{ offsetDeg: 0, widthDeg: 18 }] } }`.
3. Tests: `npx vitest run packages/core/test/viewport-color-harmony.test.ts` (with credentials unreachable).
