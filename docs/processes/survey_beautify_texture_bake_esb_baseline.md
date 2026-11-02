# Process: Survey AI Beautify texture bake (survey_beautify_to_texture) on the Empire State Building's pipeline K twin, baseline

> **Recorded:** 2026-10-29
> **Status:** Needs Fix (the bake runs end to end on the ESB after three fixes; its texture is worse than the K twin it replaces: 6 of 16 stations accepted, 40% of the seen texels painted, invented neighbours and shifted setbacks painted onto the tower, softer than K's photos)
> **Tags:** `operate-scratchbox` `survey` `ai-beautify` `texture-bake` `pipeline-k` `empire-state`
> **Target Domain:** Gemini Agent Chat / survey tools / staged-location twin textures

---

## 1. Session Context

* **What prompted this session:** the user asked whether the survey / AI Beautify tools could capture a building and texture it, chained so the style carries from station to station, with the Empire State Building as the baseline (moved from Haughwout, 2026-10-29). `survey_beautify_to_texture` already chains stations (each accepted image is warped into the next as a reference) and unprojects them into the mesh's own UVs; it had no recorded run on a real building. This is that baseline, run as the tool is, with the station plan the in-app agent chose.
* **Instance used:** web port `3510`, API port `3511`, tools port `3512` (own entry `scratchbox-survey-texture-esb`), from the worktree `.claude/worktrees/survey-texture-esb` at `fd41ca82` plus this change only. The main checkout held another session's uncommitted `scratchbox_bvh.hpp` change, under which the unprojector's ESB mock test fails station QC (it passes at HEAD and at HEAD + this change).
* **Scope tested:** `survey_synthesize_stations` then `survey_beautify_to_texture` from the chat, on the newest ESB pipeline K twin `empire_state_building_350_fifth_avenue_n_iso_l2_tex_7f5e8e84.glb` (122 MB, 1.4 M vertices, 363 primitives, 851 images; tile frame x east, y up, z south, origin on the ground at 40.748545, -73.985763).

---

## 2. What Was Tested & What Worked (Verified)

* **Fix 1, a mesh with some UV-less primitives is baked, not refused** (`SurveyTextureUnprojector.primitivesWithoutUvs`). The twin has two primitives without `TEXCOORD_0` (`base_skirt`, 24 vertices; `Seal` primitive 1, 153,480 vertices); before, `requireOwnUvs` refused the whole mesh. In the app: `untexturedPrimitives` lists exactly those two, both kept their own materials, 361 atlases baked. The texture embedding now places each atlas by its primitive index (it counted every glTF primitive, so skipping one would have shifted every later atlas).
* **Fix 2, atlas size follows each primitive's own texture** (`survey_beautify_to_texture`: `resolution` unset uses `resolutionScale`, new `textureScale`, default 1). Before, the tool always passed `resolution: 4096`, i.e. 361 x 4096² = 6,057 M texels per map on this twin. In the app: `totalAtlasTexels` 106,442,027 (the twin's own texture sizes). The total now counts width x height (it counted width², over-counting non-square atlases; caught by the new test).
* **Fix 3, an empty image answer fails one station, not the run.** The first in-app run died after 4 image calls on `Media model gemini-3.1-flash-image is unavailable: Image generation returned no image (STOP)`. A station is now asked twice (`EMPTY_IMAGE_ATTEMPTS`) and then left out and reported; any other model failure (quota, credentials) still ends the run. In the app: station 2 `no image after 2 attempts (... returned no image (STOP))`, the run went on.
* **The bake completes on the ESB:** 2,860 s in all (beautify 16 stations ~1,200 s at ~70 s each with rerolls; bake 363 primitives ~1,250 s; embedding ~420 s), output `desktop-app/public/models/survey_pbr_1793314119275.glb` in the worktree, 268 MB.
* **Station renders are correct:** a local clay render of stations 1, 8 and 14 shows the tower in frame (`docs/screenshots/esb_survey_bake_station1_clay.png`).
* **Tests:** `survey-texture-unprojection.test.ts` 21/21 with credentials unreachable (new: a mixed-UV mesh, the atlas sizes from the tool, an empty answer left out and a quota failure still thrown); the six other suites that touch the unprojector 60/60. `tsc -p packages/core`: only the existing `treeCrownShading.ts` `ShaderChunk` error.

---

## 3. What Broke / Didn't Work

* **The baked texture is worse than K's** (albedo renders of input and output from the same cameras, native path tracer):
  - North face close-up (`esb_survey_bake_north_close_k_vs_bake.jpg`, K left, bake right): K's sharp piers, window grid and tinted glass become soft, washed-out grey; a neighbouring building's facade, invented by the image model, is painted onto the tower's left side; a ghost of the setback outline lies across the piers.
  - South face close-up (`esb_survey_bake_south_close_k_vs_bake.jpg`): setback shapes painted at the wrong heights, blurred blocks, hard seams where painted texels meet K's unpainted ones.
  - Station 15 (`esb_survey_bake_station15_k_vs_bake.jpg`): the tower greyer and flatter, pier contrast lost, another building's roof painted on the base.
* **6 of 16 stations accepted** (15, 11, 16, 4, 5, 10 by texels painted). Nine failed the pose QC (`yaw moved 0.77-11.76 deg`, `pitch moved 1.70-15.31 deg`, position up to 2.32 m), one returned no image twice. Painted 9,417,305 of 23,419,021 texels the stations could see (40%); 14,001,716 unobserved, mostly the south and east faces.
* **The image model recomposes the shot.** Given the clay render of the isolated tower, Nano Banana drew a whole Manhattan scene: a street-level view with buildings on both sides, aerial city views (`esb_survey_bake_answer_street_recomposed.jpg`, `..._aerial_recomposed.jpg`). Most answers fail the pose check; those that pass keep the camera but move the content (invented neighbours, shifted setbacks), and the pose check cannot see that. `survey_beautify_to_texture` uses the plain clay prompt: none of building-survey mode's outline lock, tile-photo reference render or `checkStationOutline`.
* **Chained reference mostly empty.** The previous accepted station warped into the next pose (60 degrees apart) was nearly all white (disoccluded), so the chain passed little colour between stations at this spacing.
* **Stations too far for detail.** 360-500 m standoff, 24 mm lens: the tower fills about 15% of a frame, about 0.2 m a pixel at 2K against K's 0.077 m straightened photos. Tier 1 pitches up 28 degrees and cuts off the base.
* **`meshCoverageFraction: 0` on every enriched station** although the clay renders show the tower in frame: the enrichment metric is wrong for this mesh (not investigated).
* **The output is 268 MB** (input 122 MB): three PNG maps per primitive (albedo, normal, ORM) appended; larger than the viewport has loaded for the ESB before (107 MB+ crashed a tab on 2026-10-26). Not opened in the viewport.
* **Embedding is slow and silent.** After `Baking texture 363/363` the tool spent about 7 minutes in `embedPerSubmeshTexturesIntoGlb` with no progress report (each image appended re-copies the whole binary buffer, about a thousand copies of 120-270 MB). The chat's no-progress limit for this tool is 10 minutes.
* **Normals and roughness from image brightness.** The bake's PBR maps come from `AlgorithmicUvEngine.decomposePbr` (Scharr normals from luminance, curvature roughness). AGENTS.md section 2 allows photo-inferred relief only from a learned material model; under Beautify's even light the luminance is mostly colour, not relief.
* **Workspace guard.** The chat's survey tools accept only GLBs inside the server's workspace (`desktop-app/` here); the twin had to be copied into `desktop-app/public/models/`.

---

## 4. Candidate Tool/Service Ideas

* **Building-survey mode for the bake** — run `survey_beautify_to_texture` stations through `mode: 'building-survey'` (tile-photo reference render, `OUTLINE_LOCK_SENTENCE`, `checkStationOutline`) so invented neighbours and shifted setbacks are rejected; this session found them only by rendering the result.
* **Content QC after pose QC** — compare an accepted image's edges against the twin's own texture (the facade lattice from `sb.site_lattice` / `measureLattice`: pitch, piers, windows per bay) before painting; the pose check passed images whose content had moved.
* **One view per patch for generated plates** — winner-take-all per chart with blending only along seams, so two generated views are never averaged into ghosts.
* **Close, banded stations for tall buildings** — a planner that places stations per height band at a standoff giving K's pixel size or finer, looking level at each band; `orbital-multi-tier` here put the tower in 15% of each frame.
* **Streamed GLB embedding with progress** — collect images and write the binary once, reporting per image, so the step is seconds, not minutes, and never meets the no-progress limit.
* **A render-compare tool** — render input and output twins from the same cameras (albedo) side by side, with a sharpness and colour delta; this session hand-wrote it as a vitest probe.

---

## 5. Reproduction Steps

1. Worktree at the commit with this change; copy the ESB K twin into `desktop-app/public/models/`; launch entry on free ports (3510/3511/3512 here), `preview_start`.
2. In the chat: plan 16 `orbital-multi-tier` stations at 40.748545, -73.985763, elevation 15, radius 360, look-at [0, 200, 0], 24 mm, enriched against the twin, written to `public/models/esb_survey_stations_16.json`.
3. In the chat: `survey_beautify_to_texture` on the twin with those stations, `locationName` 'Empire State Building, New York', `resolution`, `textureScale` and `isoDate` unset (about 48 minutes).
4. Render input and output from the same stations with `SurveyStationRenderService.renderStation(..., { renderMode: 'albedo', glbPath })` and compare.
