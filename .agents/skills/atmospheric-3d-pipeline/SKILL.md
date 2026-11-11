---
name: atmospheric-3d-pipeline
description: >-
  Configure, orchestrate, and simulate photorealistic 3D atmospheric scattering, diurnal solar curves, NOAA ephemeris,
  volumetric clouds, cloud shadows, crepuscular god rays, Beer-Lambert aerial perspective, participating media raymarching,
  and 9-coefficient spherical harmonics in Scratchbox 3D Engine.
---

# 3D Atmospheric & Radiometric Environment Pipeline

The **3D Atmospheric & Radiometric Environment Skill** equips AI agents to construct, calibrate, and render physically-grounded atmospheric lighting, skies, clouds, and participating media within Scratchbox 3D scenes.

> [!IMPORTANT]
> **Zero Uninvited Defaults Invariant (Opt-In Only)**:
> In practice, uninvited atmospheric defaults pollute user intent. When building an outpost, hero vehicle, or mechanical asset, unexpected clouds or sunset lighting fight against the composition.
> - **Neutral Studio Baseline**: Unconfigured scenes default strictly to a clean, neutral studio environment (`skybox: 'studio'`, `lighting: 'studio'`).
> - **Explicit Opt-In Gate**: Atmospheric sky domes, Rayleigh/Mie scattering, diurnal solar curves, depth fog, and volumetric clouds are ONLY instantiated when the prompt or schema contract explicitly opts into them (`/sky|atmosphere|clouds?|sunset|dusk|dawn|weather/i`) or when following up after staging approval.

---

## 1. System Architecture

```
[Geodetic Anchor (Lat/Lng) & Time (ISO 8601)]
                     │
                     ▼
       [NOAA Solar Ephemeris Engine]
          - Sub-arcminute Elevation & Azimuth
          - Earth-Sun distance (AU) & Julian Day
                     │
                     ▼
       [Diurnal Lighting & Radiometry]
          - 10 Diurnal Phases (Golden Hour, Blue Hour, etc.)
          - Planckian Blackbody Color Temperature (1,000K - 40,000K)
          - Linear sRGB Spectrum & Atmospheric Turbidity
                     │
    ┌────────────────┼────────────────┬────────────────┐
    ▼                ▼                ▼                ▼
[Physical Sky]  [Volumetric]    [Crepuscular]    [Beer-Lambert]
Rayleigh & Mie  Worley Clouds & God Rays         Aerial
Scattering Dome Ground Shadows  Light Shafts     Perspective Post
    └────────────────┼────────────────┴────────────────┘
                     │
                     ▼
     [Unified AtmosphereService Facade]
     - Coordinates attach(), update(), render(), dispose()
     - Participates in WebGL / Three.js Pipeline
                     │
                     ▼
      [Direct Dispatch Operators & Agent Tools]
      - nature_atmosphere operators
      - atmosphere_* Gemini function-calling tools
```

---

## 2. The 10 Core Capabilities & Physics

| Capability | Module / API | Physical Principle / Formula |
| :--- | :--- | :--- |
| **1. Physical Scattering** | `SkyDomeModule` | Rayleigh scattering $\beta_R(\lambda) \propto \lambda^{-4}$, aerosol Mie forward scattering, atmospheric optical depth. |
| **2. Volumetric Clouds** | `SkyDomeModule.setCloudUniforms` | Two-octave 3D Worley noise raymarching with wind advection vector, density threshold, and absorption. |
| **3. Aerial Perspective** | `AerialPerspectiveEffect` | Beer-Lambert multi-spectral extinction $T(s) = \exp(-\beta_{\text{ext}} \cdot s)$, altitude density stratification, inscattering airlight. |
| **4. Terrain Cloud Shadows** | `TerrainCloudShadows` | Analytical ground projection along sun vector $\mathbf{L}$, animated noise UV coordinates, ground mesh decal attenuation. |
| **5. Volumetric God Rays** | `VolumetricGodRays` | Radial screen-space crepuscular light shafts with decay, density, and exposure controls. |
| **6. Diurnal Solar Curves** | `diurnal-lighting.ts` | 10 Diurnal phases (`Deep Night`, `Blue Hour`, `Golden Hour`, `Midday`, etc.), photometric sun intensity, and ambient bounce. |
| **7. NOAA Ephemeris** | `solar-position.ts` | High-precision solar coordinates, hour angle, equation of time, solar declination, and ENU sun vector $\mathbf{v}_{\text{sun}}$. |
| **8. Planckian Radiometry** | `kelvin.ts` | Blackbody radiation curve conversion to linear CIE XYZ and sRGB chromaticity (1,000K to 40,000K). |
| **9. Participating Media** | `volumetric-participating-media.ts` | Riemann numerical quadrature raymarching, height falloff $e^{-h/H}$, Henyey-Greenstein, Rayleigh, and dual-lobe phase functions. |
| **10. Spherical Harmonics** | `SphericalHarmonics9` | Order-3 Ramamoorthi polynomial ambient diffuse irradiance evaluation from low-frequency environment lighting. |

---

## 3. Direct Dispatch Operator Engine (`nature_atmosphere`)

When modifying scene artifacts programmatically, use the `DirectDispatchOperatorEngine` with these registered operators:

### 1. `sb_configure_atmospheric_scattering`
Configures physical Rayleigh, Mie scattering, turbidity, and volumetric clouds.
```typescript
engine.executeOperator('sb_configure_atmospheric_scattering', {
    rayleigh: 2.8,
    mie: 0.005,
    turbidity: 2.2,
    cloudCoverage: 0.5,
    cloudDensity: 1.2,
    volumetricClouds: true
});
```

### 2. `sb_set_diurnal_time_of_day`
Sets the diurnal lighting using standardized presets or high-precision NOAA geodetic coordinates.
```typescript
// Via preset
engine.executeOperator('sb_set_diurnal_time_of_day', {
    preset: 'golden_hour'
});

// Or via geodetic coordinates and timestamp
engine.executeOperator('sb_set_diurnal_time_of_day', {
    latitude: 37.7749,
    longitude: -122.4194,
    isoDate: '2026-06-21T19:45:00Z'
});
```

### 3. `sb_configure_aerial_perspective`
Enables and configures the full-screen Beer-Lambert aerial perspective pass.
```typescript
engine.executeOperator('sb_configure_aerial_perspective', {
    enabled: true,
    inscatteringIntensity: 0.85,
    hazeVisibilityMeters: 2500,  // a grey haze of this visibility at ground level (Koschmieder: extinction 3.912 / V)
    fogHeight: 55,               // the haze thins with height: e-fold height in metres above fogBaseAltitude
    fogBaseAltitude: 0
});
```
With `fogHeight` set, a sight line's optical depth is the ground-level extinction times its length times its mean density
(`common/spatial/height-haze.ts`, the same expression in the shader): a camera above the layer sees the street fade while
rooftops and the upper skyline stay clear.

### 4. `sb_configure_terrain_cloud_shadows`
Configures dynamic cloud shadows projected across terrain and ground geometry.
```typescript
engine.executeOperator('sb_configure_terrain_cloud_shadows', {
    enabled: true,
    shadowIntensity: 0.4,
    cloudScale: 0.0003,
    windSpeed: 0.02
});
```

### 5. `sb_add_volumetric_god_rays`
Injects crepuscular god rays into the scene.
```typescript
engine.executeOperator('sb_add_volumetric_god_rays', {
    enabled: true,
    density: 0.8,
    decay: 0.95,
    weight: 0.4,
    exposure: 0.6
});
```

---

## 4. In-App Gemini Agent Tools

Agents can invoke these tools directly via function calling:

### 1. `atmosphere_calculate_solar_position`
Calculates high-precision NOAA solar elevation, azimuth, distance in AU, and diurnal phase for any latitude, longitude, and date.
```json
{
  "name": "atmosphere_calculate_solar_position",
  "args": {
    "latitude": 34.0522,
    "longitude": -118.2437,
    "isoDate": "2026-07-04T18:00:00Z"
  }
}
```

### 2. `atmosphere_get_diurnal_profile`
Calculates photometric sun intensity, ambient bounce, kelvin temperature, and linear RGB lighting vectors for a given sun elevation angle.
```json
{
  "name": "atmosphere_get_diurnal_profile",
  "args": {
    "elevationDeg": 6.5,
    "turbidity": 2.2
  }
}
```

### 3. `atmosphere_configure_scene`
Lights the open 3D scene with a real sun and its sky, and adds clouds, god rays and haze when asked. Read its declaration
for every parameter; a backlit street at golden hour with haze that hugs the ground looks like this:
```json
{
  "name": "atmosphere_configure_scene",
  "args": {
    "sunElevationDeg": 33,
    "sunAzimuthDeg": 325,
    "visibilityMeters": 2500,
    "hazeScaleHeightMeters": 55
  }
}
```
- **Sun azimuth:** degrees clockwise from north, and in the scene north is -z, east +x (0 toward -z, 90 toward +x), the
  same convention `path_trace_render` takes. For a scene built for a shot, `hero.sun_azimuth_deg(frame_x)` gives it from
  the frame (-1.5 ahead and to the left).
- **Haze:** `visibilityMeters` (a clear day tens of kilometres, a hazy city 2000-5000, mist a few hundred) and
  `hazeScaleHeightMeters` (30-80 for street haze under clear upper air) only when the request asks for air, haze or mist.
- **Where it shows:** the live viewport draws the haze; `path_trace_render` draws sun and sky but no haze. Say so when a
  still is delivered for a hazy brief.

---

## 5. Unified Facade API (`AtmosphereService`)

For procedural C++20 or TypeScript 3D scene implementations:

```typescript
import { AtmosphereService } from '@scratchbox/core/browser';
import * as THREE from 'three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 10000);

// Initialize atmosphere orchestrator
const atmosphere = new AtmosphereService({
    rayleigh: 2.5,
    mie: 0.005,
    turbidity: 2.2,
    cloudCoverage: 0.4,
    volumetricClouds: true,
    godRaysEnabled: true
});

// Attach to Three.js scene
atmosphere.attach({
    scene,
    camera,
    enableGodRays: true,
    enableCloudShadows: true
});

// Synchronize with NOAA solar position
atmosphere.setGeoCoordinates(40.7128, -74.0060, new Date());

// In animation frame
function onFrame(delta: number, renderer: THREE.WebGLRenderer) {
    atmosphere.update(delta);
    atmosphere.render(renderer, camera);
}
```
