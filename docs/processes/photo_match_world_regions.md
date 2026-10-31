# The photo-match judge scores the whole place: regions from geometry (Feature 1, M1)

Date: 2026-10-31. Branch `feat/m1-world-judge`. Plan: `docs/research/2026-10-30-hyper-realistic-real-world-plan.md` (M1).

## What changed

`photo_match_evaluate` (`photo-match-evaluate.ts`, on `photo-match-eval.ts`) used to measure its secondary numbers only
inside the building mask. It now measures the whole place.

- **Regions from geometry, per render.** Every triangle gets a label from geometry alone (`triangleRegions`):
  - **ground**: no vertex stands more than 0.6 m above the terrain under it (the base cleanup's street band). The terrain
    is the app's ground model (`buildGroundModel`, the walkable street surface) of the reference tile's geometry. Off the
    terrain, a facet is ground when it faces within 60 degrees of up.
  - **target**: the isolate, matched triangle by triangle. With no isolate, it is the structure the app's structure rule
    picks at the frame origin (`pickStructure`), inside Google's building footprint when the run's vector stage read one.
  - **trees**: the crowns the run's tree strip measured (`removed_trees.glb`) and every regrown trees layer.
  - **neighbours**: everything else standing.

  The z-buffer then gives each pixel the label most of its samples hit (`renderTriangles` `regions`); a pixel no ray hits
  is sky. The skyline band is every pixel within 1.25% of the image width (8 px at 640) of where standing geometry meets
  the sky, on both sides. Colour and brightness decide nothing.
- **Metrics per region.** The masks are the reference tile's (the measured scan, whole), the same for every arm.
  - Per arm and view, `views[].regions.arms[id]` holds frame, building, ground, neighbours, trees and skyline. Each has
    the share of the frame, luminance SSIM, the structural-edge chamfer, CIEDE2000, and `agreement`: the share of the
    region where the arm's own labels show what the reference shows.
  - Means over views are in `pixelMetrics.regions`.
  - The old building numbers (`pixel`, `pixelMetrics.mean`) are unchanged, number for number. This was checked against
    the old code on the same inputs before the refactor was kept.
- **Masks in the grids.** Every grid's second image is the photo with the masks drawn over it. A mask grid per view
  (`grid_<view>_masks.png`) shows each arm's own labels over its render.
- **The judge on regions, blind, opt-in.** With `judgeRegions: true` the same calls also score ground, neighbours and
  skyline, 1-10, still shuffled and unlabelled (`regionScores`). Without it, the prompt is byte-identical to before (its
  hash is pinned in the test), and so is the reply format.
- **Both build modes.** `arms[].scope` says what an arm is:
  - `target`, the default for an isolated run and for GLBs: the arm is drawn in the tile with the target cut out.
  - `place`, the default for a district run: the arm is the whole place and is drawn on its own.

  Two runs extracted at one place are brought onto one frame by their origin heights (`liftedM`).

## Pre-existing breaks found and fixed on the way

- **Fresh K runs could not be evaluated at all.** Since the tile seam stage, a run keys its tiles on the welded scan
  (`keys.tiles` has no cache entry), so the tool failed with `missing_reference_tile`. It now follows the run's
  `tile_seams` note to the extraction and reads the welded files, which every stage of the run read.
- **K runs lost their isolate.** Pipeline K records its clay at `<entry>/polish/<key>/clay.glb`; the tool looked for
  `raw_clay.glb` beside it and found none. That silently dropped the in-context cut. It now looks two levels up too.
- **Panos a build scored itself on were not excluded.** `pipeline_k_streetview_score.json` names 16 Street View views as
  `<panoId>_h193_p55`. `collectPanoIds` now reads views named after a pano (also `SV_<panoId>_h…` stations and survey
  frame names). For run 7f594cd6, the panos excluded went from 0 to 16.
- **District views aimed at the district's centroid.** A district's first layer can reach 4 km (terrain), so held-out
  views had to stand far out. Views now aim at the target picked at the place.

## How it was checked

- `packages/core/test/photo-match-eval-regions.test.ts` (6 tests), on orthographic scenes whose counts are known by hand:
  - from above, exact pixel counts: target 400, neighbours 320, ground 3,248, sky 832;
  - from the front, exact counts with a 0.5 m kerb counted as ground, and the skyline band equal, pixel for pixel, to a
    brute-force band;
  - per-region metrics: a recoloured neighbour moves only the neighbours' ΔE; a missing neighbour drops the neighbours'
    agreement to 0;
  - judge prompts and replies, and region scores mapped back through reshuffles.
- `packages/core/test/photo-match-evaluate-tool.test.ts` (11 tests):
  - the isolated run in context;
  - a district comparison with a whole place, a decoy without its neighbour, and a hero-only arm drawn in the tile with
    the picked target cut out;
  - a seam-welded district run read through its note, where Google's footprint makes the target the whole podium and tower
    (651 m²) while the scan alone picks the tower (121 m²).
- All photo-match tests pass with credentials unreachable (empty HOME, cleared environment), except
  `photo-match-eval-tree-cutout` "card-only tree". It fails identically on the base commit (0.8396 against a bar of
  0.8352) and is not touched here. `npm run typecheck` passes.
- **Free dry run on real data** (`packages/core/test/photo-match-dryrun.test.ts`, the skill's step 2 driver), run on the
  ESB K run 7f594cd6:
  - **Inputs:** 71 real pano positions from the Street View metadata cache, "photos" rendered from the welded tile,
    identity registration, a blind pixel-difference judge.
  - **Views:** 16 panos were excluded as used; 31 candidates, 8 fetched, 8 registered and 4 judged.
  - **Cost:** 8 stand-in judge calls, 24 s, no network and no model call.
  - **Images:** `docs/screenshots/m1_world_judge/esb_dryrun/` (gitignored).

  | View | Distance | Target | Neighbours | Ground | Sky | Skyline band |
  |---|---|---|---|---|---|---|
  | v0 | 45.8 m | 90.2% | 4.1% | 5.7% | 0% | 0% |
  | v1 | 46.3 m | 33.9% | 36.7% | 17.4% | 12.0% | 4.7% |
  | v2 | 52.0 m | 17.1% | 82.9% | 0% | 0% | 0% |
  | v3 | 72.2 m | 12.6% | 83.6% | 3.1% | 0.6% | 0.5% |

  The raw scan agrees with the reference everywhere (1.00), as it must. The K hero (its clay) agrees 1.00 on the building
  and 0.74 on the neighbours.

## What the real data showed

1. **The masks follow the geometry.** The street is ground, rooflines carry the skyline band, and the tower is the target
   wherever its triangles are (`esb_dryrun/masks_view1.png`, `esb_tile_regions.png`).
2. **The structure rule alone misses most of the ESB.** Without Google's footprint, the scan-only pick at the ESB is its
   upper shaft (2,438 m², 440 m), and the setback blocks count as neighbours. A district run's cached vector stage fixes
   this, and the tool now uses it. A district reference with no vector stage should not be trusted for the building mask;
   the report says which source decided (`regions.target.footprintSource`).
3. **The isolate cut is only as good as the isolate's match with the reference tile.**
   - On run 7f594cd6, 96.7% of the isolate's triangles matched. The tile was re-extracted today, while the run reused
     yesterday's cached remesh.
   - The unmatched triangles stay in the context. They show up as part of the ESB's own facade labelled neighbour (the
     diagonal blue wedge in `masks_view1.png`), and as the K hero "standing on" neighbour pixels (neighbour agreement 0.60
     to 0.70).
   - Against the unwelded `textured.glb` the same isolate matched only 85%.
   - `regions.target.matchedShare` reports this. The preregistration stops on a share under 0.99. Fresh, uncached builds
     take both from one extraction.

## Not verified

- **No paid judge call and no live build.** The region criteria have never been answered by a real vision model, so
  whether it can score ground, neighbours and skyline blind and repeatably is the first thing the preregistered run measures.
- **Not run in the live app.** The change is the tool's server side; the chat drives it the same way as before.
- **A pick with real vector footprints.** Only the synthetic one was tested: no ESB vector stage is cached.

## Follow-ups

- **Views at a place with no structure.** At a park or a plaza (Bryant Park, Dolores Park) the pick finds no structure
  within 30 m of the place. Views then fall back to the first build's layers, which for a district is the whole district,
  so no held-out view qualifies. A view rule for a place with no structure at it is needed before those two places can be
  judged.
- **Eye height.** `heldOutViews` puts a pano's eye 2.5 m over the lowest surface within 1.5 m. At some points round the
  ESB that surface lies far below the street: -19.7 m at a point 3 m off its north face, against a terrain of 0.9 m
  (`geometry_tile_seams_2.glb` reaches -23.9 m). That can put the eye underground and reject the view. The terrain model
  is now at hand and would give the street's height. Not changed here: it moves every held-out pose before registration,
  and only a live run can show the effect on registration.
- **A target mask clipped at the footprint.** Large scan triangles that straddle the target's outline are wholly target or
  wholly neighbour; splitting them at the outline would sharpen both masks.
