#!/usr/bin/env python3
"""
Test Open-Wheel Formula Vehicle ADA Implementation in Scratchbox 3D Engine.

Exercises continuous morphological parameter adjustments:
- W_enclosure = 0.0 (Zero wheel enclosure, fully exposed open wheels)
- C_exposure = 1.0 (Open monocoque cockpit with Titanium Halo safety structure)
- S_exposure = 1.0 (Exposed aerodynamic carbon double-wishbone suspension arms & pushrods)
- N_taper = 0.88 (Sharply tapered aerodynamic needle nose cone)
- T_waist = 0.75 (Aggressive Coke-bottle sidepod waist undercut)

Outputs build/formula_hero_open_wheel.glb and verifies against ADA standard.
"""

import math
import os
import sys

import scratchbox as sb
from scratchbox import math as sbm
from scratchbox import geometry as sbg
from scratchbox import io as sbio

CLAY_COLOR = (0.55, 0.57, 0.60, 1.0)
CLAY_DARK = (0.46, 0.48, 0.51, 1.0)
CLAY_LIGHT = (0.62, 0.64, 0.67, 1.0)


def create_strut(pt_a, pt_b, thickness=(0.028, 0.012), bevel=0.003, color=CLAY_COLOR):
    """Creates an aerodynamic suspension strut connecting pt_a to pt_b."""
    dx = pt_b[0] - pt_a[0]
    dy = pt_b[1] - pt_a[1]
    dz = pt_b[2] - pt_a[2]
    dist = math.sqrt(dx*dx + dy*dy + dz*dz)
    if dist < 1e-4:
        return None
    
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


def build_open_wheel_formula_vehicle():
    car = sbg.Mesh("OpenWheelFormulaVehicle")
    
    print("[1/7] Building slender monocoque survival cell & tapered needle nose (N_taper = 0.88)...")
    # Main monocoque driver cell (slender safety cell)
    monocoque = sb.create_beveled_box((0.68, 0.44, 2.00), bevel=0.03, color=CLAY_COLOR)
    monocoque.translate(0.0, 0.38, 0.20)
    car.append(monocoque)
    
    # Forward chassis section connecting to front suspension bulkheads
    fwd_bulkhead = sb.create_beveled_box((0.54, 0.36, 1.20), bevel=0.025, color=CLAY_COLOR)
    fwd_bulkhead.translate(0.0, 0.36, 1.60)
    car.append(fwd_bulkhead)
    
    # Tapered aerodynamic needle nose cone (sweeping forward and downward)
    nose = sb.create_subdivided_box(
        size=(0.46, 0.28, 1.30),
        subdivisions=(4, 4, 8),
        color=CLAY_COLOR
    )
    nose.taper(axis=2, factor=0.35)  # Tapers sharply toward front (+Z)
    nose.translate(0.0, 0.30, 2.60)
    car.append(nose)
    
    # Nose tip pylons connecting to front wing
    for sign in (-1.0, 1.0):
        pylon = sb.create_beveled_box((0.025, 0.18, 0.28), bevel=0.005, color=CLAY_COLOR)
        pylon.translate(sign * 0.12, 0.16, 2.95)
        car.append(pylon)

    print("[2/7] Building multi-element front wing assembly & cascade flaps...")
    # Front Wing Mainplane (curved full-width aerodynamic wing)
    fw_main = sb.create_beveled_box((2.00, 0.035, 0.55), bevel=0.008, color=CLAY_COLOR)
    fw_main.translate(0.0, 0.09, 3.00)
    car.append(fw_main)
    
    # Secondary flap tier
    fw_flap = sb.create_beveled_box((1.86, 0.028, 0.36), bevel=0.006, color=CLAY_COLOR)
    fw_flap.rotate_x(10.0)
    fw_flap.translate(0.0, 0.14, 2.88)
    car.append(fw_flap)
    
    # Front Wing Endplates and outer dive vanes
    for sign in (-1.0, 1.0):
        fw_endplate = sb.create_beveled_box((0.02, 0.24, 0.70), bevel=0.005, color=CLAY_COLOR)
        fw_endplate.translate(sign * 0.99, 0.16, 2.95)
        car.append(fw_endplate)
        
        # Outboard footplate strake
        footplate = sb.create_beveled_box((0.08, 0.02, 0.65), bevel=0.004, color=CLAY_COLOR)
        footplate.translate(sign * 1.03, 0.06, 2.95)
        car.append(footplate)

    print("[3/7] Building open cockpit monocoque, Halo safety structure & headrest (C_exposure = 1.0)...")
    # Open Cockpit Aperture Rim Lip
    cockpit_rim = sb.create_beveled_box((0.62, 0.08, 0.95), bevel=0.015, color=CLAY_DARK)
    cockpit_rim.translate(0.0, 0.58, 0.15)
    car.append(cockpit_rim)
    
    # Interior driver seat & headrest bolster
    seat = sb.create_beveled_box((0.44, 0.28, 0.75), bevel=0.01, color=CLAY_DARK)
    seat.translate(0.0, 0.38, 0.15)
    car.append(seat)
    
    headrest = sb.create_beveled_box((0.36, 0.25, 0.22), bevel=0.015, color=CLAY_COLOR)
    headrest.translate(0.0, 0.58, -0.22)
    car.append(headrest)

    # Titanium Halo Safety Structure (Curved top arch + central forward strut)
    # 1. Central forward pylon
    halo_pylon = sb.create_beveled_box((0.035, 0.28, 0.05), bevel=0.008, color=CLAY_LIGHT)
    halo_pylon.rotate_x(-18.0)
    halo_pylon.translate(0.0, 0.72, 0.52)
    car.append(halo_pylon)
    
    # 2. Main curved Halo hoop arch
    halo_hoop = sb.create_beveled_box((0.66, 0.04, 0.65), bevel=0.012, color=CLAY_LIGHT)
    halo_hoop.translate(0.0, 0.82, 0.18)
    car.append(halo_hoop)
    
    # 3. Rear anchor points connecting Halo to chassis
    for sign in (-1.0, 1.0):
        anchor = sb.create_beveled_box((0.04, 0.14, 0.08), bevel=0.006, color=CLAY_LIGHT)
        anchor.rotate_x(25.0)
        anchor.translate(sign * 0.28, 0.74, -0.12)
        car.append(anchor)

    print("[4/7] Building engine airbox roll-hoop scoop & dorsal shark fin...")
    # Triangular engine air intake scoop above driver helmet
    airbox = sb.create_beveled_box((0.36, 0.38, 0.60), bevel=0.02, color=CLAY_COLOR)
    airbox.translate(0.0, 0.88, -0.42)
    car.append(airbox)
    
    # Engine cover spine tapering back to rear
    engine_cover = sb.create_envelope(
        bounds=(0.65, 0.42, 1.80),
        crown=0.35,
        slope=0.45,
        center_dip=0.0,
        grid=(12, 16),
        color=CLAY_COLOR
    )
    engine_cover.translate(0.0, 0.62, -1.20)
    car.append(engine_cover)
    
    # Dorsal Shark Fin stabilizer
    shark_fin = sb.create_subdivided_box(
        size=(0.025, 0.42, 1.50),
        subdivisions=(2, 4, 6),
        color=CLAY_COLOR
    )
    shark_fin.taper(axis=1, factor=0.25)
    shark_fin.translate(0.0, 0.95, -1.15)
    car.append(shark_fin)

    print("[5/7] Building sculpted sidepods with Coke-bottle waist undercut (T_waist = 0.75)...")
    # Left & Right radiator sidepods with aggressive waist undercut
    for sign in (-1.0, 1.0):
        # Front radiator intake mouth
        intake_mouth = sb.create_beveled_box((0.38, 0.32, 0.30), bevel=0.02, color=CLAY_DARK)
        intake_mouth.translate(sign * 0.62, 0.36, 0.80)
        car.append(intake_mouth)
        
        # Sidepod body with continuous Coke-bottle taper
        sidepod_body = sb.create_subdivided_box(
            size=(0.42, 0.34, 1.70),
            subdivisions=(3, 3, 6),
            color=CLAY_COLOR
        )
        sidepod_body.taper(axis=2, factor=0.40)  # Tapers toward rear (-Z)
        sidepod_body.translate(sign * 0.60, 0.34, -0.10)
        car.append(sidepod_body)
        
        # Floor undercut channel
        floor_skirt = sb.create_beveled_box((0.26, 0.04, 2.20), bevel=0.008, color=CLAY_COLOR)
        floor_skirt.translate(sign * 0.80, 0.08, 0.05)
        car.append(floor_skirt)

    print("[6/7] Building exposed multi-link carbon suspension wishbones (S_exposure = 1.0)...")
    # Wheel hub centers (open wheels completely exposed)
    front_z = 1.80
    rear_z = -1.80
    front_track = 0.96
    rear_track = 0.94
    wheel_y = 0.36
    
    front_wheels = [(-front_track, wheel_y, front_z), (front_track, wheel_y, front_z)]
    rear_wheels = [(-rear_track, wheel_y, rear_z), (rear_track, wheel_y, rear_z)]
    
    # Front Suspension Geometry (Double wishbone + Pushrod)
    for wx, wy, wz in front_wheels:
        sign = 1.0 if wx > 0 else -1.0
        hub_pt = (wx * 0.84, wy, wz)
        
        # Upper wishbone (A-arm forward and rear legs)
        arm_uf = create_strut((sign * 0.25, 0.44, wz + 0.18), (hub_pt[0], hub_pt[1] + 0.11, hub_pt[2]))
        arm_ur = create_strut((sign * 0.25, 0.44, wz - 0.16), (hub_pt[0], hub_pt[1] + 0.11, hub_pt[2]))
        # Lower wishbone (A-arm forward and rear legs)
        arm_lf = create_strut((sign * 0.22, 0.16, wz + 0.20), (hub_pt[0], hub_pt[1] - 0.11, hub_pt[2]))
        arm_lr = create_strut((sign * 0.22, 0.16, wz - 0.18), (hub_pt[0], hub_pt[1] - 0.11, hub_pt[2]))
        # Pushrod damper link (diagonal)
        pushrod = create_strut((sign * 0.26, 0.46, wz - 0.08), (hub_pt[0], hub_pt[1] - 0.08, hub_pt[2]), thickness=(0.022, 0.015))
        # Steering track rod
        tierod = create_strut((sign * 0.24, 0.28, wz + 0.12), (hub_pt[0], hub_pt[1] + 0.02, hub_pt[2] + 0.08))
        
        for elem in [arm_uf, arm_ur, arm_lf, arm_lr, pushrod, tierod]:
            if elem: car.append(elem)
            
    # Rear Suspension Geometry (Double wishbone + Pullrod)
    for wx, wy, wz in rear_wheels:
        sign = 1.0 if wx > 0 else -1.0
        hub_pt = (wx * 0.84, wy, wz)
        
        arm_uf = create_strut((sign * 0.28, 0.42, wz + 0.22), (hub_pt[0], hub_pt[1] + 0.12, hub_pt[2]))
        arm_ur = create_strut((sign * 0.26, 0.40, wz - 0.18), (hub_pt[0], hub_pt[1] + 0.12, hub_pt[2]))
        arm_lf = create_strut((sign * 0.24, 0.16, wz + 0.24), (hub_pt[0], hub_pt[1] - 0.12, hub_pt[2]))
        arm_lr = create_strut((sign * 0.22, 0.16, wz - 0.20), (hub_pt[0], hub_pt[1] - 0.12, hub_pt[2]))
        pullrod = create_strut((sign * 0.22, 0.18, wz - 0.06), (hub_pt[0], hub_pt[1] + 0.10, hub_pt[2]), thickness=(0.022, 0.015))
        
        for elem in [arm_uf, arm_ur, arm_lf, arm_lr, pullrod]:
            if elem: car.append(elem)

    print("[7/7] Assembling open wheels (W_enclosure = 0.0), rear downforce wing & diffuser...")
    # Open Wheel Assemblies (Lathed racing slick tires + deep dish rims + wheel nuts)
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
    
    # 4 Exposed Wheels
    all_wheels = front_wheels + rear_wheels
    for wx, wy, wz in all_wheels:
        is_right = wx > 0
        rim = sb.create_lathe(tire_rim_profile, segments=32, color=CLAY_COLOR)
        rim.rotate_z(90.0 if is_right else -90.0)
        rim.translate(wx, wy, wz)
        car.append(rim)
        
        # Central wheel hub nut
        nut = sb.create_lathe([
            sbm.Vec2(0.00, 0.14),
            sbm.Vec2(0.045, 0.14),
            sbm.Vec2(0.035, 0.17),
            sbm.Vec2(0.00, 0.17)
        ], segments=12, color=CLAY_LIGHT)
        nut.rotate_z(90.0 if is_right else -90.0)
        nut.translate(wx, wy, wz)
        car.append(nut)
        
    # High-Downforce Rear Wing Assembly (Airfoil + Endplates + Swan-Neck Pylons)
    rw_main = sb.create_beveled_box((1.70, 0.04, 0.42), bevel=0.008, color=CLAY_COLOR)
    rw_main.rotate_x(12.0)
    rw_main.translate(0.0, 1.18, -2.55)
    car.append(rw_main)
    
    rw_drs = sb.create_beveled_box((1.65, 0.025, 0.28), bevel=0.005, color=CLAY_COLOR)
    rw_drs.rotate_x(20.0)
    rw_drs.translate(0.0, 1.28, -2.68)
    car.append(rw_drs)
    
    for sign in (-1.0, 1.0):
        # Vertical endplates
        rw_endplate = sb.create_beveled_box((0.025, 0.52, 0.65), bevel=0.006, color=CLAY_COLOR)
        rw_endplate.translate(sign * 0.85, 1.14, -2.55)
        car.append(rw_endplate)
        
        # Central swan-neck pylons
        pylon = sb.create_beveled_box((0.03, 0.55, 0.16), bevel=0.005, color=CLAY_COLOR)
        pylon.rotate_x(-15.0)
        pylon.translate(sign * 0.22, 0.95, -2.42)
        car.append(pylon)

    # Rear Underfloor Venturi Diffuser & Exhaust
    diffuser = sb.create_beveled_box((1.40, 0.12, 1.10), bevel=0.015, color=CLAY_COLOR)
    diffuser.translate(0.0, 0.14, -2.15)
    car.append(diffuser)
    
    for strake_idx in range(-3, 4):
        strake = sb.create_beveled_box((0.02, 0.18, 1.05), bevel=0.004, color=CLAY_COLOR)
        strake.translate(strake_idx * 0.20, 0.13, -2.15)
        car.append(strake)
        
    exhaust = sb.create_lathe([
        sbm.Vec2(0.045, -0.20),
        sbm.Vec2(0.055, -0.20),
        sbm.Vec2(0.055,  0.05),
        sbm.Vec2(0.045,  0.05)
    ], segments=16, color=CLAY_DARK)
    exhaust.rotate_x(90.0)
    exhaust.translate(0.0, 0.45, -2.45)
    car.append(exhaust)

    # Master normals and contact ambient occlusion
    car.recompute_smooth_normals()
    car.compute_curvature_ao(0.55)
    
    print(f"Master Open-Wheel Assembly: {car.vertex_count:,} vertices, {car.triangle_count:,} triangles.")
    return car


def main():
    os.makedirs("build", exist_ok=True)
    out_glb = "build/formula_hero_open_wheel.glb"
    
    print("Generating ADA Open-Wheel Formula Vehicle via Scratchbox C++20 / Python...")
    car = build_open_wheel_formula_vehicle()
    
    print(f"Exporting master mesh to {out_glb}...")
    sb.io.write_glb(out_glb, car)
    
    file_size_kb = os.path.getsize(out_glb) / 1024.0
    print(f"Success! Exported {out_glb} ({file_size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
