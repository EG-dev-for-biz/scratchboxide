---
name: universal-tile-decomposition
description: >-
  Decompose, probe, and rectify photogrammetric 3D tiles using the Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA)
  via native C++20 engine and TypeScript API. Classifies across 9 macro-geographic domains, rectifies building shafts while preserving crowns,
  excises bridge curtain walls, and executes non-destructive elevation slicing with zero hole formation.
---

# Universal Tile Decomposition & Rectification Algorithm (UTDRA / ULDRA)

The **Universal Tile Decomposition & Rectification Skill** equips AI agents to inspect, classify, and mathematically rectify raw photogrammetric 3D tiles (such as Google Photorealistic 3D Tiles, Cesium datasets, or drone scans) into clean architectural massings and topological terrain meshes.

---

## 1. System Architecture

```
[Raw Photogrammetric 3D Tile (.glb)]
                 │
                 ▼
     [Macro-Domain Classifier]
 (Urban, Suburban, Bridge, Mountain, Forest, etc.)
                 │
  ┌──────────────┼──────────────┬──────────────┐
  ▼              ▼              ▼              ▼
[Shaft & Crown] [Bridge Void]  [Elevation]    [Slope Biomes]
Rectification   Carver         Slicer         Stratification
(Planar facade  (Excises       (Sutherland-   (Turf, scree,
 & spires)      curtain walls) Hodgman)       bedrock)
  └──────────────┼──────────────┴──────────────┘
                 │
                 ▼
  [Standard Binary glTF 2.0 (.glb) Object]
  - Magic header: 0x46546C67 ("glTF")
  - Manifold preserved mesh (zero holes)
  - Full geometric telemetry (runtime, triangles, planarity)
                 │
                 ▼
   [Mount to Stage / 3D Canvas / NLE]
```

---

## 2. 9 Macro-Geographic Domains & Probe Telemetry

The classification engine analyzes geometric relief ($\Delta Y$), surface normal verticality ($\mathbf{N} \cdot [0, 1, 0]$), horizontal footprint aspect ratio, and slope variance without mutating the input mesh:

| Domain | Characteristic Telemetry | Primary Rectification Action |
| :--- | :--- | :--- |
| **UrbanHighRiseCore** | Relief $> 60\text{m}$, Verticality $> 0.65$ | Planar shaft rectification + sculptural crown preservation |
| **SuburbanResidential** | Relief $< 25\text{m}$, Pitched roofs $\sim 35^\circ$ | Gable / hip roof facet preservation + eave separation |
| **CivilInfrastructure** | Multi-level elevation variance under decks | Multi-level underpass void carving ($\ge 3.5\text{m}$ clearance) |
| **MountainAlpineCanyon** | Relief $> 100\text{m}$, High slope variance | Slope-stratified physical PBR biomes (turf to bedrock) |
| **ForestWoodlandCanopy** | Dense high-NDVI foliage domes | Understory trunk synthesis + crown preservation |
| **IndustrialLogistics** | Expansive low-pitch planar roofs | Large-footprint slab extraction |
| **CoastalShorelineHarbor** | Flat sea-level planes + piers | Hydrographic clipping and shoreline seam welding |
| **AridDesertBadlands** | Layered sedimentary stratigraphy | Stepped bench contour preservation |
| **OpenAgriculturalPlains** | Continuous low relief ($\Delta Y < 5\text{m}$) | Quad-aligned terrain surface optimization |

---

## 3. Dedicated In-App Agent Tools

Agents can call these 4 tools directly via Gemini Function Calling:

### 1. `utdra_probe_tile`
Probes and telemetrically classifies a 3D tile without mutating geometry.
```json
{
  "name": "utdra_probe_tile",
  "args": {
    "inputGlbPath": "public/models/midtown_manhattan_raw.glb",
    "benchmark": "urban"
  }
}
```

### 2. `utdra_decompose_tile`
Executes end-to-end decomposition, planar shaft rectification, and crown preservation.
```json
{
  "name": "utdra_decompose_tile",
  "args": {
    "inputGlbPath": "public/models/chrysler_building_raw.glb",
    "mode": "full",
    "outputGlbPath": "public/models/chrysler_rectified.glb"
  }
}
```

### 3. `utdra_slice_elevation`
Non-destructively slices geometry across an elevation plane ($y$) using the Sutherland-Hodgman analytical polygon clipping kernel.
```json
{
  "name": "utdra_slice_elevation",
  "args": {
    "inputGlbPath": "public/models/elevation_study.glb",
    "cutoffY": 5.0,
    "outputGlbPath": "public/models/elevation_sliced.glb"
  }
}
```

### 4. `utdra_carve_bridge_voids`
Excises false photogrammetric vertical curtain walls beneath elevated bridges and viaducts.
```json
{
  "name": "utdra_carve_bridge_voids",
  "args": {
    "inputGlbPath": "public/models/brooklyn_bridge_raw.glb",
    "minVoidHeightMeters": 3.5,
    "outputGlbPath": "public/models/brooklyn_bridge_carved.glb"
  }
}
```

---

## 4. TypeScript Codebase API Usage

Agents writing application code or synthesizing custom scripts can import the services directly:

```typescript
import {
    UniversalTileDecompositionService,
    UtdraService,
    UldraService
} from '@scratchbox/core';

const service = new UniversalTileDecompositionService();

// 1. Zero-mutation domain probe
const probeResult = await service.probeTile('public/tiles/manhattan_raw.glb');
console.log(`Classified as ${probeResult.telemetry.dominantDomain} (${probeResult.telemetry.confidence * 100}%)`);

// 2. Full UTDRA decomposition and GLB export
const decompResult = await service.decomposeTile({
    inputGlbPath: 'public/tiles/manhattan_raw.glb',
    mode: 'full',
    minVoidHeightMeters: 3.5,
    outputPath: 'public/tiles/manhattan_rectified.glb'
});

// 3. Sutherland-Hodgman Elevation Slicing
const slicedResult = await service.sliceElevation('public/tiles/manhattan_raw.glb', 12.0);

// 4. Bridge Void Carving
const bridgeResult = await service.carveBridgeUnderpass('public/tiles/bridge_raw.glb', {
    minVoidHeightMeters: 4.0
});
```
