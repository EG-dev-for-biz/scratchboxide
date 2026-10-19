# Staged Location Builds — Fitting Ordinary Buildings (footprint prior, party walls, tile seams, the no-fit Street View rung)

**Date:** 2026-10-18 · **Target:** `scan_fit` and the staged build (`google_3d_tiles_get_clay`, `isolate: true`) · **Status:** Needs Fix (the fit is still rejected on all three buildings; the measured cause is below)

## What was measured (isolates of Puck, St. Mark's, Haughwout; offline fits on the live inputs, then the app)
1. **Only one tile piece was fitted.** 3D Tiles split a building at tile edges; the pieces' open borders lie 1-3 cm apart and the 1 mm weld does not join them. `load()` kept the piece under the anchor (and pieces inside its box grown 4 m): 21% of Puck's scan triangles (5,949 of 27,815), 29% of Haughwout's, 39% of St. Mark's. The arch's pieces happen to lie inside its box.
2. **The frame came from noise.** The walls' orientation mode held 11-23% of the wall area (arch: 45%); the strongest mode was 0 degrees (vertical curtains along tile seams, axis-aligned in the tile frame). The frame fell back to the plan's principal axes, and the wall votes, traced at that frame, fragmented the plan (Haughwout: 59 primitives, a 149 m² footprint against 602 m² in the vector data).
3. **Party walls counted as unobserved.** Haughwout: 396 m² of the rebuild stands against neighbours.
4. **The facades are not planar at the gates' scale.** With the walls placed on the scan (median depth offset 0.00-0.03 m), the scan's depth about the fitted walls spans an IQR of 0.40 m (Haughwout), 0.46 m (Puck), 0.73 m (St. Mark's); 20-32% of facade area lies within the 7 cm band. On the arch it is 0.03 m and 90%. That relief (storey cornices, bays, and the tile mesh's 0.65 m triangles) is what keeps `share kept as scanned`, `fit→scan rms` and `unobserved share` failing. St. Mark's roof is pitched; the fitter has only flat roof bands.

## What changed
- `scan_fit --prior-json` / `ScanFitFitRequest.prior` (the building's parts from Google vector data and its neighbours', `footprintPriorFor`): the frame follows the plan's edges; the plan is the prior plus raised scan joined to it that no neighbour claims (4 m wide or more); each run of it moves onto the wall the scan measures within 2 m (`measureWallTall`: the peak that stands up the band, with the most surface); roof levels are the scan's plateaus (k-medians); bands above the lowest follow the scan's roof within the prior's uncertainty; tile pieces meeting along a raised seam are joined; scan inside a neighbour's footprint is the neighbour's; faces against a neighbour (up to its height) are `partyWall`, labelled, and kept out of the unobserved share. Without a prior the fit is byte-identical to before.
- The no-fit rung: when no fit is accepted, Street View is fetched aimed at the structure's facades (8 m tiles) and projected onto the remeshed scan; nothing is read from it. It is kept only on 5 or more held-out views that find its edges nearer than the clay's (`street_view_set_aside` otherwise).

## Results (live app, ports 3361/3362/3363)
| Building | Fit (main → branch) | Failing gates (branch) | Street View | Held-out chamfer (tex / clay) |
|---|---|---|---|---|
| Haughwout | rejected → rejected; 2,401 → 8,175 tris; footprint 149 → 532 m² (prior 602, IoU 0.88); party walls 396 m² | kept-as-scanned 0.73, fit→scan 13.3 cm, unobserved 0.53 | 8 panos, kept | 8.21 / 8.36 px |
| Puck | rejected → rejected; 5,949 → 27,778 tris; footprint 412 → 1,793 m² (IoU 0.91); 5 roof levels; party 299 m² | coverage 0.844, kept-as-scanned 0.62, fit→scan 11.2 cm, unobserved 0.55 | 6 panos, set aside | 7.67 / 7.01 px |
| St. Mark's | rejected → rejected; 2,011 → 5,132 tris; footprint 186 → 905 m² (IoU 0.89) | kept-as-scanned 0.79, fit→scan 11.9 cm, unobserved 0.76 | 5 panos, set aside (3 scored views) | 8.23 / 8.98 px (one run: 9.52 / 8.53) |
| Washington Square Arch (replay) | accepted → accepted, identical metrics | — | 4 panos | l2 7.69 / 9.02 px both |

## Candidate Tool/Service Ideas
- A `scan_fit_diagnose` tool: tile pieces, frame share, per-wall depth spread and party-wall area for an isolate, without a build.
- Roof planes (pitched roofs) as a primitive: a band whose top is the scan's fitted roof planes.
- The facade grammar's layer supersedes the remeshed scan without being textured when it commits after the texture pass (Puck): the texture pass should take it as a late layer.
