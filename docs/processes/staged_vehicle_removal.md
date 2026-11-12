# Vehicles removed from every staged build (Federation Square, Melbourne)

> **Update 2026-11-12 (off the main thread):** the stage runs in a worker thread (`vehicle-removal-run.ts`,
> `removeVehiclesOffThread`). Only its vision calls stay on the server's main thread: each crop or batch is posted back
> and judged there. On the Flatiron district (run `ee634ff6`) the stage had held the main thread 498 s in 8 blocks, the
> longest 349 s (223 crop renders before the first vision call, then 175 regions of surface infill). 5 of its 11 vision
> calls timed out, and the chat's own request failed. A fresh, uncached build of the same request (run `dd6d8f7e`) blocked
> the main thread twice in its 469 s: 1.4 s at the start (shared with `vector`) and 0.8 s. Same input and model answers:
> the GLBs are byte-identical and the report is the same except `ms`. `SCRATCHBOX_VEHICLES_WORKER=0` runs it inline.

> **Update 2026-11-03 (`vehicle-removal/5`):** steps 3 and 4 below are now the surface infill's
> (`surface-infill.ts`, `docs/processes/surface_infill_service.md`): the street under a region is its ring's levels (a
> kerb kept as a step) on local quadrics instead of an inverse-distance surface, and its texels come from the infill's
> ladder (a registered view, a continuation along the street's measured direction or repeat, its own grain) behind a
> seam gate, instead of the mirror along the long axis and the strip looks. The stack ceiling and the shell rule are
> unchanged.

**Date:** 2026-10-22 · **Rule (user, 2026-10-22):** every staged 3D scene build removes all vehicles the Google Photorealistic 3D Tiles scan baked in and patches the street seamlessly (no hole, no lump, no smeared car texture).

## What runs

`packages/core/src/node/3d-engine/staged-location/vehicle-removal.ts`, wired as the `vehicles` stage of `orchestrator.ts`, straight after `tiles`. It runs on the extraction itself, so the strip, the remesh, the district massing, the roads, the inventory and the texture pass (its tile photo source) all build on the scan without vehicles. Its own `l1` layer (the tiles without vehicles) supersedes and crossfades from the raw `l1`. It is on by default; `SCRATCHBOX_STAGED_VEHICLES=0` turns it off. It needs the app's vision model (`deps.vehicleRemoval`, set by `createStagedLocationDeps`); without one, the stage is skipped and says why.

1. **Candidates (measured).** The scan's top surface on a 0.25 m grid is compared with the measured street (`buildGroundModel`). Cells standing 0.4 to 5 m proud, clear of vector buildings and water, are joined into components of 1.5 to 600 m². These only decide what the model is shown.
2. **The decision (the vision model).** Each component is shown in a top-down orthophoto crop of the textured scan (56 m, about 5.6 cm/px). The model boxes every vehicle in its own words, with `vehicle`, `permanent` and a confidence. There are no noun lists: the model decides. Readings from overlapping crops are merged.
3. **Geometry patch.** The region is the proud cells inside vehicle boxes, plus the box itself (8 % inset) and a 0.75 m skirt. A vehicle the scan flattened below 0.4 m is patched from its box alone. Every vertex in the region is moved onto an inverse-distance surface through the measured scan ring around it (within 1.5 m, within 0.35 m of the street). A vertex above the lowest continuous stack of surfaces in its cell (a gap of 1 m or more, climbed from the street) is never moved, so awnings and canopies over a car stay. No triangle is removed, so no edge opens.
4. **Texture patch.** The texels of every moved triangle are painted again from a road orthophoto around the region. They are mirrored along the vehicle's long axis from the street beyond its ends (lane lines continue), or across it when both ends are blocked. Sources are only street texels (scan top within 0.35 m of the street, at least 0.4 m clear of any region). The edge mismatch is spread over the hole with push-pull (seamless), and texels nothing reaches are filled from their surroundings.
5. **Provenance.** Root extras `sbVehicleRemoval` list each region: the model's labels, the geometry labelled `generated` (with the reason that nothing was measured under a vehicle), the texture labelled `photo-inferred` or `generated` with its shares and reason. The layer note says the same. The run note `vehicles` keeps the counts and the raw extraction path.

## Measured on the real data (extraction f3a773d6, r ≈ 260 m, 571 tiles, 508k triangles)

| | |
|---|---|
| Proud candidates | 516 |
| Crops read by the model | 103 (0 failed), 159 s end to end on a cold run (10 concurrent calls) |
| Distinct vehicles read | 264 (63 too flat in the scan to stand proud, patched by box; 5 with no scan to patch) |
| Regions patched | 120 (8,348 m²), 11,788 vertices moved, 834k texels repainted in 133 tile images |
| Non-vehicles the model boxed and kept | umbrellas, tram shelter roofs, kiosks, planters, bins, rooftop units (46 judged temporary, all kept) |

Screenshots (gitignored, `docs/screenshots/vehicle-removal/`): `flinders_topdown.jpg` and `flinders_topdown_boxes.jpg` (before on top, after below; green = removed vehicle, red = duplicate reading, blue/yellow = non-vehicle boxes), `flinders_oblique.jpg` (street level, textured and clay, before/after), `carpark_topdown_boxes.jpg` (the Jolimont car park, the hard case).

**Flinders St:** every kerbside and in-lane car in view is gone. The clay shows flat road where the lumps stood, lane lines and the "KEEP CLEAR" box run through, and the awning over the north kerb is intact. One long white shape at the Fed Square tram stop is kept: the model read it as a shelter roof, which is plausible.

**Car park (≈ 90 cars nose to tail):** all but about two cars are removed and the ground is flat. The texture is believable from a distance but streaky up close: the bay markings are partly lost, there are hedge-green streaks where the mirror crossed the planting strip, and one dark smear. With cars on every side there is little street to mirror from.

**Removed that a user might want kept (judged a vehicle by the model):** about 8 trains at Flinders Street station and in the rail yard (their tracks are re-textured, mostly `generated`), 4 moored river or tour boats at the quay, 2 trams, 1 concession trailer or kiosk, and rows of parked bicycles or scooters. They are vehicles under the rule. If boats or trains should stay, that is a rule change for the prompt, not a noun list.

## Bugs found on the way

- An O(n²) re-flood of dropped components took 76 s on the candidate pass; it now takes 0.35 s.
- Awnings over parked cars were flattened before the stack ceiling existed.
- Car-coloured ghosts came from mirroring the next car; sources are now street-only with a guard band.
- A rail cutting under the car-park deck made the stack climb start below the street; it now starts at the street.

## Not verified

- No full live staged build in the app was run with the stage, and the viewport crossfade from the raw `l1` was not seen in the app. The orchestrator compiles and its 40 existing tests pass with the stage present.
- The remesh and texture pass on the cleaned scan were not run on the real data here.
- An isolated-structure build with cars against the structure was not tried.
