---
name: location-qa-gate
description: >-
  Mandatory review gate before saying a real-place 3D scene is correct or improved: check against real photos and
  references, look at clay and textured views, and report numbers. Load after any staged build or change to one,
  and whenever the user asks whether a scene looks right.
---

# Location QA gate

Never assume a build is right. Check it with numbers, then look at it.

## Procedure
1. **Against real photos:** `photo_match_evaluate` with the build's `runId` (and `baseline` when comparing two builds). It renders the build from real Street View poses it never used and scores shape, materials, detail and errors.
2. **Against references,** for anything the user cares about specifically (a landmark, a facade): `location_reference_images` for that part, from the same viewpoint.
3. **Look at the model:** `audit_3d_scene_viewport` with what the user asked for. Look once textured and once in clay (`staged_location_material_mode`); clay shows shape problems the photo hides.
4. **Report:** the scores, then the 1–3 most visible problems in plain words, then what degraded.

## Findings → meaning → next step
| Finding | Meaning | Next step |
|---|---|---|
| Shape score low, materials fine | geometry wrong (missing building, wrong height, melted edges) | tell the user which part; check `location_building_shape` for that building |
| Materials or detail low | blurry or wrong texture | say the photo-tile texture is the limit; offer `infer_surface_materials` only if the user wants generated materials |
| A shape the references contradict (round vs square tower, wrong roof) | a fit went past the evidence | say what references and scan show; don't defend the build |
| Floating or melted scraps in clay | leftover scan pieces | name where; they are a known cleanup limit |
| Vehicles or people baked in | transient removal missed them | name where |
| Scores within noise of the baseline | no real change | say "no measurable change", not "improved" |

## Rules
1. "Improved" needs a better score beyond noise **and** a visible difference. One without the other is not enough.
2. Report every remaining visible problem you saw, not just the passes.
3. A judge score is evidence, not truth: if what you see contradicts it, say both.
