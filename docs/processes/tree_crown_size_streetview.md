# Tree crown size checked against Street View

- **Date:** 2026-10-20
- **Domain:** Generative Canvas / staged locations / tile vegetation
- **Status:** Verified for step 1 (crown-size correction). Step 2, a cheaper near-mid level, is not done; the run stopped on a usage limit.

## Question
Rendered crowns in the Washington Square Arch district (591 trees) looked smaller and lighter than the real crowns in Street View. Do the 3D tiles underestimate crown size?

## Method
- `scripts/tree_crown_photo_check.ts` and `packages/core/src/node/3d-engine/staged-location/tree-crown-photo-check.ts` do the measuring.
- They fetch Street View panoramas around the park through the Maps Imagery Grounding API and register each one against the tiles.
- Each planted crown ellipsoid (`sbTree.crown`) is projected into the photos.
- A vision call at LOW thinking reads the real crown's box, which is then lifted onto the stem plane.
- The output is a crown correction per tree, `scratchbox.crown-correction/1` (`widthScale`, `crownBaseRatio`, `source`).

## Findings
- **Readings:** 33, covering 30 trees.
- **Width ratio, real crown over tile-measured crown:**

  | p10 | p25 | Median | p75 | p90 |
  |---|---|---|---|---|
  | 0.70 | 1.01 | **1.33** | 1.64 | 2.0 |

  Four trees hit the 2.0 cap.
- **Crown base**, as a share of height: median 0.14 (range 0.08–0.36).
- **Why the tiles underestimate width:** they see crowns from above. Where neighbouring canopies touch, the split between crowns cuts each one short, and the underside of the canopy is never seen.

## What changed
- The native planting step (`--crown-correction`, `CrownCorrection`) scales each crown horizontally about its centre, and sets its base before the crown is grown.
- Trees read from photos use their own values. Trees not seen take the district median, which is 561 of 591 trees here.
- Each corrected tree carries `crownCorrection` in its extras, plus a provenance source labelled `photo-inferred`.
- If a corrected crown fails to regrow, it is grown as measured, and the reason is reported.
- `TileVegetationService` picks up the correction stored for the crowns by sha256, under `.scratchbox/cache/crown_correction/`. Passing `crownCorrectionPath: false` turns it off.

## Evidence
All in `test-results/screenshots/tree_crown_size/`:
- `streetview_vs_before_after_tex_clay.jpg`: the Street View photo, then before (textured and clay), then after (textured and clay). Crowns are fuller and closer to the photo after.
- `step1_crowns_before_after_{staging,mid,close,near}_{tex,clay}.png`: the same camera before and after.

## Caveats
- **Thin sample:** 30 trees, one photo each for most, and widths spread from 0.7 to 2.0. The median applied to the 561 unseen trees is an extrapolation. It is labelled as such (`source: district-median`).
- **Cost not re-measured:** wider crowns grow more leaves. The near-mid performance work, step 2, has not been done.
