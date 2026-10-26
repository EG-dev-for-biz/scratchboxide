# Process: The front page's 3D Scene starter in both 3D viewports (Scene3D raster vs Metal path tracer)

> **Recorded:** 2026-10-21
> **Status:** Verified (both viewports rendered the same build); Needs Fix (two gaps below)
> **Tags:** `operate-scratchbox` `scene3d` `virtual-geometry` `metal` `path-tracing` `staged-location` `tile-refine`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user asked for a side-by-side of the two 3D viewports, each showing what the front page's **3D Scene** link produces.
* **Instance used:** web port `3310`, API port `3311`, tools port `3312` (own `scratchbox-metal-pt` entry in `.claude/launch.json`, removed afterwards).
* **Scope tested:** front page → **3D Scene** starter → staged location build in `Scene3DPrimitive`; the build's refined textured GLB opened with `virtual_geometry_open_glb` in `VirtualGeometryViewport` with **Path traced** and **Sun** on.

---

## 2. What Was Tested & What Worked (Verified)

* **3D Scene starter** — clicked **3D Scene** on the front page → it sent "Build a textured 3D scene of Plaza de Cibeles in Madrid with its surrounding streets, buildings and trees, on a sunny midday under a real sky with scattered clouds". `google_3d_tiles_get_clay` ran 50.4 s and `atmosphere_configure_scene` 6 ms. The build reports 376 leaf tiles remeshed by tile_refine into 567,566 triangles; the rectifier moved 34% of vertices by at least 1 cm (23% by more than 5 cm, up to 0.74 m). The textured twin is 80% photo texels (photo-inferred, not de-lit) and 20% clay. All 547 tree crowns were regrown as SB-Veggie trees (1.2 M triangles), with a 4 km Elevation API terrain and a midday sky with clouds. So the default path on main does run the scan clean-up.
* **Scene3D viewport** — Three.js WebGL, shadow maps, ACES, volumetric clouds. Screenshots: `docs/screenshots/viewport_compare/1_scene3d_fountain.jpg`, `3_scene3d_palace.jpg`.
* **Path-traced viewport on the same refined GLB** — after copying `public/models/plaza_de_cibeles_madrid_l2_tex_1500dd7b.glb` into the workspace: the `.sbvg` build took 15.1 s and produced 567,038 leaf triangles in 15 LOD levels and 25,509 clusters (79.6 MB). The WebGPU raster pass ran at 58-60 fps. The Metal path tracer converged to 256 spp at 1280x684 on a 294-339k triangle cut, with 488 materials and 517 textures (glTF plus 14 colour and 14 normal atlases), at 110-142 M rays/s, denoised in 9-14 ms. Screenshots: `2_pathtraced_plaza.png`, `4_pathtraced_street.png`, `5_pathtraced_tree_skirts.jpg`.
* Console errors: none during the session.

---

## 3. What Broke / Didn't Work

* **The staged build's GLBs are outside the workspace** — `virtual_geometry_open_glb` on `public/models/plaza_de_cibeles_madrid_l2_tex_1500dd7b.glb` failed with "does not exist in the workspace (/Users/eligreen/Dev/scratchbox-ide-master/desktop-app)". The staged build writes to the repo root's `public/models/`, while the workspace (and the virtual geometry tool's root) is `desktop-app/`. Worked around by copying the file into `desktop-app/public/models/` (gitignored).
  - Console evidence: none (the tool error shows in chat).
  - Suspected cause: two different roots for model output (staged pipeline) and workspace files (tools); not traced further.
* **The path-traced viewport shows one GLB, not the scene** — the staged scene is several layers: the refined scan, regrown trees, terrain, sky and clouds. `virtual_geometry_open_glb` takes one GLB, so the path tracer showed the refined scan only. The closing skirts the tree strip adds (72,939 m² of vertical sheets) stand bare where Scene3D draws the regrown trees over them (`5_pathtraced_tree_skirts.jpg`). The sky is the tracer's own sun-and-sky preset, not the scene's configured atmosphere.
* **Camera framing does not carry between the viewports** — each tab remounts with its own fit camera, so the pairs are framed by hand and only approximately match. A drag in the virtual geometry viewport also flew the camera to street level.

---

## 4. Candidate Tool/Service Ideas

* **Path-traced mode inside Scene3D** — send the Scene3D scene (all layers, its atmosphere and its camera) to the Metal helper and overlay the frames, instead of a separate viewport fed one GLB. This session had to open a second tab, copy a file into the workspace and frame both cameras by hand.
* **`virtual_geometry_open_scene`** — build the `.sbvg` from a staged scene's committed layers (refined scan, trees, terrain) in one call, resolving the pipeline's model root. Until that exists, the path tracer cannot show a staged build as the user sees it.
* **Shared camera between 3D tabs** — "open this view in the other viewport" so comparisons are exact.

---

## 5. Reproduction Steps

1. Start an isolated instance (own launch entry, free port triple), open the token URL, click **New Chat**, then the front page's **3D Scene** link; wait for "Finished — committed" (about 50 s).
2. `cp public/models/plaza_de_cibeles_madrid_l2_tex_<hash>.glb desktop-app/public/models/`.
3. In the same chat: "open public/models/plaza_de_cibeles_madrid_l2_tex_<hash>.glb with virtual_geometry_open_glb".
4. In the new tab: **Path traced**, then the studio/sun button for **Sun**; wait for 256 of 256 spp.
