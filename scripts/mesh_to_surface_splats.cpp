/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * mesh_to_surface_splats: a splat for every patch of a scanned surface, coloured from station images
 * (scratchbox_surface_splats.hpp). Driven by SurfaceSplatLayerService through a plain-text manifest:
 *
 *   triangles <path to float32 xyz x 9 per triangle> <count>
 *   corridor <ax> <ay> <az> <bx> <by> <bz>
 *   spacing <k> <sMin> <sMax> <budget>
 *   incidence <minCos> <relaxedCos>
 *   unseen <spacing> <maxDist>
 *   station <rgb8 path> <W> <H> <fx> <fy> <cx> <cy> <eye xyz> <right xyz> <up xyz> <fwd xyz>
 *           <depth f32 path> <DW> <DH> <dfx> <dfy> <dcx> <dcy> <priority>
 *   out <.splat path> <.spz path>
 *
 * Prints a JSON report on stdout.
 */

#include "scratchbox_surface_splats.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox;
using scratchbox::math::Vec3;

template <typename T>
static bool readAll(const std::string& path, std::vector<T>& out, size_t count) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    out.resize(count);
    f.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(count * sizeof(T)));
    return static_cast<size_t>(f.gcount()) == count * sizeof(T);
}

static Vec3 readVec(std::istream& in) { float x, y, z; in >> x >> y >> z; return Vec3(x, y, z); }

int main(int argc, char** argv) {
    if (argc < 2) { std::cerr << "usage: mesh_to_surface_splats <manifest>" << std::endl; return 2; }
    const auto t0 = std::chrono::steady_clock::now();
    std::ifstream mf(argv[1]);
    if (!mf) { std::cerr << "cannot read the manifest " << argv[1] << std::endl; return 2; }
    surfacesplats::Params prm;
    std::vector<float> tris;
    std::vector<surfacesplats::StationView> stations;
    std::string outSplat, outSpz, line;
    while (std::getline(mf, line)) {
        std::istringstream in(line);
        std::string key;
        if (!(in >> key)) continue;
        if (key == "triangles") {
            std::string path; size_t n; in >> path >> n;
            if (!readAll(path, tris, n * 9)) { std::cerr << "cannot read the triangles " << path << std::endl; return 3; }
        } else if (key == "corridor") {
            prm.corridorA = readVec(in); prm.corridorB = readVec(in);
        } else if (key == "spacing") {
            in >> prm.k >> prm.sMin >> prm.sMax >> prm.budget;
        } else if (key == "incidence") {
            in >> prm.minCos >> prm.relaxedCos;
        } else if (key == "unseen") {
            in >> prm.unseenSpacing >> prm.unseenMaxDist;
        } else if (key == "station") {
            surfacesplats::StationView s;
            std::string rgbPath, depthPath;
            in >> rgbPath >> s.W >> s.H >> s.fx >> s.fy >> s.cx >> s.cy;
            s.eye = readVec(in); s.right = readVec(in); s.up = readVec(in); s.fwd = readVec(in);
            in >> depthPath >> s.DW >> s.DH >> s.dfx >> s.dfy >> s.dcx >> s.dcy >> s.priority;
            if (!readAll(rgbPath, s.rgb, static_cast<size_t>(s.W) * s.H * 3)) { std::cerr << "cannot read the station image " << rgbPath << std::endl; return 3; }
            if (!readAll(depthPath, s.depth, static_cast<size_t>(s.DW) * s.DH)) { std::cerr << "cannot read the station depth " << depthPath << std::endl; return 3; }
            stations.push_back(std::move(s));
        } else if (key == "out") {
            in >> outSplat >> outSpz;
        }
    }
    if (tris.empty() || stations.empty() || outSplat.empty()) { std::cerr << "the manifest needs triangles, stations and out" << std::endl; return 2; }

    surfacesplats::Report rep;
    const auto splats = surfacesplats::build(tris, stations, prm, rep);
    {
        const auto bytes = spz::SplatCodec::encode(splats);
        std::ofstream f(outSplat, std::ios::binary);
        f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    }
    size_t spzBytes = 0;
    if (!outSpz.empty()) {
        const auto bytes = spz::SpzCodec::encode(splats);
        std::ofstream f(outSpz, std::ios::binary);
        f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        spzBytes = bytes.size();
    }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    std::cout << "{\"triangles\":" << rep.triangles << ",\"invisibleTriangles\":" << rep.invisibleTriangles << ",\"skippedTriangles\":" << rep.skippedTriangles
              << ",\"splats\":" << splats.size() << ",\"observed\":" << rep.observed << ",\"relaxed\":" << rep.relaxed
              << ",\"unobserved\":" << rep.unobserved << ",\"spacingScale\":" << rep.spacingScale << ",\"spzBytes\":" << spzBytes
              << ",\"gains\":[";
    for (size_t i = 0; i < rep.gains.size(); ++i) std::cout << (i ? "," : "") << rep.gains[i];
    std::cout << "],\"ms\":" << static_cast<long>(ms) << "}" << std::endl;
    return 0;
}
