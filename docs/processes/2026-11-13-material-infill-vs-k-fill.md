# Material infill against pipeline K's hole fill (ESB, hold-out)

**Date:** 2026-11-13 · **Status:** Not adopted (no improvement measured) · **Branch:** `exp/material-infill`

## Question

Does filling a facade photo's holes from the material plan (each hole texel from its own element: a sibling window,
the wall a bay or a storey away, else the material's exemplar; `material-infill.ts`) beat pipeline K's fill
(`ortho-rectify.ts` `fillHoles`: the photo's repeats across and up, then the nearest real texel)?

## Method

Real data, with ground truth: the Empire State Building's straightened facade photos (tile_refine `9bffd2e1…`,
`relief_orthos_k_dd7178e1f54a7a3d`). Holes are punched into texels the photo reached, both fills run on the punched
photo, and each is compared with the real texels (CIELAB ΔE per texel, and after a 0.25 m blur). The design intent and
the material plan are inferred with the holes hidden (no window read inside a hole, the photo not valid there), so the
infill gets no knowledge of what it is filling. Driver: `.scratchbox/infill_bench.ts` (scratch, not committed).

## Results (lower is better)

| Holes | Texels | K fill | Material infill |
|---|---|---|---|
| Blocks of 4-9 m over 15 % of 8 facades, every hole texel | 1,044,828 | ΔE 11.3 (blurred 9.1) | ΔE 12.1 (blurred 9.6) |
| the same, texels inside real windows (blurred) | | 9.8 | 9.1 |
| the same, wall texels (blurred) | | 8.7 | 9.8 |
| the same, only what K's repeats leave (5,600 texels) | 5,600 | nearest 8.2 | 12.2 (a smooth fill: 15.0) |
| A 45 m full-width band on 4 tall facades, what K's repeats leave | 690,651 | nearest 8.1 | 19.0 (a smooth fill: 20.0) |

## Reading

- On small holes K's repeat fill is already element-aware in effect: the facade is periodic, so the texel one bay over
  is the same element. The infill only matches it, and its per-texel choice among sources leaves a patchwork K's does
  not.
- On a large hole K's nearest texel draws vertical streaks. On the ESB, whose facade is vertical piers and window
  columns, streaks are close to the truth in colour; they are visibly smeared (no storeys). The infill continues real
  windows through the part of the hole where the intent laid them, and lays stone where it laid none (the right half of
  `panel_2.png`): the limit is the intent inside a large hole, not the fill.
- The infill beats only the smooth fill.

## Decision

Not wired into the tool or pipeline K. Kept on `exp/material-infill` with its unit test. Worth another look only (a)
on a facade that is not vertically striped, where nearest-texel streaks are wrong in colour too, and (b) once the
intent lays windows through a hole this large.

## Candidate tool/service ideas

- A hold-out fill benchmark as a committed script (punch, fill, compare), so any fill change is measured this way.
- The same test on Penn 2 and the Flatiron once they have a current K reading.
