# Google Map Tiles API: Vector Tiles (GCAP Automotive Program Specification)

> **Confidential Partner Reference**: Geo Cloud Automotive Program (GCAP) Vector Tiles API methods (`tile.googleapis.com/v1/vectortiles`).

Unlike standard 2D raster tiles or monolithic 3D textured mesh tiles, the **Map Tiles API Vector Tile methods** serve raw geographic geometry, true 3D modeled building volumes, detailed road marking polylines, and real-time traffic telemetry directly to partner applications.

---

## 1. REST Endpoints & Method Signatures

| Method | HTTP Path | Data Returned |
|---|---|---|
| **GetFeatureTiles** | `GET https://tile.googleapis.com/v1/vectortiles/featuretiles/{zoom}/{x}/{y}` | Basemap vector features: road networks, 3D building meshes (`modeledVolumes`), 2.5D extruded footprints, parcels, land cover, water, and lane markings. |
| **GetTrafficTiles** | `GET https://tile.googleapis.com/v1/vectortiles/traffictiles/{zoom}/{x}/{y}` | Real-time traffic flow polylines, congestion statuses, directional flow, and incident markers (closures, construction). |

### Path Parameters
- `zoom`: integer (Zoom level $0$ through $19$ inclusive).
- `x`: integer (Mercator tile X coordinate from northwest origin).
- `y`: integer (Mercator tile Y coordinate from northwest origin).

### Query Parameters (`GetFeatureTiles`)
- `enableModeledVolumes` (boolean, optional): Set to `true` to return true 3D building models (`modeledVolumes`) rather than 2.5D extruded prisms where available.
- `alwaysIncludeBuildingFootprints` (boolean, optional): If `true`, returns both 3D modeled volumes and 2.5D extruded footprints.
- `languageCode` (string, optional): BCP-47 language tag (e.g. `en-US`, `ja`).
- `regionCode` (string, optional): CLDR region code (e.g. `US`, `FR`, `AU`).
- `includeDisputedEntityContext` (boolean, optional): Include context about disputed political entities.
- `includeAllNameTranslations` (boolean, optional): Include all available translations for label texts.

---

## 2. Coordinate System Mathematics

### A. Global Mercator to Tile Coordinates
The API uses spherical Mercator projection with origin $(0, 0)$ at the northwest corner ($180^\circ\text{ W}, \approx 85.05^\circ\text{ N}$):
$$\text{worldCoordinate} \in [0, 256] \times [0, 256]$$
$$\text{pixelCoordinate} = \text{worldCoordinate} \cdot 2^{\text{zoomLevel}}$$
$$\text{tileCoordinate} = \left\lfloor \frac{\text{pixelCoordinate}}{256} \right\rfloor$$

### B. Sub-Pixel Tile Local Coordinates ($4096 \times 4096$)
Inside each tile, vertex positions are represented in **Tile Local Coordinates** (point-within-tile):
- Top-left: $(0, 0)$
- Bottom-right: $(4095, 4095)$
- **Resolution**: $16\times$ higher resolution than standard $256 \times 256$ pixel raster tiles.
- Coordinates may extend slightly outside $[0, 4095]$ to ensure seamless geometric continuity across tile borders.

### C. Signed Delta Encoding (`vertexOffsets`)
Vertices are serialized as an efficient list of signed differences relative to the previous point:
$$p_0 = (\Delta x_0, \Delta y_0)$$
$$p_i = p_{i-1} + (\Delta x_i, \Delta y_i)$$

For 3D geometry (`modeledVolumes`), `zOffsets` provides relative elevation:
$$p_i = p_{i-1} + (\Delta x_i, \Delta y_i, \Delta z_i)$$

---

## 3. Geometric Schema Hierarchy

### A. Areas (`Area`)
Polygonal regions (water, parks, parcels, pavement surfaces).
- `vertexOffsets`: signed $\Delta x, \Delta y$ coordinate arrays.
- `type`:
  - `INDEXED_TRIANGLES`: Mesh defined by `triangleIndices` (3 indices per triangle). `loopBreaks` identify exterior/interior boundary loops for styling.
  - `TRIANGLE_FAN`: First vertex is the center hub, subsequent vertices fan outward.
  - `TRIANGLE_STRIP`: Strip sharing alternating edges.
- `hasExternalEdges` / `internalEdges`: Differentiates boundaries between adjacent features (e.g. water shoreline vs. internal tile seam).

### B. Lines (`Line`)
Polylines representing road centerlines, curbs, lane markings, transit tracks, or administrative borders.
- `vertexOffsets`: signed $\Delta x, \Delta y$ coordinate chain.
- `basemapZOrder`: Z-index for sorting above/below overlapping elements.

### C. Extruded Areas (`ExtrudedArea`)
2.5D building footprints extruded into 3D prisms.
- `area`: Base polygonal footprint (`Area`).
- `minZ`: Local z-value where extrusion starts (non-zero for skybridges or cantilevered structures).
- `maxZ`: Local z-value where extrusion terminates ($4096$ units corresponds to the width of the tile).

### D. Modeled Volumes (`ModeledVolume`) — True 3D Buildings
Photorealistic architectural massing with custom roof profiles, setbacks, and non-prismatic geometry.
- `vertexOffsets`: `xOffsets`, `yOffsets`, `zOffsets` 3D relative coordinate lists.
- `strips`: Array of `TriangleStrip` objects containing `vertexIndices` into the vertex array.

### E. Drawing Order (`BasemapZOrder`)
To eliminate visual conflicts and z-fighting on 2D planes, evaluate in exact hierarchical order:
1. `zPlane` (integer): Most significant layer component (e.g., ground vs. elevated bridge vs. skyway).
2. `zGrade` (integer): Secondary component distinguishing elements within the same `zPlane`.
3. `zWithinGrade` (int64 string): Fine-grained tie-breaker ensuring deterministic rendering.

---

## 4. Road & Detailed Infrastructure Hierarchy

### Detailed Road Markings Taxonomy
```
FEATURE_TYPE_INFRASTRUCTURE
 └── FEATURE_TYPE_ROAD
      └── FEATURE_TYPE_DETAILED_ROAD
           ├── FEATURE_TYPE_DETAILED_ROAD_SURFACE (Asphalt areas)
           └── FEATURE_TYPE_DETAILED_ROAD_MARKINGS
                ├── FEATURE_TYPE_DETAILED_ROAD_CROSSWALK (Pedestrian crosswalk areas)
                ├── FEATURE_TYPE_DETAILED_ROAD_LANE_MARKING (Lane divider lines)
                │    └── FEATURE_TYPE_DETAILED_ROAD_LANE_MARKING_CROSSABLE (Dashed lines)
                └── FEATURE_TYPE_DETAILED_ROAD_LANE_TURN_ICONS (Turn arrow stencil areas)
```

### Road Metadata (`RoadInfo`)
- `priority`: `ROAD_PRIORITY_TERMINAL`, `ROAD_PRIORITY_MOTORWAY`, `ROAD_PRIORITY_PRIMARY`, etc.
- `isPrivate`: Boolean indicating restricted/private roads.
- `isFerry`: Boolean for water ferry routes.
- `elevationCategory`: Populated as `TUNNEL` for underground infrastructure.
- `usageCategory`: `PEDESTRIAN_MALL`, `TRAIL`, `RAMP` (slip roads/highway connectors).

---

## 5. Caching & Versioning (`ETag`)

The Vector Tiles API supports client-side ETag caching:
1. Inspect response header `ETag` on initial tile fetch.
2. In subsequent queries, send `If-None-Match: <etag>`.
3. If unchanged, the REST API returns `HTTP 304 Not Modified`, preserving client cache and eliminating quota consumption.

---

## 6. Authentication & Authorization Scopes

- **OAuth 2.0 Scopes**:
  - `https://www.googleapis.com/auth/cloud-platform`
  - `https://www.googleapis.com/auth/maps-platform.tiles`
- **API Key Authentication**:
  - Header: `x-goog-api-key: <YOUR_API_KEY>`
  - Or query parameter: `?key=<YOUR_API_KEY>`
