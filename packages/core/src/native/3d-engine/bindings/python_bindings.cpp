/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include <nanobind/nanobind.h>
#include <nanobind/stl/string.h>
#include <nanobind/stl/vector.h>
#include <nanobind/stl/array.h>
#include <nanobind/stl/pair.h>

#include "scratchbox_engine.hpp"

namespace nb = nanobind;
using namespace nb::literals;

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::architecture;
using namespace scratchbox::nature;
using namespace scratchbox::composer;
using namespace scratchbox::io;

NB_MODULE(scratchbox_native, m) {
    m.doc() = "Scratchbox Native C++20 3D Engine Python Bindings (powered by nanobind)";

    // ========================================================================
    // 1. MATH SUBMODULE
    // ========================================================================
    auto m_math = m.def_submodule("math", "High-performance vector and spatial math");

    nb::class_<Vec2>(m_math, "Vec2")
        .def(nb::init<>())
        .def(nb::init<float, float>(), "x"_a, "y"_a)
        .def_rw("x", &Vec2::x)
        .def_rw("y", &Vec2::y)
        .def("__repr__", [](const Vec2& v) {
            return "Vec2(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ")";
        });

    nb::class_<Vec3>(m_math, "Vec3")
        .def(nb::init<>())
        .def(nb::init<float, float, float>(), "x"_a, "y"_a, "z"_a)
        .def_rw("x", &Vec3::x)
        .def_rw("y", &Vec3::y)
        .def_rw("z", &Vec3::z)
        .def("length", &Vec3::length)
        .def("normalized", &Vec3::normalized)
        .def("dot", &Vec3::dot)
        .def("cross", &Vec3::cross)
        .def("__add__", [](const Vec3& a, const Vec3& b) { return a + b; })
        .def("__sub__", [](const Vec3& a, const Vec3& b) { return a - b; })
        .def("__mul__", [](const Vec3& a, float s) { return a * s; })
        .def("__rmul__", [](const Vec3& a, float s) { return a * s; })
        .def("__repr__", [](const Vec3& v) {
            return "Vec3(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ", " + std::to_string(v.z) + ")";
        });

    nb::class_<Vec4>(m_math, "Vec4")
        .def(nb::init<>())
        .def(nb::init<float, float, float, float>(), "x"_a, "y"_a, "z"_a, "w"_a)
        .def_rw("x", &Vec4::x)
        .def_rw("y", &Vec4::y)
        .def_rw("z", &Vec4::z)
        .def_rw("w", &Vec4::w)
        .def("__repr__", [](const Vec4& v) {
            return "Vec4(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ", " +
                   std::to_string(v.z) + ", " + std::to_string(v.w) + ")";
        });

    nb::class_<Quat>(m_math, "Quat")
        .def(nb::init<>())
        .def(nb::init<float, float, float, float>(), "x"_a, "y"_a, "z"_a, "w"_a)
        .def_rw("x", &Quat::x)
        .def_rw("y", &Quat::y)
        .def_rw("z", &Quat::z)
        .def_rw("w", &Quat::w)
        .def_static("from_axis_angle", &Quat::fromAxisAngle, "axis"_a, "angle_radians"_a)
        .def("rotate", &Quat::rotate, "vec"_a)
        .def("__repr__", [](const Quat& q) {
            return "Quat(" + std::to_string(q.x) + ", " + std::to_string(q.y) + ", " +
                   std::to_string(q.z) + ", " + std::to_string(q.w) + ")";
        });

    // ========================================================================
    // 2. GEOMETRY & MATERIAL SUBMODULE
    // ========================================================================
    auto m_geom = m.def_submodule("geometry", "Mesh topology, primitives and PBR materials");

    nb::class_<PbrMaterial>(m_geom, "PbrMaterial")
        .def(nb::init<std::string>(), "name"_a = "defaultMaterial")
        .def_rw("name", &PbrMaterial::name)
        .def_rw("base_color", &PbrMaterial::baseColorFactor)
        .def_rw("metallic", &PbrMaterial::metallicFactor)
        .def_rw("roughness", &PbrMaterial::roughnessFactor)
        .def_rw("emissive", &PbrMaterial::emissiveFactor)
        .def_rw("clearcoat", &PbrMaterial::clearcoatFactor)
        .def_rw("ior", &PbrMaterial::ior)
        .def_static("titanium", &PbrMaterial::titanium)
        .def_static("chrome", &PbrMaterial::chrome)
        .def_static("gold", &PbrMaterial::gold)
        .def_static("basalt_rock", &PbrMaterial::basaltRock)
        .def_static("wood_oak", &PbrMaterial::woodOak)
        .def_static("optical_glass", &PbrMaterial::opticalGlass)
        .def_static("stone_limestone", &PbrMaterial::stoneLimestone)
        .def_static("concrete_brutalist", &PbrMaterial::concreteBrutalist)
        .def_static("asphalt_street", &PbrMaterial::asphaltStreet)
        .def_static("quartz_crystal", &PbrMaterial::quartzCrystal)
        .def_static("carbon_composite", &PbrMaterial::carbonComposite)
        .def_static("polished_brass", &PbrMaterial::polishedBrass)
        .def_static("copper_bullet", &PbrMaterial::copperBullet)
        .def_static("emissive_glow", [](const Vec3& color, float intensity) {
            return PbrMaterial::emissiveGlow(color, intensity);
        }, "color"_a, "intensity"_a = 1.0f);

    nb::class_<ScratchboxMesh>(m_geom, "Mesh")
        .def(nb::init<>())
        .def(nb::init<std::string>(), "name"_a = "mesh")
        .def_rw("name", &ScratchboxMesh::name)
        .def_rw("material", &ScratchboxMesh::material)
        .def_prop_ro("vertex_count", [](const ScratchboxMesh& self) { return self.vertices.size(); })
        .def_prop_ro("triangle_count", [](const ScratchboxMesh& self) { return self.indices.size() / 3; })
        .def("add_vertex", [](ScratchboxMesh& self, const Vec3& pos, const Vec3& norm, const Vec2& uv, const Vec4& color) {
            self.addVertex(Vertex(pos, norm, uv, color));
        }, "pos"_a, "norm"_a = Vec3(0, 1, 0), "uv"_a = Vec2(0, 0), "color"_a = Vec4(1, 1, 1, 1))
        .def("add_triangle", &ScratchboxMesh::addTriangle, "i0"_a, "i1"_a, "i2"_a)
        .def("append", &ScratchboxMesh::append, "other"_a, "Merge another mesh into this container")
        .def("translate", &ScratchboxMesh::translate, "offset"_a)
        .def("scale", &ScratchboxMesh::scale, "factors"_a)
        .def("rotate_x", &ScratchboxMesh::rotateX, "angle_deg"_a)
        .def("rotate_y", &ScratchboxMesh::rotateY, "angle_deg"_a)
        .def("rotate_z", &ScratchboxMesh::rotateZ, "angle_deg"_a)
        .def("set_color", &ScratchboxMesh::setColor, "color"_a)
        .def_rw("material", &ScratchboxMesh::material)
        .def("compute_curvature_ao", &ScratchboxMesh::computeCurvatureAO, "intensity"_a = 0.6f)
        .def("apply_procedural_weathering", &ScratchboxMesh::applyProceduralWeathering, "frequency"_a = 2.0f, "amplitude"_a = 0.15f)
        .def("displace_along_normals", [](ScratchboxMesh& self, float frequency, float amplitude) {
            math::FastNoise3D noise(42);
            for (auto& v : self.vertices) {
                float n = noise.fBm(v.position.x * frequency, v.position.y * frequency, v.position.z * frequency, 3, 0.5f, 2.0f);
                v.position = v.position + v.normal * (n * amplitude);
            }
            self.recomputeNormals();
            self.recomputeBounds();
        }, "frequency"_a = 2.0f, "amplitude"_a = 0.05f)
        .def("tessellate_and_displace", [](ScratchboxMesh& self, uint32_t tessellationFactor, float displacementScale, float noiseFreq, float noiseAmp) {
            disp::DisplacementOptions opt;
            opt.tessellationFactor = tessellationFactor;
            opt.displacementScale = displacementScale;
            opt.proceduralNoiseFrequency = noiseFreq;
            opt.proceduralNoiseScale = noiseAmp;
            opt.enableProceduralNoise = (noiseAmp > 0.0f);
            ScratchboxMesh displaced = disp::DisplacementEngine::tessellateAndDisplaceMesh(self, opt);
            self.vertices = std::move(displaced.vertices);
            self.indices = std::move(displaced.indices);
            self.bounds = displaced.bounds;
        }, "tessellation_factor"_a = 4, "displacement_scale"_a = 0.06f, "noise_freq"_a = 32.0f, "noise_amp"_a = 0.015f)
        .def("clear", &ScratchboxMesh::clear)
        .def("recompute_normals", &ScratchboxMesh::recomputeNormals)
        .def("recompute_smooth_normals", &ScratchboxMesh::recomputeSmoothNormals)
        .def("weld_vertices", &ScratchboxMesh::weldVertices, "epsilon"_a = 1e-4f)
        .def("recompute_bounds", &ScratchboxMesh::recomputeBounds)
        .def("__repr__", [](const ScratchboxMesh& self) {
            return "<ScratchboxMesh '" + self.name + "': " +
                   std::to_string(self.vertices.size()) + " verts, " +
                   std::to_string(self.indices.size() / 3) + " tris>";
        });

    // Primitives
    m_geom.def("create_plane", [](float width, float height, int segX, int segY) {
        return GeometryBuilder::createPlane(width, height, segX, segY);
    }, "width"_a = 2.0f, "height"_a = 2.0f, "seg_x"_a = 4, "seg_y"_a = 4);

    m_geom.def("create_sphere", [](float radius, int rings, int sectors, const Vec4& color) {
        return ScratchboxMesh::createSphere(radius, rings, sectors, color);
    }, "radius"_a = 1.0f, "rings"_a = 16, "sectors"_a = 32, "color"_a = Vec4(0.9f, 0.3f, 0.3f, 1.0f));

    m_geom.def("create_box", [](const Vec3& size, const Vec4& color) {
        return ScratchboxMesh::createBox(size, color);
    }, "size"_a = Vec3(1.0f, 1.0f, 1.0f), "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_cylinder", [](float radiusTop, float radiusBottom, float height, int segments, const Vec4& color) {
        return ScratchboxMesh::createCylinder(radiusTop, radiusBottom, height, segments, color);
    }, "radius_top"_a = 1.0f, "radius_bottom"_a = 1.0f, "height"_a = 2.0f, "segments"_a = 24, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_torus", [](float mainRadius, float tubeRadius, int radialSegments, int tubularSegments, const Vec4& color) {
        return createTorus(mainRadius, tubeRadius, radialSegments, tubularSegments, color);
    }, "main_radius"_a = 1.0f, "tube_radius"_a = 0.25f, "radial_segments"_a = 24, "tubular_segments"_a = 36, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_studio_pedestal", [](float radius, float height, float bevelRadius, int segments) {
        return generateStudioPedestal(radius, height, bevelRadius, segments);
    }, "radius"_a = 4.0f, "height"_a = 0.25f, "bevel_radius"_a = 0.04f, "segments"_a = 64);

    m_geom.def("create_fluted_column", [](float radius, float height, int flutes, int segments, const Vec4& color) {
        return ScratchboxMesh::createFlutedColumn(radius, height, flutes, segments, color);
    }, "radius"_a = 0.45f, "height"_a = 7.0f, "flutes"_a = 16, "segments"_a = 48, "color"_a = Vec4(0.88f, 0.85f, 0.80f, 1.0f));

    // ========================================================================
    // 3. ARCHITECTURE SUBMODULE (Building Tools / OSM)
    // ========================================================================
    auto m_arch = m.def_submodule("architecture", "Procedural architecture grammar and roofs");

    nb::enum_<RoofType>(m_arch, "RoofType")
        .value("FlatParapet", RoofType::FlatParapet)
        .value("Gable", RoofType::Gable)
        .value("Hip", RoofType::Hip)
        .value("Mansard", RoofType::Mansard);

    nb::class_<BuildingConfig>(m_arch, "BuildingConfig")
        .def(nb::init<>())
        .def_rw("width", &BuildingConfig::width)
        .def_rw("depth", &BuildingConfig::depth)
        .def_rw("floor_count", &BuildingConfig::floorCount)
        .def_rw("floor_height", &BuildingConfig::floorHeight)
        .def_rw("ground_floor_height", &BuildingConfig::groundFloorHeight)
        .def_rw("plinth_height", &BuildingConfig::plinthHeight)
        .def_rw("bay_width", &BuildingConfig::bayWidth)
        .def_rw("window_width", &BuildingConfig::windowWidth)
        .def_rw("window_height", &BuildingConfig::windowHeight)
        .def_rw("window_recess_depth", &BuildingConfig::windowRecessDepth)
        .def_rw("roof_type", &BuildingConfig::roofType)
        .def_rw("roof_pitch_degrees", &BuildingConfig::roofPitchDegrees)
        .def_rw("roof_overhang", &BuildingConfig::roofOverhang)
        .def_rw("parapet_height", &BuildingConfig::parapetHeight);

    m_arch.def("generate_building", [](const BuildingConfig& config, const std::string& name) {
        return ProceduralBuildingGenerator::generateBuilding(config, name);
    }, "config"_a, "name"_a = "ProceduralBuilding");

    // ========================================================================
    // 4. NATURE & BOTANICAL SUBMODULE (Mtree & IvyGen)
    // ========================================================================
    auto m_nat = m.def_submodule("nature", "Procedural botanical growth, trees and ivy");

    nb::class_<SpaceColonizationConfig>(m_nat, "SpaceColonizationConfig")
        .def(nb::init<>())
        .def_rw("attractor_count", &SpaceColonizationConfig::attractorCount)
        .def_rw("crown_center", &SpaceColonizationConfig::crownCenter)
        .def_rw("crown_extents", &SpaceColonizationConfig::crownExtents)
        .def_rw("root_anchor", &SpaceColonizationConfig::rootAnchor)
        .def_rw("perception_radius", &SpaceColonizationConfig::perceptionRadius)
        .def_rw("kill_radius", &SpaceColonizationConfig::killRadius)
        .def_rw("branch_step_length", &SpaceColonizationConfig::branchStepLength)
        .def_rw("clear_trunk_height", &SpaceColonizationConfig::clearTrunkHeight)
        .def_rw("base_radius", &SpaceColonizationConfig::baseRadius)
        .def_rw("tip_radius", &SpaceColonizationConfig::tipRadius)
        .def_rw("da_vinci_exponent", &SpaceColonizationConfig::daVinciExponent)
        .def_rw("generate_leaves", &SpaceColonizationConfig::generateLeaves)
        .def_rw("use_detailed_leaves", &SpaceColonizationConfig::useDetailedLeaves)
        .def_rw("spawn_lateral_twigs", &SpaceColonizationConfig::spawnLateralTwigs)
        .def_rw("leaf_size", &SpaceColonizationConfig::leafSize)
        .def_rw("leaves_per_tip", &SpaceColonizationConfig::leavesPerTip)
        .def_rw("wood_color", &SpaceColonizationConfig::woodColor)
        .def_rw("leaf_color", &SpaceColonizationConfig::leafColor)
        .def_rw("use_twig_sprays", &SpaceColonizationConfig::useTwigSprays)
        .def_rw("root_flare_multiplier", &SpaceColonizationConfig::rootFlareMultiplier)
        .def_rw("root_flare_height", &SpaceColonizationConfig::rootFlareHeight)
        .def_rw("volumetric_density", &SpaceColonizationConfig::volumetricDensity)
        .def_rw("foliage_branch_radius_threshold", &SpaceColonizationConfig::foliageBranchRadiusThreshold)
        .def_rw("lateral_twig_probability", &SpaceColonizationConfig::lateralTwigProbability)
        .def_rw("outward_arch_factor", &SpaceColonizationConfig::outwardArchFactor)
        .def_rw("growth_momentum_factor", &SpaceColonizationConfig::growthMomentumFactor)
        .def_rw("cantilever_droop", &SpaceColonizationConfig::cantileverDroop)
        .def_rw("is_shrub", &SpaceColonizationConfig::isShrub)
        .def_rw("seed", &SpaceColonizationConfig::seed);

    m_nat.def("generate_tree", [](const SpaceColonizationConfig& config) {
        geometry::Mesh legacy = SpaceColonizationTreeGenerator::generateTree(config);
        return legacy.toScratchboxMesh();
    }, "config"_a, "Generate a realistic botanical tree using Runions space colonization");

    nb::class_<LSystemTreeParams>(m_nat, "LSystemTreeParams")
        .def(nb::init<>())
        .def_rw("max_depth", &LSystemTreeParams::maxDepth)
        .def_rw("initial_length", &LSystemTreeParams::initialLength)
        .def_rw("initial_radius", &LSystemTreeParams::initialRadius)
        .def_rw("branch_angle_min", &LSystemTreeParams::branchAngleMin)
        .def_rw("branch_angle_max", &LSystemTreeParams::branchAngleMax)
        .def_rw("length_decay", &LSystemTreeParams::lengthDecay)
        .def_rw("gravity_droop", &LSystemTreeParams::gravityDroop)
        .def_rw("children_per_node", &LSystemTreeParams::childrenPerNode)
        .def_rw("generate_leaves", &LSystemTreeParams::generateLeaves)
        .def_rw("use_detailed_foliage_cards", &LSystemTreeParams::useDetailedFoliageCards)
        .def_rw("transfer_smooth_normals", &LSystemTreeParams::transferSmoothNormals)
        .def_rw("normal_transfer_mix_factor", &LSystemTreeParams::normalTransferMixFactor)
        .def_rw("leaf_size", &LSystemTreeParams::leafSize)
        .def_rw("seed", &LSystemTreeParams::seed);

    m_nat.def("generate_lsystem_tree", [](const Vec3& root_pos, const LSystemTreeParams& params) {
        geometry::Mesh legacy = generateProceduralTree(root_pos, params);
        return legacy.toScratchboxMesh();
    }, "root_pos"_a = Vec3(0, 0, 0), "params"_a = LSystemTreeParams(), "Generate an L-system tree with transferred envelope normals");

    nb::class_<IvyConfig>(m_nat, "IvyConfig")
        .def(nb::init<>())
        .def_rw("root_position", &IvyConfig::rootPosition)
        .def_rw("obstacle_min", &IvyConfig::obstacleMin)
        .def_rw("obstacle_max", &IvyConfig::obstacleMax)
        .def_rw("max_steps", &IvyConfig::maxSteps)
        .def_rw("cling_distance", &IvyConfig::clingDistance);

    m_nat.def("generate_ivy", [](const IvyConfig& config) {
        geometry::Mesh legacy = IvyGrowthGenerator::generateIvy(config);
        return legacy.toScratchboxMesh();
    }, "config"_a, "Generate obstacle-clinging ivy vines across geometric boundaries");

    // ========================================================================
    // 5. COMPOSER SUBMODULE (Scene Staging, Scattering, Weathering & Lighting)
    // ========================================================================
    auto m_comp = m.def_submodule("composer", "Scene staging, instance scattering and lighting");

    nb::class_<InstanceTransform>(m_comp, "InstanceTransform")
        .def(nb::init<>())
        .def_rw("position", &InstanceTransform::position)
        .def_rw("scale", &InstanceTransform::scale)
        .def_rw("rotation", &InstanceTransform::rotation);

    m_comp.def("scatter_instances", [](const ScratchboxMesh& baseMesh, size_t count, float minScale, float maxScale, uint32_t seed) {
        return scatterInstancesOnMesh(baseMesh, count, minScale, maxScale, seed);
    }, "base_mesh"_a, "count"_a, "min_scale"_a = 0.6f, "max_scale"_a = 1.4f, "seed"_a = 42,
       "Scatter object transforms across mesh surface using Poisson-disk area-weighting");

    nb::class_<MeshCurvatureResult>(m_comp, "MeshCurvatureResult")
        .def_ro("pointiness", &MeshCurvatureResult::pointiness)
        .def_ro("cavity_ao", &MeshCurvatureResult::cavityAO);

    m_comp.def("compute_curvature", &computeMeshCurvature, "mesh"_a,
               "Extract Blender-style Pointiness (convex edge wear) and Cavity AO (concave dirt)");

    nb::class_<StudioLight>(m_comp, "StudioLight")
        .def_rw("name", &StudioLight::name)
        .def_rw("position", &StudioLight::position)
        .def_rw("color", &StudioLight::color)
        .def_rw("intensity", &StudioLight::intensity)
        .def_rw("color_temperature_kelvin", &StudioLight::colorTemperatureKelvin);

    nb::class_<StudioLightingRig>(m_comp, "StudioLightingRig")
        .def_rw("key_light", &StudioLightingRig::keyLight)
        .def_rw("fill_light", &StudioLightingRig::fillLight)
        .def_rw("rim_light", &StudioLightingRig::rimLight)
        .def_rw("floor_bounce", &StudioLightingRig::floorBounce);

    m_comp.def("create_cinematic_studio_lighting", &createCinematicStudioLighting,
               "target_center"_a = Vec3(0, 1.0f, 0), "rig_scale"_a = 5.0f);

    // ========================================================================
    // 6. SHAPER SUBMODULE (DEFORMERS & SCULPTING)
    // ========================================================================
    auto m_shaper = m.def_submodule("shaper", "Non-linear geometric mesh deformers and procedural shaping");

    m_shaper.def("taper", [](ScratchboxMesh& mesh, int axisIdx, float factor) {
        shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::taper(mesh, axis, factor);
    }, "mesh"_a, "axis"_a = 1, "factor"_a = 0.5f);

    m_shaper.def("twist", [](ScratchboxMesh& mesh, int axisIdx, float angleDeg) {
        shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::twist(mesh, axis, angleDeg);
    }, "mesh"_a, "axis"_a = 1, "angle_deg"_a = 45.0f);

    m_shaper.def("bend", [](ScratchboxMesh& mesh, int mainAxisIdx, int bendAxisIdx, float angleDeg, float radius) {
        shaper::Axis mainAxis = mainAxisIdx == 0 ? shaper::Axis::X : (mainAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Axis bendAxis = bendAxisIdx == 0 ? shaper::Axis::X : (bendAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::bend(mesh, mainAxis, bendAxis, angleDeg * (math::PI / 180.0f), radius);
    }, "mesh"_a, "main_axis"_a = 1, "bend_axis"_a = 0, "angle_deg"_a = 30.0f, "radius"_a = 2.0f);

    m_shaper.def("bulge", [](ScratchboxMesh& mesh, const Vec3& center, float radius, float strength, float power) {
        shaper::Deformer::bulge(mesh, center, radius, strength, power);
    }, "mesh"_a, "center"_a = Vec3(0, 0, 0), "radius"_a = 1.0f, "strength"_a = 0.3f, "power"_a = 2.0f);

    // ========================================================================
    // 7. IO & STREAMING SUBMODULE
    // ========================================================================
    auto m_io = m.def_submodule("io", "glTF 2.0 binary (.glb) packing and file serialization");

    m_io.def("write_glb", [](const std::string& path, const ScratchboxMesh& mesh) {
        auto glb = GlbWriter::writeGlb(mesh);
        std::ofstream out(path, std::ios::binary);
        if (!out.is_open()) {
            throw std::runtime_error("Failed to open file for writing: " + path);
        }
        out.write(reinterpret_cast<const char*>(glb.data()), static_cast<std::streamsize>(glb.size()));
        out.close();
        return true;
    }, "path"_a, "mesh"_a, "Save a ScratchboxMesh directly to a standard binary glTF 2.0 (.glb) file");

    m_io.def("write_glb", [](const std::string& path, const std::vector<ScratchboxMesh>& meshes) {
        auto glb = GlbWriter::serializeMultiMeshToGlb(meshes);
        std::ofstream out(path, std::ios::binary);
        if (!out.is_open()) {
            throw std::runtime_error("Failed to open file for writing: " + path);
        }
        out.write(reinterpret_cast<const char*>(glb.data()), static_cast<std::streamsize>(glb.size()));
        out.close();
        return true;
    }, "path"_a, "meshes"_a, "Save multiple ScratchboxMeshes with distinct PBR materials to a multi-mesh glTF 2.0 (.glb) file");

    m_io.def("export_glb_bytes", [](const ScratchboxMesh& mesh) {
        auto glb = GlbWriter::writeGlb(mesh);
        return nb::bytes(reinterpret_cast<const char*>(glb.data()), glb.size());
    }, "mesh"_a, "Export ScratchboxMesh directly as a Python bytes object containing .glb data");

    m_io.def("export_glb_bytes", [](const std::vector<ScratchboxMesh>& meshes) {
        auto glb = GlbWriter::serializeMultiMeshToGlb(meshes);
        return nb::bytes(reinterpret_cast<const char*>(glb.data()), glb.size());
    }, "meshes"_a, "Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data");
}
