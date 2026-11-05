---
name: surface-inventory
description: >-
  Before any material, glass, swatch or texture-detail pass on a building, list every surface it has (not only the flat
  ones a plane finder returns), what evidence covers each one, and which pass read it; then account for all of them
  (read, read and left alone with the reason, never read) by share of area, and run the input checks that stop a pass
  from spending image calls on the wrong thing. Use whenever materials, glass, window fit, swatches, a detail bake or
  "why is this surface untextured / plain / wrong" come up on a staged building or a scan.
---

# Surface inventory

A material pass is only as good as the surfaces it looks at. A pass that reads the surfaces that happen to fall out of a
plane finder, and says nothing about the rest, looks complete while it has read a few percent of the building. So:

1. **List first, then read.** Every surface of the building goes on the list before any pass runs.
2. **Every surface ends accounted for:** read (and what it was read as), read and left alone (with the reason), or never
   read (with the reason). Shares of area, never just counts.
3. **Check the inputs before paying for anything.** A wrong input makes every later step expensive and wrong.
4. **Report against the list.** "A class on 4% of the facade area" means nothing without "of the 61% the photos cover".

## 1. The list: every surface, by kind

Group the building's geometry into surfaces by **measured** fields (normal, height band, position on the footprint,
curvature), never by a named building type. Each is one row. Typical kinds on a tall masonry building, as a checklist of
what to look for, not a closed vocabulary:

| Where | Surfaces to look for |
|---|---|
| Each facade, each setback tier | the wall plane; piers and pilasters; spandrels and bands; window reveals, sills and heads |
| The base | shopfronts and their glass; entrances; canopies and their soffits; plinth and granite courses |
| Tops of tiers | setback roofs and terraces; parapets and copings; their inner faces |
| The crown | crown faces, mast or spire, lantern, antenna; observation decks |
| Roof | roof planes; tanks, plant, bulkheads, rails |
| **Top-down (facing up)** | every up-facing surface, at any height: main roof, each setback roof and terrace, tops of parapets and copings, ledges, sills and cornices seen from above, canopy and marquee tops, tops of roof objects and the crown's decks, skylights, and the plaza or pavement the building owns at its foot |
| Corners | outside corners (chamfers, quoins); inside corners and light wells (less sky, darker) |
| Anywhere | curved walls (an arena, a drum, a round tower), sloped roofs, soffits facing down |

**Top-down surfaces are their own list, not leftovers of the facades.** Facade-facing stations graze them or miss them,
and they hold a large share of what an aerial view of the building shows: roofs, terraces and ledges at every tier. List
each up-facing surface (normal within ~30 deg of up) by height band, with its own evidence: a top-down view of it (the
tiles' own nadir photos, a station straight above or steeply down at it), and a top-down height map of the tier to tell
a roof from the ledge or object on it (pipeline K's roof de-light already builds one). A dark roof is a dark material,
not a shadow (`tile-refine-twin.ts`: roofs seen from above get no shadow lift).

**Curved and fragmented surfaces are surfaces too.** A plane finder splits a photogrammetry wall into thousands of
patches and returns nothing for a curved one: group those patches by height band and facing (normal within ~15 deg)
into one row instead of dropping them. A row too small to read is listed as such, with its area.

## 2. Evidence per surface

For each row, record what the data holds, from the build's own outputs:

| Field | From |
|---|---|
| Area, tilt, height band, facing | the remesh / twin geometry |
| Photo coverage and texel size | the twin's UVs and atlases (texel metres), the uncovered mask of the facade orthos |
| Which survey station sees it square-on, at what distance | the survey or swatch station plan |
| Readings already made | window fit (`window-fit.ts`), wall grammar (`wall-grammar.ts`), material classes (`material-regions.ts`), swatch matches (`tile-detail-bake.ts`) |
| Provenance of its texels | measured / photo-inferred / generated (GLB extras) |

## 3. Input checks (before any image call)

Each of these failed once on the Empire State Building or the Colosseum and cost a harvest:

1. **The tiles are textured.** A clay layer (no images in the GLB) renders grey, and AI Beautify then invents a whole
   photo of the place in place of the view. `survey_harvest_swatches` / `tile_detail_bake` refuse it now; any new pass
   must check the same.
2. **Every camera stands outside the footprint and sees the building.** Stations planned from the centroid stood
   inside any building wider than ~44 m and saw the neighbours through culled walls. Render one station per facade
   without Beautify (free) and look before beautifying all of them.
3. **Every surface kind on the list has at least one source.** A swatch, a photo at a usable texel size, or a reading. A
   kind with none (no station sees the crown, no swatch of the spandrels) is reported as unread up front, not discovered
   from a blank result.
4. **The top-down surfaces have their own view.** The swatch harvest's four aerials look down at 35 deg from roughly
   a kilometre out on a tall building (1 m/px swatches on the ESB): too far and too oblique for a roof or a terrace. Plan
   steep, close views over each tier's up-facing surfaces, or report them as unread.
5. **The sources are finer than the tile.** A swatch or reference coarser than the tile's texel (aerial swatches at
   1 m/px against a 15 cm tile) adds nothing; reject it at the harvest, never at the bake.

## 4. Account for everything

After each pass, fill one table: for every row, what the pass did and why, as a share of the building's area.

| Status | Means | Example reasons |
|---|---|---|
| Read | the pass assigned something (a material class, glass, a swatch) | matched swatch X at confidence c |
| Read, left alone | examined, nothing applied, with the measured reason | match below threshold; detail would lose sharpness after encoding; coverage under the minimum |
| Not read | the pass never looked | no photo coverage; no station sees it; fragment too small; curved, not a plane |

The sum of the three is 100% of the area. A pass that reads a small share is reported as exactly that, with the largest
"not read" reasons named, so the next fix goes where the area is.

## Measured so far (2026-10-29)

- **Empire State Building, tile detail bake** (48 swatches from its own survey): 200,684 scan fragments joined into
  113,609 planes, 9,002 matched a swatch; 5 of 871 atlases changed, 0.23% of the surface. The largest "left alone"
  reason was re-encoding sharpness (136 atlases), not the match.
- **Colosseum**: 68,889 fragments, 3,152 matched 7 swatches; the curved walls never formed planes, and only ~2.7% of
  the surface matched any swatch. Its first survey cameras stood in the arena.
- **Material regions** are on by default for pipeline K and give every texel its detected material's library set; there
  is no glass layer (user decision, 2026-11-05), so "glass on N% of the facade" is no longer a reading: report each
  class's share of the texels and its set instead.
  A class's set may also carry a height (a recess of at most 3 cm, generated; `pipeline_k_materials` gives each class's
  `height`, `pipeline_k_height_relief` the displaced cells): relief on rebuilt facades only, never on a scan piece.
