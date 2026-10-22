# Pipeline F: one survey, one wall stack, one facade program

Status: plan (2026-10-22), revised after review the same day. Decision: pipeline F becomes the pipeline behind the front page's "3D Building" button, replacing pipeline G there.

Naming: a "version F" already exists in the orchestrator (the round-3 procedural shape, `SCRATCHBOX_STAGED_GEOMETRY`). Pipeline F replaces it; rename or retire the old F code as the first step so the name is not shared.

## Idea

A survey gives three things for every surface it sees: geometry, texture and attachments. Pipelines E and G already share the massing (`runMassingStage`, footprint massing on a procedural request) and the native builder (`staged_massing`: openings with `arch`, sweeps, face sweeps). They differ only in what feeds the builder:

| | E | G |
|---|---|---|
| Wall image | tile ortho bake through a thin slab per face | path-traced survey stations laid onto per-face plates (5 cm/px, relief) |
| Reader | `pipeline-e/inference.ts`, verified by a second native run | `pipeline-g/read.ts`, one facade program per plate, no check |
| Texture | de-lit tile ortho | median colour paint per face |

F keeps every station's pixels per face in the face's metric (s, t) frame, from every source, reads them in layers into one facade-program schema, builds natively with the four operators, textures the build from the same stack, and checks the build against every view.

## Stages

1. **Massing.** Footprint massing (vector footprint, else the scan's plan; tiers from scan height steps). Exists: `buildMassing({ preferExtrusion })`, `cellsFootprint`.
2. **Intelligent survey** (see "Survey planning" below). Station rows: street, mid, four high aerial obliques framing the whole subject, one roof nadir; plus a registered Street View seed and chained AI Beautify stations accepted by the frame check.
3. **Per-face wall stack.** Per face, layers in (s, t) at 2-5 cm/px: colour per source (tile ortho, plates, Beautify, Street View), relief (scan depth against the plane), and per texel the best few views (top 3 by sharpness and incidence; an 86 x 60 m wall at 2 cm is 13 M texels, so never every view). Derived: best texture (sharpness- and head-on-weighted median), relief map, coverage map (holes). Occluders: every plate is rendered from the same tile texture, so plates agree on a tree or van baked into it; agreement between plates catches render seams and depth errors only. Occluders come from vehicle removal, the obstruction masks, and disagreement with independent sources (Street View, the tile ortho); Beautify is derived from the tiles and is not independent.
4. **Layered read into one schema.** Tall walls are read per height band and secondary detail per bay crop (a whole 86 m wall took about 190 s per read on the Flatiron). Primary (bays, floors, opening rhythm, arches, piers, bands, cornices); secondary (window reveal depth from relief, mullions, transoms, sills, lintels, shop fronts, awnings); attachments (fire escapes, balconies, rooftop objects) with depth from parallax across stations. G's program is the shared type; E's inference becomes a second reader that emits it.
5. **Native build with the four operators.** Cornice and band envelopes (depth, height, overhang) from vertical cuts of the relief map; the tiles hold about 0.5 m of geometric error, so the mouldings inside an envelope come from a raking Street View or Beautify read, else generated (labelled) (sweeps); columns and colonnettes (solids of revolution); bays, balusters, fire-escape slats and treads (replicators); rustication and joints from the texture's high-pass (relief fields). A repeated element is built once from the median of all its instances, then replicated.
6. **Texture the build.** Project the per-face best texture onto the built faces (de-lit, photo-inferred); fill holes with the image infill tool (`image_infill_holes`, built before build-order step 2) from neighbours and the repeat median (generated); no baked shadows.
7. **Check.** Render the build from every station. Against tile renders, compare opening positions and silhouette only: a clean build scores lower than melted tiles exactly where it improved on them, so fine edges are never judged against the tiles. Fine detail and colour (edge NCC + ΔE) are judged against Street View and accepted Beautify frames. Faces that disagree are re-read.
8. **Publish.** One layer, provenance per part and per texel.

## Survey planning (stage 2)

Plan around what the build does not yet know about this subject, measured, never by building type.

1. **Read the subject, no images:** per face size, height, orientation, visibility (party walls drop out), complexity (scan relief variance and edge density against the plane), off-plane mass (things that stand out of a wall), shape ratios (tall/thin: height bands; long/low: spaced street views; radial: even ring; large roof: nadir).
2. **Score candidates** (walkable street, mid row, aerial dome, registered Street View panos): gain = uncovered or blurry wall pixels × face complexity × incidence fit × cm/px; minus occlusion (rays through the scan), redundancy, bad framing; plus a chaining bonus for 30-60% overlap with an accepted view.
3. **Greedy next-best-view:** take the best, update coverage, rescore, stop at diminishing gain or budget. Chain order falls out: Street View seed, wide aerial, then outward.
4. **Close the loop:** after a batch is laid onto the plates, recompute gaps from what actually arrived (blur, missed occluders, frame-check rejects, reader uncertainty) and plan again only for those.
5. **View purpose sets the angle:** texture head-on; profiles 30-60° raking; attachments a parallax pair; style seed the clearest Street View.

Existing pieces: `face-survey.ts` (`surveyCandidates`, `selectSurveyViews`: add complexity weighting; the 4-face cap `MAX_SURVEY_FACES` also sizes E's Street View image budget, so it is lifted by a caller option for rendered stations, never by changing the constant), `view-match.ts` (`planRingViews`: becomes the overlap term), `pipeline-g/stations.ts` (`probe`: on-face and blocked shares are the first gain and occlusion terms).

## Build order (each step measured alone)

Every step is tested on Broome St (Haughwout), the Flatiron and the Rookery and reports: plate coverage at ≤5 cm/px, walls read, photo-match judge score, time and vision calls. Budget per building: under 6 minutes and under 12 vision calls (today: Flatiron 3 min 52 s, 3 reads).

0. Image infill tool (`image_infill_holes`), from the shared `inpaintImage` lock. Metric: keep ΔE and rim ΔE on held-out holes.
1. Wall stack from existing G plates + E orthos, top-3 views per texel. No new model calls. Metric: coverage and sharpness against today's plates.
2. Project that texture onto the current G build, holes filled by step 0. Metric: judge score against today's median-colour paint.
3. Envelopes and reveals from relief. Metric: cornice depth and reveal depth against Street View.
4. Intelligent survey (gain + occlusion + greedy), aerial row and roof nadir. Metric: coverage and walls read at the same capture count.
5. Banded and per-bay reads. Metric: read time and walls read.
6. Attachments from parallax.
7. Repeat median and the render-back check.
8. Beautify chain layer, weighted, never ground truth (2 of 10 stations pass today).

## Entry point

The front page "3D Building" button (`studio/starterPrompts.ts`, curated list) runs pipeline F only: resolve, tiles, vector, footprint massing, F. Every other stage is skipped as out of scope and left out of the progress view (the procedural-only mechanism, on main: `Runner.proceduralOnly`, `StageEvent.outOfScope`).

## Risk

Registration: the stack works only if every source lands on the face within about a pixel. Plates share the tile camera; Street View and Beautify views need per-image registration (done for the Broome St seed: edge NCC 0.65), are down-weighted when they register poorly, and dropped below edge NCC 0.5.

Street View coverage: grounding images exist for US panoramas only; elsewhere only the Static API, so the Street View seed and independent occluder evidence are thinner outside the US.

Naming: calling this "pipeline G v2" instead of F would avoid retiring the existing version F code; the plan keeps F unless the user decides otherwise.
