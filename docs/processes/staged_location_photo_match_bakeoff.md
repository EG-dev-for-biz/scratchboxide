# Staged Location Builds: Photo-Match Bake-off (what looks most like the real place)

**Date:** 2026-10-19 · **Target:** what an isolated staged build (`google_3d_tiles_get_clay`, `isolate: true`) should produce · **Status:** Evaluated. Pipeline defaults unchanged; the recommendation below is for review.

## The judge
`scripts/dev/photo-match-eval.ts` (maths in `packages/core/src/node/3d-engine/staged-location/photo-match-eval.ts`, test `packages/core/test/photo-match-eval.test.ts`):
- **Held-out views** (`scripts/dev/photo-match-heldout.ts`). These are Google Street View panos near the structure that no build used: none of the pano ids in the builds' staged-replay recordings. The evaluator refuses a view whose pano any arm used, and it did refuse one at Jefferson Market, a pano that a later build fetched. Each pano gets one view aimed at the structure. The view is posed against the full tile mesh by `registerPanosByEdges` and kept only when its edge residual locks on (at most 5 px, lower than the start).
- **Renders.** Each arm is rendered from exactly that pose, at the photo's resolution and field of view. The renderer is a software rasterizer: perspective-correct UVs, mip-mapped bilinear sampling, 2x2 supersampling. Every arm gets the same neutral light (ambient 0.72 plus a headlight) on the same grey background. The full tile mesh is a depth occluder, so neighbours and trees hide every arm the way they hide the building in the photo.
- **Blind judging.** `gemini-4-argon` at thinking HIGH, through `VisionModelChain`, sees the photo and then the renders, shuffled and unlabelled. It scores each render 1-10 on shape, materials, detail, errors (10 means none) and overall. Each view is judged 3 times with the order reshuffled.
- **Secondary numbers**, inside the building mask (the raw isolate's coverage): luminance SSIM, the symmetric structural-edge chamfer (the fit metric's edges), and the mean CIEDE2000 of the blurred colours. The pipeline's own held-out chamfer for each layer comes from `texture_fit.json`.
- **Grids.** For each view, the photo and the arms side by side, labelled, in `test-results/screenshots/bakeoff/`.

## Arms (built with the app's pipeline, origin/main 732bad34)
- **A:** the photo-textured tile as downloaded, cut to the isolate tile_refine wrote (`raw_clay.glb`, matched by triangle centroid).
- **B:** the cleaned mesh (l2, or l2g where the facade grammar was accepted) textured from the tile photo (`SCRATCHBOX_TEXTURE_STREET_VIEW=off`). With `SCRATCHBOX_TEXTURE_LIGHTING=1` the tile correction **never applied**, on any place: it relights only fitted charts, and B's layers are scan island atlases. B is therefore the tile photo without de-light.
- **B+ (experiment arm):** B with the tile correction forced on (`SCRATCHBOX_TEXTURE_LIGHTING_TILE_FORCE=1`). Every atlas map is sent and the detail lock still applies, but there is no Street View agreement gate. It applied on 4 of 5 places; on St. Mark's the lock rejected the answer.
- **C:** B plus Street View with the model lighting correction (`SCRATCHBOX_TEXTURE_STREET_VIEW=keep`, which keeps the no-fit rung without its held-out gate).
- **D:** the current default: the visible layers and their textures.

All knobs are experiment-only environment flags, off by default, and part of the texture cache key.

## Results (judge overall, mean of 3 runs per view, averaged over views)
| Place (views) | A raw | B cleaned | B+ forced de-light | C +Street View | D default | Winner |
|---|---|---|---|---|---|---|
| Puck Building (5) | 2.20 | 2.53 | 2.53 | **3.07** | 2.53 | C |
| Haughwout Building (5) | **3.93** | 3.20 | 3.20 | 3.67 | 3.67 | A |
| St. Mark's Church (4) | **4.67** | 3.67 | 3.67 | 2.92 | 3.67 | A |
| Washington Square Arch (6) | 2.05 | 2.83 | 2.83 | **4.95** | 4.61 | C |
| Jefferson Market Library (4) | **3.92** | 3.33 | 3.50 | 3.83 | 3.33 | A |
| **All 24 views** | 3.22 | 3.07 | 3.10 | **3.76** | 3.61 | C (narrowly) |

Fractional view wins: A 9.3, C 9.1, D 4.6, B+ 0.75, B 0.25. Judge consistency: the mean within-view standard deviation over the 3 shuffled runs is 0.23. 54% of (view, arm, criterion) cells scored identically every run, and 2.7% spread by 2 or more. Arms whose renders were pixel-identical (B and D on Puck and St. Mark's) got identical scores in every run.

**Secondary numbers** (all views): SSIM A 0.218, B 0.206, C 0.172, D 0.182. Edge chamfer A 7.63, B 7.53, C 7.73, D 7.49 px. CIEDE2000 A 19.2, B 17.1, C 17.1, D 16.7. These pixel numbers do not rank the arms the way the judge does: SSIM prefers A and B everywhere, including the arch, where the judge puts them last.

## What decides it
- **Street View helps where it registers, and badly hurts where it does not.** On the arch, C (4.95) and D (4.61) are the only arms with legible ornament. On St. Mark's, C projects a neighbouring building's facade onto the church front (2.92). There, D's held-out gate set Street View aside (only 3 scoring views), and the gate was right. On Puck the gate set Street View aside (held-out chamfer 7.55 against the clay's 7.00), but the judge prefers it (3.07 against 2.53): the chamfer gate and the judge disagree there. On Haughwout, C and D both keep Street View: the close view gets a neighbouring storefront painted across the facade, and the far view gets the billboard.
- **The cleaned mesh loses materials.** The tile transfer misses rectified walls that moved away from the tile surface, and those texels fall to the flat measured-palette colour: 28% (Puck), 55% (St. Mark's) and 50% (Jefferson) of the layer. The judge reads those areas as white, beige or blue slabs ("vertical curtain artifacts"). This is why the raw tile wins materials on ordinary buildings with no accepted fit.
- **Forced de-light does nothing visible.** B+ is within 0.17 of B everywhere. Relighting a whole island atlas as one image gives only a very smooth gain.
- **Cold-build race (D).** On the first, uncached build of Haughwout and Jefferson, the facade grammar's `l2g` committed after the texture pass and was left untextured (shown in clay). On cached rebuilds it was textured.

## Recommendation (for review, not applied)
1. The current default (D) is a close second to C. Do not switch to "Street View always" (C): it fails on St. Mark's.
2. Fix the cleaned mesh's tile-transfer coverage first. Widen the transfer's distance gate to the rectification displacement, which tile_refine records per vertex (`_RECTIFY_DISPLACEMENT`), so rectified walls carry the tile photo instead of the palette. That is the largest and most consistent loss against the raw tile.
3. Re-check the no-fit Street View gate against this judge: on Puck it set aside Street View that the judge preferred.
4. Make the photo-match evaluator the standard check for future work.

## Round 2: the fixes, and the bake-off again in context (2026-10-19)

**Fixes on main.** 1c61ffbf: the tile transfer's distance gate widens per texel by the move tile_refine recorded (`|_RECTIFY_DISPLACEMENT| + |_RELIEF_HEIGHT|`, at most 1 m more). e2740520: the texture stage waits for the facade grammar, so `l2g` is textured on a first build. 454fe988 and ab37e077: Street View pixel ownership and occluder cleaning (`streetview-ownership.ts`), then fill order other view, tile photo, inpainting (`texture-inpaint.ts`). 5ef62719 and ba7a13c7: the evaluator renders every arm in its street.

**What fix 1 measured.** The rectification move is not why the cleaned mesh falls to the palette. Re-running the transfer on the bake-off layers, widening the gate by the recorded move lowers the palette share by only 0.4 to 2 points (Puck 28.5 -> 27.7%, St. Mark's 54.5 -> 54.1%, Jefferson 51.0 -> 48.9%, Haughwout 8.4 -> 7.4%); even a flat 1 m gate recovers 3 to 7 points. Most palette texels have no same-facing tile surface within 1 m at all: party walls cut against neighbours, faces inside the isolate, ground and lower walls under tree canopy (the tile surface is 4 to 12 m above them), and on Puck stretches of facade where the tile's photo surface lies several metres from the remeshed wall. These are not fixed; B still loses materials to A.

**Ownership and occluders.** Per photo the structure is cut out by the vision model plus MediaPipe/GrabCut (box from the projected scan), and what stands in front is taken out (depth test against the tile mesh, an open-vocabulary "anything standing in front of the facade" cut-out, growth along thin vertical lines, dilation). Photos kept / sent: Puck 8/9, Haughwout 3/8, St. Mark's 1/5, the arch 16/16, Jefferson 3/5; the photos refused show neighbours (the model names them: storefronts, the Valentino-poster brick building, apartment buildings). Occluded texels, by where they ended up (C arm, main layer): Puck 7% other view / 85% tile / 0.05% inpainted / 8% palette; Haughwout 2 / 97 / 0.1 / 1; St. Mark's 0.03 / 61 / 0.2 / 38; the arch 70 / 30 / 0 / 0; Jefferson 4 / 71 / 7 / 17. Inpainting writes few texels: most holes sit in small islands with too little real texture around them, and the lock refused answers that left magenta or did not join the rim.

**Thin structures.** The growth caught poles where the segmenter had caught part of them (a traffic-signal pole and lamp posts on Haughwout, a pole against the arch pier), about 1 to 3% of the removed pixels. Free-standing poles the segmenter missed entirely are still missed. False positives: on one Haughwout photo the occluder cut-out took a whole right-hand bay of the facade, and on the arch small pieces of frieze sculpture; those texels fall to the tile photo.

**The evaluator in context.** Each arm is drawn inside the photo-textured tile with only the target's own triangles cut out, the same street for every arm. On the same Puck builds the old renders (isolated on grey) score A 3.47, B 3.80, C 3.87, D 3.80; in context A 4.53, B 3.27, C 3.47, D 3.27. The raw tile goes from last to first once it is seen in its street.

| Place (views) | A raw | B cleaned | C +Street View (owned) | D default | Winner |
|---|---|---|---|---|---|
| Puck Building (5) | **4.53** | 3.27 | 3.47 | 3.27 | A |
| Haughwout Building (5) | **3.67** | 3.20 | **3.67** | **3.67** | A = C = D |
| St. Mark's Church (4) | **3.92** | 3.67 | 3.58 | 3.67 | A |
| Washington Square Arch (6) | 3.72 | 3.83 | 5.28 | **5.33** | D |
| Jefferson Market Library (4, one view dropped: a build now uses its pano) | **4.83** | 4.08 | 4.00 | 4.00 | A |
| **All 24 views** | **4.10** | 3.60 | 4.07 | 4.06 | A (narrowly) |

The two rounds are not comparable number for number (the renders changed from isolated to in context). Within round 2, C and D no longer paint the wrong building: St. Mark's C rises from last of the pipeline arms (2.92, round 1) to within 0.1 of B and D. Judge consistency: mean within-view standard deviation 0.18.

**The no-fit gate on Puck (fix 5).** After ownership the gate still sets Puck's Street View aside (held-out chamfer 7.84 px against the clay's 7.10), and the judge still prefers keeping it, by a small margin: C 3.47 against D 3.27 in context, 3.87 against 3.80 in the old renders. The gate is unchanged.

## Round 3: pipeline E (2026-10-19)

Pipeline E (clean vector massing, ortho-textured faces, scanned residual, verified inference, opt-in enhanced textures; `staged_location_pipeline_e.md`) was judged with the same 24 held-out views in context, blind ×3, on three arms the user chose: E-minus-inference 3.85, E 3.81, E-enhanced **4.07** (all views). E applies at Puck, Haughwout and Jefferson; St. Mark's (massing IoU 0.54) and the arch (no vector footprint) fall back to the current pipeline in every arm. The gain is enhanced mode on Puck (4.53 against 3.40-3.53); inference alone does not move the score. Grids: `test-results/screenshots/version_e/bakeoff/` (photo | E-minus | E | E-enhanced).

## Reproduction
`scripts/dev/photo-match-heldout.ts`, then `scripts/dev/photo-match-eval.ts <manifest>` (each script's header gives its usage).
