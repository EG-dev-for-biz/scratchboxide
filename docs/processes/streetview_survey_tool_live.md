# Process: streetview_survey in the agent: Washington Square Arch and the Haughwout Building

> **Recorded:** 2026-10-19
> **Status:** Verified (both places surveyed and registered; outlines checked on a contact sheet; one fix made during the session)
> **Tags:** `operate-scratchbox` `location-evidence` `street-view` `registration` `staged-build`
> **Target Domain:** Gemini Agent Chat / real-world locations

---

## 1. Session Context

* **What prompted this session:** the staged build's Street View survey is now the in-app tool `streetview_survey` (`packages/core/src/node/gemini/tools/location-evidence/streetview-survey.ts`, in the location-evidence pack). It covers the structure from the staged caches, discovery with Google captures only, wide views per face through the Maps Imagery Grounding API with the 403 refusal retry, edge then joint registration, and the optional ownership and occluder masks. This session checks that the app's agent calls it and that the poses it returns put the structure where the photos show it.
* **Instance used:** web port `3062`, API port `3061`, tools port `3063`. It was started from the worktree with `npm run dev` and env vars, not from `.claude/launch.json`, with `SCRATCHBOX_PYTHON` set to the checkout's `.venv` (see section 3). The app was driven in the shared Browser pane by explicit tab id. Other sessions' tabs share the pane, and the active tab switched to one of theirs mid-session.
* **Scope tested:** three chat turns, each a new chat:
  * "Use the streetview_survey tool on "Washington Square Arch, New York" with maxViews 6 and ownershipMasks true", run twice.
  * The same for "Haughwout Building, 488 Broadway, New York" with maxViews 8.
  * The same handler was also run from a script, to get the payload and draw a contact sheet: the structure mesh outline rendered from each returned camera, plus the ownership mask edge.

---

## 2. What Was Tested & What Worked (Verified)

* **The agent picks the tool.** Each turn called `streetview_survey` once: 56 s, then 80 s with masks, for the arch, and 99 s for the Haughwout. The agent then reported the views, the methods, the residuals, the ownership and the coverage. The result cards are `arch_result_card.jpg` and `haughwout_result_card.jpg`.
* **Washington Square Arch.** The structure was isolated from the scan: 187 m², 21.9 m tall, four facades (33°, 123°, 213°, 302°). Discovery found 87 Google panos and rejected 192 user photospheres. There were 6 views and no refusals. All 6 were kept by the joint registration: the held-out chamfer improved from 6.31 to 6.19 px and the gradient NCC from 0.16 to 0.24.
  * Per-view residuals were 6.7 to 11.2 px (mesh edges against photo edges at 480 px wide). The cross-view match residuals were 1.9 to 2.8 px.
  * Coverage: 84 %, 80 %, 92 % and 80 % of the four faces.
  * In the contact sheet the red outline sits on the arch in 5 of 6 views. The sixth view is mostly hidden by trees. Its ownership was refused in the script run (IoU 0.006) and segmented in the chat run (IoU 0.38). The segmenter's vision step varies between runs.
* **Haughwout Building.** Discovery found 76 Google panos and rejected 113 photospheres. There were 8 views and no refusals. 5 were registered by edges, with residuals of 1.3 to 3.0 px at 900 px wide; 3 stayed nominal (7.6 to 12 px at the nominal pose).
  * The joint fit did not beat the per-pano choice (chamfer 6.98 vs 6.77 px), so the edge poses stand.
  * Coverage: Broadway (301°) 88 %, Broome (211°) 100 %, 166° 76 %, 256° 80 %, 346° 60 %. The 31°, 76° and 121° sides have no pano on their outward side, and the result says so.
  * In the contact sheet the outlines of the edge-registered views lie on the cornice and the corners.
* **Pitch sign and intrinsics.** Every view returns the request in the API's sign and the registered camera's elevation. `apiPitchDeg` is minus `elevationDeg`: a view looking up at the cornice has elevation 52.7° and API pitch −52.7°. The intrinsics follow fx = fy = (width / crop width) × 960 / tan(fov/2). For example, 1707 × 1280 at a requested 70° gives fx 1371.0 px and a true horizontal fov of 63.8°.
* **Image handling.** The bytes are written exactly as returned to `desktop-app/build/streetview-grounding/` (the workspace's `build/`, which is gitignored), under the `streetview_grounding_image` file names. The masks go to `masks/` beside them.

---

## 3. What Broke / Didn't Work

* **Faces after the first four were dropped (fixed this session).** The Haughwout pick has eight facade headings. The survey's `footprintSurveyFaces` keeps the first four, so the first run sent all six views to the 166° side and missed Broadway and Broome. The tool now keeps every facade (`structureFaces`, commit c2a18633). The rerun covered Broadway and Broome.
* **The Haughwout pick includes its neighbours.** The vector-footprint pick is 659 m² and 35 m tall. The red outline takes in the glass building to the north and part of the row to the south. This is the staged isolation's own pick and is reported as is. The ownership masks (green) follow the cast-iron front itself, so for texturing the mask is the better guide than the outline.
* **Segmenter without the venv.** The first arch run used the system Python, and every ownership view was refused: `Missing dependency: No module named 'cv2'`. The tool reported this per view and did not hide it. Restarting with `SCRATCHBOX_PYTHON=<checkout>/.venv/bin/python` fixed it.
* **Console noise.** The only console errors were `ERR_CONNECTION_REFUSED` and 401s from the tab while the server was being restarted with a new token. There were none during the tool runs.

---

## 4. Candidate Tool/Service Ideas

* **A contact-sheet output for streetview_survey** — an optional overlay per view (mesh outline and mask edge over the photo). This session drew it with a script that re-ran the handler, because the chat does not keep the tool's payload (`desktop-app/.scratchbox/sessions/*.json` holds the reply only). It needs a decision on writing re-encoded grounding pixels, which the tool does not do today.
* **Keep tool payloads in the session record**, so a later turn or a test can read the poses the agent was given, without rerunning the tool.

---

## 5. Reproduction Steps

1. In the worktree, symlink `secrets.json` (remove it afterwards). Start the app with `SCRATCHBOX_PYTHON=<checkout>/.venv/bin/python SCRATCHBOX_NO_ELECTRON=true PORT=3061 SCRATCHBOX_WEB_PORT=3062 SCRATCHBOX_TOOLS_PORT=3063 SCRATCHBOX_ALLOWED_ORIGINS=http://127.0.0.1:3062 npm run dev`, then open the token URL from the log.
2. In a new chat, ask: "Use the streetview_survey tool on "Haughwout Building, 488 Broadway, New York" with maxViews 8 and ownershipMasks true."
3. The images and masks are in `desktop-app/build/streetview-grounding/`. The synthetic test is `packages/core/test/streetview-survey-tool.test.ts`, which writes its contact sheet to `test-results/screenshots/tool_sv_survey/`.
