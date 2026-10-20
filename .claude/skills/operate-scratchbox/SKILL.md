---
name: operate-scratchbox
description: Launch and drive a live, isolated instance of the Scratchbox IDE desktop app (desktop-app/) through the Browser pane — pick free ports, authenticate with the per-launch token, click/read/verify the canvas UI, and check console/network health — then record a dated findings report in docs/processes/. Use this whenever asked to run, test, demo, preview, or "operate" the Scratchbox app, to confirm a UI/canvas/3D-viewport fix actually works in the live app (not just that it compiles or type-checks), or to audit what in the app is and isn't currently working. Always use this before claiming any UI or canvas change works, even if the user doesn't name this skill or say "operate" explicitly.
---

# Operate Scratchbox IDE

## Why this exists

This repo's renderer (`desktop-app/src/main.tsx`) is a plain React app that talks to its backend over `fetch` — it does not need Electron to run. A `.claude/launch.json` entry runs it with `SCRATCHBOX_NO_ELECTRON=true`, so the whole app (canvas, Gemini agent, workspace/git) is drivable through the Browser pane like any web app. That means you can click through it, read its console/network, and verify a change actually renders — instead of trusting that code compiles.

The procedure below exists because the naive version (starting an entry without checking its ports) breaks in two ways the first time you hit them:
1. **Port collisions with other running sessions.** This app claims three ports, not one, and a collision on any of them crashes the backend a few seconds *after* it prints a "listening" line — easy to miss if you don't check `preview_logs`.
2. **A silent wrong-port trap.** The `vite:dev` script hardcodes `--port 3030` as a CLI flag, which overrides the `SCRATCHBOX_WEB_PORT` env var that `vite.config.ts` reads. Vite auto-increments past a busy port rather than honoring your env var, so the port you *asked for* and the port it actually *bound* can differ — never assume, always read it back from the logs.

## 1. Use your own launch entry, never the user's

`.claude/launch.json` in the main checkout holds the user's own entries. **`scratchbox-dev` is the user's app** (the newest `origin/main`, run from `.claude/worktrees/latest-main` on ports 3060/3061/3062). Never start, stop or edit `scratchbox-dev`, never use ports 3060-3062, and never touch `.claude/worktrees/latest-main`. `serve-public` (port 5180) is also the user's.

Add your own entry instead, named after your branch (e.g. `scratchbox-<branch>`), that runs **your** checkout with `npm --prefix <your worktree> run dev`. Remove it when you are done.

## 2. Pick a free triple of ports for your entry

The app needs three free ports simultaneously, or the backend exits with code 1 shortly after claiming to be "listening":

| Env var | Default | What breaks if it collides |
|---|---|---|
| `SCRATCHBOX_WEB_PORT` | 3030 | Vite dev server (the page itself) — auto-increments on conflict, doesn't fail loudly |
| `PORT` | 3001 | The Express API backend — hard crash, exit code 1 |
| `SCRATCHBOX_TOOLS_PORT` | 3002 | An isolated "tools" origin the backend also binds — hard crash, exit code 1, with a clear log line: `[Scratchbox Tools] Port <N> is already in use` |

Find a free triple (check the three you intend to use):
```bash
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(<web-port>|<api-port>|<tools-port>)\b'
```
Pick three ports nothing is listening on, outside 3060-3062. Then add your entry to `.claude/launch.json`:

```json
{
  "name": "scratchbox-<branch>",
  "runtimeExecutable": "env",
  "runtimeArgs": [
    "SCRATCHBOX_NO_ELECTRON=true",
    "PORT=<api-port>",
    "SCRATCHBOX_WEB_PORT=<web-port>",
    "SCRATCHBOX_TOOLS_PORT=<tools-port>",
    "SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:<web-port>,http://localhost:<web-port>",
    "npm", "--prefix", "<absolute path of your worktree>", "run", "dev"
  ],
  "port": <web-port>,
  "autoPort": false
}
```

The `SCRATCHBOX_ALLOWED_ORIGINS` line matters even though nothing asked for it yet: `desktop-app/server/app.ts`'s `resolveAllowedOrigins()` hardcodes only `:3000` and `:3030` as allowed CORS origins by default. Skip this and every mutating API call (POST/PUT, which is most of what the app does) silently fails CORS from any other port — the page loads, looks fine, and nothing works. `.claude/launch.json` is untracked (not committed).

Then call `preview_start({name: "scratchbox-<branch>"})`. If it errors `Port <N> is in use by another chat's dev server`, another session owns that port: do **not** stop it; pick another triple.

## 3. Get the real port and the auth token — don't assume either

Read `preview_logs` for the **actual** running server (`preview_logs({serverId, lines: 60})`). Look for these two lines near the bottom:
```
➜  Local:   http://127.0.0.1:<ACTUAL_WEB_PORT>/
🔑 Open in a browser: http://127.0.0.1:<ACTUAL_WEB_PORT>/?token=<TOKEN>
```
Use `<ACTUAL_WEB_PORT>` from this output, not the value you configured — if it collided with something you didn't catch in step 2, Vite silently moved on to the next free port. Then `navigate` to the **exact token URL**, not a bare `http://127.0.0.1:<port>/`:
```
navigate({ tabId, url: "http://127.0.0.1:<ACTUAL_WEB_PORT>/?token=<TOKEN>" })
```
Without the token in the URL the page loads but every API call 401s (you'll be looking at an unauthenticated shell, not the working app).

If `preview_logs` instead shows the backend exited (`exited with code 1`) with a `[Scratchbox Tools] Port <N> is already in use` line, that port wasn't actually free — go back to step 2 and pick a different `SCRATCHBOX_TOOLS_PORT`.

## 4. Verify the load is actually clean

Don't trust a screenshot alone — a blank or broken page and a fully working one can look similar mid-render. Check, in this order:
1. `read_console_messages({onlyErrors: true, tabId})` — expect `"No console logs."` A page full of `401 Unauthorized` means the token didn't take; a page full of `ERR_CONNECTION_REFUSED` means the backend isn't actually up on the port you think it is.
2. `read_network_requests({tabId, limit: 20})` — spot-check for failed requests, especially to the API port.
3. `computer({action: "screenshot", tabId})` — confirm it visually matches what you expect.

Only once all three are clean do you have a real, isolated, working instance to test against.

## 5. Drive the app for the actual task

Use the Browser pane tools (`computer`, `find`, `read_page`, `form_input`) to exercise whatever you're there to test — click the feature, type into the prompt box, trigger the canvas action — then re-run step 4's three checks after each meaningful interaction, not just once at the end. If you edit source to fix something, the dev server hot-reloads; reload the tab and re-verify rather than assuming the fix landed.

## 6. Record findings in docs/processes/

Scratchbox already has a catalog convention for this — don't invent a new one. Follow `references/findings-report-template.md` in this skill, which mirrors the exact structure used by every existing file in `docs/processes/` (see e.g. `docs/processes/google_3d_tiles_fresh_ingestion_and_cdp_proof_capture.md` for a worked example).

1. Create `docs/processes/<slug>.md` using the template. Fill in real evidence — exact console/network error text, the actual ports used, screenshot descriptions — not a generic summary. Only mark something `Status: Verified` if you actually ran it and saw it work in this session; if something is broken or unconfirmed, say so plainly (`Status: Needs Fix` / `Status: Unverified`) rather than rounding up. This repo's own `AGENTS.md` bans claiming success without live subprocess/UI evidence — follow that here too.
2. Append one row to the table in `docs/processes/README.md`, matching its existing `| Date | Process Title | Target Domain | Tags | Status |` columns exactly, linking to the new file.
3. The findings template includes a **Candidate Tool/Service Ideas** section — use it. Every time you hit something the app's existing HTTP API or in-app tool-registry can't do cleanly (something you had to work around via raw UI clicks, or a verification step you had to hand-roll), write it down there as a concrete, scoped idea, not a vague wish. That backlog is the actual point of doing this systematically instead of ad hoc.

## Known pitfalls (already hit once, don't rediscover them)

- **Stealing another session's server.** If `preview_start` reports a collision, it's telling you someone else is using it — work around it (step 2), don't stop it.
- **Trusting the configured port over the logged one.** `vite --port 3030` in `desktop-app/package.json`'s `vite:dev` script always tries 3030 first regardless of `SCRATCHBOX_WEB_PORT`, then silently increments. Always re-read the actual bound port from `preview_logs`.
- **Forgetting `SCRATCHBOX_TOOLS_PORT`.** It's easy to remember the two obvious ports (web, API) and miss this third one — it's the one that produces the most confusing failure (API "listening" message prints, then the process dies anyway).
- **Forgetting `SCRATCHBOX_ALLOWED_ORIGINS`.** Symptom is specific: GETs work, the page looks fine, but anything that mutates state silently does nothing and the only evidence is a CORS error in the network tab, not the console.
- **Navigating without the token.** Produces a page that visually loads but 401s on everything — easy to mistake for "it's working, just empty."
