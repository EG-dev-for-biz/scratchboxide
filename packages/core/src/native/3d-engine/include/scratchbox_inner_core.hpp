/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's inner core: a closed solid inside a finished building, behind every surface it has, so that wherever the
 * outside still has a hole (a corner the scan never measured, a slot between two rebuilt walls) the eye meets a surface
 * instead of the building's inside or the sky behind it (pipeline-k/inner-core.ts drives it and textures it).
 *
 * The solid is a set of voxels on a grid turned to the building's own walls (the angle, mod 90 degrees, its upright
 * surfaces face most, by area), kept where all of these hold:
 *  - under the building's measured height in that plan cell (its top-down heightfield: the highest surface over the cell's
 *    centre) by insetM, and over the footprint when one is given;
 *  - inside the building: its generalised winding number (the solid angle its surfaces subtend, over 4 pi; 1 inside a
 *    closed outward-facing shell, 0 outside, in between near a hole) at the voxel's centre at least windingMin. Evaluated
 *    Barnes-Hut style over a bounding volume hierarchy: a far node by its area-weighted normal as one dipole, a near leaf
 *    triangle by triangle (van Oosterom and Strackee);
 *  - clear of every surface: no triangle (scan, rebuilt wall or fill) within insetM of the voxel, measured from its centre
 *    plus its half diagonal, so the voxel's box is at least insetM behind whatever is nearest.
 * Inside a repair region (a hole the outside check found, the core missing behind it) minInsetM and regionWindingMin stand
 * in for insetM and windingMin.
 *
 * Every voxel face toward a voxel not kept is drawn facing out, its corners shared on the grid, so the result is closed
 * whatever its shape (a face shared by two kept voxels is not drawn). Each face is also given the surface it takes its photo
 * from: the nearest rebuilt wall facing within facingMin of it, else the nearest other photo-textured surface, within
 * textureMaxM; the TypeScript maps the face onto that surface's own texture mapping.
 */

#pragma once

#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <limits>
#include <numeric>
#include <unordered_map>
#include <vector>

namespace scratchbox::inner_core {

using Vec3 = std::array<double, 3>;
inline Vec3 sub(const Vec3& a, const Vec3& b) { return {a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }
inline Vec3 add(const Vec3& a, const Vec3& b) { return {a[0] + b[0], a[1] + b[1], a[2] + b[2]}; }
inline Vec3 mul(const Vec3& a, double s) { return {a[0] * s, a[1] * s, a[2] * s}; }
inline double dot(const Vec3& a, const Vec3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline Vec3 cross(const Vec3& a, const Vec3& b) { return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]}; }
inline double len(const Vec3& a) { return std::sqrt(dot(a, a)); }

struct Params {
    /** The voxel's plan side and height (m). */
    double cellM = 1.5, layerM = 1.5;
    /** The core's box stays at least this far behind every surface (m), and this far under the heightfield. */
    double insetM = 1.0;
    /** Inside where the winding number is at least this. */
    double windingMin = 0.5;
    /** A node is far (one dipole) when its centre is more than this many of its radii away. */
    double farRatio = 2.0;
    /** Within a repair region: the smaller inset and winding threshold. */
    double minInsetM = 0.3, regionWindingMin = 0.3;
    /** A face takes its photo from a surface facing within this |cos| of it, no further than textureMaxM (m). */
    double facingMin = 0.5, textureMaxM = 12.0;
    /** Components of fewer voxels than this are dropped (a speck between two surfaces is no core). */
    double minComponentVoxels = 8;
};

inline std::vector<double> paramVector(const Params& p) { return {p.cellM, p.layerM, p.insetM, p.windingMin, p.farRatio, p.minInsetM, p.regionWindingMin, p.facingMin, p.textureMaxM, p.minComponentVoxels}; }
inline Params paramsFrom(const std::vector<double>& v) {
    Params p;
    if (v.size() < 10) return p;
    p.cellM = v[0]; p.layerM = v[1]; p.insetM = v[2]; p.windingMin = v[3]; p.farRatio = v[4]; p.minInsetM = v[5]; p.regionWindingMin = v[6]; p.facingMin = v[7]; p.textureMaxM = v[8]; p.minComponentVoxels = v[9];
    return p;
}

/** A sphere where the outside check found a hole with no core behind it. */
struct Region { Vec3 c; double r; };

struct Input {
    /** The building's triangles, world space, 9 floats each. */
    std::vector<float> soup;
    /** Per triangle: 0 untextured, 1 photo-textured (scan, fill on a photo), 2 a rebuilt wall. */
    std::vector<uint8_t> kind;
    /** The footprint's loops (plan x, z); none: no footprint limit. */
    std::vector<std::vector<std::array<double, 2>>> footprint;
    /** The ground (m); NaN: the building's lowest point. */
    double groundY = std::numeric_limits<double>::quiet_NaN();
    std::vector<Region> regions;
};

struct Output {
    std::vector<double> positions;
    std::vector<uint32_t> indices;
    /** Per output triangle: the soup triangle it takes its photo from (-1: none), and its route (0 none, 1 rebuilt wall, 2 other photo). */
    std::vector<int32_t> source;
    std::vector<uint8_t> route;
    double angleDeg = 0;
    double candidates = 0, keptVoxels = 0, droppedSpecks = 0, nearSurface = 0, outside = 0, inRegions = 0;
    double areaM2 = 0, volumeM3 = 0;
    /** The least clearance of any kept voxel's box to the nearest surface (m). */
    double minClearanceM = 0;
    double facesWall = 0, facesPhoto = 0, facesNone = 0;
    int nx = 0, ny = 0, nz = 0;
};

namespace detail {

struct Tri { Vec3 a, b, c; };

inline Vec3 closestOnTriangle(const Vec3& p, const Tri& t) {
    // Ericson, Real-Time Collision Detection 5.1.5
    const Vec3 ab = sub(t.b, t.a), ac = sub(t.c, t.a), ap = sub(p, t.a);
    const double d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return t.a;
    const Vec3 bp = sub(p, t.b);
    const double d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return t.b;
    const double vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(t.a, mul(ab, d1 / (d1 - d3)));
    const Vec3 cp = sub(p, t.c);
    const double d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return t.c;
    const double vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(t.a, mul(ac, d2 / (d2 - d6)));
    const double va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return add(t.b, mul(sub(t.c, t.b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    const double den = 1.0 / (va + vb + vc);
    return add(t.a, add(mul(ab, vb * den), mul(ac, vc * den)));
}

inline double solidAngle(const Vec3& q, const Tri& t) {
    const Vec3 a = sub(t.a, q), b = sub(t.b, q), c = sub(t.c, q);
    const double la = len(a), lb = len(b), lc = len(c);
    const double num = dot(a, cross(b, c));
    const double den = la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb;
    return 2.0 * std::atan2(num, den);
}

struct Node { Vec3 lo, hi, N, P; double r = 0; int left = -1, right = -1; uint32_t start = 0, count = 0; };

/** A bounding volume hierarchy over the triangles, each node with its dipole (vector area N at area-weighted centre P). */
class Bvh {
public:
    Bvh(const std::vector<Tri>& tris) : tris_(tris), order_(tris.size()) {
        std::iota(order_.begin(), order_.end(), 0u);
        cent_.resize(tris.size());
        for (size_t i = 0; i < tris.size(); ++i) cent_[i] = mul(add(add(tris[i].a, tris[i].b), tris[i].c), 1.0 / 3);
        if (!tris.empty()) build(0, static_cast<uint32_t>(tris.size()));
    }
    const std::vector<Tri>& tris() const { return tris_; }

    double winding(const Vec3& q, double farRatio) const {
        if (nodes_.empty()) return 0;
        double sum = 0;
        int stack[128];
        int top = 0;
        stack[top++] = 0;
        while (top) {
            const Node& n = nodes_[stack[--top]];
            const Vec3 d = sub(n.P, q);
            const double dl = len(d);
            if (n.left < 0) {
                for (uint32_t i = n.start; i < n.start + n.count; ++i) sum += solidAngle(q, tris_[order_[i]]);
            } else if (dl > farRatio * n.r) {
                sum += dot(d, n.N) / (dl * dl * dl);
            } else {
                if (top + 2 > 128) { for (uint32_t i = n.start; i < n.start + n.count; ++i) sum += solidAngle(q, tris_[order_[i]]); continue; }
                stack[top++] = n.left;
                stack[top++] = n.right;
            }
        }
        return sum / (4 * M_PI);
    }

    /** The distance from q to the nearest triangle, when one is within r; else r. */
    double nearestWithin(const Vec3& q, double r) const {
        double best = r;
        if (nodes_.empty()) return best;
        int stack[128];
        int top = 0;
        stack[top++] = 0;
        while (top) {
            const Node& n = nodes_[stack[--top]];
            if (boxDist(n, q) >= best) continue;
            if (n.left < 0 || top + 2 > 128) {
                for (uint32_t i = n.start; i < n.start + n.count; ++i) {
                    const double d = len(sub(q, closestOnTriangle(q, tris_[order_[i]])));
                    if (d < best) best = d;
                }
                continue;
            }
            stack[top++] = n.left;
            stack[top++] = n.right;
        }
        return best;
    }

    /** The nearest triangle within maxM that `accept` takes, or -1. */
    template <class F>
    int nearestAccepted(const Vec3& q, double maxM, F&& accept) const {
        double best = maxM;
        int hit = -1;
        if (nodes_.empty()) return hit;
        int stack[128];
        int top = 0;
        stack[top++] = 0;
        while (top) {
            const Node& n = nodes_[stack[--top]];
            if (boxDist(n, q) >= best) continue;
            if (n.left < 0 || top + 2 > 128) {
                for (uint32_t i = n.start; i < n.start + n.count; ++i) {
                    const uint32_t t = order_[i];
                    if (!accept(t)) continue;
                    const double d = len(sub(q, closestOnTriangle(q, tris_[t])));
                    if (d < best) { best = d; hit = static_cast<int>(t); }
                }
                continue;
            }
            // the nearer child first
            const Node& l = nodes_[n.left];
            const Node& rr = nodes_[n.right];
            if (boxDist(l, q) < boxDist(rr, q)) { stack[top++] = n.right; stack[top++] = n.left; }
            else { stack[top++] = n.left; stack[top++] = n.right; }
        }
        return hit;
    }

private:
    static double boxDist(const Node& n, const Vec3& q) {
        double s = 0;
        for (int k = 0; k < 3; ++k) {
            const double d = q[k] < n.lo[k] ? n.lo[k] - q[k] : q[k] > n.hi[k] ? q[k] - n.hi[k] : 0;
            s += d * d;
        }
        return std::sqrt(s);
    }
    int build(uint32_t start, uint32_t count) {
        const int id = static_cast<int>(nodes_.size());
        nodes_.emplace_back();
        Node n;
        n.start = start; n.count = count;
        n.lo = {1e300, 1e300, 1e300}; n.hi = {-1e300, -1e300, -1e300};
        n.N = {0, 0, 0};
        Vec3 P = {0, 0, 0};
        double area = 0;
        for (uint32_t i = start; i < start + count; ++i) {
            const Tri& t = tris_[order_[i]];
            for (const Vec3* v : {&t.a, &t.b, &t.c}) for (int k = 0; k < 3; ++k) { n.lo[k] = std::min(n.lo[k], (*v)[k]); n.hi[k] = std::max(n.hi[k], (*v)[k]); }
            const Vec3 va = mul(cross(sub(t.b, t.a), sub(t.c, t.a)), 0.5);
            const double a = len(va);
            n.N = add(n.N, va);
            P = add(P, mul(cent_[order_[i]], a));
            area += a;
        }
        n.P = area > 0 ? mul(P, 1.0 / area) : mul(add(n.lo, n.hi), 0.5);
        for (int c = 0; c < 8; ++c) {
            const Vec3 corner = {(c & 1) ? n.hi[0] : n.lo[0], (c & 2) ? n.hi[1] : n.lo[1], (c & 4) ? n.hi[2] : n.lo[2]};
            n.r = std::max(n.r, len(sub(corner, n.P)));
        }
        if (count > 8) {
            int axis = 0;
            for (int k = 1; k < 3; ++k) if (n.hi[k] - n.lo[k] > n.hi[axis] - n.lo[axis]) axis = k;
            const uint32_t mid = start + count / 2;
            std::nth_element(order_.begin() + start, order_.begin() + mid, order_.begin() + start + count, [&](uint32_t x, uint32_t y) { return cent_[x][axis] < cent_[y][axis]; });
            n.left = build(start, mid - start);
            n.right = build(mid, start + count - mid);
        }
        nodes_[id] = n;
        return id;
    }
    std::vector<Tri> tris_;
    std::vector<uint32_t> order_;
    std::vector<Vec3> cent_;
    std::vector<Node> nodes_;
};

inline bool insideLoops(const std::vector<std::vector<std::array<double, 2>>>& loops, double x, double z) {
    bool in = false;
    for (const auto& l : loops) {
        for (size_t i = 0, j = l.size() - 1; i < l.size(); j = i++) {
            if ((l[i][1] > z) != (l[j][1] > z) && x < (l[j][0] - l[i][0]) * (z - l[i][1]) / (l[j][1] - l[i][1]) + l[i][0]) in = !in;
        }
    }
    return in;
}

}  // namespace detail

inline Output build(const Input& in, const Params& P, FixedThreadPool& pool) {
    using namespace detail;
    Output out;
    const size_t nt = in.soup.size() / 9;
    std::vector<Tri> tris(nt);
    for (size_t i = 0; i < nt; ++i) {
        const float* f = &in.soup[i * 9];
        tris[i] = {{{f[0], f[1], f[2]}}, {{f[3], f[4], f[5]}}, {{f[6], f[7], f[8]}}};
    }
    if (!nt) return out;
    // the grid's angle: the upright surfaces' plan normals, by area, at four times their angle (so walls at right angles agree)
    double c4 = 0, s4 = 0;
    for (const Tri& t : tris) {
        const Vec3 n = cross(sub(t.b, t.a), sub(t.c, t.a));
        const double a = len(n);
        if (!(a > 0) || std::abs(n[1]) > 0.3 * a) continue;
        const double phi = std::atan2(n[2], n[0]);
        c4 += a * std::cos(4 * phi); s4 += a * std::sin(4 * phi);
    }
    const double theta = (c4 == 0 && s4 == 0) ? 0 : std::atan2(s4, c4) / 4;
    out.angleDeg = theta * 180 / M_PI;
    const double ct = std::cos(theta), st = std::sin(theta);
    // plan (x, z) -> grid (u, w) and back
    auto toU = [&](double x, double z) { return x * ct + z * st; };
    auto toW = [&](double x, double z) { return -x * st + z * ct; };
    auto toX = [&](double u, double w) { return u * ct - w * st; };
    auto toZ = [&](double u, double w) { return u * st + w * ct; };
    double u0 = 1e300, u1 = -1e300, w0 = 1e300, w1 = -1e300, y0 = 1e300, y1 = -1e300;
    for (const Tri& t : tris) for (const Vec3* v : {&t.a, &t.b, &t.c}) {
        const double u = toU((*v)[0], (*v)[2]), w = toW((*v)[0], (*v)[2]);
        u0 = std::min(u0, u); u1 = std::max(u1, u); w0 = std::min(w0, w); w1 = std::max(w1, w);
        y0 = std::min(y0, (*v)[1]); y1 = std::max(y1, (*v)[1]);
    }
    if (std::isfinite(in.groundY)) y0 = std::max(y0, in.groundY);
    const double C = P.cellM, L = P.layerM;
    const int nx = std::max(1, static_cast<int>(std::ceil((u1 - u0) / C))), nz = std::max(1, static_cast<int>(std::ceil((w1 - w0) / C)));
    const int ny = std::max(1, static_cast<int>(std::ceil((y1 - y0) / L)));
    out.nx = nx; out.ny = ny; out.nz = nz;
    if (static_cast<double>(nx) * nz > 4e7) return out;
    // the top-down heightfield: the highest surface over each cell's centre
    std::vector<double> H(static_cast<size_t>(nx) * nz, -1e300);
    for (const Tri& t : tris) {
        const double au = toU(t.a[0], t.a[2]), aw = toW(t.a[0], t.a[2]), bu = toU(t.b[0], t.b[2]), bw = toW(t.b[0], t.b[2]), cu = toU(t.c[0], t.c[2]), cw = toW(t.c[0], t.c[2]);
        const double area = (bu - au) * (cw - aw) - (cu - au) * (bw - aw);
        if (std::abs(area) < 1e-9) continue;
        const int i0 = std::max(0, static_cast<int>(std::floor((std::min({au, bu, cu}) - u0) / C - 0.5))), i1 = std::min(nx - 1, static_cast<int>(std::ceil((std::max({au, bu, cu}) - u0) / C - 0.5)));
        const int j0 = std::max(0, static_cast<int>(std::floor((std::min({aw, bw, cw}) - w0) / C - 0.5))), j1 = std::min(nz - 1, static_cast<int>(std::ceil((std::max({aw, bw, cw}) - w0) / C - 0.5)));
        for (int j = j0; j <= j1; ++j) for (int i = i0; i <= i1; ++i) {
            const double pu = u0 + (i + 0.5) * C, pw = w0 + (j + 0.5) * C;
            const double l1 = ((pu - au) * (cw - aw) - (cu - au) * (pw - aw)) / area, l2 = ((bu - au) * (pw - aw) - (pu - au) * (bw - aw)) / area, l0 = 1 - l1 - l2;
            if (l0 < -1e-9 || l1 < -1e-9 || l2 < -1e-9) continue;
            const double y = l0 * t.a[1] + l1 * t.b[1] + l2 * t.c[1];
            double& h = H[static_cast<size_t>(j) * nx + i];
            if (y > h) h = y;
        }
    }
    const Bvh bvh(tris);
    const double halfDiag = 0.5 * std::sqrt(2 * C * C + L * L);
    const size_t cells = static_cast<size_t>(nx) * nz;
    std::vector<uint8_t> kept(cells * ny, 0);
    std::vector<double> colCand(cells, 0), colNear(cells, 0), colOut(cells, 0), colReg(cells, 0), colClear(cells, 1e300);
    pool.forEach(cells, [&](size_t col) {
        const int i = static_cast<int>(col % nx), j = static_cast<int>(col / nx);
        const double h = H[col];
        if (!(h > -1e299)) return;
        const double pu = u0 + (i + 0.5) * C, pw = w0 + (j + 0.5) * C, px = toX(pu, pw), pz = toZ(pu, pw);
        if (!in.footprint.empty() && !insideLoops(in.footprint, px, pz)) return;
        for (int k = 0; k < ny; ++k) {
            const double cy = y0 + (k + 0.5) * L;
            const Vec3 q = {px, cy, pz};
            bool inRegion = false;
            for (const Region& r : in.regions) if (len(sub(q, r.c)) <= r.r) { inRegion = true; break; }
            const double inset = inRegion ? P.minInsetM : P.insetM;
            if (cy + 0.5 * L > h - inset) break;
            colCand[col]++;
            const double need = inset + halfDiag;
            const double d = bvh.nearestWithin(q, need + 1e-9);
            if (d < need) { colNear[col]++; continue; }
            if (bvh.winding(q, P.farRatio) < (inRegion ? P.regionWindingMin : P.windingMin)) { colOut[col]++; continue; }
            kept[col * ny + k] = 1;
            if (inRegion) colReg[col]++;
            colClear[col] = std::min(colClear[col], d - halfDiag);
        }
    });
    double minClear = 1e300;
    for (size_t c = 0; c < cells; ++c) { out.candidates += colCand[c]; out.nearSurface += colNear[c]; out.outside += colOut[c]; out.inRegions += colReg[c]; minClear = std::min(minClear, colClear[c]); }
    auto at = [&](int i, int j, int k) -> bool { return i >= 0 && j >= 0 && k >= 0 && i < nx && j < nz && k < ny && kept[(static_cast<size_t>(j) * nx + i) * ny + k]; };
    // specks dropped: 6-connected components under minComponentVoxels
    {
        std::vector<uint8_t> seen(kept.size(), 0);
        std::vector<size_t> stack, comp;
        for (size_t s = 0; s < kept.size(); ++s) {
            if (!kept[s] || seen[s]) continue;
            comp.clear(); stack.clear(); stack.push_back(s); seen[s] = 1;
            while (!stack.empty()) {
                const size_t v = stack.back(); stack.pop_back(); comp.push_back(v);
                const int k = static_cast<int>(v % ny), col = static_cast<int>(v / ny), i = col % nx, j = col / nx;
                const int nb[6][3] = {{i - 1, j, k}, {i + 1, j, k}, {i, j - 1, k}, {i, j + 1, k}, {i, j, k - 1}, {i, j, k + 1}};
                for (const auto& b : nb) {
                    if (!at(b[0], b[1], b[2])) continue;
                    const size_t o = (static_cast<size_t>(b[1]) * nx + b[0]) * ny + b[2];
                    if (!seen[o]) { seen[o] = 1; stack.push_back(o); }
                }
            }
            if (static_cast<double>(comp.size()) < P.minComponentVoxels) { for (size_t v : comp) kept[v] = 0; out.droppedSpecks += static_cast<double>(comp.size()); }
        }
    }
    // the closed surface: each kept voxel's faces toward a voxel not kept, facing out, corners shared on the grid
    std::unordered_map<uint64_t, uint32_t> vid;
    auto vertex = [&](int i, int j, int k) -> uint32_t {
        const uint64_t key = (static_cast<uint64_t>(i) * (static_cast<uint64_t>(nz) + 1) + static_cast<uint64_t>(j)) * (static_cast<uint64_t>(ny) + 1) + static_cast<uint64_t>(k);
        const auto it = vid.find(key);
        if (it != vid.end()) return it->second;
        const double u = u0 + i * C, w = w0 + j * C;
        out.positions.push_back(toX(u, w)); out.positions.push_back(y0 + k * L); out.positions.push_back(toZ(u, w));
        const uint32_t id = static_cast<uint32_t>(out.positions.size() / 3 - 1);
        vid.emplace(key, id);
        return id;
    };
    struct Face { int i, j, k, dir; };
    std::vector<Face> faces;
    for (int j = 0; j < nz; ++j) for (int i = 0; i < nx; ++i) for (int k = 0; k < ny; ++k) {
        if (!at(i, j, k)) continue;
        out.keptVoxels++;
        if (!at(i - 1, j, k)) faces.push_back({i, j, k, 0});
        if (!at(i + 1, j, k)) faces.push_back({i, j, k, 1});
        if (!at(i, j - 1, k)) faces.push_back({i, j, k, 2});
        if (!at(i, j + 1, k)) faces.push_back({i, j, k, 3});
        if (!at(i, j, k - 1)) faces.push_back({i, j, k, 4});
        if (!at(i, j, k + 1)) faces.push_back({i, j, k, 5});
    }
    out.volumeM3 = out.keptVoxels * C * C * L;
    out.minClearanceM = out.keptVoxels > 0 ? minClear : 0;
    // grid directions: u (+x of the grid), w, y; a face's outward normal in world space
    const Vec3 du = {ct, 0, st}, dw = {-st, 0, ct}, dy = {0, 1, 0};
    for (const Face& f : faces) {
        // corners counter-clockwise seen from outside
        std::array<std::array<int, 3>, 4> c;
        const int i = f.i, j = f.j, k = f.k;
        switch (f.dir) {
            case 0: c = {{{i, j, k}, {i, j + 1, k}, {i, j + 1, k + 1}, {i, j, k + 1}}}; break;
            case 1: c = {{{i + 1, j, k}, {i + 1, j, k + 1}, {i + 1, j + 1, k + 1}, {i + 1, j + 1, k}}}; break;
            case 2: c = {{{i, j, k}, {i, j, k + 1}, {i + 1, j, k + 1}, {i + 1, j, k}}}; break;
            case 3: c = {{{i, j + 1, k}, {i + 1, j + 1, k}, {i + 1, j + 1, k + 1}, {i, j + 1, k + 1}}}; break;
            case 4: c = {{{i, j, k}, {i + 1, j, k}, {i + 1, j + 1, k}, {i, j + 1, k}}}; break;
            default: c = {{{i, j, k + 1}, {i, j + 1, k + 1}, {i + 1, j + 1, k + 1}, {i + 1, j, k + 1}}}; break;
        }
        uint32_t v[4];
        for (int q = 0; q < 4; ++q) v[q] = vertex(c[q][0], c[q][1], c[q][2]);
        // the outward normal as drawn ((b - a) x (c - a)) checked against the face's direction, the winding flipped if they disagree
        const Vec3 want = f.dir == 0 ? mul(du, -1) : f.dir == 1 ? du : f.dir == 2 ? mul(dw, -1) : f.dir == 3 ? dw : f.dir == 4 ? mul(dy, -1) : dy;
        const Vec3 pa = {out.positions[v[0] * 3], out.positions[v[0] * 3 + 1], out.positions[v[0] * 3 + 2]};
        const Vec3 pb = {out.positions[v[1] * 3], out.positions[v[1] * 3 + 1], out.positions[v[1] * 3 + 2]};
        const Vec3 pc = {out.positions[v[2] * 3], out.positions[v[2] * 3 + 1], out.positions[v[2] * 3 + 2]};
        if (dot(cross(sub(pb, pa), sub(pc, pa)), want) < 0) std::swap(v[1], v[3]);
        out.indices.insert(out.indices.end(), {v[0], v[1], v[2], v[0], v[2], v[3]});
        out.areaM2 += (f.dir >= 4 ? C * C : C * L);
    }
    // each face's photo: the nearest rebuilt wall facing alike, else the nearest other photo-textured surface facing alike
    out.source.assign(out.indices.size() / 3, -1);
    out.route.assign(out.indices.size() / 3, 0);
    std::vector<Vec3> triN(nt);
    for (size_t t = 0; t < nt; ++t) { const Vec3 n = cross(sub(tris[t].b, tris[t].a), sub(tris[t].c, tris[t].a)); const double l = len(n); triN[t] = l > 0 ? mul(n, 1 / l) : Vec3{0, 0, 0}; }
    pool.forEach(faces.size(), [&](size_t fi) {
        const uint32_t* q = &out.indices[fi * 6];
        Vec3 c = {0, 0, 0};
        for (int k : {0, 1, 2, 5}) c = add(c, {out.positions[q[k] * 3], out.positions[q[k] * 3 + 1], out.positions[q[k] * 3 + 2]});
        c = mul(c, 0.25);
        const Vec3 a = {out.positions[q[0] * 3], out.positions[q[0] * 3 + 1], out.positions[q[0] * 3 + 2]}, b = {out.positions[q[1] * 3], out.positions[q[1] * 3 + 1], out.positions[q[1] * 3 + 2]}, d = {out.positions[q[2] * 3], out.positions[q[2] * 3 + 1], out.positions[q[2] * 3 + 2]};
        Vec3 n = cross(sub(b, a), sub(d, a));
        n = mul(n, 1 / std::max(1e-12, len(n)));
        int hit = bvh.nearestAccepted(c, P.textureMaxM, [&](uint32_t t) { return in.kind[t] == 2 && dot(triN[t], n) >= P.facingMin; });
        uint8_t route = hit >= 0 ? 1 : 0;
        if (hit < 0) { hit = bvh.nearestAccepted(c, P.textureMaxM, [&](uint32_t t) { return in.kind[t] >= 1 && dot(triN[t], n) >= P.facingMin; }); route = hit >= 0 ? 2 : 0; }
        out.source[fi * 2] = out.source[fi * 2 + 1] = hit;
        out.route[fi * 2] = out.route[fi * 2 + 1] = route;
    });
    for (size_t fi = 0; fi < faces.size(); ++fi) { const uint8_t r = out.route[fi * 2]; if (r == 1) out.facesWall++; else if (r == 2) out.facesPhoto++; else out.facesNone++; }
    return out;
}

}  // namespace scratchbox::inner_core
