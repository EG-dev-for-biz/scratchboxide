---
name: stage-3d-vector-world
description: >-
  Stage authentic 3D urban and road environments from Google 2D roadmap vector tiles (MVT/PBF at zoom 16)
  around hero assets using stage_3d_vector_world. Generates 5-tier road cross-sections with beveled granite curbs,
  sidewalks, parcel massing prisms, lane-aligned traffic, streetlamps, and street trees rendered in 18% Studio Grey Clay
  with continuous elevation profiles.
---

# Stage 3D Vector World Skill

The **Stage 3D Vector World Skill** enables AI agents to generate structured, CAD-grade 3D urban environments from real-world Google Roadmap Vector Tiles using the `stage_3d_vector_world` tool.

---

## 1. System Architecture & When to Use

```
[Target WGS-84 Coordinates (lat, lng)]
                    │
                    ▼
          [GoogleVectorTileService]
  (Fetches Zoom-16 MVT/PBF Roadmap Tiles)
                    │
                    ▼
     [Vector World Staging Pipeline]
  ┌─────────────────┼─────────────────┐
  ▼                 ▼                 ▼
[Parcel Massing] [Road Corridors]  [Urban Furnishing]
(Extruded         (5-Tier Cross-   (Streetlamps,
 Building Prisms)  Sections, Curbs) Trees, Vehicles)
  └─────────────────┬─────────────────┘
                    │
                    ▼
         [Hero Staging Solver]
  (Calculates exact lane/sidewalk pose & altitude)
                    │
                    ▼
      [Standard Binary glTF 2.0 (.glb)]
   (18% Studio Grey Clay Massing in Void)
```

### Vector Tiles vs. Photogrammetric 3D Tiles
- **Photogrammetric 3D Tiles (`getGoogle3DTilesFullTexture` / `getGoogle3DTilesClay`)**: Ideal when reproducing complex organic terrain, historical landmarks (e.g. Eiffel Tower, Colosseum), or high-altitude aerial scans.
- **Vector World Staging (`stage_3d_vector_world`)**: Superior for urban street-level automotive and architectural scenes. Vector tiles provide clean rectilinear building prisms, mathematically straight curbs with $15\text{cm}$ vertical reveal, discrete traffic lanes, and continuous elevation profiles with zero photogrammetric noise.

---

## 2. In-App Gemini Agent Tool (`stage_3d_vector_world`)

Agents invoke `stage_3d_vector_world` to construct an instant real-world staging environment around any hero asset:

```json
{
  "name": "stage_3d_vector_world",
  "args": {
    "latitude": 40.7484,
    "longitude": -73.9857,
    "zoom": 16,
    "radiusTiles": 1,
    "style": "studio_clay",
    "populate": true,
    "includeTraffic": true,
    "includeTrees": true,
    "includeStreetlamps": true,
    "includeSidewalks": true,
    "heroStaging": {
      "type": "lane",
      "laneIndex": 1,
      "distanceAlongM": 25.0,
      "roadName": "5th Avenue"
    },
    "outputGlbPath": "public/models/fifth_ave_stage.glb"
  }
}
```

### Parameter Specifications
- `latitude`, `longitude` *(required)*: Center geodetic anchor coordinates.
- `zoom`: Vector tile level (default `16` for high-definition urban street geometry).
- `radiusTiles`: Surrounding tile radius (default `1` yields a complete $3 \times 3$ district grid).
- `style`: Material mode (default `"studio_clay"` for 18% Studio Grey Clay CAD look).
- `populate`: Automatically populates streetlamps, curbside trees, and background traffic.
- `heroStaging`: Solves exact placement transforms for a hero object (`lane` or `sidewalk`).

---

## 3. The 5-Tier Road Cross-Section Engine

The native staging engine builds multi-lane highway and street cross-sections with physical curb reveals:

```
                          [ARTERIAL BOULEVARD PROFILE]
   ┌───────────┐                                                       ┌───────────┐
   │ Sidewalk  │ 15cm Beveled                               15cm Beveled│ Sidewalk  │
   │  (3.0m)   │ Granite Curb   Lane 1        Lane 2         Granite Curb│  (3.0m)   │
───┴───────────┤   ┌─────────┬──────────────┬──────────────┬───────────┤───────────┴───
               └───┘         │  Asphalt     │  Asphalt     │           └───┘
                             │  Pavement    │  Pavement    │
```

| Road Tier | Default Lanes | Lane Width | Curb Reveal | Sidewalk Width | Urban Elements |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Freeway / Motorway** | 4–6 | $3.75\text{m}$ | Barrier ($0.8\text{m}$) | None | Overhead gantries, guide barriers |
| **Arterial Boulevard** | 2–3 each way | $3.50\text{m}$ | $15\text{cm}$ bevel | $3.0\text{m}$ | Trees, dual streetlamps, traffic |
| **Secondary Collector**| 1–2 each way | $3.25\text{m}$ | $15\text{cm}$ bevel | $2.2\text{m}$ | Streetlamps, parked cars |
| **Local Residential**  | 1 each way   | $2.85\text{m}$ | $12\text{cm}$ bevel | $1.8\text{m}$ | Tree planting strips |
| **Alleyway / Service** | 1 shared     | $3.50\text{m}$ | Flush ($0\text{cm}$) | None | Service bollards |

---

## 4. Hero Asset Grounding & Contextual Placement

When staging a hero car, motorcycle, or architectural pavilion:

1. **Analytical Staging Solver**:
   When `heroStaging` is supplied, `stage_3d_vector_world` evaluates the road corridor's 3D Catmull-Rom spline at `distanceAlongM`:
   - Evaluates road centerline tangent $\mathbf{T}$ and lateral normal $\mathbf{N}$.
   - Offsets laterally by $(i_{\text{lane}} + 0.5) \times W_{\text{lane}}$ for lane staging, or to the sidewalk center.
   - Computes yaw heading: $\psi = \operatorname{atan2}(T_x, -T_z)$.
   - Returns exact metric translation and rotation quaternion for the hero asset.
2. **Contact Shadow & Ambient Occlusion**:
   The hero asset is placed flush against the asphalt or pavement plinth, producing sharp contact shadows with zero floating gaps.

---

## 5. Staging Verification Checklist

Before finalizing urban staging:
- [ ] **GLB Integrity**: File begins with 12-byte header `0x46546C67` ("glTF"), version 2.
- [ ] **Clay Uniformity**: All massing and infrastructure adheres to 18% Studio Grey Clay (`roughness: 0.85`, `metalness: 0.0`).
- [ ] **Continuous Elevation**: Roadways follow ground elevation profile smoothly without abrupt vertical tears.
- [ ] **Zero Primitive Constructors**: All buildings and road cross-sections generated via native extrusion pipeline, never flat Three.js primitives.
