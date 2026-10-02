---
name: adaptive-survey-director
description: >-
  Plan, orchestrate, and execute scene-conformal photogrammetric survey camera rigs for any 3D asset,
  architectural structure, or Google 3D Tile mesh using Adaptive Survey Rig Engine (AdaptiveSurveyRigService
  and plan_adaptive_survey_rig). Eliminates hardcoded presets and underground cameras by analyzing real mesh
  geometry (OBB, surface normals, local terrain raycasts) to enforce sub-millimeter GSD standoff, facade normal
  targeting, and depth bounding that kills floating sky splats.
---

# Adaptive Survey Director: Scene-Conformal Photogrammetric Camera Rigging

The **Adaptive Survey Director** enforces the Adaptive Domain Architecture (ADA) for 3D camera station placement and photogrammetric radiance field capture in Scratchbox IDE. It replaces legacy hardcoded presets (e.g. `'amphitheatre-complete'`, `'orbital-multi-tier'`) with continuous, geometric first-principles analysis of the underlying 3D mesh.

---

## 1. Why Preset Camera Rigs Fail

Static, hardcoded camera rigs suffer from four catastrophic real-world failure modes:

| Failure Mode | Root Cause | Observable Visual Artifact |
| :--- | :--- | :--- |
| **Underground Cameras** | Preset assumes flat ground at $Y = 0$, but real-world terrain (hills, excavations, hypogeum) has elevation $Y > 0$ or variable grade. | Camera placed inside subterranean rock/dirt. Black or inverted renders. |
| **Facade Splat Drift** | Preset uses circular orbit around $(0, 0, 0)$ ignoring structure orientation yaw $\theta_{\text{yaw}}$ and aspect ratio. | Cameras are too close on long axes (clipping walls) and too far on short axes (blurry textures). |
| **Floating Sky Splats** | Station depth unprojection is unbounded ($z \to \infty$ or $z = 1000\text{m}$). | Deep blue sky pixels are unprojected into millions of floating point clouds hovering around the model. |
| **Buried Floor Stations** | Standoff is guessed rather than derived from camera optics and sensor Ground Sampling Distance (GSD). | Cameras point at empty air or crop the top two tiers of monumental facades. |

---

## 2. Core Geometric & Physical Principles

```
                  [3D Mesh / Grounded Tile Extract (.glb)]
                                     │
                                     ▼
                [Oriented Bounding Box (OBB) & Ground Datum]
                   (Principal axes, yaw θ, W × H × D, ground Y)
                                     │
                                     ▼
                 [Optics & GSD Standoff Calculation]
               (f_mm, sensor width, target GSD mm/px -> standoff)
                                     │
                                     ▼
                  [Local Terrain Raycasting & Clearance]
                (Sample terrain in 6m radius; Y_cam >= Y_terrain + 1.8m)
                                     │
                                     ▼
                   [Multi-Tier Surface Normal Trajectory]
                 (Pedestrian 1.8m, Mid-Tier, Attic/Cornice, Zenith)
                                     │
                                     ▼
                  [Strict Depth Bounding & Sky Clipping]
                (maxDepth = standoff * 2.8, dropSky = true)
```

### Principle 1: Scene-Conformal Dual Bounding Box (AABB + OBB)
- Always extract 2D horizontal principal components (PCA) on $(X, Z)$ coordinates via `OrientedBoundingBoxSolver.compute` to determine:
  - Principal orientation yaw: $\theta_{\text{yaw}}$ (radians/degrees).
  - Structure centroid: $\mathbf{C} = [C_x, C_y, C_z]$.
  - Oriented bounding dimensions: Width $W$, Height $H$, Depth $D$.
- Camera stations must be placed along an **oriented ellipse** matching $W, D$ and yaw $\theta_{\text{yaw}}$, dilated outward along horizontal surface normals by the calculated standoff distance $d_{\text{standoff}}$.

### Principle 2: Optics & GSD-Derived Standoff Distance
- Standoff distance is **never** a hardcoded magic number. It is derived analytically from the camera sensor optics and target Ground Sampling Distance (GSD):
  $$\text{pixelPitch}_{\text{mm}} = \frac{\text{sensorWidth}_{\text{mm}}}{\text{renderWidth}_{\text{px}}}$$
  $$\text{standoff}_{\text{meters}} = \frac{f_{\text{mm}} \times \text{targetGSD}_{\text{mm}}}{\text{pixelPitch}_{\text{mm}} \times 1000}$$
- **Resolution Guidelines**:
  - **Macro / Tactile Detail** (travertine pores, brick coursing, fine relief): Target GSD $\le 2.0\text{mm}/\text{px}$ ($d_{\text{standoff}} \approx 20\text{m}-35\text{m}$ for $35\text{mm}$ lens).
  - **Monumental Architecture** (arcades, columns, pediments): Target GSD $\approx 3.0\text{m}-5.0\text{mm}/\text{px}$ ($d_{\text{standoff}} \approx 35\text{m}-60\text{m}$).
  - **Urban District / Aerial Overview**: Target GSD $\approx 10.0\text{mm}-25.0\text{mm}/\text{px}$.

### Principle 3: Strict Zero-Underground Invariant ($Y_{\text{cam}} \ge Y_{\text{terrain}} + 1.8\text{m}$)
- Ground level is **never** assumed to be $Y = 0$.
- Ground datum $Y_{\text{ground}}$ is computed from the 10th-15th percentile of surface vertices to filter subterranean pits, hypogeum trenches, and noise spikes.
- For every camera station candidate $(X_c, Z_c)$, sample the surrounding mesh vertices within a $6\text{m}$ radial neighborhood to determine the local terrain surface height $Y_{\text{terrain}}$.
- Enforce the non-negotiable ground clearance constraint:
  $$Y_{\text{cam}} \ge \max(Y_{\text{ground}} + 1.8\text{m},\; Y_{\text{terrain}} + 1.8\text{m})$$
- Under NO circumstance may any camera station be placed lower than $1.8\text{m}$ above local terrain.

### Principle 4: Facade-Normal Optical Targeting
- The camera optical axis (forward vector) must **never** point blindly at world origin $(0, 20, 0)$.
- The camera must point directly at its corresponding facade patch on the structure perimeter:
  $$\mathbf{P}_{\text{surface}} = \mathbf{C} + \mathbf{R}(\theta_{\text{yaw}}) \cdot [0.5 W \cos\phi,\; Y_{\text{target}},\; 0.5 D \sin\phi]$$
- Pitch and yaw angles are computed analytically to aim the camera optical center directly at $\mathbf{P}_{\text{surface}}$.

### Principle 5: Strict Depth Bounding & Zero Sky Splats
- To eliminate floating cloud noise and blue sky splats in 3D Gaussian Splatting:
  - Set `maxDepth = Math.max(40.0, standoff * 2.8)`.
  - Set `dropSky: true` on all station poses.
  - Reject unprojection beyond `maxDepth` in depth unprojectors (`station_to_splats`).

### Principle 6: Landmark Isolation in Environmental Tile Contexts
- Ingested Google 3D Tiles frequently contain $500\text{m}-1000\text{m}$ of surrounding urban district landscape.
- To prevent surrounding streets and hills from distorting the bounding box of the primary structure:
  - Specify `focusCentroid` (approximate structure center $[C_x, C_y, C_z]$).
  - Specify `cropRadius` ($110\text{m}-140\text{m}$) to isolate the landmark before computing OBB and ground datum.

---

## 3. Tool & API Usage

### A. Agent Tool: `plan_adaptive_survey_rig`
Invoke `plan_adaptive_survey_rig` whenever surveying or capturing any 3D asset or tile extract:

```typescript
// Example: Planning 40 adaptive stations for the Colosseum
const result = await registry.dispatch('plan_adaptive_survey_rig', {
    glbPath: 'public/models/colosseum_grounded.glb',
    cameraBudget: 40,
    mode: 'multitier-complete',
    targetResolutionMm: 2.5,
    focusCentroid: [-43.42, 24.0, 62.54],
    cropRadius: 120.0,
    outJsonPath: 'public/tilesets/colosseum/colosseum_survey_40_stations.json'
});
```

### B. HTTP API Route
`POST /api/3d/survey/plan-adaptive` accepts:
```json
{
  "glbPath": "public/models/colosseum_grounded.glb",
  "cameraBudget": 40,
  "mode": "multitier-complete",
  "targetResolutionMm": 2.5,
  "focusCentroid": [-43.42, 24.0, 62.54],
  "cropRadius": 120.0
}
```

### C. Programmatic Service
```typescript
import { AdaptiveSurveyRigService } from '@scratchbox/core/node';

const rigResult = AdaptiveSurveyRigService.planRig('public/models/my_building.glb', {
    cameraBudget: 32,
    mode: 'facade-perimeter',
    targetResolutionMm: 2.0,
    minGroundClearanceMeters: 1.8
});

console.log(`Planned ${rigResult.poses.length} stations across ${rigResult.tiers.length} tiers.`);
console.log(`Ground datum: ${rigResult.groundDatumY}m. Standoff: ${rigResult.standoffMeters}m.`);
```

---

## 4. Multi-Tier Station Distribution Archetypes

When executing in `multitier-complete` mode, camera budget is proportionally divided across architectural elevation bands:

1. **Pedestrian / Eye-Level Tier (30% of budget)**:
   - Elevation: $Y_{\text{cam}} = Y_{\text{terrain}} + 1.8\text{m}$.
   - Upward tilt: $\approx +5^\circ \text{ to } +12^\circ$ aiming at lower arcades and portals.
   - Purpose: Ground-level human perspective, entryways, base rustication, pavement joints.

2. **Mid-Level Tier (35% of budget)**:
   - Elevation: $Y_{\text{cam}} = Y_{\text{ground}} + 0.35 \times H_{\text{structure}}$.
   - Level pitch: $\approx 0^\circ \text{ to } -3^\circ$.
   - Purpose: Multi-story colonnades, piano nobile windows, mid-facade friezes.

3. **Attic / Cornice Tier (20% of budget)**:
   - Elevation: $Y_{\text{cam}} = Y_{\text{ground}} + 0.85 \times H_{\text{structure}}$.
   - Downward tilt: $\approx -12^\circ \text{ to } -18^\circ$.
   - Purpose: Entablature, parapets, roof eaves, architectural crowns.

4. **Zenith Overview Tier (15% of budget)**:
   - Elevation: $Y_{\text{cam}} = Y_{\text{ground}} + 1.25 \times H_{\text{structure}}$.
   - Steep downward plunge: $\approx -35^\circ \text{ to } -45^\circ$.
   - Purpose: Roof geometry, interior arena floor / courtyard, aerial parallax.

---

## 5. Verification & Rejection Gate

Before feeding synthesized stations into downstream pipelines (`survey_render_station`, `survey_beautify_to_splats`, or `station_to_splats`):

- [ ] **Zero Underground Cameras**: Every single pose satisfies $Y_{\text{pos}} \ge Y_{\text{ground}} + 1.8\text{m}$.
- [ ] **Oriented Coverage**: Station perimeter aligns with structure orientation yaw $\theta_{\text{yaw}}$, not an unrotated world grid.
- [ ] **Strict Depth Capping**: Every pose has `maxDepth <= standoff * 2.8` and `dropSky: true`.
- [ ] **Target Ground Sampling**: Standoff distance satisfies the user's required GSD resolution.
- [ ] **Clean Splat Fusion**: Verify fused `.splat` shows razor-sharp architectural walls without blue sky clouds or ground clipping.
