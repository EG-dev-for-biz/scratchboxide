/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * More modelling edits on a given mesh, on its welded form (one point per position, triangles by point):
 * - shell: a solid hollowed, or a surface given a wall, at a measured thickness (corners mitred so the wall keeps it);
 * - mirror and array: copies reflected, along an offset or around an axis;
 * - sweep: a profile swept along a path with parallel-transport frames, capped, as a solid to add;
 * - clean / decimate: edges collapsed while the shape stays the same (clean) or within a measured error (decimate),
 *   never pinching the surface (the link condition) or flipping a face;
 * - fracture: Voronoi cells around seeded points, each intersected with the mesh;
 * - subdivide, smooth and relief on a selection: long edges split where both neighbours see the split (so the surface
 *   stays closed), points inside the selection smoothed (Taubin) or moved along their normals by a periodic profile
 *   with noise; the selection's border never moves;
 * - inspect: bounds, area, volume, closedness, sharp edges and the planar face groups, for choosing the next edit.
 */

#pragma once

#include "scratchbox_mesh_edit.hpp"
#include <array>
#include <queue>
#include <set>
#include <sstream>
#include <random>

namespace scratchbox {
namespace mesh_edit {

struct WMesh {
    std::vector<D3> p;
    std::vector<std::array<uint32_t, 3>> t;
};

inline D3 toD3(const Vec3& v) { return {v.x, v.y, v.z}; }
inline Vec3 toV3(const D3& v) { return Vec3(float(v.x), float(v.y), float(v.z)); }

inline WMesh toWelded(const ScratchboxMesh& m, float tol) {
    uint32_t points = 0;
    const std::vector<uint32_t> wid = weldIds(m, tol, &points);
    WMesh w;
    w.p.resize(points);
    for (size_t i = 0; i < m.vertices.size(); ++i) w.p[wid[i]] = toD3(m.vertices[i].position);
    for (size_t i = 0; i + 2 < m.indices.size(); i += 3) {
        const std::array<uint32_t, 3> f{wid[m.indices[i]], wid[m.indices[i + 1]], wid[m.indices[i + 2]]};
        if (f[0] != f[1] && f[1] != f[2] && f[0] != f[2]) w.t.push_back(f);
    }
    return w;
}

inline ScratchboxMesh fromWelded(const WMesh& w, const ScratchboxMesh& like) {
    ScratchboxMesh m(like.name);
    m.material = like.material;
    for (const auto& p : w.p) m.addVertex(Vertex(toV3(p)));
    for (const auto& f : w.t) m.addTriangle(f[0], f[1], f[2]);
    return m;
}

inline D3 triNormal(const WMesh& w, const std::array<uint32_t, 3>& f, double* area = nullptr) {
    const D3 c = (w.p[f[1]] - w.p[f[0]]).cross(w.p[f[2]] - w.p[f[0]]);
    const double len = c.length();
    if (area) *area = len / 2;
    return len > 0 ? c * (1.0 / len) : D3{0, 0, 0};
}

inline double signedVolume(const WMesh& w) {
    double v = 0;
    for (const auto& f : w.t) v += w.p[f[0]].dot(w.p[f[1]].cross(w.p[f[2]])) / 6;
    return v;
}

inline uint64_t ekey(uint32_t a, uint32_t b) { return (uint64_t(std::min(a, b)) << 32) | std::max(a, b); }

// ============================================================================
// Shell
// ============================================================================

/**
 * The surface offset by thickness against its normals (inward; negative = outward) into a second wall facing the other
 * way; on an open surface the two walls are joined along its border. Each point moves to where it is thickness behind
 * every plane it touches (least squares, so flat points move straight in and corners to the offset corner; capped at
 * 4x the thickness at very sharp points).
 */
inline WMesh shellMesh(const WMesh& w, double thickness) {
    if (thickness == 0) throw MeshEditError("shell needs a non-zero thickness");
    const size_t n = w.p.size();
    std::vector<std::vector<D3>> fn(n);
    for (const auto& f : w.t) {
        double a = 0;
        const D3 nn = triNormal(w, f, &a);
        if (!(a > 0)) continue;
        for (uint32_t v : f) fn[v].push_back(nn);
    }
    WMesh out = w;
    const uint32_t base = uint32_t(n);
    for (size_t v = 0; v < n; ++v) {
        // the move d that puts the point thickness behind every distinct plane it touches: least squares on
        // (sum n n^T + tiny I) d = sum n * thickness, so a corner of three planes goes to their offset corner exactly
        std::vector<D3> planes;
        for (const auto& nn : fn[v]) {
            bool dup = false;
            for (const auto& q : planes) if (q.dot(nn) > 1 - 1e-6) { dup = true; break; }
            if (!dup) planes.push_back(nn);
        }
        double A[3][3] = {{1e-9, 0, 0}, {0, 1e-9, 0}, {0, 0, 1e-9}}, r[3] = {0, 0, 0};
        for (const auto& q : planes) {
            const double c[3] = {q.x, q.y, q.z};
            for (int i = 0; i < 3; ++i) { r[i] += c[i] * thickness; for (int j = 0; j < 3; ++j) A[i][j] += c[i] * c[j]; }
        }
        const double det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
        D3 d{0, 0, 0};
        if (std::abs(det) > 0) {
            auto col = [&](int k) {   // Cramer's rule
                double M[3][3];
                for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) M[i][j] = j == k ? r[i] : A[i][j];
                return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det;
            };
            d = {col(0), col(1), col(2)};
        }
        // very sharp points would run far: no further than 4x the thickness
        const double len = d.length(), cap = 4 * std::abs(thickness);
        if (len > cap) d = d * (cap / len);
        out.p.push_back(w.p[v] - d);
    }
    for (const auto& f : w.t) out.t.push_back({f[0] + base, f[2] + base, f[1] + base});
    // border of an open surface: each edge used once gets a wall between the two sheets
    std::unordered_map<uint64_t, int> uses;
    for (const auto& f : w.t) for (int k = 0; k < 3; ++k) uses[ekey(f[k], f[(k + 1) % 3])]++;
    for (const auto& f : w.t) for (int k = 0; k < 3; ++k) {
        const uint32_t a = f[k], b = f[(k + 1) % 3];
        if (uses[ekey(a, b)] != 1) continue;
        out.t.push_back({b, a, a + base});
        out.t.push_back({b, a + base, b + base});
    }
    return out;
}

// ============================================================================
// Mirror and array
// ============================================================================

inline WMesh mirrorMesh(const WMesh& w, const D3& point, const D3& normal) {
    const double len = normal.length();
    if (!(len > 0)) throw MeshEditError("mirror needs a non-zero normal");
    const D3 n = normal * (1.0 / len);
    WMesh out;
    for (const auto& p : w.p) out.p.push_back(p - n * (2 * n.dot(p - point)));
    for (const auto& f : w.t) out.t.push_back({f[0], f[2], f[1]});   // a reflection turns the winding inside out
    return out;
}

/** Rodrigues rotation of p about the axis through c with unit direction k by angle a. */
inline D3 rotateAbout(const D3& p, const D3& c, const D3& k, double a) {
    const D3 v = p - c;
    return c + v * std::cos(a) + k.cross(v) * std::sin(a) + k * (k.dot(v) * (1 - std::cos(a)));
}

/** count copies (the original first), each moved by offset and turned by stepDeg about the axis from the one before. */
inline std::vector<WMesh> arrayCopies(const WMesh& w, int count, const D3& offset, const D3& axisPoint, const D3& axisDir, double stepDeg) {
    if (count < 2 || count > 1000) throw MeshEditError("array needs count 2..1000");
    const double klen = axisDir.length();
    if (stepDeg != 0 && !(klen > 0)) throw MeshEditError("array with stepDeg needs an axisDir");
    const D3 k = klen > 0 ? axisDir * (1.0 / klen) : D3{0, 0, 1};
    std::vector<WMesh> out;
    for (int i = 0; i < count; ++i) {
        WMesh c = w;
        for (auto& p : c.p) p = rotateAbout(p, axisPoint, k, stepDeg * M_PI / 180.0 * i) + offset * double(i);
        out.push_back(std::move(c));
    }
    return out;
}

inline std::vector<CsgPolygon> weldedToPolygons(const WMesh& w) {
    std::vector<CsgPolygon> out;
    for (const auto& f : w.t) {
        CsgPolygon p;
        if (makePolygon({{w.p[f[0]], 0, 0}, {w.p[f[1]], 0, 0}, {w.p[f[2]], 0, 0}}, p)) out.push_back(std::move(p));
    }
    return out;
}

// ============================================================================
// Sweep
// ============================================================================

/**
 * profile (points [u, v] in the plane across the path, counter-clockwise) swept along path with parallel-transport
 * frames, scaled along the way from scaleStart to scaleEnd and twisted by twistDeg in all, capped at both ends, as
 * outward-facing polygons.
 */
inline std::vector<CsgPolygon> sweepPolygons(const std::vector<D3>& path, std::vector<std::array<double, 2>> profile,
                                             double scaleStart, double scaleEnd, double twistDeg) {
    if (path.size() < 2) throw MeshEditError("sweep needs a path of at least 2 points");
    if (profile.size() < 3) throw MeshEditError("sweep needs a profile of at least 3 points (or a radius)");
    double area2 = 0;
    for (size_t i = 0; i < profile.size(); ++i) {
        const auto& a = profile[i]; const auto& b = profile[(i + 1) % profile.size()];
        area2 += a[0] * b[1] - b[0] * a[1];
    }
    if (std::abs(area2) < 1e-18) throw MeshEditError("sweep profile has no area");
    if (area2 < 0) std::reverse(profile.begin(), profile.end());
    const size_t N = path.size(), M = profile.size();
    std::vector<D3> T(N);
    for (size_t i = 0; i < N; ++i) {
        D3 d = path[std::min(i + 1, N - 1)] - path[i == 0 ? 0 : i - 1];
        const double l = d.length();
        if (!(l > 0)) throw MeshEditError("sweep path has repeated points");
        T[i] = d * (1.0 / l);
    }
    D3 U, V;
    frameFor(T[0], U, V);
    std::vector<std::vector<D3>> rings(N);
    double length = 0, along = 0;
    for (size_t i = 1; i < N; ++i) length += (path[i] - path[i - 1]).length();
    for (size_t i = 0; i < N; ++i) {
        if (i > 0) {
            along += (path[i] - path[i - 1]).length();
            // parallel transport: rotate the frame by the turn from the last tangent to this one
            const D3 axis = T[i - 1].cross(T[i]);
            const double s = axis.length(), c = std::clamp(T[i - 1].dot(T[i]), -1.0, 1.0);
            if (s > 1e-12) {
                const D3 k = axis * (1.0 / s);
                const double a = std::atan2(s, c);
                U = rotateAbout(U, {0, 0, 0}, k, a); V = rotateAbout(V, {0, 0, 0}, k, a);
            }
        }
        const double t = length > 0 ? along / length : 0;
        const double sc = scaleStart + (scaleEnd - scaleStart) * t, tw = twistDeg * M_PI / 180.0 * t;
        const D3 u = U * std::cos(tw) + V * std::sin(tw), v = V * std::cos(tw) - U * std::sin(tw);
        for (const auto& q : profile) rings[i].push_back(path[i] + (u * q[0] + v * q[1]) * sc);
    }
    std::vector<CsgPolygon> out;
    auto push = [&](std::vector<CsgVertex> vs) { CsgPolygon p; if (makePolygon(std::move(vs), p)) out.push_back(std::move(p)); };
    for (size_t i = 0; i + 1 < N; ++i) for (size_t j = 0; j < M; ++j) {
        const size_t k = (j + 1) % M;
        push({{rings[i][j], 0, 0}, {rings[i][k], 0, 0}, {rings[i + 1][k], 0, 0}});
        push({{rings[i][j], 0, 0}, {rings[i + 1][k], 0, 0}, {rings[i + 1][j], 0, 0}});
    }
    std::vector<CsgVertex> start, end;
    for (size_t j = 0; j < M; ++j) end.push_back({rings[N - 1][j], 0, 0});
    for (size_t j = M; j-- > 0;) start.push_back({rings[0][j], 0, 0});
    push(std::move(start));
    push(std::move(end));
    // the profile's winding against the frame decides which way the sides face: turn the whole solid outward
    double vol = 0;
    for (const auto& p : out) for (size_t k = 1; k + 1 < p.verts.size(); ++k) vol += p.verts[0].p.dot(p.verts[k].p.cross(p.verts[k + 1].p));
    if (vol < 0) for (auto& p : out) p.flip();
    return out;
}

// ============================================================================
// Clean and decimate (edge collapse)
// ============================================================================

struct Quadric {
    double a[10] = {0};   // symmetric 4x4, upper triangle
    void addPlane(const D3& n, double d, double w) {
        const double v[4] = {n.x, n.y, n.z, d};
        int k = 0;
        for (int i = 0; i < 4; ++i) for (int j = i; j < 4; ++j) a[k++] += w * v[i] * v[j];
    }
    void add(const Quadric& q) { for (int i = 0; i < 10; ++i) a[i] += q.a[i]; }
    double eval(const D3& p) const {
        const double v[4] = {p.x, p.y, p.z, 1};
        double s = 0; int k = 0;
        for (int i = 0; i < 4; ++i) for (int j = i; j < 4; ++j) { s += (i == j ? 1 : 2) * a[k++] * v[i] * v[j]; }
        return s;
    }
};

struct CollapseStats { uint32_t before = 0, after = 0, collapsed = 0; double maxError = 0; };

/**
 * Edges collapsed (one end moved onto the other, so corners stay where they were) in order of the squared distance the
 * move puts the surface from its original planes, while that error is at most maxErrorM squared and the mesh has more
 * than targetTriangles. A collapse is refused when it would join two sheets (the ends share more neighbours than the
 * edge's own two), flip a face, or leave one with no area. maxErrorM tiny = clean: only points that add nothing
 * (inside a flat face or along a straight edge) go.
 */
inline CollapseStats collapseEdges(WMesh& w, double maxErrorM, size_t targetTriangles) {
    CollapseStats st;
    st.before = uint32_t(w.t.size());
    const size_t n = w.p.size();
    std::vector<Quadric> Q(n);
    std::vector<std::vector<uint32_t>> vt(n);
    std::vector<uint8_t> dead(w.t.size(), 0);
    for (uint32_t f = 0; f < w.t.size(); ++f) {
        double a = 0;
        const D3 nn = triNormal(w, w.t[f], &a);
        if (!(a > 0)) continue;
        // unweighted, so the cost is a sum of squared distances (metres squared) to the planes the point touched
        for (uint32_t v : w.t[f]) { Q[v].addPlane(nn, -nn.dot(w.p[w.t[f][0]]), 1.0); vt[v].push_back(f); }
    }
    // border edges (used once) pin their points across the border too
    std::unordered_map<uint64_t, int> uses;
    for (const auto& f : w.t) for (int k = 0; k < 3; ++k) uses[ekey(f[k], f[(k + 1) % 3])]++;
    for (uint32_t f = 0; f < w.t.size(); ++f) for (int k = 0; k < 3; ++k) {
        const uint32_t a = w.t[f][k], b = w.t[f][(k + 1) % 3];
        if (uses[ekey(a, b)] != 1) continue;
        const D3 e = w.p[b] - w.p[a], fnn = triNormal(w, w.t[f]);
        D3 side = e.cross(fnn);
        const double l = side.length();
        if (!(l > 0)) continue;
        side = side * (1.0 / l);
        Q[a].addPlane(side, -side.dot(w.p[a]), 1.0); Q[b].addPlane(side, -side.dot(w.p[a]), 1.0);
    }
    struct Cand { double cost; uint32_t from, to; bool operator>(const Cand& o) const { return cost > o.cost; } };
    std::priority_queue<Cand, std::vector<Cand>, std::greater<Cand>> pq;
    auto costOf = [&](uint32_t from, uint32_t to) { Quadric q = Q[from]; q.add(Q[to]); return std::max(0.0, q.eval(w.p[to])); };
    auto pushEdge = [&](uint32_t a, uint32_t b) { pq.push({costOf(a, b), a, b}); pq.push({costOf(b, a), b, a}); };
    {
        std::set<uint64_t> seen;
        for (const auto& f : w.t) for (int k = 0; k < 3; ++k) if (seen.insert(ekey(f[k], f[(k + 1) % 3])).second) pushEdge(f[k], f[(k + 1) % 3]);
    }
    const double limit = maxErrorM * maxErrorM;
    size_t live = w.t.size();
    std::vector<uint32_t> gone(n, 0);
    auto neighbours = [&](uint32_t v) {
        std::set<uint32_t> s;
        for (uint32_t f : vt[v]) if (!dead[f]) for (uint32_t x : w.t[f]) if (x != v) s.insert(x);
        return s;
    };
    while (!pq.empty() && live > targetTriangles) {
        const Cand c = pq.top(); pq.pop();
        if (gone[c.from] || gone[c.to]) continue;
        const double cost = costOf(c.from, c.to);
        if (cost > c.cost * (1 + 1e-9) + 1e-30) { pq.push({cost, c.from, c.to}); continue; }   // stale
        if (cost > limit) break;
        // the edge must still exist
        std::vector<uint32_t> shared;
        for (uint32_t f : vt[c.from]) if (!dead[f] && (w.t[f][0] == c.to || w.t[f][1] == c.to || w.t[f][2] == c.to)) shared.push_back(f);
        if (shared.empty()) continue;
        // link condition: the ends' common neighbours are only the edge's opposite corners
        const auto na = neighbours(c.from), nb = neighbours(c.to);
        size_t common = 0;
        for (uint32_t x : na) if (nb.count(x)) ++common;
        if (common != shared.size()) continue;
        // no face around `from` may flip, collapse or turn away from its plane by more than the error allows
        bool ok = true;
        for (uint32_t f : vt[c.from]) {
            if (dead[f]) continue;
            const auto& t = w.t[f];
            if (t[0] == c.to || t[1] == c.to || t[2] == c.to) continue;
            std::array<D3, 3> q{w.p[t[0]], w.p[t[1]], w.p[t[2]]};
            const D3 before = (q[1] - q[0]).cross(q[2] - q[0]);
            for (int k = 0; k < 3; ++k) if (t[k] == c.from) q[k] = w.p[c.to];
            const D3 after = (q[1] - q[0]).cross(q[2] - q[0]);
            const double bl = before.length(), al = after.length();
            if (!(al > 1e-14 * std::max(1.0, bl)) || before.dot(after) <= 0.2 * bl * al) { ok = false; break; }
        }
        if (!ok) continue;
        for (uint32_t f : shared) { dead[f] = 1; --live; }
        for (uint32_t f : vt[c.from]) {
            if (dead[f]) continue;
            for (auto& x : w.t[f]) if (x == c.from) x = c.to;
            vt[c.to].push_back(f);
        }
        Q[c.to].add(Q[c.from]);
        gone[c.from] = 1;
        st.maxError = std::max(st.maxError, std::sqrt(cost));
        ++st.collapsed;
        for (uint32_t x : neighbours(c.to)) pushEdge(c.to, x);
    }
    WMesh out;
    std::vector<int64_t> remap(n, -1);
    for (uint32_t f = 0; f < w.t.size(); ++f) {
        if (dead[f]) continue;
        std::array<uint32_t, 3> t;
        for (int k = 0; k < 3; ++k) {
            const uint32_t v = w.t[f][k];
            if (remap[v] < 0) { remap[v] = int64_t(out.p.size()); out.p.push_back(w.p[v]); }
            t[k] = uint32_t(remap[v]);
        }
        out.t.push_back(t);
    }
    w = std::move(out);
    st.after = uint32_t(w.t.size());
    return st;
}

// ============================================================================
// Fracture
// ============================================================================

/** A convex solid (outward polygons) cut by a plane, keeping the side behind it and capping the section. */
inline std::vector<CsgPolygon> clipConvex(const std::vector<CsgPolygon>& polys, const D3& n, double d, double eps) {
    std::vector<CsgPolygon> out;
    std::vector<D3> section;
    for (const auto& p : polys) {
        std::vector<CsgVertex> keep;
        const size_t k = p.verts.size();
        for (size_t i = 0; i < k; ++i) {
            const CsgVertex& a = p.verts[i]; const CsgVertex& b = p.verts[(i + 1) % k];
            const double da = n.dot(a.p) - d, db = n.dot(b.p) - d;
            if (da <= eps) keep.push_back(a);
            if (std::abs(da) <= eps) section.push_back(a.p);
            if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
                const CsgVertex x = a.lerp(b, da / (da - db));
                keep.push_back(x); section.push_back(x.p);
            }
        }
        if (keep.size() >= 3) out.push_back(CsgPolygon{std::move(keep), p.plane});
    }
    if (section.size() >= 3) {
        D3 c{0, 0, 0};
        for (const auto& q : section) c = c + q;
        c = c * (1.0 / section.size());
        D3 u, v;
        frameFor(n, u, v);
        std::sort(section.begin(), section.end(), [&](const D3& a, const D3& b) {
            return std::atan2((a - c).dot(v), (a - c).dot(u)) > std::atan2((b - c).dot(v), (b - c).dot(u));   // clockwise seen along n: faces +n
        });
        std::vector<CsgVertex> cap;
        for (const auto& q : section) if (cap.empty() || (cap.back().p - q).length() > eps * 4) cap.push_back({q, 0, 0});
        while (cap.size() > 3 && (cap.front().p - cap.back().p).length() <= eps * 4) cap.pop_back();
        CsgPolygon p;
        if (makePolygon(cap, p)) { if (p.plane.n.dot(n) < 0) p.flip(); out.push_back(std::move(p)); }
    }
    return out;
}

struct FracturePiece { std::vector<CsgPolygon> polys; D3 seed; };

/**
 * The mesh broken into the Voronoi cells of `pieces` seeds: uniform in its bounds, or, with an impact point and a
 * spread (metres), drawn around it so pieces are small near it and large away. Each cell is the bounds box clipped by
 * the bisector planes to every other seed, intersected with the mesh. Seeded, so the same call breaks the same way.
 */
inline std::vector<FracturePiece> fractureMesh(const std::vector<CsgPolygon>& mesh, int pieces, uint32_t seed, bool hasImpact, const D3& impact, double spread, double eps) {
    if (pieces < 2 || pieces > 256) throw MeshEditError("fracture needs pieces 2..256");
    const DBox b = boxOf(mesh);
    const D3 ext = b.hi - b.lo;
    std::mt19937 rng(seed);
    std::uniform_real_distribution<double> U(0, 1);
    std::normal_distribution<double> G(0, 1);
    std::vector<D3> seeds;
    for (int i = 0; i < pieces * 50 && int(seeds.size()) < pieces; ++i) {
        D3 s = hasImpact ? impact + D3{G(rng), G(rng), G(rng)} * spread : b.lo + D3{U(rng) * ext.x, U(rng) * ext.y, U(rng) * ext.z};
        if (s.x < b.lo.x || s.y < b.lo.y || s.z < b.lo.z || s.x > b.hi.x || s.y > b.hi.y || s.z > b.hi.z) continue;
        bool close = false;
        for (const auto& q : seeds) if ((q - s).length() < 1e-6 * ext.length()) close = true;
        if (!close) seeds.push_back(s);
    }
    if (seeds.size() < 2) throw MeshEditError("fracture could not place seeds inside the mesh's bounds (an impact point outside them?)");
    const D3 pad = ext * 0.01 + D3{eps, eps, eps} * 10;
    const D3 centre = (b.lo + b.hi) * 0.5, size = ext + pad * 2;
    std::vector<FracturePiece> out;
    for (size_t i = 0; i < seeds.size(); ++i) {
        std::vector<CsgPolygon> cell = boxPolygons(centre, size, {1, 0, 0}, {0, 1, 0}, {0, 0, 1});
        for (size_t j = 0; j < seeds.size() && !cell.empty(); ++j) {
            if (j == i) continue;
            D3 n = seeds[j] - seeds[i];
            const double l = n.length();
            n = n * (1.0 / l);
            cell = clipConvex(cell, n, n.dot((seeds[i] + seeds[j]) * 0.5), eps);
        }
        if (cell.size() < 4) continue;
        std::vector<CsgPolygon> piece = booleanPolygons(mesh, std::move(cell), BooleanOp::Intersect, eps);
        if (!piece.empty()) out.push_back({std::move(piece), seeds[i]});
    }
    return out;
}

// ============================================================================
// Subdivide, smooth and relief on a selection
// ============================================================================

/** Faces whose normal is within coneDeg of direction and/or whose centre lies in the bounds-fraction box (welded form). */
inline std::vector<uint8_t> selectWelded(const WMesh& w, const FaceSelection& s) {
    ScratchboxMesh m;
    for (const auto& p : w.p) m.vertices.push_back(Vertex(toV3(p)));
    for (const auto& f : w.t) { m.indices.push_back(f[0]); m.indices.push_back(f[1]); m.indices.push_back(f[2]); }
    return selectFaces(m, s);
}

/**
 * Every edge of a selected face longer than maxLen split at its middle, in both faces that share it (so the surface
 * stays closed); new faces keep their parent's selection. Repeats until no such edge is left or the mesh reaches
 * maxTriangles.
 */
inline uint32_t splitLongEdges(WMesh& w, std::vector<uint8_t>& sel, double maxLen, size_t maxTriangles) {
    if (!(maxLen > 0)) throw MeshEditError("subdivide needs an edge length > 0");
    uint32_t splits = 0;
    for (int pass = 0; pass < 64; ++pass) {
        std::unordered_map<uint64_t, uint32_t> mid;
        std::unordered_map<uint64_t, bool> wanted;
        for (size_t f = 0; f < w.t.size(); ++f) {
            if (!sel[f]) continue;
            for (int k = 0; k < 3; ++k) {
                const uint32_t a = w.t[f][k], b = w.t[f][(k + 1) % 3];
                if ((w.p[a] - w.p[b]).length() > maxLen) wanted[ekey(a, b)] = true;
            }
        }
        if (wanted.empty()) break;
        if (w.t.size() + wanted.size() * 2 > maxTriangles) throw MeshEditError("subdividing to that edge length would pass " + std::to_string(maxTriangles) + " triangles; use a longer edge length or a smaller selection");
        for (const auto& [k, _] : wanted) {
            const uint32_t a = uint32_t(k >> 32), b = uint32_t(k & 0xffffffffu);
            mid[k] = uint32_t(w.p.size());
            w.p.push_back((w.p[a] + w.p[b]) * 0.5);
            ++splits;
        }
        std::vector<std::array<uint32_t, 3>> nt;
        std::vector<uint8_t> ns;
        for (size_t f = 0; f < w.t.size(); ++f) {
            const auto& t = w.t[f];
            int64_t m[3];
            int count = 0;
            for (int k = 0; k < 3; ++k) {
                auto it = mid.find(ekey(t[k], t[(k + 1) % 3]));
                m[k] = it == mid.end() ? -1 : int64_t(it->second);
                if (m[k] >= 0) ++count;
            }
            auto add = [&](uint32_t a, uint32_t b, uint32_t c) { nt.push_back({a, b, c}); ns.push_back(sel[f]); };
            if (count == 0) { add(t[0], t[1], t[2]); continue; }
            if (count == 3) {
                const uint32_t m0 = uint32_t(m[0]), m1 = uint32_t(m[1]), m2 = uint32_t(m[2]);
                add(t[0], m0, m2); add(m0, t[1], m1); add(m2, m1, t[2]); add(m0, m1, m2);
                continue;
            }
            // one or two split edges: rotate so edge 0 (t0-t1) is split, then fan
            int r = 0;
            while (m[r] < 0) ++r;
            const uint32_t A = t[r], B = t[(r + 1) % 3], C = t[(r + 2) % 3];
            const int64_t mAB = m[r], mBC = m[(r + 1) % 3], mCA = m[(r + 2) % 3];
            if (count == 1) { add(A, uint32_t(mAB), C); add(uint32_t(mAB), B, C); }
            else if (mBC >= 0) { add(A, uint32_t(mAB), C); add(uint32_t(mAB), B, uint32_t(mBC)); add(uint32_t(mAB), uint32_t(mBC), C); }
            else { add(A, uint32_t(mAB), uint32_t(mCA)); add(uint32_t(mAB), B, C); add(uint32_t(mAB), C, uint32_t(mCA)); }
        }
        w.t = std::move(nt);
        sel = std::move(ns);
    }
    return splits;
}

/** Points all of whose faces are selected (the selection's inside; its border stays put). */
inline std::vector<uint8_t> innerPoints(const WMesh& w, const std::vector<uint8_t>& sel) {
    std::vector<uint8_t> in(w.p.size(), 0), out(w.p.size(), 0);
    for (size_t f = 0; f < w.t.size(); ++f) for (uint32_t v : w.t[f]) (sel[f] ? in : out)[v] = 1;
    for (size_t v = 0; v < w.p.size(); ++v) in[v] = in[v] && !out[v];
    return in;
}

/** Taubin smoothing (shrink, then inflate) of the selection's inside: rounds without shrinking. */
inline uint32_t smoothSelection(WMesh& w, const std::vector<uint8_t>& sel, int iterations, double strength) {
    if (iterations < 1 || iterations > 200) throw MeshEditError("smooth needs iterations 1..200");
    const auto inner = innerPoints(w, sel);
    std::vector<std::set<uint32_t>> nb(w.p.size());
    for (const auto& f : w.t) for (int k = 0; k < 3; ++k) { nb[f[k]].insert(f[(k + 1) % 3]); nb[f[k]].insert(f[(k + 2) % 3]); }
    const double lambda = std::clamp(strength, 0.0, 1.0) * 0.63, mu = -lambda * 1.04;
    uint32_t moved = 0;
    for (size_t v = 0; v < inner.size(); ++v) moved += inner[v];
    for (int it = 0; it < iterations; ++it) for (double f : {lambda, mu}) {
        std::vector<D3> next = w.p;
        for (size_t v = 0; v < w.p.size(); ++v) {
            if (!inner[v] || nb[v].empty()) continue;
            D3 c{0, 0, 0};
            for (uint32_t u : nb[v]) c = c + w.p[u];
            c = c * (1.0 / nb[v].size());
            next[v] = w.p[v] + (c - w.p[v]) * f;
        }
        w.p = std::move(next);
    }
    return moved;
}

struct ReliefOptions {
    double amplitude = 0;   // metres along the normal (negative = into the surface)
    D3 direction{0, 0, 0};  // the profile repeats along this; zero = no repeating profile, noise only
    double period = 1;      // metres between repeats
    double duty = 0.5;      // share of each period raised
    double softness = 0.1;  // share of a period each edge of a raised band takes to rise
    double roughness = 0;   // noise amplitude as a share of amplitude
    double noiseScale = 1;  // metres per noise cell
    uint32_t seed = 1;
};

/** Smooth value noise in [-1, 1] on a lattice of cell metres. */
inline double valueNoise(const D3& p, double cell, uint32_t seed) {
    auto h = [&](int64_t x, int64_t y, int64_t z) {
        uint64_t k = uint64_t(x) * 73856093ull ^ uint64_t(y) * 19349663ull ^ uint64_t(z) * 83492791ull ^ uint64_t(seed) * 2654435761ull;
        k ^= k >> 33; k *= 0xff51afd7ed558ccdull; k ^= k >> 33;
        return double(k & 0xffffff) / double(0xffffff) * 2 - 1;
    };
    const D3 q = p * (1.0 / cell);
    const int64_t x0 = int64_t(std::floor(q.x)), y0 = int64_t(std::floor(q.y)), z0 = int64_t(std::floor(q.z));
    auto s = [](double t) { return t * t * (3 - 2 * t); };
    const double fx = s(q.x - x0), fy = s(q.y - y0), fz = s(q.z - z0);
    double r = 0;
    for (int dx = 0; dx < 2; ++dx) for (int dy = 0; dy < 2; ++dy) for (int dz = 0; dz < 2; ++dz)
        r += h(x0 + dx, y0 + dy, z0 + dz) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    return r;
}

/** The selection's inside moved along its normals by a banded profile plus noise (isoparametric normal relief). */
inline uint32_t reliefSelection(WMesh& w, const std::vector<uint8_t>& sel, const ReliefOptions& o) {
    if (o.amplitude == 0) throw MeshEditError("relief needs a non-zero amplitude (metres)");
    const auto inner = innerPoints(w, sel);
    std::vector<D3> nrm(w.p.size(), {0, 0, 0});
    for (const auto& f : w.t) { double a = 0; const D3 n = triNormal(w, f, &a); for (uint32_t v : f) nrm[v] = nrm[v] + n * a; }
    const double dl = o.direction.length();
    const D3 dir = dl > 0 ? o.direction * (1.0 / dl) : D3{0, 0, 0};
    const double duty = std::clamp(o.duty, 0.0, 1.0), soft = std::clamp(o.softness, 1e-3, 0.5);
    uint32_t moved = 0;
    for (size_t v = 0; v < w.p.size(); ++v) {
        if (!inner[v]) continue;
        double h = 0;
        if (dl > 0) {
            if (!(o.period > 0)) throw MeshEditError("relief needs period > 0 with a direction");
            const double s = dir.dot(w.p[v]) / o.period, fr = s - std::floor(s);
            // a raised band over [0, duty) of each period, each side rising over `soft` of the period
            auto ramp = [&](double x) { const double t = std::clamp(x / soft, 0.0, 1.0); return t * t * (3 - 2 * t); };
            h = std::min(ramp(fr), ramp(duty - fr));
            if (fr >= duty) h = 0;
        } else {
            h = 1;
        }
        h += o.roughness * valueNoise(w.p[v], std::max(o.noiseScale, 1e-6), o.seed);
        const double l = nrm[v].length();
        if (!(l > 0)) continue;
        w.p[v] = w.p[v] + nrm[v] * (o.amplitude * h / l);
        ++moved;
    }
    return moved;
}

// ============================================================================
// Inspect
// ============================================================================

/** A JSON report of the mesh: what the next edit needs to know about it. */
inline std::string inspectJson(const ScratchboxMesh& m, float weldTol, double sharpDeg, int maxGroups) {
    WMesh w = toWelded(m, weldTol);
    DBox b;
    for (const auto& p : w.p) b.expand(p);
    double area = 0;
    std::unordered_map<uint64_t, std::vector<uint32_t>> ef;
    for (uint32_t f = 0; f < w.t.size(); ++f) {
        double a = 0; triNormal(w, w.t[f], &a); area += a;
        for (int k = 0; k < 3; ++k) ef[ekey(w.t[f][k], w.t[f][(k + 1) % 3])].push_back(f);
    }
    uint32_t open = 0, nonManifold = 0, sharpConvex = 0, sharpConcave = 0;
    double sharpLen = 0;
    const double cosS = std::cos(sharpDeg * M_PI / 180.0);
    for (const auto& [k, fs] : ef) {
        if (fs.size() == 1) { ++open; continue; }
        if (fs.size() > 2) { ++nonManifold; continue; }
        const D3 n1 = triNormal(w, w.t[fs[0]]), n2 = triNormal(w, w.t[fs[1]]);
        if (n1.dot(n2) > cosS) continue;
        const uint32_t a = uint32_t(k >> 32), c = uint32_t(k & 0xffffffffu);
        uint32_t far = a;
        for (uint32_t v : w.t[fs[1]]) if (v != a && v != c) far = v;
        (n1.dot(w.p[far] - w.p[a]) < 0 ? sharpConvex : sharpConcave)++;
        sharpLen += (w.p[a] - w.p[c]).length();
    }
    // planar groups: connected faces sharing one plane, largest first
    std::vector<int> group(w.t.size(), -1);
    struct G { D3 n; double d, area; DBox box; uint32_t faces; };
    std::vector<G> groups;
    std::vector<std::vector<uint32_t>> vt(w.p.size());
    for (uint32_t f = 0; f < w.t.size(); ++f) for (uint32_t v : w.t[f]) vt[v].push_back(f);
    const double dTol = std::max(1e-6, (b.hi - b.lo).length() * 1e-5);
    for (uint32_t f = 0; f < w.t.size(); ++f) {
        if (group[f] >= 0) continue;
        double a0 = 0;
        const D3 n = triNormal(w, w.t[f], &a0);
        if (!(a0 > 0)) continue;
        const double d = n.dot(w.p[w.t[f][0]]);
        G g{n, d, 0, DBox{}, 0};
        std::vector<uint32_t> stack{f};
        group[f] = int(groups.size());
        while (!stack.empty()) {
            const uint32_t x = stack.back(); stack.pop_back();
            double a = 0; triNormal(w, w.t[x], &a);
            g.area += a; ++g.faces;
            for (uint32_t v : w.t[x]) g.box.expand(w.p[v]);
            for (int k = 0; k < 3; ++k) for (uint32_t y : ef[ekey(w.t[x][k], w.t[x][(k + 1) % 3])]) {
                if (group[y] >= 0) continue;
                const D3 ny = triNormal(w, w.t[y]);
                if (ny.dot(n) < 1 - 1e-6 || std::abs(n.dot(w.p[w.t[y][0]]) - d) > dTol) continue;
                group[y] = int(groups.size());
                stack.push_back(y);
            }
        }
        groups.push_back(g);
    }
    std::vector<size_t> order(groups.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = i;
    std::sort(order.begin(), order.end(), [&](size_t x, size_t y) { return groups[x].area > groups[y].area; });
    const D3 ext = b.hi - b.lo;
    auto frac = [&](const D3& p) { return D3{ext.x > 0 ? (p.x - b.lo.x) / ext.x : 0.5, ext.y > 0 ? (p.y - b.lo.y) / ext.y : 0.5, ext.z > 0 ? (p.z - b.lo.z) / ext.z : 0.5}; };
    std::ostringstream o;
    o.precision(6);
    auto v3 = [&](const D3& p) { std::ostringstream s; s.precision(6); s << "[" << p.x << "," << p.y << "," << p.z << "]"; return s.str(); };
    o << "{\"triangles\":" << w.t.size() << ",\"points\":" << w.p.size() << ",\"boundsMin\":" << v3(b.lo) << ",\"boundsMax\":" << v3(b.hi)
      << ",\"size\":" << v3(ext) << ",\"areaM2\":" << area << ",\"volumeM3\":" << (open == 0 && nonManifold == 0 ? std::abs(signedVolume(w)) : 0.0)
      << ",\"closed\":" << (open == 0 && nonManifold == 0 ? "true" : "false") << ",\"openEdges\":" << open << ",\"nonManifoldEdges\":" << nonManifold
      << ",\"insideOut\":" << (open == 0 && signedVolume(w) < 0 ? "true" : "false")
      << ",\"sharpEdges\":{\"angleDeg\":" << sharpDeg << ",\"convex\":" << sharpConvex << ",\"concave\":" << sharpConcave << ",\"totalLengthM\":" << sharpLen << "}"
      << ",\"planarGroups\":" << groups.size() << ",\"largestFaces\":[";
    for (int i = 0; i < std::min<int>(maxGroups, int(order.size())); ++i) {
        const G& g = groups[order[i]];
        o << (i ? "," : "") << "{\"normal\":" << v3(g.n) << ",\"areaM2\":" << g.area << ",\"triangles\":" << g.faces
          << ",\"boundsMin\":" << v3(g.box.lo) << ",\"boundsMax\":" << v3(g.box.hi)
          << ",\"regionMin\":" << v3(frac(g.box.lo)) << ",\"regionMax\":" << v3(frac(g.box.hi)) << "}";
    }
    o << "]}";
    return o.str();
}

} // namespace mesh_edit
} // namespace scratchbox
