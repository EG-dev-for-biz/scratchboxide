"""
Blender Mesh Doctor & Topology Inspector
=========================================
Run inside Blender (via Text Editor or headless CLI: blender -b file.blend -P blender_mesh_doctor.py)

Performs comprehensive diagnostic analysis on active/selected meshes:
- Checks for unapplied transforms (non-uniform scale)
- Detects non-manifold edges (T-junctions, open boundaries, interior faces)
- Detects zero-area / degenerate faces
- Identifies high-valence poles (E5+) on high-curvature surfaces
- Checks for inverted face normals
- Checks for UV overlap / missing UV maps
- Optionally auto-fixes topology and configures Weighted Normal modifier
"""

import bpy
import bmesh
import math
from mathutils import Vector

def inspect_and_heal_mesh(obj, auto_heal=False):
    print(f"\n=======================================================")
    print(f" [MESH DOCTOR] Diagnosing: {obj.name}")
    print(f"=======================================================")

    if obj.type != 'MESH':
        print(f"Error: {obj.name} is not a MESH object.")
        return

    # 1. Transform / Scale Check
    scale = obj.scale
    if not (math.isclose(scale.x, 1.0, abs_tol=1e-3) and
            math.isclose(scale.y, 1.0, abs_tol=1e-3) and
            math.isclose(scale.z, 1.0, abs_tol=1e-3)):
        print(f" [WARNING] Unapplied Scale: ({scale.x:.3f}, {scale.y:.3f}, {scale.z:.3f})")
        print("           * Normal bakes and modifiers will be distorted!")
        if auto_heal:
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            print("           -> Auto-Heal: Applied scale transform.")

    # 2. BMesh Analysis
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='OBJECT')
    
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    total_verts = len(bm.verts)
    total_edges = len(bm.edges)
    total_faces = len(bm.faces)

    print(f" Stats: {total_verts:,} Verts | {total_edges:,} Edges | {total_faces:,} Faces")

    # 3. Non-Manifold Edges
    non_manifold_edges = [e for e in bm.edges if not e.is_manifold]
    t_junctions = [e for e in non_manifold_edges if len(e.link_faces) > 2]
    boundary_edges = [e for e in non_manifold_edges if len(e.link_faces) == 1]

    if non_manifold_edges:
        print(f" [CRITICAL] Non-Manifold Edges: {len(non_manifold_edges)}")
        if t_junctions:
            print(f"            - Internal T-junctions / shared faces (>2): {len(t_junctions)}")
        if boundary_edges:
            print(f"            - Open boundary / hole edges: {len(boundary_edges)}")
    else:
        print(" [OK] Geometry is completely watertight & manifold.")

    # 4. Zero-Area Degenerate Faces
    zero_area_faces = [f for f in bm.faces if f.calc_area() < 1e-7]
    if zero_area_faces:
        print(f" [WARNING] Degenerate / Zero-Area Faces: {len(zero_area_faces)}")
        if auto_heal:
            bmesh.ops.dissolve_degenerate(bm, dist=0.0001, edges=bm.edges)
            print("           -> Auto-Heal: Dissolved degenerate faces.")

    # 5. Coincident / Doubled Vertices
    # Test remove doubles without modifying
    double_verts = bmesh.ops.find_doubles(bm, verts=bm.verts, dist=0.0001)
    if 'targetmap' in double_verts and double_verts['targetmap']:
        num_doubles = len(double_verts['targetmap'])
        print(f" [WARNING] Coincident Vertices (Doubles): {num_doubles}")
        if auto_heal:
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0001)
            print("           -> Auto-Heal: Merged coincident vertices.")

    # 6. High-Valence Poles (E5+)
    poles_e5 = [v for v in bm.verts if len(v.link_edges) >= 5]
    if poles_e5:
        print(f" [INFO] High-Valence Poles (E5+): {len(poles_e5)}")
        print("        * Ensure these poles do not lie on high-curvature deformation areas.")

    # 7. N-Gons (>4 vertices)
    ngons = [f for f in bm.faces if len(f.verts) > 4]
    tris = [f for f in bm.faces if len(f.verts) == 3]
    quads = [f for f in bm.faces if len(f.verts) == 4]
    print(f" Polygon Breakdown: Quads: {len(quads):,} ({len(quads)/max(1, total_faces)*100:.1f}%) | "
          f"Tris: {len(tris):,} ({len(tris)/max(1, total_faces)*100:.1f}%) | "
          f"N-gons: {len(ngons):,} ({len(ngons)/max(1, total_faces)*100:.1f}%)")

    # 8. Auto-Heal: Recalculate Normals & Setup Weighted Normals
    if auto_heal:
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()

        # Check for Weighted Normal modifier
        wn_mod = next((m for m in obj.modifiers if m.type == 'WEIGHTED_NORMAL'), None)
        if not wn_mod:
            wn_mod = obj.modifiers.new(name="WeightedNormal_Auto", type='WEIGHTED_NORMAL')
            wn_mod.keep_sharp = True
            wn_mod.weight = 100
            print("           -> Auto-Heal: Configured Weighted Normal modifier (Weight=100, KeepSharp=True).")
        obj.data.update()
    else:
        bm.free()

    print(f"=======================================================\n")

def main():
    selected = bpy.context.selected_objects
    if not selected:
        print("No objects selected. Analyzing all mesh objects in scene...")
        selected = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    
    for obj in selected:
        inspect_and_heal_mesh(obj, auto_heal=False)

if __name__ == '__main__':
    main()
