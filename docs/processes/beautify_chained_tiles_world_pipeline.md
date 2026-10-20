# Beautify-chained textured-tiles world — a movement pipeline

**Date:** 2026-10-20
**Status:** scoping, not yet built
**Depends on:** `docs/processes/beautify_chain_service_spec.md` (not yet built either — this pipeline is written against that service's contract, not a reimplementation of its logic)

## What this is, in one sentence

An explorable world a user can walk, run, or fly through continuously, built by chaining `BeautifyStationService`-style generated renders along the user's path, with every single station anchored to real, live-captured Google 3D Tiles texture — not a reconstruction of photographed reality, but a geometrically-honest, QC'd, *styled* rendering of real places.

## This is NOT the Street View reconstruction pipeline

`docs/processes/streetview_create_a_world_plan.md` is a different pipeline, for a different experience: real Street View photos → measured depth → metric Gaussian splats. That world is "the real place" — walkable because it's physically measured. This pipeline produces a different thing: a styled, generated rendering of real geometry — walkable because it's geometrically QC'd against real geometry, not because it's photographed. They happen to share some tools (`BeautifyStationService`, Google 3D Tiles fetch, the Beautify Chain Service once it exists), but they are two separate pipelines with two separate outputs. Do not merge them or treat one as a fallback tier of the other.

## Core technique

For every pose along the user's path (walking, running, or flying — direction and speed only change lookahead distance, not the technique):

1. Capture a **real, textured** render of Google 3D Tiles geometry at that exact pose.
2. Build a pose-locked Beautify prompt from that pose's camera facts (`buildStationBeautifyPrompt` already does this).
3. Generate a styled image via the Beautify Chain Service, anchored to the real textured capture from step 1 as a reference (not grey clay — see "Why textured, not clay" below).
4. QC the result against the real mesh geometry. On failure: no rerolls — fall back to the real capture itself, queue a background regeneration, swap it in later if it passes.

## Why textured, not clay

`BeautifyStationService` already supports this — `renderMode: 'textured'`/`'albedo'` runs a full C++20 BVH path tracer with real PBR texture decoding against the actual tile mesh (`SurveyStationRenderService.ts`, `renderStation`, around line 189-194), not grey clay. Anchoring every generated station to real texture (not an untextured blockout) does two things at once: it gives the generator real material/color to match instead of inventing it from nothing, and it re-anchors every link in the chain to ground truth — fixing the drift problem a pure neighbor-to-neighbor generated chain would otherwise accumulate over a long walk or flight, since every station checks against something real, not just against whatever the previous station happened to generate.

## Why JavaScript capture, not the native path tracer, for this pipeline specifically

This pipeline needs the **fastest possible load with still-high FOV detail**, because stations are being produced live as the user moves, not offline for a one-off hero shot. The native C++20 BVH path tracer (`SurveyStationRenderService`'s `albedo` mode) is accurate but is a subprocess round trip per station — too slow for a live movement loop.

This codebase already has the faster path, proven and in production use: `Google3DTileBlockoutPipelineService.ts` runs a headless-Chrome + `3d-tiles-renderer` (live WebGL) capture loop, with a `TilePipelineMode`/`TileAtmosphereRenderMode` of `'textured'`/`'full-texture'` already implemented (not just the `'clay'` mode its name suggests), and already enforces leaf-LOD streaming (`errorTarget <= 0.5`) before treating a frame as ready. This is the mechanism to reuse for this pipeline's per-station capture: the tiles are already resident in a live WebGL viewport for display anyway, so a station capture is a frame grab from that viewport at the user's current pose, not a fresh offline render.

**One real tension to resolve, not ignore:** "fastest load" and "high level of detail" pull against each other if LOD hasn't settled yet. `Google3DTileBlockoutPipelineService` already gates on `stats.downloading === 0 && stats.parsing === 0` before capturing — this pipeline needs the same settle gate per station, even in the fast path, or "fast" quietly means "captured a blurry coarse-LOD frame." Capturing before settle defeats the FOV-detail requirement; this needs to be an explicit wait, not an assumption that JS capture is automatically both fast and detailed.

**What's intentionally given up by using JS capture over the native path tracer:** proper path-traced PBR lighting. That's an acceptable trade here, not just a speed compromise — Beautify is going to restyle lighting anyway per the chosen style/mood, so the anchor only needs to be geometrically and chromatically correct (right shapes, right base colors, right silhouette for QC), not already beautifully lit. The native path tracer's extra lighting fidelity would be wasted work for this specific role.

## Beautify prompt reliability

The existing `buildBeautifyPrompt`/`buildStationBeautifyPrompt` template is treated as a solid, already-proven foundation for this pipeline — not an open risk to re-litigate. The remaining risk in this pipeline is upstream of the prompt: the *input* texture quality, not the prompt that describes it.

## Known upstream risk: raw tile texture isn't pristine

Google's own photogrammetric texture has known defects this codebase already has tooling for — melting, false curtain walls, grazing-angle stretching (UTDRA/ULDRA exists specifically to rectify these). If every station anchors to raw tile texture, those defects propagate into every generated frame. This pipeline should run UTDRA rectification upstream of the per-station capture where applicable (vertical facades, bridges), and should track anchor-pixel trust using the existing `TexelProvenance` confidence system from the staged-location-texture-pass work rather than inventing a new confidence scheme.

## Error handling: no rerolls

Explicitly rejected for this pipeline: reroll-on-QC-failure. Rerolling multiplies image-model calls (2-3x per failed station) on the critical path of a live, continuously-moving experience — unacceptable latency at walking speed, let alone running or flying.

Instead, per the Beautify Chain Service's `fail-into-anchor-async-reglaze` error policy:
1. On QC failure, show the real textured-tiles capture for that station immediately (un-stylized, or a cheap deterministic color-grade) — never wrong geometrically, zero added latency.
2. Queue a background regeneration for that station.
3. Swap in the styled result later, if/when it passes QC, the same way a game streams in a higher LOD after the low one has already displayed.

This pipeline is the primary justification for building that error policy into the Chain Service — it is this pipeline's hard requirement, not a nice-to-have.

## Movement modes and geometry source

Google 3D Tiles is the only geometry source this pipeline uses — it is vertically unbounded by this codebase's own extraction rules ($Y_{\max} = +\infty$), so it covers ground-level walking, running, and aerial flight from one dataset, unlike Street View (ground-level only, discrete captures). Speed changes only the prefetch lookahead distance the caller requests from the Beautify Chain Service's path — walking needs a short lookahead, running more, flying the most and in full 3D rather than along a 2D route.

## Restyling

Style is a parameter the caller passes into each station's prompt build, not a global state this pipeline owns. Switching style mid-session should invalidate/regenerate stations going forward from that point (lazily, on next approach) rather than forcing a full-world redo, and the point of switch is a real seam that should be visible/consistent-locked rather than silently blended.

## Interface this pipeline expects from the Beautify Chain Service

See `beautify_chain_service_spec.md` for the full contract. This pipeline's specific usage:
- `referencePolicy`: real-anchor every station (`anchorEveryN: 1`, `useRealAnchor: true`), neighbor-warp also on for local lighting continuity.
- `errorPolicy`: `fail-into-anchor-async-reglaze`.
- `contentForPose`: this pipeline's own function, wrapping the `Google3DTileBlockoutPipelineService` headless JS capture with the leaf-LOD settle gate described above.

## Open questions / risks

- **Settle-gate latency under motion:** if leaf-LOD settle takes longer than the user's current speed allows for lookahead, detail has to degrade gracefully (coarser LOD shown, refined later) rather than blocking movement — needs an explicit policy, not implicit hope.
- **UTDRA cost on a live path:** rectifying every station's input tile geometry in real time may not be feasible; likely needs precomputation/caching per region rather than per-station, especially for flight paths covering wide areas.
- **Async reglaze swap-in UX:** when a station upgrades from real-anchor-fallback to styled-generated mid-session (the user may have already passed it, or be looking right at it), the visual pop needs a transition plan, not an instant swap.
- **Provenance labeling at scale:** every station in this pipeline is generated content over real geometry, by design — this needs to be clearly and consistently surfaced, especially since a user could revisit a station and see a different (now-regenerated) result than what they saw on first pass.
