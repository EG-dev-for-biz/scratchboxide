# Pipeline E: massing texels with no source

**Date:** 2026-11-03
**Status:** fixed and tested offline. Live at Penn Station (section 4) the fix found nothing to fill, since that build's
inference failed.
**Branch:** `fix/massing-unsourced-texels` (from main `cd52dcb3`), commit `a82cfab3`.
**Routed by:** MAIN (2026-11-03), from the aerial-paint session's finding.

## 1. The defect

A pipeline E face texture starts with every texel marked "not yet produced": source 255, and RGB 0 where nothing copies
a colour in (`face-textures.ts` `textureFromOrtho`, inference.ts `reframe`, relief.ts `reframeTexture`).
`massing-glb.ts` `packFaces` then copies each texel's RGB, forces alpha to 255, and packs a texel whose legend has no
entry for its source as the clay rung, with A 0 in the confidence page. Three paths reach it with such texels:

| Path | When | What the layer shows |
| :--- | :--- | :--- |
| inference.ts, the occluder fill's last `fillNearest` | an occluder mask (uncovered texels, measured tree crowns, the vision model's boxes, dilated 2 texels) covers every texel of a wall: the texels go back to 255 and `fillNearest` has nothing to grow from and no fallback | the masked photo, labelled clay |
| inference.ts `reframe` | a re-cut face its parent face's texture does not reach at all | black |
| relief.ts `reframeTexture` | texels of a re-cut face that no matching base face covers, when its plain texture is missing or another size | black |

The plain layer (`plainTextures`: the repeat fill, then `fillNearest` with the median fallback, or the facade median)
gives every texel a source, so the defect is only in the inference and relief layers.

## 2. How much of a layer it is

Each GLB's MassingPage atlases were decoded and the placed texels counted by their confidence texel: A 255 is sourced;
A 0 with B 6 (the clay rung) is a placed texel with no source (`scratchpad black_texels.py`, read-only on the files).

| Layer | Run | Placed texels | No source | Of those, near-black (max RGB <= 8) |
| :--- | :--- | ---: | ---: | ---: |
| Penn district massing, E detail off | `f3f527eb` (aerial-paint session), unpainted and painted | 68,337,420 | 0 | 0 |
| Trafalgar Square district, inference layer (E detail on) | `b5b76042` (new-work-buttons session, unfinished) | 495,127,093 | 1,334,254 (0.27%) | 18 |

- **f3f527eb did not run the step the defect lives in.** Its `massing` dir has no `detail` folder, so it ran with the
  E detail off. Its 75,385 near-black texels (0.11%) all carry a source: real dark texels (shadowed reveals, glass).
- **At Trafalgar the unsourced texels are whole walls, not black ones.** On page 14, one is a 718 x 523 texel wall
  (face 6116 of the inference run) that shows a real facade photo yet is labelled clay: the occluder path in section 1.
  The black paths (`reframe`, `reframeTexture`) added only 18 texels there. The relief layer had not been written.

## 3. The fix (`closeUnsourcedTexels`, pipeline-e.ts)

`writeMassingLayer` runs it before packing, so every layer gets it: district massing, inference, relief, version F
and pipeline G.
- **Which texels.** Any texel whose source index the legend does not hold: 255, or an index past the legend.
- **On copies.** The callers' textures feed later stages (the inference layer's textures are relief's base), so only
  the layer's own copy is filled.
- **The believability default, in order.**
  1. The face's own repeats: `repeatFillFace` on its real photo texels (the legend's `tile-ortho` entry), at a gated
     same-plane pitch. With no `tile-ortho` entry (pipeline G's legend) this step is skipped.
  2. The face's nearest texel with a source (`fillNearest`).
  3. A face with no sourced texel at all takes its building's median real wall colour (the walls of its part), else the
     layer's.
- **Labelled.** Each fill is labelled `generated`, with the reason in its legend entry (`UNSOURCED_LEGEND`:
  `unsourced-repeat`, `unsourced-nearest`, `unsourced-median`). The entries are appended only when used.
- **Nothing else changes.** A layer with nothing unsourced is written exactly as before: same textures, same legend.
- **Reported.** The layer files carry the packed legend, which the published provenance now lists, and what was filled
  (`unsourced`). The district detail notes say how many texels each layer filled, and how.
- **Caches.** `DISTRICT_E_DETAIL_VERSION` (now 3) and `RELIEF_VERSION` (now v3) are bumped, so cached layers rebuild.

**Tests.** `packages/core/test/pipeline-e-unsourced-texels.test.ts` (5 tests) covers:
- a clean layer passed through untouched;
- a wholly masked wall taking its own building's median, not another building's;
- a black strip and dropped rows: the dropped rows are refilled with their bands by the repeat, the strip from its
  nearest texel, and `packFaces` then packs no clay or black texel where it packed both before;
- an index past the legend;
- pipeline G's legend.

All pass, with the pipeline-E repeat, relief and version-F3 tests. The wider pipeline-e, district, massing, texture,
inference and relief suites pass too: 73 of 74 files and 458 tests, run with credentials unreachable. The one failure,
`depthbox-inference-service`, is the venv lacking `torch` and `transformers`. `tsc -p packages/core` is clean.

## 4. The live check at Penn Station

Run `454f8a26` covered 250 m with 780 leaves. It ran on this session's SSD instance with this fix and the donor-search
fix (`fix/texture-repeat-donor-index`). It is a measurement, not a comparison arm.
- **The E detail ran to the end in 40.7 minutes.** Relief built 169 features (109 bands, 60 vertical elements).
- **The relief layer had no texel without a source.** Its rung shares are 54% tile photo, 2% repeat and 44% palette,
  with 0% clay, and its legend was not extended: the closure found nothing to fill at Penn.
- **Why nothing.** The inference failed: its native `staged_massing` run on the 98-building spec was killed, most likely
  at `runMassing`'s 180 s timeout under load. So relief re-framed onto the plain textures, which cover every texel.
- **Where the defect does live.** The paths that leave texels unsourced are inference's and relief's own re-framing. At
  Trafalgar (section 2) that was 0.27% of the inference layer.
