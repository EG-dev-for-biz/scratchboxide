---
name: universal-tile-decomposition
description: >-
  Measure, slice and carve photogrammetric 3D tiles (.glb) with the UTDRA / ULDRA native C++20 tools: measurements
  (bounds, relief, surface area by slope band, wall orientation, vertex-colour green index), elevation slicing that
  clips straddling triangles, and removal of near-vertical curtain-wall triangles inside a span box the caller gives.
  The tools classify nothing; the agent interprets the measurements.
---

# UTDRA / ULDRA: tile measurements, elevation slicing and span carving

The UTDRA tools work on a tile GLB they are given (a Google 3D Tiles clay extraction, a scan, any untextured mesh with
one material and baked transforms). They report what they measured or removed. They do not classify a tile into a
domain, report a confidence, or "rectify" anything on their own judgement.

---

## 1. What each tool does

| Tool | Input | What it does | Output |
| :--- | :--- | :--- | :--- |
| `utdra_probe_tile` | `inputGlbPath` | Measures the tile: bounds, relief ΔY, surface area, the share of that area by slope band (horizontal < 15°, inclined 15–45°, steep 45–75°, vertical ≥ 75°), the dominant wall orientation (mod 90°), and the area-weighted vertex-colour green index when the tile has vertex colours. | Telemetry only; no GLB is written. |
| `utdra_slice_elevation` | `inputGlbPath`, `cutoffY` | Keeps the part of the tile above `cutoffY`, clipping straddling triangles exactly (Sutherland-Hodgman). | A GLB with the input's own material. |
| `utdra_carve_bridge_voids` | `inputGlbPath`, `span {minX, maxX, minZ, maxZ, groundY, deckY}`, optional `minVoidHeightMeters` | Removes every near-vertical triangle wholly inside the span box. It does not find bridges: the box comes from the user or from coordinates you measured. A building wall inside the box is removed too. | A GLB with the input's own material, and the number of triangles removed. |

The tools refuse a GLB they would misread or strip (node transforms, instancing, non-triangle primitives, compressed
or sparse accessors, several materials, textures) instead of returning it moved or recoloured.

---

## 2. Reading the measurements

The probe gives numbers, not a label. For example, a tile whose area is mostly vertical with a large relief and
walls aligned to one orientation is likely a street of tall buildings; a tile with a large inclined share and low
relief may be pitched roofs or a hillside; a positive green index means the vertex colours are green, which only
means something when the tile carries colours. Say what the numbers are when you report them, and do not present an
interpretation as a measurement.

---

## 3. Calls

```json
{ "name": "utdra_probe_tile", "args": { "inputGlbPath": "public/models/midtown_clay.glb" } }
```

```json
{ "name": "utdra_slice_elevation", "args": { "inputGlbPath": "public/models/midtown_clay.glb", "cutoffY": -2.0, "outputGlbPath": "public/models/midtown_above_ground.glb" } }
```

```json
{
  "name": "utdra_carve_bridge_voids",
  "args": {
    "inputGlbPath": "public/models/overpass_clay.glb",
    "span": { "minX": -40, "maxX": 40, "minZ": -6, "maxZ": 6, "groundY": 0, "deckY": 7.5 },
    "minVoidHeightMeters": 3.5,
    "outputGlbPath": "public/models/overpass_carved.glb"
  }
}
```

---

## 4. TypeScript API

```typescript
import { UniversalTileDecompositionService } from '@scratchbox/core';

const service = new UniversalTileDecompositionService();
const measured = await service.probeTile('public/tiles/manhattan_clay.glb');
console.log(measured.reliefMeters, measured.slopeAreaFractions.vertical);

const sliced = await service.sliceElevation('public/tiles/manhattan_clay.glb', -2.0, { outputGlbPath: 'public/tiles/manhattan_sliced.glb' });

const carved = await service.carveBridgeUnderpass('public/tiles/overpass_clay.glb',
    { minX: -40, maxX: 40, minZ: -6, maxZ: 6, groundY: 0, deckY: 7.5 },
    { minVoidHeightMeters: 3.5 });
console.log(`${carved.telemetry.removedTriangles} triangles removed`);
```

---

## 5. Atomic building integrity

1. Buildings are indivisible: never slice through a building or carve a span box that contains building walls you
   mean to keep.
2. Elevation slicing is for pruning below the ground (`cutoffY` at or below the foundation level). A cut above the
   ground removes the lower parts of every building.
3. Check `removedTriangles` and the measured bounds after every edit, and tell the user what was removed.
