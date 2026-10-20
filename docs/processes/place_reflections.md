# Process: Reflections made from the place for objects at real places

> **Recorded:** 2026-10-19
> **Status:** Verified (chrome fire hydrant built live at the Haughwout Building, 488 Broadway, and rebuilt from its spec at Washington Square Arch; near black before, reflecting the street and buildings after; studio scene pixel-identical; clay at a place pixel-identical in the real-viewport test; cost measured at both places). Live clay toggle at a place not exercised (see section 4).
> **Tags:** `operate-scratchbox` `place-reflections` `reflection-probe` `pbr-materials` `viewport-cost`
> **Target Domain:** Generative Canvas / 3D Viewport (`Scene3DPrimitive`, `scene3d/placeReflections.ts`, `scene3d/reflectionProbe.ts`)

---

## 1. Session Context

* **What prompted this session:** object builds now carry PBR materials, and studio scenes get neutral studio reflections ([object_build_materials.md](./object_build_materials.md)). Those studio reflections are deliberately off at real places (3D tiles or geo coordinates), so a metal or glass object staged at a place reflected nothing and rendered near black. The facade glass probe ([facade_materials_merge_eval.md](./facade_materials_merge_eval.md)) saw only the backdrop when its layer stood alone.
* **Instance used:** web `3782`, API `3781`, tools `3783`, started from the `place-reflections` worktree with `SCRATCHBOX_NO_ELECTRON=true` (no `.claude/launch.json` touched), opened with `?sbViewportCost=1`. Canvas frames were written at full drawing-buffer resolution (808 x 943) through a local receiver.
* **Scope tested:** a polished chrome fire hydrant built by `build_3d_object_from_reference` at the Haughwout Building and rebuilt from the same spec (`specJson`) at Washington Square Arch and in a studio void.

## 2. What changed

* **Place probe** (`scene3d/placeReflections.ts`, `PlaceReflections`): at a real place (outside clay mode), each object standing there gets its own probe:
  * one cube render of the scene (256 px faces, half float) from the object's bounding-box centre, with the object itself and the viewport overlays (gizmo, selection box, brush cursor, grid) hidden;
  * prefiltered (PMREM) and set as `envMap` of that object's own materials only, at `envMapIntensity` 1 (the probe holds the scene's own radiance). Tiles, staged buildings, trees and the background keep exactly the light they had;
  * receivers: loaded models that are neither environment layers nor staged-build layers (nor their textured twins), and the generated root. Clay materials and the facade reading's materials are skipped; materials swapped by the render-mode looks get the probe at draw time and are restored when it goes.
* **When it is re-rendered:** when an object loads, moves or is removed, when GPU-resident geometry or textures change (tiles streaming, layers loading), when the atmosphere or render mode changes, or when the camera moves a quarter of its distance to the probe (levels of detail). The change must hold still 350 ms, captures are at most once a second, and a change that never settles is taken after 4 s. Never every frame.
* **Fallback sky** (`scene3d/reflectionProbe.ts`): directions where nothing was drawn see a small linear gradient (blue zenith, pale horizon, dark ground) scaled to the scene's own lights. It is the scene background only inside the capture and restored before it returns, labelled `place-reflection-fallback-sky` (texture name and `userData.sbProvenance`). No sky, cloud or fog is ever added to the scene (AGENTS.md "Zero Uninvited Defaults"). An atmosphere sky, when the user turned one on, is geometry and is reflected as it is.
* **One capture for both probes:** the facade material reading's glass probe (`updateFacadeReflections`) now uses the same `ReflectionProbeRenderer`, so it also gets the fallback sky instead of the grey backdrop when its layer is alone, and it is re-rendered with the place probes when the scene changes. During any capture the shadow maps are reused, not re-rendered. A probe's render target is now freed with its model (`disposeObject3DDeep`), not only its texture.
* **Gate** (`classifyAtmosphere().placeReflections`): `!clay && (has3DTiles || hasGeoCoordinates)`. The studio room (`studioReflections`) is unchanged and still off at places. Opt out for comparisons: `?sbPlaceReflections=0` or `localStorage['sb.placeReflections'] = '0'`. Debug hook: `window.__SB_PLACE_REFLECTIONS__` (`stats()`, `refresh()`).
* **Bug fixed on the way:** a staged place's scene data carries `clayPreset`, and the viewport applied it to the whole scene with `TileClayProcessor.applyClayMaterial`, which replaces materials for good. The chrome hydrant built at Haughwout arrived as one grey clay material (`isClayMaterial`, metalness 0), and the in-app visual check said the requested chrome was missing. The preset pass now skips loaded models that are not environment layers; the clay render mode still clays them (reversibly).

## 3. Measurements and what worked (Verified)

### Live: chrome hydrant at real places, street level

* **Haughwout Building** ("Build a 3D model of a polished chrome fire hydrant standing on the Broadway sidewalk in front of the Haughwout Building"; 22 parts, 115,800 vertices, 20 materials, metalness 1, roughness 0.20-0.22; staged on remeshed clay tiles and the facade grammar layer, trees off). Before (opt-out) the metal is black with only the key-light highlights; after, the bonnet and barrel show the street, the horizon and the facades behind (`haughwout_street_a_before_after.png`, `haughwout_street_b_before_after.png`).
* **Washington Square Arch** (same spec rebuilt in 1 s, on the plaza south of the arch, trees off): the bonnet reflects the arch and the square (`washsq_street_a_before_after.png`, `washsq_street_b_before_after.png`, `washsq_street_wide_before_after.png`).
* **Studio scene unchanged:** the same hydrant rebuilt in a studio void, same camera, default vs opt-out: 0 of 761,944 pixels differ (`studio_default.png`, `studio_optout.png`); the probe stays inactive and the studio room still lights it.
* Console: no errors.

### Cost (M1 Ultra, drawing buffer 808 x 943, `EXT_disjoint_timer_query_webgl2`, 30 frames after 20 warm-up)

Frame GPU time, mean / p50 / p95 ms, probe on vs off (opt-out reload, same views):

| Place | View | On | Off |
| :--- | :--- | :--- | :--- |
| Haughwout (1.51 M tri, 21 calls) | street, 1.25 m from the hydrant | 1.39 / 1.52 / 1.63 | 1.32 / 1.32 / 1.97 |
| Haughwout | street, 8 m | 1.27 / 1.39 / 1.46 | 1.25 / 1.25 / 1.77 |
| Haughwout | elevated, 60 m | 0.99 / 1.16 / 1.23 | 1.10 / 1.12 / 1.50 |
| Washington Square (1.42 M tri, 21 calls) | street, 1.3 m | 1.70 / 1.84 / 1.89 | 1.50 / 1.54 / 1.63 |
| Washington Square | street, 8 m | 1.50 / 1.64 / 1.74 | 1.44 / 1.53 / 1.58 |
| Washington Square | elevated, 60 m | 1.21 / 1.21 / 1.70 | 1.28 / 1.31 / 1.38 |

* **Per frame:** within run-to-run noise except when the hydrant fills the frame (about +0.2 ms at Washington Square, 1.3 m).
* **Per capture:** 12.6-19.7 ms GPU (6 faces of the whole place, about 6 x 1.4-1.5 M triangles, plus the PMREM), the first one after load 18.7-24 ms; wall 10-24 ms. One such frame at most once a second, and only after a change has settled: while the camera orbits, nothing is captured.
* **Memory:** 15.7 MB GPU for one object (cube target 3.1 MB, PMREM 6.3 MB, the generator's working target 6.3 MB); each further object adds 6.3 MB. Geometry at these places is 101-103 MB.
* These places were staged with trees off (see section 4), so they are lighter than the Washington Square district of [viewport_cheap_steps.md](./viewport_cheap_steps.md) (1,062 calls with 591 trees). With trees on, a capture costs about 6 times that scene's main pass.

### Tests (all through the credential-guarded runner, no billed calls)

* `place-reflections.test.ts` (new, 6 tests; real viewport in headless Chrome): a polished chrome sphere at a geo-anchored place between a red wall and a green building. Without the probe its mean luminance is under 45 and it shows no green; with it, it is at least 1.8x brighter, the green building appears on the side facing it (over 90 % of the green pixels on that half) and the upper band reflects the blue fallback sky; every pixel outside the sphere is identical (the place keeps its light); the background stays the scene colour. Re-rendered once when the object moves, after it settles, and not during 150 still frames. Clay at a place and a studio scene are pixel-identical with and without the probe; the clay toggle takes the probe off and back on. The clay preset clays the place and leaves the object's chrome (fails without the fix). Also: the gate, the fallback sky's label, shape and scale. Screenshots: `place_reflections_1_chrome_without_probe.png`, `place_reflections_2_chrome_with_probe.png`, `place_reflections_3_clay_place.png`, `place_reflections_3_pbr_studio.png`.
* Also passing: `studio-reflections`, the atmosphere suites (`atmosphere-applies-to-scene`, `atmosphere-image-estimation`, `atmosphere-scattering-pipeline`, `atmosphere-service-apis`, `headless-scene-atmosphere`, `location-lighting-atmosphere`, `scratchbox-atmosphere-pipeline`, `universal-nature-and-atmosphere`), `facade-materials`, every `staged-texture-viewport*` suite, `staged-layer-eviction`, `object-reference-tool`: 19 files, 169 tests. `staged-texture-viewport-dither` failed once in a parallel run and passed alone and in the full re-run (load-dependent; it passed on the base commit too).
* `npm run typecheck`, `npm run lint` (0 errors) and `npm run lint:primitives` pass.

## 4. What did not work / left open

* **Staging with trees failed at Haughwout:** the first build stopped at the placement check because the cached vegetation layer `stg-257114f6-l5` reported a top at 883,679 m over the whole block ("no clear spot within 40 m"). Re-staging with `trees: false` worked. The vegetation layer's bounds need a look; not changed here.
* **Live clay toggle at a place not exercised:** asked to switch to clay, `staged_location_material_mode` replied `renderMode: "clay"`, but the scene stayed `pbr` after a reload (only the staged material mode seems to change). Clay at a place is covered by the real-viewport test (probe off, pixel-identical, toggle off and on).
* **Grey surroundings:** these places are staged in clay, so the chrome reflects clay buildings and the fallback sky. With textured twins or live photoreal tiles the probe reflects their colours (it renders whatever is drawn), but that was not shown live here.
* **Capture cost scales with the place:** a capture renders everything six times. With trees on or in a dense district it will be several times the frame. A coarser capture (no trees beyond some distance, or a lower level of detail for the probe) would bound it.

## 5. Candidate Tool/Service Ideas

* **Save-a-viewport-frame endpoint** (again): this session needed a hand-rolled local receiver to get full-resolution canvas frames out of the page; a route that writes the canvas to `test-results/` would make before/after records routine.
* **Render-mode tool for staged scenes:** a tool that sets `renderMode` (not only the staged material mode) on the active scene, so clay vs materials can be switched by the agent at a place.

## 6. Reproduction Steps

1. In the worktree: `env SCRATCHBOX_NO_ELECTRON=true PORT=3781 SCRATCHBOX_WEB_PORT=3782 SCRATCHBOX_TOOLS_PORT=3783 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3782 SCRATCHBOX_PYTHON=<repo>/.venv/bin/python npm run dev`, open the logged `?token=` URL with `&sbViewportCost=1`.
2. Ask for a metal object at a real place (with `trees: false` at Haughwout until the vegetation bounds are fixed). `window.__SB_PLACE_REFLECTIONS__.stats()` shows one probe.
3. Before/after: `localStorage['sb.placeReflections'] = '0'`, reload, same `__SB_SET_CAMERA_VIEW__`.
4. Cost: `__SB_VIEWPORT_COST__.measure({ frames: 30, warmup: 20 })` per view, probe on and off; capture time with a timer query around `__SB_PLACE_REFLECTIONS__.refresh()`.
5. Screenshots: `test-results/screenshots/place_reflections/` (gitignored).
