# Process: the window check in the viewport's chrome, a popup while the remesh runs

> **Recorded:** 2026-11-08
> **Status:** Verified (popup during a live remesh, selection, Verify and the labels on disk; the corner card once the build had finished)
> **Tags:** `operate-scratchbox` `pipeline-k` `window-check` `labels` `3d-viewport` `staged-build`
> **Target Domain:** Generative Canvas / 3D Viewport (3D Building), pipeline K window arrays

---

## 1. Session Context

* **What prompted this session:** the user watched pipeline K build the Empire State Building and saw the window check
  (PR #186, `docs/processes/2026-11-07-window-check.md`) come up as a small white card with a Material-blue header at
  the top-left of the viewport. They asked for it in the app's own look, and as a popup centred on the screen while the
  remesh stage runs, since that is dead time for the viewer. The data path (what is drawn, what is saved) was to stay.
* **Instance used:** web port `3090`, API port `3091`, tools port `3092` (a `scratchbox-window-check-popup` entry in the
  main checkout's `.claude/launch.json`, not committed), running the `claude/window-check-popup` worktree with
  `SCRATCHBOX_STORE_BUCKET=off`, `SCRATCHBOX_WINDOW_CHECK_SOURCES` pointed at the one cache on this machine whose window
  fit carries site evidence (`worktrees/k-height/.scratchbox/cache/tile_refine`) and `SCRATCHBOX_WINDOW_LABELS_DIR` in
  the session scratchpad, so the test answers never enter the real label store.
* **Scope tested:** a fresh (uncached) 3D Building build from the starter button; the card's placement while the remesh
  stage ran and after Verify; selecting tiles; the answers on disk; no card after it was answered.

---

## 2. What it does

1. **One chrome for the viewport's panels** (`stagedBuild/viewportChrome.ts`): the dark glass panel
   (`rgba(18,18,22,0.92)`, a hairline border, 10 px corners, the system font at 12 px), the text and muted colours, the
   secondary button and the accent `#56B4E9` the staged-build overlay already used for its active toggles. The overlay
   now reads these tokens; nothing about it changes on screen.
2. **The card** (`stagedBuild/WindowCheckCard.tsx`) is drawn in that chrome: an uppercase "Window check" eyebrow, the
   instruction with "window" in the accent, the muted optional line, a 3 x 3 grid of 6 px-radius tiles with a 2 px
   hairline border, a selected tile bordered in the accent with an accent check badge and the photo drawn a little
   smaller, the count, Skip as the secondary button and Verify as the primary (accent fill, dark text). The Material blue
   and Roboto are gone. `WindowCheckPanel` is the card given its data; `WindowCheckCard` fetches the check and answers
   it as before.
3. **Where it shows.** `useStagedBuild` now reports `remeshRunning` (`stagedBuildState.ts` `isRemeshRunning`: the run
   is live, not interrupted, and its `remesh` stage is running, read from the scene state with the streamed stage events
   merged). While that holds, the card is a popup centred over the viewport on a dimmed, blurred backdrop
   (`aria-modal`, focused on open, Escape skips). Otherwise it sits beside the toolstrip at the top-left as before. A
   popup open when the remesh finishes moves to the corner with its selection kept; the thank-you note always shows in
   the corner, so the viewport is never held once there is nothing to answer.
4. **Unchanged:** `GET /3d/window-check`, `POST /3d/window-check/:id`, `labels.jsonl` with each site's evidence and
   field names, the control sites, "once per build per browser session", "answered sites are never asked again".

---

## 3. What Was Tested & What Worked (Verified)

* **Check served:** `curl 127.0.0.1:3091/3d/window-check` returned a check of nine tiles from the k-height cache
  (`relief_orthos_k_dd7178e1f54a7a3d`, the Empire State Building).
* **Popup during the remesh:** the 3D Building starter button sent its prompt; the agent called `google_3d_tiles_get_clay`
  (pipeline K); the tiles committed at 15 s and the remesh stage started. The scene opened on the canvas and the card
  came up at once as a popup centred over the viewport on a dimmed backdrop, the staged-build panel reading
  "Remeshed scan — ● running" behind it (`docs/screenshots/window-check-popup/01-popup-during-remesh.jpg`, zoom in
  `02-popup-zoom.png`; the accessibility tree: `listitem "Remeshed scan: running, 37.7 seconds"`).
* **Selection:** clicking the first and ninth tiles gave them the accent border, the badge and the shrink; the count read
  "2 selected"; the buttons read `aria-pressed="true"` (`03-popup-two-selected.jpg`).
* **Verify:** posted and answered `Thanks: 7 answers saved (kept aside: a known image was answered differently).`
  The note showed in the corner card, the backdrop gone and the building fully visible (`04-after-verify-corner-note.jpg`),
  and the card closed itself 2.5 s later. The console showed no new errors (two unrelated `409`s from the project
  artifact merge on page load, retried to `200`).
* **On disk:** the scratch `labels.jsonl` gained 7 lines, each with `key`, `source`, `facadeId`, `box`, `window`,
  `evidence` (the array's row), `fields`, `check`, `trusted: false` (the test clicks missed the sure-window control, as
  the note said) and `version`. Unchanged from PR #186.
* **No second ask:** a reload of the same tab showed no card for the run (session storage); the server's answered-site
  set is unchanged.
* **Independent look:** a small multimodal model read the four screenshots against the claims above and found them
  holding: card centred, chrome dimmed behind it, two tiles bordered and badged, the backdrop gone after Verify. Its two
  caveats: the 800 x 500 captures are too small to read the eyebrow and sub-line (12 px and 11 px on the 1440 x 900
  page), and the popup covers part of the staged-build panel in the dimmed layer, which is the point of a modal.
* **Corner placement after the build:** the uncached build finished (run state "Finished: Google 3D Tiles, Remeshed
  scan, Real textures in the scene"; textures committed at 11 min 5 s). The app instance was then restarted at the
  user's ask and the saved session reopened in a new tab (fresh session storage): the card came up in the corner beside
  the toolstrip, `data-placement="corner"`, no backdrop in the page, the staged panel's run state readable and the
  console clean (`05-after-build-corner.jpg`). Skip closed it and stored nothing (the scratch `labels.jsonl` kept its 7
  lines).
* **Tests:** `window-check-card.test.ts` (both placements, the selection state, the buttons, the thank-you note, the
  remesh predicate on fixture states), `staged-build-overlay.test.ts`, `pipeline-k-window-check.test.ts` pass on Node
  22.18 with credentials unreachable; `npm run typecheck` clean.

---

## 4. What Broke / Didn't Work

* Nothing in the feature. Two things in the setup: the live cache of this checkout holds no `tile_refine` folder, so the
  check had to be pointed at another worktree's cache (`SCRATCHBOX_WINDOW_CHECK_SOURCES`); and the first screenshot after
  a click showed the old state (a hidden pane repaints late), so each state was read from the accessibility tree before
  it was screenshotted.

---

## 5. Candidate Tool/Service Ideas

* **A list route for live staged runs** (`GET /gemini/staged-runs`): the run id is only knowable from the chat stream
  or the run folder, so a session watching a build from outside the page cannot poll its stage states; a list of live
  runs with their current stage would let the operate skill wait for "remesh running" instead of screenshotting.
* **Window-check sources in the ledger:** the run ledger could name which builds carry window-array evidence, so a
  session need not grep every `window_fit.json` on the disk for `"evidence":[`.

---

## 6. Reproduction Steps

1. Add a launch entry on free ports for your worktree (operate-scratchbox skill §2) with
   `SCRATCHBOX_WINDOW_CHECK_SOURCES=<a tile_refine cache with window-array/9+ orthos>` and
   `SCRATCHBOX_WINDOW_LABELS_DIR=<a scratch folder>`; `preview_start` it.
2. `curl 127.0.0.1:<api>/3d/window-check` must return `check`, not `reason`.
3. Open the app, click the 3D Building starter button. When the tiles commit the scene opens; while the staged panel
   reads "Remeshed scan — running" the card is a centred popup. Select, Verify: the note moves to the corner and closes.
4. When the run has finished, open the saved session in a new tab (fresh session storage): the card comes up in the
   corner, never as a popup.
