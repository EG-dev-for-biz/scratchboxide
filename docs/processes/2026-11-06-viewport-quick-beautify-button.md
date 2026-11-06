# Process: Quick AI Beautify button on the 3D viewport tool rail

> **Recorded:** 2026-11-06
> **Status:** Verified
> **Tags:** `operate-scratchbox` `ai-beautify` `3d-viewport` `tool-rail`
> **Target Domain:** Generative Canvas / 3D Viewport

---

## 1. Session Context

* **What prompted this session:** the user, looking at a staged Empire State Building scene, asked for a one-click
  "AI Beautify the current view and download it" button on the viewport tool rail — distinct from the full
  survey/station beautify workflow (`survey_beautify_station` / `BeautifyStationService`).
* **Instance used:** web port `5120`, API port `5121`, tools port `5122` (`scratchbox-viewport-quick-beautify`
  entry, added to `.claude/launch.json` for this session and removed afterward; worktree
  `.claude/worktrees/quick-beautify`, branch `feat/viewport-quick-beautify`).
* **Scope tested:** the new `QuickBeautifyButton` in `Scene3DPrimitive.tsx`'s tool rail, its
  `POST /api/viewport-beautify` route, and `viewport-beautify-service.ts`'s prompt building and model call.

---

## 2. What Was Tested & What Worked (Verified)

* **Button renders in the tool rail** — opened a fresh 3D Scene canvas and prompted "a simple wooden stool" to get
  real geometry on screen (mid-build, still on a revision pass). The rail showed a sparkle-icon button titled
  "AI Beautify this view and download it" (`data-testid="sb-3d-quick-beautify"`), positioned right after
  `CameraSettingsControl`, before Translate. Evidence: `find("AI Beautify")` matched the button; a zoomed
  screenshot of the rail confirms its icon.
* **One click captures, beautifies and downloads** — clicked the button while the viewport showed the in-progress
  (visibly malformed: extra stray rods) stool build. The button went into a spinning "AI Beautify… Ns" state, then
  showed "Saved \<file\> (gemini-3.1-flash-lite-image)". Evidence: `POST http://127.0.0.1:5121/api/viewport-beautify`
  → `200 OK`; the browser's native download fired a file to `~/Downloads/a_simple_wooden_stool_beautify_20261106-112801.png`
  (448,962 bytes) — filename matches `<scene-name>_beautify_<timestamp>.png` exactly.
* **Exact camera framing and scene light kept** — the downloaded PNG shows the *same* malformed stool (the same
  stray rods sticking out at the same angles), the same studio-grey backdrop, the same flat/neutral light, turned
  into a photorealistic wood photograph — no invented geometry, no relighting. This confirms
  `KEEP_SCENE_LIGHT_SENTENCE` and the standard non-negotiable framing rules (`buildClayRenderBeautifyPrompt`, no
  `geoAnchor` on this scene so the no-place path was used) worked as intended.
* **Fast/cheap model used** — the status line and the response both named `gemini-3.1-flash-lite-image` (Nano
  Banana Lite) at `1K`, the configured default (`QUICK_BEAUTIFY_IMAGE_MODELS[0]`, `QUICK_BEAUTIFY_IMAGE_SIZE`).
* **No new console errors** — `read_console_messages({onlyErrors: true})` showed only two pre-existing
  `409 Conflict` entries from the app's own startup artifact-merge race (present before the click too, on a page
  load with no interaction); nothing new appeared after clicking AI Beautify.
* **Cost:** one Nano Banana Lite image generation call at 1K, well under $1 (the app's cheapest/fastest configured
  image model and size).

---

## 3. What Broke / Didn't Work

Nothing broke in this session. The error path (model/credential failure surfaced through the viewport's
`ViewportNotice` as a dismissable `beautify-error` entry, never a placeholder image) is covered by unit tests
(`viewport-beautify-service.test.ts`: "throws the model's own error rather than returning a placeholder image") but
was not forced live in this session (doing so would mean breaking credentials mid-session for every other user of
this shared dev box).

---

## 4. Candidate Tool/Service Ideas

* **Headless download capture for the Browser pane** — verifying the download required a manual `find`/`mdfind`
  sweep of `~/Downloads` by filename pattern after the click, since the Browser pane tools have no direct "list
  triggered downloads" call. A `read_downloads({tabId})` tool (returning path + size of files the tab's `<a download>`
  clicks produced) would replace that manual filesystem guesswork for any future download-producing feature.

---

## 5. Reproduction Steps

1. From the main checkout, `git worktree add -b feat/viewport-quick-beautify .claude/worktrees/quick-beautify origin/main`.
2. Add a `scratchbox-viewport-quick-beautify` entry to `.claude/launch.json` pointing `--prefix` at that worktree on
   a free port triple (this session used 5120/5121/5122); `preview_start({name: "scratchbox-viewport-quick-beautify"})`.
3. Navigate to the logged web port (`SCRATCHBOX_NO_LAUNCH_TOKEN` is on for this entry, so no `?token=` is needed).
4. Click the "3D Scene" starter, prompt anything (e.g. "a simple wooden stool"), wait for geometry to appear in the
   viewport (it doesn't need to finish its build).
5. Click the sparkle "AI Beautify this view and download it" button in the left tool rail (after the camera-settings
   button). Watch it show "AI Beautify… Ns", then "Saved \<file\>.png (\<model\>)".
6. Check `~/Downloads/<scene>_beautify_<timestamp>.png` for the result.
