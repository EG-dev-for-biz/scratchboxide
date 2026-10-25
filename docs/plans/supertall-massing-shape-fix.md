# Supertall massing shape fix — scoped plan

> Drafted 2026-10-25. Scopes the follow-up to the Pipeline I/J footprint-coverage investigation in
> [docs/processes/pipeline_i_empire_state_building_gate_rejection.md](../processes/pipeline_i_empire_state_building_gate_rejection.md)
> (§8–§10). Not implemented. This is a brief for whoever picks it up next.

## 1. The diagnosed problem, precisely

On the Empire State Building, Pipeline E/H's own massing gate rejects before Pipeline I/J is ever reached:
Google's vector massing roof is 21.45 m off the scan at the median (223 m at p90) because a single rigid prism
can't represent a stepped, setback tower — the gate is correct to reject it. That drops the build to Pipeline
I/J, which asks Trellis to generate the whole structure from a 4-view character sheet. The live rerun (§10 of
the ESB doc) confirms this works but has a low ceiling: plan IoU only reached 0.19 (19% footprint coverage)
after fixing the registration math's scale-search bug (§8–§9), because a 3,510-triangle generated mesh is too
simple to carry the real building's setback tiers — no amount of correct scaling fixes a shape that was never
generated. **The bottleneck is shape fidelity of the generated massing, not registration.**

## 2. Three candidate directions, and why one is favored

**A. Keep iterating `register.ts`.** Already tried (§9) — real, verified improvement (0.16→0.19), but the
unit test proved the ceiling: pure scale error is fixable this way, shape error isn't. Diminishing returns.
Not recommended as the next lever.

**B. Pipeline K — parts-aware generation** (already scoped: [docs/plans/pipeline-k-parts-aware-generation.md](pipeline-k-parts-aware-generation.md)).
Splits the structure into parts (e.g. tier by tier), generates each with OmniPart/Trellis, assembles with
verification. Directly targets this failure mode — step 3 of its rollout explicitly names "the tier-decomposition
case from the ESB investigation" as its first live benchmark. Still relies on a neural generator per part, so
each part inherits the same shape-fidelity risk Pipeline I/J has today, just at a smaller, more tractable scale
(a single setback tier is a much easier generation target than the whole 443 m tower). Real infra cost: a new
Fal.ai client, a new split/assemble service, `PartSpec` schema, two-level verification.

**C. Scan-led stacked-section massing** (in progress on the `massing-choice` branch/worktree, not yet on
`main`: `packages/core/src/node/3d-engine/staged-location/pipeline-e/massing-choice.ts`). `chooseMassing()`
already orders candidates simplest-first — block, then **stacked scan sections**, then lofted sections — and
picks the first that explains the scan within tolerance (`minCoverage: 0.9`, `minPrecision: 0.85`), banded by
height. A stacked-sections candidate derives its shape **directly from the scan's own height-banded footprint**,
not from a generative guess — so a stepped tower's setbacks come out structurally correct by construction,
the same way the scan's own geometry is correct. This is the measured-data-leads path AGENTS.md's believability
section prefers (§4: "real data still leads... measured and vector-modelled data set what's known"), and it
sidesteps the shape-fidelity problem entirely rather than chasing it inside a neural generator.

**Recommendation: evaluate C first, before investing further in B.** If `massing-choice`'s stacked-sections
candidate explains the Empire State Building's scan within its existing thresholds, the vector-massing gate's
*rejection* is the one-line evidence to check — Pipeline E/H would commit a correctly-tiered, measured massing
for the ESB and Pipeline I/J's generative fallback (and its shape ceiling) would never be reached at all for
this building. That is a cheaper, more reliable fix than teaching a generator to draw setbacks. Pipeline K
remains the right answer for buildings (or parts of objects) that have no scan coverage to stack from, or whose
real shape only exists in a photo — keep it scoped and ready, but sequence it second.

## 3. Scoped steps

1. **Verify C on the ESB specifically** (lowest cost, answers the recommendation's premise): run the
   `massing-choice` branch's `chooseMassing()` against the Empire State Building's existing 3D Tiles scan
   (`stg-613d47e8-l1` from the latest run, 136 leaf tiles / 198,462 triangles) with a stacked-scan-sections
   candidate. Check `coverage`/`precision`/`f` against `MASSING_CHOICE_PARAMS`. This needs no new code — it's
   exercising an existing branch against existing scan data, following `watch-staged-build`'s discipline.
2. **If it passes:** merging `massing-choice` to `main` (someone else's branch — coordinate, don't just merge
   it) becomes the real unlock for supertalls generally, not just the ESB. Re-run the Haughwout/Puck/Flatiron
   benchmark set per the H-S plan's experiment table to confirm no regressions on buildings that currently pass
   the simple-prism massing gate.
3. **If it fails** (the ESB's setbacks are too irregular even for stacked sections, or coverage/precision fall
   short): that's the concrete case Pipeline K's step 3 is already scoped for — hand off to that plan as written,
   using this exact failure (with its now-precise numbers: 0.16→0.19 IoU, 3,510-tri ceiling) as the benchmark
   Pipeline K must beat.
4. **Either way:** update §10 of the ESB doc with whichever path was taken and its result, keeping the
   investigation trail in one place rather than forking it across docs.

## 3a. Step 1 already answered (2026-10-25, same session): yes, and it's already fused

Checked the `massing-choice` worktree directly (read-only) rather than waiting on a reply, since the data was
already sitting there. It already has a cached scan-led massing run for the Empire State Building
(address 350 Fifth Avenue — same building; cache key `207e7401b51a60d7343ef3ff_scanmassing`): **12 stacked
tiers, IoU 0.92 against the scan, height error median 2.01 m / p90 34.7 m, `ok: true`.** That is the real,
measured wedding-cake shape — plotted directly from the tier polygons in
`esb_stacked_massing.svg` (sent to the user), it shows the actual stepped setbacks, not a box.

Better still: the fusion this plan's §2 recommends has **already been built and is sitting in the same
worktree**, not hypothetical — `empire_state_building_350_fifth_avenue_n_iso_massing_207e7401_pipelineg_tex.glb`
(11.4 MB, built 2026-10-24 00:27, with a full evidence trail in `public/briefs/207e7401/`: 30 survey stations,
per-face colour/relief maps, roof textures). Loaded and screenshotted it directly (a standalone three.js
viewer, `python -m http.server` on the worktree's `public/models/`, since this worktree isn't wired to any
running app instance) — **it is recognizably, correctly the Empire State Building**: wedding-cake setbacks at
the right heights, correct tower taper, the mast on top, textured facades from Pipeline G's survey/grammar
stage. Bounding box 143 x 406 x 117 m, consistent with the massing tiers' own 406 m top.

This is not Pipeline I/J's Trellis-generated geometry at all — it's `massing-choice`'s scan-led massing (shape)
run through Pipeline G's existing facade-grammar/texture stage (detail), exactly the role-split this plan's
§2 recommended, already working on the hardest benchmark case. **Conclusion: direction C is validated for the
ESB specifically, by evidence that already existed before this plan was written — it mostly needed finding,
not building.** What's left is coordination (merging `massing-choice` to `main`, confirmed owner), not research.

## 4. Decisions needed before implementation

- Who owns `massing-choice`'s merge to `main` — coordinate with that session rather than taking it over.
- Whether the massing gate's tolerance (`minCoverage`/`minPrecision`, and the vector-roof-offset threshold that
  rejects the ESB today) should move at all, or whether a stacked-sections *candidate* alone is enough to pass
  the existing thresholds without touching them — prefer the latter; AGENTS.md's gates exist for a reason and
  loosening them is a separate decision from adding a better candidate.
