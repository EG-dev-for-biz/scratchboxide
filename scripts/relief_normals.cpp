/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * relief_normals: height maps to normal maps and back (scratchbox_relief_normals.hpp), as a small CLI driver.
 *
 *   relief_normals --height <h.f32> --width W --rows H --texel M --out <normal.png>
 *       a height map (float32 little-endian, metres, row 0 at the top, NaN unknown) to a tangent-space normal map
 *       (RGB = (n + 1) / 2; x right, y up the image, z out), the glTF convention
 *   relief_normals --normal <normal.png> --texel M --out <h.f32>
 *       a normal map to the height it implies (Frankot-Chellappa on the mirrored grid), zero mean
 *   relief_normals --selftest
 *       a synthetic relief through both ways; prints the round trip's RMS error (m) as JSON
 */
#include "scratchbox_png.hpp"
#include "scratchbox_relief_normals.hpp"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

namespace rn = scratchbox::relief_normals;

static std::vector<uint8_t> readAll(const std::string& f) {
    std::ifstream in(f, std::ios::binary);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

static scratchbox::texture::ImageBuffer toImage(const rn::NormalMap& m) {
    scratchbox::texture::ImageBuffer img(m.width, m.height, 3);
    for (size_t i = 0; i < static_cast<size_t>(m.width) * m.height; ++i)
        for (int k = 0; k < 3; ++k) img.data[i * 3 + k] = static_cast<uint8_t>(std::lround(std::fmin(1.0, std::fmax(0.0, (m.n[i * 3 + k] + 1.0) * 0.5)) * 255.0));
    return img;
}

int main(int argc, char** argv) {
    std::string heightIn, normalIn, out;
    int W = 0, H = 0;
    double texel = 0;
    bool selftest = false;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        auto next = [&]() -> std::string { if (i + 1 >= argc) { std::cerr << "missing value for " << a << "\n"; std::exit(2); } return argv[++i]; };
        if (a == "--height") heightIn = next();
        else if (a == "--normal") normalIn = next();
        else if (a == "--out") out = next();
        else if (a == "--width") W = std::atoi(next().c_str());
        else if (a == "--rows") H = std::atoi(next().c_str());
        else if (a == "--texel") texel = std::atof(next().c_str());
        else if (a == "--selftest") selftest = true;
        else { std::cerr << "unknown argument " << a << "\n"; return 2; }
    }
    if (selftest) {
        // a 6 m x 4 m patch at 2 cm: a 10 cm deep recess with sloped sides and a gentle 2 cm wave
        W = 300; H = 200; texel = 0.02;
        std::vector<float> h(static_cast<size_t>(W) * H);
        for (int y = 0; y < H; ++y) for (int x = 0; x < W; ++x) {
            const double sx = x * texel, sy = y * texel;
            const double rx = std::fmin(std::fmax((std::fabs(sx - 3.0) - 1.0) / 0.1, 0.0), 1.0), ry = std::fmin(std::fmax((std::fabs(sy - 2.0) - 0.8) / 0.1, 0.0), 1.0);
            h[static_cast<size_t>(y) * W + x] = static_cast<float>(-0.10 * (1.0 - std::fmax(rx, ry)) + 0.02 * std::sin(sx * 2.0) * std::cos(sy * 1.5));
        }
        const auto n = rn::heightToNormals(W, H, h, texel);
        const auto back = rn::integrateNormals(n, texel);
        double mh = 0, mb = 0;
        for (size_t i = 0; i < h.size(); ++i) { mh += h[i]; mb += back[i]; }
        mh /= h.size(); mb /= h.size();
        double se = 0, peak = 0;
        for (size_t i = 0; i < h.size(); ++i) { const double e = (back[i] - mb) - (h[i] - mh); se += e * e; peak = std::fmax(peak, std::fabs(e)); }
        std::printf("{\"ok\": true, \"width\": %d, \"rows\": %d, \"texelM\": %.3f, \"rmsM\": %.6f, \"maxM\": %.6f}\n", W, H, texel, std::sqrt(se / h.size()), peak);
        return 0;
    }
    if (!(texel > 0) || out.empty()) { std::cerr << "--texel and --out are required\n"; return 2; }
    if (!heightIn.empty()) {
        if (W <= 0 || H <= 0) { std::cerr << "--width and --rows are required with --height\n"; return 2; }
        const auto bytes = readAll(heightIn);
        if (bytes.size() != static_cast<size_t>(W) * H * 4) { std::cerr << "height file is " << bytes.size() << " bytes, expected " << W * H * 4 << "\n"; return 1; }
        std::vector<float> h(static_cast<size_t>(W) * H);
        std::memcpy(h.data(), bytes.data(), bytes.size());
        const auto png = scratchbox::png::encode(toImage(rn::heightToNormals(W, H, h, texel)));
        std::ofstream o(out, std::ios::binary);
        o.write(reinterpret_cast<const char*>(png.data()), static_cast<std::streamsize>(png.size()));
        if (!o) { std::cerr << "cannot write " << out << "\n"; return 1; }
        std::printf("{\"ok\": true, \"width\": %d, \"rows\": %d}\n", W, H);
        return 0;
    }
    if (!normalIn.empty()) {
        const auto bytes = readAll(normalIn);
        const auto d = scratchbox::png::decode(bytes.data(), bytes.size(), scratchbox::png::OutputFormat::Rgb);
        if (!d.ok) { std::cerr << "cannot read " << normalIn << ": " << d.error << "\n"; return 1; }
        rn::NormalMap m{d.image.width, d.image.height, std::vector<float>(static_cast<size_t>(d.image.width) * d.image.height * 3)};
        for (size_t i = 0; i < m.n.size(); ++i) m.n[i] = d.image.data[i] / 255.0f * 2.0f - 1.0f;
        const auto h = rn::integrateNormals(m, texel);
        std::ofstream o(out, std::ios::binary);
        o.write(reinterpret_cast<const char*>(h.data()), static_cast<std::streamsize>(h.size() * 4));
        if (!o) { std::cerr << "cannot write " << out << "\n"; return 1; }
        std::printf("{\"ok\": true, \"width\": %d, \"rows\": %d}\n", m.width, m.height);
        return 0;
    }
    std::cerr << "give --height, --normal or --selftest\n";
    return 2;
}
