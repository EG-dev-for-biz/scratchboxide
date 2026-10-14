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

def place_on_ground(mesh, x):
    """Stand a showcase part on the plinth top (y = 0) at x, so the whole display is one structure."""
    b = mesh.bounds
    mesh.translate(x - (b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2)

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

# 3. Affine Metric Replicator (e.g. Bolt Circle on a Flange)
# POLAR_RING guide_points = [center, ring normal, a point on the ring]; CURVE_1D = a polyline
flange = sb.create_cylinder(radius=0.2, height=0.02, segments=64)
bolts = sb.replicate_metric_array(
    distribution_mode="POLAR_RING",
    guide_points=[(0.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.15, 0.0, 0.0)],
    pitch_meters=0.157,          # about 6 bolts on a 0.15 m radius
    seed_geometry=sb.create_cylinder(radius=0.012, height=0.03, segments=12)   # any mesh built around the origin
)
flange.append(bolts)             # the 3 cm bolts pass through the 2 cm flange

# 4. Normal Relief (surface micro-detail): displace a densely tessellated surface along its normals.
# There is no curve-guided groove operator yet; shut lines need their own geometry (e.g. thin sweeps).
panel = sb.create_plane(width=1.0, height=0.6, seg_x=128, seg_y=80)
panel.displace_along_normals(frequency=24.0, amplitude=0.004)

scene = sb.Scene()
# A display plinth under all four samples; its top is y = 0, where place_on_ground stands each part.
plinth = sb.create_box(width=5.2, height=0.05, depth=4.0)
plinth.translate(1.9, -0.025, 0.0)
plinth.set_material(sb.PbrMaterial.clay())
scene.add_mesh(plinth)
for x, part in zip((0.0, 1.4, 2.6, 3.8), (arm, rotor, flange, panel)):
    place_on_ground(part, x)
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

### Assemblies: Build Between Joints, Never by Rotating Guesswork

Parts that must meet (legs, rungs, frames, struts, rails, brackets) go wrong when each one is built at the origin and then rotated and offset by hand-computed amounts: legs lean the wrong way and rungs float a few centimetres from the legs. Build them from the joints instead:

1. Compute every joint point once (seat sockets, feet, rail ends).
2. Build each member between two joints with `sb.sweep_curve_profile(path=[start, end], profile_dimensions=(r, r))`.
3. Take a connecting member's ends from points on the members it joins (`lerp(top, foot, t)`), and run ends slightly into what they meet, so they attach by construction.

`execute_3d_python_script` checks every result: parts that touch nothing are returned in `structuralIssues` and must be fixed before finishing.

```python
import scratchbox as sb

# Joint-first assembly: compute the points where members meet once, then build every member between them.
SEAT_Y, SEAT_T = 0.46, 0.04
TOP_R, FOOT_R = 0.11, 0.17            # feet sit farther out than the sockets, so the legs splay outward
DIAG = 0.7071
CORNERS = [(1, 1), (1, -1), (-1, -1), (-1, 1)]

def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))

tops = [(sx * TOP_R * DIAG, SEAT_Y + 0.015, sz * TOP_R * DIAG) for sx, sz in CORNERS]   # 1.5 cm into the seat
feet = [(sx * FOOT_R * DIAG, 0.0, sz * FOOT_R * DIAG) for sx, sz in CORNERS]

scene = sb.Scene()
clay = sb.PbrMaterial.clay()

def add(mesh, name):
    mesh.name = name
    mesh.set_material(clay)
    scene.add_mesh(mesh)

seat = sb.create_cylinder(radius=0.17, height=SEAT_T, segments=96)
seat.translate(0.0, SEAT_Y + SEAT_T / 2, 0.0)
seat.weld_vertices()                  # cylinder caps arrive unwelded; subdividing them separately tears the rim
seat.subdivide(2)
add(seat, "seat")

for i, (top, foot) in enumerate(zip(tops, feet)):
    leg = sb.sweep_curve_profile(path=[top, foot], profile_dimensions=(0.018, 0.018), scale_taper=(1.0, 0.8))
    leg.subdivide(3)
    add(leg, f"leg_{i}")

# Rungs run between points ON the leg centrelines, so their ends sit inside the legs by construction.
for i in range(4):
    j = (i + 1) % 4
    t = 0.62 if i % 2 == 0 else 0.72      # stagger heights so rungs do not collide at the legs
    rung = sb.sweep_curve_profile(path=[lerp(tops[i], feet[i], t), lerp(tops[j], feet[j], t)], profile_dimensions=(0.011, 0.011))
    rung.subdivide(3)
    add(rung, f"rung_{i}")

sb.io.write_glb(OUTPUT_GLB_PATH, scene)
```

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
import array
import scratchbox as sb

scene = sb.Scene()
clay_material = sb.PbrMaterial.clay()

def add(mesh, name):
    mesh.name = name
    mesh.set_material(clay_material)
    scene.add_mesh(mesh)

# Joint points shared by the parts that meet there.
AXLES_Z = (1.4, -1.3)
TRACK_HALF = 0.86                      # wheel centres sit at x = +/-TRACK_HALF on each axle

# =========================================================================
# 70% PRIMARY EDIFICE: Sculpted Monocoque Chassis
# =========================================================================
chassis = sb.create_box(width=1.6, height=0.55, depth=4.2)
chassis.weld_vertices()                # box faces arrive unwelded; subdividing them separately opens cracks
chassis.subdivide(6)                   # deformers need vertices to bend
# Non-linear deformers take integer axes: 0 = X, 1 = Y, 2 = Z
sb.shaper.taper(chassis, axis=2, factor=0.45)
sb.shaper.bulge(chassis, center=sb.math.Vec3(0.0, 0.0, 0.2), radius=1.2, strength=0.25)
add(chassis, "Primary_Chassis")

# =========================================================================
# 20% SECONDARY ASSEMBLIES: Axles, Wheels and a Strut-Hung Front Wing
# =========================================================================
for z in AXLES_Z:
    # The axle passes through the chassis; the wheels are centred on its ends, so all three are joined.
    add(sb.sweep_curve_profile(path=[(-TRACK_HALF, 0.0, z), (TRACK_HALF, 0.0, z)], profile_dimensions=(0.05, 0.05)), f"Axle_{z}")
    for x in (-TRACK_HALF, TRACK_HALF):
        wheel = sb.revolve_harmonic_solid(
            axis=(1.0, 0.0, 0.0),
            # (height, radius) pairs; the 0-radius ends close the wheel into a solid with a hub
            profile_curve=[(-0.16, 0.0), (-0.16, 0.38), (-0.08, 0.40), (0.08, 0.40), (0.16, 0.38), (0.16, 0.0)],
            harmonic_lobe_count=5,
            harmonic_depth_ratio=0.08
        )
        wheel.translate(x, 0.0, z)
        add(wheel, f"Wheel_{x}_{z}")

# Subdivision rounds and shrinks the box, and the taper narrows the nose, so read the deformed
# chassis back instead of assuming its original size.
pos = array.array("f", chassis.get_positions_flat())   # float32 xyz triples, returned as bytes

def surface_y(x_half, z_lo, z_hi, top=True):
    ys = [pos[i + 1] for i in range(0, len(pos), 3) if abs(pos[i]) < x_half and z_lo <= pos[i + 2] <= z_hi]
    return max(ys) if top else min(ys)

WING_Z = 1.5
nose_bottom = surface_y(0.1, WING_Z - 0.05, WING_Z + 0.05, top=False)
wing_y = nose_bottom - 0.12
front_wing = sb.create_box(width=1.0, height=0.06, depth=0.4)
front_wing.weld_vertices()
front_wing.subdivide(4)
front_wing.translate(0.0, wing_y, WING_Z)
add(front_wing, "Front_Wing")
for x in (-0.1, 0.1):
    # Struts run from inside the wing up into the chassis nose.
    add(sb.sweep_curve_profile(path=[(x, wing_y, WING_Z), (x, nose_bottom + 0.03, WING_Z)], profile_dimensions=(0.02, 0.02)), f"Wing_Strut_{x}")

# =========================================================================
# 10% TERTIARY MICRO-DETAILS: Hood Louvers on the Real Hood Surface
# =========================================================================
# Sit the vanes on the lowest point of the hood they span, so every vane meets the surface.
vane_z = [0.1 + 0.06 * i for i in range(9)]
hood_y = min(surface_y(0.2, z - 0.03, z + 0.03) for z in vane_z) - 0.005
louvers = sb.replicate_metric_array(
    distribution_mode="CURVE_1D",
    guide_points=[(0.0, hood_y, vane_z[0]), (0.0, hood_y, vane_z[-1] + 0.06)],
    pitch_meters=0.06,
    seed_geometry=sb.create_beveled_box((0.4, 0.015, 0.04), bevel=0.002).rotate_x(20.0)   # one tilted vane, copied
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
