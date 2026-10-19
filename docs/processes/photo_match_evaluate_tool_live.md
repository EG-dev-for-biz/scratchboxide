# Process: photo_match_evaluate in the agent: Washington Square Arch built, then judged against held-out Street View

> **Recorded:** 2026-10-19
> **Status:** Verified (4 held-out views registered and judged; the build and the raw scan tie at 3.8)
> **Tags:** `operate-scratchbox` `location-evidence` `photo-match` `street-view` `staged-build`
> **Target Domain:** Gemini Agent Chat / real-world locations

---

## 1. Session Context

* **What prompted this session:** the photo-match evaluator (`staged-location/photo-match-eval.ts`, the bake-off's judge) became the in-app tool `photo_match_evaluate` (`packages/core/src/node/gemini/tools/location-evidence/photo-match-evaluate.ts`, in the location-evidence pack). This checks that the app's own agent picks it and that it runs end to end on a live build.
* **Instance used:** web port `3042`, API port `3041`, tools port `3043`, started from the worktree with `npm run dev` (env vars, not `.claude/launch.json`). Driven from a private headless Chrome over CDP, because the shared Browser pane's tab was taken over by another session mid-run.
* **Scope tested:** two chat turns. First "Build the Washington Square Arch in New York as a 3D location build, isolated to just the arch." Then "Now check how much this build actually looks like the real arch: evaluate it against held-out Street View photos."

---

## 2. What Was Tested & What Worked (Verified)

* **The build.** `google_3d_tiles_get_clay` ran as staged run `9132f71c` and finished degraded in 5 min 26 s: tiles, remesh, scan-fitted rebuild, figures and textures committed; the facade grammar and photo-read detail were degraded.
* **The agent picks the tool.** With the staged scene open, the model called `photo_match_evaluate` with no arguments, so the open scene was evaluated. The tool ran for 239 s and reported progress throughout (Street View fetch, registration, rendering, "judged n of 4 views").
* **Held out, honestly.** There were 49 Google panos near the arch. 23 were excluded as used by the build: 22 from the run's notes, stage entries and scene, and 1 more named in the layer GLBs' extras. 8 unused views were fetched. 7 locked in edge registration against the tile mesh; one (`bUGpC7ps…`) stayed at 12 → 12 px and was not used. The 4 nearest locked views were judged (14 to 24 m; edge residuals 1.5 to 2.8 px).
* **In context.** Both arms were drawn inside the photo-textured tile with the arch's 1,820 isolate triangles cut out and 33,770 kept. The arms were the raw scan cut to the arch (baseline) and the build's visible layers l3b, l3cf, l4f and l4, all textured twins (278,395 triangles).
* **Blind judging.** `gemini-4-argon` answered every call, with no fallback: 4 views × 3 reshuffled runs. Overall scores: raw 3.83 (run sd 0.35, views 3.3–4.3) and build 3.83 (run sd 0.32, views 3.0–5.0). The build is ahead on detail (3.17 vs 2.75) and behind on errors (3.58 vs 4.17). The summary says the two are within the judge's own spread and that both are weak likenesses (below 5).
* **Pixel metrics (secondary).** SSIM: raw 0.421, build 0.418. Edge chamfer: raw 8.24 px, build 8.06 px. CIEDE2000: raw 12.3, build 11.5.
* **The answer in chat.** The agent reported the held-out selection, the scores with their spread, a per-view breakdown with the grid paths and the pixel metrics. It did not claim a likeness the scores do not support.
* Screenshots and grids are in `test-results/screenshots/tool_photo_match/` (`live_arch_*`).

---

## 3. What Broke / Didn't Work

* **The shared Browser pane.** About two minutes into the first build request, the tab opened for this session (`tab-18`, port 3042) was navigated to another session's app on port 3062. That request was lost, and no new tab could be opened (the pane's tab cap was reached). Workaround: a private headless Chrome driven over CDP.
* **The tool itself:** nothing broke.

---

## 4. Candidate Tool/Service Ideas

* **Show the grids in chat.** The result gives the grid PNG paths under `.scratchbox/cache/photo_match/`, and the chat shows them as text. A result card that renders the grid images would let the user see the photo beside each render without opening files.
* **Evaluate a run that is not open.** Without the open scene, a run's visible layers are unknown (`run_layers_unknown`), because the stage cache does not record which layers the final scene showed. A run note listing the final visible layers (and their textured twins) would let the tool evaluate any past run by id.

---

## 5. Reproduction Steps

1. Link `secrets.json` into the worktree, then start the app: `cd desktop-app && SCRATCHBOX_NO_ELECTRON=true PORT=3041 SCRATCHBOX_WEB_PORT=3042 SCRATCHBOX_TOOLS_PORT=3043 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3042 npm run dev`, and open the token URL it prints.
2. Send the two prompts above, waiting for the build to finish before sending the second.
3. The report and grids are written to `<repo>/.scratchbox/cache/photo_match/<place>_<time>_<rand>/` (`report.json`, `grid_*.png`, per-arm renders). The raw Street View photos are never written there; they appear only inside the grids.
