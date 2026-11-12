# Process: The chat agent on Gemini, Claude or OpenAI, picked per chat

> **Recorded:** 2026-11-11
> **Status:** Verified on all three providers (object build live on Gemini, Claude Opus 5.5 and GPT-6 Astra; 3D Building starter live, see §2). Two bugs found live and fixed in the PR (§3).
> **Tags:** `operate-scratchbox` `chat-agent` `providers` `claude` `openai` `model-picker`
> **Target Domain:** Agent chat (model provider layer, composer, Settings > Models & AI)

---

## 1. Session Context

* **What prompted this session:** the chat ran on Gemini only; the user wants Gemini, Claude and OpenAI (GPT/Codex) models usable per chat, with the full tool-calling agent loop on each.
* **Instance used:** web port `4720`, API port `4721`, tools port `4722` (launch entry `scratchbox-chat-providers`, removed afterwards).
* **Scope tested:** the composer's model picker, a script-built object (`execute_3d_python_script`) and the "Make a 3D building" starter on Gemini; the missing/rejected-key message on Claude; the `/gemini/chat-models` endpoint.

---

## 2. What Was Tested & What Worked (Verified)

* **Model list endpoint** — `GET /gemini/chat-models` → 9 models (2 Gemini, 4 Claude, 3 OpenAI), each with `configured: true` (keys read from `~/.scratchbox/secrets.json`); no key in the response.
* **Picker** — the composer shows the chat's model (`Gemini 4 Argon`, grouped options per provider); picking Claude Opus 5.5 kept it on the chat, and a new chat opened on the last pick.
* **Gemini object build through the refactored loop** — "Build a three-legged wooden stool ... with execute_3d_python_script" on Gemini 4 Argon → `load_tools` → `read_sb_script_guide` → `execute_3d_python_script` (failed in 0.66 s, the error went back to the model, which fixed the script) → `execute_3d_python_script` (8.6 s) → verification passed → the stool opened in the 3D viewport; footnote "Answered by gemini-4-argon · Vertex AI". `[chat-turn]` log: call 1 `routedBy: "gemini-4-argon@LOW chose the first tool call (load_tools)"`, calls 3 and 5 read 53.9k / 53.6k cached prompt tokens: the fast router, the context cache and thought signatures work as before the refactor. Screenshot: `test-results/screenshots/chat-providers/gemini-object-build.jpg`.
* **Gemini 3D Building starter** — "Make a 3D building" on Gemini → the model answered in text asking which building (`routedBy: gemini-4-argon answered the first call ... handed off`). Not continued into a staged build (the pane was in use).
* **Rejected key message** — the same prompt on Claude Opus 5.5 → the chat reply "Anthropic rejected the API key (401): invalid x-api-key. Check the key in Settings > Models & AI.", footnote "No model answered · Anthropic API key". Screenshot: `test-results/screenshots/chat-providers/claude-key-rejected.jpg`.
* **Recorded-stream tests** (`packages/core/test/chat-provider-adapters.test.ts`, 15 tests, the SDKs' own stream parsers fed through an injected fetch): Claude and OpenAI request bodies (cached system prompt, JSON-Schema tools, adaptive thinking / reasoning effort, server-side refusal fallback, stateless encrypted reasoning), thinking blocks and reasoning items replayed verbatim, tool results with images, refusals, cut-off tool calls, invalid tool JSON, tool-schema rejections naming the tool, and the whole agent loop (tool call → tool run → result back → answer) on each provider through `GeminiService`.

---

* **Claude Opus 5.5 object build (after valid keys were saved in Settings)** — same stool prompt → task list, `load_tools`, `load_skill`, `read_sb_script_guide`, `execute_3d_python_script` (2.5 s) → stool in the viewport → `audit_3d_scene_viewport`, `workspace_view_image` ×4 (the renders shown to Claude inside tool_result blocks) → a second `execute_3d_python_script` → verification passed; main's quality gate then sent its review back (round 1 5.7/10, round 2 6.3/10) and Claude kept working on the feedback in the same turn; stopped after round 3 (the gate's own loop, not the provider). Summarized thinking streamed throughout. Screenshots: `claude-object-build.jpg`, `claude-object-build-tools.jpg`.
* **Claude Sonnet 5.5, 3D Building starter** — "Make a 3D building" → Claude asked which building (suggesting the Flatiron) → reply "The Flatiron Building in New York, as a single building." → `load_skill`, `google_3d_tiles_get_clay` (949 s, stage progress cards throughout) → result back to Claude, which reported honestly that pipeline K's remesh stage hit its 15-minute limit (straightened clay scan shown, no textured rebuild) → the quality gate failed it (2.3/10) → Claude started a remesh retry on its own; stopped by me because the machine's load was over 100 (house rule; the load came from other sessions' work). Screenshot: `claude-3d-building.jpg`. The remesh timeout is pipeline K's (follow-up), not the provider's.
* **GPT-6 Astra, 3D Building starter (question step)** — "Make a 3D building" on GPT-6 Astra: the server stream carried reasoning summaries, the reply "Try the **Flatiron Building in New York**. Which building or address would you like?" and `done` (read from the network response; the background tab it ran in did not render it). The build itself was not run: load over 100 and the pane in use.
* **GPT-6 Astra object build** — same prompt → task list, `load_skill` ×3, `load_tools`, `read_sb_script_guide`, `execute_3d_python_script` (4.9 s), `audit_3d_scene_viewport` (4.7 s) — 7 of 7 tools completed, verification passed, independent review round 1 8.7/10 passed; footnote "Answered by gpt-6-astra · OpenAI API key". Screenshot: `openai-object-build.jpg`.

## 3. What Broke / Didn't Work

* **Stored keys revoked** — the Anthropic and OpenAI keys in `~/.scratchbox/secrets.json`, the repo `secrets.json` and `.env` are rejected (`401 invalid x-api-key`; `401 invalid_api_key`, also from curl). The user saved valid keys in Settings > Models & AI; those come first.
* **Tools asked Google for the chat's Claude model (fixed)** — on the Claude run `audit_3d_scene_viewport` failed with `Publisher model … claude-opus-5-5 was not found`: tools that make their own Google calls read `ctx.request.model`. Fix: on a non-Gemini chat tools get the request without the chat's model (`StreamingEngine.executeToolCall`); confirmed live: the audit ran on the GPT run. Test added.
* **OpenAI's second call failed (fixed)** — `400 Unknown parameter: 'input[2].parsed_arguments'`: the openai SDK's stream helper adds `parsed_arguments` / `parsed` to the final response's items, which were replayed verbatim. Fix: `replayableOutput` drops them; the fixture test now compares the replayed items exactly; confirmed live (the 7-tool GPT run).
* **`workspace_view_image` refused the review renders** — they sit outside the workspace and the tool's path guard refuses them (not provider-related; seen on the Claude run).

---

## 4. Candidate Tool/Service Ideas

* **Key check in Settings** — a "Test" button per provider that sends a one-token request and shows the provider's answer; this session found the revoked keys only by sending a chat turn and then curl.
* **Chat-turn API for tests** — a POST that runs one chat turn headless with a given model and returns the event list, so a provider can be checked end to end without driving the composer.

---

## 5. Reproduction Steps

1. Add a launch entry on free ports (see `operate-scratchbox`), start it, open the app.
2. In the composer, pick a model in the picker beside the + button (each chat keeps its own).
3. Send "Build a three-legged wooden stool as a 3D object by writing a Python script and running it with execute_3d_python_script."; or click "Make a 3D building" and answer the question card.
4. For Claude/OpenAI, first save a valid key in Settings > Models & AI.
