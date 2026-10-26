# Pipeline H-S: scan-led massing, character-sheet facades, facade-to-geometry, procedural attachments

Status: research plan, 2026-10-24. Nothing built yet. Base branch: `massing-choice` (scan-led massing, not yet on main).

## The idea in one line

Keep pipeline H's **massing** (the scan leads), replace its blurry evidence with the **character sheet** (four registered, clean, consistent 4K views), read **shape** from those views (carve, bevel, emboss, amass with the four operators), then build the **attachments** (fire escapes, water tanks, plant) procedurally.

## What pipeline H does today (what we keep, what we swap)

| H step | Where | H-S |
|---|---|---|
| Structure seed, isolate, footprint lock, ledger | orchestrator, `extraction-sizing.ts`, `pipeline-h/ledger.ts` | keep |
| Massing: simplest candidate that explains the scan (block → stacked sections → lofted), `sb.massing` | `massing-choice` branch: `pipeline-e/massing-choice.ts`, `scratchbox_scan_massing.hpp` | keep; add the depth-carve plane snap (2026-10-24 test) as a cross-check, not a candidate |
| Survey stations around each face | `pipeline-g/stations.ts` | keep the placement rules; pick 4 for the sheet (2 widest faces head-on, their corner, an aerial) |
| Wall plates: stations path-traced from the **tile photos**, reprojected onto each face in metres | `pipeline-g/plates.ts` | **swap the source**: reproject the **sheet panels** (clean 4K, registered to the same cameras) instead of the blurred tile render |
| Facade reading: vision reads rows of openings, horizontal profiles, vertical members, cross-sections, colours from plate + measured relief | `pipeline-g/read.ts`, `facade-grammar.ts` (held-out checks) | keep the reader; feed it sheet plates + a **depth relief** from the panels |
| Native build: openings, face sweeps | `pipeline-g/facades.ts` → native tool | extend with bevel / emboss / amass ops (below) |
| Roof objects: residual-audit clusters → hull + fitted roof planes | `pipeline-g/roof-objects.ts` | keep as the measured skeleton of attachments; add operator programs on top |
| Ornament: vision → sweep / revolve / relief / replicate in slot charts | `ornament-vision.ts`, `ornament-expand.ts` | reuse for attachments with an attachment host chart |
| Textures: facade/roof plates, Nano Banana | `facade-texture/`, `roof-texture.ts` | the sheet panels are already clean, even-lit texture sources |

## Why the sheet should help (measured 2026-10-23/24)

- Registered: every panel stays inside the scan outline (12 / 12 panels, 3 buildings) and passes the edge QC, so panel pixels map to the massing through the station camera exactly like the tile render does.
- Clean: no melt, no baked shadows (even light), no obstructions, white background.
- Consistent: one image, so the four views agree on colour and storeys (4.5 m storey stack from lifted lines on Haughwout).
- Sharp: a 4K sheet panel is ~2750 px across a ~30 m facade ≈ 1.1 cm/px, against the tile's ~10-20 cm.

Risk: the sheet *invents* plausible detail (the uncertain Haughwout fire escape). The outline check bounds it in plan; what it draws inside the outline is `generated`/`photo-inferred`, never `measured`.

## Brainstorm: from facade imagery to the shape of the base object

Everything maps onto the four operators (AGENTS §1.5), nothing onto named element types.

1. **Carve (openings, reveals, recesses).** Openings from the reading (rows × intervals, arch rise), cut along the face normal. *Depth* of each reveal: Depth Anything V2 Small (the one supported depth model) on the panel, affine-registered to the scan depth on the wall plane (fit scale/offset where the scan is planar), giving reveal depth per opening. Fallback: the scan's own relief where it is sharp enough.
2. **Bevel (edges).** Corners, parapet and window-head edges: a chamfer/round radius estimated from the width of the shading gradient across the edge in the panel (even light makes edges read by tone, not shadow) and from depth discontinuity width. One continuous parameter per edge loop.
3. **Emboss (normal relief fields, operator 4).** Rustication, panels, coursing, spandrel recesses: a height field per face region from the registered panel depth, band-passed (remove the plane and the openings, keep 1-15 cm structure), stored as a relief field on the face chart. Masonry coursing already has a measured path (`masonry-relief-native.ts`); this generalises it to any relief.
4. **Amass (add volume).** Cornices, string courses, sills, hoods: horizontal profiles from the reader, their *cross-section* measured from the panel depth along vertical scanlines (median over the bay), swept along the face (operator 1). Piers, pilasters, columns: vertical members; a round member's r(z) profile from its silhouette width in the head-on panel → solid of revolution (operator 2), repeated at the measured bay pitch (operator 3).
5. **Massing correction.** Where the registered panels and the scan agree on a step the massing lacks (setback, light court, bay), feed it back as a massing constraint; where only the sheet shows it, label it generated and keep it inside the footprint.

## Brainstorm: extraneous components (attachments)

Attachments are found, measured and built without a category list:

- **Find:** (a) the scan's residual clusters (residual audit) on the roof and against walls; (b) the sheet: regions the vision model marks as standing off the wall or roof, masked with `vfx_segment_subject` (open-vocabulary; the description is a prompt, never a code branch); (c) lifted lines (cross-view agreement) place them metrically.
- **Measure:** footprint/hull and height from the scan where it sees them (tanks: yes; thin lattices: barely); otherwise from the registered panels: bbox reprojected onto the face plane gives width, height and standoff.
- **Program:** the vision model returns an operator program (the ornament v2 format: sweep, revolve, relief, replicate) in the attachment's own chart, e.g. a raised cylindrical vessel = revolve (staves via replicate, hoops via sweep) on legs (sweeps) with bracing (replicate); a stepped wall lattice = replicate of platforms at the storey pitch + sweeps for rails and ladders. These descriptions are examples of what the operators produce, not types in code.
- **Build:** native operators, at a pitch snapped to the measured storey/bay grid, so a lattice lines up with the windows it serves.
- **Label:** fitted-to-scan parts `measured`/`photo-inferred`; sheet-only parts `generated`, with the reason.

## Experiments (in order; each gates the next)

| # | Test | Buildings | Pass bar |
|---|---|---|---|
| E1 | Sheet → plates: reproject sheet panels onto massing faces (plates.ts machinery, panel as source); run the existing reader on old vs new plates | Haughwout, Puck, Cooper Union | reading "explained" share and held-out chamfer better than tile plates on ≥ 2 of 3; no opening outside the face |
| E2 | Panel depth: Depth Anything V2 on panels, affine-fit to scan depth on planar wall areas | same | residual ≤ 5 cm on planar areas; cornice projection within 25 % of the scan's where the scan sees it |
| E3 | Facade to geometry: carve + bevel + emboss + amass on the scan-led massing | Haughwout first | Haughwout benchmark held (no degradations, ≥ 116k v); photo-match realism up, identity not down; reprojected silhouette IoU vs panels ≥ the current H build |
| E4 | Attachments: tank (scan cluster + panel) and wall lattice (panel only) | Haughwout tank, Puck tank, a building with a visible wall lattice | reprojection IoU vs the segmented panel region ≥ 0.7; tank radius/height within 10 % of the scan cluster |
| E5 | End-to-end H-S vs H with `watch-staged-build` | 3 buildings | H-S ≥ H on every benchmark measure; time within H's budget |

Each experiment runs first as a scratch harness on the shipped code (like the sheet tests), then only what passes becomes code.

## Decisions needed from you

1. **Attachments outside the footprint.** A wall lattice stands ~1.5 m outside the facade plane; the 2026-10-23 rule says nothing is added past the footprint "except features the data itself shows". Allow attachments the *sheet* shows outside the footprint (labelled generated), or only those the scan also sees?
2. **Base branch.** H-S needs the scan-led massing on `massing-choice` (not on main). Build on that branch, or merge it first?
3. **Replace or fuse plates.** Sheet plates instead of tile plates, or both with the reader seeing both (more tokens, more evidence)?
