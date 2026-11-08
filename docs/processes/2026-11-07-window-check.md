# Process: the window check, a CAPTCHA-style labelling card in the 3D Building feature

> **Recorded:** 2026-11-07
> **Status:** Verified (card, crops, answers and skip live in the app; no labels collected yet beyond the test answers)
> **Tags:** `operate-scratchbox` `pipeline-k` `window-array` `window-check` `labels` `3d-viewport`
> **Target Domain:** Generative Canvas / 3D Viewport (3D Building), pipeline K window arrays

---

## 1. Session Context

* **What prompted this session:** the user asked whether a regressor or small model would help the window-array
  decisions. The answer was yes, for the accept-or-reject decisions now made on hand-set contrast cut-offs, provided
  labels exist. The user then asked: "whenever the 3D building feature is loaded, do a quick test like a CAPTCHA test".
* **Instance used:** web port `3270`, API port `3271`, tools port `3272` (a `scratchbox-window-check` entry, not
  committed), with `SCRATCHBOX_STORE_BUCKET=off`, `SCRATCHBOX_WINDOW_CHECK_SOURCES` pointed at the 2026-11-07 builds'
  orthos replayed on `window-array/9`, and `SCRATCHBOX_WINDOW_LABELS_DIR` in the session scratchpad.
* **Scope tested:** the card appearing when a 3D Building scene loads, its crops, selecting, Verify, Skip, the answers on
  disk, and one request per build.

## 2. What it does

1. **The array records its evidence** (`window-array.ts`, `window-array/9`). Every empty site it judged is written to
   `window_fit.json` (`array.evidence`, `SITE_EVIDENCE_FIELDS`). Each row holds:
   - the box;
   - the decision: outside the array, added, withheld, behind an occluder, or stepped into a blank band;
   - the site's window contrast against the wall around it;
   - the share the photo covers and the share occluded;
   - its row's and column's mean contrast;
   - its row's and column's share of boxes.
   The output is unchanged; the record is the training data's features.
2. **The check** (`pipeline-k/window-check.ts`, `GET` and `POST /3d/window-check`) draws seven sites the array was least
   sure of from earlier builds on the machine:
   - added on contrast under the add bar, or unread;
   - withheld within twice the contradiction line;
   - left outside the array though its own contrast reaches the step bar.
   It takes the nearest their cut-off first, from the closest quarter. It adds one site the array is sure is a window
   (a box kept on its site) and one it is sure is wall (outside the array, contrast at most -0.6) as controls.
   - **Crops:** each shows the site and two site sizes around it, tone-stretched for the eye over the photo only, with
     the site outlined in yellow. Past the facade's edge is a quiet grey.
   - **Answers:** appended to `labels.jsonl` in the label store with the site's evidence and the field names. They are
     trusted only when both controls were answered right. A skipped check stores nothing; answered sites are not asked
     again.
3. **The card** (`WindowCheckCard.tsx`) asks "Select every image where the yellow box is on a window", says it is
   optional, and shows a 3 x 3 grid with a count of those selected, SKIP, VERIFY and close, when a 3D Building scene
   loads.
   - It appears once per build per browser session, and one request per build is shared by remounts.
   - Nothing shows when the server has no check.
   - Sources: the cache's `tile_refine` plus `SCRATCHBOX_WINDOW_CHECK_SOURCES`; the store is `window_labels` under the
     cache or `SCRATCHBOX_WINDOW_LABELS_DIR`.

## 3. What Was Tested & What Worked (Verified)

* **Sources found** in the four replayed builds:

  | Building | Uncertain | Sure window | Sure wall |
  |---|---|---|---|
  | 30 Rock | 376 | 645 | 103 |
  | Penn 2 | 363 | 119 | 3 |
  | Seagram | 120 | 964 | 22 |
  | Lever House | 401 | 37 | 0 |

  Lever House has no sure wall and is skipped.
* **API:** `GET /3d/window-check` returned nine crops of 200 px.
* **Card on scene load:** opening a saved 30 Rockefeller Plaza 3D Building session (run 0c4e8230) showed the card in the
  viewport beside the tool strip (`test-results/screenshots/window-check-card.jpg`). After the context and tone stretch
  were added, the crops read clearly: the dark 30 Rock and Seagram facades show their windows and the pattern around the
  outlined site (`window-check-card-zoom.png`).
* **Select and Verify:** two images selected showed the tick and shrink (`window-check-selected.png`). Verify posted
  `200`, the card thanked and noted the answers were kept aside, and `labels.jsonl` gained seven lines. Each carried its
  evidence row and `trusted: false`, since the test clicks missed the sure window. The console showed no errors.
* **Skip:** after a reload with the session storage cleared, one `GET` was made (the double request fixed) and Skip
  posted. The card closed and no line was stored.

## 4. What Broke / Didn't Work

* Before the fix, the first load made two `GET /3d/window-check` requests (React's development double effect), drawing
  a second check that was never answered. Fixed with one shared request per build.
* The first crops (one site of context, no tone stretch) were too dark and too tight to judge on 30 Rock. Fixed as above.
* An independent visual check by a small model found the header and the body asking two different questions
  ("images with windows" against "the outlined box is a window"), small and slightly uneven tiles, a selection too subtle,
  and framing that read like a bot check. Fixed: one question ("the yellow box is on a window"), "optional" said,
  420 px card, square tiles at full width, a blue outline and a count on selection, and titles on SKIP and VERIFY.
* Past a facade's edge the crop's grey was stretched to white on dark facades. The tones are now set over the photo only
  (`test-results/screenshots/window-check-card-final.jpg`).
* Nothing else observed broken.

## 5. Candidate Tool/Service Ideas

* **Open a saved run's scene in the app.** A route or menu that opens a staged run's artifact from a run record, so a UI
  test of the 3D Building overlay needs no build. This session wrote a session file by hand from the build's
  `tool_result.json`.
* **Label review page.** A page listing `labels.jsonl` with each crop, the answer and trust, so wrong answers can be
  corrected before fitting.

## 6. Next

1. Collect labels: about 1,260 uncertain sites on the four builds, roughly 180 checks.
2. Fit a logistic regression on the trusted labels, holding out one building at a time, against the hand-set cut-offs.
   Commit it like the material set-fit regressor only where it wins on the held-out building.

## 7. Reproduction Steps

1. Replay or build a pipeline K building on `window-array/9`, so its `window_fit.json` carries `array.evidence`.
2. Start the app with `SCRATCHBOX_WINDOW_CHECK_SOURCES` set to the folder holding its `relief_orthos_k_*`, or build in
   the app so its cache holds them.
3. Open a 3D Building scene. The card appears top left of the viewport.
