# Process: Pipeline K's facade lattice differs between two runs on a byte-identical scan

> **Recorded:** 2026-11-13
> **Status:** Open (no owner)
> **Tags:** `pipeline-k` `facade-lattice` `window-fit` `window-array` `determinism` `cache`
> **Target Domain:** Real-world 3D locations (pipeline K, remesh polish)

---

## 1. Session Context

* **How it was found:** comparing the partition shell's roof cap on and off (`2026-11-13-partition-shell-roof-cap-esb.md`) across two live ESB builds. A difference first blamed on the cap turned out to be a difference in the facade lattice the partition shell is given.
* **The two runs:** the same request (`Empire State Building, 350 Fifth Avenue, New York`, `isolate: true`, `trees: true`, `pipeline: 'k'`), the same worktree (`exp/partition-shell` at f3d90901), `SCRATCHBOX_K_PARTITION_SHELL=1`, `SCRATCHBOX_CACHE_RESTORE=off`. Only `SCRATCHBOX_K_PARTITION_SHELL_SET` differed (`topIsAir=1`, then empty), which changes only the polish cache key and the partition step.
  * **f550d704:** uncached (empty stage caches, fresh tiles); remesh key f53189c2…
  * **1959a465:** about 30 minutes later; resolve and tiles from cache, remesh rerun (key 769b0f5e…)
  * Both share tile_refine `a35ef369…` and orthos `relief_orthos_k_dd7178e1f54a7a3d`; their polish folders are `59717d54051f86a2` and `a2026e172428ecd1`.

---

## 2. What Was Seen

* **The cleaned scan is identical:** `step_cleanup.glb` is byte-identical in both polish folders (`cmp`).
* **The lattice is not:** `step_lattice.glb` differs. From each polish's `stats.json` (`lattice`), first run against second: cells 135,458 / 92,210; photo-recess cells 50,410 / 29,892; removed triangles 1,004,146 / 817,712; tear audit found 18,245 / 14,795; proud area 5,779 / 6,318 m². The partition shell then gets about 1.32 million against 0.83 million lattice triangles.
* **The window fit differs, though the second run calls it cached:** `pipeline_k_window_fit.json` has `cached: false` in the first run and `cached: true` in the second, yet 32 facades' window counts differ, among them facade 2 2,163 → 926, facade 33 1,304 → 938, facade 39 473 → 278, facade 3 180 → 72, facade 12 155 → 257. `pipeline_k_window_array.json` differs only in `system.reused` (false → true). `pipeline_k_reveal_depth.json` is identical; `pipeline_k_wall_grammar.json` differs. The window reader (`pipeline_k_window_reader.json`) was reused in the second run (`cached: true`) with the same counts (71 read, 57 replaced).
* **Downstream:** the partition shell is deterministic on a given input (repeat runs and one thread or six give the same output), so its result differs between the runs only because the lattice does. At one ESB setback column (3, 25) the closed solid tops at 270.5 m with the first run's lattice and 318.5 m with the second's, with the roof cap on or off.

---

## 3. What It Probably Means (not verified)

The second run's window fit came from a cache entry whose content is not what the first run computed for the same scan, or the first run's fresh fit was not what was stored. Either the window-fit cache key misses an input that changed (or that the first run's fit read and the stored entry did not), or the window fit is not deterministic and the cache stored a different evaluation. Since K's lattice, wall grammar, window recesses and glass all read the window fit, two builds of the same scan can differ substantially, and comparisons between builds are confounded by it.

---

## 4. Where To Start

* Rerun the window fit twice on the same orthos with caches off and compare `pipeline_k_window_fit.json`: if they differ, the fit is not deterministic (thread order, a model reply, a time budget); if they agree, find what the second run's cache key read.
* Look up which cache entry the second run's window fit was served from (`window-fit.ts`, its cache key and where it is written), and when that entry was made.
* Both runs' records are in the `exp/partition-shell` worktree under `.scratchbox/cache/staged_location/runs/f550d704` and `…/1959a465`, with the polish folders above.
