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
#include <nanobind/stl/tuple.h>
#include <nanobind/stl/optional.h>
#include <nanobind/stl/unordered_map.h>

#include "scratchbox_engine.hpp"
#include "scratchbox_core.hpp"
#include "scratchbox_sdf.hpp"
#include "scratchbox_hair.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_parametric_human.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include "scratchbox_sb_rig.hpp"
#include "scratchbox_sb_veggie_grove.hpp"
#include "scratchbox_mesh_edit.hpp"
#include "scratchbox_scan_massing.hpp"
#include "scratchbox_roof_objects.hpp"

namespace nb = nanobind;
using namespace nb::literals;

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::architecture;
using namespace scratchbox::nature;
using namespace scratchbox::composer;
using namespace scratchbox::io;
using namespace scratchbox::sb_archi;
using namespace scratchbox::core;
using namespace scratchbox::parametric;
using namespace scratchbox::kinematics;
using namespace scratchbox::skinning;

NB_MODULE(scratchbox_native, m) {
    nb::set_leak_warnings(false);
    m.doc() = "Scratchbox Native C++20 3D Engine Python Bindings (powered by nanobind)";

    // Classical Roman Orders
    nb::enum_<core::RomanOrder>(m, "RomanOrder")
        .value("Tuscan", core::RomanOrder::Tuscan)
        .value("Doric", core::RomanOrder::Doric)
        .value("Ionic", core::RomanOrder::Ionic)
        .value("Corinthian", core::RomanOrder::Corinthian)
        .value("Composite", core::RomanOrder::Composite)
        .value("AtticPilaster", core::RomanOrder::AtticPilaster);

    // ========================================================================
    // 1. MATH SUBMODULE
    // ========================================================================
    auto m_math = m.def_submodule("math", "High-performance vector and spatial math");

    nb::class_<Vec2>(m_math, "Vec2")
        .def(nb::init<>())
        .def(nb::init<float, float>(), "x"_a, "y"_a)
        .def("__init__", [](Vec2* self, std::tuple<float, float> t) {
            new (self) Vec2(std::get<0>(t), std::get<1>(t));
        })
        .def_rw("x", &Vec2::x)
        .def_rw("y", &Vec2::y)
        .def("__len__", [](const Vec2&) { return 2; })
        .def("__getitem__", [](const Vec2& v, int64_t idx) {
            if (idx < 0) idx += 2;
            if (idx == 0) return v.x;
            if (idx == 1) return v.y;
            throw nb::index_error();
        })
        .def("__setitem__", [](Vec2& v, int64_t idx, float val) {
            if (idx < 0) idx += 2;
            if (idx == 0) { v.x = val; return; }
            if (idx == 1) { v.y = val; return; }
            throw nb::index_error();
        })
        .def("__iter__", [](const Vec2& v) {
            return nb::iter(nb::make_tuple(v.x, v.y));
        })
        .def("__neg__", [](const Vec2& v) { return Vec2(-v.x, -v.y); })
        .def("__eq__", [](const Vec2& a, const Vec2& b) {
            return std::abs(a.x - b.x) < 1e-6f && std::abs(a.y - b.y) < 1e-6f;
        })
        .def("__repr__", [](const Vec2& v) {
            return "Vec2(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ")";
        });

    nb::class_<Vec3>(m_math, "Vec3")
        .def(nb::init<>())
        .def(nb::init<float, float, float>(), "x"_a, "y"_a, "z"_a)
        .def("__init__", [](Vec3* self, std::tuple<float, float, float> t) {
            new (self) Vec3(std::get<0>(t), std::get<1>(t), std::get<2>(t));
        })
        .def_rw("x", &Vec3::x)
        .def_rw("y", &Vec3::y)
        .def_rw("z", &Vec3::z)
        .def("length", &Vec3::length)
        .def("normalized", &Vec3::normalized)
        .def("dot", &Vec3::dot)
        .def("cross", &Vec3::cross)
        .def("__len__", [](const Vec3&) { return 3; })
        .def("__getitem__", [](const Vec3& v, int64_t idx) {
            if (idx < 0) idx += 3;
            if (idx == 0) return v.x;
            if (idx == 1) return v.y;
            if (idx == 2) return v.z;
            throw nb::index_error();
        })
        .def("__setitem__", [](Vec3& v, int64_t idx, float val) {
            if (idx < 0) idx += 3;
            if (idx == 0) { v.x = val; return; }
            if (idx == 1) { v.y = val; return; }
            if (idx == 2) { v.z = val; return; }
            throw nb::index_error();
        })
        .def("__iter__", [](const Vec3& v) {
            return nb::iter(nb::make_tuple(v.x, v.y, v.z));
        })
        .def("__neg__", [](const Vec3& v) { return Vec3(-v.x, -v.y, -v.z); })
        .def("__eq__", [](const Vec3& a, const Vec3& b) {
            return std::abs(a.x - b.x) < 1e-6f && std::abs(a.y - b.y) < 1e-6f && std::abs(a.z - b.z) < 1e-6f;
        })
        .def("__add__", [](const Vec3& a, const Vec3& b) { return a + b; })
        .def("__sub__", [](const Vec3& a, const Vec3& b) { return a - b; })
        .def("__mul__", [](const Vec3& a, float s) { return a * s; })
        .def("__mul__", [](const Vec3& a, const Vec3& b) { return Vec3(a.x * b.x, a.y * b.y, a.z * b.z); })
        .def("__rmul__", [](const Vec3& a, float s) { return a * s; })
        .def("__truediv__", [](const Vec3& a, float s) { return a * (1.0f / s); })
        .def("__repr__", [](const Vec3& v) {
            return "Vec3(" + std::to_string(v.x) + ", " + std::to_string(v.y) + ", " + std::to_string(v.z) + ")";
        });

    nb::class_<Vec4>(m_math, "Vec4")
        .def(nb::init<>())
        .def(nb::init<float, float, float, float>(), "x"_a, "y"_a, "z"_a, "w"_a)
        .def("__init__", [](Vec4* self, std::tuple<float, float, float, float> t) {
            new (self) Vec4(std::get<0>(t), std::get<1>(t), std::get<2>(t), std::get<3>(t));
        })
        .def_rw("x", &Vec4::x)
        .def_rw("y", &Vec4::y)
        .def_rw("z", &Vec4::z)
        .def_rw("w", &Vec4::w)
        .def("__len__", [](const Vec4&) { return 4; })
        .def("__getitem__", [](const Vec4& v, int64_t idx) {
            if (idx < 0) idx += 4;
            if (idx == 0) return v.x;
            if (idx == 1) return v.y;
            if (idx == 2) return v.z;
            if (idx == 3) return v.w;
            throw nb::index_error();
        })
        .def("__setitem__", [](Vec4& v, int64_t idx, float val) {
            if (idx < 0) idx += 4;
            if (idx == 0) { v.x = val; return; }
            if (idx == 1) { v.y = val; return; }
            if (idx == 2) { v.z = val; return; }
            if (idx == 3) { v.w = val; return; }
            throw nb::index_error();
        })
        .def("__iter__", [](const Vec4& v) {
            return nb::iter(nb::make_tuple(v.x, v.y, v.z, v.w));
        })
        .def("__neg__", [](const Vec4& v) { return Vec4(-v.x, -v.y, -v.z, -v.w); })
        .def("__eq__", [](const Vec4& a, const Vec4& b) {
            return std::abs(a.x - b.x) < 1e-6f && std::abs(a.y - b.y) < 1e-6f &&
                   std::abs(a.z - b.z) < 1e-6f && std::abs(a.w - b.w) < 1e-6f;
        })
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
        .def("__len__", [](const Quat&) { return 4; })
        .def("__getitem__", [](const Quat& q, int64_t idx) {
            if (idx < 0) idx += 4;
            if (idx == 0) return q.x;
            if (idx == 1) return q.y;
            if (idx == 2) return q.z;
            if (idx == 3) return q.w;
            throw nb::index_error();
        })
        .def("__iter__", [](const Quat& q) {
            return nb::iter(nb::make_tuple(q.x, q.y, q.z, q.w));
        })
        .def("__neg__", [](const Quat& q) { return Quat(-q.x, -q.y, -q.z, -q.w); })
        .def_static("from_axis_angle", &Quat::fromAxisAngle, "axis"_a, "angle_radians"_a)
        .def("rotate", &Quat::rotate, "vec"_a)
        .def("__repr__", [](const Quat& q) {
            return "Quat(" + std::to_string(q.x) + ", " + std::to_string(q.y) + ", " +
                   std::to_string(q.z) + ", " + std::to_string(q.w) + ")";
        });

    nb::class_<AABB>(m_math, "AABB")
        .def(nb::init<>())
        .def(nb::init<Vec3, Vec3>(), "min"_a, "max"_a)
        .def_rw("min", &AABB::min)
        .def_rw("max", &AABB::max)
        .def_prop_ro("center", &AABB::center)
        .def_prop_ro("size", &AABB::size)
        .def_prop_ro("surface_area", &AABB::surfaceArea)
        .def("contains", &AABB::contains, "p"_a)
        .def("intersects", &AABB::intersects, "other"_a)
        .def("expand", [](AABB& self, const Vec3& p) { self.expand(p); }, "p"_a)
        .def("expand_box", [](AABB& self, const AABB& o) { self.expand(o); }, "other"_a)
        .def("__repr__", [](const AABB& b) {
            return "AABB(min=" + std::to_string(b.min.x) + "," + std::to_string(b.min.y) + "," + std::to_string(b.min.z) +
                   ", max=" + std::to_string(b.max.x) + "," + std::to_string(b.max.y) + "," + std::to_string(b.max.z) + ")";
        });

    // ========================================================================
    // 2. GEOMETRY & MATERIAL SUBMODULE
    // ========================================================================
    auto m_geom = m.def_submodule("geometry", "Mesh topology, primitives and PBR materials");

    nb::class_<Vertex>(m_geom, "Vertex")
        .def(nb::init<>())
        .def(nb::init<Vec3, Vec3, Vec2, Vec4, Vec4>(), "position"_a, "normal"_a = Vec3(0, 1, 0), "uv"_a = Vec2(0, 0), "color"_a = Vec4(1, 1, 1, 1), "tangent"_a = Vec4(1, 0, 0, 1))
        .def_rw("position", &Vertex::position)
        .def_rw("normal", &Vertex::normal)
        .def_rw("uv", &Vertex::uv)
        .def_rw("color", &Vertex::color)
        .def_rw("tangent", &Vertex::tangent);

    nb::class_<PbrMaterial>(m_geom, "PbrMaterial")
        .def(nb::init<std::string>(), "name"_a = "defaultMaterial")
        .def("__init__", [](PbrMaterial* self,
                            const std::string& name,
                            std::optional<Vec4> base_color,
                            std::optional<Vec4> color,
                            std::optional<float> metallic,
                            std::optional<float> metalness,
                            std::optional<float> roughness,
                            nb::object emissive,
                            std::optional<float> emissive_intensity,
                            std::optional<float> clearcoat,
                            std::optional<float> ior) {
            new (self) PbrMaterial();
            self->name = name;
            if (base_color) self->baseColorFactor = *base_color;
            else if (color) self->baseColorFactor = *color;

            if (metallic) self->metallicFactor = *metallic;
            else if (metalness) self->metallicFactor = *metalness;

            if (roughness) self->roughnessFactor = *roughness;

            float intensity = emissive_intensity.value_or(1.0f);
            if (!emissive.is_none()) {
                if (nb::isinstance<Vec3>(emissive)) {
                    self->emissiveFactor = nb::cast<Vec3>(emissive) * intensity;
                } else if (nb::isinstance<Vec4>(emissive)) {
                    auto v4 = nb::cast<Vec4>(emissive);
                    self->emissiveFactor = Vec3(v4.x, v4.y, v4.z) * intensity;
                } else if (nb::isinstance<nb::tuple>(emissive) || nb::isinstance<nb::list>(emissive)) {
                    auto seq = nb::cast<nb::sequence>(emissive);
                    if (nb::len(seq) >= 3) {
                        float ex = nb::cast<float>(seq[0]);
                        float ey = nb::cast<float>(seq[1]);
                        float ez = nb::cast<float>(seq[2]);
                        self->emissiveFactor = Vec3(ex, ey, ez) * intensity;
                    }
                }
            }
            if (clearcoat) self->clearcoatFactor = *clearcoat;
            if (ior) self->ior = *ior;
        }, "name"_a = "defaultMaterial",
           "base_color"_a = nb::none(),
           "color"_a = nb::none(),
           "metallic"_a = nb::none(),
           "metalness"_a = nb::none(),
           "roughness"_a = nb::none(),
           "emissive"_a = nb::none(),
           "emissive_intensity"_a = nb::none(),
           "clearcoat"_a = nb::none(),
           "ior"_a = nb::none())
        .def_rw("name", &PbrMaterial::name)
        .def_rw("base_color", &PbrMaterial::baseColorFactor)
        .def_prop_rw("color",
            [](const PbrMaterial& self) { return self.baseColorFactor; },
            [](PbrMaterial& self, const Vec4& c) { self.baseColorFactor = c; })
        .def_rw("metallic", &PbrMaterial::metallicFactor)
        .def_prop_rw("metalness",
            [](const PbrMaterial& self) { return self.metallicFactor; },
            [](PbrMaterial& self, float val) { self.metallicFactor = val; })
        .def_rw("roughness", &PbrMaterial::roughnessFactor)
        .def_rw("emissive", &PbrMaterial::emissiveFactor)
        .def_prop_rw("emissive_intensity",
            [](const PbrMaterial& self) { return self.emissiveStrength; },
            [](PbrMaterial& self, float val) { self.emissiveStrength = val; })
        .def_rw("clearcoat", &PbrMaterial::clearcoatFactor)
        .def_rw("clearcoat_roughness", &PbrMaterial::clearcoatRoughnessFactor)
        .def_rw("transmission", &PbrMaterial::transmissionFactor)
        .def_rw("thickness", &PbrMaterial::thicknessFactor)
        .def_rw("double_sided", &PbrMaterial::doubleSided)
        .def_rw("ior", &PbrMaterial::ior)
        .def("set_base_color", [](PbrMaterial& self, const Vec4& c) { self.baseColorFactor = c; }, "color"_a)
        .def("set_color", [](PbrMaterial& self, const Vec4& c) { self.baseColorFactor = c; }, "color"_a)
        .def_static("titanium", &PbrMaterial::titanium)
        .def_static("chrome", &PbrMaterial::chrome)
        .def_static("gold", &PbrMaterial::gold)
        .def_static("basalt_rock", &PbrMaterial::basaltRock)
        .def_static("wood_oak", &PbrMaterial::woodOak)
        .def_static("rough_wood", &PbrMaterial::roughWood)
        .def_static("optical_glass", &PbrMaterial::opticalGlass)
        .def_static("stone_limestone", &PbrMaterial::stoneLimestone)
        .def_static("concrete_brutalist", &PbrMaterial::concreteBrutalist)
        .def_static("asphalt_street", &PbrMaterial::asphaltStreet)
        .def_static("quartz_crystal", &PbrMaterial::quartzCrystal)
        .def_static("carbon_composite", &PbrMaterial::carbonComposite)
        .def_static("polished_brass", &PbrMaterial::polishedBrass)
        .def_static("copper_bullet", &PbrMaterial::copperBullet)
        .def_static("metal_dark_anodized", &PbrMaterial::metalDarkAnodized)
        .def_static("metal_brushed_steel", &PbrMaterial::metalBrushedSteel)
        .def_static("plastic_smooth_black", &PbrMaterial::plasticSmoothBlack)
        .def_static("plastic_shiny", &PbrMaterial::plasticShiny, "color"_a = Vec4(0.85f, 0.85f, 0.85f, 1.0f))
        .def_static("glass_tinted", &PbrMaterial::glassTinted, "color"_a = Vec4(0.85f, 0.92f, 0.98f, 0.25f), "roughness"_a = 0.08f, "ior"_a = 1.52f)
        .def_static("stone_rough", &PbrMaterial::stoneRough, "color"_a = Vec4(0.55f, 0.53f, 0.50f, 1.0f))
        .def_static("obsidian", &PbrMaterial::obsidian)
        .def_static("emissive_glow", [](const Vec3& color, float intensity) {
            return PbrMaterial::emissiveGlow(color, intensity);
        }, "color"_a, "intensity"_a = 1.0f);

    nb::class_<ScratchboxMesh>(m_geom, "Mesh", nb::dynamic_attr(), nb::is_weak_referenceable())
        .def(nb::init<>())
        .def(nb::init<std::string>(), "name"_a = "mesh")
        .def_rw("name", &ScratchboxMesh::name)
        .def_rw("material", &ScratchboxMesh::material)
        .def_prop_ro("vertex_count", [](const ScratchboxMesh& self) { return self.vertices.size(); })
        .def_prop_ro("triangle_count", [](const ScratchboxMesh& self) { return self.indices.size() / 3; })
        .def_prop_ro("bounds", [](const ScratchboxMesh& self) { return self.bounds; })
        .def_prop_ro("vertices", [](const ScratchboxMesh& self) { return self.vertices; })
        .def_prop_ro("indices", [](const ScratchboxMesh& self) { return self.indices; })
        .def("get_positions_flat", [](const ScratchboxMesh& self) {
            std::vector<float> coords;
            coords.reserve(self.vertices.size() * 3);
            for (const auto& v : self.vertices) {
                coords.push_back(v.position.x);
                coords.push_back(v.position.y);
                coords.push_back(v.position.z);
            }
            return nb::bytes(reinterpret_cast<const char*>(coords.data()), coords.size() * sizeof(float));
        })
        .def("get_normals_flat", [](const ScratchboxMesh& self) {
            std::vector<float> coords;
            coords.reserve(self.vertices.size() * 3);
            for (const auto& v : self.vertices) {
                coords.push_back(v.normal.x);
                coords.push_back(v.normal.y);
                coords.push_back(v.normal.z);
            }
            return nb::bytes(reinterpret_cast<const char*>(coords.data()), coords.size() * sizeof(float));
        })
        .def("get_indices_bytes", [](const ScratchboxMesh& self) {
            return nb::bytes(reinterpret_cast<const char*>(self.indices.data()), self.indices.size() * sizeof(uint32_t));
        })
        .def("add_vertex", [](ScratchboxMesh& self, const Vec3& pos, const Vec3& norm, const Vec2& uv, const Vec4& color) {
            self.addVertex(Vertex(pos, norm, uv, color));
        }, "pos"_a, "norm"_a = Vec3(0, 1, 0), "uv"_a = Vec2(0, 0), "color"_a = Vec4(1, 1, 1, 1))
        .def("add_triangle", &ScratchboxMesh::addTriangle, "i0"_a, "i1"_a, "i2"_a)
        .def("append", [](ScratchboxMesh& self, const ScratchboxMesh& other) -> ScratchboxMesh& {
            self.append(other);
            return self;
        }, "other"_a, "Merge another mesh into this container")
        .def("translate", [](ScratchboxMesh& self, const Vec3& offset) -> ScratchboxMesh& {
            self.translate(offset);
            return self;
        }, "offset"_a)
        .def("scale", [](ScratchboxMesh& self, const Vec3& factors) -> ScratchboxMesh& {
            self.scale(factors);
            return self;
        }, "factors"_a)
        .def("rotate_x", [](ScratchboxMesh& self, float angle_deg) -> ScratchboxMesh& {
            self.rotateX(angle_deg);
            return self;
        }, "angle_deg"_a)
        .def("rotate_y", [](ScratchboxMesh& self, float angle_deg) -> ScratchboxMesh& {
            self.rotateY(angle_deg);
            return self;
        }, "angle_deg"_a)
        .def("rotate_z", [](ScratchboxMesh& self, float angle_deg) -> ScratchboxMesh& {
            self.rotateZ(angle_deg);
            return self;
        }, "angle_deg"_a)
        .def("set_color", [](ScratchboxMesh& self, const Vec4& color) -> ScratchboxMesh& {
            self.setColor(color);
            return self;
        }, "color"_a)
        .def("multiply_vertex_colors", [](ScratchboxMesh& self, const Vec4& factor) -> ScratchboxMesh& {
            for (auto& v : self.vertices) {
                v.color = Vec4(v.color.x * factor.x, v.color.y * factor.y, v.color.z * factor.z, v.color.w * factor.w);
            }
            return self;
        }, "factor"_a, "Multiply every vertex colour (COLOR_0) component-wise, keeping per-vertex variation such as AO")
        .def_rw("material", &ScratchboxMesh::material)
        .def("set_material", [](ScratchboxMesh& self, const PbrMaterial& mat) -> ScratchboxMesh& {
            self.material = mat;
            return self;
        }, "material"_a)
        .def("apply_material", [](ScratchboxMesh& self, const PbrMaterial& mat) -> ScratchboxMesh& {
            self.material = mat;
            return self;
        }, "material"_a)
        .def("compute_curvature_ao", [](ScratchboxMesh& self, float intensity) -> ScratchboxMesh& {
            self.computeCurvatureAO(intensity);
            return self;
        }, "intensity"_a = 0.6f)
        .def("apply_procedural_weathering", [](ScratchboxMesh& self, float freq, float amp) -> ScratchboxMesh& {
            self.applyProceduralWeathering(freq, amp);
            return self;
        }, "frequency"_a = 2.0f, "amplitude"_a = 0.15f)
        .def("displace_along_normals", [](ScratchboxMesh& self, float frequency, float amplitude) -> ScratchboxMesh& {
            math::FastNoise3D noise(42);
            // 3-octave fBm has a p99 magnitude of ~0.44; normalizing makes `amplitude` the approximate peak relief in metres.
            constexpr float kFbmP99 = 0.44f;
            for (auto& v : self.vertices) {
                float n = noise.fBm(v.position.x * frequency, v.position.y * frequency, v.position.z * frequency, 3, 2.0f, 0.5f) / kFbmP99;
                v.position = v.position + v.normal * (n * amplitude);
            }
            self.recomputeNormals();
            self.recomputeBounds();
            return self;
        }, "frequency"_a = 2.0f, "amplitude"_a = 0.05f)
        .def("tessellate_and_displace", [](ScratchboxMesh& self, uint32_t tessellationFactor, float displacementScale, float noiseFreq, float noiseAmp) -> ScratchboxMesh& {
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
            return self;
        }, "tessellation_factor"_a = 4, "displacement_scale"_a = 0.06f, "noise_freq"_a = 32.0f, "noise_amp"_a = 0.015f)
        .def("clear", &ScratchboxMesh::clear)
        .def("recompute_normals", [](ScratchboxMesh& self) -> ScratchboxMesh& {
            self.recomputeNormals();
            return self;
        })
        .def("recompute_smooth_normals", [](ScratchboxMesh& self) -> ScratchboxMesh& {
            self.recomputeSmoothNormals();
            return self;
        })
        .def("weld_vertices", [](ScratchboxMesh& self, float epsilon) -> ScratchboxMesh& {
            self.weldVertices(epsilon);
            return self;
        }, "epsilon"_a = 1e-4f)
        .def("recompute_bounds", [](ScratchboxMesh& self) -> ScratchboxMesh& {
            self.recomputeBounds();
            return self;
        })
        .def("subdivide", [](ScratchboxMesh& self, int iterations) -> ScratchboxMesh& {
            self = shaper::LoopSubdivision::subdivide(self, iterations);
            return self;
        }, "iterations"_a = 1)
        .def("taper", [](ScratchboxMesh& self, int axisIdx, float factor) -> ScratchboxMesh& {
            shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
            shaper::Deformer::taper(self, axis, factor);
            return self;
        }, "axis"_a = 1, "factor"_a = 0.5f)
        .def("twist", [](ScratchboxMesh& self, int axisIdx, float angleDeg) -> ScratchboxMesh& {
            shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
            shaper::Deformer::twist(self, axis, angleDeg);
            return self;
        }, "axis"_a = 1, "angle_deg"_a = 45.0f)
        .def("bend", [](ScratchboxMesh& self, int mainAxisIdx, int bendAxisIdx, float angleDeg, float radius) -> ScratchboxMesh& {
            shaper::Axis mainAxis = mainAxisIdx == 0 ? shaper::Axis::X : (mainAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
            shaper::Axis bendAxis = bendAxisIdx == 0 ? shaper::Axis::X : (bendAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
            shaper::Deformer::bend(self, mainAxis, bendAxis, angleDeg * (math::PI / 180.0f), radius);
            return self;
        }, "main_axis"_a = 1, "bend_axis"_a = 0, "angle_deg"_a = 30.0f, "radius"_a = 2.0f)
        .def("bulge", [](ScratchboxMesh& self, const Vec3& center, float radius, float strength, float power) -> ScratchboxMesh& {
            shaper::Deformer::bulge(self, center, radius, strength, power);
            return self;
        }, "center"_a = Vec3(0, 0, 0), "radius"_a = 1.0f, "strength"_a = 0.3f, "power"_a = 2.0f)
        .def("taubin_smooth", [](ScratchboxMesh& self, int iterations, float lambdaVal, float muVal, bool preserveBoundaries) -> ScratchboxMesh& {
            processing::TaubinSmoothOptions opt;
            opt.iterations = iterations;
            opt.lambda = lambdaVal;
            opt.mu = muVal;
            opt.preserveBoundaries = preserveBoundaries;
            processing::TaubinSmoother::smooth(self, opt);
            return self;
        }, "iterations"_a = 10, "lambda_val"_a = 0.5f, "mu_val"_a = -0.53f, "preserve_boundaries"_a = true)
        .def("clean", [](ScratchboxMesh& self, float weldEpsilon) -> ScratchboxMesh& {
            processing::CleanMeshOptions opt;
            opt.weldEpsilon = weldEpsilon;
            ScratchboxMesh res = processing::MeshCleaner::clean(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "weld_epsilon"_a = 1e-5f)
        .def("bake_cavity_ao", [](ScratchboxMesh& self, float intensity) -> ScratchboxMesh& {
            processing::DifferentialGeometryEngine::bakeCavityAO(self, intensity);
            return self;
        }, "intensity"_a = 0.65f)
        .def("bake_rtao", [](ScratchboxMesh& self, int samplesPerVertex, float maxDistance, float intensity, uint32_t seed) -> ScratchboxMesh& {
            bvh::bakeMeshRTAO(self, samplesPerVertex, maxDistance, intensity, seed);
            return self;
        }, "samples_per_vertex"_a = 16, "max_distance"_a = 1.5f, "intensity"_a = 1.0f, "seed"_a = 42)
        .def("compute_rtao", [](const ScratchboxMesh& self, int samplesPerVertex, float maxDistance, uint32_t seed) {
            return bvh::computeMeshRTAO(self, samplesPerVertex, maxDistance, seed);
        }, "samples_per_vertex"_a = 16, "max_distance"_a = 1.5f, "seed"_a = 42)
        .def("slice_by_plane", [](ScratchboxMesh& self, const Vec3& planePoint, const Vec3& planeNormal, bool keepPositive, bool capCut) -> ScratchboxMesh& {
            ScratchboxMesh res = processing::PlanarSlicer::slice(self, planePoint, planeNormal, keepPositive, capCut);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "plane_point"_a = Vec3(0, 0, 0), "plane_normal"_a = Vec3(0, 1, 0), "keep_positive"_a = true, "cap_cut"_a = true)
        .def("isotropic_remesh", [](ScratchboxMesh& self, float targetEdgeLength, int iterations, float creaseAngleDeg) -> ScratchboxMesh& {
            processing::IsotropicRemeshOptions opt;
            opt.targetEdgeLength = targetEdgeLength;
            opt.iterations = iterations;
            opt.creaseAngleDeg = creaseAngleDeg;
            ScratchboxMesh res = processing::IsotropicRemesher::remesh(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "target_edge_length"_a = 0.25f, "iterations"_a = 4, "crease_angle_deg"_a = 45.0f)
        .def("decimate_qem", [](ScratchboxMesh& self, size_t targetTriangles, float targetRatio, float maxError, bool preserveBoundary, bool preserveCreases, float creaseAngleDeg) -> ScratchboxMesh& {
            processing::DecimateOptions opt;
            opt.targetTriangles = targetTriangles;
            opt.targetRatio = targetRatio;
            opt.maxError = maxError;
            opt.preserveBoundary = preserveBoundary;
            opt.preserveCreases = preserveCreases;
            opt.creaseAngleDeg = creaseAngleDeg;
            ScratchboxMesh res = processing::QuadricDecimator::decimate(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "target_triangles"_a = 0, "target_ratio"_a = 0.5f, "max_error"_a = 1e9f, "preserve_boundary"_a = true,
           "preserve_creases"_a = false, "crease_angle_deg"_a = 45.0f)
        .def("decimate", [](ScratchboxMesh& self, float ratio, size_t targetTriangles) -> ScratchboxMesh& {
            processing::DecimateOptions opt;
            opt.targetTriangles = targetTriangles;
            opt.targetRatio = ratio;
            ScratchboxMesh res = processing::QuadricDecimator::decimate(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "ratio"_a = 0.5f, "target_triangles"_a = 0)
        .def("poisson_sample", [](const ScratchboxMesh& self, size_t count, float minDistance, uint32_t seed) {
            processing::PoissonSampleOptions opt;
            opt.targetCount = count;
            opt.minDistance = minDistance;
            opt.seed = seed;
            return processing::PoissonDiskSampler::sample(self, opt);
        }, "count"_a = 100, "min_distance"_a = 0.0f, "seed"_a = 42)
        .def("fill_holes", [](ScratchboxMesh& self, size_t maxHoleEdges) -> ScratchboxMesh& {
            processing::HoleFillOptions opt;
            opt.maxHoleEdges = maxHoleEdges;
            ScratchboxMesh res = processing::HoleFiller::fillHoles(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "max_hole_edges"_a = 64)
        .def("hausdorff_distance", [](const ScratchboxMesh& self, const ScratchboxMesh& other, size_t samples) {
            return processing::HausdorffDistanceEngine::compute(self, other, samples);
        }, "other"_a, "samples"_a = 500)
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

    m_geom.def("create_cylinder", [](float radiusTop, float radiusBottom, float height, int segments, const Vec4& color, bool capped) {
        return ScratchboxMesh::createCylinder(radiusTop, radiusBottom, height, segments, color, capped);
    }, "radius_top"_a = 1.0f, "radius_bottom"_a = 1.0f, "height"_a = 2.0f, "segments"_a = 24, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f), "capped"_a = true);

    m_geom.def("create_torus", [](float mainRadius, float tubeRadius, int radialSegments, int tubularSegments, const Vec4& color) {
        return createTorus(mainRadius, tubeRadius, radialSegments, tubularSegments, color);
    }, "main_radius"_a = 1.0f, "tube_radius"_a = 0.25f, "radial_segments"_a = 24, "tubular_segments"_a = 36, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_studio_pedestal", [](float radius, float height, float bevelRadius, int segments) {
        return generateStudioPedestal(radius, height, bevelRadius, segments);
    }, "radius"_a = 4.0f, "height"_a = 0.25f, "bevel_radius"_a = 0.04f, "segments"_a = 64);

    m_geom.def("create_fluted_column", [](float radius, float height, int flutes, int segments, const Vec4& color) {
        return ScratchboxMesh::createFlutedColumn(radius, height, flutes, segments, color);
    }, "radius"_a = 0.45f, "height"_a = 7.0f, "flutes"_a = 16, "segments"_a = 48, "color"_a = Vec4(0.88f, 0.85f, 0.80f, 1.0f));

    m_geom.def("create_beveled_box", [](const Vec3& size, float bevelRadius, const Vec4& color) {
        return ScratchboxMesh::createBeveledBox(size, bevelRadius, color);
    }, "size"_a = Vec3(1.0f, 1.0f, 1.0f), "bevel_radius"_a = 0.02f, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_subdivided_box", [](const Vec3& size, int subX, int subY, int subZ, const Vec4& color) {
        return ScratchboxMesh::createSubdividedBox(size, subX, subY, subZ, color);
    }, "size"_a = Vec3(1.0f, 1.0f, 1.0f), "sub_x"_a = 4, "sub_y"_a = 4, "sub_z"_a = 4, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    m_geom.def("create_envelope", [](const Vec3& bounds, float crown, float slope, float centerDip, int gridX, int gridZ, const Vec4& color) {
        return ScratchboxMesh::createEnvelope(bounds, crown, slope, centerDip, gridX, gridZ, color);
    }, "bounds"_a = Vec3(1.0f, 0.3f, 1.5f), "crown"_a = 0.25f, "slope"_a = 0.3f, "center_dip"_a = 0.0f, "grid_x"_a = 16, "grid_z"_a = 16, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

    m_geom.def("create_arched_blister", [](const Vec3& bounds, float archRadius, float swell, int gridPhi, int gridW, float sideSign, const Vec4& color) {
        return ScratchboxMesh::createArchedBlister(bounds, archRadius, swell, gridPhi, gridW, sideSign, color);
    }, "bounds"_a = Vec3(0.35f, 0.45f, 0.9f), "arch_radius"_a = 0.40f, "swell"_a = 0.08f, "grid_phi"_a = 16, "grid_w"_a = 8, "side_sign"_a = 1.0f, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

    m_geom.def("create_lathe", [](const std::vector<Vec2>& profile, int radialSegments, float totalAngleRad, const Vec4& color, bool capEnds) {
        return shaper::Lathe3D::revolve(profile, radialSegments, totalAngleRad, color, capEnds);
    }, "profile"_a, "radial_segments"_a = 32, "total_angle_rad"_a = math::TWO_PI, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f), "cap_ends"_a = false);

    m_geom.def("create_loft", [](const std::vector<std::vector<Vec3>>& slices, bool closeEnds, const Vec4& color) {
        return shaper::Loft3D::skin(slices, closeEnds, color);
    }, "slices"_a, "close_ends"_a = true, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

    m_geom.def("create_sweep", [](const std::vector<Vec3>& curve, const std::vector<Vec2>& profile, float totalTwistRad, float startScale, float endScale, bool closeEnds, const Vec4& color) {
        return shaper::Sweep3D::sweep(curve, profile, totalTwistRad, startScale, endScale, closeEnds, color);
    }, "curve"_a, "profile"_a, "total_twist_rad"_a = 0.0f, "start_scale"_a = 1.0f, "end_scale"_a = 1.0f, "close_ends"_a = true, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

    // Named for what each actually does rather than the caller's shape: onGrid is a 2D countU x countV grid (not
    // strictly "linear"), alongCurve follows an arbitrary polyline (not strictly "circular" — closing the curve
    // on itself is what makes a circular array, the function itself doesn't require it).
    m_geom.def("replicate_on_grid", [](const ScratchboxMesh& seed, int countU, int countV, float pitchU, float pitchV, float rowOffsetU, bool alternateRows, float mergeDistance, const Vec3& origin, const Vec3& axisU, const Vec3& axisV) {
        return shaper::Replicator3D::onGrid(seed, countU, countV, pitchU, pitchV, rowOffsetU, alternateRows, mergeDistance, origin, axisU, axisV);
    }, "seed"_a, "count_u"_a, "count_v"_a, "pitch_u"_a, "pitch_v"_a, "row_offset_u"_a = 0.0f, "alternate_rows"_a = false, "merge_distance"_a = 0.0f,
       "origin"_a = Vec3(0, 0, 0), "axis_u"_a = Vec3(1, 0, 0), "axis_v"_a = Vec3(0, 0, 1));

    m_geom.def("replicate_along_curve", [](const ScratchboxMesh& seed, const std::vector<Vec3>& curve, float pitch, float mergeDistance, bool fitToLength) {
        return shaper::Replicator3D::alongCurve(seed, curve, pitch, mergeDistance, fitToLength);
    }, "seed"_a, "curve"_a, "pitch"_a, "merge_distance"_a = 0.0f, "fit_to_length"_a = true,
       "Repeat seed at a continuous pitch along curve (close the curve on itself for a circular array)");

    m_geom.def("extrude_polygon", [](const std::vector<Vec2>& footprint, float baseY, float height, const Vec4& color) {
        return footprints::extrudePolygon(footprint, baseY, height, color);
    }, "footprint"_a, "base_y"_a = 0.0f, "height"_a = 1.0f, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f),
       "Extrude a 2D XZ polygon along +Y into a closed, capped solid (walls + top + bottom)");

    m_geom.def("merge_meshes", [](const std::vector<ScratchboxMesh>& meshes) {
        ScratchboxMesh out("merged_mesh");
        for (const auto& mesh : meshes) out.append(mesh);
        out.recomputeBounds();
        return out;
    }, "meshes"_a, "Merge a list of meshes into one (vertices and triangles concatenated)");

    // BSP mesh CSG (scratchbox_mesh_edit.hpp), the same booleanPolygons the mesh_edit tool and scripts/run_mesh_edit_pipeline.cpp
    // already drive on an existing glb: here on two meshes directly, so an arch, a vault or a staircase composes from the
    // universal operators (extrude/lathe/sweep a solid, then subtract/union/intersect it) instead of needing its own named
    // primitive. eps and the T-junction weld after the boolean follow the same derivation as that pipeline: eps from the
    // larger operand's own diagonal, not a fixed constant, since a boolean on a tiny or a huge pair of solids needs a
    // different tolerance.
    m_geom.def("boolean_mesh", [](const ScratchboxMesh& a, const ScratchboxMesh& b, const std::string& op) {
        mesh_edit::BooleanOp bop;
        if (op == "union") bop = mesh_edit::BooleanOp::Union;
        else if (op == "subtract") bop = mesh_edit::BooleanOp::Subtract;
        else if (op == "intersect") bop = mesh_edit::BooleanOp::Intersect;
        else throw std::invalid_argument("boolean_mesh op must be \"union\", \"subtract\" or \"intersect\"");
        std::vector<mesh_edit::CsgPolygon> pa = mesh_edit::meshToPolygons(a), pb = mesh_edit::meshToPolygons(b);
        const mesh_edit::DBox ba = mesh_edit::boxOf(pa), bb = mesh_edit::boxOf(pb);
        const double extent = std::max((ba.hi - ba.lo).length(), (bb.hi - bb.lo).length());
        const double eps = std::max(1e-9, 1e-7 * std::max(extent, 1e-3));
        std::vector<mesh_edit::CsgPolygon> result = mesh_edit::booleanPolygons(std::move(pa), std::move(pb), bop, eps);
        mesh_edit::closeTJunctions(result, eps * 10);
        ScratchboxMesh out = mesh_edit::polygonsToMesh(result, "boolean_mesh");
        out.material = a.material;
        out.recomputeBounds();
        return out;
    }, "a"_a, "b"_a, "op"_a, "Boolean a and b by BSP mesh CSG: op is \"union\", \"subtract\" or \"intersect\"");

    // ========================================================================
    // 3. ARCHITECTURE SUBMODULE (Building Tools / OSM)
    // ========================================================================
    auto m_arch = m.def_submodule("architecture", "Procedural architecture grammar and roofs");

    nb::enum_<RoofType>(m_arch, "RoofType")
        .value("FlatParapet", RoofType::FlatParapet)
        .value("Gable", RoofType::Gable)
        .value("Hip", RoofType::Hip)
        .value("Mansard", RoofType::Mansard)
        .value("Dome", RoofType::Dome)
        .value("BarrelVault", RoofType::BarrelVault);

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
        .def_rw("vault_profile_exponent", &BuildingConfig::vaultProfileExponent)
        .def_rw("roof_pitch_degrees", &BuildingConfig::roofPitchDegrees)
        .def_rw("roof_height", &BuildingConfig::roofHeight)
        .def_rw("roof_overhang", &BuildingConfig::roofOverhang)
        .def_rw("parapet_height", &BuildingConfig::parapetHeight)
        .def_rw("curvature", &BuildingConfig::curvature)
        .def_rw("superellipse_exponent", &BuildingConfig::superellipseExponent)
        .def_rw("twist_degrees", &BuildingConfig::twistDegrees)
        .def_rw("taper", &BuildingConfig::taper)
        .def_rw("bulge", &BuildingConfig::bulge)
        .def_rw("bay_count", &BuildingConfig::bayCount)
        .def_rw("bake_curvature_ao", &BuildingConfig::bakeCurvatureAO);

    m_arch.def("generate_building", [](const BuildingConfig& config, const std::string& name) {
        return ProceduralBuildingGenerator::generateBuilding(config, name);
    }, "config"_a, "name"_a = "ProceduralBuilding");

    m_arch.def("generate_curved_building", [](const BuildingConfig& config, const std::string& name) {
        return ProceduralBuildingGenerator::generateCurvedBuilding(config, name);
    }, "config"_a, "name"_a = "CurvedBuilding");

    m_arch.attr("RomanOrder") = m.attr("RomanOrder");

    m_arch.def("generate_peripteral_temple", [](
        const std::string& archetype,
        core::RomanOrder order,
        float footprint_length,
        float footprint_width,
        int column_count_x,
        int column_count_y,
        float column_height,
        float plinth_height,
        uint32_t seed
    ) {
        core::TempleOptions opts;
        opts.archetype = archetype;
        opts.order = order;
        opts.footprintLength = footprint_length;
        opts.footprintWidth = footprint_width;
        opts.columnCountX = column_count_x;
        opts.columnCountY = column_count_y;
        opts.columnHeight = column_height;
        opts.plinthHeight = plinth_height;
        opts.seed = seed;
        return core::buildClassicalTemple(opts);
    }, "archetype"_a = "roman_peripteral",
       "order"_a = core::RomanOrder::Corinthian,
       "footprint_length"_a = 42.0f,
       "footprint_width"_a = 24.0f,
       "column_count_x"_a = 8,
       "column_count_y"_a = 14,
       "column_height"_a = 7.5f,
       "plinth_height"_a = 1.4f,
       "seed"_a = 1337,
       "Construct an authentic Vitruvian classical temple with peripteral colonnade and gable roof");

    // ========================================================================
    // 4. NATURE & BOTANICAL SUBMODULE (Mtree & IvyGen)
    // ========================================================================
    auto m_nat = m.def_submodule("nature", "Ivy growth (trees: the vegetation submodule, SB-Veggie)");

    // Trees are not grown here: every tree in a scene is an SB-Veggie tree (the vegetation submodule below,
    // scratchbox_sb_veggie_grove.hpp). The bare space-colonisation and L-system generators of scratchbox_nature.hpp
    // are engine internals, not reachable from scripts.

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

    nb::class_<ContactAuditViolation>(m_comp, "ContactAuditViolation")
        .def_ro("subject", &ContactAuditViolation::subject)
        .def_ro("target", &ContactAuditViolation::target)
        .def_ro("type", &ContactAuditViolation::type)
        .def_ro("metric_distance", &ContactAuditViolation::metricDistance)
        .def_ro("resolution_delta", &ContactAuditViolation::resolutionDelta);

    nb::class_<SpatialConstraintSolver>(m_comp, "SpatialConstraintSolver")
        .def(nb::init<>())
        .def("register_mesh", &SpatialConstraintSolver::registerMesh, "name"_a, "mesh"_a)
        .def("add_constraint", [](SpatialConstraintSolver& self, const std::string& subject, const std::string& predicate, const std::string& target, const std::string& face, float clearance, const Vec3& offset) {
            self.addConstraint(subject, predicate, target, face, clearance, offset);
        }, "subject"_a, "predicate"_a, "target"_a, "face"_a = "top", "clearance"_a = 0.0f, "offset"_a = Vec3(0, 0, 0))
        .def("solve", &SpatialConstraintSolver::solve, "collision_passes"_a = 8, "min_margin"_a = 0.01f)
        .def("relax_collisions", &SpatialConstraintSolver::relaxCollisions, "iterations"_a = 8, "min_margin"_a = 0.01f)
        .def("audit_contacts", &SpatialConstraintSolver::auditContacts, "max_allowed_gap"_a = 0.05f)
        .def("ground_on_terrain", &SpatialConstraintSolver::groundOnTerrainMesh, "name"_a, "terrain"_a, "clearance"_a = 0.0f,
             "Raycast-ground a registered mesh onto a terrain mesh (Moller-Trumbore vertical rays from footprint)")
        .def("align_to_terrain_normal", &SpatialConstraintSolver::alignToTerrainNormal, "name"_a, "terrain"_a, "max_tilt_deg"_a = 45.0f,
             "Rotate a registered mesh so its +Y axis aligns with the terrain surface normal at its footprint");

    // High-level scene-graph resolver: register meshes, apply relations, ground on terrain, relax collisions
    m_comp.def("resolve_constraints", [](std::unordered_map<std::string, ScratchboxMesh*>& meshes,
                                         const std::vector<std::unordered_map<std::string, std::string>>& relations,
                                         ScratchboxMesh* terrain,
                                         int collisionPasses) {
        SpatialConstraintSolver solver;
        for (auto& kv : meshes) {
            solver.registerMesh(kv.first, kv.second);
        }
        for (const auto& rel : relations) {
            const std::string subject = rel.count("subject") ? rel.at("subject") : "";
            const std::string predicate = rel.count("predicate") ? rel.at("predicate") : "supported_by";
            const std::string target = rel.count("target") ? rel.at("target") : "";
            const std::string face = rel.count("face") ? rel.at("face") : "top";
            float clearance = 0.0f;
            if (rel.count("clearance")) {
                try { clearance = std::stof(rel.at("clearance")); } catch (...) { clearance = 0.0f; }
            }
            if (!subject.empty() && !target.empty()) {
                solver.addConstraint(subject, predicate, target, face, clearance);
            }
        }
        // Ground any mesh whose relation targets the terrain sentinel
        if (terrain) {
            for (const auto& rel : relations) {
                const std::string target = rel.count("target") ? rel.at("target") : "";
                if (target == "terrain" || target == "__terrain__") {
                    const std::string subject = rel.count("subject") ? rel.at("subject") : "";
                    if (!subject.empty()) {
                        solver.groundOnTerrainMesh(subject, *terrain, 0.0f);
                    }
                }
            }
        }
        solver.solve(collisionPasses, 0.01f);
        return solver.auditContacts(0.05f);
    }, "meshes"_a, "relations"_a, "terrain"_a = nullptr, "collision_passes"_a = 8,
       "Resolve a relational scene graph: register named meshes, apply spatial relations, ground on terrain, relax collisions, return contact violations");

    // ========================================================================
    // 6. SHAPER SUBMODULE (DEFORMERS & SCULPTING)
    // ========================================================================
    auto m_shaper = m.def_submodule("shaper", "Non-linear geometric mesh deformers and procedural shaping");

    nb::class_<shaper::Lattice3D>(m_shaper, "Lattice3D")
        .def(nb::init<>())
        .def(nb::init<int, int, int, const AABB&>(), "dim_x"_a, "dim_y"_a, "dim_z"_a, "bounds"_a)
        .def_rw("dim_x", &shaper::Lattice3D::dimX)
        .def_rw("dim_y", &shaper::Lattice3D::dimY)
        .def_rw("dim_z", &shaper::Lattice3D::dimZ)
        .def_rw("rest_bounds", &shaper::Lattice3D::restBounds)
        .def("get_control_point", &shaper::Lattice3D::getControlPoint, "i"_a, "j"_a, "k"_a)
        .def("set_control_point", &shaper::Lattice3D::setControlPoint, "i"_a, "j"_a, "k"_a, "pos"_a)
        .def("offset_control_point", &shaper::Lattice3D::offsetControlPoint, "i"_a, "j"_a, "k"_a, "delta"_a)
        .def("deform", [](const shaper::Lattice3D& self, ScratchboxMesh& mesh) -> ScratchboxMesh& {
            self.deform(mesh);
            return mesh;
        }, "mesh"_a, "Deforms mesh vertices using trivariate Bernstein tensor product evaluation");

    m_shaper.def("taper", [](ScratchboxMesh& mesh, int axisIdx, float factor) -> ScratchboxMesh& {
        shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::taper(mesh, axis, factor);
        return mesh;
    }, "mesh"_a, "axis"_a = 1, "factor"_a = 0.5f);

    m_shaper.def("twist", [](ScratchboxMesh& mesh, int axisIdx, float angleDeg) -> ScratchboxMesh& {
        shaper::Axis axis = axisIdx == 0 ? shaper::Axis::X : (axisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::twist(mesh, axis, angleDeg);
        return mesh;
    }, "mesh"_a, "axis"_a = 1, "angle_deg"_a = 45.0f);

    m_shaper.def("bend", [](ScratchboxMesh& mesh, int mainAxisIdx, int bendAxisIdx, float angleDeg, float radius) -> ScratchboxMesh& {
        shaper::Axis mainAxis = mainAxisIdx == 0 ? shaper::Axis::X : (mainAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Axis bendAxis = bendAxisIdx == 0 ? shaper::Axis::X : (bendAxisIdx == 1 ? shaper::Axis::Y : shaper::Axis::Z);
        shaper::Deformer::bend(mesh, mainAxis, bendAxis, angleDeg * (math::PI / 180.0f), radius);
        return mesh;
    }, "mesh"_a, "main_axis"_a = 1, "bend_axis"_a = 0, "angle_deg"_a = 30.0f, "radius"_a = 2.0f);

    m_shaper.def("bulge", [](ScratchboxMesh& mesh, const Vec3& center, float radius, float strength, float power) -> ScratchboxMesh& {
        shaper::Deformer::bulge(mesh, center, radius, strength, power);
        return mesh;
    }, "mesh"_a, "center"_a = Vec3(0, 0, 0), "radius"_a = 1.0f, "strength"_a = 0.3f, "power"_a = 2.0f);

    m_shaper.def("subdivide", [](const ScratchboxMesh& mesh, int iterations) {
        return shaper::LoopSubdivision::subdivide(mesh, iterations);
    }, "mesh"_a, "iterations"_a = 1, "Refine mesh using Loop Subdivision");

    m_shaper.def("loft", [](const std::vector<std::vector<Vec3>>& slices, bool closeEnds, const Vec4& color) {
        return shaper::Loft3D::skin(slices, closeEnds, color);
    }, "slices"_a, "close_ends"_a = true, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f), "Loft skin between 3D station slices");

    m_shaper.def("lathe", [](const std::vector<Vec2>& profile, int radialSegments, float totalAngleRad, const Vec4& color, bool capEnds) {
        return shaper::Lathe3D::revolve(profile, radialSegments, totalAngleRad, color, capEnds);
    }, "profile"_a, "radial_segments"_a = 32, "total_angle_rad"_a = math::TWO_PI, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f), "cap_ends"_a = false, "Revolve 2D profile into rotational solid; cap_ends closes an open axial hole on a full sweep");

    m_shaper.def("sweep", [](const std::vector<Vec3>& curve, const std::vector<Vec2>& profile, float totalTwistRad, float startScale, float endScale, bool closeEnds, const Vec4& color) {
        return shaper::Sweep3D::sweep(curve, profile, totalTwistRad, startScale, endScale, closeEnds, color);
    }, "curve"_a, "profile"_a, "total_twist_rad"_a = 0.0f, "start_scale"_a = 1.0f, "end_scale"_a = 1.0f, "close_ends"_a = true, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f),
       "Sweep 2D profile along a 3D carrier curve with rotation-minimizing frames (limbs, hoses, struts, coils)");

    m_shaper.def("replicate_on_grid", [](const ScratchboxMesh& seed, int countU, int countV, float pitchU, float pitchV, float rowOffsetU, bool alternateRows, float mergeDistance, const Vec3& origin, const Vec3& axisU, const Vec3& axisV) {
        return shaper::Replicator3D::onGrid(seed, countU, countV, pitchU, pitchV, rowOffsetU, alternateRows, mergeDistance, origin, axisU, axisV);
    }, "seed"_a, "count_u"_a, "count_v"_a, "pitch_u"_a, "pitch_v"_a, "row_offset_u"_a = 0.0f, "alternate_rows"_a = false, "merge_distance"_a = 0.0f,
       "origin"_a = Vec3(0, 0, 0), "axis_u"_a = Vec3(1, 0, 0), "axis_v"_a = Vec3(0, 0, 1),
       "Repeat seed over a flat U x V lattice (bolt patterns, tile fields, brick-bonded rows)");

    m_shaper.def("replicate_along_curve", [](const ScratchboxMesh& seed, const std::vector<Vec3>& curve, float pitch, float mergeDistance, bool fitToLength) {
        return shaper::Replicator3D::alongCurve(seed, curve, pitch, mergeDistance, fitToLength);
    }, "seed"_a, "curve"_a, "pitch"_a, "merge_distance"_a = 0.0f, "fit_to_length"_a = true,
       "Repeat seed at a continuous pitch along curve, oriented by rotation-minimizing frames (bolt circles, louvres, teeth, treads)");

    m_shaper.def("extrude_polygon", [](const std::vector<Vec2>& footprint, float baseY, float height, const Vec4& color) {
        return footprints::extrudePolygon(footprint, baseY, height, color);
    }, "footprint"_a, "base_y"_a = 0.0f, "height"_a = 1.0f, "color"_a = Vec4(0.8f, 0.8f, 0.8f, 1.0f),
       "Extrude a 2D XZ polygon along +Y into a closed, capped solid (walls + top + bottom)");

    m_shaper.def("boolean_mesh", [](const ScratchboxMesh& a, const ScratchboxMesh& b, const std::string& op) {
        mesh_edit::BooleanOp bop;
        if (op == "union") bop = mesh_edit::BooleanOp::Union;
        else if (op == "subtract") bop = mesh_edit::BooleanOp::Subtract;
        else if (op == "intersect") bop = mesh_edit::BooleanOp::Intersect;
        else throw std::invalid_argument("boolean_mesh op must be \"union\", \"subtract\" or \"intersect\"");
        std::vector<mesh_edit::CsgPolygon> pa = mesh_edit::meshToPolygons(a), pb = mesh_edit::meshToPolygons(b);
        const mesh_edit::DBox ba = mesh_edit::boxOf(pa), bb = mesh_edit::boxOf(pb);
        const double extent = std::max((ba.hi - ba.lo).length(), (bb.hi - bb.lo).length());
        const double eps = std::max(1e-9, 1e-7 * std::max(extent, 1e-3));
        std::vector<mesh_edit::CsgPolygon> result = mesh_edit::booleanPolygons(std::move(pa), std::move(pb), bop, eps);
        mesh_edit::closeTJunctions(result, eps * 10);
        ScratchboxMesh out = mesh_edit::polygonsToMesh(result, "boolean_mesh");
        out.material = a.material;
        out.recomputeBounds();
        return out;
    }, "a"_a, "b"_a, "op"_a, "Boolean a and b by BSP mesh CSG: op is \"union\", \"subtract\" or \"intersect\" "
       "(an arch, a vault or a staircase composes from this plus extrude/lathe/sweep, instead of its own named primitive)");

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


    // ========================================================================
    // 8. VEGETATION SUBMODULE (SB-Veggie: scratchbox_sb_veggie_grove.hpp)
    // ========================================================================
    auto m_veg = m.def_submodule("vegetation", "SB-Veggie trees (the one vegetation generator): space colonisation inside described crowns, SB-Veggie leaf clusters, species and texture libraries, viewport levels of detail");

    m_veg.def("grow_described_trees", [](const std::string& treesJson, const std::string& optionsJson) {
        using namespace scratchbox::tile_vegetation;
        try {
            const io::GlbJsonValue doc = json::parse(treesJson);
            const auto trees = parseDescribedTrees(doc);
            const io::GlbJsonValue opt = json::parse(optionsJson.empty() ? std::string("{}") : optionsJson);
            GroveOptions o;
            auto num = [&](const char* k, double def) { return opt[k].type == io::GlbJsonValue::Number ? opt[k].num : def; };
            auto str = [&](const char* k) { return opt[k].type == io::GlbJsonValue::String ? opt[k].str : std::string(); };
            auto flag = [&](const char* k, bool def) { return opt[k].type == io::GlbJsonValue::Bool ? opt[k].b : def; };
            o.triangleBudget = num("triangleBudget", 0);
            o.sceneTriangleCap = num("sceneTriangleCap", o.sceneTriangleCap);
            const std::string seed = str("seed");
            if (!seed.empty()) {
                if (seed.size() > 16 || seed.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) throw VegetationError("bad_request", "seed must be 1-16 hex digits");
                o.seed = std::stoull(seed, nullptr, 16);
            }
            o.speciesIndexPath = str("speciesIndexPath");
            o.speciesIndexLabel = str("speciesIndexLabel");
            o.textureIndexPath = str("textureIndexPath");
            o.textureIndexLabel = str("textureIndexLabel");
            o.lod = flag("lod", o.lod);
            o.quantize = flag("quantize", o.quantize);
            o.reveal = flag("reveal", o.reveal);
            o.psiSeason = num("psiSeason", o.psiSeason);
            o.latAbsDeg = num("latAbsDeg", o.latAbsDeg);
            o.minSurfaceReached = num("minSurfaceReached", o.minSurfaceReached);
            o.stageKey = str("stageKey");
            if (doc["label"].type == io::GlbJsonValue::String) o.label = doc["label"].str.substr(0, 200);
            const GroveResult r = growDescribedTrees(trees, o);
            return nb::make_tuple(nb::bytes(reinterpret_cast<const char*>(r.glb.data()), r.glb.size()), r.statsJson, r.crownsJson);
        } catch (const VegetationError& e) {
            throw std::runtime_error("SB-Veggie " + e.code() + ": " + e.what());
        }
    }, "trees_json"_a, "options_json"_a = "{}",
       "Grow described trees (scratchbox.sb-veggie-trees/1 JSON) as SB-Veggie trees; returns (trees GLB bytes, stats JSON, crowns JSON)");

    // ========================================================================
    // 9. CORE INVARIANT KERNEL (GeoMorph, ArchiMorph, Sensor Passes)
    // ========================================================================
    // ========================================================================
    // SCAN MASSING: massing read from a scan, and the choice between candidates by measured fit
    // ========================================================================
    {
        namespace sm = scratchbox::scan_massing;
        auto m_sm = m.def_submodule("scan_massing", "Massing read from a scan (sections, lofts, an extruded block) and the choice between candidates by how well each explains the scan, height by height");
        auto ringOf = [](const std::vector<std::pair<double, double>>& xz) { std::vector<sm::P2> r; for (const auto& [x, z] : xz) r.push_back({x, z}); return r; };
        auto inRings = [](const std::vector<std::vector<sm::P2>>& rings, double x, double z) {
            for (const auto& ring : rings) {
                bool c = false;
                for (size_t i = 0, j = ring.size() - 1; i < ring.size(); j = i++)
                    if ((ring[i].z > z) != (ring[j].z > z) && x < (ring[j].x - ring[i].x) * (z - ring[i].z) / (ring[j].z - ring[i].z) + ring[i].x) c = !c;
                if (c) return true;
            }
            return false;
        };
        nb::class_<sm::Agreement>(m_sm, "Agreement")
            .def_ro("coverage", &sm::Agreement::coverage).def_ro("precision", &sm::Agreement::precision).def_ro("f", &sm::Agreement::f)
            .def_ro("banded_coverage", &sm::Agreement::bandedCoverage).def_ro("banded_precision", &sm::Agreement::bandedPrecision)
            .def_ro("banded_f", &sm::Agreement::bandedF).def_ro("worst_band_coverage", &sm::Agreement::worstBandCoverage)
            .def_ro("bands", &sm::Agreement::bands).def_ro("scan_samples", &sm::Agreement::scanSamples)
            .def_ro("candidate_samples", &sm::Agreement::candidateSamples).def_ro("unseen_samples", &sm::Agreement::unseenSamples)
            .def("__repr__", [](const sm::Agreement& a) { return "Agreement(coverage=" + sm::fmt3(a.bandedCoverage) + ", precision=" + sm::fmt3(a.bandedPrecision) + ", f=" + sm::fmt3(a.bandedF) + ")"; });
        nb::class_<sm::Slice>(m_sm, "Slice")
            .def_ro("y0", &sm::Slice::y0).def_ro("y1", &sm::Slice::y1)
            .def_prop_ro("cell_count", [](const sm::Slice& s) { return s.cells.size(); });
        nb::class_<sm::LoftRun>(m_sm, "LoftRun")
            .def_ro("y0", &sm::LoftRun::y0).def_ro("y1", &sm::LoftRun::y1)
            .def_prop_ro("ring_count", [](const sm::LoftRun& r) { return r.rings.size(); })
            .def_prop_ro("rings", [](const sm::LoftRun& r) {
                std::vector<std::pair<double, std::vector<std::pair<double, double>>>> out;
                for (const auto& ring : r.rings) { std::vector<std::pair<double, double>> pts; for (const auto& p : ring.pts) pts.push_back({p.x, p.z}); out.push_back({ring.y, pts}); }
                return out;
            });
        nb::class_<sm::TopGrid>(m_sm, "TopGrid", "The scan's highest point per plan cell (for the hidden-wall test)")
            .def(nb::init<>())
            .def("add_mesh", [](sm::TopGrid& g, const ScratchboxMesh& mesh) { for (const auto& v : mesh.vertices) g.add(v.position); }, "mesh"_a)
            .def("at", &sm::TopGrid::at, "x"_a, "z"_a);
        m_sm.def("crop_to_plan", [ringOf](const ScratchboxMesh& mesh, const std::vector<std::vector<std::pair<double, double>>>& plan, double margin, double minY) {
            std::vector<std::vector<sm::P2>> rings;
            for (const auto& r : plan) rings.push_back(ringOf(r));
            return sm::cropToPlan(mesh, rings, margin, minY);
        }, "mesh"_a, "plan"_a, "margin"_a = 3.0, "min_y"_a = -1e9, "The triangles of a scan above min_y and within margin of the plan rings (x, z)");
        m_sm.def("plan_outline", [](const std::vector<sm::Slice>& sl, double cellM) {
            std::vector<std::pair<double, double>> out;
            for (const auto& p : sm::planOutline(sl, cellM)) out.push_back({p.x, p.z});
            return out;
        }, "slices"_a, "cell"_a = 0.5, "The outline (x, z) of the largest piece of all slices together: the scan's plan");
        m_sm.def("snap_plan_to_scan", [ringOf](const std::vector<std::pair<double, double>>& ring, const std::vector<Vec3>& samples, double groundY, double topY, double search) {
            std::vector<sm::SnapEdge> rep;
            const auto r = sm::snapPlanToScan(ringOf(ring), samples, groundY, topY, search, 0.25, 0.15, 0.5, &rep);
            std::vector<std::pair<double, double>> out;
            for (const auto& p : r) out.push_back({p.x, p.z});
            std::vector<std::tuple<double, size_t, bool>> edges;
            for (const auto& e : rep) edges.push_back({e.shiftM, e.support, e.moved});
            return std::make_pair(out, edges);
        }, "ring"_a, "samples"_a, "ground_y"_a, "top_y"_a, "search"_a = 3.0,
           "The footprint ring (x, z) with each edge moved along its normal onto the scan's wall; returns (ring, [(shift m, support, moved)] per edge)");
        m_sm.def("sample_surface", [](const ScratchboxMesh& mesh, double spacing) { return sm::sampleMesh(mesh, spacing); }, "mesh"_a, "spacing"_a = 0.5,
                 "Evenly spaced points on a mesh's surface (about one per spacing^2)");
        m_sm.def("agreement", [ringOf, inRings](const std::vector<Vec3>& scan, const std::vector<Vec3>& candidate, double tau, double bandM, std::optional<double> groundY,
                                                 const sm::TopGrid* neighbours, const std::vector<std::vector<std::pair<double, double>>>& ownPlan, std::optional<double> coverageTau) {
            sm::AgreementOptions o;
            o.tauM = tau; o.bandM = bandM;
            if (coverageTau) o.coverageTauM = *coverageTau;
            if (groundY) o.groundY = *groundY;
            std::vector<std::vector<sm::P2>> rings;
            for (const auto& r : ownPlan) rings.push_back(ringOf(r));
            if (neighbours && !rings.empty()) { o.neighbours = neighbours; o.ownPlan = [rings, inRings](double x, double z) { return inRings(rings, x, z); }; }
            return sm::agreement(scan, candidate, o);
        }, "scan"_a, "candidate"_a, "tau"_a = 1.0, "band"_a = 2.0, "ground_y"_a = nb::none(), "neighbours"_a = nb::none(), "own_plan"_a = std::vector<std::vector<std::pair<double, double>>>{}, "coverage_tau"_a = nb::none(),
           "How well candidate samples explain scan samples: coverage, precision and F, overall and height-balanced; surface at street level (ground_y) or beside a taller neighbour (neighbours, off own_plan) is left out of precision");
        m_sm.def("slices", [](const std::vector<Vec3>& samples, double baseY, double sliceM, double cellM, double closeM) {
            return sm::slices(samples, baseY, sm::SliceParams{sliceM, cellM, closeM});
        }, "samples"_a, "base_y"_a, "slice"_a = 1.0, "cell"_a = 0.5, "close"_a = 1.0, "The scan cut into horizontal slices, each slice's plan filled");
        m_sm.def("loft_runs", [](const std::vector<sm::Slice>& sl, double cellM, double linkIoU, int ringPoints, double keepTol, double minPiece) {
            sm::LoftParams p; p.linkIoU = linkIoU; p.ringPoints = ringPoints; p.keepTolM = keepTol; p.minPieceM2 = minPiece;
            return sm::loftRuns(sl, cellM, p);
        }, "slices"_a, "cell"_a = 0.5, "link_iou"_a = 0.35, "ring_points"_a = 48, "keep_tol"_a = 0.4, "min_piece"_a = 0.5,
           "Each slice's pieces followed upward (overlap or nearness, mutual best), their outlines resampled and thinned");
        m_sm.def("loft_solids", &sm::loftSolids, "runs"_a, "The runs skinned into closed solids (Loft3D), one mesh");
        m_sm.def("extrude_block", [ringOf](const std::vector<std::pair<double, double>>& ring, double y0, double y1) { return sm::extrudeBlock(ringOf(ring), y0, y1); },
                 "ring"_a, "y0"_a, "y1"_a, "A footprint ring (x, z) extruded from y0 to y1");
        m_sm.def("roof_objects", [ringOf](const std::vector<Vec3>& samples, const std::vector<std::pair<double, double>>& plan, double roofY,
                                          std::optional<nb::bytes> photoRgba, int photoWidth, int photoHeight, double photoX0, double photoZ0, double photoTexel, double minRise, double spotLighter) {
            namespace ro = scratchbox::roof_objects;
            ro::TopPhoto photo;
            std::string buf;
            if (photoRgba) {
                buf.assign(photoRgba->c_str(), photoRgba->size());
                if (buf.size() != static_cast<size_t>(photoWidth) * photoHeight * 4) throw std::invalid_argument("photo_rgba must hold photo_width x photo_height RGBA pixels");
                photo = {reinterpret_cast<const uint8_t*>(buf.data()), photoWidth, photoHeight, photoX0, photoZ0, photoTexel};
            }
            ro::RoofParams P; P.minRiseM = minRise; P.spotLighterL = spotLighter;
            const ro::RoofReport rep = photoRgba ? ro::roofObjectsFromPhoto(samples, ringOf(plan), roofY, photo, P) : ro::roofObjects(samples, ringOf(plan), roofY, nullptr, P);
            nb::dict d;
            d["roof_y"] = rep.roofY; d["photo"] = rep.photo; d["photo_only_areas"] = rep.photoOnlyAreas;
            d["roof_delta_e_median"] = rep.roofDeltaEMedian; d["roof_delta_e_mad"] = rep.roofDeltaEMad;
            nb::list objs;
            for (const auto& o : rep.objects) {
                nb::dict od;
                std::vector<std::pair<double, double>> outline;
                for (const auto& p : o.outline) outline.push_back({p.x, p.z});
                od["outline"] = outline; od["centre"] = std::make_pair(o.centre.x, o.centre.z);
                od["base_y"] = o.baseY; od["top_y"] = o.topY; od["area"] = o.areaM2;
                od["photo_cells"] = o.photoCells; od["scan_cells"] = o.scanCells;
                od["chosen"] = o.chosen; od["why"] = o.why; od["outline_source"] = o.outlineSource; od["height_source"] = o.heightSource; od["roundness"] = o.roundness; od["agreement"] = o.agreement; od["mesh"] = o.mesh;
                nb::list rows;
                for (const auto& r : o.candidates) { nb::dict row; row["label"] = r.label; row["triangles"] = r.triangles; row["coverage"] = r.agreement.bandedCoverage; row["precision"] = r.agreement.bandedPrecision; row["accepted"] = r.accepted; row["reason"] = r.reason; rows.append(row); }
                od["candidates"] = rows;
                objs.append(od);
            }
            d["objects"] = objs;
            return d;
        }, "samples"_a, "plan"_a, "roof_y"_a, "photo_rgba"_a = nb::none(), "photo_width"_a = 0, "photo_height"_a = 0, "photo_x0"_a = 0.0, "photo_z0"_a = 0.0, "photo_texel"_a = 0.05, "min_rise"_a = 0.6, "spot_lighter"_a = 30.0,
           "The objects standing on a roof: found where the scan stands above roof_y (edges sharpened by the photo straight down, when given) and each fitted by the simplest of its outline raised, a solid of revolution and its own lofted sections");
        m_sm.def("choose", [](const std::vector<std::tuple<std::string, size_t, sm::Agreement>>& ordered, double minCoverage, double minPrecision) {
            std::vector<std::pair<std::string, std::pair<size_t, sm::Agreement>>> in;
            for (const auto& [l, t, a] : ordered) in.push_back({l, {t, a}});
            const sm::Choice c = sm::choose(in, sm::ChoiceParams{minCoverage, minPrecision});
            nb::dict d;
            d["chosen"] = c.chosen >= 0 ? nb::cast(c.rows[c.chosen].label) : nb::none();
            d["index"] = c.chosen; d["explains"] = c.explains; d["why"] = c.why;
            nb::list rows;
            for (const auto& r : c.rows) { nb::dict row; row["label"] = r.label; row["triangles"] = r.triangles; row["coverage"] = r.agreement.bandedCoverage; row["precision"] = r.agreement.bandedPrecision; row["f"] = r.agreement.bandedF; row["accepted"] = r.accepted; row["reason"] = r.reason; rows.append(row); }
            d["candidates"] = rows;
            return d;
        }, "ordered"_a, "min_coverage"_a = 0.9, "min_precision"_a = 0.85,
           "Candidates (label, triangles, Agreement) simplest first: the first explaining the scan wins, else the best height-balanced F");
    }

    auto m_core = m.def_submodule("core", "Pre-compiled C++20 invariant kernel (GeoMorph, ArchiMorph, Sensors)");

    nb::class_<core::TerrainOptions>(m_core, "TerrainOptions")
        .def(nb::init<>())
        .def_rw("extent_x", &core::TerrainOptions::extentX)
        .def_rw("extent_z", &core::TerrainOptions::extentZ)
        .def_rw("resolution", &core::TerrainOptions::resolution)
        .def_rw("archetype", &core::TerrainOptions::archetype)
        .def_rw("domain_warp_scale", &core::TerrainOptions::domainWarpScale)
        .def_rw("hydraulic_erosion_steps", &core::TerrainOptions::hydraulicErosionSteps)
        .def_rw("seed", &core::TerrainOptions::seed)
        .def_rw("macro_slope_x", &core::TerrainOptions::macroSlopeX)
        .def_rw("macro_slope_z", &core::TerrainOptions::macroSlopeZ)
        .def_rw("warp_freq", &core::TerrainOptions::warpFreq)
        .def_rw("warp_octaves", &core::TerrainOptions::warpOctaves)
        .def_rw("content_scale", &core::TerrainOptions::contentScale)
        .def_rw("content_freq", &core::TerrainOptions::contentFreq)
        .def_rw("strata_dune_scale", &core::TerrainOptions::strataDuneScale)
        .def_rw("strata_dune_freq", &core::TerrainOptions::strataDuneFreq)
        .def_rw("slope_scale", &core::TerrainOptions::slopeScale)
        .def_rw("suppressing_param", &core::TerrainOptions::suppressingParam);

    nb::class_<core::TerrainSurface>(m_core, "TerrainSurface")
        .def_rw("mesh", &core::TerrainSurface::mesh)
        .def("sample_height", &core::TerrainSurface::sampleHeight, "x"_a, "z"_a)
        .def("sample_normal", &core::TerrainSurface::sampleNormal, "x"_a, "z"_a)
        .def("sample_slope_degrees", &core::TerrainSurface::sampleSlopeDegrees, "x"_a, "z"_a);

    m_core.def("generate_geological_terrain", [](
        float extent_x, float extent_z, int resolution,
        const std::string& archetype, float domain_warp_scale,
        int hydraulic_erosion_steps, uint32_t seed,
        float macro_slope_x, float macro_slope_z,
        float warp_freq, int warp_octaves,
        float content_scale, float content_freq,
        float strata_dune_scale, float strata_dune_freq,
        float slope_scale, float suppressing_param
    ) {
        core::TerrainOptions opts;
        opts.extentX = extent_x;
        opts.extentZ = extent_z;
        opts.resolution = resolution;
        opts.archetype = archetype;
        opts.domainWarpScale = domain_warp_scale;
        opts.hydraulicErosionSteps = hydraulic_erosion_steps;
        opts.seed = seed;
        opts.macroSlopeX = macro_slope_x;
        opts.macroSlopeZ = macro_slope_z;
        opts.warpFreq = warp_freq;
        opts.warpOctaves = warp_octaves;
        opts.contentScale = content_scale;
        opts.contentFreq = content_freq;
        opts.strataDuneScale = strata_dune_scale;
        opts.strataDuneFreq = strata_dune_freq;
        opts.slopeScale = slope_scale;
        opts.suppressingParam = suppressing_param;
        return core::generateGeologicalTerrain(opts);
    }, "extent_x"_a = 250.0f, "extent_z"_a = 250.0f, "resolution"_a = 160,
       "archetype"_a = "alpine_karst", "domain_warp_scale"_a = 1.85f,
       "hydraulic_erosion_steps"_a = 35, "seed"_a = 1337,
       "macro_slope_x"_a = 0.0f, "macro_slope_z"_a = 0.0f,
       "warp_freq"_a = 0.0f, "warp_octaves"_a = 0,
       "content_scale"_a = 0.0f, "content_freq"_a = 0.0f,
       "strata_dune_scale"_a = 0.0f, "strata_dune_freq"_a = 0.0f,
       "slope_scale"_a = 0.0f, "suppressing_param"_a = 0.0f,
       "Synthesizes domain-warped terrain with continuous physical parameters or hydraulic sediment tracking");

    nb::class_<core::TempleOptions>(m_core, "TempleOptions")
        .def(nb::init<>())
        .def_rw("archetype", &core::TempleOptions::archetype)
        .def_rw("order", &core::TempleOptions::order)
        .def_rw("footprint_length", &core::TempleOptions::footprintLength)
        .def_rw("footprint_width", &core::TempleOptions::footprintWidth)
        .def_rw("column_count_x", &core::TempleOptions::columnCountX)
        .def_rw("column_count_y", &core::TempleOptions::columnCountY)
        .def_rw("column_height", &core::TempleOptions::columnHeight)
        .def_rw("plinth_height", &core::TempleOptions::plinthHeight)
        .def_rw("stone_color", &core::TempleOptions::stoneColor)
        .def_rw("seed", &core::TempleOptions::seed);

    m_core.def("build_classical_temple", &core::buildClassicalTemple, "opts"_a = core::TempleOptions());

    nb::class_<core::SensorPassesOptions>(m_core, "SensorPassesOptions")
        .def(nb::init<>())
        .def_rw("width", &core::SensorPassesOptions::width)
        .def_rw("height", &core::SensorPassesOptions::height)
        .def_rw("camera_position", &core::SensorPassesOptions::cameraPosition)
        .def_rw("camera_target", &core::SensorPassesOptions::cameraTarget)
        .def_rw("fov_degrees", &core::SensorPassesOptions::fovDegrees)
        .def_rw("samples_per_pixel", &core::SensorPassesOptions::samplesPerPixel)
        .def_rw("seed", &core::SensorPassesOptions::seed);

    nb::class_<core::SensorPassesResult>(m_core, "SensorPassesResult")
        .def_ro("width", &core::SensorPassesResult::width)
        .def_ro("height", &core::SensorPassesResult::height)
        .def_ro("rgb_beauty", &core::SensorPassesResult::rgbBeauty)
        .def_ro("linear_depth", &core::SensorPassesResult::linearDepth)
        .def_ro("surface_normals", &core::SensorPassesResult::surfaceNormals)
        .def_prop_ro("rgb_beauty_bytes", [](const core::SensorPassesResult& self) {
            return nb::bytes(reinterpret_cast<const char*>(self.rgbBeauty.data()), self.rgbBeauty.size());
        })
        .def_prop_ro("linear_depth_bytes", [](const core::SensorPassesResult& self) {
            return nb::bytes(reinterpret_cast<const char*>(self.linearDepth.data()), self.linearDepth.size() * sizeof(float));
        })
        .def_prop_ro("surface_normals_bytes", [](const core::SensorPassesResult& self) {
            return nb::bytes(reinterpret_cast<const char*>(self.surfaceNormals.data()), self.surfaceNormals.size() * sizeof(float));
        })
        .def_ro("geometry_coverage", &core::SensorPassesResult::geometryCoverage)
        .def_ro("render_ms", &core::SensorPassesResult::renderMs)
        .def_ro("triangle_count", &core::SensorPassesResult::triangleCount)
        .def_ro("vertex_count", &core::SensorPassesResult::vertexCount)
        .def_ro("ground_elevation_contact_min", &core::SensorPassesResult::groundElevationContactMin)
        .def_ro("ground_elevation_contact_max", &core::SensorPassesResult::groundElevationContactMax);

    m_core.def("render_sensor_passes", &core::renderSensorPasses, "scene_mesh"_a, "opts"_a = core::SensorPassesOptions(),
               "Renders RGB beauty, metric linear depth, and surface normal validation passes");

    m.def("render_sensor_passes", [](
        const ScratchboxMesh& mesh,
        int width,
        int height,
        const Vec3& camera_position,
        const Vec3& camera_target,
        float fov_degrees,
        int samples_per_pixel,
        uint32_t seed
    ) {
        core::SensorPassesOptions opts;
        opts.width = width;
        opts.height = height;
        opts.cameraPosition = camera_position;
        opts.cameraTarget = camera_target;
        opts.fovDegrees = fov_degrees;
        opts.samplesPerPixel = samples_per_pixel;
        opts.seed = seed;
        return core::renderSensorPasses(mesh, opts);
    }, "mesh"_a,
       "width"_a = 512,
       "height"_a = 512,
       "camera_position"_a = Vec3(0, 25, 65),
       "camera_target"_a = Vec3(0, 6, 0),
       "fov_degrees"_a = 45.0f,
       "samples_per_pixel"_a = 1,
       "seed"_a = 42,
       "Render RGB beauty, metric linear depth, and surface normal validation passes");

    // ========================================================================
    // 10. GEOMETRIC PROCESSING & TOPOLOGY SUBMODULE (scratchbox_processing.hpp)
    // ========================================================================
    auto m_proc = m.def_submodule("processing", "Scratchbox Native Geometric Processing Engine (Taubin, QEM Decimate, Remesh, Curvature, Poisson Sampling, Hole Filling, CSG Slice, Clean, Hausdorff)");
    m.def_submodule("topology", "Alias to processing submodule");

    nb::class_<processing::CurvatureAnalysisResult>(m_proc, "CurvatureAnalysisResult")
        .def_ro("mean_curvature", &processing::CurvatureAnalysisResult::meanCurvature)
        .def_ro("gaussian_curvature", &processing::CurvatureAnalysisResult::gaussianCurvature)
        .def_ro("principal_k1", &processing::CurvatureAnalysisResult::principalK1)
        .def_ro("principal_k2", &processing::CurvatureAnalysisResult::principalK2)
        .def_ro("shape_index", &processing::CurvatureAnalysisResult::shapeIndex)
        .def_ro("curvedness", &processing::CurvatureAnalysisResult::curvedness)
        .def_ro("cavity_occlusion", &processing::CurvatureAnalysisResult::cavityOcclusion);

    nb::class_<processing::SurfaceSamplePoint>(m_proc, "SurfaceSamplePoint")
        .def_ro("position", &processing::SurfaceSamplePoint::position)
        .def_ro("normal", &processing::SurfaceSamplePoint::normal)
        .def_ro("uv", &processing::SurfaceSamplePoint::uv)
        .def_ro("color", &processing::SurfaceSamplePoint::color);

    nb::class_<processing::HausdorffResult>(m_proc, "HausdorffResult")
        .def_ro("max_distance", &processing::HausdorffResult::maxDistance)
        .def_ro("mean_distance", &processing::HausdorffResult::meanDistance)
        .def_ro("rms_distance", &processing::HausdorffResult::rmsDistance);

    m_proc.def("taubin_smooth", [](ScratchboxMesh& mesh, int iterations, float lambdaVal, float muVal, bool preserveBoundaries) {
        processing::TaubinSmoothOptions opt;
        opt.iterations = iterations;
        opt.lambda = lambdaVal;
        opt.mu = muVal;
        opt.preserveBoundaries = preserveBoundaries;
        processing::TaubinSmoother::smooth(mesh, opt);
    }, "mesh"_a, "iterations"_a = 10, "lambda_val"_a = 0.5f, "mu_val"_a = -0.53f, "preserve_boundaries"_a = true,
       "Apply volume-preserving, non-shrinking Taubin low-pass smoothing filter");

    m_proc.def("decimate_qem", [](const ScratchboxMesh& mesh, size_t targetTriangles, float targetRatio, float maxError, bool preserveBoundary, bool preserveCreases, float creaseAngleDeg) {
        processing::DecimateOptions opt;
        opt.targetTriangles = targetTriangles;
        opt.targetRatio = targetRatio;
        opt.maxError = maxError;
        opt.preserveBoundary = preserveBoundary;
        opt.preserveCreases = preserveCreases;
        opt.creaseAngleDeg = creaseAngleDeg;
        return processing::QuadricDecimator::decimate(mesh, opt);
    }, "mesh"_a, "target_triangles"_a = 0, "target_ratio"_a = 0.5f, "max_error"_a = 1e9f, "preserve_boundary"_a = true,
       "preserve_creases"_a = false, "crease_angle_deg"_a = 45.0f,
       "Garland-Heckbert Quadric Error Metrics (QEM) decimation preserving surface silhouettes and curvature; "
       "preserve_creases locks sharp edges (dihedral angle >= crease_angle_deg) with an extra constraint quadric");

    m_proc.def("poisson_sample", [](const ScratchboxMesh& mesh, size_t count, float minDistance, uint32_t seed) {
        processing::PoissonSampleOptions opt;
        opt.targetCount = count;
        opt.minDistance = minDistance;
        opt.seed = seed;
        return processing::PoissonDiskSampler::sample(mesh, opt);
    }, "mesh"_a, "count"_a = 100, "min_distance"_a = 0.0f, "seed"_a = 42,
       "Blue noise Poisson-disk surface point sampling on mesh triangles");

    m_proc.def("fill_holes", [](const ScratchboxMesh& mesh, size_t maxHoleEdges) {
        processing::HoleFillOptions opt;
        opt.maxHoleEdges = maxHoleEdges;
        return processing::HoleFiller::fillHoles(mesh, opt);
    }, "mesh"_a, "max_hole_edges"_a = 64,
       "Identify open boundary half-edge loops and triangulate cleanly");

    m_proc.def("analyze_curvature", [](const ScratchboxMesh& mesh) {
        return processing::DifferentialGeometryEngine::analyzeCurvature(mesh);
    }, "mesh"_a, "Compute discrete Cotangent Laplace-Beltrami mean/Gaussian curvature and Koenderink Shape Index (-1 to +1)");

    m_proc.def("bake_cavity_ao", [](ScratchboxMesh& mesh, float intensity) {
        processing::DifferentialGeometryEngine::bakeCavityAO(mesh, intensity);
    }, "mesh"_a, "intensity"_a = 0.65f, "Bake geometric cavity ambient occlusion into vertex colors");

    m_proc.def("compute_rtao", [](const ScratchboxMesh& mesh, int samplesPerVertex, float maxDistance, uint32_t seed) {
        return bvh::computeMeshRTAO(mesh, samplesPerVertex, maxDistance, seed);
    }, "mesh"_a, "samples_per_vertex"_a = 16, "max_distance"_a = 1.5f, "seed"_a = 42,
       "Per-vertex ambient occlusion in [0, 1] from BVH cosine-weighted hemisphere ray casts (1 = fully open, 0 = fully occluded)");

    m_proc.def("bake_rtao", [](ScratchboxMesh& mesh, int samplesPerVertex, float maxDistance, float intensity, uint32_t seed) {
        bvh::bakeMeshRTAO(mesh, samplesPerVertex, maxDistance, intensity, seed);
    }, "mesh"_a, "samples_per_vertex"_a = 16, "max_distance"_a = 1.5f, "intensity"_a = 1.0f, "seed"_a = 42,
       "Bake BVH ray-traced ambient occlusion (compute_rtao) into vertex colors");

    m_proc.def("clean_mesh", [](const ScratchboxMesh& mesh, float weldEpsilon) {
        processing::CleanMeshOptions opt;
        opt.weldEpsilon = weldEpsilon;
        return processing::MeshCleaner::clean(mesh, opt);
    }, "mesh"_a, "weld_epsilon"_a = 1e-5f, "Remove duplicate faces, unreferenced vertices, and zero-area sliver triangles");

    m_proc.def("slice_mesh", [](const ScratchboxMesh& mesh, const Vec3& planePoint, const Vec3& planeNormal, bool keepPositive, bool capCut) {
        return processing::PlanarSlicer::slice(mesh, planePoint, planeNormal, keepPositive, capCut);
    }, "mesh"_a, "plane_point"_a = Vec3(0, 0, 0), "plane_normal"_a = Vec3(0, 1, 0), "keep_positive"_a = true, "cap_cut"_a = true,
       "Analytical Sutherland-Hodgman planar mesh slicing with hole capping");

    m_proc.def("isotropic_remesh", [](const ScratchboxMesh& mesh, float targetEdgeLength, int iterations, float creaseAngleDeg) {
        processing::IsotropicRemeshOptions opt;
        opt.targetEdgeLength = targetEdgeLength;
        opt.iterations = iterations;
        opt.creaseAngleDeg = creaseAngleDeg;
        return processing::IsotropicRemesher::remesh(mesh, opt);
    }, "mesh"_a, "target_edge_length"_a = 0.25f, "iterations"_a = 4, "crease_angle_deg"_a = 45.0f,
       "Botsch-Kobbelt isotropic remeshing with tangential edge relaxation");

    m_proc.def("hausdorff_distance", [](const ScratchboxMesh& meshA, const ScratchboxMesh& meshB, size_t samples) {
        return processing::HausdorffDistanceEngine::compute(meshA, meshB, samples);
    }, "mesh_a"_a, "mesh_b"_a, "samples"_a = 500,
       "Measure maximum and mean Hausdorff geometric distance between two meshes");

    // ========================================================================
    // Top-Level Convenience Functions
    // ========================================================================
    m.def("export_glb_bytes", [](const ScratchboxMesh& mesh) {
        auto glb = GlbWriter::writeGlb(mesh);
        return nb::bytes(reinterpret_cast<const char*>(glb.data()), glb.size());
    }, "mesh"_a, "Export ScratchboxMesh directly as a Python bytes object containing .glb data");

    m.def("export_glb_bytes", [](const std::vector<ScratchboxMesh>& meshes) {
        auto glb = GlbWriter::serializeMultiMeshToGlb(meshes);
        return nb::bytes(reinterpret_cast<const char*>(glb.data()), glb.size());
    }, "meshes"_a, "Export multiple ScratchboxMeshes directly as a Python bytes object containing .glb data");

    // ========================================================================
    // 9. SDF SUBMODULE (Signed Distance Fields & CSG)
    // ========================================================================
    auto m_sdf = m.def_submodule("sdf", "Signed distance field primitives, smooth CSG booleans, and domain deformations");

    // Primitives
    m_sdf.def("sd_sphere", &sdf::sdSphere, "p"_a, "radius"_a);
    m_sdf.def("sd_box", &sdf::sdBox, "p"_a, "b"_a);
    m_sdf.def("sd_round_box", &sdf::sdRoundBox, "p"_a, "b"_a, "r"_a);
    m_sdf.def("sd_torus", &sdf::sdTorus, "p"_a, "major_radius"_a, "minor_radius"_a);
    m_sdf.def("sd_cylinder", &sdf::sdCylinder, "p"_a, "radius"_a, "height"_a);
    m_sdf.def("sd_capsule", &sdf::sdCapsule, "p"_a, "a"_a, "b"_a, "radius"_a);
    m_sdf.def("sd_gyroid", &sdf::sdGyroid, "p"_a, "scale"_a = 1.0f, "thickness"_a = 0.1f);

    // Booleans
    m_sdf.def("op_union", &sdf::opUnion, "d1"_a, "d2"_a);
    m_sdf.def("op_subtraction", &sdf::opSubtraction, "d1"_a, "d2"_a);
    m_sdf.def("op_intersection", &sdf::opIntersection, "d1"_a, "d2"_a);
    m_sdf.def("op_smooth_union", &sdf::opSmoothUnion, "d1"_a, "d2"_a, "k"_a = 0.2f);
    m_sdf.def("op_smooth_subtraction", &sdf::opSmoothSubtraction, "d1"_a, "d2"_a, "k"_a = 0.2f);
    m_sdf.def("op_smooth_intersection", &sdf::opSmoothIntersection, "d1"_a, "d2"_a, "k"_a = 0.2f);

    // Domain deformations
    m_sdf.def("op_repeat", &sdf::opRepeat, "p"_a, "c"_a);
    m_sdf.def("op_twist", &sdf::opTwist, "p"_a, "k"_a);
    m_sdf.def("op_bend", &sdf::opBend, "p"_a, "k"_a);

    // ========================================================================
    // 10. HAIR & SPLATS SUBMODULE (Analytical Forward Grooming & Gaussians)
    // ========================================================================
    auto m_hair = m.def_submodule("hair", "Analytical forward hair grooming, Marschner reflectance, and Gaussian splat synthesis");

    nb::class_<spz::GaussianSplat>(m_hair, "GaussianSplat")
        .def(nb::init<>())
        .def_rw("position", &spz::GaussianSplat::position)
        .def_rw("scale", &spz::GaussianSplat::scale)
        .def_rw("rotation", &spz::GaussianSplat::rotation)
        .def_rw("color", &spz::GaussianSplat::color)
        .def_rw("opacity", &spz::GaussianSplat::opacity)
        .def_rw("sh", &spz::GaussianSplat::sh);

    nb::class_<hair::HairGroomConfig>(m_hair, "HairGroomConfig")
        .def(nb::init<>())
        .def_rw("guide_count", &hair::HairGroomConfig::guideCount)
        .def_rw("strand_count", &hair::HairGroomConfig::strandCount)
        .def_rw("segments_per_strand", &hair::HairGroomConfig::segmentsPerStrand)
        .def_rw("length", &hair::HairGroomConfig::length)
        .def_rw("root_width", &hair::HairGroomConfig::rootWidth)
        .def_rw("tip_width", &hair::HairGroomConfig::tipWidth)
        .def_rw("clumping", &hair::HairGroomConfig::clumping)
        .def_rw("curl_radius", &hair::HairGroomConfig::curlRadius)
        .def_rw("curl_frequency", &hair::HairGroomConfig::curlFrequency)
        .def_rw("wave_frequency", &hair::HairGroomConfig::waveFrequency)
        .def_rw("wave_amplitude", &hair::HairGroomConfig::waveAmplitude)
        .def_rw("eumelanin", &hair::HairGroomConfig::eumelanin)
        .def_rw("pheomelanin", &hair::HairGroomConfig::pheomelanin)
        .def_rw("cuticle_tilt", &hair::HairGroomConfig::cuticleTilt)
        .def_rw("longitudinal_roughness", &hair::HairGroomConfig::longitudinalRoughness)
        .def_rw("azimuthal_roughness", &hair::HairGroomConfig::azimuthalRoughness);

    nb::class_<hair::HairGuide>(m_hair, "HairGuide")
        .def(nb::init<>())
        .def_rw("root", &hair::HairGuide::root)
        .def_rw("p1", &hair::HairGuide::p1)
        .def_rw("p2", &hair::HairGuide::p2)
        .def_rw("tip", &hair::HairGuide::tip)
        .def_rw("length", &hair::HairGuide::length)
        .def("evaluate", &hair::HairGuide::evaluate, "t"_a)
        .def("evaluate_tangent", &hair::HairGuide::evaluateTangent, "t"_a);

    nb::class_<hair::HairStrand>(m_hair, "HairStrand")
        .def(nb::init<>())
        .def_rw("guide_index", &hair::HairStrand::guideIndex)
        .def_rw("curl_phase", &hair::HairStrand::curlPhase)
        .def_rw("base_color", &hair::HairStrand::baseColor)
        .def_prop_ro("vertex_count", [](const hair::HairStrand& self) { return self.vertices.size(); });

    m_hair.def("generate_scalp_guides", &hair::HairGroomer::generateScalpGuides,
               "scalp_center"_a, "scalp_radius"_a, "config"_a, "flow_direction"_a = Vec3(0.0f, -0.6f, 0.8f));

    m_hair.def("generate_surface_guides", &hair::HairGroomer::generateSurfaceGuides,
               "surface_positions"_a, "surface_normals"_a, "config"_a, "flow_direction"_a = Vec3(0.0f, 0.0f, 0.0f));

    m_hair.def("generate_harmonic_guides", &hair::HairGroomer::generateHarmonicGuides,
               "center"_a, "base_radius"_a, "harmonic_frequency"_a, "harmonic_amplitude"_a, "config"_a, "axial_taper"_a = 0.0f);

    m_hair.def("synthesize_dense_strands", &hair::HairGroomer::synthesizeDenseStrands,
               "guides"_a, "config"_a);

    m_hair.def("build_ribbon_mesh", &hair::HairRibbonMeshBuilder::buildRibbonMesh,
               "strands"_a, "camera_pos"_a = Vec3(0.0f, 0.0f, 5.0f), "mesh_name"_a = "hair_ribbons");

    m_hair.def("build_strand_splats", &hair::HairSplatBuilder::buildStrandSplats,
               "strands"_a, "splat_scale_multiplier"_a = 1.0f, "base_opacity"_a = 0.92f,
               "custom_base_color"_a = Vec3(-1.0f, -1.0f, -1.0f), "custom_tip_color"_a = Vec3(-1.0f, -1.0f, -1.0f));

    m_hair.def("build_surfel_mesh", &spz::SplatMeshBuilder::buildSurfelMesh,
               "splats"_a, "radius_multiplier"_a = 1.25f, "min_opacity_threshold"_a = 0.05f);

    m_hair.def("build_spz", [](const std::vector<hair::HairStrand>& strands, float splatScaleMultiplier, float baseOpacity) {
        auto bytes = hair::HairSplatBuilder::buildSpz(strands, splatScaleMultiplier, baseOpacity);
        return nb::bytes(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }, "strands"_a, "splat_scale_multiplier"_a = 1.0f, "base_opacity"_a = 0.92f);

    m_hair.def("save_spz_file", &hair::HairSplatBuilder::saveToSpzFile, "filepath"_a, "splats"_a);
    m_hair.def("save_ply_file", &hair::HairSplatBuilder::saveToPlyFile, "filepath"_a, "splats"_a);

    // ========================================================================
    // 12. HUMAN & ENTOURAGE SUBMODULE
    // ========================================================================
    auto m_human = m.def_submodule("human", "Parametric human anatomy, kinematics, and scale entourage");

    nb::enum_<skinning::GenderMorph>(m_human, "GenderMorph")
        .value("Male", skinning::GenderMorph::Male)
        .value("Female", skinning::GenderMorph::Female)
        .value("Neutral", skinning::GenderMorph::Neutral);

    nb::class_<kinematics::Skeleton>(m_human, "Skeleton")
        .def("find_joint", &kinematics::Skeleton::findJoint, "name"_a)
        .def("set_joint_rotation", [](kinematics::Skeleton& self, const std::string& name, const Vec3& rot) {
            self.setJointRotation(name, rot);
        }, "name"_a, "rotation"_a)
        .def("get_joint_rotation", [](const kinematics::Skeleton& self, const std::string& name) -> Vec3 {
            int32_t idx = self.findJoint(name);
            if (idx >= 0 && idx < static_cast<int32_t>(self.joints.size())) {
                return self.joints[idx].localRotation;
            }
            return Vec3(0.0f, 0.0f, 0.0f);
        }, "name"_a);

    nb::class_<parametric::SbHumanModel>(m_human, "SbHumanModel")
        .def_static("load_standard", &parametric::SbHumanModel::loadStandardModel, "gender"_a, "target_height"_a = 1.76f)
        .def("evaluate_posed", [](parametric::SbHumanModel& self, kinematics::Skeleton& skeleton) {
            return self.evaluatePosed(skeleton);
        }, "skeleton"_a)
        .def_rw("skeleton", &parametric::SbHumanModel::skeleton);

    m_human.def("create_grounded_character", [](
        float genderBeta,
        float targetHeight,
        const Vec3& position,
        float facingAngleDeg,
        const std::string& poseArchetype,
        const std::string& role,
        const ScratchboxMesh* surfaceMesh,
        float surfaceYOffset
    ) -> ScratchboxMesh {
        skinning::GenderMorph gender = (genderBeta > 0.3f) ? skinning::GenderMorph::Male
                                     : (genderBeta < -0.3f) ? skinning::GenderMorph::Female
                                     : skinning::GenderMorph::Neutral;

        parametric::SbHumanModel charModel = parametric::SbHumanModel::loadStandardModel(gender, targetHeight);
        kinematics::Skeleton posedRig = charModel.skeleton;

        // Apply natural survey/standing contrapposto pose
        posedRig.setJointRotation("LeftShoulder", Vec3(0.06f, 0.08f, -1.18f));
        posedRig.setJointRotation("RightShoulder", Vec3(0.06f, -0.08f, 1.18f));
        posedRig.setJointRotation("LeftElbow", Vec3(0.18f, 0.15f, -0.12f));
        posedRig.setJointRotation("RightElbow", Vec3(0.18f, -0.15f, 0.12f));
        posedRig.setJointRotation("Spine1", Vec3(0.04f, 0.0f, 0.02f));
        posedRig.setJointRotation("Spine2", Vec3(0.02f, 0.0f, -0.01f));
        posedRig.setJointRotation("Head", Vec3(-0.06f, 0.12f, 0.0f));

        if (poseArchetype == "ground_inspection") {
            posedRig.setJointRotation("Spine1", Vec3(0.18f, 0.0f, 0.0f));
            posedRig.setJointRotation("Spine2", Vec3(0.15f, 0.0f, 0.0f));
            posedRig.setJointRotation("Head", Vec3(0.25f, 0.0f, 0.0f));
        }

        float facingRad = facingAngleDeg * (3.14159265f / 180.0f);
        auto rotateY = [](const Vec3& p, float rad) -> Vec3 {
            float cosA = std::cos(rad);
            float sinA = std::sin(rad);
            return Vec3(p.x * cosA + p.z * sinA, p.y, -p.x * sinA + p.z * cosA);
        };

        // Query foot rest positions
        int32_t lAnkleIdx = posedRig.findJoint("LeftAnkle");
        int32_t rAnkleIdx = posedRig.findJoint("RightAnkle");
        Vec3 lAnkleRest = (lAnkleIdx >= 0) ? posedRig.joints[lAnkleIdx].restPosition : Vec3(0.10f, 0.08f, 0.0f);
        Vec3 rAnkleRest = (rAnkleIdx >= 0) ? posedRig.joints[rAnkleIdx].restPosition : Vec3(-0.10f, 0.08f, 0.0f);

        Vec3 lFootRot = rotateY(Vec3(lAnkleRest.x, 0.0f, lAnkleRest.z), facingRad);
        Vec3 rFootRot = rotateY(Vec3(rAnkleRest.x, 0.0f, rAnkleRest.z), facingRad);
        float lFootX = position.x + lFootRot.x;
        float lFootZ = position.z + lFootRot.z;
        float rFootX = position.x + rFootRot.x;
        float rFootZ = position.z + rFootRot.z;

        // Sample surface mesh elevation if provided, else rely on position.y
        auto sampleSurfaceElevation = [&](float x, float z) -> float {
            if (surfaceMesh != nullptr && !surfaceMesh->vertices.empty()) {
                float bestY = position.y;
                float bestDistSq = 1e9f;
                for (const auto& sv : surfaceMesh->vertices) {
                    float dx = sv.position.x - x;
                    float dz = sv.position.z - z;
                    float dSq = dx * dx + dz * dz;
                    if (dSq < bestDistSq) {
                        bestDistSq = dSq;
                        bestY = sv.position.y;
                    }
                }
                if (bestDistSq < 25.0f) {
                    return bestY + surfaceYOffset;
                }
            }
            return position.y + surfaceYOffset;
        };

        float hL = sampleSurfaceElevation(lFootX, lFootZ);
        float hR = sampleSurfaceElevation(rFootX, rFootZ);
        float hBase = std::min(hL, hR);
        float deltaL = hL - hBase;
        float deltaR = hR - hBase;

        // Law of Cosines 2-Bone IK Leg Shortening for elevated foot
        float legLength = 0.82f * (targetHeight / 1.76f);
        float upperLeg = legLength * 0.52f;
        float lowerLeg = legLength * 0.48f;

        if (deltaL > 0.002f) {
            float targetReach = std::clamp(legLength - deltaL, 0.35f * legLength, legLength);
            float cosKnee = std::clamp((upperLeg * upperLeg + lowerLeg * lowerLeg - targetReach * targetReach) / (2.0f * upperLeg * lowerLeg), -1.0f, 1.0f);
            float kneeAngle = std::acos(cosKnee);
            posedRig.setJointRotation("LeftKnee", Vec3(kneeAngle, 0.0f, 0.0f));
            posedRig.setJointRotation("LeftHip", Vec3(-kneeAngle * 0.5f, 0.0f, 0.0f));
        }
        if (deltaR > 0.002f) {
            float targetReach = std::clamp(legLength - deltaR, 0.35f * legLength, legLength);
            float cosKnee = std::clamp((upperLeg * upperLeg + lowerLeg * lowerLeg - targetReach * targetReach) / (2.0f * upperLeg * lowerLeg), -1.0f, 1.0f);
            float kneeAngle = std::acos(cosKnee);
            posedRig.setJointRotation("RightKnee", Vec3(kneeAngle, 0.0f, 0.0f));
            posedRig.setJointRotation("RightHip", Vec3(-kneeAngle * 0.5f, 0.0f, 0.0f));
        }

        posedRig.updateTransforms();
        ScratchboxMesh figure = charModel.evaluatePosed(posedRig);

        // Ground contact alignment (0.00 mm floating / penetration)
        float modelMinY = figure.bounds.min.y;
        float groundPlacementY = hBase - modelMinY;

        // 18% Studio Grey Clay Invariant
        Vec4 clayTone(0.55f, 0.57f, 0.60f, 1.0f);
        ScratchboxMesh outMesh("Character_" + role);
        outMesh.material.name = "Entourage_Studio_Clay";
        outMesh.material.roughnessFactor = 0.85f;
        outMesh.material.metallicFactor = 0.0f;
        outMesh.material.baseColorFactor = clayTone;

        outMesh.vertices.reserve(figure.vertices.size());
        for (const auto& v : figure.vertices) {
            Vec3 rotP = rotateY(v.position, facingRad);
            Vec3 rotN = rotateY(v.normal, facingRad);
            Vec3 worldP = rotP + Vec3(position.x, groundPlacementY, position.z);
            // The material carries the clay tone; COLOR_0 stays white so the colour is applied once.
            outMesh.vertices.push_back(Vertex{worldP, rotN, v.uv, Vec4(1.0f, 1.0f, 1.0f, 1.0f)});
        }
        outMesh.indices = figure.indices;
        outMesh.recomputeBounds();

        return outMesh;
    }, "gender_beta"_a = 0.0f,
       "target_height"_a = 1.76f,
       "position"_a = Vec3(0.0f, 0.0f, 0.0f),
       "facing_angle_deg"_a = 0.0f,
       "pose_archetype"_a = "standing_survey",
       "role"_a = "scale_figure",
       "surface_mesh"_a = nullptr,
       "surface_y_offset"_a = 0.0f,
       "Procedurally synthesizes and grounds an architectural scale entourage figure conforming to the 18% Studio Grey Clay Invariant");

    // ========================================================================
    // SB-RIG SUBMODULE (analytical auto-rigging of any mesh)
    // ========================================================================
    auto m_rig = m.def_submodule("rig", "SB-Rig: geometry-derived joint trees and geodesic 4-bone skin weights for any mesh");
    using Point3 = std::array<float, 3>;
    auto toVec3 = [](const Point3& p) { return Vec3(p[0], p[1], p[2]); };
    auto renameFromDict = [](const nb::dict& d) {
        sb_rig::RenameMap map;
        for (auto [key, value] : d) map.emplace_back(nb::cast<std::string>(key), nb::cast<std::string>(value));
        return map;
    };

    nb::class_<sb_rig::SbRigParams>(m_rig, "Params",
        "All lengths are dimensionless fractions of lengths the mesh measures itself (geodesic diameter D, bbox diagonal, ring radius).")
        .def(nb::init<>())
        .def_rw("weld_frac", &sb_rig::SbRigParams::weldFrac)
        .def_rw("refine_edge_multiple", &sb_rig::SbRigParams::refineEdgeMultiple)
        .def_rw("agd_samples", &sb_rig::SbRigParams::agdSamples)
        .def_rw("band_frac", &sb_rig::SbRigParams::bandFrac)
        .def_rw("band_edge_multiple", &sb_rig::SbRigParams::bandEdgeMultiple)
        .def_rw("loop_contract_ratio", &sb_rig::SbRigParams::loopContractRatio)
        .def_rw("min_node_frac", &sb_rig::SbRigParams::minNodeFrac)
        .def_rw("min_branch_frac", &sb_rig::SbRigParams::minBranchFrac)
        .def_rw("hub_merge_frac", &sb_rig::SbRigParams::hubMergeFrac)
        .def_rw("joint_deviation_frac", &sb_rig::SbRigParams::jointDeviationFrac)
        .def_rw("radius_weight", &sb_rig::SbRigParams::radiusWeight)
        .def_rw("bend_threshold_rad", &sb_rig::SbRigParams::bendThresholdRad)
        .def_rw("min_bone_frac", &sb_rig::SbRigParams::minBoneFrac)
        .def_rw("max_bone_frac", &sb_rig::SbRigParams::maxBoneFrac)
        .def_rw("min_leaf_chain_segments", &sb_rig::SbRigParams::minLeafChainSegments)
        .def_rw("blend_scale", &sb_rig::SbRigParams::blendScale)
        .def_rw("emit_tip_joints", &sb_rig::SbRigParams::emitTipJoints)
        .def_prop_rw("root_hint",
            [](const sb_rig::SbRigParams& p) -> std::optional<Point3> {
                if (!p.hasRootHint) return std::nullopt;
                return Point3{p.rootHint.x, p.rootHint.y, p.rootHint.z};
            },
            [toVec3](sb_rig::SbRigParams& p, std::optional<Point3> hint) {
                p.hasRootHint = hint.has_value();
                if (hint) p.rootHint = toVec3(*hint);
            },
            "World-space point near where the hierarchy should start (e.g. the cut end of a limb); None = geodesic centre.")
        .def_prop_rw("chain_hints",
            [](const sb_rig::SbRigParams& p) {
                std::vector<std::vector<Point3>> out;
                for (const auto& h : p.chainHints) {
                    std::vector<Point3> pts;
                    for (const auto& v : h) pts.push_back({v.x, v.y, v.z});
                    out.push_back(pts);
                }
                return out;
            },
            [toVec3](sb_rig::SbRigParams& p, const std::vector<std::vector<Point3>>& hints) {
                p.chainHints.clear();
                for (const auto& h : hints) {
                    std::vector<Vec3> pts;
                    for (const auto& v : h) pts.push_back(toVec3(v));
                    p.chainHints.push_back(pts);
                }
            },
            "Extra chains, each a base-to-tip list of points (surface points are pulled to the local axis).")
        .def("set", &sb_rig::SbRigParams::set, "name"_a, "value"_a, "Set a parameter by its camelCase name, e.g. set('minBranchFrac', '0.06')")
        .def("validate", &sb_rig::SbRigParams::validate);

    nb::class_<sb_rig::SbRigChain>(m_rig, "Chain")
        .def_ro("name", &sb_rig::SbRigChain::name)
        .def_ro("parent_joint", &sb_rig::SbRigChain::parentJoint)
        .def_ro("joints", &sb_rig::SbRigChain::joints)
        .def_ro("leaf", &sb_rig::SbRigChain::leaf)
        .def_ro("hinted", &sb_rig::SbRigChain::hinted)
        .def_ro("length", &sb_rig::SbRigChain::length)
        .def("__repr__", [](const sb_rig::SbRigChain& c) {
            return "<sb.rig.Chain " + c.name + (c.leaf ? " leaf" : " inner") + " joints=" + std::to_string(c.joints.size()) + ">";
        });

    nb::class_<sb_rig::SbRigResult>(m_rig, "Result")
        .def_ro("skeleton", &sb_rig::SbRigResult::skeleton)
        .def_ro("chains", &sb_rig::SbRigResult::chains)
        .def_prop_ro("joint_names", [](const sb_rig::SbRigResult& r) {
            std::vector<std::string> names;
            for (const auto& j : r.skeleton.joints) names.push_back(j.name);
            return names;
        })
        .def_prop_ro("parents", [](const sb_rig::SbRigResult& r) {
            std::vector<int32_t> parents;
            for (const auto& j : r.skeleton.joints) parents.push_back(j.parentIndex);
            return parents;
        })
        .def_prop_ro("rest_positions", [](const sb_rig::SbRigResult& r) {
            std::vector<Point3> out;
            for (const auto& j : r.skeleton.joints) out.push_back({j.restPosition.x, j.restPosition.y, j.restPosition.z});
            return out;
        })
        .def_prop_ro("tip_joints", [](const sb_rig::SbRigResult& r) {
            nb::list out;
            for (uint8_t t : r.jointIsTip) out.append(nb::bool_(t != 0));
            return out;
        }, "True for end-effector joints, which carry no weight.")
        .def_prop_ro("joint_indices", [](const sb_rig::SbRigResult& r) {
            std::vector<uint16_t> out;
            out.reserve(r.weights.size() * 4);
            for (const auto& w : r.weights) out.insert(out.end(), w.joints.begin(), w.joints.end());
            return out;
        }, "Flat list, 4 joint indices per input vertex (glTF JOINTS_0 order).")
        .def_prop_ro("joint_weights", [](const sb_rig::SbRigResult& r) {
            std::vector<float> out;
            out.reserve(r.weights.size() * 4);
            for (const auto& w : r.weights) out.insert(out.end(), w.weights.begin(), w.weights.end());
            return out;
        }, "Flat list, 4 weights per input vertex summing to 1 (glTF WEIGHTS_0 order).")
        .def_ro("vertex_owner", &sb_rig::SbRigResult::vertexOwner)
        .def_prop_ro("leaf_count", &sb_rig::SbRigResult::leafCount)
        .def("rename", [renameFromDict](sb_rig::SbRigResult& r, const nb::dict& mapping) { r.rename(renameFromDict(mapping)); }, "mapping"_a,
             "Rename joints in dict order. A chain name (e.g. 'Chain3') renames its joints to <value>1..n; any other key must be an exact joint name.")
        .def("report_json", [](const sb_rig::SbRigResult& r, const sb_rig::SbRigParams& params, bool includeTree) {
            return sb_rig::reportJson(r, params, includeTree).dump();
        }, "params"_a = sb_rig::SbRigParams(), "include_tree"_a = false)
        .def("__repr__", [](const sb_rig::SbRigResult& r) {
            return "<sb.rig.Result joints=" + std::to_string(r.skeleton.joints.size()) + " chains=" + std::to_string(r.chains.size()) +
                   " leaves=" + std::to_string(r.leafCount()) + ">";
        });

    m_rig.def("solve", [](const ScratchboxMesh& mesh, const sb_rig::SbRigParams& params) {
        return sb_rig::SbRigSolver::solve(mesh, params);
    }, "mesh"_a, "params"_a = sb_rig::SbRigParams(), nb::call_guard<nb::gil_scoped_release>(),
       "Discover a joint tree and 4-bone skin weights for an in-memory mesh.");

    m_rig.def("rig_glb", [renameFromDict](const std::string& inputPath, const std::string& outputPath, const sb_rig::SbRigParams& params,
                                          std::optional<nb::dict> rename, std::optional<std::string> reportPath) {
        sb_rig::RenameMap map = rename ? renameFromDict(*rename) : sb_rig::RenameMap{};
        sb_rig::SbRigResult result;
        {
            nb::gil_scoped_release release;
            result = sb_rig::rigGlbFile(inputPath, outputPath, params, map);
        }
        if (reportPath) {
            std::ofstream f(*reportPath);
            if (!f.is_open()) throw std::runtime_error("cannot write " + *reportPath);
            f << sb_rig::reportJson(result, params).dump();
        }
        return result;
    }, "input_path"_a, "output_path"_a, "params"_a = sb_rig::SbRigParams(), "rename"_a = nb::none(), "report_path"_a = nb::none(),
       "Rig a GLB file and write the skinned GLB; images, UVs and materials are carried over byte for byte.");

    m_rig.def("export_skinned_glb_bytes", [](const ScratchboxMesh& mesh, const sb_rig::SbRigResult& result) {
        if (result.weights.size() != mesh.vertices.size()) throw std::invalid_argument("result was solved for a different mesh");
        for (const auto& j : result.skeleton.joints) sb_rig::validateJointName(j.name);
        auto glb = GlbWriter::serializeSkinnedGlb(mesh, result.weights, result.skeleton);
        return nb::bytes(reinterpret_cast<const char*>(glb.data()), glb.size());
    }, "mesh"_a, "result"_a, "Serialise an in-memory mesh with its SB-Rig skin as .glb bytes.");
}
