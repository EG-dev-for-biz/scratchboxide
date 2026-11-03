# Process: Pipeline K's native kernels timed on uncached Empire State Building builds, the switch off and on

> **Recorded:** 2026-11-03
> **Status:** Verified (same output, kernels faster); Unverified (whole-build gain on a quiet machine)
> **Tags:** `operate-scratchbox` `pipeline-k` `native-kernels` `ortho-rectify` `roof-shadow` `texture-harmonize` `material-regions` `empire-state`
> **Target Domain:** Staged locations / pipeline K / remesh and twin stages

---

## 1. Session Context

* **What prompted this session:** four of pipeline K's TypeScript stages were ported to C++20 kernels: the straightening, the roof-shadow sun search and lift, the harmonising (with the roof/wall masks) and the material regions' plan. Each kernel sits beside its TypeScript code (`pipeline-k/native/`, headers in `packages/core/src/native/3d-engine/include/scratchbox_{ortho_rectify,roof_shadow,texture_harmonize,material_regions}.hpp`, drivers in `scripts/*_native.cpp`), and each has a parity test holding it bit for bit to the TypeScript result. All four are wired in behind `SCRATCHBOX_K_NATIVE` (`pipeline-k/native/native-switch.ts`), which is off by default. This session times one uncached build each way.
* **Instance used:** web port `3940`, API port `3941`, tools port `3942`. Two launch entries, `scratchbox-k-native-off` (`SCRATCHBOX_K_NATIVE=0`) and `scratchbox-k-native-on` (`=1`), both run on those ports from the main checkout, never at the same time. I confirmed the server process's environment with `ps eww`.
* **Scope tested:** the 3D Building prompt: "Build a 3D building of the Empire State Building at 350 Fifth Avenue, New York: isolate it and straighten it from Google Maps, its walls flat and its own photo texture straightened". Pipeline K ran both times.
* **Uncached:** before each build I restarted the server and moved every stage cache under `.scratchbox/cache/` except `staged_location/runs/` aside. The old caches went to `/Volumes/Scratchbox/scratchbox-stale/main-cache-2026-11-03-k-native/` before the off build, and to `/Volumes/Scratchbox/scratchbox-stale/k-native-timing-2026-11-03/off-cache/` between the builds. This branch has no restore of caches from the bucket (`0ecb8890` is not in HEAD). `pipeline_k.json` shows `cached: false` in both runs; the only stage marked cached was `textures-late`, which had nothing to do.

---

## 2. What Was Tested & What Worked (Verified)

* **Both builds committed with 0 degraded stages:** OFF was run `a9a66d65` (475 s) and ON was run `0cca18ae` (427 s), each with 751,598 triangles.
* **Times per step** (from `steps.jsonl`, `pipeline_k.json` and `pipeline_k_materials.json`):

| Step | OFF (TypeScript) | ON (native) | Speedup |
|---|---|---|---|
| Straightening, kernel time summed over 83 facades | 90.3 s | 8.9 s | 10.2x |
| Straightening step (`remesh.pipelineK`, wall time on worker threads) | 46.4 s | 22.1 s | 2.1x |
| Roof shadow (`twin.roofShadow`) | 37.5 s | 16.9 s | 2.2x |
| Harmonise (`twin.harmonize`) | 19.8 s | 4.2 s | 4.8x |
| Material regions plan (`pipeline_k_materials.json` `ms`; OFF is the worker pool) | 9.7 s | 7.5 s | 1.3x |
| Facade reader (`twin.facadeRead`, a vision model, not ported: the control) | 127.0 s | 144.8 s | - |
| Whole build | 474.7 s | 426.8 s | 1.1x |

* **Same output:**
  * All 341 straightened facade images and masks are byte-identical between the runs.
  * `rectify.json` and `window_fit.json` are equal once their timings are set aside.
  * `roof_shadow.json` is equal, and so is its top-down audit PNG, byte for byte.
  * The harmonise report (`pipeline_k_texture.json`) is equal.
  * The material plan and `twin.glb` differ, as they do between any two builds: the facade reader and the library-set choice are vision-model calls, so the material maps cannot be compared this way. Their kernel's parity is held by `material-regions-native.test.ts`.
* **Before the builds:**
  * The 23 native parity tests passed.
  * The 10 existing stage test files (53 tests) passed with the switch off and again with `SCRATCHBOX_K_NATIVE=rectify,regions,harmonize`.
  * The `packages/core` typecheck exited 0.
* **Proof sheet:** `docs/screenshots/k_native_timing_2026-11-03/k_native_timing_sheet.png`, with the ON build's viewport capture in `viewport_native_on.png`.

---

## 3. What Broke / Didn't Work

* **The whole build gains only 1.1x.** The four ported steps saved about 61 s together. Vision-model calls dominate the rest: the facade reader (127–145 s), ownership vision (30–37 s) and the library-set choice inside `twin.materials`, whose plan is 7–10 s of a 52 s step. Their latency varies more from run to run than the kernels saved.
* **Part of the straightening step is still JavaScript.** Its kernel time fell 10x, but its wall time fell only 2.1x. The remaining time is PNG decoding and encoding, the request files and the worker threads' start-up.
* **The material plan gains little in the app.** Against the existing worker pool it is 1.3x, not the 9–11x the single-thread benchmark showed.
* **The comparison is noisy.** Other sessions were using the machine: the load average was about 41 when OFF started and about 18 during ON, which favours ON in the wall-clock numbers. The summed kernel times are the reliable comparison. No control rerun was made.

---

## 4. Candidate Tool/Service Ideas

* **Run the facade reader's planes concurrently.** It is now the largest single step in K (about 2–2.5 min). Its per-plane vision calls are where the next real saving is, not in more native ports.
* **Hand the straightening its pixels in memory.** Passing raw RGBA from tile_refine's orthos, or a long-running native worker, would remove the PNG round trip that now takes more than half of the step's wall time.
* **A per-step timing table in the run report.** `staged_run_report.py` prints stage times only. I had to write a script to read the step durations from `steps.jsonl`. Adding that table would make an A/B like this one a single command.

---

## 5. Reproduction Steps

1. Check that no build is in flight: no `timeline.jsonl` without a `finish` under `.scratchbox/cache/staged_location/runs/`. Then move everything under `.scratchbox/cache/` except `staged_location/runs/` aside.
2. Run `preview_start scratchbox-k-native-off`, open http://127.0.0.1:3940/, start a New Chat and send the prompt above.
3. `python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py --wait <run>`. Then read the step durations from the run's `steps.jsonl`, plus `pipeline_k.json` (`ms`, and each facade's report `ms`) and `pipeline_k_materials.json` (`ms`).
4. Copy the run's `orthosDir` (named in `pipeline_k.json`) aside, stop the server and move the caches aside again. Then repeat steps 2–3 with `scratchbox-k-native-on`.
5. Compare the two orthos folders with `cmp`, and the JSON reports with their timings removed.
