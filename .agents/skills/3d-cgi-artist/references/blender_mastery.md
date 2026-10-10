# Blender Deep Mastery: Geometry Nodes, Python & Shading Systems

> *"Blender is not merely a DCC tool; with Geometry Nodes and bpy, it is a fully programmable procedural engine for visual geometry."*

---

## 1. Geometry Nodes Architecture & Mental Model

### 1.1 Fields vs Data Flow
- **Geometry Cable (Thick Green)**: Carries actual mesh, curve, point cloud, or instance data.
- **Field Cable (Dotted / Diamond Socket)**: Represents a **function / recipe** evaluated lazily per element (point, face, edge) on the geometry. It has no value until plugged into a geometry socket.

### 1.2 The Domain Hierarchy & Interpolation
Every attribute in Blender belongs to one of five domains:

```
[Point]        (Vertex: Position, Weight)
   │
[Edge]         (Line between two points)
   │
[Face]         (Polygon: Area, Center, Face Normal)
   │
[Corner]       (Loop: UV Coordinate, Split Normal, Vertex Color)
   │
[Instance]     (Transform matrix referencing another object)
```

**Domain Interpolation Rule**: If you plug a `Face Normal` (Face domain) into a node operating on the `Corner` domain, Blender automatically averages the adjacent face data. To preserve sharp boundaries across seams, evaluate directly within the `Face Corner` domain.

---

### 1.3 Essential Geometry Nodes Recipes

#### Recipe A: Projecting Props onto Uneven Terrain with Normal Alignment
```
[Terrain Geometry] ──> [Raycast (Target Geometry)]
                           ^
[Instance Points] ─────────┘ (Ray Direction = (0, 0, -1))
                           │
       ┌───────────────────┴────────────────────────┐
       │ Hit Position ──> Set Position (Points)     │
       │ Hit Normal   ──> Align Euler to Vector     │
       │                  (Vector = Hit Normal)     │
       │                  (Axis = Z)                │
       │                  ──> Instance on Points    │
       └────────────────────────────────────────────┘
```
- **Hit Normal**: Aligns trees, rocks, or debris flush with the slope.
- **Random Value (Float)** $\rightarrow$ plugged into `Rotation Z` prevents repetitive orientation.

#### Recipe B: Procedural Cables / Pipes with Sagging Catenary Curve
1. Create a `Mesh Line` between Point A and Point B.
2. Convert `Mesh to Curve`.
3. Add `Set Position`:
   $$Z_{\text{offset}} = -4 \cdot \text{SagStrength} \cdot \text{Factor} \cdot (1.0 - \text{Factor})$$
   *(Where $\text{Factor}$ is the curve parameter from $0.0$ to $1.0$. This yields a true parabolic catenary curve).*
4. Plug into `Curve to Mesh` with a `Curve Circle` profile.

---

## 2. Python Automation (`bpy` & `bmesh`)

Direct access to the underlying mesh data structure without UI overhead.

### 2.1 The `bmesh` Module vs `bpy.data.meshes`
- `bpy.data.meshes`: Fast read-only or bulk array assignment. Editing geometry requires slow UI operator calls (`bpy.ops`).
- `bmesh`: High-performance half-edge data structure for procedural geometry generation, slicing, and normal editing.

### 2.2 Production Script: Batch Fixing Flipped Normals & Loose Vertices
```python
import bpy
import bmesh

def clean_and_fix_mesh(obj):
    if obj.type != 'MESH':
        return
    
    # Ensure object mode
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='OBJECT')
    
    # Create BMesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    
    # 1. Remove doubles (merge coincident vertices)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
    
    # 2. Dissolve degenerate/zero-area faces
    bmesh.ops.dissolve_degenerate(bm, dist=0.0001, edges=bm.edges)
    
    # 3. Recalculate face normals outside
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    
    # Push back to mesh data
    bm.to_mesh(obj.data)
    bm.free()
    
    # 4. Enable Auto-Smooth & apply Weighted Normal modifier
    obj.data.use_auto_smooth = True
    obj.data.auto_smooth_angle = 1.0472  # 60 degrees in radians
    
    wn = obj.modifiers.new(name="WeightedNormal", type='WEIGHTED_NORMAL')
    wn.keep_sharp = True
    wn.weight = 100
    
    print(f"Cleaned and fixed: {obj.name}")

# Run on selected objects
for selected in bpy.context.selected_objects:
    clean_and_fix_mesh(selected)
```

---

## 3. Shader Nodes Wizardry & Ray Tuning

### 3.1 The Light Path Node: The Ultimate Render Optimizer
Cycles path tracing wastes compute rays bouncing through glass, shadows, and reflections that the human eye cannot perceive.

```
[Light Path]
  ├─ Is Camera Ray    ──> Mix Shader Factor
  ├─ Is Shadow Ray
  ├─ Is Diffuse Ray
  └─ Is Glossy Ray
```

#### Performance Cheats:
1. **Architectural Glass Optimization (No Noise)**:
   - Mix a `Glass BSDF` with a `Transparent BSDF`.
   - Plug `Is Shadow Ray` into the Factor.
   - **Result**: Sunlight passes directly through window glass into the room as direct light without generating thousands of noisy caustics rays!
2. **Invisible Light Blocker / Shadow Caster**:
   - Mix an opaque `Diffuse BSDF` with a `Transparent BSDF`.
   - Plug `Is Camera Ray` into Factor (inverted).
   - **Result**: Casts crisp shadows onto the scene, but is 100% invisible to the camera.

---

### 3.2 Non-Photorealistic Rendering (NPR) with `Shader to RGB`
In Eevee / Eevee Next, the `Shader to RGB` node allows extracting raw diffuse/specular lighting energy into a pure color vector:
```
[Diffuse BSDF] ──> [Shader to RGB] ──> [ColorRamp (Constant)] ──> [Emission]
```
- Set `ColorRamp` interpolation to **Constant**.
- Step 0 ($0.0$): Dark shadow tone (ambient occlusion tint).
- Step 1 ($0.3$): Mid-tone shading.
- Step 2 ($0.7$): Bright highlight tone.
- **Result**: High-end Studio Ghibli or Arcane anime shading with hard graphic shadow bands.

---

## 4. Modifier Stack Secrets

### 4.1 Boolean Epsilon Hack (Fixing Coplanar Glitches)
When two faces are mathematically co-planar (e.g. cutting a hole in a wall where cutter and wall share $Z = 0$), the Exact Boolean solver encounters a floating-point singularity and fails, leaving messy non-manifold holes.

#### The Hack:
Add a `Displace` or `Transform` modifier to the boolean cutter with an offset of $0.0001\text{m}$ (one-tenth of a millimeter). The solver becomes instantly stable.

### 4.2 Bevel Modifier Without Geometry (Render-Time Bevels)
Instead of adding bevel edge loops to every single prop:
1. In the material, add an **Input $\rightarrow$ Bevel** node.
2. Set radius to $0.005\text{m}$ (5mm).
3. Plug into the `Normal` input of the Principled BSDF.
4. **Result**: Cycles and Eevee Next smooth the geometric edge at render time as if it were beveled, saving hundreds of thousands of polygons while retaining gorgeous specular edge highlights.
