# Process: Scan rectifier knobs on the 3D Scene starter (Plaza de Cibeles)

> **Recorded:** 2026-10-21
> **Status:** Measured. **No default changed:** each knob buys a small planarity gain by flattening real relief or opening cracks, and none is visible in clay at street or oblique range.
> **Tags:** `tile-refine` `scan-rectifier` `district` `clay` `measurement`
> **Target Domain:** Real-world 3D locations (district `tile_refine`)

---

## 1. Question

The front page's **3D Scene** starter (Plaza de Cibeles) is a district build. Its buildings are the scan's own triangles after `tile_refine`: cull, scan rectifier, facade flatten, relief. Can four rectifier settings make the buildings measurably cleaner?

- `denoise`, which `tile_refine` forced off;
- `foreignPlaneSnap`;
- `snapDeadBand` (0.05);
- `maxRegionRms` (0.35).

## 2. Method

- **Input:** the build's tree-stripped scan, unchanged (`.scratchbox/cache/tile_vegetation/d9e92b55…/devegetated.glb`, 684k triangles). No anchor, as the orchestrator calls it.
- **Code:** current main. The baseline gives 569,550 triangles, against 567,566 in the 13:03 build, because the seam-weld commit landed after it.
- **Tooling added:**
  - `scripts/tile_refine.cpp` gains `--dead-band`, `--max-rms`, `--foreign-snap` and `--denoise`.
  - `scratchbox_tile_refine.hpp` now honours `rect.denoise` instead of forcing it off. The default stays off, so production output is unchanged.
- **Metric:** `scripts/clay_planarity_metric.cpp` scores the clay output.
  - Per face, it takes the angle between the face's normal and the area-weighted mean normal of faces with the same orientation (within 35°) within R m.
  - It reports that angle area-weighted, for walls (|ny| < 0.25) and for raised level surfaces (ny > 0.95, 3 m above the 10th-percentile height).
  - R = 3 m measures the melted waviness; R = 1 m measures finer noise.
  - It is independent of the rectifier's own counters.
- **Costs:** `tile_refine`'s own stats.
  - Mean vertex displacement (how far the result moves from the measured surface).
  - Final near gaps of 1–100 mm (cracks).
  - Proud-feature retained volume (ornaments, cornices, balconies kept).
  - Rectify time.
- **Visual check:** clay thumbnails with raking light (`--thumbs`, `SB_THUMB_EXTRA` close shots).

## 3. Results

| Run | Wall dev @3 m | Roof dev @3 m | Wall dev @1 m | Mean disp. | Near gaps | Proud vol. kept | Rectify |
|---|---|---|---|---|---|---|---|
| raw scan | 5.844° | 4.342° | 2.111° | – | – | – | – |
| **base** (defaults) | 5.400° | 4.156° | 2.002° | 3.26 cm | 34,611 | 95.0 % | 7.1 s |
| dead band 0.02 | 5.372° | 4.136° | 1.987° | 3.41 cm | 34,736 | 94.9 % | 7.4 s |
| max RMS 0.25 | 5.576° | 4.163° | 2.037° | 2.69 cm | – | – | – |
| max RMS 0.5 | 5.268° | 4.157° | 1.959° | 3.64 cm | 34,751 | 94.3 % | 14.6 s |
| max RMS 0.7 | 5.239° | 4.163° | 1.956° | – | 34,783 | 94.3 % | 13.4 s |
| denoise | 5.301° | 4.162° | 1.978° | 3.49 cm | 34,948 | 94.5 % | 7.8 s |
| foreign snap | 5.344° | 4.143° | 1.981° | 5.00 cm | **36,549** | 94.6 % | 7.1 s |
| RMS 0.5 + denoise | 5.219° | 4.163° | 1.952° | – | 35,087 | 94.1 % | 13.0 s |
| all four | 5.144° | 4.113° | 1.916° | 5.86 cm | **37,138** | **93.1 %** | 15.7 s |

- **The whole rectifier gains 0.44° on walls at 3 m** (5.84° → 5.40°). The best knob adds 0.13° (max RMS 0.5) and all four together add 0.26°.
- **Each gain is paid for:**
  - Every knob that flattens walls also flattens real relief: retained proud volume falls from 95.0 % to 93.1 % with all four.
  - Foreign snap opens 1,938 more 1–100 mm cracks (+5.6 %) and moves vertices 1.7 cm further from the scan, for a 0.06° gain.
  - Max RMS 0.5 doubles the rectify time (+7.5 s).
  - Dead band 0.02 is close to free, but its gain is 0.03°.
- **Visually:** the clay of the base and all-four runs cannot be told apart in close obliques (`docs/screenshots/rectifier_tune_cibeles/raw_base_all_c1.png`, `raw_base_all_c3.png`: raw | base | all). The amplified difference images (`base_all_diff_*.png`) show many facets re-shaded, but the walls stay faceted with the same 1–2 m tilted triangles. Those facets are the scan's own triangles. Snapping vertices to planes cannot straighten a facade whose triangles are this coarse.

## 4. Conclusion

- **Kept:** the four CLI flags and the denoise passthrough (default off), plus the metric tool, for future A/B runs.
- **Not adopted as defaults:** none of the four. The rectifier's settings are not what limits district building quality; the coarse, melted triangulation of the scan is. A larger gain needs geometry the scan doesn't have: footprint-guided wall planes, or pipeline E's massing per building in districts (see `viewport_comparison_3d_scene_starter.md` and `staged_location_pipeline_e.md`).
- **Not tested:** pitched-roof districts, other starters, and textured or judged views. Retained proud volume is `tile_refine`'s own audit.

## 5. Reproduction

```bash
clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/tile_refine.cpp -o build/3d-native/tile_refine -lz
clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/clay_planarity_metric.cpp -o build/3d-native/clay_planarity_metric -lz
build/3d-native/tile_refine --input <devegetated.glb> --out-textured t.glb --out-clay c.glb --stats s.json [--max-rms 0.5] [--denoise] [--foreign-snap] [--dead-band 0.02]
build/3d-native/clay_planarity_metric c.glb 3
```
