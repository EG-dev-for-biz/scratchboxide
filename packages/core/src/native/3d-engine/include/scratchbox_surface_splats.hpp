/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A splat for every patch of a scanned surface, coloured from the station images that see it (a training-free
 * Mesh2Splat: geometry decides where splats are, the stations only decide their colour).
 *
 * - Sampling: each triangle is sampled at a spacing that grows with its distance to the walk corridor
 *   (s = clamp(k * distance, sMin, sMax)), scaled up together until the splat count fits the budget. A triangle no
 *   station sees is closed at a coarse spacing near the walk and left out further away: on the 7th Ave scan two
 *   thirds of the triangles (roofs, back faces, other blocks) are seen by no station, and at the far spacing they took
 *   half the budget as flat fill.
 * - One view per patch (after Waechter et al. 2014, "Let There Be Color!"): the surface is cut into patches (a cellM
 *   cell of space, facing one of 14 ways). A view's quality at a sample is its projected area, log(priority * cos /
 *   z^2), less relaxPenalty below minCos (in frame, not occluded in the station's depth, |n.view| at least relaxedCos).
 *   Each patch takes the station whose views lose least against each sample's best (missingCost where it cannot see a
 *   sample), then the patches are smoothed: a station is kept across neighbouring patches unless another is better by
 *   more than smoothCost (iterated conditional modes). Every splat is coloured from its patch's one station, read over
 *   its footprint in that image (Mip-Splatting's bound), so no splat blends two stations' renderings of a detail, and
 *   the station changes only between patches. A sample its patch's station cannot see takes its own best view
 *   (counted as fallback); none at all takes the mean colour of observed samples facing the same way (unobserved).
 * - Colour agreement, after pipeline K's texture-harmonize.ts: where two stations both see a patch face on (|n.view|
 *   at least gainCos), their mean colours there (linear light, logs) are compared, patch by patch, never splat by
 *   splat. Only patches showing the same content in both count: within inlierLog of the station pair's most common
 *   difference. On 7th Ave (2026-10-31) the shared patches differed by a median factor of 2.3 and only 16% agreed
 *   within 20%: the stations' pictures land on the scan differently (era and registration mismatches, and each view
 *   beautified apart), and a fit over all of them pushed every gain to its bound. Each station gets one gain per
 *   channel from the weighted median of those differences with each other station, bounded by maxGainLog, applied only
 *   when one gain per station explains the pairs to within maxResidualLog and brings the shared patches closer (on 7th
 *   Ave it left a median e^0.26 unexplained, pushing the views facing Penn Station's dark glass up and the rest down:
 *   content, not exposure, so none is applied). Then each station gets a smooth low-resolution offset field over its
 *   image (Lempitsky and Ivanov 2007), fitted so the same-content shared patches agree, with a smoothness term and a
 *   weak pull to zero, kept when it brings them closer (with or without gains: it is local, so a disagreement elsewhere
 *   does not set it; on 7th Ave 0.60 -> 0.33, and the seam between two stations on the Penn Plaza ground softened).
 *   The report gives the patch difference before, after the gains and after the field, and the gains' residual.
 * - Shape: a 2DGS surfel on the triangle's plane, in-plane sigma sigmaRatio * s so neighbours overlap with no gap.
 */

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_depth_to_gaussian.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace surfacesplats {

using math::Vec3;
using math::Quat;

/** One station: its image (RGB8, row 0 at the top) and pinhole camera, and its depth (camera-z, EMPTY beyond 1e8). */
struct StationView {
    int W = 0, H = 0;
    std::vector<uint8_t> rgb;
    float fx = 1, fy = 1, cx = 0, cy = 0;
    Vec3 eye, right, up, fwd;
    int DW = 0, DH = 0;
    std::vector<float> depth;
    float dfx = 1, dfy = 1, dcx = 0, dcy = 0;
    float priority = 1.0f;
};

struct Params {
    Vec3 corridorA, corridorB;   // the walk segment (at eye height)
    float k = 0.0025f, sMin = 0.05f, sMax = 0.25f;
    /** A surface no station sees: closed at this coarse spacing near the walk, left out past unseenMaxDist (nobody
     *  on the walk sees it, and only a flat fill could colour it). */
    float unseenSpacing = 1.0f, unseenMaxDist = 40.0f;
    size_t budget = 4000000;
    float minCos = 0.26f, relaxedCos = 0.05f;
    float depthTolRel = 0.03f, depthTolAbs = 0.15f;
    /** In-plane sigma as a share of the spacing. At 0.55 the background showed between neighbours near the walk (7th
     *  Ave, 2026-10-31: 7 to 11% of the lower view, a cobblestone of gaps); at 0.75 none (0.0 to 0.2%). */
    float sigmaRatio = 0.75f, thicknessRatio = 0.05f;
    /** One view per patch: the patch (m), the cost of changing station between neighbouring patches, a view under minCos
     *  and a sample the patch's station cannot see (all in log projected area), and the smoothing passes. */
    float cellM = 1.0f, smoothCost = 0.7f, relaxPenalty = 1.0f, missingCost = 3.0f;
    int smoothPasses = 8;
    /** Colour agreement: views compared only at least this face on; gain bound (natural log, per channel); the offset
     *  field's nodes across and down a station's image, its smoothness and pull-to-zero weights and bound; and about how
     *  many samples are read for the comparison. */
    float gainCos = 0.5f, maxGainLog = 0.4f;
    /** A shared patch counts as the same content in both stations when its difference lies within inlierLog of the
     *  pair's mode; a pair needs minInliers such patches to be compared at all. */
    float inlierLog = 0.3f;
    int minInliers = 5;
    /** Gains (and the offset field after them) are applied only when one gain per station explains the pairs'
     *  differences to within this (weighted median residual, natural log). */
    float maxResidualLog = 0.15f;
    int fieldNx = 12, fieldNy = 8;
    float wSmooth = 0.15f, wAnchor = 0.01f, maxOffsetLog = 0.47f;
    size_t statSamples = 600000;
    uint32_t seed = 1;
};

struct SeamReport {
    /** Shared patch comparisons (a station against the patch's best-covered one), and those showing the same content
     *  in both stations (within inlierLog of their station pair's mode); the rest are an era or registration mismatch. */
    size_t pairs = 0, inliers = 0;
    /** Median difference of all shared patches' luminance as read (natural log, linear light). */
    float medianAll = 0;
    /** Mean difference of the same-content patches' colours (natural log, linear light): as read, after the gains, after the field. */
    float before = 0, afterGain = 0, after = 0;
    /** How far one gain per station leaves the station pairs' differences unexplained (weighted median, natural log,
     *  the worst channel): above maxResidualLog the differences are content, not exposure, and no gain is applied. */
    float gainResidual = 0;
    bool gainsKept = false, fieldKept = false;
};

struct Report {
    size_t triangles = 0, samples = 0, observed = 0, relaxed = 0, unobserved = 0, invisibleTriangles = 0, skippedTriangles = 0;
    /** Patches, patches whose station the smoothing changed, and samples their patch's station could not see. */
    size_t patches = 0, relabelled = 0, fallback = 0;
    float spacingScale = 1.0f;
    /** Per station, per channel (r, g, b). */
    std::vector<std::array<float, 3>> gains;
    SeamReport seams;
};

inline float distToSegment(const Vec3& p, const Vec3& a, const Vec3& b) {
    const Vec3 ab = b - a;
    const float L = ab.lengthSq();
    const float t = L > 1e-9f ? std::clamp((p - a).dot(ab) / L, 0.0f, 1.0f) : 0.0f;
    return (p - (a + ab * t)).length();
}

/** Projection of p into a station: pixel (u, v), camera-z, and whether the station's depth leaves it unoccluded. */
inline bool project(const StationView& s, const Vec3& p, const Params& prm, float& u, float& v, float& z) {
    const Vec3 d = p - s.eye;
    z = d.dot(s.fwd);
    if (z <= 0.1f) return false;
    u = s.cx + s.fx * d.dot(s.right) / z;
    v = s.cy - s.fy * d.dot(s.up) / z;
    if (u < 0 || v < 0 || u >= s.W - 1 || v >= s.H - 1) return false;
    if (!s.depth.empty()) {
        const int du = static_cast<int>(s.dcx + s.dfx * d.dot(s.right) / z), dv = static_cast<int>(s.dcy - s.dfy * d.dot(s.up) / z);
        if (du < 0 || dv < 0 || du >= s.DW || dv >= s.DH) return false;
        const float zd = s.depth[static_cast<size_t>(dv) * s.DW + du];
        if (zd < 5e8f && z > zd * (1.0f + prm.depthTolRel) + prm.depthTolAbs) return false;
    }
    return true;
}

/** Bilinear colour of a station image at (u, v), 0..1. */
inline Vec3 bilinear(const StationView& s, float u, float v) {
    const float x = std::clamp(u, 0.0f, s.W - 1.001f), y = std::clamp(v, 0.0f, s.H - 1.001f);
    const int x0 = static_cast<int>(x), y0 = static_cast<int>(y);
    const float fx = x - x0, fy = y - y0;
    auto px = [&](int xx, int yy, int c) { return s.rgb[(static_cast<size_t>(yy) * s.W + xx) * 3 + c] / 255.0f; };
    float out[3];
    for (int c = 0; c < 3; ++c) out[c] = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
    return Vec3(out[0], out[1], out[2]);
}

/** Mean colour over a footprint of `rad` pixels around (u, v): 3 x 3 bilinear taps. */
inline Vec3 footprintColour(const StationView& s, float u, float v, float rad) {
    Vec3 acc(0, 0, 0);
    const float step = std::max(0.0f, rad) / 1.5f;
    for (int j = -1; j <= 1; ++j) for (int i = -1; i <= 1; ++i) acc += bilinear(s, u + i * step, v + j * step);
    return acc / 9.0f;
}

inline float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline float linearToSrgb(float c) { c = std::clamp(c, 0.0f, 1.0f); return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f; }
constexpr float LOG_EPS = 1e-3f;

inline float halton(uint32_t i, uint32_t base) {
    float f = 1.0f, r = 0.0f;
    while (i > 0) { f /= base; r += f * (i % base); i /= base; }
    return r;
}

inline uint32_t hash32(uint32_t x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }

/** Which of 14 ways a normal faces: up, down, or one of 12 compass bins of its horizontal part. */
inline int facingBin(const Vec3& n) {
    if (n.y > 0.7f) return 12;
    if (n.y < -0.7f) return 13;
    const float az = std::atan2(n.x, n.z);
    return ((static_cast<int>(std::lround(az / (2.0f * 3.14159265f) * 12.0f)) % 12) + 12) % 12;
}

inline uint64_t patchKey(int ix, int iy, int iz, int facing) {
    auto b = [](int v) { return static_cast<uint64_t>(static_cast<uint32_t>(v + (1 << 19)) & 0xfffffu); };
    return (b(ix) << 44) | (b(iy) << 24) | (b(iz) << 4) | static_cast<uint64_t>(facing);
}

/** Sparse least squares rows (at most 8 unknowns a row), solved by conjugate gradients on the normal equations (CGLS). */
struct LsqRows {
    struct Row { int n = 0; int idx[8]; float a[8]; float rhs = 0; };
    std::vector<Row> rows;
    /** sum_k coef_k x_idx_k = rhs, weighted (the row is scaled by sqrt(w)). */
    void add(std::initializer_list<int> idx, std::initializer_list<float> coef, float rhs, float w) {
        Row r; const float sw = std::sqrt(std::max(0.0f, w));
        auto ii = idx.begin(); auto cc = coef.begin();
        for (; ii != idx.end() && r.n < 8; ++ii, ++cc) { r.idx[r.n] = *ii; r.a[r.n] = *cc * sw; ++r.n; }
        r.rhs = rhs * sw;
        rows.push_back(r);
    }
    void addRow(const Row& r, float w) { Row s = r; const float sw = std::sqrt(std::max(0.0f, w)); for (int k = 0; k < s.n; ++k) s.a[k] *= sw; s.rhs *= sw; rows.push_back(s); }
    std::vector<double> solve(size_t unknowns, int iterations, double tol) const {
        std::vector<double> x(unknowns, 0.0), r(rows.size()), s(unknowns, 0.0), p, q(rows.size());
        for (size_t i = 0; i < rows.size(); ++i) r[i] = rows[i].rhs;
        auto At = [&](const std::vector<double>& v, std::vector<double>& out) { std::fill(out.begin(), out.end(), 0.0); for (size_t i = 0; i < rows.size(); ++i) for (int k = 0; k < rows[i].n; ++k) out[rows[i].idx[k]] += rows[i].a[k] * v[i]; };
        At(r, s);
        p = s;
        double gamma = 0; for (double v : s) gamma += v * v;
        const double gamma0 = gamma;
        for (int it = 0; it < iterations && gamma > tol * tol * std::max(gamma0, 1e-30); ++it) {
            double qq = 0;
            for (size_t i = 0; i < rows.size(); ++i) { double v = 0; for (int k = 0; k < rows[i].n; ++k) v += rows[i].a[k] * p[rows[i].idx[k]]; q[i] = v; qq += v * v; }
            if (qq <= 1e-30) break;
            const double alpha = gamma / qq;
            for (size_t j = 0; j < unknowns; ++j) x[j] += alpha * p[j];
            for (size_t i = 0; i < rows.size(); ++i) r[i] -= alpha * q[i];
            At(r, s);
            double g2 = 0; for (double v : s) g2 += v * v;
            const double beta = g2 / gamma;
            gamma = g2;
            for (size_t j = 0; j < unknowns; ++j) p[j] = s[j] + beta * p[j];
        }
        return x;
    }
};

/** A station's offset field over its image: bilinear weights of a normalised (u, v) on its nodes. */
inline void fieldWeights(int nx, int ny, int base, float u, float v, int idx[4], float w[4]) {
    const float fx = std::clamp(u, 0.0f, 1.0f) * (nx - 1), fy = std::clamp(v, 0.0f, 1.0f) * (ny - 1);
    const int i = std::min(nx - 2, static_cast<int>(fx)), j = std::min(ny - 2, static_cast<int>(fy));
    const float a = fx - i, b = fy - j;
    idx[0] = base + j * nx + i; idx[1] = idx[0] + 1; idx[2] = idx[0] + nx; idx[3] = idx[2] + 1;
    w[0] = (1 - a) * (1 - b); w[1] = a * (1 - b); w[2] = (1 - a) * b; w[3] = a * b;
}

inline float weightedMedian(std::vector<std::pair<float, float>>& vw) {
    std::sort(vw.begin(), vw.end());
    double total = 0; for (const auto& e : vw) total += e.second;
    double acc = 0;
    for (const auto& e : vw) { acc += e.second; if (acc >= total / 2) return e.first; }
    return vw.empty() ? 0.0f : vw.back().first;
}

/** Builds the surface splats of `tris` (9 floats each) coloured from `stations`. */
inline std::vector<spz::GaussianSplat> build(const std::vector<float>& tris, const std::vector<StationView>& stations, const Params& prm, Report& rep) {
    const size_t T = tris.size() / 9;
    const size_t S = stations.size();
    rep.triangles = T;
    std::vector<float> area(T), dist(T);
    std::vector<uint8_t> seen(T);
    std::vector<Vec3> normal(T);
    for (size_t t = 0; t < T; ++t) {
        const Vec3 a(tris[t * 9], tris[t * 9 + 1], tris[t * 9 + 2]), b(tris[t * 9 + 3], tris[t * 9 + 4], tris[t * 9 + 5]), c(tris[t * 9 + 6], tris[t * 9 + 7], tris[t * 9 + 8]);
        const Vec3 n = (b - a).cross(c - a);
        area[t] = 0.5f * n.length();
        normal[t] = area[t] > 1e-12f ? n.normalized() : Vec3(0, 1, 0);
        const Vec3 ctr = (a + b + c) / 3.0f;
        dist[t] = distToSegment(ctr, prm.corridorA, prm.corridorB);
        float u, v, z;
        for (const auto& s : stations) {
            if (!project(s, ctr, prm, u, v, z)) continue;
            const Vec3 toCam = (s.eye - ctr).normalized();
            if (std::fabs(normal[t].dot(toCam)) >= prm.relaxedCos) { seen[t] = 1; break; }
        }
        if (!seen[t]) rep.invisibleTriangles++;
    }

    // the spacing scale that fits the budget
    std::vector<uint8_t> skip(T);
    for (size_t t = 0; t < T; ++t) if (!seen[t] && dist[t] > prm.unseenMaxDist) { skip[t] = 1; rep.skippedTriangles++; }
    auto spacingOf = [&](size_t t, float scale) { return seen[t] ? std::clamp(scale * prm.k * dist[t], scale * prm.sMin, prm.sMax) : prm.unseenSpacing; };
    auto countAt = [&](float scale) { double n = 0; for (size_t t = 0; t < T; ++t) { if (skip[t]) continue; const float s = spacingOf(t, scale); n += area[t] / (s * s); } return n; };
    float lo = 1.0f, hi = 1.0f;
    if (countAt(1.0f) > prm.budget) {
        while (countAt(hi) > prm.budget && hi < 256.0f) hi *= 2.0f;
        for (int it = 0; it < 30; ++it) { const float mid = 0.5f * (lo + hi); if (countAt(mid) > prm.budget) lo = mid; else hi = mid; }
        rep.spacingScale = hi;
    }
    const float scale = rep.spacingScale;

    struct Sample { Vec3 p; Vec3 n; float s; uint32_t patch = 0; int view = -1; float u = 0, v = 0; Vec3 c; };
    std::vector<Sample> samples;
    samples.reserve(static_cast<size_t>(std::min<double>(countAt(scale) * 1.05 + T, 2e8)));
    uint32_t serial = prm.seed;
    for (size_t t = 0; t < T; ++t) {
        if (skip[t]) continue;
        const float s = spacingOf(t, scale);
        const float expected = area[t] / (s * s);
        const uint32_t h = hash32(static_cast<uint32_t>(t) * 2654435761U + prm.seed);
        const int n = static_cast<int>(std::floor(expected + (h & 0xffffff) / 16777216.0f));
        const Vec3 a(tris[t * 9], tris[t * 9 + 1], tris[t * 9 + 2]), b(tris[t * 9 + 3], tris[t * 9 + 4], tris[t * 9 + 5]), c(tris[t * 9 + 6], tris[t * 9 + 7], tris[t * 9 + 8]);
        for (int i = 0; i < n; ++i, ++serial) {
            const float r1 = std::sqrt(halton(serial, 2)), r2 = halton(serial, 3);
            Sample smp;
            smp.p = a * (1 - r1) + b * (r1 * (1 - r2)) + c * (r1 * r2);
            smp.n = normal[t];
            smp.s = s;
            samples.push_back(smp);
        }
    }
    rep.samples = samples.size();

    // patches: a cell of space, facing one way
    std::unordered_map<uint64_t, uint32_t> patchOf;
    std::vector<uint64_t> patchKeys;
    for (auto& smp : samples) {
        const int ix = static_cast<int>(std::floor(smp.p.x / prm.cellM)), iy = static_cast<int>(std::floor(smp.p.y / prm.cellM)), iz = static_cast<int>(std::floor(smp.p.z / prm.cellM));
        const uint64_t key = patchKey(ix, iy, iz, facingBin(smp.n));
        auto it = patchOf.find(key);
        if (it == patchOf.end()) { it = patchOf.emplace(key, static_cast<uint32_t>(patchKeys.size())).first; patchKeys.push_back(key); }
        smp.patch = it->second;
    }
    const size_t P = patchKeys.size();
    rep.patches = P;

    // pass 1: each patch's cost of each station (how much worse than each sample's best view), and the colour statistics
    // of the views that see a patch face on (every stride-th sample)
    std::vector<float> cost(P * S, 0.0f);
    std::vector<uint32_t> covered(P * S, 0), patchN(P, 0);
    struct Stat { int station; float n = 0, u = 0, v = 0; double c[3] = {0, 0, 0}; };
    std::vector<std::vector<Stat>> stats(P);
    const size_t stride = std::max<size_t>(1, samples.size() / std::max<size_t>(1, prm.statSamples));
    std::vector<float> q(S), cosOf(S), uOf(S), vOf(S);
    std::vector<uint8_t> ok(S);
    for (size_t i = 0; i < samples.size(); ++i) {
        const auto& smp = samples[i];
        float best = -1e30f;
        for (size_t si = 0; si < S; ++si) {
            ok[si] = 0;
            float u, v, z;
            if (!project(stations[si], smp.p, prm, u, v, z)) continue;
            const float cosI = std::fabs(smp.n.dot((stations[si].eye - smp.p).normalized()));
            if (cosI < prm.relaxedCos) continue;
            ok[si] = 1; cosOf[si] = cosI; uOf[si] = u; vOf[si] = v;
            q[si] = std::log(stations[si].priority * cosI / (z * z)) - (cosI < prm.minCos ? prm.relaxPenalty : 0.0f);
            best = std::max(best, q[si]);
        }
        patchN[smp.patch]++;
        for (size_t si = 0; si < S; ++si) if (ok[si]) { cost[smp.patch * S + si] += best - q[si]; covered[smp.patch * S + si]++; }
        if (i % stride) continue;
        for (size_t si = 0; si < S; ++si) {
            if (!ok[si] || cosOf[si] < prm.gainCos) continue;
            auto& list = stats[smp.patch];
            auto it = std::find_if(list.begin(), list.end(), [&](const Stat& e) { return e.station == static_cast<int>(si); });
            if (it == list.end()) { list.push_back(Stat{static_cast<int>(si)}); it = list.end() - 1; }
            const Vec3 c = bilinear(stations[si], uOf[si], vOf[si]);
            it->n += 1; it->u += uOf[si] / stations[si].W; it->v += vOf[si] / stations[si].H;
            it->c[0] += std::log(srgbToLinear(c.x) + LOG_EPS); it->c[1] += std::log(srgbToLinear(c.y) + LOG_EPS); it->c[2] += std::log(srgbToLinear(c.z) + LOG_EPS);
        }
    }

    // each patch's station: the least cost, then smoothed over neighbouring patches facing the same way
    auto patchCost = [&](size_t p, size_t si) { return covered[p * S + si] ? (cost[p * S + si] + (patchN[p] - covered[p * S + si]) * prm.missingCost) / patchN[p] : 1e30f; };
    std::vector<int> label(P, -1);
    for (size_t p = 0; p < P; ++p) {
        float bestCost = 1e29f;
        for (size_t si = 0; si < S; ++si) { const float c = patchCost(p, si); if (c < bestCost) { bestCost = c; label[p] = static_cast<int>(si); } }
    }
    const std::vector<int> initial = label;
    std::vector<uint32_t> nbStart(P + 1, 0), nbList;
    for (size_t p = 0; p < P; ++p) {
        const uint64_t key = patchKeys[p];
        const int facing = static_cast<int>(key & 0xf);
        const int ix = static_cast<int>((key >> 44) & 0xfffff) - (1 << 19), iy = static_cast<int>((key >> 24) & 0xfffff) - (1 << 19), iz = static_cast<int>((key >> 4) & 0xfffff) - (1 << 19);
        for (int dz = -1; dz <= 1; ++dz) for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
            if (!dx && !dy && !dz) continue;
            const auto it = patchOf.find(patchKey(ix + dx, iy + dy, iz + dz, facing));
            if (it != patchOf.end()) nbList.push_back(it->second);
        }
        nbStart[p + 1] = static_cast<uint32_t>(nbList.size());
    }
    for (int pass = 0; pass < prm.smoothPasses; ++pass) {
        size_t changed = 0;
        for (size_t p = 0; p < P; ++p) {
            if (label[p] < 0) continue;
            const uint32_t n0 = nbStart[p], n1 = nbStart[p + 1];
            float bestE = 1e30f; int bestS = label[p];
            for (size_t si = 0; si < S; ++si) {
                if (!covered[p * S + si]) continue;
                int differ = 0, counted = 0;
                for (uint32_t k = n0; k < n1; ++k) { const int l = label[nbList[k]]; if (l < 0) continue; counted++; if (l != static_cast<int>(si)) differ++; }
                const float e = patchCost(p, si) + prm.smoothCost * (counted ? static_cast<float>(differ) / counted : 0.0f);
                if (e < bestE - 1e-6f) { bestE = e; bestS = static_cast<int>(si); }
            }
            if (bestS != label[p]) { label[p] = bestS; changed++; }
        }
        if (!changed) break;
    }
    for (size_t p = 0; p < P; ++p) if (label[p] != initial[p]) rep.relabelled++;

    // pass 2: each sample's colour from its patch's station (else its own best view)
    for (auto& smp : samples) {
        int view = -1;
        float u = 0, v = 0, z = 0, cosI = 0;
        const int L = label[smp.patch];
        if (L >= 0 && project(stations[L], smp.p, prm, u, v, z)) {
            cosI = std::fabs(smp.n.dot((stations[L].eye - smp.p).normalized()));
            if (cosI >= prm.relaxedCos) view = L;
        }
        if (view < 0) {
            float bestQ = -1e30f;
            for (size_t si = 0; si < S; ++si) {
                float uu, vv, zz;
                if (!project(stations[si], smp.p, prm, uu, vv, zz)) continue;
                const float c = std::fabs(smp.n.dot((stations[si].eye - smp.p).normalized()));
                if (c < prm.relaxedCos) continue;
                const float qq = std::log(stations[si].priority * c / (zz * zz)) - (c < prm.minCos ? prm.relaxPenalty : 0.0f);
                if (qq > bestQ) { bestQ = qq; view = static_cast<int>(si); u = uu; v = vv; z = zz; cosI = c; }
            }
            if (view >= 0) rep.fallback++;
        }
        if (view < 0) continue;
        const auto& st = stations[view];
        smp.view = view;
        smp.u = u / st.W; smp.v = v / st.H;
        smp.c = footprintColour(st, u, v, st.fx * smp.s / z * 0.5f);
        rep.observed++;
        if (cosI < prm.minCos) rep.relaxed++;
    }

    // colour agreement: per-channel gains from the patches two stations see face on, then each station's offset field
    struct Pair { int a, b; float ua, va, ub, vb, w; float ca[3], cb[3]; };
    std::vector<Pair> pairs;
    for (const auto& list : stats) {
        if (list.size() < 2) continue;
        size_t ref = 0;
        for (size_t k = 1; k < list.size(); ++k) if (list[k].n > list[ref].n) ref = k;
        for (size_t k = 0; k < list.size(); ++k) {
            if (k == ref || list[k].n < 2 || list[ref].n < 2) continue;
            const auto& A = list[ref]; const auto& B = list[k];
            Pair pr{A.station, B.station, A.u / A.n, A.v / A.n, B.u / B.n, B.v / B.n, std::min(4.0f, std::min(A.n, B.n)), {}, {}};
            for (int c = 0; c < 3; ++c) { pr.ca[c] = static_cast<float>(A.c[c] / A.n); pr.cb[c] = static_cast<float>(B.c[c] / B.n); }
            pairs.push_back(pr);
        }
    }
    rep.seams.pairs = pairs.size();
    // which shared patches show the same content in both stations: within inlierLog of their station pair's mode
    // (luminance), found by a kernel vote over the pair's differences. Where two stations' pictures land on the scan
    // differently (an era or registration mismatch) most patches differ by far more than any exposure, and a median
    // over them would push every gain to its bound.
    auto lumOf = [](const float c[3]) { return 0.2126f * c[0] + 0.7152f * c[1] + 0.0722f * c[2]; };
    auto pairKey = [](int a, int b) { return (static_cast<uint64_t>(std::min(a, b)) << 32) | static_cast<uint32_t>(std::max(a, b)); };
    std::vector<uint8_t> inlier(pairs.size(), 0);
    {
        std::unordered_map<uint64_t, std::vector<size_t>> members;
        for (size_t i = 0; i < pairs.size(); ++i) members[pairKey(pairs[i].a, pairs[i].b)].push_back(i);
        for (const auto& [key, list] : members) {
            const int lo2 = static_cast<int>(key >> 32);
            auto diffOf = [&](size_t i) { const float d = lumOf(pairs[i].ca) - lumOf(pairs[i].cb); return pairs[i].a == lo2 ? d : -d; };
            float mode = 0, bestVote = -1;
            for (int b = -40; b <= 40; ++b) {
                const float x = b * 0.05f;
                float vote = 0;
                for (size_t i : list) { const float t = std::fabs(diffOf(i) - x) / prm.inlierLog; if (t < 1) vote += pairs[i].w * (1 - t); }
                if (vote > bestVote) { bestVote = vote; mode = x; }
            }
            int n = 0;
            for (size_t i : list) if (std::fabs(diffOf(i) - mode) < prm.inlierLog) n++;
            if (n < prm.minInliers) continue;
            for (size_t i : list) if (std::fabs(diffOf(i) - mode) < prm.inlierLog) inlier[i] = 1;
        }
        std::vector<float> all;
        for (const auto& pr : pairs) all.push_back(std::fabs(lumOf(pr.ca) - lumOf(pr.cb)));
        if (!all.empty()) { std::nth_element(all.begin(), all.begin() + all.size() / 2, all.end()); rep.seams.medianAll = all[all.size() / 2]; }
        for (uint8_t f : inlier) rep.seams.inliers += f;
    }
    std::vector<std::array<double, 3>> lg(S, {0.0, 0.0, 0.0});
    for (int c = 0; c < 3; ++c) {
        // the robust difference of each station pair: the weighted median over the same-content patches they share
        std::unordered_map<uint64_t, std::vector<std::pair<float, float>>> byPair;
        for (size_t i = 0; i < pairs.size(); ++i) {
            if (!inlier[i]) continue;
            const auto& pr = pairs[i];
            const int lo2 = std::min(pr.a, pr.b), hi2 = std::max(pr.a, pr.b);
            const float d = pr.a == lo2 ? pr.ca[c] - pr.cb[c] : pr.cb[c] - pr.ca[c];   // lo - hi
            byPair[(static_cast<uint64_t>(lo2) << 32) | static_cast<uint32_t>(hi2)].push_back({d, pr.w});
        }
        struct Edge { int a, b; double d, w; };
        std::vector<Edge> edges;
        for (auto& [key, list] : byPair) {
            double w = 0; for (const auto& e : list) w += e.second;
            edges.push_back({static_cast<int>(key >> 32), static_cast<int>(key & 0xffffffffu), weightedMedian(list), w});
        }
        std::vector<uint8_t> linked(S, 0);
        for (const auto& e : edges) { linked[e.a] = 1; linked[e.b] = 1; }
        for (int it = 0; it < 200; ++it) {
            for (size_t a = 0; a < S; ++a) {
                double num = 0, den = 0;
                // log g_a + m_a = log g_b + m_b  =>  log g_a = log g_b - (m_a - m_b)
                for (const auto& e : edges) {
                    if (e.a == static_cast<int>(a)) { num += e.w * (lg[e.b][c] - e.d); den += e.w; }
                    else if (e.b == static_cast<int>(a)) { num += e.w * (lg[e.a][c] + e.d); den += e.w; }
                }
                if (den > 0) lg[a][c] = num / den;
            }
            double mean = 0; size_t n = 0;
            for (size_t a = 0; a < S; ++a) if (linked[a]) { mean += lg[a][c]; n++; }
            if (n) for (size_t a = 0; a < S; ++a) if (linked[a]) lg[a][c] -= mean / n;
        }
        // how well one gain per station explains the pairs' differences (0 when they agree around every loop)
        std::vector<std::pair<float, float>> res;
        for (const auto& e : edges) res.push_back({static_cast<float>(std::fabs(lg[e.a][c] - lg[e.b][c] + e.d)), static_cast<float>(e.w)});
        if (!res.empty()) rep.seams.gainResidual = std::max(rep.seams.gainResidual, weightedMedian(res));
        for (size_t a = 0; a < S; ++a) lg[a][c] = std::clamp(lg[a][c], -static_cast<double>(prm.maxGainLog), static_cast<double>(prm.maxGainLog));
    }
    const int FN = prm.fieldNx * prm.fieldNy;
    std::vector<std::array<std::vector<double>, 3>> field(S);
    auto offsetAt = [&](int st, int c, float u, float v) {
        if (field[st][c].empty()) return 0.0;
        int idx[4]; float w[4];
        fieldWeights(prm.fieldNx, prm.fieldNy, 0, u, v, idx, w);
        double o = 0; for (int k = 0; k < 4; ++k) o += w[k] * field[st][c][idx[k]];
        return o;
    };
    auto seamDiff = [&](bool gains, bool fields) {
        double s = 0, wt = 0;
        for (size_t i = 0; i < pairs.size(); ++i) for (int c = 0; c < 3; ++c) {
            if (!inlier[i]) continue;
            const auto& pr = pairs[i];
            double va = pr.ca[c], vb = pr.cb[c];
            if (gains) { va += lg[pr.a][c]; vb += lg[pr.b][c]; }
            if (fields) { va += offsetAt(pr.a, c, pr.ua, pr.va); vb += offsetAt(pr.b, c, pr.ub, pr.vb); }
            s += pr.w * std::fabs(va - vb); wt += pr.w;
        }
        return wt > 0 ? static_cast<float>(s / wt) : 0.0f;
    };
    rep.seams.before = seamDiff(false, false);
    rep.seams.afterGain = seamDiff(true, false);
    // gains are an exposure correction: kept only when the pairs agree on one gain per station (their differences are
    // not then content) and they bring the shared patches closer
    rep.seams.gainsKept = rep.seams.inliers > 0 && rep.seams.gainResidual <= prm.maxResidualLog && rep.seams.afterGain < rep.seams.before;
    if (!rep.seams.gainsKept) for (auto& g : lg) g = {0.0, 0.0, 0.0};
    const float base = rep.seams.gainsKept ? rep.seams.afterGain : rep.seams.before;
    if (rep.seams.inliers > 0 && prm.fieldNx >= 2 && prm.fieldNy >= 2) {
        std::vector<std::array<std::vector<double>, 3>> solved(S);
        for (int c = 0; c < 3; ++c) {
            LsqRows rows;
            for (size_t pi = 0; pi < pairs.size(); ++pi) {
                if (!inlier[pi]) continue;
                const auto& pr = pairs[pi];
                int ia[4], ib[4]; float wa[4], wb[4];
                fieldWeights(prm.fieldNx, prm.fieldNy, pr.a * FN, pr.ua, pr.va, ia, wa);
                fieldWeights(prm.fieldNx, prm.fieldNy, pr.b * FN, pr.ub, pr.vb, ib, wb);
                // off_a(uv_a) - off_b(uv_b) = (m_b + g_b) - (m_a + g_a)
                LsqRows::Row r;
                r.n = 8;
                for (int k = 0; k < 4; ++k) { r.idx[k] = ia[k]; r.a[k] = wa[k]; r.idx[4 + k] = ib[k]; r.a[4 + k] = -wb[k]; }
                r.rhs = static_cast<float>((pr.cb[c] + lg[pr.b][c]) - (pr.ca[c] + lg[pr.a][c]));
                rows.addRow(r, pr.w);
            }
            for (size_t st = 0; st < S; ++st) for (int j = 0; j < prm.fieldNy; ++j) for (int i = 0; i < prm.fieldNx; ++i) {
                const int k = static_cast<int>(st) * FN + j * prm.fieldNx + i;
                rows.add({k}, {1.0f}, 0.0f, prm.wAnchor);
                if (i + 1 < prm.fieldNx) rows.add({k, k + 1}, {1.0f, -1.0f}, 0.0f, prm.wSmooth);
                if (j + 1 < prm.fieldNy) rows.add({k, k + prm.fieldNx}, {1.0f, -1.0f}, 0.0f, prm.wSmooth);
            }
            const auto x = rows.solve(S * FN, 400, 1e-6);
            for (size_t st = 0; st < S; ++st) {
                solved[st][c].assign(x.begin() + st * FN, x.begin() + (st + 1) * FN);
                for (double& o : solved[st][c]) o = std::clamp(o, -static_cast<double>(prm.maxOffsetLog), static_cast<double>(prm.maxOffsetLog));
            }
        }
        field = std::move(solved);
        rep.seams.after = seamDiff(true, true);
        rep.seams.fieldKept = rep.seams.after < base;
        if (!rep.seams.fieldKept) { for (auto& f : field) for (auto& ch : f) ch.clear(); rep.seams.after = base; }
    } else rep.seams.after = base;
    rep.gains.resize(S);
    for (size_t a = 0; a < S; ++a) for (int c = 0; c < 3; ++c) rep.gains[a][c] = static_cast<float>(std::exp(lg[a][c]));

    // each observed sample's colour, agreed: gain and offset applied in linear light
    for (auto& smp : samples) {
        if (smp.view < 0) continue;
        float out[3] = {smp.c.x, smp.c.y, smp.c.z};
        for (int c = 0; c < 3; ++c) out[c] = linearToSrgb(srgbToLinear(out[c]) * static_cast<float>(std::exp(lg[smp.view][c] + offsetAt(smp.view, c, smp.u, smp.v))));
        smp.c = Vec3(out[0], out[1], out[2]);
    }

    // the colour of what no station saw: the mean of the observed samples facing the same way (up, or not)
    Vec3 upSum(0, 0, 0), sideSum(0, 0, 0);
    double upN = 0, sideN = 0;
    for (const auto& smp : samples) {
        if (smp.view < 0) continue;
        if (std::fabs(smp.n.y) > 0.7f) { upSum += smp.c; upN += 1; } else { sideSum += smp.c; sideN += 1; }
    }
    const Vec3 upMean = upN > 0 ? upSum / static_cast<float>(upN) : Vec3(0.5f, 0.5f, 0.5f);
    const Vec3 sideMean = sideN > 0 ? sideSum / static_cast<float>(sideN) : Vec3(0.5f, 0.5f, 0.5f);

    std::vector<spz::GaussianSplat> out;
    out.reserve(samples.size());
    for (const auto& smp : samples) {
        spz::GaussianSplat g;
        g.position = smp.p;
        Vec3 col;
        if (smp.view < 0) { col = std::fabs(smp.n.y) > 0.7f ? upMean : sideMean; rep.unobserved++; }
        else col = smp.c;
        g.color = Vec3(std::clamp(col.x, 0.0f, 1.0f), std::clamp(col.y, 0.0f, 1.0f), std::clamp(col.z, 0.0f, 1.0f));
        g.opacity = 1.0f;
        const Vec3 helper = std::fabs(smp.n.y) < 0.9f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        const Vec3 t1 = helper.cross(smp.n).normalized();
        const Vec3 t2 = smp.n.cross(t1).normalized();
        g.rotation = depthbox::DepthToGaussianEngine::quatFromBasis(t1, t2, smp.n).normalized();
        const float sigma = prm.sigmaRatio * smp.s;
        g.scale = Vec3(sigma, sigma, std::max(1e-4f, prm.thicknessRatio * sigma));
        out.push_back(g);
    }
    if (rep.observed > rep.samples) rep.observed = rep.samples;
    return out;
}

} // namespace surfacesplats
} // namespace scratchbox
