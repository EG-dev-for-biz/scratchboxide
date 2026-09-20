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
3. **Geocoding Requirement**:
   - Provide explicit coordinates: `"40.748400, -73.985700"` or `{ lat: 40.7484, lng: -73.9857 }`.
   - OR provide an address with an active `GOOGLE_MAPS_API_KEY` configured in the environment.
   - If neither is provided, the API throws an explicit, actionable `Error`.

---

## 4. Ingestion Quality Standards

All 3D tile captures adhere to strict photogrammetric standards:
- **Leaf LOD Geometric Error**: `errorTarget <= 0.5` (guarantees leaf octree geometry rather than coarse city blocks).
- **4K SSE Budget**: Screen-Space Error calculated against a $3840 \times 2160$ virtual viewport.
- **Asynchronous Settle**: Execution waits until `stats.downloading === 0 && stats.parsing === 0`.
- **Multi-Waypoint Pre-Warming**: Pre-warms camera waypoints `[0, 18, 36, 54, 71]` to load the entire flight corridor before collision detection or export.

---

## 5. In-App Agent Tools (Gemini Function Calling)

The in-app Scratchbox agent has direct access to two registered function declarations:

### `google_3d_tiles_get_full_texture`
```json
{
  "name": "google_3d_tiles_get_full_texture",
  "description": "Ingest real-world geographic coordinates or address as a photorealistic, full-texture 3D GLB object rendered from Google Maps Photorealistic 3D Tiles at highest leaf LOD quality.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "query": { "type": "STRING", "description": "Geographic coordinates or address" },
      "outputGlbPath": { "type": "STRING", "description": "Optional destination path for .glb file" },
      "mockExecution": { "type": "BOOLEAN", "description": "Optional offline mock mode" }
    },
    "required": ["query"]
  }
}
```

### `google_3d_tiles_get_clay`
```json
{
  "name": "google_3d_tiles_get_clay",
  "description": "Ingest real-world geographic coordinates or address as a studio grey clay 3D GLB object rendered from Google Maps Photorealistic 3D Tiles at highest leaf LOD quality.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "query": { "type": "STRING", "description": "Geographic coordinates or address" },
      "outputGlbPath": { "type": "STRING", "description": "Optional destination path for .glb file" },
      "mockExecution": { "type": "BOOLEAN", "description": "Optional offline mock mode" }
    },
    "required": ["query"]
  }
}
```

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
  'Midtown Manhattan, coordinates: 40.748400, -73.985700',
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
