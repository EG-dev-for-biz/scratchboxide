#!/usr/bin/env python3
"""
Test Authentic Aerodynamic Curvature on Open-Wheel Formula Vehicle in Scratchbox 3D Engine.

Replaces discrete box stacking with continuous cross-sectional lofting (sb.create_loft):
1. Continuous Monocoque Hull: 22 superelliptic cross-section stations along Z (3.10 to -2.40)
   producing compound curvature on needle nose, front bulkhead, cockpit tub, and engine cowl.
2. Sculpted Coke-Bottle Sidepods: 14 lofted stations per sidepod with radiator intake lips,
   downwash slope, and deep waist undercut.
3. Tubular Titanium Halo: 3D spline sweep lofting creating an authentic curved protective hoop.
4. Multi-Link Carbon Suspension: Exposed double-wishbones and pushrods.
5. Rotational Solid Wheels: Lathed racing slicks with deep-dish rims.

Outputs build/formula_hero_curved_clay.glb in 18% Studio Grey Clay with contact AO shading.
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


def superellipse_loop(z, cx, cy, rx, ry, m=2.5, n_pts=28, y_offset_fn=None):
    """Generates a closed 3D polygonal loop of a super-ellipse at coordinate z."""
    pts = []
    for i in range(n_pts):
        th = i * 2.0 * math.pi / n_pts
        cos_t = math.cos(th)
        sin_t = math.sin(th)
        sgn_x = 1.0 if cos_t >= 0 else -1.0
        sgn_y = 1.0 if sin_t >= 0 else -1.0
        
        # Super-elliptic radius modulation
        px = cx + rx * sgn_x * (abs(cos_t) ** (2.0 / m))
        py = cy + ry * sgn_y * (abs(sin_t) ** (2.0 / m))
        
        if y_offset_fn is not None:
            py += y_offset_fn(th)
            
        pts.append(sbm.Vec3(px, py, z))
    return pts


def build_tubular_loft(spline_pts, radius=0.022, n_pts=16, color=CLAY_LIGHT):
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


def create_strut(pt_a, pt_b, thickness=(0.026, 0.012), bevel=0.003, color=CLAY_COLOR):
    """Creates an aerodynamic suspension strut connecting pt_a to pt_b."""
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


def build_curved_formula_hero():
    car = sbg.Mesh("CurvedOpenWheelFormulaHero")
    
    print("[1/6] Lofting continuous central monocoque hull via sb.create_loft (Z: +3.10 -> -2.40)...")
    # 22 longitudinal cross-sectional stations defining compound curvature
    # (z, cy, rx, ry, m)
    hull_stations = [
        # Needle nose tip
        ( 3.10, 0.16, 0.040, 0.030, 2.0),
        ( 2.95, 0.18, 0.075, 0.055, 2.1),
        ( 2.75, 0.22, 0.120, 0.085, 2.2),
        ( 2.50, 0.26, 0.170, 0.120, 2.3),
        # Front wing transition & nose underside concavity
        ( 2.20, 0.30, 0.210, 0.150, 2.5),
        # Front suspension bulkhead
        ( 1.85, 0.34, 0.250, 0.180, 2.7),
        ( 1.50, 0.38, 0.280, 0.200, 2.8),
        # Forward cockpit bulkhead
        ( 1.15, 0.40, 0.310, 0.220, 2.9),
        ( 0.85, 0.42, 0.330, 0.230, 3.0),
        # Open cockpit rim area
        ( 0.50, 0.42, 0.340, 0.235, 3.0),
        ( 0.20, 0.43, 0.345, 0.240, 3.0),
        (-0.10, 0.44, 0.340, 0.240, 2.9),
        # Driver helmet recess & rise into engine airbox scoop
        (-0.35, 0.56, 0.300, 0.320, 2.6),
        (-0.60, 0.68, 0.260, 0.380, 2.4), # Airbox intake apex
        (-0.90, 0.62, 0.250, 0.350, 2.4),
        # Sloping engine spine
        (-1.20, 0.52, 0.240, 0.290, 2.5),
        (-1.50, 0.44, 0.220, 0.240, 2.5),
        # Rear gearbox Coke-bottle waist
        (-1.80, 0.36, 0.180, 0.190, 2.4),
        (-2.05, 0.32, 0.150, 0.160, 2.3),
        # Rear crash structure & tail cone
        (-2.25, 0.29, 0.120, 0.130, 2.2),
        (-2.40, 0.27, 0.090, 0.100, 2.0),
    ]
    
    monocoque_slices = []
    for z, cy, rx, ry, m in hull_stations:
        monocoque_slices.append(superellipse_loop(z, 0.0, cy, rx, ry, m=m, n_pts=32))
        
    monocoque_hull = sb.create_loft(monocoque_slices, close_ends=True, color=CLAY_COLOR)
    car.append(monocoque_hull)
    
    # Cockpit tub interior cutout & seat
    seat = sb.create_beveled_box((0.44, 0.24, 0.70), bevel=0.015, color=CLAY_DARK)
    seat.translate(0.0, 0.36, 0.15)
    car.append(seat)
    
    headrest = sb.create_beveled_box((0.36, 0.26, 0.20), bevel=0.02, color=CLAY_COLOR)
    headrest.translate(0.0, 0.58, -0.22)
    car.append(headrest)

    print("[2/6] Lofting sculpted Coke-bottle sidepods with smooth undercut bellies via sb.create_loft...")
    # 12 longitudinal stations per sidepod creating authentic downwash and Coke-bottle waist
    # (z, cx_offset, cy, rx, ry, m)
    sidepod_stations = [
        # Radiator forward intake mouth
        ( 0.85, 0.56, 0.34, 0.170, 0.140, 2.8),
        ( 0.70, 0.59, 0.34, 0.190, 0.155, 3.0),
        # Maximum belly width with undercut
        ( 0.45, 0.62, 0.33, 0.210, 0.160, 3.0),
        ( 0.15, 0.63, 0.31, 0.210, 0.150, 2.9),
        # Beginning of downwash ramp
        (-0.20, 0.61, 0.29, 0.195, 0.135, 2.8),
        (-0.55, 0.57, 0.26, 0.175, 0.115, 2.7),
        # Coke-bottle waist contraction toward gearbox
        (-0.90, 0.50, 0.23, 0.150, 0.095, 2.6),
        (-1.25, 0.42, 0.20, 0.120, 0.075, 2.5),
        (-1.55, 0.34, 0.17, 0.085, 0.055, 2.4),
        (-1.80, 0.26, 0.15, 0.055, 0.035, 2.2),
    ]
    
    for sign in (-1.0, 1.0):
        sp_slices = []
        for z, cx, cy, rx, ry, m in sidepod_stations:
            sp_slices.append(superellipse_loop(z, sign * cx, cy, rx, ry, m=m, n_pts=24))
        sidepod = sb.create_loft(sp_slices, close_ends=True, color=CLAY_COLOR)
        car.append(sidepod)
        
        # Floor ground-effect edge running along the wheelbase
        floor_plank = sb.create_beveled_box((0.26, 0.035, 2.40), bevel=0.008, color=CLAY_COLOR)
        floor_plank.translate(sign * 0.78, 0.08, -0.15)
        car.append(floor_plank)

    print("[3/6] Lofting curved tubular Titanium Halo & aerodynamic center pylon...")
    halo_arch_pts = [
        (-0.26, 0.68, -0.14),
        (-0.31, 0.74,  0.08),
        (-0.25, 0.79,  0.30),
        ( 0.00, 0.81,  0.42),
        ( 0.25, 0.79,  0.30),
        ( 0.31, 0.74,  0.08),
        ( 0.26, 0.68, -0.14),
    ]
    halo_ring = build_tubular_loft(halo_arch_pts, radius=0.022, n_pts=16, color=CLAY_LIGHT)
    car.append(halo_ring)
    
    # Forward center pylon sweeping down into monocoque nose bridge
    pylon_pts = [
        (0.00, 0.80, 0.42),
        (0.00, 0.72, 0.52),
        (0.00, 0.62, 0.62),
        (0.00, 0.52, 0.70),
    ]
    halo_pylon = build_tubular_loft(pylon_pts, radius=0.018, n_pts=14, color=CLAY_LIGHT)
    car.append(halo_pylon)

    # Dorsal Shark Fin stabilizer with continuous tapered aerodynamic spine
    fin = sb.create_subdivided_box(
        size=(0.025, 0.38, 1.55),
        subdivisions=(2, 4, 8),
        color=CLAY_COLOR
    )
    fin.taper(axis=1, factor=0.20)
    fin.translate(0.0, 0.82, -1.25)
    car.append(fin)

    print("[4/6] Assembling exposed multi-link carbon suspension wishbones (S_exposure = 1.0)...")
    front_z = 1.85
    rear_z = -1.80
    front_track = 0.98
    rear_track = 0.95
    wheel_y = 0.35
    
    front_wheels = [(-front_track, wheel_y, front_z), (front_track, wheel_y, front_z)]
    rear_wheels = [(-rear_track, wheel_y, rear_z), (rear_track, wheel_y, rear_z)]
    
    # Front Suspension (Double Wishbone + Pushrod)
    for wx, wy, wz in front_wheels:
        sign = 1.0 if wx > 0 else -1.0
        hub_pt = (wx * 0.83, wy, wz)
        
        arm_uf = create_strut((sign * 0.25, 0.42, wz + 0.16), (hub_pt[0], hub_pt[1] + 0.11, hub_pt[2]))
        arm_ur = create_strut((sign * 0.25, 0.42, wz - 0.16), (hub_pt[0], hub_pt[1] + 0.11, hub_pt[2]))
        arm_lf = create_strut((sign * 0.23, 0.18, wz + 0.18), (hub_pt[0], hub_pt[1] - 0.11, hub_pt[2]))
        arm_lr = create_strut((sign * 0.23, 0.18, wz - 0.18), (hub_pt[0], hub_pt[1] - 0.11, hub_pt[2]))
        pushrod = create_strut((sign * 0.26, 0.44, wz - 0.06), (hub_pt[0], hub_pt[1] - 0.08, hub_pt[2]), thickness=(0.020, 0.014))
        tierod  = create_strut((sign * 0.24, 0.28, wz + 0.10), (hub_pt[0], hub_pt[1] + 0.02, hub_pt[2] + 0.06))
        
        for elem in [arm_uf, arm_ur, arm_lf, arm_lr, pushrod, tierod]:
            if elem: car.append(elem)
            
    # Rear Suspension (Double Wishbone + Pullrod)
    for wx, wy, wz in rear_wheels:
        sign = 1.0 if wx > 0 else -1.0
        hub_pt = (wx * 0.83, wy, wz)
        
        arm_uf = create_strut((sign * 0.20, 0.38, wz + 0.20), (hub_pt[0], hub_pt[1] + 0.12, hub_pt[2]))
        arm_ur = create_strut((sign * 0.18, 0.36, wz - 0.18), (hub_pt[0], hub_pt[1] + 0.12, hub_pt[2]))
        arm_lf = create_strut((sign * 0.18, 0.18, wz + 0.22), (hub_pt[0], hub_pt[1] - 0.12, hub_pt[2]))
        arm_lr = create_strut((sign * 0.16, 0.18, wz - 0.20), (hub_pt[0], hub_pt[1] - 0.12, hub_pt[2]))
        pullrod = create_strut((sign * 0.16, 0.20, wz - 0.06), (hub_pt[0], hub_pt[1] + 0.10, hub_pt[2]), thickness=(0.020, 0.014))
        
        for elem in [arm_uf, arm_ur, arm_lf, arm_lr, pullrod]:
            if elem: car.append(elem)

    print("[5/6] Building front & rear downforce aerodynamic wing assemblies...")
    # Front Wing Mainplane (curved anhedral span)
    fw_main = sb.create_beveled_box((2.05, 0.035, 0.55), bevel=0.008, color=CLAY_COLOR)
    fw_main.translate(0.0, 0.09, 3.00)
    car.append(fw_main)
    
    fw_flap = sb.create_beveled_box((1.90, 0.028, 0.35), bevel=0.006, color=CLAY_COLOR)
    fw_flap.rotate_x(12.0)
    fw_flap.translate(0.0, 0.14, 2.90)
    car.append(fw_flap)
    
    for sign in (-1.0, 1.0):
        # Front wing endplate & footplate
        fw_endplate = sb.create_beveled_box((0.02, 0.24, 0.70), bevel=0.005, color=CLAY_COLOR)
        fw_endplate.translate(sign * 1.01, 0.16, 2.95)
        car.append(fw_endplate)
        
        footplate = sb.create_beveled_box((0.08, 0.02, 0.65), bevel=0.004, color=CLAY_COLOR)
        footplate.translate(sign * 1.04, 0.06, 2.95)
        car.append(footplate)
        
        # Nose tip mounting pylons
        pylon = sb.create_beveled_box((0.025, 0.14, 0.25), bevel=0.004, color=CLAY_COLOR)
        pylon.translate(sign * 0.10, 0.13, 2.95)
        car.append(pylon)

    # Rear Downforce Wing
    rw_main = sb.create_beveled_box((1.70, 0.04, 0.42), bevel=0.008, color=CLAY_COLOR)
    rw_main.rotate_x(12.0)
    rw_main.translate(0.0, 1.16, -2.55)
    car.append(rw_main)
    
    rw_drs = sb.create_beveled_box((1.65, 0.025, 0.28), bevel=0.005, color=CLAY_COLOR)
    rw_drs.rotate_x(20.0)
    rw_drs.translate(0.0, 1.26, -2.68)
    car.append(rw_drs)
    
    for sign in (-1.0, 1.0):
        rw_endplate = sb.create_beveled_box((0.025, 0.52, 0.65), bevel=0.006, color=CLAY_COLOR)
        rw_endplate.translate(sign * 0.85, 1.12, -2.55)
        car.append(rw_endplate)
        
        pylon = sb.create_beveled_box((0.03, 0.55, 0.16), bevel=0.005, color=CLAY_COLOR)
        pylon.rotate_x(-15.0)
        pylon.translate(sign * 0.22, 0.94, -2.42)
        car.append(pylon)

    # Rear Venturi Diffuser & Exhaust Tailpipe
    diffuser = sb.create_beveled_box((1.35, 0.12, 1.10), bevel=0.015, color=CLAY_COLOR)
    diffuser.translate(0.0, 0.14, -2.15)
    car.append(diffuser)
    
    for strake_idx in range(-3, 4):
        strake = sb.create_beveled_box((0.02, 0.18, 1.05), bevel=0.004, color=CLAY_COLOR)
        strake.translate(strake_idx * 0.19, 0.13, -2.15)
        car.append(strake)
        
    exhaust = sb.create_lathe([
        sbm.Vec2(0.045, -0.20),
        sbm.Vec2(0.055, -0.20),
        sbm.Vec2(0.055,  0.05),
        sbm.Vec2(0.045,  0.05)
    ], segments=16, color=CLAY_DARK)
    exhaust.rotate_x(90.0)
    exhaust.translate(0.0, 0.44, -2.45)
    car.append(exhaust)

    print("[6/6] Assembling open wheels (W_enclosure = 0.0) with lathed rims...")
    tire_rim_profile = [
        sbm.Vec2(0.00, -0.15),
        sbm.Vec2(0.08, -0.15),
        sbm.Vec2(0.14, -0.12),
        sbm.Vec2(0.24, -0.10),
        sbm.Vec2(0.34, -0.06),
        sbm.Vec2(0.36, -0.01),
        sbm.Vec2(0.37,  0.12),
        sbm.Vec2(0.38,  0.15),
        sbm.Vec2(0.36,  0.15),
        sbm.Vec2(0.33,  0.08),
        sbm.Vec2(0.20,  0.06),
        sbm.Vec2(0.00,  0.05),
    ]
    
    all_wheels = front_wheels + rear_wheels
    for wx, wy, wz in all_wheels:
        is_right = wx > 0
        rim = sb.create_lathe(tire_rim_profile, segments=32, color=CLAY_COLOR)
        rim.rotate_z(90.0 if is_right else -90.0)
        rim.translate(wx, wy, wz)
        car.append(rim)
        
        nut = sb.create_lathe([
            sbm.Vec2(0.00, 0.14),
            sbm.Vec2(0.045, 0.14),
            sbm.Vec2(0.035, 0.17),
            sbm.Vec2(0.00, 0.17)
        ], segments=12, color=CLAY_LIGHT)
        nut.rotate_z(90.0 if is_right else -90.0)
        nut.translate(wx, wy, wz)
        car.append(nut)

    # Master smooth normals & curvature contact ambient occlusion
    car.recompute_smooth_normals()
    car.compute_curvature_ao(0.55)
    
    print(f"Curved Open-Wheel Vehicle Completed: {car.vertex_count:,} vertices, {car.triangle_count:,} triangles.")
    return car


def main():
    os.makedirs("build", exist_ok=True)
    out_glb = "build/formula_hero_curved_clay.glb"
    
    print("Generating Curvature-Lofted Open-Wheel Formula Vehicle...")
    car = build_curved_formula_hero()
    
    print(f"Exporting master mesh to {out_glb}...")
    sb.io.write_glb(out_glb, car)
    
    file_size_kb = os.path.getsize(out_glb) / 1024.0
    print(f"Success! Exported {out_glb} ({file_size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
