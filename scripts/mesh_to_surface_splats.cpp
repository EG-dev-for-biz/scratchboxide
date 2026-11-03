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
 *   shape <sigmaRatio> <thicknessRatio>                       (optional)
 *   views <cellM> <smoothCost>                                (optional)
 *   colour <gainCos> <maxGainLog> <fieldNx> <fieldNy>         (optional; fieldNx 0 turns the offset field off)
 *   station <rgb8 path> <W> <H> <fx> <fy> <cx> <cy> <eye xyz> <right xyz> <up xyz> <fwd xyz>
 *           <depth f32 path> <DW> <DH> <dfx> <dfy> <dcx> <dcy> <priority>
 *   mask <u8 path>                                            (optional; W x H, where the station above does not see
 *                                                              the scan: its sky, what its photo disagrees with)
 *   tile <uv f32 x 6 per triangle> <texture i32 per triangle> <moved u8 per triangle>
 *                                                             (optional: the scan's own photo texture of the triangles)
 *   texture <rgb8 path> <W> <H>                               (the tile's textures, in index order)
 *   provenance <u8 path>                                      (optional: each splat's colour source, 0 true view,
 *                                                              1 tile texture, 2 generated)
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
    std::string outSplat, outSpz, provenancePath, line;
    surfacesplats::TileSurface tile;
    bool hasTile = false;
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
        } else if (key == "shape") {
            in >> prm.sigmaRatio >> prm.thicknessRatio;
        } else if (key == "views") {
            in >> prm.cellM >> prm.smoothCost;
        } else if (key == "colour") {
            in >> prm.gainCos >> prm.maxGainLog >> prm.fieldNx >> prm.fieldNy;
        } else if (key == "station") {
            surfacesplats::StationView s;
            std::string rgbPath, depthPath;
            in >> rgbPath >> s.W >> s.H >> s.fx >> s.fy >> s.cx >> s.cy;
            s.eye = readVec(in); s.right = readVec(in); s.up = readVec(in); s.fwd = readVec(in);
            in >> depthPath >> s.DW >> s.DH >> s.dfx >> s.dfy >> s.dcx >> s.dcy >> s.priority;
            if (!readAll(rgbPath, s.rgb, static_cast<size_t>(s.W) * s.H * 3)) { std::cerr << "cannot read the station image " << rgbPath << std::endl; return 3; }
            if (!readAll(depthPath, s.depth, static_cast<size_t>(s.DW) * s.DH)) { std::cerr << "cannot read the station depth " << depthPath << std::endl; return 3; }
            stations.push_back(std::move(s));
        } else if (key == "mask") {
            std::string path; in >> path;
            if (stations.empty()) { std::cerr << "a mask line needs its station line before it" << std::endl; return 2; }
            auto& s = stations.back();
            if (!readAll(path, s.mask, static_cast<size_t>(s.W) * s.H)) { std::cerr << "cannot read the station mask " << path << std::endl; return 3; }
        } else if (key == "tile") {
            std::string uvPath, texPath, movedPath; in >> uvPath >> texPath >> movedPath;
            const size_t n = tris.size() / 9;
            if (!n) { std::cerr << "a tile line needs the triangles line before it" << std::endl; return 2; }
            if (!readAll(uvPath, tile.uv, n * 6) || !readAll(texPath, tile.tex, n) || !readAll(movedPath, tile.moved, n)) { std::cerr << "cannot read the tile texture's triangles" << std::endl; return 3; }
            hasTile = true;
        } else if (key == "texture") {
            std::string path; surfacesplats::TileTexture t; in >> path >> t.W >> t.H;
            if (!readAll(path, t.rgb, static_cast<size_t>(t.W) * t.H * 3)) { std::cerr << "cannot read the tile texture " << path << std::endl; return 3; }
            tile.textures.push_back(std::move(t));
        } else if (key == "provenance") {
            in >> provenancePath;
        } else if (key == "out") {
            in >> outSplat >> outSpz;
        }
    }
    if (tris.empty() || stations.empty() || outSplat.empty()) { std::cerr << "the manifest needs triangles, stations and out" << std::endl; return 2; }

    surfacesplats::Report rep;
    std::vector<uint8_t> sources;
    const auto splats = surfacesplats::build(tris, stations, prm, rep, hasTile ? &tile : nullptr, provenancePath.empty() ? nullptr : &sources);
    if (!provenancePath.empty()) {
        std::ofstream f(provenancePath, std::ios::binary);
        f.write(reinterpret_cast<const char*>(sources.data()), static_cast<std::streamsize>(sources.size()));
    }
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
              << ",\"patches\":" << rep.patches << ",\"relabelled\":" << rep.relabelled << ",\"fallback\":" << rep.fallback
              << ",\"seams\":{\"pairs\":" << rep.seams.pairs << ",\"inliers\":" << rep.seams.inliers << ",\"medianAll\":" << rep.seams.medianAll << ",\"before\":" << rep.seams.before << ",\"afterGain\":" << rep.seams.afterGain
              << ",\"after\":" << rep.seams.after << ",\"gainResidual\":" << rep.seams.gainResidual << ",\"gainsAtBound\":" << rep.seams.gainsAtBound << ",\"gainsKept\":" << (rep.seams.gainsKept ? "true" : "false")
              << ",\"fieldKept\":" << (rep.seams.fieldKept ? "true" : "false") << "},\"gains\":[";
    for (size_t i = 0; i < rep.gains.size(); ++i) std::cout << (i ? "," : "") << "[" << rep.gains[i][0] << "," << rep.gains[i][1] << "," << rep.gains[i][2] << "]";
    std::cout << "],\"sources\":{\"trueView\":" << rep.trueView << ",\"tileTexture\":" << rep.tileTexture << ",\"generated\":" << rep.generated
              << ",\"generatedMoved\":" << rep.generatedMoved << ",\"generatedUntextured\":" << rep.generatedUntextured
              << ",\"patches\":{\"trueView\":" << rep.patchesTrueView << ",\"tileTexture\":" << rep.patchesTile << ",\"generated\":" << rep.patchesGenerated << "}"
              << ",\"tileGain\":[" << rep.tileGain[0] << "," << rep.tileGain[1] << "," << rep.tileGain[2] << "],\"tileGainSamples\":" << rep.tileGainSamples << ",\"tileToneStations\":" << rep.tileToneStations << "},\"stationPatches\":[";
    for (size_t i = 0; i < rep.stationPatches.size(); ++i) std::cout << (i ? "," : "") << rep.stationPatches[i];
    std::cout << "],\"ms\":" << static_cast<long>(ms) << "}" << std::endl;
    return 0;
}
