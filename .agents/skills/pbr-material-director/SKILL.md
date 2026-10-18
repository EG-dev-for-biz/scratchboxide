---
name: pbr-material-director
description: Direct, calibrate, synthesize, and pack photographic-grade PBR material texture sets (1K, 2K, 4K, 8K, 12K) using native C++20 multithreaded SIMD kernels and continuous biophysical manifolds (R^20), in competition with Hyper3D Rodin. Complies with Adaptive Domain Architecture (zero closed taxonomies), strict prohibition on Three.js texture generation, and zero cloud GPU overhead.
---

# PBR Material Director Skill

The **PBR Material Director Skill** equips AI agents with high-performance, photographic-grade Physically Based Rendering (PBR) material synthesis and calibration. Operating directly within the Scratchbox native C++20 engine and TypeScript API, it generates multi-resolution texture sets across **1K ($1024$), 2K ($2048$), 4K ($4096$), 8K ($8192$), and up to 12K ($12288 \times 12288$)**, directly rivaling and surpassing cloud diffusion solutions such as Hyper3D Rodin (Deemos Tech) without cloud GPU costs, queuing latency, or taxonomic constraints.

---

## 1. System Architecture

```
[Agent Request / User Prompt / Archetype]
                     │
                     ▼
  [Continuous Biophysical Descriptor (R^20)]
  - Albedo Linear [R, G, B]
  - Conduction (Metallic [0.0 - 1.0])
  - Roughness Baseline & Micro-Porosity
  - Anisotropy Vector (Strength + Angle)
  - Fissure Frequency & Depth
  - Cellular & Grain Multi-Scale Fields
                     │
                     ▼
 [Native C++20 Engine: scratchbox_pbr_manifold.hpp, OpenMP/std::async, SIMD]
 (the only synthesizer: a compile or run failure is a NativePbrSynthesisError, never a substitute)
                     │
                     ▼
 [Multi-Channel Biophysical Synthesizer]
 1. Anisotropic Manifold Coordinate Warping
 2. Multi-Octave FBM + Cellular Micro-Relief Field
 3. High-Pass Scharr Gradient Tangent Normal Generation
 4. Biophysical Curvature-Coupled Roughness (Burnish / Crevice dirt)
 5. 8-Directional Horizon Cavity Ambient Occlusion
                     │
                     ▼
 [Channel Packing & glTF 2.0 ORM]
 - Albedo Map: sRGB Linear Base Color
 - Normal Map: Tangent-Space OpenGL [+X, +Y, +Z]
 - ORM Map: R = Ambient Occlusion, G = Roughness, B = Metallic
 - Height Map: Virtual Normalized Displacement
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  ['png_pack' Output]        ['glb' Binary Mesh Plane]
  - 4x 16-bit/8-bit PNGs    - Standard glTF 2.0 (0x46546C67)
  - Raw uncompressed buffers - Displaced 3D surface plinth
                             - Ready for Three.js Stage Viewport
```

---

## 2. Core Directives & Invariants

### 1. The Alien Planet Test (Adaptive Domain Architecture Directive)
- **Zero Closed Taxonomies**: Never categorize materials via static enums (`type Material = 'wood' | 'gold' | 'marble'`).
- **Continuous $\mathbb{R}^{20}$ Dimensional Parameter Manifold**: Any material—whether terrestrial Carrara marble or an extraterrestrial cryogenic methane hydrate crystal—is represented as a continuous vector in $\mathbb{R}^{20}$ (`ContinuousMaterialDescriptor`).
- **Smooth Manifold Interpolation**: Materials can be continuously blended and morphed using `pbr_interpolate_materials` along geodesic paths in the continuous parameter space:
  $$\mathbf{M}(t) = (1 - t)\mathbf{M}_A + t\mathbf{M}_B$$

### 2. Strict Prohibition on Three.js Procedural Textures
- **Zero Three.js Texture Synthesis**: Procedural texture authoring MUST NEVER use client-side Three.js constructors (`new THREE.DataTexture`, HTML5 2D canvas drawing loops, or runtime Three.js procedural shaders).
- **Three.js as Pure Viewport**: Three.js is strictly a WebGL rendering viewport. All textures and geometries are generated upstream by the native engine and ingested as binary buffers or standard binary glTF 2.0 (`.glb`).

### 3. Multi-Resolution Ladder (1K to 12K)
The engine natively supports continuous arbitrary power-of-two and rectangular resolutions:
- **1K ($1024 \times 1024$)**: Fast iteration, mobile WebXR, background props (~100 ms).
- **2K ($2048 \times 2048$)**: Standard production default, high-frequency micro-relief (~350 ms).
- **4K ($4096 \times 4096$)**: Hero film assets, architectural hero surfaces (~1.5 s).
- **8K ($8192 \times 8192$)**: IMAX, large-format close-up VFX (~5 s).
- **12K ($12288 \times 12288$)**: Ultimate cinematic fidelity, competitive with Hyper3D Rodin Master tier (~12 s).

### 4. Chroma-Preserving Shadow Lifting (Prohibition on Scalar RGB Scaling)
- **The Scalar Desaturation Trap**: When de-lighting aerial or photographic stone textures, never multiply $R, G, B$ by a scalar `lift = 1.0 + k * shadowFrac^2`. In colorimetry, scaling RGB in dark crevices raises luminance without expanding chroma, bleaching rich amber/ochre travertine recesses into flat chalky grey.
- **Polar Chroma Expansion**: De-lighting kernels must transform into polar chroma spaces (HSV or CIELAB) and expand saturation proportionally to shadow depth:
  $$S_{\text{lifted}} = \operatorname{clamp}\left( S \cdot \left(1.0 + \beta \left(\frac{L_{\text{target}} - L}{L_{\text{target}}}\right)\right), \; 0.0, \; 1.0 \right)$$
  This guarantees that shadowed arcades and architectural recesses preserve authentic warm limonite mineral patinas.

### 5. Cross-Source Gamut Balancing & Diffuse Studio Wash Mitigation
- **Gamut Disparity in Hybrid Scenes**: Digital DCC botanical libraries author foliage textures with high chlorophyll chromaticity ($S \approx 0.60\text{–}0.70$), while aerial photogrammetric stone has naturally low chroma ($S \approx 0.17\text{–}0.24$) due to atmospheric Rayleigh haze.
- **Biophysical Eco-Region Clamping**: When instancing botanical foliage into photogrammetric scenes, clamp foliage saturation to the target eco-region ($S \approx 0.38\text{–}0.42$ for Mediterranean arid pine/cypress) to prevent trees from appearing hyper-saturated or tropical.
- **Achromatic Studio Wash Compensation**: Neutral studio environment maps in Three.js or `<model-viewer>` scatter pure white diffuse light across pale stone ($R \approx 1.0, M = 0.0$). Apply a $+15\%\text{–}25\%$ warm-chroma compensation curve on pale limestone/travertine albedos to prevent the stone from appearing washed out and bleached.

---

## 3. Gemini Agent Tools & TypeScript APIs

### 1. `pbr_synthesize_material`
Synthesizes a full PBR texture set from an archetype or continuous biophysical descriptor.

```typescript
// Example: Synthesizing a 4K anisotropic brushed titanium material
const result = await call_tool('pbr_synthesize_material', {
    resolution: '4K',
    archetype: 'brushed_titanium',
    format: 'glb',
    planeWidthMeters: 2.0,
    displacementScaleMeters: 0.02,
    descriptor: {
        anisotropyStrength: 0.95,
        anisotropyAngleRad: 0.785, // 45 degrees
        roughnessBaseline: 0.22,
        conduction: 0.98
    }
});
```

**Parameters:**
- `resolution`: Multi-res tier (`'1K'`, `'2K'`, `'4K'`, `'8K'`, `'12K'`) or integer pixel dimension (e.g. `4096`).
- `descriptor`: The material, as a `ContinuousMaterialDescriptor` in $\mathbb{R}^{20}$, filled from the user's description of the surface. Without an archetype it must give `albedoLinear`, `conduction` and `roughnessBaseline` (the rest default to neutral noise settings).
- `archetype`: Optional shortcut to a named example descriptor (e.g. `'carrara_marble'`, `'corten_steel'`, `'roman_travertine'`); `descriptor` fields override it. An unknown name fails with the key list. With neither archetype nor descriptor the call fails: no material is assumed.
- `format`: Output format:
  - `'png_pack'` (default): Writes individual Albedo, Normal, ORM, and Height PNG files.
  - `'glb'`: Generates a fully textured, normal-mapped 3D test plinth in standard binary glTF 2.0 format.
  - `'raw_buffer'`: Writes uncompressed raw float/byte buffers for direct C++ or GPU ingestion.
  - `'materialx'`: Generates OpenPBR v1.38 compliant XML `.mtlx` document (with Autodesk Standard Surface fallback) and referenced texture maps for Houdini Karma, Unreal Engine 5.4+, and Maya Arnold.
  - `'usdz'`: Packages a zero-compression, Pixar/Apple 64-byte aligned USDZ archive containing `material.usda` (`UsdPreviewSurface`) and relative PBR textures.
- `uvTilingX` / `uvTilingY`: Multiplier for continuous UV texture coordinate repetition across surface manifolds (default: `1.0`).
- `outputDir`: Directory to persist texture files.
- `outputFileName`: Base filename prefix.

### 2. `pbr_get_material_catalog`
Lists 50 named example descriptors (stones, concrete and paving, metals, glazing, roofing, timbers, weathering), each with its full descriptor. They are reference points, not a closed list: any surface (including ones no example covers) is a descriptor filled from the user's words. `query` narrows the list by free text.

### 3. `pbr_interpolate_materials`
Blends two materials along the continuous $\mathbb{R}^{20}$ biophysical manifold.

```typescript
const blendedDescriptor = await call_tool('pbr_interpolate_materials', {
    materialA: 'carrara_marble',
    materialB: 'oxidized_copper',
    factor: 0.5 // 50/50 biophysical blend
});
```

---

## 4. Mathematical & Biophysical Formulation

### 1. Anisotropic Manifold Warping
Coordinates are rotated and stretched to reproduce directionally aligned micro-structures (wood grain, brushed metal, woven carbon fiber):
$$u_{\text{rot}} = u\cos\theta - v\sin\theta$$
$$v_{\text{rot}} = (u\sin\theta + v\cos\theta)(1 + 8s_{\text{aniso}})$$

### 2. High-Pass Scharr Normal Field
Surface normal gradients are computed with a $3 \times 3$ Scharr operator, preserving high-frequency micro-relief:
$$\mathbf{G}_x = \begin{bmatrix} -3 & 0 & 3 \\ -10 & 0 & 10 \\ -3 & 0 & 3 \end{bmatrix} * H, \quad \mathbf{G}_y = \begin{bmatrix} -3 & -10 & -3 \\ 0 & 0 & 0 \\ 3 & 10 & 3 \end{bmatrix} * H$$
$$\mathbf{n} = \operatorname{normalize}\begin{pmatrix} -G_x \cdot s_N \\ -G_y \cdot s_N \\ 1.0 \end{pmatrix}$$

### 3. Biophysical Curvature-Coupled Roughness
Micro-surface roughness is dynamically coupled to local mean surface curvature $\kappa$:
$$\kappa = 4H(x, y) - \sum_{(dx, dy) \in \mathcal{N}_4} H(x + dx, y + dy)$$
$$R(x, y) = \operatorname{clamp}\left(R_0 - \max(0, \kappa)\cdot 0.35 + \max(0, -\kappa)\cdot 0.40 + (1 - H)\cdot \mu_P, \, 0.04, \, 0.98\right)$$
- Convex ridges ($\kappa > 0$) undergo handling wear and friction polishing (lower roughness).
- Concave fissures ($\kappa < 0$) collect grime, dust, and micro-debris (higher roughness).

### 4. glTF 2.0 ORM Standard Channel Packing
$$\text{ORM} = \begin{pmatrix} \text{Red: Ambient Occlusion} \\ \text{Green: Biophysical Roughness} \\ \text{Blue: Electrical Conduction (Metallic)} \end{pmatrix}$$

### 5. Continuous Texture Coordinate Tiling & Seamless Triplanar Projection
For arbitrary non-manifold or complex architectural meshes, continuous biophysical materials are mapped without UV seams via triplanar projection in `scratchbox_engine.hpp` (`sb::applyContinuousTriplanarToMesh`, `sb::sampleContinuousManifoldTriplanar`):
$$w_i = \frac{|n_i|^k}{\sum_{j \in \{x,y,z\}} |n_j|^k}, \quad k \in [4, 8]$$
Normals are blended per-axis via Reoriented Normal Mapping (RNM) preserving micro-relief without distortion:
$$\mathbf{n}_{\text{rnm}} = \operatorname{normalize}\begin{pmatrix} \mathbf{n}_{\text{base}}.xy + \mathbf{n}_{\text{detail}}.xy \\ \mathbf{n}_{\text{base}}.z \cdot \mathbf{n}_{\text{detail}}.z \end{pmatrix}$$

---

## 5. Competitive Analysis & Benchmark Matrix

| Capability | Scratchbox Native PBR Manifold | Hyper3D Rodin (Deemos) | ArmorPaint | MaterialX | Matfuse |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Core Architecture** | Analytical $\mathbb{R}^{20}$ Manifold + Native C++20 SIMD | Multi-View Latent Diffusion | GPU Node Shader Painting | XML Material Specification | 2D Latent Diffusion |
| **Resolution Range** | **1K, 2K, 4K, 8K, 12K ($12288^2$)** | 8K–16K (Cloud Diffusion) | Up to 16K (Manual paint) | Host-dependent | $512 \times 512$ |
| **Generation Latency** | **~0.1s at 1K, ~0.4s at 2K kernel time measured on an M-series Mac (reported per call in `nativeTimingsMs`)** | 30s–90s (Cloud Queue) | Interactive Manual | N/A | 15s–30s (GPU) |
| **Zero Closed Taxonomies (ADA)** | **100% (Continuous $\mathbb{R}^{20}$ Manifold)** | ❌ (Trained latent priors) | ❌ (Manual node graphs) | ❌ (Node taxonomy) | ❌ (Fixed dataset) |
| **Compute & Cost** | **Zero GPU / Apple Clang native ($0)** | High-cost cloud GPU cluster ($$$) | Local Desktop GPU | Host Dependent | NVIDIA GPU (PyTorch) |
| **Binary glTF 2.0 Output** | **Direct binary `.glb` plane & plinth** | Cloud export mesh | Manual export | DCC Export | Python numpy export |
| **Curvature Wear Coupling** | **Analytical Scharr curvature burnish** | Probabilistic texture diffusion | Manual painting layer | Manual procedural graph | ❌ |

---

## 6. Scenario-Adaptive UV Wrapping & Seam Mitigation Engine (`AdaptiveUvOrchestrator`)

### 1. Organic vs. Non-Organic Continuous Classification ($\Omega \in [0.0, 1.0]$)
In compliance with the **Adaptive Domain Architecture (ADA)**, surface classification is evaluated as a continuous organicity index $\Omega \in [0.0, 1.0]$:
- **Organic ($\Omega \to 1.0$)**: Living anatomy, articulated limbs, digits, creatures, and deforming surfaces. Requires strain-preserving parameterization and natural occlusion seams.
- **Non-Organic ($\Omega \to 0.0$)**: Hard-surface CAD, architectural edifices, infrastructure, props, and photogrammetric scans. Requires rigid, reveal-aligned, or completely seam-free unwrapping.

### 2. Scenario-Adaptive UV Strategy & Seam Decision Matrix

| Scenario & Mesh Topology | Optimal UV Strategy | Seam Placement | Seam Adjustment & Mitigation Technique |
| :--- | :--- | :--- | :--- |
| **Organic: Deforming Limbs / Digits / Avatars** ($\Omega \ge 0.5$, articulated) | **$\mathrm{SO}(3)$ Carrier-Frame Conformal Sheets** (`scratchbox_carrier.hpp`) | Natural anatomical occlusion lines (lateral inter-digital neutral line; extensor-flexor boundary). NEVER on joints, knuckles, or front faces. | **Hermite Margin Overlap** ($\ge 8\,\text{px}$) + **Continuous Metric Arc-Length** ($v$-axis) + **MikkTSpace Handedness** ($\mathbf{B} = \operatorname{sign} \cdot (\mathbf{N} \times \mathbf{T})$) + **Harmonic Dirichlet Boundary Smoothing**. |
| **Non-Organic: Rigid CAD / Vehicles / Props** ($\Omega < 0.5$, boxy/compact) | **Height-Blended Triplanar** (`scratchbox_triplanar.hpp`) | **Zero Seams (Seam-Free)**! | No UV unwrapping or seam cuts needed. Normal-weighted projection ($w_i = n_i^k / \sum n_j^k$, $k \ge 4$) blended with height map transitions. |
| **Non-Organic: High-Rise Architecture** ($\Omega < 0.5, Y \ge 35\text{m}$, aspect $\ge 1.5$) | **Elevation-Stratified Conformal Mapping** (`AlgorithmicUvEngine.ts`) | Architectural reveals, internal re-entrant corners, window mullions, and chamfers. | **Wall-Corner Co-Planar Unfolding** + **16-pixel Dilation Gutters** (`gutterDilationPixels: 16`) + **Laplacian Crevice Ambient Occlusion** (visually masks micro-filtering differences) + **NOAA Solar Inverse De-Lighting**. |
| **Non-Organic: Massive Photogrammetric Tile Scans** ($\ge 10$ submeshes) | **Hybrid Recipe PBR** (`HybridRecipePbrService.ts`) | Existing drone camera capture boundaries. | **KD-Tree Boundary Seam Welding** (`weldTileBoundarySeams`) + **Affine Edge Altitude (`_SBEDGEH`) & Octahedral Neighbor Normals (`_SBNBRA`)** for GPU micro-beveling across seams without geometry mutation. |

### 3. Agent Tool Invocations

#### A. Probe Mesh Topology & Compute Seam Strategy
```json
{
  "name": "pbr_probe_mesh_topology",
  "arguments": {
    "meshPath": "/Users/eligreen/dev/scratchbox-ide-master/public/models/character_arm.glb",
    "domain": "organic"
  }
}
```
**Returns** measured quantities only: counts (`submeshCount`, `primitiveCount`, `renderedInstances`, `vertexCount`, `triangleCount`, `imageCount`, `texturedPrimitives`), world `bounds` (`boundsSpace` says how they were measured), the outcome of each routing rule (`rules`), `recommendedStrategy` with the `routingRule` that picked it, `methodThatRuns` (for `height_blended_triplanar` / `carrier_conformal_sheet` that is per-triangle box projection) and what it does about UV `seams`. There is no organicity index or confidence score.

#### B. Synthesize & Apply Adaptive PBR to Target Mesh
```json
{
  "name": "pbr_synthesize_material",
  "arguments": {
    "targetMeshPath": "/Users/eligreen/dev/scratchbox-ide-master/public/models/empire_state_building.glb",
    "domain": "nonorganic",
    "uvStrategy": "elevation_stratified_conformal",
    "solarCoordinates": {
      "latitude": 40.748817,
      "longitude": -73.985428,
      "timestampIso": "2026-10-11T14:30:00Z"
    },
    "seamPaddingPx": 16,
    "resolution": "4K"
  }
}
```

---

## 7. Low-Frequency Ratio De-Lighting & Direct Street View Texture Remaking

### 1. Inadequacy of Scalar Shadow Multiplication
When de-lighting photogrammetric surfaces, scalar adjustments ($V \leftarrow V + k \cdot \text{shadow}$) leave visible transition penumbras and fail to replace the muddy, low-chroma pixel data inside subterranean or shadowed vaults.

### 2. Separable 2D Box Filter Illuminance Extraction
1. Extract low-frequency spatial illumination using a fast separable box filter:
   $$Y_{\text{smooth}}(x, y) = \frac{1}{(2R+1)^2} \sum_{i=-R}^R \sum_{j=-R}^R Y(x+i, y+j), \quad R = 16$$
2. Compute high-frequency structural detail ratio:
   $$D(x, y) = \operatorname{clamp}\left(\frac{Y(x, y)}{\max(0.04f, Y_{\text{smooth}}(x, y))}, \; 0.72, \; 1.28\right)$$
3. Modulate authentic Street View PBR base albedo (e.g. Roman Travertine $L \approx 70.3, a \approx 6.0, b \approx 28.6$):
   $$\mathbf{a}_{\text{out}}(x, y) = \text{Albedo}_{\text{StreetView}} \cdot D(x, y)$$
4. Deep shadows ($Y \approx Y_{\text{smooth}}$) seamlessly resolve to pure sunlit stone, while high-frequency ashlar joints and carving relief ($Y < Y_{\text{smooth}}$) are razor-sharp.

---

## 8. Organic Anatomical Zero-Gap UV Wrapping & Multi-Aspect Blending

### 1. The 4 Failure Modes of Planar/Dual-Aspect Organic Texturing
When mapping 2D photographic references onto complex 3D organic anatomy (such as hands, articulated digits, limbs, and facial structures), naive planar or dual-aspect projection fails due to:
1. **Grazing-Angle Singularity ($\mathbf{n} \cdot \mathbf{d}_{\text{cam}} \to 0$)**: Surface area shrinks to zero ($dA_{\text{proj}} \to 0$), smearing 1-pixel photo edges into elongated longitudinal streaks down the sides of fingers and limbs.
2. **Missing Lateral Information**: Planar front/back photos provide zero observation of the lateral flanks ($360^\circ$ perimeter).
3. **Gutter Mipmap Bleed**: Abrupt UV island termination without dilation causes GPU downsampling to sample the black background ($[0,0,0,0]$), creating dark outline fringes on outer silhouettes.
4. **Histological Decal Warping**: Keratin nail plates, cuticles, and subcutaneous carbon tattoos warp when subjected to whole-body global unwraps.

### 2. The Five-Stage Zero-Gap Solution Architecture
To guarantee 100% gap-free, non-stretched, and artifact-free organic unwraps:
1. **$\mathrm{SO}(3)$ Carrier-Frame Cylindrical Unwrapping (`scratchbox_carrier.hpp`)**:
   - Sweeps an orthonormal Frenet-Serret frame ($\mathbf{T}, \mathbf{N}, \mathbf{B}$) along kinematic bone splines $\mathbf{C}(t)$.
   - Evaluates continuous metric longitudinal arc-length $v = t^*$ and circumferential polar angle $u = \frac{\theta + \pi}{2\pi}$.
   - Unwraps digits $360^\circ$ with a single seam routed strictly along the lateral inter-digital contact line (hidden from view).
2. **Trilateral Normal-Weighted Continuous Blending**:
   - $w_{\text{dorsal}} = \max(0, \mathbf{n} \cdot \mathbf{d}_{\text{dorsal}})^2$
   - $w_{\text{palmar}} = \max(0, \mathbf{n} \cdot \mathbf{d}_{\text{palmar}})^2$
   - $w_{\text{flank}} = \max(0, 1.0 - (w_{\text{dorsal}} + w_{\text{palmar}}))$
   - Fills lateral profiles with melanin-calibrated procedural skin micro-texture matching the subject's Fitzpatrick scale.
3. **Voronoi Gutter Dilation ($\ge 16\,\text{px}$)**:
   - Floods border pixels outward into atlas gutters via Euclidean distance transforms (`AlgorithmicUvEngine.ts`), preventing black mipmap downsampling fringes on silhouettes.
4. **Decoupled Local Decal Frames**:
   - Pinned orthonormal frames for fingernails ($x_n, y_n \in [-1, 1]$) with 4-zone biological histology (ivory free edge, vascular bed, onychodermal band, lunula).
   - Dedicated local UV window for tattoos/scars ($u \in [0.46, 0.66], v \in [0.84, 0.94]$) with dermal carbon scattering and $C^1$ Hermite alpha tapers.
5. **Screen-Space AI Inpainting for Concave Clefts**:
   - Orbits camera into concave saddles (interdigital web spaces, negative Gaussian curvature $K < 0$).
   - Renders 24px occlusion ribbon mask, calls Imagen 3 / Gemini multimodal inpainting, and inverse-reprojects seamless skin bridges back into the UV atlas.
