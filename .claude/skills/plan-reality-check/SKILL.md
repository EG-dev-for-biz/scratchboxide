---
name: plan-reality-check
description: Review a plan, roadmap or milestone list for this repo against what the code, the build records and the other branches actually show, then against AGENTS.md's rules, and report how close it is, what it gets wrong, what it misses and what to do first. Use whenever the user shares a plan (pasted, a doc, another agent's proposal) and asks how close we are, whether it is good or what to change, and before turning any plan into milestones.
---

# Plan reality check

The shape of the review draws on gstack's `/plan-eng-review` and `/plan-ceo-review` (MIT, Garry Tan). The checks are this
repo's own, learned on 2026-10-30, when a plan's "gaps" turned out to be built already and its real gap was one it never
named.

## Why this exists

A plan written from memory describes the code as it once was. Every claim of state ("not built", "off by default",
"needs wiring", "leaves a gap") is a hypothesis until a file and line settle it.

## Step 1: list the claims

Number each claim of state and each proposed step.

## Step 2: settle each claim where it lives

- **Defaults and switches:** read the function that reads the switch, not the comment above it; comments drift. The
  staged build's switches are in `packages/core/src/node/3d-engine/staged-location/staged-switches.ts`; the node graph's
  step toggles are in `packages/core/src/common/staged-build-steps.ts`.
- **What a build mode runs:** the orchestrator's skip sets and `runner.skip(...)` reasons
  (`staged-location/orchestrator.ts`, for example `PIPELINE_K_ISOLATE_SKIPPED`) say which stages a mode leaves out.
- **"Not built":** search for the capability by what it does (water, terrain, grass, ground cover, erosion), not by the
  plan's word for it, in TypeScript and in the engine headers (`packages/core/src/native/3d-engine/include/scratchbox_*.hpp`).
- **Run notes and status strings** often say exactly what is missing, for example "not planted: SB-Veggie ... has no
  low-vegetation input yet".

Mark each claim right, wrong or partly right, with its file and line.

## Step 3: check what is actually used and in flight

- **Build records:** `.scratchbox/cache/staged_location/runs/*/stages.json` (`request.isolate`, `procedural`,
  `pipeline`), and the same under `.claude/worktrees/*/`. Count by pipeline and day. On 2026-10-30, 176 of 188 builds
  were pipeline K and none were G, H, I or J.
- **Branches and worktrees:** `git branch -a`, `git worktree list` and `git log main..<branch>` for work that overlaps
  the plan. On 2026-10-30, `feat/pipeline-kd`, K over whole districts and unmerged, had already built much of the plan's
  later milestones.
- **Recent commits** on the files the plan touches: `git log --since=<date> -- <dir>`.

## Step 4: check against the rules

Read AGENTS.md, in particular:

- section 2, supported and unsupported services: a plan that names a model or service not on the list needs a user
  decision first;
- section 1, ADA: no closed taxonomies (real tree and plant species, stored as data and chosen by measurement, are a
  user carve-out);
- section 3: forward mapping, no uninvited atmosphere, the complexity gate's exemption for measured geometry;
- section 4: the product decisions (the footprint rule's scope, believability and provenance labels, buildings win over
  trees, the current defaults);
- section 5: the tile rules (deepest-leaf LOD, atomic building integrity).

A step that breaks a rule is dropped or listed as a decision for the user, never quietly kept.

## Step 5: judge the plan

- **The real gap:** often it is joining parts that already exist in separate modes, not building new parts.
- **Order by what the viewer sees:** in a city, the street and the neighbours before distant terrain; on a hillside, the
  terrain first.
- **A test that it worked:** a benchmark that measures the plan's own goal, not an older one, run on fresh uncached
  builds (the `judge-preregister` skill).
- **A stronger version:** what the plan would be if it started from what exists.

## Step 6: report

1. A verdict in one or two sentences: how close it is, and whether it is good.
2. A table: each claim, what the code says (file:line), and right, wrong or partly right.
3. The critical problems, the most important first.
4. What to do instead: milestones in order, what can run in parallel, and each one's exit test.
5. The decisions only the user can make.

Offer to write the corrected plan to `docs/research/<date>-<slug>-plan.md`.
