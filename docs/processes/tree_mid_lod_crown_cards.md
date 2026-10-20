# Process: A cheaper mid tree level (crown cards instead of mid leaf clusters)

> **Recorded:** 2026-10-20
> **Status:** Verified (with the shortfalls in section 3)
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `textures` `performance`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** after the density work (`tree_crown_density_live.md`), the mid level carried 2.6× the near level's leaf area. On the Washington Square Arch district it cost about 45k triangles a tree (31.5 M if every tree were at mid), and the triangle budget demoted 25-29 trees in the 110 m, 34 m and 10 m views.
* **Options weighed:**
  * **(A) Crown cards (shipped).** Each tree's mid level is a set of large cards over its crown. A card is one quad (2 triangles) showing a dense spray of leaves, cut from a shared card atlas.
  * **(B) Impostors (not built).** These are estimates, not measurements:
    * Memory: an 8×8 octahedral impostor at 128 px a view, with colour and normal+depth maps, is about 10.7 MB a tree with mips. That is 6.3 GB for 591 trees, or about 340 MB for 32 shape clusters. Sharing an impostor across trees also loses each tree's measured crown shape.
    * Resolution: at 64 px a view, a 15 m tree at the near end of the mid band (about 375 px tall at 34 m) would be blurry.
    * Bake: from the near level (a median of 434k triangles a tree), 64 views × 591 trees is about 16 G triangles to rasterise, natively or at load.
    * Relighting with the crown-normal shading, the breakup and the dither crossfade would need a dedicated impostor shader.
  * A gives back nearly all the triangles for about 15 MB of textures, keeps every tree's own crown, and reuses the existing crown, fade and shadow paths. A was the better choice.
* **What changed:**
  * **Native (`scratchbox_tree_lod.hpp`, `LodParams crownCard*`):**
    * The card atlas has 2×2 cells. Each cell holds 300 leaves inside a lobed outline (3-4 lobes, 0.35 deep), denser toward the centre.
    * `CrownCardLayout` is deterministic. `rasterizeCardMask` gives the cut-out (clay leaves are ellipses at the blade width ratio). A textured leaf is drawn at the clay leaf's area, so the clay and textured cut-outs cover alike.
    * `placeCrownCards`:
      * Card side = 2 cluster reaches (0.8-2.6 m).
      * Candidates are the placed clusters' leaf centres, at least 240 or half the clusters. Each candidate tries 5 orientations: the reference crown's outward normal, plus ±0.6 rad about two tangents.
      * A lazy greedy picks cards by the uncovered crown silhouette each covers, in the 9 coverage views at about 8 cells a card side.
      * It stops at the mid clusters' own coverage (`crownCardCoverageShare` 1), checked in the tree's full-resolution views. The cap is 5 × ellipsoid area / side².
    * Mid triangles are the wood plus 2 a card.
  * **GLB (`scratchbox_tile_vegetation.hpp`):**
    * Level 2 instances `sb_crown_card_k` (`EXT_mesh_gpu_instancing`) when a tree has cards.
    * Root extras carry `sbTrees.crownCards` (`scratchbox.crown-cards/1`, the leaf list) for the viewer.
    * Per tree: `lod.crownCards`, plus coverage `midClusters` and `cardTarget`. Stats add `msCards`.
    * New CLI flags: `--crown-cards 0|1`, `--crown-card-side-per-reach`, `--crown-card-coverage-share`.
  * **Viewer:**
    * `treeCrownCards.ts` bakes the atlas from the GLB's layout. The clay mask is plain ellipses. The textured atlas is the leaf set's cells at each leaf's pick, with empty pixels set to the mean leaf colour so mips do not darken the rims.
    * Cards wear the trees' clay surface (same grey, roughness and metalness), cut out by the mask. `clayRenderMode` reads `userData.sbTreeClay`.
    * Card materials use a plain alpha test with a mip alpha lift, not alpha to coverage (see section 3).
    * Card meshes are mid-level leaf meshes. They get the crown attributes, the crown variant and the dither variants unchanged. The shadow map copies their alpha map into the depth pass, so they cast leaf shadows, not squares.
    * The crown chunk's back-face "gap darkening" now skips cards (`SB_CROWN_CARD`, set by the card materials' onBeforeCompile).
* **Instance used:**
  * "Before": a detached worktree at origin/main fc70ed2f (ports 3382/3383/3384). "After": `.claude/worktrees/tree-mid-lod` (3372/3373/3374). Both used `npm run dev`, were started outside the sandbox, and were stopped by PID.
  * Canvas 613×711. The Browser pane was hidden.
  * The adaptive GPU budget was turned off for measuring (`localStorage['sb.adaptiveTreeBudget']='0'`); it varied 0.45-1.0 between runs. The default 14 M tree budget applied (13.2 M after the scene's share).
  * Screenshots: `canvas.toDataURL` posted to a local receiver on 3399.
* **Scope:** prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees` (591 trees). Cameras are as in the density doc. The Street View pose is approximate: target (0, 9, 0), θ −0.82, φ 1.52, 60 m.

---

## 2. What Was Tested & What Worked (Verified)

* **Native, the same crowns and seed (`tile_vegetation plant`, 591 trees):**

  | | Before (mid clusters) | After (crown cards) |
  |---|---|---|
  | Mid triangles a tree, p10 / median / p90 | 7,997 / 45,339 / 97,672 | 278 / 1,135 / 2,905 |
  | Every tree at mid | 31.49 M | 0.90 M |
  | Cards a tree, p10 / median / p90 | – | 22 / 119 / 271 (side 1.33 / 1.63 / 2.33 m) |
  | Mid coverage, clay (p10 / median / p90 of the 9-view mean) | 0.480 / 0.792 / 0.907 | 0.494 / 0.797 / 0.912 |
  | Least view, median | 0.712 | 0.742 |
  | Mid coverage, textured cut-out | 0.419 / 0.762 / 0.896 | 0.493 / 0.801 / 0.918 |
  | Trees short of their card target by > 0.01 | – | 0 of 591 |
  | Park-view frame estimate (lodFrames), median / p95 / max | 1.69 / 10.44 / 16.78 M | 1.31 / 9.05 / 14.27 M |
  | Plant wall time (all cores) | 10.8 s | 14.6 s (cards: median 109 ms CPU a tree) |
  | Trees GLB | 74.1 MB | 78.2 MB |

  * The near and near-mid levels are byte-for-byte the same.
  * In the app, the trees GLB went from 73.6 to 77.6 MB, and the trees stage took 20.7 s before and 16.9 s after (wall time, not comparable: cached inputs differ).

* **In the app:**
  * Same tab, run one after the other, 40-frame medians (`lod.update` + render + 1 px readback), 3 runs each, ms.
  * "Unbudgeted" is the triangles the views ask for with the budget lifted.

  | View | Tree triangles (budgeted), before → after | Budget-demoted trees, before → after | Unbudgeted demand, before → after | Clay ms, before / after | Textured ms, before / after |
  |---|---|---|---|---|---|
  | Staging (675 m) | 0.68 M → 0.68 M | 0 → 0 | 0.68 M → 0.68 M | 25.4-26.3 / 27.2 (two runs stalled at 75-77) | 25.9-28.0 / 24.5-24.9 |
  | Mid (110 m) | 12.94 M → 12.72 M | 25 → 0 | 14.59 M → 12.72 M | 28.2-30.0 / 24.1-27.1 | 39.3-41.8 / 30.8-31.3 |
  | Close (34 m) | 13.14 M → 13.05 M | 29 → 23 | 16.06 M → 14.41 M | 24.5-26.9 / 22.3-23.7 | 31.6-33.1 / 28.5-29.5 |
  | Near (10 m) | 13.09 M → 13.04 M | 29 → 27 | 16.98 M → 16.14 M | 23.2-25.0 / 21.6-22.5 | 31.3-33.1 / 29.9-32.7 |

  * At 110 m, the levels (near / near-mid / mid / far) went from 2/36/7/210 to 2/39/28/186. The budget no longer pushes mid-distance trees to far masses. What remains at 12.7 M is mostly the near-mid level (39 trees).
  * GPU memory of the trees layer: geometry and instances went from 167.5 to 137.8 MB. Textures went from 223.7 to 239.1 MB (the card atlases, 12 × 1.4 MB, and the mask).
  * Frame times across tabs were not comparable (the second tab ran about 5 ms slower on the unchanged staging view). These numbers are from one tab running each build in turn.

* **Crossfade:**
  * The camera pulled back from 34 m to 110 m over 6 s, for 113 frames in clay and 117 textured.
  * Up to 304 card meshes were in a dither at once, and every one wore a crown fade variant. No visible card mesh wore the plain material (`plainSnap` 0).
* **Screenshots** in `test-results/screenshots/tree_mid_lod/` (gitignored):
  * `mid_{tex,clay}_before_after.png` and `close_*`, `near_*`, `staging_*`;
  * `crossfade_dolly_34_to_110_{tex,clay}.png`;
  * `streetview_vs_before_after_textured_clay.png`;
  * `test_card_atlas_clay_mask.png`.
  * Raw frames are in `raw/`. The `dbg_*` frames are the debugging steps below.
* **Tests:**
  * `packages/core/test/tree-mid-lod-cards.test.ts`:
    * mid coverage within 0.03 of the clusters', and the cut-out not lower;
    * mid triangles under 10% of the clusters', and more cards on the larger crown;
    * a contract GLB, with the viewer bake's fill within 0.01 of the native mask per cell;
    * crown attributes, the crown variant and the dither variant with the crown chunk and cut-out;
    * clay one grey.
  * Updated: `tile-vegetation-textures` (card meshes and the card clay) and `tile-vegetation-lod` (cards at level 2).
  * The tree suites pass: 25 files, 258 tests passed and 9 skipped. `npm run typecheck`, `npm run lint` (0 errors) and `npm run lint:primitives` are clean.

---

## 3. What Broke / Didn't Work

* **Found and fixed during the session:**
  * **Dark cards:** the crown chunk's "gap darkening" for back faces is guarded by `#ifndef USE_INSTANCING`, but three.js defines `USE_INSTANCING` only in the vertex stage. Back-facing instanced leaves are therefore darkened by 0.55 too. On cards this made whole 1.6 m patches dark. Cards are now exempt. Instanced leaf clusters keep the old behaviour, which may not be what was intended: a follow-up.
  * **Material `defines` are lost:** they did not survive `MeshStandardMaterial.copy`, which the crown and fade clones use. The marker is now injected in onBeforeCompile.
  * **Bright specks on clay cards at 110 m:** alpha to coverage wrote the lifted mip alpha (between 0.5 and 1) into the frame, and the page showed through. Cards now use a plain alpha test. The near leaves still use alpha to coverage and may show the same thing faintly.
  * **Round discs:** the first layout read as discs with dark rims. The outline is now lobed, and empty atlas pixels take the mean leaf colour.
* **Still short:**
  * Forced to the mid level at 34 m, cards read as larger, rounder leaves than the clusters. The mid band normally starts at 60-140 m, where single leaves are under a pixel.
  * The Street View pose is approximate (the density doc's exact pose was not recorded). The before/after shots share the pose.
  * The pull-back dolly passes through a crown at about 59 m.
  * Build time went from 10.8 s to 14.6 s.
  * The photo-match evaluator's software renderer (`node/3d-engine/staged-location/tree-lod-view.ts`) drew triangles without alpha, so a mid-level tree there was drawn as solid card squares. Fixed on 2026-10-20 (branch `tree-view-alpha`): it now cuts cards and textured leaves out as the viewer does (`photo-match-eval-tree-cutout.test.ts`). That fix also found the viewer's clay mask opaque: an alphaMap reads green, and the bake fills empty pixels with the (white) leaf colour, so clay and loader-material cards were drawn as squares in the viewer too. `crownCardMask` now carries the cut-out in every channel.

---

## 4. Candidate Tool/Service Ideas

* **`__SB_TREE_LOD__.measure()`:** a frame-timing hook that runs `update` and render, reads the GPU timer, and reports `document.hidden` and `budgetScale`. Timings here were noisy, and the adaptive budget changed between runs until it was switched off.
* **Camera-path capture:** a timer-driven camera path that does not depend on requestAnimationFrame. The hidden Browser pane pauses rAF.
* **Alpha cut-out in the photo-match software renderer:** sample the card atlas mask, so mid trees are not solid squares there.

---

## 5. Reproduction Steps

1. Offline: `build/3d-native/tile_vegetation plant --crowns crowns.json --out t.glb --stats s.json --scene-triangle-cap 1500000 --seed <hex> --texture-index assets/textures/trees/index.json`. Add `--crown-cards 0` for the old mid clusters.
2. Per tree, see `perTree[].lod.crownCards` and `coverage.{mid,midClusters,cardTarget,cutout}`.
3. In the app, stage the district, then set `localStorage['sb.adaptiveTreeBudget']='0'` and reload.
4. The controller is `[...__SB_3D_EXTERNAL_OBJECTS__.values()].find(m => m.userData.sbTreeLod).userData.sbTreeLod`. `lod.forceLevel(2)` shows every tree at the card level.
