"""
Scratchbox IDE - Hero Curved Architecture Generation via Python Bindings
Generates an advanced curvilinear architectural complex (Soaring Twisting Tower,
Entrance Rotunda, Skybridge, Fluted Colonnade Peristyle, and Beveled Podium)
adhering strictly to the 70-20-10 geometric form hierarchy and ADA principles.
"""

import os
import sys
import math

# Ensure local python bindings are found
sys.path.insert(0, os.path.abspath("packages/core/src/python"))
import scratchbox as sb
sbm = sb.math

# 18% Studio Grey Clay Palette
CLAY_PRIMARY = (0.55, 0.57, 0.60, 1.0)
CLAY_DARK    = (0.35, 0.37, 0.40, 1.0)
CLAY_ACCENT  = (0.70, 0.72, 0.75, 1.0)
CLAY_GLASS   = (0.42, 0.45, 0.48, 1.0)

def build_curved_architecture_hero():
    print("[1/5] Synthesizing Primary Edifice: Soaring Twisting Skyscraper Tower (70% Form)...")
    # 16-story curvilinear skyscraper with helical twist, mid-elevation entasis bulge,
    # superelliptic floorplate loft (m=2.4), and dome observation crown
    tower = sb.create_tower(
        width=20.0,
        depth=20.0,
        floors=16,
        floor_height=3.4,
        ground_floor_height=4.8,
        twist_degrees=48.0,
        taper=0.68,
        bulge=0.12,
        superellipse_exponent=2.35,
        bay_width=2.8,
        window_width=1.8,
        window_height=2.2,
        window_recess_depth=0.35,
        roof="dome",
        roof_height=5.2,
        bake_curvature_ao=True,
        name="SoaringTwistingTower"
    )
    tower.translate(0.0, 1.2, 0.0)

    print("[2/5] Synthesizing Secondary Edifice: Curvilinear Rotunda & Gallery Wing (20% Form)...")
    # Low-slung cultural rotunda and exhibition pavilion
    wing = sb.create_curved_building(
        width=22.0,
        depth=16.0,
        floors=4,
        floor_height=3.6,
        ground_floor_height=4.2,
        curvature=0.90,
        superellipse_exponent=2.15,
        twist_degrees=15.0,
        taper=0.88,
        bulge=0.08,
        roof="vault",
        roof_height=3.8,
        bay_width=2.5,
        bake_curvature_ao=True,
        name="GalleryRotundaWing"
    )
    wing.translate(18.0, 1.2, -6.0)

    # Master assembly mesh
    complex_mesh = sb.geometry.Mesh("HeroCurvedArchitectureComplex")
    complex_mesh.append(tower)
    complex_mesh.append(wing)

    print("[3/5] Synthesizing Articulated Elements: Lofted Skybridge & Observation Terraces...")
    # Curved skybridge connecting tower at level 6 (~22m elevation) to gallery roof terrace
    bridge = sb.create_beveled_box((12.0, 3.2, 3.6), bevel=0.25, color=CLAY_PRIMARY)
    bridge.rotate_y(-18.0)
    bridge.translate(9.0, 21.5, -3.2)
    complex_mesh.append(bridge)

    # Skybridge structural support arch (swept curvature)
    bridge_strut = sb.create_cylinder(radius=0.45, height=18.0, segments=24)
    bridge_strut.rotate_z(26.0)
    bridge_strut.translate(10.0, 10.5, -3.2)
    complex_mesh.append(bridge_strut)

    print("[4/5] Synthesizing 10% Tertiary Micro-Detail: Fluted Peristyle Colonnade & Louvers...")
    # Peristyle fluted columns using Operator 2 (Harmonic Solid of Revolution)
    col_radius = 0.38
    col_height = 4.6
    rotunda_center_x = 18.0
    rotunda_center_z = -6.0
    num_columns = 16
    rotunda_rad = 12.5

    column_profile = [
        sbm.Vec2(0.00, 0.00),
        sbm.Vec2(col_radius * 1.35, 0.00),
        sbm.Vec2(col_radius * 1.35, 0.35),
        sbm.Vec2(col_radius, 0.55),
        sbm.Vec2(col_radius * 0.92, col_height * 0.5), # Subtle classical entasis
        sbm.Vec2(col_radius, col_height - 0.55),
        sbm.Vec2(col_radius * 1.35, col_height - 0.35),
        sbm.Vec2(col_radius * 1.35, col_height),
        sbm.Vec2(0.00, col_height)
    ]

    for c_idx in range(num_columns):
        angle = (2.0 * math.pi * c_idx) / num_columns
        cx = rotunda_center_x + rotunda_rad * math.cos(angle)
        cz = rotunda_center_z + rotunda_rad * 0.75 * math.sin(angle)
        
        col = sb.create_lathe(column_profile, segments=20, color=CLAY_ACCENT)
        col.translate(cx, 1.2, cz)
        complex_mesh.append(col)

    # Multi-tier Beveled Podium Plinth with reveal steps
    plinth_tier1 = sb.create_beveled_box((54.0, 0.6, 44.0), bevel=0.15, color=CLAY_DARK)
    plinth_tier1.translate(8.0, 0.3, -3.0)
    complex_mesh.append(plinth_tier1)

    plinth_tier2 = sb.create_beveled_box((50.0, 0.6, 40.0), bevel=0.12, color=CLAY_PRIMARY)
    plinth_tier2.translate(8.0, 0.9, -3.0)
    complex_mesh.append(plinth_tier2)

    # Entrance Grand Staircase (stepped reveals)
    for step_i in range(6):
        step_h = 0.20
        step_d = 0.60
        step = sb.create_beveled_box((14.0, step_h, step_d), bevel=0.03, color=CLAY_ACCENT)
        step.translate(0.0, step_i * step_h + 0.1, 11.0 + (5 - step_i) * step_d)
        complex_mesh.append(step)

    # Sunshade louvers on south-facing tower facade (Operator 3 Metric Replicator)
    for floor_idx in range(2, 14):
        fy = 1.2 + 4.8 + floor_idx * 3.4
        louver_w = 12.0 * (1.0 - 0.28 * (floor_idx / 16.0))
        louver = sb.create_beveled_box((louver_w, 0.12, 0.85), bevel=0.02, color=CLAY_DARK)
        # Follow helical twist angle at this elevation
        twist_rad = (48.0 * (floor_idx / 16.0)) * math.pi / 180.0
        louver.rotate_y(twist_rad * 180.0 / math.pi)
        louver.translate(0.0, fy + 2.4, 0.0)
        complex_mesh.append(louver)

    print("[5/5] Recomputing Smooth Normals & Baking Vertex Curvature Ambient Occlusion...")
    complex_mesh.recompute_smooth_normals()
    complex_mesh.compute_curvature_ao(0.70)

    print(f"Curved Architecture Complex Complete: {complex_mesh.vertex_count:,} vertices | {complex_mesh.triangle_count:,} triangles.")
    return complex_mesh

def main():
    os.makedirs("build", exist_ok=True)
    out_glb = "build/curved_tower_hero_clay.glb"

    print("Generating Hero Curved Architecture Asset...")
    model = build_curved_architecture_hero()

    print(f"Exporting master mesh to {out_glb}...")
    sb.io.write_glb(out_glb, model)

    file_size_kb = os.path.getsize(out_glb) / 1024.0
    print(f"Success! Exported {out_glb} ({file_size_kb:.1f} KB)")

if __name__ == "__main__":
    main()
