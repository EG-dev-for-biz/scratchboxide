/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_RELIEF_AVERAGE_HPP
#define SCRATCHBOX_RELIEF_AVERAGE_HPP

/**
 * Measured relief by averaging along repeats (staged-location pipeline E, the relief stage).
 *
 * Input per face of the clean massing: a relief map, i.e. the scan's outermost surface through a slab about the face,
 * as a metric height along the face normal (h > 0 stands out of the clean plane), sampled on the face's ortho grid,
 * and a validity mask (seen, inside the face, not canopy, not an occluder, not already kept as scanned residual).
 * One scan sample is noisy (photogrammetric melt, 10-30 cm); what repeats is averaged until it is significant:
 *
 *   - Lines along s (rows): per row, the row is cut into blocks `block` metres long (neighbouring texels of one scan
 *     triangle are not independent; a block is one sample), each block's median is a sample, and the row's relief is the
 *     trimmed mean of the blocks with the Tukey-McLaughlin standard error (winsorised sd / ((1 - 2g) sqrt n)). Rows that
 *     stand consistently out of the wall's own line (its mode) form a horizontal band; its cross-section is the row means.
 *   - Lines along t (columns): the same, transposed (openings and accepted band rows masked): vertical elements.
 *   - Lattice units: every opening of a group (similar size) is resampled into one frame (the opening scaled to the group's
 *     median size, a metric margin around it unscaled), co-registered by a small shift search against the median of the
 *     others, and averaged per texel. Scalars are averaged over openings (each opening one sample): the reveal depth (the
 *     core's median), and the projection profiles below, above, left and right of the opening.
 *
 * A feature is kept only when its averaged depth is at least `k` standard errors and `minDepth`, from at least `minBlocks`
 * blocks (lines) or `minOpenings` openings (units). Everything is continuous numbers: no kind of building or ornament is
 * named here; labels the caller passes through are opaque.
 */

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace scratchbox {
namespace relief_average {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

struct Params {
    /** Significance: the averaged depth must reach k standard errors. */
    double k{3.0};
    /** Block length along a line (metres): one independent sample. */
    double block{0.5};
    /** Trim fraction at each end. */
    double trim{0.2};
    /** Least averaged depth worth building (metres). */
    double minDepth{0.05};
    /** Least share of a line's blocks standing out by half the line's depth (bands, verticals). */
    double consistency{0.7};
    /** Least blocks behind a line feature. */
    int minBlocks{6};
    /** Least openings behind a unit feature. */
    int minOpenings{4};
    /** Unit frame: the metric margin around an opening. */
    double margin{0.5};
    /** Unit co-registration: largest shift searched (metres). */
    double shift{0.15};
    /** Samples at the slab's limits are clamp hits, not surface: excluded. */
    double slabLo{-1.5}, slabHi{2.5}, clampGuard{0.06};
    /** Least share of a block that must be valid for the block to be a sample. */
    double blockValid{0.3};
    /** A vertical run may cover at most this share of the face width (wider is the wall itself). */
    double maxVerticalShare{0.5};
    /** A line feature is full-length when it covers at least this share of the line's valid extent. */
    double fullLength{0.8};
    /**
     * The local wall line: a moving median of the block medians over this window (metres, each way in total), the window
     * kept inside the face at its edges. What departs from it locally is relief; a facade's slow bow or tilt is not.
     */
    double detrendWindow{4.0};
};

struct RobustStat { double mean{kNaN}, sd{kNaN}, se{kNaN}; int n{0}; };

/** Trimmed mean with the Tukey-McLaughlin standard error (winsorised sd / ((1 - 2g) sqrt n)). */
inline RobustStat trimmed(std::vector<double> v, double g) {
    RobustStat r;
    v.erase(std::remove_if(v.begin(), v.end(), [](double x) { return !std::isfinite(x); }), v.end());
    r.n = static_cast<int>(v.size());
    if (v.empty()) return r;
    std::sort(v.begin(), v.end());
    const int n = r.n;
    const int cut = static_cast<int>(std::floor(g * n));
    double s = 0;
    for (int i = cut; i < n - cut; ++i) s += v[static_cast<size_t>(i)];
    r.mean = s / std::max(1, n - 2 * cut);
    if (n < 2) return r;
    // winsorised variance
    const double lo = v[static_cast<size_t>(cut)], hi = v[static_cast<size_t>(n - 1 - cut)];
    double wm = 0;
    for (double x : v) wm += std::clamp(x, lo, hi);
    wm /= n;
    double ws = 0;
    for (double x : v) { double d = std::clamp(x, lo, hi) - wm; ws += d * d; }
    const double sw = std::sqrt(ws / (n - 1));
    r.sd = sw;
    const double eff = std::max(1e-6, 1.0 - 2.0 * static_cast<double>(cut) / n);
    r.se = sw / (eff * std::sqrt(static_cast<double>(n)));
    // a floor: fewer than 3 distinct samples cannot show their own spread
    if (n < 3) r.se = std::max(r.se, 1e-3);
    return r;
}

inline double medianOf(std::vector<double> v) {
    v.erase(std::remove_if(v.begin(), v.end(), [](double x) { return !std::isfinite(x); }), v.end());
    if (v.empty()) return kNaN;
    const size_t m = v.size() / 2;
    std::nth_element(v.begin(), v.begin() + static_cast<long>(m), v.end());
    double hi = v[m];
    if (v.size() % 2) return hi;
    double lo = *std::max_element(v.begin(), v.begin() + static_cast<long>(m));
    return 0.5 * (lo + hi);
}

/** A face's relief map: height along the normal (NaN invalid), its ortho frame. */
struct Field {
    int W{0}, H{0};
    double pixel{0.05};
    std::vector<float> h;
    double at(int x, int y) const {
        if (x < 0 || y < 0 || x >= W || y >= H) return kNaN;
        float v = h[static_cast<size_t>(y) * W + x];
        return std::isfinite(v) ? static_cast<double>(v) : kNaN;
    }
};

/** The wall's own line: the mode of the valid heights (1 cm bins, smoothed over 5 cm). */
inline double baselineMode(const Field& f, const Params& p) {
    const double lo = p.slabLo, hi = p.slabHi, bin = 0.01;
    const int B = static_cast<int>(std::ceil((hi - lo) / bin)) + 1;
    std::vector<double> hist(static_cast<size_t>(B), 0.0);
    size_t n = 0;
    for (float v : f.h) if (std::isfinite(v)) { int b = static_cast<int>(std::floor((v - lo) / bin)); if (b >= 0 && b < B) { hist[static_cast<size_t>(b)] += 1; ++n; } }
    if (!n) return 0;
    double best = -1, at = 0;
    for (int b = 0; b < B; ++b) {
        double s = 0;
        for (int d = -2; d <= 2; ++d) { int q = b + d; if (q >= 0 && q < B) s += hist[static_cast<size_t>(q)] * (3 - std::abs(d)); }
        if (s > best) { best = s; at = lo + (b + 0.5) * bin; }
    }
    return at;
}

/**
 * The field made relative to its local wall line: block medians (`block` metres, openings excluded), a moving median of
 * them over `detrendWindow` (shifted inside the face at its edges, so a band at the top of a wall is measured against the
 * wall below it), bilinear between block centres. Returns the RMS of that line's departure from the face's mode.
 */
inline double detrend(Field& f, const Params& p, const std::vector<uint8_t>* exclude) {
    const int B = std::max(1, static_cast<int>(std::lround(p.block / f.pixel)));
    const int GW = (f.W + B - 1) / B, GH = (f.H + B - 1) / B;
    std::vector<double> blk(static_cast<size_t>(GW) * GH, kNaN);
    std::vector<double> v;
    for (int gy = 0; gy < GH; ++gy) for (int gx = 0; gx < GW; ++gx) {
        v.clear();
        int total = 0;
        for (int y = gy * B; y < std::min(f.H, (gy + 1) * B); ++y) for (int x = gx * B; x < std::min(f.W, (gx + 1) * B); ++x) {
            ++total;
            const size_t i = static_cast<size_t>(y) * f.W + x;
            if (exclude && (*exclude)[i]) continue;
            if (std::isfinite(f.h[i])) v.push_back(f.h[i]);
        }
        if (!v.empty() && static_cast<double>(v.size()) >= p.blockValid * total) blk[static_cast<size_t>(gy) * GW + gx] = medianOf(v);
    }
    // the valid extent of the blocks (the window is kept inside it)
    int bx0 = GW, bx1 = -1, by0 = GH, by1 = -1;
    for (int gy = 0; gy < GH; ++gy) for (int gx = 0; gx < GW; ++gx) if (std::isfinite(blk[static_cast<size_t>(gy) * GW + gx])) { bx0 = std::min(bx0, gx); bx1 = std::max(bx1, gx); by0 = std::min(by0, gy); by1 = std::max(by1, gy); }
    if (bx1 < 0) return 0;
    const int R = std::max(1, static_cast<int>(std::lround(0.5 * p.detrendWindow / p.block)));
    auto window = [&](int c, int lo, int hi, int& a, int& b) {
        a = c - R; b = c + R;
        if (b - a > hi - lo) { a = lo; b = hi; return; }
        if (a < lo) { b += lo - a; a = lo; }
        if (b > hi) { a -= b - hi; b = hi; }
    };
    // per block: a robust local plane (Tukey biweight, from the window's median) through the window's blocks, evaluated at
    // the block itself, so the wall's slow slope is followed up to the face's edges where the window is shifted inside
    std::vector<double> base(static_cast<size_t>(GW) * GH, kNaN);
    std::vector<std::array<double, 3>> pts;
    for (int gy = 0; gy < GH; ++gy) for (int gx = 0; gx < GW; ++gx) {
        int xa, xb, ya, yb;
        window(std::clamp(gx, bx0, bx1), bx0, bx1, xa, xb);
        window(std::clamp(gy, by0, by1), by0, by1, ya, yb);
        pts.clear();
        v.clear();
        for (int y = ya; y <= yb; ++y) for (int x = xa; x <= xb; ++x) { double q = blk[static_cast<size_t>(y) * GW + x]; if (std::isfinite(q)) { pts.push_back({static_cast<double>(x - gx), static_cast<double>(y - gy), q}); v.push_back(q); } }
        if (v.empty()) continue;
        double a = medianOf(v), bx = 0, by = 0;
        if (pts.size() >= 6) {
            for (int it = 0; it < 6; ++it) {
                std::vector<double> res;
                for (const auto& q : pts) res.push_back(std::abs(q[2] - (a + bx * q[0] + by * q[1])));
                const double scale = std::max(0.02, 1.4826 * medianOf(res)) * 4.685;
                // weighted least squares for (a, bx, by)
                double S[3][3] = {{0, 0, 0}, {0, 0, 0}, {0, 0, 0}}, r[3] = {0, 0, 0};
                for (const auto& q : pts) {
                    const double e = (q[2] - (a + bx * q[0] + by * q[1])) / scale;
                    if (std::abs(e) >= 1) continue;
                    const double w = (1 - e * e) * (1 - e * e);
                    const double x3[3] = {1, q[0], q[1]};
                    for (int i = 0; i < 3; ++i) { r[i] += w * x3[i] * q[2]; for (int j = 0; j < 3; ++j) S[i][j] += w * x3[i] * x3[j]; }
                }
                const double det = S[0][0] * (S[1][1] * S[2][2] - S[1][2] * S[2][1]) - S[0][1] * (S[1][0] * S[2][2] - S[1][2] * S[2][0]) + S[0][2] * (S[1][0] * S[2][1] - S[1][1] * S[2][0]);
                if (std::abs(det) < 1e-9) break;
                auto solve = [&](int col) {
                    double M[3][3];
                    for (int i = 0; i < 3; ++i) for (int j = 0; j < 3; ++j) M[i][j] = j == col ? r[i] : S[i][j];
                    return (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])) / det;
                };
                a = solve(0); bx = solve(1); by = solve(2);
            }
        }
        base[static_cast<size_t>(gy) * GW + gx] = a;
    }
    // bilinear between block centres
    auto at = [&](int gx, int gy) { gx = std::clamp(gx, 0, GW - 1); gy = std::clamp(gy, 0, GH - 1); double q = base[static_cast<size_t>(gy) * GW + gx]; return std::isfinite(q) ? q : 0.0; };
    double ss = 0; size_t n = 0;
    for (int y = 0; y < f.H; ++y) {
        const double fy = (y + 0.5) / B - 0.5;
        const int y0 = static_cast<int>(std::floor(fy));
        const double wy = fy - y0;
        for (int x = 0; x < f.W; ++x) {
            const double fx = (x + 0.5) / B - 0.5;
            const int x0 = static_cast<int>(std::floor(fx));
            const double wx = fx - x0;
            const double b = (1 - wy) * ((1 - wx) * at(x0, y0) + wx * at(x0 + 1, y0)) + wy * ((1 - wx) * at(x0, y0 + 1) + wx * at(x0 + 1, y0 + 1));
            float& h = f.h[static_cast<size_t>(y) * f.W + x];
            if (std::isfinite(h)) { h = static_cast<float>(h - b); ss += b * b; ++n; }
        }
    }
    return n ? std::sqrt(ss / n) : 0;
}

/** One line (row or column) of the field: its block samples and their robust statistic (relative to the baseline). */
struct LineStat {
    RobustStat st;
    /** Per block: median relief (NaN when the block has too few valid texels). */
    std::vector<double> blocks;
    /** Share of blocks standing out by at least half the mean, in the mean's direction. */
    double agree{0};
    double depth() const { return st.mean; }
};

/** A view of the field as lines along one axis: `along` 0 = rows (lines along s), 1 = columns (lines along t). */
struct Lines {
    const Field& f;
    int along;
    int count() const { return along == 0 ? f.H : f.W; }
    int length() const { return along == 0 ? f.W : f.H; }
    double at(int line, int i) const { return along == 0 ? f.at(i, line) : f.at(line, i); }
};

inline LineStat lineStat(const Lines& L, int line, double base, const Params& p, const std::vector<uint8_t>* exclude = nullptr, int i0 = 0, int i1 = -1) {
    LineStat s;
    const int len = L.length();
    if (i1 < 0) i1 = len;
    const int B = std::max(1, static_cast<int>(std::lround(p.block / L.f.pixel)));
    for (int a = i0; a < i1; a += B) {
        std::vector<double> v;
        int total = 0;
        for (int i = a; i < std::min(i1, a + B); ++i) {
            ++total;
            if (exclude) {
                size_t idx = L.along == 0 ? static_cast<size_t>(line) * L.f.W + i : static_cast<size_t>(i) * L.f.W + line;
                if ((*exclude)[idx]) continue;
            }
            double x = L.at(line, i);
            if (std::isfinite(x)) v.push_back(x - base);
        }
        s.blocks.push_back(static_cast<double>(v.size()) >= p.blockValid * total && !v.empty() ? medianOf(v) : kNaN);
    }
    s.st = trimmed(s.blocks, p.trim);
    if (s.st.n && std::isfinite(s.st.mean) && std::abs(s.st.mean) > 1e-9) {
        int ok = 0;
        for (double b : s.blocks) if (std::isfinite(b) && b * (s.st.mean > 0 ? 1 : -1) >= 0.5 * std::abs(s.st.mean)) ++ok;
        s.agree = static_cast<double>(ok) / s.st.n;
    }
    return s;
}

/** A line feature: a run of lines standing out together (a horizontal band when along = 0, a vertical element when 1). */
struct LineFeature {
    int along{0};
    /** Line range [l0, l1] (inclusive) and the profile lines around it. */
    int l0{0}, l1{0};
    /** Extent along the lines (texel index, [i0, i1)) and whether it spans the line's valid extent. */
    int i0{0}, i1{0};
    bool fullLength{false};
    double depth{0}, se{0}, maxSe{0};
    int blocks{0};
    double agree{0};
    bool accepted{false};
    std::string why;
    /** Profile: per line from l0 - 1 to l1 + 1, the averaged relief (clamped at >= 0 for a projection) and its SE. */
    std::vector<int> lines;
    std::vector<double> profile, profileSe;
};

/**
 * Line features along one axis. Candidates: runs of lines whose mean stands at least minDepth/2 out with at least half
 * their blocks agreeing (a loose screen, so the gate's refusals are counted); kept with the gate: peak depth >= minDepth,
 * >= k SE, >= minBlocks blocks, agreement >= consistency, a run of at least two lines.
 */
inline std::vector<LineFeature> lineFeatures(const Field& f, int along, double base, const Params& p, const std::vector<uint8_t>* exclude) {
    Lines L{f, along};
    const int C = L.count();
    std::vector<LineStat> st(static_cast<size_t>(C));
    for (int l = 0; l < C; ++l) st[static_cast<size_t>(l)] = lineStat(L, l, base, p, exclude);
    auto screen = [&](int l) {
        const auto& s = st[static_cast<size_t>(l)];
        return s.st.n >= 3 && std::isfinite(s.st.mean) && s.st.mean >= 0.5 * p.minDepth && s.agree >= 0.5;
    };
    std::vector<LineFeature> out;
    int l = 0;
    while (l < C) {
        if (!screen(l)) { ++l; continue; }
        int a = l, b = l;
        // allow one-line gaps
        while (b + 1 < C && (screen(b + 1) || (b + 2 < C && screen(b + 2)))) b += screen(b + 1) ? 1 : 2;
        l = b + 1;
        LineFeature lf;
        lf.along = along;
        lf.l0 = a; lf.l1 = b;
        int peak = a;
        for (int q = a; q <= b; ++q) if (st[static_cast<size_t>(q)].st.mean > st[static_cast<size_t>(peak)].st.mean) peak = q;
        const auto& ps = st[static_cast<size_t>(peak)];
        // the extent along the lines: blocks where the run's lines (median) stand at least half its mean depth out
        const int nb = static_cast<int>(ps.blocks.size());
        double runMean = 0; int rm = 0;
        for (int q = a; q <= b; ++q) if (std::isfinite(st[static_cast<size_t>(q)].st.mean)) { runMean += st[static_cast<size_t>(q)].st.mean; ++rm; }
        runMean = rm ? runMean / rm : 0;
        std::vector<int> shows(static_cast<size_t>(nb), 0), seen(static_cast<size_t>(nb), 0);
        for (int j = 0; j < nb; ++j) {
            std::vector<double> v;
            for (int q = a; q <= b; ++q) { double x = st[static_cast<size_t>(q)].blocks[static_cast<size_t>(j)]; if (std::isfinite(x)) v.push_back(x); }
            double m = medianOf(v);
            seen[static_cast<size_t>(j)] = std::isfinite(m);
            shows[static_cast<size_t>(j)] = std::isfinite(m) && m >= 0.5 * runMean;
        }
        // the longest run of showing blocks (one unseen or non-showing block may sit inside it)
        int bestA = -1, bestB = -2;
        for (int j = 0; j < nb; ++j) {
            if (!shows[static_cast<size_t>(j)]) continue;
            int k2 = j, gaps = 0;
            int lastShow = j;
            while (k2 + 1 < nb) {
                if (shows[static_cast<size_t>(k2 + 1)]) { lastShow = k2 + 1; gaps = 0; }
                else if (++gaps > 1) break;
                ++k2;
            }
            if (lastShow - j > bestB - bestA) { bestA = j; bestB = lastShow; }
            j = lastShow;
        }
        int firstSeen = -1, lastSeen = -1;
        for (int j = 0; j < nb; ++j) if (seen[static_cast<size_t>(j)]) { if (firstSeen < 0) firstSeen = j; lastSeen = j; }
        const int B = std::max(1, static_cast<int>(std::lround(p.block / f.pixel)));
        if (bestA < 0) { bestA = 0; bestB = nb - 1; }
        lf.i0 = bestA * B;
        lf.i1 = std::min(L.length(), (bestB + 1) * B);
        lf.fullLength = firstSeen >= 0 && (bestB - bestA + 1) >= p.fullLength * (lastSeen - firstSeen + 1);
        // the run measured again over its own extent only
        std::vector<LineStat> own;
        for (int q = std::max(0, a - 1); q <= std::min(C - 1, b + 1); ++q) own.push_back(lineStat(L, q, base, p, exclude, lf.i0, lf.i1));
        int ownPeak = -1;
        for (int q = a; q <= b; ++q) {
            const auto& s = own[static_cast<size_t>(q - std::max(0, a - 1))];
            if (!std::isfinite(s.st.mean)) continue;
            if (ownPeak < 0 || s.st.mean > own[static_cast<size_t>(ownPeak - std::max(0, a - 1))].st.mean) ownPeak = q;
        }
        if (ownPeak < 0) ownPeak = peak;
        const auto& os = own[static_cast<size_t>(ownPeak - std::max(0, a - 1))];
        // the depth: the mean over the plateau (lines within 80 % of the peak), not the peak line alone, which the
        // largest of several noisy means would bias outward; its SE the plateau lines' mean SE (they are not independent)
        {
            double sd = 0, sse = 0; int m = 0;
            for (int q = a; q <= b; ++q) {
                const auto& s2 = own[static_cast<size_t>(q - std::max(0, a - 1))];
                if (std::isfinite(s2.st.mean) && s2.st.mean >= 0.8 * os.st.mean) { sd += s2.st.mean; sse += std::isfinite(s2.st.se) ? s2.st.se : 0; ++m; }
            }
            lf.depth = m ? sd / m : os.st.mean;
            lf.se = m ? sse / m : os.st.se;
        }
        lf.blocks = os.st.n;
        lf.agree = os.agree;
        for (int q = std::max(0, a - 1); q <= std::min(C - 1, b + 1); ++q) {
            const auto& s = own[static_cast<size_t>(q - std::max(0, a - 1))];
            lf.lines.push_back(q);
            const bool inRun = q >= a && q <= b;
            lf.profile.push_back(std::isfinite(s.st.mean) ? std::max(0.0, inRun ? s.st.mean : std::min(s.st.mean, 0.5 * lf.depth)) : 0.0);
            lf.profileSe.push_back(std::isfinite(s.st.se) ? s.st.se : 0.0);
            if (inRun && std::isfinite(s.st.se)) lf.maxSe = std::max(lf.maxSe, s.st.se);
        }
        const int runLines = b - a + 1;
        char buf[320];
        std::snprintf(buf, sizeof buf, "%.3f m out (+- %.3f m SE) from %d blocks, %.0f%% agreeing, %d lines", lf.depth, lf.se, lf.blocks, 100 * lf.agree, runLines);
        lf.why = buf;
        if (!(lf.depth >= p.minDepth)) lf.why += "; below the least depth";
        else if (!(lf.depth >= p.k * lf.se)) lf.why += "; not significant (under k SE)";
        else if (lf.blocks < p.minBlocks) lf.why += "; too few blocks";
        else if (lf.agree < p.consistency) lf.why += "; not consistent along its length";
        else if (runLines < 2) lf.why += "; a single line";
        else if (along == 1 && (lf.l1 - lf.l0 + 1) > p.maxVerticalShare * f.W) lf.why += "; wider than half the face (the wall itself, not an element on it)";
        else lf.accepted = true;
        out.push_back(std::move(lf));
    }
    return out;
}

/** An opening in a face's ortho, pixel coordinates (x right, y down), and its group. */
struct Opening { int group{0}; double x0{0}, y0{0}, x1{0}, y1{0}; };

/** One averaged projection profile beside an opening (cross coordinate in metres from the opening's edge, outward). */
struct UnitProfile {
    bool proposed{false}, accepted{false};
    std::string why;
    double depth{0}, se{0};
    int n{0};
    /** Profile samples: cross coordinate (metres; 0 at the opening's edge, positive away from it) and depth. */
    std::vector<double> cross, offset, offsetSe;
    /** Extent along the edge, metres relative to the opening's start edge (a0) and end edge (a1). */
    double a0{0}, a1{0};
};

struct UnitResult {
    int group{0};
    std::vector<int> members;
    std::vector<std::pair<int, int>> shifts;
    double nccGain{0};
    double widthM{0}, heightM{0};
    int pw{0}, ph{0}, mx{0}, my{0};
    /** The averaged patch (NaN where fewer than minOpenings), its SE, and the count per texel. */
    std::vector<float> mean, se;
    std::vector<uint16_t> count;
    /** The reveal: how deep the opening's core sits behind the wall's line (positive = recessed). */
    UnitProfile reveal;
    /** Projections below, above, left and right of the opening. */
    UnitProfile below, above, left, right;
};

/** Gate for a scalar averaged over openings. */
inline void gateScalar(UnitProfile& u, const RobustStat& s, const Params& p, const char* what) {
    u.proposed = s.n > 0;
    u.depth = s.mean; u.se = s.se; u.n = s.n;
    char buf[256];
    std::snprintf(buf, sizeof buf, "%s %.3f m (+- %.3f m SE) over %d openings", what, s.mean, s.se, s.n);
    u.why = buf;
    if (!std::isfinite(s.mean) || s.n < p.minOpenings) u.why += "; too few openings";
    else if (!(s.mean >= p.minDepth)) u.why += "; below the least depth";
    else if (!(s.mean >= p.k * s.se)) u.why += "; not significant (under k SE)";
    else u.accepted = true;
}

inline UnitResult averageUnit(const Field& f, double base, const std::vector<Opening>& all, const std::vector<int>& members, const Params& p) {
    UnitResult u;
    if (members.empty()) return u;
    std::vector<double> ws, hs;
    for (int m : members) { ws.push_back(all[static_cast<size_t>(m)].x1 - all[static_cast<size_t>(m)].x0); hs.push_back(all[static_cast<size_t>(m)].y1 - all[static_cast<size_t>(m)].y0); }
    const double Wg = medianOf(ws), Hg = medianOf(hs);
    const int mx = std::max(2, static_cast<int>(std::lround(p.margin / f.pixel))), my = mx;
    const int W = std::max(2, static_cast<int>(std::lround(Wg))), H = std::max(2, static_cast<int>(std::lround(Hg)));
    const int PW = W + 2 * mx, PH = H + 2 * my;
    u.members = members; u.mx = mx; u.my = my; u.pw = PW; u.ph = PH;
    u.widthM = Wg * f.pixel; u.heightM = Hg * f.pixel;
    const int S = std::max(0, static_cast<int>(std::lround(p.shift / f.pixel)));
    // the piecewise map: the opening scaled to the group's size, the margins unscaled
    auto mapAxis = [](double c, int M, int Wn, double a0, double a1) {
        if (c < M) return a0 - (M - c);
        if (c < M + Wn) return a0 + (c - M) * (a1 - a0) / Wn;
        return a1 + (c - M - Wn);
    };
    auto sample = [&](const Opening& o, int dx, int dy, std::vector<float>& out) {
        out.assign(static_cast<size_t>(PW) * PH, std::numeric_limits<float>::quiet_NaN());
        for (int v = 0; v < PH; ++v) {
            double y = mapAxis(v + 0.5, my, H, o.y0, o.y1) + dy;
            for (int c = 0; c < PW; ++c) {
                double x = mapAxis(c + 0.5, mx, W, o.x0, o.x1) + dx;
                double h = f.at(static_cast<int>(std::floor(x)), static_cast<int>(std::floor(y)));
                if (std::isfinite(h)) out[static_cast<size_t>(v) * PW + c] = static_cast<float>(h - base);
            }
        }
    };
    const size_t K = members.size(), N = static_cast<size_t>(PW) * PH;
    std::vector<std::vector<float>> patch(K);
    for (size_t i = 0; i < K; ++i) sample(all[static_cast<size_t>(members[i])], 0, 0, patch[i]);
    auto ncc = [&](const std::vector<float>& a, const std::vector<float>& b) {
        double sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0; int n = 0;
        for (size_t i = 0; i < N; ++i) if (std::isfinite(a[i]) && std::isfinite(b[i])) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; ++n; }
        if (n < 16) return -2.0;
        double ma = sa / n, mb = sb / n, va = saa / n - ma * ma, vb = sbb / n - mb * mb;
        if (va <= 1e-12 || vb <= 1e-12) return -2.0;
        return (sab / n - ma * mb) / std::sqrt(va * vb);
    };
    // co-registration: each opening shifted (within S texels) onto the median of the others
    u.shifts.assign(K, {0, 0});
    double gain = 0;
    if (K >= 3 && S > 0) {
        std::vector<std::vector<float>> shifted(K);
        for (size_t i = 0; i < K; ++i) {
            std::vector<float> ref(N, std::numeric_limits<float>::quiet_NaN());
            std::vector<double> col;
            for (size_t t = 0; t < N; ++t) {
                col.clear();
                for (size_t j = 0; j < K; ++j) if (j != i && std::isfinite(patch[j][t])) col.push_back(patch[j][t]);
                if (col.size() >= 2) ref[t] = static_cast<float>(medianOf(col));
            }
            const double c0 = ncc(patch[i], ref);
            double best = c0; int bx = 0, by = 0;
            std::vector<float> trial;
            for (int dy = -S; dy <= S; ++dy) for (int dx = -S; dx <= S; ++dx) {
                if (!dx && !dy) continue;
                sample(all[static_cast<size_t>(members[i])], dx, dy, trial);
                double c = ncc(trial, ref);
                if (c > best + 0.02) { best = c; bx = dx; by = dy; }
            }
            u.shifts[i] = {bx, by};
            if (bx || by) sample(all[static_cast<size_t>(members[i])], bx, by, shifted[i]); else shifted[i] = patch[i];
            if (c0 > -1.5) gain += best - c0;
        }
        patch.swap(shifted);
        u.nccGain = gain / K;
    }
    // per texel: trimmed mean over openings
    u.mean.assign(N, std::numeric_limits<float>::quiet_NaN());
    u.se.assign(N, std::numeric_limits<float>::quiet_NaN());
    u.count.assign(N, 0);
    std::vector<double> col;
    for (size_t t = 0; t < N; ++t) {
        col.clear();
        for (size_t i = 0; i < K; ++i) if (std::isfinite(patch[i][t])) col.push_back(patch[i][t]);
        u.count[t] = static_cast<uint16_t>(col.size());
        if (static_cast<int>(col.size()) < p.minOpenings) continue;
        RobustStat s = trimmed(col, p.trim);
        u.mean[t] = static_cast<float>(s.mean);
        u.se[t] = static_cast<float>(s.se);
    }
    auto perOpening = [&](int c0, int c1, int v0, int v1) {
        std::vector<double> out;
        for (size_t i = 0; i < K; ++i) {
            std::vector<double> v;
            for (int y = std::max(0, v0); y < std::min(PH, v1); ++y) for (int x = std::max(0, c0); x < std::min(PW, c1); ++x) { float h = patch[i][static_cast<size_t>(y) * PW + x]; if (std::isfinite(h)) v.push_back(h); }
            if (v.size() >= 6) out.push_back(medianOf(v));
        }
        return out;
    };
    // the reveal: the core (the middle 60 % of the opening each way), recessed = positive
    {
        auto v = perOpening(mx + static_cast<int>(0.2 * W), mx + static_cast<int>(std::ceil(0.8 * W)), my + static_cast<int>(0.2 * H), my + static_cast<int>(std::ceil(0.8 * H)));
        for (double& x : v) x = -x;
        gateScalar(u.reveal, trimmed(v, p.trim), p, "the core sits");
    }
    // a projection profile beside an edge: per cross line (rows below/above, columns left/right) the per-opening median
    // over the opening's span; contiguous significant lines from the edge outward; its extent along the edge from the
    // averaged patch over those lines
    auto side = [&](UnitProfile& out, int dir) {
        // dir 0 below (rows my+H .. PH), 1 above (rows my-1 .. 0), 2 left (cols mx-1 .. 0), 3 right (cols mx+W .. PW)
        const bool rows = dir < 2;
        const int count = rows ? my : mx;
        std::vector<RobustStat> lines;
        for (int q = 0; q < count; ++q) {
            int line = dir == 0 ? my + H + q : dir == 1 ? my - 1 - q : dir == 2 ? mx - 1 - q : mx + W + q;
            auto v = rows ? perOpening(mx, mx + W, line, line + 1) : perOpening(line, line + 1, my, my + H);
            lines.push_back(trimmed(v, p.trim));
        }
        // the run from the edge (it may start up to 3 lines out: a reveal frame)
        int start = -1;
        for (int q = 0; q < std::min(count, 4) && start < 0; ++q) if (lines[static_cast<size_t>(q)].n >= p.minOpenings && lines[static_cast<size_t>(q)].mean >= 0.5 * p.minDepth) start = q;
        out.proposed = start >= 0;
        if (start < 0) { out.why = "nothing stands out beside the opening"; return; }
        int end = start;
        while (end + 1 < count && lines[static_cast<size_t>(end + 1)].n >= p.minOpenings && lines[static_cast<size_t>(end + 1)].mean >= 0.5 * p.minDepth) ++end;
        int peak = start;
        for (int q = start; q <= end; ++q) if (lines[static_cast<size_t>(q)].mean > lines[static_cast<size_t>(peak)].mean) peak = q;
        const auto& ps = lines[static_cast<size_t>(peak)];
        const char* names[4] = {"below it", "above it", "left of it", "right of it"};
        std::string what = std::string("the projection ") + names[dir] + " stands";
        gateScalar(out, ps, p, what.c_str());
        char buf[96];
        std::snprintf(buf, sizeof buf, ", %d lines deep", end - start + 1);
        out.why += buf;
        if (end - start + 1 < 2 && out.accepted) { out.accepted = false; out.why += "; a single line"; }
        // the profile (cross from the edge, metres), one zero line beyond each end
        for (int q = std::max(0, start - 1); q <= std::min(count - 1, end + 1); ++q) {
            const auto& s = lines[static_cast<size_t>(q)];
            const bool in = q >= start && q <= end;
            out.cross.push_back((q + 0.5) * f.pixel);
            out.offset.push_back(in && std::isfinite(s.mean) ? std::max(0.0, s.mean) : 0.0);
            out.offsetSe.push_back(std::isfinite(s.se) ? s.se : 0.0);
        }
        // the extent along the edge: on the averaged patch, across the run's lines, positions standing at least half the
        // peak out (longest contiguous run through the opening's middle)
        const int along = rows ? PW : PH;
        // per position along the edge: the median over the run's lines and a 0.25 m window along it (one averaged texel is
        // still noisy)
        const int hw = std::max(1, static_cast<int>(std::lround(0.125 / f.pixel)));
        std::vector<int> ok(static_cast<size_t>(along), 0);
        for (int a = 0; a < along; ++a) {
            std::vector<double> v;
            for (int q = start; q <= end; ++q) for (int da = -hw; da <= hw; ++da) {
                const int aa = a + da;
                if (aa < 0 || aa >= along) continue;
                int line = dir == 0 ? my + H + q : dir == 1 ? my - 1 - q : dir == 2 ? mx - 1 - q : mx + W + q;
                size_t idx = rows ? static_cast<size_t>(line) * PW + aa : static_cast<size_t>(aa) * PW + line;
                if (std::isfinite(u.mean[idx])) v.push_back(u.mean[idx]);
            }
            double m = medianOf(v);
            ok[static_cast<size_t>(a)] = std::isfinite(m) && m >= 0.5 * ps.mean;
        }
        const int mid = rows ? mx + W / 2 : my + H / 2;
        int a0 = mid, a1 = mid;
        if (!ok[static_cast<size_t>(mid)]) { out.a0 = 0; out.a1 = 0; if (out.accepted) { out.accepted = false; out.why += "; not continuous across the opening"; } return; }
        while (a0 - 1 >= 0 && ok[static_cast<size_t>(a0 - 1)]) --a0;
        while (a1 + 1 < along && ok[static_cast<size_t>(a1 + 1)]) ++a1;
        // relative to the start edge (x0 for rows; for columns, the top edge in pixels is y0: t1) and the end edge
        const int M = rows ? mx : my, Wn = rows ? W : H;
        out.a0 = (a0 - M) * f.pixel;               // metres from the start edge (negative: beyond it)
        out.a1 = (a1 + 1 - (M + Wn)) * f.pixel;    // metres from the end edge (positive: beyond it)
    };
    side(u.below, 0); side(u.above, 1); side(u.left, 2); side(u.right, 3);
    return u;
}

/** Groups of openings of similar size (width and height within `tol` of the group's first member), in reading order. */
inline std::vector<std::vector<int>> sizeGroups(const std::vector<Opening>& o, double tol = 0.15) {
    std::vector<std::vector<int>> groups;
    std::vector<int> order(o.size());
    for (size_t i = 0; i < o.size(); ++i) order[i] = static_cast<int>(i);
    std::sort(order.begin(), order.end(), [&](int a, int b) { return (o[static_cast<size_t>(a)].x1 - o[static_cast<size_t>(a)].x0) * (o[static_cast<size_t>(a)].y1 - o[static_cast<size_t>(a)].y0) > (o[static_cast<size_t>(b)].x1 - o[static_cast<size_t>(b)].x0) * (o[static_cast<size_t>(b)].y1 - o[static_cast<size_t>(b)].y0); });
    std::vector<int> used(o.size(), 0);
    for (int i : order) {
        if (used[static_cast<size_t>(i)]) continue;
        const auto& a = o[static_cast<size_t>(i)];
        const double wa = a.x1 - a.x0, ha = a.y1 - a.y0;
        std::vector<int> g;
        for (int j : order) {
            if (used[static_cast<size_t>(j)]) continue;
            const auto& b = o[static_cast<size_t>(j)];
            if (b.group != a.group) continue;
            if (std::abs((b.x1 - b.x0) - wa) <= tol * wa && std::abs((b.y1 - b.y0) - ha) <= tol * ha) { g.push_back(j); used[static_cast<size_t>(j)] = 1; }
        }
        groups.push_back(std::move(g));
    }
    return groups;
}

}  // namespace relief_average
}  // namespace scratchbox

#endif
