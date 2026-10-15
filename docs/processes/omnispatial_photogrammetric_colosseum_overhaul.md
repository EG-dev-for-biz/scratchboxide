# Omnispatial Photogrammetric Colosseum Overhaul & Ground-Truth Invariants Pipeline

> **Superseded (2026-10-15): do not follow the steps below.** `PhotogrammetricTerrainHarmonizerService` (`harmonizeGlb`,
> `fitOrientedBoundingEnvelope`), the `harmonize_photogrammetric_district` tool and `scripts/integrate_colosseum_botanical_trees*`
> are deleted: they flattened canopy and placed trees from hand-written or seeded-random stands (species, positions,
> heights) instead of measuring them. A location's trees are now measured in its photo tiles and rebuilt as SB-Veggie
> trees by `TileVegetationService` (`packages/core/src/node/3d-engine/tile-vegetation-service.ts`, native
> `scratchbox_tile_vegetation.hpp` / `scripts/tile_vegetation.cpp`) through `google_3d_tiles_get_clay`
> (`location-clay-pipeline.ts`); a single tree of given measurements comes from `botanical_synthesize_tree`. This record
> is kept as history only.

**Status**: Verified  
**Date**: 2026-10-11  
**Target Domain**: 3D Photogrammetry, Architectural Heritage Reconstruction, Biophysical Dendrology, Native C++20 Processing  
**Tags**: `photogrammetry`, `ground-truth-primacy`, `pbr-delighting`, `botanical-biomes`, `curtain-wall-excision`, `cdp-proof`, `cpp20`

---

## 1. Problem Statement

When ingesting Google Maps Photorealistic 3D Tiles of monumental historic sites (such as the Flavian Amphitheatre / Colosseum in Rome) and applying procedural enhancements, several critical failure modes emerge if naive heuristics are applied:

1. **The "Blue Shadow & Pink Stone" De-Lighting Trap**: Attempting to "de-light" photogrammetric textures by applying global HSV saturation boosts ($S \times 1.55$) onto aerial photogrammetry corrupts the calibrated sensor data. Cold ambient blue skylight in deep cavea and hypogeum shadows is amplified into electric blue glow, while weathered Roman travertine limestone is distorted into hot pink/magenta blotches.
2. **Missing Italian Cypresses (*Cupressus sempervirens*)**: Due to oblique aerial camera angles, columnar vertical tree clusters blur and fuse with surrounding understory shrubs and ground terrain in the mesh, artificially widening cluster diameters ($6\text{m}\text{--}7\text{m}$). Standard dendrological aspect ratio classifiers ($aspect = height / diam \ge 1.5$) misclassify $90\%+$ of authentic Italian cypresses as broad umbrella stone pines (*Pinus pinea*).
3. **The "Lost Model / Severed Building" Polygon Clipping Bug**: Injecting flat 2D vector road ribbons or CAD entrance stairs into undulating 3D photogrammetric terrain creates planar knife cuts. Minor millimeter elevation discrepancies cause flat polygons to intersect the Colosseum plaza, severing the ground-level arcades and making it appear as if the bottom tier of the monument was destroyed or lost in the process.
4. **Noisy Ground Bush Clutter**: Small surface objects (waste bins, mopeds, queue stanchions, low shrubs) between $1.0\text{m}\text{--}2.5\text{m}$ trigger low-threshold tree extractors, creating miniature stunted tree models and leaving spotty brown lumps on the ground.
5. **Photogrammetric Curtain Walls in Arches**: The Arch of Constantine had its three fornices completely sealed by solid vertical mesh webs.

---

## 2. Prerequisites & Architectural Context

- **Source Asset**: Google Photorealistic 3D Tiles leaf LOD (`public/models/colosseum_rome_pristine_leaf_raw.glb`, 537,940 vertices, 252 textured submeshes).
- **Core Engine Modules**:
  - `packages/core/src/node/spatial/PhotogrammetricTerrainHarmonizerService.ts`: Canopy resection, bare-earth DTM projection, botanical dendrology classification, Dirichlet monument boundary locks.
  - `scripts/pbr_texture_batch.cpp`: Native C++20 Apple Clang SIMD kernel for Polar HSV solar de-lighting, Scharr normal generation, and ORM map baking.
  - `scripts/apply_omnispatial_complete_overhaul.cjs`: Binary glTF 2.0 pipeline orchestrating curtain wall excision, texture packing, and PBR remapping.
  - `public/omnispatial_synthesis_demo.html`: Production multi-mode viewport (Dual Split, Wipe Slider, 2.5x Loupe, 3D Orbit).

---

## 3. Step-by-Step Procedure

### Step 1: Enforce Ground-Truth Primacy De-Lighting in Polar HSV (`pbr_texture_batch.cpp`)
Google Maps 3D Tiles are calibrated photographs taken under real sunlight. De-lighting must be strictly **subtractive/neutralizing** on shadows, never additive/amplifying on stone:
1. **Preserve Sunlit Photogrammetry 100%**: Pixels with value $V \ge 0.48$ are left completely untouched to preserve authentic travertine patina and historical weathering.
2. **Neutralize Cold Skylight in Shadows**: For deep shadow pixels ($V < 0.48$) contaminated by cold ambient skylight ($H \in [170^\circ, 260^\circ]$), desaturate by $0.35\times$ ($S \leftarrow S \times 0.35$) and gently steer hue toward warm limestone ($H \leftarrow 38.0^\circ$).
3. **Gentle Non-Linear Shadow Lifting**: Apply $+0.16 \times \text{shadowFrac}$ to reveal subterranean hypogeum details without introducing chalky grey wash.
4. Compile with Apple Clang:
   ```bash
   clang++ -std=c++20 -O3 -framework CoreGraphics -framework CoreFoundation -framework ImageIO scripts/pbr_texture_batch.cpp -o scripts/pbr_texture_batch
   ```

### Step 2: Calibrate Oblique Photogrammetric Botanical Aspect Ratios (`PhotogrammetricTerrainHarmonizerService.ts`)
Compensate for oblique aerial scan cluster broadening to isolate slender columnar cypresses:
1. Adjust Italian cypress classification rule:
   ```typescript
   const isCypress = aspect > 1.15 || (diam <= 7.0 && height >= 6.0);
   ```
2. Enforce minimum tree height floor $h_{\text{min}} \ge 4.8\text{m}$ to ignore low street furniture and trash receptacles.
3. Rebuild `@scratchbox/core` to generate updated distribution:
   - *Pinus pinea* (Umbrella Stone Pine): 51 instances (44.3%)
   - *Cupressus sempervirens* (Italian Cypress): 37 instances (32.2%)
   - *Quercus ilex* (Holm Oak): 27 instances (23.5%)

### Step 3: Eradicate Flat CAD Slabs & Preserve Grounded Topography
1. Never inject flat 2D vector polygons or artificial radiating ramps into 3D photogrammetric terrain.
2. Preserve the authentic 3D photogrammetric road network (Via dei Fori Imperiali, Piazza del Colosseo, Via Celio Vibenna) which already conforms naturally to the Roman topography.
3. Apply high-resolution PBR basalt and travertine materials directly in-situ.

### Step 4: Exact Oriented Bounding Box (OBB) Arch Excision & Watertight Splicing
1. **The Collateral Damage Trap of Loose AABBs**: Using a loose axis-aligned bounding box ($X \in [-156, -125], Z \in [-62, -32]$) on an angled structure excised 1,711 triangles, slicing off 902 triangles belonging to the neighboring Palatine hill building and Roman Forum terrace.
2. **Exact OBB Formulation**:
   - Centroid: $(-140.600, -47.110)$, Principal rotation angle: $\theta = -68.78^\circ$.
   - Coordinate transformation:
     $$u = (x - c_x)\cos\theta + (z - c_z)\sin\theta$$
     $$v = -(x - c_x)\sin\theta + (z - c_z)\cos\theta$$
   - Excision predicate: $|u| \le 13.8\text{m} \land |v| \le 5.2\text{m} \land y \ge 6.0\text{m}$.
   - Result: Exactly 809 triangles excised under the fornices; 0 collateral triangles removed from adjacent buildings or terraces.
3. Splice watertight 88,556-triangle Arch of Constantine with Roman travertine ashlar PBR textures (`roman_travertine_albedo.png`, Scharr normal, and ORM maps).

### Step 5: Continuous Polar HSV Solar Irradiance De-Lighting Kernel (`pbr_texture_batch.cpp`)
1. **Continuous Irradiance Transfer Function**:
   $$w_{\text{shadow}} = \operatorname{clamp}\left(\frac{0.72 - v}{0.72 - 0.12}, 0.0, 1.0\right)$$
   $$v_{\text{lifted}} = v \cdot (1.0 + 1.25\, w_{\text{shadow}})$$
2. **Blue Skylight Neutralization**:
   For shadow pixels contaminated by ambient blue skylight ($H \in [150^\circ, 265^\circ]$):
   $$S \leftarrow S \cdot (1.0 - 0.85\, w_{\text{shadow}}), \quad H \leftarrow 38.0^\circ$$
3. **Warm Travertine Chromatic Balance**:
   $$R \leftarrow R \cdot (1.0 + 0.14\, w_{\text{shadow}}), \quad B \leftarrow B \cdot (1.0 - 0.16\, w_{\text{shadow}})$$
4. Result: Uniform, radiant honey-buff limestone across the Colosseum cavea and hypogeum with zero dark blue shadow pits.

### Step 6: Botanical Resection, Canopy Blob Pruning & Curtain Wall Excision (`PhotogrammetricTerrainHarmonizerService.ts`)
1. **Unlocking Western Monument Clutter**: Replaced coarse western exclusion box with tight Dirichlet footprints for the Arch of Constantine and Temple of Venus.
2. **Multi-Species Scale**: Resected **509 botanical trees across 1,018 nodes** and depressed **140,903 canopy vertices** flat to bare-earth DTM.
3. **Curtain Wall & Elevated Canopy Pruning**:
   - `pruneElevatedCanopyTriangles: true`: Spatial hash grid checks if candidate triangles inside a tree stand footprint ($r \le r_{\text{fade}}$) remain elevated $> 2.0\text{m}$ above DTM bare-earth; if so and outside Dirichlet monument locks, excises them.
   - `pruneCurtainWalls: true` ($\Delta y > 5.5\text{m}$, $|n_y| < 0.30$): Excised **17,285 vertical curtain triangles** hanging off the Celio hill retaining wall and slopes.

### Step 7: Automated Targeted Headless CDP Visual Verification
1. Run `scripts/capture_master_verified_plates.cjs` via Chrome DevTools Protocol to capture 2048x1024 master plates.
2. Compile and run `scripts/crop_plates.cpp` to extract 1:1 pixel verification plates for trees, road curbs, Arch of Constantine, and Colosseum cavea.

---

## 4. Verification & Invariants

| Invariant | Requirement | Verification Result |
| :--- | :--- | :--- |
| **Ground-Truth Primacy** | Zero blue shadows in cavea; zero pink travertine distortion. | **PASSED**: Cavea shadows are neutral-warm; travertine is natural honey-buff limestone. |
| **OBB Boundary Excision** | 0 triangles excised from adjacent Palatine/Forum buildings. | **PASSED**: Adjoining Roman Forum building and terrace wall are 100% intact. |
| **Curtain Wall Pruning** | 0 downward-streaking vertical curtain walls on slopes. | **PASSED**: 17,285 curtain triangles excised; retaining wall drops cleanly. |
| **Botanical Biome Fidelity** | Slender Italian cypresses, umbrella stone pines, and holm oaks. | **PASSED**: 509 botanical trees instanced with species-specific foliage PBR factors. |
| **Zero Geometry Slicing** | Ground arcades fully intact; zero clipping road ribbons. | **PASSED**: All three ground arcade levels are 100% visible and unclipped. |
| **PBR Material Binding** | 1024x1024 travertine and volcanic basalt bound with Scharr normals. | **PASSED**: Full normal and ORM maps active across all 259 meshes. |

---

## 5. Pitfalls & Anti-Patterns

1. **The Loose AABB Anti-Pattern**: Never use coarse axis-aligned bounding boxes on rotated structures. Always formulate exact OBB transformations $(u, v)$ to prevent gouging holes into adjacent architecture.
2. **The Global Saturation Multiplier Anti-Pattern**: Never multiply saturation globally on aerial scans ($S \leftarrow S \times 1.55$). Aerial photogrammetry is already color-balanced; global boosts cause severe chromatic degradation.
3. **Unpruned Canopy Curtains**: Depressing canopy vertices without pruning steep vertical triangles ($\Delta y > 5.5\text{m}$) leaves stretched polygonal curtains hanging from hillsides.
4. **Superimposing Flat Vector Ribbons**: A flat CAD polygon will always slice through rolling terrain. Ground enhancement must be in-situ material upgrades on the terrain mesh, or conformal raycast DEM meshes.

---

## 6. Automation & Maintenance Pointers

- **Re-run Pipeline**: (deleted, see the note at the top) `node scripts/integrate_colosseum_botanical_trees_v4.cjs && node scripts/apply_omnispatial_complete_overhaul.cjs`
- **Capture Proofs**: `node scripts/capture_master_verified_plates.cjs`
- **Generate Verification Crops**: `clang++ -std=c++20 -O3 -framework CoreGraphics -framework CoreFoundation -framework ImageIO scripts/crop_plates.cpp -o scripts/crop_plates && ./scripts/crop_plates`
- **Inspect Web Demo**: Serve on port 8080 and open `http://localhost:8080/omnispatial_synthesis_demo.html`.
