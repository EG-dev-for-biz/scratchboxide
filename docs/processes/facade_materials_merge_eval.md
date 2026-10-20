# Process: Facade materials merged onto main, extended to pipeline E, judged with a specular renderer

> **Recorded:** 2026-10-19
> **Status:** Verified (merged and tested; materials stay **off** by default: no measured gain, small losses on the D texture pass)
> **Tags:** `operate-scratchbox` `staged-build` `texture-pass` `pipeline-e` `photo-match` `provenance` `pbr`
> **Target Domain:** Real-world 3D locations (textured twins)

---

## 1. Session Context

* **What prompted this session:** "textured by default" was approved for 3D, including real PBR on location buildings. The `facade-materials` branch (glass weight, roughness, metalness and masonry coursing in the texture pass, behind `SCRATCHBOX_FACADE_MATERIALS=1`) was three commits ahead of an older main. Task: merge it, extend the same material evidence to pipeline E's textured twin, judge it honestly and turn it on only if it does not lower realism or identity.
* **Branch:** `facade-materials-merge` (worktree `.claude/worktrees/facade-materials-merge`), from `origin/main` 4eed22be.
* **Instance used:** web `3742`, API `3741`, tools `3743`, started from the worktree with `node desktop-app/scripts/dev.js` and `SCRATCHBOX_NO_ELECTRON`, `SCRATCHBOX_FACADE_MATERIALS=1`, `SCRATCHBOX_STAGED_PIPELINE=e`. Headless builds through `scripts/dev/staged-replay.ts` (recordings: the round-7 `vF`, `vE` and the facade-materials session's `fm` recordings, hard-linked into one directory).

## 2. What Was Done

* **Merge** (1cb5d1b4). Six conflicts against main. The texture pass keeps main's lighting gate, inpainting and outcome fields, and runs the material reading after inpainting with one shared depth render. The orchestrator keeps the lighting correction, ownership and temporary keys and adds the material evidence and its cache key. The viewport keeps merged staged parts (`mergeStagedParts`) and adds the glass reflection probe. The facade materials' collected material instances survive the merge, so the probe and the environment gate still apply to merged meshes (checked live). The segmenter pool now uses the repo Python resolver's options signature (`resolveRepoPython({ modules, purpose })`, the same pool key as `ObjectSegmenterService`).
* **Pipeline E material channels** (a11e8c15, `pipeline-e/massing-materials.ts`, written by `massing-glb.ts`). The evidence E holds is its cut openings. Each opening node is a recessed pane (triangles along the face normal) inside four reveals. A pane is glass (roughness 0.05, dielectric) only where its median luminance is at most 0.85 of its wall's. Otherwise it is rejected and reported. Every other texel keeps the masonry 0.85, labelled `assumed`. Glass carries its opening's own label (`photo-inferred` or `generated`) in `extras.sbMaterial.materialSources`, and the params A channel indexes it. A page holding glass gets a glTF `metallicRoughnessTexture` and the viewer's params texture (R glass weight). The other pages are unchanged byte for byte. `PIPELINE_E_VERSION` follows the flag.
* **No normal map.** E's measured relief is already geometry (`facesweep:relief`, sweeps, reveals). A normal map from the same averages would draw it twice.
* **Evaluator specular term** (6dfb174d). The photo-match software renderer did not shade roughness or metalness, so the judge could not see the change. `renderTriangles({ specular })` now adds a fixed street-canyon environment on top of the unchanged neutral light. The environment is a dark street below the horizon, far facades up to about 14°, then a sky gradient. The term uses Schlick Fresnel (F0 0.04, or the albedo for metal) and blurs by roughness². Roughness and metalness are read per texel from each arm's glTF (`readTileTriangles(glb, { pbr: true })`). It is enabled with `"specular": true` in the manifest and is off by default, so earlier scores stay comparable.

## 3. Evaluation (Same Held-Out Views, Specular On, 3 Blind Repeats)

Places: St. Mark's Church (4 views), Puck Building (4), Haughwout Building (4; one view dropped because a build fetched its pano). Arms:

* `A` raw tile
* `D` texture pass / `Dm` texture pass with the reading (separate builds)
* `E0` / `Ehm` pipeline E enhanced with the material channels and the **same GLB with them stripped**. The independent E builds differed by a relief-gate judge call, so they were not a clean pair.

| Mean over views | overall | realism | identity | materials |
|---|---|---|---|---|
| D -> Dm, St. Mark's | 3.75 -> 3.75 | 3.08 -> 3.08 | 5.33 -> 5.33 | 4.33 -> 4.33 |
| D -> Dm, Puck | 3.17 -> **3.00** | 3.00 -> 3.00 | 4.25 -> 4.25 | 3.58 -> **3.42** |
| D -> Dm, Haughwout | 3.17 -> **3.08** | 3.00 -> 3.00 | 3.83 -> **3.67** | 3.83 -> **3.67** |
| E0 -> Ehm, St. Mark's | 4.00 -> 4.00 | 3.58 -> 3.58 | 5.25 -> 5.25 | 4.17 -> 4.17 |
| E0 -> Ehm, Puck | 5.17 -> 5.17 | 4.58 -> 4.58 | 6.25 -> 6.25 | 5.67 -> 5.67 |
| E0 -> Ehm, Haughwout | 5.58 -> **5.42** | 5.25 -> **5.17** | 6.17 -> 6.17 | 5.83 -> 5.83 |
| **All 12 views, D -> Dm** | 3.36 -> 3.28 | 3.03 -> 3.03 | 4.47 -> **4.42** | 3.92 -> 3.81 |
| **All 12 views, E0 -> Ehm** | 4.92 -> 4.86 | 4.47 -> **4.45** | 5.89 -> 5.89 | 5.22 -> 5.22 |

What the reading found:

* **St. Mark's:** 0 of 30 glass regions accepted (D). E has no openings there, because the modelled-volume facets are not cut. Both pairs are identical, and the judge scored them identically (a useful noise check).
* **Puck:** D accepted about 1% of texels as glass (286 of 629 regions on l2g, all decided by the tile). Ehm: 44 of 91 panes.
* **Haughwout:** D accepted 0.8% (19 of 38 regions). Ehm: 97 of 103 panes (144 k texels).

**Decision: off.** No view scored higher with materials. Identity dropped for D on Haughwout, and realism dropped for E on Haughwout (one view, -0.67 overall). The differences are small and within one judge step, but they all point the same way. The grids show why:

* **D:** the glass is the "measured interior" (the darkest photo texels) drawn over stair-stepped tile-resolution masks. These read as dark holes, worse than the photo (`eval/haughwout_v0_AHxVmF.png`).
* **E:** the panes brighten slightly with the reflection, while the photo windows are dark, shaded and full of storefront detail.

The flag `SCRATCHBOX_FACADE_MATERIALS=1` remains the switch to turn materials on.

## 4. Live App (Street Level)

* **Build:** "Build the Haughwout Building, 488 Broadway, New York as a 3D location" (live calls, 318 s), then Show real textures.
* **Viewport state:** read from `__SB_3D_SCENE__`. Both merged meshes (`sb-merged-parts-0/1`) carry `MassingPage0` with `sbFacadeMaterial`, a `roughnessMap`, `envMap` set by the probe, and 76 of 105 panes accepted.
* **Captures:** 1280x720 frames from a 1.7 m eye height, with materials on and with the material channels removed in place.
* **Difference:** 61.9 k pixels change, all on the Broadway openings, with a mean luminance change of +35. The reflection is of the studio backdrop, because only the hero was in the scene.
* **Health:** no console errors apart from one `500` on a session save PUT. It was followed by 200s and is unrelated to this change.

Screenshots: `test-results/screenshots/facade_materials_merge/`

* `haughwout_street_off_vs_on.png`
* `haughwout_street_materials_{on,off,diff}.png`
* `pipeline_e_materials_specular_eval.png`
* `eval/*.png` (every held-out grid)

## 5. Tests and Checks

* `npm run typecheck` exit 0.
* `npm run lint:primitives` passed.
* eslint on the touched trees: 0 errors (warnings pre-existing).
* New `staged-pipeline-e-materials.test.ts` (5 tests):
  * glass vs masonry texels of the metallicRoughness and params maps
  * rejection of a pane that is not darker
  * off is byte-identical
  * the evaluator's specular term brightens the glass pane (+>8 luminance) and leaves the wall within 6
* `facade-materials.test.ts` (+1 test): the reading end to end into the twin (glass texels roughness 13, wall texels 217, metalness 0).
* Related suites: 259 of 260 passed. The failure is `staged-merged-parts.test.ts` "a real pipeline E hero ... 94 meshes become one". It loads whichever E hero is cached on the machine, including sibling worktrees. That hero's clay layer merges into 2 meshes, not 1 (more than `MAX_PARTS_PER_MESH` parts). This depends on the environment and does not involve these changes.

## 6. Candidate Tool/Service Ideas

* **Glass that keeps the photo.** In D, replace the "measured interior" albedo with the projected photo under a low-roughness channel, so the windows keep their real content and only gain view-dependent reflection. That change can be re-judged with this same specular evaluator.
* **Probe from the street.** The reflection is the studio backdrop when the hero is alone. A probe placed outside each facade in the district context would reflect the street the photo shows.
* **Judge views that show reflections.** Street-level views at a grazing angle to large storefront glass are where reflections show. The current held-out views are mostly frontal.

## 7. Reproduction

1. Worktree `facade-materials-merge`, temporary `secrets.json` link. For the headless builds, set `SCRATCHBOX_REPLAY_DIR=<rec>` and use the `chain.sh` arms (`Eh` / `Ehm` / `D` / `Dm` = `SCRATCHBOX_STAGED_PIPELINE=e` and/or `SCRATCHBOX_FACADE_MATERIALS=1`).
2. Strip the material channels from an `Ehm` GLB to get its flag-off twin (drop `metallicRoughnessTexture` and `extras.sbMaterial`, roughness 0.85, metallic 0).
3. `node -r ts-node/register -r ./scripts/dev/staged-replay.ts scripts/dev/photo-match-eval.ts <manifest>` with `"specular": true`.
