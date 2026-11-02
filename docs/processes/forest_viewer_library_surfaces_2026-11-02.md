# Process: The forest demo page's floor, moss, fern and bark surfaces drawn from the texture library at real size

> **Recorded:** 2026-11-02
> **Status:** Verified (Wideshot, Canopy, Hero and Ferns bookmarks and four close views before and after; no console errors, no failed responses, no `/textures` request; the forest test passes with credentials unreachable). Section 6: conifer crowns now draw the needle-spray atlas (species classification linked to the leaf choice), Verified. Section 7: pointed crowns whose species holds its leader grow excurrent (a stem through the crown, laterals at the species' angle), Verified. Needs Fix, not done here: the page's lighting was tuned for the old maps (section 3), and spray-sized leaf cards need a porous-leaf coverage rule in the leaf shaders (section 7).
> **Tags:** `operate-scratchbox` `demos` `pbr-materials` `texture-library` `forest-viewer` `sb-veggie` `tree-species`
> **Target Domain:** static demo page `/forest_3d_viewer.html` and its native generator `scripts/generate_forest_procedural_3d.cpp`

---

## 1. Session Context

* **What prompted this session:** `forest_viewer_sb_veggie_crowns_2026-11-02.md` section 3. The floor, bark, fern and moss maps (`public/textures/photo_*`) were crops of the reference photograph: the bark map was two trunks and the forest between them, and the floor map had ferns and moss in it. Tiled on the surfaces they read as noise or painted scenery.
* **Branch:** started from `claude/determined-nightingale-4d8473` (2fce88ea, the SB-Veggie crowns).
* **Instance used:** own launch entry `scratchbox-elated-wright` (web `4170`, API `4171`, tools `4172`) run from this worktree. `scratchbox-dev` was not touched.
* **Screenshots:** headless Chromium (Python Playwright, ANGLE on Metal) at 1600 x 1000. Each view sets the camera to the bookmark's `pos`, `target` and `fov` and records the median of 40 frame times. The before set came from the 2fce88ea page and GLB, regenerated from that commit's generator; the extra close views were served under a temporary name that was deleted afterwards. Also checked in the Browser pane: console, network and the Canopy Sunbeams button. Sheet: `docs/screenshots/forest_surfaces_2026-11-02/forest_surfaces_before_after_2026-11-02.jpg` (gitignored).

---

## 2. What Was Tested & What Worked (Verified)

* **Sets chosen by measurement from the app's texture library** (`gs://scratchbox-library-training-textures`, indexed in `assets/textures/library/index.json`, ambientCG and Poly Haven, CC0). Each candidate's publisher colour preview was measured against its region of `public/forest_reference.png`, using chromaticity in linear sRGB and, for bark, the vertical anisotropy of its luminance gradients. A candidate needed a colour map in the bucket and a real tile size.

  | Surface | Photo region (px) | Chosen | Real tile | Why | Runners-up (chroma L1 distance) |
  | :--- | :--- | :--- | ---: | :--- | :--- |
  | needle duff | 760,640 - 1000,715 | `Ground071` (ambientCG) | 1.75 m (publisher) | Fibrous needle and twig litter, chroma 0.100. `forest_ground_05`/`06` are a little closer in chroma (0.094 / 0.083) but almost featureless compacted soil: luminance spread 2.0 / 3.3, against Ground071's 8.1. | Ground072 0.102, Ground106 0.125, forest_leaves_03 0.143. `forrest_ground_03` (pine needle litter), `forest_floor` and `forrest_ground_01` have no colour map in the bucket. |
  | bark | the two near columns, 120,100 - 280,420 and 990,40 - 1150,400 (moss pixels out) | `bark_willow_02` (Poly Haven) | 2.15 m (publisher) | chroma 0.023; vertical anisotropy 2.40 against the photo's 2.0 / 3.0 (long vertical fissured ridges) | bark_brown_02 0.074, Bark014 0.089, trees-library bark_05 0.090, chinese_cedar_bark 0.201 |
  | moss | the nurse log's top and the right column's base | `Moss001` (ambientCG) | 0.45 m (publisher) | chroma 0.238 (yellow-green) | Moss002 / 003 / 004 0.44 - 0.50 (grass green, size only estimated) |
  | fern pinnae | fronds at 30,560 - 380,700 (green pixels) | `leaves_08` (tree texture library) | 0.343 x 0.124 m leaf | chosen in the generator by shape, real length and colour: cost 0.55 against a 0.35 m pinna of width/length 0.33; next best leaves_03 at 1.42. A pinnate spray: each coarse pinna reads as a frond segment. | |

* **Copies** (`scripts/copy_texture_library_sets.py`, new): the three sets' 8K maps (2.6 GB) were fetched with the app's `fetchLibrarySets`, area-resampled (colour in linear light, normals renormalised, as `material_maps::prepare` does) and packed into albedo / normal / ORM JPEGs under `assets/textures/library/copies/<id>/`. `index.json` there records the publisher's size and the colour, roughness and normal tilt measured on the written maps. Ground071 and bark_willow_02 are at 2048 px (0.85 / 1.05 mm per texel), Moss001 at 1024 px; 19 MB in all. Copies are never tinted.
* **The generator** (`scripts/generate_forest_procedural_3d.cpp`):
  - reads the copies and the tree texture library, not `public/textures`;
  - measures the photo regions itself, so a missing set or photo stops the build.
  - **Tint**, written as each material's `baseColorFactor`: the region's chromaticity over the set's, scaled so the largest channel is 1. Then a luminance share darkens a surface the photo shows darker relative to the duff than its set is. Only the bark is darkened (share 0.44, to albedo ≈ 0.09); the duff, moss and fern keep their sets' own albedo.

    | Surface | Factor |
    | :--- | :--- |
    | floor | (0.939, 0.743, 1) |
    | bark | (0.440, 0.422, 0.398) |
    | moss | (1, 0.766, 0.289) |
    | fern | (1, 0.790, 0.679) |

  - **UVs at real size:**
    - floor: metres over 1.75 m;
    - moss cushions: metres over 0.45 m;
    - moss tufts: projected across and up their blades;
    - columns, roots and logs: a whole number of bark tiles around each at its mean radius, and metres along. The columns gained a seam column of vertices; before, the last quad ran u from 3.9 back to 0.
    - fern pinnae: one leaf cell each, at the leaf's own width over length, with the leaf's opacity in the albedo's alpha (MASK, cutoff 0.5).
  - **Vertex colours** only modulate the tinted map: duff 1, damp humus and loam darker, the flutes' crevices darker, moss on bark as the photo's moss chromaticity over its bark.
  - **Surfaces regrouped:**
    - the moss (hummocks and log tufts) is its own `Forest_Moss_Cushions` / `PBR_Moss`;
    - the polypores moved to the undergrowth, which draws in its own vertex colours with no map;
    - the floor lost its green vertex-colour moss patches, since the moss is the cushions.
  - **Tangents:** every vertex in the GLB carried the placeholder tangent (1, 0, 0, 1), so normal maps were lit in a wrong frame. The generator now computes glTF tangents from the UVs.
  - **Provenance:** each textured material's `extras.sbSurface` names the set, library, publisher, licence, real size, UV rule, tint factor, luminance share, measured colour and regions.
  - **Size and time:** forest GLB 47,096,692 B -> 67,561,136 B. Still 12 embedded maps; triangles unchanged at 602,445. Generation takes 7-12 s.
* **The page** (`public/demos/showcase/forest_3d_viewer.html`):
  - draws the GLB's factors, normal scale, roughness and alpha cutoff as authored; its overrides (`normalScale` 2.6, repeats of 12 / 2 / 4 / 1 x 0.4, alphaTest 0.35) are gone;
  - the bark/ground shader no longer paints a per-pixel hash speckle, "edge wear" toward a fixed brown, crevice grime from a world-space sine pattern, or settled dust over the maps. These were the floor's beige ovals and most of the noise;
  - its rim light is scaled by the surface's albedo instead of adding up to +0.45 white after tone mapping;
  - the foliage kernel's noise applies only to untextured leaves (the crowns);
  - a moss branch is added;
  - the crowns' grown wood takes the forest bark at its real size: repeat = the tree's `texture.bark.tileM` / 2.15 m, normal Y flipped for derivative tangents.
* **Bookmarks after** (headless frame time, ms, before -> after; triangle counts unchanged):

  | View | Before | After | What changed |
  | :--- | ---: | ---: | :--- |
  | wideshot | 50.6 | 46.2 | Before: columns pale with photo stripes. After: brown fissured bark, red-brown duff, green cushions (the haze still washes them) |
  | canopy | 31.3 | 33.2 | The far-left column's sunlit flank is warm fissured bark (before: white-grey); its shaded face is dark |
  | hero | 16.8 | 11.6 | Fern pinnae are feathery sprays instead of flat green kites (the camera is still inside the fern bank) |
  | ferns | 12.5 | 9.9 | Same; the duff under them shows needles and twigs instead of beige speckle |
  | bark (diagnostic, 4 m) | 12.4 | 11.2 | Real fissured bark instead of photo stripes and speckle |
  | floor (diagnostic) | 11.7 | 8.7 | Needle duff instead of beige ovals |
  | log (diagnostic, 5 m duff) | 9.6 | 8.2 | Needles and twigs at real size |

* **Live checks** (Browser pane, port 4170): no console errors; `GET /forest_3d_viewer.html`, `/models/forest_hyperreal.glb` and `/models/forest_hyperreal_trees.glb` answer `200`; no request under `/textures/`; the Canopy Sunbeams button lands on the far-left column.
* **Tests** (`env -i PATH=... HOME=<empty>`: credentials unreachable): `packages/core/test/forest-hyperrealistic-3d-reconstruction.test.ts`, 7 of 7. It was run from a deleted binary, so the app's `NativeCppCompilerService` compiled the generator, now with `-lz`, which the photo and PNG codecs need. New checks:
  - every textured material's `sbSurface` (provenance, real size equal to the copy's, tint);
  - the floor's U range = 80 m / 1.75 m;
  - the floor, bark and moss albedo images byte-identical to the copies;
  - over 99% of the columns' tangents perpendicular to their normals.

---

## 3. What Broke / Didn't Work

* **The page's lighting was tuned for the old maps.** Their albedo was about 0.01 (the map times vertex colours), 10-20 times darker than real material. With real albedos:
  - Sun 4.8 at exposure 1.24 makes sunlit duff read pale salmon.
  - The green hemisphere (`0x78a088`, 1.45) and fill (`0x709080`) lights turn shaded bark olive.
  - Only the bark was brought down, and only by the photo's own luminance ratio; the lights were not changed. A lighting pass against the reference photo is the next step.
* **Moss on the columns' bases is a tint of the bark map**, not moss. Heavily mossed bases read as dark olive bark. Blending the moss map there needs a second map on the bark material (the page could do it from the vertex colour's chroma); not done.
* **Fern pinnae are still the coarse kites:** leaves_08's sprays are cut by the kites' edges. Once the pinnae are real size (5-10 cm), a lanceolate leaf (leaves_07) at one leaf per pinna would fit. The fern leaf is a cypress-like spray chosen by shape, size and colour, not a sword-fern scan; the tree texture library has no fern.
* **The god-ray sheets** (`Atmospheric_Crepuscular_Sunbeams`, additive) lie over every near view as pale translucent planes. This is what made the moss cushion behind the ferns look smooth grey. Unchanged.
* The hero and fern bookmark framings are unchanged (cameras inside the fern bank).
* The 1.75 m duff tile repeats; no grid was visible in the shots (the wideshot is hazed), but a low wide view may show it.
* `public/textures/photo_*` and `scripts/extract_forest_pbr_textures.ts` are now unused. They were kept: removing them is a cleanup of its own.

---

## 4. Candidate Tool/Service Ideas

* **GLB writer tangents.** `io::GlbWriter` writes each vertex's `tangent`, and `ScratchboxMesh` defaults it to (1, 0, 0, 1). Any generator that embeds a normal map without setting tangents gets a wrong frame. Computing UV tangents in the writer when a material has a normal texture would fix every producer; this generator's `computeTangents` could move there.
* **One-step library copies.** Today it takes a vite-node call to `fetchLibrarySets` and then `scripts/copy_texture_library_sets.py`. A `texture_library_copy` script that fetches, copies with the native `material_maps::prepare` and writes the copies index would make offline producers one command.
* **Image names in GLBs.** `EmbeddedTexture.name` is not written to `images[]`, so a viewer or test cannot tell which set a map came from without following the material.
* **Demo lighting check.** The demo pages could be checked by rendering a grey card and a known albedo under each page's lights and comparing exposure, so that pages tuned around wrong albedos are caught.

---

## 5. Reproduction Steps

1. Library copies (needs the app's Google credentials; about 2.6 GB of 8K maps): fetch `Ground071`, `Moss001`, `bark_willow_02` with `fetchLibrarySets` into a cache directory, then run `python3 scripts/copy_texture_library_sets.py <cache> Ground071:2048 Moss001:1024 bark_willow_02:2048` from the repository root.
2. `clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include scripts/generate_forest_procedural_3d.cpp -o build/3d-native/generate_forest_procedural_3d -lz`, then `build/3d-native/generate_forest_procedural_3d public/models/forest_hyperreal.glb`. The run prints the leaf ranking, each surface's set, real size and tint.
3. Start an instance on free ports (`operate-scratchbox`) and open `http://127.0.0.1:<web>/forest_3d_viewer.html`. Network shows the two GLBs and nothing under `/textures/`.

---

## 6. Conifer foliage: the species classification linked to the leaf choice and drawn on the page (same day)

* **What prompted it:** the crowns read as broadleaf trees. The species library's chooser (`scratchbox_tree_species.hpp`, the tree classifier: crowns matched by height, crown proportions, top share and hue) already called the forest's crowns conifers: coast redwood 20, spruce 23, Italian cypress 2 (olive 3 and honey locust 1 in the understory). But the classification stopped at the crowns' proportions.
  - **Leaf choice:** `tree_textures::choose` ignored a species leaf shorter than every atlas leaf (a 2 cm needle against 6.6 cm and up) and never compared leaf form. Every redwood drew a broad leaf (`leaves_01`, heart-shaped), although the tree texture library has a needle-spray atlas (`leaves_08`).
  - **The page** drew all crown leaves in flat colour, with no atlas.
* **Measured leaf form** (`scripts/measure_tree_leaf_blades.py`, new): each leaf atlas in `assets/textures/trees/index.json` gains `leaf.bladeWidthM`, the width of its flat parts (2 x opaque area / outline length, outline counted in pixel edges x pi/4, median over its cells).

  | Atlas | bladeWidthM |
  | :--- | ---: |
  | broad leaves | 20-53 mm |
  | `leaves_12` (small lobed, bristle-tipped) | 8.3 mm |
  | `leaves_08` (needle spray) | 2.65 mm |

  This is data in the library, measured: no form enum and no branch on names.
* **Native link** (`scratchbox_tree_textures.hpp`, `scratchbox_tile_vegetation.hpp`):
  - the matched species' leaf now also gives a blade width (`bladeWidthOfLeaf`: the same measure on an ellipse of its length and aspect). Coast redwood 1.8 mm, spruce 1.5 mm, cypress 1.1 mm, olive 9 mm, oak 40 mm.
  - the leaf choice adds `(ln(entry / species) / 0.6)^2` while the species' width is within 3x of the library's range;
  - the tree's extras record `bladeWidthM` and `targetBladeWidthM` (declared in `staged-location-contracts.ts`);
  - the trees GLB's `textures.chosenBy` says so.
  - **Result for the forest:** all 45 crowns matched to coast redwood, spruce or cypress draw `leaves_08`; the 4 broadleaf understory crowns draw `leaves_06` / `leaves_01`.
  - This applies to every SB-Veggie build: staged-location trees the species library matches to needles or scales now draw the spray too.
* **The page** draws each crown's chosen atlas on its leaf cards as the app's viewport does (`treeTextureMaterials.ts`): the card's blade coordinates and `_LEAF` pick into one atlas cell, the leaf cut out by its opacity, tinted by the tree's tint, with the page's foliage lighting kept. The atlases come from `/assets/textures/trees/`, the tree texture library the app serves its viewport, proxied to the API on the page's origin. Without that route the leaves keep each tree's flat colour and the HUD says "LEAF ATLASES NOT LOADED".
  - **Live:** 408 leaf-card meshes drawn with `leaves_08` / `06` / `01`; no console errors; no failed responses; nothing under `/textures/`.
* **Before / after** (commit ae720963's headers, generator and page, against this change; headless, same views):
  - In the crowns view (camera 9 m up, looking into the crowns) the foliage goes from solid leaf flakes to fine needle sprays.
  - In the Canopy view the overhead foliage is feathery.
  - In the Wideshot the difference is small: at 32 m under the haze, the crowns' clumped arrangement dominates the leaf.

### Still broadleaf-like (not done)

* **Crown architecture.** SB-Veggie grows long sinuous scaffold limbs by space colonisation into the described crown. A coast redwood has a straight leader with short, near-horizontal, whorled branches carrying drooping sprays. The species entry's `apicalDominance`, `branchAngleRad` and `scaffoldBranches` do not yet produce that form. This is what still reads broadleaf from the bookmarks.
* **Spray size.** The LOD sizes leaf cards from crown height (0.08-0.14 m), so a 0.34 m spray is drawn at about 0.4 of its size, as in the app's viewport. Sizing the cards from the chosen atlas leaf would change every tree's cluster geometry and budgets.
* **Foliage colour.** The crowns' described colour is lifted pale by the page's haze and the foliage kernel's airlight.

---

## 7. Conifer architecture: an excurrent leader with laterals at the species' angle (same day)

* **The cause of the broadleaf look:**
  - `growSkeleton` (space colonisation, `scratchbox_nature.hpp`) grew every tree as a trunk to its crown break, forked into 2-4 scaffold limbs, which colonised the crown: a decurrent form whatever the species.
  - The species library's apical dominance cannot express a cone: redwood 0.62, spruce 0.6, birch and ginkgo 0.6 too, and the index notes the grower stalls above about 0.65.
* **Excurrence** (new, continuous, 0 grows exactly as before), per crown in `tile_vegetation`:
  - `(1 - smoothstep(0.15, 0.30, measured top share)) x smoothstep(0.45, 0.60, apical dominance)`. A cone's top share is about 0.12 and a dome's about 0.58; the species library's conifers lie at 0.12-0.20, its broadleaves at 0.35 and over. The forest's redwood crowns measure 0.011, so 1.
  - A first band of 0.20-0.45 also made the test suite's steep broadleaf domes (top share 0.27) excurrent; 0.15-0.30 leaves them at 0.10.
  - At excurrence `e`, the leader carries on through `e` of the crown depth above the break before colonisation; the scaffold limbs still leave at the break.
  - A lateral sprouting beside a shoot leaves at the species' `branchAngleRad` from that shoot.
  - Shoots off the leader are steered `0.6 e` of the way toward that angle from the vertical, with tip droop `+0.25 e`.
  - Recorded in each tree's `extras.inferred` as `topShare` and `excurrence`.
  - The band is part of the growth record `strip` writes into crowns.json and `plant` reads back (`scripts/tile_vegetation.cpp`), so measuring and planting grow the same trees.
  - `tree-mid-lod-cards.test.ts` compares card counts of a 6 m and a 4.5 m crown. Its 6 m crown (top share 0.19, eucalyptus) grows excurrent by default, which changes its card count: 314 decurrent, 261 excurrent, same coverage target met. Card count follows crown shape as well as area: a scaled copy of the small crowns gets 247 decurrent. So the test now plants its crowns at one growth form (decurrent) through that record.
* **Engine check** (new case in the forest test): a 30 m cone of attractors, branch angle 80 degrees.
  - At excurrence 0 the trunk stops at the break (leader share 0.005, laterals 32 degrees from vertical, 98% reached).
  - At excurrence 1 the leader runs through 0.998 of the crown, laterals hold at 90 degrees (80 plus droop), 100% reached.
* **Forest:** every redwood crown grows at excurrence 1.
  - **Crowns view:** short, near-level laterals in tiers along a straight stem, where before there were long winding scaffold limbs.
  - **Wideshot:** the crowns are narrow columns of foliage around their stems instead of spreading forks.
  - Crown triangles are unchanged (83,070 of an 85,426 budget); generation 1-3 s.
* **Leaf cards at the atlas leaf's size: tried and reverted.**
  - Sizing the cards from the chosen leaf (0.34 m for the spray) spaced the stations 3x wider; crown triangles on screen fell from about 14 M to 3.7 M.
  - The leaf shader's mip-alpha boost (`uSbMipScale`, meant to keep a solid leaf from eroding at distance) turned each distant spray card, which covers only 37% of its box, into an opaque flake. The page renders without MSAA, so alpha-to-coverage does not help.
  - The Wideshot read as a field of solid pale flakes, so the cards stay sized from crown height.
  - Drawing sprays at their real size needs a coverage rule for porous leaves (for example hashed alpha, and a boost scaled by the leaf's fill) in the app's viewport shader as well as the page's: a change of its own.
