# Process: Massing capability review (Pipeline I default) — Haughwout Building, footprint-lock catches a real breach

> **Recorded:** 2026-10-24
> **Status:** Verified (the footprint-lock fix shipped and re-verified live, below)
> **Tags:** `operate-scratchbox`, `watch-staged-build`, `massing`, `pipeline-i`, `pipeline-h`, `footprint-regularize`, `haughwout-benchmark`
> **Target Domain:** 3D Building staged-location pipeline — massing / footprint locking

---

## 1. Session Context

* **What prompted this session:** user asked to review massing capability now that the massing-related tools on `main` have been updated (uncommitted working-tree changes to `orchestrator.ts`, `facade-grammar.ts`, `face-survey.ts`, `texture-pass.ts`, `texture-uv.ts`, plus new `footprint-regularize.ts` and `pipeline-i/refine.ts`). The standing check for any single-building pipeline change is the 2026-10-23 Haughwout benchmark (`.claude/skills/watch-staged-build/references/haughwout_baseline.json`).
* **Instance used:** own isolated launch entry `scratchbox-massing-review` — web port `3400`, API port `3401`, tools port `3402` (added to `.claude/launch.json`, `SCRATCHBOX_PIPELINE_I_REFINE=1` set so the new `pipeline-i/refine.ts` path runs). Did not touch the user's `scratchbox-dev` entry or ports 3060-3062.
* **Scope tested:** one live, end-to-end staged-location build of the E.V. Haughwout Building (488 Broadway, NYC) through the canvas chat UI — run `88eae258`, driven and monitored per the `watch-staged-build` skill.

---

## 2. What Was Tested & What Worked (Verified)

* **App bring-up** — new launch entry, `preview_start`, read back the actual bound port/token from `preview_logs`, navigated with the token. Evidence: `read_console_messages({onlyErrors:true})` → "No console logs." both at load and after the finished build; clean network load.
* **End-to-end staged build** — typed "Build a procedural 3D building of the E.V. Haughwout Building, 488-492 Broadway, New York: isolate it from the scan and rebuild it with the staged-location pipeline, facades read from a survey of the photo tiles." into the chat → full run committed `resolve → vector → tiles → remesh → grammar → finish` with no crashes, in 366 s (`staged_run_report.py 88eae258`).
* **Shared massing check (pipeline_e, used ahead of both G/H and I)** — IoU **0.88**, roof offset 1.78 m median / 3.24 m p90, `ok: true`. Matches the baseline's 0.885 IoU to within noise.
* **Pipeline I is now the live default** — no `pipeline` param was passed; the orchestrator picked Pipeline I on its own (per the 2026-10-24 AGENTS.md decision), ran all four stations → 4K character sheet (`gemini-3.1-flash-image`) → 6 Trellis-multi seeds on fal.ai in parallel (seeds 7/11/23/41/59/73, scores 0.743-0.825) → kept seed 11 → swatch colour match → fit to scan footprint/height (plan IoU **0.915**, 96.7% footprint coverage, 5.5% of the model's plan outside it — reported, not clipped, which is the documented Pipeline I exception to the footprint rule). `pipeline_i.json` total 235 s.
* **New `pipeline-i/refine.ts` step (the file under review) ran end-to-end** — `pipeline_i_refine.json` shows a second massing fit pass (plan IoU 0.915, shift -1,-1 m), a 24-station resurvey, and facade projection onto the 2 faces the survey actually saw well (face 2: f-score 0.563 → **0.794** after projection; face 3: 0.632 → **0.883** after projection). **2 of 6 wall plates read — an exact match to the baseline's "2 of 6."**
* **Specular-materials inference (recent commits)** also fired inline: 21 of 2,114 sampled cells accepted across 21 regions (`pipeline_i_specular.json`) — ran without error, did not block the build.
* **Visual check** — the finished geometry reads as a recognizable 5-story cast-iron building with a rooftop water tank (see screenshot 1 below), textured on the two surveyed faces, clay elsewhere, matching the documented default (textured where real data supports it, clay/generated where it doesn't).

---

## 3. What Broke / Didn't Work

* **`footprint_breach` on the `remesh` (vector-massing) layer — new check, real defect, visually confirmed.**
  `footprint_lock_massing_layer.json`: `{"vertices":14619,"outsideShare":0.125,"maxOutsideM":5.04,"beyondLimit":931,"ok":false}`. 931 of 14,619 vertices (12.5%) on the massing/remesh layer sit more than 1.5 m outside the locked footprint, up to **5.04 m** beyond it. The chat's own finish summary called this out explicitly: *"remesh fell to the layer as built, its breach recorded (footprint_breach)"* — the one reason the run ended `degraded` instead of clean.
  - This is **not** a crash or a missing feature — the new footprint-lock gate (part of the `footprint-regularize.ts` / orchestrator massing-choice work) is doing exactly what it's supposed to: catching geometry that violates the "believable within the designated footprint" rule, something the 2026-10-23 baseline run had no equivalent check for at all (the gate didn't exist then, so the old run couldn't have failed it either way).
  - Visually confirmed, not just a number: the textured mid-facade on the long elevation **bulges outward in a rounded bay shape** well past the building's rectangular footprint (screenshot 2 below) — a real geometric defect, not a false positive. The bulge sits on the `remesh` (vector-massing) layer, not on the Trellis-generated model (which stayed inside its own, separately-tolerated 5% overflow).
  - Suspected cause (not investigated further this session): the scan-residual clustering in `pipeline_e.json` records a `"proud"` cluster of 1,075 triangles with `areaM2: 465.5` and `extremeM: 2.6` directly in this elevation's bounding range — i.e. the massing extrusion pulled in a large proud (outward-bulging) scan residual cluster that the new footprint lock correctly flags but the orchestrator still commits "as built" rather than clipping or re-fitting it. Worth tracing in `orchestrator.ts`'s massing-choice branch and `footprint-regularize.ts` to see why a flagged breach still gets committed instead of triggering a re-fit.
* **Secondary observation, not a hard failure:** `pipeline_i_refine.json`'s own `massingOnly` fit (the footprint-regularize output fit directly against the scan, independent of the Trellis model) scores plan IoU **0.637** / scan IoU **0.551** — much weaker than the full Trellis-fitted result (IoU 0.915). The regularized-massing-only geometry is a noticeably worse standalone fit to the scan than what the generative model+fit produces; it's only used as a prior/initialization here so it didn't block anything, but it's a plausible contributor to the footprint breach above.

---

## 4. Candidate Tool/Service Ideas

* **Auto re-fit on `footprint_breach`** — when `footprint_lock_massing_layer` comes back `ok:false`, the orchestrator currently commits "as built" with the breach recorded rather than attempting one re-fit pass (e.g. re-running `footprint-regularize.ts` with a tighter clip or re-deriving the proud/cut split in `pipeline_e.json`). Today's manual diagnosis required reading three separate JSON files by hand; a single `massing_breach_explain` style note surfaced directly in the chat summary (pointing at the specific scan-residual cluster, the way `pipeline_e.json`'s `ledger` already explains the footprint/structure picks) would have made this a 30-second read instead of a cross-file trace.

---

## 5. Reproduction Steps

1. `lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(3400|3401|3402)\b'` to confirm the ports are free (or pick a fresh unused triple).
2. Add a `scratchbox-<branch>` entry to `.claude/launch.json` pointed at this worktree with `SCRATCHBOX_PIPELINE_I_REFINE=1` set, matching the `scratchbox-massing-review` entry added in this session.
3. `preview_start({name: "scratchbox-<branch>"})`, read the token from `preview_logs`, navigate to `http://127.0.0.1:<port>/?token=<token>`.
4. In the chat, send: *"Build a procedural 3D building of the E.V. Haughwout Building, 488-492 Broadway, New York: isolate it from the scan and rebuild it with the staged-location pipeline, facades read from a survey of the photo tiles."*
5. Once finished, run `python3 .claude/skills/watch-staged-build/scripts/staged_run_report.py <run-id>` and inspect `.scratchbox/cache/staged_location/runs/<run-id>/footprint_lock_massing_layer.json` and `pipeline_i_refine.json`.

---

## 6. Baseline Comparison

Against `.claude/skills/watch-staged-build/references/haughwout_baseline.json` (pipeline G, 2026-10-23):

| Measure | Baseline (G, 2026-10-23) | This run (I+H, 2026-10-24) | Verdict |
| :--- | :--- | :--- | :--- |
| Massing check passed | True | True (IoU 0.88 vs 0.885) | met |
| Degraded stages | 0 | 1 (`footprint_breach`, new check) | **below** |
| Wall plates read | 2 of 6 | 2 of 6 (faces 2 & 3) | met |
| Grammar-layer triangles | 38,142 | 47,638 (different pipeline — Trellis mesh, not directly comparable) | n/a |
| Finish time | 346 s | 366 s | roughly met |

**Verdict: the massing pipeline itself is working — footprint IoU and wall-plate coverage both match the benchmark — but the newly added footprint-lock gate surfaced one real, visually-confirmed geometry defect (a facade bulging up to 5 m past the locked footprint on the vector-massing layer) that the old benchmark run had no equivalent check to catch.** This is new-tool value (a real bug it found), not new-tool regression, but the bulge itself should be fixed or re-fitted rather than committed "as built."

---

## 7. Fix Verified (2026-10-24, same session)

The breach was traced and fixed rather than left open:

* **Root cause.** `checkFootprintLock` (`orchestrator.ts`, called from the `remesh` and `grammar` stages) only ever *measured* the breach (`footprintConformance`) and recorded a `footprint_breach` degradation — there was no code path that corrected the geometry. `footprint-regularize.ts` (the file named in the original review as a candidate fix) turned out to be a *shape-cleanup* tool only (straightens a noisy footprint ring's angles) with zero callers anywhere in the codebase — it has no notion of "outside the footprint" and can't clip or pull in a mesh, so it was not usable as-is.
* **The fix** (`footprint-lock.ts`):
  - `footprintClampEdits(mesh, loops, limit)` — for every welded vertex standing more than `FOOTPRINT_MAX_PROJECTION_M` (1.5 m) outside the footprint, computes a shift that pulls it back along the line from the nearest footprint edge, to just inside the limit.
  - `clampToFootprint(clayBytes, others, loops, limit)` — applies those edits to the clay GLB and its textured twin by reusing `remesh-cleanup.ts`'s proven `weldGlb` / `applyRemeshEdits` GLB parse-patch-reserialize path (the same machinery the existing scan-smoothing clamp uses), rather than inventing new GLB plumbing. Stamps its own `asset.extras.sbFootprintLockClamp` tag so the correction is distinguishable from an unrelated remesh-cleanup pass (`remesh-cleanup.ts`'s `applyRemeshEdits` gained an optional `extras` override for this).
  - `orchestrator.ts`'s `checkFootprintLock` now re-fits in place at the `remesh` stage (`opts.clamp: true`) before re-measuring conformance, and only still records `footprint_breach` if vertices remain outside after the pull-back. The `grammar` (pipeline G/H) call site is unchanged — the fix is scoped to the remesh/massing layer, as asked.
* **A real bug found during verification, not just the original one:** the first pass pulled vertices to *exactly* 1.5 m out. Float32 GLB storage rounded roughly half of those a hair back over the limit, so a live re-run (`9839f3f4`'s first attempt, before this second fix) still showed `ok:false` (`beyondLimit` dropped from 931 to 449, `maxOutsideM` stuck at exactly 1.5). Added `FOOTPRINT_CLAMP_MARGIN_M = 0.01` so clamped vertices land 1 cm inside the limit, safely past float32 rounding.
* **Tests added** (`footprint-lock.test.ts`): a direct unit test on `footprintClampEdits` (on-footprint and short-projection vertices untouched; a 3 m breach pulled to just inside 1.5 m) and a full GLB round-trip test via `clampToFootprint` (breached clay + textured twin both corrected, `footprintConformance` passes after, a no-op input returns unchanged bytes). All 15 tests across `footprint-lock.test.ts` / `remesh-cleanup.test.ts` / `footprint-regularize.test.ts` pass; `tsc --noEmit` clean.
* **Live re-verification** — same build, same instance pattern, restarted to pick up the code change, driven through a fresh chat (not a cached session) to avoid the earlier cross-session run-mixup:

  | Measure | Run `88eae258` (before fix) | Run `9839f3f4` (after fix) |
  | :--- | :--- | :--- |
  | `footprint_lock_massing_layer.json` | `ok:false`, `beyondLimit:931`, `maxOutsideM:5.04` | **`ok:true`, `beyondLimit:0`** |
  | Finish status | `degraded` (1 degradation: `footprint_breach`) | **`committed`** (0 degradations) |
  | Massing check | IoU 0.88, `ok:true` | IoU 0.88, `ok:true` (unchanged, as expected) |
  | Grammar-layer triangles | 47,638 | 47,459 (same order, different Trellis seed draw) |
  | Visual | facade bulges in a rounded bay past the footprint (screenshot 2) | flat rectangular facade, bulge gone (screenshot 3) |

  Baseline comparison (`staged_run_report.py 9839f3f4`) now reads `degraded stages: 0 (baseline 0)` — **met**, where it previously read `BELOW`.
* **Not committed.** The fix (`footprint-lock.ts`, `remesh-cleanup.ts`, `orchestrator.ts`, `footprint-lock.test.ts`) is in the working tree, verified but uncommitted — the user did not ask for a commit this session.
