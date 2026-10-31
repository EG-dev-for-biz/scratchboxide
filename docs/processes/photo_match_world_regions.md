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

## Views at a place with no structure, and eye height (2026-10-31, later)

Commits 84c10b79 and 6d6d25f7 on `claude/elastic-jennings-e32939`, on top of this branch.

- **Which rule chose the views** is reported in `heldOut.viewTarget.rule`:
  - `isolate`, or `picked-structure`, as before;
  - `first-build`: no structure at the place, and the first build stands in for the target (scope `target`), as before;
  - `open-place`: no structure at the place, and the first build is a whole place (a district).
- **An open place.** The views look at the place itself: every surface of the reference tile within a radius of the frame
  origin, cut at that circle (`surfacesWithin`, a 32-sided polygon). A large ground triangle counts for its part inside.
  - Each view is aimed at the centre, at its ground there, never at the nearest wall.
  - The radius is the pick's window (30 m) first, then 60, 90 and 120 m: the first at which as many views qualify as
    the tool fetches, else the one where the most do. `viewTarget.tried` lists every radius tried and its candidates.
  - Geometry alone decides: no names and no land-use codes.
- **Eye height.** A pano's eye stands 2.5 m over the reference tile's terrain ground model (`buildGroundModel`).
  - Off the terrain grid it falls back to the old rule: the lowest surface within 1.5 m, else the structure's base.
  - `heldOut.eyeGround` counts which rule placed each candidate's eye. `heldOut.notQualified` counts the panos that did
    not qualify.

How it was checked:

- **Tool tests:** 13, all passing with credentials unreachable.
  - **A walled park:** nothing 3 m tall within 30 m of the place, and a 2.9 m wall 45 m out.
    - Within 30 m only the pano inside the park qualifies; from the streets the wall hides the place.
    - The place widens to 60 m, where 5 candidates qualify. Two are judged, each aimed at the centre.
    - The 260 m ground (two triangles) cut at 30 m covers π·30² to within 0.5%. A centroid test would keep none of it.
  - **A vault 20 m under the street:** the old rule put the eye 17.5 m under the street, which hid the block (3%
    unhidden). On the terrain the eye stands at 2.48 m, and the view is judged.
- **The ESB dry run** (run 7f594cd6, the same arguments as the dry run above): **no more candidates.**
  - The views are unchanged: 31 candidates, 8 fetched, 8 registered and the same 4 judged.
  - 22 eyes stand on the terrain. 9 panos stand off the tile's grid (the tile reaches about 90 m), so their eyes stay
    on the structure's base.
  - Both rules compared on all 71 panos with nothing excluded: 38 candidates each, the same set, eyes at most 0.72 m apart.
  - The -19.7 m surface lies under no pano. At the ESB the fix neither adds nor removes a view. It removes a failure only
    where scan lies below a pano.
- **Cost of the open place on the ESB tile** (200,974 triangles): 1.3 s for two radii. Cutting the tile at 120 m takes
  38 ms.
- **Images** (gitignored):
  - `docs/screenshots/m1_world_judge/esb_dryrun_eye/`;
  - `test-results/screenshots/tool_photo_match/tool_photo_match_open_place_masks_view*.png`.

Not verified: no park tile is cached, so the open-place rule has not met a real park. Bryant Park and Dolores Park each
need a fresh district build and a dry run before the preregistration can lift their block.

## Fixed poses (2026-10-31, later)

A preregistration can name its views: `poses`, each a position (`lat`/`lng`, or a `panoId`) and a `headingDeg`, with
optional `pitchDeg` (default 0) and `fovDeg` (10 to 90, default 90), and a `label`. The automatic rule needs the target
to fill 6% of the frame, so it never picks a look along a street with the target at its edge.

- **The pano.** A pose looks from the nearest Google-captured pano within 20 m of its position, or from the pano named.
  The app's lookup probes the position and two rings round it (8 and 16 m); the grounding API's known refusals are left out.
- **The same checks as the automatic views.** A pano any build used is refused (`used-by-build`). A view that does not
  register by edges (at most 5 px, lower than the start) is not used (`not-registered`, with its residuals). There is no
  6% gate: the target's share of the frame and of it unhidden are reported, not used to decide.
- **Views.** The fixed views are fetched, registered and judged blind with the automatic ones, and count toward `views`,
  which is raised to the number of poses (`heldOut.viewsRaisedTo`). Registered fixed views come first, in the order
  given; the nearest automatic views fill the rest, and never repeat a fixed pose's pano. The fetch stays at the tool's
  usual count: the automatic views fetched are fewer by the number of fixed ones.
- **Report.** `heldOut.fixed` lists every pose: the pano used, its distance from the position, the eye's ground, the
  status (`judged`, `no-pano`, `used-by-build`, `no-ground`, `duplicate`, `not-fetched`, `not-registered`) and the
  reason it dropped out. `views[].fixed` marks the fixed views, and the summary counts them.
- **Dry run.** The driver's stand-in lookup takes fixed poses' panos from the metadata cache, so a pose whose pano no
  earlier build looked up drops out there as `no-pano`.

How it was checked:

- **Tool test** (credentials unreachable). Four poses on the synthetic block, views 3:
  - A position 2.8 m from the pano east of the neighbour, heading 250, pitch 4, fov 60. The neighbour hides the block
    from that pano, and the automatic rule rejects it. It is judged first, and the grounding API was asked for heading
    250, pitch -4 (its sign) and fov 60.
  - A pano the build used: refused, never fetched.
  - A position 200 m out: `no-pano`, with the distance to the nearest pano.
  - A named pano, heading 180, fov 70: judged second.
  - The views rise to 4, and the two automatic views are the other two panos.
  - With that named pano failing registration, it is reported with its residuals (6 to 9 px), and an automatic view
    takes its place.
- **ESB dry run** (run 7f594cd6). A position 3 m from a pano the automatic rule rejects was judged first, at the heading,
  pitch and fov given. A pano the K build scored itself on was refused.

## Follow-ups

- **Eyes off the tile.** At the ESB, 9 of the 31 candidates stand beyond the tile's grid. Their eye is the structure's
  base plus 2.5 m, a guess the pose registration has to correct.
- **A target mask clipped at the footprint.** Large scan triangles that straddle the target's outline are wholly target or
  wholly neighbour; splitting them at the outline would sharpen both masks.
