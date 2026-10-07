#!/usr/bin/env python3
"""
Hybrid Structural & Curvature Hero Hypercar Generator (Scratchbox 3D Engine).
Demonstrates the Dual Surface Architecture:
- Hard / Prismatic Geometry: Splitters, diffuser strakes, wing endplates, side skirts, cockpit dash
- Continuous Curvature Geometry: Sculpted hood, arched wheel fenders, teardrop canopy, rear haunches
- Rotational Geometry: Lathed deep-dish turbine rims, brake discs, exhaust nozzles
- Micro-Bevel Invariant: Hard geometry has calibrated edge chamfers to catch specular highlights
Preserves 100% of the authentic geometric layout while introducing silky surface curvature.
"""

import math
import os
import sys

import scratchbox as sb
from scratchbox import math as sbm
from scratchbox import geometry as sbg
from scratchbox import io as sbio


def build_crowned_hood(width=1.85, length=1.80, height=0.28, center_drop=0.08, grid_x=12, grid_z=12, color=(0.55, 0.57, 0.60, 1.0)):
    """
    Constructs a continuously curved automotive hood with:
    - Transverse crown bulge (higher in center-flanks, dropping at centerline)
    - Longitudinal aerodynamic slope down to the front nose
    - Center extraction channel
    """
    mesh = sbg.Mesh("CurvedHood")
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    half_w = width * 0.5
    half_l = length * 0.5
    
    # Generate parametric vertex grid
    for iz in range(grid_z + 1):
        tz = iz / grid_z  # 0 at rear cowl, 1 at front nose
        pz = -half_l + tz * length
        # Longitudinal slope: drops toward the front
        base_y = height * (1.0 - tz * 0.75)
        
        for ix in range(grid_x + 1):
            tx = ix / grid_x  # 0 at left edge, 1 at right edge
            px = -half_w + tx * width
            norm_x = (tx - 0.5) * 2.0  # -1 to +1
            
            # Compound curvature: crown dome + center extraction depression
            crown = math.cos(norm_x * math.pi * 0.5) * (height * 0.45)
            # Center channel depression: inverted Gaussian dip near centerline
            center_dip = math.exp(-(norm_x ** 2) / 0.12) * center_drop * (0.2 + tz * 0.8)
            
            py = base_y + crown - center_dip
            u = tx
            v = tz
            mesh.add_vertex(sbm.Vec3(px, py, pz), sbm.Vec3(0, 1, 0), sbm.Vec2(u, v), col)
            
    # Triangulate grid
    row_stride = grid_x + 1
    for iz in range(grid_z):
        for ix in range(grid_x):
            i0 = iz * row_stride + ix
            i1 = (iz + 1) * row_stride + ix
            i2 = (iz + 1) * row_stride + (ix + 1)
            i3 = iz * row_stride + (ix + 1)
            
            mesh.add_triangle(i0, i1, i2)
            mesh.add_triangle(i0, i2, i3)
            
    mesh.recompute_smooth_normals()
    return mesh


def build_arched_fender(width=0.38, length=1.45, height=0.48, arch_radius=0.44, grid_phi=16, grid_w=6, side=1.0, color=(0.55, 0.57, 0.60, 1.0)):
    """
    Constructs a curved wheel arch blister fender:
    - Circular wheel cutout arch along the side
    - Bulging compound curvature haunch peaking above the wheel
    - Smooth blend inward toward the hood/chassis
    """
    mesh = sbg.Mesh(f"ArchedFender_{'R' if side > 0 else 'L'}")
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    # Semi-circular arch from angle 15 deg to 165 deg
    start_v = mesh.vertex_count
    for iphi in range(grid_phi + 1):
        t_phi = iphi / grid_phi
        angle = math.radians(15.0 + t_phi * 150.0)
        
        # Radial vector in the Y-Z plane
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        
        inner_z = -cos_a * arch_radius
        inner_y = sin_a * arch_radius
        
        outer_z = -cos_a * (arch_radius + 0.18)
        outer_y = sin_a * (arch_radius + height * 0.6)
        
        for iw in range(grid_w + 1):
            tw = iw / grid_w  # 0 at wheel rim outer lip, 1 at inner body join
            # Radial interpolation
            pz = inner_z + (outer_z - inner_z) * (1.0 - (tw - 0.5)**2 * 4.0 * 0.3)
            # Vertical haunch swell
            swell = math.sin(tw * math.pi) * 0.08
            py = inner_y + (outer_y - inner_y) * (1.0 - tw) + swell
            # Transverse width
            px = side * (tw * width)
            
            mesh.add_vertex(sbm.Vec3(px, py, pz), sbm.Vec3(side, 1, 0), sbm.Vec2(t_phi, tw), col)
            
    row_stride = grid_w + 1
    for iphi in range(grid_phi):
        for iw in range(grid_w):
            i0 = start_v + iphi * row_stride + iw
            i1 = start_v + (iphi + 1) * row_stride + iw
            i2 = start_v + (iphi + 1) * row_stride + (iw + 1)
            i3 = start_v + iphi * row_stride + (iw + 1)
            
            if side > 0:
                mesh.add_triangle(i0, i1, i2)
                mesh.add_triangle(i0, i2, i3)
            else:
                mesh.add_triangle(i0, i2, i1)
                mesh.add_triangle(i0, i3, i2)
                
    mesh.recompute_smooth_normals()
    return mesh


def build_curved_canopy(width=1.40, length=2.00, height=0.54, grid_u=16, grid_v=12, color=(0.58, 0.60, 0.63, 1.0)):
    """
    Constructs a continuous aerodynamic teardrop cockpit canopy:
    - Raked windshield (45 deg angle)
    - Tumblehome (inward curve of greenhouse glass towards the roof)
    - Fastback rear window taper
    """
    mesh = sbg.Mesh("CurvedCanopy")
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    half_l = length * 0.5
    half_w = width * 0.5
    
    for iv in range(grid_v + 1):
        tv = iv / grid_v  # 0 at front base of windshield, 1 at rear fastback base
        pz = -half_l + tv * length
        
        # Longitudinal roof profile: rises steeply, peaks at 40% length, gently slopes down
        if tv < 0.40:
            # Windshield rake
            t_win = tv / 0.40
            profile_y = math.sin(t_win * math.pi * 0.5) * height
            w_factor = 0.70 + 0.30 * t_win
        else:
            # Fastback roof slope
            t_deck = (tv - 0.40) / 0.60
            profile_y = height * (1.0 - (t_deck ** 1.6) * 0.65)
            w_factor = 1.00 - t_deck * 0.35  # rear taper
            
        cur_w = half_w * w_factor
        
        for iu in range(grid_u + 1):
            tu = iu / grid_u  # 0 at left base, 1 at right base
            norm_u = (tu - 0.5) * 2.0  # -1 to +1
            px = norm_u * cur_w
            
            # Transverse tumblehome dome: parabolic arch
            arch = math.cos(norm_u * math.pi * 0.5)
            py = profile_y * (arch ** 0.65)
            
            mesh.add_vertex(sbm.Vec3(px, py, pz), sbm.Vec3(0, 1, 0), sbm.Vec2(tu, tv), col)
            
    row_stride = grid_u + 1
    for iv in range(grid_v):
        for iu in range(grid_u):
            i0 = iv * row_stride + iu
            i1 = (iv + 1) * row_stride + iu
            i2 = (iv + 1) * row_stride + (iu + 1)
            i3 = iv * row_stride + (iu + 1)
            
            mesh.add_triangle(i0, i1, i2)
            mesh.add_triangle(i0, i2, i3)
            
    mesh.recompute_smooth_normals()
    return mesh


def build_beveled_box(size, bevel=0.03, segs=2, color=(0.55, 0.57, 0.60, 1.0)):
    """
    Constructs a prismatic hard geometry block with calibrated edge chamfers.
    Ensures planar faces remain crisp, while 90-degree edges reflect specular highlights.
    """
    w, h, d = size
    hw, hh, hd = w * 0.5, h * 0.5, d * 0.5
    b = min(bevel, hw * 0.4, hh * 0.4, hd * 0.4)
    
    mesh = sbg.Mesh("BeveledPlate")
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    # Top face
    t0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(-hw + b,  hh, -hd + b), sbm.Vec3(0, 1, 0), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3(-hw + b,  hh,  hd - b), sbm.Vec3(0, 1, 0), sbm.Vec2(0, 1), col)
    mesh.add_vertex(sbm.Vec3( hw - b,  hh,  hd - b), sbm.Vec3(0, 1, 0), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3( hw - b,  hh, -hd + b), sbm.Vec3(0, 1, 0), sbm.Vec2(1, 0), col)
    mesh.add_triangle(t0, t0 + 1, t0 + 2)
    mesh.add_triangle(t0, t0 + 2, t0 + 3)
    
    # Bottom face
    b0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(-hw + b, -hh, -hd + b), sbm.Vec3(0, -1, 0), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3( hw - b, -hh, -hd + b), sbm.Vec3(0, -1, 0), sbm.Vec2(1, 0), col)
    mesh.add_vertex(sbm.Vec3( hw - b, -hh,  hd - b), sbm.Vec3(0, -1, 0), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3(-hw + b, -hh,  hd - b), sbm.Vec3(0, -1, 0), sbm.Vec2(0, 1), col)
    mesh.add_triangle(b0, b0 + 1, b0 + 2)
    mesh.add_triangle(b0, b0 + 2, b0 + 3)
    
    # Front face
    f0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(-hw + b, -hh + b, hd), sbm.Vec3(0, 0, 1), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3( hw - b, -hh + b, hd), sbm.Vec3(0, 0, 1), sbm.Vec2(1, 0), col)
    mesh.add_vertex(sbm.Vec3( hw - b,  hh - b, hd), sbm.Vec3(0, 0, 1), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3(-hw + b,  hh - b, hd), sbm.Vec3(0, 0, 1), sbm.Vec2(0, 1), col)
    mesh.add_triangle(f0, f0 + 1, f0 + 2)
    mesh.add_triangle(f0, f0 + 2, f0 + 3)
    
    # Back face
    k0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(-hw + b, -hh + b, -hd), sbm.Vec3(0, 0, -1), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3(-hw + b,  hh - b, -hd), sbm.Vec3(0, 0, -1), sbm.Vec2(0, 1), col)
    mesh.add_vertex(sbm.Vec3( hw - b,  hh - b, -hd), sbm.Vec3(0, 0, -1), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3( hw - b, -hh + b, -hd), sbm.Vec3(0, 0, -1), sbm.Vec2(1, 0), col)
    mesh.add_triangle(k0, k0 + 1, k0 + 2)
    mesh.add_triangle(k0, k0 + 2, k0 + 3)
    
    # Left face
    l0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(-hw, -hh + b, -hd + b), sbm.Vec3(-1, 0, 0), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3(-hw, -hh + b,  hd - b), sbm.Vec3(-1, 0, 0), sbm.Vec2(1, 0), col)
    mesh.add_vertex(sbm.Vec3(-hw,  hh - b,  hd - b), sbm.Vec3(-1, 0, 0), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3(-hw,  hh - b, -hd + b), sbm.Vec3(-1, 0, 0), sbm.Vec2(0, 1), col)
    mesh.add_triangle(l0, l0 + 1, l0 + 2)
    mesh.add_triangle(l0, l0 + 2, l0 + 3)
    
    # Right face
    r0 = mesh.vertex_count
    mesh.add_vertex(sbm.Vec3(hw, -hh + b, -hd + b), sbm.Vec3(1, 0, 0), sbm.Vec2(0, 0), col)
    mesh.add_vertex(sbm.Vec3(hw,  hh - b, -hd + b), sbm.Vec3(1, 0, 0), sbm.Vec2(0, 1), col)
    mesh.add_vertex(sbm.Vec3(hw,  hh - b,  hd - b), sbm.Vec3(1, 0, 0), sbm.Vec2(1, 1), col)
    mesh.add_vertex(sbm.Vec3(hw, -hh + b,  hd - b), sbm.Vec3(1, 0, 0), sbm.Vec2(1, 0), col)
    mesh.add_triangle(r0, r0 + 1, r0 + 2)
    mesh.add_triangle(r0, r0 + 2, r0 + 3)
    
    # 12 Chamfered edge bevel strips
    def add_quad(pA, pB, pC, pD):
        idx = mesh.vertex_count
        mesh.add_vertex(pA, sbm.Vec3(0, 1, 0), sbm.Vec2(0, 0), col)
        mesh.add_vertex(pB, sbm.Vec3(0, 1, 0), sbm.Vec2(1, 0), col)
        mesh.add_vertex(pC, sbm.Vec3(0, 1, 0), sbm.Vec2(1, 1), col)
        mesh.add_vertex(pD, sbm.Vec3(0, 1, 0), sbm.Vec2(0, 1), col)
        mesh.add_triangle(idx, idx + 1, idx + 2)
        mesh.add_triangle(idx, idx + 2, idx + 3)
        
    # Top 4 chamfers
    add_quad(sbm.Vec3(-hw + b, hh, hd - b), sbm.Vec3(hw - b, hh, hd - b), sbm.Vec3(hw - b, hh - b, hd), sbm.Vec3(-hw + b, hh - b, hd))
    add_quad(sbm.Vec3(hw - b, hh, -hd + b), sbm.Vec3(-hw + b, hh, -hd + b), sbm.Vec3(-hw + b, hh - b, -hd), sbm.Vec3(hw - b, hh - b, -hd))
    add_quad(sbm.Vec3(-hw, hh - b, -hd + b), sbm.Vec3(-hw, hh - b, hd - b), sbm.Vec3(-hw + b, hh, hd - b), sbm.Vec3(-hw + b, hh, -hd + b))
    add_quad(sbm.Vec3(hw, hh - b, hd - b), sbm.Vec3(hw, hh - b, -hd + b), sbm.Vec3(hw - b, hh, -hd + b), sbm.Vec3(hw - b, hh, hd - b))
    
    mesh.recompute_smooth_normals()
    return mesh


def lathe_turbine_rim(radius=0.40, depth=0.28, radial_segs=24, color=(0.55, 0.57, 0.60, 1.0)):
    """Revolves a deep-dish concave turbine rim with outer lip."""
    mesh = sbg.Mesh("LathedTurbineRim")
    col = sbm.Vec4(color[0], color[1], color[2], color[3])
    
    profile = [
        (0.00 * radius, -depth * 0.35),
        (0.20 * radius, -depth * 0.30),
        (0.35 * radius, -depth * 0.15),
        (0.70 * radius, -depth * 0.35),  # Deep drop center
        (0.92 * radius, -depth * 0.45),  # Barrel recess
        (0.96 * radius,  0.00),         # Outer rim lip
        (1.00 * radius,  0.05 * depth), # Lip edge
        (1.00 * radius,  depth * 0.55), # Tire bead
        (1.10 * radius,  depth * 0.60), # Tire sidewall crown
        (1.10 * radius, -depth * 0.60), # Outer tire sidewall
        (1.00 * radius, -depth * 0.55), # Outer tire bead
        (0.95 * radius, -depth * 0.50),
    ]
    
    n_pts = len(profile)
    start_v = mesh.vertex_count
    for r in range(radial_segs):
        ang = (r / radial_segs) * 2.0 * math.pi
        ca, sa = math.cos(ang), math.sin(ang)
        for p_idx, (rad, axial_y) in enumerate(profile):
            px = rad * ca
            pz = rad * sa
            py = axial_y
            norm = sbm.Vec3(ca, 0.0, sa)
            mesh.add_vertex(sbm.Vec3(px, py, pz), norm, sbm.Vec2(r / radial_segs, p_idx / (n_pts - 1)), col)
            
    for r in range(radial_segs):
        next_r = (r + 1) % radial_segs
        s0 = start_v + r * n_pts
        s1 = start_v + next_r * n_pts
        for p in range(n_pts - 1):
            i0 = s0 + p
            i1 = s1 + p
            i2 = s1 + (p + 1)
            i3 = s0 + (p + 1)
            mesh.add_triangle(i0, i1, i2)
            mesh.add_triangle(i0, i2, i3)
            
    mesh.recompute_smooth_normals()
    return mesh


def generate_hybrid_hero_hypercar():
    print("Synthesizing Hybrid Layout & Continuous Curvature Hypercar...")
    clay_mat = sbg.PbrMaterial.clay(roughness=0.85, metalness=0.0)
    clay_col = (0.55, 0.57, 0.60, 1.0)
    
    car = sbg.Mesh("HybridHeroHypercar")
    car.apply_material(clay_mat)
    
    # =========================================================================
    # [1] CONTINUOUS CURVATURE SURFACES (Aerodynamic Envelopes)
    # =========================================================================
    print(" -> Generating Curved Body Panels (Hood, Fenders, Canopy, Haunches)...")
    
    # 1. Sculpted Aerodynamic Hood (replaces the flat box hood in exact layout location)
    hood = build_crowned_hood(width=1.85, length=1.80, height=0.30, center_drop=0.07, color=clay_col)
    hood.translate(sbm.Vec3(0, 0.38, 1.30))
    car.append(hood)
    
    # 2. Arched Front Fenders (left and right, sitting over the front wheels)
    for side in (-1.0, 1.0):
        front_fender = build_arched_fender(width=0.36, length=1.45, height=0.48, arch_radius=0.46, side=side, color=clay_col)
        front_fender.translate(sbm.Vec3(side * 0.88, 0.36, 1.45))
        car.append(front_fender)
        
    # 3. Arched Rear Muscular Haunches (left and right, flared over rear wheels)
    for side in (-1.0, 1.0):
        rear_haunch = build_arched_fender(width=0.44, length=1.65, height=0.55, arch_radius=0.48, side=side, color=clay_col)
        rear_haunch.translate(sbm.Vec3(side * 0.92, 0.38, -1.45))
        car.append(rear_haunch)
        
    # 4. Aerodynamic Teardrop Cockpit Canopy (smooth tumblehome & windshield)
    canopy = build_curved_canopy(width=1.42, length=2.10, height=0.52, color=(0.58, 0.60, 0.63, 1.0))
    canopy.translate(sbm.Vec3(0, 0.72, -0.05))
    car.append(canopy)
    
    # 5. Fastback Sloping Rear Engine Deck & Cowl
    rear_deck = build_crowned_hood(width=1.90, length=1.65, height=0.25, center_drop=0.03, color=clay_col)
    rear_deck.rotate_x(180.0)  # slope downwards toward rear
    rear_deck.translate(sbm.Vec3(0, 0.52, -1.35))
    car.append(rear_deck)
    
    # =========================================================================
    # [2] HARD PRISMATIC GEOMETRY (Preserving the Authentic Layout)
    # =========================================================================
    print(" -> Generating Hard Geometric Layout Elements (Splitter, Skirts, Diffuser, Wing)...")
    
    # 1. Main Lower Monocoque Chassis Floor (stiff structural plinth)
    chassis_floor = build_beveled_box((2.15, 0.22, 4.70), bevel=0.02, color=clay_col)
    chassis_floor.translate(sbm.Vec3(0, 0.20, 0))
    car.append(chassis_floor)
    
    # 2. Dual-Tier Front Aerodynamic Splitter
    splitter_main = build_beveled_box((2.35, 0.05, 0.85), bevel=0.015, color=clay_col)
    splitter_main.translate(sbm.Vec3(0, 0.10, 2.50))
    car.append(splitter_main)
    
    splitter_upper = build_beveled_box((2.10, 0.04, 0.45), bevel=0.01, color=clay_col)
    splitter_upper.translate(sbm.Vec3(0, 0.18, 2.40))
    car.append(splitter_upper)
    
    # Splitter vertical fences / grille slats
    for ix in range(-4, 5):
        fence = build_beveled_box((0.025, 0.12, 0.35), bevel=0.005, color=clay_col)
        fence.translate(sbm.Vec3(ix * 0.18, 0.14, 2.45))
        car.append(fence)
        
    # Front dive plane canards (dual tier)
    for side in (-1.0, 1.0):
        for tier, y_off, z_off in [(1, 0.28, 2.25), (2, 0.42, 2.15)]:
            canard = build_beveled_box((0.38, 0.025, 0.25), bevel=0.005, color=clay_col)
            canard.rotate_y(side * 18.0)
            canard.rotate_z(side * 12.0)
            canard.translate(sbm.Vec3(side * 1.16, y_off, z_off))
            car.append(canard)
            
    # 3. Ground Effect Side Skirts running along the wheelbase
    for side in (-1.0, 1.0):
        skirt = build_beveled_box((0.24, 0.08, 2.75), bevel=0.01, color=clay_col)
        skirt.translate(sbm.Vec3(side * 1.15, 0.12, 0.0))
        car.append(skirt)
        
        skirt_fin = build_beveled_box((0.03, 0.22, 0.35), bevel=0.005, color=clay_col)
        skirt_fin.translate(sbm.Vec3(side * 1.24, 0.18, 1.15))
        car.append(skirt_fin)
        
    # 4. Rear Aerodynamic Diffuser with 6 Vertical Strakes
    diffuser = build_beveled_box((2.20, 0.14, 0.95), bevel=0.015, color=clay_col)
    diffuser.translate(sbm.Vec3(0, 0.16, -2.48))
    car.append(diffuser)
    
    for strake_idx in range(-3, 4):
        if strake_idx == 0: continue
        strake = build_beveled_box((0.025, 0.22, 0.90), bevel=0.005, color=clay_col)
        strake.translate(sbm.Vec3(strake_idx * 0.28, 0.14, -2.48))
        car.append(strake)
        
    # 5. Active GT Rear Wing (Blade + Endplates + Swan-Neck Pylons)
    main_wing = build_beveled_box((2.50, 0.045, 0.50), bevel=0.01, color=clay_col)
    main_wing.rotate_x(6.0)
    main_wing.translate(sbm.Vec3(0, 1.28, -2.15))
    car.append(main_wing)
    
    for side in (-1.0, 1.0):
        # Vertical endplate
        endplate = build_beveled_box((0.03, 0.32, 0.60), bevel=0.005, color=clay_col)
        endplate.translate(sbm.Vec3(side * 1.26, 1.28, -2.15))
        car.append(endplate)
        
        # Swan-neck pylon
        pylon = build_beveled_box((0.04, 0.55, 0.18), bevel=0.005, color=clay_col)
        pylon.rotate_x(-12.0)
        pylon.translate(sbm.Vec3(side * 0.62, 0.98, -2.05))
        car.append(pylon)
        
    # 6. Cockpit Interior Details
    for side in (-1.0, 1.0):
        seat_base = build_beveled_box((0.45, 0.12, 0.55), bevel=0.01, color=clay_col)
        seat_base.translate(sbm.Vec3(side * 0.32, 0.46, -0.05))
        car.append(seat_base)
        
        seat_back = build_beveled_box((0.42, 0.52, 0.10), bevel=0.01, color=clay_col)
        seat_back.rotate_x(-15.0)
        seat_back.translate(sbm.Vec3(side * 0.32, 0.74, -0.28))
        car.append(seat_back)
        
    dash = build_beveled_box((1.10, 0.20, 0.32), bevel=0.01, color=clay_col)
    dash.translate(sbm.Vec3(0, 0.66, 0.45))
    car.append(dash)
    
    # =========================================================================
    # [3] ROTATIONAL GEOMETRY (Wheels, Rims, Rotors, Exhausts)
    # =========================================================================
    print(" -> Generating Rotational Solid Assemblies (Deep-Dish Rims, Brake Discs)...")
    
    wheel_coords = [
        (-1.02, 0.36,  1.45), # Front Left
        ( 1.02, 0.36,  1.45), # Front Right
        (-1.05, 0.38, -1.45), # Rear Left
        ( 1.05, 0.38, -1.45), # Rear Right
    ]
    
    for wx, wy, wz in wheel_coords:
        is_right = wx > 0
        rim = lathe_turbine_rim(radius=0.40, depth=0.28, radial_segs=28, color=clay_col)
        rim.rotate_z(90.0 if is_right else -90.0)
        rim.translate(sbm.Vec3(wx, wy, wz))
        car.append(rim)
        
        # Perforated brake disc
        disc = sbg.create_cylinder(radius=0.28, height=0.03, segments=24, color=(0.48, 0.50, 0.53, 1.0))
        disc.rotate_z(90.0)
        disc.translate(sbm.Vec3(wx * 0.90, wy, wz))
        car.append(disc)
        
        # Caliper
        caliper = build_beveled_box((0.08, 0.14, 0.08), bevel=0.005, color=(0.60, 0.62, 0.65, 1.0))
        caliper.translate(sbm.Vec3(wx * 0.88, wy + 0.16, wz + 0.06))
        car.append(caliper)
        
    # Quad exhaust nozzle cluster
    for ex in [-0.18, -0.06, 0.06, 0.18]:
        nozzle = sbg.create_cylinder(radius=0.048, height=0.18, segments=16, color=(0.50, 0.52, 0.55, 1.0))
        nozzle.rotate_x(90.0)
        nozzle.translate(sbm.Vec3(ex, 0.36, -2.52))
        car.append(nozzle)
        
    # =========================================================================
    # [4] FINALIZE & NORMALS
    # =========================================================================
    car.recompute_smooth_normals()
    car.compute_curvature_ao(0.55)
    
    v_cnt = car.vertex_count
    t_cnt = car.triangle_count
    print(f"Hybrid Layout Curvature Hypercar Completed: {v_cnt:,} vertices, {t_cnt:,} triangles.")
    
    out_dir = "/Users/eligreen/dev/scratchbox-ide-master/build"
    os.makedirs(out_dir, exist_ok=True)
    out_glb = os.path.join(out_dir, "hero_hypercar_hybrid_clay.glb")
    sbio.write_glb(out_glb, car)
    print(f"Exported hybrid glTF 2.0 to: {out_glb}")
    return out_glb


if __name__ == "__main__":
    generate_hybrid_hero_hypercar()
