# Process: Pipeline K sky de-light on the native BVH, with the gain's sign fixed, on the Empire State Building

> **Recorded:** 2026-10-29
> **Status:** Needs Fix
> **Tags:** `operate-scratchbox` `pipeline-k` `sky-delight` `texture-lighting` `native-bvh` `empire-state`
> **Target Domain:** Staged locations / pipeline K / twin textures

---

## 1. Session Context

* **What prompted this session:** `pipeline-k/sky-delight.ts` cast its sky-visibility rays in a TypeScript uniform-grid marcher. It now casts them in C++ (`scratchbox_bvh.hpp` `skyVisibility`, driver `scripts/sky_visibility.cpp`, `sky-visibility-service.ts`). The port's end-to-end test found that the gain had the wrong sign since the step was added (a7055292): it divided each wall texel by `exp(-b (V - Vref))`, multiplying the sky darkening in instead of dividing it out. The fix is `sky-delight/2`. This session measures both changes on uncached ESB builds in the live app.
* **Instance used:** web port `3940`, API port `3941`, tools port `3942`; launch entries `scratchbox-sky-delight-on` (`SCRATCHBOX_K_SKY_DELIGHT=1`) and `scratchbox-sky-delight-off`, same ports, never run together.
* **Scope tested:** the 3D Building starter prompt ("Build a 3D building of the Empire State Building at 350 Fifth Avenue, New York: isolate it and straighten it from Google Maps, its walls flat and its own photo texture straightened"), pipeline K. Before each build, the server was restarted and every stage cache under `.scratchbox/cache/` was deleted except `staged_location/runs/`. In each run, the only stage marked `cached: true` was `textures-late`, which had nothing to do (`lateLayers: 0 ms`). Other sessions ran ESB builds in the same cache at the same time (runs `6fab5dd3`, `b970de81`, `7f848cfc`), under the query "Empire State Building, New York", which has different resolve and tile keys.

---

## 2. What Was Tested & What Worked (Verified)

* **Native ray casting matches the old marcher** (vitest `pipeline-k-sky-visibility.test.ts`): on a street canyon between two closed blocks, 60 samples x 48 rays, the largest difference from the sky-delight/1 marcher (kept in the test as the reference) is 2.4e-8. Every ray decides the same; the test requires < 1e-6. Visibility on the canyon wall rises from 0.04 at the street to 0.92 at 59 m.
* **The sign fix works on a synthetic wall** (same test): a canyon wall photographed with its top 6.6x brighter than the street fits slope 1.5 (capped), with 1.73 on both halves and 78.6% of held-out variance explained. After the step, the top is 1.92x the street; the sky-delight/1 sign made it 22x.
* **Sky on, run `c7e2d085`** (uncached, 801 s, committed, 0 degraded): `twin.sky de-light` ran from 15:48:13.3 to 15:48:19.5, **6.2 s** for the whole step on the ESB twin, native build of the driver included. Harmonise (`pipeline_k_texture.json`): 199 photos, 79,311 patch pairs, mean patch difference **0.1575 -> 0.1261** (log colour).
* **Sky off, run `6c6c7b96`** (uncached, 676 s, committed, 0 degraded): harmonise over 199 photos and 79,172 pairs, **0.1484 -> 0.1231**.

| Seam measure (mean patch difference, log colour) | before harmonise | after harmonise |
|---|---|---|
| off, 2026-10-28 (sky-delight/1 build) | 0.160 | 0.132 |
| on, sky-delight/1 (wrong sign), 2026-10-28 | 0.181 | 0.138 |
| off, `6c6c7b96` | 0.1484 | 0.1231 |
| on, sky-delight/2, `c7e2d085` | 0.1575 | 0.1261 |

---

## 3. What Broke / Didn't Work

* **Sky de-light still widens the seams, by much less.** With the sign fixed the step moves the seams +0.009 before harmonising and +0.003 after (the old sign: +0.021 / +0.006). The two runs' remeshes differ (727,495 vs 732,408 triangles; the facade reader is a vision model), so part of the gap may be noise. The step stays off by default.
* **The sky de-light report was not saved.** `tile-refine-twin.ts` returns `skyDelight`, but the orchestrator wrote no run note for it, so run `c7e2d085`'s slope, halves, held-out variance and gain range are lost. Fixed in this session: the orchestrator now writes `pipeline_k_sky_delight.json` beside `pipeline_k_texture.json`. Not yet confirmed by a build.
* **The rerun to read that report timed out, run `18275f92`** (degraded after 1,192 s): the remesh hit its 900 s limit (pipeline K alone took 911 s, against 142 s in `c7e2d085`; the main thread blocked for 288 s in one stretch, `main_thread.json` `eventLoopMaxMs` 288,300), so the twin and the sky step never ran. Cause: the machine was saturated (load average 41-74). A full vitest suite this session started by mistake (an empty file list after a zsh glob failure) ran alongside, with the other session's ESB build `7f848cfc` (which degraded at the same moment) and a headless Chrome using about five cores. The remesh's degraded reason is only in the chat reply ("timed out at its 900-second limit"), not in the run record.
* **New Chat crashed the canvas once:** `Uncaught Error: Should have a queue. This is likely a bug in React.` from `useSendMessage.ts:632`, right after Vite hot-reloaded `useSendMessage.ts` and `GenerativeCanvasStudio.tsx` (another session's edit; hook 153 changed from `useCallback` to `useRef` between renders). After a full reload New Chat worked: a dev-server artefact, not a product bug.

---

## 4. Candidate Tool/Service Ideas

* **Every twin step writes its report to the run.** A generic `writeRunNote` for each `TileRefineTwin` field present, not one hand-written line per step, so a new step's measurements cannot be lost the way sky de-light's were.
* **A stage's degraded reason in `stages.json`.** The run record says `remesh: degraded` with no reason; the reason only reached the chat model's prose.
* **A build-isolated cache root.** `SCRATCHBOX_ROOT` moves the stage caches and the published models together, so a test build cannot have a private cache without losing the viewer. A cache-only root would let comparison builds run while other sessions build.
* **Pipeline K kernels off the main thread.** A 288 s event-loop block during remesh is the TypeScript pixel kernels (ortho-rectify, lattice stitch) on the main thread; under load they push the remesh past its time limit. Porting them to native drivers (as sky de-light's rays were) is the lasting fix.

---

## 5. Reproduction Steps

1. Check no build is in flight (`.scratchbox/cache/staged_location/runs/*/timeline.jsonl` without `finish`, no `tile_refine` process), then delete everything under `.scratchbox/cache/` except `staged_location/runs/`.
2. `preview_start scratchbox-sky-delight-on` (or `-off`), open http://127.0.0.1:3940/, New Chat, click the 3D Building starter.
3. `python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py --wait <run>`; then read `pipeline_k_texture.json` and (sky on, after this change) `pipeline_k_sky_delight.json` in the run folder, and the `twin.sky de-light` times in `steps.jsonl`.
4. Run on a quiet machine: under load the remesh's 900 s limit is reached before the twin runs.
