# Universal High-Rise Procedural Synthesis & Photogrammetric Rectification Pipeline
## Architectural Directive & Skill Specification for Open-Domain 3D Skyscraper Generation

---

### 1. Executive Summary & Problem Formulation

Raw photogrammetric 3D tiles (such as Google Maps 3D Tiles) capture real-world metropolitan massing, but suffer from severe spatial and geometric defects when inspected at close or medium range:
1. **Photogrammetric Facade "Melting"**: Vertical walls sag inward, window frames lose coplanarity, and building corners become soft, undulating noise.
2. **Ground-Level "Curtain Wall" Occlusion**: Street-level geometry turns into solid vertical walls that seal off pedestrian sidewalks and entrance porticos.
3. **Baked Low-Resolution Shadows**: Lighting baked into the photogrammetry produces dark streaks and prevents dynamic relighting under diurnal solar ephemeris.

#### The Visual Critic Challenge & Orbit Defect Discovery
In early iterations of procedural high-rise replacement, two critical failures occurred:
- **The Street-Level Illusion**: Offline path-traced renders taken from street level (looking up at the entrance portico) appeared convincing because camera framing hid the upper shaft and roof.
- **The 3D Free Orbit Failure Mode**: When users orbited the 3D model (`.glb`) to an elevated or aerial vantage, severe visual defects were exposed:
  - The upper shaft (Floors 30 to 85, from $96\,\text{m}$ to $320\,\text{m}$) was modeled as a monolithic rectangular box ($60\,\text{m} \times 38\,\text{m}$) lacking authentic setback tiers.
  - The roof at $320\,\text{m}$ was capped with a flat pitch-black bitumen ballast block (`baseColorFactor: [0.12, 0.12, 0.13, 1.0]`).
  - The mooring mast was a crude 3-cylinder peg ($110$ vertices) without the 86th floor open-air observation promenade, enclosed pavilion, fluted octagonal mooring mast, 102nd circular glass gallery, or broadcast lattice spire.
  - In side-by-side split comparison, the procedural building sat in an empty void, completely detached from the surrounding city block.

---

### 2. Adaptive Domain Architecture (ADA) & Open-Domain Universality

To ensure this pipeline applies to **ANY location on Earth or any extraterrestrial settlement**, the synthesizer is architected with **Zero Closed Taxonomies**:
- **Strict Prohibition on Closed Enums**: Never declare `enum class SkyscraperStyle { ART_DECO, GOTHIC, MODERN }`.
- **The Alien Planet Test**: Any high-rise edifice—whether the Empire State Building, Chrysler Building, Taipei 101, Burj Khalifa, or a crystalline terraforming tower on Mars—must be parameterized purely through continuous physical fields ($\mathbb{R}^N$).

#### Continuous Physical Parameter Schema (`AdaptiveHighRiseParams`)
```cpp
struct ContinuousSetbackTier {
    float yMinMeters;               // Elevation base of this tier
    float yMaxMeters;               // Elevation top of this tier
    float widthXMeters;             // Footprint width along primary axis
    float depthZMeters;             // Footprint depth along secondary axis
    float cornerInsetMeters;        // Art Deco re-entrant corner notch dimension
    float floorToFloorHeightMeters; // Structural slab spacing
    float bayWidthMeters;           // Center-to-center window bay pitch
    float pierReliefMeters;         // Normal projection of vertical structural piers
    float spandrelRecessMeters;     // Inset depth of decorative bronze spandrel panels
};

struct ContinuousCrownMastParams {
    float promenadeDeckElevationMeters; // e.g. 320.0m (86th Floor)
    float promenadeParapetHeightMeters; // e.g. 1.25m safety perimeter
    float pavilionWidthMeters;          // e.g. 30.0m enclosed observation deck
    float pavilionDepthMeters;          // e.g. 19.0m
    float mastBaseElevationMeters;      // e.g. 328.0m (Floors 87-101)
    float mastTopElevationMeters;       // e.g. 365.0m
    float mastBaseRadiusMeters;         // e.g. 8.2m
    float mastTopRadiusMeters;          // e.g. 5.6m
    int   mastHarmonicOrder;            // K = 4 for octagonal fluting, K = 0 for cylinder
    float galleryElevationMeters;       // e.g. 365.0m (102nd Floor circular gallery)
    float galleryRadiusMeters;          // e.g. 4.4m
    float spireTipElevationMeters;      // e.g. 443.2m
    int   latticeLegCount;              // 4 structural steel lattice legs
};
```

---

### 3. The 4 Universal Differential Geometric Operators

In accordance with Scratchbox IDE Agent Directives, all architectural components are synthesized via the 4 Universal Geometric Operators:

1. **Harmonic Solids of Revolution**:
   Radial profiles $r(z)$ revolved around the central vertical axis with continuous radial harmonic lobes:
   $$r(\theta, z) = r_0(z) \cdot \left[1 + A(z) \cos(K \theta)\right]$$
   - $K = 4, A = 0.08$: Generates the fluted, stepped octagonal mooring mast (Floors 87–101).
   - $K = 0, A = 0.0$: Generates the 102nd floor circular glass observation gallery and conical mooring dome cap.

2. **$\mathrm{SE}(3)$ Lie Group Curve Sweeps**:
   Sweeps continuous cross-sectional profiles along 3D carrier curves $\mathbf{C}(t)$:
   - Generates the continuous vertical limestone structural piers running un-interrupted from base to crown.
   - Generates the observation promenade perimeter safety railings and mullions.

3. **Affine Metric Replicators**:
   Periodic affine distribution of seed geometry along 1D curves or 2D manifolds at continuous pitch $p$:
   - Facade window bay apertures and structural pier rhythm along perimeter edges:
     $$\mathbf{P}_i = \mathbf{P}_{\text{start}} + i \cdot \mathbf{u} \cdot p, \quad i \in [0, N-1]$$
   - Horizontal circular antenna platforms distributed along the broadcast spire at continuous metric elevations ($398\,\text{m}, 412\,\text{m}, 426\,\text{m}, 438\,\text{m}$).

4. **Isoparametric Normal Relief Fields**:
   Surface normal displacements $\Delta h(u, v) \, \mathbf{n}(u, v)$:
   - Window spandrel recesses: Displaces window glazing inward by $-0.28\,\text{m}$ relative to outer wall normal.
   - Structural pier relief: Displaces limestone piers outward by $+0.45\,\text{m}$ along surface normals.
   - Ground plinth granite base course: Displaces the lowest $4.5\,\text{m}$ outward by $+0.20\,\text{m}$.

---

### 4. Enforcing the 70-20-10 Form Hierarchy

To ensure cinematic photographic fidelity from any orbit angle, geometry is strictly stratified:

```
+-----------------------------------------------------------------------------------------+
| 70% PRIMARY EDIFICE / SILHOUETTE                                                        |
| - Continuous 6-Tier Stepped Setback Hierarchy:                                          |
|   * Podium Base:   128m x 60m  (Y: 0m to 24m)   - 5-story street-wall podium            |
|   * Tier 1:        88m x 54m   (Y: 24m to 68m)  - 6th floor major setback               |
|   * Tier 2:        78m x 48m   (Y: 68m to 82m)  - Intermediate transition               |
|   * Tier 3:        70m x 43m   (Y: 82m to 96m)  - Tower base setback                    |
|   * Tier 4 Shaft:  60m x 38m   (Y: 96m to 258m) - Main shaft with 3.2m corner notches   |
|   * Tier 5:        53m x 34m   (Y: 258m to 294m)- Upper transition setback              |
|   * Tier 6:        46m x 30m   (Y: 294m to 320m)- 85th floor observation pedestal       |
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------------+
| 20% SECONDARY ARTICULATED ASSEMBLIES                                                    |
| - 86th Floor Open-Air Observation Promenade (Y: 320m):                                  |
|   * Stone paver terrace decking (albedo=[0.55, 0.54, 0.50], roughness=0.75)             |
|   * Perimeter parapet coping wall & stainless steel safety railings                     |
| - 86th Floor Enclosed Observation Pavilion (30m x 19m, Y: 320m to 328m):                |
|   * Wrap-around panoramic ribbon viewing glazing & warm interior lighting               |
| - Stepped Octagonal Mooring Mast (Y: 328m to 365m):                                     |
|   * 4 Art Deco projecting corner buttress fins                                          |
| - 102nd Floor Circular Glass Observation Gallery (R: 4.4m, Y: 365m to 373m):            |
|   * 24 vertical stainless steel window mullions                                         |
| - Stepped Conical Mooring Dome Cap (Y: 373m to 381m)                                    |
| - 3-Story Monumental Entrance Portico & Cantilevered Marquee Canopies on 5th Ave        |
+-----------------------------------------------------------------------------------------+
                                           |
                                           v
+-----------------------------------------------------------------------------------------+
| 10% TERTIARY MICRO-DETAIL                                                               |
| - 4-Leg Structural Steel Broadcast Lattice Spire (Y: 381m to 443.2m):                   |
|   * 4 horizontal circular antenna platforms & red aviation strobe beacons               |
| - Rooftop mechanical elevator penthouses and HVAC chillers on setback terraces          |
| - Scored pedestrian sidewalk apron with beveled granite curbs                           |
| - Anatomical botanical street trees instanced along pedestrian corridors (SB-Veggie)    |
+-----------------------------------------------------------------------------------------+
```

---

### 5. Multi-Slot PBR Biophysical Material Grounding

A key insight that eliminated the flat black roof defect was **replacing bitumen ballast with stone paver decking**:
- The 86th floor observation deck is not an industrial gravel roof; it is a paved tourist promenade.
- Assigning `Mat_StonePaverDecking` (`baseColorFactor: [0.55, 0.54, 0.50, 1.0]`, `roughnessFactor: 0.75`) matches the limestone tone and gives the promenade authentic visual weight.

#### The 12 Discrete PBR Mesh Slots:
1. `Hero_IndianaLimestone`: Outer piers, spandrel jambs, parapets ($92,872$ vertices)
2. `Hero_CharcoalGranitePlinth`: Ground-level street base course
3. `Hero_ArtDecoSpandrels`: Chevron-patterned dark bronze window spandrel panels ($17,480$ vertices)
4. `Hero_StainlessSteel`: Mullions, pilaster trim, promenade railings ($22,050$ vertices)
5. `Hero_ArchitecturalGlazing`: Dielectric window glass with sky reflections ($17,658$ vertices)
6. `Hero_StatuaryBronze`: Revolving doors, entrance marquee trim, signage
7. `Hero_StonePaverDecking`: 86th floor open-air observation promenade
8. `Hero_ScoredSidewalkApron`: Sidewalk pavers with pedestrian curb reveals
9. `Hero_GrandLobbyInterior`: Emissive warm illumination for 3-story grand entrance
10. `Hero_MooringMastAndSpire`: Architectural aluminum mooring mast, dome, and antenna spire
11. `SBVeggie_OakTrunks`: Procedurally branch-modeled botanical street trees ($305,472$ vertices)
12. `MidtownManhattan_SurroundingDistrict`: Excised photogrammetric city block ($468,744$ vertices)

---

### 6. Sub-Millimeter Tile Excision & City Context Fusion Protocol

To solve the "void detachment" defect where the procedural building floated without surrounding blocks:
1. **Raw Tile Ingestion**:
   Load raw Google 3D Tile (`scan_studio_tile_esb_77197_98526.glb`) containing $169,588$ triangles.
2. **Spatial Geofencing Excision**:
   Define an excision AABB around the hero building parcel:
   $$X \in [-70\,\text{m}, +70\,\text{m}], \quad Z \in [-52\,\text{m}, +52\,\text{m}], \quad Y > 2.0\,\text{m}$$
3. **District Mesh Preservation**:
   Retain all triangles outside the excision volume ($156,248$ triangles, $468,744$ vertices).
4. **Photogrammetric Vertex Color Baking**:
   Sample the raw tile's photogrammetric texture map directly into per-vertex `COLOR_0` attributes. This preserves the surrounding Midtown Manhattan district without requiring multiple texture atlases.
5. **Unified glTF Scene Serialization**:
   Stream the procedural hero building and the preserved surrounding district into a single standardized binary `.glb` (`omnispatial_real_stage3_streetview_pbr.glb`).

---

### 7. Performance & Compilation Invariants

- **Compile Time Optimization**:
  Targeting modular C++ headers (`scratchbox_math.hpp`, `scratchbox_geometry.hpp`, `scratchbox_io.hpp`, `scratchbox_gltf_scene.hpp`, `scratchbox_pbr_manifold.hpp`) drops compilation time from $45\,\text{s}$ down to **$8.2\,\text{s}$** under Apple Clang `-std=c++20 -O2 -lz`.
- **Mesh Synthesis Speed**:
  Generates $924,892$ vertices and $333,860$ triangles in **$1.8\,\text{seconds}$** on Apple Silicon.
- **Path-Traced Verification**:
  CPU path-traced rendering with 16 spp across $333,860$ triangles settles in $37$ to $72\,\text{seconds}$ with BVH acceleration.
