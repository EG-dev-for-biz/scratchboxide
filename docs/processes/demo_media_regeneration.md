# Demo media: removed from the repo, and how to recreate it

**Date:** 2026-10-20
**Status:** Media removed; demo pages, scripts and tests kept.

## What was removed

- **Images:** 153 still images from `public/images` (623 MB): 360° panoramas, blockout and comparison keyframes, the dense-plaza, Eloise and Plaza Hotel stills, lens-split and matchmove proof images, and sample stills.
- **Videos:** everything in `public/videos`:
  - the demo `.mp4`s;
  - the frame sequences `frames`, `frames_alpine`, `frames_clay`, `frames_plaza`, `frames_shibuya` and `frames_textured`;
  - `renders` and `renders_clay`;
  - the three blockout manifests (two of them were `"mock": true`).
- **The copies under `desktop-app/public`:** `desktop-app/public/videos` and `desktop-app/public/images/blockout_frame_00.png`.
- **Hydration entries:** 30 entries in `manifests/demos_asset_manifest.json`, so `npm run hydrate` (which runs before `npm run dev`) no longer downloads them again.

The demo pages that show this media are kept. Until their media is regenerated, those pages show missing images or videos.

## Recreating it

| Media | How to recreate |
|---|---|
| 360° panoramas (`*_360_4k.png`, `*_360_4k_raw_pinched.png`, `kyoto_bamboo_16k_test.avif`, `pantheon_rectilinear_ceiling_1to1.png`) | The in-app `panorama_generate_360` tool (`Google360PanoramaPipelineService`) |
| 16K panoramas (`*_360_16k.jpg`) | `scripts/generate_all_monumental_16k_assets.ts`; the desert canyon also has `scripts/remediate_desert_canyon_16k.ts` |
| Google tiles blockout flight (`frames_clay`, `frames_textured`, `google_tiles_*_blockout_camera.mp4`, `blockout_frame_00.png`, `blockout_textured_frame_00.png`, `blockout_4k_keyframe_*`, the manifests) | `scripts/run_google_tiles_blockout_pipeline.cjs` (the `google_3d_tiles_clay_blockout_runner` tool) |
| Omni blockout video from `frames` | `scripts/render_omni_blockout_video.ts` |
| Omni restyle and comparison (`google_tiles_omni_restyled.mp4`, `comparison_*_keyframe_*`, `start_frame_01_*`) | `scripts/run_real_vertex_omni_execution.cjs` |
| Eloise matchmove (`eloise_*`) | `scripts/matchmove/build_eloise_demo.py` and `scripts/matchmove/omni_recreate_shot.ts` |
| Plaza Hotel matchmove (`plaza_hotel_*`, `frames_plaza`, `plaza_*_keyframe_*`) | The matchmove pipeline (`GeoCameraMatchmovePipelineService`, which writes `<name>_blockout_manifest.json`) |
| Everything else (`lens_split_*`, `precision_matchmove_*`, `real_tile_stage*`, `*_ai.png`, `interaction_input_*`, `dense_plaza_*`, `clay_blockout_frame_36.png`, `real_omni_frame_36.png`, `plaza_wireframe_transparent_overlay.png`, `frames_alpine`, `frames_shibuya`, `renders*`, the `s4d_*` reference videos) | No script in the repo makes these. Regenerate with the in-app tools, or restore them as described below. |

## Restoring the originals

- **Tracked files:** git history keeps every one. Restore with `git checkout <commit>^ -- <path>`, where `<commit>` is the commit that removed them.
- **The `.mp4` videos** were never in git. Their mirrors were listed in `manifests/demos_asset_manifest.json` before this change, in the `scratchbox-demo-assets` storage bucket. Restoring those entries makes `npm run hydrate` fetch them again.

## Tests

- **Two tests now skip with a stated reason when the media is absent,** and run again once it is regenerated:
  - `regenerate-demo-assets` uses the raw panoramas as input;
  - `gallery-asset-integrity` checks the Plaza Hotel keyframe stills.
- **Tests that already skipped** when their gitignored media was missing still do.
- **The gallery test still checks** that the gallery page names the right media for each district.
