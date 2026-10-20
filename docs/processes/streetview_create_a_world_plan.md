# "Create a World" — Street View → explorable 3DGS world

**Date:** 2026-10-19
**Goal:** Reproduce the Mint (`mint.gg/create`) experience — browse a real-world Street View panorama, hit one action, get an explorable Gaussian-splat 3D world in-browser — using Scratchbox IDE's existing native pipeline, with the two pieces that don't exist yet: a single orchestrating tool, and the UI that drives it.

## What already exists (verified in this repo, not assumed)

The full geometry/splat pipeline is already built. Nothing new is needed here:

- `maps_imagery_grounding_pano` (`packages/core/src/node/gemini/tools/spatial-tools.ts:1771`) — grounds a landmark prompt, a `panoId`, or `lat`/`lng` to official Google Street View imagery via Vertex AI Maps Imagery Grounding, and projects it to a true 2:1 equirectangular PNG on disk. This is the panorama *fetch* step — it already returns a real 360 pano, not a single-FOV crop.
- `streetview_grounding_image` (same file, `:1755`) — the redacted single-image variant, for when only one grounded frame is needed.
- `panorama_to_3dgs` (declared `:1419`, handler `:2490`) — the full depth → offset-view synthesis → splat fusion pipeline. Takes `inputImagePath` (an equirect panorama) + `eyeHeight`, runs `PanoramaDepthService` (Depth Anything V2, floor-fit to eye height) then `OffsetViewSynthesisService`, and returns `fusedSplatPath` / `fusedSpzPath`.
- `mount_canvas_primitive` (`canvas-tools.ts:52`, payload handling `:401`) — the 3d-scene payload already accepts `splatUrl` directly, so a fused splat can be mounted into a live, explorable viewport with no new rendering code.

So the chain `pano fetch → depth → splat → viewport` is real end to end. What's missing is purely **integration and UI**.

## Scope of this plan

**In scope:**
1. One new orchestrator tool that chains grounding → `panorama_to_3dgs` → a ready-to-mount scene payload, in a single call.
2. A "Create a World" UI: a prompt/location box plus a live Street View pane, wired to that orchestrator, that mounts the result into the existing splat viewport.
3. A boundary-extension strategy so the walkable world doesn't dead-end at a single panorama's ~1.25m offset ring (see Part 3).

**Out of scope (explicitly deferred, not forgotten):**
- The pure-text-prompt world path (no real location) — that's the separate `AdaptiveDomainEngine` ADA pipeline and needs no Street View work at all.
- Any new depth model, splat format, or rendering engine — `PanoramaDepthService` / `image-to-splat-service` / `PhotorealGaussianSplatMesh` stay untouched.
- A standalone mobile app or a `mint.gg`-style separate product — this stays inside Scratchbox IDE's existing canvas/agent surface.
- Multi-location "world hopping" or saved galleries — single-session, single-world generation only, for v1.
- Running AI Beautify (`buildBeautifyPrompt` / `BeautifyStationService`) on the *source* Street View panorama before depth extraction — considered and rejected: depth estimation reads real photometric cues the generative repaint would corrupt (synthetic haze/DOF directly fight the depth model's own cues), equirectangular seam/pole handling isn't what Beautify is built for, and `BeautifyStationService`'s geometric QC loop needs a known mesh to verify against — which doesn't exist yet at the pre-depth stage, since depth *is* the thing being produced. Beautify's real strength (render-from-known-pose → generate → QC-against-that-pose's-mesh) only applies once real or extension geometry already exists — see Part 3.

## Part 1 — Orchestrator tool

**Name:** `streetview_to_3dgs_world`
**Location:** `packages/core/src/node/gemini/tools/spatial-tools.ts`, alongside the panorama tool family (declared in `PANORAMA_TOOL_DECLARATIONS`, handler in `panoramaHandlers`).

**Inputs:**
- `prompt` (string, optional) — natural-language landmark text (e.g. "Dotonbori, Osaka"), forwarded to `maps_imagery_grounding_pano`.
- `panoId` (string, optional) — direct Street View pano ID, when the UI already has one (the user is live-browsing a specific pano).
- `lat` / `lng` (number, optional) — alternative to `panoId`.
- One of `prompt` / `panoId` / `lat`+`lng` is required — same validation `maps_imagery_grounding_pano` already does, so this tool just forwards and lets that call fail with its existing error if none are given.
- `eyeHeight` (number, optional, default `1.7`) — forwarded to `panorama_to_3dgs`. Surfaced as an argument (not hidden) because AGENTS.md requires the floor-fit height to be explicit, never invented.
- `radius`, `numPoses`, `voxelSize`, `skipOffsets` (optional) — passthrough to `panorama_to_3dgs` for callers that want to trade quality for latency (e.g. a fast preview pass with `skipOffsets: true`, then a full-quality regenerate).
- `canvasWidth` / `canvasHeight` (optional) — passthrough to the grounding call's ERP canvas size.

**Flow:**
1. Call `maps_imagery_grounding_pano` (or reuse its service directly rather than round-tripping through the tool layer) with the location args → get the equirect panorama path + grounding metadata (`panoId`, capture date, lat/lng).
2. Call `panorama_to_3dgs` with that panorama path + `eyeHeight` (and the passthrough options) → get `fusedSplatPath` / `fusedSpzPath` + pipeline stats.
3. Build a `Scene3DData`-shaped payload with `splatUrl` set to the fused splat, plus a `geoAnchor` carrying the grounded lat/lng so the world can later be re-anchored against Google 3D Tiles if asked.
4. Return both the raw pipeline stats (depth model, floor-fit scale, splat counts, grounding pano ID/date) **and** the ready-to-mount payload, so the caller can hand the payload straight to `mount_canvas_primitive` without reshaping it.

**Error handling:** no new failure modes — propagate whatever `maps_imagery_grounding_pano` or `panorama_to_3dgs` throw verbatim (missing API key, no pano at that location, depth model failure, image model refusing the inpaint size). This tool adds zero fallback logic, per the "never approximate / never silently substitute" directive — if either stage fails, the whole call fails with that stage's real error.

**Testing:** a service-level integration test that runs the real chain against a known Street View location (mock mode only for the depth sidecar in CI, exactly like existing `panorama_to_3dgs` tests use `mock: mockExecution`), asserting the returned payload has a valid `splatUrl` and non-zero splat count — not a mock-only `expect(spy).toHaveBeenCalled()`.

## Part 2 — "Create a World" UI

**Shape:** two-pane layout mirroring the screenshot — left: prompt box + mode toggle (location text / live pano browsing), right: the viewport (Street View pane *before* generation, splat viewport *after*).

**Build surface:** a `live-code-sandbox` app using `@scratchbox/core` exports (`Google3DViewport` or the splat-mesh equivalent), not a new hardcoded primitive — per the Code-First directive, bespoke UI shells belong in the sandbox, consuming the platform as an SDK.

**State machine:**
- `idle` — prompt box empty, right pane shows nothing or a default map search.
- `browsing` — user has typed a location or navigated Street View; right pane shows the live pano (existing `getEmbedMapUrl({ mode: 'streetview' })` or a Street View JS panorama, for *browsing only* — this is separate from the grounded-pano fetch used for generation).
- `generating` — user hit the generate action; call `streetview_to_3dgs_world` with either the typed prompt or the `panoId` the user was just looking at (so "generate what I'm looking at" and "describe a world" are the same tool, just different args). Show pipeline progress from the tool's own stats (depth → offsets → fusion) rather than a fake progress bar.
- `ready` — mount the returned payload via `mount_canvas_primitive`; swap the right pane from the Street View embed to the live splat viewport.

**Why `panoId` matters here:** the UI's live Street View pane already knows the exact `panoId` the user is looking at (Street View JS exposes it), so "View World" should pass that `panoId` straight to the orchestrator — not re-geocode from a typed address — to guarantee the generated world matches the pano on screen.

## Part 3 — Boundary extension beyond a single panorama

A single `panorama_to_3dgs` call only covers one capture's offset-synthesis ring (~1.25m by default). A user who walks past that boundary hits either a void or (per the earlier Beautify discussion) a last-resort generative extension. Real neighboring Street View captures should be preferred over generation wherever they exist — this is the same measured-over-generated priority the rest of this codebase already enforces (`AGENTS.md`'s photo-inferred/generated provenance rules). Three tiers, in priority order:

**Tier 1 — real neighbor-pano prefetch + registration (preferred; requires new work).**
- **Gap confirmed in this codebase:** there is no Street View link-graph lookup. `StreetViewGroundingImageService.findGooglePano()` only does a coordinate ring search (0m/25m/50m/100m, nearest capture) — it doesn't read Street View's own `links` field (connected neighbor panoIds + headings), which is what a real street graph needs. **New capability required**, not just new wiring.
- Once a neighbor pano is found, run it through the same `panorama_to_3dgs` pipeline independently.
- **Registration is not free:** each pano's splat is only internally metric (its own per-pano floor-fit). Placing two splats purely by GPS coordinates will not align cleanly — Street View GPS is accurate to a few meters, and each capture's floor-fit can drift independently, so a naive placement shows doubled geometry or a misaligned floor seam at the join.
- **Correct tool for registration, already in this codebase:** `SpatialPoseEstimatorService` (`solvePnP`/`solvePnPRansac`) + `VisualFeatureMatcherService` — real 2D/3D feature matching and pose resection between the two overlapping real photographs. This is geometric registration of two ground-truth captures against each other, not generation, and it's the same machinery the matchmove/resection pipeline already uses elsewhere.
- **Prefetch strategy:** full per-pano cost (depth + offset-view synthesis + Gemini disocclusion inpainting) means prefetching every direction around the user is wasteful. Prefetch directionally — 1-2 panos ahead of the user's current viewing/walking direction, streamed in like a game engine's next-chunk loading — not the whole radius up front.

**Tier 2 — lighting/atmosphere harmonization (already built, just needs wiring here).**
- Neighboring real captures are often shot on different dates (season, weather, time of day), so even correctly registered they can look visually mismatched at the seam.
- `geobox_harmonize_location_lighting` (`LocationObjectLightingService`) is a **relighting pass on real reconstructed geometry** — not a repaint of the surface itself — and is the right tool to harmonize fused neighbor captures to one consistent atmosphere.

**Tier 3 — Beautify-based generative extension (fallback only, for genuine gaps).**
- Only reached where Tier 1 finds no real coverage at all — off-road locations, interiors, plazas, courtyards, sparse/no Street View coverage.
- Uses the pattern from the earlier Beautify discussion: render the clay blockout of real Google 3D Tiles massing at the gap, beautify it through `BeautifyStationService` with a consistency-lock reference to the adjoining real (or Tier-1-fused) imagery at the seam, and QC it against that same real mesh — the one case where Beautify's closed-loop verification is actually usable, because real geometry exists at that point to check against.
- **Provenance requirement:** every pixel this tier adds must be labeled `generated`/`photo-inferred` per AGENTS.md's photo-read-detail rule. `BeautifyStationService`'s result type should be checked for whether it already threads that label through to splat/scene metadata — treat as an open gap, not an assumption, until verified.

## Step-by-step build order

1. Add `streetview_to_3dgs_world` tool declaration + handler in `spatial-tools.ts`, reusing the grounding and `panorama_to_3dgs` logic already present (call the underlying services directly to avoid a tool-calling-a-tool layering issue — check whether `panoramaHandlers` entries are callable as plain functions or need to go through the dispatcher).
2. Write the integration test for it (mock depth sidecar, real grounding call against a fixed test location or a recorded fixture).
3. Confirm `mount_canvas_primitive`'s `Scene3DData` payload shape precisely (already read partially above — need the full `isDrawableSceneObject` / payload interface before step 4) so the orchestrator's returned payload is mount-ready with zero UI-side reshaping.
4. Build the `live-code-sandbox` two-pane app: prompt box, Street View embed pane, generate action, splat viewport swap.
5. Wire state machine + the tool call.
6. Run it live via the `operate-scratchbox` skill, screenshot each state (`idle`, `browsing`, `generating`, `ready`) per the Visual Progress directive, confirm the mounted splat world is actually explorable (not a static 360 photo).
7. Run the `visual-critic` 8-dimension rubric pass on the `ready` state screenshot before calling it done — a cotton-ball or void-background result fails here, not just "did it render."
8. (Part 3, Tier 1) Build the Street View link-graph lookup — the confirmed missing piece — then wire directional neighbor prefetch + `SpatialPoseEstimatorService` registration once a user approaches the single-pano boundary.
9. (Part 3, Tier 2) Wire `geobox_harmonize_location_lighting` over fused neighbor captures before mounting them.
10. (Part 3, Tier 3) Only after 8-9 are in place, add the Beautify-based clay-extension fallback for genuine no-coverage gaps, with provenance labeling verified end to end.

## Open questions / risks to flag before building

- **Cost/latency:** `panorama_to_3dgs` calls a Gemini image model for disocclusion inpainting on every non-`skipOffsets` generation — a live "type and wait" UI needs a fast preview (`skipOffsets: true`) path distinct from a slower full-quality regenerate, or users will stare at a spinner for a full multi-pose inpaint on every keystroke-driven request.
- **API key dependency:** both `maps_imagery_grounding_pano` (Vertex AI MIG) and the depth/splat pipeline need keys configured; the UI needs a clear "not configured" state, not a silent failure.
- **`eyeHeight` UX:** the pipeline requires an explicit eye height for correct metric scale — defaulting to 1.7m silently is fine for street-level Americans/Europeans on foot, but worth a one-line disclosure in the UI rather than hiding it entirely, since AGENTS.md treats invented scale as a correctness violation.
- **Not yet confirmed:** whether `panoramaHandlers['panorama_to_3dgs']` and `['maps_imagery_grounding_pano']` can be invoked as plain async functions from inside another handler, or whether they're only reachable through the Gemini tool-calling dispatcher — this decides whether the new tool calls the underlying services directly (cleaner) or re-enters the handler map (simpler but layering-odd). Resolve this first, before writing the handler.
- **Part 3, Tier 1 is the biggest unknown in this whole plan.** It requires a genuinely new capability (Street View `links` graph traversal) that nothing in this codebase does today — treat it as its own spike, not a subtask of the orchestrator tool.
- **Registration accuracy is unverified.** Whether `SpatialPoseEstimatorService`'s feature-matching accuracy is good enough on two independently-floor-fit splat reconstructions (vs. its proven use cases, which register a photo against known mesh geometry) needs a real test before committing to Tier 1 as the default path.
- **Tier 3 provenance labeling must be confirmed, not assumed,** before any Beautify-based extension content is mounted into a world a user can walk into — an unlabeled generated patch presented as the same world is exactly the kind of silent substitution AGENTS.md prohibits.
