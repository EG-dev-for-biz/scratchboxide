---
name: vector-spatial-intelligence
description: >-
  Query, extract, and fuse 2D vector roadmap and cadastral parcel data (kinematic road corridors, lane centerlines, building footprints with verified heights, bridge/tunnel vertical layers, landuse surface friction, POIs) with Google 3D Photorealistic Tiles, UTDRA, NOAA solar ephemeris, and Video Timeline NLE. Enforces Universal Spatial Identifiers (urn:scratchbox:spatial:<layer>:<geohash>:<id>) and the Zero-Fake-Trees reality grounding invariant.
---

# Vector Spatial Intelligence & Multi-Modal 3D Data Synergy

The **Vector Spatial Intelligence Skill** guides AI agents and engineers in querying, interpreting, and fusing 2D vector roadmap and cadastral parcel tiles with the 3D photorealistic, geometric, atmospheric, and video pipelines across Scratchbox IDE.

---

## 1. Core Architectural Paradigm: The "Skin & Bones" Synergy

Never treat 2D vector roadmap data as an isolated rendering layer. The foundational principle in Scratchbox IDE is the **Skin & Bones Architecture**:

```
 ┌──────────────────────────────────────────────┐    ┌──────────────────────────────────────────────┐
 │       Google Photorealistic 3D Tiles         │    │       Google 2D Vector Roadmap Tiles         │
 │              (The Visual Skin)               │    │           (The Semantic Skeleton)            │
 ├──────────────────────────────────────────────┤    ├──────────────────────────────────────────────┤
 │ • Authentic photographic surface textures    │    │ • Kinematic road splines & lane centerlines  │
 │ • Real, biophysically grounded tree canopies │    │ • Legal traffic headings & speed limits      │
 │ • Continuous, irregular WGS84 terrain relief │    │ • Exact 2D cadastral building footprints     │
 │ • Architectural facade details & ornamentation│   │ • Verified building heights (null if unknown)│
 │ • Atmospheric depth & material reflections   │    │ • Structural Z-ordering (bridges & tunnels)  │
 │                                              │    │ • Clickable Universal Spatial IDs (URNs)     │
 └──────────────────────┬───────────────────────┘    └──────────────────────┬───────────────────────┘
                        │                                                   │
                        └─────────────────────┬─────────────────────────────┘
                                              │
                                              ▼
                             [Multi-Modal Spatial Data Fusion]
                        ┌───────────────────────────────────────────┐
                        │ • Sub-millimeter ENU Co-Registration      │
                        │ • UTDRA Span-Box Curtain Carving          │
                        │ • Raycast Click-to-Identify HUD Billboard │
                        │ • 2D Analytical Excavation Stencils       │
                        │ • Kinematic Vehicle & Camera Choreography │
                        │ • Real-Tree Extraction (DSM + ExG)        │
                        └───────────────────────────────────────────┘
```

---

## 2. Universal Spatial Identifiers (`UniversalSpatialId`)

To ensure every asset, mesh node, raycast hit, and HUD label references a singular source of truth across the IDE, all entities extracted from vector tiles are assigned a deterministic, universally unique spatial URN:

$$\text{URN} = \mathbf{urn:scratchbox:spatial}:\langle\text{layer}\rangle:\langle\text{geohash}_{10}\rangle:\langle\text{slug}\rangle$$

### Layer Taxonomies
- **`building`**: Cadastral parcel footprint (`urn:scratchbox:spatial:building:dr5regw3p2:empire-state-building-0`)
- **`road`**: Kinematic centerline corridor (`urn:scratchbox:spatial:road:dr5regw3p2:5th-avenue-1`)
- **`landuse`**: Surface zoning & acoustic friction mask (`urn:scratchbox:spatial:landuse:dr5regw3p2:greeley-square-park-0`)
- **`water`**: Hydrology basin polygon (`urn:scratchbox:spatial:water:dr5regw3p2:reflecting-pool-0`)
- **`poi`**: Point of interest / commercial anchor (`urn:scratchbox:spatial:poi:dr5regw3p2:observation-deck-0`)

### Propagation Across IDE Foundations
1. **glTF 2.0 Node Extras**: Packed into `node.extras.universalSpatialId` during GLB compilation.
2. **Universal 3D Structure Foundation**: Indexed inside `Universal3DStructureFoundation.addSpatialNode(...)`.
3. **WebXR Geospatial Anchors**: Bound directly to geodetic lat/lng via `WebXRGeospatialAnchorBridge`.
4. **Canvas HUD Viewports**: Linked to interactive 3D billboard cards in `Scene3DPrimitive`.

---

## 3. Sub-Millimeter Co-Registration Invariant

Vector roadmap data and Google Photorealistic 3D Tiles MUST share the exact same Local Tangent Plane (LTP) projection matrix derived from the WGS-84 reference ellipsoid ($a = 6378137.0\text{ m}, \, f = 1/298.257223563$):

$$\begin{aligned}
X &= (\mathbf{P}_{\text{ECEF}} - \mathbf{O}_{\text{ECEF}}) \cdot \mathbf{East} \\
Y &= (\mathbf{P}_{\text{ECEF}} - \mathbf{O}_{\text{ECEF}}) \cdot \mathbf{Up} \\
Z &= -(\mathbf{P}_{\text{ECEF}} - \mathbf{O}_{\text{ECEF}}) \cdot \mathbf{North}
\end{aligned}$$

- Both `GoogleTileDistrictCrawler.ts` and `SpatialVectorDataService.ts` execute this exact transformation.
- Guarantees $0.000\text{ mm}$ theoretical offset between 2D vector building footprint edges and 3D photogrammetric facades.

---

## 4. Multi-Source Data Fusion Workflows

### Workflow 1: Click-to-Identify & Raycasting on 3D Photorealistic Tiles
Raw 3D photorealistic tiles are "dumb" continuous meshes with photogrammetric textures; they have no concept of individual buildings or parcels.
1. When a user clicks a point $\mathbf{P} = [X, Y, Z]$ in the 3D viewport or camera ray hits a mesh:
2. Query `SpatialVectorDataService.queryBuildingAt(dataset, [X, Y, Z])`.
3. Performs 2D point-in-polygon raycasting against cadastral polygons.
4. Returns the `UniversalBuildingFeature`: name, verified height, floor count, building type, area, and `universalId`.
5. Renders a 3D HUD billboard hovering at $(X, Y_{\text{height}} + 2.5\text{m}, Z)$.

### Workflow 2: Analytical Building Excavation Stencils
When replacing an existing building in a real city with a custom user-generated CAD/BIM model:
1. Call `SpatialVectorDataService.generateExcavationStencil(building)`.
2. Yields the 2D footprint polygon in local ENU space and an Oriented/Axis-Aligned Bounding Box.
3. In Three.js / C++20 engine, apply a stencil buffer or CSG subtraction against the Google 3D Tile mesh.
4. The existing photogrammetric building is excised with zero tears, leaving a clean foundation hole for the hero asset.

### Workflow 3: Automated Underpass Void Carving with UTDRA
Raw photogrammetry suffers from "curtain walls"—solid geometry stretching beneath bridges down to water or road surfaces because aerial sensors cannot see underneath.
1. `SpatialVectorDataService` flags roads where `isBridge === true` and `layerIndex > 0`.
2. Extract the bridge corridor polyline and width $W$.
3. Convert the corridor's footprint to the tile's local coordinates and pass it, with the ground and deck elevations, as the `span` box of `utdra_carve_bridge_voids` (`UniversalTileDecompositionService.carveBridgeUnderpass`).
4. UTDRA removes the near-vertical triangles inside that box and reports how many; the deck (horizontal) and everything outside the box stay. A long or curved corridor is carved as several boxes.

### Workflow 4: Authentic Vegetation Grounding (Strict Prohibition on Fake Trees)
**Invariant**: 2D vector roadmap tiles do NOT contain real-world tree coordinates. Scattering procedural "lollipop" trees across parks or sidewalks based on 2D vector landuse polygons is **strictly prohibited**.
- **The Solution**: Real trees are physically present in Google 3D Photorealistic Tiles.
- To isolate trees cleanly, pair with **`GoogleSolarFoliageClassifier`**:
  1. Fetch Google Solar API `dataLayers` (0.1m DSM, DTM, and RGB orthophoto).
  2. Compute normalized Digital Surface Model: $\text{nDSM} = \text{DSM} - \text{DTM}$.
  3. Compute Excess Green spectral index: $\text{ExG} = 2G - R - B$.
  4. Classify pixels where $\text{nDSM} \ge 2.50\text{ m}$ and $\text{ExG} > 10.0$ as authentic tree canopies.
  5. Yields authentic real-world tree coordinates, canopy diameters, and tree heights.

### Workflow 5: Kinematic Camera & Vehicle Choreography (Omni 1.1 & NLE)
When directing a car chase, autonomous vehicle simulation, or drone flyover:
1. `UniversalRoadFeature` provides precomputed `laneCenterlinesEnu` arrays.
2. Select a target lane: `laneCenterlinesEnu[laneIndex]`.
3. Construct a $C^2$-continuous Catmull-Rom spline through the lane points.
4. Vehicle positions $\mathbf{x}(t)$ evaluate along the spline; yaw angle aligns with $\operatorname{atan2}(dx, dz)$.
5. For camera matchmoving in Video Timeline NLE, position the camera at offset $\Delta \mathbf{x} = \mathbf{x}_{\text{veh}} - \mathbf{v}_{\text{tangent}} \cdot 8\text{m} + [0, 2.5, 0]$.
6. Renders the blockout video `<VIDEO_REF_0>` with 100% legal traffic adherence for Google Omni 1.1 video-to-video synthesis.

### Workflow 6: Diurnal Shadow Channeling (NOAA Ephemeris & Atmospheric Engine)
Urban street canyons create dramatic light channeling and shadow pockets:
1. `UniversalRoadFeature.headingStartDeg` provides the exact street azimuth $\phi_{\text{street}}$.
2. Building heights $H$ provide canyon aspect ratios $H / W$.
3. Compute diurnal solar position $(\alpha_{\text{sun}}, \phi_{\text{sun}})$ via `Atmospheric3DPipelineService.getSolarPosition(lat, lng, date)`.
4. When $|\phi_{\text{sun}} - \phi_{\text{street}}| < 1.5^\circ$, trigger **"Manhattanhenge"** crepuscular god ray rendering with Henyey-Greenstein Mie scattering ($g \approx 0.76$).

### Workflow 7: Universal Global Fallback via Satellite & Aerial Orthophotography
Outside the thousands of metropolitan areas with Google 3D Photorealistic mesh tiles, or in off-road wilderness where Street View was never captured:
1. Every query to `SpatialVectorDataService.querySpatialVectorData` automatically computes **`dataset.satelliteFallback`** (`UniversalSatelliteFallback`).
2. Provides deterministic WGS-84 bounding coordinates (`boundsWgs84`), Mercator tile coordinates $(X, Y, Z)$, and high-resolution Static Maps URLs.
3. In Three.js / Scratchbox C++20 engine, the satellite imagery is draped directly onto the global Digital Elevation Model (DEM) terrain heightfield via standard Mercator UV unwrapping:
   $$u = \frac{\lambda - \lambda_{\min}}{\lambda_{\max} - \lambda_{\min}}, \quad v = \frac{y(\phi) - y(\phi_{\min})}{y(\phi_{\max}) - y(\phi_{\min})}$$
4. Guarantees **100% universal global surface coverage** across every ocean, desert, mountaintop, and rural boundary on Earth with zero rendering voids.

---

## 5. Universal Spatial Fallback Hierarchy

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ TIER 1: HIGH-DENSITY METRO & LANDMARKS (~50+ COUNTRIES)                                │
│ • Google 3D Photorealistic Mesh Tiles (Volumetric 3D Hull)                             │
│ • 2D Vector Roadmap & Cadastral Parcels (Semantic Skeleton & Kinematics)               │
│ • Google 360 Street View Panoramas (Ground-Level Photography & Depth Planes)           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TIER 2: SUBURBS, TOWNS & MAPPED ROADWAYS                                               │
│ • Google 3D DEM Terrain Elevation Heightfield                                          │
│ • 2D Vector Roadmap Kinematic Network & Landuse Polygons                               │
│ • Google 360 Street View Panoramas (Available on Public Mapped Roads)                  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ TIER 3: COMPLETE GLOBAL FALLBACK (100% WORLDWIDE COVERAGE)                             │
│ • High-Resolution Orthorectified Satellite / Aerial Imagery (Draped on DEM)            │
│ • Global WGS-84 Elevation Terrain                                                      │
│ • Hydrography, Regional Landuse & Geographic Place Boundaries                          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Codebase API & Agent Tool Reference

### TypeScript API
```typescript
import { SpatialVectorDataService } from '@scratchbox/core';

// 1. Query rich vector dataset co-registered with Google 3D Tiles
const dataset = await SpatialVectorDataService.querySpatialVectorData({
    latitude: 40.7484,
    longitude: -73.9857,
    radiusMeters: 300,
    layers: ['building', 'road', 'landuse', 'poi']
});

// 2. Access 100% Global Satellite Fallback for Terrain Draping
console.log(`Satellite Source: ${dataset.satelliteFallback.source}`);
console.log(`Static Map URL: ${dataset.satelliteFallback.staticMapUrl}`);
console.log(`Bounding Box: N:${dataset.satelliteFallback.boundsWgs84.north}, S:${dataset.satelliteFallback.boundsWgs84.south}`);

// 3. Click-to-Identify building at 3D local coordinate
const building = SpatialVectorDataService.queryBuildingAt(dataset, [25.4, 0.0, -112.8]);
if (building) {
    console.log(`Building: ${building.name}, Verified Height: ${building.heightM}m, Universal ID: ${building.universalId}`);
}

// 4. Snap vehicle to nearest road lane
const nearest = SpatialVectorDataService.queryNearestRoad(dataset, [10.0, 0.0, -50.0]);
if (nearest) {
    console.log(`Snapped to ${nearest.road.name}, Lane ${nearest.laneIndex}, Heading ${nearest.headingDeg}°`);
}

// 5. Generate excavation stencil for custom building placement
const stencil = SpatialVectorDataService.generateExcavationStencil(building);
```

### Agent Tool: `query_spatial_vector_data`
Agents can directly invoke the unified spatial vector tool:
```json
{
  "name": "query_spatial_vector_data",
  "arguments": {
    "latitude": 40.7484,
    "longitude": -73.9857,
    "radiusMeters": 250,
    "queryType": "overview"
  }
}
```

**Specialized `queryType` Modes**:
- `overview`: Complete statistical summary and feature lists with Universal Spatial URNs.
- `building_at_point`: Returns building metadata for a specific local metric ENU point `[X, Y, Z]`.
- `nearest_road`: Calculates closest road corridor, lane index, and heading for a local point.
- `excavation_stencil`: Returns 2D polygon stencil and 3D bounding box for clipping Google 3D Tiles.
- `kinematic_graph`: Returns interconnected nodes and directed road segments for traffic/camera simulation.
- `semantic_annotations`: Generates 3D HUD billboard label markers with heights and tags.
