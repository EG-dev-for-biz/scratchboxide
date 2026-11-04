# Process: A real-car agent: building manufactured cars to their published dimensions

> **Recorded:** 2026-11-04
> **Status:** Verified (live in the app: Golf GTI before / skill v1 / skill v2, and Polestar 3 with skill v2, each measured against the user's production model); the paint-colour line added after the Polestar run is unverified
> **Tags:** `operate-scratchbox` `object-build` `real-car-builder` `build-notes` `size-check` `skills`
> **Target Domain:** Gemini Agent Chat / object builds (build_3d_object_from_reference)

---

## 1. Session Context

* **What prompted this session:** the user asked for the in-app agent to be tuned for building 3D models of real,
  manufactured cars, after studying production-car models they supplied (`/Volumes/3DTESTING/car models`: Honda
  CR-V 2026, Odyssey 2026, WR-V; Kia Carnival, Seltos 2022; Polestar 3 2027; VW Golf GTI 2025, Tiguan 2025;
  Sketchfab, author geyges, Sketchfab Standard licence — studied, not copied into the repo).
* **Instance used:** web port `3470`, API port `3471`, tools port `3472` (`.claude/launch.json` entry
  `scratchbox-real-car-agent`, worktree `.claude/worktrees/real-car-agent`, branch `feat/real-car-agent`). Node 20
  (no asset store); load average about 200 throughout, so stage times are long.
* **Scope tested:** the chat agent on "Build a 3D model of a 2025 Volkswagen Golf GTI in Kings Red Metallic." three
  times (stock, skill v1, skill v2), and "Build a 3D model of a 2027 Polestar 3 in Magnesium grey." once with v2.

## 2. What Was Tested & What Worked (Verified)

* **The study.** Each model measured by script (scratch only): wheels from the tyre contact patches and a vertical
  section through each tyre (circle fit; the first fits on vertices or the bottom arc were wrong on low-poly or
  squashed tyres and were replaced), front found as the end whose bonnet is lower at its axle, glass from the
  materials. Every wheelbase came out within 1.5 % of the manufacturer's figure (CR-V 2.700, Seltos 2.610, Golf
  2.631, Tiguan 2.796, Polestar 3 2.982, Carnival 3.082 m). The ranges went into the skill's hardpoint table and the
  per-car values into `.agents/skills/real-car-builder/references/production-car-measurements.md`.
* **Before (stock agent).** It called build_3d_object_from_reference with the request alone. Result 4.42 x 1.70 x
  1.46 m (published 4.29 x 2.07 with mirrors x 1.47), wheelbase 2.55 m, tyres inside the body (outer face at
  x 0.60 m against 0.88), a slab body; 418 s, three passes.
* **Skill v1** (skill + buildNotes + size check, before the root-part rule). The agent loaded real-car-builder by
  itself, searched the web for the published figures, kept request visual and put the hardpoints in buildNotes. The
  spec reader stated every published number in its observations but attached nearly every part to a parent surface,
  so the absolute hardpoints were lost: wheelbase 2.99 m, tyres at x 0.49 m, 4.49 x 2.15 x 1.64 m.
* **Skill v2** (the builder's notes section tells the reader that a part the notes place at object coordinates is a
  root part there, overlapping its neighbours; the skill says which parts are roots and how mirroring works). Result
  2.106 x 1.461 x 4.366 m against the published 2.073 x 1.466 x 4.290 (all within 2 %), wheelbase 2.631 m
  (published 2.627; the production model 2.631), tyre radius 0.324 m (235/35 R19), overhangs 0.90 / 0.84 m (model
  0.88 / 0.78); 497 s, three passes. The reply named every estimated hardpoint and the remaining differences.
* **Second car, unchanged agent: Polestar 3 2027 in Magnesium grey.** The agent loaded the skill, searched, and
  built 2.139 x 1.645 x 4.955 m, wheelbase 2.985 m (published 2.985; the production model 2.982), tyre radius
  0.386 m (265/45 R21), overhangs 0.97 / 1.00 m (model 0.90 / 0.99); 385 s, three passes. Axle lines and roof line
  fall on the production model's.
* **Tests.** `packages/core/test/object-reference-tool.test.ts` and `object-build-spec.test.ts`: 89 passed (Node
  22.18, credentials unset); instruction-tool-drift, skills-on-demand, skill-discovery-cache, skill-guide-examples
  passed; `npm run typecheck` exit 0.

## 3. What Broke / Didn't Work

* **Skill v1 lost every absolute position** (above): fixed by the root-part rule, which is sent only when buildNotes
  are given, so other object builds are unchanged.
* **Remaining shape gaps on the Golf (v2):** the glasshouse is boxier than the car (little tumblehome), the tailgate
  is more upright, the C-pillar too thin and the nose blunt; the vision check scored it 58/100. These are surface and
  section shape, which the operators can do better with more profile keys; not attempted here.
* **The Polestar paint came out too dark:** linear [0.16, 0.17, 0.18] where the production model's Magnesium is
  [0.62, 0.63, 0.64]; the reader took it off the studio-lit picture. The skill now asks for the named paint as linear
  RGB in buildNotes, with reference values; not yet rerun.
* **The agent's picture request named a Volvo detail ("Thor's Hammer" headlamps) for the Polestar 3**: a slip in the
  visual description, not a dimension.
* **Nose and tail are blunt and the plan is boxy on both cars** (the sweeps' sections stay near-rectangular to the
  ends); the plan-taper ranges are in the notes but the reader keeps few profile keys there.
* **Tool arguments are not recorded** in the session file or the result, so the buildNotes a run sent could only be
  inferred from the spec's observations.

## 4. Candidate Tool/Service Ideas

* **Record buildNotes in data.objectBuild** — the notes a build was given, beside its spec, so a run can be audited
  and rebuilt; this session had to infer them from the spec's observations.
* **A hardpoint check for object builds** — buildNotes could carry named positions (an axle line, a hub) that the
  builder measures on the built parts, as it now measures the overall size; here the wheelbase was measured by hand
  from the tyre parts' bounds.
* **A side-view comparison** — the shape comparison renders one three-quarter view, in which wheelbase and overhangs
  are hard to judge; a side view against the reference would catch them.

## 5. Reproduction Steps

1. Run the worktree with the `scratchbox-real-car-agent` entry (ports 3470-3472) and open `http://127.0.0.1:3470/`.
2. New chat: "Build a 3D model of a 2025 Volkswagen Golf GTI in Kings Red Metallic."
3. The agent loads real-car-builder, searches for the published dimensions and calls build_3d_object_from_reference
   with a short request, dimensionsHintMeters and buildNotes; read the result's size and the tyre and axle parts.
