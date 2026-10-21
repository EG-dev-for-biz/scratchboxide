# Process: Fast chat routing — cutting the time from Enter to the first tool start

> **Recorded:** 2026-10-20 / 2026-10-21
> **Status:** Verified
> **Tags:** `operate-scratchbox` `gemini-chat` `routing` `prompt-caching` `tool-catalog` `latency`
> **Target Domain:** Gemini Agent Chat (first model call of a turn)

---

## 1. Session Context

* **What prompted this session:** on a request such as "Build a 3D scene of the Flatiron Building" the chat took 7–11 s
  from Enter to the first tool starting (`google_3d_tiles_get_clay`), before any 3D appeared. The goal was to measure
  where that time went and cut it without choosing tools worse than before.
* **Instance used:** the `scratchbox-fast-routing` launch entry (web `3870`, API `3871`, tools `3872`,
  `SCRATCHBOX_HOME` in the session scratchpad), branch `fast-routing`; removed after the session.
* **Scope tested:** the first model call of a chat turn (its payload, its timing, which tool it chooses), the routing
  race, `load_tools`, and the live app's Enter → tool start and Enter → first 3D on three location requests.
* **Billing:** every eval run is a real Gemini call on the app's Vertex service account (`--yes-billed`); unit tests run
  with credentials unreachable (`guarded-vitest.sh`).

---

## 2. Where the 7–11 s went (measured with the `[chat-turn]` line)

Every model call of a turn logs one `[chat-turn]` JSON line (`chat-turn-telemetry.ts`): `authMs`, `historyMs`,
`payloadMs`, `sentMs` (preparation, from the turn reaching the server), `firstByteMs`, `firstFunctionCallMs`,
`toolStartMs`, `endMs`, the usage the model reported (`promptTokenCount`, `cachedContentTokenCount`,
`thoughtsTokenCount`), the sizes sent (system instruction, tool declarations, contents) and, when a router took part,
`routedBy`. Nothing is estimated.

The old first call (every tool declared, `gemini-4-argon` at MEDIUM thinking), as the chat sent it before this work
(`SCRATCHBOX_CHAT_TOOLS=all SCRATCHBOX_CHAT_ROUTER=off`), live in the app:

| part of the wait | measured | notes |
| --- | --- | --- |
| client, Enter → fetch | 55–70 ms | the renderer builds the request and opens the stream |
| server, turn start → request sent (`sentMs`) | 30–600 ms warm; 1.2 s on the first turn after a server start (3.4 s on the very first turn of a freshly started dev server, with the first page load) | lazy compilation of the prompt builder's modules under ts-node and the one-time workspace pattern scan (`analyzeWorkspacePatterns`, ~600 ms, cached per workspace); auth 0 ms (token cached), history 0–3 ms |
| model, request sent → first functionCall part | **7.1–9.5 s** (Flatiron, Colosseum), **14–23 s** ("a scene at the Alhambra") | 161 function declarations, 287 KB, **95.4k prompt tokens**; the implicit prefix cache hit on 1 call in 9 (93k cached tokens; that call was not faster: 9.0 s) |
| server, functionCall part → tool start | 0–1 ms | since this work; before it the tool waited for the end of the stream (the stream ends 0.1–1.5 s after the call: `endMs − firstFunctionCallMs`) |
| tool → first 3D in the viewport | 0.1–2.4 s with cached tiles; 12 s cold | the staged pipeline's first clay layer; not part of this work |

So the wait was the model reading a 95k-token prompt, almost all of it tool declarations, before writing its first
token (first byte = first function call on these requests: the model wrote no thoughts on most of them).

---

## 3. What changed, and the effect of each step

All measured on the chat routing eval (`scripts/chat-routing-eval/`, 44 requests across locations, heroes, objects,
clay, video, apps, documents, scene edits with an open staged scene or object, images, ambiguous requests and code;
the Alhambra request the old keyword routing missed is `loc-alhambra`). Each variant changes one thing. Timings are
medians over the 44 calls (`fc` = request sent → first function call; `loc fc` = the same over the 12 location, hero
and clay requests), run 4 at a time, so the absolute numbers are a little slower than the app's single calls.

| variant | tools declared | prompt tokens | thinking | fc (all) | loc fc | tool agreement with reference | blind judge on disagreements (variant : reference) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **reference** (before): all tools, MEDIUM | 161 | 93.9k | MEDIUM | 9.3 s | 8.1 s | — | — |
| all tools, LOW | 161 | 93.9k | LOW | 8.5 s | 7.4 s | 97.7% | 3 : 1 |
| catalog (entry set + `load_tools`), MEDIUM | 22 | 35.9k | MEDIUM | 8.3 s | 6.2 s | 93.2% | 2 : 4 |
| catalog, LOW | 22 | 35.9k | LOW | 6.6 s | 4.8 s | 95.5% | 4 : 1 |
| **default-med**: catalog, context at the end of the system instruction, MEDIUM | 22 | 35.9k | MEDIUM | 6.7 s | 5.6 s | 95.5% | 3 : 2 |
| **default-low**: the same at LOW | 22 | 35.9k | LOW | 6.4 s | 4.5 s | 95.5% | 4 : 2 |
| **default-race** (shipped): default-low raced against default-med; the router's call when it ends first with a call | 22 | 35.9k | LOW / MEDIUM | **5.4 s** | **4.5 s** | **95.5%** | **4 : 1** |
| gemini-3.8-flash router (explicit context cache) over catalog, raced | 22 | 34.0k (cached) | budget 1024 | 3.0 s | 2.1 s | 86.4% | 2 : 6 |
| gemini-3.8-flash, all tools | 161 | 77.8k | budget 1024 | 12.2 s | 11.7 s | 72.7% | 4 : 10 |
| gemini-3.8-flash, catalog | 19 | 32.1k | budget 1024 | 11.3 s | 11.4 s | — | — |

Each disagreement is judged three times blind (order shuffled) by `gemini-4-argon`; the majority decides. Key-argument
agreement (place, isolate, radius, subject, primitive type, material mode) stayed at 0.93–0.95 for every argon variant.

1. **`[chat-turn]` instrumentation** (`chat-turn-telemetry.ts`, logged from `streaming.ts`): the breakdown above.
   This session added `authMs`, `historyMs` and `payloadMs` so the preparation time is split too.
2. **Cacheable prompt prefix** (`chat-payload.ts`, `prompt-builder.ts` `buildSystemInstructionParts`): the system
   instruction is split into a stable part (persona, project instructions, knowledge, skill index, memories, tool
   guide, capabilities, 3D policy: byte-identical across turns of a workspace) and this request's context (attached
   skills and MCP tools, matched symbols, exemplars, diagnostics, diffs, script guide, open-artifact rule). The stable
   sections come first, then the tools in a fixed order (entry set, `load_tools`, loaded tools), then the contents.
   **Measured:** `gemini-4-argon` gains nothing from a byte-identical prefix: implicit caching hit on about 1 call in
   6 across the eval (`cachedContentTokenCount` > 0 on 7–12 of 44 calls, whatever the layout) and a hit was not
   faster; `gemini-4-argon` refuses explicit caches ("does not support explicit context caching", `context-cache.ts`).
   With the context moved into the request the routing call was *slower* (paired runs, 11 rounds × 3 prompts with a
   5.8k-character workspace context: LOW 5.9 s against 4.9 s; MEDIUM 9.7 s against 7.3 s), so by default the context
   stays at the end of the system instruction after the stable sections (`SCRATCHBOX_CHAT_STABLE_PREFIX=1` sends it
   with the request). Explicit Vertex context caches work for `gemini-3.8-flash` (`ContextCacheManager`: created in
   the background on the first sight of a prefix, 1 h TTL, renewed near expiry, refused models remembered): 1.9–3.6 s
   to the first token against 5.4–7.9 s without; a router of another model always gets the cacheable layout and the
   cache. The app shows `cachedContentTokenCount` on every `[chat-turn]` line.
3. **Thinking level by turn role** (`fast-router.ts`): the catalog made argon at MEDIUM spend 300–600 thought tokens
   on most routing calls (median 10.1 s on an earlier catalog run against 8.6 s before). At LOW it answered in a median
   4.7 s with no thoughts and chose tools as well as the reference or better. **Default on:** the first call is sent
   twice at once, to the chat model at LOW (the router) and at its own level; the router's call is used when it ends
   with a function call before the chat model decides, otherwise the chat model's stream is used and the router's is discarded
   unseen (text answers and later calls always come from the chat model at its own level). In the live app the LOW call
   decided 7 of 9 routing calls; the two it lost were decided by the MEDIUM call first (4.1 s, 7.6 s). Each reply's
   provenance says who routed ("Routing: gemini-4-argon@LOW chose the first tool call (google_3d_tiles_get_clay) in
   3.8 s; gemini-4-argon did the rest"), as does the `[chat-turn]` line (`routedBy`).
4. **Tool catalog with `load_tools`** (`tool-catalog.ts`, `tool-registry.ts` `buildToolDeclarations`): every call
   declares an entry set of 21 tools (the tools most requests start with, chosen from the eval's reference choices)
   and `load_tools`, whose description lists every other allowed tool by name with the first sentence of its
   description; the model loads what a task needs by meaning and the loaded declarations are appended after the
   prefix and returned to the client (`loadedTools`), which sends them back on the conversation's next request.
   Keyword pack routing and the regex tool gating in `domain-tool-packs.ts` / `tool-registry.ts` (word lists such as
   `beach|park|monaco`, `browse|click|navigate`, `3d|tile|photorealistic|...`, the `is3DSceneRequest` regex that
   withheld code execution, the silent `catch { // Graceful fallback }`) are gone; what is offered is decided by the
   request's switches only (`mode`, `enableWorkspaceTools`, `enableLensTools`, `enableBrowserTools`, `toolPacks`,
   attached MCP tools, `isSubagentRun`). `SCRATCHBOX_CHAT_TOOLS=all` offers every tool as before.
   **Measured:** 161 declarations / 287 KB / 95.4k prompt tokens → 22 / 68 KB / 37.5k on the routing call (the
   continuation call after the tool result: 48.3k); the model called `load_tools` first on 3–4 of 44 eval requests
   (video grading, matchmove, a tree), which costs a second call on those. `instruction-tool-drift.test.ts` passes.
5. **Early tool start** (`streaming.ts`): a tool starts as soon as its functionCall part arrives in the stream, in
   the order the model wrote them; the rest of the stream (usage, closing text) no longer holds it up. Measured:
   `toolStartMs − firstFunctionCallMs` = 0–1 ms; the stream ends 0.1–1.5 s later (0.8 s on the live Flatiron calls).
6. **Optional router model** (`SCRATCHBOX_CHAT_ROUTER`): `off`, a Gemini model id, `<model>@<LOW|MEDIUM|HIGH>`, or
   `@<level>` for the chat model itself at that level (the default, `@LOW`). `gemini-3.8-flash` as router was the
   fastest (2.1 s to the first call on location requests, reading the prefix from an explicit cache) but chose worse
   (86% agreement, judged 2 : 6; it loaded skills instead of calling tools, searched the workspace instead of asking),
   so it stays off. `gemini-3.5-flash-lite` is wired as a variant but was not run.

---

## 4. Live app: Enter → tool start and Enter → first 3D (3 runs each, same machine, same evening)

Measured in the running app through the Browser pane: a probe recorded the Enter keydown, the moment the renderer
opened the stream (55–70 ms after Enter), and the first visible triangles of a new 3D object in the viewport
(`window.__SB_3D_EXTERNAL_OBJECTS__`, polled every 100 ms); the server's `[chat-turn]` line gives the tool start.
Enter → tool start below is the server's `toolStartMs` (add ~60 ms for the client hop). Tiles were cached for most
runs (the `SCRATCHBOX_HOME` store), so first 3D measures the chat, not tile streaming; cold runs are marked.

| request | config | Enter → tool start (s) | Enter → first 3D (s) |
| --- | --- | --- | --- |
| Build a 3D scene of the Flatiron Building | before | 9.6 (first turn after start), 9.0, 7.2 | 12.1, 10.7, 8.1 |
| | **after** | 8.0 (first turn of a fresh server + first page load, `sentMs` 3.4 s), 5.4, 5.2 (first turn after a restart) | 19.7 (cold tiles), 6.7, 7.0 |
| Build a 3D scene of the Colosseum | before | 9.2, 7.7, 7.3 | 10.4, 8.4, 8.0 |
| | **after** | 3.9, 4.1, 4.3 | 6.5, 6.4, 6.4 |
| a scene at the Alhambra | before | 23.4, 23.0, 14.0 | 24.2, 23.8, 14.7 |
| | **after** | 7.6 (cold tiles; MEDIUM decided first), 5.0, 4.6 | 19.7 (cold), 12.0, 5.4 |
| **median** | before | **9.1** | **10.7** |
| | **after** | **5.0** | **6.7** |

Before = `SCRATCHBOX_CHAT_TOOLS=all SCRATCHBOX_CHAT_ROUTER=off` on the same branch (the early tool start is in both,
so "before" is already 0.1–1.5 s better than the code before this branch). The prompt tokens per routing call went from
95.4k to 37.5k; the Alhambra wording, which the old keyword routing did not recognise as a 3D request at all, is now
routed like any other place.

Screenshots: `after_colosseum_run1_routing_provenance.jpg` (the reply's provenance line naming the router and its time;
the finished clay Colosseum) and `after_flatiron_run3_first3d.jpg` (first clay layer in the viewport at 7.0 s) in the
session's `shots/fast_routing/` folder; `live_before_after.png` is the chart of the table above.

---

## 5. What broke / did not work

* **The LOW router loses some races.** On 2 of 9 live routing calls and 23 of 44 eval requests the chat model's own
  call decided first (the race then costs nothing but the aborted LOW call). On "a scene at the Alhambra" with cold
  tiles the MEDIUM call won at 7.6 s against a 5 s typical LOW answer: there is no deadline on either call, so the
  turn is never slower than before, only sometimes not faster.
* **Implicit caching on `gemini-4-argon` is not a lever.** It hit on 7–12 of 44 eval calls and on 3 of 18 live calls
  regardless of prefix layout, and a hit did not make the call faster (9.0 s with 93k cached tokens).
* **`gemini-3.8-flash` as router chose worse** (section 3, step 6), so the fastest configuration measured (2–3 s to
  the first call) is not the default.
* **The first turn after a server start pays 0.4–1.2 s of preparation** (lazy ts-node compilation of the prompt
  builder and the workspace pattern scan); 3.4 s on the first turn of a freshly started dev server with a fresh page.
  Later turns: 30–600 ms (`payloadMs`), mostly the per-workspace pattern scan when a workspace is seen for the first
  time. Not changed in this session.
* **Full vitest run:** 3 files failed once in the full run (`staged-time-slice` timing bounds, `viewport-camera-focus`
  headless Chrome, `server-stream-dualauth` which had found the credential link I had restored for the eval while the
  suite was running and made a real call); all four files pass alone under `guarded-vitest.sh` with credentials
  unreachable (28 passed, 2 skipped). The run with the link present was a mistake on my part: tests must never bill.

---

## 6. Candidate tool/service ideas

* **A deadline-free race needs a cheaper loser:** the aborted call still bills its prompt tokens. A `[chat-turn]` field
  for the losing stream's tokens would make that cost visible per turn.
* **Warm the prompt builder at server start** (as the native warm-ups do): would take the 0.4–1.2 s off the first
  turn after a start.
* **Client-side tool-call timing is unreliable from the SSE text** (a split event hid the `tool_call` from a regex
  on 3 runs); a `t` field on stream events, set when the server emits them, would let the renderer measure the same
  thing the server logs.

---

## 7. Reproduction steps

1. Eval (billed): `npx vite-node scripts/chat-routing-eval/run.ts -- run --variant reference --out <dir> --yes-billed`,
   then `--variant default-med`, `--variant default-low`; `-- compose --chat <dir>/default-med.json --router
   <dir>/default-low.json --name default-race --out <dir>/default-race.json`; `-- compare --ref <dir>/reference.json
   --var <dir>/default-race.json --yes-billed` (3 blind judgements per disagreement, `EVAL_JUDGE_VOTES`).
2. Live timing: start your own `scratchbox-<branch>` launch entry (operate-scratchbox skill), open the token URL, send
   "Build a 3D scene of the Flatiron Building" in a new chat and read the `[chat-turn]` line in the server log
   (`toolStartMs`, `routedBy`, `usage`). For "before", add `SCRATCHBOX_CHAT_TOOLS=all SCRATCHBOX_CHAT_ROUTER=off` to the
   entry and restart it.
3. Unit tests (never billed): `bash guarded-vitest.sh packages/core/test/fast-chat-routing.test.ts
   packages/core/test/instruction-tool-drift.test.ts packages/core/test/domain-tool-packs-and-coercion.test.ts`.
4. Switches: `SCRATCHBOX_CHAT_TOOLS=all` (every tool declared), `SCRATCHBOX_CHAT_ROUTER=off|<model>[@LEVEL]|@LEVEL`
   (default `@LOW`), `SCRATCHBOX_CHAT_STABLE_PREFIX=1` (context in the request), `SCRATCHBOX_CHAT_CONTEXT_CACHE=0`
   (no explicit caches for router models).
