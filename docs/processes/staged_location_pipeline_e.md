# Staged Location Builds: Pipeline E (clean vector massing, ortho textures, verified inference, opt-in enhanced mode)

> **Recorded:** 2026-10-19
> **Status:** Verified behind a flag (`SCRATCHBOX_STAGED_PIPELINE=e`, off by default). Within pipeline E enhanced appearance is the default since round 4 (realism-first directive); the real-data view is `enhance: false` or `SCRATCHBOX_STAGED_ENHANCE=0`. Since round 5 enhanced mode uses Nano Banana Lite behind an identity gate (section 7). Not on main: for the user's review.
> **Tags:** `operate-scratchbox` `staged-build` `pipeline-e` `google-vector-data` `solar-api` `facade-grammar` `photo-match` `provenance`
> **Target Domain:** Real-world 3D locations (`google_3d_tiles_get_clay`, `isolate: true`)

---

## 1. What pipeline E is

The current pipeline (D) remeshes the scan, tries a scan fit and textures the remesh; on ordinary buildings the fit is refused and the remesh keeps the tile's melted look. Pipeline E starts from Google's own massing instead and keeps only what the scan proves.

1. **Massing** (`pipeline-e/massing-spec.ts`). The building's vector footprint parts with their own heights (`vector-footprints.ts` now keeps `extruded` parts and modelled `volumes`), Solar roof facets read through `location_building_shape` (`runBuildingShape`; flat facets give the roof level, pitched facets become roof planes only when each lowers the roof's error against the scan), and the modelled volume where Google has one (made single-sided: Google repeats every triangle with both windings). Loops simplified to clean corners. Checked against the scan: plan IoU with the structure cells and median roof error. Below IoU 0.6, or a roof further off than max(3 m, 15 % of the height), the build falls back to the current pipeline and records the numbers.
2. **Native solid** (`scratchbox_staged_massing.hpp`, `scripts/staged_massing.cpp`, built through the native build cache). Prism parts are extruded to a closed solid (a wall whose outside is another part's inside is cut to what stands above it; roofs are the lower envelope of the planes); walls are moved onto the facade the scan measures (area-weighted mode of the scan's outward vertical surface within 4 m, corners re-intersected); a modelled volume is moved as a whole by the horizontal translation that best explains its facades' offsets. Signed volume is the closure check (synthetic tests: 2600 m³ for two boxes, exact).
3. **Residual scan.** The isolate's tile triangles are classified against the solid: clusters at least 2 m² that reach 1.5 m proud of it or cut into it are kept as scanned with their tile photo (labelled `as-scanned`); a cut cluster at least 2 m deep that fills its box on a wall opens that wall; the ground apron stays. Everything else is the clean solid.
4. **Face textures.** Each face is an orthographic render of the (devegetated) photo tile through a thin slab about its plane (walls -1.5 .. +0.8 m; roofs seen from above). No distance-gated transfer. Uncovered texels take the nearest covered one; a face the tile hardly sees (party walls, coverage < 35 %) takes one median colour, labelled.
5. **Inference** (`pipeline-e/inference.ts`, in the grammar stage's slot, background, each step verified and labelled `photo-inferred` with a confidence; generated fill labelled `generated`):
   - (a) roof (`roof-infer.ts`): pitch, ridge, hips, parapet, raised blocks read from a top-down render; pitch kept when it lowers the roof error by 10 % and agrees with Solar within 10°, parapet when the scan's rim stands 0.5-2× the read height, blocks when they stand 1 m proud;
   - (b) bands (`band-infer.ts`): read from a side-on section render, kept where the scan's cross-section stands out by the read depth; swept with mitred corners;
   - (c) windows: the existing facade grammar on the wall orthos, recessed at the depth the ortho depth map measures;
   - (d) averaged bays (`bay-average.ts`): bays co-registered by NCC, per-texel median, re-placed with each bay's own low-frequency colour; held-out NCC gate per group and per bay;
   - (e) straightened texture (`straighten.ts`): separable monotone warp of the photo's edges onto the lattice lines, kept when the edge-to-line distance falls 20 %;
   - (f) colour (`colour-transfer.ts`): Street View photos (the no-fit rung's views, ownership and occluder masks), per-wall per-channel gain, kept when it lowers CIEDE2000 by 10 % on both held-out halves;
   - (g) occluders (`occluders.ts`): tree crowns of the strip projected onto walls, uncovered texels and the vision model's open-vocabulary boxes; filled by averaged bays, then the same wall a bay pitch along or another facade at the same height (holes up to 30 m²), then Nano Banana Lite through `texture-inpaint.ts`'s lock (labelled `generated`), then the nearest texel.
6. **Trees**: the existing strip + SB-Veggie stages, unchanged; facade texels behind crowns get the occluder fill.
7. **Enhanced mode** (`pipeline-e/enhance.ts`; the default within pipeline E since round 4): the 8 largest walls redrawn once by Nano Banana Lite (`gemini-3.1-flash-lite-image`, since round 5; `gemini-3.1-flash-image` before) with `buildTexturePlatePrompt` (new; the AI Beautify template is unchanged; its keep-in-place sentences are the de-light study's `plain-detailed` ones), the adjacent finished wall as reference. Gate (round 5, section 7): corrective shift/scale, then the identity gate (framing, storey and bay counts, colour family, a gross-failure bound); the symmetric edge chamfer and the share of the tile's edges lost are reported per wall, not gated (round 3-4 rejected above 2.2 px or 15 %). Accepted texels are `generated`, "AI-enhanced from tile (model, texture-plate/v1)". The facade grammar is read again from the plates and used only where it passes its gates and the tile check. The build summary says enhanced mode was used and how many walls were enhanced or rejected.

## 2. Bake-off (round 3): E-minus-inference, E, E-enhanced

Same 5 places and 24 held-out views as round 2 (none used by these builds), in context (the tile with the target's isolate and the strip's removed trees cut out; every arm draws its SB-Veggie trees), `gemini-4-argon` blind, 3 reshuffled runs per view. Arms per the user: E-minus-inference (massing + ortho texture + trees), E, E-enhanced. Tiles came from the round-2 cache (same frames); origin/main 56cc5fd1 (footprint decoder fix) is merged in.

| Place (views) | E used? | E-minus | E | E-enhanced |
|---|---|---|---|---|
| Puck Building (5) | yes | 3.40 | 3.53 | **4.53** |
| Haughwout Building (5) | yes | **3.60** | **3.60** | **3.60** (0 of 2 walls passed the gate: same as E) |
| St. Mark's Church (4) | no: massing IoU 0.54 | 3.25 | 3.25 | 3.25 (current pipeline in all arms) |
| Washington Square Arch (6) | no: no vector footprint | 4.83 | 4.83 | 4.83 (one current-pipeline build for all arms) |
| Jefferson Market Library (4) | yes (modelled volume) | **3.83** | 3.42 | 3.75 |
| **All 24 views** | | 3.85 | 3.81 | **4.07** |

Per criterion, all views (shape / materials / detail / errors / overall): E-minus 4.72 / 4.28 / 3.56 / 3.40 / 3.85; E 4.57 / 4.22 / 3.51 / 3.26 / 3.81; E-enhanced 4.60 / 4.46 / 3.89 / 3.35 / 4.07. Fractional view wins: E-enhanced 10.8, E-minus 7.3, E 5.8. Judge spread: mean within-view sd 0.09; 81 % of cells identical across runs. Pixel numbers: SSIM 0.213 / 0.212 / 0.209, edge chamfer 8.01 / 8.07 / 7.98 px, CIEDE2000 19.9 / 19.9 / 19.7.

Round 2's A/D numbers are not comparable (different arms, trees now regrown in the arms and cut from the context).

**Build time** (warm tile, strip and tile_refine caches; tile download excluded): clean textured building (run start to the E layer) Puck 5.7-8.7 s, Haughwout 2.9-3.8 s, Jefferson 4.9-5.5 s; the first cold Puck build 11 s (tile_refine and the native tool built). Inference afterwards in the background: Puck 84 s, Haughwout 17 s, Jefferson 52 s; with enhanced mode 143 / 34 / 88 s. Fallbacks run the current pipeline: St. Mark's 36 s, the arch 164 s (warm caches).

**Inferred steps, accepted / proposed (E builds of the three places E applies to):** roof 11/17 (65 %), bands 4/49 (8 %), windows 2/9 (22 %), occluder regions filled with real or generated pixels 45/203 (22 %), averaged-bay groups 9/10 (90 %), straightened walls 2/2, Street View colour 1/27 (4 %); enhanced mode: walls 7/18 (39 %), plate grammars 1/2.

**Image model for enhanced mode** (Puck 3 walls, Haughwout 2): `gemini-3.1-flash-image` passed 4 of 5 (chamfer 1.54-1.94 px, 2-4 % edges lost); Nano Banana Lite passed 2 of 5 (1.80-4.35 px, 7-38 %) and invented storefronts and replaced a fire escape with windows (`test-results/screenshots/version_e/enhance/puck_model_comparison.png`).

## 3. What inference added, and what did not work

- **Inference alone added nothing measurable** (E 3.81 against E-minus 3.85; the errors score, 10 meaning none, 3.26 against 3.40). Most steps rarely pass their gates on these places (bands 8 %, colour 4 %, windows 22 %), and the occluder fill introduces visible artefacts (nearest-texel smears and bay-shifted stamps below the lattice), which the judge reads as errors on Jefferson (3.42 against 3.83).
- **Enhanced mode is the only clear gain**, all of it on Puck (+1.0 overall, materials 5.33 and detail 4.73 against 4.33 / 3.26), where 4 of 8 walls passed. The judge's errors score on Puck was slightly better for it (3.47 against 3.07-3.20, 10 meaning none), but invented content is real: on Puck wall 17 the plate draws fire-escape stairs the tile only smears and paints flat grey patches into two occluded bays, both within the edge gate (`enhance/e3e994c8_wall_17_tile_vs_enhanced.png`). Rejected walls (e.g. wall 23, `..._wall_23_...`) show what the gate stops.
- **Massing failure modes:** St. Mark's falls back (the modelled volume covers 998 cells against the scan pick's 579: the pick is partial, IoU 0.54); the arch has no usable vector footprint. Puck's roof error is 2.65 m median but 29 m at the 90th percentile (some massing cells stand where the scan's top is the street; not investigated further). Walls against neighbours have no photo and show as flat median slabs, visible in isolation and in some in-context views (Puck's west strip, Jefferson's garden walls behind trees).
- **Party walls and occluded walls** dominate what is left grey; colour transfer rarely passes because nominal Street View poses misalign pairs.

## 4. In the app (operate-scratchbox)

Instance from the `version-e` worktree, web 3471 / API 3472 / tools 3473, `SCRATCHBOX_STAGED_PIPELINE=e`. "Build the Puck Building, 295 Lafayette Street, New York in 3D (clay)": `Remeshed scan committed · inferred · 4.9 s` (the E layer), facade grammar slot (E inference) 1 min 45 s, finished 1 min 51 s; the reply names the vector massing, plan IoU 0.86 and the photo-inferred layer. Jefferson Market Library: finished in 1 min 2 s. "Show real textures" shows the textured twin ("Real textures on 1 of 2 layers"); clay and textured, front, back and oblique screenshots in `test-results/screenshots/version_e/app/`. Console after the build: no errors for the staged layers (the `ERR_CONNECTION_REFUSED` entries date from the server restart). The stage keeps the title "Remeshed scan" (pipeline E reuses the remesh and grammar stage slots): a candidate for a label of its own.

## 5. Candidate tool/service ideas
- A `staged_location_massing_preview` tool: the E massing, its check numbers and the native faces for a place, without a build (this session hand-rolled `dev_massing.ts`).
- Stage titles per pipeline (E's massing currently shows as "Remeshed scan").
- A held-out pose refinement for the Street View colour pairs (nominal poses make the colour step pass 1 in 27).

## 6. Round 4 (2026-10-19): identity check, Street View guidance, realism and identity scores

**What changed** (commits 8f62a85a .. on `version-e`):
- **Identity check** (`pipeline-e/plate-audit.ts`, `guardPlate` in `enhance.ts`), after the alignment gate. Per 0.5 m cell: the low-passed CIELAB distance after one global colour map (chroma in full, lightness ×0.6), the band-pass (0.08-0.8 m) contrast of input and plate and their NCC over 1.5 m, and how far the input stands from the wall's median colour (≥ 15) or how strong its structure is (≥ 9 L\*), reaching 1 m round each distinct cell. Unsupported structure over a distinct element is `replaced`, flattened distinct structure `erased`, a changed colour `retoned`; unsupported structure over ordinary wall is `invented-detail` and kept (realism-first: finer detail is the point). 8-connected regions ≥ 3 m² revert to the input, feathered over 0.5 m; > 35 % of the wall flagged rejects it. On the round-3 plates: the Lite redraw's painted-over fire-escape bay and arched ground floor (wall 17 then) revert; its stone base over smeared street clutter (wall 15 then) is kept unless a photo contradicts it (no distinct element in the tile there).
- **Street View guidance** (`pipeline-e/plate-streetview.ts`, `streetview-registered-views.ts`): enhanced mode runs the `streetview_survey` planning, refusal retry and edge+joint registration (moved out of the tool, re-exported) for 5 survey views plus a street-level view of each pano (aimed 4.5 m above the foot: the survey's wide views leave the lower storeys below the frame), cut out by the ownership and occluder masks. Per wall the registered view that best sees its street-level band (9 m; at least 10 %) is rectified onto the wall (pose, joint warp, depth test) and sent as a third image, resampled onto the plate's frame (`texture-plate/v1+street-view`; a perspective crop pulled the plates off the walls' geometry). A photo-guided redraw that fails the gate is redrawn once without the photo, which then only checks it. The check: after a ±1 m shift search, per cell over 2.5 m, where the input agrees with the photo clearly better than the plate (NCC +0.25 or colour +10) the plate contradicts it and reverts; where the photo supports the plate, tile flags are lifted. Provenance: "AI-enhanced from tile, guided by Street View <panoId>".
- **Judge** (`photo-match-eval.ts`): two more criteria, `realism` and `identity`, optional in the reply schema.
- **Consistency:** plates cached per wall (`enhance_plates/`, keyed by models, prompt and every image); walls redrawn in rounds, each referencing only earlier rounds.
- Grammar stage limit 420 s (enhanced mode's survey runs beside the readings).

**Bake-off (round 4)**: same 24 held-out views (none used by any build of this round), in context, `gemini-4-argon` blind ×3. Arms: E (real-data view), Eh0 (enhanced before: gate only), Eh1 (enhanced after). St. Mark's now takes pipeline E (plan IoU 0.73 after the picker fix). Full tables: `test-results/screenshots/version_e/enhance2/bakeoff_round4.md`.

| Arm (all 24 views) | shape | materials | detail | errors | overall | realism | identity |
|---|---|---|---|---|---|---|---|
| E | 4.57 | 4.08 | 3.47 | 3.29 | 3.82 | 3.21 | 4.85 |
| Eh0 | 4.58 | 4.32 | 3.81 | 3.29 | 4.00 | 3.44 | 5.03 |
| Eh1 | 4.58 | 4.32 | 3.81 | 3.29 | 4.00 | 3.44 | 5.03 |

Eh0 and Eh1 were scored identically on every view: the reverted regions (Puck's fire-escape bay, 26 m² replaced + 21.5 m² retoned, 96.5 m² reverted) are seen edge-on or not at all from the held-out poses, and the judge reads the scanned street-level residue as the dominant error. The change is measured on the walls instead (below). Enhanced (either) against the real-data view: realism +0.23, identity +0.18, errors unchanged; on Puck realism 3.00 → 4.07, identity 4.93 → 5.73.

**Walls (Eh1 builds):** Puck 3 of 8 enhanced (wall 19: 47.6 m² flagged, 96.5 m² reverted, 30.5 m² finer detail kept; wall 32: 17 m² flagged; wall 17: none); Jefferson 5 of 8 (3.1 m² flagged on wall 109); Haughwout 0 of 2; St. Mark's 0 of 2 (one model refusal, one gate failure). Street View: Puck 10 views all jointly registered and owned, 4 walls with a photo, every photo-guided redraw failed the gate and was redrawn without it, then checked (wall 19: 10 cells contradicted, 27 supported); Haughwout 10 registered, 7 owned (round 3: 0 owned at nominal poses), 2 walls with a photo; Jefferson 10 registered, 3 owned, 1 wall; St. Mark's no pose held (churchyard trees), no wall.

**Haughwout (0 walls before and after):** per band the plates miss the tile by 2.5-5 px with different best shifts per band (wall 3: +6 px at the top, -5 px in the body): the model re-lays the storeys at a slightly different pitch, replaces the scan's roof junk at the top with sky (40 % of edges lost there), and the tile's cast-iron arcade is melted and doubled, so even a faithful redraw cannot land within 2.2 px of its edges. A per-band corrective warp would be the fix; not done.

**Build time** (warm tile and strip caches, model answers replayed where recorded, plates cached on rebuilds): Puck E 91 s, Eh0 184 s, Eh1 279-316 s (survey 86 s beside the readings, redraws 185 s); Jefferson 84 / 110 / 141 s; Haughwout 20 / 39 / 175 s; St. Mark's 53 / 18 / 56 s.

## 7. Round 5 (2026-10-19): Nano Banana Lite, the identity gate, openings that follow the plate

The user chose the round-4 "After Lite Rejected" plates (Puck wall 17 at chamfer 4.4 px / 35 % of the tile's edges lost; Jefferson wall 157, red brick with white stone arches, at 3.5 px / 17 %) as the most realistic. Commits f12ff53a, 6a0954ec on `version-e`.

**What changed**
- **Model:** `ENHANCE_MODEL_DEFAULT` is `gemini-3.1-flash-lite-image` (`SCRATCHBOX_STAGED_ENHANCE_MODELS` still overrides).
- **Identity gate** (`pipeline-e/plate-identity.ts`) in place of the 2.2 px / 15 % edge gate. A plate is accepted when (a) the answer's aspect is within 3 % of the one asked for; (b) the vision model, shown the tile and the plate together with the same definitions (`countPrompt`), reads storey and bay counts that agree within 15 % of the tile's (at least one; a count of 0 on the tile, or a reply that cannot be read, is "not counted" and says so); (c) the median CIELAB colour stays in the tile's family (lightness weighted 0.3, at most 22; the CIEDE2000 distance is reported); (d) a gross-failure bound holds: chamfer at most 6 px and lost share at most 60 %. Then the region audit (`plate-audit.ts`) as before, now tolerant of 0.5 m of drift (a structure match found off its place counts 0.25 less in NCC). Chamfer and lost are reported per wall in the build notes, `inference.json` and the layer's texel provenance (`chamferPx`, `lostShare` on the wall's own `generated` entry).
- **Choosing the bounds.** Counted apart, the soft tile and the crisp plate were read with different definitions (Puck wall 17: 3 bays on the tile, the ground floor's arches; 9 on the plate), so the counts are read in one look. On the Eh2 plates of Puck: every same-wall plate within tolerance, 4 of 56 cross-wall pairs (another wall's plate resized to this one) within it; on Jefferson's small walls (1-3 storeys and bays) 27 of 56 cross pairs pass the counts, so there the colour family and the region audit carry the identity. Chamfer does not separate a wrong wall (cross-wall pairs 4.2-5.2 px against same-wall plates 0.8-5.1 px): it only catches garbage (a flat or blank answer scores 8 px). Colour family: same-wall plates 0.5-19.5 (Jefferson wall 85, its washed pink tile redrawn as darker brick); Puck wall 35, a near-black tile redrawn as a different building with a "PUCK" sign, 25.7.
- **Openings follow the plate** (`pipeline-e/plate-lattice.ts`, inference step `enhance-lattice`). On a wall whose openings were carved from the tile's facade grammar, the lattice is read again from the accepted plate: each tier's top and bottom and each opening's sides move (at most 0.6 m) to where the plate's edges are, only where the mean edge distance falls by 15 % and at least 1 px; counts and order are kept and the massing is untouched; the solid is rebuilt (`native3`). Diagnostic `wall_<n>_lattice_refit.png` (red the tile's openings, green the plate's). Walls without a tile grammar take the plate's own grammar (round 4's `enhance-grammar`), which already follows the plate.
- **Two bugs fixed on the way** (they affected every arm): a wall the rebuilt solid split in pieces (`<key>:0`, `<key>:1`, where a raised roof block's corner projects onto it) took the plain tile ortho instead of its inferred or enhanced texture (`parentFace`), and the native massing dropped that wall's openings silently (Haughwout wall 3 lost all 43; now the piece under each opening's centre takes it, in its own frame, and an opening with no wall is reported).

**Street View guidance under the new gate** (walls the user named; plate per wall in `test-results/screenshots/version_e/enhance3/<place>_wall_sheet.png`):

| Wall | Round 4 (Eh1) | Round 5 (Eh2): used |
|---|---|---|
| Puck 17 | full model, plain (photo redraw failed 2.2 px) | **photo-guided** (chamfer 3.52, lost 0.20; 117 cells supported by the photo, 24 contradicting it) |
| Puck 19 (fire escape) | full model, plain | **photo-guided** (2.70 / 0.14; 47 supported, 41 contradicted, 297 m² reverted) |
| Puck 32 | full model, plain | plain Lite: no registered photo shows 10 % of its street band (0.96 / 0.01) |
| Haughwout 2 | rejected | **photo-guided** (3.07 / 0.12; 100 supported, 12 contradicted) |
| Haughwout 3 | rejected | **photo-guided** (4.33 / 0.33; 65 supported, 1 contradicted) |
| Jefferson 236 | full model, plain | **photo-guided** (1.51 / 0.06; 19 supported, none contradicted) |
| Jefferson 157 | full model, plain | kept the tile: no photo; the Lite plate (a different Gothic front) failed the region audit (73 % erased) |
| Jefferson 85 | full model, plain | kept the tile: no photo; the Lite plate failed the region audit (72 % replaced) |

Puck walls 24 and 25 also took their photo-guided plates (wall 24 carries the real flag and street-level arcade).

**Walls enhanced, before → after:** Puck 3 → 6 of 8 (35: another building on a near-black tile, colour and gross bound; 36: bays 3 / 10), Haughwout 0 → 2 of 2, Jefferson 5 → 4 of 8 (109, 157, 85, 153 failed the region audit: the Lite plates there invent a different front over a tile the scan barely sees), St. Mark's 0 → 2 of 2 (its tile counts read 0: not counted). Haughwout's walls 2 and 3 also had their openings moved onto the plate (79 of 140 and 46 of 96 lattice lines, mean 0.25-0.27 m; openings' borders 2.68 → 1.75 px and 3.31 → 1.99 px from the plate's nearest edge); Puck wall 24 took 48 openings from the plate's own grammar.

**Bake-off (round 5)**: same 24 held-out views, in context, `gemini-4-argon` blind ×3. Arms: E (real data, this code, so with the two fixes), Eh1 (round 4's enhanced GLBs, as built then), Eh2 (this). Full tables: `test-results/screenshots/version_e/enhance3/bakeoff_round5.md`; grids in `test-results/screenshots/version_e/bakeoff5/`.

| Arm (all 24 views) | shape | materials | detail | errors | overall | realism | identity | view wins |
|---|---|---|---|---|---|---|---|---|
| E | 4.47 | 4.07 | 3.37 | 3.31 | 3.72 | 3.21 | 4.58 | 5.0 |
| Eh1 | 4.50 | 4.39 | 3.74 | 3.35 | 4.01 | 3.44 | 4.86 | 6.0 |
| Eh2 | **4.76** | **4.74** | **4.26** | **3.65** | **4.39** | **3.82** | **5.17** | **13.0** |

Per place (overall / realism / identity): Puck E 3.27 / 3.00 / 4.40, Eh1 4.20 / 4.00 / 5.33, Eh2 **4.93 / 4.13 / 5.87**; Haughwout E 3.40 / 3.00 / 3.93, Eh1 3.87 / 3.13 / 4.33, Eh2 **4.93 / 4.80 / 5.27**; St. Mark's, the arch and Jefferson equal across arms (St. Mark's two small enhanced walls and Jefferson's four are not what the held-out views show; the arch runs the current pipeline in every arm). Judge spread: mean within-view sd 0.09, 82 % of cells identical across the three runs. Eh2 raised realism (+0.38 over Eh1) without lowering identity (+0.31), the directive's acceptance rule.

**Build time** (warm tile, strip and tile_refine caches, vision replies replayed where recorded): first Eh2 build with live Lite redraws and counts Puck 329 s, Jefferson 213 s, Haughwout 188 s, St. Mark's 91 s; rebuilt with the plates cached Puck 265 s (survey 90 s beside the readings, redraws and counts 162 s), Jefferson 149 s, Haughwout 180 s (survey 122 s), St. Mark's 69 s; E (real data) 91 / 74 / 21 / 15 s. The grammar stage limit stays 420 s.

**Not solved:** Lite invents over walls the scan barely sees (Jefferson 104: lettering read nowhere; its counts on the tile were 0, so not counted); a photo-guided plate carries the photo's sun and shade (Puck 24); a reverted region shows the tile's smear next to crisp plate (Puck 24, the region audit's feathered revert). Plates are drawn once per wall input and cached; a change upstream (e.g. which neighbour is the reference) draws a new plate.

## 8. Reproduction
Headless: `SCRATCHBOX_STAGED_PIPELINE=e [SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE=0 | SCRATCHBOX_STAGED_ENHANCE=1] node -r ts-node/register -r ./scripts/dev/staged-replay.ts <build.ts> "<query>"` (the tool entry with `isolate: true`); run notes `pipeline_e.json` and `pipeline_e_inference.json` in `.scratchbox/cache/staged_location/runs/<runId>/`. Evaluation: `scripts/dev/photo-match-eval.ts <manifest>` with `context.cut` listing the isolate and the strip's `removed_trees.glb`. Tests: `packages/core/test/staged-pipeline-e.test.ts` (12 synthetic tests), `staged-pipeline-e-guards.test.ts` (14), `staged-pipeline-e-identity.test.ts` (8: the identity gate, the drift-tolerant audit, the lattice refit, split walls); screenshots in `test-results/screenshots/version_e/`.

## 9. Round 6 (2026-10-19): merge readiness, the clay arm, combined bake-off

**Merges.** `origin/version-e-relief` (measured relief, generated profiles) and `origin/main` twice (tree crown shading, lobed crowns and the near-mid level, UV unwrap/rewrap, tool honesty, `streetview_survey` temporary check on by default; then tree LOD by screen space, crown breakup, the tree texture library, the camera settings panel, viewport lens distortion and depth of field). Conflicts only in the native massing (round 5's split-wall opening placement kept; it reports an opening with no wall as relief did), the inference (lattice refit kept, the plates' openings also handed to the relief stage) and the stage limits (grammar 420 s, relief 480 s).

**Fixes on the way.** The real-data view (enhanced mode off) no longer adds generated relief profiles. The inference note no longer calls enhanced mode "opt-in" (it is the default within E). The relief test's profile plot hung its worker on a row with a sentinel standard error (after every assertion passed); it now skips such rows. `readTileTriangles` takes an untextured triangle's colour as base colour times COLOR_0.

**Clay arm** (`photo-match-eval.ts` `renderTriangles({ clay })`, `judgeViewClay`; `photo_match_evaluate` `clay`, default true; dev driver manifest `"clay": true`). Every arm is rendered again from the held-out pose in one clay (its street in a lighter clay, a key light raised behind the camera so a band's soffit reads darker than the wall) and judged blind for `shape` only. Textured judging is unchanged.

**Bake-off (round 6).** Round 5's held-out views, minus Puck's `9bNcQu` (the Eh build's Street View guidance fetched it this round): 23 views, in context, `gemini-4-argon` blind x3, textured and clay. Arms: A raw tile (cut to the target), D main's default pipeline, E pipeline E real-data view (`SCRATCHBOX_STAGED_ENHANCE=0`), Eh pipeline E default (enhanced Lite + relief). The regrown SB-Veggie trees are left out of every built arm and the scanned trees stay in the street for all arms: the trees GLB holds every LOD level and instanced leaves that the viewer resolves at run time, and drawn whole it put grey hulls in front of the facades (`bakeoff6_run2_trees_lods/`; the in-app tool already leaves the trees stage out). Grids: `test-results/screenshots/version_e/bakeoff6/` (`*_clay.png` for the clay arm).

| Arm (23 views) | shape | materials | detail | errors | overall | realism | identity | clay shape |
|---|---|---|---|---|---|---|---|---|
| A raw tile | 4.62 | 4.39 | 3.62 | 3.86 | 4.12 | 3.38 | 4.80 | 3.36 |
| D main default | 4.38 | 4.26 | 3.86 | 3.51 | 3.90 | 3.46 | 4.91 | 3.87 |
| E real data | 4.46 | 4.17 | 3.77 | 3.58 | 4.06 | 3.43 | 4.84 | 4.80 |
| Eh enhanced + relief | **4.81** | **4.75** | **4.59** | **3.88** | **4.61** | **3.97** | **5.36** | **4.94** |

Per place (overall / realism / identity / clay shape): Puck A 4.25/3.50/5.25/2.00, D 3.00/3.00/4.25/3.17, E 4.00/3.17/5.25/1.33, Eh **5.33/4.50/6.42**/1.83; Haughwout A 3.33/3.07/3.93/3.53, D 3.00/3.00/3.67/3.40, E 3.93/3.60/4.27/5.60, Eh **5.40/5.07/5.73/5.87**; St. Mark's A **4.17/3.58/5.00**/3.58, D 3.50/3.17/4.67/3.25, E and Eh 2.75/2.50/3.67/**5.75**; the arch (E falls back to D in both E arms) A 3.83/3.00/4.28/4.22, D=E=Eh **5.17/4.22/5.94/4.95**; Jefferson A **5.33/4.00/6.00**/3.00, D 4.42/3.67/5.83/4.17, E and Eh 3.92/3.25/4.67/**6.08**. Judge spread: within-view sd 0.22 textured, 0.35 clay.

- Eh is the best arm overall on every textured criterion and on clay shape; against D it raises realism +0.51 and identity +0.45.
- The clay arm separates what texture hides: E's geometry beats D's in clay at Haughwout, St. Mark's and Jefferson (+2.2, +2.5, +1.9), while Puck's E massing, with no window grammar accepted, scores lowest in clay (1.33).
- Not won: at St. Mark's and Jefferson the raw tile still scores best textured (E's texture on the clean massing reads worse than the scan's own); St. Mark's enhanced redraws do not show from the held-out poses (Eh = E there).

**Build time** (warm tile caches, replayed vision answers where recorded; live calls for what changed): Puck D 225 / E 146 / Eh 312 s, Haughwout 147 / 60 / 232 s, St. Mark's 142 / 71 / 91 s, the arch 170 / 174 / 174 s, Jefferson 175 / 130 / 144 s. Largest stages: grammar 244 s (Puck Eh; limit 420 s), relief 76 s (Haughwout Eh; limit 480 s). First visual 0.6-1.5 s everywhere.

**Fallbacks.** Only the arch: "the structure's footprint did not come from Google vector data (the vector footprint (111 m²) and the scan disagree: only 0% of it stands 3 m or more above the terrain in the scan)": the arch builds through the current pipeline and says so in the `remesh` degradation; relief is skipped there with its reason.

**In the app.** A place no bake-off used, Grace Church (802 Broadway), live in the chat with `SCRATCHBOX_STAGED_PIPELINE=e`: [staged_location_pipeline_e_grace_church_live.md](./staged_location_pipeline_e_grace_church_live.md).

## 10. Round 7 (2026-10-19): why E's texture lost at St. Mark's and Jefferson, and Puck's flat walls

Branch `version-e-fixes` (from main 1deb842f; origin/main 04a13e98, the evaluator's per-view tree LOD, merged before scoring). Diagnostics and builds: `test-results/screenshots/version_e_fixes/`.

### Causes found (evidence)

The judges' round-6 notes for E and Eh at St. Mark's and Jefferson say the same thing in every run: "untextured blocky portico and steeple", "clock tower replaced by an untextured block", "roof gaps", "missing facade sections". Per wall, from the native report and the build notes:

1. **Modelled volumes had walls turned inwards** (`massing-spec.ts` `singleSided`). Google's volumes carry every triangle twice; the copy kept was the one facing away from the whole volume's centre. On a non-convex volume that turns the walls of a corner tower or an offset steeple that face the centre inwards: Jefferson's clock-tower walls 93 and 94 had coverage 0.002 and 0.006 while their opposite walls had 0.81; St. Mark's steeple walls 18 and 50 had 0; 80 of St. Mark's 392 and 101-140 of Jefferson's 559 triangles were inward, and St. Mark's roofs read as 250 m² of soffits. An inward wall's ortho looks from inside, sees nothing, and the wall takes one flat colour: the "untextured clock tower" and "untextured steeple". The renderer draws both sides, so the flat inside showed; a back-face-culling viewer (the app) shows a hole instead ("roof gaps", "missing facade sections"). Signed volume with the old orientation: Jefferson 31,520 m³ for a 679 m² plan (impossible), now 25,680 (overlapping shells counted twice).
2. **The vegetation strip's untextured caps were baked as photo** (`scratchbox_staged_massing.hpp` `rasterFace`). Pipeline E textures from the devegetated tile, whose `vegetation_removed_cap` and `_skirt` (walls continued down where trees stood) are flat clay (0.55, 0.57, 0.60). The ortho bake counted them as covered tile photo: 21% of St. Mark's long wall 70 was that flat blue-grey, labelled `as-scanned` (a provenance error as well). These are the blue-grey slabs in the round-6 grids.
3. **Walls of a modelled volume a few metres off the scanned facade.** A modelled volume is moved as a whole, so single walls can stand off the facade the scan measures (St. Mark's wing 3.3 m, others 1-3.6 m). The ±1.5/0.8 m slab about the plane saw nothing; the wall took one flat colour although the tile has its photo (round-6 grid `stmarks_v3`: A shows the arched windows that E draws flat).
4. **Enhancement never reached the walls the views see** (why Eh equalled E). Enhanced mode skipped every wall under 35% tile coverage. At St. Mark's that is every wall the held-out views see (behind the churchyard trees: walls 70, 102, 153, 167); the two walls it redrew (102, 165 in round 6) face away from all four views. At Jefferson the tower walls were not candidates (cause 1).
5. **Openings on a modelled volume were never cut** (`attachOpening` accepted only extruded walls). Jefferson's tile grammar was accepted on walls 152 and 259 (19 openings each) and all 38 were dropped as "did not fit inside their wall"; the clay judge's note "lacks window openings" on every Jefferson and St. Mark's view.
6. **Not a pipeline-E cause, reported only** (from the evaluator-trees agent, checked here): at St. Mark's the strip removed the scanned trees in front of the church (19 k triangles) but regrew only two trees, both behind it, so the photo's foreground canopy is missing in every built arm (D, E, Eh) while the raw-tile arm A keeps the canopy that lay inside the isolate. Planting is outside pipeline E; not changed.

Also found and fixed: the plates' own grammar openings (round 5's `enhance-grammar`, Puck wall 24) were labelled `photo-inferred`; they come from a generated plate and are `generated` now.

### Fixes (commits on `version-e-fixes`)

- `08807012` Each triangle of a modelled volume faces the side more rays escape from (`orientOutward`: 7 points per triangle, 32 directions, a triangle buried on both sides left as given); the colour pass skips triangles with no photo, so the strip's caps leave texels uncovered (filled downstream, labelled `filled`).
- `f3df8845` A wall under 35% covered is baked again through the same slab centred on the projected-area mode of the photo surfaces facing it within ±4 m (`reslabBelow`, `reslabReach`), when that covers 5% more; the offset is reported per face (`textureOffsetM`) and in the `tile-ortho` legend entry. Jefferson's walls under 35% coverage fall from 5,647 to 3,527 m² (most of the rest are partitions inside the volume).
- `020f33dc` **Unseen walls** (enhanced mode only): up to 4 walls under 35% covered that face open air (`exposure.ts`: a voxel ray test against the solid; partitions inside a modelled volume are left out and counted in the notes) are drawn with `texture-plate/v1+unseen` (uncovered texels sent mid-grey, "parts of this same wall the scan could not see ... fill them as this wall continues ... nothing that no image shows"), the finished adjacent wall as reference. Gate: aspect; the gross alignment bound only when at least 10% is covered (else "alignment not measured", said); counts only when 25% is covered; colour family against the building's median facade colour when under 5% is covered (said); the region audit on the covered texels; refused when more than 10% of the unseen part inside the wall's polygon is left mid-grey (`ff81b554`). Unseen texels are labelled `generated`, "drawn by an image model where the tile has no photo of the wall".
- `020f33dc` **Openings from the plate's lattice** (Task 2): an accepted plate on an extruded wall without openings from any grammar that passed is read once by the vision model (or the plates' grammar pass reading is reused), its lines fitted to the plate's edges (`refitLatticeToPlate`), and each opening kept only where its border lies within 2.5 px of the plate's edges and its inside differs from the wall round it by 10 luma; the wall is cut when at least 2 openings and half of those read are kept (`plateLatticeOpenings`). Openings are `generated` ("cut where an AI-enhanced wall plate shows it ... no window grammar of the scan placed it"); recess at the depth the scan's ortho measures, else 0.12 m (counted in the note). Walls drawn unseen are not cut ("nothing real places their openings"). The real-data view (`enhance: false`) has none of this.
- `503717eb` A vertical facet of a modelled volume takes openings: the facet's triangles are clipped round each rectangle (convex half-plane pieces, fanned) and the recess built as on a wall; the notes now say when openings lie on facets.

Tests: `packages/core/test/staged-pipeline-e-fixes.test.ts` (10, synthetic, no model calls): a corner tower's walls face out (8 of 8 free tower walls), the cap left uncovered (alpha 0 behind it, coverage 0.35-0.6), a wall 3 m off the scan re-baked (coverage > 0.85, offset 2.7-3.3 m; 0 with `reslabReach: 0`), outside wall exposed 1 / partition 0, 24 of 24 plate openings kept within one pixel and none on a plain wall, a `generated` opening node never measured, an unseen wall drawn with its unseen texels labelled and the plain prompt unchanged, a grey answer refused (and the polygon mask honoured), the colour family against the building, a facet window cut (facet area 108 → 105 m², recess 30 indices, a misfit rejected).

### Rebuilt and re-scored

St. Mark's, Jefferson and Puck rebuilt from this branch with real calls (E: `SCRATCHBOX_STAGED_ENHANCE=0`; Eh: the default), warm tile caches copied from round 6, new vision and image answers recorded. Build times: St. Mark's E 25 s / Eh 82 s, Jefferson 99 / 188 s, Puck 108 / 281 s. No build of this round fetched a held-out pano (checked against the replay recordings; all 12 views kept).

Scoring: round 6's held-out views exactly (4 per place, `gemini-4-argon` blind x3, textured and clay). The evaluator now draws regrown trees (main 04a13e98), so every built arm carries its trees GLB and the context is cut by the isolate and the strip's removed trees; round 6's numbers had no regrown trees, so all arms were judged again together rather than reusing round 6's A and D: A raw tile, D main default (round-6 build), E6 and Eh6 (round-6 builds), E7 and Eh7 (this branch). Six arms per judgement instead of four, so absolute numbers are not comparable with §9; the arms within this table are. Table: `test-results/screenshots/version_e_fixes/bakeoff7/bakeoff_round7.md`; grids (`*.png`) and clay grids (`*_clay.png`) in the same folder.

| Place (overall / realism / identity / clay shape) | A raw | D | E6 | Eh6 | E7 | Eh7 |
|---|---|---|---|---|---|---|
| St. Mark's | **5.25** / 4.42 / 6.25 / 3.42 | 4.33 / 3.67 / 5.42 / 2.17 | 3.33 / 3.00 / 4.33 / 6.42 | 3.33 / 3.00 / 4.50 / 6.42 | 4.08 / 3.58 / 5.25 / **6.92** | 4.83 / 4.17 / 5.67 / **6.92** |
| Jefferson | **5.42** / 3.75 / 6.67 / 2.50 | 4.33 / 3.25 / 5.75 / 2.75 | 3.33 / 2.58 / 4.42 / **6.17** | 3.33 / 2.58 / 4.50 / **6.17** | 4.17 / 2.83 / 5.25 / 5.83 | 4.17 / 2.83 / 5.25 / 5.83 |
| Puck | 4.08 / 3.25 / 4.92 / 3.17 | 3.00 / 3.00 / 3.92 / 4.25 | 3.92 / 3.17 / 4.83 / 3.00 | **5.25** / 4.67 / 6.25 / 3.25 | 3.92 / 3.17 / 4.83 / 3.00 | **5.25** / **4.75** / 6.17 / **4.33** |
| All 12 views | 4.92 / 3.81 / 5.94 / 3.03 | 3.89 / 3.31 / 5.03 / 3.06 | 3.53 / 2.92 / 4.53 / 5.19 | 3.97 / 3.42 / 5.08 / 5.28 | 4.06 / 3.19 / 5.11 / 5.25 | 4.75 / **3.92** / 5.70 / **5.69** |

Judge spread: within-view sd 0.23 textured, 0.34 clay. View wins (overall): A 5.3, Eh7 3.8, Eh6 2.0, E7 0.8.

- **St. Mark's**: Eh +1.50 (3.33 → 4.83) and E +0.75; both now above D, Eh 0.42 under the raw tile. The steeple and the long walls carry the tile photo (causes 1-3), and the walls behind the churchyard trees are drawn (102, 153, 167). Judges still name "the side wall is an untextured plane": wall 70's drawing was refused (it left 28% of the wall mid-grey, drawing a narrower front), and the bands and portico strips are plain.
- **Jefferson**: E and Eh +0.84 (3.33 → 4.17), still under D (4.33) and A. The tower is textured now, and 27-28 tile-grammar openings are cut into the facets (none before). Eh equals E again: the two walls enhanced (152, 259) face away from the views, and three of the four unseen walls were refused by the region audit on their few covered texels. Judges still read "flat pink lower walls" and "solid fill on the main tower" where the views look at walls the tile does not see. Clay 6.17 → 5.83 is within the clay spread (0.34).
- **Puck** (Task 2): Eh's clay shape 3.25 → 4.33, now the best clay arm there; textured unchanged (5.25). 48 openings were cut from the plates' own lattices on walls 17, 20 and 25 (24, 15 and 9; wall 19 kept only 28 of 69 read and wall 32 20 of 42, under half, and stay flat), all labelled `generated`; with wall 24's 48 plate-grammar openings (relabelled `generated`) the Eh layer has 96 `generated` opening nodes (round 6: 48, labelled `photo-inferred`).

### Not fixed
- St. Mark's foreground canopy (cause 6): planting, outside pipeline E.
- Jefferson's walls behind trees: the unseen-wall gate refuses three of four (region audit on few covered texels); the views mostly see those walls.
- A redraw that leaves part of an unseen wall grey is refused, not retried (St. Mark's wall 70).
- Bands and generated relief sweeps carry the plain face texture, read as "untextured bands".
- Openings on facets get no averaged reveal from the relief stage (`window reveals 0 of 0`); they keep the ortho-measured or 0.12 m recess.
- The five-place bake-off is not run here (Haughwout and the arch not rebuilt).
