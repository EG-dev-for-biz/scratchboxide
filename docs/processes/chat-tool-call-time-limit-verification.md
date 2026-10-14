# Process: Chat Tool-Call Time Limit — A Stuck Tool No Longer Hangs the Chat

> **Recorded:** 2026-10-13
> **Status:** Verified
> **Tags:** `operate-scratchbox` `gemini-chat` `tool-calls` `timeouts` `google-3d-tiles`
> **Target Domain:** Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** a tool call that never returned left the chat on "Thinking…" indefinitely; scripted clients were cut off by their own ~300 s idle limits. The Google 3D Tiles blockout render, for example, allows itself up to `max(5 min, frames × (settle + 5 s) + 120 s)` (about 38 min at 72 frames).
* **Instance used:** web port `3032`, API port `3013`, tools port `3014`, started from a shell with `SCRATCHBOX_TOOL_TIMEOUT_MS=8000` and then `1500` to force the limit.
* **Scope tested:** `StreamingEngine.executeToolCallWithDeadline` (`packages/core/src/node/gemini/streaming.ts`): the per-call time limit (default 5 min, `SCRATCHBOX_TOOL_TIMEOUT_MS`) and the 15 s "Still running …" status events.

---

## 2. What Was Tested & What Worked (Verified)

* **Normal 3D tile request under an 8 s limit** — "Build a 3D clay model of the Eiffel Tower in Paris at its real location" → both tool calls finished in time and the clay tile scene rendered. The limit stays out of the way when tools finish.
* **Forced overrun under a 1.5 s limit** — "Build a 3D clay model of the Colosseum in Rome at its real location" → `google_3d_tiles_get_clay` returned `failed` with "did not finish within …s, so the chat continued without its result"; the model continued with `mount_canvas_primitive`, and the chat completed in 34 s with the Colosseum scene. The UI showed "3 Tool Actions Executed · Failed".
* **No leaked browser** — 20 s after the abandoned tile job, no `chrome_tile_blockout` processes remained. Since `6f4a5d0`, `Google3DTileBlockoutPipelineService` kills Chrome on completion and on every failure path.
* **Unit test** — `chat-failure-reporting.test.ts` registers a tool that never resolves: the stream finishes in < 5 s with the tool marked failed and the timeout text sent back to the model. Without the change the same test hangs until vitest's 180 s timeout.

---

## 3. What Broke / Didn't Work

* **Message rounding (fixed)** — a 1.5 s limit was printed as "2s"; it now prints one decimal.
* **Abandoned work keeps running** — the timed-out tile job still finished in the background and rewrote tracked demo media under `desktop-app/public/` (storyboards, clay frames, manifests; about 80 files). This is pre-existing pipeline behaviour, not caused by the time limit, but it means any live tile run dirties the working tree.
* **Not exercised live:** the 15 s "Still running …" status events (every live run either finished or hit the 1.5 s limit first).

---

## 4. Candidate Tool/Service Ideas

* **Cancellable tool handlers** — pass an `AbortSignal` from the time limit into `ToolContext` so long tools such as the tile pipeline stop work, and kill Chrome, when the chat abandons them, instead of running to their own 38-minute deadline.
* **Write pipeline outputs outside tracked folders** — have the tile blockout pipeline write to `build/` or an ignored run folder instead of overwriting committed demo media in `desktop-app/public/`, so test and live runs leave `git status` clean.

---

## 5. Reproduction Steps

1. `env SCRATCHBOX_TOOL_TIMEOUT_MS=1500 SCRATCHBOX_NO_ELECTRON=true PORT=3013 SCRATCHBOX_WEB_PORT=3032 SCRATCHBOX_TOOLS_PORT=3014 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3032,http://localhost:3032 npm run dev`
2. Open the logged `…/?token=…` URL and send "Build a 3D clay model of the Colosseum in Rome at its real location".
3. Expect a failed `google_3d_tiles_get_clay` with the "did not finish within 1.5s" result, and the chat still completing.
4. Afterwards run `git restore desktop-app/public public` to undo the pipeline's media rewrites.
5. `npx vitest run packages/core/test/chat-failure-reporting.test.ts`
