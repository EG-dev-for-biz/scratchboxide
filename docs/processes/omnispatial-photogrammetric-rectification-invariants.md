# Omnispatial Photogrammetric Rectification & Ground-Truth Invariants Pipeline

> **Superseded (2026-10-15): do not follow the steps below.** `PhotogrammetricTerrainHarmonizerService` (`harmonizeGlb`,
> `fitOrientedBoundingEnvelope`), the `harmonize_photogrammetric_district` tool and `scripts/integrate_colosseum_botanical_trees*`
> are deleted: they flattened canopy and placed trees from hand-written or seeded-random stands (species, positions,
> heights) instead of measuring them. A location's trees are now measured in its photo tiles and rebuilt as SB-Veggie
> trees by `TileVegetationService` (`packages/core/src/node/3d-engine/tile-vegetation-service.ts`, native
> `scratchbox_tile_vegetation.hpp` / `scripts/tile_vegetation.cpp`) through `google_3d_tiles_get_clay`
> (`location-clay-pipeline.ts`); a single tree of given measurements comes from `botanical_synthesize_tree`. This record
> is kept as history only.

## Problem Statement
When restructuring raw aerial photogrammetric 3D tiles (such as Google Photorealistic 3D Tiles) into high-fidelity PBR architectural assets, automated processing frequently introduces severe visual and geometric regressions:
1. **Geometric Intrusion & Facade Slicing**: Attempting to superimpose arbitrary synthetic vector road spline quads with fixed elevations causes the synthetic road to slice directly through historic monuments (e.g. cutting through Colosseum arcades) and protrude off the edge of the tile as floating diving boards.
2. **Pedestrian Hardscape Corruption**: Placing vehicular asphalt and modern highway lane stripes across ancient pedestrian concourses and monument plazas (e.g. Piazza del Colosseo, Via Triumphalis) violates historical and municipal land-use.
3. **Tourist/Umbrella Chaff Misclassification**: Setting tree classification height thresholds too low ($h < 3.5\text{m}$) classifies tourist crowds, queue stanchions, umbrellas, and kiosks as trees, sprouting miniature vegetation across stone pavements and monument aprons.
4. **Botanical Biome Discordance & Broccoli Clumping**: Resecting photogrammetric trees without regional dendrological constraints produces broadleaf deciduous trees with generic spherical foliage in Mediterranean settings, and insufficient spatial repulsion causes canopies to merge into dense solid green masses.
5. **Topological Portal Webbing**: Photogrammetry fills open architectural portals, triumphal arches, and colonnades with solid curtain walls, blocking light and line-of-sight.
6. **Floating Island Void Disconnect**: Displaying cropped 3D tiles in a black void without a continuous boundary skirt produces a severed "cookie-cutter" aesthetic.

## Prerequisites
- Native C++20 toolchain (`clang++ -std=c++20 -O3`) with SIMD math headers (`scratchbox_engine.hpp`, `scratchbox_veggie.hpp`, `scratchbox_archie.hpp`).
- Node.js runtime with binary glTF 2.0 parsing capabilities (`fs`, buffer manipulation).
- High-resolution real-world reference textures (e.g. authentic Roman travertine and volcanic basalt *sanpietrini*).
- Headless Chrome DevTools Protocol (CDP) capture pipeline for automated 4K multi-angle verification.

---

## Step-by-Step Procedure

### 1. Enforce the Ground-Truth Primacy Invariant (Zero Geometric Intrusion)
- **Principle**: The raw 3D photogrammetric tile already captures the authentic ground truth of road curves, intersections, pedestrian concourses, and terrain topography.
- **Implementation**:
  - Never generate arbitrary floating vector road polygons or synthetic spline quads with hardcoded elevations.
  - Enhance road and ground surfaces directly in-situ by upgrading the materials, normal maps, roughness, and solar de-lighting on the existing tile mesh triangles.
  - If geometric road replacement is required, perform sub-centimeter conformal DEM raycasting that guarantees 100% surface contact, terminating strictly at building Dirichlet footprint boundaries with zero interpenetration.

### 2. Pedestrian Concourse & Monument Apron Protection
- **Classification**: Distinguish between vehicular streets (`Via Celio Vibenna`) and pedestrian monument concourses (`Piazza del Colosseo`, Arch of Constantine apron).
- **Hardscape Materials**: Pedestrian aprons must remain continuous Roman cobblestones (*sanpietrini*), travertine flagstones, or gravel concourses. Never inject vehicular asphalt or painted lane stripes into pedestrian monument precincts.
- **Apron Exclusion Zones**: Establish Dirichlet containment envelopes covering the entire paved monument apron (e.g. an ellipse of $138\text{m} \times 136\text{m}$ centered on the Colosseum and a polygon around the Arch of Constantine concourse). Within these exclusion zones, tree placement is strictly clamped to zero (`treeCount === 0`).

### 3. Botanical Biome Fidelity & Poisson-Disk Spacing
- **Minimum Tree Height Floor**: Elevate `minTreeHeightMeters` to $\ge 4.8\text{m}$ above local ground level. This filters out tourists, queue umbrellas, ticket booths, and bollards.
- **Regional Dendrology**: Instantiate authentic native species for the target eco-region:
  - Central Mediterranean / Rome: *Pinus pinea* (parasol stone pines with flat-topped crowns and furrowed orange-brown bark) and *Cupressus sempervirens* (columnar cypresses with slender vertical flame spires).
  - Prohibit generic deciduous broadleaf oaks in Mediterranean settings.
- **Spatial Repulsion**: Enforce minimum trunk spacing ($d_{\text{trunk}} \ge 9.5\text{m}$) and canopy spacing ($d_{\text{canopy}} \ge 13.0\text{m}$) using Poisson-disk sampling to prevent canopy interpenetration and solid "broccoli" clumping.
- **DTM Bare-Earth Flattening**: Depress underlying canopy vertices flat to bare-earth DTM to excise photogrammetric foliage geometry before instancing clean botanical 3D trees.

### 4. Geofenced Topological Curtain Wall Excision
- **Excision Scope**: Identify open architectural arches and portals (e.g. Arch of Constantine barrel vaults).
- **Geofenced Bounding Box**: Define strict 3D bounding volumes enclosing only the webbed portal geometry (e.g. $X \in [-156.0, -125.0], Z \in [-62.0, -32.0], Y \ge 5.2\text{m}$).
- **Index Buffer Surgery**: Cull indices of triangles whose centroid falls within the bounding volume. Prohibit global vertical thresholding ($\Delta Y > 3.5\text{m}$), which punches holes through building facades and hillsides.
- **Watertight Splicing**: Splice in procedural or scanned watertight classical architecture with open, unobstructed barrel vaults.

### 5. Polar HSV Solar De-Lighting & In-Situ Travertine Calibration
- **Polar HSV Space**: Lift cast shadows in polar HSV or CIELAB space rather than scalar RGB:
  $$\Delta S \propto (1.0 - V_{\text{shadow}})$$
  This maintains rich amber and limonite saturation in stone shadows, preventing chalky grey bleaching.
- **Travertine Patina Calibration**: Warm the building base color toward authentic Roman travertine ($H \approx 38^\circ\text{–}42^\circ$, $S \approx 0.28\text{–}0.34$, $V \approx 0.75\text{–}0.85$).
- **Micro-Texture Normal Synthesis**: Combine multi-scale 5x5 Scharr edge detection with synthetic limestone cavitation noise to produce tactile, light-responsive PBR normal and ORM (Occlusion-Roughness-Metallic) maps.

### 6. Conformal Perimeter Skirting (Architectural Exhibition Plinth)
- **Top Edge Sampling**: Sample the exact $(X, Y, Z)$ positions of the actual perimeter boundary vertices of the 3D tile mesh.
- **Vertical Extrusion**: Drop the bottom edge vertices vertically down to a uniform datum floor level ($Y = -25.0\text{m}$ to $-28.0\text{m}$).
- **Material Binding**: Assign a matte, dark architectural slate PBR material (`color: [0.12, 0.13, 0.14]`, `roughness: 0.95`) and cap the bottom with a floor plate. This transforms a floating, jagged photogrammetric cutout into an elegant architectural exhibition model.

---

## Verification & Invariants

| Invariant | Mathematical / Physical Constraint | Verification Method |
| :--- | :--- | :--- |
| **Ground-Truth Primacy** | 0.000 mm drift between road surfaces and photogrammetry terrain; zero facade slicing | Telephoto CDP inspection along building foundation lines |
| **Pedestrian Zoning** | Zero asphalt/highway lane markings within historical pedestrian plazas | Top-down orthographic visual inspection of plaza polygons |
| **Zero-Wall-Tree Invariant** | Outside monument Dirichlet lock: $100\%$ structural building vertices preserved; inside lock: 0 trees | Automated vertex containment assertions (`outsideCount === 0`) |
| **Botanical Height Floor** | $h_{\text{tree}} \ge 4.8\text{m}$; zero foliage instanced on ground features $< 4.8\text{m}$ | Elevation histogram assertions on detected canopy clusters |
| **Poisson-Disk Spacing** | $\|p_i - p_j\|_2 \ge 9.5\text{m}$ for all trunk coordinates $(p_i, p_j)$ | Pairwise Euclidean distance assertion over all tree nodes |
| **Curtain Wall Excision** | 0 webbed triangles remaining within portal bounding volume; facades outside volume preserved | Raycast / transparency pass through arch barrel vaults |
| **Conformal Skirt** | Skirt top edge $Y_{\text{top}} = Y_{\text{mesh\_boundary}}(X, Z)$; bottom edge $Y_{\text{bottom}} = -25.0\text{m}$ | Visual inspection of perimeter edge seal without vertical gaps |

---

## Pitfalls & Rollback

- **Pitfall 1: Arbitrary Spline Elevations**: Manually keyframing road elevations ($Y = 11.2\text{m}, 12.5\text{m}$) creates visible gaps or subterranean intersections. **Rollback**: Disable synthetic road ribbons and retain in-situ photogrammetric road geometry with PBR texture enhancements.
- **Pitfall 2: PNG Loaded as JPEG**: Passing a `.png` buffer to `addImageBuffer(buf, 'image/jpeg')` causes Three.js and WebGL texture decoders to fail silently, rendering the mesh pitch black. **Fix**: Explicitly sniff image magic numbers (`89 50 4E 47` for PNG vs. `FF D8 FF` for JPEG) and assign the matching MIME type.
- **Pitfall 3: Global Curtain Wall Thresholding**: Slicing all vertical triangles with $\Delta Y > 3.5\text{m}$ punches catastrophic holes through building facades, retaining walls, and hillsides. **Fix**: Strictly restrict triangle excision to localized monument bounding boxes.
- **Pitfall 4: Model-Viewer Camera Stagnation**: Programmatically setting `setAttribute('camera-orbit', ...)` on `<model-viewer>` without invoking `jumpCameraToGoal()` causes CDP screenshots to capture stale default camera frames. **Fix**: Always set properties directly (`mv.cameraOrbit = ...; mv.cameraTarget = ...; mv.jumpCameraToGoal();`).

---

## Automation Pointers

- Execution scripts:
  - (deleted, see the note at the top) `node scripts/integrate_colosseum_botanical_trees_v4.cjs` (botanical DTM flattening and conifer instancing).
  - `node scripts/apply_omnispatial_complete_overhaul.cjs` (curtain wall excision, polar HSV solar de-lighting, PBR map generation).
  - `node scripts/capture_master_verified_plates.cjs` (headless Chrome CDP automated multi-angle verification).
- Target Master Asset: `public/models/colosseum_stage3_master_pbr.glb`
- Interactive Demo: `public/omnispatial_synthesis_demo.html`
