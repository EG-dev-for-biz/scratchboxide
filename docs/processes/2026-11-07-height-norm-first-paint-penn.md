# Height norm and volume dedup in the first paint at Penn Station (2026-11-07)

**Status: Verified.** The duplicate fix is kept as the only path. The height norm was measured and removed: it did not beat 12 m on real unmeasured footprints.

## What was tested

- **Branch:** `claude/serene-spence-a4181c`.
- **Code at the run:** commit 372bfc28 (`height-norm.ts`, `applyHeightNorm`, `VECTOR_VOLUME_DUPLICATE_SHARE`). The PR keeps only the duplicate fix.
- **Research:** `docs/research/2026-11-07-architectural-norms.md`.

## How

1. **App instance:** my own launch entry `scratchbox-height-norm`, on web 4510, API 4511 and tools 4512, with `SCRATCHBOX_CACHE_RESTORE=off`. The workspace's stage caches were deleted before the run, keeping only `runs/`.
2. **Chat request:** "Stage the whole Penn Station district around 7th Ave & W 32nd St (2 Penn Plaza, New York) … isolate false, radius 300 m, district as massing."
   - The first wording, without "isolate false", was routed as an isolated building.
   - Opening the app also restarted the "recover missing files" rebuilds of two old chats (an ESB K build and a Penn isolate). These jobs have no list or cancel route, so they were stopped by restarting this instance.
3. **Run 53fcfbec:** uncached (`cached: false` on every stage). The norm was switched on for this run, since it was the default at the time.

## Evidence

- **Vector first paint:** committed at +8.8 s with 50,930 triangles and 185 buildings in 300 m.
  - Norm fitted on 720 measured footprints: leave-one-out error 21.9 m, against 39.9 m for 12 m.
  - 109 2D-only footprints under another feature's modelled volume left out.
  - 4 real gaps estimated, at 7.7, 18.4, 33.7 and 46.4 m.
  - The 46.4 m one is 1,077 m², and the Solar DSM puts it at 2.8 m (street level). This failure is why the norm was removed.
- **Vector stage:** went degraded at its 120 s limit while waiting on the tiles, after its own layer had committed.
- **Tiles stage:** failed at its 360 s limit ("No Photorealistic 3D Tiles could be extracted … the stage reached its time limit"). The load average was about 60 from other sessions' work. This is a separate issue and was not retried.
- **Offline checks:**
  - Leave-one-out in 7 cities.
  - Solar DSM truth on 110 real unmeasured footprints in 4 cities: 27 Solar calls, under $3.
  - Vitest: 10/10 in `vector-first-paint-believability.test.ts`, on the final code.
  - Duplicate fix before/after at Penn (300 m): generated buildings 109 → 4, triangles −16%, GLB −18%, native build 1.9 → 0.6 s.
  - `tsc -p packages/core` clean.
- **Sheets:** `docs/screenshots/height_norm_2026-11-07/data-sheet.png` and `app-run.png` (gitignored).

## Candidate Tool/Service Ideas

- **A list route for asset-recovery jobs** (`GET /assets/recover`): with it, a test instance can see and cancel rebuilds the page started for other chats' missing files. Here they started ESB and Penn K builds unasked.
- **A measured existence gate for unmeasured footprints:** check the Solar DSM, or the scan where it reaches, before drawing any guessed height. Where nothing stands above the street, draw nothing (or a slab at street level), labelled `measured`.
- **A per-building provenance record in the first paint's GLB:** each estimate's band and confidence. Today one layer-level record covers every guessed building.
