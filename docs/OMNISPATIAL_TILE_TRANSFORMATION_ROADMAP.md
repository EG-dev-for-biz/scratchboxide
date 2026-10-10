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

### A. The Alien Planet Test (Adaptive Domain Architecture)
- **Zero Closed Taxonomies**: Never design hardcoded enums for architectural styles, biomes, or materials (e.g. `type Style = 'art_deco' | 'gothic' | 'modern'`).
- **Continuous Physical Fields**: All building profiles, setbacks, window bay dimensions, and material parameters must be expressed as continuous metric values ($w_{\text{bay}}, d_{\text{recess}}, h_{\text{spandrel}}, \alpha_{\text{roughness}}, \mu_{\text{metalness}}$).

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
| - Assigns 13 calibrated PBR material sets (Indiana limestone, bronze, glazing)     |
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

### C. Phase 3: PBR Material Calibration & De-Lighting
- Material channels calibrated against measured real-world biophysical values:
  - **Indiana Limestone (Piers/Walls)**: Albedo = `[0.72, 0.70, 0.65]`, Roughness = `0.82`, Metalness = `0.0`.
  - **Statuary Bronze (Spandrels/Mullions/Doors)**: Albedo = `[0.28, 0.22, 0.16]`, Roughness = `0.38`, Metalness = `0.85`.
  - **Dielectric Window Glazing**: Albedo = `[0.05, 0.08, 0.12]`, Roughness = `0.03`, Metalness = `0.05`.
  - **Granite Base Course Plinth**: Albedo = `[0.18, 0.19, 0.20]`, Roughness = `0.75`, Metalness = `0.0`.
  - **Concrete Sidewalk Paving**: Albedo = `[0.60, 0.59, 0.57]`, Roughness = `0.90`, Metalness = `0.0`.
- **Zero Baked Shadows**: De-lighting is achieved by overriding tile diffuse maps with calibrated physical albedo and evaluating path-traced direct solar irradiance and diffuse sky dome scattering using NOAA ephemeris.

### D. Phase 4: Botanical Integration via SB-Veggie
- Photogrammetric scans reduce trees to solid, distorted green mounds.
- Excised street trees must be replaced with procedurally grown botanical models ([`sb_veggie_oak.glb`](file:///Users/eligreen/dev/scratchbox-ide-master/public/models/sb_veggie_oak.glb)):
  - Multi-tier branching with tapering branch radii.
  - Rhytidome bark texture with longitudinal furrow displacement.
  - Translucent foliage ($R=0.65$) that transmits sunlight and casts dappled contact shadows.

---

## 6. The 3-Way Architectural Vantage Verification Triad

To prevent visual cherry-picking and verify quality across all scales, every synthesized asset must be path-traced and inspected from **three mandatory vantage points**:

| Vantage | Camera Config | Spatial Purpose | What It Audits |
| :--- | :--- | :--- | :--- |
| **1. Midtown Aerial Master** | `pos: [-160, 140, 180]`, `target: [0, 80, 0]`, `FOV: 48°` | City District Scale | Setbacks, 4-sided fenestration, skyline integration, and photogrammetric context fusion |
| **2. Facade Mid-Rise** | `pos: [70, 35, 45]`, `target: [15, 40, 0]`, `FOV: 50°` | Architectural Scale | Ashlar pier relief, recessed window bays, bronze chevron spandrels, self-shadowing |
| **3. Street View Pedestrian** | `pos: [48, 4.5, -14]`, `target: [35, 10, 0]`, `FOV: 55°` | Human / Botanical Scale | Curtain wall excision, monumental entrance, bronze portico, sidewalk joints, SB-Veggie oak trees |

---

## 7. Interactive Showcase & Demonstration UX

The interactive web demo ([`omnispatial_synthesis_demo.html`](file:///Users/eligreen/dev/scratchbox-ide-master/public/demos/showcase/omnispatial_synthesis_demo.html)) must provide:
1. **Interactive Vantage Switching**: Fast switching between the three canonical vantages.
2. **Dual-Viewport Side-by-Side Mode**: Synchronized comparison between Stage 1, Stage 2, and Stage 3.
3. **Interactive Split Wipe Slider**: Smooth drag slider allowing real-time pixel-level wipe between stages.
4. **2.5x Detail Loupe**: Magnifying glass tool for close-up examination of masonry joints, bronze mullions, and window reflections.
5. **3D Free Orbit Viewport**: Interactive `<model-viewer>` allowing users to orbit, zoom, and inspect the binary `.glb` model in real-time 3D.
6. **Address / Location Query Box**: User input enabling arbitrary geographic coordinates and real-world addresses to be processed through the synthesis pipeline.

---

## 8. Summary of Lessons Learned & Skill Reusability

1. **Never Guess Coordinates**: Always read the raw binary glTF accessors to determine exact $(X, Y, Z)$ centroid and extents before synthesizing geometry.
2. **Preserve Contextual Tiles**: Do not delete the entire scene; preserve the surrounding block with baked photogrammetric vertex colors to ground the hero building in its authentic environment.
3. **Excise the Curtain Wall**: Photogrammetry always fails at the street level; the ground floor must always be procedurally reconstructed with deep porticos, clear glazing, and botanical assets.
4. **Enforce Native C++20 for Geometry**: Avoid client-side Three.js primitives to guarantee high-performance, watertight meshes capable of exceeding 500,000 triangles in under 200 milliseconds.
