# Steps, stairs and ramps as geometry, and the scan carved under them

**Date:** 2026-11-03
**Status:** Unit-tested on synthetic flights and run through a whole staged build in the orchestrator test. Not yet built
live in the app (the load average stayed at 250-500, against the no-builds-above-100 rule), no proof sheet yet, and
not yet judged by the user.
**Branch:** `feat/ground-steps`, stacked on `feat/road-kerbs-gutters` (it reuses that branch's carve, `road-carve.ts`,
and its bevel rule, `frontBevelM`).
**Switch:** `SCRATCHBOX_STAGED_STEPS=1`, off by default. It turns the roads stage on with it, with or without the
streets.

## Why

In walk mode the James A. Farley Building's grand steps on 8th Avenue (between W 31st and W 33rd St, facing east) have
melted into a smooth ramp. The photo tiles resolve a flight of 15-18 cm steps as one incline. The same happens to every
flight in a district.

## What it does (`ground-steps.ts`)

### 1. Finding the inclines (`findInclines`)

On a 0.25 m surface model of the scan, an incline is a connected region whose gradient is:

- steeper than a street's grade and gentler than a wall (rise over run 0.06 to 1.2);
- free of jumps (neighbouring cells within 0.35 m: more is a wall or an object's side);
- coherent in direction (at least 35 % of its cells within 35 degrees of its mean uphill direction: a dome or a berm
  slopes every way);
- at least 4 m² and 0.3 m of rise;
- standing on the terrain (its foot within 1.5 m of it: a sloping roof is no flight);
- short along its slope (at most 40 m: longer is a street on a hill, the road's own).

Cells outside the extraction's cover and within 3 m of a Google road centreline are left out.

### 2. Reading each one (`readIncline`)

Cross-sections every 0.75 m across the incline, each read every 3 cm along its slope on the scan's own triangles
(barycentric, `scanHeightIndex`) and 1.5 m past each end. A section counts when its slope is in range, it runs at least
0.5 m, and it is within 40 % of the median section. From them:

- **the extent and levels:** where the incline starts and ends (percentiles over the sections), and the levels at its
  foot and top;
- **landings:** level runs of at least 1 m (slope under 0.035);
- **resolved steps:** where the profile's residual about its own line repeats at a step's pitch (autocorrelation at
  least 0.3, run 0.2-0.7 m), the pitch is the step's run, and the count follows from the measured rise.

### 3. What each one is (`modelFlight`)

- **Steps the scan resolves:** count, rise and run all measured.
- **A smooth incline up to 1:8:** a ramp, a plane through the measured slope.
- **A steeper smooth incline:** a flight the scan melted. Its count comes from Street View when the app has the
  grounding service and a vision model (`step-count-streetview.ts`, below), and is labelled photo-inferred. Otherwise
  it is estimated at a 16 cm rise and labelled generated, with the reason. A Street View count whose rise falls outside
  7-25 cm is not used, and the estimate says so.

### 4. Counting a melted flight on Street View (`step-count-streetview.ts`)

- The free metadata query finds panos around the flight (in front of its foot and off either side).
- The nearest within 5-45 m that sees it from the side, and the nearest that sees it from the front, are fetched
  through the Maps Imagery Grounding API. At most two, in memory only, as `streetview-evidence.ts` has them.
- A vision model counts the risers on each, told what the scan measured (the rise, the length, the width).
- Two counts within one of each other give the larger (a riser hidden is likelier than one invented). Two further apart
  give no count, with the reason.

### 5. The rebuild (`buildStepsMesh`)

One step profile repeated at the measured pitch along the measured slope (operator 3, the replicator):

- **the step:** a riser, a nosing, a tread. The nosing is bevelled by the bevel rule (1.5 % of the step's smallest
  dimension, clamped to 1-5 cm, at most half the rise or run): about 2-3 cm on a stair nosing.
- **landings:** where the scan shows a level run.
- **ramps:** one plane through the measured slope.
- **the edges:** a 3 cm toe strip at the foot level in front of the first riser, so the carve's rim meets it; the sides
  closed down to the foot level.
- **the colour:** the tile photo seen from above (planar, 5 cm a texel).

Every part is its own node with its label. Nothing here names a kind of stair.

## Labels

- **measured:** the extent, the levels, the total rise, the slope, the landings, and each step's rise and run where the
  scan resolves them.
- **photo-inferred:** each step's rise and run where the count came from Street View.
- **generated:** each step's rise and run where the count is estimated (with the reason); the nosings; the sides.

## In a build (`orchestrator.ts`, the roads stage)

- The steps are their own layer, `l1s`, published as `<base>_steps_<key8>.glb`. The layer note gives each flight's
  measured rise, length, width, count, each step's rise and run, and where the count came from.
- The carve is the kerbs branch's (`road-carve.ts`). The roads stage now gathers every new surface's footprint (the
  kerbed streets' and the steps') and installs one carve over all of them. It runs on the shown ground (`l2`, or the
  ground layer) and its twin, and writes the run note `road_carve`.
- The run note `ground_steps` records every flight, how many inclines were looked at and refused, and why there was no
  Street View count.
- With `SCRATCHBOX_STAGED_ROAD_KERBS` off and the steps on, the roads stage runs the steps alone.

## Evidence

- **`staged-ground-steps.test.ts`** (9 tests, credentials unreachable):
  - a resolved flight: 10 steps counted from the scan;
  - a melted flight: Street View's count gives photo-inferred steps; with no count, a generated estimate with its reason;
  - a 1:12 ramp reads as a ramp;
  - a landing is found;
  - a street on a hill is refused;
  - the rebuild: risers face downhill, treads up, the nosing follows the bevel rule, and the labels are in the GLB;
  - the carve under a flight;
  - Street View reply parsing and combining.
- **`staged-location-orchestrator.test.ts`:** a melted 1.2 m flight runs through a whole staged build with the switch on.
  It is rebuilt as `l1s` with an estimated count (no Street View in the test), and the shown ground is carved under it.
- **Not done:**
  - a live uncached build at Farley's steps and at a second flight;
  - the before/after sheet at walk-mode eye height.

  Farley's steps are in none of the extractions on disk: the Penn K-D smoke run's ground ends at 8th Avenue's west
  sidewalk, and the Penn Station extraction is cut at 72 m. They need a fresh tile extraction at about 40.7503,
  -73.9957, which waits for the load average to fall under 100.

## Known gaps

- **Street View counting is untested on real images.** The counter is tested on its parsing and combining only.
- **Steps that turn:** no test has a flight whose direction turns (a curved or dog-leg stair). Each incline gets one
  uphill direction, so such a flight may be refused by the coherence test.
- **Cost:** the carve runs synchronously in the commit, as for the kerbs.
