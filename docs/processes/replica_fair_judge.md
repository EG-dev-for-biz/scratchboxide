# A fair judge for the district replica: lit renders, grounded references, per-surface arms, repeats with spread

> **Status:** Implemented and run once on the current `origin/main` procedural district (Federation Square, Melbourne, the
> texture-pass layers l2m / l1g / l2r plus the revolution fits). The numbers below are that run; later waves compare against it.

* **Date:** 2026-10-22
* **Branch / worktree:** `fair-judge` (`.claude/worktrees/fair-judge`), pushed to `main`.
* **What prompted this session:** the look-dev judge's plan (WP8) found the replica scorecard unfair in three ways: the flat
  headlight hides relief of the wall's own colour (a proud pilaster is invisible), the judge only ever sees the scan (so a
  rebuild that is better than the scan can never win), and a whole-view score cannot say which treatment of a single wall
  to keep. The user's decisions of the same day fix the texture ladder: the tile photo transfer on rebuilt planes is the
  base rung for every surface, a scan-conditioned painting sits above it and is accepted per surface only when its gates
  pass, the tiling library is the last fill; search-grounded references are generated, never measurements, and are used
  for likeness checks.
* **Scope:** `scripts/replica_scorecard.ts` (flags `--light headlight|lit|both`, `--sun`, `--grounded`, `--baseline`),
  `photo-match-eval.ts` (the lit renderer), `replica-scorecard.ts` (grounded judgement, deltas with standard error),
  `surface-arm-selection.ts` + `scripts/surface_arm_eval.ts` (per-surface arms). Tests: `photo-match-eval-lit.test.ts`,
  `replica-scorecard-grounded.test.ts`, `surface-arm-selection.test.ts` (fake clients; no billed call).

## What was built

1. **Lit mode** (`renderTriangles({ lit })`, `PHOTO_MATCH_LIT`): one sun (default from the camera set's latitude, Melbourne
   azimuth 35 / elevation 55; `--sun az,el` overrides), a shadow map with cast shadows, hemispherical sky occlusion. Every
   arm, the tiles included, is lit the same way. The unit test shows a proud pilaster of the wall's own colour casts a
   measurable shadow edge (luminance step >= 10 %) that the headlight render does not have. `--light both` keeps the
   headlight block where it was in `report.json` (comparable with every earlier report) and adds `views[].lit`.
2. **Grounded-reference arm** (`--grounded`): for every view, `fetchGroundedReferences` (Gemini image models with Google
   Search) draws the real place from roughly that camera (the view phrase is read from the camera: height, bearing, field;
   no labels). Cached under `<out>/grounded/<view>/references.json` and reused. The references are shown to an extra replica
   judgement as G1..Gn after the tiles (image 0), never as scored renders, labelled `generated, search-grounded`; that
   judgement scores realism and identity too and judges the tiles render as an arm, so a rebuild can be seen to beat the scan.
3. **Repeats with spread** (`--repeats`, default 3; `--baseline <old report.json>`): every score is a mean, sd and n over
   the repeats; `report.json.deltas` holds, per view, arm and criterion, the change against the baseline, its standard error
   from both runs' spreads, and whether it is clear of the judge's noise (|delta| >= 2 se).
4. **Per-surface arm selection** (`surface-arm-selection.ts`, `scripts/surface_arm_eval.ts`): a manifest
   (`scratchbox.surface-arms/1`) names the arms (sets of GLB layers in the tile frame; one is the base, the safety net), the
   shared context (ground, streets) and the surfaces (found by node-name prefix in arms that name their parts, else by an
   oriented box, e.g. in the raw scan). For every view that sees the surface, each arm's version is rendered in place inside
   the same scene (the base with that surface removed, plus the arm's surface, plus the context), lit, and the views are
   cropped to the union of the arms' coverage. A blind judge (shuffled, repeated) scores realism, identity and errors 1-10
   against the tiles' crop and the surface's own grounded references. The rule (`decideSurfaceArm`) keeps the base unless
   another arm raises realism by >= 0.5 and >= 2 standard errors while identity does not fall by more than 0.25 and errors
   (10 = none) do not fall by more than 0.5; of the arms that pass, the most realistic wins; every verdict carries its reason
   in `selection.json`. Nothing in it knows a place, a surface kind or a pipeline.

## The baseline re-run on current main (procedural + texture pass)

RESULTS_PLACEHOLDER

## What still looks fake (looking at the sheets)

CRITIQUE_PLACEHOLDER

## How to reproduce

```
npx tsx --env-file=.env scripts/replica_scorecard.ts \
  --reference <tiles textured.glb> --structure-scan <devegetated.glb> \
  --procedural <l2m_tex.glb>,<revolutions.glb> --procedural-ground <l1g_tex.glb>,<l2r_tex.glb> \
  --out docs/screenshots/replica/<run> --light both --grounded --repeats 3 \
  --baseline docs/screenshots/replica/main-2026-10-22-texture-pass/report.json

npx tsx --env-file=.env scripts/surface_arm_eval.ts --manifest <surface-arms.json> --reference <tiles textured.glb> \
  --out docs/screenshots/replica/<run>/surfaces --grounded --repeats 3 --max-views 2
```

The layer GLBs of the current main run live in the durable store (`~/.scratchbox/assets/blobs/<sha>`; `served` rows
`federation_square_melbourne_{l2m_tex_13c1b969,l1g_tex_6711af10,l2r_tex_444a7409,revolutions_6e087529}.glb`).

## Gaps

GAPS_PLACEHOLDER
