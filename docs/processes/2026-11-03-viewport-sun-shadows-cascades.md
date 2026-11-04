# Process: the viewport's sun shadows, camera-fitted cascades, a contact-hardening filter, contact AO and lit twins

> **Recorded:** 2026-11-03
> **Status:** Verified (live, the ESB pipeline-K build opened from disk, before and after from the same cameras). Not covered: a district (no kd build was opened), studio scenes (no AO there), frame cost on a district.
> **Tags:** `operate-scratchbox` `viewport` `shadows` `cascaded-shadow-maps` `pcss` `gtao` `textured-twin`
> **Target Domain:** Generative Canvas / 3D Viewport (sky sun, shadows, post stack)

---

## 1. Session Context

* **What prompted this session:** section 3a of `docs/research/2026-11-03-district-run-over-run-plan.md`: the sun's shadows are blocky at street level and some photo surfaces take no shadow.
* **Instance used:** own entry `scratchbox-viewer-shadows`, web `4260`, API `4261`, tools `4262`, run from the `claude/viewer-shadows-2e1e9a` worktree. The saved chat `session-chat-1793173055785` (ESB, pipeline K, run `9dea22a0`) was copied into the worktree's `desktop-app/.scratchbox/sessions/`, and its 12 GLBs symlinked from the main checkout's `public/models/`. No staged build was run.
* **Scope tested:** the sky's sun shadows and the twin's materials, in the viewport, at the scene's own sun (36° up, due south). "Before" is the base commit `90e65beb` (the four changed files checked out over the branch, the page reloaded); "after" is the branch.

---

## 2. What Was Tested & What Worked (Verified)

* **The sun is a cascaded SunLight** — read from the page after loading: `AtmosphericSunLight.type` is `SunLight`, `renderer.shadowMap.type` is `BasicShadowMap` (0), four cascades of 2048 px. From the scene's stored camera (about 650 m out) the cascades start where the building does (view depth 470-812 m) and each box is cut to the building (half-size 215 m). From 20 m at the base they are 0.5, 0.9, 3.2 and 12.8 cm a texel (before: one 4096 px box of ±322 m, 15.7 cm a texel everywhere).
* **Shaders compile** — no console errors, 19-20 programs, none with failed diagnostics, with the patched shadow chunk, the facade glass and the staged reveal.
* **Lit twins** — unlit photo materials in the scene: 67 before, 0 after (the twin GLB has 72 KHR_materials_unlit materials of 278).
* **Before and after** (sheet: `docs/screenshots/2026-11-03-viewer-shadows/viewer-shadows-before-after.png`, gitignored; the 13 frames beside it):
  - **Street, 20 m from the base (S3):** before, the window shadows are smeared blocks with stair-steps and diagonal acne streaks across the lower wall. After, each sill and reveal casts a crisp shadow into its window, soft at the far edge, and the wall below is clean.
  - **Street, SE corner and south face (S1, S2):** after, the base is darker in its reveals and under its ledges (the window shadows and the occlusion); before, it is flatter and lighter.
  - **Air (A1, A1c, A2, A3):** at the pane's 800 px capture the two look much the same: the base roof in the tower's shadow and the setbacks shade alike. The gain is at street level; still frames show nothing about crawl while the camera moves (not checked).
* **Frame time** (20 forced frames, CPU-timed with a pixel read-back, 1416x841 canvas): S1 6.9 → 8.7 ms, A3 6.3 → 6.7 ms.

---

## 3. What Broke / Didn't Work

* **Found and fixed in this session:** the facade glass's ground-bounce clamp (`facadeMaterialLook.ts`) and the trees' leaf and card translucency (`treeTextureMaterials.ts`) read only `directionalLights[]`; with the sun drawn as a SunLight they lost it. Both read `sunLights[]` first now (commit `5dfd104b`).
* **Pre-existing, not from this change:** three pale strips at the foot of the ESB's base in S3 are K's `BaseSkirt` (untextured, `#c4c0bc`). They are there before and after, with the sun's shadow on or off.
* **Not covered:** studio scenes get no GTAO (it runs inside the aerial perspective pass, which only the sky has); `CineRealSkinRenderer.ts` and `headless-realism-service.ts` still read `directionalLights[]` only (stage and headless lights, not the sky's sun).
* **Noticed:** the aerial perspective target is sized in CSS pixels (`attachViewportResize` passes `clientWidth/Height`), so under the sky the scene is drawn at 1x and stretched on a 2x display.

---

## 4. Candidate Tool/Service Ideas

* **Open a saved chat by id in an instance** — a URL parameter or API call that opens `<session id>` in a fresh instance's viewport. This session copied the JSON into the worktree's sessions folder, symlinked the GLBs and set localStorage by hand; clicking the first matching sidebar entry sent a starter prompt instead (a new build, refused only because the backend was not up yet).
* **Viewport capture at canvas resolution** — the Browser pane's screenshots are 800x500 whatever the viewport size, so detail comparisons needed closer cameras. A `__SB_CAPTURE__(path)` that writes the canvas to `docs/screenshots/` would give full-resolution before/after frames.
* **Before/after toggle for a code change** — this session checked the base commit's files out and reloaded twice; a launch flag that pins a second instance to the base commit would make paired frames one step.

---

## 5. Reproduction Steps

1. In the worktree: copy `desktop-app/.scratchbox/sessions/session-chat-1793173055785.json` from the main checkout, and symlink the `/models/empire_state_building_350_*` GLBs it names into `public/models/`.
2. Add the `scratchbox-viewer-shadows` entry (ports 4260/4261/4262) and start it; open `http://127.0.0.1:4260/?token=<launch token>`.
3. Set `localStorage['scratchbox_studio_current_session_id_v18']` to the session id, reload, click "Open 3D", collapse the overlay, chat and sidebar.
4. Place the camera: `__SB_SET_CAMERA_VIEW__(target, { theta: atan2(dx, dz), phi: acos(dy / d), distance: d })` for S3 `(92, 2.5, 38) → (74, 1, 27)`, S1 `(115, 1.7, 115) → (30, 40, 60)`, S2 `(75, 1.7, 112) → (35, 22, 72)`, A1 the stored camera, A1c `(200, 280, 200) → (10, 160, 10)`, A2 `(230, 330, -170) → (10, 120, 0)`, A3 `(140, 110, -90) → (0, 25, -20)`.
5. For "before", check `90e65beb`'s `Scene3DPrimitive.tsx`, `syncAtmosphere.ts`, `AerialPerspectiveEffect.ts` and `AtmosphericSkyDome.ts` out over the branch, reload, repeat 3-4, then check the branch's files back out.
