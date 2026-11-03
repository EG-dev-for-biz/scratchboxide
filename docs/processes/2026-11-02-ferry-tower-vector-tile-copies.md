# The Ferry Building's torn clock tower: one building carried by two vector tiles

Date: 2026-11-02. Status: **fixed and verified offline and in a fresh build** (run 526b7580). Branch `fix/k-twin-delight`
(PR #17).

## Why it was looked at

[Preregistration 3](./2026-11-02-k-ferry-stage-cuts-prereg.md) found two stages of pipeline K losing the Ferry's geometry.
- **The cleanup** cost 2.27 on clay shape.
- **The footprint clip** cost 2.27 on clay shape and 2.38 px of placement.

In the clay renders the clip tore the clock tower, so the parent session asked for the clip to be fixed, keeping the footprint
rule's intent: a feature the data shows rising above the footprint stays.

## What was actually wrong

The clip only finished a cut made three stages earlier, which traces back to how the vector evidence is read.
1. **Google's feature tiles name each feature by its tile** (`z/x/y/f<i>`). The decoded features carry geometry and type
   codes only, with no id of their own. A modelled volume is carried whole into every tile it reaches.
   - At the Ferry, `17/20973/50652/f75` (1,030 vertices) and `17/20974/50652/f26` (210) are the same building.
   - Both span x −64..98, z −108..85 m.
2. **`fetchVectorEvidence` kept them as two buildings.** `rasterizeEvidence` let the copy drawn last take every cell they
   share.
   - The footprint under the place (`f75`) kept only a 376 m² diagonal strip.
   - The clock tower's cells became "another building's".
3. **The structure pick was limited to that footprint plus 2 m**, never growing into another building's cells. It took the
   strip, with 34 of the tower's 272 cells, and left 238 of them out.
4. **tile_refine's isolate followed the pick.** It held 216 m² of the tile's 1,553 m² of tower surface above 30 m (14%).
5. **The clip** cut at the scan's outline plus 0.3 m, as it is meant to. The slice of tower it was handed stood past that
   outline, so it removed 214 of the 358 m² left (60%). K kept 155 m², a tenth of the tower.

Reproduced offline with the app's own functions (`fetchVectorEvidence`, `evidenceLookup`, `chooseFootprint`, `pickStructure`)
on the run's welded scan: the same outline, seed (−6.5, 0.5) and core height as the run's saved isolation pick.

## The fix

`vector-footprints.ts` `mergeTileCopies`, called at the end of `fetchVectorEvidence`.
- **What merges:** buildings of different tiles whose plans (1 m cells) overlap by at least half the smaller plan
  (`SAME_BUILDING_PLAN_OVERLAP`). They become one building under the first one's id, with every part, extrusion and volume
  kept.
- **What never merges:** buildings of one tile (the tile draws them apart), and neighbours that only touch (they share no
  plan).
- **No geometry is doubled.** The first paint already drew both copies' volumes as two buildings; now it draws them as one.
- **The footprint tests are unions.** `signedFootprintDistance` and `outsideFootprint` count a point inside any loop as
  inside, so a merged building's two outlines never cancel.
- **The clip itself is unchanged.** It now gets an outline that holds the whole building.

AGENTS.md §5 (atomic building integrity) names it. Test: `packages/core/test/vector-tile-copies.test.ts`.
- It fails on the old code: 2 buildings where there is 1.
- It also checks that touching neighbours, buildings of one tile, and a 10% overlap stay apart.

## Measured

| | Before (run 345e37dd) | After (run 526b7580) |
|---|---|---|
| Footprint under the place | 376 m² strip | the whole building |
| Structure picked | 428 cells, to 50.6 m | 11,052 cells, to 71.3 m |
| Tower cells in the structure | 34 of 272 | 272 of 272 (offline), 270 of 270 (the build) |
| Tower in the isolate (surface above 30 m) | 216 m² of 1,553 (14%) | 1,500 m² of 1,553 (97%) |
| Tower the clip removes | 214 of 358 m² (60%) | 0 of 1,561 m² (0%) |
| Clip removed over the building | 588 m² | 102 m² |

- **The fresh build** (run 526b7580, 489 s, through the app's run-stream on this branch) built the whole building.
- **It reports three degradations**, none of them fixed here:
  - one survey face timed out (the survey is not read by K);
  - a 58 m² hole at one rebuilt facade (`visible_defects`, FacadeLattice_7 showing the back of FacadeLattice_6);
  - 1.6% of the building seen untextured, mostly the base skirt and the seal (`visible_clay`).
- **The tower in clay** is smoother than the scan's: the cleanup and the lattice, as preregistration 3 found.
- **Proof sheet:** `docs/screenshots/ferry_tower_fix_2026-11-02/proof_sheet_ferry_tower.png`. It shows the raw scan, K before
  and K after, in texture and in clay, wide and the tower close up, with the judge's renderer.

At the ESB and the Haughwout the merge also combines copies: 38 of 704 tile-scoped features and 32 of 672. Their K arms
are rebuilt fresh for the next comparison rather than reused.

## Follow-ups

- **The build target changed:** the Ferry Building is now built whole (about 200 m long, 11,000 m²), as the rule asks. A
  build takes longer there, and the judge's target and views change with it.
- **MAIN was told:** `photo_match_evaluate` reads `fetchVectorEvidence` for its placement footprint and its indoor-pano rule,
  so they follow the merged footprints. No judge file was changed.
