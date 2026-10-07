import math
import os
import scratchbox as sb

def generate_hero_hypercar():
    world = sb.World(seed=42)
    clay_mat = sb.PbrMaterial.clay()

    print("[1/4] Constructing 70% Primary Edifice (Monocoque Chassis & Cabin)...")
    # Main lower chassis
    chassis = sb.geometry.create_box(2.2, 0.45, 4.8, clay_mat)
    chassis.taper(0.25, 2) # Taper front and rear along Z
    chassis.translate(0, 0.35, 0)

    # Front hood & nose
    hood = sb.geometry.create_box(1.8, 0.3, 1.8, clay_mat)
    hood.taper(0.35, 2)
    hood.translate(0, 0.45, 1.3)
    chassis.append(hood)

    # Rear engine bay deck
    rear_deck = sb.geometry.create_box(1.9, 0.35, 1.6, clay_mat)
    rear_deck.taper(-0.15, 2)
    rear_deck.translate(0, 0.5, -1.3)
    chassis.append(rear_deck)

    # Aerodynamic cockpit glasshouse
    cockpit = sb.geometry.create_box(1.4, 0.55, 2.0, clay_mat)
    cockpit.taper(0.4, 2)
    cockpit.taper(0.25, 1) # Taper in Y
    cockpit.translate(0, 0.85, -0.1)
    chassis.append(cockpit)

    print("[2/4] Constructing 20% Secondary Articulated Assemblies...")
    # Front aerodynamic splitter
    splitter = sb.geometry.create_box(2.3, 0.08, 0.7, clay_mat)
    splitter.taper(0.2, 2)
    splitter.translate(0, 0.12, 2.45)
    chassis.append(splitter)

    # Splitter endplates (left & right)
    for side in (-1, 1):
        endplate = sb.geometry.create_box(0.06, 0.25, 0.6, clay_mat)
        endplate.translate(side * 1.15, 0.2, 2.45)
        chassis.append(endplate)

    # Rear aerodynamic diffuser
    diffuser = sb.geometry.create_box(2.1, 0.15, 0.8, clay_mat)
    diffuser.taper(-0.25, 2)
    diffuser.translate(0, 0.18, -2.45)
    chassis.append(diffuser)

    # Rear high-downforce GT wing
    wing_blade = sb.geometry.create_box(2.4, 0.06, 0.5, clay_mat)
    wing_blade.taper(0.15, 0) # Taper wingtips
    wing_blade.translate(0, 1.25, -2.1)
    chassis.append(wing_blade)

    # Wing vertical stanchions (swan necks)
    for side in (-1, 1):
        pylon = sb.geometry.create_box(0.06, 0.5, 0.2, clay_mat)
        pylon.translate(side * 0.6, 0.95, -2.0)
        chassis.append(pylon)
        wing_endplate = sb.geometry.create_box(0.04, 0.22, 0.55, clay_mat)
        wing_endplate.translate(side * 1.2, 1.25, -2.1)
        chassis.append(wing_endplate)

    # Side aerodynamic ground-effect skirts
    for side in (-1, 1):
        skirt = sb.geometry.create_box(0.2, 0.12, 2.6, clay_mat)
        skirt.translate(side * 1.12, 0.15, 0.0)
        chassis.append(skirt)

    # Aerodynamic side mirrors
    for side in (-1, 1):
        stalk = sb.geometry.create_box(0.25, 0.04, 0.06, clay_mat)
        stalk.translate(side * 0.82, 0.82, 0.6)
        chassis.append(stalk)
        mirror_cap = sb.geometry.create_box(0.22, 0.12, 0.14, clay_mat)
        mirror_cap.taper(0.3, 2)
        mirror_cap.translate(side * 0.95, 0.83, 0.6)
        chassis.append(mirror_cap)

    # 4 Detailed Wheel & Brake Assemblies
    wheel_positions = [
        ("FL", -1.15, 0.38, 1.45),
        ("FR",  1.15, 0.38, 1.45),
        ("RL", -1.18, 0.42, -1.45),
        ("RR",  1.18, 0.42, -1.45)
    ]

    for name, wx, wy, wz in wheel_positions:
        is_rear = wz < 0
        tire_radius = 0.42 if is_rear else 0.38
        tire_width = 0.36 if is_rear else 0.30

        # Outer tire
        tire = sb.geometry.create_cylinder(radius=tire_radius, height=tire_width, segments=32, material=clay_mat)
        tire.rotate_z(90)
        tire.translate(wx, wy, wz)
        chassis.append(tire)

        # Recessed wheel rim
        rim = sb.geometry.create_cylinder(radius=tire_radius * 0.78, height=tire_width * 0.9, segments=24, material=clay_mat)
        rim.rotate_z(90)
        rim.translate(wx, wy, wz)
        chassis.append(rim)

        # Center lock hub
        center_hub = sb.geometry.create_cylinder(radius=0.08, height=tire_width * 1.05, segments=16, material=clay_mat)
        center_hub.rotate_z(90)
        center_hub.translate(wx, wy, wz)
        chassis.append(center_hub)

        # Perforated brake rotor disc
        disc = sb.geometry.create_cylinder(radius=tire_radius * 0.65, height=0.04, segments=20, material=clay_mat)
        disc.rotate_z(90)
        disc.translate(wx * 0.88, wy, wz)
        chassis.append(disc)

        # Brake caliper
        caliper = sb.geometry.create_box(0.10, 0.18, 0.12, clay_mat)
        caliper.translate(wx * 0.88, wy + 0.16, wz)
        chassis.append(caliper)

    print("[3/4] Constructing 10% Tertiary Micro-Detail...")
    # Quad aerodynamic exhaust pipes
    for i, ex in enumerate([-0.35, -0.15, 0.15, 0.35]):
        pipe = sb.geometry.create_cylinder(radius=0.065, height=0.25, segments=16, material=clay_mat)
        pipe.rotate_x(90)
        pipe.translate(ex, 0.35, -2.42)
        chassis.append(pipe)

    # Central aerodynamic shark fin
    shark_fin = sb.geometry.create_box(0.04, 0.35, 1.4, clay_mat)
    shark_fin.taper(0.5, 1) # Taper along Y
    shark_fin.translate(0, 0.98, -1.0)
    chassis.append(shark_fin)

    # Hood louvers / heat extraction vents
    for louver_z in [0.8, 1.0, 1.2]:
        louver = sb.geometry.create_box(0.9, 0.03, 0.08, clay_mat)
        louver.translate(0, 0.58, louver_z)
        chassis.append(louver)

    # Front hex grille bezel
    grille = sb.geometry.create_box(1.2, 0.22, 0.08, clay_mat)
    grille.translate(0, 0.28, 2.38)
    chassis.append(grille)

    # Recalculate smooth normals & bounds
    chassis.recompute_smooth_normals()
    chassis.recompute_bounds()

    world.add(chassis)
    print(f"[4/4] Serializing to Binary GLB... (Vertices: {chassis.vertex_count}, Triangles: {chassis.triangle_count})")
    glb_data = world.build()

    out_path = "/Users/eligreen/dev/scratchbox-ide-master/build/hero_hypercar_clay.glb"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sb.io.write_glb(out_path, glb_data)
    print(f"Successfully generated hero hypercar GLB: {len(glb_data)} bytes at {out_path}")
    return out_path, glb_data, chassis.vertex_count, chassis.triangle_count

if __name__ == "__main__":
    generate_hero_hypercar()
