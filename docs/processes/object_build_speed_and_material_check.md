# Process: Object build speed with materials, and a material check against the reference

> **Recorded:** 2026-10-21 (work started 2026-10-19 on branch `object-build-speed-check`; the first session was stopped by a usage limit and finished by a second)
> **Status:** Verified (16 headless builds on the final code, 4 prompts x clay/materials x 2 runs, every stage timed; the perfume bottle and the fire hydrant built live in the app with materials; 15 of 16 headless builds succeeded, one clay seed pod failed its triangle budget twice)
> **Tags:** `operate-scratchbox` `object-build` `pbr-materials` `latency` `material-check` `review-render`
> **Target Domain:** Gemini Agent tools (`build_3d_object_from_reference`) / Native Python engine / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** [object_build_materials.md](./object_build_materials.md) measured that a build with the colour reference and per-part materials took 557 s against 304 s for clay and left two things open: where the extra time goes, and that the shape comparison only ever sees a clay render, so a wrong material is never caught.
* **Instances used:** headless runs through `buildObjectFromReference` with the app's `GeminiClient` (model `gemini-4-argon` reading the spec, `gemini-3.1-flash-lite-image` drawing the reference); live runs on web port `3872`, API `3871`, tools `3873` from the `object-build-speed-check` worktree (the user's `scratchbox-dev` entry was not touched).
* **Scope:** the four prompts of the earlier session (a vintage red fire hydrant, a brushed-steel espresso machine, a glass perfume bottle with a gold cap, an alien seed pod), each built in clay and with materials, two runs each, on the code before this branch (2026-10-19) and on the final merged code (2026-10-21).

## 2. What changed

* **Every stage is timed** (`BuildStageClock` in `reference-object-builder.ts`): reference image, reference prep, each spec read and corrective re-ask (with prompt, output and thought tokens), engine readiness, native build, measurement, the clay render, the shape comparison, the material render and the material comparison, per pass. `result.timings` and `data.objectBuild.timings` carry them; the live tool result shows them in the scene data.
* **Child origins are normalized, not re-asked** (`normalizeChildOrigins`, `object-build-spec.ts`): 36 of 37 problems quoted in the clay builds' corrective re-asks, and 72 of 73 in the material builds', were a child sweep or revolve whose own coordinates did not start at its attach point. Such a child is translated there (each move recorded in `normalized`) instead of costing a complete second spec from the model.
* **Patch replies**: corrective re-asks and revisions answer with only the parts that change (`objectBuildSpecPatchJsonSchema`, `applySpecPatch`, merged by part id; a part listed in `removePartIds` and in `parts` is replaced). A reply that is not a spec at all still gets a complete re-ask. `deps.patchReplies: false` restores complete replies for measurement.
* **A material check against the reference** (`material-preview-render.ts`, `checkMaterials`): a software render of the build in its part materials (same `#808080` backdrop, neutral white studio light, three-quarter view) is compared with the reference by the vision model, in parallel with the shape comparison, while the contact analysis still runs. It lists per-part differences as continuous corrections (base colour, roughness, metalness, transmission, ior, clearcoat, emission). High-confidence corrections within range are applied to the spec the next revision is given (the revision prompt says they are already applied, keep them); when the kept build still has unapplied corrections and no revision is left, one material-only pass rebuilds it natively with them (no spec call, one more comparison), never more than one. `materialChecks` and `remainingMaterialDifferences` are in the result, and the build notes list each correction with its from and to values.
* **The material render's exposure is calibrated** (this session): measured against the hydrant and espresso references, every lit surface of the render read 1.3-1.8x its base colour and bare metal reflected a near-white room, so the check called nearly every part "too bright" (112 of 124 findings in the earlier runs were worded too bright, pale, white or blown out) and corrected it darker than the reference. The render now sets its exposure so a white matte surface facing the camera reads 0.9 linear (`WHITE_POINT`); a lit colour reads about its own base colour and only highlights go over 1 (`material_preview_*` screenshots; `a_vintage_red_fire_hydrant_ref_vs_preview.png` before and after).
* **The clay review render's near plane follows the camera distance** (`HeadlessMeshSilhouetteRenderer.nearPlaneFor`, this session): the near plane was a fixed 0.5 m, so a 0.072 m perfume bottle framed at 0.26 m was entirely behind it and every clay render of it was a blank frame. The shape comparison then reported "the render is empty, the meridian axes must be swapped" in all three passes of the first live build and the revisions chased a phantom; the chat's summary repeated it as "the clay software rasterizer reported blank silhouette frames". The near plane is now 0.5 m or 2 % of the camera distance, whichever is nearer (`renderMesh` and `renderShadedMesh`; `review_small_sphere.png`).

## 3. Measurements and what worked (Verified)

### 3.1 Where the time goes

Per build, mean over the 8 builds of an arm (4 prompts x 2 runs, failures included), seconds. "Calls" is the mean number of model calls of that stage per build; "s/call" its mean duration; "out tok" the mean output tokens of one call. Before = the code of 2026-10-19 with timing only; after = the final merged branch (2026-10-21), same prompts, same models.

| Stage | Clay before | Clay after | Materials before | Materials after |
| :--- | ---: | ---: | ---: | ---: |
| spec-read (first spec and revisions) | 202.2 s (2.75 calls, 73.5 s/call, 4639 out tok) | 179.2 s (2.75 calls, 65.2 s/call, 3925 out tok) | 312.7 s (2.75 calls, 113.7 s/call, 7241 out tok) | 252.4 s (3.00 calls, 84.1 s/call, 5408 out tok) |
| spec-correction (corrective re-asks) | 95.7 s (0.88 calls, 109 s/call) | 13.1 s (0.25 calls, 52 s/call) | 155.5 s (1.50 calls, 104 s/call) | 4.1 s (0.38 calls, 11 s/call) |
| shape-compare | 24.4 s (2.5 calls, 9.8 s/call) | 26.4 s (2.6 calls, 10.1 s/call) | 25.7 s (2.5 calls, 10.3 s/call) | 30.9 s (3.0 calls, 10.3 s/call) |
| material-compare (runs beside shape-compare) | - | - | - | 24.7 s of model time (3.1 calls, 7.9 s/call); 4.5 s of wall time added per build (0-2 s in 7 builds, 31.5 s for the one with a material-only pass) |
| reference-image | 3.6 s | 3.1 s | 3.8 s | 3.8 s |
| native-build | 1.6 s | 1.2 s | 1.5 s | 1.5 s |
| measure (contact analysis) | 1.0 s | 0.9 s | 1.2 s | 2.0 s |
| render + material-render | 0.1 s | 0.1 s | 0.1 s | 0.9 s |
| **wall time, mean** | **328 s** (ok only 319) | **223 s** (ok only 205) | **499 s** (ok only 525) | **298 s** |
| builds that succeeded | 7/8 | 7/8 | 7/8 | 8/8 |
| parts, mean | 16.1 | 16.1 | 22.7 | 23.2 |

Per prompt, after (run 1 / run 2), wall seconds: hydrant clay 176/209, materials 202/251; espresso machine clay 324/266, materials 400/416; perfume bottle clay 112/90, materials 127/144; alien seed pod clay failed (349)/259, materials 387/453.

**Causes of the extra time with materials, and what was done about each:**

1. **The model writes at a fixed rate (about 55 output tokens/s), so every spec call costs its reply length.** The first spec with materials is longer (the material block is 17-23 % of the JSON and the colour reference yields more parts: 23 vs 16 on average), so the first read takes 85-250 s against 35-210 s in clay. This is the cost of the materials themselves and remains. A trimmed prompt variant (shorter conventions, defaults left out) was tried by the first session and gave no reliable gain (hydrant 185 -> 168 s, espresso 184 -> 219 s), so it was not kept.
2. **Corrective re-asks** cost about 100 s each (a complete spec written again) and happened 1.5 times per materials build against 0.88 in clay, nearly all for child origins. Normalizing them took the re-asks to 0.38 per build (clay 0.25), and a patch reply makes the remaining ones 11-52 s instead of 104-109 s.
3. **Revisions returned the whole spec** (75-115 s each). With patch replies a revision takes 11-80 s (mean 65 s for clay, 84 s with materials, first read included). A measurement with patch replies off on the same code (`fullreplies`, first session, n = 8 each) gave 311 s clay and 517 s with materials against 228 s and 303 s with them on: patch replies are the main saving.
4. **Blank clay renders of small objects** (fixed this session) made the model revise geometry that was right; the live perfume bottle went from 181 s (3 passes, "render is blank" in each) to 106 s (2 passes, no differences left) once the near plane followed the camera.

### 3.2 Shape scores did not change

High-confidence shape differences the vision model listed (lower is better), mean over successful builds: pass 1 clay 5.3 before / 7.0 after, materials 5.0 / 6.4; remaining after revisions clay 4.1 / 5.1, materials 5.3 / 6.3. The four intermediate runs of the first session gave remaining materials scores of 5.3, 5.5, 5.2 and 6.3, and the espresso machine alone (10-13 remaining) moves the mean; at n = 7-8 per arm this is run-to-run noise, with no trend in either direction. The patch replies, the origin normalization and the material check did not make the shapes worse; they did not make them better either.

### 3.3 The material check

* **Before the exposure fix** (29 successful materials builds over the first session's four runs): 124 findings, 112 worded too bright / pale / white / blown out; 44 high-confidence corrections applied; 3 material-only passes. The darkened brass, red paint and glass were corrections of the renderer, not of the spec.
* **After it** (8 materials builds, final run): 11 findings, 6 high-confidence, all 6 applied, 1 material-only pass. The findings are now of the kind the check exists for: a gold cap "too matte compared to the mirror-like gold cap" (roughness 0.10 -> 0.03), a dip tube "too opaque and white, in the reference the straw is nearly invisible" (transmission 0.75 -> 0.94), and on the seed pod four glows with emissive strength 2.5-5 that render as white (-> 0.6-1.2, which the viewport also needs). Only one of the 6 brightness-worded findings was about a lit surface rather than a glow.
* **Cost:** 24.7 s of model time per build, of which 4.5 s reaches the wall clock because it runs beside the shape comparison; the material-only pass, when it happens, adds about 30 s (one native rebuild and one comparison, no spec call). Kept.
* **Live** (2026-10-21, app on port 3872): the perfume bottle (181 s, then 106 s after the near-plane fix; `live_perfume_bottle_pbr.jpg`, `live_perfume_bottle_pbr_after_near_plane_fix.jpg`) and the fire hydrant (196 s, 14 parts, 97,550 vertices, "zero material differences"; `live_fire_hydrant_pbr.jpg`) built with materials and opened in PBR mode; no console errors on either; each reply listed the parts' materials and the provenance note.

### 3.4 Tests

Through the credential-guarded runner (no billed calls; `secrets.json` removed first): `material-preview-render.test.ts` (new cases: the exposure, a small object's review render is not blank), `object-reference-tool.test.ts`, `object-spec-materials.test.ts`, `object-build-spec.test.ts`, `object-spec-interpreter.test.ts`, `python-engine-mesh-integrity.test.ts`. `npm run typecheck`, `npm run lint` (0 errors), `npm run lint:primitives`.

## 4. What did not work / left open

* **The first spec read is the floor.** 85-250 s with materials, 35-210 s in clay, at the model's output rate; only a shorter reply (fewer parts or a terser schema, both tried without a gain) or a faster model would move it.
* **The espresso machine** is the slow prompt in both arms (29-44 parts, 11-14 high-confidence differences at pass 1, 5-13 remaining): the revisions do not converge on it.
* **One clay seed pod failed twice on its triangle budget** (the spec built more than 450,000 triangles, then again after the correction); the limit message is right, the model did not respect it.
* **The viewport renders lighter than the reference too** (the hydrant's red reads salmon in `live_fire_hydrant_pbr.jpg` against the deep red of the reference it was read from); the material render is now calibrated to the reference, the viewport's studio lighting is not, so a material that matches the reference can still look lighter in the app.
* **The material render's framing** is the review renders' (the object fills about a third of the frame); the reference fills most of its frame. Closer framing would give the comparison more pixels per part.

## 5. Candidate Tool/Service Ideas

* **Expose the stage timings in the chat summary** (`data.objectBuild.timings` exists; the reply does not say where the time went), so a slow build explains itself.
* **A viewport exposure check**: render the build in the viewport's studio lighting headless and compare with the material render, to calibrate the two to each other.

## 6. Reproduction Steps

1. Headless timing: with `secrets.json` linked in the worktree, run a script that calls `buildObjectFromReference({ request, clay }, { chat: new GeminiClient(), outputDir })` for each prompt and arm and writes `res.timings`, `res.passes`, `res.materialChecks` (the first session's `measure.ts`; `patchReplies: false` for the complete-reply arm). Aggregate `timings` by stage.
2. Live: `.claude/launch.json` entry `scratchbox-object-build-speed-check` (`SCRATCHBOX_NO_ELECTRON=true PORT=3871 SCRATCHBOX_WEB_PORT=3872 SCRATCHBOX_TOOLS_PORT=3873 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3872 npm --prefix <worktree> run dev`), open the logged `?token=` URL, ask "Build a 3D model of a glass perfume bottle with a gold cap", then "Now, in a new scene, build a 3D model of a vintage red fire hydrant".
3. The material render of any saved spec: `buildObjectFromSpec(spec)`, `measureBuild(spec, glb)`, `renderMaterialPreview(materialPreviewMeshes(meshes, id => part.material), { azimuthDeg: 35, elevationDeg: 22 }, 512)`.
4. Screenshots: `test-results/screenshots/` (`material_preview_*.png`, `review_small_sphere.png`, gitignored) and the session's `shots/object_speed/`.
