# Kerbs and gutters as geometry, and the scan carved under them

**Date:** 2026-11-03
**Status:** Unit-tested, replayed offline on the Penn K-D smoke run, and built live and uncached at Penn (7th Ave & W 33rd
St, run `d2a35134`) and Federation Square (run `d10c8f6e`) on 2026-11-04. Before/after sheets made; not yet judged by the
user.
**Branch:** `feat/road-kerbs-gutters` (from main `d20e36d3`).
**Switch:** `SCRATCHBOX_STAGED_ROAD_KERBS=1`, off by default. It turns the roads stage on with it.

## Why

Walking a K-D district in walk mode, the streets look melted. The photo tiles' street is one lumpy sheet with the kerb
smeared into a slope. SB-Roadie (`road-surfaces.ts`) already measures the kerbs and the camber along Google's road
centrelines, but it drew ribbons 4 cm above the scan, with nothing carved under them, so bumps showed through. It was
shelved on 2026-10-21 for that reason.

## What it does

### 1. Each kerb read again on the scan's triangles (`road-kerbs.ts` `readKerbSection`)

At every SB-Roadie station, each kerb is read again: a cross-section every 5 cm, ±1.2 m either side of the station's
step, each offset the median of three reads 0.5 m apart along the street. The reads come from the scan's own triangles
(barycentric, `scanHeightIndex`), not from the 0.5 m cell grid. It finds:

- **the levels:** the road's level inside the kerb and the sidewalk's level behind it, both read low (30th and 25th
  percentile), since cars stand on the road and bollards, planters and sheds' posts on the sidewalk;
- **the face:** where it stands (the first sustained crossing of the half rise), its height, and how far across the
  rise runs (20 % to 80 %);
- **the gutter:** the dip at the face's foot, measured below the road's own line. That line is fitted beyond the
  gutter and carried to the face, so the camber is not mistaken for a dip.

A rise over 0.35 m is a wall, a stoop or a car. SB-Roadie's first sustained rise is often one of those: it accepts any
rise of 8 cm or more. In that case the kerb is looked for further in, a metre at a time.

### 2. Along the street (`measureKerbs`)

- **Smoothing:** the carrier's lateral jitter is averaged out, and the kerb line is smoothed (a median over 5 samples,
  then a mean over 3). Smoothing may move a measured offset at most 0.2 m, so a kerb bending into a corner stays where
  the scan puts it.
- **Gaps SB-Roadie bridged:** its dropped stations are read again every 2 m.
- **Ramps:** a ramp is where, just behind the kerb line its neighbours draw, the surface stands under 4 cm above the
  road while the sidewalk further back stands up, and the rise is a slope (at least 0.5 m across). There the face drops
  to the road.
- **Soft kerbs:** a slope that is already up behind the line is a kerb the scan smears. It is drawn at its half-rise
  crossing with its measured rise, and recorded as soft.
- **Gutters:** measured where most samples around one read a dip. Elsewhere the gutter is a plausible pan (0.3 m wide,
  2.5 cm deep), labelled generated, with the reason (the road's spread there).
- **The kerb line:** measured from Google's own centreline (each station records SB-Roadie's snap), not from the
  station, which jumps between lane windows. A robust local line is fitted over ±8 m, residuals past 0.25 m dropped.
  Only at a stretch's last two samples may it bend off that line, where the scan already curves into a corner.
- **One-sample gaps:** a single sample whose read failed is carried across, when the scan still steps up a kerb's height
  at the carried line.
- **Where nothing is drawn:** where no kerb is read, and SB-Roadie's step is not a kerb's height either, no kerb is
  drawn, and the sample records why.

### 3. Corners and straight joins

- **Corners:** two kerb ends whose straight kerb lines meet within 15 m, with each end on the other's sidewalk side, are
  joined around the corner. The arc is tangent to both lines. Its radius is measured from 9 rays cast from the lines'
  meeting point into the block: each ray's half-rise crossing gives one radius, and at least 5 must agree within 0.6 m
  (median). The arc is read across at every step, so a corner ramp drops its kerb too.
- **Runs that already curve:** when the runs already follow the curve, the arc starts ahead of the run's last cross-section.
  When the runs nearly meet, the join is just the short piece between their ends.
- **Straight joins:** two ends on one line facing each other within 12 m are joined straight across, drawn only where
  the read shows a kerb.
- **Where a corner is not drawn:** a corner the rays do not agree on is not drawn, and the reason is recorded.

### 4. The sweep (`buildKerbedRoadMesh`, operator 1)

The carriageway is drawn only between two measured kerbs. On a side with no measured kerb, SB-Roadie's step is as
often the building line, so that side's scan is kept and only the measured kerb is drawn.

One profile is swept along each run. Across, from left to right, it holds:

- each kerb: the kerb top (0.15 m behind the face, at the measured sidewalk level), a 45° nosing, the face itself (from
  the kerb top down to the gutter's invert), and the gutter. The nosing follows the user's bevel rule: 1.5 % of the
  kerb's smallest dimension, clamped to 1–5 cm (so 1 cm), and at most half the face;
- the carriageway, through SB-Roadie's measured camber;
- the same kerb parts mirrored on the other side, and a median's kerbs when one is measured.

**The seams:** neighbouring parts share their vertex positions. A segment is drawn between two samples only when both
have it, so a kerb that ends simply stops, and the carriageway runs on to its bare edge. A join's first and last
cross-sections are the runs' own points, so it meets them exactly.

**Labels and texture:** each part is its own node, with its label and method in the GLB extras:

- `carriageway`, `face` and median tops: measured;
- `gutter`: measured or generated;
- `nosing`, `top`: generated (their sizes are not resolved by the scan).

The stage colours the parts with the tile photo seen from above (planar UVs, `renderTopDownPhoto`), so they continue
the scan's own photo at the carve's rim, crossings and markings included. SB-Roadie's atlas redraw (`road-texture.ts`,
owned by the infill session) drew flat tarmac and lost the crosswalks at Penn. `buildKerbedRoadMesh` still takes its
layout unchanged: the gutter uses the carriageway band's edge rows, the face and nosing `kerbRow`, the top `sideRow`.

### 5. The carve (`road-carve.ts`) and road-flatten

The footprint is the plan of every up-facing surface the sweep drew, triangle by triangle, with their levels. Each scan
triangle over it is cut exactly at the footprint triangles' edges, using lattice-stitch's `split`, which carries every
vertex attribute and shares cut points between neighbours. Then:

- **What goes, what stays:** a piece inside the footprint goes when it lies within -0.6 / +0.5 m of the new surface. A
  piece reaching higher stands on the street (a post, a hydrant) and is kept.
- **The rim:** every cut point on the outline, and every scan vertex already on it, is set onto the outline's own
  level (height only, within 0.25 m). Where the outline steps (a kerb's end) or the scan stood further off, a curtain
  closes the gap, labelled generated. Only points within the band count as rim: a wall the outline crosses is not
  curtained.
- **Whole triangles:** a triangle is cut only when the cut removes something under the new surface or sets a foot onto
  it. A wall that merely touches the footprint stays whole.
- **T-junctions:** a cut point a kept piece uses that lies on another piece's edge, or on a whole neighbour's, is put
  into that edge. Otherwise a cut line running past the footprint's corner opens a wedge once the rim moves the corner.
- **Primitives without an index list:** given one first, so they are carved like the rest.
- **Before the carve:** `road-flatten.ts` (written for K-D, never wired until now) settles the scan's street just
  outside onto SB-Roadie's levels.

**In a build:** the carve is a layer transform. It applies to the shown ground (`l2`, or whichever layer is the ground)
and its textured twin as they commit; a ground committed before the roads finished is committed again, carved. The
carved files are published as `*_road_<key8>.glb`, and the carve is recorded in the run note `road_carve`.

## Evidence

### Unit tests (`packages/core/test/staged-road-kerbs.test.ts`, 14 tests, credentials unreachable)

- **Cross-sections:**
  - a 12 cm step found 0.30 m out, within 3 cm, with its height within 1 cm;
  - a 4 cm by 0.4 m pan measured as a gutter (depth within 1 cm, width within 0.12 m);
  - a 1:12 ramp read as a ramp;
  - a flat surface and a 2.5 m wall read as no kerb.
- **A scanned crossing** (two 8.2 m streets, 0.13 m kerbs, 3 m corners, on a 0.25 m triangulated grid):
  - every straight kerb's face lies within the scan's own step, with its height the rise plus the gutter;
  - the measured gutter is read as such (4 cm, 0.4 m) and the north side gets the plausible one, with its reason;
  - the ramp drops the kerb (under 5 cm) while kerbs either side stand over 10 cm;
  - the four corners are drawn with radii 2.76–2.87 m, every kerb point around them within 15 cm of the block's true
    curve;
  - faces face the road, and every level part faces up;
  - the carriageway shares its edge vertices with the gutters.
- **The carve:**
  - the lump on the carriageway is gone;
  - the 1.5 m object standing on it is kept;
  - a scan primitive with no index list is carved like any other;
  - no crack: every open edge of the carved scan lies within 2 mm of an open edge of the new streets (or of another of
    the scan's own open edges, a collinear T-junction inside a cut triangle);
  - every open edge of the streets lies on the scan's rim, or on the streets' own surface.
- **The stage** (`staged-location-orchestrator.test.ts`, with the switch on): a synthetic kerbed crossing through a
  whole staged build commits the kerbed `l1r` layer (labels measured and generated) and a carved ground. The lump is
  gone, and the run note records the carve.

### Offline replay on the Penn K-D smoke run's files (development, not the test)

The centre build of `kd-penn-smoke-20261103` (2 Penn Plaza, run `266b12eb`), replayed on its own files with the
code of this branch:

- **Inputs:** 7 SB-Roadie runs, measured on the vehicle-removed tile scan (as the stage does). The carve ran on the
  remeshed ground `l2` (673,270 triangles) and its textured twin.
- **Kerb line:** 356.5 m measured, 266.0 m drawn.
  - Of the drawn: 174.5 m read on the triangles (90.5 m of it soft: the tiles smear the step over more than 0.9 m),
    41.8 m at SB-Roadie's step, 49.7 m carried along the line (33.7 m of ramps, single samples an object hides).
  - Nothing drawn on 195.1 m, mostly because SB-Roadie's step was a building wall (135 samples). There the scan runs
    smoothly from the road to the wall: the tiles show no kerb.
- **Faces:** 2.7 / 13.3 / 24.4 cm (10th / 50th / 90th percentile). The low end is ramps.
- **Gutters:** 0 m measured, 266 m generated. Penn's tiles resolve no dip at the kerb's foot.
- **Corners:** 0 of 7 drawn. The rays across them saw the kerb on too few rays (5) or disagreed (2). One corner that
  fitted a 0.4 m radius (a planter's foot) is now refused below 1 m. Straight joins: 7 drawn, 13 refused (no kerb
  across the gap).
- **The carve (textured twin), 5.8 s:**
  - 129 triangles removed and 1,195 cut (566 m²);
  - 273 pieces standing on the new surface kept, their feet set onto it;
  - 4,043 rim points pinned (at most 0.249 m), 181 too far, closed by 263 curtain triangles;
  - 151 whole triangles joined to their cut neighbours (the T-junction repair).
- **Renders** (the photo-match rasteriser, 1.7 m over the sidewalk, looking along the kerb):
  - before: the scan's street a smooth slope to the sidewalk;
  - after: a kerb face, nosing and gutter along the streets where the scan measures them.
- **Real-data problems found and fixed on the way:**
  - SB-Roadie's walls taken for kerbs;
  - the carriageway drawn out to them;
  - the flat atlas texture;
  - the remesh's primitive without an index list;
  - wall triangles cut and curtained;
  - T-junction wedges at kerb ends.
- **What the renders still show:** Penn's scan is heavy with shards and vehicle remnants. Those above the band are kept
  (their feet set onto the new surface), so the street around the kerbs is still as lumpy as the scan. That is the
  vehicle stage's work.
- **Crack count on real data:** the remeshed ground carries part of its street twice (mesh 42 repeats mesh 0's triangles
  with reversed winding), which confounds an exact-weld open-edge count, so the real-data check is the renders.

### Live builds (2026-11-03/04)

My own instance (launch entry `scratchbox-road-kerbs`, ports 4310-4312, `SCRATCHBOX_CACHE_RESTORE=off`), districts shown
as scanned (`district: "scan"`), each started only with the load average under 100, through the app's tool route
(`/gemini/tools/run-stream`, `google_3d_tiles_get_clay`).

**The first build, at Penn (run `02c4e917`), found four faults, all fixed:**

- **The carve fanned a kiosk's face into slivers.** The T-junction repair put a cut point into any edge it lay over in
  plan, and a vertical face's edges are one line in plan, so the street's cut points below went into it, reading other
  charts of the twin's photo. Now a point goes into an edge only when it lies on it in 3D, with that piece's own
  attributes along the edge.
- **The new surfaces' photo sat metres off the scan's.** The photo seen from above was exact at the tile's highest point,
  so beside a 230 m tower the street was drawn 7 % small toward the frame's centre. `renderTopDownPhoto` takes a
  `referenceY` (default unchanged); the kerbs pass the ground's level.
- **The new surfaces were darker than the ground around them**, coloured from the raw tile photo while the ground shows
  the de-lit twin. When the build's own ground twin commits, its own kerbed streets are coloured again from it (seen from
  above, before the carve), and committed again (`road_recolour` run note).
- **The roads stage ran past its 240 s limit.** It now has 6 more minutes with the kerbs on.

**Then, found by the seam session in chunked K-D builds, also fixed:** the centre's ground, clipped to its territory first
(`_kd0_`), was skipped by the carve as if it were a joined chunk's; and the recolour fired on every joined and seam-cut
ground. A joined chunk is now told by `meta.extra.chunk` alone, and a build recolours only its own streets from its own
ground.

**The uncached builds on the final code:**

| | Penn, 7th Ave & W 33rd St (`d2a35134`) | Federation Square (`d10c8f6e`) |
|---|---|---|
| Extraction | 581 leaf tiles, 210 m | 298 leaf tiles, 201 m |
| Kerb line measured / drawn | 2,295.5 m / 1,932.1 m | 1,432.1 m / 1,321.3 m |
| Not drawn (no kerb measured) | 816.1 m | 369.5 m |
| Faces (10th / 50th / 90th pct) | 2.5 / 11.0 / 23.7 cm | 4.1 / 13.6 / 23.0 cm |
| Ramps, corners | 390.4 m; 2 drawn, 10 not | 225.3 m; 0 drawn, 2 not |
| Gutters measured / generated | 7.9 m / 1,924.3 m | 7.2 m / 1,314.1 m |
| Scan carved (textured twin) | 6,975 triangles removed, 11,271 cut (6,455 m²), 2,914 standing kept | 1,427 removed, 3,081 cut (7,834 m²), 4,325 standing kept |
| Rim | 36,213 points pinned (max 0.249 m), 1,430 curtain triangles | 11,767 pinned (max 0.25 m), 3,438 curtain triangles |
| Roads stage | 240 s | 53 s |
| Recolour from the twin | 17.7 s | 15.4 s |

**What the sheets show** (`docs/screenshots/road-kerbs_2026-11-04/kerbs-sheet-penn.jpg`, `kerbs-sheet-fedsquare.jpg`,
gitignored; walk-mode eye height along the three best-measured kerb stretches and from above, before and after,
textured and clay, rendered offline from each run's published layers):

- From above, the recoloured surfaces cannot be told from the ground around them: lanes, lines and crossings continue.
- At eye height the measured kerb reads as a clean edge with its face; the street otherwise looks as the scan did.
- **Defects:**
  - a few small black slivers at the carve's rim, one or two a view, that the before does not have;
  - at Federation Square, sliver spikes in the sweep where a kerb run meets a crossing (`road_39`).

## Known gaps

- **Chunk joins:** a chunk's `l1r` is joined by the seam band (any corner in band) while its ground is cut exactly at
  the cell lines, so neighbouring chunks' road surfaces overlap in the band. Reported to the District KD session; the
  proposal is to cut `l1r` at the cell lines by owner.
- **The `sb_roadie` tool:** `rebuild` still draws the old lifted ribbon. With the kerb switch on it would sit over a
  carved ground. The tool is gated by `SCRATCHBOX_STAGED_ROADS=1` only.
- **The carve's cost:** it runs inside the layer commit, synchronously. At Penn's centre this was 6–17 s a file, 2 files,
  on a loaded Mac.
- **Sidewalks:** the scan's own sidewalk stays (settled by road-flatten). SB-Roadie's sidewalk strips are still off
  (`buildSidewalks: false`).
- **Rim slivers and crossing spikes:** see the live builds above.
- **The photo seen from above elsewhere:** `renderTopDownPhoto`'s default is still the tile's highest point. Its other
  callers (vehicle removal's crops, the grass map, bridge build, scan massing, procedural materials, revolution fit, and
  the legacy SB-Roadie path) draw the ground small beside tall buildings in the same way; each should pass its ground's
  level.
- **The recolour's cost:** it runs in the commit listener, synchronously: 15-30 s a layer at these sizes.

## Candidate Tool/Service Ideas

- `location_carve_under_layer`: the carve as a tool. Remove scan triangles under any committed layer's footprint within
  a band, its rim set onto the layer's edge (plazas, water, platforms).
- A kerb report in `sb_roadie report`: per street, metres measured vs drawn, ramps, corners with their radii, gutters
  measured vs generated, from `kerbs.json`.
