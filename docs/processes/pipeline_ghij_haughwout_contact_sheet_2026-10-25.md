# Process: pipeline G/H/I/J contact sheet on the Haughwout Building

> **Recorded:** 2026-10-25
> **Status:** Verified
> **Tags:** `operate-scratchbox` `staged-location` `pipeline-g` `pipeline-h` `pipeline-i` `pipeline-j`
> **Target Domain:** 3D Building button / staged-location orchestrator

---

## 1. Session Context

* **What prompted this session:** user asked for a side-by-side contact sheet of real results from pipelines D, F, G, H, I, J, K.
* **Instance used:** web port 3500, API port 3501, tools port 3502 (`scratchbox-pipeline-contact-sheet` in `.claude/launch.json`).
* **Scope tested:** four fresh, separate isolated 3D Building builds of the E.V. Haughwout Building, 488 Broadway, New York, one per pipeline letter (`pipeline: 'g'|'h'|'i'|'j'`), via the chat UI, watched through to completion with `watch-staged-build`'s report script.

---

## 2. What Was Tested & What Worked (Verified)

* **Pipeline D/F/K are not comparable/implemented** — investigated first (see "Candidate" note below); none produced, nothing run.
* **Pipeline G** (run `f16ad012`) — "Build ... pipeline: 'g' explicitly" → grammar stage committed, 29,919 triangles, 2/6 wall plates read, 3/5 facade textures accepted. `finish` stage degraded (unrelated to geometry — footprint-breach provenance note on layer `g`, not a build failure). Screenshot: `pipeline_g_haughwout.jpg`.
* **Pipeline H** (run `06d6f79b`) — grammar committed, 32,453 triangles, 2/6 wall plates, 1/5 textures accepted. Same non-geometry `finish` degrade as G. Screenshot: `pipeline_h_haughwout.jpg`.
* **Pipeline I** (run `acd64510`) — grammar committed, 50,979 triangles, 0 degraded stages, Trellis best-of-six + swatch colour match. Screenshot: `pipeline_i_haughwout.jpg`.
* **Pipeline J** (run `38705099`) — grammar committed, 26,565 triangles, 0 degraded stages, Meshy single seed, no colour match (today's default). Screenshot: `pipeline_j_haughwout.jpg`.
* Composited all four into one labeled contact sheet (`pipelines_g_h_i_j_contact_sheet.png`, `make_contact_sheet.py`) and sent to the user.

---

## 3. What Broke / Didn't Work

* **G and H's `finish` stage degraded** on both runs, despite `grammar` committing cleanly — a provenance/footprint-breach note on the committed layer, not a build failure; the model/geometry is real and usable. Not investigated further (out of scope for this task).

---

## 4. Candidate Tool/Service Ideas

* **A true pure-G run was hard to find/produce in the existing cache** — every previously cached "pipelineg"-named GLB on disk actually turned out to be from a `pipeline: 'h'` request (filenames don't encode which letter actually built them, a known naming quirk shared with the I/J `..._pipelinei*.glb` mislabeling). A run-note or filename that actually names the pipeline that built it would have saved the detour of re-deriving this from `stages.json` by hand for every file.

---

## 5. Reproduction Steps

1. Start a dev server from `.claude/launch.json` on free ports (not `scratchbox-dev`).
2. In the chat, send, once per letter: `Build a brand new, separate isolated 3D Building of the Haughwout Building, 488 Broadway, New York using pipeline: '<g|h|i|j>' explicitly (not editing the existing scene, a fresh build).`
3. Find the newest dir under `.scratchbox/cache/staged_location/runs/`, confirm `request.pipeline` matches, then `python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py <runId> --wait`.
4. Screenshot the viewport once `Finished` shows (collapse the build panel, click Fit to View).
5. `docs/screenshots/pipeline_contact_sheet_2026-10-25/make_contact_sheet.py` composites the four screenshots (crops the app chrome, keeps just the viewport pane) into one labeled sheet.
