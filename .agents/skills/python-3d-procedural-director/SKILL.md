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
  - sb.rig       (SB-Rig: skeleton + skin weights for any mesh)
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

Every example in this file runs as-is in `execute_3d_python_script` (checked by `packages/core/test/skill-guide-examples.test.ts`).

```python
import scratchbox as sb

# 1. SE(3) Lie Group Curve Sweep (e.g. Suspension Arm / Hose / Tentacle)
arm = sb.sweep_curve_profile(
    path=[(0.0, 0.2, 1.2), (0.4, 0.8, 0.4), (0.6, 1.1, -0.6), (0.5, 0.9, -1.8)],
    profile="CIRCULAR",
    profile_dimensions=(0.04, 0.04),
    scale_taper=(1.0, 0.6),      # radius scale at start, end
    twist_deg=45.0
)

# 2. Harmonic Solid of Revolution (e.g. Fluted Turbine Hub): profile_curve is (height, radius) pairs
rotor = sb.revolve_harmonic_solid(
    profile_curve=[(0.0, 0.40), (0.12, 0.42), (0.24, 0.38), (0.35, 0.25)],
    harmonic_lobe_count=16,      # 16 cooling flutes; 0 = smooth turning
    harmonic_depth_ratio=0.04,
    helix_pitch_meters=0.5       # 0 = straight flutes
)

# 3. Affine Metric Replicator (e.g. Wheel Bolt Circle)
# POLAR_RING guide_points = [center, ring normal, a point on the ring]; CURVE_1D = a polyline
bolts = sb.replicate_metric_array(
    distribution_mode="POLAR_RING",
    guide_points=[(0.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.15, 0.0, 0.0)],
    pitch_meters=0.157,          # about 6 bolts on a 0.15 m radius
    seed_geometry={"shape": "CYLINDRICAL_FASTENER", "dimensions": (0.012, 0.02, 0.02)}
)

# 4. Normal Relief (surface micro-detail): displace a densely tessellated surface along its normals.
# There is no curve-guided groove operator yet; shut lines need their own geometry (e.g. thin sweeps).
panel = sb.create_plane(width=1.0, height=0.6, seg_x=128, seg_y=80)
panel.displace_along_normals(frequency=24.0, amplitude=0.004)

scene = sb.Scene()
for part in (arm, rotor, bolts, panel):
    part.set_material(sb.PbrMaterial.clay())
    scene.add_mesh(part)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
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

def add(mesh, name):
    mesh.name = name
    mesh.set_material(clay_material)
    scene.add_mesh(mesh)

# =========================================================================
# 70% PRIMARY EDIFICE: Sculpted Monocoque Chassis
# =========================================================================
chassis = sb.create_box(width=1.6, height=0.55, depth=4.2)
chassis.subdivide(6)                               # deformers need vertices to bend
# Non-linear deformers take integer axes: 0 = X, 1 = Y, 2 = Z
sb.shaper.taper(chassis, axis=2, factor=0.45)
sb.shaper.bulge(chassis, center=sb.math.Vec3(0.0, 0.0, 0.2), radius=1.2, strength=0.25)
add(chassis, "Primary_Chassis")

# =========================================================================
# 20% SECONDARY ASSEMBLIES: Aerodynamic Wings & Wheel Assemblies
# =========================================================================
front_wing = sb.create_box(width=1.8, height=0.08, depth=0.6)
front_wing.subdivide(4)
sb.shaper.bend(front_wing, main_axis=0, bend_axis=1, angle_deg=12.0, radius=2.0)
front_wing.translate(0.0, -0.15, 1.9)
add(front_wing, "Front_Wing")

# 4 five-lobe rims via Harmonic Solids of Revolution, revolved around the X (axle) axis
for x_side, z_pos in [(-0.85, 1.4), (0.85, 1.4), (-0.88, -1.3), (0.88, -1.3)]:
    wheel = sb.revolve_harmonic_solid(
        axis=(1.0, 0.0, 0.0),
        profile_curve=[(-0.16, 0.38), (-0.08, 0.40), (0.08, 0.40), (0.16, 0.38)],
        harmonic_lobe_count=5,
        harmonic_depth_ratio=0.08
    )
    wheel.translate(x_side, 0.0, z_pos)
    add(wheel, f"Wheel_{x_side}_{z_pos}")

# =========================================================================
# 10% TERTIARY MICRO-DETAILS: Hood Louvers
# =========================================================================
# Affine Replicator: tilted louver vanes every 6 cm along a line over the hood
louvers = sb.replicate_metric_array(
    distribution_mode="CURVE_1D",
    guide_points=[(0.0, 0.32, 0.1), (0.0, 0.32, 0.6)],
    pitch_meters=0.06,
    seed_geometry={"shape": "ANGLED_LOUVER_VANE", "dimensions": (0.4, 0.015, 0.04), "tiltAngleDeg": 20.0}
)
add(louvers, "Hood_Louvers")

# Write binary glTF 2.0 (.glb)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
```

---

## 6. Rigging Any Mesh with `sb.rig` (SB-Rig)

`sb.rig` discovers a joint tree and 4-bone skin weights from a mesh's geometry alone (hands, creatures, tentacles, branching props); there is no preset skeleton and no Blender. Full reference: `docs/processes/sb-rig-auto-rigger.md`.

```python
import math
import scratchbox as sb
from scratchbox_native.math import Vec3, Vec4

# A bent, knobbly tube (lofted rings along a quarter arc) stands in for a tail or tentacle.
slices = []
for i in range(121):
    t = i / 120.0
    a = t * math.pi / 2
    centre = Vec3((1 - math.cos(a)) * 3.0, math.sin(a) * 3.0, 0.0)
    nx, ny = -math.cos(a), math.sin(a)
    r = 0.35 + 0.08 * math.sin(t * math.pi * 6)
    slices.append([Vec3(centre.x + nx * r * math.cos(p), centre.y + ny * r * math.cos(p), r * math.sin(p))
                   for p in (2 * math.pi * k / 48 for k in range(48))])
mesh = sb.geometry.create_loft(slices, True, Vec4(0.55, 0.57, 0.6, 1.0))

# In-memory mesh -> skinned .glb bytes
params = sb.rig.Params()
params.root_hint = (0.0, 0.0, 0.0)               # start the hierarchy at the tube's base
result = sb.rig.solve(mesh, params)
result.rename({"Chain1": "Tail", "Root": "TailBase"})   # chain name -> Tail1..n, or exact joint names
open(OUTPUT_GLB_PATH, "wb").write(sb.rig.export_skinned_glb_bytes(mesh, result))

# Existing .glb file (textures, UVs and materials are carried over byte for byte)
sb.io.write_glb("tail.glb", mesh)
p = sb.rig.Params()
p.root_hint = (0.0, 0.0, 0.0)
# p.chain_hints = [[(x, y, z), ...]]            # optional: trace a limb the solver misses, e.g. a digit fused to the body
file_result = sb.rig.rig_glb("tail.glb", "tail_rigged.glb", p, {"Chain1": "Tail"}, "tail.sbrig.json")
print(file_result, file_result.chains)            # read chain end positions, then rename / add hints
```
