---
name: image-location-resection
description: >-
  Resect exact 6-DOF camera optical center, 3-axis attitude (heading, pitch, roll), standoff distance,
  horizontal/vertical FOV, and closed-loop edge alignment against a given 3D model from any photograph or video into real-world
  geodetic coordinates and Google Photorealistic 3D Tiles using analytical solvePnP, 2D-to-3D visual feature matching,
  and pure Node.js headless closed-loop rasterization.
---

# Image Location Resection & 6-DOF Camera Pose Estimation

The **Image Location Resection Skill** enables AI agents to determine the exact physical 3D location of the photographer's camera optical center $(\text{lat}_{\text{cam}}, \text{lng}_{\text{cam}}, \text{alt}_{\text{cam}})$, 3-axis viewing attitude, focal length, standoff distance, and viewing frustum cone from any input photograph or video frame against real-world 3D models and Google Photorealistic 3D Tiles.

---

## 1. System Architecture

```
[Query Photograph / Video Frame]                [Google 3D Tiles Mesh (.glb)]
               │                                              │
               ▼                                              ▼
[Visual Feature Extractor]                       [Direct Binary .glb Ingestion]
 (Harris / FAST Corner Detectors)                 (Vertices, Normals, Triangles)
               │                                              │
               ▼                                              │
[128-D Gradient Descriptors]                                  │
 (Normalized Cross-Correlation)                               │
               │                                              │
               ▼                                              │
[Bidirectional Lowe's Ratio Matcher]                          │
 (d1 / d2 < 0.75 + Cross-Check)                               │
               │                                              │
               ▼                                              │
[2D-to-3D Depth / Surface Ray-Lifting] ◄──────────────────────┘
 (Metric ENU Coordinate Mapping)
               │
               ▼
[Analytical solvePnP (DLT + SVD + Levenberg-Marquardt)]
 (Direct Linear Transform + Orthogonal Procrustes UV^T)
               │
               ▼
[4-Point Minimal Sample Consensus (solvePnPRansac)]
 (100% Outlier Rejection Filter, < 0.05 px RMS)
               │
               ▼
[Pure Node.js Headless Silhouette Rasterizer]
 (Triangle & Wireframe Projection, < 5ms / frame, Zero GPU)
               │
               ▼
[Closed-Loop Sub-Pixel Edge Alignment Optimizer]
 (Coordinate Descent Re-render Loop; reports the edge correlation it reached)
               │
               ▼
[WGS-84 Geodetic Resection & Google 3D Tiles Configuration]
 (C_lat, C_lng, C_alt, Heading, Pitch, Roll, Standoff, FOV)
```

---

## 2. Core Mathematical Principles

### Direct Linear Transform (DLT) & SVD Matrix Resection
Each 2D-to-3D correspondence $(\mathbf{X}_i, \mathbf{x}_i)$ where $\mathbf{X}_i = [X_i, Y_i, Z_i, 1]^T$ and $\mathbf{x}_i = [u_i, v_i, 1]^T$ produces two linear equations:
$$\begin{aligned}
\mathbf{X}_i^T \mathbf{p}_1 - u_i \mathbf{X}_i^T \mathbf{p}_3 &= 0 \\
\mathbf{X}_i^T \mathbf{p}_2 - v_i \mathbf{X}_i^T \mathbf{p}_3 &= 0
\end{aligned}$$
Formulating the linear system $\mathbf{A}_{2n \times 12} \mathbf{p} = 0$, Singular Value Decomposition $\mathbf{A} = \mathbf{U}\mathbf{\Sigma}\mathbf{V}^T$ recovers the camera projection matrix $\mathbf{P} = \mathbf{K}[\mathbf{R} \mid \mathbf{t}]$ from the right singular vector corresponding to the smallest singular value.

### Orthonormal Rotation via Orthogonal Procrustes
To enforce strict rotation group $SO(3)$ geometry without shear or projective warping:
$$\mathbf{M} = \mathbf{K}^{-1} \mathbf{P}_{1:3, 1:3} \implies \mathbf{M} = \mathbf{U}_r \mathbf{S} \mathbf{V}_r^T \implies \mathbf{R} = \mathbf{U}_r \mathbf{V}_r^T$$
If $\det(\mathbf{R}) < 0$, the last column of $\mathbf{U}_r$ is inverted: $\mathbf{U}_r[:, 2] \leftarrow -\mathbf{U}_r[:, 2]$ guaranteeing $\det(\mathbf{R}) = +1$.

### Damped Levenberg-Marquardt Non-Linear Least Squares
Refines the 6-DOF pose vector $\mathbf{p} = [r_x, r_y, r_z, t_x, t_y, t_z]^T$ by minimizing the sum of squared reprojection residuals:
$$E(\mathbf{p}) = \sum_{i=1}^{N} \|\mathbf{x}_i - \pi(\mathbf{K}(\mathbf{R}(\mathbf{r})\mathbf{X}_i + \mathbf{t}))\|^2$$
Solving $[\mathbf{J}^T\mathbf{J} + \lambda \operatorname{diag}(\mathbf{J}^T\mathbf{J})]\Delta \mathbf{p} = -\mathbf{J}^T \mathbf{r}$ until gradient norm $\|\mathbf{g}\| < 10^{-6}$.

### Minimal 4-Point RANSAC Consensus Filter
Randomly samples 4 minimal correspondences, computes closed-form candidate poses via DLT, tests all remaining points against reprojection threshold $\tau \le 3.0\text{ px}$, and refits the best consensus set via Levenberg-Marquardt, achieving 100% outlier rejection across noisy real-world scenes.

### Closed-Loop Offscreen Edge Alignment Optimization
SubPixelEdgeAlignmentOptimizer couples directly to `HeadlessMeshSilhouetteRenderer`:
At each perturbation step in 6-DOF parameter space $(\Delta x, \Delta y, \Delta z, \Delta \text{yaw}, \Delta \text{pitch}, \Delta \text{roll}, \Delta \text{fov})$, the software rasterizer dynamically computes the candidate wireframe Sobel edge field $\mathbf{S}_{\text{render}}$ and evaluates Normalized Cross-Correlation (NCC) against the photograph edge field $\mathbf{S}_{\text{target}}$:
$$\operatorname{Score} = \frac{\sum_{(x,y)} \mathbf{S}_{\text{target}}(x,y) \cdot \mathbf{S}_{\text{render}}(x,y)}{\sqrt{\sum \mathbf{S}_{\text{target}}^2 \cdot \sum \mathbf{S}_{\text{render}}^2}}$$
The search stops when the correlation reaches its target, when no step improves it, or at its iteration or time limit, and reports the correlation it reached and why it stopped. A poor match stays poor: no overlap or residual is certified that was not measured.

---

## 3. Codebase APIs

Importable directly from `@scratchbox/core` or `@scratchbox/core/node`:

```typescript
import {
    SpatialPoseEstimatorService,
    VisualFeatureMatcherService,
    HeadlessMeshSilhouetteRenderer,
    SubPixelEdgeAlignmentOptimizer,
    computeSobelField,
    GeoBoxPrecisionResectionService,
    resectImageLocation
} from '@scratchbox/core';

// 1. Ingest authentic Google 3D Tile mesh from GLB
const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb('public/models/google_tiles_textured_area.glb');

// 2. Extract 2D features and match against reference
const queryKeypoints = VisualFeatureMatcherService.extractKeypoints(queryRaster, width, height);
const refKeypoints = VisualFeatureMatcherService.extractKeypoints(renderRaster, width, height);
const matches = VisualFeatureMatcherService.matchKeypoints(queryKeypoints, refKeypoints, {
    loweRatio: 0.75,
    crossCheck: true
});

// 3. Solve 6-DOF Camera Pose via solvePnPRansac
const intrinsics = { fx: 1200, fy: 1200, cx: 960, cy: 540, width: 1920, height: 1080 };
const result = SpatialPoseEstimatorService.solvePnPRansac(points3D, points2D, intrinsics, {
    inlierThresholdPx: 3.0,
    maxRansacIterations: 100
});

console.log(result.pose.cameraCenterWorld); // [x, y, z] metric ENU
console.log(result.pose.attitude);          // { headingDeg, pitchDeg, rollDeg }
console.log(result.pose.meanReprojectionErrorPx); // < 0.05 px

// 4. Closed-loop edge alignment against the photograph (not against a render of a known pose)
const photoField = computeSobelField(160, 120, photoGray160x120);
const aligned = await SubPixelEdgeAlignmentOptimizer.optimizePoseAsync(
    initialPose,
    photoField,
    (pose) => HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, pose, 160, 120),
    { targetOverlapScore: 95, subpixelTolerancePx: Infinity, timeBudgetMs: 60_000, signal }
);
console.log(aligned.overlapScorePercent, aligned.stoppedBy); // the correlation reached, and why it stopped

// 5. Camera resection from stated pose evidence (the photo's pixels are not analysed here)
const resection = await resectImageLocation({
    imagePath: 'public/test_images/my_photo.jpg',
    targetLandmarkName: 'Flatiron Building, New York', // resolved with Google Places
    headingDeg: 210, pitchDeg: 8, standoffDistanceMeters: 180,
    sensorFocalMm: 26.0
});
console.log(resection.poseSource, resection.imageAnalysed); // which evidence was used; always false
```

---

## 4. In-App Agent Tools (Gemini Function Calling)

### 1. `spatial_solve_pnp`
Analytically solves 6-DOF camera pose, position, 3-axis attitude, FOV, and reprojection error from $\ge 4$ 2D-to-3D point correspondences using DLT, SVD, and Levenberg-Marquardt with optional RANSAC outlier rejection:
```json
{
  "name": "spatial_solve_pnp",
  "parameters": {
    "points2D": [{ "x": 960, "y": 540 }],
    "points3D": [{ "x": 0, "y": 10, "z": 0 }],
    "imageWidth": 1920,
    "imageHeight": 1080,
    "focalLengthPx": 1200,
    "useRansac": true,
    "ransacReprojThresholdPx": 3.0
  }
}
```

### 2. `spatial_match_features_2d_3d`
Extracts salient 2D Harris/FAST corners with 128-D descriptors, runs bidirectional Lowe's ratio test matching, and unprojects into metric 3D surface coordinates:
```json
{
  "name": "spatial_match_features_2d_3d",
  "parameters": {
    "queryImagePath": "public/test_images/storefront.jpg",
    "renderImagePath": "public/renders/google_tiles_render.png",
    "maxKeypoints": 300,
    "loweRatio": 0.75,
    "crossCheck": true
  }
}
```

### 3. `spatial_closed_loop_edge_align` (or `geobox_closed_loop_edge_align`, `geobox_optimize_edge_alignment`)
Refines a camera pose so a given model lines up with a given photograph: the model is rendered at each trial pose with
`HeadlessMeshSilhouetteRenderer` and its silhouette/depth edges are correlated with the photo's edges. The photograph,
the model and the starting pose are all required (no proxy box, no default pose). It reports the edge correlation
before and after, whether the target was reached, and the mean pixel distance from the model's edges to the nearest
strong photo edge:
```json
{
  "name": "spatial_closed_loop_edge_align",
  "parameters": {
    "imagePath": "public/test_images/storefront.jpg",
    "glbPath": "public/models/storefront_block_raw_tiles.glb",
    "initialPose": { "x": 2, "y": 11, "z": -38, "targetX": 0, "targetY": 10, "targetZ": 0, "fov": 46 },
    "maxIterations": 25,
    "targetEdgeCorrelation": 95,
    "timeBudgetSeconds": 120
  }
}
```

### 4. `geobox_resect_image_location`
Computes the camera optical center $(\text{lat}_{\text{cam}}, \text{lng}_{\text{cam}}, \text{alt}_{\text{cam}})$, attitude, standoff distance, FOV, view frustum and Google Maps 3D Platform tiles camera configuration for a photograph or video frame from pose evidence you supply. It does not analyse the photo's pixels and runs no edge alignment (use `geobox_optimize_edge_alignment` for that, which reports the correlation it measured). What the photo shows comes from `targetCoords`, or from `targetLandmarkName` (else `promptHint`) resolved with Google Places. The pose needs one of: 2D-3D point correspondences (`points2D`/`points3D` with `imageWidthPx`/`imageHeightPx`), the camera position (`cameraOpticalCenter` or `knownCoords`, with `alt`), or `headingDeg` with `pitchDeg` and `standoffDistanceMeters`. Missing evidence is an error, and the result's `poseSource` names the evidence used:
```json
{
  "name": "geobox_resect_image_location",
  "parameters": {
    "imagePath": "public/test_images/urban_scene.jpg",
    "targetLandmarkName": "Flatiron Building, New York",
    "headingDeg": 210,
    "pitchDeg": 8,
    "standoffDistanceMeters": 180,
    "sensorFocalMm": 26.0
  }
}
```
