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

## 8. Step 5: depth relief from the drawings (2026-11-04, night)

**Status: Needs Fix: built and labelled, but the hollows do not show.**

What was built (commits 8c004667, 8fab0ad2):
- `object_blueprint_outlines` takes `depth: true`.
  - Depth Anything V2 Small (`PanoramaDepthService`, local, about 4.5 s for the first view and 0.5 s after) reads the front and side drawings.
  - Where each drawing sinks inside its outline, relative to a masked local average, becomes a 0 to −1 grid saved with the outlines (`blueprint-depth.ts`).
  - A band as wide as the blur, just inside the outline, is left out, so the depth jump to the background is not read as a sink.
- A `fromBlueprint` part takes the grid with `reliefMeters` (at most 0.05). It moves the part's front- and side-facing surface along its normal, and the outline never moves.
- The GLB extras label it `depthRelief {meters, model, provenance: 'photo-inferred'}`.
- Tests: a synthetic depth map, the tool saving both grids, and a native slab whose side sinks 2–3 cm only where the grid says.

Live run: port 3470, the request "Build a 3D model of a 2025 Volkswagen Golf GTI in Kings Red Metallic."
- The agent passed `depth: true`. The relief came from the depth model, with grid minima of −0.99 on the side and −0.89 on the front.
- The agent built the body with `reliefMeters` 0.012 and the glasshouse with 0.010.
- The final GLB carries the photo-inferred labels.

Mean outline error against the production Golf (`golf_gti_my25_lights_on.glb`). Each row is measured against the production model, except "Build vs its blueprint", which is measured against that run's own drawing.

| Model | Side top | Side bottom | Plan half width | Front half width |
|---|---|---|---|---|
| This run's blueprint | 1.1 cm | 1.9 cm | 1.8 cm | 1.8 cm |
| Step 5 build | 3.1 cm | 6.7 cm | 2.1 cm | 2.3 cm |
| Same spec, relief removed | 3.1 cm | 6.7 cm | 2.1 cm | 2.3 cm |
| Build vs its blueprint | 2.1 cm | 4.6 cm | 2.7 cm | 1.4 cm |
| Agent's final, after its own fix pass | 1.8 cm | 2.1 cm | 1.5 cm | 1.9 cm |
| Earlier loft build | 0.8 cm | 2.1 cm | 1.3 cm | 1.3 cm |
| Earlier hollows build | 1.3 cm | 2.5 cm | 1.4 cm | 2.4 cm |

- **The relief changes no outline.** The build with it and the same spec rebuilt without it measure identically.
- **The first pass's regression is the agent's part choices, and its own fix pass recovered it** (final 1.8 / 2.1 / 1.5 / 1.9 cm, near the earlier hollows build). A side skirt reaches down near the ground, exhaust pipes stand out past the rear, and there are roof extras. The drawing was good.
- **The hollows are not visible.**
  - Vertex by vertex, at 1.0 cm the glasshouse moved at most 0.47 cm.
  - Rebuilt at the 5 cm maximum it moved at most 2.37 cm (mean 0.72 cm over the vertices that moved).
  - Renders under low grazing light, relief off and on, look the same (`docs/screenshots/golf_step5_sheet.png`, `golf_relief_onoff.png`, `golf_relief_max.png`).
- **Why:**
  - The grid is coarse and smoothed (48 × 36 front, 96 × 36 side, a blur radius of 4 % of the view).
  - A sink wider than the blur reads mostly at its rim.
  - A loft's nose has few front-facing vertices, because its last ring is the cap.
  - The real recesses that read on a car (grille, intakes, window reveals) are sharp-edged steps that a smooth field of at most 5 cm cannot draw. They need cuts (step 3) or relief curves (step 2).

Candidate next steps:
- Done (user decision, 2026-11-04): `depth: true` and `reliefMeters` are out of the skill, which now tells the agent to leave depth off; the code stays.
- If it is pursued:
  - sample the grid at the drawing's resolution in the loft, with no pooling;
  - add stations near the nose;
  - use the depth map only to place step 4's openings, not as a surface field.

## 9. Blueprint stretched to the axles (2026-11-04, night)

**Status: Verified offline; small gain. No live build was run (machine load above 300).**

What was built (commit d9d7f461):
- `object_blueprint_outlines` takes `axleZMeters` [front, rear].
- The side and plan drawings are read through a three-piece linear stretch along the length: tail to rear wheel, wheel to wheel, front wheel to nose. It puts the drawn ground contacts on the given axles, and the bumpers stay at the ends. Side-view openings map back through the same stretch.
- It is refused, with the reason, when fewer than two contacts are read or the drawn wheels are more than 12 % off the wheelbase.
- It is recorded as `outlines.lengthWarp` and labelled generated. The real-car skill passes the axles from its hardpoints.

Checked offline on the two Polestar 3 drawings already made (no new image calls), against the production model. Mean error in cm, roofline / underside / plan / front, for the two drawings:

| Read | Drawing 1 | Drawing 2 |
|---|---|---|
| As drawn (wheels at z 1.593 / −1.501) | 5.6 / 5.7 / 1.6 / 8.1 | 5.3 / 6.2 / 2.3 / 6.6 |
| Stretched to a guessed even overhang split (±1.4925) | 5.9 / 5.5 / 1.6 / 8.1 | 5.8 / 5.9 / 1.9 / 6.6 |
| Stretched to the production model's axles (1.532 / −1.439) | 5.8 / 5.0 / 1.6 / 8.1 | 5.6 / 5.3 / 2.1 / 6.6 |
| The same, scaled to the production model's height (1.662 m) | 3.8 / 4.5 / 1.6 / 4.3 | 3.4 / 4.8 / 2.1 / 3.9 |

- **The stretch works as intended.** The drawn wheels land on the axles, and with the right axles the underside improves by about 1 cm. The roofline does not improve, and with a guessed overhang split it gets about 0.4 cm worse.
- **Most of the Polestar's error is height, not length.** The published height it was scaled to (1.614 m) is 4.8 cm less than the production model's (1.662 m). With that height the roofline error falls from 5.6 to 3.8 cm and the front width from 8.1 to 4.3 cm. Which figure is right for this trim (roof rails, an antenna, a different suspension) is not settled. The drawing was not at fault there.
- The production model's axles sit 4.7 cm forward of centre (front overhang 0.904 m). The skill's median split (0.5 of the overhangs) puts them centred, so a published front overhang matters.

**Live Polestar 3 build (2026-11-04, about 17:30, ports 3480–3482, load under 100).** The request was "Build a 3D model of a 2027 Polestar 3 in Magnesium grey."
- The agent passed `axleZMeters` [1.519, −1.466], from a published front overhang of 0.931 m.
- This drawing's wheels were drawn 1.6 % too far apart. The stretch put them on the axles.
- The agent built and checked several passes, and its final follows its blueprint closely: roofline 0.6 cm, underside 0.5 cm, plan 2.1 cm, front 2.9 cm.

Mean error against the production model, in cm (sheet: `docs/screenshots/ps_axle_sheet.png`):

| Model | Roofline | Underside | Plan | Front |
|---|---|---|---|---|
| This drawing, unstretched | 5.8 | 5.6 | 3.7 | 5.2 |
| This drawing, stretched | 6.2 | 5.3 | 3.7 | 5.2 |
| The agent's final build | 6.8 | 5.7 | 1.7 | 4.2 |
| Earlier loft build | 5.3 | 6.6 | 3.6 | 6.1 |

- **Better:** the wheel arches now sit on the axles, and plan and front width improved.
- **Not better:** the roofline. It is set by the drawing's height: scaled to the published 1.614 m, it sits about 5 cm under the 1.662 m production model.
- **Next step:** settle which height is right for this trim. The stretch has done what it can on this car.
