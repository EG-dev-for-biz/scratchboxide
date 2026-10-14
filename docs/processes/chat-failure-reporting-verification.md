# Process: Chat Failure Reporting — Unreachable Server vs. AI Request Errors

> **Recorded:** 2026-10-13
> **Status:** Verified
> **Tags:** `operate-scratchbox` `gemini-chat` `error-reporting` `streaming`
> **Target Domain:** Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** Every chat failure was shown as "⚠️ Scratchbox Backend Service Offline", including a Google `API_KEY_SERVICE_BLOCKED` rejection while the server was healthy; and when the model returned nothing (e.g. `finishReason: MAX_TOKENS`) the server built a template artifact from the prompt instead of reporting the failure.
* **Instance used:** web port `3032`, API port `3013`, tools port `3014` (the `scratchbox-dev` entry in `.claude/launch.json`; started from a shell because the Browser pane resolved `launch.json` from a different folder). Ports 3001/3002 were held by the Electron app and 3011/3012 by another dev server.
* **Scope tested:** the chat composer's three failure paths (server unreachable, server HTTP error, AI request error) and a normal successful message.

---

## 2. What Was Tested & What Worked (Verified)

* **Normal chat** — sent "In one sentence, what is a Gaussian splat?" → the model answered (and mounted a 3D scene of its own choosing). Evidence: no console errors; all API requests 200.
* **Server unreachable** — killed the API process on 3013 with the page still loaded, sent "What is 2 plus 2?" → reply: "⚠️ **Can't reach the Scratchbox server** — The app couldn't connect to its local server (Failed to fetch)…". Evidence: `ERR_CONNECTION_REFUSED` in the console, which is the outage itself.
* **AI request error** — restarted with `SCRATCHBOX_VERTEX_LOCATION=us-nowhere1` (Google answers with an HTML 404 page), sent "What is 4 plus 4?" → reply: "⚠️ **The AI request failed** — AI request failed (404): Error 404 (Not Found)!!1 404. That's an error. The requested URL /v1/projects/scoutscan/locations/us-nowhere1/publishers/google/models/gemini-2.5-pro:streamGenerateContent was not found on this server. That's all we know."
* **Unit coverage** — `packages/core/test/chat-failure-reporting.test.ts` (6 tests): the exact `API_KEY_SERVICE_BLOCKED` body a user saw maps to "The AI request failed" plus a Settings → Models hint; `RESOURCE_EXHAUSTED` gets a quota hint; HTML pages are reduced to text; an empty model turn with `MAX_TOKENS` emits an `error` event and no artifact; a normal text reply still emits `done`.

---

## 3. What Broke / Didn't Work

* **AI error with an HTML body (fixed during this session)** — the first attempt rendered Google's entire HTML/CSS error page into the chat bubble.
  - Console evidence: none; it was a rendering issue only.
  - Network evidence: `streamGenerateContent` → 404 `text/html` from `us-nowhere1-aiplatform.googleapis.com`.
  - Cause: `parseGoogleError` in `packages/core/src/browser/generative-canvas/hooks/chatFailureMessage.ts` handled JSON bodies only. It now strips HTML to its text; verified live on reload.

Nothing else broke.

---

## 4. Candidate Tool/Service Ideas

* **Fault-injection switch for the stream endpoint** — e.g. `SCRATCHBOX_FAULT=ai-403|empty-max-tokens|drop-mid-stream` on the dev server — to exercise each chat failure path on demand. This session had to fake an AI error with a bogus Vertex region, and could not trigger the `MAX_TOKENS` empty reply live at all (unit test only).
* **Dev-mode token endpoint for automation** — `/api/auth/token` now requires the token itself (correctly), so harnesses must start the app with `SCRATCHBOX_LAUNCH_TOKEN` preset. A documented `npm run dev -- --print-token-file <path>` would make scripted chat checks simpler.

---

## 5. Reproduction Steps

1. `env SCRATCHBOX_NO_ELECTRON=true PORT=3013 SCRATCHBOX_WEB_PORT=3032 SCRATCHBOX_TOOLS_PORT=3014 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3032,http://localhost:3032 npm run dev`
2. Open the `🔑 Open in a browser: …/?token=…` URL from the log and send any prompt (normal path).
3. Kill the process listening on 3013 and send another prompt: expect "Can't reach the Scratchbox server".
4. Restart step 1 with `SCRATCHBOX_VERTEX_LOCATION=us-nowhere1` added, reopen the new token URL, and send a prompt: expect "The AI request failed" with Google's 404 text.
5. `npx vitest run packages/core/test/chat-failure-reporting.test.ts`.
