# Pipeline K-D at Penn Station: the district's edge and the debris on 7th Ave

**Date:** 2026-11-03
**Status:**
- **The edge:** fixed and tested on fixtures.
- **The debris:** diagnosed; its fix comes next.

**Branch:** `fix/district-edge-circle` (from main `90e65beb`).
**Routed by:** MAIN, from the Penn kd run on Cloud Run (run `266b12eb`, workspace
`/Volumes/Scratchbox/kd-penn-smoke-20261103`, its view sheet `2026-11-03-penn-kd-district-views.jpg`). No local build was
run: the evidence is read from that run's own files.

## 1. The district's edge (view 1: torn triangles and loose bits all round the 250 m)

**Why.** Three gaps, all in pipeline K-D's chunk plan and seam stage:
1. **A building straddling the line was never planned.** `planDistrictChunks` planned a building only when its middle
   lay inside the circle. Also, the orchestrator handed the plan only buildings whose middle was within the radius
   (`selectPaintBuildings(ev, radius)`). So a building whose middle lay past the line, but which reached into it, was
   owned cell by cell. Its inside part was kept as a cut fragment.
2. **The ground was never cut on the circle.** The seam stage's `cutChunkGround` cuts exactly at the cell lines between
   chunks. Where ownership changes at no cell line, it keeps a triangle whole by design (a sliver of overlap beside a
   wall, never a hole), and the district's own circle is such a change. So every triangle across the edge stood whole
   past it, and the join's keep-any-corner rule (`joinChunkGlb`) had already kept them.
3. **Nothing past the edge was left out by rule.**

**The fix.**
- **The plan** (`district-chunks.ts`, `DISTRICT_CHUNKS_VERSION` 3):
  - Every building the circle reaches is planned whole: in the cell of its middle, or, if its middle lies past the
    circle, in the cell of its point nearest the centre. That chunk's rectangle grows to it, so the building is
    extracted whole.
  - A building reaching more than `edgeGrowthM` (100 m, the staged district's containment growth) past the circle is
    left out whole, with its reason, in `plan.leftOut`. No chunk owns any of it (`chunkOwner` returns -1 there).
  - The orchestrator now fetches and selects buildings out to the radius plus `edgeGrowthM`. This is a two-line change
    in `orchestrator.ts`.
- **The seam stage** (`district-seams.ts`, `DISTRICT_SEAMS_VERSION` 3):
  - A triangle across the circle, whose outside is no chunk's, is cut exactly on the circle with every attribute
    carried. Only its inside is kept, and the cut points are set on the circle.
  - Inside a building planned whole, the ground runs on past the circle.
  - The report counts these cuts (`edgeCut`).

**Tests** (fixtures, credentials unreachable):
- **The plan:**
  - a building across the 350 m line is owned whole by the cell of its nearest point, and that cell's rectangle reaches
    its far end;
  - a 700 m rail yard is left out with "reaches 701 m from the centre, more than 100 m past the district's 350 m edge";
  - ownership is -1 inside the yard and the cell's beside it.
- **The circle cut:**
  - ground running 20 m past the edge ends on the circle: nothing past 350 m, more than 20 cut points on it, each at the
    height of the surface it was cut from, and the area kept equals the area inside;
  - a building planned whole keeps its ground to 370 m, while the street beside it stops on the circle.
- **Suites:** the kd, orchestrator and first-paint suites pass, and so does `tsc -p packages/core`.

## 2. The debris on 7th Ave (view 4: white shards and leaning panels in the carriageway)

**What it is.** View 4 was redrawn from the run's shown layers (chunks 10 and 15's seam-cut remesh), each triangle
coloured by its source. The result is `docs/screenshots/2026-11-03-penn-kd-view4-by-source.png` (gitignored).
- **The shards and the floating blob** are the scan itself (`TileRefine`): lumps 0.5 to 3.4 m over the street.
- **The leaning panels** are long, slanted scan triangles running from the road up to a lump.
- **Not the cause:** generated seal pieces (lattice-stitch) are only thin strips there. Base cleanup's skirts don't run
  in a kd district at all (the polish gets no `base` without one structure's loops).

**Where they come from.**
- **Measured in both chunks:**
  - **Chunk 15** (the camera's half of the block): 35 clusters of standing triangles, 32 of them at least 0.5 m². All
    but 7 lie inside regions its vehicle stage reported removed and patched. Examples: 54 m² up to 2 m inside a
    "white pickup or truck" region; 35 m² up to 3.4 m inside a taxi region.
  - **The centre:** the same stretch's lumps are already in the vehicle stage's own output (`vehicles/<key>/geometry.glb`,
    before any K step). For example: 19 m² up to 2.3 m and 45 m² up to 1.2 m, inside "yellow car" regions. The K steps
    carry them through.
- **So the vehicle stage's patch leaves part of each vehicle standing.** `vehicle-removal.ts` `patchVehiclesInGlb` moves
  a vertex down to the patch surface only when:
  - its cell is in the region (the proud cells, widened by `skirtM`);
  - it sits no higher than the cell's stack ceiling (`measureStacks`: the scan's surfaces climbed from the street while
    each step up is under `stackGapM`, 1 m; above a gap is taken for an awning or canopy and never moved);
  - it sits within `proudMaxM` of the patch.
- **Two of those leave vehicle geometry standing:**
  - a vehicle the scan holds with a gap of a metre or more in its stack keeps its upper part, floating;
  - vertices just outside the region's cells never move, so their triangles become slanted shards from the patched
    road up to the old top.
- **Which applies where** needs the region's cells and stacks, which the stage does not save. The fix will record them,
  then apply a rule tested on a fixture.

**Still to do (next):**
- The patch fix in `vehicle-removal.ts` with a fixture test: a vehicle with a gap in its stack, and one whose lump
  reaches past its region, each flattened, while a real awning over a car stays.
- Unread lumps (no reading of any kind) on the carriageway are a smaller share here: 7 of 35 clusters in chunk 15.
