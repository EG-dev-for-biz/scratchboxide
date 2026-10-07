import math
import os
import scratchbox as sb

def generate_hero_hypercar():
    world = sb.World(seed=1337)
    clay_mat = sb.PbrMaterial.clay()

    print("[1/4] Constructing 70% Primary Edifice (Monocoque Chassis & Sculpted Body)...")
    # Main lower aerodynamic monocoque
    chassis = sb.geometry.create_box(2.2, 0.42, 4.8, clay_mat)
    chassis.taper(0.28, 2)
    chassis.translate(0, 0.35, 0)
    chassis.tessellate_and_displace(3, 0.0, 1.0, 0.0)

    # Front hood with sculpted center drop channel
    hood = sb.geometry.create_box(1.85, 0.28, 1.8, clay_mat)
    hood.taper(0.38, 2)
    hood.translate(0, 0.48, 1.3)
    hood.tessellate_and_displace(3, 0.0, 1.0, 0.0)
    chassis.append(hood)

    # Front wheel arches / front fenders (left & right)
    for side in (-1, 1):
        fender = sb.geometry.create_box(0.35, 0.45, 1.4, clay_mat)
        fender.bulge(0.2, 0)
        fender.translate(side * 1.05, 0.52, 1.45)
        chassis.append(fender)

    # Rear muscular haunches / rear fenders (left & right)
    for side in (-1, 1):
        haunch = sb.geometry.create_box(0.42, 0.52, 1.6, clay_mat)
        haunch.bulge(0.25, 0)
        haunch.translate(side * 1.10, 0.58, -1.45)
        chassis.append(haunch)

    # Rear engine bay deck & fastback cowl
    rear_deck = sb.geometry.create_box(1.92, 0.38, 1.7, clay_mat)
    rear_deck.taper(-0.20, 2)
    rear_deck.translate(0, 0.52, -1.35)
    rear_deck.tessellate_and_displace(3, 0.0, 1.0, 0.0)
    chassis.append(rear_deck)

    # Aerodynamic teardrop canopy / glasshouse
    canopy = sb.geometry.create_box(1.42, 0.52, 2.1, clay_mat)
    canopy.taper(0.42, 2) # Taper front to back
    canopy.taper(0.30, 1) # Taper in height
    canopy.translate(0, 0.86, -0.05)
    canopy.tessellate_and_displace(3, 0.0, 1.0, 0.0)
    chassis.append(canopy)

    # Cockpit interior: dual racing bucket seats & dash binnacle
    for side in (-1, 1):
        seat_base = sb.geometry.create_box(0.45, 0.15, 0.55, clay_mat)
        seat_base.translate(side * 0.32, 0.48, -0.05)
        chassis.append(seat_base)

        seat_back = sb.geometry.create_box(0.42, 0.55, 0.12, clay_mat)
        seat_back.rotate_x(-15)
        seat_back.translate(side * 0.32, 0.76, -0.28)
        chassis.append(seat_back)

    dash = sb.geometry.create_box(1.1, 0.22, 0.35, clay_mat)
    dash.translate(0, 0.68, 0.45)
    chassis.append(dash)

    steering_col = sb.geometry.create_cylinder(radius=0.03, height=0.35, segments=16, material=clay_mat)
    steering_col.rotate_x(45)
    steering_col.translate(-0.32, 0.68, 0.32)
    chassis.append(steering_col)

    steering_yoke = sb.geometry.create_box(0.32, 0.18, 0.04, clay_mat)
    steering_yoke.rotate_x(45)
    steering_yoke.translate(-0.32, 0.78, 0.22)
    chassis.append(steering_yoke)

    print("[2/4] Constructing 20% Secondary Articulated Assemblies...")
    # Front dual-tier carbon splitter with aero tunnels
    splitter_main = sb.geometry.create_box(2.35, 0.06, 0.85, clay_mat)
    splitter_main.taper(0.22, 2)
    splitter_main.translate(0, 0.10, 2.50)
    chassis.append(splitter_main)

    splitter_upper = sb.geometry.create_box(2.10, 0.04, 0.45, clay_mat)
    splitter_upper.translate(0, 0.20, 2.40)
    chassis.append(splitter_upper)

    # Front canards / dive planes (dual planes per side)
    for side in (-1, 1):
        for tier, y_off, z_off in [(1, 0.28, 2.25), (2, 0.42, 2.15)]:
            canard = sb.geometry.create_box(0.38, 0.03, 0.25, clay_mat)
            canard.rotate_y(side * 18)
            canard.rotate_z(side * 12)
            canard.translate(side * 1.16, y_off, z_off)
            chassis.append(canard)

    # Rear aerodynamic diffuser with 6 vertical downforce strakes
    diffuser = sb.geometry.create_box(2.20, 0.16, 0.95, clay_mat)
    diffuser.taper(-0.28, 2)
    diffuser.translate(0, 0.16, -2.48)
    chassis.append(diffuser)

    for strake_idx in range(-3, 4):
        if strake_idx == 0: continue
        strake_x = strake_idx * 0.28
        strake = sb.geometry.create_box(0.03, 0.22, 0.90, clay_mat)
        strake.translate(strake_x, 0.14, -2.48)
        chassis.append(strake)

    # Active aero high-downforce GT rear wing (main blade + flap)
    main_wing = sb.geometry.create_box(2.50, 0.05, 0.52, clay_mat)
    main_wing.taper(0.18, 0)
    main_wing.rotate_x(6)
    main_wing.translate(0, 1.28, -2.15)
    chassis.append(main_wing)

    gurney_flap = sb.geometry.create_box(2.45, 0.03, 0.06, clay_mat)
    gurney_flap.translate(0, 1.32, -2.40)
    chassis.append(gurney_flap)

    # Swan-neck wing pylons & endplates
    for side in (-1, 1):
        pylon = sb.geometry.create_box(0.05, 0.55, 0.24, clay_mat)
        pylon.rotate_x(-12)
        pylon.translate(side * 0.62, 0.98, -2.05)
        chassis.append(pylon)

        endplate = sb.geometry.create_box(0.04, 0.32, 0.62, clay_mat)
        endplate.translate(side * 1.26, 1.28, -2.15)
        chassis.append(endplate)

    # Ground effect side skirts & vortex generators
    for side in (-1, 1):
        skirt = sb.geometry.create_box(0.24, 0.10, 2.75, clay_mat)
        skirt.translate(side * 1.15, 0.12, 0.0)
        chassis.append(skirt)

        skirt_fin = sb.geometry.create_box(0.04, 0.22, 0.35, clay_mat)
        skirt_fin.translate(side * 1.24, 0.18, 1.15)
        chassis.append(skirt_fin)

    # Aerodynamic side view mirrors
    for side in (-1, 1):
        stalk = sb.geometry.create_box(0.28, 0.04, 0.05, clay_mat)
        stalk.rotate_z(side * 10)
        stalk.translate(side * 0.85, 0.84, 0.58)
        chassis.append(stalk)

        mirror = sb.geometry.create_box(0.22, 0.12, 0.14, clay_mat)
        mirror.taper(0.35, 2)
        mirror.translate(side * 0.98, 0.86, 0.58)
        chassis.append(mirror)

    # 4 Master-Class Articulated Wheel Assemblies
    wheel_positions = [
        ("Front-Left",  -1.16, 0.38,  1.45, 0.38, 0.30),
        ("Front-Right",  1.16, 0.38,  1.45, 0.38, 0.30),
        ("Rear-Left",   -1.18, 0.42, -1.45, 0.42, 0.36),
        ("Rear-Right",   1.18, 0.42, -1.45, 0.42, 0.36)
    ]

    for name, wx, wy, wz, tr, tw in wheel_positions:
        # High-res tread tire
        tire = sb.geometry.create_cylinder(radius=tr, height=tw, segments=48, material=clay_mat)
        tire.rotate_z(90)
        tire.translate(wx, wy, wz)
        chassis.append(tire)

        # Deep dish wheel rim barrel
        rim_barrel = sb.geometry.create_cylinder(radius=tr * 0.80, height=tw * 0.92, segments=36, material=clay_mat)
        rim_barrel.rotate_z(90)
        rim_barrel.translate(wx, wy, wz)
        chassis.append(rim_barrel)

        # 10 Aerodynamic rim spokes
        spoke_count = 10
        spoke_len = tr * 0.72
        for s_idx in range(spoke_count):
            angle = (s_idx / spoke_count) * 2.0 * math.pi
            spoke = sb.geometry.create_box(0.03, spoke_len, 0.05, clay_mat)
            spoke.rotate_x(math.degrees(angle))
            spoke.translate(wx + (0.08 if wx > 0 else -0.08), wy, wz)
            chassis.append(spoke)

        # Center lock nut
        center_nut = sb.geometry.create_cylinder(radius=0.075, height=tw * 1.04, segments=24, material=clay_mat)
        center_nut.rotate_z(90)
        center_nut.translate(wx, wy, wz)
        chassis.append(center_nut)

        # Carbon ceramic brake rotor
        rotor = sb.geometry.create_cylinder(radius=tr * 0.68, height=0.04, segments=32, material=clay_mat)
        rotor.rotate_z(90)
        rotor.translate(wx * 0.86, wy, wz)
        chassis.append(rotor)

        # 6-piston monobloc brake caliper
        caliper = sb.geometry.create_box(0.12, 0.22, 0.14, clay_mat)
        caliper.translate(wx * 0.86, wy + 0.16, wz)
        chassis.append(caliper)

    print("[3/4] Constructing 10% Tertiary Micro-Detail...")
    # Quad central exhaust pipe cluster
    for i, ex in enumerate([-0.36, -0.12, 0.12, 0.36]):
        pipe_outer = sb.geometry.create_cylinder(radius=0.07, height=0.28, segments=24, material=clay_mat)
        pipe_outer.rotate_x(90)
        pipe_outer.translate(ex, 0.36, -2.44)
        chassis.append(pipe_outer)

        pipe_inner = sb.geometry.create_cylinder(radius=0.05, height=0.30, segments=16, material=clay_mat)
        pipe_inner.rotate_x(90)
        pipe_inner.translate(ex, 0.36, -2.44)
        chassis.append(pipe_inner)

    # Dorsal shark fin running from roof to wing
    shark_fin = sb.geometry.create_box(0.035, 0.42, 1.6, clay_mat)
    shark_fin.taper(0.55, 1)
    shark_fin.translate(0, 1.02, -1.05)
    chassis.append(shark_fin)

    # Roof engine induction air scoop
    roof_scoop = sb.geometry.create_box(0.38, 0.22, 0.65, clay_mat)
    roof_scoop.taper(-0.35, 2)
    roof_scoop.translate(0, 1.15, -0.32)
    chassis.append(roof_scoop)

    # Engine bay cooling louvers / heat extractors (6 tiers)
    for l_idx, lz in enumerate([0.7, 0.85, 1.0, 1.15, 1.3, 1.45]):
        louver = sb.geometry.create_box(0.95, 0.025, 0.07, clay_mat)
        louver.rotate_x(15)
        louver.translate(0, 0.58 - l_idx * 0.02, lz)
        chassis.append(louver)

    # Front air intake fascia & hexagonal cell bars
    grille_frame = sb.geometry.create_box(1.4, 0.26, 0.10, clay_mat)
    grille_frame.translate(0, 0.26, 2.42)
    chassis.append(grille_frame)

    for bar_x in [-0.4, -0.2, 0.0, 0.2, 0.4]:
        bar = sb.geometry.create_box(0.03, 0.24, 0.08, clay_mat)
        bar.translate(bar_x, 0.26, 2.43)
        chassis.append(bar)

    # Fuel filler cap
    filler_cap = sb.geometry.create_cylinder(radius=0.07, height=0.02, segments=20, material=clay_mat)
    filler_cap.translate(0.72, 0.88, -0.92)
    chassis.append(filler_cap)

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
