# Pipeline K-D: a district shadow pass for roofs and ground, and a district-wide harmonise

**Status:** design, reviewed. Nothing here is built.
**Date:** 2026-10-29.
**Review:** by the roof-shadow session, the same day. Its eight points are folded in below: §4.1 (the above test, sky visibility), §4.2 (confirmation needs edge cells), §4.4 (the lift as a world-space field, ratio by sky visibility, shadow edges), §4.5 (markings, trees), §4.6 (harmonise again), §5–6 (the Empire State Building as a regression check).
**Branch:** `feat/pipeline-kd`.
**Builds on:**
- the roof-shadow step (`pipeline-k/roof-shadow.ts`, commit `8242c97e` on `feat/cartesian-normal-snapping`, not merged here);
- the per-chunk seam stage (`pipeline-k/district-seams.ts`).

## 1. Why

Google's aerial photos carry the shadows of the capture's sun. A K-D district is then lit with the scene's own sun, for example "bright late-day light". The baked shadows point the wrong way and darken streets and terraces that should be lit.

The roof-shadow step lifts these shadows for one building. In a district it has to cover:
- **roofs, terraces and the ground** (streets, plazas, tracks): anything that faces up and is seen from above;
- **shadows cast across chunk lines and from outside the district.**

## 2. What we measured

The roof-shadow step at `8242c97e` was run offline on Shibuya. Inputs:
- **Run:** K-D run `c527da43`, 350 m radius, 44 chunks.
- **Grounds:** the 40 joined textured grounds, already harmonised.
- **Context:** each chunk was given its 8 neighbouring chunks' grounds as shadow casters (0.3–3.6 M triangles).
- **Results:** `.scratchbox/examples/live-c527da43/roof-shadow/` (the district audit image, the summary, each chunk's report, before/after views of chunk 23).
- **Scripts:** `.scratchbox/examples/tools/rs_shibuya.ts` and `rs_render.ts`.

| Area seen from above (the step counts any upward surface as roof, ground included) | m² | Share |
|---|---|---|
| Lifted | 114,171 | 27% |
| In shadow, rejected by the gates | 14,781 | 3% |
| No sun for its photo or terrace | 210,939 | 50% |
| Lit | 83,276 | 20% |

**Suns.**
- **Coverage:** only 592 of 2,629 photos got a sun: 139 from a deck fit, 453 from fits on their own terraces.
- **Spread:** those 592 suns fall in 71 different bins of 30° azimuth by 10° elevation.
- **Elevation:** median 40°, 10th percentile 20°, 90th percentile 70°.

A handful of capture flights would give a handful of suns. So most per-photo fits are probably passing the gates on noise.

**Seams.** The audit image is a patchwork of tile-sized squares. On the textures of chunk 23 (the station plaza), lifted photos sit next to unlifted ones as rectangular brightness steps. The lift is decided per photo, so it changes wherever the texture atlas changes photo.

**Reach.**
- **Needed:** a shadow reaches the building's height divided by the tangent of the sun's elevation. A 230 m tower (Shibuya Scramble Square) at the median 40° casts about 270 m; at the 10th percentile (20°), about 630 m.
- **Available:** the 8 neighbours reach 120–180 m past a chunk, and the step caps context at 250 m.
- **Edge chunks:** they need buildings beyond the 350 m radius.

**Cost.** 48 minutes over 40 chunks. Each chunk rasterises its 3M-triangle context once per candidate sun (144 coarse, then refined). Each triangle is rasterised by up to 9 chunks.

**Failure.** Chunk 5 threw "Invalid typed array length: Infinity" (reported to the roof-shadow session).

## 3. What changes from the per-building step

| Concern | Per-building step | District pass |
|---|---|---|
| What casts shadows | the twin plus a context mesh, rasterised per candidate sun | one district height map, swept per sun (§4.1) |
| How far | `contextRadiusM` 250 m | the reach from §2: max height / tan(elevation), plus a ring past the radius |
| Suns | fitted per deck, per photo, per terrace, all independently | a few capture suns fitted district-wide; each photo picks one of them or none (§4.2) |
| Where the shadow falls | per photo's own fit | geometry only: the same for every photo |
| How much to lift | per photo or terrace ratio | a world-space gain map per capture: shadow fraction times a ratio that depends on how much sky each point sees (§4.4) |
| Surfaces | up-facing and seen from above (roofs and ground alike) | the same, seen-from-above tested against the district height map (§4.1), with the per-photo sun confirmed at shadow edges (§4.2) |
| Trees | the twin as built | the scan's own tree crowns as shadow casters (§4.1) |

## 4. Design

### 4.1 The shadow height map

**What it is.** One height map for the district, holding the highest scanned surface in each cell:
- **Area:** the 350 m radius plus a ring of the reach, about 300 m. That's a 1.3 km square.
- **Cells:** 0.5 m inside the radius (1,400², about 2 M) and 2 m in the ring.

**Sources.**
- **Inside the radius:** the raw leaf tiles, already prefetched for the district into `.scratchbox/tiles_cache/leaves` under the server's working directory. This is the scene the photos were taken of: the scan's own trees and buildings, before vehicle removal or tree replanting. That is what should cast the baked shadows, not the trees K-D plants.
- **In the ring:** coarser tiles or Google's vector building heights (the vector stage already fetches footprints and heights). A shadow only needs metre accuracy there.

**Shadow per sun.** For each candidate sun, one sweep across the grid along the sun's direction gives each cell the height of the shadow line above it. This is the standard height-field shadow: one O(N) pass over about 2 M cells per sun. 144 coarse suns plus refinement take seconds, instead of rasterising 3 M triangles per sun per chunk.

**Testing a point.** A surface point is in shadow when it lies more than a bias below that cell's shadow line. The step already uses a 0.5 m bias plus the map's slope.

**Overhangs.** A height map can't hold them, for example a canopy over a pavement. A canopy's shade on the pavement is lost, which leaves the shadow unlifted rather than lifting anything wrongly. That's the safe failure.

**Only what's seen from above.** A surface point is a candidate only if it lies within the bias of the map's top for its cell, which is the shadow test with the sun overhead. The map holds the scan's tree crowns, so the ground under a crown sits below the map's top. Without this test it would read as shadowed under every sun and be lifted, though in the photo the crown covers it. The test also skips the scan's interior shells. It replaces the per-building step's own map from above.

**Sky visibility.** The same map gives each cell the share of sky it sees (V, between 0 and 1): a few horizon sweeps per cell, the same machinery as the shadow sweep. A canyon floor sees a narrow slot of sky, an open plaza nearly all of it. §4.4 uses V for the lift.

### 4.2 Capture suns, fitted district-wide

1. **Fit large surfaces first.** Every large plane (a deck or plaza with at least 1,500 cells, as the step's `minPlaneCells`) is fitted under the existing gates against the district height map. With district context, more of them pass: today only 139 photos took a deck sun.
2. **Cluster the accepted suns** within about 7° of each other. Keep clusters supported by at least N planes in at least two chunks. These are the capture suns, expected to be a handful.
3. **Choose one per photo.** Each photo with enough surface cells picks the capture sun its own cells confirm best, under the existing gates, or none. Confirming needs a minimum number of cells on both sides of that sun's shadow edges within the photo. A photo given the wrong sun would lift lit surface, so this check is the main guard. Choosing among a few known suns can't overfit the way a free 144-candidate fit per photo does. That free own-terrace fit is dropped: it's where the 71 bins came from.
4. **Fragments.** Small fragments that can't confirm a sun take the sun of the surface they belong to, the step's per-terrace rule, restricted to capture suns.
5. **Registry.** Results are stored per photo, keyed by the image's hash, so a photo seen by several chunks gets the same sun.

**Expected effect:** the "no sun" share drops and every lifted photo uses a plausible sun. The 71-bin spread becomes the test: after this, accepted suns should fall in a few clusters.

### 4.3 Where the shadow falls

From geometry only: is the point below the chosen sun's shadow line (§4.1)? The edge is soft, from the map's nearest cells, as the step already does. Two photos meeting at a boundary then agree on which side is in shadow. Today each photo has its own shadow decision, which draws the photo boundaries into the result.

### 4.4 How much to lift, without new seams

**The ratio depends on the sky a point sees.** A shadowed point is lit only by the sky it sees (V, §4.1), so its lit-to-shadow ratio is

ratio = 1 + (E_sun · sin el) / (E_sky · V)

where `el` is the sun's elevation and E_sun / E_sky is the capture's sun-to-sky strength. A canyon floor (small V) is darker in shade than an open plaza and needs the bigger lift. One ratio per capture would under-lift the canyon floors, which are most of the streets, and over-lift plazas. The lit-level cap hides the over-lift but not the under-lift.

**Fitting it.** E_sun / E_sky is fitted once per capture, per colour channel in linear light, from that capture's accepted planes, whose V is known. Shadows are bluer, so red is lifted more than blue.

**The lift is a world-space field.** Per capture, a gain map on the height map's 0.5 m grid holds each cell's shadow fraction times its ratio. Each texel samples the gain map of its photo's capture at its own 3D point. Photos of the same capture then meet without a step and need no fading. Where neighbouring photos come from different captures, their shadows really are in different places. The step there is the photos' own seam, and evening it out is harmonise's job. A fade of about 2 m across photo boundaries is kept only as a fallback, for photos with no capture sun next to lifted ones.

**Shadow edges.** At 0.5 m a shadow's edge is half a metre soft. The per-building step needed a 0.15 m map, together with the cap below, to avoid halos where a lifted edge spills onto lit surface at scan edges. Phase 1 checks halos at deck edges and parapets against the per-building step's close-ups (`docs/screenshots/view_relight_2026-10-29/roof_shadow_upper_terraces.jpg`). If they show, the map is refined to 0.15 m in a band of a few metres around each shadow edge.

**Capped.** The lift never exceeds the surface's lit level, as the step already does, so vents, rails and scan-edge mismatches don't glow.

**Before harmonise.** The pass runs before harmonise, so harmonise's seam levelling (one gain per photo plus smooth seam offsets) evens out what the lift leaves at photo boundaries. Running it after harmonise, as in §2's measurement, also leaves harmonise's per-photo gains wrong, because they were computed with the shadows still in. §4.6 covers running harmonise again.

### 4.5 Ground surfaces

- **Markings and patches.** With the shadow placed by geometry, paint and dark asphalt can't create a shadow. They can only skew a gate or the ratio. The real risk is a photo given the wrong capture sun, which would lift lit asphalt; §4.2's confirmation at shadow edges guards that. For the ratio, a shadowed patch counts only with a lit patch within about 3 m that the height map says is the same surface (same height within 0.3 m), so the ratio is measured on one material.
- **Vehicles.** The vehicle stage repaints cars out of the photos, but their shadows stay. They're too small for the height map to cast (cars are gone from the scan), so their shadows stay. They're small; accept.
- **Trees.** The scan's crowns cast the baked shadows (§4.1), so those shadows are lifted. K-D's replanted trees cast their own shadows live in the viewer. Where a replanted tree stands somewhere other than the scanned one, the lifted shadow and the new live one won't line up. That's acceptable. Ground under a scanned crown isn't lifted at all (the above test in §4.1).
- **Streets in canyons.** Mostly shaded by buildings across the street, often in another chunk. This is the main reason for district-wide shadows.

### 4.6 Where it runs

**Proposed order:**
1. Chunks build and join.
2. **District shadow pass** (new).
3. **District-wide harmonise** (new, §4.7) on the lifted photos, in place of each chunk's own.
4. Seam stage: colour levelling, then cut and snap.

The seam stage's colour levelling samples the bands along chunk lines. Baked shadows there skew its gains, so lifting first helps it too.

**Repeating harmonise.** Harmonise runs inside each chunk's build today, with the shadows still in. After the lift it has to run again, and §4.7 makes that one district-wide pass instead of 45 per-chunk ones. Lifting the harmonised photos (as measured in §2) and letting the seam stage level is the cheaper alternative. Phase 1 measures it, but it leaves harmonise's per-photo gains computed with the shadows in.

**One chunk at a time.** The pass reads one chunk's photos at a time, as the seam stage does: the height map and sun registry are small, the photos are not. Peak memory stays one chunk, which matters after the seam stage's earlier out-of-memory failure.

**Labels.** Every lifted texel is labelled `photo-inferred` (AGENTS.md §4), with the capture sun and ratio in the GLB extras. The run note keeps the district audit.

### 4.7 District-wide harmonise, walls and roofs

**Today.** Pipeline K's harmonise (`pipeline-k/texture-harmonize.ts`) runs in every K-D chunk on its own buildings:
- **Gains:** one gain per photo toward a reference per building, side and height band, walls and roofs apart.
- **Seams:** smooth per-photo offset fields where photos share a patch of surface.

On Shibuya (run `c527da43`) it was kept in all 45 chunks, and the median step where photos share a patch went from 0.129 to 0.115 in log colour. The chunks also straightened 1,233 of 1,799 facades, fitted windows on 1,829 and rebuilt 110 whole walls.

**What's missing.** Each chunk's references are its own, so the same street's facades can settle at different levels in neighbouring chunks. A building is owned whole by one chunk, so no single wall is split across a line. But buildings facing each other across a line can differ, and nothing compares walls between chunks. The seam stage gives each chunk one gain measured from the ground along its lines, and the walls ride along with it.

**Design.** One harmonise over the district, after the shadow pass, in two passes, one chunk at a time like the seam stage:
1. **Read.** Each chunk's photos are sampled as harmonise samples them today: per photo, its texels by building, side (facing direction) and height band, walls and roofs apart, upward surfaces only where seen from above (§4.1). Only the statistics are kept, never the photos.
2. **Shared references.** The district's references are pooled from every chunk's statistics, per side and height band, walls and roofs apart. One per building stays as now, but it is pulled toward the district's reference for its side and band, so a building keeps its own colour while neighbours across a line come to one level.
3. **Gains.** Each chunk's photos get their gains toward those references, solved once for the district. Brightness is levelled in full and hue only within a small cap. The per-channel ground gains in the seam stage tinted whole chunks; the same cap guards against that here (`maxHueShift`, 3%).
4. **Seams.** Each chunk's per-photo offset fields are fitted as today, within the chunk.
5. **Seam stage.** It keeps its ground colour levelling, which should now find gains near 1. A large gain there means the district harmonise left a step.

**Cost.** About what 45 per-chunk harmonises cost (around 50 s each, mostly applying the gains), parallel across chunks for the read and apply passes. The solve is small. Peak memory stays one chunk's photos.

**Not flattening.** Pulling every photo toward a reference can wash facades out, and the late-afternoon views of Shibuya look flat and grey. Harmonise sets one gain per photo, which keeps contrast within a photo. It's the per-band references that can make different buildings look alike. §5 measures it against the scan's own colours.

## 5. How we judge it

1. **District audit from above,** the same picture as today: lifted, rejected, no sun, lit. Target: "no sun" well under today's 50%, and no tile-shaped patchwork.
2. **Sun spread:** accepted suns fall in a few clusters, not 71 bins, and every photo's choice is confirmed on its own cells (§4.2): report how many photos were confirmed, and on how many edge cells.
3. **Seams across photo boundaries:** the median brightness step across photo boundaries on lifted surfaces, measured before and after the pass, as harmonise measures its patch pairs. It must not rise. Today's per-photo lift makes it rise (chunk 23). If it does rise, the pass is reverted for that chunk.
4. **Shadow contrast:** in lifted areas, the ratio between a lifted texel and a lit texel of the same surface nearby should be close to 1, for canyon floors and open plazas alike (§4.4's sky visibility).
5. **Street markings:** sample crossings and lane paint, then count lifted texels that are paint. Target: near zero.
6. **No glow:** no lifted texel above its surface's lit level, and no halos at deck edges and parapets (§4.4).
7. **Empire State Building regression:** on the per-building step's test building, the pass should match or beat that step: harmonised seams at 0.1263 or better, the 86th-floor deck lifted, no halos. Pipeline K could then use the same pass later.
8. **Walls across chunk lines:** the brightness step between facades of the same side and height band on either side of a chunk line, against the same measure inside a chunk (the floor). After §4.7 it should be near the floor.
9. **No flattening:** the spread of brightness within each facade, and between buildings of one side and band, against the scan's raw colours. Harmonise must not shrink either by much.
10. **Seam stage gains:** after §4.7 the seam stage's ground gains should sit near 1.
11. **Visual check:** the whole district from above, plus street-level views in canyons, before and after, in the app's viewer.

## 6. Phases

| Phase | What | Changes the pipeline? |
|---|---|---|
| 1. Prototype | Offline on run `c527da43`: height map from the cached leaf tiles plus a vector ring, the above test and sky visibility, capture suns confirmed per photo, the world-space gain field. Measured by §5 on the harmonised grounds, first without repeating harmonise. Also the Empire State Building, against the per-building step. | No |
| 2. District harmonise | Offline on the same run, after the phase 1 lift: §4.7's shared references and gains. Measured by §5 points 8–10, against both today's per-chunk harmonise and lifting without harmonising again. | No |
| 3. Integrate | A `shadows` stage and a district `harmonise` stage between the chunk joins and the seam stage, behind `SCRATCHBOX_KD_SHADOWS=1`, with run notes, the audit image and provenance. Each chunk's own harmonise is skipped when these run. | Yes |
| 4. Default on | After the visual review on Shibuya and one more district. | Yes |

**Effort.** Phase 1 is about one and a half to two days of work, with sky visibility and the Empire State Building check added. The Shibuya run itself should take a few minutes, against 48 for the per-chunk version.

## 7. Open questions

1. **Ring source.** Vector heights are cheap but flat-topped. Coarse 3D tiles are better, but are extra fetches at a lower level of detail. Start with vector heights and check the edge chunks' audit.
2. **Walls.** Façades also carry baked sun and shade. This design is upward surfaces only. Lighting walls needs the sun's angle to each wall and is a separate problem.
3. **The per-building step.** Keep it for isolated pipeline K builds (the review agrees). In K-D the district pass replaces it, so leave it off for K-D chunks (`SCRATCHBOX_K_ROOF_SHADOW` unset). If the pass passes §5's Empire State Building check, pipeline K can move to it later.
4. **Capture identity.** Google gives no capture time, so captures are inferred from sun clusters. Two flights with similar suns would merge, which is harmless: same sun, same shadows.
5. **Merging the roof-shadow commit.** The district pass reuses the step's gates and lift code. It means bringing `8242c97e` into `feat/pipeline-kd` (cherry-pick) at phase 1.
6. **How hard to pull each building toward the district (§4.7).** Fully, and every building of a side and height band looks alike. Not at all, and buildings across a chunk line keep their step. Phase 2 tries a few weights and judges by §5 points 8 and 9.
