---
name: google-3d-tiles-ingestion
description: >-
  Ingest any real-world address or geographic coordinates as a high-fidelity 3D object (.glb)
  rendered from Google Maps Photorealistic 3D Tiles in full photogrammetric texture or studio grey clay.
  Enforces zero presets, no procedural fallback, leaf LOD errorTarget <= 0.5, 4K screen-space error budget,
  and returns standardized binary glTF 2.0 with geometric mesh statistics.
---

# Google Photorealistic 3D Tiles Ingestion (Full Texture & Studio Clay)

The **Google 3D Tiles Ingestion Skill** enables AI agents to retrieve any geographic location or street address on Earth as a production-grade 3D model directly from the Google Maps Platform Photorealistic 3D Tiles API.

---

## 1. System Architecture

```
[User Request / Address / Coordinates]
                   │
                   ▼
       [Zero-Preset Geocoding]
 (Explicit coords or Google Geocoding API)
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
[Full Texture API]     [Studio Clay API]
(PBR Textures)         (Clay Grey Box)
         │                   │
         └─────────┬─────────┘
                   ▼
    [High-Fidelity 3D Tiles Ingestion]
  - Leaf LOD Target Error (errorTarget <= 0.5)
  - 4K UHD Screen-Space Error (3840x2160)
  - Async Octree Settle (downloading: 0, parsing: 0)
  - Multi-Waypoint Pre-Warming [0, 18, 36, 54, 71]
                   │
                   ▼
  [Standard Binary glTF 2.0 (.glb) Object]
  - Magic header: 0x46546C67 ("glTF")
  - Mesh statistics: vertexCount, triangleCount, bounds
  - Render frames & Quality report
                   │
                   ▼
   [Mount to Stage / 3D Canvas / NLE]
```

---

## 2. Dual Dedicated APIs

The system provides two distinct, separate APIs to prevent mode confusion and cross-contamination:

### 1. Full Texture API (`getGoogle3DTilesFullTexture`)
- Ingests photogrammetric PBR textures directly from Google Maps 3D Tiles.
- Best for realistic architectural visualization, drone matchmove background plates, and environmental staging.

### 2. Studio Clay API (`getGoogle3DTilesClay`)
- Applies a unified studio grey clay PBR material (`#b0b0b0`, roughness `0.75`, metalness `0.10`).
- Strips photogrammetric texture clutter for clean volumetric massing, shadow studies, structural alignment, and collision auditing.

---

## 3. Strict Zero-Preset & No-Fallback Contract

1. **Zero Hardcoded Presets**: The pipeline never looks up addresses in a static landmark dictionary. Any location on Earth can be queried.
2. **Zero Procedural Hash Fallback**: Queries without geodetic coordinates will never fall back to synthetic hash coordinates.
3. **Geodetic Requirement**:
   - Provide explicit geodetic coordinates, either as text that is only a coordinate pair (`"40.748400, -73.985700"`) or as `{ lat: 40.7484, lng: -73.9857 }`, OR a place name or address. A place name is resolved with one Google Places API (New) Text Search call (the Maps key from Settings, `GOOGLE_MAPS_API_KEY` or `MAP_TILES_API_KEY`), and the result reports the exact address it resolved.
   - Do not mix the two in one string (`"Midtown, coordinates: 40.7484, -73.9857"`): such text is not a coordinate pair, so all of it is sent to Places as a place name.
   - With no key, no Places result, or (0, 0) coordinates, the API throws `LocationUnresolvedError`; it never substitutes another place.
   - **Zero Uninvited Synthetic Ground Boxes**: When an authentic location is specified, agents MUST NEVER write Python code to stack flat asphalt boxes or lollipop trees in a void; let the geospatial engine extract authentic 3D massing or stage the vector world!

---

## 4. Ingestion Quality Standards & Zero-Building-Clipping Invariant

All 3D tile captures adhere to strict photogrammetric standards and architectural integrity rules:
- **Leaf LOD Geometric Error**: `errorTarget <= 0.5` (guarantees leaf octree geometry rather than coarse city blocks).
- **4K SSE Budget**: Screen-Space Error calculated against a $3840 \times 2160$ virtual viewport.
- **Asynchronous Settle**: Execution waits until `stats.downloading === 0 && stats.parsing === 0`.
- **Multi-Waypoint Pre-Warming**: Pre-warms camera waypoints `[0, 18, 36, 54, 71]` to load the entire flight corridor before collision detection or export.
- **Atomic Building Integrity (Zero Building Clipping)**:
  - Buildings, skyscrapers, and architectural entities are indivisible atomic units. Extraction boundaries must never slice through building envelopes or bisect vertical walls.
  - Slicing through facades or rooms to expose open, non-manifold hollow "dollhouse" shells or roofless walls is strictly forbidden.
- **Unbounded Vertical Skyward Extent ($Y_{\max} = +\infty$)**:
  - Vertical extraction volumes must NEVER cap the skyward dimension. $Y_{\max}$ remains unbounded ($+\infty$) or $\ge 2,500\text{m}$, guaranteeing that architectural crowns, spires, and penthouses are 100% preserved. Ground datum cuts only apply below lowest foundation level ($Y \le Y_{\text{ground}}$).
- **Multi-Tier Zenith Frustum Encompassment**:
  - Headless tile streaming employs multi-tier high-altitude zenith cameras ($\ge 1,800\text{m} - 2,500\text{m}$, FOV 75°, far plane $\ge 25,000\text{m}$) and upward-inclined horizon cameras covering the full vertical envelope of metropolitan skylines to eliminate camera near-plane and frustum culling on skyscrapers.
- **Boundary Dilation to Street Corridors**:
  - Extraction boundaries snap to natural clearings (street canyons, plazas, or waterways). If a boundary intersects a structure, it dilates to encompass the complete connected building.
- **Fresh Ingestion for New Workflows (Prohibition on Stale/Distorted Legacy Re-Use)**:
  - When initiating a new workflow, or whenever an existing model exhibits geometric distortion, shearing, or legacy editing artifacts, agents must NEVER inherit stale intermediate `.glb` assets from prior sessions.
  - Always download/extract a brand new 3D model directly from Google Maps Platform Photorealistic 3D Tiles (`getGoogle3DTilesFullTexture` / `getGoogle3DTilesClay`) at leaf LOD (`errorTarget <= 0.5`) to establish a pristine, uncorrupted ground-truth geometric foundation.

---

## 5. In-App Agent Tools & Geospatial Integrations

### 1. `google_3d_tiles_get_full_texture`
Ingest real-world geographic coordinates as a photorealistic, full-texture 3D GLB object rendered from Google Maps Photorealistic 3D Tiles at highest leaf LOD quality.

### 2. `google_3d_tiles_get_clay`
Ingest real-world geographic coordinates as a studio grey clay 3D GLB object (`clayPreset: 'studio-grey'`), capturing authentic metropolitan massing without texture noise.

### 3. An object standing at a real place
For one object at a real-world location (e.g., *"race car in Monaco"*), call `build_3d_object_from_reference` with that `location` and a `placement`; it stages the object on the place's clay tiles. `execute_3d_python_script` does not stage scripts on real places: a call with `location` or `coordinates` fails without running the script.

### 4. `stage_3d_vector_world`
For street-level vehicle and urban corridor staging, stages Google 2D Roadmap Vector Tiles (zoom 16) into 3D geometry: extruded building prisms, 5-tier road cross-sections with beveled granite curbs, sidewalks, streetlamps, and roadside trees in 18% Studio Grey Clay.

---

## 6. TypeScript API Usage

```typescript
import {
  getGoogle3DTilesFullTexture,
  getGoogle3DTilesClay,
  type Google3DTile3DObjectResult
} from '@scratchbox/core/node';

// Full Texture Ingestion
const texturedResult: Google3DTile3DObjectResult = await getGoogle3DTilesFullTexture(
  '40.748400, -73.985700',
  {
    outputGlbPath: 'public/models/midtown_textured.glb'
  }
);

// Studio Clay Ingestion
const clayResult: Google3DTile3DObjectResult = await getGoogle3DTilesClay(
  { lat: 40.748400, lng: -73.985700 },
  {
    outputGlbPath: 'public/models/midtown_clay.glb'
  }
);
```

### Mounting into Generative Canvas (`3d-scene`)
Once the `.glb` file is exported, the agent can mount it directly to the stage:

```typescript
await ctx.geminiService.executeMountCanvasPrimitive({
  primitiveType: '3d-scene',
  title: 'Midtown Manhattan 3D Tiles',
  summary: 'Ingested high-fidelity Google Maps Photorealistic 3D Tiles at leaf LOD.',
  payload: {
    modelUrl: texturedResult.glbPath,
    cameraPosition: [0, 50, 100],
    environment: 'city'
  }
});
```

---

## 7. Canonical Clay Blockout Runner (`<VIDEO_REF_0>`)

For generative video synthesis with Gemini Omni / Vertex AI, the **Google Maps 3D Tile Clay Blockout Runner** is the canonical standard for providing 3D spatial conditioning:

```typescript
import {
  runTileClayBlockoutRunner,
  create3DTilesOrbitTrajectory,
  create3DTilesPushInTrajectory,
  type TileClayBlockoutRunnerResult
} from '@scratchbox/core/node';

const blockoutResult: TileClayBlockoutRunnerResult = await runTileClayBlockoutRunner({
  query: 'Tokyo Tower, Minato City, Tokyo',
  trajectoryPreset: 'canyon_push', // 'cinematic_arc' | 'orbit_360' | 'canyon_push'
  clayPreset: 'studio-grey',       // '#dcd6cd', roughness 0.82, metalness 0.02
  outputVideoPath: 'public/videos/google_tiles_clay_blockout_camera.mp4',
  firstFramePngPath: 'public/images/blockout_frame_00.png',
  outputGlbPath: 'public/models/google_tiles_clay_area.glb'
});

// Outputs:
// - blockoutResult.videoRef: Strictly '<VIDEO_REF_0>'
// - blockoutResult.startFramePngPath: Frame 0 PNG precursor for AI Beautify -> <IMAGE_REF_0>
// - blockoutResult.clayGlbPath: Real-world geodetic massing mesh (.glb)
```

### Agent Tool: `google_3d_tiles_clay_blockout_runner`
```json
{
  "name": "google_3d_tiles_clay_blockout_runner",
  "description": "Execute the canonical Google Maps 3D Tile Clay Blockout Runner. Headlessly streams real-world 3D tiles in studio grey clay PBR, runs collision-avoided 6-DoF camera flight (cinematic_arc, orbit_360, or canyon_push), and exports <VIDEO_REF_0> (MP4/WebM), startFramePngPath (Frame 0 PNG for AI Beautify -> <IMAGE_REF_0>), and volumetric .glb mesh.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "query": { "type": "STRING", "description": "Geographic coordinate string or address" },
      "trajectoryPreset": { "type": "STRING", "description": "'cinematic_arc' | 'orbit_360' | 'canyon_push'" },
      "clayPreset": { "type": "STRING", "description": "'studio-grey' | 'warm-clay' | 'alabaster'" },
      "outputVideoPath": { "type": "STRING", "description": "Destination path for <VIDEO_REF_0> MP4" },
      "outputGlbPath": { "type": "STRING", "description": "Destination path for .glb massing" },
      "firstFramePngPath": { "type": "STRING", "description": "Destination path for Frame 0 PNG" }
    },
    "required": ["query"]
  }
}
```

