# Vehicle removal: a vehicle's own shell over a gap in the stack

**Date:** 2026-11-03
**Status:** fixed; tested on fixtures and replayed on the Penn centre's saved inputs (no build).
**Branch:** `fix/vehicle-patch-floating-tops` (from main `90e65beb`).
**Routed by:** MAIN, from the Penn kd run on Cloud Run (`266b12eb`). View 4 showed white shards and leaning panels in
7th Ave's carriageway. The diagnosis is in `2026-11-03-kd-district-edge-and-street-debris.md`, section 2, on
`fix/district-edge-circle`.

## The defect

**Where the vehicles were left.** `vehicle-removal.ts` `patchVehiclesInGlb` moves each vertex of a removed vehicle's
region down to the patch surface. It skips a vertex above its cell's stack ceiling (`measureStacks`): the scan's
surfaces are climbed from the street while each step up is under `stackGapM` (1 m), and anything above a larger gap is
taken for an awning or canopy and kept.

**Why the rule misfired.** Google's mesh sometimes keeps the street surface under a vehicle and the vehicle as its own
shell over it. Over such a vehicle a cell's stack reads street, then roof 1.4 m up, a gap. So the roof was kept, and the
walls (whose cells have a continuous stack) were flattened. That left a roof hanging over the patched road and slanted
shards from the road up to it.

**Measured** with `.scratchbox/examples/tools/vehicle_patch_replay.ts` (gitignored). It replays the centre's vehicle stage
on its saved inputs: the welded scan, Google's vector evidence and the model's 145 saved readings. It reproduces the run's
33 regions from 102 candidates. Of the vertices still standing 0.4 to 4.5 m inside the model's vehicle boxes (off every
building), 3,146 stood above the ceiling and 167 outside the region's cells.

## The fix

`unattachedAboveCeiling`:
- **What gets patched.** A piece of the region's above-ceiling vertices, joined by its triangles, is patched with the
  rest of the vehicle when none of its triangles reaches a vertex outside the region. That is a vehicle's own shell.
- **What stays.** An awning, a canopy or a tree runs on past the vehicle, so its piece is attached and kept, as before.
- **Reporting.** The patch reports these vertices (`shellVertices`).
- **Version.** `VEHICLE_REMOVAL_VERSION` 4.

## Evidence

- **Fixture tests** (`staged-vehicle-removal.test.ts`, credentials unreachable):
  - a car built as its own closed shell over a street that continues beneath it is flattened whole, every shell vertex
    within 3 cm of the road;
  - an awning 3 m up, reaching 3 m past the same car on every side, keeps its height everywhere, over the car too, while
    the car under it is still flattened;
  - all 11 tests in the file pass, as do the orchestrator's vehicle cases. `tsc -p packages/core` is clean.
- **The Penn centre, replayed.** The vertices standing inside the model's vehicle boxes drop from 3,570 (the run's patch)
  to 788 (this patch), with 3,331 shell vertices flattened. The rest belong to pieces attached to something outside the
  region. The before and after render is `docs/screenshots/2026-11-03-vehicle-patch-before-after.png` (gitignored).
- **Not this:** the slanted slabs along the west sidewalk against the wall. They are not in any vehicle box (most likely a
  sidewalk structure in the scan) and stay; that is a separate item.
