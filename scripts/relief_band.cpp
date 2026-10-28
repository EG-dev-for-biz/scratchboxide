/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * CLI of the photometric relief's analysis on bands of a straightened facade photo (scratchbox_photometric_relief.hpp
 * analyzeOrthophoto), for the window fit (window-fit.ts). Optionally hides alternate stripes along the wall or bands up
 * it (the held-out folds), so a fold is read without writing a second image. Prints one JSON line per band: its grid
 * (pitches, cell, dark runs) in plane s/t metres.
 *
 *   relief_band <facade.png> <uncovered.png|-> <pixel> <orthoSMin> <orthoTMax> <texel> <hide: -|s|t> <span px> <parity> <x0 x1 y0 y1>...
 *
 * Build:
 *   clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/relief_band.cpp -o build/3d-native/relief_band -lz
 */

#include "scratchbox_photometric_relief.hpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

using namespace scratchbox;
namespace pr = scratchbox::photometric_relief;

static std::vector<uint8_t> readFile(const std::string& p) {
    std::ifstream f(p, std::ios::binary);
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(f), {});
}

static std::string runs(const std::vector<std::pair<double, double>>& r) {
    std::string s = "[";
    for (size_t i = 0; i < r.size(); ++i) s += (i ? ",[" : "[") + std::to_string(r[i].first) + "," + std::to_string(r[i].second) + "]";
    return s + "]";
}

int main(int argc, char** argv) {
    if (argc < 14 || (argc - 10) % 4 != 0) {
        std::cerr << "usage: relief_band facade.png uncovered.png|- pixel orthoSMin orthoTMax texel hide(-|s|t) span parity x0 x1 y0 y1...\n";
        return 2;
    }
    const auto bytes = readFile(argv[1]);
    const auto dec = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgba);
    if (!dec.ok) { std::cerr << "cannot decode " << argv[1] << ": " << dec.error << "\n"; return 1; }
    const auto& img = dec.image;
    std::vector<uint8_t> unc;
    int uw = 0;
    if (std::string(argv[2]) != "-") {
        const auto ub = readFile(argv[2]);
        const auto ud = png::decode(ub.data(), ub.size(), png::OutputFormat::Rgba);
        if (!ud.ok) { std::cerr << "cannot decode " << argv[2] << ": " << ud.error << "\n"; return 1; }
        uw = ud.image.width;
        unc.resize(static_cast<size_t>(ud.image.width) * ud.image.height);
        for (size_t i = 0; i < unc.size(); ++i) unc[i] = ud.image.data[i * ud.image.channels];
    }
    const double pixel = std::stod(argv[3]), sMin = std::stod(argv[4]), tMax = std::stod(argv[5]), texel = std::stod(argv[6]);
    const char hide = argv[7][0];
    const int span = std::max(1, std::stoi(argv[8])), parity = std::stoi(argv[9]);
    // a held-out fold: alternate stripes along the wall (s) or bands up it (t) of `span` pixels, those of `parity` hidden
    const auto hidden = [&](int x, int y) { return (hide == 's' && (x / span) % 2 == parity) || (hide == 't' && (y / span) % 2 == parity); };
    pr::ReliefParams p;
    for (int a = 10; a + 3 < argc; a += 4) {
        const int x0 = std::stoi(argv[a]), x1 = std::stoi(argv[a + 1]), y0 = std::stoi(argv[a + 2]), y1 = std::stoi(argv[a + 3]);
        pr::Orthophoto o;
        o.width = std::max(0, x1 - x0); o.height = std::max(0, y1 - y0); o.pixel = pixel;
        o.sMin = sMin + x0 * pixel; o.tMax = tMax - y0 * pixel;
        const size_t N = static_cast<size_t>(o.width) * o.height;
        o.lum.assign(N, 0.f); o.rgb.assign(N * 3, 0); o.cov.assign(N, 0);
        for (int y = 0; y < o.height; ++y) for (int x = 0; x < o.width; ++x) {
            const int sx = x0 + x, sy = y0 + y;
            if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height || hidden(sx, sy)) continue;
            const size_t si = (static_cast<size_t>(sy) * img.width + sx) * img.channels, di = static_cast<size_t>(y) * o.width + x;
            if (img.channels == 4 && img.data[si + 3] == 0) continue;
            if (!unc.empty() && unc[static_cast<size_t>(sy) * uw + sx] >= 128) continue;
            const double r = img.data[si] / 255.0, g = img.data[si + 1] / 255.0, b = img.data[si + 2] / 255.0;
            o.lum[di] = static_cast<float>(0.2126 * r + 0.7152 * g + 0.0722 * b);
            for (int c = 0; c < 3; ++c) o.rgb[di * 3 + c] = img.data[si + c];
            o.cov[di] = 1;
        }
        const auto fa = pr::analyzeOrthophoto(o, texel, p);
        std::cout << "{\"band\":[" << x0 << "," << x1 << "," << y0 << "," << y1 << "]"
                  << ",\"periodS\":{\"found\":" << (fa.periodS.found ? "true" : "false") << ",\"pitch\":" << fa.periodS.pitch << "}"
                  << ",\"periodT\":{\"found\":" << (fa.periodT.found ? "true" : "false") << ",\"pitch\":" << fa.periodT.pitch << "}"
                  << ",\"cell\":{\"foundS\":" << (fa.cell.foundS ? "true" : "false") << ",\"foundT\":" << (fa.cell.foundT ? "true" : "false")
                  << ",\"runsS\":" << runs(fa.cell.runsS) << ",\"runsT\":" << runs(fa.cell.runsT) << "}}\n";
    }
    return 0;
}
