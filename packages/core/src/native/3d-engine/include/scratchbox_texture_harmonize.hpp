/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TEXTURE_HARMONIZE_HPP
#define SCRATCHBOX_TEXTURE_HARMONIZE_HPP

/**
 * Pipeline K's texture harmonisation, native: a line-for-line translation of the compute in
 * packages/core/src/node/3d-engine/staged-location/pipeline-k/texture-harmonize.ts (its doc comment gives the method:
 * per-photo gains toward side and height-band references, roofs apart, then a smooth per-photo offset field levelling
 * the seams, kept only when the seams get closer). The TypeScript stays the reference; this exists for speed.
 *
 * Parity rules, so the result equals the TypeScript's on the same inputs:
 *  - JS numbers are doubles, Float32Array stores are rounded to float, Uint8Array stores truncate modulo 256;
 *  - Math.round, Math.hypot (V8's scaled Kahan sum), Number.toFixed and JS % (fmod) are reproduced exactly;
 *  - every loop, reduction and insertion-ordered Map walk runs in the TypeScript's order, and sorts are stable;
 *  - floating-point contraction is off (no fused multiply-add the TypeScript does not do).
 * Math.log, Math.exp and Math.atan2 are V8's own (fdlibm / FreeBSD msun ports, not the platform's libm, which differs
 * from them in the last bit for a few per cent of arguments): they are reproduced in `jsmath` below, compiled as V8 is
 * (fused multiply-add within an expression on arm64, none elsewhere). Math.pow is used only by the final sRGB encode,
 * whose 0..255 result is read from the caller's thresholds (the least linear value reaching each byte, found with the
 * caller's own Math.pow), so no pow is computed here.
 *
 * Only the self-contained compute lives here; the GLB is read by the caller, which passes each triangle primitive's
 * positions, indices, UVs and image index (the sRGB-to-linear table too, so it is the caller's own).
 *
 * Threads: the masks run one photo per thread (each photo's triangles in their original order, so a texel two
 * triangles share resolves as in the TypeScript) and the final per-texel pass runs by rows; both are independent per
 * texel or per photo, so the result does not depend on the thread count.
 */

#pragma STDC FP_CONTRACT OFF
#pragma clang fp contract(off)

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace scratchbox {
namespace texture_harmonize {

/**
 * V8's Math.log, Math.exp, Math.atan and Math.atan2 (src/base/ieee754.cc), from fdlibm / FreeBSD msun:
 * Copyright (C) 1993, 2004 by Sun Microsystems, Inc. All rights reserved. Developed at SunSoft, a Sun Microsystems, Inc.
 * business. Permission to use, copy, modify, and distribute this software is freely granted, provided that this notice
 * is preserved.
 */
namespace jsmath {
#if defined(__aarch64__)
#pragma clang fp contract(on)
#endif
inline int32_t hiWord(double x) { uint64_t b; std::memcpy(&b, &x, 8); return (int32_t)(b >> 32); }
inline uint32_t loWord(double x) { uint64_t b; std::memcpy(&b, &x, 8); return (uint32_t)b; }
inline double fromWords(uint32_t hi, uint32_t lo) { const uint64_t b = ((uint64_t)hi << 32) | lo; double x; std::memcpy(&x, &b, 8); return x; }
inline double withHi(double x, int32_t hi) { return fromWords((uint32_t)hi, loWord(x)); }
inline double withLo(double x, uint32_t lo) { return fromWords((uint32_t)hiWord(x), lo); }
inline double hex(uint32_t hi, uint32_t lo) { return fromWords(hi, lo); }

inline double log(double x) {
    const double ln2_hi = hex(0x3fe62e42, 0xfee00000), ln2_lo = hex(0x3dea39ef, 0x35793c76), two54 = hex(0x43500000, 0);
    const double Lg1 = hex(0x3FE55555, 0x55555593), Lg2 = hex(0x3FD99999, 0x9997FA04), Lg3 = hex(0x3FD24924, 0x94229359), Lg4 = hex(0x3FCC71C5, 0x1D8E78AF), Lg5 = hex(0x3FC74664, 0x96CB03DE), Lg6 = hex(0x3FC39A09, 0xD078C69F), Lg7 = hex(0x3FC2F112, 0xDF3E5244);
    double hfsq, f, s, z, R, w, t1, t2, dk;
    int32_t k, hx, i, j;
    uint32_t lx;
    hx = hiWord(x); lx = loWord(x);
    k = 0;
    if (hx < 0x00100000) {
        if (((hx & 0x7fffffff) | (int32_t)lx) == 0) return -INFINITY;
        if (hx < 0) return NAN;
        k -= 54; x *= two54; hx = hiWord(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = withHi(x, hx | (i ^ 0x3ff00000));
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) {
        if (f == 0.0) { if (k == 0) return 0.0; dk = (double)k; return dk * ln2_hi + dk * ln2_lo; }
        R = f * f * (0.5 - 0.33333333333333333 * f);
        if (k == 0) return f - R;
        dk = (double)k; return dk * ln2_hi - ((R - dk * ln2_lo) - f);
    }
    s = f / (2.0 + f);
    dk = (double)k;
    z = s * s;
    i = hx - 0x6147a;
    w = z * z;
    j = 0x6b851 - hx;
    t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    i |= j;
    R = t2 + t1;
    if (i > 0) {
        hfsq = 0.5 * f * f;
        if (k == 0) return f - (hfsq - s * (hfsq + R));
        return dk * ln2_hi - ((hfsq - (s * (hfsq + R) + dk * ln2_lo)) - f);
    }
    if (k == 0) return f - s * (f - R);
    return dk * ln2_hi - ((s * (f - R) - dk * ln2_lo) - f);
}

inline double exp(double x) {
    const double halF[2] = {0.5, -0.5};
    const double o_threshold = hex(0x40862E42, 0xFEFA39EF), u_threshold = hex(0xc0874910, 0xD52D3051);
    const double ln2HI[2] = {hex(0x3fe62e42, 0xfee00000), hex(0xbfe62e42, 0xfee00000)}, ln2LO[2] = {hex(0x3dea39ef, 0x35793c76), hex(0xbdea39ef, 0x35793c76)};
    const double invln2 = hex(0x3ff71547, 0x652b82fe);
    const double P1 = hex(0x3FC55555, 0x5555553E), P2 = hex(0xBF66C16C, 0x16BEBD93), P3 = hex(0x3F11566A, 0xAF25DE2C), P4 = hex(0xBEBBBD41, 0xC5D26BF1), P5 = hex(0x3E663769, 0x72BEA4D0);
    const double E = hex(0x4005bf0a, 0x8b145769);
    const double huge = 1.0e+300, twom1000 = hex(0x01700000, 0), two1023 = hex(0x7fe00000, 0);
    double y, hi = 0.0, lo = 0.0, c, t, twopk;
    int32_t k = 0, xsb;
    uint32_t hx;
    hx = (uint32_t)hiWord(x);
    xsb = (int32_t)((hx >> 31) & 1);
    hx &= 0x7fffffff;
    if (hx >= 0x40862E42) {
        if (hx >= 0x7ff00000) {
            if (((hx & 0xfffff) | loWord(x)) != 0) return x + x;
            return (xsb == 0) ? x : 0.0;
        }
        if (x > o_threshold) return INFINITY;
        if (x < u_threshold) return 0.0;
    }
    if (hx > 0x3fd62e42) {
        if (hx < 0x3FF0A2B2) {
            if (x == 1.0) return E;
            hi = x - ln2HI[xsb]; lo = ln2LO[xsb]; k = 1 - xsb - xsb;
        } else {
            k = (int32_t)(invln2 * x + halF[xsb]);
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
    if (k >= -1021) twopk = fromWords((uint32_t)(0x3ff00000 + (k << 20)), 0);
    else twopk = fromWords((uint32_t)(0x3ff00000 + ((k + 1000) << 20)), 0);
    c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if (k == 0) return 1.0 - ((x * c) / (c - 2.0) - x);
    y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if (k >= -1021) {
        if (k == 1024) return y * 2.0 * two1023;
        return y * twopk;
    }
    return y * twopk * twom1000;
}

inline double atan(double x) {
    const double atanhi[4] = {hex(0x3FDDAC67, 0x0561BB4F), hex(0x3FE921FB, 0x54442D18), hex(0x3FEF730B, 0xD281F69B), hex(0x3FF921FB, 0x54442D18)};
    const double atanlo[4] = {hex(0x3C7A2B7F, 0x222F65E2), hex(0x3C81A626, 0x33145C07), hex(0x3C700788, 0x7AF0CBBD), hex(0x3C91A626, 0x33145C07)};
    const double aT[11] = {hex(0x3FD55555, 0x5555550D), hex(0xBFC99999, 0x9998EBC4), hex(0x3FC24924, 0x920083FF), hex(0xBFBC71C6, 0xFE231671), hex(0x3FB745CD, 0xC54C206E), hex(0xBFB3B0F2, 0xAF749A6D), hex(0x3FB10D66, 0xA0D03D51), hex(0xBFADDE2D, 0x52DEFD9A), hex(0x3FA97B4B, 0x24760DEB), hex(0xBFA2B444, 0x2C6A6C2F), hex(0x3F90AD3A, 0xE322DA11)};
    double w, s1, s2, z;
    int32_t ix, hx, id;
    hx = hiWord(x);
    ix = hx & 0x7fffffff;
    if (ix >= 0x44100000) {
        if (ix > 0x7ff00000 || (ix == 0x7ff00000 && (loWord(x) != 0))) return x + x;
        if (hx > 0) return atanhi[3] + atanlo[3];
        return -atanhi[3] - atanlo[3];
    }
    if (ix < 0x3fdc0000) {
        if (ix < 0x3e400000) return x;
        id = -1;
    } else {
        x = std::fabs(x);
        if (ix < 0x3ff30000) {
            if (ix < 0x3fe60000) { id = 0; x = (2.0 * x - 1.0) / (2.0 + x); }
            else { id = 1; x = (x - 1.0) / (x + 1.0); }
        } else {
            if (ix < 0x40038000) { id = 2; x = (x - 1.5) / (1.0 + 1.5 * x); }
            else { id = 3; x = -1.0 / x; }
        }
    }
    z = x * x;
    w = z * z;
    s1 = z * (aT[0] + w * (aT[2] + w * (aT[4] + w * (aT[6] + w * (aT[8] + w * aT[10])))));
    s2 = w * (aT[1] + w * (aT[3] + w * (aT[5] + w * (aT[7] + w * aT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    z = atanhi[id] - ((x * (s1 + s2) - atanlo[id]) - x);
    return (hx < 0) ? -z : z;
}

inline double atan2(double y, double x) {
    const double tiny = 1.0e-300, pi_o_4 = hex(0x3FE921FB, 0x54442D18), pi_o_2 = hex(0x3FF921FB, 0x54442D18), pi = hex(0x400921FB, 0x54442D18), pi_lo = hex(0x3CA1A626, 0x33145C07);
    double z;
    int32_t k, m, hx, hy, ix, iy;
    uint32_t lx, ly;
    hx = hiWord(x); ix = hx & 0x7fffffff; lx = loWord(x);
    hy = hiWord(y); iy = hy & 0x7fffffff; ly = loWord(y);
    if (((uint32_t)ix | ((lx | (0u - lx)) >> 31)) > 0x7ff00000 || ((uint32_t)iy | ((ly | (0u - ly)) >> 31)) > 0x7ff00000) return x + y;
    if (hx == 0x3ff00000 && lx == 0) return atan(y);
    m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if ((iy | (int32_t)ly) == 0) {
        switch (m) { case 0: case 1: return y; case 2: return pi + tiny; default: return -pi - tiny; }
    }
    if ((ix | (int32_t)lx) == 0) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
    if (ix == 0x7ff00000) {
        if (iy == 0x7ff00000) {
            switch (m) { case 0: return pi_o_4 + tiny; case 1: return -pi_o_4 - tiny; case 2: return 3.0 * pi_o_4 + tiny; default: return -3.0 * pi_o_4 - tiny; }
        }
        switch (m) { case 0: return 0.0; case 1: return -0.0; case 2: return pi + tiny; default: return -pi - tiny; }
    }
    if (iy == 0x7ff00000) return (hy < 0) ? -pi_o_2 - tiny : pi_o_2 + tiny;
    k = (iy - ix) >> 20;
    if (k > 60) { z = pi_o_2 + 0.5 * pi_lo; m &= 1; }
    else if (hx < 0 && k < -60) z = 0.0;
    else z = atan(std::fabs(y / x));
    switch (m) {
        case 0: return z;
        case 1: return -z;
        case 2: return pi - (z - pi_lo);
        default: return (z - pi_lo) - pi;
    }
}

#pragma clang fp contract(off)
} // namespace jsmath

/** TEXTURE_HARMONIZE_PARAMS, field for field. */
struct Params {
    double sampleM = 0.6, maxSamplesPerTriangle = 64;
    double sideBins = 8, bandM = 15, flatNy = 0.7;
    double maxGainLog = jsmath::log(1.8), gainScale = 0.5;
    double seamM = 1.5, seamFacingBins = 12;
    double fieldPx = 64, maxField = 24, wSmooth = 0.15, wAnchor = 0.01;
    double maxOffsetLog = jsmath::log(1.6);
    double heightCellM = 0.5, roofToleranceM = 0.75;
};

/** One triangle primitive (mode 4 with POSITION) of the GLB, in JSON order; `image` is -1 when it has no base-colour texture. */
struct Primitive {
    int32_t image = -1;
    std::vector<double> positions;
    bool indexed = false;
    std::vector<uint32_t> indices;
    std::vector<double> uvs;
};

/** One photo: its image index, size, RGBA (empty for masks alone) and optionally a given class mask. */
struct Image {
    int32_t index = 0;
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> rgba;
    bool hasMask = false;
    std::vector<uint8_t> mask;
};

constexpr uint8_t TEXEL_NONE = 0, TEXEL_WALL = 1, TEXEL_ROOF = 2;
constexpr double LOG_EPS = 1e-3;
constexpr double JS_PI = 3.141592653589793;

/** Math.round. */
inline double jsRound(double x) {
    if (!std::isfinite(x)) return x;
    double r = std::ceil(x);
    if (r - 0.5 > x) r -= 1;
    return r;
}

/** Math.hypot as V8 computes it: scaled by the largest magnitude, Kahan-summed squares. */
inline double jsHypot3(double a, double b, double c) {
    if (std::isnan(a) || std::isnan(b) || std::isnan(c)) {
        if (std::isinf(a) || std::isinf(b) || std::isinf(c)) return std::numeric_limits<double>::infinity();
        return std::numeric_limits<double>::quiet_NaN();
    }
    const double v[3] = {std::fabs(a), std::fabs(b), std::fabs(c)};
    double mx = 0;
    for (double x : v) if (x > mx) mx = x;
    if (mx == std::numeric_limits<double>::infinity()) return mx;
    if (mx == 0) return 0;
    double sum = 0, comp = 0;
    for (double x : v) {
        const double n = x / mx;
        const double summand = n * n - comp;
        const double prelim = sum + summand;
        comp = (prelim - sum) - summand;
        sum = prelim;
    }
    return std::sqrt(sum) * mx;
}

/** JS Math.min / Math.max (NaN wins). */
inline double jsMin(double a, double b) { if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN(); return a < b ? a : (b < a ? b : (std::signbit(a) ? a : b)); }
inline double jsMax(double a, double b) { if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN(); return a > b ? a : (b > a ? b : (std::signbit(a) ? b : a)); }

/** +x.toFixed(4): the decimal with four places nearest x (ties away from zero), read back as a double. */
inline double jsToFixed4(double x) {
    if (!std::isfinite(x) || std::fabs(x) >= 1e21) return x;
    const bool neg = x < 0;
    static thread_local char buf[1200];
    std::snprintf(buf, sizeof buf, "%.1080f", neg ? -x : x);
    std::string s(buf);
    const size_t dot = s.find('.');
    std::string digits = s.substr(0, dot) + s.substr(dot + 1, 4);
    if (s[dot + 5] >= '5') {
        int k = (int)digits.size() - 1;
        while (k >= 0 && digits[k] == '9') { digits[k] = '0'; k--; }
        if (k < 0) digits.insert(digits.begin(), '1'); else digits[k]++;
    }
    const std::string out = (neg ? "-" : "") + digits.substr(0, digits.size() - 4) + "." + digits.substr(digits.size() - 4);
    return std::strtod(out.c_str(), nullptr);
}

/**
 * Math.round(linearToSrgb255(lin)) stored into a Uint8Array: `thresholds[v - 1]` is the least value of clamp01(lin)
 * whose encode reaches v (v = 1..255; +Infinity when none does), so the byte is how many thresholds the value reaches.
 */
inline uint8_t encodeSrgb8(double lin, const double* thresholds) {
    const double x = lin < 0 ? 0 : lin > 1 ? 1 : lin;
    if (std::isnan(x)) return 0;
    int lo = 0, hi = 255;
    while (lo < hi) { const int mid = (lo + hi) / 2; if (thresholds[mid] <= x) lo = mid + 1; else hi = mid; }
    return (uint8_t)lo;
}

/** ((u % 1) + 1) % 1. */
inline double wrap01(double u) { return std::fmod(std::fmod(u, 1.0) + 1, 1.0); }

/** The top-down height map of every triangle (topHeightMap). */
class TopHeightMap {
public:
    TopHeightMap(const std::vector<Primitive>& prims, const Params& P) : c_(P.heightCellM) {
        double x0 = std::numeric_limits<double>::infinity(), z0 = x0, x1 = -x0, z1 = -x0;
        std::vector<double> tris;
        for (const auto& pr : prims) {
            const size_t n = pr.indexed ? pr.indices.size() : pr.positions.size() / 3;
            for (size_t t = 0; t < n; t++) {
                const size_t i = pr.indexed ? pr.indices[t] : t;
                if (i * 3 + 2 >= pr.positions.size()) throw std::runtime_error("an index points past its primitive's positions");
                const double* q = &pr.positions[i * 3];
                tris.push_back(q[0]); tris.push_back(q[1]); tris.push_back(q[2]);
                x0 = jsMin(x0, q[0]); x1 = jsMax(x1, q[0]); z0 = jsMin(z0, q[2]); z1 = jsMax(z1, q[2]);
            }
        }
        if (tris.empty()) return;
        any_ = true; x0_ = x0; z0_ = z0;
        W_ = (int64_t)jsMax(1, std::ceil((x1 - x0) / c_) + 1); H_ = (int64_t)jsMax(1, std::ceil((z1 - z0) / c_) + 1);
        top_.assign((size_t)(W_ * H_), -std::numeric_limits<float>::infinity());
        const double c = c_;
        for (size_t t = 0; t + 8 < tris.size(); t += 9) {
            const double ax = (tris[t] - x0) / c, az = (tris[t + 2] - z0) / c, bx = (tris[t + 3] - x0) / c, bz = (tris[t + 5] - z0) / c, cx = (tris[t + 6] - x0) / c, cz = (tris[t + 8] - z0) / c;
            const double den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
            if (std::fabs(den) < 1e-9) continue;
            const double ix0 = jsMax(0, std::floor(jsMin(jsMin(ax, bx), cx))), ix1 = jsMin((double)(W_ - 1), std::ceil(jsMax(jsMax(ax, bx), cx)));
            const double iz0 = jsMax(0, std::floor(jsMin(jsMin(az, bz), cz))), iz1 = jsMin((double)(H_ - 1), std::ceil(jsMax(jsMax(az, bz), cz)));
            if (!(iz0 <= iz1) || !(ix0 <= ix1)) continue;
            for (int64_t iz = (int64_t)iz0; iz <= (int64_t)iz1; iz++) for (int64_t ix = (int64_t)ix0; ix <= (int64_t)ix1; ix++) {
                const double px = ix + 0.5, pz = iz + 0.5;
                const double a = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, b = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den;
                if (a < 0 || b < 0 || a + b > 1) continue;
                const double y = a * tris[t + 1] + b * tris[t + 4] + (1 - a - b) * tris[t + 7];
                float& cell = top_[(size_t)(iz * W_ + ix)];
                if (y > (double)cell) cell = (float)y;
            }
        }
    }
    double operator()(double x, double z) const {
        if (!any_) return -std::numeric_limits<double>::infinity();
        const double ix = std::floor((x - x0_) / c_), iz = std::floor((z - z0_) / c_);
        if (ix < 0 || iz < 0 || ix >= (double)W_ || iz >= (double)H_ || std::isnan(ix) || std::isnan(iz)) return -std::numeric_limits<double>::infinity();
        return (double)top_[(size_t)((int64_t)iz * W_ + (int64_t)ix)];
    }
private:
    double c_, x0_ = 0, z0_ = 0;
    bool any_ = false;
    int64_t W_ = 0, H_ = 0;
    std::vector<float> top_;
};

/** triangleFacing: unit normal, area, faces up. */
struct Facing { bool ok = false, up = false; double area = 0, n[3] = {0, 0, 0}; };
inline Facing triangleFacing(const double* p, const Params& P) {
    const double ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const double area2 = jsHypot3(nx, ny, nz);
    Facing f;
    if (!(area2 > 1e-9)) return f;
    nx /= area2; ny /= area2; nz /= area2;
    f.ok = true; f.up = ny > P.flatNy; f.area = area2 / 2; f.n[0] = nx; f.n[1] = ny; f.n[2] = nz;
    return f;
}

inline bool seenFromAbove(double x, double y, double z, const TopHeightMap& top, const Params& P) { return y >= top(x, z) - P.roofToleranceM; }

/** forEachTexturedTriangle: calls fn(image, p[9], uv[6]) in the TypeScript's order. */
template <class Fn>
void forEachTexturedTriangle(const std::vector<Primitive>& prims, Fn&& fn) {
    double p[9], q[6];
    for (size_t pi = 0; pi < prims.size(); pi++) {
        const auto& pr = prims[pi];
        if (pr.image < 0) continue;
        const size_t n = pr.indexed ? pr.indices.size() : pr.positions.size() / 3;
        for (size_t t = 0; t + 2 < n; t += 3) {
            for (int k = 0; k < 3; k++) {
                const size_t i = pr.indexed ? pr.indices[t + k] : t + k;
                if (i * 3 + 2 >= pr.positions.size() || i * 2 + 1 >= pr.uvs.size()) throw std::runtime_error("an index points past its primitive's positions or UVs");
                p[k * 3] = pr.positions[i * 3]; p[k * 3 + 1] = pr.positions[i * 3 + 1]; p[k * 3 + 2] = pr.positions[i * 3 + 2];
                q[k * 2] = pr.uvs[i * 2]; q[k * 2 + 1] = pr.uvs[i * 2 + 1];
            }
            fn(pr.image, pi, t, p, q);
        }
    }
}

inline unsigned threadCount(unsigned requested) {
    if (requested) return requested;
    const unsigned h = std::thread::hardware_concurrency();
    return h ? h : 1;
}

/** Runs fn(i) for i in [0, n) over up to `threads` workers. */
template <class Fn>
void parallelFor(size_t n, unsigned threads, Fn&& fn) {
    const unsigned T = (unsigned)std::min<size_t>(threadCount(threads), std::max<size_t>(n, 1));
    if (T <= 1) { for (size_t i = 0; i < n; i++) fn(i); return; }
    std::atomic<size_t> next{0};
    std::vector<std::thread> pool;
    for (unsigned t = 0; t < T; t++) pool.emplace_back([&] { for (size_t i; (i = next.fetch_add(1)) < n;) fn(i); });
    for (auto& th : pool) th.join();
}

/**
 * surfaceClassMasks: per photo (in `images` order), TEXEL_* per texel, grown by two texels. `top` is the GLB's height
 * map. Each photo's triangles run in their original order on one thread.
 */
inline std::vector<std::vector<uint8_t>> surfaceClassMasks(const std::vector<Primitive>& prims, const std::vector<Image>& images, const TopHeightMap& top, const Params& P, unsigned threads) {
    std::unordered_map<int32_t, size_t> slot;
    for (size_t k = 0; k < images.size(); k++) slot.emplace(images[k].index, k);
    // each photo's triangles (primitive, first index) in order
    std::vector<std::vector<std::pair<uint32_t, uint64_t>>> work(images.size());
    forEachTexturedTriangle(prims, [&](int32_t img, size_t pi, size_t t, const double*, const double*) {
        const auto it = slot.find(img);
        if (it != slot.end()) work[it->second].emplace_back((uint32_t)pi, (uint64_t)t);
    });
    std::vector<std::vector<uint8_t>> masks(images.size());
    parallelFor(images.size(), threads, [&](size_t k) {
        const double Wd = images[k].width, Hd = images[k].height;
        const int64_t W = images[k].width, H = images[k].height;
        auto& m = masks[k];
        m.assign((size_t)(W * H), TEXEL_NONE);
        double p[9], uv[6];
        for (const auto& [pi, t] : work[k]) {
            const auto& pr = prims[pi];
            for (int c = 0; c < 3; c++) {
                const size_t i = pr.indexed ? pr.indices[t + c] : t + c;
                p[c * 3] = pr.positions[i * 3]; p[c * 3 + 1] = pr.positions[i * 3 + 1]; p[c * 3 + 2] = pr.positions[i * 3 + 2];
                uv[c * 2] = pr.uvs[i * 2]; uv[c * 2 + 1] = pr.uvs[i * 2 + 1];
            }
            const Facing surf = triangleFacing(p, P);
            if (!surf.ok) continue;
            const double ax = uv[0] * Wd, ay = uv[1] * Hd, bx = uv[2] * Wd, by = uv[3] * Hd, cx = uv[4] * Wd, cy = uv[5] * Hd;
            const double den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            const double x0 = jsMax(0, std::floor(jsMin(jsMin(ax, bx), cx))), x1 = jsMin(Wd - 1, std::ceil(jsMax(jsMax(ax, bx), cx)));
            const double y0 = jsMax(0, std::floor(jsMin(jsMin(ay, by), cy))), y1 = jsMin(Hd - 1, std::ceil(jsMax(jsMax(ay, by), cy)));
            if (std::fabs(den) < 1e-12) {
                if (x0 <= x1 && y0 <= y1) { uint8_t& e = m[(size_t)((int64_t)y0 * W + (int64_t)x0)]; if (!e) e = TEXEL_WALL; }
                continue;
            }
            if (!(y0 <= y1) || !(x0 <= x1)) continue;
            for (int64_t y = (int64_t)y0; y <= (int64_t)y1; y++) for (int64_t x = (int64_t)x0; x <= (int64_t)x1; x++) {
                const double px = x + 0.5, py = y + 0.5;
                const double a = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, b = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
                if (a < 0 || b < 0 || a + b > 1) continue;
                const double c = 1 - a - b;
                const uint8_t cls = surf.up && seenFromAbove(a * p[0] + b * p[3] + c * p[6], a * p[1] + b * p[4] + c * p[7], a * p[2] + b * p[5] + c * p[8], top, P) ? TEXEL_ROOF : TEXEL_WALL;
                uint8_t& e = m[(size_t)(y * W + x)];
                e = e == TEXEL_NONE ? cls : std::min(e, cls);
            }
        }
        for (int pass = 0; pass < 2; pass++) {
            const std::vector<uint8_t> src = m;
            for (int64_t y = 0; y < H; y++) for (int64_t x = 0; x < W; x++) {
                const int64_t k2 = y * W + x;
                if (src[k2] != TEXEL_NONE) continue;
                uint8_t best = TEXEL_NONE;
                if (x > 0 && src[k2 - 1]) best = std::max(best, src[k2 - 1]);
                if (x + 1 < W && src[k2 + 1]) best = std::max(best, src[k2 + 1]);
                if (y > 0 && src[k2 - W]) best = std::max(best, src[k2 - W]);
                if (y + 1 < H && src[k2 + W]) best = std::max(best, src[k2 + W]);
                m[k2] = best;
            }
        }
    });
    return masks;
}

struct Sample { double x, y, z, nx, ny, nz; int32_t img; double u, v, w; double c[3]; bool roof; };

/** sampleLinear: bilinear linear-RGB colour at a UV (wrapped). */
inline void sampleLinear(const Image& im, const float* srgb, double u, double v, double out[3]) {
    const int64_t W = im.width, H = im.height;
    const double fx = wrap01(u) * (double)W - 0.5, fy = wrap01(v) * (double)H - 0.5;
    const double fx0 = std::floor(fx), fy0 = std::floor(fy), a = fx - fx0, b = fy - fy0;
    const int64_t x0 = (int64_t)fx0, y0 = (int64_t)fy0;
    auto at = [&](int64_t x, int64_t y, int c) -> double { return (double)srgb[im.rgba[(size_t)(((((y + H) % H)) * W + ((x + W) % W)) * 4 + c)]]; };
    for (int c = 0; c < 3; c++) out[c] = (1 - a) * (1 - b) * at(x0, y0, c) + a * (1 - b) * at(x0 + 1, y0, c) + (1 - a) * b * at(x0, y0 + 1, c) + a * b * at(x0 + 1, y0 + 1, c);
}

/** samplesOf. */
inline std::vector<Sample> samplesOf(const std::vector<Primitive>& prims, const std::vector<Image>& images, const float* srgb, const TopHeightMap& top, const Params& P, double& roofM2, double& hiddenM2) {
    std::unordered_map<int32_t, size_t> slot;
    for (size_t k = 0; k < images.size(); k++) slot.emplace(images[k].index, k);
    std::vector<Sample> out;
    const double maxSteps = std::floor(std::sqrt(2 * P.maxSamplesPerTriangle)) - 1;
    forEachTexturedTriangle(prims, [&](int32_t source, size_t, size_t, const double* p, const double* uv) {
        const auto it = slot.find(source);
        if (it == slot.end()) return;
        const Image& img = images[it->second];
        const Facing surf = triangleFacing(p, P);
        if (!surf.ok) return;
        const double nx = surf.n[0], ny = surf.n[1], nz = surf.n[2];
        const double ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        const double steps = jsMax(1, jsMin(maxSteps, std::ceil(jsMax(jsHypot3(ux, uy, uz), jsHypot3(vx, vy, vz)) / P.sampleM)));
        const double count = ((steps + 1) * (steps + 2)) / 2, w = surf.area / count;
        for (double i = 0; i <= steps; i++) for (double j = 0; i + j <= steps; j++) {
            const double a = (i + 1.0 / 3) / (steps + 1), b = (j + 1.0 / 3) / (steps + 1);
            if (a + b > 1) continue;
            const double x = p[0] + ux * a + vx * b, y = p[1] + uy * a + vy * b, z = p[2] + uz * a + vz * b;
            const bool roof = surf.up && seenFromAbove(x, y, z, top, P);
            if (surf.up) { if (roof) roofM2 += w; else { hiddenM2 += w; continue; } }
            const double su = uv[0] + (uv[2] - uv[0]) * a + (uv[4] - uv[0]) * b;
            const double sv = uv[1] + (uv[3] - uv[1]) * a + (uv[5] - uv[1]) * b;
            double lin[3];
            sampleLinear(img, srgb, su, sv, lin);
            Sample s{x, y, z, nx, ny, nz, source, su, sv, w, {jsmath::log(lin[0] + LOG_EPS), jsmath::log(lin[1] + LOG_EPS), jsmath::log(lin[2] + LOG_EPS)}, roof};
            out.push_back(s);
        }
    });
    return out;
}

/** weightedMedian (a stable sort, as Array.prototype.sort). */
inline double weightedMedian(const std::vector<double>& v, const std::vector<double>& w) {
    std::vector<size_t> idx(v.size());
    for (size_t i = 0; i < idx.size(); i++) idx[i] = i;
    std::stable_sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return v[a] - v[b] < 0; });
    double total = 0;
    for (double x : w) total = total + x;
    double acc = 0;
    for (size_t i : idx) { acc += w[i]; if (acc >= total / 2) return v[i]; }
    return v[idx.back()];
}

struct Field { int64_t nx, ny, base; };

/** fieldWeights: four global node indices and bilinear weights. */
inline void fieldWeights(const Field& f, double u, double v, int64_t k[4], double w[4]) {
    const double fx = wrap01(u) * (double)(f.nx - 1), fy = wrap01(v) * (double)(f.ny - 1);
    const double i = jsMin((double)(f.nx - 2), std::floor(fx)), j = jsMin((double)(f.ny - 2), std::floor(fy)), a = fx - i, b = fy - j;
    const int64_t ii = (int64_t)i, jj = (int64_t)j;
    k[0] = f.base + jj * f.nx + ii; k[1] = f.base + jj * f.nx + ii + 1; k[2] = f.base + (jj + 1) * f.nx + ii; k[3] = f.base + (jj + 1) * f.nx + ii + 1;
    w[0] = (1 - a) * (1 - b); w[1] = a * (1 - b); w[2] = (1 - a) * b; w[3] = a * b;
}

/** Rows (ortho-rectify.ts): a sparse least-squares system, rows scaled by the square root of their weight. */
struct Rows {
    std::vector<int32_t> idx; std::vector<double> val; std::vector<int32_t> start{0}; std::vector<double> rhs;
    void add(const int64_t* cols, const double* coefs, int n, double b, double w) {
        const double s = std::sqrt(w);
        for (int k = 0; k < n; k++) if (coefs[k] != 0) { idx.push_back((int32_t)cols[k]); val.push_back(coefs[k] * s); }
        start.push_back((int32_t)idx.size());
        rhs.push_back(b * s);
    }
};

/** solveLeastSquares (ortho-rectify.ts): Jacobi-preconditioned conjugate gradients on the normal equations. */
inline std::vector<double> solveLeastSquares(const Rows& rows, size_t n, int iterations, double tol, int& itOut) {
    const size_t nr = rows.rhs.size();
    const auto& idx = rows.idx; const auto& val = rows.val; const auto& start = rows.start; const auto& rhs = rows.rhs;
    std::vector<double> tmp(nr);
    auto AtA = [&](const std::vector<double>& x, std::vector<double>& out) {
        for (size_t r = 0; r < nr; r++) { double a = 0; for (int32_t k = start[r]; k < start[r + 1]; k++) a += val[k] * x[idx[k]]; tmp[r] = a; }
        std::fill(out.begin(), out.end(), 0.0);
        for (size_t r = 0; r < nr; r++) { const double t = tmp[r]; for (int32_t k = start[r]; k < start[r + 1]; k++) out[idx[k]] += val[k] * t; }
    };
    std::vector<double> diag(n, 0.0), b(n, 0.0);
    for (size_t r = 0; r < nr; r++) for (int32_t k = start[r]; k < start[r + 1]; k++) { diag[idx[k]] += val[k] * val[k]; b[idx[k]] += val[k] * rhs[r]; }
    std::vector<double> u(n, 0.0), r(n), z(n), p(n), Ap(n);
    AtA(u, Ap);
    for (size_t i = 0; i < n; i++) { r[i] = b[i] - Ap[i]; z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; p[i] = z[i]; }
    double rz = 0, bn = 0;
    for (size_t i = 0; i < n; i++) { rz += r[i] * z[i]; bn += r[i] * r[i]; }
    bn = std::sqrt(bn);
    if (bn == 0 || std::isnan(bn)) bn = 1;
    int it = 0;
    for (; it < iterations; it++) {
        AtA(p, Ap);
        double pAp = 0;
        for (size_t i = 0; i < n; i++) pAp += p[i] * Ap[i];
        if (!(pAp > 0)) break;
        const double alpha = rz / pAp;
        double rn = 0;
        for (size_t i = 0; i < n; i++) { u[i] += alpha * p[i]; r[i] -= alpha * Ap[i]; rn += r[i] * r[i]; }
        if (std::sqrt(rn) / bn < tol) { it++; break; }
        double rz2 = 0;
        for (size_t i = 0; i < n; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; rz2 += r[i] * z[i]; }
        const double beta = rz2 / rz;
        rz = rz2;
        for (size_t i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    }
    itOut = it;
    return u;
}

/** An insertion-ordered map (a JS Map's walk order) from a small integer tuple to a value. */
template <class V>
class OrderedMap {
public:
    struct Key { int64_t a, b, c, d; bool operator==(const Key& o) const { return a == o.a && b == o.b && c == o.c && d == o.d; } };
    struct Hash { size_t operator()(const Key& k) const { uint64_t h = 1469598103934665603ull; for (int64_t x : {k.a, k.b, k.c, k.d}) { h ^= (uint64_t)x + 0x9e3779b97f4a7c15ull + (h << 6) + (h >> 2); } return (size_t)h; } };
    V& get(const Key& k) {
        const auto it = at_.find(k);
        if (it != at_.end()) return items_[it->second].second;
        at_.emplace(k, items_.size());
        items_.emplace_back(k, V{});
        return items_.back().second;
    }
    std::vector<std::pair<Key, V>>& items() { return items_; }
    size_t size() const { return items_.size(); }
private:
    std::unordered_map<Key, size_t, Hash> at_;
    std::vector<std::pair<Key, V>> items_;
};

/** A key of a photo's statistics inside one group or patch: the gain key (photo * 2 + roof), its weight and sums. */
struct Entry { int64_t key; double w = 0, c[3] = {0, 0, 0}, u = 0, v = 0; };
/** A small insertion-ordered map from gain key to Entry (groups and patches hold a handful of photos). */
struct EntryList {
    std::vector<Entry> list;
    Entry& get(int64_t key) { for (auto& e : list) if (e.key == key) return e; list.push_back(Entry{key}); return list.back(); }
};

enum Status : uint32_t { TOO_FEW = 0, NOT_CLOSER = 1, KEPT = 2 };

struct HarmonizeResult {
    Status status = TOO_FEW;
    uint32_t samples = 0, groups = 0, roofGains = 0, gainCount = 0, pairs = 0;
    double roofM2 = 0, hiddenM2 = 0, sumAbs = 0, maxAbs = 0, before = 0, afterMatch = 0, after = 0;
    int cgIterations[3] = {0, 0, 0};
    /** Milliseconds: height map, samples, gains and patches, field solve, masks, apply. */
    double ms[6] = {0, 0, 0, 0, 0, 0};
};

/**
 * harmonizeTextures: the images' RGBA are replaced in place only when the result is kept. With `masksGiven`, each
 * image's given mask is used (an image without one, or a texel past its end, is wall); otherwise the masks are computed
 * (as the TypeScript, only on the kept path). `srgb` is SRGB8_TO_LINEAR, `srgbEncode` the encode thresholds (encodeSrgb8).
 */
inline HarmonizeResult harmonizeTextures(const std::vector<Primitive>& prims, std::vector<Image>& images, double groundY, const float* srgb, const double* srgbEncode, const Params& P, unsigned threads, bool masksGiven) {
    using clk = std::chrono::steady_clock;
    auto msSince = [](clk::time_point t) { return std::chrono::duration<double, std::milli>(clk::now() - t).count(); };
    HarmonizeResult R;
    auto t = clk::now();
    const TopHeightMap top(prims, P);
    R.ms[0] = msSince(t); t = clk::now();
    const std::vector<Sample> samples = samplesOf(prims, images, srgb, top, P, R.roofM2, R.hiddenM2);
    R.ms[1] = msSince(t); t = clk::now();
    R.samples = (uint32_t)samples.size();
    if (samples.size() < 100 || images.size() < 2) return R;
    // groups and their references
    using Map = OrderedMap<EntryList>;
    auto sideBin = [](const Sample& s, double bins) { const double az = jsmath::atan2(s.nx, s.nz); return std::fmod(std::fmod(jsRound((az / (2 * JS_PI)) * bins), bins) + bins, bins); };
    auto groupOf = [&](const Sample& s) -> Map::Key {
        const int64_t band = (int64_t)std::floor((s.y - groundY) / P.bandM);
        if (s.ny > P.flatNy) return {0, 0, band, 0};
        if (s.ny < -P.flatNy) return {1, 0, band, 0};
        return {2, (int64_t)sideBin(s, P.sideBins), band, 0};
    };
    auto gainKey = [](const Sample& s) -> int64_t { return (int64_t)s.img * 2 + (s.roof ? 1 : 0); };
    Map stats;
    for (const auto& s : samples) {
        Entry& e = stats.get(groupOf(s)).get(gainKey(s));
        e.w += s.w; for (int c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    R.groups = (uint32_t)stats.size();
    struct Acc { double num[3] = {0, 0, 0}; double den = 0; };
    OrderedMap<Acc> gainAcc;
    for (auto& [gk, m] : stats.items()) {
        if (m.list.size() < 2) continue;
        std::vector<Entry> list;
        for (const auto& e : m.list) { Entry x{e.key}; x.w = e.w; for (int c = 0; c < 3; c++) x.c[c] = e.c[c] / e.w; list.push_back(x); }
        double ref[3];
        for (int c = 0; c < 3; c++) {
            std::vector<double> v, w;
            for (const auto& x : list) { v.push_back(x.c[c]); w.push_back(x.w); }
            ref[c] = weightedMedian(v, w);
        }
        for (const auto& x : list) {
            Acc& a = gainAcc.get({x.key, 0, 0, 0});
            for (int c = 0; c < 3; c++) a.num[c] += x.w * (ref[c] - x.c[c]);
            a.den = a.den + x.w;
        }
    }
    std::unordered_map<int64_t, std::array<double, 3>> gain;
    for (auto& [k, a] : gainAcc.items()) {
        std::array<double, 3> gg;
        for (int c = 0; c < 3; c++) gg[c] = P.gainScale * jsMax(-P.maxGainLog, jsMin(P.maxGainLog, a.num[c] / a.den));
        gain[k.a] = gg;
        if (k.a & 1) R.roofGains++;
        for (double v : gg) { R.sumAbs += std::fabs(v); R.maxAbs = jsMax(R.maxAbs, std::fabs(v)); }
    }
    R.gainCount = (uint32_t)gain.size();
    // seam patches
    auto facingBin = [&](const Sample& s) -> int64_t { return s.ny > P.flatNy ? -1 : s.ny < -P.flatNy ? -2 : (int64_t)sideBin(s, P.seamFacingBins); };
    Map patches;
    for (const auto& s : samples) {
        const Map::Key k{(int64_t)std::floor(s.x / P.seamM), (int64_t)std::floor(s.y / P.seamM), (int64_t)std::floor(s.z / P.seamM), facingBin(s)};
        Entry& e = patches.get(k).get(gainKey(s));
        e.w += s.w; e.u += s.w * s.u; e.v += s.w * s.v; for (int c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    struct End { int64_t img; double u, v, c[3]; };
    struct Pair { End a, b; double w; };
    std::vector<Pair> pairs;
    for (auto& [pk, m] : patches.items()) {
        if (m.list.size() < 2) continue;
        std::vector<Entry> list;
        for (const auto& e : m.list) { Entry x{e.key}; x.w = e.w; x.u = e.u / e.w; x.v = e.v / e.w; for (int c = 0; c < 3; c++) x.c[c] = e.c[c] / e.w; list.push_back(x); }
        std::stable_sort(list.begin(), list.end(), [](const Entry& x, const Entry& y) { return y.w - x.w < 0; });
        auto end = [](const Entry& e) { End o{e.key, e.u, e.v, {e.c[0], e.c[1], e.c[2]}}; return o; };
        for (size_t k = 1; k < list.size(); k++) pairs.push_back(Pair{end(list[0]), end(list[k]), jsMin(list[0].w, list[k].w)});
    }
    R.pairs = (uint32_t)pairs.size();
    auto g0 = [&](int64_t img, int c) { const auto it = gain.find(img); return it == gain.end() ? 0.0 : it->second[c]; };
    // the fields, one per photo in `images` order
    std::unordered_map<int64_t, Field> fields;
    int64_t nodes = 0;
    std::vector<Field> fieldOrder;
    for (const auto& im : images) {
        const int64_t nx = (int64_t)jsMax(2, jsMin(P.maxField, std::ceil(im.width / P.fieldPx) + 1)), ny = (int64_t)jsMax(2, jsMin(P.maxField, std::ceil(im.height / P.fieldPx) + 1));
        const Field f{nx, ny, nodes};
        fields[im.index] = f; fieldOrder.push_back(f);
        nodes += nx * ny;
    }
    auto fieldOf = [&](int64_t key) -> const Field& { return fields.at(key >> 1); };
    auto seamDiff = [&](const std::vector<std::vector<double>>* off, bool useGain) {
        double s = 0, wt = 0;
        int64_t ka[4], kb[4]; double wa[4], wb[4];
        for (const auto& pr : pairs) {
            for (int c = 0; c < 3; c++) {
                double va = pr.a.c[c] + (useGain ? g0(pr.a.img, c) : 0), vb = pr.b.c[c] + (useGain ? g0(pr.b.img, c) : 0);
                if (off) {
                    fieldWeights(fieldOf(pr.a.img), pr.a.u, pr.a.v, ka, wa); fieldWeights(fieldOf(pr.b.img), pr.b.u, pr.b.v, kb, wb);
                    for (int q = 0; q < 4; q++) { va += wa[q] * (*off)[c][ka[q]]; vb += wb[q] * (*off)[c][kb[q]]; }
                }
                s += pr.w * std::fabs(va - vb); wt += pr.w;
            }
        }
        return wt > 0 ? s / wt : 0;
    };
    R.before = seamDiff(nullptr, false);
    R.afterMatch = seamDiff(nullptr, true);
    R.ms[2] = msSince(t); t = clk::now();
    std::vector<std::vector<double>> off;
    for (int c = 0; c < 3; c++) {
        Rows rows;
        int64_t cols[8]; double coefs[8];
        for (const auto& pr : pairs) {
            double wa[4], wb[4];
            fieldWeights(fieldOf(pr.a.img), pr.a.u, pr.a.v, cols, wa); fieldWeights(fieldOf(pr.b.img), pr.b.u, pr.b.v, cols + 4, wb);
            for (int q = 0; q < 4; q++) { coefs[q] = wa[q]; coefs[4 + q] = -wb[q]; }
            rows.add(cols, coefs, 8, (pr.b.c[c] + g0(pr.b.img, c)) - (pr.a.c[c] + g0(pr.a.img, c)), jsMin(4, pr.w));
        }
        for (const auto& f : fieldOrder) for (int64_t jy = 0; jy < f.ny; jy++) for (int64_t ix = 0; ix < f.nx; ix++) {
            const int64_t k = f.base + jy * f.nx + ix;
            const double one = 1, sm[2] = {1, -1};
            rows.add(&k, &one, 1, 0, P.wAnchor);
            if (ix + 1 < f.nx) { const int64_t kk[2] = {k, k + 1}; rows.add(kk, sm, 2, 0, P.wSmooth); }
            if (jy + 1 < f.ny) { const int64_t kk[2] = {k, k + f.nx}; rows.add(kk, sm, 2, 0, P.wSmooth); }
        }
        std::vector<double> sol = solveLeastSquares(rows, (size_t)nodes, 400, 1e-6, R.cgIterations[c]);
        for (auto& x : sol) x = jsMax(-P.maxOffsetLog, jsMin(P.maxOffsetLog, x));
        off.push_back(std::move(sol));
    }
    R.after = seamDiff(&off, true);
    R.ms[3] = msSince(t); t = clk::now();
    if (!(jsToFixed4(R.after) < jsToFixed4(R.before))) { R.status = NOT_CLOSER; return R; }
    // apply: per texel, the photo's gain (its roof's on a roof texel) and its field's offset, in linear light
    if (!masksGiven) {
        auto masks = surfaceClassMasks(prims, images, top, P, threads);
        for (size_t k = 0; k < images.size(); k++) { images[k].mask = std::move(masks[k]); images[k].hasMask = true; }
    }
    R.ms[4] = msSince(t); t = clk::now();
    struct RowJob { size_t img; int64_t y0, y1; };
    std::vector<RowJob> jobs;
    for (size_t k = 0; k < images.size(); k++) for (int64_t y = 0; y < (int64_t)images[k].height; y += 64) jobs.push_back({k, y, std::min<int64_t>(images[k].height, y + 64)});
    std::vector<std::vector<uint8_t>> outs(images.size());
    for (size_t k = 0; k < images.size(); k++) outs[k] = images[k].rgba;
    parallelFor(jobs.size(), threads, [&](size_t j) {
        const auto& job = jobs[j];
        const Image& im = images[job.img];
        const Field& f = fields.at(im.index);
        const std::array<double, 3> zero{0, 0, 0};
        const auto wg = gain.find((int64_t)im.index * 2), rg = gain.find((int64_t)im.index * 2 + 1);
        const std::array<double, 3>& wallGain = wg == gain.end() ? zero : wg->second;
        const std::array<double, 3>& roofGain = rg == gain.end() ? zero : rg->second;
        const int64_t W = im.width;
        const size_t maskLen = im.hasMask ? im.mask.size() : 0;
        auto& out = outs[job.img];
        int64_t k[4]; double w[4];
        for (int64_t y = job.y0; y < job.y1; y++) for (int64_t x = 0; x < W; x++) {
            fieldWeights(f, (x + 0.5) / (double)W, (y + 0.5) / (double)im.height, k, w);
            const size_t p = (size_t)((y * W + x) * 4);
            const std::array<double, 3>& gg = (size_t)(y * W + x) < maskLen && im.mask[(size_t)(y * W + x)] == TEXEL_ROOF ? roofGain : wallGain;
            for (int c = 0; c < 3; c++) {
                double o = gg[c];
                for (int q = 0; q < 4; q++) o += w[q] * off[c][k[q]];
                out[p + c] = encodeSrgb8((double)srgb[im.rgba[p + c]] * jsmath::exp(o), srgbEncode);
            }
        }
    });
    for (size_t k = 0; k < images.size(); k++) images[k].rgba = std::move(outs[k]);
    R.ms[5] = msSince(t);
    R.status = KEPT;
    return R;
}

} // namespace texture_harmonize
} // namespace scratchbox

#endif
