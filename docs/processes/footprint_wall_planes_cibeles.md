# Process: Footprint-guided wall planes in the scan rectifier (Plaza de Cibeles)

> **Recorded:** 2026-10-21
> **Status:** Implemented, **off by default**: a `tile_refine` CLI flag only, not wired into the staged pipeline. Measured gain on Cibeles is small (+1.7 points of facade area within 5 cm of its plane), costs nothing measurable, and is not visible in clay.
> **Tags:** `tile-refine` `scan-rectifier` `google-vector-data` `district` `clay` `measurement`
> **Target Domain:** Real-world 3D locations (district `tile_refine`)

---

## 1. Question

District builds (the front page's **3D Scene** starter) keep the scan's own triangles after `tile_refine`. The rectifier snaps a wall's orientation only within 1.5° of one of a few scene-wide orientation families, so at a non-grid place like Cibeles many walls keep their noisy fitted direction, and one facade is split into regions at slightly different depths. Can Google vector footprints, used as wall-plane candidates and accepted only where the scan agrees, make the buildings cleaner?

## 2. What was built

`scratchbox_scan_rectifier.hpp` (`wallFootprintsXZ`; empty means off and leaves the output unchanged):

1. **Match** (`matchFootprintEdges`). Every footprint edge at least 4 m long is a candidate. A wall region matches the closest edge it runs along:
   - its normal is within 10° of the edge's;
   - its centroid is within 5 m of the edge's line;
   - at least half of its length lies beside the edge.
2. **Accept.** An edge needs 15 m² of matched wall, and the matched regions' area-weighted mean direction must lie within 3° of the edge. A footprint drawn rotated against the scan is refused whole.
3. **Snap** (`snapRegion`). A matched region takes the edge's direction. Its offset is always the scan's.
   - Per edge side, the regions' own offsets are grouped at gaps wider than 0.3 m; the largest group gives a shared offset.
   - A region whose offset agrees with it shares one plane with its neighbours.
   - The existing bounds still apply: induced displacement of 0.25 m and region RMS of 0.35 m. A region that fails keeps the scan-derived orientation path.
4. **Claim** (`claimFootprintFacades`). Triangles that no region took (crinkled facets) beside an accepted edge join the side's plane when all three vertices lie within 0.2 m of it and the face is within 35° of facing along it. Deeper relief stays as scanned.

`tile_refine` exposes it:
- `--wall-footprints FILE` takes one ring per line: `x z x z ...` in the tile frame.
- Tuning flags: `--footprint-match-dist`, `--footprint-match-deg`, `--footprint-merge-offset`, `--footprint-claim-tau`, `--footprint-claim-deg` and `--max-snap-induced`.
- Its stats gain `rectify.footprintWalls`.

`scripts/clay_planarity_metric.cpp` gains an optional footprints argument for **facade straightness**:
- Per edge, it takes the wall faces facing along the edge within 2 m of it.
- It fits one vertical plane to those faces themselves; the footprint only selects the facade and never sets the reference.
- It reports the RMS distance from that plane and the area share within 5 cm.

## 3. Method

- **Input:** the build's tree-stripped scan, unchanged (`.scratchbox/cache/tile_vegetation/d9e92b55…/devegetated.glb`).
- **Footprints:** the build's cached vector selection (`.scratchbox/cache/staged_location/vector/e5ba9a0b…`): 84 buildings, 216 rings, 1,017 edges at least 4 m long. They are already in the scan frame.
- **Metrics:**
  - local planarity (`clay_planarity_metric`, R = 3 m);
  - facade straightness;
  - `tile_refine`'s own near gaps (cracks), proud-feature retention and displacement.
- **Visual check:** clay renders under raking light (`SB_THUMB_EXTRA` close shots), plus amplified difference images.

## 4. Results

| Run | Facade within 5 cm | Facade RMS | Wall dev @3 m | Near gaps | Proud vol. kept |
|---|---|---|---|---|---|
| raw scan | 22.2 % | 0.747 m | 5.844° | – | – |
| **base** (no footprints) | 36.2 % | 0.6825 m | 5.400° | 34,611 | 95.04 % |
| direction + shared plane, match 2.5 m | 37.3 % | 0.6813 m | 5.408° | 34,591 | 95.15 % |
| **+ claim 0.2 m / 35°, match 5 m (defaults)** | **38.0 %** | 0.6809 m | 5.401° | 34,609 | 95.24 % |
| claim 0.3 m | 36.9 % | 0.6819 m | 5.396° | 34,606 | 95.50 % |
| claim 0.5 m / 45°, merge 0.5 m | 36.6 % | 0.6828 m | 5.369° | 34,585 | 95.43 % |
| induced 0.5 m, merge 0.5 m | 36.6 % | 0.6793 m | 5.423° | 34,544 | 95.27 % |
| all four rectifier knobs (`scan_rectifier_knob_tuning_cibeles.md`) | 37.7 % | 0.6822 m | 5.144° | 37,138 | 93.14 % |

- **Defaults run:**
  - 253 edges were accepted (55 refused off-angle) and 379 walls matched.
  - 258 walls snapped to their edge, 210 of them onto a shared plane; 100 snaps were refused by the bounds.
  - Claimed: 1,136 triangles, 962 m².
  - Time was unchanged (13–15 s).
- **The gain is small and free.** Facade straightness rose 1.7 points, about the same as all four rectifier knobs together, without their cracks or lost relief. Wider settings make it worse.
- **Not visible.** Amplified difference images show only a handful of re-shaded facets in the close views (`docs/screenshots/footprint_wall_planes_cibeles/base_fp_diff_*.png`: base | footprints | difference).
- **Why it is capped:**
  - Only about 380 of 2,269 wall regions lie along a footprint edge, and those were already snapped flat. The footprint turns them by a degree or two.
  - The crumpled look comes from 1–2 m tilted triangles 0.3–0.7 m off the plane, which bounded vertex moves under the crease and fold guards cannot remove, whatever the plane's direction.
  - A visible gain needs geometry the scan doesn't have (pipeline E's massing per building in districts).

## 5. Decision

The user chose to keep the code **off by default**, as a CLI flag for future work. It is not wired into `TileRefineService` or the orchestrator. Wiring it later needs:
- the district's vector rings (`t.vector.raster.buildings[].extruded[].loops`) written to a file;
- the service passing `--wall-footprints`;
- the file's content included in the cache key.

Not tested: other starters and pitched-roof districts.

## 6. Reproduction

```bash
clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/tile_refine.cpp -o build/3d-native/tile_refine -lz
clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/clay_planarity_metric.cpp -o build/3d-native/clay_planarity_metric -lz
# footprints: one ring per line from the cached vector selection (value.sel.buildings[].parts[].loops)
build/3d-native/tile_refine --input <devegetated.glb> --out-textured t.glb --out-clay c.glb --stats s.json --wall-footprints footprints.txt
build/3d-native/clay_planarity_metric c.glb 3 footprints.txt
```
