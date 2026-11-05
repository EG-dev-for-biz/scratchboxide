/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MATERIAL_REGIONS_HPP
#define SCRATCHBOX_MATERIAL_REGIONS_HPP

/**
 * Pipeline K's material regions, per-texel kernels: a line-for-line translation of the texel compute in
 * packages/core/src/node/3d-engine/staged-location/pipeline-k/material-regions.ts, so the native results equal the
 * TypeScript ones bit for bit (material-regions-native.ts drives it; the GLB JSON, the library match and the report
 * stay in TypeScript).
 *
 *  - appearanceKMeans: readRegionClasses' sampling (the seeded LCG sampler) and its CIELAB k-means;
 *  - harvestClassify: the tile-only harvest's per-texel validity, luma and nearest class;
 *  - regionClassMap / planJob: planMaterialJob (each texel's class, its majority over a square, and the maps its class's
 *    set writes: tiled at the set's real size on a rebuilt facade, the set's mean on a scan piece).
 *
 * Parity rules: a JS number is a double, a Float32Array element a float (stored rounded); a Uint8Array/Int32Array store
 * (ToUint8/ToInt32), Math.round, Math.hypot and Math.cbrt are V8's, from scratchbox_js_math.hpp; and no multiply-add is
 * fused outside it (the pragma below), since JS never fuses.
 */

#pragma STDC FP_CONTRACT OFF

#include "scratchbox_js_math.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <vector>

namespace scratchbox::material_regions {

// ---- JS number semantics: scratchbox_js_math.hpp ----

/** `Math.hypot(...) || 1`. */
inline double hypotOr1(double a, double b, double c) { const double h = js::hypot({a, b, c}); return (h == 0 || std::isnan(h)) ? 1.0 : h; }

// ---- colour ----

/** SRGB8_TO_LINEAR (photogrammetric-delight.ts): a Float32Array. */
struct Srgb8ToLinear {
    float t[256];
    Srgb8ToLinear() {
        for (int i = 0; i < 256; i++) { const double c = i / 255.0; t[i] = static_cast<float>(c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4)); }
    }
};
inline const Srgb8ToLinear& srgb8ToLinear() { static const Srgb8ToLinear s; return s; }

/** linearRgbToLab (texture-library-index.ts). */
inline void linearRgbToLab(double r, double g, double b, double out[3]) {
    const double X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    auto f = [](double t) { return t > 0.008856 ? js::cbrt(t) : 7.787 * t + 16.0 / 116.0; };
    const double fX = f(X), fY = f(Y), fZ = f(Z);
    out[0] = 116 * fY - 16; out[1] = 500 * (fX - fY); out[2] = 200 * (fY - fZ);
}

/** labOf's 5-bit buckets, each the CIELAB of its own centre (so the value never depends on which texel came first). */
struct LabTable {
    std::vector<double> v; // 32768 x 3
    LabTable() : v(32768 * 3) {
        const auto& s = srgb8ToLinear();
        for (int key = 0; key < 32768; key++) {
            const int r = (key >> 10) & 31, g = (key >> 5) & 31, b = key & 31;
            linearRgbToLab(s.t[(r << 3) | 4], s.t[(g << 3) | 4], s.t[(b << 3) | 4], &v[key * 3]);
        }
    }
    const double* of(uint8_t r, uint8_t g, uint8_t b) const { return &v[(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)) * 3]; }
};
inline const LabTable& labTable() { static const LabTable t; return t; }

/** lumaOf. */
inline double lumaOf(const uint8_t* rgba, size_t p) {
    const auto& s = srgb8ToLinear().t;
    return 0.2126 * s[rgba[p]] + 0.7152 * s[rgba[p + 1]] + 0.0722 * s[rgba[p + 2]];
}

struct Image { int width = 0, height = 0; std::vector<uint8_t> rgba; };

/** The sampler: an LCG through Math.imul, >>> 0, over 2^32. */
struct Sampler {
    uint32_t s;
    explicit Sampler(uint32_t seed) : s(seed) {}
    /** (Math.imul(s, 1664525) + 1013904223) >>> 0 is this product and sum mod 2^32. */
    double operator()() { s = s * 1664525u + 1013904223u; return s / 4294967296.0; }
};

/** openingMask: each rect (u0 v0 u1 v1) filled, floor at the start, ceil at the end; empty without rects. */
inline std::vector<uint8_t> openingMask(const std::vector<double>& rects, int W, int H) {
    if (rects.empty()) return {};
    std::vector<uint8_t> m(static_cast<size_t>(W) * H, 0);
    for (size_t k = 0; k + 3 < rects.size(); k += 4) {
        const int x0 = static_cast<int>(std::max(0.0, std::floor(rects[k] * W))), y0 = static_cast<int>(std::max(0.0, std::floor(rects[k + 1] * H)));
        const int x1 = static_cast<int>(std::min(static_cast<double>(W), std::ceil(rects[k + 2] * W))), y1 = static_cast<int>(std::min(static_cast<double>(H), std::ceil(rects[k + 3] * H)));
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) m[static_cast<size_t>(y) * W + x] = 1;
    }
    return m;
}

/** regionCandidates: each region's class indices, outside (0) and inside (1) the openings; a region with none takes every class. */
inline std::vector<std::vector<int>> regionCandidates(const std::vector<uint8_t>& openings) {
    std::vector<int> all, out, inn;
    for (int k = 0; k < static_cast<int>(openings.size()); k++) { all.push_back(k); (openings[k] ? inn : out).push_back(k); }
    return { out.empty() ? all : out, inn.empty() ? all : inn };
}

// ---- appearance classes ----

/** One photo readRegionClasses samples, and its openings (empty: none). */
struct SampledPhoto { const Image* img; std::vector<uint8_t> open; };

/** One region's k-means: its sample count, whether it ran, the final centres, member counts and squared CIELAB deviations (by k-means index). */
struct KMeansResult { size_t n = 0; bool ok = false; std::vector<double> C, count, sd; };

/** kMeansLab and its counts: the lightness-seeded k-means of the samples X. */
inline KMeansResult kMeansLab(const std::vector<double>& X, int K, int iterations, double wL) {
    KMeansResult res;
    const size_t n = X.size() / 3;
    res.n = n;
    if (K < 1 || n < static_cast<size_t>(K) * 10) return res;
    std::vector<size_t> order(n);
    for (size_t i = 0; i < n; i++) order[i] = i;
    std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) { return X[a * 3] - X[b * 3] < 0; });
    std::vector<double> C(K * 3);
    for (int k = 0; k < K; k++) { const size_t i = order[static_cast<size_t>(std::floor(((k + 0.5) / K) * static_cast<double>(n)))]; C[k * 3] = X[i * 3]; C[k * 3 + 1] = X[i * 3 + 1]; C[k * 3 + 2] = X[i * 3 + 2]; }
    std::vector<int32_t> lb(n);
    std::vector<double> sum(K * 4);
    for (int it = 0; it < iterations; it++) {
        std::fill(sum.begin(), sum.end(), 0.0);
        for (size_t i = 0; i < n; i++) {
            int best = 0;
            double bd = INFINITY;
            for (int k = 0; k < K; k++) {
                const double e0 = wL * (X[i * 3] - C[k * 3]), e1 = X[i * 3 + 1] - C[k * 3 + 1], e2 = X[i * 3 + 2] - C[k * 3 + 2];
                const double d = e0 * e0 + e1 * e1 + e2 * e2;
                if (d < bd) { bd = d; best = k; }
            }
            lb[i] = best; sum[best * 4] += X[i * 3]; sum[best * 4 + 1] += X[i * 3 + 1]; sum[best * 4 + 2] += X[i * 3 + 2]; sum[best * 4 + 3]++;
        }
        for (int k = 0; k < K; k++) if (sum[k * 4 + 3] != 0) for (int c = 0; c < 3; c++) C[k * 3 + c] = sum[k * 4 + c] / sum[k * 4 + 3];
    }
    res.C = C; res.count.assign(K, 0); res.sd.assign(K * 3, 0);
    for (int k = 0; k < K; k++) for (size_t i = 0; i < n; i++) if (lb[i] == k) {
        res.count[k]++;
        for (int c = 0; c < 3; c++) { const double e = X[i * 3 + c] - C[k * 3 + c]; res.sd[k * 3 + c] += e * e; }
    }
    res.ok = true;
    return res;
}

/** readRegionClasses up to its classes' formatting: the samples, split by region, and each region's k-means (outside, inside). */
inline std::vector<KMeansResult> appearanceKMeans(const std::vector<SampledPhoto>& photos, int samplesPerPhoto, uint32_t seed, int K, int Kopen, int iterations, double wL) {
    const auto& lab = labTable();
    Sampler rnd(seed);
    std::vector<double> X[2];
    for (const auto& ph : photos) {
        const Image& img = *ph.img;
        const double N = static_cast<double>(img.width) * img.height;
        const double take = std::min(N, static_cast<double>(samplesPerPhoto));
        for (double s = 0; s < take; s++) {
            const double q = std::floor(rnd() * N);
            const size_t qi = static_cast<size_t>(q), p = qi * 4;
            if (!img.rgba[p + 3]) continue;
            const double* v = lab.of(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
            auto& x = X[!ph.open.empty() && ph.open[qi] ? 1 : 0];
            x.push_back(v[0]); x.push_back(v[1]); x.push_back(v[2]);
        }
    }
    return { kMeansLab(X[0], K, iterations, wL), kMeansLab(X[1], Kopen, iterations, wL) };
}

/** The harvest's per-texel reading of one photo: valid (lit), luma (float) and nearest class (-1 none). */
struct HarvestTexels { std::vector<uint8_t> valid; std::vector<float> L; std::vector<int8_t> cls; };

inline HarvestTexels harvestClassify(const Image& img, const std::vector<uint8_t>& open, const std::vector<double>& meanLab, const std::vector<uint8_t>& openings, double wL) {
    const auto& lab = labTable();
    const auto cand = regionCandidates(openings);
    const size_t N = static_cast<size_t>(img.width) * img.height;
    HarvestTexels h;
    h.valid.assign(N, 0); h.L.assign(N, 0.0f); h.cls.assign(N, -1);
    for (size_t i = 0; i < N; i++) {
        const size_t p = i * 4;
        if (!img.rgba[p + 3]) continue;
        h.valid[i] = 1;
        h.L[i] = static_cast<float>(lumaOf(img.rgba.data(), p));
        const double* v = lab.of(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
        int best = 0;
        double bd = INFINITY;
        for (const int k : cand[!open.empty() && open[i] ? 1 : 0]) {
            const double* c = &meanLab[k * 3];
            const double e0 = wL * (v[0] - c[0]), e1 = v[1] - c[1], e2 = v[2] - c[2], d = e0 * e0 + e1 * e1 + e2 * e2;
            if (d < bd) { bd = d; best = k; }
        }
        h.cls[i] = static_cast<int8_t>(best);
    }
    return h;
}

// ---- texel kernels ----

/**
 * regionClassMap: each texel's nearest class among its region's (`open`: 1 inside an opening; an empty texel none), then
 * the class most of the (2r+1)-square about it holds, the texel's own on a tie, else the lowest index; a square of empty
 * texels the wall.
 */
inline std::vector<uint8_t> regionClassMap(const Image& img, const std::vector<double>& meanLab, const std::vector<uint8_t>& openings, int wall, int r, const std::vector<uint8_t>& open) {
    const auto& lab = labTable();
    const int W = img.width, H = img.height, K = static_cast<int>(meanLab.size() / 3);
    const auto cand = regionCandidates(openings);
    const size_t N = static_cast<size_t>(W) * H;
    constexpr uint8_t NONE = 255;
    std::vector<uint8_t> raw(N);
    for (size_t k = 0; k < N; k++) {
        if (!img.rgba[k * 4 + 3]) { raw[k] = NONE; continue; }
        const double* v = lab.of(img.rgba[k * 4], img.rgba[k * 4 + 1], img.rgba[k * 4 + 2]);
        int best = 0;
        double bd = INFINITY;
        for (const int c : cand[!open.empty() && open[k] ? 1 : 0]) {
            const double* m = &meanLab[c * 3];
            const double e0 = v[0] - m[0], e1 = v[1] - m[1], e2 = v[2] - m[2], d = e0 * e0 + e1 * e1 + e2 * e2;
            if (d < bd) { bd = d; best = c; }
        }
        raw[k] = static_cast<uint8_t>(best);
    }
    std::vector<uint8_t> best(N, static_cast<uint8_t>(wall));
    std::vector<uint16_t> bestN(N, 0), rawN(N, 0), row(N), cnt(N);
    for (int c = 0; c < K; c++) {
        for (int y = 0; y < H; y++) {
            int run = 0;
            const size_t o = static_cast<size_t>(y) * W;
            for (int x = 0; x < std::min(W, r); x++) if (raw[o + x] == c) run++;
            for (int x = 0; x < W; x++) {
                if (x + r < W && raw[o + x + r] == c) run++;
                row[o + x] = static_cast<uint16_t>(run);
                if (x - r >= 0 && raw[o + x - r] == c) run--;
            }
        }
        for (int x = 0; x < W; x++) {
            int run = 0;
            for (int y = 0; y < std::min(H, r); y++) run += row[static_cast<size_t>(y) * W + x];
            for (int y = 0; y < H; y++) {
                if (y + r < H) run += row[static_cast<size_t>(y + r) * W + x];
                cnt[static_cast<size_t>(y) * W + x] = static_cast<uint16_t>(run);
                if (y - r >= 0) run -= row[static_cast<size_t>(y - r) * W + x];
            }
        }
        for (size_t k = 0; k < N; k++) {
            if (cnt[k] > bestN[k]) { bestN[k] = cnt[k]; best[k] = static_cast<uint8_t>(c); }
            if (raw[k] == c) rawN[k] = cnt[k];
        }
    }
    for (size_t k = 0; k < N; k++) if (raw[k] != NONE && rawN[k] == bestN[k]) best[k] = raw[k];
    return best;
}

/** shrinkTile: a library map box-filtered to tw x th texels (floats; a normal map renormalised). */
inline std::vector<float> shrinkTile(const Image& src, int tw, int th, bool normal) {
    std::vector<float> out(static_cast<size_t>(tw) * th * 3);
    for (int ty = 0; ty < th; ty++) for (int tx = 0; tx < tw; tx++) {
        const double sw = src.width, sh = src.height;
        const int x0 = static_cast<int>(std::floor((tx * sw) / tw)), x1 = std::max(x0 + 1, static_cast<int>(std::floor(((tx + 1) * sw) / tw)));
        const int y0 = static_cast<int>(std::floor((ty * sh) / th)), y1 = std::max(y0 + 1, static_cast<int>(std::floor(((ty + 1) * sh) / th)));
        double s[3] = {0, 0, 0};
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) for (int c = 0; c < 3; c++) s[c] += src.rgba[(static_cast<size_t>(y) * src.width + x) * 4 + c] / 255.0;
        const double n = static_cast<double>(x1 - x0) * (y1 - y0);
        double v[3] = { s[0] / n, s[1] / n, s[2] / n };
        if (normal) {
            const double d[3] = { v[0] * 2 - 1, v[1] * 2 - 1, v[2] * 2 - 1 }, l = hypotOr1(d[0], d[1], d[2]);
            for (int c = 0; c < 3; c++) v[c] = (d[c] / l) * 0.5 + 0.5;
        }
        for (int c = 0; c < 3; c++) out[(static_cast<size_t>(ty) * tw + tx) * 3 + c] = static_cast<float>(v[c]);
    }
    return out;
}

// ---- planMaterialJob ----

/** One class's library set: its tile's real size and its normal and occlusion/roughness/metalness maps. */
struct RegionSet { double realSizeX = 1, realSizeY = 1; Image normal, orm; };

/** What every job reads: the classes' CIELAB means, their sets and each set's mean ORM (3 per set). */
struct PlanContext { std::vector<double> meanLab; std::vector<uint8_t> openings; int wall = 0; std::vector<RegionSet> sets; std::vector<double> setMeans; };

/** A job: its photo, metres per texel, whether it is a rebuilt facade (else a scan piece) and the square's half-side. */
struct PlanJob { const Image* img = nullptr; double texelM = 0; bool rebuilt = false; int radius = 1; std::vector<uint8_t> open; };

struct PlanResult {
    int width = 0, height = 0;
    std::vector<double> classTexels;
    std::vector<uint8_t> orm, normal;
};

inline PlanResult planJob(const PlanJob& job, const PlanContext& ctx) {
    const Image& img = *job.img;
    const int W = img.width, H = img.height, K = static_cast<int>(ctx.meanLab.size() / 3);
    const size_t N = static_cast<size_t>(W) * H;
    PlanResult r;
    r.width = W; r.height = H;
    r.classTexels.assign(K, 0);
    const auto cls = regionClassMap(img, ctx.meanLab, ctx.openings, ctx.wall, job.radius, job.open);
    for (size_t k = 0; k < N; k++) r.classTexels[cls[k]]++;
    r.orm.assign(N * 4, 0);
    if (job.rebuilt) {
        struct Tile { int tw = 0, th = 0; std::vector<float> n, o; };
        std::vector<Tile> tiles(K);
        for (int c = 0; c < K; c++) {
            if (r.classTexels[c] == 0) continue;
            const RegionSet& s = ctx.sets[c];
            Tile& t = tiles[c];
            t.tw = static_cast<int>(std::max(2.0, js::round(s.realSizeX / job.texelM))); t.th = static_cast<int>(std::max(2.0, js::round(s.realSizeY / job.texelM)));
            t.n = shrinkTile(s.normal, t.tw, t.th, true); t.o = shrinkTile(s.orm, t.tw, t.th, false);
        }
        r.normal.assign(N * 4, 0);
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
            const size_t k = static_cast<size_t>(y) * W + x;
            const Tile& t = tiles[cls[k]];
            const size_t j = (static_cast<size_t>(y % t.th) * t.tw + (x % t.tw)) * 3;
            for (int c = 0; c < 3; c++) {
                r.orm[k * 4 + c] = js::toUint8(js::round(static_cast<double>(t.o[j + c]) * 255));
                r.normal[k * 4 + c] = js::toUint8(js::round(static_cast<double>(t.n[j + c]) * 255));
            }
            r.orm[k * 4 + 3] = 255; r.normal[k * 4 + 3] = 255;
        }
        return r;
    }
    for (size_t k = 0; k < N; k++) {
        const double* m = &ctx.setMeans[static_cast<size_t>(cls[k]) * 3];
        for (int c = 0; c < 3; c++) r.orm[k * 4 + c] = js::toUint8(js::round(m[c] * 255));
        r.orm[k * 4 + 3] = 255;
    }
    return r;
}

} // namespace scratchbox::material_regions

#endif // SCRATCHBOX_MATERIAL_REGIONS_HPP
