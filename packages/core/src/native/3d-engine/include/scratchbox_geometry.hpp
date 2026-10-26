/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_GEOMETRY_HPP
#define SCRATCHBOX_GEOMETRY_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <string>
#include <functional>
#include <algorithm>
#include <thread>
#include <cstdint>
#include <cmath>
#include <unordered_map>

namespace scratchbox {
namespace geometry {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::AABB;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;

struct PbrMaterial {
    std::string name{"defaultMaterial"};
    Vec4 baseColorFactor{0.8f, 0.85f, 0.9f, 1.0f};
    float metallicFactor{0.1f};
    float roughnessFactor{0.5f};
    Vec3 emissiveFactor{0.0f, 0.0f, 0.0f};
    float clearcoatFactor{0.0f};
    float clearcoatRoughnessFactor{0.03f};
    float transmissionFactor{0.0f};
    float thicknessFactor{0.0f};
    Vec3 attenuationColor{1.0f, 1.0f, 1.0f};
    float attenuationDistance{1.0f};
    Vec3 sheenColorFactor{0.0f, 0.0f, 0.0f};
    float sheenRoughnessFactor{0.0f};
    float anisotropyStrength{0.0f};
    float anisotropyRotation{0.0f};
    float iridescenceFactor{0.0f};
    float iridescenceIor{1.3f};
    float iridescenceThicknessMin{100.0f};
    float iridescenceThicknessMax{400.0f};
    float emissiveStrength{1.0f};
    float ior{1.5f};
    bool doubleSided{false};
    std::string alphaMode{"OPAQUE"};
    float alphaCutoff{0.5f};

    static PbrMaterial titanium() {
        PbrMaterial m;
        m.name = "brushed_titanium";
        m.baseColorFactor = Vec4(0.75f, 0.77f, 0.82f, 1.0f);
        m.metallicFactor = 0.95f;
        m.roughnessFactor = 0.22f;
        return m;
    }

    static PbrMaterial chrome() {
        PbrMaterial m;
        m.name = "polished_chrome";
        m.baseColorFactor = Vec4(0.96f, 0.97f, 0.99f, 1.0f);
        m.metallicFactor = 0.98f;
        m.roughnessFactor = 0.06f;
        return m;
    }

    static PbrMaterial gold() {
        PbrMaterial m;
        m.name = "polished_gold";
        m.baseColorFactor = Vec4(1.00f, 0.84f, 0.00f, 1.0f);
        m.metallicFactor = 0.95f;
        m.roughnessFactor = 0.15f;
        return m;
    }

    static PbrMaterial basaltRock() {
        PbrMaterial m;
        m.name = "volcanic_basalt";
        m.baseColorFactor = Vec4(0.18f, 0.17f, 0.19f, 1.0f);
        m.metallicFactor = 0.05f;
        m.roughnessFactor = 0.88f;
        return m;
    }

    static PbrMaterial woodOak() {
        PbrMaterial m;
        m.name = "procedural_oak";
        m.baseColorFactor = Vec4(0.42f, 0.28f, 0.16f, 1.0f);
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.82f;
        return m;
    }

    static PbrMaterial roughWood() {
        PbrMaterial m;
        m.name = "rough_wood";
        m.baseColorFactor = Vec4(0.38f, 0.25f, 0.14f, 1.0f);
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.88f;
        return m;
    }

    static PbrMaterial quartzCrystal() {
        PbrMaterial m;
        m.name = "amethyst_quartz";
        m.baseColorFactor = Vec4(0.68f, 0.38f, 0.92f, 0.9f);
        m.metallicFactor = 0.08f;
        m.roughnessFactor = 0.12f;
        m.emissiveFactor = Vec3(0.28f, 0.10f, 0.48f);
        m.transmissionFactor = 0.75f;
        m.ior = 1.54f;
        return m;
    }

    static PbrMaterial carbonComposite() {
        PbrMaterial m;
        m.name = "carbon_composite";
        m.baseColorFactor = Vec4(0.14f, 0.14f, 0.16f, 1.0f);
        m.metallicFactor = 0.25f;
        m.roughnessFactor = 0.60f;
        m.clearcoatFactor = 0.4f;
        return m;
    }

    static PbrMaterial emissiveGlow(const Vec3& color, float intensity = 1.0f) {
        PbrMaterial m;
        m.name = "photonic_glow";
        m.baseColorFactor = Vec4(color.x, color.y, color.z, 1.0f);
        m.metallicFactor = 0.0f;
        m.roughnessFactor = 0.2f;
        m.emissiveFactor = color * intensity;
        return m;
    }

    static PbrMaterial opticalGlass() {
        PbrMaterial m;
        m.name = "optical_crown_glass";
        m.baseColorFactor = Vec4(0.92f, 0.96f, 0.99f, 0.15f);
        m.metallicFactor = 0.0f;
        m.roughnessFactor = 0.04f;
        m.transmissionFactor = 0.98f;
        m.ior = 1.52f;
        m.clearcoatFactor = 1.0f;
        m.clearcoatRoughnessFactor = 0.02f;
        return m;
    }

    static PbrMaterial copperBullet() {
        PbrMaterial m;
        m.name = "copper_bullet_jacket";
        m.baseColorFactor = Vec4(0.95f, 0.64f, 0.54f, 1.0f);
        m.metallicFactor = 0.92f;
        m.roughnessFactor = 0.22f;
        return m;
    }

    static PbrMaterial polishedBrass() {
        PbrMaterial m;
        m.name = "polished_brass";
        m.baseColorFactor = Vec4(0.91f, 0.78f, 0.42f, 1.0f);
        m.metallicFactor = 0.88f;
        m.roughnessFactor = 0.18f;
        return m;
    }

    static PbrMaterial stoneLimestone() {
        PbrMaterial m;
        m.name = "indiana_limestone";
        m.baseColorFactor = Vec4(0.82f, 0.79f, 0.73f, 1.0f);
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.76f;
        return m;
    }

    static PbrMaterial concreteBrutalist() {
        PbrMaterial m;
        m.name = "brutalist_concrete";
        m.baseColorFactor = Vec4(0.68f, 0.67f, 0.65f, 1.0f);
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.82f;
        return m;
    }

    static PbrMaterial asphaltStreet() {
        PbrMaterial m;
        m.name = "asphalt_street";
        m.baseColorFactor = Vec4(0.18f, 0.18f, 0.20f, 1.0f);
        m.metallicFactor = 0.01f;
        m.roughnessFactor = 0.92f;
        return m;
    }

    static PbrMaterial metalDarkAnodized() {
        PbrMaterial m;
        m.name = "metal_dark_anodized";
        m.baseColorFactor = Vec4(0.22f, 0.23f, 0.25f, 1.0f);
        m.metallicFactor = 0.92f;
        m.roughnessFactor = 0.28f;
        return m;
    }

    static PbrMaterial metalBrushedSteel() {
        PbrMaterial m;
        m.name = "metal_brushed_steel";
        m.baseColorFactor = Vec4(0.78f, 0.80f, 0.82f, 1.0f);
        m.metallicFactor = 0.88f;
        m.roughnessFactor = 0.32f;
        return m;
    }

    static PbrMaterial plasticSmoothBlack() {
        PbrMaterial m;
        m.name = "plastic_smooth_black";
        m.baseColorFactor = Vec4(0.08f, 0.08f, 0.09f, 1.0f);
        m.metallicFactor = 0.0f;
        m.roughnessFactor = 0.35f;
        return m;
    }

    static PbrMaterial plasticShiny(const Vec4& color = Vec4(0.85f, 0.85f, 0.85f, 1.0f)) {
        PbrMaterial m;
        m.name = "plastic_shiny";
        m.baseColorFactor = color;
        m.metallicFactor = 0.0f;
        m.roughnessFactor = 0.15f;
        m.clearcoatFactor = 0.5f;
        return m;
    }

    static PbrMaterial glassTinted(const Vec4& color = Vec4(0.85f, 0.92f, 0.98f, 0.25f), float roughness = 0.08f, float iorVal = 1.52f) {
        PbrMaterial m;
        m.name = "glass_tinted";
        m.baseColorFactor = color;
        m.metallicFactor = 0.0f;
        m.roughnessFactor = roughness;
        m.transmissionFactor = 0.92f;
        m.ior = iorVal;
        m.clearcoatFactor = 0.8f;
        return m;
    }

    static PbrMaterial stoneRough(const Vec4& color = Vec4(0.55f, 0.53f, 0.50f, 1.0f)) {
        PbrMaterial m;
        m.name = "stone_rough";
        m.baseColorFactor = color;
        m.metallicFactor = 0.02f;
        m.roughnessFactor = 0.85f;
        return m;
    }

    static PbrMaterial obsidian() {
        PbrMaterial m;
        m.name = "volcanic_obsidian";
        m.baseColorFactor = Vec4(0.05f, 0.05f, 0.06f, 1.0f);
        m.metallicFactor = 0.15f;
        m.roughnessFactor = 0.05f;
        m.clearcoatFactor = 0.9f;
        return m;
    }
};

struct Vertex {
    Vec3 position;
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec2 uv{0.0f, 0.0f};
    Vec4 color{1.0f, 1.0f, 1.0f, 1.0f};
    Vec4 tangent{1.0f, 0.0f, 0.0f, 1.0f};

    constexpr Vertex() = default;
    constexpr Vertex(const Vec3& p, const Vec3& n = {0, 1, 0}, const Vec2& u = {0, 0}, const Vec4& c = {1, 1, 1, 1}, const Vec4& t = {1, 0, 0, 1})
        : position(p), normal(n), uv(u), color(c), tangent(t) {}
};

class ScratchboxMesh {
public:
    std::string name{"mesh"};
    std::vector<Vertex> vertices;
    std::vector<uint32_t> indices;
    AABB bounds;
    PbrMaterial material;

    ScratchboxMesh() = default;
    explicit ScratchboxMesh(std::string meshName) : name(std::move(meshName)) {}

    void clear() {
        vertices.clear();
        indices.clear();
        bounds = AABB();
    }

    void addVertex(const Vertex& v) {
        vertices.push_back(v);
        bounds.expand(v.position);
    }

    void addTriangle(uint32_t i0, uint32_t i1, uint32_t i2) {
        indices.push_back(i0);
        indices.push_back(i1);
        indices.push_back(i2);
    }

    void append(const ScratchboxMesh& other) {
        uint32_t offset = static_cast<uint32_t>(vertices.size());
        vertices.insert(vertices.end(), other.vertices.begin(), other.vertices.end());
        indices.reserve(indices.size() + other.indices.size());
        for (uint32_t idx : other.indices) {
            indices.push_back(idx + offset);
        }
        bounds.expand(other.bounds.min);
        bounds.expand(other.bounds.max);
    }

    void recomputeNormals() {
        for (auto& v : vertices) {
            v.normal = Vec3(0, 0, 0);
        }

        for (size_t i = 0; i + 2 < indices.size(); i += 3) {
            uint32_t i0 = indices[i];
            uint32_t i1 = indices[i + 1];
            uint32_t i2 = indices[i + 2];

            Vec3 v0 = vertices[i0].position;
            Vec3 v1 = vertices[i1].position;
            Vec3 v2 = vertices[i2].position;

            Vec3 fn = (v1 - v0).cross(v2 - v0);
            vertices[i0].normal += fn;
            vertices[i1].normal += fn;
            vertices[i2].normal += fn;
        }

        for (auto& v : vertices) {
            v.normal = v.normal.normalized();
        }
    }

    void recomputeSmoothNormals() {
        for (auto& v : vertices) {
            v.normal = Vec3(0, 0, 0);
        }
        for (size_t i = 0; i + 2 < indices.size(); i += 3) {
            uint32_t i0 = indices[i];
            uint32_t i1 = indices[i + 1];
            uint32_t i2 = indices[i + 2];
            Vec3 v0 = vertices[i0].position;
            Vec3 v1 = vertices[i1].position;
            Vec3 v2 = vertices[i2].position;

            Vec3 e1 = v1 - v0;
            Vec3 e2 = v2 - v0;
            Vec3 fn = e1.cross(e2);
            float len = fn.length();
            if (len > 1e-6f) {
                fn = fn / len;
                Vec3 d01 = (v1 - v0).normalized();
                Vec3 d02 = (v2 - v0).normalized();
                Vec3 d12 = (v2 - v1).normalized();
                float a0 = std::acos(std::max(-1.0f, std::min(1.0f, d01.dot(d02))));
                float a1 = std::acos(std::max(-1.0f, std::min(1.0f, (-d01).dot(d12))));
                float a2 = std::acos(std::max(-1.0f, std::min(1.0f, (-d02).dot(-d12))));
                vertices[i0].normal += fn * a0;
                vertices[i1].normal += fn * a1;
                vertices[i2].normal += fn * a2;
            }
        }
        for (auto& v : vertices) {
            float l = v.normal.length();
            if (l > 1e-6f) v.normal = v.normal / l;
            else v.normal = Vec3(0, 1, 0);
        }
    }

    void weldVertices(float epsilon = 1e-4f) {
        if (vertices.empty()) return;
        std::vector<Vertex> uniqueVerts;
        std::vector<uint32_t> remap(vertices.size());
        
        float invCell = 1.0f / (epsilon > 1e-6f ? epsilon : 1e-4f);
        struct Key {
            int64_t x, y, z;
            bool operator==(const Key& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct KeyHash {
            size_t operator()(const Key& k) const {
                size_t h1 = std::hash<int64_t>{}(k.x);
                size_t h2 = std::hash<int64_t>{}(k.y);
                size_t h3 = std::hash<int64_t>{}(k.z);
                return h1 ^ (h2 << 1) ^ (h3 << 2);
            }
        };

        std::unordered_map<Key, uint32_t, KeyHash> grid;
        grid.reserve(vertices.size());

        for (size_t i = 0; i < vertices.size(); ++i) {
            const auto& p = vertices[i].position;
            Key key{
                static_cast<int64_t>(std::floor(p.x * invCell + 0.5f)),
                static_cast<int64_t>(std::floor(p.y * invCell + 0.5f)),
                static_cast<int64_t>(std::floor(p.z * invCell + 0.5f))
            };

            auto it = grid.find(key);
            if (it != grid.end()) {
                remap[i] = it->second;
            } else {
                uint32_t newIdx = static_cast<uint32_t>(uniqueVerts.size());
                uniqueVerts.push_back(vertices[i]);
                grid[key] = newIdx;
                remap[i] = newIdx;
            }
        }

        std::vector<uint32_t> newIndices;
        newIndices.reserve(indices.size());
        for (size_t i = 0; i + 2 < indices.size(); i += 3) {
            uint32_t i0 = remap[indices[i]];
            uint32_t i1 = remap[indices[i + 1]];
            uint32_t i2 = remap[indices[i + 2]];
            if (i0 != i1 && i1 != i2 && i0 != i2) {
                newIndices.push_back(i0);
                newIndices.push_back(i1);
                newIndices.push_back(i2);
            }
        }

        vertices = std::move(uniqueVerts);
        indices = std::move(newIndices);
        recomputeBounds();
    }

    void computeCurvatureAO(float intensity = 0.6f) {
        if (vertices.empty() || indices.empty()) return;
        std::vector<std::vector<uint32_t>> adj(vertices.size());
        for (size_t i = 0; i + 2 < indices.size(); i += 3) {
            uint32_t i0 = indices[i], i1 = indices[i+1], i2 = indices[i+2];
            adj[i0].push_back(i1); adj[i0].push_back(i2);
            adj[i1].push_back(i0); adj[i1].push_back(i2);
            adj[i2].push_back(i0); adj[i2].push_back(i1);
        }

        for (size_t i = 0; i < vertices.size(); ++i) {
            if (adj[i].empty()) continue;
            Vec3 avgNeighbor(0, 0, 0);
            for (uint32_t nIdx : adj[i]) {
                avgNeighbor += vertices[nIdx].position;
            }
            avgNeighbor = avgNeighbor * (1.0f / static_cast<float>(adj[i].size()));
            Vec3 diff = avgNeighbor - vertices[i].position;
            float concavity = diff.dot(vertices[i].normal);
            float ao = 1.0f - std::max(0.0f, std::min(0.85f, concavity * intensity * 2.5f));
            vertices[i].color.x *= ao;
            vertices[i].color.y *= ao;
            vertices[i].color.z *= ao;
        }
    }

    void applyProceduralWeathering(float frequency = 2.0f, float amplitude = 0.15f) {
        math::FastNoise3D noise(1337);
        for (auto& v : vertices) {
            float n = noise.fBm(v.position.x * frequency, v.position.y * frequency, v.position.z * frequency, 3, 0.5f, 2.0f);
            float factor = 1.0f + (n * amplitude);
            v.color.x = std::max(0.0f, std::min(1.0f, v.color.x * factor));
            v.color.y = std::max(0.0f, std::min(1.0f, v.color.y * factor));
            v.color.z = std::max(0.0f, std::min(1.0f, v.color.z * factor));
        }
    }

    void recomputeBounds() {
        bounds = AABB();
        for (const auto& v : vertices) {
            bounds.expand(v.position);
        }
    }

    void merge(const ScratchboxMesh& other) {
        uint32_t offset = static_cast<uint32_t>(vertices.size());
        vertices.insert(vertices.end(), other.vertices.begin(), other.vertices.end());
        for (uint32_t idx : other.indices) {
            indices.push_back(offset + idx);
        }
        recomputeBounds();
    }

    void translate(const Vec3& offset) {
        for (auto& v : vertices) {
            v.position += offset;
        }
        recomputeBounds();
    }

    void scale(const Vec3& factors) {
        for (auto& v : vertices) {
            v.position = Vec3(v.position.x * factors.x, v.position.y * factors.y, v.position.z * factors.z);
        }
        recomputeBounds();
    }

    void rotateX(float angleDeg) {
        float rad = angleDeg * math::DEG_TO_RAD;
        float cosA = std::cos(rad);
        float sinA = std::sin(rad);
        for (auto& v : vertices) {
            float y = v.position.y * cosA - v.position.z * sinA;
            float z = v.position.y * sinA + v.position.z * cosA;
            v.position.y = y;
            v.position.z = z;
            float ny = v.normal.y * cosA - v.normal.z * sinA;
            float nz = v.normal.y * sinA + v.normal.z * cosA;
            v.normal.y = ny;
            v.normal.z = nz;
        }
        recomputeBounds();
    }

    void rotateY(float angleDeg) {
        float rad = angleDeg * math::DEG_TO_RAD;
        float cosA = std::cos(rad);
        float sinA = std::sin(rad);
        for (auto& v : vertices) {
            float x = v.position.x * cosA - v.position.z * sinA;
            float z = v.position.x * sinA + v.position.z * cosA;
            v.position.x = x;
            v.position.z = z;
            float nx = v.normal.x * cosA - v.normal.z * sinA;
            float nz = v.normal.x * sinA + v.normal.z * cosA;
            v.normal.x = nx;
            v.normal.z = nz;
        }
        recomputeBounds();
    }

    void rotateZ(float angleDeg) {
        float rad = angleDeg * math::DEG_TO_RAD;
        float cosA = std::cos(rad);
        float sinA = std::sin(rad);
        for (auto& v : vertices) {
            float x = v.position.x * cosA - v.position.y * sinA;
            float y = v.position.x * sinA + v.position.y * cosA;
            v.position.x = x;
            v.position.y = y;
            float nx = v.normal.x * cosA - v.normal.y * sinA;
            float ny = v.normal.x * sinA + v.normal.y * cosA;
            v.normal.x = nx;
            v.normal.y = ny;
        }
        recomputeBounds();
    }

    void setColor(const Vec4& color) {
        for (auto& v : vertices) {
            v.color = color;
        }
    }

    // ========================================================================
    // Standard Geometric Primitives
    // ========================================================================
    static ScratchboxMesh createBox(const Vec3& size, const Vec4& color = {0.2f, 0.6f, 1.0f, 1.0f}) {
        ScratchboxMesh mesh("box");
        Vec3 h = size * 0.5f;

        // 6 faces * 4 vertices = 24 vertices
        auto addFace = [&](const Vec3& n, const Vec3& u, const Vec3& v) {
            uint32_t start = static_cast<uint32_t>(mesh.vertices.size());
            Vec3 center(n.x * h.x, n.y * h.y, n.z * h.z);
            Vec3 u_span(u.x * h.x, u.y * h.y, u.z * h.z);
            Vec3 v_span(v.x * h.x, v.y * h.y, v.z * h.z);

            mesh.addVertex({center - u_span - v_span, n, {0, 0}, color});
            mesh.addVertex({center + u_span - v_span, n, {1, 0}, color});
            mesh.addVertex({center + u_span + v_span, n, {1, 1}, color});
            mesh.addVertex({center - u_span + v_span, n, {0, 1}, color});

            mesh.addTriangle(start, start + 1, start + 2);
            mesh.addTriangle(start, start + 2, start + 3);
        };

        addFace({0, 0, 1}, {1, 0, 0}, {0, 1, 0});  // +Z
        addFace({0, 0, -1}, {-1, 0, 0}, {0, 1, 0}); // -Z
        addFace({1, 0, 0}, {0, 0, -1}, {0, 1, 0}); // +X
        addFace({-1, 0, 0}, {0, 0, 1}, {0, 1, 0}); // -X
        addFace({0, 1, 0}, {1, 0, 0}, {0, 0, -1}); // +Y
        addFace({0, -1, 0}, {1, 0, 0}, {0, 0, 1}); // -Y

        return mesh;
    }

    static ScratchboxMesh createBeveledBox(
        const Vec3& size,
        float bevelRadius = 0.02f,
        const Vec4& color = {0.8f, 0.8f, 0.8f, 1.0f}
    ) {
        float minDim = std::min({size.x, size.y, size.z});
        float b = std::clamp(bevelRadius, 0.0f, minDim * 0.48f);
        if (b < 1e-4f) {
            return createBox(size, color);
        }

        ScratchboxMesh mesh("beveled_box");
        Vec3 h = size * 0.5f;
        Vec3 inH(h.x - b, h.y - b, h.z - b);

        auto addQuad = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
                           const Vec3& n0, const Vec3& n1, const Vec3& n2, const Vec3& n3) {
            uint32_t start = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex({p0, n0, {0.0f, 0.0f}, color});
            mesh.addVertex({p1, n1, {1.0f, 0.0f}, color});
            mesh.addVertex({p2, n2, {1.0f, 1.0f}, color});
            mesh.addVertex({p3, n3, {0.0f, 1.0f}, color});
            mesh.addTriangle(start, start + 1, start + 2);
            mesh.addTriangle(start, start + 2, start + 3);
        };

        // 6 Primary Inset Faces
        // Top (+Y)
        addQuad({-inH.x, h.y, -inH.z}, { inH.x, h.y, -inH.z}, { inH.x, h.y,  inH.z}, {-inH.x, h.y,  inH.z},
                {0, 1, 0}, {0, 1, 0}, {0, 1, 0}, {0, 1, 0});
        // Bottom (-Y)
        addQuad({-inH.x, -h.y,  inH.z}, { inH.x, -h.y,  inH.z}, { inH.x, -h.y, -inH.z}, {-inH.x, -h.y, -inH.z},
                {0, -1, 0}, {0, -1, 0}, {0, -1, 0}, {0, -1, 0});
        // Front (+Z)
        addQuad({-inH.x, -inH.y, h.z}, { inH.x, -inH.y, h.z}, { inH.x,  inH.y, h.z}, {-inH.x,  inH.y, h.z},
                {0, 0, 1}, {0, 0, 1}, {0, 0, 1}, {0, 0, 1});
        // Back (-Z)
        addQuad({ inH.x, -inH.y, -h.z}, {-inH.x, -inH.y, -h.z}, {-inH.x,  inH.y, -h.z}, { inH.x,  inH.y, -h.z},
                {0, 0, -1}, {0, 0, -1}, {0, 0, -1}, {0, 0, -1});
        // Right (+X)
        addQuad({h.x, -inH.y,  inH.z}, {h.x, -inH.y, -inH.z}, {h.x,  inH.y, -inH.z}, {h.x,  inH.y,  inH.z},
                {1, 0, 0}, {1, 0, 0}, {1, 0, 0}, {1, 0, 0});
        // Left (-X)
        addQuad({-h.x, -inH.y, -inH.z}, {-h.x, -inH.y,  inH.z}, {-h.x,  inH.y,  inH.z}, {-h.x,  inH.y, -inH.z},
                {-1, 0, 0}, {-1, 0, 0}, {-1, 0, 0}, {-1, 0, 0});

        // 12 Edge Chamfers
        // Top 4 edges (+Y)
        Vec3 nTF = Vec3(0, 1, 1).normalized();
        addQuad({-inH.x, h.y, inH.z}, { inH.x, h.y, inH.z}, { inH.x, inH.y, h.z}, {-inH.x, inH.y, h.z},
                nTF, nTF, nTF, nTF);
        Vec3 nTB = Vec3(0, 1, -1).normalized();
        addQuad({ inH.x, h.y, -inH.z}, {-inH.x, h.y, -inH.z}, {-inH.x, inH.y, -h.z}, { inH.x, inH.y, -h.z},
                nTB, nTB, nTB, nTB);
        Vec3 nTR = Vec3(1, 1, 0).normalized();
        addQuad({inH.x, h.y, -inH.z}, {inH.x, h.y, inH.z}, {h.x, inH.y, inH.z}, {h.x, inH.y, -inH.z},
                nTR, nTR, nTR, nTR);
        Vec3 nTL = Vec3(-1, 1, 0).normalized();
        addQuad({-inH.x, h.y, inH.z}, {-inH.x, h.y, -inH.z}, {-h.x, inH.y, -inH.z}, {-h.x, inH.y, inH.z},
                nTL, nTL, nTL, nTL);

        // Bottom 4 edges (-Y)
        Vec3 nBF = Vec3(0, -1, 1).normalized();
        addQuad({ inH.x, -h.y, inH.z}, {-inH.x, -h.y, inH.z}, {-inH.x, -inH.y, h.z}, { inH.x, -inH.y, h.z},
                nBF, nBF, nBF, nBF);
        Vec3 nBB = Vec3(0, -1, -1).normalized();
        addQuad({-inH.x, -h.y, -inH.z}, { inH.x, -h.y, -inH.z}, { inH.x, -inH.y, -h.z}, {-inH.x, -inH.y, -h.z},
                nBB, nBB, nBB, nBB);
        Vec3 nBR = Vec3(1, -1, 0).normalized();
        addQuad({inH.x, -h.y, inH.z}, {inH.x, -h.y, -inH.z}, {h.x, -inH.y, -inH.z}, {h.x, -inH.y, inH.z},
                nBR, nBR, nBR, nBR);
        Vec3 nBL = Vec3(-1, -1, 0).normalized();
        addQuad({-inH.x, -h.y, -inH.z}, {-inH.x, -h.y, inH.z}, {-h.x, -inH.y, inH.z}, {-h.x, -inH.y, -h.z},
                nBL, nBL, nBL, nBL);

        // Vertical 4 edges
        Vec3 nFR = Vec3(1, 0, 1).normalized();
        addQuad({inH.x, -inH.y, h.z}, {h.x, -inH.y, inH.z}, {h.x, inH.y, inH.z}, {inH.x, inH.y, h.z},
                nFR, nFR, nFR, nFR);
        Vec3 nFL = Vec3(-1, 0, 1).normalized();
        addQuad({-h.x, -inH.y, inH.z}, {-inH.x, -inH.y, h.z}, {-inH.x, inH.y, h.z}, {-h.x, inH.y, inH.z},
                nFL, nFL, nFL, nFL);
        Vec3 nBR2 = Vec3(1, 0, -1).normalized();
        addQuad({h.x, -inH.y, -inH.z}, {inH.x, -inH.y, -h.z}, {inH.x, inH.y, -h.z}, {h.x, inH.y, -inH.z},
                nBR2, nBR2, nBR2, nBR2);
        Vec3 nBL2 = Vec3(-1, 0, -1).normalized();
        addQuad({-inH.x, -inH.y, -h.z}, {-h.x, -inH.y, -inH.z}, {-h.x, inH.y, -inH.z}, {-inH.x, inH.y, -h.z},
                nBL2, nBL2, nBL2, nBL2);

        // 8 Corner Triangles
        auto addTri = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& norm) {
            uint32_t start = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex({p0, norm, {0, 0}, color});
            mesh.addVertex({p1, norm, {1, 0}, color});
            mesh.addVertex({p2, norm, {0, 1}, color});
            mesh.addTriangle(start, start + 1, start + 2);
        };

        addTri({inH.x, h.y, inH.z}, {inH.x, inH.y, h.z}, {h.x, inH.y, inH.z}, Vec3(1, 1, 1).normalized());
        addTri({-inH.x, h.y, inH.z}, {-h.x, inH.y, inH.z}, {-inH.x, inH.y, h.z}, Vec3(-1, 1, 1).normalized());
        addTri({inH.x, h.y, -inH.z}, {h.x, inH.y, -inH.z}, {inH.x, inH.y, -h.z}, Vec3(1, 1, -1).normalized());
        addTri({-inH.x, h.y, -inH.z}, {-inH.x, inH.y, -h.z}, {-h.x, inH.y, -inH.z}, Vec3(-1, 1, -1).normalized());

        addTri({inH.x, -h.y, inH.z}, {h.x, -inH.y, inH.z}, {inH.x, -inH.y, h.z}, Vec3(1, -1, 1).normalized());
        addTri({-inH.x, -h.y, inH.z}, {-inH.x, -inH.y, h.z}, {-h.x, -inH.y, inH.z}, Vec3(-1, -1, 1).normalized());
        addTri({inH.x, -h.y, -inH.z}, {inH.x, -inH.y, -h.z}, {h.x, -inH.y, -inH.z}, Vec3(1, -1, -1).normalized());
        addTri({-inH.x, -h.y, -inH.z}, {-h.x, -inH.y, -inH.z}, {-inH.x, -inH.y, -h.z}, Vec3(-1, -1, -1).normalized());

        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createSubdividedBox(
        const Vec3& size,
        int subX = 4,
        int subY = 4,
        int subZ = 4,
        const Vec4& color = {0.8f, 0.8f, 0.8f, 1.0f}
    ) {
        ScratchboxMesh mesh("subdivided_box");
        Vec3 h = size * 0.5f;

        auto addFaceGrid = [&](const Vec3& norm, const Vec3& uDir, const Vec3& vDir,
                              float uExtent, float vExtent, float faceOffset,
                              int uSteps, int vSteps) {
            uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());
            for (int j = 0; j <= vSteps; ++j) {
                float vNorm = static_cast<float>(j) / vSteps;
                float v = (vNorm - 0.5f) * 2.0f * vExtent;
                for (int i = 0; i <= uSteps; ++i) {
                    float uNorm = static_cast<float>(i) / uSteps;
                    float u = (uNorm - 0.5f) * 2.0f * uExtent;
                    Vec3 pos = norm * faceOffset + uDir * u + vDir * v;
                    mesh.addVertex({pos, norm, {uNorm, vNorm}, color});
                }
            }
            int cols = uSteps + 1;
            for (int j = 0; j < vSteps; ++j) {
                for (int i = 0; i < uSteps; ++i) {
                    uint32_t i0 = baseIdx + j * cols + i;
                    uint32_t i1 = baseIdx + j * cols + (i + 1);
                    uint32_t i2 = baseIdx + (j + 1) * cols + (i + 1);
                    uint32_t i3 = baseIdx + (j + 1) * cols + i;
                    mesh.addTriangle(i0, i1, i2);
                    mesh.addTriangle(i0, i2, i3);
                }
            }
        };

        // +Z / -Z
        addFaceGrid({0, 0, 1}, {1, 0, 0}, {0, 1, 0}, h.x, h.y, h.z, subX, subY);
        addFaceGrid({0, 0, -1}, {-1, 0, 0}, {0, 1, 0}, h.x, h.y, h.z, subX, subY);
        // +X / -X
        addFaceGrid({1, 0, 0}, {0, 0, -1}, {0, 1, 0}, h.z, h.y, h.x, subZ, subY);
        addFaceGrid({-1, 0, 0}, {0, 0, 1}, {0, 1, 0}, h.z, h.y, h.x, subZ, subY);
        // +Y / -Y
        addFaceGrid({0, 1, 0}, {1, 0, 0}, {0, 0, -1}, h.x, h.z, h.y, subX, subZ);
        addFaceGrid({0, -1, 0}, {1, 0, 0}, {0, 0, 1}, h.x, h.z, h.y, subX, subZ);

        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createEnvelope(
        const Vec3& bounds,
        float crown = 0.25f,
        float slope = 0.3f,
        float centerDip = 0.0f,
        int gridX = 16,
        int gridZ = 16,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f}
    ) {
        ScratchboxMesh mesh("envelope");
        float w = bounds.x;
        float h = bounds.y;
        float d = bounds.z;

        gridX = std::max(gridX, 2);
        gridZ = std::max(gridZ, 2);

        for (int j = 0; j <= gridZ; ++j) {
            float v = static_cast<float>(j) / gridZ;
            float z = (v - 0.5f) * d;

            for (int i = 0; i <= gridX; ++i) {
                float u = static_cast<float>(i) / gridX;
                float x = (u - 0.5f) * w;

                float uNorm = (u - 0.5f) * 2.0f; // -1 to +1
                float crownMod = h * crown * (1.0f - uNorm * uNorm);
                float slopeMod = -h * slope * v;
                float dipMod = -h * centerDip * std::exp(-8.0f * uNorm * uNorm) * std::sin(v * PI);
                float y = h * 0.5f + crownMod + slopeMod + dipMod;

                mesh.addVertex({Vec3(x, y, z), Vec3(0, 1, 0), {u, v}, color});
            }
        }

        int cols = gridX + 1;
        for (int j = 0; j < gridZ; ++j) {
            for (int i = 0; i < gridX; ++i) {
                uint32_t i0 = j * cols + i;
                uint32_t i1 = j * cols + (i + 1);
                uint32_t i2 = (j + 1) * cols + (i + 1);
                uint32_t i3 = (j + 1) * cols + i;

                mesh.addTriangle(i0, i2, i1);
                mesh.addTriangle(i0, i3, i2);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createArchedBlister(
        const Vec3& bounds,
        float archRadius = 0.40f,
        float swell = 0.08f,
        int gridPhi = 16,
        int gridW = 8,
        float sideSign = 1.0f,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f}
    ) {
        ScratchboxMesh mesh("arched_blister");
        float w = bounds.x;
        float h = bounds.y;
        float d = bounds.z;

        for (int j = 0; j <= gridW; ++j) {
            float t = static_cast<float>(j) / gridW; // 0 (inner) to 1 (outer lip)
            for (int i = 0; i <= gridPhi; ++i) {
                float phi = (static_cast<float>(i) / gridPhi) * PI; // 0 to PI
                float z = (std::cos(phi)) * (d * 0.5f);
                float rY = archRadius * 0.7f + h * (1.0f - t * 0.4f);
                float y = std::sin(phi) * rY;

                float xBase = (t - 0.5f) * w;
                float xSwell = sideSign * swell * std::sin(phi) * (1.0f - t * t);
                float x = xBase + xSwell;

                mesh.addVertex({Vec3(x, y, z), Vec3(sideSign, 0, 0), {t, static_cast<float>(i) / gridPhi}, color});
            }
        }

        int cols = gridPhi + 1;
        for (int j = 0; j < gridW; ++j) {
            for (int i = 0; i < gridPhi; ++i) {
                uint32_t i0 = j * cols + i;
                uint32_t i1 = j * cols + (i + 1);
                uint32_t i2 = (j + 1) * cols + (i + 1);
                uint32_t i3 = (j + 1) * cols + i;

                if (sideSign >= 0.0f) {
                    mesh.addTriangle(i0, i1, i2);
                    mesh.addTriangle(i0, i2, i3);
                } else {
                    mesh.addTriangle(i0, i2, i1);
                    mesh.addTriangle(i0, i3, i2);
                }
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createSphere(float radius = 1.0f, int rings = 16, int sectors = 32, const Vec4& color = {0.9f, 0.3f, 0.3f, 1.0f}) {
        ScratchboxMesh mesh("sphere");
        float const R = 1.0f / static_cast<float>(rings - 1);
        float const S = 1.0f / static_cast<float>(sectors - 1);

        for (int r = 0; r < rings; ++r) {
            for (int s = 0; s < sectors; ++s) {
                float y = std::sin(-HALF_PI + PI * r * R);
                float x = std::cos(TWO_PI * s * S) * std::sin(PI * r * R);
                float z = std::sin(TWO_PI * s * S) * std::sin(PI * r * R);

                Vec3 norm(x, y, z);
                mesh.addVertex({norm * radius, norm, {s * S, r * R}, color});
            }
        }

        for (int r = 0; r < rings - 1; ++r) {
            for (int s = 0; s < sectors - 1; ++s) {
                uint32_t i0 = r * sectors + s;
                uint32_t i1 = r * sectors + (s + 1);
                uint32_t i2 = (r + 1) * sectors + (s + 1);
                uint32_t i3 = (r + 1) * sectors + s;

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }

        return mesh;
    }

    static ScratchboxMesh createCylinder(float radius, float height, int segments = 24, const Vec4& color = {0.3f, 0.8f, 0.4f, 1.0f}) {
        return createCylinder(radius, radius, height, segments, color);
    }

    static ScratchboxMesh createCylinder(float radiusTop = 1.0f, float radiusBottom = 1.0f, float height = 2.0f, int segments = 24, const Vec4& color = {0.3f, 0.8f, 0.4f, 1.0f}, bool capped = true) {
        ScratchboxMesh mesh("cylinder");
        float halfH = height * 0.5f;
        // Tilt side normals by the taper slope so cones and frustums shade correctly.
        float slope = height > 0.0f ? (radiusBottom - radiusTop) / height : 0.0f;

        for (int i = 0; i <= segments; ++i) {
            float u = static_cast<float>(i) / segments;
            float angle = u * TWO_PI;
            float cosA = std::cos(angle);
            float sinA = std::sin(angle);

            Vec3 topPos(cosA * radiusTop, halfH, sinA * radiusTop);
            Vec3 botPos(cosA * radiusBottom, -halfH, sinA * radiusBottom);
            Vec3 norm = Vec3(cosA, slope, sinA).normalized();

            mesh.addVertex({topPos, norm, {u, 1.0f}, color});
            mesh.addVertex({botPos, norm, {u, 0.0f}, color});
        }

        for (int i = 0; i < segments; ++i) {
            uint32_t top1 = i * 2;
            uint32_t bot1 = i * 2 + 1;
            uint32_t top2 = (i + 1) * 2;
            uint32_t bot2 = (i + 1) * 2 + 1;

            mesh.addTriangle(top1, top2, bot2);
            mesh.addTriangle(top1, bot2, bot1);
        }

        if (capped) {
            // Caps get their own vertices so the rim keeps a hard edge instead of averaged normals.
            auto addCap = [&](float radius, float y, float ny) {
                if (radius <= 1e-6f) return;
                uint32_t center = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex({Vec3(0.0f, y, 0.0f), Vec3(0.0f, ny, 0.0f), {0.5f, 0.5f}, color});
                for (int i = 0; i <= segments; ++i) {
                    float angle = static_cast<float>(i) / segments * TWO_PI;
                    float cosA = std::cos(angle);
                    float sinA = std::sin(angle);
                    mesh.addVertex({Vec3(cosA * radius, y, sinA * radius), Vec3(0.0f, ny, 0.0f), {0.5f + 0.5f * cosA, 0.5f + 0.5f * sinA}, color});
                }
                for (int i = 0; i < segments; ++i) {
                    uint32_t a = center + 1 + i;
                    uint32_t b = center + 2 + i;
                    if (ny > 0.0f) mesh.addTriangle(center, b, a);
                    else mesh.addTriangle(center, a, b);
                }
            };
            addCap(radiusTop, halfH, 1.0f);
            addCap(radiusBottom, -halfH, -1.0f);
        }

        return mesh;
    }

    static ScratchboxMesh createFlutedColumn(
        float radius = 0.45f,
        float height = 7.0f,
        int flutes = 16,
        int segments = 48,
        const Vec4& color = {0.88f, 0.85f, 0.80f, 1.0f}
    ) {
        ScratchboxMesh mesh("fluted_column");
        float plinthH = height * 0.045f;
        float plinthW = radius * 2.6f;
        float abacusH = height * 0.045f;
        float abacusW = radius * 2.5f;
        float torusH = radius * 0.22f;
        float shaftH = height - plinthH - abacusH - torusH * 2.0f;
        float yBase = 0.0f;

        // 1. Square Plinth Base Box
        ScratchboxMesh plinth = createBox(Vec3(plinthW, plinthH, plinthW), color * 0.95f);
        for (auto& v : plinth.vertices) v.position.y += plinthH * 0.5f;
        mesh.append(plinth);
        yBase += plinthH;

        // 2. Base Moulding Ring (Attic Base)
        ScratchboxMesh baseRing = createCylinder(radius * 1.22f, radius * 1.30f, torusH, segments, color * 0.98f);
        for (auto& v : baseRing.vertices) v.position.y += yBase + torusH * 0.5f;
        mesh.append(baseRing);
        yBase += torusH;

        // 3. Fluted Shaft with Classical Entasis
        int vertRings = 16;
        float shaftBotY = yBase;
        float shaftTopY = shaftBotY + shaftH;
        uint32_t shaftBaseIdx = static_cast<uint32_t>(mesh.vertices.size());

        for (int r = 0; r <= vertRings; ++r) {
            float vNorm = static_cast<float>(r) / static_cast<float>(vertRings);
            float y = shaftBotY + vNorm * shaftH;

            // Classical Entasis: subtle taper from base to neck
            float entasis = 1.0f - 0.14f * std::pow(vNorm, 1.6f);
            float rEff = radius * entasis;

            for (int s = 0; s <= segments; ++s) {
                float u = static_cast<float>(s) / static_cast<float>(segments);
                float angle = u * TWO_PI;

                // Fluting modulation: sinusoidal concave flutes
                float fluteDepth = 0.045f * rEff;
                float fluteMod = -fluteDepth * std::cos(static_cast<float>(flutes) * angle);
                float rFinal = rEff + fluteMod;

                float cosA = std::cos(angle);
                float sinA = std::sin(angle);
                Vec3 pos(cosA * rFinal, y, sinA * rFinal);

                Vec3 norm(cosA, 0.0f, sinA);
                mesh.addVertex(Vertex(pos, norm.normalized(), Vec2(u, vNorm), color));
            }
        }

        // Connect shaft quads
        int segStride = segments + 1;
        for (int r = 0; r < vertRings; ++r) {
            for (int s = 0; s < segments; ++s) {
                uint32_t i0 = shaftBaseIdx + r * segStride + s;
                uint32_t i1 = shaftBaseIdx + r * segStride + (s + 1);
                uint32_t i2 = shaftBaseIdx + (r + 1) * segStride + (s + 1);
                uint32_t i3 = shaftBaseIdx + (r + 1) * segStride + s;

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }

        yBase = shaftTopY;

        // 4. Neck Capital Moulding Ring (Echinus)
        ScratchboxMesh capRing = createCylinder(radius * 1.25f, radius * 0.90f, torusH, segments, color * 1.02f);
        for (auto& v : capRing.vertices) v.position.y += yBase + torusH * 0.5f;
        mesh.append(capRing);
        yBase += torusH;

        // 5. Square Abacus Cap Box
        ScratchboxMesh abacus = createBox(Vec3(abacusW, abacusH, abacusW), color);
        for (auto& v : abacus.vertices) v.position.y += yBase + abacusH * 0.5f;
        mesh.append(abacus);

        return mesh;
    }
};

// ============================================================================
// Isosurface Extraction (Marching Tetrahedra)
// ============================================================================
/**
 * Marching tetrahedra over a regular grid. Every cell is split into the same six tetrahedra around
 * its main diagonal, so neighbouring cells triangulate their shared faces identically and a
 * tetrahedron has no ambiguous cases: the surface comes out as a closed 2-manifold wherever it stays
 * inside the sampled volume (closeAtBounds treats the volume's outer layer as outside, capping
 * anything the volume cuts). Vertices lie on grid edges, shared through an edge key, and are then
 * nudged onto the isosurface along the field gradient (at most half a cell). Faces wind so their
 * normals point from inside (field < iso) to outside; vertex normals are the field gradient.
 */
class IsosurfaceExtractor {
public:
    using ScalarField3D = std::function<float(const Vec3&)>;

    static ScratchboxMesh extract(
        const ScalarField3D& field,
        const AABB& bounds,
        int nx, int ny, int nz,
        float isoLevel = 0.0f,
        int projectionSteps = 2,
        bool closeAtBounds = true,
        const Vec4& color = {0.8f, 0.8f, 0.8f, 1.0f},
        const std::string& name = "isosurface"
    ) {
        ScratchboxMesh mesh(name);
        nx = std::max(1, nx); ny = std::max(1, ny); nz = std::max(1, nz);
        const Vec3 size = bounds.max - bounds.min;
        const Vec3 cell(size.x / nx, size.y / ny, size.z / nz);
        const int px = nx + 1, py = ny + 1, pz = nz + 1;
        auto pointIndex = [&](int i, int j, int k) { return (static_cast<uint64_t>(k) * py + j) * px + i; };
        auto gridPoint = [&](int i, int j, int k) { return bounds.min + Vec3(i * cell.x, j * cell.y, k * cell.z); };

        // 1. Sample the field at every grid point, in parallel z-slices.
        std::vector<float> value(static_cast<size_t>(px) * py * pz);
        const float outside = std::max({cell.x, cell.y, cell.z}) * 0.5f;
        {
            int threads = std::max(1, std::min(pz, static_cast<int>(std::thread::hardware_concurrency())));
            std::vector<std::thread> pool;
            for (int t = 0; t < threads; ++t) {
                pool.emplace_back([&, t] {
                    for (int k = t; k < pz; k += threads) {
                        for (int j = 0; j < py; ++j) {
                            for (int i = 0; i < px; ++i) {
                                float v = field(gridPoint(i, j, k)) - isoLevel;
                                bool boundary = i == 0 || j == 0 || k == 0 || i == nx || j == ny || k == nz;
                                if (closeAtBounds && boundary) v = std::max(v, outside);
                                value[pointIndex(i, j, k)] = v;
                            }
                        }
                    }
                });
            }
            for (auto& th : pool) th.join();
        }
        auto inside = [](float v) { return v < 0.0f; };

        auto gradient = [&](const Vec3& p) {
            Vec3 e(cell.x * 0.25f, cell.y * 0.25f, cell.z * 0.25f);
            return Vec3((field(p + Vec3(e.x, 0, 0)) - field(p - Vec3(e.x, 0, 0))) / (2.0f * e.x),
                        (field(p + Vec3(0, e.y, 0)) - field(p - Vec3(0, e.y, 0))) / (2.0f * e.y),
                        (field(p + Vec3(0, 0, e.z)) - field(p - Vec3(0, 0, e.z))) / (2.0f * e.z));
        };

        // 2. Six tetrahedra per cell (Kuhn split along the 0-7 diagonal); corner bit 1 = +x, 2 = +y, 4 = +z.
        static const int tets[6][4] = { {0,1,3,7},{0,1,5,7},{0,2,3,7},{0,2,6,7},{0,4,5,7},{0,4,6,7} };
        std::unordered_map<uint64_t, uint32_t> edgeVertex;
        const float maxShift = std::min({cell.x, cell.y, cell.z}) * 0.5f;
        auto vertexOnEdge = [&](uint64_t ia, uint64_t ib, const Vec3& pa, const Vec3& pb, float va, float vb) {
            uint64_t lo = std::min(ia, ib), hi = std::max(ia, ib);
            uint64_t key = lo * 8 + (hi - lo == 1 ? 0 : hi - lo == static_cast<uint64_t>(px) ? 1
                         : hi - lo == static_cast<uint64_t>(px) * py ? 2 : hi - lo == static_cast<uint64_t>(px) + 1 ? 3
                         : hi - lo == static_cast<uint64_t>(px) * py + 1 ? 4 : hi - lo == static_cast<uint64_t>(px) * py + px ? 5 : 6);
            auto it = edgeVertex.find(key);
            if (it != edgeVertex.end()) return it->second;
            // Kept off the grid points, where several edges' crossings would otherwise coincide.
            float t = std::clamp(va / (va - vb), 0.02f, 0.98f);
            Vec3 p = pa + (pb - pa) * t, start = p;
            for (int s = 0; s < projectionSteps; ++s) {
                Vec3 g = gradient(p);
                float g2 = g.dot(g);
                if (g2 < 1e-12f) break;
                Vec3 next = p - g * ((field(p) - isoLevel) / g2);
                Vec3 shift = next - start;
                float len = shift.length();
                p = len > maxShift ? start + shift * (maxShift / len) : next;
            }
            uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex(Vertex(p, gradient(p).normalized(), Vec2(0, 0), color));
            edgeVertex.emplace(key, idx);
            return idx;
        };

        for (int k = 0; k < nz; ++k) {
            for (int j = 0; j < ny; ++j) {
                for (int i = 0; i < nx; ++i) {
                    uint64_t ci[8]; Vec3 cp[8]; float cv[8];
                    int insideCount = 0;
                    for (int c = 0; c < 8; ++c) {
                        int di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
                        ci[c] = pointIndex(i + di, j + dj, k + dk);
                        cp[c] = gridPoint(i + di, j + dj, k + dk);
                        cv[c] = value[ci[c]];
                        if (inside(cv[c])) ++insideCount;
                    }
                    if (insideCount == 0 || insideCount == 8) continue;
                    for (const auto& tet : tets) {
                        int in[4], out[4], nIn = 0, nOut = 0;
                        for (int c : tet) (inside(cv[c]) ? in[nIn++] : out[nOut++]) = c;
                        if (nIn == 0 || nOut == 0) continue;
                        Vec3 cIn(0, 0, 0), cOut(0, 0, 0);
                        for (int a = 0; a < nIn; ++a) cIn += cp[in[a]];
                        for (int a = 0; a < nOut; ++a) cOut += cp[out[a]];
                        Vec3 outward = cOut / static_cast<float>(nOut) - cIn / static_cast<float>(nIn);
                        auto v = [&](int a, int b) { return vertexOnEdge(ci[a], ci[b], cp[a], cp[b], cv[a], cv[b]); };
                        auto tri = [&](uint32_t x, uint32_t y, uint32_t z) {
                            Vec3 n = (mesh.vertices[y].position - mesh.vertices[x].position).cross(mesh.vertices[z].position - mesh.vertices[x].position);
                            if (n.dot(outward) >= 0.0f) mesh.addTriangle(x, y, z);
                            else mesh.addTriangle(x, z, y);
                        };
                        if (nIn == 1) {
                            tri(v(in[0], out[0]), v(in[0], out[1]), v(in[0], out[2]));
                        } else if (nOut == 1) {
                            tri(v(out[0], in[0]), v(out[0], in[1]), v(out[0], in[2]));
                        } else {
                            // Two in, two out: the four crossings form a quad around the tetrahedron.
                            uint32_t a = v(in[0], out[0]), b = v(in[0], out[1]), c = v(in[1], out[1]), d = v(in[1], out[0]);
                            tri(a, b, c);
                            tri(a, c, d);
                        }
                    }
                }
            }
        }
        mesh.recomputeBounds();
        return mesh;
    }
};

// Kept for existing callers: extracts the isosurface at `resolution` cells along every axis.
class MarchingCubes {
public:
    using ScalarField3D = std::function<float(const Vec3&)>;

    static ScratchboxMesh polygonize(
        const ScalarField3D& field,
        const AABB& volumeBounds,
        int resolution = 32,
        float isoLevel = 0.0f,
        const Vec4& color = {0.7f, 0.8f, 0.9f, 1.0f}
    ) {
        return extractIsosurface(field, volumeBounds, resolution, isoLevel, color);
    }

    static ScratchboxMesh extractIsosurface(
        const ScalarField3D& field,
        const AABB& volumeBounds,
        int resolution = 32,
        float isoLevel = 0.0f,
        const Vec4& color = {0.7f, 0.8f, 0.9f, 1.0f}
    ) {
        return IsosurfaceExtractor::extract(field, volumeBounds, resolution, resolution, resolution, isoLevel, 2, true, color, "isosurface_mesh");
    }
};

// ============================================================================
// Splines & Extrusions (Cubic Bezier, Catmull-Rom)
// ============================================================================
class Spline3D {
public:
    std::vector<Vec3> points;

    Spline3D() = default;
    Spline3D(const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3) {
        points = {p0, p1, p2, p3};
    }

    ScratchboxMesh extrudeTube(float radius = 0.5f, int curveSegments = 64, int radialSegments = 12, const Vec4& color = {0.8f, 0.7f, 0.2f, 1.0f}) const {
        return extrudeTubeAlongSpline(points, radius, radialSegments, curveSegments, color);
    }

    static Vec3 evaluateCubicBezier(const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3, float t) {
        float u = 1.0f - t;
        float tt = t * t;
        float uu = u * u;
        float uuu = uu * u;
        float ttt = tt * t;

        return p0 * uuu + p1 * (3.0f * uu * t) + p2 * (3.0f * u * tt) + p3 * ttt;
    }

    static ScratchboxMesh extrudeTubeAlongSpline(
        const std::vector<Vec3>& controlPoints,
        float radius = 0.5f,
        int radialSegments = 12,
        int curveSegments = 64,
        const Vec4& color = {0.8f, 0.7f, 0.2f, 1.0f}
    ) {
        ScratchboxMesh mesh("spline_tube");
        if (controlPoints.size() < 4) return mesh;

        std::vector<Vec3> spine;
        for (int i = 0; i <= curveSegments; ++i) {
            float t = static_cast<float>(i) / curveSegments;
            spine.push_back(evaluateCubicBezier(controlPoints[0], controlPoints[1], controlPoints[2], controlPoints[3], t));
        }

        for (size_t s = 0; s < spine.size(); ++s) {
            Vec3 pos = spine[s];
            Vec3 forward = (s + 1 < spine.size()) ? (spine[s + 1] - pos).normalized() : (pos - spine[s - 1]).normalized();
            Vec3 up = std::abs(forward.y) < 0.9f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Vec3 right = forward.cross(up).normalized();
            up = right.cross(forward).normalized();

            for (int r = 0; r < radialSegments; ++r) {
                float angle = (static_cast<float>(r) / radialSegments) * TWO_PI;
                Vec3 offset = right * (std::cos(angle) * radius) + up * (std::sin(angle) * radius);
                Vec3 norm = offset.normalized();
                mesh.addVertex({pos + offset, norm, {static_cast<float>(r) / radialSegments, static_cast<float>(s) / spine.size()}, color});
            }
        }

        for (size_t s = 0; s + 1 < spine.size(); ++s) {
            for (int r = 0; r < radialSegments; ++r) {
                int nextR = (r + 1) % radialSegments;
                uint32_t i0 = static_cast<uint32_t>(s * radialSegments + r);
                uint32_t i1 = static_cast<uint32_t>((s + 1) * radialSegments + r);
                uint32_t i2 = static_cast<uint32_t>((s + 1) * radialSegments + nextR);
                uint32_t i3 = static_cast<uint32_t>(s * radialSegments + nextR);

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }

        mesh.recomputeBounds();
        return mesh;
    }
};

/**
 * Structure-of-Arrays (SoA) Mesh representation for high-throughput procedural generators
 * (vegetation, terrain, triplanar baking, SSS estimation).
 */
struct Mesh {
    std::string name{"mesh"};
    std::vector<Vec3> vertices;
    std::vector<Vec3> normals;
    std::vector<Vec2> uvs;
    std::vector<Vec4> vertexColors;
    std::vector<uint32_t> indices;
    AABB bounds;
    PbrMaterial material;

    Mesh() = default;
    explicit Mesh(std::string meshName) : name(std::move(meshName)) {}

    void clear() {
        vertices.clear();
        normals.clear();
        uvs.clear();
        vertexColors.clear();
        indices.clear();
        bounds = AABB();
    }

    ScratchboxMesh toScratchboxMesh() const {
        ScratchboxMesh sm(name);
        sm.material = material;
        sm.bounds = bounds;
        sm.indices = indices;
        sm.vertices.resize(vertices.size());
        for (size_t i = 0; i < vertices.size(); ++i) {
            Vec3 p = vertices[i];
            Vec3 n = (i < normals.size()) ? normals[i] : Vec3(0, 1, 0);
            Vec2 uv = (i < uvs.size()) ? uvs[i] : Vec2(0, 0);
            Vec4 c = (i < vertexColors.size()) ? vertexColors[i] : Vec4(1, 1, 1, 1);
            sm.vertices[i] = Vertex(p, n, uv, c);
        }
        sm.recomputeBounds();
        return sm;
    }

    static Mesh fromScratchboxMesh(const ScratchboxMesh& sm) {
        Mesh m(sm.name);
        m.material = sm.material;
        m.bounds = sm.bounds;
        m.indices = sm.indices;
        m.vertices.reserve(sm.vertices.size());
        m.normals.reserve(sm.vertices.size());
        m.uvs.reserve(sm.vertices.size());
        m.vertexColors.reserve(sm.vertices.size());
        for (const auto& v : sm.vertices) {
            m.vertices.push_back(v.position);
            m.normals.push_back(v.normal);
            m.uvs.push_back(v.uv);
            m.vertexColors.push_back(v.color);
        }
        return m;
    }
};

struct GeometryBuilder {
    static ScratchboxMesh createPlane(float width = 2.0f, float height = 2.0f, int segX = 4, int segY = 4) {
        ScratchboxMesh mesh("plane");
        for (int y = 0; y <= segY; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(segY);
            float py = (v - 0.5f) * height;
            for (int x = 0; x <= segX; ++x) {
                float u = static_cast<float>(x) / static_cast<float>(segX);
                float px = (u - 0.5f) * width;
                mesh.addVertex(Vertex(
                    Vec3(px, 0.0f, py),
                    Vec3(0, 1, 0),
                    Vec2(u, v),
                    Vec4(1, 1, 1, 1)
                ));
            }
        }
        for (int y = 0; y < segY; ++y) {
            for (int x = 0; x < segX; ++x) {
                uint32_t i0 = y * (segX + 1) + x;
                uint32_t i1 = i0 + 1;
                uint32_t i2 = (y + 1) * (segX + 1) + x;
                uint32_t i3 = i2 + 1;
                mesh.addTriangle(i0, i2, i1);
                mesh.addTriangle(i1, i2, i3);
            }
        }
        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createSphere(float radius = 1.0f, int rings = 12, int sectors = 16) {
        ScratchboxMesh mesh("sphere");
        for (int r = 0; r <= rings; ++r) {
            float theta = static_cast<float>(r) * 3.14159265f / static_cast<float>(rings);
            float sinTheta = std::sin(theta);
            float cosTheta = std::cos(theta);

            for (int s = 0; s <= sectors; ++s) {
                float phi = static_cast<float>(s) * 2.0f * 3.14159265f / static_cast<float>(sectors);
                float sinPhi = std::sin(phi);
                float cosPhi = std::cos(phi);

                Vec3 norm(cosPhi * sinTheta, cosTheta, sinPhi * sinTheta);
                Vec3 pos = norm * radius;
                Vec2 uv(static_cast<float>(s) / static_cast<float>(sectors), static_cast<float>(r) / static_cast<float>(rings));

                mesh.addVertex(Vertex(pos, norm, uv, Vec4(1, 1, 1, 1)));
            }
        }

        for (int r = 0; r < rings; ++r) {
            for (int s = 0; s < sectors; ++s) {
                uint32_t first = r * (sectors + 1) + s;
                uint32_t second = first + sectors + 1;

                mesh.addTriangle(first, second, first + 1);
                mesh.addTriangle(second, second + 1, first + 1);
            }
        }
        mesh.weldVertices(1e-4f);
        mesh.recomputeBounds();
        return mesh;
    }
};

} // namespace geometry
} // namespace scratchbox

#endif // SCRATCHBOX_GEOMETRY_HPP
