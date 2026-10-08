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

## 2. Continuous Stone Albedo & Radiometric Colorimetry

In compliance with **Adaptive Domain Architecture (ADA)**, surface materials are defined by continuous diffuse albedo vectors $\boldsymbol{\rho} \in [0, 1]^3$ rather than closed classifiers. Diagnostic labels use open literals (`type StoneHint = 'travertine' | 'limestone' | 'sandstone' | (string & {})`):

| Diagnostic Reference Hint | Measured Diffuse Albedo $\boldsymbol{\rho}$ | Hex Reference | Common Real-World Lithic Formations |
| :--- | :--- | :--- | :--- |
| **Travertine** | `[0.86, 0.82, 0.78]` | `#dcd1c7` | Roman Colosseum, Trevi Fountain, Getty Center |
| **Limestone** | `[0.88, 0.85, 0.76]` | `#e0d9c2` | Pyramids of Giza, Notre-Dame, Empire State Building |
| **Sandstone** | `[0.85, 0.68, 0.52]` | `#d9ad85` | Petra, Red Rocks, Sydney Sandstone |
| **Granite** | `[0.72, 0.73, 0.74]` | `#b8babb` | El Capitan, Mount Rushmore, modern structural plazas |
| **Terracotta** | `[0.80, 0.52, 0.42]` | `#cc856b` | Florence Duomo, Roman tiles, brick monuments |
| **Marble** | `[0.92, 0.92, 0.93]` | `#ebebee` | Taj Mahal, Lincoln Memorial, Parthenon |
| **Concrete / Caisson** | `[0.70, 0.70, 0.68]` | `#b3b3ad` | Brutalist monuments, highway caissons, retaining walls |
| *(Continuous Custom)* | $[\rho_R, \rho_G, \rho_B] \in [0, 1]^3$ | Custom Hex | Continuous physical reflectance spectrum |

---

## 3. Native & Server-Side APIs

De-lighting and photometric harmonization are executed via native C++20 (`scratchbox_delight.hpp`) and TypeScript services in `@scratchbox/core` and `@scratchbox/core/node`:

```typescript
import { 
  matchImageAndLightingToLocation, 
  LocationObjectLightingService 
} from '@scratchbox/core/node';

// 1. Solve photometric lighting and 6-DOF camera pose against matched location
const matchedRig = await matchImageAndLightingToLocation({
  imagePath: 'uploads/colosseum_dusk.jpg',
  locationName: 'Colosseum, Rome',
  stoneType: 'travertine',
  autoAlignCamera: true,
  autoExportUsd: true
});

// 2. High-performance native de-lighting uniform resolution
const delightParams = LocationObjectLightingService.calculateDelightUniforms({
  shadowLift: 0.60,
  highlightCompress: 0.45,
  albedoTint: [0.86, 0.82, 0.78]
});
```

---

## 4. First-Class Gemini Agent Tools

Agents should invoke the dedicated lighting tools in `lighting-tools.ts`:

### 1. `lighting_match_image_to_location`
Matches physical scene lighting (sun angle, Kelvin temperature, sky ambient) and 6-DOF camera pose from a reference photograph after 3D location extraction.
```json
{
  "name": "lighting_match_image_to_location",
  "args": {
    "imagePath": "uploads/target_plate.jpg",
    "locationName": "Empire State Building, NYC",
    "stoneType": "limestone",
    "autoAlignCamera": true,
    "autoExportUsd": true
  }
}
```

### 2. `lighting_estimate_from_photo`
Performs inverse photometric decomposition to extract primary light direction vector, shadow softness, Kelvin temperature, and order-3 (9×3) Spherical Harmonics ambient irradiance.
```json
{
  "name": "lighting_estimate_from_photo",
  "args": {
    "imagePath": "uploads/plate_sunset.png",
    "hfovDeg": 60,
    "vfovDeg": 45
  }
}
```

### 3. `atmosphere_harmonize_location_3d`
Harmonizes atmospheric scattering and diurnal solar ephemeris with the real-world geodetic position.
