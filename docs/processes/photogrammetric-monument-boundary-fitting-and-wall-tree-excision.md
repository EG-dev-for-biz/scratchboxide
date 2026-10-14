# Process: Photogrammetric Monument Boundary Fitting, Zero-Drift Dirichlet Locking, and Wall-Tree Excision

## Problem Statement

When processing photogrammetric 3D tiles (such as Google Photorealistic 3D Tiles) to resect flattened vegetation and instantiate realistic 3D botanical trees, automated canopy detection engines analyze elevated geometry outside protected zones. If the bounding boundary for a historic monument or architectural edifice is specified using idealized theoretical dimensions (e.g. textbook architectural plans or rectangular cadastral lot boundaries), subtle spatial offsets, yaw misalignments, or asymmetric structural extensions (such as preserved outer Roman arcade walls, buttresses, or stairs) will fall outside the protected zone.

The canopy resection algorithm encounters these elevated, weathered masonry surfaces ($10\text{–}20\text{ m}$ height above ground with multi-angle normal dispersion), misclassifies the rough stone blocks as organic tree canopy, depresses the architectural facade to ground elevation, and instances 3D botanical trees directly on the monument walls.

This process establishes an analytical, closed-loop methodology to derive exact monument Dirichlet boundary envelopes directly from photogrammetric mesh vertices, guarantee $100\%$ structural locking ($0.000\text{ mm}$ drift), eliminate wall-tree misclassification, and automatically verify the cleaned facade using targeted headless Chrome DevTools Protocol (CDP) cameras.

---

## Prerequisites

1. **Photogrammetric Input**: Standard binary glTF 2.0 (`.glb`) containing raw, un-decimated aerial 3D tiles (e.g., `colosseum_rome_pristine_leaf_raw.glb`).
2. **Core Spatial Harmonizer**: `@scratchbox/core` module exporting `PhotogrammetricTerrainHarmonizerService`.
3. **C++20 Processing Pipeline**: Clang 15+ or Apple Clang supporting C++20 for SIMD PBR texture and normal map synthesis (`scripts/pbr_texture_batch`).
4. **Automated Verification Harness**: Headless Chrome with Chrome DevTools Protocol (`ws` WebSocket connection) and `<model-viewer>` WebGL runtime.

---

## Step-by-Step Procedure

### Step 1: Statistical Mesh Vertex Inspection & Centroid/Extent Analysis

Never assume textbook cadastral dimensions match the geodetic local ENU coordinates of photogrammetric tile meshes. Extract the authentic structural distribution from the raw vertex buffer:

```javascript
// scripts/inspect_monument_bounds.cjs
const fs = require('fs');

function inspectMonumentVertices(glbPath, minElevation = 8.5) {
  const buf = fs.readFileSync(glbPath);
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binBuf = buf.subarray(28 + jsonLen);

  const buildingVerts = [];
  for (const mesh of gltf.meshes) {
    for (const prim of mesh.primitives) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      const posBv = gltf.bufferViews[posAcc.bufferView];
      const count = posAcc.count;
      const byteOffset = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);

      for (let i = 0; i < count; i++) {
        const x = binBuf.readFloatLE(byteOffset + i * 12);
        const y = binBuf.readFloatLE(byteOffset + i * 12 + 4); // Elevation
        const z = binBuf.readFloatLE(byteOffset + i * 12 + 8);

        // Filter for monument core elevation (excluding flat ground)
        if (y > minElevation && Math.hypot(x, z) < 130.0) {
          buildingVerts.push({ x, y, z });
        }
      }
    }
  }

  // Calculate actual centroid and principal bounding extents
  let sumX = 0, sumZ = 0;
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const v of buildingVerts) {
    sumX += v.x; sumZ += v.z;
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.z < minZ) minZ = v.z;
    if (v.z > maxZ) maxZ = v.z;
  }

  const cx = sumX / buildingVerts.length;
  const cz = sumZ / buildingVerts.length;
  const halfMajor = Math.max(Math.abs(maxX - cx), Math.abs(minX - cx));
  const halfMinor = Math.max(Math.abs(maxZ - cz), Math.abs(minZ - cz));

  console.log(`Analyzed ${buildingVerts.length} structure vertices.`);
  console.log(`Authentic Centroid: [${cx.toFixed(2)}, ${cz.toFixed(2)}]`);
  console.log(`Bounding Extents: X [${minX.toFixed(2)}, ${maxX.toFixed(2)}], Z [${minZ.toFixed(2)}, ${maxZ.toFixed(2)}]`);
  console.log(`Fitted Semi-Axes: Major=${halfMajor.toFixed(1)}m, Minor=${halfMinor.toFixed(1)}m`);

  return { cx, cz, halfMajor, halfMinor, buildingVerts };
}
```

### Step 2: Formulate and Mathematically Verify Dirichlet Boundary Coverage

Define the Dirichlet boundary polygon with an analytical safety buffer ($\delta = 1.5\text{–}2.5\text{ m}$) ensuring all structural vertices satisfy the containment condition:

$$\left( \frac{(x - c_x)\cos\theta + (z - c_z)\sin\theta}{a + \delta} \right)^2 + \left( \frac{-(x - c_x)\sin\theta + (z - c_z)\cos\theta}{b + \delta} \right)^2 \le 1.0$$

Verify zero vertices leak outside the boundary before invoking mesh resection:

```javascript
// Mathematical containment check
let outsideCount = 0;
for (const v of buildingVerts) {
  const dx = v.x - cx;
  const dz = v.z - cz;
  const rotX = dx * Math.cos(yaw) + dz * Math.sin(yaw);
  const rotZ = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const normDist = Math.hypot(rotX / (semiMajor + buffer), rotZ / (semiMinor + buffer));
  if (normDist > 1.0) outsideCount++;
}

if (outsideCount > 0) {
  throw new Error(`Dirichlet boundary violation: ${outsideCount} structure vertices remain unprotected!`);
}
console.log(`✅ Mathematical Invariant Satisfied: 0 structure vertices outside Dirichlet boundary.`);
```

### Step 3: Dual-Phase Terrain Harmonization & Botanical Instancing

Invoke `PhotogrammetricTerrainHarmonizerService.harmonizeGlb()` with strict Dirichlet locking and curtain-wall pruning:

```javascript
const result = await PhotogrammetricTerrainHarmonizerService.harmonizeGlb(baseBuf, {
    autoResectStands: true,
    renderMode: 'pbr',
    datumCutoffElevation: -15.0,
    monumentPolygons: [
        {
            id: 'monument_flavian_amphitheatre',
            name: 'Flavian Amphitheatre (Colosseum)',
            localPolygonEnu: colosseumPoly,
            bufferMeters: 2.5
        }
    ],
    resectGridCellSizeMeters: 3.0,
    minTreeHeightMeters: 1.8,
    maxTreeHeightMeters: 34.0,
    fadeRadiusMultiplier: 1.45,
    pruneCurtainWalls: true,
    curtainWallSpanThresholdMeters: 3.5,
    enableDenseCanopyFill: true,
    denseCanopySpacingMeters: 6.5,
    maxPerimeterRadiusMeters: 185.0,
    perimeterCenter: [cx, cz]
});
```

### Step 4: Native PBR Batch Material Compilation & Toksvig Anti-Aliasing

Process the harmonized base model through `scripts/pbr_texture_batch` (C++20 Apple ImageIO / SIMD kernel) to synthesize tangent-space Scharr normal maps and cavity ORM maps while preserving authentic travertine albedo:

```bash
clang++ -std=c++20 -O3 \
    -framework CoreGraphics -framework ImageIO -framework CoreFoundation \
    scripts/pbr_texture_batch.cpp -o scripts/pbr_texture_batch

node scripts/apply_master_pbr_pipeline.cjs
```

### Step 5: Automated Headless Chrome DevTools Protocol (CDP) Verification

To prevent regressions, execute automated headless visual audits using targeted camera frames specifically aimed at the vulnerable monument wall facades:

```javascript
// scripts/verify_app_demo_population.cjs
await sendCdp('Runtime.evaluate', {
  expression: `(() => {
    const mv = document.getElementById('mainModelViewer');
    if (mv) {
      // Focus directly on southern wall facade
      mv.setAttribute('camera-orbit', '35deg 55deg 320m');
      mv.setAttribute('camera-target', '20m 14m 35m');
      mv.setAttribute('field-of-view', '32deg');
    }
  })()`
});
await sleep(2500);
await takeScreenshot('colosseum_southern_wall_clean_closeup.png', 'Southern Wall Verified Clean');
```

---

## Verification & Invariants

| Invariant | Mathematical / Physical Constraint | Verification Command / Check |
| :--- | :--- | :--- |
| **Zero Structure Leakage** | Structural building vertices outside Dirichlet polygon $= 0$ | Checked prior to resection (`outsideCount === 0`) |
| **Zero Monument Drift** | Maximum displacement of locked monument vertices $= 0.000\text{ mm}$ | `result.lockedMonumentVertices >= 264,000` |
| **Zero Wall Trees** | Number of botanical tree stands instanced on monument walls $= 0$ | Probed tree node coordinates against monument envelope |
| **Curtain Wall Excision** | Vertical photogrammetric skirts under arches and bridges excised | `excisedCurtainTriangles > 0` |
| **PBR Albedo Fidelity** | Stone textures retain authentic de-lighted travertine reflectance | Scharr normals + Toksvig ORM applied to all 252 base tiles |

---

## Pitfalls & Rollback

- **Pitfall: Cadastral vs. Mesh Offset**: Architectural drawings represent the building footprint at ground level ($Y = 0$). Historical monuments with leaning walls, upper-tier corbels, or reconstructed exterior arches often flare outward by $5\text{–}12\text{ m}$ at elevation ($Y = 20\text{–}45\text{ m}$). Always filter and inspect vertices across the full vertical column ($Y \in [8, 48]\text{ m}$).
- **Pitfall: Over-Expansion of Dirichlet Polygon**: If the Dirichlet boundary is set too large ($\text{buffer} > 15\text{ m}$), legitimate park trees situated right along the street or piazza sidewalk will be locked and will not be resected. Keep the safety buffer tight ($\delta = 1.5\text{–}2.5\text{ m}$) once the true vertex distribution is fitted.
- **Rollback**: If tree stands are erroneously placed or a facade is distorted, immediately restore the pristine base tile scan (`public/models/colosseum_rome_pristine_leaf_raw.glb`), re-run the vertex inspection script with higher elevation gating, and re-generate the base GLB.

---

## Automation & Tool Integration

To permanently integrate this process into the Scratchbox IDE toolchain:

1. **Automated Envelope Fitting in `PhotogrammetricTerrainHarmonizerService`**:
   - Add a pre-pass method `PhotogrammetricTerrainHarmonizerService.fitOrientedBoundingEnvelope(mesh, { elevationFloor, localCenterHint })` that automatically clusters building vertices and fits an optimal 2D oriented convex hull / Dirichlet ellipse before canopy resection begins.
2. **Automated Wall Tree Linter**:
   - Add a post-generation validation step in CI (`scripts/lint_zero_wall_trees.cjs`) that queries all instanced node translations against the building's 3D Oriented Bounding Box (OBB) and throws an error if any tree origin falls within the vertical volume of a building.
