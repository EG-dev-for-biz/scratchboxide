# Pipeline K facade upscale, live at Penn 2

**Date:** 2026-11-04 · **Status:** Verified live (opt-in, off by default) · **Switch:** `SCRATCHBOX_K_FACADE_UPSCALE=1` or the node graph's `twin.facadeUpscale`

## What it does

Each rebuilt facade's photo in the twin (`FacadeLattice_<id>`, about 15 cm a texel) is sent in tiles to Gemini 3 Pro
Image for the same picture at up to 4x (`pipeline-k/facade-upscale.ts`). Only the answer's fine detail is kept, added to
the photo enlarged; it is kept where the answer shrunk back (its smooth colour offset removed) still matches the photo,
and capped at the photo's own local contrast. Labelled generated (`sbFacadeUpscale`, one provenance entry); answers kept
in the model readings store.

## Runs (my own instance, ports 3960-3962, branch `feat/k-facade-upscale`, stage caches cleared before each)

| Run | Code | Upscale | Result |
|---|---|---|---|
| 3b87c37c | first version, calls one at a time | 30 calls in 38 min | the chat tool's 40 min limit stopped the textures stage before the upscale finished |
| 58fd725d | 4 calls at a time, a 15 min step limit, the build's time +20 min | 31 of 34 facades in 3.7 min | median detail kept about 20%: the answers were 1024 px drafts, and a brighter answer was read as a redrawing |
| 85ed68bf | the draft-image fix and the colour-offset-free check | 31 of 34 facades, 48 calls, 7.7 min; build 623 s | median detail kept 80%; 28 of 31 keep more than half; none under a fifth |

## Findings

- **App-wide bug fixed:** `generateImageWithModels` (and three direct callers) took the first image part of a reply.
  Gemini 3 Pro Image sends 1K draft images (`thought: true`) first, so every Pro image call kept the draft. A 2K ask
  through `genAiEnhanceClient` returned 1024 x 1024 before the fix, 2048 x 2048 after (`finalImagePart`).
- The gain at walk-mode distance is modest: crisper mullions and edges, finer grain; no invented signs or windows
  (the check and the contrast cap hold the model to the photo). Sheet: `docs/screenshots/2026-11-04-penn2-facade-upscale.png`.
- Two thin facades (16 and 19 px wide) are too small to read; one facade fell past the 48-call budget.

## Candidate Tool/Service Ideas

- A per-facade before/after export in the run folder, so a sheet needs no reconstruction from the twin.
- Upscale only the walk-reachable band (lowest 15 m) of tall facades, to spend the call budget where a walk sees it.
