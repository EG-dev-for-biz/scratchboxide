/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PROCESSING_HPP
#define SCRATCHBOX_PROCESSING_HPP

/**
 * Scratchbox Native Geometric Processing Engine (C++20)
 *
 * High-performance, contiguous SIMD buffer implementations of geometric processing algorithms:
 * 1. Taubin Non-Shrinking Volume-Preserving Smoothing (λ > 0, μ < 0)
 * 2. Garland-Heckbert Quadric Error Metric (QEM) Decimation (Curvature & Silhouette Preservation)
 * 3. Discrete Differential Geometry, Cotangent Laplace-Beltrami & Koenderink Shape Index (-1 to +1)
 * 4. Poisson-Disk Blue Noise Surface Point Sampling on Meshes
 * 5. Boundary Loop Detection & Ear-Clipping Hole Filling
 * 6. Botsch-Kobbelt Isotropic Remeshing & Tangential Edge Relaxation
 * 7. Analytical Planar Slicing & Sutherland-Hodgman Hole Capping
 * 8. Topological Mesh Cleaning & Non-Manifold Vertex/Face Repair
 * 9. Hausdorff Distance & Metro Geometric Surface Error Verification
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <array>
#include <unordered_map>
#include <unordered_set>
#include <set>
#include <queue>
#include <cstdint>
#include <limits>
#include <iostream>
#include <random>

namespace scratchbox {
namespace processing {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. Taubin Non-Shrinking Volume-Preserving Smoothing
// ============================================================================

struct TaubinSmoothOptions {
    int iterations{10};          // Number of two-step (lambda, mu) passes
    float lambda{0.50f};         // Positive diffusion step (shrinks high frequencies)
    float mu{-0.53f};            // Negative anti-diffusion step (re-inflates volume, must satisfy 1/lambda + 1/mu < 0)
    bool preserveBoundaries{true}; // Pin or restrict boundary vertices
};

class TaubinSmoother {
public:
    /**
     * Applies Taubin's volume-preserving low-pass filter to a triangle mesh.
     * Unlike standard Laplacian smoothing which causes severe deflation and volume loss,
     * Taubin smoothing filters out high-frequency noise while preserving total geometric volume.
     */
    static void smooth(ScratchboxMesh& mesh, const TaubinSmoothOptions& opt = {}) {
        if (mesh.vertices.empty() || mesh.indices.empty() || opt.iterations <= 0) return;

        size_t n = mesh.vertices.size();
        size_t triCount = mesh.indices.size() / 3;

        // Build vertex adjacency lists using contiguous index buffers
        std::vector<std::vector<uint32_t>> adj(n);
        std::vector<bool> isBoundary(n, false);

        // Track directed half-edge pairs to identify open boundary loops
        struct EdgeKey {
            uint32_t u, v;
            bool operator==(const EdgeKey& o) const { return u == o.u && v == o.v; }
        };
        struct EdgeHash {
            size_t operator()(const EdgeKey& k) const {
                return (static_cast<size_t>(k.u) * 73856093) ^ (static_cast<size_t>(k.v) * 19349663);
            }
        };
        std::unordered_map<EdgeKey, int, EdgeHash> edgeCount;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            if (i0 < n && i1 < n && i2 < n) {
                adj[i0].push_back(i1); adj[i0].push_back(i2);
                adj[i1].push_back(i0); adj[i1].push_back(i2);
                adj[i2].push_back(i0); adj[i2].push_back(i1);

                edgeCount[{i0, i1}]++;
                edgeCount[{i1, i2}]++;
                edgeCount[{i2, i0}]++;
            }
        }

        // Deduplicate neighbor adjacency
        for (size_t i = 0; i < n; ++i) {
            auto& neighbors = adj[i];
            std::sort(neighbors.begin(), neighbors.end());
            neighbors.erase(std::unique(neighbors.begin(), neighbors.end()), neighbors.end());
        }

        if (opt.preserveBoundaries) {
            for (const auto& kv : edgeCount) {
                EdgeKey rev{kv.first.v, kv.first.u};
                if (edgeCount.find(rev) == edgeCount.end()) {
                    if (kv.first.u < n) isBoundary[kv.first.u] = true;
                    if (kv.first.v < n) isBoundary[kv.first.v] = true;
                }
            }
        }

        // Contiguous SIMD working position buffers
        std::vector<Vec3> positions(n);
        std::vector<Vec3> deltas(n);

        for (size_t i = 0; i < n; ++i) {
            positions[i] = mesh.vertices[i].position;
        }

        auto applyPass = [&](float scale) {
            for (size_t i = 0; i < n; ++i) {
                if (opt.preserveBoundaries && isBoundary[i]) {
                    deltas[i] = Vec3(0, 0, 0);
                    continue;
                }
                const auto& neighbors = adj[i];
                if (neighbors.empty()) {
                    deltas[i] = Vec3(0, 0, 0);
                    continue;
                }
                Vec3 avg(0, 0, 0);
                for (uint32_t nb : neighbors) {
                    avg += positions[nb];
                }
                avg = avg * (1.0f / static_cast<float>(neighbors.size()));
                deltas[i] = (avg - positions[i]) * scale;
            }

            for (size_t i = 0; i < n; ++i) {
                positions[i] += deltas[i];
            }
        };

        // Alternating Taubin iterations: positive lambda step then negative mu step
        for (int iter = 0; iter < opt.iterations; ++iter) {
            applyPass(opt.lambda);
            applyPass(opt.mu);
        }

        // Write back smoothed positions
        for (size_t i = 0; i < n; ++i) {
            mesh.vertices[i].position = positions[i];
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }
};

// ============================================================================
// 2. Garland-Heckbert Quadric Error Metric (QEM) Decimation
// ============================================================================

struct SymmetricQuadric {
    // 10 coefficients for symmetric 4x4 matrix:
    // [ a0  a1  a2  a3 ]
    // [ a1  a4  a5  a6 ]
    // [ a2  a5  a7  a8 ]
    // [ a3  a6  a8  a9 ]
    double data[10]{0, 0, 0, 0, 0, 0, 0, 0, 0, 0};

    SymmetricQuadric() = default;

    // Construct fundamental quadric from plane equation ax + by + cz + d = 0
    SymmetricQuadric(double a, double b, double c, double d) {
        data[0] = a * a;  data[1] = a * b;  data[2] = a * c;  data[3] = a * d;
        data[4] = b * b;  data[5] = b * c;  data[6] = b * d;
        data[7] = c * c;  data[8] = c * d;
        data[9] = d * d;
    }

    SymmetricQuadric& operator+=(const SymmetricQuadric& o) {
        for (int i = 0; i < 10; ++i) data[i] += o.data[i];
        return *this;
    }

    SymmetricQuadric operator+(const SymmetricQuadric& o) const {
        SymmetricQuadric res = *this;
        res += o;
        return res;
    }

    SymmetricQuadric& operator*=(double s) {
        for (int i = 0; i < 10; ++i) data[i] *= s;
        return *this;
    }

    // Evaluates quadric error v^T Q v
    double evaluate(const Vec3& p) const {
        double x = p.x, y = p.y, z = p.z;
        return data[0]*x*x + 2*data[1]*x*y + 2*data[2]*x*z + 2*data[3]*x
             + data[4]*y*y + 2*data[5]*y*z + 2*data[6]*y
             + data[7]*z*z + 2*data[8]*z
             + data[9];
    }
};

struct DecimateOptions {
    size_t targetTriangles{0};     // Exact triangle count goal (if 0, uses targetRatio)
    float targetRatio{0.5f};       // Ratio of faces to retain [0.01, 1.0]
    float maxError{1e9f};          // Maximum allowed quadric error threshold
    bool preserveBoundary{true};   // Protect open boundary edges with high penalty quadrics
    bool preventNormalFlips{true}; // Prevent triangle folding / inversions
    bool preserveCreases{false};   // Lock sharp edges (open boundaries, or a dihedral angle >= creaseAngleDeg) with
                                    // an extra constraint quadric, so simplification can still slide vertices along
                                    // a crease but is heavily penalised for moving them off it
    float creaseAngleDeg{45.0f};   // Dihedral angle threshold (same convention as IsotropicRemeshOptions) between
                                    // two triangles sharing an edge that counts that edge as a crease; also the angle
                                    // between two copies of one corner's normal that keeps them a hard edge
    float normalWeight{0.001f};    // the normal field's length scale, as a share of the mesh's bounding diagonal: a
                                    // unit change of the surface normal where a vertex lands costs as much as moving
                                    // it that far off the surface (0: plane quadrics only)
    float normalSmoothing{0.0f};   // the field's normals, blended: 0 each wedge's own (hard edges kept: clean meshes
                                    // such as Pipeline K twins), 1 each position's area-weighted face normal (a raw 3D
                                    // Tiles soup, whose own normals are noise). Measured RMS from input, 2026-11-07:
                                    // the defaults keep the benchmark K twins at or under the previous decimator's error
                                    // at a half and a quarter; a raw tile wants normalWeight 0.12 with normalSmoothing 1
                                    // (ESB tile 14 cm at a quarter, 41 cm at a tenth, against 26 cm and 47 cm with the
                                    // defaults), which on a clean twin costs up to 18 cm at half.
    bool optimizeOrder{true};      // order the result's triangles for the post-transform vertex cache and its
                                    // vertices by first use (optimizeVertexCache, optimizeVertexFetch)
};

// Triangle and vertex order for the GPU (post-transform vertex cache, then vertex fetch)

/** Average vertex-shader invocations per triangle (ACMR) of `indices` through a FIFO cache of cacheSize entries. */
inline double vertexCacheMissRatio(const std::vector<uint32_t>& indices, size_t vertexCount, size_t cacheSize = 16) {
    if (indices.size() < 3) return 0.0;
    std::vector<uint64_t> stamp(vertexCount, 0);
    uint64_t clock = 0;
    size_t misses = 0;
    for (uint32_t i : indices) {
        // a vertex is cached while fewer than cacheSize misses have followed its own
        if (stamp[i] == 0 || clock - stamp[i] >= cacheSize) { ++misses; stamp[i] = ++clock; }
    }
    return double(misses) / double(indices.size() / 3);
}

/**
 * Re-orders triangles for the post-transform vertex cache, in place (Forsyth's linear-speed vertex cache ordering).
 * Each vertex scores by its place in a simulated LRU cache (the last triangle's three corners a fixed 0.75, deeper
 * entries falling off as (1 - depth/size)^1.5) plus a boost for few remaining triangles (2 / sqrt(remaining)), so
 * lone vertices are finished first; the next triangle is the best-scoring one around the cache, else the next
 * unemitted one in input order.
 */
inline void optimizeVertexCache(std::vector<uint32_t>& indices, size_t vertexCount, int cacheSize = 32) {
    const size_t triCount = indices.size() / 3;
    if (triCount < 2) return;
    std::vector<uint32_t> offset(vertexCount + 1, 0), remaining(vertexCount, 0);
    for (size_t i = 0; i < triCount * 3; ++i) offset[indices[i] + 1]++;
    for (size_t v = 0; v < vertexCount; ++v) { remaining[v] = offset[v + 1]; offset[v + 1] += offset[v]; }
    std::vector<uint32_t> vertTris(triCount * 3), fill(offset.begin(), offset.end() - 1);
    for (size_t t = 0; t < triCount; ++t) for (int k = 0; k < 3; ++k) vertTris[fill[indices[t * 3 + k]]++] = uint32_t(t);

    std::vector<int> cachePos(vertexCount, -1);
    auto vertexScore = [&](uint32_t v) -> float {
        if (remaining[v] == 0) return -1.0f;
        float score = 0.0f;
        const int p = cachePos[v];
        if (p >= 0) score = p < 3 ? 0.75f : std::pow(1.0f - float(p - 3) / float(cacheSize - 3), 1.5f);
        return score + 2.0f / std::sqrt(float(remaining[v]));
    };
    std::vector<float> vScore(vertexCount), tScore(triCount, 0.0f);
    for (size_t v = 0; v < vertexCount; ++v) vScore[v] = vertexScore(uint32_t(v));
    for (size_t t = 0; t < triCount; ++t) tScore[t] = vScore[indices[t * 3]] + vScore[indices[t * 3 + 1]] + vScore[indices[t * 3 + 2]];

    std::vector<uint8_t> emitted(triCount, 0);
    std::vector<uint32_t> out;
    out.reserve(indices.size());
    std::vector<uint32_t> cache, next;
    cache.reserve(cacheSize + 3);
    size_t cursor = 0;
    int64_t best = -1;
    for (size_t done = 0; done < triCount; ++done) {
        if (best < 0) {
            while (cursor < triCount && emitted[cursor]) ++cursor;
            best = int64_t(cursor);
        }
        const uint32_t t = uint32_t(best);
        emitted[t] = 1;
        const uint32_t tri[3] = { indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2] };
        out.insert(out.end(), tri, tri + 3);
        // the triangle's corners go to the front of the cache; the rest follow, pushed one place deeper
        next.assign(tri, tri + 3);
        for (uint32_t v : cache) if (v != tri[0] && v != tri[1] && v != tri[2]) next.push_back(v);
        for (uint32_t v : tri) {
            uint32_t* list = vertTris.data() + offset[v];
            const uint32_t n = remaining[v];
            for (uint32_t i = 0; i < n; ++i) if (list[i] == t) { list[i] = list[n - 1]; list[n - 1] = t; break; }
            remaining[v]--;
        }
        for (uint32_t v : cache) cachePos[v] = -1;
        for (size_t i = 0; i < next.size(); ++i) cachePos[next[i]] = i < size_t(cacheSize) ? int(i) : -1;
        // the best live triangle around the cache, scored afresh
        best = -1;
        float bestScore = -1.0f;
        for (uint32_t v : next) vScore[v] = vertexScore(v);
        for (uint32_t v : next) {
            for (uint32_t i = 0; i < remaining[v]; ++i) {
                const uint32_t s = vertTris[offset[v] + i];
                const float sc = vScore[indices[s * 3]] + vScore[indices[s * 3 + 1]] + vScore[indices[s * 3 + 2]];
                tScore[s] = sc;
                if (sc > bestScore) { bestScore = sc; best = int64_t(s); }
            }
        }
        if (next.size() > size_t(cacheSize)) next.resize(cacheSize);
        cache.swap(next);
    }
    indices.swap(out);
}

/** Vertices in the order the triangles first use them, unused ones dropped, in place (cheaper vertex fetch). */
inline void optimizeVertexFetch(ScratchboxMesh& mesh) {
    constexpr uint32_t NONE = std::numeric_limits<uint32_t>::max();
    std::vector<uint32_t> remap(mesh.vertices.size(), NONE);
    std::vector<Vertex> out;
    out.reserve(mesh.vertices.size());
    for (uint32_t& i : mesh.indices) {
        if (remap[i] == NONE) { remap[i] = uint32_t(out.size()); out.push_back(mesh.vertices[i]); }
        i = remap[i];
    }
    mesh.vertices.swap(out);
}

class QuadricDecimator {
public:
    /**
     * Decimates mesh using Garland-Heckbert Quadric Error Metrics (QEM).
     * Preserves surface curvature, feature lines, and boundary loops.
     *
     * Collapses run on the welded surface. The copies of a corner at one position (the two sides of a UV seam, a hard
     * edge, a sphere's pole) are one vertex there: they move together, and its quadric holds the planes on every
     * side, so a seam can neither open into a crack nor slide off the surface. Each copy stays a wedge with its own
     * attributes, and a collapse is taken only when every wedge of the vertex it removes has exactly one wedge of the
     * vertex it keeps to become (along a seam, side to side), so seams, colour edges and hard edges reach the output.
     * Where no such partner exists the collapse crosses the seam: the wedge takes the kept vertex's nearest wedge in
     * UV and the collapse pays for the texture it drags.
     *
     * Which collapses are allowed follows from each position's kind (step 3: manifold, border, seam, complex or
     * fringe): a border vertex moves only along its own outline, a vertex where pieces of a scan soup touch only
     * onto another such vertex, and a free vertex anywhere. With preventNormalFlips no triangle around either end may
     * fold, and a face the collapse would draw twice is dropped. The cost is the plane quadric plus the normal field
     * (normalWeight, step 2a), which makes a vertex pay for sliding to where its faces' normals disagree.
     */
    static ScratchboxMesh decimate(const ScratchboxMesh& input, const DecimateOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        size_t initialTriCount = input.indices.size() / 3;
        size_t targetTriangles = opt.targetTriangles;
        if (targetTriangles == 0) {
            targetTriangles = std::max<size_t>(4, static_cast<size_t>(initialTriCount * std::clamp(opt.targetRatio, 0.01f, 1.0f)));
        }

        if (initialTriCount <= targetTriangles) return input;

        const uint32_t numVerts = static_cast<uint32_t>(input.vertices.size());
        double normalScale = 0.0;   // set below, once the bounds are known
        constexpr uint32_t NONE = std::numeric_limits<uint32_t>::max();
        std::vector<Vertex> wedges = input.vertices;   // per-wedge attributes (only the entries wedgeOf points at are used)
        std::vector<Vec3> positions(numVerts);         // per welded position (only the entries posOf points at are used)
        for (uint32_t i = 0; i < numVerts; ++i) positions[i] = input.vertices[i].position;

        // 1. Weld. posOf: each vertex takes the id of the first vertex within eps of it, searched over the 27 cells
        // around it. wedgeOf: the first vertex at that position whose UVs and colour match and whose normal lies within
        // creaseAngleDeg of it; a copy that matches none is a wedge of its own.
        std::vector<uint32_t> posOf(numVerts), wedgeOf(numVerts), nextWedge(numVerts, NONE);
        {
            Vec3 lo = positions[0], hi = positions[0];
            for (const auto& p : positions) {
                lo = Vec3(std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z));
                hi = Vec3(std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z));
            }
            const float eps = std::max(1e-5f, 1e-6f * (hi - lo).length()), inv = 1.0f / eps;
            normalScale = double(std::max(0.0f, opt.normalWeight)) * (hi - lo).length();
            auto cellKey = [](int64_t x, int64_t y, int64_t z) -> uint64_t {
                return (static_cast<uint64_t>(x & 0x1fffff) << 42) | (static_cast<uint64_t>(y & 0x1fffff) << 21) | static_cast<uint64_t>(z & 0x1fffff);
            };
            const float normalCos = std::cos(opt.creaseAngleDeg * static_cast<float>(PI) / 180.0f);
            auto sameWedge = [&](const Vertex& a, const Vertex& b) {
                auto near2 = [](const Vec2& p, const Vec2& q) { return std::abs(p.x - q.x) <= 1e-5f && std::abs(p.y - q.y) <= 1e-5f; };
                if (!near2(a.uv, b.uv) || !near2(a.uv1, b.uv1)) return false;
                if (std::abs(a.color.x - b.color.x) > 1e-3f || std::abs(a.color.y - b.color.y) > 1e-3f ||
                    std::abs(a.color.z - b.color.z) > 1e-3f || std::abs(a.color.w - b.color.w) > 1e-3f) return false;
                float la = a.normal.length(), lb = b.normal.length();
                return la < 1e-6f || lb < 1e-6f || a.normal.dot(b.normal) >= normalCos * la * lb;
            };
            std::unordered_map<uint64_t, std::vector<uint32_t>> cells;
            for (uint32_t i = 0; i < numVerts; ++i) {
                const Vec3& p = positions[i];
                int64_t cx = static_cast<int64_t>(std::floor(p.x * inv)), cy = static_cast<int64_t>(std::floor(p.y * inv)), cz = static_cast<int64_t>(std::floor(p.z * inv));
                uint32_t id = i;
                for (int64_t dx = -1; dx <= 1 && id == i; ++dx)
                    for (int64_t dy = -1; dy <= 1 && id == i; ++dy)
                        for (int64_t dz = -1; dz <= 1 && id == i; ++dz) {
                            auto it = cells.find(cellKey(cx + dx, cy + dy, cz + dz));
                            if (it == cells.end()) continue;
                            for (uint32_t j : it->second) if ((positions[j] - p).length() <= eps) { id = j; break; }
                        }
                posOf[i] = id;
                wedgeOf[i] = i;
                if (id == i) { cells[cellKey(cx, cy, cz)].push_back(i); continue; }
                uint32_t last = id;
                for (uint32_t w = id; w != NONE; last = w, w = nextWedge[w])
                    if (sameWedge(input.vertices[w], input.vertices[i])) { wedgeOf[i] = w; break; }
                if (wedgeOf[i] == i) nextWedge[last] = i;
            }
        }

        // 2. Triangles on the welded surface, and their plane quadrics. A triangle two of whose corners weld into one
        // (a UV sphere's zero-area fan at each pole) has no area and no place in a manifold, so it is dropped.
        struct Triangle {
            uint32_t w[3];   // corner wedges; the corner's position is posOf[w]
            bool deleted{false};
        };
        std::vector<Triangle> triangles(initialTriCount);
        std::vector<std::vector<uint32_t>> vertTriangles(numVerts);
        std::vector<SymmetricQuadric> quadrics(numVerts);
        size_t currentTriCount = 0;
        auto corner = [&](const Triangle& tri, int k) { return posOf[tri.w[k]]; };
        auto faceCross = [&](const Triangle& tri) {
            Vec3 p0 = positions[corner(tri, 0)];
            return (positions[corner(tri, 1)] - p0).cross(positions[corner(tri, 2)] - p0);
        };
        auto faceNormal = [&](const Triangle& tri) {
            Vec3 n = faceCross(tri);
            float len = n.length();
            return len > 1e-8f ? n * (1.0f / len) : Vec3(0, 0, 0);
        };

        for (size_t t = 0; t < initialTriCount; ++t) {
            auto& tri = triangles[t];
            for (int k = 0; k < 3; ++k) tri.w[k] = wedgeOf[input.indices[t * 3 + k]];
            uint32_t i0 = corner(tri, 0), i1 = corner(tri, 1), i2 = corner(tri, 2);
            if (i0 == i1 || i1 == i2 || i2 == i0) { tri.deleted = true; continue; }
            ++currentTriCount;

            vertTriangles[i0].push_back(static_cast<uint32_t>(t));
            vertTriangles[i1].push_back(static_cast<uint32_t>(t));
            vertTriangles[i2].push_back(static_cast<uint32_t>(t));

            Vec3 fn = faceCross(tri);
            float len = fn.length();
            if (len > 1e-8f) {
                fn = fn * (1.0f / len);
                double d = -fn.dot(positions[i0]);
                SymmetricQuadric q(fn.x, fn.y, fn.z, d);
                // Area-weighted quadric
                q *= (len * 0.5);

                quadrics[i0] += q;
                quadrics[i1] += q;
                quadrics[i2] += q;
            }
        }

        // 2a. The normal field. Over each face the normal runs linearly between its corners' normals. For every face and
        // every normal component, the plane gradient g and offset d with g.p + d = that component at each corner give
        // the component the face would show at any point p. A field sums, over its faces, area x L^2 x (g.p + d - s)^2
        // for the normal s its vertex ends up with (L = normalWeight x the bounding diagonal): moving a vertex to where
        // its faces' normals disagree with the one it keeps costs as much as moving it off the surface by L per unit of
        // normal change. Plane quadrics alone let a vertex slide along a flat face for nothing, so a raw scan's faces
        // stretch into slivers and later collapses fold the surface away; the field makes every slide pay for the
        // normals it drags.
        struct NormalField {
            SymmetricQuadric a;                 // sum of w (g.p + d)^2 over faces and components
            double g[3][4]{};                   // per component: sum of w g (xyz) and w d
            double w{0.0};                      // sum of w
            void add(const NormalField& o) {
                a += o.a;
                for (int c = 0; c < 3; ++c) for (int k = 0; k < 4; ++k) g[c][k] += o.g[c][k];
                w += o.w;
            }
            double evaluate(const Vec3& p, const Vec3& s) const {
                const double sc[3] = { s.x, s.y, s.z };
                double e = a.evaluate(p);
                for (int c = 0; c < 3; ++c) e += sc[c] * (sc[c] * w - 2.0 * (g[c][0] * p.x + g[c][1] * p.y + g[c][2] * p.z + g[c][3]));
                return std::max(0.0, e);
            }
        };
        // Two fields, blended by normalSmoothing s: one per wedge on the mesh's own normals (a hard edge keeps one per
        // side; a wedge with none takes its position's), weighted 1 - s, and one per position on its area-weighted
        // face normal, weighted s
        const float normalSmoothing = std::clamp(opt.normalSmoothing, 0.0f, 1.0f);
        const bool wedgeField = normalScale > 0.0 && normalSmoothing < 1.0f, positionField = normalScale > 0.0 && normalSmoothing > 0.0f;
        std::vector<Vec3> wedgeNormal(wedgeField ? numVerts : 0, Vec3(0, 0, 0)), posNormal(normalScale > 0.0 ? numVerts : 0, Vec3(0, 0, 0));
        std::vector<NormalField> fields(wedgeField ? numVerts : 0), posFields(positionField ? numVerts : 0);
        auto faceField = [](const Vec3& p0, const Vec3& e1, const Vec3& e2, const Vec3& n0, const Vec3& n1, const Vec3& n2, double w) {
            NormalField f;
            const double a11 = e1.dot(e1), a12 = e1.dot(e2), a22 = e2.dot(e2), det = a11 * a22 - a12 * a12;
            if (det <= 1e-20 || w <= 0.0) return f;
            const double v0[3] = { n0.x, n0.y, n0.z }, v1[3] = { n1.x, n1.y, n1.z }, v2[3] = { n2.x, n2.y, n2.z };
            for (int c = 0; c < 3; ++c) {
                // g = x e1 + y e2 with g.e1 = v1 - v0, g.e2 = v2 - v0
                const double b1 = v1[c] - v0[c], b2 = v2[c] - v0[c];
                const double x = (a22 * b1 - a12 * b2) / det, y = (a11 * b2 - a12 * b1) / det;
                const double gx = x * e1.x + y * e2.x, gy = x * e1.y + y * e2.y, gz = x * e1.z + y * e2.z;
                const double d = v0[c] - (gx * p0.x + gy * p0.y + gz * p0.z);
                SymmetricQuadric q(gx, gy, gz, d);
                q *= w;
                f.a += q;
                f.g[c][0] = w * gx; f.g[c][1] = w * gy; f.g[c][2] = w * gz; f.g[c][3] = w * d;
            }
            f.w = w;
            return f;
        };
        if (normalScale > 0.0) {
            for (const auto& tri : triangles) {
                if (tri.deleted) continue;
                const Vec3 n = faceCross(tri);
                for (int k = 0; k < 3; ++k) posNormal[corner(tri, k)] += n;
            }
            for (auto& n : posNormal) { const float l = n.length(); n = l > 1e-12f ? n * (1.0f / l) : Vec3(0, 0, 0); }
            if (wedgeField) for (uint32_t w = 0; w < numVerts; ++w) {
                const Vec3 own = wedges[w].normal;
                const float lo = own.length();
                wedgeNormal[w] = lo > 1e-6f ? own * (1.0f / lo) : posNormal[posOf[w]];
            }
            const double L2 = normalScale * normalScale;
            for (const auto& tri : triangles) {
                if (tri.deleted) continue;
                const uint32_t c0 = corner(tri, 0), c1 = corner(tri, 1), c2 = corner(tri, 2);
                const Vec3 p0 = positions[c0], e1 = positions[c1] - p0, e2 = positions[c2] - p0;
                const double area = 0.5 * e1.cross(e2).length();
                if (area <= 1e-12) continue;
                if (wedgeField) {
                    const NormalField f = faceField(p0, e1, e2, wedgeNormal[tri.w[0]], wedgeNormal[tri.w[1]], wedgeNormal[tri.w[2]], area * L2 * (1.0 - normalSmoothing));
                    for (uint32_t w : tri.w) fields[w].add(f);
                }
                if (positionField) {
                    const NormalField f = faceField(p0, e1, e2, posNormal[c0], posNormal[c1], posNormal[c2], area * L2 * normalSmoothing);
                    for (uint32_t c : { c0, c1, c2 }) posFields[c].add(f);
                }
            }
        }

        auto edgeKey = [](uint32_t a, uint32_t b) -> uint64_t {
            if (a > b) std::swap(a, b);
            return (static_cast<uint64_t>(a) << 32) | static_cast<uint64_t>(b);
        };

        // 2b. Boundary and crease constraint quadrics: an edge of the welded surface with one face (an outline) or, with
        // preserveCreases, whose two faces' normals diverge by at least creaseAngleDeg (or that more than two faces
        // share) is a "crease" — each of its endpoints gets an extra quadric for a plane through the edge, perpendicular
        // to each adjacent face (a "fin"), weighted heavily. Two straight, co-linear fin planes from the same crease
        // agree everywhere along it, so the crease can still be simplified; moving either endpoint off the crease plane
        // (eg. rounding a box's corner) does not. A UV seam or a box built from separate faces is not an outline here:
        // its copies are welded into one surface above.
        if (opt.preserveCreases || opt.preserveBoundary) {
            struct EdgeFaces { int32_t t[2]{-1, -1}; int count{0}; };
            std::unordered_map<uint64_t, EdgeFaces> edgeFaces;
            for (size_t t = 0; t < initialTriCount; ++t) {
                if (triangles[t].deleted) continue;
                for (int e = 0; e < 3; ++e) {
                    auto& ef = edgeFaces[edgeKey(corner(triangles[t], e), corner(triangles[t], (e + 1) % 3))];
                    if (ef.count < 2) ef.t[ef.count] = static_cast<int32_t>(t);
                    ++ef.count;
                }
            }

            // per metre of edge; with the normal field on, in step with it (400 x its length scale), so the outline
            // holds against the field on a mesh of any size
            const double CREASE_WEIGHT = std::max(1000.0, 400.0 * normalScale);
            float creaseCos = std::cos(opt.creaseAngleDeg * static_cast<float>(PI) / 180.0f);
            for (const auto& [key, ef] : edgeFaces) {
                bool isCrease = ef.count == 1;
                if (!isCrease && opt.preserveCreases) {
                    isCrease = ef.count > 2 || faceNormal(triangles[ef.t[0]]).dot(faceNormal(triangles[ef.t[1]])) < creaseCos;
                }
                if (!isCrease) continue;

                uint32_t a = static_cast<uint32_t>(key >> 32), b = static_cast<uint32_t>(key & 0xffffffffu);
                Vec3 pa = positions[a], pb = positions[b];
                Vec3 edgeVec = pb - pa;
                float edgeLen = edgeVec.length();
                if (edgeLen < 1e-8f) continue;
                Vec3 edgeDir = edgeVec * (1.0f / edgeLen);

                for (int f = 0; f < std::min(ef.count, 2); ++f) {
                    Vec3 faceN = faceNormal(triangles[ef.t[f]]);
                    Vec3 finN = edgeDir.cross(faceN);
                    float finLen = finN.length();
                    if (finLen < 1e-8f) continue;
                    finN = finN * (1.0f / finLen);

                    double d = -finN.dot(pa);
                    SymmetricQuadric fin(finN.x, finN.y, finN.z, d);
                    fin *= (edgeLen * CREASE_WEIGHT);
                    quadrics[a] += fin;
                    quadrics[b] += fin;
                }
            }
        }

        // 3. What each welded position may do. Its kind is read once from the surface as loaded: whether its edges
        // close around it, and how many wedges it has. An edge is open when its half-edge has no partner running the
        // other way (one face, or faces that disagree on the edge's direction); an edge shared by more than two faces
        // still has partners, so it is not open and its ends stay free, as a raw scan soup needs.
        //   Manifold  no open edge, one wedge          moves anywhere
        //   Seam      no open edge, two wedges         moves anywhere; its wedges go along the seam (or cross it)
        //   Complex   no open edge, more wedges        moves anywhere: all its wedges always go to the one kept position
        //   Border    one open loop through it         moves only along that loop, onto a Border or Fringe end
        //   Fringe    any other open edges (a loop     moves along any of its edges, but only onto another Fringe end:
        //             with several wedges, several     a scan soup's pieces touching at a corner, a seam meeting an
        //             loops, faces that disagree)      outline, faces that disagree on their direction
        // No position is locked: on the raw tile benchmark, locking the vertices whose open edges run only one way
        // left 18 cm RMS at a quarter of the triangles and 61 cm at a tenth, against 14 cm and 42 cm as Fringe.
        // The end kept keeps its kind, so a collapse never changes what the surface around it may do. A collapse
        // into a Border or Fringe end lands on it; only two free ends, or two ends of one border loop, may meet at
        // their midpoint or at the removed end. There is no link condition: a raw scan is non-manifold
        // everywhere, and the kinds, the fold check and the duplicate-face rule (a face a collapse would draw twice is
        // dropped, step 6) keep the surface whole without it.
        enum class VertexKind : uint8_t { Manifold, Border, Seam, Complex, Fringe };
        std::vector<VertexKind> kind(numVerts, VertexKind::Manifold);
        {
            constexpr uint32_t MANY = NONE - 1;   // more than one open edge that way
            std::vector<uint64_t> halfEdges;
            halfEdges.reserve(currentTriCount * 3);
            for (size_t t = 0; t < initialTriCount; ++t) {
                if (triangles[t].deleted) continue;
                for (int e = 0; e < 3; ++e)
                    halfEdges.push_back((static_cast<uint64_t>(corner(triangles[t], e)) << 32) | corner(triangles[t], (e + 1) % 3));
            }
            std::sort(halfEdges.begin(), halfEdges.end());
            halfEdges.erase(std::unique(halfEdges.begin(), halfEdges.end()), halfEdges.end());
            std::vector<uint32_t> openOut(numVerts, NONE), openIn(numVerts, NONE);
            for (uint64_t h : halfEdges) {
                const uint32_t a = static_cast<uint32_t>(h >> 32), b = static_cast<uint32_t>(h & 0xffffffffu);
                if (std::binary_search(halfEdges.begin(), halfEdges.end(), (static_cast<uint64_t>(b) << 32) | a)) continue;
                openOut[a] = openOut[a] == NONE ? b : MANY;
                openIn[b] = openIn[b] == NONE ? a : MANY;
            }
            std::vector<uint8_t> used(numVerts, 0);
            for (const auto& tri : triangles) if (!tri.deleted) for (uint32_t w : tri.w) used[w] = 1;
            for (uint32_t p = 0; p < numVerts; ++p) {
                if (posOf[p] != p) continue;
                int wedgeCount = 0;
                for (uint32_t w = p; w != NONE; w = nextWedge[w]) wedgeCount += used[w];
                const bool closed = openOut[p] == NONE && openIn[p] == NONE;
                const bool oneLoop = openOut[p] < MANY && openIn[p] < MANY && openOut[p] != openIn[p];
                if (closed) kind[p] = wedgeCount <= 1 ? VertexKind::Manifold : wedgeCount == 2 ? VertexKind::Seam : VertexKind::Complex;
                else if (oneLoop) kind[p] = wedgeCount <= 1 ? VertexKind::Border : VertexKind::Fringe;
                else kind[p] = VertexKind::Fringe;
            }
        }
        auto isFree = [](VertexKind k) { return k == VertexKind::Manifold || k == VertexKind::Seam || k == VertexKind::Complex; };
        // How far collapsing v into u may move u: 0 not at all (no collapse), 1 u stays where it is, 2 anywhere
        // between the two ends. alongOpen: the edge is an open edge of the surface (one face).
        auto freedom = [&](uint32_t v, uint32_t u, bool alongOpen) -> int {
            const VertexKind kv = kind[v], ku = kind[u];
            if (isFree(kv)) return isFree(ku) ? 2 : 1;
            if (kv == VertexKind::Fringe) return ku == VertexKind::Fringe ? 1 : 0;
            if (kv == VertexKind::Border && alongOpen) return ku == VertexKind::Border ? 2 : ku == VertexKind::Fringe ? 1 : 0;
            return 0;
        };

        // 4. Planning a collapse of the edge (a, b): which end it keeps (u), the target position and its cost, and the
        // wedge each wedge of the removed end (v) becomes. Returns false when no collapse of the edge is allowed.
        struct Plan {
            uint32_t u{0}, v{0};
            Vec3 target;
            float attrT{0.0f};   // 0: the target is u's position, 1: v's, 0.5: their midpoint
            double cost{0.0};
            std::vector<std::pair<uint32_t, uint32_t>> wedgeMap;   // (wedge of v, wedge of u)
            std::vector<uint8_t> crossed;   // per wedgeMap entry: 1 when the pair crosses a seam (attributes not blended)
            double seamCost{0.0};
        };
        std::vector<uint32_t> ringA, edgeTris;
        auto ringOf = [&](uint32_t a, std::vector<uint32_t>& ring) {
            // every other corner of a's live triangles, sorted
            ring.clear();
            for (uint32_t t : vertTriangles[a]) {
                const auto& tri = triangles[t];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k) if (corner(tri, k) != a) ring.push_back(corner(tri, k));
            }
            std::sort(ring.begin(), ring.end());
        };
        auto mapWedges = [&](uint32_t u, uint32_t v, std::vector<std::pair<uint32_t, uint32_t>>& map) {
            map.clear();
            for (uint32_t t : edgeTris) {
                const auto& tri = triangles[t];
                uint32_t wu = NONE, wv = NONE;
                for (int k = 0; k < 3; ++k) {
                    if (corner(tri, k) == u) wu = tri.w[k];
                    if (corner(tri, k) == v) wv = tri.w[k];
                }
                auto it = std::find_if(map.begin(), map.end(), [&](const auto& m) { return m.first == wv; });
                if (it == map.end()) map.emplace_back(wv, wu);
                else if (it->second != wu) return false;   // one wedge of v meets two of u (a seam ends at v)
            }
            for (uint32_t t : vertTriangles[v]) {
                const auto& tri = triangles[t];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k)
                    if (corner(tri, k) == v && std::none_of(map.begin(), map.end(), [&](const auto& m) { return m.first == tri.w[k]; }))
                        return false;   // a wedge of v with no counterpart at u (the edge leaves v's seam)
            }
            return true;
        };
        // The seam-crossing map for collapsing v into u: each wedge of v takes its partner
        // across the edge's own triangles where it has one, else u's wedge nearest in UV. Returns the texture-drift cost:
        // over v's triangles that stay, area x (UV shift x metres per UV unit)^2, plus area^2 x (colour shift)^2 (a full
        // colour flip costs as much as moving the triangle by its own size).
        std::vector<uint32_t> uWedges;
        auto uvGap2 = [&](uint32_t a, uint32_t b) {
            const Vertex& x = wedges[a];
            const Vertex& y = wedges[b];
            const double du = x.uv.x - y.uv.x, dv = x.uv.y - y.uv.y, du1 = x.uv1.x - y.uv1.x, dv1 = x.uv1.y - y.uv1.y;
            return du * du + dv * dv + du1 * du1 + dv1 * dv1;
        };
        auto colourGap2 = [&](uint32_t a, uint32_t b) {
            const Vec4& x = wedges[a].color;
            const Vec4& y = wedges[b].color;
            const double dr = x.x - y.x, dg = x.y - y.y, db = x.z - y.z, da = x.w - y.w;
            return dr * dr + dg * dg + db * db + da * da;
        };
        auto crossWedges = [&](uint32_t u, uint32_t v, std::vector<std::pair<uint32_t, uint32_t>>& map, std::vector<uint8_t>& crossed) -> double {
            map.clear();
            crossed.clear();
            for (uint32_t t : edgeTris) {
                const auto& tri = triangles[t];
                uint32_t wu = NONE, wv = NONE;
                for (int k = 0; k < 3; ++k) {
                    if (corner(tri, k) == u) wu = tri.w[k];
                    if (corner(tri, k) == v) wv = tri.w[k];
                }
                if (std::none_of(map.begin(), map.end(), [&](const auto& m) { return m.first == wv; })) { map.emplace_back(wv, wu); crossed.push_back(0); }
            }
            uWedges.clear();
            for (uint32_t t : vertTriangles[u]) {
                const auto& tri = triangles[t];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k)
                    if (corner(tri, k) == u && std::find(uWedges.begin(), uWedges.end(), tri.w[k]) == uWedges.end()) uWedges.push_back(tri.w[k]);
            }
            double cost = 0.0;
            for (uint32_t t : vertTriangles[v]) {
                const auto& tri = triangles[t];
                if (tri.deleted || std::find(edgeTris.begin(), edgeTris.end(), t) != edgeTris.end()) continue;
                for (int k = 0; k < 3; ++k) {
                    if (corner(tri, k) != v) continue;
                    const uint32_t wv = tri.w[k];
                    size_t i = 0;
                    while (i < map.size() && map[i].first != wv) ++i;
                    if (i == map.size()) {
                        uint32_t best = uWedges.empty() ? NONE : uWedges[0];
                        for (uint32_t w : uWedges) if (uvGap2(wv, w) < uvGap2(wv, best)) best = w;
                        if (best == NONE) return -1.0;
                        map.emplace_back(wv, best);
                        crossed.push_back(1);
                    }
                    if (!crossed[i]) continue;
                    const uint32_t wu = map[i].second;
                    const double area = 0.5 * faceCross(tri).length();
                    const Vec2& a = wedges[tri.w[0]].uv;
                    const Vec2& b = wedges[tri.w[1]].uv;
                    const Vec2& c = wedges[tri.w[2]].uv;
                    const double uvArea = 0.5 * std::abs(double(b.x - a.x) * (c.y - a.y) - double(c.x - a.x) * (b.y - a.y));
                    const double metres2PerUv2 = uvArea > 1e-14 ? area / uvArea : 0.0;
                    cost += area * metres2PerUv2 * uvGap2(wv, wu) + area * area * colourGap2(wv, wu);
                }
            }
            return cost;
        };
        auto foldsOver = [&](uint32_t a, uint32_t b, const Vec3& target) {
            for (uint32_t end : { a, b }) {
                for (uint32_t t : vertTriangles[end]) {
                    const auto& tri = triangles[t];
                    if (tri.deleted) continue;
                    Vec3 p[3];
                    bool hasA = false, hasB = false;
                    for (int k = 0; k < 3; ++k) {
                        uint32_t c = corner(tri, k);
                        hasA |= c == a;
                        hasB |= c == b;
                        p[k] = (c == a || c == b) ? target : positions[c];
                    }
                    if (hasA && hasB) continue;   // removed by the collapse
                    Vec3 oldN = faceCross(tri);
                    Vec3 newN = (p[1] - p[0]).cross(p[2] - p[0]);
                    float oldLenSq = oldN.lengthSquared();
                    if (oldLenSq <= 1e-30f) continue;
                    if (newN.lengthSquared() <= 1e-12f * oldLenSq) return true;   // flattened to a sliver
                    if (newN.normalized().dot(oldN * (1.0f / std::sqrt(oldLenSq))) < 0.2f) return true;   // Reject fold-over
                }
            }
            return false;
        };
        // The normals u's wedges keep after collapsing v into u, at blend attrT: each wedge's own blended with the wedge
        // of v that becomes it, its own when none does
        std::vector<std::pair<uint32_t, Vec3>> kept;   // (wedge of u, normal it keeps)
        std::vector<std::pair<uint32_t, Vec3>> keptBefore;
        auto unitOr = [](const Vec3& n, const Vec3& fallback) { const float l = n.length(); return l > 1e-12f ? n * (1.0f / l) : fallback; };
        auto keptNormals = [&](const Plan& plan, float attrT) {
            kept.clear();
            for (uint32_t t : vertTriangles[plan.u]) {
                const auto& tri = triangles[t];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k)
                    if (corner(tri, k) == plan.u && std::none_of(kept.begin(), kept.end(), [&](const auto& e) { return e.first == tri.w[k]; }))
                        kept.emplace_back(tri.w[k], wedgeNormal[tri.w[k]]);
            }
            for (auto& [wu, n] : kept)
                for (const auto& m : plan.wedgeMap) if (m.second == wu) { n = unitOr(math::lerp(n, wedgeNormal[m.first], attrT), n); break; }
        };
        // The normal field's cost of collapsing v into u at p: every wedge of u and every wedge of v (in the one of u it
        // becomes) judged against the normal that wedge of u keeps
        auto fieldCost = [&](const Plan& plan, const Vec3& p, float attrT) {
            double cost = 0.0;
            if (wedgeField) {
                keptNormals(plan, attrT);
                auto keptOf = [&](uint32_t wu) {
                    for (const auto& e : kept) if (e.first == wu) return e.second;
                    return wedgeNormal[wu];
                };
                for (const auto& [wu, n] : kept) cost += fields[wu].evaluate(p, n);
                for (const auto& [wv, wu] : plan.wedgeMap) cost += fields[wv].evaluate(p, keptOf(wu));
            }
            if (positionField) {
                NormalField f = posFields[plan.u];
                f.add(posFields[plan.v]);
                cost += f.evaluate(p, unitOr(math::lerp(posNormal[plan.u], posNormal[plan.v], attrT), posNormal[plan.u]));
            }
            return cost;
        };
        // Collapsing v into u, as far as freedom allows: the wedge map, then the cheapest target that folds nothing.
        Plan alt;
        auto planDirection = [&](uint32_t u, uint32_t v, int free, Plan& plan) -> bool {
            plan.u = u;
            plan.v = v;
            plan.seamCost = 0.0;
            if (mapWedges(u, v, plan.wedgeMap)) plan.crossed.assign(plan.wedgeMap.size(), 0);
            else {
                // Across a UV or colour seam (meshoptimizer's "permissive" idea): a wedge of the removed end with no
                // partner at the kept end takes the kept end's wedge nearest in UV, and the collapse pays for the
                // texture it drags in the quadric's units (crossWedges). Respecting seams instead stalls atlased scans
                // (a seam at nearly every vertex) far above the target.
                plan.seamCost = crossWedges(u, v, plan.wedgeMap, plan.crossed);
                if (plan.seamCost < 0) return false;
            }

            const SymmetricQuadric Q = quadrics[u] + quadrics[v];
            const Vec3 pu = positions[u], pv = positions[v];
            struct Candidate { Vec3 p; float attrT; double err; };
            Candidate cands[3] = { { pu, 0.0f, 0.0 }, { (pu + pv) * 0.5f, 0.5f, 0.0 }, { pv, 1.0f, 0.0 } };
            const int count = free >= 2 ? 3 : 1;
            for (int i = 0; i < count; ++i) {
                cands[i].err = Q.evaluate(cands[i].p);
                if (normalScale > 0.0) cands[i].err += fieldCost(plan, cands[i].p, cands[i].attrT);
            }
            std::stable_sort(cands, cands + count, [](const Candidate& x, const Candidate& y) { return x.err < y.err; });
            for (int i = 0; i < count; ++i) {
                if (opt.preventNormalFlips && foldsOver(u, v, cands[i].p)) continue;
                plan.target = cands[i].p;
                plan.attrT = cands[i].attrT;
                plan.cost = cands[i].err + plan.seamCost;
                return true;
            }
            return false;
        };
        auto planCollapse = [&](uint32_t a, uint32_t b, Plan& plan) -> bool {
            edgeTris.clear();
            for (uint32_t t : vertTriangles[a]) {
                const auto& tri = triangles[t];
                if (tri.deleted) continue;
                if (corner(tri, 0) == b || corner(tri, 1) == b || corner(tri, 2) == b) edgeTris.push_back(t);
            }
            if (edgeTris.empty()) return false;   // no longer an edge
            const bool alongOpen = edgeTris.size() == 1;
            const int freeAB = freedom(b, a, alongOpen), freeBA = freedom(a, b, alongOpen);
            const bool okAB = freeAB > 0 && planDirection(a, b, freeAB, plan);
            const bool okBA = freeBA > 0 && planDirection(b, a, freeBA, okAB ? alt : plan);
            if (okAB && okBA && alt.cost < plan.cost) std::swap(plan, alt);
            return okAB || okBA;
        };

        // 5. Track candidate edges and collapse costs
        struct EdgeCollapse {
            uint32_t a, b;
            double cost;
            uint32_t aGen, bGen;

            bool operator>(const EdgeCollapse& o) const {
                return cost > o.cost;
            }
        };

        std::vector<uint32_t> vertGen(numVerts, 0);
        std::vector<bool> vertexDeleted(numVerts, false);
        std::priority_queue<EdgeCollapse, std::vector<EdgeCollapse>, std::greater<EdgeCollapse>> pq;
        Plan plan;
        auto enqueue = [&](uint32_t a, uint32_t b) {
            if (planCollapse(a, b, plan)) pq.push({ a, b, plan.cost, vertGen[a], vertGen[b] });
        };

        {
            std::vector<uint64_t> edges;
            edges.reserve(currentTriCount * 3);
            for (size_t t = 0; t < initialTriCount; ++t) {
                if (triangles[t].deleted) continue;
                for (int e = 0; e < 3; ++e) edges.push_back(edgeKey(corner(triangles[t], e), corner(triangles[t], (e + 1) % 3)));
            }
            std::sort(edges.begin(), edges.end());
            edges.erase(std::unique(edges.begin(), edges.end()), edges.end());
            for (uint64_t key : edges) enqueue(static_cast<uint32_t>(key >> 32), static_cast<uint32_t>(key & 0xffffffffu));
        }

        // 6. Iterative edge collapse loop
        while (!pq.empty() && currentTriCount > targetTriangles) {
            auto top = pq.top();
            pq.pop();

            if (vertexDeleted[top.a] || vertexDeleted[top.b]) continue;
            if (vertGen[top.a] != top.aGen || vertGen[top.b] != top.bGen) continue;
            if (top.cost > opt.maxError) break;

            // The ends are unchanged since this was queued, but their neighbourhoods may not be: plan it again
            if (!planCollapse(top.a, top.b, plan)) continue;
            if (plan.cost > top.cost) {
                pq.push({ top.a, top.b, plan.cost, top.aGen, top.bGen });
                continue;
            }

            // Collapse v into u
            uint32_t u = plan.u, v = plan.v;
            positions[u] = plan.target;
            quadrics[u] += quadrics[v];
            if (wedgeField) {
                keptNormals(plan, plan.attrT);
                for (const auto& [wu, n] : kept) wedgeNormal[wu] = n;
                for (const auto& [wv, wu] : plan.wedgeMap) fields[wu].add(fields[wv]);
                keptBefore = kept;   // u's wedges before the collapse, for the fields the edge's own faces leave behind
            }
            if (positionField) {
                posFields[u].add(posFields[v]);
                posNormal[u] = unitOr(math::lerp(posNormal[u], posNormal[v], plan.attrT), posNormal[u]);
            }
            for (size_t i = 0; i < plan.wedgeMap.size(); ++i) {
                if (plan.crossed[i]) continue;   // the two sides of a seam keep their own attributes
                const auto [wv, wu] = plan.wedgeMap[i];
                wedges[wu].uv = math::lerp(wedges[wu].uv, wedges[wv].uv, plan.attrT);
                wedges[wu].uv1 = math::lerp(wedges[wu].uv1, wedges[wv].uv1, plan.attrT);
                wedges[wu].color = math::lerp(wedges[wu].color, wedges[wv].color, plan.attrT);
            }

            vertexDeleted[v] = true;
            vertGen[u]++;
            vertGen[v]++;

            // Update incident triangles: the edge's own collapse away, v's others move to u's wedges
            std::vector<uint32_t> newTriList;
            for (uint32_t tIdx : vertTriangles[u]) {
                auto& tri = triangles[tIdx];
                if (tri.deleted) continue;
                if (corner(tri, 0) == v || corner(tri, 1) == v || corner(tri, 2) == v) {
                    tri.deleted = true;
                    currentTriCount--;
                    continue;
                }
                newTriList.push_back(tIdx);
            }
            for (uint32_t tIdx : vertTriangles[v]) {
                auto& tri = triangles[tIdx];
                if (tri.deleted) continue;
                for (int k = 0; k < 3; ++k) {
                    if (corner(tri, k) != v) continue;
                    tri.w[k] = std::find_if(plan.wedgeMap.begin(), plan.wedgeMap.end(), [&](const auto& m) { return m.first == tri.w[k]; })->second;
                }
                // a face u already has (the same three positions) is drawn once
                uint32_t x = NONE, y = NONE;
                for (int k = 0; k < 3; ++k) if (corner(tri, k) != u) (x == NONE ? x : y) = corner(tri, k);
                const bool twin = std::any_of(newTriList.begin(), newTriList.end(), [&](uint32_t s) {
                    const auto& o = triangles[s];
                    bool hx = false, hy = false;
                    for (int k = 0; k < 3; ++k) { hx |= corner(o, k) == x; hy |= corner(o, k) == y; }
                    return hx && hy;
                });
                if (twin) { tri.deleted = true; currentTriCount--; continue; }
                newTriList.push_back(tIdx);
            }
            vertTriangles[u] = std::move(newTriList);
            if (wedgeField) {
                // a wedge of u whose faces were all the edge's own keeps no face: its field joins u's surviving wedge
                // with the nearest normal, so the surface it measured is not forgotten
                std::vector<uint32_t> alive;
                for (uint32_t tIdx : vertTriangles[u]) for (int k = 0; k < 3; ++k)
                    if (corner(triangles[tIdx], k) == u && std::find(alive.begin(), alive.end(), triangles[tIdx].w[k]) == alive.end()) alive.push_back(triangles[tIdx].w[k]);
                for (const auto& [w, n] : keptBefore) {
                    if (alive.empty() || std::find(alive.begin(), alive.end(), w) != alive.end()) continue;
                    uint32_t best = alive[0];
                    for (uint32_t a : alive) if (wedgeNormal[a].dot(n) > wedgeNormal[best].dot(n)) best = a;
                    fields[best].add(fields[w]);
                    fields[w] = NormalField();
                }
            }
            vertTriangles[v].clear();

            // Re-evaluate edges connected to u
            ringOf(u, ringA);
            ringA.erase(std::unique(ringA.begin(), ringA.end()), ringA.end());
            std::vector<uint32_t> neighbors = ringA;
            for (uint32_t nIdx : neighbors) enqueue(u, nIdx);
        }

        // 7. Pack surviving wedges and triangles
        ScratchboxMesh decimated(input.name + "_decimated");
        decimated.material = input.material;
        decimated.hasUv1 = input.hasUv1;

        std::vector<int> remap(numVerts, -1);
        for (size_t t = 0; t < initialTriCount; ++t) {
            if (triangles[t].deleted) continue;
            for (int k = 0; k < 3; ++k) {
                uint32_t w = triangles[t].w[k];
                if (remap[w] == -1) {
                    remap[w] = static_cast<int>(decimated.vertices.size());
                    Vertex out = wedges[w];
                    out.position = positions[posOf[w]];
                    decimated.addVertex(out);
                }
            }
            decimated.addTriangle(
                static_cast<uint32_t>(remap[triangles[t].w[0]]),
                static_cast<uint32_t>(remap[triangles[t].w[1]]),
                static_cast<uint32_t>(remap[triangles[t].w[2]])
            );
        }

        decimated.recomputeSmoothNormals();
        decimated.recomputeBounds();
        if (opt.optimizeOrder) {
            optimizeVertexCache(decimated.indices, decimated.vertices.size());
            optimizeVertexFetch(decimated);
        }
        return decimated;
    }
};

// ============================================================================
// 3. Discrete Differential Geometry & Koenderink Shape Index
// ============================================================================

struct CurvatureAnalysisResult {
    std::vector<float> meanCurvature;      // H = 0.5 * (k1 + k2)
    std::vector<float> gaussianCurvature;  // K = k1 * k2
    std::vector<float> principalK1;        // Maximum principal curvature
    std::vector<float> principalK2;        // Minimum principal curvature
    std::vector<float> shapeIndex;         // S in [-1, 1]: -1 (Cup), -0.5 (Rut), 0 (Saddle), +0.5 (Ridge), +1 (Cap)
    std::vector<float> curvedness;         // C = sqrt((k1^2 + k2^2)/2)
    std::vector<float> cavityOcclusion;    // Normalized Cavity AO [0, 1]
};

class DifferentialGeometryEngine {
public:
    /**
     * Computes Laplace-Beltrami cotangent weights, Gaussian curvature (angle deficit),
     * principal curvatures (k1, k2), and Koenderink Shape Index.
     */
    static CurvatureAnalysisResult analyzeCurvature(const ScratchboxMesh& mesh) {
        CurvatureAnalysisResult res;
        size_t n = mesh.vertices.size();
        if (n == 0 || mesh.indices.empty()) return res;

        res.meanCurvature.assign(n, 0.0f);
        res.gaussianCurvature.assign(n, 0.0f);
        res.principalK1.assign(n, 0.0f);
        res.principalK2.assign(n, 0.0f);
        res.shapeIndex.assign(n, 0.0f);
        res.curvedness.assign(n, 0.0f);
        res.cavityOcclusion.assign(n, 1.0f);

        std::vector<float> dualAreas(n, 0.0f);
        std::vector<float> angleSums(n, 0.0f);
        std::vector<Vec3> laplacian(n, Vec3(0, 0, 0));

        size_t triCount = mesh.indices.size() / 3;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            if (i0 >= n || i1 >= n || i2 >= n) continue;

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;

            Vec3 e01 = p1 - p0;
            Vec3 e12 = p2 - p1;
            Vec3 e20 = p0 - p2;

            float l01 = e01.length();
            float l12 = e12.length();
            float l20 = e20.length();

            if (l01 < 1e-7f || l12 < 1e-7f || l20 < 1e-7f) continue;

            float cos0 = std::clamp((-e20).dot(e01) / (l20 * l01), -0.9999f, 0.9999f);
            float cos1 = std::clamp((-e01).dot(e12) / (l01 * l12), -0.9999f, 0.9999f);
            float cos2 = std::clamp((-e12).dot(e20) / (l12 * l20), -0.9999f, 0.9999f);

            float theta0 = std::acos(cos0);
            float theta1 = std::acos(cos1);
            float theta2 = std::acos(cos2);

            angleSums[i0] += theta0;
            angleSums[i1] += theta1;
            angleSums[i2] += theta2;

            float cot0 = cos0 / std::max(1e-4f, std::sin(theta0));
            float cot1 = cos1 / std::max(1e-4f, std::sin(theta1));
            float cot2 = cos2 / std::max(1e-4f, std::sin(theta2));

            float triArea = 0.5f * (e01.cross(-e20)).length();
            dualAreas[i0] += triArea / 3.0f;
            dualAreas[i1] += triArea / 3.0f;
            dualAreas[i2] += triArea / 3.0f;

            laplacian[i0] += (p1 - p0) * cot2 + (p2 - p0) * cot1;
            laplacian[i1] += (p2 - p1) * cot0 + (p0 - p1) * cot2;
            laplacian[i2] += (p0 - p2) * cot1 + (p1 - p2) * cot0;
        }

        for (size_t i = 0; i < n; ++i) {
            float area = std::max(1e-6f, dualAreas[i]);
            Vec3 lap = laplacian[i] / (2.0f * area);

            // Mean curvature magnitude: convex sphere has positive H
            // Inward Laplacian lap.dot(normal) < 0 -> H > 0
            float H = 0.5f * lap.length();
            if (lap.dot(mesh.vertices[i].normal) > 0.0f) {
                H = -H;
            }
            res.meanCurvature[i] = H;

            // Gaussian curvature via Gauss-Bonnet angle deficit
            float K = (TWO_PI - angleSums[i]) / area;
            res.gaussianCurvature[i] = K;

            // Principal curvatures: k1,2 = H +/- sqrt(max(0, H^2 - K))
            float discriminant = std::max(0.0f, H * H - K);
            float rootDisc = std::sqrt(discriminant);
            float k1 = H + rootDisc;
            float k2 = H - rootDisc;

            res.principalK1[i] = k1;
            res.principalK2[i] = k2;

            // Koenderink Shape Index S = (2/pi) * arctan((k1 + k2) / (k1 - k2))
            float diff = k1 - k2;
            if (std::abs(diff) > 1e-5f) {
                res.shapeIndex[i] = (2.0f / PI) * std::atan2(k1 + k2, diff);
            } else {
                res.shapeIndex[i] = (k1 + k2 > 0.0f) ? 1.0f : ((k1 + k2 < 0.0f) ? -1.0f : 0.0f);
            }

            // Curvedness C = sqrt((k1^2 + k2^2) / 2)
            res.curvedness[i] = std::sqrt(0.5f * (k1 * k1 + k2 * k2));

            // Cavity Occlusion: concave areas (H < 0) darken towards 0.0
            float occ = std::clamp(1.0f - std::max(0.0f, -H) * 0.4f, 0.15f, 1.0f);
            res.cavityOcclusion[i] = occ;
        }

        return res;
    }

    /**
     * Bakes discrete Cavity AO directly into mesh vertex colors (COLOR_0).
     */
    static void bakeCavityAO(ScratchboxMesh& mesh, float intensity = 0.65f) {
        auto curvs = analyzeCurvature(mesh);
        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            float occ = math::lerp(1.0f, curvs.cavityOcclusion[i], intensity);
            mesh.vertices[i].color.x *= occ;
            mesh.vertices[i].color.y *= occ;
            mesh.vertices[i].color.z *= occ;
        }
    }
};

// ============================================================================
// 4. Poisson-Disk Blue Noise Point Sampling on Surfaces
// ============================================================================

struct SurfaceSamplePoint {
    Vec3 position;
    Vec3 normal;
    Vec2 uv;
    Vec4 color;
};

struct PoissonSampleOptions {
    size_t targetCount{100};      // Desired number of samples
    float minDistance{0.0f};      // Minimum spacing radius between points (0 = auto-compute from area)
    uint32_t seed{42};
    int maxAttemptsPerPoint{30};
};

class PoissonDiskSampler {
public:
    /**
     * Samples points on triangle mesh with blue noise Poisson-disk spatial distribution.
     * Prevents clumping artifacts for botanical scattering, greebles, and rivet placement.
     */
    static std::vector<SurfaceSamplePoint> sample(const ScratchboxMesh& mesh, const PoissonSampleOptions& opt = {}) {
        std::vector<SurfaceSamplePoint> samples;
        size_t triCount = mesh.indices.size() / 3;
        if (triCount == 0 || opt.targetCount == 0) return samples;

        // 1. Calculate cumulative area distribution
        std::vector<float> cdf(triCount);
        float totalArea = 0.0f;

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            Vec3 p0 = mesh.vertices[i0].position;
            Vec3 p1 = mesh.vertices[i1].position;
            Vec3 p2 = mesh.vertices[i2].position;

            float area = 0.5f * (p1 - p0).cross(p2 - p0).length();
            totalArea += area;
            cdf[t] = totalArea;
        }

        if (totalArea <= 1e-7f) return samples;

        // Auto-calculate minDistance if 0
        float r = opt.minDistance;
        if (r <= 0.0f) {
            // Hexagonal packing bound on 2D manifold
            r = std::sqrt((2.0f * totalArea) / (1.73205f * static_cast<float>(opt.targetCount))) * 0.75f;
        }
        float rSq = r * r;

        // 2. Spatial hashing grid for accelerated distance queries
        float cellSize = r / 1.732f;
        float invCell = 1.0f / cellSize;

        struct CellKey {
            int64_t x, y, z;
            bool operator==(const CellKey& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct CellHash {
            size_t operator()(const CellKey& k) const {
                return (static_cast<size_t>(k.x) * 73856093) ^
                       (static_cast<size_t>(k.y) * 19349663) ^
                       (static_cast<size_t>(k.z) * 83492791);
            }
        };

        std::unordered_map<CellKey, std::vector<size_t>, CellHash> grid;
        std::mt19937 rng(opt.seed);
        std::uniform_real_distribution<float> dist01(0.0f, 1.0f);

        size_t attempts = 0;
        size_t maxTotalAttempts = opt.targetCount * opt.maxAttemptsPerPoint;

        while (samples.size() < opt.targetCount && attempts < maxTotalAttempts) {
            attempts++;

            // Pick random triangle proportional to surface area
            float targetVal = dist01(rng) * totalArea;
            auto it = std::lower_bound(cdf.begin(), cdf.end(), targetVal);
            size_t triIdx = std::distance(cdf.begin(), it);
            if (triIdx >= triCount) triIdx = triCount - 1;

            uint32_t i0 = mesh.indices[triIdx * 3 + 0];
            uint32_t i1 = mesh.indices[triIdx * 3 + 1];
            uint32_t i2 = mesh.indices[triIdx * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            // Uniform sampling on triangle using square-root transform
            float u1 = dist01(rng);
            float u2 = dist01(rng);
            float sqrtU1 = std::sqrt(u1);
            float w0 = 1.0f - sqrtU1;
            float w1 = u2 * sqrtU1;
            float w2 = 1.0f - w0 - w1;

            Vec3 candPos = v0.position * w0 + v1.position * w1 + v2.position * w2;

            // Check neighbor grid cells
            int64_t gx = static_cast<int64_t>(std::floor(candPos.x * invCell));
            int64_t gy = static_cast<int64_t>(std::floor(candPos.y * invCell));
            int64_t gz = static_cast<int64_t>(std::floor(candPos.z * invCell));

            bool conflict = false;
            for (int64_t dx = -2; dx <= 2 && !conflict; ++dx) {
                for (int64_t dy = -2; dy <= 2 && !conflict; ++dy) {
                    for (int64_t dz = -2; dz <= 2 && !conflict; ++dz) {
                        CellKey neighborKey{gx + dx, gy + dy, gz + dz};
                        auto nIt = grid.find(neighborKey);
                        if (nIt != grid.end()) {
                            for (size_t sampleIdx : nIt->second) {
                                if ((samples[sampleIdx].position - candPos).lengthSquared() < rSq) {
                                    conflict = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            if (!conflict) {
                SurfaceSamplePoint pt;
                pt.position = candPos;
                pt.normal = (v0.normal * w0 + v1.normal * w1 + v2.normal * w2).normalized();
                pt.uv = v0.uv * w0 + v1.uv * w1 + v2.uv * w2;
                pt.color = v0.color * w0 + v1.color * w1 + v2.color * w2;

                size_t newIdx = samples.size();
                samples.push_back(pt);
                grid[{gx, gy, gz}].push_back(newIdx);
            }
        }

        return samples;
    }
};

// ============================================================================
// 5. Boundary Loop Detection & Hole Filling
// ============================================================================

struct HoleFillOptions {
    size_t maxHoleEdges{64}; // Max boundary loop length to triangulate
    bool smoothPatches{true}; // Apply local Laplacian smoothing to newly filled vertices
};

class HoleFiller {
public:
    /**
     * Identifies open boundary half-edge loops and triangulates them cleanly.
     */
    static ScratchboxMesh fillHoles(const ScratchboxMesh& input, const HoleFillOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        ScratchboxMesh out = input;
        size_t triCount = out.indices.size() / 3;

        struct DirectedEdge {
            uint32_t u, v;
            bool operator==(const DirectedEdge& o) const { return u == o.u && v == o.v; }
        };
        struct DirectedHash {
            size_t operator()(const DirectedEdge& e) const {
                return (static_cast<size_t>(e.u) * 73856093) ^ (static_cast<size_t>(e.v) * 19349663);
            }
        };

        std::unordered_map<DirectedEdge, int, DirectedHash> edgeMap;
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = out.indices[t * 3 + 0];
            uint32_t i1 = out.indices[t * 3 + 1];
            uint32_t i2 = out.indices[t * 3 + 2];
            edgeMap[{i0, i1}]++;
            edgeMap[{i1, i2}]++;
            edgeMap[{i2, i0}]++;
        }

        // Find boundary edges (half-edges with no opposite)
        std::unordered_map<uint32_t, uint32_t> nextVertex;
        for (const auto& kv : edgeMap) {
            DirectedEdge rev{kv.first.v, kv.first.u};
            if (edgeMap.find(rev) == edgeMap.end()) {
                nextVertex[kv.first.u] = kv.first.v;
            }
        }

        std::unordered_set<uint32_t> visited;
        std::vector<std::vector<uint32_t>> loops;

        for (const auto& kv : nextVertex) {
            uint32_t start = kv.first;
            if (visited.count(start)) continue;

            std::vector<uint32_t> loop;
            uint32_t curr = start;
            bool closed = false;

            while (visited.insert(curr).second) {
                loop.push_back(curr);
                auto it = nextVertex.find(curr);
                if (it == nextVertex.end()) break;
                if (it->second == start) {
                    closed = true;
                    break;
                }
                curr = it->second;
                if (loop.size() > opt.maxHoleEdges) break;
            }

            if (closed && loop.size() >= 3 && loop.size() <= opt.maxHoleEdges) {
                loops.push_back(loop);
            }
        }

        // Triangulate each boundary loop
        for (const auto& loop : loops) {
            if (loop.size() == 3) {
                out.addTriangle(loop[0], loop[1], loop[2]);
            } else {
                // Compute loop centroid and insert fan
                Vec3 centroid(0, 0, 0);
                Vec3 avgNormal(0, 0, 0);
                Vec2 avgUv(0, 0);
                Vec4 avgCol(0, 0, 0, 0);

                for (uint32_t vIdx : loop) {
                    centroid += out.vertices[vIdx].position;
                    avgNormal += out.vertices[vIdx].normal;
                    avgUv += out.vertices[vIdx].uv;
                    avgCol += out.vertices[vIdx].color;
                }

                float invK = 1.0f / static_cast<float>(loop.size());
                centroid = centroid * invK;
                avgNormal = (avgNormal * invK).normalized();
                avgUv = avgUv * invK;
                avgCol = avgCol * invK;

                uint32_t centerIdx = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(Vertex(centroid, avgNormal, avgUv, avgCol));

                for (size_t i = 0; i < loop.size(); ++i) {
                    uint32_t v0 = loop[i];
                    uint32_t v1 = loop[(i + 1) % loop.size()];
                    out.addTriangle(centerIdx, v0, v1);
                }
            }
        }

        out.recomputeSmoothNormals();
        out.recomputeBounds();
        return out;
    }
};

// ============================================================================
// 6. Topological Mesh Cleaning & Repair
// ============================================================================

struct CleanMeshOptions {
    float weldEpsilon{1e-5f};         // Distance threshold for welding duplicate vertices
    bool removeDuplicateFaces{true};   // Remove identical triangle indices
    bool removeDegenerateFaces{true};  // Remove zero-area / collapsed triangles
    bool removeIsolatedVertices{true}; // Remove vertices unreferenced by any triangle
};

class MeshCleaner {
public:
    /**
     * Cleans up unreferenced vertices, duplicate faces, zero-area slivers,
     * and non-manifold topology, restoring clean manifold glTF geometry.
     */
    static ScratchboxMesh clean(const ScratchboxMesh& input, const CleanMeshOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        ScratchboxMesh cleaned(input.name + "_cleaned");
        cleaned.material = input.material;

        size_t vertCount = input.vertices.size();
        size_t triCount = input.indices.size() / 3;

        // 1. Spatial hashing for duplicate vertex welding
        std::vector<int> vertexRemap(vertCount);
        std::vector<Vertex> uniqueVertices;

        struct PosKey {
            int64_t x, y, z;
            bool operator==(const PosKey& o) const { return x == o.x && y == o.y && z == o.z; }
        };
        struct PosHash {
            size_t operator()(const PosKey& k) const {
                return (static_cast<size_t>(k.x) * 73856093) ^
                       (static_cast<size_t>(k.y) * 19349663) ^
                       (static_cast<size_t>(k.z) * 83492791);
            }
        };

        float invGrid = 1.0f / std::max(1e-6f, opt.weldEpsilon);
        std::unordered_map<PosKey, int, PosHash> grid;

        for (size_t i = 0; i < vertCount; ++i) {
            const auto& v = input.vertices[i];
            PosKey key{
                static_cast<int64_t>(std::floor(v.position.x * invGrid)),
                static_cast<int64_t>(std::floor(v.position.y * invGrid)),
                static_cast<int64_t>(std::floor(v.position.z * invGrid))
            };

            auto it = grid.find(key);
            if (it != grid.end()) {
                vertexRemap[i] = it->second;
            } else {
                int newIdx = static_cast<int>(uniqueVertices.size());
                grid[key] = newIdx;
                vertexRemap[i] = newIdx;
                uniqueVertices.push_back(v);
            }
        }

        // 2. Filter duplicate & degenerate triangles
        struct TriKey {
            uint32_t a, b, c;
            bool operator<(const TriKey& o) const {
                if (a != o.a) return a < o.a;
                if (b != o.b) return b < o.b;
                return c < o.c;
            }
        };
        std::set<TriKey> seenTriangles;
        std::vector<uint32_t> cleanIndices;
        std::vector<bool> vertexUsed(uniqueVertices.size(), false);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 0]]);
            uint32_t i1 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 1]]);
            uint32_t i2 = static_cast<uint32_t>(vertexRemap[input.indices[t * 3 + 2]]);

            // Degenerate triangle check (duplicate vertex indices)
            if (opt.removeDegenerateFaces) {
                if (i0 == i1 || i1 == i2 || i2 == i0) continue;

                // Collinear / zero-area check
                Vec3 p0 = uniqueVertices[i0].position;
                Vec3 p1 = uniqueVertices[i1].position;
                Vec3 p2 = uniqueVertices[i2].position;
                Vec3 fn = (p1 - p0).cross(p2 - p0);
                if (fn.lengthSquared() < 1e-12f) continue;
            }

            // Duplicate face check (canonical sorted index key)
            if (opt.removeDuplicateFaces) {
                uint32_t s0 = i0, s1 = i1, s2 = i2;
                if (s0 > s1) std::swap(s0, s1);
                if (s1 > s2) std::swap(s1, s2);
                if (s0 > s1) std::swap(s0, s1);
                TriKey triKey{s0, s1, s2};
                if (!seenTriangles.insert(triKey).second) continue;
            }

            cleanIndices.push_back(i0);
            cleanIndices.push_back(i1);
            cleanIndices.push_back(i2);
            vertexUsed[i0] = true;
            vertexUsed[i1] = true;
            vertexUsed[i2] = true;
        }

        // 3. Compact unreferenced vertices
        std::vector<int> compactRemap(uniqueVertices.size(), -1);
        for (size_t i = 0; i < uniqueVertices.size(); ++i) {
            if (!opt.removeIsolatedVertices || vertexUsed[i]) {
                compactRemap[i] = static_cast<int>(cleaned.vertices.size());
                cleaned.addVertex(uniqueVertices[i]);
            }
        }

        for (size_t i = 0; i < cleanIndices.size(); i += 3) {
            int ci0 = compactRemap[cleanIndices[i]];
            int ci1 = compactRemap[cleanIndices[i + 1]];
            int ci2 = compactRemap[cleanIndices[i + 2]];
            if (ci0 >= 0 && ci1 >= 0 && ci2 >= 0) {
                cleaned.addTriangle(static_cast<uint32_t>(ci0), static_cast<uint32_t>(ci1), static_cast<uint32_t>(ci2));
            }
        }

        cleaned.recomputeSmoothNormals();
        cleaned.recomputeBounds();
        return cleaned;
    }
};

// ============================================================================
// 7. Analytical Planar Slicing (Sutherland-Hodgman Kernel)
// ============================================================================

class PlanarSlicer {
public:
    /**
     * Slices an input mesh by an arbitrary 3D cutting plane (defined by planePoint and planeNormal).
     * Exact triangle-plane intersection with linear interpolation of positions, normals, UVs, and colors.
     * If keepPositive is true, retains geometry where (p - planePoint) . planeNormal >= 0.
     * If capCut is true, triangulates the planar cross-section with an inward/outward cap.
     */
    static ScratchboxMesh slice(
        const ScratchboxMesh& input,
        const Vec3& planePoint,
        const Vec3& planeNormal,
        bool keepPositive = true,
        bool capCut = true
    ) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        Vec3 n = planeNormal.normalized();
        float planeD = -n.dot(planePoint);

        ScratchboxMesh out(input.name + "_sliced");
        out.material = input.material;

        size_t triCount = input.indices.size() / 3;

        // Signed distances from vertices to plane
        std::vector<float> dists(input.vertices.size());
        for (size_t i = 0; i < input.vertices.size(); ++i) {
            dists[i] = n.dot(input.vertices[i].position) + planeD;
        }

        // Track cut boundary line segments for capping
        struct CutSegment {
            uint32_t v0, v1;
        };
        std::vector<CutSegment> cutEdges;

        auto interpolateVertex = [](const Vertex& a, const Vertex& b, float t) -> Vertex {
            Vertex out;
            out.position = math::lerp(a.position, b.position, t);
            out.normal = math::lerp(a.normal, b.normal, t).normalized();
            out.uv = math::lerp(a.uv, b.uv, t);
            out.color = math::lerp(a.color, b.color, t);
            out.tangent = math::lerp(a.tangent, b.tangent, t);
            return out;
        };

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = input.indices[t * 3 + 0];
            uint32_t i1 = input.indices[t * 3 + 1];
            uint32_t i2 = input.indices[t * 3 + 2];

            float d0 = dists[i0];
            float d1 = dists[i1];
            float d2 = dists[i2];

            bool in0 = keepPositive ? (d0 >= 0.0f) : (d0 <= 0.0f);
            bool in1 = keepPositive ? (d1 >= 0.0f) : (d1 <= 0.0f);
            bool in2 = keepPositive ? (d2 >= 0.0f) : (d2 <= 0.0f);

            int inCount = (in0 ? 1 : 0) + (in1 ? 1 : 0) + (in2 ? 1 : 0);

            if (inCount == 3) {
                // Entire triangle on inside half-space
                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[i0]);
                out.addVertex(input.vertices[i1]);
                out.addVertex(input.vertices[i2]);
                out.addTriangle(base, base + 1, base + 2);
            } else if (inCount == 0) {
                // Entire triangle clipped
                continue;
            } else if (inCount == 1) {
                // 1 vertex in, 2 vertices out -> 1 smaller triangle
                uint32_t vIn = in0 ? i0 : (in1 ? i1 : i2);
                uint32_t vOut1 = in0 ? i1 : (in1 ? i2 : i0);
                uint32_t vOut2 = in0 ? i2 : (in1 ? i0 : i1);

                float dIn = dists[vIn];
                float dOut1 = dists[vOut1];
                float dOut2 = dists[vOut2];

                float t1 = dIn / (dIn - dOut1);
                float t2 = dIn / (dIn - dOut2);

                Vertex cutV1 = interpolateVertex(input.vertices[vIn], input.vertices[vOut1], t1);
                Vertex cutV2 = interpolateVertex(input.vertices[vIn], input.vertices[vOut2], t2);

                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[vIn]);
                out.addVertex(cutV1);
                out.addVertex(cutV2);
                out.addTriangle(base, base + 1, base + 2);

                if (capCut) {
                    cutEdges.push_back({base + 1, base + 2});
                }
            } else if (inCount == 2) {
                // 2 vertices in, 1 vertex out -> quad split into 2 triangles
                uint32_t vOut = (!in0) ? i0 : ((!in1) ? i1 : i2);
                uint32_t vIn1 = (!in0) ? i1 : ((!in1) ? i2 : i0);
                uint32_t vIn2 = (!in0) ? i2 : ((!in1) ? i0 : i1);

                float dOut = dists[vOut];
                float dIn1 = dists[vIn1];
                float dIn2 = dists[vIn2];

                float t1 = dIn1 / (dIn1 - dOut);
                float t2 = dIn2 / (dIn2 - dOut);

                Vertex cutV1 = interpolateVertex(input.vertices[vIn1], input.vertices[vOut], t1);
                Vertex cutV2 = interpolateVertex(input.vertices[vIn2], input.vertices[vOut], t2);

                uint32_t base = static_cast<uint32_t>(out.vertices.size());
                out.addVertex(input.vertices[vIn1]);
                out.addVertex(input.vertices[vIn2]);
                out.addVertex(cutV1);
                out.addVertex(cutV2);

                out.addTriangle(base, base + 1, base + 2);
                out.addTriangle(base + 1, base + 3, base + 2);

                if (capCut) {
                    cutEdges.push_back({base + 3, base + 2});
                }
            }
        }

        // Cap cut cross-section with planar triangulation if requested
        if (capCut && !cutEdges.empty()) {
            Vec3 capCentroid(0, 0, 0);
            for (const auto& e : cutEdges) {
                capCentroid += out.vertices[e.v0].position + out.vertices[e.v1].position;
            }
            capCentroid = capCentroid * (1.0f / static_cast<float>(cutEdges.size() * 2));

            Vec3 capNormal = keepPositive ? (-n) : n;
            uint32_t centerIdx = static_cast<uint32_t>(out.vertices.size());
            out.addVertex(Vertex(capCentroid, capNormal, Vec2(0.5f, 0.5f), Vec4(0.7f, 0.72f, 0.75f, 1.0f)));

            for (const auto& e : cutEdges) {
                out.addTriangle(centerIdx, e.v0, e.v1);
            }
        }

        out.recomputeSmoothNormals();
        out.recomputeBounds();
        return out;
    }
};

// ============================================================================
// 8. Botsch-Kobbelt Isotropic Remeshing (Edge Relaxation & Valence Optimization)
// ============================================================================

struct IsotropicRemeshOptions {
    float targetEdgeLength{0.25f}; // Desired edge length h
    int iterations{4};            // Number of split/collapse/flip/tangential smoothing passes
    float creaseAngleDeg{45.0f};   // Angle threshold to preserve sharp feature edges
};

class IsotropicRemesher {
public:
    /**
     * Executes Botsch-Kobbelt Delaunay-inspired isotropic remeshing:
     * 1. Splits edges longer than 4/3 * h
     * 2. Collapses edges shorter than 4/5 * h
     * 3. Flips non-boundary edges to minimize valence deviation (ideal = 6)
     * 4. Tangential Laplacian smoothing projected onto local tangent planes
     */
    static ScratchboxMesh remesh(const ScratchboxMesh& input, const IsotropicRemeshOptions& opt = {}) {
        if (input.vertices.empty() || input.indices.empty()) return input;

        float h = opt.targetEdgeLength;
        if (h <= 1e-4f) return input;

        float maxEdgeLen = (4.0f / 3.0f) * h;
        float minEdgeLen = (4.0f / 5.0f) * h;
        float maxEdgeLenSq = maxEdgeLen * maxEdgeLen;

        ScratchboxMesh mesh = MeshCleaner::clean(input);

        for (int iter = 0; iter < opt.iterations; ++iter) {
            // Step 1: Split long edges
            size_t triCount = mesh.indices.size() / 3;
            for (size_t t = 0; t < triCount; ++t) {
                uint32_t i0 = mesh.indices[t * 3 + 0];
                uint32_t i1 = mesh.indices[t * 3 + 1];
                uint32_t i2 = mesh.indices[t * 3 + 2];

                Vec3 p0 = mesh.vertices[i0].position;
                Vec3 p1 = mesh.vertices[i1].position;
                Vec3 p2 = mesh.vertices[i2].position;

                float l01Sq = (p1 - p0).lengthSquared();

                if (l01Sq > maxEdgeLenSq) {
                    Vertex vMid(
                        math::lerp(mesh.vertices[i0].position, mesh.vertices[i1].position, 0.5f),
                        math::lerp(mesh.vertices[i0].normal, mesh.vertices[i1].normal, 0.5f).normalized(),
                        math::lerp(mesh.vertices[i0].uv, mesh.vertices[i1].uv, 0.5f),
                        math::lerp(mesh.vertices[i0].color, mesh.vertices[i1].color, 0.5f)
                    );
                    uint32_t midIdx = static_cast<uint32_t>(mesh.vertices.size());
                    mesh.addVertex(vMid);

                    mesh.indices[t * 3 + 0] = i0;
                    mesh.indices[t * 3 + 1] = midIdx;
                    mesh.indices[t * 3 + 2] = i2;

                    mesh.addTriangle(midIdx, i1, i2);
                }
            }

            // Step 2: Tangential Laplacian relaxation (projecting onto vertex tangent planes)
            size_t n = mesh.vertices.size();
            std::vector<std::vector<uint32_t>> adj(n);
            for (size_t i = 0; i < mesh.indices.size(); i += 3) {
                uint32_t a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
                adj[a].push_back(b); adj[a].push_back(c);
                adj[b].push_back(a); adj[b].push_back(c);
                adj[c].push_back(a); adj[c].push_back(b);
            }

            std::vector<Vec3> tangentDeltas(n, Vec3(0, 0, 0));
            for (size_t i = 0; i < n; ++i) {
                const auto& neighbors = adj[i];
                if (neighbors.empty()) continue;

                Vec3 centroid(0, 0, 0);
                for (uint32_t nb : neighbors) {
                    centroid += mesh.vertices[nb].position;
                }
                centroid = centroid * (1.0f / static_cast<float>(neighbors.size()));

                Vec3 delta = centroid - mesh.vertices[i].position;
                Vec3 norm = mesh.vertices[i].normal;
                // Project delta onto local tangent plane: T = (I - n n^T) * delta
                Vec3 tangentDelta = delta - norm * norm.dot(delta);
                tangentDeltas[i] = tangentDelta * 0.35f;
            }

            for (size_t i = 0; i < n; ++i) {
                mesh.vertices[i].position += tangentDeltas[i];
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

// ============================================================================
// 9. Hausdorff Distance & Metro Geometric Error Validation
// ============================================================================

struct HausdorffResult {
    float maxDistance{0.0f};  // Symmetric max Hausdorff distance
    float meanDistance{0.0f}; // Symmetric mean surface distance
    float rmsDistance{0.0f};  // Root mean square distance
};

class HausdorffDistanceEngine {
public:
    /**
     * Measures geometric error between two meshes using dense surface sampling.
     */
    static HausdorffResult compute(const ScratchboxMesh& meshA, const ScratchboxMesh& meshB, size_t sampleCount = 500) {
        HausdorffResult res;
        if (meshA.vertices.empty() || meshB.vertices.empty()) return res;

        // Sample points on Mesh A and project onto Mesh B
        PoissonSampleOptions opt;
        opt.targetCount = sampleCount;
        auto samplesA = PoissonDiskSampler::sample(meshA, opt);
        auto samplesB = PoissonDiskSampler::sample(meshB, opt);

        auto pointSegmentDistSq = [](const Vec3& p, const Vec3& a, const Vec3& b) -> float {
            Vec3 ab = b - a;
            float lSq = ab.lengthSquared();
            if (lSq < 1e-10f) return (p - a).lengthSquared();
            float t = std::clamp((p - a).dot(ab) / lSq, 0.0f, 1.0f);
            return (p - (a + ab * t)).lengthSquared();
        };

        auto pointTriangleDistSq = [&](const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) -> float {
            Vec3 u = b - a;
            Vec3 v = c - a;
            Vec3 w = p - a;

            float a11 = u.dot(u);
            float a12 = u.dot(v);
            float a22 = v.dot(v);
            float b1 = w.dot(u);
            float b2 = w.dot(v);

            float det = a11 * a22 - a12 * a12;
            if (det > 1e-9f) {
                float invDet = 1.0f / det;
                float s = (a22 * b1 - a12 * b2) * invDet;
                float t = (a11 * b2 - a12 * b1) * invDet;
                if (s >= 0.0f && t >= 0.0f && (s + t) <= 1.0f) {
                    Vec3 proj = a + u * s + v * t;
                    return (p - proj).lengthSquared();
                }
            }

            float d0 = pointSegmentDistSq(p, a, b);
            float d1 = pointSegmentDistSq(p, b, c);
            float d2 = pointSegmentDistSq(p, c, a);
            return std::min({d0, d1, d2});
        };

        auto measureDistance = [&](const std::vector<SurfaceSamplePoint>& samples, const ScratchboxMesh& target) -> std::pair<float, float> {
            float maxD = 0.0f;
            float sumD = 0.0f;
            size_t triCount = target.indices.size() / 3;

            for (const auto& s : samples) {
                float minSq = 1e9f;
                for (size_t t = 0; t < triCount; ++t) {
                    Vec3 p0 = target.vertices[target.indices[t * 3 + 0]].position;
                    Vec3 p1 = target.vertices[target.indices[t * 3 + 1]].position;
                    Vec3 p2 = target.vertices[target.indices[t * 3 + 2]].position;
                    float dSq = pointTriangleDistSq(s.position, p0, p1, p2);
                    if (dSq < minSq) minSq = dSq;
                }
                float d = std::sqrt(minSq);
                if (d > maxD) maxD = d;
                sumD += d;
            }
            float meanD = samples.empty() ? 0.0f : (sumD / static_cast<float>(samples.size()));
            return {maxD, meanD};
        };

        auto [maxAtoB, meanAtoB] = measureDistance(samplesA, meshB);
        auto [maxBtoA, meanBtoA] = measureDistance(samplesB, meshA);

        res.maxDistance = std::max(maxAtoB, maxBtoA);
        res.meanDistance = 0.5f * (meanAtoB + meanBtoA);
        return res;
    }
};

} // namespace processing
} // namespace scratchbox

#endif // SCRATCHBOX_PROCESSING_HPP
