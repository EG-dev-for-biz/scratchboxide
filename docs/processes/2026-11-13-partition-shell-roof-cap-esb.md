# Process: The partition shell's roof cap on a live ESB build (pipeline K)

> **Recorded:** 2026-11-13
> **Status:** Verified (roof cap); Needs Fix (run-to-run lattice variation, upstream)
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

* **The setback "slot" at (3, 25) is not the roof cap** (first read as a 40 m slot the cap cut). Rerunning the solver offline on each build's own input (`SCRATCHBOX_K_PARTITION_SHELL_KEEP` keeps it; the solver is deterministic, one thread or six): with build f550d704's input that column tops at 270.5 m with the cap off and on; with build 1959a465's input, 318.5 m off and on. The two live builds' facade lattices differ (135,458 against 92,210 cells, 50,410 against 29,892 photo-recess cells) although their cleaned scans are byte-identical and the window reader was reused: run-to-run variation upstream of the partition shell (window fit and window arrays differ slightly between the runs). Not investigated further here. A wall-raised second cut was tried at three thresholds; it changed nothing at that column and was reverted.
* **Why the assembled output's edges rise with the cap:** per output kind on the same input, off → on: partition shell open edges 15,795 → 13,331 (non-manifold 2 → 1); inset facades 16,017 → 13,562 (27,697 → 27,515); residual scan 7,013 → 8,152 (487 → 885); seam skirts 9,813 → 11,275 (609 → 860). Residual scan above 380 m grows from 887 to 3,035 triangles, 97% within 3 m of the antenna's axis, and the skirts there from 1,032 to 2,834; below 330 m both shrink. The antenna is kept as measured scan instead of buried in a solid column, and its own open borders and skirts are the extra edges; on build 1959a465's input the same holds (+1,020 open, +466 non-manifold). Sheet: `docs/screenshots/like_for_like.png`.
* **UI** — "New Chat (⌘K)" did not open a new chat (the composer stayed on an existing session), so the builds were started through the tool route instead; the first call was refused until the worktree was added to `SCRATCHBOX_WORKSPACE_ROOTS`.

---

## 4. Candidate Tool/Service Ideas

* **A point-in-solid audit stage** — sample the closed solid on a grid finer than its thinnest column and compare inside/outside before and after any closing step, below the scan's top; it found both the shaft (offline) and this slot, and no current gate sees hidden volume loss.
* **Walls as roof evidence for the cap** — where a column has no roof but its vertical scan rises above the cut, raise the cut to the highest level the walls reach, so the slot does not form.
* **A `workspaceRoot` default for `tools/run-stream`** — accept the server's own checkout when none is given, so a worktree's launch entry can run tools without `SCRATCHBOX_WORKSPACE_ROOTS`.
