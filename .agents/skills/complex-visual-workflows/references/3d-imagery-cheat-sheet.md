# 3D Imagery & Surface Synthesis Reference Cheat Sheet

This reference document provides the canonical runbooks, mathematical formulations, and API contracts for AI Beautify, multi-angle turnaround orbits, PBR textures, Gaussian splatting, and algorithmic UV synthesis.

---

## 1. AI Beautify Location Pipeline

Transforms photogrammetric 3D tile views into photorealistic photographs using the exact `buildBeautifyPrompt` API:

### Core Prompt Structure
```typescript
import { buildBeautifyPrompt } from '@scratchbox/core';

const prompt = buildBeautifyPrompt({
  locationName: "Empire State Building",
  coordinates: { lat: 40.748441, lng: -73.985664 },
  cameraAltitudeMeters: 380,
  cameraDistanceMeters: 450,
  solarElevationDeg: 18.5,
  solarAzimuthDeg: 245.0,
  season: "autumn",
  atmosphericCondition: "crisp golden hour with slight haze"
});
```

### Non-Negotiable Rules
1. **Aspect Ratio Enforcement**: Match the canvas viewport aspect ratio exactly (16:9 widescreen or 4:3 aerial).
2. **Geodetic Precision**: Always embed 6-decimal geodetic coordinates for ground truth.
3. **Google Earth Vantage References**: State camera elevation and pitch angle relative to the horizon.
4. **Distance-Based Depth of Field**: Use realistic f-stop ($f/5.6 - f/8.0$) for telephoto architectural shots to prevent tilt-shift miniature illusions.

---

## 2. Multi-Angle Turnaround Capture Orbits

Directs continuous spherical camera orbits for 3D reconstruction and turnaround showcases using `MultiAngleTurnaroundService` / `generate_multi_angle_turnaround`:

### Continuous Spherical Coordinates
$$\mathbf{P}(\theta, \phi) = \mathbf{T}_{\text{target}} + r \begin{bmatrix} \cos\phi \sin\theta \\ \sin\phi \\ \cos\phi \cos\theta \end{bmatrix}$$
- $\theta$: Azimuth angle $[0^\circ, 360^\circ)$
- $\phi$: Elevation angle $[-15^\circ, +45^\circ]$
- $r$: Standoff distance ($1.8 \times \text{AABB}_{\text{diagonal}}$)

### Dual-Anchor Identity Conditioning Graph
```
        [Frame 0: Front Hero Anchor] (Establishes identity & proportions)
           │                        │
           ▼                        ▼
  [Frame 1: Front-Right 45°]   [Frame 7: Front-Left 315°]
           │                        │
           ▼                        ▼
  [Frame 2: Right Profile 90°] [Frame 6: Left Profile 270°]
           │                        │
           └──────────► [Frame 4: Rear 180°] ◄────────┘
```
- Condition each new view on **Frame 0 (Hero Anchor)** for structural scale AND the **immediate preceding frame** for local texture continuity.
- Non-negotiable isolation: zero ground plane, zero cast shadows, pure neutral void to prevent geometry fusion during downstream 3D reconstruction.

---

## 3. Gaussian Radiance Fields & Forward Splats

### 2DGS Planar Surfels (`SURFACE_2DGS_PLANAR_SURFEL`)
- Eliminates floating splatter artifacts by squashing Gaussian ellipsoids to near-zero thickness along the surface normal:
  $$\mathbf{S} = \operatorname{diag}(s_u, s_v, \epsilon) \quad \text{where } \epsilon \le 10^{-4}$$
- Yields razor-sharp architectural edges and clean silhouette cutouts.

### Analytical Forward Grooming (`scratchbox_hair.hpp`, `scratchbox_spz.hpp`)
- **Prohibition on Circular Inverse Photogrammetry**: Never take procedural hair $\rightarrow$ render images $\rightarrow$ train inverse 3DGS.
- **Direct Forward Splatting**:
  1. Generate guide curves via spherical harmonics or mesh geodesic curves.
  2. Synthesize Voronoi clumping, curl noise, and Marschner melanin albedo.
  3. Splat each segment as an oriented 3D Gaussian ellipsoid:
     - Center $\mathbf{x} = \frac{\mathbf{p}_1 + \mathbf{p}_2}{2}$
     - Orientation $\mathbf{q} = \operatorname{Rot}(\mathbf{e}_z \to \mathbf{t})$
     - Scale $\mathbf{s} = (w, w, L/2)$
  4. Stream directly to Niantic SPZ v2 (`.spz`) in under 100 milliseconds.

---

## 4. Algorithmic UV Rewrap & Micro-Texture Synthesis

Computes inverse barycentric weights and affine determinants for **100% geometric spatial lock (0.000 px drift)** using `AlgorithmicUVRewrapService`:

- **Sobel Photographic Joint Deepening**: Detects mortar joints in photogrammetric tiles and deepens ambient occlusion and normal grooves.
- **Analytical Travertine & Cavitation Pores**: Multi-octave Worley cellular noise synthesizing microporous stone voids.
- **Calcite Mineral Grain & Bedding Strata**: Anisotropic Perlin noise along geological bedding planes.
- **Bitumen Road Surfacing**: Cleans photogrammetric road noise, replaces with asphalt roughness and crisp lane line markings.
- **Chlorophyll Leaf Canopy Dappling**: Thin-wall subsurface scattering and transmission masks.
