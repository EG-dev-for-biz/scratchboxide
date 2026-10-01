import { test, expect } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { NativeTilePathTracerService } from '../src/node/3d-engine/native-tile-path-tracer-service';

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b';

test('Zero-Presets 3D Pipeline: Generates and Renders 3 Complex Unrelated Scenes with Full Physical PBR', async () => {
    const pythonRunner = NativePythonRunnerService.getInstance();
    const pathTracer = new NativeTilePathTracerService();
    const workDir = path.resolve(process.cwd(), 'build/zero_presets_renders');
    fs.mkdirSync(workDir, { recursive: true });

    // =========================================================================
    // SCENE 1: Deep-Sea Hydrothermal Vent Caldera (Basalt, Magma Glow, Pyrite)
    // =========================================================================
    console.log('\n🌋 [Scene 1/3] Generating Deep-Sea Hydrothermal Vent Caldera with Physical PBR...');
    const scene1Script = `
import scratchbox as sb
import math

meshes = []

# 1. Volcanic Basalt Caldera Bed Mound with Noise Displacement & Curvature AO
bed = sb.geometry.create_studio_pedestal(4.2, 0.45, 0.15, 48)
bed.material = sb.geometry.PbrMaterial.basalt_rock()
bed.set_color(sb.math.Vec4(0.18, 0.18, 0.20, 1.0))
bed.displace_along_normals(1.8, 0.04)
bed.apply_procedural_weathering(2.0, 0.25)
bed.compute_curvature_ao(0.85)
meshes.append(bed)

# 2. Main Central Hydrothermal Black Smoker Spire (segmented basalt column)
segments_data = [
    (1.15, 0.85, 0.90, 0.22),
    (0.85, 0.65, 0.95, 0.20),
    (0.65, 0.48, 0.85, 0.24),
    (0.48, 0.36, 0.80, 0.19),
    (0.36, 0.26, 0.70, 0.26)
]
curr_y = 0.25
for s_idx, (r_bot, r_top, h, shade) in enumerate(segments_data):
    seg = sb.geometry.create_cylinder(r_top, r_bot, h, 24, sb.math.Vec4(shade, shade * 0.95, shade * 0.90, 1.0))
    seg.material = sb.geometry.PbrMaterial.basalt_rock()
    seg.apply_procedural_weathering(3.0, 0.22)
    seg.compute_curvature_ao(0.70)
    seg.translate(sb.math.Vec3(0, curr_y + h * 0.5, 0))
    meshes.append(seg)
    curr_y += h

# Top Vent Chimney Rim (dark basalt collar)
vent_rim = sb.geometry.create_torus(0.32, 0.09, 16, 28, sb.math.Vec4(0.28, 0.27, 0.26, 1.0))
vent_rim.material = sb.geometry.PbrMaterial.basalt_rock()
vent_rim.translate(sb.math.Vec3(0, curr_y, 0))
meshes.append(vent_rim)

# Superheated Internal Magmatic Vent Plume Fissure (blazing high-radiance emissive glow)
magma_fissure = sb.geometry.create_sphere(0.25, 12, 16, sb.math.Vec4(1.0, 0.38, 0.05, 1.0))
magma_mat = sb.geometry.PbrMaterial()
magma_mat.name = "molten_magma"
magma_mat.base_color = sb.math.Vec4(1.0, 0.38, 0.05, 1.0)
magma_mat.emissive = sb.math.Vec3(4.5, 1.6, 0.2)
magma_mat.roughness = 0.35
magma_mat.metallic = 0.0
magma_fissure.material = magma_mat
magma_fissure.translate(sb.math.Vec3(0, curr_y - 0.08, 0))
meshes.append(magma_fissure)

# 3. Flanking Parasitic Hydrothermal Vent Spires
parasitic_spires = [
    (1.5, 0.8, 2.2, 0.20, 0.42, 0.22),
    (-1.4, 0.9, 1.8, 0.18, 0.38, 0.25),
    (0.6, -1.6, 2.5, 0.22, 0.45, 0.20)
]
for px, pz, ph, prt, prb, pcol in parasitic_spires:
    spire = sb.geometry.create_cylinder(prt, prb, ph, 20, sb.math.Vec4(pcol, pcol * 0.95, pcol * 1.1, 1.0))
    spire.material = sb.geometry.PbrMaterial.basalt_rock()
    spire.apply_procedural_weathering(3.0, 0.20)
    spire.compute_curvature_ao(0.75)
    spire.translate(sb.math.Vec3(px, 0.25 + ph * 0.5, pz))
    meshes.append(spire)

    # Parasitic vent tip glow
    tip_glow = sb.geometry.create_sphere(prt * 0.8, 8, 12, sb.math.Vec4(1.0, 0.45, 0.08, 1.0))
    tip_mat = sb.geometry.PbrMaterial()
    tip_mat.name = "parasitic_glow"
    tip_mat.base_color = sb.math.Vec4(1.0, 0.45, 0.08, 1.0)
    tip_mat.emissive = sb.math.Vec3(3.0, 1.2, 0.2)
    tip_mat.roughness = 0.4
    tip_glow.material = tip_mat
    tip_glow.translate(sb.math.Vec3(px, 0.25 + ph, pz))
    meshes.append(tip_glow)

# 4. Dense Colonies of Crimson-Tipped Riftia Tubeworms
tubeworm_body_mesh = sb.geometry.Mesh("TubewormBodies")
tubeworm_plume_mesh = sb.geometry.Mesh("TubewormPlumes")
for t_i in range(56):
    angle = (t_i / 56.0) * math.pi * 2.0
    dist = 1.0 + (t_i % 9) * 0.28
    tx = math.cos(angle) * dist
    tz = math.sin(angle) * dist
    th = 0.85 + (t_i % 6) * 0.22
    # White chitin stalk
    stalk = sb.geometry.create_cylinder(0.024, 0.034, th, 10, sb.math.Vec4(0.92, 0.91, 0.88, 1.0))
    stalk.translate(sb.math.Vec3(tx, 0.25 + th * 0.5, tz))
    tubeworm_body_mesh.append(stalk)
    # Vibrant crimson branch plume
    plume = sb.geometry.create_sphere(0.052, 8, 12, sb.math.Vec4(0.92, 0.06, 0.12, 1.0))
    plume.translate(sb.math.Vec3(tx, 0.25 + th + 0.03, tz))
    tubeworm_plume_mesh.append(plume)

tw_mat = sb.geometry.PbrMaterial()
tw_mat.name = "chitin_tubeworm"
tw_mat.base_color = sb.math.Vec4(0.92, 0.91, 0.88, 1.0)
tw_mat.roughness = 0.45
tw_mat.metallic = 0.02
tubeworm_body_mesh.material = tw_mat
meshes.append(tubeworm_body_mesh)

plume_mat = sb.geometry.PbrMaterial()
plume_mat.name = "crimson_plume"
plume_mat.base_color = sb.math.Vec4(0.92, 0.06, 0.12, 1.0)
plume_mat.roughness = 0.55
tubeworm_plume_mesh.material = plume_mat
meshes.append(tubeworm_plume_mesh)

# 5. Glowing Bioluminescent Siphonophore Organism (Space Colonization Tree)
tree_cfg = sb.nature.SpaceColonizationConfig()
tree_cfg.attractor_count = 110
tree_cfg.crown_center = sb.math.Vec3(1.6, 2.6, -1.1)
tree_cfg.crown_extents = sb.math.Vec3(1.4, 1.6, 1.4)
tree_cfg.base_radius = 0.06
tree_cfg.tip_radius = 0.02
siphonophore = sb.nature.generate_tree(tree_cfg)
siph_mat = sb.geometry.PbrMaterial()
siph_mat.name = "bioluminescent_siphonophore"
siph_mat.base_color = sb.math.Vec4(0.10, 0.85, 0.95, 1.0)
siph_mat.emissive = sb.math.Vec3(0.3, 2.8, 3.2)
siph_mat.roughness = 0.25
siphonophore.material = siph_mat
meshes.append(siphonophore)

# 6. Golden Pyrite & Sulfide Mineral Crystal Formations (High-Reflectance Metallic Gold)
pyrite_mesh = sb.geometry.Mesh("PyriteCrystals")
for c_i in range(18):
    c_ang = c_i * 0.35
    cx = math.cos(c_ang) * (2.1 + (c_i % 5) * 0.32)
    cz = math.sin(c_ang) * (2.1 + (c_i % 5) * 0.32)
    ch = 0.45 + (c_i % 4) * 0.18
    crystal = sb.geometry.create_box(sb.math.Vec3(0.24, ch, 0.24), sb.math.Vec4(0.95, 0.82, 0.25, 1.0))
    crystal.rotate_y(c_i * 25.0)
    crystal.translate(sb.math.Vec3(cx, 0.25 + ch * 0.5, cz))
    pyrite_mesh.append(crystal)

pyrite_mesh.material = sb.geometry.PbrMaterial.gold()
meshes.append(pyrite_mesh)

total_verts = sum(m.vertex_count for m in meshes)
total_tris = sum(m.triangle_count for m in meshes)
print(f"[Scene 1] Submeshes: {len(meshes)}, Vertices: {total_verts}, Triangles: {total_tris}")
sb.io.write_glb(OUTPUT_GLB_PATH, meshes)
`;

    const res1 = await pythonRunner.runScript(scene1Script, { timeoutMs: 30000 });
    expect(res1.success).toBe(true);
    expect(res1.glbPath).toBeDefined();

    const outDir1 = path.join(workDir, 'scene_1_hydrothermal_vent');
    const render1 = await pathTracer.render({
        glbPath: res1.glbPath!,
        outputDir: outDir1,
        width: 1280,
        height: 720,
        samplesPerPixel: 48,
        maxBounces: 4,
        sun: { elevationDeg: 52, azimuthDeg: 125 },
        camera: { auto: { pitchDeg: 22, headingDeg: 35, verticalFovDeg: 42, distanceScale: 0.68 } },
        denoise: true,
        groundPlane: true
    });
    expect(render1.success).toBe(true);
    const dest1 = path.join(ARTIFACT_DIR, 'screenshot_scene_1_hydrothermal_vent.png');
    fs.copyFileSync(render1.beautyPngPath, dest1);
    console.log(`✅ [Scene 1] Rendered Physical PBR Screenshot saved to: ${dest1}`);

    // =========================================================================
    // SCENE 2: Ancient Monumental Babylonian Ziggurat Observatory (Limestone, Lapis, Gold)
    // =========================================================================
    console.log('\n🏛️ [Scene 2/3] Generating Ancient Monumental Babylonian Ziggurat Observatory with Physical PBR...');
    const scene2Script = `
import scratchbox as sb
import math

meshes = []

# 1. Base Foundation Terrace (9m x 9m x 2.4m) - Weathered Terracotta Mudbrick
tier1_cfg = sb.architecture.BuildingConfig()
tier1_cfg.width = 9.0
tier1_cfg.depth = 9.0
tier1_cfg.floor_count = 1
tier1_cfg.ground_floor_height = 2.4
tier1_cfg.floor_height = 2.4
tier1_cfg.plinth_height = 0.0
tier1_cfg.parapet_height = 0.30
tier1_cfg.roof_type = sb.architecture.RoofType.FlatParapet
tier1 = sb.architecture.generate_building(tier1_cfg, "Tier1_Foundation")
tier1.material = sb.geometry.PbrMaterial.stone_limestone()
tier1.set_color(sb.math.Vec4(0.78, 0.64, 0.46, 1.0))
tier1.apply_procedural_weathering(2.5, 0.18)
tier1.compute_curvature_ao(0.80)
meshes.append(tier1)

# 2. Second Stepped Terrace (6.5m x 6.5m x 2.0m) - Glazed Lapis-Lazuli Royal Blue
tier2_cfg = sb.architecture.BuildingConfig()
tier2_cfg.width = 6.5
tier2_cfg.depth = 6.5
tier2_cfg.floor_count = 1
tier2_cfg.ground_floor_height = 2.0
tier2_cfg.floor_height = 2.0
tier2_cfg.plinth_height = 0.0
tier2_cfg.parapet_height = 0.30
tier2_cfg.roof_type = sb.architecture.RoofType.FlatParapet
tier2 = sb.architecture.generate_building(tier2_cfg, "Tier2_Lapis")
lapis_mat = sb.geometry.PbrMaterial()
lapis_mat.name = "glazed_lapis_lazuli"
lapis_mat.base_color = sb.math.Vec4(0.08, 0.22, 0.68, 1.0)
lapis_mat.roughness = 0.22
lapis_mat.metallic = 0.15
tier2.material = lapis_mat
tier2.set_color(sb.math.Vec4(0.08, 0.22, 0.68, 1.0))
tier2.compute_curvature_ao(0.75)
tier2.translate(sb.math.Vec3(0, 2.4, 0))
meshes.append(tier2)

# 3. Third Upper Celestial Sanctuary Terrace (4.2m x 4.2m x 1.6m) - Gold Leaf Frieze
tier3_cfg = sb.architecture.BuildingConfig()
tier3_cfg.width = 4.2
tier3_cfg.depth = 4.2
tier3_cfg.floor_count = 1
tier3_cfg.ground_floor_height = 1.6
tier3_cfg.floor_height = 1.6
tier3_cfg.plinth_height = 0.0
tier3_cfg.parapet_height = 0.25
tier3_cfg.roof_type = sb.architecture.RoofType.FlatParapet
tier3 = sb.architecture.generate_building(tier3_cfg, "Tier3_Sanctuary")
tier3.material = sb.geometry.PbrMaterial.gold()
tier3.set_color(sb.math.Vec4(0.92, 0.80, 0.32, 1.0))
tier3.translate(sb.math.Vec3(0, 4.4, 0))
meshes.append(tier3)

# 4. Monumental Front Central Ramp / Grand Staircase
stair_mesh = sb.geometry.Mesh("GrandStaircase")
steps = 14
for step_idx in range(steps):
    t = step_idx / float(steps)
    sz = 4.5 + (1.0 - t) * 2.5
    sy = t * 2.4 + 0.09
    step_box = sb.geometry.create_box(sb.math.Vec3(2.2, 0.18, 0.45), sb.math.Vec4(0.82, 0.72, 0.55, 1.0))
    step_box.translate(sb.math.Vec3(0, sy, sz))
    stair_mesh.append(step_box)

stair_mesh.material = sb.geometry.PbrMaterial.stone_limestone()
stair_mesh.compute_curvature_ao(0.70)
meshes.append(stair_mesh)

# 5. Celestial Armillary Sphere Sanctuary (interlocking brass rings & central golden globe on summit)
altar_pylon = sb.geometry.create_cylinder(0.35, 0.45, 1.0, 20, sb.math.Vec4(0.85, 0.78, 0.65, 1.0))
altar_pylon.material = sb.geometry.PbrMaterial.stone_limestone()
altar_pylon.translate(sb.math.Vec3(0, 6.0 + 0.5, 0))
meshes.append(altar_pylon)

ring_meridian = sb.geometry.create_torus(1.1, 0.055, 20, 32, sb.math.Vec4(0.92, 0.78, 0.25, 1.0))
ring_meridian.material = sb.geometry.PbrMaterial.polished_brass()
ring_meridian.translate(sb.math.Vec3(0, 7.6, 0))
meshes.append(ring_meridian)

ring_equator = sb.geometry.create_torus(0.9, 0.048, 20, 32, sb.math.Vec4(0.88, 0.72, 0.22, 1.0))
ring_equator.material = sb.geometry.PbrMaterial.polished_brass()
ring_equator.rotate_x(65.0)
ring_equator.translate(sb.math.Vec3(0, 7.6, 0))
meshes.append(ring_equator)

ring_solstice = sb.geometry.create_torus(0.72, 0.042, 18, 28, sb.math.Vec4(0.95, 0.82, 0.28, 1.0))
ring_solstice.material = sb.geometry.PbrMaterial.polished_brass()
ring_solstice.rotate_y(45.0)
ring_solstice.translate(sb.math.Vec3(0, 7.6, 0))
meshes.append(ring_solstice)

central_globe = sb.geometry.create_sphere(0.24, 16, 20, sb.math.Vec4(1.0, 0.85, 0.25, 1.0))
central_globe.material = sb.geometry.PbrMaterial.gold()
central_globe.translate(sb.math.Vec3(0, 7.6, 0))
meshes.append(central_globe)

# 6. Four Bronze Ritual Braziers on Tier 1 Terrace Corners with Blazing Fire Embers
brazier_mesh = sb.geometry.Mesh("Braziers")
fire_mesh = sb.geometry.Mesh("FireEmbers")
for bx, bz in [(-3.8, -3.8), (3.8, -3.8), (-3.8, 3.8), (3.8, 3.8)]:
    brazier_base = sb.geometry.create_cylinder(0.25, 0.18, 0.75, 16, sb.math.Vec4(0.38, 0.28, 0.18, 1.0))
    brazier_base.translate(sb.math.Vec3(bx, 2.4 + 0.375, bz))
    brazier_mesh.append(brazier_base)

    brazier_bowl = sb.geometry.create_torus(0.26, 0.065, 12, 20, sb.math.Vec4(0.48, 0.36, 0.22, 1.0))
    brazier_bowl.translate(sb.math.Vec3(bx, 2.4 + 0.75, bz))
    brazier_mesh.append(brazier_bowl)

    brazier_flame = sb.geometry.create_sphere(0.18, 12, 16, sb.math.Vec4(1.0, 0.42, 0.06, 1.0))
    brazier_flame.translate(sb.math.Vec3(bx, 2.4 + 0.88, bz))
    fire_mesh.append(brazier_flame)

brazier_mesh.material = sb.geometry.PbrMaterial.copper_bullet()
meshes.append(brazier_mesh)

fire_mat = sb.geometry.PbrMaterial()
fire_mat.name = "ritual_fire"
fire_mat.base_color = sb.math.Vec4(1.0, 0.45, 0.08, 1.0)
fire_mat.emissive = sb.math.Vec3(5.0, 2.0, 0.3)
fire_mesh.material = fire_mat
meshes.append(fire_mesh)

# Courtyard Ground Pedestal
ground = sb.geometry.create_studio_pedestal(7.5, 0.25, 0.05, 48)
ground.material = sb.geometry.PbrMaterial.stone_limestone()
ground.set_color(sb.math.Vec4(0.72, 0.62, 0.48, 1.0))
ground.apply_procedural_weathering(2.0, 0.15)
meshes.append(ground)

total_verts = sum(m.vertex_count for m in meshes)
total_tris = sum(m.triangle_count for m in meshes)
print(f"[Scene 2] Submeshes: {len(meshes)}, Vertices: {total_verts}, Triangles: {total_tris}")
sb.io.write_glb(OUTPUT_GLB_PATH, meshes)
`;

    const res2 = await pythonRunner.runScript(scene2Script, { timeoutMs: 30000 });
    expect(res2.success).toBe(true);
    expect(res2.glbPath).toBeDefined();

    const outDir2 = path.join(workDir, 'scene_2_babylonian_ziggurat');
    const render2 = await pathTracer.render({
        glbPath: res2.glbPath!,
        outputDir: outDir2,
        width: 1280,
        height: 720,
        samplesPerPixel: 48,
        maxBounces: 4,
        sun: { elevationDeg: 24, azimuthDeg: 235 }, // Mesopotamian golden hour sunset
        camera: { auto: { pitchDeg: 26, headingDeg: 34, verticalFovDeg: 44, distanceScale: 0.82 } },
        denoise: true,
        groundPlane: true
    });
    expect(render2.success).toBe(true);
    const dest2 = path.join(ARTIFACT_DIR, 'screenshot_scene_2_babylonian_ziggurat.png');
    fs.copyFileSync(render2.beautyPngPath, dest2);
    console.log(`✅ [Scene 2] Rendered Physical PBR Screenshot saved to: ${dest2}`);

    // =========================================================================
    // SCENE 3: Sub-Orbital Superconducting Fusion Thruster (Titanium, Copper, Plasma)
    // =========================================================================
    console.log('\n🚀 [Scene 3/3] Generating Sub-Orbital Superconducting Fusion Thruster with Physical PBR...');
    const scene3Script = `
import scratchbox as sb
import math

meshes = []

# 1. Divergent Hyperbolic Titanium Rocket Nozzle Bell
throat_radius = 0.65
exit_radius = 2.2
stages = 6
h_seg = 0.38
base_y = 2.4

nozzle_mesh = sb.geometry.Mesh("TitaniumNozzleBell")
for s in range(stages):
    frac_b = s / float(stages)
    frac_t = (s + 1) / float(stages)
    rb = throat_radius + (exit_radius - throat_radius) * (frac_b ** 1.5)
    rt = throat_radius + (exit_radius - throat_radius) * (frac_t ** 1.5)
    y_pos = base_y - (s * h_seg + h_seg * 0.5)
    seg = sb.geometry.create_cylinder(rb, rt, h_seg, 32, sb.math.Vec4(0.75, 0.77, 0.82, 1.0))
    seg.translate(sb.math.Vec3(0, y_pos, 0))
    nozzle_mesh.append(seg)

nozzle_mesh.material = sb.geometry.PbrMaterial.titanium()
nozzle_mesh.compute_curvature_ao(0.70)
meshes.append(nozzle_mesh)

# 2. Toroidal Superconducting Magnetic Confinement Chamber (burnished copper coils)
coils_mesh = sb.geometry.Mesh("CopperSuperconductingCoils")
primary_mag_ring = sb.geometry.create_torus(1.65, 0.30, 24, 40, sb.math.Vec4(0.92, 0.55, 0.24, 1.0))
primary_mag_ring.translate(sb.math.Vec3(0, 2.7, 0))
coils_mesh.append(primary_mag_ring)

secondary_mag_ring = sb.geometry.create_torus(1.30, 0.22, 20, 36, sb.math.Vec4(0.92, 0.55, 0.24, 1.0))
secondary_mag_ring.translate(sb.math.Vec3(0, 3.4, 0))
coils_mesh.append(secondary_mag_ring)

coils_mesh.material = sb.geometry.PbrMaterial.copper_bullet()
meshes.append(coils_mesh)

# 3. Superheated Fusion Reaction Zone (Brilliant Blue Plasma Sphere with Intense Radiance)
plasma_core = sb.geometry.create_sphere(0.55, 20, 28, sb.math.Vec4(0.20, 0.85, 1.0, 1.0))
plasma_mat = sb.geometry.PbrMaterial()
plasma_mat.name = "deuterium_fusion_plasma"
plasma_mat.base_color = sb.math.Vec4(0.20, 0.85, 1.0, 1.0)
plasma_mat.emissive = sb.math.Vec3(2.0, 8.5, 12.0)
plasma_mat.roughness = 0.10
plasma_mat.metallic = 0.0
plasma_core.material = plasma_mat
plasma_core.translate(sb.math.Vec3(0, 3.0, 0))
meshes.append(plasma_core)

# 4. Regenerative Cooling Jacket Rings (Chrome manifolds)
cooling_mesh = sb.geometry.Mesh("ChromeCoolingManifolds")
for ring_i in range(4):
    cooling_ring = sb.geometry.create_torus(0.75 + ring_i * 0.12, 0.038, 16, 32, sb.math.Vec4(0.96, 0.97, 0.99, 1.0))
    cooling_ring.translate(sb.math.Vec3(0, 2.35 + ring_i * 0.15, 0))
    cooling_mesh.append(cooling_ring)

cooling_mesh.material = sb.geometry.PbrMaterial.chrome()
meshes.append(cooling_mesh)

# 5. Quad Hydraulic Gimbal Actuator Pistons (Chrome Rods & Carbon-Composite Bodies)
actuator_body_mesh = sb.geometry.Mesh("ActuatorBodies")
actuator_rod_mesh = sb.geometry.Mesh("ActuatorRods")
for g_angle_deg in [45, 135, 225, 315]:
    rad = math.radians(g_angle_deg)
    gx = math.cos(rad) * 1.6
    gz = math.sin(rad) * 1.6
    cylinder_body = sb.geometry.create_cylinder(0.09, 0.09, 1.0, 16, sb.math.Vec4(0.18, 0.18, 0.20, 1.0))
    cylinder_body.translate(sb.math.Vec3(gx, 3.9, gz))
    piston_rod = sb.geometry.create_cylinder(0.048, 0.048, 1.1, 16, sb.math.Vec4(0.96, 0.97, 0.99, 1.0))
    piston_rod.translate(sb.math.Vec3(gx, 4.4, gz))
    actuator_body_mesh.append(cylinder_body)
    actuator_rod_mesh.append(piston_rod)

actuator_body_mesh.material = sb.geometry.PbrMaterial.carbon_composite()
actuator_rod_mesh.material = sb.geometry.PbrMaterial.chrome()
meshes.append(actuator_body_mesh)
meshes.append(actuator_rod_mesh)

# 6. Structural Thrust Puck & Octagonal Mounting Ring Truss
thrust_mesh = sb.geometry.Mesh("TitaniumMountingTruss")
thrust_ring = sb.geometry.create_torus(1.95, 0.14, 16, 40, sb.math.Vec4(0.75, 0.77, 0.82, 1.0))
thrust_ring.translate(sb.math.Vec3(0, 4.8, 0))
thrust_mesh.append(thrust_ring)

for strut_i in range(8):
    s_ang = strut_i * (math.pi / 4.0)
    sx = math.cos(s_ang) * 1.5
    sz = math.sin(s_ang) * 1.5
    strut = sb.geometry.create_box(sb.math.Vec3(0.12, 1.2, 0.12), sb.math.Vec4(0.75, 0.77, 0.82, 1.0))
    strut.translate(sb.math.Vec3(sx, 4.1, sz))
    thrust_mesh.append(strut)

thrust_mesh.material = sb.geometry.PbrMaterial.titanium()
thrust_mesh.compute_curvature_ao(0.70)
meshes.append(thrust_mesh)

# Test Mount Base Pedestal
pedestal = sb.geometry.create_studio_pedestal(3.8, 0.25, 0.05, 40)
pedestal.material = sb.geometry.PbrMaterial.concrete_brutalist()
pedestal.set_color(sb.math.Vec4(0.55, 0.55, 0.58, 1.0))
pedestal.compute_curvature_ao(0.80)
meshes.append(pedestal)

total_verts = sum(m.vertex_count for m in meshes)
total_tris = sum(m.triangle_count for m in meshes)
print(f"[Scene 3] Submeshes: {len(meshes)}, Vertices: {total_verts}, Triangles: {total_tris}")
sb.io.write_glb(OUTPUT_GLB_PATH, meshes)
`;

    const res3 = await pythonRunner.runScript(scene3Script, { timeoutMs: 30000 });
    expect(res3.success).toBe(true);
    expect(res3.glbPath).toBeDefined();

    const outDir3 = path.join(workDir, 'scene_3_fusion_thruster');
    const render3 = await pathTracer.render({
        glbPath: res3.glbPath!,
        outputDir: outDir3,
        width: 1280,
        height: 720,
        samplesPerPixel: 48,
        maxBounces: 4,
        sun: { elevationDeg: 46, azimuthDeg: 140 }, // High-contrast orbital sunlight
        camera: { auto: { pitchDeg: 22, headingDeg: 40, verticalFovDeg: 44, distanceScale: 0.65 } },
        denoise: true,
        groundPlane: true
    });
    expect(render3.success).toBe(true);
    const dest3 = path.join(ARTIFACT_DIR, 'screenshot_scene_3_fusion_thruster.png');
    fs.copyFileSync(render3.beautyPngPath, dest3);
    console.log(`✅ [Scene 3] Rendered Physical PBR Screenshot saved to: ${dest3}`);

    console.log('\n🎉 Finished generating and rendering all 3 physical PBR complex 3D scenes!');
}, 180000);
