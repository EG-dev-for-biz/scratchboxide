# Omnispatial 3D Tile Transformation Plan: Colosseum & Imperial Rome District

> **Superseded (2026-10-15): do not follow the steps below.** `PhotogrammetricTerrainHarmonizerService` (`harmonizeGlb`,
> `fitOrientedBoundingEnvelope`), the `harmonize_photogrammetric_district` tool and `scripts/integrate_colosseum_botanical_trees*`
> are deleted: they flattened canopy and placed trees from hand-written or seeded-random stands (species, positions,
> heights) instead of measuring them. A location's trees are now measured in its photo tiles and rebuilt as SB-Veggie
> trees by `TileVegetationService` (`packages/core/src/node/3d-engine/tile-vegetation-service.ts`, native
> `scratchbox_tile_vegetation.hpp` / `scripts/tile_vegetation.cpp`) through `google_3d_tiles_get_clay`
> (`location-clay-pipeline.ts`); a single tree of given measurements comes from `botanical_synthesize_tree`. This record
> is kept as history only.
## Adaptive Domain Architecture (ADA) Compliance, Critical Thinking Audit, 3D Artistry & Visual Criticism

---

## 1. Executive Summary & Problem Formulation

### 1.1 The Objective
Transform the raw Google Photorealistic 3D Tile of the **Colosseum District in Rome, Italy** ($41.8902^\circ\,\text{N}, 12.4922^\circ\,\text{E}$) into a **photorealistic, structurally sound, VFX-grade 3D architectural asset**, building directly on the architectural foundation established in [`docs/OMNISPATIAL_TILE_TRANSFORMATION_ROADMAP.md`](file:///Users/eligreen/dev/scratchbox-ide-master/docs/OMNISPATIAL_TILE_TRANSFORMATION_ROADMAP.md).

The transformation must deliver:
1. **Pristine Geometric Rectification**: Sharp Vitruvian arcade profiling, 80 radial bays per tier, intact attic pilasters, and elimination of photogrammetric "melted wax" and hollow shell artifacts.
2. **Context-Preserved City District Grounding**: Absolute $100\%$ preservation of the surrounding Roman urban block (Colle Oppio, Celian Hill residential quarter, Roman Forum, Via dei Fori Imperiali) with **$0.000\,\text{mm}$ spatial drift and zero building crushing**.
3. **Continuous Biophysical Material Manifold ($\mathbb{R}^{16}$)**: Physically grounded PBR parameters for Roman travertine marble, volcanic tuff/brick core, Sanpietrini basalt pavers, weathered terracotta tiles, and bitumen asphalt, eliminating baked diffuse sun shadows while preserving authentic high-resolution photographic albedo.
4. **Botanical Reality Grounding**: Procedurally authentic Mediterranean flora (*Pinus pinea* Stone Pines, *Cupressus sempervirens* Italian Cypress) grown via native C++20 SB-Veggie instanced **strictly within verified cadastral green spaces**, with smooth turf re-texturing underneath.
5. **Zero Radiance Field Splatters & Zero Client-Side Toy Primitives**: Strict polygonal C++20 geometry compiled via Apple Clang (`-std=c++20 -O3`), streaming binary glTF 2.0 (`.glb`) with zero 3DGS floating ellipsoids and zero Three.js generative boxes.

---

## 2. Critical Thinking & Adversarial Technical Audit

Following the 5-Gate Adversarial Audit Framework from `.agents/skills/critical-thinking/SKILL.md`:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   5-GATE CRITICAL THINKING AUDIT                       │
├────────────────────────────────┬───────────────────────────────────────┤
│ Gate 1: Epistemic Assumptions  │ Gate 4: Adversarial Failure Modes     │
│ Gate 2: Information Theory     │ Gate 5: The "Boring Path" Benchmark   │
│ Gate 3: Component Reality Check│                                       │
└────────────────────────────────┴───────────────────────────────────────┘
```

### Gate 1: Epistemic & Assumption Audit (Root Cause Analysis of Recent Failure)
* **The False Assumption**: Previous scripts assumed that high-elevation clusters with irregular surface normals across the tile were "vegetation canopy lumps" that could be flattened via radial smoothstep equations down to an arbitrary ground datum ($Y = 22.0\,\text{m}$).
* **The Fatal Reality**: In `physical_trees_dataset.json`, 26 stands in `celian_north` were located at $Z \in [-140, -180]\text{m}$, $X \in [-80, 60]\text{m}$. These coordinates correspond to 4-to-5-story residential apartment blocks on Celian Hill with authentic rooftop elevations of $Y \approx 55\,\text{m} - 65\,\text{m}$.
* **The Failure Mechanism**: Depressing these coordinates by $35\,\text{m} - 40\,\text{m}$ while keeping original photogrammetric UV coordinates static caused extreme vertical triangle elongation, resulting in the catastrophic texture streaking and kaleidoscopic polygon shredding seen in the user's uploaded images.
* **The Remediation Invariant**: Geometry must never be modified based on heuristic bounding boxes. Modification must be gated by **Cadastral Vector Distance Fields** ($\Phi_{\text{cadastral}}$) that strictly classify surfaces into Building Parcels, Road Networks, and Public Green Spaces.

### Gate 2: Information-Theoretic & Physical Grounding
* **Raw Tile Fidelity**: Google 3D Tiles are not synthetic hallucinations; they represent bundle-adjusted photogrammetric observations from multi-view aerial camera arrays. The photographic atlas captures real travertine weathering, iron clamp sockets, terracotta roof tiles, and asphalt wear.
* **What Photogrammetry Lacks**:
  1. *Grazing-angle resolution on vertical surfaces*: Nadir/oblique cameras under-sample vertical surfaces under cornices and arch soffits.
  2. *Cavity depth*: Photogrammetric Poisson surface reconstruction bridges open archways with closed "curtain walls".
  3. *Unlit Albedo*: Photographs have baked-in solar irradiance and atmospheric haze.
* **Information Invariant**: Our tools must extract and enhance what is physically observed (deriving micro-normals and PBR roughness from authentic high-frequency photo gradients), reconstruct occluded geometry (piercing the 80 radial arcades), and de-light the diffuse map using physical solar ephemeris. We must **never destroy or overwrite** authentic photographic observations with synthetic procedural noise.

### Gate 3: Component Reality Check (The "No Magic Boxes" Rule)
* **Native C++20 vs Client-Side JS**: Geometry operations exceeding $100{,}000$ vertices must execute in native C++20 via Apple Clang (`-std=c++20 -O3`) and `NativeCppCompilerService`. Three.js is restricted strictly to rendering and viewport camera choreography.
* **Vector Data Ingestion**: Cadastral parcel polygons from OpenStreetMap/GIS must be converted into signed 2D distance fields ($d_{\text{poly}}$) to provide continuous, analytical containment testing at sub-millimeter precision.

### Gate 4: Adversarial Failure-Mode Excavation
| Failure Mode | Root Cause | Preventive Invariant |
| :--- | :--- | :--- |
| **Crushed Building Envelopes** | Blind radial terrain depression | Building parcels locked with $0.000\,\text{mm}$ displacement tolerance ($\Phi_{\text{building}} < 0 \implies \Delta Y \equiv 0$). |
| **UV Streaking / Waterfall Smearing** | Displacing vertices without re-projecting UVs | Vertices displaced in green spaces must have ground UVs re-mapped orthogonally ($U=X/s, V=Z/s$) with seamless turf/soil textures. |
| **Spatial Boundary Disconnection** | Procedural asset off-center from raw scan | Binary buffer profiling calculates exact OBB centroid and semi-axes ($a, b, \theta$) before synthesizing replacement geometry. |
| **Unnatural Plastic Sheen** | Uniform roughness values | PBR roughness mapped from photographic luminance gradients and material classification on the $\mathbb{R}^{16}$ manifold. |

### Gate 5: The "Boring Path" Benchmark
* Before generating complex synthetic geometry, verify if the existing tile geometry is already accurate. For the Colosseum, the surrounding residential blocks, the Forum ruins, and the street layout are already $90\%$ geometrically true. We only excise and reconstruct what is genuinely melted (the 80 arcade openings and foliage lumps in verified public parks).

---

## 3. Adaptive Domain Architecture (ADA) Compliance & Universal Invariants

To satisfy the **Alien Planet Test (Zero Closed Taxonomies)**, the system must not contain hardcoded strings (`"colosseum"`, `"roman_classical"`, `"temple"`). It must operate strictly on continuous physical and geometric dimensions:

```
                                [ADA UNIVERSAL PIPELINE]
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │ 1. Continuous Geometric Profiles (SE(3) Sweeps & Harmonic Solids of Revolution)  │
  ├─────────────────────────────────────────────────────────────────────────────────┤
  │ 2. Cadastral Vector Distance Fields (Continuous Analytical Partitioning)         │
  ├─────────────────────────────────────────────────────────────────────────────────┤
  │ 3. Continuous Biophysical Material Manifold (R^16 Physical Parameter Space)      │
  ├─────────────────────────────────────────────────────────────────────────────────┤
  │ 4. Dynamic OBB-Conformal Survey Rigging (GSD-Bounded Camera Mathematics)         │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 The 4 Universal Differential Geometric Operators
1. **$\mathrm{SE}(3)$ Lie Group Curve Sweeps**:
   * Carrier curve $\mathbf{C}(t) = (a\cos t, 0, b\sin t)$ sweeps continuous transverse profiles $P(u, v)$ with radial thickness $w(t)$ to generate the outer amphitheater rings, podium balustrades, entablatures, and street curbs.
2. **Harmonic Solids of Revolution / Elliptical Shells**:
   * Radial profile $r(\theta, z)$ with continuous circumferential harmonic frequency $K = 80$ lobes, modulating arcade pier centers and radial vomitoria axes.
3. **Affine Metric Replicators**:
   * Periodic distribution of arcade pilasters, attic corbels, and Sanpietrini basalt pavers along the elliptical perimeter at continuous metric arc-length pitch $p = \frac{\mathcal{L}_{\text{ellipse}}}{N}$.
4. **Isoparametric Normal Relief Fields**:
   * Continuous surface normal displacements $\Delta h(u, v)\,\mathbf{n}(u, v)$ generating ashlar travertine coursing, drafted stone margins, ancient iron clamp sockets, and road asphalt aggregate.

### 3.2 Continuous Biophysical Material Manifold ($\mathbb{R}^{16}$)
Materials are points on the continuous manifold $\mathbf{m} \in \mathbb{R}^{16}$ (`scratchbox_pbr_manifold.hpp`):
$$\mathbf{m} = \left(\mathbf{a}_{\text{lin}}, \mathbf{a}_{\text{sec}}, w_{\text{sec}}, \sigma_{\text{cond}}, \alpha_{\text{rough}}, \mu_{\text{porosity}}, \kappa_{\text{norm}}, \omega_{\text{fissure}}, \delta_{\text{fissure}}, \ldots\right)$$

* **Roman Travertine Ashlar**: $\mathbf{a}_{\text{lin}} = [0.76, 0.73, 0.64]$, $\alpha_{\text{rough}} = 0.84$, $\sigma_{\text{cond}} = 0.0$, $\mu_{\text{porosity}} = 0.48$, $\kappa_{\text{norm}} = 1.7$, $\omega_{\text{fissure}} = 14.0$.
* **Roman Tuff / Opus Caementicium Core**: $\mathbf{a}_{\text{lin}} = [0.62, 0.40, 0.30]$, $\alpha_{\text{rough}} = 0.88$, $\sigma_{\text{cond}} = 0.0$, $\mu_{\text{porosity}} = 0.58$, $\kappa_{\text{norm}} = 2.0$.
* **Sanpietrini Basalt Pavers**: $\mathbf{a}_{\text{lin}} = [0.22, 0.23, 0.24]$, $\alpha_{\text{rough}} = 0.65$, $\sigma_{\text{cond}} = 0.0$, $\mu_{\text{porosity}} = 0.20$, $\kappa_{\text{norm}} = 1.9$, specular grazing highlight.
* **Weathered Terracotta Roof Tiles**: $\mathbf{a}_{\text{lin}} = [0.68, 0.35, 0.22]$, $\alpha_{\text{rough}} = 0.76$, $\sigma_{\text{cond}} = 0.0$, $\mu_{\text{porosity}} = 0.35$.
* **Pine Rhytidome Bark**: $\mathbf{a}_{\text{lin}} = [0.25, 0.20, 0.16]$, $\alpha_{\text{rough}} = 0.92$, $\sigma_{\text{cond}} = 0.0$, longitudinal furrow depth $\delta = 0.04\,\text{m}$.
* **Pine Needle Canopy**: $\mathbf{a}_{\text{lin}} = [0.18, 0.30, 0.12]$, $\alpha_{\text{rough}} = 0.45$, thin-wall subsurface scattering transmission $\tau = 0.65$.

---

## 4. 3D Environmental Artist Execution Plan (70-20-10 Hierarchy)

As Technical Art Director, the scene reconstruction follows the strict **70-20-10 Form Hierarchy**:

```
                                 [70-20-10 FORM HIERARCHY]
  ┌─────────────────────────────────────────────────────────────────────────────────┐
  │ 70% PRIMARY EDIFICE / MACRO SILHOUETTE                                          │
  │ • True Vitruvian Elliptical Envelope: a = 94.4m, b = 78.1m, Height = 48.5m      │
  │ • 4 Continuous Facade Tiers with accurate vertical step-backs and entablatures  │
  │ • Subterranean Hypogeum Labyrinth with radial masonry support ribs              │
  │ • Surrounding Topography: Oppian Hill crest, Celian Hill ridge, Forum valley    │
  ├─────────────────────────────────────────────────────────────────────────────────┤
  │ 20% SECONDARY ARTICULATED ASSEMBLIES                                            │
  │ • 80 Open Radial Arcade Bays per Tier: Pierced through photogrammetric curtain  │
  │ • Architectural Pilaster Orders: Tuscan (Tier 1), Ionic (Tier 2), Corinthian    │
  │ • Attic Corinthian Pilasters with 240 projecting travertine corbels for velarium│
  │ • Botanical Pinus pinea & Cupressus sempervirens with anatomical trunk branching│
  ├─────────────────────────────────────────────────────────────────────────────────┤
  │ 10% TERTIARY MICRO-DETAIL                                                       │
  │ • Travertine Ashlar Coursing with drafting margins and eroded mortar relief     │
  │ • Medieval Iron Clamp Extraction Sockets (pitting and quarry gouges)            │
  │ • Sanpietrini Basalt Cobblestone Pavers with concentric fan laying patterns     │
  │ • Scored asphalt road marking and granite pedestrian perimeter curbs            │
  └─────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Botanical Grounding (Parks-Only SB-Veggie Instancing)
* **Species 1: Italian Stone Pine (*Pinus pinea*)**:
  - Parasol-shaped umbrella canopy ($18\,\text{m} - 24\,\text{m}$ diameter).
  - Tapering trunk with sinuous bark furrows and natural lean towards the sun.
  - Multi-tier secondary branch whorls terminating in dense spherical needle clusters.
* **Species 2: Mediterranean Cypress (*Cupressus sempervirens*)**:
  - Dense, columnar fastigiate silhouette ($12\,\text{m} - 18\,\text{m}$ height, $2.0\,\text{m} - 3.0\,\text{m}$ diameter).
  - Vertical ascending branch structure casting sharp, elongated shadows.
* **Spatial Grounding Rules**:
  - Trees are placed **strictly** where $\Phi_{\text{green}}(\mathbf{x}) < 0$ (inside Parco del Colle Oppio and Parco di Traiano) and $\Phi_{\text{building}}(\mathbf{x}) > 5.0\,\text{m}$.
  - Ground elevation is sampled directly from the local photogrammetric mesh at the root collar.
  - The ground mesh under cleared canopy lumps is re-textured with seamless park turf/soil PBR materials, eliminating stretched aerial tree textures.

---

## 5. Visual Critic Quality Audit & 8-Dimension Rubric

Following `.agents/skills/visual-critic/SKILL.md`, the output must achieve **$\ge 8.5/10$ across all 8 dimensions**:

```
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ Dimension                            │ Verification Standard                │
├──────────────────────────────────────┼──────────────────────────────────────┤
│ 1. Geometry & Silhouette             │ Sharp, un-melted Vitruvian arcades;  │
│                                      │ intact Celian residential roofs.     │
│ 2. Mesh Topology & UV Integrity      │ Zero stretched UV streaks; smooth    │
│                                      │ watertight manifold transitions.     │
│ 3. Material & Micro-Surface          │ Travertine ashlar micro-relief; PBR  │
│                                      │ roughness variation; no plastic look.│
│ 4. Environmental Grounding           │ 100% intact Roman city district;     │
│                                      │ zero floating geometry or voids.     │
│ 5. Radiometric Lighting & Shadows    │ Rome NOAA diurnal solar ephemeris;   │
│                                      │ deep contact AO inside archways.     │
│ 6. Color Temperature & Radiance      │ Warm golden hour (5500K) with blue   │
│                                      │ Rayleigh ambient sky dome (12000K).  │
│ 7. Volumetric Depth & Interleaving   │ Soft botanical root contact in turf; │
│                                      │ zero hard polygonal scissor cuts.    │
│ 8. The "Squint Test"                 │ Indistinguishable from an aerial     │
│                                      │ photograph taken over Rome.          │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

### Automatic Disqualifier Verification ("Red Lines")
* ❌ **No Bisected or Crushed Buildings**: Celian Hill residential blocks must retain full physical height ($Y \in [55, 65]\,\text{m}$).
* ❌ **No UV Smearing / Waterfall Needles**: All surfaces must have conformal, distortion-free UV coordinates.
* ❌ **No Floating Trees on Rooftops**: Trees must only exist on cadastral soil/turf.
* ❌ **No Untextured Flat Grey Slabs**: All streets, sidewalks, and plazas must possess authentic PBR textures.

---

## 6. The 3-Stage Progressive Pipeline Implementation

```
+-----------------------------------------------------------------------------------+
| STAGE 1: AUTHENTIC REAL-WORLD 3D TILE IN 18% STUDIO GREY CLAY                     |
| - Ingest pristine Colosseum district GLB (colosseum_rome_textured.glb)            |
| - Override materials with 18% Studio Grey Clay (roughness=0.85, albedo=[0.56])    |
| - Binary buffer cross-section profiling to lock exact centroid and ellipse axes   |
| - Isolate photogrammetric defects: melted arcades, solid curtain walls, foliage  |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 2: VECTOR-REFINED CLASSICAL ARCHITECTURAL GEOMETRY (18% CLAY)               |
| - Cadastral distance field locks building parcels (0.000mm drift)                 |
| - Excises melted inner/outer Colosseum curtain walls via analytical ellipse math  |
| - Synthesizes 4-tier Vitruvian arcades (80 bays/tier, Tuscan/Ionic/Corinthian)    |
| - Excises foliage blobs ONLY in Colle Oppio park; instances SB-Veggie Stone Pines |
| - Re-surfaces cleared park ground with continuous smooth terrain                  |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| STAGE 3: MASTER PBR REALITY WITH PHOTOGRAMMETRIC CONTEXT FUSION                   |
| - Preserves authentic high-resolution photographic albedo for city block          |
| - Derives Sobel/Scharr micro-surface normal relief for travertine and brick       |
| - Assigns physical roughness from continuous R^16 manifold (stone, pavers, turf)  |
| - Bakes geometric contact AO in archways, vomitoria, and under cornices           |
| - Relights under Rome NOAA solar ephemeris (41.8902 N, 12.4922 E, 48 deg sun)     |
+-----------------------------------------------------------------------------------+
```

---

## 7. The 3-Way Architectural Vantage Verification Triad

Camera coordinates are evaluated dynamically via `AdaptiveSurveyRigService` (`plan_adaptive_survey_rig`) as continuous geometric functions of the asset's Oriented Bounding Box (OBB) and surface normals:

| Vantage Class | Dynamic OBB Equation | Evaluated Coordinates | Spatial Purpose | What It Audits |
| :--- | :--- | :--- | :--- | :--- |
| **1. Aerial District Master** | $\mathbf{P} = \mathbf{C}_{\text{OBB}} + 1.6 \cdot \max(W, H, D) \cdot \mathbf{v}_{\text{orbit}}(25^\circ, 38^\circ)$ | `pos: [-145, 120, 160]`, `target: [-43, 25, 62]`, `FOV: 46°` | City District Scale | Amphitheater ellipse silhouette, Celian residential block integrity, Colle Oppio park integration |
| **2. Facade Mid-Rise** | $\mathbf{P} = \mathbf{P}_{\text{facade}} + 0.5 \cdot H \cdot \mathbf{n}_{\text{outer}} + \mathbf{u}_y \cdot 12\,\text{m}$ | `pos: [-45, 32, -40]`, `target: [-43, 25, 30]`, `FOV: 52°` | Architectural Scale | 80 pierced arcade openings, Tuscan/Ionic/Corinthian pilaster articulation, attic corbels |
| **3. Pedestrian Piazza / Park** | $\mathbf{P} = \mathbf{P}_{\text{piazza}} + 1.7\,\text{m} \cdot \mathbf{u}_y$ | `pos: [15, 23.7, 75]`, `target: [-43, 28, 62]`, `FOV: 58°` | Human & Botanical Scale | Sanpietrini cobblestone pavers, street curbs, SB-Veggie Stone Pine trunk bark, contact shadows |

---

## 8. Interactive Showcase UX & AI Prompt Interface

The interactive web demo ([`public/demos/showcase/colosseum_omnispatial_master_demo.html`](file:///Users/eligreen/dev/scratchbox-ide-master/public/demos/showcase/colosseum_omnispatial_master_demo.html)) provides:
1. **Natural Language AI Prompt Command Bar**: Freeform prompt processing ("Stage 1 Clay", "Stage 2 Vector Refined Arcades", "Stage 3 PBR Reality", "Inspect Pierced Arcades", "Wipe Comparison").
2. **Interactive Quick-Prompt Chips**: Canonical one-click pipeline triggers.
3. **Live Streaming C++20 Engine Terminal**: Real-time console with millisecond timestamps tracking centroid locking, UTDRA curtain excision, SB-Veggie botanical growth, PBR manifold evaluation, and NOAA solar harmonization.
4. **Interactive Multi-Mode Inspection**: Dual Split View, Interactive Split Wipe Slider, 2.5x Detail Loupe, and 3D Free Orbit Viewport.
5. **Universal Relative Asset Resolution**: Cascaded multi-tier path resolution (`../../renders/...`, `../../models/...`) guaranteeing zero black-screen errors across `file:///`, dev server, and production deployments.

---

## 9. Actionable Execution Steps

1. **Purge Mutilated Models & Restore Pristine District**:
   * Restore the clean, intact building geometry from `colosseum_rome_recipe_pbr.glb` / `colosseum_rome_textured.glb` to guarantee Celian residential buildings and streetscapes remain at their full authentic heights ($Y \approx 55\,\text{m} - 65\,\text{m}$).
2. **Implement Cadastral Vector Gating**:
   * Formulate the building parcel exclusion mask in `PhotogrammetricTerrainHarmonizerService.ts`, permanently locking all urban building footprints ($0.000\,\text{mm}$ displacement tolerance).
3. **Surgical Botanical Replacement in Parco del Colle Oppio**:
   * Restrict tree replacement strictly to verified green space coordinates, instancing anatomical *Pinus pinea* models and re-texturing the cleared turf.
4. **Compile C++20 Vitruvian Arcade Mesh**:
   * Synthesize the pierced 4-tier Vitruvian amphitheater geometry via `scratchbox_archie.hpp` and compile through `NativeCppCompilerService`.
5. **Evaluate Biophysical PBR Manifold & NOAA Relighting**:
   * Apply derived micro-normals, roughness, and geometric contact AO; relight under Rome solar ephemeris.
6. **Capture High-Resolution 4K Proof Plates & Showcase Demo**:
   * Render the 3-Way Architectural Vantage Triad across Stage 1, Stage 2, and Stage 3; package into the interactive showcase demo.
