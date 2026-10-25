# Process: Pipeline I's own texture holes (black tearing) — traced, fixed, verified live

> **Recorded:** 2026-10-24
> **Status:** Verified
> **Tags:** `operate-scratchbox`, `watch-staged-build`, `pipeline-i`, `texture-holes`, `image-hole-infill`, `haughwout-benchmark`
> **Target Domain:** 3D Building staging — Pipeline I (Trellis/Meshy) texture quality

---

## 1. Session Context

* **What prompted this session:** a live Haughwout Building rebuild (run `1ce71a26`, recorded the same day in [the massing review](./pipeline_i_massing_review_haughwout_footprint_breach.md)) scored **48/100** on the app's own visual check: *"Texturing exhibits severe tearing and missing faces along the side, creating harsh black artifacts."* The user asked to look into it as a follow-up fix.
* **Instance used:** own isolated launch entry `scratchbox-massing-review` (ports 3400-3402, `SCRATCHBOX_PIPELINE_I_REFINE=1`), same pattern as the footprint-lock session.
* **Scope tested:** Pipeline I's own generated texture (Trellis multi-view reconstruction), both the plain path (`pipeline-i.ts`) and the prototype refine path (`pipeline-i/refine.ts`).

---

## 2. Root Cause

Rather than guess, the raw Trellis output texture from the failing run was extracted and measured directly:

* The GLB's single `baseColorTexture` image (2048x2048) was pulled out of `refine_unprojected.glb` (the pre-projection, raw-from-Trellis texture) with a one-off diagnostic test.
* **7.8% of the texture was literal black** (RGB < 8 on every channel) — not a dark material colour, a true hole. `magentaPct` was 0%, ruling out any stray inpaint-placeholder leak from elsewhere in the codebase.
* This is Trellis's own limitation: surfaces its 4 input character-sheet views never saw (interior courtyard walls, true backsides, occluded ground-floor sections) come back unfilled, baked flat black into the generated UV atlas.
* Nothing in Pipeline I's code filled these holes before the GLB was written and rendered — the black bakes straight through to the finished build, exactly matching the visual check's "harsh black artifacts."
* A bonus finding: the black holes also corrupt the facade *scoring* in the refine path (`compareFacade`'s `photoEdges` reads a black-vs-real-colour boundary as a spurious sharp edge), so the hole wasn't just cosmetic — it was degrading the facade precision/recall numbers too.

This directly matches AGENTS.md's "believability first, honestly labelled" rule: *"Where real data is missing... the default is a plausible, labelled fill... not a refusal, a blank gap, a flat/clay fallback."* A literal black gap is exactly what that rule rules out, and nothing was filling it.

---

## 3. The Fix

* **No new machinery invented.** The codebase already has a generic, proven hole-infill utility (`image-hole-infill.ts`'s `infillImageHoles`) used elsewhere for a warp's white disocclusion and an unseen plate's grey — it finds flat-colour regions above a minimum size, crops around them with margin, and runs them through the detail-locked generative inpaint (`texture-inpaint.ts`: the model sees the hole in magenta, its answer is kept only if it reproduces the real surrounding pixels and joins the rim cleanly).
* **New file:** `packages/core/src/node/3d-engine/staged-location/pipeline-i/texture-holes.ts` — `infillModelTextureHoles(glbBytes, opts)` walks a GLB's materials for every image used as a `baseColorTexture`, decodes it, runs `infillImageHoles` with black (not white) as the hole colour, and re-serializes only the images that actually got filled, byte-identical otherwise.
* **Wired into both places** that produce Pipeline I's final texture, since the refine path re-derives its own texture from the raw model independently of the plain path:
  - `pipeline-i.ts`: after colour-matching, before the model is written and fitted.
  - `pipeline-i/refine.ts`: after colour-matching, **before** the model is surveyed/scored (fixing the scoring-corruption side effect too) and before it's projected onto.
  - `orchestrator.ts`: both `runPipelineI(...)` and `refinePipelineI(...)` call sites now pass `infill: { client: genAiEnhanceClient(visionAvailable.client), models: [LIGHTING_MODEL_FULL] }` when a vision client is available (same pattern already used for the pipeline G/H enhance infill).
* **Reported, not silent:** a new `'texture holes'` step appears in Pipeline I's own step list, and the refine path's chat summary now names the hole count and fill outcome, so a future run that still has holes (model refused, no vision client) is visible, not just silently worse.

---

## 4. Tests

`packages/core/test/pipeline-i-texture-holes.test.ts` — 4 tests, a local mock image model (nothing bills):
* fills a black hole, leaves the rest of the texture untouched (byte-exact outside the grown hole region);
* leaves the texture unchanged with the reason, when the model keeps the holes (magenta) in its answer;
* comes back byte-identical when the texture has no black holes;
* comes back byte-identical (and reports `no_images`) when the GLB has no `baseColorTexture` at all.

Full regression: `pipeline-i-texture-holes.test.ts`, `pipeline-i-refine.test.ts`, `pipeline-i.test.ts` (including its pre-existing end-to-end tests, unaffected since `infill` is optional and off by default), `image-hole-infill.test.ts` — **24/24 pass**. `tsc --noEmit` clean throughout.

---

## 5. Live Verification

Same Haughwout build, same instance pattern, fresh chat (run `a3cff44a`):

| Measure | Before (run `1ce71a26`) | After (run `a3cff44a`) |
| :--- | :--- | :--- |
| Visual check score | 48/100, "severe tearing... harsh black artifacts" | not re-scored by the app, but visually clean (see screenshot) |
| `pipeline_i.json` / `pipeline_i_refine.json` `holes` | field did not exist | `{images: 1, holePixels: 244284, filledPixels: 244284, decision: "accepted", modelUsed: "gemini-3.1-flash-image"}` — both paths |
| Finish status | `committed` (0 degradations; this bug doesn't gate the build) | `committed` (0 degradations), 399 s |
| Visual (zoomed facade) | diagonal black streak, torn patches | continuous facade, no black tearing |

244,284 texels — about 5.8% of the 2048x2048 atlas — were found and filled by `gemini-3.1-flash-image` and accepted (passed the detail lock). The fix fired identically in both the plain Pipeline I path and the refine path, confirming the dual wiring was necessary (the refine path's `unprojectedGlb` is derived independently and would otherwise have kept the holes even with the plain path fixed).

---

## 6. Not Committed

`texture-holes.ts` (new), `pipeline-i.ts`, `pipeline-i/refine.ts`, `orchestrator.ts` (two call sites + one run-note), `pipeline-i-texture-holes.test.ts` (new) are in the working tree, verified but uncommitted pending the user's go-ahead.
