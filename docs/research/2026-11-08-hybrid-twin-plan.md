# Hybrid twin: the procedural twin with pipeline K's detail stages (plan)

Date: 2026-11-08. Branch: `feat/measured-procedural-twin` (PR #189). Status: plan, nothing built.

## Goal

A building at pipeline K's level of detail up close and the procedural twin's cleanliness and colour at distance, from a
cold start (no cached tiles, readings, plates or K run), in about 5-7 minutes and 10-20 model calls, against K's many
minutes and 100+ calls. Decided by the photo-match judge on held-out photos, not by eye (see "Proof").

## What each side contributes

| Job | Source | Notes |
|---|---|---|
| Massing, tiers, setbacks, slender top with fins, closed shell | twin (`scratchbox_measured_twin.hpp`) | measured |
| Photometry: roof-shadow lift, seam levelling | twin (`correctedScanTexture`, K's `tile-refine-twin.ts` without the de-light curve) | photo-inferred |
| Straight wall photos at ~0.08 m | tile_refine's facade orthos (already written by the cut-out stage, `relief_orthos/`) + K's `rectifyOrtho` (native, no calls) | photo-inferred |
| Window system | K's `readBuildingSystem` | 1 vision call |
| Windows | K's `fitWindowsForOrthos`, the facade reader on one lead wall per family, siblings by `facade-reader-template.ts`, then `inferWindowArrays` | ~5-10 vision calls |
| Wall texture | the twin's storey median as the base; each wall's own straightened ortho blended over it where it is sharp and agrees with the median | photo-inferred; unique detail kept |
| Pier and bay depth | K's measured pier-to-bay depth where the scan resolves it, else the twin's (0.10 m generated) | |
| Ornament, crown | scan surface kept where it stands >= 0.3 m proud of the shell (the twin's `scanDetailM`), limited to the cells K's `KEEP_MEASURED` rule would keep | measured |
| Materials | K's library sets by colour, finish and real tile size (`material-sets.ts`), finishes read once | 1 vision call |
| Relief | image-model height maps, one per wall family, several cells on one sheet | 2-4 image calls, generated, normal map |

Skipped from K: the lattice rebuild and polish (outside closure, tear and proud audits, infill, clip), the texture stage's
de-light curve, the per-class pick by look, facade upscale, Street View evidence. The twin's shell replaces the rebuild.

## Stages and budget (cold)

| # | Stage | Time | Calls |
|---|---|---|---|
| 0 | Tiles at leaf LOD, cut-out, tree strip, seam weld (unchanged) | 2-5 min | tile requests |
| 1 | Photometry on the cut-out's texture | 15-30 s | 0 |
| 2 | Rectify tile_refine's facade orthos (native) | 10-20 s | 0 |
| 3 | Window fit on the straightened orthos | 10-20 s | 0 |
| 4 | Building system (one contact sheet) | 10-20 s | 1 |
| 5 | Facade reader on one lead wall per family; siblings by template; array | 30-60 s | 5-10 |
| 6 | Finish read; library sets | 5-10 s | 1 |
| 7 | Relief: one height map per family, cells batched | 20-40 s | 2-4 |
| 8 | Twin pass on K-format inputs: planes = rectified orthos, windows = 5, detail = median + ortho blend, scan kept at ornament cells | 45-60 s | 0 |
| | Total | ~5-8 min | ~10-16 |

All model answers are kept in the readings store by their inputs, so a rebuild costs nothing. Street View is opt-in
(registering plates cold is minutes of work); without it the base band comes from the scan.

## Work items

1. **K-lite orthos.** A function that takes a tile_refine folder and writes K's `facades.json` frames, straightened orthos
   and masks (reuse `ortho-rectify.ts` / its native kernel), without running pipeline K. The twin's own pass-1 export
   stays as the fallback when tile_refine wrote no orthos.
2. **Lead-wall reading.** `readPlanes` limited to one lead plane per family of the building system, the rest through
   `readFromTemplates` (a family's exemplars on each sibling, read in full only where the template fails); calls run 4 at
   a time.
3. **Ortho blend in the generator.** Per wall, a second texture layer: the straightened ortho at its own pixel, blended
   over the storey median where it covers the wall and its local contrast is within a factor of the median's (no smear,
   no hole); its weight and coverage reported per wall.
4. **Ornament cells.** The twin's `scanDetailM` restricted to the cells K's `KEEP_MEASURED` test marks (a step of >= 0.6 m
   between plateaus inside the cell), so the scan is kept on crowns and fins, not on photogrammetry bulges.
5. **Library materials.** The class lines from `resolveRegionSets` (colour, finish, tile size) with their maps, as the
   K-fed twin already reads them (`classMaps`).
6. **Batched relief.** Congruent walls share one cell answer; up to 4 cells per image call on one sheet, split back.
7. **Tool and node graph.** `location_measured_twin` `hybrid: true`; the node graph's stages switchable; the run note
   lists each stage's time and calls.

## Proof (preregistered before the run; the judge-preregister skill)

- Arms: hybrid, pipeline K (the 3D Building default), K-free infer twin, plus decoys the judge must score low (the clay
  massing; the twin with its windows shuffled).
- Views: the ESB benchmark's held-out Street View and aerial photos, none used by any arm's inputs.
- Measures: the photo-match judge's realism and identity; window count; triangles; wall time; model calls and cost.
- Bars: hybrid identity and realism no lower than K's; calls under 20; time under 8 minutes cold; decoys below every arm.
- Then the other cached benchmark buildings and the Penn district (real cached places only), before any default changes.

## Risks

- The facade reader's families: a family read wrong propagates to every sibling. The template's own NCC gate and the
  fall-back to a full read on failure bound it; the report counts both.
- Blending the ortho reintroduces K's smears and seams where its photo is poor: the contrast gate and the photometry
  step are there for that; measured per wall.
- Kept scan at ornament cells must meet the twin's walls without gaps: the twin's shell distance test already places it.
- MAIN judges integration (class 1/2/3) from the real-data evidence; nothing here changes K or its defaults.

## Finding, 2026-11-12: the scan holds no bay-scale relief at the ESB (folding cannot recover it)

Tried: pier steps and window reveals read from the scan folded over every bay and window of a wall (`foldScan`,
`scratchbox_measured_twin.hpp`), on the cut-out before tile_refine flattened its walls (`raw_clay.glb`), so that the
scan's noise would average down over the copies.

- The depth across a whole bay, in 20 phase bins, is flat on every wall with a regular bay: within 1.6-7.9 cm of a
  constant (no step at the strips or anywhere else), so the bays are not misplaced; the mesh has no relief there.
- Per wall the folded step is 0.0 cm median (reveals; 80% within +/-2 cm) and 0.1-0.3 cm (piers), with a standard error
  of about 5.5 mm once each scan triangle counts once (samples on one triangle are one measurement): 1 of 79 walls'
  reveals and none of 37 walls' pier steps stand three standard errors clear.
- Why: the ESB's whole cut-out is 48,744 triangles, about 2 m^2 each. Averaging removes noise, not resolution the mesh
  never had.

So geometric detail below about 0.5 m at the ESB has to come from another source: Street View with Depth Anything V2
Small at street level (allowed), or, with a decision under AGENTS.md section 2, cast-shadow widths under the fitted sun,
shading over the folded photo, or stereo between registered panos. `foldScan` stays opt-in for meshes that do resolve
their bays.
