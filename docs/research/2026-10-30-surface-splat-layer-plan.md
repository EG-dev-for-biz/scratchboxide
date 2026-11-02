# Surface splat layer: one splat per surface patch, not per photo pixel (plan, 2026-10-30)

**Why.** In the 7th Ave / Penn Station world (`docs/processes/street_view_splat_world_7th_ave_penn.md`) the splats are
plentiful but too small for their spacing:

| Distance from the vantage | Splats | Median size | Per occupied 0.5 m cell |
|---|---|---|---|
| 0–10 m | 160 k | 0.7 cm | 84 |
| 10–25 m | 734 k | 0.7 cm | 68 |
| 25–50 m | 1.79 M | 1.6 cm | 57 |

The spacing is about 6–7 cm against splats 0.7–1.6 cm across, so about 2% of each surface is covered and you see
through it. The cause: each station bakes splats sized for its own pixels, and the fuser keeps one per 8 cm voxel
without growing it. Coverage also depends on which photos happened to see a surface, so anything no station saw is a
hole.

**The change (Mesh2Splat-style, user choice "option 3").** Splats come from the **scan's surface**, not from the
photos. Every patch of surface gets a splat at a spacing chosen for where the viewer walks, and the stations only
**colour** them. Coverage then follows the geometry, so no surface is left with a hole. This is forward mapping (AGENTS.md 3.5): the
geometry and the cameras are known, nothing is re-estimated, and nothing is trained.

## Design

1. **Geometry.**
   - Use the clay extraction the world is built on (no UVs, no texture: 146 primitives, 113 k triangles at this
     place). Contain it to the hulls first: the same rule as `splat-containment.ts` applied per triangle, so the pits,
     the car lumps and anything above the scan are never sampled.
   - The **textured** extraction of the same area (`google_3d_tiles_get_full_texture`) is fetched only for the fallback
     colour (step 3).
2. **Sampling: spacing by distance to the walk.**
   - Spacing is `s = clamp(k * distance to the walk corridor, s_min, 25 cm)`. The corridor is the vantage's walk
     segment (60 m along the sidewalk).
   - `k` is about 2 px at 1920 wide and a 70° field of view: about 1.2 mrad for full detail, up to 2.5 mrad for a lighter
     world.
   - Each triangle gets stratified samples at its own `s`, so a small triangle near the walk gets several and a large
     one far away gets few.
   - Measured here, all 196,000 m² above the street:

     | Spacing | Splats | Within 15 m of the walk |
     |---|---|---|
     | 1.2 mrad × distance, min 1.5 cm | 84.4 M | 33.4 M |
     | 1.8 mrad × distance, min 2.0 cm | 40.7 M | 18.0 M |
     | 2.5 mrad × distance, min 3.0 cm | 20.2 M | 8.3 M |
   - **Visibility budget.** These totals include roofs and back faces nobody on the sidewalk sees. A surface no station
     and no point on the walk corridor sees is sampled at the far spacing (25 cm), coloured by the fallback. The target
     is under 10 M splats at about 2 mrad.
3. **Colour per sample (training-free texture mapping, after Waechter et al.).**
   - **Candidates:** the stations that see the sample (in frame, not occluded by the station's own depth buffer
     beyond a tolerance, and `|n·view|` above 0.26, about 75°).
   - **Scoring:** each candidate is scored by its projected pixel area (`cos / distance²`). The two best are blended,
     weighted by score, and the best view dominates.
   - **Per-station correction:** each station gets a gain and an offset fitted where stations overlap, to remove
     colour drift; it is training-free, after VastGaussian. `StationRadianceEqualizer` already fits per-station gains
     and is reused.
   - **Street stations first:** they win ties, since they are the only views made from a real photograph.
   - **Fallback:** a sample no station sees takes the textured extraction's own colour at that point, labelled
     `vector-modelled`/`photo-inferred` per AGENTS.md section 4. Provenance is kept per splat: station id or fallback,
     as a byte in an extras channel of the tileset.
4. **Splat shape.**
   - A 2DGS surfel: the normal from the triangle, both in-plane sigmas `0.6 * s` so neighbours overlap, and a thin
     normal axis.
   - Its colour is a 2-tap average over the sample's footprint in the chosen view, not one pixel: a Mip-Splatting-style
     bound, so a far splat does not alias.
5. **Output and loading.**
   - The `.splat` file and the 3D Tiles tileset (`splat_to_3dtiles`, Morton octree with LOD) are written as now.
   - **The viewer must stream the tileset:** today the 3D Scene loads `splatUrl` as one file and ignores
     `splatTilesetUrl`. At 5–10 M splats one file is 160–320 MB, so this step is required, not optional.

## Where it lives (reuse first)

* **Native:** `scratchbox_surface_splats.hpp` (the sampler, the per-sample best-view colouring and the surfel writer)
  and a small CLI driver, `scripts/mesh_to_surface_splats.cpp`, built like `station_to_splats` with
  `buildNativeIfStale`. Both read the station plates and depths the pipeline already writes per station.
* **TS:** `SurfaceSplatLayerService` (node/spatial) prepares the inputs (contained triangles, the corridor, station
  plates, the fallback texture) and runs the driver.
* **Pipeline:** `SurveySplatPipelineService` gets `surfaceLayer: true`, set by `location_generate_3dgs` for a street
  vantage. It replaces the per-station bake and the voxel fusion, and keeps the beautify, the anchoring, containment
  and tiling as they are.
* **Viewer:** the 3D Scene loads `splatTilesetUrl` through the existing 3D Tiles path with the
  `KHR_gaussian_splatting` content (to check: whether the tiles renderer in use reads it; if not, page the octree's
  tiles directly).

## Phases and checks

1. **Sampler and colouring on a synthetic scene (tests, no billing).**
   - A box on a ground plane and two stations with flat known colours. Each face takes the colour of the station
     that sees it head-on, a face only one station sees takes that one, an occluded face takes the other, and an
     unobserved face takes the fallback.
   - The spacing follows the distance rule, the splat count stays within the budget, and the surfels lie on the faces
     (within 1 mm).
2. **Run it on 7th Ave with the existing station images (no image calls).**
   - Coverage: at least 95% of each 0.5 m cell of the visible surface covered by splat discs, against about 2% now.
   - The splat count and file size against the budget.
3. **The viewer streams the tileset.** Measure the time to first view and to full detail at the vantage.
4. **Judge.**
   - Viewport screenshots in four directions plus the walk; held-out Street View frames scored with
     `photo_match_evaluate` against today's world.
   - Store the result in the world cache (new key: `WORLD_CACHE_VERSION` bumped to `v2`).

## Risks

* **The clay mesh is blobby at street level.** Surface splats show the blobs' shapes honestly, where today's sparse
  splats hid them. The street-level stations still paint them, so this is a geometry limit: noted, not fixed here.
* **Two-view blending can ghost** where two stations disagree (generated images drift). The best view dominates, and
  ghosting falls as the per-station correction improves.
* **Load time** depends on step 5.
