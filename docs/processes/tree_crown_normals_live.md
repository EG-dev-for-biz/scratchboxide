# Process: Soft crown normals on the leaves of staged trees

> **Recorded:** 2026-10-19
> **Status:** Verified
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `shading`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** Foliage read as faceted cards up close and as rocky masses at a distance. Each tree now carries an ellipsoid fitted to its delivered leaves, and the viewer shades the leaves with that ellipsoid's normals.
* **Instance used:** worktree `.claude/worktrees/tree-normals`. Ports: web `3072`, API `3073`, tools `3074`. The server was started from the worktree with `npm run dev` and these env vars, and stopped by PID.
* **Scope tested:** prompt `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees` (250 m district). The trees layer had 591 trees, and all 591 carried `sbTree.crown`. The controller reported `crownTrees` 591 and `crownLeafMeshes` 7,017.

---

## 2. What Was Tested & What Worked (Verified)

The camera was set with `__SB_SET_CAMERA_VIEW__`. Crown shading was toggled with `TreeLodController.setCrownShading({enabled})`. Each pair of shots was taken from the same camera. Screenshots are in `test-results/screenshots/tree_normals/` (gitignored).

* **Staging view (675 m, clay):** see `v1_clay_staging_off.png` and `v1_clay_staging_on.png`. Off, the far masses are faceted white lumps. On, each crown reads as one soft volume, lit on top and darker underneath.
* **Mid view (110 m, mostly level 2, clay):** see `v1_clay_mid_*`. On, crowns have a lit side and a shaded side. At blend 1.0, single blobs lose their own roundness, and the blobs on the shadow side of a crown read as flat darker patches. A far blend of 0.75 keeps some of each blob's roundness. It can be set live with `blend: [0.7, 0.9, 0.75]`. The default stays 1.0.
* **Close view (34 m, levels 0 and 1, clay):** see `v1_clay_close_*`. Off, the leaves are uniform glitter with no volume. On, the crown has a lit top, a shaded interior, and per-leaf variation.
* **Back-lit (camera facing the key light, clay):** see `v1_clay_backlit_*`. On, the camera side of the crown is an even mid grey. There are no black back-facing cards.
* **Textured mode:** set with `applyClayRenderMode(roots, false)`, so leaves wear the loader's material (`#c4c7cb`). See `v1_textured_staging_*` and `v1_textured_close_*`. The behaviour is the same as in clay.
* **Crossfade:** the camera dollied from 34 m to 90 m over 6 s; frames are `v1_clay_crossfade_1..3`. The JS log covered 144 frames. Up to 114 leaf meshes were in a dither at once, and every one of them wore a crown fade variant (`allCrown: true`). No mesh snapped to the plain material.
* **Performance:** measured with `lod.update` + `renderer.render` + a 1-pixel readback, median of 60 frames, twice each. The canvas was 709×843 and the pane was hidden. Off is the old shading path.

  | View | Triangles (off = on) | Draw calls | Median frame time, off | Median frame time, on |
  |---|---|---|---|---|
  | Staging | 1,937,786 | 1,165 | 12.6 / 11.7 ms | 13.0 / 12.8 ms |
  | Mid | 1,596,138 | 302 | 8.2 / 8.3 ms | 8.5 / 8.5 ms |
  | Close | 5,992,074 | 307 | 10.6 / 10.5 ms | 10.9 / 10.8 ms |

---

## 3. What Broke / Didn't Work

* The first district run was interrupted after the tiles stage, probably by my stop click on the earlier isolate run. A second prompt finished the run; its trees stage came from cache.
* The isolate run of `Washington Square Arch` planted 0 trees: its 3 crowns were `not_on_support_mesh`. This is not related to this change.
* This build has 591 trees, not 651.

---

## 4. Candidate Tool/Service Ideas

* **Render mode switch in the viewport:** a UI toggle for clay and textured. The only way here was importing `clayRenderMode.ts` through Vite's `/@fs/` path from the console.
* **`__SB_TREE_LOD__` debug hook:** a handle to the tree controllers (stats, `forceLevel`, `setCrownShading`). The only way here was through `__SB_3D_EXTERNAL_OBJECTS__` and the trees layer id.

---

## 5. Reproduction Steps

1. Start the app from the worktree with your own ports, and open the token URL.
2. In a new chat, send `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`.
3. In the console, get the controller: `const lod = [...__SB_3D_EXTERNAL_OBJECTS__.values()].find(m => m.userData.sbTreeLod).userData.sbTreeLod`.
4. Toggle with `lod.setCrownShading({ enabled: false })` and `lod.setCrownShading({ enabled: true })`. Change the factors with `lod.setCrownShading({ blend: [0.7, 0.9, 0.75] })`.
5. To make it persistent, set it in scene data: `treeCrownShading: { enabled: false }`.

---

## 6. Follow-up (2026-10-19): near leaves lost their shape

* **Reported:** close up, leaves of the staged Washington Square Arch district (clay) read as large flat angular plates.
* **Cause:** not the material. The leaves are geometry (SB-Veggie blades, no texture cutout), and the crown variant is a clone that keeps every material property. The cause was the near level's normal blend (0.7 toward the crown normal), plus the card normals turned to the crown's side with three's back-face flip dropped. Neighbouring leaves got almost the same normal, so their folds and outlines merged into flat patches, and the shootlets and petioles lit as bright as the blades.
* **Fix:** the near level no longer blends normals (`blend` 0 / 0.9 / 1.0). Leaves keep their own normal and three's back-face flip. Crown volume at every level now also comes from an occlusion term on the diffuse colour: darker toward the crown's underside and core, no normal change (`occlusion` 0.6 / 0.45 / 0.35). The mid and far levels still blend normals as before.
* **Evidence** (same camera, 13 m from a crown near the arch, port 3241; `test-results/screenshots/tree_lod_step/`): `regress_close_off_before.png` (shading off), `regress_close_on_broken.png` (a2e1b127), `regress_close_on_fixed.png` (fix), `regress_mid_on_fixed.png` / `regress_mid_off.png` (70 m).
