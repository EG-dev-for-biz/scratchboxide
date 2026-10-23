---
name: staged-location-build
description: >-
  Build and read a real-place 3D scene with google_3d_tiles_get_clay: what each stage does, how to read the result's
  stages and degradations, what to tell the user, and how to retry a failed stage. Load whenever a real place,
  building, street or district is staged, retried or explained.
---

# Staged location build

## Fast paths
- District: `google_3d_tiles_get_clay { query: "<place>", radiusMeters: 60 }` (pass `radiusMeters` only when the user gives an extent).
- One structure: add `isolate: true`. This runs the from-scratch native rebuild by default; add `procedural: false` for the older scan-detailed rebuild.
- No trees: `trees: false`, only when the user asks.
- Retry one stage after a failure: `retryRunId` + `retryStage` from the failed result.
- Clay vs textured: `staged_location_material_mode { mode: "clay" | "textured" }`. Textured is the default.

## What the stages do (in order)
| Stage | Does | If it degrades |
|---|---|---|
| resolve | geocodes the place | say the address it resolved |
| vector | Google footprints, shown first as massing | nothing else depends on it alone |
| tiles | the photo-tile scan at leaf detail | everything later is weaker; say so |
| vehicles | removes vehicles, patches the ground (districts) | the scan keeps them; say so. Always skipped for an isolated rebuild, by design |
| trees-measure / trees | measures crowns, regrows SB-Veggie trees (districts) | scanned trees stay. Always skipped for an isolated rebuild, by design |
| remesh | the scan remeshed and smoothed | the raw scan stays |
| grammar | district: photo-inferred facade structure on the remesh. Isolated rebuild: the whole native rebuild runs here | district: facades stay as remeshed. Isolated: falls back to the clean vector massing (clay or median-coloured); there is no remeshed fallback |
| textures | the photo transferred onto the rebuilt surfaces (districts) | the layer stays clay. Always skipped for an isolated rebuild (it paints itself), by design |
| finish | `complete` or `degraded` | list what degraded |

## Reading the result
- `status: "degraded"` is normal and honest: some stage fell back. Name the stages that degraded and why, from the result, in one line each.
- `skipped` stages were not asked for or not available. Don't describe them as done.
- Provenance labels in the result are the truth about each layer; repeat them, don't upgrade them.
- An isolated rebuild's result carries `buildingBrief.path`: a JSON beside the build with its massing, roof objects, every wall and roof face, the facades a jagged footprint was grouped into, every survey station with its saved photograph, and every plate with its reading and `readingFit` (`explains`, `weak`). Before judging or refining that building, read it with `workspace_view_file` (use the path given; don't search) and open the photos it lists with `workspace_view_image`.

## Findings → what to do
| You see | Means | Do |
|---|---|---|
| "the place could not be resolved" | no geocoding key, or an unknown place | ask for coordinates (`"lat, lng"`) or a clearer name |
| a stage `degraded` with a transient error | a model or network call failed | offer `retryRunId` + `retryStage` |
| grammar accepted few facades | most facades had no confident structure | say so; the facades are remeshed scan with photo texture |
| the user says buildings look boxy or blank | an opt-in replacement path was on | say the default path is the remeshed scan; do not switch paths yourself |
| a plate's `readingFit.weak` is set, or `readingFit.explains` is low | that wall's reading fits its own survey photo poorly; the build already re-read it once and kept the better reading | report it as the best available, not as a bug |
| a detail looks invented (an onion dome top, a cylinder for a square tower) | a fitted shape went past the evidence | check with `location_reference_images` and tell the user what the references and scan say |

## Rules
1. One build per request; don't rebuild to "try again" without a reason from the result.
2. Never supply coordinates from memory; resolve them or ask.
3. After the build, load `location-qa-gate` before you claim it looks right.
