# Process: A live Google 3D Tiles failure reaches the viewport and the chat

> **Recorded:** 2026-11-03
> **Status:** Verified (no Maps key: viewport notice, no request to Google, honest reply; a key Google refuses: viewport notice with HTTP 400 and the next turn's reason; a 403 through the real tiles renderer by vitest only)
> **Tags:** `operate-scratchbox` `google-3d-tiles` `3d-viewport` `honest-status` `chat`
> **Target Domain:** Generative Canvas / 3D Viewport, Gemini Agent Chat

---

## 1. Session Context

* **What prompted this session:** on 2026-11-03 a test instance with no browser Maps key (port 3730, a worktree with no `.env`) mounted a scene at the Empire State Building with a `geoAnchor`. `TilesRenderer` failed (`Failed to load tileset ".../root.json" with status 403`), the viewport was empty, the error reached only the console, and the reply said the tiles were "streaming directly to the horizon". Only the visual check (38/100) noticed.
* **Instance used:** web port `3740`, API port `3741`, tools port `3742` (an own `scratchbox-musing-gagarin` entry in the worktree's `.claude/launch.json`, with `GOOGLE_MAPS_API_KEY` and `MAP_TILES_API_KEY` unset; not committed). The worktree has no `.env`, and the origin's storage held no Maps key. The server had its own key (`/api/geo/maps-key`: `configured: true, savedInSettings: false`), as on 2026-11-03.
* **Scope tested:** the live tiles layer with no key and with a key Google refuses; the chat turn that mounts a live tiles scene in a window with no key.

---

## 2. What Was Tested & What Worked (Verified)

* **No key: the viewport says why and how to fix it** — chat request "Open a 3D scene of live Google photorealistic 3D tiles streaming around the Empire State Building (40.748817, -73.985428): mount a 3d-scene with that geoAnchor. No staged build or extraction." → the model called `mount_canvas_primitive`; the viewport showed the red "3D Tiles unavailable" notice: *Live Google 3D Tiles are not shown: this app window has no Google Maps API key, and Google refuses the tiles without one (HTTP 403). Add the key in Settings > MCP Tools > Maps API Key; the tiles load once it is saved.* Evidence: `read_network_requests` matching `googleapis` returned none (no renderer was started); no console errors about tiles. Screenshot: `docs/screenshots/live-tiles-failure-2026-11-03/no-maps-key-viewport-and-reply.jpg` (gitignored).
* **No key: the reply says so** — the same turn's reply: "I mounted a 3D scene anchored at the Empire State Building (40.748817, -73.985428). Live Google 3D Tiles are not shown in the viewport right now because this app window has no Google Maps API key configured, and Google refuses the tiles without one (HTTP 403). Add a key in Settings > MCP Tools > Maps API Key — once saved, the live tiles will load automatically in the scene." It made no claim that tiles stream. The request carried `liveTilesUnavailable` (read from the page: `liveTilesUnavailableReason()` returned the message above).
* **A key saved in the window restarts the tiles** — `GoogleMapsService.setApiKey('test-invalid-key-not-real')` (window only, not through Settings, which would also send it to the server) → the tiles layer restarted with the new key within seconds, no reload.
* **A key Google refuses: the status reaches the viewport and the next turn** — Google answered the root tileset `400` (`API_KEY_INVALID`, read by a direct fetch: "API key not valid. Please pass a valid API key."). The viewport showed: *Google 3D Tiles did not load (HTTP 400 from Google): the Maps key was refused. Check in Settings > MCP Tools > Maps API Key that it is the right key, that the Map Tiles API is enabled for its project and that its restrictions allow this app.* `liveTilesUnavailableReason()` returned the same text for that key, so the next chat turn carries it. Screenshot: `docs/screenshots/live-tiles-failure-2026-11-03/refused-key-http-400.jpg` (gitignored). The first build of this check said only "HTTP 400 from Google" with no fix; a root 400 now gets the refused-key fix (`syncTilesLayer.ts` `tilesLoadFailureMessage`).
* **Clearing the key** — `setApiKey('')` → the notice returned to the no-key message; the origin's storage holds no key afterwards.

---

## 3. What Broke / Didn't Work

* **The first chat request took another path** — "Create a 3D scene at the Empire State Building with live photorealistic 3D tiles." → the model started `google_3d_tiles_get_clay` (a staged build on the server's key). A staged scene draws its own extracted tiles and asks for no live tiles, so neither the notice nor the mount note applies to it. The turn was stopped at the remesh stage; the survey stage already in flight still committed (`[staged-timeline] ffed7790 +72.6 s survey committed in 55.4 s`) and no later stage ran.
* **Not verified live:** a 403 (a valid key without the Map Tiles API) and a first scene whose key is refused mid-turn. A refused key is learned only when the viewport tries it, so the turn that first mounts with it can still finish before the failure; the viewport notice shows it, and every later turn carries it. The 403 path is covered by vitest through the real tiles renderer with a stubbed `fetch` (`live-tiles-failure-reporting.test.ts`).

---

## 4. Candidate Tool/Service Ideas

* **A window-only Maps key switch for tests** — set or clear the browser's Maps key for one origin without the Settings Save button (which also sends the key to the server, `maps-key-sync.ts`). This session imported `google-maps-service.ts` in the page and called `setApiKey` by hand to keep a made-up key away from the server's settings.
* **Read Google's error body on a refused root tileset** — the tiles renderer keeps only the status, so the notice cannot quote Google's reason (`API_KEY_INVALID`, `PERMISSION_DENIED`, the referrer restriction). This session fetched `root.json` with the made-up key by hand to read it.
* **A deterministic "mount this scene" action** — opening a scene from JSON without a model turn would test the viewport alone; this session had to word a chat request so the model chose `mount_canvas_primitive` over a staged build.

---

## 5. Reproduction Steps

1. Run a worktree with no `.env` and `GOOGLE_MAPS_API_KEY` / `MAP_TILES_API_KEY` unset, on a fresh origin (no Settings key in its storage).
2. In a new chat, ask for a scene of live tiles at a place with an explicit `geoAnchor` mount (the request in section 2).
3. Expect the "3D Tiles unavailable" notice with the no-key message, no request to `tile.googleapis.com`, and a reply that says the tiles are not shown and how to add the key.
4. In the page, import `packages/core/src/browser/generative-canvas/services/google-maps-service.ts` and call `GoogleMapsService.getInstance().setApiKey('<made-up key>')`: the notice changes to "Google 3D Tiles did not load (HTTP 400 from Google): the Maps key was refused. ...". Clear it with `setApiKey('')`.
