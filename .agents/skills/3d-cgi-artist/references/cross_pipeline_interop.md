# Cross-Pipeline Interoperability: Formats, Coordinates & Asset Exchange

> *"A model is only as good as its pipeline. An asset created in Blender that looks breathtaking in the viewport but breaks in Unreal or Unity due to inverted tangents, missing scale transforms, or scrambled channel masks is a failed asset."*

---

## 1. The Coordinate System & Handedness Matrix

The single greatest source of flipped faces, inverted animations, and backward lights:

```
Blender (Right-Handed, Z-Up)         Unreal Engine 5 (Left-Handed, Z-Up)
           +Z (Up)                              +Z (Up)
            |                                    |
            |   +Y (Forward)                     |   +X (Forward)
            |  /                                 |  /
            | /                                  | /
-X <--------+--------> +X (Right)      -Y <------+--------> +Y (Right)

Unity (Left-Handed, Y-Up)
           +Y (Up)
            |
            |   +Z (Forward)
            |  /
            | /
-X <--------+--------> +X (Right)
```

### Conversion Formulas:
- **Blender $\rightarrow$ Unreal Engine 5**:
  - Transform: $(X, Y, Z) \rightarrow (X, -Y, Z) \times 100$ (Swap handedness by negating $Y$, scale by $100$).
  - In FBX Exporter: Set `Forward: X Forward`, `Up: Z Up`, check `Apply Unit Scale`, check `!EXPERIMENTAL! Apply Transform`.
- **Blender $\rightarrow$ Unity**:
  - Transform: $(X, Y, Z) \rightarrow (-X, Z, Y)$ (Swap $Y$ and $Z$, negate $X$).
  - In FBX Exporter: Set `Forward: -Z Forward`, `Up: Y Up`, check `Apply Transform`.

---

## 2. Normal Map Green Channel Convention (DirectX vs OpenGL)

A normal map encodes tangent-space vectors:
$$\vec{V} = \left(2R - 1, \; 2G - 1, \; 2B - 1\right)$$

| Engine / DCC | Standard | Green Channel Direction | Appearance in 2D Viewer |
| :--- | :--- | :--- | :--- |
| **Blender** | OpenGL ($+Y$) | Green illuminates from **Above** | Bumps appear lit from top |
| **Unity** | OpenGL ($+Y$) | Green illuminates from **Above** | Bumps appear lit from top |
| **Unreal Engine 5** | DirectX ($-Y$) | Green illuminates from **Below** | Bumps appear lit from bottom (inverted) |
| **Substance 3D** | Selectable | Choose DirectX or OpenGL in Project Settings | Matches target |

### How to Fix in Engine Without Re-exporting:
- **Unreal Engine**: Open the Texture Editor $\rightarrow$ check `Flip Green Channel` under Texture Settings.
- **Unity**: In Shader Graph, add a `Multiply` node on the Green channel by $-1.0$.
- **Blender**: In Shader Editor, insert `Separate Color` $\rightarrow$ `Math (Subtract 1.0 - Green)` $\rightarrow$ `Combine Color`.

---

## 3. PBR Texture Channel Packing Conventions

Real-time engines pack grayscale scalar masks into single RGBA textures to drastically reduce texture samplers and GPU cache misses:

### 3.1 Unreal Engine 5 Standard: **ORM Map**
- **R (Red)**: **O**cclusion (Ambient Occlusion / Cavity)
- **G (Green)**: **R**oughness ($0.0 = \text{mirror}, 1.0 = \text{diffuse matte}$)
- **B (Blue)**: **M**etallic ($0.0 = \text{dielectric}, 1.0 = \text{pure metal}$)
- **A (Alpha)**: *Optional* (Height / Displacement or Emissive Mask)
> **Crucial Engine Setting**: Always uncheck `sRGB` on the ORM texture in Unreal! These are linear mathematical data, not color data.

### 3.2 Unity HDRP / URP Standard: **Mask Map**
- **R (Red)**: Metallic
- **G (Green)**: Ambient Occlusion
- **B (Blue)**: Detail Mask (controls micro-detail map blending)
- **A (Alpha)**: Smoothness ($1.0 - \text{Roughness}$)
> **Notice**: Unity uses **Smoothness** (inverted Roughness)! Invert the roughness channel ($S = 1.0 - R$) before packing into Alpha.

---

## 4. Modern File Formats: USD, glTF 2.0 & Alembic

### 4.1 USD (Universal Scene Description - OpenUSD)
- The Pixar open-source foundation for VFX, virtual production, and omniverse pipelines.
- **Composition Arcs**: Enables non-destructive collaboration:
  - `Sublayers`: Layering departments (Layout $\rightarrow$ Animation $\rightarrow$ Lighting).
  - `References`: Reusable asset instancing.
  - `Variants`: Instant switching between LODs, materials (e.g. Clean vs Battle-Damaged).
- **UsdPreviewSurface**: Cross-platform standard PBR material description.

### 4.2 glTF 2.0 (GL Transmission Format)
- The royalty-free runtime standard for 3D on the web, AR, and game interchange.
- Strictly specifies the PBR Metallic-Roughness workflow.
- Format extensions:
  - `KHR_materials_transmission`: Real-time refractive glass.
  - `KHR_materials_volume`: Absorption and thickness for subsurface scattering.
  - `KHR_materials_clearcoat`: Automotive clear lacquer.
  - `KHR_materials_ior`: Physical index of refraction.

### 4.3 Alembic (`.abc`)
- Baked point-cache format for geometry that cannot be represented by bone transforms.
- **Mandatory For**:
  - Cloth simulations with self-collision.
  - Fluid splashes and ocean spray meshes.
  - Demolition and fracturing geometry with dynamic topology count changes.
  - **Motion Blur Requirement**: Ensure `Export Velocities` (`vel` attribute) is enabled; without point velocities, real-time engines cannot compute motion blur vectors for deforming caches.
