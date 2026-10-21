# Hedged requests and deadlines for unstreamed vision calls (2026-10-20)

**Date:** 2026-10-20
**Status:** Verified (tests on recorded latencies; 6 live headless builds of Haughwout and the Flatiron District, cold
and warm, plus a same-day hedging off/on comparison of the Flatiron grammar stage)

## Why

`docs/processes/build_speed_benchmark.md` found that stages wait for their slowest vision call, and only streamed calls
were hedged. The grammar, ownership-vote and locate-target calls are not streamed, so they were never hedged:

- Flatiron District: the grammar stage (60 calls) was held 226 s by one 189.7 s call.
- Haughwout: the ownership vote (12 calls) waited 76 s for one call; the grammar had 61 s and 83 s calls.

## Design (`packages/core/src/node/gemini/vision-model-chain.ts`)

- **Hedging.** A call that is not streamed and carries a `hedge` policy is sent once more, the same request, when it has
  had no answer for an adaptive threshold. The first *valid* answer is taken (each caller passes its own parse check
  as `valid`), and the other request is aborted through its `AbortSignal`.
- **The threshold.** It is a quantile of the latencies that the same call kind (its stage name) answered in lately in
  this process: the last 64 answered requests, clamped to a floor and a ceiling. Until a kind has 8 answers, an initial
  value is used. A shared `VisionHedgeBook` keeps the latencies, the 429 pauses and per-kind counts (calls, fired, won,
  suppressed, deadlines).
- **Rate limits.**
  - A 429 is retried on the same model after 2 s, then 4 s. A 5xx keeps its 1 s, 2 s.
  - After a 429, from the request or its duplicate, no duplicate goes to that model for 30 s. The pause doubles for
    each 429 in a row, up to 5 minutes.
  - At most 8 duplicates are out at once across the process. A skipped hedge is logged and counted as `suppressed`.
- **Deadlines.** `deadlineMs` covers the whole call, retries and hedges included. If there is still no answer when it
  passes, every request is aborted and the call fails with a typed error: `details.deadline`, the attempt outcome
  `'deadline'`, and the message "no answer within 90 s (the grammar call's deadline)". No answer is ever made up.
  The caller degrades as it already could.
- **Model fallback stays visible.** The candidate walk, `skipped` with reasons, `answeredModel` and the per-attempt
  record are unchanged. Attempts add `hedged`, `hedgeWon` and `hedgeAtMs`. `[vision-call]` lines say "hedged at N ms
  (the duplicate won / the first request won)", "not hedged (429 pause …)", and a call ended by its caller or by its
  deadline says so instead of "transient".
- **The switch.** `SCRATCHBOX_VISION_HEDGE=0` turns hedging of unstreamed calls off. Deadlines stay on.

## Deadlines and quorums per call kind (`VISION_CALL_POLICY`, `OWNERSHIP_VOTE_RULE`)

| Kind | Hedge threshold | Deadline | When there is no answer by the deadline |
|---|---|---|---|
| `grammar` | p80 of recent, 12–30 s (15 s at first) | 90 s per reading | Whole reading missing: the facade keeps the relief's own window lattice, and its outcome says "the reading failed (no answer within 90 s …)". A held-out reading missing: that fold is not scored. The held-out check keeps its own quorum (at least two folds and 40% of the hidden facade), else the grammar is not used. |
| `ownership` | p75 of recent, 15–30 s (20 s at first) | 90 s per view | The view casts no vote. **Vote quorum:** from 30 s after the vote starts, as soon as ¾ of the views (9 of 12) have outlines, the calls still out are aborted. Their views are recorded as "no answer by the time the vote went ahead (…)". The run note adds "the vote went ahead N s in without K views …". Below the quorum the vote waits; fewer than 2 outlines gives the existing `ownership_vote_unavailable` degradation (the geometric rules decide). |
| `locate-target` | p80 of recent, 10–30 s (15 s at first) | none | Hedged only. A locator failure fails the texture pass's Street View ownership step, which has no rung for a missing answer, so a deadline here would turn a slow answer into a failed stage. |

The streamed calls (survey, ornament reading, figures) keep their existing time-to-first-token hedge (`hedgeAfterMs`
25 s), which now also respects the 429 pause.

**Caller changes (all small):**
- `ownership-masks.ts`: the vote rule, a per-view `AbortController`, and the policy on the call.
- `facade-grammar.ts`: the policy and a parse check on the call.
- `segment-target-locator.ts`: the policy on the call.
- `orchestrator.ts` (two lines): the ownership vote asks 12 views at once (it was 6), and the run note gets the cut note.

## Choosing the numbers: replaying recorded latencies

The fixture `packages/core/test/fixtures/vision-latency/recorded.json` holds 394 grammar and 72 ownership latencies. They
come from the vision reply caches of real staged builds in this repository's worktrees (`gemini-4-argon` on Vertex),
with entries under 1 s left out. Their spread:
- grammar: p50 8.5 s, p75 13.6 s, p90 23.3 s, p99 74.8 s, max 211 s;
- ownership: p50 18.0 s, p75 26.7 s, p90 33.5 s, max 46 s.

`vision-call-hedging.test.ts` replays them on fake timers, in the stages' own shapes. Grammar has 12 facades, 3 at a
time, each waiting for its 5 readings. The ownership vote has 12 views.

| Replay | Stage times (s) | Notes |
|---|---|---|
| grammar, today (no hedge, no deadline) | 74.7, 72, 124, 72, 106.2, 81, **249.5**; sum 779 | worst call 211 s |
| grammar, deadline only | 74.7, 72, 106.2, 72, 106.2, 81, 128.5; sum 641 | 3 deadlines |
| grammar, hedged + deadline | 49.9, 65, 71.5, 65.9, 48.9, 78.4, 69.9; sum **450** (−42%) | worst call 50 s; 108 hedges fired for 394 calls (27%), 41 won; 0 deadlines |
| ownership, wait for all, 6 at a time | 74.6, 56.9, 69.3, 68.3, 57.4, 41.6; sum 368 | 12 views vote |
| ownership, hedged + quorum, 6 at a time | 33.3, 30, 44.9, 30.5, 30, 32.3; sum 201 | 9–11 views vote |
| ownership, hedged + quorum, 12 at a time | 30 each; sum 180 | 9–11 views vote (hence the concurrency change) |

## Live builds

**How they were run.**
- The builds ran headless through the server's own tool entry (`runStagedLocationTool`), with
  `createStagedLocationDeps`, the same dependencies the chat route uses. The arguments matched the benchmark's chosen
  ones: Haughwout `isolate: true`; Flatiron District `isolate: false, radiusMeters: 250`.
- Cold means a fresh worktree with no `.scratchbox` cache and an empty, isolated `SCRATCHBOX_HOME`.
- Times are tool times. The benchmark's "build finished" is counted from Enter and includes 7–8 s of chat routing,
  which is subtracted below.
- The in-app chat route was not used. The launch entry `scratchbox-vision-call-hedging` (ports 3940-3942) started, but
  reading the per-launch token from the server log was refused by the session's permission policy, so the page could
  not authenticate. The entry was removed.

### Haughwout (isolated structure)

| Stage | Benchmark cold | This branch cold (run `28fa5c84`) |
|---|---|---|
| remesh | 77.3 s (ownership vote 76.2 s, slowest call 76.1 s) | **31.0 s** (vote 30.0 s: 11 of 12 answered, 5 hedged with the first request winning each time; the 12th was cut by the quorum rule at 29.9 s) |
| grammar | 85.4 s (10 calls 3.8–83.3 s) | **23.9 s** (10 calls 4.4–22.7 s; one hedged at 15 s, the duplicate won) |
| textures | 90.5 s (waiting for grammar 41.3 s) | **51.6 s** (waiting for grammar 0.0 s; Street View ownership 24.9 s, 4 locate-target calls 4.7–8.1 s, none hedged) |
| tool time, finished | ~176.5 s (183.8 s from Enter) | **96.4 s** |
| warm | 44.2 s | 70.3 s (see "Quality") |

### Flatiron District (district, 250 m)

| | Benchmark cold (run `514b7165`) | This branch cold (`341c7f83`) | Same day, hedging off (`a7b55d01`) | Same day, hedging on (`14b9630b`) |
|---|---|---|---|---|
| grammar stage | 229.9 s | **189.6 s** | 209.7 s | **190.5 s** |
| vision pass | 195.6 s | ~154 s | ~176 s | ~152 s |
| call p50 / p90 / max | – / – / 189.7 s | 15.4 / 38.2 / 58.2 s | 14.8 / 27.0 / 83.8 s, plus **2 cut at the 90 s deadline** | 15.1 / 36.7 / 58.2 s |
| hedges fired / won | 0 | 18 / 7 (5 suppressed by a 429 pause, 1 × 429) | off | 19 / 3 (2 suppressed by the in-flight cap) |
| facades accepted | not recorded | 4 of 12 | 4 of 12 (facade 1 lost its whole reading to the deadline) | 7 of 12 |
| tool time, finished | ~274 s (282.0 s from Enter) | **237.7 s** | 210.2 s* | 191.0 s* |
| warm | 0.9 s | 0.9 s | | |

\* The same-day runs reused the cached remesh and trees and rebuilt only the grammar (its stage cache and the reply
cache cleared).

**Reading it.**
- The tail is gone. No grammar call took longer than 58 s with hedging, against 189.7 s in the benchmark. With hedging
  off on the same day, two calls ran past 90 s.
- Without the deadline, those two calls would have held the stage longer than 209.7 s. With the deadline, the facade
  that lost its whole reading kept the relief's lattice, and its outcome said why.
- The Flatiron gain is smaller than the benchmark's −150 s estimate, for two reasons.
  - Today's median latency was about 15 s, against 8.5 s in the recording.
  - The grammar pass is shaped as 12 facades, 3 at a time, each waiting for all 5 of its readings. That makes about 4
    rounds of "slowest of 5", around 35–40 s each, so its length now comes from that shape, not from the tail.

## Quality

- **Haughwout ownership.** The vote went ahead with 11 of 12 outlines. The isolate it voted gave l2 7,636 triangles. The
  warm run's full 12-view vote gave 7,608. The fit degraded in both, with the same gates failing as in the benchmark.
- **Haughwout grammar.** One facade was accepted and the other "read no openings", the same in cold and warm.
- **Flatiron grammar.** 4, 4 and 7 facades were accepted over three cold readings of the same orthophotos (hedged,
  unhedged, hedged). The model's answers vary from run to run at temperature 0. No accepted count fell with hedging.
- **Hedging does not change a reading.** A hedged answer is the same request's answer: the duplicate is byte-identical,
  and both go through the same parse check and gates.
- **Warm after a quorum cut.** A cut view has no recorded reply, so the next build asks it live. The vote then has
  12 masks, a new tile_refine key and a new remesh, and the grammar and textures run again. That is why Haughwout warm
  took 70.3 s against 44.2 s. The build after that is fully cached. The vote is completed, not frozen at 11 views.
- **Honesty.**
  - Every cut or deadline is reported: the view's skipped reason, the run note, the facade outcome reason, and the
    `[vision-call]` lines.
  - The degraded steps are the pipeline's existing ones: no vote from a view, the relief's lattice, a fold not scored.

## Tests

- `packages/core/test/vision-call-hedging.test.ts` (19 tests, fake timers, no network):
  - hedging fires at the threshold, the duplicate wins and the slow request is aborted;
  - the first answer wins and the duplicate is aborted;
  - no hedge before the threshold;
  - an invalid answer waits for the other request;
  - adaptive threshold (floor, quantile, ceiling, kinds kept apart);
  - `SCRATCHBOX_VISION_HEDGE=0`;
  - 429: 2 s back-off, hedge pause, pause doubling and expiry, a duplicate refused with a 429;
  - deadline error typed and every request aborted; a stop is still a stop;
  - model fallback still visible while hedged;
  - ownership vote: the quorum cut is reported; below the quorum it waits to the deadline; the rule can be turned off;
  - grammar: a whole reading past the deadline keeps the relief's lattice; a held-out reading past it is not scored;
  - the two replays above.
- Also passing: `vision-model-chain`, `staged-location-grammar`, `staged-location-orchestrator`, `staged-scheduling`,
  `staged-e2e-integration`, `staged-stage-cache`, `staged-stage-timeline`, `staged-texture-pass-ladder`,
  `tile-refine-mask-voting`, `open-vocab-segment`, `photo-ornament-*`, `ornament-vision` and
  `streetview-survey-temporary`: 249 passed, 1 skipped.
- `npm run typecheck`, `npm run lint` (0 errors) and `npm run lint:primitives` all pass.

## Candidate Tool/Service Ideas

- **The grammar pass's shape is now the limit.** Read all 60 readings through one pool (for example 15 at once) instead
  of 3 facades × 5. Each facade could then be judged as soon as its own five are in. Estimate: the Flatiron vision pass
  from about 150 s to about 60 s. Watch the 429s: one came at 15 in flight.
- **Record a cut view's absence in the stage cache.** Then a warm build could reuse the 11-view remesh instead of
  completing the vote, if consistency matters more than the 12th view.
- **A degraded rung for a missing locator answer in the texture pass.** For example, that photo vouches for no pixel.
  That would let `locate-target` take a deadline too.
- **`GET /api/staged/runs/:runId/vision-calls`:** the per-call attempts and the hedge counts
  (`visionHedgeBook.counts()`) for a run, instead of grepping `[vision-call]` lines.
