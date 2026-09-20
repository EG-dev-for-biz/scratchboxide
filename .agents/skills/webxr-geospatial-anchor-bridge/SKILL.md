---
name: webxr-geospatial-anchor-bridge
description: >-
  Bidirectionally align WGS-84 geodetic GPS coordinates with WebXR metric space (+Y gravity-aligned Up),
  calibrate multi-tier sensor fusion (GPS + compass + viewer pose) and optical manual pins, synchronize ARCore
  deployment contracts, and project Google Maps road corridors and parcel massing into 3D WebXR scenes.
---

# WebXR Geospatial Anchor Bridge & Metric Space Alignment

The **WebXR Geospatial Anchor Bridge Skill** enables AI agents to seamlessly bridge physical geodetic coordinates (WGS-84 GPS latitude, longitude, and ellipsoidal/MSL altitude) with immersive WebXR and ARCore metric coordinate spaces.

---

## 1. System Architecture & Coordinate Transformations

```
[Real-World Geodetic Coordinates (WGS-84)]
     Latitude (φ), Longitude (λ), Altitude MSL (h)
                    │
                    ▼  (WGS-84 Ellipsoidal Projection)
    [Local Tangent Plane (ENU)]
     +X = East, +Y = Up, -Z = North
                    │
                    ▼  (Rigid Affine Alignment: R_y(θ_align) * P_enu + T_align)
    [WebXR Metric Space (local-floor)]
     1 unit = 1 meter
     +Y = Gravity-aligned Up
     +X = Right, +Z = Backward (relative to initial viewer orientation)
                    ▲
                    │  (Inverse Transform: R_y(-θ_align) * (P_xr - T_align))
[User / Device Interactions & 6-DoF Viewer Pose]
```

### Mathematical Foundations
1. **WGS-84 Reference Ellipsoid**:
   - Semi-major axis $a = 6,378,137.0\text{ m}$
   - Flattening $f = 1 / 298.257223563$
   - First eccentricity squared $e^2 = 2f - f^2$
   - Prime vertical radius of curvature $N(\phi) = \frac{a}{\sqrt{1 - e^2 \sin^2 \phi}}$
2. **Local Tangent Plane (ENU)**:
   - Evaluated about reference origin $(\phi_0, \lambda_0, h_0)$:
     $$\begin{aligned}
     \Delta \phi &= \phi - \phi_0, \quad \Delta \lambda = \lambda - \lambda_0, \quad \Delta h = h - h_0 \\
     X_{\text{enu}} &= \Delta \lambda \cdot \frac{\pi}{180} \cdot N(\phi_0) \cos(\phi_0) \\
     Z_{\text{enu}} &= -\Delta \phi \cdot \frac{\pi}{180} \cdot M(\phi_0) \quad (\text{where } -Z \text{ is North}) \\
     Y_{\text{enu}} &= \Delta h
     \end{aligned}$$
3. **Compass Heading $\leftrightarrow$ WebXR Orientation**:
   - Compass heading $\theta$ (degrees clockwise from True North: $0^\circ = \text{North}, 90^\circ = \text{East}$) converts to yaw angle:
     $$\text{yaw} = -\theta \cdot \frac{\pi}{180}$$
   - Rotational quaternion: $q = [0, \sin(\text{yaw}/2), 0, \cos(\text{yaw}/2)]$.

---

## 2. Multi-Tier Sensor Calibration Pipeline

Raw GPS on mobile devices is subject to $3 - 10\text{m}$ multipath drift and magnetic declination errors. The bridge provides three calibration tiers:

### Tier 1: Anchor Origin Calibration
- Sets the primary geodetic anchor at the WebXR metric world origin $[0, 0, 0]$ with an optional True North heading offset.
- Fast, deterministic baseline initialization.

### Tier 2: Autonomous Sensor Fusion
- Continuously fuses device GPS fixes ($\ge 5\text{m}$ accuracy threshold), hardware magnetometer/compass heading, and WebXR viewer pose without user intervention.
- Computes optimal translation delta $\mathbf{T}_{\text{align}} = \mathbf{P}_{\text{viewer}} - \mathbf{R}_y(\theta_{\text{align}}) \cdot \mathbf{P}_{\text{gps\_enu}}$.

### Tier 3: Zero-Drift Manual Optical Pin Calibration
- The user visually sights a known physical landmark (e.g. building corner, doorway, surveyed survey monument) and taps or places a reticle pin in WebXR space.
- Calculates exact translation offset $\mathbf{T}_{\text{offset}} = \mathbf{P}_{\text{pinned}} - \mathbf{P}_{\text{projected}}$, locking millimeter-precision spatial stability for the entire session.

---

## 3. ARCore Deployment Contracts & Vector Projections

### ARCore GeoAnchorDeploymentContract
Integrates directly with Cloud Anchor and Geospatial Anchor contracts:
```typescript
interface GeoAnchorDeploymentContract {
    contractId: string;
    targetDistrictId: string;
    anchorOrigin: GeospatialAnchorOrigin;
    geospatialAnchorType: 'WGS84_TERRAIN' | 'WGS84_ROOFTOP' | 'LOCAL_VPS_SURFACE';
    entities: ARPlacementEntity[];
    vectorOverlays?: {
        roadCenterlines?: GoogleRoadCorridor[];
        parcelBoundaries?: GoogleParcelEnvelope[];
    };
}
```

### Road Corridors & Parcel Boundaries
- `projectRoadCorridorsToWebXR(corridors)`: Transforms WGS-84 waypoint arrays into Three.js `THREE.Line` geometry with standard line materials and embedded corridor metadata.
- `projectParcelsToWebXR(parcels)`: Polygons are converted into ENU 2D boundary shapes and extruded into 3D volumetric massing meshes (`THREE.ExtrudeGeometry`) elevated by height in meters.

---

## 4. In-App Gemini Agent Tools

Agents can invoke these tools directly during conversational workflows or automated AR pipeline tasks:

### 1. `webxr_geospatial_align_coordinates`
Bidirectionally convert coordinates between geodetic GPS and WebXR metric space:
```json
{
  "originAnchor": { "latitude": 37.774929, "longitude": -122.419416, "altitudeMsl": 15.0 },
  "targetGeodetic": { "latitude": 37.775200, "longitude": -122.419100 },
  "headingDeg": 45.0
}
```

### 2. `webxr_geospatial_calibrate`
Calibrate coordinate alignment via anchor origin, sensors, or manual optical pin:
```json
{
  "originAnchor": { "latitude": 37.774929, "longitude": -122.419416 },
  "mode": "sensors",
  "sensorSample": {
    "latitude": 37.774935,
    "longitude": -122.419420,
    "accuracyMeters": 3.2,
    "headingDeg": 12.5
  },
  "viewerPose": {
    "position": [0.5, 1.6, -1.2]
  }
}
```

### 3. `webxr_geospatial_project_vectors`
Project road corridors and parcel boundaries into WebXR 3D metric lines and meshes:
```json
{
  "originAnchor": { "latitude": 37.774929, "longitude": -122.419416 },
  "roadCorridors": [
    {
      "id": "market_st",
      "name": "Market Street",
      "type": "arterial",
      "coordinatesWGS84": [
        [-122.419416, 37.774929],
        [-122.418000, 37.776000]
      ]
    }
  ],
  "parcels": [
    {
      "id": "lot_101",
      "name": "Civic Center Plaza",
      "heightMeters": 25.0,
      "isLandmark": true,
      "polygonWGS84": [
        [-122.419500, 37.774800],
        [-122.419200, 37.774800],
        [-122.419200, 37.775100],
        [-122.419500, 37.775100]
      ]
    }
  ]
}
```

---

## 5. Usage in Codebase

```typescript
import { WebXRGeospatialAnchorBridge } from '@scratchbox/core/browser';
import * as THREE from 'three';

// 1. Initialize with reference anchor
const bridge = new WebXRGeospatialAnchorBridge({
    latitude: 37.774929,
    longitude: -122.419416,
    altitudeMsl: 15.0
});

// 2. Calibrate anchor
bridge.calibrateAnchorOrigin(0);

// 3. Project GPS coordinate to WebXR metric space
const webxrPos = bridge.geodeticToWebXR({
    latitude: 37.775200,
    longitude: -122.419100,
    altitudeMsl: 18.0
});

// 4. Position 3D object in Three.js / WebXR scene
const markerMesh = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x00ff88 })
);
markerMesh.position.copy(webxrPos);
scene.add(markerMesh);
```
