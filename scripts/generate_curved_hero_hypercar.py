#!/usr/bin/env python3
"""
Procedural Aerodynamic Curvature Hypercar Generator (C++ Engine / Python SDK).
Demonstrates continuous compound curvature modeling via:
1. Transverse Profile Lofting (Station Curves / Superellipses) for aerodynamic monocoque
2. Rotational Lathe Profiles for wheels, concave rims, and exhaust nozzles
3. Parametric Spline Tubes for roll bars, aero strakes, and suspension wishbones
4. Filleted Chamfers on wings, splitters, and diffusers
5. Smooth Vertex Normals and 18% Studio Grey Clay PBR Material
"""

import math
import os
import sys

import scratchbox as sb
from scratchbox import math as sbm
from scratchbox import geometry as sbg
from scratchbox import io as sbio


def build_superellipse(cx, cy, cz, width, height, n_pts=32, top_curvature=1.2, bot_curvature=0.6, flatten_bot=True):
    """
    Evaluates an aerodynamic superellipse cross section at a given Z station.
    top_curvature controls the dome curvature; bot_curvature controls flat floor underbody.
    """
    pts = []
    rx = width * 0.5
    ry = height * 0.5
    for i in range(n_pts):
        angle = (i / n_pts) * 2.0 * math.pi
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        
        # Upper vs lower profile shaping
        if sin_a >= 0:
            # Roof / hood dome
            px = cx + math.copysign(abs(cos_a) ** (1.0 / top_curvature) * rx, cos_a)
            py = cy + (abs(sin_a) ** (1.0 / top_curvature)) * ry
        else:
            # Flat aerodynamic underbody with slight corner radiusing
            if flatten_bot:
                px = cx + math.copysign(abs(cos_a) ** (1.0 / bot_curvature) * rx, cos_a)
                py = cy - (abs(sin_a) ** (1.0 / bot_curvature)) * (ry * 0.4)
            else:
                px = cx + math.copysign(abs(cos_a) ** (1.0 / bot_curvature) * rx, cos_a)
                py = cy - (abs(sin_a) ** (1.0 / bot_curvature)) * ry
        pts.append((px, py, cz))
    return pts


def loft_slices(mesh, slices, close_ends=True, color=(0.55, 0.57, 0.60, 1.0)):
    """Skins a quad-strip surface between consecutive closed 3D loops."""
    n_slices = len(slices)
    if n_slices < 2:
        return
    pts_per_slice = len(slices[0])
    
    start_vidx = mesh.vertex_count
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    # 1. Add all vertices
    for s_idx, slice_pts in enumerate(slices):
        v_coord = s_idx / (n_slices - 1)
        for p_idx, (x, y, z) in enumerate(slice_pts):
            u_coord = p_idx / pts_per_slice
            mesh.add_vertex(
                sbm.Vec3(x, y, z),
                sbm.Vec3(0, 1, 0),
                sbm.Vec2(u_coord, v_coord),
                col
            )
            
    # 2. Add quad strips
    for s_idx in range(n_slices - 1):
        s0 = start_vidx + s_idx * pts_per_slice
        s1 = start_vidx + (s_idx + 1) * pts_per_slice
        for p_idx in range(pts_per_slice):
            next_p = (p_idx + 1) % pts_per_slice
            i0 = s0 + p_idx
            i1 = s1 + p_idx
            i2 = s1 + next_p
            i3 = s0 + next_p
            
            mesh.add_triangle(i0, i1, i2)
            mesh.add_triangle(i0, i2, i3)
            
    # 3. Optional end caps
    if close_ends:
        # Front cap
        front_center = sbm.Vec3(
            sum(p[0] for p in slices[0]) / pts_per_slice,
            sum(p[1] for p in slices[0]) / pts_per_slice,
            sum(p[2] for p in slices[0]) / pts_per_slice
        )
        c_front_idx = mesh.vertex_count
        mesh.add_vertex(front_center, sbm.Vec3(0, 0, -1), sbm.Vec2(0.5, 0.5), col)
        s0 = start_vidx
        for p_idx in range(pts_per_slice):
            next_p = (p_idx + 1) % pts_per_slice
            mesh.add_triangle(c_front_idx, s0 + next_p, s0 + p_idx)
            
        # Rear cap
        last_s = slices[-1]
        rear_center = sbm.Vec3(
            sum(p[0] for p in last_s) / pts_per_slice,
            sum(p[1] for p in last_s) / pts_per_slice,
            sum(p[2] for p in last_s) / pts_per_slice
        )
        c_rear_idx = mesh.vertex_count
        mesh.add_vertex(rear_center, sbm.Vec3(0, 0, 1), sbm.Vec2(0.5, 0.5), col)
        s_last = start_vidx + (n_slices - 1) * pts_per_slice
        for p_idx in range(pts_per_slice):
            next_p = (p_idx + 1) % pts_per_slice
            mesh.add_triangle(c_rear_idx, s_last + p_idx, s_last + next_p)


def lathe_profile(mesh, profile_pts, radial_segs=24, color=(0.55, 0.57, 0.60, 1.0)):
    """Revolves a 2D profile (radius, y) around the Y-axis to form a rotational solid."""
    start_vidx = mesh.vertex_count
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    n_pts = len(profile_pts)
    
    for r in range(radial_segs):
        angle = (r / radial_segs) * 2.0 * math.pi
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        for p_idx, (rad, y) in enumerate(profile_pts):
            px = rad * cos_a
            pz = rad * sin_a
            py = y
            norm = sbm.Vec3(cos_a, 0.0, sin_a)
            mesh.add_vertex(sbm.Vec3(px, py, pz), norm, sbm.Vec2(r / radial_segs, p_idx / (n_pts - 1)), col)
            
    for r in range(radial_segs):
        next_r = (r + 1) % radial_segs
        s0 = start_vidx + r * n_pts
        s1 = start_vidx + next_r * n_pts
        for p in range(n_pts - 1):
            i0 = s0 + p
            i1 = s1 + p
            i2 = s1 + (p + 1)
            i3 = s0 + (p + 1)
            mesh.add_triangle(i0, i1, i2)
            mesh.add_triangle(i0, i2, i3)


def generate_curved_hero_hypercar():
    print("Synthesizing Continuous Curvature Aerodynamic Hypercar...")
    clay_mat = sbg.PbrMaterial.clay(roughness=0.85, metalness=0.0)
    clay_col = (0.55, 0.57, 0.60, 1.0)
    
    hypercar = sbg.Mesh("CurvedHeroHypercar")
    hypercar.apply_material(clay_mat)
    
    # =========================================================================
    # 1. PRIMARY MONOCOQUE BODY (Lofted along 18 Station Slices)
    # =========================================================================
    # Total car length: 4.4 meters (Z from -2.2m front splitter to +2.2m rear diffuser)
    # The car width dynamically swells over wheel arches and pinches at the cockpit waist.
    body_slices = []
    stations = [
        # (z, width, height, y_center, top_curv, bot_curv)
        (-2.20, 1.30, 0.08, 0.16, 1.8, 0.5), # 0: Front Splitter Leading Tip
        (-2.00, 1.55, 0.14, 0.19, 1.6, 0.6), # 1: Low-profile Nose Cone
        (-1.65, 1.82, 0.24, 0.24, 1.4, 0.7), # 2: Front Hood Base & Center Extraction Vent
        (-1.30, 1.96, 0.38, 0.32, 1.3, 0.8), # 3: Front Wheel Arch Apex (Flared Crest)
        (-0.95, 1.90, 0.44, 0.36, 1.3, 0.8), # 4: Hood Trailing Edge & Wiper Cowl
        (-0.60, 1.68, 0.72, 0.54, 1.5, 0.8), # 5: A-Pillar Base & Windshield Rake
        (-0.25, 1.50, 0.94, 0.66, 1.6, 0.9), # 6: Windshield Crest / Cockpit Entrance
        ( 0.10, 1.44, 0.98, 0.68, 1.7, 0.9), # 7: Maximum Roof Apex (Teardrop Canopy)
        ( 0.45, 1.48, 0.92, 0.65, 1.6, 0.9), # 8: B-Pillar Tumblehome & Pinched Waist
        ( 0.80, 1.70, 0.78, 0.58, 1.4, 0.8), # 9: Fastback Sloping Rear Screen & Engine Deck
        ( 1.15, 1.94, 0.66, 0.52, 1.3, 0.8), # 10: Side Air Intake Scoops & Rear Haunch Start
        ( 1.50, 2.02, 0.58, 0.48, 1.2, 0.7), # 11: Rear Wheel Arch Muscular Haunch Apex
        ( 1.75, 1.95, 0.50, 0.44, 1.2, 0.6), # 12: Rear Deck Taper
        ( 1.95, 1.82, 0.42, 0.40, 1.3, 0.5), # 13: Integrated Rear Spoiler Crest
        ( 2.10, 1.72, 0.34, 0.36, 1.4, 0.4), # 14: Truncated Kamm-Tail Fascia
        ( 2.20, 1.64, 0.28, 0.32, 1.5, 0.3), # 15: Rear Diffuser Exit
    ]
    
    n_pts_body = 32
    for (z, w, h, yc, tc, bc) in stations:
        body_slices.append(build_superellipse(0.0, yc, z, w, h, n_pts=n_pts_body, top_curvature=tc, bot_curvature=bc))
        
    loft_slices(hypercar, body_slices, close_ends=True, color=clay_col)
    
    # =========================================================================
    # 2. COCKPIT CANOPY BUBBLE (Faceted Glass Dome with Fillet Blend)
    # =========================================================================
    canopy_slices = []
    canopy_stations = [
        (-0.70, 0.95, 0.10, 0.50),
        (-0.40, 1.10, 0.38, 0.68),
        (-0.05, 1.18, 0.48, 0.75),
        ( 0.30, 1.15, 0.46, 0.74),
        ( 0.65, 1.05, 0.34, 0.68),
        ( 0.95, 0.85, 0.12, 0.58),
    ]
    for (cz, cw, ch, cyc) in canopy_stations:
        canopy_slices.append(build_superellipse(0.0, cyc, cz, cw, ch, n_pts=24, top_curvature=1.8, bot_curvature=1.0, flatten_bot=False))
    loft_slices(hypercar, canopy_slices, close_ends=True, color=(0.58, 0.60, 0.63, 1.0))
    
    # =========================================================================
    # 3. AERODYNAMIC FRONT SPLITTER & CURVED ENDPLATES
    # =========================================================================
    splitter_slices = []
    for sz in [-2.32, -2.25, -2.15, -1.95]:
        sw = 1.65 + (-sz - 1.95) * 1.2
        splitter_slices.append(build_superellipse(0.0, 0.10, sz, sw, 0.04, n_pts=20, top_curvature=1.0, bot_curvature=1.0))
    loft_slices(hypercar, splitter_slices, close_ends=True, color=clay_col)
    
    # Left & right curved splitter winglet endplates
    for sign in [-1.0, 1.0]:
        winglet_slices = [
            [(sign * 0.95, 0.10, -2.25), (sign * 0.95, 0.22, -2.20), (sign * 0.93, 0.22, -2.10), (sign * 0.93, 0.10, -2.15)],
            [(sign * 0.98, 0.10, -2.25), (sign * 0.98, 0.26, -2.20), (sign * 0.96, 0.26, -2.10), (sign * 0.96, 0.10, -2.15)],
            [(sign * 1.00, 0.10, -2.25), (sign * 1.00, 0.28, -2.20), (sign * 0.98, 0.28, -2.10), (sign * 0.98, 0.10, -2.15)]
        ]
        loft_slices(hypercar, winglet_slices, close_ends=True, color=clay_col)
        
    # =========================================================================
    # 4. CURVED SWAN-NECK REAR WING WITH AIRFOIL CROSS-SECTION
    # =========================================================================
    wing_slices = []
    # NACA-like cambered curved airfoil slice
    for wx in [-0.98, -0.65, -0.30, 0.0, 0.30, 0.65, 0.98]:
        # Cambered dihedral wing arc (slightly drooped tips)
        arc_droop = -0.04 * (abs(wx) / 0.98) ** 2
        wy = 1.02 + arc_droop
        w_slice = [
            (wx, wy + 0.00, 2.00), # Leading edge
            (wx, wy + 0.03, 2.10), # Max camber top
            (wx, wy + 0.02, 2.25), # Trailing top
            (wx, wy + 0.00, 2.30), # Sharp trailing edge
            (wx, wy - 0.01, 2.22), # Bottom concave suction
            (wx, wy - 0.01, 2.08), # Bottom front
        ]
        wing_slices.append(w_slice)
    loft_slices(hypercar, wing_slices, close_ends=True, color=clay_col)
    
    # Twin curved swan-neck wing pylons (C-shaped curve)
    for sign in [-0.35, 0.35]:
        pylon_pts = []
        for i in range(12):
            t = i / 11.0
            # Parametric cubic curve rising from engine deck to wing top
            py = 0.55 + t * 0.48
            pz = 1.70 + math.sin(t * math.pi * 0.5) * 0.40
            pylon_pts.append(build_superellipse(sign, py, pz, 0.03, 0.08, n_pts=8, top_curvature=1.0, bot_curvature=1.0))
        loft_slices(hypercar, pylon_pts, close_ends=True, color=clay_col)
        
    # =========================================================================
    # 5. REAR DIFFUSER & VENTURI TUNNELS
    # =========================================================================
    for strake_x in [-0.60, -0.20, 0.20, 0.60]:
        strake = sbg.create_box(size=(0.025, 0.18, 0.65), color=clay_col)
        strake.rotate_x(12.0)
        strake.translate(sbm.Vec3(strake_x, 0.16, 1.95))
        hypercar.append(strake)
        
    # =========================================================================
    # 6. WHEELS & CONCAVE TURBINE RIMS (LATHED REVOLUTIONS)
    # =========================================================================
    wheel_positions = [
        (-0.88, 0.36, -1.35), # Front Left
        ( 0.88, 0.36, -1.35), # Front Right
        (-0.92, 0.38,  1.42), # Rear Left
        ( 0.92, 0.38,  1.42), # Rear Right
    ]
    
    # 2D Rim profile: (radius, axial_depth)
    rim_profile = [
        (0.00, -0.08), # Center cap hub
        (0.08, -0.06), # Lug nut recess
        (0.12, -0.03), # Spoke root
        (0.28, -0.05), # Concave barrel drop
        (0.36, -0.07), # Deep inner dish
        (0.38, -0.02), # Outer bead flange
        (0.40,  0.00), # Rim lip
        (0.40,  0.15), # Outer tire bead
        (0.42,  0.16), # Tire shoulder
        (0.44,  0.10), # Tread sidewall crown
        (0.44, -0.10), # Outer sidewall crown
        (0.42, -0.16), # Outer bead
        (0.39, -0.16), # Outer rim lip
        (0.38, -0.10), # Bead lock
    ]
    
    for wx, wy, wz in wheel_positions:
        rim_mesh = sbg.Mesh(f"Rim_{wx}_{wz}")
        lathe_profile(rim_mesh, rim_profile, radial_segs=24, color=clay_col)
        
        # Orient wheel outward along X axis
        rim_mesh.rotate_z(90.0 if wx > 0 else -90.0)
        rim_mesh.translate(sbm.Vec3(wx, wy, wz))
        hypercar.append(rim_mesh)
        
        # Perforated brake disc inside rim
        disc = sbg.create_cylinder(radius=0.28, height=0.03, segments=24, color=(0.48, 0.50, 0.53, 1.0))
        disc.rotate_z(90.0)
        disc.translate(sbm.Vec3(wx * 0.92, wy, wz))
        hypercar.append(disc)
        
        # Brake caliper
        caliper = sbg.create_box(size=(0.08, 0.14, 0.09), color=(0.60, 0.62, 0.65, 1.0))
        caliper.translate(sbm.Vec3(wx * 0.90, wy + 0.16, wz + 0.08))
        hypercar.append(caliper)
        
    # =========================================================================
    # 7. QUAD EXHAUST TIPS (LATHED CYLINDRICAL NOZZLES)
    # =========================================================================
    exhaust_profile = [
        (0.050, 0.00),
        (0.055, 0.00),
        (0.058, 0.12),
        (0.050, 0.12),
    ]
    for ex in [-0.18, -0.06, 0.06, 0.18]:
        nozzle = sbg.Mesh("ExhaustTip")
        lathe_profile(nozzle, exhaust_profile, radial_segs=16, color=(0.50, 0.52, 0.55, 1.0))
        nozzle.rotate_x(90.0)
        nozzle.translate(sbm.Vec3(ex, 0.38, 2.18))
        hypercar.append(nozzle)
        
    # =========================================================================
    # 8. FINALIZE & SMOOTH NORMALS
    # =========================================================================
    print("Computing smooth vertex envelope normals across all compound surfaces...")
    hypercar.recompute_smooth_normals()
    hypercar.compute_curvature_ao(0.55)
    
    v_count = hypercar.vertex_count
    t_count = hypercar.triangle_count
    print(f"Generated Curved Hero Hypercar: {v_count:,} vertices, {t_count:,} triangles.")
    
    out_dir = "/Users/eligreen/dev/scratchbox-ide-master/build"
    os.makedirs(out_dir, exist_ok=True)
    out_glb = os.path.join(out_dir, "hero_hypercar_curved_clay.glb")
    
    print(f"Streaming binary glTF 2.0 (.glb) to: {out_glb}")
    sbio.write_glb(out_glb, hypercar)
    print("Export complete.")
    return out_glb


if __name__ == "__main__":
    generate_curved_hero_hypercar()
