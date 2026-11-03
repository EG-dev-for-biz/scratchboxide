# Pipeline E's repeat fill at district scale, and the leaf-tile cap at Penn Station

**Date:** 2026-11-03
**Status:** the donor search is fixed with the same output byte for byte (offline, on Penn's real district faces). The
live E-detail timing at Penn is not done: three builds stopped at stage time limits (the tiles stage twice, then the
remesh) under a load average of 70 to 430 from other sessions' work (see "The live build"). The leaf-cap decision is
below.
**Branch:** `fix/texture-repeat-donor-index` (from main `cd52dcb3`), commit `42f403c3`.
**Routed by:** MAIN (2026-11-03), from the aerial-paint session's findings (`feat/district-aerial-paint`).

## 1. The hang: `findDonors` in texture-repeat.ts

Pipeline E's district detail (district-e-detail.ts) runs relief.ts `buildLayer` twice, and each run fills every face's
uncovered texels with the gated same-plane repeat (`plainTextures` → face-texture-repeat.ts `repeatFillFace` →
texture-repeat.ts `repeatFill`). For every uncovered texel, `findDonors` searched its phase's lattice again from
scratch at 8, 16, 32 and 64 pitches. At each radius it built new range and donor arrays and checked each candidate
through an allocating `isReal`. It then sorted each channel of the donors for the trimmed mean. A face the tile hardly
saw sends nearly every texel through all four radii.

**The run that was profiled** (80+ min in massing, 21 GB, both worker threads in `findDonors`) is `8fe1ef25`. Its
request is Piazza del Duomo, Milan, at the default radius, not Penn. The aerial-paint session's Penn runs are
`5805a429`, `87c01600` and `f3f527eb`, each asked at `radiusM` 150.

### The fix (`fillPlaneFromRepeats`)

Same donors, same mean, same bytes, found differently:
- **One pass over the plane.** Each texel is classed once as a donor, a target or neither.
- **A summed-area table per phase lattice.** A phase's texels form a lattice, one cell per pitch. Counting the donors
  in any window of that lattice takes four lookups. So the radius (8, 16, 32 or 64 pitches, as before) is chosen
  without gathering anything. A texel with too few donors even at 64 pitches costs a few lookups.
- **Shared means.** Texels whose windows clip to the same cells share one mean. Once the window spans the plane, that
  is every texel of the phase.
- **A byte histogram for the trimmed mean.** `SRGB8_TO_LINEAR` rises with the byte, so walking the bins upward visits
  the values in sorted order. Adding them one at a time over the kept range repeats the sorted reduce's additions
  exactly.

No cache key changed, because the output is the same.

### Same output

- **The oracle test.** `packages/core/test/texture-repeat-donor-index.test.ts` keeps the old search verbatim as its
  oracle. It compares albedo and confidence byte for byte, and the degradations and provenance whole, over 8 fixtures:
  - both axes, dense;
  - one axis at a time;
  - sparse planes on lattices wider than the widest window (the radius doubles, windows clip, some texels stay unfilled);
  - very sparse, one axis;
  - three planes with overlapping bboxes, gutters, rung-3 texels and a plane with no gated axis;
  - a pitch longer than the plane;
  - `detectPlaneRepeats` end to end on a periodic facade with holes.

  All pass. So do the 14 texture and pipeline-E test files (116 tests), run with credentials unreachable.
- **Penn's real faces.** The 10,466 textured faces of the Penn district massing are the native dir of the aerial-paint
  session's run `f3f527eb`: 63.4 M texels at 0.15 m, copied read-only. Each was run through `textureFromOrtho` then
  `repeatFillFace`, as `plainTextures` does, once on the old code (origin/main's texture-repeat.ts) and once on the new.
  The md5 of each face's RGBA and source arrays matched on **all 10,466 faces**, with 1,569,358 texels filled by each.

| Penn district faces (10,466) | Old | New |
| :--- | ---: | ---: |
| Repeat fill, summed over faces | 46.1 s | 10.4 s |
| Peak RSS of the process | 0.71 GB | 0.74 GB |
| Slowest face (wall 7871, 233 x 839, coverage 0.00) | 2,741 ms | 13.7 ms |
| Wall 7885 (717 x 859, coverage 0.64) | 1,378 ms | 152 ms |

These faces are the district massing's own layer. On them the old code takes 46 s, not 80 minutes. The hang is in
`buildLayer`'s re-rendered faces, which exist only when the district's buildings are rebuilt. At Penn that needs more
than the default 524 leaves (section 2). The live build that would capture them is in "The live build".

## 2. The 524 leaf-tile cap at Penn

`Google3DTileBlockoutPipelineService` keeps the nearest `options.maxLeaves || 524` leaf tiles. The district path never
passes `maxLeaves`, so every district extraction keeps 524. The containment step (`districtContainmentRadiusM`,
`DISTRICT_CONTAINMENT_MAX_GROWTH_M` = 100 m) then grows the radius so it ends on whole buildings.

| Penn request | Grown to | Leaves the radius holds | Reach at the 524 cap |
| :--- | ---: | ---: | ---: |
| `radiusMeters` 150 (the aerial-paint runs, `c9af0e56`) | 250 m | 780 | 81 m (`5805a429`: 8 of 8 rebuilds fail, "the footprint runs past the extraction") |
| no radius (the tool's default 250) (`8f6a7bfd`) | 350 m | 1,396 | 81 m |

The leaf counts are from this session's extractions with a local 2,000-leaf override (never committed), which kept
every leaf: `truncated: false` at both radii. The 81 m reach is the aerial-paint session's `5805a429`.

**Decision: change the cap for districts, not the radius.**
- **A smaller radius cannot help.** At 81 m the extraction stops short of Penn 2 itself. Its isolate spans about 103 by
  122 m in plan around the geocoded point, reaching up to about 100 m from it (M1 preregistration, K run `1ef02345`).
  Asking 150 m still grows to 250 m and holds 780 leaves. Penn 2 is the target.
- **What to change.**
  - A district extraction keeps every leaf its grown radius holds, up to a district cap of 2,000. That covers Penn's
    default 350 m (1,396 leaves) with room.
  - Past 2,000 the extraction truncates and reports `radius_truncated` as it does now. Past the crawler's 6,000 it
    refuses with `DistrictTooLargeError`.
  - A single structure keeps 524.
  - The extraction cache key carries the cap. Without that, the cache mirror would hand a 524-leaf extraction to a
    2,000-leaf request under the same key, or the reverse. The aerial-paint session's uncommitted
    `SCRATCHBOX_STAGED_MAX_LEAF_TILES` already adds `leaves:N` to the key.
- **What it costs, measured so far.**
  - The tile download: the aerial-paint session's 780-leaf extraction took 44 s.
  - Disk: this session's 350 m extraction is 219 MB.
  - The tiles stage's 360 s budget: it did not cover the work after the download at 780 or 1,396 leaves under a load
    of 180 to 430. On a quiet machine the aerial-paint session's took 44 to 62 s.
  - The full-build time and RSS at 780 leaves wait on the live build below.
- **Who implements it.** The switch and the default touch the same lines (staged-location-tool.ts `extract`,
  orchestrator.ts `extractCached`'s key). So they belong in one change: the aerial-paint session's switch commit, with
  this default, or this branch once that switch is on main.
- **Comparisons already run.** Any Penn 2 district-massing arm built at the default cap had no rebuilt massing: M1's DM
  `0ced0b89` rebuilt 0 of 8.

## 3. The live build

- **The instance.** A detached checkout of `42f403c3` on the Scratchbox SSD
  (`/Volumes/Scratchbox/scratchbox-ide-overflow/2026-11-03-district-kd/district-donors-ssd`), because the Mac had
  13 GiB free. Its own launch entry `scratchbox-district-donors` uses web 3750, API 3751 and tools 3752.
- **Kept fresh and private.** The stage cache started empty, with `SCRATCHBOX_CACHE_MIRROR=off` and
  `SCRATCHBOX_CACHE_RESTORE=off`, so nothing came from or went to the bucket. The 2,000-leaf override is a local edit in
  that checkout only.
- **The builds.** Each was `google_3d_tiles_get_clay` `{ query: "2 Penn Plaza, New York", isolate: false,
  district: "massing" }` through `/gemini/tools/run-stream`.
  - **`8f6a7bfd`** (no radius, so 350 m): the vector first paint passed its 120 s limit, and the tiles stage failed at
    its 360 s budget after the download finished. The load average was 180 to 197.
  - **`c9af0e56`** (`radiusMeters` 150, so 250 m): failed the same way, with the load at 274 to 429. Other sessions'
    vitest workers held the CPUs.
  - **`030f649b`** (the retry of `c9af0e56` from tiles, started when the load fell to 74): finished degraded in 21.7
    min, and the massing never ran.
    - Tiles committed in 263 s, with 780 leaves out to 250 m.
    - Vehicle removal passed its 480 s limit.
    - The remesh failed: tile_refine passed its 300 s limit, so the raw scan with its facades flattened stood in.
    - The massing, relief and grammar stages were skipped because the remesh failed. So the E-detail step never ran.
    - The load climbed back to 140 to 180 during the run, with other sessions' native audits and compiles running.
    - The server's peak RSS was 3.6 GB.
- **What is still open.** The live E-detail time and RSS at Penn, and its relief faces for an old-against-new byte
  check, need a build whose remesh finishes. On this machine that means a time when it is not shared with other
  sessions' builds and test suites. No stage budget can be stretched for a slow machine: only kd chunks scale theirs.
