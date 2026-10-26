# Scene inventory and Street View identification (Federation Square, Flatiron)

**Date:** 2026-10-22 · **Status:** Steps 1-2 measured (step 2 not yet wired into builds)

## What was built

1. **Scene inventory** (`scene-inventory.ts`, runs beside every district build in the `scene-inventory` sibling): one
   `sb-feature/1` entity per vector building (measured against the scan surface in its footprint), road, rail, water area,
   measured crown, and street-audit cluster (`district-residual-audit.ts`), each with its sources and relations, and its own
   gate checks.
2. **Street identification** (`street-identify.ts`): panos every 12 m along the road centrelines of an area, four 90° views
   each, registered against the tile mesh, one vision read per view (label, box, size, form, permanence, catalogue code),
   boxes cast into the tile mesh's depth (place, height, width), merged across views, matched to the inventory.

## Measured

| | Federation Square | Flatiron (NYC) |
|---|---|---|
| Inventory entities (gate checks) | 3,239 (all pass) | 3,212 (all pass) |
| Views / panos / registered | 48 / 12 / 48 (Static API) | 48 / 12 / 48 (grounding API) |
| Boxes read / placed | 371 / 269 | 367 / 334 |
| Objects (≤25 m range) | 201 | 218 |
| Wall time | 464 s | 524 s |

**Hand check, Flinders St (60 objects, crop against label):** 49 outdoor objects, 43 labels right (**88%**); 6 wrong (a
roadwork sign as a bollard, a bent stand as a bollard, two traffic-signal heads as "projectors", two unclear crops);
11 were indoor objects from Google interior captures (gallery artwork, projectors, a display case): the read now asks
whether the photo is outdoors and drops interior views (not yet re-measured).

## Findings

- **The Maps Imagery Grounding API serves US panoramas only.** NYC and San Francisco: served. London, Paris, Berlin,
  Amsterdam, Tokyo, Melbourne: every Google capture 403 "not published or eligible". Outside the US the step reads the
  Street View Static API (user decision, 2026-10-22), chosen automatically when grounding refuses.
- **Placement accuracy falls with range.** Boxes seen from 30-40 m landed on other objects seen from 15 m; placement now
  stops at 25 m and the merge radius grows with range.
- **Cross-view duplicates remain.** Only ~10% of objects are seen in two views: the model does not list the same object
  again from the next pano. Duplicates inflate counts, not labels; deduplication is the next fix.
- **Registration** (joint) took a pose for all 12 panos in both places once views were read in one batch.
- **Native speed:** BVH nearest-child-first closest point plus a threaded residual audit took the Federation Square audit
  from 203 s to 1.65 s, identical measures.

## Candidate tool/service ideas

- A `location_identify_streets` tool wrapping `identifyStreetObjects` for an area (the step currently runs from a driver).
- Per-object crop reads for unclear or single-view objects (a second, closer look), and a dedup pass that projects each
  object into the other panos' views and asks "is this the same object?".
