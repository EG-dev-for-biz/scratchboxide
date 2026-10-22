# Process: Pipeline G (procedural rebuild from a survey of the tile) and the 3D Building button, live

> **Recorded:** 2026-10-22
> **Status:** Verified (end to end in the live app on the Guaranty Building; quality limits below)
> **Tags:** `operate-scratchbox` `staged-location` `pipeline-g` `procedural` `starter-buttons` `provenance`
> **Target Domain:** Real-world 3D locations (isolated structure) / Studio new-chat page / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user asked for pipeline G (the survey-driven procedural rebuild worked out on the Haughwout Building in test scripts) as an app pipeline, with a front-page "3D Building" button that builds a random building through it.
* **Instance used:** web port `3140`, API port `3141`, tools port `3142` (own `scratchbox-pipeline-g` entry in `.claude/launch.json`, run from `.claude/worktrees/pipeline-g`, branch `pipeline-g`; `.env` symlinked into the worktree the way `latest-main` has it; the server used the Gemini key saved in Settings).
* **Scope tested:** the 3D Building button on the new-chat page; its routing to `google_3d_tiles_get_clay` with `isolate` and `procedural`; pipeline G in the grammar slot (stations, plates, reading, native build, paint); the committed layer in the viewport.

---

## 2. What Was Tested & What Worked (Verified)

* **3D Building button** — New Chat → the button sits between 3D Scene and Video NLE (`front_page_3d_building_button.jpg`); a click sends one of its curated prompts (no repeat of the last one).
* **Routing** — the model called `google_3d_tiles_get_clay` within 5.5 s; the run's recorded request was `{ query, isolate: true, procedural: true, trees: true }` (`runs/4bca00b0/stages.json`, `runs/578b5045/stages.json`).
* **Pipeline G on the Guaranty Building, Buffalo (run 578b5045, 2 min 42 s in all)** — resolved 0.7 m from the geocoded point; pipeline E's massing passed (plan IoU 0.86, roof 0.37 m off the scan at the median); G then: 17 of 32 survey stations kept (666 candidate eyes on the walkable street), 2 of 3 wall plates read (72 % and 48 % seen), 252 of 264 elements built natively (250 openings, 79 of them continued into unseen parts; 10 horizontal profiles; 29 vertical members), 37 of 37 faces painted (2 walls from their own reading, 35 from their median colour, labelled generated). Relief skipped with G's reason. The layer `l2g` replaced E's massing in the viewport (`guaranty_app_full.jpg`, `guaranty_viewport.png`). Console: `No console logs.` (errors only).
* **Stated fallback** — when G is asked for and E's massing is not available, the run now records `pipeline_g_unavailable` with the reason (added in this session after the Wainwright run below fell back silently).

* **Flatiron Building, pipeline G only (run 1b8034c9, 3 min 52 s)** — the build ran only place, 3D Tiles, vector data, the massing and G; every other step was skipped as outside the build and left out of the progress panel (four rows: Google vector massing, Google 3D Tiles, Remeshed scan, Facade grammar). Google has no footprint for the Flatiron, only a modelled volume, so the massing is the scan's own plan of the structure (10 corners, plan IoU 0.96). 34 survey stations, 4 of them aerials framing the whole building from 35° up (`pipeline_g_flatiron_aerial/aerial_sheet_labelled.png`); 6 wall plates, 3 read; 10,953 triangles committed as `l2g` (`pipeline_g_flatiron_v2/built_sheet_labelled.png`).

---

## 3. What Broke / Didn't Work

* **Wainwright Building prompt** — Places resolved "Wainwright Building, 709 Chestnut Street, St. Louis" to the Wainwright State Office Building next door; E's massing then failed its scan check (plan IoU 0.5 < 0.6) and the run fell back to the current pipeline with no word about G. Fixed: the prompt was replaced by the Gunther Building, 469 Broome Street, New York, and the silent fallback now records `pipeline_g_unavailable`.
* **Quality on a tall building (Guaranty)** — not a failure, a limit: the survey's selection takes at most 4 faces (`the image budget of 4 is spent`), so on a many-faced footprint one street front was never read while a rear lightwell was; street and mid-height stations do not see above about 35 m, so the upper storeys are the reading's continuation (generated), without the real round top windows or deep cornice; the paint reads near-black purple where the building is red-brown terracotta (dark station renders).

* **Flatiron before the fixes** — (1) the modelled volume split the walls into slivers, so no plate reached the reading threshold; (2) with the footprint massing, the reads of 86 m walls timed out at 180 s (two answered in about 190 s once the deadline grew with wall height); (3) the aerials first failed the per-wall gate built for street stations (each wall is a few percent of an aerial frame); (4) a traced footprint with 27 corners cut the long walls into 7 m pieces. All four are fixed; the timeline log line now carries a degraded stage's reason.
* **Flatiron after** — 3 of 6 walls are still unread (two of them face lanes no street eye reaches), so those walls stay plain piers.

---

## 4. Candidate Tool/Service Ideas

* **High station row for tall faces** — a third twin per street eye at about 0.8 of the face height (or an aerial oblique per face) when the face is taller than the mid-height twin can see; would have read the Guaranty's top storeys instead of continuing them.
* **Per-face survey budget for G** — selectSurveyViews caps at 4 faces (MAX_SURVEY_FACES, sized for Street View image cost); G's stations are free renders, so G should pick its own faces (largest street-facing walls) without that cap.
* **Exposure-normalised plates** — de-light or normalise the station renders before the reading so the read colours are not the shadowed albedo.
* **Run note in chat** — the chat summary should name `pipeline_g_unavailable` when G could not run, from the run's degradations (it was only visible in the run notes during this session).

---

## 5. Reproduction Steps

1. `git worktree add .claude/worktrees/pipeline-g <branch with pipeline G>`; symlink `node_modules`, `desktop-app/node_modules` and `.env` from the main checkout.
2. Add a launch entry on free ports (3140/3141/3142) with `SCRATCHBOX_NO_ELECTRON=true` and `SCRATCHBOX_ALLOWED_ORIGINS`, `preview_start` it, open the token URL from its log.
3. New Chat → 3D Building. Follow `.scratchbox/cache/staged_location/runs/<id>/pipeline_g.json` for G's steps.
