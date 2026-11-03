# Extraction reach: leaf tiles by plan distance, the whole radius

**Date:** 2026-11-03
**Status:** fixed and verified with real extractions (Empire State Building and Penn Station, 250 m, uncached).
**Branch:** `fix/district-reach-plan-leaves` (from main `676d9978`).
**Routed by:** MAIN (2026-11-03): priority 1 for the Penn district comparison.

## 1. The defect

`Google3DTileBlockoutPipelineService.fetch3DObject` took the leaves the crawl selected, which are every leaf whose plan
footprint touches the circle at any height. It then kept the 524 whose box centres lay nearest the anchor in 3D.
- **Tall buildings lost their tops.** A tower's upper leaves sit high above the anchor, so they ranked as far away and
  were the first dropped. That broke AGENTS.md §5's atomic building integrity.
- **Dense districts stopped short.** 524 leaves reach about 81 m at Penn Station, so every massing rebuild there failed
  with "the footprint runs past the extraction".

## 2. The fix

- **`selectLeavesByPlanReach`** (Google3DTileBlockoutPipelineService.ts):
  - **Order.** Leaves are ranked by the plan distance of their footprint from the anchor (`footprintDistance`). A
    tower's leaves count as near as its base.
  - **No cap by default.** Every leaf the radius touches is kept. The crawl's own limit stays the budget: past 6,000
    leaves it refuses with `DistrictTooLargeError`.
  - **A cap a caller sets** (`maxLeaves`) cuts at a plan distance, never inside a column of leaves at one distance.
  - **Reach is still reported.** The covered radius is the nearest dropped leaf's (`coveredRadiusMeters`,
    `truncated`, the staged `radius_truncated` degradation).
- **The extraction cache key** is now `extract/v3` (orchestrator, isolate-structure, streetview-survey), so no
  524-leaf extraction is served from the cache or the bucket mirror.
- **Dropped connections are retried** (GoogleTileDistrictCrawler `fetchWithRetry`). Every tile in the radius now
  downloads, and the first ESB run failed when Google closed one socket mid-tile ("other side closed"). A request or
  body read cut off like that is now retried with the same backoff as HTTP 429 and 5xx. A stop (`AbortError`) is not
  retried.
- **The tool descriptions** (`radiusMeters` on the extraction tools, the staged tool's radius) and the kd chunk note
  say the new rule.

## 3. Evidence

Each extraction ran in an empty directory on the Scratchbox SSD, so no leaf came from a cache:
`.scratchbox/examples/tools/reach_check.ts` (gitignored), through `getGoogle3DTilesFullTexture`. "Old rule" is the
524-nearest-in-3D selection, applied to the same crawl.

| 250 m | Leaves kept | Radius covered | Top of the GLB | Time | Peak RSS |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Empire State Building, now | 778 of 778 | 250 m | 441 m (the spire) | 16.6 s | 640 MB |
| Empire State Building, old rule | 524 | 0 m | 216 m (the highest leaf kept) | | |
| 2 Penn Plaza, now | 780 of 780 | 250 m | 232 m | 16.0 s | 575 MB |
| 2 Penn Plaza, old rule | 524 | 81 m | 188 m (the highest leaf kept) | | |

- **The ESB under the old rule:** 28 leaves within 60 m of the anchor were dropped, all of them more than 200 m up.
  Those were the tower's upper shaft and spire, so the reach collapsed to 0 m.
- **The Penn massing.** The district build `454f8a26` (this session's SSD instance, every leaf to 250 m: the same 780
  leaves) rebuilt 98 of 179 buildings.
  - All 34 buildings within about 150 m of the place that reached the check either passed (24) or failed for a reason
    other than reach: the scan raised past the footprint, or too little of the footprint raised. The nearest buildings
    (53 and 68 m away) and the 40,688 m² block 83 m away passed.
  - The 40 buildings still failing "past the extraction" lie at the district's edge. There the containment growth hit
    its 100 m cap (`DISTRICT_CONTAINMENT_MAX_GROWTH_M`), so their footprints cross the grown circle.
  - At 81 m reach, run `5805a429`, the district held only 8 buildings and all 8 failed for reach.
- **Tests** (run with credentials unreachable):
  - `tile-tools-do-what-was-asked.test.ts`:
    - the 625-leaf grid at 400 m now keeps every leaf and covers 400 m;
    - `selectLeavesByPlanReach` keeps a 12-leaf, 460 m tower whole under a cap that the old rule cut, cuts at one plan
      distance, and keeps a boxless leaf first.
  - `google-tile-district-crawler.test.ts`: a body cut off mid-read is fetched again; an abort is not retried.
  - Every test file that touches extraction passes, 280 tests in all with 13 skipped: the orchestrator, crawler, staged
    extraction, kd chunks, location tools, real-data staged runs and instruction drift. So does `tsc -p packages/core`.

## 4. What it costs

A 250 m extraction now holds every leaf there: about 780 in Midtown, against 524 before.
- **Time and memory.** About 16 s uncached and 0.6 GB for the extraction alone.
- **Size.** The textured GLB is 71 to 83 MB.
- **The build.** The staged build's later stages scale with the area: the Penn build's massing stage peaked at 11 GB
  of server RSS with the E detail on.
- **A cap.** A caller can still set `maxLeaves`, and the result says how far it reached.

The aerial-paint session's `SCRATCHBOX_STAGED_MAX_LEAF_TILES` (on `feat/district-aerial-paint`) is no longer needed
for reach. Kept, it would only be a cap below the radius.
