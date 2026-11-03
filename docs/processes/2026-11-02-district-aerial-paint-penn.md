# The district's aerial paint at Penn Station: the prototype run

**Date:** 2026-11-02
**Branch:** `feat/district-aerial-paint` (from `main` at `cd52dcb3`)
**Status:** Ran 2026-11-02 (run `f3f527eb`): the method works where it is kept, but 3 of the 4 preregistered bars were missed

## What is tested

`district-aerial-paint.ts`, behind `SCRATCHBOX_STAGED_DISTRICT_PAINT=1`: CityPaint's method (arXiv 2610.27564) on the
app's own image model (`IMAGE_MODEL_PRIORITY`, Gemini image), not CityPaint's diffusion model. The district massing's atlas
is repainted from a height-following aerial sweep. Each face is written only by its best K = 2 views. Each view goes to
the model as the massing over the scan, with the texels no photo reached in a key colour, and with the scan alone from the
same camera as evidence. An answer is kept only when the gate passes at building scale (edges kept, nothing new, hue kept)
and no key colour is left. Photo texels keep their own low band and take the model's detail. Unreached texels take the
paint. Everything written is labelled generated.

## The run

- **Place:** `2 Penn Plaza, New York` (the district test place), `isolate: false`, `district: 'massing'`,
  `radiusMeters: 150`. 150 m, not M1's 250 m, keeps the sweep near 70 views; this is a prototype, not the M1 arm.
- **App:** this worktree, on its own launch entry `scratchbox-district-aerial-paint` (web 3720, API 3721, tools 3722),
  with `SCRATCHBOX_STAGED_DISTRICT_PAINT=1`. The build goes through the app's tool endpoint (`/gemini/tools/run-stream`).
  The worktree's stage caches start empty, so every stage is a miss.
- **Params:** the defaults (`DISTRICT_PAINT_PARAMS`): pitch 48°, hfov 40°, 1344 x 768 at 1K, overlap 0.4, at most 120 views,
  K = 2, rho 0.25, two asks per view.

## What counts

There is no judge verdict in this run. `photo_match_evaluate` judges builds against held-out Street View photos. There is
no aerial photo to hold out (the tiles would be the reference, and a judge would reward copying them), and Penn 2's
street views are on hold for the era mismatch. The prototype is judged by these, written before the run:

| Measure | Bar | Why |
|---|---|---|
| Views kept by the gate, of those with faces to write | at least 60% | below it, the model's answers do not hold registration often enough for the method to work at this scale |
| Unreached texels painted (`texels.fill`) of all unreached texels | at least 70% | the fill is the point of the method |
| Faces with an eligible view left with no accepted view | at most 20% | top K with promotion should cover most faces |
| Painted photo texels' low band | unchanged by construction; checked on the proof renders | measured colour must lead |
| Proof renders from 4 held-out aerial poses (headings between the sweep's, pitch 40°), before and after | no key colour, no flat walls left where a view was accepted, no invented buildings, no shift | read with `screenshot-review` |
| Cost | at most $25 for the paint (`imagesAsked` x $0.067) | |

## Cost

- **The paint:** at most 120 views x 2 asks = 240 images at $0.067 (Gemini 3.1 Flash Image, 1K output, Google's price)
  ≈ $16; about $7 to $10 expected.
- **The district build's own model calls** (pipeline E detail, the revolution references): not recorded for a Penn district
  before; estimated at most $20.
- **Total:** under $40, inside the standing $100 limit.

## What happened before the measured run

The "What counts" section above was written before any paid call and is unchanged. Four builds were started; only the
fourth finished.

1. **Run `5805a429`: no massing to paint.** At the default 524 leaf tiles the scan reached 81 m of the 250 m the
   district grew to, and all 8 buildings failed "the footprint runs past the extraction". Fixed by an opt-in switch,
   `SCRATCHBOX_STAGED_MAX_LEAF_TILES` (`staged-switches.ts`), set to 2000: 780 leaf tiles then covered the full 250 m.
2. **Run `8fe1ef25`: pipeline E's district detail did not finish.** After more than 80 minutes and 21 GB, both worker
   threads were still in `texture-repeat.ts` `findDonors`. Stopped; the measured run has `SCRATCHBOX_STAGED_DISTRICT_E_DETAIL=0`
   (an existing switch). Reported to MAIN, who routed it to the District KD session.
3. **The third run: the real answers were not registered.** About 10 views in, every answer had been rejected, so it was
   stopped (about $1.50 spent) and its 19 saved answers measured offline:
   - a block-wise match found most answers to be the view itself moved 1-7 px and rescaled up to 0.8%: one affine per
     answer explained its matched blocks to 0.5-0.8 px;
   - so every answer's warp is now fitted from its matched blocks and undone before anything is judged or baked
     (`fitAnswerWarp`, `warpAnswerToView`); after it, the kept answers' blocks sit 0-1 px from the view;
   - answers that redrew or reframed the scene still fail (few blocks match, or no one warp fits);
   - a face texel no source produced was sent black, not in the key colour (the black wedges in the first views): fixed
     in `texelClassOf`;
   - a view at the district's edge came back as an invented city block: views over 20% empty are now skipped unasked.
4. **Run `f3f527eb`: the measured run**, with the fixes above. Built through the app's tool endpoint on this worktree's
   instance (web 3720, API 3721, tools 3722) with `SCRATCHBOX_STAGED_DISTRICT_PAINT=1`,
   `SCRATCHBOX_STAGED_MAX_LEAF_TILES=2000` and `SCRATCHBOX_STAGED_DISTRICT_E_DETAIL=0`. The tiles, remesh, trees and
   textures stages were served from the stage cache of run `8fe1ef25` an hour earlier (same code for those stages); the
   massing stage and the paint ran fresh. 108 minutes; the build completed (degraded only where it always is: the
   facade grammar, the isolate-only stages skipped). The massing rebuilt 98 of 179 buildings.

## Results (run `f3f527eb`)

| Measure | Bar | Result | |
|---|---|---|---|
| Views kept by the gate, of those asked | at least 60% | 39 of 78 asked (50%) | missed |
| Unreached texels painted, of all unreached texels | at least 70% | 0.86 M of 29.5 M (2.9%) | missed |
| Faces with an eligible view left with no kept view | at most 20% | 1,261 of 2,290 (55%) | missed |
| Painted photo texels' low band | unchanged by construction | the photo's own low band below 1 m by construction; see the proof renders | by construction |
| Proof renders from held-out aerial poses | no key colour, no flat walls where a view was kept, no invented buildings, no shift | see below | |
| Cost | at most $25 | 129 images of `gemini-3.1-flash-image` at 1K: about $8.64 (Google's $0.067) | met |

- **Views:** 108 planned over 250 m (grid heading 28.5°), 82 with faces to write; 25 had none, 5 were skipped as over 20%
  empty, 78 were asked (129 images over two tries each).
- **Kept answers:** the undone warp's shift had a median of 4.3 px (at most 11.1 px), scale 0.986 to 1.011, residual
  median 0.67 px; after it every kept answer's median block shift was 0 px (29) or 1 px (10). Hue change, median CIEDE2000
  3.3 (bar 12). Key colour left, median 0.5% (never baked).
- **Rejected answers:** 22 had no one warp that placed them (the model moved parts of the view apart); 17 matched too few
  blocks (it redrew the view).
- **Texels written:** 1.46 M photo texels took the model's detail over their own colour; 0.86 M unreached texels and
  33 K repeat-filled ones took the paint; 40 K repeat-filled ones were kept where the paint disagreed with them. All are
  labelled generated (legend indices 4 `aerial-paint-detail` and 5 `aerial-paint`).
- **Why the fill bar missed so badly:** 29.5 M unreached texels lie on 10,482 faces, but only 2,290 faces are seen well
  enough by any aerial view at all (400 px or more), and only 1,029 got a kept view. Most of the unreached area is party
  walls, walls facing narrow gaps and small faces no camera 60 m over the roofs sees. The bar was set against all
  unreached texels, not against what the sweep can see; it is left as written.

## Findings

1. **Gemini does not return a registered image.** The model hands back the view moved by a few pixels and slightly
   rescaled. Anything that bakes an image-model answer back onto geometry (this paint, beautify-to-texture) must fit and
   undo that warp first; a block-wise match and one affine was enough here for half the answers.
2. **The texture-enhance gate cannot judge this.** Its single edge score mixes a moved frame with restyled detail. The
   aerial paint judges registration block by block and keeps that gate's hue check only; DEFAULT and RECREATE_GATE are
   unchanged for everyone else (MAIN, 2026-11-02).
3. **Half the answers are not usable,** and the misses are not shifts the warp could undo: the model moves parts of the
   view relative to each other, or redraws it. Prompting for an exact edit, sending the view at the answer's own aspect,
   or asking per building (smaller crops, CityPaint's stage 4 orbit) are the next things to try.
4. **The sweep's height decides what can be painted.** From 60 m over the roofs, most walls are never seen well. Walls
   need CityPaint's per-building orbit (20° and 35°) or street-level views, not more of the same sweep.
5. **District massing at Penn needs the raised tile cap,** and pipeline E's district detail does not finish there.
6. **No face texel of the Penn massing is unwritten.** Counted 2026-11-03 on run `f3f527eb`'s `district_massing_unpainted.glb`
   (5 pages at 4096²): no texel carries the clay rung, and none of the 37.2 M texels the faces sample (their UV triangles
   rasterised) has confidence A 0; the 15.5 M A-0 texels are page area no face uses. `packFaces`' path for a texel no
   source wrote (RGB 0, drawn black) is real but this build never took it. What the district does show is flat colour:
   30.4 M written texels (45%) are rung 4, the measured palette colour; 36.2 M are tile photo transfer and 1.8 M repeated
   fill. Sent to District KD.
7. **The answer warp is its own module now** (`packages/core/src/node/spatial/answer-warp.ts`, PR #34, from `main`), with
   the final numbers over all 129 answers of this run: 43 pass, 44 `answer_parts_moved`, 42 `answer_redrawn`; residual
   median 0.5 px; blocks in place 7% → 92% (medians). This branch's copy (`fitAnswerWarp`, `warpAnswerToView` in
   `district-aerial-paint.ts`) is the earlier one the run used.
