/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FOOTPRINTS_HPP
#define SCRATCHBOX_FOOTPRINTS_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <numeric>

namespace scratchbox {
namespace footprints {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

class PolygonTriangulator {
public:
    static float signedArea(const std::vector<Vec2>& poly) {
        if (poly.size() < 3) return 0.0f;
        float area = 0.0f;
        for (size_t i = 0; i < poly.size(); ++i) {
            size_t j = (i + 1) % poly.size();
            area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
        }
        return area * 0.5f;
    }

    static bool isPointInTriangle(const Vec2& p, const Vec2& a, const Vec2& b, const Vec2& c) {
        auto cross2d = [](const Vec2& v1, const Vec2& v2) {
            return v1.x * v2.y - v1.y * v2.x;
        };

        float c1 = cross2d(b - a, p - a);
        float c2 = cross2d(c - b, p - b);
        float c3 = cross2d(a - c, p - c);

        bool hasNeg = (c1 < 0) || (c2 < 0) || (c3 < 0);
        bool hasPos = (c1 > 0) || (c2 > 0) || (c3 > 0);

        return !(hasNeg && hasPos);
    }

    /**
     * Ear-clipping triangulation for simple polygons.
     * Returns triangle indices pointing into the input polygon.
     */
    static std::vector<uint32_t> triangulate(const std::vector<Vec2>& rawPoly) {
        std::vector<uint32_t> indices;
        if (rawPoly.size() < 3) return indices;

        std::vector<Vec2> poly = rawPoly;
        std::vector<uint32_t> V(poly.size());
        std::iota(V.begin(), V.end(), 0);

        // Ensure CCW orientation
        if (signedArea(poly) < 0.0f) {
            std::reverse(V.begin(), V.end());
            std::reverse(poly.begin(), poly.end());
        }

        int n = static_cast<int>(poly.size());
        int count = 2 * n;

        for (int v = n - 1; n > 2;) {
            if ((count--) <= 0) {
                // Polygon is degenerate/self-intersecting; fallback fan
                for (int i = 1; i < n - 1; ++i) {
                    indices.push_back(V[0]);
                    indices.push_back(V[i]);
                    indices.push_back(V[i + 1]);
                }
                break;
            }

            int u = v;
            if (n <= u) u = 0;
            v = u + 1;
            if (n <= v) v = 0;
            int w = v + 1;
            if (n <= w) w = 0;

            const Vec2& A = poly[u];
            const Vec2& B = poly[v];
            const Vec2& C = poly[w];

            // Check if vertex is convex
            float cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
            if (cross <= 1e-6f) continue;

            // Check if any other point is inside this ear
            bool isEar = true;
            for (int p = 0; p < n; ++p) {
                if (p == u || p == v || p == w) continue;
                if (isPointInTriangle(poly[p], A, B, C)) {
                    isEar = false;
                    break;
                }
            }

            if (isEar) {
                indices.push_back(V[u]);
                indices.push_back(V[v]);
                indices.push_back(V[w]);

                poly.erase(poly.begin() + v);
                V.erase(V.begin() + v);
                n--;
                count = 2 * n;
            }
        }

        return indices;
    }
};

class BuildingMassingGenerator {
public:
    /**
     * Extrude a 2D footprint polygon into a 3D building prism with vertical walls and a flat roof.
     */
    static ScratchboxMesh extrudeSinglePrism(
        const std::vector<Vec2>& footprint,
        float baseY,
        float height,
        const PbrMaterial& mat = PbrMaterial(),
        float floorHeight = 3.5f
    ) {
        ScratchboxMesh mesh("building_prism");
        mesh.material = mat;

        if (footprint.size() < 3) return mesh;

        float topY = baseY + height;
        size_t n = footprint.size();

        // 1. Build Walls
        float uCoord = 0.0f;
        for (size_t i = 0; i < n; ++i) {
            size_t next = (i + 1) % n;
            Vec2 p0 = footprint[i];
            Vec2 p1 = footprint[next];

            Vec2 seg = p1 - p0;
            float segLen = seg.length();
            if (segLen < 1e-4f) continue;

            // Outward normal in XZ plane
            Vec3 wallNormal(seg.y / segLen, 0.0f, -seg.x / segLen);
            Vec4 tangent(seg.x / segLen, 0.0f, seg.y / segLen, 1.0f);

            uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

            float u0 = uCoord;
            float u1 = uCoord + segLen;
            uCoord = u1;

            float v0 = 0.0f;
            float v1 = height / floorHeight;

            // Quad: p0_bottom, p1_bottom, p1_top, p0_top
            mesh.vertices.push_back(Vertex(Vec3(p0.x, baseY, p0.y), wallNormal, Vec2(u0, v0), Vec4(1, 1, 1, 1), tangent));
            mesh.vertices.push_back(Vertex(Vec3(p1.x, baseY, p1.y), wallNormal, Vec2(u1, v0), Vec4(1, 1, 1, 1), tangent));
            mesh.vertices.push_back(Vertex(Vec3(p1.x, topY, p1.y), wallNormal, Vec2(u1, v1), Vec4(1, 1, 1, 1), tangent));
            mesh.vertices.push_back(Vertex(Vec3(p0.x, topY, p0.y), wallNormal, Vec2(u0, v1), Vec4(1, 1, 1, 1), tangent));

            mesh.indices.push_back(baseIdx + 0);
            mesh.indices.push_back(baseIdx + 1);
            mesh.indices.push_back(baseIdx + 2);

            mesh.indices.push_back(baseIdx + 0);
            mesh.indices.push_back(baseIdx + 2);
            mesh.indices.push_back(baseIdx + 3);
        }

        // 2. Build Roof
        uint32_t roofStartIdx = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 roofNormal(0.0f, 1.0f, 0.0f);
        Vec4 roofTangent(1.0f, 0.0f, 0.0f, 1.0f);

        for (size_t i = 0; i < n; ++i) {
            Vec2 p = footprint[i];
            mesh.vertices.push_back(Vertex(
                Vec3(p.x, topY, p.y),
                roofNormal,
                Vec2(p.x * 0.1f, p.y * 0.1f),
                Vec4(0.9f, 0.9f, 0.95f, 1.0f),
                roofTangent
            ));
        }

        std::vector<uint32_t> roofTriangles = PolygonTriangulator::triangulate(footprint);
        for (uint32_t idx : roofTriangles) {
            mesh.indices.push_back(roofStartIdx + idx);
        }

        // 3. Compute AABB bounds
        for (const auto& v : mesh.vertices) {
            mesh.bounds.expand(v.position);
        }

        return mesh;
    }

    /**
     * Extrude a multi-tier stepped massing (podium + setback tower).
     */
    static ScratchboxMesh extrudeSteppedMassing(
        const std::vector<Vec2>& footprint,
        float baseY,
        float podiumHeight,
        float towerHeight,
        float towerInset = 0.75f,
        const PbrMaterial& mat = PbrMaterial()
    ) {
        // 1. Generate Podium
        ScratchboxMesh podium = extrudeSinglePrism(footprint, baseY, podiumHeight, mat);

        // 2. Inset Footprint around Centroid for Tower
        Vec2 centroid(0.0f, 0.0f);
        for (const auto& p : footprint) {
            centroid.x += p.x;
            centroid.y += p.y;
        }
        centroid = centroid / static_cast<float>(footprint.size());

        std::vector<Vec2> towerFootprint;
        towerFootprint.reserve(footprint.size());
        for (const auto& p : footprint) {
            towerFootprint.push_back(centroid + (p - centroid) * towerInset);
        }

        // 3. Generate Tower
        ScratchboxMesh tower = extrudeSinglePrism(towerFootprint, baseY + podiumHeight, towerHeight - podiumHeight, mat);

        // 4. Merge into unified mesh
        ScratchboxMesh result("stepped_tower");
        result.material = mat;
        result.vertices = podium.vertices;
        result.indices = podium.indices;

        uint32_t offset = static_cast<uint32_t>(result.vertices.size());
        for (const auto& v : tower.vertices) {
            result.vertices.push_back(v);
        }
        for (uint32_t idx : tower.indices) {
            result.indices.push_back(offset + idx);
        }

        result.bounds = podium.bounds;
        result.bounds.expand(tower.bounds.min);
        result.bounds.expand(tower.bounds.max);

        return result;
    }

    /**
     * Serialize generated building mesh directly to glTF 2.0 binary (.glb).
     */
    static std::vector<uint8_t> serializeToGlb(const ScratchboxMesh& mesh) {
        return io::GlbWriter::writeGlb(mesh);
    }
};

} // namespace footprints
} // namespace scratchbox

#endif // SCRATCHBOX_FOOTPRINTS_HPP
