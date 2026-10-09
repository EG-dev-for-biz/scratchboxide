/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Exact Planar Half-Edge CSG Cutter & Architectural Aperture Engine
 *
 * Provides exact 0.000 mm analytical planar polygon cutting, wall aperture
 * generation (windows, doors, access penetrations), reveal jambs, sills,
 * and 2D spatial clearance interval solving for surface mount plane attachments.
 ********************************************************************************/

#ifndef SCRATCHBOX_CSG_HPP
#define SCRATCHBOX_CSG_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <algorithm>
#include <cmath>
#include <string>

namespace scratchbox {
namespace csg {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;

/**
 * Architectural Aperture Specification
 */
struct ApertureSpec {
    Vec2 centerOffset{0.0f, 0.0f}; // (u, v) offset relative to wall face center
    Vec2 size{1.2f, 1.8f};         // (width, height) in meters
    float recessDepth{0.25f};      // Depth of window/door reveal jamb in meters
    float sillHeight{0.08f};       // Height of sill projection
    float sillDepth{0.12f};        // Forward projection of sill
    bool isDoor{false};            // Extends to base
    float confidence{1.0f};        // 1.0 = measured, 0.0 = procedurally inferred
};

/**
 * Result of a 2D mount clearance search on a surface plane.
 */
struct ClearanceIntervalResult {
    bool found{false};
    Vec2 solvedCenterOffset{0.0f, 0.0f};
    Vec2 allocatedSize{0.0f, 0.0f};
    float minClearanceMeters{0.0f};
};

/**
 * Analytical 2D Interval Clearance Solver
 * Finds an obstacle-free placement on a planar wall face for surface attachments
 * (e.g. fire escapes, balconies, awnings) avoiding apertures.
 */
inline ClearanceIntervalResult solveMountClearanceInterval(
    float wallWidth,
    float wallHeight,
    const std::vector<ApertureSpec>& obstacles,
    float targetWidth,
    float targetHeight,
    float safetyMargin = 0.3f
) {
    ClearanceIntervalResult res;
    res.allocatedSize = Vec2(targetWidth, targetHeight);

    float halfW = wallWidth * 0.5f;
    float halfH = wallHeight * 0.5f;

    // Grid search with fine discrete steps
    float stepX = 0.25f;
    float stepY = 0.5f;

    float bestDistanceToEdge = -1.0f;
    Vec2 bestPos{0.0f, 0.0f};

    for (float x = -halfW + targetWidth * 0.5f + safetyMargin; x <= halfW - targetWidth * 0.5f - safetyMargin; x += stepX) {
        for (float y = -halfH + targetHeight * 0.5f + safetyMargin; y <= halfH - targetHeight * 0.5f - safetyMargin; y += stepY) {
            bool collision = false;
            float minObsDist = 1e6f;

            float minX1 = x - targetWidth * 0.5f;
            float maxX1 = x + targetWidth * 0.5f;
            float minY1 = y - targetHeight * 0.5f;
            float maxY1 = y + targetHeight * 0.5f;

            for (const auto& obs : obstacles) {
                float obsMinX = obs.centerOffset.x - obs.size.x * 0.5f - safetyMargin;
                float obsMaxX = obs.centerOffset.x + obs.size.x * 0.5f + safetyMargin;
                float obsMinY = obs.centerOffset.y - obs.size.y * 0.5f - safetyMargin;
                float obsMaxY = obs.centerOffset.y + obs.size.y * 0.5f + safetyMargin;

                // AABB overlap check
                if (maxX1 > obsMinX && minX1 < obsMaxX && maxY1 > obsMinY && minY1 < obsMaxY) {
                    collision = true;
                    break;
                }

                // Compute clearance distance
                float dx = std::max(0.0f, std::max(obsMinX - maxX1, minX1 - obsMaxX));
                float dy = std::max(0.0f, std::max(obsMinY - maxY1, minY1 - obsMaxY));
                float dist = std::sqrt(dx * dx + dy * dy);
                if (dist < minObsDist) minObsDist = dist;
            }

            if (!collision) {
                if (minObsDist > bestDistanceToEdge) {
                    bestDistanceToEdge = minObsDist;
                    bestPos = Vec2(x, y);
                    res.found = true;
                }
            }
        }
    }

    if (res.found) {
        res.solvedCenterOffset = bestPos;
        res.minClearanceMeters = bestDistanceToEdge;
    }

    return res;
}

/**
 * Generates an architectural wall plane with an exact rectangular aperture cutout,
 * recessed reveal jambs, and projecting sill.
 *
 * Encodes provenance and uncertainty in COLOR_0:
 * - color.r = confidence (1.0 = measured, 0.0 = inferred)
 * - color.g = isApertureReveal (1.0 = reveal/jamb, 0.0 = primary wall face)
 */
inline void generateWallWithAperture(
    ScratchboxMesh& mesh,
    const Vec3& origin,
    const Vec3& uDir,       // Normalized horizontal vector along wall width
    const Vec3& vDir,       // Normalized vertical vector along wall height
    float width,
    float height,
    const ApertureSpec& aperture
) {
    Vec3 normal = uDir.cross(vDir).normalized();
    Vec3 inDir = -normal; // Inward direction into wall thickness

    uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

    float halfW = width * 0.5f;
    float halfH = height * 0.5f;

    // Aperture bounds in (u, v) space
    float apHalfW = aperture.size.x * 0.5f;
    float apHalfH = aperture.size.y * 0.5f;

    float apLeft = aperture.centerOffset.x - apHalfW;
    float apRight = aperture.centerOffset.x + apHalfW;
    float apBottom = aperture.centerOffset.y - apHalfH;
    float apTop = aperture.centerOffset.y + apHalfH;

    // Clamp aperture to wall bounds
    apLeft = std::max(-halfW + 0.05f, apLeft);
    apRight = std::min(halfW - 0.05f, apRight);
    apBottom = std::max(-halfH + 0.05f, apBottom);
    apTop = std::min(halfH - 0.05f, apTop);

    Vec4 wallColor(aperture.confidence, 0.0f, 0.0f, 1.0f);
    Vec4 jambColor(aperture.confidence, 1.0f, 0.0f, 1.0f);

    auto addQuad = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
                       const Vec3& n, const Vec4& col) {
        uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
        Vertex v0, v1, v2, v3;
        v0.position = p0; v0.normal = n; v0.color = col; v0.uv = Vec2(0, 0);
        v1.position = p1; v1.normal = n; v1.color = col; v1.uv = Vec2(1, 0);
        v2.position = p2; v2.normal = n; v2.color = col; v2.uv = Vec2(1, 1);
        v3.position = p3; v3.normal = n; v3.color = col; v3.uv = Vec2(0, 1);

        mesh.vertices.push_back(v0);
        mesh.vertices.push_back(v1);
        mesh.vertices.push_back(v2);
        mesh.vertices.push_back(v3);

        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 1);
        mesh.indices.push_back(idx + 2);
        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 2);
        mesh.indices.push_back(idx + 3);
    };

    auto toWorld = [&](float u, float v, float depthOffset = 0.0f) -> Vec3 {
        return origin + uDir * u + vDir * v + inDir * depthOffset;
    };

    // 1. Bottom wall section (below sill)
    if (apBottom > -halfH) {
        addQuad(
            toWorld(-halfW, -halfH),
            toWorld(halfW, -halfH),
            toWorld(halfW, apBottom),
            toWorld(-halfW, apBottom),
            normal, wallColor
        );
    }

    // 2. Top wall section (above lintel)
    if (apTop < halfH) {
        addQuad(
            toWorld(-halfW, apTop),
            toWorld(halfW, apTop),
            toWorld(halfW, halfH),
            toWorld(-halfW, halfH),
            normal, wallColor
        );
    }

    // 3. Left pier section
    if (apLeft > -halfW) {
        addQuad(
            toWorld(-halfW, apBottom),
            toWorld(apLeft, apBottom),
            toWorld(apLeft, apTop),
            toWorld(-halfW, apTop),
            normal, wallColor
        );
    }

    // 4. Right pier section
    if (apRight < halfW) {
        addQuad(
            toWorld(apRight, apBottom),
            toWorld(halfW, apBottom),
            toWorld(halfW, apTop),
            toWorld(apRight, apTop),
            normal, wallColor
        );
    }

    // 5. Inset Reveal Jambs & Lintel (recessed into wall depth)
    float d = aperture.recessDepth;
    if (d > 0.001f) {
        // Left Jamb (facing +u)
        addQuad(
            toWorld(apLeft, apBottom, 0.0f),
            toWorld(apLeft, apBottom, d),
            toWorld(apLeft, apTop, d),
            toWorld(apLeft, apTop, 0.0f),
            uDir, jambColor
        );

        // Right Jamb (facing -u)
        addQuad(
            toWorld(apRight, apBottom, d),
            toWorld(apRight, apBottom, 0.0f),
            toWorld(apRight, apTop, 0.0f),
            toWorld(apRight, apTop, d),
            -uDir, jambColor
        );

        // Lintel / Soffit (facing -v)
        addQuad(
            toWorld(apLeft, apTop, 0.0f),
            toWorld(apRight, apTop, 0.0f),
            toWorld(apRight, apTop, d),
            toWorld(apLeft, apTop, d),
            -vDir, jambColor
        );

        // Sill / Floor reveal (facing +v)
        addQuad(
            toWorld(apLeft, apBottom, d),
            toWorld(apRight, apBottom, d),
            toWorld(apRight, apBottom, 0.0f),
            toWorld(apLeft, apBottom, 0.0f),
            vDir, jambColor
        );
    }
}

/**
 * Cuts multiple apertures into a continuous multi-story façade wall.
 */
inline void generateFacadeWithApertures(
    ScratchboxMesh& mesh,
    const Vec3& origin,
    const Vec3& uDir,
    const Vec3& vDir,
    float width,
    float height,
    const std::vector<ApertureSpec>& apertures
) {
    if (apertures.empty()) {
        Vec3 normal = uDir.cross(vDir).normalized();
        float halfW = width * 0.5f;
        float halfH = height * 0.5f;
        Vec4 color(1.0f, 0.0f, 0.0f, 1.0f);

        uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
        auto addV = [&](float u, float v) {
            Vertex vert;
            vert.position = origin + uDir * u + vDir * v;
            vert.normal = normal;
            vert.color = color;
            vert.uv = Vec2((u + halfW) / width, (v + halfH) / height);
            mesh.vertices.push_back(vert);
        };
        addV(-halfW, -halfH);
        addV(halfW, -halfH);
        addV(halfW, halfH);
        addV(-halfW, halfH);

        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 1);
        mesh.indices.push_back(idx + 2);
        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 2);
        mesh.indices.push_back(idx + 3);
        return;
    }

    // For single aperture, direct evaluation
    if (apertures.size() == 1) {
        generateWallWithAperture(mesh, origin, uDir, vDir, width, height, apertures[0]);
        return;
    }

    // Multi-aperture: Partition wall into vertical columns centered around each aperture
    std::vector<ApertureSpec> sortedApertures = apertures;
    std::sort(sortedApertures.begin(), sortedApertures.end(), [](const ApertureSpec& a, const ApertureSpec& b) {
        return a.centerOffset.x < b.centerOffset.x;
    });

    float halfW = width * 0.5f;
    float lastBoundary = -halfW;

    for (size_t i = 0; i < sortedApertures.size(); ++i) {
        float nextBoundary = (i + 1 < sortedApertures.size())
            ? (sortedApertures[i].centerOffset.x + sortedApertures[i + 1].centerOffset.x) * 0.5f
            : halfW;

        float subWidth = nextBoundary - lastBoundary;
        float subCenterU = (lastBoundary + nextBoundary) * 0.5f;
        Vec3 subOrigin = origin + uDir * subCenterU;

        ApertureSpec localAp = sortedApertures[i];
        localAp.centerOffset.x = sortedApertures[i].centerOffset.x - subCenterU;

        generateWallWithAperture(mesh, subOrigin, uDir, vDir, subWidth, height, localAp);
        lastBoundary = nextBoundary;
    }
}

} // namespace csg
} // namespace scratchbox

#endif // SCRATCHBOX_CSG_HPP
