# Process: A clay view asked from chat at a staged place, kept over a reload

> **Recorded:** 2026-10-19
> **Status:** Verified (chrome hydrant built live at the staged Flatiron Building: "show it in clay" clayed all 19 hydrant meshes and the place, and the scene reopened clay after a full page reload; "Show real textures" brought the chrome back; real-viewport and unit tests fail without the fix)
> **Tags:** `operate-scratchbox` `staged-build` `render-mode` `clay` `staged-location-material-mode`
> **Target Domain:** Gemini Agent tools / 3D Viewport (`staged-material-mode-tool.ts`, `material-pbr-operators.ts`, `stagedBuild/texturedTwins.ts`, `useStagedBuild.ts`, `Scene3DPrimitive.tsx`)

---

## 1. Session Context

* **What prompted this session:** [place_reflections.md](./place_reflections.md) §4 reported that at a real place, asking for clay called `staged_location_material_mode`, the reply said `renderMode: "clay"`, and after a reload the scene was still `pbr`.
* **Instance used:** web `3032`, API `3013`, tools `3014` (`.claude/launch.json` `scratchbox-dev`), restarted once so the backend (ts-node, no watch) ran the fixed tool.
* **Scope tested:** a place staged on its own (Flatiron Building), then a polished chrome fire hydrant built at that place by `build_3d_object_from_reference`.

## 2. Cause

* The tool's persistence was never broken. With the place on its own, "show it in clay" saved `stagedBuild.materialMode: "clay"` in localStorage and on disk, and after a reload the overlay read "Clay. Real textures ready for 1 layer." (checked live before any change).
* The failing case is a place with an **object built there**. `build_3d_object_from_reference` stages the object with `renderMode: 'pbr'` (`object-reference-tools.ts`). Staged layers follow `stagedBuild.materialMode`, but everything else in the scene (the object, trees, the generated root) follows `renderMode`. `applyStagedMaterialMode` wrote only `materialMode`, so the object kept its chrome, nothing ever saved a clay render mode, and the model's reply invented `renderMode: "clay"`. The overlay's "Show clay" had the same gap.

## 3. What changed

* `withStagedMaterialMode` (`texturedTwins.ts`, pure): a clay/textured choice writes `stagedBuild.materialMode` **and** `renderMode`. Clay sets `renderMode: 'clay'` and keeps the mode it replaced in `stagedBuildView.renderModeBeforeClay`. Textured puts that mode back, so the object gets its `pbr` again, while a place staged on its own (base `renderMode: 'clay'`, textured layers) keeps `clay`. Remembering the mode is deliberate: always mapping textured to `pbr` changed how a lone place's layers draw and broke `staged-texture-viewport-render` and `-late-twin`.
* `sb_set_staged_material_mode` (behind the tool) and the overlay toggle both use it, so a choice made either way is saved the same way.
* `Scene3DPrimitive` now draws a render mode changed in its own scene data (the overlay path). The tool path already applied it through the props sync.
* The tool's summary now states the scene render mode (`Scene render mode: clay.`), so the model reports what was saved. Its declaration says clay covers objects at the place and lasts across reloads.

## 4. Verified

### Live (Flatiron Building, chrome hydrant `hero-1792475438721`, 19 meshes, 24 parts)

| Step | Saved `renderMode` / `materialMode` | Hydrant meshes clay |
| :--- | :--- | :--- |
| Before (old backend, after a reload) | `pbr` / `clay` (the reported state) | 0 / 19 |
| "show it in clay" (tool, fixed backend) | `clay` / `clay`, `renderModeBeforeClay: "pbr"` | 19 / 19 |
| Full page reload | `clay` / `clay` | 19 / 19 |
| "Show real textures on the scene" (tool) | `pbr` / `textured` | 0 / 19 |

* Reply after the fix: "...now displayed in studio grey clay (renderMode: "clay", materialMode: "clay")", which matches the saved scene.
* Console: no errors after the reload. Screenshot: `test-results/screenshots/staged_material_mode/live_hydrant_clay_after_reload.jpg` (gitignored).

### Tests (credential-guarded runner, no billed calls)

* `staged-material-mode-viewport.test.ts` (new, headless Chrome, real viewport): a chrome sphere at a staged place (`renderMode: 'pbr'`). (1) The real tool run on the mounted scene clays the sphere, the saved scene remounted (a reload) is still clay, and textured restores the chrome. (2) The overlay's "Show clay" writes `renderMode`/`materialMode` `clay`/`clay`, and the remount is still clay. Both fail without the fix (`['pbr', 'clay']`). Screenshots: `test-results/screenshots/staged_material_mode/1_…5_*.png`.
* `staged-texture-viewport.test.ts`: operator and tool now assert the render mode. New tests cover an object at a place (the tool and the overlay helper write the same fields) and the remember/restore rule.
* Also passing: every `staged-texture-viewport*` suite, `staged-material-edit`, `place-reflections`, `first-pass-baseline`, `staged-summary`, `object-reference-tool`, `staged-layer-eviction` (13 files, 125 tests). `npm run typecheck`, `npm run lint` (0 errors), `npm run lint:primitives` pass.

## 5. Left open

* A later commit of a **running** staged build always carries `renderMode: 'clay'` (`composeStagedArtifact`). The viewport's props sync applies it, and `carryMaterialMode` carries only `materialMode`. A textured choice made mid-run on an object scene can therefore be reset to clay by the next commit. It was not seen live (object builds at a place commit once).
* A follow-up object build at a place in clay picks its own render mode (`object-reference-tools.ts`: `clay ? 'clay' : 'pbr'`), so a clay view chosen before "add a bench" is not kept for the new build.

## 6. Candidate Tool/Service Ideas

* **`scene_render_state` readout:** a tool or HTTP route that returns the open scene's `renderMode`, `stagedBuild.materialMode` and per-object clay state. This session read them from localStorage and `__SB_3D_EXTERNAL_OBJECTS__` through `javascript_tool`.
* **Backend reload in dev:** `server:dev` runs ts-node without watch, so tool edits need a full restart (which interrupts a running build). A watch mode for `packages/core/src/node` would avoid stale backends during live checks.

## 7. Reproduction Steps

1. `preview_start scratchbox-dev` (ports above), open the logged `?token=` URL.
2. "the Flatiron Building", then "Build a 3D model of a polished chrome fire hydrant standing on the sidewalk in front of the Flatiron Building".
3. "show it in clay"; reload; the hydrant and the place stay clay (saved `renderMode: "clay"`).
4. "Show real textures on the scene": the chrome is back (`renderMode: "pbr"`).
