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

Runs as-is in `execute_3d_python_script` (checked by `packages/core/test/skill-guide-examples.test.ts`).

```python
import scratchbox as sb

# 1. Scene and material
scene = sb.Scene()
clay_mat = sb.PbrMaterial.clay()          # 18% studio grey clay

def add(mesh, name):
    mesh.name = name
    mesh.set_material(clay_mat)
    scene.add_mesh(mesh)

spine_path = [(0.0, 0.0, -2.0), (0.2, 0.8, -0.5), (-0.1, 1.2, 1.0), (0.0, 1.5, 2.5)]

# 2. Operator 1: SE(3) Lie Group Curve Sweep (Truss, Hoses, Ribs)
add(sb.sweep_curve_profile(path=spine_path, profile_dimensions=(0.12, 0.12),
                           scale_taper=(0.9, 0.6), twist_deg=90.0), "chassis_spine")

# 3. Operator 2: Harmonic Solid of Revolution (Rims, Flanges, Thrusters)
# profile_curve is (height, radius) pairs; K lobes make cog teeth or flutes, K=0 a smooth turning.
# The default axis is Y; wheels revolve around the axle (X), or the complexity gate rejects them as flat discs.
add(sb.revolve_harmonic_solid(axis=(1.0, 0.0, 0.0),
                              profile_curve=[(0.0, 0.45), (0.1, 0.52), (0.2, 0.47), (0.35, 0.52)],
                              harmonic_lobe_count=5, harmonic_depth_ratio=0.1,
                              helix_pitch_meters=3.5), "wheel_rim_fl")

# 4. Operator 3: Affine Metric Replicator (Fasteners, Louvers, Vanes) along the same path
add(sb.replicate_metric_array(distribution_mode="CURVE_1D", guide_points=spine_path, pitch_meters=0.18,
                              seed_geometry={"shape": "CYLINDRICAL_FASTENER", "dimensions": (0.015, 0.04)}),
    "structural_fasteners")

# 5. Operator 4: Normal Relief. Only noise-style displacement exists today
# (Mesh.displace_along_normals, Mesh.tessellate_and_displace); there is no curve-guided groove operator.
panel = sb.create_plane(width=1.2, height=0.8, seg_x=128, seg_y=96)
panel.displace_along_normals(frequency=20.0, amplitude=0.006)
add(panel, "relief_panel")

# 6. Write binary .glb (the runner defines OUTPUT_GLB_PATH)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
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
