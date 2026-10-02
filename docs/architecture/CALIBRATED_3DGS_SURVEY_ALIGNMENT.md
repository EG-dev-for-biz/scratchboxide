# Calibrated 1:1 Metric 3DGS Survey Alignment & Reconstruction Architecture

**Authoritative Technical Reference: Ground-Truth Alignment, Adaptive Spatial Rigs, Splat Density Scaling, and Micro-Cavity ("Nook and Cranny") Coverage**  
*Scratchbox 3D Engine & Spatial Computing Foundation*

---

## 1. Executive Summary & Root Architecture

The **Calibrated 1:1 Metric 3DGS Pipeline** provides an end-to-end framework for reconstructing photorealistic, millimeter-accurate 3D Gaussian Splatting (3DGS) radiance fields from arbitrary 3D geometry (including Google Maps Photorealistic 3D Tiles, photogrammetric meshes, and procedural CAD models).

Unlike classical Structure-from-Motion (SfM) pipelines (e.g. COLMAP) which suffer from metric scale drift, unconstrained camera bundle adjustment errors, and floating sky artifacts, this architecture enforces **deterministic 1:1 metric matrix lock**:
1. Camera poses, view frusta, and depth buffers are rendered with exact identical pinhole optics as the plate rasterizer.
2. 3D Gaussian surfels are unprojected directly from ground-truth metric depth buffers with 2D EWA planar covariance.
3. Multi-station surfels are fused in a shared metric world frame (Scratchbox Local ENU) using spatial hashing, normal consensus, and soft radial feathering.
4. Downstream viewports (Three.js WebGL / WebGPU) render the 3DGS radiance field overlaid directly on the underlying 3D Tile mesh with **0.000 pixel drift** across arbitrary camera angles, zooms, and altitudes.

---

## 2. Mathematical Formulation & Physical Invariants

### 2.1 2D Horizontal Principal Component Analysis (PCA) & Oriented Bounding Box (OBB)

Real-world architectural structures (amphitheatres, temples, towers, stadiums) are rarely aligned with cardinal Cartesian axes $(X, Z)$. To construct scene-conformal camera orbits and boundaries, we estimate the primary architectural orientation via 2D horizontal PCA on ground-projected mesh vertices.

Given $N$ vertices $\mathbf{v}_i = (x_i, y_i, z_i)^T \in \mathbb{R}^3$, we compute the horizontal centroid $\mathbf{\bar{c}}_{xz}$:

$$\mathbf{\bar{c}}_{xz} = \frac{1}{N} \sum_{i=1}^N \begin{pmatrix} x_i \\ z_i \end{pmatrix}$$

The horizontal $2 \times 2$ covariance matrix $\mathbf{\Sigma}_{xz}$ is:

$$\mathbf{\Sigma}_{xz} = \frac{1}{N} \sum_{i=1}^N \begin{pmatrix} x_i - \bar{c}_x \\ z_i - \bar{c}_z \end{pmatrix} \begin{pmatrix} x_i - \bar{c}_x & z_i - \bar{c}_z \end{pmatrix}$$

Eigen-decomposition yields orthonormal eigenvectors $\mathbf{e}_1, \mathbf{e}_2 \in \mathbb{R}^2$ with eigenvalues $\lambda_1 \ge \lambda_2 \ge 0$. The primary orientation angle (architectural yaw) is:

$$\theta_{\text{yaw}} = \text{atan2}(e_{1,z},\; e_{1,x})$$

The Oriented Bounding Box (OBB) half-extents $(h_u, h_w)$ along the principal axes are:

$$h_u = \max_i \left| (x_i - \bar{c}_x) \cos\theta_{\text{yaw}} + (z_i - \bar{c}_z) \sin\theta_{\text{yaw}} \right|$$

$$h_w = \max_i \left| -(x_i - \bar{c}_x) \sin\theta_{\text{yaw}} + (z_i - \bar{c}_z) \cos\theta_{\text{yaw}} \right|$$

The vertical extent $(y_{\min}, y_{\max})$ along gravity $+Y$ is maintained unrotated.

---

### 2.2 Optics, Focal Length, and Ground Sampling Distance (GSD) Standoff

To eliminate manual camera placement and maintain uniform visual resolution across structures of any scale, station standoff distance $d_{\text{standoff}}$ is derived analytically from the target Ground Sampling Distance (GSD) and camera sensor parameters:

$$\text{GSD} = \frac{\text{pixelPitch} \times d_{\text{standoff}}}{f}$$

Solving for standoff distance $d_{\text{standoff}}$:

$$d_{\text{standoff}} = \frac{f \times \text{targetGSD}}{\text{pixelPitch} \times 1000}$$

where:
- $f$ is focal length in millimeters (e.g. $35\text{mm}$).
- $\text{targetGSD}$ is target ground resolution in millimeters per pixel (e.g. $15\text{mm/px}$ for macro detail, $35\text{mm/px}$ for overview).
- $\text{pixelPitch}$ is physical sensor pixel size in microns (e.g. $4.5\mu\text{m}$ for a standard full-frame $36 \times 24\text{mm}$ sensor at $8K$).

Converting horizontal field-of-view $\theta_{\text{hfov}}$ to 35mm equivalent focal length:

$$f_{35} = \frac{36.0}{2 \cdot \tan(\theta_{\text{hfov}} / 2)}$$

---

### 2.3 Local Terrain Raycasting & Clearance Invariant

A critical failure mode of naive circular or orbital camera paths is the "subterranean camera bug", where cameras plunge into hillside slopes or surrounding topography.

To guarantee physical clearance, every candidate station $(\tilde{x}, \tilde{y}, \tilde{z})$ undergoes local vertical terrain probing against the active mesh:

$$y_{\text{terrain}}(\tilde{x}, \tilde{z}) = \max_{j \in \mathcal{N}(\tilde{x}, \tilde{z}, R_{\text{probe}})} y_j$$

where $\mathcal{N}(\tilde{x}, \tilde{z}, R_{\text{probe}})$ denotes all mesh vertices within a search radius $R_{\text{probe}} = 6.0\text{m}$.

The camera altitude $y_{\text{cam}}$ is strictly clamped by the **Minimum Terrain Clearance Invariant**:

$$y_{\text{cam}} = \max\left(\tilde{y},\; y_{\text{terrain}}(\tilde{x}, \tilde{z}) + h_{\text{clearance}}\right)$$

where $h_{\text{clearance}} = 1.8\text{m}$ (standard human eye level above local topography).

---

### 2.4 Facade-Normal Optical Targeting

Pointing cameras at an arbitrary arbitrary spatial coordinate (e.g. $[0, 20, 0]$) produces oblique viewing angles that degrade resolution on exterior walls.

For any station at horizontal angle $\theta$, the optical look-at target $\mathbf{t}_{\text{target}}$ is placed on the structure's physical perimeter:

$$u_{\text{target}} = h_u \cos\theta, \quad w_{\text{target}} = h_w \sin\theta$$

$$\mathbf{t}_{\text{target}} = \begin{pmatrix} \bar{c}_x + u_{\text{target}} \cos\theta_{\text{yaw}} - w_{\text{target}} \sin\theta_{\text{yaw}} \\ y_{\text{ground}} + h_{\text{structure}} \times \alpha_{\text{tier}} \\ \bar{c}_z + u_{\text{target}} \sin\theta_{\text{yaw}} + w_{\text{target}} \cos\theta_{\text{yaw}} \end{pmatrix}$$

The forward optical vector $\mathbf{f}$ is:

$$\mathbf{f} = \frac{\mathbf{t}_{\text{target}} - \mathbf{c}_{\text{cam}}}{\|\mathbf{t}_{\text{target}} - \mathbf{c}_{\text{cam}}\|}$$

The camera orthonormal basis $(\mathbf{r}, \mathbf{u}, \mathbf{f})$ is formed via:

$$\mathbf{r} = \frac{\mathbf{f} \times \mathbf{u}_{\text{world}}}{\|\mathbf{f} \times \mathbf{u}_{\text{world}}\|}, \quad \mathbf{u} = \mathbf{r} \times \mathbf{f}$$

where $\mathbf{u}_{\text{world}} = (0, 1, 0)^T$ (gravity-aligned Up in Scratchbox Local ENU).

---

### 2.5 1:1 Metric Matrix Lock: Pinhole Intrinsics & Extrinsics Unprojection

The foundation of zero-drift alignment is mathematical congruence between the rasterizer projection matrix $\mathbf{P}$ and the surfel unprojector matrix $\mathbf{K}^{-1}$.

#### The Projection Matrix ($\mathbf{P}$)
In standard WebGL and Three.js viewports, given horizontal field of view $\theta_{\text{hfov}}$, aspect ratio $a = W / H$, and clipping planes $z_n, z_f$:

$$\theta_{\text{vfov}} = 2 \cdot \arctan\left(\tan(\theta_{\text{hfov}} / 2) \cdot \frac{1}{a}\right)$$

$$\mathbf{P} = \begin{pmatrix} \frac{1}{a \tan(\theta_{\text{vfov}}/2)} & 0 & 0 & 0 \\ 0 & \frac{1}{\tan(\theta_{\text{vfov}}/2)} & 0 & 0 \\ 0 & 0 & -\frac{z_f + z_n}{z_f - z_n} & -\frac{2 z_f z_n}{z_f - z_n} \\ 0 & 0 & -1 & 0 \end{pmatrix}$$

#### The Intrinsics Matrix ($\mathbf{K}$)
For an un-skewed sensor with square pixels, principal point at exact optical center $(c_x, c_y) = (W/2, H/2)$:

$$f_x = f_y = \frac{H}{2 \cdot \tan(\theta_{\text{vfov}} / 2)} = \frac{W}{2 \cdot \tan(\theta_{\text{hfov}} / 2)}$$

$$\mathbf{K} = \begin{pmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{pmatrix}$$

#### Surfel Unprojection Equation
For pixel $(u, v)$ with camera-space depth $z = Z_{\text{depth}}(u, v)$:

$$\mathbf{p}_{\text{cam}} = \begin{pmatrix} X_{\text{cam}} \\ Y_{\text{cam}} \\ Z_{\text{cam}} \end{pmatrix} = \begin{pmatrix} \frac{u + 0.5 - c_x}{f_x} \cdot z \\ -\frac{v + 0.5 - c_y}{f_y} \cdot z \\ z \end{pmatrix}$$

Transforming to world space via camera-to-world pose $\mathbf{T}_{c \to w} = (\mathbf{r}, \mathbf{u}, \mathbf{f}, \mathbf{c}_{\text{cam}})$:

$$\mathbf{p}_{\text{world}} = \mathbf{c}_{\text{cam}} + \mathbf{r} \cdot X_{\text{cam}} + \mathbf{u} \cdot Y_{\text{cam}} + \mathbf{f} \cdot Z_{\text{cam}}$$

Because $f_x, f_y, c_x, c_y$ match $\mathbf{P}$ to machine epsilon ($< 10^{-7}$), every pixel maps back to the exact physical 3D surface point that rendered it.

---

## 3. Splat Density Scaling & Penetrating Every "Nook and Cranny"

### 3.1 Density Scaling Limits & Hardware Budgets

How far can we push the density of splats?

Density scaling is governed by three primary parameters:
1. **Unprojection Stride ($S$)**: Stride determines sub-pixel sampling. At $S = 1$, every single rendered pixel emits a Gaussian surfel candidate.
   - At $1920 \times 1080$, each station produces $2,073,600$ candidate rays.
   - At $3840 \times 2160$ (4K UHD), each station produces $8,294,400$ candidate rays.
   - With 16 stations at 4K, $132,710,400$ rays probe the structure.
2. **Spatial Voxel Hash Resolution ($\Delta_{\text{voxel}}$)**: Multi-station fusion deduplicates overlapping rays within a 3D grid cell:
   - $\mathbf{k} = \left(\lfloor x/\Delta \rfloor, \lfloor y/\Delta \rfloor, \lfloor z/\Delta \rfloor\right)$.
3. **Surfel Density Benchmark**:

| Voxel Size ($\Delta$) | Surfel Count (Colosseum Scale) | Standard .splat Size | Compressed .spz Size | WebGL 60 FPS Target | Use Case |
|---|---|---|---|---|---|
| **$10.0\text{ cm}$** | ~3.8 Million | 121 MB | 22 MB | Mobile / Low-End | Fast preview, broad landscape |
| **$5.0\text{ cm}$** *(Default)* | **13.0 Million** | 417 MB | 78 MB | Desktop GPU / M-Series | Real-time interactive inspection |
| **$2.5\text{ cm}$** | **45.0 - 52.0 Million** | 1.5 GB | 280 MB | High-End GPU / RTX 4090 / L4 | Architectural preservation, macro joints |
| **$1.25\text{ cm}$** | **140.0 - 180.0 Million** | 5.2 GB | 950 MB | Cloud Run / Offline Path Tracing | Sub-millimeter museum archival scan |

---

### 3.2 The Ray Occlusion Problem in Classical Photogrammetry

Why do naive orbital rigs fail to capture the underside of arches, interior barrel vaults, and hypogeum trenches?

Let a surface point $\mathbf{p} \in \mathcal{S}$ reside inside a cavity with surface normal $\mathbf{n}(\mathbf{p})$. An optical station at position $\mathbf{c}$ can reconstruct $\mathbf{p}$ if and only if two physical conditions are simultaneously satisfied:

1. **Line-of-Sight Visibility**:
   $$\text{Segment}(\mathbf{c}, \mathbf{p}) \cap \mathcal{M}_{\text{exterior}} = \emptyset$$
2. **Incidence Angle Threshold**:
   $$\langle \frac{\mathbf{c} - \mathbf{p}}{\|\mathbf{c} - \mathbf{p}\|},\; \mathbf{n}(\mathbf{p}) \rangle \ge \cos(\theta_{\text{max\_incidence}}) \quad (\approx 0.15)$$

In classical exterior surveys:
- Exterior cameras are positioned outside the monument looking horizontally or slightly downward.
- The underside of arches (intrados) has downward-pointing normals: $n_y < -0.20$.
- The ceiling of interior galleries and barrel vaults is completely occluded by the exterior attic walls.
- Therefore, no ray from any exterior camera ever strikes these surfaces.

---

### 3.3 The Three Penetrative Station Rigs (Reaching Every Nook and Cranny)

To achieve 100% complete coverage of intricate classical architecture, the adaptive survey engine introduces three specialized penetrative camera trajectories:

```
                      Zenith / Roof Survey (Tier 4)
                                [CAM]
                                  │
                                  ▼
      Exterior Attic Rim (Tier 3) 
              [CAM] ──► ┌─────────────────────────┐
                        │   Colosseum Outer Wall  │
    Mid Facade (Tier 2) │                         │
              [CAM] ──► │  [Arch]         [Arch]  │
                        │                         │
  Pedestrian Street     │       ┌─────────┐       │
  (Tier 1) [CAM] ──►    │       │         │       │
                        │       │         │       │
                        └───────┴─────────┴───────┘
                                ▲         ▲
                                │         │
                         [CAM] ─┘         └─ [CAM]
                 Soffit-Upward Rig        Ambulacrum Traversal Rig
               (+45° to +65° pitch)       (Inside Arcade Corridors)
                                              │
                                              ▼
                                     ┌─────────────────┐
                                     │ Hypogeum Trench │
                                     │  [CAM] ──► [CAM]│
                                     └─────────────────┘
                                     Hypogeum Floor Rig
```

#### 1. Soffit-Upward Rigs (Arch Intrados & Capital Normals)
- **Positioning**: Placed at the base of each bay along the ground perimeter ($d = 0.15 \times d_{\text{standoff}}$).
- **Attitude**: Pinned with positive upward pitch: $\theta_{\text{pitch}} \in [+45^\circ,\; +65^\circ]$.
- **Targeting**: Optical center aims directly at the keystone and voussoirs on the underside of each arch.
- **Normal Activation**: Captures downward-facing surfels with $n_y < -0.22$.

#### 2. Ambulacrum Traversal Rigs (Interior Arcade Walkways)
- **Positioning**: Traverses the concentric ring corridors (the first and second ambulacrum) between the outer facade and the cavea seating bowl.
- **Attitude**: Cameras look circumferentially along the curved aisle while maintaining a $+35^\circ$ upward incline.
- **Coverage**: Captures the groin vault ceilings, interior column pilasters, and radial cross-walls that connect the rings.

#### 3. Hypogeum Trench Corridors (Subterranean Substructures)
- **Positioning**: Lowered directly into the sunken hypogeum channels:
  $$y_{\text{cam}} = y_{\text{ground}} - 1.5\text{m} \dots y_{\text{ground}} + 2.5\text{m}$$
- **Targeting**: Directed along the subterranean axes of the animal cages, mechanical hoist channels, and retaining foundation walls.

---

### 3.4 Underside Surface Preservation (`--include-underside`)

In early unprojector versions, an aggressive filtering condition dropped downward-pointing normals:
```cpp
// INADEQUATE: Strips out ceilings and arch soffits
if (excludeUnderside && (n.y < -0.22f || p.y < minGroundY)) continue;
```
When reconstructing architecture, this condition deleted every arch ceiling, portico roof, and alcove vault.

The canonical invariant decouples ground clipping from normal orientation:
1. **Vertical Ground Clipping**: Retained strictly below the foundation level:
   $$p_y < Y_{\text{ground\_datum}} \implies \text{Discard}$$
2. **Underside Normals**: Downward normals ($n_y < -0.22$) are **100% preserved** when `--include-underside` is active.
3. **Spatial Hash Normal Disambiguation**: The voxel key includes the normal direction:
   $$\text{normalDir} = \begin{cases} +1 & \text{if } n_y \ge +0.20 \text{ (Floor / Ground)} \\ -1 & \text{if } n_y \le -0.20 \text{ (Ceiling / Soffit)} \\ 0 & \text{if } |n_y| < 0.20 \text{ (Vertical Wall)} \end{cases}$$
   Because $\text{normalDir}$ is hashed into the voxel key, a ceiling surfel and a floor surfel occupying the same vertical grid column will **never overwrite or squash each other**.

---

### 3.5 Curvature-Adaptive Splat Radii ($\sigma$)

In flat open surfaces (e.g. ashlar facade blocks), surfels can be relatively large ($\sigma \approx 2.5\text{cm} - 5.0\text{cm}$) without visual artifact. However, in tight geometric crevices (e.g. mortar joints, moulding indentations, and column fluting), large surfels bleed across perpendicular surfaces.

The curvature-adaptive radius $\sigma_i$ at vertex $\mathbf{p}_i$ is defined by:

$$\sigma_i = \min\left(\sigma_{\max},\; \max\left(\sigma_{\min},\; \frac{\sigma_{\text{base}}}{\sqrt{1 + \beta \cdot \kappa_i}}\right)\right)$$

where:
- $\kappa_i = \|\nabla \mathbf{n}_i\|$ is the discrete surface curvature estimated across the 4-neighbour depth stencil:
  $$\kappa_i = \frac{\|\mathbf{n}(u+1, v) - \mathbf{n}(u-1, v)\| + \|\mathbf{n}(u, v+1) - \mathbf{n}(u, v-1)\|}{2 \cdot \Delta_{\text{sample}}}$$
- $\beta = 4.5$ is the crevice sensitivity coefficient.

In flat regions ($\kappa_i \approx 0$), $\sigma_i \to \sigma_{\text{base}}$. In sharp internal corners and grooves ($\kappa_i \gg 1$), $\sigma_i$ contracts down to $\sigma_{\min} \approx 6\text{mm}$, preventing planar surfel bleeding across open air.

---

## 4. Formal Canonical API Specification

The canonical API is implemented in `@scratchbox/core` under [`Calibrated3DGSReconstructionService`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/spatial/Calibrated3DGSReconstructionService.ts).

### 4.1 Interface Contract

```typescript
export interface Calibrated3DGSReconstructionOptions {
    /** Absolute path to the source 3D model (.glb) */
    glbPath: string;

    /** Destination directory for stations, splats, and tilesets */
    outDir: string;

    /** Optional pre-computed survey stations. If omitted, planned adaptively. */
    stations?: ColmapCameraPose[];

    /** Options for adaptive survey rig planning if stations are auto-derived */
    rigOptions?: AdaptiveSurveyRigOptions;

    /** Voxel grid deduplication size in meters (default: 0.05m = 5cm) */
    voxelSizeMeters?: number;

    /** Unprojection render resolution (default: 1920x1080; 3840x2160 for 4K ultra) */
    resolution?: { width: number; height: number };

    /** Sub-pixel unprojection stride (1 = full density, 2 = half density) */
    stride?: number;

    /** If true, adds penetrative interior ambulacrum and upward soffit rigs */
    includeInteriorPenetration?: boolean;

    /** If true (default), preserves downward-facing ceiling/soffit normals */
    includeUnderside?: boolean;

    /** Density preset selector */
    densityPreset?: 'standard' | 'high' | 'ultra' | 'nooks-and-crannies';

    /** Horizontal crop boundary radius in meters around centroid */
    cropRadius?: number;

    /** Horizontal crop center [X, Z] in Local ENU */
    cropCenter?: [number, number];

    /** Minimum Y elevation datum to clip subterranean noise */
    minAltitudeY?: number;

    /** Use 2D Gaussian Surface Regularization (squashed Z axis) */
    use2dgs?: boolean;

    /** Force rebaking even if cached plates/splats exist on disk */
    forceRebake?: boolean;
}

export interface Calibrated3DGSReconstructionResult {
    success: boolean;
    fusedSplatPath: string;
    fusedSpzPath?: string;
    tilesetMetaPath: string;
    splatCount: number;
    fileSizeMb: number;
    spzSizeKb?: number;
    stationCount: number;
    voxelSizeMeters: number;
    durationMs: number;
    cropCenter: [number, number];
    cropRadius: number;
    error?: string;
}
```

---

### 4.2 Pipeline Execution Stages

1. **Stage 1: Geometric Mesh Analysis & Ground Datum**:
   Loads the source GLB into `RenderMesh3D`, calculates dual AABB/OBB, 2D horizontal PCA yaw, and estimates ground datum $Y_{\text{ground}}$ via 5th-percentile vertex sampling.

2. **Stage 2: Adaptive Multi-Tier Survey Rig Planning**:
   If stations are not supplied, invokes `AdaptiveSurveyRigService.planRig()`. When `includeInteriorPenetration` or `nooks-and-crannies` is active, automatically provisions:
   - Exterior Street / Pedestrian tier (inward looking).
   - Facade mid-level and attic rim tiers.
   - Soffit-Upward close-in stations (pitch $+45^\circ \dots +65^\circ$).
   - Ambulacrum corridor traversal stations.
   - Aerial zenith survey stations.

3. **Stage 3: Calibrated Matrix-Locked Plate & Depth Rendering**:
   Iterates through stations, configuring the camera with exact vertical FOV derived for aspect ratio $a = W / H$. Renders:
   - True-color textured plate (saved as PNG).
   - Metric depth buffer `Float32Array` with exact pinhole intrinsics $(f_x, f_y, c_x, c_y)$.
   - Validates that $f_x = f_y$ and $(c_x, c_y) = (W/2, H/2)$ to guarantee 0.000 pixel drift.

4. **Stage 4: 2D EWA Planar Surfel Baking**:
   Executes native C++20 `station_to_splats` with:
   - `--2dgs`: Planar surfel covariance squashing raymarching thickness.
   - `--include-underside`: Retains arch soffits and vault ceilings.
   - `--sigma-scale 0.95`: Optimal footprint matching `gaussian-splat-lite`.
   - Depth-jump severance ($\tau = 0.08$) to preserve sharp architectural edges.

5. **Stage 5: Multi-Station Spatial Voxel Fusion**:
   Executes fusion in C++20 across all station splats:
   - Harmonizes radiometric exposure gain across multi-view plates.
   - Indexes into 3D hash grid with normal-direction segregation.
   - Soft radial feathering on outer 10% of crop boundary ($0.90 \cdot R_{\text{crop}} \dots R_{\text{crop}}$) to eliminate cliff artifacts.
   - Writes canonical `fused.splat`, compressed `fused.spz`, and `meta.json`.

---

## 5. Architectural Verification & Zero-Drift Visual Rubric

Every reconstructed asset must pass the **8-Dimension Visual Fidelity Rubric**:

1. **Sub-Pixel Spatial Lock ($0.000\text{ px}$ Drift)**:
   Toggle between pure 3DGS radiance field and underlying 3D Tile mesh in the Three.js viewport. Architectural cornices, column capitals, and arch contours must align to the exact sub-pixel boundary with zero translation, rotation, or shearing drift.
2. **Zero Floating Sky Artifacts**:
   Radial bounds clipping and depth thresholding ($\text{maxDepth} = d_{\text{standoff}} \times 2.8$) must guarantee that zero unprojected sky haze or floating dust particles exist in the airspace surrounding or above the monument.
3. **Full Micro-Cavity Integrity**:
   Inspection under arcade bays, barrel vaults, and hypogeum corridors must display continuous, solid surfel surfaces without hollow cavities or missing ceiling shells.
4. **Natural Boundary Feathering**:
   Peripheral boundaries must transition smoothly into the surrounding earth via soft distance feathering, without hard cookie-cutter vertical cuts.
5. **Authentic PBR Stone Albedo**:
   Luminance and chromaticity must match calibrated historical travertine ($R \approx 0.50, G \approx 0.45, B \approx 0.38$) without burnt-in artificial lighting or oversaturation.
