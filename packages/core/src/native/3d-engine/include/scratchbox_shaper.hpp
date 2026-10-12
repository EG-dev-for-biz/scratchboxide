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

// ============================================================================
// 4. Parametric Sweeps: Loft3D, Lathe3D, Sweep3D
// ============================================================================
class Loft3D {
public:
    /**
     * Lofts a smooth 3D skin between consecutive cross-sectional polygonal loops.
     *
     * The skin always winds outward, whichever way the loops run around the loft
     * direction, and the end caps wind consistently with the side quads.
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

        auto loopCentroid = [&](const std::vector<Vec3>& loop) {
            Vec3 c(0, 0, 0);
            for (const auto& pt : loop) c += pt;
            return c * (1.0f / ptsPerSlice);
        };
        const size_t lastS = slices.size() - 1;
        const Vec3 botCenter = loopCentroid(slices[0]);
        const Vec3 topCenter = loopCentroid(slices[lastS]);

        // Signed volume (x6) of the side quads below closed by centroid fans at both
        // ends, taken about botCenter. Negative means the loops run the other way round
        // the loft direction and every triangle must be flipped to face outward. Open
        // lofts are measured the same way so their skin also faces away from the axis.
        double signedVolume6 = 0.0;
        for (size_t s = 0; s < lastS; ++s) {
            for (size_t p = 0; p < ptsPerSlice; ++p) {
                size_t nextP = (p + 1) % ptsPerSlice;
                Vec3 a = slices[s][p] - botCenter;
                Vec3 b = slices[s + 1][p] - botCenter;
                Vec3 c = slices[s + 1][nextP] - botCenter;
                Vec3 d = slices[s][nextP] - botCenter;
                signedVolume6 += a.dot(b.cross(c)) + a.dot(c.cross(d));
            }
        }
        for (size_t p = 0; p < ptsPerSlice; ++p) {
            size_t nextP = (p + 1) % ptsPerSlice;
            signedVolume6 += (topCenter - botCenter).dot(
                (slices[lastS][nextP] - botCenter).cross(slices[lastS][p] - botCenter));
        }
        const bool flip = signedVolume6 < 0.0;
        auto addTri = [&](uint32_t a, uint32_t b, uint32_t c) {
            if (flip) mesh.addTriangle(a, c, b);
            else mesh.addTriangle(a, b, c);
        };

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

                addTri(i0, i1, i2);
                addTri(i0, i2, i3);
            }
        }

        // Optional end capping: centroid fans wound to traverse each rim edge opposite to
        // the side quad that shares it. The fans reuse the end-ring vertices so the skin
        // stays index-watertight; LoopSubdivision and the SculptEngine brushes (which move
        // vertices along their normals or index neighbours) would tear a duplicated rim.
        if (closeEnds) {
            uint32_t botCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex({botCenter, Vec3(0, -1, 0), Vec2(0.5f, 0.5f), color});
            for (size_t p = 0; p < ptsPerSlice; ++p) {
                size_t nextP = (p + 1) % ptsPerSlice;
                addTri(botCenterIdx, static_cast<uint32_t>(p), static_cast<uint32_t>(nextP));
            }

            uint32_t topCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.addVertex({topCenter, Vec3(0, 1, 0), Vec2(0.5f, 0.5f), color});
            uint32_t topOffset = static_cast<uint32_t>(lastS * ptsPerSlice);
            for (size_t p = 0; p < ptsPerSlice; ++p) {
                size_t nextP = (p + 1) % ptsPerSlice;
                addTri(topCenterIdx, topOffset + static_cast<uint32_t>(nextP), topOffset + static_cast<uint32_t>(p));
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

class Lathe3D {
public:
    /**
     * Revolve a 2D profile curve around an axis to produce a watertight manifold.
     */
    static ScratchboxMesh revolve(
        const std::vector<Vec2>& profilePoints,
        int radialSegments = 32,
        float totalAngleRad = TWO_PI,
        const Vec4& color = {0.8f, 0.85f, 0.9f, 1.0f}
    ) {
        ScratchboxMesh mesh("lathed_mesh");
        if (profilePoints.size() < 2 || radialSegments < 3) return mesh;

        size_t pts = profilePoints.size();
        for (int s = 0; s <= radialSegments; ++s) {
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
            uint32_t s0 = static_cast<uint32_t>(s * pts);
            uint32_t s1 = static_cast<uint32_t>((s + 1) * pts);

            for (size_t p = 0; p + 1 < pts; ++p) {
                uint32_t i0 = s0 + static_cast<uint32_t>(p);
                uint32_t i1 = s1 + static_cast<uint32_t>(p);
                uint32_t i2 = s1 + static_cast<uint32_t>(p + 1);
                uint32_t i3 = s0 + static_cast<uint32_t>(p + 1);

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
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
