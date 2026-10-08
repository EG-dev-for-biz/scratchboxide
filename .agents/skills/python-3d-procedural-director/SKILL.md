---
name: python-3d-procedural-director
description: >-
  Direct, author, and execute procedural 3D Python scripts using the native Scratchbox 3D Engine
  (execute_3d_python_script, import scratchbox as sb). Enforces the 4 Universal Differential Geometric Operators
  (SE(3) Lie Group Sweeps, Harmonic Solids of Revolution, Affine Metric Replicators, Isoparametric Normal Relief Fields),
  the 70-20-10 anatomical form hierarchy, AABB dynamic camera auto-framing, 18% Studio Grey Clay void baseline,
  and automatic real-world location staging.
---

# Python 3D Procedural Director Skill

The **Python 3D Procedural Director Skill** guides AI agents to synthesize, author, and direct complex 3D scenes, vehicles, architectural edifices, and environmental props using the native Scratchbox Python SDK (`import scratchbox as sb`) executed via `execute_3d_python_script`.

---

## 1. Architecture & Execution Bus

Procedural scripts execute inside a sandboxed Python sub-process communicating directly with the native C++20 engine via nanobind bindings:

```
[Agent Natural Language Request]
                 │
                 ▼
     [execute_3d_python_script]
 (Python 3 script + optional location)
                 │
                 ▼
   [NativePythonRunnerService]
                 │
                 ▼
 [Python Runtime: import scratchbox as sb]
  - sb.core      (Scenes, submeshes, transforms)
  - sb.shaper    (Taper, twist, bend, bulge, FFD lattices)
  - sb.nature    (Botany, space colonization, foliage)
  - sb.plant     (SMPL tree architecture)
  - sb.terrain   (Multi-fractal noise, elevation profiles)
  - sb.geospatial(Leaf-LOD 3D tile shape extraction)
                 │
                 ▼
 [Native C++20 Astro Engine (Apple Clang)]
 (Sub-millisecond SIMD geometry & normal transfer)
                 │
                 ▼
 [Standard Binary glTF 2.0 (.glb) File]
  - Written via sb.io.write_glb(OUTPUT_GLB_PATH, scene)
  - Evaluated against GeometricComplexityGate (>= 25,000 vertices)
  - AABB bounding box and metrics extracted for dynamic camera framing
                 │
                 ▼
 [Mounted to Three.js Stage / Canvas Viewport]
```

### Invariant Rules
1. **Never Fall Back to Client-Side Primitives ("Tier-0" Ban)**: Client-side Three.js primitives (`new THREE.BoxGeometry`, etc.) are strictly prohibited. All geometry must be generated via the native Python/C++ engine.
2. **Deterministic Output Path**: Every script must import `scratchbox as sb` and end by writing the compiled scene to `OUTPUT_GLB_PATH` via `sb.io.write_glb(OUTPUT_GLB_PATH, scene)`.

---

## 2. The 4 Universal Differential Geometric Operators

To guarantee domain-agnostic universality (the Alien Planet Test), agents must construct all mechanical, structural, and organic assemblies using combinations of the **4 Universal Differential Geometric Operators**:

```
                       [THE 4 UNIVERSAL OPERATORS]
 ┌────────────────────────────────────────────────────────────────────────┐
 │ 1. SE(3) LIE GROUP CURVE SWEEPS                                        │
 │    Sweeps profile P(u, v) along 3D carrier curve C(t) with twist θ(t)  │
 │    and non-linear scale s(t). Generates roll cages, exhaust pipes,     │
 │    suspension arms, claw prongs, struts, coils, tentacles, trusses.    │
 ├────────────────────────────────────────────────────────────────────────┤
 │ 2. HARMONIC SOLIDS OF REVOLUTION                                       │
 │    Revolves radial profile r(z) about axis with K radial lobes and     │
 │    helical pitch. K=0: smooth flanges/housings; K=2-6: spiral drills,  │
 │    fluted columns; K>=12: brake cooling fins, cogs, splined hubs.      │
 ├────────────────────────────────────────────────────────────────────────┤
 │ 3. AFFINE METRIC REPLICATORS                                           │
 │    Distributes seed geometry along curves or 2D manifolds at continuous│
 │    pitch p. Generates bolt circles, fastener arrays, louver vanes,     │
 │    tread blocks, debris grilles, gripper teeth.                        │
 ├────────────────────────────────────────────────────────────────────────┤
 │ 4. ISOPARAMETRIC NORMAL RELIEF FIELDS                                  │
 │    Surface normal displacements Δh(u, v) n(u, v) along geodesic curves.│
 │    Generates panel shut lines, weld beads, knurling, expansion joints. │
 └────────────────────────────────────────────────────────────────────────┘
```

### Python Implementation Patterns

```python
import scratchbox as sb
import math

# 1. SE(3) Lie Group Curve Sweep (e.g. Aerodynamic Roll Cage / Suspension Arm)
carrier_curve = [
    [0.0, 0.2, 1.2],
    [0.4, 0.8, 0.4],
    [0.6, 1.1, -0.6],
    [0.5, 0.9, -1.8]
]
arm_mesh = sb.shaper.sweep_curve(
    carrier_curve,
    radius=0.04,
    radial_segments=16,
    taper_end=0.6,
    twist_rad=math.pi / 4.0
)

# 2. Harmonic Solid of Revolution (e.g. Fluted Turbine Hub / Drilled Rotor)
rotor_mesh = sb.shaper.harmonic_revolution(
    z_min=0.0,
    z_max=0.35,
    radial_profile=[0.4, 0.42, 0.38, 0.25],
    harmonic_lobes=16,          # 16 cooling vents / flutes
    harmonic_amplitude=0.015,
    helical_twist=0.5
)

# 3. Affine Metric Replicator (e.g. Hexagonal Wheel Bolt Circle)
bolt_seed = sb.mesh.create_cylinder(radius=0.012, height=0.02, segments=6)
bolt_array = sb.shaper.affine_replicate_circle(
    seed_mesh=bolt_seed,
    radius=0.15,
    count=6,
    axis="Z"
)

# 4. Isoparametric Normal Relief (e.g. Hood Panel Shut Line Groove)
sb.shaper.apply_normal_relief(
    chassis_mesh,
    curve_points=[[-0.5, 0.8, 0.6], [0.0, 0.82, 0.8], [0.5, 0.8, 0.6]],
    groove_width=0.008,
    groove_depth=-0.005
)
```

---

## 3. The 70-20-10 Geometric Form Hierarchy

Every asset generated through `execute_3d_python_script` must respect the 70-20-10 hierarchy and pass the `GeometricComplexityGate`:

- **70% Primary Edifice / Silhouette**: Proportions, bounding volumes, sculpted curvature, non-linear deformers (taper, bend, twist, FFD tensor lattice).
- **20% Secondary Articulated Assemblies**: Discrete functional sub-parts (diffusers, wings, hollow-spoke rims, brake discs, cockpit canopy, air intakes).
- **10% Tertiary Micro-Detail**: Panel shut lines, hex grilles, hood louvers, quad exhaust tips, mechanical fasteners, chamfers.
- **Complexity Gate Threshold**:
  - Generative scenes / vehicles: $\ge 25,000$ vertices, $\ge 15,000$ triangles, $\ge 3$ distinct submeshes.
  - Isolated props: $\ge 5,000$ vertices, $\ge 3,000$ triangles.

---

## 4. The 18% Studio Grey Clay Void & Staging Sequence

### Default CAD Void Baseline
When NO real-world geographic location is described in the initial prompt:
1. Construct hero assets in **18% Studio Grey Clay**:
   ```python
   clay_mat = sb.PbrMaterial.clay()  # roughness: 0.85, metalness: 0.0, albedo: [0.55, 0.57, 0.60]
   ```
2. Stage in a clean 3D void (`environment: { skybox: 'studio', lighting: 'studio', ground: false }`).
3. Follow-up suggestions MUST proceed strictly chronologically:
   - **1. Lighting & Atmosphere**: 3-point studio rim lighting, dusk twilight, or solar ephemeris.
   - **2. Staging & Contextual Placement (MANDATORY BEFORE TEXTURES)**: Real-world geographic staging with Google 3D Tiles Clay (`getGoogle3DTilesClay`) or Vector World Staging (`stage_3d_vector_world`).
   - **3. Textures & PBR Materials (Only After Staging)**: Deep automotive clearcoat, carbon fiber weave, brushed aluminum.

### Explicit Location Staging Invariant
When the user explicitly provides a real-world location (e.g., *"F1 car in Monaco"*, *"monument in Central Park"*):
- Provide `location` or `coordinates` directly to `execute_3d_python_script`:
  ```json
  {
    "script": "import scratchbox as sb\n...",
    "location": "Monaco GP Circuit, Monte Carlo",
    "coordinates": [43.7384, 7.4246]
  }
  ```
- The engine automatically extracts leaf-LOD 3D tile massing and positions the hero model directly on the real-world surface.

---

## 5. Complete Production Python Script Example

```python
import scratchbox as sb
import math

scene = sb.Scene()
clay_material = sb.PbrMaterial.clay()

# =========================================================================
# 70% PRIMARY EDIFICE: Sculpted Monocoque Chassis
# =========================================================================
chassis = sb.mesh.create_box(width=1.6, height=0.55, length=4.2, subdivisions=32)
# Apply non-linear aerodynamic tapering and belly bulge
sb.shaper.taper(chassis, factor=0.45, axis="Z", origin=[0, 0, 2.1])
sb.shaper.bulge(chassis, factor=0.25, radius=1.2, center=[0, 0, 0.2])
chassis.set_material(clay_material)
scene.add_mesh("Primary_Chassis", chassis)

# =========================================================================
# 20% SECONDARY ASSEMBLIES: Aerodynamic Wings & Wheel Assemblies
# =========================================================================
# Front splitter & rear diffuser
front_wing = sb.mesh.create_box(width=1.8, height=0.08, length=0.6, subdivisions=16)
sb.shaper.bend(front_wing, angle_deg=12.0, axis="Y")
front_wing.translate(0.0, -0.15, 1.9)
front_wing.set_material(clay_material)
scene.add_mesh("Front_Wing", front_wing)

# 4 Hollow-Spoke Wheels via Harmonic Solids of Revolution
for x_side, z_pos in [(-0.85, 1.4), (0.85, 1.4), (-0.88, -1.3), (0.88, -1.3)]:
    wheel = sb.shaper.harmonic_revolution(
        z_min=-0.16, z_max=0.16,
        radial_profile=[0.38, 0.40, 0.40, 0.38],
        harmonic_lobes=5,            # 5-spoke lightweight rim
        harmonic_amplitude=0.03
    )
    wheel.rotate_y(math.pi / 2.0)
    wheel.translate(x_side, 0.0, z_pos)
    wheel.set_material(clay_material)
    scene.add_mesh(f"Wheel_{x_side}_{z_pos}", wheel)

# =========================================================================
# 10% TERTIARY MICRO-DETAILS: Fasteners, Grilles & Exhaust Tips
# =========================================================================
# Affine Replicator: Hood cooling louver array
louver_blade = sb.mesh.create_box(width=0.4, height=0.015, length=0.04, subdivisions=4)
sb.shaper.taper(louver_blade, factor=0.7, axis="X")
louvers = sb.shaper.affine_replicate_linear(
    seed_mesh=louver_blade,
    direction=[0, 0, 1],
    pitch=0.06,
    count=8
)
louvers.translate(0.0, 0.32, 0.4)
louvers.set_material(clay_material)
scene.add_mesh("Hood_Louvers", louvers)

# Write binary glTF 2.0 (.glb)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
```
