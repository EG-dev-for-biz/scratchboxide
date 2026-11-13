# Process: The partition shell's roof cap on a live ESB build (pipeline K)

> **Recorded:** 2026-11-13
> **Status:** Needs Fix
> **Tags:** `operate-scratchbox` `pipeline-k` `partition-shell` `shell-fit` `roof-cap` `esb`
> **Target Domain:** Real-world 3D locations (pipeline K, partition shell experiment)

---

## 1. Session Context

* **What prompted this session:** the shell fit's roof cap (`topIsAir`: solid stops at the highest roof the scan shows; `roofLevels`, `capCellsAtRoof` in `scratchbox_shell_fit.hpp`) was merged into `exp/partition-shell` (8dd0ff9f) after offline tests on cached ESB, Flatiron and Dakota scans; this tries it inside K's partition shell in the live app.
* **Instance used:** web port `4720`, API port `4721`, tools port `4722` (launch entry `scratchbox-partition-roofcap`, the `exp/partition-shell` worktree), with `SCRATCHBOX_K_PARTITION_SHELL=1`, `SCRATCHBOX_CACHE_RESTORE=off`, and `SCRATCHBOX_K_PARTITION_SHELL_SET=topIsAir=1` for the first build, empty for the second.
* **Scope tested:** two ESB 3D Building builds (`google_3d_tiles_get_clay`, `isolate: true`, `trees: true`, `pipeline: 'k'`) through `POST /gemini/tools/run-stream`. The first was uncached (fresh tiles, empty stage caches); the second reused its upstream stages, so only the polish (partition shell) and the texturing differ.

---

## 2. What Was Tested & What Worked (Verified)

* **Passing solver settings from K** — `SCRATCHBOX_K_PARTITION_SHELL_SET` (comma-separated `key=number`, `partitionShellSettings()` in `pipeline-k/partition-shell.ts`) reaches `scripts/partition_shell.cpp` as `--set` pairs and is part of the polish cache key (`remesh-polish.ts`). The two builds produced different polish directories (`59717d54…` on, `a2026e17…` off). `partition_shell.cpp` now reports `roof: {topIsAir, levels, caps}`; the off build reports `{"topIsAir": false, "levels": 0, "caps": 0}` (the on build ran before the field was added).
* **The slabs go** — clay renders of `step_partition.glb` (`docs/screenshots/live_roofcap_ab.png`): with the cap off, a solid column stands from the tower to the volume's top in place of the antenna, with spikes at the setbacks; with it on, the top is clean and the antenna is residual scan. Solid top against the scan's top (point-in-solid along vertical lines): beside the shaft 442.5 → 378.5 m (scan 378.4 m); at the antenna base 442.5 → 388.5 m (its platform); what is left of the shell above 390 m is a pole about 1 m across on the antenna's axis (121 m²).
* **Shell measures** (off → on): generated share 0.167 → 0.139; shell non-manifold edges 2 → 0 (open edges 0 both); shell area 103,563 → 99,411 m²; volume 911,247 → 910,938 m³; scan within 0.5 m 0.924 → 0.919; cells 1,199 → 1,557.
* **Builds** — run f550d704 (on): completed in 1,514 s, degraded; run 1959a465 (off): 748 s, degraded. Both degrade on the same hole (62.3 m² at [-47.5, 5.5, -24.7], the back of the residual scan), so the cap does not cause it.

---

## 3. What Broke / Didn't Work

* **A 40 m slot at one setback column** — at (3, 25) the solid tops at 270.5 m with the cap on, against 318.5 m with it off (the scan reaches about 310 m there). Offline with ray votes the cap kept 318.5 m at the same column; it is the cap together with the winding-number labels (`windingLabels`, which `partition_shell.cpp` turns on). Suspected cause: that column has no up-facing scan at its real top, so `capCellsAtRoof` cuts at the highest roof found in its footprint, a terrace near 270 m. Not yet fixed.
* **The assembled output is less clean** — after the facades are inset and the seams stitched: non-manifold edges 1,469 → 2,308, open edges 13,001 → 16,941. Not investigated: the cap's extra level cuts make more shell faces for the inset to meet.
* **UI** — "New Chat (⌘K)" did not open a new chat (the composer stayed on an existing session), so the builds were started through the tool route instead; the first call was refused until the worktree was added to `SCRATCHBOX_WORKSPACE_ROOTS`.

---

## 4. Candidate Tool/Service Ideas

* **A point-in-solid audit stage** — sample the closed solid on a grid finer than its thinnest column and compare inside/outside before and after any closing step, below the scan's top; it found both the shaft (offline) and this slot, and no current gate sees hidden volume loss.
* **Walls as roof evidence for the cap** — where a column has no roof but its vertical scan rises above the cut, raise the cut to the highest level the walls reach, so the slot does not form.
* **A `workspaceRoot` default for `tools/run-stream`** — accept the server's own checkout when none is given, so a worktree's launch entry can run tools without `SCRATCHBOX_WORKSPACE_ROOTS`.
