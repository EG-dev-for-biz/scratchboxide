# Process: Inclined-plane regions checked in a staged build of a pitched-roof building

> **Recorded:** 2026-10-20
> **Status:** Verified (slopes measurably flatter; `tile_refine` cost within noise). Context tiles in the viewport 403 on a non-default port (unrelated).
> **Tags:** `operate-scratchbox` `staged-build` `tile-refine` `scan-rectifier`
> **Target Domain:** Real-world 3D locations (Google 3D Tiles clay)

---

## 1. Session Context

* **What prompted this session:** PR #5 ([scan_rectifier_inclined_regions.md](./scan_rectifier_inclined_regions.md)) merged with two items open: a pitched-roof location, and a staged build in the app. On the ESB tile most of what it straightened was low-detail periphery.
* **Instance used:** web port `3070`, API port `3071`, tools port `3072`, in an entry of my own (`scratchbox-inclined-check`, since removed). It ran a detached worktree of `origin/main` at 1802c58d with its own `npm ci`, so `@scratchbox/core` came from `main`.
* **Scope tested:** the same request twice, in fresh chats: "Build Jefferson Market Library, 425 6th Avenue, New York in 3D (clay)". It is a Victorian Gothic library with steep pitched roofs and a tower.
  1. **With:** `main` as merged.
  2. **Without:** the same worktree with only `scratchbox_scan_rectifier.hpp` checked out at `3777db2c^1`, the pre-merge rectifier. `tile_refine` recompiled (1,592,504 → 1,587,800 bytes), so its cache key changed and nothing from build 1 was reused for the remesh.

---

## 2. What Was Tested & What Worked (Verified)

* **Both builds ran to the end.** Build 1 finished in 44.2 s; build 2 in 27.6 s.
  - Both ended `degraded` for reasons that have nothing to do with the rectifier: no Street View panorama looks at any face, the fit was rejected (coverage 83.5% < 85%), and the facade grammar was rejected by its held-out check.
  - The totals can't be compared. Build 2 reused build 1's resolve, tile, survey and ownership caches, and its remesh stage spent about 14 s compiling `tile_refine`.

* **`tile_refine` cost.** Each build ran it twice: the first pass, then again after the ownership vote. Timings come from each cache entry's `stats.json`.

  | pass | with (build 1) | without (build 2) |
  | :--- | :--- | :--- |
  | first: total / rectify / rectifier regions | 267 / 68 / 11 ms | 213 / 50 / 7 ms |
  | after the ownership vote: total / rectify / rectifier regions | 537 / 56 / 9 ms | 571 / 62 / 7 ms |
  | vertex groups moved by the rectifier (first, second pass) | 2,522 / 2,566 | 2,163 / 2,216 |

  The difference is a few milliseconds inside `rectify`, within the run-to-run noise of a sub-second step. The rectifier moves about 16% more vertex groups.

* **The slopes come out flatter.** I measured each output `clay.glb`: welded edges whose two triangles both face up at 10° to 78°, as the area share whose dihedral is under a threshold.

  | coplanar sloped neighbours | raw isolated scan | without | with |
  | :--- | :--- | :--- | :--- |
  | under 1° | 5.9% | 5.2% / 6.2% | **14.5% / 17.3%** |
  | under 2° | 12.8% | 12.3% / 12.2% | **24.7% / 27.0%** |
  | under 5° | 28.4% | 27.2% / 27.6% | **41.5% / 41.4%** |

  (Two values per build: the final pass and the first pass.) Before the change the roofs came out no flatter than scanned. With it, two to three times as many neighbouring slope faces are coplanar. Sloped area stays about the same (1,573 vs 1,551–1,566 m², raw 1,615 m²), so nothing was cut away.

* **What the rectifier found on the library.** I ran `run_scan_rectifier` (default parameters, its own visibility pass, so approximate) on build 1's isolated raw scan (`raw_clay.glb`):
  - 21 inclined regions, covering 683 m², about 43% of the sloped area;
  - 4 dropped as already explained by the walls;
  - 21 took the shared pitch and 20 turned to a wall direction;
  - walls (38) and level roofs (3) unchanged.

* **Visual comparison.** Both final clay outputs were rendered from the same fixed cameras: with on the left, without on the right.
  - The main pyramid roof and the gables read as broader, uniform faces with inclined regions; the same slopes are visibly faceted without.
  - Walls and the tower are unchanged.
  - Renders: `docs/screenshots/inclined_regions_app/jml_oblique_sw.png`, `jml_oblique_ne.png`, `jml_roofs_close.png`. App views: `app_build1_with.png`, `app_build2_without.png`. That folder is gitignored.

---

## 3. What Broke / Didn't Work

* **Context tiles in the viewport, on this port.** Opening the result streamed Google 3D Tiles in the browser, and the tileset request was refused.
  - Console evidence: ```Error: TilesRenderer: Failed to load tileset "https://tile.googleapis.com/v1/3dtiles/root.json" with status 403```
  - Network evidence: one `403` to `tile.googleapis.com`.
  - Suspected cause: not investigated. Likely the browser key's HTTP-referrer restriction, which allows the usual dev ports but not `127.0.0.1:3070`. The server-side build fetched its tiles without error, and the staged layers rendered.
* **Nothing broke in the rectifier or the staged build** in either run.

---

## 4. Candidate Tool/Service Ideas

* **Rectifier counts in `tile_refine`'s stats.** `tile_refine`'s `stats.json` reports only `wallRegions` and `roofRegions` from the rectifier. It should carry the rectifier's own `regions` block (inclined regions, pitch and direction snaps, explained). I had to rerun `run_scan_rectifier` on the cached `raw_clay.glb` to count inclined regions, which uses its own visibility instead of `tile_refine`'s.
* **A switch for A/B rectifier runs from the app.** An environment variable, read by `TileRefineService` and passed to the binary like `SCRATCHBOX_FACADE_GRAMMAR`, would let one instance compare with and without. I had to swap a header in a worktree and wait for a recompile.
* **A "same camera" capture of a staged layer.** A tool that renders a layer's committed GLB from named viewpoints, so two builds can be compared image to image. I rendered the cached `clay.glb` files with a scratch script, because viewport screenshots don't share a camera between chats.

---

## 5. Reproduction Steps

1. Create a worktree of `origin/main`, run `npm ci` in it, and add a launch entry with three free ports, `SCRATCHBOX_ALLOWED_ORIGINS` and `npm --prefix <worktree> run dev`.
2. Start it, open the tokened URL from `preview_logs`, and send "Build Jefferson Market Library, 425 6th Avenue, New York in 3D (clay)".
3. When `.scratchbox/cache/staged_location/runs/<id>/timeline.jsonl` has a `finish` line, keep `.scratchbox/cache/tile_refine/<key>/stats.json` and `clay.glb` for both passes.
4. In the worktree: `git checkout 3777db2c^1 -- packages/core/src/native/3d-engine/include/scratchbox_scan_rectifier.hpp`. Then send the same request in a new chat. `tile_refine` recompiles under a new cache key.
5. Compare the two runs' `stats.json` and measure the two `clay.glb` files (dihedral shares of sloped neighbours, as above). Restore the header with `git checkout HEAD -- <header>`.
