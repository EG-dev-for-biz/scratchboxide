---
name: judge-preregister
description: Plan a photo-match comparison of build variants before running it - write down the question, the arms, the held-out views, the pass bars, decoy builds the judge must score low, the stop rules and the cost; check it with a free dry run; then run it once and report against the bars. Use before every photo_match_evaluate comparison that decides something (a milestone exit, a default or pipeline change, "which build is better", "did this change help"), and whenever a judge score is about to be quoted as proof.
---

# Judge preregistration: decide what counts before the judge speaks

The method is adapted from gstack's `/eval-plan` (MIT, Garry Tan), rewritten for Scratchbox's photo-match judge. Nothing
from gstack is installed or needed.

## Why this exists

A judge read after the fact can be made to say almost anything: keep the views that flatter the change, move the bar,
drop the arm that lost, re-run until it passes. Writing the bars and arms down first, and proving the judge can tell a
known-bad build from a good one, is what turns a score into evidence.

## The judge this repo has

`photo_match_evaluate` (`packages/core/src/node/gemini/tools/location-evidence/photo-match-evaluate.ts`, built on
`packages/core/src/node/3d-engine/staged-location/photo-match-eval.ts`):

- renders every arm from held-out real photo poses: Street View panos the build did not use (`excludePanoIds` adds ones
  the run records miss), under the same neutral light, inside the photo-textured tile (`inContext`), and again in clay
  for shape alone (`clay`);
- shows the judge the photo and the renders shuffled and unlabelled, `runs` times per view, and scores each 1-10 on
  shape, materials, detail, errors and overall, reported as mean and spread;
- adds luminance SSIM, the structural-edge chamfer and CIEDE2000 inside the building mask, and a grid image;
- compares several arms at once with `builds: [{ id, label, runId | glbs }]`; `baseline` adds the raw scan as an arm.

Judge calls per comparison: views x runs x (2 with clay, else 1), plus one more view with `includeSatelliteOrtho`. The
defaults (4 views, 3 runs, clay on) make 24 calls.

## Step 1: write the preregistration

Write `docs/processes/<date>-<question-slug>-prereg.md` (with a README row, like any process doc) before any paid call.
Every section is required; a section left empty means it is not ready.

| Section | What it holds |
|---|---|
| Question | the one decision this settles, and what each outcome makes us do |
| Arms | id, label and how each is built: the pipeline, step switches and environment; one arm is today's default |
| Places and views | the benchmark places (M1 in `docs/research/2026-10-30-hyper-realistic-real-world-plan.md`), views per place and how they are chosen; held-out panos only |
| Bars | one line per metric: name, bar, direction, mask (whole frame, building, ground, neighbours, skyline, as the judge supports them), what a miss means |
| Decoys | builds the judge must score clearly lower: how each is made and the margin it must lose by |
| Stop rules | the spend cap, a decoy that passes, a judge spread wider than the gap between arms, a render that fails |
| Exposure | panos any arm's build used (never held out) and panos earlier comparisons judged |

Save it before the paid run. A bar, arm, place or view changed after a paid call is a new preregistration that names the
old one.

### Decoys that fit 3D builds

Use at least two, chosen for what the question claims to measure:

- the raw scan or its clay at the same place (`baseline`), when the question is about detail or texture;
- the right build moved 3-5 m or turned 10 degrees, so registration must cost points;
- a neighbouring building's build put in the target's place, so identity must cost points;
- the build with its textures replaced by one flat colour, so materials must cost points;
- for whole-frame questions: the build with its ground or its neighbours removed.

If a decoy scores within the judge's spread of the arm it imitates, the judge cannot answer this question. Stop and fix
the judge or the views, not the build.

### Blinding

The judge already sees the renders shuffled and unlabelled; keep everything else blind too. Nothing the judge sees
names an arm, a pipeline letter, a file or the experiment: `place` is the address, and arm builds are made and named the
way the app makes them.

## Step 2: the free dry run

This step makes no model calls. Run the comparison under vitest with a stand-in judge client, the way
`packages/core/test/photo-match-evaluate-tool.test.ts` does (`fakeJudge`), with credentials unreachable (empty HOME,
credential variables unset; AGENTS.md section 6.3). It must show that:

- every arm and every decoy renders at every held-out pose, with no empty or black render;
- the held-out panos exclude every pano any arm's build used;
- the call count and the expected cost match the preregistration.

Look at the grid image with the `screenshot-review` skill. A render problem found here costs nothing; found after the
paid run, it costs the whole run.

## Step 3: the paid run

Build every arm fresh and uncached: clear the stage caches and restart first. Run `photo_match_evaluate` once, with all
the arms and decoys as `builds`. Do not add arms, views or places once it has started.

## Step 4: report against the bars

Write the result into the same doc: one row per bar with each arm's value and spread, each decoy's value, and met or
missed, then the decision the question named. Attach the grid image. When a decoy passed, or the spread swallowed the
difference, say so plainly: the answer is "the judge cannot tell", not "the change helped".

## Rules

- No comparison that decides something without a preregistration.
- Never re-run until it passes. A second run is a new preregistration that names the first and why it was run again.
- Tests never bill: dry runs only under vitest with credentials unreachable.
