# Process: Pipeline E (enhanced Lite + measured relief) live on a fresh place: Grace Church, 802 Broadway

> **Recorded:** 2026-10-19
> **Status:** Verified (behind `SCRATCHBOX_STAGED_PIPELINE=e`; branch `version-e`, merge-readiness run)
> **Tags:** `operate-scratchbox` `staged-build` `pipeline-e` `relief` `enhance` `merge-readiness`
> **Target Domain:** Gemini Agent Chat / real-world locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. Session Context

* **What prompted this session:** the readiness check before merging `version-e` to main asked for one live run of a place no bake-off had used, through the normal chat, with the version E flag on.
* **Instance used:** web port `3591`, API port `3592`, tools port `3593` (`.claude/launch.json` entry `version-e-ready`, `npm --prefix .claude/worktrees/version-e run dev`, env `SCRATCHBOX_STAGED_PIPELINE=e`; enhanced mode and relief at their defaults, i.e. on). Viewport emulated at 1600x1000.
* **Scope tested:** the chat request "Build Grace Church, 802 Broadway, New York in 3D" end to end: the staged progression, the final clay and textured views, the result card and its provenance text.

---

## 2. What Was Tested & What Worked (Verified)

* **Staged progression** — the request went to `google_3d_tiles_get_clay`; the panel showed Google 3D Tiles committed at 3.7 s, the clean vector massing committed (inferred) at 6.9 s, Facade grammar running with "enhanced mode: registering 5 panos against the scan's silhouette and edges", then "enhanced mode: redrawing wall 540 (69 m²)" at 174 s, Facade grammar committed at 3 min 39 s, then "pipeline E relief: the photo-match gate on 4 Street View photos (base, measured)", Measured relief committed at 54.4 s, Finished at 4 min 45 s (tool call 284,993 ms). Screenshots `test-results/screenshots/version_e/app6/01-06`.
* **Stage limits** — grammar 219 s against its 420 s limit; relief 54 s against 480 s.
* **Result** — inference: 0 of 2 window grammars (held-out and plausibility refused them), 3 of 362 occluders, 0 of 16 colour transfers; enhanced mode: 8 of 8 walls redrawn by `gemini-3.1-flash-lite-image` and accepted by the identity gate (chamfer 0.96-4.81 px, 3-34 % of the tile's edges lost, reported); Street View guidance 10 photos, 10 posed, 7 with owned pixels. Relief: 4 of 89 bands and 26 of 108 vertical elements kept; gate base 3.58 / measured 3.58 overall (4 photos x 3 runs): measured kept, no generated profile built.
* **Result card** — the agent reply lists the layers `l1` as-scanned, `l2` vector-massing (confidence 0.83), `l2g` photo-inferred / generated (0.75, "8 of 8 walls redrawn by gemini-3.1-flash-lite-image in enhanced mode", with the note that generated surfaces are AI-enhanced from the tile imagery), `l2r` measured relief with the kept counts and the gate score; no degradations; skipped stages each with their reason. Matches the run notes (`runs/e96de608/pipeline_e_inference.json`, `pipeline_e_relief_gate.json`).
* **Final views** — clay (`07_final_clay.jpg`) and textured (`08_final_textured.jpg`, `08b_final_textured_viewport.png`): the spire, the cruciform nave and the transepts stand; the textured twin carries the enhanced plates.
* **Console** — `read_console_messages(onlyErrors)`: "No console logs." Network: the relief layer's textured GLB `grace_church_802_broadway_new_york_iso_massing_6ef142d5_relief_tex.glb` 200, no failed requests in the buffer.

---

## 3. What Broke / Didn't Work

* Nothing failed. Two things to know:
  - The panel says "Real textures on 1 of 3 layers ... the rest stay clay": the trees and residual layers have no textured twin.
  - "Measured relief: reveal skipped (frame time)": the relief layer appeared without its reveal animation.
  - The scan residual (2,745 proud triangles in 13 clusters) shows as jagged scan pieces around the base in both views.

---

## 4. Candidate Tool/Service Ideas

* **A "show superseded layer" toggle in the viewport** — the same camera before and after the relief or enhanced layer; here the progression could only be screenshotted as it happened.
* **A per-stage timing line in the result card** — the stage limits were checked from the panel by hand.

---

## 5. Reproduction Steps

1. Add the `version-e-ready` entry to `.claude/launch.json` (ports 3591/3592/3593, `SCRATCHBOX_STAGED_PIPELINE=e`, `npm --prefix <worktree> run dev`), link `secrets.json` into the worktree, `preview_start`.
2. Open the token URL from the logs; New Chat; send "Build Grace Church, 802 Broadway, New York in 3D".
3. Wait about 5 minutes; collapse the panel, Fit to View, zoom in; "Show real textures" for the textured view.
4. Run notes: `.scratchbox/cache/staged_location/runs/e96de608/`.
