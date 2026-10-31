# Street-level splat world: 7th Ave at Penn Station / MSG (plan, 2026-10-29)

**Vantage.** The west sidewalk of 7th Avenue at the Penn Station / Madison Square Garden entrance, eye height 1.6 m,
looking east across the avenue. The user should be able to stand there, look around, and walk the sidewalk.

**What it extends.** `location_generate_3dgs` (`Location3DGaussianSplatService` → `SurveySplatPipelineService`:
stations → beautify → `scripts/station_to_splats.cpp` bake on the mesh's own depth → voxel fuse → `splat_to_3dtiles`).
Today every station is a beautified render of the clay tiles from synthetic cameras at +5 m and +25 m. This plan adds
**street-level stations posed by real Street View panos and conditioned on their pictures**, plus an infill pass
along the walk path.

**What it does not use.** COLMAP / splatfacto. The cameras are known (survey stations exactly; Street View frames after
`StreetViewPoseRegistrar`) and so is the depth (the tiles mesh), so bake forward, never re-estimate (AGENTS.md §3.5,
§5). `survey_export_colmap` stays for anyone who wants to train elsewhere.

## Built so far (2026-10-29): phase 2, from existing code

Nothing new was written as machinery. The street stations reuse the staged build's Street View evidence path, and the
splat pipeline's beautify, bake and fuse run unchanged.

- **`spatial/street-view-stations.ts`** (new, glue only): `planStreetViewStations` takes a vantage (lat/lng, look
  heading, walk length, reach) and does the following:
  - discovers panos at a street grid across the look direction (`discoverPanosAt`, Google captures only, the staged
    metadata cache);
  - asks four views per pano: ahead, ±55° and behind, 12° up, 70° fov, 3:2 (`fetchViews`, bytes in memory);
  - registers them against the **same clay GLB** the splats are baked on (`runPanoRegistrationOffThread`), so the
    poses need no frame conversion;
  - turns each camera into a station (`castCamera` → `stationForFrame`). The roll is kept in the vectors only: the
    renderer would otherwise apply it twice, and the baker reads only the vectors.
- **The beautify:** `BeautifyStationService` has a `groundingPhoto` option. It uses the existing, previously unused
  `buildStreetViewSeedBeautifyPrompt`: the photograph is transformed, obstructions are cleared, and the light is
  even. The chained warp is not used for these stations. The result names its pano and capture month.
- **The Google station generator** sends the photograph alone, inline, as the source image. A new
  `inlineSource` option on `GoogleMediaGenerationService.generateImage` means it never goes through the asset store.
- **`SurveySplatPipelineService`** has a `streetStations` option. These stations run first, are never ranked out, and
  report `groundingPanoId` / `groundingDate` in the station reports and `tileset.meta.json`. The fuse priority needed
  **no C++ change**. `station_to_splats.cpp` already prefers low, sharp street-level splats (`wGround`, line 322), and
  takes the first station's colour as its exposure target, which is now a street view.
- **`location_generate_3dgs`** takes `vantageHeadingDeg`, `walkMeters` and `streetViewPanos`. The handler builds the
  same Street View deps as the staged build: the Maps key, the grounding service on the service account, and the
  staged metadata cache.
- **Tests:** `packages/core/test/street-view-stations.test.ts`, 8 tests run with no credentials reachable. They cover
  pose, heading and pitch sign, the photograph carried byte for byte and written nowhere, the seed prompt, the
  generator sending one inline image, and a full pipeline run that bakes the street station first and names its pano.

**Not done yet.** Phase 0 and 1 live runs at the vantage. Phase 3, the walk-path infill. Phase 5, the judging.
Per-splat provenance: today it is per station, in the meta.

**To run it at the vantage** (in the app, chat or tool):
`location_generate_3dgs { location: "Penn Station 7th Avenue entrance, New York", lat, lng (the west sidewalk), vantageHeadingDeg: 90 }`.
Clear the stage caches first. Then judge only the uncached run.

## The constraint that shapes it

Street View bytes are **never written, cached, logged or re-encoded**. They stay in memory, go into the request, and
are dropped (`docs/processes/staged-location-builds.md:62`). Only pano ids, locations and dates may be cached. So
**real Street View pixels cannot be baked into the splats**. What MIG allows is Street View *as input to image
generation* (`StreetViewGroundingImageService`). So a street-level station is:

1. the registered pose of a Street View frame;
2. a render of the tiles at exactly that pose (the outline and depth the bake uses);
3. a beautify of that render with the Street View frame as its reference image (in memory, then dropped);
4. the generated image baked onto the mesh depth, labelled `generated` and recording that it was conditioned on pano
   `<id>` captured `<date>`.

That is literally "survey station + AI beautify to match the image qualities". The beautify gets the real place's
materials, colour and signage from the pano while staying locked to the tile geometry it is baked onto. **To check
before shipping:** whether the MIG / Maps Platform terms allow keeping a 3D splat derived from generation outputs
conditioned on grounding images, and keeping splats derived from Photorealistic 3D Tiles.

## Site-specific risks (each checked in phase 0, not assumed)

- **Different eras.** The blocks across 7th Ave from Penn have been rebuilt in recent years. The tiles and the panos
  may show different buildings. Read the pano dates (MIG metadata) and compare each frame with the tile render. Where
  they disagree, the tiles win (they are the geometry), and that frame is dropped as a reference with the reason given.
- **Transients.** Crowds, taxis, buses, sidewalk sheds and scaffolding. Use `streetview_survey`'s temporary-structure
  check (`temporary-structures.ts`), `detectOccludersWithGemini`, and `vfx_segment_subject` for people and vehicles.
  Masked regions are not used as reference content.
- **Pano position.** The panos are car captures in the roadway, roughly 10 m east of the vantage. A tall street canyon
  makes GPS error large, but it also gives a narrow, well-defined sky, which the registrar's sky-silhouette term handles
  well. Use `TEXTURING_GATES`.
- **Behind the viewer.** The MSG / Penn entrance canopy is an overhang, and tiles are poor under overhangs. Expect weak
  geometry there. The plan scores the eastward view first.
- **Light.** Street View is real sun, varying by capture date. Station beautify is even overcast light by rule
  (`EVEN_LIGHT_SENTENCE`). This is an open decision (below).

## Phases

### 0. Pin the site (no image-model calls)
- Geocode the vantage (`GoogleMapsService`). Extract fresh clay tiles, never from a stale `public/models` GLB, with a
  crop of about 200 m along the avenue (W 31st to W 33rd and a margin) by about 80 m across, grown to whole buildings
  (atomic building integrity) and unbounded upward.
- Discover panos on the free metadata endpoint along 7th Ave between W 30th and W 34th, Google captures only, plus any
  on the west sidewalk. Record ids, positions and dates.
- **Done when:** a table of panos with dates, distance from the vantage, and the tile render beside each candidate
  heading's outline, in `docs/processes/`.

### 1. Register the street-level frames
- For each pano: frames at headings covering east (primary), north, south and west, with a horizontal FOV around 60°.
  Fetch them through `StreetViewGroundingImageService` and register them with `StreetViewPoseRegistrar` (one rigid
  correction per pano) against the clay GLB. Masks: occluders, transients, sky.
- Keep only the poses (`stationForFrame`) and masks. Images stay in memory, so beautify runs in the same process pass,
  or refetches by pano id + heading (allowed: ids are cacheable).
- **Done when:** registration overlays (`renderRegistrationOverlay`, written from the tile render side only) pass
  gates for the eastward frames. Report rejected frames and why.

### 2. Street-level stations in the pipeline (code)
- `SurveySplatPipelineService.run`: accept `referenceStations`, each a pose + intrinsics + a function that yields the
  reference bytes on demand + a mask. For these, beautify the tile render at the pose with the reference as the
  conditioning image (the outline lock and edge QC unchanged), then bake as now. `bakeStation` already takes
  rgb + depth + pose, so the baker is unchanged.
- **Chained mode seeded from the street:** the first accepted street-level image is the consistency reference for
  the +5 m / +25 m synthetic stations that follow, so the upper floors match the street's materials.
- **Fuser source priority** (`station_to_splats --fuse-list`): today the fuser keeps the most face-on view and
  averages near-ties. Add a per-station weight (pose quality × reference-conditioned bonus), and provenance per splat
  (`generated` + conditioned-on pano id or synthetic station id), written to `tileset.meta.json` and the GLB extras.
- `location_generate_3dgs`: one new argument, a vantage (lat/lng, eye height, look heading, walk length), that turns on
  street-level stations and centres the crop. No new tool.
- **Tests (no billing):** a fixture plate with a known pose → the baked splats land on the mesh within tolerance; fuse
  priority picks the higher-weight station on overlap; provenance survives into the tileset meta. Assert counts and
  values, never mocks only.

### 3. Walk-path infill
- Render novel views from the fused splats along the west sidewalk (every 3 m at 1.6 m, looking east, plus a 360°
  turn at the entrance). Mark holes (disocclusions behind columns, under awnings, where transients were masked), fill
  them with `image_infill_holes` (rim-checked, `generated`), and bake only the hole pixels on the mesh depth.
- **Done when:** less than 2 % of pixels on the walk renders are holes, and no fill is accepted that fails its rim check.

### 4. Optional: street-furniture depth
Where the tiles' depth is blobby (trees, lamp posts, kiosks), refine per-plate depth with Depth Anything V2 Small,
fitted to the mesh depth (scale and shift), only within the masked furniture, labelled `photo-inferred`. Skip this
unless phase 5 shows smearing on parallax.

### 5. Judge it
- **Baselines at the same vantage:** (a) today's `location_generate_3dgs` (synthetic stations only), (b) street-level
  stations only, (c) both, (c+) both plus infill. Clear stage caches and restart before each build; judge only
  uncached runs.
- **Held-out views:** two or three Street View frames near the vantage, eastward, never used as references. Render
  the splats at their registered poses and score with `photo_match_evaluate` on static, unmasked pixels (identity and
  realism).
- **In the app:** walk the path in the viewport, take screenshots at milestones, review them with the
  `screenshot-review` skill; count floaters (prune report), hole share, and the provenance share per view.
- Record the run in `docs/processes/` with a README row.

## Open decisions (yours)

1. **Light.** Bake even overcast light (house rule for stations, and it relights cleanly), or keep the real sun of one
   chosen capture date, because a navigable world is the final picture, as `lighting: 'scene'` is for 2D?
   Recommendation: even light. Mixed-date panos would otherwise bake contradictory shadows.
2. **Era.** If the tiles and the panos show different buildings across the avenue, keep the tiles' era (consistent
   geometry), or stop and report?
3. **Terms.** Who checks whether the MIG / 3D Tiles terms allow persisting the result?

## Cost (rough)
Metadata discovery is free. MIG: about 8 to 12 panos × 4 headings. Nano Banana: about 30 to 40 street-level beautifies
plus 12 synthetic stations, with rerolls. Infill: one call per walk render that has holes. Registration and baking are
local.
