# Pipeline K's outline in M1's placement: which stage, and how much of it is K

**Date:** 2026-11-01
**Status:** diagnosed; no K stage moves the building's outline by 2 to 5 px. Most of M1's gap comes from how placement
builds its reference. The real outline effects in K are 0.4 to 1.5 px. No code was changed.
**Places:** the Empire State Building (K run `0bb20154`), the Ferry Building (`cdbda9bb`) and the Haughwout Building
(`f4f25a8e`): the three M1 benchmark places.

## The question

M1's rerun on the fixed judge measured `placement`: the mean distance in px, at 640 px wide, from the photo's silhouette
of the target to each build's outline. K scored further from the photo than the raw scan at every place:

| Place | Raw | K |
| :--- | ---: | ---: |
| ESB | 3.64 | 5.34 |
| Ferry Building | 2.91 | 6.48 |
| Haughwout | 3.67 | 8.47 |

The task was to find the K stage that moves or trims the outline, and to fix it.

## Method (free: no judge call)

- **Inputs.** M1's four held-out views per place, with the same panos and poses. The photos were fetched again through
  the grounding API (12 images, a few cents). Each was edge-registered against the run's seam-welded tile, as
  `photo_match_evaluate` registers it.
- **Measure.** For every GLB the polish wrote (`tile_refine/<key>/polish/<key>/step_*.glb`), plus tile_refine's own
  output and the final K model:
  - each GLB is drawn alone at the metric width and labelled by `triangleRegions`;
  - its placement is read with M1's own `targetPlacement` against the scan's target. The target is every tile triangle
    on the isolate's surface (`onSurfaceFlags`).
- **Check.** This reproduces M1's numbers:
  - raw: 3.63, 2.91, 3.67 against M1's 3.64, 2.91, 3.67;
  - K: 5.34, 6.47, 8.47 against 5.34, 6.48, 8.47.

## Per stage, on M1's metric

Mean over the four views. The polish steps run in the order shown (`remesh-polish.ts` `POLISH_STEPS`). Orient, and the
twin after it, change nothing in placement.

| Place | Raw | tile_refine | Cleanup | Lattice | Base | Clip | Infill | K |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ESB | 3.63 | 4.10 | 4.10 | 4.47 | **5.34** | 5.34 | 5.34 | 5.34 |
| Ferry | 2.91 | 3.63 | 3.77 | **8.27** | 8.25 | 6.46 | 6.47 | 6.47 |
| Haughwout | 3.67 | **6.44** | 6.31 | 7.05 | 7.04 | **8.14** | 8.47 | 8.47 |

No one stage accounts for the gap at all three places. tile_refine is the first stage to worsen it everywhere: by 0.5,
0.7 and 2.8 px. After that, the base step adds most at the ESB, the lattice at the Ferry (the clip takes 1.8 px of it
back) and the clip at the Haughwout.

## Why: placement's reference is the raw isolate

The photo's "silhouette" is the photo's structural edges within 8 px of the raw scan's target outline. Each build is
drawn alone, with nothing in front of it. Three things then count against a build that is cleaner than the scan.

1. **Pieces of the isolate outside the building's footprint.** Wherever the raw outline runs, its photo edges count as
   silhouette. K clips these pieces to the footprint (§4).
   - **Ferry:** the isolate holds ragged fragments of the clock tower. The lattice fills them, so the outline loses the
     fragments' edges (8.27). The clip then removes them (6.46).
   - **Haughwout:** the isolate wraps a slice of the next building on Broome St: its upper bay and the cornice over its
     storefront. tile_refine's flattened walls reach further into it (6.44). K's footprint clip removes it (8.14).
2. **Holes in the scan.** A hole's border is outline too, so photo edges inside the building count as silhouette.
   - When K fills a hole, its border goes, and so does the photo edge it matched. The infill's +0.33 px at the
     Haughwout is this.
3. **No street in front.** The base skirt (`base-cleanup.ts`) runs from one ground height for the whole building: the
   median of the ground ring, 0.33 m at the ESB.
   - The ESB's ground varies from -0.14 to 1.00 m along its footprint. So 14 of the skirt's 43 quads reach 0.5 to
     0.64 m below the real sidewalk.
   - Below the street, nothing hides the skirt in a drawing of the build alone. The photo shows the storefront meeting
     the sidewalk higher up.
   - Drawn behind the tile's street (its ground triangles as an occluder), the base step's +0.87 px at the ESB goes to
     zero.

**Corrected.** A test reference avoids all three:

- the scan's target restricted to the footprint the run used, plus 0.3 m (`raw_fp`);
- outlines with their holes filled;
- every arm drawn behind the tile's street.

Against it the gap is:

| Place | Raw in footprint | K | K minus raw | Raw, unrestricted |
| :--- | ---: | ---: | ---: | ---: |
| ESB | 3.57 | 4.05 | +0.48 | 3.59 |
| Ferry | 3.04 | 4.59 | +1.55 | 5.96 |
| Haughwout | 3.71 | 4.13 | +0.42 | 6.63 |

M1's mean gap of +3.36 px becomes +0.82 px. Against the footprint, K's outline is closer to the photo than the
unrestricted raw scan's at the Ferry and the Haughwout.

| Correction | ESB raw → K | Ferry raw → K | Haughwout raw → K |
| :--- | :--- | :--- | :--- |
| none (M1) | 3.63 → 5.34 | 2.91 → 6.47 | 3.67 → 8.47 |
| street in front | 3.57 → 3.97 | 2.90 → 6.48 | 3.67 → 8.47 |
| footprint reference | 3.56 → 5.41 | 3.03 → 3.52 | 3.69 → 6.52 |
| footprint, holes filled | 3.52 → 6.27 | 3.04 → 4.58 | 3.70 → 4.13 |
| all three | 3.57 → 4.05 | 3.04 → 4.59 | 3.71 → 4.13 |

## What is left that is K's own

- **ESB: the lattice, +0.44 px.** At the podium's corner (v0), the rebuilt wall sheet's silhouette is a staircase. The
  sheet's storey rows stand at front depths 0.8 to 1.3 m apart (64.10 to 64.90 m along the normal of
  `FacadeLattice_10038`). Each row's wall takes the median depth of its own structure cells.
  - The podium facades, about 23% of the ESB's facade area, show the same spread.
  - The tower's facades stay within 0.3 m.
  - These depths are measured, so whether they are real features (storefront frames, signs, a cornice) or something
    the median picks up needs its own look.
- **Ferry: the isolate's ragged cut end, +1.0 px of the 1.55.** The isolate ends a few metres into the recessed wing,
  past the corner pavilion. tile_refine's rectifier snaps that ragged piece into a flush slab (`relief_m9`), and the
  clip leaves part of it within the footprint. This is the "pale slab" beside the tower's base in M1's v1 and v2. The
  infill's cap there is small (the `Seal` node).
- **Ferry v0's "white spikes".** These are the base skirt, untextured, rising to "the lowest kept surface" where an
  arcade opening's sill is missing. Its tops step between 0.4 and 3.7 m from one 0.5 m sample to the next. They show
  above the street and have almost no effect on placement.

## Proposals

- **For the M1 session (`photo-match-evaluate.ts` and `targetPlacement`: not changed here).**
  - Read the photo's silhouette from the target restricted to the run's footprint, with holes filled.
  - Draw every arm behind the reference tile's street when measuring placement.
  - Each of these, measured above, removes one way the metric rewards the scan's own defects.
- **For K, if wanted (none is the 2 to 5 px):**
  - the lattice wall's per-row depth at a sheet's free side edges (the ESB podium);
  - the skirt kept out of openings, so it only closes the gap the apron left;
  - tile_refine's snapping at an isolate's ragged cut.

## Files

- **Evidence images (gitignored):** `docs/screenshots/k_outline_placement/evidence.png` (the three causes, one view
  each) and `placement_chart.png`.
- **Scratch driver:** `placement.mts`, kept in the session group's notes folder. It reproduces M1's placement per stage
  from a place folder: the tile, the isolate, the stage GLBs, the run's base note and the Street View metadata cache.
  The `REF` variants `fp`, `outer` and `street` are the corrections above.
- **Cost:** 12 grounding images, a few cents. No judge call and no build.
