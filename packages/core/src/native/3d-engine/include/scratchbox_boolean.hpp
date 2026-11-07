/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Robust mesh booleans: union, intersection and difference of closed triangle meshes, and the trim of any mesh (open
 * scans included) to the inside or outside of a closed one. The result is always topologically valid: every cut point is
 * shared exactly by the faces that meet there, so two closed inputs give a closed, manifold result and a trim leaves
 * exactly the cut curve open.
 * Method: the logic of Manifold (Apache-2.0): intersections found as edge-face crossings, decided once each by
 * predicates under symbolic perturbation so coplanar, touching and degenerate input is resolved consistently; winding
 * numbers carried along edges from one ray cast per connected piece; faces rebuilt from their cut curves by topology.
 *
 * The decisions are exact (scratchbox_exact_predicates.hpp orient3dPerturbed): B's vertices are displaced symbolically
 * along their own normals, outward for union, difference and trims (touching solids merge, a coplanar cut removes the
 * shared skin) and inward for intersection (touching solids give nothing), then by a generic second-order displacement,
 * so no decision is ever a tie. Positions of the new points are computed in floating point from the exact topology;
 * coincident points are allowed (a zero-area triangle stays topologically sound) and `collapseShort` removes them.
 *
 * Each face is rebuilt from its cut curves without any angle sorting: within one input face a cut curve is a chain of
 * points of degree two, ending on the face's edges, so splitting the face along each chain is purely combinatorial; a
 * closed curve inside one face (the other mesh piercing it wholly) is cut out with the CDT (scratchbox_cdt.hpp).
 * Every rebuilt piece remembers its source face and barycentric weights, for carrying vertex attributes.
 */

#pragma once

#include "scratchbox_cdt.hpp"
#include "scratchbox_exact_predicates.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace scratchbox {
namespace boolean {

using V3 = std::array<double, 3>;
using Tri = std::array<int, 3>;

struct Mesh {
    std::vector<V3> pos;
    std::vector<Tri> tris;
};

enum class Op { Union, Intersection, Difference, TrimInside, TrimOutside };

struct Options {
    /** Vertices at one exact position are one vertex (a scan's UV seams split them): on for scans, off for meshes already indexed. */
    bool weldByPosition = true;
    /** After the boolean, edges shorter than this that touch a cut point are collapsed where that keeps the mesh valid (0: off). */
    double collapseShort = 0;
    /** Minimum angle (degrees) a collapse may not fold a triangle past (its normal turning more than 90 degrees refuses it). */
    double collapseMaxTurnDeg = 60;
};

/** Where an output vertex comes from. */
struct Origin {
    /** 0: a vertex of A, 1: a vertex of B, 2: an edge of A crossing a face of B, 3: an edge of B crossing a face of A. */
    int kind = 0;
    int a = -1, b = -1;  // kind 0/1: the input vertex; 2: A's edge (lo, hi vertex ids) ... see `edgeLo/edgeHi`; 3: likewise for B
    int face = -1;       // kinds 2/3: the other mesh's face
    double t = 0;        // kinds 2/3: the parameter along the edge from its lower to its higher vertex id
};

struct Report {
    size_t trisA = 0, trisB = 0, crossingsA = 0, crossingsB = 0, segments = 0;
    size_t facesCutA = 0, facesCutB = 0, keptA = 0, keptB = 0, droppedA = 0, droppedB = 0;
    /** Faces that needed the fallback triangulation (their cut points nearly coincide). */
    size_t fallbackFaces = 0;
    /** Topology checks: pairs of faces whose crossings did not pair up, winding contradictions, perturbation ties. */
    size_t unpairedSegments = 0, chainFailures = 0, windingConflicts = 0, ties = 0;
    /** B is not closed (its winding means nothing): open or non-manifold edges. */
    size_t openEdgesB = 0;
    /** After: edges of one triangle (the cut curve of a trim, holes the input had), edges of more than two, collapsed edges. */
    size_t openEdgesOut = 0, nonManifoldOut = 0, collapsed = 0;
    size_t componentsA = 0;
};

struct Result {
    Mesh mesh;
    std::vector<Origin> origin;  // per output vertex
    /** Per output triangle: which input (0 A, 1 B), its source triangle in that input, and its corners' barycentric weights there. */
    std::vector<int> side, source;
    std::vector<std::array<V3, 3>> bary;
    Report report;
};

namespace detail {

constexpr int kNone = -1;

inline V3 sub(const V3& a, const V3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline V3 add(const V3& a, const V3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
inline V3 mul(const V3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
inline V3 cross(const V3& a, const V3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double dot(const V3& a, const V3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline double norm(const V3& a) { return std::sqrt(dot(a, a)); }

inline uint64_t bitsOf(double x) { if (x == 0) x = 0; uint64_t u; std::memcpy(&u, &x, 8); return u; }
struct PosKey {
    uint64_t x, y, z;
    bool operator==(const PosKey& o) const { return x == o.x && y == o.y && z == o.z; }
};
struct PosHash { size_t operator()(const PosKey& k) const { return k.x * 0x9E3779B97F4A7C15ull ^ (k.y + 0x632BE59BD9B4E019ull + (k.x << 6)) ^ (k.z * 0xC2B2AE3D27D4EB4Full); } };
inline uint64_t ekey(int a, int b) { return a < b ? (uint64_t(uint32_t(a)) << 32) | uint32_t(b) : (uint64_t(uint32_t(b)) << 32) | uint32_t(a); }
inline uint64_t pkey(int a, int b) { return (uint64_t(uint32_t(a)) << 32) | uint32_t(b); }

/** A mesh welded by exact position: its vertices, triangles (degenerate ones dropped) and their source triangles. */
struct Welded {
    std::vector<V3> pos;
    std::vector<Tri> tris;
    std::vector<int> src;      // per welded triangle, the input triangle
    std::vector<int> vertOf;   // per input vertex, its welded vertex
    // edges
    std::vector<std::array<int, 2>> edges;               // lo, hi
    std::unordered_map<uint64_t, int> edgeId;
    std::vector<std::vector<int>> edgeFaces;            // per edge, its faces
    std::vector<std::array<int, 3>> faceEdges;          // per face, its edges (edge k: corners k -> k+1)
};

inline Welded weld(const Mesh& m, bool byPosition = true) {
    Welded w;
    std::unordered_map<PosKey, int, PosHash> at;
    w.vertOf.resize(m.pos.size());
    for (size_t i = 0; i < m.pos.size(); ++i) {
        if (!byPosition) { w.vertOf[i] = static_cast<int>(w.pos.size()); w.pos.push_back(m.pos[i]); continue; }
        const PosKey k{bitsOf(m.pos[i][0]), bitsOf(m.pos[i][1]), bitsOf(m.pos[i][2])};
        auto it = at.find(k);
        if (it == at.end()) { it = at.emplace(k, static_cast<int>(w.pos.size())).first; w.pos.push_back(m.pos[i]); }
        w.vertOf[i] = it->second;
    }
    for (size_t t = 0; t < m.tris.size(); ++t) {
        const Tri f{w.vertOf[m.tris[t][0]], w.vertOf[m.tris[t][1]], w.vertOf[m.tris[t][2]]};
        if (f[0] == f[1] || f[1] == f[2] || f[0] == f[2]) continue;
        w.tris.push_back(f);
        w.src.push_back(static_cast<int>(t));
    }
    w.faceEdges.resize(w.tris.size());
    for (size_t f = 0; f < w.tris.size(); ++f) {
        for (int k = 0; k < 3; ++k) {
            const int a = w.tris[f][k], b = w.tris[f][(k + 1) % 3];
            const uint64_t key = ekey(a, b);
            auto it = w.edgeId.find(key);
            if (it == w.edgeId.end()) {
                it = w.edgeId.emplace(key, static_cast<int>(w.edges.size())).first;
                w.edges.push_back({std::min(a, b), std::max(a, b)});
                w.edgeFaces.emplace_back();
            }
            w.edgeFaces[it->second].push_back(static_cast<int>(f));
            w.faceEdges[f][k] = it->second;
        }
    }
    return w;
}

/** Axis-aligned boxes over triangles, a median split; queries by box or by segment. */
class Bvh {
public:
    struct Node { V3 lo, hi; int left = -1, right = -1, start = 0, count = 0; };
    std::vector<Node> nodes;
    std::vector<int> items;
    std::vector<V3> blo, bhi;

    void build(const std::vector<V3>& pos, const std::vector<Tri>& tris) {
        const size_t n = tris.size();
        blo.resize(n); bhi.resize(n);
        items.resize(n);
        std::iota(items.begin(), items.end(), 0);
        for (size_t t = 0; t < n; ++t) {
            V3 lo = pos[tris[t][0]], hi = lo;
            for (int k = 1; k < 3; ++k) for (int c = 0; c < 3; ++c) { lo[c] = std::min(lo[c], pos[tris[t][k]][c]); hi[c] = std::max(hi[c], pos[tris[t][k]][c]); }
            blo[t] = lo; bhi[t] = hi;
        }
        nodes.clear();
        if (n) split(0, static_cast<int>(n));
    }
    template <class F>
    void queryBox(const V3& lo, const V3& hi, F&& visit) const {
        if (nodes.empty()) return;
        std::vector<int> st{0};
        while (!st.empty()) {
            const Node& nd = nodes[st.back()];
            st.pop_back();
            if (nd.hi[0] < lo[0] || nd.lo[0] > hi[0] || nd.hi[1] < lo[1] || nd.lo[1] > hi[1] || nd.hi[2] < lo[2] || nd.lo[2] > hi[2]) continue;
            if (nd.left < 0) { for (int i = nd.start; i < nd.start + nd.count; ++i) { const int t = items[i]; if (!(bhi[t][0] < lo[0] || blo[t][0] > hi[0] || bhi[t][1] < lo[1] || blo[t][1] > hi[1] || bhi[t][2] < lo[2] || blo[t][2] > hi[2])) visit(t); } continue; }
            st.push_back(nd.left);
            st.push_back(nd.right);
        }
    }
    template <class F>
    void querySegment(const V3& p, const V3& q, F&& visit) const {
        if (nodes.empty()) return;
        const auto hits = [&](const V3& lo, const V3& hi) {
            double t0 = 0, t1 = 1;
            for (int c = 0; c < 3; ++c) {
                const double d = q[c] - p[c];
                if (d == 0) { if (p[c] < lo[c] || p[c] > hi[c]) return false; continue; }
                double a = (lo[c] - p[c]) / d, b = (hi[c] - p[c]) / d;
                if (a > b) std::swap(a, b);
                // widened a hair: a segment grazing a box edge is still tested exactly by the caller
                t0 = std::max(t0, a - 1e-9);
                t1 = std::min(t1, b + 1e-9);
                if (t0 > t1) return false;
            }
            return true;
        };
        std::vector<int> st{0};
        while (!st.empty()) {
            const Node& nd = nodes[st.back()];
            st.pop_back();
            if (!hits(nd.lo, nd.hi)) continue;
            if (nd.left < 0) { for (int i = nd.start; i < nd.start + nd.count; ++i) if (hits(blo[items[i]], bhi[items[i]])) visit(items[i]); continue; }
            st.push_back(nd.left);
            st.push_back(nd.right);
        }
    }

private:
    int split(int start, int end) {
        Node nd;
        nd.lo = blo[items[start]]; nd.hi = bhi[items[start]];
        for (int i = start; i < end; ++i) for (int c = 0; c < 3; ++c) { nd.lo[c] = std::min(nd.lo[c], blo[items[i]][c]); nd.hi[c] = std::max(nd.hi[c], bhi[items[i]][c]); }
        const int id = static_cast<int>(nodes.size());
        nodes.push_back(nd);
        if (end - start <= 6) { nodes[id].start = start; nodes[id].count = end - start; return id; }
        int axis = 0;
        for (int c = 1; c < 3; ++c) if (nd.hi[c] - nd.lo[c] > nd.hi[axis] - nd.lo[axis]) axis = c;
        const int mid = (start + end) / 2;
        std::nth_element(items.begin() + start, items.begin() + mid, items.begin() + end, [&](int a, int b) { return blo[a][axis] + bhi[a][axis] < blo[b][axis] + bhi[b][axis]; });
        const int l = split(start, mid), r = split(mid, end);
        nodes[id].left = l;
        nodes[id].right = r;
        return id;
    }
};

/** Angle-weighted vertex normals (outward for an outward-facing closed mesh). */
inline std::vector<V3> vertexNormals(const Welded& w) {
    std::vector<V3> n(w.pos.size(), V3{0, 0, 0});
    for (const auto& f : w.tris) {
        for (int k = 0; k < 3; ++k) {
            const V3& p = w.pos[f[k]];
            const V3 u = sub(w.pos[f[(k + 1) % 3]], p), v = sub(w.pos[f[(k + 2) % 3]], p);
            const V3 c = cross(u, v);
            const double cl = norm(c), ul = norm(u), vl = norm(v);
            if (!(cl > 0) || !(ul > 0) || !(vl > 0)) continue;
            const double ang = std::atan2(cl, dot(u, v));
            n[f[k]] = add(n[f[k]], mul(c, ang / cl));
        }
    }
    for (auto& x : n) { const double l = norm(x); if (l > 0) x = mul(x, 1 / l); }
    return n;
}

/** A small generic integer vector per vertex (the second-order perturbation). */
inline V3 genericOf(uint64_t i, uint64_t salt) {
    uint64_t s = (i + 1) * 0x9E3779B97F4A7C15ull ^ salt;
    V3 g;
    for (int c = 0; c < 3; ++c) { s ^= s >> 31; s *= 0xBF58476D1CE4E5B9ull; s ^= s >> 27; g[c] = static_cast<double>(static_cast<int64_t>(s % 2001) - 1000); }
    return g;
}

/** Where a crossing lies along an edge, from the edge ends' signed distances to the plane (lo end first). */
inline double crossingParam(double dlo, double dhi) {
    const double den = dlo - dhi;
    if (!(std::fabs(den) > 0) || !std::isfinite(den)) return 0.5;
    const double t = dlo / den;
    return std::isfinite(t) ? std::clamp(t, 0.0, 1.0) : 0.5;
}

/** One crossing of an edge of mesh X with a face of mesh Y. */
struct Crossing {
    int edge;   // X's edge
    int face;   // Y's face
    int sign;   // +1 when the edge, lo -> hi, enters Y through that face
    double t;   // along lo -> hi
    int vid;    // the output vertex
};

/**
 * Triangles over a cycle of vertices given 2D positions, as many as the cycle needs (n - 2), its edges kept; never fails.
 * `edgeMask` gives each vertex the source face's edges it lies on (bit k: edge k): no triangle may join two vertices on
 * one edge by a chord, since the face beside it holds that edge too and the chord would be its edge doubled.
 */
inline std::vector<Tri> ringTriangulate(const std::vector<int>& ring, const std::vector<std::vector<int>>& holes, const std::vector<cdt::P2>& xy, const std::function<int(int)>& edgeMask, bool& fallback) {
    // the CDT first: best angles, exact
    std::vector<cdt::P2> pts;
    std::vector<std::vector<int>> loops;
    std::vector<int> ids;
    for (const auto* l : [&] { std::vector<const std::vector<int>*> v{&ring}; for (const auto& h : holes) v.push_back(&h); return v; }()) {
        std::vector<int> loop;
        for (int v : *l) { loop.push_back(static_cast<int>(pts.size())); pts.push_back(xy[pts.size()]); ids.push_back(v); }
        loops.push_back(loop);
    }
    size_t expected = ring.size() - 2;
    for (const auto& h : holes) expected += h.size();
    if (auto t = cdt::triangulatePolygon(pts, loops); t && t->size() == expected) {
        std::unordered_set<uint64_t> have;
        for (const auto& f : *t) for (int k = 0; k < 3; ++k) have.insert(pkey(f[k], f[(k + 1) % 3]));
        bool ok = true;
        for (const auto& l : loops) for (size_t i = 0; i < l.size() && ok; ++i) ok = have.count(pkey(l[i], l[(i + 1) % l.size()])) > 0;
        // no chord along an edge of the source face
        std::unordered_set<uint64_t> ringEdges;
        for (const auto& l : loops) for (size_t i = 0; i < l.size(); ++i) ringEdges.insert(ekey(l[i], l[(i + 1) % l.size()]));
        for (const auto& f : *t) for (int k = 0; k < 3 && ok; ++k) {
            const int a = f[k], b = f[(k + 1) % 3];
            if (!ringEdges.count(ekey(a, b)) && (edgeMask(ids[a]) & edgeMask(ids[b]))) ok = false;
        }
        if (ok) {
            std::vector<Tri> out;
            for (const auto& f : *t) out.push_back({ids[f[0]], ids[f[1]], ids[f[2]]});
            return out;
        }
    }
    fallback = true;
    // topological ear clipping: always n - 2 triangles over the cycle (holes bridged in first)
    std::vector<int> poly = loops[0];
    for (size_t h = 1; h < loops.size(); ++h) {
        const auto& hl = loops[h];
        // bridge from the hole's vertex nearest any ring vertex
        size_t bi = 0, bj = 0;
        double bd = std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < poly.size(); ++i) for (size_t j = 0; j < hl.size(); ++j) {
            const double d = std::hypot(pts[poly[i]][0] - pts[hl[j]][0], pts[poly[i]][1] - pts[hl[j]][1]);
            if (d < bd) { bd = d; bi = i; bj = j; }
        }
        std::vector<int> np(poly.begin(), poly.begin() + static_cast<long>(bi) + 1);
        for (size_t k = 0; k <= hl.size(); ++k) np.push_back(hl[(bj + k) % hl.size()]);
        np.insert(np.end(), poly.begin() + static_cast<long>(bi), poly.end());
        poly = np;
    }
    std::vector<Tri> out;
    while (poly.size() > 3) {
        const size_t n = poly.size();
        long best = -1;
        double bestScore = -std::numeric_limits<double>::infinity();
        for (size_t i = 0; i < n; ++i) {
            const int a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
            const double ar = exact::orient2dValue(pts[a], pts[b], pts[c]);
            double score;
            // the chord (a, c) must not lie along an edge of the source face (nor repeat a vertex, as a bridge can)
            const bool chordOnEdge = ids[a] == ids[c] || (edgeMask(ids[a]) & edgeMask(ids[c])) != 0;
            if (exact::orient2d(pts[a], pts[b], pts[c]) > 0) {
                bool empty = true;
                for (size_t j = 0; j < n && empty; ++j) {
                    const int p = poly[j];
                    if (p == a || p == b || p == c) continue;
                    if (exact::orient2d(pts[a], pts[b], pts[p]) > 0 && exact::orient2d(pts[b], pts[c], pts[p]) > 0 && exact::orient2d(pts[c], pts[a], pts[p]) > 0) empty = false;
                }
                score = empty ? 1e6 + cdt::minAngleDeg(pts[a], pts[b], pts[c]) : 1e3 + ar;
            } else {
                score = ar;  // a reflex or flat corner only when nothing else is left
            }
            if (chordOnEdge) score -= 1e12;
            if (score > bestScore) { bestScore = score; best = static_cast<long>(i); }
        }
        const size_t i = static_cast<size_t>(best);
        out.push_back({ids[poly[(i + n - 1) % n]], ids[poly[i]], ids[poly[(i + 1) % n]]});
        poly.erase(poly.begin() + static_cast<long>(i));
    }
    if (poly.size() == 3) out.push_back({ids[poly[0]], ids[poly[1]], ids[poly[2]]});
    return out;
}

}  // namespace detail

/**
 * The boolean `op` of A with B. B must be closed (outward-facing); A must be closed for union, intersection and difference,
 * and may be anything for the trims.
 */
inline Result compute(const Mesh& Ain, const Mesh& Bin, Op op, const Options& opt = {}) {
    using namespace detail;
    Result R;
    Report& rep = R.report;
    const Welded A = weld(Ain, opt.weldByPosition), B = weld(Bin, opt.weldByPosition);
    rep.trisA = A.tris.size();
    rep.trisB = B.tris.size();
    for (size_t e = 0; e < B.edges.size(); ++e) {
        const auto& fs = B.edgeFaces[e];
        if (fs.size() != 2) { rep.openEdgesB++; continue; }
        // opposite directions in the two faces
        const auto dirIn = [&](int f) { const Tri& t = B.tris[f]; for (int k = 0; k < 3; ++k) if (t[k] == B.edges[e][0] && t[(k + 1) % 3] == B.edges[e][1]) return 1; return -1; };
        if (dirIn(fs[0]) == dirIn(fs[1])) rep.openEdgesB++;
    }
    const bool trim = op == Op::TrimInside || op == Op::TrimOutside;
    const bool needB = !trim;
    const int nA = static_cast<int>(A.pos.size()), nB = static_cast<int>(B.pos.size());

    // ---------------------------------------------------------------------------------------- perturbed points
    const double s1 = op == Op::Intersection ? -1.0 : 1.0;
    const std::vector<V3> nb = vertexNormals(B);
    std::vector<exact::PerturbedPoint> PA(A.pos.size()), PB(B.pos.size());
    // A moves only at second order (generically): it breaks ties among A's own coincident points
    for (size_t i = 0; i < A.pos.size(); ++i) PA[i] = {A.pos[i], {0, 0, 0}, genericOf(i, 0x2F7A3B9C1D4E5F61ull)};
    for (size_t i = 0; i < B.pos.size(); ++i) PB[i] = {B.pos[i], mul(nb[i], s1), genericOf(i, 0x5851F42D4C957F2Dull)};
    const auto orient = [&](const exact::PerturbedPoint& a, const exact::PerturbedPoint& b, const exact::PerturbedPoint& c, const exact::PerturbedPoint& d) {
        const int s = exact::orient3dPerturbed(a, b, c, d);
        if (s == 0) { rep.ties++; return 1; }
        return s;
    };

    // ---------------------------------------------------------------------------------------- broadphase
    Bvh bvhB;
    bvhB.build(B.pos, B.tris);
    std::vector<std::pair<int, int>> pairs;  // (A face, B face) with touching boxes
    {
        for (size_t f = 0; f < A.tris.size(); ++f) {
            V3 lo = A.pos[A.tris[f][0]], hi = lo;
            for (int k = 1; k < 3; ++k) for (int c = 0; c < 3; ++c) { lo[c] = std::min(lo[c], A.pos[A.tris[f][k]][c]); hi[c] = std::max(hi[c], A.pos[A.tris[f][k]][c]); }
            bvhB.queryBox(lo, hi, [&](int g) { pairs.push_back({static_cast<int>(f), g}); });
        }
    }

    // ---------------------------------------------------------------------------------------- edge-face crossings
    std::vector<V3> outPos;
    std::vector<Origin> origin;
    outPos.insert(outPos.end(), A.pos.begin(), A.pos.end());
    outPos.insert(outPos.end(), B.pos.begin(), B.pos.end());
    for (int i = 0; i < nA; ++i) origin.push_back({0, i, -1, -1, 0});
    for (int i = 0; i < nB; ++i) origin.push_back({1, i, -1, -1, 0});

    std::vector<std::vector<Crossing>> crossA(A.edges.size()), crossB(B.edges.size());
    std::unordered_set<uint64_t> testedA, testedB;
    // the edge p -> q (one mesh) against the triangle a, b, c (the other): +1/-1 its entering sign, 0 none
    const auto edgeFace = [&](const exact::PerturbedPoint& p, const exact::PerturbedPoint& q, const exact::PerturbedPoint& a, const exact::PerturbedPoint& b, const exact::PerturbedPoint& c) {
        const int sp = orient(a, b, c, p), sq = orient(a, b, c, q);
        if (sp == sq) return 0;
        const int o1 = orient(p, q, a, b), o2 = orient(p, q, b, c), o3 = orient(p, q, c, a);
        if (o1 != o2 || o2 != o3) return 0;
        return sp > 0 ? 1 : -1;  // from the face's front (outside) to its back
    };
    for (const auto& [f, g] : pairs) {
        const Tri& fa = A.tris[f];
        const Tri& gb = B.tris[g];
        for (int k = 0; k < 3; ++k) {
            const int e = A.faceEdges[f][k];
            if (testedA.insert(pkey(e, g)).second) {
                const int lo = A.edges[e][0], hi = A.edges[e][1];
                const int s = edgeFace(PA[lo], PA[hi], PB[gb[0]], PB[gb[1]], PB[gb[2]]);
                if (s) {
                    const double dlo = exact::orient3dValue(B.pos[gb[0]], B.pos[gb[1]], B.pos[gb[2]], A.pos[lo]);
                    const double dhi = exact::orient3dValue(B.pos[gb[0]], B.pos[gb[1]], B.pos[gb[2]], A.pos[hi]);
                    const double t = crossingParam(dlo, dhi);
                    const int vid = static_cast<int>(outPos.size());
                    outPos.push_back(add(A.pos[lo], mul(sub(A.pos[hi], A.pos[lo]), t)));
                    origin.push_back({2, lo, hi, g, t});
                    crossA[e].push_back({e, g, s, t, vid});
                    rep.crossingsA++;
                }
            }
            const int h = B.faceEdges[g][k];
            if (testedB.insert(pkey(h, f)).second) {
                const int lo = B.edges[h][0], hi = B.edges[h][1];
                const int s = edgeFace(PB[lo], PB[hi], PA[fa[0]], PA[fa[1]], PA[fa[2]]);
                if (s) {
                    const double dlo = exact::orient3dValue(A.pos[fa[0]], A.pos[fa[1]], A.pos[fa[2]], B.pos[lo]);
                    const double dhi = exact::orient3dValue(A.pos[fa[0]], A.pos[fa[1]], A.pos[fa[2]], B.pos[hi]);
                    const double t = crossingParam(dlo, dhi);
                    const int vid = static_cast<int>(outPos.size());
                    outPos.push_back(add(B.pos[lo], mul(sub(B.pos[hi], B.pos[lo]), t)));
                    origin.push_back({3, lo, hi, f, t});
                    crossB[h].push_back({h, f, s, t, vid});
                    rep.crossingsB++;
                }
            }
        }
    }
    // along each edge the crossings in order, one order shared by every face at the edge. Clear gaps go by the floating
    // parameter; near ties by the perturbed configuration exactly: crossing 1 comes first from the edge's low end p when
    // it lies on p's side of plane 2, i.e. sign(o1p o2q - o2p o1q) sign(o1p) == sign(o2p) (o: plane-to-point determinants)
    const auto orderEdge = [&](std::vector<Crossing>& v, const exact::PerturbedPoint& P, const exact::PerturbedPoint& Q, const Welded& Y, const std::vector<exact::PerturbedPoint>& PY) {
        if (v.size() < 2) return;
        std::unordered_map<int, std::array<exact::Poly, 2>> polys;
        const auto polyOf = [&](int face) -> const std::array<exact::Poly, 2>& {
            auto it = polys.find(face);
            if (it != polys.end()) return it->second;
            const Tri& g = Y.tris[face];
            return polys.emplace(face, std::array<exact::Poly, 2>{exact::orient3dPoly(PY[g[0]], PY[g[1]], PY[g[2]], P), exact::orient3dPoly(PY[g[0]], PY[g[1]], PY[g[2]], Q)}).first->second;
        };
        std::sort(v.begin(), v.end(), [&](const Crossing& x, const Crossing& y) {
            if (x.face == y.face) return false;
            if (std::fabs(x.t - y.t) > 1e-7) return x.t < y.t;
            const auto& o1 = polyOf(x.face);
            const auto& o2 = polyOf(y.face);
            const int d = exact::leadingSign(exact::crossPoly(o1[0], o2[1], o2[0], o1[1]));
            if (d == 0) { rep.ties++; return x.face < y.face; }
            return d * exact::leadingSign(o1[0]) == exact::leadingSign(o2[0]);
        });
    };
    for (size_t e = 0; e < crossA.size(); ++e) orderEdge(crossA[e], PA[A.edges[e][0]], PA[A.edges[e][1]], B, PB);
    for (size_t e = 0; e < crossB.size(); ++e) orderEdge(crossB[e], PB[B.edges[e][0]], PB[B.edges[e][1]], A, PA);

    // ---------------------------------------------------------------------------------------- segments per face pair
    std::unordered_map<uint64_t, std::vector<int>> seg;  // (A face, B face) -> its points
    for (const auto& list : crossA) for (const auto& c : list) for (int f : A.edgeFaces[c.edge]) seg[pkey(f, c.face)].push_back(c.vid);
    for (const auto& list : crossB) for (const auto& c : list) for (int g : B.edgeFaces[c.edge]) seg[pkey(c.face, g)].push_back(c.vid);
    std::vector<std::vector<std::array<int, 2>>> segsOfA(A.tris.size()), segsOfB(B.tris.size());
    for (const auto& [key, pts] : seg) {
        const int f = static_cast<int>(key >> 32), g = static_cast<int>(key & 0xffffffffu);
        if (pts.size() != 2) { rep.unpairedSegments++; continue; }
        segsOfA[f].push_back({pts[0], pts[1]});
        segsOfB[g].push_back({pts[0], pts[1]});
        rep.segments++;
    }

    // ---------------------------------------------------------------------------------------- winding numbers
    // the winding number of each vertex of X with respect to Y: one ray per connected piece of X, then carried along X's
    // edges by their crossings
    const auto windings = [&](const Welded& X, const std::vector<exact::PerturbedPoint>& PX, const Welded& Y, const std::vector<exact::PerturbedPoint>& PY, const Bvh& bvhY, const std::vector<std::vector<Crossing>>& crossX, size_t& components) {
        std::vector<int> w(X.pos.size(), std::numeric_limits<int>::min());
        std::vector<std::vector<std::pair<int, int>>> adj(X.pos.size());  // (neighbour, edge)
        for (size_t e = 0; e < X.edges.size(); ++e) { adj[X.edges[e][0]].push_back({X.edges[e][1], static_cast<int>(e)}); adj[X.edges[e][1]].push_back({X.edges[e][0], static_cast<int>(e)}); }
        V3 lo = Y.pos.empty() ? V3{0, 0, 0} : Y.pos[0], hi = lo;
        for (const auto& p : Y.pos) for (int c = 0; c < 3; ++c) { lo[c] = std::min(lo[c], p[c]); hi[c] = std::max(hi[c], p[c]); }
        for (const auto& p : X.pos) for (int c = 0; c < 3; ++c) { lo[c] = std::min(lo[c], p[c]); hi[c] = std::max(hi[c], p[c]); }
        const double L = 2 * (norm(sub(hi, lo)) + 1);
        std::vector<int> stack;
        for (size_t v0 = 0; v0 < X.pos.size(); ++v0) {
            if (w[v0] != std::numeric_limits<int>::min() || adj[v0].empty()) continue;
            components++;
            // a ray from far outside to v0: the far end has no perturbation of its own
            const V3 far = add(X.pos[v0], V3{L, L * 0.5773, L * 0.3301});
            const exact::PerturbedPoint F{far, {0, 0, 0}, genericOf(0x7FFFFFFF, 0x2545F4914F6CDD1Dull)};
            int wind = 0;
            bvhY.querySegment(far, X.pos[v0], [&](int g) {
                const Tri& t = Y.tris[g];
                const int s = edgeFace(F, PX[v0], PY[t[0]], PY[t[1]], PY[t[2]]);
                wind += s;
            });
            w[v0] = wind;
            stack.push_back(static_cast<int>(v0));
            while (!stack.empty()) {
                const int v = stack.back();
                stack.pop_back();
                for (auto [u, e] : adj[v]) {
                    int d = 0;
                    for (const auto& c : crossX[e]) d += c.sign;
                    if (X.edges[e][0] != v) d = -d;  // crossings are signed lo -> hi
                    const int wu = w[v] + d;
                    if (w[u] == std::numeric_limits<int>::min()) { w[u] = wu; stack.push_back(u); }
                    else if (w[u] != wu) rep.windingConflicts++;
                }
            }
        }
        return w;
    };
    const std::vector<int> wA = windings(A, PA, B, PB, bvhB, crossA, rep.componentsA);
    std::vector<int> wB;
    Bvh bvhA;
    if (needB) {
        bvhA.build(A.pos, A.tris);
        size_t compB = 0;
        wB = windings(B, PB, A, PA, bvhA, crossB, compB);
    }

    // ---------------------------------------------------------------------------------------- faces rebuilt
    const auto keepA = [&](int w) {
        switch (op) {
            case Op::Union: case Op::Difference: case Op::TrimOutside: return w == 0;
            case Op::Intersection: case Op::TrimInside: return w > 0;
        }
        return false;
    };
    const auto keepB = [&](int w) {
        switch (op) {
            case Op::Union: return w == 0;
            case Op::Intersection: case Op::Difference: return w > 0;
            default: return false;
        }
    };
    std::vector<Tri> outTris;
    std::vector<int> outSide, outSrc;
    std::vector<std::array<V3, 3>> outBary;

    // a point's barycentric weights in X's face f (corners c0, c1, c2)
    const auto baryIn = [&](const Welded& X, int f, int vid, int base, int kindEdge) -> V3 {
        const Tri& t = X.tris[f];
        const Origin& o = origin[vid];
        if (vid >= base && vid < base + static_cast<int>(X.pos.size())) {
            const int v = vid - base;
            for (int k = 0; k < 3; ++k) if (t[k] == v) { V3 b{0, 0, 0}; b[k] = 1; return b; }
        }
        if (o.kind == kindEdge) {
            V3 b{0, 0, 0};
            for (int k = 0; k < 3; ++k) { if (t[k] == o.a) b[k] += 1 - o.t; if (t[k] == o.b) b[k] += o.t; }
            if (b[0] + b[1] + b[2] > 0.5) return b;
        }
        // inside the face: by areas in its plane
        const V3 &p0 = X.pos[t[0]], &p1 = X.pos[t[1]], &p2 = X.pos[t[2]], &q = outPos[vid];
        const V3 n = cross(sub(p1, p0), sub(p2, p0));
        const double nn = dot(n, n);
        if (!(nn > 0)) return {1.0 / 3, 1.0 / 3, 1.0 / 3};
        const double b1 = dot(cross(sub(q, p0), sub(p2, p0)), n) / nn, b2 = dot(cross(sub(p1, p0), sub(q, p0)), n) / nn;
        return {1 - b1 - b2, b1, b2};
    };

    const auto rebuild = [&](const Welded& X, int base, int kindEdge, int sideTag, const std::vector<std::vector<Crossing>>& crossX, const std::vector<std::vector<std::array<int, 2>>>& segsOf, const std::vector<int>& wX, const std::function<bool(int)>& keep, const exact::PerturbedPoint* PY, const Welded& Y, const Bvh& bvhY, bool reverse, size_t& cut, size_t& kept, size_t& dropped) {
        for (size_t f = 0; f < X.tris.size(); ++f) {
            const Tri& t = X.tris[f];
            bool touched = !segsOf[f].empty();
            for (int k = 0; k < 3 && !touched; ++k) touched = !crossX[X.faceEdges[f][k]].empty();
            const auto emit = [&](const Tri& tri) {
                Tri o = reverse ? Tri{tri[0], tri[2], tri[1]} : tri;
                outTris.push_back(o);
                outSide.push_back(sideTag);
                outSrc.push_back(X.src[f]);
                outBary.push_back({baryIn(X, static_cast<int>(f), o[0], base, kindEdge), baryIn(X, static_cast<int>(f), o[1], base, kindEdge), baryIn(X, static_cast<int>(f), o[2], base, kindEdge)});
            };
            if (!touched) {
                if (keep(wX[t[0]])) { emit({t[0] + base, t[1] + base, t[2] + base}); kept++; }
                else dropped++;
                continue;
            }
            cut++;
            // the boundary cycle, with each boundary piece's winding, and which of the face's edges each ring vertex lies on
            std::vector<int> ring;
            std::unordered_map<uint64_t, int> pieceWind;
            std::unordered_map<int, int> onEdge;
            for (int k = 0; k < 3; ++k) {
                const int a = t[k], b = t[(k + 1) % 3];
                const int e = X.faceEdges[f][k];
                const auto& cs = crossX[e];
                const bool forward = X.edges[e][0] == a;
                int w = wX[a];
                int prev = a + base;
                ring.push_back(prev);
                onEdge[a + base] |= 1 << k;
                onEdge[b + base] |= 1 << k;
                for (size_t m = 0; m < cs.size(); ++m) {
                    const Crossing& c = forward ? cs[m] : cs[cs.size() - 1 - m];
                    onEdge[c.vid] |= 1 << k;
                    pieceWind[pkey(prev, c.vid)] = w;
                    w += forward ? c.sign : -c.sign;
                    prev = c.vid;
                    ring.push_back(prev);
                }
                pieceWind[pkey(prev, b + base)] = w;
            }
            // chains: from each boundary point along the segments to another
            std::unordered_map<int, std::vector<int>> nbr;
            for (const auto& s : segsOf[f]) { nbr[s[0]].push_back(s[1]); nbr[s[1]].push_back(s[0]); }
            std::unordered_set<int> onRing(ring.begin(), ring.end());
            std::unordered_set<uint64_t> usedSeg;
            std::vector<std::vector<int>> chains, loops;
            for (int start : ring) {
                auto it = nbr.find(start);
                if (it == nbr.end()) continue;
                for (int first : it->second) {
                    if (usedSeg.count(ekey(start, first))) continue;
                    std::vector<int> ch{start};
                    int prev = start, cur = first;
                    usedSeg.insert(ekey(start, first));
                    for (size_t guard = 0; guard < nbr.size() + 4; ++guard) {
                        ch.push_back(cur);
                        if (onRing.count(cur)) break;
                        int next = kNone;
                        for (int x : nbr[cur]) if (x != prev && !usedSeg.count(ekey(cur, x))) { next = x; break; }
                        if (next == kNone) break;
                        usedSeg.insert(ekey(cur, next));
                        prev = cur;
                        cur = next;
                    }
                    if (onRing.count(ch.back()) && ch.size() >= 2) chains.push_back(ch);
                    else rep.chainFailures++;
                }
            }
            for (auto& [v, ns] : nbr) {
                for (int first : ns) {
                    if (usedSeg.count(ekey(v, first))) continue;
                    std::vector<int> lp{v};
                    int prev = v, cur = first;
                    usedSeg.insert(ekey(v, first));
                    for (size_t guard = 0; guard < nbr.size() + 4 && cur != v; ++guard) {
                        lp.push_back(cur);
                        int next = kNone;
                        for (int x : nbr[cur]) if (x != prev && !usedSeg.count(ekey(cur, x))) { next = x; break; }
                        if (next == kNone) { next = v; }
                        usedSeg.insert(ekey(cur, next));
                        prev = cur;
                        cur = next;
                    }
                    if (lp.size() >= 3) loops.push_back(lp);
                }
            }
            // split the face along each chain
            std::vector<std::vector<int>> regions{ring};
            for (const auto& ch : chains) {
                const int u = ch.front(), v = ch.back();
                bool done = false;
                for (size_t r = 0; r < regions.size() && !done; ++r) {
                    auto& cyc = regions[r];
                    const auto iu = std::find(cyc.begin(), cyc.end(), u), iv = std::find(cyc.begin(), cyc.end(), v);
                    if (iu == cyc.end() || iv == cyc.end()) continue;
                    const size_t n = cyc.size(), a = static_cast<size_t>(iu - cyc.begin()), b = static_cast<size_t>(iv - cyc.begin());
                    std::vector<int> r1, r2;
                    for (size_t i = a;; i = (i + 1) % n) { r1.push_back(cyc[i]); if (i == b) break; }
                    for (size_t i = ch.size() - 2; i >= 1; --i) r1.push_back(ch[i]);
                    for (size_t i = b;; i = (i + 1) % n) { r2.push_back(cyc[i]); if (i == a) break; }
                    for (size_t i = 1; i + 1 < ch.size(); ++i) r2.push_back(ch[i]);
                    cyc = r1;
                    regions.push_back(r2);
                    done = true;
                }
                if (!done) rep.chainFailures++;
            }
            // the face's plane as 2D, counter-clockwise where the face is
            const V3 n = cross(sub(X.pos[t[1]], X.pos[t[0]]), sub(X.pos[t[2]], X.pos[t[0]]));
            int ax = 0;
            for (int c = 1; c < 3; ++c) if (std::fabs(n[c]) > std::fabs(n[ax])) ax = c;
            const int u0 = (ax + 1) % 3, u1 = (ax + 2) % 3;
            const bool flip = n[ax] < 0;
            const auto to2 = [&](int vid) { const V3& p = outPos[vid]; return flip ? cdt::P2{p[u1], p[u0]} : cdt::P2{p[u0], p[u1]}; };
            const auto signedArea = [&](const std::vector<int>& cyc) { double s = 0; for (size_t i = 0; i < cyc.size(); ++i) { const auto a = to2(cyc[i]), b = to2(cyc[(i + 1) % cyc.size()]); s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
            // closed loops inside the face: an island each, a hole in the region holding it
            std::vector<std::vector<std::vector<int>>> holes(regions.size());
            std::vector<std::vector<int>> islands;
            for (auto lp : loops) {
                if (signedArea(lp) < 0) std::reverse(lp.begin(), lp.end());
                const cdt::P2 q = to2(lp[0]);
                size_t holder = 0;
                for (size_t r = 0; r < regions.size(); ++r) {
                    bool in = false;
                    const auto& cyc = regions[r];
                    for (size_t i = 0, j = cyc.size() - 1; i < cyc.size(); j = i++) {
                        const auto a = to2(cyc[i]), b = to2(cyc[j]);
                        if ((a[1] > q[1]) != (b[1] > q[1]) && q[0] < (b[0] - a[0]) * (q[1] - a[1]) / (b[1] - a[1]) + a[0]) in = !in;
                    }
                    if (in) { holder = r; break; }
                }
                std::vector<int> hole(lp.rbegin(), lp.rend());
                holes[holder].push_back(hole);
                islands.push_back(lp);
            }
            // each region's winding: from a boundary piece on its cycle, else (an island) by a ray from inside it
            const auto regionWinding = [&](const std::vector<int>& cyc, const std::vector<Tri>& tris) {
                for (size_t i = 0; i < cyc.size(); ++i) {
                    auto it = pieceWind.find(pkey(cyc[i], cyc[(i + 1) % cyc.size()]));
                    if (it != pieceWind.end()) return it->second;
                }
                // the centroid of its largest triangle, cast to far away
                size_t best = 0;
                double ba = -1;
                for (size_t i = 0; i < tris.size(); ++i) {
                    const double a = norm(cross(sub(outPos[tris[i][1]], outPos[tris[i][0]]), sub(outPos[tris[i][2]], outPos[tris[i][0]])));
                    if (a > ba) { ba = a; best = i; }
                }
                if (tris.empty()) return 0;
                const V3 c = mul(add(add(outPos[tris[best][0]], outPos[tris[best][1]]), outPos[tris[best][2]]), 1.0 / 3);
                const exact::PerturbedPoint C{c, {0, 0, 0}, genericOf(0x7FFFFFFE, 0x0123456789ABCDEFull)};
                V3 lo = c, hi = c;
                for (const auto& p : Y.pos) for (int k = 0; k < 3; ++k) { lo[k] = std::min(lo[k], p[k]); hi[k] = std::max(hi[k], p[k]); }
                const double L = 2 * (norm(sub(hi, lo)) + 1);
                const V3 far = add(c, V3{L, L * 0.5773, L * 0.3301});
                const exact::PerturbedPoint F{far, {0, 0, 0}, genericOf(0x7FFFFFFF, 0x2545F4914F6CDD1Dull)};
                int wind = 0;
                bvhY.querySegment(far, c, [&](int g) { const Tri& tt = Y.tris[g]; wind += edgeFace(F, C, PY[tt[0]], PY[tt[1]], PY[tt[2]]); });
                return wind;
            };
            const auto emitRegion = [&](const std::vector<int>& cyc, const std::vector<std::vector<int>>& hs) {
                std::vector<cdt::P2> xy;
                for (int v : cyc) xy.push_back(to2(v));
                for (const auto& h : hs) for (int v : h) xy.push_back(to2(v));
                bool fb = false;
                auto tris = ringTriangulate(cyc, hs, xy, [&](int v) { auto it = onEdge.find(v); return it == onEdge.end() ? 0 : it->second; }, fb);
                if (fb) rep.fallbackFaces++;
                if (keep(regionWinding(cyc, tris))) { for (const auto& tr : tris) emit(tr); kept++; } else dropped++;
            };
            for (size_t r = 0; r < regions.size(); ++r) emitRegion(regions[r], holes[r]);
            for (const auto& isl : islands) emitRegion(isl, {});
        }
    };
    rebuild(A, 0, 2, 0, crossA, segsOfA, wA, keepA, PB.data(), B, bvhB, false, rep.facesCutA, rep.keptA, rep.droppedA);
    if (needB) rebuild(B, nA, 3, 1, crossB, segsOfB, wB, keepB, PA.data(), A, bvhA, op == Op::Difference, rep.facesCutB, rep.keptB, rep.droppedB);

    // ---------------------------------------------------------------------------------------- compacted output
    std::vector<int> remap(outPos.size(), kNone);
    for (auto& tri : outTris) for (int& v : tri) {
        if (remap[v] == kNone) { remap[v] = static_cast<int>(R.mesh.pos.size()); R.mesh.pos.push_back(outPos[v]); R.origin.push_back(origin[v]); }
        v = remap[v];
    }
    R.mesh.tris = std::move(outTris);
    R.side = std::move(outSide);
    R.source = std::move(outSrc);
    R.bary = std::move(outBary);

    if (opt.collapseShort > 0) {
        // short edges at cut points collapsed onto a neighbour along the edge, where no triangle folds and the link
        // condition holds (the surface stays a manifold of the same shape)
        const double tol2 = opt.collapseShort * opt.collapseShort;
        const double minCos = std::cos(opt.collapseMaxTurnDeg * M_PI / 180);
        const size_t nv = R.mesh.pos.size();
        std::vector<std::vector<int>> vt(nv);
        for (size_t t = 0; t < R.mesh.tris.size(); ++t) for (int v : R.mesh.tris[t]) vt[v].push_back(static_cast<int>(t));
        std::vector<uint8_t> dead(R.mesh.tris.size(), 0);
        std::vector<int> into(nv);
        std::iota(into.begin(), into.end(), 0);
        const auto isCut = [&](int v) { return R.origin[v].kind >= 2; };
        // a point's weights in an input triangle (the collapsed corner takes its new position's)
        const auto baryOfInput = [&](int side, int src, const V3& q) -> V3 {
            const Mesh& M = side == 0 ? Ain : Bin;
            const V3 &p0 = M.pos[M.tris[src][0]], &p1 = M.pos[M.tris[src][1]], &p2 = M.pos[M.tris[src][2]];
            const V3 n = cross(sub(p1, p0), sub(p2, p0));
            const double nn = dot(n, n);
            if (!(nn > 0)) return {1.0 / 3, 1.0 / 3, 1.0 / 3};
            const double b1 = dot(cross(sub(q, p0), sub(p2, p0)), n) / nn, b2 = dot(cross(sub(p1, p0), sub(q, p0)), n) / nn;
            return {1 - b1 - b2, b1, b2};
        };
        for (int v = 0; v < static_cast<int>(nv); ++v) {
            if (!isCut(v) || into[v] != v) continue;
            // candidate targets: neighbours along live triangles
            std::vector<int> nbrs;
            for (int t : vt[v]) if (!dead[t]) for (int u : R.mesh.tris[t]) if (u != v) nbrs.push_back(u);
            std::sort(nbrs.begin(), nbrs.end());
            nbrs.erase(std::unique(nbrs.begin(), nbrs.end()), nbrs.end());
            int best = kNone;
            double bestD = tol2;
            for (int u : nbrs) {
                const double d = dot(sub(R.mesh.pos[u], R.mesh.pos[v]), sub(R.mesh.pos[u], R.mesh.pos[v]));
                if (d >= bestD) continue;
                // the link condition: v and u share exactly the neighbours of the triangles on edge (v, u)
                std::vector<int> nu;
                for (int t : vt[u]) if (!dead[t]) for (int x : R.mesh.tris[t]) if (x != u) nu.push_back(x);
                std::sort(nu.begin(), nu.end());
                nu.erase(std::unique(nu.begin(), nu.end()), nu.end());
                std::vector<int> common;
                std::set_intersection(nbrs.begin(), nbrs.end(), nu.begin(), nu.end(), std::back_inserter(common));
                size_t onEdge = 0;
                std::vector<int> opp;
                for (int t : vt[v]) {
                    if (dead[t]) continue;
                    const Tri& tr = R.mesh.tris[t];
                    if (tr[0] == u || tr[1] == u || tr[2] == u) { onEdge++; for (int x : tr) if (x != u && x != v) opp.push_back(x); }
                }
                std::sort(opp.begin(), opp.end());
                if (onEdge == 0 || common != opp) continue;
                // no triangle round v may fold when v moves to u
                bool ok = true;
                for (int t : vt[v]) {
                    if (dead[t] || !ok) continue;
                    const Tri& tr = R.mesh.tris[t];
                    if (tr[0] == u || tr[1] == u || tr[2] == u) continue;
                    V3 p[3], q[3];
                    for (int k = 0; k < 3; ++k) { p[k] = R.mesh.pos[tr[k]]; q[k] = tr[k] == v ? R.mesh.pos[u] : p[k]; }
                    const V3 n0 = cross(sub(p[1], p[0]), sub(p[2], p[0])), n1 = cross(sub(q[1], q[0]), sub(q[2], q[0]));
                    const double l0 = norm(n0), l1 = norm(n1);
                    if (l0 > 0 && l1 > 0 && dot(n0, n1) < minCos * l0 * l1) ok = false;
                }
                if (ok) { best = u; bestD = d; }
            }
            if (best == kNone) continue;
            for (int t : vt[v]) {
                if (dead[t]) continue;
                Tri& tr = R.mesh.tris[t];
                if (tr[0] == best || tr[1] == best || tr[2] == best) { dead[t] = 1; continue; }
                for (int k = 0; k < 3; ++k) if (tr[k] == v) { tr[k] = best; R.bary[t][k] = baryOfInput(R.side[t], R.source[t], R.mesh.pos[best]); }
                vt[best].push_back(t);
            }
            into[v] = best;
            rep.collapsed++;
        }
        // compact
        std::vector<Tri> tris;
        std::vector<int> side, src;
        std::vector<std::array<V3, 3>> bary;
        for (size_t t = 0; t < R.mesh.tris.size(); ++t) if (!dead[t]) { tris.push_back(R.mesh.tris[t]); side.push_back(R.side[t]); src.push_back(R.source[t]); bary.push_back(R.bary[t]); }
        R.mesh.tris = std::move(tris);
        R.side = std::move(side);
        R.source = std::move(src);
        R.bary = std::move(bary);
    }

    std::unordered_map<uint64_t, int> ec;
    for (const auto& tr : R.mesh.tris) for (int k = 0; k < 3; ++k) ec[ekey(tr[k], tr[(k + 1) % 3])]++;
    for (const auto& [k, c] : ec) { if (c == 1) rep.openEdgesOut++; else if (c > 2) rep.nonManifoldOut++; }
    return R;
}

// ------------------------------------------------------------------------------------------------ footprint prisms

using Loop2 = std::vector<std::array<double, 2>>;

/**
 * A plan region (loops in x, z; their union, each loop's own holes ignored as the footprint clip ignores them) pushed
 * out by `margin` with mitred corners (a mitre longer than 2 x margin bevelled), as loops: the union of each loop, a strip
 * along each edge and a wedge at each convex corner, made by the CDT under the non-zero rule.
 */
inline std::vector<Loop2> offsetRegion(const std::vector<Loop2>& loops, double margin) {
    std::vector<cdt::P2> pts;
    std::vector<std::array<int, 2>> segs;
    const auto addPoly = [&](const std::vector<cdt::P2>& poly) {
        // counter-clockwise always (the non-zero rule unions them)
        double a = 0;
        for (size_t i = 0; i < poly.size(); ++i) a += poly[i][0] * poly[(i + 1) % poly.size()][1] - poly[(i + 1) % poly.size()][0] * poly[i][1];
        const int base = static_cast<int>(pts.size());
        const int n = static_cast<int>(poly.size());
        for (int i = 0; i < n; ++i) pts.push_back(a >= 0 ? poly[i] : poly[n - 1 - i]);
        for (int i = 0; i < n; ++i) segs.push_back({base + i, base + (i + 1) % n});
    };
    for (const auto& raw : loops) {
        std::vector<cdt::P2> L;
        for (const auto& p : raw) if (L.empty() || p[0] != L.back()[0] || p[1] != L.back()[1]) L.push_back({p[0], p[1]});
        while (L.size() > 1 && L.front() == L.back()) L.pop_back();
        if (L.size() < 3) continue;
        double area = 0;
        for (size_t i = 0; i < L.size(); ++i) area += L[i][0] * L[(i + 1) % L.size()][1] - L[(i + 1) % L.size()][0] * L[i][1];
        if (area < 0) std::reverse(L.begin(), L.end());
        addPoly(L);
        if (!(margin > 0)) continue;
        const size_t n = L.size();
        std::vector<cdt::P2> nrm(n);
        for (size_t i = 0; i < n; ++i) {
            const auto& a = L[i];
            const auto& b = L[(i + 1) % n];
            const double dx = b[0] - a[0], dy = b[1] - a[1], l = std::hypot(dx, dy);
            nrm[i] = l > 0 ? cdt::P2{dy / l, -dx / l} : cdt::P2{0, 0};  // outward for a counter-clockwise loop
        }
        for (size_t i = 0; i < n; ++i) {
            const auto& a = L[i];
            const auto& b = L[(i + 1) % n];
            if (nrm[i][0] == 0 && nrm[i][1] == 0) continue;
            addPoly({a, b, {b[0] + nrm[i][0] * margin, b[1] + nrm[i][1] * margin}, {a[0] + nrm[i][0] * margin, a[1] + nrm[i][1] * margin}});
            // the corner at b: convex when the turn is to the left
            const auto& n1 = nrm[i];
            const auto& n2 = nrm[(i + 1) % n];
            const double turn = n1[0] * n2[1] - n1[1] * n2[0];
            if (turn <= 0) continue;  // reflex: the strips overlap there already
            const double c = n1[0] * n2[0] + n1[1] * n2[1];
            const cdt::P2 p1{b[0] + n1[0] * margin, b[1] + n1[1] * margin}, p2{b[0] + n2[0] * margin, b[1] + n2[1] * margin};
            const double mitre = margin / std::sqrt(std::max(1e-12, (1 + c) / 2));
            if (mitre <= 2 * margin) {
                const double bx = n1[0] + n2[0], by = n1[1] + n2[1], bl = std::hypot(bx, by);
                addPoly({b, p1, {b[0] + bx / bl * mitre, b[1] + by / bl * mitre}, p2});
            } else {
                addPoly({b, p1, p2});
            }
        }
    }
    cdt::Options o;
    o.fill = cdt::Fill::NonZero;
    const cdt::Output out = cdt::triangulate(pts, segs, o);
    std::vector<Loop2> res;
    for (const auto& lp : cdt::boundaryLoops(out)) {
        // drop vertices within a micrometre of the line through their neighbours (a mitre point computed in floating
        // point lands a hair off its straight edge; a vertex kept there makes a needle wherever the prism cuts)
        std::vector<int> keep(lp.begin(), lp.end());
        for (bool again = true; again && keep.size() > 3;) {
            again = false;
            for (size_t i = 0; i < keep.size() && keep.size() > 3; ++i) {
                const auto& a = out.points[keep[(i + keep.size() - 1) % keep.size()]];
                const auto& b = out.points[keep[i]];
                const auto& c = out.points[keep[(i + 1) % keep.size()]];
                const double chord = std::hypot(c[0] - a[0], c[1] - a[1]);
                const double off = chord > 0 ? std::fabs(exact::orient2dValue(a, c, b)) / chord : std::hypot(b[0] - a[0], b[1] - a[1]);
                if (exact::orient2d(a, b, c) == 0 || off < 1e-6) { keep.erase(keep.begin() + static_cast<long>(i)); again = true; break; }
            }
        }
        if (keep.size() < 3) continue;
        Loop2 l;
        for (int v : keep) l.push_back({out.points[v][0], out.points[v][1]});
        res.push_back(l);
    }
    return res;
}

/**
 * A closed, outward-facing prism over plan loops (x, z; counter-clockwise outer boundaries, clockwise holes, as
 * offsetRegion gives them) from y0 to y1: walls along every loop edge, caps by the CDT over the loops.
 */
inline Mesh prism(const std::vector<Loop2>& loops, double y0, double y1) {
    Mesh m;
    std::vector<cdt::P2> pts;
    std::vector<std::vector<int>> rings;
    for (const auto& l : loops) {
        std::vector<int> r;
        for (const auto& p : l) { r.push_back(static_cast<int>(pts.size())); pts.push_back({p[0], p[1]}); }
        rings.push_back(r);
    }
    const int n = static_cast<int>(pts.size());
    for (const auto& p : pts) m.pos.push_back({p[0], y0, p[1]});
    for (const auto& p : pts) m.pos.push_back({p[0], y1, p[1]});
    // plan (x, z) counter-clockwise seen from +y is clockwise in (x, z) axes' own handedness: y up, x east, z south
    // means looking down -y, (x, z) appear mirrored, so a counter-clockwise (x, z) loop is traversed clockwise from above.
    std::vector<std::array<int, 2>> segs;
    for (const auto& r : rings) for (size_t i = 0; i < r.size(); ++i) segs.push_back({r[i], r[(i + 1) % r.size()]});
    const cdt::Output o = cdt::triangulate(pts, segs, {});
    std::vector<int> back(o.points.size(), -1);
    for (int i = 0; i < n; ++i) if (back[o.inputVertex[i]] < 0) back[o.inputVertex[i]] = i;
    for (const auto& t : o.tris) {
        if (back[t[0]] < 0 || back[t[1]] < 0 || back[t[2]] < 0) continue;  // a crossing point: loops must not cross
        const int a = back[t[0]], b = back[t[1]], c = back[t[2]];
        // (x, z) counter-clockwise: the normal (b - a) x (c - a) in 3D (x, y, z) points to -y
        m.tris.push_back({a, b, c});              // bottom, facing -y
        m.tris.push_back({a + n, c + n, b + n});  // top, facing +y
    }
    for (const auto& r : rings) for (size_t i = 0; i < r.size(); ++i) {
        const int a = r[i], b = r[(i + 1) % r.size()];
        // the wall outside the edge a -> b (outward normal to the right of a -> b in (x, z) counter-clockwise loops)
        m.tris.push_back({a, b + n, b});
        m.tris.push_back({a, a + n, b + n});
    }
    return m;
}

}  // namespace boolean
}  // namespace scratchbox
