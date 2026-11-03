/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ORTHO_RECTIFY_HPP
#define SCRATCHBOX_ORTHO_RECTIFY_HPP

/**
 * Pipeline K's facade ortho straightening, native: a line-for-line translation of rectifyOrtho and everything it calls in
 * packages/core/src/node/3d-engine/staged-location/pipeline-k/ortho-rectify.ts (ORTHO_RECTIFY_VERSION 'ortho-rectify/2').
 * The method is documented there; this file only carries it over. Nothing here is a different algorithm.
 *
 * Parity with the TypeScript, bit for bit on the same input:
 *  - JS numbers are doubles, Float32Array slots are floats stored from a double computation (as Math.fround), Uint8Array
 *    and Int16Array stores keep their conversions (ToUint8: NaN to 0, modular; Int16 modular).
 *  - Math.round, Math.min / Math.max (NaN propagating), Math.sign, Math.log, Math.exp and Math.hypot are V8's, from
 *    scratchbox_js_math.hpp (log and exp its fdlibm ports, compiled as V8 is; the platform libm differs in the last bit for
 *    several percent of inputs). Everything else is compiled with contraction off: V8's generated code never fuses a
 *    multiply and an add.
 *  - Sorts with a comparator are stable (Array.prototype.sort is), reductions run in the TypeScript's order, and threads only
 *    split loops whose iterations are independent (rows, columns, pixels), so the thread count never changes a result.
 */

#pragma clang fp contract(off)

#include "scratchbox_js_math.hpp"

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <string>
#include <thread>
#include <vector>

namespace scratchbox::ortho_rectify {

/** ORTHO_RECTIFY_PARAMS, field for field (ortho-rectify.ts has what each one means). */
struct Params {
    double peakK = 1.0;
    double minLineGapM = 0.4;
    double maxShiftM = 0.35;
    double trackStepM = 0.25;
    double bendCost = 0.25;
    double minEdge = 0.35;
    double minSupport = 0.5, minSegmentM = 3;
    double segmentGapM = 4;
    bool traceVertical = true, traceHorizontal = true;
    double gridM = 0.75, wLine = 1, wSimilarity = 0.08, wAnchor = 0.001, wBorder = 1;
    double cgIterations = 600, cgTolerance = 1e-6;
    double minJacobian = 0.35;
    double minGain = 0.2;
    double fillRepeats = 4, minFillRepeats = 2, storeyMinM = 2.5, storeyMaxM = 7;
    double periodMinM = 1.2, periodMaxM = 10, minPeriodNcc = 0.35;
    double repeats = 3, minRepeats = 3;
    double repeatWindowM = 1.5, minRepeatNcc = 0.75, minSmearRepeats = 2, smearRepeats = 2, phaseSearchPx = 2;
    double smearRadiusYM = 2.5, smearRadiusXM = 0.6;
    double smearK = 3, smearMinLog = 0.12, smearMaxLog = 0.5877866649021191;
    double featureWindowM = 1, featurelessRatio = 0.3, featurelessMinM2 = 4, featurelessMinSideM = 1.5;
};

/** The parameter names in the order the CLI's request carries them as doubles (booleans as 0 / 1). */
inline const std::vector<const char*>& paramNames() {
    static const std::vector<const char*> names = {
        "peakK", "minLineGapM", "maxShiftM", "trackStepM", "bendCost", "minEdge", "minSupport", "minSegmentM", "segmentGapM",
        "traceVertical", "traceHorizontal", "gridM", "wLine", "wSimilarity", "wAnchor", "wBorder", "cgIterations", "cgTolerance",
        "minJacobian", "minGain", "fillRepeats", "minFillRepeats", "storeyMinM", "storeyMaxM", "periodMinM", "periodMaxM",
        "minPeriodNcc", "repeats", "minRepeats", "repeatWindowM", "minRepeatNcc", "minSmearRepeats", "smearRepeats", "phaseSearchPx",
        "smearRadiusYM", "smearRadiusXM", "smearK", "smearMinLog", "smearMaxLog", "featureWindowM", "featurelessRatio",
        "featurelessMinM2", "featurelessMinSideM"};
    return names;
}

/** Params from doubles in paramNames() order. */
inline Params paramsFromDoubles(const double* v) {
    Params P;
    int k = 0;
    P.peakK = v[k++]; P.minLineGapM = v[k++]; P.maxShiftM = v[k++]; P.trackStepM = v[k++]; P.bendCost = v[k++]; P.minEdge = v[k++];
    P.minSupport = v[k++]; P.minSegmentM = v[k++]; P.segmentGapM = v[k++];
    P.traceVertical = v[k++] != 0; P.traceHorizontal = v[k++] != 0;
    P.gridM = v[k++]; P.wLine = v[k++]; P.wSimilarity = v[k++]; P.wAnchor = v[k++]; P.wBorder = v[k++];
    P.cgIterations = v[k++]; P.cgTolerance = v[k++]; P.minJacobian = v[k++]; P.minGain = v[k++];
    P.fillRepeats = v[k++]; P.minFillRepeats = v[k++]; P.storeyMinM = v[k++]; P.storeyMaxM = v[k++];
    P.periodMinM = v[k++]; P.periodMaxM = v[k++]; P.minPeriodNcc = v[k++]; P.repeats = v[k++]; P.minRepeats = v[k++];
    P.repeatWindowM = v[k++]; P.minRepeatNcc = v[k++]; P.minSmearRepeats = v[k++]; P.smearRepeats = v[k++]; P.phaseSearchPx = v[k++];
    P.smearRadiusYM = v[k++]; P.smearRadiusXM = v[k++]; P.smearK = v[k++]; P.smearMinLog = v[k++]; P.smearMaxLog = v[k++];
    P.featureWindowM = v[k++]; P.featurelessRatio = v[k++]; P.featurelessMinM2 = v[k++]; P.featurelessMinSideM = v[k++];
    return P;
}

// ---------------------------------------------------------------------------------------------------------------------
// JavaScript number semantics: scratchbox_js_math.hpp

using js::kNaN;
using js::kInf;
inline float f32(double x) { return static_cast<float>(x); }

/** The round(v, d) of ortho-rectify.ts: Math.round(v * 10 ** d) / 10 ** d, non-finite values as they are. */
inline double roundTo(double v, int d) {
    if (!std::isfinite(v)) return v;
    const double p = d == 0 ? 1 : d == 1 ? 10 : d == 2 ? 100 : d == 3 ? 1000 : d == 4 ? 10000 : std::pow(10.0, d);
    return js::round(v * p) / p;
}

/** A number as a JS template literal prints it (Number::toString for the magnitudes the reports hold). */
inline std::string jsNumberString(double v) {
    if (std::isnan(v)) return "NaN";
    if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    if (v == 0) return "0";
    char buf[512];
    const double a = std::fabs(v);
    auto r = (a >= 1e21 || a < 1e-6) ? std::to_chars(buf, buf + sizeof buf, v) : std::to_chars(buf, buf + sizeof buf, v, std::chars_format::fixed);
    return std::string(buf, r.ptr);
}

/** medianOf (pipeline-e/image-ops.ts): a sorted copy's middle, the mean of the two middles for an even count. */
inline double medianOf(std::vector<double> s) {
    if (s.empty()) return kNaN;
    std::sort(s.begin(), s.end());
    const size_t m = s.size() >> 1;
    return s.size() % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Threads

/** Worker threads for the independent loops (0: all cores). */
inline unsigned& threadCount() { static unsigned n = 0; return n; }

/** fn(begin, end) over [0, n) in contiguous chunks, one per thread; small loops run inline. */
inline void parallelFor(size_t n, const std::function<void(size_t, size_t)>& fn, size_t minChunk = 64) {
    unsigned t = threadCount() ? threadCount() : std::max(1u, std::thread::hardware_concurrency());
    if (t <= 1 || n < 2 * minChunk) { if (n) fn(0, n); return; }
    t = static_cast<unsigned>(std::min<size_t>(t, n / minChunk));
    std::vector<std::thread> pool;
    const size_t step = (n + t - 1) / t;
    for (unsigned k = 1; k < t; k++) {
        const size_t b = k * step, e = std::min(n, b + step);
        if (b < e) pool.emplace_back([&fn, b, e] { fn(b, e); });
    }
    fn(0, std::min(n, step));
    for (auto& th : pool) th.join();
}

// ---------------------------------------------------------------------------------------------------------------------
// Types

constexpr uint8_t UNCOVERED = 128;

struct Rgba { int width = 0, height = 0; std::vector<uint8_t> rgba; };

/** A traced line (TracedLine). */
struct TracedLine {
    char axis = 'v';
    int at = 0;
    std::vector<double> along, across, weight, straight;
    int segments = 0;
};

struct HoleFill {
    double uncovered = 0, fromRepeats = 0, fromStoreys = 0, fromNearest = 0;
    bool hasPeriodPx = false, hasStoreyPx = false, hasFeatureless = false, hasFeaturelessLeft = false;
    double periodPx = 0, storeyPx = 0, featureless = 0, featurelessLeft = 0;
};

struct Report {
    int width = 0, height = 0; double pixelM = 0;
    struct { double vertical = 0, horizontal = 0, segments = 0, samples = 0; } lines;
    struct { double before = 0, after = 0, gain = 0; } straightnessPx;
    bool hasHomogeneity = false; struct { double before = 0, after = 0; } homogeneity;
    bool hasPeriod = false; double periodM = 0, periodNcc = 0;
    struct { bool kept = false; std::string why; double maxShiftPx = 0, meanShiftPx = 0, foldScale = 1, cgIterations = 0; } warp;
    struct { bool applied = false; std::string why; double texels = 0, share = 0, meanAbsLog = 0; } smear;
    HoleFill holes;
    double ms = 0;
};

struct Result {
    Rgba image; Report report;
    std::vector<uint8_t> uncovered, featureless;
    bool hasOccluded = false; std::vector<uint8_t> occluded;
};

inline bool isUncovered(const std::vector<uint8_t>& rgba, size_t i) { return rgba[i * 4] == UNCOVERED && rgba[i * 4 + 1] == UNCOVERED && rgba[i * 4 + 2] == UNCOVERED; }

/** Covered mask and luma of an ortho. */
inline void planes(const Rgba& img, std::vector<uint8_t>& valid, std::vector<float>& L) {
    const size_t N = static_cast<size_t>(img.width) * img.height;
    valid.assign(N, 0); L.assign(N, 0.0f);
    parallelFor(N, [&](size_t b, size_t e) {
        for (size_t i = b; i < e; i++) {
            if (img.rgba[i * 4 + 3] == 0 || isUncovered(img.rgba, i)) continue;
            valid[i] = 1;
            L[i] = f32(0.299 * img.rgba[i * 4] + 0.587 * img.rgba[i * 4 + 1] + 0.114 * img.rgba[i * 4 + 2]);
        }
    }, 4096);
}

/** Signed central-difference gradients, zero where either neighbour is uncovered. */
inline void gradients(const std::vector<float>& L, const std::vector<uint8_t>& valid, int W, int H, std::vector<float>& gx, std::vector<float>& gy) {
    gx.assign(static_cast<size_t>(W) * H, 0.0f); gy.assign(static_cast<size_t>(W) * H, 0.0f);
    if (H < 3) return;
    parallelFor(static_cast<size_t>(H - 2), [&](size_t b, size_t e) {
        for (size_t yy = b; yy < e; yy++) {
            const int y = static_cast<int>(yy) + 1;
            for (int x = 1; x < W - 1; x++) {
                const size_t i = static_cast<size_t>(y) * W + x;
                if (valid[i - 1] && valid[i + 1]) gx[i] = f32(static_cast<double>(L[i + 1]) - L[i - 1]);
                if (valid[i - W] && valid[i + W]) gy[i] = f32(static_cast<double>(L[i + W]) - L[i - W]);
            }
        }
    }, 16);
}

/** Peaks of a profile above mean + k sd, at least sep apart (strongest first), sorted by position. */
inline std::vector<int> profilePeaks(const std::vector<double>& p, double k, double sep) {
    const int n = static_cast<int>(p.size());
    if (n < 3) return {};
    double sum = 0;
    for (double v : p) sum += v;
    const double m = sum / n;
    double ss = 0;
    for (double v : p) ss += (v - m) * (v - m);
    const double sd = std::sqrt(ss / n);
    std::vector<int> c;
    for (int i = 1; i < n - 1; i++) if (p[i] > m + k * sd && p[i] >= p[i - 1] && p[i] >= p[i + 1]) c.push_back(i);
    std::stable_sort(c.begin(), c.end(), [&](int a, int b) { return p[b] - p[a] < 0; });
    std::vector<int> keep;
    for (int i : c) {
        bool ok = true;
        for (int j : keep) if (!(std::fabs(static_cast<double>(j - i)) >= sep)) { ok = false; break; }
        if (ok) keep.push_back(i);
    }
    std::stable_sort(keep.begin(), keep.end());
    return keep;
}

/** Weighted median of values (weights > 0 only). */
inline double weightedMedian(const std::vector<double>& v, const std::vector<double>& w) {
    std::vector<int> idx;
    for (int i = 0; i < static_cast<int>(v.size()); i++) if (w[i] > 0) idx.push_back(i);
    std::stable_sort(idx.begin(), idx.end(), [&](int a, int b) { return v[a] - v[b] < 0; });
    if (idx.empty()) return kNaN;
    double total = 0;
    for (int i : idx) total += w[i];
    double acc = 0;
    for (int i : idx) { acc += w[i]; if (acc >= total / 2) return v[i]; }
    return v[idx.back()];
}

/** Traces the lines of one axis ('v': gradient across is gx, samples down the rows; 'h': the same transposed). */
inline std::vector<TracedLine> traceAxis(char axis, const std::vector<float>& g, int W, int H, double pixelM, const Params& P) {
    const int nAcross = axis == 'v' ? W : H, nAlong = axis == 'v' ? H : W;
    auto at = [&](int along, int across) -> size_t { return axis == 'v' ? static_cast<size_t>(along) * W + across : static_cast<size_t>(across) * W + along; };
    std::vector<double> profile(nAcross, 0.0);
    // per column of the profile its sum runs down `along` in order, as the TypeScript's nested loop does
    parallelFor(static_cast<size_t>(nAcross), [&](size_t b, size_t e) {
        for (size_t c = b; c < e; c++) { double acc = 0; for (int a = 0; a < nAlong; a++) acc += std::fabs(static_cast<double>(g[at(a, static_cast<int>(c))])); profile[c] = acc; }
    }, 16);
    const double sep = js::max(2, js::round(P.minLineGapM / pixelM));
    const int R = static_cast<int>(js::max(1, js::round(P.maxShiftM / pixelM))), S = static_cast<int>(js::max(1, js::round(P.trackStepM / pixelM)));
    const int nS = nAlong / S;
    const std::vector<int> peaks = profilePeaks(profile, P.peakK, sep);
    std::vector<TracedLine> found(peaks.size());
    std::vector<uint8_t> kept(peaks.size(), 0);
    parallelFor(peaks.size(), [&](size_t pb, size_t pe) {
        for (size_t pk = pb; pk < pe; pk++) {
            const int c0 = peaks[pk];
            if (c0 - R < 1 || c0 + R > nAcross - 2) continue;
            double signedSum = 0;
            for (int a = 0; a < nAlong; a++) signedSum += g[at(a, c0)];
            const double pol = signedSum >= 0 ? 1 : -1;
            const int nD = 2 * R + 1;
            std::vector<double> e(static_cast<size_t>(nS) * nD), best(nS);
            for (int s = 0; s < nS; s++) {
                double m = 0;
                for (int d = 0; d < nD; d++) {
                    double acc = 0;
                    for (int a = s * S; a < (s + 1) * S; a++) acc += pol * g[at(a, c0 - R + d)];
                    e[static_cast<size_t>(s) * nD + d] = acc / S;
                    if (acc / S > m) m = acc / S;
                }
                best[s] = m;
            }
            std::vector<double> pos;
            for (double v : best) if (v > 0) pos.push_back(v);
            const double norm = medianOf(pos);
            if (!(norm > 0)) continue;
            std::vector<double> cost(static_cast<size_t>(nS) * nD);
            std::vector<int16_t> back(static_cast<size_t>(nS) * nD, 0);
            for (int d = 0; d < nD; d++) cost[d] = -e[d] / norm;
            for (int s = 1; s < nS; s++) {
                for (int d = 0; d < nD; d++) {
                    double bc = kInf; int bd = 0;
                    for (int q = 0; q < nD; q++) { const double v = cost[static_cast<size_t>(s - 1) * nD + q] + P.bendCost * std::fabs(static_cast<double>(d - q)); if (v < bc) { bc = v; bd = q; } }
                    cost[static_cast<size_t>(s) * nD + d] = bc - e[static_cast<size_t>(s) * nD + d] / norm;
                    back[static_cast<size_t>(s) * nD + d] = js::toInt16(bd);
                }
            }
            std::vector<int16_t> path(nS, 0);
            int bd = 0;
            if (nS > 0) {
                for (int d = 1; d < nD; d++) if (cost[static_cast<size_t>(nS - 1) * nD + d] < cost[static_cast<size_t>(nS - 1) * nD + bd]) bd = d;
                for (int s = nS - 1; s >= 0; s--) { path[s] = js::toInt16(bd); if (s > 0) bd = back[static_cast<size_t>(s) * nD + bd]; }
            }
            TracedLine l;
            l.axis = axis; l.at = c0;
            std::vector<double> weight;
            for (int s = 0; s < nS; s++) {
                l.along.push_back((s + 0.5) * S - 0.5);
                const int d = path[s];
                const double rm = d > 0 ? e[static_cast<size_t>(s) * nD + d - 1] : kNaN, r0 = e[static_cast<size_t>(s) * nD + d], rp = d < nD - 1 ? e[static_cast<size_t>(s) * nD + d + 1] : kNaN, den = rm - 2 * r0 + rp;
                l.across.push_back(static_cast<double>(c0 - R + d) + (den < 0 ? js::max(-0.5, js::min(0.5, 0.5 * (rm - rp) / den)) : 0));
                const double r = e[static_cast<size_t>(s) * nD + path[s]] / norm;
                weight.push_back(r >= P.minEdge && path[s] > 0 && path[s] < nD - 1 ? js::min(1, r) : 0);
            }
            const int gapS = static_cast<int>(js::max(1, js::round(P.segmentGapM / (S * pixelM))));
            std::vector<double> straight(nS, kNaN);
            int segs = 0, s = 0;
            while (s < nS) {
                while (s < nS && weight[s] == 0) s++;
                if (s >= nS) break;
                int end = s, lost = 0;
                for (int k = s; k < nS; k++) { if (weight[k] > 0) { end = k; lost = 0; } else if (++lost > gapS) break; }
                int supported = 0;
                for (int k = s; k <= end; k++) if (weight[k] > 0) supported++;
                const int count = end - s + 1;
                if (supported >= P.minSupport * count && static_cast<double>(count * S) * pixelM >= P.minSegmentM) {
                    std::vector<double> v, w;
                    for (int k = s; k <= end; k++) { v.push_back(l.across[k]); w.push_back(weight[k]); }
                    const double med = weightedMedian(v, w);
                    for (int k = s; k <= end; k++) straight[k] = med;
                    segs++;
                }
                s = end + 1;
            }
            if (segs) {
                l.weight.resize(nS);
                for (int k = 0; k < nS; k++) l.weight[k] = std::isfinite(straight[k]) ? weight[k] : 0;
                l.straight = std::move(straight);
                l.segments = segs;
                found[pk] = std::move(l);
                kept[pk] = 1;
            }
        }
    }, 1);
    std::vector<TracedLine> lines;
    for (size_t pk = 0; pk < peaks.size(); pk++) if (kept[pk]) lines.push_back(std::move(found[pk]));
    return lines;
}

/** The lines of an ortho, traced. */
inline std::vector<TracedLine> traceLines(const Rgba& img, double pixelM, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L, gx, gy;
    planes(img, valid, L);
    gradients(L, valid, img.width, img.height, gx, gy);
    std::vector<TracedLine> out;
    if (P.traceVertical) { auto v = traceAxis('v', gx, img.width, img.height, pixelM, P); for (auto& l : v) out.push_back(std::move(l)); }
    if (P.traceHorizontal) { auto h = traceAxis('h', gy, img.width, img.height, pixelM, P); for (auto& l : h) out.push_back(std::move(l)); }
    return out;
}

/** Weighted mean distance of traced samples from their straight positions (px). */
inline double straightness(const std::vector<TracedLine>& lines) {
    double acc = 0, w = 0;
    for (const auto& l : lines) for (size_t k = 0; k < l.across.size(); k++) if (l.weight[k] > 0) { acc += l.weight[k] * std::fabs(l.across[k] - l.straight[k]); w += l.weight[k]; }
    return w > 0 ? acc / w : 0;
}

/** Sparse rows of a linear least-squares system: each row is sqrt(weight) * (sum c_k u_{i_k} - b). */
struct Rows {
    std::vector<int32_t> idx; std::vector<double> val; std::vector<int32_t> start{0}; std::vector<double> rhs;
    void add(std::initializer_list<int> cols, std::initializer_list<double> coefs, double b, double w) {
        const double s = std::sqrt(w);
        auto c = cols.begin();
        for (auto k = coefs.begin(); k != coefs.end(); ++k, ++c) if (*k != 0) { idx.push_back(*c); val.push_back(*k * s); }
        start.push_back(static_cast<int32_t>(idx.size()));
        rhs.push_back(b * s);
    }
};

/** Solves min |A u - b|^2 by Jacobi-preconditioned conjugate gradients on A^T A u = A^T b, from u0. */
inline std::vector<double> solveLeastSquares(const Rows& rows, int n, const std::vector<double>& u0, double iterations, double tol, int& itersOut) {
    const size_t nr = rows.rhs.size();
    const int32_t* idx = rows.idx.data(); const double* val = rows.val.data(); const int32_t* start = rows.start.data(); const double* rhs = rows.rhs.data();
    std::vector<double> tmp(nr);
    auto AtA = [&](const std::vector<double>& x, std::vector<double>& out) {
        parallelFor(nr, [&](size_t b, size_t e) {
            for (size_t r = b; r < e; r++) { double a = 0; for (int32_t k = start[r]; k < start[r + 1]; k++) a += val[k] * x[idx[k]]; tmp[r] = a; }
        }, 4096);
        std::fill(out.begin(), out.end(), 0.0);
        for (size_t r = 0; r < nr; r++) { const double t = tmp[r]; for (int32_t k = start[r]; k < start[r + 1]; k++) out[idx[k]] += val[k] * t; }
    };
    std::vector<double> diag(n, 0.0), b(n, 0.0);
    for (size_t r = 0; r < nr; r++) for (int32_t k = start[r]; k < start[r + 1]; k++) { diag[idx[k]] += val[k] * val[k]; b[idx[k]] += val[k] * rhs[r]; }
    std::vector<double> u(u0), r(n), z(n), p(n), Ap(n);
    AtA(u, Ap);
    for (int i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; p[i] = z[i]; }
    double rz = 0, bn = 0;
    for (int i = 0; i < n; i++) { rz += r[i] * z[i]; bn += r[i] * r[i]; }
    bn = std::sqrt(bn);
    if (!(bn != 0)) bn = 1;
    int it = 0;
    for (; it < iterations; it++) {
        AtA(p, Ap);
        double pAp = 0;
        for (int i = 0; i < n; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0)) break;
        const double alpha = rz / pAp;
        double rn = 0;
        for (int i = 0; i < n; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rn += r[i] * r[i]; }
        if (std::sqrt(rn) / bn < tol) { it++; break; }
        double rz2 = 0;
        for (int i = 0; i < n; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; rz2 += r[i] * z[i]; }
        const double beta = rz2 / rz;
        rz = rz2;
        for (int i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    itersOut = it;
    return u;
}

/** A warp: per vertex of a regular grid over the output (spacing G px), the source position it samples (px). */
struct MeshWarp { double G = 4; int nx = 0, ny = 0; std::vector<double> sx, sy; };

/** Bilinear weights of an output point (px) in the warp's grid: the four vertex indices and weights. */
inline void cellWeights(const MeshWarp& w, double x, double y, int vs[4], double ws[4]) {
    const double fx = js::min(w.nx - 1 - 1e-9, js::max(0, x / w.G)), fy = js::min(w.ny - 1 - 1e-9, js::max(0, y / w.G));
    const int i = static_cast<int>(std::floor(fx)), j = static_cast<int>(std::floor(fy));
    const double a = fx - i, b = fy - j;
    vs[0] = j * w.nx + i; vs[1] = j * w.nx + i + 1; vs[2] = (j + 1) * w.nx + i; vs[3] = (j + 1) * w.nx + i + 1;
    ws[0] = (1 - a) * (1 - b); ws[1] = a * (1 - b); ws[2] = (1 - a) * b; ws[3] = a * b;
}

/** The content-preserving warp that takes every traced sample onto its straight line (unknowns [sx0, sy0, sx1, ...]). */
inline MeshWarp solveWarp(const std::vector<TracedLine>& lines, int W, int H, double pixelM, const Params& P, int& iterations) {
    const double G = js::max(4, js::round(P.gridM / pixelM));
    const int nx = static_cast<int>(std::ceil((W - 1) / G)) + 1, ny = static_cast<int>(std::ceil((H - 1) / G)) + 1, nv = nx * ny;
    auto id = [&](int i, int j) { return j * nx + i; };
    auto X = [](int v) { return 2 * v; };
    auto Y = [](int v) { return 2 * v + 1; };
    Rows rows;
    MeshWarp shell; shell.G = G; shell.nx = nx; shell.ny = ny; shell.sx.assign(nv, 0.0); shell.sy.assign(nv, 0.0);
    for (const auto& l : lines) for (size_t k = 0; k < l.across.size(); k++) {
        if (!(l.weight[k] > 0)) continue;
        const double ox = l.axis == 'v' ? l.straight[k] : l.along[k], oy = l.axis == 'v' ? l.along[k] : l.straight[k];
        int vs[4]; double ws[4];
        cellWeights(shell, ox, oy, vs, ws);
        if (l.axis == 'v') rows.add({X(vs[0]), X(vs[1]), X(vs[2]), X(vs[3])}, {ws[0], ws[1], ws[2], ws[3]}, l.across[k], P.wLine * l.weight[k]);
        else rows.add({Y(vs[0]), Y(vs[1]), Y(vs[2]), Y(vs[3])}, {ws[0], ws[1], ws[2], ws[3]}, l.across[k], P.wLine * l.weight[k]);
    }
    struct Pt { double x, y; };
    auto tri = [&](int a, int b, int c, Pt pa, Pt pb, Pt pc) {
        const double ex = pc.x - pb.x, ey = pc.y - pb.y, e2 = ex * ex + ey * ey;
        const double dx = pa.x - pb.x, dy = pa.y - pb.y;
        const double mu = (dx * ex + dy * ey) / e2, nu = (dx * ey - dy * ex) / e2;
        rows.add({X(a), X(b), X(c), Y(c), Y(b)}, {1, -1 + mu, -mu, -nu, nu}, 0, P.wSimilarity);
        rows.add({Y(a), Y(b), Y(c), X(c), X(b)}, {1, -1 + mu, -mu, nu, -nu}, 0, P.wSimilarity);
    };
    auto pos = [&](int i, int j) -> Pt { return {js::min(W - 1, i * G), js::min(H - 1, j * G)}; };
    for (int j = 0; j + 1 < ny; j++) for (int i = 0; i + 1 < nx; i++) {
        const int v00 = id(i, j), v10 = id(i + 1, j), v01 = id(i, j + 1), v11 = id(i + 1, j + 1);
        const Pt p00 = pos(i, j), p10 = pos(i + 1, j), p01 = pos(i, j + 1), p11 = pos(i + 1, j + 1);
        tri(v00, v10, v01, p00, p10, p01);
        tri(v10, v11, v00, p10, p11, p00);
        tri(v11, v01, v10, p11, p01, p10);
        tri(v01, v00, v11, p01, p00, p11);
    }
    std::vector<double> u0(2 * static_cast<size_t>(nv), 0.0);
    for (int j = 0; j < ny; j++) for (int i = 0; i < nx; i++) {
        const int v = id(i, j);
        const Pt p = pos(i, j);
        u0[X(v)] = p.x; u0[Y(v)] = p.y;
        rows.add({X(v)}, {1}, p.x, P.wAnchor);
        rows.add({Y(v)}, {1}, p.y, P.wAnchor);
        if (i == 0 || i == nx - 1) rows.add({X(v)}, {1}, p.x, P.wBorder);
        if (j == 0 || j == ny - 1) rows.add({Y(v)}, {1}, p.y, P.wBorder);
    }
    const std::vector<double> u = solveLeastSquares(rows, 2 * nv, u0, P.cgIterations, P.cgTolerance, iterations);
    for (int v = 0; v < nv; v++) { shell.sx[v] = u[X(v)]; shell.sy[v] = u[Y(v)]; }
    return shell;
}

/** The largest scale s in (0, 1] of the warp's displacement under which no source triangle shrinks below minJacobian. */
inline double foldScale(const MeshWarp& w, int W, int H, double minJacobian) {
    auto ok = [&](double s) {
        auto px = [&](int v, int i) { return js::min(W - 1, i * w.G) + s * (w.sx[v] - js::min(W - 1, i * w.G)); };
        auto py = [&](int v, int j) { return js::min(H - 1, j * w.G) + s * (w.sy[v] - js::min(H - 1, j * w.G)); };
        for (int j = 0; j + 1 < w.ny; j++) for (int i = 0; i + 1 < w.nx; i++) {
            const int v[4] = {j * w.nx + i, j * w.nx + i + 1, (j + 1) * w.nx + i, (j + 1) * w.nx + i + 1};
            const int ci[4] = {i, i + 1, i, i + 1}, cj[4] = {j, j, j + 1, j + 1};
            double Px[4], Py[4], Ox[4], Oy[4];
            for (int k = 0; k < 4; k++) { Px[k] = px(v[k], ci[k]); Py[k] = py(v[k], cj[k]); Ox[k] = js::min(W - 1, ci[k] * w.G); Oy[k] = js::min(H - 1, cj[k] * w.G); }
            const int tris[2][3] = {{0, 1, 2}, {1, 3, 2}};
            for (const auto& t : tris) {
                const int a = t[0], b = t[1], c = t[2];
                const double ao = (Ox[b] - Ox[a]) * (Oy[c] - Oy[a]) - (Oy[b] - Oy[a]) * (Ox[c] - Ox[a]);
                if (ao > 0) {
                    const double ap = (Px[b] - Px[a]) * (Py[c] - Py[a]) - (Py[b] - Py[a]) * (Px[c] - Px[a]);
                    if (ap < minJacobian * ao) return false;
                }
            }
        }
        return true;
    };
    if (ok(1)) return 1;
    double lo = 0, hi = 1;
    for (int k = 0; k < 12; k++) { const double m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
    return lo;
}

/** Where output pixel (x, y) samples its source through the warp (px, clamped to the image). */
inline void warpSource(const MeshWarp& w, int W, int H, double scale, double x, double y, double& outX, double& outY) {
    int vs[4]; double ws[4];
    cellWeights(w, x, y, vs, ws);
    double sx = 0, sy = 0;
    for (int k = 0; k < 4; k++) {
        const int i = vs[k] % w.nx, j = vs[k] / w.nx;
        sx += ws[k] * (js::min(W - 1, i * w.G) + scale * (w.sx[vs[k]] - js::min(W - 1, i * w.G)));
        sy += ws[k] * (js::min(H - 1, j * w.G) + scale * (w.sy[vs[k]] - js::min(H - 1, j * w.G)));
    }
    outX = js::min(W - 1, js::max(0, sx)); outY = js::min(H - 1, js::max(0, sy));
}

/** A one-channel mask (W x H) carried through the same warp, by its nearest source pixel. */
inline std::vector<uint8_t> applyWarpMask(const std::vector<uint8_t>& mask, int W, int H, const MeshWarp& w, double scale) {
    std::vector<uint8_t> out(static_cast<size_t>(W) * H);
    parallelFor(static_cast<size_t>(H), [&](size_t b, size_t e) {
        for (size_t y = b; y < e; y++) for (int x = 0; x < W; x++) {
            double sx, sy;
            warpSource(w, W, H, scale, x, static_cast<double>(y), sx, sy);
            out[y * W + x] = mask[static_cast<size_t>(js::round(sy)) * W + static_cast<size_t>(js::round(sx))];
        }
    }, 8);
    return out;
}

/** The ortho resampled through the warp (bilinear; uncovered stays uncovered and is never blended in). */
inline Rgba applyWarp(const Rgba& img, const MeshWarp& w, double scale) {
    const int W = img.width, H = img.height;
    const auto& rgba = img.rgba;
    Rgba out; out.width = W; out.height = H; out.rgba.assign(rgba.size(), 0);
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    parallelFor(static_cast<size_t>(H), [&](size_t yb, size_t ye) {
        for (size_t y = yb; y < ye; y++) for (int x = 0; x < W; x++) {
            double sx, sy;
            warpSource(w, W, H, scale, x, static_cast<double>(y), sx, sy);
            const int x0 = static_cast<int>(std::floor(sx)), y0 = static_cast<int>(std::floor(sy)), x1 = std::min(W - 1, x0 + 1), y1 = std::min(H - 1, y0 + 1);
            const double a = sx - x0, b = sy - y0;
            const size_t o = (y * W + x) * 4;
            const size_t ci[4] = {static_cast<size_t>(y0) * W + x0, static_cast<size_t>(y0) * W + x1, static_cast<size_t>(y1) * W + x0, static_cast<size_t>(y1) * W + x1};
            const double cw[4] = {(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b};
            double wsum = 0, acc[4] = {0, 0, 0, 0};
            for (int k = 0; k < 4; k++) if (valid[ci[k]] && cw[k] > 0) { wsum += cw[k]; for (int c = 0; c < 4; c++) acc[c] += cw[k] * rgba[ci[k] * 4 + c]; }
            const size_t nearPx = static_cast<size_t>(js::round(sy)) * W + static_cast<size_t>(js::round(sx));
            if (!valid[nearPx] || wsum <= 0) { out.rgba[o] = out.rgba[o + 1] = out.rgba[o + 2] = UNCOVERED; out.rgba[o + 3] = rgba[nearPx * 4 + 3]; continue; }
            for (int c = 0; c < 4; c++) out.rgba[o + c] = js::toUint8(js::round(acc[c] / wsum));
            if (out.rgba[o] == UNCOVERED && out.rgba[o + 1] == UNCOVERED && out.rgba[o + 2] == UNCOVERED) out.rgba[o + 2] = UNCOVERED + 1;
        }
    }, 8);
    return out;
}

struct Period { bool found = false; double periodPx = 0, ncc = 0; };

/** The repeat (px) along an axis: the first strong peak of the autocorrelation of the luma profile along it. */
inline Period axisPeriod(const Rgba& img, double pixelM, char axis, double minM, double maxM, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    const int W0 = img.width, H0 = img.height;
    const int W = axis == 'x' ? W0 : H0, H = axis == 'x' ? H0 : W0;
    std::vector<double> prof(W, 0.0), cnt(W, 0.0);
    if (axis == 'x') {
        parallelFor(static_cast<size_t>(W0), [&](size_t b, size_t e) {
            for (size_t x = b; x < e; x++) { double s = 0, c = 0; for (int y = 0; y < H0; y++) { const size_t i = static_cast<size_t>(y) * W0 + x; if (valid[i]) { s += L[i]; c++; } } prof[x] = s; cnt[x] = c; }
        }, 16);
    } else {
        parallelFor(static_cast<size_t>(H0), [&](size_t b, size_t e) {
            for (size_t y = b; y < e; y++) { double s = 0, c = 0; for (int x = 0; x < W0; x++) { const size_t i = y * W0 + x; if (valid[i]) { s += L[i]; c++; } } prof[y] = s; cnt[y] = c; }
        }, 16);
    }
    for (int x = 0; x < W; x++) prof[x] = cnt[x] > 0.1 * H ? prof[x] / cnt[x] : kNaN;
    const int lo = static_cast<int>(js::max(2, js::round(minM / pixelM))), hi = static_cast<int>(js::min(std::floor(W / 2.0), js::round(maxM / pixelM)));
    auto nccAt = [&](int lag) {
        double n = 0, sa = 0, sb = 0, ab = 0, aa = 0, bb = 0;
        for (int x = 0; x + lag < W; x++) { const double a = prof[x], b = prof[x + lag]; if (std::isfinite(a) && std::isfinite(b)) { n++; sa += a; sb += b; ab += a * b; aa += a * a; bb += b * b; } }
        if (n < 8) return -1.0;
        const double va = aa - sa * sa / n, vb = bb - sb * sb / n;
        return va > 0 && vb > 0 ? (ab - sa * sb / n) / std::sqrt(va * vb) : -1.0;
    };
    std::vector<double> c;
    for (int lag = lo - 1; lag <= hi + 1; lag++) c.push_back(nccAt(lag));
    for (size_t k = 1; k + 1 < c.size(); k++) if (c[k] >= P.minPeriodNcc && c[k] >= c[k - 1] && c[k] >= c[k + 1]) {
        const int lag = lo - 1 + static_cast<int>(k);
        const double d = c[k - 1] - 2 * c[k] + c[k + 1];
        return {true, lag + (d < 0 ? 0.5 * (c[k - 1] - c[k + 1]) / d : 0), c[k]};
    }
    return {};
}

/** The horizontal repeat (px) of an ortho. */
inline Period horizontalPeriod(const Rgba& img, double pixelM, const Params& P) { return axisPeriod(img, pixelM, 'x', P.periodMinM, P.periodMaxM, P); }

/** Where an ortho's photo is featureless: 1 per texel of a large smooth region. */
inline std::vector<uint8_t> featurelessMask(const Rgba& img, double pixelM, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    const int W = img.width, H = img.height;
    const size_t N = static_cast<size_t>(W) * H;
    std::vector<float> e(N, 0.0f);
    std::vector<uint8_t> ev(N, 0);
    if (H >= 3) parallelFor(static_cast<size_t>(H - 2), [&](size_t b, size_t en) {
        for (size_t yy = b; yy < en; yy++) {
            const int y = static_cast<int>(yy) + 1;
            for (int x = 1; x < W - 1; x++) {
                const size_t i = static_cast<size_t>(y) * W + x;
                if (!valid[i]) continue;
                double s = 0, n = 0;
                for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) { const size_t j = static_cast<size_t>(static_cast<long>(i) + dy * W + dx); if (valid[j]) { s += L[j]; n++; } }
                e[i] = f32(std::fabs(L[i] - s / n)); ev[i] = 1;
            }
        }
    }, 16);
    const int r = static_cast<int>(js::max(1, js::round(P.featureWindowM / pixelM / 2)));
    const size_t W1 = static_cast<size_t>(W) + 1;
    std::vector<double> S(W1 * (H + 1), 0.0), C(W1 * (H + 1), 0.0);
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        const size_t k = (y + 1) * W1 + x + 1;
        S[k] = static_cast<double>(e[static_cast<size_t>(y) * W + x]) + S[k - 1] + S[k - W - 1] - S[k - W - 2];
        C[k] = static_cast<double>(ev[static_cast<size_t>(y) * W + x]) + C[k - 1] + C[k - W - 1] - C[k - W - 2];
    }
    auto box = [&](const std::vector<double>& A, int x0, int y0, int x1, int y1) { return A[y1 * W1 + x1] - A[y0 * W1 + x1] - A[y1 * W1 + x0] + A[y0 * W1 + x0]; };
    std::vector<float> local(N, std::numeric_limits<float>::quiet_NaN());
    parallelFor(static_cast<size_t>(H), [&](size_t b, size_t en) {
        for (size_t yy = b; yy < en; yy++) {
            const int y = static_cast<int>(yy);
            for (int x = 0; x < W; x++) {
                const size_t i = static_cast<size_t>(y) * W + x;
                if (!ev[i]) continue;
                const int x0 = std::max(0, x - r), y0 = std::max(0, y - r), x1 = std::min(W, x + r + 1), y1 = std::min(H, y + r + 1);
                const double n = box(C, x0, y0, x1, y1);
                if (n > 0) local[i] = f32(box(S, x0, y0, x1, y1) / n);
            }
        }
    }, 16);
    std::vector<double> all;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) { const size_t i = static_cast<size_t>(y) * W + x; if (ev[i] && (x + y) % 3 == 0 && !std::isnan(local[i])) all.push_back(local[i]); }
    std::vector<uint8_t> out(N, 0);
    if (all.empty()) return out;
    std::sort(all.begin(), all.end());
    const double thr = P.featurelessRatio * all[all.size() >> 1];
    std::vector<uint8_t> flat(N, 0);
    for (size_t i = 0; i < N; i++) if (local[i] < thr) flat[i] = 1;
    const double minPx = P.featurelessMinM2 / (pixelM * pixelM), side = P.featurelessMinSideM / pixelM;
    std::vector<uint8_t> seen(N, 0);
    std::vector<size_t> stack, comp;
    for (size_t i = 0; i < N; i++) {
        if (!flat[i] || seen[i]) continue;
        comp.clear(); stack.push_back(i); seen[i] = 1;
        int x0 = W, x1 = 0, y0 = H, y1 = 0;
        while (!stack.empty()) {
            const size_t j = stack.back(); stack.pop_back();
            const int x = static_cast<int>(j % W), y = static_cast<int>(j / W);
            comp.push_back(j); x0 = std::min(x0, x); x1 = std::max(x1, x); y0 = std::min(y0, y); y1 = std::max(y1, y);
            const long nb[4] = {x > 0 ? static_cast<long>(j) - 1 : -1, x < W - 1 ? static_cast<long>(j) + 1 : -1, static_cast<long>(j) - W, static_cast<long>(j) + W};
            for (long k : nb) if (k >= 0 && k < static_cast<long>(N) && flat[k] && !seen[k]) { seen[k] = 1; stack.push_back(static_cast<size_t>(k)); }
        }
        if (comp.size() >= minPx && x1 - x0 + 1 >= side && y1 - y0 + 1 >= side) for (size_t j : comp) out[j] = 1;
    }
    return out;
}

/**
 * The ortho's holes filled from real texels only: bay repeats, then storey repeats, then the nearest real texel. With
 * `nearest` false the holes the repeats leave stay grey, for pipeline K's later rungs (ortho-rectify.ts fillHoles).
 */
inline Rgba fillHoles(const Rgba& img, double pixelM, const Params& P, HoleFill& fill, const std::vector<uint8_t>* noNearest = nullptr, bool nearest = true) {
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    const int W = img.width, H = img.height;
    const size_t N = static_cast<size_t>(W) * H;
    Rgba out; out.width = W; out.height = H; out.rgba = img.rgba;
    std::vector<uint8_t> known(valid);
    fill = HoleFill{};
    for (size_t i = 0; i < N; i++) if (!valid[i] && img.rgba[i * 4 + 3]) fill.uncovered++;
    if (!fill.uncovered || fill.uncovered == static_cast<double>(N)) return out;
    auto write = [&](size_t i, size_t j) {
        for (int c = 0; c < 3; c++) out.rgba[i * 4 + c] = img.rgba[j * 4 + c];
        out.rgba[i * 4 + 3] = 255;
        if (out.rgba[i * 4] == 128 && out.rgba[i * 4 + 1] == 128 && out.rgba[i * 4 + 2] == 128) out.rgba[i * 4 + 2] = 129;
        known[i] = 1;
    };
    struct Cand { size_t j; float l; };
    auto pass = [&](double period, char axis) {
        double n = 0;
        std::vector<Cand> cand;
        for (size_t i = 0; i < N; i++) {
            if (known[i] || !img.rgba[i * 4 + 3]) continue;
            const int x = static_cast<int>(i % W), y = static_cast<int>(i / W);
            cand.clear();
            for (double k = -P.fillRepeats; k <= P.fillRepeats; k++) {
                if (k == 0) continue;
                const double xx = axis == 'x' ? js::round(x + k * period) : x, yy = axis == 'y' ? js::round(y + k * period) : y;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                const size_t j = static_cast<size_t>(yy) * W + static_cast<size_t>(xx);
                if (valid[j]) cand.push_back({j, L[j]});
            }
            if (cand.size() < P.minFillRepeats) continue;
            std::stable_sort(cand.begin(), cand.end(), [](const Cand& a, const Cand& b) { return static_cast<double>(a.l) - b.l < 0; });
            write(i, cand[cand.size() >> 1].j);
            n++;
        }
        return n;
    };
    const Period ph = horizontalPeriod(img, pixelM, P);
    if (ph.found) { fill.hasPeriodPx = true; fill.periodPx = js::round(ph.periodPx * 100) / 100; fill.fromRepeats = pass(ph.periodPx, 'x'); }
    const Period pv = axisPeriod(img, pixelM, 'y', P.storeyMinM, P.storeyMaxM, P);
    if (pv.found) { fill.hasStoreyPx = true; fill.storeyPx = js::round(pv.periodPx * 100) / 100; fill.fromStoreys = pass(pv.periodPx, 'y'); }
    if (!nearest) return out;
    std::vector<int64_t> src(N, -1), queue(N);
    size_t head = 0, tail = 0;
    for (size_t i = 0; i < N; i++) if (valid[i]) { src[i] = static_cast<int64_t>(i); queue[tail++] = static_cast<int64_t>(i); }
    while (head < tail) {
        const int64_t i = queue[head++];
        const int x = static_cast<int>(i % W);
        const int64_t nb[4] = {x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W};
        for (int64_t j : nb) {
            if (j < 0 || j >= static_cast<int64_t>(N) || src[j] >= 0) continue;
            src[j] = src[i]; queue[tail++] = j;
        }
    }
    for (size_t i = 0; i < N; i++) {
        if (known[i] || !img.rgba[i * 4 + 3] || src[i] < 0) continue;
        if (noNearest && (*noNearest)[i]) { fill.hasFeaturelessLeft = true; fill.featurelessLeft++; continue; }
        write(i, static_cast<size_t>(src[i])); fill.fromNearest++;
    }
    return out;
}

/** Lattice homogeneity: the median over covered pixels of the luma spread across a pixel and its horizontal repeats. */
inline double homogeneity(const Rgba& img, double periodPx, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    const int W = img.width, H = img.height, rows = (H + 1) / 2;
    // per sampled row its spreads, gathered in row order (the median does not depend on the order)
    std::vector<std::vector<double>> perRow(static_cast<size_t>(rows));
    parallelFor(static_cast<size_t>(rows), [&](size_t rb, size_t re) {
        std::vector<double> buf;
        for (size_t r = rb; r < re; r++) {
            const int y = static_cast<int>(2 * r);
            auto& sds = perRow[r];
            for (int x = 0; x < W; x += 2) {
                const size_t i = static_cast<size_t>(y) * W + x;
                if (!valid[i]) continue;
                buf.clear();
                for (double k = -P.repeats; k <= P.repeats; k++) {
                    if (k == 0) continue;
                    const double sx = x + k * periodPx, x0 = std::floor(sx), a = sx - x0;
                    if (x0 < 0 || x0 + 1 >= W) continue;
                    const size_t ii = static_cast<size_t>(y) * W + static_cast<size_t>(x0);
                    if (!valid[ii] || !valid[ii + 1]) continue;
                    buf.push_back((1 - a) * L[ii] + a * L[ii + 1]);
                }
                const double n = static_cast<double>(buf.size());
                if (n < P.minRepeats) continue;
                double m = L[i];
                for (double v : buf) m += v;
                m /= n + 1;
                double v = (L[i] - m) * (L[i] - m);
                for (double q : buf) v += (q - m) * (q - m);
                sds.push_back(std::sqrt(v / (n + 1)));
            }
        }
    }, 8);
    std::vector<double> sds;
    for (auto& r : perRow) sds.insert(sds.end(), r.begin(), r.end());
    return sds.empty() ? kNaN : medianOf(std::move(sds));
}

/**
 * The separable box sum of boxMean: the running sum along x (half-width rx), then along y (ry), each stored as a float. The
 * y pass sweeps rows with one accumulator per column, so every column's sum runs in the TypeScript's order.
 */
inline std::vector<float> boxSum(const std::vector<float>& a, int W, int H, int rx, int ry) {
    std::vector<float> h(a.size()), out(a.size());
    parallelFor(static_cast<size_t>(H), [&](size_t jb, size_t je) {
        for (size_t j = jb; j < je; j++) {
            const float* row = a.data() + j * W;
            float* o = h.data() + j * W;
            double acc = 0;
            for (int k = 0; k <= std::min(rx, W - 1); k++) acc += row[k];
            for (int k = 0; k < W; k++) {
                o[k] = f32(acc);
                if (k + rx + 1 < W) acc += row[k + rx + 1];
                if (k - rx >= 0) acc -= row[k - rx];
            }
        }
    }, 16);
    parallelFor(static_cast<size_t>(W), [&](size_t cb, size_t ce) {
        std::vector<double> acc(ce - cb, 0.0);
        for (int k = 0; k <= std::min(ry, H - 1); k++) { const float* row = h.data() + static_cast<size_t>(k) * W; for (size_t c = cb; c < ce; c++) acc[c - cb] += row[c]; }
        for (int k = 0; k < H; k++) {
            float* o = out.data() + static_cast<size_t>(k) * W;
            const float* add = k + ry + 1 < H ? h.data() + static_cast<size_t>(k + ry + 1) * W : nullptr;
            const float* sub = k - ry >= 0 ? h.data() + static_cast<size_t>(k - ry) * W : nullptr;
            for (size_t c = cb; c < ce; c++) {
                double& v = acc[c - cb];
                o[c] = f32(v);
                if (add) v += add[c];
                if (sub) v -= sub[c];
            }
        }
    }, 64);
    return out;
}

/** Separable box mean with different half-widths along x and y over the pixels `use` marks (NaN where none). */
inline std::vector<float> boxMean(const std::vector<float>& v, const std::vector<uint8_t>& use, int W, int H, int rx, int ry) {
    const size_t N = v.size();
    std::vector<float> val(N, 0.0f), wt(N, 0.0f);
    for (size_t i = 0; i < N; i++) if (use[i]) { val[i] = v[i]; wt[i] = 1; }
    const std::vector<float> sv = boxSum(val, W, H, rx, ry), sw = boxSum(wt, W, H, rx, ry);
    std::vector<float> out(N);
    for (size_t i = 0; i < N; i++) out[i] = sw[i] > 0.5f ? f32(static_cast<double>(sv[i]) / sw[i]) : std::numeric_limits<float>::quiet_NaN();
    return out;
}

/**
 * Local zero-mean NCC of the luma against itself shifted s pixels along x, over a box of half-widths (rx, ry). The five
 * box means share one weight sum (they mask the same pixels), each mean the float boxMean stores.
 */
inline std::vector<float> shiftedNcc(const std::vector<float>& L, const std::vector<uint8_t>& valid, int W, int H, int s, int rx, int ry) {
    const size_t N = static_cast<size_t>(W) * H;
    std::vector<float> wt(N, 0.0f), a(N, 0.0f), b(N, 0.0f), ab(N, 0.0f), aa(N, 0.0f), bb(N, 0.0f);
    parallelFor(N, [&](size_t ib, size_t ie) {
        for (size_t i = ib; i < ie; i++) {
            const long x = static_cast<long>(i % W), xs = x + s;
            if (xs < 0 || xs >= W || !valid[i] || !valid[i + s]) continue;
            wt[i] = 1;
            a[i] = L[i]; b[i] = L[i + s];
            ab[i] = f32(static_cast<double>(a[i]) * b[i]); aa[i] = f32(static_cast<double>(a[i]) * a[i]); bb[i] = f32(static_cast<double>(b[i]) * b[i]);
        }
    }, 4096);
    const auto sw = boxSum(wt, W, H, rx, ry), sa = boxSum(a, W, H, rx, ry), sb = boxSum(b, W, H, rx, ry), sab = boxSum(ab, W, H, rx, ry), saa = boxSum(aa, W, H, rx, ry), sbb = boxSum(bb, W, H, rx, ry);
    std::vector<float> out(N);
    parallelFor(N, [&](size_t ib, size_t ie) {
        for (size_t i = ib; i < ie; i++) {
            if (!(sw[i] > 0.5f)) { out[i] = std::numeric_limits<float>::quiet_NaN(); continue; }
            const double w = sw[i];
            const double ma = f32(sa[i] / w), mb = f32(sb[i] / w), mab = f32(sab[i] / w), maa = f32(saa[i] / w), mbb = f32(sbb[i] / w);
            const double va = maa - ma * ma, vb = mbb - mb * mb;
            out[i] = va > 4 && vb > 4 ? f32((mab - ma * mb) / std::sqrt(va * vb)) : std::numeric_limits<float>::quiet_NaN();
        }
    }, 4096);
    return out;
}

struct SmearResult { Rgba image; double texels = 0, covered = 0, meanAbsLog = 0; };

/** Smears levelled against the facade's horizontal repeats (bounded gain toward the matching repeats' median). */
inline SmearResult levelSmears(const Rgba& img, double periodPx, double pixelM, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L;
    planes(img, valid, L);
    const int W = img.width, H = img.height;
    const size_t N = static_cast<size_t>(W) * H;
    const int nrx = static_cast<int>(js::max(2, js::round(periodPx / 2))), nry = static_cast<int>(js::max(2, js::round(P.repeatWindowM / pixelM)));
    struct Shift { std::vector<int16_t> s; std::vector<float> ncc; };
    std::vector<Shift> shifts;
    for (double k = -P.smearRepeats; k <= P.smearRepeats; k++) {
        if (k == 0) continue;
        const double s0 = js::round(k * periodPx);
        Shift sh; sh.ncc.assign(N, std::numeric_limits<float>::quiet_NaN()); sh.s.assign(N, 0);
        for (double d = -P.phaseSearchPx; d <= P.phaseSearchPx; d++) {
            const auto ncc = shiftedNcc(L, valid, W, H, static_cast<int>(s0 + d), nrx, nry);
            const int16_t sv = js::toInt16(s0 + d);
            parallelFor(N, [&](size_t ib, size_t ie) {
                for (size_t i = ib; i < ie; i++) if (ncc[i] > sh.ncc[i] || (!(sh.ncc[i] >= -1) && ncc[i] >= -1)) { sh.ncc[i] = ncc[i]; sh.s[i] = sv; }
            }, 4096);
        }
        shifts.push_back(std::move(sh));
    }
    std::vector<float> ratio(N, 0.0f);
    std::vector<uint8_t> has(N, 0);
    double covered = 0;
    for (size_t i = 0; i < N; i++) if (valid[i]) covered++;
    parallelFor(N, [&](size_t ib, size_t ie) {
        std::vector<double> buf;
        for (size_t i = ib; i < ie; i++) {
            if (!valid[i]) continue;
            buf.clear();
            for (const auto& sh : shifts) {
                if (!(sh.ncc[i] >= P.minRepeatNcc)) continue;
                const long j = static_cast<long>(i) + sh.s[i];
                if (j >= 0 && j < static_cast<long>(N) && valid[j]) buf.push_back(L[j]);
            }
            if (buf.size() < P.minSmearRepeats) continue;
            ratio[i] = f32(js::log((L[i] + 8.0) / (medianOf(buf) + 8)));
            has[i] = 1;
        }
    }, 4096);
    const int rx = static_cast<int>(js::max(1, js::min(js::round(P.smearRadiusXM / pixelM), js::round(periodPx / 3)))), ry = static_cast<int>(js::max(1, js::round(P.smearRadiusYM / pixelM)));
    const auto low = boxMean(ratio, has, W, H, rx, ry);
    std::vector<double> vals;
    for (size_t i = 0; i < N; i += 3) if (has[i] && std::isfinite(low[i])) vals.push_back(low[i]);
    const double med = medianOf(vals);
    std::vector<double> dev(vals.size());
    for (size_t k = 0; k < vals.size(); k++) dev[k] = std::fabs(vals[k] - med);
    const double mad = medianOf(std::move(dev));
    const double sd = 1.4826 * (mad != 0 && !std::isnan(mad) ? mad : 1e-3);
    const double thr = js::max(P.smearMinLog, P.smearK * sd);
    SmearResult res;
    res.image.width = W; res.image.height = H; res.image.rgba = img.rgba;
    auto& out = res.image.rgba;
    double texels = 0, sumAbs = 0;
    for (size_t i = 0; i < N; i++) {
        if (!valid[i] || !std::isfinite(low[i])) continue;
        const double r = low[i] - med, a = std::fabs(r);
        if (a <= thr) continue;
        const double ramp = js::min(1, (a - thr) / (0.5 * thr));
        const double corr = js::sign(r) * js::min(P.smearMaxLog, ramp * a);
        const double gain = js::exp(-corr);
        for (int c = 0; c < 3; c++) out[i * 4 + c] = js::toUint8(js::max(0, js::min(255, js::round(img.rgba[i * 4 + c] * gain))));
        if (out[i * 4] == UNCOVERED && out[i * 4 + 1] == UNCOVERED && out[i * 4 + 2] == UNCOVERED) out[i * 4 + 2] = UNCOVERED + 1;
        texels++; sumAbs += std::fabs(corr);
    }
    res.texels = texels; res.covered = covered; res.meanAbsLog = texels ? sumAbs / texels : 0;
    return res;
}

/** The given lines traced again on another image, each sample searched about its straight position. */
inline std::vector<TracedLine> retrace(const Rgba& img, const std::vector<TracedLine>& lines, double pixelM, const Params& P) {
    std::vector<uint8_t> valid; std::vector<float> L, gx, gy;
    planes(img, valid, L);
    gradients(L, valid, img.width, img.height, gx, gy);
    const int W = img.width;
    const long N = static_cast<long>(img.width) * img.height;
    const int R = static_cast<int>(js::max(1, js::round(P.maxShiftM / pixelM))), S = static_cast<int>(js::max(1, js::round(P.trackStepM / pixelM)));
    std::vector<TracedLine> out(lines.size());
    parallelFor(lines.size(), [&](size_t lb, size_t le) {
        for (size_t li = lb; li < le; li++) {
            const TracedLine& l = lines[li];
            const std::vector<float>& g = l.axis == 'v' ? gx : gy;
            // an index outside the array reads undefined in the TypeScript: NaN
            auto gat = [&](double along, double across) -> double {
                const double idx = l.axis == 'v' ? along * W + across : across * W + along;
                return idx >= 0 && idx < N ? static_cast<double>(g[static_cast<size_t>(idx)]) : kNaN;
            };
            const int nAcross = l.axis == 'v' ? img.width : img.height;
            double signedSum = 0;
            for (size_t k = 0; k < l.along.size(); k++) if (l.weight[k] > 0) signedSum += gat(js::round(l.along[k]), js::round(l.across[k]));
            const double pol = signedSum >= 0 ? 1 : -1;
            TracedLine t = l;
            for (size_t k = 0; k < l.across.size(); k++) {
                if (!(l.weight[k] > 0)) { t.across[k] = kNaN; continue; }
                const double c0 = js::round(l.straight[k]);
                const double a0 = js::round(l.along[k] - (S - 1) / 2.0);
                double best = -kInf; int bd = 0;
                for (int d = -R; d <= R; d++) {
                    const double c = c0 + d;
                    if (c < 1 || c >= nAcross - 1) continue;
                    double acc = 0;
                    for (double a = a0; a < a0 + S; a++) acc += pol * gat(a, c);
                    if (acc > best + 1e-9 || (std::fabs(acc - best) <= 1e-9 && std::abs(d) < std::abs(bd))) { best = acc; bd = d; }
                }
                auto rr = [&](int d) { double acc = 0; for (double a = a0; a < a0 + S; a++) acc += pol * gat(a, c0 + d); return acc; };
                const double c = c0 + bd;
                if (c - 1 < 1 || c + 1 >= nAcross - 1) { t.across[k] = c; continue; }
                const double rm = rr(bd - 1), rp = rr(bd + 1), den = rm - 2 * best + rp;
                t.across[k] = c + (den < 0 ? js::max(-0.5, js::min(0.5, 0.5 * (rm - rp) / den)) : 0);
            }
            out[li] = std::move(t);
        }
    }, 1);
    return out;
}

/** One facade ortho straightened (verified) and its smears levelled; `occluded` is carried through a kept warp. */
inline Result rectifyOrtho(const Rgba& img, double pixelM, const Params& P, const std::vector<uint8_t>* occluded = nullptr) {
    const auto t0 = std::chrono::steady_clock::now();
    const int W = img.width, H = img.height;
    const size_t N = static_cast<size_t>(W) * H;
    const auto lines = traceLines(img, pixelM, P);
    const double before = straightness(lines);
    const Period period = horizontalPeriod(img, pixelM, P);
    Result res;
    Report& report = res.report;
    report.width = W; report.height = H; report.pixelM = pixelM;
    for (const auto& l : lines) {
        if (l.axis == 'v') report.lines.vertical++; else report.lines.horizontal++;
        report.lines.segments += l.segments;
        for (double w : l.weight) if (w > 0) report.lines.samples++;
    }
    report.straightnessPx = {roundTo(before, 3), roundTo(before, 3), 0};
    if (period.found) { report.hasPeriod = true; report.periodM = roundTo(period.periodPx * pixelM, 3); report.periodNcc = roundTo(period.ncc, 3); }
    res.hasOccluded = occluded != nullptr;
    if (occluded) res.occluded = *occluded;
    Rgba image = img;
    if (!report.lines.samples) report.warp.why = "no line of the ortho could be traced";
    else if (before < 0.25) report.warp.why = "the lines are already straight (" + jsNumberString(roundTo(before, 2)) + " px mean distance)";
    else {
        int iterations = 0;
        const MeshWarp warp = solveWarp(lines, W, H, pixelM, P, iterations);
        const double scale = foldScale(warp, W, H, P.minJacobian);
        Rgba warped = applyWarp(img, warp, scale);
        const double after = straightness(retrace(warped, lines, pixelM, P));
        const double gain = before > 0 ? 1 - after / before : 0;
        double maxShift = 0, sumShift = 0;
        for (size_t v = 0; v < warp.sx.size(); v++) {
            const int i = static_cast<int>(v % warp.nx), j = static_cast<int>(v / warp.nx);
            const double d = scale * js::hypot({warp.sx[v] - js::min(W - 1, i * warp.G), warp.sy[v] - js::min(H - 1, j * warp.G)});
            maxShift = js::max(maxShift, d); sumShift += d;
        }
        const double hBefore = period.found ? homogeneity(img, period.periodPx, P) : kNaN, hAfter = period.found ? homogeneity(warped, period.periodPx, P) : kNaN;
        if (period.found) { report.hasHomogeneity = true; report.homogeneity = {roundTo(hBefore, 3), roundTo(hAfter, 3)}; }
        report.straightnessPx = {roundTo(before, 3), roundTo(after, 3), roundTo(gain, 3)};
        report.warp.maxShiftPx = roundTo(maxShift, 2); report.warp.meanShiftPx = roundTo(sumShift / warp.sx.size(), 3); report.warp.foldScale = roundTo(scale, 3); report.warp.cgIterations = iterations;
        const bool regular = !period.found || !(hAfter > hBefore * 1.02);
        const std::string spread = "(spread " + jsNumberString(roundTo(hBefore, 2)) + " -> " + jsNumberString(roundTo(hAfter, 2)) + ")";
        if (gain >= P.minGain && regular) {
            image = std::move(warped);
            if (occluded) res.occluded = applyWarpMask(*occluded, W, H, warp, scale);
            report.warp.kept = true;
            report.warp.why = "lines " + jsNumberString(roundTo(before, 2)) + " -> " + jsNumberString(roundTo(after, 2)) + " px from straight (" + jsNumberString(js::round(gain * 100)) + "% straighter)" +
                (period.found ? ", lattice spread " + jsNumberString(roundTo(hBefore, 2)) + " -> " + jsNumberString(roundTo(hAfter, 2)) : "");
        } else {
            report.warp.why = gain < P.minGain ? "the warp straightened the lines by only " + jsNumberString(js::round(gain * 100)) + "% (at least " + jsNumberString(js::round(P.minGain * 100)) + "% needed)"
                                               : "the warp made the lattice less regular " + spread;
        }
    }
    if (!period.found) report.smear.why = "no horizontal repeat in the ortho to level smears against";
    else {
        SmearResult s = levelSmears(image, period.periodPx, pixelM, P);
        image = std::move(s.image);
        report.smear.applied = s.texels > 0;
        report.smear.why = s.texels ? jsNumberString(s.texels) + " texels levelled against their repeats at a " + jsNumberString(roundTo(period.periodPx * pixelM, 2)) + " m pitch" : "no smear stood out from the repeats";
        report.smear.texels = s.texels; report.smear.share = roundTo(s.covered ? s.texels / s.covered : 0, 4); report.smear.meanAbsLog = roundTo(s.meanAbsLog, 3);
    }
    res.uncovered.assign(N, 0);
    for (size_t k = 0; k < N; k++) if (image.rgba[k * 4 + 3] && isUncovered(image.rgba, k)) res.uncovered[k] = 1;
    HoleFill fill;
    // the repeats only: the holes they leave are filled once every facade is straightened (pipeline-k.ts), never from the nearest texel
    Rgba filled = fillHoles(image, pixelM, P, fill, nullptr, false);
    const auto flat = featurelessMask(image, pixelM, P);
    res.featureless.assign(N, 0);
    double featureless = 0;
    for (size_t k = 0; k < N; k++) if (flat[k] && !res.uncovered[k]) { res.featureless[k] = 1; featureless++; }
    fill.hasFeatureless = true; fill.featureless = featureless;
    res.image = std::move(filled);
    report.holes = fill;
    report.ms = static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count());
    return res;
}

} // namespace scratchbox::ortho_rectify

#endif // SCRATCHBOX_ORTHO_RECTIFY_HPP
