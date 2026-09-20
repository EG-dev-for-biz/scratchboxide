# VFX Professional Optical Lens Distortion Engine: Specification, Verification Status & Engineering History

This document serves as the canonical technical reference, evolutionary history, mathematical foundation, and automated test suite status for the **VFX Professional Optical Lens Distortion Engine** in Scratchbox IDE.

It covers the high-order optical models, analytical 2D Jacobian Newton-Raphson solvers, VFX studio interchange protocols (3DEqualizer 4, Foundry Nuke, OpenCV, STMap), sub-pixel matchmove anti-drift integration, WebGL multi-mode shaders, and production Gemini agent tools.

---

## 1. Executive Summary & Current Test Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Primary Test Suite** | `packages/core/test/lens-distortion-vfx-standards.test.ts` | Vitest v2.1.9 (19/19 Passed) |
| **Pass & Uniforms Suite** | `packages/core/test/lens-distortion-effect.test.ts` | Vitest v2.1.9 (15/15 Passed) |
| **Matchmove Integration** | `packages/core/test/precision-camera-matchmove-integration.test.ts` | Vitest v2.1.9 (5/5 Passed) |
| **Spatial Resection Suite** | `packages/core/test/spatial-resection-agent-tools.test.ts` | Vitest v2.1.9 (10/10 Passed) |
| **Total Test Cases** | **49 Passed / 49 Total (100% Green)** | Automated CLI Execution |
| **Monorepo Typecheck** | **0 Errors** across all packages | `npx tsc --noEmit -p packages/core` |
| **Supported Models** | 8th-Order Brown-Conrady, 3DE4 Anamorphic Deg 4, Kannala-Brandt Fisheye, OpenCV Rational | Mathematical Implementations |
| **Studio Interchange** | 3DEqualizer 4 (`.lens`), Foundry Nuke 15 (`.nk`), OpenCV ($K, D$), STMap (Float32Array) | `VfxLensInterchangeService` |
| **Inversion Precision** | **$< 10^{-7}$ coordinate residual error** | Analytical 2D Newton-Raphson |
| **Matchmove Drift** | **$< 0.01\text{ px}$ verified tracking drift** | Optical Distortion Feature Projection |
| **Compositing Integrity** | **Transparent edge padding & Overscan calculation** | `Video3DLayerRenderer` + WebGL Pass |

---

## 2. Chronological Engineering History

The lens distortion engine in Scratchbox IDE evolved through three distinct generational milestones:

```
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 1: Viewport Post-Processing Pass (Original Baseline)        │
│ • Low-Order Brown-Conrady approximation (k1, k2, p1, p2 only)           │
│ • Single-iteration approximate inverse warp                            │
│ • Fixed letterbox black borders (caused dark fringes when compositing) │
│ • No interchange with VFX matchmoving software (Nuke, 3DEqualizer)     │
│ • Synthetic preset profiles without physical millimeter optical links  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 2: Precision Resection & Matchmoving Integration            │
│ • 6-DOF camera solve trajectory matching (VfxPlateMatchmoveService)    │
│ • Sub-pixel edge alignment optimizer (SubPixelEdgeAlignmentOptimizer)   │
│ • Discovery of False Drift: linear 3D projections on wide-angle lenses  │
│   appeared non-stationary, registering false drift on curved lenses    │
│ • Need identified for bidirectional optical coordinates & overscan     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ GENERATION 3: Professional VFX Studio Standards (Current Milestone)    │
│ • 8th-Order Radial Polynomial (k1, k2, k3, k4) + Decentering (p1, p2)   │
│ • 3DEqualizer 4 Anamorphic Degree 4 & Kannala-Brandt Fisheye Models    │
│ • Analytical 2D Damped Newton-Raphson Solver with Exact 2x2 Jacobian   │
│ • Sub-Pixel Drift Elimination in matchmoving (< 0.01px drift)          │
│ • VfxLensInterchangeService: 3DEqualizer .lens, Nuke .nk, OpenCV, STMap│
│ • Multi-Mode WebGL Shader (Undistort, Redistort, STMap, 16-tap Bicubic)│
│ • Transparent Edge Padding & Analytical Overscan Margin Calculation    │
│ • Joint Camera Pose & Lens Distortion Resection Parameter Descent      │
│ • Production Gemini Agent Tools (optics_configure & optics_export)     │
└────────────────────────────────────────────────────────────────────────┘
```

### Generation 1: Viewport Post-Processing Pass (Original Baseline)
* **Architecture**: Implemented as a basic Three.js screen-space post-processing shader pass (`LensDistortionEffect`).
* **Limitations**:
  - Handled only 4th-order radial terms ($k_1, k_2$) and tangential parameters ($p_1, p_2$).
  - Inverse undistortion was an approximate forward inversion with 1 fixed step, which diverged significantly near frame borders on wide-angle optics ($f < 20\text{mm}$).
  - Out-of-bounds sampling filled borders with solid black (`letterboxColor`), corrupting downstream WebGL layer compositing when overlaying 3D synthetic assets on live-action footage.
  - Zero support for industry-standard interchange formats (3DEqualizer `.lens` files, Foundry Nuke `.nk` scripts, or OpenCV camera matrices).
  - No physical connection between millimeters (focal length, sensor size) and dimensionless polynomial coefficients.

### Generation 2: Precision Resection & Matchmoving Integration
* **Architecture**: Integrated with the 6-DOF camera solve matchmoving engine (`VfxPlateMatchmoveService`) and the sub-pixel edge alignment optimizer (`SubPixelEdgeAlignmentOptimizer`).
* **The "False Drift" Problem**:
  - In matchmoving, feature markers tracked across video plates are compared against projected 3D world points.
  - Because camera solve paths reprojected points using ideal pinhole perspective matrices, wide-angle lenses produced apparent feature drift ($\ge 0.5\text{px}$ to $2.0\text{px}$) near the edges of the frame—even when the camera trajectory was mathematically locked.
  - The matchmove optimizer was improperly attempting to compensate for optical distortion by rotating the camera.

### Generation 3: Professional VFX Studio Standards (Current Milestone)
* **Initiative**: Comprehensive evaluation against professional VFX standards (Foundry Nuke, 3DEqualizer, OpenCV, ILM/Weta digital optical pipelines) followed by full development of all recommendations.
* **Key Innovations**:
  1. **8th-Order Polynomials & Dedicated Lens Models**: Added $k_3, k_4$, 3DEqualizer 4 Anamorphic Degree 4 ($c_{20}, c_{02}, c_{40}, c_{22}, c_{04}$), and Kannala-Brandt fisheye ($fisheyeK_1 \dots fisheyeK_4$).
  2. **Analytical 2D Damped Newton-Raphson Solver**: Replaced heuristics with an exact analytical matrix Jacobian inversion ($\mathbf{J}^{-1} \mathbf{R}$) with Armijo line-search step damping, guaranteeing sub-pixel convergence ($< 10^{-7}$ coordinate residual error).
  3. **Optical Matchmove Anti-Drift**: Projected 3D feature rays through forward distortion before drift evaluation, eliminating false optical drift and proving $< 0.01\text{px}$ drift on verified trajectories.
  4. **Full VFX Interchange**: Implemented `VfxLensInterchangeService` generating 3DEqualizer 4 `.lens` files (with round-trip parsing), Foundry Nuke 15 `LensDistortion2` scripts and Python automation, OpenCV $K$ and $D$ matrices, and 32-bit float STMap buffers.
  5. **Compositing-Ready Post-Processing**: Created a multi-mode GLSL shader supporting forward undistortion, GPU-side Newton-Raphson redistortion, STMap UV visualization, 16-tap Catmull-Rom bicubic filtering, and transparent edge padding.
  6. **Joint Camera Pose & Lens Resection**: Integrated $k_1$ parameter coordinate descent into the closed-loop edge alignment optimizer.
  7. **Agent Tools**: Registered `optics_configure_lens_distortion` and `optics_export_lens_distortion` with two-tier resolution.

---

## 3. Mathematical Foundations & Optical Formulations

### 1. 8th-Order Brown-Conrady Forward Distortion
Given normalized camera coordinates $(x_u, y_u)$ with optical center $(c_x, c_y)$ and anamorphic squeeze $S$:

$$\tilde{x} = \frac{x_u - c_x}{S}, \quad \tilde{y} = y_u - c_y$$
$$r^2 = \tilde{x}^2 + \tilde{y}^2$$

The high-order radial distortion factor $L(r)$ is:
$$L(r) = 1 + k_1 r^2 + k_2 r^4 + k_3 r^6 + k_4 r^8$$

The tangential decentering distortion vector $\mathbf{T} = [T_x, T_y]^T$ is:
$$T_x = 2 p_1 \tilde{x} \tilde{y} + p_2 (r^2 + 2 \tilde{x}^2)$$
$$T_y = p_1 (r^2 + 2 \tilde{y}^2) + 2 p_2 \tilde{x} \tilde{y}$$

The distorted coordinate $(x_d, y_d)$ is:
$$x_d = c_x + S \cdot (\tilde{x} \cdot L(r) + T_x)$$
$$y_d = c_y + (\tilde{y} \cdot L(r) + T_y)$$

---

### 2. Analytical 2D Damped Newton-Raphson Inversion
To invert distorted coordinates $(x_d, y_d)$ back to ideal undistorted coordinates $(x_u, y_u)$, we solve the non-linear root-finding problem:

$$\mathbf{F}(\mathbf{x}) = \mathbf{f}(\mathbf{x}) - \mathbf{x}_d = \mathbf{0}$$

Where $\mathbf{x} = [\tilde{x}, \tilde{y}]^T$. The iterative Newton-Raphson update step is:

$$\mathbf{x}_{n+1} = \mathbf{x}_n - \alpha \cdot \mathbf{J}^{-1}(\mathbf{x}_n) \cdot \mathbf{F}(\mathbf{x}_n)$$

The exact $2 \times 2$ analytical Jacobian matrix $\mathbf{J} = \begin{bmatrix} J_{xx} & J_{xy} \\ J_{yx} & J_{yy} \end{bmatrix}$ is formulated without finite-difference approximations:

$$\frac{\partial r^2}{\partial \tilde{x}} = 2 \tilde{x}, \quad \frac{\partial r^2}{\partial \tilde{y}} = 2 \tilde{y}$$
$$\frac{\partial L}{\partial r^2} = k_1 + 2 k_2 r^2 + 3 k_3 r^4 + 4 k_4 r^6$$
$$\frac{\partial L}{\partial \tilde{x}} = 2 \tilde{x} \frac{\partial L}{\partial r^2}, \quad \frac{\partial L}{\partial \tilde{y}} = 2 \tilde{y} \frac{\partial L}{\partial r^2}$$

Partial derivatives of radial displacement:
$$\frac{\partial (\tilde{x} L)}{\partial \tilde{x}} = L + 2 \tilde{x}^2 \frac{\partial L}{\partial r^2}, \quad \frac{\partial (\tilde{x} L)}{\partial \tilde{y}} = 2 \tilde{x} \tilde{y} \frac{\partial L}{\partial r^2}$$
$$\frac{\partial (\tilde{y} L)}{\partial \tilde{x}} = 2 \tilde{x} \tilde{y} \frac{\partial L}{\partial r^2}, \quad \frac{\partial (\tilde{y} L)}{\partial \tilde{y}} = L + 2 \tilde{y}^2 \frac{\partial L}{\partial r^2}$$

Partial derivatives of tangential displacement:
$$\frac{\partial T_x}{\partial \tilde{x}} = 2 p_1 \tilde{y} + 6 p_2 \tilde{x}, \quad \frac{\partial T_x}{\partial \tilde{y}} = 2 p_1 \tilde{x} + 2 p_2 \tilde{y}$$
$$\frac{\partial T_y}{\partial \tilde{x}} = 2 p_1 \tilde{x} + 2 p_2 \tilde{y}, \quad \frac{\partial T_y}{\partial \tilde{y}} = 6 p_1 \tilde{y} + 2 p_2 \tilde{x}$$

Combining terms:
$$J_{xx} = L + 2 \tilde{x}^2 \frac{\partial L}{\partial r^2} + 2 p_1 \tilde{y} + 6 p_2 \tilde{x}$$
$$J_{xy} = 2 \tilde{x} \tilde{y} \frac{\partial L}{\partial r^2} + 2 p_1 \tilde{x} + 2 p_2 \tilde{y}$$
$$J_{yx} = 2 \tilde{x} \tilde{y} \frac{\partial L}{\partial r^2} + 2 p_1 \tilde{x} + 2 p_2 \tilde{y}$$
$$J_{yy} = L + 2 \tilde{y}^2 \frac{\partial L}{\partial r^2} + 6 p_1 \tilde{y} + 2 p_2 \tilde{x}$$

The inverse is evaluated directly via determinant:
$$\det(\mathbf{J}) = J_{xx} J_{yy} - J_{xy} J_{yx}$$
$$\mathbf{J}^{-1} = \frac{1}{\det(\mathbf{J})} \begin{bmatrix} J_{yy} & -J_{xy} \\ -J_{yx} & J_{xx} \end{bmatrix}$$

Step damping $\alpha \in \{1.0, 0.5, 0.25\}$ with Armijo condition ensures monotonicity and eliminates overshoot near frame boundaries.

---

### 3. 3DEqualizer 4 Anamorphic Standard Degree 4 Model
For anamorphic lenses, distortion varies non-isotropically between horizontal and vertical axes:

$$\tilde{x} = \frac{x_u - c_x}{S}, \quad \tilde{y} = y_u - c_y$$
$$\Delta x = \tilde{x} \cdot (c_{20} \tilde{x}^2 + c_{02} \tilde{y}^2 + c_{40} \tilde{x}^4 + c_{22} \tilde{x}^2 \tilde{y}^2 + c_{04} \tilde{y}^4)$$
$$\Delta y = \tilde{y} \cdot (c_{20} \tilde{x}^2 + c_{02} \tilde{y}^2 + c_{40} \tilde{x}^4 + c_{22} \tilde{x}^2 \tilde{y}^2 + c_{04} \tilde{y}^4)$$
$$x_d = c_x + S \cdot (\tilde{x} + \Delta x), \quad y_d = c_y + (\tilde{y} + \Delta y)$$

---

### 4. Kannala-Brandt Fisheye Model
For ultra-wide action cameras and drones ($\text{FOV} > 120^\circ$):

$$r = \sqrt{\tilde{x}^2 + \tilde{y}^2}$$
$$\theta = \text{atan2}(r, 1.0)$$
$$d(\theta) = \theta + k_1 \theta^3 + k_2 \theta^5 + k_3 \theta^7 + k_4 \theta^9$$

The distorted radius $r_d$ is:
$$r_d = d(\theta)$$
$$x_d = c_x + S \cdot \frac{\tilde{x}}{r} \cdot r_d, \quad y_d = c_y + \frac{\tilde{y}}{r} \cdot r_d$$

Inversion is accomplished via 1D Newton-Raphson solving for $\theta$ from $r_d$ using the exact derivative:
$$d'(\theta) = 1 + 3 k_1 \theta^2 + 5 k_2 \theta^4 + 7 k_3 \theta^6 + 9 k_4 \theta^8$$

---

### 5. Bidirectional Overscan Margin Formulation
Undistortion stretches corners outward, clipping peripheral pixels if rendered within standard canvas bounds. The engine computes the analytical overscan expansion factor $M$:

Corners tested: $\mathbf{C} \in \{(\pm 1, \pm 1), (\pm 1, 0), (0, \pm 1)\}$.
For each corner $\mathbf{p}$:
$$\mathbf{p}_{\text{undist}} = \text{undistortPoint}(\mathbf{p})$$
$$s_x = |\mathbf{p}_{\text{undist}, x}|, \quad s_y = |\mathbf{p}_{\text{undist}, y}|$$
$$M = \max(1.0, \max_{\mathbf{p}}(s_x, s_y))$$
$$\text{overscanPercent} = (M - 1.0) \times 100$$
$$\text{paddedWidth} = \lceil W \cdot M \rceil, \quad \text{paddedHeight} = \lceil H \cdot M \rceil$$

---

## 4. VFX Studio Interchange Formats

### 1. 3DEqualizer 4 (`.lens`) Specification
Exported and parsed via `VfxLensInterchangeService.export3DEqualizerLensFile` and `parse3DEqualizerLensFile`:

```text
# 3DEqualizer Lens Profile File
# Exported by Scratchbox IDE VfxLensInterchangeService
distortion_model 3de4_radial_standard_degree_4
focal_length 24.000000
film_width 36.000000
film_height 24.000000
film_aspect_ratio 1.500000
lens_center_offset_x 0.000000
lens_center_offset_y 0.000000
squeeze_factor 1.000000
c02 -0.06500000
c04 0.01200000
c06 -0.00150000
c08 0.00020000
p1 0.00000000
p2 0.00000000
```

For anamorphic lenses, the model identifier switches to `3de4_anamorphic_standard_degree_4` with parameters `c20`, `c02`, `c40`, `c22`, `c04`.

### 2. Foundry Nuke 15 (`.nk`) Script & Python Automation
Exported via `VfxLensInterchangeService.exportNukeLensDistortionScript`:

```tcl
LensDistortion2 {
 inputs 1
 distortionModel "Brown-Conrady"
 output "Undistort"
 distortion1 -0.065
 distortion2 0.012
 distortionCenter {0 0}
 anamorphicSqueeze 1
 preserveBBox true
 name LensDistortion_Scratchbox
 selected true
}
```

Accompanying Python automation snippet:
```python
import nuke
node = nuke.nodes.LensDistortion2()
node['distortionModel'].setValue('Brown-Conrady')
node['distortion1'].setValue(-0.065)
node['distortion2'].setValue(0.012)
node['output'].setValue('Undistort')
```

### 3. OpenCV Camera Calibration Contract
Exported via `VfxLensInterchangeService.exportOpenCvCameraMatrix`:

$$\mathbf{K} = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}, \quad \mathbf{D} = [k_1, k_2, p_1, p_2, k_3, k_4, k_5, k_6]$$

Where:
$$f_x = \frac{\text{focalLengthMm}}{\text{sensorWidthMm}} \cdot W \cdot S$$
$$f_y = \frac{\text{focalLengthMm}}{\text{sensorHeightMm}} \cdot H$$
$$c_x = c_{\text{optical}, x} \cdot W, \quad c_y = c_{\text{optical}, y} \cdot H$$

### 4. 32-Bit Float STMap UV Pipeline
Generated via `LensDistortionEffect.generateSTMap(width, height)`:
- Returns a 2-channel `Float32Array` containing absolute normalized $(u, v) \in [0.0, 1.0]$ coordinates.
- Format matches Foundry Nuke `STMap` node expectations where Red channel $= U$ coordinate and Green channel $= V$ coordinate.
- Allows VFX compositors to bake distortion once and apply it across thousands of EXR frames with zero runtime overhead.

---

## 5. WebGL Post-Processing Pass Architecture

The upgraded `LensDistortionEffect` ([`LensDistortionEffect.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/optics/LensDistortionEffect.ts)) operates as a multi-mode GPU shader pass:

```mermaid
graph LR
    Input[Input Texture / Render Buffer] --> Pass[LensDistortionEffect Pass]
    Pass --> Uniforms[Uniforms: k1-k4, p1-p2, mode, filterQuality, edgeMode]
    Uniforms --> Mode{Shader Mode}
    Mode -->|mode = 0| Undistort[Forward Undistortion Warp]
    Mode -->|mode = 1| Redistort[GPU Newton-Raphson Inverse Warp]
    Mode -->|mode = 2| STMap[STMap UV Generation Pass]
    Undistort & Redistort --> Filter{Filter Quality}
    Filter -->|Bilinear| Bilerp[Fast 4-Tap Texture Sample]
    Filter -->|Bicubic| Bicubic[16-Tap Catmull-Rom Hermite Spline]
    Bilerp & Bicubic --> Edge{Edge Mode}
    Edge -->|Letterbox| Black[Solid Border Color]
    Edge -->|Transparent| Alpha[vec4 0,0,0,0 Zero Alpha]
    Alpha --> Output[VFX Layer Composite]
```

### GLSL Uniform Contract
| Uniform | Type | Purpose |
| :--- | :--- | :--- |
| `tDiffuse` | `sampler2D` | Scene or video plate input texture |
| `k1, k2, k3, k4` | `float` | Radial distortion polynomial coefficients |
| `p1, p2` | `float` | Tangential decentering coefficients |
| `opticalCenter` | `vec2` | Calibrated optical axis in normalized UV space |
| `aspectRatio` | `float` | Display aspect ratio ($W/H$) |
| `anamorphicSqueeze` | `float` | Lens squeeze factor ($1.0$ spherical, $2.0$ cinema anamorphic) |
| `chromaticAberration` | `float` | Spectral lateral chromatic dispersion ($\Delta r$ between R & B) |
| `mode` | `int` | $0 =$ Undistort, $1 =$ Redistort (Newton-Raphson), $2 =$ STMap |
| `edgeMode` | `int` | $0 =$ Letterbox border, $1 =$ Transparent border (`vec4(0.0)`) |
| `filterQuality` | `int` | $0 =$ Bilinear, $1 =$ Catmull-Rom 16-tap Bicubic |
| `letterboxColor` | `vec4` | Border color when `edgeMode = 0` |
| `enabled` | `bool` | Passthrough bypass switch |

---

## 6. Automated Test Suite Matrix & Verification

### Suite 1: VFX Standards Verification (`lens-distortion-vfx-standards.test.ts`)
Run: `npx vitest run packages/core/test/lens-distortion-vfx-standards.test.ts`
All **19 tests pass** with zero errors:

| Test Group | Test Case | Assertion Criteria | Result |
| :--- | :--- | :--- | :--- |
| **1. Analytical Inversion** | Forward & Inverse Round-Trip | $\Delta < 10^{-6}$ at $r=0.2$, $\Delta < 10^{-5}$ at $r=0.7$ | **PASS** |
| | Convergence on Extreme Barrel | Converges at $k_1 = -0.22$ within 10 iterations | **PASS** |
| | Higher-Order Radial Terms | $k_3, k_4$ contribute significantly at frame corners | **PASS** |
| | 3DEqualizer 4 Anamorphic Deg 4 | Asymmetric X and Y radial displacement verified | **PASS** |
| | Kannala-Brandt Fisheye | Sub-pixel convergence with 1D Newton-Raphson | **PASS** |
| **2. VFX Interchange** | 3DEqualizer 4 `.lens` Export | Correct headers, float formatting, and coefficients | **PASS** |
| | 3DEqualizer 4 Round-Trip Parse | Parses `.lens` file back into identical typed object | **PASS** |
| | 3DEqualizer 4 Anamorphic Export | Exports `3de4_anamorphic_standard_degree_4` syntax | **PASS** |
| | Foundry Nuke 15 `.nk` Script | Valid `LensDistortion2` block and Python script | **PASS** |
| | OpenCV Intrinsic Camera Matrix | Correct $f_x, f_y, c_x, c_y$ and 8-element $D$ vector | **PASS** |
| | STMap Raw Float32Array Export | Accurate buffer size ($W \times H \times 2$) and $[0, 1]$ bounds | **PASS** |
| | Focal Length to Brown-Conrady | Physically realistic coefficients for 14mm, 24mm, 85mm | **PASS** |
| **3. Overscan Margins** | Analytical Margin Calculation | Returns $> 5\%$ for wide-angle and $< 0.1\%$ for telephoto | **PASS** |
| | Bidirectional Margins | Correctly identifies expansion for barrel and pinch | **PASS** |
| **4. Matchmove Anti-Drift** | Feature Projection Drift | World feature rays project through `distortPoint` | **PASS** |
| | Sub-Pixel Drift Tolerance | Maximum drift on verified trajectory $< 0.01\text{ px}$ | **PASS** |
| **5. Gemini Agent Tools** | `optics_configure_lens_distortion` | Tool dispatch, preset resolution, overscan return | **PASS** |
| | `optics_export_lens_distortion` | Generates 3DEqualizer, Nuke, OpenCV, STMap payloads | **PASS** |
| | Unknown Preset Error Handling | Throws descriptive error on unknown preset ID | **PASS** |

### Suite 2: Pass & Legacy Test Suite (`lens-distortion-effect.test.ts`)
Run: `npx vitest run packages/core/test/lens-distortion-effect.test.ts`
All **15 tests pass** with zero errors:
- Confirms GLSL fragment and vertex shader definitions export properly.
- Confirms `LensDistortionEffect` post-processing pass fluent setters and uniforms.
- Confirms optical presets (`ultrawide_14mm`, `action_cam_fisheye`, `cinema_anamorphic_2x`, `telephoto_portrait_85mm`).
- Confirms CPU analytical UV displacement (`computeBrownConradyUV`).
- Confirms agent tool registration and capability resolution.

### Suite 3: Matchmove & Spatial Resection Suites
- `packages/core/test/precision-camera-matchmove-integration.test.ts`: **5 / 5 Passed**
- `packages/core/test/spatial-resection-agent-tools.test.ts`: **10 / 10 Passed**
- Confirms 361-frame continuous trajectory solve without gimbal singularities, closed-loop sub-pixel edge alignment optimizer ($\ge 99.98\%$ overlap, $< 0.08\text{px}$ residual), and locked drift audits.

---

## 7. Codebase API Reference

### 1. `VfxLensInterchangeService`
Location: [`packages/core/src/common/optics/VfxLensInterchangeService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/common/optics/VfxLensInterchangeService.ts)

```typescript
export class VfxLensInterchangeService {
    // 3DEqualizer 4
    public static export3DEqualizerLensFile(params: LensDistortionParams, metadata?: VfxLensMetadata): string;
    public static parse3DEqualizerLensFile(content: string): LensDistortionParams;

    // Foundry Nuke 15
    public static exportNukeLensDistortionScript(params: LensDistortionParams, mode?: 'undistort' | 'distort'): { nkScript: string; pythonSnippet: string };

    // OpenCV
    public static exportOpenCvCameraMatrix(params: LensDistortionParams, imageWidth: number, imageHeight: number): OpenCvCameraCalibration;

    // STMap 32-bit Float Pipeline
    public static exportSTMapRaw(params: LensDistortionParams, width: number, height: number): Float32Array;

    // Physical Optics Synthesizer
    public static calculateBrownConradyFromFocalLength(focalLengthMm: number, sensorWidthMm?: number): LensDistortionParams;
}
```

### 2. `VfxPlateMatchmoveService`
Location: [`packages/core/src/browser/generative-canvas/services/video/VfxPlateMatchmoveService.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/video/VfxPlateMatchmoveService.ts)

```typescript
export class VfxPlateMatchmoveService {
    // Forward optical distortion
    public static distortPoint(point: { x: number; y: number }, params?: LensDistortionParams): { x: number; y: number };

    // Analytical 2D Damped Newton-Raphson inverse undistortion
    public static undistortPoint(distortedPoint: { x: number; y: number }, params?: LensDistortionParams): { x: number; y: number };

    // Anti-drift matchmove trajectory verification
    public static evaluateDrift(solve: CameraSolveResult, features: TrackedFeature2D[], lens?: LensDistortionParams): MatchmoveDriftReport;
}
```

### 3. `LensDistortionEffect`
Location: [`packages/core/src/browser/generative-canvas/services/optics/LensDistortionEffect.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/optics/LensDistortionEffect.ts)

```typescript
export class LensDistortionEffect {
    public setDistortion(k1: number, k2: number, p1?: number, p2?: number, k3?: number, k4?: number): this;
    public setMode(mode: LensDistortionMode): this; // 'undistort' | 'redistort' | 'stmap'
    public setEdgeMode(edgeMode: LensDistortionEdgeMode): this; // 'letterbox' | 'transparent'
    public setFilterQuality(quality: LensDistortionFilterQuality): this; // 'bilinear' | 'bicubic'
    public calculateOverscanMargin(): { overscanPercent: number; recommendedWidth: number; recommendedHeight: number };
    public generateSTMap(width?: number, height?: number): Float32Array;
}
```

### 4. Gemini In-App Agent Tools
Location: [`packages/core/src/node/gemini/tools/spatial-tools.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/gemini/tools/spatial-tools.ts)

- **`optics_configure_lens_distortion`**:
  Configures preset, high-order polynomial parameters, overscan padding, and edge modes.
- **`optics_export_lens_distortion`**:
  Exports calibrated distortion parameters directly into 3DEqualizer `.lens`, Nuke `.nk`, OpenCV camera matrices, or STMap float buffers.

---

## 8. Future Roadmap

1. **Spline-Based Keyframe Animation Curves**:
   - Support dynamic zoom lenses with time-varying focal length and distortion curves interpolated via Catmull-Rom splines across shot frames.
2. **Machine-Learned Lateral Chromatic Aberration De-Fringing**:
   - Neural estimation of non-linear spectral dispersion curves across complex anamorphic glass.
3. **Native C++20 Astra Engine Vectorization**:
   - Port 2D Newton-Raphson Jacobian inversion to C++20 SIMD (`scratchbox_engine.hpp`) for real-time undistortion of dense point clouds ($> 10\text{M}$ points/sec).
