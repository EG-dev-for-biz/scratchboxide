# Unreal Engine 5+ Deep Mastery: Nanite, Lumen, Substrate & PCG

> *"Unreal Engine 5 changes the fundamental axioms of real-time rendering. Nanite decouples polygon count from performance; Lumen replaces lightmaps with dynamic radiosity; Substrate unifies multi-layer optics."*

---

## 1. Nanite Architecture & Production Rules

### 1.1 How Nanite Works Under the Hood
Nanite divides meshes into hierarchical clusters of **128 triangles**. Each cluster has a bounding sphere and error metric:
- **Sub-Pixel Micro-Polys**: If triangles are smaller than a pixel, Nanite switches to a custom **Software Compute Rasterizer** (orders of magnitude faster than hardware rasterization).
- **Large Polys**: Routed through standard hardware rasterization.

### 1.2 The Nanite Golden Rules & Pitfalls
1. **Never use Alpha-Masked foliage without Nanite Testing**:
   - Alpha-masked materials force **Programmable Rasterization**, disabling the hyper-fast micro-poly rasterizer and stalling GPU execution.
   - *Artist Solution*: Model actual 3D geometry for leaves and needles instead of flat transparent cards! Nanite handles 2 million geometric pine needles faster than 50 alpha-tested leaf cards.
2. **World Position Offset (WPO) Disable Distance**:
   - If foliage or props use WPO for wind, Nanite must evaluate displacement on the CPU/GPU for cluster bounds.
   - *Fix*: In the Static Mesh editor, set `Nanite $\rightarrow$ WPO Disable Distance` (e.g., $3000\text{ cm}$). Beyond this distance, wind animation ceases and clusters cull optimally.
3. **Cluster Boundary Pinning**:
   - Every UV seam and material assignment acts as a hard boundary that Nanite cannot collapse across during LOD reduction.
   - *Fix*: Minimize UV splits and keep material slot count per mesh $\le 2$.

---

## 2. Lumen: Dynamic Global Illumination & Reflections

### 2.1 The Two-Tier Lumen Architecture
```
[Camera Ray] ──> [1. Screen Traces (High Res, Fast, Screen-Space)]
                       │ (Miss / Offscreen)
                       v
                 [2. Lumen Surface Cache (Mesh Distance Fields / Cards)]
                       │ (High Specular / Mirror)
                       v
                 [3. Hardware Ray Tracing / Hit Lighting (DXR)]
```

### 2.2 Diagnosing & Fixing Lumen Light Leaks
- **Symptom**: Sunlight glows along interior baseboards, or dark interior rooms look washed out with indirect light.
- **Root Cause**: The **Surface Cache** has a default resolution of $\approx 10\text{ cm}$. Geometry thinner than $10\text{ cm}$ (single-polygon walls, ceiling planes) fails to generate surface cache cards, allowing indirect radiance to bleed through.
- **The Out-of-the-Box Artist Fixes**:
  1. **Thicken Architectural Geometry**: Never use single-sided planes for exterior walls or roofs. Give all walls a minimum thickness of $15 - 20\text{ cm}$.
  2. **Invisible Shadow Blocker Meshes**: Place an inverted two-sided blocking mesh inside ceiling voids or wall cavities. In the Details panel, uncheck `Visible in Scene` but check `Cast Hidden Shadow`.
  3. **Tune Distance Field Bias**: In the Static Mesh editor, adjust `Distance Field Resolution Scale` from $1.0$ to $2.0$ or $3.0$ for thin architectural assets.

---

## 3. Substrate (Strata) Material Framework

Substrate replaces the legacy single-lobe PBR pipeline with physically accurate, layered multi-BSDF optics.

### 3.1 Substrate Building Blocks
- **Substrate Slab BSDF**: The fundamental material unit (diffuse, roughness, metallic, normal, SSS).
- **Substrate Horizontal Blend**: Mixes two materials side-by-side based on a mask (e.g., rust patches on painted steel).
- **Substrate Vertical Layer**: Physically coats one material on top of another (e.g., clear lacquer over metallic carbon fiber).
  - Handles **Beer-Lambert Light Absorption** through the coating layer!

### 3.2 Complex Carbon Fiber / Automotive Clearcoat Setup
```
[Substrate Slab: Base Carbon Fiber]
  (Roughness = 0.45, Anisotropy = 0.8, Base Color = Dark Gray)
                       │
                       v (Bottom Input)
[Substrate Vertical Layer] <── (Top Input: [Substrate Slab: Clearcoat])
                       │                     (Roughness = 0.02, IOR = 1.5)
                       v
              [Substrate Output]
```

---

## 4. Runtime Virtual Textures (RVT) for Seamless Terrain Blending

Eliminates the ugly hard seam where rocks, boulders, and buildings slice into terrain.

### The RVT Workflow:
1. Create two RVT Assets: `RVT_Terrain_Material` (Albedo, Normal, Roughness) and `RVT_Terrain_Height`.
2. Add a `Runtime Virtual Texture Volume` in the level covering the landscape.
3. In the rock/prop master material:
   - Sample `Runtime Virtual Texture Parameter` (`RVT_Terrain_Material`).
   - Calculate world height distance to terrain:
     $$\Delta h = \text{AbsoluteWorldPosition.Z} - \text{RVT\_Height.Z}$$
   - Lerp rock Albedo, Normal, and Roughness with the sampled RVT terrain data over a soft falloff ($\Delta h \in [0, 25\text{ cm}]$).
4. Add **Pixel Depth Offset (PDO)** to softly blend the geometry intersection depth.

---

## 5. Niagara VFX & GPU Particle Simulation

### 5.1 Skeletal Mesh Surface Reproduction
To emit sparks, fire, or digital dissolution particles from a moving character:
1. In Niagara Emitter, add module **Initialize Particle**.
2. Add module **Skeletal Mesh Location**:
   - Assign user parameter for the character's `SkeletalMeshComponent`.
   - Set Sampling Mode to `Surface Triangles` or `Surface Vertices`.
3. Add module **Sample Skeletal Mesh Skinning Data**:
   - Reads deformed vertex positions and normals directly from GPU skinning buffers.
4. Set Particle Velocity = `SkeletalMesh.Normal * Speed + SkeletalMesh.Velocity`.

---

## 6. Procedural Content Generation (PCG) Framework

Replaces manual prop placement and foliage painting with graph-driven procedural generation.

### Essential PCG Node Pipeline:
```
[Input: Landscape / Spline]
          │
          v
[Surface Sampler] (Density = 0.05, Point Extents = (100, 100, 100))
          │
          v
[Density Filter] (Min = 0.3, Max = 1.0)
          │
          v
[Difference / Exclude] <── [Road Spline Sampler (Bounds + 200cm)]
          │
          v
[Transform Points] (Random Yaw = 0..360, Random Scale = 0.8..1.25)
          │
          v
[Static Mesh Spawner] (Selects from Rock / Tree Weighted Meshes)
```
- **Difference Node**: Automatically carves roads, paths, and building clearings out of forest scatter points.
