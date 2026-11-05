/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A top-down window of the photo tiles: for every cell of a square around a point, the height of the highest surface
 * and its photo colour, rasterised exactly from the tile's triangles (the same drawing StagedMassing::topdown does for
 * the isolate). Also the walls' direction near the point: the area-weighted mode, modulo 90 degrees, of the azimuths
 * of the tile's vertical faces (smoothed over 2 degrees, so a broad real wall peak beats a narrow spike of axis-aligned
 * seam faces). The footprint model (tools/footprint/footprint_model.py) reads these two rasters.
 *
 * Frame: the tile's own (x east, y up, z south, metres). Cells are row-major with z as rows: index = row * width + col,
 * col = floor((x - x0) / pixel), row = floor((z - z0) / pixel). Unseen cells hold NaN height and colour 0.
 */
#pragma once

#include "scratchbox_staged_massing.hpp"

#include <cmath>
#include <fstream>
#include <limits>
#include <numbers>
#include <sstream>
#include <string>
#include <vector>

namespace scratchbox::topdown_window {

using staged_massing::TileSource;
using staged_massing::V3;

struct Window {
    double x0{0}, z0{0}, pixel{0.25};
    int width{0}, rows{0};
    std::vector<float> height;    // width * rows, NaN where nothing was seen
    std::vector<uint8_t> rgb;     // width * rows * 3
    double wallAngleRad{0};       // walls' direction mod pi/2, in [0, pi/2)
    double wallAreaM2{0};         // vertical area the direction was read from
};

inline Window rasterise(const TileSource& tile, double cx, double cz, double halfM, double pixel, double wallRadiusM) {
    Window w;
    w.pixel = pixel;
    w.x0 = cx - halfM;
    w.z0 = cz - halfM;
    w.width = w.rows = static_cast<int>(std::ceil(2 * halfM / pixel));
    const int W = w.width, H = w.rows;
    w.height.assign(static_cast<size_t>(W) * H, -std::numeric_limits<float>::infinity());
    w.rgb.assign(static_cast<size_t>(W) * H * 3, 0);
    for (uint32_t t : tile.query(V3{w.x0, -1e9, w.z0}, V3{w.x0 + W * pixel, 1e9, w.z0 + H * pixel})) {
        double xs[3], ys[3], hs[3];
        for (int k = 0; k < 3; ++k) { xs[k] = (tile.p[3 * t + k].x - w.x0) / pixel; ys[k] = (tile.p[3 * t + k].z - w.z0) / pixel; hs[k] = tile.p[3 * t + k].y; }
        const double area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
        if (std::abs(area) < 1e-12) continue;
        const int a0 = std::max(0, static_cast<int>(std::floor(std::min({xs[0], xs[1], xs[2]})))), a1 = std::min(W - 1, static_cast<int>(std::ceil(std::max({xs[0], xs[1], xs[2]}))));
        const int b0 = std::max(0, static_cast<int>(std::floor(std::min({ys[0], ys[1], ys[2]})))), b1 = std::min(H - 1, static_cast<int>(std::ceil(std::max({ys[0], ys[1], ys[2]}))));
        for (int y = b0; y <= b1; ++y) for (int x = a0; x <= a1; ++x) {
            const double px = x + 0.5, py = y + 0.5;
            double w0 = (xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py);
            double w1 = (xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py);
            double w2 = (xs[0] - px) * (ys[1] - py) - (xs[1] - px) * (ys[0] - py);
            if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
            if (w0 < 0 || w1 < 0 || w2 < 0) continue;
            const double s = w0 + w1 + w2;
            w0 /= s; w1 /= s; w2 /= s;
            const float h = static_cast<float>(w0 * hs[0] + w1 * hs[1] + w2 * hs[2]);
            const size_t i = static_cast<size_t>(y) * W + x;
            if (h <= w.height[i]) continue;
            w.height[i] = h;
            double c[3];
            tile.colour(t, w0, w1, w2, c);
            for (int k = 0; k < 3; ++k) w.rgb[i * 3 + k] = static_cast<uint8_t>(std::clamp(c[k] * 255.0 + 0.5, 0.0, 255.0));
        }
    }
    for (auto& v : w.height) if (!std::isfinite(v)) v = std::numeric_limits<float>::quiet_NaN();
    // the walls' direction near the point, from the tile's vertical faces
    constexpr int bins = 180;
    std::vector<double> hist(bins, 0.0);
    const double quarter = std::numbers::pi / 2;
    for (uint32_t t : tile.query(V3{cx - wallRadiusM, -1e9, cz - wallRadiusM}, V3{cx + wallRadiusM, 1e9, cz + wallRadiusM})) {
        const V3& n = tile.n[t];
        if (std::abs(n.y) >= 0.25) continue;
        const V3 c = (tile.p[3 * t] + tile.p[3 * t + 1] + tile.p[3 * t + 2]) * (1.0 / 3.0);
        if (std::hypot(c.x - cx, c.z - cz) > wallRadiusM) continue;
        double a = std::fmod(std::atan2(n.z, n.x), quarter);
        if (a < 0) a += quarter;
        hist[std::min(bins - 1, static_cast<int>(a / quarter * bins))] += tile.area[t];
        w.wallAreaM2 += tile.area[t];
    }
    std::vector<double> sm(bins, 0.0);
    const double sigma = 4.0;  // bins (2 degrees)
    for (int i = 0; i < bins; ++i) for (int d = -12; d <= 12; ++d) sm[i] += hist[((i + d) % bins + bins) % bins] * std::exp(-0.5 * d * d / (sigma * sigma));
    int best = 0;
    for (int i = 1; i < bins; ++i) if (sm[i] > sm[best]) best = i;
    w.wallAngleRad = (best + 0.5) / bins * quarter;
    return w;
}

/** Writes height.f32 (little-endian float32, row-major), colour.rgb (uint8 RGB, row-major) and window.json. */
inline std::string write(const Window& w, const std::string& outDir) {
    {
        std::ofstream h(outDir + "/height.f32", std::ios::binary);
        h.write(reinterpret_cast<const char*>(w.height.data()), static_cast<std::streamsize>(w.height.size() * sizeof(float)));
        std::ofstream c(outDir + "/colour.rgb", std::ios::binary);
        c.write(reinterpret_cast<const char*>(w.rgb.data()), static_cast<std::streamsize>(w.rgb.size()));
    }
    std::ostringstream js;
    js.precision(10);
    js << "{\"height\":\"height.f32\",\"colour\":\"colour.rgb\",\"x0\":" << w.x0 << ",\"z0\":" << w.z0 << ",\"pixel\":" << w.pixel
       << ",\"width\":" << w.width << ",\"rows\":" << w.rows << ",\"wallAngleRad\":" << w.wallAngleRad << ",\"wallAreaM2\":" << w.wallAreaM2 << "}";
    std::ofstream(outDir + "/window.json") << js.str();
    return js.str();
}

}  // namespace scratchbox::topdown_window
