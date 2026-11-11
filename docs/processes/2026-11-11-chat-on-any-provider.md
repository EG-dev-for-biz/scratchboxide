# Process: The chat agent on Gemini, Claude or OpenAI, picked per chat

> **Recorded:** 2026-11-11
> **Status:** Partly verified. Gemini path verified live through the new provider-neutral loop; Claude and OpenAI verified on recorded/constructed streams only. Live Claude/OpenAI runs are blocked: the keys in the secrets files are revoked.
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

## 3. What Broke / Didn't Work

* **Claude and OpenAI live runs** — both keys stored in `~/.scratchbox/secrets.json`, the repo's `secrets.json` and `.env` (one value each) are rejected by the providers themselves:
  - Anthropic: `401 {"type":"authentication_error","message":"invalid x-api-key"}` (also with the standard `x-api-key` header from curl, so not the adapter).
  - OpenAI: `401 invalid_api_key` for the `sk-svcac…` key.
  - Needed: valid keys in Settings > Models & AI (or replaced in the secrets file), then the object build and the 3D Building starter re-run on each provider.

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
