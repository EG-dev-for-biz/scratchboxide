/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader's window search (pipeline-k/facade-reader-template.ts matchExemplar), translated line for line: a
 * family's exemplar looked for on one plane by normalised cross-correlation of luminance, coarse then refined, then the
 * crossings of the matches' columns and rows. Every sum is taken in the TypeScript's order and its doubles' rounding
 * (contraction off), the grids are float32 as its Float32Arrays are, and Math.round is js::round, so the matches are its
 * matches bit for bit (template-match-native.test.ts holds the parity). The plane's coarse grid is resampled once for all
 * its exemplars; the exemplars, the coarse scores' rows and the refinements of the peaks run on the thread pool, each
 * writing only its own slot, so the result does not depend on the thread count.
 *
 * What stays in TypeScript: the match's rounded ncc, panes and plane, the final sort (each a stable sort with the same
 * comparator), and everything readFromTemplates does with the matches.
 */

#pragma once

#include "scratchbox_js_math.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <vector>

SCRATCHBOX_JS_NO_CONTRACT

namespace scratchbox {
namespace template_match {

/** TEMPLATE_PARAMS's fields matchExemplar reads. */
struct Params { double coarseM = 0.25, minNcc = 0.6, gridNcc = 0.45, minCovered = 0.85, openingCovered = 0.6; };

/** A grid of luminance (NaN = not covered): LumGrid. */
struct Grid { std::vector<float> L; long W = 0, H = 0; double pixel = 0; };

struct Exemplar { std::vector<float> patch; long pw = 0, ph = 0; double pixel = 0; double opening[4] = {0, 0, 0, 0}; };

/** One match: the opening's rectangle, its correlation (unrounded) and whether it filled a gap in the grid. */
struct Match { double rect[4]; double s; bool grid; };

/** resample: each new texel the mean of the covered source texels under it (at least the one it falls in). */
inline Grid resample(const std::vector<float>& L, long W, long H, double from, double to) {
    const double f = to / from;
    const long w = static_cast<long>(js::max(1, js::round(W / f))), h = static_cast<long>(js::max(1, js::round(H / f)));
    Grid out;
    out.L.assign(static_cast<size_t>(w) * h, 0.0f);
    out.W = w; out.H = h; out.pixel = to;
    for (long y = 0; y < h; y++) for (long x = 0; x < w; x++) {
        const long y0 = static_cast<long>(std::floor(y * f)), y1 = std::max(y0 + 1, static_cast<long>(std::floor((y + 1) * f)));
        const long x0 = static_cast<long>(std::floor(x * f)), x1 = std::max(x0 + 1, static_cast<long>(std::floor((x + 1) * f)));
        double s = 0;
        long n = 0;
        for (long yy = y0; yy < std::min(H, y1); yy++) for (long xx = x0; xx < std::min(W, x1); xx++) {
            const double v = L[static_cast<size_t>(yy * W + xx)];
            if (std::isfinite(v)) { s += v; n++; }
        }
        out.L[static_cast<size_t>(y * w + x)] = n ? static_cast<float>(s / n) : std::numeric_limits<float>::quiet_NaN();
    }
    return out;
}

/** nccAt: the correlation of patch t placed at (ox, oy) on g over the texels both cover; -1 when too few are. */
inline double nccAt(const Grid& g, const float* t, long tw, long th, long ox, long oy, double minCovered) {
    long n = 0;
    double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (long y = 0; y < th; y++) {
        const long gy = oy + y;
        if (gy < 0 || gy >= g.H) continue;
        for (long x = 0; x < tw; x++) {
            const long gx = ox + x;
            if (gx < 0 || gx >= g.W) continue;
            const double a = t[y * tw + x], b = g.L[static_cast<size_t>(gy * g.W + gx)];
            if (!std::isfinite(a) || !std::isfinite(b)) continue;
            n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
        }
    }
    if (n < minCovered * tw * th) return -1;
    const double va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
    if (!(va > 1e-6) || !(vb > 1e-6)) return -1;
    return (sab - (sa * sb) / n) / std::sqrt(va * vb);
}

namespace detail {

/** The middle of each cluster of sorted values no more than tol apart (matchExemplar's cluster). */
inline std::vector<double> cluster(std::vector<double> v, double tol) {
    std::stable_sort(v.begin(), v.end(), [](double a, double b) { return a - b < 0; });
    std::vector<std::vector<double>> out;
    for (double x : v) {
        if (!out.empty() && x - out.back().back() <= tol) out.back().push_back(x);
        else out.push_back({x});
    }
    std::vector<double> mids;
    mids.reserve(out.size());
    for (const auto& c : out) mids.push_back(c[c.size() >> 1]);
    return mids;
}

} // namespace detail

/**
 * matchExemplar on a plane whose coarse grid `cg` (resample(g, g.pixel, P.coarseM)) is already made: the matches in the
 * order the TypeScript pushes them (the peaks', then the grid's).
 */
inline std::vector<Match> matchExemplar(const Grid& g, const Grid& cg, const Exemplar& ex, const Params& P, FixedThreadPool* pool) {
    const Grid t = resample(ex.patch, ex.pw, ex.ph, ex.pixel, g.pixel);
    const double k = ex.pixel / g.pixel;
    const double opening[4] = {ex.opening[0] * k, ex.opening[1] * k, ex.opening[2] * k, ex.opening[3] * k};
    const Grid ct = resample(t.L, t.W, t.H, g.pixel, P.coarseM);
    std::vector<float> scores(static_cast<size_t>(cg.W) * cg.H, -1.0f);
    const auto scoreRow = [&](size_t yi) {
        const long y = static_cast<long>(yi);
        for (long x = 0; x + ct.W <= cg.W; x++) scores[static_cast<size_t>(y * cg.W + x)] = static_cast<float>(nccAt(cg, ct.L.data(), ct.W, ct.H, x, y, P.minCovered));
    };
    const long rowsToScore = std::max(0L, cg.H - ct.H + 1);
    if (pool) pool->forEach(static_cast<size_t>(rowsToScore), scoreRow);
    else for (long y = 0; y < rowsToScore; y++) scoreRow(static_cast<size_t>(y));
    // local maxima at minNcc, at least half an exemplar apart
    struct Peak { long x, y; };
    std::vector<Peak> peaks;
    const long rx = std::max(1L, ct.W / 2), ry = std::max(1L, ct.H / 2);
    for (long y = 0; y < cg.H; y++) for (long x = 0; x < cg.W; x++) {
        const float s = scores[static_cast<size_t>(y * cg.W + x)];
        if (s < P.minNcc) continue;
        bool top = true;
        for (long yy = std::max(0L, y - ry); yy <= std::min(cg.H - 1, y + ry) && top; yy++) for (long xx = std::max(0L, x - rx); xx <= std::min(cg.W - 1, x + rx); xx++) {
            const float o = scores[static_cast<size_t>(yy * cg.W + xx)];
            if (o > s || (o == s && yy * cg.W + xx < y * cg.W + x)) { top = false; break; }
        }
        if (top) peaks.push_back({x, y});
    }
    // each peak refined at the plane's pixel, within one coarse texel
    const double f = P.coarseM / g.pixel;
    const long r = static_cast<long>(std::ceil(f));
    struct Best { double x, y, s; };
    const auto refine = [&](double cx, double cy) {
        const double rcx = js::round(cx), rcy = js::round(cy);
        Best best{rcx, rcy, -1};
        for (long dy = -r; dy <= r; dy++) for (long dx = -r; dx <= r; dx++) {
            const double x = rcx + dx, y = rcy + dy, s = nccAt(g, t.L.data(), t.W, t.H, static_cast<long>(x), static_cast<long>(y), P.minCovered);
            if (s > best.s) best = {x, y, s};
        }
        return best;
    };
    const auto at = [&](double x, double y, double out[4]) { out[0] = x + opening[0]; out[1] = y + opening[1]; out[2] = x + opening[2]; out[3] = y + opening[3]; };
    // the opening itself covered by the photo where it would be drawn
    const auto covered = [&](const double rc[4]) {
        long n = 0, c = 0;
        const long y0 = static_cast<long>(js::max(0, std::floor(rc[1]))), y1 = static_cast<long>(js::min(static_cast<double>(g.H), std::ceil(rc[3])));
        const long x0 = static_cast<long>(js::max(0, std::floor(rc[0]))), x1 = static_cast<long>(js::min(static_cast<double>(g.W), std::ceil(rc[2])));
        for (long y = y0; y < y1; y++) for (long x = x0; x < x1; x++) { n++; if (std::isfinite(g.L[static_cast<size_t>(y * g.W + x)])) c++; }
        return n > 0 && c >= P.openingCovered * n;
    };
    std::vector<Best> refined(peaks.size());
    const auto refinePeak = [&](size_t i) { refined[i] = refine(peaks[i].x * f, peaks[i].y * f); };
    if (pool) pool->forEach(peaks.size(), refinePeak);
    else for (size_t i = 0; i < peaks.size(); i++) refinePeak(i);
    std::vector<Match> found;
    for (const Best& b : refined) {
        Match m{};
        at(b.x, b.y, m.rect);
        if (b.s >= P.minNcc && covered(m.rect)) { m.s = b.s; m.grid = false; found.push_back(m); }
    }
    if (found.empty()) return found;
    // the matches' columns and rows; a crossing with no match is an opening when the photo there still matches at gridNcc
    const double ow = opening[2] - opening[0], oh = opening[3] - opening[1];
    std::vector<double> xs, ys;
    for (const Match& m : found) { xs.push_back(m.rect[0]); ys.push_back(m.rect[1]); }
    const std::vector<double> cols = detail::cluster(xs, 0.3 * ow), rows = detail::cluster(ys, 0.3 * oh);
    const auto near = [&](double x, double y) {
        for (const Match& m : found) if (std::fabs(m.rect[0] - x) <= 0.3 * ow && std::fabs(m.rect[1] - y) <= 0.3 * oh) return true;
        return false;
    };
    for (double x : cols) for (double y : rows) {
        if (near(x, y)) continue;
        const Best b = refine(x - opening[0], y - opening[1]);
        Match m{};
        at(b.x, b.y, m.rect);
        if (b.s >= P.gridNcc && covered(m.rect)) { m.s = b.s; m.grid = true; found.push_back(m); }
    }
    return found;
}

/** Every exemplar's matches on the plane g, the coarse grid made once; the exemplars spread over the pool. */
inline std::vector<std::vector<Match>> matchExemplars(const Grid& g, const std::vector<Exemplar>& exemplars, const Params& P, FixedThreadPool* pool) {
    const Grid cg = resample(g.L, g.W, g.H, g.pixel, P.coarseM);
    std::vector<std::vector<Match>> out(exemplars.size());
    const auto one = [&](size_t i) { out[i] = matchExemplar(g, cg, exemplars[i], P, pool); };
    if (pool) pool->forEach(exemplars.size(), one);
    else for (size_t i = 0; i < exemplars.size(); i++) one(i);
    return out;
}

} // namespace template_match
} // namespace scratchbox
