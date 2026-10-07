#!/usr/bin/env python3
"""
Test Nanobind Routing Layer & Continuous Native Primitives in Scratchbox 3D Engine.

Constructs an authentic Hero Hypercar in 18% Studio Grey Clay staged in a 3D stage void,
exercising:
1. sb.create_beveled_box (Prismatic plates with calibrated specular chamfers)
2. sb.create_envelope (Double-curved continuous aerodynamic surfaces)
3. sb.create_arched_blister (Radial arched wheel blisters with circular openings)
4. sb.create_lathe (High-definition rotational solids for wheels & exhausts)
5. sb.create_subdivided_box with .subdivide() and .taper() (Deformed aerodynamic fins)
6. sb.create_form (Universal ADA Continuum parameter routing)

All parts are merged into a master Mesh with curvature-based ambient occlusion (AO)
and exported directly to build/nanobind_hero_hypercar.glb.
"""

import math
import os
import sys

import scratchbox as sb
from scratchbox import math as sbm
from scratchbox import geometry as sbg
from scratchbox import io as sbio

# 18% Studio Grey Clay Color
CLAY_COLOR = (0.55, 0.57, 0.60, 1.0)
CLAY_DARK = (0.45, 0.47, 0.50, 1.0)
CLAY_LIGHT = (0.62, 0.64, 0.67, 1.0)


def build_hero_scene():
    car = sbg.Mesh("NanobindHeroHypercar")

    print("[1/6] Building structural monocoque chassis & layout plates via sb.create_beveled_box...")
    
    # 1. Main Lower Monocoque Chassis Floor (stiff structural plinth)
    chassis_floor = sb.create_beveled_box((2.15, 0.24, 4.70), bevel=0.02, color=CLAY_COLOR)
    chassis_floor.translate(0.0, 0.20, 0.0)
    car.append(chassis_floor)

    # 2. Cockpit Lower Tub & Side Pods (Enclosing cockpit sides)
    cockpit_tub = sb.create_beveled_box((1.70, 0.38, 2.20), bevel=0.02, color=CLAY_COLOR)
    cockpit_tub.translate(0.0, 0.48, -0.05)
    car.append(cockpit_tub)

    # Left & Right Aerodynamic Side Pods with cooling radiators
    for sign in (-1.0, 1.0):
        sidepod = sb.create_beveled_box((0.28, 0.32, 1.80), bevel=0.015, color=CLAY_COLOR)
        sidepod.translate(sign * 0.98, 0.44, -0.05)
        car.append(sidepod)

    # 3. Dual-Tier Front Aerodynamic Splitter
    splitter_main = sb.create_beveled_box((2.35, 0.05, 0.85), bevel=0.015, color=CLAY_COLOR)
    splitter_main.translate(0.0, 0.10, 2.50)
    car.append(splitter_main)

    splitter_upper = sb.create_beveled_box((2.10, 0.04, 0.45), bevel=0.01, color=CLAY_COLOR)
    splitter_upper.translate(0.0, 0.18, 2.40)
    car.append(splitter_upper)

    # Splitter vertical fences / grille slats
    for ix in range(-4, 5):
        fence = sb.create_beveled_box((0.025, 0.12, 0.35), bevel=0.005, color=CLAY_COLOR)
        fence.translate(ix * 0.18, 0.14, 2.45)
        car.append(fence)

    # Front dive plane canards (dual tier)
    for sign in (-1.0, 1.0):
        for tier, y_off, z_off in [(1, 0.28, 2.25), (2, 0.42, 2.15)]:
            canard = sb.create_beveled_box((0.38, 0.025, 0.25), bevel=0.005, color=CLAY_COLOR)
            canard.rotate_y(sign * 18.0)
            canard.rotate_z(sign * 12.0)
            canard.translate(sign * 1.16, y_off, z_off)
            car.append(canard)

    # 4. Ground Effect Side Skirts running along the wheelbase
    for sign in (-1.0, 1.0):
        skirt = sb.create_beveled_box((0.24, 0.08, 2.75), bevel=0.01, color=CLAY_COLOR)
        skirt.translate(sign * 1.15, 0.12, 0.0)
        car.append(skirt)

        skirt_fin = sb.create_beveled_box((0.03, 0.22, 0.35), bevel=0.005, color=CLAY_COLOR)
        skirt_fin.translate(sign * 1.24, 0.18, 1.15)
        car.append(skirt_fin)

    # 5. Rear Aerodynamic Diffuser with 6 Vertical Strakes
    diffuser = sb.create_beveled_box((2.20, 0.14, 0.95), bevel=0.015, color=CLAY_COLOR)
    diffuser.translate(0.0, 0.16, -2.48)
    car.append(diffuser)

    for strake_idx in range(-3, 4):
        if strake_idx == 0: continue
        strake = sb.create_beveled_box((0.025, 0.22, 0.90), bevel=0.005, color=CLAY_COLOR)
        strake.translate(strake_idx * 0.28, 0.14, -2.48)
        car.append(strake)

    # 6. Active GT Rear Wing (Blade + Endplates + Swan-Neck Pylons)
    main_wing = sb.create_beveled_box((2.50, 0.045, 0.50), bevel=0.01, color=CLAY_COLOR)
    main_wing.rotate_x(6.0)
    main_wing.translate(0.0, 1.28, -2.15)
    car.append(main_wing)

    for sign in (-1.0, 1.0):
        endplate = sb.create_beveled_box((0.03, 0.32, 0.60), bevel=0.005, color=CLAY_COLOR)
        endplate.translate(sign * 1.26, 1.28, -2.15)
        car.append(endplate)

        pylon = sb.create_beveled_box((0.04, 0.55, 0.18), bevel=0.005, color=CLAY_COLOR)
        pylon.rotate_x(-12.0)
        pylon.translate(sign * 0.62, 0.98, -2.05)
        car.append(pylon)

    print("[2/6] Building continuous aerodynamic body panels via sb.create_envelope & sb.create_form...")
    
    # 1. Crowned Aerodynamic Hood
    hood = sb.create_envelope(
        bounds=(1.85, 0.30, 1.80),
        crown=0.35,
        slope=0.40,
        center_dip=0.10,
        grid=(16, 16),
        color=CLAY_COLOR
    )
    hood.translate(0.0, 0.44, 1.45)
    car.append(hood)

    # 2. Fastback Sloping Rear Engine Deck & Cowl via ADA sb.create_form
    rear_deck = sb.create_form(
        bounds=(1.90, 0.25, 1.65),
        curvature=0.25,
        slope=-0.25,
        center_dip=0.04,
        grid_x=16,
        grid_z=16,
        color=CLAY_COLOR
    )
    rear_deck.translate(0.0, 0.52, -1.35)
    car.append(rear_deck)

    # 3. Aerodynamic Teardrop Cockpit Canopy
    canopy = sb.create_envelope(
        bounds=(1.42, 0.54, 2.10),
        crown=0.50,
        slope=0.20,
        center_dip=0.02,
        grid=(16, 16),
        color=(0.58, 0.60, 0.63, 1.0)
    )
    canopy.translate(0.0, 0.72, -0.05)
    car.append(canopy)

    print("[3/6] Building arched wheel fenders via sb.create_arched_blister...")
    # Front Wheel Arches (left and right, flared over front wheels)
    for side in (-1.0, 1.0):
        front_fender = sb.create_arched_blister(
            bounds=(0.36, 0.48, 1.45),
            arch_radius=0.46,
            swell=0.08,
            side=side,
            grid=(16, 8),
            color=CLAY_COLOR
        )
        front_fender.translate(side * 0.88, 0.36, 1.45)
        car.append(front_fender)

    # Rear Muscular Haunches (left and right, flared over rear wheels)
    for side in (-1.0, 1.0):
        rear_haunch = sb.create_arched_blister(
            bounds=(0.44, 0.55, 1.65),
            arch_radius=0.48,
            swell=0.10,
            side=side,
            grid=(16, 8),
            color=CLAY_COLOR
        )
        rear_haunch.translate(side * 0.92, 0.38, -1.45)
        car.append(rear_haunch)

    print("[4/6] Building dorsal shark fin via sb.create_subdivided_box with .taper()...")
    fin = sb.create_subdivided_box(
        size=(0.04, 0.45, 1.30),
        subdivisions=(2, 4, 6),
        color=CLAY_COLOR
    )
    fin.taper(axis=1, factor=0.30)  # Narrow apex
    fin.translate(0.0, 0.88, -1.15)
    car.append(fin)

    print("[5/6] Building rotational solids (deep-dish rims, brake discs, exhausts) via sb.create_lathe...")
    # Lathed Rim Profile (Hub, deep barrel, outer bead lip)
    rim_profile = [
        sbm.Vec2(0.00, -0.14),
        sbm.Vec2(0.08, -0.14),
        sbm.Vec2(0.12, -0.11),
        sbm.Vec2(0.24, -0.09),
        sbm.Vec2(0.38, -0.05),
        sbm.Vec2(0.40, -0.01),
        sbm.Vec2(0.42,  0.11),
        sbm.Vec2(0.44,  0.14),
        sbm.Vec2(0.40,  0.14),
        sbm.Vec2(0.36,  0.07),
        sbm.Vec2(0.22,  0.05),
        sbm.Vec2(0.00,  0.04),
    ]

    rotor_profile = [
        sbm.Vec2(0.08, -0.015),
        sbm.Vec2(0.28, -0.015),
        sbm.Vec2(0.28,  0.015),
        sbm.Vec2(0.08,  0.015),
    ]

    exhaust_profile = [
        sbm.Vec2(0.045, -0.15),
        sbm.Vec2(0.055, -0.15),
        sbm.Vec2(0.058,  0.05),
        sbm.Vec2(0.050,  0.06),
        sbm.Vec2(0.045,  0.05),
    ]

    wheel_coords = [
        (-1.02, 0.36,  1.45), # Front Left
        ( 1.02, 0.36,  1.45), # Front Right
        (-1.05, 0.38, -1.45), # Rear Left
        ( 1.05, 0.38, -1.45), # Rear Right
    ]

    for wx, wy, wz in wheel_coords:
        is_right = wx > 0
        rim = sb.create_lathe(rim_profile, segments=28, color=CLAY_COLOR)
        rim.rotate_z(90.0 if is_right else -90.0)
        rim.translate(wx, wy, wz)
        car.append(rim)

        # Perforated brake disc
        rotor = sb.create_lathe(rotor_profile, segments=24, color=(0.48, 0.50, 0.53, 1.0))
        rotor.rotate_z(90.0)
        rotor.translate(wx * 0.90, wy, wz)
        car.append(rotor)

        # Caliper
        caliper = sb.create_beveled_box((0.08, 0.14, 0.08), bevel=0.005, color=(0.60, 0.62, 0.65, 1.0))
        caliper.translate(wx * 0.88, wy + 0.16, wz + 0.06)
        car.append(caliper)

    # Quad exhaust nozzle cluster
    for ex in [-0.18, -0.06, 0.06, 0.18]:
        nozzle = sb.create_lathe(exhaust_profile, segments=16, color=(0.50, 0.52, 0.55, 1.0))
        nozzle.rotate_x(90.0)
        nozzle.translate(ex, 0.36, -2.52)
        car.append(nozzle)

    print("[6/6] Building cockpit interior elements...")
    for side in (-1.0, 1.0):
        seat_base = sb.create_beveled_box((0.45, 0.12, 0.55), bevel=0.01, color=CLAY_COLOR)
        seat_base.translate(side * 0.32, 0.46, -0.05)
        car.append(seat_base)

        seat_back = sb.create_beveled_box((0.42, 0.52, 0.10), bevel=0.01, color=CLAY_COLOR)
        seat_back.rotate_x(-15.0)
        seat_back.translate(side * 0.32, 0.74, -0.28)
        car.append(seat_back)

    dash = sb.create_beveled_box((1.10, 0.20, 0.32), bevel=0.01, color=CLAY_COLOR)
    dash.translate(0.0, 0.66, 0.45)
    car.append(dash)

    # Finalize normals and calculate contact ambient occlusion
    car.recompute_smooth_normals()
    car.compute_curvature_ao(0.55)

    print(f"Master Mesh Assembly: {car.vertex_count:,} vertices, {car.triangle_count:,} triangles.")
    return car


def main():
    os.makedirs("build", exist_ok=True)
    out_glb = "build/nanobind_hero_hypercar.glb"

    print("Generating Hero Hypercar via Python Nanobind Routing Layer...")
    car = build_hero_scene()

    print(f"Exporting master mesh to {out_glb}...")
    sb.io.write_glb(out_glb, car)

    file_size_kb = os.path.getsize(out_glb) / 1024.0
    print(f"Success! Exported {out_glb} ({file_size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
