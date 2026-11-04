---
name: real-car-builder
description: >-
  Build a 3D model of a real, manufactured car (a named make and model, e.g. "2025 VW Golf GTI", "Kia Carnival",
  "Polestar 3") with build_3d_object_from_reference: pin down the exact generation and trim, look up its published
  dimensions, draw its orthographic blueprint (object_blueprint_outlines) and read its outlines at scale, turn them
  into hardpoints (axles, tyres, bonnet, beltline, windscreen, roof) checked against proportions measured from eight
  production-car models, hand the spec reader a car construction plan in buildNotes, and check the build against
  the blueprint. Use for any
  request to model, build or place a real production car, van, SUV or pickup, even when the user names only the model.
---

# Real Car Builder

A real car is recognised by its proportions before its details: wheelbase against length, how big the wheels are
against the body, where the bonnet, beltline and roof sit, how far back the windscreen starts. The object builder
gets these right only when it is told them. Its reference picture is drawn by an image model and is good at the
car's character and colour, but it carries no measurements, and the spec reader guesses sizes from it. This skill
supplies the measurements (published data where it exists, the ratios below where it does not) and a way of
building a car body from the builder's four operators.

The ratios come from eight production-car models measured on 2026-11-04 (Honda CR-V 2026, Odyssey 2026, WR-V; Kia
Carnival, Seltos 2022; Polestar 3 2027; VW Golf GTI 2025, Tiguan 2025): wheels found from the tyre contact patches
and a section through each tyre, glass from the materials. Every measured wheelbase was within 1.5 % of the
manufacturer's published figure. They are proportions of real cars, not a template: published numbers for the car
asked for always win over them.

## 1. Pin down the exact car

- Make, model, **generation or model year**, body style (hatch, saloon, estate, SUV, van, pickup, coupé), and trim
  when it changes the wheels or bodywork (GTI vs base Golf, Sport-L vs base Odyssey). Generations differ in every
  dimension; a facelift usually keeps the hardpoints and changes the lamps and bumpers.
- Paint: the manufacturer's colour name when the user gives one (Kings Red Metallic), else the colour they say.
- If the generation is ambiguous **and** the user cares about likeness (they named a year, a trim, or a real car
  they own), ask with ask_user_question. Otherwise take the current generation and say so.

## 2. Look up the published dimensions

Search the web (Google Search) for the manufacturer's specification sheet, else a reputable spec database. Collect,
in millimetres:

| Figure | Notes |
|---|---|
| Overall length, width, height | Width is published **without mirrors**; find the with-mirrors width too if it is given |
| Wheelbase | Most important single number |
| Front and rear track | |
| Tyre size for the trim, e.g. 235/40 R19 | Tyre diameter = rim inches x 25.4 + 2 x width x aspect/100 (235/40 R19 = 482.6 + 188 = 671 mm) |
| Ground clearance | Optional |

Never invent a published number. Where one is missing, use the ratio in section 3 and mark it **estimated** in
buildNotes. Keep the sources for the reply.

### 2b. Draw the blueprint

Car modellers work from blueprints: every line placed against side, top and front drawings at scale. Do the same:
load object_blueprint_outlines with load_tools and call it with subject (the same visual description as the build
request) and sizeMeters [width with mirrors, height, length] (the build's dimensionsHintMeters). It draws the three
orthographic views (three billed image calls), scales them to that size and returns the outlines in the build frame:
the side top and bottom line and the plan half width every few centimetres along the car, the front half width up
its height, and where the side outline touches the ground (the tyres). Keep its blueprintPath for the check.

Judge the drawing before using it:
- **Ground contacts:** the two contact centres should be one wheelbase apart (within 3 %) at about the axle positions
  of section 3. If they are not, the side drawing is wrong: call the tool once more; if it is wrong again, build
  from the published hardpoints and the ratios, and say the blueprint was not used. The contacts only check the
  drawing: the axles always go at the published wheelbase (a Golf's blueprint read 2.654 m for a published 2.627).
- **aspectError** over 0.12 on a view means its proportions were drawn wrong before scaling; trust that view's
  outline only for shape, not for heights or widths the published figures give.
- The outlines are read from generated drawings: published figures win where they disagree, and the outlines are
  labelled generated.

## 3. Derive the hardpoints

Work in metres in the builder's frame: +Y up, **+Z toward the car's front**, +X to the car's right, origin on the
ground at the middle of the car (z = 0 halfway between the bumpers). Then:

- Front bumper tip z = L/2, tail z = -L/2.
- Front axle z = L/2 - front overhang; rear axle z = front axle z - wheelbase. Without a published overhang split,
  the front overhang is 0.45-0.53 of (L - wheelbase); 0.5 is the median.
- Tyre radius R from the tyre size; hub height = R. Track from the data, else 0.85-0.88 x body width.
- With a blueprint, read the remaining heights off its side top line instead of the ratios below: the bonnet height
  at the front axle, the nose and tail heights, the windscreen's foot and where the roof starts and ends (the top
  line's flat run). Read the plan taper off the plan outline and the cabin's narrowing off the front outline. The
  ratios below then only bound them: a blueprint value far outside a range is a drawing error.

Measured ranges across the eight cars (median in brackets). H is overall height, W body width without mirrors, WB
wheelbase. Positions along the car are measured backward from the front axle.

| Hardpoint | Range (median) |
|---|---|
| Wheelbase / length | 0.56-0.61 (0.60) |
| Each overhang / length | 0.18-0.24 (0.20) |
| Tyre diameter / H | 0.41-0.50 (0.43) |
| Lowest body point between the axles (m) | 0.22-0.32 (0.25) in the models, which mostly omit the underbody; use the published ground clearance (cars about 0.13-0.18, SUVs 0.18-0.22) for the floor |
| Bonnet top height at the front axle / H | 0.65-0.69 (0.67) |
| Front bumper top / H (nose height) | 0.48-0.59 (0.56); minivans lower |
| Beltline (bottom of the side glass) / H | 0.67-0.72 (0.69) |
| Side glass height / H | 0.16-0.28 (0.22) |
| Windscreen base behind the front axle (m) | 0.0-0.35 (0.20); longer on premium, EV and rear-drive cars, near 0 on vans |
| Windscreen rake from horizontal | 23-31 deg (26); vans and EVs flatter, small SUVs steeper |
| Roof (within 6 cm of H) starts behind the front axle | 0.45-0.58 WB (0.50) |
| Roof ends behind the front axle | 0.97-1.11 WB (1.03): near the rear axle |
| Roof width / W (tumblehome) | 0.64-0.72 (0.68) |
| Plan width 15 cm in from the nose / W | 0.62-0.78 (0.75) |
| Plan width 15 cm in from the tail / W | 0.74-0.86 (0.85): tails are squarer than noses |
| Tail (top of the rear bumper/deck) / H | 0.63-0.77 (0.71) |
| Mirrors add to the width (m) | 0.12-0.54 (0.28) |
| Tyre to arch-lip gap (m) | 0.02-0.06 above the tyre on a stock car |

Each car's own values, and the cabin and side-glass measurements, are in this skill's
`references/production-car-measurements.md` (load_skill with file set to that path).

Use the low ends for long, low and sporty cars and the high ends for tall boxy ones, and read the reference picture
for which way this car leans. Body styles differ mainly in where the roof ends and how the tail drops: a hatch, SUV or
van ends the roof near the rear axle with a near-vertical tailgate (rake 50-75 deg from horizontal); a saloon drops a
rear screen to a boot deck at about 0.7 H; a coupé or fastback runs one shallow slope (15-25 deg) to the tail.

## 4. Plan the build from the four operators

There is no cutting operator, so wheel arches come from leaving gaps between body pieces, not from cutting holes.

**Coordinates, the rule that makes or breaks the build.** The hardpoints are absolute (object frame). In the
builder a child part's points are offsets from its attach point, so a child given absolute numbers lands twice as
far out: wheels a metre ahead of the car, pillars floating. So, in buildNotes, say:

- Every body mass, the glasshouse, the floor, each axle and each tyre and rim is a **root part** (no parentId) in
  absolute coordinates, overlapping its neighbours by 2-5 cm; overlapping or embedded parts count as joined, so the
  car is still one piece (expectedBodies 1).
- Only small details sitting on one surface (shut lines as relief, handles, badges, the mirror glass on its housing)
  are children, with their own points starting at [0, 0, 0] at the attach point.
- A left/right pair is built once, on the **+X side only** at its real position (a tyre at x = +track/2), with
  mirrorPlaneNormal [1, 0, 0]; the mirror makes the -X twin. Never give a mirrored part points on both sides.
- An axle is one root sweep straight across X from x = -track/2 to +track/2 at hub height and the axle's z, not
  mirrored. Each tyre: a root revolve with axisDirection [1, 0, 0], axisOrigin [track/2 - tyreWidth/2, R, axle z],
  meridian over 0..tyreWidth from the rim radius out to R and back; each rim the same with a smaller radius.

**With a blueprint, loft the masses from it.** Pass blueprintPath to build_3d_object_from_reference: the spec then
carries the outlines, and a root sweep can be lofted from them with fromBlueprint in place of control points and
profile keys, every section the drawings' own (side, plan and front at that station). Use that for every body mass
and keep the operators for the rest. In buildNotes, ask for exactly these parts (numbers filled in):

- **body**: fromBlueprint {yToMeters: beltline + 0.02, clearances: one circle per axle, zMeters the axle's z, yMeters
  the hub height R, radiusMeters R + the arch gap (0.03-0.05)}: the lower body with round wheel arches.
- **glasshouse**: fromBlueprint {yFromMeters: beltline - 0.02}, dark glass: the cabin as the drawings shape it.
- **pillars**: fromBlueprint {yFromMeters: beltline - 0.02, zFromMeters, zToMeters: the pillar's span, insetMeters:
  -0.005}, in body colour (or gloss black as the picture shows): the B-pillar and the C or D pillar spans from
  section 4's measurements. They lie on the cabin's own surface, so they cannot stand off it.
- **roof**: fromBlueprint {fromTopMeters: 0.03, zFromMeters, zToMeters: the roof span, insetMeters: -0.004}, in body
  colour, unless the picture shows a glass or black roof.
- Wheels, axles, lamps, grille, mirrors and handles as in the plan below (steps 7-9); skip its steps 1-6.

Without a blueprint, write this plan into buildNotes with the numbers filled in:

1. **Upper body** (one sweep along Z from tail to nose, closed ends, section exponent 3-3.5: a car's shoulders are
   rounded, and 5 or more reads as a slab): its top line is the bonnet, beltline and deck silhouette; its underside
   sits flat at the arch tops (2R + gap). Section width follows the plan widths. Carrier y = (top + bottom) / 2 and
   section height = top - bottom at each profile key, so both lines come out right.
2. **Front bumper, sills and rear bumper** (three sweeps along Z under the upper body, overlapping into it): front
   bumper from the nose to just ahead of the front tyre, sill between the tyres, rear bumper from just behind the
   rear tyre to the tail, each down to the ground clearance. The gaps left around the tyres are the wheel arches.
   **Ends, not walls:** over the last 0.3 m at each end, the upper body and its bumper narrow together to the plan
   width (15 cm in from the nose 0.62-0.78 W, from the tail 0.74-0.86 W, and about 0.1 W less again at the tip), the
   section exponent falls to about 2.5 at the tip so the corners round off in plan, and the tip key's height is about
   0.75 of the key before it so the face rounds in profile. Where the upper body meets a bumper, both have the same
   width and the bumper's top meets the body's underside, so no step shows at the bonnet's front edge.
3. **Arch lips** (a sweep along a half-circle carrier of radius R + gap around each axle, on the body side,
   mirrored left/right with mirrorPlaneNormal [1, 0, 0]): they round off the arch edges.
4. **Floor** (a sweep along Z, width = track - tyre width - 0.1 m, from the ground clearance up to about the hub
   height): it closes the view through the car under the arches and carries the axles.
5. **Glasshouse** (sweeps along Z from the windscreen base to the rear-glass base, cut into glass and pillar slices as in 6). Build it like the
   upper body: at each profile key its **bottom sits at the arch tops + 2 cm** (2R + gap + 0.02), its **top follows
   the roofline** (the windscreen rising from the bonnet at the windscreen base, the roof, the rear glass falling to
   its base), carrier y = (top + bottom) / 2 and section height = top - bottom. Its bottom then hides inside the upper
   body, which is wider; a glasshouse whose section reaches lower shows through the wheel arches and under the sills.
   Over the roof span give width 0.88 W and exponent 3: the section is widest near the beltline and rounds in to
   about 0.62-0.7 W just under the roof, which is how the eight cars narrow (about 0.90 W at the beltline, 0.77 W
   halfway up the glass, 0.65 W 5 cm under the roof). Toward the windscreen base and the rear-glass base the width
   narrows to the body's plan width there less 0.1 m. The windscreen covers (roof - bonnet) / tan(rake) along Z; at
   the back the rear glass is steep on a hatch, SUV or van (50-75 deg from horizontal, over 0.2-0.5 m) and long and
   shallow on a saloon or fastback (15-30 deg). Never a constant-width box with exponent 5: that is the boxy cabin.
6. **Pillars are slices of the glasshouse, never panels laid on it.** Build the glasshouse as consecutive sweeps along
   Z that share its carrier and whose section keys are identical where they meet (overlap 2 cm), alternating
   material: glass from the windscreen to the B-pillar; a body-colour (or gloss black, as the picture shows) B-pillar
   slice 0.08-0.12 m long; glass to where the side windows end; a body-colour C or D pillar slice of the measured
   length; glass for the rear window down to its base. The pillars then lie exactly on the cabin's curve. A panel
   laid on the cabin side cannot follow its lean and curve: it stands off it and pokes above the roof like a fin.
   Measured on the eight cars: the side glass starts 0.4-0.9 m behind the front axle; at the back it either runs
   0.4-0.9 m past the rear axle, leaving a slim C or D pillar of 0.13-0.25 m at the beltline (the Hondas, Kias,
   Polestar 3), or stops at the rear axle, leaving a broad C-pillar of 0.7-0.85 m (Golf, Tiguan). Read which from
   the picture and give the length. Only the A-pillars are separate thin strips (0.06-0.08 m wide) along the
   windscreen's side edges, inside the glasshouse's width. A thin body-colour roof sweep (about 0.63 W wide, 2-4 cm
   thick) caps the roof span, unless the picture shows a glass or black roof.
7. **Wheels**: per axle an axle sweep across X between the hubs, through the floor; on each end a tyre revolve about
   the X axis (meridian tracing a tyre section: tread width, rounded shoulders, sidewall down to the rim radius, about
   R minus the sidewall height = width x aspect), a rim revolve with lobeCount = the number of spokes and
   lobeDepthRatio 0.3-0.5, and a brake disc revolve behind the spokes. Mirror the left wheel to the right.
8. **Lamps and front end**: headlamp and tail-lamp sweeps following the body's corner (clear and red lenses), a grille
   opening as a dark sweep or relief, number-plate recesses as shallow reliefs.
9. **Details**: door shut lines, the bonnet and tailgate edges as relief grooves (width 0.004-0.006 m, depth
   -0.004 m) on the upper body and sills; door mirrors as sweeps at the base of the A-pillars (mirrored); door handles.

Spend the parts (at most 48) on the body masses first, then wheels and glasshouse, then lamps and details.

## 5. Materials (measured from the production models)

| Surface | Factors |
|---|---|
| Body paint | the paint's colour (linear RGB), roughness 0.3-0.45, metalness 0, clearcoat 1 |
| Side and rear glass | baseColor about [0.02, 0.03, 0.03], roughness 0.04, transmission 0.2-0.4, ior 1.5 (tinted) |
| Windscreen | as glass, transmission 0.6-0.8 (lighter tint) |
| Tyre rubber | [0.02, 0.02, 0.02], roughness 0.6-0.7, metalness 0 |
| Alloy rim | about [0.55, 0.56, 0.58], metalness 1, roughness 0.25-0.35; gloss black or two-tone rims as seen |
| Brake disc | [0.5, 0.5, 0.5], metalness 0.7-1, roughness 0.4 |
| Black trim plastic | [0.02, 0.02, 0.02], roughness 0.4-0.5 (matte) or 0.3 (gloss) |
| Chrome trim | [0.9, 0.9, 0.9], metalness 1, roughness 0.05 |
| Tail-lamp lens | [0.3, 0.02, 0.02], roughness 0.05, transmission 0.6 |
| Headlamp lens | [0.9, 0.9, 0.9], roughness 0.03, transmission 0.9 |

Give the named paint's colour in buildNotes as linear RGB, worked out from the colour itself, not read off the
picture: studio light darkens it (a Polestar Magnesium grey was read as [0.16, 0.17, 0.18]; the production model's
is [0.62, 0.63, 0.64]). Convert sRGB as (v/255)^2.2: light silver or grey about [0.55, 0.57, 0.58], mid grey
[0.2, 0.2, 0.21], black [0.01, 0.01, 0.012], white [0.8, 0.8, 0.78], a strong red [0.6, 0.01, 0.01].

## 6. Call build_3d_object_from_reference

- **request**: short and visual, what the picture should show: year, make, model, generation, body style, trim,
  colour, wheel design. No numbers (they would reach the picture prompt, not the spec).
- **blueprintPath**: the blueprint's, when section 2b drew one.
- **dimensionsHintMeters**: [width with mirrors, height, length]. Use the published with-mirrors width, else the
  body width + 0.28 m (estimated). The build is revised until it is within 3 % of this on every axis.
- **buildNotes**: the hardpoint sheet and the plan from section 4 with every number filled in, each marked
  published, blueprint or estimated, and the materials from section 5 with the paint colour. With a blueprint, add
  its notesText and say how to use it: the upper body's and the glasshouse's top lines follow the side top line
  station by station (one profile key per blueprint station over the bonnet, windscreen, roof and tail), the
  section widths follow the plan half widths (times 2), and the glasshouse's widths follow the front outline above
  the beltline. The A-pillar strips lie inside the front outline too: a strip wider than the cabin there reads as a
  fin at the windscreen's corners. Example (2025 Golf GTI; look up
  the real figures for the car asked for):

```
Car: 2025 Volkswagen Golf GTI (Mk8.5), five-door hatch (figures illustrative; take them from the spec sheet). Frame: +Z front, origin on the ground at mid-length.
Published: L 4.289, W 1.789 (2.073 with mirrors), H 1.471, wheelbase 2.627, track F 1.538 R 1.513,
tyres 225/40 R18 (diameter 0.637, R 0.319).
Hardpoints (z): nose 2.145, front axle 1.265 (overhang 0.880 estimated, half of L - WB), rear axle -1.362, tail -2.145.
Heights: ground clearance 0.14 (estimated), arch tops 0.68 (2R + 0.04), bonnet at the front axle 0.98 (0.67 H,
estimated), nose top 0.73, beltline 1.00 (0.68 H), roof 1.471 from z 0.0 to -1.35, tail top 1.00.
Windscreen base 0.20 behind the front axle (z 1.065) at y 0.98, raked 25 deg, reaching the roof at z 0.0.
Rear glass from the roof end (z -1.35) down to y 1.04 at z -1.85, a near-vertical tailgate below it to the tail.
Plan widths: 1.39 at z 2.0, 1.789 from the front axle to the rear axle, 1.52 at z -2.0. Roof width 1.20.
Plan: [the nine-part plan from the skill, with these numbers]
Materials: paint Kings Red Metallic baseColor [0.64, 0.01, 0.01] roughness 0.4 clearcoat 1; [the rest of the table].
```

## 7. Check and report

- Read the result: the built size against the hint, and the remaining differences. If the wheelbase or wheel size
  reads wrong in the render, fix the spec (axle and tyre parts) and rebuild it with specJson; that call makes no
  model or image call.
- With a blueprint, check the build against it: object_blueprint_outlines with blueprintPath and compareGlbPath set
  to the result's modelUri. It lists every span where the build's outline is off (no image call). Fix the parts that
  set those spans in the spec (the key heights and widths at those z or y), rebuild with specJson, and check again;
  stop after two rounds, and report the spans still off.
- Reply with what was built and that the shape follows the published dimensions while its surfaces and details
  come from a generated picture (materials inferred, `generated`). Name every number you estimated. It is a
  recognisable model of the car, not a manufacturer's CAD surface; say so if the user asks for exactness.
- Offer follow-ups: another colour or trim (edit the spec's materials or wheels with specJson), placing it at a
  real place (location and placement), a detail pass (object_detail_pass) for road grime or plates.
- No manufacturer logos or badges are drawn; a decal pass can add a plate or lettering the user asks for.
