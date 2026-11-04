# Process: K-D seam stage cuts SB-Roadie's streets at the chunk cell lines

> **Recorded:** 2026-11-04
> **Status:** Verified (street area drawn twice 153.4 m² before the cut, 0.0 m² after, in the uncached chunked run 9fac8fa5 at Penn with road kerbs on; no hole where a street was cut away)
> **Tags:** `operate-scratchbox` `pipeline-kd` `district-seams` `roads` `sb-roadie` `kerbs` `penn-station`
> **Target Domain:** Staged locations / chunked districts (K-D seam stage)

---

## 1. Session Context

* **What prompted this session:** the kerbs session found that in chunked K-D builds each chunk's street layer (`l1r`, SB-Roadie, with `SCRATCHBOX_STAGED_ROAD_KERBS=1`) is joined with the 3 m seam band while the ground is cut exactly at the cell lines, so street surfaces were drawn twice along every cell line a street crosses. PR #80 cuts the streets in the seam stage by the same owner as the ground.
* **Instance used:** launch entry `scratchbox-kd-seam-roads`: web port `4530`, API port `4531`, tools port `4532`. It ran the local branch `test/kd-seam-roads-kerbs`: PR #80 merged with the kerbs branch (PR #86), at the commits each run names in §2. Environment: `SCRATCHBOX_STAGED_DISTRICT=kd`, `SCRATCHBOX_STAGED_ROAD_KERBS=1`, `SCRATCHBOX_CACHE_RESTORE=off`, `SCRATCHBOX_OBJECT_REUSE=0`. The backend ran on Node 20.19.5, so the asset store was off.
* **Scope tested:** a chunked district at 2 Penn Plaza, New York (40.750316, -73.991722), 150 m radius: 9 cells of 120 m, the centre and 8 chunks. It was asked in the in-app chat: "Stage the real district around 2 Penn Plaza, New York, NY in 3D with a 150 m radius: the whole district from Google 3D Tiles, not one isolated building." Both runs were uncached: a fresh worktree for the first, and the stage caches cleared before the second.

---

## 2. What Was Tested & What Worked (Verified)

* **First run, `24121b69` (PR #80 at `27beb34a`: the owner read from the grounds alone)** ran from 22:06 to 23:41 and committed 9 chunks.
  - **The seam stage** (`district-seams/4`) cut all 9 grounds and all 9 street layers. The triangles cut per chunk are in `district_chunks_joined.json` under `seams.roads`.
  - **Street area drawn by two or more street layers,** measured over the whole district from the run's files at 0.2 m (plan view): 89.1 m² before the cut, 14.8 m² after it. The 14.8 m² that remained lay 1-4 m from the cell lines, not on them.
* **Why some doubling remained:** the centre build's ground is never carved under its own streets (see §3). The ground-only owner therefore handed the centre the street band past its cell lines, out to where its ground's coverage ends. There the street was cut off the line, and a triangle across that edge was kept by both chunks.
* **Fix, `d9a1d569`:** each chunk's coverage is now read from its ground and its streets together, and one owner still serves both.
  - **Replayed** on the first run's joined files (the replay reproduces the run's cut counts exactly with the old owner): street area drawn twice is 0.0 m².
  - **New unit test:** the centre's ground left uncarved over the band. With the grounds alone, the centre's street runs past x 62. With the streets read too, both chunks cut exactly on x = 60.
* **Run 2, `f982bb2a`** (PR #80 at `d9a1d569`): street area drawn twice went from 123.0 m² before the cut to 0.0 m² after it.
  - **What it actually ran:** the test merge picked up the kerbs head `214f7c95`, not `e4c808a9`. The kerbs session's pushes move the remote ref every worktree here shares.
  - **Its colours are not this PR's:** that kerbs head recoloured every chunk's streets from the last chunk ground committed (chunk 8's seam-cut ground, twin `f5ae7474`). This was reported, and it is fixed in kerbs `f3c72e20`.
  - **Fix on this PR, `440e6e1b`:** each street is cut as it stands when it is cut, so a recolour that lands during the stage is kept.
* **Run 3, `9fac8fa5`** (PR #80 at `440e6e1b` + kerbs `f3c72e20`; the test merge's parents were checked; uncached; 23.7 min at load 10-30). This is the result the sheet shows.
  - **Chunks:** all 9 committed. Chunk 6's trees stage degraded, and chunk 0 recorded a degradation at its finish; neither concerns the roads or seam stage.
  - **The centre's ground is now carved** under its streets: `road_carve.json` lists 3 layers.
  - **The recolour fired once,** from the centre's own ground.
  - **The cut:** the seam stage cut 9 grounds and 9 street layers in 66.7 s. Of 5,482 street triangles, 263 were cut at a cell line and 207 left to a neighbour; per chunk in `district_chunks_joined.json` `seams.roads`.
  - **Whole district** (each street GLB rasterised from above at 0.2 m): street area drawn by two street layers was 153.4 m² before the cut and 0.0 m² after.
  - **Streets cut away:** 114.4 m² of street drawn before is no longer drawn inside the circle (23.7 m² more past it, cut on the circle as the ground is). All of it lies against a cell line, on the side of a chunk whose own build drew no street there. 109.4 of its 109.6 m² is covered by that chunk's own cut ground, so it is not a hole.
  - **Close-ups** (sheet `kd_seam_streets_penn_9fac8fa5.png`), drawn twice before and after:
    - x = 60 line at z -90 (chunks 1 and 2): 52.4 m², then 0.0 m²;
    - x = 60 line at z -25 (centre and chunk 5): 48.4 m², then 0.0 m²;
    - z = -60 line at x 130 (chunks 2 and 5): 35.6 m², then 0.0 m².
  - **Each street ends exactly on the cell line** and continues on the other side.
* **Tests:**
  - `pipeline-kd-district-seams.test.ts` 13/13 and `staged-road-kerbs.test.ts` 16/16 pass on the final merge (Node 22.18, credentials unset);
  - `npm run typecheck` exits 0;
  - `staged-location-orchestrator.test.ts`: 34 of 44 pass; the other 10 hit the 180 s timeout at load 360-540, all isolate tests that never enter the chunks stage.

---

## 3. What Broke / Didn't Work

* **The K-D centre's ground is not carved under its kerbed streets.** This is on the kerbs branch, and it was reported to the kerbs session.
  - **Evidence:** the centre's `road_carve.json` lists no layers. The shown centre ground is `remesh_f455acce_kd0_f40cb6d1.glb`, and no `remesh_*_road_1d4ac70e` file exists. Every chunk's ground is carved, because each chunk's own build carves it.
  - **Cause:** the centre's layer transform runs `territoryClipper` first, which republishes the ground as `*_kd0_<hash>.glb`. `roadCarver` then skips it because the name matches `CHUNK_URL`.
  - **Effect:** inside the centre's cell, its scan ground stays under its own streets. With `d9a1d569` this no longer moves the street cut off the cell lines.
* **Stopping a chunked build in the chat does not stop its chunk builds.** After `469a1abe` (below) was stopped at its tiles stage, its 5 chunk builds kept running for up to about 50 minutes. They shared the machine with run 2 but wrote only their own place's files. Not investigated (district-chunks' `runChunk` and the stop signal).
* **The viewer's live Google tiles feed answers 403** in this instance (`TilesRenderer: Failed to load tileset "https://tile.googleapis.com/v1/3dtiles/root.json" with status 403`). The staged layers are not affected.
* **The textures-late stage reports `cached: true`** in every run's timeline, though it ran (384 s in run 2). A check for an uncached run that greps the timeline needs to know this.
* **First rerun attempt, `469a1abe`, geocoded to the wrong place.** The chat model passed the query "2 Penn Plaza, New York (7th Ave & W 32nd St)", which resolved to the Sheraton at 811 7th Ave and W 53rd St. The build was stopped at the tiles stage and re-asked without the cross street.
* **Where a street now shows the scan ground instead:** a street that only one chunk drew past its own line now shows the owning chunk's scan ground there. This happens where the owning chunk's build drew no street.
  - **Example:** at x 55-60, z -100 to -84, chunk 2's band-joined street lay in chunk 1's cell. Chunk 1 drew no street there.
  - **Before the cut,** chunk 2's street lay over chunk 1's uncarved ground there (the street a median of 7 cm under it). After the cut, chunk 1's ground alone is drawn.
  - **Why:** each cell shows its own chunk's surfaces. It is not a hole: chunk 1's cut ground covers 64.9 of the 78 m².

---

## 4. Candidate Tool/Service Ideas

* **`district_seam_audit`:** over a finished K-D run's shown layers, the plan area drawn by two or more layers of one kind (ground, streets), and the area no layer covers, per cell line. This session hand-rolled it in Python (rasterising each GLB's triangles from above) to measure the doubling.
* **A viewport camera API for the live app:** move the viewport camera to a frame point and heading by tool call, for repeatable close-ups of one spot across runs. The camera panel has lens settings only. This session steered by hand and could not frame a cell line in the viewport, so the close-ups are plan views drawn from the run's files.

---

## 5. Reproduction Steps

1. Check out PR #80 merged with the kerbs branch, `feat/road-kerbs-gutters` (PR #86), and add a launch entry with the environment in §1 on free ports.
2. Clear `.scratchbox/cache/staged_location/*` (keep `runs/`), `tile_refine` and `tile_vegetation`, then start the entry.
3. In a new chat, ask: "Stage the real district around 2 Penn Plaza, New York, NY in 3D with a 150 m radius: the whole district from Google 3D Tiles, not one isolated building." Check that `stages.json` resolves to 40.750316, -73.991722.
4. When `district_chunks_joined.json` appears, read `seams.roads`.
   - **Before:** the joined street files `public/models/*_roads_*_kd<N>_*.glb`, and the centre's `*_roads_<key>_kd0_*.glb`.
   - **After:** the `*_kd_roads_<chunk>_*.glb` files.
