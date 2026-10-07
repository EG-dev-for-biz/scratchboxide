#!/usr/bin/env python3
"""
Test Autonomous Deep-Sea Scientific Submersible Hero Asset in Scratchbox 3D Engine.

Validates ADA Open-Domain Universality on a completely non-automotive, organic/industrial archetype:
1. 70% Primary Edifice:
   - Spherical pressure hull & acrylic panoramic forward viewport.
   - Hydrodynamic lofted buoyancy fairing (streamlined teardrop cowl via sb.create_loft).
   - Lateral thruster sponson wings.
2. 20% Secondary Articulated Assemblies:
   - 4x Vectoring ducted thrusters with lathed Venturi nozzles & central impeller hubs.
   - 6-DOF dexterous robotic manipulator arm with shoulder turret, elbow, and 3-finger claw.
   - Heavy-duty tubular titanium landing skids with upswept bow runners.
   - Forward scientific sample collection basket with structural ribbing.
3. 10% Tertiary Micro-Detail:
   - High-intensity LED lighting bar (5 deep-dish projector housings).
   - Pan-tilt scientific stereoscopic camera turret.
   - Dorsal lifting bail and acoustic transponder pylon.

Outputs build/submersible_hero_clay.glb in 18% Studio Grey Clay with contact AO shading.
"""

import math
import os
import sys

import scratchbox as sb
from scratchbox import math as sbm
from scratchbox import geometry as sbg
from scratchbox import io as sbio

CLAY_COLOR = (0.55, 0.57, 0.60, 1.0)
CLAY_DARK = (0.45, 0.47, 0.50, 1.0)
CLAY_LIGHT = (0.64, 0.66, 0.69, 1.0)


def superellipse_loop(z, cx, cy, rx, ry, m=2.4, n_pts=24):
    """Generates a closed 3D polygonal loop of a super-ellipse at coordinate z."""
    pts = []
    for i in range(n_pts):
        th = i * 2.0 * math.pi / n_pts
        cos_t = math.cos(th)
        sin_t = math.sin(th)
        sgn_x = 1.0 if cos_t >= 0 else -1.0
        sgn_y = 1.0 if sin_t >= 0 else -1.0
        px = cx + rx * sgn_x * (abs(cos_t) ** (2.0 / m))
        py = cy + ry * sgn_y * (abs(sin_t) ** (2.0 / m))
        pts.append(sbm.Vec3(px, py, z))
    return pts


def build_tubular_loft(spline_pts, radius=0.030, n_pts=16, color=CLAY_COLOR):
    """Lofts a smooth circular tube along an arbitrary 3D guide spline."""
    slices = []
    for i, pt in enumerate(spline_pts):
        if i == 0:
            tangent = (spline_pts[1][0] - pt[0], spline_pts[1][1] - pt[1], spline_pts[1][2] - pt[2])
        elif i == len(spline_pts) - 1:
            tangent = (pt[0] - spline_pts[i-1][0], pt[1] - spline_pts[i-1][1], pt[2] - spline_pts[i-1][2])
        else:
            tangent = (spline_pts[i+1][0] - spline_pts[i-1][0], spline_pts[i+1][1] - spline_pts[i-1][1], spline_pts[i+1][2] - spline_pts[i-1][2])
            
        mag = math.sqrt(tangent[0]**2 + tangent[1]**2 + tangent[2]**2)
        if mag < 1e-5: tangent = (0.0, 0.0, 1.0)
        else: tangent = (tangent[0]/mag, tangent[1]/mag, tangent[2]/mag)
        
        ref = (0.0, 1.0, 0.0) if abs(tangent[1]) < 0.9 else (1.0, 0.0, 0.0)
        ux = tangent[1]*ref[2] - tangent[2]*ref[1]
        uy = tangent[2]*ref[0] - tangent[0]*ref[2]
        uz = tangent[0]*ref[1] - tangent[1]*ref[0]
        u_mag = math.sqrt(ux*ux + uy*uy + uz*uz)
        ux, uy, uz = ux/u_mag, uy/u_mag, uz/u_mag
        
        vx = uy*tangent[2] - uz*tangent[1]
        vy = uz*tangent[0] - ux*tangent[2]
        vz = ux*tangent[1] - uy*tangent[0]
        
        loop = []
        for j in range(n_pts):
            ang = j * 2.0 * math.pi / n_pts
            px = pt[0] + radius * (math.cos(ang) * ux + math.sin(ang) * vx)
            py = pt[1] + radius * (math.cos(ang) * uy + math.sin(ang) * vy)
            pz = pt[2] + radius * (math.cos(ang) * uz + math.sin(ang) * vz)
            loop.append(sbm.Vec3(px, py, pz))
        slices.append(loop)
    return sb.create_loft(slices, close_ends=True, color=color)


def create_strut(pt_a, pt_b, thickness=(0.04, 0.04), bevel=0.005, color=CLAY_COLOR):
    """Creates an articulated structural member connecting pt_a to pt_b."""
    dx = pt_b[0] - pt_a[0]
    dy = pt_b[1] - pt_a[1]
    dz = pt_b[2] - pt_a[2]
    dist = math.sqrt(dx*dx + dy*dy + dz*dz)
    if dist < 1e-4: return None
    
    mid_x = (pt_a[0] + pt_b[0]) * 0.5
    mid_y = (pt_a[1] + pt_b[1]) * 0.5
    mid_z = (pt_a[2] + pt_b[2]) * 0.5
    
    yaw = math.degrees(math.atan2(dx, dz))
    pitch = -math.degrees(math.atan2(dy, math.sqrt(dx*dx + dz*dz)))
    
    strut = sb.create_beveled_box(
        size=(thickness[0], thickness[1], dist),
        bevel=bevel,
        color=color
    )
    strut.rotate_x(pitch)
    strut.rotate_y(yaw)
    strut.translate(mid_x, mid_y, mid_z)
    return strut


def create_ducted_thruster():
    """Builds a high-performance Kort-nozzle ducted marine thruster."""
    thruster = sbg.Mesh("DuctedThruster")
    
    # 1. Outer Kort Nozzle (Venturi hydrofoil profile lathed 360 deg)
    nozzle_profile = [
        sbm.Vec2(0.24, -0.22),
        sbm.Vec2(0.27, -0.15),
        sbm.Vec2(0.28,  0.00),
        sbm.Vec2(0.26,  0.18),
        sbm.Vec2(0.23,  0.22),
        sbm.Vec2(0.21,  0.22),
        sbm.Vec2(0.20,  0.08),
        sbm.Vec2(0.20, -0.12),
        sbm.Vec2(0.21, -0.22),
    ]
    nozzle = sb.create_lathe(nozzle_profile, segments=24, color=CLAY_COLOR)
    thruster.append(nozzle)
    
    # 2. Central Motor Bullet Hub
    hub_profile = [
        sbm.Vec2(0.00, -0.18),
        sbm.Vec2(0.065, -0.16),
        sbm.Vec2(0.075,  0.00),
        sbm.Vec2(0.065,  0.15),
        sbm.Vec2(0.00,   0.22),
    ]
    hub = sb.create_lathe(hub_profile, segments=18, color=CLAY_DARK)
    thruster.append(hub)
    
    # 3. 4-Blade Impeller & Stator Struts
    for i in range(4):
        ang = i * 90.0
        blade = sb.create_beveled_box((0.14, 0.015, 0.05), bevel=0.003, color=CLAY_LIGHT)
        blade.rotate_y(25.0)
        blade.translate(0.13, 0.0, 0.0)
        blade.rotate_z(ang)
        thruster.append(blade)
        
    return thruster


def build_deep_sea_submersible():
    sub = sbg.Mesh("DeepSeaExplorationSubmersible")
    
    print("[1/5] Lofting hydrodynamic teardrop buoyancy fairing & pressure hull...")
    # 1. Spherical Titanium Pressure Hull (occupying forward center of craft)
    pressure_hull = sb.create_sphere(radius=0.74, rings=20, sectors=36, color=CLAY_COLOR)
    pressure_hull.translate(0.0, 1.08, 0.22)
    sub.append(pressure_hull)
    
    # Forward Panoramic Viewport Bezel & Acrylic Conical Dome
    viewport_bezel = sb.create_lathe([
        sbm.Vec2(0.00,  0.00),
        sbm.Vec2(0.38,  0.00),
        sbm.Vec2(0.42,  0.04),
        sbm.Vec2(0.41,  0.08),
        sbm.Vec2(0.32,  0.12),
        sbm.Vec2(0.00,  0.14),
    ], segments=28, color=CLAY_LIGHT)
    viewport_bezel.rotate_x(90.0)
    viewport_bezel.translate(0.0, 1.05, 0.92)
    sub.append(viewport_bezel)

    # 2. Continuous Hydrodynamic Teardrop Buoyancy Cowl via sb.create_loft
    # 14 stations along Z (+1.30 -> -1.75) wrapping over the top and sides
    fairing_stations = [
        # Bow nose cap above viewport
        ( 1.30, 0.0, 1.32, 0.22, 0.18, 2.2),
        ( 1.10, 0.0, 1.40, 0.46, 0.32, 2.4),
        ( 0.80, 0.0, 1.48, 0.68, 0.44, 2.6),
        # Mid-body maximum beam over pressure hull
        ( 0.40, 0.0, 1.54, 0.82, 0.52, 2.8),
        ( 0.00, 0.0, 1.55, 0.85, 0.54, 2.9),
        (-0.40, 0.0, 1.52, 0.83, 0.52, 2.8),
        # Dorsal sail & equipment bay
        (-0.80, 0.0, 1.45, 0.76, 0.46, 2.6),
        (-1.15, 0.0, 1.35, 0.64, 0.38, 2.4),
        (-1.45, 0.0, 1.25, 0.48, 0.28, 2.2),
        # Streamlined stern taper
        (-1.70, 0.0, 1.15, 0.28, 0.18, 2.0),
        (-1.85, 0.0, 1.10, 0.12, 0.10, 2.0),
    ]
    fairing_slices = []
    for z, cx, cy, rx, ry, m in fairing_stations:
        fairing_slices.append(superellipse_loop(z, cx, cy, rx, ry, m=m, n_pts=28))
    fairing = sb.create_loft(fairing_slices, close_ends=True, color=CLAY_COLOR)
    sub.append(fairing)
    
    # Dorsal Access Hatch & Heavy Lifting Bail (for crane recovery)
    hatch = sb.create_lathe([
        sbm.Vec2(0.00, 0.00),
        sbm.Vec2(0.28, 0.00),
        sbm.Vec2(0.30, 0.06),
        sbm.Vec2(0.28, 0.09),
        sbm.Vec2(0.00, 0.09),
    ], segments=20, color=CLAY_LIGHT)
    hatch.translate(0.0, 1.95, -0.10)
    sub.append(hatch)
    
    lift_bail_pts = [
        (-0.25, 1.95, -0.10),
        (-0.22, 2.22, -0.10),
        ( 0.00, 2.30, -0.10),
        ( 0.22, 2.22, -0.10),
        ( 0.25, 1.95, -0.10),
    ]
    lift_bail = build_tubular_loft(lift_bail_pts, radius=0.024, n_pts=14, color=CLAY_LIGHT)
    sub.append(lift_bail)

    print("[2/5] Building tubular titanium benthic landing skids & structural crossbars...")
    # Port & Starboard continuous tubular skids with upswept bows
    for sign in (-1.0, 1.0):
        skid_pts = [
            # Stern bumper curve
            (sign * 0.72, 0.35, -1.50),
            (sign * 0.72, 0.14, -1.35),
            # Flat ground contact runner
            (sign * 0.72, 0.10, -0.80),
            (sign * 0.72, 0.10,  0.00),
            (sign * 0.72, 0.10,  0.75),
            # Upswept bow ski curve
            (sign * 0.72, 0.22,  1.30),
            (sign * 0.72, 0.48,  1.60),
        ]
        skid = build_tubular_loft(skid_pts, radius=0.032, n_pts=16, color=CLAY_COLOR)
        sub.append(skid)
        
        # Vertical chassis support stanchions connecting skids to hull
        for sz in (-0.90, 0.10, 0.90):
            stanchion = create_strut(
                (sign * 0.72, 0.12, sz),
                (sign * 0.58, 0.68, sz),
                thickness=(0.045, 0.045),
                bevel=0.006,
                color=CLAY_COLOR
            )
            if stanchion: sub.append(stanchion)
            
    # Skid Cross-members (transverse tie bars)
    for cz in (-0.85, 0.05, 0.85):
        crossbar = create_strut(
            (-0.70, 0.14, cz),
            ( 0.70, 0.14, cz),
            thickness=(0.038, 0.038),
            bevel=0.005,
            color=CLAY_COLOR
        )
        if crossbar: sub.append(crossbar)

    print("[3/5] Assembling 4-axis vectoring ducted marine thrusters...")
    # 2x Horizontal Main Propulsion Thrusters (Aft Port & Starboard)
    for sign in (-1.0, 1.0):
        t_main = create_ducted_thruster()
        t_main.translate(sign * 0.96, 1.05, -1.35)
        sub.append(t_main)
        
        # Pylon strut mounting thruster to hull
        pylon = create_strut(
            (sign * 0.65, 1.15, -1.35),
            (sign * 0.96, 1.05, -1.35),
            thickness=(0.06, 0.03),
            bevel=0.006,
            color=CLAY_COLOR
        )
        if pylon: sub.append(pylon)

    # 2x Vertical / Lateral Maneuvering Thrusters (Midship Port & Starboard, angled 45 deg)
    for sign in (-1.0, 1.0):
        t_vert = create_ducted_thruster()
        t_vert.rotate_x(90.0)  # Aim thrust vertically
        t_vert.rotate_y(sign * 15.0)
        t_vert.translate(sign * 0.98, 1.45, 0.15)
        sub.append(t_vert)
        
        pylon_v = create_strut(
            (sign * 0.75, 1.40, 0.15),
            (sign * 0.98, 1.45, 0.15),
            thickness=(0.05, 0.05),
            bevel=0.005,
            color=CLAY_COLOR
        )
        if pylon_v: sub.append(pylon_v)

    print("[4/5] Articulating 6-DOF dexterous robotic manipulator arm & claw...")
    # Mounted on starboard forward lower frame (X = +0.42, Y = 0.58, Z = 0.85)
    # 1. Shoulder Turret Mount
    shoulder_base = sb.create_lathe([
        sbm.Vec2(0.00, 0.00),
        sbm.Vec2(0.09, 0.00),
        sbm.Vec2(0.08, 0.08),
        sbm.Vec2(0.00, 0.08),
    ], segments=16, color=CLAY_DARK)
    shoulder_base.translate(0.42, 0.54, 0.85)
    sub.append(shoulder_base)
    
    # 2. Upper Boom (Bicep) angled forward-downward
    pt_shoulder = (0.42, 0.62, 0.85)
    pt_elbow = (0.48, 0.42, 1.35)
    boom = create_strut(pt_shoulder, pt_elbow, thickness=(0.055, 0.055), bevel=0.008, color=CLAY_COLOR)
    if boom: sub.append(boom)
    
    # Elbow Pivot Actuator
    elbow_joint = sb.create_sphere(radius=0.055, rings=12, sectors=16, color=CLAY_DARK)
    elbow_joint.translate(pt_elbow[0], pt_elbow[1], pt_elbow[2])
    sub.append(elbow_joint)
    
    # 3. Forearm Link angled toward sample target
    pt_wrist = (0.35, 0.38, 1.82)
    forearm = create_strut(pt_elbow, pt_wrist, thickness=(0.045, 0.045), bevel=0.006, color=CLAY_COLOR)
    if forearm: sub.append(forearm)
    
    # Wrist Rotator
    wrist_joint = sb.create_sphere(radius=0.042, rings=10, sectors=14, color=CLAY_DARK)
    wrist_joint.translate(pt_wrist[0], pt_wrist[1], pt_wrist[2])
    sub.append(wrist_joint)
    
    # 4. 3-Finger Intermeshing Titanium Gripper Claw
    claw_palm = sb.create_beveled_box((0.08, 0.08, 0.04), bevel=0.008, color=CLAY_LIGHT)
    claw_palm.translate(pt_wrist[0], pt_wrist[1], pt_wrist[2] + 0.03)
    sub.append(claw_palm)
    
    # 3 articulated fingers
    for f_idx, f_ang in enumerate((0.0, 120.0, 240.0)):
        rad = math.radians(f_ang)
        fx = pt_wrist[0] + 0.035 * math.cos(rad)
        fy = pt_wrist[1] + 0.035 * math.sin(rad)
        fz = pt_wrist[2] + 0.05
        
        f_mid = (fx + 0.02 * math.cos(rad), fy + 0.02 * math.sin(rad), fz + 0.08)
        f_tip = (fx - 0.01 * math.cos(rad), fy - 0.01 * math.sin(rad), fz + 0.15)
        
        seg1 = create_strut((fx, fy, fz), f_mid, thickness=(0.016, 0.012), bevel=0.002, color=CLAY_LIGHT)
        seg2 = create_strut(f_mid, f_tip, thickness=(0.012, 0.010), bevel=0.002, color=CLAY_LIGHT)
        if seg1: sub.append(seg1)
        if seg2: sub.append(seg2)

    print("[5/5] Fabricating scientific sample basket & forward sensor/lighting array...")
    # Scientific Specimen Collection Basket (slotted frame between front skids)
    basket_w = 0.68
    basket_h = 0.24
    basket_d = 0.55
    basket_z = 1.45
    basket_y = 0.28
    
    # Main outer perimeter frame
    for b_sign in (-1.0, 1.0):
        # Longitudinal side rails
        side_rail = create_strut(
            (b_sign * basket_w * 0.5, basket_y, basket_z - basket_d * 0.5),
            (b_sign * basket_w * 0.5, basket_y, basket_z + basket_d * 0.5),
            thickness=(0.024, 0.024),
            color=CLAY_COLOR
        )
        if side_rail: sub.append(side_rail)
        
        top_rail = create_strut(
            (b_sign * basket_w * 0.5, basket_y + basket_h, basket_z - basket_d * 0.5),
            (b_sign * basket_w * 0.5, basket_y + basket_h, basket_z + basket_d * 0.5),
            thickness=(0.024, 0.024),
            color=CLAY_COLOR
        )
        if top_rail: sub.append(top_rail)

    # Transverse front & bottom retaining ribs
    for r_idx in range(5):
        rz = (basket_z - basket_d * 0.5) + r_idx * (basket_d / 4.0)
        rib = create_strut(
            (-basket_w * 0.5, basket_y, rz),
            ( basket_w * 0.5, basket_y, rz),
            thickness=(0.018, 0.018),
            color=CLAY_DARK
        )
        if rib: sub.append(rib)

    # High-Intensity Deep-Sea LED Lighting Bar (5 projector light pods across bow brow)
    light_bar = create_strut(
        (-0.55, 1.82, 0.88),
        ( 0.55, 1.82, 0.88),
        thickness=(0.04, 0.04),
        bevel=0.005,
        color=CLAY_COLOR
    )
    if light_bar: sub.append(light_bar)
    
    for l_idx in range(-2, 3):
        lx = l_idx * 0.24
        light_pod = sb.create_lathe([
            sbm.Vec2(0.00,  0.00),
            sbm.Vec2(0.065, 0.00),
            sbm.Vec2(0.080, 0.04),
            sbm.Vec2(0.075, 0.12),
            sbm.Vec2(0.00,  0.13),
        ], segments=16, color=CLAY_LIGHT)
        light_pod.rotate_x(80.0)  # Aim 10 deg downward into benthic seabed
        light_pod.translate(lx, 1.84, 0.90)
        sub.append(light_pod)

    # Pan-Tilt Stereoscopic 4K Science Camera Turret (mounted on bow brow)
    cam_base = sb.create_lathe([
        sbm.Vec2(0.00, 0.00),
        sbm.Vec2(0.06, 0.00),
        sbm.Vec2(0.05, 0.08),
        sbm.Vec2(0.00, 0.08),
    ], segments=14, color=CLAY_DARK)
    cam_base.translate(0.0, 1.62, 0.95)
    sub.append(cam_base)
    
    cam_head = sb.create_beveled_box((0.18, 0.08, 0.12), bevel=0.012, color=CLAY_COLOR)
    cam_head.translate(0.0, 1.72, 0.98)
    sub.append(cam_head)
    
    # Dual stereo optical lenses
    for c_sign in (-1.0, 1.0):
        lens = sb.create_lathe([
            sbm.Vec2(0.00, 0.00),
            sbm.Vec2(0.024, 0.00),
            sbm.Vec2(0.028, 0.03),
            sbm.Vec2(0.00,  0.035),
        ], segments=12, color=CLAY_LIGHT)
        lens.rotate_x(90.0)
        lens.translate(c_sign * 0.055, 1.72, 1.05)
        sub.append(lens)

    # Master smooth normals & curvature contact ambient occlusion
    sub.recompute_smooth_normals()
    sub.compute_curvature_ao(0.55)
    
    print(f"Deep-Sea Submersible Completed: {sub.vertex_count:,} vertices, {sub.triangle_count:,} triangles.")
    return sub


def main():
    os.makedirs("build", exist_ok=True)
    out_glb = "build/submersible_hero_clay.glb"
    
    print("Generating Deep-Sea Scientific Submersible Hero Asset in Studio Grey Clay...")
    sub = build_deep_sea_submersible()
    
    print(f"Exporting master mesh to {out_glb}...")
    sb.io.write_glb(out_glb, sub)
    
    file_size_kb = os.path.getsize(out_glb) / 1024.0
    print(f"Success! Exported {out_glb} ({file_size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
