---
name: omnispatial-photogrammetric-reshaping
description: >-
  Extract, reshape, and synthesize grounded architectural, botanical, and micro-surface geometry from raw 3D photogrammetric tiles (Google Maps 3D Tiles, drone scans) using continuous physical fields, frequency-derived normal relief, quadric canopies, Dirichlet harmonic boundary preservation for ruins, and elevation-stratified PBR de-lighting in strict compliance with Adaptive Domain Architecture (ADA).
---

# Omnispatial Photogrammetric Reshaping Skill

The **Omnispatial Photogrammetric Reshaping Skill** equips AI agents to transform raw, noisy photogrammetric 3D tiles (e.g., Google Maps Photorealistic 3D Tiles, Cesium datasets, drone photogrammetry) into clean, high-fidelity architectural assets, anatomical botanical armatures, and physical PBR surfaces.

By strictly adhering to **Adaptive Domain Architecture (ADA)**, this skill eliminates closed taxonomies (no rigid enums like `'spanish_tile' | 'slate'` or `'oak' | 'pine'`). Instead, all operations are governed by **continuous differential geometric operators** and mathematical inversion of lighting signals embedded inside raw photogrammetric tile textures.

---

## 1. Core Architectural Pillars & ADA Invariants

```
                      Raw 3D Photogrammetric Tile (.glb)
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
 [Geometric Inversion]       [Dirichlet Preservation]       [NOAA Solar Ephemeris]
  Texture Frequency FFT       Harmonic Boundary Lock         Location (lat, lon, time)
  Shadow Gradient Analysis    SDF Void Excavation            Solar Vector L_sun
        │                              │                              │
        ▼                              ▼                              ▼
 [Operator 1: Undulation]    [Operator 2: Quadric Trees]    [Operator 4: De-Lighting]
  Continuous Roof Corrugation  SE(3) Carrier + Quadric Crown  Shadow Inversion & Toksvig AA
        │                              │                              │
        └──────────────────────────────┼──────────────────────────────┘
                                       ▼
                       [Native C++20 Clang Assembly]
                    (scratchbox_engine.hpp / Archie / Shaper)
                                       │
                                       ▼
                      Standard Binary glTF 2.0 (.glb)
                     (PBR Metallic-Roughness, Normal Maps)
                                       │
                                       ▼
                      [Omnispatial Multi-Mode Viewport]
                  (Dual Split · Wipe Slider · Loupe · 3D Orbit)
```

### The Alien Planet Test (Zero Closed Taxonomies)
1. **No Hardcoded Classification Enums**: Never declare `type Roof = 'spanish' | 'slate' | 'flat'` or `type Tree = 'pine' | 'oak' | 'palm'`. Any arbitrary architectural or biological morphology must be represented through continuous dimensional parameters.
2. **Diagnostic Open Literals**: Where human-readable telemetry is helpful, use open string literals: `type TopologySignature = 'corrugated_tiles' | 'parasol_canopy' | (string & {})`. Logic must never branch on string matches.
3. **Information Inversion from Photo Tiles**: A flat photogrammetric polygon contains rich 2D photographic lighting clues. Alternating light and dark bands indicate surface corrugation; shadow penumbras indicate relief depth. The engine analyzes frequency and gradient data from the image to calculate normal relief $\Delta h(u, v)\,\mathbf{n}$.
4. **Preservation of Historical Ruin Character**: Ancient structures and ruins (such as the Colosseum) must never be subjected to "plastic restoration." Missing spans and seismic fracture boundaries are locked with zero-tolerance Dirichlet boundary conditions ($w=1.0$), while interior melted voids are analytically carved.
5. **Zero JavaScript Generative Primitives**: Stacking flat Three.js primitives (`new THREE.BoxGeometry`, etc.) is strictly prohibited. All geometric synthesis occurs in native C++20, streaming binary `.glb` chunks directly to the viewport.
6. **Fresh Ingestion for New Workflows (Prohibition on Stale/Distorted Legacy Re-Use)**: If starting a new workflow, or whenever an existing model exhibits distortion, non-uniform scaling, or legacy editing artifacts, agents must NEVER inherit stale intermediate `.glb` assets. Always download/extract a fresh 3D model directly from Google Maps Platform Photorealistic 3D Tiles (`getGoogle3DTilesFullTexture` / `getGoogle3DTilesClay`) at leaf LOD (`errorTarget <= 0.5`) to establish a pristine, uncorrupted ground-truth geometric foundation.

---

## 2. The 4 Universal Differential Reshaping Operators

### Operator 1: Continuous Anisotropic Undulation Field (Roofs & Corrugated Surfaces)
Translates 2D frequency patterns from tile textures into physical 3D normal displacement:

$$\Delta h_{\text{tile}}(u, v) = A(u, v) \left( \sin\left(\frac{2\pi u'}{\Lambda}\right) + \frac{1}{3}\sin\left(\frac{6\pi u'}{\Lambda}\right) \right)^\gamma + \mathcal{N}_{\text{micro}}(u, v)$$

Where $u' = u \cos\theta + v \sin\theta$ aligns with the dominant roof slope azimuth $\theta$.

* **Spatial Wavelength ($\Lambda \in [0.05, 1.5]\text{m}$)**: Extracted via 2D Fast Fourier Transform (FFT) or Gabor filter bank on the tile texture. For Roman/Spanish barrel tiles, $\Lambda \approx 0.22\text{m}$; for industrial metal decking, $\Lambda \approx 0.075\text{m}$; for broad terracotta pantiles, $\Lambda \approx 0.35\text{m}$.
* **Corrugation Amplitude ($A \in [0.01, 0.15]\text{m}$)**: Derived from the photographic shadow gradient width across the ridge.
* **Profile Exponent ($\gamma \in [0.5, 10.0]$)**: Governs trough roundness vs. ridge sharpness ($\gamma \approx 1.4$ for Roman barrel tiles; $\gamma \ge 8.0$ for stepped flat slates).
* **Micro-Relief Noise ($\mathcal{N}_{\text{micro}}$)**: Multi-octave Simplex noise injecting material grain, kiln-firing camber variance, and weathering chips.

---

### Operator 2: Quadric Revolution Field & Anatomical Foliage (Trees & Canopies)
Reconstructs photogrammetric foliage "broccoli blobs" into structurally grounded botanical armatures:

1. **Trunk Carrier Curve**: 3D space curve $\mathbf{C}(t)$ sweeping continuous radial profiles with clear-stem height $h_{\text{clear}} \in [2, 20]\text{m}$. The trunk extends into the terrain mesh, eliminating floating canopy curtains.
2. **Quadric Revolution Crown Envelope**:
   $$r_{\text{crown}}(z) = R_{\text{max}} \left( 1 - \left( \frac{z - z_{\text{cog}}}{h_{\text{crown}}} \right)^2 \right)^\rho$$
   * **$z_{\text{cog}}$ (Center of Gravity Elevation)**: High values ($z_{\text{cog}} \approx 0.75\, h_{\text{crown}}$) produce flat-topped parasol canopies (e.g. Mediterranean *Pinus pinea*); low values ($z_{\text{cog}} \approx 0.25\, h_{\text{crown}}$) produce decurrent weeping forms; mid values produce ovate crowns.
   * **$\rho$ (Flatness Exponent)**: $\rho \approx 0.40$ yields the characteristic umbrella crown; $\rho \approx 1.0$ yields a standard ellipsoid; $\rho > 2.0$ yields cylindrical columnar forms.
3. **Harmonic Solid Modulation**: Applies $K$ radial lobes ($K \in [3, 8]$) with helical twist to create natural branch cluster clumps without polygon explosion.

---

### Operator 3: Dirichlet Harmonic Boundary Clamping & Ruin Void Excavation
Preserves the authenticity of weathered historic ruins while restoring hollow structural voids:

1. **Fracture Line Locking**:
   $$\mathbf{x}_{\text{rectified}}(u, v) = w(u, v)\,\mathbf{x}_{\text{scan}}(u, v) + (1 - w(u, v))\,\mathbf{x}_{\text{parametric}}(u, v)$$
   Along jagged ruin fractures and weathered masonry breaks, $w(u, v) = 1.0$. The engine never reconstructs missing tiers, arches, or collapsed vaults.
2. **SDF Void Carving (Excavating Webbed Apertures)**:
   Photogrammetry regularly seals open archways with webbed mesh sheets. The engine identifies arcade centers along radial axes $\theta_k = k \frac{2\pi}{N}$ and performs analytical boolean subtractions:
   $$\Phi_{\text{arch}}(\mathbf{x}) = \max\left( \sqrt{x^2 + z^2} - R_{\text{vault}}, \; |y| - \frac{W_{\text{bay}}}{2}, \; -d_{\text{depth}} \right)$$
   Carving voids to depth $d_{\text{depth}} \ge 4.2\text{m}$ restores authentic Roman barrel vaults, shadows, and interior ambulatory sightlines.

---

### Operator 4: Biophysical Inverse Solar De-Lighting & Patina Synthesis
Removes baked harsh shadows from aerial photogrammetry and synthesizes physical PBR material maps:

1. **NOAA Solar Ephemeris Inversion**:
   Given real-world geodetic coordinates $(\phi, \lambda)$ and capture timestamp, calculate the solar unit vector $\mathbf{L}_\odot$, direct solar irradiance $E_{\text{sun}}$, and diffuse sky irradiance $E_{\text{sky}}$:
   $$\mathbf{a}(u, v) = \frac{\mathbf{I}_{\text{raw}}(u, v)}{\max\left(\mathbf{n}(u, v) \cdot \mathbf{L}_\odot, \; \varepsilon\right) E_{\text{sun}} + E_{\text{sky}}}$$
   Where $\varepsilon \approx 0.18$ prevents division-by-zero singularities in deeply self-shadowed recesses.
2. **Elevation-Stratified Fusion**:
   Blends high-resolution street-level photography (pedestrian portals, ashlar masonry) with aerial de-lighted scans using a smooth Hermite cubic sigmoid:
   $$w(z) = 3s^2 - 2s^3, \quad s = \operatorname{clamp}\left( \frac{z - z_{\text{min}}}{z_{\text{max}} - z_{\text{min}}}, 0, 1 \right)$$
3. **Toksvig Normal Filtering for Specular Anti-Aliasing**:
   Compresses micro-facet roughness based on normal map variance within the camera pixel footprint, eliminating specular scintillation on fine masonry and corrugated roof edges:
   $$\alpha_{\text{eff}} = \sqrt{\alpha^2 + \left( \frac{1 - |\mathbf{n}_{\text{avg}}|}{|\mathbf{n}_{\text{avg}}|} \right)}$$

---

### Operator 5: Empirical Dirichlet Boundary Extraction & Zero-Drift Structural Locking (The Zero-Wall-Tree Invariant)
Prevents false canopy detection and tree placement on monument walls caused by cadastral or textbook footprint mismatches:

1. **The Cadastral Trap**:
   Never use idealized textbook footprints ($L \times W$) or 2D cadastral lot lines as Dirichlet boundaries. Real-world photogrammetry captures structural asymmetry (e.g. surviving Roman outer arcade tiers, buttresses, cornice overhangs, or local origin offsets). Any elevated masonry ($Y > 1.8\text{m}$) falling outside an idealized boundary is misclassified as organic tree canopy, flattened to ground datum, and populated with trees.
2. **Empirical Vertex Point Cloud Extraction**:
   Derive the Dirichlet envelope directly from the 3D vertex cloud ($\mathrm{elev} > h_{\text{floor}}$) using PCA / Oriented Bounding Box (OBB) covariance analysis:
   $$\mathbf{c} = \frac{1}{N} \sum_{i=1}^N \mathbf{v}_i, \quad \mathbf{\Sigma} = \frac{1}{N} \sum_{i=1}^N (\mathbf{v}_i - \mathbf{c})(\mathbf{v}_i - \mathbf{c})^T$$
   Extract principal axes $(a, b)$ and yaw $\theta$ from the eigenvectors of $\mathbf{\Sigma}_{xz}$.
3. **The Zero-Leakage Pre-Flight Invariant (`outsideCount === 0`)**:
   Enforce a safety margin ($\delta \in [1.5, 2.5]\text{ m}$) ensuring $100\%$ of structural building vertices satisfy containment before canopy resection begins:
   $$\left( \frac{(x - c_x)\cos\theta + (z - c_z)\sin\theta}{a + \delta} \right)^2 + \left( \frac{-(x - c_x)\sin\theta + (z - c_z)\cos\theta}{b + \delta} \right)^2 \le 1.0$$
   If `outsideCount > 0`, execution is halted and the boundary is dynamically expanded.

---

### Operator 6: Biophysical Cross-Domain Gamut Harmonization & Chroma-Preserving De-Lighting
Eliminates extreme saturation disparity between high-chroma synthetic DCC assets (trees, props) and low-chroma aerial photogrammetric stone:

1. **The Cross-Domain Gamut Problem**:
   * *Botanical Tree Assets*: Authored with rich chlorophyll albedo ($S \approx 0.62\text{–}0.70$, $G \approx 0.50$, $R \approx 0.25$).
   * *Photogrammetric Stone*: Aerial capture through atmospheric Rayleigh haze desaturates stone; natural Roman travertine limestone is calcium carbonate ($\mathrm{CaCO}_3$) with intrinsically low chroma ($S \approx 0.17\text{–}0.24$).
   * *The Diffuse Wash Effect*: When converting unlit photogrammetry (`KHR_materials_unlit`) to standard PBR metallic-roughness ($R = 1.0, M = 0.0$), the neutral studio environment map scatters pure white diffuse light across pale stone, acting like white paint that dilutes warm stone tones.
2. **Chroma-Preserving Shadow Lifting (Prohibition on Scalar RGB Scaling)**:
   Never lift shadows by multiplying $R, G, B$ by a scalar multiplier ($\text{lift} = 1.0 + k \cdot \text{shadow}^2$), which bleaches dark crevices into flat grey. De-lighting kernels must operate in polar chroma space (HSV or CIELAB), expanding saturation ($\Delta S$) proportionally to shadow depth:
   $$S_{\text{lifted}} = \operatorname{clamp}\left( S \cdot \left(1.0 + \beta \left(\frac{L_{\text{target}} - L}{L_{\text{target}}}\right)\right), \; 0.0, \; 1.0 \right)$$
   Preserving amber, ochre, and limonite tones in shadowed arcade recesses.
3. **Biophysical Eco-Region Gamut Clamping**:
   Instanced vegetation albedos must be dynamically harmonized to match the regional biome/climate (e.g. Mediterranean arid pine/cypress clamped to $S \approx 0.38\text{–}0.42$) to avoid the appearance of neon tropical trees in arid urban landscapes.

---

### Operator 7: Curtain-Wall Excision & Oblique Sightline Restoration
Excises solid photogrammetric webbing underneath elevated architectural spans, arches, and bridges:

1. **Curtain Web Detection**:
   Identify near-vertical triangulation sheets ($|\mathbf{n}_y| < 0.15$) spanning horizontal openings between solid ground piers ($W_{\text{span}} \in [2.5, 12.0]\text{ m}$).
2. **Analytical Topology Pruning (Geofenced Excision Only)**:
   Excise web triangles intersecting the portal bounding envelope while clamping border vertices to preserve pier masonry integrity with zero boundary raggedness.
   * **Mandatory Geofencing Invariant**: Never apply blanket vertical span culling ($\Delta Y > \text{threshold}$) globally across the entire tile set. Global culling inadvertently destroys real building facades, perimeter walls, and hillside terrain outside Dirichlet locks, punching holes through the model where the sky void shows through. Excision must be strictly geofenced to targeted monument coordinates (e.g. Arch of Constantine undercuts).

---

### Operator 8: Planar Vector Road Networks & Beveled Hardscape Infrastructure
Replaces melted, distorted photogrammetric asphalt with mathematically true planar carriageways and beveled granite curbs:

1. **Elevation Offset & Anti-Clipping**:
   Vector road ribbons sit $+0.06\text{m}$ above the photogrammetric terrain DTM bare-earth surface, preventing z-fighting with the underlying photogrammetry while following real-world grade changes.
2. **Continuous 5-Tier Road Cross-Section**:
   * *Carriageway*: Full road width ($W_{\text{road}} \approx 12.0\text{m}$) following road centerline splines.
   * *Dual Beveled Granite Curbs*: Vertical height $+0.15\text{m}$, width $0.20\text{m}$, with a $45^\circ$ beveled chamfer facing the roadway.
   * *Flanking Sidewalks*: Width $W_{\text{walk}} \approx 3.0\text{m}$ elevated $+0.15\text{m}$ flush with curb tops.
3. **The Ground-Truth Paving Sampling Invariant**:
   When extracting PBR textures from Street View or ground-level panoramas to bind to planar road meshes, the cropping ROI must strictly sample planar ground surface aggregate (asphalt, Sanpietrini basalt paving cobblestones).
   * **Prohibition on Vertical Contamination**: The texture crop must NEVER include vertical architectural elements (arches, walls), tourists, or sky.
   * **Visual Artifact Prevention**: Tiling a texture containing sky or vertical structures along the road corridor produces alternating dark and light horizontal bands that look like railway sleepers, wooden boardwalks, or pedestrian zebra crosswalks.

---

### Operator 9: Full-Body Anatomical Botanical Replacement (Trunk + Foliage Multi-Primitive Contract)
Transforms irregular photogrammetric "broccoli blobs" into structurally grounded, biologically accurate tree stands:

1. **Multi-Species Morphological Classification**:
   Terrain harmonizer analyzes canopy height, diameter, and aspect ratio ($H / D$):
   * $\text{Aspect} > 1.5$ or ($D \le 5.2\text{m}$ and $H \ge 7.5\text{m}$): Classified as **Italian Cypress** (*Cupressus sempervirens*), slender columnar evergreen.
   * $D > 8.0\text{m}$ and high center of gravity ($z_{\text{cog}} \ge 0.65$): Classified as **Italian Stone Pine** (*Pinus pinea*), wide parasol umbrella canopy.
   * Moderate diameter and dense canopy: Classified as **Holm Oak** (*Quercus ilex*), dense ovate dome.
2. **Multi-Primitive Asset Integrity Invariant**:
   Any instanced botanical 3D model MUST possess verified multi-primitive armatures containing BOTH bark trunk geometry AND lush green foliage primitives (e.g. `public/models/sb_veggie_cypress.glb`).
   * **The Bark-Only Anti-Pattern**: Loading single-mesh test assets that contain only bark primitives (`material_oak_bark`) without foliage geometry causes tall columnar cypresses to render as bare brown stumps or scattered clumps resembling low bushes.
3. **DTM Bare-Earth Grounding**:
   Trunk roots extend $\ge 0.8\text{m}$ into the depressed terrain DTM surface, ensuring zero floating trees across rolling topography.

---

## 3. Step-by-Step Production Workflow

### Step 1: Raw Photogrammetric Tile Ingestion
* Demand maximum quality: Screen-Space Error (SSE) calculated against 4K ($3840 \times 2160$) viewports with `errorTarget <= 0.5`.
* Wait for tile streaming to settle completely (`stats.downloading === 0 && stats.parsing === 0`).
* Extract bounding box submesh into binary glTF 2.0 (`.glb`). Persist the raw capture as baseline.

### Step 2: Cadastral Alignment & Foundation Grounding
* Query local vector road networks (e.g. Piazza del Colosseo, Via dei Fori Imperiali, 5th Avenue).
* Compute principal building facade azimuth via PCA / OBB covariance.
* Rotate and translate mesh to snap primary street facades into strict alignment with vector parcels ($\Delta \theta < 0.1^\circ$, drift $< 0.05\text{m}$).
* Extend boundary skirt aprons downward by $\ge 5.0\text{m}$ to seal perimeter terrain gaps.
* **Empirical Dirichlet Envelope Extraction**: Fit the monument protection envelope directly from elevated vertices ($Y > h_{\text{floor}}$) using PCA/OBB. Assert the pre-flight invariant `outsideCount === 0` with safety margin $\delta \in [1.5, 2.5]\text{ m}$ before allowing canopy resection to proceed.

### Step 3: Texture Frequency Analysis & Micro-Relief Detection
* Execute 2D spatial FFT or multi-scale Scharr operator on horizontal roof and facade planes.
* Extract dominant corrugation frequency $\Lambda$ and orientation angle $\theta$.
* Discard specular highlights and baked ambient occlusion prior to geometric extraction.

### Step 4: Native C++20 Geometric Reshaping & Curtain-Wall Excision
* Compile ephemeral C++20 pipeline via `NativeCppCompilerService` (`-std=c++20 -O3`).
* Apply **Operator 1** to corrugated roofs and spandrels.
* Apply **Operator 2** to replace canopy blobs with grounded trunk carriers and quadric crowns.
* Apply **Operator 3** to carve hollow archway vaults while locking jagged ruin edges.
* Apply **Operator 7** to excise vertical photogrammetric curtain webs under elevated arches, colonnades, and bridges.
* Calculate transferred envelope normals for soft foliage canopies and sharp facet normals for masonry.

### Step 5: Solar De-Lighting, Gamut Harmonization & PBR Material Baking
* Compute solar vector $\mathbf{L}_\odot$ via NOAA ephemeris.
* Lift self-shadows into unoccluded albedo $\mathbf{a}(u, v)$ using **Operator 6** chroma-preserving expansion in HSV/Lab space (never scalar RGB multiplication).
* Apply biophysical gamut clamping to instanced botanical trees ($S \approx 0.38\text{–}0.42$ for Mediterranean arid pine/cypress) to harmonize with ambient photogrammetry.
* Apply subtle $+15\%\text{–}25\%$ warm-chroma compensation on pale stone albedo to prevent achromatic diffuse wash under neutral studio environment maps.
* Synthesize physical PBR texture sets:
  * **Albedo**: De-lighted, chroma-preserved base color.
  * **Normal**: Scharr 5x5 multi-scale + Toksvig anti-aliasing.
  * **Roughness**: Derived from stone porosity / micro-relief ($\approx 0.85$ for weathered travertine/limestone; $\approx 0.45$ for glazed terracotta).
  * **Metallic**: $0.0$ for mineral stone/tiles; $0.85$ for bronze window grilles/chevrons.

### Step 6: Binary glTF 2.0 Streaming & Multi-Mode Verification
* Serialize watertight geometry, vertex attributes, and PBR material samplers into standard `.glb`.
* Mount to the single canonical production web demo (`public/omnispatial_synthesis_demo.html`).
* Verify across all 4 viewport modes:
  1. **Dual Split**: Side-by-side comparison of Raw Scan vs. Stage 3 PBR.
  2. **Wipe Slider**: 50/50 interactive wipe at identical camera orbit angles.
  3. **Macro Detail Loupe**: 2.5x cursor magnification inspecting stone grain and tile ridges.
  4. **3D Free Orbit**: Real-time orbital navigation powered by `<model-viewer>`.

### Step 7: Automated Targeted-Angle Headless CDP Visual Verification
* Command `<model-viewer>` via Chrome DevTools Protocol (`sendCdp('Runtime.evaluate')`) to execute mandatory targeted close-up camera audits:
  1. **Vulnerable Facade Frame**: Oblique close-up targeting the outer perimeter wall to verify zero wall trees.
  2. **Ground Contact Frame**: Pedestrian eye-level camera verifying terrain depression and solid trunk grounding.
  3. **Macro Detail Loupe Frame**: $2.5\times$ zoom verifying stone strata, Scharr normals, and cavity ambient occlusion.

---

## 4. Grounded Telemetry HUD Contract

Every pipeline execution must compute and display real-time physical telemetry:

```typescript
interface OmnispatialReshapingTelemetry {
  location: {
    name: string;
    coordinates: [number, number]; // [lat, lon]
    cadastralCorridor: string;
  };
  solarEphemeris: {
    sunElevationDeg: number;
    azimuthDeg: number;
    irradianceVector: [number, number, number];
    inversionEpsilon: number;
  };
  geometricTelemetry: {
    rawTriangles: number;
    reshapedTriangles: number;
    hollowedVoidsCount: number;
    roofCorrugationWavelengthMeters: number;
    boundaryClampingDriftMeters: number; // Must be 0.000m on ruins
    monumentVerticesProtected: number;
    monumentVerticesLeaking: number; // Must be 0
  };
  materialBake: {
    delightedAlbedoCoveragePct: number;
    toksvigMipLevels: number;
    roughnessBaseline: number;
    botanicalGamutSaturationClamp: number; // e.g. 0.40
  };
}
```

---

## 5. Summary of Quality Rules & Invariants

1. **Zero Hallucinated Restoration on Ruins**: Weathered fractures and missing structures must remain broken. Clamp boundary vertices ($w=1.0$).
2. **Always Carve Interior Webbing**: If an arch, tunnel, or colonnade is open in the real world, the photogrammetric web must be carved out to at least $4.2\text{m}$ depth.
3. **No Closed Taxonomies**: All roofs, trees, facades, and materials must be defined by continuous dimensional numbers $(\Lambda, A, \gamma, \rho, z_{\text{cog}}, h_{\text{clear}})$.
4. **No Toy JavaScript Primitives**: Geometry must be synthesized through native C++20 SIMD kernels or verified shader pipelines, outputting standardized `.glb`.
5. **Always Verify at 1:1 Scale**: Inspect micro-relief through the 2.5x macro loupe and orbital wipe slider to ensure geometric alignment with zero pixel drift.
6. **The Zero-Wall-Tree Invariant (`outsideCount === 0`)**: Dirichlet protection envelopes must be derived from empirical mesh vertices. Pre-flight checks must assert that $100\%$ of structural building vertices satisfy the containment condition before canopy resection begins.
7. **Prohibition on Scalar RGB Shadow Lifting**: Shadow de-lighting must operate in polar HSV or CIELAB space, expanding saturation ($\Delta S$) proportionally to shadow depth to prevent washing amber/limonite stone into chalky grey.
8. **Biophysical Botanical Gamut Clamping**: Instanced tree foliage must be clamped to the target eco-region ($S \approx 0.38\text{–}0.42$ for Mediterranean vegetation) to eliminate jarring chromatic contrast against photogrammetric stone.
9. **Single-Source Canonical Production Invariant**: All procedural operations must compile directly into canonical master assets (`public/models/colosseum_stage3_master_pbr.glb`) and update the single canonical application demo (`public/omnispatial_synthesis_demo.html`), preventing stale or unpopulated demo views.
10. **Prohibition on Blanket Vertical Curtain-Wall Excision (Geofenced Excision Only)**: Global vertical span thresholding ($\Delta Y > 3.5\text{m}$) across an entire tile set is strictly prohibited. While intended to excise webbed spans beneath arches, global culling indiscriminately collapses legitimate vertical building facades, perimeter walls, and hillside terrain outside Dirichlet locks, punching holes through the model where the sky void shows through. Curtain wall excision must be strictly geofenced to verified monument bounding volumes (e.g. Arch of Constantine undercuts).
11. **Ground-Truth Planar Texture Cropping Invariant**: Textures extracted from Street View or ground photography to bind to planar hardscapes must strictly sample planar asphalt or cobblestone aggregates. Crops must mathematically exclude vertical architecture, arches, tourists, and sky. Tiling a crop containing vertical structures or sky across a road ribbon creates false alternating bands that appear as pedestrian walkways, railway ties, or striped boardwalks.
12. **Botanical Multi-Primitive Completeness Invariant**: Prior to instancing, all botanical species assets must be verified to contain complete armatures with both trunk bark and canopy foliage. Assets with missing foliage primitives will render slender trees (e.g. Italian cypress) as bare brown stumps or low bushes.
13. **Semantic Land-Use & Typology Grounding Invariant (Pedestrian Plazas vs. Vehicular Roads)**: Never synthesize modern vehicular asphalt or painted highway lane striping across historical monument precincts, ancient archaeological parks, or pedestrian plazas (e.g. Piazza del Colosseo, Via Triumphalis). Urban ground surfaces must strictly adhere to real-world municipal and historical zoning: pedestrian aprons must remain continuous Roman cobblestones (*sanpietrini*), travertine flagstones, or gravel concourses. Only verified vehicular streets on municipal cadastral plans may feature asphalt carriageways.
14. **Conformal Surface Draping & Ground-Truth Primacy Invariant (Zero Floating Slabs & Zero Facade Slicing)**:
    - *The Ground-Truth Primacy Principle*: Raw 3D photogrammetric tiles already capture the authentic real-world geometry and topography of roads, curbs, intersections, and pedestrian plazas. Never attempt to superimpose arbitrary synthetic vector spline ribbons or floating polygonal slabs with hardcoded centerlines across a 3D tile. Even minor millimeter discrepancies in elevation cause synthetic slabs to slice through building foundations, block open portals, and float into empty air like diving boards.
    - *In-Situ Material Enhancement over Geometric Intrusion*: Ground enhancements must either:
      1. Directly upgrade the materials, normal maps, roughness, and solar de-lighting on the existing photogrammetric tile mesh triangles in-situ.
      2. Or, if replacing geometry, perform sub-centimeter conformal DEM raycasting that guarantees 100% surface contact, terminating strictly at building Dirichlet footprint boundaries with zero interpenetration.
15. **Pedestrian Plaza Exclusion & Minimum Botanical Height Floor ($h_{\text{tree}} \ge 4.5\text{m}$, $d_{\text{min}} \ge 8.5\text{m}$)**: Trees cannot sprout from bare pedestrian stone pavement, asphalt carriageways, or tourist concourses. Automated canopy resection must enforce:
    - **Minimum Canopy Height Floor**: $\ge 4.5\text{m}$ above local ground (eliminating tourist clumps, queue stanchions, umbrella carts, bollards, and ticket kiosks that cluster between $1.5\text{m}\text{--}2.2\text{m}$).
    - **Pedestrian Concourses Exclusion Zone**: Monument Dirichlet locks must encompass the entire historical paved apron (minimum $45\text{m}\text{--}55\text{m}$ buffer for monument plazas like the Colosseum).
    - **Poisson-Disk Spatial Repulsion**: Enforce minimum trunk spacing $d_{\text{min}} \ge 8.5\text{m}$ to prevent canopy interpenetration and dense "broccoli" clumping.
16. **Botanical Biome Fidelity Invariant (Mediterranean Conifers vs. Deciduous Oaks)**: Botanical replacement must strictly reflect native eco-regional flora. For central Mediterranean / Roman sites:
    - *Pinus pinea* (Italian Stone Umbrella Pine): Wide, parasol-shaped flat-topped crown with needle alpha clusters and reddish-orange furrowed rhytidome bark.
    - *Cupressus sempervirens* (Mediterranean Cypress): Dense, narrow vertical flame spires with coniferous scale foliage.
    - Broadleaf deciduous oak leaves on Mediterranean conifers are strictly prohibited.
17. **Perimeter Boundary Skirting & Environmental Grounding Invariant**: Never present a reconstructed monument or 3D tile as an isolated, severed polygonal cookie-cutter island suspended in a pitch-black void.
    - *Conformal Perimeter Sampling*: Skirt geometry must sample the exact $(X, Y, Z)$ coordinates of the actual tile perimeter boundary vertices at its top edge, dropping only the bottom vertices down to datum $Y = -25.0\text{m}$ to avoid vertical protrusions or gaps against undulating topography.
    - *Architectural Museum Plinth*: Bound a matte dark slate material (`[0.12, 0.13, 0.14]`) to the extruded perimeter skirt and include a bottom floor plate to create an authentic architectural exhibition model.
18. **The Ground-Truth Primacy De-Lighting Invariant (Subtractive Neutralization over Additive Amplification)**:
    - *Google 3D Tiles are Calibrated Photographs*: Real aerial photogrammetry already possesses authentic sunlight and diffuse skylight balance. Applying blanket global HSV saturation multipliers ($S \times 1.55$) onto aerial photogrammetry is catastrophic: it amplifies cold blue skylight reflections in cavea/shadow recesses into blinding electric blue, and corrupts warm weathered travertine into radioactive pink/magenta blotches.
    - *Subtractive Shadow Desaturation & Skylight Neutralization*:
      - Sunlit stone ($V \ge 0.48$) must remain **100% untouched** to preserve ground-truth color accuracy.
      - Deep shadow pixels ($V < 0.48$) contaminated by ambient blue skylight ($H \in [170^\circ, 260^\circ]$) must be neutralized: desaturate by $0.35\times$ ($S \leftarrow S \times 0.35$) and gently steer hue toward warm neutral limestone ($H \leftarrow 38.0^\circ$).
      - Apply gentle non-linear shadow lifting ($+0.16 \times \text{shadowFrac}$) without altering unoccluded stone.
19. **Oblique Photogrammetry Cluster Morphology & Botanical Aspect Ratio Calibration**:
    - *Aerial Angle Broadening*: Aerial cameras capture trees obliquely, causing vertical columnar species (like *Cupressus sempervirens* / Italian cypress) to fuse with understory shrubs and ground terrain in the polygon mesh. Consequently, a slender $10\text{m}$ cypress extracts with a cluster diameter of $6\text{m}\text{--}7\text{m}$, yielding an apparent cluster aspect ratio of only $1.2\text{--}1.4$.
    - *Calibrated Aspect Ratio Floor*: Setting a textbook aspect ratio floor ($aspect \ge 1.5$) erroneously misclassifies $90\%+$ of authentic Italian cypresses as broad umbrella stone pines (*Pinus pinea*). The photogrammetric classifier must lower the cypress aspect floor to $1.15$ with diameter allowance up to $7.0\text{m}$ when height $\ge 6.0\text{m}$, ensuring authentic Mediterranean flora representation.
20. **Prohibition on Synthetic CAD Road Polygons & Geometry Slicing**:
    - *Zero Flat Vector Slabs over 3D Terrain*: Never superimpose flat 2D vector polygons or CAD road/walkway ribbons on top of undulating 3D photogrammetric terrain. Even minor millimeter discrepancies cause flat planes to act as giant clipping knives slicing through building foundations, chopping off the lower ground tier of monument arcades, and creating harsh black polygons cutting across the scene.
    - *In-Situ Upgrades Only*: The real 3D road network and pedestrian plazas already exist with correct topographical grades in the photogrammetric tile. Upgrade their materials in-situ with PBR maps (Scharr normals, roughness, ambient occlusion) rather than injecting colliding geometry.
21. **Photogrammetric Low-Noise Floor & Turf Inpainting**:
    - Surface clutter (parked mopeds, queue stanchions, trash receptacles, small low shrubs) clusters between $1.0\text{m}\text{--}2.5\text{m}$. Setting a tree detection floor $\ge 4.8\text{m}$ prevents these objects from spawning miniature tree models.
    - Vertices depressed during canopy resection must have their squashed canopy textures inpainted with clean regional park turf / gravel textures, preventing residual spotty brown lumps from marring the ground.
22. **Oriented Bounding Box (OBB) Excision vs. Coarse Axis-Aligned Bounding Box (AABB)**:
    - *The Danger of Loose AABBs*: When excising webbed curtain walls or melted geometry for isolated monuments adjacent to complex terrain or other buildings (such as the Arch of Constantine next to the Palatine Hill terrace and Roman Forum walls), NEVER use a loose axis-aligned bounding box (AABB). An AABB that encloses an angled structure will slice off thousands of triangles belonging to neighboring historic buildings and hillside terraces, creating massive holes into the black void.
    - *Exact OBB Formulations*: Formulate the exact Oriented Bounding Box with centroid $(c_x, c_z)$, principal orientation angle $\theta$, local half-extents $(h_u, h_v)$, and an elevation floor $y_{\text{min}}$. Any triangle is excised IF AND ONLY IF its centroid $(u, v)$ in the monument's local frame satisfies $|u| \le h_u \land |v| \le h_v \land y \ge y_{\text{min}}$.
23. **Authentic Street View Travertine Remaking & CIELAB Normalization (Prohibition on Scalar Multipliers)**:
    - *The Prohibition on Heuristic Red/Blue Boosts*: Never apply ad-hoc scalar multipliers (such as `R * 1.14` or `B * 0.84`) in an attempt to warm up shadows. These uncalibrated scalars corrupt white balance, generating unnatural salmon, pink, and magenta artifacts across sunlit stone and shadow penumbras.
    - *Street View Ground-Truth Anchoring*: Texture synthesis must anchor strictly to measured CIELAB ground-truth statistics from authentic Street View photographic references (e.g., Roman Travertine: $L^* = 85.16 \pm 0.49$, $a^* = -0.39 \pm 0.07$, $b^* = 15.35 \pm 0.03$).
    - *De-Lighting & Ambient Shadow Neutralization*: Shadow cavities inside arches, vaults, and subterranean hypogeums ($L^* < 42.0$) must be smoothly lifted ($L^* \ge 22.0$) and neutralized to authentic warm limestone shadow ($a^* \in [1.0, 1.2], b^* \in [3.5, 3.8]$). This completely purges ambient blue skylight without injecting magenta.
    - *Lithic Micro-Pore & Cavitation Synthesis via RNM*: Sample authentic Street View cavitation pores and chisel striations from 4K PBR maps, combining micro-normals with macro architectural Scharr gradients via Reoriented Normal Mapping (RNM): $\mathbf{n}_{\text{rnm}} = \operatorname{normalize}(\mathbf{n}_{\text{arch}} + \mathbf{n}_{\text{sv}} - (0, 0, 1))$.
    - *Segmentation Protection*: Natural foliage ($h \in [68^\circ, 170^\circ]$, excess green $> 0.04$) and dark basalt roadways ($C < 7.5, L^* \in [14, 54]$) must be preserved with their distinct biophysical roughness and color profiles.
24. **Watertight Terrain Continuity & Prohibition on Destructive Ground Curtain Culling**:
    - *The Ground Watertightness Invariant*: `pruneCurtainWalls` must NEVER cull continuous ground terrain, retaining walls, or park hillside slopes. Global or non-geofenced thresholding on vertical span ($\Delta y > 5.5\text{m}$) punches gaping black holes into sloped roads (such as Via Celio Vibenna) and park terraces.
    - *Strictly Geofenced Elevation Excision*: Curtain wall excision is strictly permitted ONLY on detached vertical spans with $|n_y| < 0.12$ and bottom elevation $> 2.5\text{m}$ above bare-earth DTM within verified geofenced monuments (e.g. beneath the Arch of Constantine vaults).
    - *Continuous DTM Vertex Depression over Triangle Deletion*: Residual tree canopy vertices must be flattened flush to bare-earth DTM via continuous $C^1$ Hermite vertex clamping (`gy`) rather than deleting triangles or leaving degenerate gaps, guaranteeing 100% watertight terrain topology.
25. **Species-Specific Foliage PBR Calibration (SB-Veggie Multi-Species Library)**:
    - Trees cannot share a single uniform green material. Mediterranean biomes consist of diverse species with distinct chromatic and reflectance profiles:
      - *Cupressus sempervirens* (Italian Cypress): Dark conical spire foliage (`baseColorFactor: [0.18, 0.28, 0.16]`, `roughnessFactor: 0.85`).
      - *Pinus pinea* (Stone Umbrella Pine): Warm parasol canopy (`baseColorFactor: [0.22, 0.32, 0.18]`, `roughnessFactor: 0.82`).
      - *Quercus ilex* (Holm Oak): Deep rounded broadleaf crown (`baseColorFactor: [0.20, 0.30, 0.15]`, `roughnessFactor: 0.80`).
26. **Tight Monument Dirichlet Bounds & Complete Tree Recovery**:
    - Dirichlet monument protection envelopes must be strictly dimensioned to the authentic architectural edifice footprint (e.g. Colosseum semi-major $98\text{m}$, semi-minor $82\text{m}$ with tight $\le 2.0\text{m}$ margin).
    - Oversized bounding envelopes ($> 130\text{m}$) mistakenly lock out and suppress hundreds of legitimate trees along adjacent hillsides, park slopes, and roadside avenues (e.g. Parco del Colle Oppio and Via Nicola Salvi).
    - Automated canopy detection must maintain a sensitive height threshold ($h \ge 2.2\text{m}$) and spacing ($4.5\text{m}$) to recover all specimen trees, spires, and shrub masses across urban parks.
27. **Unified Multi-Tile Color Harmonization via Built-in Recolor Services**:
    - Built-in color harmonization services (`GlbTextureRecolorService.ts` / `GLB_RECOLOR_PRESETS.realistic_travertine`) ensure that background tiles seamlessly match hero monument textures, eliminating tile seam discontinuities and white-balance jumps.
28. **Low-Frequency Spatial Ratio Filtering ($Y / Y_{\text{smooth}}$) for 100% Shadow Purging & Complete Street View Remaking**:
    - *The Shadow Penumbra Trap*: Ad-hoc scalar shadow lifting ($V \leftarrow V + k \cdot \text{shadow}$) or color shifting leaves visible shadow penumbras and fails to remake the stone texture. Dark stone inside hypogeums, barrel vaults, and subterranean chambers remains muddy because the low-frequency illumination was baked into the photograph.
    - *Separable 2D Box Filter Decomposition*: Extract low-frequency spatial illumination $Y_{\text{smooth}}(x, y)$ using a fast separable box filter (radius $R = 16$).
    - *High-Frequency Structural Detail Ratio*:
      $$D(x, y) = \operatorname{clamp}\left(\frac{Y(x, y)}{\max(0.04f, Y_{\text{smooth}}(x, y))}, \; 0.72, \; 1.28\right)$$
    - *Direct Street View Remaking*: Replace the base albedo with 100% authentic Street View Roman Travertine ($svL \approx 70.3, svA \approx 6.0, svB \approx 28.6$) modulated by $D(x, y)$:
      $$\mathbf{a}_{\text{out}}(x, y) = \text{Travertine}_{\text{StreetView}} \cdot D(x, y)$$
    - *Invariant Proof*: In shadow regions, $Y(x, y) \approx Y_{\text{smooth}}(x, y) \implies D(x, y) \approx 1.0$, which yields pure sunlit Roman Travertine albedo, 100% purging baked cast shadows. In regions with mortar joints, stone carving relief, and cracks, $Y < Y_{\text{smooth}} \implies D < 1.0$, which sharpens and engraves the authentic architectural relief directly into the new travertine stone.
29. **Empirical Principal Axis Verification for Radial & Elliptical Monuments**:
    - *The Swapped-Axis Disaster*: Never assume standard $(X = \text{major}, Z = \text{minor})$ coordinate alignments. In the Roman Colosseum (and many elliptical amphitheaters), the major axis runs North-South ($Z$-axis in ENU, $Z \in [-132, 67]$, half-diameter $\ge 104\text{m}$), while the minor axis runs East-West ($X \in [-77, 102]$, half-diameter $\approx 92\text{m}$).
    - Swapping axes ($Z = 82\text{m}, X = 98\text{m}$) leaves the entire northern and southern 50-meter monument walls outside the Dirichlet protection envelope. The canopy resection algorithm misclassifies the $30\text{m}\text{--}50\text{m}$ monumental masonry as organic tree canopies, depresses the facade into the ground (causing gaping structural holes), and plants cypress trees directly on the Colosseum roof!
    - *Pre-Flight Verification Invariant*: Before canopy resection executes, compute the oriented bounding envelope from the elevated vertices and assert that $100\%$ of structural building vertices satisfy containment (`outsideCount === 0`) with a conservative buffer margin ($\delta \ge 8.0\text{m}$).
30. **Multi-Tier Perimeter Sawtooth Clipping vs. Boundary Spikes**:
    - *Boundary Sawtooth Curtains*: Raw photogrammetric tiles terminate in ragged, triangular sawtooth edges where multi-view camera rays ran out of overlap, leaving vertical edge curtains dropping 50+ meters into the void.
    - *Concentric Perimeter Excision*: Excising triangles whose vertices lie beyond the verified contextual radius ($R_{\text{max}} = 175.0\text{m}$ from the scene centroid) completely eliminates over 100,000 distorted perimeter edge spikes, producing a pristine circular architectural presentation model while preserving all authentic contextual monuments (Arch of Constantine, Via Celio Vibenna, Parco del Celio).





