# Pipeline K proud audit: scan standing in front of the rebuilt facades, measured and removed

**Date:** 2026-11-07/08 · **Status:** Verified on uncached ESB and Penn 2 builds (six builds, same model readings on every side) · **Branch:** `feat/k-proud-audit` on `feat/k-glass-openings` (b54f4c3d, the cut on by default) · **Benchmark:** `/Volumes/3DTESTING/scratchbox-ide/benchmarks/2026-11-07-proud/` (`combined/sheet.jpg`, `esb-shaft-clay-sheet.jpg`, `closeups-final/esb/`)

## Ask (MAIN, 2026-11-07)

The tear audit (`facade-lattice.ts` `applyFacadeLattices`, native `scratchbox_facade_lattice.hpp` `audit`) looks only for
missing surface. On 2026-11-07 the ESB's shaft showed jagged plateaus: whole tile triangles reaching past the rebuilt cells
were kept and lay on the wall plane a quarter metre proud of the recessed bays, invisible to the tear audit and to the hole
metric. Add its mirror: a proud audit that reports the proud area per facade and in total, removes the proud scan where
the rebuilt cells cover its footprint without opening anything, in TypeScript and natively with parity, carried into the
benchmark; prove it on the ESB and Penn 2 with the cut on and off.

## What was built (d430c5f7, then the fix below)

- **The audit.** After the tear audit, each rebuilt facade is seen straight on and from the tear audit's four angled
  views. A pixel where the nearest surface is a *scan* triangle (never a rebuilt one) standing more than
  `restoreFrontM + STRUCTURE.chamferM` (0.10 m) in front of the surface the rebuild itself draws there, within the
  facade's depth band and over one of its built cells (the hit point run through `overBuilt`), is proud. The renders
  record which triangle drew each pixel (`who`), so a proud pixel names its triangle.
- **The report.** `ProudReport` (`m2` straight on, `obliqueM2` from the angles, `removedTriangles`, `restoredTriangles`,
  `afterM2`, `obliqueAfterM2`, `tolM`, `perFacade`) in the polish stats, in the run's `pipeline_k_lattice.json` (with the
  tear report and the cut's), in the run note (`describePolish`), in each rebuilt facade's `sbFacadeLattice.proud` extras
  (label measured: it is scan, measured, standing where it should not), and in the benchmark runner's result
  (`proudM2`, `proudLeftM2`, `latticeCells`, `latticeCut`, `tearsLeft`), its ledger row and the sheet's caption.
- **The removal.** A proud triangle whose whole footprint the rebuilt cells cover (facing the facade, `coveredByRebuild`)
  is claimed; the tear audit then runs again over those removals alone and puts back what they opened; if a tear straight
  on survives, every proud removal is undone. Scan the rebuild does not cover (unbuilt cells, past the outline, the end
  cells kept as scan) is never touched. `SCRATCHBOX_K_PROUD_REMOVE=0` measures only.
- **Native.** The same pass in `audit()` (SBLA protocol 3: the proud counts per facade appended), held to the TypeScript
  by `facade-lattice-native.test.ts`: a wall of two whole triangles over a facade with cells left as scan, measured the
  same, nothing removed, measure-only the same, and the same wall cut at the cells with the proud residue gone; and the
  four earlier audit cases now compare the proud report too. `facade-lattice.test.ts` adds the TypeScript cases (the
  measure and the extras; a proud triangle removed over a hole comes back and the hole stays closed).

## Found on the way

1. **A cut piece exactly on a lattice line was judged by the wrong cell.** With the cut on, pieces over built cells are
   left to `decide`'s coverage test. A piece whose vertex lies on the line between a built cell and a cell left as scan
   had that sample mapped into the unbuilt neighbour (`cellIndex` takes the next cell at an exact edge), so it read as
   not covered and stayed on the wall plane, 0.25 m proud of the recessed cell beside it. In the unit scene 4.8 of the
   16.3 m² plateau survived the cut this way. The coverage samples are now drawn in toward the triangle's centroid by
   1e-3 (`COVER_INSET`, native `kCoverInset`); the residue there is 0. This holds for every cut piece on every building.
2. **The proud removal's first form cost 0.03 points of holes** (ESB 0.67% against 0.64% measuring only). The removed
   proud pieces had been closing slits seen only from an angle, and the restore declines to put a piece back from an
   angle when it would stand in front of the rebuild (`keptInFront`). For a proud removal that is wrong: the piece stood
   there before, and the removal must open nothing. A proud removal now comes back from an angled tear too (one commit
   after d430c5f7). ESB holes 0.64%, Penn 2 1.31%.

## Results (uncached, pipeline K, this branch; the cut-on sides share one set of model readings)

| Building | side | holes | worst view | untextured | proud before → after (m², straight on) | proud from the angles | lattice tears left (oblique) | triangles | build |
|---|---|---|---|---|---|---|---|---|---|
| ESB | cut off (`SCRATCHBOX_K_LATTICE_CUT=0`) | **0.36%** | 0.79% | 0.25% | 14,340 → 10,607 | 45,660 → 33,361 | 0 (14,391) | 821,886 | 6.1 min |
| ESB | cut on, measure only | 0.64% | 0.96% | 0.52% | 5,618 → 5,618 | 21,128 | 0 (7,503) | 1,934,320 | 6.1 min |
| ESB | cut on, first removal (d430c5f7) | 0.67% | 0.99% | 0.55% | 5,618 → 2,162 | 21,128 → 9,731 | 0 (49,421) | 1,933,572 | 12.6 min |
| ESB | **cut on, removal with the angled restore (final)** | 0.64% | 0.96% | 0.55% | **5,618 → 3,143** | 21,128 → 12,746 | 0 (7,503) | 1,933,809 | 6.5 min |
| Penn 2 | cut off | **1.02%** | 2.02% | 1.48% | 4,631 → 3,078 | 15,014 → 10,298 | 0 (6,729) | 561,323 | 6.3 min |
| Penn 2 | cut on, measure only | 1.28% | 2.68% | 1.81% | 2,255 → 2,255 | 7,958 | 0 (4,740) | 1,139,778 | 5.8 min |
| Penn 2 | cut on, first removal | 1.35% | 2.75% | 1.76% | 2,255 → 1,027 | 7,958 → 4,356 | 0 (8,072) | 1,142,006 | 12.4 min |
| Penn 2 | **cut on, final** | 1.31% | 2.72% | 1.78% | **2,255 → 1,602** | 7,958 → 6,001 | 0 (4,740) | 1,139,196 | 4.2 min |

Cells: ESB 141,841 and Penn 2 104,344 on every side (the lattice is the same; only the scan around it changes). The
twelve-minute builds ran at load 200; the others at load 30 to 90. Model calls about $1.90 in all.

**The ESB shaft in clay** (`esb-shaft-clay-sheet.jpg`, the glass benchmark's `glass` and `stone` cameras on facade 39):
cut off, the top half of the shaft is flat slabs with slanted lower edges (the whole tile triangles over the recessed
bays, 14,340 m² proud); cut on and measuring only, the bays are recessed but shards run down the right pier and the
setback top (the cut's pieces on the wall plane, 5,618 m² proud); final, the piers are clean but for a few slivers on the
second pier, 3,143 m² proud left. The clay renders show geometry, not texture.

## Against the gate

- **Proud area:** the measure tracks what the eye sees (the slabs, the shards, then neither), and the final removal cuts
  it by 44% on the ESB and 29% on Penn 2 without opening a tear straight on (`tears.left` 0 on every side).
- **Holes against the branch's state before this work** (cut on, no proud audit, which the measure-only side reproduces
  to the pixel but for `COVER_INSET`): ESB 0.644% against 0.641%, Penn 2 1.306% against 1.282%. The ESB is level; Penn 2
  is 0.02 points worse, so the gate's "no worse on both" is not met and **no PR was opened**; the branch is pushed for
  MAIN to decide (the removal can ship measure-only with `SCRATCHBOX_K_PROUD_REMOVE=0` as the default, which meets the
  gate exactly).
- **Holes against the cut-off baseline** (main-era 0.36% / 0.92–1.02%): the cut itself (#182, b54f4c3d) is what lifts
  holes to 0.64% / 1.28%, on both buildings, before any proud removal: the extra hole pixels are at the backs of the
  scan's cut pieces (`relief_m*` 48,726 against 16,398 pixels on the ESB), not at the rebuilt facades. The proud audit
  now measures what the cut buys (proud scan 14,340 → 5,618 m² on the ESB) against what it costs (0.28 points of holes);
  that trade is the cut default's to decide, not this audit's. The hole regions over 5 m² are the same eight on every
  ESB side (the largest 59 m² at FacadeLattice_30, a seam the closure leaves).

## Where to read it

`<run>/pipeline_k_lattice.json` (`proud`, `tears`, `cutReport`); the polish `stats.json` `lattice.proud`; the GLB's
`FacadeLattice_<id>` nodes `extras.sbFacadeLattice.proud`; the run note's "proud audit: …" clause; benchmark
`result.json` `proudM2` / `proudLeftM2` and the sheet caption "proud scan X → Y m²".
