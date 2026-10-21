# Process: Tree strip caps and skirts filled from the photo, and skirts kept off real walls

> **Recorded:** 2026-10-21
> **Status:** Verified (synthetic tests, four real tiles with before/after numbers and renders, live app build of the fill); the buildings-win-over-trees guard and the plant wall clearance verified by tests and the real tiles through the CLI; the photo-match judge was not run (no held-out manifests survive from round 7, see §6)
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-strip` `provenance` `believability` `pipeline-e` `st-marks` `jefferson-market` `washington-square-arch` `haughwout`
> **Target Domain:** Real-world 3D locations (tree strip, staged build), 3D viewport

---

## 1. Session Context

* **What prompted this session:** "Fix the tree caps and skirts. They are the most visible white artifacts. Fill them with the nadir-ortho photo instead of clay, or keep skirts off building walls. Strictly this is tree-strip work, but it's what reads as broken buildings." Branch `tree-strip-caps-skirts`, continued from an agent stopped by a usage limit.
* **Instance used:** web port `3096`, API port `3094`, tools port `3095` (own entry `scratchbox-tree-strip-caps-skirts` in `.claude/launch.json`, removed afterwards).
* **Scope tested:** the strip kernel's cap and skirt output (`packages/core/src/native/3d-engine/include/scratchbox_tile_vegetation.hpp`, new `scratchbox_strip_fill.hpp`, CLI `scripts/tile_vegetation.cpp`, wrapper `tile-vegetation-service.ts`), its consumers (pipeline E's ortho bake, the TS tile-photo transfer, the remesh), the trees summary and the stage notes, and a live district build of St. Mark's in-the-Bowery with trees.

---

## 2. What the strip emitted before

The strip rebuilds the ground under each removed tree (the **cap**) and, where the hole edge stands off that surface, continues it down with a vertical **skirt**. Both were flat clay primitives (`VegetationRemovedCap`, base colour 0.55/0.57/0.60): the white slabs in every district build with trees. Measured on the four tiles (`legacy` = `fill 0, skirtDropBacked 0`):

| Tile | Clay cap m² | Clay skirt m² | Skirt m² by what it hangs on (walls / level surfaces / kept canopy / other) | Cap / skirt triangles |
|---|---|---|---|---|
| St. Mark's in-the-Bowery | 4,048 | 3,102 | 121 / 369 / 784 / 1,828 | 15,658 / 1,123 |
| Jefferson Market | 4,980 | 5,148 | 459 / 342 / 841 / 3,507 | 17,260 / 1,262 |
| Washington Square Arch | 587 | 643 | 72 / 81 / 15 / 475 | 852 / 341 |
| Haughwout | 34 | 98 | 0 / 0 / 0 / 98 | 50 / 50 |

Round 7 of pipeline E had already stopped the native ortho bake from counting these as photo (21 % of St. Mark's wall 70 was that clay, labelled as-scanned). The TS tile-photo-transfer rung (`buildTileSurface`) still read the clay's flat colour as the tile's photo (checked in the new test: a sample on a legacy cap returns the clay colour).

---

## 3. What changed

### Fill (caps and skirts carry photo-inferred texels)

`scratchbox_strip_fill.hpp`: each piece (a cap: a connected set of cap triangles, seen from above; a skirt: a run of consecutive hole-edge segments, seen from the front) is laid out as a raster at `fillTexel` (0.1 m). A texel is **real** when the kept scan has a not-vegetation surface facing the way the piece faces within `fillSurfaceTol` (0.35 m) of its place, whose photo colour is not the crown's (the same chroma test the classifier uses: the ortho directly under a crown shows the crown, never painted). Every other texel is **carried** from the nearest real one (its mirror image across it when that is real, so the grain continues across the boundary), and the carried distance sets a confidence `exp(-d / 3 m)`. The real scan is read `fillContext` (2 m) beyond each piece: this is the nadir ring just outside the hole loop for caps, and the wall above or below the crease for skirts. A piece with no real texel at its own level is read again with the tolerance widened to max(4 x tol, 2 m) at half the confidence (`piecesWidened`); only a piece with nothing facing it anywhere near is **generated** (the tile's mean photo colour of such surfaces, in a primitive of its own, labelled `generated`, with a degradation record).

The pieces are packed into one atlas (shelf packing, 2 px gutters, at most `fillAtlasMaxPx` 4096, the texel coarsened only to fit) written as a texture of its own: material `VegetationFill`, `extras.scratchbox.photoInferredFill: true`. Nodes `vegetation_removed_cap` / `_skirt` carry `extras.scratchbox.stripFill` with pieces, area, texel counts (target / real / carried / unsourced) and a `staged_glb::Provenance` (`photo-inferred`, `measuredGeometry false`, the mean confidence, method and note); `_generated` twins carry `generated` with confidence 0. Cap and skirt geometry is unchanged by the fill (asserted against a `fill 0` run). `fill 0` keeps the legacy clay.

### Skirts on walls (per-skirt geometric test)

A skirt on architecture (category wall or level surface) is a panel pasted over a real wall where the scan has a surface straight behind it. Per skirt quad, sample points over its face (≤ 2,000) look for a kept, not-vegetation triangle facing like the skirt within `skirtBackedReach` (0.4 m) of its plane whose closest point stands straight behind the sample (no further sideways or up than 0.4 x the sample spacing: a wall beside the skirt, or one ending within it, is not behind it; the triangle the skirt hangs on counts where it does stand behind, as the scanned wall under a crown's underside does). The band backed from the foot in every column is cut off (the quad's own foot vertices rise to its top; neighbours keep theirs, so runs break there for the fill); a quad backed to within `skirtMin` of its top, or over `skirtBackedShare` (0.5) of its face with no clean band, is not built (`openEdgesAtDroppedSkirts` counts what that leaves open). Decisions are reported per category: `skirtDecisions.{onWalls,onLevelSurfaces,onKeptCanopy,onOther}.{kept,shortened,dropped}` with counts and m². Skirts on kept canopy and "other" are built whole and filled (canopy skirts may take vegetation texels, the others may not).

Both outcomes of the wall test, on the synthetic tile (a tree over pavement pressed against a building wall, `againstWall` in `test/helpers/synthetic-textured-tile.ts`):

* the wall is scanned below the crown's underside (crownBaseM 3): the skirt from the top crease is **shortened** to the band the tree hid (3 m up to the crease), the skirt from the underside crease is **dropped** (fully backed); nothing built on the wall lies below 3 m; the built skirt's mean colour is the facade's;
* the crown reaches the ground against the wall (crownBaseM 0, nothing of the wall under the crease is scanned): the skirt is **kept whole** down to the ground and textured from the wall above the crease (real texels > 0, confidence > 0.2).

Texturing the kept skirt from the adjacent real wall texels was chosen over handing it to pipeline E's unseen-wall drawing: the strip runs on every district build with trees (pipeline E only on isolates, enhanced mode only), the fill is deterministic and cheap (1-2 s), and the labelled carried texels are what pipeline E's own texture pass then reads as "not the scan's photo" (the flag) and may redraw.

### Consumers kept honest

* `scratchbox_staged_massing.hpp` `TileSource::hasPhoto` returns false for a `photoInferredFill` material (`scratchbox_gltf_scene.hpp` reads the flag): pipeline E's ortho bake leaves the fill uncovered, as round 7 did for the clay.
* `tile-texture-transfer.ts` `readTileTriangles` carries the flag per triangle (`fill`), `selectTriangles` keeps it, and `buildTileSurface().sample` never returns a fill triangle (test: a sample on the filled cap is `undefined`; on the legacy clay cap it was the clay colour).
* `summarizeTrees` (`location-clay-pipeline.ts`): `strip.skirtDecisions` and `strip.fill` (per kind: pieces, generated and widened areas, texel shares, carried distances, mean confidence; the generated pieces with their reasons). `remeshNote` says what the closed ground carries and how many closing walls were cut down or not built. The `trees-measure` stage records generated pieces as degradations (`strip_fill_generated-cap` / `-skirt`, `provenanceAfter: generated`, with the reason).
* New strip params through `TileVegetationStripParams` → kebab-case CLI flags (part of the cache key): `fill`, `fillTexel`, `fillAtlasMaxPx`, `fillContext`, `fillSurfaceTol`, `fillNormalCos`, `fillConfidenceScale`, `skirtDropBacked`, `skirtBackedReach`, `skirtBackedShare`.

### Buildings win over trees (standing rule, 2026-10-21)

* **Strip, the cut stops at the facade** (`guardBuildings`, after the removal and before the caps): a triangle the removal took that lies on a kept wall it touches across a welded edge (within `facadeGuard` 0.15 m of the wall's plane, facing like it, |cos| ≥ `facadeGuardCos` 0.9) is facade whatever the classifier called it and is put back; the wave runs from the kept wall into the cut, every triangle measured against the plane of the scanned wall triangle the wave started from (never against a neighbour already put back, so it cannot creep over a rounded crown). Put-back triangles are building for everything after (hole edges, skirt categories, the fill's real texels, the backing test) and stay so across the strip's ground passes. Level surfaces are measured but not put back: the drape hem a crown lays on the paving around it, and a crown top beside a flat roof, are the crown's, and a first version that put them back lowered the rebuilt ground under three St. Mark's trees by 4-8 m and kept them as scanned (26 → 23 trees); walls only leaves every tree count unchanged. Stats `buildingGuard`: `removedOnBuilding.before/after.{onWalls,onLevelSurfaces}` (removed triangles lying on a kept building surface), `keptAsBuilding` (count, m²), `removedMeetingAlongEdge` (removed triangles that only meet a kept wall / level surface / other surface along an edge: the crease where a crown meets it, crown not building, counted so the join is visible), `crownsWithWalls`, `crownWalls`. The remesh note and the trees summary (`strip.buildingGuard`) carry it.
* **Where a tree hid a wall** the fill is the wall's continuation from its real texels above or beside (photo-inferred with a confidence; generated when nothing real is near), never a skirt pretending to be measured: the skirt's provenance says what it is.
* **Strip measures the walls each removed crown touched** (`measureCrownWalls`): kept wall triangles across a welded edge from the crown's removed triangles, clustered by plane (normals within 25°, within 0.5 m), each an area-weighted point and normal turned towards the crown, a horizontal tangent and its half extents along and up; written to crowns.json as `walls` (`crownsWithWalls` / `crownWalls` in the stats).
* **Plant keeps the regrown crown off those walls** (`GrowthParams::wallClearance`, 1 m, `--wall-clearance`, `TileVegetationPlantParams.wallClearance`): attractors and surface samples behind a wall or within the clearance of it, over the wall's extent grown by the clearance (a low garden wall or a short return clips what stands against it, not the whole crown), are left out of the growth; the height the leaves must reach becomes the top of the surface that remains when the clip took the apex; a clipped crown that still cannot fill its measured surface is reported (`keptOffWalls.perTree[].short`, `shortOfCrown`), not refused. Measured on the synthetic crown pressed to the wall (species library): unclipped 0.4 % of its triangles inside the building, deepest 0.52 m; clearance 0.5 m: 0.12 %, 0.32 m (a leaf cluster's reach past its attractors); 1 m: none. Stats `keptOffWalls` (trees, attractors clipped / at clipped crowns, per tree with walls, attractors, surface samples, and why it falls short if it does); the trees summary carries `keptOffWalls` with the crown ids. The Flatiron suite's "every tree fills its crown" check now excepts crowns kept off walls (one of 58 there, crown 223: 80 % of 15 remaining samples, reported).
* **Real tiles** (removed triangles lying on scanned walls, before → after the guard; put back as facade; crowns that touched walls): St. Mark's 0 → 0, 8 triangles / 7.7 m², 4 crowns (5 walls); Jefferson 0 → 0, 108 / 25 m², 4 crowns (8 walls); Washington Square Arch 7 → 0, 101 / 11.5 m², 3 crowns (3 walls); Haughwout 0 → 0, none. Removed triangles meeting a wall only along an edge (the crease, crown not building): 16 / 84 / 36 / 0. Tree counts unchanged by the guard (26 / 28 / 22 / 1).
* **Tests** (`tile-vegetation-fill.test.ts`): in both scans every scan triangle of the west wall is in the output unchanged (same corner coordinates, same count), `buildingGuard.removedOnBuilding.after.onWalls` is 0, the pressed crown's `walls` entry faces the crown (normal −x) on the wall plane; the planted crown with the default clearance has under 0.1 % of its triangles inside the building and none deeper than 0.3 m, the unclipped run more; a `wallClearance: 0` run reports no crown kept off walls.

---

## 4. Before / after on the real tiles

Defaults (`fill 1`, `skirtDropBacked 1`), through `TileVegetationService.strip` (`scratchpad/strip_run.ts`), same tiles as above:

| Tile | Clay area after | Cap fill (pieces; generated m²; widened m²; texels real / carried; confidence) | Skirt fill (pieces; generated m²; widened m²; real; confidence) | Skirt decisions (walls; level) | Atlas | Fill time |
|---|---|---|---|---|---|---|
| St. Mark's | 0 | 110; 121; 102; 15 % / 79 %; 0.49 | 145; 0; 48; 9 %; 0.42 | walls 14 kept, 0 cut, 0 dropped; level 185 kept, 1 cut (0.5 m²), 1 dropped (0.3 m²) | 2048 x 1660, 1.8 MB | 1.5 s |
| Jefferson Market | 0 | 123; 4.7; 14.6; 17 % / 82 %; 0.60 | 137; 1.6; 76; 13 %; 0.46 | walls 52 kept, 7 cut (2.6 m² off); level 98 kept | 2048 x 1864, 2.6 MB | 1.7 s |
| Washington Square Arch | 0 | 60; 0.1; -; 44 % / 56 %; 0.87 | 61; 37.9; -; 31 %; 0.71 | walls 7 kept, 4 cut (0.5 m² off); level 55 kept | 1024 x 983, 0.8 MB | 0.5 s |
| Haughwout | 0 | 2; 0; -; 44 % / 56 %; 0.93 | 5; 2.0; -; 41 %; 0.90 | none on walls or level surfaces | 512 x 155, 0.1 MB | 0.1 s |

(Generated and widened areas for the Arch and Haughwout are from the run before the widened search was added; St. Mark's and Jefferson after it: St. Mark's generated caps 222 → 121 m², generated skirts 48 → 0; Jefferson 19 → 5 and 78 → 2.)

Clay area before → after: St. Mark's 7,150 m² → 0, Jefferson 10,128 → 0, Arch 1,230 → 0, Haughwout 132 → 0. What remains labelled `generated` (no facing surface anywhere near, the tile's mean colour): St. Mark's 121 m² of caps (two pieces of 89 and 79 m² on raised levels at the tile edge), Arch 38 m² of skirts.

**The wall test on real scans:** the walls under these trees are mostly not in the scan at all (Google's photogrammetry has nothing behind the crowns), so most wall skirts are kept and are now textured from the wall above them; the backing it did find was partial (Jefferson 7 wall quads cut by 2.6 m², the Arch 4 by 0.5 m², St. Mark's one level-surface quad dropped). With the first, looser test (any kept surface within 0.4 m, not required to stand straight behind the sample) St. Mark's dropped 15 level-surface quads and Jefferson cut 13 wall quads, but that counted walls *beside* a skirt as behind it (the synthetic hidden-wall case dropped two quads it should have kept), so the strict test stands.

Renders (`test-results/screenshots/tree_strip_caps_skirts/`, also in the session scratchpad `shots/tree_strip_caps_skirts/`): `ob_cmp_<place>.png` oblique before | after, `td_cmp_<place>.png` nadir before | after, `pieces_after2_<place>.png` the pieces by kind (red caps, blue skirts, yellow generated caps, cyan generated skirts). At St. Mark's the churchyard reads as paving and lawn carried in from the ring instead of white; at Jefferson the garden reads as the dark soil and planting around it (blotchy, but the garden's own colours); the big skirts beside the church (on kept canopy, 784 m²) are textured but still read as flat panels where they are tall.

---

## 5. Live app (operate-scratchbox)

* **Instance**: own entry on 3094/3095/3096, `secrets.json` linked for the build and removed after. Load clean: `read_console_messages` no errors, the page at the token URL.
* **Build**: "Stage St. Mark's Church in-the-Bowery, 131 E 10th St, New York as a textured 3D location with its trees" in the prompt box. See the evidence below (filled in after the build).

* **Build finished (degraded, as expected for a district)**: `google_3d_tiles_get_clay` in 136 s: 250 m radius, 476 leaf tiles, 361 of 361 measured trees rebuilt. Console errors: none. The viewport crossfaded from clay to the textured layers (`live_stmarks_building.jpg` mid-build, `live_stmarks_finished.jpg` after).
* **The strip's new reporting reached the tool result verbatim** (trees summary, this session's `remeshNote` / `summarizeTrees` / degradations): "343,834 canopy triangles were stripped and the underlying ground and adjacent walls were closed (136,872 cap triangles covering 59,468.9 m²; 32,287 closing-wall skirt triangles covering 127,100.1 m²; **155 closing walls totaling 349 m² were omitted and 19 shortened by 29 m² where real scanned walls stood behind them**)", and two degradation records: `d-trees-measure-strip_fill_generated-cap` "most closed ground carries photo-inferred texels sampled from neighbouring surfaces (mean confidence 0.59), 143 cap pieces (494.5 m²) had no kept photographed surface facing the same way within reach and fell back to the tile's mean surface colour (generated)", and `-skirt` (mean confidence 0.51; 147 pieces, 99.5 m² generated). At district scale the wall test fires where the isolate-sized tiles had nothing behind the trees: 155 quads not built, 19 cut down.
* **Not a strip finding, reported for honesty:** the build's own visual check scored 52/100 ("tearing and incomplete mesh reconstruction around the main structure"); the district remesh of the church is outside this work. The generated share at district scale (494.5 m² of 59,469 m² caps, 0.8 %; 99.5 m² of 127,100 m² skirts, 0.1 %) is labelled and reported, never clay.
* **Cleanup:** preview server stopped, launch entry and `secrets.json` link removed.
* The live build above ran before the buildings-win-over-trees guard and the plant clearance were added; those are verified by the synthetic suite and the four real tiles through the CLI (§3), not by a second live build.

---

## 6. What was not done, and known gaps

* **Photo-match judge not run.** Round 7's held-out manifests and replay recordings (`test-results/screenshots/version_e_fixes/bakeoff7/`) are gitignored and no longer on disk; a judged run needs the per-place manifests with the held-out Street View views and the replay recordings. The numbers here are clay/generated areas, texel sources and confidences, plus the renders.
* **tile_refine drops the flag.** The district remesh (`tile_refine`, textured output) keeps the fill atlas (12 images out, 11 in) so the viewport shows the fill, but rewrites materials without names or extras: downstream of the remesh nothing can tell the fill from the photo. The strip's own output (what pipeline E and the TS transfer read) keeps it. `scratchbox_tile_refine.hpp` is owned by the `tile-seam-weld` session and was not touched.
* **`photo-match-eval-tree-cutout.test.ts`** fails on this branch's base commit (`fd5e6537`) exactly as with these changes (card-only tree coverage 0.8396 vs the 0.8352 bound): pre-existing, not from this work.
* Skirts on kept canopy and "other" are built whole; tall ones are textured but still flat panels.

---

## 7. Candidate Tool/Service Ideas

* **A strip inspection render in the app** (nadir and oblique of the devegetated tile with pieces coloured by kind and label) — this session rendered them with scratchpad scripts (`oblique.ts`, `topdown.ts`, `DEBUG_PIECES=1`) against the strip's cache; a tool result image would make the fill reviewable from chat.
* **Provenance flag carried through tile_refine** — `photoInferredFill` on the remeshed textured GLB's materials, so the provenance view and any later texture pass see the fill as a fill after the remesh.

---

## 8. Reproduction Steps

1. Tests: `bash <guarded-vitest.sh> packages/core/test/tile-vegetation-fill.test.ts packages/core/test/tile-vegetation.test.ts` (HOME empty, credentials unset, no `.env`/`secrets.json` in cwd); plus the tree/strip/LOD/pipeline-E suites listed in the commit.
2. Real tiles: the four cached extractions (`tile.glb` per place), `TileVegetationService.strip({ tilePath, params: { fill: 0, skirtDropBacked: 0 } })` for the legacy numbers and defaults for the new; `stats.json` `fill`, `skirtDecisions`, `skirts.areaM2`.
3. Renders: `scripts/dev`-style scratchpad `oblique.ts <glb> <png> 35 40 140` and `topdown.ts <glb> <png> 0.15`.
4. Live: own `scratchbox-<branch>` launch entry, token URL from `preview_logs`, the prompt above; trees summary in the build panel's trees stage, `strip.fill` and `strip.skirtDecisions` in the tool result.
