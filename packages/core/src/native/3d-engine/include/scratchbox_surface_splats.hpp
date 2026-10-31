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
 * - Colour: the two best station views of each sample (in frame, not occluded in the station's depth, |n.view| at
 *   least minCos), scored by projected area (priority * cos / z^2, after Waechter et al.), blended with the best
 *   dominant, each read over the splat's footprint in its image (Mip-Splatting's bound). A sample no view meets at
 *   minCos takes the best view down to relaxedCos; none at all takes the mean colour of observed samples facing the
 *   same way, and is counted as unobserved.
 * - Per-station gains: a gain per station fitted where two stations see the same sample (log-luminance, anchored to a
 *   mean of 1, after VastGaussian's per-image appearance), so one station's exposure does not seam against another's.
 * - Shape: a 2DGS surfel on the triangle's plane, in-plane sigma sigmaRatio * s so neighbours overlap.
 */

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_depth_to_gaussian.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
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
    float sigmaRatio = 0.55f, thicknessRatio = 0.05f;
    uint32_t seed = 1;
};

struct Report {
    size_t triangles = 0, samples = 0, observed = 0, relaxed = 0, unobserved = 0, invisibleTriangles = 0, skippedTriangles = 0;
    float spacingScale = 1.0f;
    std::vector<float> gains;
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

/** Mean colour over a footprint of `rad` pixels around (u, v): 3 x 3 bilinear taps. */
inline Vec3 footprintColour(const StationView& s, float u, float v, float rad) {
    Vec3 acc(0, 0, 0);
    const float step = std::max(0.0f, rad) / 1.5f;
    for (int j = -1; j <= 1; ++j) for (int i = -1; i <= 1; ++i) {
        const float x = std::clamp(u + i * step, 0.0f, s.W - 1.001f), y = std::clamp(v + j * step, 0.0f, s.H - 1.001f);
        const int x0 = static_cast<int>(x), y0 = static_cast<int>(y);
        const float fx = x - x0, fy = y - y0;
        auto px = [&](int xx, int yy, int c) { return s.rgb[(static_cast<size_t>(yy) * s.W + xx) * 3 + c] / 255.0f; };
        for (int c = 0; c < 3; ++c) {
            const float val = (px(x0, y0, c) * (1 - fx) + px(x0 + 1, y0, c) * fx) * (1 - fy) + (px(x0, y0 + 1, c) * (1 - fx) + px(x0 + 1, y0 + 1, c) * fx) * fy;
            if (c == 0) acc.x += val; else if (c == 1) acc.y += val; else acc.z += val;
        }
    }
    return acc / 9.0f;
}

inline float halton(uint32_t i, uint32_t base) {
    float f = 1.0f, r = 0.0f;
    while (i > 0) { f /= base; r += f * (i % base); i /= base; }
    return r;
}

inline uint32_t hash32(uint32_t x) { x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16; return x; }

/** Builds the surface splats of `tris` (9 floats each) coloured from `stations`. */
inline std::vector<spz::GaussianSplat> build(const std::vector<float>& tris, const std::vector<StationView>& stations, const Params& prm, Report& rep) {
    const size_t T = tris.size() / 9;
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

    struct Sample { Vec3 p; Vec3 n; float s; int s0 = -1, s1 = -1; Vec3 c0, c1; float w0 = 0, w1 = 0; };
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

    // pass 1: the two best views of each sample
    for (auto& smp : samples) {
        float best0 = 0, best1 = 0, relaxedBest = 0;
        int relaxedId = -1;
        float ru = 0, rv = 0, rz = 0, b0u = 0, b0v = 0, b0z = 0, b1u = 0, b1v = 0, b1z = 0;
        for (size_t si = 0; si < stations.size(); ++si) {
            const auto& st = stations[si];
            float u, v, z;
            if (!project(st, smp.p, prm, u, v, z)) continue;
            const float cosI = std::fabs(smp.n.dot((st.eye - smp.p).normalized()));
            const float score = st.priority * cosI / (z * z);
            if (cosI >= prm.minCos) {
                if (score > best0) { best1 = best0; smp.s1 = smp.s0; b1u = b0u; b1v = b0v; b1z = b0z; best0 = score; smp.s0 = static_cast<int>(si); b0u = u; b0v = v; b0z = z; }
                else if (score > best1) { best1 = score; smp.s1 = static_cast<int>(si); b1u = u; b1v = v; b1z = z; }
            } else if (cosI >= prm.relaxedCos && score > relaxedBest) { relaxedBest = score; relaxedId = static_cast<int>(si); ru = u; rv = v; rz = z; }
        }
        if (smp.s0 < 0 && relaxedId >= 0) { smp.s0 = relaxedId; best0 = relaxedBest; b0u = ru; b0v = rv; b0z = rz; rep.relaxed++; }
        if (smp.s0 >= 0) {
            const auto& s0 = stations[smp.s0];
            smp.c0 = footprintColour(s0, b0u, b0v, s0.fx * smp.s / b0z * 0.5f);
            smp.w0 = best0 * best0;
            rep.observed++;
        }
        if (smp.s1 >= 0) {
            const auto& s1 = stations[smp.s1];
            smp.c1 = footprintColour(s1, b1u, b1v, s1.fx * smp.s / b1z * 0.5f);
            smp.w1 = best1 * best1 * 0.5f;   // the best view dominates
        }
    }

    // per-station gains from the samples two stations share (log luminance, Gauss-Seidel, anchored to a mean of 1)
    const size_t S = stations.size();
    std::vector<double> pairSum(S * S, 0.0), pairCount(S * S, 0.0);
    auto lum = [](const Vec3& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; };
    for (const auto& smp : samples) {
        if (smp.s0 < 0 || smp.s1 < 0) continue;
        const float l0 = lum(smp.c0), l1 = lum(smp.c1);
        if (l0 < 0.03f || l1 < 0.03f) continue;
        const double d = std::log(l0) - std::log(l1);
        pairSum[smp.s0 * S + smp.s1] += d; pairCount[smp.s0 * S + smp.s1] += 1;
        pairSum[smp.s1 * S + smp.s0] -= d; pairCount[smp.s1 * S + smp.s0] += 1;
    }
    std::vector<double> lg(S, 0.0);
    for (int it = 0; it < 50; ++it) {
        for (size_t a = 0; a < S; ++a) {
            double num = 0, den = 0;
            // log g_a + log l_a = log g_b + log l_b  =>  log g_a = log g_b - (log l_a - log l_b)
            for (size_t b = 0; b < S; ++b) if (pairCount[a * S + b] > 0) { num += pairCount[a * S + b] * (lg[b] - pairSum[a * S + b] / pairCount[a * S + b]); den += pairCount[a * S + b]; }
            if (den > 0) lg[a] = std::clamp(num / den, -0.3, 0.3);
        }
        double mean = 0; for (double v : lg) mean += v; mean /= std::max<size_t>(1, S);
        for (double& v : lg) v -= mean;
    }
    rep.gains.resize(S);
    for (size_t a = 0; a < S; ++a) rep.gains[a] = static_cast<float>(std::exp(lg[a]));

    // the colour of what no station saw: the mean of the observed samples facing the same way (up, or not)
    Vec3 upSum(0, 0, 0), sideSum(0, 0, 0);
    double upN = 0, sideN = 0;
    for (const auto& smp : samples) {
        if (smp.s0 < 0) continue;
        const Vec3 c = smp.c0 * rep.gains[smp.s0];
        if (std::fabs(smp.n.y) > 0.7f) { upSum += c; upN += 1; } else { sideSum += c; sideN += 1; }
    }
    const Vec3 upMean = upN > 0 ? upSum / static_cast<float>(upN) : Vec3(0.5f, 0.5f, 0.5f);
    const Vec3 sideMean = sideN > 0 ? sideSum / static_cast<float>(sideN) : Vec3(0.5f, 0.5f, 0.5f);

    std::vector<spz::GaussianSplat> out;
    out.reserve(samples.size());
    for (const auto& smp : samples) {
        spz::GaussianSplat g;
        g.position = smp.p;
        Vec3 col;
        if (smp.s0 < 0) { col = std::fabs(smp.n.y) > 0.7f ? upMean : sideMean; rep.unobserved++; }
        else {
            col = smp.c0 * (rep.gains[smp.s0] * smp.w0);
            float w = smp.w0;
            if (smp.s1 >= 0) { col += smp.c1 * (rep.gains[smp.s1] * smp.w1); w += smp.w1; }
            col = col / std::max(w, 1e-20f);
        }
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
