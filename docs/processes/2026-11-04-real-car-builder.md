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

## 6. Shape pass (2026-11-04, afternoon)

The skill's body and cabin plan rewritten from the v2 specs: the cabin was a constant-width box (exponent 5), the
body a slab (exponent 5.5), the ends full-height walls and the C-pillar a 0.35 m panel. New cabin and side-glass
measurements from the eight models went into the reference (cabin about 0.90 / 0.77 / 0.65 W at the beltline,
halfway up the glass and 5 cm under the roof; rear pillar 0.13-0.25 m where the side glass runs past the rear axle,
0.71-0.83 m where it stops at it).

* **v3 (Golf):** cabin centred below the beltline per the first rewrite: the cabin tapered, but its section reached
  0.02 m and showed through the arches and under the sills; the C-pillar, a panel laid on the cabin, stood off it as
  a fin.
* **v4:** the cabin built like the body (its bottom at the arch tops, its top on the roofline, width 0.88 W,
  exponent 3) and the pillars as slices of the cabin. Golf: 2.088 x 1.469 x 4.360 m, wheelbase 2.631, cabin about
  0.81 W tapering to 0.62 W at the roof, C-pillar 0.65 m at the beltline, nothing through the arches; by eye no
  better than v2 (the cabin reads as one dark slab, the pillar paint too dark to show; the app check 62/100, "like
  a stretched wagon"). Polestar 3: 4.99 x 2.17 x 1.63 m, wheelbase 2.985, the paint now [0.62, 0.63, 0.64] (the
  production model's Magnesium; v2 [0.16, 0.17, 0.18]), the cabin tapering in the front view and the roof sloping
  to the tail; the nose too pointed in plan and the front bumper a block. The agent's own specJson follow-ups on
  the Polestar failed once and were still running when this was recorded.
* **Next:** a blueprint fit (orthographic views of the car scaled to its published size, silhouettes read into
  buildNotes, a side-view comparison), from the blueprint-matching method of car modelling tutorials.

## 7. Blueprint step and lofted bodies (2026-11-04, evening)

**Blueprint** (`object_blueprint_outlines`): orthographic side, top and front views drawn by the standard image model
and read into outlines at the published size. Against the user's production Golf GTI the drawn outlines are within
0.6-1.4 cm (roofline), 1.3-2.5 cm (underside), 2.3-4.6 cm (plan) and 1.4-2.7 cm (front) on average over three
drawings. The Polestar 3 drawings are worse: the side view comes out about 10 % out of proportion and the drawn
wheelbase 3.7 % long (3.094 m for 2.985), twice. A drawn ground line joined the tyres on one Golf drawing (fixed:
thin horizontal runs are removed before the background is flooded in).

**Loft** (`sweep.fromBlueprint`): the body, cabin, pillars and roof lofted through the blueprint's sections. Mean
distance from the user's production model (roofline / underside / plan / front, cm; spans off by more than 6-7 cm):

| Build | Golf GTI | Polestar 3 |
|---|---|---|
| v2 (hardpoint notes) | 3.9 / 7.9 / 5.8 / 2.6; 14 | 5.9 / 8.0 / 6.2 / 3.6; 15 |
| v4 (shape pass) | 3.6 / 7.5 / 4.8 / 2.3; 13 | 7.5 / 9.2 / 4.3 / 3.8; 17 |
| blueprint, keyed sweeps | 3.0 / 3.6 / 2.9 / 8.0; 9 | 5.7 / 5.0 / 4.0 / 5.5; 11 |
| **blueprint, lofted** | **1.1 / 2.5 / 1.4 / 1.2; 6** | 5.3 / 6.6 / 3.6 / 6.0; 14 |

The loft reproduces its blueprint faithfully, so it is exactly as good as the drawing: on the Golf it beats every
other build on every outline; on the Polestar it carries the drawing's own error. The first live loft inlined its
rings in the build script (555k characters); the engine now expands the blocks itself (parity-tested).

**Hollows plan** (from a forked session, agreed with the user): 1 inset glass under a roof band (clearTopMeters);
2 relief on lofted parts (tested natively; a groove along the car fell between ring points until the loft sampled
the rows and columns a relief asks for); 3 cuts saved in the spec (part.cuts, native boolean, creased normals,
labelled generated); 4 openings read from the drawings (vision boxes traced by the object segmenter, in metres);
5 photo-inferred depth relief: not built, because this machine's Python has no torch or transformers and the
Depth Anything V2 Small weights are not downloaded (the user's call to install).

**Steps 1-4 live** (Golf GTI, one request, the agent unaided: blueprint with openings 47 s, lofted build 450 s,
one compare-and-fix round 78 s): the agent used every step (glasshouse inset 2 cm under a roof band, pillars and roof
proud of it, 9 relief shut lines on the lofted body, cut openings at the nose, 8 openings read and all traced by the
segmenter). Against the production model: 1.7 / 2.9 / 1.6 / 2.1 cm, 5 off-spans (the loft before the hollows: 1.1 /
2.5 / 1.4 / 1.2 cm, 6), a difference within the run-to-run spread of the blueprint drawings themselves. The front view
shows the lower intake as an opening and no roof flicker. Wrong: the agent made the A-pillar a body-colour slice over
z 0.20-0.92, painting over the front side window (the skill now says A-pillars are never slices). The app's own vision
check scored it 52/100 and reported surface rippling round the windscreen and doors, not confirmed in the outline
renders. An earlier run had its drawing rejected because a drawn ground line joined the tyres (fixed). Step 5 (depth
relief) not built: no torch here.
