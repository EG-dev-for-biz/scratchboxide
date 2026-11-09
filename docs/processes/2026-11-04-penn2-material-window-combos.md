# Process: Penn 2, pipeline K material detection x window detection

> **Recorded:** 2026-11-04
> **Status:** Verified (6 uncached builds compared; 2 more timed out under machine load)
> **Tags:** `operate-scratchbox` `pipeline-k` `material-regions` `facade-reader` `penn-2`
> **Target Domain:** Staged locations / pipeline K textures

---

## 1. Session Context

* **What prompted this session:** choose the most believable combination of material detection (the vision finish reading, its thresholds, the appearance or spectrum pick, regions off) and window detection (facade reader or window fit alone) for 2 Penn Plaza, after the finish reading landed on `feat/k-material-finish`.
* **Instance used:** the `scratchbox-k-material` launch entry (web 3960, API 3961, tools 3962), worktree `feat/k-material-finish`. Each arm was started from a new chat with the same request ("Build a 3D building of 2 Penn Plaza (Penn 2), New York: isolate it and straighten it ..."), the server restarted with that arm's environment, and every stage cache moved aside first (`model_readings` and `runs` kept).
* **Evidence:** the labelled sheet `docs/screenshots/2026-11-04-penn2-material-window-combos.png` (gitignored, on the machine that ran it): four fixed viewport cameras per arm (curtain wall at 24 m and 75 m, podium at 55 m, corner at 150 m), the sun forced to 10 to 14 degrees, captured with the viewport's own frame capture.

## 2. What Was Tested & What Worked

| Arm | Run | Materials | Windows | Materials step | Build |
|---|---|---|---|---|---|
| A default | 47cc1a16 | finish read + look-pick | facade reader | 279 s | 686 s |
| B | 638eec37 | finish read + look-pick | window fit only (`SCRATCHBOX_K_FACADE_READ=0`) | 57 s | 363 s |
| C | 009f2569 | spectrum pick (`SCRATCHBOX_K_MATERIAL_PICK=spectrum`) | facade reader | 111 s | 472 s |
| E | 78193b7e | A + plain when the pick finds nothing alike | facade reader | 142 s | 598 s |
| F | 37b1766c | A + plain unless the pick confirms (commit 80cc4404) | facade reader | 122 s | 930 s |
| D | 9b45787e | regions off (`SCRATCHBOX_K_MATERIAL_REGIONS=0`) | window fit only (the reader does not run without regions) | n/a | 1163 s |

* **Glass class plain:** the dark glass class (L 38, 17% of facade texels) was read as smooth glass (roughness 0.15 to 0.2, confidence 75) in every arm and drawn plain; no more Snow005.
* **Prepared maps reused:** a set prepared in an earlier build was taken from the readings store (B, C, E, F each reused 1 or 2); the materials step fell from 247 to 279 s (cold) to 57 to 142 s.
* **Window detection:** reader and window fit give the same glass share (7.5% and 7.2% of texels); B's window fit alone put far fewer panes on stone (121 against 289 to 314). The sheet shows no visible difference in the curtain wall between A and B at these distances. The reader costs about 100 s and 6 to 12 model calls.
* **Spectrum pick (C):** re-splits the classes by texture (L 46 43%, L 57 28%); both were read confidently as metal (conf 80 and 85) and drawn as metal plates, so the upper curtain wall mirrors the sky in silver bands. The most distinct look of the set; whether it reads as Penn 2 is the user's call.
* **Regions off (D):** photo colour only; the flattest look, no grain and no sheen.

## 3. What Broke / Didn't Work

* **Wood on metal.** When the look-pick found no candidate like a class, or timed out, the ranking's nearest by numbers was drawn: the dark spandrel or louvre classes (read as metal, roughness 0.45 to 0.5) took Wood080 in A, B and E, and the wall took PavingStones068 in B and E. Fixed in commit 80cc4404: a confidently read class whose set the pick did not confirm is drawn plain at its read finish (metal when read as metal). F shows it: no wood, the wall plain at roughness 0.75.
* **The finish reading drifts and is never reused.** The same four classes (identical CIELAB means in A, B, E, F) were read differently every build: class L 53 metalness 0.7, 0.4, 0.3, 0.7; class L 44 confidence 70, 70, 70, 80. So threshold changes (`metalConf` 60 or 80, `plainBelowRoughness` 0.2 or 0.4) flip fewer classes than the drift does, and were not built. Cause: each build's twin differs by 1-LSB noise (the brief contact sheet differs by mean 0.001 per channel between builds), so the facade reader's brief is asked again and comes back reworded, and the finish prompt (which includes the brief) and the swatch sheet change, so the memo key misses. Not fixed here.
* **The look-pick timed out** in E (90 s, the grammar call's deadline) while the machine's load was over 300.
* **Two builds timed out** in the remesh (900 s budget) at load 300 to 600 from other sessions (runs fa30a4e4, 6abd416c); both were rerun.

## 4. Candidate Tool/Service Ideas

* Key model readings on a quantised image hash (for example a 64 x 64 box-filtered, 5-bit image) instead of the PNG bytes, so 1-LSB twin noise does not re-ask the brief, the finish reading and the look-pick each build.
* A headless "capture these camera views of this run's GLB" route, so arms can be compared without reopening chats in the viewport.
