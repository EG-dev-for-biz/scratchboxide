/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Gaussian splats (.splat / .spz) -> 3D Tiles octree of KHR_gaussian_splatting GLB tiles.
// Writes <out>/tiles/{level}/{x}/{y}/{z}.glb and <out>/tree.json; the TypeScript
// Splat3DTilesService assembles tileset.json (with the geodetic root transform) from tree.json.

#include "scratchbox_engine.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_splat_octree.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <chrono>

using namespace scratchbox;
using namespace scratchbox::spz;
using namespace scratchbox::splattiles;
namespace fs = std::filesystem;

static std::vector<uint8_t> readFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f.is_open()) return {};
    std::streamsize size = f.tellg();
    f.seekg(0, std::ios::beg);
    std::vector<uint8_t> buf(static_cast<size_t>(size));
    f.read(reinterpret_cast<char*>(buf.data()), size);
    return buf;
}

static void writeFile(const fs::path& path, const std::vector<uint8_t>& bytes) {
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
}

int main(int argc, char** argv) {
    std::string inputPath, outDir;
    OctreeOptions opts;
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--input" && i + 1 < argc) inputPath = argv[++i];
        else if (a == "--out-dir" && i + 1 < argc) outDir = argv[++i];
        else if (a == "--max-depth" && i + 1 < argc) opts.maxDepth = std::stoi(argv[++i]);
        else if (a == "--leaf-capacity" && i + 1 < argc) opts.leafCapacity = static_cast<size_t>(std::stoul(argv[++i]));
        else if (a == "--interior-budget" && i + 1 < argc) opts.interiorBudget = static_cast<size_t>(std::stoul(argv[++i]));
        else if (a == "--geometric-error-scale" && i + 1 < argc) opts.geometricErrorScale = std::stof(argv[++i]);
        else if (a == "--json") emitJson = true;
    }
    if (inputPath.empty() || outDir.empty()) {
        std::cerr << "Usage: splat_to_3dtiles --input <cloud.splat|cloud.spz> --out-dir <dir> [--max-depth 5] [--leaf-capacity 65536] [--interior-budget 32768] [--geometric-error-scale 0.25] [--json]" << std::endl;
        return 1;
    }

    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<uint8_t> bytes = readFile(inputPath);
    if (bytes.empty()) { std::cerr << "ERROR: cannot read " << inputPath << std::endl; return 1; }

    std::vector<GaussianSplat> splats;
    const bool isGz = GzipCodec::isGzip(bytes.data(), bytes.size());
    if (isGz || inputPath.ends_with(".spz")) {
        splats = SpzCodec::decode(bytes.data(), bytes.size());
    } else {
        splats = SplatCodec::decode(bytes.data(), bytes.size());
    }
    if (splats.empty()) { std::cerr << "ERROR: no splats decoded from " << inputPath << std::endl; return 1; }

    OctreeBuilder builder(splats, opts);
    builder.build();

    fs::path out(outDir);
    fs::create_directories(out / "tiles");
    size_t tileCount = 0, tileBytes = 0;
    int maxLevel = 0;
    for (size_t i = 0; i < builder.nodes.size(); ++i) {
        const auto& n = builder.nodes[i];
        auto content = builder.tileContent(static_cast<int>(i));
        std::vector<uint8_t> glb = SplatTileGlbWriter::write(content);
        fs::path tilePath = out / "tiles" / std::to_string(n.level) / std::to_string(n.x) / std::to_string(n.y) / (std::to_string(n.z) + ".glb");
        writeFile(tilePath, glb);
        tileCount++; tileBytes += glb.size();
        maxLevel = std::max(maxLevel, n.level);
    }

    std::string tree = builder.toJson();
    writeFile(out / "tree.json", std::vector<uint8_t>(tree.begin(), tree.end()));

    double ms = std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - t0).count();
    if (emitJson) {
        std::cout << "{\"success\":true,\"numSplats\":" << splats.size()
                  << ",\"tileCount\":" << tileCount
                  << ",\"levels\":" << (maxLevel + 1)
                  << ",\"tileBytes\":" << tileBytes
                  << ",\"treePath\":\"" << (out / "tree.json").string() << "\""
                  << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[SplatTiles] " << splats.size() << " splats -> " << tileCount << " tiles, " << (maxLevel + 1)
                  << " levels, " << (tileBytes / (1024.0 * 1024.0)) << " MB in " << ms << " ms" << std::endl;
    }
    return 0;
}
