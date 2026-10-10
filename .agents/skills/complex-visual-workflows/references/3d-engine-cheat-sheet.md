# 3D Engine & Procedural Modeling Reference Cheat Sheet

This reference document provides the canonical API contracts, C++20 engine headers, Python nanobind primitives, and geometric invariants for Scratchbox 3D Engine.

---

## 1. Core Geometric Invariants

1. **The 70-20-10 Form Hierarchy**:
   - **70% Primary Edifice / Silhouette**: Sculpted compound curvature, proportional stance, non-linear deformers (taper, twist, bend, bulge, FFD tensor lattices).
   - **20% Secondary Articulated Assemblies**: Discrete sub-parts (splitters, diffusers, multi-element chassis, hollow-spoke wheel rims, brake calipers, cockpit framing, intake cowlings).
   - **10% Tertiary Micro-Detail**: Panel shut lines, hex grilles, hood louvers, quad exhaust tips, mechanical fasteners, chamfers.
2. **Complexity Floors**:
   - Multi-mesh scenes: $\ge 25,000$ vertices, $\ge 15,000$ triangles.
   - Standalone props/vehicles: $\ge 5,000$ vertices, $\ge 3,000$ triangles.
   - Zero flat Three.js primitives (`new THREE.BoxGeometry`).
3. **Mandatory First-Request Staging**:
   - **No location in prompt**: Construct Hero Objects in **18% Studio Grey Clay** (`sb.PbrMaterial.clay()`, roughness 0.85, metalness 0.0, color `[0.55, 0.57, 0.60]`) in a clean studio void (`environment: { skybox: 'studio', lighting: 'studio', ground: false }`).
   - **Location in prompt**: Stage directly at authentic real-world coordinates via Google 3D Tiles Studio Grey Clay (`google_3d_tiles_get_clay` or `execute_3d_python_script({ location: "..." })`) or `stage_3d_vector_world`. Never generate synthetic asphalt boxes or procedural lollipop trees.

---

## 2. Python Nanobind Engine (`import scratchbox as sb`)

```python
import scratchbox as sb
import math

# 1. Initialize Scene and Material
scene = sb.Scene()
clay_mat = sb.PbrMaterial.clay(roughness=0.85, albedo=(0.57, 0.57, 0.59))

# 2. Operator 1: SE(3) Lie Group Curve Sweep (Truss, Hoses, Ribs)
spline = sb.CatmullRomCurve3D([
    (0.0, 0.0, -2.0),
    (0.2, 0.8, -0.5),
    (-0.1, 1.2, 1.0),
    (0.0, 1.5, 2.5)
])
chassis_sweep = sb.LieSweep(spline, profile_radius=0.12, taper_start=0.9, taper_end=0.6, twist_turns=0.25)
scene.add_mesh(chassis_sweep.polygonize(radial_segments=24, step_count=80), material=clay_mat, name="chassis_spine")

# 3. Operator 2: Harmonic Solid of Revolution (Rims, Flanges, Thrusters)
# K lobes create cog teeth or flutes; K=0 creates smooth turnings
wheel_hub = sb.HarmonicRevolve(
    radius_func=lambda z: 0.45 + 0.08 * math.sin(z * 8.0) if z < 0.2 else 0.52,
    z_min=0.0, z_max=0.35,
    harmonic_lobes=5,   # 5-spoke hollow alloy rim
    helical_twist=0.1
)
scene.add_mesh(wheel_hub.polygonize(segments=64), material=clay_mat, name="wheel_rim_fl")

# 4. Operator 3: Affine Metric Replicators (Fasteners, Louvers, Vanes)
replicator = sb.AffineMetricReplicator(
    seed_geometry=sb.Cylinder(radius=0.015, height=0.04, segments=12),
    pitch_meters=0.18,
    distribution_curve=spline
)
scene.add_mesh(replicator.generate_instanced_mesh(), material=clay_mat, name="structural_fasteners")

# 5. Operator 4: Isoparametric Normal Relief Fields (Panel Shut Lines)
chassis_mesh = chassis_sweep.polygonize(24, 80)
sb.apply_normal_displacement(
    chassis_mesh,
    relief_func=lambda u, v, pos: -0.012 if (math.sin(u * 20.0 * math.pi) > 0.96) else 0.0
)

# 6. Stream directly to binary .glb
glb_bytes = scene.export_glb(binary=True, embed_pbr=True)
sb.write_file("output/hero_asset.glb", glb_bytes)
```

---

## 3. Native C++20 Astro Engine Headers

Include directly in ephemerally compiled C++ modules:

| Header | Key Primitives & Functions | Use Case |
| :--- | :--- | :--- |
| `scratchbox_engine.hpp` | `Mesh`, `Vertex`, `Material`, `Scene` | Canonical data structures, glTF 2.0 streaming |
| `scratchbox_math.hpp` | `Vec3`, `Quat`, `Mat4`, SIMD ops | High-performance vector mathematics |
| `scratchbox_shaper.hpp` | `BernsteinFFD`, `Taper`, `Twist`, `Bend` | Parametric mesh reshaping and non-linear deformation |
| `scratchbox_archie.hpp` | `ArchieBuilding`, `FenestrationBay` | Architectural massing, mansard roofs, facade relief |
| `scratchbox_veggie.hpp` | `VeggieTree`, `LSystemGrowth` | Botanical branching, Golden Ratio phyllotaxis ($137.5^\circ$) |
| `scratchbox_hair.hpp` | `HarmonicGuideCurves`, `MarschnerAlbedo` | Analytical hair, fur, and groom splat projection |
| `scratchbox_spz.hpp` | `SpzEncoder`, `SpzDecoder` | Niantic SPZ v2 streaming serialization ($< 100$ms) |
| `scratchbox_4dgs_humanoid.hpp` | `SbHumanAvatar`, `LinearBlendSkinning` | 22-joint canonical dynamic humanoid performer |

---

## 4. Google 3D Tiles & Geospatial Rectification

- **Ingestion APIs**:
  - `getGoogle3DTilesClay({ lat, lng, radiusMeters: 250, errorTarget: 0.5 })` $\rightarrow$ Studio Grey Clay massing without photogrammetric texture noise.
  - `getGoogle3DTilesFullTexture({ lat, lng, radiusMeters: 250, errorTarget: 0.5 })` $\rightarrow$ Full photogrammetric textured model.
- **2D Roadmap Vector Staging (`stage_3d_vector_world`)**:
  - Ingests MVT/PBF vector tiles at zoom 16.
  - Constructs 5-tier kinematic road profiles with beveled granite curbs, sidewalks, parcel massing prisms, lane-aligned traffic, and streetlamps.
- **UTDRA / ULDRA Mesh Rectification (`utdra_probe_tile`)**:
  - Excises curtain walls beneath bridges.
  - Rectifies vertical skyscraper shafts while preserving historic cornices/crowns.
  - Non-destructive elevation slicing without hole formation.
