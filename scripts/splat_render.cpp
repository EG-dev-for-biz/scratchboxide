/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * splat_render: renders a splat file (.spz or .splat) from pinhole views in the photo-match judge's neutral light or clay
 * (scratchbox_splat_raster.hpp). Driven by splat-arm-render.ts through a plain-text manifest:
 *
 *   splats <.spz or .splat path>
 *   offset <dx> <dy> <dz>                                                          (optional, after splats: moves every splat)
 *   labels <uint8 per splat path> <sky label>                                     (optional: per-pixel regions)
 *   light <ambient> <bg r> <bg g> <bg b> <near m>                                  (sRGB8 background)
 *   clay <albedo r> <albedo g> <albedo b> <ambient> <bg r> <bg g> <bg b>
 *   view <out prefix> <textured|clay> <W> <H> <fx> <fy> <cx> <cy> <eye xyz> <right xyz> <up xyz> <fwd xyz>
 *   positions <out path>                                                          (float32 x y z per splat, file order)
 *
 * Each view writes <prefix>.rgba (RGBA8, row 0 at the top), <prefix>.cov (float32 coverage) and, with labels,
 * <prefix>.reg (uint8). Prints one JSON line per view, then a summary line.
 */

#include "scratchbox_splat_raster.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox;
using scratchbox::math::Vec3;

static bool readFile(const std::string& path, std::vector<uint8_t>& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    return true;
}

template <typename T>
static void writeFile(const std::string& path, const std::vector<T>& data) {
    std::ofstream f(path, std::ios::binary);
    f.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size() * sizeof(T)));
}

static Vec3 readVec(std::istream& in) { float x, y, z; in >> x >> y >> z; return Vec3(x, y, z); }

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "usage: splat_render <manifest>" << std::endl; return 2; }
    std::ifstream mf(argv[1]);
    if (!mf) { std::cerr << "cannot read the manifest " << argv[1] << std::endl; return 2; }
    std::vector<spz::GaussianSplat> splats;
    std::vector<uint8_t> labels;
    uint8_t skyLabel = 0;
    splatraster::Light light;
    std::string line;
    size_t views = 0;
    const auto t0 = std::chrono::steady_clock::now();
    while (std::getline(mf, line)) {
        std::istringstream in(line);
        std::string key;
        if (!(in >> key)) continue;
        if (key == "splats") {
            std::string path; in >> path;
            std::vector<uint8_t> bytes;
            if (!readFile(path, bytes)) { std::cerr << "cannot read the splats " << path << std::endl; return 3; }
            const bool isSpz = path.size() > 4 && path.compare(path.size() - 4, 4, ".spz") == 0;
            splats = isSpz ? spz::SpzCodec::decode(bytes.data(), bytes.size()) : spz::SplatCodec::decode(bytes.data(), bytes.size());
            if (splats.empty()) { std::cerr << "no splats in " << path << std::endl; return 3; }
        } else if (key == "offset") {
            if (splats.empty()) { std::cerr << "an offset before the splats" << std::endl; return 2; }
            const Vec3 d = readVec(in);
            if (!in) { std::cerr << "a malformed offset line: " << line << std::endl; return 2; }
            for (auto& s : splats) s.position = s.position + d;
        } else if (key == "labels") {
            std::string path; int sky = 0; in >> path >> sky;
            if (!readFile(path, labels)) { std::cerr << "cannot read the labels " << path << std::endl; return 3; }
            skyLabel = static_cast<uint8_t>(sky);
            if (labels.size() != splats.size()) { std::cerr << "labels: " << labels.size() << " for " << splats.size() << " splats" << std::endl; return 3; }
        } else if (key == "light") {
            in >> light.ambient >> light.background[0] >> light.background[1] >> light.background[2] >> light.nearM;
        } else if (key == "clay") {
            in >> light.clayAlbedo[0] >> light.clayAlbedo[1] >> light.clayAlbedo[2] >> light.clayAmbient >> light.clayBackground[0] >> light.clayBackground[1] >> light.clayBackground[2];
        } else if (key == "positions") {
            std::string path; in >> path;
            std::vector<float> xyz;
            xyz.reserve(splats.size() * 3);
            for (const auto& s : splats) { xyz.push_back(s.position.x); xyz.push_back(s.position.y); xyz.push_back(s.position.z); }
            writeFile(path, xyz);
        } else if (key == "view") {
            if (splats.empty()) { std::cerr << "a view before the splats" << std::endl; return 2; }
            std::string prefix, mode;
            splatraster::Camera cam;
            in >> prefix >> mode >> cam.width >> cam.height >> cam.fx >> cam.fy >> cam.cx >> cam.cy;
            cam.eye = readVec(in); cam.right = readVec(in); cam.up = readVec(in); cam.fwd = readVec(in);
            if (!in || cam.width <= 0 || cam.height <= 0) { std::cerr << "a malformed view line: " << line << std::endl; return 2; }
            splatraster::Light l = light;
            l.clay = mode == "clay";
            const auto v0 = std::chrono::steady_clock::now();
            const auto r = splatraster::render(splats, labels, skyLabel, cam, l);
            writeFile(prefix + ".rgba", r.rgba);
            writeFile(prefix + ".cov", r.coverage);
            if (!r.regions.empty()) writeFile(prefix + ".reg", r.regions);
            const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - v0).count();
            std::cout << "{\"view\":\"" << prefix << "\",\"drawn\":" << r.drawn << ",\"ms\":" << static_cast<long>(ms) << "}" << std::endl;
            views++;
        }
    }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    std::cout << "{\"splats\":" << splats.size() << ",\"views\":" << views << ",\"ms\":" << static_cast<long>(ms) << "}" << std::endl;
    return 0;
}
