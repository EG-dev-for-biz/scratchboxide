# Process: Pipeline K's work on the voted remesh, and the base cleanup's footprint label, in the live app

> **Recorded:** 2026-11-01
> **Status:** Verified (one live K build with a material vote: St. Mark's Church in-the-Bowery, run `87801182`, uncached)
> **Tags:** `operate-scratchbox` `pipeline-k` `ownership-vote` `base-cleanup` `provenance`
> **Target Domain:** Staged locations / pipeline K (orchestrator remesh and ownership stages)

---

## 1. Session Context

* **What prompted this session:** two bugs in `orchestrator.ts`, found while reviewing sb-ide `nyc-truth`:
  - **Bug 1:** a material ownership vote published its raw tile_refine re-run as the building (`l2v`). It never had K's
    facade work or polish (cleanup, lattice, base cleanup, clip to the footprint, infill, orient), because the second
    pass does not reopen the remesh.
  - **Bug 2:** K's `pipeline_k_base` note called every footprint "Google vector footprint" whenever `eBuildings` was
    non-empty.
* **Instance used:** own launch entry `scratchbox-upbeat-austin` on web `3760`, API `3761`, tools `3762`. The branch's
  code was served with `SCRATCHBOX_NO_ELECTRON=true`.
* **Scope tested:** builds from the in-app chat ("Build <place> as a 3D building (isolated).", pipeline K). Checked the
  ownership verdict, the step log, the run notes, the published layers, and clay renders of the voted building before
  and after.

---

## 2. What Was Tested & What Worked (Verified)

**Finding a material vote.** Most votes on this code are not material: they either fail the voted-isolate check or move
less than `OWNERSHIP_MATERIAL_SHARE` (5%). Places tried:

| Place | Run | Ownership verdict |
|---|---|---|
| 229 Mott Street (BIN 1083324, an sb-ide `nyc-truth` material case) | `c5a57fa3` | not used: 100% of the pick covered, but only 66% of the voted isolate lies on the pick (gate 70%) |
| 129 Grand Street (BIN 1003036) | `95688d97` | not used: 70% on the pick, just under the gate (90% roofed) |
| Jefferson Market Library, 425 Sixth Avenue | `794018d7` | accepted, moved 3.3% (0.5 m² joined, 181.6 m² left): under 5% |
| St. Paul's Chapel, 209 Broadway | `cbafecf7` | no verdict: the disk filled up (ENOSPC) during the build |
| **St. Mark's Church in-the-Bowery, 131 East 10th Street** | **`87801182`** | **material: moved 14.2% (32.9 m² joined, 657.9 m² left)** |

The two `nyc-truth` cases are attached SoHo buildings. There the vote's outlines bleed onto the neighbours and the
isolate check rejects them. That branch picks its footprint with its own model, which may explain why they went
material there.

**Bug 1 on the material vote (run `87801182`).** Every stage was a cache miss, and the checkout's stage caches were
fresh.
* **Step log (`steps.jsonl`).** After `ownership.tileRefine` (judged without orthos, then made again with them), K's
  work runs again on the voted remesh: `remesh.pipelineK`, `remesh.windowFit`, `remesh.wallGrammar`,
  `remesh.wallSheets`, then `polish.cleanup`, `polish.lattice`, `polish.base`, `polish.clip`, `polish.infill`,
  `polish.orient`, `remesh.streetViewScore` and `remesh.visibleDefects`. The ownership stage's breakdown holds their
  times: wall grammar 858 ms, wall sheets 818 ms, polish 1,277 ms, Street View score 4,757 ms; 40.0 s in all.
* **The published `l2v`** (`stg-10b42025-l2v`) carries the polished remesh's key, which is also `keys.remesh` in the run
  record. Its method ends "then pipeline K's facade work and polish, its base cleaned and clipped to the footprint, as
  on the first isolate". The texture pass ran again on it: 82.2% tile photo, 17.8% clay.
* **What the polish did to the voted remesh** (from its `stats.json`):
  - 170 loose pieces removed;
  - 295 m² of ground apron taken away by the base cleanup (misfit 2.7%, so the footprint was used);
  - 452 m² clipped past the footprint plus 0.3 m;
  - 438 m² of infill;
  - 324 inward-facing triangles turned outward.
* **K's facade work had nothing to rebuild here.** tile_refine wrote no facade ortho the straightening kept for this
  small church: 0 facades fitted, 0 wall sheets, and the lattice rebuilt 0 facades. That part of the fix ran, but this
  build doesn't show its effect. The orchestrator test doesn't exercise it either.
* **The notes describe the voted build.**
  - `pipeline_k.json` names the voted re-refine's orthos (tile_refine `2681e000…/relief_orthos_k_…`), so the second
    texture pass reads the right orthos.
  - The node graph's latest `polish.base`, `polish.clip`, `polish.infill`, `polish.lattice` and `ownership.tileRefine`
    snapshots are framed on `stg-10b42025-l2v`.
  - The ownership summary is still the remesh legend's text.
* **Before and after.** `docs/screenshots/k_vote_finish_refine/stmarks_vote_before_after.png` (gitignored) compares two
  clay renders from the same cameras, with the footprint drawn in white:
  - **before:** the voted tile_refine output, which is what `main` publishes as `l2v`. It has the ground apron and
    loose scraps well past the footprint.
  - **after:** the published `l2v`, cut to the footprint with its base closed.

  The in-app view of the textured `l2v` is `stmarks_viewport_l2v_textured.jpg`.

**Bug 2 on the same build.** The structure pick used Google's footprint (`footprintSource: vector-footprint`, IoU
0.768), so `eBuildings` is non-empty. None of its parts gave extruded loops, though, so K's base cleanup stood on
`structure.outline`: 12 corners on the 1 m grid, the scan's own outline. The note now says `footprint: "scan outline"`.
`main` labels by `eBuildings.length` and would have written "Google vector footprint" over the scan's outline here.

**Tests and checks.** All run with HOME empty and credentials unset:
* the two new orchestrator tests;
* 18 orchestrator-related test files, 278 tests, exit 0;
* `npm run typecheck`, eslint on the changed files (0 errors) and `npm run lint:primitives`, all exit 0.

---

## 3. What Broke / Didn't Work

* **Holes on St. Mark's, on both isolates.** The outside check flags holes on the first isolate (17.39% of the views
  through holes) and on the voted building (12.67%), at the back faces of `relief_m4`, `relief_m5` and `relief_m8`. So
  both the remesh and the ownership stage end degraded. That is K's existing hole problem on this scan, not this change.
  The voted building's holes are now recorded under the ownership stage, the stage that made it.
* **The disk filled up mid-session** (ENOSPC, 764 MB free) and killed the St. Paul's Chapel build. My own caches were
  about 2 GB. Space was freed by moving another worktree's set-aside caches to G-RAID. Nothing here was deleted.
* **The first isolate's remesh degradations stay on the run** after the vote replaces it. The remesh stage did build
  that first isolate, and an `isolate_mismatch` on it already behaved this way. Not changed.

---

## 4. Candidate Tool/Service Ideas

* **A per-build ownership verdict in the run record.** `stages.json` holds statuses only. Reading how far a vote moved
  meant either the in-memory `/gemini/staged-runs/:runId` snapshot (lost on a server restart) or the server log. A
  `ownership.json` run note with the share moved, the isolate check (recall, precision, roofed) and whether it replaced
  the isolate would make "find a place where the vote goes material" a file search instead of a build per guess.
* **A dry vote.** The tile render, the vision outlines and tile_refine's isolate check, without the rest of the build.
  It would answer "does this place's vote go material?" for about 12 vision calls instead of a whole build.

---

## 5. Reproduction Steps

1. Add a launch entry for this checkout on three free ports, with `SCRATCHBOX_NO_ELECTRON=true` and
   `SCRATCHBOX_ALLOWED_ORIGINS` set for the web port (operate-scratchbox skill), and start it.
2. In the chat: "Build St. Mark's Church in-the-Bowery, 131 East 10th Street, New York as a 3D building (isolated)."
3. Once ownership finishes (about 95 s in), `.scratchbox/cache/staged_location/runs/<run>/steps.jsonl` lists K's steps
   a second time after `ownership.tileRefine`, and `pipeline_k_base.json` says `"footprint": "scan outline"`.
4. Render the voted tile_refine `clay.glb` (the `pipeline_k.json` orthos folder's parent) against the published `l2v`
   GLB from the same cameras.

Cost: five builds (four voted, one ended by the full disk), each stopped after its vote except St. Mark's. That came to
about 40 vision calls, 6 Street View images and a few chat turns per build. Estimated $3–6 in all; the build records
hold no billing to give an exact figure.
