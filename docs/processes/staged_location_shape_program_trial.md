# Staged Location Builds: Shape Program Trial (height-map tiers, one-call shape program + native fit)

> **Recorded:** 2026-10-19
> **Status:** Trial behind a flag (`SCRATCHBOX_STAGED_SHAPE_PROGRAM=tiers|1`, off by default; only inside pipeline E, `SCRATCHBOX_STAGED_PIPELINE=e`). Branch `shape-program` (from `origin/version-e-fixes`). Recommendation: **drop as a replacement for E's massing; keep two parts** (section 7).
> **Tags:** `staged-build` `pipeline-e` `shape-program` `photo-match` `provenance` `trees`
> **Target Domain:** Real-world 3D locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. What was built

All of it replaces only pipeline E's massing (step 1 of `staged_location_pipeline_e.md`); the native massing kernel (orthos, residual, wall snap), inference, enhancement, relief and the tree stage run unchanged after it.

1. **Trees out first** (`pipeline-e/shape-stage.ts` `measureTrees`, `scratchbox_shape_program.hpp` `analyseScan`). The strip's crowns (`crowns.json`: stem, apex, support, 16 sector radii, plan polygon) are kept as measurements; each crown's base height is read from the strip's removed triangles under it (5th percentile above the support; `estimated` at 35 % of the height when fewer than 8 triangles). The isolate (already cut from the devegetated tile) is split natively into ground (near-flat within 0.6 m of the street), tree (inside a crown's plan, between its base and top, more than 1 m outside the vector footprint) and building. Triangles in a crown's plan within 1 m of the footprint are **kept and counted** (`treeInsideFootprintKept`), never deleted silently. Written per build: `trees.json`, `tree_mask.png`.
2. **Height-map tiers (no model)**. Frame: the mode of the scan walls' azimuths or of the vector footprint's edges (mod 90 degrees), whichever boxes the roof more tightly. Height grid 0.25 m; the building's cells are those 2 m above the street, bounded by the vector footprint grown by 2 m when the two agree (at least 50 % of the footprint covered), else the height map alone (the arch). Tier levels: mean-shift modes of the up-facing area and the cell heights (the scan rectifier's area-density modes, re-implemented standalone, merge 1.5 m), plus levels at the median and 95th percentile of what stands 2.5 m above the top level (spires). Each tier's region is cleaned (close/open 0.75 m), traced along cell boundaries, simplified (0.35 m) and squared to the frame's axes. Tiers become kernel parts labelled `measured`.
3. **Shape program from one vision call** (`pipeline-e/shape-program.ts`, `shape-stage.ts`). A contact sheet (the height map in the frame with metre ticks, the measured outline with edge lengths, the map footprint, four oblique clay views of the tree-free scan) goes to `gemini-4-argon` (LOW thinking, structured output `SHAPE_PROGRAM_JSON_SCHEMA`, 120 s limit). The language: elements carrying exactly one of `prism` (outline as polygon / rect / measured outline inset; base, top, roof rise, ridge direction, hip share 0..1), `revolve` (r(h) profile, side count, K harmonic lobes, amplitude, twist), `sweep` (profile with DXF bulges along a 3D carrier polyline, end scale, twist), `relief` (an outward band of a prism's walls), and `repeat` on any element (count, step vector). No closed type enum; `label` is never read by execution. Built natively (`scratchbox_shape_program.hpp`, CLI `scripts/shape_program.cpp`): prisms become kernel parts (roof planes = lower envelope), the rest closed triangle solids.
4. **Render-and-fit** (native). Every element has a fixed handle vector (prism: each box side moved independently, base, top, rise; revolve: axis offset, base, height and radius scales; sweep: offset, path and profile scales; relief: from, to, out; repeat: step scale) with bounds. Coordinate descent with halving steps against: height-grid mean absolute error / building height + 0.5 x (1 - silhouette IoU, mean of 4 views) + 0.25 x truncated depth error. A fit never removes an element (a prism keeps 0.5 m of height and 0.3 m of width, a band 0.1 m). One correction call with the difference images when silhouette disagreement > 0.12 or height error > 8 %; kept only when the refit's loss is lower. Provenance: the structure `photo-inferred` (`shape-program-inferred` token, `massingProvenance`), every handle the fit was free to move listed as `measured` in the run note and `program.json` (`parameters[]`).
5. **Trees back in**: the build's own tree stage regrows from the same strip crowns (identical trees GLB to E7 at St. Mark's and Jefferson); scoring draws them at one LOD per view (`treeLod`, the evaluator's rule).

Evaluator addition: `scripts/dev/photo-match-eval.ts` `visibility` (per view, share of pixels where the target's isolate is visible and not behind the strip's removed trees; aggregates weighted by it).

## 2. Scores (`gemini-4-argon` blind x3, textured and clay; in context, regrown trees one LOD per view)

Views: round 7's held-out views for St. Mark's and Jefferson, round 6's for the arch and Haughwout; no build of this trial fetched a held-out pano (checked against the replay recordings in `gen_man.py`). Arms: A raw tile (cut to the isolate), E7 / Eh7 (round 7's builds; Haughwout's built on this branch with the same code; the arch's are round 6's fallback-to-D builds because E has no usable footprint there), ST height-map tiers, SP shape program + fit (real-data texture, `SCRATCHBOX_STAGED_ENHANCE=0`), SPH the same program with Eh7's enhanced texturing. Table: `test-results/screenshots/shape_program/bakeoff/bakeoff_shape_program.md`.

Overall (textured) / clay shape / overall visibility-weighted / clay visibility-weighted:

| Place (views) | A | E7 | Eh7 | ST | SP | SPH |
|---|---|---|---|---|---|---|
| St. Mark's (4) | **5.67** / 4.17 / 5.91 / 4.85 | 4.67 / **7.58** / 4.93 / **7.65** | 5.25 / **7.58** / 5.65 / **7.65** | 3.00 / 1.92 / 3.00 / 1.89 | 3.42 / 4.25 / 3.54 / 3.87 | 4.08 / 4.50 / 4.04 / 4.09 |
| Washington Sq. Arch (6) | 4.28 / 5.17 / 4.45 / 5.29 | **5.61** / **5.39** / **5.70** / **5.71** (D) | **5.61** / **5.39** / **5.70** / **5.71** (D) | 3.00 / 3.67 / 3.12 / 3.44 | 3.17 / 3.72 / 3.24 / 3.76 | 3.56 / 3.72 / 3.69 / 3.76 |
| Haughwout (5) | 3.93 / 4.80 / 3.83 / 4.71 | 4.47 / 6.47 / 4.22 / 6.37 | **6.07** / **6.73** / **6.01** / **6.78** | 3.20 / 3.80 / 3.07 / 3.94 | 3.00 / 3.07 / 3.00 / 3.02 | 3.00 / 3.07 / 3.00 / 3.02 |
| Jefferson (4) | **6.08** / 5.58 / **5.87** / 5.26 | 4.42 / **6.92** / 4.78 / **6.19** | 4.42 / **6.92** / 4.78 / **6.19** | 2.58 / 1.58 / 2.82 / 1.26 | 3.33 / 3.25 / 3.74 / 3.11 | 3.33 / 3.42 / 3.74 / 3.15 |
| **All 19 views** | 4.86 / 4.95 / 4.56 / 5.01 | 4.86 / 6.46 / 4.93 / 6.24 | **5.40** / **6.53** / **5.70** / **6.40** | 2.97 / 2.89 / 3.05 / 3.19 | 3.21 / 3.56 / 3.24 / 3.41 | 3.47 / 3.65 / 3.47 / 3.44 |

Judge spread: mean within-view sd 0.23 (textured), 0.28 (clay). Visibility per view (share of the frame where the building is visible): St. Mark's 0.05 / 0.12 / 0.24 / 0.02 (S0kdms 0.12: mostly trees, as expected), arch 0.05-0.39, Haughwout 0.08-0.68, Jefferson 0.03-0.32. Weighting does not change any ranking.

**Result:** every S arm scores below E7/Eh7 on every place, textured and clay, weighted or not (clay: ST -3.6, SP -2.9 against E7 over all views). The shape program beats the plain tiers in clay at St. Mark's (+2.3) and Jefferson (+1.7), not at Haughwout; enhanced texturing (SPH) adds 0.0-0.7 over SP.

## 3. Time (seconds; warm tile, strip and tile_refine caches; S live model calls; E's from round 7's logs, Haughwout's from this branch)

| Place | E massing stage | E grammar stage (E / Eh) | ST shape stage (tree split / height map) | SP shape stage: total (model / fit / correction call + refit) | SP massing stage | SP grammar stage (SP / SPH) |
|---|---|---|---|---|---|---|
| St. Mark's | 3.7 | 10.7 / 68.7 | 0.5 (0.30 / 0.08) | 55.4 (28.3 / 4.8 / 17.7 + 3.8, kept) | 58.4 | 41.1 / 167.0 |
| Arch | (falls back to D: evidence 108 + textures 63) | n/a | 0.1 (0.05 / 0.00) | 19.9 (9.4 / 9.4 / not asked) | 24.8 | 212.5 / 199.9 |
| Haughwout | 4.8 | 47.0 / 211.8 | 5.7 (0.01 / 0.01; 5.3 native build-cache check) | 38.2 (11.2 / 5.8 / 15.4 + 5.3, kept) | 42.5 | 43.4 / 135.3 |
| Jefferson | 6.5 | 77.5 / 168.5 | 0.4 (0.24 / 0.06) | 27.2 (20.1 / 6.4 / not asked) | 32.2 | 140.7 / 257.4 |

- The shape stage is **added** to E, it does not replace the grammar stage: E's inference (roof, bands, windows, colour, enhancement) still runs on the S solid and is as slow or slower (more and odder faces). Per building, S-tiers costs 0.1-0.5 s over E's massing; the shape program costs 20-55 s, of which 9-28 s is the one model call and 3-9 s the native fit (480-790 evaluations); the correction call adds 15-18 s and was asked at St. Mark's and Haughwout.
- Tree regrow (tree stage) 0.0-2.7 s in every arm (cached strip).

## 4. What the shape program got right and wrong (screenshots in `test-results/screenshots/shape_program/<place>/`)

- **Right:** the overall structure is read well from one contact sheet: St. Mark's nave with a gable along the long axis, a portico, a square tower base and an octagonal tiered spire as a revolve (`stmarks/Sp_stmarks_program.json`); the arch as two piers, a swept spandrel with an arched underside, cornice and attic (`arch/Sp_arch_program.json`; fit loss 0.179 to 0.063, silhouette IoU about 0.95 per view, `arch/Sp_arch_fit_overlay.png`) - the first time E's massing path applies to the arch at all (its vector footprint lies about 9 m off the scan, `arch/Sp_arch_contact_sheet.png`); Haughwout's belt courses, cornice and the water tank as a revolve; Jefferson's clock tower and spire, gabled hall and apse. The native fit recovers known parameters exactly on synthetic scans (test) and lowers the real losses by 20-65 %.
- **Wrong:**
  - Shapes are boxier than Google's modelled volumes, which E uses where they exist (St. Mark's, Jefferson): the clay judge prefers E's volume by 3+ points (`stmarks/arms_alone_clay_v2_KiwFv6.png`, `jefferson/arms_alone_clay_v0_xf-y97.png`).
  - Readings vary by call: four St. Mark's calls (the contact sheet changed slightly between code versions) answered 8, 11, 4 (one element carrying two operators, dropped) and 12 elements; the portico was read as two 2-6 m wide solid piers.
  - Arc semantics: the arch's spandrel profile came back as a self-overlapping polygon with a 90-degree downward bulge, so the opening has a flat V top instead of a round arch (`bakeoff/arch_v1_OD27n2_clay.png`).
  - Haughwout: both S solids leave the scanned street facade standing in front as residual (`haughwout/arms_alone_clay_v0_AHxVmF.png`; the judge gave SP/SPH 3.0 on every view). Not diagnosed further.
  - The fit's targets carry the strip's vertical skirts and isolate fragments (red spikes in every `*_fit_overlay.png`), so silhouette disagreement stays near 0.15-0.20 and triggers the correction call even when the reading is right.
- **Bugs found and fixed during the trial** (each rebuilt before scoring): the vector footprint's parts are triangles repeated with both windings (even-odd cancelled them: union now); a fit could shrink an element to nothing (St. Mark's portico roof and a band) or cross a prism's sides (Haughwout parapets, a NaN volume that sent the build to the current pipeline); a revolved square stood on its corner; the walls' azimuth mode at Haughwout was the isolate's axis-aligned cut (32 degrees off); a stalled correction call held St. Mark's past the 300 s stage limit (120 s call limit now).

## 5. Tree removal (`<place>/St_<place>_trees.json`, `*_tree_mask.png`)

| Place | crowns measured near | strip-removed triangles near the building (area) | of which inside the footprint | isolate tree triangles dropped (area) | kept in a crown's plan near the footprint (area) | isolate fragments outside the outline (dropped from fit targets only) |
|---|---|---|---|---|---|---|
| St. Mark's | 24 | 13,998 (5,844 m²) | 0 | 102 (371 m²) | 474 (644 m²) | 703-713 |
| Arch | 5 | 244 (130 m²) | 0 | 0 | 0 | 19 |
| Haughwout | 1 | 0 | 0 | 0 | 0 | 230 |
| Jefferson | 13 | 9,511 (4,088 m²) | 0 | 179 (477 m²) | 254 (417 m²) | 63 |

Nothing inside a footprint was removed. The kept triangles at St. Mark's are largely the strip's vertical skirts along the walls (they still reach the fit's targets, section 4).

## 6. Tests

`packages/core/test/staged-shape-program.test.ts` (7, synthetic, no model or network; guarded runner): flag; program validation (two operators, impossible heights, repeat count, relief renumbering); native volumes of every operator (box, gable, pyramid, cone, straight and arc sweeps, bulged profile, band and a 5-column row with exact triangle counts) and the kernel closing a program solid; fit handles never remove an element; height-map tiers of a rotated two-tier scan (frame within 1 degree, tower tier 26 m, squared rectangle) and the fit recovering a perturbed program (loss 0.48 to 0.002, heights within 1 m, sides within 1.5 m); tree measurement round trip (crown base 3 m from the removed triangles, 30 tree triangles split out, the walls in the crown's plan kept). With `staged-pipeline-e.test.ts`: 19 passed. Screenshots `test-results/screenshots/shape_program/tests/`.

## 7. Recommendation

**Drop** the shape program and the height-map tiers as a replacement for E's massing: neither is faster per building (the model call alone costs more than E's whole massing stage, and E's grammar stage still runs after), and both score clearly worse in clay and textured at all four places. **Keep** two parts if wanted: the trees-out split with its removal report (cheap, 0.01-0.3 s, and it never touched a footprint), and the program + fit as a **fallback where E has no usable vector massing** (the arch: E falls back to D today; SP's arch is a recognisable arch at 20 s, though D still scores higher there). Iterating would need: Google's modelled volume as the starting program where one exists, circular-arc and opening primitives the model fills by number rather than by polygon, and skirt-free fit targets.

## 8. Reproduction

`SCRATCHBOX_STAGED_PIPELINE=e SCRATCHBOX_STAGED_SHAPE_PROGRAM=tiers|1 [SCRATCHBOX_STAGED_ENHANCE=0]` with the headless build driver of `staged_location_pipeline_e.md` section 8; the stage's note is `runs/<runId>/shape_program.json`, its files under `pipeline_e/<key>/shape/` (`scan/`, `contact_sheet.png`, `program.json`, `fit*/`). Evaluation: `scripts/dev/photo-match-eval.ts` with the manifests in `test-results/screenshots/shape_program/bakeoff/man_*.json`.
