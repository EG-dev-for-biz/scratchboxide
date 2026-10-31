# The photo-match judge scores the whole place: regions from geometry (Feature 1, M1)

Date: 2026-10-31. Branch `feat/m1-world-judge`. Plan: `docs/research/2026-10-30-hyper-realistic-real-world-plan.md` (M1).

## What changed

`photo_match_evaluate` (`photo-match-evaluate.ts`, on `photo-match-eval.ts`) used to measure its secondary numbers only
inside the building mask. It now measures the whole place.

- **Regions from geometry, per render.** Every triangle gets a label from geometry alone (`triangleRegions`):
  - **ground**: no vertex stands more than 0.6 m above the terrain under it (the base cleanup's street band). The terrain
    is the app's ground model (`buildGroundModel`, the walkable street surface) of the reference tile's geometry. Off the
    terrain, a facet is ground when it faces within 60 degrees of up.
  - **target**: the isolate: every tile triangle whose centroid lies on its surface (since 2026-10-31, later; it was
    matched triangle by triangle). With no isolate, it is the structure the app's structure rule
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
  - `place`, the default for a district run: the arm is the whole place and is drawn on its own. Its standing triangles
    are labelled by the target's footprint: the picked structure's cells, or, with an isolate as the target, the
    isolate's plan outline (see "A whole place with an isolate as the target" below).

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
3. **The isolate cut is only as good as the isolate's match with the reference tile.** (Corrected later on 2026-10-31:
   the 96.7% was not a mixed extraction. A fresh build gives the same figure, because tile_refine cuts the isolate's
   triangles at its outline. See "The isolate's target by its surface" below.)
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

## A whole place with an isolate as the target (2026-10-31, later)

**The gap.** A whole-place arm (`scope: 'place'`) was labelled by the target's footprint only when the target was
picked. With an isolate as the target (a K run named first) there was no footprint, so every standing triangle of such an
arm was a neighbour. The decoy X1 (K's GLBs as a whole place) then had no building at all, and its hero counted as
neighbours wherever the photo had a building in front of it.

**The outline method** (`planOutlineCells` in `photo-match-eval.ts`). It uses geometry only; colour and class decide
nothing.
- **The cells.** On the reference tile's terrain grid (1 m), a cell is in the outline when its centre lies within 1 m in
  plan (`PHOTO_MATCH_OUTLINE_REACH_M`) of one of the isolate's standing triangles. Standing is decided as for the regions
  (`triangleRegions`), so a roof counts by its area, a wall by its foot line, and the street under the isolate not at all.
- **Enclosed cells join.** These are cells not 4-connected to the grid's edge through cells outside: a courtyard, or a gap
  in the roof.
- **The labels.** A whole place's standing triangle is the target when its centroid falls in an outline cell, else a
  neighbour.
- **The tolerance.** A wall rebuilt up to half a metre outside the scanned one stays the target (K clips at its footprint
  plus 0.3 m). A neighbour's face within about a metre of the target's counts as the target.
- **What stays the same.** It applies only to whole-place arms with an isolate as the target. The tile's own labels (the
  isolate matched triangle by triangle) and every `scope: 'target'` arm are labelled as before. With a picked target, a
  whole place still follows the pick's cells.

**Report.**
- `regions.placeOutline` gives the method, the cells, the area and the reach. It is present only when the outline was
  used.
- `regions.armTriangles` gives every arm's triangles by label (target, neighbours, ground, trees; a trees layer is counted
  whole). It covers every run.

**How it was checked.**
- **Unit test** (`photo-match-eval-regions.test.ts`), on a flat 1 m grid:
  - a roofed 10 × 6 m box is exactly the 12 × 8 cells within 1 m of it;
  - four walls with no roof are their foot lines plus the 18 × 18 cells they enclose;
  - with one wall missing, the yard stays outside;
  - the street draws nothing.
- **Tool test** (`photo-match-evaluate-tool.test.ts`). The synthetic block's K run is named first, so its isolate is the
  target. The whole-place arms are labelled triangle for triangle:
  - X1, the hero alone: 10 target and nothing else;
  - the place as the tile has it: 10 target, 10 neighbours and 2 ground, with frame agreement 1.00 in every view;
  - a rebuilt place: its hero 0.3 m out on every side is 10 target; a building 1.5 m east of the hero's wall and the
    neighbour across the street are 20 neighbours; the street is 2 ground.
  - The tile's labels (`matchedShare` 1), the raw scan and the hero arm are unchanged.
  - With the outline switched off, the test fails on X1's counts (0 target).
- All photo-match tests pass with credentials unreachable, except `photo-match-eval-tree-cutout` "card-only tree". That
  failure predates this change (0.8396 against 0.8352). The core typecheck is clean.
- **Free dry run at the ESB** (run 7f594cd6, the driver's stand-ins, no network and no model call, 34 s):
  - **Arms:** K's polish clay as K (`scope: 'target'`), and the same GLB as X1 (`scope: 'place'`). Both judged in 4 views.
  - **The outline:** 8,607 cells (m²), from the isolate's 98,883 triangles.
  - **X1's triangles:** 941,198 in all: 933,344 target, 10 neighbours and 7,844 ground. That is 99.999% of its standing
    triangles as target. Under the old rule all 933,354 would have been neighbours.
  - **X1's agreement, by region:**

    | View | Distance | Target in the photo | Neighbours in the photo | X1 building | X1 neighbours | X1 ground |
    |---|---|---|---|---|---|---|
    | v0 | 45.8 m | 89.5% | 4.2% | 1.00 | 0.00 | 0.06 |
    | v1 | 46.3 m | 34.0% | 36.7% | 1.00 | 0.00 | 0.03 |
    | v2 | 52.0 m | 19.7% | 80.3% | 1.00 | 0.00 | - |
    | v3 | 72.2 m | 12.6% | 83.7% | 1.00 | 0.00 | 0.08 |

  - In `masks_view1.png` (`docs/screenshots/m1_world_judge/esb_dryrun_x1/`, gitignored), X1's hero is red throughout,
    with a sliver of ground at its base. The street and the neighbours are missing, so its frame agreement falls to 0.47.
  - The reference's own mask still shows the 96.7% isolate match: part of the ESB's facade is blue in the reference, and
    X1 draws it red there. Fresh, uncached builds match fully (`matchedShare` 1).

Not verified: the outline has not met a fresh K build, a courtyard building, or a district arm with real abutting
neighbours.

## The isolate's target by its surface (2026-10-31, later)

**What the dry run found.** The preregistered ESB dry run on a fresh K build hit the stop rule `matchedShare` under 0.99,
at 0.967. That run was 0bb20154, with every stage a cache miss.
- In its reference mask a straight diagonal wedge of the building's own facade was labelled neighbour
  (`docs/screenshots/m1_prereg/esb_dryrun/masks_view1.png`).
- tile_refine cuts the isolate's triangles at its outline, so the isolate does not hold the tile's triangles one for one:
  - 4.9% of the isolate's triangles had no tile triangle with the same centroid, even at 5 cm;
  - by area, 2.5% of its standing parts had none.
- The tile triangles they were cut from were left out of the target.

**The rule now** (`onSurfaceFlags` in `photo-match-evaluate.ts`). Geometry decides, nothing else.
- A tile triangle is the target when its centroid lies on the isolate's surface: point-to-triangle distance within 3 cm
  (`PHOTO_MATCH_ISOLATE_SURFACE_M`, the seam weld's tolerance), through a 2 m grid over the isolate.
- A triangle the isolate holds cut into pieces is found whole.
- A triangle the cut runs through goes by where its centroid falls.

**`matchedShare`.** It is now by area (`surfaceCoverShare`): the share of the isolate's area within 3 cm of the tile
triangles labelled target. Each isolate triangle is sampled at four interior points, each standing for a quarter of its
area. The earlier count is reported beside it as `matchedShareByTriangles`.

**On run 0bb20154 (the ESB):**

| | Before | After |
|---|---|---|
| Tile triangles labelled target | 95,646 | 105,452 |
| `matchedShare` | 0.967 (by count) | 0.996 (by area) |

The tolerance hardly matters: 0.9958 at 1 cm, 0.9963 at 3 cm, 0.9967 at 5 cm. The labelling takes under a second.

**How it was checked** (`photo-match-evaluate-tool.test.ts`). The test isolate has the synthetic block's target cut into
four pieces a face, plus a ground triangle cut at x = 7.
- Centroid-to-centroid matching found none of the cut target.
- On the surface:
  - all ten of the target's tile triangles are found, and nothing of the street or the neighbour;
  - the straddling triangle goes by its centroid both ways;
  - a wall moved 6 cm off the surface is not found.
- The area share is 1000/1001 (the 1 m² piece of ground is not covered).
- Through the tool, with that isolate, the target is the tile's 10 triangles, `matchedShare` is at least 0.99,
  `matchedShareByTriangles` is 0, and the raw scan's frame agreement is 1.00.

## Follow-ups

- **Eyes off the tile.** At the ESB, 9 of the 31 candidates stand beyond the tile's grid. Their eye is the structure's
  base plus 2.5 m, a guess the pose registration has to correct.
- **A target mask clipped at the footprint.** Large scan triangles that straddle the target's outline are wholly target or
  wholly neighbour; splitting them at the outline would sharpen both masks.
