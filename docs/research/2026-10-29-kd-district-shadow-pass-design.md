# Pipeline K-D: a district shadow pass for roofs and ground

**Status:** design, for review. Nothing here is built.
**Date:** 2026-10-29.
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
| How much to lift | per photo or terrace ratio | per capture ratio, faded across photo boundaries, then evened out by harmonise (§4.4) |
| Surfaces | up-facing and seen from above (roofs and ground alike) | the same, with checks for street markings (§4.5) |
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

### 4.2 Capture suns, fitted district-wide

1. **Fit large surfaces first.** Every large plane (a deck or plaza with at least 1,500 cells, as the step's `minPlaneCells`) is fitted under the existing gates against the district height map. With district context, more of them pass: today only 139 photos took a deck sun.
2. **Cluster the accepted suns** within about 7° of each other. Keep clusters supported by at least N planes in at least two chunks. These are the capture suns, expected to be a handful.
3. **Choose one per photo.** Each photo with enough surface cells picks the capture sun its own cells confirm best, under the existing gates, or none. Choosing among a few known suns can't overfit the way a free 144-candidate fit per photo does.
4. **Fragments.** Small fragments that can't confirm a sun take the sun of the surface they belong to, the step's per-terrace rule, restricted to capture suns.
5. **Registry.** Results are stored per photo, keyed by the image's hash, so a photo seen by several chunks gets the same sun.

**Expected effect:** the "no sun" share drops and every lifted photo uses a plausible sun. The 71-bin spread becomes the test: after this, accepted suns should fall in a few clusters.

### 4.3 Where the shadow falls

From geometry only: is the point below the chosen sun's shadow line (§4.1)? The edge is soft, from the map's nearest cells, as the step already does. Two photos meeting at a boundary then agree on which side is in shadow. Today each photo has its own shadow decision, which draws the photo boundaries into the result.

### 4.4 How much to lift, without new seams

**The ratio.** The lit-to-shadow brightness ratio, (sun + sky) / sky, belongs to the capture, not the photo. It's measured per capture sun from all its accepted planes, per colour channel in linear light. Shadows are bluer, so red is lifted more than blue.

**Fading at photo boundaries.** Each texel's lift is the capture ratio, faded at photo boundaries: within about 2 m of a boundary, it blends toward the neighbouring photo's lift.

**Capped.** The lift never exceeds the surface's lit level, as the step already does, so vents, rails and scan-edge mismatches don't glow.

**Before harmonise.** The pass runs before harmonise, so harmonise's seam levelling (one gain per photo plus smooth seam offsets) evens out what the lift leaves at photo boundaries. Running it after harmonise, as in §2's measurement, leaves those steps in place.

### 4.5 Ground surfaces

- **Markings and patches.** Zebra crossings, painted lanes and patched asphalt can pass for shadows. The colour gate (no channel stepping more than 1.5× another) catches paint. Dark asphalt is the remaining risk. Add a check: a shadowed patch must have a lit patch within about 3 m that the height map says is the same surface (same height within 0.3 m). Then the step is measured on one material.
- **Vehicles.** The vehicle stage repaints cars out of the photos, but their shadows stay. They're too small for the height map to cast (cars are gone from the scan), so their shadows stay. They're small; accept.
- **Trees.** The scan's crowns cast the baked shadows (§4.1), so those shadows are lifted. K-D's replanted trees cast their own shadows live in the viewer.
- **Streets in canyons.** Mostly shaded by buildings across the street, often in another chunk. This is the main reason for district-wide shadows.

### 4.6 Where it runs

**Proposed order:**
1. Chunks build and join.
2. **District shadow pass** (new).
3. Per-chunk harmonise, again, on the lifted photos.
4. Seam stage: colour levelling, then cut and snap.

The seam stage's colour levelling samples the bands along chunk lines. Baked shadows there skew its gains, so lifting first helps it too.

**Repeating harmonise.** Harmonise runs inside each chunk's build today. Doing it again after the lift costs about 50 s a chunk; with 3 workers that's about 12 minutes for Shibuya. Cheaper alternative: lift the harmonised photos (as measured in §2), then let the seam stage level. Phase 1 measures whether that is enough (§6).

**One chunk at a time.** The pass reads one chunk's photos at a time, as the seam stage does: the height map and sun registry are small, the photos are not. Peak memory stays one chunk, which matters after the seam stage's earlier out-of-memory failure.

**Labels.** Every lifted texel is labelled `photo-inferred` (AGENTS.md §4), with the capture sun and ratio in the GLB extras. The run note keeps the district audit.

## 5. How we judge it

1. **District audit from above,** the same picture as today: lifted, rejected, no sun, lit. Target: "no sun" well under today's 50%, and no tile-shaped patchwork.
2. **Sun spread:** accepted suns fall in a few clusters, not 71 bins.
3. **Seams across photo boundaries:** the median brightness step across photo boundaries on lifted surfaces, measured before and after the pass. It must not rise. Today's per-photo lift makes it rise (chunk 23).
4. **Shadow contrast:** in lifted areas, the ratio between a lifted texel and a lit texel of the same surface nearby should be close to 1.
5. **Street markings:** sample crossings and lane paint, then count lifted texels that are paint. Target: near zero.
6. **Visual check:** the whole district from above, plus street-level views in canyons, before and after, in the app's viewer.

## 6. Phases

| Phase | What | Changes the pipeline? |
|---|---|---|
| 1. Prototype | Offline on run `c527da43`: height map from the cached leaf tiles plus a vector ring, capture suns, geometry shadow, faded lift. Measured by §5 on the harmonised grounds, first without repeating harmonise. | No |
| 2. Decide order | If photo-boundary steps remain after the seam stage, add the repeated per-chunk harmonise (§4.6). | No |
| 3. Integrate | A `shadows` stage between the chunk joins and the seam stage, behind `SCRATCHBOX_KD_SHADOWS=1`, with run notes, audit image and provenance. | Yes |
| 4. Default on | After the visual review on Shibuya and one more district. | Yes |

**Effort.** Phase 1 is about a day of work plus a 1–2 minute run, against 48 minutes for the per-chunk version.

## 7. Open questions

1. **Ring source.** Vector heights are cheap but flat-topped. Coarse 3D tiles are better, but are extra fetches at a lower level of detail. Start with vector heights and check the edge chunks' audit.
2. **Walls.** Façades also carry baked sun and shade. This design is upward surfaces only. Lighting walls needs the sun's angle to each wall and is a separate problem.
3. **The per-building step.** Keep it for isolated pipeline K builds. In K-D the district pass replaces it, so leave it off for K-D chunks (`SCRATCHBOX_K_ROOF_SHADOW` unset).
4. **Capture identity.** Google gives no capture time, so captures are inferred from sun clusters. Two flights with similar suns would merge, which is harmless: same sun, same shadows.
5. **Merging the roof-shadow commit.** The district pass reuses the step's gates and lift code. It means bringing `8242c97e` into `feat/pipeline-kd` (cherry-pick) at phase 1.
