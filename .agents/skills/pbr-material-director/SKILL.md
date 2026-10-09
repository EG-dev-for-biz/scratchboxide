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
        ┌────────────┴────────────┐
        ▼                         ▼
 [Tier 1: Native C++20 Engine]   [Resilient Procedural Fallback]
 (scratchbox_pbr_manifold.hpp,    (Node.js / texture-processing.ts)
  OpenMP/std::async, SIMD)
        │                         │
        └────────────┬────────────┘
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
- `archetype`: Optional base anchor from the 50-material biophysical library (e.g. `'carrara_marble'`, `'cor_ten_steel'`, `'roman_travertine'`, `'aerospace_carbon_fiber'`).
- `descriptor`: Partial or full `ContinuousMaterialDescriptor` in $\mathbb{R}^{20}$.
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
Returns the calibrated 50-archetype biophysical library and parameter spaces:
- Architectural stones (Limestone, Travertine, Marble, Basalt, Granite)
- Structural metals (Cor-Ten steel, Brushed Titanium, Cast Iron, Copper patina)
- High-tech composites (Aerospace carbon fiber, PTFE, Anodized aerospace alloy)
- Organic & biomorphic surfaces (Rhytidome bark, Chitin exoskeleton, Travertine calcite)

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
| **Generation Latency** | **1.5s–6s (Local CPU/SIMD) / 15ms (TS)** | 30s–90s (Cloud Queue) | Interactive Manual | N/A | 15s–30s (GPU) |
| **Zero Closed Taxonomies (ADA)** | **100% (Continuous $\mathbb{R}^{20}$ Manifold)** | ❌ (Trained latent priors) | ❌ (Manual node graphs) | ❌ (Node taxonomy) | ❌ (Fixed dataset) |
| **Compute & Cost** | **Zero GPU / Apple Clang native ($0)** | High-cost cloud GPU cluster ($$$) | Local Desktop GPU | Host Dependent | NVIDIA GPU (PyTorch) |
| **Binary glTF 2.0 Output** | **Direct binary `.glb` plane & plinth** | Cloud export mesh | Manual export | DCC Export | Python numpy export |
| **Curvature Wear Coupling** | **Analytical Scharr curvature burnish** | Probabilistic texture diffusion | Manual painting layer | Manual procedural graph | ❌ |
