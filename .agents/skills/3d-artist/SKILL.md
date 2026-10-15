---
name: 3d-artist
description: >-
  Thinks and executes like a master 3D environmental artist and technical director to recreate scenes in absolute,
  uncompromising photographic fidelity. Enforces the 70-20-10 form hierarchy, anatomical botanical branching,
  biome stratification, transferred envelope normals for soft foliage, multi-layer procedural PBR rhytidome,
  thin-wall subsurface scattering (SSS), and physically-grounded volumetric lighting with Henyey-Greenstein Mie scattering.
---

# Master 3D Artist Skill (Environmental & Botanical Photorealism)

The **Master 3D Artist Skill** equips AI agents to design, sculpt, texture, and light 3D environments with the trained eye, physical intuition, and technical discipline of a senior VFX environment supervisor and master 3D artist.

Photorealism is not achieved by cranking polygon counts or stacking post-processing filters. It is achieved through **adherence to natural physics, biological morphogenesis, radiative transfer, and optical camera behavior**.

---

## 1. How Master 3D Artists Achieve Hyper-Photorealism

When world-class 3D artists construct natural landscapes, they follow five foundational disciplines:

### 1. The 70-20-10 Form Hierarchy (Abbitt / VFX Standard)
```
                       [THE 70-20-10 HIERARCHY]
 ┌────────────────────────────────────────────────────────────────────────┐
 │ 70% PRIMARY FORMS: Gesture, Silhouette, Bounding Masses, Dominance    │
 │   - Fluted root buttress flares anchoring deep into subterranean soil   │
 │   - Phototropic trunk lean & non-linear taper (Da Vinci caliper rule)  │
 │   - Undulating micro-topography & nurse logs breaking planar horizons  │
 ├────────────────────────────────────────────────────────────────────────┤
 │ 20% SECONDARY FORMS: Anatomical Branches, Boughs, Fronds, Cracks       │
 │   - Ramified boughs following Golden Ratio phyllotaxis (137.5°)        │
 │   - Arching fern rachis with alternating serrated pinnule blades        │
 │   - Deep longitudinal bark furrows & cork plate plateaus                │
 ├────────────────────────────────────────────────────────────────────────┤
 │ 10% TERTIARY FORMS: Micro-Textures, Moss Decals, SSS, Volumetrics      │
 │   - Transferred clump envelope normals (eliminates paper-cut cards)     │
 │   - Backlit leaf blade transmission & subsurface scattering (SSS)      │
 │   - Organic velvet moss gradients on northern damp bark faces          │
 │   - Radiative volumetric participating media & crepuscular sunbeams    │
 └────────────────────────────────────────────────────────────────────────┘
```

### 2. Physical Radiative Transfer & Volumetric Lighting
True volumetric lighting in nature is governed by the **Radiative Transfer Equation (RTE)**:
$$\frac{dL(\mathbf{x}, \mathbf{\omega})}{ds} = -\sigma_t(\mathbf{x}) L(\mathbf{x}, \mathbf{\omega}) + \sigma_s(\mathbf{x}) \int_{4\pi} p(\mathbf{\omega}', \mathbf{\omega}) L(\mathbf{x}, \mathbf{\omega}') d\mathbf{\omega}'$$

- **Henyey-Greenstein Phase Function ($g \approx 0.75 - 0.85$)**:
  $$p(\cos\theta) = \frac{1 - g^2}{4\pi (1 + g^2 - 2g\cos\theta)^{3/2}}$$
  In humid temperate forests, aerosols, water vapor, and suspended spore particles cause strong **forward Mie scattering**. When the camera looks toward the morning sun (*contre-jour*), the air glows intensely with golden radiance, whereas looking away yields deep, saturated shadows.
- **Crepuscular Ray Formation (Shadow Occlusion in Media)**:
  God rays are not glowing solids; they are the **illuminated regions of participating air** interspersed between shadow volumes cast by dense canopy openings and massive tree trunks.
- **Dual-Band Atmospheric Mist**:
  Combine exponential height falloff ($\rho(y) = \rho_0 e^{-y/H}$) for ground morning mist with linear Beer-Lambert extinction along the camera ray ($T(s) = \exp(-\sigma_t \cdot s)$).

### 3. Thin-Wall Subsurface Scattering (SSS) for Plant Tissues
- In reality, leaves and fern pinnules are thin translucent biological membranes ($0.2\text{mm} - 0.5\text{mm}$) containing chlorophyll suspended in water.
- Flat diffuse materials turn dark black when backlit. Real vegetation exhibits **dual-sided backface transmission**:
  $$L_{\text{trans}} = \mathbf{C}_{\text{transmission}} \cdot \max(0, -\mathbf{N} \cdot \mathbf{L}) \cdot \text{Thickness}^{-1}$$
  Backlit fern fronds and canopy leaves must ignite with brilliant, translucent lime-yellow glow ($\mathbf{L} \cdot -\mathbf{V}$).

### 4. Transferred Envelope Normals ("Data Transfer" Technique)
- **The Origami Card Trap**: Foliage cards shaded with raw polygon face normals produce visible rectangular seams and artificial faceted glints under sunlight.
- **Master Artist Solution**: Construct a bounding spherical or ellipsoidal helper envelope around each branch clump and project the smooth outward radial vector onto the card vertices:
  $$\mathbf{N}_{\text{shading}} = \text{normalize}\left(\frac{\mathbf{P} - \mathbf{C}_{\text{clump}}}{\|\mathbf{P} - \mathbf{C}_{\text{clump}}\|} + \alpha \mathbf{Up}\right)$$
  This softens individual cards into continuous volumetric leafy masses that catch soft rim and ambient light.

### 5. Ground-Truth Palette & Texture Derivation
- Real forests are **not lime green**. A statistical sampling of National Geographic temperate redwood photography demonstrates:
  - **Bark**: Rich deep reddish heartwood (`RGB ~ [0.21, 0.20, 0.14]`), cleft shadows (`[0.10, 0.05, 0.03]`), sunlit cork ridges (`[0.34, 0.32, 0.25]`).
  - **Forest Floor**: 85% is deep reddish-brown redwood needle duff (`[0.19, 0.19, 0.07]`) and dark moist organic loam (`[0.12, 0.08, 0.05]`). Pure green moss is strictly localized on elevated moist hummock mounds (`[0.20, 0.26, 0.10]`).
  - **Understory Ferns**: Deep chlorophyll emerald (`[0.14, 0.17, 0.07]`) with sun-transmitting tips (`[0.26, 0.35, 0.15]` to `[0.50, 0.82, 0.18]`).
  - **Atmospheric Mist**: Neutral silver-green ambient (`[0.21, 0.21, 0.19]`) with warm golden sunbeam cores (`[0.98, 0.94, 0.74]`).

---

## 2. Codebase Tools & Native Engine Integrations

Scratchbox IDE contains production-grade Python nanobind, native C++20, and TypeScript systems that directly map to these disciplines:

| Discipline | Python Nanobind & Gemini Tools | Native C++20 Engine | TypeScript / Viewport |
| :--- | :--- | :--- | :--- |
| **Hero 3D Assets** | `execute_3d_python_script` (`import scratchbox as sb`, `sb.PbrMaterial.clay()`) | `#include "scratchbox_engine.hpp"` | Pure WebGL rendering, camera CAD controls |
| **Botanical Growth** | `botanical_synthesize_tree` (`heightMeters`, `crownDiameterMeters` required; `crownBaseHeightMeters`, `trunkRadiusMeters`, `triangleBudget`); a place's own trees come from `google_3d_tiles_get_clay` | `#include "scratchbox_nature.hpp"` (space colonisation), `"scratchbox_tile_vegetation.hpp"` | `TileVegetationService` (strip / plant), `SbVeggieService` |
| **Volumetric Lighting** | `atmosphere_configure_scene`, `atmosphere_harmonize_location_3d` | `#include "scratchbox_volumetrics.hpp"` (`marchVolumetrics`, `henyeyGreensteinPhase`) | `VolumetricGodRays.ts`, `volumetric-participating-media.ts` |
| **Thin-Wall SSS** | Subsurface transmission parameters in material shaders | `#include "scratchbox_sss.hpp"` (`evaluateThinWallTransmission`) | Custom GLSL shader chunks injecting backface transmission |
| **Procedural Textures** | `sb.pbr` continuous material procedural generators | `#include "scratchbox_pbr_texture_expert.hpp"` | Multi-layer Worley F1/F2 rhytidome, packed ORM textures |
| **Multi-Mesh glTF** | Direct binary GLB streaming via `execute_3d_python_script` | `#include "scratchbox_io.hpp"` (`GlbWriter::serializeMultiMeshToGlb`) | Submesh PBR metallic-roughness material bindings |

---

## 3. Mandatory Workflow & Staging Sequence

When creating or sculpting any 3D asset or scene:

1. **Initial Asset in 18% Studio Grey Clay Void (When No Location Given)**:
   - Always build initial hero models in **18% Studio Grey Clay** (`sb.PbrMaterial.clay()`, roughness 0.85, albedo 0.55–0.60) in a clean studio void.
   - Enforce the **70-20-10 geometric form hierarchy** across all sub-assemblies.
2. **Explicit Location Staging Invariant (When Real Location Given)**:
   - If the user specifies a real-world location (e.g., *"monument in Central Park"*, *"car in Monaco"*), stage immediately using **Google 3D Tiles Studio Grey Clay** (`google_3d_tiles_get_clay` for the place, `build_3d_object_from_reference` with `location` and `placement` for one object standing there) or **Vector World Staging** (`stage_3d_vector_world`). `execute_3d_python_script` does not stage scripts on real places.
   - Zero synthetic ground slabs or lollipop trees in a void!
3. **Follow-Up Suggestions Sequence (Strictly Staging BEFORE Textures)**:
   - For standalone hero assets in a void, follow-up suggestions MUST proceed chronologically:
     1. **Lighting & Atmosphere**: 3-point high-contrast rim lighting, dramatic dusk twilight, or solar ephemeris.
     2. **Staging & Contextual Placement**: Real-world geographic staging with Google 3D Tiles Clay, vector road corridors, or curved infinity cyclorama cove.
     3. **Textures & PBR Materials**: Deep clearcoat automotive paint, bark rhytidome, weathered travertine, or carbon fiber weave.

---

## 4. The Master 3D Artist's Verification Gate

Before declaring any scene complete, evaluate against the **8-Dimension Visual Fidelity Rubric**:

1. [ ] **Silhouette Definition**: Trunks flare organically with buttress lobes diving below soil; no floating roots or cylinder primitives.
2. [ ] **Foliage Softness**: Envelope normals applied to all foliage; zero visible card facets or paper-cut boundaries.
3. [ ] **Ground Authenticity**: Rich organic needle duff and humus base; moss confined to natural moisture hummocks.
4. [ ] **Subsurface Radiance**: Backlit leaves and fern fronds glow with translucent lime transmission.
5. [ ] **Volumetric Coherence**: Sunbeams cast from a single motivated light source; forward Henyey-Greenstein Mie scattering softens glare into foreground shadows.
6. [ ] **Material Tactility**: Normal and ORM maps resolve bark cork fissures and leaf venation at sub-meter inspection.
7. [ ] **70-20-10 Geometric Form Hierarchy**: Primary structural envelope (70%), articulated secondary elements (20%), fine tertiary micro-details and fasteners (10%).
8. [ ] **Zero-Primitive Conformance**: Strictly zero flat Three.js client-side primitive constructors (`new THREE.BoxGeometry`, etc.). Generated via Python nanobind `scratchbox` or native C++20 engine.
9. [ ] **Depth Colonnade**: Clear foreground hero element, midground focus, and receding background corridor (30m+).
10. [ ] **The Squint Test**: When squinting at the scene thumbnail, values, color contrast, and lighting direction match an authentic photograph.
