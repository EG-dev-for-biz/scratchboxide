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
- **Not this:** the slanted slabs along the west sidewalk against the wall. They are not in any vehicle box (section
  below).

## The west sidewalk slabs: a temporary construction structure

These were chased the same way: from the saved inputs, with no build and no model call. The evidence sheet is
`docs/screenshots/2026-11-03-penn-west-sidewalk-structure.png` (gitignored).
- **What the scan holds.** Cross-sections of the centre's welded scan every 10 m between W 32nd and W 33rd St show one
  structure along the whole stretch:
  - a front at the kerb (9.7 m west of 7th Ave's centreline) rising about 8 m;
  - a flat deck about 6.3 m over the street;
  - a back at 15.5 m;
  - the sidewalk continuing beneath it;
  - the building's own facade standing behind it at 18.4 m, down to the street.

  It is about 90 m long and 6 m deep. Google's footprint edges only start 12 m out, so it stands mostly off the building.
- **What it is.** Its street face, drawn from the scan photo, shows a "PENN STATION" sign on a steel frame, pallets, a
  yellow skip, red barriers and crates. Its deck from above shows tarps and loose items. It is a sidewalk shed with a
  construction staging yard: the renovation's site, standing when the tiles were captured.
- **What the build did with it.**
  - **The vehicle stage never saw it.** That stage removes temporary objects, scaffold sheds by name, under the user's
    clutter decision of 2026-10-30. But it only takes lumps at most `proudMaxM` (5 m) tall and more than `buildingClearM`
    (1 m) from a footprint, and this structure is neither.
  - **Pipeline K treated its front as a building facade:** it built a facade lattice on it, and generated seal strips
    under it.
  - **So it shows as a scanned box.** Its melted ends read as slanted slabs from the street up to the wall.
- **Which step should handle it.** By the clutter policy it is temporary, so it should go, with the sidewalk patched and
  the building's scanned facade behind it left standing. The vehicle stage's temporary-object path is the step that
  owns that.
- **What that needs.**
  - Proud lumps up to a shed's height, about 10 m, beside buildings, offered to the model. Fixtures, entrances and
    canopies that are part of a building must still stay.
  - A removal that leaves the facade behind it standing.

  Not fixed here: it changes what the model is shown and needs a decision, recorded in the PR.
