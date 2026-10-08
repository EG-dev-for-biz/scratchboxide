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
            for (auto& v : self.vertices) {
                float n = noise.fBm(v.position.x * frequency, v.position.y * frequency, v.position.z * frequency, 3, 0.5f, 2.0f);
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
        .def("decimate_qem", [](ScratchboxMesh& self, size_t targetTriangles, float targetRatio, float maxError, bool preserveBoundary) -> ScratchboxMesh& {
            processing::DecimateOptions opt;
            opt.targetTriangles = targetTriangles;
            opt.targetRatio = targetRatio;
            opt.maxError = maxError;
            opt.preserveBoundary = preserveBoundary;
            ScratchboxMesh res = processing::QuadricDecimator::decimate(self, opt);
            self.vertices = std::move(res.vertices);
            self.indices = std::move(res.indices);
            self.bounds = res.bounds;
            return self;
        }, "target_triangles"_a = 0, "target_ratio"_a = 0.5f, "max_error"_a = 1e9f, "preserve_boundary"_a = true)
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

    m_geom.def("create_lathe", [](const std::vector<Vec2>& profile, int radialSegments, float totalAngleRad, const Vec4& color) {
        return shaper::Lathe3D::revolve(profile, radialSegments, totalAngleRad, color);
    }, "profile"_a, "radial_segments"_a = 32, "total_angle_rad"_a = math::TWO_PI, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

    m_geom.def("create_loft", [](const std::vector<std::vector<Vec3>>& slices, bool closeEnds, const Vec4& color) {
        return shaper::Loft3D::skin(slices, closeEnds, color);
    }, "slices"_a, "close_ends"_a = true, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f));

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

    m_nat.def("generate_tree_components", [](const SpaceColonizationConfig& config) {
        auto [wood, foliage] = SpaceColonizationTreeGenerator::generateTreeComponents(config);
        return std::make_pair(wood.toScratchboxMesh(), foliage.toScratchboxMesh());
    }, "config"_a, "Generate separate wood and foliage components with proper material tagging and cylindrical UVs");

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

    m_shaper.def("lathe", [](const std::vector<Vec2>& profile, int radialSegments, float totalAngleRad, const Vec4& color) {
        return shaper::Lathe3D::revolve(profile, radialSegments, totalAngleRad, color);
    }, "profile"_a, "radial_segments"_a = 32, "total_angle_rad"_a = math::TWO_PI, "color"_a = Vec4(0.8f, 0.85f, 0.9f, 1.0f), "Revolve 2D profile into rotational solid");

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

    m_io.def("write_botanical_glb", [](const std::string& path, const std::vector<ScratchboxMesh>& meshes, int texture_res, float season, uint32_t seed) {
        auto textures = botanical::BotanicalPbrTextureSynthesizer::createBotanicalEmbeddedTextures(texture_res, texture_res, season, seed, false);
        auto glb = GlbWriter::serializeMultiMeshToGlb(meshes, textures);
        std::ofstream out(path, std::ios::binary);
        if (!out.is_open()) {
            throw std::runtime_error("Failed to open file for writing: " + path);
        }
        out.write(reinterpret_cast<const char*>(glb.data()), static_cast<std::streamsize>(glb.size()));
        out.close();
        return true;
    }, "path"_a, "meshes"_a, "texture_res"_a = 512, "season"_a = 1.0f, "seed"_a = 42,
       "Save botanical tree meshes to GLB embedding procedural Worley bark and botanical foliage PBR texture maps (Albedo, Normal, ORM)");

    // ========================================================================
    // 8. PLANT SUBMODULE (scratchbox_plant_builder.hpp)
    // ========================================================================
    auto m_plant = m.def_submodule("plant", "Procedural botanical plant presets and heroic biome assets");

    nb::class_<plant::PlantBuildResult>(m_plant, "PlantBuildResult")
        .def_rw("wood_mesh", &plant::PlantBuildResult::woodMesh)
        .def_rw("foliage_mesh", &plant::PlantBuildResult::foliageMesh)
        .def_rw("ground_clutter_mesh", &plant::PlantBuildResult::groundClutterMesh)
        .def_rw("total_vertices", &plant::PlantBuildResult::totalVertices)
        .def_rw("total_triangles", &plant::PlantBuildResult::totalTriangles)
        .def("get_combined", &plant::PlantBuildResult::getCombined, "name"_a = "CombinedPlant");

    m_plant.def("create_hero_redwood", [](const Vec3& pos, float height) {
        return plant::PlantPresets::createHeroAncientRedwood(pos, height);
    }, "pos"_a = Vec3(0, 0, 0), "height"_a = 28.0f, "Create hero ancient redwood with 8 buttress flutes and multi-tier conifer boughs");

    m_plant.def("create_understory_dogwood", [](const Vec3& pos, float height) {
        return plant::PlantPresets::createUnderstoryDogwood(pos, height);
    }, "pos"_a = Vec3(0, 0, 0), "height"_a = 5.5f, "Create subcanopy understory dogwood tree");

    m_plant.def("create_sword_fern_colony", [](const Vec3& pos, float radius, int fronds) {
        return plant::PlantPresets::createSwordFernColony(pos, radius, fronds);
    }, "pos"_a = Vec3(0, 0, 0), "radius"_a = 1.6f, "fronds"_a = 26, "Create arching sword fern colony");

    m_plant.def("create_wood_sorrel_cushion", [](const Vec3& pos, float radius) {
        return plant::PlantPresets::createWoodSorrelCushion(pos, radius);
    }, "pos"_a = Vec3(0, 0, 0), "radius"_a = 0.95f, "Create trifoliate wood sorrel ground cushion");

    m_plant.def("create_decaying_nurse_log", [](const Vec3& start, const Vec3& end, float radius) {
        return plant::PlantPresets::createDecayingNurseLog(start, end, radius);
    }, "start"_a = Vec3(-2, 0, 0), "end"_a = Vec3(2, 0, 0), "radius"_a = 0.5f, "Create decaying nurse log with polypore shelves");

    // ========================================================================
    // 9. CORE INVARIANT KERNEL (GeoMorph, ArchiMorph, Sensor Passes)
    // ========================================================================
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

    m_proc.def("decimate_qem", [](const ScratchboxMesh& mesh, size_t targetTriangles, float targetRatio, float maxError, bool preserveBoundary) {
        processing::DecimateOptions opt;
        opt.targetTriangles = targetTriangles;
        opt.targetRatio = targetRatio;
        opt.maxError = maxError;
        opt.preserveBoundary = preserveBoundary;
        return processing::QuadricDecimator::decimate(mesh, opt);
    }, "mesh"_a, "target_triangles"_a = 0, "target_ratio"_a = 0.5f, "max_error"_a = 1e9f, "preserve_boundary"_a = true,
       "Garland-Heckbert Quadric Error Metrics (QEM) decimation preserving surface silhouettes and curvature");

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
}
