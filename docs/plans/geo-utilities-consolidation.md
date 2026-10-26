# Geographic utilities: consolidation plan

Status: plan only, nothing implemented. Written 2026-10-23.

## 1. Correction to the earlier audit

The earlier Aleph comparison said Scratchbox has no geographic utilities. That was wrong. What exists:

| Need | Already in Scratchbox | Verdict vs Aleph `geo.py` |
|---|---|---|
| Lat/lng ↔ local metres | `common/coordinate/LocalTangentPlane.ts`: exact WGS-84 ECEF ↔ ENU, Bowring inverse | Better (Aleph uses a sphere) |
| Footprint under a point ("nearest footprint to click") | `vector-footprints.ts` rasterises footprints, `buildingAt(x, z)` is O(1) | Better than Aleph's segment grid |
| Tile selection ("does this tile reach the area") | `GoogleTileDistrictCrawler.footprintIntersectsCircle`: tile OBB projected onto the tangent plane | Equivalent; circle not polygon (fine: boundaries grow to whole buildings anyway, §5) |
| Clip features to the area | `within(x, z)` predicates through the orchestrator, `road-surfaces.ts` | Sufficient; no caller needs segment clipping |
| Great-circle distance | `metresBetween` in `google-maps-service.ts` (haversine, 6,371,008.8 m) | Same formula, private |
| Point in polygon | Eight private copies (list below) | Same even-odd algorithm, duplicated |

So Aleph adds no capability. What it does show is one shared module with one Earth model. Scratchbox has the opposite problem: the same maths is written many times, with different Earth models.

## 2. The real gaps

### Gap A: two Earth models put vector data in the same frame (a correctness bug)

The scan and `vector-footprints.ts` place lat/lng into the scan frame with the exact tangent plane (`geodeticToScan` → `LocalTangentPlane`). Other code places lat/lng into **the same frame** with a flat-earth constant of 111,320 m per degree:

- `node/3d-engine/staged-location/facade-footprints.ts:42-48` `toTileFrame` (called from `orchestrator.ts:930`, used by `facade-grammar.ts` and `footprintAgreement`)
- `node/gemini/tools/location-evidence/building-shape.ts:98-151` `LocalFrame` (a ground-truth tool, §4 "real-data only")

The two models disagree. Error at 300 m from the place origin:

| Place | Latitude | North–south | East–west |
|---|---|---|---|
| Singapore | 1.3° | 2.02 m | 0.00 m |
| New York (Haughwout) | 40.7° | 0.73 m | 0.43 m |
| London | 51.5° | 0.17 m | 0.61 m |
| Oslo | 59.9° | 0.24 m | 0.75 m |

The error grows linearly with distance and differs by axis, so facade footprints are both shifted and slightly squashed against the scan. For comparison, the photo-correction tolerance is 0.31 m (`PHOTO_CORRECTION_TOLERANCE_M`).

A worse case: `browser/generative-canvas/services/google-solar-service.ts:294-295` hard-codes `84400` m per degree of longitude, which is `cos(40.75°) × 111000`. This is correct only near New York. In Singapore, Solar roof segments land about 31% too short east–west.

Other flat-earth sites (111,000 / 111,139 / 111,320) are used for search radii, de-duplication thresholds and bounding boxes, where 0.1–0.7% does not matter. These include `GoogleVectorTileService.ts:699-723`, `scene-objects.ts:430-432`, `kept-structure.ts:81,131`, `object-catalog.ts:52`, `asset-recovery-service.ts:344`, `SpatialAssetVaultService.ts:91`, `GoogleSolarFoliageClassifier.ts:134,522`, `google-elevation-service.ts:336`, `RegionalPlacementEngine.ts:114`, `vector-footprints.ts:75` (tile range only) and `facade-footprints.ts:132` (tile range only). Two browser services also use a spherical 6,378,137 m radius for positions: `google-vector-mapping-service.ts:87` and `geojson-vector-service.ts:57`.

### Gap B: duplicated planar helpers

These are identical even-odd ray-cast functions:

- `staged-location/slot-projection.ts:59`
- `staged-location/scanned-trees.ts:78`
- `staged-location/road-surfaces.ts:422` (exported; argument order `(poly, x, z)`)
- `staged-location/ornament-vision.ts:242` (exported; adds a boundary tolerance)
- `location-evidence/building-shape.ts:107`, plus `distanceToRing`
- `spatial/building-shape-fusion.ts:83`, plus `distanceToRing`
- `browser/.../mesh/FlattenRegion.ts:84` (exported; overloaded signature)
- `test/helpers/synthetic-structure-scan.ts:187` (test helper)

Two slippy-map tile functions are also duplicated: `vector-footprints.ts:61` and `facade-footprints.ts:126-128`.

These copies work today. The cost is drift: a fix to one copy (for example, boundary handling) does not reach the others.

## 3. Non-goals: Aleph code we should not port

- **`RoadIndex` segment grid:** the `buildingAt` raster already answers footprint queries in O(1).
- **Liang–Barsky / `pieces()` segment clipping:** no current caller needs it. Adding it unused would break the no-hollow-code rule (§6.2). Add it only when a caller needs it.
- **Separating-axis OBB test:** tile culling is handled by `3d-tiles-renderer` in the viewport and by the crawler's footprint projection on the server.
- **Spherical `offset()` / `measure()`:** these would be a regression from the ellipsoid tangent plane.
- **Polygon (not circle) tile selection:** §5 grows extraction boundaries to whole structures, so a polygon boundary buys nothing today.

## 4. Implementation plan

### Phase 1: measure before changing anything (about 1 h)

1. Write a vitest, `packages/core/test/geo-frame-agreement.test.ts`, that projects a synthetic footprint ring both ways (`toTileFrame` vs `geodeticToScan`) at the four latitudes above, at 50, 150 and 300 m. It asserts the measured displacement, so the numbers in §2 become a checked fact rather than a hand calculation.
2. Run one staged build at the Haughwout anchor through the `watch-staged-build` skill. Record `footprintAgreement` outcomes and facade-part extents as the before-baseline: 116k vertices / 38.7k triangles, 0 degradations (benchmark memory).
3. Go/no-go: if the displacement at the build's real radius is under 0.05 m, stop after Phase 2. Otherwise continue.

### Phase 2: one planar ring module (2–3 h)

Create `packages/core/src/common/spatial/planar-ring.ts` with only the functions existing callers use:

- `pointInRing(x, y, ring)`: even-odd, exact current semantics (no boundary rule change)
- `pointInRingWithin(x, y, ring, tol)`: the `ornament-vision` variant
- `distanceToRing(x, y, ring)`
- `ringSignedArea(ring)`, only if two or more current callers compute it

Steps:

1. Before deleting any copy, add an equivalence test. For 10,000 seeded random points against convex, concave, self-touching and degenerate rings, each old copy and the new function must return the same result. Inline the old body in the test as the reference.
2. Replace the copies one file per commit. Keep exported names that other code imports (`road-surfaces.pointInPolygon`, `ornament-vision.pointInPolygon`, `FlattenRegion.isPointInPolygon`) as thin calls to the shared function. Leave callers' argument order alone.
3. Move `tileOf` into the same commit series as `slippyTile(lat, lng, z)` in a new `common/coordinate/geodesy.ts`.

### Phase 3: one Earth model for placing positions (3–5 h plus build check)

Create `packages/core/src/common/coordinate/geodesy.ts`:

- `planarFrame(origin)`: returns `{ toLocal([lng, lat]) → [x, z], toLngLat([x, z]) }` in the scan convention (x east, z south). It is backed by `LocalTangentPlane` at the origin height, so it agrees exactly with `geodeticToScan`. It must reuse one `LocalTangentPlane` instance; `geodeticToScan` currently constructs a new one per point, which is worth fixing in the same change.
- `metresPerDegree(lat)`: ellipsoid meridian and parallel lengths. This is for radius and bounding-box code that needs a scale, not a position.
- `haversineM(a, b)`: moved from `google-maps-service.ts`.

Bearing and destination are deliberately omitted until a caller needs them.

Migrate in this order, one commit each, with the Phase 1 test updated to expect agreement:

1. **`facade-footprints.toTileFrame` → `planarFrame`**. This is the actual fix. Re-run the Haughwout build and compare against the Phase 1 baseline. It must match or beat 116k / 38.7k / 0 degradations, and `footprintAgreement` must not get worse. Send before/after screenshots of footprints overlaid on the scan.
2. **`google-solar-service.ts:294-303` → `metresPerDegree(anchorLat)`**. This removes the New York-only constant. Add a test at a non-New York latitude.
3. **`building-shape.ts` `LocalFrame` → `planarFrame`**. This is a ground-truth tool, so reported areas change by up to about 0.7%. Note the change in the commit message.
4. **`google-vector-mapping-service.ts` and `geojson-vector-service.ts`**. Read first whether their positions are drawn together with tiles in the viewport. Migrate only if they are; otherwise leave them and record why.
5. **Radius / bounding-box / de-duplication sites** (the list in §2, Gap A): switch the bare constants to `metresPerDegree` for one consistent source. Behaviour changes are under 1% of a threshold. This step is optional and can be its own small PR.

### Phase 4: keep it from coming back (30 min)

Add `packages/core/test/no-flat-earth-constants.test.ts`, in the style of `instruction-tool-drift.test.ts`. It fails if `packages/core/src` (outside `geodesy.ts`) contains `111_320`, `111320`, `111000.0`, `111139` or `84400` as metres-per-degree literals, or a new private `pointInPolygon` / `pointInRing`. It uses an allow-list for any site deliberately left in Phase 3.5.

### Phase 5: verification

- `npm run typecheck`, and vitest with credentials unreachable (empty `HOME`, credential variables unset).
- Phase 2 equivalence tests pass before each copy is deleted.
- One Haughwout staged build after Phase 3.1, compared to the baseline via `watch-staged-build`, with screenshots.
- No claim that something passed without exit code 0 (§6.2).

## 5. Effort and order

| Phase | Effort | Risk | Ships alone? |
|---|---|---|---|
| 1 Measure | ~1 h | none | yes (test only) |
| 2 Planar ring | 2–3 h | low: equivalence-tested | yes |
| 3.1 Facade frame fix | 1–2 h + build | medium: changes facade placement | yes, after build check |
| 3.2 Solar constant | 30 min | low | yes |
| 3.3 building-shape | 30 min | low: reported areas shift <1% | yes |
| 3.4–3.5 Remaining sites | 1–2 h | low | optional |
| 4 Guard test | 30 min | none | yes |

Total: about one working day, mostly verification. Commit shape: one logical change per commit, staging only touched files (§6.6).

## 6. Open decision

Phase 3.3 changes numbers reported by a ground-truth tool (`location_building_shape`). They become more correct, but anyone comparing with old outputs will see area shifts of up to about 0.7%. Decide whether that is acceptable or should be called out in the tool's result.
