/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * U.S. PATENT APPLICATION NO. 64/168,583 (PATENT PENDING)
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC and Elias John Green. Unauthorized copying, modification,
 * distribution, or use of this file, via any medium, is strictly prohibited
 * without explicit written permission.
 ********************************************************************************/

#ifndef SCRATCHBOX_UTDRA_HPP
#define SCRATCHBOX_UTDRA_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_geospatial.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_texture_inducer.hpp"
#include "scratchbox_pbr_50_library.hpp"
#include "scratchbox_tile_abstractor.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <iostream>
#include <iomanip>
#include <sstream>

namespace scratchbox {
namespace utdra {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::AABB;
using geospatial::wgs84::GeodeticCoord;

// ============================================================================
// 1. Tile Measurements
// ============================================================================
//
// What a tile measures, and nothing else: no domain is inferred and no confidence is reported. Fractions are by
// surface area, from each triangle's face normal. The caller (or the model reading the numbers) interprets them.

struct TileMeasurements {
    AABB bounds;
    float reliefMeters{0.0f};          // maxY - minY
    double surfaceArea{0.0};           // total triangle area, square metres
    float horizontalFraction{0.0f};    // slope < 15 degrees
    float inclinedFraction{0.0f};      // 15 to 45 degrees
    float steepFraction{0.0f};         // 45 to 75 degrees
    float verticalFraction{0.0f};      // 75 degrees and steeper
    float greenIndex{0.0f};            // area-weighted mean (2G - R - B) / (2G + R + B) of the vertex colours
    bool hasWalls{false};
    float dominantWallYawDeg{0.0f};    // peak of the vertical faces' horizontal normal angle, modulo 90, 1-degree bins
    size_t triangles{0};
    size_t degenerateTriangles{0};     // zero-area triangles (not counted in the fractions)
};

class TileMeasurer {
public:
    static TileMeasurements measure(const ScratchboxMesh& mesh) {
        TileMeasurements m;
        for (const auto& v : mesh.vertices) m.bounds.expand(v.position);
        if (!mesh.vertices.empty()) m.reliefMeters = m.bounds.max.y - m.bounds.min.y;

        const size_t numTriangles = mesh.indices.size() / 3;
        m.triangles = numTriangles;
        double horizontal = 0.0, inclined = 0.0, steep = 0.0, vertical = 0.0, green = 0.0;
        double yawBins[90] = {0.0};
        for (size_t t = 0; t < numTriangles; ++t) {
            const auto& v0 = mesh.vertices[mesh.indices[t * 3]];
            const auto& v1 = mesh.vertices[mesh.indices[t * 3 + 1]];
            const auto& v2 = mesh.vertices[mesh.indices[t * 3 + 2]];
            Vec3 cross = (v1.position - v0.position).cross(v2.position - v0.position);
            const double area = 0.5 * static_cast<double>(cross.length());
            if (!(area > 1e-12)) {
                m.degenerateTriangles++;
                continue;
            }
            const Vec3 n = cross.normalized();
            const float slopeDeg = std::acos(std::clamp(std::abs(n.y), 0.0f, 1.0f)) * math::RAD_TO_DEG;
            if (slopeDeg < 15.0f) horizontal += area;
            else if (slopeDeg < 45.0f) inclined += area;
            else if (slopeDeg < 75.0f) steep += area;
            else {
                vertical += area;
                float angle = std::atan2(n.z, n.x) * math::RAD_TO_DEG;
                if (angle < 0.0f) angle += 360.0f;
                yawBins[std::clamp(static_cast<int>(std::fmod(angle, 90.0f)), 0, 89)] += area;
            }
            const Vec4 c = (v0.color + v1.color + v2.color) * (1.0f / 3.0f);
            const float denom = 2.0f * c.y + c.x + c.z;
            if (denom > 1e-6f) green += area * ((2.0f * c.y - c.x - c.z) / denom);
            m.surfaceArea += area;
        }
        if (m.surfaceArea > 0.0) {
            m.horizontalFraction = static_cast<float>(horizontal / m.surfaceArea);
            m.inclinedFraction = static_cast<float>(inclined / m.surfaceArea);
            m.steepFraction = static_cast<float>(steep / m.surfaceArea);
            m.verticalFraction = static_cast<float>(vertical / m.surfaceArea);
            m.greenIndex = static_cast<float>(green / m.surfaceArea);
        }
        if (vertical > 0.0) {
            int peak = 0;
            for (int i = 1; i < 90; ++i) if (yawBins[i] > yawBins[peak]) peak = i;
            m.hasWalls = true;
            m.dominantWallYawDeg = static_cast<float>(peak) + 0.5f;
        }
        return m;
    }
};

// ============================================================================
// 2. Triangle-Plane Slicer (Sutherland-Hodgman)
// ============================================================================

class SutherlandHodgmanSlicer {
public:
    struct Triangle {
        Vertex v0, v1, v2;
    };

    /**
     * Clips a triangle against a horizontal plane y = yCutoff.
     * Retains all geometric portions above yCutoff without loss or dropping of vertical elements.
     */
    static void clipTriangleAboveElevation(
        const Vertex& v0, const Vertex& v1, const Vertex& v2,
        float yCutoff,
        std::vector<Triangle>& outTriangles
    ) {
        bool b0 = v0.position.y >= yCutoff;
        bool b1 = v1.position.y >= yCutoff;
        bool b2 = v2.position.y >= yCutoff;

        int countAbove = (b0 ? 1 : 0) + (b1 ? 1 : 0) + (b2 ? 1 : 0);

        if (countAbove == 3) {
            // Whole triangle is above: keep as-is
            outTriangles.push_back({v0, v1, v2});
        } else if (countAbove == 1) {
            // 1 vertex above, 2 below: clip into 1 smaller triangle above the plane
            const Vertex& top = b0 ? v0 : (b1 ? v1 : v2);
            const Vertex& bot1 = b0 ? v1 : (b1 ? v0 : v0);
            const Vertex& bot2 = b0 ? v2 : (b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(top, bot1, yCutoff);
            Vertex i2 = interpolateAtY(top, bot2, yCutoff);
            outTriangles.push_back({top, i1, i2});
        } else if (countAbove == 2) {
            // 2 vertices above, 1 below: clip into 1 quad (2 triangles) above the plane
            const Vertex& bot = !b0 ? v0 : (!b1 ? v1 : v2);
            const Vertex& top1 = !b0 ? v1 : (!b1 ? v0 : v0);
            const Vertex& top2 = !b0 ? v2 : (!b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(top1, bot, yCutoff);
            Vertex i2 = interpolateAtY(top2, bot, yCutoff);
            outTriangles.push_back({top1, top2, i1});
            outTriangles.push_back({top2, i2, i1});
        }
    }

    /**
     * Clips a triangle against a horizontal plane y = yCutoff.
     * Retains all geometric portions below yCutoff (e.g. building shaft).
     */
    static void clipTriangleBelowElevation(
        const Vertex& v0, const Vertex& v1, const Vertex& v2,
        float yCutoff,
        std::vector<Triangle>& outTriangles
    ) {
        bool b0 = v0.position.y >= yCutoff;
        bool b1 = v1.position.y >= yCutoff;
        bool b2 = v2.position.y >= yCutoff;

        int countAbove = (b0 ? 1 : 0) + (b1 ? 1 : 0) + (b2 ? 1 : 0);

        if (countAbove == 0) {
            // Whole triangle is below: keep as-is
            outTriangles.push_back({v0, v1, v2});
        } else if (countAbove == 2) {
            // 1 vertex below, 2 above: clip into 1 smaller triangle below the plane
            const Vertex& bot = !b0 ? v0 : (!b1 ? v1 : v2);
            const Vertex& top1 = !b0 ? v1 : (!b1 ? v0 : v0);
            const Vertex& top2 = !b0 ? v2 : (!b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(bot, top1, yCutoff);
            Vertex i2 = interpolateAtY(bot, top2, yCutoff);
            outTriangles.push_back({bot, i1, i2});
        } else if (countAbove == 1) {
            // 2 vertices below, 1 above: clip into 1 quad (2 triangles) below the plane
            const Vertex& top = b0 ? v0 : (b1 ? v1 : v2);
            const Vertex& bot1 = b0 ? v1 : (b1 ? v0 : v0);
            const Vertex& bot2 = b0 ? v2 : (b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(bot1, top, yCutoff);
            Vertex i2 = interpolateAtY(bot2, top, yCutoff);
            outTriangles.push_back({bot1, bot2, i1});
            outTriangles.push_back({bot2, i2, i1});
        }
    }

private:
    static Vertex interpolateAtY(const Vertex& a, const Vertex& b, float y) {
        float dy = b.position.y - a.position.y;
        float t = std::abs(dy) > 1e-6f ? (y - a.position.y) / dy : 0.5f;
        t = std::clamp(t, 0.0f, 1.0f);

        Vertex v;
        v.position = a.position * (1.0f - t) + b.position * t;
        v.position.y = y; // strictly snap to cutting plane
        v.normal = (a.normal * (1.0f - t) + b.normal * t).normalized();
        v.uv = a.uv * (1.0f - t) + b.uv * t;
        v.color = a.color * (1.0f - t) + b.color * t;
        return v;
    }
};

// ============================================================================
// 3. Span Curtain Carver
// ============================================================================
//
// Removes the near-vertical triangles inside a span box the caller gives: the footprint of an elevated deck
// (minX..maxX, minZ..maxZ) between the ground under it and the deck. It does not decide what is a bridge; every
// near-vertical triangle wholly inside the box is removed, whatever it belongs to, and the count is reported.

struct SpanBox {
    float minX{0.0f}, maxX{0.0f};
    float minZ{0.0f}, maxZ{0.0f};
    float groundY{0.0f}, deckY{0.0f};
};

struct SpanCarveResult {
    ScratchboxMesh mesh{"UtdraOutputMesh"};
    size_t removedTriangles{0};
};

class SpanCurtainCarver {
public:
    /** Triangles whose face normal has |y| below this are near-vertical (steeper than about 78.5 degrees). */
    static constexpr float kMaxWallNormalY = 0.2f;

    static SpanCarveResult carve(const ScratchboxMesh& input, const SpanBox& box) {
        constexpr float eps = 1e-3f;
        auto inside = [&](const Vec3& p) {
            return p.x >= box.minX - eps && p.x <= box.maxX + eps
                && p.z >= box.minZ - eps && p.z <= box.maxZ + eps
                && p.y >= box.groundY - eps && p.y <= box.deckY + eps;
        };
        SpanCarveResult result;
        std::vector<int64_t> remap(input.vertices.size(), -1);
        const size_t numTriangles = input.indices.size() / 3;
        for (size_t t = 0; t < numTriangles; ++t) {
            const uint32_t i[3] = {input.indices[t * 3], input.indices[t * 3 + 1], input.indices[t * 3 + 2]};
            const Vec3& p0 = input.vertices[i[0]].position;
            const Vec3& p1 = input.vertices[i[1]].position;
            const Vec3& p2 = input.vertices[i[2]].position;
            Vec3 cross = (p1 - p0).cross(p2 - p0);
            const bool nearVertical = cross.lengthSquared() > 1e-12f && std::abs(cross.normalized().y) < kMaxWallNormalY;
            if (nearVertical && inside(p0) && inside(p1) && inside(p2)) {
                result.removedTriangles++;
                continue;
            }
            for (uint32_t k : i) {
                if (remap[k] < 0) {
                    remap[k] = static_cast<int64_t>(result.mesh.vertices.size());
                    result.mesh.addVertex(input.vertices[k]);
                }
                result.mesh.indices.push_back(static_cast<uint32_t>(remap[k]));
            }
        }
        return result;
    }
};

} // namespace utdra
} // namespace scratchbox

#endif // SCRATCHBOX_UTDRA_HPP
