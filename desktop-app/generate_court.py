import scratchbox as sb
import math

scene = sb.geometry.Mesh("ModernBasketballCourt")

# ==========================================
# 1. PRIMARY SLAB & COURT SURFACE (70% Form)
# ==========================================
# Regulation NBA / FIBA outdoor court playing surface (28m x 15m) on a 32m x 19m foundation slab
court_slab = sb.create_box(width=32.0, height=0.35, depth=19.0)
court_slab.translate(0.0, -0.175, 0.0)
scene.merge(court_slab)

# Elevated boundary apron / bevel curb
apron = sb.create_box(width=32.6, height=0.15, depth=19.6)
apron.translate(0.0, -0.35, 0.0)
scene.merge(apron)

# Ground pad foundation
pedestal = sb.create_box(width=36.0, height=0.10, depth=23.0)
pedestal.translate(0.0, -0.45, 0.0)
scene.merge(pedestal)

# Center court circle marking (embossed relief)
center_ring = sb.create_cylinder(radius=1.8, height=0.015, segments=32)
center_ring.translate(0.0, 0.008, 0.0)
scene.merge(center_ring)

center_outer = sb.create_cylinder(radius=3.6, height=0.01, segments=32)
center_outer.translate(0.0, 0.005, 0.0)
scene.merge(center_outer)

# Half-court dividing line
center_line = sb.create_box(width=0.10, height=0.015, depth=15.0)
center_line.translate(0.0, 0.008, 0.0)
scene.merge(center_line)

# Sidelines and Baselines
for side_z in [-7.5, 7.5]:
    sideline = sb.create_box(width=28.0, height=0.012, depth=0.10)
    sideline.translate(0.0, 0.006, side_z)
    scene.merge(sideline)

for end_x in [-14.0, 14.0]:
    baseline = sb.create_box(width=0.10, height=0.012, depth=15.0)
    baseline.translate(end_x, 0.006, 0.0)
    scene.merge(baseline)

# Key / Painted Area (The Lane) & 3-Point Arcs for both hoops
for side_x in [-1.0, 1.0]:
    # Key rectangle (4.9m wide x 5.8m long)
    key_box = sb.create_box(width=5.8, height=0.012, depth=4.9)
    key_box.translate(side_x * (14.0 - 2.9), 0.006, 0.0)
    scene.merge(key_box)

    # Free throw circle at top of key
    ft_circle = sb.create_cylinder(radius=1.8, height=0.014, segments=24)
    ft_circle.translate(side_x * (14.0 - 5.8), 0.007, 0.0)
    scene.merge(ft_circle)

    # Restricted area semi-circle under hoop
    ra_circle = sb.create_cylinder(radius=1.25, height=0.014, segments=20)
    ra_circle.translate(side_x * (14.0 - 1.575), 0.007, 0.0)
    scene.merge(ra_circle)

# ===================================================
# 2. REGULATION HOOP STANCHIONS & BACKBOARDS (20% Form)
# ===================================================
for side_x in [-1.0, 1.0]:
    base_x = side_x * 15.2  # 1.2m behind baseline
    
    # Heavy weighted base anchor plinth & protective padding box
    stanchion_base = sb.create_box(width=1.1, height=0.75, depth=0.9)
    stanchion_base.translate(base_x, 0.375, 0.0)
    scene.merge(stanchion_base)

    # Slanted gooseneck main post (cantilevered beam)
    post_vert = sb.create_box(width=0.22, height=3.2, depth=0.22)
    post_vert.translate(base_x, 1.6, 0.0)
    scene.merge(post_vert)

    # Angled extension arm overhang
    ext_arm = sb.create_box(width=1.6, height=0.18, depth=0.18)
    ext_arm.rotate_z(-side_x * 22.0)
    ext_arm.translate(base_x - side_x * 0.7, 3.4, 0.0)
    scene.merge(ext_arm)

    # Upper stabilization tension struts (twin diagonals)
    for strut_z in [-0.2, 0.2]:
        strut = sb.create_cylinder(radius=0.035, height=1.8, segments=12)
        strut.rotate_z(-side_x * 35.0)
        strut.translate(base_x - side_x * 0.65, 3.65, strut_z)
        scene.merge(strut)

    # Backboard mounting frame & H-bracket
    h_bracket = sb.create_box(width=0.08, height=0.75, depth=0.9)
    h_bracket.translate(base_x - side_x * 1.45, 3.25, 0.0)
    scene.merge(h_bracket)

    # Regulation Glass Backboard (1.80m wide x 1.05m high x 0.04m thick, bottom at 2.90m)
    backboard = sb.create_box(width=0.04, height=1.05, depth=1.80)
    backboard.translate(base_x - side_x * 1.50, 3.425, 0.0)
    scene.merge(backboard)

    # Inner shooter's target box frame (0.59m wide x 0.45m high)
    inner_box = sb.create_box(width=0.05, height=0.45, depth=0.59)
    inner_box.translate(base_x - side_x * 1.50, 3.25, 0.0)
    scene.merge(inner_box)

    # Rim mounting plate & spring-loaded breakaway collar
    collar = sb.create_box(width=0.20, height=0.12, depth=0.20)
    collar.translate(base_x - side_x * 1.60, 3.05, 0.0)
    scene.merge(collar)

    # Solid Regulation Rim (0.45m / 18-inch diameter at exactly 3.05m / 10ft height)
    rim = sb.create_cylinder(radius=0.23, height=0.04, segments=24)
    rim.translate(base_x - side_x * 1.78, 3.05, 0.0)
    scene.merge(rim)

    # Conical Chain/Nylon Net mesh
    net = sb.create_cone(radius=0.22, height=0.45, segments=16)
    net.taper(factor=0.45, axis=1)
    net.translate(base_x - side_x * 1.78, 2.825, 0.0)
    scene.merge(net)

# ==========================================================
# 3. PERIMETER CHAINLINK FENCE & CORNER POSTS (10% Details)
# ==========================================================
fence_half_w = 15.5
fence_half_d = 9.2
fence_height = 3.6

# 4 Corner Heavy Structural Pylons
corners = [
    (-fence_half_w, -fence_half_d),
    (-fence_half_w, fence_half_d),
    (fence_half_w, -fence_half_d),
    (fence_half_w, fence_half_d)
]

for cx, cz in corners:
    c_post = sb.create_cylinder(radius=0.09, height=fence_height, segments=16)
    c_post.translate(cx, fence_height / 2.0, cz)
    scene.merge(c_post)
    
    cap = sb.create_sphere(radius=0.11, segments=12)
    cap.translate(cx, fence_height + 0.05, cz)
    scene.merge(cap)

# Intermediate line posts along Length (X-axis)
num_posts_x = 10
for i in range(1, num_posts_x):
    t = i / float(num_posts_x)
    px = -fence_half_w + t * (2.0 * fence_half_w)
    for pz in [-fence_half_d, fence_half_d]:
        post = sb.create_cylinder(radius=0.05, height=fence_height, segments=12)
        post.translate(px, fence_height / 2.0, pz)
        scene.merge(post)

# Intermediate line posts along Width (Z-axis) with opening for entrance gate
num_posts_z = 6
for i in range(1, num_posts_z):
    t = i / float(num_posts_z)
    pz = -fence_half_d + t * (2.0 * fence_half_d)
    for px in [-fence_half_w, fence_half_w]:
        if px == fence_half_w and abs(pz) < 1.6:
            continue
        post = sb.create_cylinder(radius=0.05, height=fence_height, segments=12)
        post.translate(px, fence_height / 2.0, pz)
        scene.merge(post)

# Horizontal Top & Middle Tension Rails
for pz in [-fence_half_d, fence_half_d]:
    for h in [1.8, fence_height]:
        rail = sb.create_cylinder(radius=0.035, height=fence_half_w * 2.0, segments=12)
        rail.rotate_z(90.0)
        rail.translate(0.0, h, pz)
        scene.merge(rail)

for px in [-fence_half_w, fence_half_w]:
    for h in [1.8, fence_height]:
        rail = sb.create_cylinder(radius=0.035, height=fence_half_d * 2.0, segments=12)
        rail.rotate_x(90.0)
        rail.translate(px, h, 0.0)
        scene.merge(rail)

# Semi-transparent micro-mesh boundary screens
for pz in [-fence_half_d, fence_half_d]:
    mesh_screen = sb.create_box(width=fence_half_w * 2.0, height=fence_height - 0.2, depth=0.02)
    mesh_screen.translate(0.0, fence_height / 2.0, pz)
    scene.merge(mesh_screen)

for px in [-fence_half_w, fence_half_w]:
    mesh_screen = sb.create_box(width=0.02, height=fence_height - 0.2, depth=fence_half_d * 2.0)
    mesh_screen.translate(px, fence_height / 2.0, 0.0)
    scene.merge(mesh_screen)

# ==========================================================
# 4. PLAYER BENCHES & COURTSIDE SEATING (10% Details)
# ==========================================================
for bench_x in [-5.5, 5.5]:
    # Bench seating planks (3 slats)
    for slat_idx in range(3):
        slat = sb.create_box(width=3.6, height=0.05, depth=0.18)
        slat.translate(bench_x, 0.48, -8.2 + slat_idx * 0.20)
        scene.merge(slat)
    
    # Bench backrest (2 slats)
    for bslat_idx in range(2):
        bslat = sb.create_box(width=3.6, height=0.18, depth=0.05)
        bslat.translate(bench_x, 0.72 + bslat_idx * 0.20, -8.2 - 0.15)
        scene.merge(bslat)

    # 3 Sturdy A-frame leg supports
    for leg_offset in [-1.5, 0.0, 1.5]:
        leg_post = sb.create_box(width=0.08, height=0.45, depth=0.55)
        leg_post.translate(bench_x + leg_offset, 0.225, -8.0)
        scene.merge(leg_post)

        back_post = sb.create_box(width=0.08, height=0.85, depth=0.08)
        back_post.translate(bench_x + leg_offset, 0.425, -8.32)
        scene.merge(back_post)

# Courtside scorekeeper / media desk
score_table = sb.create_box(width=2.4, height=0.78, depth=0.8)
score_table.translate(0.0, 0.39, -8.1)
scene.merge(score_table)

table_screen = sb.create_box(width=2.2, height=0.35, depth=0.04)
table_screen.translate(0.0, 0.95, -8.1)
scene.merge(table_screen)

# Compute 18% Studio Grey Clay Material & Curvature Ambient Occlusion
scene.compute_curvature_ao(intensity=0.75)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
