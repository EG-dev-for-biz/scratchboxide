# How fast a real place builds with default settings (2026-10-20)

**Date:** 2026-10-20
**Status:** Verified (9 live chat builds of 4 places, cold and warm, on `origin/main` `3c99f63c` plus timing logs only). After: see "After: fast first (branch `staged-fast-first`)" below (8 more live builds, the same 4 places).

## What was measured

A normal chat request, `Build a 3D scene of <place>`, typed into the app with no special environment flags. The chat
model chose the tool arguments itself. Times are counted from pressing Enter.

- **Server times** come from a new per-run timeline, `runs/<runId>/timeline.jsonl` (see "Instrumentation").
- **Viewport times** come from a page poller. Every 500 ms it counted the visible, opaque triangles of each staged layer,
  and of textured meshes, in `window.__SB_3D_EXTERNAL_OBJECTS__`.
- **Viewport cost** comes from `?sbViewportCost=1`, using `breakdown()` and `measure()` (GPU timer query).

**Pipeline that ran:** the current staged pipeline (resolve → tiles → trees-measure → remesh → grammar, fit/rebuild,
trees → evidence → textures). Pipeline E did not run: it still needs `SCRATCHBOX_STAGED_PIPELINE=e`, and every panel
showed "Measured relief skipped (… SCRATCHBOX_STAGED_PIPELINE=e)".

**Setup:**
- Worktree `.claude/worktrees/build-speed-benchmark`, launch entry `scratchbox-build-speed-benchmark`, ports 3850/3851/3852.
- `SCRATCHBOX_HOME` was an isolated scratch directory. `secrets.json` was symlinked for the runs and removed afterwards.

**Cold:**
- The worktree had no `.scratchbox` stage cache, no tile leaf cache (`desktop-app/.scratchbox/tiles_cache`) and an empty
  `SCRATCHBOX_HOME`.
- Every place was built for the first time.
- Native binaries were **warm**: tile_refine, tile_vegetation and scan_fit came from the shared native build cache, ready
  in 0.0–0.1 s. The first server start rebuilt the `scratchbox_native` Python module in 32.7 s, which is not on the
  staged path.

**Warm:** the same request again in a new chat.

**Build type the model chose:**
- Haughwout and Washington Square Arch were built as **isolated structures** (`isolate: true`, 25 m extraction).
- The Flatiron District, using the app's own "3D Scene" starter prompt, and the Colosseum were built as **districts**
  (250 m radius, trees).

## End-to-end timeline (seconds from Enter)

| Run | Tool starts | First 3D (L1 scan) | First clay building | Trees | First textured | Build finished | Chat reply done |
|---|---|---|---|---|---|---|---|
| Haughwout cold #1 (before the breakdown logs) | 9.0 | 14.2 | 109.1 | none (isolate) | 229.6 (l2g) | 229.1 | 254.4 |
| Haughwout cold #2 | 7.3 | 10.0 | 87.0 | none | 131.5 (l2), 184.0 (l2g) | 183.8 | 233.3 |
| Haughwout warm | 7.8 | 8.9 | 10.9 | none | 51.4 | 52.1 | 77.4 |
| Washington Sq Arch cold | 9.7 | 11.9 | 51.9 | none | 57.9 (fitted l3b) | 107.0 | 165.9 |
| Washington Sq Arch warm | 8.0 | 8.9 | 8.9 | none | 12.8 | 10.9 | 35.3 |
| Flatiron District cold | 8.1 | 15.5 | 53.1 | 56.0 | **never** (texture pass skipped for districts) | 282.0 | 305.7 |
| Flatiron District warm | 10.9 | 13.9 | 13.9 | 15.4 | never | 11.8 | 33.7 |
| Colosseum cold | 7.4 | 12.9 | 37.0 | 49.4 | never | 47.0 | 61.2 |
| Colosseum warm | 10.8 | 13.1 | 13.1 | 15.3 | never | 11.6 | 31.5 |

**Reading the table:**
- "Tool starts" is the chat model's routing time before the staged build begins: 7.3–10.9 s on every run.
- "Chat reply done" minus "Build finished" is the model's closing answer: 14–59 s.
- The first Colosseum warm attempt failed in the chat model with `fetch failed` before any tool call. It was sent again.

## Per-stage server times (cold)

### Haughwout #2 (run `f1a097ae`)

| Stage | Seconds | Breakdown |
|---|---|---|
| resolve | 0.2 | |
| tiles | 1.9 | 11 leaves, 30,659 triangles, 1.2 MB downloaded |
| trees-measure | 0.1 | |
| survey | 52.4 (alongside remesh) | 1 vision call, 44.8 s (first token 35.4 s, hedged) |
| **remesh** | **77.3** | ownership views 0.3 s; **ownership vision vote 76.2 s** (12 calls, median 13 s, slowest 76.1 s); tile_refine 0.7 s |
| grammar | 85.4 (alongside the rest) | 10 calls, 3.8–83.3 s, two of them 60.7 s and 83.3 s |
| fit | 0.6 | degraded: the gates failed, the remesh stands |
| evidence (Street View) | 5.9 | 4 panos |
| **textures** | **90.5** | prepare 3.1; Street View ownership 22.8 (6 locate-target calls 5.5–8.3 s); layer l2 11.8; **waiting for grammar 41.3**; layer l2g 11.6. Texel shares: tile photo 92%, palette 8%, **Street View 0%** |

### Washington Square Arch (run `91a2e6e4`)

| Stage | Seconds | Breakdown |
|---|---|---|
| tiles | 1.6 | 10 leaves, 35,590 triangles |
| survey | 4.9 | no Street View pano faces the arch today, so no survey and no evidence |
| **remesh** | **39.8** | ownership vote 38.9 s (12 calls 6.1–32.7 s: 11 done by 16.6 s); tile_refine 0.7 s |
| fit | 0.5 | committed: l3a, l3b, l3c, l3ch |
| figures | 0.0 | degraded |
| vision (ornament reading) | 53.9 | 13 streamed calls 4.1–39.9 s; 3 hedged at 25 s |
| detail | 0.7 | l4, 22,804 triangles |
| grammar | 28.9 | 10 calls 4.0–28.1 s |
| textures | 54.9 | layers 0.5 s in all; **waiting for the rebuild and grammar 51.7 s** |

### Flatiron District (run `514b7165`)

| Stage | Seconds | Breakdown |
|---|---|---|
| tiles | 6.4 | 524 leaves (the cap; 149 m of the 250 m), 1,488,958 triangles, 60 MB downloaded |
| trees-measure | 4.6 | |
| remesh | 32.8 | tile_refine (native) 32.4 s; 1,097,385 triangles |
| trees | 3.4 | 182,672 triangles (89 crowns) |
| **grammar** | **229.9** | vision pass 195.6 s (60 calls: 59 took 4.2–38.4 s, **one took 189.7 s**); refine with the grammar 31.8 s |
| textures | skipped | "the texture pass runs on an isolated structure" |

The server's main thread was blocked 14 times during the grammar stage, for 1.0–5.3 s each.

### Colosseum (run `88d8bda4`)

| Stage | Seconds | Breakdown |
|---|---|---|
| tiles | 4.7 | 375 leaves, 890,664 triangles, 40 MB downloaded |
| trees-measure | 6.4 | |
| remesh | 17.8 | tile_refine 17.6 s; 532,787 triangles |
| grammar | 3.3 | 0 calls |
| trees | 10.4 | 684,923 triangles |
| textures | skipped | |

### Warm tool times

| Place | Tool time | Notes |
|---|---|---|
| Haughwout | 44.2 s | Every stage cached except evidence (4.2 s) and textures (38.2 s). Street View images are fetched again by policy, so the texture pass redoes Street View ownership (24.0 s, 6 live calls) and both layers (11 s). |
| Washington Square | 2.9 s | |
| Flatiron District | 0.9 s | |
| Colosseum | 0.8 s | |

### Vision and image calls

| Run | Live vision calls | Image-model calls |
|---|---|---|
| Haughwout cold | 29 | 0 (the enhance rung ran its gate, about 0.23 s per layer) |
| Arch cold | 35 | 0 |
| Flatiron District cold | 60 | 0 |
| Colosseum cold | 0 | 0 |
| Haughwout warm | 6 (everything else replayed) | 0 |

The model was `gemini-4-argon` (Vertex). Per-call logs are in this session's scratch notes; the tail calls are the story.

## Critical path

### Isolated structure

The run is: resolve → tiles → [survey ‖ remesh] → [grammar ‖ fit → evidence → textures]. The first clay building waits
for the remesh. The remesh is about 1% tile_refine and 99% the multi-view ownership vote, which takes as long as the
slowest of its 12 vision calls (76 s at Haughwout, 33 s at the arch). The textured twin waits for:
1. the remesh;
2. the fit;
3. evidence (Street View fetch);
4. Street View ownership (23 s);
5. the bake.

The l2g twin also waits for the grammar's slowest call.

### District

The run is: resolve → tiles → trees-measure → remesh → [trees ‖ grammar]. Everything the user sees is on screen by
about 56 s, apart from l2g. The last 226 s of the Flatiron run were the grammar alone. Its finish was held by one
189.7 s call, which was never hedged: only streamed calls are hedged, and the grammar calls are not streamed.

## The floor: raw tile streaming

A standalone run of `getGoogle3DTilesFullTexture` used a fresh leaf cache and the build's radius. It gave:

| Place | Radius | Time | Leaves | Downloaded |
|---|---|---|---|---|
| Haughwout | 25 m | 1.17 s | 11 | 1.2 MB |
| Washington Sq | 25 m | 1.16 s | 10 | 1.4 MB |
| Flatiron | 250 m | 5.65 s | 524 (capped) | 60.2 MB |
| Colosseum | 250 m | 4.27 / 4.21 s | 375 | 40.1 MB |

The tiles stage inside the builds matched this (1.6–6.4 s), so tile streaming is already at its floor. The smallest
achievable time to first 3D is about chat routing (7–11 s) plus 1–6 s of tiles plus about 1 s of loading in the browser.
The measured 10–15.5 s is that.

## Viewport, once settled

| Scene | Triangles drawn | Draw calls | GPU ms (p50 / p95) | JS heap | Geometry |
|---|---|---|---|---|---|
| Haughwout (isolate, textured) | 9,534 | 1 | 0.16 / 0.18 | 58–71 MB | 1.5 MB + 22 MB textures |
| Washington Sq (isolate, textured) | 23,930 | 11 | 0.76 / 2.9 | 63–65 MB | 1.7 MB + 1.9 MB textures |
| Flatiron District (clay) | 1,198,277 | 179 (178 tree draws) | 2.4 / 4.5 (trees hidden: 1.8) | 212–233 MB | 99 MB |
| Colosseum (clay) | 868,105 | 691 (690 tree draws) | 10.1 / 22.8 (trees hidden: 1.5) | 348 MB | 96 MB |

Notes on the measurements:
- The rAF rate read 14 fps right after the Colosseum loaded and 53 fps once it settled.
- The Browser pane was sometimes hidden, so treat the rAF rate as indicative only. The GPU timer-query numbers are not
  affected.

## Speedups, ranked by estimated seconds saved (not implemented)

1. **Show the geometric isolate first and run the ownership vote afterwards.**
   - Commit tile_refine's isolate (0.7 s) as l2 straight away. Then supersede it with the voted remesh when the vote lands.
   - First clay building: about −75 s at Haughwout (87 → ~12 s) and −38 s at the arch (52 → ~13 s).
   - The fit, evidence and texture pass would also start about 40–75 s earlier.
2. **Hedge or limit the non-streamed vision calls (grammar, ownership vote, locate-target).** The chain hedges only
   streamed calls. Tail calls measured: 189.7 s against a median of about 13 s (district grammar); 83.3 s and 76.1 s
   (Haughwout); 32.7 s (arch).
   - Flatiron finish: −150 s (282 → ~130 s).
   - Haughwout: l2g and the finish about −60 s.
   - If item 1 is not done, the ownership vote about −50 s.
3. **Publish a textured twin from the tile photo first, before Street View.**
   - The tile photo gave 92% of Haughwout's texels and Street View gave 0%. Yet the twin waited for evidence (5.9 s),
     Street View ownership (22.8 s) and the bake.
   - A tile-photo bake of a layer takes about 4 s. Street View could then refine it in the background.
   - First textured: about −40 s cold (131.5 → ~92 s; with item 1, ~20 s) and about −38 s warm (51.4 → ~13 s).
4. **Let the texture stage commit without waiting for grammar or the rebuild.** The stage held its commit 41.3 s
   (Haughwout) and 51.7 s (arch) waiting for grammar or the rebuild. Its early layers stream, but the stage finish (and
   so "Build finished") waits for them. Run the late layers as their own follow-up: about −40 to −50 s to "finished" on
   isolates.
5. **Warm isolate runs redo the Street View work** (warm Haughwout tool time 44 s against 1–3 s elsewhere).
   - The derived ownership masks and texture bakes are keyed by image bytes that change on every fetch.
   - Keying the derived outputs by pano id and pose, never storing the image bytes, would save about −35 s warm. This needs
     checking against the "Street View image bytes are never cached" rule.
6. **Chat model overhead.**
   - Routing takes 7.3–10.9 s before the tool starts, on every run, warm included. It is the floor on warm runs.
   - The closing answer takes 14–59 s after the build finishes, because the tool result is long.
   - A lower thinking level for the routing turn, or a shorter result digest for the reply, is an estimated −3 to −6 s to
     first 3D and −10 to −30 s to "chat done". These are estimates, not measured.
7. **District grammar on the main thread.** There were 14 main-thread blocks of 1–5.3 s during the Flatiron grammar
   stage. They delay stage events and the server. Moving the ortho rendering and analysis to a worker would reclaim about
   30 s of blocked time (it does not shorten the stage).
8. **Viewport, Colosseum trees.** Trees take 690 draw calls and about 8.6 of 10.1 ms of GPU per frame. Instancing or
   merging the level-3 trees would save about −8 ms per frame. This affects frame rate, not build time.
9. **Nothing to gain in tile streaming.** The tiles stage is within 0.5 s of the raw fetch floor.

**Not a speed issue but found:** district builds (the app's own "3D Scene" starter) never get the texture pass ("the
texture pass runs on an isolated structure"). They stay clay, although new scenes are textured by default (AGENTS.md §4).

## Instrumentation added (behaviour unchanged)

- **`stage-timeline.ts`:** every stage event is appended to `runs/<runId>/timeline.jsonl` with epoch ms, ms since the run
  started, the stage timings and breakdown, and the committed layers with their triangles and bytes. It also logs one
  `[staged-timeline]` line. A failed write never reaches the run. Test: `staged-stage-timeline.test.ts`.
- **Remesh `breakdownMs`:** `ownershipViews`, `ownershipVision`, `tileRefine`, `tileRefineDistrict`.
- **Texture `breakdownMs` / `texture_timings`:** `step.prepareSources`, `workerWarmup`, `streetViewOwnership`,
  `temporaryCheck`, `layer.<id>`, `firstLayers`, `waitRebuildGrammar`, `lateLayers`, `redo`, `looLane`, `looTail`.
- **`[vision-call]` log lines:** stage, model, ms, first token, hedged, outcome, or replayed from the cache.
- **`[image-call]` log lines:** each enhance image-model call.
- Tests `staged-location-orchestrator`, `staged-e2e-integration`, `staged-stage-cache`, `vision-model-chain` and
  `staged-texture-pass-ladder` pass (62 tests).

## Evidence

Screenshots are in `test-results/screenshots/build_speed/` (gitignored): first visual, clay, textured or finished,
cold and warm, for each place.

## Candidate Tool/Service Ideas

- **`GET /api/staged/runs/:runId/timeline`:** serve `timeline.jsonl` with the per-stage breakdowns. Today the numbers are
  read from the cache directory.
- **A viewport milestone hook:** `window.__SB_STAGED_MILESTONES__` recording first-visible, first-textured and
  trees-visible per layer. This would replace the hand-rolled poller used here.
- **A `staged_build_benchmark` script:** the same request cold and warm against an isolated `SCRATCHBOX_HOME`, printing
  this table.

## After: fast first (branch `staged-fast-first`, 2026-10-20)

**Status:** Verified live (8 chat builds: the same 4 places, cold and warm, on worktree `.claude/worktrees/staged-fast-first`,
launch entry `scratchbox-staged-fast-first` on ports 3960/3961/3962, an isolated `SCRATCHBOX_HOME`; the cold set started
with no `.scratchbox` stage cache, no tile_refine cache and an empty home; native binaries warm). Tests: 10 new
(`staged-fast-first.test.ts`) and the staged suite.

### What changed

1. **Vector first paint.** A `vector` stage starts as soon as the place resolves, beside the tile download: Google's vector
   buildings for the whole requested area (vectortiles.featuretiles), each building's terrain height from the Elevation API,
   extruded natively by the staged massing tool with no tile (`vector-first-paint.ts`), one node per building, labelled
   `vector-modelled` (new legend entry). It commits `l0` unless the tiles were first; `l1` supersedes and crossfades from it
   and the viewport frees it like any superseded layer. A district keeps the buildings the tiles do not cover as `l0o`
   (bases against the tiles' frame). The district camera is the one the tiles will give, so the view does not move.
2. **The geometric isolate first.** The remesh commits tile_refine's geometric isolate at once; fit, evidence, grammar and
   textures start from it. The ownership vote is its own stage afterwards, waits at most 60 s for its outlines
   (`OWNERSHIP_VOTE_WINDOW_MS`: a view not outlined by then is left out), never fails the build, and replaces the isolate only
   when it moves at least **5% of the isolate's scan surface** (`ownership-change.ts`, triangles matched by centroid); then
   `l2v` supersedes the first isolate and what was built on it, the first pass's remaining work is ended
   (`Runner.passSignal`) and grammar, rebuild and textures run again on it. An identical earlier vote's outlines are read back.
3. **A twin from the tile photo first.** The texture stage starts at the remesh commit and bakes each layer from the tile photo
   alone (about 3 s with the worker threads, which now start loading when an isolate's tiles are in); once the Street View
   close-ups are in, each layer is baked again with them and replaces the tile twin only where Street View adds texels (else
   the record says `street_view_no_texels`).
4. **Textures do not wait for grammar or the rebuild.** A `textures-late` stage textures every later layer (fit, detail,
   `l2g`, figures) as it lands, waiting only for the fit's charts so a layer is not baked twice.
5. **Districts are textured.** tile_refine's own photo-textured remesh is the district's twin, and `l2g`'s
   (`tile-refine-twin.ts`: confidence extras on every material, rung shares by area, labelled photo-inferred, "as captured,
   not de-lit"); clay first, then the crossfade; a clay choice still shows clay. A district staged around a kept structure
   carves its twin like its clay layer.

### Timeline after (seconds from Enter)

Server time the layer was published, then (in brackets) the page poller's first visible frame. The Browser pane was
hidden for most of the runs, so the page's timers were throttled: the bracketed numbers lag by 0.5–3 s.

| Run | Tool starts | First 3D | First clay building | Trees | First textured | Build finished | Chat reply done |
|---|---|---|---|---|---|---|---|
| Haughwout cold | 7.5 | 8.2 (8.4) vector | 9.4 (12.4) | none | 12.3 (14.4) l2 tile photo | 70.3 (grammar done 30.0; the vote held the rest) | 91.1 |
| Haughwout warm | 8.1 | 8.1 (8.5) | 8.3 (11.3) | none | 10.6 (12.0) | 10.6 | 38.8 |
| Washington Sq Arch cold | 7.7 | 8.3 (8.6) vector | 9.6 (12.6); fitted l3b 10.3 | none | 11.3 (18.1) late twins of the fit | 70.6 (everything else 45.8) | 99.1 |
| Washington Sq Arch warm | 7.8 | 7.8 (8.3) | 7.9 (10.8) | none | 10.0 (11.8) | 10.0 | 30.6 |
| Flatiron District cold | 8.3 | 10.0 (10.2) vector | 51.9 (54.2) | 56.2 (56.6) | 52.3 (55.3) district twin | 205.9 | 297.9 |
| Flatiron District warm | 9.0 | 9.1 (10.9) | 9.7 (13.6) | 10.5 (17.5) | 10.3 (13.9) | 10.5 | 36.1 |
| Colosseum cold | 21.7 | 23.2 (23.4) vector | 48.1 (49.1) | 56.8 (59.3) | 48.4 (49.7) district twin | 56.8 | 74.4 |
| Colosseum warm | 26.7 | 26.7 (28.0) | 27.1 (28.0) | 27.6 (34.6) | 27.2 (30.0) | 27.7 | 47.3 |

### Before and after (the benchmark's runs above against these)

| Run | First 3D | First clay building | First textured | Finished |
|---|---|---|---|---|
| Haughwout cold | 10.0 → 8.2 | 87.0 → 9.4 | 131.5 → 12.3 | 183.8 → 70.3 |
| Haughwout warm | 8.9 → 8.1 | 10.9 → 8.3 | 51.4 → 10.6 | 52.1 → 10.6 |
| Arch cold | 11.9 → 8.3 | 51.9 → 9.6 | 57.9 → 11.3 | 107.0 → 70.6 |
| Arch warm | 8.9 → 7.8 | 8.9 → 7.9 | 12.8 → 10.0 | 10.9 → 10.0 |
| Flatiron cold | 15.5 → 10.0 | 53.1 → 51.9 | never → 52.3 | 282.0 → 205.9 |
| Flatiron warm | 13.9 → 9.1 | 13.9 → 9.7 | never → 10.3 | 11.8 → 10.5 |
| Colosseum cold | 12.9 → 23.2 (routing 7.4 → 21.7 s) | 37.0 → 48.1 | never → 48.4 | 47.0 → 56.8 |
| Colosseum warm | 13.1 → 26.7 (routing 10.8 → 26.7 s) | 13.1 → 27.1 | never → 27.2 | 11.6 → 27.7 |

**Time to first 3D after the tool starts** (what this change can move): Haughwout 2.7 → 0.7 s, Arch 2.2 → 0.6 s, Flatiron
7.4 → 1.7 s, Colosseum 5.5 → 1.5 s cold; 0.0–0.1 s warm.

**Vector fetch and extrude, cold** (`vector` breakdown, from the place to l0 on the server): Haughwout 0.50 s (fetch 0.37,
elevations 0.12, native 0.01), Arch 0.41 s, Flatiron 1.40 s (fetch 0.69, elevations 0.30, native 0.34; 238 buildings, 47,903
triangles, 4.3 MB), Colosseum 1.31 s. The tiles took 1.2, 1.3, 6.2 and 4.6 s.

### Honest reading

- **The chat model still bounds the first 3D.** Routing took 7.5–9.0 s on six runs and 21.7 and 26.7 s on the two Colosseum
  runs (the other agents' load and the model; nothing in the build). The Colosseum rows are slower only by that; server-side
  the Colosseum cold run reached its vector paint 1.5 s after the tool started and its textured district 26.7 s after.
- **The machine was shared.** Other agents ran test suites and builds (load average 6–55 on 20 cores during the runs): the
  cold Flatiron remesh and grammar ran 32 s and 154 s, against 33 s and 230 s in the benchmark; a shakedown Flatiron run under
  heavier load took 45 s and 303 s.
- **The ownership vote now holds the isolates' finish.** Cold Haughwout and Arch finished their other stages at 30 s and 46 s;
  the vote's slowest outline call ran into its 60 s window both times (the non-streamed calls are not hedged: branch
  `vision-call-hedging`). A shakedown run at the arch had one outline call answer after 299 s; before the window this failed the
  whole tool call. With hedged calls the finish would be about 30 s and 46 s.
- **The 5% threshold** was set after one measurement: Haughwout's vote moved 3.0% (95 m² left, 27 m² joined, of 3,980 m²). At
  3% that replaced the isolate and ran grammar, fit and textures again, +85 s to the finish (shakedown run `ca74d8a2`). It is a
  judgement, said in `ownership-change.ts`.
- **Flatiron's tiles cover the whole 250 m.** The `radius_truncated` record says the scan "reaches 149 m" (the nearest 524
  leaves); measured in plan, the leaf tiles cover 96–98% of every 25 m ring out to 250 m (55% to 275 m), so no building is left
  for `l0o` there. The degradation's wording understates the coverage; not changed here.
- **No Street View texel came in.** Haughwout and the arch found no Google pano facing them in these runs (the survey said
  so), so the Street View phase had nothing to add; the tile-photo twins stand, recorded. In the shakedown Haughwout run the
  phase ran (16 s ownership, 29 s re-bakes) and added no texel either.
- **Districts' trees stay clay** (SB-Veggie geometry, no photo): the visual check called the Colosseum "mixed texture and clay".
- **Warm first textured** is held by about 2 s of tile source loading done before the bake's cache is checked.
- `staged-build-real-data-screens` (crossfade coverage) fails the same way on the commit before these changes.

### Starting the vector fetch earlier (proposal, not done)

The tool call is the first thing that names the place, 7–27 s after Enter. Without routing on nouns: (a) a lower thinking level
for the routing turn (the benchmark's item 6); (b) streaming the function call and starting the place resolution and the vector
fetch when its `query` argument is complete, before the rest of the call; (c) a speculative Places Text Search on every chat
message, warming only the server's caches (never shown) — cheap, but it geocodes text that is not a place, so it needs the
user's say.

### Evidence

Screenshots: `test-results/screenshots/staged_fast_first/` (gitignored): the vector first paint at Flatiron (`08_…t14s`,
`04_…t19s` before the geoAnchor fix showed a "geoAnchor 0, 0" banner), textured isolates while the vote runs (`05_`, `07_`),
the textured Flatiron and Colosseum districts (`02_`, `09_`), and a native render of the Flatiron vector massing (`00_`).
Per-run timelines: `runs/<runId>/timeline.jsonl` (runs `a915e1f0`, `fc60dc47`, `02887cdd`, `e69cc874`, `62435fa3`,
`43f163be`, `d09a0780`, `569b9dae`).
