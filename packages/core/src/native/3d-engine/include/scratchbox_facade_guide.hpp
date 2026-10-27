/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_FACADE_GUIDE_HPP
#define SCRATCHBOX_FACADE_GUIDE_HPP

#include "scratchbox_geometry.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_png.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <map>
#include <string>
#include <vector>

/**
 * A real building's facades as photographed and straightened by pipeline K (rectified orthos on the scan's fitted facade
 * planes, about 8 cm a pixel), used to guide a procedural build of the same building:
 *
 *  - registration: a built facade is slid over the photo, within one bay and one storey, to where its glass lands on the
 *    photo's dark windows and its walls on the photo's light surfaces (the score is the walls' mean brightness minus the
 *    glass's), so what the build calls a pier reads the photo's pier;
 *  - colours per part: every built part reads the photo where it lands after registration (lit, trimmed means);
 *  - stain: each pixel of the facade's original ortho is compared with its own repeats one and two bays away along the
 *    facade (the median of those that are covered): windows, piers and spandrels repeat and cancel, and what is left is
 *    what breaks the repeat, such as run-off columns, weathered patches and damp. The log residual is low-passed (a
 *    fraction of a bay wide, half a storey tall), and darkening becomes stain the weathering bake paints (photo-inferred).
 *
 * Planes arrive in the build's frame (site-guides.ts relates K's frame to it). A point reads a facade when it faces the
 * same way (normal agreement), lies within `depthToleranceM` of the plane and inside its extent.
 */
namespace scratchbox {
namespace facade_guide {

using math::Vec2;
using math::Vec3;

struct Facade {
    int id{0};
    Vec3 c, n, s, t;
    float sMin{0}, sMax{0}, tMin{0}, tMax{0}, pixel{0.08f}, oSMin{0}, oTMax{0};
    int W{0}, H{0};
    texture::ImageBuffer rect;          // straightened ortho (RGB)
    std::vector<uint8_t> uncovered;     // 1 where the photo never reached
    float periodPx{0}, storeyPx{0};
    std::vector<float> stainLog;        // low-passed log residual against the repeats (negative: darker), NaN: unknown
    float shiftS{0}, shiftT{0};         // registration: the build's facade slides by this to meet the photo (m)
    float regScore{0}, regScoreAtZero{0};
    int regGlass{0}, regWall{0};
    // The photo's own lattice: light pier columns against dark infill (windows and spandrels between them).
    struct Lattice {
        bool ok{false};
        float pitchM{0}, pierWidthM{0}, lightShare{0}, contrast{0};
        Vec3 pier{0, 0, 0}, infill{0, 0, 0}, glass{0, 0, 0};   // linear
        int piers{0};
        std::vector<float> centresPx;   // pier centres along the photo (x)
        float pierWidthPx{0}, cut{0};   // the median pier width; the light/dark split of the column profile
    } lattice;
};

struct GuideSet {
    std::vector<Facade> facades;
    float depthToleranceM{2.0f}, minNormalDot{0.85f};
    std::vector<std::string> notes;

    /** The facade a surface point reads, and its pixel (registered), or -1. */
    int locate(const Vec3& p, const Vec3& nrm, float& px, float& py, bool registered = true) const {
        int best = -1; float bestD = 1e30f;
        for (size_t i = 0; i < facades.size(); ++i) {
            const Facade& f = facades[i];
            if (nrm.dot(f.n) < minNormalDot) continue;
            const Vec3 r = p - f.c;
            const float d = std::abs(r.dot(f.n));
            if (d > depthToleranceM || d >= bestD) continue;
            const float sv = r.dot(f.s) + (registered ? f.shiftS : 0.0f), tv = r.dot(f.t) + (registered ? f.shiftT : 0.0f);
            if (sv < f.sMin || sv > f.sMax || tv < f.tMin || tv > f.tMax) continue;
            const float x = (sv - f.oSMin) / f.pixel, y = (f.oTMax - tv) / f.pixel;
            if (x < 0 || y < 0 || x >= f.W || y >= f.H) continue;
            best = int(i); bestD = d; px = x; py = y;
        }
        return best;
    }

    /** The photo's linear colour at a point (registered), or false where it is uncovered or no facade reads it. */
    bool colourAt(const Vec3& p, const Vec3& nrm, Vec3& lin) const {
        float x, y;
        const int i = locate(p, nrm, x, y);
        if (i < 0) return false;
        const Facade& f = facades[i];
        const size_t k = size_t(int(y)) * f.W + size_t(int(x));
        if (f.uncovered.size() == size_t(f.W) * f.H && f.uncovered[k]) return false;
        const uint8_t* q = &f.rect.data[k * f.rect.channels];
        auto L = [](uint8_t v) { const float c = v / 255.0f; return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
        lin = Vec3(L(q[0]), L(q[1]), L(q[2]));
        return true;
    }

    /** The stain at a point: the photo's darkening against its repeats (0..1) and its colour there, or false. */
    bool stainAt(const Vec3& p, const Vec3& nrm, float& alpha, Vec3& lin) const {
        float x, y;
        const int i = locate(p, nrm, x, y);
        if (i < 0) return false;
        const Facade& f = facades[i];
        if (f.stainLog.empty()) return false;
        const size_t k = size_t(int(y)) * f.W + size_t(int(x));
        const float r = f.stainLog[k];
        if (std::isnan(r)) return false;
        alpha = std::clamp(1.0f - std::exp(r), 0.0f, 0.85f);   // r < 0: darker than its repeats by exp(r)
        if (!colourAt(p, nrm, lin)) lin = Vec3(0.2f, 0.18f, 0.16f);
        return true;
    }
};

namespace detail {

inline bool readPng(const std::string& path, png::OutputFormat fmt, texture::ImageBuffer& out, std::string& err) {
    std::ifstream in(path, std::ios::binary);
    if (!in) { err = "cannot open " + path; return false; }
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    auto r = png::decode(bytes.data(), bytes.size(), fmt);
    if (!r.ok) { err = path + ": " + r.error; return false; }
    out = std::move(r.image);
    return true;
}

/** Separable box filter of `v` over cells where `w` > 0 (normalised by the weight inside the window). */
inline std::vector<float> boxMean(const std::vector<float>& v, const std::vector<float>& w, int W, int H, int hx, int hy) {
    std::vector<float> rv(size_t(W) * H, 0.0f), rw(size_t(W) * H, 0.0f), out(size_t(W) * H, NAN);
    for (int y = 0; y < H; ++y) {
        double sv = 0, sw = 0;
        for (int x = -hx; x < W; ++x) {
            const int a = x + hx, b = x - hx - 1;
            if (a < W) { sv += v[size_t(y) * W + a] * w[size_t(y) * W + a]; sw += w[size_t(y) * W + a]; }
            if (b >= 0) { sv -= v[size_t(y) * W + b] * w[size_t(y) * W + b]; sw -= w[size_t(y) * W + b]; }
            if (x >= 0) { rv[size_t(y) * W + x] = float(sv); rw[size_t(y) * W + x] = float(sw); }
        }
    }
    for (int x = 0; x < W; ++x) {
        double sv = 0, sw = 0;
        for (int y = -hy; y < H; ++y) {
            const int a = y + hy, b = y - hy - 1;
            if (a < H) { sv += rv[size_t(a) * W + x]; sw += rw[size_t(a) * W + x]; }
            if (b >= 0) { sv -= rv[size_t(b) * W + x]; sw -= rw[size_t(b) * W + x]; }
            if (y >= 0 && sw > 0.5) out[size_t(y) * W + x] = float(sv / sw);
        }
    }
    return out;
}

/** The repeat residual of an ortho: log luminance minus the median of the same pixel one and two pitches away. */
inline std::vector<float> repeatResidual(const texture::ImageBuffer& img, const std::vector<uint8_t>& uncovered, float periodPx, float storeyPx) {
    const int W = img.width, H = img.height;
    std::vector<float> logL(size_t(W) * H, NAN);
    for (size_t i = 0; i < size_t(W) * H; ++i) {
        if (!uncovered.empty() && uncovered[i]) continue;
        const uint8_t* q = &img.data[i * img.channels];
        if (q[0] == 128 && q[1] == 128 && q[2] == 128) continue;   // the ortho's exact grey: not photographed
        auto L = [](uint8_t v) { const float c = v / 255.0f; return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
        logL[i] = std::log(std::max(1e-3f, 0.2126f * L(q[0]) + 0.7152f * L(q[1]) + 0.0722f * L(q[2])));
    }
    const int P = std::max(2, int(std::lround(periodPx)));
    std::vector<float> resid(size_t(W) * H, 0.0f), weight(size_t(W) * H, 0.0f);
    float rep[4];
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            const size_t i = size_t(y) * W + x;
            if (std::isnan(logL[i])) continue;
            int n = 0;
            for (int k : {-2, -1, 1, 2}) {
                const int xx = x + k * P;
                if (xx < 0 || xx >= W) continue;
                const float v = logL[size_t(y) * W + xx];
                if (!std::isnan(v)) rep[n++] = v;
            }
            if (n < 2) continue;
            std::sort(rep, rep + n);
            const float med = n % 2 ? rep[n / 2] : 0.5f * (rep[n / 2 - 1] + rep[n / 2]);
            resid[i] = logL[i] - med;
            weight[i] = 1.0f;
        }
    }
    const int hx = std::max(1, int(std::lround(0.15f * P))), hy = std::max(2, int(std::lround(0.5f * std::max(storeyPx, 0.5f * P))));
    return boxMean(resid, weight, W, H, hx, hy);
}

}  // namespace detail

struct FacadeIn {
    int id{0};
    std::string image, original, uncovered;
    Vec3 c, n, s, t;
    float sMin{0}, sMax{0}, tMin{0}, tMax{0}, pixel{0}, oSMin{0}, oTMax{0};
    int W{0}, H{0};
    float periodM{0}, storeyM{0};
};

namespace detail {

/**
 * The lattice a straightened facade photo shows: the column profile (mean luminance down each column, over covered
 * pixels) split by Otsu into light and dark columns; light runs at least 0.4 m wide are piers. Pier width is the median
 * run width, pitch the median spacing of pier centres (or K's measured period when given); colours are the lit middle of
 * the pier columns, of the dark columns (infill), and the darkest fifth of the dark columns (glass).
 */
/** A pixel no photo filled: transparent, or the exact grey 128 the orthos leave where the scan had no photo. */
inline bool unfilled(const uint8_t* q, int channels) {
    return (channels == 4 && q[3] < 128) || (q[0] == 128 && q[1] == 128 && q[2] == 128);
}

inline void measureLattice(Facade& f, float periodM) {
    auto L = [](uint8_t v) { const float c = v / 255.0f; return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
    const int W = f.W, H = f.H;
    std::vector<double> sum(W, 0.0); std::vector<int> cnt(W, 0);
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            const size_t k = size_t(y) * W + x;
            if (!f.uncovered.empty() && f.uncovered[k]) continue;
            const uint8_t* q = &f.rect.data[k * f.rect.channels];
            if (unfilled(q, f.rect.channels)) continue;
            sum[x] += 0.2126 * L(q[0]) + 0.7152 * L(q[1]) + 0.0722 * L(q[2]); ++cnt[x];
        }
    std::vector<float> prof(W, NAN);
    std::vector<float> vals;
    for (int x = 0; x < W; ++x) if (cnt[x] > H / 10) { prof[x] = float(sum[x] / cnt[x]); vals.push_back(prof[x]); }
    if (vals.size() < 20) return;
    std::sort(vals.begin(), vals.end());
    // Otsu on the column means
    double best = -1, cut = vals[vals.size() / 2], acc = 0, total = 0;
    for (float v : vals) total += v;
    for (size_t k = 1; k < vals.size(); ++k) {
        acc += vals[k - 1];
        const double w0 = double(k) / vals.size(), m0 = acc / k, m1 = (total - acc) / (vals.size() - k);
        const double b = w0 * (1 - w0) * (m1 - m0) * (m1 - m0);
        if (b > best) { best = b; cut = 0.5 * (vals[k - 1] + vals[k]); }
    }
    std::vector<int> centres; std::vector<float> widths;
    int run = -1, light = 0, covered = 0;
    for (int x = 0; x <= W; ++x) {
        const bool isLight = x < W && !std::isnan(prof[x]) && prof[x] > cut;
        if (x < W && !std::isnan(prof[x])) { ++covered; if (isLight) ++light; }
        if (isLight && run < 0) run = x;
        if (!isLight && run >= 0) {
            const float w = (x - run) * f.pixel;
            if (w >= 0.4f) { widths.push_back(w); centres.push_back((run + x) / 2); f.lattice.centresPx.push_back(0.5f * (run + x)); }
            run = -1;
        }
    }
    if (widths.size() < 2) return;
    std::sort(widths.begin(), widths.end());
    f.lattice.pierWidthM = widths[widths.size() / 2];
    f.lattice.pierWidthPx = f.lattice.pierWidthM / f.pixel;
    f.lattice.cut = float(cut);
    std::vector<float> gaps;
    for (size_t k = 1; k < centres.size(); ++k) gaps.push_back((centres[k] - centres[k - 1]) * f.pixel);
    std::sort(gaps.begin(), gaps.end());
    f.lattice.pitchM = periodM > 0 ? periodM : gaps[gaps.size() / 2];
    f.lattice.piers = int(widths.size());
    f.lattice.lightShare = covered ? float(light) / covered : 0.0f;
    // colours from the pixels of light and dark columns
    std::vector<std::pair<float, Vec3>> lp, dp;
    for (int y = 0; y < H; y += 2)
        for (int x = 0; x < W; x += 2) {
            const size_t k = size_t(y) * W + x;
            if (std::isnan(prof[x]) || (!f.uncovered.empty() && f.uncovered[k])) continue;
            const uint8_t* q = &f.rect.data[k * f.rect.channels];
            if (unfilled(q, f.rect.channels)) continue;
            const Vec3 lin(L(q[0]), L(q[1]), L(q[2]));
            (prof[x] > cut ? lp : dp).push_back({0.2126f * lin.x + 0.7152f * lin.y + 0.0722f * lin.z, lin});
        }
    auto mean = [](std::vector<std::pair<float, Vec3>>& v, double a, double b) {
        std::sort(v.begin(), v.end(), [](const auto& p, const auto& q) { return p.first < q.first; });
        const size_t i0 = size_t(v.size() * a), i1 = std::max(i0 + 1, size_t(v.size() * b));
        Vec3 s(0, 0, 0);
        for (size_t i = i0; i < i1 && i < v.size(); ++i) s = s + v[i].second;
        return s * (1.0f / float(std::min(i1, v.size()) - i0));
    };
    if (lp.size() < 50 || dp.size() < 50) return;
    f.lattice.pier = mean(lp, 0.4, 0.95);
    f.lattice.infill = mean(dp, 0.4, 0.95);
    f.lattice.glass = mean(dp, 0.0, 0.2);
    auto lum = [](const Vec3& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; };
    f.lattice.contrast = lum(f.lattice.pier) / std::max(1e-4f, lum(f.lattice.infill));
    f.lattice.ok = true;
}

}  // namespace detail

/** Loads the guides: the straightened orthos, the masks, each facade's lattice and its stain from its original ortho. */
inline GuideSet load(const std::vector<FacadeIn>& in) {
    GuideSet g;
    for (const FacadeIn& fi : in) {
        Facade f;
        f.id = fi.id; f.c = fi.c; f.n = fi.n.normalized(); f.s = fi.s.normalized(); f.t = fi.t.normalized();
        f.sMin = fi.sMin; f.sMax = fi.sMax; f.tMin = fi.tMin; f.tMax = fi.tMax; f.pixel = fi.pixel; f.oSMin = fi.oSMin; f.oTMax = fi.oTMax;
        std::string err;
        if (!detail::readPng(fi.image, png::OutputFormat::Rgb, f.rect, err)) { g.notes.push_back(err); continue; }
        f.W = f.rect.width; f.H = f.rect.height;
        texture::ImageBuffer mask;
        if (!fi.uncovered.empty() && detail::readPng(fi.uncovered, png::OutputFormat::Luma, mask, err) && mask.width == f.W && mask.height == f.H) {
            f.uncovered.resize(size_t(f.W) * f.H);
            for (size_t i = 0; i < f.uncovered.size(); ++i) f.uncovered[i] = mask.data[i] > 127 ? 1 : 0;
        }
        f.periodPx = fi.periodM > 0 ? fi.periodM / f.pixel : 0.0f;
        detail::measureLattice(f, fi.periodM);
        f.storeyPx = fi.storeyM > 0 ? fi.storeyM / f.pixel : 0.0f;
        texture::ImageBuffer orig;
        if (f.periodPx > 4 && !fi.original.empty() && detail::readPng(fi.original, png::OutputFormat::Rgb, orig, err) && orig.width == f.W && orig.height == f.H) {
            f.stainLog = detail::repeatResidual(orig, f.uncovered, f.periodPx, f.storeyPx);
        } else if (f.periodPx <= 4) {
            g.notes.push_back("facade " + std::to_string(f.id) + ": no bay pitch measured, so no repeat residual");
        }
        g.facades.push_back(std::move(f));
    }
    return g;
}

/**
 * Replaces every facade's photo with pipeline K's finished model seen straight on: the model (its rebuilt facades carrying
 * the straightened, de-lit and harmonised photos) is rasterised onto each facade's plane at the facade's own pixel, the
 * front-most surface facing the facade within depthM of its plane winning (bilinear in its photo; the plane is K's fit,
 * and the model's recessed bays lie up to several metres behind it). Pixels no surface reaches
 * are uncovered. Then each facade's lattice and its stain (its residual against its own repeats) are read again from the
 * render. `toFrame` (column-major) takes the model's coordinates to the guides' frame (street at y = 0).
 * Returns false (and a note) when the model cannot be read.
 */
inline bool renderFromModel(GuideSet& g, const std::string& modelGlb, const std::array<float, 16>& toFrame, float depthM = 6.0f, float minDot = 0.85f) {
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(modelGlb);
    if (!scene.ok) { g.notes.push_back("pipeline K model: " + (scene.error.empty() ? "cannot read " + modelGlb : scene.error)); return false; }
    auto xf = [&](const Vec3& p) {
        const auto& m = toFrame;
        return Vec3(m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12], m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13], m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]);
    };
    const auto& mesh = scene.mesh;
    std::vector<Vec3> pos(mesh.vertices.size());
    for (size_t i = 0; i < pos.size(); ++i) pos[i] = xf(mesh.vertices[i].position);
    struct Target { texture::ImageBuffer img; std::vector<float> depth; };
    std::vector<Target> tg(g.facades.size());
    for (size_t i = 0; i < g.facades.size(); ++i) {
        const Facade& f = g.facades[i];
        tg[i].img = texture::ImageBuffer(f.W, f.H, 3, 128);
        tg[i].depth.assign(size_t(f.W) * f.H, -1e30f);
    }
    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        const uint32_t ia = mesh.indices[t], ib = mesh.indices[t + 1], ic = mesh.indices[t + 2];
        const Vec3 &A = pos[ia], &B = pos[ib], &C = pos[ic];
        Vec3 n = (B - A).cross(C - A);
        const float len = n.length();
        if (len < 1e-8f) continue;
        n = n / len;
        const uint32_t mi = scene.triangleMaterial[t / 3];
        if (mi >= scene.materials.size()) continue;
        const int im = scene.materials[mi].baseColorImage;
        if (im < 0 || im >= int(scene.images.size()) || !scene.images[im].decoded) continue;
        const auto& px = scene.images[im].pixels;
        const Vec2 ua = mesh.vertices[ia].uv, ub = mesh.vertices[ib].uv, uc = mesh.vertices[ic].uv;
        for (size_t fi = 0; fi < g.facades.size(); ++fi) {
            const Facade& f = g.facades[fi];
            if (n.dot(f.n) < minDot) continue;
            float X[3], Y[3], D[3];
            const Vec3* P[3] = {&A, &B, &C};
            bool near = true;
            for (int k = 0; k < 3; ++k) {
                const Vec3 r = *P[k] - f.c;
                D[k] = r.dot(f.n);
                if (std::abs(D[k]) > depthM) near = false;
                X[k] = (r.dot(f.s) - f.oSMin) / f.pixel;
                Y[k] = (f.oTMax - r.dot(f.t)) / f.pixel;
            }
            if (!near) continue;
            const int x0 = std::max(0, int(std::floor(std::min({X[0], X[1], X[2]})))), x1 = std::min(f.W - 1, int(std::ceil(std::max({X[0], X[1], X[2]}))));
            const int y0 = std::max(0, int(std::floor(std::min({Y[0], Y[1], Y[2]})))), y1 = std::min(f.H - 1, int(std::ceil(std::max({Y[0], Y[1], Y[2]}))));
            if (x0 > x1 || y0 > y1) continue;
            const float den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2]);
            if (std::abs(den) < 1e-9f) continue;
            Target& T = tg[fi];
            for (int y = y0; y <= y1; ++y)
                for (int x = x0; x <= x1; ++x) {
                    const float qx = x + 0.5f, qy = y + 0.5f;
                    const float w0 = ((Y[1] - Y[2]) * (qx - X[2]) + (X[2] - X[1]) * (qy - Y[2])) / den;
                    const float w1 = ((Y[2] - Y[0]) * (qx - X[2]) + (X[0] - X[2]) * (qy - Y[2])) / den;
                    const float w2 = 1.0f - w0 - w1;
                    if (w0 < -1e-4f || w1 < -1e-4f || w2 < -1e-4f) continue;
                    const float d = w0 * D[0] + w1 * D[1] + w2 * D[2];
                    const size_t k = size_t(y) * f.W + x;
                    if (d <= T.depth[k]) continue;
                    T.depth[k] = d;
                    const Vec2 uv = ua * w0 + ub * w1 + uc * w2;
                    const float fu = (uv.x - std::floor(uv.x)) * px.width - 0.5f, fv = (uv.y - std::floor(uv.y)) * px.height - 0.5f;
                    const int u0 = std::clamp(int(std::floor(fu)), 0, px.width - 1), v0 = std::clamp(int(std::floor(fv)), 0, px.height - 1);
                    const int u1 = std::min(u0 + 1, px.width - 1), v1 = std::min(v0 + 1, px.height - 1);
                    const float au = std::clamp(fu - u0, 0.0f, 1.0f), av = std::clamp(fv - v0, 0.0f, 1.0f);
                    for (int ch = 0; ch < 3; ++ch) {
                        const int c = std::min(ch, px.channels - 1);
                        auto at = [&](int uu, int vv) { return float(px.data[(size_t(vv) * px.width + uu) * px.channels + c]); };
                        const float v = (at(u0, v0) * (1 - au) + at(u1, v0) * au) * (1 - av) + (at(u0, v1) * (1 - au) + at(u1, v1) * au) * av;
                        T.img.data[k * 3 + ch] = uint8_t(std::clamp(std::lround(v), 0L, 255L));
                    }
                }
        }
    }
    int reached = 0;
    for (size_t i = 0; i < g.facades.size(); ++i) {
        Facade& f = g.facades[i];
        f.rect = std::move(tg[i].img);
        f.uncovered.assign(size_t(f.W) * f.H, 0);
        size_t hit = 0;
        for (size_t k = 0; k < f.uncovered.size(); ++k) { if (tg[i].depth[k] < -1e29f) f.uncovered[k] = 1; else ++hit; }
        if (hit) ++reached;
        f.lattice = Facade::Lattice{};
        detail::measureLattice(f, f.periodPx * f.pixel);
        f.stainLog.clear();
        if (f.periodPx > 4) f.stainLog = detail::repeatResidual(f.rect, f.uncovered, f.periodPx, f.storeyPx);
    }
    g.notes.push_back("photos read from pipeline K's finished model (" + std::to_string(reached) + " of " + std::to_string(g.facades.size()) + " facades reached)");
    return true;
}

/** A built part to register and colour: its name, its role in the registration (1 glass: dark in the photo, 0 wall:
 * light, -1 neither: only coloured), and its mesh. */
struct PartIn { std::string name; int role{0}; const geometry::ScratchboxMesh* mesh{nullptr}; };

struct PartColour { std::string name; Vec3 linear{0, 0, 0}; int samples{0}; };

namespace detail {

struct Pt { Vec3 p, n; int part; };

inline std::vector<Pt> samplePoints(const std::vector<PartIn>& parts, float spacing) {
    std::vector<Pt> pts;
    uint32_t h = 12345;
    auto rnd = [&]() { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return (h & 0xFFFFFF) / float(0x1000000); };
    for (size_t pi = 0; pi < parts.size(); ++pi) {
        const auto& m = *parts[pi].mesh;
        for (size_t t = 0; t + 2 < m.indices.size(); t += 3) {
            const Vec3 &A = m.vertices[m.indices[t]].position, &B = m.vertices[m.indices[t + 1]].position, &C = m.vertices[m.indices[t + 2]].position;
            Vec3 n = (B - A).cross(C - A);
            const float a2 = n.length();
            if (a2 < 1e-8f) continue;
            n = n / a2;
            const int count = std::clamp(int(std::ceil(0.5f * a2 / (spacing * spacing))), 1, 200);
            for (int k = 0; k < count; ++k) {
                float a = rnd(), b = rnd();
                if (a + b > 1) { a = 1 - a; b = 1 - b; }
                pts.push_back({A + (B - A) * a + (C - A) * b, n, int(pi)});
            }
        }
    }
    return pts;
}

}  // namespace detail

/**
 * Registers each facade to the built parts (a shift within half a bay and half a storey either way, scored by the
 * walls' mean photo brightness minus the glass's), then reads each part's photo colour where it lands: the lit middle of
 * its samples' luminance (40th-95th percentile), averaged in linear light.
 */
inline std::vector<PartColour> registerAndColour(GuideSet& g, const std::vector<PartIn>& parts, float spacing = 0.25f) {
    const auto pts = detail::samplePoints(parts, spacing);
    auto L = [](uint8_t v) { const float c = v / 255.0f; return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); };
    for (auto& f : g.facades) {
        f.shiftS = f.shiftT = 0;
        // the points this facade reads, in its plane
        std::vector<std::pair<Vec2, bool>> on;
        size_t seen = 0;
        for (const auto& q : pts) {
            if (q.n.dot(f.n) < g.minNormalDot) continue;
            const Vec3 r = q.p - f.c;
            if (std::abs(r.dot(f.n)) > g.depthToleranceM) continue;
            const float sv = r.dot(f.s), tv = r.dot(f.t);
            if (sv < f.sMin || sv > f.sMax || tv < f.tMin || tv > f.tMax) continue;
            if (parts[q.part].role < 0) continue;
            on.push_back({Vec2(sv, tv), parts[q.part].role == 1});
            ++seen;
        }
        // at most 4000 points score a shift: thinned evenly, so a large facade costs the same as a small one
        if (on.size() > 4000) {
            std::vector<std::pair<Vec2, bool>> thin;
            const double stride = double(on.size()) / 4000.0;
            for (double k = 0; k < on.size(); k += stride) thin.push_back(on[size_t(k)]);
            on.swap(thin);
        }
        int ng = 0, nw = 0;
        for (const auto& o : on) (o.second ? ng : nw)++;
        f.regGlass = ng; f.regWall = nw;
        if (ng < 50 || nw < 50) continue;
        const float spanS = 0.5f * (f.periodPx > 4 ? f.periodPx * f.pixel : 3.0f), spanT = 0.5f * (f.storeyPx > 4 ? f.storeyPx * f.pixel : 3.7f);
        const float step = std::max(f.pixel, 0.1f);
        auto score = [&](float ds, float dt) {
            double sw = 0, sg = 0; int cw = 0, cg = 0;
            for (const auto& o : on) {
                const float x = (o.first.x + ds - f.oSMin) / f.pixel, y = (f.oTMax - (o.first.y + dt)) / f.pixel;
                if (x < 0 || y < 0 || x >= f.W || y >= f.H) continue;
                const size_t k = size_t(int(y)) * f.W + size_t(int(x));
                if (!f.uncovered.empty() && f.uncovered[k]) continue;
                const uint8_t* q = &f.rect.data[k * f.rect.channels];
                const float lum = 0.2126f * L(q[0]) + 0.7152f * L(q[1]) + 0.0722f * L(q[2]);
                if (o.second) { sg += lum; ++cg; } else { sw += lum; ++cw; }
            }
            return (cg > 20 && cw > 20) ? float(sw / cw - sg / cg) : -1e9f;
        };
        f.regScoreAtZero = score(0, 0);
        float best = f.regScoreAtZero;
        for (float ds = -spanS; ds <= spanS; ds += step)
            for (float dt = -spanT; dt <= spanT; dt += step) {
                const float sc = score(ds, dt);
                if (sc > best) { best = sc; f.shiftS = ds; f.shiftT = dt; }
            }
        f.regScore = best;
    }
    // colours per part where the registered photo covers its samples
    std::vector<std::vector<std::pair<float, Vec3>>> per(parts.size());
    for (const auto& q : pts) {
        Vec3 lin;
        if (!g.colourAt(q.p, q.n, lin)) continue;
        per[q.part].push_back({0.2126f * lin.x + 0.7152f * lin.y + 0.0722f * lin.z, lin});
    }
    std::vector<PartColour> out;
    for (size_t pi = 0; pi < parts.size(); ++pi) {
        auto& v = per[pi];
        PartColour pc; pc.name = parts[pi].name; pc.samples = int(v.size());
        if (v.size() >= 20) {
            std::sort(v.begin(), v.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
            const size_t a = v.size() * 40 / 100, b = std::max(a + 1, v.size() * 95 / 100);
            Vec3 s(0, 0, 0);
            for (size_t k = a; k < b; ++k) s = s + v[k].second;
            pc.linear = s * (1.0f / float(b - a));
        }
        out.push_back(pc);
    }
    return out;
}

/** One tier's textures cut from the photos (see elementTextures). Images are RGB; sizes in metres. */
struct ElementTextures {
    bool ok{false};
    std::string reason;
    texture::ImageBuffer pier, pierNormal, spandrel, spandrelNormal, cell;
    float pierWidthM{0}, storeyM{0}, infillWidthM{0}, spandrelHeightM{0}, pitchM{0};
    Vec3 glass{0, 0, 0};          // linear
    int pierSamples{0}, cellSamples{0};
    std::vector<int> facades;
    // the bay's windows as the infill cell shows them: dark runs across its window rows, light wall between
    int windowsPerBay{0};
    float windowWidthM{0}, windowGapM{0};
    float lightBand{0};           // the brightest row across the infill against the pier (1 = as light as the stone)
};

namespace detail {

inline float srgbToLin(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline uint8_t linToSrgb8(float l) {
    l = std::clamp(l, 0.0f, 1.0f);
    const float c = l <= 0.0031308f ? 12.92f * l : 1.055f * std::pow(l, 1.0f / 2.4f) - 0.055f;
    return uint8_t(std::lround(c * 255.0f));
}

/** The storey period (px) of a facade's infill rows: K's when measured, else the autocorrelation peak in 2.8-5.2 m. */
inline float storeyPeriodPx(const std::vector<float>& rows, float storeyPx, float pixel) {
    if (storeyPx > 4) return storeyPx;
    const int lo = int(2.8f / pixel), hi = int(5.2f / pixel);
    double mean = 0; int n = 0;
    for (float v : rows) if (!std::isnan(v)) { mean += v; ++n; }
    if (n < 2 * hi) return 0;
    mean /= n;
    double best = -1e30; int bestL = 0;
    for (int L = lo; L <= hi; ++L) {
        double acc = 0; int m = 0;
        for (size_t i = 0; i + L < rows.size(); ++i)
            if (!std::isnan(rows[i]) && !std::isnan(rows[i + L])) { acc += (rows[i] - mean) * (rows[i + L] - mean); ++m; }
        if (m > 0 && acc / m > best) { best = acc / m; bestL = L; }
    }
    return float(bestL);
}

/** Per-pixel channel medians of stacked samples (linear), NaN-free; returns the cell in linear RGB. */
struct MedianStack {
    int W{0}, H{0};
    std::vector<std::vector<float>> r, g, b;
    void init(int w, int h) { W = w; H = h; r.assign(size_t(w) * h, {}); g = r; b = r; }
    void add(int x, int y, const Vec3& c) { const size_t k = size_t(y) * W + x; r[k].push_back(c.x); g[k].push_back(c.y); b[k].push_back(c.z); }
    static float med(std::vector<float>& v) {
        if (v.empty()) return NAN;
        std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end());
        return v[v.size() / 2];
    }
    std::vector<Vec3> result() {
        std::vector<Vec3> out(size_t(W) * H);
        for (size_t k = 0; k < out.size(); ++k) out[k] = Vec3(med(r[k]), med(g[k]), med(b[k]));
        return out;
    }
};

/** Bilinear resample of a linear cell that wraps in both directions (it is one period of the lattice). */
inline Vec3 sampleWrap(const std::vector<Vec3>& img, int W, int H, float x, float y) {
    x = std::fmod(std::fmod(x, float(W)) + W, float(W)); y = std::fmod(std::fmod(y, float(H)) + H, float(H));
    const int x0 = int(x), y0 = int(y), x1 = (x0 + 1) % W, y1 = (y0 + 1) % H;
    const float fx = x - x0, fy = y - y0;
    auto at = [&](int xx, int yy) { return img[size_t(yy) * W + xx]; };
    return at(x0, y0) * ((1 - fx) * (1 - fy)) + at(x1, y0) * (fx * (1 - fy)) + at(x0, y1) * ((1 - fx) * fy) + at(x1, y1) * (fx * fy);
}

/**
 * Renders a tile at outPx pixels a metre from a photo cell (linear, wrapping), with stone joints drawn over it: courses
 * every courseM, and head joints at headM staggered by half a block each course, each block's tone varied by up to
 * +-toneJitter (generated detail finer than the photo's pixel, which the median over repeats has smoothed away). Writes the albedo (sRGB) and a tangent-space normal map from the joint grooves.
 */
inline void renderTile(const std::vector<Vec3>& cell, int cw, int ch, float wM, float hM, float outPx, float courseM, float headM,
                       float jointM, float jointDarken, float toneJitter, texture::ImageBuffer& albedo, texture::ImageBuffer& normal) {
    const int W = std::max(8, int(std::lround(wM * outPx))), H = std::max(8, int(std::lround(hM * outPx)));
    // whole courses and heads per tile, so the joints tile
    const int nc = std::max(1, int(std::lround(hM / courseM))), nh = std::max(1, int(std::lround(wM / headM)));
    const float cM = hM / nc, hdM = wM / nh;
    albedo = texture::ImageBuffer(W, H, 3, 0);
    normal = texture::ImageBuffer(W, H, 3, 0);
    std::vector<float> depth(size_t(W) * H, 0.0f);
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            const float xm = (x + 0.5f) / outPx, ym = (y + 0.5f) / outPx;
            const Vec3 c = sampleWrap(cell, cw, ch, xm / wM * cw - 0.5f, ym / hM * ch - 0.5f);
            const int course = int(ym / cM);
            const float dy = std::abs(ym - std::round(ym / cM) * cM);
            const float shift = (course % 2) * 0.5f * hdM;
            const float xs = xm + shift;
            const float dx = std::abs(xs - std::round(xs / hdM) * hdM);
            const float d = std::min(dx, dy);
            const float groove = std::clamp(1.0f - d / std::max(0.5f * jointM, 1.0f / outPx), 0.0f, 1.0f);   // at least a pixel wide
            depth[size_t(y) * W + x] = groove;
            const int head = int(std::floor(xs / hdM)) % nh;
            uint32_t h = uint32_t(course % nc) * 73856093u ^ uint32_t(head) * 19349663u;
            h ^= h >> 13; h *= 0x5bd1e995u; h ^= h >> 15;
            const float tone = 1.0f + toneJitter * (2.0f * float(h & 0xffff) / 65535.0f - 1.0f);
            const float k = (1.0f - jointDarken * groove) * tone;
            uint8_t* o = &albedo.data[(size_t(y) * W + x) * 3];
            o[0] = linToSrgb8(c.x * k); o[1] = linToSrgb8(c.y * k); o[2] = linToSrgb8(c.z * k);
        }
    const float strength = 0.004f * outPx;   // a groove about 4 mm deep
    for (int y = 0; y < H; ++y)
        for (int x = 0; x < W; ++x) {
            auto D = [&](int xx, int yy) { return depth[size_t((yy + H) % H) * W + (xx + W) % W]; };
            const float gx = (D(x + 1, y) - D(x - 1, y)) * strength, gy = (D(x, y + 1) - D(x, y - 1)) * strength;
            Vec3 n(gx, -gy, 1.0f);
            n = n.normalized();
            uint8_t* o = &normal.data[(size_t(y) * W + x) * 3];
            o[0] = uint8_t(std::lround((n.x * 0.5f + 0.5f) * 255)); o[1] = uint8_t(std::lround((n.y * 0.5f + 0.5f) * 255));
            o[2] = uint8_t(std::lround((n.z * 0.5f + 0.5f) * 255));
        }
}

}  // namespace detail

/**
 * A tier's own textures, cut from the photos of the facades that cross its height band [y0, y1] (build frame) and show a
 * clear lattice: every pier, storey by storey, is stacked into one pier cell (the pier's width by one storey), and every
 * bay of infill into one infill cell (the gap between piers by one storey, its window included); each pixel of a cell is
 * the median over all its repeats, so what repeats (the stone, the spandrel, the frames) stays and what does not (a
 * stain, a reflection, a passing smear) drops out. The storey phase is aligned on each facade by its infill rows (the
 * cell starts at the brightest row, the middle of a spandrel). The spandrel is the infill cell's rows brighter than the
 * split between its row means, joined across the cell's wrap. Glass is the median of the darkest fifth of the window rows.
 * Tiles are rendered at outPx pixels a metre with stone joints drawn on (generated), courseM tall and headM long.
 */
inline ElementTextures elementTextures(const GuideSet& g, float y0, float y1, float outPx = 40.0f, float courseM = 0.6f,
                                       float headM = 1.2f, int minPiers = 4, float minContrast = 1.3f) {
    ElementTextures out;
    struct Use { const Facade* f; float stP; float phase; };
    std::vector<Use> uses;
    std::vector<float> pierW, pitch, storey;
    auto lum = [](const Vec3& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; };
    for (const auto& f : g.facades) {
        const auto& L = f.lattice;
        if (!L.ok || L.piers < minPiers || L.contrast < minContrast || L.pierWidthM >= 0.6f * L.pitchM || std::abs(f.t.y) < 0.9f) continue;
        const float fy0 = f.c.y + std::min(f.t.y * f.tMin, f.t.y * f.tMax), fy1 = f.c.y + std::max(f.t.y * f.tMin, f.t.y * f.tMax);
        if (fy1 <= y0 || fy0 >= y1) continue;
        // infill row profile, over the columns between piers
        std::vector<float> rows(f.H, NAN);
        for (int y = 0; y < f.H; ++y) {
            double acc = 0; int n = 0;
            for (size_t k = 0; k + 1 < L.centresPx.size(); ++k) {
                const int xa = int(L.centresPx[k] + 0.5f * L.pierWidthPx + 1), xb = int(L.centresPx[k + 1] - 0.5f * L.pierWidthPx - 1);
                for (int x = std::max(0, xa); x <= std::min(f.W - 1, xb); x += 2) {
                    const size_t i = size_t(y) * f.W + x;
                    if (!f.uncovered.empty() && f.uncovered[i]) continue;
                    const uint8_t* q = &f.rect.data[i * f.rect.channels];
                    if (detail::unfilled(q, f.rect.channels)) continue;
                    acc += 0.2126 * detail::srgbToLin(q[0] / 255.f) + 0.7152 * detail::srgbToLin(q[1] / 255.f) + 0.0722 * detail::srgbToLin(q[2] / 255.f); ++n;
                }
            }
            if (n > 4) rows[y] = float(acc / n);
        }
        const float stP = detail::storeyPeriodPx(rows, f.storeyPx, f.pixel);
        if (stP < 8) continue;
        // phase: the brightest folded row
        const int P = int(std::lround(stP));
        std::vector<double> fold(P, 0.0); std::vector<int> fn(P, 0);
        for (int y = 0; y < f.H; ++y) if (!std::isnan(rows[y])) { fold[y % P] += rows[y]; ++fn[y % P]; }
        int ph = 0; double bv = -1;
        for (int k = 0; k < P; ++k) if (fn[k] && fold[k] / fn[k] > bv) { bv = fold[k] / fn[k]; ph = k; }
        uses.push_back({&f, stP, float(ph)});
        pierW.push_back(L.pierWidthPx * f.pixel); pitch.push_back(L.pitchM); storey.push_back(stP * f.pixel);
        out.facades.push_back(f.id);
    }
    if (uses.empty()) { out.reason = "no facade photo with a clear lattice crosses this height band"; return out; }
    auto median = [](std::vector<float> v) { std::nth_element(v.begin(), v.begin() + v.size() / 2, v.end()); return v[v.size() / 2]; };
    out.pierWidthM = median(pierW); out.pitchM = median(pitch); out.storeyM = median(storey);
    out.infillWidthM = out.pitchM - out.pierWidthM;
    // cells on a common grid, about the photos' own pixel
    const float px = uses.front().f->pixel;
    const int pw = std::max(4, int(std::lround(out.pierWidthM / px))), iw = std::max(4, int(std::lround(out.infillWidthM / px)));
    const int sh = std::max(8, int(std::lround(out.storeyM / px)));
    detail::MedianStack pier, cell;
    pier.init(pw, sh); cell.init(iw, sh);
    for (const auto& u : uses) {
        const Facade& f = *u.f;
        const auto& L = f.lattice;
        auto read = [&](float x, float y, Vec3& c) {
            const int xi = int(x), yi = int(y);
            if (xi < 0 || yi < 0 || xi >= f.W || yi >= f.H) return false;
            const size_t i = size_t(yi) * f.W + xi;
            if (!f.uncovered.empty() && f.uncovered[i]) return false;
            const uint8_t* q = &f.rect.data[i * f.rect.channels];
            if (detail::unfilled(q, f.rect.channels)) return false;
            c = Vec3(detail::srgbToLin(q[0] / 255.f), detail::srgbToLin(q[1] / 255.f), detail::srgbToLin(q[2] / 255.f));
            return true;
        };
        // storeys of this facade inside the band
        for (float r0 = u.phase; r0 + u.stP <= f.H; r0 += u.stP) {
            // the storey's height in the build frame: row r lies at t = oTMax - r * pixel from the centroid
            const float tMid = f.oTMax - (r0 + 0.5f * u.stP) * f.pixel;
            const float yMid = f.c.y + f.t.y * tMid;
            if (yMid < y0 || yMid > y1) continue;
            const float sy = u.stP / sh;
            for (size_t k = 0; k < L.centresPx.size(); ++k) {
                const float sx = L.pierWidthPx / pw;
                const float x0 = L.centresPx[k] - 0.5f * L.pierWidthPx;
                for (int yy = 0; yy < sh; ++yy)
                    for (int xx = 0; xx < pw; ++xx) {
                        Vec3 c;
                        if (read(x0 + (xx + 0.5f) * sx, r0 + (yy + 0.5f) * sy, c)) pier.add(xx, yy, c);
                    }
                ++out.pierSamples;
                if (k + 1 >= L.centresPx.size()) continue;
                const float xa = L.centresPx[k] + 0.5f * L.pierWidthPx, xb = L.centresPx[k + 1] - 0.5f * L.pierWidthPx;
                if (xb - xa < 4 || std::abs((L.centresPx[k + 1] - L.centresPx[k]) * f.pixel - out.pitchM) > 0.25f * out.pitchM) continue;
                const float ix = (xb - xa) / iw;
                for (int yy = 0; yy < sh; ++yy)
                    for (int xx = 0; xx < iw; ++xx) {
                        Vec3 c;
                        if (read(xa + (xx + 0.5f) * ix, r0 + (yy + 0.5f) * sy, c)) cell.add(xx, yy, c);
                    }
                ++out.cellSamples;
            }
        }
    }
    if (out.pierSamples < 8 || out.cellSamples < 8) { out.reason = "too few repeats in the band to take a median"; return out; }
    auto pierCell = pier.result(), infCell = cell.result();
    auto fillNan = [](std::vector<Vec3>& v) {
        Vec3 m(0, 0, 0); int n = 0;
        for (auto& c : v) if (!std::isnan(c.x)) { m = m + c; ++n; }
        if (n) m = m * (1.0f / n);
        for (auto& c : v) if (std::isnan(c.x)) c = m;
    };
    fillNan(pierCell); fillNan(infCell);
    // spandrel rows: brighter than the split of the infill cell's row means; the cell starts mid-spandrel, so the
    // spandrel runs from the bottom rows across the wrap into the top rows
    std::vector<float> rm(sh, 0.0f);
    for (int y = 0; y < sh; ++y) { float a = 0; for (int x = 0; x < iw; ++x) a += lum(infCell[size_t(y) * iw + x]); rm[y] = a / iw; }
    std::vector<float> sorted = rm; std::sort(sorted.begin(), sorted.end());
    float split = 0.5f * (sorted.front() + sorted.back()), bestB = -1;
    for (int k = 1; k < sh; ++k) {
        double m0 = 0, m1 = 0;
        for (int i = 0; i < k; ++i) m0 += sorted[i];
        for (int i = k; i < sh; ++i) m1 += sorted[i];
        m0 /= k; m1 /= (sh - k);
        const double w0 = double(k) / sh, b = w0 * (1 - w0) * (m1 - m0) * (m1 - m0);
        if (b > bestB) { bestB = float(b); split = 0.5f * (sorted[k - 1] + sorted[k]); }
    }
    int top = 0; while (top < sh && rm[top] > split) ++top;
    int bot = 0; while (bot < sh - top && rm[sh - 1 - bot] > split) ++bot;
    const int spH = top + bot;
    if (spH < 3 || spH > sh - 3) { out.reason = "the infill shows no window rows apart from its spandrel"; return out; }
    std::vector<Vec3> span(size_t(iw) * spH);
    for (int y = 0; y < spH; ++y) {
        const int src = y < bot ? sh - bot + y : y - bot;
        for (int x = 0; x < iw; ++x) span[size_t(y) * iw + x] = infCell[size_t(src) * iw + x];
    }
    // glass: the darkest fifth of the window rows
    std::vector<std::pair<float, Vec3>> win;
    for (int y = top; y < sh - bot; ++y) for (int x = 0; x < iw; ++x) { const Vec3& c = infCell[size_t(y) * iw + x]; win.push_back({lum(c), c}); }
    std::sort(win.begin(), win.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
    Vec3 gs(0, 0, 0); const size_t gn = std::max<size_t>(1, win.size() / 5);
    for (size_t i = 0; i < gn; ++i) gs = gs + win[i].second;
    out.glass = gs * (1.0f / gn);
    out.spandrelHeightM = spH * out.storeyM / sh;
    // windows: the window rows' column profile, smoothed; the extreme that repeats across the bay's middle (light lobes
    // for glass brighter than its frames, dark ones for darker glass) counts the windows, and the opposite extreme
    // between two of them is the wall or mullion strip, as wide as where the profile stays within a quarter of the way
    // from it to its neighbours
    {
        std::vector<float> cm(iw, 0.0f), sm(iw, 0.0f);
        for (int x = 0; x < iw; ++x) { float a = 0; for (int y = top; y < sh - bot; ++y) a += lum(infCell[size_t(y) * iw + x]); cm[x] = a / std::max(1, sh - bot - top); }
        for (int x = 0; x < iw; ++x) { float a = 0; int n = 0; for (int k = -1; k <= 1; ++k) if (x + k >= 0 && x + k < iw) { a += cm[x + k]; ++n; } sm[x] = a / n; }
        const int x0 = std::max(1, int(0.1f * iw)), x1 = std::min(iw - 2, int(0.9f * iw));
        float mean = 0; for (int x = x0; x <= x1; ++x) mean += sm[x]; mean /= std::max(1, x1 - x0 + 1);
        const float lo = *std::min_element(sm.begin() + x0, sm.begin() + x1 + 1), hi = *std::max_element(sm.begin() + x0, sm.begin() + x1 + 1);
        // an extreme counts when it stands out from both sides by over a third of the bay's range (ripples do not)
        std::vector<int> peaks, valleys;
        for (int x = x0; x <= x1; ++x) {
            const bool pk = sm[x] > sm[x - 1] && sm[x] >= sm[x + 1], vl = sm[x] < sm[x - 1] && sm[x] <= sm[x + 1];
            if (!pk && !vl) continue;
            float l = sm[x], r = sm[x];
            for (int k = x0; k <= x; ++k) l = pk ? std::min(l, sm[k]) : std::max(l, sm[k]);
            for (int k = x; k <= x1; ++k) r = pk ? std::min(r, sm[k]) : std::max(r, sm[k]);
            const float prom = pk ? sm[x] - std::max(l, r) : std::min(l, r) - sm[x];
            if (prom >= 0.35f * (hi - lo)) (pk ? peaks : valleys).push_back(x);
        }
        const float pxM = out.infillWidthM / iw;
        out.windowsPerBay = 1;
        if (mean > 0 && (hi - lo) / mean >= 0.03f && std::max(peaks.size(), valleys.size()) >= 2) {
            const bool lightLobes = peaks.size() >= valleys.size();
            const auto& lobes = lightLobes ? peaks : valleys;
            out.windowsPerBay = int(lobes.size());
            std::vector<float> gaps;
            for (size_t k = 1; k < lobes.size(); ++k) {
                int sep = lobes[k - 1];
                for (int x = lobes[k - 1]; x <= lobes[k]; ++x) if (lightLobes ? sm[x] < sm[sep] : sm[x] > sm[sep]) sep = x;
                const float lobeV = 0.5f * (sm[lobes[k - 1]] + sm[lobes[k]]);
                const float thr = sm[sep] + 0.25f * (lobeV - sm[sep]);
                int a = sep, b = sep;
                auto inside = [&](int x) { return lightLobes ? sm[x] <= thr : sm[x] >= thr; };
                while (a - 1 > lobes[k - 1] && inside(a - 1)) --a;
                while (b + 1 < lobes[k] && inside(b + 1)) ++b;
                gaps.push_back((b - a + 1) * pxM);
            }
            std::sort(gaps.begin(), gaps.end());
            out.windowGapM = gaps[gaps.size() / 2];
        }
        out.windowWidthM = (out.infillWidthM - (out.windowsPerBay - 1) * out.windowGapM) / out.windowsPerBay;
        Vec3 pm(0, 0, 0);
        for (const auto& c : pierCell) pm = pm + c;
        const float pierLum = lum(pm * (1.0f / pierCell.size()));
        out.lightBand = pierLum > 0 ? *std::max_element(rm.begin(), rm.end()) / pierLum : 0.0f;
    }
    detail::renderTile(pierCell, pw, sh, out.pierWidthM, out.storeyM, outPx, courseM, headM, 0.012f, 0.25f, 0.05f, out.pier, out.pierNormal);
    detail::renderTile(span, iw, spH, out.infillWidthM, out.spandrelHeightM, outPx, out.spandrelHeightM, headM, 0.012f, 0.2f, 0.03f, out.spandrel, out.spandrelNormal);
    // the infill cell as the photos show it (window included), for reference
    out.cell = texture::ImageBuffer(iw, sh, 3, 0);
    for (size_t k = 0; k < infCell.size(); ++k) {
        out.cell.data[k * 3] = detail::linToSrgb8(infCell[k].x); out.cell.data[k * 3 + 1] = detail::linToSrgb8(infCell[k].y);
        out.cell.data[k * 3 + 2] = detail::linToSrgb8(infCell[k].z);
    }
    out.ok = true;
    return out;
}

}  // namespace facade_guide
}  // namespace scratchbox

#endif  // SCRATCHBOX_FACADE_GUIDE_HPP
