# Process: Textured by default, clay on request (policy, staged locations, live app)

> **Recorded:** 2026-10-19
> **Status:** Verified (location crossfade, saved clay choice, script scenes, clay request); object builds still clay (owned by the `object-materials` branch)
> **Tags:** `operate-scratchbox` `render-mode` `staged-build` `textured-twins` `clay` `policy`
> **Target Domain:** Gemini Agent Chat / Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user (2026-10-19) approved changing the 3D default from "clay first" to "textured by default, clay on request". This branch (`textured-default`) owns the policy and the locations part.
* **Instance used:** worktree `.claude/worktrees/textured-default`, started with `npm run dev` from the worktree: web port `3631`, API port `3611`, tools port `3612` (`SCRATCHBOX_ALLOWED_ORIGINS` set to the web origin). Credentials through a temporary `secrets.json` symlink, removed afterwards.
* **Scope tested:** a real place ("the Flatiron Building"), the overlay's "Show clay" and a reload, a multi-object script scene, "show it in clay" as a follow-up and a reload, a first request that asks for clay, an object request.

## 2. What changed

| Where | Before | Now |
|---|---|---|
| `scene3d-first-pass-baseline.ts` (was `scene3d-clay-baseline.ts`) | `applyClayFirstPassBaseline` forced `renderMode: 'clay'` and deleted `pbrMaterials` / `multiLayerWeathering` / `proceduralTextures` / `pbrTextures` | `applyFirstPassBaseline` keeps material features; `firstPassRenderMode`: clay when the prompt asks for it (`clay`, `untextured`, `no textures`, `greybox`, `whitebox`, `massing model/only/study`), else the model's mode, else `'pbr'`. Atmosphere opt-in gate unchanged. `keepOpenSceneRenderMode` unchanged (an explicit clay choice carries over follow-ups). |
| `scene-atmosphere-opt-in.ts` | `sceneRendersClay` treated a missing mode as clay | `DEFAULT_SCENE_RENDER_MODE = 'pbr'`; a missing mode is textured |
| `Scene3DPrimitive.tsx` | `useState(data?.renderMode \|\| 'clay')` | `\|\| DEFAULT_SCENE_RENDER_MODE`; the external-data merge carries a clay/textured choice over a later commit of the same run (`carryMaterialMode`) |
| `execute_3d_python_script`, `scene_3d_dispatch_operators` with no scene | always `'clay'` | `firstPassRenderMode(prompt)`; the script tool also takes `renderMode: 'clay'` |
| `prompt-builder.ts` | "New objects and places start in studio grey clay … then textures and materials" | textured by default, clay only when asked; follow-ups are staging, then views and material refinement (a clay view, PBR tuning, 2DGS, 3DGS, micro-texture) |
| Staged builds (`texturedTwins.ts`, `useStagedBuild.ts`) | wanted mode `userMode ?? sceneMode ?? 'clay'`; the toggle was local state only | `DEFAULT_MATERIAL_MODE = 'textured'`: clay layers reveal first, each layer crossfades to its twin when the texture stage commits it (pipeline E's twin too). The toggle writes `stagedBuild.materialMode` into the scene (saved, no undo step) |
| `staged-summary.ts` | pill "Show real textures", "shown in clay until the user picks textures" | pill "Show clay" (`SHOW_CLAY_PILL`) while textured; "Show real textures" after a clay choice |
| `staged-material-mode-tool.ts`, `StagedBuildOverlay.tsx` | "Clay is the default" / "Real textures asked for; none published yet" | "Textured is the default: clay shows first …" / "Clay until the real textures are published" |
| `AGENTS.md` | "Universal First-Request 3D Staging Invariant (Grey Clay Void …)" | "(Textured by Default, Clay on Request …)"; clay exceptions listed (blockout runner and `<VIDEO_REF_0>`, `_clay` tile tools called for clay massing, survey-station clay renders, location evidence tools, shape review); Section 2 is "Views & Material Refinement" |

Unchanged on purpose: `staged-artifact.ts` keeps `renderMode: 'clay'` (the clay layers are the clay look; the textured view comes from the twins); `google_3d_tiles_clay_blockout_runner`, the non-remeshing `google_3d_tiles_get_clay` path and the survey renders stay clay; `object-reference-tools.ts` (sets `'clay'` for object builds) belongs to the `object-materials` branch.

## 3. Tests

Updated to the new policy, keeping coverage and asserting that explicit clay still works and the clay exceptions stay clay: `first-pass-baseline` (renamed from `clay-first-pass-baseline`), `model-authored-artifacts-only`, `spatial-intent-policy`, `staged-summary` (new pill test), `staged-texture-orchestrator`, `staged-texture-viewport` (new: textured default reveals clay first then crossfades on its own; `carryMaterialMode`), the headless-Chrome `staged-texture-viewport-render` (new: default crossfade with no click, "Show clay" saved and kept over a later commit, clay choice reopened from the saved data), `-dither`, `-lighting`, `-late-twin` (now mounted with the viewer's saved clay choice so the toggle still drives each switch).

Pre-existing failures on origin/main, unchanged by this branch (checked with the branch stashed): `python-3d-scene-synthesis`, `procedural-building-complexity` (pythonGenerator.enabled undefined), `location-clay-pipeline` (vertex count), `staged-merged-parts` (pipeline E hero mesh count).

## 4. What Was Tested Live & What Worked (Verified)

* **Location: "the Flatiron Building"** — the staged build mounted the remeshed scan in clay at once (`01_flatiron_clay_first.jpg`), stayed clay while "Real textures" ran (`02_…`), and when the texture stage committed (2 min 54 s) the viewport crossfaded to the textured twin with no click (`03_…`, `04_flatiron_textured_viewport.jpg`). The reply's follow-ups were "1. Staging & Environments" and "2. Views & Material Refinement" with "Show clay" first.
* **"Show clay" in the overlay** — switched to clay; the toggle read "Show real textures", status "Clay. Real textures ready for 1 layer." (`05_…`). After a full page reload the scene reopened in clay with the same toggle and status text read from the DOM (`06_…`).
* **Script scene: "a small fishing harbour scene with a wooden pier, three painted rowing boats and a red lighthouse"** — `execute_3d_python_script` (second attempt; the first failed in 65 ms in the script) opened with the script's materials: red and white lighthouse, blue water, coloured boats (`07_…`). Follow-ups offered a "Clay View" under "Views & Material Refinement".
* **"show it in clay"** — the model set `renderMode: "clay"`; the scene turned clay and the reply offered "Restore Authored PBR Materials" (`08_…`). After a reload it stayed clay (`09_…`).
* **First request asking for clay: "a small market square with a stone fountain and four wooden stalls, in clay"** — opened in studio grey clay (`10_…`).
* **Object: "a vintage rotary telephone"** — `build_3d_object_from_reference` built it and it mounted in clay (`11_object_build_still_clay.jpg`), as expected until the `object-materials` branch lands (that tool sets `renderMode: 'clay'` and its spec carries no per-part materials yet).
* Console: no errors on load (`read_console_messages` onlyErrors: "No console logs.").

## 5. What Broke / Didn't Work

* **An edit during a run interrupts it.** Editing `StagedBuildOverlay.tsx` while the first Flatiron run was going hot-reloaded the page and the run reported "Interrupted". Not a product bug introduced here; rerunning worked (stage cache made the rerun fast).
* **Object builds are still clay** — `build_3d_object_from_reference` mounts with `renderMode: 'clay'` (`object-reference-tools.ts` ~1229), owned by the `object-materials` branch (see section 4).
* **Visual check wording** — the first Flatiron visual check (run before the texture stage committed) mentioned "textured photogrammetry fragments … inconsistent with uniform clay rendering"; it judges whatever frame it captured.

## 6. Candidate Tool/Service Ideas

* **`scene_render_mode` readout in the canvas card** — showing the active render mode and `stagedBuild.materialMode` would have replaced reading DOM test ids through `javascript_tool` to confirm the saved clay choice after reload.
* **Dev-server "run in progress" guard** — warn before a Vite full reload while a chat turn streams a staged build, so an edit does not silently interrupt a multi-minute run.

## 7. Reproduction Steps

1. In the worktree: `ln -s ../integration-behaviour/secrets.json secrets.json`, then `SCRATCHBOX_NO_ELECTRON=true PORT=3611 SCRATCHBOX_WEB_PORT=3631 SCRATCHBOX_TOOLS_PORT=3612 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3631,http://localhost:3631 npm run dev`.
2. Open the token URL from the log; prompt "the Flatiron Building"; watch clay, then the automatic crossfade when "Real textures" commits.
3. Click "Show clay" in the staged panel; reload; the scene stays clay.
4. Prompt a multi-object scene (textured), then "show it in clay" (clay, kept after reload); prompt a scene "… in clay" (clay first pass).
5. Screenshots: `test-results/screenshots/textured_default/` (gitignored).
