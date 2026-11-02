# Process: Fixing what the 2 Nov app tour found (lost models, chat ages, quiet open, NLE demo, forest page)

> **Recorded:** 2026-11-02
> **Status:** Verified (items 1-4 fixed and checked live, before and after); Needs Fix (item 5 explained, not fixed here; the shared model store is a proposal)
> **Tags:** `operate-scratchbox` `chat-sessions` `3d-viewport` `video-nle` `demos` `asset-store`
> **Target Domain:** Generative Canvas studio (chat list, session persistence, background visual check), 3D Viewport notices, Video NLE, static demo pages

---

## 1. Session Context

* **What prompted this session:** the live tour of 2026-11-02 (`docs/processes/app_tour_2026-11-02.md` in the main checkout, not committed) found five things a team demo would hit. This session fixed or explained each.
* **Instance used:** own launch entry `scratchbox-awesome-nobel`: web `4110`, API `4111`, tools `4112`, run from the worktree `awesome-nobel-5e8080` with `SCRATCHBOX_NO_LAUNCH_TOKEN=1` and `SCRATCHBOX_STATIC_DIR` pointed at the main checkout's stale `desktop-app/dist` (built 9 Oct), so the API behaves as it does in the main checkout. `scratchbox-dev` was not touched.
* **Test data:** eight of the user's saved chats copied into the worktree's `desktop-app/.scratchbox/sessions` (`sess-new-canvas` with St. Mark's Church and four other Manhattan builds, the Empire State Building, The Plaza, a kanban); the demo videos and `forest_hyperreal.glb` linked in from the main checkout (all gitignored).
* **Screenshots:** headless Chromium (Playwright) at 1600 x 1000, with `/gemini/verify-visual`, `/gemini/verify-and-repair` and `/api/assets/recover` intercepted and refused, so nothing was billed and no rebuild could start; each refused call is logged as evidence that the app tried it.

---

## 2. What Was Tested & What Worked (Verified)

* **Missing model files (item 1)**, commits `f5fbb6f7`, `982cccc4`.
  - Before: `GET /models/st_mark_s_church_in_the_bowery_131_east__iso_tiles_52c85820.glb` → `200 text/html` (the SPA fallback's `index.html`); the viewport retried five times and showed "4 models failed to load … `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`".
  - After: the same request → `404 application/json` `{"error":"not_found","message":"/models/… is not on this machine"}`; a present model (`/models/forest_hyperreal.glb`) and page routes (`/`, `/chat/x`) are unchanged. The viewport shows one plain status: "This build's files are not on this machine — 4 of its model files were not found here: the build ran in another checkout of the app, or its files were deleted." with the four file names. No retries.
* **Chat ages (item 2)**, commit `beb5d8b6`. Before: every chat "now" (all 197 saved chats hold `relativeTime` and `updatedAt` = `'Just now'`). After: 1h, 2d, 4d, 4d, 1w, 1w, 2d, 6d for the eight test chats, read from a stamped `updatedAt` (new) or, for older chats, the newest message id's time (`msg-<sender>-<Date.now()>`), else `savedAt`. The list is ordered by that time. After launching a demo into a chat (a real change) that chat reads "now" and moves to the top.
* **Opening a chat (item 3)**, commit `beb5d8b6`.
  - Before: clicking "Build 229 Mott Street…" sent `PUT /workspace/sessions/sess-new-canvas` within 4 s and again after Open 3D, and `POST /gemini/verify-visual` (refused by the harness; the chat then recorded "Visual check unavailable: Failed to fetch"). While this session ran, five of the same chats' files in the main checkout were rewritten between 08:09 and 08:12 by another instance, with no new messages in them.
  - After: open + Open 3D → no `PUT`, no `verify-visual`; all eight chat files byte-identical (shasum) afterwards. A real change still saves: launching the NLE demo into the chat sent exactly one `PUT`, stamped `updatedAt: 2026-11-02T16:32:19.248Z`, 12 messages.
* **VFX Matchmove NLE demo (item 4)**, commit `20f5ed80`. The demo's three videos exist and serve (`206 video/mp4` from the tour instance); the monitor never asked for them. After: the program monitor shows the real frame (the 50/50 blockout vs Omni restyle comparison at 00:00:02:15) and the three clip blocks show in their lanes.
* **Checks:** `npm run typecheck` exit 0; eslint 0 errors (no new warnings on changed lines); `lint_no_js_primitives` passed; vitest (credentials unreachable, empty HOME) 7 files, 105 tests passed, including the new `spa-fallback-missing-file`, `chat-activity` and `video-monitor-clip-source` tests.

---

## 3. What Broke / Didn't Work

* **Item 1, why the files are missing** — the builds ran in the worktree `upbeat-austin-817fb8`; 46 of the 53 model files the main checkout's chats reference but lack are in its `public/models`, 7 are nowhere (one build hit ENOSPC). Only 3 of the 166 chats with models are affected.
  - The app already has the shared store meant for this: the durable asset store (`~/.scratchbox/assets`, `scratchbox.db`; `packages/core/src/node/asset-store/`), which app.ts consults when a checkout lacks a served file. It has never run on this machine: `[asset-store] not available: node:sqlite is not available in this Node (v20.19.5); the asset database needs Node 22.13 or newer`. `.nvmrc` says 22 and Node 22.18.0 is installed, but nvm's default is 20, so `npm run dev` starts on 20. `~/.scratchbox/assets/blobs` is empty and there is no `scratchbox.db`.
  - Not built here (proposal in section 4).
* **Item 3, the asset recovery that follows a 404** — a 404 now goes to asset recovery at once (before, after five retries). With the store off it fails to start and nothing happens. With the store on, a file it never recorded comes back "unrecoverable" and the viewport rebuilds the location on its own (user decision, 2026-10-23), which for `sess-new-canvas` is five staged builds started by opening a chat. Left as decided; it needs the user's call before the store is switched on.
* **Item 5, `/forest_3d_viewer.html` draws grey spike trunks** — not fixed here; two causes:
  - The model. `public/models/forest_hyperreal.glb` (262 MB, 12 Oct, untracked, not in the hydration manifest) comes from `scripts/generate_forest_procedural_3d.cpp`. Each redwood is a tapered trunk with straight cylinder limbs (the spikes: `Forest_Trunks_And_Log`, 371,292 triangles), and the canopy is 2,061,948 needle slivers with a median area of 1.9 cm² (11.5 x 1.8 cm needles), invisible from the page's 32 m camera. Rendered alone with plain vertex colours, the canopy mesh is a faint green dust. The vertex colours themselves are right (bark brown, canopy green).
  - The page. It fetches 13 `textures/photo_*.png` files that the server now refuses (`404 application/json`, "Texture assets are served from the GCS texture library"), so bark, floor, fern and moss maps are blank and everything reads grey-beige under the page's fog and ACES grade. The GLB already embeds the same 15 PNGs (byte sizes match), so the page could use its own maps. Served locally (in the headless browser only), the textures turn the ferns green, but the trunks and spikes stay: the model is the main cause.
  - Fixing it means regenerating the forest with the SB-Veggie crown grammar (`scratchbox_sb_veggie.hpp`) and pointing the page at the GLB's embedded maps; a task of its own.
* **Seen in passing, not fixed:** in a fresh browser profile, the app starts on `sess-new-canvas` with an empty cached copy while the disk copy has 11 messages; launching a demo before opening the chat would save the chat with only the demo message. The first load of a fresh profile also once listed only the default chat until a reload.

---

## 4. Candidate Tool/Service Ideas

* **Turn on the shared model store (proposal, not built)** — run the dev server on Node 22 as `.nvmrc` asks (have `scripts/dev.js` re-exec under the `.nvmrc` version, or stop with a clear message on Node < 22.13), so the durable asset store records every build by content hash; sweep every `.claude/worktrees/*/public/models` once (the startup sweep covers only the server's own checkout), so the 46 files in `upbeat-austin-817fb8` are kept before that worktree is cleaned; and decide whether a chat opened to look at should rebuild lost files on its own or offer "Rebuild this location".
* **A quiet "view only" mode is now the default** — the tour's request is met by the fix; no tool needed.
* **Paid-call guard for live checks** — this session refused `verify-visual` and asset recovery in the headless browser by URL. A launch flag (`SCRATCHBOX_NO_PAID_CALLS=1`) that makes the server refuse paid calls with a clear error would make live verification safe in the Browser pane too.

---

## 5. Reproduction Steps

1. Add a launch entry on free ports with `SCRATCHBOX_NO_ELECTRON=true SCRATCHBOX_NO_LAUNCH_TOKEN=1 SCRATCHBOX_STATIC_DIR=<main checkout>/desktop-app/dist` and `preview_start` it; copy `sess-new-canvas.json` and a few other chats into the worktree's `desktop-app/.scratchbox/sessions`.
2. `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:<api>/models/st_mark_s_church_in_the_bowery_131_east__iso_tiles_52c85820.glb` → `404 application/json`.
3. In a fresh headless browser (refuse `**/gemini/verify-visual` and `**/api/assets/recover`), open the chat "Build 229 Mott Street…", press the last **Open 3D**, wait 45 s: no `PUT /workspace/sessions/*`, no `verify-visual`; the viewport notice reads "This build's files are not on this machine".
4. Settings → Admin & Demos → the "VFX Matchmove & Neural Video NLE" card's **Launch Stage**: the monitor shows the comparison video and the lanes show three clips; one `PUT` for the chat, which then reads "now".
5. `/forest_3d_viewer.html`: still grey spikes (item 5, not fixed).
