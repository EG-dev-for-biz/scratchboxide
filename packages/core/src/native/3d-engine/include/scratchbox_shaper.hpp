/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SHAPER_HPP
#define SCRATCHBOX_SHAPER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_kelvinlet.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <array>
#include <functional>
#include <string>
#include <map>
#include <unordered_map>
#include <set>
#include <cstdint>
#include <limits>
#include <numeric>

namespace scratchbox {
namespace shaper {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::AABB;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;

enum class Axis { X, Y, Z };

// ============================================================================
// 1. Non-Linear Global & Local Mesh Deformers
// ============================================================================
class Deformer {
public:
    /**
     * Tapers a mesh along a specified axis. Coordinates orthogonal to the axis
     * are scaled by lerp(1.0, factor, t^power) where t in [0, 1] across [minBound, maxBound].
     */
    static void taper(
        ScratchboxMesh& mesh,
        Axis axis,
        float factor,
        float minBound = -1.0f,
        float maxBound = 1.0f,
        float power = 1.0f
    ) {
        if (std::abs(maxBound - minBound) < 1e-6f) return;
        float range = maxBound - minBound;

        for (auto& v : mesh.vertices) {
            float coord = getAxisCoord(v.position, axis);
            float t = std::clamp((coord - minBound) / range, 0.0f, 1.0f);
            float s = 1.0f + (factor - 1.0f) * std::pow(t, power);

            scaleOrthogonal(v.position, axis, s);
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    /**
     * Conformal axial twist deformation. Rotates cross-sections around the given axis
     * by angle = totalAngleRad * t where t in [0, 1] across [minBound, maxBound].
     */
    static void twist(
        ScratchboxMesh& mesh,
        Axis axis,
        float totalAngleRad,
        float minBound = -1.0f,
        float maxBound = 1.0f
    ) {
        if (std::abs(maxBound - minBound) < 1e-6f) return;
        float range = maxBound - minBound;

        for (auto& v : mesh.vertices) {
            float coord = getAxisCoord(v.position, axis);
            float t = std::clamp((coord - minBound) / range, 0.0f, 1.0f);
            float angle = totalAngleRad * t;
            rotateOrthogonal(v.position, axis, angle);
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    /**
     * Cylindrical conformal bend preserving surface arc length.
     * Bends mainAxis around bendAxis by angleRad over radius R.
     */
    static void bend(
        ScratchboxMesh& mesh,
        Axis mainAxis,
        Axis bendAxis,
        float angleRad,
        float radius
    ) {
        if (std::abs(angleRad) < 1e-5f || radius <= 1e-5f) return;

        for (auto& v : mesh.vertices) {
            float mainCoord = getAxisCoord(v.position, mainAxis);
            float bendCoord = getAxisCoord(v.position, bendAxis);

            // Compute arc angle theta
            float theta = (mainCoord / radius) * (angleRad / PI);
            float r = radius + bendCoord;

            float newMain = r * std::sin(theta);
            float newBend = r * std::cos(theta) - radius;

            setAxisCoord(v.position, mainAxis, newMain);
            setAxisCoord(v.position, bendAxis, newBend);
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    /**
     * Directional shear deformation. Displaces shearAxis by factor * position[mainAxis].
     */
    static void shear(
        ScratchboxMesh& mesh,
        Axis mainAxis,
        Axis shearAxis,
        float factor
    ) {
        for (auto& v : mesh.vertices) {
            float m = getAxisCoord(v.position, mainAxis);
            float s = getAxisCoord(v.position, shearAxis);
            setAxisCoord(v.position, shearAxis, s + factor * m);
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    /**
     * Spherical bulge / pinch: radially displaces vertices within radius of center.
     */
    static void bulge(
        ScratchboxMesh& mesh,
        const Vec3& center,
        float radius,
        float strength,
        float power = 2.0f
    ) {
        if (radius <= 1e-6f) return;

        for (auto& v : mesh.vertices) {
            Vec3 delta = v.position - center;
            float dist = delta.length();
            if (dist < radius) {
                float falloff = std::pow(1.0f - (dist / radius), power);
                Vec3 dir = dist > 1e-6f ? delta / dist : v.normal;
                v.position += dir * (strength * falloff);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    /**
     * Kelvinlet deformation (scratchbox_kelvinlet.hpp): the elastic response to a regularised point load - a grab,
     * twist, uniform scale or pinch - with no falloff edge, bulging like clay when the material is incompressible.
     * Large moves are integrated in small steps so they drag rather than fold. `weights` (one per vertex, 0..1) or null.
     */
    static kelvinlet::Report kelvinlet(
        ScratchboxMesh& mesh,
        const kelvinlet::Load& load,
        const kelvinlet::Options& options,
        const std::vector<float>* weights = nullptr
    ) {
        return kelvinlet::deformMesh(mesh, load, options, weights);
    }

private:
    static float getAxisCoord(const Vec3& p, Axis a) {
        switch (a) {
            case Axis::X: return p.x;
            case Axis::Y: return p.y;
            case Axis::Z: return p.z;
        }
        return p.y;
    }

    static void setAxisCoord(Vec3& p, Axis a, float val) {
        switch (a) {
            case Axis::X: p.x = val; break;
            case Axis::Y: p.y = val; break;
            case Axis::Z: p.z = val; break;
        }
    }

    static void scaleOrthogonal(Vec3& p, Axis a, float s) {
        switch (a) {
            case Axis::X: p.y *= s; p.z *= s; break;
            case Axis::Y: p.x *= s; p.z *= s; break;
            case Axis::Z: p.x *= s; p.y *= s; break;
        }
    }

    static void rotateOrthogonal(Vec3& p, Axis a, float angle) {
        float c = std::cos(angle);
        float s = std::sin(angle);
        switch (a) {
            case Axis::X: {
                float y = c * p.y - s * p.z;
                float z = s * p.y + c * p.z;
                p.y = y; p.z = z;
                break;
            }
            case Axis::Y: {
                float x = c * p.x + s * p.z;
                float z = -s * p.x + c * p.z;
                p.x = x; p.z = z;
                break;
            }
            case Axis::Z: {
                float x = c * p.x - s * p.y;
                float y = s * p.x + c * p.y;
                p.x = x; p.y = y;
                break;
            }
        }
    }
};

// ============================================================================
// 2. Free-Form Deformation (FFD) 3D Bernstein Tensor Product Lattice
// ============================================================================
class Lattice3D {
public:
    int dimX{3};
    int dimY{3};
    int dimZ{3};
    AABB restBounds;
    std::vector<Vec3> controlPoints;

    Lattice3D() = default;
    Lattice3D(int dx, int dy, int dz, const AABB& bounds)
        : dimX(dx), dimY(dy), dimZ(dz), restBounds(bounds) {
        initGrid();
    }

    void initGrid() {
        controlPoints.resize(dimX * dimY * dimZ);
        Vec3 bMin = restBounds.min;
        Vec3 size = restBounds.size();

        for (int k = 0; k < dimZ; ++k) {
            float w = dimZ > 1 ? static_cast<float>(k) / (dimZ - 1) : 0.5f;
            for (int j = 0; j < dimY; ++j) {
                float v = dimY > 1 ? static_cast<float>(j) / (dimY - 1) : 0.5f;
                for (int i = 0; i < dimX; ++i) {
                    float u = dimX > 1 ? static_cast<float>(i) / (dimX - 1) : 0.5f;
                    int idx = getIndex(i, j, k);
                    controlPoints[idx] = Vec3(
                        bMin.x + u * size.x,
                        bMin.y + v * size.y,
                        bMin.z + w * size.z
                    );
                }
            }
        }
    }

    int getIndex(int i, int j, int k) const {
        return k * (dimX * dimY) + j * dimX + i;
    }

    Vec3 getControlPoint(int i, int j, int k) const {
        return controlPoints[getIndex(i, j, k)];
    }

    void setControlPoint(int i, int j, int k, const Vec3& pos) {
        controlPoints[getIndex(i, j, k)] = pos;
    }

    void offsetControlPoint(int i, int j, int k, const Vec3& delta) {
        controlPoints[getIndex(i, j, k)] += delta;
    }

    /**
     * Deforms mesh vertices using trivariate Bernstein tensor product evaluation.
     */
    void deform(ScratchboxMesh& mesh) const {
        Vec3 bMin = restBounds.min;
        Vec3 bSize = restBounds.size();
        if (bSize.x < 1e-6f || bSize.y < 1e-6f || bSize.z < 1e-6f) return;

        for (auto& vert : mesh.vertices) {
            // Normalized parametric coords u, v, w in [0, 1]
            float u = std::clamp((vert.position.x - bMin.x) / bSize.x, 0.0f, 1.0f);
            float v = std::clamp((vert.position.y - bMin.y) / bSize.y, 0.0f, 1.0f);
            float w = std::clamp((vert.position.z - bMin.z) / bSize.z, 0.0f, 1.0f);

            Vec3 deformedPos(0, 0, 0);

            for (int k = 0; k < dimZ; ++k) {
                float Bw = bernstein(dimZ - 1, k, w);
                for (int j = 0; j < dimY; ++j) {
                    float Bv = bernstein(dimY - 1, j, v);
                    for (int i = 0; i < dimX; ++i) {
                        float Bu = bernstein(dimX - 1, i, u);
                        float weight = Bu * Bv * Bw;
                        deformedPos += getControlPoint(i, j, k) * weight;
                    }
                }
            }

            vert.position = deformedPos;
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

private:
    static float bernstein(int n, int i, float t) {
        if (i < 0 || i > n) return 0.0f;
        float c = binomial(n, i);
        return c * std::pow(t, i) * std::pow(1.0f - t, n - i);
    }

    static float binomial(int n, int k) {
        if (k < 0 || k > n) return 0.0f;
        if (k == 0 || k == n) return 1.0f;
        float res = 1.0f;
        for (int i = 1; i <= k; ++i) {
            res = res * (n - (k - i)) / i;
        }
        return res;
    }
};

// ============================================================================
// 3. Multi-Brush Sculpt Engine
// ============================================================================
enum class SculptBrush {
    Grab,
    Clay,
    Inflate,
    Flatten,
    Pinch,
    Crease,
    Smooth
};

enum class SculptFalloff {
    Gaussian,
    Cosine,
    Smoothstep,
    Spike,
    Linear
};

class SculptEngine {
public:
    static float evaluateFalloff(float dist, float radius, SculptFalloff type) {
        if (dist >= radius) return 0.0f;
        float t = dist / radius;
        switch (type) {
            case SculptFalloff::Gaussian:
                return std::exp(-3.0f * t * t);
            case SculptFalloff::Cosine:
                return 0.5f * (1.0f + std::cos(t * PI));
            case SculptFalloff::Smoothstep:
                return (1.0f - t) * (1.0f - t) * (1.0f + 2.0f * t);
            case SculptFalloff::Spike:
                return std::pow(1.0f - t, 3.0f);
            case SculptFalloff::Linear:
                return 1.0f - t;
        }
        return 1.0f - t;
    }

    static void applyStroke(
        ScratchboxMesh& mesh,
        SculptBrush brush,
        const Vec3& center,
        float radius,
        float strength,
        const Vec3& strokeDir = {0, 1, 0},
        SculptFalloff falloff = SculptFalloff::Smoothstep
    ) {
        if (radius <= 1e-6f || mesh.vertices.empty()) return;

        Vec3 normDir = strokeDir.lengthSq() > 1e-6f ? strokeDir.normalized() : Vec3(0, 1, 0);

        switch (brush) {
            case SculptBrush::Grab: {
                for (auto& v : mesh.vertices) {
                    float dist = (v.position - center).length();
                    if (dist < radius) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        v.position += normDir * (strength * w);
                    }
                }
                break;
            }
            case SculptBrush::Clay: {
                // Layered clay buildup with surface tangent constraint
                for (auto& v : mesh.vertices) {
                    float dist = (v.position - center).length();
                    if (dist < radius) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        Vec3 dispDir = (v.normal + normDir).normalized();
                        v.position += dispDir * (strength * w * 0.75f);
                    }
                }
                break;
            }
            case SculptBrush::Inflate: {
                for (auto& v : mesh.vertices) {
                    float dist = (v.position - center).length();
                    if (dist < radius) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        v.position += v.normal * (strength * w);
                    }
                }
                break;
            }
            case SculptBrush::Flatten: {
                // Project toward tangent plane at center
                for (auto& v : mesh.vertices) {
                    float dist = (v.position - center).length();
                    if (dist < radius) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        float distToPlane = (v.position - center).dot(normDir);
                        v.position -= normDir * (distToPlane * strength * w);
                    }
                }
                break;
            }
            case SculptBrush::Pinch: {
                for (auto& v : mesh.vertices) {
                    Vec3 delta = center - v.position;
                    float dist = delta.length();
                    if (dist < radius && dist > 1e-6f) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        v.position += (delta / dist) * (strength * w);
                    }
                }
                break;
            }
            case SculptBrush::Crease: {
                // Pinch towards stroke line while pushing downward along normal
                for (auto& v : mesh.vertices) {
                    Vec3 delta = center - v.position;
                    float dist = delta.length();
                    if (dist < radius && dist > 1e-6f) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        Vec3 inward = (delta / dist) * (strength * w * 0.5f);
                        Vec3 carve = (-v.normal) * (strength * w * 0.5f);
                        v.position += inward + carve;
                    }
                }
                break;
            }
            case SculptBrush::Smooth: {
                // Local Laplacian smoothing
                std::vector<Vec3> newPositions(mesh.vertices.size());
                std::vector<std::vector<uint32_t>> adj(mesh.vertices.size());
                for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
                    uint32_t i0 = mesh.indices[i], i1 = mesh.indices[i+1], i2 = mesh.indices[i+2];
                    adj[i0].push_back(i1); adj[i0].push_back(i2);
                    adj[i1].push_back(i0); adj[i1].push_back(i2);
                    adj[i2].push_back(i0); adj[i2].push_back(i1);
                }

                for (size_t i = 0; i < mesh.vertices.size(); ++i) {
                    newPositions[i] = mesh.vertices[i].position;
                    float dist = (mesh.vertices[i].position - center).length();
                    if (dist < radius && !adj[i].empty()) {
                        float w = evaluateFalloff(dist, radius, falloff);
                        Vec3 avg(0, 0, 0);
                        for (uint32_t nIdx : adj[i]) {
                            avg += mesh.vertices[nIdx].position;
                        }
                        avg = avg * (1.0f / static_cast<float>(adj[i].size()));
                        newPositions[i] = mesh.vertices[i].position + (avg - mesh.vertices[i].position) * (strength * w);
                    }
                }

                for (size_t i = 0; i < mesh.vertices.size(); ++i) {
                    mesh.vertices[i].position = newPositions[i];
                }
                break;
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }
};

namespace detail {

/**
 * Ear-clipping triangulation for a simple (possibly concave) 2D polygon, for Loft3D's end caps. A byte-for-byte
 * port of footprints::PolygonTriangulator::triangulate (scratchbox_footprints.hpp): that header can't be included
 * here directly, since scratchbox_io.hpp (which it pulls in) already depends on this file's own `shaper` namespace
 * being fully defined first in the engine's normal include order (scratchbox_engine.hpp includes shaper.hpp before
 * io.hpp/footprints.hpp) -- including footprints.hpp from here would include io.hpp too early and break that.
 */
inline float loftCapSignedArea(const std::vector<Vec2>& poly) {
    if (poly.size() < 3) return 0.0f;
    float area = 0.0f;
    for (size_t i = 0; i < poly.size(); ++i) {
        size_t j = (i + 1) % poly.size();
        area += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    return area * 0.5f;
}

inline bool loftCapPointInTriangle(const Vec2& p, const Vec2& a, const Vec2& b, const Vec2& c) {
    auto cross2d = [](const Vec2& v1, const Vec2& v2) { return v1.x * v2.y - v1.y * v2.x; };
    float c1 = cross2d(b - a, p - a);
    float c2 = cross2d(c - b, p - b);
    float c3 = cross2d(a - c, p - c);
    bool hasNeg = (c1 < 0) || (c2 < 0) || (c3 < 0);
    bool hasPos = (c1 > 0) || (c2 > 0) || (c3 > 0);
    return !(hasNeg && hasPos);
}

inline std::vector<uint32_t> loftCapTriangulate(const std::vector<Vec2>& rawPoly) {
    std::vector<uint32_t> indices;
    if (rawPoly.size() < 3) return indices;

    std::vector<Vec2> poly = rawPoly;
    std::vector<uint32_t> V(poly.size());
    std::iota(V.begin(), V.end(), 0);

    if (loftCapSignedArea(poly) < 0.0f) {
        std::reverse(V.begin(), V.end());
        std::reverse(poly.begin(), poly.end());
    }

    int n = static_cast<int>(poly.size());
    int count = 2 * n;

    for (int v = n - 1; n > 2;) {
        if ((count--) <= 0) {
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

        float cross = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
        if (cross <= 1e-6f) continue;

        bool isEar = true;
        for (int p = 0; p < n; ++p) {
            if (p == u || p == v || p == w) continue;
            if (loftCapPointInTriangle(poly[p], A, B, C)) {
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

} // namespace detail

// ============================================================================
// 4. Parametric Sweeps: Loft3D, Lathe3D, Sweep3D
// ============================================================================
class Loft3D {
public:
    /**
     * Lofts a smooth 3D skin between consecutive cross-sectional polygonal loops.
     */
    static ScratchboxMesh skin(
        const std::vector<std::vector<Vec3>>& slices,
        bool closeEnds = true,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f}
    ) {
        ScratchboxMesh mesh("lofted_mesh");
        if (slices.size() < 2) return mesh;
        size_t ptsPerSlice = slices[0].size();
        for (const auto& slice : slices) {
            if (slice.size() != ptsPerSlice || ptsPerSlice < 3) return mesh;
        }

        // Add vertices
        for (size_t s = 0; s < slices.size(); ++s) {
            float v = static_cast<float>(s) / (slices.size() - 1);
            for (size_t p = 0; p < ptsPerSlice; ++p) {
                float u = static_cast<float>(p) / ptsPerSlice;
                mesh.addVertex({slices[s][p], Vec3(0, 1, 0), Vec2(u, v), color});
            }
        }

        // Add quad strip faces between consecutive slices
        for (size_t s = 0; s + 1 < slices.size(); ++s) {
            uint32_t s0 = static_cast<uint32_t>(s * ptsPerSlice);
            uint32_t s1 = static_cast<uint32_t>((s + 1) * ptsPerSlice);

            for (size_t p = 0; p < ptsPerSlice; ++p) {
                size_t nextP = (p + 1) % ptsPerSlice;
                uint32_t i0 = s0 + static_cast<uint32_t>(p);
                uint32_t i1 = s1 + static_cast<uint32_t>(p);
                uint32_t i2 = s1 + static_cast<uint32_t>(nextP);
                uint32_t i3 = s0 + static_cast<uint32_t>(nextP);

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }

        // Optional end capping: a proper polygon triangulation (PolygonTriangulator, the same ear-clipping-style
        // triangulator extrude_polygon caps with), not a centroid fan. A fan's single center vertex is a plain
        // average of the loop, which for a non-convex cross-section (an arch haunch, an L/U footprint, a sawtooth
        // facade) can sit outside the polygon entirely, or send a fan triangle straight across a concavity -- real,
        // self-intersecting garbage, not just an approximation. Each cap is projected to its own XZ (u, v) = (x, z)
        // plane for triangulation (consistent with this engine's existing cap-normal convention below, which already
        // assumes a roughly Y-aligned sweep), triangulated in that 2D polygon, then emitted at the slice's own 3D
        // positions. Winding: PolygonTriangulator's raw order is correct for the bottom cap's -Y-facing normal, and
        // must be reversed for the top cap's +Y-facing one -- verified against a BSP boolean operand the same way
        // extrude_polygon's own winding was fixed earlier, not assumed from either function's doc comment.
        if (closeEnds) {
            auto capFlat = [](const std::vector<Vec3>& slice) {
                std::vector<Vec2> flat;
                flat.reserve(slice.size());
                for (const auto& p : slice) flat.push_back(Vec2(p.x, p.z));
                return flat;
            };

            // Bottom cap: raw triangulator order is already correct for a -Y-facing normal.
            {
                const std::vector<uint32_t> capTris = detail::loftCapTriangulate(capFlat(slices[0]));
                const uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
                for (const auto& p : slices[0]) mesh.addVertex({p, Vec3(0, -1, 0), Vec2(p.x, p.z), color});
                for (uint32_t idx : capTris) mesh.indices.push_back(base + idx);
            }

            // Top cap: reversed, for a +Y-facing normal.
            {
                const size_t lastS = slices.size() - 1;
                const std::vector<uint32_t> capTris = detail::loftCapTriangulate(capFlat(slices[lastS]));
                const uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
                for (const auto& p : slices[lastS]) mesh.addVertex({p, Vec3(0, 1, 0), Vec2(p.x, p.z), color});
                for (size_t i = 0; i + 2 < capTris.size(); i += 3) {
                    mesh.indices.push_back(base + capTris[i]); mesh.indices.push_back(base + capTris[i + 2]); mesh.indices.push_back(base + capTris[i + 1]);
                }
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

class Sweep3D {
public:
    struct Frame {
        Vec3 origin;
        Vec3 tangent;
        Vec3 normal;    // first transverse axis
        Vec3 binormal;  // second transverse axis (tangent x normal)
    };

    /**
     * Rotation-minimizing frames along a polyline carrier curve, via the double
     * reflection method (Wang, Jüttler, Zheng, Liu — "Computation of Rotation
     * Minimizing Frames", ACM TOG 2008). Unlike a per-segment Frenet or
     * Gram-Schmidt frame, the transverse axes are propagated from the previous
     * frame rather than re-derived from local curvature, so they don't flip or
     * spin at inflection points, straight runs, or near-parallel tangents —
     * the artifact a naive per-segment frame produces when sweeping a profile
     * along a general carrier curve (limbs, hoses, struts, coils).
     */
    static std::vector<Frame> rotationMinimizingFrames(
        const std::vector<Vec3>& curve,
        Vec3 initialNormalHint = Vec3(0, 1, 0)
    ) {
        std::vector<Frame> frames;
        size_t n = curve.size();
        if (n < 2) return frames;
        frames.resize(n);

        std::vector<Vec3> tangent(n);
        for (size_t i = 0; i < n; ++i) {
            Vec3 dir = (i + 1 < n ? curve[i + 1] : curve[i]) - (i > 0 ? curve[i - 1] : curve[i]);
            tangent[i] = dir.length() > 1e-8f ? dir.normalized() : Vec3(0, 0, 1);
        }

        // Seed frame 0: orthogonalize the hint normal against the tangent.
        Vec3 t0 = tangent[0];
        Vec3 hint = initialNormalHint;
        if (std::abs(hint.normalized().dot(t0)) > 0.999f) {
            hint = (std::abs(t0.y) < 0.9f) ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        }
        Vec3 n0 = (hint - t0 * t0.dot(hint)).normalized();
        frames[0] = { curve[0], t0, n0, t0.cross(n0).normalized() };

        for (size_t i = 0; i + 1 < n; ++i) {
            const Frame& Fi = frames[i];
            Vec3 v1 = curve[i + 1] - curve[i];
            float c1 = v1.dot(v1);

            Vec3 rL = Fi.normal;
            Vec3 tL = Fi.tangent;
            if (c1 > 1e-12f) {
                rL = Fi.normal - v1 * (2.0f / c1 * v1.dot(Fi.normal));
                tL = Fi.tangent - v1 * (2.0f / c1 * v1.dot(Fi.tangent));
            }

            Vec3 tNext = tangent[i + 1];
            Vec3 v2 = tNext - tL;
            float c2 = v2.dot(v2);

            Vec3 rNext = rL;
            if (c2 > 1e-12f) {
                rNext = rL - v2 * (2.0f / c2 * v2.dot(rL));
            }
            rNext = (rNext - tNext * tNext.dot(rNext)).normalized();

            frames[i + 1] = { curve[i + 1], tNext, rNext, tNext.cross(rNext).normalized() };
        }

        return frames;
    }

    /**
     * Sweeps a 2D profile along an arbitrary carrier curve using rotation-minimizing
     * frames, with optional continuous twist (radians, end-to-end) and non-uniform
     * scale (end-to-end lerp). Produces slices consumable directly by Loft3D::skin.
     */
    static ScratchboxMesh sweep(
        const std::vector<Vec3>& curve,
        const std::vector<Vec2>& profile,
        float totalTwistRad = 0.0f,
        float startScale = 1.0f,
        float endScale = 1.0f,
        bool closeEnds = true,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f}
    ) {
        if (curve.size() < 2 || profile.size() < 3) return ScratchboxMesh("swept_mesh");

        std::vector<Frame> frames = rotationMinimizingFrames(curve);
        std::vector<std::vector<Vec3>> slices(frames.size());

        for (size_t i = 0; i < frames.size(); ++i) {
            float t = static_cast<float>(i) / static_cast<float>(frames.size() - 1);
            float twist = t * totalTwistRad;
            float scale = startScale + (endScale - startScale) * t;
            float cosA = std::cos(twist);
            float sinA = std::sin(twist);

            const Frame& f = frames[i];
            slices[i].reserve(profile.size());
            for (const Vec2& p : profile) {
                float x = (p.x * cosA - p.y * sinA) * scale;
                float y = (p.x * sinA + p.y * cosA) * scale;
                slices[i].push_back(f.origin + f.normal * x + f.binormal * y);
            }
        }

        ScratchboxMesh mesh = Loft3D::skin(slices, closeEnds, color);
        mesh.name = "swept_mesh";
        return mesh;
    }
};

class Replicator3D {
public:
    /**
     * Repeats a seed mesh at a continuous pitch along a carrier curve (bolt circles on a
     * closed loop, louvres, teeth, treads), oriented by rotation-minimizing frames so each
     * instance follows the carrier's local tangent/normal/binormal rather than staying
     * axis-aligned. The seed's local +Z maps to the carrier tangent, +X to the frame normal,
     * +Y to the binormal.
     *
     * fitToLength spaces instances evenly from the curve's start to its end (so the last
     * instance always lands exactly at the end); otherwise instances step at a fixed pitch
     * from the start and may leave a remainder gap. mergeDistance welds coincident vertices
     * between neighboring instances (the artifact naive per-instance duplication produces at
     * a shared seam, e.g. adjoining tread teeth) — 0 disables welding.
     */
    static ScratchboxMesh alongCurve(
        const ScratchboxMesh& seed,
        const std::vector<Vec3>& curve,
        float pitch,
        float mergeDistance = 0.0f,
        bool fitToLength = true
    ) {
        ScratchboxMesh out("replicated_mesh");
        if (curve.size() < 2 || pitch <= 1e-6f || seed.vertices.empty()) return out;

        std::vector<float> cum(curve.size(), 0.0f);
        for (size_t i = 1; i < curve.size(); ++i) cum[i] = cum[i - 1] + (curve[i] - curve[i - 1]).length();
        float total = cum.back();
        if (total < 1e-6f) return out;

        int count = std::max(1, fitToLength
            ? static_cast<int>(std::lround(total / pitch)) + 1
            : static_cast<int>(std::floor(total / pitch)) + 1);
        std::vector<float> arcLens(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i) {
            arcLens[static_cast<size_t>(i)] = fitToLength
                ? (count > 1 ? total * static_cast<float>(i) / static_cast<float>(count - 1) : 0.0f)
                : std::min(total, pitch * static_cast<float>(i));
        }

        // An augmented curve carrying every original vertex plus every exact instance
        // position, inserted at its true arc-length place, so one rotation-minimizing-frame
        // pass gives correctly propagated frames at the instance points directly, instead of
        // re-deriving curvature locally at each one (which is what produces per-instance twist).
        std::vector<Vec3> augmented;
        std::vector<int> instanceFrame(static_cast<size_t>(count), -1);
        augmented.push_back(curve[0]);
        size_t ai = 0;
        auto stampAt = [&](float arc) {
            while (ai < arcLens.size() && arcLens[ai] <= arc + 1e-5f) {
                instanceFrame[ai] = static_cast<int>(augmented.size()) - 1;
                ++ai;
            }
        };
        stampAt(cum[0]);
        for (size_t i = 1; i < curve.size(); ++i) {
            float segStart = cum[i - 1], segEnd = cum[i];
            while (ai < arcLens.size() && arcLens[ai] < segEnd - 1e-5f) {
                float t = (arcLens[ai] - segStart) / std::max(1e-9f, segEnd - segStart);
                augmented.push_back(curve[i - 1] + (curve[i] - curve[i - 1]) * t);
                instanceFrame[ai] = static_cast<int>(augmented.size()) - 1;
                ++ai;
            }
            augmented.push_back(curve[i]);
            stampAt(segEnd);
        }
        while (ai < arcLens.size()) { instanceFrame[ai] = static_cast<int>(augmented.size()) - 1; ++ai; }

        std::vector<Sweep3D::Frame> frames = Sweep3D::rotationMinimizingFrames(augmented);

        for (int i = 0; i < count; ++i) {
            int fi = instanceFrame[static_cast<size_t>(i)];
            if (fi < 0 || static_cast<size_t>(fi) >= frames.size()) continue;
            const Sweep3D::Frame& f = frames[static_cast<size_t>(fi)];

            ScratchboxMesh instance = seed;
            for (auto& v : instance.vertices) {
                Vec3 local = v.position;
                v.position = f.origin + f.normal * local.x + f.binormal * local.y + f.tangent * local.z;
                Vec3 n = f.normal * v.normal.x + f.binormal * v.normal.y + f.tangent * v.normal.z;
                v.normal = n.length() > 1e-8f ? n.normalized() : v.normal;
                Vec3 tanXyz(v.tangent.x, v.tangent.y, v.tangent.z);
                Vec3 t = f.normal * tanXyz.x + f.binormal * tanXyz.y + f.tangent * tanXyz.z;
                if (t.length() > 1e-8f) { t = t.normalized(); v.tangent = Vec4(t.x, t.y, t.z, v.tangent.w); }
            }
            instance.recomputeBounds();
            out.append(instance);
        }

        if (mergeDistance > 1e-9f) weldCoincidentVertices(out, mergeDistance);
        out.recomputeBounds();
        return out;
    }

    /**
     * Repeats a seed mesh over a flat lattice: pitchU/pitchV spacing, countU x countV
     * instances, with alternating rows offset by rowOffsetU (brick-style bonding) when
     * alternateRows is set. originNormal/originTangent/originBinormal place the lattice
     * plane in world space (defaults: XZ plane, Y up). mergeDistance welds coincident
     * vertices between neighboring instances, as in alongCurve.
     */
    static ScratchboxMesh onGrid(
        const ScratchboxMesh& seed,
        int countU, int countV,
        float pitchU, float pitchV,
        float rowOffsetU = 0.0f,
        bool alternateRows = false,
        float mergeDistance = 0.0f,
        const Vec3& origin = Vec3(0, 0, 0),
        const Vec3& axisU = Vec3(1, 0, 0),
        const Vec3& axisV = Vec3(0, 0, 1)
    ) {
        ScratchboxMesh out("replicated_grid_mesh");
        if (countU < 1 || countV < 1 || seed.vertices.empty()) return out;

        for (int j = 0; j < countV; ++j) {
            float rowShift = (alternateRows && (j % 2 != 0)) ? rowOffsetU : 0.0f;
            for (int i = 0; i < countU; ++i) {
                Vec3 offset = origin + axisU * (static_cast<float>(i) * pitchU + rowShift) + axisV * (static_cast<float>(j) * pitchV);
                ScratchboxMesh instance = seed;
                for (auto& v : instance.vertices) v.position += offset;
                instance.recomputeBounds();
                out.append(instance);
            }
        }

        if (mergeDistance > 1e-9f) weldCoincidentVertices(out, mergeDistance);
        out.recomputeBounds();
        return out;
    }

private:
    /**
     * Merge-by-distance: welds vertices within epsilon of each other (the artifact naive
     * per-instance duplication leaves at a shared seam between adjoining replicated copies),
     * via a uniform spatial hash so it stays near-linear instead of all-pairs.
     */
    static void weldCoincidentVertices(ScratchboxMesh& mesh, float epsilon) {
        if (mesh.vertices.empty()) return;
        float cell = std::max(epsilon, 1e-6f);
        auto keyOf = [&](const Vec3& p) {
            return std::array<int64_t, 3>{
                static_cast<int64_t>(std::floor(p.x / cell)),
                static_cast<int64_t>(std::floor(p.y / cell)),
                static_cast<int64_t>(std::floor(p.z / cell))
            };
        };
        std::map<std::array<int64_t, 3>, std::vector<uint32_t>> grid;
        for (uint32_t i = 0; i < mesh.vertices.size(); ++i) grid[keyOf(mesh.vertices[i].position)].push_back(i);

        std::vector<uint32_t> remap(mesh.vertices.size());
        std::vector<uint8_t> resolved(mesh.vertices.size(), 0);
        float eps2 = epsilon * epsilon;

        for (uint32_t i = 0; i < mesh.vertices.size(); ++i) {
            if (resolved[i]) continue;
            remap[i] = i;
            resolved[i] = 1;
            auto k = keyOf(mesh.vertices[i].position);
            for (int64_t dx = -1; dx <= 1; ++dx)
            for (int64_t dy = -1; dy <= 1; ++dy)
            for (int64_t dz = -1; dz <= 1; ++dz) {
                auto it = grid.find({k[0] + dx, k[1] + dy, k[2] + dz});
                if (it == grid.end()) continue;
                for (uint32_t j : it->second) {
                    if (resolved[j] || j <= i) continue;
                    if ((mesh.vertices[j].position - mesh.vertices[i].position).lengthSq() <= eps2) {
                        remap[j] = i;
                        resolved[j] = 1;
                    }
                }
            }
        }

        std::vector<uint32_t> newIndexOf(mesh.vertices.size(), std::numeric_limits<uint32_t>::max());
        std::vector<Vertex> newVerts;
        newVerts.reserve(mesh.vertices.size());
        for (uint32_t i = 0; i < mesh.vertices.size(); ++i) {
            uint32_t root = remap[i];
            if (newIndexOf[root] == std::numeric_limits<uint32_t>::max()) {
                newIndexOf[root] = static_cast<uint32_t>(newVerts.size());
                newVerts.push_back(mesh.vertices[root]);
            }
            newIndexOf[i] = newIndexOf[root];
        }
        for (auto& idx : mesh.indices) idx = newIndexOf[idx];
        mesh.vertices = std::move(newVerts);
    }
};

class Lathe3D {
public:
    /**
     * Revolve a 2D profile curve around an axis to produce a watertight manifold.
     *
     * A full 2*PI sweep welds the seam ring (reuses the first ring's vertices
     * instead of duplicating a coincident one at the end) so smooth normals
     * blend across it instead of leaving a visible shading seam. A partial
     * sweep instead caps both open ends with a fan of the profile polyline, so
     * "watertight" holds for any totalAngleRad, not just the full circle.
     *
     * A full sweep is watertight only when the profile's own ends already sit on the axis (radius 0); a profile
     * that doesn't (a dome/spire/finial's drum, or any tube-like cross-section) leaves the top and/or bottom ring
     * open. capEnds (default false, so every existing caller's output is unchanged) closes whichever end(s) of a
     * full sweep have radius > 0 with a flat disk fanned from the axis — distinct from the partial-sweep end caps
     * above, which close the two flat radial cut faces of a wedge, not a sweep's own axial hole. Left false by
     * default because an open-ended tube/pipe/duct profile is sometimes deliberately left open, to be closed later
     * by a boolean union with whatever it connects to.
     */
    static ScratchboxMesh revolve(
        const std::vector<Vec2>& profilePoints,
        int radialSegments = 32,
        float totalAngleRad = TWO_PI,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f},
        bool capEnds = false
    ) {
        ScratchboxMesh mesh("lathed_mesh");
        if (profilePoints.size() < 2 || radialSegments < 3) return mesh;

        size_t pts = profilePoints.size();
        bool isFullSweep = std::abs(totalAngleRad - TWO_PI) < 1e-4f;
        int ringCount = isFullSweep ? radialSegments : (radialSegments + 1);

        for (int s = 0; s < ringCount; ++s) {
            float u = static_cast<float>(s) / radialSegments;
            float angle = u * totalAngleRad;
            float cosA = std::cos(angle);
            float sinA = std::sin(angle);

            for (size_t p = 0; p < pts; ++p) {
                float radius = profilePoints[p].x;
                float y = profilePoints[p].y;
                float v = static_cast<float>(p) / (pts - 1);

                Vec3 pos(radius * cosA, y, radius * sinA);
                Vec3 norm(cosA, 0.0f, sinA);
                mesh.addVertex({pos, norm, Vec2(u, v), color});
            }
        }

        for (int s = 0; s < radialSegments; ++s) {
            uint32_t s0 = static_cast<uint32_t>((s % ringCount) * pts);
            uint32_t s1 = static_cast<uint32_t>(((s + 1) % ringCount) * pts);

            for (size_t p = 0; p + 1 < pts; ++p) {
                uint32_t i0 = s0 + static_cast<uint32_t>(p);
                uint32_t i1 = s1 + static_cast<uint32_t>(p);
                uint32_t i2 = s1 + static_cast<uint32_t>(p + 1);
                uint32_t i3 = s0 + static_cast<uint32_t>(p + 1);

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }

        if (!isFullSweep) {
            // Fan-cap the profile polyline at each open end (angle = 0 and angle = totalAngleRad).
            auto capFan = [&](int ring, bool flip) {
                uint32_t base = static_cast<uint32_t>(ring * pts);
                for (size_t p = 1; p + 1 < pts; ++p) {
                    uint32_t i0 = base, i1 = base + static_cast<uint32_t>(p), i2 = base + static_cast<uint32_t>(p + 1);
                    if (flip) mesh.addTriangle(i0, i2, i1);
                    else mesh.addTriangle(i0, i1, i2);
                }
            };
            capFan(0, true);
            capFan(ringCount - 1, false);
        } else if (capEnds) {
            // Close an open axial hole at a profile end whose radius isn't already 0: a flat disk fanned from a
            // new axis-center vertex across that end's ring (fixed profile index, varying azimuthal ring s) — not
            // capFan above, which fans across profile points at one fixed azimuthal ring instead.
            auto capAxisDisk = [&](size_t profileIdx, bool normalDown) {
                float y = profilePoints[profileIdx].y;
                uint32_t centerIdx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.addVertex({Vec3(0.0f, y, 0.0f), Vec3(0, normalDown ? -1.0f : 1.0f, 0), Vec2(0.5f, 0.5f), color});
                for (int s = 0; s < radialSegments; ++s) {
                    uint32_t i0 = static_cast<uint32_t>(s * pts + profileIdx);
                    uint32_t i1 = static_cast<uint32_t>(((s + 1) % radialSegments) * pts + profileIdx);
                    if (normalDown) mesh.addTriangle(centerIdx, i1, i0);
                    else mesh.addTriangle(centerIdx, i0, i1);
                }
            };
            // Winding points the cap away from the rest of the profile (outward), whichever end is "up": compare
            // against the neighbouring profile point's y rather than assuming point 0 is the bottom.
            if (profilePoints.front().x > 1e-5f) {
                capAxisDisk(0, pts > 1 ? profilePoints[1].y >= profilePoints[0].y : true);
            }
            if (profilePoints.back().x > 1e-5f) {
                capAxisDisk(pts - 1, pts > 1 ? profilePoints[pts - 2].y >= profilePoints[pts - 1].y : false);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

// ============================================================================
// 5. Loop Subdivision Refinement (C² Continuity Surface)
// ============================================================================
class LoopSubdivision {
public:
    static ScratchboxMesh subdivide(const ScratchboxMesh& mesh, int iterations = 1) {
        ScratchboxMesh current = mesh;
        for (int iter = 0; iter < iterations; ++iter) {
            current = subdivideOnce(current);
        }
        return current;
    }

private:
    struct Edge {
        uint32_t v0, v1;
        bool operator<(const Edge& other) const {
            if (v0 != other.v0) return v0 < other.v0;
            return v1 < other.v1;
        }
    };

    static Edge makeEdge(uint32_t a, uint32_t b) {
        return a < b ? Edge{a, b} : Edge{b, a};
    }

    static ScratchboxMesh subdivideOnce(const ScratchboxMesh& inMesh) {
        ScratchboxMesh outMesh(inMesh.name + "_subdivided");
        outMesh.material = inMesh.material;

        size_t nVerts = inMesh.vertices.size();
        std::map<Edge, std::vector<uint32_t>> edgeOpposites;
        std::vector<std::set<uint32_t>> vertexAdj(nVerts);

        for (size_t i = 0; i + 2 < inMesh.indices.size(); i += 3) {
            uint32_t i0 = inMesh.indices[i], i1 = inMesh.indices[i+1], i2 = inMesh.indices[i+2];

            edgeOpposites[makeEdge(i0, i1)].push_back(i2);
            edgeOpposites[makeEdge(i1, i2)].push_back(i0);
            edgeOpposites[makeEdge(i2, i0)].push_back(i1);

            vertexAdj[i0].insert(i1); vertexAdj[i0].insert(i2);
            vertexAdj[i1].insert(i0); vertexAdj[i1].insert(i2);
            vertexAdj[i2].insert(i0); vertexAdj[i2].insert(i1);
        }

        // 1. Compute new positions for existing vertices using Loop weights
        for (size_t i = 0; i < nVerts; ++i) {
            const auto& neighbors = vertexAdj[i];
            size_t k = neighbors.size();
            Vec3 newPos;

            if (k >= 3) {
                float beta;
                if (k == 3) {
                    beta = 3.0f / 16.0f;
                } else {
                    float val = 3.0f / 8.0f + 0.25f * std::cos(TWO_PI / k);
                    beta = (1.0f / static_cast<float>(k)) * (5.0f / 8.0f - val * val);
                }

                Vec3 sumNeighbors(0, 0, 0);
                for (uint32_t nIdx : neighbors) {
                    sumNeighbors += inMesh.vertices[nIdx].position;
                }
                newPos = inMesh.vertices[i].position * (1.0f - static_cast<float>(k) * beta) + sumNeighbors * beta;
            } else {
                newPos = inMesh.vertices[i].position;
            }

            outMesh.addVertex({newPos, inMesh.vertices[i].normal, inMesh.vertices[i].uv, inMesh.vertices[i].color});
        }

        // 2. Compute edge midpoint vertices with 3/8 weighting rule
        std::map<Edge, uint32_t> edgeMidpointMap;
        for (const auto& [edge, opposites] : edgeOpposites) {
            Vec3 pA = inMesh.vertices[edge.v0].position;
            Vec3 pB = inMesh.vertices[edge.v1].position;
            Vec3 edgePos;

            if (opposites.size() == 2) {
                Vec3 pC = inMesh.vertices[opposites[0]].position;
                Vec3 pD = inMesh.vertices[opposites[1]].position;
                edgePos = (pA + pB) * (3.0f / 8.0f) + (pC + pD) * (1.0f / 8.0f);
            } else {
                edgePos = (pA + pB) * 0.5f;
            }

            Vec2 uv = (inMesh.vertices[edge.v0].uv + inMesh.vertices[edge.v1].uv) * 0.5f;
            Vec4 color = (inMesh.vertices[edge.v0].color + inMesh.vertices[edge.v1].color) * 0.5f;

            uint32_t newIdx = static_cast<uint32_t>(outMesh.vertices.size());
            outMesh.addVertex({edgePos, Vec3(0, 1, 0), uv, color});
            edgeMidpointMap[edge] = newIdx;
        }

        // 3. Subdivide each triangle into 4 sub-triangles
        for (size_t i = 0; i + 2 < inMesh.indices.size(); i += 3) {
            uint32_t v0 = inMesh.indices[i];
            uint32_t v1 = inMesh.indices[i+1];
            uint32_t v2 = inMesh.indices[i+2];

            uint32_t m01 = edgeMidpointMap[makeEdge(v0, v1)];
            uint32_t m12 = edgeMidpointMap[makeEdge(v1, v2)];
            uint32_t m20 = edgeMidpointMap[makeEdge(v2, v0)];

            outMesh.addTriangle(v0, m01, m20);
            outMesh.addTriangle(v1, m12, m01);
            outMesh.addTriangle(v2, m20, m12);
            outMesh.addTriangle(m01, m12, m20);
        }

        outMesh.recomputeSmoothNormals();
        outMesh.recomputeBounds();
        return outMesh;
    }
};

// ============================================================================
// 6. Mesh Topology & Manifold Cleaner
// ============================================================================
class MeshTopologyCleaner {
public:
    static void weldCoincidentVertices(ScratchboxMesh& mesh, float epsilon = 1e-4f) {
        if (mesh.vertices.empty()) return;

        struct CellCoord {
            int64_t x, y, z;
            bool operator==(const CellCoord& o) const { return x == o.x && y == o.y && z == o.z; }
        };

        struct CellHasher {
            size_t operator()(const CellCoord& c) const {
                size_t h = 14695981039346656037ULL;
                h = (h ^ static_cast<size_t>(c.x)) * 1099511628211ULL;
                h = (h ^ static_cast<size_t>(c.y)) * 1099511628211ULL;
                h = (h ^ static_cast<size_t>(c.z)) * 1099511628211ULL;
                return h;
            }
        };

        float invCell = 1.0f / epsilon;
        std::unordered_map<CellCoord, std::vector<uint32_t>, CellHasher> grid;
        std::vector<Vertex> uniqueVertices;
        std::vector<uint32_t> remap(mesh.vertices.size());
        float epsSq = epsilon * epsilon;

        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            const auto& p = mesh.vertices[i].position;
            int64_t cx = static_cast<int64_t>(std::floor(p.x * invCell));
            int64_t cy = static_cast<int64_t>(std::floor(p.y * invCell));
            int64_t cz = static_cast<int64_t>(std::floor(p.z * invCell));

            int foundIdx = -1;
            for (int64_t dx = -1; dx <= 1 && foundIdx < 0; ++dx) {
                for (int64_t dy = -1; dy <= 1 && foundIdx < 0; ++dy) {
                    for (int64_t dz = -1; dz <= 1 && foundIdx < 0; ++dz) {
                        CellCoord neighbor{cx + dx, cy + dy, cz + dz};
                        auto it = grid.find(neighbor);
                        if (it != grid.end()) {
                            for (uint32_t uIdx : it->second) {
                                if ((mesh.vertices[i].position - uniqueVertices[uIdx].position).lengthSq() <= epsSq) {
                                    foundIdx = static_cast<int>(uIdx);
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (foundIdx >= 0) {
                remap[i] = static_cast<uint32_t>(foundIdx);
            } else {
                uint32_t newIdx = static_cast<uint32_t>(uniqueVertices.size());
                remap[i] = newIdx;
                uniqueVertices.push_back(mesh.vertices[i]);
                grid[{cx, cy, cz}].push_back(newIdx);
            }
        }

        mesh.vertices = std::move(uniqueVertices);
        for (auto& idx : mesh.indices) {
            idx = remap[idx];
        }

        removeDegenerateFaces(mesh);
        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

    static void removeDegenerateFaces(ScratchboxMesh& mesh, float minArea = 1e-7f) {
        std::vector<uint32_t> cleanIndices;
        for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
            uint32_t i0 = mesh.indices[i];
            uint32_t i1 = mesh.indices[i+1];
            uint32_t i2 = mesh.indices[i+2];

            if (i0 == i1 || i1 == i2 || i2 == i0) continue;

            Vec3 v0 = mesh.vertices[i0].position;
            Vec3 v1 = mesh.vertices[i1].position;
            Vec3 v2 = mesh.vertices[i2].position;

            float area = (v1 - v0).cross(v2 - v0).length() * 0.5f;
            if (area >= minArea) {
                cleanIndices.push_back(i0);
                cleanIndices.push_back(i1);
                cleanIndices.push_back(i2);
            }
        }
        mesh.indices = std::move(cleanIndices);
    }
};

// ============================================================================
// 8. Weighted Normal Micro-Bevel Engine (Blender Weighted Normal Modifier)
// ============================================================================
struct WeightedNormalOptions {
    float weightPower{1.0f};          // Power of face area weighting (1.0 = linear area, 2.0 = quadratic)
    float thresholdAngleDeg{45.0f};   // Maximum dihedral angle to smooth across
    bool keepSharpEdges{true};
};

class BevelEngine {
public:
    using Options = WeightedNormalOptions;
    using WeightedNormalOptions = scratchbox::shaper::WeightedNormalOptions;

    /**
     * Applies area-weighted face normals to vertex normals.
     * Replicates the Blender "Weighted Normal" modifier: larger polygons retain their
     * true geometric normal, while small bevel chamfer polygons smoothly transition normals,
     * yielding razor-sharp planar highlights and soft rounded edge glints without adding geometry.
     */
    static void applyWeightedNormals(
        ScratchboxMesh& mesh,
        const WeightedNormalOptions& options = {}
    ) {
        if (mesh.vertices.empty() || mesh.indices.size() < 3) return;

        std::vector<Vec3> accumNormals(mesh.vertices.size(), Vec3(0, 0, 0));
        float thresholdCos = std::cos(options.thresholdAngleDeg * math::DEG_TO_RAD);

        // Precompute face normals and areas
        size_t numFaces = mesh.indices.size() / 3;
        std::vector<Vec3> faceNormals(numFaces);
        std::vector<float> faceWeights(numFaces);

        for (size_t f = 0; f < numFaces; ++f) {
            uint32_t i0 = mesh.indices[f * 3];
            uint32_t i1 = mesh.indices[f * 3 + 1];
            uint32_t i2 = mesh.indices[f * 3 + 2];

            Vec3 v0 = mesh.vertices[i0].position;
            Vec3 v1 = mesh.vertices[i1].position;
            Vec3 v2 = mesh.vertices[i2].position;

            Vec3 cross = (v1 - v0).cross(v2 - v0);
            float area = cross.length() * 0.5f;
            faceNormals[f] = (area > 1e-8f) ? cross / (area * 2.0f) : Vec3(0, 1, 0);
            faceWeights[f] = std::pow(std::max(1e-6f, area), options.weightPower);
        }

        // Accumulate weighted normals onto vertices
        for (size_t f = 0; f < numFaces; ++f) {
            const Vec3& fn = faceNormals[f];
            float w = faceWeights[f];

            for (int k = 0; k < 3; ++k) {
                uint32_t idx = mesh.indices[f * 3 + k];
                // Check dihedral threshold against original vertex normal if sharp edges are preserved
                if (options.keepSharpEdges) {
                    float cosTheta = fn.dot(mesh.vertices[idx].normal);
                    if (cosTheta < thresholdCos) {
                        continue; // Do not bleed normal across sharp edge
                    }
                }
                accumNormals[idx] += fn * w;
            }
        }

        // Normalize accumulated normals
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            if (accumNormals[i].lengthSq() > 1e-8f) {
                mesh.vertices[i].normal = accumNormals[i].normalized();
            }
        }
    }
};

} // namespace shaper
} // namespace scratchbox

#endif // SCRATCHBOX_SHAPER_HPP
