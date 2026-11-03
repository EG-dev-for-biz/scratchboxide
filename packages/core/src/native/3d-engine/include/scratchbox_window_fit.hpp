/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window fit (SB-Fenestra) of one straightened facade photo, natively: the same readings, gates and completion as
 * packages/core/src/node/3d-engine/staged-location/window-fit.ts fitFacadeWindows (whose comments say why each step is
 * there), with the photometric relief read in this process (photometric_relief::analyzeOrthophoto, as scripts/relief_band.cpp
 * reads it and prints it) instead of five relief_band processes per facade.
 *
 * Parity with the TypeScript: every comparison, rounding and order is JavaScript's (Math.round, Python's round where the
 * prototype used it, stable sorts, first-seen map order, the band report's key order), and floating point is evaluated
 * as JavaScript evaluates it: no fused multiply-add below the pragma, Math.hypot's normalised compensated sum. The relief's
 * input is built above the pragma, compiled as relief_band compiles it. What can still differ is the last bit of pow and
 * cbrt in the CIELAB of a texel (libm against V8's fdlibm), which changes a decision only on an exact tie.
 */

#pragma once

#include "scratchbox_photometric_relief.hpp"
#include "scratchbox_thread_pool.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace scratchbox {
namespace window_fit {

/** The relief's grid on one band, as relief_band prints it (pitches %g, runs %f) and JSON.parse reads it back. */
struct ReliefGrid {
    std::array<int, 4> band{};
    bool foundS = false, foundT = false;
    double pitchS = 0, pitchT = 0;
    bool cellFoundS = false, cellFoundT = false;
    std::vector<std::pair<double, double>> runsS, runsT;
};

/** One facade photo: rgba, and the texels not read (1: the photo never reached it, or something stood in front). */
struct FacadePhoto {
    int W = 0, H = 0;
    double pixel = 0, orthoSMin = 0, orthoTMax = 0, texel = 0;
    std::vector<uint8_t> rgba, unread;
};

namespace detail {

// relief_band's number formats read back as JSON.parse reads them
inline double asPrintedG(double v) {
    char b[64];
    std::snprintf(b, sizeof b, "%g", v);
    return std::strtod(b, nullptr);
}
inline double asPrintedF(double v) { return std::strtod(std::to_string(v).c_str(), nullptr); }

/**
 * The relief on bands of the photo, alternate stripes along the wall ('s') or bands up it ('t') of `span` pixels of
 * `parity` hidden ('-': none): scripts/relief_band.cpp, compiled under the same floating-point contraction.
 */
inline std::vector<ReliefGrid> relief(const FacadePhoto& ph, char hide, int span, int parity, const std::vector<std::array<int, 4>>& bands) {
    namespace pr = photometric_relief;
    pr::ReliefParams p;
    p.minPeriodsInSpan = 2;
    span = std::max(1, span);
    const auto hidden = [&](int x, int y) { return (hide == 's' && (x / span) % 2 == parity) || (hide == 't' && (y / span) % 2 == parity); };
    std::vector<ReliefGrid> out;
    out.reserve(bands.size());
    for (const auto& bd : bands) {
        const int x0 = bd[0], x1 = bd[1], y0 = bd[2], y1 = bd[3];
        pr::Orthophoto o;
        o.width = std::max(0, x1 - x0); o.height = std::max(0, y1 - y0); o.pixel = ph.pixel;
        o.sMin = ph.orthoSMin + x0 * ph.pixel; o.tMax = ph.orthoTMax - y0 * ph.pixel;
        const size_t N = static_cast<size_t>(o.width) * o.height;
        o.lum.assign(N, 0.f); o.rgb.assign(N * 3, 0); o.cov.assign(N, 0);
        for (int y = 0; y < o.height; ++y) for (int x = 0; x < o.width; ++x) {
            const int sx = x0 + x, sy = y0 + y;
            if (sx < 0 || sy < 0 || sx >= ph.W || sy >= ph.H || hidden(sx, sy)) continue;
            const size_t k = static_cast<size_t>(sy) * ph.W + sx, si = k * 4, di = static_cast<size_t>(y) * o.width + x;
            if (ph.rgba[si + 3] == 0) continue;
            if (ph.unread[k]) continue;
            const double r = ph.rgba[si] / 255.0, g = ph.rgba[si + 1] / 255.0, b = ph.rgba[si + 2] / 255.0;
            o.lum[di] = static_cast<float>(0.2126 * r + 0.7152 * g + 0.0722 * b);
            for (int c = 0; c < 3; ++c) o.rgb[di * 3 + c] = ph.rgba[si + c];
            o.cov[di] = 1;
        }
        const auto fa = pr::analyzeOrthophoto(o, ph.texel, p);
        ReliefGrid g;
        g.band = bd;
        g.foundS = fa.periodS.found; g.pitchS = asPrintedG(fa.periodS.pitch);
        g.foundT = fa.periodT.found; g.pitchT = asPrintedG(fa.periodT.pitch);
        g.cellFoundS = fa.cell.foundS; g.cellFoundT = fa.cell.foundT;
        for (const auto& r : fa.cell.runsS) g.runsS.emplace_back(asPrintedF(r.first), asPrintedF(r.second));
        for (const auto& r : fa.cell.runsT) g.runsT.emplace_back(asPrintedF(r.first), asPrintedF(r.second));
        out.push_back(std::move(g));
    }
    return out;
}

}  // namespace detail

// ---------------------------------------------------------------------------------------- JavaScript's arithmetic below
#if defined(__clang__)
#pragma clang fp contract(off)
#endif

/** WINDOW_FIT_PARAMS, in the order nativeParamVector (window-fit-native.ts) writes them. */
struct Params {
    double present, heldOutSpanM, runShare, minBandSM, minBandTM, splitGain, rowNcc, storeysMin, clearlyBetter, stripMargin, stripDarkShare;
    double heightBand0, heightBand1, storeySpread, shortStorey, latWindowM, rephaseWidth0, rephaseWidth1, mullion, pierMinShare, bayRange0, bayRange1;
    double subAc, subMajority, minScore, paneContrast, paneShare0, paneShare1;
    double cOverlap, cMinAxis, cMinValid, cClearShare;
    double nMaxWidthM, nMinColumnShare, nMinContrast, nRunShare0, nRunShare1, nMinStoreyNcc, nMinStoreys;
    double glassDeltaE, pitchS0, pitchS1, meanWindowM;
    static constexpr size_t kCount = 43;
    static Params from(const std::vector<double>& v) {
        Params p{};
        double* f = &p.present;
        for (size_t i = 0; i < kCount && i < v.size(); ++i) f[i] = v[i];
        return p;
    }
};
static_assert(sizeof(Params) == Params::kCount * sizeof(double), "Params is a flat list of doubles");

using Rect = std::array<int, 4>;
using Band = std::array<int, 4>;
using Span = std::pair<int, int>;

/** A band's report entry: its fields in the order the TypeScript adds them (JSON values as text). */
struct OrderedObject {
    std::vector<std::pair<std::string, std::string>> fields;
    void set(const std::string& k, std::string v) {
        for (auto& f : fields) if (f.first == k) { f.second = std::move(v); return; }
        fields.emplace_back(k, std::move(v));
    }
    void erase(const std::string& k) { fields.erase(std::remove_if(fields.begin(), fields.end(), [&](const auto& f) { return f.first == k; }), fields.end()); }
    const std::string* get(const std::string& k) const { for (const auto& f : fields) if (f.first == k) return &f.second; return nullptr; }
    std::string json() const {
        std::string s = "{";
        for (size_t i = 0; i < fields.size(); ++i) s += (i ? ",\"" : "\"") + fields[i].first + "\":" + fields[i].second;
        return s + "}";
    }
};

struct FitResult {
    std::vector<Rect> rects, panes, generated;
    std::vector<OrderedObject> bands;
};

namespace js {

inline double round(double x) { const double f = std::floor(x); return x - f >= 0.5 ? f + 1 : f; }
/** Python's round(): halves to even. */
inline double pyRound(double x) { const double f = std::floor(x), d = x - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : std::fmod(f, 2.0) == 0 ? f : f + 1; }
/** Math.hypot: the arguments over their largest, squared with a compensated sum, its root times the largest. */
inline double hypot(std::initializer_list<double> xs) {
    double mx = 0;
    bool nan = false;
    for (double v : xs) { if (std::isnan(v)) nan = true; else mx = std::max(mx, std::fabs(v)); }
    if (mx == std::numeric_limits<double>::infinity()) return mx;
    if (nan) return std::numeric_limits<double>::quiet_NaN();
    if (mx == 0) return 0;
    double sum = 0, comp = 0;
    for (double v : xs) {
        const double n = std::fabs(v) / mx, summand = n * n - comp, prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    return std::sqrt(sum) * mx;
}
/** A number as JavaScript's String(n) writes it. */
inline std::string str(double v) {
    if (std::isnan(v)) return "NaN";
    if (v == 0) return "0";
    if (std::isinf(v)) return v > 0 ? "Infinity" : "-Infinity";
    char buf[64];
    auto r = std::to_chars(buf, buf + sizeof buf, v, std::chars_format::scientific);
    std::string sci(buf, r.ptr);
    std::string sign;
    if (sci[0] == '-') { sign = "-"; sci.erase(0, 1); }
    const size_t e = sci.find('e');
    std::string digits;
    for (size_t i = 0; i < e; ++i) if (sci[i] != '.') digits += sci[i];
    const int exp10 = std::atoi(sci.c_str() + e + 1), k = static_cast<int>(digits.size()), n = exp10 + 1;
    if (k <= n && n <= 21) return sign + digits + std::string(n - k, '0');
    if (0 < n && n <= 21) return sign + digits.substr(0, n) + "." + digits.substr(n);
    if (-6 < n && n <= 0) return sign + "0." + std::string(-n, '0') + digits;
    return sign + digits.substr(0, 1) + (k > 1 ? "." + digits.substr(1) : "") + "e" + (n - 1 >= 0 ? "+" : "-") + std::to_string(std::abs(n - 1));
}
/** A double that JSON.parse reads back exactly. */
inline std::string num(double v) {
    if (!std::isfinite(v)) return "null";
    char b[64];
    std::snprintf(b, sizeof b, "%.17g", v);
    return b;
}
inline double round3(double v) { return js::round(v * 1000) / 1000; }

}  // namespace js

namespace detail {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
inline bool fin(double v) { return std::isfinite(v); }

/** numpy's linear-interpolated percentile over the finite values (NaN when none); nth_element gives the same order statistics a sort does. */
inline double percentile(std::vector<double> v, double q) {
    v.erase(std::remove_if(v.begin(), v.end(), [](double x) { return !std::isfinite(x); }), v.end());
    if (v.empty()) return kNaN;
    const double r = (q / 100) * (static_cast<double>(v.size()) - 1);
    const size_t lo = static_cast<size_t>(std::floor(r)), hi = static_cast<size_t>(std::ceil(r));
    std::nth_element(v.begin(), v.begin() + lo, v.end());
    const double a = v[lo];
    const double b = hi == lo ? a : *std::min_element(v.begin() + lo + 1, v.end());
    return a + (b - a) * (r - lo);
}
inline double median(const std::vector<double>& v) { return percentile(v, 50); }
template <class T>
inline double medianOf(const std::vector<T>& v) { return median(std::vector<double>(v.begin(), v.end())); }

inline double meanFinite(const double* a, size_t n) { double s = 0; size_t c = 0; for (size_t i = 0; i < n; ++i) if (std::isfinite(a[i])) { s += a[i]; c++; } return c ? s / c : kNaN; }
inline double meanFinite(const std::vector<double>& a) { return meanFinite(a.data(), a.size()); }
inline bool anyFinite(const std::vector<double>& a) { for (double v : a) if (std::isfinite(v)) return true; return false; }
inline double sumSeq(const std::vector<double>& a, size_t b, size_t e) { double s = 0; for (size_t i = b; i < e; ++i) s += a[i]; return s; }

inline double boxesIou(const Rect& a, const Rect& b) {
    const double ix = std::max(0, std::min(a[2], b[2]) - std::max(a[0], b[0])), iy = std::max(0, std::min(a[3], b[3]) - std::max(a[1], b[1])), i = ix * iy;
    const double u = static_cast<double>(a[2] - a[0]) * (a[3] - a[1]) + static_cast<double>(b[2] - b[0]) * (b[3] - b[1]) - i;
    return u != 0 ? i / u : 0;
}
inline bool rectLess(const Rect& a, const Rect& b) { return a[0] != b[0] ? a[0] < b[0] : a[1] != b[1] ? a[1] < b[1] : a[2] != b[2] ? a[2] < b[2] : a[3] < b[3]; }
inline void sortRects(std::vector<Rect>& r) { std::stable_sort(r.begin(), r.end(), rectLess); }

inline double ncc(const std::vector<double>& a, const std::vector<double>& b) {
    double sa = 0, sb = 0;
    for (double x : a) sa += x;
    for (double x : b) sb += x;
    const double ma = sa / a.size(), mb = sb / b.size();
    double ab = 0, aa = 0, bb = 0;
    for (size_t i = 0; i < a.size(); ++i) { const double x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    const double d = std::sqrt(aa * bb);
    return d > 0 ? ab / d : 0;
}

/** The photo's darkness: 1 - luminance / (1.15 x its local mean over about 4 m), clipped to [0, 1]; NaN off the photo. */
struct Darkness {
    int W = 0, H = 0;
    std::vector<double> D;
    double at(int x, int y) const { return D[static_cast<size_t>(y) * W + x]; }
    std::vector<double> colMeans(int x0, int x1, int y0, int y1) const {
        std::vector<double> out(std::max(0, x1 - x0));
        for (int x = x0; x < x1; ++x) { double s = 0; int n = 0; for (int y = y0; y < y1; ++y) { const double v = D[static_cast<size_t>(y) * W + x]; if (v == v) { s += v; n++; } } out[x - x0] = n ? s / n : kNaN; }
        return out;
    }
    std::vector<double> rowMeans(int x0, int x1, int y0, int y1) const {
        std::vector<double> out(std::max(0, y1 - y0));
        for (int y = y0; y < y1; ++y) { double s = 0; int n = 0; const double* row = D.data() + static_cast<size_t>(y) * W; for (int x = x0; x < x1; ++x) { const double v = row[x]; if (v == v) { s += v; n++; } } out[y - y0] = n ? s / n : kNaN; }
        return out;
    }
    double boxMean(int x0, int x1, int y0, int y1, const Rect* hole = nullptr) const {
        double s = 0; int n = 0;
        for (int y = std::max(0, y0); y < std::min(H, y1); ++y) for (int x = std::max(0, x0); x < std::min(W, x1); ++x) {
            if (hole && x >= (*hole)[0] && x < (*hole)[1] && y >= (*hole)[2] && y < (*hole)[3]) continue;
            const double v = D[static_cast<size_t>(y) * W + x]; if (v == v) { s += v; n++; }
        }
        return n ? s / n : kNaN;
    }
    /** As the TypeScript reads it: past the array an index is undefined, which counts as finite there. */
    double finiteShare(int x0, int x1, int y0, int y1) const {
        long n = 0, all = 0;
        const long N = static_cast<long>(D.size());
        for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) { all++; const long k = static_cast<long>(y) * W + x; if (k < 0 || k >= N || D[k] == D[k]) n++; }
        return all ? static_cast<double>(n) / all : 0;
    }
};

inline void darknessOf(const FacadePhoto& ph, Darkness& dk, std::vector<uint8_t>& valid) {
    const int W = ph.W, H = ph.H;
    const size_t N = static_cast<size_t>(W) * H;
    valid.assign(N, 0);
    std::vector<double> lum(N);
    for (size_t k = 0; k < N; ++k) {
        valid[k] = ph.rgba[k * 4 + 3] > 0 && !ph.unread[k] ? 1 : 0;
        lum[k] = 0.2126 * ph.rgba[k * 4] + 0.7152 * ph.rgba[k * 4 + 1] + 0.0722 * ph.rgba[k * 4 + 2];
    }
    const int n = std::max(3, static_cast<int>(std::trunc(4.0 / ph.pixel))) | 1, h = n >> 1;
    const size_t W1 = W + 1;
    std::vector<double> cl(W1 * (H + 1), 0.0), cv(W1 * (H + 1), 0.0);
    for (int y = 0; y < H; ++y) {
        double rl = 0, rv = 0;
        for (int x = 0; x < W; ++x) {
            const size_t k = static_cast<size_t>(y) * W + x;
            rl += valid[k] ? lum[k] : 0; rv += valid[k];
            cl[(y + 1) * W1 + x + 1] = cl[y * W1 + x + 1] + rl;
            cv[(y + 1) * W1 + x + 1] = cv[y * W1 + x + 1] + rv;
        }
    }
    dk.W = W; dk.H = H; dk.D.assign(N, 0.0);
    for (int y = 0; y < H; ++y) {
        const int y0 = std::max(0, y - h), y1 = std::min(H, y + h + 1);
        for (int x = 0; x < W; ++x) {
            const size_t k = static_cast<size_t>(y) * W + x;
            if (!valid[k]) { dk.D[k] = kNaN; continue; }
            const int x0 = std::max(0, x - h), x1 = std::min(W, x + h + 1);
            const auto box = [&](const std::vector<double>& c) { return c[y1 * W1 + x1] - c[y0 * W1 + x1] - c[y1 * W1 + x0] + c[y0 * W1 + x0]; };
            const double wall = std::max((box(cl) / std::max(box(cv), 1.0)) * 1.15, 1.0);
            dk.D[k] = std::min(1.0, std::max(0.0, (wall - lum[k]) / wall));
        }
    }
}

/** Otsu's threshold of the darkness (64 bins over [0, 1]): the darker class. */
inline std::vector<uint8_t> otsuMask(const Darkness& dk, const std::vector<uint8_t>& valid) {
    double hist[64] = {0};
    for (size_t k = 0; k < dk.D.size(); ++k) if (valid[k] && dk.D[k] == dk.D[k]) hist[std::min(63, static_cast<int>(std::floor(dk.D[k] * 64)))]++;
    double total = 0;
    for (double v : hist) total += v;
    double w0 = 0, mu = 0, muAll = 0;
    for (int i = 0; i < 64; ++i) muAll += hist[i] * (i + 0.5) / 64;
    double best = -1;
    int at = 0;
    for (int i = 0; i < 64; ++i) {
        w0 += hist[i]; mu += hist[i] * (i + 0.5) / 64;
        const double w1 = total - w0, d = muAll * w0 / std::max(total, 1.0) - mu, b = d * d / std::max(w0 * w1, 1.0);
        if (b > best) { best = b; at = i; }
    }
    const double thr = at / 64.0;
    std::vector<uint8_t> out(dk.D.size());
    for (size_t k = 0; k < out.size(); ++k) out[k] = valid[k] && dk.D[k] > thr ? 1 : 0;
    return out;
}

inline int reflectScipy(int i, int n) { while (i < 0 || i >= n) i = i < 0 ? -i - 1 : 2 * n - i - 1; return i; }
inline int reflectNumpy(int i, int n) { if (n == 1) return 0; while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i; return i; }

/** Opening evidence also darker than its row's local mean along the wall. */
inline void lateralEvidence(const Darkness& dk, const std::vector<uint8_t>& valid, std::vector<uint8_t>& dark, double pixel, const Params& P) {
    const int W = dk.W, H = dk.H, k = std::max(3, static_cast<int>(js::pyRound(P.latWindowM / pixel))), lo = k >> 1;
    std::vector<double> s(W + 1), v(W + 1);
    for (int y = 0; y < H; ++y) {
        const auto pre = [&](int x, double& d, double& w) { const int j = reflectScipy(x, W); const size_t kk = static_cast<size_t>(y) * W + j; d = valid[kk] && dk.D[kk] == dk.D[kk] ? dk.D[kk] : 0; w = valid[kk]; };
        double a = 0, b = 0, d, w;
        for (int x = -lo; x < -lo + k; ++x) { pre(x, d, w); a += d * w; b += w; }
        for (int x = 0; x < W; ++x) {
            s[x] = a; v[x] = b;
            double d0, w0, d1, w1;
            pre(x - lo, d0, w0); pre(x - lo + k, d1, w1);
            a += d1 * w1 - d0 * w0; b += w1 - w0;
        }
        for (int x = 0; x < W; ++x) {
            const size_t kk = static_cast<size_t>(y) * W + x;
            const double local = s[x] / std::max(v[x], 1e-6), dz = dk.D[kk] == dk.D[kk] ? dk.D[kk] : 0;
            if (!(dz > local + P.stripMargin)) dark[kk] = 0;
        }
    }
}

/** The best repeat lag (m) of a profile: detrended by a running mean, normalised, the strongest positive autocorrelation. */
inline double autocorrPitch(const std::vector<double>& profile, double px, double lo, double hi, const Params& P) {
    const int n = static_cast<int>(profile.size());
    const double m = meanFinite(profile);
    std::vector<double> v(n);
    for (int i = 0; i < n; ++i) v[i] = std::isfinite(profile[i]) ? profile[i] : std::isfinite(m) ? m : 0;
    const int w = std::max(3, static_cast<int>(std::trunc(P.meanWindowM / px))) | 1, h = w >> 1;
    std::vector<double> rm(n);
    for (int i = 0; i < n; ++i) { double s = 0; for (int j = i - h; j <= i + h; ++j) s += v[reflectNumpy(j, n)]; rm[i] = s / w; }
    for (int i = 0; i < n; ++i) v[i] -= rm[i];
    double su = 0;
    for (double x : v) su += x;
    const double mu = su / n;
    double sq = 0;
    for (double x : v) sq += (x - mu) * (x - mu);
    const double sd = std::sqrt(sq / n);
    for (int i = 0; i < n; ++i) v[i] = (v[i] - mu) / (sd + 1e-9);
    double best = 0;
    int lag = 0;
    const int kHi = std::min(static_cast<int>(std::floor(n / 2.0)), static_cast<int>(std::trunc(hi / px)));
    for (int k = std::max(2, static_cast<int>(std::trunc(lo / px))); k <= kHi; ++k) {
        double c = 0;
        for (int i = 0; i + k < n; ++i) c += v[i] * v[i + k];
        c /= n - k;
        if (c > best) { best = c; lag = k; }
    }
    return lag * px;
}

using Rows = std::vector<std::vector<double>>;

/** A moving average of length n along a sequence of vectors (edge-padded). */
inline Rows smoothAlong(const Rows& rows, double nIn) {
    const int n = std::max(1, static_cast<int>(std::trunc(nIn)));
    const int L = static_cast<int>(rows.size()), h = n >> 1;
    Rows out(L, std::vector<double>(L ? rows[0].size() : 0, 0.0));
    for (int i = 0; i < L; ++i) {
        auto& o = out[i];
        for (int j = i - h; j < i - h + n; ++j) {
            const auto& r = rows[std::min(L - 1, std::max(0, j))];
            for (size_t d = 0; d < o.size(); ++d) o[d] += r[d] / n;
        }
    }
    return out;
}

/** Binary segmentation of a sequence of vectors by their spread around the segment mean. */
inline std::vector<Span> segments(const Rows& vec, size_t begin, size_t end, int minLen, double gain, int depth = 0) {
    const int n = static_cast<int>(end - begin);
    if (n < 2 * minLen || depth > 4 || minLen < 1) return {{0, n}};
    const size_t d = vec[begin].size();
    std::vector<double> S1(static_cast<size_t>(n + 1) * d, 0.0), S2(n + 1, 0.0);
    for (int i = 0; i < n; ++i) {
        const auto& r = vec[begin + i];
        double q = 0;
        for (size_t j = 0; j < d; ++j) { S1[(i + 1) * d + j] = S1[i * d + j] + r[j]; q += r[j] * r[j]; }
        S2[i + 1] = S2[i] + q;
    }
    const auto cost = [&](int a, int b) { double s = 0; for (size_t j = 0; j < d; ++j) { const double x = S1[b * d + j] - S1[a * d + j]; s += x * x; } return S2[b] - S2[a] - s / std::max(1, b - a); };
    const double whole = cost(0, n);
    double best = 0;
    int at = -1;
    for (int k = minLen; k <= n - minLen; ++k) { const double g = whole - cost(0, k) - cost(k, n); if (g > best) { best = g; at = k; } }
    if (at < 0 || best < gain * whole) return {{0, n}};
    auto left = segments(vec, begin, begin + at, minLen, gain, depth + 1);
    for (auto [a, b] : segments(vec, begin + at, end, minLen, gain, depth + 1)) left.emplace_back(a + at, b + at);
    return left;
}

struct Ctx {
    const FacadePhoto* ph;
    const Darkness* dk;
    const std::vector<uint8_t>* valid;
    Params P;
    /** Per band, the 30th percentile of its darkness (refineCells' wall), computed once. */
    std::map<Band, double> wallOf;
};

inline std::array<int, 4> toPx(const Ctx& c, double s0, double s1, double t0, double t1) {
    const double px = c.ph->pixel;
    return {static_cast<int>(std::floor((std::min(s0, s1) - c.ph->orthoSMin) / px)), static_cast<int>(std::ceil((std::max(s0, s1) - c.ph->orthoSMin) / px)),
            static_cast<int>(std::floor((c.ph->orthoTMax - std::max(t0, t1)) / px)), static_cast<int>(std::ceil((c.ph->orthoTMax - std::min(t0, t1)) / px))};
}

inline bool presentCell(const Ctx& c, int xa, int ya, int xb, int yb) {
    const auto& dk = *c.dk;
    if (dk.finiteShare(xa, xb, ya, yb) < 0.5) return false;
    const int my = std::max(2, (yb - ya) >> 1), mx = std::max(2, (xb - xa) >> 1);
    const Rect hole{xa, xb, ya, yb};
    const double inside = dk.boxMean(xa, xb, ya, yb), around = dk.boxMean(xa - mx, xb + mx, ya - my, yb + my, &hole);
    return inside - (std::isfinite(around) ? around : 0) > c.P.present;
}

inline std::vector<std::pair<double, double>> runsOf(const std::vector<std::pair<double, double>>& a, double share) {
    double m = -std::numeric_limits<double>::infinity();
    for (const auto& r : a) m = std::max(m, r.second);
    std::vector<std::pair<double, double>> out;
    for (const auto& r : a) if (r.second >= share * m) out.push_back(r);
    return out;
}

/** Runs of a bay's profile darker than its mullion level. */
inline std::vector<Span> splitPanes(const std::vector<double>& bay, double pier, const Params& P, int minW = 0) {
    const double dark = percentile(bay, 75), split = dark - P.mullion * (dark - pier);
    std::vector<Span> panes;
    const int n = static_cast<int>(bay.size());
    for (int i = 0; i < n;) {
        if (bay[i] > split) { int j = i; while (j + 1 < n && bay[j + 1] > split) j++; panes.emplace_back(i, j + 1); i = j + 1; } else i++;
    }
    if (panes.empty()) return panes;
    int longest = 0;
    for (auto [a, b] : panes) longest = std::max(longest, b - a);
    std::vector<Span> out;
    for (auto [a, b] : panes) if (b - a >= P.runShare * longest && b - a >= minW) out.emplace_back(a, b);
    return out;
}

/** The light run of a fold: [pw, pa] (its length and start), over the fold read twice round. */
inline std::pair<int, int> lightRun(const std::vector<bool>& light, int tw) {
    std::pair<int, int> best{0, 0};
    int run = 0;
    for (int i = 0; i < 2 * tw; ++i) { run = light[i % tw] ? run + 1 : 0; if (run > best.first && run < tw) best = {run, i - run + 1}; }
    return best;
}

struct Nested { double ps; std::vector<std::pair<double, double>> cols; double lightThr; int pw; double pier; };

inline std::optional<Nested> nestedColumns(const Ctx& c, const ReliefGrid& g, const Band& band) {
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    const double px = c.ph->pixel, ps = g.foundS ? g.pitchS : 0;
    if (!(ps > 0)) return std::nullopt;
    const auto col = c.dk->colMeans(x0, x1, y0, y1);
    if (!anyFinite(col)) return std::nullopt;
    const int tw = std::max(4, static_cast<int>(std::ceil(ps / px)));
    std::vector<double> sum(tw, 0.0), cnt(tw, 0.0);
    for (int x = x0; x < x1; ++x) {
        const int b = std::min(tw - 1, std::max(0, static_cast<int>(std::trunc(std::fmod((x - x0) * px, ps) / px))));
        const double v = col[x - x0];
        if (std::isfinite(v)) { sum[b] += v; cnt[b]++; }
    }
    std::vector<double> fold(tw);
    for (int i = 0; i < tw; ++i) fold[i] = cnt[i] != 0 ? sum[i] / cnt[i] : kNaN;
    if (!anyFinite(fold)) return std::nullopt;
    double fmin = std::numeric_limits<double>::infinity();
    for (double v : fold) if (std::isfinite(v)) fmin = std::min(fmin, v);
    for (double& v : fold) if (!std::isfinite(v)) v = fmin;
    const double lo = *std::min_element(fold.begin(), fold.end()), hi = *std::max_element(fold.begin(), fold.end()), lightThr = lo + (hi - lo) / 3;
    std::vector<bool> light(tw);
    for (int i = 0; i < tw; ++i) light[i] = fold[i] < lightThr;
    const auto [pw, pa] = lightRun(light, tw);
    if (pw < 1 || tw - pw < 2) return std::nullopt;
    const int start = (pa + pw) % tw;
    std::vector<double> bay(tw - pw);
    for (int i = 0; i < tw - pw; ++i) bay[i] = fold[(start + i) % tw];
    double ps2 = 0;
    int pn = 0;
    for (int i = 0; i < tw; ++i) if (light[i] && std::isfinite(fold[i])) { ps2 += fold[i]; pn++; }
    const double pier = pn ? ps2 / pn : kNaN;
    const auto panes = splitPanes(bay, pier, c.P);
    if (panes.empty()) return std::nullopt;
    const double s0 = c.ph->orthoSMin + x0 * px;
    Nested n{ps, {}, lightThr, pw, pier};
    for (auto [a, b] : panes) n.cols.emplace_back(s0 + (start + a) * px, (b - a) * px);
    return n;
}

/** Bays as their piers stand, split at mullions. */
inline std::vector<Span> pierColumns(const Ctx& c, const ReliefGrid& g, const Band& band) {
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    const auto n = nestedColumns(c, g, band);
    if (!n) return {};
    const auto raw = c.dk->colMeans(x0, x1, y0, y1);
    if (!anyFinite(raw)) return {};
    std::vector<double> col(raw.size());
    for (size_t i = 0; i < raw.size(); ++i) col[i] = std::isfinite(raw[i]) ? raw[i] : n->pier;
    std::vector<Span> piers;
    const int L = static_cast<int>(col.size());
    for (int i = 0; i < L;) {
        if (col[i] < n->lightThr) { int j = i; while (j + 1 < L && col[j + 1] < n->lightThr) j++; if (j + 1 - i >= std::max(1.0, c.P.pierMinShare * n->pw)) piers.emplace_back(i, j + 1); i = j + 1; } else i++;
    }
    const double tw = n->ps / c.ph->pixel;
    std::vector<Span> spans;
    for (size_t k = 0; k + 1 < piers.size(); ++k) {
        const int a1 = piers[k].second, b0 = piers[k + 1].first;
        if (!(c.P.bayRange0 * tw <= b0 - a1 && b0 - a1 <= c.P.bayRange1 * tw)) continue;
        const std::vector<double> sub(col.begin() + a1, col.begin() + b0);
        for (auto [p, q] : splitPanes(sub, n->pier, c.P, 2)) spans.emplace_back(x0 + a1 + p, x0 + a1 + q);
    }
    return spans;
}

/** The relief's rows laid at its storey pitch over the band. */
inline std::vector<Span> rowSpans(const Ctx& c, const ReliefGrid& g, const Band& band) {
    const int y0 = band[2], y1 = band[3];
    const double px = c.ph->pixel, pt = g.pitchT;
    const double tHi = c.ph->orthoTMax - y0 * px, tLo = c.ph->orthoTMax - y1 * px;
    std::vector<Span> out;
    if (!(std::isfinite(pt) && pt != 0)) return out;
    for (auto [rt, rh] : runsOf(g.runsT, c.P.runShare)) {
        const double jEnd = std::ceil((tHi - rt) / pt) + 1;
        for (double j = std::floor((tLo - rt) / pt) - 1; j < jEnd; j++) {
            const double b = rt + j * pt;
            const auto r = toPx(c, 0, 0, b, b + rh);
            const int a = std::max(y0, r[2]), e = std::min(y1, r[3]);
            if (e - a >= 2) out.emplace_back(a, e);
        }
    }
    return out;
}

inline std::vector<Rect> cellsLayout(const Ctx& c, const ReliefGrid& g, const Band& band, bool nested) {
    const int x0 = band[0], x1 = band[1];
    const double px = c.ph->pixel;
    if (!(g.foundS && g.foundT && g.cellFoundS && g.cellFoundT && !g.runsS.empty() && !g.runsT.empty())) return {};
    double ps = g.pitchS;
    auto cols = runsOf(g.runsS, c.P.runShare);
    if (nested) { const auto n = nestedColumns(c, g, band); if (n) { ps = n->ps; cols = n->cols; } }
    const double sLo = c.ph->orthoSMin + x0 * px, sHi = c.ph->orthoSMin + x1 * px;
    const auto rows = rowSpans(c, g, band);
    std::vector<Rect> out;
    for (auto [cs, cw] : cols) {
        const double kEnd = std::ceil((sHi - cs) / ps) + 1;
        for (double k = std::floor((sLo - cs) / ps) - 1; k < kEnd; k++) {
            const auto r = toPx(c, cs + k * ps, cs + k * ps + cw, 0, 0);
            const int xa = std::max(x0, r[0]), xb = std::min(x1, r[1]);
            if (xb - xa < 2) continue;
            for (auto [ya, yb] : rows) if (presentCell(c, xa, ya, xb, yb)) out.push_back({xa, ya, xb, yb});
        }
    }
    return out;
}

inline std::vector<Rect> pierCellsLayout(const Ctx& c, const ReliefGrid& g, const Band& band) {
    if (!(g.foundT && g.cellFoundT && !g.runsT.empty())) return {};
    const auto rows = rowSpans(c, g, band);
    std::vector<Rect> out;
    for (auto [xa, xb] : pierColumns(c, g, band)) for (auto [ya, yb] : rows) if (presentCell(c, xa, ya, xb, yb)) out.push_back({xa, ya, xb, yb});
    return out;
}

inline std::vector<Rect> stripsLayout(const Ctx& c, const ReliefGrid& g, const Band& band, bool nested) {
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    const double px = c.ph->pixel;
    std::vector<Rect> out;
    if (nested) {
        const auto n = nestedColumns(c, g, band);
        if (!n) return {};
        const double sLo = c.ph->orthoSMin + x0 * px, sHi = c.ph->orthoSMin + x1 * px;
        for (auto [cs, cw] : n->cols) {
            const double kEnd = std::ceil((sHi - cs) / n->ps) + 1;
            for (double k = std::floor((sLo - cs) / n->ps) - 1; k < kEnd; k++) {
                const auto r = toPx(c, cs + k * n->ps, cs + k * n->ps + cw, 0, 0);
                const int xa = std::max(x0, r[0]), xb = std::min(x1, r[1]);
                if (xb - xa >= 2) out.push_back({xa, y0, xb, y1});
            }
        }
        return out;
    }
    const double ps = g.foundS ? g.pitchS : 0;
    if (!(ps > 0)) return {};
    const auto col = c.dk->colMeans(x0, x1, y0, y1);
    if (!anyFinite(col)) return {};
    const int tw = std::max(4, static_cast<int>(js::pyRound(ps / px)));
    std::vector<double> fold(tw);
    for (int i = 0; i < tw; ++i) { double s = 0; int n = 0; for (size_t x = i; x < col.size(); x += tw) if (std::isfinite(col[x])) { s += col[x]; n++; } fold[i] = n ? s / n : kNaN; }
    if (!anyFinite(fold)) return {};
    double lo = std::numeric_limits<double>::infinity(), hi = -lo;
    for (double v : fold) if (std::isfinite(v)) { lo = std::min(lo, v); hi = std::max(hi, v); }
    std::vector<bool> light(tw);
    for (int i = 0; i < tw; ++i) light[i] = fold[i] < lo + (hi - lo) / 3;
    const auto [pw, pa] = lightRun(light, tw);
    if (pw < 1 || tw - pw < 2) return {};
    const int a = (pa + pw) % tw, w = tw - pw;
    const int kEnd = static_cast<int>(std::floor(static_cast<double>(x1 - x0) / tw)) + 2;
    for (int k = -1; k < kEnd; ++k) {
        const int xa = std::max(x0, x0 + a + k * tw), xb = std::min(x1, x0 + a + k * tw + w);
        if (xb - xa >= 2) out.push_back({xa, y0, xb, y1});
    }
    return out;
}

/** The band's storey slabs from its top at the storey pitch; those whose profile along the wall repeats the band's. */
inline std::pair<std::vector<Span>, std::set<Span>> repeatingSlabs(const Ctx& c, const Band& band, int ptPx) {
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    std::vector<Span> slabs;
    if (ptPx < 4) slabs.emplace_back(y0, y1);
    if (ptPx >= 4) for (int y = y0; y < y1; y += ptPx) if (std::min(y1, y + ptPx) - y >= (ptPx >> 1)) slabs.emplace_back(y, std::min(y1, y + ptPx));
    if (slabs.size() < 3) return {slabs, std::set<Span>(slabs.begin(), slabs.end())};
    std::vector<std::vector<double>> prof;
    for (auto [a, b] : slabs) { auto p = c.dk->colMeans(x0, x1, a, b); for (double& v : p) if (!std::isfinite(v)) v = 0; prof.push_back(std::move(p)); }
    std::vector<double> med(prof[0].size()), col(prof.size());
    for (size_t i = 0; i < med.size(); ++i) { for (size_t s = 0; s < prof.size(); ++s) col[s] = prof[s][i]; med[i] = median(col); }
    std::set<Span> keep;
    for (size_t i = 0; i < slabs.size(); ++i) if (ncc(prof[i], med) >= c.P.rowNcc) keep.insert(slabs[i]);
    return {slabs, keep};
}

inline std::vector<Rect> mergeRuns(std::vector<Rect> out) {
    sortRects(out);
    std::vector<Rect> merged;
    for (const auto& r : out) {
        if (!merged.empty()) { auto& m = merged.back(); if (m[0] == r[0] && m[2] == r[2] && m[3] == r[1]) { m[3] = r[3]; continue; } }
        merged.push_back(r);
    }
    return merged;
}

/** Each strip kept over the storeys where it is darker than the piers beside it and the storey repeats the band's. */
inline std::vector<Rect> refineStrips(const Ctx& c, const std::vector<Rect>& rects, const Band& band, int ptPx) {
    if (rects.empty()) return rects;
    const auto& dk = *c.dk;
    const auto& P = c.P;
    const int W = dk.W;
    auto xs = rects;
    sortRects(xs);
    std::vector<double> gaps;
    for (size_t i = 0; i + 1 < xs.size(); ++i) { const int g = xs[i + 1][0] - xs[i][2]; if (g > 0) gaps.push_back(g); }
    const int pw = !gaps.empty() ? static_cast<int>(std::trunc(median(gaps))) : std::max(2, static_cast<int>(std::trunc((xs[0][2] - xs[0][0]) / 3.0)));
    const auto [slabs, keep] = repeatingSlabs(c, band, ptPx);
    std::vector<Rect> out;
    for (const auto& r : rects) {
        const int xa = r[0], ya = r[1], xb = r[2], yb = r[3];
        const int l0 = std::max(0, xa - pw), r1 = std::min(W, xb + pw);
        for (const auto& s : slabs) {
            if (!keep.count(s)) continue;
            const int a = std::max(ya, s.first), b = std::min(yb, s.second);
            if (b - a < 2) continue;
            const auto strip = dk.rowMeans(xa, xb, a, b);
            int ok = 0, darkRows = 0;
            for (int i = 0; i < b - a; ++i) {
                double ps = 0; int pn = 0;
                for (int x = l0; x < xa; ++x) { const double v = dk.at(x, a + i); if (v == v) { ps += v; pn++; } }
                for (int x = xb; x < r1; ++x) { const double v = dk.at(x, a + i); if (v == v) { ps += v; pn++; } }
                const double pier = l0 < xa || xb < r1 ? (pn ? ps / pn : kNaN) : 0;
                if (!(std::isfinite(strip[i]) && std::isfinite(pier))) continue;
                ok++;
                if (strip[i] - pier > P.stripMargin) darkRows++;
            }
            if (static_cast<double>(ok) / (b - a) < 0.5) continue;
            if (static_cast<double>(darkRows) / ok >= P.stripDarkShare) out.push_back({xa, a, xb, b});
        }
    }
    return mergeRuns(std::move(out));
}

inline std::vector<Rect> dedupeIou(std::vector<Rect> out) {
    sortRects(out);
    std::vector<Rect> keep;
    for (const auto& r : out) { bool clash = false; for (const auto& o : keep) if (boxesIou(r, o) > 0.5) { clash = true; break; } if (!clash) keep.push_back(r); }
    return keep;
}

/** Each column measured along the wall: moved to the darkest point near it and given the dark run there. */
inline std::vector<Rect> rephaseColumns(const Ctx& c, const std::vector<Rect>& rects, const Band& band) {
    if (rects.empty()) return rects;
    const auto& dk = *c.dk;
    const auto& P = c.P;
    const int x0 = band[0], x1 = band[1];
    std::vector<Rect> out;
    for (const auto& r : rects) {
        const int xa = r[0], ya = r[1], xb = r[2], yb = r[3];
        const int w = xb - xa, lo = std::max(x0, xa - (w >> 1)), hi = std::min(x1, xb + (w >> 1));
        const auto raw = yb > ya && hi > lo ? dk.colMeans(lo, hi, ya, yb) : std::vector<double>();
        if (raw.empty() || !anyFinite(raw)) { out.push_back(r); continue; }
        const double pier = percentile(raw, 15);
        std::vector<double> q(raw.size());
        for (size_t i = 0; i < raw.size(); ++i) q[i] = std::isfinite(raw[i]) ? raw[i] : pier;
        const int n = static_cast<int>(q.size()), k = std::max(1, w >> 2);
        std::vector<double> sm(n);
        for (int i = 0; i < n; ++i) { double s = 0; for (int j = i - (k >> 1); j <= i + ((k - 1) >> 1); ++j) if (j >= 0 && j < n) s += q[j]; sm[i] = s / k; }
        const int c0 = xa - lo, c1 = xb - lo;
        int mid = (c0 + c1) >> 1;
        if (c1 > c0) { mid = c0; for (int i = c0; i < c1; ++i) if (sm[i] > sm[mid]) mid = i; }
        if (mid < 0 || mid >= n) { out.push_back(r); continue; }
        const int lb = std::max(0, mid - (k >> 1)), le = std::min(n, mid + (k >> 1) + 1);
        const double level = sumSeq(q, lb, le) / (le - lb), thr = (level + pier) / 2;
        if (q[mid] <= thr || level - pier < P.stripMargin) { out.push_back(r); continue; }
        const auto grow = [&](int i, int d) { for (;;) { bool moved = false; for (int g = 1; g <= 4; ++g) { const int nx = i + d * g; if (nx >= 0 && nx < n && q[nx] > thr) { i = nx; moved = true; break; } } if (!moved) return i; } };
        const int a = grow(mid, -1), b = grow(mid, 1), nw = b + 1 - a;
        if (!(P.rephaseWidth0 * w <= nw && nw <= P.rephaseWidth1 * w)) { out.push_back(r); continue; }
        const int na = lo + a, nb = lo + b + 1, pw = std::max(2, (nb - na) >> 1);
        double ss = 0; int sn = 0;
        for (int y = ya; y < yb; ++y) {
            for (int x = std::max(x0, na - pw); x < na; ++x) { const double v = dk.at(x, y); if (v == v) { ss += v; sn++; } }
            for (int x = nb; x < std::min(x1, nb + pw); ++x) { const double v = dk.at(x, y); if (v == v) { ss += v; sn++; } }
        }
        if (sn && dk.boxMean(na, nb, ya, yb) - ss / sn < P.stripMargin) continue;
        out.push_back({na, ya, nb, yb});
    }
    return dedupeIou(std::move(out));
}

/** Each cell measured up the wall (its dark run, darker than the piers beside it); storeys that agree in height kept. */
inline std::vector<Rect> refineCells(Ctx& c, const std::vector<Rect>& rects, const Band& band) {
    if (rects.empty()) return rects;
    const auto& dk = *c.dk;
    const auto& P = c.P;
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    auto wit = c.wallOf.find(band);
    if (wit == c.wallOf.end()) {
        std::vector<double> vals;
        for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) { const double v = dk.at(x, y); if (v == v) vals.push_back(v); }
        wit = c.wallOf.emplace(band, vals.empty() ? 0.0 : percentile(std::move(vals), 30)).first;
    }
    const double wall = wit->second;
    std::vector<std::pair<Span, Rect>> measured;
    for (const auto& r : rects) {
        const int xa = r[0], ya = r[1], xb = r[2], yb = r[3];
        const auto pRaw = dk.rowMeans(xa, xb, y0, y1);
        if (!anyFinite(pRaw)) continue;
        const int w = std::max(2, (xb - xa) >> 1), l0 = std::max(x0, xa - w), r1 = std::min(x1, xb + w);
        const bool hasSide = l0 < xa || xb < r1;
        std::vector<double> lat(pRaw.size());
        for (size_t i = 0; i < pRaw.size(); ++i) {
            const int y = y0 + static_cast<int>(i);
            double ps = 0; int pn = 0;
            for (int x = l0; x < xa; ++x) { const double d = dk.at(x, y); if (d == d) { ps += d; pn++; } }
            for (int x = xb; x < r1; ++x) { const double d = dk.at(x, y); if (d == d) { ps += d; pn++; } }
            const double pier = hasSide && pn ? ps / pn : wall;
            lat[i] = (std::isfinite(pRaw[i]) ? pRaw[i] : wall) - pier;
        }
        const int c0 = ya - y0, c1 = yb - y0, mid = (c0 + c1) >> 1, n = static_cast<int>(lat.size());
        if (!(mid >= 0 && mid < n)) continue;
        double inner;
        if (c1 > c0) {
            const int sb = std::max(0, std::min(c0, n)), se = std::max(0, std::min(c1, n));
            inner = se > sb ? sumSeq(lat, sb, se) / (se - sb) : kNaN;
        } else inner = lat[mid];
        const double thr = inner / 2;
        if (inner < P.stripMargin || lat[mid] <= thr) continue;
        const auto grow = [&](int i, int d) { for (;;) { bool moved = false; for (int g = 1; g <= 3; ++g) { const int nx = i + d * g; if (nx >= 0 && nx < n && lat[nx] > thr) { i = nx; moved = true; break; } } if (!moved) return i; } };
        measured.push_back({{ya, yb}, {xa, y0 + grow(mid, -1), xb, y0 + grow(mid, 1) + 1}});
    }
    if (measured.empty()) return {};
    // the storeys in order of their rows (the TypeScript sorts its keys so)
    std::map<Span, std::vector<Rect>> storeys;
    for (const auto& [k, r] : measured) storeys[k].push_back(r);
    double tallest = -std::numeric_limits<double>::infinity();
    for (const auto& [k, rs] : storeys) { std::vector<double> hs; for (const auto& r : rs) hs.push_back(r[3] - r[1]); tallest = std::max(tallest, median(hs)); }
    std::vector<Rect> out;
    for (const auto& [key, rs0] : storeys) {
        std::vector<double> hs;
        for (const auto& r : rs0) hs.push_back(r[3] - r[1]);
        const double med = median(hs);
        if (storeys.size() > 1 && med < P.shortStorey * tallest) continue;
        std::vector<double> dev;
        for (double h : hs) dev.push_back(std::fabs(h - med));
        if (rs0.size() < 2 || median(dev) > P.storeySpread * med) continue;
        auto rs = rs0;
        sortRects(rs);
        for (const auto& r : rs) {
            const double h = r[3] - r[1];
            if (!(P.heightBand0 * med <= h && h <= P.heightBand1 * med)) continue;
            bool clash = false;
            for (const auto& o : out) if (boxesIou(r, o) > 0.5) { clash = true; break; }
            if (clash) continue;
            out.push_back(r);
        }
    }
    return out;
}

/** A bay's window columns, from the rhythm of its per-column variation up the wall. */
inline std::optional<std::vector<Span>> bayColumns(const Ctx& c, int xa, int ya, int xb, int yb) {
    const int W = xb - xa;
    if (W < 16 || yb - ya < 4) return std::nullopt;
    std::vector<double> p(W);
    for (int x = xa; x < xb; ++x) {
        double s = 0, s2 = 0; int n = 0;
        for (int y = ya; y < yb; ++y) { const double v = c.dk->at(x, y); if (v == v) { s += v; s2 += v * v; n++; } }
        p[x - xa] = n ? std::sqrt(std::max(0.0, s2 / n - (s / n) * (s / n))) : 0;
    }
    double pm = 0;
    for (double v : p) pm += v;
    pm /= W;
    std::vector<double> q(W);
    double den = 0;
    for (int i = 0; i < W; ++i) q[i] = p[i] - pm;
    for (double v : q) den += v * v;
    if (!(den > 0)) return std::nullopt;
    std::vector<double> ac(W);
    for (int L = 0; L < W; ++L) { double s = 0; for (int i = 0; i + L < W; ++i) s += q[i] * q[i + L]; ac[L] = s / den; }
    const int lo = std::max(6, static_cast<int>(std::trunc(0.25 * W))), hi = static_cast<int>(std::trunc(0.6 * W));
    int L = -1;
    for (int l = lo; l <= std::min(hi, W - 2); ++l) if (ac[l] >= ac[l - 1] && ac[l] >= ac[l + 1] && ac[l] >= c.P.subAc && (L < 0 || ac[l] > ac[L])) L = l;
    if (L < 0) return std::nullopt;
    const int n = static_cast<int>(js::pyRound(static_cast<double>(W) / L));
    if (n < 2) return std::nullopt;
    std::vector<double> sm(W);
    for (int i = 0; i < W; ++i) sm[i] = ((i > 0 ? p[i - 1] : 0) + p[i] + (i < W - 1 ? p[i + 1] : 0)) / 3;
    const auto argmin = [&](int a, int b) { int m = a; for (int i = a; i < b; ++i) if (sm[i] < sm[m]) m = i; return m; };
    std::vector<int> divs;
    const int third = static_cast<int>(std::trunc(L / 3.0));
    for (int k = 1; k < n; ++k) { const int cc = static_cast<int>(js::pyRound(static_cast<double>(k * W) / n)); divs.push_back(argmin(std::max(1, cc - third), std::min(W - 1, cc + third + 1))); }
    const double smMed = median(sm);
    const auto thr = [&](int d) { return (sm[d] + smMed) / 2; };
    const int edge = std::max(1, third);
    const int leftEdge = argmin(0, edge);
    int rightEdge = W - 1;
    for (int i = W - 1; i >= W - edge; --i) if (sm[i] < sm[rightEdge]) rightEdge = i;
    std::vector<int> bounds{0};
    bounds.insert(bounds.end(), divs.begin(), divs.end());
    bounds.push_back(W);
    std::vector<Span> cols;
    for (int i = 0; i < n; ++i) {
        const int a = bounds[i], b = bounds[i + 1];
        const double t = std::max(i > 0 ? thr(divs[i - 1]) : thr(leftEdge), i < n - 1 ? thr(divs[i]) : thr(rightEdge));
        int first = -1, last = -1;
        for (int x = a; x < b; ++x) if (sm[x] > t) { if (first < 0) first = x; last = x; }
        if (first >= 0 && last + 1 - first >= 0.4 * L) cols.emplace_back(xa + first, xa + last + 1);
    }
    if (cols.size() >= 2) return cols;
    return std::nullopt;
}

struct SplitBays { std::vector<Rect> rects; int found = 0, bays = 0; };

/** Strips split at the window-column rhythm inside each bay, when most of the band's bays find it. */
inline SplitBays splitBays(const Ctx& c, const std::vector<Rect>& rects) {
    if (rects.empty()) return {rects, 0, 0};
    std::vector<Span> keys;
    std::map<Span, std::vector<Rect>> bays;
    for (const auto& r : rects) { auto& l = bays[{r[0], r[2]}]; if (l.empty()) keys.push_back({r[0], r[2]}); l.push_back(r); }
    std::map<Span, std::optional<std::vector<Span>>> found;
    int nf = 0;
    for (const auto& k : keys) {
        const auto& rs = bays[k];
        int ya = std::numeric_limits<int>::max(), yb = std::numeric_limits<int>::min();
        for (const auto& r : rs) { ya = std::min(ya, r[1]); yb = std::max(yb, r[3]); }
        auto f = bayColumns(c, rs[0][0], ya, rs[0][2], yb);
        if (f) nf++;
        found[k] = std::move(f);
    }
    if (static_cast<double>(nf) / bays.size() < c.P.subMajority) return {rects, nf, static_cast<int>(bays.size())};
    std::vector<Rect> out;
    for (const auto& k : keys) {
        const auto& cols = found[k];
        for (const auto& r : bays[k]) {
            if (cols) for (auto [a, b] : *cols) out.push_back({a, r[1], b, r[3]});
            else out.push_back(r);
        }
    }
    return {out, nf, static_cast<int>(bays.size())};
}

/** sRGB 8-bit to CIELAB (D65). */
struct LabTable {
    double lin[256];
    LabTable() { for (int v = 0; v < 256; ++v) { const double c = v / 255.0; lin[v] = c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); } }
};
inline const LabTable& labTable() { static const LabTable t; return t; }
inline std::array<double, 3> labOf8(int r, int g, int b) {
    const auto& T = labTable();
    const double R = T.lin[r], G = T.lin[g], B = T.lin[b];
    const auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116; };
    const double x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return {116 * y - 16, 500 * (x - y), 200 * (y - z)};
}

struct Look { bool has = false; std::array<double, 4> lab{}; double validShare = 0; };

/**
 * A region's look over its valid texels, leaving out `skip`'s: mean CIELAB and the spread of its lightness. The skipped
 * texels are rasterised once per call (the TypeScript tests every rect at every texel; the set is the same).
 */
inline Look regionLook(const FacadePhoto& ph, const std::vector<uint8_t>& valid, const Rect& r, const std::vector<Rect>* skip = nullptr) {
    const int W = ph.W, H = ph.H;
    const int xs = std::max(0, r[0]), xe = std::min(W, r[2]), ys = std::max(0, r[1]), ye = std::min(H, r[3]);
    Look out;
    if (xe <= xs || ye <= ys) return out;
    const int RW = xe - xs;
    std::vector<uint8_t> skipped;
    if (skip && !skip->empty()) {
        skipped.assign(static_cast<size_t>(RW) * (ye - ys), 0);
        for (const auto& q : *skip) {
            const int a0 = std::max(xs, q[0]), a1 = std::min(xe, q[2]), b0 = std::max(ys, q[1]), b1 = std::min(ye, q[3]);
            for (int y = b0; y < b1; ++y) std::fill(skipped.begin() + static_cast<size_t>(y - ys) * RW + (a0 - xs), skipped.begin() + static_cast<size_t>(y - ys) * RW + std::max(a0, a1) - xs, 1);
        }
    }
    double m0 = 0, m1 = 0, m2 = 0, l2 = 0;
    long n = 0, all = 0;
    for (int y = ys; y < ye; ++y) for (int x = xs; x < xe; ++x) {
        if (!skipped.empty() && skipped[static_cast<size_t>(y - ys) * RW + (x - xs)]) continue;
        all++;
        const size_t k = static_cast<size_t>(y) * W + x;
        if (!valid[k]) continue;
        const auto l = labOf8(ph.rgba[k * 4], ph.rgba[k * 4 + 1], ph.rgba[k * 4 + 2]);
        m0 += l[0]; m1 += l[1]; m2 += l[2]; l2 += l[0] * l[0]; n++;
    }
    if (n) { const double mn = m0 / n; out.has = true; out.lab = {m0 / n, m1 / n, m2 / n, std::sqrt(std::max(0.0, l2 / n - mn * mn))}; }
    out.validShare = all ? static_cast<double>(n) / all : 0;
    return out;
}

/** The panes that read as glass: each against the wall just beside its window, kept only at least glassDeltaE from it. */
inline std::pair<std::vector<Rect>, int> panesUnlikeWall(const FacadePhoto& ph, const std::vector<uint8_t>& valid, const std::vector<Rect>& panes, const std::vector<Rect>& windows, const Band& band, const Params& P) {
    if (panes.empty()) return {panes, 0};
    std::optional<Look> bandWall;
    std::vector<Rect> keep;
    for (const auto& p : panes) {
        Rect w = p;
        for (const auto& q : windows) if (p[0] >= q[0] - 1 && p[2] <= q[2] + 1 && p[1] >= q[1] - 1 && p[3] <= q[3] + 1) { w = q; break; }
        const int sw = std::max(2, static_cast<int>(js::round((w[2] - w[0]) * 0.3)));
        std::vector<std::array<double, 4>> sides;
        for (const Rect& s : {Rect{w[0] - sw, p[1], w[0], p[3]}, Rect{w[2], p[1], w[2] + sw, p[3]}}) {
            const auto l = regionLook(ph, valid, s, &windows);
            if (l.has && l.validShare > 0.3) sides.push_back(l.lab);
        }
        std::array<double, 4> wall{};
        bool hasWall = false;
        if (!sides.empty()) {
            for (int j = 0; j < 3; ++j) { double t = 0; for (const auto& l : sides) t += l[j]; wall[j] = t / sides.size(); }
            hasWall = true;
        } else {
            if (!bandWall) bandWall = regionLook(ph, valid, Rect{band[0], band[2], band[1], band[3]}, &windows);
            hasWall = bandWall->has;
            wall = bandWall->lab;
        }
        const auto look = regionLook(ph, valid, p);
        if (!look.has || !hasWall) continue;
        if (js::hypot({look.lab[0] - wall[0], look.lab[1] - wall[1], look.lab[2] - wall[2]}) >= P.glassDeltaE) keep.push_back(p);
    }
    const int dropped = static_cast<int>(panes.size() - keep.size());
    return {keep, dropped};
}

struct Column { std::vector<Rect> rects; int storeys = 0; };

/** A narrow face's windows from its storey rhythm. */
inline std::optional<Column> storeyColumn(const Ctx& c, const Band& band, double tPitchM) {
    const auto& dk = *c.dk;
    const auto& P = c.P;
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3];
    const double pitch = tPitchM / c.ph->pixel;
    if (!(pitch >= 6) || (y1 - y0) < P.nMinStoreys * pitch) return std::nullopt;
    const auto col = dk.colMeans(x0, x1, y0, y1);
    double cLo = std::numeric_limits<double>::infinity(), cHi = -cLo;
    int nf = 0;
    for (double v : col) if (std::isfinite(v)) { cLo = std::min(cLo, v); cHi = std::max(cHi, v); nf++; }
    if (nf < 3) return std::nullopt;
    if (cHi - cLo < P.nMinContrast) return std::nullopt;
    std::pair<int, int> best{0, 0};
    const int L = static_cast<int>(col.size());
    for (int i = 0; i < L;) {
        if (!(col[i] > (cLo + cHi) / 2)) { i++; continue; }
        int j = i;
        while (j < L && col[j] > (cLo + cHi) / 2) j++;
        if (j - i > best.second - best.first) best = {i, j};
        i = j;
    }
    if (best.second - best.first < P.nMinColumnShare * (x1 - x0)) return std::nullopt;
    const int ca = x0 + best.first, cb = x0 + best.second;
    const auto rows = dk.rowMeans(ca, cb, y0, y1);
    const int nb = std::max(6, static_cast<int>(js::round(pitch)));
    std::vector<double> sum(nb, 0.0), cnt(nb, 0.0);
    for (size_t i = 0; i < rows.size(); ++i) {
        if (!std::isfinite(rows[i])) continue;
        const int b = std::min(nb - 1, static_cast<int>(std::floor((std::fmod(static_cast<double>(i), pitch) / pitch) * nb)));
        sum[b] += rows[i]; cnt[b]++;
    }
    for (double v : cnt) if (v == 0) return std::nullopt;
    std::vector<double> fold(nb);
    for (int i = 0; i < nb; ++i) fold[i] = sum[i] / cnt[i];
    const double fLo = *std::min_element(fold.begin(), fold.end()), fHi = *std::max_element(fold.begin(), fold.end());
    if (fHi - fLo < P.nMinContrast) return std::nullopt;
    std::vector<bool> darkBin(nb);
    for (int i = 0; i < nb; ++i) darkBin[i] = fold[i] > (fLo + fHi) / 2;
    std::pair<int, int> run{0, 0};
    for (int i = 0; i < nb; ++i) {
        if (!darkBin[i] || darkBin[(i - 1 + nb) % nb]) continue;
        int n = 0;
        while (n < nb && darkBin[(i + n) % nb]) n++;
        if (n > run.second) run = {i, n};
    }
    const double share = static_cast<double>(run.second) / nb;
    if (!run.second || share < P.nRunShare0 || share > P.nRunShare1) return std::nullopt;
    Column out;
    for (int k = 0; y0 + k * pitch < y1; ++k) {
        const int s0 = static_cast<int>(js::round(k * pitch)), s1 = std::min(static_cast<int>(rows.size()), static_cast<int>(js::round((k + 1) * pitch)));
        if (s1 - s0 < 0.9 * pitch) continue;
        out.storeys++;
        std::vector<double> seg(rows.begin() + s0, rows.begin() + s1), ref(seg.size());
        bool bad = false;
        for (size_t i = 0; i < seg.size(); ++i) { if (!std::isfinite(seg[i])) bad = true; ref[i] = fold[std::min(nb - 1, static_cast<int>(std::floor((std::fmod(static_cast<double>(i), pitch) / pitch) * nb)))]; }
        if (bad || ncc(seg, ref) < P.nMinStoreyNcc) continue;
        const int ya = static_cast<int>(js::round(y0 + k * pitch + (static_cast<double>(run.first) / nb) * pitch));
        const int yb = std::min(y1, static_cast<int>(js::round(y0 + k * pitch + (static_cast<double>(run.first + run.second) / nb) * pitch)));
        if (yb - ya >= 2) out.rects.push_back({ca, ya, cb, yb});
    }
    if (out.rects.size() >= static_cast<size_t>(P.nMinStoreys)) return out;
    return std::nullopt;
}

struct SpanGroup { double lo, hi; std::vector<int> members; };

/** Spans grouped where they overlap by `overlap` of the wider: each group's median span and its members. */
inline std::vector<SpanGroup> spanGroups(const std::vector<Span>& spans, double overlap) {
    std::vector<int> order(spans.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return spans[a].first < spans[b].first; });
    std::vector<SpanGroup> groups;
    for (int i : order) {
        const double a = spans[i].first, b = spans[i].second;
        SpanGroup* g = nullptr;
        for (auto& x : groups) if (std::min(b, x.hi) - std::max(a, x.lo) >= overlap * std::max(b - a, x.hi - x.lo)) { g = &x; break; }
        if (g) g->members.push_back(i);
        else { groups.push_back({a, b, {i}}); g = &groups.back(); }
        std::vector<double> l, h;
        for (int k : g->members) { l.push_back(spans[k].first); h.push_back(spans[k].second); }
        g->lo = median(l); g->hi = median(h);
    }
    std::stable_sort(groups.begin(), groups.end(), [](const SpanGroup& x, const SpanGroup& y) { return x.lo < y.lo; });
    return groups;
}

struct Completed { std::vector<Rect> rects; int added = 0, stone = 0; std::vector<Rect> generated; };

/** The looks of the facade's grid windows, read once for every band's completion. */
struct GridLooks {
    std::vector<Look> win;
    bool ready = false;
};

/** An accepted band's window lattice completed from the facade's repeats. */
inline Completed completeLattice(const FacadePhoto& ph, const std::vector<uint8_t>& valid, const std::vector<Rect>& rects, const Band& band, const Params& P, const std::vector<Rect>& grid, GridLooks& looks) {
    if (grid.size() < 4) return {rects, 0, 0, {}};
    std::vector<Span> cs, rs;
    for (const auto& r : grid) { cs.emplace_back(r[0], r[2]); rs.emplace_back(r[1], r[3]); }
    const auto cols = spanGroups(cs, P.cOverlap), rows = spanGroups(rs, P.cOverlap);
    if (cols.size() < P.cMinAxis && rows.size() < P.cMinAxis) return {rects, 0, 0, {}};
    std::vector<int> colOf(grid.size()), rowOf(grid.size());
    for (size_t ci = 0; ci < cols.size(); ++ci) for (int k : cols[ci].members) colOf[k] = static_cast<int>(ci);
    for (size_t ri = 0; ri < rows.size(); ++ri) for (int k : rows[ri].members) rowOf[k] = static_cast<int>(ri);
    const size_t NC = cols.size();
    std::vector<uint8_t> has(NC * rows.size(), 0);
    for (size_t k = 0; k < grid.size(); ++k) has[rowOf[k] * NC + colOf[k]] = 1;
    const auto dist4 = [](const std::array<double, 4>& p, const std::array<double, 4>& q) { return js::hypot({p[0] - q[0], p[1] - q[1], p[2] - q[2], p[3] - q[3]}); };
    const auto wallBeside = [&](const Rect& r) -> std::optional<std::array<double, 4>> {
        const int sw = std::max(2, static_cast<int>(js::round((r[2] - r[0]) * 0.4)));
        std::vector<std::array<double, 4>> walls;
        for (const Rect& s : {Rect{r[0] - sw, r[1], r[0], r[3]}, Rect{r[2], r[1], r[2] + sw, r[3]}}) { const auto l = regionLook(ph, valid, s, &grid); if (l.has) walls.push_back(l.lab); }
        if (walls.empty()) return std::nullopt;
        std::array<double, 4> m{};
        for (int j = 0; j < 4; ++j) { double t = 0; for (const auto& l : walls) t += l[j]; m[j] = t / walls.size(); }
        return m;
    };
    if (!looks.ready) { looks.win.clear(); for (const auto& r : grid) looks.win.push_back(regionLook(ph, valid, r)); looks.ready = true; }
    Completed res;
    res.rects = rects;
    for (size_t ri = 0; ri < rows.size(); ++ri) for (size_t ci = 0; ci < NC; ++ci) {
        if (has[ri * NC + ci]) continue;
        const Rect r{static_cast<int>(js::round(cols[ci].lo)), static_cast<int>(js::round(rows[ri].lo)), static_cast<int>(js::round(cols[ci].hi)), static_cast<int>(js::round(rows[ri].hi))};
        const double cx = (r[0] + r[2]) / 2.0, cy = (r[1] + r[3]) / 2.0;
        if (cx < band[0] || cx >= band[1] || cy < band[2] || cy >= band[3]) continue;
        const double area = static_cast<double>(r[2] - r[0]) * (r[3] - r[1]);
        const auto covered = [&](const Rect& q) { return static_cast<double>(std::max(0, std::min(q[2], r[2]) - std::max(q[0], r[0]))) * std::max(0, std::min(q[3], r[3]) - std::max(q[1], r[1])); };
        if (!(area > 0)) continue;
        bool taken = false;
        for (const auto& q : grid) if (covered(q) > P.cClearShare * area) { taken = true; break; }
        if (!taken) for (const auto& q : res.rects) if (covered(q) > P.cClearShare * area) { taken = true; break; }
        if (taken) continue;
        bool left = false, right = false, above = false, below = false;
        for (size_t c2 = 0; c2 < NC; ++c2) if (has[ri * NC + c2]) { if (c2 < ci) left = true; else right = true; }
        for (size_t r2 = 0; r2 < rows.size(); ++r2) if (has[r2 * NC + ci]) { if (r2 < ri) above = true; else below = true; }
        const bool flankedRow = NC >= P.cMinAxis && left && right, flankedCol = rows.size() >= P.cMinAxis && above && below;
        if (!((flankedRow && (above || below || rows.size() < P.cMinAxis)) || (flankedCol && (left || right || NC < P.cMinAxis)))) continue;
        const auto site = regionLook(ph, valid, r);
        if (!site.has || site.validShare < P.cMinValid) {
            if (left && right && above && below) { res.rects.push_back(r); res.generated.push_back(r); res.added++; }
            continue;
        }
        std::vector<const std::array<double, 4>*> peers;
        for (size_t k = 0; k < grid.size(); ++k) if ((colOf[k] == static_cast<int>(ci) || rowOf[k] == static_cast<int>(ri)) && looks.win[k].has) peers.push_back(&looks.win[k].lab);
        if (peers.empty()) continue;
        std::array<double, 4> peer{};
        for (int j = 0; j < 4; ++j) { double t = 0; for (const auto* l : peers) t += (*l)[j]; peer[j] = t / peers.size(); }
        const auto wall = wallBeside(r);
        if (wall && dist4(site.lab, *wall) <= dist4(site.lab, peer)) { res.stone++; continue; }
        res.rects.push_back(r);
        res.added++;
    }
    sortRects(res.rects);
    return res;
}

/** The fold's two colours (2-means from its darkest and lightest bins) and the glass side. */
struct GlassSplit { std::vector<int> side; std::array<double, 3> glass, other; };
inline std::optional<GlassSplit> glassSplit(const std::vector<std::array<double, 3>>& fold, const Params& P) {
    const auto lum = [](const std::array<double, 3>& c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    std::array<double, 3> A = fold[0], B = fold[0];
    for (size_t i = 1; i < fold.size(); ++i) { if (lum(fold[i]) < lum(A)) A = fold[i]; if (lum(fold[i]) > lum(B)) B = fold[i]; }
    std::vector<int> side(fold.size(), 0);
    for (int it = 0; it < 10; ++it) {
        for (size_t i = 0; i < fold.size(); ++i) {
            const auto& c = fold[i];
            side[i] = js::hypot({c[0] - A[0], c[1] - A[1], c[2] - A[2]}) <= js::hypot({c[0] - B[0], c[1] - B[1], c[2] - B[2]}) ? 0 : 1;
        }
        const auto meanOf = [&](int s) -> std::optional<std::array<double, 3>> {
            std::array<double, 3> m{0, 0, 0};
            int n = 0;
            for (size_t i = 0; i < fold.size(); ++i) if (side[i] == s) { for (int k = 0; k < 3; ++k) m[k] += fold[i][k]; n++; }
            if (!n) return std::nullopt;
            for (auto& v : m) v /= n;
            return m;
        };
        const auto a = meanOf(0), b = meanOf(1);
        if (!a || !b) return std::nullopt;
        A = *a; B = *b;
    }
    if (js::hypot({A[0] - B[0], A[1] - B[1], A[2] - B[2]}) < P.paneContrast) return std::nullopt;
    const auto blue = [](const std::array<double, 3>& c) { return c[2] / std::max(1.0, c[0] + c[1] + c[2]); };
    const int g = std::fabs(blue(A) - blue(B)) > 0.01 ? (blue(A) > blue(B) ? 0 : 1) : lum(A) > lum(B) ? 0 : 1;
    GlassSplit out;
    for (int v : side) out.side.push_back(v == g ? 1 : 0);
    out.glass = g == 0 ? A : B;
    out.other = g == 0 ? B : A;
    return out;
}

struct UnitCells { std::vector<std::optional<std::vector<Rect>>> perStrip; int groups = 0; };

/** A band's strips' panes from their folded unit cell. */
inline UnitCells panesOfUnitCell(const FacadePhoto& ph, const std::vector<uint8_t>& valid, const std::vector<Rect>& strips, const Band& band, double pitchPx, const Params& P) {
    UnitCells res;
    res.perStrip.assign(strips.size(), std::nullopt);
    if (!(pitchPx >= 6)) return res;
    const int W = ph.W, nT = std::max(6, static_cast<int>(js::round(pitchPx))), y0 = band[2];
    const auto width = [&](size_t i) { return strips[i][2] - strips[i][0]; };
    std::vector<int> order(strips.size());
    for (size_t i = 0; i < order.size(); ++i) order[i] = static_cast<int>(i);
    std::stable_sort(order.begin(), order.end(), [&](int a, int b) { return width(a) < width(b); });
    std::vector<std::vector<int>> groups;
    for (int i : order) {
        const double w = width(i);
        std::vector<int>* g = nullptr;
        for (auto& x : groups) if (std::fabs(w / width(x[0]) - 1) <= 0.15) { g = &x; break; }
        if (g) g->push_back(i); else groups.push_back({i});
    }
    for (const auto& g : groups) {
        std::vector<double> ws;
        for (int i : g) ws.push_back(width(i));
        const int nS = std::min(64, std::max(6, static_cast<int>(js::round(median(ws)))));
        std::vector<std::array<double, 4>> sum(static_cast<size_t>(nT) * nS, {0, 0, 0, 0});
        for (int i : g) {
            const auto& s = strips[i];
            const int xa = s[0], ya = s[1], xb = s[2], yb = s[3];
            if (yb - ya < 1.6 * pitchPx || xb - xa < 3) continue;
            for (int y = ya; y < yb; ++y) {
                const int bt = std::min(nT - 1, static_cast<int>(std::floor(std::fmod(std::fmod(static_cast<double>(y - y0), pitchPx) + pitchPx, pitchPx) / pitchPx * nT)));
                for (int x = xa; x < xb; ++x) {
                    const size_t k = static_cast<size_t>(y) * W + x;
                    if (!valid[k]) continue;
                    const int bs = std::min(nS - 1, static_cast<int>(std::floor((static_cast<double>(x - xa) / (xb - xa)) * nS)));
                    auto& cell = sum[static_cast<size_t>(bt) * nS + bs];
                    for (int c = 0; c < 3; ++c) cell[c] += ph.rgba[k * 4 + c];
                    cell[3]++;
                }
            }
        }
        std::vector<std::array<double, 3>> rowsFold;
        for (int t = 0; t < nT; ++t) {
            std::array<double, 4> m{0, 0, 0, 0};
            for (int b = static_cast<int>(std::floor(nS * 0.2)); b < static_cast<int>(std::ceil(nS * 0.8)); ++b) for (int c = 0; c < 4; ++c) m[c] += sum[static_cast<size_t>(t) * nS + b][c];
            if (!m[3]) break;
            rowsFold.push_back({m[0] / m[3], m[1] / m[3], m[2] / m[3]});
        }
        if (static_cast<int>(rowsFold.size()) < nT) continue;
        const auto split = glassSplit(rowsFold, P);
        if (!split) continue;
        int sideSum = 0;
        for (int v : split->side) sideSum += v;
        const double share = static_cast<double>(sideSum) / nT;
        if (share < P.paneShare0 || share > P.paneShare1) continue;
        std::pair<int, int> best{0, 0};
        int runs = 0;
        for (int i = 0; i < nT; ++i) {
            if (!split->side[i] || split->side[(i - 1 + nT) % nT]) continue;
            int n = 0;
            while (n < nT && split->side[(i + n) % nT]) n++;
            if (n >= 2) runs++;
            if (n > best.second) best = {i, n};
        }
        if (!best.second || runs > 1) continue;
        std::vector<Span> glassCols;
        int run = -1;
        for (int b = 0; b <= nS; ++b) {
            bool isGlass = false;
            if (b < nS) {
                std::array<double, 4> m{0, 0, 0, 0};
                for (int t = 0; t < best.second; ++t) for (int c = 0; c < 4; ++c) m[c] += sum[static_cast<size_t>((best.first + t) % nT) * nS + b][c];
                if (m[3]) {
                    const std::array<double, 3> col{m[0] / m[3], m[1] / m[3], m[2] / m[3]};
                    const auto d = [&](const std::array<double, 3>& q) { return js::hypot({col[0] - q[0], col[1] - q[1], col[2] - q[2]}); };
                    isGlass = d(split->glass) <= d(split->other);
                }
            }
            if (isGlass && run < 0) run = b;
            if (!isGlass && run >= 0) { if (b - run >= 2) glassCols.emplace_back(run, b); run = -1; }
        }
        if (glassCols.empty()) continue;
        res.groups++;
        for (int i : g) {
            const auto& s = strips[i];
            const int xa = s[0], ya = s[1], xb = s[2], yb = s[3];
            std::vector<Rect> out;
            const int kFirst = static_cast<int>(std::floor((ya - y0) / pitchPx)) - 1;
            for (int k = kFirst; y0 + k * pitchPx < yb; ++k) {
                const int ty0 = std::max(ya, static_cast<int>(js::round(y0 + k * pitchPx + (static_cast<double>(best.first) / nT) * pitchPx)));
                const int ty1 = std::min(yb, static_cast<int>(js::round(y0 + k * pitchPx + (static_cast<double>(best.first + best.second) / nT) * pitchPx)));
                if (ty1 - ty0 < 2) continue;
                for (auto [a, b] : glassCols) out.push_back({static_cast<int>(js::round(xa + (static_cast<double>(a) / nS) * (xb - xa))), ty0, static_cast<int>(js::round(xa + (static_cast<double>(b) / nS) * (xb - xa))), ty1});
            }
            if (!out.empty()) res.perStrip[i] = std::move(out);
        }
    }
    return res;
}

/** IoU of a rect set's mask (all inside `band`) against `ref`, counted where `where` holds (`shiftAxis` >= 0 rolls the set). */
template <class Where>
inline double maskIou(const std::vector<Rect>& rects, const Band& band, int W, int H, const std::vector<uint8_t>& ref, Where&& where, int shiftAxis = -1, int by = 0) {
    const int x0 = band[0], x1 = band[1], y0 = band[2], y1 = band[3], bw = x1 - x0;
    std::vector<uint8_t> m(static_cast<size_t>(std::max(0, bw)) * std::max(0, y1 - y0), 0);
    for (const auto& r : rects) for (int y = std::max(y0, r[1]); y < std::min(y1, r[3]); ++y) {
        const long s = static_cast<long>(y - y0) * bw + std::max(0, r[0] - x0), e = std::min(static_cast<long>(m.size()), static_cast<long>(y - y0) * bw + std::max(0, std::min(x1, r[2]) - x0));
        if (s < e) std::fill(m.begin() + s, m.begin() + e, 1);
    }
    long i = 0, u = 0;
    for (int y = y0; y < y1; ++y) for (int x = x0; x < x1; ++x) {
        const size_t k = static_cast<size_t>(y) * W + x;
        if (!where(k, x, y)) continue;
        int sx = x, sy = y;
        if (shiftAxis == 1) sx = (((x - by) % W) + W) % W;
        else if (shiftAxis == 0) sy = (((y - by) % H) + H) % H;
        const int a = sx >= x0 && sx < x1 && sy >= y0 && sy < y1 ? m[static_cast<size_t>(sy - y0) * bw + sx - x0] : 0, b = ref[k];
        if (a || b) u++;
        if (a && b) i++;
    }
    return u ? static_cast<double>(i) / u : 0;
}

/** A window cut by a band's edge joined again. */
inline std::vector<Rect> joinAcrossBands(const std::vector<Rect>& rects, const std::vector<Band>& bands) {
    std::set<int> edges;
    for (const auto& b : bands) { edges.insert(b[2]); edges.insert(b[3]); }
    std::vector<std::optional<Rect>> out(rects.begin(), rects.end());
    std::stable_sort(out.begin(), out.end(), [](const auto& a, const auto& b) { return (*a)[1] != (*b)[1] ? (*a)[1] < (*b)[1] : (*a)[0] < (*b)[0]; });
    for (int i = 0; i < static_cast<int>(out.size()); ++i) {
        if (!out[i]) continue;
        const Rect a = *out[i];
        for (int j = 0; j < static_cast<int>(out.size()); ++j) {
            if (!out[j] || j == i) continue;
            const Rect b = *out[j];
            if (b[1] != a[3] || !edges.count(a[3]) || std::abs(a[0] - b[0]) > 2 || std::abs(a[2] - b[2]) > 2) continue;
            out[i] = Rect{std::min(a[0], b[0]), a[1], std::max(a[2], b[2]), b[3]};
            out[j].reset();
            i--;
            break;
        }
    }
    std::vector<Rect> res;
    for (const auto& r : out) if (r) res.push_back(*r);
    return res;
}

inline bool usable(const ReliefGrid* g) { return g && g->foundS && g->foundT && g->cellFoundS && g->cellFoundT; }

enum Kind { Cells, Strips, NestedCells, NestedStrips, PierCells, PierStrips };
constexpr const char* kKindNames[6] = {"cells", "strips", "nested-cells", "nested-strips", "pier-cells", "pier-strips"};
inline bool isStrips(int k) { return k == Strips || k == NestedStrips || k == PierStrips; }

inline std::string rectsJson(const std::vector<Rect>& rs) {
    std::string s = "[";
    for (size_t i = 0; i < rs.size(); ++i) {
        s += i ? ",[" : "[";
        s += std::to_string(rs[i][0]) + "," + std::to_string(rs[i][1]) + "," + std::to_string(rs[i][2]) + "," + std::to_string(rs[i][3]) + "]";
    }
    return s + "]";
}
inline std::string quoted(const std::string& s) { return "\"" + s + "\""; }

}  // namespace detail

/**
 * Fits one facade's windows (window-fit.ts fitFacadeWindows, its relief read here). `pool` runs the relief's readings of
 * the facade side by side (each held-out fold and band its own reading); null reads them in turn.
 */
inline FitResult fitFacadeWindows(const FacadePhoto& ph, const Params& P, FixedThreadPool* pool = nullptr) {
    using namespace detail;
    const int W = ph.W, H = ph.H;
    const double px = ph.pixel;
    Darkness dk;
    std::vector<uint8_t> valid;
    darknessOf(ph, dk, valid);
    Ctx c{&ph, &dk, &valid, P, {}};
    auto dark = otsuMask(dk, valid);
    lateralEvidence(dk, valid, dark, px, P);
    // bands: change points of the darkness along the wall (columns as vectors of 1 m row sums), then up it within each
    const auto colMean = dk.colMeans(0, W, 0, H);
    double gps = autocorrPitch(colMean, px, P.pitchS0, P.pitchS1, P);
    if (!(gps != 0) || std::isnan(gps)) gps = 6.0;
    const int rb = std::max(1, static_cast<int>(std::trunc(1.0 / px))), nR = static_cast<int>(std::ceil(static_cast<double>(H) / rb));
    const auto z = [](double v) { return v == v ? v : 0.0; };
    Rows colvec(W, std::vector<double>(nR, 0.0));
    for (int x = 0; x < W; ++x) for (int y = 0; y < H; ++y) colvec[x][y / rb] += z(dk.at(x, y)) / rb;
    std::vector<Band> bands;
    const auto colSmooth = smoothAlong(colvec, gps / px);
    for (auto [a0, a1] : segments(colSmooth, 0, colSmooth.size(), static_cast<int>(std::trunc(P.minBandSM / px)), P.splitGain)) {
        const int nC = static_cast<int>(std::ceil(static_cast<double>(a1 - a0) / rb));
        Rows rowvec(H, std::vector<double>(nC, 0.0));
        for (int y = 0; y < H; ++y) for (int x = a0; x < a1; ++x) rowvec[y][(x - a0) / rb] += z(dk.at(x, y)) / rb;
        const auto rowSmooth = smoothAlong(rowvec, 4.0 / px);
        for (auto [b0, b1] : segments(rowSmooth, 0, rowSmooth.size(), static_cast<int>(std::trunc(P.minBandTM / px)), P.splitGain)) {
            long n = 0;
            for (int y = b0; y < b1; ++y) for (int x = a0; x < a1; ++x) n += valid[static_cast<size_t>(y) * W + x];
            if (static_cast<double>(n) / (static_cast<double>(b1 - b0) * (a1 - a0)) >= 0.3) bands.push_back({a0, a1, b0, b1});
        }
    }
    FitResult res;
    if (bands.empty()) return res;
    // the relief: the whole facade and each band, then the same with each held-out half hidden
    const int span = std::max(4, static_cast<int>(std::trunc(P.heldOutSpanM / px)));
    struct FoldSpec { char hide; int parity; };
    const FoldSpec foldSpecs[4] = {{'s', 0}, {'s', 1}, {'t', 0}, {'t', 1}};
    std::vector<Band> all{{0, W, 0, H}};
    all.insert(all.end(), bands.begin(), bands.end());
    std::vector<std::vector<ReliefGrid>> reads(5, std::vector<ReliefGrid>(all.size()));
    // the readings largest first, so the longest is not the last to start (each writes only its own result)
    std::vector<size_t> jobs(5 * all.size());
    for (size_t j = 0; j < jobs.size(); ++j) jobs[j] = j;
    const auto area = [&](size_t j) { const auto& b = all[j % all.size()]; return static_cast<long>(b[1] - b[0]) * (b[3] - b[2]); };
    std::stable_sort(jobs.begin(), jobs.end(), [&](size_t x, size_t y) { return area(x) > area(y); });
    const auto readOne = [&](size_t at) {
        const size_t job = jobs[at], cfg = job / all.size(), b = job % all.size();
        const char hide = cfg == 0 ? '-' : foldSpecs[cfg - 1].hide;
        const int parity = cfg == 0 ? 0 : foldSpecs[cfg - 1].parity;
        reads[cfg][b] = detail::relief(ph, hide, span, parity, {all[b]})[0];
    };
    if (pool) pool->forEach(5 * all.size(), readOne);
    else for (size_t j = 0; j < 5 * all.size(); ++j) readOne(j);
    const ReliefGrid* whole = &reads[0][0];
    const auto gridOf = [&](size_t bi) -> const ReliefGrid* { return &reads[0][1 + bi]; };
    const auto foldGrid = [&](int fi, size_t k) -> const ReliefGrid* { return &reads[1 + fi][k]; };
    const auto hiddenOf = [&](const FoldSpec& s, size_t k) { const int x = static_cast<int>(k % W), y = static_cast<int>(k / W); return s.hide == 's' ? (x / span) % 2 == s.parity : (y / span) % 2 == s.parity; };
    const auto build = [&](int kind, const ReliefGrid& g, const Band& band) -> std::vector<Rect> {
        const int ptPx = g.foundT ? static_cast<int>(js::pyRound(g.pitchT / px)) : 0;
        if (kind == PierCells) return refineCells(c, pierCellsLayout(c, g, band), band);
        if (kind == PierStrips) { std::vector<Rect> s; for (auto [a, b] : pierColumns(c, g, band)) s.push_back({a, band[2], b, band[3]}); return refineStrips(c, s, band, ptPx); }
        if (kind == Cells || kind == NestedCells) return rephaseColumns(c, refineCells(c, cellsLayout(c, g, band, kind == NestedCells), band), band);
        return refineStrips(c, rephaseColumns(c, stripsLayout(c, g, band, kind == NestedStrips), band), band, ptPx);
    };
    struct Pick { int kind; std::vector<Rect> rects; std::array<double, 6> sc; };
    struct Accepted { Band band; int kind; std::vector<Rect> chosen; ReliefGrid g; size_t info; };
    std::vector<Accepted> accepted, pending;
    int poolJudged = 0;
    double poolMargin = 0;
    std::vector<OrderedObject>& report = res.bands;
    std::vector<Rect> generatedRects;
    for (size_t bi = 0; bi < bands.size(); ++bi) {
        const Band band = bands[bi];
        const ReliefGrid* own = gridOf(bi);
        const auto inBand = [&](size_t k, int, int) { return valid[k] != 0; };
        const auto bestOf = [&](const ReliefGrid* g) -> std::optional<Pick> {
            if (!usable(g)) return std::nullopt;
            Pick p{0, {}, {}};
            std::array<std::vector<Rect>, 6> cand;
            for (int k = 0; k < 6; ++k) { cand[k] = build(k, *g, band); p.sc[k] = maskIou(cand[k], band, W, H, dark, inBand); }
            for (int k = 0; k < 6; ++k) if (p.sc[k] > p.sc[p.kind]) p.kind = k;
            p.rects = cand[p.kind];
            return p;
        };
        const auto fw = bestOf(whole), bo = bestOf(own);
        bool srcFacade = fw.has_value();
        std::optional<Pick> pick = fw ? fw : bo;
        size_t gi = bi;
        if (fw && bo && *std::max_element(bo->sc.begin(), bo->sc.end()) > P.clearlyBetter * *std::max_element(fw->sc.begin(), fw->sc.end())) { srcFacade = false; pick = bo; }
        report.emplace_back();
        const size_t ii = report.size() - 1;
        report[ii].set("band", "[" + std::to_string(band[0]) + "," + std::to_string(band[1]) + "," + std::to_string(band[2]) + "," + std::to_string(band[3]) + "]");
        report[ii].set("accepted", "false");
        if (!pick) {
            const double mid = (band[2] + band[3]) / 2.0;
            std::vector<size_t> order;
            for (size_t j = 0; j < bands.size(); ++j) if (j != bi && usable(gridOf(j))) order.push_back(j);
            std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return std::fabs((bands[a][2] + bands[a][3]) / 2.0 - mid) < std::fabs((bands[b][2] + bands[b][3]) / 2.0 - mid); });
            for (size_t j : order) { auto bb = bestOf(gridOf(j)); if (bb) { pick = bb; srcFacade = false; gi = j; report[ii].set("borrowedFrom", std::to_string(j)); break; } }
        }
        if (!pick) {
            const double tPitch = own->foundT ? own->pitchT : whole->foundT ? whole->pitchT : 0;
            const auto col = (band[1] - band[0]) * px <= P.nMaxWidthM && tPitch > 0 ? storeyColumn(c, band, tPitch) : std::nullopt;
            if (!col) { report[ii].set("why", quoted("no grid")); continue; }
            report[ii].set("accepted", "true");
            report[ii].set("grid", quoted("column"));
            report[ii].set("kind", quoted("cells"));
            report[ii].set("storeys", quoted(std::to_string(col->rects.size()) + "/" + std::to_string(col->storeys)));
            ReliefGrid gCol;
            gCol.band = band; gCol.foundT = true; gCol.pitchT = tPitch; gCol.cellFoundT = true;
            accepted.push_back({band, Cells, col->rects, gCol, ii});
            continue;
        }
        std::vector<Rect> chosen = pick->rects;
        const int kind = pick->kind;
        const auto& sc = pick->sc;
        // a storey that does not repeat the band's storeys (a ground floor, a shopfront, signage) gets no openings
        int droppedRows = 0;
        if (!isStrips(kind) && !chosen.empty()) {
            std::vector<Span> rows;
            std::set<Span> seen;
            for (const auto& r : chosen) if (seen.insert({r[1], r[3]}).second) rows.push_back({r[1], r[3]});
            if (rows.size() >= 3) {
                std::vector<std::vector<double>> prof;
                for (auto [a, b] : rows) { auto p = dk.colMeans(band[0], band[1], a, b); for (double& v : p) if (!std::isfinite(v)) v = 0; prof.push_back(std::move(p)); }
                std::vector<double> med(prof[0].size()), colv(prof.size());
                for (size_t i = 0; i < med.size(); ++i) { for (size_t s = 0; s < prof.size(); ++s) colv[s] = prof[s][i]; med[i] = median(colv); }
                std::set<Span> keep;
                for (size_t i = 0; i < rows.size(); ++i) if (ncc(prof[i], med) >= P.rowNcc) keep.insert(rows[i]);
                droppedRows = static_cast<int>(rows.size() - keep.size());
                std::vector<Rect> kept;
                for (const auto& r : chosen) if (keep.count({r[1], r[3]})) kept.push_back(r);
                chosen.swap(kept);
            }
        }
        const ReliefGrid& g = srcFacade ? *whole : *gridOf(gi);
        report[ii].set("grid", quoted(srcFacade ? "facade" : "band"));
        report[ii].set("kind", quoted(kKindNames[kind]));
        report[ii].set("droppedRows", std::to_string(droppedRows));
        {
            std::string s = "{";
            for (int k = 0; k < 6; ++k) s += (k ? ",\"" : "\"") + std::string(kKindNames[k]) + "\":" + js::num(js::round3(sc[k]));
            report[ii].set("scores", s + "}");
        }
        // a band of one storey has nothing to repeat in up the wall
        if ((band[3] - band[2]) * px < P.storeysMin * g.pitchT * 0.9) { report[ii].set("why", quoted("one storey: no lattice to repeat")); continue; }
        // the gate: the reading on each fold beats itself shifted half a pitch on the fold's hidden part, summed over the folds
        int wins = 0, judged = 0;
        double margin = 0;
        long bandValid = 0;
        for (int y = band[2]; y < band[3]; ++y) for (int x = band[0]; x < band[1]; ++x) bandValid += valid[static_cast<size_t>(y) * W + x];
        for (int fi = 0; fi < 4; ++fi) {
            const auto& spec = foldSpecs[fi];
            const ReliefGrid* g2 = srcFacade ? foldGrid(fi, 0) : foldGrid(fi, 1 + gi);
            if (!usable(g2)) continue;
            const auto where = [&](size_t k, int, int) { return valid[k] && hiddenOf(spec, k); };
            long hv = 0;
            for (int y = band[2]; y < band[3]; ++y) for (int x = band[0]; x < band[1]; ++x) { const size_t k = static_cast<size_t>(y) * W + x; if (where(k, x, y)) hv++; }
            if (hv < 0.2 * bandValid) continue;
            const auto pred = build(kind, *g2, band);
            const int by = spec.hide == 's' ? static_cast<int>(js::pyRound(g2->pitchS / px / 2)) : static_cast<int>(js::pyRound(g2->pitchT / px / 2));
            const double ip = maskIou(pred, band, W, H, dark, where), ic = maskIou(pred, band, W, H, dark, where, spec.hide == 's' ? 1 : 0, by);
            judged++;
            if (ip > ic) wins++;
            margin += ip - ic;
        }
        report[ii].set("heldOut", quoted(std::to_string(wins) + "/" + std::to_string(judged)));
        report[ii].set("margin", js::num(js::round3(margin)));
        const bool scored = *std::max_element(sc.begin(), sc.end()) > P.minScore;
        if (srcFacade) { poolJudged += judged; poolMargin += margin; }
        const bool ok = scored && judged >= 2 && margin > 0;
        report[ii].set("accepted", ok ? "true" : "false");
        if (isStrips(kind)) {
            auto s = splitBays(c, chosen);
            chosen = std::move(s.rects);
            report[ii].set("subPitch", quoted(std::to_string(s.found) + "/" + std::to_string(s.bays)));
        }
        if (!ok) {
            report[ii].set("why", quoted("held-out folds"));
            // a band too small to be judged on two folds waits for the facade's bands pooled
            if (scored && srcFacade && judged >= 1 && judged < 2 && margin > 0) pending.push_back({band, kind, chosen, g, ii});
            continue;
        }
        accepted.push_back({band, kind, chosen, g, ii});
    }
    // the bands too small to be judged alone: accepted when the facade's bands read on its grid pass together
    if (poolJudged >= 2 && poolMargin > 0) for (auto& p : pending) {
        auto& info = report[p.info];
        info.set("accepted", "true");
        info.erase("why");
        const std::string held = *info.get("heldOut");
        info.set("heldOut", held.substr(0, held.size() - 1) + " (pooled " + std::to_string(poolJudged) + " folds, margin " + js::str(js::round3(poolMargin)) + ")\"");
        accepted.push_back(p);
    }
    // the lattice completed from the facade's repeats (every accepted band's windows the grid)
    std::vector<Rect> grid;
    for (const auto& a : accepted) grid.insert(grid.end(), a.chosen.begin(), a.chosen.end());
    GridLooks looks;
    std::vector<Rect> rects;
    for (const auto& a : accepted) {
        auto& info = report[a.info];
        auto done = completeLattice(ph, valid, a.chosen, a.band, P, grid, looks);
        const auto& chosen = done.rects;
        info.set("completed", std::to_string(done.added));
        info.set("stone", std::to_string(done.stone));
        if (!done.generated.empty()) { info.set("generated", std::to_string(done.generated.size())); generatedRects.insert(generatedRects.end(), done.generated.begin(), done.generated.end()); }
        rects.insert(rects.end(), chosen.begin(), chosen.end());
        // the glass in them, kept only where it reads unlike the stone beside it: a punched window is its own pane; a band's
        // strips take their panes from their folded unit cell, a strip it cannot read none
        std::vector<Rect> cand;
        if (!isStrips(a.kind)) cand = chosen;
        else {
            const double pitchPx = a.g.foundT ? a.g.pitchT / px : 0;
            const auto unit = panesOfUnitCell(ph, valid, chosen, a.band, pitchPx, P);
            int readStrips = 0;
            for (const auto& ps : unit.perStrip) if (ps) { readStrips++; cand.insert(cand.end(), ps->begin(), ps->end()); }
            info.set("panes", quoted(std::to_string(readStrips) + "/" + std::to_string(chosen.size()) + " strips (" + std::to_string(unit.groups) + " unit cells)"));
        }
        std::vector<Rect> windows = grid;
        windows.insert(windows.end(), chosen.begin(), chosen.end());
        const auto glass = panesUnlikeWall(ph, valid, cand, windows, a.band, P);
        res.panes.insert(res.panes.end(), glass.first.begin(), glass.first.end());
        info.set("panesDropped", std::to_string(glass.second));
    }
    res.rects = joinAcrossBands(rects, bands);
    res.generated = std::move(generatedRects);
    return res;
}

/** One facade's fit as the line window-fit-native.ts reads: its slot, the windows, panes, generated windows and band report. */
inline std::string fitJson(int slot, const FitResult& r, double ms) {
    std::string s = "{\"slot\":" + std::to_string(slot) + ",\"ms\":" + std::to_string(static_cast<long>(ms)) + ",\"rects\":" + detail::rectsJson(r.rects) + ",\"panes\":" + detail::rectsJson(r.panes);
    if (!r.generated.empty()) s += ",\"generated\":" + detail::rectsJson(r.generated);
    s += ",\"bands\":[";
    for (size_t i = 0; i < r.bands.size(); ++i) s += (i ? "," : "") + r.bands[i].json();
    return s + "]}";
}

}  // namespace window_fit
}  // namespace scratchbox
