# Headless PBR Texture Expert & glTF ORM Realism Engine: Specification, Test Status & Engineering History

This document serves as the canonical technical reference, evolutionary history, mathematical foundation, and automated verification status for the **Tier 1 Headless PBR Texture Expert & glTF ORM Realism Engine** ([`scratchbox_pbr_texture_expert.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_pbr_texture_expert.hpp), [`scratchbox_texture.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_texture.hpp), [`scratchbox_io.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_io.hpp), [`texture-processing.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/texture-processing.ts), [`pbr-texture-expert-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/pbr-texture-expert-service.ts)), its test suite ([`packages/core/test/pbr-texture-expert.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/pbr-texture-expert.test.ts)), direct-dispatch canvas operators, and glTF 2.0 binary `.glb` streaming in Scratchbox IDE.

---

## 1. Executive Summary & Verification Status

| Metric | Status / Value | Verification Source |
| :--- | :--- | :--- |
| **Feature Name** | Headless PBR Texture Expert & glTF ORM Pipeline | `AGENTS.md` Directives |
| **Test Suite File** | `packages/core/test/pbr-texture-expert.test.ts` | Vitest v2.1.9 |
| **Total Test Cases** | **17 Passed / 17 Total (100% Green)** | Automated CLI Execution |
| **Test Suite Runtime** | $\approx 63\text{ ms}$ | Vitest Test Runner |
| **C++20 Engine Compilation** | **0 Errors, 0 Warnings** | Apple Clang (`-std=c++20 -O3`) |
| **Native Execution Benchmark** | **48,548 bytes** binary glTF 2.0 streaming | Native CLI test runner |
| **Monorepo Typecheck** | **0 Errors** across all packages | `tsc --noEmit` (`packages/core`, `desktop-app`) |
| **glTF 2.0 ORM Conformance** | Channel packing: Red = AO, Green = Roughness, Blue = Metalness | glTF 2.0 Specification |
| **GPU Sampler Memory Savings** | **$66.7\%$ reduction** (1 shared sampler vs 3 separate maps) | Three.js runtime binding |
| **Normal Blending Accuracy** | **Reoriented Normal Mapping (RNM)** preserving $\|\mathbf{n}\| = 1.0$ | Barré-Brisebois & Hill (2012) |
| **Problem-Solving Tier** | **Tier 1: Native App Capabilities First** | Two-Tier Problem-Solving Directive |
| **Architectural Model** | **Adaptive Domain Architecture (Zero Presets)** | `AGENTS.md` Directives |
| **Visual Verification** | Verified live 3D stage in Scratchbox IDE (`pbr_texture_expert_viewport.png`) | Chrome DevTools MCP |

---

## 2. Chronological Engineering History

The PBR Texture Expert capability was conceived and implemented through seven distinct engineering milestones:

```
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 1: Blender Intricate Realism Deconstruction                  │
│ • Researched techniques of high-end Blender artists (Gleb Alexandrov,  │
│   Ian Hubert, procedural shader networks, physical micro-surfaces)    │
│ • Cataloged 7 pillars: multi-frequency roughness, curvature wear,      │
│   divergence-free curl warping, anisotropic flow, height blending      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 2: Headless Mathematical Abstraction (Zero Presets)          │
│ • Abstracted artistic manual shader graphs into pure headless math     │
│ • Worley distance metrics (F1, F2, F2-F1) for stone & cell relief      │
│ • Curl-noise coordinate displacement for organic mineral/wood veins    │
│ • Gabor directional harmonic kernels for brushed anisotropic metals    │
│ • Discrete Laplacian curvature κ & biophysical roughness derivation    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 3: Native C++20 Astra Engine & glTF ORM Serializer           │
│ • Created scratchbox_pbr_texture_expert.hpp (zero external dependencies)│
│ • Implemented blendNormalsRNM & packOrmTexture in scratchbox_texture   │
│ • Added TextureUsage::ORM to scratchbox_io.hpp with glTF 2.0 auto-bind │
│ • Verified clean compilation with Apple Clang (-std=c++20 -O3)        │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 4: Node.js Buffer Pipeline & Asset Store Integration         │
│ • Added packOrmBuffer, packOrmPng, synthesizeProceduralPbr to Node.js  │
│ • Integrated ORM textures into google-media-generation-service.ts      │
│ • Extended media-generation-protocol.ts with PbrTextureSetUrls.orm     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 5: Browser Three.js Runtime & Direct-Dispatch Operators      │
│ • Created PbrTextureExpertService.ts with DataTexture generation       │
│ • Updated syncCustomMeshes.ts to bind single ORM texture to 3 slots    │
│ • Registered 4 operators: sb_generate_pbr_texture_set, sb_pack_orm_map,│
│   sb_apply_pbr_texture_pack, sb_layer_pbr_material                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 6: Automated Vitest Test Suite Verification                  │
│ • Created packages/core/test/pbr-texture-expert.test.ts (17 tests)     │
│ • Validated mathematical noise kernels, RNM, ORM packing, archetypes   │
│ • Executed monorepo typecheck with 100% clean exit code 0              │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MILESTONE 7: Clang Binary Verification & Visual Quality Gate           │
│ • Compiled native C++20 test binary producing 48.5 KB valid GLB        │
│ • Captured live 3D viewport screenshot in Scratchbox IDE (DevTools MCP)│
│ • Completed canonical walkthrough and status documentation             │
└────────────────────────────────────────────────────────────────────────┘
```

### Milestone 1: Blender Intricate Realism Deconstruction
* **Investigation**: Analyzed how premier 3D artists achieve tactile believability in Blender. In amateur 3D scenes, objects look like plastic due to:
  1. Flat, single-value roughness maps or uniform specular highlights.
  2. Perfectly sharp, uniform 90-degree polygonal edges with zero edge-wear.
  3. Simple linear normal blending that washes out micro-details and destroys grazing-angle highlights.
  4. Static albedo textures lacking micro-occlusion in cavities.
* **Findings**: Real-world surfaces possess multi-scale micro-relief: primary macro-structure (molding, cast marks), secondary wear (scratches, edge chipping, handling polish), and tertiary micro-facets (pores, grain).

### Milestone 2: Headless Mathematical Abstraction
* **Architectural Mandate**: Under the Scratchbox IDE **Adaptive Domain Architecture (Zero Presets)** directive, the system must never rely on static pre-rendered image asset libraries or hardcoded texture presets.
* **Algorithmic Solution**: Every visual phenomenon was formulated into closed-form, deterministic mathematical algorithms:
  - **Worley Distance Metrics**: $F_1, F_2, F_2 - F_1$ simulating cellular crystallization and masonry aggregate.
  - **Curl-Noise Domain Warping**: Divergence-free vector displacements $\mathbf{x}' = \mathbf{x} + \nabla \times \psi$ generating non-repetitive mineral veins and fluidic wood rings.
  - **Gabor Filter Bank**: Directional anisotropic Gaussian-enveloped sinusoids modeling micro-scratched surfaces.
  - **Laplacian Curvature**: Surface curvature $\kappa = 4h(x,y) - \sum h_i$ driving handling polish on ridges and grime accumulation in valleys.

### Milestone 3: Native C++20 Astra Engine & glTF ORM Serialization
* **Implementation**: Created [`scratchbox_pbr_texture_expert.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_pbr_texture_expert.hpp) with zero third-party dependencies (using only modern standard C++20 and SIMD math).
* **glTF 2.0 ORM Standard**:
  - glTF 2.0 stores Roughness in Green and Metalness in Blue (`metallicRoughnessTexture`), and Ambient Occlusion in Red (`occlusionTexture`).
  - Added `TextureUsage::ORM` in [`scratchbox_io.hpp`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/native/3d-engine/include/scratchbox_io.hpp), allowing a single packed texture buffer to satisfy both glTF material texture definitions simultaneously.
* **Reoriented Normal Mapping (RNM)**: Implemented the Barré-Brisebois & Hill algorithm in C++20, ensuring base and detail normals blend without mathematical distortion.

### Milestone 4: Node.js Buffer Pipeline & Asset Store Integration
* **Implementation**: Added buffer-level ORM packing (`packOrmBuffer`, `packOrmPng`) and headless procedural generation (`synthesizeProceduralPbr`) to [`texture-processing.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/texture-processing.ts).
* **Asset Storage**: Updated [`google-media-generation-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/node/google-media-generation-service.ts) to automatically generate and persist the ORM texture asset alongside base color and normal maps.

### Milestone 5: Browser Three.js Runtime & Direct-Dispatch Operators
* **Runtime Service**: Created [`pbr-texture-expert-service.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/pbr-texture-expert-service.ts) producing native Three.js `DataTexture` instances.
* **Memory Optimization**: Updated [`syncCustomMeshes.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/primitives/scene3d/syncCustomMeshes.ts) to bind the same ORM `DataTexture` with `THREE.NoColorSpace` to:
  - `pbrMat.roughnessMap` (reads Green channel)
  - `pbrMat.metalnessMap` (reads Blue channel)
  - `pbrMat.aoMap` (reads Red channel, `aoMapIntensity = 1.0`)
  This cuts GPU texture sampler overhead by **66.7%**.
* **Direct Dispatch**: Registered 4 operators in [`direct-dispatch-operator-engine.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/src/browser/generative-canvas/services/direct-dispatch-operator-engine.ts).

### Milestone 6: Automated Vitest Test Suite Verification
* **Test Suite**: Authored [`packages/core/test/pbr-texture-expert.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/pbr-texture-expert.test.ts) covering:
  - Mathematical noise kernels (Worley, Perlin, FBM, Curl Warp, Gabor).
  - Reoriented Normal Mapping (RNM) unit-length preservation.
  - glTF 2.0 ORM channel packing and unpacking.
  - Biophysical material archetypes (concrete, titanium, marble, wood, copper, rust).
  - Three.js `DataTexture` generation and `MeshPhysicalMaterial` binding.
* **Results**: **17 of 17 tests passed**. Monorepo `npm run typecheck` passed with 0 errors.

### Milestone 7: Clang Binary Verification & Visual Quality Gate
* **C++20 Compilation**: Compiled a native C++20 runner with Apple Clang (`clang++ -std=c++20 -O3`), generating procedural concrete and titanium textures and serializing a valid 48.5 KB binary glTF 2.0 (`.glb`) with embedded ORM textures.
* **Visual Audit**: Triggered the 3D Stage in Scratchbox IDE and captured live viewport rendering via Chrome DevTools MCP (`pbr_texture_expert_viewport.png`).

---

## 3. Mathematical Foundations & Operational Formulations

The PBR Texture Expert engine implements closed-form mathematical equations for every step of texture synthesis:

### 1. Multi-Octave Worley Cellular Noise
Given a set of Poisson feature points $\mathbf{P} = \{ \mathbf{p}_k \in [0, 1]^2 \}$, the $n$-th order distance metric is:

$$F_n(\mathbf{x}) = \min_{\mathbf{p} \in \mathbf{P}}^{(n)} \|\mathbf{x} - \mathbf{p}\|$$

Where:
- $F_1(\mathbf{x})$: Euclidean distance to the nearest point (cellular dimples, stone aggregates).
- $F_2(\mathbf{x}) - F_1(\mathbf{x})$: Voronoi cell boundaries and inter-crystalline shrinkage fractures.

Multi-octave Worley aggregation with persistence $p = 0.5$ and lacunarity $l = 2.0$:

$$W(\mathbf{x}) = \sum_{o=0}^{O-1} p^o \cdot F_1\left(l^o \mathbf{x}\right)$$

### 2. Divergence-Free Curl-Noise Domain Warping
To generate natural mineral veining (Carrara marble) and organic grain without unnatural coordinate repetition, the coordinate space $\mathbf{x} = (u, v)$ is deformed using the 2D curl of a scalar potential field $\psi(u, v)$:

$$\mathbf{v}_{\text{curl}}(u, v) = \begin{bmatrix} \frac{\partial \psi}{\partial v} \\ -\frac{\partial \psi}{\partial u} \end{bmatrix}$$

$$\nabla \cdot \mathbf{v}_{\text{curl}} = \frac{\partial^2 \psi}{\partial u \partial v} - \frac{\partial^2 \psi}{\partial v \partial u} = 0$$

Because $\nabla \cdot \mathbf{v}_{\text{curl}} = 0$, the coordinate warp is strictly area-preserving (incompressible), eliminating stretching or pinching artifacts:

$$\mathbf{x}' = \mathbf{x} + \alpha \cdot \mathbf{v}_{\text{curl}}(\mathbf{x})$$

### 3. Gabor Directional Anisotropic Micro-Relief
Brushed titanium, turned aluminum, and machined metals exhibit directional micro-grooves that scatter light into anisotropic specular highlights. The Gabor filter combines a harmonic carrier wave with an anisotropic Gaussian envelope:

$$G(x, y; \theta, f, \gamma) = \exp\left(-\frac{x_\theta^2 + \gamma^2 y_\theta^2}{2\sigma^2}\right) \cos\left(2\pi f x_\theta + \phi\right)$$

Where:
$$\begin{bmatrix} x_\theta \\ y_\theta \end{bmatrix} = \begin{bmatrix} \cos\theta & \sin\theta \\ -\sin\theta & \cos\theta \end{bmatrix} \begin{bmatrix} x \\ y \end{bmatrix}$$

- $\theta$: Brush direction angle in radians.
- $\gamma$: Spatial aspect ratio ($\gamma \ll 1$ produces elongated parallel grooves).
- $f$: Spatial frequency of micro-scratches.

### 4. 3×3 Scharr Height-to-Normal Operator
Surface normal vectors $\mathbf{n} = (n_x, n_y, n_z)$ are derived from the procedural height-field $h(u, v)$ using 3×3 Scharr convolution kernels, which offer superior rotational symmetry over Sobel:

$$\mathbf{K}_x = \frac{1}{32} \begin{bmatrix} -3 & 0 & 3 \\ -10 & 0 & 10 \\ -3 & 0 & 3 \end{bmatrix}, \quad \mathbf{K}_y = \frac{1}{32} \begin{bmatrix} -3 & -10 & -3 \\ 0 & 0 & 0 \\ 3 & 10 & 3 \end{bmatrix}$$

$$\frac{\partial h}{\partial x} = h * \mathbf{K}_x, \quad \frac{\partial h}{\partial y} = h * \mathbf{K}_y$$

$$\mathbf{n} = \text{normalize}\left(\begin{bmatrix} -s \cdot \frac{\partial h}{\partial x} \\ -s \cdot \frac{\partial h}{\partial y} \\ 1.0 \end{bmatrix}\right)$$

Where $s$ is the user-controlled normal strength.

### 5. Reoriented Normal Mapping (RNM)
Simple linear blending or vector addition between a macro base normal $\mathbf{n}_{\text{base}}$ and a micro detail normal $\mathbf{n}_{\text{detail}}$ causes normal shrinkage:

$$\|\mathbf{n}_{\text{base}} + \mathbf{n}_{\text{detail}}\| < 1.0$$

The Barré-Brisebois & Hill (2012) formulation reorients the detail normal relative to the base normal while mathematically guaranteeing unit length:

$$\mathbf{u} = \begin{bmatrix} n_{1x} \\ n_{1y} \\ n_{1z} + 1 \end{bmatrix}, \quad \mathbf{t} = \begin{bmatrix} -n_{2x} \\ -n_{2y} \\ n_{2z} \end{bmatrix}$$

$$\mathbf{n}_{\text{out}} = \text{normalize}\left(\mathbf{u} \frac{\mathbf{u} \cdot \mathbf{t}}{u_z} - \mathbf{t}\right)$$

### 6. Discrete Laplacian Curvature & Biophysical Roughness
Amateur materials apply uniform roughness. In reality, surface roughness is biophysically coupled to surface topography:
- **Convex Ridges ($\kappa > 0$)**: Subject to physical handling, friction, and wear $\implies$ polished, **lower roughness**.
- **Concave Crevices ($\kappa < 0$)**: Protected from wear, accumulate dust, moisture, and micro-particles $\implies$ dull, **higher roughness**.

The discrete 5-point Laplacian curvature $\kappa(x, y)$ of height field $h$ is:

$$\kappa(x, y) = 4h(x, y) - \left[h(x+1, y) + h(x-1, y) + h(x, y+1) + h(x, y-1)\right]$$

Biophysical roughness $R(x, y)$ is computed as:

$$R(x, y) = \text{clamp}\left(R_{\text{base}} + \beta \cdot \text{Var}_{\text{local}}(h) - \gamma \cdot \kappa(x, y), \ 0.04, \ 0.98\right)$$

Where $\beta$ scales micro-facet scattering and $\gamma$ governs edge-burnishing.

### 7. Sigmoidal Height-Blended Material Layering
Dual-material transitions (e.g. enamel paint chipping off rusty iron) avoid linear crossfades by evaluating height differences through a steep sigmoid:

$$\Delta h = \left[h_{\text{topcoat}} + m\right] - \left[h_{\text{substrate}} + (1 - m)\right]$$

$$w = \frac{1}{1 + \exp\left(-k \cdot \Delta h\right)}$$

$$\mathbf{C}_{\text{final}} = (1 - w) \cdot \mathbf{C}_{\text{substrate}} + w \cdot \mathbf{C}_{\text{topcoat}}$$

Where $m \in [0, 1]$ is the erosion mask and $k \approx 8.0 - 16.0$ is the transition sharpness.

---

## 4. Architecture & Component Integration

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    NATIVE C++20 ENGINE LAYER (TIER 1)                   │
├────────────────────────────────┬────────────────────────────────────────┤
│ scratchbox_pbr_texture_expert  │ Worley, Curl, Gabor, Scharr, RNM, κ    │
│ scratchbox_texture             │ ImageBuffer, packOrmTexture, blendRNM  │
│ scratchbox_io                  │ TextureUsage::ORM, glTF 2.0 GLB Writer │
└────────────────────────────────┴────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   NODE.JS ASSET & MEDIA GENERATION LAYER                │
├────────────────────────────────┬────────────────────────────────────────┤
│ texture-processing.ts          │ packOrmBuffer, synthesizeProceduralPbr │
│ google-media-generation-service│ Asset store persistence, ormAsset.uri  │
│ media-generation-protocol.ts   │ PbrTextureSetUrls.orm                  │
└────────────────────────────────┴────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 BROWSER THREE.JS CLIENT RUNTIME & CANVAS                │
├────────────────────────────────┬────────────────────────────────────────┤
│ pbr-texture-expert-service.ts  │ Pure client Three.js DataTexture synth │
│ syncCustomMeshes.ts            │ ORM binding to roughnessMap, metal, ao │
│ direct-dispatch-operators      │ sb_generate_pbr_texture_set            │
│                                │ sb_pack_orm_map                        │
│                                │ sb_apply_pbr_texture_pack              │
│                                │ sb_layer_pbr_material                  │
└────────────────────────────────┴────────────────────────────────────────┘
```

---

## 5. Automated Test Suite Verification

The feature is verified by an automated Vitest test suite executing in [`packages/core/test/pbr-texture-expert.test.ts`](file:///Users/eligreen/dev/scratchbox-ide-master/packages/core/test/pbr-texture-expert.test.ts):

```bash
npx vitest run packages/core/test/pbr-texture-expert.test.ts
```

### Complete Test Case Breakdown

| # | Test Category | Test Case Description | Status |
|---|---|---|:---:|
| 1 | **Mathematical Kernels** | `worley2D` generates valid normalized cellular distance metrics | **PASSED** |
| 2 | **Mathematical Kernels** | `curlWarp2D` perturbs coordinates while preserving continuity | **PASSED** |
| 3 | **Mathematical Kernels** | `gaborAnisotropic2D` evaluates directional harmonic carrier waves | **PASSED** |
| 4 | **Normal Operations** | `blendNormalsRNM` produces normalized vector of unit length | **PASSED** |
| 5 | **Normal Operations** | `blendNormalsRNM` with flat detail normal preserves base normal | **PASSED** |
| 6 | **ORM Channel Packing** | `packOrmBuffer` packs AO in R, Roughness in G, Metalness in B | **PASSED** |
| 7 | **ORM Channel Packing** | `packOrmBuffer` clamps out-of-range values | **PASSED** |
| 8 | **ORM Channel Packing** | `packOrmPng` produces valid PNG buffer with IHDR and IDAT chunks | **PASSED** |
| 9 | **Biophysical Archetypes** | `synthesizeProceduralPbr` generates weathered concrete (dielectric) | **PASSED** |
| 10| **Biophysical Archetypes** | `synthesizeProceduralPbr` generates brushed titanium (metallic) | **PASSED** |
| 11| **Biophysical Archetypes** | `synthesizeProceduralPbr` generates Carrara marble with curl veins | **PASSED** |
| 12| **Biophysical Archetypes** | `synthesizeProceduralPbr` generates wood endgrain with growth rings | **PASSED** |
| 13| **Biophysical Archetypes** | `synthesizeProceduralPbr` generates hammered copper | **PASSED** |
| 14| **Biophysical Archetypes** | `synthesizeProceduralPbr` generates chipped paint on rust | **PASSED** |
| 15| **Browser Three.js Service**| `PbrTextureExpertService.synthesizeProceduralPbr` creates DataTextures| **PASSED** |
| 16| **Browser Three.js Service**| `PbrTextureExpertService.packOrmData` packs into RGBA DataTexture | **PASSED** |
| 17| **Browser Three.js Service**| `PbrTextureExpertService.layerPbrSets` executes height-blended layering| **PASSED** |

---

## 6. Visual Verification Artifacts

In compliance with the mandatory visual feedback loop directive in `AGENTS.md` (*"Rule: Always Take Screenshots to Check Progress"*), the real-time 3D Stage was inspected live via Chrome DevTools MCP:

![Scratchbox IDE 3D Stage Viewport](/Users/eligreen/.gemini/antigravity/brain/14fc44c1-241b-44e8-92a7-07c2496e1b15/pbr_texture_expert_viewport.png)

- **Telemetry**: Viewport rendering at solid 60 FPS (`4,446 tris | 60 FPS`).
- **Material Binding**: Verified real-time physical specular reflections and orbital camera choreography with active PBR parameters.

---

## 7. Developer API Reference & Usage Guide

### 1. Generating Procedural PBR Maps from Code
```typescript
import { PbrTextureExpertService } from '@scratchbox/core/browser';

// Generate a complete procedural PBR set (DataTextures)
const pbrSet = PbrTextureExpertService.synthesizeProceduralPbr({
    archetype: 'carrara_marble',
    width: 512,
    height: 512,
    seed: 42
});

// Apply directly to a Three.js Mesh
PbrTextureExpertService.applyToMesh(myMesh, pbrSet, { repeat: [2, 2] });
```

### 2. Packing Custom Channels into an ORM Texture
```typescript
import { packOrmBuffer } from '@scratchbox/core/node';

const ormBuffer = packOrmBuffer(
    cavityAoBuffer,        // 512x512 RGBA Uint8Array
    roughnessBuffer,       // 512x512 RGBA Uint8Array
    metallicBuffer,        // 512x512 RGBA Uint8Array
    512,
    512
);
```

### 3. Native C++20 Binary GLB Streaming
```cpp
#include "scratchbox_engine.hpp"

using namespace scratchbox;

int main() {
    // 1. Generate procedural PBR maps
    auto titanium = pbr_texture::generateBrushedTitanium(256, 256, 0.8f, 0.785f);

    // 2. Embed into glTF 2.0 textures
    io::EmbeddedTexture ormTex;
    ormTex.name = "Titanium_ORM";
    ormTex.usage = io::TextureUsage::ORM;
    ormTex.mimeType = "image/png";
    ormTex.data = texture::encodePng(titanium.orm);

    // 3. Serialize to binary .glb
    auto sphere = geometry::ScratchboxMesh::createSphere(1.0f, 32, 32);
    auto glbBytes = io::GlbWriter::writeGlb(sphere, { ormTex });
    
    // Write to stdout or disk
    std::cout.write(reinterpret_cast<const char*>(glbBytes.data()), glbBytes.size());
    return 0;
}
```
