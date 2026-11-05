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
 *  - planRebuilt / planScan: planMaterialJob's two branches (markRects, paneIdsOf, stonePanes over classify,
 *    storeyPitchOf, shrinkTile, featherWeights, forTexelsOf and the maps they write).
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
#include <unordered_map>
#include <unordered_set>
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

/** The harvest's excluded texels: each rect (u0 v0 u1 v1) filled, floor at the start, ceil at the end. */
inline std::vector<uint8_t> excludedMask(const std::vector<double>& rects, int W, int H) {
    std::vector<uint8_t> ex(static_cast<size_t>(W) * H, 0);
    for (size_t k = 0; k + 3 < rects.size(); k += 4) {
        const int x0 = static_cast<int>(std::max(0.0, std::floor(rects[k] * W))), y0 = static_cast<int>(std::max(0.0, std::floor(rects[k + 1] * H)));
        const int x1 = static_cast<int>(std::min(static_cast<double>(W), std::ceil(rects[k + 2] * W))), y1 = static_cast<int>(std::min(static_cast<double>(H), std::ceil(rects[k + 3] * H)));
        for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) ex[static_cast<size_t>(y) * W + x] = 1;
    }
    return ex;
}

// ---- appearance classes ----

/** One photo readRegionClasses samples: its image and, with the harvest, its excluded texels (empty: none). */
struct SampledPhoto { const Image* img; std::vector<uint8_t> excluded; };

/** The k-means' state: the final centres, each centre's member count and squared CIELAB deviations (by original index). */
struct KMeansResult { size_t n = 0; bool ok = false; std::vector<double> C, count, sd; };

/** readRegionClasses up to its classes' formatting: the samples, the lightness-seeded k-means, counts and spreads. */
inline KMeansResult appearanceKMeans(const std::vector<SampledPhoto>& photos, int samplesPerPhoto, uint32_t seed, int K, int iterations, double wL) {
    const auto& lab = labTable();
    Sampler rnd(seed);
    std::vector<double> X;
    for (const auto& ph : photos) {
        const Image& img = *ph.img;
        const double N = static_cast<double>(img.width) * img.height;
        const double take = std::min(N, static_cast<double>(samplesPerPhoto));
        for (double s = 0; s < take; s++) {
            const double q = std::floor(rnd() * N);
            const size_t qi = static_cast<size_t>(q), p = qi * 4;
            if (!img.rgba[p + 3] || (!ph.excluded.empty() && ph.excluded[qi])) continue;
            const double* v = lab.of(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
            X.push_back(v[0]); X.push_back(v[1]); X.push_back(v[2]);
        }
    }
    KMeansResult res;
    const size_t n = X.size() / 3;
    res.n = n;
    if (n < static_cast<size_t>(K) * 10) return res;
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

/** The harvest's per-texel reading of one photo: valid (lit, not excluded), luma (float) and nearest class (-1 none). */
struct HarvestTexels { std::vector<uint8_t> valid; std::vector<float> L; std::vector<int8_t> cls; };

inline HarvestTexels harvestClassify(const Image& img, const std::vector<uint8_t>& excluded, const std::vector<double>& meanLab, double wL) {
    const auto& lab = labTable();
    const int K = static_cast<int>(meanLab.size() / 3);
    const size_t N = static_cast<size_t>(img.width) * img.height;
    HarvestTexels h;
    h.valid.assign(N, 0); h.L.assign(N, 0.0f); h.cls.assign(N, -1);
    for (size_t i = 0; i < N; i++) {
        const size_t p = i * 4;
        if (!img.rgba[p + 3] || (!excluded.empty() && excluded[i])) continue;
        h.valid[i] = 1;
        h.L[i] = static_cast<float>(lumaOf(img.rgba.data(), p));
        const double* v = lab.of(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
        int best = 0;
        double bd = INFINITY;
        for (int k = 0; k < K; k++) {
            const double* c = &meanLab[k * 3];
            const double e0 = wL * (v[0] - c[0]), e1 = v[1] - c[1], e2 = v[2] - c[2], d = e0 * e0 + e1 * e1 + e2 * e2;
            if (d < bd) { bd = d; best = k; }
        }
        h.cls[i] = static_cast<int8_t>(best);
    }
    return h;
}

// ---- texel kernels ----

/** classify: each texel's class (texels outside `only` the wall's), with a 3 x 3 majority. */
inline std::vector<uint8_t> classify(const Image& img, const std::vector<double>& meanLab, const uint8_t* only) {
    const auto& lab = labTable();
    const int W = img.width, H = img.height, K = static_cast<int>(meanLab.size() / 3);
    const size_t N = static_cast<size_t>(W) * H;
    std::vector<uint8_t> raw(N), out(N);
    for (size_t k = 0; k < N; k++) {
        if (only && !only[k]) { raw[k] = static_cast<uint8_t>(K - 1); continue; }
        const double* v = lab.of(img.rgba[k * 4], img.rgba[k * 4 + 1], img.rgba[k * 4 + 2]);
        int best = 0;
        double bd = INFINITY;
        for (int c = 0; c < K; c++) {
            const double* m = &meanLab[c * 3];
            const double e0 = v[0] - m[0], e1 = v[1] - m[1], e2 = v[2] - m[2], d = e0 * e0 + e1 * e1 + e2 * e2;
            if (d < bd) { bd = d; best = c; }
        }
        raw[k] = static_cast<uint8_t>(best);
    }
    std::vector<uint16_t> votes(K);
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        std::fill(votes.begin(), votes.end(), 0);
        for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
            const int yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) votes[raw[static_cast<size_t>(yy) * W + xx]]++;
        }
        int best = raw[static_cast<size_t>(y) * W + x];
        for (int c = 0; c < K; c++) if (votes[c] > votes[best]) best = c;
        out[static_cast<size_t>(y) * W + x] = static_cast<uint8_t>(best);
    }
    return out;
}

/** A rect's texel span (Math.round of its UVs, clamped). */
struct Span { int x0, x1, y0, y1; };
inline Span spanOf(const std::vector<double>& rects, size_t i, int W, int H) {
    return { static_cast<int>(std::max(0.0, js::round(rects[i] * W))), static_cast<int>(std::min(static_cast<double>(W), js::round(rects[i + 2] * W))),
             static_cast<int>(std::max(0.0, js::round(rects[i + 1] * H))), static_cast<int>(std::min(static_cast<double>(H), js::round(rects[i + 3] * H))) };
}

/** markRects with value 1: marks the rects' unmarked texels (within `inside` when given); returns how many. */
inline size_t markRects(const std::vector<double>& rects, int W, int H, std::vector<uint8_t>& mask, const uint8_t* inside = nullptr) {
    size_t n = 0;
    for (size_t i = 0; i + 3 < rects.size(); i += 4) {
        const Span s = spanOf(rects, i, W, H);
        for (int y = s.y0; y < s.y1; y++) for (int x = s.x0; x < s.x1; x++) { const size_t k = static_cast<size_t>(y) * W + x; if (!mask[k] && (!inside || inside[k])) { mask[k] = 1; n++; } }
    }
    return n;
}

/** paneIdsOf: each texel's rect (index + 1; 0 none), the first rect holding it, within `inside` (null: everywhere). */
inline std::vector<int32_t> paneIdsOf(const std::vector<double>& rects, int W, int H, const uint8_t* inside) {
    std::vector<int32_t> ids(static_cast<size_t>(W) * H, 0);
    for (size_t i = 0; i + 3 < rects.size(); i += 4) {
        const Span s = spanOf(rects, i, W, H);
        const int32_t id = static_cast<int32_t>(i / 4 + 1);
        for (int y = s.y0; y < s.y1; y++) for (int x = s.x0; x < s.x1; x++) { const size_t k = static_cast<size_t>(y) * W + x; if (!ids[k] && (!inside || inside[k])) ids[k] = id; }
    }
    return ids;
}

/** stonePanes: the ids at least `share` of whose texels the classes read as the wall's. */
inline std::unordered_set<int32_t> stonePanes(const Image& img, const std::vector<double>& meanLab, const std::vector<int32_t>& ids, double share) {
    const size_t N = ids.size();
    std::vector<uint8_t> mask(N);
    bool any = false;
    for (size_t k = 0; k < N; k++) { mask[k] = ids[k] ? 1 : 0; any = any || mask[k]; }
    std::unordered_set<int32_t> out;
    if (!any) return out;
    const auto cls = classify(img, meanLab, mask.data());
    const int WALL = static_cast<int>(meanLab.size() / 3) - 1;
    std::unordered_map<int32_t, std::pair<double, double>> n;
    for (size_t k = 0; k < N; k++) if (ids[k]) { auto& c = n[ids[k]]; c.first++; if (cls[k] == WALL) c.second++; }
    for (const auto& [id, c] : n) if (c.second >= share * c.first) out.insert(id);
    return out;
}

/** storeyPitchOf: the median step between windows one above another, and the median phase; none with fewer than 3 steps. */
struct Storey { bool ok = false; double pitch = 0, phase = 0; };
inline Storey storeyPitchOf(const std::vector<double>& rects, int W, int H) {
    struct Wn { double cx, w, y; };
    std::vector<Wn> ws;
    for (size_t i = 0; i + 3 < rects.size(); i += 4) ws.push_back({ (rects[i] + rects[i + 2]) / 2 * W, (rects[i + 2] - rects[i]) * W, rects[i + 1] * H });
    std::stable_sort(ws.begin(), ws.end(), [](const Wn& a, const Wn& b) { const double d = a.cx - b.cx; return (d != 0 ? d : a.y - b.y) < 0; });
    std::vector<double> steps;
    for (size_t i = 0; i < ws.size(); i++) for (size_t j = i + 1; j < ws.size(); j++) {
        if (std::fabs(ws[j].cx - ws[i].cx) > 0.5 * std::min(ws[i].w, ws[j].w)) continue;
        const double d = std::fabs(ws[j].y - ws[i].y);
        if (d > 2) { steps.push_back(d); break; }
    }
    Storey s;
    if (steps.size() < 3) return s;
    std::sort(steps.begin(), steps.end());
    s.pitch = steps[steps.size() >> 1];
    std::vector<double> phases;
    for (const auto& w : ws) phases.push_back(std::fmod(std::fmod(w.y, s.pitch) + s.pitch, s.pitch));
    std::sort(phases.begin(), phases.end());
    s.phase = phases[phases.size() >> 1];
    s.ok = true;
    return s;
}

/** paneSeed: 1 + (Math.imul(pane + 1, 2654435761) >>> 0) % 254. */
inline uint8_t paneSeed(double pane) { return static_cast<uint8_t>(1 + (js::toUint32(pane + 1) * 2654435761u) % 254u); }

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

/** featherWeights: each glass texel's chamfer distance to the nearest texel that is not glass, over `ramp`, capped at 1 (floats). */
template <typename T>
inline std::vector<float> featherWeights(const std::vector<T>& glass, int W, int H, double ramp) {
    const size_t N = static_cast<size_t>(W) * H;
    std::vector<float> d(N);
    for (size_t k = 0; k < N; k++) d[k] = glass[k] ? 1e9f : 0.0f;
    auto relax = [&](size_t k, size_t j, double c) { if (static_cast<double>(d[j]) + c < static_cast<double>(d[k])) d[k] = static_cast<float>(static_cast<double>(d[j]) + c); };
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        const size_t k = static_cast<size_t>(y) * W + x;
        if (d[k] == 0) continue;
        if (x == 0 || y == 0 || x == W - 1 || y == H - 1) d[k] = static_cast<float>(std::min(static_cast<double>(d[k]), 1.0));
        if (x > 0) relax(k, k - 1, 1);
        if (y > 0) { relax(k, k - W, 1); if (x > 0) relax(k, k - W - 1, 1.414); if (x < W - 1) relax(k, k - W + 1, 1.414); }
    }
    for (int y = H - 1; y >= 0; y--) for (int x = W - 1; x >= 0; x--) {
        const size_t k = static_cast<size_t>(y) * W + x;
        if (d[k] == 0) continue;
        if (x < W - 1) relax(k, k + 1, 1);
        if (y < H - 1) { relax(k, k + W, 1); if (x < W - 1) relax(k, k + W + 1, 1.414); if (x > 0) relax(k, k + W - 1, 1.414); }
    }
    const double den = std::max(1.0, ramp);
    std::vector<float> out(N);
    for (size_t k = 0; k < N; k++) { const double v = d[k]; out[k] = v != 0 ? static_cast<float>(std::min(1.0, v / den)) : 0.0f; }
    return out;
}

/** forTexelsOf: the texels of a triangle given in UVs (uv * size) whose centres it holds, with their barycentric weights. */
template <typename F>
inline void forTexelsOf(const double* uv, int W, int H, F&& visit) {
    const double ax = uv[0] * W, ay = uv[1] * H, bx = uv[2] * W, by = uv[3] * H, cx = uv[4] * W, cy = uv[5] * H;
    const double den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (std::fabs(den) < 1e-12) return;
    const double x0 = std::max(0.0, std::floor(std::min({ax, bx, cx}))), x1 = std::min(static_cast<double>(W - 1), std::ceil(std::max({ax, bx, cx})));
    const double y0 = std::max(0.0, std::floor(std::min({ay, by, cy}))), y1 = std::min(static_cast<double>(H - 1), std::ceil(std::max({ay, by, cy})));
    for (double y = y0; y <= y1; y++) for (double x = x0; x <= x1; x++) {
        const double px = x + 0.5, py = y + 0.5;
        const double wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, wc = 1 - wa - wb;
        if (wa >= 0 && wb >= 0 && wc >= 0) visit(static_cast<size_t>(y * W + x), wa, wb, wc);
    }
}

// ---- planMaterialJob ----

/** One class's library set: its tile's real size and its normal and occlusion/roughness/metalness maps; `metal`: the class
 * was read confidently as metal and its set is one, so its metalness is drawn (else none). */
struct RegionSet { double realSizeX = 1, realSizeY = 1; bool metal = false; Image normal, orm; };

struct PlanParams { double paneWallShare = 0.5, glassFeatherM = 0.15, paneGlassWeight = 128, glassRoughness = 0.05; };

/** What every job reads: the classes' CIELAB means, their sets, the sets' mean roughness (G) and the params. */
struct PlanContext { std::vector<double> meanLab; std::vector<RegionSet> sets; std::vector<double> setMeanG; double wallMeanG = 0; std::vector<double> setMeanB; double wallMeanB = 0; PlanParams P; };

/** A rebuilt facade's job: its photo, metres per texel and its lattice's rects (u0 v0 u1 v1 each). */
struct RebuiltJob { const Image* img = nullptr; double texelM = 0; std::vector<double> fitted, panes, runs, bays; };

struct RebuiltResult {
    int width = 0, height = 0, frameClass = 0;
    double windowN = 0, stoneN = 0, paneN = 0, panesOnStone = 0, baysOnStone = 0, texels = 0, glass = 0;
    std::vector<uint8_t> orm, normal, params;
};

inline RebuiltResult planRebuilt(const RebuiltJob& job, const PlanContext& ctx) {
    const Image& img = *job.img;
    const int W = img.width, H = img.height, K = static_cast<int>(ctx.meanLab.size() / 3), WALL = K - 1;
    const size_t N = static_cast<size_t>(W) * H;
    const double texelM = job.texelM;
    RebuiltResult r;
    r.width = W; r.height = H;
    std::vector<uint8_t> window(N, 0), pane(N, 0), stone(N, 0);
    r.windowN = static_cast<double>(markRects(job.fitted, W, H, window));
    r.stoneN = static_cast<double>(markRects(job.runs, W, H, stone));
    const auto bayId = paneIdsOf(job.bays, W, H, nullptr);
    const auto stoneBays = stonePanes(img, ctx.meanLab, bayId, ctx.P.paneWallShare);
    const auto allPanes = paneIdsOf(job.panes, W, H, nullptr);
    std::unordered_set<int32_t> panedBays;
    for (size_t k = 0; k < N; k++) if (allPanes[k] && bayId[k]) panedBays.insert(bayId[k]);
    auto glassBay = [&](size_t k) { return bayId[k] && !stoneBays.count(bayId[k]) && (!panedBays.count(bayId[k]) || allPanes[k]); };
    const Storey storey = storeyPitchOf(job.fitted, W, H);
    double paneN = 0;
    for (size_t k = 0; k < N; k++) if (glassBay(k)) {
        const double st = storey.ok ? std::floor((std::floor(static_cast<double>(k) / W) - storey.phase) / storey.pitch) : 0;
        pane[k] = paneSeed((bayId[k] - 1) * 997.0 + st + 500); paneN++;
    }
    std::vector<uint8_t> loose(N);
    for (size_t k = 0; k < N; k++) loose[k] = window[k] && !glassBay(k) ? 1 : 0;
    const auto paneIds = paneIdsOf(job.panes, W, H, loose.data());
    const auto stoneIds = stonePanes(img, ctx.meanLab, paneIds, ctx.P.paneWallShare);
    for (size_t k = 0; k < N; k++) if (paneIds[k] && !stoneIds.count(paneIds[k])) { pane[k] = paneSeed(100000.0 + paneIds[k]); paneN++; }
    r.panesOnStone = static_cast<double>(stoneIds.size());
    r.baysOnStone = static_cast<double>(stoneBays.size());
    auto framed = [&](size_t k) { return !pane[k] && (bayId[k] || window[k]); };
    int frameClass = WALL;
    std::vector<uint8_t> frameMask(N);
    bool anyFrame = false;
    for (size_t k = 0; k < N; k++) { frameMask[k] = framed(k) ? 1 : 0; anyFrame = anyFrame || frameMask[k]; }
    if (anyFrame) {
        const auto cls = classify(img, ctx.meanLab, frameMask.data());
        std::vector<uint32_t> inFrames(K, 0);
        for (size_t k = 0; k < N; k++) if (frameMask[k] && cls[k] != WALL) inFrames[cls[k]]++;
        for (int c = 0; c < WALL; c++) if (inFrames[c] && (frameClass == WALL || inFrames[c] > inFrames[frameClass])) frameClass = c;
    }
    r.frameClass = frameClass;

    struct Tile { int tw, th; std::vector<float> n, o; bool metal = false; };
    auto tileOf = [&](const RegionSet& s) {
        Tile t;
        t.tw = static_cast<int>(std::max(2.0, js::round(s.realSizeX / texelM))); t.th = static_cast<int>(std::max(2.0, js::round(s.realSizeY / texelM)));
        t.n = shrinkTile(s.normal, t.tw, t.th, true); t.o = shrinkTile(s.orm, t.tw, t.th, false); t.metal = s.metal;
        return t;
    };
    const Tile wallTile = tileOf(ctx.sets[WALL]);
    const Tile frameOwn = frameClass == WALL ? Tile{} : tileOf(ctx.sets[frameClass]);
    const Tile& frameTile = frameClass == WALL ? wallTile : frameOwn;
    const auto fw = featherWeights(pane, W, H, ctx.P.glassFeatherM / texelM);
    r.orm.assign(N * 4, 0); r.normal.assign(N * 4, 0); r.params.assign(N * 4, 0);
    // the set's roughness; metalness 0 unless the class's set is a metal read as such (RegionSet::metal), and never on glass
    auto write = [&](size_t k, double rough, double glassWeight, double seed, double metal = 0) {
        const uint8_t mb = glassWeight != 0 ? 0 : js::toUint8(js::round(std::max(0.0, std::min(1.0, metal)) * 255));
        r.orm[k * 4] = 255; r.orm[k * 4 + 1] = js::toUint8(js::round(rough * 255)); r.orm[k * 4 + 2] = mb; r.orm[k * 4 + 3] = 255;
        r.params[k * 4] = js::toUint8(glassWeight); r.params[k * 4 + 2] = mb; r.params[k * 4 + 3] = js::toUint8(seed);
        r.texels++;
        if (glassWeight != 0) r.glass++;
    };
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) {
        const size_t k = static_cast<size_t>(y) * W + x;
        const Tile& t = pane[k] || framed(k) ? frameTile : wallTile;
        const size_t j = (static_cast<size_t>(y % t.th) * t.tw + (x % t.tw)) * 3;
        const double a = fw[k];
        if (pane[k]) {
            const double o1 = t.o[j + 1];
            write(k, o1 + (ctx.P.glassRoughness - o1) * a, std::max(1.0, js::round(ctx.P.paneGlassWeight * a)), pane[k]);
            double n[3];
            for (int c = 0; c < 3; c++) n[c] = (static_cast<double>(t.n[j + c]) * 2 - 1) * (1 - a) + (c == 2 ? a : 0);
            const double l = hypotOr1(n[0], n[1], n[2]);
            for (int c = 0; c < 3; c++) r.normal[k * 4 + c] = js::toUint8(js::round(((n[c] / l) * 0.5 + 0.5) * 255));
            r.normal[k * 4 + 3] = 255;
            continue;
        }
        write(k, t.o[j + 1], 0, 255, t.metal ? t.o[j + 2] : 0);
        for (int c = 0; c < 3; c++) r.normal[k * 4 + c] = js::toUint8(js::round(static_cast<double>(t.n[j + c]) * 255));
        r.normal[k * 4 + 3] = 255;
    }
    r.paneN = paneN;
    return r;
}

/** A fitted plane's rasters in its ortho's pixels (materialPlanContext's rasters): windows, bay ids, pane ids, storey. */
struct PlaneRaster {
    int width = 0, height = 0;
    double orthoSMin = 0, orthoTMax = 0, pixel = 1;
    Storey storey;
    std::vector<uint8_t> win;
    std::vector<int32_t> bay, pane;
    std::unordered_set<int32_t> panedBays;
};

/** A scan triangle on its nearest plane: its UVs and its corners' plane coordinates (s, t). */
struct ScanTriangle { uint32_t plane; double uv[6], sv[3], tv[3]; };

struct ScanJob { const Image* img = nullptr; double texelM = 0; std::vector<ScanTriangle> tris; };

struct ScanResult {
    int width = 0, height = 0, frameClass = 0;
    double onPlane = 0, inWindows = 0, inPanes = 0, texels = 0, glass = 0, panesOnStone = 0, baysOnStone = 0;
    bool anyGlass = false;
    std::vector<uint8_t> orm, params;
};

inline ScanResult planScan(const ScanJob& job, const std::vector<PlaneRaster>& planes, const PlanContext& ctx) {
    const Image& img = *job.img;
    const int W = img.width, H = img.height, K = static_cast<int>(ctx.meanLab.size() / 3), WALL = K - 1;
    const size_t N = static_cast<size_t>(W) * H;
    ScanResult r;
    r.width = W; r.height = H;
    std::vector<uint8_t> on(N, 0), win(N, 0), pane(N, 0), onPane(N, 0), paned(N, 0);
    std::vector<int32_t> bayId(N, 0), storeyOf(N, 0), paneAt(N, 0);
    for (const auto& tri : job.tris) {
        const PlaneRaster& b = planes[tri.plane];
        forTexelsOf(tri.uv, W, H, [&](size_t k, double wa, double wb, double wc) {
            on[k] = 1;
            const double x = std::floor((wa * tri.sv[0] + wb * tri.sv[1] + wc * tri.sv[2] - b.orthoSMin) / b.pixel), y = std::floor((b.orthoTMax - (wa * tri.tv[0] + wb * tri.tv[1] + wc * tri.tv[2])) / b.pixel);
            if (x < 0 || y < 0 || x >= b.width || y >= b.height) return;
            const size_t j = static_cast<size_t>(y * b.width + x);
            if (b.win[j]) win[k] = 1;
            if (b.bay[j]) { bayId[k] = b.bay[j]; storeyOf[k] = b.storey.ok ? js::toInt32(std::floor((y - b.storey.phase) / b.storey.pitch)) : 0; if (b.panedBays.count(b.bay[j])) paned[k] = 1; }
            if (b.pane[j]) { onPane[k] = 1; paneAt[k] = b.pane[j]; }
        });
    }
    const auto stoneBays = stonePanes(img, ctx.meanLab, bayId, ctx.P.paneWallShare);
    for (size_t k = 0; k < N; k++) if (bayId[k] && !stoneBays.count(bayId[k]) && (!paned[k] || onPane[k])) pane[k] = paneSeed((bayId[k] - 1) * 997.0 + storeyOf[k] + 500);
    r.baysOnStone = static_cast<double>(stoneBays.size());
    std::vector<int32_t> loose(N);
    for (size_t k = 0; k < N; k++) loose[k] = paneAt[k] && !bayId[k] ? paneAt[k] : 0;
    const auto stoneLoose = stonePanes(img, ctx.meanLab, loose, ctx.P.paneWallShare);
    for (size_t k = 0; k < N; k++) if (loose[k] && !stoneLoose.count(loose[k])) pane[k] = paneSeed(100000.0 + loose[k]);
    r.panesOnStone = static_cast<double>(stoneLoose.size());
    int frameClass = WALL;
    std::vector<uint8_t> frameMask(N);
    bool anyFrame = false;
    for (size_t k = 0; k < N; k++) { frameMask[k] = (win[k] || bayId[k]) && !pane[k] ? 1 : 0; anyFrame = anyFrame || frameMask[k]; }
    if (anyFrame) {
        const auto cls = classify(img, ctx.meanLab, frameMask.data());
        std::vector<uint32_t> n(K, 0);
        for (size_t k = 0; k < N; k++) if (frameMask[k] && cls[k] != WALL) n[cls[k]]++;
        for (int c = 0; c < WALL; c++) if (n[c] && (frameClass == WALL || n[c] > n[frameClass])) frameClass = c;
    }
    r.frameClass = frameClass;
    const auto fw = featherWeights(pane, W, H, job.texelM > 0 ? ctx.P.glassFeatherM / job.texelM : 1);
    r.orm.assign(N * 4, 0); r.params.assign(N * 4, 0);
    for (size_t k = 0; k < N; k++) {
        const bool framedK = pane[k] || win[k] || bayId[k];
        const double rough = framedK ? ctx.setMeanG[frameClass] : ctx.wallMeanG;
        const double metal = (framedK ? ctx.sets[frameClass] : ctx.sets[WALL]).metal ? (framedK ? ctx.setMeanB[frameClass] : ctx.wallMeanB) : 0;
        const uint8_t mb = pane[k] ? 0 : js::toUint8(js::round(std::max(0.0, std::min(1.0, metal)) * 255));
        const double gw = pane[k] ? std::max(1.0, js::round(ctx.P.paneGlassWeight * fw[k])) : 0;
        const double v = pane[k] ? rough + (ctx.P.glassRoughness - rough) * fw[k] : rough;
        r.orm[k * 4] = 255; r.orm[k * 4 + 1] = js::toUint8(js::round(v * 255)); r.orm[k * 4 + 2] = mb; r.orm[k * 4 + 3] = 255;
        r.params[k * 4] = js::toUint8(gw); r.params[k * 4 + 2] = mb; r.params[k * 4 + 3] = pane[k] ? pane[k] : 255;
        r.texels++;
        if (gw != 0) r.glass++;
        r.onPlane += on[k]; r.inWindows += win[k]; if (pane[k]) { r.inPanes++; r.anyGlass = true; }
    }
    return r;
}

} // namespace scratchbox::material_regions

#endif // SCRATCHBOX_MATERIAL_REGIONS_HPP
