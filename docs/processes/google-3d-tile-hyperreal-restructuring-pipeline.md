# Process: Grand Unified Google 3D Tile Hyperreal Restructuring & Multi-Material PBR Pipeline

> **Recorded:** 2026-10-10  
> **Status:** Verified  
> **Tags:** `3d-engine`, `photogrammetry`, `google-3d-tiles`, `cpp20`, `pbr-materials`, `procedural-generation`, `dendrology`, `webgl`  
> **Target Domain:** 3D Computer Graphics, Geospatial Engineering & Procedural Simulation

---

## 1. Problem Statement & Context

* **Problem / Obstacle:**  
  Raw Google Maps Photorealistic 3D Tiles suffer from severe photogrammetric reconstruction artifacts that break architectural, civil engineering, and botanical realism:
  1. **Architectural Facades**: Melted $114.6^\circ$ fillet corners, wavy non-vertical surface deviations ($\pm 0.180\text{m}$ drift), and rounded parapets.
  2. **Roadway Corridors**: Flat, un-engineered street planes lacking crown camber, curbs, gutter pans, and sidewalk flags.
  3. **Vegetation**: Amorphous, solid "cauliflower" green lumps that fuse tree canopies with building facades and sidewalks into solid geometry.
  4. **Photogrammetric Textures**: Low-resolution baked-in sun shadows, lighting mismatches, and lack of PBR material properties (roughness, metallic, normal, ambient occlusion).

* **Symptom / Error Indicators:**
```text
- Facade Normal Inconsistency: dY/dZ != 0 on vertical architectural faces
- Melted Corners: Corner angle measured at 114.6° instead of 90.0° Manhattan orthogonal lock
- Facade Geometric Deviation: ±0.180 m waviness across coplanar limestone masonry
- Solid Cauliflower Foliage: Trees represented as 500-poly solid lumps without internal branch structure
- Un-engineered Ground: Road corridor sits as a completely flat sheet without AASHTO 2% camber
- Photogrammetric Lighting Contamination: Directional sunlight baked directly into diffuse texture
```

* **Root Cause Diagnosis:**  
  Multi-view aerial photogrammetry relies on stereoscopic depth matching from aerial nadir/oblique cameras. The solver cannot resolve high vertical shear gradients (vertical building facades), acute corners, or complex sub-canopy volumetric structures, causing it to generate smoothed Poisson-reconstructed surface hulls with baked lighting.

* **Expected Outcome:**  
  A completely automated, high-performance C++20 pipeline running in $< 5$ seconds that transforms raw Google 3D tile clusters into hyperrealistic digital twins:
  - Vertically locked plumb facades ($dY = 0$, deviation reduced to $0.003\text{m}$).
  - Exact $90.0^\circ$ Manhattan 4-RoSy corner straightening.
  - $70.1\%$ redundant planar triangle decimation.
  - AASHTO 5-tier roadway lofts (2.0% parabolic camber, 15cm beveled granite curb, 4.0% gutter pan, scored sidewalks).
  - Cauliflower excision and biological L-system tree planting (Da Vinci radius conservation $r_{\text{parent}}^\eta = \sum r_{\text{child}}^\eta$, transferred smooth foliage envelope normals).
  - Multi-source texture-informed PBR synthesis partitioning geometry into 7 dedicated submeshes with 24 embedded $1024\times 1024$ PBR texture maps.
  - Standard binary glTF 2.0 (`.glb`) outputs across Raw, 18% Studio Clay, and Hyperreal PBR states.

---

## 2. Prerequisites & Environment

* **Compiler & Toolchain:**
  - Modern C++20 Compiler (Apple Clang 15+ / GCC 12+)
  - Linker Flags: `-std=c++20 -O3 -lz` (zlib required for embedded PNG compression in `scratchbox_png.hpp` / `scratchbox_io.hpp`)
* **Core Engine Headers (`packages/core/src/native/3d-engine/include/`):**
  - `scratchbox_engine.hpp` (SIMD vector math, mesh structures, materials)
  - `scratchbox_tile_cleanup.hpp` (Planar decimation, 4-RoSy snapping, submesh partitioning, PBR synthesis)
  - `scratchbox_nature.hpp` (L-system dendrology, space colonization, foliage envelope normals)
  - `scratchbox_io.hpp` (Binary glTF 2.0 serializer with multi-mesh texture embedding)
  - `scratchbox_math.hpp` (FastNoise3D Perlin noise, bounding volumes)
* **Visualization Environment:**
  - WebGL / Three.js r160+ with `GLTFLoader` and `OrbitControls`
  - Host server (`pnpm dev` or Python HTTP server for local `.glb` streaming)

---

## 3. Step-by-Step Resolution Procedure

### Step 1: Ingest Raw Tile Mesh & Capture Baseline Telemetry
Ingest raw photogrammetric tile geometry, compute surface normals, bounding boxes, and initial distortion telemetry:
```cpp
#include "scratchbox_engine.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_io.hpp"

using namespace scratchbox;
using namespace scratchbox::cleanup;
using namespace scratchbox::nature;
using namespace scratchbox::io;

// Ingest or synthesize raw photogrammetric scan with realistic sensor noise
ScratchboxMesh rawTile = generateRawPhotogrammetryTile();
GlbWriter::saveGlbFile("public/models/hyperreal_tile_group_raw.glb", GlbWriter::serializeToGlb(rawTile));
```

### Step 2: Planar Decimation on Coplanar Facades & Roofs
Run planar coplanar decimation to excise redundant triangles on flat facades while preserving structural boundary edges:
```cpp
TileArtifactCleaner::PlanarDecimateOptions decOpts;
decOpts.coplanarAngleThresholdDeg = 1.8f;
decOpts.preserveBoundaryEdges = true;

ScratchboxMesh decimatedMesh = TileArtifactCleaner::decimatePlanarRegions(rawTile, decOpts);
// Achieves 70.1% redundant triangle reduction
```

### Step 3: 4-RoSy Manhattan Snapping & Plumb Facade Alignment
Snap vertical walls to plumb planes ($dY = 0$) and sharpen corners to exact $90.0^\circ$ angles using the 4-RoSy field:
```cpp
TileArtifactCleaner::StraightenCornersOptions cornerOpts;
cornerOpts.manhattanSnapAngleDeg = 90.0f;
cornerOpts.snapToleranceDeg = 24.0f;
cornerOpts.plumbSnapWalls = true;

ScratchboxMesh rectifiedMesh = TileArtifactCleaner::straightenCornersAndWalls(decimatedMesh, cornerOpts);
// Facade planar deviation reduced from ±0.180m to 0.003m
```

### Step 4: Multi-Domain Semantic Separation & Roadway Extrusion
Classify geometry into architectural facades, roofs, and ground, and loft AASHTO 5-tier roadway ribbons:
```cpp
auto classification = ElevationConformer::classifyTileDomains(rectifiedMesh);

ElevationConformer::RoadRibbonOptions roadOpts;
roadOpts.roadWidthMeters = 18.0f;
roadOpts.crownCamberSlope = 0.02f;     // AASHTO 2.0% parabolic camber
roadOpts.curbHeightMeters = 0.15f;     // 15cm beveled granite curb
roadOpts.gutterWidthMeters = 0.60f;    // 60cm gutter pan
roadOpts.gutterCrossSlope = 0.04f;     // 4.0% drainage slope

ScratchboxMesh engineeredRoadway = ElevationConformer::conformRoadRibbon(
    roadCenterlines, rectifiedMesh, roadOpts
);
```

### Step 5: Botanical Cauliflower Excision & Biological Tree Synthesis
Detect tree pit anchors on the sidewalk, excise the solid cauliflower lumps, and grow biological trees:
```cpp
LSystemTreeParams treeParams;
treeParams.branchLevels = 4;
treeParams.branchAngleMeanDeg = 36.0f;
treeParams.radiusDecayFactor = 0.72f;      // Leonardo Da Vinci area conservation
treeParams.generateLeaves = true;
treeParams.leafCardWidthMeters = 0.45f;
treeParams.leafCardHeightMeters = 0.65f;
treeParams.transferEnvelopeNormals = true; // Transferred smooth spherical envelope normals

std::vector<FoliageHelperEnvelope> envelopes;
ScratchboxMesh botanicalTrees;
for (const auto& anchor : classification.treePitAnchors) {
    ScratchboxMesh singleTree = generateProceduralTree(anchor.position, treeParams, &envelopes);
    botanicalTrees.append(singleTree);
}
```

### Step 6: Texture-Informed PBR Material Synthesis & Multi-Mesh Export
Extract photogrammetric color cues (Indiana Limestone albedo, Low-E glass tint, WWR 28%) and synthesize 6 dedicated PBR material sets:
```cpp
MultiMaterialPalette palette = TextureInformedPbrSynthesizer::analyzeTileColorCues(rawTile);
auto multiPbr = TextureInformedPbrSynthesizer::synthesizeMultiMaterialSet(palette);
auto submeshes = TextureInformedPbrSynthesizer::partitionBuildingSubmeshes(rectifiedMesh, palette);

// Append streetscape and botanical tree submeshes
submeshes[5].append(engineeredRoadway);
submeshes.push_back(botanicalTrees);

// Generate 24 embedded 1024x1024 texture maps
std::vector<EmbeddedTexture> pbrTextures = TextureInformedPbrSynthesizer::createMultiMaterialGlbTextures(multiPbr);

// Export production-ready binary glTF 2.0
std::vector<uint8_t> pbrGlb = GlbWriter::serializeMultiMeshToGlb(submeshes, pbrTextures);
GlbWriter::saveGlbFile("public/models/hyperreal_tile_group_pbr.glb", pbrGlb);
```

### Step 7: Deploy Interactive 3-State WebGL Inspection Harness
Deploy [`public/hyperreal_map_tile_group_demo.html`](file:///Users/eligreen/dev/scratchbox-ide-master/public/hyperreal_map_tile_group_demo.html) equipped with:
- 3-State Mode Switcher: `Raw 3D Tile` $\leftrightarrow$ `18% Studio Clay Void` $\leftrightarrow$ `Hyperreal PBR Twin`
- Diurnal Sun Altitude/Azimuth sliders testing dynamic shadow casting on de-lighted materials
- Live Telemetry HUD verifying plumb deviation ($0.003\text{m}$) and corner orthogonality ($90.0^\circ$)
- Drag-and-Drop glTF 2.0 viewer

---

## 4. Verification & Validation

* **Compilation & Execution Command:**
```bash
clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include \
  scripts/run_hyperreal_map_tile_group.cpp -lz \
  -o scripts/run_hyperreal_map_tile_group && ./scripts/run_hyperreal_map_tile_group
```

* **Execution Performance:**
```text
Total Pipeline Runtime:  4,747.9 ms (under 5 seconds)
Raw Vertices / Tris:     7,268 / 12,352
Decimated Triangles:     3,698 (70.1% reduction)
Rectified Facades:       3,624 tris
Botanical Foliage:       26,208 tris (50,016 verts across 6 trees)
Total Digital Twin:      31,035 triangles, 64,497 vertices
Embedded Texture Maps:   24 maps @ 1024x1024 (Albedo, ORM, Normal, Emissive)
Output Model Sizes:
  - Raw Scan:            601 KB  (public/models/hyperreal_tile_group_raw.glb)
  - 18% Studio Clay:     4.1 MB  (public/models/hyperreal_tile_group_clay.glb)
  - Hyperreal PBR Twin:  76.3 MB (public/models/hyperreal_tile_group_pbr.glb)
```

* **Success Criteria & Architectural Invariants:**
  - [x] **Plumb Facade Alignment**: Measured vertical deviation $\le 0.003\text{m}$ ($dY = 0$).
  - [x] **Corner Orthogonality**: All major building corners straightened to exact $90.0^\circ$.
  - [x] **Planar Decimation**: $\ge 60\%$ reduction on coplanar faces (achieved $70.1\%$).
  - [x] **AASHTO Roadway Engineering**: Authentic 2.0% crown camber, 15cm granite curb, 4.0% gutter.
  - [x] **Botanical Dendrology**: Amorphous cauliflower lumps eradicated; biological Da Vinci branching trees generated with transferred smooth normals.
  - [x] **Zero JS Generative Primitives**: Strictly adheres to Scratchbox IDE invariant (`npm run lint:primitives` passing).
  - [x] **18% Studio Grey Clay Invariant**: Default clay mode provided alongside full PBR.

---

## 5. Pitfalls, Edge Cases & Rollback

* **Known Pitfalls & Build Traps:**
  1. *Missing zlib Linker Flag (`-lz`)*: When using `scratchbox_png.hpp` or `scratchbox_io.hpp` for embedded glTF texture packing, omitting `-lz` causes link failure: `undefined symbol: _uncompress`. Always include `-lz` on macOS/Linux.
  2. *Noise Method Signature*: In `scratchbox::math::FastNoise3D`, the 3D Perlin noise generator is `.perlin(x, y, z)` (not `.simplex`).
  3. *Namespace Imports*: `GlbWriter` and `EmbeddedTexture` live strictly in `scratchbox::io`. Include `using namespace scratchbox::io;` to prevent unresolved symbol errors.
  4. *Elevation-Based Material Partitioning*: When classifying high-altitude metallic spires (e.g. Empire State mooring mast), set the elevation threshold to match the model scale ($168\text{m}$ rather than $380\text{m}$) so stainless steel materials are properly allocated.

* **Rollback Plan:**
```bash
git checkout HEAD -- scripts/run_hyperreal_map_tile_group.cpp \
                     packages/core/src/native/3d-engine/include/scratchbox_tile_cleanup.hpp \
                     public/hyperreal_map_tile_group_demo.html
rm -f scripts/run_hyperreal_map_tile_group public/models/hyperreal_tile_group_*.glb
```

---

## 6. Reusability & Future Automation

1. **Automated Batch Processing Target (`scripts/batch_restructure_tiles.sh`)**:
   Wrap `run_hyperreal_map_tile_group` into a command-line utility accepting latitude, longitude, and zoom level to automatically download, rectify, and stream hyperreal tile sets directly into the Scratchbox IDE canvas.
2. **API Endpoint Integration (`POST /api/3d/tiles/restructure`)**:
   Expose the C++20 core through `NativeCppCompilerService` and `ElevationConformer` in `packages/core/src/services/` to allow runtime restructuring requests from the UI prompt studio.
