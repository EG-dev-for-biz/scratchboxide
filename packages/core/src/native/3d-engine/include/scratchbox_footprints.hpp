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

/**
 * Extrudes an arbitrary 2D polygon (XZ footprint, CCW or CW — PolygonTriangulator::triangulate corrects winding)
 * straight up by height along +Y into a closed, capped solid: side walls plus a top AND a bottom cap, so the result
 * is a valid standalone CSG operand (BuildingMassingGenerator::extrudeSinglePrism caps only the top, since a
 * building's underside is never seen once it is placed — this is the general-purpose primitive, not tied to that
 * assumption).
 */
inline ScratchboxMesh extrudePolygon(const std::vector<Vec2>& footprint, float baseY, float height, const Vec4& color = Vec4(0.8f, 0.8f, 0.8f, 1.0f)) {
    ScratchboxMesh mesh("extruded_polygon");
    if (footprint.size() < 3) return mesh;
    const float topY = baseY + height;
    const size_t n = footprint.size();

    // Face names (scratchbox_named_topology.hpp): the caps "top" and "bottom"; the walls "side", one surface per run
    // of segments that turns by less than 30 degrees at each joint, so a polygonal circle's wall is one smooth surface
    // (no "side" edges on it) and a rectangle's four walls meet at four "side" edges.
    std::vector<int32_t> wallSurface(n, -1);
    {
        int32_t surface = -1;
        size_t first = n;
        // start where a sharp joint is, so a run never wraps across the starting segment
        auto dirOf = [&](size_t i) { return (footprint[(i + 1) % n] - footprint[i]); };
        auto sharpAt = [&](size_t i) {   // the joint at the start of segment i
            const Vec2 a = dirOf((i + n - 1) % n), b = dirOf(i);
            const float la = a.length(), lb = b.length();
            if (la < 1e-4f || lb < 1e-4f) return false;
            return (a.x * b.x + a.y * b.y) / (la * lb) < std::cos(30.0f * 3.14159265358979f / 180.0f);
        };
        for (size_t i = 0; i < n && first == n; ++i) if (sharpAt(i)) first = i;
        if (first == n) first = 0;
        for (size_t k = 0; k < n; ++k) {
            const size_t i = (first + k) % n;
            if (surface < 0 || sharpAt(i)) {
                surface = static_cast<int32_t>(mesh.faceGroups.size());
                mesh.faceGroups.push_back({{"side"}, "side", false});
            }
            wallSurface[i] = surface;
        }
    }
    const int32_t topGroup = static_cast<int32_t>(mesh.faceGroups.size());
    mesh.faceGroups.push_back({{"top"}, "side", false});
    mesh.faceGroups.push_back({{"bottom"}, "side", false});

    // Side walls
    float uCoord = 0.0f;
    for (size_t i = 0; i < n; ++i) {
        const Vec2 p0 = footprint[i], p1 = footprint[(i + 1) % n];
        const Vec2 seg = p1 - p0;
        const float segLen = seg.length();
        if (segLen < 1e-4f) continue;
        mesh.faceGroup.push_back(wallSurface[i]);
        mesh.faceGroup.push_back(wallSurface[i]);
        const Vec3 wallNormal(seg.y / segLen, 0.0f, -seg.x / segLen);
        const Vec4 tangent(seg.x / segLen, 0.0f, seg.y / segLen, 1.0f);
        const uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        const float u0 = uCoord, u1 = uCoord + segLen;
        uCoord = u1;
        mesh.vertices.push_back(Vertex(Vec3(p0.x, baseY, p0.y), wallNormal, Vec2(u0, 0.0f), color, tangent));
        mesh.vertices.push_back(Vertex(Vec3(p1.x, baseY, p1.y), wallNormal, Vec2(u1, 0.0f), color, tangent));
        mesh.vertices.push_back(Vertex(Vec3(p1.x, topY, p1.y), wallNormal, Vec2(u1, 1.0f), color, tangent));
        mesh.vertices.push_back(Vertex(Vec3(p0.x, topY, p0.y), wallNormal, Vec2(u0, 1.0f), color, tangent));
        // CCW from outside (so meshToPolygons' Newell-derived plane normal, not just this quad's stored shading
        // normal, actually faces out -- verified against a BSP boolean operand, where only the index winding matters):
        mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 2); mesh.indices.push_back(base + 1);
        mesh.indices.push_back(base + 0); mesh.indices.push_back(base + 3); mesh.indices.push_back(base + 2);
    }

    const std::vector<uint32_t> capTris = PolygonTriangulator::triangulate(footprint);

    // Top cap, index winding verified against a BSP boolean operand (meshToPolygons/Newell), not assumed from the
    // triangulator's own "CCW" doc comment, which -- same mismatch as the walls above -- pointed the wrong way here.
    {
        const uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        const Vec4 tangent(1.0f, 0.0f, 0.0f, 1.0f);
        for (const auto& p : footprint) mesh.vertices.push_back(Vertex(Vec3(p.x, topY, p.y), Vec3(0, 1, 0), Vec2(p.x, p.y), color, tangent));
        for (size_t i = 0; i + 2 < capTris.size(); i += 3) {
            mesh.indices.push_back(base + capTris[i]); mesh.indices.push_back(base + capTris[i + 2]); mesh.indices.push_back(base + capTris[i + 1]);
            mesh.faceGroup.push_back(topGroup);
        }
    }
    // Bottom cap: the triangulator's own order, which after the swap above is this cap's correct (-Y-facing) winding.
    {
        const uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        const Vec4 tangent(1.0f, 0.0f, 0.0f, 1.0f);
        for (const auto& p : footprint) mesh.vertices.push_back(Vertex(Vec3(p.x, baseY, p.y), Vec3(0, -1, 0), Vec2(p.x, p.y), color, tangent));
        for (uint32_t idx : capTris) mesh.indices.push_back(base + idx);
        mesh.faceGroup.insert(mesh.faceGroup.end(), capTris.size() / 3, topGroup + 1);
    }

    for (const auto& v : mesh.vertices) mesh.bounds.expand(v.position);
    return mesh;
}

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
