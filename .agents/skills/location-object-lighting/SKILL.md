---
name: location-object-lighting
description: >-
  Harmonize real-world 3D location objects and Google Photorealistic 3D Tiles with photograph lighting,
  stone albedo calibration (travertine, limestone, etc.), GLSL de-lighting shaders (shadow lift, highlight compression),
  dusk twilight atmosphere, and architectural window portal backlighting.
---

# Location 3D Object De-Lighting, Atmosphere & Architectural Illumination

The **Location 3D Object Lighting Skill** equips AI agents to resolve baked photogrammetry artifacts (crushed black shadows and overexposed daytime highlights), color calibrate real-world stone materials, and harmonize 3D location meshes with authentic photographic atmospheric conditions and interior backlighting.

---

## 1. System Architecture

```
[Target Photograph & Resected 3D Location Mesh]
                     │
                     ▼
       [Material & Stone Identification]
 (Travertine, Limestone, Sandstone, Granite, etc.)
                     │
                     ▼
  [GLSL Photogrammetric De-Lighting Shader]
   - Non-linear shadow lifting (uShadowLift: 0.60)
   - Highlight compression (uHighlightCompress: 0.45)
   - Stone albedo color tint (uStoneAlbedoTint)
   - Sky catch-light irradiance (uTwilightSkyTint)
   - Ground bounce irradiance (uGroundBounceTint)
   - Plaza ground de-washing (uGroundDeWash: 0.42)
                     │
                     ▼
     [Atmospheric Lighting Environment]
   - Ambient twilight light (#3a7ea5)
   - Hemisphere sky/ground light (#56b5e6 / #383025)
   - Low western dusk horizon fill (#b8dcfa)
   - Multi-stop sky gradient background canvas
                     │
                     ▼
     [Architectural Portal Backlighting]
   - 12 Interior window fixtures (2,850K amber)
   - Physical transmission through window openings
   - Zero exterior facade washout
```

---

## 2. Stone Albedo Colorimetry Standards

| Stone Type | RGB Vector | Hex Reference | Common Real-World Landmarks |
| :--- | :--- | :--- | :--- |
| **Travertine** | `[0.86, 0.82, 0.78]` | `#dcd1c7` | Roman Colosseum, Trevi Fountain, Getty Center |
| **Limestone** | `[0.88, 0.85, 0.76]` | `#e0d9c2` | Pyramids of Giza, Notre-Dame, Empire State Building |
| **Sandstone** | `[0.85, 0.68, 0.52]` | `#d9ad85` | Petra, Red Rocks, Sydney Sandstone |
| **Granite** | `[0.72, 0.73, 0.74]` | `#b8babb` | El Capitan, Mount Rushmore, modern plazas |
| **Terracotta** | `[0.80, 0.52, 0.42]` | `#cc856b` | Florence Duomo, Roman tiles, brick monuments |
| **Marble** | `[0.92, 0.92, 0.93]` | `#ebebee` | Taj Mahal, Lincoln Memorial, Parthenon |
| **Concrete** | `[0.70, 0.70, 0.68]` | `#b3b3ad` | Sydney Opera House podium, Brutalist structures |

---

## 3. Codebase APIs

Importable directly from `@scratchbox/core`, `@scratchbox/core/browser`, or `@scratchbox/core/node`:

```typescript
import { LocationObjectLightingService, harmonizeLocationObjectAtmosphere } from '@scratchbox/core';

// 1. Calculate lighting & de-lighting parameters
const harmonization = harmonizeLocationObjectAtmosphere({
  landmarkName: 'Colosseum, Rome',
  preset: 'civil_twilight_dusk',
  stoneType: 'travertine',
  enableArchitecturalBacklighting: true,
});

// 2. Apply directly to Three.js materials and scene
mesh.traverse((child) => {
  if ((child as any).isMesh) {
    LocationObjectLightingService.applyPhotogrammetricDelightShader(
      (child as any).material,
      harmonization.delightUniforms
    );
  }
});

LocationObjectLightingService.applyLocationAtmosphereLighting(
  scene,
  harmonization.sceneLighting
);

LocationObjectLightingService.applyArchitecturalPortalLights(
  scene,
  harmonization.architecturalFixtures
);
```

---

## 4. In-App Agent Tools (Gemini Function Calling)

### `geobox_harmonize_location_lighting`
```json
{
  "name": "geobox_harmonize_location_lighting",
  "description": "Harmonize 3D photogrammetric location tiles with photograph lighting, stone albedo calibration, GLSL de-lighting shaders (shadow lift, highlight compression), dusk atmosphere, and interior window fixtures.",
  "parameters": {
    "type": "OBJECT",
    "properties": {
      "landmarkName": { "type": "STRING", "description": "Landmark or scene name" },
      "preset": { "type": "STRING", "enum": ["civil_twilight_dusk", "golden_hour", "midday_clear", "blue_hour", "night_monumental"] },
      "stoneType": { "type": "STRING", "enum": ["travertine", "limestone", "sandstone", "granite", "terracotta", "marble", "concrete"] },
      "shadowLift": { "type": "NUMBER", "description": "Shadow lift factor (default: 0.60)" },
      "highlightCompress": { "type": "NUMBER", "description": "Highlight compression factor (default: 0.45)" },
      "enableArchitecturalBacklighting": { "type": "BOOLEAN", "description": "Enable 12-portal window backlighting" }
    }
  }
}
```

### `atmosphere_harmonize_location_3d`
High-level atmospheric alias exposed under the `nature_atmosphere` toolset.
