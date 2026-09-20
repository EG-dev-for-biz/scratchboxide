---
name: algorithmic-uv-rewrap
description: >-
  Algorithmic UV unwrap, rewrap, and high-definition texture synthesis engine for 3D meshes and photogrammetric tiles.
  Computes inverse barycentric weights and affine determinants for 100% geometric spatial lock (0.000 px drift),
  and synthesizes tactile, material-conformal micro-details: Sobel photographic joint deepening, analytical travertine
  cavitation pores, calcite mineral grain, bedding strata, archway soffit ambient occlusion, clean bitumen roads, and chlorophyll leaf canopy dappling.
---

# Algorithmic UV Unwrap & Rewrap Engine

The **Algorithmic UV Unwrap & Rewrap Skill** provides mathematical principles, rasterization kernels, and material-conformal procedural synthesis algorithms for super-resolving and enhancing 3D mesh texture maps while maintaining **100% geometric spatial lock** (zero UV distortion or drift relative to 3D geometry).

---

## 1. Core Engineering Principle: 100% Geometric Spatial Lock

When enhancing textures on 3D geometry (especially photogrammetric meshes like Google Photorealistic 3D Tiles):
1. **Never Distort UV Parameterization ($0.000\text{ px}$ Drift)**:
   - External neural text-to-image or image-to-image upscalers hallucinate features independently of the underlying 3D topology, shifting architectural edges, creating coordinate swimming, and generating severe boundary seam tearing.
   - Algorithmic unwrap/rewrap projects each 2D texel $(p_x, p_y)$ directly into 3D world space $\mathbf{P}(w_x, w_y, w_z)$ using triangle vertex anchors. The UV map scale is exactly $1.000\times$, maintaining zero pixel displacement.
2. **Material-Conformal Detail Synthesis (Zero Artificial Streaks)**:
   - Detail must be derived from continuous 3D coordinate fields $\mathbf{P} \in \mathbb{R}^3$, never 2D UV coordinates.
   - Reject 2D periodic sine-wave or directional frequency filters that produce artificial zebra stripes across angled polygons.
   - Enforce rigorous semantic classification: distinct physical response curves for masonry stone, asphalt roads, and tree foliage.

---

## 2. Mathematical Foundation: 2D Inverse Barycentric Projection

Given a 3D triangle with vertices $\mathbf{V}_0, \mathbf{V}_1, \mathbf{V}_2$ and corresponding UV texture coordinates $\mathbf{U}_0, \mathbf{U}_1, \mathbf{U}_2$ mapped to image pixel dimensions $W \times H$:

### 1. Affine Determinant
$$\Delta = (v_1 - v_2)(u_0 - u_2) + (u_2 - u_1)(v_0 - v_2)$$

If $|\Delta| < 10^{-6}$, the triangle is degenerate in UV space and can be safely skipped.

### 2. Inverse Barycentric Weights
For any texel $(p_x, p_y)$ inside the triangle's 2D bounding box $[u_{\min}, u_{\max}] \times [v_{\min}, v_{\max}]$:

$$w_0 = \frac{(v_1 - v_2)(p_x - u_2) + (u_2 - u_1)(p_y - v_2)}{\Delta}$$
$$w_1 = \frac{(v_2 - v_0)(p_x - u_2) + (u_0 - u_2)(p_y - v_2)}{\Delta}$$
$$w_2 = 1.0 - w_0 - w_1$$

The point lies strictly within the triangle if:
$$w_0 \ge -\epsilon \quad \land \quad w_1 \ge -\epsilon \quad \land \quad w_2 \ge -\epsilon \quad (\epsilon = 10^{-3})$$

### 3. Continuous 3D Metric Reconstruction
The exact 3D world-space coordinate corresponding to the texel is reconstructed analytically:
$$\mathbf{P}(w_x, w_y, w_z) = w_0 \mathbf{V}_0 + w_1 \mathbf{V}_1 + w_2 \mathbf{V}_2$$

And the triangle normal $\mathbf{N} = \frac{(\mathbf{V}_1 - \mathbf{V}_0) \times (\mathbf{V}_2 - \mathbf{V}_0)}{\|(\mathbf{V}_1 - \mathbf{V}_0) \times (\mathbf{V}_2 - \mathbf{V}_0)\|}$ provides surface orientation for directional lighting and ambient occlusion.

---

## 3. High-Definition Texture Synthesis Pipeline

```
[Original Low-Res Texture (512x512)]
                 │
                 ▼
[Lanczos Accurate-Round Resample (2x / 4x)]
                 │
                 ▼
[Sobel 2D Luminance Gradient (|∇L| / 8.0)]
                 │
                 ▼
[Rasterization Loop over All Triangles]
  ├── Compute 2D affine determinant & barycentric weights (w0, w1, w2)
  ├── Reconstruct 3D world position P(wx, wy, wz) and normal N(nx, ny, nz)
  │
  ├── SEMANTIC CLASSIFICATION:
  │   ├── Foliage (Green chroma: G > R + 3 && G > B + 3 && G > 45)
  │   │   └── Chlorophyll micro-dapple: valueNoise3D(P * 16) + hash3D(P * 65)
  │   │
  │   ├── Ground / Road (wy < 73.5m || (|ny| > 0.70 && wy < 80.0m))
  │   │   └── Bitumen aggregate tooth: valueNoise3D(P * 40) + hash3D(P * 110)
  │   │
  │   └── Roman Travertine Stone Architecture (All elevated non-ground)
  │       ├── 1. Photographic Joint Deepening: ΔL_joint = -min(26, (|∇L| - 6) * 0.90)
  │       ├── 2. Analytical Travertine Cavitation Pores:
  │       │      If valueNoise3D(P * 22) < 0.24:
  │       │        ΔL_pore = -((0.24 - n) / 0.24)^2 * 52.0
  │       ├── 3. Calcite Mineral Grain & Bedding Strata:
  │       │      FBM3D(P * 28, 3 octaves) + hash3D(P * 85) - strataDarken
  │       └── 4. Architectural Ambient Occlusion:
  │              Soffit shadow (ny < -0.15 => 0.76x)
  │              Cornice sky bounce (ny > 0.60 => 1.06x)
  │
  ▼
[1-Pixel Dilated Edge Padding (Bleed Prevention)]
  │
  ▼
[Optimized MozJPEG / libjpeg Encoding (qv <= 3)]
  │
  ▼
[Standard Binary glTF 2.0 (.glb) Repack]
```

---

## 4. Key Mathematical Formulations for Realism

### 1. Photographic Joint & Mortar Crevice Deepening
To recover sharp, tangible voussoir arch vaults and block courses without artificial geometric re-meshing, precompute a 3x3 Sobel gradient over the luminance field $L(x, y) = 0.299 R + 0.587 G + 0.114 B$:
$$G_x = \begin{bmatrix} -1 & 0 & +1 \\ -2 & 0 & +2 \\ -1 & 0 & +1 \end{bmatrix} * L, \quad G_y = \begin{bmatrix} -1 & -2 & -1 \\ 0 & 0 & 0 \\ +1 & +2 & +1 \end{bmatrix} * L$$
$$g = \frac{\sqrt{G_x^2 + G_y^2}}{8.0}$$
$$\Delta L_{\text{joint}} = -\min(26.0, (g - 6.0) \times 0.90) \quad (\text{for } g > 6.0)$$

### 2. Fast Analytical Travertine Cavitation Micro-Pores
Geothermal travertine stone naturally contains steep-walled micro-vacuoles and pits formed by outgassing. Evaluating 3D Worley cellular noise requires checking 27 neighboring cubic cells, which is computationally prohibitive across millions of texels.

The **analytical quadratic depression** models the steep crater lip profile in nanoseconds using a single continuous 3D value noise evaluation:
$$n = \text{valueNoise3D}(\mathbf{P} \cdot 22.0)$$
$$\Delta L_{\text{pore}} = -\left(\frac{0.24 - n}{0.24}\right)^2 \times 52.0 \quad (\text{when } n < 0.24)$$

### 3. Calcite Mineral Tooth & Sedimentary Bedding Strata
Roman ashlar masonry blocks were quarried along natural horizontal bedding planes ($0.35\text{ m}$ block courses):
$$\text{strata} = \sin(w_y \cdot 18.0) \cdot 0.5 + 0.5$$
$$\Delta L_{\text{strata}} = -(\text{strata} - 0.65) \times 16.0 \quad (\text{when } \text{strata} > 0.65)$$
Combined with multi-scale mineral calcite faceting:
$$\Delta L_{\text{calcite}} = (\text{FBM3D}(\mathbf{P} \cdot 28.0, 3) - 0.5) \times 30.0 + (\text{hash3D}(\mathbf{P} \cdot 85.0) - 0.5) \times 12.0$$

---

## 5. Adaptive Domain Architecture: Zero Presets & Signal-Induced Biophysical PBR

In strict compliance with **Adaptive Domain Architecture** (`AGENTS.md`), the engine rejects closed material catalogs or hardcoded taxonomies in favor of open continuous parameter contracts (`BiophysicalMaterialContract`) and signal-induced mathematical operators:

### 1. Multi-Frequency Scharr + Reoriented Normal Mapping (RNM)
Instead of flattening surface gradients, normals are decomposed into three spatial frequency bands:
- **Macro Relief**: Evaluated with wide baseline ($\Delta = 3\text{px}$) for architectural massing and masonry courses.
- **Meso Relief**: High-accuracy $3\times3$ Scharr differential operator minimizing angular error.
- **Micro Relief**: High-pass difference $(\text{center} - \text{avg}_4) \times 8.0$ capturing mineral granular roughness.
Normals are blended via analytical **Reoriented Normal Mapping (RNM)**:
$$\mathbf{u} = [n_{1x}, n_{1y}, n_{1z} + 1], \quad \mathbf{t} = [-n_{2x}, -n_{2y}, n_{2z}], \quad \mathbf{r} = \mathbf{u}\frac{\mathbf{u} \cdot \mathbf{t}}{u_z} - \mathbf{t}, \quad \mathbf{n}_{\text{blended}} = \frac{\mathbf{r}}{\|\mathbf{r}\|}$$
RNM guarantees unit vector conservation and prevents specular flattening at steep grazing angles.

### 2. Biophysical Laplacian Curvature Roughness
Discrete 2D surface Laplacian operator $\kappa = 4h(x, y) - \sum \text{neighbors}$ models physical surface contact:
$$\text{burnish} = \max(0, \kappa) \cdot \beta, \quad \text{dirt} = \max(0, -\kappa) \cdot \gamma$$
$$r = \text{clamp}(r_{\text{base}} + \text{variance} \cdot s - \text{burnish} + \text{dirt}, 0.04, 0.98)$$
Convex features ($\kappa > 0$) undergo handling wear and polish, while concave crevices ($\kappa < 0$) trap micro-particulate dust and grit.

### 3. Toksvig Specular Anti-Aliasing
At grazing distances, sub-texel normal variance causes destructive specular shimmering. The Toksvig filter measures local normal variance $s = \|\bar{\mathbf{n}}\|$ across a $3\times3$ kernel and folds roughness variance into the linear Beckmann/GGX roughness $\alpha$:
$$f_t = \frac{1 - s}{s} \cdot v_{\text{scale}}, \quad \alpha_{\text{toksvig}} = \sqrt{\frac{\alpha^2 + f_t}{1 + f_t}}$$

### 4. 8-Directional Radial Horizon Micro-Cavity HBAO
Computes contact shadows inside deep mortar recesses and window reveals by raymarching radial horizon angles across 8 directions up to a radius of 10 pixels:
$$\tan(\theta) = \frac{\Delta h}{r}, \quad \text{AO} = \text{clamp}\left(1.0 - \frac{I_{\text{hbao}}}{8}\sum_{i=1}^8 \max(0, \sin(\theta_i)), 0.05, 1.0\right)$$

### 5. 1D Scanline Spatial Autocorrelation for Periodicity Induction
Texture charts are analyzed without preset dictionaries using normalized spatial autocorrelation $R(\tau)$ along horizontal and vertical scanlines:
$$R(\tau) = \frac{1}{N \sigma^2}\sum_{x=0}^{N-\tau-1} (I(x) - \mu)(I(x + \tau) - \mu)$$
Detects fundamental masonry block width and height $(\lambda_x, \lambda_y)$, correlation length, and architectural module aspect ratio, dynamically parameterizing `KHR_texture_transform` repeats.

---

## 6. Verification Protocols

1. **Automated Unit Tests**:
   - Verify affine determinant non-degeneracy: `packages/core/test/algorithmic-uv-rewrap.test.ts`.
   - Verify material discrimination (foliage, asphalt, stone).
   - Verify Adaptive Domain biophysical material contract resolution with zero closed taxonomies.
   - Verify Reoriented Normal Mapping (RNM) blending unit length conservation.
   - Verify multi-frequency Scharr gradient normal synthesis.
   - Verify biophysical Laplacian curvature roughness differentiation ($\kappa > 0$ burnish vs $\kappa < 0$ cavity dirt).
   - Verify Toksvig specular anti-aliasing roughness adjustment.
   - Verify 8-directional radial horizon HBAO micro-cavity occlusion.
   - Verify 1D scanline spatial autocorrelation detecting architectural unit cell periodicity.
   - Verify 100% GLB header validity, `KHR_texture_transform` injection, and non-zero texture bufferViews.
2. **Visual Progress & Multimodal Evaluation**:
   - Inspect 2D texture atlas with 4x extreme micro-detail loupe across multiple architectural targets (`arch`, `cornice`, `masonry`).
   - Inspect 3D interactive viewports (`standingFacade`, `roadAndTrees`, `facadeTarget`) to verify tactile surface definition, crisp shadows, and zero geometric drift.
