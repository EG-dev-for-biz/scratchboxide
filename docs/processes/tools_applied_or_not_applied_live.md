# Process: configure tools apply to the open scene, or say NOT applied

> **Recorded:** 2026-10-19
> **Status:** Verified (physical camera and gaffer rig applied in the live viewport; lens distortion and WebXR calibrate labelled by tests)
> **Tags:** `operate-scratchbox` `lighting` `camera` `tool-honesty`
> **Target Domain:** Gemini Agent Chat / 3D scene

---

## 1. Session Context

* **What prompted this session:** four tools returned "Configured ..." / "Calibrated ..." while nothing in any scene changed: `lighting_configure_gaffer_rig`, `configure_physical_camera`, `optics_configure_lens_distortion`, `webxr_geospatial_calibrate`. The pattern of `atmosphere_configure_scene` (commits f2625f19, b04d2c83) was followed: apply through a direct-dispatch operator and return `applied: true` with the updated scene, or return `applied: false` and a summary starting "NOT applied: computed only".
* **Code:** `lighting-tools.ts` (`gafferRigToSceneRig`, handler), `advanced-realism-operators.ts` (`sb_set_explicit_lighting_rig`), `lightingRigs.ts` (`SceneLightingRig`, explicit rigs with an origin), `syncAtmosphere.ts` (draws `environment.lightingRig` when `cinematicRig` names it), `Scene3DPrimitive.tsx` (honours `camera.fov`), `spatial-tools.ts` (camera, lens, WebXR handlers).
* **Instance used:** web `3082`, API `3081`, tools `3083`, started from the worktree with `npm run dev`.

---

## 2. What Was Tested & What Worked (Verified)

* **Scene:** the "3D Scene" starter (procedural sci-fi outpost, 46,012 vertices), lit by the agent with `atmosphere_configure_scene` at golden hour (`live_01_before_scene_golden_hour_sun.jpg`).
* **Prompt:** an 85 mm lens on full frame at f/2.8 focused at 30 m (`configure_physical_camera`), then a Rembrandt rig, 4:1, 3200 K key (`lighting_configure_gaffer_rig`).
* **Camera:** the scene's `camera.fov` went from 50° to 16.071°, and the live viewport camera read back `fov: 16.071` (`window.__SB_3D_CAMERA__`). The reply listed depth of field (sharp 22.5 to 45.1 m), bokeh and the horizontal FOV as computed only, matching the tool result.
* **Rig:** the viewport built `rembrandt_Key_Light` (spot, warm `ffb87b`, shadows), `rembrandt_Fill_Light` (point, cool) and `rembrandt_Rim_Kicker` (spot), scaled with the content around the camera target; the golden-hour atmosphere was switched off (`enabled: false`) and the reply said so (`live_02_...jpg`).
* **Exposure fix (this session):** the first rig used the dim `three_point_studio` key as its exposure reference and the visual check called the scene underexposed. The key now lands at the default studio key's irradiance (2.25); re-applied, the key's intensity rose from 15.77 to 69.12 (rig units) with the 4:1 ratio kept (`live_03_...jpg`, `live_04_viewport_rembrandt_rig_fov16.png`).
* **Unit test:** `packages/core/test/tools-apply-or-say-not-applied.test.ts` (sphere shading under the built rig: `unit_gaffer_rembrandt_sphere.png`).

Screenshots: `test-results/screenshots/small_fixes/`.

---

## 3. What Broke / Didn't Work

* **Spot cones on large scenes:** the Rembrandt key and rim are spots with 0.58 and 0.55 rad cones. On an 84 m scene they light the centre and leave the outer rocks dark (the gaffer rig is a portrait rig; nothing widens it).
* **Reload re-frames generated content:** after a page reload, the generated GLB is auto-framed with `force: true` at the scene FOV, so the stored camera position is not used (existing behaviour, unchanged).
* **Gobo cookies and absolute lux** are not drawn; the result lists them under `notAppliedParts`.

---

## 4. Candidate Tool/Service Ideas

* ~~**A lens-distortion pass in the 3D viewport**~~ and ~~**a depth-of-field pass**~~: done, see `viewport_lens_distortion_dof_live.md` (`optics_configure_lens_distortion` and `configure_physical_camera` now apply them through `camera.lens`).

---

## 5. Reproduction Steps

1. Start the app from the worktree on free ports with the token URL.
2. Click "3D Scene" on a new chat and wait for the build.
3. Ask: "Set up a physical camera on this scene: a 85mm lens on a full-frame sensor at f/2.8, focused at 30 m (use configure_physical_camera). Then light it with a Rembrandt gaffer rig, 4:1 key-to-fill, 3200 K key (use lighting_configure_gaffer_rig). Tell me exactly what changed in the scene."
