# Process: Denser, fuller tree crowns (fill to the measured crown, mid cards, inner darkening)

> **Recorded:** 2026-10-19
> **Status:** Verified (with the costs and shortfalls in section 3)
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `textures` `shading`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** next to a Street View photo of the Washington Square Arch, the real summer crowns were much denser than the rebuilt ones, in clay and textured (see `tree_textures_live.md`).
* **What changed:**
  * **Native (`scratchbox_tree_lod.hpp`):**
    * Each level's projected coverage is measured against the measured crown. The reference is an ellipsoid fitted to the crown's surface samples and its footprint ring at the crown base. It is viewed orthographically from 9 directions (5 near the horizon, 3 at 45°, 1 from above).
    * The coverage is also measured against the 2D hull of the same points. With textures, a cut-out estimate shapes each leaf as the viewer maps the chosen texture (cell fill, leaf aspect, card stretch).
    * A crown short of its target gets clusters at shell points of its envelope. The shell points are the surface samples plus a Fibonacci sphere of the ellipsoid, inset 0.45 cluster reaches, then a layer deeper. Clusters go where the views see the most uncovered envelope, at most 0.8 × the tree's stations.
    * The target is `1 - exp(-0.5 × LAI × leafiness)` with LAI 4.6. Summer broadleaf crowns have a leaf area index of about 3-6, and a spherical leaf-angle distribution gives G = 0.5. This makes the target 0.90 at full leaf, 0.68 at half and 0 when bare.
    * `leafiness` is the crown's season cue from its measured colour. It uses the green share (0.05 → 0.45); with no judged cells, it uses chroma weighted by how green the hue is. Unknown colour counts as 1. The cue also thins the stations, so a leafless crown stays sparse.
    * Clusters now hold 100 leaves (was 160) at spacing 0.4 reach (was 0.5). Fewer, closer clusters cover more of the crown for the same triangles.
    * The mid and near-mid leaf-area gains are now 2.6 and 1.7 (were 1.5 and 1.0).
  * **Viewer:**
    * `treeCrownShading.ts`: inner-crown darkening `1 - innerDarkening × (1 - exp(-d / innerDepthM))`, where d is the depth in metres below the crown ellipsoid. Defaults are 0.3 and 1.5 m. It applies at every slot, in clay and textured, and in the dither variants.
    * `treeTextureMaterials.ts`: card zoom per detail slot (1 / 1.15 / 1.3 / 1.3) and alpha gain (1 / 1.1 / 1.25 / 1.25). The atlas sampling and the mip-aware alpha to coverage are kept.
    * The coverage is written into the trees GLB (`extras.lod.coverage`) and into the plant stats.
* **Instance used:**
  * "Before" ran in a temporary detached worktree at 529e569e (ports 3352/3353/3354). "After" ran in `.claude/worktrees/tree-density` (ports 3362/3363/3364).
  * Both servers were started with `npm run dev` outside the sandbox and stopped by PID.
  * Screenshots were posted from `canvas.toDataURL` to a local receiver on 3359.
  * The canvas was 613×711. The Browser pane was hidden.
* **Scope tested:**
  * Prompt: `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`, which gives 591 trees.
  * All 591 have a measured colour with green share 1 (leafiness 1).

---

## 2. What Was Tested & What Worked (Verified)

* **Projected coverage of the measured crown, all 591 trees.** Values are p10 / median / p90 of the per-tree mean over 9 views. The same crowns and seed were run with the old parameters and the new ones; the "after" numbers equal the app's own plant stats.

  | Level | Before | After |
  |---|---|---|
  | Near (level 0), clay | 0.17 / 0.32 / 0.47 | 0.23 / 0.51 / 0.68 |
  | Near-mid (level 1), clay | 0.18 / 0.34 / 0.49 | 0.36 / 0.67 / 0.83 |
  | Mid (level 2), clay | 0.25 / 0.44 / 0.60 | 0.48 / 0.79 / 0.91 |
  | Near, cut-out (textured estimate) | 0.15 / 0.29 / 0.45 | 0.19 / 0.47 / 0.65 |
  | Mid, cut-out (textured estimate) | 0.22 / 0.41 / 0.58 | 0.41 / 0.76 / 0.89 |

  The fill added 202,919 stations to the 255,825 base stations (458,744 in all). Level-0 leaves went from 19.0 M to 30.4 M.

* **Screenshots:** in `test-results/screenshots/tree_density/` (gitignored). Each `*_before_after.png` shows before on the left and after on the right, from the same camera.
  * `mid_tex_before_after.png`: the foreground crowns (near-mid and mid levels) went from see-through branch skeletons to closed crowns.
  * `close_tex_before_after.png` and `close_clay_before_after.png`.
  * `near_tex_before_after.png` (10 m): fuller leaves and a darker core.
  * `staging_*_before_after.png`: unchanged at 675 m. The far masses are not touched.
  * `streetview_vs_before_after_textured_clay.png`: Street View (heading 47°) | before textured | after textured | after clay. The crowns through and beside the arch now read as crowns, closer to the photo, though still lighter and smaller than the real ones.
  * `close_clay_inner_darkening_off_on.png`: the inner darkening is subtle. It changes 8% of the pixels.
* **Performance (WebGL, `lod.update` + `renderer.render` + a 1-pixel readback, median of 40 frames):**
  * Triangles and draw calls are from `renderer.info`.
  * The pane was hidden. Repeat runs varied by up to 2× (clay mid was 46.9 ms, then 20.6 ms), so read the trend, not the digits.

  | View | Triangles before → after | Clay ms before / after (run 1, run 2) | Textured ms before / after (run 1, run 2) |
  |---|---|---|---|
  | Staging (675 m) | 1.47 M → 1.47 M | 19.9 / 20.0, 17.6 | 24.1 / 38.8, 21.3 (19.8 and 19.8 re-measured) |
  | Mid (110 m) | 7.96 M → 8.62 M | 37.7 / 46.9, 20.6 | 49.4 / 64.6, 45.6 (45.7) |
  | Close (34 m) | 8.05 M → 6.72-6.97 M (more budget demotions) | 23.9 / 17.2, 15.6 | 35.6 / 43.2, 33.9 |
  | Near (10 m) | 8.70 M → 8.45 M | 21.3 / 17.4, 13.6 | 38.6 / 41.2, 28.5 |

  * Every view stays within the controller's 8 M triangle budget. The budget absorbs the denser near levels by demoting more trees (up to 30-38 against 0-15 before).
  * **GPU memory (trees layer):** geometry and instance buffers grew from 95 MB to 157 MB. Textures stayed at 213 MB (44 textures).
  * **Trees GLB:** 60 MB → 70 MB.
  * **Native plant time:** 2 s → 15 s for 591 trees. The coverage measure and the fill take about 0.35 s of CPU per tree.
  * **Frame estimate (`lodFrames`):** median 0.51 M → 0.68 M; worst 7.9 M → 10.8 M before the viewer's budget.
* **Tests:** `packages/core/test/tree-crown-density.test.ts` covers:
  * known covers on a synthetic crown (a closed shell gives 1 from every view; an upper half gives 1 from above and about 0.5 from the side; a cut-out card gives its fill);
  * the season cue: summer fills toward 0.9 with mid ≥ 0.85, while a leafless cue gives no leaves and a sparse cue stays under 0.45;
  * the inner darkening in the chunk, the crown variant and the fade variants (clay and textured);
  * one clay grey for wood and leaves.

  The tile-vegetation suites (`lod`, `textures`, `growth-order`, `tile-vegetation`, `crown-breakup`) and the tree-LOD suites pass.

---

## 3. What Broke / Didn't Work

* **Fill capped:** the near level reaches a median of 0.51, not the 0.90 target. The fill is capped at 0.8 × the stations to bound triangles, and the skeleton leaves gaps.
* **Mid and near-mid levels:** they reach 0.67-0.79 through larger cards, at no triangle cost.
* **Mid view cost:** the 110 m view costs more (8.6 M triangles, at the budget; textured roughly +0 to +30% frame time, within run-to-run noise).
* **Level distances:** these were not changed. The staging view did not regress.
* **Screen coverage in the viewer:** this was a debug measure: leaf pixels over the crown ellipsoids, `sbTree.crown`. It did not track the improvement at mid and street views: before mid 0.33 / street 0.34, after 0.36 / 0.33; close went from 0.34 to 0.48. Its denominator is the ellipsoid fitted to the delivered leaves, and that ellipsoid grows with the fill. Its mask also includes far trees, which are unchanged. The native measure against the fixed measured crown is the meaningful one.
* **Compared with the photo:** the real crowns are still denser and darker. The near-level fill is capped, and the far masses (most trees at 110 m) are unchanged.

---

## 4. Candidate Tool/Service Ideas

* **`__SB_TREE_COVERAGE__` debug hook:** the projected coverage of the trees in view, against the file's measured reference rather than the leaf-fitted ellipsoid.
* **Visible-pane perf capture:** frame timing with the Browser pane hidden varies by up to 2×. A perf hook should warn when `document.hidden` is true.
* **`--coverage-*` options on the staged-location tool:** `treeCoverageLeafAreaIndex` and `treeCoverageMaxFillShare`, so a user can trade density against triangles.

---

## 5. Reproduction Steps

1. Start the app from the worktree with your own ports, open the token URL, and send the prompt above.
2. Per-tree coverage is in the plant cache's `stats.json`, under `perTree[].lod.coverage`, and in the GLB node extras under `lod.coverage`.
3. Offline: `build/3d-native/tile_vegetation plant --crowns crowns.json --out t.glb --stats s.json --scene-triangle-cap 1500000 --seed <tile sha256 first 16 hex> --texture-index assets/textures/trees/index.json`.
   * Add `--coverage-fill 0 --leaves-per-cluster 160 --station-spacing 0.5 --mid-area-gain 1.5 --near-mid-area-gain 1.0` for the old density.
4. Viewer: `lod.setCrownShading({ innerDarkening: 0 })` turns the darkening off. Card zoom and alpha gain are `TreeTextureLibrary` options (`cardZoom`, `alphaGain`).
