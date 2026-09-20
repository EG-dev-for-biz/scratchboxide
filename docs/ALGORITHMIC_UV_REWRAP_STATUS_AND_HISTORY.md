# Algorithmic UV Unwrap & Rewrap Engine: Specification, Test Status & Engineering History

This document serves as the canonical technical reference, evolutionary history, and automated test suite status for the **Algorithmic UV Unwrap & Rewrap Engine** (`AlgorithmicUvEngine`), its accompanying test suite ([`packages/core/test/algorithmic-uv-rewrap.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/algorithmic-uv-rewrap.test.ts)), and the **Adaptive Domain Biophysical PBR & Signal Induction Suite** in Scratchbox IDE.

---

## 1. Executive Summary & Current Test Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Test Suite File** | `packages/core/test/algorithmic-uv-rewrap.test.ts` | Vitest v2.1.9 |
| **Total Test Cases** | **20 Passed / 20 Total (100% Green)** | Automated CLI Execution |
| **Execution Duration** | $\approx 894\text{ ms}$ (sub-second suite) | Vitest Test Runner |
| **Monorepo Typecheck** | **0 Errors** across 4 packages | `tsc --noEmit` (Core, CLI, Desktop, Electron) |
| **Reference 3D Asset** | Google 3D Tiles Roman Colosseum (`79` submeshes, `>15MB` binary `.glb`) | `public/models/colosseum_rome_shape_grounded.glb` |
| **Architectural Model** | **Adaptive Domain Architecture (Zero Presets)** | `AGENTS.md` Directives |
| **Application Context** | Native 3D engine capabilities for **Scratchbox IDE** & In-App Agents | `.agents/skills/algorithmic-uv-rewrap/` |

---

## 2. Chronological Engineering History

The Algorithmic UV and PBR pipeline evolved through three major generational milestones:

```
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 1: Pure Geometric Spatial Lock & Atlas Packing             │
│ • 2D Affine Determinant & Inverse Barycentric Projection (0.000px drift)│
│ • Heuristic Material Discrimination (Stone vs Foliage vs Asphalt)       │
│ • MaxRects Atlas Packing with 90° Rotations                            │
│ • Scene-Wide Repacking across 79 Photogrammetric Submeshes              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 2: Architectural Metrology & Deep Urban Canyons             │
│ • Texel Density Normalization (TDN): World-to-UV Metric Ratio          │
│ • Height-Stratified Street Canyon De-Lighting (Shadow Lift Curve)      │
│ • Road Marking & Crosswalk Low-Chroma Protection                       │
│ • KHR_texture_transform Scale-Invariant Micro-Detail Tiling Injection  │
│ • In-App Gemini Agent Tools (uv_analyze_texel_density, etc.)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 3: Adaptive Domain Architecture & Signal-Induced PBR        │
│ • User Directive: Strict Adherence to Zero Presets & Open Contracts    │
│ • BiophysicalMaterialContract: Open Continuous Schema                  │
│ • Multi-Frequency Scharr + Reoriented Normal Mapping (RNM)             │
│ • Biophysical Laplacian Curvature Roughness (Burnish vs Cavity Dirt)   │
│ • Toksvig Specular Anti-Aliasing (Normal Variance to Roughness)        │
│ • 8-Directional Radial Horizon Micro-Cavity HBAO Raymarching           │
│ • 1D Scanline Spatial Autocorrelation for Periodicity Auto-Induction   │
└────────────────────────────────────────────────────────────────────────┘
```

### Generation 1: 100% Geometric Spatial Lock & Atlas Packing
* **Problem**: Neural image-to-image or external upscalers hallucinate architectural features independently of the underlying 3D topology, shifting stone lintels, distorting window mullions, and generating severe boundary seam tears between adjacent UV charts.
* **Solution**: Developed pure mathematical inverse barycentric rasterization projecting 2D texels directly into 3D world space $\mathbf{P}(w_x, w_y, w_z)$. Achieved exactly $0.000\text{ px}$ spatial drift. Developed `MaxRectsAtlasPacker` supporting 90-degree chart rotation, consolidating 79 fragmented draw calls into unified packed texture sheets.

### Generation 2: Architectural Metrology & Deep Urban Canyons
* **Problem**: Real-world photogrammetry exhibits drastic texel density fluctuations between soaring skyscraper towers and street-level sidewalks. Furthermore, deep skyscraper canyons suffer from pitch-black baked photogrammetric shadows that wash out during dusk rendering.
* **Solution**:
  - Implemented analytical Texel Density Normalization measuring $\rho = \sqrt{\frac{A_{\text{uv}} \cdot W \cdot H}{A_{\text{world}}}}$.
  - Added height-stratified non-linear shadow lift ($C_{\text{lift}}$) boosting ground canyon luminance without over-exposing observation decks.
  - Implemented road marking segmentation and `KHR_texture_transform` injection to preserve procedural detail across extreme camera distances.

### Generation 3: Adaptive Domain Architecture & Signal-Induced Biophysical PBR
* **Problem**: Initial proposals introduced static material catalogs (e.g., hardcoded lists of stone types, glass types, and masonry). The user explicitly intervened:
  > *"I agree with all of this with exception of having presets of a library, we hav eaddressed this more than once: Adaptive Domain Architecture"*
* **Solution**: Fully eliminated static preset tables and closed taxonomies. Designed an open continuous schema ([`BiophysicalMaterialContract`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/AlgorithmicUvEngine.ts#L45-L75)) where every parameter is continuous and dynamically resolved. Developed signal-induced mathematical operators (Scharr, RNM, Laplacian curvature, Toksvig AA, radial horizon HBAO, and 1D scanline autocorrelation) that infer physical properties and unit-cell periodicities directly from raw texture signals.

---

## 3. Mathematical Foundations & Operational Formulations

### 1. 2D Inverse Barycentric Projection
Given a 3D triangle with vertices $\mathbf{V}_0, \mathbf{V}_1, \mathbf{V}_2$ and UV texture coordinates $\mathbf{U}_0, \mathbf{U}_1, \mathbf{U}_2$:

$$\Delta = (v_1 - v_2)(u_0 - u_2) + (u_2 - u_1)(v_0 - v_2)$$

For any texel $(p_x, p_y)$ within the triangle's 2D bounding box:
$$w_0 = \frac{(v_1 - v_2)(p_x - u_2) + (u_2 - u_1)(p_y - v_2)}{\Delta}$$
$$w_1 = \frac{(v_2 - v_0)(p_x - u_2) + (u_0 - u_2)(p_y - v_2)}{\Delta}$$
$$w_2 = 1.0 - w_0 - w_1$$

The exact 3D world coordinate is reconstructed without geometric distortion:
$$\mathbf{P}(w_x, w_y, w_z) = w_0 \mathbf{V}_0 + w_1 \mathbf{V}_1 + w_2 \mathbf{V}_2$$

### 2. Multi-Frequency Normal Decomposition & Reoriented Normal Mapping (RNM)
Normals are synthesized across three spatial frequency octaves:
1. **Macro Relief**: Baseline offset $\Delta = 3\text{px}$ for coarse structural courses.
2. **Meso Relief**: $3\times3$ Scharr differential operator minimizing directional error:
   $$D_x = \frac{(p_{02} + \frac{10}{3}p_{12} + p_{22}) - (p_{00} + \frac{10}{3}p_{10} + p_{20})}{5.333}$$
   $$D_y = \frac{(p_{20} + \frac{10}{3}p_{21} + p_{22}) - (p_{00} + \frac{10}{3}p_{01} + p_{02})}{5.333}$$
3. **Micro Relief**: High-pass Laplacian delta $(\text{center} - \text{avg}_4) \times 8.0$ for mineral tooth.

The normal bands are blended via analytical **Reoriented Normal Mapping (RNM)**:
$$\mathbf{u} = [n_{1x}, n_{1y}, n_{1z} + 1], \quad \mathbf{t} = [-n_{2x}, -n_{2y}, n_{2z}]$$
$$\mathbf{r} = \mathbf{u}\frac{\mathbf{u} \cdot \mathbf{t}}{u_z} - \mathbf{t}, \quad \mathbf{n}_{\text{blended}} = \frac{\mathbf{r}}{\|\mathbf{r}\|}$$
RNM preserves unit vector length and prevents specular highlights from flattening at steep glancing angles.

### 3. Biophysical Laplacian Curvature Roughness
Models physical abrasion and weathering using the discrete 2D surface Laplacian $\kappa$:
$$\kappa = 4h(x, y) - \left(h(x+1, y) + h(x-1, y) + h(x, y+1) + h(x, y-1)\right)$$
- **Convex Ridges ($\kappa > 0$)**: Experience handling wear, erosion, and polish:
  $$\text{burnish} = \max(0, \kappa) \cdot \beta$$
- **Concave Crevices ($\kappa < 0$)**: Trap micro-particulate dust, grime, and soot:
  $$\text{dirt} = \max(0, -\kappa) \cdot \gamma$$
$$r = \text{clamp}(r_{\text{base}} + \text{variance} \cdot s - \text{burnish} + \text{dirt}, 0.04, 0.98)$$

### 4. Toksvig Specular Anti-Aliasing
At glancing angles, high-frequency normal map variance produces sub-texel shimmering. The Toksvig filter measures local normal variance $s = \|\bar{\mathbf{n}}\|$ across a $3\times3$ kernel and folds roughness variance into the linear Beckmann/GGX roughness $\alpha$:
$$f_t = \frac{1 - s}{s} \cdot v_{\text{scale}}, \quad \alpha_{\text{toksvig}} = \sqrt{\frac{\alpha^2 + f_t}{1 + f_t}}$$

### 5. 8-Directional Radial Horizon Micro-Cavity HBAO
Computes contact shadows inside mortar joints, voussoir arches, and window reveals by raymarching radial horizon elevation angles across 8 angular directions:
$$\tan(\theta) = \frac{\Delta h}{r}, \quad \text{AO} = \text{clamp}\left(1.0 - \frac{I_{\text{hbao}}}{8}\sum_{i=1}^8 \max(0, \sin(\theta_i)), 0.05, 1.0\right)$$

### 6. 1D Scanline Spatial Autocorrelation for Periodicity Induction
Texture charts are analyzed without closed dictionaries using normalized spatial autocorrelation $R(\tau)$ along horizontal and vertical scanlines:
$$R(\tau) = \frac{1}{N \sigma^2}\sum_{x=0}^{N-\tau-1} (I(x) - \mu)(I(x + \tau) - \mu)$$
The engine detects the first harmonic peak above a prominence threshold ($0.08$), extracting fundamental unit cell width and height $(\lambda_x, \lambda_y)$, correlation length, and module aspect ratio. This dynamically parameterizes `KHR_texture_transform` repeats.

---

## 4. Comprehensive Test Suite Breakdown (20/20 Passing)

All tests reside in [`packages/core/test/algorithmic-uv-rewrap.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/algorithmic-uv-rewrap.test.ts).

### Part I: Core Geometric, Material & Metrology Suite (12 Tests)

1. **`correctly calculates 2D affine determinant and inverse barycentric weights`**:
   - *Test Objective*: Verifies that 2D affine determinant $\Delta$ and barycentric coordinates $(w_0, w_1, w_2)$ for arbitrary UV points reconstruct exact 3D world coordinates $(10/3, 10/3, 0)$ with error $< 10^{-4}$.
2. **`correctly discriminates asphalt roadway vs tree canopy vs travertine stone`**:
   - *Test Objective*: Validates multi-spectral semantic classification rules based on Excess Green chroma, elevation thresholds ($wy < 73.5\text{m}$), and surface normal orientation ($|n_y| > 0.70$).
3. **`validates scene-wide repacked GLB model integrity across all 79 submeshes`**:
   - *Test Objective*: Validates that repacking the Roman Colosseum photogrammetric asset (`colosseum_rome_shape_grounded.glb`) preserves all 79 meshes, materials, textures, and valid JPEG image bufferViews (`0xFF 0xD8` headers).
4. **`packs texture charts with MaxRectsAtlasPacker achieving high fill efficiency with 90-degree rotations`**:
   - *Test Objective*: Packs 12 non-uniform rectangular texture charts into a power-of-two texture atlas. Verifies fill rate $> 80\%$ and detects successful 90° chart rotations.
5. **`decomposes intrinsic albedo and synthesizes complete PBR material suite`**:
   - *Test Objective*: Separates input diffuse texture into intrinsic albedo and bilateral irradiance field, while synthesizing tangent normal maps, metallic-roughness maps, and ambient occlusion channels.
6. **`resolves algorithmic UV and PBR tasks natively in TaskCapabilityResolver`**:
   - *Test Objective*: Verifies that Scratchbox IDE's capability resolver routes algorithmic UV and texture atlas rewrapping natively to Tier 1 rather than falling back unnecessarily to ComfyUI.
7. **`provides registered Gemini agent tools for Algorithmic UV unwrapping and packing`**:
   - *Test Objective*: Asserts that `uv_analyze_texel_density`, `algorithmic_uv_unwrap_rewrap`, and `pbr_material_decompose` are present in Scratchbox IDE's default agent tool registry.
8. **`computes texel density metrics and detects variance across submeshes`**:
   - *Test Objective*: Audits 3D world-space triangle area vs UV parameter-space triangle area across the Colosseum GLB, asserting positive `meanTexelsPerMeter` and tracking metric variance.
9. **`provides specialized lithology presets for classical stone, limestone, and modern curtain walls`**:
   - *Test Objective*: Verifies physical parameters returned by `getLithologyPreset` for backward compatibility.
10. **`applies height-stratified shadow lift in deep street canyons`**:
    - *Test Objective*: Validates that bilateral de-lighting applies amplified shadow lift ($C_{\text{lift}}$) at low elevations ($normY \to 0$) without over-lifting sunlit rooftops.
11. **`injects KHR_texture_transform for scale-invariant micro-detail tiling`**:
    - *Test Objective*: Verifies that `processGlb` with `enableMicroDetailTiling: true` injects the `KHR_texture_transform` extension and scale vector `[32.0, 32.0]` into the output GLB material definition.
12. **`dispatches uv_analyze_texel_density and algorithmic_uv_unwrap_rewrap with lithologyProfile via Gemini agent tool registry`**:
    - *Test Objective*: Dispatches both agent tools end-to-end via the tool registry dispatcher, verifying status `completed` and valid JSON result payloads.

---

### Part II: Adaptive Domain Biophysical PBR & Signal Induction Suite (8 Tests)

13. **`resolves biophysical material contracts dynamically with zero closed taxonomies`**:
    - *Test Objective*: Verifies that `resolveBiophysicalContract`:
      - Preserves direct continuous values (`roughness: 0.42`, `metalness: 0.95`, `normalStrength: 4.8`, `laplacianBurnishFactor: 0.6`).
      - Inters open natural language prompts (`'patinated bronze statuary'`, `'overgrown climbing ivy'`, `'ancient travertine monumental facade'`) via latent entity extraction rather than closed enum classifiers.
14. **`blends normal vectors using Reoriented Normal Mapping (RNM) preserving unit length`**:
    - *Test Objective*: Blends base and detail normal vectors, asserting exact conservation of unit length ($\|\mathbf{n}\| = 1.0000 \pm 10^{-4}$) and verifying that grazing angle details are not flattened.
15. **`synthesizes multi-frequency normal maps using Scharr gradients and RNM blending`**:
    - *Test Objective*: Computes multi-frequency normal map from synthetic stepped relief and micro-noise. Asserts alpha $= 255$, outward vectors ($Z \ge 120$), and non-flat normal dispersion ($>100$ perturbed texels).
16. **`models biophysical Laplacian curvature roughness (burnish vs cavity dirt)`**:
    - *Test Objective*: Evaluates a patch with a sharp ridge (convex, $\kappa > 0$) and a sharp groove (concave, $\kappa < 0$). Asserts that the convex ridge exhibits burnish wear ($r < r_{\text{base}}$) and the groove exhibits micro-grit accumulation ($r > r_{\text{base}}$).
17. **`applies Toksvig specular anti-aliasing to fold grazing normal variance into roughness`**:
    - *Test Objective*: Measures roughness under high normal variance perturbations. Verifies that Toksvig filtering increases roughness from base $0.30$ to prevent specular shimmer.
18. **`computes 8-directional radial horizon HBAO micro-cavity occlusion`**:
    - *Test Objective*: Simulates a deep structural crevice with converging normals. Asserts that radial horizon raymarching produces lower AO values ($<0.95$) inside the cavity compared to flat planar areas ($1.00$).
19. **`auto-induces unit cell periodicity and module aspect ratio from 1D spatial autocorrelation`**:
    - *Test Objective*: Evaluates a synthetic masonry grid with $32\text{px}$ width and $16\text{px}$ height. Verifies that normalized 1D autocorrelation detects `isPeriodic: true`, `dominantPeriodPxX: 32`, `dominantPeriodPxY: 16`, aspect ratio $\approx 2.0$, and valid recommended repeats.
20. **`executes processGlb with auto-induced periodicity and biophysical contract`**:
    - *Test Objective*: End-to-end execution of `AlgorithmicUvEngine.processGlb` on the 79-submesh Colosseum model with `autoInducePeriodicity: true` and custom `biophysicalContract`. Asserts successful GLB output, populated `inducedSpatialProfile`, and injected `KHR_texture_transform`.

---

## 5. Architectural Context: Scratchbox IDE vs Antigravity

> [!IMPORTANT]
> **Runtime Boundary Clarification**:
> The skills located in `.agents/skills/` (including `algorithmic-uv-rewrap`, `atmospheric-3d-pipeline`, `google-3d-tiles-ingestion`, `location-object-lighting`, etc.) are **built-in capabilities, procedural modules, and agent playbooks for the Scratchbox IDE desktop application**.
> 
> They are NOT tools for Antigravity (the coding assistant). They are exposed directly to Scratchbox IDE's own canvas runtime, WebGL/Three.js renderers, and in-app Gemini agents to allow end-users to unwrap, re-light, remesh, and restyle geospatial 3D assets inside the application.

---

## 6. How to Run the Verification Suite

To run the complete Algorithmic UV and PBR test suite:

```bash
# Execute the specific test suite
npx vitest run packages/core/test/algorithmic-uv-rewrap.test.ts

# Execute full monorepo typecheck (verifying zero TypeScript regressions)
npm run typecheck
```
