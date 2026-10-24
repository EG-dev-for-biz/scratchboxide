# Process: Pipeline I (Trellis) live on the Puck Building, and the training capture it feeds

> **Recorded:** 2026-10-24
> **Status:** Verified (one bug found and fixed in the session)
> **Tags:** `operate-scratchbox` `staged-location` `pipeline-i` `trellis` `training-capture`
> **Target Domain:** Real-world 3D locations (isolated structure) / chat build

---

## 1. Session Context

* **What prompted this session:** the user asked to see pipeline I work in the app, right after the training capture (`cloud-store/building-training-capture.ts`) was wired into the staged build.
* **Instance used:** web port `3140`, API port `3141`, tools port `3142` (own entry `scratchbox-training-capture` in `.claude/launch.json`, main checkout).
* **Scope tested:** a chat request to build the Puck Building (295 Lafayette St, New York) as an isolated building with pipeline I; the training records it wrote to `gs://scoutscan-building-training`.

---

## 2. What Was Tested & What Worked (Verified)

* **Pipeline I on Puck.** The prompt "Build the Puck Building, 295 Lafayette St, New York in 3D as an isolated building using pipeline I (Trellis)." ran these stages:
  - Vector massing, 3D Tiles and the remeshed scan committed.
  - The Facade grammar slot (pipeline I) committed in 3 min 59 s.
  - The progress line showed Trellis jobs on Fal (`fal-ai/trellis/multi`), six seeds in parallel.
  - The viewport showed the fitted Trellis model: red brick, arched ground floor, window bays, the roof water tower (screenshot `test-results/screenshots/2026-10-24-puck-pipeline-i-trellis.jpg`).
  - The run as a whole finished with 1 degraded part; I didn't check which stage it was. It wasn't pipeline I.
* **Seed scores** (0.7 × silhouette IoU + 0.3 × plan IoU): 7 = 0.808, 11 = 0.734, 23 = 0.763, **41 = 0.825 (kept)**, 59 = 0.733, 73 = 0.812.
* **Fit to the scan:**
  - plan IoU 0.776;
  - 89 % of the footprint covered;
  - 14 % of the model outside the footprint (reported, not clipped);
  - height ratio 1.05;
  - yaw 300°;
  - footprint 1,724 cells, 46.2 m tall.
* **Training capture, live.** The server log shows `[training-capture] fal-ai/trellis/multi delivered pair 3e97ffa1c1d9802dd83c for run 4cdf209b (11 files)`. The bucket holds the record plus its blobs:
  - **Files:** the textured and clay scan, the 4 views, the sheet and its reference, and the fitted textured, clay and raw Trellis model.
  - **Labels:** `targetKind: model-output`, `trainAllowed: true`.
  - **Notes:** all six seed candidates.
* **Failed runs are captured too.** The first attempt (below) also wrote a record: `outcome: failed`, with its reason, scan inputs only.

---

## 3. What Broke / Didn't Work

* **Pipeline I could not find `FAL_KEY` in the desktop app.** The first run degraded at once:
  - Message: ``pipeline I failed (pipeline-i-trellis needs FAL_KEY: pipeline I builds its model on Fal.ai: add FAL_KEY to secrets.json ...)``.
  - The key is in the checkout's `secrets.json`, but `resolveFalKey` (`pipeline-i/fal-queue.ts`) looked only in `process.cwd()`. The backend runs in `desktop-app/`, so it never found it.
  - **Fixed:** the lookup now also tries the checkout root found from the module's own location, as `gemini-client.ts` does. The rerun found the key.

---

## 4. Candidate Tool/Service Ideas

* **Run-record reader for pipeline I.** A tool returning the grammar-stage run note (seeds, scores, fit, sheet QC) by run id. I had to read the training record from GCS to get the seed scores, because the UI shows only the stage summary.
* **Training-bucket browser.** A small panel or tool listing captured pairs: place, outcome, trainAllowed, fit, with links. I had to check the bucket with a hand-written script.

---

## 5. Reproduction Steps

1. Add a launch entry on free ports (here 3140/3141/3142) for the main checkout; `preview_start` it; open the token URL from `preview_logs`.
2. New chat; send the Puck prompt above.
3. Watch the Facade grammar stage reach "committed · inferred" (about 4 min).
4. `preview_logs` with search `training-capture` shows the pair id; the record is at `gs://scoutscan-building-training/training/building/v1/records/<id>.json`. Capture runs only where `trainingBucket` is set in `~/.scratchbox/cloud-store.json`.
