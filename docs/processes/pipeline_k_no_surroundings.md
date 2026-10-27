# Pipeline K: the 3D Building build no longer loads the surroundings

**Date:** 2026-10-27
**Target Domain:** staged locations / pipeline K / 3D Viewport
**Status:** Verified

## Goal

A pipeline K build of one building (the 3D Building button's default) loaded the place around it as well: the vector first paint extruded every Google building within the extraction's maximum radius (Midtown Manhattan around the Empire State Building), and surrounding terrain, vehicle removal and road surfaces were queued behind it. K keeps and straightens the one building's scan, and its base cleanup removes the street anyway, so none of that is needed.

## Change

`orchestrator.ts`: when `request.isolate` and pipeline K (and not `procedural`), the `vector`, `vehicles`, `terrain` and `roads` stages are skipped with the reason "pipeline K builds the one building: the surroundings (vector massing, terrain, street cleanup) are not loaded", marked out of scope so the progress panel leaves them out (`Runner.outOfScope`, `PIPELINE_K_ISOLATE_SKIPPED`). The tiles' own footprint lookup (structure sizing, base cleanup) is a separate call and still runs. A K district and the procedural pipelines are unchanged.

Test: `staged-location-orchestrator.test.ts`, "a pipeline K isolate (the 3D Building default)".

## Live run

- Instance: own launch entry `scratchbox-k-no-surroundings`, ports 3570 / 3571 / 3572, this checkout.
- New chat, the 3D Building starter button (prompt: "Build a 3D building of the Empire State Building at 350 Fifth Avenue, New York: isolate it and straighten it from Google Maps, its walls flat and its own photo texture straightened").
- Run `b6081752`, request `{ isolate: true, trees: true, pipeline: 'k' }`.
- Server timeline: `vector skipped` at +0.0 s, `tiles committed` +5.1 s (cached, 265,578 tris), `vehicles skipped`, `terrain skipped` +5.1 s, `roads skipped` +5.3 s, `remesh committed` +103.3 s, finished in 3 min 44 s (degraded, see below).
- Page text after the run: "Google vector massing", "Surrounding terrain", "Removing vehicles", "Road surfaces" each appear 0 times.
- Viewport (fit to view): the textured Empire State Building alone in the studio void; no city massing, no terrain. Screenshot: `docs/screenshots/2026-10-27-pipeline-k-no-surroundings-esb.jpg`.

## Observations

- Nothing is drawn until the tiles commit (5 s here, from cache): the vector massing was the quick first paint before. On an uncached place the viewport stays empty longer.
- The build still degraded for reasons outside this change: every survey image failed to fetch ("fetch failed"), and the scan fit exceeded its 30 s limit (`fit_rejected`).
- `trees: true` is still sent by the button and the trees stage still runs for an isolate.
- The Browser pane's screenshots showed a stale frame (the chat stuck at "Google 3D Tiles — running (0s)") for about two minutes while the run had already finished; a later screenshot showed the finished scene. Check the run record (`.scratchbox/cache/staged_location/runs/<runId>/timeline.jsonl`) before reading a frozen UI as a hang.

## Candidate Tool/Service Ideas

- A read-only endpoint for a staged run's stage statuses by `runId` (what `timeline.jsonl` holds), so a live check need not read the cache folder.
