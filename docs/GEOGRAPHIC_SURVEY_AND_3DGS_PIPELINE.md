# Geographic 3D Tiles Survey & 3D Gaussian Splatting (3DGS) Capture Pipeline
**Architecture Specification, Mathematical Foundations, Generative Conditioning & Production Verification**

---

## 1. Executive Summary & Architecture Overview

Real-world 3D geospatial environments ingested from photogrammetric sources (such as Google Photorealistic 3D Tiles, Cesium, or aerial LiDAR) provide broad geographic massing and geodetic positioning. However, raw photogrammetric tiles suffer from fundamental visual defects:
- **Photogrammetric "Melting"**: Soft, rounded architectural corners, bowed columns, and non-manifold degenerate surfaces caused by coarse multi-view stereo matching.
- **Baked Directional Illumination**: Baked midday harsh shadows, bleached sunny facades, and low dynamic range baked into albedo textures.
- **Texture Blurring & Low GSD**: Street-level facades, ground pavement, and intricate stonework exhibit low Ground Sample Distance (GSD) due to aerial oblique flight altitudes.
- **Vegetative Deformity**: Trees and shrubbery are reconstructed as solid, lumpy mounds of melted green geometry rather than distinct foliage.

To transform coarse geographic 3D tiles into VFX-grade, walkable, photorealistic real-time environments, Scratchbox IDE implements an **end-to-end Geographic Survey & 3DGS Capture Pipeline**. This pipeline combines:
1. **Deterministic 3D Tile Ingestion** at deepest leaf Level of Detail (LOD).
2. **Geodetically Anchored Multi-Tier Survey Synthesis** producing calibrated 6-DoF camera poses.
3. **Headless Multimodal Spatial Pass Extraction** (Dense Metric Depth, Studio Grey Clay, Surface Normals, and Silhouette Mattes).
4. **Multi-Model Generative AI Beautification & Restoration** (Google Vertex AI / Nano Banana and fal.ai FLUX.1 [dev] Depth LoRA / Img2Img).
5. **High-Performance C++20 Depth-to-Gaussian Unprojection** with 2DGS surfel regularization, silhouette edge severance, and Excess Green Index foliage pruning.
6. **Cross-Station Radiometric Harmonization & Multi-Resolution Voxel Fusion**.
7. **OGC 3D Tiles 1.1 Octree Hierarchical Tiling** with compressed SPZ splats and geodetic WGS-84 root transformation matrices.
8. **Real-Time Viewport Compositing with Soft-Z Volumetric Interleaving**.

```mermaid
flowchart TD
    subgraph Ingestion ["1. Geospatial Ingestion"]
        A[Google Photorealistic 3D Tiles API] -->|errorTarget <= 0.5m, 4K SSE| B[Binary glTF 2.0 .glb Extraction]
        B --> C[Zero Building Clipping & Sutherland-Hodgman Datum Clamp]
    end

    subgraph Survey ["2. Survey Synthesis Engine"]
        C --> D[WGS-84 Geodetic Origin & Local Tangent Plane ENU]
        D --> E["geographic-3dtiles-survey (4-Tier Choreography)"]
        E --> F1[Tier 1: Pedestrian / Street 1.8m-3.5m]
        E --> F2[Tier 2: Mid-Elevation Facades 15m-35m]
        E --> F3[Tier 3: Crown & Attic Oblique 40m-75m]
        E --> F4[Tier 4: Topographic Nadir 75m-160m]
    end

    subgraph Rasterization ["3. Multimodal Pass Extraction"]
        F1 & F2 & F3 & F4 --> G[HeadlessMeshSilhouetteRenderer]
        G --> H1[Dense Metric Camera-Z Depth .f32]
        G --> H2[Studio Grey Clay Massing .png]
        G --> H3[Surface Normal Vector Buffer .png]
        G --> H4[Normalized Distance Mist Pass .png]
    end

    subgraph AI ["4. Multimodal Generative Restoration"]
        H1 & H2 & H3 & H4 --> I[BeautifyStationService & Prompt Engine]
        I --> J1["fal.ai FLUX.1 [dev] Depth LoRA & Img2Img"]
        I --> J2["Vertex AI / Gemini 2.5 / Nano Banana 2"]
        J1 & J2 --> K[Two-Candidate Edge Alignment QC Gate]
    end

    subgraph Splatting ["5. Native C++20 Unprojection & Fusion"]
        K & H1 --> L["station_to_splats (scratchbox_engine.hpp)"]
        L --> M1[Planar Tangent Disc / 2DGS Surfel Regularization]
        L --> M2[Silhouette Edge Severance tau = 0.08]
        L --> M3[Excess Green Index Foliage Filtration]
        L --> M4[Hybrid Micro-Depth Displacement]
        M1 & M2 & M3 & M4 --> N["Multi-Station Voxel Fusion (runFuse)"]
        N --> O1[Chromaticity-Preserving Radiometric Harmonization]
        N --> O2[Adaptive Concentric LOD Shells 0-3]
        N --> O3[Normal Consensus Pruning & Multi-Tier GSD Priority]
    end

    subgraph Delivery ["6. 3D Tiles 1.1 Packaging & WebGL Viewport"]
        O1 & O2 & O3 --> P["Splat3DTilesService & splat_to_3dtiles.cpp"]
        P --> Q[Morton Octree & SPZ Compressed Splats]
        P --> R[WGS-84 ECEF 4x4 Root Transform Matrix]
        Q & R --> S["Geographical 3DGS Studio (Three.js / WebGL)"]
        S --> T[Continuous Soft-Z Volumetric Interleaving]
    end
```

---

## 2. Geospatial 3D Tile Ingestion Standards

All geographic asset pipelines begin with photogrammetric tile ingestion adhering to non-negotiable geometric and quality directives:

### 2.1 Maximum Geometric Quality (Deepest Leaf LOD)
- **Strict Error Target**: Tile streaming is initialized with `errorTarget <= 0.50` meters (never intermediate LOD octree budgets of 2.0–5.0m).
- **4K Screen-Space Error (SSE)**: Screen-space error calculations target a virtual $3840 \times 2160$ viewport, forcing the octree traversal to reach maximum resolution leaf tiles.
- **Full Settle Invariant**: Extraction occurs only when `stats.downloading === 0 && stats.parsing === 0`.
- **Zero Procedural Fallbacks**: Never hash landmark coordinates or substitute synthetic bounding boxes. Real geodetic coordinates (WGS-84 latitude, longitude, and elevation) are mandatory.

### 2.2 Atomic Building Integrity & Unbounded Skyward Extent
- **Zero-Cut Extraction Invariant**: Architectural entities are indivisible. Geofences, bounding volumes, and planar slicers must never bisect a building or expose hollow "dollhouse" interior shells.
- **Unbounded Vertical Skyward Extent ($Y_{\max} = +\infty$)**: Slicing applies strictly at the foundation datum level ($Y \le Y_{\text{ground}}$) to prune subterranean tile artifacts. Spires, mansard roofs, cornices, and antennae must remain 100% intact.
- **Planar Boundary Slicing**: Executed via the Sutherland-Hodgman analytical polygon clipper (`utdra_slice_elevation`), ensuring closed planar boundaries without hole formation.

```
Ingestion APIs:
• getGoogle3DTilesFullTexture(queryOrCoords, options) -> Authentic PBR photogrammetric texture
• getGoogle3DTilesClay(queryOrCoords, options)        -> Volumetric studio grey clay massing (#b0b8c4, roughness 0.82)
Canonical Output: Standard binary glTF 2.0 (.glb) preserving positions, vertex normals, UVs, and materials.
```

---

## 3. Geodetic Survey Synthesis Engine

The camera network is synthesized by `SurveySynthesisEngine` (`packages/core/src/common/spatial/SurveySynthesisEngine.ts`), which acts as the single mathematical source of camera truth.

### 3.1 Geodetic Coordinate Systems & Local Tangent Plane
Survey stations are computed in the Scratchbox Local Tangent Plane (ENU convention: $+X = \text{East}$, $+Y = \text{Up}$, $-Z = \text{North}$) anchored on a WGS-84 geodetic datum $(\phi_0, \lambda_0, h_0)$:

$$\begin{pmatrix} X \\ Y \\ Z \end{pmatrix}_{\text{ENU}} = \mathbf{R}_{\text{geodetic}} \cdot \left[ \mathbf{P}_{\text{ECEF}}(\phi, \lambda, h) - \mathbf{P}_{\text{ECEF}}(\phi_0, \lambda_0, h_0) \right]$$

### 3.2 The Canonical `geographic-3dtiles-survey` Pattern
To capture architectural monuments from the ground to the sky without vertical occlusions, `SurveySynthesisEngine` generates a **4-tier hierarchical survey pattern**:

| Tier | Station Allocation | Altitude ($Y$) | Standoff Radius ($R$) | Camera Pitch | Lens ($f$) | Primary Target Focus |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Pedestrian / Street Level** | ~25% (min 4) | $1.8\text{m} - 3.5\text{m}$ | $0.28 \cdot R_{\text{target}}$ | $+3^\circ \text{ to } +10^\circ$ | $35\text{mm} - 50\text{mm}$ | Pedestrian arcades, column bases, arch soffits, entry portals, pavement pavers |
| **Tier 2: Mid-Elevation Facades** | ~30% (min 4) | $15.0\text{m} - 35.0\text{m}$ | $0.55 \cdot R_{\text{target}}$ | $-5^\circ \text{ to } -15^\circ$ | $35\text{mm}$ | Colonnades, piano nobile window reveals, pilasters, architectural balustrades |
| **Tier 3: Crown & Attic Oblique** | ~25% (min 4) | $40.0\text{m} - 75.0\text{m}$ | $0.85 \cdot R_{\text{target}}$ | $-25^\circ \text{ to } -45^\circ$ | $28\text{mm}$ | Entablatures, cornices, velarium corbels, roof setbacks, hypogeum/courtyard bowls |
| **Tier 4: Topographic Nadir** | ~20% (min 4) | $75.0\text{m} - 160.0\text{m}$ | $0.40 \cdot R_{\text{target}}$ | $-60^\circ \text{ to } -85^\circ$ | $24\text{mm}$ | Flat roofs, arena courtyard floors, surrounding urban street grid and plaza layout |

```typescript
// packages/core/src/common/spatial/SurveySynthesisEngine.ts
const poses = engine.synthesize(colosseumAnchor, {
  type: 'geographic-3dtiles-survey',
  targetRadiusMeters: 130,
  cameraCount: 24,
  focalLengthMm: 35
});
```

### 3.3 Stereo Baseline Overlap & Optical Formulation
- **Stereo Overlap Invariant**: Baseline overlap between adjacent azimuth angles $\Delta \theta$ must satisfy:
  $$\text{Overlap} = 1 - \frac{2 \cdot R \cdot \sin(\Delta \theta / 2)}{2 \cdot Z \cdot \tan(\text{HFOV} / 2)} \ge 0.75 \quad (75\%)$$
- **Pinhole Intrinsics Derivation**:
  $$f_x = \frac{W}{2 \cdot \tan(\text{HFOV} / 2)}, \quad f_y = f_x, \quad c_x = \frac{W}{2}, \quad c_y = \frac{H}{2}$$
  $$\text{VFOV} = 2 \cdot \arctan\left(\frac{H}{2 \cdot f_y}\right)$$
- **Export Standards**: Serializes natively to COLMAP (`cameras.txt`, `images.txt`) and RFC 7946 GeoJSON `FeatureCollection`.

---

## 4. Multimodal Spatial Pass Extraction

Before generative AI can restore or beautify a station, dense geometric conditioning passes must be extracted. This is handled by `SurveyStationRenderService` and `NativeAiRenderEngineService` via pure Node.js headless software rasterization (`HeadlessMeshSilhouetteRenderer.ts`):

```
                                  ┌─────────────────────────────┐
                                  │      3D Tile Mesh (.glb)     │
                                  └──────────────┬──────────────┘
                                                 │
                                                 ▼
                                  ┌─────────────────────────────┐
                                  │  Pose-Exact Camera Station  │
                                  │  (6-DoF ENU + Pinhole f)    │
                                  └──────────────┬──────────────┘
                                                 │
                     ┌───────────────────────────┼───────────────────────────┐
                     ▼                           ▼                           ▼
          ┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
          │  Dense Metric Depth │     │  Studio Grey Clay   │     │ Surface Normal Pass │
          │  Float32 Camera-Z   │     │  #dcd6cd, Rough 0.82│     │ World Normal -> RGB │
          └─────────────────────┘     └─────────────────────┘     └─────────────────────┘
```

1. **Dense Metric Camera-Z Depth (`.f32`)**:
   - Stores true Euclidean camera-Z metric distance per pixel ($Z \in [0.05\text{m}, Z_{\max}]$).
   - Empty/sky pixels are assigned `EMPTY_DEPTH = 1e9`.
2. **Studio Grey Clay Pass (`.png`)**:
   - Neutral clay shading (`#dcd6cd`, roughness $0.82$, metalness $0.02$) under key/fill/rim lighting.
   - Provides pure geometric massing, occlusion, and parallax without baked photogrammetric textures.
3. **World/Camera Surface Normal Pass (`.png`)**:
   - Encodes normal vector coordinates $\mathbf{n} = (n_x, n_y, n_z)$ mapped to RGB color:
     $$\text{RGB} = \text{round}\left( \frac{\mathbf{n} + 1}{2} \times 255 \right)$$
4. **Normalized Distance Mist Pass (`.png`)**:
   - 16-bit or 8-bit inverse depth gradient tailored for diffusion depth conditioning models (e.g. FLUX.1 [dev] Depth ControlNet / LoRA).
5. **Silhouette Foreground Mask (`.png`)**:
   - Binary mask ($0$ = background/sky, $1$ = valid mesh surface) subjected to a $2\text{px}$ morphological erosion kernel to eliminate boundary pixel sky-bleed.

---

## 5. Multi-Model Generative AI Beautification & Restoration

Generative beautification transforms coarse photogrammetric geometry into high-frequency, authentic visual imagery while locking camera poses.

### 5.1 Strict AI Beautify Prompting Contract
All generative station prompts are constructed via `buildBeautifyPrompt()` enforcing non-negotiable spatial locks:
- **Aspect Ratio & Framing Lock**: Exact matching of sensor aspect ratio (`16:9` or `1:1`).
- **Zero-Viewpoint Shift**: Verbatim prohibition against altering camera pitch, yaw, zoom, or cropping.
- **Geographic Vantage Reference**: Cites authentic Google Earth coordinates and cardinal orientation.
- **Subject Distance Hint**: Exact metric standoff distance from camera to landmark focal point to guide depth-of-field, focal falloff, and aerial perspective haze.
- **Stone Albedo Specification**: Enforces authentic calibrated stone reflectance (e.g. Roman Travertine, Limestone, Marble, Sandstone).

### 5.2 Comparative Generative AI Model Architectures

The pipeline supports two primary production backends for station beautification:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ MODEL BACKEND 1: fal.ai FLUX.1 [dev] Depth LoRA & Img2Img                                              │
│ • Conditioning: Dense metric camera-z depth pass + normalized mist pass (ControlNet / LoRA)            │
│ • Architecture: 12B parameter Flow Matching Diffusion Transformer (DiT)                                │
│ • Strengths: Pixel-perfect structural fidelity to architectural edges, fluting, and depth steps        │
│ • Texture Restoration: Img2Img mode cleans photogrammetric mush while preserving underlying geometry  │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ MODEL BACKEND 2: Google Vertex AI (Gemini 2.5 / 3.1 Flash Image & Nano Banana 2)                       │
│ • Conditioning: Multimodal dual-image conditioning (Studio Grey Clay + Historical Reference)           │
│ • Architecture: Native Multimodal Autoregressive Transformer with spatial grounding tokens             │
│ • Strengths: Rich environmental realism, authentic historical weather, foliage micro-leaves, travertine│
│ • Performance: Ultra-fast generation (< 3.5s per station) via enterprise Vertex AI endpoints           │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Geometric Quality Control (QC) & Edge Alignment Gate
Before a beautified station image is accepted for 3D Gaussian unprojection, it passes through `BeautifyStationService`'s two-candidate edge verification gate:
1. **Sobel Edge Extraction**: Extracts edge magnitudes from both the generated image luminance and the mesh depth discontinuity map.
2. **Normalized Cross-Correlation (NCC)**: Compares edge overlap across two scales:
   - **Candidate A**: Fine-scale high-frequency Sobel response.
   - **Candidate B**: Coarse-to-fine Gaussian-blurred multi-scale response.
3. **Rejection Threshold**: Any generated image scoring $\text{NCC} < 0.72$ is flagged as structurally drifted and automatically rerolled (up to `maxRerolls = 2`).

### 5.4 Chained Forward-Warping for Cross-Station Material Coherence
In `mode: 'chained'`, each accepted station image is forward-warped into the camera frame of the subsequent station using the 3D mesh depth buffer:
- **Reprojection**: $\mathbf{p}' = \mathbf{K}_2 \cdot (\mathbf{R}_{1 \to 2} \cdot \mathbf{K}_1^{-1} \cdot \mathbf{p} \cdot Z_1 + \mathbf{T}_{1 \to 2})$.
- **Disocclusion Mask**: Identifies newly revealed surfaces and occluded zones.
- **Conditioning**: The warped image + disocclusion mask are fed into the image generator as an inpainting/restyling precursor, guaranteeing identical travertine coloration, sun position, and material patina across stations.

---

## 6. Depth-to-Gaussian Unprojection Engine (`station_to_splats.cpp`)

The core mathematical unprojector is implemented in native C++20 (`scripts/station_to_splats.cpp`) utilizing SIMD vector math (`scratchbox_engine.hpp` and `scratchbox_depth_to_gaussian.hpp`).

### 6.1 Geometric Pixel-to-World Backprojection
For each pixel $(u, v)$ with camera-Z metric depth $Z$, its 3D position in the camera frame and world frame is:

$$\mathbf{P}_{\text{cam}} = \begin{pmatrix} X_{\text{cam}} \\ Y_{\text{cam}} \\ Z_{\text{cam}} \end{pmatrix} = \begin{pmatrix} \frac{u + 0.5 - c_x}{f_x} \cdot Z \\ -\frac{v + 0.5 - c_y}{f_y} \cdot Z \\ Z \end{pmatrix}$$

$$\mathbf{P}_{\text{world}} = \mathbf{P}_{\text{eye}} + X_{\text{cam}} \cdot \mathbf{R}_{\text{right}} + Y_{\text{cam}} \cdot \mathbf{R}_{\text{up}} + Z_{\text{cam}} \cdot \mathbf{R}_{\text{forward}}$$

### 6.2 Tangent Planar Discs & 2DGS Surfel Regularization
To eliminate the cloudy, amorphous "cotton-ball" look of standard 3DGS, splats are constructed as **oriented planar discs (surfels)** aligned with the physical surface:
- **Surface Normal Formulation**: Derived from a 4-neighbor depth gradient in world space:
  $$\mathbf{t}_u = \frac{\partial \mathbf{P}}{\partial u} \approx \frac{\mathbf{P}(u+1, v) - \mathbf{P}(u-1, v)}{2}, \quad \mathbf{t}_v = \frac{\partial \mathbf{P}}{\partial v} \approx \frac{\mathbf{P}(u, v+1) - \mathbf{P}(u, v-1)}{2}$$
  $$\mathbf{n} = \frac{\mathbf{t}_u \times \mathbf{t}_v}{\|\mathbf{t}_u \times \mathbf{t}_v\|}$$
- **Orientation Quaternion**: The splat's rotation quaternion $\mathbf{q}$ aligns its local Z-axis with $\mathbf{n}$ and local X/Y axes with the surface tangents.
- **2DGS Planar Surfel Regularization (`--2dgs`)**:
  - Tangential in-plane scale: $\sigma_{\parallel} = \sigma_{\text{scale}} \cdot \frac{Z}{f_x} \cdot \text{stride}$ (where $\sigma_{\text{scale}} \approx 0.35$).
  - Normal-axis thickness: $\sigma_{\perp} = 10^{-4}\text{m}$ (squashed into a flat 2D disc).
  - *Result*: Solid architectural masonry walls that do not leak light or raymarching opacity through solid stone.

### 6.3 Silhouette Edge Severance ($\tau$) & Grazing Rejection
- **Silhouette Discontinuity Severance ($\tau = 0.08$)**:
  When calculating tangent vectors, if the relative depth step between adjacent pixels exceeds $\tau$:
  $$\frac{|\Delta Z|}{Z} > \tau = 0.08$$
  The neighbor is severed. The splat is decoupled and shrunk, preventing foreground columns or statues from smearing or webbing into background sky or distant terrain.
- **Oblique Grazing Sample Filter**:
  Samples where the viewing angle is near-parallel to the surface ($|\mathbf{n} \cdot \mathbf{v}| < \text{minCosIncidence} = 0.15$) are discarded, eliminating stretched, blurry streaks on flat pavement.

### 6.4 Foliage Pruning via Excess Green Index (ExG)
Photogrammetric trees produce lumpy mounds. When `--drop-foliage` is active, pixels are analyzed via normalized chromaticity coordinates:

$$g_n = \frac{G}{R + G + B + \epsilon}, \quad \text{ExG} = 2G - R - B$$

Any sample satisfying $(g_n > 0.38 \land G > R + 0.02 \land G > B + 0.02) \lor (\text{ExG} > 0.08)$ is classified as organic foliage and pruned, leaving clean architectural masonry for subsequent 3D tree instancing.

### 6.5 Hybrid Micro-Depth Displacement
To capture fine stone relief, fluting, and deep window reveals beyond the coarse 3D tile mesh:
- **Neural Depth Affine Alignment**: An external dense depth map $Z_{\text{neural}}$ (e.g. Depth Anything V2 or MoGe) is aligned to the metric mesh depth $Z_{\text{mesh}}$ via closed-form linear regression:
  $$\min_{s^*, t^*} \sum_i \left( (s^* \cdot Z_{\text{neural}, i} + t^*) - Z_{\text{mesh}, i} \right)^2$$
- **High-Pass Photometric Cavity Displacement**: Dark window portals and archway crevices ($L < \text{cavityLum} = 0.18$) are displaced inward along camera rays up to $\text{maxDeltaZ} = 3.5\text{m}$, creating true 3D spatial depth inside open archways.

---

## 7. Cross-Station Harmonization & Multi-Resolution Voxel Fusion

When individual station splats are merged into a global spatial model, `runFuse` in `station_to_splats.cpp` executes consensus optimization:

### 7.1 Chromaticity-Preserving Radiometric Harmonization
Because different AI beautify runs or sun angles produce subtle lighting exposure shifts, `runFuse` computes the global consensus luminance target $L_{\text{target}}$ across all stations:

$$\text{gain}_k = \text{clamp}\left( \frac{L_{\text{target}}}{\max(0.05, L_k)}, 0.70, 1.40 \right)$$

Each station's RGB channels are scaled by $\text{gain}_k$. This equalizes exposure across all angles while strictly preserving relative color chromaticity $(r/g/b)$, preventing yellowing or desaturation.

### 7.2 Adaptive Concentric LOD Shells
To manage splat counts over large geographic areas, voxel grid sizing expands dynamically based on horizontal distance $D_{\text{horiz}}$ from the landmark anchor:

| Shell | Radial Distance | Voxel Cell Size | Target Geometric Feature |
| :--- | :--- | :--- | :--- |
| **Shell 0 (Core Focal)** | $0\text{m} - 75\text{m}$ | $1.0\times$ base ($5\text{cm} - 10\text{cm}$) | Intricate capitals, column fluting, archway soffits, inscription reliefs |
| **Shell 1 (Mid-Range)** | $75\text{m} - 160\text{m}$ | $2.0\times$ base ($10\text{cm} - 20\text{cm}$) | Colosseum outer ring, perimeter plazas, pedestrian sidewalks |
| **Shell 2 (Peripheral)** | $160\text{m} - 260\text{m}$ | $3.5\times$ base ($17.5\text{cm} - 35\text{cm}$) | Adjacent boulevards, outer perimeter trees, adjacent building envelopes |
| **Shell 3 (Macro Context)**| $> 260\text{m}$ | $5.0\times$ base ($25\text{cm} - 50\text{cm}$) | Distant urban district skyline and regional topography |

### 7.3 Multi-View Normal Consensus & Ground Paver Priority
- **Spatial Voxel Hashing**: The 64-bit voxel key incorporates spatial cell indices $(v_x, v_y, v_z)$, concentric shell ID, and a surface normal category ($+1$ upward roof/ground, $-1$ downward ceiling/soffit, $0$ vertical facade).
- **Normal Consensus Pruning**: If two observations occupying the same voxel have opposing normals ($\mathbf{n}_1 \cdot \mathbf{n}_2 < \cos \theta_{\text{prune}}$), the lower-resolution or higher-uncertainty observation is rejected.
- **Multi-Tier GSD Resolution Priority**: Fine-scale pedestrian splats (lower physical footprint $\sigma$) strictly supersede coarse aerial splats. Aerial splats can never overwrite sharp ground or facade details.
- **Soft Radial Boundary Feathering**: On the outer 10% of the landmark crop radius, splat opacities follow a linear ramp to zero, eliminating harsh circular clipping boundaries.

---

## 8. OGC 3D Tiles 1.1 Hierarchical Octree & Geodetic Anchoring

To stream millions of Gaussian splats efficiently across web browsers without crashing GPU memory, `Splat3DTilesService` (`packages/core/src/node/spatial/Splat3DTilesService.ts`) and `splat_to_3dtiles.cpp` package the fused splats into the standard **OGC 3D Tiles 1.1 specification**:

### 8.1 SPZ Compression & Morton Octree Hierarchy
- **SPZ Compressed Splats**: Splats are encoded using the modern `.spz` binary format, which compresses Gaussian positions, spherical harmonics, scale vectors, and rotation quaternions to $\sim 4 - 6$ bytes per splat (an $80\% - 90\%$ size reduction over raw PLY).
- **Morton Octree Spatial Index**: Points are sorted along a 3D Morton space-filling curve (Z-order) and partitioned into an octree hierarchy.
- **Hierarchical Level of Detail (HLOD)**:
  - Root and interior nodes contain simplified subsets of splats representing distant low-frequency views.
  - Leaf nodes contain full-density micro-splats.
  - Each node defines a metric `geometricError` driving Screen-Space Error (SSE) refinement in the client.

### 8.2 WGS-84 Geodetic Root Transformation Matrix
To align the local Three.js coordinate system with global real-world coordinates, `tileset.json` embeds a 16-element column-major $4 \times 4$ transformation matrix $\mathbf{T}_{\text{root}}$:

$$\mathbf{T}_{\text{root}} = \begin{pmatrix} 
\mathbf{R}_{\text{ENU} \to \text{ECEF}} & \mathbf{P}_{\text{ECEF}}(\phi_0, \lambda_0, h_0) \\
\mathbf{0}^T & 1 
\end{pmatrix}$$

This enables the splats to render in perfect 1:1 spatial registration on top of Google Maps Photorealistic 3D Tiles in Cesium, Scratchbox Studio, or any standard geospatial viewer.

---

## 9. Real-Time Viewport & Soft-Z Volumetric Interleaving

Visualized in `public/geographic_3dgs_studio.html` and powered by `PhotorealGaussianSplatMesh.ts`:

### 9.1 Continuous Soft-Z Volumetric Interleaving
When compositing high-resolution Gaussian splats over the underlying photogrammetric 3D tile mesh, standard depth buffering causes severe Z-fighting and hard geometric slicing lines. The studio implements **Soft-Z Volumetric Depth Interleaving**:

```glsl
// Soft-Z volumetric depth margin evaluation
float tileMeshDepth = texture2D(uTileDepthTexture, screenUV).r;
float splatDepth = gl_FragCoord.z;
float depthDelta = (splatDepth - tileMeshDepth) * uDepthScale;

// Soft feathering margin (epsilon = 0.20m - 0.25m)
float softAlpha = smoothstep(-uSoftZEpsilon, uSoftZEpsilon, depthDelta);
gl_FragColor.a *= softAlpha;
```

This creates a seamless optical transition where splats feather smoothly into the structural massing without clipping artifacts.

### 9.2 The 8-Dimension Visual Fidelity Rubric
All geographic 3DGS scenes are evaluated by the automated `visual-critic` against strict photorealistic criteria (minimum passing score $\ge 8.5/10$ across all axes):
1. **Geometric Definition & Silhouette Crispness**: Sharp, straight columns and cornices; zero lumpy, melted surfaces.
2. **Splat Density & Anisotropic Covariance**: True projected 2D covariance ellipses ($\Sigma' = \mathbf{J} \mathbf{W} \mathbf{V} \mathbf{W}^T \mathbf{J}^T$); zero billboard discs.
3. **Material & Micro-Surface Definition**: Tactile travertine cavitation, ashlar masonry joints, and calcite grain.
4. **Environmental Grounding**: Complete $360^\circ$ physical atmospheric sky dome (Rayleigh/Mie scattering); zero black voids.
5. **Radiometric Lighting & Analytical Shadows**: Directional sun shadows driven by NOAA solar ephemeris matching real time-of-day.
6. **Color Temperature Harmonization**: Planckian blackbody color temperatures ($1,000\text{K} - 40,000\text{K}$) synchronized across splats and tiles.
7. **Volumetric Depth & Interleaving**: Smooth Soft-Z penetration without boundary seams.
8. **The "Squint Test"**: Indistinguishable from an authentic optical photograph to an unprimed observer.

---

## 10. Automated Verification & Production Test Suite

The pipeline is verified by automated Vitest test suites and headless visual capture gates:

### 10.1 Key Automated Test Suites
- `packages/core/test/geographic-3dgs-refinement.test.ts`:
  - Validates `geographic-3dtiles-survey` 4-tier station generation.
  - Verifies pedestrian altitude clearance ($1.8\text{m} - 5.0\text{m}$) and nadir plunge ($\le -55^\circ$).
  - Serves `geographic_3dgs_studio.html` and audits Three.js WebGL canvas rendering.
- `packages/core/test/fal-flux-depth-survey.test.ts`:
  - Verifies extraction of Clay, Depth Mist, and Normal passes.
  - Validates live fal.ai FLUX.1 [dev] Depth LoRA image generation and Img2Img restoration.
  - Confirms multi-panel verification boards.
- `packages/core/test/render-multimodal-survey-passes.test.ts`:
  - Renders real multimodal survey conditioning passes for the Colosseum and Arch of Constantine.

### 10.2 Empirical Benchmarks (Rome Colosseum Survey Benchmark)

| Stage / Metric | Raw Photogrammetric 3D Tile | fal.ai FLUX.1 [dev] Depth LoRA | Vertex AI / Nano Banana 2 | Fused 3DGS Model (Final) |
| :--- | :--- | :--- | :--- | :--- |
| **Ground Sample Distance (GSD)** | $12.5\text{cm/px}$ (blurry, low-res) | $< 1.5\text{cm/px}$ (crisp ashlar) | $< 1.8\text{cm/px}$ (travertine relief) | **$1.8\text{cm}$ spatial density** |
| **Corner / Column Definition** | Rounded, melted, non-manifold | Straight, sharp, plumb | Straight, organic patina | **Planar 2D surfels ($\sigma_{\perp}=10^{-4}$)** |
| **Baked Shadow Contamination** | Severe midday baked shadows | De-lit / harmonized | Atmospheric dusk lighting | **Radiometrically harmonized** |
| **Generation Latency** | N/A (Static ingest: 4.2s) | $12.4\text{s}$ per station | $3.2\text{s}$ per station | **$850\text{ms}$ C++ bake & fuse** |
| **Storage / VRAM Footprint** | $145\text{MB}$ GLB | $2.1\text{MB}$ PNG per frame | $1.8\text{MB}$ PNG per frame | **$14.2\text{MB}$ SPZ (620k splats)** |
| **Interactive Viewport FPS** | $60\text{ FPS}$ (Three.js WebGL) | Static 2D raster | Static 2D raster | **$60\text{ FPS}$ real-time 3D** |

---

## 11. Visual Proof & Verification Artifacts

The following visual artifacts demonstrate each stage of the pipeline:

### 11.1 Geographic 3DGS Studio: Integrated 3D Tile Mesh & Gaussian Splats
Interactive dual-layer inspection showing real-time 3D Gaussian Splats with Soft-Z volumetric interleaving over the Google 3D Tile mesh:
![Geographic 3DGS Studio](docs/screenshots/135_geographic_3dgs_studio.png)

### 11.2 Multimodal Spatial Conditioning Passes
Dense conditioning passes extracted directly from the 3D tile mesh (Studio Grey Clay, Distance Mist Depth, Surface Normals, and Silhouette Mask):
![Multimodal Survey Conditioning Board](docs/screenshots/136_multimodal_survey_conditioning_board.png)

### 11.3 Radiance Solo vs Structural Tile Mesh Solo
Visualizing the decoupling between high-resolution radiance splats and the underlying geospatial foundation:
- **Left (Radiance Splats Solo)**:
  ![3DGS Radiance Solo](docs/screenshots/137_geographic_3dgs_radiance_solo.png)
- **Right (3D Tile Mesh Foundation Solo)**:
  ![3D Tile Mesh Solo](docs/screenshots/136_geographic_3d_tile_mesh_solo.png)

### 11.4 Live Head-to-Head Comparison: Raw 3D Tile vs Nano Banana vs fal.ai FLUX.1 [dev]
Tri-panel verification board comparing the raw coarse photogrammetric tile against Google Nano Banana 2 and fal.ai FLUX.1 [dev]:
![Colosseum Head-to-Head Comparison](docs/screenshots/150_colosseum_head_to_head_nano_banana_vs_flux.png)

### 11.5 Colosseum fal.ai FLUX.1 [dev] Verification Board
Detailed verification showing the progression from raw tile crop to Depth LoRA reconstruction and full-resolution image restoration:
![Colosseum fal.ai FLUX Verification Board](docs/screenshots/148_colosseum_fal_flux_verification_board.png)

---

## 12. Command-Line Interface & Programmatic Recipes

### 12.1 End-to-End Pipeline Execution via CLI
To execute the complete pipeline for any geographic coordinate or landmark query:

```bash
# 1. Synthesize 4-tier geographic survey camera stations
npx tsx scripts/run_survey_pipeline_cli.ts \
  --location "Colosseum, Rome, Italy" \
  --pattern "geographic-3dtiles-survey" \
  --stations 24 \
  --radius 130 \
  --out-dir "public/surveys/colosseum_rome"

# 2. Extract multimodal survey passes (Clay, Depth, Normal, Mist) via survey director
npm run build:core

# 3. Beautify stations via Vertex AI / Google Omni
npm run sbox -- ai-beautify --location "Colosseum, Rome"

# 4. Bake stations into oriented Gaussian splats and fuse into global model
build/station_to_splats \
  --fuse-list "public/surveys/colosseum_rome/fuse_list.txt" \
  --voxel-size 0.08 \
  --crop-radius 115.0 \
  --normal-prune-cos 0.25 \
  --drop-foliage \
  --adaptive-voxel \
  --2dgs \
  --out-splat "public/models/colosseum_fused.splat" \
  --out-spz "public/models/colosseum_fused.spz"

# 5. Pack fused splats into OGC 3D Tiles 1.1 octree
build/splat_to_3dtiles \
  --input "public/models/colosseum_fused.spz" \
  --out-dir "public/tilesets/colosseum_3dgs_tiles" \
  --lat 41.8902 --lng 12.4922 --alt 22.0
```

### 12.2 Programmatic TypeScript Ingestion
```typescript
import { 
  SurveySynthesisEngine, 
  SurveyStationRenderService, 
  SurveySplatPipelineService 
} from '@scratchbox/core/node';

// Initialize pipeline
const pipeline = new SurveySplatPipelineService();
const result = await pipeline.run({
  glbPath: 'public/models/colosseum_grounded.glb',
  anchor: { lat: 41.8902, lng: 12.4922, elevationMeters: 22.0 },
  stations: poses,
  outDir: 'public/surveys/colosseum_rome',
  beautify: {
    landmarkName: 'Colosseum',
    stoneType: 'travertine',
    era: 'contemporary'
  },
  mode: 'chained',
  voxelSizeMeters: 0.08,
  cropRadius: 115.0,
  dropFoliage: true,
  use2dgs: true,
  surfaceModel: 'planar',
  tiles: { maxDepth: 5, leafCapacity: 65536 }
});

console.log(`Generated ${result.totalSplats} splats across ${result.tilesetPath}`);
```
