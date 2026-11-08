# Pipeline K: the symmetry the source data implies (step 1, detection only)

2026-11-08, branch `feat/k-symmetry` from main 17f1d2f1.

## What it does

Until now K detected translation only (window arrays, wall grammar, NCC repeats) plus a radial score per residual cluster. This step adds mirror and rotational symmetry, read and reported, nothing built from it. It is off by default: `SCRATCHBOX_K_SYMMETRY=1` or the node graph's `remesh.symmetry` turns it on.

- **Kernels:** `scratchbox_symmetry.hpp`, driver `scripts/symmetry_native.cpp`, wrapper `pipeline-k/symmetry.ts`. It runs in the remesh right after the orthos are straightened.
- **Plan:** the scan's top-down height map is split into tiers where flat roof area gathers. Each tier's outline, the whole height field and the footprint are scored against their own image under every vertical mirror through the centroid (0.5° sweep, refined to 0.05°) and every rotation by 2πk/n (n = 2..8).
  - Score: Σ min(f, f′) / Σ max(f, f′). That is an IoU for an outline and a volume IoU for the height field: Podolak et al. 2006's planar reflective symmetry, restricted to vertical planes.
  - Peaks over the angle are the hypotheses, as in Mitra et al. 2006.
  - Detected at ≥ 0.9.
- **Facades:** each straightened ortho is band-passed (its 2 m mean removed) and compared with its own mirror about every vertical axis, by NCC over texels read on both sides.
  - Not read: transparent, never reached, occluded ≥ 65% (`OCCLUSION_PARAMS.minBlocked`), or smeared.
  - The axis is chosen by NCC × paired share. NCC alone picked edge axes where a few pairs correlate by chance.
  - Detected at NCC ≥ 0.55 over ≥ 50% of the read texels, and ≥ 0.2 above the median over all axes. A uniformly repeating wall matches its mirror at every half pitch, so it is reported as `periodic`, not as a mirror.
- **Twins:** each facade is carried through each detected plan symmetry. A facade standing where it lands is a candidate: same facing (cos ≥ 0.97), plane within 2 m, extents overlapping ≥ 50%.
  - The two photos are compared point for point through the transform, with a ±1 m shift search, by band-passed NCC.
  - The gate is `texture-repeat.ts` `NCC_GATE` (0.55). Xue, Wu & Li 2026 pair symmetric facades from the massing and give no NCC value, and the queued item names none, so the repo's repeat gate is used.
- **Output:** the run note `pipeline_k_symmetry` (with the sweeps), one notes line, and `asset.extras.sbSymmetry` on copies of the polished remesh (`*_sym.glb`). The twin carries the extras into the finished model.

## Results on cached builds (no model calls; native time 0.3–4.4 s per building)

| Building | Massing mirror (best) | Rotation | Tiers symmetric | Footprint | Facade mirrors | Twins accepted |
|---|---|---|---|---|---|---|
| Empire State | 29° 0.98, 119° 0.98 | 2-fold 0.97 | 7 / 7 | 0.99 ×2, 2-fold | 65 / 83 | 104 / 198 |
| Penn 2 | 29° 0.95 | none | 4 / 6 | 29° 0.99 | 8 / 35 (7 periodic) | 3 / 19 |
| Lever House | none (0.44) | none | 1 / 3 (the slab, 0.94) | none (0.57) | 0 / 17 (6 periodic) | 1 / 2 |
| 30 Rock | 29° 0.95 | none | 8 / 10 | 0.98, 0.96, 2-fold | 38 / 64 | 17 / 36 |
| Seagram | 29° 0.94 | none | 3 / 6 | 3 peaks ≥ 0.90 | 1 / 15 | 0 / 8 |
| Flatiron (control) | none (0.83) | none | 0 / 4 | none (0.87) | 8 / 14 | none (no plan symmetry) |
| Haughwout (control, uncached build b29b5497) | none (0.81) | none | 0 / 2 | none (0.84, vector) | 1 / 2 | none (no plan symmetry) |

In the tile frame, 29° runs along the cross streets and 119° along the avenues.

## Findings

- **Plan controls hold.** Flatiron (0.83) and Haughwout (0.81) stay under the 0.9 gate.
  - Lever House is asymmetric in plan as built: the slab stands at one end of an L-shaped podium. It scores 0.44, while its slab tier alone scores 0.94.
- **Seagram misses at the facade level.** Its dark bronze curtain wall gives the band-pass almost no texture (NCC 0.3–0.5), so its real front mirror is not confirmed. That is a limit of the data, not a false negative of the measure.
  - Its scan-outline footprint shows two extra peaks at 0.90–0.91, from the bustle and plaza outline.
- **Flatiron's long walls are mirror-symmetric** (NCC 0.62–0.81 at the centre, ≥ 0.2 above the median). That is real: its bays are laid out symmetrically. The control for "asymmetric" is the plan.
- **The wiring was checked on the Haughwout build.** The step logged running → done in 53 ms, and its run note equals the offline reading (0.8144). `sbSymmetry` is on the remesh model and on the building's textured layer, beside `sbTexture`. The whole-scene file keeps no layer's asset extras, existing ones included.
- **Haughwout's Broadway cast-iron front is mirror-symmetric** (NCC 0.73, 1.2 m off centre), as built.
- **Where twins are found:** mostly on the setback stacks (ESB, 30 Rock). There the mirror and the 180° rotation carry each face onto its opposite.

## Proof

- **Sheet:** `k-symmetry-step1-sheet.jpg` in the session notes folder. Each building has its plan with tier outlines, footprint and axes, and four orthos, each with its axis and NCC sweep.
- **Tests:** `packages/core/test/pipeline-k-symmetry.test.ts`, synthetic shapes with known answers (a formula test).
- **Real data:** the cached benchmark builds of 2026-11-07/08 and one uncached Haughwout build on the branch with the switch on (`benchmarks/2026-11-08-symmetry`).
