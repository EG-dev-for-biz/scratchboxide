# Process: The 3D/VFX product gate (SCRATCHBOX_PRODUCT_SCOPE=3d-vfx) in the live app

> **Recorded:** 2026-10-30
> **Status:** Verified (gate holds everywhere tested; the two gate gaps it found, the timeline's silent React Player button and copy that still invited apps, specs and boards, are fixed and re-checked live, §2b; chat still renders markdown tables flat, which is not the gate's and matters more with the gate on)
> **Tags:** `operate-scratchbox` `product-scope` `gate` `chat` `spotlight` `sidebar`
> **Target Domain:** Generative Canvas studio / Gemini Agent Chat / server routes

---

## 1. Session Context

* **What prompted this session:** the live check of the temporary 3D/VFX product gate (commit b6551d97, `common/product-scope.ts`, AGENTS.md §4) with the switch on, after its unit tests passed.
* **Instance used:** web port `3610`, API port `3611`, tools port `3612`, launch entry `scratchbox-product-scope` (`SCRATCHBOX_PRODUCT_SCOPE=3d-vfx` in its `env` arguments), this checkout at `3fe6253f` plus other sessions' uncommitted work. Viewport emulated at 1280 x 800.
* **Scope tested:** home starter buttons, the sidebar "+" menu, Spotlight (⌘K), an off-scope slash command, opening a new 3D scene and video timeline, View As on a 3D scene, the timeline header's morph buttons, a real agent-mode chat request for a kanban board, deep write over HTTP, and reopening a saved session that holds a code sandbox.

---

## 2. What Was Tested & What Worked (Verified)

* **Starter buttons** — loaded the home page → 3D Scene, 3D Building, 3D World, Video NLE; Interactive App is gone. Evidence: DOM button list, `test-results/screenshots/product-scope/01-starters.jpg`. No console errors on load.
* **Sidebar "+" (new workspace file)** — opened the menu → New Chat, 4D Scene (the app's label for the 3D scene), Video Timeline; Code, Document and Kanban are gone. Evidence: `02-sidebar-add.jpg`.
* **Off-scope slash command** — sent `/kanban` → a local assistant note: "`/kanban` is off: this build of Scratchbox is limited to 3D and VFX projects and does not offer kanban boards. Ask for a 3D scene or a video timeline instead." No request to the model. Evidence: `03-slash-kanban-note.jpg`.
* **Spotlight** — ⌘K → canvases listed are New 3D Scene and New Video Timeline only; searching "new" shows chat, 3D scene, video timeline and a recent session, nothing else. Evidence: `04-spotlight-new.jpg`.
* **New 3D scene and new video timeline** — both opened from Spotlight with no console errors; the scene shows the neutral studio with its "No geometry" notice, the timeline its NLE. Evidence: `05-new-3d-scene.jpg`.
* **No sandbox "+" tab and no View As on a 3D scene** — the canvas header has Focus Chat / Maximize / Fit / More only. View As renders nothing because every morph target of a 3D scene (`primitive-transformer-engine.ts` `MORPH_TARGETS['3d-scene']`: document, kanban, node graph, dashboard, sandbox) is out of scope, so `ViewAsMenu` returns null.
* **The model, asked for a board** — Agent mode, "Make me a kanban board to track the shots for my short film: storyboard, shoot, edit, done." → answered by gemini-4-argon: "This build of Scratchbox is limited to 3D and VFX projects, so interactive Kanban boards are not available on the canvas stage", gave the shot list as a markdown table in the chat, and offered three in-scope next steps (a video timeline, storyboard frames, a 3D previz scene). No canvas opened; no canvas tool was called (the server log has no "limited to 3D" refusal, so the prompt alone steered it). Evidence: `06-model-refuses-kanban.jpg`; saved reply in `desktop-app/.scratchbox/sessions/session-chat-1793410152235.json`.
* **Deep write** — `POST /gemini/deep-write/pipeline` with the launch token → `HTTP 403 {"success":false,"error":"This build of Scratchbox is limited to 3D and VFX projects, so deep write (documents, boards and plans) is off."}`.
* **A saved session holding a code sandbox** (`session-chat-1793039254697`: live-code-sandbox, 3d-scene, 3d-scene, saved mode `code`) — opened → shown as chat, no sandbox tab or stage. After the app wrote the session back, `artifactHistory` and `activeArtifact` (the sandbox) were unchanged on disk. Another saved session (`session-chat-1793033361283`) opened its 3D scene from the chat's "Open 3D" card with only the scene's tab.

### 2b. The two gate gaps, fixed and re-checked (same day, same ports and launch entry)

* **Out-of-scope buttons are hidden** — the timeline's "React Player", the browser page's "Morph to Code Sandbox" (Quick Actions drawer) and a generated image card's "Insert into Code" each make a code sandbox; each now shows only when `canCreatePrimitive('live-code-sandbox')`. Live: a new timeline's header has Smart Razor Cut and 3D Stage only; a browser page opened as a chat link opens it (example.com) lists Inspect DOM, Capture Screenshot, Run JS and Emulate iPhone only. Evidence: `08-fixed-timeline-and-chat-note.jpg`, `10-fixed-browser-quick-actions.jpg`. The image card is covered by a unit test (no image was generated live).
* **Every gate refusal is said in the chat** — the seven refusals that went to the hidden toast (`useCanvasOpeners` morph and code preview, `useCreateEmptyCanvas`, `useWorkspaceFiles` file open and new file, the studio's sandbox tab and open-primitive listener) now post a local assistant note through `chat/scopeNote.ts`, which the `/kanban` note also uses. Live: a media card's `scratchbox:open-primitive` event for a kanban board → the note "This build of Scratchbox is limited to 3D and VFX projects: it makes 3d-scene and video-timeline canvases only, so no kanban-board was created." in the chat beside the timeline, no tab opened. Evidence: `08-fixed-timeline-and-chat-note.jpg`.
* **Copy names only what the build makes** — gate on: headline "A canvas for 3D and VFX work. What scene or shot can I help you build today?", composer "Prompt a 3D scene, a building or a video edit... (/ for skills, @ for context)", sidebar "+" title "Add file to workspace (Chat, 4D Scene, Video Timeline)". Gate off: unchanged. Evidence: DOM read and `09-fixed-home-copy.jpg`.
* **A companion is not created by the open-primitive event** — the same event for `interactive-browser` now says "…so no interactive-browser was created." in the chat. That is the gate as designed (companions show when the app opens them, as a chat link does, and are never created on request); before the fix it failed silently. No UI sends that event for a browser today (`MediaCards.tsx` sends it for 3D scenes, timelines and sandboxes only).
* **Tests:** `packages/core/test/product-scope-gate.test.ts` (14 tests) renders the timeline header and an image card with the gate on and off, checks the headline and placeholder, and drives four refusals with the gate on (a morph to a sandbox, a code preview, an empty kanban canvas, a new code file): each posts an assistant note and touches neither the stage, the tabs nor the toast.

---

## 3. What Broke / Didn't Work

* **Timeline "React Player" button (gate gap, fixed — §2b)** — clicked it on a new timeline → nothing visible happens. The button morphs the timeline into a live-code-sandbox (`primitives/VideoTimelinePrimitive.tsx` `handleMorphToCode`); `useCanvasOpeners.ts` `handleMorphArtifact` refuses it correctly, but says so with `showToast`, and toasts are not displayed anywhere in the app, so it fails silently.
  - Console evidence: none — failed silently.
  - Network evidence: n/a.
  - Suspected cause: the button is not gated by `canCreatePrimitive('live-code-sandbox')`, and the morph refusal goes to the invisible toast instead of a chat note (the slash commands already use a chat note for this reason).
* **Copy still offers what the gate removes (gate gap, fixed — §2b)** — the home headline ("design, build, or analyze"), the composer placeholder "Prompt any creation (3D, apps, specs, boards)…" and the sidebar "+" tooltip "Add file to workspace (Chat, Code, Document, Kanban)" are unchanged with the gate on.
* **Markdown tables in chat render as one run-on line (not the gate's)** — the model's reply is a correct GFM table with line breaks (checked in the saved session JSON), but `ChatMarkdownRenderer.tsx` has no table rendering (no `<table>` output at all), so the rows run together. It matters more with the gate on: chat is where the model now puts anything that is not a 3D scene or a timeline.
* **The empty skill picker stays open after `/kanban` (minor)** — the input clears and the note posts, but "SELECT SKILL (/SKILL) — No matching skills" stays up until Esc. Not checked for other slash commands.
* **Reopening a chat session rewrites its saved layout mode (not the gate's)** — `session-chat-1793039254697` was saved back with `layoutMode: "chat"` (was `"code"`). The restore picks `session.fileType` ('chat') before `session.layoutMode` (`hooks/useSessionHandlers.ts:112`), so this happens with the gate off too; read from the code, not re-run with the gate off. The file was put back byte for byte from a backup after the check (sha1 `8c16db77…`). `session-chat-1793033361283` was saved with `layoutMode: "3d"` after "Open 3D" was clicked; its earlier value was not backed up.
* **Not from the gate, seen on the way:** opening an empty 3D scene posted an automatic "Visual check (gemini-3.8-flash) 35/100" note, a vision-model call that scores the empty studio; one `PUT /workspace/sessions/session-chat-1793033361283` answered 500 and the retry 200.

---

## 4. Candidate Tool/Service Ideas

* **A scope-aware UI audit route** — `GET /debug/product-scope` listing, for the running build, every creation surface (starter buttons, Spotlight actions, sidebar menu items, primitive header buttons) and whether each is offered. This session found the React Player button only by reading a screenshot of a timeline; a list would catch every primitive-level button at once.
* **Open a session by id** — a route or `?session=<id>` URL parameter. Several sessions share a title in the sidebar, and this session had to call the sidebar's React handler from the page to open a specific one.
* **A visible notice channel** — toasts were removed app-wide, but `showToast` still has many callers whose messages now go nowhere. The gate's refusals now go to the chat (`chat/scopeNote.ts`), but the rest do not: for example `useWorkspaceFiles` "Could not open <file>: <reason>" and `useCreateEmptyCanvas` "No empty <type> canvas can be created here". Either route `showToast` to the chat as a local note or remove the callers.

---

## 5. Reproduction Steps

1. Add a launch entry that runs the checkout with `SCRATCHBOX_PRODUCT_SCOPE=3d-vfx` among its `env` arguments, on three free ports (`operate-scratchbox` skill), and start it with `preview_start`.
2. Open `http://127.0.0.1:<web>/?token=<token from ~/.scratchbox/launch-token.json>`.
3. Check the starter row, the sidebar workspace "+" menu, ⌘K, and send `/kanban`.
4. Open New 3D Scene and New Video Timeline from ⌘K; the timeline header offers Smart Razor Cut and 3D Stage (before the fix it also offered "React Player", which did nothing).
5. In a new chat (Agent mode) ask for a kanban board for a short film's shots; the reply refuses and puts a table in the chat.
6. `curl -X POST -H "x-scratchbox-token: <token>" -H 'content-type: application/json' -d '{"prompt":"x"}' http://127.0.0.1:<api>/gemini/deep-write/pipeline` → 403.
