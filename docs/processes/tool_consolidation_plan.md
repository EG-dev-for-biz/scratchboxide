# Tool consolidation plan (step 3)

**Date:** 2026-10-20
**Status:** Steps 1 and 2 done on 2026-10-20 (branch `tool-aliases-templates`); steps 3-6 not started

## Inventory (live registry, `createDefaultToolRegistry()`)

- **173 tools registered.** 172 are offered by default.
- **Six packs choose what a turn sees:** `core_workspace`, `geospatial_3d`, `mesh_surface`, `vfx_video`, `lens` and `browser` (`domain-tool-packs.ts`). The resolver picks packs per turn, so the model rarely sees all 173 at once.
- **`inferToolGroup` puts 163 tools in "workspace".** The group label carries no information; packs do the real selection.

Largest families by name prefix:

| Family | Count |
|---|---|
| `vfx_*` | 16 |
| `workspace_*` | 12 |
| `spatial_*` | 9 |
| `panorama_*` | 9 |
| `adaptive_*` | 8 |
| `survey_*` | 7 |
| `browser_*` | 6 |

`location_*`, `build_*`, `pbr_*`, `atmosphere_*`, `geobox_*` and `lighting_*` have 5 each.

## Findings

### 1. Pure aliases (one tool, several names)

`geobox_resect_camera_pose` and `spatial_resect_image_location` both call `geobox_resect_image_location`'s handler unchanged. That is three names for one tool.

### 2. Overlapping tools (same purpose, separate code)

| Overlap | Tools |
|---|---|
| Camera spline from keyframes | `continuous_spline_synthesize_trajectory` / `continuous_spline_matchmove_optimize` (`ContinuousSplineMatchmoveService`) and `adaptive_matchmove_synthesize_trajectory` (`AdaptiveMatchmoveCalibrationService`) |
| Edge alignment | `spatial_closed_loop_edge_align`, `geobox_closed_loop_edge_align` and `geobox_optimize_edge_alignment` |
| Place lighting | `atmosphere_harmonize_location_3d` and `geobox_harmonize_location_lighting` |
| Lighting from an image | `lighting_estimate_from_photo`, `atmosphere_estimate_from_image` and `lighting_match_image_to_location` |
| Panorama generation | `panorama_generate_360` and `panorama_generate_4k` |
| Two avatar families | `avatar_4dgs_list/get/animate/retarget` and `humanoid_avatar_list/get/skin/animate` |

### 3. Families that are one tool with a mode

| Family | Members |
|---|---|
| `vfx_ffmpeg_*` | 10 operations (quick edit, extract frames, split screen, storyboard sheet, LUT grade, chromakey, controlnet map, audio normalize, seamless loop, encode sequence) |
| `survey_*` | 7 steps of one survey workflow |
| `webxr_geospatial_*` | 3 modes of one coordinate bridge |
| `universal_3d_structure_*` | 4 operations on one structure |
| `pbr_get_material_catalog` | Next to `pbr_synthesize_material` |

### 4. Prompt templates exposed as tools

`build_beautify_prompt`, `build_neutral_performer_prompt` and `build_frame_motivated_performer_prompt` only fill a text template. The model has to remember to call them before generating; they should run inside the generation step instead.

`build_conditioning_contact_sheet` and `normalize_conditioning_plates` make real images and stay tools.

### 5. Missing tool that instructions rely on

The `directors-treatment` skill tells the model to make storyboard frames with `generate_image`, but no image-generation tool is registered (`KNOWN_DRIFT` in `instruction-tool-drift.test.ts`). The fix is either:

- register a real image tool (Nano Banana / Imagen, with the model fallback list made visible); or
- point the skill at whatever the app actually uses to make images.

`adaptive_matchmove_render_blockout` (geo-camera-matchmove skill) is the same kind of gap; the closest real tool is `google_3d_tiles_clay_blockout_runner`.

## Proposed changes, in order

1. **Remove the pure aliases.** Keep `geobox_resect_image_location` and register the two other names as hidden aliases (`offeredByDefault: false`) for one release, so saved scripts and chats keep working.
2. **Fold the prompt-template tools into the generators.** Beautify runs inside restyle and survey beautify; the performer prompts run inside the video and avatar capture tools. Keep the functions; stop offering them as tools.
3. **Decide the image tool.** Register `generate_image` or rewrite the skill. This is the user's call: it adds a billed tool the model can call freely.
4. **Merge families into one tool with a mode:**
   - `vfx_ffmpeg {operation}` (10 → 1);
   - `survey` steps (7 → about 4);
   - `webxr_geospatial {mode}` (3 → 1);
   - `universal_3d_structure` (4 → 2).

   Each merged tool keeps per-mode parameter validation and error messages.
5. **Pick one implementation for each overlap in §2.** Pick by measured results: run both on the same inputs and keep the better one, without choosing by name. Delete the loser's tool, and its service if nothing else uses it.
6. **Re-check the packs.** With families merged, re-balance the six packs so a typical turn sees about 30–50 tools.

**Expected result:** about 173 → 135 registered tools. The earlier estimate of 60–80 was too optimistic: most tools are distinct operations. The bigger win is fewer tools per turn through the packs, not fewer tools overall.

## How to do it safely

- **Find which tools the model actually calls.** Before step 4, read the saved chat sessions for tool-call counts. Merge rarely used families first; leave hot paths until last.
- **Keep old names as hidden aliases** for one release, then remove them.
- **Tests per change:**
  - `tool-registry-handlers` (every declaration has a handler);
  - `domain-tool-packs-and-coercion`;
  - `instruction-tool-drift`, after updating skills and the system prompt in the same commit;
  - each pack's own tests.
- **Check the in-app agent live.** One chat per merged family (operate-scratchbox skill) confirms the model picks the merged tool and its mode correctly.

## Done: steps 1 and 2 (2026-10-20)

### Step 1: resection aliases hidden

- `geobox_resect_image_location` is the one offered name. `geobox_resect_camera_pose` and `spatial_resect_image_location` stay registered (`createDefaultToolRegistry`, `offeredByDefault: false` through `DEPRECATED_TOOL_ALIASES` in `tool-registry.ts`) so saved scripts and chats still dispatch them to the same handler; `declarations()` and `declarationsForPacks()` both leave hidden tools out. Their descriptions start `DEPRECATED alias of geobox_resect_image_location (hidden since 2026-10-20; remove after one release)`.
- The kept name replaces the aliases in the system prompt (`prompt-builder.ts`), the `image-location-resection` skill, `lighting_match_image_to_location`'s description, `GeoBoxPrecisionResectionService`'s error names and the API ledger. The capability resolver already named the kept tool.
- Test: `tool-deprecated-aliases.test.ts` (hidden by group and by pack; alias dispatch gives the kept handler's result; one error text from every name).

### Step 2: prompt-template tools folded into generation

Real call sites found:

| Path | Where the template is applied | Status |
|---|---|---|
| Survey beautify (`survey_beautify_station`, `survey_beautify_to_splats`, `survey_beautify_to_texture`) | `BeautifyStationService.beautify` -> `buildStationBeautifyPrompt` -> `buildBeautifyPrompt` | Already applied; now proven at the network boundary |
| Mesh render restyle / AI Beautify of a render (`spatial_ai_render_scene`, and `SceneKeyframeVideoService`, `MeshAiTextureBakingService` through `renderAiBeautyFrame`) | `NativeAiRenderEngineService.buildMeshRenderRestylePrompt` was a hand-copied variant of the no-place template; it now calls `buildClayRenderBeautifyPrompt` (new, in `location-beautify-service.ts`), which `buildBlockoutNanoBananaPrompt`'s no-coordinates branch also reads. One template, two readers. | Wired |
| Performer video / image capture | None exists. No tool or service in the app generates performer images or video; `buildNeutralPerformerPrompt` and `buildFrameMotivatedPerformerVideoPrompt` are read only by the two template tools, and `VideoTo4DPerformerPipelineService.frameMotivatedInput` (which only records metadata) is passed by nothing in production. | Nothing to wire; the functions stay |

- `build_beautify_prompt`, `build_neutral_performer_prompt` and `build_frame_motivated_performer_prompt` are registered but hidden (`PROMPT_TEMPLATE_TOOL_NAMES` in `vfx-video-tools.ts`, added to `DEPRECATED_TOOL_ALIASES`), with `DEPRECATED (hidden since 2026-10-20; remove after one release)` descriptions. The capability resolver, the `ai-beautify-location-pipeline` and `google-omni-prompting-and-formatting` skills, `preflight_capability.cjs` and the ledger now point at the generating tools (beautify) or the functions (performer).
- The performer decision is reversible in one line (drop the two names from `PROMPT_TEMPLATE_TOOL_NAMES`) if the user wants the model to keep writing those prompts for runs outside the app.
- **MCP:** `scratchbox-mcp-server.ts` and `scratchbox-mcp.ts` expose `VFX_VIDEO_TOOL_DECLARATIONS` directly, so the three still appear as `mcp__scratchbox__build_*` to external clients (Claude Code sessions use them). Left as is: an external client has no generation step to fold them into.
- Test: `beautify-template-in-generation.test.ts` stands a fake GenAI client at `client.models.generateContent` under the real `GoogleMediaGenerationService` and asserts the exact prompt text the mesh render restyle and the survey beautify send.

## Update (2026-10-20): the two performer prompt tools are offered again

`build_neutral_performer_prompt` and `build_frame_motivated_performer_prompt` are offered to the model again (user decision). No generation path can tell when an image is a performer reference without keyword routing, so the model writes the prompt with the tool and then calls `generate_image` (for a reference image) or hands the prompt to the user (for video). Only `build_beautify_prompt` stays hidden, because the generation paths apply that template themselves. The capability resolver now names the two tools as its target for performer requests.

