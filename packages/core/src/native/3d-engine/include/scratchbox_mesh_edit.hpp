/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Edits on a given triangle mesh, the way a modeller makes them:
 * - booleans (union, subtract, intersect): each solid's polygons classified against the other's BSP tree, in double
 *   precision; the cut faces keep the edges they were cut on and are capped by the other solid's faces, so a hole has walls;
 * - plane cuts: everything on the side a plane's normal points to removed and the cut capped (a subtract with a half-space);
 * - face selection by direction and region (a cone around a direction, a box in fractions of the mesh's bounds);
 * - extrude and inset of a selected region: the region moved along its normals and/or shrunk inside its own plane, joined
 *   to the rest by side walls on its boundary;
 * - crease normals: smooth across shallow edges, hard across sharp ones.
 * The operand solids of a boolean are measurements (centre, size, radius, end points), not named shapes.
 */

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <memory>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <stdexcept>
#include <cstdint>
#include <string>
#include <functional>

namespace scratchbox {
namespace mesh_edit {

using math::Vec3;
using math::AABB;
using geometry::ScratchboxMesh;
using geometry::Vertex;

struct MeshEditError : std::invalid_argument {
    using std::invalid_argument::invalid_argument;
};

// ============================================================================
// BSP booleans
// ============================================================================

struct D3 {
    double x = 0, y = 0, z = 0;
    D3 operator+(const D3& o) const { return {x + o.x, y + o.y, z + o.z}; }
    D3 operator-(const D3& o) const { return {x - o.x, y - o.y, z - o.z}; }
    D3 operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(const D3& o) const { return x * o.x + y * o.y + z * o.z; }
    D3 cross(const D3& o) const { return {y * o.z - z * o.y, z * o.x - x * o.z, x * o.y - y * o.x}; }
    double length() const { return std::sqrt(dot(*this)); }
};

struct CsgVertex {
    D3 p;
    double u = 0, v = 0;
    CsgVertex lerp(const CsgVertex& o, double t) const { return {p + (o.p - p) * t, u + (o.u - u) * t, v + (o.v - v) * t}; }
};

struct CsgPlane {
    D3 n;
    double w = 0;
    void flip() { n = n * -1.0; w = -w; }
};

struct CsgPolygon {
    std::vector<CsgVertex> verts;
    CsgPlane plane;
    void flip() { std::reverse(verts.begin(), verts.end()); plane.flip(); }
};

/** A polygon from three or more points, or none when they are degenerate. */
inline bool makePolygon(std::vector<CsgVertex> verts, CsgPolygon& out) {
    if (verts.size() < 3) return false;
    D3 n{0, 0, 0};
    for (size_t i = 0; i < verts.size(); ++i) {   // Newell's normal, stable for any planar polygon
        const D3& a = verts[i].p; const D3& b = verts[(i + 1) % verts.size()].p;
        n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
    }
    const double len = n.length();
    if (!(len > 1e-18)) return false;
    out.plane.n = n * (1.0 / len);
    out.plane.w = out.plane.n.dot(verts[0].p);
    out.verts = std::move(verts);
    return true;
}

class BspTree {
public:
    /** Points within eps of a plane count as on it; set from the solids' size. */
    explicit BspTree(double eps) : eps_(eps), root_(std::make_unique<Node>()) {}

    void build(std::vector<CsgPolygon> polys) { insert(root_.get(), std::move(polys)); }

    /**
     * polys split into their parts outside and inside this solid. A part lying in one of the solid's planes goes the way
     * the caller says: sameFront for a part facing the plane's way, oppFront for one facing against it (true = outside).
     */
    void classify(std::vector<CsgPolygon> polys, bool sameFront, bool oppFront, std::vector<CsgPolygon>& outside, std::vector<CsgPolygon>& inside) const {
        std::vector<std::pair<const Node*, std::vector<CsgPolygon>>> work;
        work.emplace_back(root_.get(), std::move(polys));
        while (!work.empty()) {
            auto [node, list] = std::move(work.back());
            work.pop_back();
            if (!node->hasPlane) { for (auto& p : list) outside.push_back(std::move(p)); continue; }
            std::vector<CsgPolygon> front, back, coSame, coOpp;
            for (auto& p : list) split(node->plane, p, coSame, coOpp, front, back);
            for (auto& p : coSame) (sameFront ? front : back).push_back(std::move(p));
            for (auto& p : coOpp) (oppFront ? front : back).push_back(std::move(p));
            if (node->front) work.emplace_back(node->front.get(), std::move(front));
            else for (auto& p : front) outside.push_back(std::move(p));
            if (node->back) work.emplace_back(node->back.get(), std::move(back));
            else for (auto& p : back) inside.push_back(std::move(p));
        }
    }

private:
    struct Node {
        bool hasPlane = false;
        CsgPlane plane;
        std::vector<CsgPolygon> polygons;
        std::unique_ptr<Node> front, back;
    };

    double eps_;
    std::unique_ptr<Node> root_;

    template <typename F> void forEach(F f) {
        std::vector<Node*> stack{root_.get()};
        while (!stack.empty()) {
            Node* n = stack.back(); stack.pop_back();
            f(n);
            if (n->front) stack.push_back(n->front.get());
            if (n->back) stack.push_back(n->back.get());
        }
    }

    void insert(Node* start, std::vector<CsgPolygon> polys) {
        std::vector<std::pair<Node*, std::vector<CsgPolygon>>> work;
        work.emplace_back(start, std::move(polys));
        while (!work.empty()) {
            auto [node, list] = std::move(work.back());
            work.pop_back();
            if (list.empty()) continue;
            if (!node->hasPlane) { node->plane = list[0].plane; node->hasPlane = true; }
            std::vector<CsgPolygon> front, back;
            for (auto& p : list) split(node->plane, p, node->polygons, node->polygons, front, back);
            if (!front.empty()) { if (!node->front) node->front = std::make_unique<Node>(); work.emplace_back(node->front.get(), std::move(front)); }
            if (!back.empty()) { if (!node->back) node->back = std::make_unique<Node>(); work.emplace_back(node->back.get(), std::move(back)); }
        }
    }

    void split(const CsgPlane& plane, const CsgPolygon& poly, std::vector<CsgPolygon>& coFront, std::vector<CsgPolygon>& coBack,
               std::vector<CsgPolygon>& front, std::vector<CsgPolygon>& back) const {
        enum { COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3 };
        int polyType = 0;
        std::vector<int> types(poly.verts.size());
        std::vector<double> dist(poly.verts.size());
        for (size_t i = 0; i < poly.verts.size(); ++i) {
            const double t = plane.n.dot(poly.verts[i].p) - plane.w;
            dist[i] = t;
            types[i] = t < -eps_ ? BACK : (t > eps_ ? FRONT : COPLANAR);
            polyType |= types[i];
        }
        switch (polyType) {
            case COPLANAR: (plane.n.dot(poly.plane.n) > 0 ? coFront : coBack).push_back(poly); break;
            case FRONT: front.push_back(poly); break;
            case BACK: back.push_back(poly); break;
            default: {
                std::vector<CsgVertex> f, b;
                const size_t n = poly.verts.size();
                for (size_t i = 0; i < n; ++i) {
                    const size_t j = (i + 1) % n;
                    const int ti = types[i], tj = types[j];
                    const CsgVertex& vi = poly.verts[i];
                    if (ti != BACK) f.push_back(vi);
                    if (ti != FRONT) b.push_back(vi);
                    if ((ti | tj) == SPANNING) {
                        const CsgVertex v = vi.lerp(poly.verts[j], dist[i] / (dist[i] - dist[j]));
                        f.push_back(v); b.push_back(v);
                    }
                }
                // the pieces keep the parent's plane: re-deriving it from a sliver would tilt it
                if (f.size() >= 3) front.push_back(CsgPolygon{std::move(f), poly.plane});
                if (b.size() >= 3) back.push_back(CsgPolygon{std::move(b), poly.plane});
            }
        }
    }
};

enum class BooleanOp { Union, Subtract, Intersect };

struct DBox {
    D3 lo{1e300, 1e300, 1e300}, hi{-1e300, -1e300, -1e300};
    void expand(const D3& p) { lo = {std::min(lo.x, p.x), std::min(lo.y, p.y), std::min(lo.z, p.z)}; hi = {std::max(hi.x, p.x), std::max(hi.y, p.y), std::max(hi.z, p.z)}; }
    bool overlaps(const DBox& o, double pad) const {
        return lo.x <= o.hi.x + pad && hi.x >= o.lo.x - pad && lo.y <= o.hi.y + pad && hi.y >= o.lo.y - pad && lo.z <= o.hi.z + pad && hi.z >= o.lo.z - pad;
    }
};

inline DBox boxOf(const CsgPolygon& p) { DBox b; for (const auto& v : p.verts) b.expand(v.p); return b; }
inline DBox boxOf(const std::vector<CsgPolygon>& ps) { DBox b; for (const auto& p : ps) for (const auto& v : p.verts) b.expand(v.p); return b; }

/**
 * a op b on closed solids, as polygons. Each solid's BSP tree is built from all of it, so it tells inside from outside
 * everywhere; only the polygons near the other solid (their boxes overlapping its box) are split by it, so a face far
 * from the cut is not broken up by planes that never reach it. Faces the two solids share (coplanar) are kept once:
 * union keeps a's where they face the same way and neither where they face each other; subtract removes a's under b's
 * same-facing face and keeps it where b only touches; intersect keeps a's same-facing one.
 */
inline std::vector<CsgPolygon> booleanPolygons(std::vector<CsgPolygon> a, std::vector<CsgPolygon> b, BooleanOp op, double eps) {
    const DBox ba = boxOf(a), bb = boxOf(b);
    const double pad = eps * 16;
    BspTree TA(eps), TB(eps);
    TA.build(a);
    TB.build(b);
    std::vector<CsgPolygon> aNear, aFar, bNear, bFar;
    for (auto& p : a) (boxOf(p).overlaps(bb, pad) ? aNear : aFar).push_back(std::move(p));
    for (auto& p : b) (boxOf(p).overlaps(ba, pad) ? bNear : bFar).push_back(std::move(p));
    std::vector<CsgPolygon> out, aOut, aIn, bOut, bIn;
    auto add = [&](std::vector<CsgPolygon>& v, bool flip) { for (auto& p : v) { if (flip) p.flip(); out.push_back(std::move(p)); } };
    switch (op) {
        case BooleanOp::Union:
            TB.classify(std::move(aNear), true, false, aOut, aIn);
            TA.classify(std::move(bNear), false, false, bOut, bIn);
            add(aOut, false); add(bOut, false); add(aFar, false); add(bFar, false);
            break;
        case BooleanOp::Subtract:
            TB.classify(std::move(aNear), false, true, aOut, aIn);
            TA.classify(std::move(bNear), true, true, bOut, bIn);
            add(aOut, false); add(bIn, true); add(aFar, false);
            break;
        case BooleanOp::Intersect:
        default:
            TB.classify(std::move(aNear), false, true, aOut, aIn);
            TA.classify(std::move(bNear), true, true, bOut, bIn);
            add(aIn, false); add(bIn, false);
            break;
    }
    return out;
}

/**
 * T-junctions closed: every polygon edge with another polygon's corner lying on it gets that corner, so neighbouring
 * faces share their edges exactly (a cut leaves corners mid-edge on the faces next to it).
 */
inline void closeTJunctions(std::vector<CsgPolygon>& polys, double eps) {
    struct K { int64_t x, y, z; bool operator==(const K& o) const { return x == o.x && y == o.y && z == o.z; } };
    struct H { size_t operator()(const K& k) const { return std::hash<int64_t>()(k.x * 73856093 ^ k.y * 19349663 ^ k.z * 83492791); } };
    const DBox all = boxOf(polys);
    const D3 ext = all.hi - all.lo;
    size_t corners = 0;
    for (const auto& p : polys) corners += p.verts.size();
    if (corners == 0) return;
    const double cell = std::max(ext.length() / std::max(1.0, std::cbrt(double(corners))), eps * 64);
    auto keyOf = [&](const D3& p) { return K{int64_t(std::floor((p.x - all.lo.x) / cell)), int64_t(std::floor((p.y - all.lo.y) / cell)), int64_t(std::floor((p.z - all.lo.z) / cell))}; };
    std::unordered_map<K, std::vector<D3>, H> grid;
    for (const auto& p : polys) for (const auto& v : p.verts) {
        auto& bucket = grid[keyOf(v.p)];
        bool dup = false;
        for (const auto& q : bucket) if ((q - v.p).length() <= eps) { dup = true; break; }
        if (!dup) bucket.push_back(v.p);
    }
    for (auto& p : polys) {
        std::vector<CsgVertex> out;
        const size_t n = p.verts.size();
        for (size_t i = 0; i < n; ++i) {
            const CsgVertex& a = p.verts[i]; const CsgVertex& b = p.verts[(i + 1) % n];
            out.push_back(a);
            const D3 e = b.p - a.p;
            const double len2 = e.dot(e);
            if (len2 <= eps * eps) continue;
            const K k0 = keyOf(a.p), k1 = keyOf(b.p);
            const int64_t cells = (std::abs(k1.x - k0.x) + 1) * (std::abs(k1.y - k0.y) + 1) * (std::abs(k1.z - k0.z) + 1);
            if (cells > 4096) continue;   // an edge across much of the mesh: left as it is
            std::vector<std::pair<double, D3>> on;
            for (int64_t x = std::min(k0.x, k1.x); x <= std::max(k0.x, k1.x); ++x)
            for (int64_t y = std::min(k0.y, k1.y); y <= std::max(k0.y, k1.y); ++y)
            for (int64_t z = std::min(k0.z, k1.z); z <= std::max(k0.z, k1.z); ++z) {
                auto it = grid.find(K{x, y, z});
                if (it == grid.end()) continue;
                for (const auto& q : it->second) {
                    const double t = (q - a.p).dot(e) / len2;
                    if (t <= 0 || t >= 1) continue;
                    const D3 foot = a.p + e * t;
                    if ((q - foot).length() > eps || (q - a.p).length() <= eps || (q - b.p).length() <= eps) continue;
                    on.emplace_back(t, q);
                }
            }
            std::sort(on.begin(), on.end(), [](const auto& l, const auto& r) { return l.first < r.first; });
            for (const auto& [t, q] : on) { CsgVertex v = a.lerp(b, t); v.p = q; out.push_back(v); }
        }
        p.verts = std::move(out);
    }
}

inline std::vector<CsgPolygon> meshToPolygons(const ScratchboxMesh& m) {
    std::vector<CsgPolygon> out;
    out.reserve(m.indices.size() / 3);
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
        std::vector<CsgVertex> vs;
        for (int k = 0; k < 3; ++k) {
            const Vertex& v = m.vertices[m.indices[i + k]];
            vs.push_back({{v.position.x, v.position.y, v.position.z}, v.uv.x, v.uv.y});
        }
        CsgPolygon p;
        if (makePolygon(std::move(vs), p)) out.push_back(std::move(p));
    }
    return out;
}

/**
 * Each polygon as triangles with its own vertices (its plane is its normal). The pieces a BSP leaves are convex and often
 * carry corners in the middle of a side (where a neighbour was cut): they are ear-clipped, always taking the ear with the
 * widest smallest angle, so no triangle lies flat along a side and no point is added inside (a point added inside would
 * stay put when the face is later inset, and fold).
 */
inline ScratchboxMesh polygonsToMesh(const std::vector<CsgPolygon>& polys, const std::string& name) {
    ScratchboxMesh m(name);
    for (const auto& p : polys) {
        const Vec3 n(static_cast<float>(p.plane.n.x), static_cast<float>(p.plane.n.y), static_cast<float>(p.plane.n.z));
        const uint32_t base = static_cast<uint32_t>(m.vertices.size());
        for (const auto& v : p.verts) {
            m.addVertex(Vertex(Vec3(static_cast<float>(v.p.x), static_cast<float>(v.p.y), static_cast<float>(v.p.z)), n,
                               math::Vec2(static_cast<float>(v.u), static_cast<float>(v.v))));
        }
        std::vector<uint32_t> ring(p.verts.size());
        for (uint32_t i = 0; i < ring.size(); ++i) ring[i] = i;
        auto minSin = [&](uint32_t a, uint32_t b, uint32_t c) {
            const D3 &A = p.verts[a].p, &B = p.verts[b].p, &C = p.verts[c].p;
            const double area2 = (B - A).cross(C - A).dot(p.plane.n);
            if (area2 <= 0) return -1.0;
            const double ab = (B - A).length(), bc = (C - B).length(), ca = (A - C).length();
            return area2 / std::max({ab * bc, bc * ca, ca * ab});   // sine of the triangle's smallest angle
        };
        // an ear may not hold another corner, on its cut side either (a corner there would be left on a flat remainder)
        auto coversCorner = [&](uint32_t a, uint32_t b, uint32_t c) {
            const D3 &A = p.verts[a].p, &B = p.verts[b].p, &C = p.verts[c].p;
            const double area2 = (B - A).cross(C - A).dot(p.plane.n), tol = 1e-12 * std::max(1.0, area2);
            for (uint32_t k : ring) {
                if (k == a || k == b || k == c) continue;
                const D3& P = p.verts[k].p;
                const double w0 = (B - A).cross(P - A).dot(p.plane.n), w1 = (C - B).cross(P - B).dot(p.plane.n), w2 = (A - C).cross(P - C).dot(p.plane.n);
                if (w0 >= -tol && w1 >= -tol && w2 >= -tol) return true;
            }
            return false;
        };
        while (ring.size() > 3) {
            size_t best = ring.size();
            double bestQ = 1e-9;
            for (size_t i = 0; i < ring.size(); ++i) {
                const uint32_t a = ring[(i + ring.size() - 1) % ring.size()], b = ring[i], c = ring[(i + 1) % ring.size()];
                const double q = minSin(a, b, c);
                if (q <= bestQ || coversCorner(a, b, c)) continue;
                bestQ = q; best = i;
            }
            if (best == ring.size()) break;   // what is left is flat (all on a line): it covers nothing
            m.addTriangle(base + ring[(best + ring.size() - 1) % ring.size()], base + ring[best], base + ring[(best + 1) % ring.size()]);
            ring.erase(ring.begin() + static_cast<std::ptrdiff_t>(best));
        }
        if (ring.size() == 3 && minSin(ring[0], ring[1], ring[2]) > 0) m.addTriangle(base + ring[0], base + ring[1], base + ring[2]);
    }
    return m;
}

// ============================================================================
// Operand solids (measurements, in metres)
// ============================================================================

/** An orthonormal frame whose third axis is n. */
inline void frameFor(const D3& n, D3& t, D3& b) {
    const D3 helper = std::abs(n.y) < 0.9 ? D3{0, 1, 0} : D3{1, 0, 0};
    t = helper.cross(n); t = t * (1.0 / t.length());
    b = n.cross(t);
}

/** A box: centre, full size along its own axes ax, ay, az (orthonormal). */
inline std::vector<CsgPolygon> boxPolygons(const D3& c, const D3& size, const D3& ax, const D3& ay, const D3& az) {
    const D3 hx = ax * (size.x / 2), hy = ay * (size.y / 2), hz = az * (size.z / 2);
    auto corner = [&](int i) { return c + hx * ((i & 1) ? 1.0 : -1.0) + hy * ((i & 2) ? 1.0 : -1.0) + hz * ((i & 4) ? 1.0 : -1.0); };
    // faces wound counter-clockwise seen from outside
    const int faces[6][4] = {{0, 4, 6, 2}, {1, 3, 7, 5}, {0, 1, 5, 4}, {2, 6, 7, 3}, {0, 2, 3, 1}, {4, 5, 7, 6}};
    std::vector<CsgPolygon> out;
    for (const auto& f : faces) {
        std::vector<CsgVertex> vs;
        for (int k = 0; k < 4; ++k) vs.push_back({corner(f[k]), (k == 1 || k == 2) ? 1.0 : 0.0, (k >= 2) ? 1.0 : 0.0});
        CsgPolygon p;
        if (makePolygon(std::move(vs), p)) out.push_back(std::move(p));
    }
    return out;
}

/** Rotation by Euler angles in degrees, applied X then Y then Z, as the box's axes. */
inline void eulerAxes(const D3& deg, D3& ax, D3& ay, D3& az) {
    const double k = M_PI / 180.0;
    const double cx = std::cos(deg.x * k), sx = std::sin(deg.x * k), cy = std::cos(deg.y * k), sy = std::sin(deg.y * k), cz = std::cos(deg.z * k), sz = std::sin(deg.z * k);
    // R = Rz * Ry * Rx; its columns are the rotated axes
    ax = {cz * cy, sz * cy, -sy};
    ay = {cz * sy * sx - sz * cx, sz * sy * sx + cz * cx, cy * sx};
    az = {cz * sy * cx + sz * sx, sz * sy * cx - cz * sx, cy * cx};
}

/** A cylinder between two end points; segments around (>= 3). */
inline std::vector<CsgPolygon> cylinderPolygons(const D3& start, const D3& end, double radius, int segments) {
    const D3 axis = end - start;
    const double len = axis.length();
    if (!(len > 0) || !(radius > 0) || segments < 3) throw MeshEditError("a cylinder needs distinct start and end, radius > 0 and segments >= 3");
    const D3 n = axis * (1.0 / len);
    D3 t, b;
    frameFor(n, t, b);
    std::vector<D3> ring(segments);
    for (int i = 0; i < segments; ++i) {
        const double a = 2 * M_PI * i / segments;
        ring[i] = t * (std::cos(a) * radius) + b * (std::sin(a) * radius);
    }
    std::vector<CsgPolygon> out;
    auto push = [&](std::vector<CsgVertex> vs) { CsgPolygon p; if (makePolygon(std::move(vs), p)) out.push_back(std::move(p)); };
    for (int i = 0; i < segments; ++i) {
        const int j = (i + 1) % segments;
        const double u0 = double(i) / segments, u1 = double(i + 1) / segments;
        push({{start + ring[i], u0, 0}, {start + ring[j], u1, 0}, {end + ring[j], u1, 1}, {end + ring[i], u0, 1}});
    }
    std::vector<CsgVertex> top, bottom;
    for (int i = 0; i < segments; ++i) top.push_back({end + ring[i], 0, 0});
    for (int i = segments - 1; i >= 0; --i) bottom.push_back({start + ring[i], 0, 0});
    push(std::move(top));
    push(std::move(bottom));
    return out;
}

/** A sphere of latitude/longitude quads; segments around (>= 3), half as many rings. */
inline std::vector<CsgPolygon> spherePolygons(const D3& c, double radius, int segments) {
    if (!(radius > 0) || segments < 3) throw MeshEditError("a sphere needs radius > 0 and segments >= 3");
    const int rings = std::max(2, segments / 2);
    auto at = [&](int i, int j) {
        const double th = 2 * M_PI * i / segments, ph = M_PI * j / rings;
        return CsgVertex{c + D3{std::cos(th) * std::sin(ph), std::cos(ph), std::sin(th) * std::sin(ph)} * radius, double(i) / segments, double(j) / rings};
    };
    std::vector<CsgPolygon> out;
    for (int i = 0; i < segments; ++i) for (int j = 0; j < rings; ++j) {
        std::vector<CsgVertex> vs{at(i, j)};
        if (j > 0) vs.push_back(at(i + 1, j));
        vs.push_back(at(i + 1, j + 1));
        if (j < rings - 1) vs.push_back(at(i, j + 1));
        if (j == rings - 1) vs = {at(i, j), at(i + 1, j), at(i, j + 1)};
        CsgPolygon p;
        if (makePolygon(std::move(vs), p)) {
            // wind outward
            const D3 centroid = p.verts[0].p;
            if (p.plane.n.dot(centroid - c) < 0) p.flip();
            out.push_back(std::move(p));
        }
    }
    return out;
}


/** Everything on the side the plane's normal points to removed and the section capped (a subtract with a box on the plane larger than the mesh). */
inline std::vector<CsgPolygon> cutPolygons(std::vector<CsgPolygon> a, const D3& point, const D3& normal, double eps) {
    const double len = normal.length();
    if (!(len > 0)) throw MeshEditError("a cut needs a non-zero normal");
    const D3 n = normal * (1.0 / len);
    const DBox ba = boxOf(a);
    const D3 centre = (ba.lo + ba.hi) * 0.5;
    const double s = std::max((ba.hi - ba.lo).length(), 1e-3) * 1.1;
    const D3 onPlane = centre - n * n.dot(centre - point);
    D3 t, b;
    frameFor(n, t, b);
    return booleanPolygons(std::move(a), boxPolygons(onPlane + n * (s / 2), {s, s, s}, t, b, n), BooleanOp::Subtract, eps);
}

// ============================================================================
// Welding, selection, extrude / inset, crease normals
// ============================================================================

/** Vertex ids merged by position (within tol), one per distinct point. */
inline std::vector<uint32_t> weldIds(const ScratchboxMesh& m, float tol, uint32_t* count = nullptr) {
    struct K { int64_t x, y, z; bool operator==(const K& o) const { return x == o.x && y == o.y && z == o.z; } };
    struct H { size_t operator()(const K& k) const { return std::hash<int64_t>()(k.x * 73856093 ^ k.y * 19349663 ^ k.z * 83492791); } };
    std::unordered_map<K, uint32_t, H> map;
    std::vector<uint32_t> ids(m.vertices.size());
    const double inv = 1.0 / std::max(tol, 1e-9f);
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const Vec3& p = m.vertices[i].position;
        const K k{std::llround(p.x * inv), std::llround(p.y * inv), std::llround(p.z * inv)};
        auto it = map.find(k);
        if (it == map.end()) it = map.emplace(k, static_cast<uint32_t>(map.size())).first;
        ids[i] = it->second;
    }
    if (count) *count = static_cast<uint32_t>(map.size());
    return ids;
}

inline Vec3 faceNormal(const ScratchboxMesh& m, size_t f, float* area = nullptr) {
    const Vec3& a = m.vertices[m.indices[3 * f]].position;
    const Vec3 c = (m.vertices[m.indices[3 * f + 1]].position - a).cross(m.vertices[m.indices[3 * f + 2]].position - a);
    const float len = c.length();
    if (area) *area = len / 2;
    return len > 0 ? c * (1.0f / len) : Vec3(0, 0, 0);
}

struct FaceSelection {
    bool hasDirection = false;
    Vec3 direction;            // faces whose normal is within coneDeg of this
    float coneDeg = 30.0f;
    bool hasRegion = false;
    Vec3 regionMin, regionMax; // face centroids inside this box, as fractions of the mesh's bounds
};

/** Faces matching every criterion given (none given selects nothing; a selection is always explicit). */
inline std::vector<uint8_t> selectFaces(const ScratchboxMesh& m, const FaceSelection& s) {
    if (!s.hasDirection && !s.hasRegion) throw MeshEditError("a selection needs a direction (with coneDeg) or a region");
    const size_t faces = m.indices.size() / 3;
    std::vector<uint8_t> sel(faces, 0);
    AABB box;
    for (const auto& v : m.vertices) box.expand(v.position);
    const Vec3 size = box.max - box.min;
    const Vec3 dir = s.hasDirection ? s.direction.normalized() : Vec3(0, 0, 0);
    const float cosCone = std::cos(std::clamp(s.coneDeg, 0.0f, 180.0f) * static_cast<float>(M_PI) / 180.0f);
    for (size_t f = 0; f < faces; ++f) {
        float area = 0;
        const Vec3 n = faceNormal(m, f, &area);
        if (!(area > 0)) continue;
        if (s.hasDirection && n.dot(dir) < cosCone - 1e-5f) continue;
        if (s.hasRegion) {
            const Vec3 c = (m.vertices[m.indices[3 * f]].position + m.vertices[m.indices[3 * f + 1]].position + m.vertices[m.indices[3 * f + 2]].position) * (1.0f / 3.0f);
            auto frac = [](float v, float lo, float ext) { return ext > 0 ? (v - lo) / ext : 0.5f; };
            const Vec3 u(frac(c.x, box.min.x, size.x), frac(c.y, box.min.y, size.y), frac(c.z, box.min.z, size.z));
            const float e = 1e-4f;
            if (u.x < s.regionMin.x - e || u.x > s.regionMax.x + e || u.y < s.regionMin.y - e || u.y > s.regionMax.y + e || u.z < s.regionMin.z - e || u.z > s.regionMax.z + e) continue;
        }
        sel[f] = 1;
    }
    return sel;
}

struct ExtrudeStats { uint32_t selectedFaces = 0; uint32_t boundaryEdges = 0; uint32_t sideTriangles = 0; };

/**
 * The selected faces moved by distance along their (area-weighted, per point) normals and their boundary pulled inward
 * by inset inside their own plane, joined to the faces around them by side walls. inset alone is an inset; distance
 * alone an extrude (negative pushes in); both together the usual inset-then-extrude.
 */
inline ExtrudeStats extrudeFaces(ScratchboxMesh& m, const std::vector<uint8_t>& sel, float distance, float inset, float weldTol) {
    if (!(std::abs(distance) > 0) && !(inset > 0)) throw MeshEditError("extrude needs a non-zero distance or an inset > 0");
    if (inset < 0) throw MeshEditError("inset must be >= 0");
    ExtrudeStats st;
    uint32_t points = 0;
    const std::vector<uint32_t> wid = weldIds(m, weldTol, &points);
    const size_t faces = m.indices.size() / 3;
    std::vector<Vec3> pn(points, Vec3(0, 0, 0));
    std::vector<int64_t> rep(points, -1);
    // directed edges of the selection, by welded point
    std::unordered_map<uint64_t, uint32_t> edges;
    auto key = [](uint32_t a, uint32_t b) { return (uint64_t(a) << 32) | b; };
    for (size_t f = 0; f < faces; ++f) {
        if (!sel[f]) continue;
        ++st.selectedFaces;
        float area = 0;
        const Vec3 n = faceNormal(m, f, &area);
        for (int k = 0; k < 3; ++k) {
            const uint32_t v = m.indices[3 * f + k], a = wid[v], b = wid[m.indices[3 * f + (k + 1) % 3]];
            pn[a] += n * area;
            if (rep[a] < 0) rep[a] = v;
            edges[key(a, b)] = m.indices[3 * f + (k + 1) % 3];
        }
    }
    if (st.selectedFaces == 0) throw MeshEditError("the selection matched no faces");
    // boundary: a selected edge whose reverse is not selected
    std::vector<std::pair<uint32_t, uint32_t>> boundary;
    for (const auto& [k, _] : edges) {
        const uint32_t a = uint32_t(k >> 32), b = uint32_t(k & 0xffffffffu);
        if (!edges.count(key(b, a))) boundary.emplace_back(a, b);
    }
    st.boundaryEdges = static_cast<uint32_t>(boundary.size());
    for (auto& n : pn) n = n.length() > 0 ? n.normalized() : n;
    // inset: each boundary point moves along the bisector of its two boundary edges' inward directions
    std::vector<Vec3> move(points, Vec3(0, 0, 0));
    if (inset > 0) {
        std::unordered_map<uint32_t, uint32_t> nextOf, prevOf;
        for (const auto& [a, b] : boundary) { nextOf[a] = b; prevOf[b] = a; }
        for (const auto& [v, w] : nextOf) {
            auto pit = prevOf.find(v);
            if (pit == prevOf.end()) continue;
            const Vec3 P = m.vertices[rep[v]].position;
            const Vec3 e1 = (P - m.vertices[rep[pit->second]].position).normalized(), e2 = (m.vertices[rep[w]].position - P).normalized();
            const Vec3 n = pn[v];
            const Vec3 l1 = n.cross(e1).normalized(), l2 = n.cross(e2).normalized();
            Vec3 bis = l1 + l2;
            if (bis.length() < 1e-6f) bis = l1;
            bis = bis.normalized();
            move[v] = bis * (inset / std::max(0.2f, bis.dot(l1)));
        }
        // a point in the middle of a straight side keeps its place along the side between the inset corners either end
        auto straight = [&](uint32_t v) {
            auto pit = prevOf.find(v); auto nit = nextOf.find(v);
            if (pit == prevOf.end() || nit == nextOf.end()) return false;
            const Vec3 P = m.vertices[rep[v]].position;
            return (P - m.vertices[rep[pit->second]].position).normalized().dot((m.vertices[rep[nit->second]].position - P).normalized()) > 1.0f - 1e-6f;
        };
        std::vector<Vec3> fixedMove = move;
        for (const auto& [v, _] : nextOf) {
            if (!straight(v)) continue;
            uint32_t a = v, b = v;
            size_t guard = 0;
            while (straight(a) && guard++ < nextOf.size()) a = prevOf[a];
            guard = 0;
            while (straight(b) && guard++ < nextOf.size()) b = nextOf[b];
            if (a == v || b == v || straight(a) || straight(b)) continue;
            const Vec3 A = m.vertices[rep[a]].position, B = m.vertices[rep[b]].position, P = m.vertices[rep[v]].position;
            const float len2 = (B - A).dot(B - A);
            if (!(len2 > 0)) continue;
            const float t = (P - A).dot(B - A) / len2;
            const Vec3 A2 = A + move[a], B2 = B + move[b];
            fixedMove[v] = A2 + (B2 - A2) * t - P;
        }
        move = std::move(fixedMove);
    }
    // new points for every selected point
    std::vector<int64_t> moved(points, -1);
    for (uint32_t p = 0; p < points; ++p) {
        if (rep[p] < 0) continue;
        Vertex v = m.vertices[rep[p]];
        v.position = v.position + move[p] + pn[p] * distance;
        moved[p] = m.vertices.size();
        m.addVertex(v);
    }
    // selected faces onto the new points (a seam's own uv is kept by copying that corner's vertex)
    for (size_t f = 0; f < faces; ++f) {
        if (!sel[f]) continue;
        for (int k = 0; k < 3; ++k) {
            const uint32_t v = m.indices[3 * f + k], p = wid[v];
            if (rep[p] == int64_t(v)) { m.indices[3 * f + k] = uint32_t(moved[p]); continue; }
            Vertex c = m.vertices[v];
            c.position = m.vertices[moved[p]].position;
            m.indices[3 * f + k] = static_cast<uint32_t>(m.vertices.size());
            m.addVertex(c);
        }
    }
    // side walls on the boundary, wound outward
    for (const auto& [a, b] : boundary) {
        const uint32_t A = uint32_t(rep[a]), B = uint32_t(rep[b]), A2 = uint32_t(moved[a]), B2 = uint32_t(moved[b]);
        // facing out of a raised region and into a sunk one alike: the moved edge's side flips with the move
        m.addTriangle(A, B, B2); m.addTriangle(A, B2, A2);
        st.sideTriangles += 2;
    }
    return st;
}

/**
 * Every triangle given its own corners, each corner's normal the area-weighted mean of the faces at that point whose
 * normal is within creaseDeg of the corner's face: smooth across shallow edges, hard across sharp ones.
 */
inline void creaseNormals(ScratchboxMesh& m, float creaseDeg, float weldTol) {
    const size_t faces = m.indices.size() / 3;
    ScratchboxMesh out(m.name);
    out.material = m.material;
    for (size_t f = 0; f < faces; ++f) for (int k = 0; k < 3; ++k) {
        out.addVertex(m.vertices[m.indices[3 * f + k]]);
    }
    for (uint32_t i = 0; i < out.vertices.size(); ++i) out.indices.push_back(i);
    uint32_t points = 0;
    const std::vector<uint32_t> wid = weldIds(out, weldTol, &points);
    std::vector<Vec3> fn(faces);
    std::vector<float> fa(faces);
    for (size_t f = 0; f < faces; ++f) fn[f] = faceNormal(out, f, &fa[f]);
    std::vector<std::vector<uint32_t>> at(points);
    for (size_t f = 0; f < faces; ++f) for (int k = 0; k < 3; ++k) at[wid[3 * f + k]].push_back(static_cast<uint32_t>(f));
    const float c = std::cos(creaseDeg * static_cast<float>(M_PI) / 180.0f);
    for (size_t f = 0; f < faces; ++f) for (int k = 0; k < 3; ++k) {
        Vec3 n(0, 0, 0);
        for (uint32_t g : at[wid[3 * f + k]]) if (fn[g].dot(fn[f]) >= c) n += fn[g] * fa[g];
        out.vertices[3 * f + k].normal = n.length() > 0 ? n.normalized() : fn[f];
    }
    out.recomputeBounds();
    m = std::move(out);
}

inline uint32_t openEdges(const ScratchboxMesh& m, float tol) {
    const std::vector<uint32_t> wid = weldIds(m, tol);
    std::unordered_map<uint64_t, int> count;
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) for (int k = 0; k < 3; ++k) {
        uint32_t a = wid[m.indices[i + k]], b = wid[m.indices[i + (k + 1) % 3]];
        if (a == b) continue;
        count[(uint64_t(std::min(a, b)) << 32) | std::max(a, b)]++;
    }
    uint32_t open = 0;
    for (const auto& [_, c] : count) if (c == 1) ++open;
    return open;
}

/** Triangles with no area removed (a boolean's slivers); their vertices stay until the mesh is re-cornered. */
inline uint32_t dropDegenerate(ScratchboxMesh& m, float minArea) {
    std::vector<uint32_t> keep;
    uint32_t dropped = 0;
    for (size_t f = 0; f < m.indices.size() / 3; ++f) {
        float area = 0;
        faceNormal(m, f, &area);
        if (area > minArea) keep.insert(keep.end(), m.indices.begin() + 3 * f, m.indices.begin() + 3 * f + 3);
        else ++dropped;
    }
    m.indices = std::move(keep);
    return dropped;
}

} // namespace mesh_edit
} // namespace scratchbox
