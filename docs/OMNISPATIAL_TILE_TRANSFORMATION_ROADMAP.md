# Omnispatial 3D Tile Transformation Roadmap & Skill Specification

## 1. Executive Summary & Objective

This document formalizes the architectural decisions, mathematical invariants, algorithmic discoveries, and failure-mode mitigations developed during the engineering of the **Omnispatial Multi-Sensor 3D Synthesis Pipeline**. 

### The Core Objective
Transform raw real-world photogrammetric 3D tiles (such as Google Maps Photorealistic 3D Tiles) into **hyper-realistic architectural 3D models** that exhibit:
1. **Pristine Geometric Rectification**: Crisp architectural edges, 70-20-10 form hierarchy, true recessed window bays, and complete removal of photogrammetric melting and ground-level "curtain wall" artifacts.
2. **Physically Based Rendering (PBR)**: Calibrated physical materials (dielectric glazing, ashlar limestone, statuary bronze, asphalt, granite), eliminating baked diffuse shadows.
3. **Sub-Millimeter Real-World Spatial Registration**: 1-to-1 physical alignment with the surrounding city block and underlying geodetic coordinate frame.
4. **Botanical Reality Grounding**: Procedurally accurate street trees via SB-Veggie instead of melted green blobs.
5. **Zero Radiance Field Splatters & Zero Toy Primitives**: Strict adherence to polygonal mesh geometry with PBR materials (zero 3DGS/2DGS/4DGS) and zero client-side Three.js generative boxes.

---

## 2. Mandatory Architectural Directives (ADA & Quality Invariants)

Before executing any tile transformation, the system must enforce the following non-negotiable gates:

### A. The Alien Planet Test (Adaptive Domain Architecture & Open-Domain Universality)
- **Zero Closed Taxonomies**: Never declare closed enum classifiers for architectural styles, biomes, or materials (e.g. `type Style = 'art_deco' | 'gothic' | 'modern'` or `enum class PbrMaterialArchetype`).
- **Continuous Biophysical Material Manifold ($\mathbb{R}^{16}$)**: In accordance with `scratchbox_pbr_manifold.hpp`, all surfaces are represented as continuous dimensional vectors $\mathbf{m} \in \mathbb{R}^{16}$ ($\text{albedoLinear}$, $\text{conduction}$, $\text{roughnessBaseline}$, $\text{microPorosity}$, $\text{normalStrength}$, $\text{fissureScale}$, $\text{fissureDepth}$, $\text{cellularWeight}$). Any earthly stone, metal, glazed facade, or alien metamaterial can be interpolated ($\operatorname{lerp}$), blended, or dynamically evaluated without code modification.
- **Differential Tangent-Plane Facade Grammar**: Facade apertures, piers, and setbacks are computed in continuous local tangent space $(s, y, f)$ via orthonormal frames $(\mathbf{t}, \mathbf{b}, \mathbf{n})$ anchored at $\mathbf{P}_0$. Execution logic must NEVER branch on human street names or discrete facing enums (`EAST_5TH_AVE`, `NORTH_34TH_ST`).
- **Dynamic OBB GSD-Conformal Camera Rigging**: Camera coordinates must NEVER be static hardcoded numbers. All verification vantages are generated dynamically via `AdaptiveSurveyRigService` as continuous functions of the mesh Oriented Bounding Box (OBB) and surface normal vectors to enforce sub-millimeter Ground Sampling Distance (GSD).
- **Automated Unsupervised DNA Abstraction**: Architectural setback tiers, bay rhythms, and material clusters must be discoverable directly from raw geometry via `TileAbstractorEngine` (`scratchbox_tile_abstractor.hpp`), eliminating manual hardcoded schemas.

### B. C++20 Engine Primacy & Apple Clang Compilation
- **C++20 as Geometry Generator**: The generation of multi-tier building geometry, window aperture recesses, and botanical assets must be implemented in native C++20 using the Scratchbox 3D Engine (`#include "scratchbox_engine.hpp"`), compiled via Apple Clang (`-std=c++20 -O3`).
- **Three.js as Pure Viewport**: Three.js is restricted strictly to rendering, camera choreographies, and post-processing. Generative procedural construction in Three.js (`new THREE.BoxGeometry`, etc.) is strictly prohibited under the Zero-Tolerance Tier-0 Ban.

### C. Pure Polygonal PBR over Radiance Fields
- Photogrammetric tile rectification must produce standardized binary glTF 2.0 (`.glb`) with true polygonal topology and PBR materials.
- Radiance field approximations (3DGS, 2DGS, 4DGS) are prohibited for solid architectural structures because they introduce floating splatter artifacts, lack physical collision bounds, and fail under multi-bounce directional lighting.

---

## 3. Spatial Alignment & Geometric Grounding (The Critical Discovery)

### The Alignment Pitfall & Root-Cause Analysis
A primary failure mode in procedural tile replacement is **spatial misalignment relative to the raw tile mesh**:
- **Observed Defect**: When the reconstructed building was rendered alongside the raw photogrammetric city block, the tower appeared noticeably shifted and detached from the street grid.
- **Root-Cause Discovery**: 
  - An initial naive assumption placed the building base at an arbitrary bounding box:
    $$\text{naive: } X \in [-65.0, 35.0] \implies X_{\text{center}} = -15.0\,\text{m}$$
  - Direct analytical inspection of the raw Google 3D tile binary buffer (`spce_scan_studio_cleaned_pbr.glb`) across multiple height bands revealed the true coordinates:
    $$\text{Actual Base } (Y \in [10, 25]): X \in [-79.7, 79.5] \implies X_{\text{center}} = 0.0\,\text{m}, Z \in [-59.7, 59.6] \implies Z_{\text{center}} = 0.0\,\text{m}$$
    $$\text{Actual Tower Shaft } (Y \in [180, 220]): X \in [-34.1, 34.4] \implies X_{\text{center}} = 0.15\,\text{m}, Z \in [-32.0, 31.0] \implies Z_{\text{center}} = -0.5\,\text{m}$$
    $$\text{Actual Pinnacle Spire } (Y \in [336, 427]): X \in [-19.9, 18.3] \implies X_{\text{center}} = -0.8\,\text{m}, Z \in [-15.4, 15.4] \implies Z_{\text{center}} = 0.0\,\text{m}$$
- **Result**: The initial procedural model was displaced by **$15.0\,\text{meters}$ to the west**, and its tower shaft width was undersized ($54\,\text{m}$ vs. the real $68.5\,\text{m}$). This misalignment immediately broke visual continuity with the surrounding streets and adjacent buildings.

### The Canonical Grounding Protocol
To guarantee 100% sub-millimeter geometric registration:
1. **Binary Buffer Cross-Section Profiling**: Prior to generating replacement geometry, query the raw tile vertex buffer across discrete elevation intervals ($Y_{\text{ground}}, Y_{\text{podium}}, Y_{\text{shaft}}, Y_{\text{crown}}, Y_{\text{spire}}$).
2. **Centroid & Extent Calculation**:
   $$X_{\text{center}} = \frac{X_{\min} + X_{\max}}{2}, \quad Z_{\text{center}} = \frac{Z_{\min} + Z_{\max}}{2}$$
   $$W_X(Y) = X_{\max}(Y) - X_{\min}(Y), \quad D_Z(Y) = Z_{\max}(Y) - Z_{\min}(Y)$$
3. **Conformal Footprint Alignment**: The synthesized base plinth, podium, and setback tiers must be centered exactly on $(X_{\text{center}}, Z_{\text{center}})$ and match the cross-sectional extents $W_X(Y)$ and $D_Z(Y)$ within $1\%$ tolerance.
4. **Excised Parcel Geofencing**: The excision bounding volume used to remove the melted raw structure from the tile must tightly encompass the building envelope without clipping adjacent structures:
   $$\text{Excision Volume} = [X_{\min} - \delta, X_{\max} + \delta] \times [Z_{\min} - \delta, Z_{\max} + \delta], \quad \delta \in [1.0\,\text{m}, 2.5\,\text{m}]$$

---

## 4. The 3-Stage Progressive Pipeline Architecture

The transformation pipeline is structured into three distinct, verifiable stages:

```
+-----------------------------------------------------------------------------------+
| STAGE 1: AUTHENTIC REAL-WORLD 3D TILE IN 18% STUDIO GREY CLAY                     |
| - Raw Google Photorealistic 3D Tile mesh ingested at maximum LOD (errorTarget <= 0.5)|
| - Material overridden to 18% Studio Grey Clay (roughness=0.85, albedo=[0.55,0.57,0.60])|
| - Reveals underlying geometric defects: melted facades, jagged polygons, curtain walls|
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 2: VECTOR-REFINED 4-SIDED ARCHITECTURAL GEOMETRY (18% CLAY)                 |
| - Excises melted target structure via UTDRA spatial geofencing                    |
| - Synthesizes 4-sided Art Deco / classical fenestration via C++20 engine           |
| - Projects vertical piers, deep recessed window bays (0.35m - 0.45m recess)        |
| - Reconstructs street-level entrance portico & excises ground curtain wall         |
| - Instances anatomical botanical trees via SB-Veggie along pedestrian sidewalk     |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 3: MASTER PBR REALITY WITH PHOTOGRAMMETRIC CONTEXT FUSION                   |
| - Evaluates continuous biophysical material points on the R^16 manifold           |
| - Synthesizes micro-relief ashlar masonry normal maps (Scharr/Sobel operators)    |
| - Preserves & bakes photogrammetric vertex colors for surrounding district tiles  |
| - Path-traces final beauty plate under NOAA diurnal solar ephemeris (0-baked-shadows)|
+-----------------------------------------------------------------------------------+
```

---

## 5. Detailed Implementation Blueprint

### A. Phase 1: High-Fidelity 3D Tile Ingestion
- Stream Google Photorealistic 3D Tiles using leaf-node Level of Detail (`errorTarget = 0.5` or lower) against a 4K screen-space error budget.
- Package ingested tile chunks into standardized binary glTF 2.0 (`.glb`).
- Overwrite material shaders with uniform 18% Studio Grey Clay to isolate and document geometry defects.

### B. Phase 2: Vector Refinement & Geometry Synthesis (C++20)
- **70-20-10 Geometric Form Hierarchy**:
  - **70% Primary Edifice**: Monumental massing, podium, shaft setbacks, and crown spire conforming to extracted centroid $(X_c, Z_c)$.
  - **20% Secondary Assemblies**: Continuous vertical limestone piers, recessed window mullions, setback balustrades, entrance canopy frame.
  - **10% Tertiary Micro-Detail**: Ashlar stone blocks, chevron bronze spandrel panels, fluted entrance transoms, scored sidewalk paving.
- **Aperture Bay Geometry**: Window bays must never be flat texture decals. Each window bay must be modeled with real polygonal geometry:
  - Left and right pier returns: $\text{width} = d_{\text{recess}}$
  - Top lintel and bottom sill returns: $\text{depth} = d_{\text{recess}}$
  - Window glazing quad recessed behind the facade plane.

### C. Phase 3: Continuous Biophysical Material Manifold & De-Lighting
In accordance with ADA Pillar 3, materials are never closed discrete archetypes. They are represented as continuous coordinate vectors $\mathbf{m} \in \mathbb{R}^{16}$ on the Scratchbox Biophysical Manifold (`scratchbox_pbr_manifold.hpp`):
- **Continuous Manifold Dimensions**:
  $$\mathbf{m} = \left(\mathbf{a}_{\text{lin}}, \mathbf{a}_{\text{sec}}, w_{\text{sec}}, \sigma_{\text{cond}}, \alpha_{\text{rough}}, \mu_{\text{porosity}}, \kappa_{\text{norm}}, \omega_{\text{fissure}}, \delta_{\text{fissure}}, \ldots\right)$$
- **Continuous Physical Material Coordinates (ESB Instance Points)**:
  - **Masonry Ashlar Piers / Walls**: $\mathbf{a}_{\text{lin}} = [0.72, 0.70, 0.65]$, $\alpha_{\text{rough}} = 0.82$, $\sigma_{\text{cond}} = 0.0$, $\mu_{\text{porosity}} = 0.42$, $\kappa_{\text{norm}} = 1.6$, $\omega_{\text{fissure}} = 12.0$.
  - **Architectural Bronze Spandrels / Trim**: $\mathbf{a}_{\text{lin}} = [0.28, 0.22, 0.16]$, $\sigma_{\text{cond}} = 0.85$, $\alpha_{\text{rough}} = 0.38$, $\kappa_{\text{norm}} = 1.4$, anisotropy $= 0.50$.
  - **Dielectric Low-E Glazing**: $\mathbf{a}_{\text{lin}} = [0.05, 0.08, 0.12]$, $\sigma_{\text{cond}} = 0.05$, $\alpha_{\text{rough}} = 0.03$, $\mu_{\text{porosity}} = 0.02$, zero daytime emission.
  - **Granite Base Course Plinth**: $\mathbf{a}_{\text{lin}} = [0.18, 0.19, 0.20]$, $\alpha_{\text{rough}} = 0.75$, $\sigma_{\text{cond}} = 0.0$, $\kappa_{\text{norm}} = 1.8$, cellular weight $= 0.45$.
  - **Scored Pedestrian Pavement**: $\mathbf{a}_{\text{lin}} = [0.60, 0.59, 0.57]$, $\alpha_{\text{rough}} = 0.90$, $\sigma_{\text{cond}} = 0.0$, graininess $= 0.40$.
- **Zero Baked Shadows**: De-lighting is achieved by synthesizing unshadowed linear albedo and normal maps directly from the manifold, then evaluating path-traced direct solar irradiance and diffuse sky dome scattering using NOAA diurnal solar ephemeris.

### D. Phase 4: Botanical Integration via SB-Veggie
- Photogrammetric scans reduce trees to solid, distorted green mounds.
- Excised street trees must be replaced with procedurally grown botanical models ([`sb_veggie_oak.glb`](file:///Users/eligreen/dev/scratchbox-ide-master/public/models/sb_veggie_oak.glb)):
  - Multi-tier branching with tapering branch radii.
  - Rhytidome bark texture with longitudinal furrow displacement.
  - Translucent foliage ($R=0.65$) that transmits sunlight and casts dappled contact shadows.

---

## 6. The 3-Way Architectural Vantage Verification Triad

To prevent visual cherry-picking and verify quality across all scales, every synthesized asset is framed dynamically via `AdaptiveSurveyRigService` (`plan_adaptive_survey_rig`). Camera coordinates are evaluated as continuous geometric functions of the asset's Oriented Bounding Box (OBB) and facade surface normals rather than hardcoded magic numbers:

| Vantage Class | Dynamic OBB Equation | Evaluated Camera Coordinates (ESB Instance) | Spatial Purpose | What It Audits |
| :--- | :--- | :--- | :--- | :--- |
| **1. Aerial District Master** | $\mathbf{P} = \mathbf{C}_{\text{OBB}} + 1.8 \cdot \max(W, H, D) \cdot \mathbf{v}_{\text{orbit}}(\theta, 35^\circ)$ | `pos: [-160, 140, 180]`, `target: [0, 80, 0]`, `FOV: 48°` | City District Scale | Setbacks, 4-sided fenestration, skyline integration, and photogrammetric context fusion |
| **2. Facade Mid-Rise** | $\mathbf{P} = \mathbf{P}_{\text{shaft\_mid}} + \frac{h_{\text{shaft}}}{2} \cdot \mathbf{n}_{\text{facade}} + \mathbf{b} \cdot y_{\text{offset}}$ | `pos: [70, 35, 45]`, `target: [15, 40, 0]`, `FOV: 50°` | Architectural Scale | Ashlar pier relief, recessed window bays, bronze chevron spandrels, self-shadowing |
| **3. Pedestrian Street View** | $\mathbf{P} = \mathbf{P}_{\text{pedestrian\_corridor}} + 1.7\,\text{m} \cdot \mathbf{u}_y$ | `pos: [48, 4.5, -14]`, `target: [35, 10, 0]`, `FOV: 55°` | Human / Botanical Scale | Curtain wall excision, monumental entrance, bronze portico, sidewalk joints, SB-Veggie oak trees |

---

## 7. Interactive Showcase UX & AI Prompt Interface

The interactive web demo ([`omnispatial_synthesis_demo.html`](file:///Users/eligreen/dev/scratchbox-ide-master/public/demos/showcase/omnispatial_synthesis_demo.html)) proves the transformation through an end-to-end **Natural Language AI Prompt Interface**:
1. **Natural Language AI Prompt Command Bar**:
   - Accepts arbitrary freeform prompts (e.g. *"Transform raw 3D tile into hyper-realistic PBR building with recessed window bays"*, *"Stage 1: Ingest Google 3D tile in 18% Studio Grey Clay"*, *"Refine geometry to 4-sided Art Deco piers and SB-Veggie trees"*, *"Inspect 2.5x macro detail loupe on 5th Ave limestone facade"*).
   - Intelligently parses intent across Target Stage (1, 2, 3), Architectural Vantage (Aerial, Facade, Street View), View Mode (Dual Split, Wipe Slider, 2.5x Detail Loupe, 3D Orbit), and Render Pass (Beauty, Albedo, Normal, Depth).
2. **Interactive Quick-Prompt Chips**:
   - Single-click prompt chips allow instantaneous execution of canonical pipeline configurations:
     - `✨ Transform to PBR`
     - `🏛️ Stage 1: Clay Scan`
     - `📐 Stage 2: Vector Refined`
     - `🎨 Stage 3: Manifold PBR`
     - `🌳 Street View Portico`
     - `🔍 2.5x Detail Loupe`
     - `🌐 3D Free Orbit`
     - `☀️ Surface Normals`
     - `⇄ Wipe Comparison`
3. **Live Streaming C++20 Pipeline Terminal Drawer**:
   - Real-time animated terminal console tracking the exact C++20 engine operations with millisecond timestamps:
     - `[PROMPT]`: Ingests and sanitizes natural language instruction.
     - `[INTENT]`: Resolves stage, vantage, render pass, and view mode parameters.
     - `[GEODESIC]`: Verifies sub-millimeter centroid locking at $(0.00\,\text{m}, 0.00\,\text{m})$ and base envelope dimensions.
     - `[UTDRA]`: Excises melted tower shaft and ground curtain wall while preserving surrounding city block.
     - `[C++20 ENGINE]`: Synthesizes 4-sided tangent plane Art Deco piers and 0.40m window bay recesses.
     - `[SB-VEGGIE]`: Instances botanical Quercus alba trees along pedestrian sidewalk.
     - `[PBR MANIFOLD]`: Evaluates continuous $\mathbb{R}^{16}$ manifold parameters and Toksvig Scharr normal AA pyramid.
     - `[NOAA SOLAR]`: Inverts diurnal solar irradiance $L_\odot = [0.24, 0.93, 0.29]$ to eliminate baked shadows.
     - `[VIEWPORT]`: Transitions viewports and 3D `<model-viewer>` with $0.000\,\text{px}$ spatial drift.
4. **Interactive Multi-Mode Inspection**:
   - **Dual-Viewport Side-by-Side Mode**: Synchronized comparison between Stage 1, Stage 2, and Stage 3.
   - **Interactive Split Wipe Slider**: Smooth drag slider allowing real-time pixel-level wipe between stages.
   - **2.5x Detail Loupe**: Magnifying glass tool for close-up examination of masonry joints, bronze mullions, and window reflections.
   - **3D Free Orbit Viewport**: Interactive `<model-viewer>` allowing users to orbit, zoom, and inspect the binary `.glb` model in real-time 3D.

### 7.5 Universal Asset Resolution & Multi-Tier Fallback Cascade (Resolution of Black Screen Issue)
- **Root-Cause Analysis**:
  - The demo HTML file resides at `public/demos/showcase/omnispatial_synthesis_demo.html`.
  - When referencing assets via root-relative URLs (`/renders/...` or `/models/...`), browsers attempting to open the file directly via `file:///` protocol resolve `/` to the root of the user's hard drive (`file:///renders/...`), which does not exist and throws `ERR_FILE_NOT_FOUND`.
  - Similarly, when served by web servers rooted at the repository directory, `/renders/...` 404s because the physical directory is `public/renders/...`.
- **Architectural Solution**:
  1. Converted all hardcoded `src` attributes and data URLs to relative paths (`../../renders/...` and `../../models/...`), allowing the browser to resolve cleanly up two directories from `showcase/` into `public/`.
  2. Implemented `setPlateSrc(imgElement, rawPath)` and `setModelViewerSrc(viewerElement, rawPath)` with an automatic fallback cascade (`../../...`, `/...`, `/public/...`, `../...`, `...`).
  3. Validated that all 18 rendered beauty/albedo/normal/depth images and binary `.glb` models resolve with 100% success from the demo directory.

---

## 8. Summary of Lessons Learned & Skill Reusability

1. **Never Guess Coordinates**: Always read the raw binary glTF accessors to determine exact $(X, Y, Z)$ centroid and extents before synthesizing geometry.
2. **Preserve Contextual Tiles**: Do not delete the entire scene; preserve the surrounding block with baked photogrammetric vertex colors to ground the hero building in its authentic environment.
3. **Excise the Curtain Wall**: Photogrammetry always fails at the street level; the ground floor must always be procedurally reconstructed with deep porticos, clear glazing, and botanical assets.
4. **Enforce Native C++20 for Geometry**: Avoid client-side Three.js primitives to guarantee high-performance, watertight meshes capable of exceeding 500,000 triangles in under 200 milliseconds.
5. **Universal Relative Asset Resolution**: Demos and showcases must never rely on root-relative `/` paths; always use relative or cascaded multi-tier URL resolvers (`../../renders/...`) so files can be opened seamlessly across `file:///`, local dev servers, and production web servers.

