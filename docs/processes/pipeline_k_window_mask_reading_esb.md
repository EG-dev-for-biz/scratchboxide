# Process: Pipeline K window fit, the opening-mask reading on the Empire State Building

> **Recorded:** 2026-10-29
> **Status:** Needs Fix (the reading places windows the photo confirms on 5 of the 18 facades the structural fit left empty; with material regions on (run fcdf3c68) facade 63's window column and part of 64's window are drawn as glass on the scan, below the lattice's coverage gate; but an uncached build with the segmenter on (run 5f57d7b2) ran the remesh stage past its 600 s limit and degraded — the segmenter tries need a time cap before the flag is safe)
> **Tags:** `operate-scratchbox` `pipeline-k` `window-fit` `segmentation` `empire-state`
> **Target Domain:** staged locations / pipeline K / facade openings

---

## 1. Session Context

* **What prompted this session:** the window fit's segmenter fallback (`SCRATCHBOX_K_WINDOW_SEGMENT=1`) was reworked so the segmenter's mask places windows itself, kept only where the photo confirms them (`maskWindows`, `openingSegmenter` in `window-fit.ts`); the user asked to see it in the app.
* **Instance used:** launch entry `scratchbox-window-mask`: web 3980, API 3981, tools 3982, with `SCRATCHBOX_K_WINDOW_SEGMENT=1` and `SCRATCHBOX_PYTHON=/Users/eligreen/dev/scratchbox-main/.venv/bin/python` (this checkout's `.venv` has no numpy, OpenCV or MediaPipe, so the segmenter cannot run on it).
* **Scope tested:** the 3D Building button on the Empire State Building (run `1c7d8e54`), the `pipeline_k_window_fit` run note, the lattice's per-facade report, and facades 84 and 63 framed in the 3D viewport textured and in clay.

---

## 2. What Was Tested & What Worked (Verified)

* **Stage caches cleared before the build** — `staged_location/*` stage dirs (not `runs/`), `tile_refine`, `tile_vegetation` deleted after checking no build had touched the cache for 20 minutes. Caveat: another session started an ESB build (run `482e3845`) a minute before this one on the same checkout, so this run's tiles, tile_refine and straightened orthos (`pipeline_k cached: true`) came from that build, computed minutes earlier on the same code. The window fit itself ran in this run: `pipeline_k_window_fit` `cached: false`, and the orthos' `window_fit.json` carries `segment: "segment-try/2"`, which only the new code writes.
* **The segmenter tries, from the run note** — `segmentTries: { attempted: 18, assisted: 5, noWindows: 2, notFound: 11, failed: 0 }`. Windows gained: 43 (1), 63 (3: two confirmed parts of the window column, 12 m and 10 m, plus 0.4 m generated), 64 (1), 84 (3), 86 (2). No call failed (the borrowed interpreter has the modules).
* **Facade 84 in the viewport** — the camera set head-on to its plane (from `facades.json`) and the fitted window rects projected to the screen: the three boxes land on the three dark openings in the stone below the top setback (screen 465-488, 542-561, 618-639 x 214-269 px at an 800 px wide frame).
* **The rest of the build** — finished `degraded` (the Street View survey timed out on every image, unrelated); textures committed; 63 of 88 facades rebuilt on the lattice.

---

## 3. What Broke / Didn't Work

* **Facades 63, 64 and 43 get windows in `window_fit.json`, but nothing draws them** — the lattice report (`polish/c858808beb749b79/stats.json`, `lattice.perFacade`) has no entry for them: `facadeEligible` (`facade-lattice.ts:123`) rebuilds a facade only at `wallCoverage ?? coverage >= 0.6`; 63 is 0.46, 64 0.12. Material regions, the other reader of the fit, is off by default (`twin.materials skipped`, `SCRATCHBOX_K_MATERIAL_REGIONS=1` turns it on). So facade 63's window column, the case the rework was for, is in the record but not in the model.
* **Facades 84 and 86 are rebuilt, but their windows barely recess** — `photoRecessCells` 11 of 146 cells on 84 and 6 of 144 on 86. In clay, framed at 14-16 m from an angle, the wall at the three windows reads flat; the reveals seen in the textured view are the photo.
* **The in-app chat's camera move did nothing visible** — asked to "move the viewport camera to look at (-12.6, 250.2, 16.4) from 70 m along (-0.5, 0, 0.87)", the assistant ran `scene3d_dispatch_operators`, reported the camera moved, and bumped the scene to v7; the viewport did not change. The view was set with the page's own `window.__SB_SET_CAMERA_VIEW__(target, { theta, phi, distance })` instead.
  - Console evidence: none.
  - Suspected cause: not investigated.
* **The segmenter varies from call to call** — across four reruns of the same photos, 82 and 86 gained windows in some and not others; 63 needed the photo enlarged (43 px wide: found 1 call in 4 at its own size, 4 in 4 at 4x; now automatic under 160 px).

---

## 3a. Follow-up the same day: material regions on (runs 5f57d7b2, fcdf3c68)

Instance with `SCRATCHBOX_K_WINDOW_SEGMENT=1` and `SCRATCHBOX_K_MATERIAL_REGIONS=1` (same ports and interpreter).

* **Run 5f57d7b2, uncached (caches cleared after another session's ESB build finished and the cache went quiet) — Needs Fix.** Remesh degraded: "tile_refine failed (Remeshed scan took longer than its 600 s limit)". Steps: tileRefine 25.7 s, pipelineK straightening 205.6 s, windowFit 368.3 s when the stage limit cut it off (no `pipeline_k_window_fit` note written). Without the segmenter the window fit took about 80 s in run 0996136a; the machine's load average was about 30. The build fell back to the flattened raw scan; textures and material regions were skipped. **With the flag on, an uncached build can degrade as a whole.** The segmenter tries need a per-build time cap (tries left over recorded as skipped), which also covers the district case District KD raised (every empty facade of every chunk).
* **Run fcdf3c68, reusing 5f57d7b2's cached scan and straightened photos (the user's choice) — Verified for 63 and 64.** All stages committed. Window fit fresh (`cached: false`): `segmentTries { attempted 18, assisted 5, noWindows 5, notFound 8, failed 0 }`, assisted 63 (2 windows), 64 (1), 82 (1), 84 (3), 86 (2). The lattice still rebuilt neither 63 nor 64 (coverage gate), but material regions (`twin.materials done`) drew planes 63, 64 and 82 on the scan (`pipeline_k_materials.scanPieces.planes`; 21% of scan texels on planes, 3.2% in panes; building glass 4.50 M of 46.3 M texels). Sampled in the viewport by raycasting onto each plane and reading the material maps at the hit's UV:
  - facade 63, scan piece `relief_m108`, window column at t = 10 and 14 m: roughness 6-14 (of 255) against 190-200 on the stone pier beside it; at t = 6 m (below the confirmed part) all 200.
  - facade 64, scan piece `relief_m125`, inside its one window: glass (roughness 7-14) on some samples and 190 on others, patchy because glass is decided per strip; stone (about 200) either side.
  - Caveat: a scan piece takes glass from its plane's bays, which come from the plane's fitted windows or from wall-grammar bays. 63 had no structural windows, so the column is the mask reading's; whether the wall grammar alone would have given 63 bays could not be checked, because another session cleared the tile cache (with this run's `facades.json`, `window_fit.json` and `wall_grammar.json`) before it was read.
  - Under the studio light the glass barely shows to the eye head-on or at 20 degrees; the material maps are the evidence.

---

## 3b. The facade reader on its own (run dbaa178a, uncached, segmenter off, material regions on)

* **Completes in time.** Remesh committed in 556 s (limit now 900 s); whole build 687 s. Steps: tileRefine 24 s, straightening 72 s, window fit 153 s and the facade reader 339 s beside it, polish 80 s. Load was lighter than in run 5f57d7b2.
* **Reader (facade-reader/4).** 263 planes eligible, 80 read (`maxPlanes`), 56 drawn by it, 22 kept from the window fit, 1 skipped, 1 failed; 64 planes (7,045 m²) left unread by the cap.
* **On the 18 facades the structural fit leaves empty.** It drew 3 openings each on 84 and 86, skipped 2 as blank, kept 30, 31, 58 and 59 empty (unsure, or no openings), and did not read the other 12, including 63, 64, 82 and 43, which its plane gates exclude (`minWidthM: 6`, `minHeightM: 10`, `minCoverage: 0.3`: 63 is 3.3 m wide, 82 is 2.9 m, 64 is 12% covered).
* **Correction to 3a: facade 63's glass does not need the mask reading.** With neither the reader nor the segmenter giving 63 any window, its window column (scan piece `relief_m108`, t = 10 and 14 m) still reads roughness 14-18 against 202 on the pier, so the glass comes from another source, most likely the wall grammar's bays (`fittedPlanesOf`). The mask reading's own contribution is therefore limited to 64, 82 and 43.
* **Facade 84:** at the points where the window fit placed its three windows, the scan piece `relief_m121` reads roughness 190-200 (no glass); not investigated further.

---

## 4. Candidate Tool/Service Ideas

* **A "frame this facade" viewport action** — given a facade id of the build, set the camera head-on to its plane and outline its fitted windows; this session computed the plane from `facades.json`, called `__SB_SET_CAMERA_VIEW__` by hand and projected the rects with the page's three.js camera to know where to look.
* **The lattice's skipped facades in the run note** — which facades were not rebuilt and why (coverage under the gate, torn and dropped); found here only by diffing `stats.json`'s `perFacade` against the facade list.
* **A start-up warning when the project's Python lacks the sidecar modules** — every segmenter call failed silently on this checkout's `.venv` before the run note recorded failures; `repo-python.ts` already has the check (`SIDECAR_MODULES`), but the dev server does not surface it.

---

## 5. Reproduction Steps

1. Add a launch entry with `SCRATCHBOX_K_WINDOW_SEGMENT=1` and `SCRATCHBOX_PYTHON` pointing at an interpreter that has numpy, cv2 and mediapipe; start it.
2. Clear the stage caches (keep `staged_location/runs/`), open a new chat, press **3D Building** (the Empire State Building prompt).
3. When it finishes, read `.scratchbox/cache/staged_location/runs/<run>/pipeline_k_window_fit.json` (`segmentTries`, per-facade `segmentTry`) and the lattice's `perFacade` in `tile_refine/<hash>/polish/<key>/stats.json`.
4. Frame a facade: target its plane's centre, `theta = atan2(normal.x, normal.z)`, `phi = pi/2`, with `window.__SB_SET_CAMERA_VIEW__`.
