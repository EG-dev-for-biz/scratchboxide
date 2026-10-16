# Staged Location Builds (google_3d_tiles_get_clay)

| | |
|---|---|
| Date | 2026-10-15 |
| Domain | Real-world 3D locations: Google Photorealistic 3D Tiles in clay, built in stages the user watches |
| Code | `packages/core/src/node/3d-engine/staged-location/` (orchestrator, cache, evidence, vision, summary), `native-warmup.ts`, `scan-fit-loader.ts` |
| Contracts | `packages/core/src/common/spatial/staged-location-contracts.ts` (owned by the shared contracts branch; read it, never edit it from a feature branch) |

## What it does

`google_3d_tiles_get_clay`, when it remeshes (the default), runs one orchestrated build instead of three blocking steps. Each stage commits as it finishes, streams its status and the scene so far to the chat, and a later failure never removes an earlier stage.

```
resolve -> tiles -> trees-measure -> remesh -> (isolated structure only: fit || evidence -> project -> vision -> correct -> detail) || trees -> finish
```

- A district (default 250 m) commits the tiles, the remeshed scan and the regrown trees.
- An isolated structure (`isolate`) is picked once, on a canopy-masked surface model, and the extraction is sized to it (25 m probe, grown in up to three rounds to 150 m until the footprint is 3 m inside the edge). `radiusMeters` is ignored. The structure is then fitted by `scan_fit`, and facade detail is read from the tile photos and up to four Street View images.

## Degrade, don't fabricate

Every stage has one lower rung built from the same real data. A degraded part gets a `DegradationRecord` (stage, what was intended, what it fell to, the provenance label after, the reason, whether a retry may help), is shaded in the viewport by provenance, and reaches the model in three places: the digest (at most 200 characters, status and degradations first, then the retry handle), the summary sentences, and the structured `degradations` list.

| Failure | Rung (same real data) | Provenance after |
|---|---|---|
| photo-read detail (vision) | the flat fitted face; the record names the model and thinking level tried | fitted |
| the fitted rebuild | the remeshed scan stays the structure | remeshed |
| the remesh | the raw scan with its facades flattened (`scan_fit flatten`), else the raw scan as downloaded; its scanned trees stay in it and nothing is planted over them | scan-flattened / as-scanned |
| a tree that cannot regrow | that tree stays as scanned | as-scanned |
| the whole tree stage | the scanned trees are put back as their own layer, labelled as scanned (never "no trees") | as-scanned |
| measuring the trees | the raw tile is remeshed with its own trees | remeshed |
| Street View | tile orthos only | photo-inferred |

Only an unresolved place and a place with no tile coverage fail the call (`StagedLocationHardFailure`); nothing real is discarded then.

## Provenance labels (what the viewport shades and the model reports)

`as-scanned`, `scan-flattened`, `remeshed`, `fitted`, `fitted-unobserved`, `photo-corrected`, `photo-inferred`, `grown to the measured crown`. tile_refine's photometric relief stays on by default: it is gated (confirmed patterns only) and labelled inferred. Its per-vertex attributes (`_RELIEF_HEIGHT`, `_RECTIFY_DISPLACEMENT`, `_PROUD_BLOCK`) are read in bands (untouched under 1 cm, moved 1-5 cm, reshaped over 5 cm), never by an exact-zero test; an absent attribute means no per-vertex claim, never "as scanned".

## Evidence and the vision call

- **Tile orthos** come from `scan_fit` (one per fitted surface), resampled from the tile photo texture; each carries the photo's own texel size, and an element must be at least twice the smallest sample of the image it cites.
- **Street View** (at most 4 images per building): discovery uses the free metadata endpoint with the Maps key and keeps Google captures only; images come only from `StreetViewGroundingImageService` (Maps Imagery Grounding API, the app's service account). The bytes are held in memory exactly as returned, put into the vision request unchanged, and dropped. They are never written to disk, logged, cached, decoded or re-encoded. Pano ids, locations and dates may be cached. When either credential is missing the stage says which and the detail is read from the tile photos only.
- **Vision**: `gemini-4-argon` at thinking LOW (the user's decision; no benchmark was run), through `vision-model-chain.ts`: a model that is not served moves to the chat's next model and the skipped model and the reason are recorded; a transient error retries the same model; every attempt is on the tool card, in the result and in the summary. The reply is compact and slot-relative, checked by rules 1-13, with at most one revision pass. Photo corrections are accepted only within 0.31 m of scan residual (a refit decides).
- `scripts/bench_ornament_vision.ts` is the optional benchmark (billed; it makes no call without `--yes-billed`).

## Streaming and retry

`ctx.emitStage(event, artifact?)` becomes a `status` event on the chat SSE carrying the running tool card and the `stageEvent`; the scene artifact rides only on a commit, a degrade and the finish (`scene-stg-<runId>`, one id and one camera for the whole run). A Stop marks the run stopped; the model sees the state on the next turn through `stagedBuildContext` (one line ahead of the scene summary).

A degraded part with a retry handle can be retried with `google_3d_tiles_get_clay { retryRunId, retryStage }`: the recorded request is rebuilt from `.scratchbox/cache/staged_location/runs/<runId>/stages.json`, earlier stages hit their caches, and only the named stage bypasses its cache.

## Caching and publishing

Per-stage caches live under `<workspace>/.scratchbox/cache/staged_location/` (the workspace is `SCRATCHBOX_ROOT` when set, else the checkout). Entries are written to a temp dir and renamed; published models are `public/models/<name>_<stage>_<key8>.glb`, written to a temp name and renamed, and re-checked by size and sha256 on every hit. Deterministic native failures are negative-cached (by error-code tables, never by matching message text) and bypassed by a retry. Extraction results are cached 7 days, geocodes 30. Two requests for one key share a run.

## Warm engines

`warmNativeEngine()` runs after the API server's listen callback in `desktop-app/server/index.ts` and `desktop-app/electron/main.ts` (never from `createStandaloneServer`): tile_vegetation, tile_refine, scan_fit, then the `scratchbox_native` Python module the object builder needs, one after the other, each timed in the log. A failed step is logged and the next still runs. `SCRATCHBOX_NATIVE_WARMUP=0` turns it off. A request that needs a binary still being built waits for it and reports the wait.

## Object builder

`build_3d_object_from_reference` reads its spec at thinking LOW through the same chain (the judge calls keep the model's default until a measurement shows the same accept and reject decisions), and finds its Python module already built.

## Tests

`staged-location-orchestrator`, `staged-location-tool`, `staged-location-handoff`, `staged-stage-cache`, `staged-artifact`, `staged-summary`, `staged-scanned-trees`, `staged-remesh-provenance`, `staged-tile-extraction`, `extraction-sizing`, `streetview-evidence`, `ornament-vision`, `vision-model-chain`, `streaming-stage-events`, `complexity-gate-staged`, `native-warmup`, and `desktop-app/test/native-warmup-startup`. The registry-level `tile-tools-do-what-was-asked` exercises the real crawler, the real tool registry and the staged build against a fake tile server. Visual cases write screenshots to `test-results/screenshots/staged/`.

## Not in this branch

The scan fitter service (`scan-fit-service.ts`) and tile_vegetation's `roi` and `canopy` belong to the native workstream. Until they are merged the rebuild stages degrade and say so (`scan_fit_unavailable`, `canopy_not_masked`) and `strip` is given a ROI it ignores.
