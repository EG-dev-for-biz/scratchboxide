# Feature 1: a hyper-realistic real world (plan, 2026-10-30)

**What it is.** Given a real place, the app builds the place, not just one building: the hero building from pipeline K,
its neighbours, the street, the ground and its planting, the water, and the terrain out to the horizon. It uses Google's
measured data wherever it exists, and believable, labelled fill wherever it does not (AGENTS.md §4, "Believability
first"). It is mesh only: splat worlds are a separate side project (user decision, 2026-10-30), and neither track depends
on the other.

**Why this replaces the earlier draft.** The draft treated terrain, water and ground cover as unbuilt, the material
regions as off, and the sun as unwired. In the code, most of the parts exist. What does not exist is one build that runs
them together: pipeline K builds one building and skips everything around it, and the district build has the
surroundings but no K hero. Combining the two is the feature.

## What exists today (checked 2026-10-30)

| Part | Where | State | What is missing |
|---|---|---|---|
| Hero building | `pipeline-k/`, isolate builds | The 3D Building default | Skips vector massing, vehicles, terrain, roads and trees (`orchestrator.ts` `PIPELINE_K_ISOLATE_SKIPPED`) |
| Neighbours | `district-massing.ts`, `district-e-detail.ts` | On by default in non-isolate builds | Never runs beside a K hero |
| Vehicles removed, trees measured and regrown | vehicles stage; `scratchbox_tile_vegetation.hpp`, trees stage | Non-isolate builds | Skipped around a K hero |
| Tree species library | `assets/vegetation/species/index.json`, `scratchbox_tree_species.hpp` | 17 real species stored as data (continuous proportions, names as labels), chosen per crown by its measurements and the climate | No ground-cover entries (lawns, beds, hedges) |
| District edge | `extraction-sizing.ts`; the tree strip | An isolated structure's extraction grows until the structure is whole; crowns at the edge are kept as scanned (`cut_at_boundary`) | I found no step that grows a district's edge to whole buildings or whole trees |
| Ground surface and land-use program | `procedural-ground.ts` | Only with `SCRATCHBOX_STAGED_PROCEDURAL=1` | Computes a low-vegetation density per region, but never plants it: "SB-Veggie … has no low-vegetation input yet" |
| Grass map | `grass-detect.ts`, `location_grass_map` | A tool | Not used by the build |
| Road surfaces | `road-surfaces.ts` (SB-Roadie) | Shelved 2026-10-21 (`SCRATCHBOX_STAGED_ROADS=1`) | Waiting on the carve-under-the-ribbon work and a real-place photo-match judging pass |
| Water | `bridge-build.ts` `writeWaterGlb`: Google vector water areas, colour from the tile photo | Procedural district builds only, and only when the bridge build finds a water level | Not a layer of its own |
| Terrain | `terrain-surround.ts`: Google Elevation heightfield, 50 m grid to 1 km, 150 m to 4 km | Non-isolate builds | No texture or material; a deliberate 15 m clear strip (`TERRAIN_HERO_GAP_M`) around the tiles' ground |
| Erosion | `scratchbox_nature.hpp` `simulateHydraulicErosion` | In the engine | Not wired to staged places |
| Sun and weather | `scene-weather.ts` `applySceneWeather` | Done: NOAA ephemeris at the scene's geoAnchor | — |
| Material regions | `pipeline-k/material-regions.ts` | On by default (2026-10-30) | — |
| De-light, harmonise, roof-shadow lift | `tile-refine-twin.ts`, `pipeline-k/` | Harmonising runs only on a K isolated building (`kTwin`); the roof-shadow lift on a district only with its switch set to 1 | Surroundings keep the scan's baked light |
| Photo-match judge | `photo-match-eval.ts`, `photo_match_evaluate` | Renders arms from held-out real photo poses and scores them | Its secondary numbers are measured inside the building mask only |
| Satellite reference | `ortho-reference.ts` (Google Static Maps) | The judge's second opinion from above | — |

## Switches (user decision, 2026-10-30: separate them clearly)

Today `SCRATCHBOX_STAGED_PROCEDURAL` carries two unrelated things:
- the one building's pipeline, as a letter `g`, `h`, `i`, `j` or `k` (read by `staged-location-tool.ts`, `pipeline-h.ts`
  `stagedProcedural` and `pipeline-k.ts` `stagedPipelineK`);
- whether the district is shown rebuilt, as `1` (read by `district-massing.ts` `proceduralDistrictEnabled`). This also
  forces district massing on, even when `SCRATCHBOX_STAGED_DISTRICT_MASSING=0`.

Proposal:
- `SCRATCHBOX_STAGED_BUILDING_PIPELINE=g|h|i|j|k`: the one building's pipeline. The request's `pipeline` still takes
  precedence.
- `SCRATCHBOX_STAGED_DISTRICT=scan|massing|rebuilt`: the district shown as scanned (today's `DISTRICT_MASSING=0`),
  with pipeline E's massing (today's default), or rebuilt (today's `PROCEDURAL=1`). This replaces
  `SCRATCHBOX_STAGED_DISTRICT_MASSING`.
- The old variables are no longer read. If one is set, the server says once at start which variable replaces it, so a
  stale environment never silently changes a build.
- Update AGENTS.md (the pipeline J line names the old variable), the `pipeline` description in `spatial-tools.ts`, and
  `pipeline-h.test.ts` / `pipeline-i.test.ts`.

Built 2026-10-30 (`staged-switches.ts`; the server reports a retired switch at start and again at the first build).

**Pipelines reviewed the same day (user decision, 2026-10-30).** Of the 188 build records on disk since 10-25, 176 ran
pipeline K and none ran G, H, I or J. So:
- K stays the one-building default.
- I and J are one pipeline, J, with the model service as a setting: `modelService` in the request, or
  `SCRATCHBOX_STAGED_MODEL_SERVICE=meshy|trellis` (Meshy by default; Trellis was pipeline I). The staged tool still
  takes `pipeline: 'i'`, as J with Trellis.
- G and H are retired as choices. The tool refuses `pipeline: 'g'` or `'h'` with that reason, and their code is kept,
  frozen, with the survey modules J's refine step uses.
- `SCRATCHBOX_STAGED_BUILDING_PIPELINE` therefore takes `j|k`.

Existing work for M2 and M3: the unmerged branch `feat/pipeline-kd` runs K over a whole district in chunks, with a
district-wide harmonise, a shadow lift on upward surfaces and street clutter removed. It still reads the old switch, so
it needs the new switches when it merges: `kd` belongs under `SCRATCHBOX_STAGED_DISTRICT`, not as a building letter.

## Milestones

**M0: See it.** Run fresh, uncached builds at every benchmark place (M1) in today's two modes: K isolate, and a
non-isolate build with the procedural district on. Screenshot each from a Street View pose at street level, from above
over the tile edge, and at eye level toward the horizon. Write the findings to `docs/processes/` and add a README row.
*Exit:* a list of what reads as false, ranked by how much of the screen it covers. The order below is re-checked
against it.

**M1: The world judge** (built before the other work, so every later milestone is scored the same way). Extend
`photo-match-eval.ts` beyond the building mask: score the whole frame, plus separate masks for the ground, the
neighbours and the skyline, from held-out Street View photos with registered poses. Benchmark places in Manhattan,
San Francisco and Los Angeles (user choice, 2026-10-30; the specific places are proposals):

| Place | What it tests |
|---|---|
| Empire State Building, Manhattan | Dense and tall; the existing building benchmark |
| Haughwout Building, SoHo, Manhattan | Low-rise street; the existing staged-build baseline |
| Bryant Park, Manhattan | Park edge: lawn, plantings and plane trees hard against tall buildings |
| Ferry Building, Embarcadero, San Francisco | Waterfront, plaza and the bridge |
| Dolores Park, San Francisco | A sloping lawn, palms, and the skyline as far field |
| Griffith Observatory, Los Angeles | Hillside, with the horizon across the basin |

Each milestone's exit runs only at the places where its gap shows, so that fresh builds stay affordable.
`GeometricComplexityGate` is not a measure here, because measured geometry is exempt from it. *Exit:* today's two modes
scored at every place, repeatably within the judge's spread. This also provides the real-place judging pass SB-Roadie
is waiting for.

**M2: One build, the hero in its place.** A build that runs K's isolate pipeline on the chosen structure and the
non-isolate surroundings, in one run and one frame:
- Surroundings: the tiles with vehicles removed and trees measured and regrown. The neighbours come from district
  massing or from the cleaned scan; both run as arms in M1 and the judge decides (user decision, 2026-10-30).
- The context loses everything inside the hero's footprint plus 0.3 m (the same clip as K's `clipToFootprint`), so the
  hero and the scan never overlap. Check where the hero meets its neighbours: K draws no party wall.
- K's base cleanup removes the street and expects the scene's ground to stand in. Here the procedural ground supplies
  that ground.
- Buildings still win over trees; the hero's footprint rule is unchanged.
- The build is selected with the separated switches (above).

*Exit:* at every benchmark place, one build with hero, neighbours, street and terrain; no overlapping surfaces and no
gap at the hero's base; on the hero mask the judge scores no lower than K isolate, and on the whole frame it scores
higher than both of today's modes.

**M2a: Whole at the district's edge** (user decision, 2026-10-30). No building or tree built inside a district is cut
off by the district's edge. The edge grows, as an isolated structure's extraction already does, until every building
it touches (by its Google vector footprint, else its scan component) and every tree crown it touches (by its crown,
not only its apex) is whole. The stopping rule is the same as the isolate's: a few rounds, up to a cap. If something
still cannot be made whole, the edge leaves it out entirely, with the reason, rather than show it cut. Crowns are no
longer kept as scanned at the edge (`cut_at_boundary`). AGENTS.md §5 ("Atomic building integrity") gains trees.
*Exit:* at every benchmark place, no building or crown is cut where the district ends, seen from above; the build
reports how far the edge grew and anything left out.

**M3: One look across hero and context.** The hero's photos are de-lit and harmonised; the context's are not, so the
seam where the hero meets its neighbours shows as a jump in colour and light. Run the de-light and the per-photo
gain and seam levelling (`texture-harmonize.ts`) over the context tiles as well, with the hero as the reference, and
turn the roof-shadow lift on for the context. *Exit:* no visible step in colour or light at the hero's edges, in
screenshots and in the judge's neighbour mask; the hero's own score unchanged.

**M4: Ground cover.** Give SB-Veggie a low-vegetation input and feed it the ground program's density per region. The
plants come from real species, as the trees already do (the species carve-out, user decision): extend the species
library with ground-cover entries (lawn grasses, bedding plants, hedge shrubs). Each entry is data with continuous
proportions (height, density, leaf or blade size, clumping) and its name as a label, chosen per region by what was
measured there (greenness, roughness, height above the ground) and by the climate. The library already grows a
many-stemmed entry as a shrub, which is a start for hedges. Adding a species is a data change, never a code change; this
goes through the library, not the older `PlantArchetype` enum in `scratchbox_plant_builder.hpp`. Grass seen from above
(`grass-detect.ts`) is labelled photo-inferred; ground hidden under crowns inside a park outline that continues the
nearest seen surface is labelled generated. Buildings still win. *Exit:* the build note no longer says "not planted";
at Bryant Park and Dolores Park the judge's ground-mask score improves, within the scene's budget.

**M5: Street level.** The first few metres around a viewer: carriageway, kerbs, sidewalks and paving. Bring SB-Roadie
back once M1 gives it its judging pass and the carve-under-the-ribbon work lands. Draw paving from the texture library
at its real size, with the material regions' roughness and normal. *Exit:* at street-level poses, the judge's
ground-mask score is higher than after M2.

**M6: Tile edge to terrain.** First measure the height step between the tiles' ground and the terrain along the tile
edge, and report how it is distributed. Then replace the 15 m clear strip with a blend strip stitched to the tile
edge's loop and to the terrain's inner edge. It is measured at both ends and generated in between (labelled), and
carries the tiles' ground colour across. *Exit:* no hole or step visible, from above or at eye level, at any benchmark
place.

**M7: Water as its own layer.** Take `writeWaterGlb` out of the bridge build, so that any place with Google vector
water areas gets the water layer. The water level is measured from the scan at the water's edge. The layer is shaded
with the scene probe's reflection, as glass already is (`facadeMaterialLook.ts`). Water is never drawn where the vector
data shows none. *Exit:* Federation Square shows its river without the bridges switch, and the waterfront score rises.

**M8: The far field.** Today the terrain is a measured heightfield with no texture or material. In order of preference:
1. A ring of coarser-LOD Google 3D Tiles outward, giving real photos and real buildings to the horizon. The ring
   starts outside the district's grown edge (M2a), so no building or tree is ever half fine and half coarse. This still
   needs a user decision: AGENTS.md §5 says to stream to the deepest leaf LOD. That rule is about the extraction, and a
   far ring at the LOD its screen size calls for is a different use.
2. Where the tiles have no 3D coverage: the terrain textured from land cover and a measured colour, with relief finer
   than the grid from `simulateHydraulicErosion`, constrained so that no measured sample moves (labelled generated).

*Exit:* the eye-level horizon at the hillside place reads as the real place in the judge, and no measured sample has
moved.

## Order

- The switch split: built.
- M0 and M1 next, side by side.
- M2, M2a, M4, M6 and M7 then touch different files (the orchestrator; `extraction-sizing.ts` and the tree strip;
  SB-Veggie, the species library and `procedural-ground.ts`; `terrain-surround.ts`; `bridge-build.ts`). M2a, M4, M6
  and M7 can each be built and judged in today's non-isolate district build, so they need not wait for M2. They are
  candidates for separate sessions.
- M3 after M2; M5 after M1; M8 after M2a and the LOD decision.

## Decisions

Made (2026-10-30):
- The two meanings of `SCRATCHBOX_STAGED_PROCEDURAL` get separate switches.
- Tree and plant species are a carve-out from AGENTS.md §1: real species, stored as data and chosen by measurement.
- Neighbours: district massing or the cleaned scan, decided by the M1 judge.
- No building or tree inside a district is cut by its edge (M2a).
- Benchmarks in Manhattan, San Francisco and Los Angeles.
- No street furniture in v1.

Still open:
1. The far-field LOD ring (M8.1), as an exception to the deepest-leaf rule.
2. The specific benchmark places proposed in M1.
3. AGENTS.md does not record the species carve-out yet; §1 should say so, so that agents stop flagging the library.

## Out of scope

- Splat worlds: a side project (2026-10-30).
- Street furniture (signs, lamp posts, bins): not in v1 (2026-10-30).
- Genie-conditioned dynamics: not on AGENTS.md §2's supported list, and its output is video frames, not geometry. It
  needs a decision before it becomes Feature 2.
- CAT3D-class view synthesis: unsupported (§2), and it generates views only to reconstruct 3D from them, against the
  forward-mapping rule (§3.5).
- Climate-field vegetation (moisture, temperature) at real places: only where nothing is measured, labelled generated,
  if used at all (M8.2).
- Wholly invented procedural worlds: Feature 3, reusing this feature's terrain, planting and water without the
  grounding.

## Rules every milestone keeps

- Every new layer carries provenance labels (`measured`, `vector-modelled`, `photo-inferred`, `generated`) with the
  real reason for any fill.
- No uninvited atmosphere (§3.6); the weather appears only when asked for.
- Buildings win over trees; the hero's footprint rule is unchanged.
- Every judgement is made on fresh, uncached builds in the live app.
- Tests never bill.
