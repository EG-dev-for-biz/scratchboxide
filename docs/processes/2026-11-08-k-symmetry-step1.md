# Pipeline K: the symmetry the source data implies (step 1 detection, step 2 fill and windows)

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

# Step 2: building from the symmetry (fill, reader windows, phase flags)

Accepted by MAIN after step 1. Still behind `SCRATCHBOX_K_SYMMETRY=1`. With it on, each part can be turned off: `SCRATCHBOX_K_SYMMETRY_FILL=0`, `SCRATCHBOX_K_SYMMETRY_WINDOWS=0`, or the node graph's `remesh.mirrorWindows`. The mirror never overrides what the other side measured: a read texel is never written, and a window is added only on an unread site.

- **(a) Mirror fill** (`fillFromOwnMirror`, `fillFromTwin` in `scratchbox_symmetry.hpp`; `mirrorFillOrthos` in `symmetry.ts`). It runs on clones of the straightened orthos (`relief_orthos_k_<key>_sym_<hash>`), before the nearest-repeat fill.
  - Unread texels (uncovered, or ≥ 65% occluded) are split into 4-connected regions.
  - A region is filled only when the 1 m read ring round it agrees with its own image at band-passed NCC ≥ 0.55 (≥ 40 pairs, ≥ 30% of the ring paired), and the image covers ≥ 90% of it.
  - Then the region is filled whole: copied texels first, the rest spread from them inside the region. Each channel's gain is matched to the ring (0.6–1.6).
  - The facade's own mirror goes first, then each accepted twin (plan mirror or rotation).
  - Every filled texel is `generated`. Its mask is `<image>_mirror.png`, and each facade carries `mirrorFill` (axis, NCC, regions, texels from mirror and from each twin).
  - A first version filled texel by texel and left seams 3–6× the photo's own step. Region-whole fill with gain matching (`k-symmetry-3`) cut the fill to the regions that hold, and the seams with it.
- **(b) Reader windows across the mirror** (`mirrorWindows`, after the window array). The facade reader's accepted boxes are reflected across the facade's mirror axis.
  - A reflection that meets a reader box at IoU ≥ 0.5 confirms it.
  - One that lands on a site ≥ 50% unread with no box there (overlap ≤ 0.1) adds a window, labelled `generated` with axis and NCC.
  - This is done only where the axis holds for the windows: at least half of the read mirror sites (≥ 4 seen) carry a window.
- **(c) Phase flags.** When ≥ 4 mirrored pairs are offset by a median ≥ 0.25 window widths and ≥ 0.6 m, ≥ 70% to one side, the facade is flagged `phase` (the reader's grid is shifted). When ≥ 30% of the read mirror sites miss their partner, it is flagged `halves-disagree`. Flags are reported only (`pipeline_k_mirror_windows`), never corrected.

## Step 2 results: uncached main against branch, one shared answer store

Main is 70468777 (runs `mainN`, `mainN2`). The branch is `feat/k-symmetry` 2a94264c with `SCRATCHBOX_K_SYMMETRY=1` (runs `symC`, `symC2`, and `symC3` for the ESB). Every build started at a load under 60, one at a time. Files are in `benchmarks/2026-11-08-symmetry-step2`.

| Building | Holes main → branch | Untextured | Windows | Filled m² (own / twin) | Reader confirmed / added | Flags phase / disagree | Fill-edge step before → after |
|---|---|---|---|---|---|---|---|
| Empire State | 0.68 → 0.69% | 0.60 → 0.61% | 9502 → 9190 | 68 / 70 | 4444 / 82 | 2 / 11 | 13.7 → 12.5 |
| Penn 2 | 0.96 → 0.98% | 1.14 → 1.09% | 1298 → 1168 | 304 / 707 | 604 / 1 | 1 / 1 | 9.9 → 11.5 |
| 30 Rock | 0.68 → 0.65% | 0.72 → 0.60% | 7578 → 7365 / 7946 | 47 / 209 | 4233 / 250 | 2 / 4 | 22.1 → 11.7 |
| Flatiron (control) | 0.90 → 1.00% | 3.61 → 3.98% | 963 → 879 | 49 / 0 | 460 / 10 | 0 / 1 | 14.6 → 15.6 |

- **Repeatability:** main is identical across its two runs. 30 Rock's first main run hit the 900 s tile_refine limit, and its remesh varies upstream: main's 30 Rock window counts are 7578 and 8378. The branch's runs are identical on Penn 2 and the Flatiron.
- **Window counts move** because the window fit and the reader re-read the filled photos, not because mirror windows replace measured ones.
- **Fill-edge step** is the mean luminance step across the fill boundary; the photo's own step is 5.5–7.5. The first, texel-by-texel version left 3–6× that step.
- **Dark lines in the rendered filled view** rose on ESB (0.13 → 0.31%) and Penn 2 (0.15 → 0.37%), and fell on the Flatiron (0.65 → 0.25%). Most fall at the lattice's window recesses, which differ where the window fit read the filled photo.
- **Close-ups:** 30 Rock's filled span gains a continuous window grid where main had a smeared wall. ESB looks unchanged. Penn 2's filled span shows a new diagonal edge in the lattice.
- **The Flatiron control is not unchanged.** Its plan stays asymmetric (0.83 against the 0.9 gate; Haughwout 0.81), so it gets no twins. Its walls are mirror-symmetric (real), so it gets 49 m² of own-mirror fill and 10 reader windows.
  - Ablation, holes / untextured: main 0.90 / 3.61%; windows only 0.93 / 3.61%; fill only 0.96 / 3.87%; both 1.00 / 3.98%.
  - At 1.00% the remesh hole gate (limit 1.00%) marks the build degraded.
  - The fill reshapes the lattice (37.8k → 24.7k proud cells): a small photo change moves the window fit a long way.
- **Close-up caveat:** the close-ups are rendered by the app's native path tracer from the finished twin GLBs, not taken from the app viewer.
- **Sheet:** `k-symmetry-step2-sheet.jpg` in the session notes folder.
