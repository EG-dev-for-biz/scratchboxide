# Street View in pipeline E: what it was costing, why it contributed nothing, and what it's worth now

## Why this was looked at

`build_speed_benchmark.md`'s "After" section found Street View contributing 0% of texels in every benchmark run (Haughwout: tile photo 92%, palette 8%), with no facing pano found at Haughwout or Washington Square Arch, and 0% even in a shakedown run that did find Haughwout images. Street View cost 60-150 s per build. This doc tracks down why, fixes the real bug, measures what Street View is worth once it actually runs, and gives a recommendation backed by live before/after numbers.

## The root cause: a copyright-string regex

`StreetViewGroundingImageService.isGoogleCapture` only accepted `© Google`. Google's metadata endpoint started writing `© 2026 Google` (the year before the name) at some point in October 2026; every Google-captured pano has been rejected as a "user photosphere" since. Live check at the time of the fix: 299 of 299 Google panos near the Haughwout were rejected. This is the entire explanation for "no facing pano found" in the original benchmark — the panos were there, they were just all refused by a regex that didn't expect a year.

Fix (commit `50305302`): `/©\s*Google\b/i` → `/©\s*(?:\d{4}\s+)?Google\b/i`.

Two more commits on the same branch improve what happens once panos are found:
- `d3d7c03d` — one registered survey shared by both of pipeline E's Street View uses (colour-matching and enhanced-mode guidance), instead of each fetching its own views at nominal (~2 m) poses; and the ownership/occluder masks now compare against the tile mesh **minus the isolated structure's own melted scan**, instead of the full tile mesh, so the structure's own cornices and arch hoods no longer count as "something in front of itself" (IoU 0.71→0.79, 0.72→0.89, 0.43→0.89 on the same views).
- `56398a39` — a genuinely new step, `street-view-texels.ts`: once the plates are decided, each wall takes the registered, owned Street View photo where it resolves the wall at least 1.5x finer than the tile ortho, within 70° of the wall's normal, **and** its band-passed structure correlates at least 0.3 (NCC) with the wall's own existing texels at the best shift within 1 m. That agreement gate exists because a registration can be geometrically "good" (low residual) and still project the wrong thing onto the wall — a neighbour, a blank sunlit wall, a triangle of sky.

## What was actually measured, live, on the fixed code (all 3 commits)

All runs below are headless staged builds (`google_3d_tiles_get_clay`, isolate, trees) against the current branch, not simulated.

### Texel share: before (bug present) vs. after (fixed)

| Place | Before (no SV / bug present) | After (fixed, SV on) | Street View's share | Time, SV off → on |
| :--- | :--- | :--- | :--- | :--- |
| Washington Square Arch | `tile photo 7.3%, clay 92.7%` (0 registered views) | `street-view multi-view 1.6% + single-view 12.8%` = **14.4%**, tile photo 31.3%, palette 3%, clay 51.3% (16 registered views) | **0% → 14.4%** of all texels | 305 s → 550 s (+245 s) |
| Haughwout (per wall, the `street-view-texels` step's own record, not the building-wide mix) | 0 of ~15 walls qualified pre-fix | wall 1: **2%** of that wall from 1 registered photo; wall 3: **35%** of that wall from 2 agreeing photos (69,820 of 199,486 texels); every other wall rejected on resolution or the 0.3 agreement gate | **0% → up to 35% on the one wall it actually helps** | 167 s → 255-259 s (+~90-100 s) |
| Bradbury (304 S Broadway, LA) | 0 of 14 walls qualified pre-fix | **0 of 14 walls qualified post-fix too** — 12 walls failed "no registered photo resolves the wall ≥1.5x finer than the tile"; walls 11 and 12 had registered photos but failed the agreement gate (correlation 0.19 and 0.23 against a 0.3 floor: "the pose puts something else on this wall", matching the Bradbury numbers already measured when `street-view-texels.ts` was written) | **0% → 0%, correctly** — the gates are working, there just isn't a usable photo there | 328 s → 462 s (+134 s, for zero texel payoff) |

So the bug fix alone does not make Street View valuable everywhere: it makes it possible, and the quality gates then decide, correctly, that Bradbury's photos don't help while Haughwout's wall 3 and the Arch's many walls do.

### Photo-match judge: with vs. without Street View (held-out views, never used by any build)

Using the in-app `photo_match_evaluate` evaluator (4 held-out Street View views per place, 3 blind reshuffled judge runs each, `gemini-4-argon`, trees on, in-context). Arms: **A** = Street View off entirely, **B** = Street View guidance-only (the pre-`56398a39` behaviour: colour-matching/redraw guidance but no texel baking), **C** = the fixed pipeline, Street View texels on.

**Haughwout** (`judge/eval/haughwout/report.json`):

| Arm | overall | realism | identity | shape | materials | detail |
| :-- | --: | --: | --: | --: | --: | --: |
| A — no Street View | 4.44 | 4.55 | 4.56 | 4.67 | 4.78 | 4.78 |
| B — guidance only (pre-fix) | 4.22 | 3.33 | 4.89 | 4.67 | 4.11 | 3.89 |
| C — texels (after fix) | 4.00 | 3.78 | 4.33 | 4.56 | 4.33 | 4.33 |

The judge preferred **no Street View** here, on overall and realism, even with the gates working correctly and wall 3 genuinely getting 35% real photo texels. Its own notes on C: "invents storefront interior," "distorts upper window proportions." B scored worst on realism (blurred, nominal-pose photos) but best on identity (it still matched the storefront decals, just blurrily).

**Bradbury** (`judge/eval/bradbury/report.json`):

| Arm | overall | realism | identity | shape | materials | detail |
| :-- | --: | --: | --: | --: | --: | --: |
| A — no Street View | 3.08 | 3.00 | 3.42 | 3.50 | 3.08 | 3.17 |
| B — guidance only (pre-fix) | 3.00 | 3.00 | 3.25 | 3.50 | 3.25 | 3.00 |
| C — texels (after fix) | 4.00 | 3.50 | 4.50 | 4.25 | 4.33 | 3.92 |

Here C scores clearly best (+0.92 overall, +1.08 identity, +1.25 materials over A), **despite writing zero Street View texels onto any wall** (see above). The gain at Bradbury comes entirely from `d3d7c03d`'s better-registered colour-matching and enhanced-mode guidance, not from `56398a39`'s texel baking. The judge's own caveat: "even the best render is judged a weak likeness (below 5 of 10)" — small effect sizes, 4 views.

**Washington Square Arch**: no judge bake-off was run (out of time); only the texel-share measurement above exists for it.

### Time cost, summary

Street View adds roughly 90-150 s per build when it contributes something (Haughwout +90-100 s, Arch +245 s — the Arch's larger isolate and 16 registered views push it past the original 60-150 s estimate), and it still adds ~134 s at Bradbury where it ends up contributing **nothing** to the texture, because the survey, registration and per-wall agreement checks all still run before the gate says no.

## Recommendation

**Not a clean "on by default."** The fix is correct, and the two mechanisms it unlocks behave very differently:

- Direct texel baking (`56398a39`) is the right design — it is honestly gated and does real, measurable work (Haughwout wall 3: 0%→35%, correctly rejecting Bradbury) — but the one place it was judge-tested (Haughwout), it did not improve the photo-match judge's realism or overall score, and in the worst case it fabricates storefront detail that was never on any registered photo's resolved region (the judge's own complaint).
- The registration and colour-matching improvements (`d3d7c03d`) look like the real win: Bradbury's judge gain is entirely attributable to them, with zero texels baked.
- It costs real time (90-250 s) everywhere it runs, including the 0%-payoff case.

Given a mixed judge result (helps at Bradbury, hurts at Haughwout, untested at the Arch and Flatiron, on a small 4-view sample), I'd recommend:

1. **Keep `d3d7c03d`'s shared-survey and context-without-structure fixes unconditionally** — they're a straightforward correctness improvement to the existing colour/guidance path, independent of whether texel baking helps.
2. **Make `56398a39`'s direct texel baking opt-in, not on by default**, until it's judge-tested on more than one place — or tighten `MIN_AGREEMENT_NCC` well above the 0.3 floor it currently clears at (e.g. require a clear margin over the floor, not just over it) so it only fires on the strongest matches like Haughwout's wall 3, and re-test.
3. Keep paying the Street View time cost only where a build is specifically asked to privilege street-level realism — not as a blanket default — since it costs time even when, as at Bradbury's texel pass, it ends up changing nothing on the mesh.

## What this doc does not cover (left for a follow-up)

- Flatiron: not rebuilt against the fix — its facade-grammar stage was already timing out at its 420 s budget before Street View even finishes its cut-out pass (`pipeline_e_inference_failed`), a pre-existing issue unrelated to these 3 commits.
- A fourth, non-NYC place from the original brief: not attempted.
- A judge bake-off at the Arch.
- Guarded unit tests for the fixed files (`street-view-texels.test.ts`, `streetview-grounding-image.test.ts`) pass (9/9, `guarded-vitest.sh`, HOME isolated, no credentials reachable) but are necessarily synthetic/geometry-level, not a live-build check.

## Evidence

- Live build logs: `sv/{arch1,arch_nosv,haughwout3,haughwout4,haughwout_nosv,bradbury1,bradbury2,bradbury3,bradbury_nosv,bradbury_after,flatiron1}.out` and each run's `inference/inference.json` (per-wall `street-view-texels` step records), captured during this work in the session scratchpad.
- Judge bake-offs: `judge/eval/haughwout/report.json`, `judge/eval/bradbury/report.json` (+ grid images in `judge/grids/`).
- Screenshots: `test-results/screenshots/streetview_value/` — wrong nominal-pose colour view (01), pre-fix occluder/context-cut failures at Haughwout (02, 03), sparse pre-fix rectified wall (04), wall 3 before/after with real Street View texels (05), Bradbury's rejected wrong-"edges"-pose view (06), the gated wall-3/wall-1 texel diagnostics (07, 09), and the Arch's owned-view path (08).
