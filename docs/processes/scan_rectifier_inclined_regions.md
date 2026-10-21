# Scan rectifier: inclined-plane regions with pitch consensus

2026-10-20 · `packages/core/src/native/3d-engine/include/scratchbox_scan_rectifier.hpp`, `scripts/run_scan_rectifier.cpp`, `packages/core/test/scan-rectifier.test.ts`

## Why

Until now a triangle joined a plane region only if it was near-vertical (`|ny| < 0.2`, a wall) or near-level (`ny > 0.985`, about 10°). Everything in between was left as scanned: pitched roofs, mansards, sloped glazing and ramps. Most of the world's houses have pitched roofs, so this was the largest gap in what the rectifier straightens.

## What changed

Up-facing triangles between the two thresholds are now a third geometric class (`cls 2`, inclined). They go through the same region loop as walls and roofs: proximity grouping with normal agreement, offset splitting, robust IRLS plane fit, bounded orientation snap, and the RMS check. The vertex snap, corner and ridge lines, seam solve and guards are unchanged and treat the new planes like any other.

Added steps, all in `buildRegions`:

1. **Admission** (`dropExplainedInclined`). Walls and level regions are snapped first. An inclined region is then dropped if more than `inclinedMaxExplainedShare` (0.5) of its area already lies on a found plane, using the same tau and support-box test as the vertex snap. This removes wall crinkle tilted past the wall threshold, and bevels the mesher melted into wall/roof corners. Real slopes stand well off both and stay. Dropped triangles stay unclaimed, exactly as before.
2. **Direction consensus.** A slope's downhill azimuth snaps (mod 90) to the nearest wall direction of its own footprint within `localOrientationRadius`, otherwise to a global family, when within `inclinedAzimuthSnapDeg` (3°).
3. **Pitch consensus.** Mean shift over the pitches of admitted slopes within `pitchConsensusRadius` (30 m), weighted by area and Gaussian distance (σ 12 m), with other footprints at `crossFootprintWeight`, using a ±4° window. A slope takes the result when it is within `pitchSnapDeg` (3°).
4. **Snap.** Direction and pitch together are tried first, then direction alone, then pitch alone. Each is accepted only within `maxSnapInducedDisplacement` (0.25 m), the bound walls already use. Inclined regions use `tauInclined` (0.4 m).

Nothing branches on what a surface is: the class comes from the normal and every target is measured from the scan. `--no-inclined-regions` restores the previous behaviour exactly, because the region order is unchanged when there are no inclined fits. New stats are under `regions`: `inclinedCandidates`, `inclinedRegions`, `inclinedArea`, `inclinedExplained`, `inclinedExplainedArea`, `inclinedAzimuthSnapped`, `pitchSnapped`, `pitchConsensusMaxChangeDeg` and `inclinedSnapRejectedInduced`.

## Time on the ESB tile

The ESB district tile (`public/tiles/scan_studio_tile_esb_77197_98526.glb`, 169,588 triangles) was run with the ESB test's arguments and `--threads 8` on a 16-core machine with load average 3–7. There were two runs each, back to back, using the unmodified CLI and then the new one.

| | before (2 runs) | after (2 runs) | added |
| :--- | :--- | :--- | :--- |
| total wall time | 11,508 / 11,492 ms | 11,564 / 11,595 ms | **+80 ms (+0.7%)** |
| `regions` stage | 434 / 467 ms | 546 / 576 ms | +111 ms |
| regions through seam stitch (all geometry stages) | 1,676 / 1,673 ms | 1,766 / 1,788 ms | +103 ms |
| `snap` stage | 22.5 / 22.8 ms | 23.7 / 23.5 ms | +1 ms |

Visibility (escape rays, street reach, rig, sight lines: about 9.5 s) still dominates, and the new step adds less than the run-to-run noise of those stages. The seam and guard stages did not grow measurably, even though more vertex groups now snap.

## What it found on the ESB tile

- 22,218 inclined candidate triangles. **1,117 inclined regions admitted (38,864 m²)**, with 459 dropped as explained (10,493 m²).
- 746 regions turned to a wall direction, 1,093 took the consensus pitch (largest change 3.0°), and 2 were refused by the induced-displacement bound.
- Snapping compared with before: +776 one-plane groups, +1,636 line groups (ridges, eaves, slope/wall edges), +513 point groups, +2,081 moved groups.
- **Most admitted area is in the coarse periphery of the extraction**, where large low-detail triangles approximate whole blocks. The largest admitted region is a 63° band that runs 122 m across two buildings at a cornice line there. The detailed centre around the ESB has only small inclined patches on setbacks. Manhattan has few true pitched roofs, so this tile shows the step is cheap and does no harm, but it does not show quality on real pitched roofs. That needs a tile of a pitched-roof district.
- Without the admission rule, the ESB facade check (plumb-and-grid facade area of the lot ≥ 0.70) fell to 0.6985 because steep patches took vertices from walls. With the rule it passes again.

Diagnostic renders (scratch, not committed) coloured walls grey, level regions blue, inclined regions orange and unclaimed surfaces dark.

## Tests

`packages/core/test/scan-rectifier.test.ts`, describe block "pitched roof halves share one pitch and face their walls". It uses a synthetic gable house rotated 17° in plan. Its roof halves are crinkled ±0.15 m, one scanned at 34° and the other at 36° and turned 1° off its wall. Everything is measured independently from the SBRX sidecar:

- Both halves become inclined regions. After the run their pitches differ by less than 0.2° (2° before), both lie between 34.4° and 35.6°, and the plane RMS at least halves.
- The twisted half faces its wall within 0.2° (more than 0.8° before).
- The ridge's height spread at least halves. Every ridge vertex lies within 6 cm of the line where the two output planes meet, which is horizontal within 0.2°.
- Displacement ≤ 0.75 m, zero flips, no collapsed kept triangles, and the ridge seam stays closed (< 1 cm).
- With `--no-inclined-regions` there are no inclined regions, and the roof keeps its RMS and pitch.
- The screenshot `test-results/screenshots/scan_rectifier_gable_displacement.png` shows input on the left and output with displacement heat on the right.

Run with credentials unreachable (`env -i PATH=… HOME=<empty dir>`). On this branch (based on `origin/main` 4c149bee) the whole file passes, 24 of 24, including the real ESB tile block. `tile-refine-proud-blocks.test.ts` passes. The core typecheck had one error, in an untouched file (`treeCrownShading.ts`), when checked on the branch this work was developed on.

## Limits

- **The 5 cm snap dead band** applies to slopes as well: a ridge or eave is only levelled to within it.
- **Shallow roofs:** below about 15° pitch, the two halves of a gable meet at less than `cornerMinAngleDeg` (30°), so no ridge line forms. Each half still snaps to its own plane.
- **Down-facing slopes** (soffits, the underside of overhangs) and **curved surfaces** (domes, drums, vaults) are still left as scanned.
- **Not yet checked in the app:** `tile_refine` uses the rectifier's defaults, so staged-location builds now include inclined regions. A staged build of a pitched-roof location is the next check.
