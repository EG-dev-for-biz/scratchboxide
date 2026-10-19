# Process: Textured staged trees from a small tree texture library

> **Recorded:** 2026-10-19
> **Status:** Verified (with the shortfalls listed in section 3)
> **Tags:** `operate-scratchbox` `tile-vegetation` `tree-lod` `textures`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** In textured mode the staged trees wore the loader's flat grey. This change adds a small tree texture library and chooses a leaf set and a bark for each tree by its appearance. It is a quick fix; a fuller library comes later.
* **The library:** It lives in `assets/textures/trees/` and takes 16 MB. It holds 12 leaf atlases (`leaves/leaves_01..12/{color.jpg, opacity.png, normal.jpg, roughness.jpg}`, colour and opacity at 2K, the rest at 1K) and 8 barks (`bark/bark_01..08/{color, normal, roughness, ao}.jpg`, 1K). `index.json` (`scratchbox.tree-textures/1`) describes each entry by continuous quantities only:
  * colour mean and spread (linear sRGB and CIELAB);
  * leaf length and width in metres, coverage, and one atlas cell per leaf (base to tip);
  * bark relief index, furrow depth, ridge spacing and real-world size.
  * Each entry also has a free-text appearance description, which nothing branches on.
  * Sizes are estimates, and the index says how each was made.
  * The images carry no metadata (no text, ICC or EXIF chunks).
* **Instance used:**
  * Worktree `.claude/worktrees/tree-textures`.
  * Ports: web `3082`, API `3083`, tools `3084`. The server was started from the worktree with `npm run dev` and stopped by PID.
  * Screenshots came from the viewport canvas (`toDataURL`), posted to a local receiver on `3089`.
* **Scope tested:**
  * Prompt: `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees` (250 m district, 591 trees).
  * The district has no textured twin for the tiles (that pass runs on isolated structures). Textured mode for the trees was therefore switched with `applyClayRenderMode([trees], false)`, imported through Vite's `/@fs/` path.

---

## 2. What Was Tested & What Worked (Verified)

* **Measured colour and the choice:** Every one of the 591 trees carries `sbTree.colour`, with provenance `measured` (mean crown colour about linear (0.078, 0.088, 0.044), green share 1.0). Every tree also carries `sbTree.texture`, which records the entries, the tints and why each was chosen.
  * The final build chose 10 leaf sets: leaves_07 183, leaves_06 107, leaves_02 95, leaves_09 75, leaves_01 65, leaves_05 24, leaves_03 17, leaves_04 16, leaves_10 8, leaves_08 1.
  * It chose all 8 barks: bark_04 215, bark_06 130, bark_07 70, bark_08 50, bark_03 41, bark_02 37, bark_05 25, bark_01 23.
* **Viewer:**
  * The library dressed 591 trees: 9,639 leaf meshes, 2,364 wood meshes, 589 twig meshes and 591 far masses, with 0 unknown entries.
  * No shader errors appeared in the console.
  * Crown shading and the level dissolve still apply to the textured leaves.
* **Screenshots:** These are in `test-results/screenshots/tree_textures/` (gitignored). Each set is clay | before (the loader's grey) | textured, from the same camera.
  * `staging_clay_before_textured.png` (675 m): the far masses take the measured crown colour with gentle noise, and the canopy reads green-olive with a few yellowing crowns.
  * `mid_clay_before_textured.png` (110 m): bark on the trunks, alpha-cut leaves on the near and mid levels, coloured masses behind.
  * `close_clay_before_textured.png` (34 m): textured bark and green leaves at levels 0 and 1.
  * `near10m_textured.png` and `near10m_clay.png` (10 m): single leaves on twigs, and bark tiles around the trunks.
  * `streetview_vs_textured_vs_clay.png`: a real Street View photo (from `streetview_survey`, heading 47°) next to the same view, textured and clay.
* **Performance:** Canvas 709×843. Each figure is the median frame time (ms) of `lod.update` + `renderer.render` + a 1-pixel readback over 40 frames. Each mode was measured twice.

  | View | Triangles | Draw calls | Clay | Textured |
  |---|---|---|---|---|
  | Staging (675 m, all far) | 1,984,589 | 1,245 | 20.2 / 17.7 | 19.5 / 19.3 |
  | Mid (110 m) | 8,142,099 | 692 | 17.6 / 17.4 | 21.2 / 24.5 |
  | Close (34 m) | 3,959,894 | 417 | 17.8 / 17.3 | 19.9 / 19.5 |
  | Near (10 m) | 8,676,049 | 425 | 15.1 / 15.4 | 20.8 / 21.3 |

  The alpha-cut leaves cost fill rate:
  * about +2 ms at 34 m;
  * +4 to 7 ms at 110 m;
  * about +6 ms at 10 m.

  Far views cost nothing extra. GPU textures for all 20 entries take about 213 MB (44 textures). The trees GLB grows from 48.7 to 56.1 MB, because the wood now carries UVs.

---

## 3. What Broke / Didn't Work

* **Fixed during the session:**
  * Matching the photo's chromaticity gave 572 of 591 trees the same leaf set, because haze greys the photo. Leaves are now matched on hue, with saturation counting only weakly.
  * Distant leaves eroded under the alpha cutoff (coarse opacity mips). Alpha now rises with the mip level the leaf reads.
  * The first build loaded 648 MB of GPU textures. Packing opacity into colour (1K on the GPU) and roughness with AO brought this to 213 MB.
  * The scanned leaves rendered too bright, so the tint may now darken them further.
* **Still short:**
  * Textured crowns at 30-110 m read thinner than clay. A cut-out leaf covers 50-70% of its card, while a clay card is solid.
  * Next to the Street View photo, the real summer crowns through the arch are much denser than the rebuilt ones, textured or clay. This is mostly the leaf density of the tree levels, not the textures.
  * The library's absolute sizes are estimates: the leaf atlas's longer side is taken as 0.40 m and the bark scan's shorter side as 0.50 m.
* **Process issues:**
  * The first dev server, started inside the sandbox, could not reach Vertex AI ("fetch failed"). It was restarted outside the sandbox.

---

## 4. Candidate Tool/Service Ideas

* **Textured trees on a district:** a `staged_location_material_mode` switch that also covers the trees layer when the tiles have no textured twin. Here the only way was a console import.
* **`__SB_SCREENSHOT__` hook:** render a frame and return the canvas as PNG bytes to a path. Here a local receiver had to be run.

---

## 5. Reproduction Steps

1. Start the app from the worktree with your own ports (outside the sandbox, so Vertex AI is reachable), and open the token URL.
2. Send `Washington Square Arch district: stage the whole area around the arch (not isolated), with its trees`.
3. In the console, import clay mode: `const clay = await import('/@fs/<worktree>/packages/core/src/browser/generative-canvas/primitives/scene3d/clayRenderMode.ts')`.
4. Find the trees layer: `const trees = [...__SB_3D_EXTERNAL_OBJECTS__.values()].find(m => m.userData.sbTreeLod)`. Its `userData.sbTreeTextures` holds the dressing counts.
5. Switch to textured with `clay.applyClayRenderMode([trees], false)`, and back to clay with `true`.
6. Set cameras with `__SB_SET_CAMERA_VIEW__(target, {theta, phi, distance})`:
   * staging: `[0,0,0]`, `{0.785, 1.082, 675}`;
   * mid: `[0,5,0]`, `{0.785, 1.15, 110}`;
   * close: `[-21.3,8,-2.4]`, `{0.785, 1.4, 34}`.
