/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FIELD_REMESH_HPP
#define SCRATCHBOX_FIELD_REMESH_HPP

/**
 * Field-aligned quad remesher (C++20).
 *
 * 1. Weld, split edges longer than half the target spacing, detect creases and open edges.
 * 2. Per-vertex 4-RoSy orientation field and 4-PoSy position field, smoothed coarse to fine over a matching hierarchy
 *    (extrinsic smoothing as in Jakob et al. 2015, "Instant Field-Aligned Meshes"); creases and open edges pin the
 *    orientation, an optional Manhattan prior pulls facades plumb.
 * 3. Integer lattice offsets per edge, then the per-triangle sums made zero by a min-cost flow on the triangle
 *    equations after a spanning-tree orientation gauge (the integer step of Huang et al. 2018, "QuadriFlow"): a
 *    position field that does not close around a triangle is what makes the extra valence-3/5 vertices and holes the
 *    plain rounding leaves.
 * 4. Edges with zero offset collapse their ends; the surviving lattice triangles join across their diagonals into
 *    quads; anything else becomes one polygon, and any hole an inverted triangle leaves is closed by a polygon, so a
 *    closed input stays closed.
 * 5. Vertices relaxed tangentially and projected back onto the source (BVH closest point).
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_mesh_audit.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <numeric>
#include <queue>
#include <random>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace scratchbox {
namespace remesh {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using bvh::BvhTree;

// ============================================================================
// 1. Options & telemetry
// ============================================================================

struct QuadRemeshOptions {
    size_t targetQuadCount{2000};       // desired quad budget (sets the spacing h = sqrt(area / quads))
    double targetEdgeLength{0.0};       // explicit spacing in mesh units; overrides targetQuadCount when > 0
    float creaseAngleDeg{35.0f};        // dihedral angle that pins the orientation field to the edge
    bool alignToManhattanAxes{true};    // pull near-vertical and near-horizontal surfaces to the plumb / street axes
    float dominantYawDeg{0.0f};         // street canyon rotation about Y for the Manhattan prior
    bool preserveBoundaryEdges{true};   // open edges pin the orientation field to their direction
    int smoothingIterations{25};        // orientation and position sweeps on the finest level (coarser levels use half)
    int tangentRelaxationPasses{3};     // tangential smoothing + reprojection passes on the output
    bool integerFlow{true};             // the min-cost flow that closes the lattice offsets around every triangle
    bool weldInput{true};               // weld seam-split vertices by position first (off for an already indexed surface)
    uint32_t seed{7};
    // kept for callers of the earlier API; the extraction no longer uses them
    float minEdgeLengthRatio{0.25f};
    float maxEdgeLengthRatio{2.0f};
};

struct RemeshTelemetry {
    size_t inputTriangleCount{0};
    size_t workingTriangleCount{0};      // after the edge split
    size_t outputQuadCount{0};
    size_t outputPolygonCount{0};        // all faces, quads included
    size_t outputTriangleCount{0};       // triangles in the emitted mesh
    size_t singularityCount{0};          // interior vertices of valence other than 4
    size_t orientationSingularities{0};  // triangles the cross field turns a quarter around
    size_t flowSupply{0};                // unit imbalance the integer step had to move
    size_t flowUnmet{0};                 // imbalance left (triangles that still do not close)
    size_t flippedTriangles{0};          // lattice triangles with negative area (dropped, hole closed by a polygon)
    size_t holesClosed{0};
    float pureQuadRatio{0.0f};
    float meanQuadAspect{1.0f};
    float meanOrthogonalityDeg{90.0f};   // mean interior corner angle of the quads
    float meanAngleDeviationDeg{0.0f};   // mean |corner - 90|
    float maxOrthogonalityDeviationDeg{0.0f};
    float meanScaledJacobian{1.0f};
    float minScaledJacobian{1.0f};
    float meanSurfaceErrorMeters{0.0f};
    double targetEdgeLength{0.0};
    double msPrepare{0.0}, msOrientation{0.0}, msPosition{0.0}, msExtract{0.0}, msRelax{0.0};
    double elapsedMs{0.0};
    size_t sharpCreaseEdges{0};

    void printSummary() const {
        std::cout << "\n======================================================================\n";
        std::cout << "  SCRATCHBOX FIELD-ALIGNED QUAD REMESHER TELEMETRY\n";
        std::cout << "======================================================================\n";
        std::cout << "  Input Triangles:         " << inputTriangleCount << "\n";
        std::cout << "  Output Quads:            " << outputQuadCount << "\n";
        std::cout << "  Output Polygons:         " << outputPolygonCount << "\n";
        std::cout << "  Pure Quad Ratio:         " << std::fixed << std::setprecision(1) << (pureQuadRatio * 100.0f) << "%\n";
        std::cout << "  Singularities (val 3/5): " << singularityCount << "\n";
        std::cout << "  Field Singularities:     " << orientationSingularities << "\n";
        std::cout << "  Integer Flow Supply:     " << flowSupply << " (unmet " << flowUnmet << ")\n";
        std::cout << "  Mean Quad Aspect Ratio:  " << std::setprecision(3) << meanQuadAspect << " (ideal = 1.000)\n";
        std::cout << "  Mean Corner Angle:       " << std::setprecision(1) << meanOrthogonalityDeg << " deg (ideal = 90.0 deg)\n";
        std::cout << "  Mean Angle Deviation:    " << std::setprecision(2) << meanAngleDeviationDeg << " deg\n";
        std::cout << "  Max Angle Deviation:     " << std::setprecision(1) << maxOrthogonalityDeviationDeg << " deg\n";
        std::cout << "  Mean Scaled Jacobian:    " << std::setprecision(3) << meanScaledJacobian << " (min " << minScaledJacobian << ")\n";
        std::cout << "  Mean Surface Deviation:  " << std::setprecision(4) << (meanSurfaceErrorMeters * 1000.0f) << " mm\n";
        std::cout << "  Sharp Crease Edges:      " << sharpCreaseEdges << "\n";
        std::cout << "  Processing Runtime:      " << std::setprecision(2) << elapsedMs << " ms\n";
        std::cout << "======================================================================\n\n";
    }
};

/** A polygon mesh: face f has vertices faceVerts[faceStart[f] .. faceStart[f + 1]), counter-clockwise outward. */
struct PolyMesh {
    std::vector<Vec3> positions;
    std::vector<uint32_t> faceStart{0};
    std::vector<uint32_t> faceVerts;
    size_t faceCount() const { return faceStart.size() - 1; }
    uint32_t degree(size_t f) const { return faceStart[f + 1] - faceStart[f]; }
    void addFace(const std::vector<uint32_t>& vs) {
        faceVerts.insert(faceVerts.end(), vs.begin(), vs.end());
        faceStart.push_back(static_cast<uint32_t>(faceVerts.size()));
    }
};

namespace field {

// ---------------------------------------------------------------------------
// Small double-precision vector and the lattice helpers
// ---------------------------------------------------------------------------

struct D3 {
    double x{0}, y{0}, z{0};
    D3() = default;
    D3(double a, double b, double c) : x(a), y(b), z(c) {}
    explicit D3(const Vec3& v) : x(v.x), y(v.y), z(v.z) {}
    D3 operator+(const D3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    D3 operator-(const D3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    D3 operator*(double s) const { return {x * s, y * s, z * s}; }
    D3 operator-() const { return {-x, -y, -z}; }
    D3& operator+=(const D3& o) { x += o.x; y += o.y; z += o.z; return *this; }
    double dot(const D3& o) const { return x * o.x + y * o.y + z * o.z; }
    D3 cross(const D3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double norm() const { return std::sqrt(dot(*this)); }
    D3 normalized() const { double l = norm(); return l > 1e-300 ? *this * (1.0 / l) : D3(0, 0, 0); }
    Vec3 f() const { return Vec3(float(x), float(y), float(z)); }
};

struct I2 { int x{0}, y{0}; bool operator==(const I2& o) const { return x == o.x && y == o.y; } };
/** Counter-clockwise quarter turns of integer lattice coordinates. */
inline I2 rot(I2 v, int k) {
    k = ((k % 4) + 4) % 4;
    for (int i = 0; i < k; ++i) v = {-v.y, v.x};
    return v;
}
inline I2 operator+(I2 a, I2 b) { return {a.x + b.x, a.y + b.y}; }
inline I2 operator-(I2 a) { return {-a.x, -a.y}; }

inline D3 projectTangent(const D3& v, const D3& n) { return v - n * n.dot(v); }
inline D3 anyTangent(const D3& n) {
    D3 a = std::abs(n.x) < 0.9 ? D3(1, 0, 0) : D3(0, 1, 0);
    return projectTangent(a, n).normalized();
}
/** q turned k quarter turns about n (q tangent to n). */
inline D3 rotate90(const D3& q, const D3& n, int k) {
    k = ((k % 4) + 4) % 4;
    D3 r = q;
    for (int i = 0; i < k; ++i) r = n.cross(r);
    return r;
}

/** The pair of representatives of two 4-RoSy directions that agree best: (a in {q0, n0 x q0}, +-b of {q1, n1 x q1}). */
inline std::pair<D3, D3> compatOrientation(const D3& q0, const D3& n0, const D3& q1, const D3& n1) {
    const D3 A[2] = {q0, n0.cross(q0)};
    const D3 B[2] = {q1, n1.cross(q1)};
    double best = -1;
    int bi = 0, bj = 0;
    for (int i = 0; i < 2; ++i)
        for (int j = 0; j < 2; ++j) {
            double s = std::abs(A[i].dot(B[j]));
            if (s > best) { best = s; bi = i; bj = j; }
        }
    double sgn = A[bi].dot(B[bj]) >= 0 ? 1.0 : -1.0;
    return {A[bi], B[bj] * sgn};
}

/** The quarter turn r for which q1 turned by r about n1 best matches q0. */
inline int compatOrientationIndex(const D3& q0, const D3& n0, const D3& q1, const D3& n1) {
    (void)n0;
    double best = -2;
    int br = 0;
    for (int r = 0; r < 4; ++r) {
        double s = q0.dot(rotate90(q1, n1, r));
        if (s > best) { best = s; br = r; }
    }
    return br;
}

/** The point the two tangent planes nearly share, between the two samples. */
inline D3 middlePoint(const D3& p0, const D3& n0, const D3& p1, const D3& n1) {
    double n0p0 = n0.dot(p0), n0p1 = n0.dot(p1), n1p0 = n1.dot(p0), n1p1 = n1.dot(p1), n0n1 = n0.dot(n1);
    double denom = 1.0 / (1.0 - n0n1 * n0n1 + 1e-4);
    double l0 = 2.0 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * denom;
    double l1 = 2.0 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * denom;
    return (p0 + p1) * 0.5 - (n0 * l0 + n1 * l1) * 0.25;
}

inline D3 latticeFloor(const D3& o, const D3& q, const D3& n, const D3& p, double h) {
    D3 t = n.cross(q), d = p - o;
    return o + q * (std::floor(q.dot(d) / h) * h) + t * (std::floor(t.dot(d) / h) * h);
}
inline D3 latticeRound(const D3& o, const D3& q, const D3& n, const D3& p, double h) {
    D3 t = n.cross(q), d = p - o;
    return o + q * (std::round(q.dot(d) / h) * h) + t * (std::round(t.dot(d) / h) * h);
}

/** The lattice points of the two samples' lattices that come closest, near the samples' shared middle point. */
inline std::pair<D3, D3> compatPosition(const D3& p0, const D3& n0, const D3& q0, const D3& o0,
                                        const D3& p1, const D3& n1, const D3& q1, const D3& o1, double h) {
    D3 t0 = n0.cross(q0), t1 = n1.cross(q1);
    D3 mid = middlePoint(p0, n0, p1, n1);
    D3 a = latticeFloor(o0, q0, n0, mid, h), b = latticeFloor(o1, q1, n1, mid, h);
    double best = std::numeric_limits<double>::infinity();
    std::pair<D3, D3> out{a, b};
    for (int i = 0; i < 4; ++i) {
        D3 ai = a + (q0 * double(i & 1) + t0 * double((i >> 1) & 1)) * h;
        for (int j = 0; j < 4; ++j) {
            D3 bj = b + (q1 * double(j & 1) + t1 * double((j >> 1) & 1)) * h;
            double c = (ai - bj).dot(ai - bj);
            if (c < best) { best = c; out = {ai, bj}; }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Working triangle mesh with opposite half-edges
// ---------------------------------------------------------------------------

struct TriMesh {
    std::vector<D3> p;
    std::vector<D3> n;
    std::vector<std::array<uint32_t, 3>> f;
    std::vector<int64_t> opp;  // half-edge 3 f + k (f[k] -> f[k+1]) -> its opposite, -1 on an open or non-manifold edge

    void buildOpposites() {
        opp.assign(f.size() * 3, -1);
        std::unordered_map<uint64_t, int64_t> dir;
        std::unordered_map<uint64_t, int> uses;
        dir.reserve(f.size() * 3);
        for (size_t t = 0; t < f.size(); ++t)
            for (int k = 0; k < 3; ++k) {
                uint32_t a = f[t][k], b = f[t][(k + 1) % 3];
                uint64_t ukey = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
                uses[ukey]++;
                dir[uint64_t(a) << 32 | b] = int64_t(t * 3 + k);
            }
        for (size_t t = 0; t < f.size(); ++t)
            for (int k = 0; k < 3; ++k) {
                uint32_t a = f[t][k], b = f[t][(k + 1) % 3];
                uint64_t ukey = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
                if (uses[ukey] != 2) continue;
                auto it = dir.find(uint64_t(b) << 32 | a);
                if (it != dir.end()) opp[t * 3 + k] = it->second;
            }
    }
    void computeNormals() {
        n.assign(p.size(), D3(0, 0, 0));
        for (const auto& t : f) {
            D3 fn = (p[t[1]] - p[t[0]]).cross(p[t[2]] - p[t[0]]);
            for (int k = 0; k < 3; ++k) n[t[k]] += fn;
        }
        for (auto& x : n) { x = x.normalized(); if (x.norm() == 0) x = D3(0, 0, 1); }
    }
    double area() const {
        double a = 0;
        for (const auto& t : f) a += 0.5 * (p[t[1]] - p[t[0]]).cross(p[t[2]] - p[t[0]]).norm();
        return a;
    }
};

/** Welds by exact position (or keeps the mesh's own indices) and drops degenerate triangles. */
inline TriMesh fromMesh(const ScratchboxMesh& m, bool weld = true) {
    TriMesh tm;
    auto w = mesh_audit::weldByPosition(m, weld ? 0.0f : -1.0f);
    tm.p.reserve(w.positions.size());
    for (const auto& v : w.positions) tm.p.emplace_back(v);
    for (const auto& t : w.triangles) {
        if (t[0] == t[1] || t[1] == t[2] || t[0] == t[2]) continue;
        tm.f.push_back(t);
    }
    return tm;
}

/** Splits every edge longer than maxLen at its midpoint until none is (longest first; both sides of an edge split). */
inline void splitLongEdges(TriMesh& m, double maxLen, size_t maxTriangles) {
    const double max2 = maxLen * maxLen;
    for (int pass = 0; pass < 32; ++pass) {
        std::unordered_map<uint64_t, uint32_t> dir;  // directed edge -> triangle
        dir.reserve(m.f.size() * 3);
        for (uint32_t t = 0; t < m.f.size(); ++t)
            for (int k = 0; k < 3; ++k) dir[uint64_t(m.f[t][k]) << 32 | m.f[t][(k + 1) % 3]] = t;
        std::unordered_set<uint64_t> sharedAtStart;
        for (const auto& [key, t] : dir) {
            uint32_t a = uint32_t(key >> 32), b = uint32_t(key & 0xffffffffu);
            if (a < b && dir.count(uint64_t(b) << 32 | a)) sharedAtStart.insert(uint64_t(a) << 32 | b);
        }
        std::vector<std::pair<double, uint64_t>> longEdges;
        for (uint32_t t = 0; t < m.f.size(); ++t)
            for (int k = 0; k < 3; ++k) {
                uint32_t a = m.f[t][k], b = m.f[t][(k + 1) % 3];
                if (a > b && dir.count(uint64_t(b) << 32 | a)) continue;  // shared edge, taken from its low end
                double l2 = (m.p[a] - m.p[b]).dot(m.p[a] - m.p[b]);
                if (l2 > max2) longEdges.push_back({l2, uint64_t(a) << 32 | b});
            }
        if (longEdges.empty()) return;
        std::sort(longEdges.begin(), longEdges.end(), [](auto& x, auto& y) { return x.first > y.first; });
        bool any = false;
        for (const auto& [l2, key] : longEdges) {
            if (m.f.size() + 2 > maxTriangles) return;
            uint32_t a = uint32_t(key >> 32), b = uint32_t(key & 0xffffffffu);
            auto it1 = dir.find(uint64_t(a) << 32 | b);
            if (it1 == dir.end()) continue;  // already split this pass
            auto it2 = dir.find(uint64_t(b) << 32 | a);
            // a shared edge whose other triangle was already split this pass waits for the next pass: splitting
            // one side alone would leave a T-junction (an open edge)
            if (it2 == dir.end() && sharedAtStart.count(a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a))) continue;
            uint32_t mid = static_cast<uint32_t>(m.p.size());
            m.p.push_back((m.p[a] + m.p[b]) * 0.5);
            auto splitTri = [&](uint32_t t, uint32_t u, uint32_t v) {
                // triangle t holds the directed edge u -> v; c is its third corner
                auto tri = m.f[t];
                int k = 0;
                while (!(tri[k] == u && tri[(k + 1) % 3] == v)) ++k;
                uint32_t c = tri[(k + 2) % 3];
                for (int e = 0; e < 3; ++e) dir.erase(uint64_t(tri[e]) << 32 | tri[(e + 1) % 3]);
                m.f[t] = {u, mid, c};
                uint32_t t2 = static_cast<uint32_t>(m.f.size());
                m.f.push_back({mid, v, c});
                // the halves are new edges: not split again this pass
                (void)t2;
            };
            uint32_t t1 = it1->second;
            int64_t t2 = it2 != dir.end() ? int64_t(it2->second) : -1;
            splitTri(t1, a, b);
            if (t2 >= 0) splitTri(uint32_t(t2), b, a);
            any = true;
        }
        if (!any) return;
    }
}

// ---------------------------------------------------------------------------
// Matching hierarchy for coarse-to-fine field smoothing
// ---------------------------------------------------------------------------

struct Level {
    std::vector<D3> p, n;
    std::vector<double> area;
    std::vector<std::vector<uint32_t>> adj;
    std::vector<uint32_t> toParent;          // into the next coarser level
    std::vector<uint8_t> pinned;             // orientation pinned (crease / open edge)
    std::vector<D3> pinDir;
};

inline Level coarsen(Level& fine) {
    const size_t N = fine.p.size();
    struct Cand { double score; uint32_t a, b; };
    std::vector<Cand> cand;
    for (uint32_t i = 0; i < N; ++i)
        for (uint32_t j : fine.adj[i])
            if (i < j) {
                double ar = std::min(fine.area[i], fine.area[j]) / std::max({fine.area[i], fine.area[j], 1e-300});
                cand.push_back({fine.n[i].dot(fine.n[j]) * ar, i, j});
            }
    std::sort(cand.begin(), cand.end(), [](const Cand& x, const Cand& y) { return x.score > y.score; });
    std::vector<int64_t> partner(N, -1);
    std::vector<uint8_t> done(N, 0);
    for (const auto& c : cand) {
        if (done[c.a] || done[c.b]) continue;
        done[c.a] = done[c.b] = 1;
        partner[c.a] = c.b;
        partner[c.b] = c.a;
    }
    Level coarse;
    fine.toParent.assign(N, 0);
    for (uint32_t i = 0; i < N; ++i) {
        if (partner[i] >= 0 && uint32_t(partner[i]) < i) continue;
        uint32_t id = static_cast<uint32_t>(coarse.p.size());
        double ai = fine.area[i];
        D3 p = fine.p[i] * ai, n = fine.n[i] * ai;
        double a = ai;
        uint8_t pin = fine.pinned[i];
        D3 pd = fine.pinDir[i];
        fine.toParent[i] = id;
        if (partner[i] >= 0) {
            uint32_t j = uint32_t(partner[i]);
            double aj = fine.area[j];
            p += fine.p[j] * aj; n += fine.n[j] * aj; a += aj;
            fine.toParent[j] = id;
            if (!pin && fine.pinned[j]) { pin = 1; pd = fine.pinDir[j]; }
        }
        D3 nn = n.normalized();
        if (nn.norm() == 0) nn = fine.n[i];
        coarse.p.push_back(p * (1.0 / std::max(a, 1e-300)));
        coarse.n.push_back(nn);
        coarse.area.push_back(a);
        coarse.pinned.push_back(pin);
        coarse.pinDir.push_back(pin ? projectTangent(pd, nn).normalized() : D3());
    }
    coarse.adj.resize(coarse.p.size());
    for (uint32_t i = 0; i < N; ++i)
        for (uint32_t j : fine.adj[i]) {
            uint32_t a = fine.toParent[i], b = fine.toParent[j];
            if (a != b) coarse.adj[a].push_back(b);
        }
    for (auto& l : coarse.adj) { std::sort(l.begin(), l.end()); l.erase(std::unique(l.begin(), l.end()), l.end()); }
    for (size_t i = 0; i < coarse.pinned.size(); ++i) if (coarse.pinned[i] && coarse.pinDir[i].norm() == 0) coarse.pinned[i] = 0;
    return coarse;
}

// ---------------------------------------------------------------------------
// Min-cost flow: successive shortest paths with potentials, unit augmentations, early exit at the sink
// ---------------------------------------------------------------------------

class MinCostFlow {
public:
    struct Arc { uint32_t to; int32_t cap; int64_t cost; uint32_t rev; int64_t tag; };
    explicit MinCostFlow(size_t n) : g_(n) {}
    /** An arc u -> v of capacity cap and unit cost; `tag` identifies it for reading its flow back. */
    void addArc(uint32_t u, uint32_t v, int32_t cap, int64_t cost, int64_t tag) {
        g_[u].push_back({v, cap, cost, static_cast<uint32_t>(g_[v].size()), tag});
        g_[v].push_back({u, 0, -cost, static_cast<uint32_t>(g_[u].size() - 1), -1});
    }
    /** Sends up to `want` units from s to t at least cost; returns the units sent. */
    int64_t run(uint32_t s, uint32_t t, int64_t want) {
        const size_t N = g_.size();
        const int64_t INF = std::numeric_limits<int64_t>::max();
        std::vector<int64_t> pot(N, 0), dist(N, INF);
        std::vector<uint32_t> prevNode(N), prevArc(N);
        std::vector<uint8_t> fin(N, 0);
        std::vector<uint32_t> visited;
        int64_t sent = 0;
        using QE = std::pair<int64_t, uint32_t>;
        while (sent < want) {
            for (uint32_t u : visited) { dist[u] = INF; fin[u] = 0; }
            visited.clear();
            std::priority_queue<QE, std::vector<QE>, std::greater<QE>> pq;
            dist[s] = 0;
            visited.push_back(s);
            pq.push({0, s});
            std::vector<uint32_t> finalised;
            while (!pq.empty()) {
                auto [d, u] = pq.top();
                pq.pop();
                if (fin[u] || d > dist[u]) continue;
                fin[u] = 1;
                finalised.push_back(u);
                if (u == t) break;
                for (uint32_t k = 0; k < g_[u].size(); ++k) {
                    const Arc& a = g_[u][k];
                    if (a.cap <= 0) continue;
                    int64_t nd = d + a.cost + pot[u] - pot[a.to];
                    if (nd < dist[a.to]) {
                        if (dist[a.to] == INF) visited.push_back(a.to);
                        dist[a.to] = nd; prevNode[a.to] = u; prevArc[a.to] = k; pq.push({nd, a.to});
                    }
                }
            }
            if (!fin[t]) break;
            // Potentials: pot += min(dist, D) keeps reduced costs >= 0; adding D to every node changes nothing, so
            // only the finalised nodes move, by dist - D.
            const int64_t D = dist[t];
            for (uint32_t u : finalised) pot[u] += dist[u] - D;
            int32_t f = std::numeric_limits<int32_t>::max();
            for (uint32_t v = t; v != s; v = prevNode[v]) f = std::min(f, g_[prevNode[v]][prevArc[v]].cap);
            f = static_cast<int32_t>(std::min<int64_t>(f, want - sent));
            for (uint32_t v = t; v != s; v = prevNode[v]) {
                Arc& a = g_[prevNode[v]][prevArc[v]];
                a.cap -= f;
                g_[v][a.rev].cap += f;
            }
            sent += f;
        }
        return sent;
    }
    /** Flow on every tagged arc (its reverse arc's capacity). */
    void forEachTagged(const std::function<void(int64_t tag, int32_t flow)>& fn) const {
        for (const auto& list : g_)
            for (const auto& a : list)
                if (a.tag >= 0) fn(a.tag, g_[a.to][a.rev].cap);
    }
private:
    std::vector<std::vector<Arc>> g_;
};

}  // namespace field

// ============================================================================
// 2. Crease & open-edge detection
// ============================================================================

class CreaseDetector {
public:
    /** Per half-edge: 1 when its dihedral angle passes the threshold or it is open. Returns the undirected count. */
    static size_t detect(const field::TriMesh& m, float creaseAngleDeg, bool boundaries, std::vector<uint8_t>& crease) {
        const double cosT = std::cos(creaseAngleDeg * PI / 180.0);
        crease.assign(m.f.size() * 3, 0);
        std::vector<field::D3> fn(m.f.size());
        for (size_t t = 0; t < m.f.size(); ++t) fn[t] = (m.p[m.f[t][1]] - m.p[m.f[t][0]]).cross(m.p[m.f[t][2]] - m.p[m.f[t][0]]).normalized();
        size_t count = 0;
        for (size_t he = 0; he < crease.size(); ++he) {
            int64_t o = m.opp[he];
            if (o < 0) { if (boundaries) { crease[he] = 1; count++; } continue; }
            if (fn[he / 3].dot(fn[size_t(o) / 3]) < cosT) { crease[he] = 1; if (int64_t(he) < o) count++; }
        }
        return count;
    }
};

// ============================================================================
// 3. 4-RoSy orientation field
// ============================================================================

class FourRoSyFieldSolver {
public:
    /** Smooths per-vertex cross directions over the hierarchy, coarse to fine; pinned vertices keep their direction. */
    static void solve(std::vector<field::Level>& levels, std::vector<std::vector<field::D3>>& q, const QuadRemeshOptions& opt) {
        using namespace field;
        const int L = static_cast<int>(levels.size());
        q.assign(L, {});
        std::mt19937 rng(opt.seed);
        const double yaw = opt.dominantYawDeg * PI / 180.0;
        const D3 mx(std::cos(yaw), 0, -std::sin(yaw)), up(0, 1, 0);
        auto prior = [&](const D3& n) -> std::pair<D3, double> {
            if (!opt.alignToManhattanAxes) return {D3(), 0.0};
            double ny = std::abs(n.y);
            if (ny < 0.35) return {projectTangent(up, n).normalized(), 1.0};
            if (ny > 0.85) return {projectTangent(mx, n).normalized(), 1.0};
            return {D3(), 0.0};
        };
        for (int l = L - 1; l >= 0; --l) {
            Level& lv = levels[l];
            auto& ql = q[l];
            ql.resize(lv.p.size());
            if (l == L - 1) {
                for (size_t i = 0; i < ql.size(); ++i) {
                    auto pr = prior(lv.n[i]);
                    ql[i] = pr.second > 0 && pr.first.norm() > 0 ? pr.first : anyTangent(lv.n[i]);
                }
            } else {
                for (size_t i = 0; i < ql.size(); ++i) {
                    D3 v = projectTangent(q[l + 1][lv.toParent[i]], lv.n[i]).normalized();
                    ql[i] = v.norm() > 0 ? v : anyTangent(lv.n[i]);
                }
            }
            for (size_t i = 0; i < ql.size(); ++i) if (lv.pinned[i]) ql[i] = lv.pinDir[i];
            std::vector<uint32_t> order(ql.size());
            std::iota(order.begin(), order.end(), 0u);
            const int sweeps = l == 0 ? std::max(4, opt.smoothingIterations) : std::max(4, opt.smoothingIterations / 2);
            for (int it = 0; it < sweeps; ++it) {
                std::shuffle(order.begin(), order.end(), rng);
                for (uint32_t i : order) {
                    if (lv.pinned[i] || lv.adj[i].empty()) continue;
                    const D3& ni = lv.n[i];
                    D3 sum = ql[i];
                    double w = 1.0;
                    auto pr = prior(ni);
                    if (pr.second > 0 && pr.first.norm() > 0) {
                        auto c = compatOrientation(sum, ni, pr.first, ni);
                        sum = c.first * w + c.second * pr.second;
                        w += pr.second;
                        sum = projectTangent(sum, ni).normalized();
                    }
                    for (uint32_t j : lv.adj[i]) {
                        auto c = compatOrientation(sum, ni, ql[j], lv.n[j]);
                        sum = c.first * w + c.second * 1.0;
                        w += 1.0;
                        sum = projectTangent(sum, ni).normalized();
                        if (sum.norm() == 0) sum = anyTangent(ni);
                    }
                    ql[i] = sum;
                }
            }
        }
    }
};

// ============================================================================
// 4. 4-PoSy position field
// ============================================================================

class PositionFieldOptimizer {
public:
    /** Spacing h for a quad budget: area per quad = h^2. */
    static double spacingFor(double area, size_t targetQuadCount) {
        if (targetQuadCount == 0) targetQuadCount = 1000;
        return std::sqrt(area / static_cast<double>(targetQuadCount));
    }

    /** Smooths per-vertex lattice origins over the hierarchy, coarse to fine, each rounded to the lattice near its vertex. */
    static void solve(std::vector<field::Level>& levels, const std::vector<std::vector<field::D3>>& q,
                      std::vector<std::vector<field::D3>>& o, double h, const QuadRemeshOptions& opt) {
        using namespace field;
        const int L = static_cast<int>(levels.size());
        o.assign(L, {});
        std::mt19937 rng(opt.seed + 1);
        for (int l = L - 1; l >= 0; --l) {
            Level& lv = levels[l];
            auto& ol = o[l];
            const auto& ql = q[l];
            ol.resize(lv.p.size());
            for (size_t i = 0; i < ol.size(); ++i) {
                D3 init = l == L - 1 ? lv.p[i] : o[l + 1][lv.toParent[i]];
                init = init - lv.n[i] * lv.n[i].dot(init - lv.p[i]);
                ol[i] = latticeRound(init, ql[i], lv.n[i], lv.p[i], h);
            }
            std::vector<uint32_t> order(ol.size());
            std::iota(order.begin(), order.end(), 0u);
            const int sweeps = l == 0 ? std::max(4, opt.smoothingIterations) : std::max(4, opt.smoothingIterations / 2);
            for (int it = 0; it < sweeps; ++it) {
                std::shuffle(order.begin(), order.end(), rng);
                for (uint32_t i : order) {
                    if (lv.adj[i].empty()) continue;
                    const D3 &pi = lv.p[i], &ni = lv.n[i], &qi = ql[i];
                    D3 sum = ol[i];
                    double w = 1.0;
                    for (uint32_t j : lv.adj[i]) {
                        auto c = compatPosition(pi, ni, qi, sum, lv.p[j], lv.n[j], ql[j], ol[j], h);
                        sum = (c.first * w + c.second) * (1.0 / (w + 1.0));
                        w += 1.0;
                        sum = sum - ni * ni.dot(sum - pi);
                    }
                    ol[i] = latticeRound(sum, qi, ni, pi, h);
                }
            }
        }
    }
};

// ============================================================================
// 5. Integer offsets, min-cost flow and quad extraction
// ============================================================================

class QuadExtractor {
public:
    struct Result {
        PolyMesh poly;
        size_t orientationSingularities{0};
        size_t flowSupply{0}, flowUnmet{0}, flipped{0}, holesClosed{0};
    };

    /** Bowtie vertices: the largest fan keeps the vertex, small extra fans are removed (their hole closed by the caller),
     *  larger ones get their own copy of the vertex (moved a fiftieth toward the fan). */
    static size_t splitNonManifoldVertices(std::vector<std::vector<uint32_t>>& faces, std::vector<Vec3>& pos, bool allowDrop = true) {
        struct Corner { uint32_t face, k; };
        std::vector<std::vector<Corner>> at(pos.size());
        for (uint32_t f = 0; f < faces.size(); ++f) for (uint32_t k = 0; k < faces[f].size(); ++k) at[faces[f][k]].push_back({f, k});
        size_t splits = 0;
        const size_t V0 = pos.size();
        std::vector<uint8_t> dropFace(faces.size(), 0);
        for (uint32_t v = 0; v < V0; ++v) {
            auto& cs = at[v];
            if (cs.size() <= 1) continue;
            std::vector<uint32_t> par(cs.size());
            std::iota(par.begin(), par.end(), 0u);
            auto fnd = [&](uint32_t x) { while (par[x] != x) { par[x] = par[par[x]]; x = par[x]; } return x; };
            std::unordered_map<uint32_t, uint32_t> byPrev;  // corner whose face enters v from x (x -> v)
            for (uint32_t i = 0; i < cs.size(); ++i) {
                const auto& fv = faces[cs[i].face];
                byPrev[fv[(cs[i].k + fv.size() - 1) % fv.size()]] = i;
            }
            for (uint32_t i = 0; i < cs.size(); ++i) {
                const auto& fv = faces[cs[i].face];
                uint32_t next = fv[(cs[i].k + 1) % fv.size()];  // v -> next; the neighbour across holds next -> v
                auto it = byPrev.find(next);
                if (it != byPrev.end()) par[fnd(i)] = fnd(it->second);
            }
            std::unordered_map<uint32_t, std::vector<uint32_t>> fans;
            for (uint32_t i = 0; i < cs.size(); ++i) fans[fnd(i)].push_back(i);
            if (fans.size() <= 1) continue;
            // the largest fan keeps the vertex; a small extra fan (a few faces pinched on) is removed and its hole
            // closed later, a large one gets its own copy of the vertex
            uint32_t keepRoot = 0;
            size_t keepSize = 0;
            for (auto& [root, members] : fans) if (members.size() > keepSize) { keepSize = members.size(); keepRoot = root; }
            for (auto& [root, members] : fans) {
                if (root == keepRoot) continue;
                if (allowDrop && members.size() <= 4) {
                    for (uint32_t i : members) dropFace[cs[i].face] = 1;
                    splits++;
                    continue;
                }
                uint32_t nv = static_cast<uint32_t>(pos.size());
                Vec3 c(0, 0, 0);
                size_t n = 0;
                for (uint32_t i : members) for (uint32_t u : faces[cs[i].face]) { c += pos[u]; n++; }
                Vec3 p = pos[v];
                if (n) p = p + (c * (1.0f / float(n)) - p) * 0.02f;
                pos.push_back(p);
                for (uint32_t i : members) faces[cs[i].face][cs[i].k] = nv;
                splits++;
            }
        }
        if (std::find(dropFace.begin(), dropFace.end(), 1) != dropFace.end()) {
            std::vector<std::vector<uint32_t>> kept;
            for (size_t f = 0; f < faces.size(); ++f) if (!dropFace[f]) kept.push_back(std::move(faces[f]));
            faces.swap(kept);
        }
        return splits;
    }

    /** Closes every simple boundary loop with one polygon (reverse winding of the loop). */
    static size_t closeHoles(std::vector<std::vector<uint32_t>>& faces) {
        std::unordered_set<uint64_t> du;
        for (const auto& fv : faces) for (size_t k = 0; k < fv.size(); ++k) du.insert(uint64_t(fv[k]) << 32 | fv[(k + 1) % fv.size()]);
        std::unordered_map<uint32_t, std::vector<uint32_t>> holeNext;  // b -> a for a boundary edge a -> b
        for (uint64_t key : du) {
            uint32_t a = uint32_t(key >> 32), b = uint32_t(key & 0xffffffffu);
            if (!du.count(uint64_t(b) << 32 | a)) holeNext[b].push_back(a);
        }
        std::unordered_set<uint64_t> usedHe;
        size_t added = 0;
        for (auto& [start, outs] : holeNext) {
            for (uint32_t firstStep : outs) {
                if (usedHe.count(uint64_t(start) << 32 | firstStep)) continue;
                std::vector<uint32_t> loop{start};
                uint32_t cur = firstStep;
                usedHe.insert(uint64_t(start) << 32 | firstStep);
                bool closed = false;
                for (size_t guard = 0; guard < 100000; ++guard) {
                    if (cur == start) { closed = true; break; }
                    loop.push_back(cur);
                    auto it = holeNext.find(cur);
                    if (it == holeNext.end()) break;
                    uint32_t nxt = UINT32_MAX;
                    for (uint32_t cand : it->second) if (!usedHe.count(uint64_t(cur) << 32 | cand)) { nxt = cand; break; }
                    if (nxt == UINT32_MAX) break;
                    usedHe.insert(uint64_t(cur) << 32 | nxt);
                    cur = nxt;
                }
                std::unordered_set<uint32_t> uniq(loop.begin(), loop.end());
                if (closed && loop.size() >= 3 && uniq.size() == loop.size()) { faces.push_back(loop); added++; }
            }
        }
        return added;
    }

    /** Doublets: an interior vertex with only two faces (they share two consecutive edges) is taken out of both. */
    static size_t removeDoublets(std::vector<std::vector<uint32_t>>& faces) {
        size_t removed = 0;
        for (int pass = 0; pass < 4; ++pass) {
            std::unordered_map<uint32_t, std::vector<uint32_t>> facesAt;
            for (uint32_t f = 0; f < faces.size(); ++f) for (uint32_t v : faces[f]) facesAt[v].push_back(f);
            std::unordered_set<uint64_t> du;
            for (const auto& fv : faces) for (size_t k = 0; k < fv.size(); ++k) du.insert(uint64_t(fv[k]) << 32 | fv[(k + 1) % fv.size()]);
            std::vector<uint8_t> touched(faces.size(), 0);
            size_t n = 0;
            for (auto& [v, fs] : facesAt) {
                if (fs.size() != 2 || touched[fs[0]] || touched[fs[1]]) continue;
                // interior: both edges at v have both directions
                const auto& f0 = faces[fs[0]];
                size_t k = std::find(f0.begin(), f0.end(), v) - f0.begin();
                uint32_t prev = f0[(k + f0.size() - 1) % f0.size()], next = f0[(k + 1) % f0.size()];
                if (!du.count(uint64_t(v) << 32 | prev) || !du.count(uint64_t(next) << 32 | v)) continue;
                for (uint32_t f : fs) {
                    auto& fv = faces[f];
                    fv.erase(std::remove(fv.begin(), fv.end(), v), fv.end());
                    touched[f] = 1;
                }
                n++;
            }
            if (!n) break;
            removed += n;
            std::vector<std::vector<uint32_t>> kept;
            for (auto& fv : faces) if (fv.size() >= 3) kept.push_back(std::move(fv));
            faces.swap(kept);
        }
        return removed;
    }

    static Result extract(const field::TriMesh& m, const std::vector<field::D3>& q, const std::vector<field::D3>& o,
                          const std::vector<uint8_t>& crease, double h, const QuadRemeshOptions& opt) {
        using namespace field;
        Result res;
        const size_t V = m.p.size(), F = m.f.size();

        // undirected edges; each holds its lattice offset (low -> high vertex, in the low vertex's frame) and the
        // quarter turn that carries the high vertex's frame onto the low one's
        std::unordered_map<uint64_t, uint32_t> edgeId;
        std::vector<std::array<uint32_t, 2>> ev;
        std::vector<std::array<uint32_t, 3>> faceEdge(F);
        for (size_t t = 0; t < F; ++t)
            for (int k = 0; k < 3; ++k) {
                uint32_t a = m.f[t][k], b = m.f[t][(k + 1) % 3];
                uint64_t key = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
                auto it = edgeId.find(key);
                if (it == edgeId.end()) { it = edgeId.emplace(key, uint32_t(ev.size())).first; ev.push_back({std::min(a, b), std::max(a, b)}); }
                faceEdge[t][k] = it->second;
            }
        const size_t E = ev.size();
        std::vector<int> erot(E);       // frame(high) turned by erot ~ frame(low)
        std::vector<I2> ediff(E);       // integer offset, low frame
        std::vector<double> ecx(E), ecy(E);  // continuous offset before rounding (for the flow's costs)
        std::vector<uint8_t> ecrease(E, 0);
        for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) if (crease[t * 3 + k]) ecrease[faceEdge[t][k]] = 1;
        for (size_t e = 0; e < E; ++e) {
            uint32_t a = ev[e][0], b = ev[e][1];
            const D3 &na = m.n[a], &nb = m.n[b];
            erot[e] = compatOrientationIndex(q[a], na, q[b], nb);
            D3 qb = rotate90(q[b], nb, erot[e]);  // b's frame expressed so that it matches a's
            auto c = compatPosition(m.p[a], na, q[a], o[a], m.p[b], nb, qb, o[b], h);
            D3 ta = na.cross(q[a]), tb = nb.cross(qb);
            // o_b - o_a = (c.first - o_a) - (c.second - o_b), each part measured in its own frame
            double ax = q[a].dot(c.first - o[a]) / h, ay = ta.dot(c.first - o[a]) / h;
            double bx = qb.dot(c.second - o[b]) / h, by = tb.dot(c.second - o[b]) / h;
            I2 d{static_cast<int>(std::lround(ax)) - static_cast<int>(std::lround(bx)), static_cast<int>(std::lround(ay)) - static_cast<int>(std::lround(by))};
            ediff[e] = d;
            // The edge itself measured in lattice units: a unit of flow should cross edges that run along the
            // component it shifts (a new column crosses edges along x), so this is what the flow's costs follow.
            D3 delta = m.p[b] - m.p[a];
            ecx[e] = q[a].dot(delta) / h;
            ecy[e] = ta.dot(delta) / h;
        }

        // Each triangle's offsets, all in the frame of its corner 0: rho is the quarter turn applied to the edge
        // variable (two quarter turns = a sign flip for an edge walked high -> low).
        auto rotToV0 = [&](size_t t, uint32_t v) -> int {
            uint32_t v0 = m.f[t][0];
            if (v == v0) return 0;
            uint32_t a = std::min(v0, v), b = std::max(v0, v);
            uint64_t key = uint64_t(a) << 32 | b;
            auto it = edgeId.find(key);
            int r = 0;
            if (it != edgeId.end()) r = erot[it->second];
            else r = compatOrientationIndex(q[a], m.n[a], q[b], m.n[b]);
            // r carries b's frame onto a's; coordinates in b's frame enter a's frame turned by -r
            if (v0 == a) return (4 - r) % 4;  // v is b: its coordinates turn by -r into v0 = a
            return r;                          // v0 is b, v is a: a's coordinates turn by +r into b's
        };
        std::vector<std::array<int, 3>> rho(F);
        for (size_t t = 0; t < F; ++t)
            for (int k = 0; k < 3; ++k) {
                uint32_t u = m.f[t][k], w = m.f[t][(k + 1) % 3];
                uint32_t e = faceEdge[t][k];
                // offset u -> w in u's frame: +diff when u is the low end, else -(diff turned from the low end's frame)
                int r;
                if (u == ev[e][0]) r = 0;
                else r = 2 + erot[e];  // the low end is w: its coordinates enter u's (high) frame turned by +erot
                r = (r + rotToV0(t, u)) % 4;
                rho[t][k] = r;
            }

        // orientation singularities: the frame turns a quarter around the triangle
        std::vector<uint8_t> singular(F, 0);
        for (size_t t = 0; t < F; ++t) {
            int sum = 0;
            for (int k = 0; k < 3; ++k) {
                uint32_t u = m.f[t][k], w = m.f[t][(k + 1) % 3];
                int r = compatOrientationIndex(q[u], m.n[u], q[w], m.n[w]);
                sum += r;
            }
            if (sum % 4 != 0) { singular[t] = 1; res.orientationSingularities++; }
        }

        // Orientation gauge: turn each triangle's pair of equations so that across spanning-tree edges every edge
        // variable enters its two triangles with opposite sign. Non-singular triangles first, creases last.
        std::vector<int> gauge(F, -1);
        {
            std::vector<std::vector<std::pair<uint32_t, int>>> faceOfEdge(E);
            for (size_t t = 0; t < F; ++t) for (int k = 0; k < 3; ++k) faceOfEdge[faceEdge[t][k]].push_back({uint32_t(t), k});
            for (int phase = 0; phase < 3; ++phase) {
                for (size_t seed = 0; seed < F; ++seed) {
                    if (gauge[seed] >= 0) continue;
                    if (phase == 0 && singular[seed]) continue;
                    gauge[seed] = 0;
                    std::deque<uint32_t> dq{uint32_t(seed)};
                    while (!dq.empty()) {
                        uint32_t t = dq.front();
                        dq.pop_front();
                        for (int k = 0; k < 3; ++k) {
                            uint32_t e = faceEdge[t][k];
                            if (phase < 2 && ecrease[e]) continue;
                            for (auto [g, kg] : faceOfEdge[e]) {
                                if (g == t || gauge[g] >= 0) continue;
                                if (phase == 0 && singular[g]) continue;
                                gauge[g] = ((gauge[t] + rho[t][k] + 2 - rho[g][kg]) % 4 + 4) % 4;
                                dq.push_back(g);
                            }
                        }
                    }
                }
            }
        }

        // variables: 2 per edge. occurrence (node = 2 t + row, sign) after the gauge.
        struct Occ { int32_t node{-1}; int8_t sign{0}; };
        std::vector<std::array<Occ, 2>> occ(E * 2);
        auto addOcc = [&](uint32_t var, int32_t node, int8_t sign) {
            auto& o2 = occ[var];
            if (o2[0].node < 0) o2[0] = {node, sign};
            else if (o2[1].node < 0) o2[1] = {node, sign};
        };
        for (size_t t = 0; t < F; ++t)
            for (int k = 0; k < 3; ++k) {
                int R = (rho[t][k] + gauge[t]) % 4;
                // Rot^R applied to (x, y): row 0 / row 1 as signed components
                I2 cx = rot({1, 0}, R), cy = rot({0, 1}, R);
                uint32_t e = faceEdge[t][k];
                // x component lands in row (cx.x != 0 ? 0 : 1) with sign of that entry
                if (cx.x != 0) addOcc(e * 2, int32_t(t * 2), int8_t(cx.x)); else addOcc(e * 2, int32_t(t * 2 + 1), int8_t(cx.y));
                if (cy.x != 0) addOcc(e * 2 + 1, int32_t(t * 2), int8_t(cy.x)); else addOcc(e * 2 + 1, int32_t(t * 2 + 1), int8_t(cy.y));
            }
        auto varValue = [&](uint32_t var) -> int& { return var % 2 == 0 ? ediff[var / 2].x : ediff[var / 2].y; };
        auto residuals = [&]() {
            std::vector<int64_t> r(F * 2, 0);
            for (uint32_t var = 0; var < E * 2; ++var)
                for (const auto& oc : occ[var]) if (oc.node >= 0) r[oc.node] += oc.sign * varValue(var);
            return r;
        };

        if (opt.integerFlow) {
            // components of the arc graph, so each one's supply can be balanced before the flow
            std::vector<uint32_t> comp(F * 2);
            std::iota(comp.begin(), comp.end(), 0u);
            std::function<uint32_t(uint32_t)> find = [&](uint32_t x) { while (comp[x] != x) { comp[x] = comp[comp[x]]; x = comp[x]; } return x; };
            auto isArc = [&](uint32_t var) {
                const auto& o2 = occ[var];
                return o2[0].node >= 0 && o2[1].node >= 0 && o2[0].sign == -o2[1].sign && !ecrease[var / 2];
            };
            for (uint32_t var = 0; var < E * 2; ++var) if (isArc(var)) comp[find(uint32_t(occ[var][0].node))] = find(uint32_t(occ[var][1].node));
            std::vector<int64_t> r = residuals();
            std::unordered_map<uint32_t, int64_t> total;
            for (size_t nd = 0; nd < r.size(); ++nd) total[find(uint32_t(nd))] += r[nd];
            // balance: change fixed variables (same-sign pairs move a component's total by 2, single ones by 1)
            std::mt19937 rng(opt.seed + 2);
            std::vector<uint32_t> fixedVars;
            for (uint32_t var = 0; var < E * 2; ++var) if (!isArc(var)) fixedVars.push_back(var);
            std::shuffle(fixedVars.begin(), fixedVars.end(), rng);
            for (int stepSize : {2, 1}) {
                for (uint32_t var : fixedVars) {
                    const auto& o2 = occ[var];
                    if (o2[0].node < 0) continue;
                    uint32_t c0 = find(uint32_t(o2[0].node));
                    int effect = o2[0].sign;
                    bool pair = o2[1].node >= 0;
                    if (pair) {
                        if (find(uint32_t(o2[1].node)) != c0) continue;  // two components: left alone
                        effect += o2[1].sign;
                    }
                    if (std::abs(effect) != stepSize) continue;
                    int64_t& B = total[c0];
                    if (B == 0) continue;
                    if (std::abs(B) < std::abs(effect)) continue;
                    int delta = (B > 0) == (effect > 0) ? -1 : 1;
                    int& val = varValue(var);
                    if (std::abs(val + delta) > 2) continue;
                    val += delta;
                    B += delta * effect;
                }
            }
            // the flow network: node per equation row, source / sink for the residuals
            r = residuals();
            const uint32_t S = uint32_t(F * 2), Tn = uint32_t(F * 2 + 1);
            MinCostFlow mcf(F * 2 + 2);
            int64_t supply = 0;
            for (size_t nd = 0; nd < r.size(); ++nd) {
                if (r[nd] > 0) { mcf.addArc(S, uint32_t(nd), int32_t(r[nd]), 0, -1); supply += r[nd]; }
                else if (r[nd] < 0) mcf.addArc(uint32_t(nd), Tn, int32_t(-r[nd]), 0, -1);
            }
            res.flowSupply = static_cast<size_t>(supply);
            // var with +1 in node u and -1 in node v: one unit u -> v lowers it by 1, v -> u raises it by 1;
            // costs are the convex steps of (x - x_continuous)^2 from the rounded value, so all start >= 0
            for (uint32_t var = 0; var < E * 2; ++var) {
                if (!isArc(var)) continue;
                uint32_t u = uint32_t(occ[var][0].sign > 0 ? occ[var][0].node : occ[var][1].node);
                uint32_t v = uint32_t(occ[var][0].sign > 0 ? occ[var][1].node : occ[var][0].node);
                double xc = var % 2 == 0 ? ecx[var / 2] : ecy[var / 2];
                int x0 = varValue(var);
                auto c = [&](int x) { return (x - xc) * (x - xc); };
                // A step toward the edge's own measure is near free and one across it costs up to twice a unit, so
                // a unit of flow runs where the shift it makes matches the edges it crosses (a new column crosses
                // edges along x). Steps are floored at a small positive cost to keep the search's arcs non-negative.
                // A base cost per step was tried: it shortens routes but raises valence defects about sixfold.
                for (int step = 1; step <= 2; ++step) {
                    int64_t down = static_cast<int64_t>(std::llround(1000.0 * (c(x0 - step) - c(x0 - step + 1)))) + 2000 * (step - 1);
                    int64_t up = static_cast<int64_t>(std::llround(1000.0 * (c(x0 + step) - c(x0 + step - 1)))) + 2000 * (step - 1);
                    mcf.addArc(u, v, 1, std::max<int64_t>(50, down), int64_t(var) * 2);      // lower
                    mcf.addArc(v, u, 1, std::max<int64_t>(50, up), int64_t(var) * 2 + 1);    // raise
                }
            }
            int64_t sent = supply > 0 ? mcf.run(S, Tn, supply) : 0;
            res.flowUnmet = static_cast<size_t>(supply - sent);
            mcf.forEachTagged([&](int64_t tag, int32_t flow) {
                if (flow <= 0) return;
                uint32_t var = uint32_t(tag / 2);
                varValue(var) += (tag % 2 == 0 ? -flow : flow);
            });
        }

        // ---- extraction ----
        // 1. collapse zero-offset edges
        std::vector<uint32_t> parent(V);
        std::iota(parent.begin(), parent.end(), 0u);
        std::function<uint32_t(uint32_t)> find = [&](uint32_t x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for (size_t e = 0; e < E; ++e) if (ediff[e].x == 0 && ediff[e].y == 0) parent[find(ev[e][0])] = find(ev[e][1]);
        std::unordered_map<uint32_t, uint32_t> clusterId;
        std::vector<uint32_t> vcl(V);
        for (uint32_t v = 0; v < V; ++v) {
            auto it = clusterId.find(find(v));
            if (it == clusterId.end()) it = clusterId.emplace(find(v), uint32_t(clusterId.size())).first;
            vcl[v] = it->second;
        }
        const size_t C = clusterId.size();
        std::vector<D3> cpos(C, D3(0, 0, 0));
        std::vector<double> ccount(C, 0);
        for (uint32_t v = 0; v < V; ++v) { cpos[vcl[v]] += o[v]; ccount[vcl[v]] += 1; }
        for (size_t c = 0; c < C; ++c) cpos[c] = cpos[c] * (1.0 / ccount[c]);

        // 2. each triangle's lattice corners in its corner-0 frame
        auto edgeVec = [&](size_t t, int k) {
            uint32_t e = faceEdge[t][k];
            return rot(ediff[e], rho[t][k]);
        };
        struct LTri { std::array<uint32_t, 3> c; std::array<I2, 3> d; };
        std::vector<LTri> kept;
        for (size_t t = 0; t < F; ++t) {
            std::array<uint32_t, 3> c{vcl[m.f[t][0]], vcl[m.f[t][1]], vcl[m.f[t][2]]};
            if (c[0] == c[1] || c[1] == c[2] || c[0] == c[2]) continue;
            I2 d0 = edgeVec(t, 0), d1 = edgeVec(t, 1), d2 = edgeVec(t, 2);
            long long area2 = (long long)d0.x * d1.y - (long long)d0.y * d1.x;
            if (area2 <= 0 || !(d0 + d1 + d2 == I2{0, 0})) { res.flipped++; continue; }
            kept.push_back({c, {d0, d1, d2}});
        }
        // 3. join triangles across non-unit lattice edges (diagonals) that two triangles share by cluster
        auto ukey = [](uint32_t a, uint32_t b) { return a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a); };
        std::unordered_map<uint64_t, std::vector<uint32_t>> diagUse;
        for (uint32_t i = 0; i < kept.size(); ++i)
            for (int k = 0; k < 3; ++k) {
                I2 d = kept[i].d[k];
                if (std::abs(d.x) + std::abs(d.y) == 1) continue;
                diagUse[ukey(kept[i].c[k], kept[i].c[(k + 1) % 3])].push_back(i);
            }
        std::vector<uint32_t> grp(kept.size());
        std::iota(grp.begin(), grp.end(), 0u);
        std::function<uint32_t(uint32_t)> gfind = [&](uint32_t x) { while (grp[x] != x) { grp[x] = grp[grp[x]]; x = grp[x]; } return x; };
        for (auto& [key, list] : diagUse) if (list.size() == 2) grp[gfind(list[0])] = gfind(list[1]);
        std::unordered_map<uint32_t, std::vector<uint32_t>> groups;
        for (uint32_t i = 0; i < kept.size(); ++i) groups[gfind(i)].push_back(i);

        // 4. each group's outline (its directed edges not cancelled inside the group) as one polygon
        PolyMesh& poly = res.poly;
        poly.positions.resize(C);
        for (size_t c = 0; c < C; ++c) poly.positions[c] = cpos[c].f();
        std::vector<std::vector<uint32_t>> faces;
        for (auto& [root, members] : groups) {
            std::unordered_map<uint64_t, int> dirCount;
            for (uint32_t i : members)
                for (int k = 0; k < 3; ++k) {
                    uint32_t a = kept[i].c[k], b = kept[i].c[(k + 1) % 3];
                    dirCount[uint64_t(a) << 32 | b]++;
                }
            std::unordered_map<uint32_t, uint32_t> nextOf;
            bool bad = false;
            for (auto& [key, cnt] : dirCount) {
                uint32_t a = uint32_t(key >> 32), b = uint32_t(key & 0xffffffffu);
                int rev = dirCount.count(uint64_t(b) << 32 | a) ? dirCount[uint64_t(b) << 32 | a] : 0;
                if (cnt - rev <= 0) continue;
                if (cnt - rev > 1 || nextOf.count(a)) { bad = true; break; }
                nextOf[a] = b;
            }
            std::vector<uint32_t> loop;
            if (!bad && !nextOf.empty()) {
                uint32_t start = nextOf.begin()->first, cur = start;
                do {
                    loop.push_back(cur);
                    auto it = nextOf.find(cur);
                    if (it == nextOf.end()) { bad = true; break; }
                    cur = it->second;
                } while (cur != start && loop.size() <= nextOf.size());
                if (loop.size() != nextOf.size()) bad = true;
            }
            if (bad || loop.size() < 3) {
                for (uint32_t i : members) faces.push_back({kept[i].c[0], kept[i].c[1], kept[i].c[2]});
            } else {
                faces.push_back(loop);
            }
        }
        // 5. drop faces that would make an edge non-manifold (later duplicates), then close holes with polygons
        {
            std::unordered_map<uint64_t, int> dirUse;
            std::vector<std::vector<uint32_t>> ok;
            // larger faces first keep their place; small leftovers give way
            std::vector<size_t> order(faces.size());
            std::iota(order.begin(), order.end(), size_t(0));
            std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
                bool qa = faces[a].size() == 4, qb = faces[b].size() == 4;
                return qa > qb;
            });
            for (size_t fi : order) {
                const auto& fv = faces[fi];
                bool clash = false;
                std::unordered_set<uint32_t> seenV;
                for (uint32_t v : fv) if (!seenV.insert(v).second) clash = true;
                for (size_t k = 0; k < fv.size() && !clash; ++k) if (dirUse.count(uint64_t(fv[k]) << 32 | fv[(k + 1) % fv.size()])) clash = true;
                if (clash) { res.flipped++; continue; }
                for (size_t k = 0; k < fv.size(); ++k) dirUse[uint64_t(fv[k]) << 32 | fv[(k + 1) % fv.size()]] = 1;
                ok.push_back(fv);
            }
            faces.swap(ok);
            // bowtie vertices split per fan, then holes closed (a closed source only: an open mesh keeps its own
            // boundary), until neither changes
            bool sourceClosed = std::none_of(m.opp.begin(), m.opp.end(), [](int64_t x) { return x < 0; });
            for (int round = 0; round < 6; ++round) {
                size_t split = splitNonManifoldVertices(faces, poly.positions, sourceClosed);
                size_t added = sourceClosed ? closeHoles(faces) : 0;
                split += removeDoublets(faces);
                res.holesClosed += added;
                if (!split && !added) break;
            }
            removeDoublets(faces);
            splitNonManifoldVertices(faces, poly.positions, false);
        }
        for (const auto& fv : faces) poly.addFace(fv);
        // drop clusters no face uses
        std::vector<int64_t> remap(poly.positions.size(), -1);
        PolyMesh compact;
        for (uint32_t v : poly.faceVerts) if (remap[v] < 0) { remap[v] = int64_t(compact.positions.size()); compact.positions.push_back(poly.positions[v]); }
        for (size_t f2 = 0; f2 < poly.faceCount(); ++f2) {
            std::vector<uint32_t> fv;
            for (uint32_t k = poly.faceStart[f2]; k < poly.faceStart[f2 + 1]; ++k) fv.push_back(uint32_t(remap[poly.faceVerts[k]]));
            compact.addFace(fv);
        }
        res.poly = std::move(compact);
        return res;
    }
};

// ============================================================================
// 6. Tangential relaxation, reprojection and quality metrics
// ============================================================================

class SurfaceProjector {
public:
    /** Relaxes polygon vertices tangentially toward their neighbours' centroid, each pass reprojected onto the source. */
    static void projectAndSmooth(PolyMesh& poly, const BvhTree& bvh, int passes, RemeshTelemetry& tel) {
        const size_t V = poly.positions.size();
        if (V == 0) return;
        std::vector<std::vector<uint32_t>> nb(V);
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            uint32_t s = poly.faceStart[f], d = poly.degree(f);
            for (uint32_t k = 0; k < d; ++k) {
                uint32_t a = poly.faceVerts[s + k], b = poly.faceVerts[s + (k + 1) % d];
                nb[a].push_back(b); nb[b].push_back(a);
            }
        }
        for (auto& l : nb) { std::sort(l.begin(), l.end()); l.erase(std::unique(l.begin(), l.end()), l.end()); }
        auto normals = [&]() {
            std::vector<Vec3> n(V, Vec3(0, 0, 0));
            for (size_t f = 0; f < poly.faceCount(); ++f) {
                uint32_t s = poly.faceStart[f], d = poly.degree(f);
                for (uint32_t k = 0; k < d; ++k) {
                    const Vec3& a = poly.positions[poly.faceVerts[s + k]];
                    const Vec3& b = poly.positions[poly.faceVerts[s + (k + 1) % d]];
                    const Vec3& c = poly.positions[poly.faceVerts[s + (k + d - 1) % d]];
                    n[poly.faceVerts[s + k]] += (b - a).cross(c - a);
                }
            }
            for (auto& x : n) x = x.normalized();
            return n;
        };
        auto snap = [&]() {
            double total = 0;
            for (auto& p : poly.positions) { float d2 = 0; Vec3 c = bvh.closestPoint(p, d2); if (std::isfinite(d2)) { total += std::sqrt(d2); p = c; } }
            return total / double(V);
        };
        tel.meanSurfaceErrorMeters = static_cast<float>(snap());
        for (int pass = 0; pass < passes; ++pass) {
            auto n = normals();
            std::vector<Vec3> next = poly.positions;
            for (size_t i = 0; i < V; ++i) {
                if (nb[i].empty()) continue;
                Vec3 c(0, 0, 0);
                for (uint32_t j : nb[i]) c += poly.positions[j];
                c = c * (1.0f / float(nb[i].size()));
                Vec3 d = c - poly.positions[i];
                d = d - n[i] * n[i].dot(d);
                next[i] = poly.positions[i] + d * 0.5f;
            }
            poly.positions.swap(next);
            snap();
        }
    }

    /** Valence singularities, corner angles, scaled Jacobians and aspect of the quads. */
    static void measure(const PolyMesh& poly, RemeshTelemetry& tel) {
        const size_t V = poly.positions.size();
        std::vector<uint32_t> valence(V, 0);
        std::unordered_map<uint64_t, int> edgeUse;
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            uint32_t s = poly.faceStart[f], d = poly.degree(f);
            for (uint32_t k = 0; k < d; ++k) {
                uint32_t a = poly.faceVerts[s + k], b = poly.faceVerts[s + (k + 1) % d];
                uint64_t key = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
                if (edgeUse[key]++ == 0) { valence[a]++; valence[b]++; }
            }
        }
        std::vector<uint8_t> onBoundary(V, 0);
        for (auto& [key, cnt] : edgeUse) if (cnt == 1) { onBoundary[key >> 32] = 1; onBoundary[key & 0xffffffffu] = 1; }
        tel.singularityCount = 0;
        for (size_t v = 0; v < V; ++v) if (!onBoundary[v] && valence[v] > 0 && valence[v] != 4) tel.singularityCount++;
        size_t quads = 0;
        double sumAngle = 0, sumDev = 0, maxDev = 0, sumJ = 0, minJ = 1, sumAsp = 0;
        size_t nAngles = 0;
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            if (poly.degree(f) != 4) continue;
            quads++;
            uint32_t s = poly.faceStart[f];
            Vec3 p[4];
            for (int k = 0; k < 4; ++k) p[k] = poly.positions[poly.faceVerts[s + k]];
            Vec3 fn(0, 0, 0);
            for (int k = 0; k < 4; ++k) fn += (p[(k + 1) % 4] - p[k]).cross(p[(k + 3) % 4] - p[k]);
            fn = fn.normalized();
            double minLocalJ = 1;
            for (int k = 0; k < 4; ++k) {
                Vec3 a = p[(k + 1) % 4] - p[k], b = p[(k + 3) % 4] - p[k];
                double la = a.length(), lb = b.length();
                if (la < 1e-12 || lb < 1e-12) { minLocalJ = -1; continue; }
                double c = std::clamp<double>(a.dot(b) / (la * lb), -1.0, 1.0);
                double ang = std::acos(c) * 180.0 / PI;
                double j = a.cross(b).dot(fn) / (la * lb);
                minLocalJ = std::min(minLocalJ, j);
                sumAngle += ang; sumDev += std::abs(ang - 90.0); maxDev = std::max(maxDev, std::abs(ang - 90.0)); nAngles++;
            }
            sumJ += minLocalJ;
            minJ = std::min(minJ, minLocalJ);
            double w = ((p[1] - p[0]).length() + (p[2] - p[3]).length()) * 0.5;
            double hgt = ((p[3] - p[0]).length() + (p[2] - p[1]).length()) * 0.5;
            double asp = (w > 1e-12 && hgt > 1e-12) ? std::max(w / hgt, hgt / w) : 10.0;
            sumAsp += std::min(asp, 10.0);
        }
        tel.outputQuadCount = quads;
        tel.outputPolygonCount = poly.faceCount();
        tel.pureQuadRatio = poly.faceCount() ? float(double(quads) / double(poly.faceCount())) : 0.0f;
        if (nAngles) {
            tel.meanOrthogonalityDeg = float(sumAngle / nAngles);
            tel.meanAngleDeviationDeg = float(sumDev / nAngles);
            tel.maxOrthogonalityDeviationDeg = float(maxDev);
        }
        if (quads) {
            tel.meanScaledJacobian = float(sumJ / quads);
            tel.minScaledJacobian = float(minJ);
            tel.meanQuadAspect = float(sumAsp / quads);
        }
    }
};

// ============================================================================
// 7. FieldAlignedQuadRemesher facade
// ============================================================================

class FieldAlignedQuadRemesher {
public:
    /** The quad-dominant polygon mesh, vertices on the source surface. */
    static PolyMesh remeshToPolygons(const ScratchboxMesh& input, const QuadRemeshOptions& opt = {}, RemeshTelemetry* outTelemetry = nullptr) {
        using namespace field;
        auto t0 = std::chrono::steady_clock::now();
        RemeshTelemetry tel;
        tel.inputTriangleCount = input.indices.size() / 3;
        TriMesh m = fromMesh(input, opt.weldInput);
        const double area = m.area();
        double h = opt.targetEdgeLength > 0 ? opt.targetEdgeLength : PositionFieldOptimizer::spacingFor(area, opt.targetQuadCount);
        if (!(h > 0) || m.f.empty()) { if (outTelemetry) *outTelemetry = tel; return {}; }
        tel.targetEdgeLength = h;
        splitLongEdges(m, 0.5 * h, std::max<size_t>(m.f.size() * 4, size_t(4) << 20));
        m.computeNormals();
        m.buildOpposites();
        tel.workingTriangleCount = m.f.size();

        std::vector<uint8_t> crease;
        tel.sharpCreaseEdges = CreaseDetector::detect(m, opt.creaseAngleDeg, opt.preserveBoundaryEdges, crease);

        // finest level: vertices, one-ring adjacency, Voronoi-ish area, pins from crease / open edges
        std::vector<Level> levels(1);
        Level& L0 = levels[0];
        const size_t V = m.p.size();
        L0.p = m.p;
        L0.n = m.n;
        L0.area.assign(V, 0.0);
        L0.adj.resize(V);
        L0.pinned.assign(V, 0);
        L0.pinDir.assign(V, D3());
        for (size_t t = 0; t < m.f.size(); ++t) {
            double a = 0.5 * (m.p[m.f[t][1]] - m.p[m.f[t][0]]).cross(m.p[m.f[t][2]] - m.p[m.f[t][0]]).norm();
            for (int k = 0; k < 3; ++k) {
                uint32_t u = m.f[t][k], w = m.f[t][(k + 1) % 3];
                L0.area[u] += a / 3.0;
                L0.adj[u].push_back(w);
                L0.adj[w].push_back(u);
                if (crease[t * 3 + k]) {
                    D3 dir = m.p[w] - m.p[u];
                    for (uint32_t x : {u, w}) {
                        D3 d = projectTangent(dir, m.n[x]).normalized();
                        if (d.norm() == 0) continue;
                        if (!L0.pinned[x]) { L0.pinned[x] = 1; L0.pinDir[x] = d; }
                    }
                }
            }
        }
        for (auto& l : L0.adj) { std::sort(l.begin(), l.end()); l.erase(std::unique(l.begin(), l.end()), l.end()); }
        while (levels.back().p.size() > 64 && levels.size() < 24) {
            Level c = coarsen(levels.back());
            if (c.p.size() > levels.back().p.size() * 0.9) { levels.back().toParent.clear(); break; }
            levels.push_back(std::move(c));
        }

        auto lap = [&]() { auto n = std::chrono::steady_clock::now(); double d = std::chrono::duration<double, std::milli>(n - t0).count(); return d; };
        double mark = lap();
        tel.msPrepare = mark;
        std::vector<std::vector<D3>> q, o;
        FourRoSyFieldSolver::solve(levels, q, opt);
        tel.msOrientation = lap() - mark; mark = lap();
        PositionFieldOptimizer::solve(levels, q, o, h, opt);
        tel.msPosition = lap() - mark; mark = lap();

        auto ex = QuadExtractor::extract(m, q[0], o[0], crease, h, opt);
        tel.msExtract = lap() - mark; mark = lap();
        tel.orientationSingularities = ex.orientationSingularities;
        tel.flowSupply = ex.flowSupply;
        tel.flowUnmet = ex.flowUnmet;
        tel.flippedTriangles = ex.flipped;
        tel.holesClosed = ex.holesClosed;

        BvhTree bvh;
        bvh.build(input);
        SurfaceProjector::projectAndSmooth(ex.poly, bvh, opt.tangentRelaxationPasses, tel);
        SurfaceProjector::measure(ex.poly, tel);
        tel.msRelax = lap() - mark;
        tel.elapsedMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        if (outTelemetry) *outTelemetry = tel;
        return std::move(ex.poly);
    }

    /** Triangulates a polygon mesh: quads on their shorter diagonal, other polygons as a fan from their centroid. */
    static ScratchboxMesh triangulate(const PolyMesh& poly, const std::string& name = "quad_remeshed") {
        ScratchboxMesh out(name);
        out.vertices.reserve(poly.positions.size());
        for (const auto& p : poly.positions) { Vertex v; v.position = p; out.vertices.push_back(v); }
        // a diagonal that is already an edge of the mesh would be shared by four triangles: avoid it
        std::unordered_set<uint64_t> edges;
        auto ukey = [](uint32_t a, uint32_t b) { return a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a); };
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            uint32_t s = poly.faceStart[f], d = poly.degree(f);
            for (uint32_t k = 0; k < d; ++k) edges.insert(ukey(poly.faceVerts[s + k], poly.faceVerts[s + (k + 1) % d]));
        }
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            uint32_t s = poly.faceStart[f], d = poly.degree(f);
            const uint32_t* fv = &poly.faceVerts[s];
            bool fan = d > 4;
            if (d == 3) out.addTriangle(fv[0], fv[1], fv[2]);
            else if (d == 4) {
                const Vec3 &a = poly.positions[fv[0]], &b = poly.positions[fv[1]], &c = poly.positions[fv[2]], &e = poly.positions[fv[3]];
                bool acFree = !edges.count(ukey(fv[0], fv[2])), bdFree = !edges.count(ukey(fv[1], fv[3]));
                bool useAC = acFree && (!bdFree || (c - a).lengthSquared() <= (e - b).lengthSquared());
                if (useAC) { out.addTriangle(fv[0], fv[1], fv[2]); out.addTriangle(fv[0], fv[2], fv[3]); edges.insert(ukey(fv[0], fv[2])); }
                else if (bdFree) { out.addTriangle(fv[0], fv[1], fv[3]); out.addTriangle(fv[1], fv[2], fv[3]); edges.insert(ukey(fv[1], fv[3])); }
                else fan = true;
            }
            if (fan) {
                Vec3 c(0, 0, 0);
                for (uint32_t k = 0; k < d; ++k) c += poly.positions[fv[k]];
                Vertex cv; cv.position = c * (1.0f / float(d));
                uint32_t ci = static_cast<uint32_t>(out.vertices.size());
                out.vertices.push_back(cv);
                for (uint32_t k = 0; k < d; ++k) out.addTriangle(fv[k], fv[(k + 1) % d], ci);
            }
        }
        out.recomputeNormals();
        out.recomputeBounds();
        return out;
    }

    /** Field-aligned quad remesh, triangulated for glTF (quads as two triangles on their shorter diagonal). */
    static ScratchboxMesh remesh(const ScratchboxMesh& input, const QuadRemeshOptions& opt = {}, RemeshTelemetry* outTelemetry = nullptr) {
        RemeshTelemetry tel;
        PolyMesh poly = remeshToPolygons(input, opt, &tel);
        ScratchboxMesh out = triangulate(poly, input.name + "_quad_remeshed");
        out.material = input.material;
        tel.outputTriangleCount = out.indices.size() / 3;
        if (outTelemetry) *outTelemetry = tel;
        return out;
    }

    /** Wireframe strips along every polygon edge (no triangulation diagonals), for inspection in the viewer. */
    static ScratchboxMesh buildQuadWireframe(const PolyMesh& poly, float wireThickness = 0.08f, const Vec4& wireColor = Vec4(0.05f, 0.85f, 0.95f, 1.0f)) {
        ScratchboxMesh wire("quad_wireframe");
        geometry::PbrMaterial wireMat;
        wireMat.name = "quad_wireframe";
        wireMat.baseColorFactor = wireColor;
        wireMat.roughnessFactor = 0.9f;
        wireMat.metallicFactor = 0.0f;
        wire.material = wireMat;
        std::unordered_set<uint64_t> done;
        for (size_t f = 0; f < poly.faceCount(); ++f) {
            uint32_t s = poly.faceStart[f], d = poly.degree(f);
            for (uint32_t k = 0; k < d; ++k) {
                uint32_t ia = poly.faceVerts[s + k], ib = poly.faceVerts[s + (k + 1) % d];
                uint64_t key = ia < ib ? (uint64_t(ia) << 32 | ib) : (uint64_t(ib) << 32 | ia);
                if (!done.insert(key).second) continue;
                const Vec3 &a = poly.positions[ia], &b = poly.positions[ib];
                Vec3 dir = (b - a).normalized();
                Vec3 upv(0, 1, 0);
                if (std::abs(dir.y) > 0.9f) upv = Vec3(1, 0, 0);
                Vec3 side = dir.cross(upv).normalized() * (wireThickness * 0.5f);
                uint32_t base = static_cast<uint32_t>(wire.vertices.size());
                wire.addVertex(Vertex(a - side, Vec3(0, 1, 0), Vec2(0, 0), wireColor));
                wire.addVertex(Vertex(a + side, Vec3(0, 1, 0), Vec2(1, 0), wireColor));
                wire.addVertex(Vertex(b + side, Vec3(0, 1, 0), Vec2(1, 1), wireColor));
                wire.addVertex(Vertex(b - side, Vec3(0, 1, 0), Vec2(0, 1), wireColor));
                wire.addTriangle(base, base + 1, base + 2);
                wire.addTriangle(base, base + 2, base + 3);
            }
        }
        wire.recomputeNormals();
        wire.recomputeBounds();
        return wire;
    }
};

} // namespace remesh
} // namespace scratchbox

#endif // SCRATCHBOX_FIELD_REMESH_HPP
