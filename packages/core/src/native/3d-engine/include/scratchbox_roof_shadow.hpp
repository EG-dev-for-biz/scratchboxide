/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ROOF_SHADOW_HPP
#define SCRATCHBOX_ROOF_SHADOW_HPP

/**
 * The numeric kernels of pipeline K's roof cast-shadow lift (packages/core/.../pipeline-k/roof-shadow.ts, roof-shadow/9),
 * translated line for line so the results equal the TypeScript's:
 *   - shadowMap: the orthographic map of the occluders' topmost surface toward a sun (p . s per pixel, float storage);
 *   - shadowedAt / shadowFraction: a point's shadow test against a map (nearest pixel / the four around it);
 *   - planeSums: a sun's accumulators on a roof plane (planeScore's sums; the caller takes the exp, so the
 *     transcendental runs in one place);
 *   - sunSearch: the whole coarse-then-refine sun search over every plane in one call (the step that dominates the run);
 *   - shadowBits: shadowedAt of many points under several suns;
 *   - liftTexels: the lift's texel pass (which texels are lifted, by what fraction), in the order the TypeScript visits them.
 *
 * Parity rules: JS numbers are doubles, Float32Array entries floats (stores rounded through float), Math.round is
 * jsRound below, and loops and reductions run in the same order. Floating-point contraction is off in this header (an
 * a * b + c fused into one rounding would differ from V8). Sun directions, tan(elevation) and logarithm tables come
 * from the caller, computed by the TypeScript itself, so no libm call here can differ from V8's.
 */

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <limits>
#include <thread>
#include <unordered_map>
#include <vector>

#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace scratchbox::roof_shadow {

/** A sun's frame as roof-shadow.ts builds it: s toward the sun, r across it (horizontal), u the third; tanEl = max(0.1, tan(el)). */
struct SunDir { double s[3], r[3], u[3]; double tanEl; };

/** The topmost surface toward the sun over a plane perpendicular to it (roof-shadow.ts ShadowMap). */
struct ShadowMap {
    SunDir d{};
    double X0 = 0, Y1 = 0, mpp = 1, slope = 0;
    int64_t W = 0, H = 0;
    std::vector<float> top;
};

/** Math.round: the nearest integer, halves toward +infinity (floor(x + 0.5) rounds 0.49999999999999994 up). */
inline double jsRound(double x) { const double f = std::floor(x); return x - f >= 0.5 ? f + 1 : f; }

inline double min3(double a, double b, double c) { return std::min(std::min(a, b), c); }
inline double max3(double a, double b, double c) { return std::max(std::max(a, b), c); }

/** Runs fn(i) for i in [0, n) on up to `threads` workers (0: every core), each index once. */
template <class F> void parallelFor(int64_t n, int threads, F&& fn) {
    int nt = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    nt = static_cast<int>(std::min<int64_t>(nt, std::max<int64_t>(1, n)));
    if (nt <= 1) { for (int64_t i = 0; i < n; ++i) fn(i); return; }
    std::atomic<int64_t> next{0};
    std::vector<std::thread> pool;
    for (int t = 0; t < nt; ++t) pool.emplace_back([&] { for (int64_t i; (i = next.fetch_add(1)) < n;) fn(i); });
    for (auto& th : pool) th.join();
}

/**
 * roof-shadow.ts shadowMap over the first `n` triangles of P (nine floats each). Rows are split into bands across
 * `threads` workers; every pixel still sees the triangles in order, so the map is the sequential one.
 */
inline ShadowMap shadowMap(const float* P, int64_t n, const SunDir& d, double mpp, int threads = 1) {
    ShadowMap m;
    m.d = d; m.mpp = mpp;
    const double* r = d.r; const double* u = d.u; const double* s = d.s;
    double x0 = std::numeric_limits<double>::infinity(), x1 = -x0, y0 = x0, y1 = -x0;
    for (int64_t i = 0; i < n * 9; i += 3) {
        const double px = P[i], py = P[i + 1], pz = P[i + 2];
        const double x = px * r[0] + py * r[1] + pz * r[2], y = px * u[0] + py * u[1] + pz * u[2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const int64_t W = static_cast<int64_t>(std::ceil((x1 - x0) / mpp)) + 3, H = static_cast<int64_t>(std::ceil((y1 - y0) / mpp)) + 3;
    const double X0 = x0 - mpp, Y1 = y1 + mpp;
    m.W = W; m.H = H; m.X0 = X0; m.Y1 = Y1;
    m.slope = mpp / d.tanEl;
    m.top.assign(static_cast<size_t>(W * H), -std::numeric_limits<float>::infinity());
    float* top = m.top.data();
    const int nt = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    const int64_t bands = std::max<int64_t>(1, std::min<int64_t>(nt, H / 16));
    parallelFor(bands, nt, [&](int64_t band) {
        const int64_t rowLo = H * band / bands, rowHi = H * (band + 1) / bands - 1;
        double sx[3], sy[3], st[3];
        for (int64_t t = 0; t < n; ++t) {
            const int64_t a = t * 9;
            for (int k = 0; k < 3; ++k) {
                const double px = P[a + k * 3], py = P[a + k * 3 + 1], pz = P[a + k * 3 + 2];
                sx[k] = (px * r[0] + py * r[1] + pz * r[2] - X0) / mpp;
                sy[k] = (Y1 - (px * u[0] + py * u[1] + pz * u[2])) / mpp;
                st[k] = px * s[0] + py * s[1] + pz * s[2];
            }
            const double by0d = std::max(0.0, std::floor(min3(sy[0], sy[1], sy[2]))), by1d = std::min(static_cast<double>(H - 1), std::floor(max3(sy[0], sy[1], sy[2])));
            if (by1d < static_cast<double>(rowLo) || by0d > static_cast<double>(rowHi)) continue;
            const double area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
            const int64_t bx0 = static_cast<int64_t>(std::max(0.0, std::floor(min3(sx[0], sx[1], sx[2])))), bx1 = static_cast<int64_t>(std::min(static_cast<double>(W - 1), std::floor(max3(sx[0], sx[1], sx[2]))));
            const int64_t by0 = std::max(static_cast<int64_t>(by0d), rowLo), by1 = std::min(static_cast<int64_t>(by1d), rowHi);
            if (std::fabs(area) < 1e-9) {
                // edge-on to the sun (a wall along the light): its highest corner over the pixels it crosses
                const double tm = max3(st[0], st[1], st[2]);
                for (int64_t y = by0; y <= by1; ++y) for (int64_t x = bx0; x <= bx1; ++x) if (tm > top[y * W + x]) top[y * W + x] = static_cast<float>(tm);
                continue;
            }
            const double inv = 1 / area;
            for (int64_t y = by0; y <= by1; ++y) for (int64_t x = bx0; x <= bx1; ++x) {
                const double cx = x + 0.5, cy = y + 0.5;
                const double w0 = ((sx[1] - cx) * (sy[2] - cy) - (sx[2] - cx) * (sy[1] - cy)) * inv;
                const double w1 = ((sx[2] - cx) * (sy[0] - cy) - (sx[0] - cx) * (sy[2] - cy)) * inv;
                const double w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                const double tt = w0 * st[0] + w1 * st[1] + w2 * st[2];
                const int64_t i = y * W + x;
                if (tt > top[i]) top[i] = static_cast<float>(tt);
            }
        }
    });
    return m;
}

/** roof-shadow.ts shadowedAt: something of the mesh stands between the point and the sun (nearest pixel). */
inline bool shadowedAt(const ShadowMap& m, double x, double y, double z, double biasM) {
    const double* r = m.d.r; const double* u = m.d.u; const double* s = m.d.s;
    const double px = std::floor((x * r[0] + y * r[1] + z * r[2] - m.X0) / m.mpp), py = std::floor((m.Y1 - (x * u[0] + y * u[1] + z * u[2])) / m.mpp);
    if (px < 0 || py < 0 || px >= static_cast<double>(m.W) || py >= static_cast<double>(m.H)) return false;
    return m.top[static_cast<size_t>(static_cast<int64_t>(py) * m.W + static_cast<int64_t>(px))] > x * s[0] + y * s[1] + z * s[2] + biasM + m.slope;
}

/** roof-shadow.ts shadowFraction: the shadowed share of a point from the four map pixels around it. */
inline double shadowFraction(const ShadowMap& m, double x, double y, double z, double biasM) {
    const double* r = m.d.r; const double* u = m.d.u; const double* s = m.d.s;
    const double fx = (x * r[0] + y * r[1] + z * r[2] - m.X0) / m.mpp - 0.5, fy = (m.Y1 - (x * u[0] + y * u[1] + z * u[2])) / m.mpp - 0.5;
    const double x0 = std::floor(fx), y0 = std::floor(fy), ax = fx - x0, ay = fy - y0, t = x * s[0] + y * s[1] + z * s[2] + biasM + m.slope;
    const double corners[4][3] = {{0, 0, (1 - ax) * (1 - ay)}, {1, 0, ax * (1 - ay)}, {0, 1, (1 - ax) * ay}, {1, 1, ax * ay}};
    double f = 0;
    for (const auto& c : corners) {
        const double px = x0 + c[0], py = y0 + c[1];
        if (px < 0 || py < 0 || px >= static_cast<double>(m.W) || py >= static_cast<double>(m.H)) continue;
        if (m.top[static_cast<size_t>(static_cast<int64_t>(py) * m.W + static_cast<int64_t>(px))] > t) f += c[2];
    }
    return f;
}

/** Roof cells: 3D point and log linear colour, three floats each (roof-shadow.ts Cells). */
struct Cells { int64_t n = 0; const float* p = nullptr; const float* c = nullptr; };

/** planeScore's accumulators: counts lit/shadowed, the channel and luminance log sums, the checkerboard halves'. */
struct PlaneSums { double n[2] = {0, 0}; double sum[2][4] = {{0, 0, 0, 0}, {0, 0, 0, 0}}; double hs[2][2] = {{0, 0}, {0, 0}}; double hn[2][2] = {{0, 0}, {0, 0}}; };

inline double lum(const float* c, int64_t i) { return 0.2126 * c[i * 3] + 0.7152 * c[i * 3 + 1] + 0.0722 * c[i * 3 + 2]; }

/** roof-shadow.ts planeScore up to its sums (the caller forms share, ratio, rgb and halves from them). */
inline PlaneSums planeSums(const Cells& cells, const int32_t* idx, int64_t m, const ShadowMap& map, double biasM, double halfBlockM) {
    PlaneSums q;
    for (int64_t j = 0; j < m; ++j) {
        const int64_t i = idx[j];
        const int sh = shadowedAt(map, cells.p[i * 3], cells.p[i * 3 + 1], cells.p[i * 3 + 2], biasM) ? 1 : 0;
        q.n[sh]++;
        for (int k = 0; k < 3; ++k) q.sum[sh][k] += cells.c[i * 3 + k];
        const double L = lum(cells.c, i);
        q.sum[sh][3] += L;
        const int half = static_cast<int>(static_cast<int64_t>(std::floor(cells.p[i * 3] / halfBlockM) + std::floor(cells.p[i * 3 + 2] / halfBlockM)) & 1);
        q.hs[half][sh] += L; q.hn[half][sh]++;
    }
    return q;
}

/** The lit-minus-shadowed mean log luminance (ratio = exp of it); NaN when either side is empty (planeScore's ratio 0). */
inline double logRatio(const PlaneSums& q) { return q.n[0] && q.n[1] ? q.sum[0][3] / q.n[0] - q.sum[1][3] / q.n[1] : std::numeric_limits<double>::quiet_NaN(); }

struct SunSearchInput {
    const float* P = nullptr; int64_t n = 0;
    Cells cells;
    std::vector<std::vector<int32_t>> planes;
    double coarseMpp = 0.4, biasM = 0.5, halfBlockM = 4, minShare = 0.1, maxShare = 0.9;
    std::vector<SunDir> coarse;
    /** Per coarse sun, its refinement neighbours in roof-shadow.ts's order (da, then de; the centre and out-of-range elevations left out). */
    std::vector<std::vector<SunDir>> refine;
    /** Per plane, the coarse sun to refine around (-1: the first of the highest ratio among the valid ones). */
    std::vector<int32_t> forcedCentre;
    int threads = 0;
};

struct SunSearchEntry { int32_t coarse; int32_t refine; PlaneSums sums; };

struct SunSearchResult {
    int64_t candidates = 0;
    std::vector<int32_t> centre;
    /** Per plane, its scored suns in roof-shadow.ts's push order: every coarse sun, then its centre's neighbours. */
    std::vector<std::vector<SunSearchEntry>> scored;
    /** Per coarse sun, every cell's shadow under it (coarseBits). */
    std::vector<std::vector<uint8_t>> bits;
};

/**
 * Step 3 of roofShadowLift in one call: every coarse sun scored on every plane (and every cell's shadow kept), then each
 * plane's best valid coarse sun refined. Suns are mapped in parallel; each result goes to its own slot.
 */
inline SunSearchResult sunSearch(const SunSearchInput& in) {
    const int64_t nc = static_cast<int64_t>(in.coarse.size()), np = static_cast<int64_t>(in.planes.size()), ncells = in.cells.n;
    SunSearchResult res;
    res.scored.assign(static_cast<size_t>(np), {});
    res.bits.assign(static_cast<size_t>(nc), {});
    res.centre.assign(static_cast<size_t>(np), -1);
    std::vector<std::vector<PlaneSums>> coarseSums(static_cast<size_t>(nc));
    parallelFor(nc, in.threads, [&](int64_t c) {
        const ShadowMap m = shadowMap(in.P, in.n, in.coarse[c], in.coarseMpp, 1);
        auto& sums = coarseSums[c];
        sums.resize(static_cast<size_t>(np));
        for (int64_t k = 0; k < np; ++k) sums[k] = planeSums(in.cells, in.planes[k].data(), static_cast<int64_t>(in.planes[k].size()), m, in.biasM, in.halfBlockM);
        auto& bits = res.bits[c];
        bits.resize(static_cast<size_t>(ncells));
        for (int64_t i = 0; i < ncells; ++i) bits[i] = shadowedAt(m, in.cells.p[i * 3], in.cells.p[i * 3 + 1], in.cells.p[i * 3 + 2], in.biasM) ? 1 : 0;
    });
    res.candidates = nc;
    struct Job { int64_t plane; int32_t coarse; int32_t refine; };
    std::vector<Job> jobs;
    for (int64_t k = 0; k < np; ++k) {
        auto& list = res.scored[k];
        int32_t best = -1;
        double bestD = 0;
        for (int64_t c = 0; c < nc; ++c) {
            const PlaneSums& q = coarseSums[c][k];
            list.push_back({static_cast<int32_t>(c), -1, q});
            const double share = q.n[1] / std::max(1.0, q.n[0] + q.n[1]), d = logRatio(q);
            // valid: share in range and ratio > 0 (ratio is exp(d): both sides populated; |d| stays far from exp's underflow)
            if (share >= in.minShare && share <= in.maxShare && !std::isnan(d) && (best < 0 || d > bestD)) { best = static_cast<int32_t>(c); bestD = d; }
        }
        const int32_t forced = k < static_cast<int64_t>(in.forcedCentre.size()) ? in.forcedCentre[k] : -1;
        if (best < 0) continue;
        const int32_t centre = forced >= 0 ? forced : best;
        res.centre[k] = centre;
        for (int32_t j = 0; j < static_cast<int32_t>(in.refine[centre].size()); ++j) jobs.push_back({k, centre, j});
    }
    std::vector<PlaneSums> refined(jobs.size());
    parallelFor(static_cast<int64_t>(jobs.size()), in.threads, [&](int64_t j) {
        const Job& job = jobs[j];
        const ShadowMap m = shadowMap(in.P, in.n, in.refine[job.coarse][job.refine], in.coarseMpp, 1);
        refined[j] = planeSums(in.cells, in.planes[job.plane].data(), static_cast<int64_t>(in.planes[job.plane].size()), m, in.biasM, in.halfBlockM);
    });
    for (size_t j = 0; j < jobs.size(); ++j) res.scored[jobs[j].plane].push_back({jobs[j].coarse, jobs[j].refine, refined[j]});
    res.candidates += static_cast<int64_t>(jobs.size());
    return res;
}

/** shadowedAt of every point under each sun's map (points three floats each); one byte per point per sun. */
inline std::vector<std::vector<uint8_t>> shadowBits(const float* P, int64_t n, const std::vector<SunDir>& suns, double mpp, const float* points, int64_t npoints, double biasM, int threads = 0) {
    std::vector<std::vector<uint8_t>> out(suns.size());
    parallelFor(static_cast<int64_t>(suns.size()), threads, [&](int64_t k) {
        const ShadowMap m = shadowMap(P, n, suns[k], mpp, 1);
        auto& bits = out[k];
        bits.resize(static_cast<size_t>(npoints));
        for (int64_t i = 0; i < npoints; ++i) bits[i] = shadowedAt(m, points[i * 3], points[i * 3 + 1], points[i * 3 + 2], biasM) ? 1 : 0;
    });
    return out;
}

/** A photo: its texels and harmonise mask (0: no triangle uses the texel). */
struct Photo { int64_t W = 0, H = 0; const uint8_t* rgba = nullptr; const uint8_t* mask = nullptr; };

/** One photo's sun: the index into the suns, and log(0.2126 r + 0.7152 g + 0.0722 b) of its ratio. */
struct PhotoSun { int32_t sun = -1; double logFull = 0; };
/** A terrace across photos: its sun, log of its ratio's luminance, its lit level. */
struct CompSun { int32_t sun = -1; double logFull = 0; double lit = 0; };

struct LiftInput {
    /** Occluders; the first soupN triangles are the twin (the soup the map from above is drawn over). */
    const float* P = nullptr; int64_t n = 0; int64_t soupN = 0;
    const float* UV = nullptr; const int32_t* img = nullptr; const float* ny = nullptr;
    SunDir above{}; double aboveMpp = 0.25, fineMpp = 0.15, biasM = 0.5, flatNy = 0.7, terraceBinM = 1, componentGridM = 2;
    /** Math.log(1e-4 + SRGB8_TO_LINEAR[v]) for every byte. */
    double logLin[256] = {};
    std::unordered_map<int32_t, Photo> photos;
    std::vector<SunDir> suns;
    std::unordered_map<int32_t, PhotoSun> photoSun;
    /** Lifted terraces `${im}:${bin}` and their lit level (NaN: none known). */
    std::unordered_map<int64_t, double> liftTerrace;
    bool hasComp = false;
    std::vector<CompSun> comps;
    /** Grid cells `${bin}:${gx}:${gz}` of the terraces across photos that have a sun, to their comp. */
    std::unordered_map<uint64_t, int32_t> compCells;
    int threads = 0;
};

/** One lifted texel: photo, texel, source (-1: its photo's sun, else the comp) and the shadowed share after the cap. */
struct LiftedTexel { int32_t im; int32_t texel; int32_t src; double f; };

inline int64_t terraceKey(int32_t im, int64_t bin) { return (static_cast<int64_t>(im) << 40) ^ (bin & ((int64_t(1) << 40) - 1)); }
inline uint64_t gridCellKey(int64_t bin, int64_t gx, int64_t gz) {
    return (static_cast<uint64_t>(bin & 0x1fffff) << 42) | (static_cast<uint64_t>(gx & 0x1fffff) << 21) | static_cast<uint64_t>(gz & 0x1fffff);
}

/**
 * Step 7 of roofShadowLift without the colour change: for each sun (in order) a fine map, then every flat roof triangle's
 * texels in the TypeScript's visiting order, each lifted texel listed with its fraction. The caller applies the gain
 * (Math.pow and the sRGB curve stay in V8). Triangles are split across workers in contiguous runs and their lists
 * joined in order.
 */
inline std::vector<LiftedTexel> liftTexels(const LiftInput& in) {
    const ShadowMap above = shadowMap(in.P, in.soupN, in.above, in.aboveMpp, in.threads);
    std::vector<LiftedTexel> out;
    const int nt = in.threads > 0 ? in.threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    for (int32_t sunIdx = 0; sunIdx < static_cast<int32_t>(in.suns.size()); ++sunIdx) {
        const ShadowMap m = shadowMap(in.P, in.n, in.suns[sunIdx], in.fineMpp, in.threads);
        const int64_t chunks = std::max<int64_t>(1, std::min<int64_t>(nt * 8, in.soupN / 256));
        std::vector<std::vector<LiftedTexel>> parts(static_cast<size_t>(chunks));
        parallelFor(chunks, nt, [&](int64_t ch) {
            auto& part = parts[ch];
            const int64_t t0 = in.soupN * ch / chunks, t1 = in.soupN * (ch + 1) / chunks;
            for (int64_t t = t0; t < t1; ++t) {
                const int32_t im = in.img[t];
                if (im < 0 || std::fabs(static_cast<double>(in.ny[t])) < in.flatNy) continue;
                const auto ps = in.photoSun.find(im);
                const bool sun = ps != in.photoSun.end();
                if (sun ? ps->second.sun != sunIdx : !in.hasComp) continue;
                const auto ph = in.photos.find(im);
                if (ph == in.photos.end()) continue;
                const Photo& photo = ph->second;
                const int64_t a = t * 9, q = t * 6, W = photo.W, H = photo.H;
                const double ax = in.UV[q] * static_cast<double>(W), ay = in.UV[q + 1] * static_cast<double>(H), bx = in.UV[q + 2] * static_cast<double>(W), by = in.UV[q + 3] * static_cast<double>(H), cx = in.UV[q + 4] * static_cast<double>(W), cy = in.UV[q + 5] * static_cast<double>(H);
                const double det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
                if (std::fabs(det) < 1e-12) continue;
                const int64_t x0 = static_cast<int64_t>(std::max(0.0, std::floor(min3(ax, bx, cx)))), x1 = static_cast<int64_t>(std::min(static_cast<double>(W - 1), std::ceil(max3(ax, bx, cx))));
                const int64_t y0 = static_cast<int64_t>(std::max(0.0, std::floor(min3(ay, by, cy)))), y1 = static_cast<int64_t>(std::min(static_cast<double>(H - 1), std::ceil(max3(ay, by, cy))));
                const float* Pt = in.P + a;
                for (int64_t y = y0; y <= y1; ++y) for (int64_t x = x0; x <= x1; ++x) {
                    const int64_t i = y * W + x;
                    if (photo.mask[i] == 0) continue;
                    const double px = x + 0.5, py = y + 0.5;
                    const double b1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det, b2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det, b0 = 1 - b1 - b2;
                    if (b0 < 0 || b1 < 0 || b2 < 0) continue;
                    const double wx = b0 * Pt[0] + b1 * Pt[3] + b2 * Pt[6], wy = b0 * Pt[1] + b1 * Pt[4] + b2 * Pt[7], wz = b0 * Pt[2] + b1 * Pt[5] + b2 * Pt[8];
                    double logFull, lit;
                    bool hasLit;
                    int32_t src;
                    if (sun) {
                        const auto tk = in.liftTerrace.find(terraceKey(im, static_cast<int64_t>(jsRound(wy / in.terraceBinM))));
                        if (tk == in.liftTerrace.end()) continue;
                        logFull = ps->second.logFull; lit = tk->second; hasLit = !std::isnan(lit); src = -1;
                    } else {
                        const auto cc = in.compCells.find(gridCellKey(static_cast<int64_t>(jsRound(wy / in.terraceBinM)), static_cast<int64_t>(std::floor(wx / in.componentGridM)), static_cast<int64_t>(std::floor(wz / in.componentGridM))));
                        if (cc == in.compCells.end()) continue;
                        const CompSun& cs = in.comps[cc->second];
                        if (cs.sun != sunIdx) continue;
                        logFull = cs.logFull; lit = cs.lit; hasLit = true; src = cc->second;
                    }
                    if (shadowedAt(above, wx, wy, wz, in.biasM)) continue;
                    double f = shadowFraction(m, wx, wy, wz, in.biasM);
                    if (f <= 0) continue;
                    // never above the terrace's lit level: the share of the lift this texel's own darkness asks for
                    if (hasLit) {
                        const double L = 0.2126 * in.logLin[photo.rgba[i * 4]] + 0.7152 * in.logLin[photo.rgba[i * 4 + 1]] + 0.0722 * in.logLin[photo.rgba[i * 4 + 2]];
                        const double full = f * logFull;
                        if (full > 0) f *= std::max(0.0, std::min(1.0, (lit - L) / full));
                        if (f <= 0.01) continue;
                    }
                    part.push_back({im, static_cast<int32_t>(i), src, f});
                }
            }
        });
        for (auto& part : parts) out.insert(out.end(), part.begin(), part.end());
    }
    return out;
}

} // namespace scratchbox::roof_shadow

#endif // SCRATCHBOX_ROOF_SHADOW_HPP
