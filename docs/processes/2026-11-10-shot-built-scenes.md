# Process: Scenes built for a shot: the in-app agent on a cinematic city brief

> **Recorded:** 2026-11-10
> **Status:** Verified for the shot plan, its report, the shot-camera review, haze with height and the path-traced still; Needs Fix (later fixed: the path tracer draws the haze since its height-haze commit): the path tracer drew no haze, and the agent's scenes stay sparse
> **Tags:** `operate-scratchbox` `3d-viewport` `python-3d` `shot-plan` `detail-budget` `atmosphere` `path-tracer`
> **Target Domain:** Gemini agent chat / scripted 3D scenes (`execute_3d_python_script`), 3D viewport, Metal path tracer

---

## 1. Session Context

* **What prompted this session:** the Higgsfield "10 Fable 5.2 agents built a cinematic city in Blender" case (2026-11-09). The user asked to implement its logic in Scratchbox and see what the in-app agent can do with it, and whether the agent needs a newer Gemini model.
* **Instance used:** web port `3470`, API port `3471`, tools port `3472` (own launch entry `scratchbox-shot-detail-budget`, worktree `.claude/worktrees/shot-detail-budget` on current `origin/main`).
* **Scope tested:** one brief, given unchanged to the chat agent (`gemini-4-argon`) three times: before the change, after the first version of the change, and after correcting its rules. The brief asks for an imagined Manhattan-style avenue at golden hour: a glass tower on the left, brick buildings with fire escapes and water tanks on the right, billboards, traffic, and blocks to the horizon. The camera is 160 m up at 31.5 mm with a 2.39:1 frame, under a backlit sun 33° up, with haze thicker near the ground, recessed windows, and a rendered hero shot at the end.

What was taken from the case, as continuous rules rather than a scene recipe: one layout written once; the camera declared before building; detail sized by what the lens can show (under 2 px is wasted); seeded imperfection; dirt by cause; one low backlight; haze that thins with height. The ten parallel agents were not copied: the in-app agent runs tools one after another and its subagents are read-only, so the logic went into the tools and the prompt instead.

## 2. What Was Built

* **`sb.shot(...)`** (`packages/core/src/python/scratchbox/shot_plan.py`): a camera as measurements (position, target, focal length, sensor, aspect, width, detail budget). `resolves(size, at)`, `pixels`, `min_feature_m`, `member_m` (a thin member thickened just enough to show, at most 8x), `sees`, `frame_point(x, y, depth)` and `right` / `up` / `forward`. Declared shots are written beside the GLB.
* **The shot detail budget** (`packages/core/src/common/spatial/shot-detail-budget.ts`): the share of in-frame triangles whose longest edge is under the budget in every declared shot, per part and in total; frame pixels per triangle; and the advice the agent gets, which says both "wasted" (above 25% under budget) and "under-built" (more than 16 px per triangle). Trees (SB-Veggie, every level of detail stacked in the GLB) are left out of it.
* **`execute_3d_python_script`** opens the scene on the first shot with its lens (`camera.lens`, `keepPoseOnLoad`, `Scene3DData.shots`) and returns `shots` and `shotDetailBudget`. Its visual review adds a clay view through the shot (`visual-review.ts` `renderShotView`) and asks for frame errors, including something on the wrong side of the frame.
* **Review far plane:** the review's software renders drew nothing past 1 km. Every view of the baseline's 1 km street came back blank, and the agent's independent reviewer scored it 1/10 for "blank images" (`HeadlessMeshSilhouetteRenderer.renderShadedMesh` `farPlane`).
* **Haze that thins with height** (`packages/core/src/common/spatial/height-haze.ts`, one expression in TypeScript and GLSL): `atmosphere_configure_scene` gained `visibilityMeters` (a grey haze, Koschmieder extinction 3.912 / V) and `hazeScaleHeightMeters` / `hazeBaseAltitudeMeters`. The aerial perspective pass multiplies its optical depth by the sight line's mean density. The existing `fogHeight` / `fogBaseAltitude` fields were passed around but read by no shader; they now are.
* **`path_trace_render`** finds a published model (`/models/...`, which lives under the repo's `public/models`, outside the chat workspace), or the open scene's own model when given no path. With no camera it renders the open scene's first shot at its own frame size.
* **The virtual geometry builder** (`scratchbox_virtual_geometry.hpp`) decodes `KHR_mesh_quantization` positions and texture coordinates, and leaves out levels of detail drawn by GPU instances (`extras.sbLod.instanced`), keeping each tree's plain level. Before this, no scripted scene with trees could be path-traced.
* **Guidance:** rule 9 of the script guide (`prompt-builder.ts`), the tool's usage note, `python-3d-procedural-director` section 7, and AGENTS.md section 3.9.

## 3. What Was Tested & What Worked (Verified)

All three runs are measured against one camera, (0, 160, 95) toward (0, 14, −210), with trees left out (`probe` scripts in the session scratchpad).

| Run | Script | Triangles in frame | Within 200 m of the lens | Under 2 px | Picture from the shot |
|---|---|---|---|---|---|
| 1, before | 210 s | 362,277 | 315,794 | 32% | A good blockout; no render (see 4) |
| 2, first rule | 7 s | 40,922 | 12,188 | 38% | Brick buildings without windows: worse |
| 3, corrected rule, first pass | 43 s | 210,558 | 169,791 | 41% | Fire escapes, tanks, tower grid; mirrored |
| 3, after its own render | 14 s | 65,698 | 46,115 | 22% (16% from its own shot) | Layout as briefed; sparse (34 px a triangle) |

* **The agent adopted the shot plan unprompted** in runs 2 and 3: it declared `sb.shot` with the brief's lens and frame, and gated detail on `resolves` (run 3: 8 calls to `member_m`).
* **The scene opens on the shot** after a reload: camera at (0, 160, 95), the 31.5 mm vertical field (26.89°). See 4 for the first arrival from the chat.
* **The agent used the haze controls** with sensible values (`hazeScaleHeightMeters` 55, `visibilityMeters` 1800).
* **The path-traced hero shot works end to end** in run 3: `path_trace_render` resolved the published model, took the declared shot at 1920 x 803, 1024 spp, in 25-60 s.
* **The loop corrected the agent:** after looking at its first render, the agent saw the tower on the wrong side, rebuilt with the tower at −X and the sun ahead-left, and rendered again. A third pass gave the final still (`desktop-app/renders/path-traced/scene_1794374452079_46be3c-*.png`). The agent's independent reviewer (`gemini-3.8-flash`) scored it 6.0/10 (layout 9, light 8, brands 5, haze 2) against 1.0 for run 1 and 1.7 for run 2.
* **Haze with height, measured on the GPU:** the live aerial-perspective program holds `uHazeExtinction` 0.002794 /m (= 3.912 / 1400 m) and `uHazeScaleHeight` 55. With that uniform zeroed and restored on the same frame, street contrast falls 24-26% (std 16.1 → 12.9 far, 13.1 → 9.7 near), rooftops 16%, the tall tower 4%: the haze thins with height. It is subtle in this frame because the haze colour is near the grey street's.
* **A scene declaring a shot opens on it when it arrives**, not only after a reload: the run-3 scene opened into a mounted viewport at (2.5, 160, 54), 26.89°, with no reload (after the `keepsPoseForGeneratedModel` fix).
* **Tests:** `shot-detail-budget` (10), `height-haze` (5), `path-trace-render-resolve` (3), `visual-review` (6, including a 1.2 km model), `virtual-geometry` quantization case, plus `sb-stubs`, `instruction-tool-drift`, `python-3d-api-reference`, `sb-script-typecheck`, `part-connectivity`, `aerial-perspective-cloud-shadows`, `metal-path-tracer`, all passing with credentials unreachable. `npm run typecheck`: exit 0.

## 4. What Broke / Didn't Work

* **The first rule made scenes worse (run 2).** The agent tested `resolves()` on a window's 22 cm reveal and a fire escape's 15 cm bars. From 160 m up neither is 2 px, so it left out the whole window system and every fire escape: 12 k triangles near the lens against the baseline's 316 k. Fixed by asking about the feature's overall size and sizing members with `member_m`, which run 3 used.
* **Spatial left/right.** Run 3's first pass put the tower on the right and the sun ahead-right: it took +X as frame-left while looking down −Z. The agent fixed it itself from its render. `frame_point` and the review's side check were added after that run and have not yet been exercised by the agent.
* **Arrival from the chat re-frames the camera.** The viewport kept a saved pose only for the first model of a mount (`Scene3DPrimitive.tsx`, both generated-model paths), so a scene arriving from the chat into an open viewport was re-framed, its shot ignored, until reloaded. Fixed in `cameraSettings.ts` `keepsPoseForGeneratedModel`, where a scene that declares shots always keeps its camera; verified live (section 3).
* **The path tracer drew no haze**, so the hero render showed none of what the agent set; the viewport drew it. Fixed after this session: both tracers draw the same height haze (`render::HeightHaze`, `lighting.haze`), and `path_trace_render` takes the open scene's sun and haze; on run 3's final scene the street's contrast falls 32.9 → 14.2 and the roofs' 47.6 → 30.0.
* **The scenes stay sparse.** The final pass is 34 px a triangle (the first pass of run 3 was 8.4). The blocks behind the brick row are plain boxes, and the materials are flat factors with no weathering pass, which the brief did not ask for.
* **The agent's own error:** run 2's first script failed on an indentation error in its 43 KB script; it rewrote and continued.
* **A page reload ends the agent's turn** (run 2): the turn stopped mid-request and had to be asked to continue.
* **Guard change:** the new `sb.Shot` class block in the generated API summary displaced two small class blocks, taking `sb-stubs`'s count of listed `sb.` names from 32 to 30. That count is only a floor that keeps its name check non-vacuous, so it was lowered to 25. The summary's pinned token budget is unchanged.

## 5. Candidate Tool/Service Ideas

* **Haze in the path tracer:** a participating medium with the same height falloff (`height-haze.ts`), so the rendered still matches the viewport. This session could only show haze in the viewport.
* **GPU instancing in the virtual geometry builder** (`EXT_mesh_gpu_instancing`): the trees' near levels are left out of path-traced stills today.
* **A viewport capture tool for the agent:** "render the live viewport from the scene's shot to a PNG", with its atmosphere, tone mapping and lens. `path_trace_render` and the clay review both ignore the viewport's haze.
* **A camera path on the scene timeline:** the brief's "slow push-in" has no field to land in (`Scene3DData.timeline` has no camera track).

## 6. Reproduction Steps

1. Start an own launch entry on the branch (`scratchbox-shot-detail-budget` above) and open `http://127.0.0.1:3470/`.
2. New chat; paste the brief in section 1 unchanged.
3. Read the result's `shotDetailBudget` in the `execute_3d_python_script` row, the shot view `*_review_0.png` beside the GLB in `build/3d-python/`, and the render under `desktop-app/renders/path-traced/`.
4. Reload the tab and read `window.__SB_3D_CAMERA__`: it stands at the declared shot.
