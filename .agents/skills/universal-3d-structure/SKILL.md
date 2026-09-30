---
name: universal-3d-structure
description: >-
  Maintain and project 3D spatial scenes, assets, and photogrammetry using the Universal 3D Structure Foundation
  (Universal3DStructureFoundation). Enforces a single canonical geometric anchor across solid meshes, surface point
  constellations, calibrated camera rigs, collision envelopes, and geodetic coordinates, with deterministic adapters
  for GLB, COLMAP, Nerfstudio (3DGS), AI Video Blockouts (<VIDEO_REF_0>), Collision Hulls, and GeoJSON.
---

# Universal 3D Structure Foundation Skill

The **Universal 3D Structure Skill** guides Scratchbox IDE agents to manage, transform, and export 3D spatial data through a unified, single-source-of-truth geometric anchor (`Universal3DStructureFoundation` from `@scratchbox/core`).

---

## 1. When to Activate This Skill

Activate this skill whenever a user or workflow asks to:
1. **Export or convert 3D data across formats**: Moving between `.glb`, `COLMAP`, `Nerfstudio (transforms.json)`, `GeoJSON`, or physics collision bounds.
2. **Train or initialize 3D Gaussian Splatting (3DGS) or NeRF**: Generating camera matrices (`transforms.json`) and seed point clouds (`sparse_pcd.ply`).
3. **Generate camera trajectories for AI video diffusion**: Conditioning Google Omni 1.1, Veo, or Sora using spatial blockout trajectories (`<VIDEO_REF_0>`).
4. **Anchor 3D models to real-world geography**: Tying procedural or photogrammetric models to WGS-84 GPS coordinates (`lat`, `lng`, `elevation`).
5. **Set up obstacle collision or navigation**: Generating low-poly bounding volumes for physics simulation or drone flight safety.

---

## 2. Core Architecture & Mental Model

```
                    [ The Universal Master Blueprint ]
                     (Universal3DStructureFoundation)
                     
   1. Metric Surface Mesh       ──► [Hardware Rasterization / Three.js / Unreal]
   2. Surface Point Cloud       ──► [Neural Splatting / 3DGS Seed]
   3. Calibrated 6-DoF Cameras  ──► [Photogrammetry / View Synthesis / Raymarching]
   4. Collision Envelope        ──► [Physics / Obstacle Avoidance / NavMesh]
   5. WGS-84 GPS Anchor         ──► [Google Maps / GIS / Real-World Alignment]
```

### The Cardinal Rule: Project Outward, Never Daisy-Chain
- **NEVER** convert neural representations into solid meshes directly (e.g. running Poisson reconstruction on 3DGS splats to guess a mesh).
- **NEVER** reverse-engineer camera flight paths from flat 2D AI videos.
- **ALWAYS** anchor the ground truth in `Universal3DStructureFoundation`, and project outward deterministically via the built-in adapters.

---

## 3. Standard Code Workflow

### 1. Ingest or Synthesize the Master Structure
```typescript
import { Universal3DStructureFoundation } from '@scratchbox/core';

// From procedural primitives:
const structure = Universal3DStructureFoundation.createFromProcedural('box', {
  name: 'Palazzo_Massing',
  scale: 10.0,
  center: [0, 10.0, 0],
  numViews: 24,
  pointDensity: 3000,
  anchor: {
    lat: 41.8902,
    lng: 12.4922,
    elevationMeters: 50.0
  }
});
```

### 2. Export Outward to Downstream Formats
```typescript
// A. Standard binary glTF 2.0 (.glb) for WebGL Viewports
const glbBuffer = structure.toGlbBuffer();

// B. COLMAP text files for photogrammetry
const { camerasText, imagesText, points3DText } = structure.toColmap();

// C. Nerfstudio dataset for 3D Gaussian Splatting (3DGS)
const { transformsJson, sparsePcdPly } = structure.toNerfstudio();

// D. Video diffusion camera blockout for Google Omni / Veo (<VIDEO_REF_0>)
const blockout = structure.toVideoCameraBlockout(24);

// E. Collision Hull for physics and collision detection
const hull = structure.toCollisionHull();

// F. RFC 7946 GeoJSON for Google Maps Platform
const geoJson = structure.toGeoJson();
```

### 3. Concurrent Multi-Format Disk Export
```typescript
// Concurrently export everything to a clean folder tree
await structure.exportToDisk('./output/scene_bundle', [
  'glb',
  'colmap',
  'nerfstudio',
  'video_blockout',
  'geojson'
]);
```

---

## 4. Format Verification Checklist

Before presenting any 3D asset to the user or downstream stage:
- [ ] **GLB Integrity**: Check that the file begins with the 12-byte header `0x46546C67` ("glTF"), version 2.
- [ ] **Coordinate Conventions**: 
  - Nerfstudio `transforms.json` must adhere to OpenGL (+Y Up, -Z Forward).
  - COLMAP must adhere to OpenCV (+Y Down, +Z Forward).
  - Verify that columns 1 and 2 of rotation matrices are inverted between the two.
- [ ] **Video Blockout**: Verify that `videoRef` is strictly `<VIDEO_REF_0>` and durations match `frameCount / fps`.
- [ ] **GPS Footprint**: Verify that GeoJSON coordinates are `[longitude, latitude, elevation]` per RFC 7946.
