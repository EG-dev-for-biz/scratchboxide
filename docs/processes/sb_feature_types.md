# Design: one feature model for Google's vector features and ours (`sb-feature/1`)

> **Recorded:** 2026-10-19
> **Status:** Verified (model, Google pass-through and guardrail test); first consumer is the residual audit
> **Tags:** `feature-types` `ada` `google-vector-tiles` `labels` `export`
> **Target Domain:** Spatial data contracts (`packages/core/src/common/spatial/sb-feature-types.ts`)

## The model

Features follow the style of Google's FeatureTile: a feature carries `types: string[]`, which are SCREAMING_SNAKE codes from general to specific, several at once. Its geometry sits in separate named blocks.

**Codes**

* Google's codes (`FEATURE_TYPE_*`) pass through unchanged.
* Ours all start with `SB_FEATURE_TYPE_`, so the two sets never collide.

**Geometry blocks**

* Google's blocks are carried as received: `extrudedAreas`, `areas`, `lines`, `modeledVolumes`.
* Ours add one block per universal operator:

| Block | What it holds |
| :--- | :--- |
| `revolvedProfiles` | axis, r(z), lobes, twist |
| `sweeps` | carrier curve, profile, scale and twist along it |
| `replicators` | seed reference, pitch, count, carrier |
| `reliefFields` | displacement map, scale, pixel size |

**Other fields**

* `measurements`: metres from the scan, open names.
* `provenance`: `measured`, `vector-modelled`, `photo-inferred`, `generated` (open), with confidence, sources and method.
* `relations`: `PART_OF`, `STANDS_ON`, `ATTACHED_TO`, `OCCLUDES` (open).
* `displayName` and `placeId` pass through.
* `typeLabels`: per code, a confidence and who proposed it.

**Schema rules**

* The schema id is `sb-feature/1`.
* Codes are never renamed, only deprecated (`deprecated: { since, useInstead }`).

## Starter codes

There are 43 starter codes.

* **Parents:** `OBJECT` (the catch-all, always valid, with a free-text description and a confidence), `BUILDING_PART`, `WALL_SURFACE`, `ROOF_SURFACE`, `GROUND_SURFACE`.
* **`ROOF_OBJECT`** and its children: `_TANK`, `_CHIMNEY`, `_BULKHEAD`, `_EQUIPMENT`, `_SKYLIGHT`, `_DORMER`, `_DOME`, `_SPIRE`, `_MAST`, `_SIGN_FRAME`, `_PARAPET`, `_RAILING`, `_SOLAR_ARRAY`.
* **`FACADE_ELEMENT`** and its children:
  * `_OPENING`, with `_WINDOW`, `_DOOR` and `_STOREFRONT` under it;
  * `_BAND`, `_CORNICE`, `_COLUMN`, `_BALCONY`, `_BAY`, `_FIRE_ESCAPE`, `_AWNING`, `_SIGN`, `_ORNAMENT`, `_FIGURE`.
* **Street and planting:** `TREE`, `STREET_FURNITURE`, `POLE`.
* **Scan states:** `SCAN_ARTEFACT` (with `_SLIVER`, `_FLOATING`, `_SPIKE`), `SCAN_UNEXPLAINED`, `OCCLUDED`.

Each code has a description in our own words, a parent, and a CityGML 3.0 class and/or OSM tags for export. Add a code only when a consumer needs it.

## Guardrails (ADA)

* **The vocabulary is open.** `types` is `string[]`, and an unknown code is accepted and kept. `reviewUnknownCodes` reports an unknown `SB_FEATURE_TYPE_*` code that a model proposed, for review. It never adds the code to the list.
* **No code selects a geometry path.** Geometry comes only from the operator blocks and the measurements. `sb-feature-types.test.ts` scans `packages/core/src` and `scripts` for comparisons, switches or matches on our codes outside the model file. In the residual audit, a test relabels a cluster and checks that its verdict does not change.
* **A model may stop at a parent code** with a confidence. `typesFromLabels` fills in the parents.

## Google pass-through

* `decodeFeatureTile` now also returns `features: SbFeature[]`. Each one carries the raw feature's types and geometry blocks exactly as received, in tile grid units, plus its label text as `displayName` and its `placeId`.
* Provenance is `vector-modelled` from `google-vectortiles`.
* The decoder's existing outputs (`buildings`, `roads`, …) are unchanged.

## AGENTS.md

* The "Open Feature-Type Vocabulary (Labels Only)" line under ADA pillar 1 has landed on main. It names `packages/core/src/common/spatial/sb-feature-types.ts`, which is the path used here.

## Not done (by request)

* Codes in roof and facade vision prompts.
* Feature records in GLB extras, merged parts, a provenance view, and export.
