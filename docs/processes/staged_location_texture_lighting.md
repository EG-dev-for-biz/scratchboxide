# Staged location: model lighting correction of the texture photos (detail-locked)

Status: built, off by default (`SCRATCHBOX_TEXTURE_LIGHTING=1` turns it on). Code: `packages/core/src/node/3d-engine/staged-location/texture-lighting.ts`, the gate in `texture-pass.ts` (`gateLightingViews`), the measure in `texture-projection.ts` (`measureCrossViewAgreement`), the tile hook in `tile-texture-transfer.ts` (`correctCandidates`). Tests: `packages/core/test/texture-lighting.test.ts`.

## What it does

1. The texture stage sends every registered Street View photo, and in each layer every fitted face's frontal crop of the transferred tile photo, to an image model (default Nano Banana Lite, `gemini-3.1-flash-lite-image`; `SCRATCHBOX_TEXTURE_LIGHTING_MODELS` picks another) asking for the same image under uniform, shadowless, diffuse light. Calls run in parallel through the texture-enhance client (`generateImageWithModels`).
2. Detail lock: the model's pixels are never used. The answer is resized to the image sent; it is rejected when its aspect ratio changed (> 2 percent), its Sobel edges at zero shift correlate below 0.5 with the photo's, its best-matching shift is more than 1 px at 512 px, or more than 20 percent of the subject needs a gain outside 1/6..6. Otherwise C = blur(answer) / blur(photo) per channel in linear light (sigma 3 percent of the longest side, on a 128-cell grid, masked to the subject so the sky is in neither blur), and the photo becomes photo x C.
3. Gate, per layer: cross-view agreement on the layer's atlas (every texel 0.25 m apart, 0.5 m footprint, the bake's own visibility and exposure solve; pairs of crops of one pano do not count), CIEDE2000 median and p95 over texels two panos see. The corrected set is used only when both drop, with at least 500 such texels; a photo flagged by its own pairs is set back only when that lowers the set's disagreement. The tile correction stands only when the tile agrees better with the Street View texels (9 x 9 texel means, exposure matched), chart by chart and for the layer. Otherwise a degradation record says why.
4. Provenance: corrected texels stay `photo-inferred`, with `lightingCorrection: { models, note: "photo, lighting corrected by <model>", confidence, images }`.

## Prompt study (Washington Square Arch, Lite, 16 Street View crops + 57 tile charts per variant)

Sources: Google's prompting guide for Gemini image editing (https://developers.googleblog.com/en/how-to-prompt-gemini-2-5-flash-image-generation-for-the-best-results/), the Gemini API image docs (https://ai.google.dev/gemini-api/docs/image-generation), the Vertex model page (https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-1-flash-image). JSON prompts are not in Google's guides; tested anyway. Lite serves only 1K output; the request sets `imageConfig.aspectRatio` and the image is padded to it.

| variant | lock rejections | cross-view CIEDE2000 median (all corrected) | p95 | raw edge NCC (median) |
|---|---|---|---|---|
| plain-detailed (chosen) | 28 / 73 (38%) | 3.51 -> 2.97 | 10.71 -> 9.19 | 0.949 |
| plain-short | 35 / 73 (48%) | 3.51 -> 3.16 | 10.71 -> 9.72 | 0.896 |
| google-template | 49 / 73 (67%) | 3.51 -> 3.41 | 10.71 -> 10.99 | 0.393 |
| json | 32 / 73 (44%) | 3.51 -> 3.95 | 10.71 -> 14.63 | 0.914 |
| json-preserve | 42 / 73 (58%) | 3.51 -> 4.06 | 10.71 -> 15.52 | 0.813 |
| google-template-negative | 43 / 73 (59%) | 3.51 -> 3.35 | 10.71 -> 10.42 | 0.796 |

Naming the subject ("a building") made Lite redraw whole buildings into tile crops; JSON prompts redrew more and agreed worse. The plain, detailed instruction redraws least.

## Results

Arch (replayed evidence, the same for every build), Lite with the chosen prompt:
- Street View crops: 16 of 16 pass the lock; the gate used 12 of 16 on the scan (l2) and the fitted arch (l3b): CIEDE2000 median 3.45 -> 2.90 and 3.62 -> 2.97, p95 10.8 -> 9.1 and 11.1 -> 9.4. The detail layer (236 multiply-seen texels) is left alone.
- Leave-one-pano-out (chamfer px / gradient NCC): l2 6.053 / 0.144 -> 5.942 / 0.139; l3b 6.242 / 0.082 -> 6.195 / 0.084.
- Seams: Street View output seam p95 l2 16.88 -> 16.98, l3b 17.44 -> 14.99; Street View / tile seam p95 l2 24.07 -> 22.87, l3b 23.83 -> 21.73.
- Tile charts: 29 of 57 pass the lock; the layer's tile agreement with Street View moved 6.29 -> 6.13 median but 18.09 -> 18.16 p95, so it was not applied.

Nano Banana (`gemini-3.1-flash-image`) on the same evidence: slower (about 15 s per crop against Lite's 9 s live), redrew more (edge NCC 0.87 against 0.95), one answer out of range, and the views' agreement improved less (weighted median 3.51 -> 3.24 against 2.94 for Lite). No newer full Nano Banana is served on Vertex in this project (the listing has gemini-3.1-flash-image, gemini-3.1-flash-lite-image, gemini-3-pro-image and a 404ing gemini-3.1-flash-image-preview).

Haughwout Building (live): 8 of 8 crops pass; agreement 14.4 -> 13.9 median, 31.1 -> 30.6 p95; leave-one-pano-out 8.733 / -0.001 -> 8.694 / 0.000. Puck Building (live): the fit did not pass its gates and the layer is textured from the tile alone, with no fitted faces, so nothing was corrected.

## Why it stays off by default

The primary gate improves where it acts, but one secondary measure got slightly worse (the scan layer's leave-one-pano-out gradient NCC 0.144 -> 0.139, its Street View seam p95 +0.1), Lite does not relight much (the arch's pier exposure step between the tile and the Street View texels is still there), and the tile correction never passed on the arch. Known artefact: where the tile mesh's silhouette is misregistered against a photo, the mask holds a band of sky and the correction lightens it (seen above the arch's attic in one crop).
