---
name: facade-relief-research
description: Reference map of the known techniques for inferring building facade/window structure and relief/recess depth from photogrammetry imagery and textures — periodicity/repetition detection, irreducible-facade splitting, shape grammars, grammar-driven completion of occluded regions, and shape-from-shading / photometric mesh refinement — cross-referenced line-by-line against what window-fit.ts, wall-grammar.ts and facade-lattice.ts already do versus never implemented. Load this before touching window/opening detection, bay or pitch layout, PHOTO_RECESS / structure-proud-of-bay depth inference, or any pipeline-k facade geometry code, and whenever asked to compare our implementation to a named technique (shape grammars, shape-from-shading, photometric stereo, inverse procedural facade modeling) — the file:function mapping is already done so you don't re-derive it.
---

# Facade/relief techniques: what's known vs. what we built

Pipeline K's facade stage (`packages/core/src/node/3d-engine/staged-location/{window-fit,wall-grammar,facade-lattice}.ts`)
independently reinvented several techniques that have names and a known literature behind them, without borrowing
their code. Knowing the real name of a technique gets you the right vocabulary and the right failure modes to watch
for — and, just as importantly, makes clear what the technique does that our code does **not**, so a "let's add X"
idea doesn't silently re-derive something already known to be hard, or get credited as novel when it's a known,
weaker approximation.

This is a reference skill: it doesn't run anything.

## The mapping

| Technique | What it does | Our analog | Gap — what we do NOT have |
|---|---|---|---|
| Integral-projection / periodicity detection on a rectified facade, to find the smallest repeating unit (the "irreducible facade") | Sums pixel energy along rows/columns of a rectified facade photo and finds the period via a self-similarity (often mutual-information) measure | `facade-lattice.ts` `photoLattice()` (edge-energy row/col sums + `peaks()` thresholding); real autocorrelation/NCC pitch refinement in `window-fit.ts` `autocorrPitch()` / `ncc()` | No mutual-information irreducibility measure. We pick grid lines from edge-energy peaks and confirm pitch by correlation — a cheaper, more brittle proxy for the same question ("what is the period?") |
| Recursive top-down split of a facade into floors, then each floor into tiles, by minimizing a self-similarity/reducibility cost at each cut | Finds the best place to cut by testing how self-similar each half is, recursing until further splitting stops helping | `window-fit.ts` `segments()` (variance-based horizontal band split, hard-capped at depth 4) then `nestedColumns()` / `pierColumns()` (pitch-fold within a band) | Not recursive, not self-similarity-driven. Band count and fold are fixed-shape heuristics, not a search over split points |
| Shape grammar / split grammar: a parsed, generative rule set describing how an element subdivides, used for synthesis *and* classification | A tree of production rules (floor → bays → window/wall/door/sill/cornice) derived from or fit to the image, then applied generatively | `wall-grammar.ts` `TierGrammar` / `fitTierGrammar` / `applyTierGrammar`: fits one pitch + width + sill/head row pattern per wall tier, then stamps it into unseen spans | It's a single fitted template, not a parsed production grammar. No recursive rules, no door/sill/cornice element classes — only window / wall / glass / structure. Nothing here could represent an asymmetric or multi-rule facade |
| Grammar-rule completion of occluded or unobserved regions (apply the derived rule, don't texture-copy pixels) | Where the photo doesn't cover a region, apply the fitted generative rule to produce what should be there | `window-fit.ts` `completeLattice()` (CIELAB-distance grid-repeat fill, marks sites `generated`); `wall-grammar.ts` `applyTierGrammar` bay stamping | Same spirit (repeat what's established), different mechanism (nearest-neighbor/majority grid-repeat, not rule application). Close enough that calling this "grammar completion" in a PR description would overclaim slightly — say "pitch-repeat completion" |
| Shape-from-shading / photometric mesh refinement: recover a displacement or normal field from shading cues on an existing coarse mesh, then push it back into geometry | Solves for the surface shape that best explains the observed shading (brightness pattern), under some reflectance/lighting model, and adds that as relief to a coarser mesh | `facade-lattice.ts` frame/sill/recess depth (`sideS`/`sideT`, `STRUCTURE`, `WINDOW_STRIPS.windowInsetM`) driven by measured scan-depth statistics (two-sample test, `diff ≥ 2·se`), with `PHOTO_RECESS` contrast-based recess and Street View stereo (`reveal-depth.ts`) as fallbacks | **We do not do shape-from-shading.** `PHOTO_RECESS` reads local photo contrast as a recess *signal*, gated by measured depth when it exists — it never solves for a displacement field from shading alone. If someone proposes "estimate depth from shading," check first whether they mean this real technique or our contrast heuristic; they are not the same strength of claim |
| Treating a photo-derived relief estimate as evidence that can **override** a photogrammetry mesh that disagrees with it, rather than only filling where the mesh is silent | Per-region signed protruding/recessed/neutral relief read from imagery, confident enough to replace a disagreeing measured value, not just fill gaps | `PHOTO_RECESS` and the structure-proud-of-bay logic in `facade-lattice.ts` — currently photo cues only fill/shade *within* what the measured scan already allows, gated by the scan's own depth stats | We never let a photo cue overrule a measured depth value. That's a deliberate, correct choice under this repo's "measured data leads" rule (AGENTS.md §4, *Believable within the designated footprint*) — don't adopt an override-the-mesh behavior here without raising it as a product decision first |
| Multi-view texture fusion and microstructure extraction from occluded, variably-lit photo sets | Fuses many partial, differently-lit views of the same surface into one consistent texture, then extracts the fine geometric relief that texture implies | `texture-harmonize.ts` (per-photo gain toward a reference, roof/wall apart, seam offset field) | Our harmonization is tone/gain matching across tile photos, not microstructure (fine geometric relief) extraction from the fused texture itself |
| Material/appearance recovery from photographs for relighting | Estimates a relightable reflectance (BRDF-like) description of a surface from photos taken under one lighting condition | `material-regions.ts` (CIELAB class → texture-library match by colour/texture, `SCRATCHBOX_K_MATERIAL_REGIONS`) | This recovers a relightable material description from photos; ours matches a de-lit photo to a pre-made library material. No BRDF or relighting estimation happens anywhere in pipeline K |

## How to use this when working on pipeline-K facade code

- **Comparing our code to a technique someone names in chat:** go to the table row first. Cite the exact function
  and line range, say plainly which parts are analogous and which are missing — don't imply we implemented
  something we didn't. The temptation is to round up ("yes, we do shape-from-shading") because the code *rhymes*
  with the technique; resist it, the gap column exists for this.
- **Extending window/opening detection or bay layout:** read `window-fit.ts` and `wall-grammar.ts` before writing
  anything — the periodicity and segmentation machinery already has three independent strategies
  (edge-energy peaks, autocorrelation/NCC, variance band-split). A new idea should slot into one of those, not add a
  fourth unrelated one.
- **Extending relief/recess depth:** `facade-lattice.ts`'s depth hierarchy is scan-measured first, `PHOTO_RECESS`
  second, Street View stereo third — in that priority order, per AGENTS.md's "measured data leads" rule. True
  shape-from-shading (an actual displacement-from-shading solve, not a contrast heuristic) is the one technique in
  this table we have never built; if a task calls for it, say so explicitly rather than quietly extending
  `PHOTO_RECESS` to do more than contrast gating.
- **No shortcuts that conflict with this repo's own rules:** none of this is a reason to reach for a JS primitive
  stand-in (`THREE.BoxGeometry` etc. — `npm run lint:primitives` catches it) or to bypass the C++20 engine
  (AGENTS.md §3.1–3.2). Grammar/relief logic computes *parameters* (pitch, depth, inset); the native engine still
  generates the geometry. And none of these techniques imply a closed taxonomy — periodicity, grammar fit and
  relief depth are all continuous measurements, never a switch on a building "type."
