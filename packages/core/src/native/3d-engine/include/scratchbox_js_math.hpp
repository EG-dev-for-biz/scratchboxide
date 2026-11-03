/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_JS_MATH_HPP
#define SCRATCHBOX_JS_MATH_HPP

/**
 * JavaScript's number arithmetic, value for value, for the native ports that must give their TypeScript's result bit for
 * bit (pipeline K's kernels: scratchbox_ortho_rectify.hpp, scratchbox_material_regions.hpp, scratchbox_twin_texels.hpp,
 * scratchbox_window_fit.hpp, scratchbox_open_loop_fill.hpp). One copy, so a fix reaches every kernel.
 *
 *  - round: Math.round (the spec's: ceil, minus one when that overshoots by more than a half; -0 kept; not
 *    floor(x + 0.5), which differs at 0.49999999999999994);
 *  - min, max, sign: Math.min / Math.max of two and Math.sign, NaN propagating, -0 below +0;
 *  - toUint32, toInt32, toUint8, toInt16: the conversions of typed-array stores (modular; NaN and infinities to 0);
 *  - hypot: V8's Math.hypot (builtins/math.tq MathHypot: over the largest, squares summed with Kahan compensation);
 *  - log, exp, cbrt: V8's fdlibm ports (src/base/ieee754.cc). V8 is compiled by clang with contraction on: on arm64 its
 *    multiply-adds fuse, on x86-64 (no FMA in its target) none can. These ports fuse where it does. Measured against
 *    Node 20 and 22 on arm64 over 3 million arguments: 0 differ, where macOS's libm differs on 4-9% of them and the same
 *    ports unfused on 0.1-0.9% (cbrt agrees either way). GCC ignores the clang pragmas; build these kernels with clang.
 *  - pow is not ported. Where a pow decides a stored value, the caller works the values out in JavaScript and sends
 *    them: a table over the 8-bit codes, or the 8-bit sRGB encoder's thresholds (Srgb8Encoder). Nor are sin and cos:
 *    the few angles a kernel turns by are sent the same way.
 *  - toString: String(n), the shortest digits that read back as n, in JavaScript's layout;
 *  - sort: Array.prototype.sort with a comparator, as V8 12.4 (Node 22) runs it (third_party/v8/builtins/array-sort.tq,
 *    TimSort). Stable, so any stable sort gives its order for a consistent comparator; it is needed where the comparator
 *    is not, as (x, y) => x - y over values holding NaN: the comparator's NaN is read as 0 (equal), and the order such a
 *    relation leaves only V8's own steps decide. Newer V8 sorts by PowerSort; js-math-native.test.ts holds this to the
 *    running V8.
 *
 * Everything outside log, exp and cbrt must be compiled with contraction off, as V8's generated code never fuses a
 * multiply and an add: each kernel says so for its own code (the pragma after its includes, or -ffp-contract=off).
 */

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#if defined(__clang__) && defined(__aarch64__)
#define SCRATCHBOX_JS_V8_CONTRACT _Pragma("clang fp contract(on)")
#elif defined(__clang__)
#define SCRATCHBOX_JS_V8_CONTRACT _Pragma("clang fp contract(off)")
#else
#define SCRATCHBOX_JS_V8_CONTRACT
#endif
#if defined(__clang__)
#define SCRATCHBOX_JS_NO_CONTRACT _Pragma("clang fp contract(off)")
#else
#define SCRATCHBOX_JS_NO_CONTRACT
#endif

namespace scratchbox {
namespace js {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

/** Math.round. */
inline double round(double x) {
    if (!std::isfinite(x)) return x;
    const double r = std::ceil(x);
    return r - 0.5 > x ? r - 1.0 : r;
}
/** Math.min / Math.max of two (NaN wins; -0 below +0); Math.sign. */
inline double min(double a, double b) { if (std::isnan(a) || std::isnan(b)) return kNaN; if (a == 0 && b == 0) return std::signbit(a) ? a : b; return a < b ? a : b; }
inline double max(double a, double b) { if (std::isnan(a) || std::isnan(b)) return kNaN; if (a == 0 && b == 0) return std::signbit(a) ? b : a; return a > b ? a : b; }
inline double sign(double x) { if (std::isnan(x)) return kNaN; return x > 0 ? 1.0 : x < 0 ? -1.0 : x; }

/** ToUint32; ToInt32; a Uint8Array store (ToUint8); an Int16Array store (ToInt16). */
inline uint32_t toUint32(double x) {
    if (!std::isfinite(x)) return 0;
    double m = std::fmod(std::trunc(x), 4294967296.0);
    if (m < 0) m += 4294967296.0;
    return static_cast<uint32_t>(m);
}
inline int32_t toInt32(double x) { return static_cast<int32_t>(toUint32(x)); }
inline uint8_t toUint8(double x) { return static_cast<uint8_t>(toUint32(x) & 0xffu); }
inline int16_t toInt16(double x) { return static_cast<int16_t>(static_cast<uint16_t>(toUint32(x) & 0xffffu)); }

/** Math.hypot. */
inline double hypot(std::initializer_list<double> xs) {
    SCRATCHBOX_JS_NO_CONTRACT
    double mx = 0;
    bool nan = false;
    for (double v : xs) { if (std::isnan(v)) nan = true; else if (std::fabs(v) > mx) mx = std::fabs(v); }
    if (mx == kInf) return kInf;
    if (nan) return kNaN;
    if (mx == 0) return 0;
    double sum = 0, compensation = 0;
    for (double v : xs) {
        const double n = std::fabs(v) / mx, summand = n * n - compensation, preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    return std::sqrt(sum) * mx;
}

namespace detail {
inline uint32_t hiWord(double x) { uint64_t b; std::memcpy(&b, &x, 8); return static_cast<uint32_t>(b >> 32); }
inline uint32_t loWord(double x) { uint64_t b; std::memcpy(&b, &x, 8); return static_cast<uint32_t>(b); }
inline double withHi(double x, uint32_t h) { uint64_t b; std::memcpy(&b, &x, 8); b = (b & 0xffffffffull) | (static_cast<uint64_t>(h) << 32); std::memcpy(&x, &b, 8); return x; }
inline double fromWords(uint32_t hi, uint32_t lo) { const uint64_t b = (static_cast<uint64_t>(hi) << 32) | lo; double d; std::memcpy(&d, &b, 8); return d; }
} // namespace detail

/** Math.log: V8's ieee754::log (fdlibm e_log.c). */
inline double log(double x) {
    SCRATCHBOX_JS_V8_CONTRACT
    using namespace detail;
    const double ln2_hi = 6.93147180369123816490e-01, ln2_lo = 1.90821492927058770002e-10, two54 = 1.80143985094819840000e+16;
    const double Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01, Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01;
    const double Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01, Lg7 = 1.479819860511658591e-01;
    double hfsq, f, s, z, R, w, t1, t2, dk;
    int32_t k = 0, hx = static_cast<int32_t>(hiWord(x)), i, j;
    const uint32_t lx = loWord(x);
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | static_cast<int32_t>(lx)) == 0) return -kInf;
        if (hx < 0) return kNaN;
        k -= 54; x *= two54; hx = static_cast<int32_t>(hiWord(x));
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = withHi(x, static_cast<uint32_t>(hx | (i ^ 0x3ff00000)));
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) {
        if (f == 0.0) { if (k == 0) return 0.0; dk = static_cast<double>(k); return dk * ln2_hi + dk * ln2_lo; }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k == 0) return f - R;
        dk = static_cast<double>(k);
        return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
    s = f / (2.0 + f); dk = static_cast<double>(k); z = s * s; i = hx - 0x6147a; w = z * z; j = 0x6b851 - hx;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6)); t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7))); i |= j; R = t2 + t1;
    if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k == 0) return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
    }
    if (k == 0) return f - s * (f - R);
    return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

/** Math.exp: V8's ieee754::exp (fdlibm e_exp.c, with V8's exact exp(1)). */
inline double exp(double x) {
    SCRATCHBOX_JS_V8_CONTRACT
    using namespace detail;
    const double halF[2] = {0.5, -0.5}, huge = 1.0e+300, twom1000 = 9.33263618503218878990e-302;
    const double o_threshold = 7.09782712893383973096e+02, u_threshold = -7.45133219101941108420e+02;
    const double ln2HI[2] = {6.93147180369123816490e-01, -6.93147180369123816490e-01}, ln2LO[2] = {1.90821492927058770002e-10, -1.90821492927058770002e-10};
    const double invln2 = 1.44269504088896338700e+00, E = 2.718281828459045;
    const double P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
    double y, hi = 0, lo = 0, c, t;
    int32_t k = 0;
    uint32_t hx = hiWord(x);
    const int32_t xsb = static_cast<int32_t>((hx >> 31) & 1);
    hx &= 0x7fffffff;
    if (hx >= 0x40862E42) {
        if (hx >= 0x7ff00000) { if (((hx & 0xfffff) | loWord(x)) != 0) return x + x; return xsb == 0 ? x : 0.0; }
        if (x > o_threshold) return kInf;
        if (x < u_threshold) return 0.0;
    }
    if (hx > 0x3fd62e42) {
        if (hx < 0x3FF0A2B2) {
            if (x == 1.0) return E;
            hi = x - ln2HI[xsb]; lo = ln2LO[xsb]; k = 1 - xsb - xsb;
        } else {
            k = static_cast<int32_t>(invln2 * x + halF[xsb]);
            t = k;
            hi = x - t * ln2HI[0];
            lo = t * ln2LO[0];
        }
        x = hi - lo;
    } else if (hx < 0x3e300000) {
        if (huge + x > 1.0) return 1.0 + x;
    } else {
        k = 0;
    }
    t = x * x;
    c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k == 0) return 1.0 - ((x * c) / (c - 2.0) - x);
    y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if (k >= -1021) return withHi(y, hiWord(y) + (static_cast<uint32_t>(k) << 20));
    y = withHi(y, hiWord(y) + (static_cast<uint32_t>(k + 1000) << 20));
    return y * twom1000;
}

/** Math.cbrt: V8's ieee754::cbrt (fdlibm s_cbrt.c). */
inline double cbrt(double x) {
    SCRATCHBOX_JS_V8_CONTRACT
    using namespace detail;
    const uint32_t B1 = 715094163, B2 = 696219795;
    const double P0 = 1.87595182427177009643, P1 = -1.88497979543377169875, P2 = 1.621429720105354466140, P3 = -0.758397934778766047437, P4 = 0.145996192886612446982;
    uint32_t hx = hiWord(x);
    const uint32_t low = loWord(x), sign = hx & 0x80000000u;
    hx ^= sign;
    if (hx >= 0x7ff00000u) return x + x;
    double t = 0.0;
    if (hx < 0x00100000u) {
        if ((hx | low) == 0) return x;
        t = fromWords(0x43500000u, 0);
        t *= x;
        t = fromWords(sign | ((hiWord(t) & 0x7fffffffu) / 3 + B2), 0);
    } else {
        t = fromWords(sign | (hx / 3 + B1), 0);
    }
    double r = (t * t) * (t / x);
    t = t * ((P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4));
    uint64_t ub;
    std::memcpy(&ub, &t, 8);
    ub = (ub + 0x80000000ull) & 0xffffffffc0000000ull;
    std::memcpy(&t, &ub, 8);
    const double s = t * t;
    r = x / s;
    const double w = t + t;
    r = (r - t) / (w + r);
    return t + t * r;
}

/**
 * 8-bit sRGB from linear light, as Math.round(linearToSrgb255(x)) gives it: the code is how many of the 255 thresholds
 * the value reaches, threshold k - 1 being the least linear value whose code is at least k, found by the caller in
 * JavaScript (twin-texels-native.ts srgb8Thresholds). The pow in the curve is V8's, through the thresholds.
 */
struct Srgb8Encoder {
    double t[255];
    uint8_t encode(double x) const {
        int lo = 0, hi = 255;
        while (lo < hi) {
            const int mid = (lo + hi) >> 1;
            if (t[mid] <= x) lo = mid + 1; else hi = mid;
        }
        return static_cast<uint8_t>(lo);
    }
};

/** String(n): the shortest round-trip digits (std::to_chars) in Number::toString's layout. */
inline std::string toString(double v) {
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

namespace detail {

/** V8 12.4's TimSort (array-sort.tq), step for step; `cmp(a, b)` is the comparator's number, NaN allowed. */
template <class T, class Cmp>
class TimSort {
public:
    TimSort(std::vector<T>& a, Cmp& cmp) : w_(a), cmp_(cmp) {}

    void run() {
        const int length = static_cast<int>(w_.size());
        if (length < 2) return;
        int remaining = length, low = 0;
        const int minRun = minRunLength(remaining);
        while (remaining != 0) {
            int current = countAndMakeRun(low, low + remaining);
            if (current < minRun) {
                const int forced = std::min(minRun, remaining);
                binaryInsertionSort(low, low + current, low + forced);
                current = forced;
            }
            runs_.push_back({low, current});
            mergeCollapse();
            low += current;
            remaining -= current;
        }
        mergeForceCollapse();
    }

private:
    static constexpr int kMinGallopWins = 7;
    std::vector<T>& w_;
    Cmp& cmp_;
    std::vector<std::pair<int, int>> runs_;
    std::vector<T> tmp_;
    int minGallop_ = kMinGallopWins;

    // SortCompareUserFn: the comparator's number, NaN read as +0
    double compare(const T& a, const T& b) { const double v = static_cast<double>(cmp_(a, b)); return std::isnan(v) ? 0.0 : v; }

    static int minRunLength(int n) {
        int r = 0;
        while (n >= 64) { r |= n & 1; n >>= 1; }
        return n + r;
    }

    void binaryInsertionSort(int low, int startArg, int high) {
        for (int start = low == startArg ? startArg + 1 : startArg; start < high; ++start) {
            int left = low, right = start;
            T pivot = w_[start];
            while (left < right) {
                const int mid = left + ((right - left) >> 1);
                if (compare(pivot, w_[mid]) < 0) right = mid; else left = mid + 1;
            }
            for (int p = start; p > left; --p) w_[p] = w_[p - 1];
            w_[left] = pivot;
        }
    }

    int countAndMakeRun(int lowArg, int high) {
        const int low = lowArg + 1;
        if (low == high) return 1;
        int runLength = 2;
        double order = compare(w_[low], w_[low - 1]);
        const bool descending = order < 0;
        int previous = low;
        for (int idx = low + 1; idx < high; ++idx) {
            order = compare(w_[idx], w_[previous]);
            if (descending) { if (order >= 0) break; }
            else { if (order < 0) break; }
            previous = idx;
            ++runLength;
        }
        if (descending) std::reverse(w_.begin() + lowArg, w_.begin() + lowArg + runLength);
        return runLength;
    }

    static bool invariant(const std::vector<std::pair<int, int>>& r, int n) {
        if (n < 2) return true;
        return r[n - 2].second > r[n - 1].second + r[n].second;
    }

    void mergeCollapse() {
        while (runs_.size() > 1) {
            int n = static_cast<int>(runs_.size()) - 2;
            if (!invariant(runs_, n + 1) || !invariant(runs_, n)) {
                if (runs_[n - 1].second < runs_[n + 1].second) --n;
                mergeAt(n);
            } else if (runs_[n].second <= runs_[n + 1].second) {
                mergeAt(n);
            } else {
                break;
            }
        }
    }

    void mergeForceCollapse() {
        while (runs_.size() > 1) {
            int n = static_cast<int>(runs_.size()) - 2;
            if (n > 0 && runs_[n - 1].second < runs_[n + 1].second) --n;
            mergeAt(n);
        }
    }

    // GallopLeft and GallopRight over `a` (the work array or the temp array)
    int gallopLeft(const std::vector<T>& a, const T& key, int base, int length, int hint) {
        int lastOfs = 0, offset = 1;
        double order = compare(a[base + hint], key);
        if (order < 0) {
            const int maxOfs = length - hint;
            while (offset < maxOfs) {
                order = compare(a[base + hint + offset], key);
                if (order >= 0) break;
                lastOfs = offset;
                offset = (offset << 1) + 1;
                if (offset <= 0) offset = maxOfs;
            }
            if (offset > maxOfs) offset = maxOfs;
            lastOfs += hint;
            offset += hint;
        } else {
            const int maxOfs = hint + 1;
            while (offset < maxOfs) {
                order = compare(a[base + hint - offset], key);
                if (order < 0) break;
                lastOfs = offset;
                offset = (offset << 1) + 1;
                if (offset <= 0) offset = maxOfs;
            }
            if (offset > maxOfs) offset = maxOfs;
            const int t = lastOfs;
            lastOfs = hint - offset;
            offset = hint - t;
        }
        ++lastOfs;
        while (lastOfs < offset) {
            const int m = lastOfs + ((offset - lastOfs) >> 1);
            if (compare(a[base + m], key) < 0) lastOfs = m + 1; else offset = m;
        }
        return offset;
    }

    int gallopRight(const std::vector<T>& a, const T& key, int base, int length, int hint) {
        int lastOfs = 0, offset = 1;
        double order = compare(key, a[base + hint]);
        if (order < 0) {
            const int maxOfs = hint + 1;
            while (offset < maxOfs) {
                order = compare(key, a[base + hint - offset]);
                if (order >= 0) break;
                lastOfs = offset;
                offset = (offset << 1) + 1;
                if (offset <= 0) offset = maxOfs;
            }
            if (offset > maxOfs) offset = maxOfs;
            const int t = lastOfs;
            lastOfs = hint - offset;
            offset = hint - t;
        } else {
            const int maxOfs = length - hint;
            while (offset < maxOfs) {
                order = compare(key, a[base + hint + offset]);
                if (order < 0) break;
                lastOfs = offset;
                offset = (offset << 1) + 1;
                if (offset <= 0) offset = maxOfs;
            }
            if (offset > maxOfs) offset = maxOfs;
            lastOfs += hint;
            offset += hint;
        }
        ++lastOfs;
        while (lastOfs < offset) {
            const int m = lastOfs + ((offset - lastOfs) >> 1);
            if (compare(key, a[base + m]) < 0) offset = m; else lastOfs = m + 1;
        }
        return offset;
    }

    void mergeAt(int i) {
        int baseA = runs_[i].first, lengthA = runs_[i].second;
        const int baseB = runs_[i + 1].first;
        int lengthB = runs_[i + 1].second;
        runs_[i].second = lengthA + lengthB;
        runs_.erase(runs_.begin() + i + 1);
        const T keyRight = w_[baseB];
        const int k = gallopRight(w_, keyRight, baseA, lengthA, 0);
        baseA += k;
        lengthA -= k;
        if (lengthA == 0) return;
        const T keyLeft = w_[baseA + lengthA - 1];
        lengthB = gallopLeft(w_, keyLeft, baseB, lengthB, lengthB - 1);
        if (lengthB == 0) return;
        if (lengthA <= lengthB) mergeLow(baseA, lengthA, baseB, lengthB);
        else mergeHigh(baseA, lengthA, baseB, lengthB);
    }

    void mergeLow(int baseA, int lengthA, int baseB, int lengthB) {
        tmp_.assign(w_.begin() + baseA, w_.begin() + baseA + lengthA);
        int dest = baseA, cursorTemp = 0, cursorB = baseB;
        w_[dest++] = w_[cursorB++];
        enum { kRun, kSucceed, kCopyB } exit = kRun;
        if (--lengthB == 0) exit = kSucceed;
        else if (lengthA == 1) exit = kCopyB;
        int minGallop = minGallop_;
        while (exit == kRun) {
            int winsA = 0, winsB = 0;
            for (;;) {
                if (compare(w_[cursorB], tmp_[cursorTemp]) < 0) {
                    w_[dest++] = w_[cursorB++];
                    ++winsB; --lengthB; winsA = 0;
                    if (lengthB == 0) { exit = kSucceed; break; }
                    if (winsB >= minGallop) break;
                } else {
                    w_[dest++] = tmp_[cursorTemp++];
                    ++winsA; --lengthA; winsB = 0;
                    if (lengthA == 1) { exit = kCopyB; break; }
                    if (winsA >= minGallop) break;
                }
            }
            if (exit != kRun) break;
            ++minGallop;
            bool first = true;
            while (winsA >= kMinGallopWins || winsB >= kMinGallopWins || first) {
                first = false;
                minGallop = std::max(1, minGallop - 1);
                minGallop_ = minGallop;
                winsA = gallopRight(tmp_, w_[cursorB], cursorTemp, lengthA, 0);
                if (winsA > 0) {
                    std::copy(tmp_.begin() + cursorTemp, tmp_.begin() + cursorTemp + winsA, w_.begin() + dest);
                    dest += winsA; cursorTemp += winsA; lengthA -= winsA;
                    if (lengthA == 1) { exit = kCopyB; break; }
                    if (lengthA == 0) { exit = kSucceed; break; }
                }
                w_[dest++] = w_[cursorB++];
                if (--lengthB == 0) { exit = kSucceed; break; }
                winsB = gallopLeft(w_, tmp_[cursorTemp], cursorB, lengthB, 0);
                if (winsB > 0) {
                    std::copy(w_.begin() + cursorB, w_.begin() + cursorB + winsB, w_.begin() + dest);
                    dest += winsB; cursorB += winsB; lengthB -= winsB;
                    if (lengthB == 0) { exit = kSucceed; break; }
                }
                w_[dest++] = tmp_[cursorTemp++];
                if (--lengthA == 1) { exit = kCopyB; break; }
            }
            if (exit != kRun) break;
            ++minGallop;
            minGallop_ = minGallop;
        }
        if (exit == kSucceed) {
            if (lengthA > 0) std::copy(tmp_.begin() + cursorTemp, tmp_.begin() + cursorTemp + lengthA, w_.begin() + dest);
        } else {
            // the last element of run A belongs at the end of the merge
            std::copy(w_.begin() + cursorB, w_.begin() + cursorB + lengthB, w_.begin() + dest);
            w_[dest + lengthB] = tmp_[cursorTemp];
        }
    }

    void mergeHigh(int baseA, int lengthA, int baseB, int lengthB) {
        tmp_.assign(w_.begin() + baseB, w_.begin() + baseB + lengthB);
        int dest = baseB + lengthB - 1, cursorTemp = lengthB - 1, cursorA = baseA + lengthA - 1;
        w_[dest--] = w_[cursorA--];
        enum { kRun, kSucceed, kCopyA } exit = kRun;
        if (--lengthA == 0) exit = kSucceed;
        else if (lengthB == 1) exit = kCopyA;
        int minGallop = minGallop_;
        while (exit == kRun) {
            int winsA = 0, winsB = 0;
            for (;;) {
                if (compare(tmp_[cursorTemp], w_[cursorA]) < 0) {
                    w_[dest--] = w_[cursorA--];
                    ++winsA; --lengthA; winsB = 0;
                    if (lengthA == 0) { exit = kSucceed; break; }
                    if (winsA >= minGallop) break;
                } else {
                    w_[dest--] = tmp_[cursorTemp--];
                    ++winsB; --lengthB; winsA = 0;
                    if (lengthB == 1) { exit = kCopyA; break; }
                    if (winsB >= minGallop) break;
                }
            }
            if (exit != kRun) break;
            ++minGallop;
            bool first = true;
            while (winsA >= kMinGallopWins || winsB >= kMinGallopWins || first) {
                first = false;
                minGallop = std::max(1, minGallop - 1);
                minGallop_ = minGallop;
                int k = gallopRight(w_, tmp_[cursorTemp], baseA, lengthA, lengthA - 1);
                winsA = lengthA - k;
                if (winsA > 0) {
                    dest -= winsA; cursorA -= winsA;
                    std::copy_backward(w_.begin() + cursorA + 1, w_.begin() + cursorA + 1 + winsA, w_.begin() + dest + 1 + winsA);
                    lengthA -= winsA;
                    if (lengthA == 0) { exit = kSucceed; break; }
                }
                w_[dest--] = tmp_[cursorTemp--];
                if (--lengthB == 1) { exit = kCopyA; break; }
                k = gallopLeft(tmp_, w_[cursorA], 0, lengthB, lengthB - 1);
                winsB = lengthB - k;
                if (winsB > 0) {
                    dest -= winsB; cursorTemp -= winsB;
                    std::copy(tmp_.begin() + cursorTemp + 1, tmp_.begin() + cursorTemp + 1 + winsB, w_.begin() + dest + 1);
                    lengthB -= winsB;
                    if (lengthB == 1) { exit = kCopyA; break; }
                    if (lengthB == 0) { exit = kSucceed; break; }
                }
                w_[dest--] = w_[cursorA--];
                if (--lengthA == 0) { exit = kSucceed; break; }
            }
            if (exit != kRun) break;
            ++minGallop;
            minGallop_ = minGallop;
        }
        if (exit == kSucceed) {
            if (lengthB > 0) std::copy(tmp_.begin(), tmp_.begin() + lengthB, w_.begin() + (dest - (lengthB - 1)));
        } else {
            // the first element of run B belongs at the front of the merge
            dest -= lengthA; cursorA -= lengthA;
            std::copy_backward(w_.begin() + cursorA + 1, w_.begin() + cursorA + 1 + lengthA, w_.begin() + dest + 1 + lengthA);
            w_[dest] = tmp_[cursorTemp];
        }
    }
};

} // namespace detail

/** Array.prototype.sort(cmp) over `a`, as V8 12.4 runs it. */
template <class T, class Cmp>
void sort(std::vector<T>& a, Cmp cmp) {
    detail::TimSort<T, Cmp>(a, cmp).run();
}

} // namespace js
} // namespace scratchbox

#endif // SCRATCHBOX_JS_MATH_HPP
