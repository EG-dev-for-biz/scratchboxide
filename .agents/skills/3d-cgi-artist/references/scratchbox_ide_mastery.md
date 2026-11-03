# Scratchbox IDE Deep Mastery & Codebase Leverage

> *"Scratchbox IDE is not a toy WebGL viewer; it is an autonomous generative canvas studio, visual primitives suite, and high-precision 3D geospatial engine with patent-pending photogrammetric algorithms and bare-metal C++20 invariant kernels."*

Codebase Location: `/Users/eligreen/dev/scratchbox-ide-master/` (referred to as `/dev/scratchbox-ide-master/`).

---

## 1. Codebase Architecture & Key Systems

### 1.1 Monorepo Topography
```
scratchbox-ide/
├── packages/
│   ├── core/                  # @scratchbox/core (First-party library)
│   │   ├── src/
│   │   │   ├── browser/       # React 18 Canvas Studio, 8 Visual Primitives, Three.js layers
│   │   │   ├── node/          # 3D Engines, Spatial Services, Gemini AI, KeyStore, PathGuard
│   │   │   ├── common/        # GeoFrame, LocalTangentPlane, Invariant types, Protocols
│   │   │   ├── native/        # High-performance C++20 invariant kernels & SPZ/Splat engines
│   │   │   └── python/        # Procedural Python DSL & World compilation bridges
│   │   └── test/              # Vitest suites & architectural verification
│   └── cli/                   # sbox developer CLI
├── desktop-app/               # Electron 38 + Express API backend (ports 3000, 3001, 3002)
└── .agents/skills/            # Reality grounding & Anti-Simulation Trap directive
```

---

## 2. Core 3D Engine & Spatial Services Reference

### 2.1 Procedural 3D Engine (`Procedural3DEngineService`)
- **File**: `packages/core/src/node/3d-engine/Procedural3DEngineService.ts`
- **What it does**: Autonomous AI-native 3D platform (Blender alternative).
- **Execution Flow**:
  1. `ProceduralAstGuard.validateScript(script)`: Pre-flight AST validation, ensures no banned toy JS primitives (`THREE.BoxGeometry`), extracts dynamic UI parameters.
  2. Runs high-performance Python script linked to pre-compiled C++20 invariant kernel (`packages/core/src/native/3d-engine/build_py`).
  3. Emits binary glTF 2.0 (`.glb`) directly into RAM buffer, validating vertex/triangle counts and bounding envelopes.
- **How to leverage in code**:
  ```typescript
  import { Procedural3DEngineService } from '@scratchbox/core/node';

  const engine = Procedural3DEngineService.getInstance();
  const result = await engine.executeScript(pythonScript, {
    skipAstGuard: false,
    timeoutMs: 30000
  });

  if (result.success && result.glbBuffer) {
    console.log(`Generated ${result.vertexCount} vertices, ${result.triangleCount} triangles`);
  }
  ```

### 2.2 Location 3D Gaussian Splatting (`Location3DGaussianSplatService`)
- **File**: `packages/core/src/node/spatial/Location3DGaussianSplatService.ts`
- **What it does**: End-to-end autonomous synthesis of high-fidelity 3D Gaussian Splats (3DGS) for any real-world location or landmark.
- **Pipeline**:
  1. Google 3D Tiles grounded mesh ingestion & geodetic anchor resolution.
  2. Multi-tier camera survey synthesis & pinhole blockout rendering.
  3. Closed-loop Sobel edge alignment quality control.
  4. Multi-view depth unprojection via native C++20 voxel-hash fusion (`station_to_splats.cpp`).
  5. Packaging to OGC 3D Tiles 1.1 or Niantic SPZ.

### 2.3 Toksvig Specular Filtering (where it runs)
- **`algorithmic_uv_unwrap_rewrap`** (`enableToksvigFiltering`, default on) and **`TileCleanupService`** (`packages/core/src/node/3d-engine/tile-cleanup-service.ts`, `enableToksvigFiltering`) fold normal variance into roughness at bake time.
- **The viewer** (`facadeMaterialLook.ts`) raises roughness where the normal varies within a pixel, so distant glass and facades do not shimmer.

### 2.4 Normal Bevel (where it runs)
- **`sb_apply_normal_bevel`** (`packages/core/src/browser/generative-canvas/services/operators/advanced-realism-operators.ts`): rounds the live viewport mesh's shading normals across creases between a threshold and a maximum dihedral angle; geometry unchanged; live viewport only, not exported into normal maps.
- **Pipeline K** chamfers its facade structure edges 5 cm at 45 degrees in real geometry.

### 2.5 Unused kernels: do not cite as running
- **`UniversalPbrBakingKernel`** (`universal-pbr-baking-kernel.ts`) and **`VirtualBevelKernel`** (`virtual-bevel-kernel.ts`) are exported and unit-tested, but no build, tool or route has ever called them.
- The baking kernel's per-texel rule (`applyUniversalSleightOfHand`) conflicts with AGENTS.md: it brightens every texel under 45% luminance as shadow (dark materials included), derives cavities and height relief from image brightness, invents a vertical grain pattern, and darkens walls near the ground unasked. Do not propose wiring it in as written.
- The bevel kernel's fixed 5 mm width is smaller than a texel on tile textures and would sparkle along noisy scan edges; if a bevel is wanted on engine-built objects, scale its width to the object.

### 2.6 Dynamic 4DGS Humanoid Avatar Engine (`SbHumanLoader` & `ConcertStagePerformerService`)
- **Files**: `packages/core/src/common/spatial/SbHumanLoader.ts`, `packages/core/src/browser/generative-canvas/services/ConcertStagePerformerService.ts`
- **What it does**: 22-joint canonical kinematic skeleton with dual-quaternion / linear blend skinning driving dynamic 3D Gaussian splat ellipsoids for realistic humanoid performance in WebGL.

---

## 3. Adaptive Domain Architecture (ADA) & The Alien Planet Test

A foundational architectural doctrine in Scratchbox IDE is **Adaptive Domain Architecture (ADA)**. Every technical artist solution, procedural script, shader, and spatial service MUST be self-interrogated:
> **"Are these solutions adaptive domain architecture compliant?"**

### 3.1 The 6 ADA Pillars
1. **The Alien Planet Test (Zero Closed Taxonomies)**:
   - Zero hardcoded noun lists, closed string enums, or rigid preset tables.
   - All parameters must exist as continuous coordinates in $\mathbb{R}^n$.
   - The engine must synthesize a "Titan Cryogenic Atmospheric Methane Harvester Drone" or "Obsidian Basalt Ziggurat" just as easily as an Earth skyscraper.
2. **2-Layer Metric Root vs Relative Geodesics**:
   - **Layer 1 (Local)**: Strict metric root ($1.0\text{ unit} = 1.0\text{ meter}$) for 100% of meshes, tools, and props.
   - **Layer 2 (Global)**: Relative geodetic attachment via `LocalTangentPlane` (ENU) or `GeoFrame`. Never mandate GPS coordinates on isolated non-geographic props (prevents "Null Island").
3. **The 5 Universal Geometric Operators of Mechanical Fidelity**:
   - Panelized Compound-Curvature Lofts (aerodynamic hulls, shutlines, fastener pitch).
   - Kinematic Actuator & Linkage Chains (hydraulic rams, clevis pins, gimbal bearings).
   - Protective Fluid & Thermal Interfaces (directional louvers, debris strainers, heat sinks).
   - Spline-Swept Umbilical Harnesses (cryo conduits, P-clamp brackets, wiring looms).
   - Structural Spaceframe & Lightening Topology (trusses, lightening pockets, gussets).
4. **The 70-20-10 Form Hierarchy**:
   - 70% Primary Edifice (dominant structural silhouette).
   - 20% Secondary Cowlings (functional articulators, cowls, intakes, sponsons).
   - 10% Tertiary Micro-detail (chamfers, fasteners, rivets, panel seams).
5. **Relational Spatial Solvers vs Hardcoded Magic Offsets**:
   - Spatial relationships must be declared as relational predicates (`SUPPORTED_BY`, `ATTACHED_TO`, `CONCENTRIC_WITH`, `CONTAINED_IN`) solved at compile/runtime by constraint solvers, never brittle magic Cartesian offsets.
6. **Continuous Radiometric & Signal Grounding**:
   - Continuous physical units (lux, candela, Kelvin, EV100, Pascals, microfacet roughness, complex refractive indices).

---

## 4. The 7 Non-Negotiable Mathematical Invariants

When working in Scratchbox IDE, you must strictly satisfy the 7 core mathematical invariants verified by `scripts/verify_3d_math_invariants.js`:

1. **SO(3) / SE(3) Chirality & Orthogonality**:
   - Rigid-body rotation matrices must have $\det(R) = +1.000000$ (strictly right-handed).
   - $R^T R = I$ with residual $< 10^{-11}$.
   - Unit quaternions $\|\mathbf{q}\|_2 = 1.000000 \pm 10^{-6}$.
2. **WGS-84 Geodesic Invariant**:
   - Sub-millimeter metric geodesic preservation ($< 0.1\text{mm}$) when converting between Ellipsoid, ECEF, and Local Tangent Plane (ENU).
3. **3DGS Covariance Positive-Definiteness**:
   - $\Sigma = R S S^T R^T \succ 0$ with $\det(\Sigma) = (s_x s_y s_z)^2 > 0$ and all Sylvester principal minors $> 0$.
4. **Projective 2D Jacobian Conditioning**:
   - Affine perspective Jacobian $J$ must maintain full row rank $\det(J J^T) > 0$.
5. **Bernstein Polynomial FFD Partition of Unity**:
   - $\sum B_{ijk}(u,v,w) \equiv 1.000000$ for Free-Form Deformation volume affine invariance.
6. **Differential UV Parameterization**:
   - Affine Jacobian determinant $\det(J_{uv}) > 0$ across all triangles (no inverted/twisted UV seams).
7. **Radiometric Conservation & Genus-0 Manifoldness**:
   - BRDF reflectance $\le 1.0$, Beer-Lambert transmittance $0 \le e^{-\tau} \le 1.0$.
   - Closed 2-manifold Euler characteristic $\chi = V - E + F = 2$.

---

## 5. How to Suggest Meaningful Improvements in Scratchbox IDE

When auditing or proposing improvements for Scratchbox IDE, focus on concrete technical artist & engineering optimizations:

### 1. WebGL/WebGPU Render Pipeline Upgrades
- **Problem**: Large 3D Tiles and Gaussian Splat scenes bottleneck the main JavaScript thread during CPU frustum culling and quad-tree traversal.
- **Improvement**: Migrate splat sorting and BVH traversal to **WebGPU Compute Shaders** (`GPUComputePipeline`), sorting 1M+ splats via GPU radix sort in $< 2\text{ms}$ per frame.

### 2. Texture Memory & Streaming Bandwidth
- **Problem**: 4K uncompressed PBR textures can cause mobile / low-VRAM Electron crashes.
- **Improvement**: Integrate KTX2 / Basis Universal supercompression (`KHR_texture_basisu`), transcoding directly to native GPU formats (BC7 on desktop, ASTC on mobile) with 75% VRAM reduction.

### 3. Dynamic LOD for 3DGS (Continuous Level of Detail)
- **Problem**: Distant Gaussian splats waste rasterization bandwidth rendering sub-pixel ellipsoids.
- **Improvement**: Implement hierarchical octree clustering for splats, merging clusters of micro-splats into single representative parent Gaussians at distance.

### 4. Avoiding the Architectural Simulation Trap (AST)
- Always test proposals by running live verification:
  ```bash
  npm run typecheck
  npm run lint
  npm test
  node .agents/skills/prevent-architectural-simulation-trap/scripts/verify_3d_math_invariants.js
  ```
- Reject any hollow wrapper classes, mock echo-chambers, or toy Three.js primitives. Enforce `GeometricComplexityGate` ($\ge 25,000$ vertices).
