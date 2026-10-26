---
name: scratchbox-core
description: >-
  Start here for any 3D scene, real place, building, object or material request. Routes the task to the right tool and
  skill, and states the standing rules every 3D build follows (real places from Google 3D Tiles, honest provenance
  labels, no invented success, verify by looking). Load before planning a 3D task.
---

# Scratchbox core

## Route the task
| The user asks for | Do | Then load |
|---|---|---|
| A real place, address, landmark or coordinates | `google_3d_tiles_get_clay` with the place as `query` | `staged-location-build` |
| One building or structure at a real place | `google_3d_tiles_get_clay` with `isolate: true` (defaults to the from-scratch native rebuild; `procedural: false` for the scan-detailed rebuild) | `staged-location-build` |
| Photo texture of a place, as downloaded | `google_3d_tiles_get_full_texture` | |
| What a real detail looks like (a dome's top, a facade, a paving) | `location_reference_images` | `staged-location-build` |
| The materials of a rebuilt district (opt-in procedural district builds only) | `infer_surface_materials` | `surface-materials` |
| "Does it look right?" / before saying a scene is better | the checks in `location-qa-gate` | `location-qa-gate` |
| Clay vs textured | `staged_location_material_mode` | |
| An imagined (not real) scene | the sb Python route | `python-3d-procedural-director` |
| Trees or plants in any scene | `botanical_synthesize_tree` or `sb.create_tree` (SB-Veggie only) | |

## Rules (each was learned the hard way)
1. **A real place is built from Google 3D Tiles at that place.** Never a synthetic slab, fake terrain or lollipop trees in a void. Why: the user wants the real place, recognisable.
2. **The default build is the right build, and it differs by scope.**
   - **District** (no `isolate`): vector data as the base, the photo-tile scan remeshed and smoothed, the photo transferred onto it. Don't ask for replacement massing, plane-only walls or library-only materials unless the user asks for that look. Why: those opt-in paths came out boxy or blank (2026-10-22).
   - **One building** (`isolate: true`): a from-scratch native rebuild. Survey views of the tile from the street and from above are read as facade programs, the geometry is built natively (openings with frames, mullions and sills, bands, piers, roof objects fitted from the scan), then painted. Pass `procedural: false` only when the user wants the older scan-detailed rebuild.
3. **Measurement decides geometry; references decide only unresolved detail.** Take a detail from `location_reference_images` only where its independent references agree and the scan does not contradict them. Why: the references are generated images and disagree on fine points.
4. **Label honestly.** Every part is `measured`, `vector-modelled`, `photo-inferred` or `generated`. Never call an estimate measured; never say a step ran when it was skipped. Read the tool result's stage list before you describe the scene.
5. **Remove transients.** Builds strip vehicles (cars, buses, trams, trains, moored boats) and patch the ground. Don't put them back.
6. **Look before you claim.** Never say a scene improved without the checks in `location-qa-gate`.
7. **Report briefly.** Say what was built, what was labelled generated or estimated, and what degraded, in plain words. No internals.
