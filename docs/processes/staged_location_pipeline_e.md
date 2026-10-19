# Staged Location Builds: Pipeline E (clean vector massing, ortho textures, verified inference, opt-in enhanced mode)

> **Recorded:** 2026-10-19
> **Status:** Verified behind a flag (`SCRATCHBOX_STAGED_PIPELINE=e`, off by default). Within pipeline E enhanced appearance is the default since round 4 (realism-first directive); the real-data view is `enhance: false` or `SCRATCHBOX_STAGED_ENHANCE=0`. Not on main: for the user's review.
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
7. **Enhanced mode** (opt-in, `pipeline-e/enhance.ts`): the 8 largest walls redrawn once by `gemini-3.1-flash-image` with `buildTexturePlatePrompt` (new; the AI Beautify template is unchanged; its keep-in-place sentences are the de-light study's `plain-detailed` ones), the adjacent finished wall as reference. Gate: corrective shift/scale, then rejected when the symmetric edge chamfer exceeds 2.2 px or more than 15 % of the tile's edges have no edge within 0.3 m. Accepted texels are `generated`, "AI-enhanced from tile (model, texture-plate/v1)". The facade grammar is read again from the plates and used only where it passes its gates and the tile check. The build summary says enhanced mode was used and how many walls were enhanced or rejected.

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

## 7. Reproduction
Headless: `SCRATCHBOX_STAGED_PIPELINE=e [SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE=0 | SCRATCHBOX_STAGED_ENHANCE=1] node -r ts-node/register -r ./scripts/dev/staged-replay.ts <build.ts> "<query>"` (the tool entry with `isolate: true`); run notes `pipeline_e.json` and `pipeline_e_inference.json` in `.scratchbox/cache/staged_location/runs/<runId>/`. Evaluation: `scripts/dev/photo-match-eval.ts <manifest>` with `context.cut` listing the isolate and the strip's `removed_trees.glb`. Tests: `packages/core/test/staged-pipeline-e.test.ts` (12 synthetic tests; screenshots in `test-results/screenshots/version_e/`).
