# Process: Dense, dark-cored, translucent tree crowns, and the cheaper near-mid level

> **Recorded:** 2026-11-05
> **Status:** Verified headless (the app's own tree controller and texture library in headless Chrome, and the native plant's own measures). Not checked in the live app.
> **Tags:** `tile-vegetation`, `tree-lod`, `textures`, `shading`, `performance`
> **Target Domain:** native tree LOD (`scratchbox_tree_lod.hpp`, `scratchbox_tree_textures.hpp`, `scratchbox_tile_vegetation.hpp`) and the viewport's tree materials (`treeLod/`)

---

## 1. Session Context

* **What prompted this session:** the user's decision of 2026-11-05: make the regrown SB-Veggie trees of staged places look real, and finish the cheaper middle level `tree_crown_size_streetview.md` left undone (its step 2).
* **What changed:**
  * **Card sets (native).** `placeCrownCards` became one placer, `placeCardSet`, used three times:
    * the **near-mid level** is drawn as clumped leaf cards (`nearMidCards*`) in place of a share of every cluster's leaves;
    * the **near level** keeps every leaf and adds **core cards** (`coreCards*`): cards inset 0.9 cluster reaches beneath the leaves, placed only where the coverage views still see the crown through the blades. They stand for the inner foliage the station cap (0.8 × stations) leaves out;
    * the **mid level's** crown cards as before.
    * Every set aims at the larger of its own reference and the crown's Beer-Lambert target (`cardTargetShare`, 0.90 at full leaf), so the levels no longer inherit the near level's 0.51.
    * The far masses follow for free: they are spread to the near level's drawn cover, which rose.
  * **Open sprays.** The card atlas is 3 × 3 cells: 4 dense sprays (the mid level's, unchanged) and 5 open ones (90 leaves spread evenly, fill 0.27) for the near-mid and core cards. A first version used the dense cells at 12 m and each card read as one large lobed leaf. Near cards are sized from the tree's blade length (1.3 × and 1.25 ×), so their leaves are the tree's own size.
  * **Darker cores (viewer).** Inner darkening 0.3 → 0.55 over 1.2 m (was 1.5 m); core cards are shaded 0.7 (`coreCardShade`).
  * **Translucency (viewer).** One term, `translucencyFragment`, on leaves, cards and the far masses: gathered toward the sun (0.5 + cos³ of the angle between the line of sight and the sun), tinted yellower than the reflected colour (× 1.0, 1.12, 0.55), strength 0.5 (0.35 on the masses). It multiplies the diffuse colour, which already carries the crown's occlusion, so the core transmits less than the rim.
  * **Colour.** On main every tree was already tinted to its own crown's mean colour in the tile photo (610 of 610 here). Added: the tree's own leaf-to-leaf variation from the spread of that colour (`texture.leaves.variation`, a quarter of the relative spread, 0.08-0.45; the viewer used a fixed 0.18), and `texture.tintProvenance`: `photo-inferred` for a measured crown, `generated` with its reason for a fill.
* **Instance used:** none. A proof harness (scratch, `/Volumes/3DTESTING/trees-look-real/proof/`) bundles each arm's sources (main f4989130 from `git archive`, the branch's worktree) with esbuild and draws the place in headless Chrome at 1280 × 800: the devegetated tile, the trees with `TreeLodController` and `applyTreeTextures`, a sun with a 4096 shadow map, ACES tone mapping. It is not the app's sky, exposure or post-processing.
* **Scope tested:** Washington Square Park, the r 350 m extraction (`public/models/washington_square_park_new_york_ny_10012_40.73088_-73.99733_r350_textured.glb`), stripped once uncached with main's `tile_vegetation` (732 crowns, 612 trees; two whose crown base lies above every sample were set aside, as the plant refuses them), then planted by each arm's binary from the same `crowns.json` and seed: 610 trees.

---

## 2. What Was Tested & What Worked (Verified)

* **Native, per tree (p10 / median / p90 of 610):**

  | | Main | Branch |
  |---|---|---|
  | Near triangles | 43,153 / 280,255 / 1,014,930 | 43,364 / 280,656 / 1,016,302 |
  | Near-mid triangles | 11,666 / 79,392 / 288,456 | 372 / 1,472 / 4,688 |
  | Mid triangles | 225 / 1,056 / 3,182 | 300 / 1,134 / 3,520 |
  | Far triangles | 299 / 921 / 2,277 | the same |
  | Cards: core / near-mid / mid (median) | – / – / 80 | 280 / 274 / 127 |
  | Coverage, near blades | 0.25 / 0.52 / 0.68 | the same blades |
  | Coverage, near blades + core cards | – | 0.61 / 0.84 / 0.90 |
  | Coverage, near-mid | 0.37 / 0.68 / 0.83 | 0.84 / 0.91 / 0.92 |
  | Coverage, mid | 0.51 / 0.80 / 0.91 | 0.88 / 0.90 / 0.91 |
  | Drawn coverage, far | 0.43 / 0.71 / 0.83 | 0.65 / 0.85 / 0.91 |
  | Every tree at near-mid | 76.6 M | 1.26 M |
  | Frame estimate (lodFrames) median / p95 / max | 1.10 / 10.4 / 20.3 M | 0.25 / 3.0 / 8.6 M |

* **On screen** (10 trees from the 8th to the 95th height percentile, each alone, 4 sides, textured, crown holes on; share of the crown ellipsoid's pixels covered, median): near 0.77 → 0.97, near-mid 0.82 → 0.96, mid 0.73 → 0.84, far 0.60 → 0.80.
* **Frames** (median of 40, `lod.update` + render + a 1-pixel readback, shadows on; triangles include the shadow pass):

  | View | Triangles | Trees held back by the budget | Frame |
  |---|---|---|---|
  | Far (about 200 m) | 15.3 M → 3.2 M | 128 → 0 | 32 → 27 ms |
  | Mid (30-110 m) | 14.9 M → 7.2 M | 175 → 0 | 50 → 29 ms |
  | Near (12 m) | 14.1 M → 7.2 M | 81 → 0 | 40 → 26 ms |
  | Close (7 m) | 13.2 M → 9.7 M | 91 → 0 | 31 → 25 ms |
  | Street | 14.3 M → 4.8 M | 89 → 0 | 26 → 25 ms |

  An earlier pair on a quieter machine read 73 → 32 ms far and 67 → 32 ms mid; other sessions were loading the machine throughout, so read the trend.
* **Pictures** (`docs/screenshots/trees_look_real_2026-11-05/trees_look_real_before_after_sheet.png`, gitignored; 14 numbered panels):
  * **Mid:** main shows see-through skeletons and, where the budget pushed trees down, far masses. The branch shows closed crowns.
  * **Near and close:** main shows the limbs through the crown. The branch closes it, with dark foliage behind the lit leaves.
  * **Backlit:** the branch's crowns glow yellow-green toward the sun and stay dark in the core, as the right-hand tree of the Street View photo does.
  * **Far:** closed canopy, nearer the scan's own (panel 3).
* **Tests** (Node 22.18, credentials out of reach, touched and importing files only): 41 files (38 passed, 3 skipped for want of a tile or a staged trees GLB on disk), 389 tests: 370 passed, 19 skipped, 0 failed. A first run with the load average over 200 had two timeouts and the park frame estimate, which expected the old near-mid cost and was rewritten. `npm run typecheck`: exit 0 (the electron project with the main checkout's `desktop-app/node_modules` linked in; this worktree has none). `npm run lint:primitives`: passed.

---

## 3. What Broke / Didn't Work

* **Cost.**
  * Plant CPU 438 s → 731 s for 610 trees (1.67 ×; wall 31-33 s → 51-75 s on a loaded machine): three card placements a tree where there was one.
  * Trees GLB 84.2 → 108.7 MB: 662,000 card instances, where the near-mid clusters shared the near level's instance data.
* **Still short, from the pictures:**
  * The regrown crowns are darker, more olive and more separate than the scan and the photo. The tint is the crown's mean colour in the aerial photo, shade included, and the viewer shades it again.
  * Mid-level cards (dense sprays, 2.4 m) read as round clumps from 40-100 m, and crowns as smooth balls.
  * The near level is darker than the near-mid level (mean brightness of the covered pixels 0.171 against 0.202): the near-mid cards sit on the crown's surface and show no core. A tone step at the 12-30 m handover.
  * Core cards seen from 7 m are flat sprays; they pass because they are in shade.
  * The translucency term is not shadowed: a leaf in another crown's shadow still glows.
* **Not done:**
  * The live app (sky, exposure, the adaptive budget) was not checked.
  * The instanced-leaf back-face darkening (`USE_INSTANCING` is defined only in three's vertex stage) is as it was: near leaf clusters still take it, cards do not.
  * The photo-match evaluator's software renderer cuts the new cards out but does not shade core cards.
  * The Street View panel's pose is approximate, and its photo is June 2021.
* **Tried and dropped:** the dense card cells for the near sets (each card read as one large leaf); a variation of half the relative spread (most trees hit the 0.45 cap); core shade 0.6 (tone step too large).

---

## 4. Candidate Tool/Service Ideas

* **The proof harness as a test helper:** one page that loads a staged place's tile and trees with the app's controller and textures, sun and shadows, and returns named views, frame times and per-tree on-screen coverage. `tree-lod-harness` is clay only and has no tile.
* **A lit-colour reading in strip:** the crown's colour over its sunlit cells only (an upper quantile), so the tint is an albedo and not a shaded mean.
* **Inner cards for the near-mid level:** a share of its cards inset, shaded as core cards are, so its tone matches the near level's.

---

## 5. Reproduction Steps

1. `tile_vegetation strip --input <tile.glb> --out devegetated.glb --crowns crowns.json --stats s.json --seed <tile sha256 first 16 hex> --species-index assets/vegetation/species/index.json`.
2. `tile_vegetation plant --crowns crowns.json --out trees.glb --stats stats.json --scene-triangle-cap 1500000 --seed <hex> --texture-index assets/textures/trees/index.json --species-index assets/vegetation/species/index.json`. For the old levels add `--near-mid-cards 0 --core-cards 0 --card-target-share 0`.
3. Per tree, in `stats.json`: `lod.nearMidCards`, `lod.coreCards`, `lod.coverage.{level0Core, nearMid, nearMidClusters, nearMidCardTarget, coreCardTarget}`.
4. Viewer: `TreeTextureLibrary` options `translucency`, `translucencyTint`, `translucencyFocus`, `massTranslucency`, `coreCardShade`; `lod.setCrownShading({ innerDarkening, innerDepthM })`.
