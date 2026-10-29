/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SCAN_COLOUR_HPP
#define SCRATCHBOX_SCAN_COLOUR_HPP

#include "scratchbox_gltf_scene.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <random>
#include <string>
#include <vector>

/**
 * The colours of a real building in its photographic scan (Google 3D Tiles, unlit, with sun and shade baked into the
 * photos), region by region: per height band (a script's tiers) and per facing (walls by compass side, up-facing roofs
 * and setback terraces, down-facing soffits). Points are sampled over the scan's triangles at a fixed spacing, kept
 * inside the building's plan outline (plus a margin), and each takes its texel's colour in linear sRGB.
 *
 * Per region it reports the lit colour (litColour's method: an Otsu split of log luminance keeps the lit side when the
 * two populations differ by 1.6x or more, its top 5 % dropped as highlights; else the 40th-95th luminance percentiles),
 * and the split itself: the light population and the dark one with its share. On a facade the light population is
 * mostly the cladding and the dark one the windows and shade between; at tile resolution a texel can hold both, so
 * these are readings of the photo, not of materials. A measurement only: no photo texel is drawn on anything.
 * Frame: the tiles' (x east, y up, z south), y measured from `groundY`.
 */
namespace scratchbox {
namespace scan_colour {

using math::Vec2;
using math::Vec3;

struct Band { float y0, y1; };

struct RegionColour {
    int band{0};
    /** 0..7 walls N, NE, E, SE, S, SW, W, NW (outward normal); 8 up-facing; 9 down-facing. */
    int facing{0};
    int samples{0};
    std::array<double, 3> litLinear{0, 0, 0};
    bool shadowSplit{false};
    std::array<double, 3> lightLinear{0, 0, 0}, darkLinear{0, 0, 0};
    /** CIELAB (D65) standard deviation of the lit samples (the ones litLinear averages): the reading's texture spread. */
    std::array<double, 3> litSpreadLab{0, 0, 0};
    double darkShare{0}, lightToDarkLuminance{1};
};

struct Result {
    std::vector<RegionColour> regions;
    int sampled{0}, kept{0}, triangles{0};
    std::string error;
};

namespace detail {

inline double lum(const std::array<double, 3>& c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }

inline std::array<double, 3> lab(const std::array<double, 3>& c) {
    const double X = (0.4124 * c[0] + 0.3576 * c[1] + 0.1805 * c[2]) / 0.95047, Y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2],
                 Z = (0.0193 * c[0] + 0.1192 * c[1] + 0.9505 * c[2]) / 1.08883;
    auto f = [](double t) { return t > 0.008856 ? std::cbrt(t) : 7.787 * t + 16.0 / 116.0; };
    return {116.0 * f(Y) - 16.0, 500.0 * (f(X) - f(Y)), 200.0 * (f(Y) - f(Z))};
}

/** CIELAB standard deviation of the samples idx[from, to). */
inline std::array<double, 3> labSpread(const std::vector<std::array<double, 3>>& c, const std::vector<size_t>& idx, size_t from, size_t to) {
    std::array<double, 3> s{0, 0, 0}, s2{0, 0, 0};
    if (to <= from) return s;
    for (size_t k = from; k < to; ++k) {
        const auto L = lab(c[idx[k]]);
        for (int i = 0; i < 3; ++i) { s[i] += L[i]; s2[i] += L[i] * L[i]; }
    }
    const double n = double(to - from);
    std::array<double, 3> out{};
    for (int i = 0; i < 3; ++i) out[i] = std::sqrt(std::max(0.0, s2[i] / n - (s[i] / n) * (s[i] / n)));
    return out;
}

inline std::array<double, 3> meanOf(const std::vector<std::array<double, 3>>& c, const std::vector<size_t>& idx, size_t from, size_t to) {
    std::array<double, 3> m{0, 0, 0};
    if (to <= from) return m;
    for (size_t k = from; k < to; ++k) for (int i = 0; i < 3; ++i) m[i] += c[idx[k]][i];
    for (double& v : m) v /= double(to - from);
    return m;
}

/** Inside a ring, or within `margin` of its edge (x, z plan). */
inline bool nearRing(const std::vector<Vec2>& r, float x, float z, float margin) {
    bool in = false;
    float best = 1e30f;
    for (size_t i = 0, j = r.size() - 1; i < r.size(); j = i++) {
        const Vec2 &a = r[i], &b = r[j];
        if ((a.y > z) != (b.y > z) && x < (b.x - a.x) * (z - a.y) / (b.y - a.y) + a.x) in = !in;
        const float ex = b.x - a.x, ez = b.y - a.y, L2 = ex * ex + ez * ez;
        const float u = L2 > 0 ? std::clamp(((x - a.x) * ex + (z - a.y) * ez) / L2, 0.0f, 1.0f) : 0.0f;
        const float dx = x - a.x - u * ex, dz = z - a.y - u * ez;
        best = std::min(best, dx * dx + dz * dz);
    }
    return in || best <= margin * margin;
}

}  // namespace detail

inline Result measure(const std::string& texturedGlb, float groundY, const std::vector<std::vector<Vec2>>& plan,
                      const std::vector<Band>& bands, float spacingM = 0.5f, float marginM = 2.0f) {
    Result out;
    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(texturedGlb);
    if (!scene.ok) { out.error = scene.error.empty() ? "cannot read " + texturedGlb : scene.error; return out; }
    const auto& mesh = scene.mesh;
    const int regionsPerBand = 10;
    std::vector<std::vector<std::array<double, 3>>> cols(bands.size() * regionsPerBand);
    std::mt19937 rng(12345);
    std::uniform_real_distribution<float> U(0.0f, 1.0f);
    std::array<double, 256> toLin{};
    for (int i = 0; i < 256; ++i) { const double c = i / 255.0; toLin[i] = c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }

    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        const auto& A = mesh.vertices[mesh.indices[t]], &B = mesh.vertices[mesh.indices[t + 1]], &C = mesh.vertices[mesh.indices[t + 2]];
        const Vec3 c = (A.position + B.position + C.position) * (1.0f / 3.0f);
        bool onBuilding = plan.empty();
        for (const auto& r : plan) if (!onBuilding && r.size() >= 3 && detail::nearRing(r, c.x, c.z, marginM)) onBuilding = true;
        if (!onBuilding) continue;
        Vec3 n = (B.position - A.position).cross(C.position - A.position);
        const float area2 = n.length();
        if (area2 < 1e-8f) continue;
        n = n / area2;
        const uint32_t mi = scene.triangleMaterial[t / 3];
        if (mi >= scene.materials.size()) continue;
        const int img = scene.materials[mi].baseColorImage;
        if (img < 0 || img >= int(scene.images.size()) || !scene.images[img].decoded) continue;
        const auto& px = scene.images[img].pixels;
        ++out.triangles;
        int facing;
        if (n.y > 0.7f) facing = 8;
        else if (n.y < -0.7f) facing = 9;
        else {
            const double ang = std::fmod(std::atan2(double(n.x), double(-n.z)) * 180.0 / M_PI + 360.0, 360.0);  // 0 = north (z is south)
            facing = int((ang + 22.5) / 45.0) % 8;
        }
        const int count = std::clamp(int(std::ceil(0.5f * area2 / (spacingM * spacingM))), 1, 400);
        for (int k = 0; k < count; ++k) {
            float a = U(rng), b = U(rng);
            if (a + b > 1.0f) { a = 1.0f - a; b = 1.0f - b; }
            const Vec3 p = A.position + (B.position - A.position) * a + (C.position - A.position) * b;
            const float y = p.y - groundY;
            ++out.sampled;
            int band = -1;
            for (size_t i = 0; i < bands.size(); ++i) if (y >= bands[i].y0 && y < bands[i].y1) { band = int(i); break; }
            if (band < 0) continue;
            const Vec2 uv = A.uv + (B.uv - A.uv) * a + (C.uv - A.uv) * b;
            const float fu = uv.x - std::floor(uv.x), fv = uv.y - std::floor(uv.y);
            const int x = std::clamp(int(fu * px.width), 0, px.width - 1), yy = std::clamp(int(fv * px.height), 0, px.height - 1);
            const uint8_t* s = &px.data[(size_t(yy) * px.width + x) * px.channels];
            cols[size_t(band) * regionsPerBand + facing].push_back({toLin[s[0]], toLin[s[px.channels > 1 ? 1 : 0]], toLin[s[px.channels > 2 ? 2 : 0]]});
            ++out.kept;
        }
    }

    for (size_t r = 0; r < cols.size(); ++r) {
        const auto& c = cols[r];
        if (c.size() < 16) continue;
        RegionColour rc;
        rc.band = int(r / regionsPerBand);
        rc.facing = int(r % regionsPerBand);
        rc.samples = int(c.size());
        std::vector<size_t> idx(c.size());
        std::iota(idx.begin(), idx.end(), 0);
        std::vector<double> L(c.size());
        for (size_t i = 0; i < c.size(); ++i) L[i] = detail::lum(c[i]);
        std::sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return L[a] < L[b]; });
        // Otsu on log luminance
        std::vector<double> lg(c.size());
        for (size_t k = 0; k < c.size(); ++k) lg[k] = std::log(std::max(1e-4, L[idx[k]]));
        const double total = std::accumulate(lg.begin(), lg.end(), 0.0);
        double acc = 0, best = -1;
        size_t cut = 1;
        for (size_t k = 1; k < lg.size(); ++k) {
            acc += lg[k - 1];
            const double w0 = double(k) / lg.size(), m0 = acc / k, m1 = (total - acc) / (lg.size() - k);
            const double between = w0 * (1 - w0) * (m1 - m0) * (m1 - m0);
            if (between > best) { best = between; cut = k; }
        }
        rc.darkLinear = detail::meanOf(c, idx, size_t(c.size() * 0.05), cut);
        const size_t lightEnd = cut + size_t((c.size() - cut) * 0.95);
        rc.lightLinear = detail::meanOf(c, idx, cut, std::max(lightEnd, cut + 1));
        rc.darkShare = double(cut) / c.size();
        rc.lightToDarkLuminance = detail::lum(rc.lightLinear) / std::max(1e-6, detail::lum(rc.darkLinear));
        rc.shadowSplit = rc.lightToDarkLuminance >= 1.6 && 1.0 - rc.darkShare >= 0.08;
        const size_t litFrom = rc.shadowSplit ? cut : size_t(c.size() * 0.4);
        const size_t litTo = rc.shadowSplit ? std::max(lightEnd, cut + 1) : std::max(size_t(c.size() * 0.95), size_t(c.size() * 0.4) + 1);
        rc.litLinear = detail::meanOf(c, idx, litFrom, litTo);
        rc.litSpreadLab = detail::labSpread(c, idx, litFrom, litTo);
        out.regions.push_back(rc);
    }
    return out;
}

}  // namespace scan_colour
}  // namespace scratchbox

#endif  // SCRATCHBOX_SCAN_COLOUR_HPP
