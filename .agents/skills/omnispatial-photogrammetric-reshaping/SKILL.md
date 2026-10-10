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

### Step 3: Texture Frequency Analysis & Micro-Relief Detection
* Execute 2D spatial FFT or multi-scale Scharr operator on horizontal roof and facade planes.
* Extract dominant corrugation frequency $\Lambda$ and orientation angle $\theta$.
* Discard specular highlights and baked ambient occlusion prior to geometric extraction.

### Step 4: Native C++20 Geometric Reshaping
* Compile ephemeral C++20 pipeline via `NativeCppCompilerService` (`-std=c++20 -O3`).
* Apply **Operator 1** to corrugated roofs and spandrels.
* Apply **Operator 2** to replace canopy blobs with grounded trunk carriers and quadric crowns.
* Apply **Operator 3** to carve hollow archway vaults while locking jagged ruin edges.
* Calculate transferred envelope normals for soft foliage canopies and sharp facet normals for masonry.

### Step 5: Solar De-Lighting & PBR Material Baking
* Compute solar vector $\mathbf{L}_\odot$ via NOAA ephemeris.
* Lift self-shadows into unoccluded albedo $\mathbf{a}(u, v)$.
* Synthesize physical PBR texture sets:
  * **Albedo**: De-lighted base color.
  * **Normal**: Scharr 5x5 multi-scale + Toksvig anti-aliasing.
  * **Roughness**: Derived from stone porosity / micro-relief ($\approx 0.85$ for weathered travertine/limestone; $\approx 0.45$ for glazed terracotta).
  * **Metallic**: $0.0$ for mineral stone/tiles; $0.85$ for bronze window grilles/chevrons.

### Step 6: Binary glTF 2.0 Streaming & Multi-Mode Verification
* Serialize watertight geometry, vertex attributes, and PBR material samplers into standard `.glb`.
* Mount to the interactive web demo (`public/omnispatial_synthesis_demo.html`).
* Verify across all 4 viewport modes:
  1. **Dual Split**: Side-by-side comparison of Raw Scan vs. Stage 3 PBR.
  2. **Wipe Slider**: 50/50 interactive wipe at identical camera orbit angles.
  3. **Macro Detail Loupe**: 2.5x cursor magnification inspecting stone grain and tile ridges.
  4. **3D Free Orbit**: Real-time orbital navigation powered by `<model-viewer>`.

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
  };
  materialBake: {
    delightedAlbedoCoveragePct: number;
    toksvigMipLevels: number;
    roughnessBaseline: number;
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
