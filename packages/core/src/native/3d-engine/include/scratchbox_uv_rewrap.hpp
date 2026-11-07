/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// UV unwrap, atlas packing and texture rebake (AlgorithmicUvEngine modes 'unwrap' and 'rewrap').
//
// Unwrap
// - Charts: grown by uv_atlas::growCharts (cost on normal deviation, roundness, straightness and creases, seeds
//   relocated, enclosed charts merged); a chart in several edge-connected pieces is flattened piece by piece.
// - Every chart's distortion is measured per triangle from the singular values s1 >= s2 of the 3D -> UV Jacobian:
//   angle stretch s1 / s2 and area ratio r = s1 s2 / (chart UV area / chart 3D area), folded to max(r, 1/r). The chart
//   passes when the area-weighted RMS of both is under the caller's thresholds (continuous parameters).
// - Flattening: a chart whose orthographic projection is not isometric goes through LSCM (least-squares conformal map,
//   Levy et al. 2002; preconditioned conjugate gradients, two pins) as a fast first map, then ABF++ (Sheffer et al.
//   2005: Newton on the angle Lagrangian, triangle constraints eliminated, Schur complement by conjugate gradients;
//   UVs by LSCM over the triangles its angles describe), then SLIM (Rabinovich et al. 2017: reweighted local-global
//   iterations on the symmetric Dirichlet energy with a flip-free line search) from the best flip-free map, else from
//   a Tutte embedding. The result is kept when it has no flipped triangle, no overlapping pair and passes.
// - Otherwise the chart is split: its triangles are re-clustered by buildIslands at a smaller normal tolerance and each
//   piece is processed again. A single triangle (or a chart at the tolerance floor) keeps its orthographic UVs, which
//   are always valid, and is counted as accepted over the threshold when it still fails. Charts are processed in
//   breadth-first batches on worker threads; results are taken in batch order, so the output is thread-count independent.
// - Charts are scaled to UV area = 3D area (one texel density across the atlas), turned to their minimum-area bounding
//   rectangle (rotating calipers over the convex hull) and packed at the requested texel density, or at the largest
//   density that fits a requested atlas size: by uv_atlas::packChartsBitmap (rasterised masks, quarter turns, charts
//   nest in each other's concavities); above bitmapMaxCharts charts (a remesh in hundreds of thousands of
//   pieces, where tight rectangles waste less than masks) by a skyline bottom-left rectangle packer with 90 degree
//   rotations.
//
// Bake
// - Each atlas texel is resolved to a source triangle and barycentric coordinates: for a rewrap of the same mesh the
//   target triangle itself (exact: geometry is unchanged), for a transfer the nearest point of a source mesh (BVH,
//   optional distance and normal gates).
// - Every texture slot is sampled bilinearly at the source UV with the source sampler's wrap modes. A normal-map slot
//   is decoded in the source tangent frame (interpolated vertex tangent, Gram-Schmidt against the normal, bitangent
//   sign w), taken to world space and re-encoded in the target tangent frame.
// - Texels whose centre lies outside every triangle but within `edgeTexels` of one are sampled at the closest point of
//   that triangle (exact gutter ring); the remaining gutter is filled by 8-neighbour dilation and empty texels get the
//   slot's mean so mipmaps do not bleed toward black.

#pragma once

#include "scratchbox_uv_atlas.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox::uv_rewrap {

using V3 = std::array<double, 3>;
using uv_atlas::detail::cross;
using uv_atlas::detail::dot;
using uv_atlas::detail::len;
using uv_atlas::detail::sub;
using uv_atlas::detail::unit;

// =====================================================================================================================
// Distortion
// =====================================================================================================================

struct TriangleDistortion {
    double sigma1 = 1, sigma2 = 1, det = 0, area3D = 0;
    bool degenerate3D = true;
};

/** Singular values of the Jacobian that maps the triangle (in its own plane, metres) to its UV triangle. */
inline TriangleDistortion triangleDistortion(const V3& p0, const V3& p1, const V3& p2, const double* q0, const double* q1, const double* q2) {
    TriangleDistortion d;
    V3 e1 = sub(p1, p0), e2 = sub(p2, p0);
    V3 n = cross(e1, e2);
    double a2 = len(n);
    double l1 = len(e1);
    if (a2 < 1e-18 || l1 < 1e-12) return d;
    d.degenerate3D = false;
    d.area3D = 0.5 * a2;
    V3 x = {e1[0] / l1, e1[1] / l1, e1[2] / l1};
    V3 y = unit(cross(unit(n), x));
    const double x1 = l1, y1 = 0, x2 = dot(e2, x), y2 = dot(e2, y);
    const double detP = x1 * y2 - x2 * y1;
    const double du1 = q1[0] - q0[0], dv1 = q1[1] - q0[1], du2 = q2[0] - q0[0], dv2 = q2[1] - q0[1];
    // J = Q P^-1, P = [[x1 x2][y1 y2]], Q = [[du1 du2][dv1 dv2]]
    const double i00 = y2 / detP, i01 = -x2 / detP, i10 = -y1 / detP, i11 = x1 / detP;
    const double a = du1 * i00 + du2 * i10, b = du1 * i01 + du2 * i11;
    const double c = dv1 * i00 + dv2 * i10, e = dv1 * i01 + dv2 * i11;
    const double E = (a + e) / 2, F = (a - e) / 2, G = (c + b) / 2, H = (c - b) / 2;
    const double Q = std::sqrt(E * E + H * H), R = std::sqrt(F * F + G * G);
    d.sigma1 = Q + R;
    d.sigma2 = std::fabs(Q - R);
    d.det = a * e - b * c;
    return d;
}

struct ChartDistortion {
    double stretchRms = 1, stretchMax = 1, areaRms = 1, areaMax = 1;
    double area3D = 0, area2D = 0;
    uint32_t flipped = 0;
};

constexpr double kDistortionCap = 1e6;

/** cornerUv: 6 doubles per triangle. Area-weighted RMS and max of the angle stretch and the folded area ratio. */
inline ChartDistortion chartDistortion(const std::vector<uint32_t>& tris, const std::vector<double>& cornerUv,
                                       const std::function<V3(uint32_t, int)>& corner) {
    ChartDistortion out;
    std::vector<TriangleDistortion> per(tris.size());
    double a3 = 0, a2 = 0, signedSum = 0;
    for (size_t k = 0; k < tris.size(); ++k) {
        const double* q = &cornerUv[k * 6];
        per[k] = triangleDistortion(corner(tris[k], 0), corner(tris[k], 1), corner(tris[k], 2), q, q + 2, q + 4);
        if (per[k].degenerate3D) continue;
        a3 += per[k].area3D;
        a2 += std::fabs(per[k].det) * per[k].area3D;
        signedSum += per[k].det * per[k].area3D;
    }
    out.area3D = a3;
    out.area2D = a2;
    if (a3 <= 0) return out;
    const double scale2 = a2 / a3;  // UV area per 3D area over the chart
    const double orientation = signedSum >= 0 ? 1.0 : -1.0;
    double s2sum = 0, r2sum = 0;
    out.stretchMax = 1; out.areaMax = 1;
    for (size_t k = 0; k < tris.size(); ++k) {
        const auto& t = per[k];
        if (t.degenerate3D) continue;
        if (t.det * orientation <= 0) ++out.flipped;
        double stretch = t.sigma2 > t.sigma1 / kDistortionCap ? t.sigma1 / t.sigma2 : kDistortionCap;
        double r = scale2 > 0 ? std::fabs(t.det) / scale2 : 0;
        double area = r > 1 / kDistortionCap ? std::max(r, 1 / r) : kDistortionCap;
        area = std::min(area, kDistortionCap);
        s2sum += t.area3D * stretch * stretch;
        r2sum += t.area3D * area * area;
        out.stretchMax = std::max(out.stretchMax, stretch);
        out.areaMax = std::max(out.areaMax, area);
    }
    out.stretchRms = std::sqrt(s2sum / a3);
    out.areaRms = std::sqrt(r2sum / a3);
    return out;
}

// =====================================================================================================================
// Overlap test inside one chart (uniform grid + separating axes on slightly shrunk triangles)
// =====================================================================================================================

/**
 * Triangle pairs whose interiors overlap. Each triangle is first inset by `inset` (same units as the UVs) about its
 * incentre, and by a relative 1e-6 so shared edges and vertices never count; a triangle thinner than the inset covers
 * no area and is skipped (float rounding of slivers is not overlap).
 */
inline uint64_t countOverlappingPairs(const std::vector<double>& cornerUv, uint64_t stopAfter = 1, double inset = 0.0) {
    const size_t n = cornerUv.size() / 6;
    if (n < 2) return 0;
    std::vector<std::array<double, 6>> tri(n);
    std::vector<char> skip(n, 0);
    double minX = 1e300, minY = 1e300, maxX = -1e300, maxY = -1e300, sumArea = 0;
    for (size_t m = 0; m < n; ++m) {
        const double* q = &cornerUv[m * 6];
        double la = std::hypot(q[2] - q[4], q[3] - q[5]), lb = std::hypot(q[0] - q[4], q[1] - q[5]), lc = std::hypot(q[0] - q[2], q[1] - q[3]);
        double per = la + lb + lc;
        double area = 0.5 * std::fabs(uv_atlas::detail::orient(q, q + 2, q + 4));
        double r = per > 0 ? 2 * area / per : 0;  // inradius
        if (r <= inset) { skip[m] = 1; continue; }
        double ix = (la * q[0] + lb * q[2] + lc * q[4]) / per, iy = (la * q[1] + lb * q[3] + lc * q[5]) / per;
        double f = (1 - inset / r) * (1 - 1e-6);
        for (int k = 0; k < 3; ++k) {
            tri[m][k * 2] = ix + (q[k * 2] - ix) * f;
            tri[m][k * 2 + 1] = iy + (q[k * 2 + 1] - iy) * f;
            minX = std::min(minX, tri[m][k * 2]); maxX = std::max(maxX, tri[m][k * 2]);
            minY = std::min(minY, tri[m][k * 2 + 1]); maxY = std::max(maxY, tri[m][k * 2 + 1]);
        }
        if (uv_atlas::detail::orient(&tri[m][0], &tri[m][2], &tri[m][4]) < 0) { std::swap(tri[m][2], tri[m][4]); std::swap(tri[m][3], tri[m][5]); }
        sumArea += area;
    }
    if (minX > maxX) return 0;
    double cell = std::max(std::sqrt(std::max(sumArea, 1e-18) / n) * 2.0, 1e-9);
    int gx = std::clamp(int((maxX - minX) / cell) + 1, 1, 4096), gy = std::clamp(int((maxY - minY) / cell) + 1, 1, 4096);
    double cw = (maxX - minX) / gx + 1e-15, ch = (maxY - minY) / gy + 1e-15;
    std::vector<std::vector<uint32_t>> grid(size_t(gx) * gy);
    std::vector<uint32_t> stamp(n, UINT32_MAX);
    uint64_t pairs = 0;
    for (size_t m = 0; m < n; ++m) {
        if (skip[m]) continue;
        const auto& a = tri[m];
        double bx0 = std::min({a[0], a[2], a[4]}), bx1 = std::max({a[0], a[2], a[4]});
        double by0 = std::min({a[1], a[3], a[5]}), by1 = std::max({a[1], a[3], a[5]});
        int x0 = std::clamp(int((bx0 - minX) / cw), 0, gx - 1), x1 = std::clamp(int((bx1 - minX) / cw), 0, gx - 1);
        int y0 = std::clamp(int((by0 - minY) / ch), 0, gy - 1), y1 = std::clamp(int((by1 - minY) / ch), 0, gy - 1);
        for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) {
            for (uint32_t o : grid[size_t(y) * gx + x]) {
                if (stamp[o] == m) continue;
                stamp[o] = static_cast<uint32_t>(m);
                if (uv_atlas::detail::trianglesOverlap2D(a.data(), tri[o].data())) { if (++pairs >= stopAfter) return pairs; }
            }
        }
        for (int y = y0; y <= y1; ++y) for (int x = x0; x <= x1; ++x) grid[size_t(y) * gx + x].push_back(static_cast<uint32_t>(m));
    }
    return pairs;
}

// =====================================================================================================================
// LSCM
// =====================================================================================================================

struct LscmReport { uint32_t iterations = 0; double relativeResidual = 0; bool converged = false; };

// =====================================================================================================================
// Chart parameterisation beyond LSCM: per-triangle shapes, chart topology, ABF++, Tutte and SLIM
// =====================================================================================================================

namespace param {

/** A triangle in its own plane: corner 0 at the origin, corner 1 on +x, corner 2 above the x axis (metres). */
struct TriShape { double x1 = 0, x2 = 0, y2 = 0; };

inline TriShape shapeOf(const V3& p0, const V3& p1, const V3& p2) {
    TriShape s;
    V3 e1 = sub(p1, p0), e2 = sub(p2, p0);
    V3 n = cross(e1, e2);
    double l1 = len(e1);
    if (len(n) < 1e-18 || l1 < 1e-12) return s;
    V3 x = {e1[0] / l1, e1[1] / l1, e1[2] / l1};
    V3 y = unit(cross(unit(n), x));
    s.x1 = l1; s.x2 = dot(e2, x); s.y2 = dot(e2, y);
    return s;
}

inline double shapeArea(const TriShape& s) { return 0.5 * s.x1 * s.y2; }

/**
 * LSCM (least-squares conformal map, Levy et al. 2002) over per-triangle shapes (the 3D triangles, or the triangles an
 * angle solution describes): preconditioned conjugate gradients on the normal equations, two pinned vertices, warm
 * start from `uv`.
 */
inline LscmReport lscmShapes(const std::vector<TriShape>& shapes, const std::vector<uint32_t>& tris, size_t nV, std::vector<double>& uv,
                             uint32_t pinA, uint32_t pinB, int maxIterations, double relTolerance) {
    // a chart is rebuilt as flat 3D positions per corner is not possible (shapes need not close up), so the solver is
    // run on the per-triangle coefficients directly: c_j = (P_{j+2} - P_{j+1}) / sqrt(A)
    LscmReport rep;
    const size_t nT = tris.size() / 3;
    std::vector<double> cr(nT * 3, 0.0), ci(nT * 3, 0.0);
    for (size_t t = 0; t < nT; ++t) {
        const TriShape& s = shapes[t];
        const double a = shapeArea(s);
        if (!(a > 1e-24)) continue;
        const double lx[3] = {0, s.x1, s.x2}, ly[3] = {0, 0, s.y2};
        const double w = 1.0 / std::sqrt(a);
        for (int j = 0; j < 3; ++j) {
            int k1 = (j + 1) % 3, k2 = (j + 2) % 3;
            cr[t * 3 + j] = (lx[k2] - lx[k1]) * w;
            ci[t * 3 + j] = (ly[k2] - ly[k1]) * w;
        }
    }
    auto applyNormal = [&](const std::vector<double>& x, std::vector<double>& out) {
        std::fill(out.begin(), out.end(), 0.0);
        for (size_t t = 0; t < nT; ++t) {
            double re = 0, im = 0;
            for (int j = 0; j < 3; ++j) {
                uint32_t v = tris[t * 3 + j];
                double u = x[v], w = x[nV + v];
                re += cr[t * 3 + j] * u - ci[t * 3 + j] * w;
                im += ci[t * 3 + j] * u + cr[t * 3 + j] * w;
            }
            for (int j = 0; j < 3; ++j) {
                uint32_t v = tris[t * 3 + j];
                out[v] += cr[t * 3 + j] * re + ci[t * 3 + j] * im;
                out[nV + v] += -ci[t * 3 + j] * re + cr[t * 3 + j] * im;
            }
        }
    };
    std::vector<double> diag(nV * 2, 0.0);
    for (size_t t = 0; t < nT; ++t) for (int j = 0; j < 3; ++j) {
        uint32_t v = tris[t * 3 + j];
        double s = cr[t * 3 + j] * cr[t * 3 + j] + ci[t * 3 + j] * ci[t * 3 + j];
        diag[v] += s; diag[nV + v] += s;
    }
    std::vector<char> pinned(nV * 2, 0);
    pinned[pinA] = pinned[nV + pinA] = pinned[pinB] = pinned[nV + pinB] = 1;
    for (size_t i = 0; i < nV * 2; ++i) if (diag[i] <= 0) pinned[i] = 1;
    std::vector<double> x(nV * 2);
    for (size_t v = 0; v < nV; ++v) { x[v] = uv[v * 2]; x[nV + v] = uv[v * 2 + 1]; }
    std::vector<double> r(nV * 2), z(nV * 2), p(nV * 2), q(nV * 2);
    applyNormal(x, r);
    for (size_t i = 0; i < r.size(); ++i) r[i] = pinned[i] ? 0 : -r[i];
    auto norm = [](const std::vector<double>& a) { double s = 0; for (double v : a) s += v * v; return std::sqrt(s); };
    const double r0 = norm(r);
    const double target = relTolerance * std::max(r0, 1e-300);
    double rz = 0;
    for (size_t i = 0; i < r.size(); ++i) { z[i] = pinned[i] ? 0 : r[i] / diag[i]; rz += r[i] * z[i]; }
    p = z;
    int it = 0;
    double rn = r0;
    for (; it < maxIterations && rn > target && rn > 1e-300; ++it) {
        applyNormal(p, q);
        double pq = 0;
        for (size_t i = 0; i < q.size(); ++i) { if (pinned[i]) q[i] = 0; pq += p[i] * q[i]; }
        if (!(pq > 0)) break;
        double alpha = rz / pq, rzNew = 0, s = 0;
        for (size_t i = 0; i < x.size(); ++i) {
            x[i] += alpha * p[i];
            r[i] -= alpha * q[i];
            z[i] = pinned[i] ? 0 : r[i] / diag[i];
            rzNew += r[i] * z[i];
            s += r[i] * r[i];
        }
        rn = std::sqrt(s);
        double beta = rzNew / rz;
        rz = rzNew;
        for (size_t i = 0; i < p.size(); ++i) p[i] = z[i] + beta * p[i];
    }
    rep.iterations = static_cast<uint32_t>(it);
    rep.relativeResidual = r0 > 0 ? rn / r0 : 0;
    rep.converged = rn <= target || r0 == 0;
    for (size_t v = 0; v < nV; ++v) { uv[v * 2] = x[v]; uv[v * 2 + 1] = x[nV + v]; }
    return rep;
}

/** Topology of a welded chart. */
struct Topology {
    bool manifold = true;              // every edge used at most twice with opposite orientations, every vertex one fan
    std::vector<uint8_t> interior;     // per vertex: closed single fan
    std::vector<std::vector<uint32_t>> boundaryLoops;
    std::vector<std::vector<uint32_t>> neighbours;  // per vertex, unique
    uint32_t interiorCount = 0;
};

inline Topology topologyOf(const std::vector<uint32_t>& tris, size_t nV) {
    Topology top;
    const size_t nT = tris.size() / 3;
    top.interior.assign(nV, 0);
    top.neighbours.assign(nV, {});
    std::unordered_map<uint64_t, uint32_t> directed;  // (a -> b) -> uses
    directed.reserve(nT * 3);
    auto key = [](uint32_t a, uint32_t b) { return (uint64_t(a) << 32) | b; };
    for (size_t t = 0; t < nT; ++t) for (int k = 0; k < 3; ++k) {
        uint32_t a = tris[t * 3 + k], b = tris[t * 3 + (k + 1) % 3];
        if (a == b) { top.manifold = false; continue; }
        if (++directed[key(a, b)] > 1) top.manifold = false;
        top.neighbours[a].push_back(b);
        top.neighbours[b].push_back(a);
    }
    for (auto& n : top.neighbours) { std::sort(n.begin(), n.end()); n.erase(std::unique(n.begin(), n.end()), n.end()); }
    // boundary edges: a -> b without b -> a
    std::vector<uint32_t> nextBoundary(nV, UINT32_MAX);
    std::vector<uint32_t> boundaryOut(nV, 0);
    std::vector<uint32_t> corners(nV, 0);
    for (size_t t = 0; t < nT; ++t) for (int k = 0; k < 3; ++k) ++corners[tris[t * 3 + k]];
    for (auto& [kk, uses] : directed) {
        uint32_t a = uint32_t(kk >> 32), b = uint32_t(kk & 0xffffffffu);
        if (directed.find(key(b, a)) == directed.end()) { nextBoundary[a] = b; ++boundaryOut[a]; }
    }
    for (size_t v = 0; v < nV; ++v) if (boundaryOut[v] > 1) top.manifold = false;
    // interior vertices: no boundary edge and one fan (as many distinct neighbours as corners)
    for (size_t v = 0; v < nV; ++v) {
        if (corners[v] == 0 || boundaryOut[v] > 0) continue;
        bool hasIncomingBoundary = false;
        for (uint32_t u : top.neighbours[v]) if (nextBoundary[u] == v) { hasIncomingBoundary = true; break; }
        if (hasIncomingBoundary) continue;
        if (top.neighbours[v].size() != corners[v]) { top.manifold = false; continue; }
        top.interior[v] = 1;
        ++top.interiorCount;
    }
    // boundary loops
    std::vector<uint8_t> seen(nV, 0);
    for (size_t v = 0; v < nV; ++v) {
        if (nextBoundary[v] == UINT32_MAX || seen[v]) continue;
        std::vector<uint32_t> loop;
        uint32_t c = static_cast<uint32_t>(v);
        while (c != UINT32_MAX && !seen[c]) { seen[c] = 1; loop.push_back(c); c = nextBoundary[c]; }
        if (c != v) top.manifold = false;  // an open chain: non-manifold boundary
        top.boundaryLoops.push_back(std::move(loop));
    }
    return top;
}

inline double cornerAngle(const TriShape& s, int k) {
    const double px[3] = {0, s.x1, s.x2}, py[3] = {0, 0, s.y2};
    const int a = (k + 1) % 3, b = (k + 2) % 3;
    const double ux = px[a] - px[k], uy = py[a] - py[k], vx = px[b] - px[k], vy = py[b] - py[k];
    return std::atan2(std::fabs(ux * vy - uy * vx), ux * vx + uy * vy);
}

struct AbfReport { uint32_t iterations = 0; double residual = 0; bool converged = false; };

/**
 * ABF++ (Sheffer, Levy, Mogilnitsky, Bogomyakov 2005): the corner angles closest (weighted by 1 / beta^2) to the 3D
 * angles, scaled to sum to 2 pi around interior vertices, under the triangle (sum = pi), planarity (sum = 2 pi around
 * an interior vertex) and length (sine law around an interior vertex) constraints. Newton steps on the Lagrangian with
 * the Hessian of the energy only; the triangle constraints are eliminated (their block is diagonal) and the remaining
 * Schur complement over the vertex constraints is solved by preconditioned conjugate gradients.
 */
inline AbfReport abfPlusPlus(const std::vector<TriShape>& shapes, const std::vector<uint32_t>& tris, const Topology& top,
                             std::vector<double>& alpha, int maxIterations = 20, double tolerance = 1e-7) {
    AbfReport rep;
    const size_t nT = tris.size() / 3, nV = top.interior.size();
    const size_t nC = nT * 3;
    const double minAngle = 1.0 * M_PI / 180.0;
    std::vector<double> beta(nC), w(nC);
    for (size_t t = 0; t < nT; ++t) for (int k = 0; k < 3; ++k) beta[t * 3 + k] = std::clamp(cornerAngle(shapes[t], k), minAngle, M_PI - 2 * minAngle);
    std::vector<double> vsum(nV, 0.0);
    for (size_t c = 0; c < nC; ++c) vsum[tris[c]] += beta[c];
    for (size_t c = 0; c < nC; ++c) if (top.interior[tris[c]] && vsum[tris[c]] > 0) beta[c] *= 2 * M_PI / vsum[tris[c]];
    for (size_t c = 0; c < nC; ++c) w[c] = 1.0 / (beta[c] * beta[c]);
    // interior vertex numbering
    std::vector<uint32_t> vi(nV, UINT32_MAX);
    uint32_t nI = 0;
    for (size_t v = 0; v < nV; ++v) if (top.interior[v]) vi[v] = nI++;
    alpha = beta;
    if (nI == 0) {
        // only triangle constraints: closed form per triangle (weighted projection onto sum = pi)
        for (size_t t = 0; t < nT; ++t) {
            double s = 0, iw = 0;
            for (int k = 0; k < 3; ++k) { s += alpha[t * 3 + k]; iw += 1.0 / w[t * 3 + k]; }
            for (int k = 0; k < 3; ++k) alpha[t * 3 + k] -= (s - M_PI) / (w[t * 3 + k] * iw);
        }
        rep.converged = true;
        return rep;
    }
    std::vector<double> lTri(nT, 0.0), lPlan(nI, 0.0), lLen(nI, 0.0);
    std::vector<double> g(nC), cotA(nC), lam(nC), b1(nT), b2(2 * nI), dl2(2 * nI), dl1(nT), dAlpha(nC), y(nC), zc(nC), atri(nT);
    // J2^T x (vertex constraints -> corners) and J2 z (corners -> vertex constraints)
    auto J2T = [&](const std::vector<double>& x, std::vector<double>& outC) {
        for (size_t c = 0; c < nC; ++c) {
            const size_t t = c / 3; const int j = int(c % 3);
            const uint32_t v = tris[c], vPrev = tris[t * 3 + (j + 2) % 3], vNext = tris[t * 3 + (j + 1) % 3];
            double s = 0;
            if (vi[v] != UINT32_MAX) s += x[vi[v]];
            if (vi[vPrev] != UINT32_MAX) s += x[nI + vi[vPrev]] * cotA[c];
            if (vi[vNext] != UINT32_MAX) s -= x[nI + vi[vNext]] * cotA[c];
            outC[c] = s;
        }
    };
    auto J2 = [&](const std::vector<double>& zC, std::vector<double>& out) {
        std::fill(out.begin(), out.end(), 0.0);
        for (size_t c = 0; c < nC; ++c) {
            const size_t t = c / 3; const int j = int(c % 3);
            const uint32_t v = tris[c], vPrev = tris[t * 3 + (j + 2) % 3], vNext = tris[t * 3 + (j + 1) % 3];
            if (vi[v] != UINT32_MAX) out[vi[v]] += zC[c];
            if (vi[vPrev] != UINT32_MAX) out[nI + vi[vPrev]] += cotA[c] * zC[c];
            if (vi[vNext] != UINT32_MAX) out[nI + vi[vNext]] -= cotA[c] * zC[c];
        }
    };
    std::vector<double> tmpC(nC), Cplan(nI), Clen(nI), Ctri(nT);
    for (int it = 0; it < maxIterations; ++it) {
        for (size_t c = 0; c < nC; ++c) cotA[c] = 1.0 / std::tan(alpha[c]);
        // constraints
        std::fill(Cplan.begin(), Cplan.end(), -2 * M_PI);
        std::fill(Clen.begin(), Clen.end(), 0.0);
        for (size_t t = 0; t < nT; ++t) Ctri[t] = alpha[t * 3] + alpha[t * 3 + 1] + alpha[t * 3 + 2] - M_PI;
        for (size_t c = 0; c < nC; ++c) {
            const size_t t = c / 3; const int j = int(c % 3);
            const uint32_t v = tris[c], vPrev = tris[t * 3 + (j + 2) % 3], vNext = tris[t * 3 + (j + 1) % 3];
            const double ls = std::log(std::sin(alpha[c]));
            if (vi[v] != UINT32_MAX) Cplan[vi[v]] += alpha[c];
            if (vi[vPrev] != UINT32_MAX) Clen[vi[vPrev]] += ls;
            if (vi[vNext] != UINT32_MAX) Clen[vi[vNext]] -= ls;
        }
        // gradient of the Lagrangian
        std::vector<double> lam2(2 * nI);
        for (uint32_t i = 0; i < nI; ++i) { lam2[i] = lPlan[i]; lam2[nI + i] = lLen[i]; }
        J2T(lam2, tmpC);
        double res = 0;
        for (size_t c = 0; c < nC; ++c) { g[c] = 2 * w[c] * (alpha[c] - beta[c]) + lTri[c / 3] + tmpC[c]; res += g[c] * g[c]; }
        for (double v : Ctri) res += v * v;
        for (double v : Cplan) res += v * v;
        for (double v : Clen) res += v * v;
        res = std::sqrt(res);
        rep.residual = res;
        rep.iterations = static_cast<uint32_t>(it);
        if (res < tolerance) { rep.converged = true; break; }
        // b = C - J Lambda^-1 g, Lambda = 2w
        for (size_t c = 0; c < nC; ++c) lam[c] = 1.0 / (2 * w[c]);
        for (size_t t = 0; t < nT; ++t) {
            atri[t] = lam[t * 3] + lam[t * 3 + 1] + lam[t * 3 + 2];
            b1[t] = Ctri[t] - (lam[t * 3] * g[t * 3] + lam[t * 3 + 1] * g[t * 3 + 1] + lam[t * 3 + 2] * g[t * 3 + 2]);
        }
        for (size_t c = 0; c < nC; ++c) tmpC[c] = lam[c] * g[c];
        J2(tmpC, b2);
        for (uint32_t i = 0; i < nI; ++i) { b2[i] = Cplan[i] - b2[i]; b2[nI + i] = Clen[i] - b2[nI + i]; }
        // r2 = b2 - J2 Lambda^-1 J1^T A11^-1 b1
        for (size_t c = 0; c < nC; ++c) tmpC[c] = lam[c] * b1[c / 3] / atri[c / 3];
        std::vector<double> r2(2 * nI);
        J2(tmpC, r2);
        for (size_t i = 0; i < 2 * nI; ++i) r2[i] = b2[i] - r2[i];
        // Schur operator S x = J2 P Lambda^-1 J2^T x
        auto applyS = [&](const std::vector<double>& x, std::vector<double>& out) {
            J2T(x, y);
            for (size_t c = 0; c < nC; ++c) y[c] *= lam[c];
            for (size_t t = 0; t < nT; ++t) {
                const double s = (y[t * 3] + y[t * 3 + 1] + y[t * 3 + 2]) / atri[t];
                for (int k = 0; k < 3; ++k) zc[t * 3 + k] = y[t * 3 + k] - lam[t * 3 + k] * s;
            }
            J2(zc, out);
        };
        std::vector<double> dg(2 * nI, 0.0);
        for (size_t c = 0; c < nC; ++c) {
            const size_t t = c / 3; const int j = int(c % 3);
            const uint32_t v = tris[c], vPrev = tris[t * 3 + (j + 2) % 3], vNext = tris[t * 3 + (j + 1) % 3];
            if (vi[v] != UINT32_MAX) dg[vi[v]] += lam[c];
            if (vi[vPrev] != UINT32_MAX) dg[nI + vi[vPrev]] += lam[c] * cotA[c] * cotA[c];
            if (vi[vNext] != UINT32_MAX) dg[nI + vi[vNext]] += lam[c] * cotA[c] * cotA[c];
        }
        for (double& v : dg) v = v > 1e-30 ? v : 1.0;
        // PCG
        std::fill(dl2.begin(), dl2.end(), 0.0);
        std::vector<double> r = r2, zz(2 * nI), pp(2 * nI), qq(2 * nI);
        double rr0 = 0; for (double v : r) rr0 += v * v;
        double rz = 0;
        for (size_t i = 0; i < r.size(); ++i) { zz[i] = r[i] / dg[i]; rz += r[i] * zz[i]; }
        pp = zz;
        // inexact Newton: a relative 1e-6 inner solve, tightened as the outer residual falls
        const double target = std::min(1e-12, res * res) * std::max(rr0, 1e-300);
        for (int k = 0; k < 600; ++k) {
            applyS(pp, qq);
            double pq = 0; for (size_t i = 0; i < pp.size(); ++i) pq += pp[i] * qq[i];
            if (!(pq > 0)) break;
            const double a = rz / pq;
            double rzN = 0, rrN = 0;
            for (size_t i = 0; i < r.size(); ++i) { dl2[i] += a * pp[i]; r[i] -= a * qq[i]; zz[i] = r[i] / dg[i]; rzN += r[i] * zz[i]; rrN += r[i] * r[i]; }
            if (rrN <= target) break;
            const double bta = rzN / rz;
            rz = rzN;
            for (size_t i = 0; i < pp.size(); ++i) pp[i] = zz[i] + bta * pp[i];
        }
        // dl1 = A11^-1 (b1 - J1 Lambda^-1 J2^T dl2)
        J2T(dl2, tmpC);
        for (size_t t = 0; t < nT; ++t) dl1[t] = (b1[t] - (lam[t * 3] * tmpC[t * 3] + lam[t * 3 + 1] * tmpC[t * 3 + 1] + lam[t * 3 + 2] * tmpC[t * 3 + 2])) / atri[t];
        // dAlpha = -Lambda^-1 (g + J^T dl)
        bool finite = true;
        for (size_t c = 0; c < nC; ++c) {
            dAlpha[c] = -lam[c] * (g[c] + dl1[c / 3] + tmpC[c]);
            if (!std::isfinite(dAlpha[c])) finite = false;
        }
        if (!finite) return rep;
        for (size_t c = 0; c < nC; ++c) alpha[c] = std::clamp(alpha[c] + dAlpha[c], 1e-4, M_PI - 1e-4);
        for (size_t t = 0; t < nT; ++t) lTri[t] += dl1[t];
        for (uint32_t i = 0; i < nI; ++i) { lPlan[i] += dl2[i]; lLen[i] += dl2[nI + i]; }
        rep.iterations = static_cast<uint32_t>(it + 1);
    }
    return rep;
}

/** Triangle shapes from corner angles (sine law), each scaled to the area of the 3D triangle it replaces. */
inline std::vector<TriShape> shapesFromAngles(const std::vector<double>& alpha, const std::vector<TriShape>& reference) {
    const size_t nT = reference.size();
    std::vector<TriShape> out(nT);
    for (size_t t = 0; t < nT; ++t) {
        const double a0 = alpha[t * 3], a1 = alpha[t * 3 + 1], a2 = alpha[t * 3 + 2];
        // side opposite corner k is proportional to sin(a_k): |p0 p1| ~ sin a2, |p0 p2| ~ sin a1
        TriShape s;
        const double l01 = std::sin(a2), l02 = std::sin(a1);
        s.x1 = l01; s.x2 = l02 * std::cos(a0); s.y2 = l02 * std::sin(a0);
        const double a = shapeArea(s), aRef = shapeArea(reference[t]);
        const double k = a > 1e-30 && aRef > 0 ? std::sqrt(aRef / a) : 0.0;
        s.x1 *= k; s.x2 *= k; s.y2 *= k;
        out[t] = s;
    }
    return out;
}

/** Tutte embedding: the one boundary loop on a circle by arc length, interior vertices at the mean of their neighbours. */
inline bool tutte(const std::vector<TriShape>& shapes, const std::vector<uint32_t>& tris, const Topology& top, const std::vector<double>& vpos, std::vector<double>& uv) {
    if (!top.manifold || top.boundaryLoops.size() != 1 || top.boundaryLoops[0].size() < 3) return false;
    const size_t nV = top.interior.size();
    double area = 0;
    for (const auto& s : shapes) area += shapeArea(s);
    const double radius = std::sqrt(std::max(area, 1e-24) / M_PI);
    const auto& loop = top.boundaryLoops[0];
    std::vector<double> cum(loop.size() + 1, 0.0);
    auto P = [&](uint32_t v) -> V3 { return {vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2]}; };
    for (size_t i = 0; i < loop.size(); ++i) cum[i + 1] = cum[i] + std::max(len(sub(P(loop[(i + 1) % loop.size()]), P(loop[i]))), 1e-12);
    uv.assign(nV * 2, 0.0);
    std::vector<uint8_t> fixedV(nV, 0);
    for (size_t i = 0; i < loop.size(); ++i) {
        const double a = 2 * M_PI * cum[i] / cum.back();
        uv[loop[i] * 2] = radius * std::cos(a);
        uv[loop[i] * 2 + 1] = radius * std::sin(a);
        fixedV[loop[i]] = 1;
    }
    // vertices that are neither interior nor on the loop (cannot happen on a manifold disk) fail the embedding
    for (size_t v = 0; v < nV; ++v) if (!fixedV[v] && !top.interior[v] && !top.neighbours[v].empty()) return false;
    // uniform Laplacian with Dirichlet boundary, conjugate gradients per coordinate
    for (int axis = 0; axis < 2; ++axis) {
        std::vector<double> x(nV), b(nV, 0.0), r(nV), p(nV), q(nV);
        for (size_t v = 0; v < nV; ++v) x[v] = fixedV[v] ? uv[v * 2 + axis] : 0.0;
        auto apply = [&](const std::vector<double>& in, std::vector<double>& out) {
            for (size_t v = 0; v < nV; ++v) {
                if (fixedV[v] || top.neighbours[v].empty()) { out[v] = 0; continue; }
                double s = double(top.neighbours[v].size()) * in[v];
                for (uint32_t u : top.neighbours[v]) if (!fixedV[u]) s -= in[u];
                out[v] = s;
            }
        };
        for (size_t v = 0; v < nV; ++v) {
            if (fixedV[v] || top.neighbours[v].empty()) continue;
            for (uint32_t u : top.neighbours[v]) if (fixedV[u]) b[v] += uv[u * 2 + axis];
        }
        std::vector<double> xi(nV, 0.0);
        apply(xi, q);
        for (size_t v = 0; v < nV; ++v) r[v] = b[v] - q[v];
        p = r;
        double rr = 0; for (double v : r) rr += v * v;
        const double target = 1e-24 * std::max(rr, 1e-300);
        for (int it = 0; it < 20000 && rr > target; ++it) {
            apply(p, q);
            double pq = 0; for (size_t v = 0; v < nV; ++v) pq += p[v] * q[v];
            if (!(pq > 0)) break;
            const double a = rr / pq;
            double rrN = 0;
            for (size_t v = 0; v < nV; ++v) { xi[v] += a * p[v]; r[v] -= a * q[v]; rrN += r[v] * r[v]; }
            const double bta = rrN / rr;
            rr = rrN;
            for (size_t v = 0; v < nV; ++v) p[v] = r[v] + bta * p[v];
        }
        for (size_t v = 0; v < nV; ++v) if (!fixedV[v]) uv[v * 2 + axis] = xi[v];
    }
    (void)tris;
    return true;
}

/** Signed doubled UV area of each triangle. */
inline double uvDet(const std::vector<double>& uv, const uint32_t* t) {
    const double* a = &uv[t[0] * 2]; const double* b = &uv[t[1] * 2]; const double* c = &uv[t[2] * 2];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Flips against the chart's majority orientation; degenerate UV triangles count as flipped. */
inline uint32_t countFlips(const std::vector<double>& uv, const std::vector<uint32_t>& tris, const std::vector<TriShape>& shapes, double* orientationOut = nullptr) {
    const size_t nT = tris.size() / 3;
    double signedSum = 0;
    for (size_t t = 0; t < nT; ++t) signedSum += uvDet(uv, &tris[t * 3]);
    const double o = signedSum >= 0 ? 1.0 : -1.0;
    if (orientationOut) *orientationOut = o;
    uint32_t f = 0;
    for (size_t t = 0; t < nT; ++t) if (shapeArea(shapes[t]) > 1e-24 && !(uvDet(uv, &tris[t * 3]) * o > 0)) ++f;
    return f;
}

struct SlimReport { uint32_t iterations = 0; double energyStart = 0, energyEnd = 0; bool ok = false; };

/**
 * SLIM (Rabinovich, Lipman, Sorkine-Hornung 2017) on the symmetric Dirichlet energy sum A (s1^2 + s1^-2 + s2^2 + s2^-2):
 * each iteration fits a reweighted ARAP proxy per triangle (closest rotation R = U V^T, weights from dD/ds over 2 (s - 1),
 * which for this energy is (s + 1)(s^2 + 1) / s^3) and solves the global weighted least squares (conjugate gradients,
 * warm start, a tiny proximal term fixes the translation), then takes a flip-free line search along the step: the
 * largest step before any triangle degenerates (a quadratic per triangle) times 0.8, halved until the energy drops.
 * `uv` must start with every triangle positively oriented; it stays so.
 */
inline SlimReport slim(const std::vector<TriShape>& shapes, const std::vector<uint32_t>& tris, size_t nV, std::vector<double>& uv,
                       int maxIterations = 30, double relStop = 1e-4) {
    SlimReport rep;
    const size_t nT = tris.size() / 3;
    std::vector<double> A(nT), gx(nT * 3, 0.0), gy(nT * 3, 0.0);
    std::vector<uint8_t> live(nT, 0);
    double totalA = 0;
    for (size_t t = 0; t < nT; ++t) {
        const TriShape& s = shapes[t];
        A[t] = shapeArea(s);
        if (!(A[t] > 1e-24) || std::fabs(s.x1) < 1e-15 || std::fabs(s.y2) < 1e-15) continue;
        live[t] = 1;
        totalA += A[t];
        gx[t * 3] = -1 / s.x1; gx[t * 3 + 1] = 1 / s.x1; gx[t * 3 + 2] = 0;
        gy[t * 3] = s.x2 / (s.x1 * s.y2) - 1 / s.y2; gy[t * 3 + 1] = -s.x2 / (s.x1 * s.y2); gy[t * 3 + 2] = 1 / s.y2;
    }
    if (!(totalA > 0)) return rep;
    for (size_t t = 0; t < nT; ++t) if (live[t] && !(uvDet(uv, &tris[t * 3]) > 0)) return rep;
    auto jac = [&](const std::vector<double>& x, size_t t, double J[4]) {
        J[0] = J[1] = J[2] = J[3] = 0;
        for (int k = 0; k < 3; ++k) {
            const uint32_t v = tris[t * 3 + k];
            J[0] += gx[t * 3 + k] * x[v * 2]; J[1] += gy[t * 3 + k] * x[v * 2];
            J[2] += gx[t * 3 + k] * x[v * 2 + 1]; J[3] += gy[t * 3 + k] * x[v * 2 + 1];
        }
    };
    auto energy = [&](const std::vector<double>& x) {
        double e = 0;
        for (size_t t = 0; t < nT; ++t) {
            if (!live[t]) continue;
            double J[4]; jac(x, t, J);
            const double det = J[0] * J[3] - J[1] * J[2];
            if (!(det > 0)) return HUGE_VAL;
            const double fro = J[0] * J[0] + J[1] * J[1] + J[2] * J[2] + J[3] * J[3];
            // s1^2 + s2^2 = |J|^2, s1^-2 + s2^-2 = |J|^2 / det^2
            e += A[t] * (fro + fro / (det * det));
        }
        return e / totalA;
    };
    double E = energy(uv);
    rep.energyStart = E;
    if (!std::isfinite(E)) return rep;
    std::vector<double> M(nT * 4), R(nT * 4), target(nV * 2), b(nV * 2), r(nV * 2), z(nV * 2), p(nV * 2), q(nV * 2), diag(nV * 2), d(nV * 2), trial(nV * 2);
    for (int it = 0; it < maxIterations; ++it) {
        // local step
        for (size_t t = 0; t < nT; ++t) {
            if (!live[t]) continue;
            double J[4]; jac(uv, t, J);
            const double Ee = (J[0] + J[3]) / 2, F = (J[0] - J[3]) / 2, G = (J[2] + J[1]) / 2, H = (J[2] - J[1]) / 2;
            const double Qv = std::hypot(Ee, H), Rv = std::hypot(F, G);
            const double s1 = Qv + Rv, s2 = std::max(Qv - Rv, 1e-12);
            const double a1 = std::atan2(G, F), a2 = std::atan2(H, Ee);
            const double phi = (a2 + a1) / 2;  // U = rot(phi); R = rot(a2)
            const double cr = std::cos(a2), sr = std::sin(a2);
            R[t * 4] = cr; R[t * 4 + 1] = -sr; R[t * 4 + 2] = sr; R[t * 4 + 3] = cr;
            auto wgt = [](double s) { return (s + 1) * (s * s + 1) / (s * s * s); };  // squared weight
            const double w1 = wgt(s1), w2 = wgt(s2);
            const double cu = std::cos(phi), su = std::sin(phi);
            // M = U diag(w1, w2) U^T
            M[t * 4] = w1 * cu * cu + w2 * su * su;
            M[t * 4 + 1] = M[t * 4 + 2] = (w1 - w2) * cu * su;
            M[t * 4 + 3] = w1 * su * su + w2 * cu * cu;
        }
        // global step: sum 2A J*(M J(x)) + 2 mu x = sum 2A J*(M R) + 2 mu x_cur
        double meanDiag = 0;
        std::fill(diag.begin(), diag.end(), 0.0);
        std::fill(b.begin(), b.end(), 0.0);
        for (size_t t = 0; t < nT; ++t) {
            if (!live[t]) continue;
            const double* m = &M[t * 4]; const double* rr = &R[t * 4];
            const double K[4] = {m[0] * rr[0] + m[1] * rr[2], m[0] * rr[1] + m[1] * rr[3], m[2] * rr[0] + m[3] * rr[2], m[2] * rr[1] + m[3] * rr[3]};
            for (int k = 0; k < 3; ++k) {
                const uint32_t v = tris[t * 3 + k];
                const double ax = gx[t * 3 + k], ay = gy[t * 3 + k];
                b[v * 2] += 2 * A[t] * (K[0] * ax + K[1] * ay);
                b[v * 2 + 1] += 2 * A[t] * (K[2] * ax + K[3] * ay);
                diag[v * 2] += 2 * A[t] * m[0] * (ax * ax + ay * ay);
                diag[v * 2 + 1] += 2 * A[t] * m[3] * (ax * ax + ay * ay);
            }
        }
        for (double v : diag) meanDiag += v;
        meanDiag /= double(diag.size());
        const double mu = 1e-8 * std::max(meanDiag, 1e-30);
        for (size_t i = 0; i < nV * 2; ++i) { b[i] += 2 * mu * uv[i]; diag[i] += 2 * mu; if (!(diag[i] > 0)) diag[i] = 1; }
        auto applyH = [&](const std::vector<double>& x, std::vector<double>& out) {
            for (size_t i = 0; i < nV * 2; ++i) out[i] = 2 * mu * x[i];
            for (size_t t = 0; t < nT; ++t) {
                if (!live[t]) continue;
                double J[4]; jac(x, t, J);
                const double* m = &M[t * 4];
                const double K[4] = {m[0] * J[0] + m[1] * J[2], m[0] * J[1] + m[1] * J[3], m[2] * J[0] + m[3] * J[2], m[2] * J[1] + m[3] * J[3]};
                for (int k = 0; k < 3; ++k) {
                    const uint32_t v = tris[t * 3 + k];
                    const double ax = gx[t * 3 + k], ay = gy[t * 3 + k];
                    out[v * 2] += 2 * A[t] * (K[0] * ax + K[1] * ay);
                    out[v * 2 + 1] += 2 * A[t] * (K[2] * ax + K[3] * ay);
                }
            }
        };
        target = uv;
        applyH(target, q);
        double rr = 0, bb = 0;
        for (size_t i = 0; i < nV * 2; ++i) { r[i] = b[i] - q[i]; rr += r[i] * r[i]; bb += b[i] * b[i]; }
        double rz = 0;
        for (size_t i = 0; i < nV * 2; ++i) { z[i] = r[i] / diag[i]; rz += r[i] * z[i]; }
        p = z;
        const double tol2 = 1e-12 * std::max(bb, 1e-300);
        for (int k = 0; k < 300 && rr > tol2; ++k) {
            applyH(p, q);
            double pq = 0; for (size_t i = 0; i < nV * 2; ++i) pq += p[i] * q[i];
            if (!(pq > 0)) break;
            const double a = rz / pq;
            double rzN = 0; rr = 0;
            for (size_t i = 0; i < nV * 2; ++i) { target[i] += a * p[i]; r[i] -= a * q[i]; z[i] = r[i] / diag[i]; rzN += r[i] * z[i]; rr += r[i] * r[i]; }
            const double bta = rzN / rz;
            rz = rzN;
            for (size_t i = 0; i < nV * 2; ++i) p[i] = z[i] + bta * p[i];
        }
        // flip-free line search
        for (size_t i = 0; i < nV * 2; ++i) d[i] = target[i] - uv[i];
        double tMax = HUGE_VAL;
        for (size_t t = 0; t < nT; ++t) {
            if (!live[t]) continue;
            const uint32_t* id = &tris[t * 3];
            const double ux1 = uv[id[1] * 2] - uv[id[0] * 2], uy1 = uv[id[1] * 2 + 1] - uv[id[0] * 2 + 1];
            const double ux2 = uv[id[2] * 2] - uv[id[0] * 2], uy2 = uv[id[2] * 2 + 1] - uv[id[0] * 2 + 1];
            const double dx1 = d[id[1] * 2] - d[id[0] * 2], dy1 = d[id[1] * 2 + 1] - d[id[0] * 2 + 1];
            const double dx2 = d[id[2] * 2] - d[id[0] * 2], dy2 = d[id[2] * 2 + 1] - d[id[0] * 2 + 1];
            // det(t) = (u1 + t d1) x (u2 + t d2) = qa t^2 + qb t + qc
            const double qa = dx1 * dy2 - dy1 * dx2, qb = ux1 * dy2 - uy1 * dx2 + dx1 * uy2 - dy1 * ux2, qc = ux1 * uy2 - uy1 * ux2;
            double root = HUGE_VAL;
            if (std::fabs(qa) > 1e-300 * std::max(1.0, std::fabs(qc))) {
                const double disc = qb * qb - 4 * qa * qc;
                if (disc >= 0) {
                    const double sq = std::sqrt(disc);
                    const double r1 = (-qb - sq) / (2 * qa), r2 = (-qb + sq) / (2 * qa);
                    const double lo = std::min(r1, r2), hi = std::max(r1, r2);
                    if (lo > 0) root = lo; else if (hi > 0) root = hi;
                }
            } else if (std::fabs(qb) > 0) {
                const double r1 = -qc / qb;
                if (r1 > 0) root = r1;
            }
            tMax = std::min(tMax, root);
        }
        double step = std::min(1.0, 0.8 * tMax);
        double Enew = HUGE_VAL;
        for (int h = 0; h < 12; ++h, step *= 0.5) {
            for (size_t i = 0; i < nV * 2; ++i) trial[i] = uv[i] + step * d[i];
            Enew = energy(trial);
            if (Enew < E) break;
        }
        rep.iterations = static_cast<uint32_t>(it + 1);
        if (!(Enew < E)) break;
        uv.swap(trial);
        const double drop = (E - Enew) / E;
        E = Enew;
        if (drop < relStop) break;
    }
    rep.energyEnd = E;
    rep.ok = std::isfinite(E);
    return rep;
}

}  // namespace param

// =====================================================================================================================
// Unwrap
// =====================================================================================================================

struct UnwrapParams {
    /** Normal tolerance (degrees) charts are grown with before any split. */
    double chartNormalToleranceDeg = 60.0;
    /** Charts under this 3D area merge into a neighbour when their normals allow (uv_atlas semantics). */
    double minIslandAreaM2 = 0.0;
    /** Accepted area-weighted RMS of sigma1 / sigma2 per chart. */
    double maxAngleStretch = 1.25;
    /** Accepted area-weighted RMS of max(r, 1/r), r = local area scale over the chart's mean area scale. */
    double maxAreaDistortion = 1.5;
    /** Tolerance multiplier per split and the floor below which a chart is no longer split. */
    double splitToleranceFactor = 0.6;
    double minToleranceDeg = 1.0;
    int lscmMaxIterations = 4000;
    double lscmRelTolerance = 1e-9;
    // packing
    double texelsPerMeter = 0;     // > 0: requested density
    uint32_t atlasWidth = 0;       // > 0 with atlasHeight: fit this size at the largest density
    uint32_t atlasHeight = 0;
    uint32_t maxSide = 8192;
    uint32_t gutter = 4;
    bool allowRotation = true;
    /**
     * Above this many charts the bitmap packer gives way to the rectangle packer: on a mesh of crumbs (a remesh in
     * hundreds of thousands of pieces) tight rectangles waste less than conservative masks, and the search is long.
     */
    uint32_t bitmapMaxCharts = 30000;
    bool abf = true;
    int slimIterations = 30;
    /** Quarter turns tried by the bitmap packer (1, 2 or 4) when allowRotation. */
    int packRotations = 4;
    uv_atlas::GrowParams grow{};
    /** Chart worker threads (0 = hardware concurrency, capped at 32). */
    uint32_t threads = 0;
};

enum : uint32_t { kMethodOrtho = 0, kMethodLscm = 1, kMethodAbf = 2, kMethodSlim = 3 };

struct ChartReport {
    uint32_t method = kMethodOrtho;
    uint32_t group = 0;
    uint32_t triangles = 0;
    uint32_t splitDepth = 0;
    uint32_t overThreshold = 0;   // accepted while failing the thresholds (single triangle or tolerance floor)
    uint32_t lscmIterations = 0;
    uint32_t abfIterations = 0;
    uint32_t slimIterations = 0;
    ChartDistortion orthoDistortion;
    ChartDistortion distortion;   // of the UVs kept
    double widthM = 0, heightM = 0;
    // packed rect in texels, gutter included
    uint32_t x = 0, y = 0, w = 0, h = 0;
    uint32_t rotated = 0;
};

struct UnwrapResult {
    std::vector<uint32_t> sourceVertex;
    std::vector<float> uv;         // 2 per output vertex, glTF convention (0,0 = top-left corner of the atlas)
    std::vector<uint32_t> indices;
    std::vector<uint32_t> triangleChart;
    std::vector<ChartReport> charts;
    uint32_t width = 0, height = 0;
    double texelsPerMeter = 0;
    double requestedTexelsPerMeter = 0;
    double utilisation = 0;        // UV triangle area / atlas area
    uint64_t overlappingPairs = 0; // inside charts after the unwrap (0 for a valid atlas)
    uint32_t lscmAttempts = 0, lscmAccepted = 0, splits = 0;
    uint32_t abfAccepted = 0, slimAccepted = 0, grownCharts = 0;
    /** The packer used: 1 bitmap masks, 0 rectangles (above bitmapMaxCharts). */
    uint32_t bitmapPacked = 0;
    double msCharts = 0, msPack = 0;
};

namespace detail {

struct Chart {
    std::vector<uint32_t> tris;     // input triangle ids
    std::vector<double> cornerUv;   // 6 per triangle, metres
    double tolDeg = 0;
    uint32_t depth = 0;
};

struct PackRect { uint32_t w = 0, h = 0, x = 0, y = 0; bool rotated = false; };

/** Skyline bottom-left packing into a fixed width. Returns the used height, or UINT32_MAX when a rect is wider than W. */
inline uint32_t skylinePack(std::vector<PackRect>& rects, uint32_t W, bool allowRotation) {
    struct Seg { uint32_t x, y, w; };
    std::vector<Seg> sky{{0, 0, W}};
    std::vector<uint32_t> order(rects.size());
    std::iota(order.begin(), order.end(), 0u);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t a, uint32_t b) {
        uint32_t ma = std::max(rects[a].w, rects[a].h), mb = std::max(rects[b].w, rects[b].h);
        if (ma != mb) return ma > mb;
        return uint64_t(rects[a].w) * rects[a].h > uint64_t(rects[b].w) * rects[b].h;
    });
    uint32_t used = 0;
    for (uint32_t id : order) {
        PackRect& r = rects[id];
        uint64_t bestTop = UINT64_MAX, bestWaste = UINT64_MAX;
        size_t bestSeg = SIZE_MAX; uint32_t bestY = 0; bool bestRot = false;
        for (int rot = 0; rot < (allowRotation && r.w != r.h ? 2 : 1); ++rot) {
            const uint32_t rw = rot ? r.h : r.w, rh = rot ? r.w : r.h;
            if (rw > W) continue;
            for (size_t i = 0; i < sky.size(); ++i) {
                if (sky[i].x + rw > W) break;
                uint32_t y = 0, covered = 0;
                size_t j = i;
                while (covered < rw) { y = std::max(y, sky[j].y); covered += sky[j].w; ++j; }
                uint64_t waste = 0;
                covered = 0;
                for (size_t k = i; k < j; ++k) {
                    uint32_t take = std::min(sky[k].w, rw - covered);
                    waste += uint64_t(y - sky[k].y) * take;
                    covered += take;
                }
                uint64_t top = uint64_t(y) + rh;
                if (top < bestTop || (top == bestTop && waste < bestWaste)) { bestTop = top; bestWaste = waste; bestSeg = i; bestY = y; bestRot = rot; }
            }
        }
        if (bestSeg == SIZE_MAX) return UINT32_MAX;
        r.rotated = bestRot;
        const uint32_t rw = bestRot ? r.h : r.w, rh = bestRot ? r.w : r.h;
        r.x = sky[bestSeg].x; r.y = bestY;
        // replace the covered span with the new segment
        Seg ns{r.x, bestY + rh, rw};
        std::vector<Seg> next;
        next.reserve(sky.size() + 2);
        for (size_t k = 0; k < sky.size(); ++k) {
            const Seg& s = sky[k];
            uint32_t s0 = s.x, s1 = s.x + s.w, n0 = ns.x, n1 = ns.x + ns.w;
            if (s1 <= n0 || s0 >= n1) { next.push_back(s); continue; }
            if (s0 < n0) next.push_back({s0, s.y, n0 - s0});
            if (s0 <= n0 && (next.empty() || next.back().x + next.back().w <= n0)) {
                if (next.empty() || next.back().x != n0 || next.back().y != ns.y) next.push_back(ns);
            }
            if (s1 > n1) next.push_back({n1, s.y, s1 - n1});
        }
        // merge equal-height neighbours
        std::sort(next.begin(), next.end(), [](const Seg& a, const Seg& b) { return a.x < b.x; });
        sky.clear();
        for (const Seg& s : next) {
            if (!sky.empty() && sky.back().y == s.y && sky.back().x + sky.back().w == s.x) sky.back().w += s.w;
            else sky.push_back(s);
        }
        used = std::max<uint32_t>(used, bestY + rh);
    }
    return used;
}

inline uint32_t nextPow2(uint64_t n) { uint32_t p = 1; while (p < n && p < (1u << 31)) p <<= 1; return p; }

/** Convex hull (monotone chain) of 2D points. */
inline std::vector<std::array<double, 2>> convexHull(std::vector<std::array<double, 2>> pts) {
    std::sort(pts.begin(), pts.end());
    pts.erase(std::unique(pts.begin(), pts.end()), pts.end());
    if (pts.size() < 3) return pts;
    std::vector<std::array<double, 2>> h(pts.size() * 2);
    size_t k = 0;
    auto crossz = [](const std::array<double, 2>& o, const std::array<double, 2>& a, const std::array<double, 2>& b) {
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    };
    for (size_t i = 0; i < pts.size(); ++i) { while (k >= 2 && crossz(h[k - 2], h[k - 1], pts[i]) <= 0) --k; h[k++] = pts[i]; }
    for (size_t i = pts.size() - 1, t = k + 1; i-- > 0;) { while (k >= t && crossz(h[k - 2], h[k - 1], pts[i]) <= 0) --k; h[k++] = pts[i]; }
    h.resize(k - 1);
    return h;
}

}  // namespace detail

/** Charts before packing: per chart its triangles and corner UVs in metres (origin at the chart's min corner). */
struct ChartSet {
    std::vector<std::vector<uint32_t>> tris;
    std::vector<std::vector<double>> cornerUv;   // 6 per triangle
    std::vector<ChartReport> reports;            // widthM / heightM set; no packed rect
};

/**
 * The chart stage of unwrap (segmentation, flattening, splits, normalisation to UV area = 3D area, minimum-area
 * rectangle): `out` receives the chart counters and msCharts.
 */
inline ChartSet unwrapCharts(const float* positions, uint32_t vertexCount, const uint32_t* indices, uint32_t triangleCount,
                             const uint32_t* groups, const UnwrapParams& prm, UnwrapResult& out) {
    using clock = std::chrono::steady_clock;
    const auto t0 = clock::now();
    const uint32_t T = triangleCount;
    auto P = [&](uint32_t v) -> V3 { return {positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]}; };
    auto corner = [&](uint32_t t, int k) -> V3 { return P(indices[t * 3 + k]); };
    auto groupOf = [&](uint32_t t) -> uint32_t { return groups ? groups[t] : 0u; };

    // initial charts: buildIslands over everything at the chart tolerance
    std::vector<detail::Chart> work;
    auto islandsToCharts = [&](const std::vector<uint32_t>& tris, double tolDeg, uint32_t depth, bool evictOverlaps) {
        // local vertex set of these triangles (source vertex ids), positions copied
        std::unordered_map<uint32_t, uint32_t> local;
        std::vector<float> pos;
        std::vector<uint32_t> idx(tris.size() * 3), grp(tris.size());
        for (size_t k = 0; k < tris.size(); ++k) {
            grp[k] = groupOf(tris[k]);
            for (int c = 0; c < 3; ++c) {
                uint32_t v = indices[tris[k] * 3 + c];
                auto it = local.find(v);
                if (it == local.end()) {
                    it = local.emplace(v, static_cast<uint32_t>(local.size())).first;
                    pos.push_back(positions[v * 3]); pos.push_back(positions[v * 3 + 1]); pos.push_back(positions[v * 3 + 2]);
                }
                idx[k * 3 + c] = it->second;
            }
        }
        uv_atlas::Params ip;
        ip.normalToleranceDeg = tolDeg;
        ip.minIslandAreaM2 = prm.minIslandAreaM2;
        ip.evictOverlaps = evictOverlaps;
        auto r = uv_atlas::buildIslands(pos.data(), static_cast<uint32_t>(pos.size() / 3), idx.data(), static_cast<uint32_t>(tris.size()), grp.data(), ip);
        std::vector<detail::Chart> charts(r.islands.size());
        for (auto& c : charts) { c.tolDeg = tolDeg; c.depth = depth; }
        for (size_t k = 0; k < tris.size(); ++k) {
            auto& c = charts[r.triangleIsland[k]];
            c.tris.push_back(tris[k]);
            for (int j = 0; j < 3; ++j) {
                uint32_t ov = r.indices[k * 3 + j];
                c.cornerUv.push_back(r.uv[ov * 2]);
                c.cornerUv.push_back(r.uv[ov * 2 + 1]);
            }
        }
        return charts;
    };
    {
        // grown charts, each projected orthographically on its proxy plane as the starting UVs
        auto g = uv_atlas::growCharts(positions, vertexCount, indices, T, groups, prm.grow);
        work.resize(g.chartNormal.size());
        for (auto& c : work) { c.tolDeg = prm.chartNormalToleranceDeg; c.depth = 0; }
        std::vector<std::array<V3, 2>> basis(g.chartNormal.size());
        for (size_t c = 0; c < basis.size(); ++c) {
            const V3 n = g.chartNormal[c];
            const V3 axis = std::fabs(n[0]) < 0.9 ? V3{1, 0, 0} : V3{0, 1, 0};
            const V3 a = unit(cross(n, axis));
            basis[c] = {a, cross(n, a)};
        }
        for (uint32_t t = 0; t < T; ++t) {
            auto& c = work[g.triangleChart[t]];
            c.tris.push_back(t);
            for (int j = 0; j < 3; ++j) {
                const V3 p = corner(t, j);
                c.cornerUv.push_back(dot(p, basis[g.triangleChart[t]][0]));
                c.cornerUv.push_back(dot(p, basis[g.triangleChart[t]][1]));
            }
        }
        out.grownCharts = static_cast<uint32_t>(work.size());
    }

    auto passes = [&](const ChartDistortion& d) {
        return d.flipped == 0 && d.stretchRms <= prm.maxAngleStretch && d.areaRms <= prm.maxAreaDistortion;
    };

    // edge-connected pieces of a chart (edges welded on bit-identical positions), as indices into `tris`
    auto edgeComponents = [&](const std::vector<uint32_t>& tris) {
        std::unordered_map<std::array<uint32_t, 3>, uint32_t, uv_atlas::detail::KeyHash> weld;
        auto id = [&](uint32_t v) {
            std::array<uint32_t, 3> key;
            for (int a = 0; a < 3; ++a) { float f = positions[v * 3 + a]; if (f == 0.0f) f = 0.0f; std::memcpy(&key[a], &f, 4); }
            return weld.emplace(key, static_cast<uint32_t>(weld.size())).first->second;
        };
        std::vector<uint32_t> parent(tris.size());
        std::iota(parent.begin(), parent.end(), 0u);
        auto root = [&](uint32_t x) { while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        std::unordered_map<uint64_t, uint32_t> edgeOwner;
        for (uint32_t k = 0; k < tris.size(); ++k) for (int j = 0; j < 3; ++j) {
            uint32_t a = id(indices[tris[k] * 3 + j]), b = id(indices[tris[k] * 3 + (j + 1) % 3]);
            if (a == b) continue;
            const uint64_t key = a < b ? (uint64_t(a) << 32 | b) : (uint64_t(b) << 32 | a);
            auto [it, fresh] = edgeOwner.emplace(key, k);
            if (!fresh) parent[root(k)] = root(it->second);
        }
        std::unordered_map<uint32_t, uint32_t> label;
        std::vector<std::vector<uint32_t>> parts;
        for (uint32_t k = 0; k < tris.size(); ++k) {
            auto [it, fresh] = label.emplace(root(k), static_cast<uint32_t>(parts.size()));
            if (fresh) parts.emplace_back();
            parts[it->second].push_back(k);
        }
        return parts;
    };

    // LSCM, then ABF++ (angle-based LSCM from its angles), then SLIM from the best flip-free map (else a Tutte embedding)
    auto flattenChart = [&](const detail::Chart& c, std::vector<double>& cornerOut, ChartReport& rep) -> bool {
        std::unordered_map<std::array<uint32_t, 3>, uint32_t, uv_atlas::detail::KeyHash> weld;
        std::vector<double> vpos, vuv;
        std::vector<uint32_t> tris(c.tris.size() * 3);
        for (size_t k = 0; k < c.tris.size(); ++k) for (int j = 0; j < 3; ++j) {
            uint32_t v = indices[c.tris[k] * 3 + j];
            std::array<uint32_t, 3> key;
            for (int a = 0; a < 3; ++a) { float f = positions[v * 3 + a]; if (f == 0.0f) f = 0.0f; std::memcpy(&key[a], &f, 4); }
            auto it = weld.find(key);
            if (it == weld.end()) {
                it = weld.emplace(key, static_cast<uint32_t>(vpos.size() / 3)).first;
                for (int a = 0; a < 3; ++a) vpos.push_back(positions[v * 3 + a]);
                vuv.push_back(c.cornerUv[k * 6 + j * 2]); vuv.push_back(c.cornerUv[k * 6 + j * 2 + 1]);
            }
            tris[k * 3 + j] = it->second;
        }
        const size_t nV = vpos.size() / 3, nT = c.tris.size();
        if (nV < 3) return false;
        std::vector<param::TriShape> shapes(nT);
        auto VP = [&](uint32_t v) -> V3 { return {vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2]}; };
        for (size_t t = 0; t < nT; ++t) shapes[t] = param::shapeOf(VP(tris[t * 3]), VP(tris[t * 3 + 1]), VP(tris[t * 3 + 2]));
        const param::Topology top = param::topologyOf(tris, nV);
        double minU = 1e300, maxU = -1e300, minV = 1e300, maxV = -1e300;
        for (size_t v = 0; v < nV; ++v) { minU = std::min(minU, vuv[v * 2]); maxU = std::max(maxU, vuv[v * 2]); minV = std::min(minV, vuv[v * 2 + 1]); maxV = std::max(maxV, vuv[v * 2 + 1]); }
        const int axis = (maxU - minU) >= (maxV - minV) ? 0 : 1;
        uint32_t pinA = 0, pinB = 0;
        for (size_t v = 0; v < nV; ++v) {
            if (vuv[v * 2 + axis] < vuv[pinA * 2 + axis]) pinA = static_cast<uint32_t>(v);
            if (vuv[v * 2 + axis] > vuv[pinB * 2 + axis]) pinB = static_cast<uint32_t>(v);
        }
        if (pinA == pinB) return false;
        auto finite = [](const std::vector<double>& u) { for (double x : u) if (!std::isfinite(x)) return false; return true; };
        auto toCorners = [&](const std::vector<double>& u, std::vector<double>& q) {
            q.resize(nT * 6);
            for (size_t k = 0; k < nT; ++k) for (int j = 0; j < 3; ++j) { q[k * 6 + j * 2] = u[tris[k * 3 + j] * 2]; q[k * 6 + j * 2 + 1] = u[tris[k * 3 + j] * 2 + 1]; }
        };
        std::vector<double> best, q;
        double bestStretch = HUGE_VAL;
        uint32_t method = kMethodLscm;
        auto consider = [&](std::vector<double>& u, uint32_t m) {
            if (!finite(u) || param::countFlips(u, tris, shapes) != 0) return;
            toCorners(u, q);
            const double st = chartDistortion(c.tris, q, corner).stretchRms;
            if (st < bestStretch) { bestStretch = st; best = u; method = m; }
        };
        {
            std::vector<double> u = vuv;
            // only a starting map here: a looser tolerance than the LSCM-only path
            auto lr = param::lscmShapes(shapes, tris, nV, u, pinA, pinB, std::min(prm.lscmMaxIterations, 1500), std::max(prm.lscmRelTolerance, 1e-6));
            rep.lscmIterations = lr.iterations;
            consider(u, kMethodLscm);
        }
        if (prm.abf && top.manifold && top.interiorCount > 0) {
            std::vector<double> alpha;
            auto ar = param::abfPlusPlus(shapes, tris, top, alpha);
            rep.abfIterations = ar.iterations;
            bool ok = true;
            for (double a : alpha) if (!std::isfinite(a)) { ok = false; break; }
            if (ok) {
                auto shapesA = param::shapesFromAngles(alpha, shapes);
                std::vector<double> u = vuv;
                param::lscmShapes(shapesA, tris, nV, u, pinA, pinB, std::min(prm.lscmMaxIterations, 2000), std::max(prm.lscmRelTolerance, 1e-7));
                consider(u, kMethodAbf);
            }
        }
        if (prm.slimIterations > 0) {
            std::vector<double> init = best;
            if (init.empty()) {
                if (param::tutte(shapes, tris, top, vpos, init) && !(finite(init) && param::countFlips(init, tris, shapes) == 0)) init.clear();
            }
            if (!init.empty()) {
                double orient = 1;
                param::countFlips(init, tris, shapes, &orient);
                if (orient < 0) for (size_t v = 0; v < nV; ++v) init[v * 2] = -init[v * 2];
                double a3 = 0, a2 = 0;
                for (size_t t = 0; t < nT; ++t) { a3 += param::shapeArea(shapes[t]); a2 += 0.5 * param::uvDet(init, &tris[t * 3]); }
                const double sc = a2 > 0 && a3 > 0 ? std::sqrt(a3 / a2) : 1.0;
                for (double& x : init) x *= sc;
                auto sr = param::slim(shapes, tris, nV, init, prm.slimIterations);
                rep.slimIterations = sr.iterations;
                if (sr.ok && finite(init) && param::countFlips(init, tris, shapes) == 0) {
                    toCorners(init, q);
                    const double st = chartDistortion(c.tris, q, corner).stretchRms;
                    // SLIM trades a little angle for area: kept unless it is clearly more angle-distorted
                    if (best.empty() || st <= bestStretch * 1.05 + 1e-9) { bestStretch = st; best = init; method = kMethodSlim; }
                }
            }
        }
        if (best.empty()) return false;
        rep.method = method;
        toCorners(best, cornerOut);
        return true;
    };

    std::vector<detail::Chart> done;
    std::vector<ChartReport> reports;
    struct Outcome {
        bool finished = false;
        detail::Chart chart;
        ChartReport rep;
        std::vector<detail::Chart> pieces;
        uint32_t lscmAttempts = 0, lscmAccepted = 0, abfAccepted = 0, slimAccepted = 0, splits = 0;
        void finish(detail::Chart&& c, const ChartReport& r) { finished = true; chart = std::move(c); rep = r; }
    };
    auto process = [&](detail::Chart c, Outcome& o) {
        if (c.tris.size() == 1) {
            // a lone triangle is laid out isometrically in its own plane (distortion exactly 1)
            V3 p0 = corner(c.tris[0], 0), p1 = corner(c.tris[0], 1), p2 = corner(c.tris[0], 2);
            V3 e1 = sub(p1, p0), e2 = sub(p2, p0);
            double l1 = len(e1);
            V3 n = cross(e1, e2);
            if (l1 > 1e-12 && len(n) > 1e-18) {
                V3 x = {e1[0] / l1, e1[1] / l1, e1[2] / l1}, y = unit(cross(unit(n), x));
                c.cornerUv = {0, 0, l1, 0, dot(e2, x), dot(e2, y)};
            }
        }
        ChartReport rep;
        rep.group = groupOf(c.tris[0]);
        rep.triangles = static_cast<uint32_t>(c.tris.size());
        rep.splitDepth = c.depth;
        rep.orthoDistortion = chartDistortion(c.tris, c.cornerUv, corner);
        const bool orthoOverlaps = countOverlappingPairs(c.cornerUv) > 0;
        const bool orthoIsometric = rep.orthoDistortion.flipped == 0 && rep.orthoDistortion.stretchRms <= 1.001 && rep.orthoDistortion.areaRms <= 1.001;
        if (c.tris.size() > 1) {
            // a chart in several edge-connected pieces (merged islands) is flattened piece by piece: the solvers fix
            // translation per chart, so loose pieces would drift apart
            auto parts = edgeComponents(c.tris);
            if (parts.size() > 1) {
                ++o.splits;
                for (auto& part : parts) {
                    detail::Chart piece;
                    piece.tolDeg = c.tolDeg; piece.depth = c.depth + 1;
                    for (uint32_t k : part) {
                        piece.tris.push_back(c.tris[k]);
                        piece.cornerUv.insert(piece.cornerUv.end(), c.cornerUv.begin() + k * 6, c.cornerUv.begin() + k * 6 + 6);
                    }
                    o.pieces.push_back(std::move(piece));
                }
                return;
            }
        }
        if (c.tris.size() > 1 && !(orthoIsometric && !orthoOverlaps)) {
            std::vector<double> flat;
            ++o.lscmAttempts;
            ChartReport fr = rep;
            if (flattenChart(c, flat, fr)) {
                ChartDistortion df = chartDistortion(c.tris, flat, corner);
                if (passes(df) && countOverlappingPairs(flat) == 0) {
                    if (fr.method == kMethodSlim) ++o.slimAccepted;
                    else if (fr.method == kMethodAbf) ++o.abfAccepted;
                    else ++o.lscmAccepted;
                    fr.distortion = df;
                    c.cornerUv.swap(flat);
                    o.finish(std::move(c), fr);
                    return;
                }
            }
        }
        if (!orthoOverlaps && passes(rep.orthoDistortion)) {
            rep.distortion = rep.orthoDistortion;
            o.finish(std::move(c), rep);
            return;
        }
        // split at a smaller tolerance; a chart that no tolerance splits keeps its orthographic UVs
        bool split = false;
        double tol = c.tolDeg;
        if (orthoOverlaps && c.tris.size() > 1) {
            // same tolerance with overlap eviction first: the orthographic pieces never overlap
            auto pieces = islandsToCharts(c.tris, tol, c.depth + 1, true);
            if (pieces.size() > 1) {
                ++o.splits;
                for (auto& p : pieces) o.pieces.push_back(std::move(p));
                return;
            }
        }
        while (c.tris.size() > 1 && tol * prm.splitToleranceFactor >= prm.minToleranceDeg) {
            tol *= prm.splitToleranceFactor;
            auto pieces = islandsToCharts(c.tris, tol, c.depth + 1, true);
            if (pieces.size() > 1) {
                ++o.splits;
                for (auto& p : pieces) o.pieces.push_back(std::move(p));
                split = true;
                break;
            }
        }
        if (split) return;
        if (orthoOverlaps) {
            // nothing above separated the overlapping triangles: lone triangles never overlap
            ++o.splits;
            for (size_t k = 0; k < c.tris.size(); ++k) {
                detail::Chart one;
                one.tris = {c.tris[k]};
                one.cornerUv.assign(c.cornerUv.begin() + k * 6, c.cornerUv.begin() + k * 6 + 6);
                one.tolDeg = c.tolDeg; one.depth = c.depth + 1;
                o.pieces.push_back(std::move(one));
            }
            return;
        }
        rep.distortion = rep.orthoDistortion;
        rep.overThreshold = 1;
        o.finish(std::move(c), rep);
        };
    // breadth-first batches processed in parallel; results are taken in batch order, so the output does not depend on
    // the thread count
    const unsigned threads = std::max(1u, std::min(prm.threads ? prm.threads : std::thread::hardware_concurrency(), 32u));
    while (!work.empty()) {
        std::vector<detail::Chart> batch;
        batch.swap(work);
        std::vector<Outcome> outcomes(batch.size());
        std::atomic<size_t> next{0};
        auto worker = [&]() { for (size_t i = next++; i < batch.size(); i = next++) process(std::move(batch[i]), outcomes[i]); };
        const unsigned n = static_cast<unsigned>(std::min<size_t>(threads, batch.size()));
        if (n <= 1) worker();
        else {
            std::vector<std::thread> pool;
            for (unsigned k = 0; k < n; ++k) pool.emplace_back(worker);
            for (auto& th : pool) th.join();
        }
        for (auto& o : outcomes) {
            out.lscmAttempts += o.lscmAttempts; out.lscmAccepted += o.lscmAccepted; out.abfAccepted += o.abfAccepted;
            out.slimAccepted += o.slimAccepted; out.splits += o.splits;
            if (o.finished) { done.push_back(std::move(o.chart)); reports.push_back(o.rep); }
            for (auto& p : o.pieces) work.push_back(std::move(p));
        }
    }
    const auto t1 = clock::now();
    out.msCharts = std::chrono::duration<double, std::milli>(t1 - t0).count();

    // normalise every chart to UV area = 3D area, turn it to its minimum-area rectangle, origin at its min corner
    for (size_t i = 0; i < done.size(); ++i) {
        auto& c = done[i];
        auto& rep = reports[i];
        double s = rep.distortion.area2D > 0 && rep.distortion.area3D > 0 ? std::sqrt(rep.distortion.area3D / rep.distortion.area2D) : 1.0;
        if (rep.distortion.flipped == 0) {
            // charts are emitted counter-clockwise (front faces keep their winding in UV); mirror a clockwise chart
            double signedA = 0;
            for (size_t k = 0; k < c.tris.size(); ++k) signedA += uv_atlas::detail::orient(&c.cornerUv[k * 6], &c.cornerUv[k * 6 + 2], &c.cornerUv[k * 6 + 4]);
            if (signedA < 0) for (size_t k = 0; k < c.tris.size() * 3; ++k) c.cornerUv[k * 2] = -c.cornerUv[k * 2];
        }
        std::vector<std::array<double, 2>> pts(c.tris.size() * 3);
        for (size_t k = 0; k < pts.size(); ++k) { c.cornerUv[k * 2] *= s; c.cornerUv[k * 2 + 1] *= s; pts[k] = {c.cornerUv[k * 2], c.cornerUv[k * 2 + 1]}; }
        auto hull = detail::convexHull(pts);
        double bestArea = 1e300, bestAng = 0;
        auto tryAngle = [&](double ang) {
            double ca = std::cos(ang), sa = std::sin(ang);
            double x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
            for (auto& p : hull) { double x = p[0] * ca + p[1] * sa, y = -p[0] * sa + p[1] * ca; x0 = std::min(x0, x); x1 = std::max(x1, x); y0 = std::min(y0, y); y1 = std::max(y1, y); }
            double a = (x1 - x0) * (y1 - y0);
            if (a < bestArea - 1e-15) { bestArea = a; bestAng = ang; }
        };
        tryAngle(0);
        for (size_t k = 0; k < hull.size(); ++k) {
            const auto& a = hull[k];
            const auto& b = hull[(k + 1) % hull.size()];
            tryAngle(std::atan2(b[1] - a[1], b[0] - a[0]));
        }
        double ca = std::cos(bestAng), sa = std::sin(bestAng);
        double x0 = 1e300, x1 = -1e300, y0 = 1e300, y1 = -1e300;
        for (size_t k = 0; k < pts.size(); ++k) {
            double x = c.cornerUv[k * 2] * ca + c.cornerUv[k * 2 + 1] * sa, y = -c.cornerUv[k * 2] * sa + c.cornerUv[k * 2 + 1] * ca;
            c.cornerUv[k * 2] = x; c.cornerUv[k * 2 + 1] = y;
            x0 = std::min(x0, x); x1 = std::max(x1, x); y0 = std::min(y0, y); y1 = std::max(y1, y);
        }
        for (size_t k = 0; k < pts.size(); ++k) { c.cornerUv[k * 2] -= x0; c.cornerUv[k * 2 + 1] -= y0; }
        rep.widthM = x1 - x0; rep.heightM = y1 - y0;
        // distortion of the final (scaled, rotated) UVs is the same up to the normalisation already folded in
    }
    ChartSet set;
    set.reports = std::move(reports);
    for (auto& c : done) { set.tris.push_back(std::move(c.tris)); set.cornerUv.push_back(std::move(c.cornerUv)); }
    return set;
}

/**
 * Unwraps one atlas: `positions` (3 per vertex, metres), `indices` (3 per triangle), `groups` (one per triangle, may be
 * null) keep charts inside a group (a glTF primitive). The result's vertices are (source vertex, chart) pairs.
 */
inline UnwrapResult unwrap(const float* positions, uint32_t vertexCount, const uint32_t* indices, uint32_t triangleCount,
                           const uint32_t* groups, const UnwrapParams& prm) {
    using clock = std::chrono::steady_clock;
    UnwrapResult out;
    const uint32_t T = triangleCount;
    ChartSet set = unwrapCharts(positions, vertexCount, indices, triangleCount, groups, prm, out);
    std::vector<detail::Chart> done(set.tris.size());
    for (size_t i = 0; i < done.size(); ++i) { done[i].tris = std::move(set.tris[i]); done[i].cornerUv = std::move(set.cornerUv[i]); }
    std::vector<ChartReport>& reports = set.reports;

    // packing
    const auto t2 = clock::now();
    const uint32_t G = prm.gutter;
    double total3D = 0;
    for (auto& r : reports) total3D += r.distortion.area3D;
    std::vector<detail::PackRect> rects(done.size());
    std::vector<uv_atlas::BitmapPlacement> places;   // per packed item (a chart, or a bin of tiny charts)
    struct Binned { uint32_t item = 0; double cx = 0, cy = 0; bool inBin = false; };
    std::vector<Binned> binned(done.size());
    std::vector<double> itemW, itemH;
    double d = prm.texelsPerMeter;
    const bool bitmapPacking = done.size() <= prm.bitmapMaxCharts;
    out.bitmapPacked = bitmapPacking ? 1 : 0;
    if (bitmapPacking) {
        // With many charts the tiny ones are first shelf-packed into small bins at the pack's density (footprints kept a
        // gutter pair apart), and each bin enters the bitmap packer as one item: tens of thousands of crumbs would
        // otherwise each search the whole atlas for a hole.
        std::vector<uv_atlas::BitmapChart> items;
        std::vector<std::vector<double>> binUv;
        std::vector<double> binW, binH;
        auto buildItems = [&](double dd) {
            items.clear(); binUv.clear(); binW.clear(); binH.clear();
            const bool binning = done.size() > 1500;
            const double small = 24.0 * 24.0, binSide = 96.0;
            std::vector<uint32_t> smalls;
            for (size_t i = 0; i < done.size(); ++i) {
                const double fw = reports[i].widthM * dd + 2.0 * G, fh = reports[i].heightM * dd + 2.0 * G;
                if (binning && fw * fh <= small) { smalls.push_back(static_cast<uint32_t>(i)); continue; }
                binned[i] = {static_cast<uint32_t>(items.size()), 0, 0, false};
                uv_atlas::BitmapChart c; c.cornerUv = &done[i].cornerUv; c.widthM = reports[i].widthM; c.heightM = reports[i].heightM;
                items.push_back(c);
            }
            std::stable_sort(smalls.begin(), smalls.end(), [&](uint32_t x, uint32_t y) { return reports[x].heightM > reports[y].heightM; });
            std::vector<std::pair<uint32_t, std::array<double, 2>>> members;
            double shelfX = 0, shelfY = 0, shelfH = 0, usedW = 0;
            const size_t firstBin = items.size();
            auto closeBin = [&]() {
                if (members.empty()) return;
                const double bh = shelfY + shelfH;
                std::vector<double> uvb;
                for (auto& [ci, off] : members) {
                    const auto& q = done[ci].cornerUv;
                    const double hM = reports[ci].heightM;
                    // the member's image coords inside the bin are (off.x + u d, off.y + (hM - v) d); bin metres keep v up
                    for (size_t k = 0; k < q.size(); k += 2) {
                        uvb.push_back((off[0] + q[k] * dd) / dd);
                        uvb.push_back((bh - (off[1] + (hM - q[k + 1]) * dd)) / dd);
                    }
                    binned[ci] = {static_cast<uint32_t>(firstBin + binUv.size()), off[0], off[1], true};
                }
                binUv.push_back(std::move(uvb)); binW.push_back(usedW / dd); binH.push_back(bh / dd);
                members.clear(); shelfX = shelfY = shelfH = usedW = 0;
            };
            for (uint32_t ci : smalls) {
                const double w = reports[ci].widthM * dd, h = reports[ci].heightM * dd;
                if (shelfX > 0 && shelfX + w > binSide) { shelfY += shelfH + 2.0 * G; shelfX = 0; shelfH = 0; }
                if (shelfY > 0 && shelfY + h > binSide) closeBin();
                members.push_back({ci, {shelfX, shelfY}});
                usedW = std::max(usedW, shelfX + w);
                shelfX += std::ceil(w) + 2.0 * G + 1.0;
                shelfH = std::max(shelfH, std::ceil(h) + 1.0);
            }
            closeBin();
            for (size_t k = 0; k < binUv.size(); ++k) {
                uv_atlas::BitmapChart c; c.cornerUv = &binUv[k]; c.widthM = binW[k]; c.heightM = binH[k];
                items.push_back(c);
            }
        };
        uv_atlas::BitmapPackParams bp;
        bp.gutter = G;
        bp.rotations = prm.allowRotation ? prm.packRotations : 1;
        bp.maxSide = prm.maxSide;
        auto packAt = [&](double dd) {
            buildItems(dd);
            bp.texelsPerMeter = dd;
            // one bound on the whole search: few items are searched near exhaustively for holes, many briefly
            bp.searchBudget = std::max<uint64_t>(1000, uint64_t(4e7 / std::max<size_t>(1, items.size())));
            return uv_atlas::packChartsBitmap(items, bp);
        };
        uv_atlas::BitmapPackResult pr;
        // the extent of a pack scales almost linearly with the density (only the gutters do not): one measured pack
        // gives the density that fills a target, and a few small steps settle it
        auto fitTo = [&](double d0, uint32_t W, uint32_t H) {
            bp.aspect = double(W) / H;
            bp.maxSide = std::min<uint32_t>(16384, std::max(W, H) * 2);
            double dd = d0, failed = HUGE_VAL;
            bool found = false;
            for (int it = 0; it < 12; ++it) {
                auto r = packAt(dd);
                const double scale = r.ok ? std::min(double(W) / r.width, double(H) / r.height) : 0.5;
                if (r.ok && r.width <= W && r.height <= H) {
                    d = dd; pr = std::move(r); found = true;
                    // slack left: one step up, never to a density that already failed
                    const double up = std::min(dd * scale * 0.995, failed * 0.995);
                    if (scale < 1.02 || up <= dd * 1.005) return true;
                    dd = up;
                    continue;
                }
                failed = std::min(failed, dd);
                if (found) return true;
                dd *= std::min(0.985, scale * 0.995);
                if (dd <= 1e-9) break;
            }
            return found;
        };
        if (prm.atlasWidth > 0 && prm.atlasHeight > 0) {
            const double hi = total3D > 0 ? std::sqrt(double(prm.atlasWidth) * prm.atlasHeight / total3D) : 1.0;
            if (!fitTo(hi * 0.85, prm.atlasWidth, prm.atlasHeight)) throw std::runtime_error("the charts do not fit the requested atlas size even at a vanishing texel density");
            out.requestedTexelsPerMeter = 0;
            out.width = prm.atlasWidth; out.height = prm.atlasHeight;
        } else {
            if (!(d > 0)) d = total3D > 0 ? std::sqrt(1024.0 * 1024.0 * 0.7 / total3D) : 1.0;
            out.requestedTexelsPerMeter = d;
            bp.maxSide = prm.maxSide;
            pr = packAt(d);
            if (!pr.ok && !fitTo(d, prm.maxSide, prm.maxSide)) throw std::runtime_error("the charts do not fit the maximum atlas side even at a vanishing texel density");
            out.width = std::min(prm.maxSide, std::max<uint32_t>(16, (pr.width + 3) / 4 * 4));
            out.height = std::min(prm.maxSide, std::max<uint32_t>(16, (pr.height + 3) / 4 * 4));
        }
        buildItems(d);  // the items of the density kept
        places = std::move(pr.placements);
        for (const auto& it : items) { itemW.push_back(it.widthM); itemH.push_back(it.heightM); }
        out.texelsPerMeter = d;
    } else {
    auto sizeRects = [&](double d) {
        for (size_t i = 0; i < done.size(); ++i) {
            rects[i].w = static_cast<uint32_t>(std::max(1.0, std::ceil(reports[i].widthM * d - 1e-9))) + 2 * G;
            rects[i].h = static_cast<uint32_t>(std::max(1.0, std::ceil(reports[i].heightM * d - 1e-9))) + 2 * G;
        }
    };
    // smallest power-of-two width that packs under maxH; returns {W, H} or {0, 0}
    auto packAt = [&](double d, uint32_t fixedW, uint32_t maxH) -> std::pair<uint32_t, uint32_t> {
        sizeRects(d);
        uint64_t area = 0; uint32_t widest = 0;
        for (auto& r : rects) { area += uint64_t(r.w) * r.h; widest = std::max({widest, prm.allowRotation ? std::min(r.w, r.h) : r.w}); }
        if (fixedW) {
            uint32_t h = detail::skylinePack(rects, fixedW, prm.allowRotation);
            return h <= maxH ? std::pair<uint32_t, uint32_t>{fixedW, maxH} : std::pair<uint32_t, uint32_t>{0, 0};
        }
        std::pair<uint32_t, uint32_t> best{0, 0};
        uint32_t startW = std::max<uint32_t>(16, detail::nextPow2(std::max<uint64_t>(widest, static_cast<uint64_t>(std::sqrt(double(area))))));
        if (startW > 16) startW /= 2;
        for (uint32_t w = startW; w <= prm.maxSide; w *= 2) {
            uint32_t h = detail::skylinePack(rects, w, prm.allowRotation);
            if (h == UINT32_MAX) continue;
            uint32_t hh = std::max<uint32_t>(16, (h + 3) / 4 * 4);
            // smallest area, with a mild preference for square atlases (elongated ones waste mip levels and limits)
            auto cost = [](uint32_t W2, uint32_t H2) { return double(W2) * H2 * (1.0 + 0.1 * std::fabs(std::log2(double(W2) / H2))); };
            if (hh <= maxH && (best.first == 0 || cost(w, hh) < cost(best.first, best.second))) best = {w, hh};
        }
        if (best.first) detail::skylinePack(rects, best.first, prm.allowRotation);
        return best;
    };
    std::pair<uint32_t, uint32_t> size{0, 0};
    if (prm.atlasWidth > 0 && prm.atlasHeight > 0) {
        // largest density that fits the requested size (bisection; packing is monotone enough in practice)
        double hi = total3D > 0 ? std::sqrt(double(prm.atlasWidth) * prm.atlasHeight / total3D) : 1.0, lo = 0;
        double bestD = 0;
        for (int it = 0; it < 40; ++it) {
            double mid = it == 0 ? hi : 0.5 * (lo + hi);
            auto s = packAt(mid, prm.atlasWidth, prm.atlasHeight);
            if (s.first) { bestD = mid; lo = mid; if (it == 0) break; } else hi = mid;
            if (it > 0 && hi - lo < hi * 1e-3) break;
        }
        if (bestD <= 0) bestD = lo > 0 ? lo : 1e-6;
        d = bestD;
        size = packAt(d, prm.atlasWidth, prm.atlasHeight);
        if (!size.first) { size = {prm.atlasWidth, prm.atlasHeight}; }
        out.requestedTexelsPerMeter = 0;
    } else {
        if (!(d > 0)) d = total3D > 0 ? std::sqrt(1024.0 * 1024.0 * 0.7 / total3D) : 1.0;
        out.requestedTexelsPerMeter = d;
        size = packAt(d, 0, prm.maxSide);
        for (int attempt = 0; !size.first && attempt < 80; ++attempt) {
            uint64_t area = 0;
            for (auto& r : rects) area += uint64_t(r.w) * r.h;
            d *= std::min(0.95, std::sqrt(double(prm.maxSide) * prm.maxSide * 0.7 / std::max<uint64_t>(area, 1)));
            size = packAt(d, 0, prm.maxSide);
        }
        if (!size.first) throw std::runtime_error("the charts do not fit the maximum atlas side even at a vanishing texel density");
    }
    out.width = size.first; out.height = size.second; out.texelsPerMeter = d;
    }
    out.msPack = std::chrono::duration<double, std::milli>(clock::now() - t2).count();

    // emit: output vertices are (source vertex, chart) pairs
    out.charts.resize(done.size());
    out.triangleChart.resize(T);
    out.indices.resize(size_t(T) * 3);
    std::unordered_map<uint64_t, uint32_t> outVertex;
    double uvArea = 0;
    for (size_t i = 0; i < done.size(); ++i) {
        auto& c = done[i];
        auto rep = reports[i];
        const auto& r = rects[i];
        if (bitmapPacking) {
            const auto& pl = places[binned[i].item];
            if (binned[i].inBin) {
                // the chart's own rect inside its bin (the bin's quarter turn applied to the corners)
                double x0 = 1e300, y0 = 1e300, x1 = -1e300, y1 = -1e300;
                const double cxs[2] = {binned[i].cx, binned[i].cx + reports[i].widthM * d}, cys[2] = {binned[i].cy, binned[i].cy + reports[i].heightM * d};
                for (double cx : cxs) for (double cy : cys) {
                    double X, Y;
                    uv_atlas::bitmapTexel(pl, d, G, itemW[binned[i].item], itemH[binned[i].item], cx / d, itemH[binned[i].item] - cy / d, X, Y);
                    x0 = std::min(x0, X); x1 = std::max(x1, X); y0 = std::min(y0, Y); y1 = std::max(y1, Y);
                }
                rep.x = uint32_t(std::max(0.0, std::floor(x0) - G)); rep.y = uint32_t(std::max(0.0, std::floor(y0) - G));
                rep.w = uint32_t(std::ceil(x1 - x0)) + 2 * G; rep.h = uint32_t(std::ceil(y1 - y0)) + 2 * G;
            } else {
                rep.x = pl.x; rep.y = pl.y; rep.w = pl.w; rep.h = pl.h;
            }
            rep.rotated = pl.rotation;
        } else {
            rep.x = r.x; rep.y = r.y; rep.rotated = r.rotated ? 1 : 0;
            rep.w = r.rotated ? r.h : r.w; rep.h = r.rotated ? r.w : r.h;
        }
        const double wM = rep.widthM, hM = rep.heightM;
        for (size_t k = 0; k < c.tris.size(); ++k) {
            const uint32_t t = c.tris[k];
            out.triangleChart[t] = static_cast<uint32_t>(i);
            double px[3][2];
            for (int j = 0; j < 3; ++j) {
                double lu = c.cornerUv[k * 6 + j * 2], lv = c.cornerUv[k * 6 + j * 2 + 1];
                double cw = wM * d, chh = hM * d;
                double X, Y;
                if (bitmapPacking) {
                    const Binned& b = binned[i];
                    if (!b.inBin) uv_atlas::bitmapTexel(places[b.item], d, G, wM, hM, lu, lv, X, Y);
                    else {
                        // the same point in its bin's metres (as the bin was rasterised), then the bin's placement
                        const double ub = (b.cx + lu * d) / d, vb = itemH[b.item] - (b.cy + (hM - lv) * d) / d;
                        uv_atlas::bitmapTexel(places[b.item], d, G, itemW[b.item], itemH[b.item], ub, vb, X, Y);
                    }
                }
                else if (!r.rotated) { X = r.x + G + lu * d; Y = r.y + G + (chh - lv * d); }
                else { X = r.x + G + lv * d; Y = r.y + G + lu * d; (void)cw; }
                px[j][0] = X; px[j][1] = Y;
                const uint32_t v = indices[t * 3 + j];
                const uint64_t key = (uint64_t(v) << 32) | static_cast<uint32_t>(i);
                auto it = outVertex.find(key);
                if (it == outVertex.end()) {
                    it = outVertex.emplace(key, static_cast<uint32_t>(out.sourceVertex.size())).first;
                    out.sourceVertex.push_back(v);
                    out.uv.push_back(static_cast<float>(X / out.width));
                    out.uv.push_back(static_cast<float>(Y / out.height));
                }
                out.indices[size_t(t) * 3 + j] = it->second;
            }
            uvArea += 0.5 * std::fabs((px[1][0] - px[0][0]) * (px[2][1] - px[0][1]) - (px[1][1] - px[0][1]) * (px[2][0] - px[0][0]));
        }
        out.charts[i] = rep;
    }
    out.utilisation = uvArea / (double(out.width) * out.height);
    // overlap audit of the emitted UVs, chart by chart (packing keeps charts apart)
    for (size_t i = 0; i < done.size(); ++i) {
        std::vector<double> q(done[i].tris.size() * 6);
        for (size_t k = 0; k < done[i].tris.size(); ++k) for (int j = 0; j < 3; ++j) {
            uint32_t ov = out.indices[size_t(done[i].tris[k]) * 3 + j];
            q[k * 6 + j * 2] = double(out.uv[ov * 2]) * out.width;
            q[k * 6 + j * 2 + 1] = double(out.uv[ov * 2 + 1]) * out.height;
        }
        out.overlappingPairs += countOverlappingPairs(q, UINT64_MAX, 1e-3);  // texels
    }
    return out;
}

// =====================================================================================================================
// Bake
// =====================================================================================================================

enum : uint32_t { kSlotLinear = 0, kSlotSrgb = 1, kSlotNormal = 2 };
enum : uint32_t { kWrapRepeat = 10497, kWrapClamp = 33071, kWrapMirror = 33648 };

struct Image { uint32_t width = 0, height = 0; std::vector<uint8_t> rgba; };

struct MaterialSlot { int32_t image = -1; uint32_t wrapS = kWrapRepeat, wrapT = kWrapRepeat; float factor[4] = {1, 1, 1, 1}; };

struct BakeMesh {
    std::vector<float> pos, nrm, tan;   // 3, 3, 4 per vertex (tan may be empty when no normal slot)
    std::vector<float> uv;              // per slot: 2 per vertex, slot-major (slot s at s * 2 * V)
    std::vector<uint32_t> idx;          // 3 per triangle
    std::vector<uint32_t> triMaterial;  // one per triangle
    uint32_t vertexCount() const { return static_cast<uint32_t>(pos.size() / 3); }
};

struct BakeParams {
    uint32_t width = 0, height = 0, gutter = 4;
    double edgeTexels = 1.5;            // closest-point ring around triangles
    bool transfer = false;              // false: source triangle == target triangle
    double maxDistance = 0;             // transfer: 0 = unlimited
    double maxNormalAngleDeg = 0;       // transfer: 0 = no normal gate
    std::vector<uint32_t> slotKind;     // one per slot
    uint32_t threads = 0;
};

struct BakeResult {
    std::vector<std::vector<uint8_t>> slots;  // RGBA per slot, width * height * 4
    uint64_t interiorTexels = 0, edgeTexels = 0, dilatedTexels = 0, emptyTexels = 0, unresolvedTexels = 0;
    double meanTransferDistance = 0, maxTransferDistance = 0;
    double msRaster = 0, msShade = 0, msDilate = 0, msBvh = 0;
};

namespace detail {

inline int wrapIndex(int i, int n, uint32_t mode) {
    if (mode == kWrapClamp) return std::clamp(i, 0, n - 1);
    if (mode == kWrapMirror) {
        int period = 2 * n;
        int m = ((i % period) + period) % period;
        return m < n ? m : period - 1 - m;
    }
    return ((i % n) + n) % n;
}

inline void sampleBilinear(const Image& img, uint32_t wrapS, uint32_t wrapT, double u, double v, double out[4]) {
    const int w = static_cast<int>(img.width), h = static_cast<int>(img.height);
    double x = u * w - 0.5, y = v * h - 0.5;
    double fx = std::floor(x), fy = std::floor(y);
    double ax = x - fx, ay = y - fy;
    int x0 = wrapIndex(int(fx), w, wrapS), x1 = wrapIndex(int(fx) + 1, w, wrapS);
    int y0 = wrapIndex(int(fy), h, wrapT), y1 = wrapIndex(int(fy) + 1, h, wrapT);
    const uint8_t* p00 = &img.rgba[(size_t(y0) * w + x0) * 4];
    const uint8_t* p10 = &img.rgba[(size_t(y0) * w + x1) * 4];
    const uint8_t* p01 = &img.rgba[(size_t(y1) * w + x0) * 4];
    const uint8_t* p11 = &img.rgba[(size_t(y1) * w + x1) * 4];
    for (int c = 0; c < 4; ++c)
        out[c] = ((1 - ax) * (1 - ay) * p00[c] + ax * (1 - ay) * p10[c] + (1 - ax) * ay * p01[c] + ax * ay * p11[c]) / 255.0;
}

inline double srgbToLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
inline double linearToSrgb(double c) { c = std::clamp(c, 0.0, 1.0); return c <= 0.0031308 ? 12.92 * c : 1.055 * std::pow(c, 1 / 2.4) - 0.055; }

/** Closest point on triangle (a, b, c) to p; barycentrics in `bary`. Ericson, Real-Time Collision Detection 5.1.5. */
inline V3 closestOnTriangle(const V3& p, const V3& a, const V3& b, const V3& c, double bary[3]) {
    V3 ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    double d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) { bary[0] = 1; bary[1] = 0; bary[2] = 0; return a; }
    V3 bp = sub(p, b);
    double d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) { bary[0] = 0; bary[1] = 1; bary[2] = 0; return b; }
    double vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); bary[0] = 1 - v; bary[1] = v; bary[2] = 0; return {a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]}; }
    V3 cp = sub(p, c);
    double d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) { bary[0] = 0; bary[1] = 0; bary[2] = 1; return c; }
    double vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); bary[0] = 1 - w; bary[1] = 0; bary[2] = w; return {a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]}; }
    double va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        bary[0] = 0; bary[1] = 1 - w; bary[2] = w;
        return {b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])};
    }
    double denom = 1.0 / (va + vb + vc);
    double v = vb * denom, w = vc * denom;
    bary[0] = 1 - v - w; bary[1] = v; bary[2] = w;
    return {a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w};
}

struct Bvh {
    struct Node { float mn[3], mx[3]; int32_t left = -1, right = -1, start = 0, count = 0; };
    std::vector<Node> nodes;
    std::vector<uint32_t> order;
};

inline Bvh buildBvh(const BakeMesh& m) {
    Bvh b;
    const size_t T = m.idx.size() / 3;
    b.order.resize(T);
    std::iota(b.order.begin(), b.order.end(), 0u);
    std::vector<std::array<float, 3>> cen(T);
    std::vector<std::array<float, 6>> box(T);
    for (size_t t = 0; t < T; ++t) {
        std::array<float, 6> bx{1e30f, 1e30f, 1e30f, -1e30f, -1e30f, -1e30f};
        for (int k = 0; k < 3; ++k) {
            uint32_t v = m.idx[t * 3 + k];
            for (int a = 0; a < 3; ++a) { bx[a] = std::min(bx[a], m.pos[v * 3 + a]); bx[3 + a] = std::max(bx[3 + a], m.pos[v * 3 + a]); }
        }
        box[t] = bx;
        for (int a = 0; a < 3; ++a) cen[t][a] = 0.5f * (bx[a] + bx[3 + a]);
    }
    std::function<int32_t(int32_t, int32_t)> build = [&](int32_t s, int32_t e) -> int32_t {
        int32_t id = static_cast<int32_t>(b.nodes.size());
        b.nodes.emplace_back();
        Bvh::Node nd;
        for (int a = 0; a < 3; ++a) { nd.mn[a] = 1e30f; nd.mx[a] = -1e30f; }
        float cmn[3] = {1e30f, 1e30f, 1e30f}, cmx[3] = {-1e30f, -1e30f, -1e30f};
        for (int32_t i = s; i < e; ++i) {
            const auto& bx = box[b.order[i]];
            for (int a = 0; a < 3; ++a) {
                nd.mn[a] = std::min(nd.mn[a], bx[a]); nd.mx[a] = std::max(nd.mx[a], bx[3 + a]);
                cmn[a] = std::min(cmn[a], cen[b.order[i]][a]); cmx[a] = std::max(cmx[a], cen[b.order[i]][a]);
            }
        }
        if (e - s <= 8) { nd.start = s; nd.count = e - s; b.nodes[id] = nd; return id; }
        int axis = 0;
        for (int a = 1; a < 3; ++a) if (cmx[a] - cmn[a] > cmx[axis] - cmn[axis]) axis = a;
        int32_t mid = (s + e) / 2;
        std::nth_element(b.order.begin() + s, b.order.begin() + mid, b.order.begin() + e,
                         [&](uint32_t x, uint32_t y) { return cen[x][axis] < cen[y][axis]; });
        b.nodes[id] = nd;
        int32_t l = build(s, mid);
        int32_t r = build(mid, e);
        b.nodes[id].left = l;
        b.nodes[id].right = r;
        b.nodes[id].count = 0;
        return id;
    };
    if (T) build(0, static_cast<int32_t>(T));
    return b;
}

inline double boxDist2(const Bvh::Node& n, const V3& p) {
    double s = 0;
    for (int a = 0; a < 3; ++a) { double d = std::max({double(n.mn[a]) - p[a], 0.0, p[a] - double(n.mx[a])}); s += d * d; }
    return s;
}

}  // namespace detail

/** Which triangle answers each atlas texel, and where in it: the bake's raster, shared with passes that shade the same atlas. */
struct TexelRaster {
    std::vector<int32_t> owner;   // triangle per texel, -1 empty
    std::vector<float> bary;      // 2 per texel (b0, b1; b2 = 1 - b0 - b1)
    std::vector<uint8_t> state;   // 0 empty, 1 interior, 2 edge ring
    uint64_t interior = 0, edge = 0;
};

/**
 * Rasters triangles `idx` at UVs `uvPx` (texels, 2 per vertex) into a W x H atlas: interior texels take the triangle
 * whose barycentrics are most inside, and texels outside every triangle but within `ring` texels of one take its
 * closest point (an exact gutter ring).
 */
inline TexelRaster rasterTexels(const std::vector<uint32_t>& idx, const std::vector<float>& uvPx, uint32_t W, uint32_t H, double ring) {
    const size_t N = size_t(W) * H;
    const size_t Tt = idx.size() / 3;
    TexelRaster r;
    r.owner.assign(N, -1);
    r.bary.assign(N * 2, 0.0f);
    r.state.assign(N, 0);
    std::vector<int32_t>& owner = r.owner;
    std::vector<float>& bary = r.bary;
    std::vector<uint8_t>& state = r.state;
    std::vector<float> score(N, -1e30f);
    ring = std::max(0.0, ring);
    const std::vector<float>& targetUvPx = uvPx;
    for (size_t t = 0; t < Tt; ++t) {
        const uint32_t ia = idx[t * 3], ib = idx[t * 3 + 1], ic = idx[t * 3 + 2];
        const double A[2] = {targetUvPx[ia * 2], targetUvPx[ia * 2 + 1]}, B[2] = {targetUvPx[ib * 2], targetUvPx[ib * 2 + 1]}, C[2] = {targetUvPx[ic * 2], targetUvPx[ic * 2 + 1]};
        const double den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
        if (std::fabs(den) < 1e-14) continue;
        int x0 = std::max(0, int(std::floor(std::min({A[0], B[0], C[0]}) - ring))), x1 = std::min(int(W) - 1, int(std::ceil(std::max({A[0], B[0], C[0]}) + ring)));
        int y0 = std::max(0, int(std::floor(std::min({A[1], B[1], C[1]}) - ring))), y1 = std::min(int(H) - 1, int(std::ceil(std::max({A[1], B[1], C[1]}) + ring)));
        // edge lengths for the distance of a texel centre outside the triangle (in texels)
        for (int y = y0; y <= y1; ++y) {
            const double py = y + 0.5;
            for (int x = x0; x <= x1; ++x) {
                const double px = x + 0.5;
                double l0 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / den;
                double l1 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / den;
                double l2 = 1 - l0 - l1;
                const size_t i = size_t(y) * W + x;
                double m = std::min({l0, l1, l2});
                if (m >= -1e-9) {
                    if (state[i] == 1 && score[i] >= m) continue;
                    state[i] = 1; owner[i] = static_cast<int32_t>(t); score[i] = static_cast<float>(m);
                    bary[i * 2] = static_cast<float>(l0); bary[i * 2 + 1] = static_cast<float>(l1);
                    continue;
                }
                if (state[i] == 1 || ring <= 0) continue;
                // closest point of the triangle to the texel centre, in texel space
                V3 p{px, py, 0}, a{A[0], A[1], 0}, b{B[0], B[1], 0}, c{C[0], C[1], 0};
                double bc[3];
                V3 q = detail::closestOnTriangle(p, a, b, c, bc);
                double dist = std::hypot(q[0] - px, q[1] - py);
                if (dist > ring) continue;
                if (state[i] == 2 && -score[i] <= dist) continue;
                state[i] = 2; owner[i] = static_cast<int32_t>(t); score[i] = static_cast<float>(-dist);
                bary[i * 2] = static_cast<float>(bc[0]); bary[i * 2 + 1] = static_cast<float>(bc[1]);
            }
        }
    }
    for (size_t i = 0; i < N; ++i) { if (state[i] == 1) ++r.interior; else if (state[i] == 2) ++r.edge; }
    return r;
}

/**
 * Fills the gutter of every slot: texels with `filled` set are kept, the rest within `gutter` texels of them take the
 * mean of their filled 8-neighbours (one ring per pass), and whatever is left takes the slot's mean (a flat normal for
 * normal slots) so mipmaps never bleed towards black. Returns {dilated texels, empty texels}.
 */
inline std::pair<uint64_t, uint64_t> dilateSlots(std::vector<std::vector<uint8_t>>& slots, std::vector<uint8_t> filled, uint32_t W, uint32_t H,
                                                 uint32_t gutter, const std::vector<uint32_t>& slotKind) {
    const size_t N = size_t(W) * H;
    const size_t S = slots.size();
    uint64_t dilated = 0, empty = 0;
    std::vector<uint32_t> add;
    for (uint32_t pass = 0; pass < gutter; ++pass) {
        add.clear();
        for (uint32_t y = 0; y < H; ++y) for (uint32_t x = 0; x < W; ++x) {
            const size_t i = size_t(y) * W + x;
            if (filled[i]) continue;
            for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                int xx = int(x) + dx, yy = int(y) + dy;
                if ((dx || dy) && xx >= 0 && yy >= 0 && xx < int(W) && yy < int(H) && filled[size_t(yy) * W + xx] == 1) { add.push_back(static_cast<uint32_t>(i)); dy = 2; break; }
            }
        }
        for (uint32_t i : add) {
            const int x = int(i % W), y = int(i / W);
            for (size_t s = 0; s < S; ++s) {
                double acc[4] = {0, 0, 0, 0}; int n = 0;
                for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                    int xx = x + dx, yy = y + dy;
                    if ((dx || dy) && xx >= 0 && yy >= 0 && xx < int(W) && yy < int(H) && filled[size_t(yy) * W + xx] == 1) {
                        const uint8_t* q = &slots[s][(size_t(yy) * W + xx) * 4];
                        for (int k = 0; k < 4; ++k) acc[k] += q[k];
                        ++n;
                    }
                }
                for (int k = 0; k < 4; ++k) slots[s][size_t(i) * 4 + k] = static_cast<uint8_t>(std::lround(acc[k] / std::max(n, 1)));
            }
        }
        for (uint32_t i : add) filled[i] = 1;
        dilated += add.size();
    }
    for (size_t s = 0; s < S; ++s) {
        double mean[4] = {0, 0, 0, 0}; uint64_t n = 0;
        for (size_t i = 0; i < N; ++i) if (filled[i]) { for (int k = 0; k < 4; ++k) mean[k] += slots[s][i * 4 + k]; ++n; }
        uint8_t m[4];
        for (int k = 0; k < 4; ++k) m[k] = static_cast<uint8_t>(n ? std::lround(mean[k] / n) : 0);
        if (s < slotKind.size() && slotKind[s] == kSlotNormal) { m[0] = 128; m[1] = 128; m[2] = 255; m[3] = 255; }
        for (size_t i = 0; i < N; ++i) if (!filled[i]) std::copy(m, m + 4, &slots[s][i * 4]);
    }
    for (size_t i = 0; i < N; ++i) if (!filled[i]) ++empty;
    return {dilated, empty};
}

/**
 * Bakes every slot of `source` into the atlas of `target`. In same-mesh mode (`transfer` false) `source` shares the
 * target's triangles and vertices (its uv/tan/nrm arrays are per target vertex); in transfer mode it is another mesh.
 */
inline BakeResult bake(const BakeMesh& target, const std::vector<float>& targetUvPx, const BakeMesh& source,
                       const std::vector<std::vector<MaterialSlot>>& materials, const std::vector<Image>& images, const BakeParams& prm) {
    using clock = std::chrono::steady_clock;
    BakeResult res;
    const uint32_t W = prm.width, H = prm.height;
    const size_t N = size_t(W) * H;
    const size_t S = prm.slotKind.size();
    const uint32_t Vt = target.vertexCount(), Vs = source.vertexCount();

    // 1. raster: owner triangle and barycentrics per texel (interior texels win over the closest-point ring)
    auto ta = clock::now();
    TexelRaster raster = rasterTexels(target.idx, targetUvPx, W, H, prm.edgeTexels);
    const std::vector<int32_t>& owner = raster.owner;
    const std::vector<float>& bary = raster.bary;
    std::vector<uint8_t>& state = raster.state;
    res.interiorTexels = raster.interior;
    res.edgeTexels = raster.edge;
    res.msRaster = std::chrono::duration<double, std::milli>(clock::now() - ta).count();

    // 2. transfer: BVH over the source
    auto tb = clock::now();
    detail::Bvh bvh;
    if (prm.transfer) bvh = detail::buildBvh(source);
    res.msBvh = std::chrono::duration<double, std::milli>(clock::now() - tb).count();
    const double cosGate = prm.maxNormalAngleDeg > 0 ? std::cos(prm.maxNormalAngleDeg * M_PI / 180.0) : -2.0;
    const double maxD2 = prm.maxDistance > 0 ? prm.maxDistance * prm.maxDistance : std::numeric_limits<double>::infinity();

    res.slots.assign(S, std::vector<uint8_t>(N * 4, 0));
    std::vector<uint8_t> resolved(N, 0);
    std::vector<float> transferDist(prm.transfer ? N : 0, 0.0f);

    auto interpV3 = [](const std::vector<float>& a, uint32_t i0, uint32_t i1, uint32_t i2, double b0, double b1, double b2, int stride) -> V3 {
        return {a[i0 * stride] * b0 + a[i1 * stride] * b1 + a[i2 * stride] * b2,
                a[i0 * stride + 1] * b0 + a[i1 * stride + 1] * b1 + a[i2 * stride + 1] * b2,
                a[i0 * stride + 2] * b0 + a[i1 * stride + 2] * b1 + a[i2 * stride + 2] * b2};
    };
    // tangent frame at a point: N from vertex normals (geometric normal when absent), T orthonormalised, sign w
    auto frame = [&](const BakeMesh& m, uint32_t t, double b0, double b1, double b2, V3& Tn, V3& Bn, V3& Nn) {
        const uint32_t i0 = m.idx[t * 3], i1 = m.idx[t * 3 + 1], i2 = m.idx[t * 3 + 2];
        V3 p0{m.pos[i0 * 3], m.pos[i0 * 3 + 1], m.pos[i0 * 3 + 2]}, p1{m.pos[i1 * 3], m.pos[i1 * 3 + 1], m.pos[i1 * 3 + 2]}, p2{m.pos[i2 * 3], m.pos[i2 * 3 + 1], m.pos[i2 * 3 + 2]};
        V3 g = unit(cross(sub(p1, p0), sub(p2, p0)));
        Nn = m.nrm.empty() ? g : unit(interpV3(m.nrm, i0, i1, i2, b0, b1, b2, 3));
        if (len(Nn) < 0.5) Nn = g;
        V3 t3{0, 0, 0};
        double w = 1;
        if (!m.tan.empty()) {
            t3 = {m.tan[i0 * 4] * b0 + m.tan[i1 * 4] * b1 + m.tan[i2 * 4] * b2,
                  m.tan[i0 * 4 + 1] * b0 + m.tan[i1 * 4 + 1] * b1 + m.tan[i2 * 4 + 1] * b2,
                  m.tan[i0 * 4 + 2] * b0 + m.tan[i1 * 4 + 2] * b1 + m.tan[i2 * 4 + 2] * b2};
            double ws = m.tan[i0 * 4 + 3] * b0 + m.tan[i1 * 4 + 3] * b1 + m.tan[i2 * 4 + 3] * b2;
            w = ws < 0 ? -1 : 1;
        }
        double nd = dot(t3, Nn);
        t3 = {t3[0] - Nn[0] * nd, t3[1] - Nn[1] * nd, t3[2] - Nn[2] * nd};
        if (len(t3) < 1e-9) {  // no usable tangent: any perpendicular (the frame then only carries the normal)
            V3 helper = std::fabs(Nn[1]) < 0.9 ? V3{0, 1, 0} : V3{1, 0, 0};
            t3 = cross(helper, Nn);
        }
        Tn = unit(t3);
        Bn = cross(Nn, Tn);
        Bn = {Bn[0] * w, Bn[1] * w, Bn[2] * w};
    };

    // 3. shade texels in parallel
    auto tc = clock::now();
    const uint32_t threads = std::max(1u, prm.threads ? prm.threads : std::min(16u, std::max(1u, std::thread::hardware_concurrency())));
    std::atomic<uint32_t> nextRow{0};
    auto worker = [&]() {
        std::vector<int32_t> stack;
        for (uint32_t y; (y = nextRow.fetch_add(1)) < H;) {
            for (uint32_t x = 0; x < W; ++x) {
                const size_t i = size_t(y) * W + x;
                if (state[i] == 0) continue;
                const uint32_t t = static_cast<uint32_t>(owner[i]);
                const double b0 = bary[i * 2], b1 = bary[i * 2 + 1], b2 = 1 - b0 - b1;
                // source triangle and barycentrics
                uint32_t st = t;
                double sb0 = b0, sb1 = b1, sb2 = b2;
                if (prm.transfer) {
                    const uint32_t i0 = target.idx[t * 3], i1 = target.idx[t * 3 + 1], i2 = target.idx[t * 3 + 2];
                    V3 P = interpV3(target.pos, i0, i1, i2, b0, b1, b2, 3);
                    V3 p0{target.pos[i0 * 3], target.pos[i0 * 3 + 1], target.pos[i0 * 3 + 2]}, p1{target.pos[i1 * 3], target.pos[i1 * 3 + 1], target.pos[i1 * 3 + 2]}, p2{target.pos[i2 * 3], target.pos[i2 * 3 + 1], target.pos[i2 * 3 + 2]};
                    V3 gn = unit(cross(sub(p1, p0), sub(p2, p0)));
                    double best = maxD2;
                    int64_t bestT = -1;
                    double bb[3] = {0, 0, 0};
                    stack.clear();
                    if (!bvh.nodes.empty()) stack.push_back(0);
                    while (!stack.empty()) {
                        int32_t id = stack.back(); stack.pop_back();
                        const auto& nd = bvh.nodes[id];
                        if (detail::boxDist2(nd, P) >= best) continue;
                        if (nd.left < 0) {
                            for (int32_t k = nd.start; k < nd.start + nd.count; ++k) {
                                uint32_t s = bvh.order[k];
                                const uint32_t j0 = source.idx[s * 3], j1 = source.idx[s * 3 + 1], j2 = source.idx[s * 3 + 2];
                                V3 a{source.pos[j0 * 3], source.pos[j0 * 3 + 1], source.pos[j0 * 3 + 2]}, b{source.pos[j1 * 3], source.pos[j1 * 3 + 1], source.pos[j1 * 3 + 2]}, c{source.pos[j2 * 3], source.pos[j2 * 3 + 1], source.pos[j2 * 3 + 2]};
                                if (cosGate > -1.5) {
                                    V3 sn = unit(cross(sub(b, a), sub(c, a)));
                                    if (dot(sn, gn) < cosGate) continue;
                                }
                                double bc[3];
                                V3 q = detail::closestOnTriangle(P, a, b, c, bc);
                                V3 dq = sub(q, P);
                                double d2 = dot(dq, dq);
                                if (d2 < best) { best = d2; bestT = s; bb[0] = bc[0]; bb[1] = bc[1]; bb[2] = bc[2]; }
                            }
                        } else {
                            // nearer child last so it is popped first
                            double dl = detail::boxDist2(bvh.nodes[nd.left], P), dr = detail::boxDist2(bvh.nodes[nd.right], P);
                            if (dl < dr) { stack.push_back(nd.right); stack.push_back(nd.left); }
                            else { stack.push_back(nd.left); stack.push_back(nd.right); }
                        }
                    }
                    if (bestT < 0) continue;
                    st = static_cast<uint32_t>(bestT); sb0 = bb[0]; sb1 = bb[1]; sb2 = bb[2];
                    transferDist[i] = static_cast<float>(std::sqrt(best));
                }
                resolved[i] = 1;
                const uint32_t mat = source.triMaterial.empty() ? 0 : source.triMaterial[st];
                const uint32_t s0 = source.idx[st * 3], s1 = source.idx[st * 3 + 1], s2 = source.idx[st * 3 + 2];
                bool haveFrames = false;
                V3 sT, sB, sN, tT, tB, tN;
                for (size_t s = 0; s < S; ++s) {
                    const MaterialSlot& ms = materials[mat][s];
                    double c[4] = {1, 1, 1, 1};
                    if (ms.image >= 0) {
                        const float* uvs = &source.uv[s * 2 * size_t(Vs)];
                        double u = uvs[s0 * 2] * sb0 + uvs[s1 * 2] * sb1 + uvs[s2 * 2] * sb2;
                        double v = uvs[s0 * 2 + 1] * sb0 + uvs[s1 * 2 + 1] * sb1 + uvs[s2 * 2 + 1] * sb2;
                        detail::sampleBilinear(images[ms.image], ms.wrapS, ms.wrapT, u, v, c);
                    } else if (prm.slotKind[s] == kSlotNormal) {
                        c[0] = 0.5; c[1] = 0.5; c[2] = 1.0; c[3] = 1.0;
                    }
                    uint8_t* o = &res.slots[s][i * 4];
                    if (prm.slotKind[s] == kSlotNormal) {
                        if (!haveFrames) { frame(source, st, sb0, sb1, sb2, sT, sB, sN); frame(target, t, b0, b1, b2, tT, tB, tN); haveFrames = true; }
                        V3 n{c[0] * 2 - 1, c[1] * 2 - 1, c[2] * 2 - 1};
                        n = unit(n);
                        V3 wv{n[0] * sT[0] + n[1] * sB[0] + n[2] * sN[0], n[0] * sT[1] + n[1] * sB[1] + n[2] * sN[1], n[0] * sT[2] + n[1] * sB[2] + n[2] * sN[2]};
                        V3 m{dot(wv, tT), dot(wv, tB), dot(wv, tN)};
                        m = unit(m);
                        for (int k = 0; k < 3; ++k) o[k] = static_cast<uint8_t>(std::lround(std::clamp((m[k] + 1) * 0.5, 0.0, 1.0) * 255));
                        o[3] = static_cast<uint8_t>(std::lround(std::clamp(c[3], 0.0, 1.0) * 255));
                    } else if (prm.slotKind[s] == kSlotSrgb) {
                        for (int k = 0; k < 3; ++k) {
                            double lin = detail::srgbToLinear(c[k]) * ms.factor[k];
                            o[k] = static_cast<uint8_t>(std::lround(detail::linearToSrgb(lin) * 255));
                        }
                        o[3] = static_cast<uint8_t>(std::lround(std::clamp(c[3] * ms.factor[3], 0.0, 1.0) * 255));
                    } else {
                        for (int k = 0; k < 4; ++k) o[k] = static_cast<uint8_t>(std::lround(std::clamp(c[k] * ms.factor[k], 0.0, 1.0) * 255));
                    }
                }
            }
        }
    };
    {
        std::vector<std::thread> pool;
        for (uint32_t k = 0; k < threads; ++k) pool.emplace_back(worker);
        for (auto& th : pool) th.join();
    }
    res.msShade = std::chrono::duration<double, std::milli>(clock::now() - tc).count();
    if (prm.transfer) {
        double sum = 0; uint64_t n = 0;
        for (size_t i = 0; i < N; ++i) if (state[i] && resolved[i]) { sum += transferDist[i]; ++n; res.maxTransferDistance = std::max(res.maxTransferDistance, double(transferDist[i])); }
        res.meanTransferDistance = n ? sum / n : 0;
    }
    for (size_t i = 0; i < N; ++i) if (state[i] && !resolved[i]) { ++res.unresolvedTexels; state[i] = 0; }

    // 4. gutter: dilate resolved texels `gutter` times (mean of resolved 8-neighbours), then the slot mean everywhere else
    auto td = clock::now();
    std::vector<uint8_t> filled(N);
    for (size_t i = 0; i < N; ++i) filled[i] = state[i] ? 1 : 0;
    const auto [dilated, empty] = dilateSlots(res.slots, std::move(filled), W, H, prm.gutter, prm.slotKind);
    res.dilatedTexels = dilated;
    res.emptyTexels = empty;
    res.msDilate = std::chrono::duration<double, std::milli>(clock::now() - td).count();
    (void)Vt;
    return res;
}

}  // namespace scratchbox::uv_rewrap
