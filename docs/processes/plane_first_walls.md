# Plane-first walls for the district rebuild (Federation Square / Flinders St)

Date: 2026-10-22. User direction: building walls are rarely curved insets, they are planes. Start from the most probable
form (one plumb plane on each Google footprint edge, its depth and height measured from the scan) and work outward only
where the scan clearly and consistently departs from it over a real area; the scan's bumpiness and faceting is noise,
never geometry.

## What changed

- `packages/core/src/node/3d-engine/staged-location/wall-plane-fit.ts` (new)
  - Per wall: the scan's near-vertical surface sampled every ~0.35 m (only surfaces facing along the wall's normal),
    read as an outermost-surface depth map in the wall's frame (0.5 m cells). The plane is the robust mode of the depth
    (the ±0.2 m window most cells fall in), refined by least squares on its inliers. A yaw off the vector edge is taken
    only when it explains 1.2× the cells (≤ 5°).
  - Recorded per wall: offset, yaw, measured lean (reported; walls stay plumb), measured top, coverage, inlier share,
    RMS of the lumps about the plane, RMS and P90 with the relief, and the residual map.
  - Status per wall:
    - `measured`: a clean plane.
    - `estimated`: seen, but under 30 % of it within 0.2 m of any plane. Placed at the median depth and labelled
      `generated`.
    - `unseen`: the scan sees under 20 % of the wall, or the wall is under 2 m long or under 2.5 m tall. Kept on the
      footprint edge.
  - Relief is kept only for a region of the 3×3-median-smoothed residual that passes all of these:
    - at least 0.5 m off the plane;
    - 4-connected, at least 4 m², with both sides at least 1.5 m;
    - filling at least 60 % of its box;
    - one depth (median absolute deviation ≤ max(0.2 m, 35 % of the depth)).

    A recess goes to the native tool as an opening of its measured depth, a projection as a face-sweep box. Everything
    else is snapped to the plane.
  - Setbacks: a run of at least 3 m whose columns stand at least 0.6 m off the plane, at one depth, over at least 60 % of
    their height, splits the edge. Each run is fitted as its own plane, and the runs are joined by a return wall.
  - Jogs and unseen walls:
    - Jogs too short to measure move with their neighbours, so a notch stays a notch and never becomes a spike.
    - Unseen walls move with the building's least-squares measured shift, when that shift constrains both directions.
  - `dropWallBandResidual`: a residual cluster lying at least 70 % within 2.5 m of a seen wall (wider where relief is
    deeper) is that wall's lumps and is removed. A cluster mostly off the walls (a canopy, roof plant) stays whole.
- `scratchbox_staged_massing.hpp` changes, all off by default:
  - `param snapWalls 0` keeps the caller's wall planes. Modelled volumes still snap.
  - `param clipOpenings 1` clips an opening or face sweep to every piece of a wall that another part splits, and to the
    height a neighbour part leaves uncovered, instead of rejecting it.
  - Face sweeps on split walls resolve to their pieces, as openings do.
- `district-massing.ts`: plane first is on unless `SCRATCHBOX_STAGED_PLANE_FIRST=0` (cache version
  `district-massing/1+wall-plane-fit/1`).
  - Native parameters: `snapWalls 0`, `residualOpen 1e9` (the scan's cut clusters no longer punch holes that the lumpy
    scan then fills) and `clipOpenings 1`.
  - Wall-band residual is dropped. The remesh carve also covers the cells the moved walls take in.
  - Soft failures become labelled caveats, and the building is rebuilt. Soft failures are a footprint running past the
    extraction, or scan spilling past the footprint; the caveat reports the overhang left once the walls moved.
  - Failures that still keep the scan:
    - a roof well off the scan (a pitched or spired roof a flat box would erase; St Paul's Cathedral stays scanned);
    - a footprint the scan shows as street.
  - Provenance per wall node:
    - `vector-modelled`, measuredGeometry true, for measured planes (offset, coverage, inliers and RMS in the note and in
      `residual`);
    - `generated` for estimates;
    - `vector-modelled` for footprint edges;
    - `vector-modelled` returns for steps;
    - `measured` for relief (depth, area, fill and spread);
    - a lower confidence and the caveat for buildings rebuilt despite a failed check.
- `orchestrator.ts`: builds the wall sample index for the district massing stage and writes `plane_first_walls.json`.
  The layer note gives the counts.

## Measured on the real district (cached Fed Square extraction, 116 footprints)

Run offline through `buildDistrictMassingLayer` on the cached devegetated scan (tiles `4b35eb…`, tree strip `a83e0b…`),
vector evidence fetched live (290 buildings within 282 m). "Before" is the same code with `SCRATCHBOX_STAGED_PLANE_FIRST=0`
(strict, the non-procedural default).

### Buildings rebuilt

| | before (strict) | plane first |
| :--- | ---: | ---: |
| rebuilt | 57 / 116 | 92 / 116 (35 with a labelled caveat) |
| left as scan: the scan shows street | 20 | 20 |
| left as scan: past the extraction | 25 | 0 (rebuilt, caveat) |
| left as scan: scan spills past the footprint | 12 | 0 (10 rebuilt with a caveat; 2 failed another check) |
| left as scan: roof off the scan | 2 | 3 |
| left as scan: no extruded part | 0 | 1 |

Of the 17 overhang buildings, moving the walls onto the scanned facades left the median overhang share at 0.29, down
from 0.49.

### Walls (92 buildings, 1,452 walls)

| status | walls | length |
| :--- | ---: | ---: |
| measured | 551 | 7,593 m |
| estimated | 69 | 1,238 m |
| unseen | 757 | 9,431 m |
| returns at setbacks | 75 | 142 m |

The unseen walls are mostly party walls and walls hidden by a taller neighbour. Over the measured walls, length-weighted
10 / 50 / 90 %:

| measure | 10 % | 50 % | 90 % |
| :--- | ---: | ---: | ---: |
| coverage | 0.33 | 0.88 | 1.00 |
| inliers | 0.41 | 0.69 | 0.96 |
| lumps about the plane, RMS within 1 m (snapped flat) | 0.06 m | 0.20 m | 0.37 m |
| with relief, RMS of all seen cells | 0.15 m | 0.54 m | 1.41 m |
| \|offset\| from the vector edge | 0.12 m | 1.11 m | 3.05 m |
| measured lean | 0.02° | 0.15° | 2.5° |

- 77 walls took a yaw.
- The district's least-squares shift between the vector footprints and the scan is (−0.26, −0.76) m.
- Relief: 195 recesses and 219 projections. 76 of the 414 items were not built, mostly on walls covered by a neighbour
  part or below its roof; the native tool rejects those correctly.

### Scan lumps on the same 57 buildings (rebuilt in both runs)

| | before | after |
| :--- | ---: | ---: |
| visible as-scanned residual on walls (outside the solid, within 2 m of the footprint edge, below the top) | 5,584 m² | 2,978 m² (−47 %) |
| all wall residual, including cut residual hidden inside the solid | 19,262 m² | 13,455 m² |
| residual taken out as wall lumps, whole district | | 25,666 m² (13,560 triangles) |

### Fit to the scan

Distance from the scan's wall samples to the shown surface: the layer plus the carved remesh, at wall heights.

| buildings | measure | before | after |
| :--- | :--- | ---: | ---: |
| same 57 | RMS | 0.38 m | 0.93 m |
| | P50 | 0.08 m | 0.15 m |
| | P90 | 0.56 m | 1.61 m |
| | within 0.3 m | 77 % | 64 % |
| | farther than 3 m | 0.1 % | 4.9 % |
| 35 newly rebuilt (before: their raw scan) | RMS | 0.44 m | 0.63 m |
| | within 0.3 m | 87 % | 69 % |

This is the trade the direction asks for. "Before" scored well because its residual *is* the scan, lumps included. The
planes now stand where the lumps were. The far samples concentrate in four dense CBD towers (f58, f90, f72, f31): deep
scanned recesses and courtyards inside the footprint that no relief rule took, and neighbour facades inside overlapping
footprints.

### Screenshots

Clay; grey is the rebuilt massing, orange the as-scanned residual, blue the carved remesh. Saved in
`docs/screenshots/plane_first_walls/` (gitignored), and I looked at each one.

- `before_wide.png` / `after_wide.png`, the block south of Flinders St: the lumpy residual columns and the scanned opening
  on the back-row towers are gone. The buildings on the right that were raw scan are now planar. Rooftop plant stays as
  residual.
- `before_f75.png` / `after_f75.png`: one building, the same camera. Facade lumps snapped; small measured projections at
  street level.
- `before_f83.png` / `after_f83.png`: St Paul's Cathedral keeps its scan (roof check). The neighbour on the left is now
  rebuilt.
- `plan_b.png` / `plan_f90.png`, plan views: vector footprint in blue, plane-first loop in red, scan wall samples in
  grey.

## Tests

`packages/core/test/wall-plane-fit.test.ts`, 9 tests on synthetic lumpy walls (±0.15 m noise plus ±0.35 m lumps):

- the noise is snapped flat: offset within 0.15 m of truth, no relief;
- a 1 m deep, 4 m wide recess is kept within ±0.8 m of its box and ±0.2 m of its depth;
- unseen and estimated walls are labelled;
- a 2.5 m setback splits the edge with a return;
- lumps are dropped and a canopy is kept;
- native: relief crossing a split wall is rejected without `clipOpenings` and clipped to all three pieces with it, never
  into the annex.

The existing district, pipeline-E, version-F, shape-program and residual-audit suites also pass (69 tests).
`npm run typecheck` exits 0.

## Round 2: registration, enclosed voids, roof debris

All three changes are on with plane first (cache version `district-massing/1+wall-plane-fit/1+roof-and-voids/1`). The
same views were re-rendered and checked: `after_round2_wide.png`, `after_round2_f75.png` and `after_round2_f83.png`.

### Footprint registration

`registerFootprint` in `wall-plane-fit.ts` fits a 2D shift (and a rotation of at most 3°) to the building's measured
walls before the walls are fitted. It is Huber-weighted least squares of `o_i ≈ n_i · (T + θ perp(m_i − c))`.

- It is offered only when both shift directions are constrained and the offsets' RMS drops by at least 20%. Offered to
  31 of 94 buildings: median shift 1.84 m, offset RMS 1.39 → 0.69 m.
- It is kept only when the walls refitted from the registered footprint agree with at least 1.1× the scan cells (within
  0.2 m of their planes). That leaves 5 of 92.
- When I applied it whenever offered, the same-57 metric got slightly worse:
  - RMS 1.17 m with registration, 1.15 m without;
  - more than 3 m from any surface: 7.9% with, 7.2% without;
  - newly rebuilt buildings, RMS: 1.05 m with, 0.82 m without.
- `SCRATCHBOX_STAGED_PLANE_REGISTER=0` turns registration off.
- The district-wide 0.8 m shift is not a per-building constant. The per-wall planes already absorb it.

### Enclosed voids

`carveCourtyards` in `roof-and-voids.ts` carves a region inside a part as an inner ring when all of these hold:

- the scan's top lies at least max(4 m, 25% of the height) under the roof;
- the region is at least 2 m inside the outer ring, at least 20 m², with no side shorter than 3 m;
- 75% of the part's cells within 3 m of it stand near the roof (enclosed);
- a rectangle or 16-gon fills at least 60% of it.

The new ring's walls are fitted like any other. When the void's floor stands more than 1 m over the base, a floor part
(labelled `measured`) is added up to the median floor height.

- Without the enclosure test, the cathedral's aisles were "carved", which let its roof check pass. With it, the
  cathedral keeps its scan again.
- In this district only one void qualifies (29 m², with a floor).
- The far samples are not courtyards. 84% of them lie inside the rebuilt solid more than 6 m up, along walls where two
  footprints overlap (`plan_far_samples_f58.png`). That is the scan standing more than 3 m behind the planes at upper
  floors, which no relief rule takes.

### Rooftop solids

`fitRooftopSolids` rebuilds each 4-connected region of the scan as one prism when it:

- stands at least 1.2 m over a part's roof;
- is at least 1 m inside the outer ring;
- covers at least 4 m², and no more than 35% of the part (a larger region is a tier, not a rooftop object);
- has its holes filled (a hollow lantern is one solid).

The prism is the rectangle or 16-gon that best fills the region (at least 55%), running from the roof to the median of
the region's upper half. Each is labelled `generated`, with its fill and the scan top's RMS about it.

- Result: 118 solids, 8,689 m², 23 of them polygons.
- The solids join after the roof check, so they never rescue a roof the check refused.
- `location_reference_images` was not used. The scan resolves these to prism level, and nothing finer is modelled.

### Roof debris

`roofDebrisDecider` runs over welded residual clusters after the wall-band drop:

- splinters: second principal extent under 0.5 m and area under 15 m²; 66 clusters, 49 m²;
- hidden: at least 60% inside the rebuilt solid. These are the scan's surfaces under the roof, whose tips poke through as
  the thin shards on the big block's roof. 142 clusters, 57,514 m²;
- roof noise: at least 70% within 1 m of a rebuilt roof; 21 clusters, 359 m².

Real rooftop clusters (the spires on parts left as scan, canopies) stay.

### Numbers

On the same 57 buildings:

| measure | before | round 1 | round 2 |
| :--- | ---: | ---: | ---: |
| visible as-scanned residual | 16,552 m² | | 3,987 m² (−76%) |
| visible residual on walls | 5,584 m² | 2,978 m² | 1,822 m² |

Distance from the scan's wall samples to the visible surface (layer plus carved remesh). The round-1 figures counted the
hidden cut residual as a surface:

| buildings | measure | before | round 1 | round 2 |
| :--- | :--- | ---: | ---: | ---: |
| same 57 | RMS | 0.38 m | 0.91 m | 1.13 m |
| | P50 | | | 0.28 m |
| | P90 | | | 2.35 m |
| | within 0.3 m | 78% | 64% | 52% |
| | farther than 3 m | 0.1% | 4.8% | 6.9% |
| newly rebuilt | RMS | 0.43 m | | 0.82 m |
| | within 0.3 m | 87% | | 61% |

Rebuilt: 92 of 116. 4 tests in `packages/core/test/roof-and-voids.test.ts`:

- a light well is carved and a notch is not;
- a plant room and a hollow lantern become prisms, and the parapet is left;
- splinters, hidden scan and roof noise are dropped, and a canopy is kept;
- a 0.7 / 1.1 m shift is recovered, and walls of one direction are refused.

## Gaps

- The 20 buildings the scan shows as street (raised share under 0.6, several at 0.45 to 0.59) are not rebuilt. A
  partial rebuild of their raised part would need its own footprint.
- Relief is boxes only: recesses and projections. Bays at an angle, curved facades and colonnade piers are not modelled
  as such. A colonnade comes out as one recess.
- The scan→surface distance worsened where the scan holds deep courtyards inside the footprint.
- Upper floors set back more than 3 m behind the fitted planes inside overlapping footprints (the 6.9% of samples more than 3 m away) need a tier or relief rule of their own.
- Some long scan triangles still bridge notches in the carved remesh (the blue sliver in `after_round2_f75.png`).
- Not yet seen live in the app (the district massing stage is still behind `SCRATCHBOX_STAGED_DISTRICT_MASSING=1`), and
  the photo-match judge was not run.
