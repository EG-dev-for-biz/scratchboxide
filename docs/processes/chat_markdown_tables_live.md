# Process: GFM pipe tables in the chat (ChatMarkdownRenderer)

> **Recorded:** 2026-10-30
> **Status:** Verified
> **Tags:** `operate-scratchbox` `chat` `markdown` `gfm-tables`
> **Target Domain:** Gemini Agent Chat / message rendering

---

## 1. Session Context

* **What prompted this session:** the 3D/VFX product gate check (`product_scope_3d_vfx_gate_live.md`, 2026-10-30) found that the chat shows the model's markdown tables as one run-on line of pipes. `ChatMarkdownRenderer.tsx` is a hand-rolled renderer and had no table support. The fix is independent of the gate.
* **Instance used:** web port `3610`, API port `3611`, tools port `3612` (a temporary `scratchbox-chat-tables` entry in this worktree's `.claude/launch.json`, removed afterwards; the launcher's Vite proxy injects the token, so the plain URL worked).
* **Scope tested:** a live model reply holding a table, the saved shot-list reply from `session-chat-1793410152235.json` (7 columns, `**bold**` ids, inline-code `[x]` cells), the table streaming in, a narrow chat column, and the light theme's colours.

---

## 2. What Was Tested & What Worked (Verified)

* **Live table reply.** In a new chat, asked: "Answer in chat only, no canvas: a small markdown table of four cinema lenses with columns Lens, Focal length (right-aligned), Field of view (centred) and Typical shot…". gemini-4-argon answered with a correct GFM table (`| :--- | ---: | :---: | :--- |`). It rendered as one `table.sb-chat-table`: 4 header cells, 16 body cells. The computed `text-align` of the header cells was left / right / center / left, and body cells matched. Bold lens names render as `<strong class="sb-chat-strong">`, focal lengths as `<code class="sb-chat-inline-code">`. Screenshot: `test-results/screenshots/chat-table-live-lens-reply.jpg`.
* **No flicker while streaming.** A MutationObserver on the reply logged each change of (tables, body rows, paragraphs or list items starting with a pipe row). It saw tables 0 → 1 with 1 row, then rows 2, 3 and 4 within 1.3 s, and `pipeText` stayed 0 throughout. Raw pipe rows never showed as text. A half-written last row is already a row that fills in place (the parser pads it), and the cursor sits after the last cell written so far.
* **The saved shot-list reply.** Copied `session-chat-1793410152235.json` into this worktree's gitignored `desktop-app/.scratchbox/sessions/` and opened it. It renders as text, then a 7 x 5 table (header Shot ID … Done; Storyboard to Done centred), then the paragraph and the three action pills, unchanged. Screenshot: `test-results/screenshots/chat-table-shot-list-wide.jpg`.
* **Wide table in a narrow column.** At an 820 px viewport the chat column is 476 px, and the table needs 694 px. It scrolls inside its frame (`.sb-chat-table-scroll`: clientWidth 474, scrollWidth 694, `overflow-x: auto`). The paragraph above stays 476 px, and the document has no horizontal scroll (`scrollWidth - clientWidth = 0`). Screenshots: `chat-table-shot-list-narrow.jpg` and `chat-table-shot-list-narrow-scrolled.jpg` (scrolled 220 px to the Done column).
* **Light theme.** With `body.sb-light` the frame is `#f8fafc` and header text is `#0f172a`, read from computed styles. No screenshot was taken in light mode.
* **Unit test.** `packages/core/test/chat-markdown-table.test.ts` (6 tests) passed under `env -i`, with no credentials reachable. It covers the shot-list reply (block sequence; 7 header cells; 35 body cells; alignment; bold and inline-code cells), lines that only contain pipes staying text, escaped `\|`, every alignment form, row padding and cutting, where the table ends, and streaming prefixes.

---

## 3. What Broke / Didn't Work

* **Short ids broke at the hyphen in a narrow column** ("SH-" / "010") with a 3.5em cell min-width. Fixed in this session by raising the min-width to 5em: the id column became 87 px and "SH-010" now stays on one line. A probe showed `max-width` on `td` has no effect in Chromium's auto table layout (140 px with and without it), so that rule was dropped.
* Unrelated to tables: the app's default session (an ESB build) logged four 404s for `/models/empire_state_building_350_fifth_avenue_n_iso_*.glb`. Those models live in another checkout's workspace.
* Unrelated, and already failing on HEAD: in `studio-decomposition.test.ts`, `GenerativeCanvasStudio.tsx` has 26 `useState` (limit 25), and `chat/MessageItem.tsx` uses index keys.

---

## 4. Candidate Tool/Service Ideas

* **Inject a chat message for rendering checks.** An API endpoint (dev only) that appends an assistant message with given markdown to a session would help. This session had to copy a saved session file into the workspace, or spend a real model call of about 70 s, just to see a known markdown string rendered.
* **Light-theme toggle for checks.** A URL flag or API call that switches the theme would help. Here `body.sb-light` was toggled by hand from the console.

---

## 5. Reproduction Steps

1. Add a launch entry on three free ports (`operate-scratchbox` step 2), run `preview_start`, and open `http://127.0.0.1:<web>/`.
2. Copy `desktop-app/.scratchbox/sessions/session-chat-1793410152235.json` from the main checkout into the worktree's `desktop-app/.scratchbox/sessions/`, reload, and open "Make me a kanban board…" in the sidebar.
3. Narrow the viewport to about 820 px and scroll the table frame sideways.
4. Or, in a new chat, ask for a small markdown table "in chat only, no canvas".
