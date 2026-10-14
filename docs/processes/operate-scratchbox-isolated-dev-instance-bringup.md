# Process: Operating Scratchbox IDE via Claude Code's Browser Pane — Isolated Dev Instance Bring-Up

> **Recorded:** 2026-10-12
> **Status:** Verified
> **Tags:** `operate-scratchbox` `dev-tooling` `browser-pane` `port-conflicts` `cors` `claude-code`
> **Target Domain:** Developer Tooling — Claude Code Browser-Pane Automation of `desktop-app/`

---

## 1. Session Context

* **What prompted this session:** Establishing whether Claude Code can directly operate a live instance of Scratchbox IDE (not just edit its source) — specifically, launch it through the Browser pane, authenticate, and verify it loads cleanly — as groundwork for using Claude to test and refine the app going forward. This produced the `.claude/skills/operate-scratchbox/SKILL.md` skill, and this report is that skill's first dogfooded run.
* **Instance used:** web port `3031`, API port `3011`, tools port `3012` (default `.claude/launch.json` ports 3030/3001/3002 were already claimed by another running session).
* **Scope tested:** cold bring-up of an isolated dev instance only — the "Scratchbox 2.0 Canvas" landing screen load and auth handshake. No app feature beyond the landing page was exercised in this pass.

---

## 2. What Was Tested & What Worked (Verified)

* **Isolated instance launch** — reconfigured `.claude/launch.json`'s `scratchbox-dev` entry with fresh, confirmed-free ports (`PORT=3011`, `SCRATCHBOX_WEB_PORT=3031`, `SCRATCHBOX_TOOLS_PORT=3012`, `SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3031,http://localhost:3031`) and called `preview_start({name: "scratchbox-dev"})`. Backend stayed up (no crash), Vite bound the expected port. Evidence: `preview_logs` showed `➜ Local: http://127.0.0.1:3031/` with no `npm error` lines, unlike the two failed attempts below.
* **Token-authenticated load** — navigated to the exact `http://127.0.0.1:3031/?token=<printed token>` URL from `preview_logs`. Evidence: `read_console_messages({onlyErrors: true})` returned `"No console logs."`; screenshot confirmed the "Scratchbox 2.0 Canvas" home screen rendered correctly (prompt bar + Interactive App / 3D Scene / Video NLE / System Spec / KPI Dashboard quick-action chips, no visible errors).

---

## 3. What Broke / Didn't Work

* **Attempt 1 — reusing default ports** — called `preview_start({name: "scratchbox-dev"})` with the unmodified config (3030/3001/3002).
  - Console evidence: n/a — refused before a page loaded.
  - Network evidence: n/a.
  - Cause: another already-running Claude Code session owned port 3030. `preview_start` refused outright with an explicit "another chat's dev server" error rather than failing silently.
* **Attempt 1b — manually navigating to the other session's URL anyway** — opened `http://127.0.0.1:3030/` directly (the already-running instance) out of curiosity about whether it was reachable.
  - Console evidence: 18 repeated `Failed to load resource: the server responded with a status of 401 (Unauthorized)` entries.
  - Cause: that instance's page loaded, but every API call needs that *other* session's launch token, which this session never had. Confirms you cannot piggyback on another session's running server even though the port responds.
* **Attempt 2 — new web/API ports, but default tools port** — set `PORT=3011`, `SCRATCHBOX_WEB_PORT=3031`, left `SCRATCHBOX_TOOLS_PORT` unset (defaults to 3002, also already claimed by the other session).
  - Console evidence: `net::ERR_CONNECTION_REFUSED` on every API call (`/workspace/config`, `/git/branches`, `/gemini/status`, etc.) after the page itself loaded fine.
  - Server log evidence: `[Scratchbox Tools] Port 3002 is already in use on 127.0.0.1. Stop the other process or set SCRATCHBOX_TOOLS_PORT to a free port.` followed by `npm error code 1` — the backend printed `🚀 ... listening on http://127.0.0.1:3011` and then died a moment later.
  - Cause: `desktop-app/server/index.ts:15` defaults `SCRATCHBOX_TOOLS_PORT` to `3002` independently of `PORT`/`SCRATCHBOX_WEB_PORT` — easy to miss since the "listening" line prints *before* the crash.

---

## 4. Candidate Tool/Service Ideas

* **Default-aware CORS origins** — `resolveAllowedOrigins()` in `desktop-app/server/app.ts:103-115` hardcodes only `:3000`/`:3030` as allowed origins. If it instead always trusted the origin implied by the live `PORT`/`SCRATCHBOX_WEB_PORT` values at startup, ad hoc port changes wouldn't require also remembering to set `SCRATCHBOX_ALLOWED_ORIGINS` by hand — this session had to discover that requirement by reading source, not from any error message (mutating calls would have failed silently with a CORS network error, not a console error).
* **Dynamic-by-default dev ports** — `.claude/launch.json`'s `scratchbox-dev` entry hardcodes all three ports as literals in `runtimeArgs`. A variant that lets all three float (true `autoPort` behavior across `PORT`/`SCRATCHBOX_WEB_PORT`/`SCRATCHBOX_TOOLS_PORT` together, with the actual bound values surfaced in `preview_logs`) would remove the manual `lsof` port-hunting this session needed, and would let multiple Claude Code sessions run concurrent instances of this app with zero coordination.
* **A `dev:doctor` preflight script** — a small script that checks whether the configured port triple is free *before* `npm run dev` spawns anything, and on conflict prints a ready-to-paste alternate `.claude/launch.json` block (or just picks one itself). Would collapse steps 1-2 of `.claude/skills/operate-scratchbox/SKILL.md` into a single command.

---

## 5. Reproduction Steps

1. Ensure `.claude/launch.json`'s `scratchbox-dev` entry has free ports for `PORT`, `SCRATCHBOX_WEB_PORT`, and `SCRATCHBOX_TOOLS_PORT`, plus a matching `SCRATCHBOX_ALLOWED_ORIGINS` — see `.claude/skills/operate-scratchbox/SKILL.md` for the full procedure.
2. `preview_start({name: "scratchbox-dev"})`.
3. Read `preview_logs` for the printed `🔑 Open in a browser: http://127.0.0.1:<port>/?token=...` line.
4. `navigate` to that exact URL (token included).
5. Confirm `read_console_messages({onlyErrors: true})` returns no errors and a screenshot matches the "Scratchbox 2.0 Canvas" landing screen.
