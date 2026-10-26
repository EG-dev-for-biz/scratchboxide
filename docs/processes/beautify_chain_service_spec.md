# Beautify Chain Service — standalone capability spec

**Date:** 2026-10-20
**Status:** scoping, not yet built
**Owner surface:** neutral — not part of any one pipeline

## Problem this solves

`BeautifyStationService.beautify()` (`packages/core/src/node/spatial/BeautifyStationService.ts`) already does the hard part well: render a station from a known pose, build a pose-locked prompt, generate, QC by closed-loop edge alignment against real mesh geometry, reroll on failure. But it operates **one station at a time**. Chaining — deciding what the next station's reference should be, carrying consistency state forward, tracking drift across a sequence — currently lives nowhere as a reusable thing. It's implicit in how a caller happens to pass `options.reference` from one call to the next.

At least three real consumers need this same chaining logic, independently:

1. **The existing architecture-survey pipeline** (`BeautifyStationService` callers today) — already does this informally, station by station.
2. **Street View Tier 1 multi-pano fusion** (`docs/processes/streetview_create_a_world_plan.md`, Part 3) — real neighbor panoramas registered and chained together as a user walks/runs along a street graph.
3. **The Beautify-chained textured-tiles movement pipeline** (`docs/processes/beautify_chained_tiles_world_pipeline.md`) — stations generated along a walk/run/fly path over Google 3D Tiles geometry.

Three different callers, same underlying need (ordered poses → consistency-locked, QC'd sequence of generated or real-anchored content). Building it three times means three different drift behaviors, three different error strategies, and no shared place to fix a bug in the chaining logic itself. This spec pulls it out once.

## What this service owns

Given an **ordered list of camera poses** (a path — survey route, street-graph walk, or a flight trajectory) and, per pose, a **content source** the caller already has (a real photo, a real-textured render, a clay render — this service doesn't care which), produce an ordered, consistency-locked, QC'd sequence of station results.

**Inputs (conceptual, not a final interface):**
- `path: StationPose[]` — ordered poses to walk.
- `contentForPose: (pose) => StationContent` — caller-supplied function or pre-fetched array giving this service the render/photo to work from at each pose. The service does not fetch geometry or call Google 3D Tiles / Street View itself — that stays with the caller, per pipeline.
- `referencePolicy: { anchorEveryN?: number; useRealAnchor?: boolean; useNeighborWarp?: boolean }` — how each station composes its reference image(s): chain to the immediately preceding accepted station (`useNeighborWarp`), anchor to the caller-supplied real content every station or every Nth (`useRealAnchor` + `anchorEveryN`), or both at once (recommended default: both, every station, per the textured-tiles pipeline's decision to always anchor to real texture).
- `errorPolicy: 'reroll' | 'fail-into-anchor' | 'fail-into-anchor-async-reglaze'` — what happens when a station's QC fails. Different callers may want different policies (the textured-tiles pipeline explicitly wants `fail-into-anchor-async-reglaze`, not reroll; the survey pipeline may still want `reroll` for one-off hero shots where latency doesn't matter).

**Outputs:**
- Ordered list of accepted station results (image, QC score, which policy branch it resolved through).
- Per-station confidence/provenance (did this pixel come from a real anchor, a generated station, or a pending-reglaze placeholder).
- A list of any queued async re-generation jobs (for `fail-into-anchor-async-reglaze`), so a caller can swap results in later without the service owning a job queue itself.

## What this service does NOT own

- **Geometry/content acquisition.** It never calls Google 3D Tiles, Street View, or any renderer directly. Callers hand it renders; this is purely the chaining/consistency/QC/error-policy layer on top of `BeautifyStationService`.
- **When to walk the chain.** Prefetch timing, velocity-scaled lookahead, "the user just turned left" — all pipeline-specific, stays with the caller.
- **Style selection.** The prompt/style a caller wants is theirs to build (via `buildBeautifyPrompt` / `buildStationBeautifyPrompt`) and hand in per station; this service only decides *which reference images* go with the generation call, not what's asked for.

## Relationship to `BeautifyStationService`

This is a thin layer *on top of* `BeautifyStationService.beautify()`, not a replacement. It composes calls to it (one call per station, with the reference(s) this service's policy decides to pass) and adds: chain-level state (what was the last accepted station), chain-level drift tracking (cumulative QC score trend across a long sequence, so a caller can tell if an unbroken generated chain is drifting even though each individual link passed), and the error-policy branching described above (`BeautifyStationService` itself only knows reroll — the `fail-into-anchor` branches are new logic this layer adds, not something to push down into the lower-level service).

## Why `fail-into-anchor` needs to live here, not in `BeautifyStationService`

`BeautifyStationService` has no concept of "the caller also has a real, trustworthy fallback image for this exact pose" — it only knows how to retry its own generation. The chain service is the first layer that has both: the generated attempt *and* the real anchor content the caller supplied. So "if QC fails, show the real anchor instead of a bad generation" can only be decided at this layer.

## Real-world evidence (2026-10-24) and a related alternative

`docs/processes/beautify_consistency_and_character_sheet_2026-10-24.md` (landed on `main`: `6ac37dc8`, `3605f803`, `2b8e81d6`) measured exactly the mechanism this spec is built on, in production use ahead of this service existing: `BeautifyStationService`'s existing neighbour-warp chaining (`options.reference`) held colour within ΔE 2.6 across 3 Haughwout views, against ΔE 9.7–16.4 unchained — even though the warped reference covered only 10–14 % of each next frame. That is strong support for `referencePolicy.useNeighborWarp` as a default, not just a nice-to-have.

The same work also shipped a related but different tool: a "character sheet" (`building-character-sheet.ts`) — four station views of one structure composed into a single 2x2 sheet, made photorealistic by one 4K Nano Banana 2 call, then split back into station frames, each checked against its own outline. For a small, *fixed* set of views of one bounded subject, this gets the same cross-view consistency in one call, with no chaining logic at all. It does not substitute for this spec's chain service: it needs the view count fixed in advance and the subject to fit one sheet, so it has nothing to say about an open-ended walk/run/fly path or a street-graph fusion sequence, where the number of stations is not known up front. Treat it as a sibling tool for the "small fixed set of views" case, not as this spec's replacement.

Also from the same commits: `buildStationBeautifyPrompt` now defaults to even, shadowless lighting (no sun clause) because its typical caller feeds 3D reconstruction (splat/texture bakes), where a baked-in sun does not transform away cleanly; `lighting: 'scene'` restores sun and mood for a caller whose station image is itself the deliverable. This chain service composes prompts through the same function, so a caller building a user-facing styled sequence (not 3D-feeding) must pass `lighting: 'scene'` explicitly — the new default is wrong for that case. This is exactly the kind of caller-supplied style parameter `referencePolicy`/prompt-building already leaves to the caller (see "What this service does NOT own"); it is called out here because the default direction just changed under it.

## Open design questions

- **Interface shape:** function-returning-async-generator (stream stations as they resolve, good for a live-moving user) vs. batch call (resolve a whole prefetched segment, simpler but blocks on the slowest station). Given the movement pipeline's "don't block on generation" requirement, a streaming/generator shape is likely the right default — worth deciding before writing code, not after.
- **Where it lives in the tree:** alongside `BeautifyStationService.ts` in `packages/core/src/node/spatial/`, since it's a peer/wrapper of that service, not owned by either pipeline that consumes it.
- **Migration of the existing survey pipeline:** not required for either new pipeline to ship — existing callers can keep calling `BeautifyStationService` directly and adopt this layer later, once it exists and is proven on the two new pipelines.

## Explicitly not in scope for this spec

Building either of the two consuming pipelines. This is the shared dependency both of them should be written against; see each pipeline's own plan doc for what it does with this service once it exists.
