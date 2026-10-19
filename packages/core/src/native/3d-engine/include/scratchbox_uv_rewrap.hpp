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
// - Charts start as the islands of scratchbox_uv_atlas.hpp (normal-clustered, orthographic, never overlapping) grown at
//   a continuous normal tolerance.
// - Every chart's distortion is measured per triangle from the singular values s1 >= s2 of the 3D -> UV Jacobian:
//   angle stretch s1 / s2 and area ratio r = s1 s2 / (chart UV area / chart 3D area), folded to max(r, 1/r). The chart
//   passes when the area-weighted RMS of both is under the caller's thresholds (continuous parameters).
// - A chart whose orthographic projection fails is re-parameterized conformally (LSCM: least-squares conformal map,
//   Levy et al. 2002) by preconditioned conjugate gradients on the normal equations, started from the orthographic
//   UVs with the two extreme vertices of the principal axis pinned. The LSCM result is kept when it has no flipped
//   triangle, no overlapping triangle pair and passes the thresholds.
// - Otherwise the chart is split: its triangles are re-clustered by buildIslands at a smaller normal tolerance and each
//   piece is processed again. A single triangle (or a chart at the tolerance floor) keeps its orthographic UVs, which
//   are always valid, and is counted as accepted over the threshold when it still fails.
// - Charts are scaled to UV area = 3D area (one texel density across the atlas), turned to their minimum-area bounding
//   rectangle (rotating calipers over the convex hull) and packed with a skyline bottom-left packer with 90 degree
//   rotations at the requested texel density, or at the largest density that fits a requested atlas size.
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

/**
 * Least-squares conformal map of one connected chart. `vertexPos` holds the welded chart vertices (3 per vertex),
 * `tris` indexes them, `uv` (2 per vertex) is the starting point and receives the result. Vertices `pinA` and `pinB`
 * keep their starting UVs.
 */
inline LscmReport solveLscm(const std::vector<double>& vertexPos, const std::vector<uint32_t>& tris, std::vector<double>& uv,
                            uint32_t pinA, uint32_t pinB, int maxIterations, double relTolerance) {
    LscmReport rep;
    const size_t nV = vertexPos.size() / 3, nT = tris.size() / 3;
    // per triangle: complex coefficients c_j = (P_{j+2} - P_{j+1}) / sqrt(A) in the triangle's own plane
    std::vector<double> cr(nT * 3), ci(nT * 3);
    for (size_t t = 0; t < nT; ++t) {
        V3 p[3];
        for (int k = 0; k < 3; ++k) { uint32_t v = tris[t * 3 + k]; p[k] = {vertexPos[v * 3], vertexPos[v * 3 + 1], vertexPos[v * 3 + 2]}; }
        V3 e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
        V3 n = cross(e1, e2);
        double a2 = len(n), l1 = len(e1);
        if (a2 < 1e-18 || l1 < 1e-12) { for (int k = 0; k < 3; ++k) cr[t * 3 + k] = ci[t * 3 + k] = 0; continue; }
        V3 x = {e1[0] / l1, e1[1] / l1, e1[2] / l1};
        V3 y = unit(cross(unit(n), x));
        double lx[3] = {0, l1, dot(e2, x)}, ly[3] = {0, 0, dot(e2, y)};
        double w = 1.0 / std::sqrt(0.5 * a2);
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
    for (size_t i = 0; i < nV * 2; ++i) if (diag[i] <= 0) pinned[i] = 1;  // isolated (degenerate-only) vertices keep their start

    std::vector<double> x(nV * 2);
    for (size_t v = 0; v < nV; ++v) { x[v] = uv[v * 2]; x[nV + v] = uv[v * 2 + 1]; }
    std::vector<double> r(nV * 2), z(nV * 2), p(nV * 2), q(nV * 2);
    applyNormal(x, r);
    for (size_t i = 0; i < r.size(); ++i) r[i] = pinned[i] ? 0 : -r[i];
    auto norm = [](const std::vector<double>& a) { double s = 0; for (double v : a) s += v * v; return std::sqrt(s); };
    // converged when the preconditioned residual has dropped by relTolerance from the orthographic start
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
        double alpha = rz / pq;
        double rzNew = 0, s = 0;
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
    bool conformal = true;
    int lscmMaxIterations = 4000;
    double lscmRelTolerance = 1e-9;
    // packing
    double texelsPerMeter = 0;     // > 0: requested density
    uint32_t atlasWidth = 0;       // > 0 with atlasHeight: fit this size at the largest density
    uint32_t atlasHeight = 0;
    uint32_t maxSide = 8192;
    uint32_t gutter = 4;
    bool allowRotation = true;
};

enum : uint32_t { kMethodOrtho = 0, kMethodLscm = 1 };

struct ChartReport {
    uint32_t method = kMethodOrtho;
    uint32_t group = 0;
    uint32_t triangles = 0;
    uint32_t splitDepth = 0;
    uint32_t overThreshold = 0;   // accepted while failing the thresholds (single triangle or tolerance floor)
    uint32_t lscmIterations = 0;
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

/**
 * Unwraps one atlas: `positions` (3 per vertex, metres), `indices` (3 per triangle), `groups` (one per triangle, may be
 * null) keep charts inside a group (a glTF primitive). The result's vertices are (source vertex, chart) pairs.
 */
inline UnwrapResult unwrap(const float* positions, uint32_t vertexCount, const uint32_t* indices, uint32_t triangleCount,
                           const uint32_t* groups, const UnwrapParams& prm) {
    using clock = std::chrono::steady_clock;
    const auto t0 = clock::now();
    (void)vertexCount;
    UnwrapResult out;
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
        std::vector<uint32_t> all(T);
        std::iota(all.begin(), all.end(), 0u);
        // first charts are pure normal clusters (no orthographic overlap eviction): a chart that folds in projection goes
        // to LSCM whole rather than being fragmented, and is split only when LSCM cannot flatten it either
        work = islandsToCharts(all, prm.chartNormalToleranceDeg, 0, !prm.conformal);
    }

    auto passes = [&](const ChartDistortion& d) {
        return d.flipped == 0 && d.stretchRms <= prm.maxAngleStretch && d.areaRms <= prm.maxAreaDistortion;
    };

    // LSCM over a chart: weld bit-identical positions, pin the extremes of the orthographic principal axis
    auto lscmChart = [&](const detail::Chart& c, std::vector<double>& cornerOut, uint32_t& iterations) -> bool {
        std::unordered_map<std::array<uint32_t, 3>, uint32_t, uv_atlas::detail::KeyHash> weld;
        std::vector<double> vpos, vuv;
        std::vector<uint32_t> tris(c.tris.size() * 3);
        std::vector<uint32_t> uses;
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
        const size_t nV = vpos.size() / 3;
        if (nV < 3) return false;
        // pins: extremes along the chart's longer orthographic axis
        double minU = 1e300, maxU = -1e300, minV = 1e300, maxV = -1e300;
        for (size_t v = 0; v < nV; ++v) { minU = std::min(minU, vuv[v * 2]); maxU = std::max(maxU, vuv[v * 2]); minV = std::min(minV, vuv[v * 2 + 1]); maxV = std::max(maxV, vuv[v * 2 + 1]); }
        const int axis = (maxU - minU) >= (maxV - minV) ? 0 : 1;
        uint32_t pinA = 0, pinB = 0;
        for (size_t v = 0; v < nV; ++v) {
            if (vuv[v * 2 + axis] < vuv[pinA * 2 + axis]) pinA = static_cast<uint32_t>(v);
            if (vuv[v * 2 + axis] > vuv[pinB * 2 + axis]) pinB = static_cast<uint32_t>(v);
        }
        if (pinA == pinB) return false;
        auto rep = solveLscm(vpos, tris, vuv, pinA, pinB, prm.lscmMaxIterations, prm.lscmRelTolerance);
        iterations = rep.iterations;
        cornerOut.resize(c.tris.size() * 6);
        for (size_t k = 0; k < c.tris.size(); ++k) for (int j = 0; j < 3; ++j) {
            uint32_t w = tris[k * 3 + j];
            if (!std::isfinite(vuv[w * 2]) || !std::isfinite(vuv[w * 2 + 1])) return false;
            cornerOut[k * 6 + j * 2] = vuv[w * 2];
            cornerOut[k * 6 + j * 2 + 1] = vuv[w * 2 + 1];
        }
        return true;
    };

    std::vector<detail::Chart> done;
    std::vector<ChartReport> reports;
    while (!work.empty()) {
        detail::Chart c = std::move(work.back());
        work.pop_back();
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
        if (!orthoOverlaps && passes(rep.orthoDistortion)) {
            rep.distortion = rep.orthoDistortion;
            done.push_back(std::move(c)); reports.push_back(rep);
            continue;
        }
        if (prm.conformal && c.tris.size() > 1) {
            std::vector<double> lscmUv;
            uint32_t iters = 0;
            ++out.lscmAttempts;
            if (lscmChart(c, lscmUv, iters)) {
                ChartDistortion dl = chartDistortion(c.tris, lscmUv, corner);
                if (passes(dl) && countOverlappingPairs(lscmUv) == 0) {
                    ++out.lscmAccepted;
                    rep.method = kMethodLscm; rep.distortion = dl; rep.lscmIterations = iters;
                    c.cornerUv.swap(lscmUv);
                    done.push_back(std::move(c)); reports.push_back(rep);
                    continue;
                }
            }
        }
        // split at a smaller tolerance; a chart that no tolerance splits keeps its orthographic UVs
        bool split = false;
        double tol = c.tolDeg;
        if (orthoOverlaps && c.tris.size() > 1) {
            // same tolerance with overlap eviction first: the orthographic pieces never overlap
            auto pieces = islandsToCharts(c.tris, tol, c.depth + 1, true);
            if (pieces.size() > 1) {
                ++out.splits;
                for (auto& p : pieces) work.push_back(std::move(p));
                continue;
            }
        }
        while (c.tris.size() > 1 && tol * prm.splitToleranceFactor >= prm.minToleranceDeg) {
            tol *= prm.splitToleranceFactor;
            auto pieces = islandsToCharts(c.tris, tol, c.depth + 1, true);
            if (pieces.size() > 1) {
                ++out.splits;
                for (auto& p : pieces) work.push_back(std::move(p));
                split = true;
                break;
            }
        }
        if (split) continue;
        if (orthoOverlaps) {
            // nothing above separated the overlapping triangles: lone triangles never overlap
            ++out.splits;
            for (size_t k = 0; k < c.tris.size(); ++k) {
                detail::Chart one;
                one.tris = {c.tris[k]};
                one.cornerUv.assign(c.cornerUv.begin() + k * 6, c.cornerUv.begin() + k * 6 + 6);
                one.tolDeg = c.tolDeg; one.depth = c.depth + 1;
                work.push_back(std::move(one));
            }
            continue;
        }
        rep.distortion = rep.orthoDistortion;
        rep.overThreshold = 1;
        done.push_back(std::move(c)); reports.push_back(rep);
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

    // packing
    const auto t2 = clock::now();
    const uint32_t G = prm.gutter;
    double total3D = 0;
    for (auto& r : reports) total3D += r.distortion.area3D;
    std::vector<detail::PackRect> rects(done.size());
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
            if (hh <= maxH && (best.first == 0 || uint64_t(w) * hh < uint64_t(best.first) * best.second ||
                               (uint64_t(w) * hh == uint64_t(best.first) * best.second && std::abs(int64_t(w) - hh) < std::abs(int64_t(best.first) - best.second))))
                best = {w, hh};
        }
        if (best.first) detail::skylinePack(rects, best.first, prm.allowRotation);
        return best;
    };
    double d = prm.texelsPerMeter;
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
        rep.x = r.x; rep.y = r.y; rep.rotated = r.rotated ? 1 : 0;
        rep.w = r.rotated ? r.h : r.w; rep.h = r.rotated ? r.w : r.h;
        const double wM = rep.widthM, hM = rep.heightM;
        for (size_t k = 0; k < c.tris.size(); ++k) {
            const uint32_t t = c.tris[k];
            out.triangleChart[t] = static_cast<uint32_t>(i);
            double px[3][2];
            for (int j = 0; j < 3; ++j) {
                double lu = c.cornerUv[k * 6 + j * 2], lv = c.cornerUv[k * 6 + j * 2 + 1];
                double cw = wM * d, chh = hM * d;
                double X, Y;
                if (!r.rotated) { X = r.x + G + lu * d; Y = r.y + G + (chh - lv * d); }
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
    const size_t Tt = target.idx.size() / 3;

    // 1. raster: owner triangle and barycentrics per texel (interior texels win over the closest-point ring)
    auto ta = clock::now();
    std::vector<int32_t> owner(N, -1);
    std::vector<float> bary(N * 2, 0.0f);
    std::vector<float> score(N, -1e30f);
    std::vector<uint8_t> state(N, 0);  // 0 empty, 1 interior, 2 edge ring, 3 dilated
    const double ring = std::max(0.0, prm.edgeTexels);
    for (size_t t = 0; t < Tt; ++t) {
        const uint32_t ia = target.idx[t * 3], ib = target.idx[t * 3 + 1], ic = target.idx[t * 3 + 2];
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
    for (size_t i = 0; i < N; ++i) { if (state[i] == 1) ++res.interiorTexels; else if (state[i] == 2) ++res.edgeTexels; }
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
    std::vector<uint32_t> add;
    for (uint32_t pass = 0; pass < prm.gutter; ++pass) {
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
                        const uint8_t* q = &res.slots[s][(size_t(yy) * W + xx) * 4];
                        for (int k = 0; k < 4; ++k) acc[k] += q[k];
                        ++n;
                    }
                }
                for (int k = 0; k < 4; ++k) res.slots[s][size_t(i) * 4 + k] = static_cast<uint8_t>(std::lround(acc[k] / std::max(n, 1)));
            }
        }
        for (uint32_t i : add) filled[i] = 1;
        res.dilatedTexels += add.size();
    }
    for (size_t s = 0; s < S; ++s) {
        double mean[4] = {0, 0, 0, 0}; uint64_t n = 0;
        for (size_t i = 0; i < N; ++i) if (filled[i]) { for (int k = 0; k < 4; ++k) mean[k] += res.slots[s][i * 4 + k]; ++n; }
        uint8_t m[4];
        for (int k = 0; k < 4; ++k) m[k] = static_cast<uint8_t>(n ? std::lround(mean[k] / n) : 0);
        if (prm.slotKind[s] == kSlotNormal) { m[0] = 128; m[1] = 128; m[2] = 255; m[3] = 255; }
        for (size_t i = 0; i < N; ++i) if (!filled[i]) std::copy(m, m + 4, &res.slots[s][i * 4]);
    }
    for (size_t i = 0; i < N; ++i) if (!filled[i]) ++res.emptyTexels;
    res.msDilate = std::chrono::duration<double, std::milli>(clock::now() - td).count();
    (void)Vt;
    return res;
}

}  // namespace scratchbox::uv_rewrap
