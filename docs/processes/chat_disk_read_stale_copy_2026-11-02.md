# Process: A stale browser copy of the open chat no longer overwrites disk

> **Recorded:** 2026-11-02
> **Status:** Verified (fresh-profile demo launch keeps all 11 messages on disk; the same flow on main cut them to 1. The "sidebar lists only the default chat until a reload" report was not reproduced.)
> **Tags:** `operate-scratchbox` `chat` `persistence` `sessions` `data-loss`
> **Target Domain:** Generative Canvas studio / chat persistence (`usePersistedChatState.ts`, `state/chatStore.ts`, `common/chat-session-merge.ts`)

---

## 1. Session Context

* **What prompted this session:** the 2 Nov app tour (`app_tour_fixes_2026-11-02.md`, branch `claude/awesome-nobel-5e8080`) found that a fresh browser profile starts on `sess-new-canvas` with an empty cached copy while disk holds 11 messages of it, and that launching a demo before opening the chat saves it with only the demo message.
* **Instance used:** web port `3770`, API port `3771`, tools port `3772` (own `scratchbox-interesting-boyd` launch entry, `SCRATCHBOX_STORE_BUCKET=off` so nothing synced to GCS), workspace root this worktree's `desktop-app`, holding copies of three chats from the main checkout (`sess-new-canvas` with 11 messages and two others).
* **Scope tested:** first load with empty localStorage, then Settings → Admin & Demos → "Maps Imagery Grounding (MIG) & 360 Panorama" → Launch Stage without opening the chat first; the chat file on disk read before and after each step.

---

## 2. What Was Tested & What Worked (Verified)

* **Fresh load, fixed code** — `localStorage.clear()` and reload → after the disk read, the open chat shows the 229 Mott Street messages without a click; the sidebar lists all three chats on disk. Network: `GET /workspace/sessions` (twice without `root`, the dev StrictMode double effect), `GET /workspace/sessions?root=…/desktop-app`, then one `PUT /workspace/sessions/sess-new-canvas`. That `PUT` changed only `visualAudit` on the last message (the existing background visual check, "No frame of the canvas could be captured", so no paid call); the read itself wrote nothing.
* **Demo launch, fixed code** — disk went from 11 messages to 12 (the 11 plus `msg-demo-1793639796524`), title "Build 229 Mott Street, New York as..." kept, artifact history 11 → 13 entries, the canvas tab strip showing the chat's earlier scenes beside the demo.
* **Same flow on main** (the hook and studio wiring set back to `HEAD` for one run, chat file restored first) — after the read the list highlights "Build 229 Mott Street" but the open chat is the empty home screen; after the demo launch `sess-new-canvas.json` went from 1.69 MB with 11 messages to 6.3 KB with 1 (`msg-demo-1793639837740`). The report reproduces exactly.
* **Proof sheet:** `docs/screenshots/chat_disk_read_before_after_2026-11-02.png` (gitignored), before row and after row.
* **Tests:** `packages/core/test/chat-disk-read.test.ts` (8 tests) fails on the old behaviour with the written chat holding only `msg-demo-…`, and passes with the fix; `chat-session-store.test.ts` still passes; `npm run typecheck` exit 0. Run with HOME empty and credential variables unset.

---

## 3. What Broke / Didn't Work

* **Main: the save after a fresh-profile demo launch drops the chat's history** (fixed here). The disk read merged disk's 11 messages into the chat list only; the open chat's live messages stayed the empty cached ones, and the save writes `{...listEntry, messages: live}`.
  - Console evidence: none, it fails silently.
  - Network evidence: `PUT /workspace/sessions/sess-new-canvas → 200` carrying 1 message.
  - Cause: `usePersistedChatState.ts` merged disk into `sessions` only, and saved before (or regardless of) that read.
* **Not reproduced: "the sidebar listed only the default chat until a reload".** Three fresh loads watched here (one on main's code, two fixed) all listed the three chats on disk. Not investigated further; it may need the main checkout's 200-chat folder or the first Vite dependency re-optimise reload.
* **Still on main, not this fix's: restoring a chat whose active artifact is a 3D scene, sandbox or browser runs the background visual check**, which stamps `visualAudit` on the last message and so rewrites the chat. Branch `claude/awesome-nobel-5e8080` stops that for chats opened from the list (`chatOpenCountRef`); the disk read should count as an open there too (see the hand-over note).

---

## 4. Candidate Tool/Service Ideas

* **A "chat on disk" read for tests** — `GET /workspace/sessions/:id` returning one chat's message ids and `savedAt`, so a live check can compare disk before and after an action without reading the 1.7 MB file from the shell.
* **A fresh-profile switch** — a `?fresh=1` query that starts the studio with empty localStorage, so a fresh-profile check does not need `localStorage.clear()` and a reload through the page's JavaScript.

---

## 5. Reproduction Steps

1. Copy `sess-new-canvas.json` (and any other chats) from a checkout's `desktop-app/.scratchbox/sessions/` into this checkout's.
2. Add an own launch entry with free ports and `SCRATCHBOX_STORE_BUCKET=off`; `preview_start` it.
3. Open `http://127.0.0.1:<web>/`, run `localStorage.clear(); location.reload()` in the page.
4. Without clicking the chat, open Settings → Admin & Demos → Launch Stage on any demo.
5. Wait 2 s (the save is debounced 1.5 s) and count the messages in `desktop-app/.scratchbox/sessions/sess-new-canvas.json`: the original count plus one.
