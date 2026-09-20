/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <cmath>

using namespace scratchbox;
using namespace scratchbox::spz;

void writeBinary(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
}

std::vector<uint8_t> readBinary(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in.is_open()) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
}

// Generate synthetic Gaussian Splats (e.g. volumetric spherical cluster with spiral arms)
std::vector<GaussianSplat> generateSyntheticSplats(size_t count = 1000) {
    std::vector<GaussianSplat> splats;
    splats.reserve(count);

    for (size_t i = 0; i < count; ++i) {
        float t = static_cast<float>(i) / static_cast<float>(count);
        float angle = t * 20.0f;
        float radius = 0.5f + t * 4.0f;
        float height = std::sin(t * 10.0f) * 0.8f;

        GaussianSplat s;
        s.position = Vec3(
            radius * std::cos(angle),
            height,
            radius * std::sin(angle)
        );

        float splatSize = 0.04f + 0.02f * std::sin(t * 30.0f);
        s.scale = Vec3(splatSize * 1.5f, splatSize * 0.8f, splatSize * 0.3f);

        // Compute rotation tangent to spiral
        Vec3 tangent(-std::sin(angle), 0.2f, std::cos(angle));
        tangent = tangent.normalized();
        s.rotation = Quat::fromAxisAngle(Vec3(0, 1, 0), angle);

        // Vibrant color gradient: cyan -> magenta -> gold
        s.color = Vec3(
            0.5f + 0.5f * std::cos(t * math::TWO_PI),
            0.5f + 0.5f * std::sin(t * math::TWO_PI),
            1.0f - t
        );
        s.opacity = 0.85f;

        splats.push_back(s);
    }

    return splats;
}

// Parse 3D Gaussian Splatting ASCII PLY file
std::vector<GaussianSplat> readPly(const std::string& path) {
    std::ifstream in(path);
    if (!in.is_open()) return {};

    std::string line;
    size_t vertexCount = 0;
    bool inHeader = true;

    while (inHeader && std::getline(in, line)) {
        if (line.rfind("element vertex", 0) == 0) {
            std::sscanf(line.c_str(), "element vertex %zu", &vertexCount);
        } else if (line == "end_header" || line.rfind("end_header", 0) == 0) {
            inHeader = false;
        }
    }

    std::vector<GaussianSplat> splats;
    if (vertexCount > 0) {
        splats.reserve(vertexCount);
    }

    float x, y, z, nx, ny, nz, r, g, b, op, s0, s1, s2, rot0, rot1, rot2, rot3;
    while (in >> x >> y >> z >> nx >> ny >> nz >> r >> g >> b >> op >> s0 >> s1 >> s2 >> rot0 >> rot1 >> rot2 >> rot3) {
        GaussianSplat s;
        s.position = Vec3(x, y, z);
        s.color = Vec3(
            std::clamp(r, 0.0f, 1.0f),
            std::clamp(g, 0.0f, 1.0f),
            std::clamp(b, 0.0f, 1.0f)
        );
        s.opacity = (op > 1.0f || op < 0.0f) ? (1.0f / (1.0f + std::exp(-op))) : op;

        float sx = std::clamp(std::exp(s0), 0.0005f, 0.1f);
        float sy = std::clamp(std::exp(s1), 0.0005f, 0.1f);
        float sz = std::clamp(std::exp(s2), 0.0005f, 0.1f);
        s.scale = Vec3(sx, sy, sz);

        Quat q(rot1, rot2, rot3, rot0);
        float lenSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
        s.rotation = (lenSq > 1e-6f) ? q.normalized() : Quat::identity();

        splats.push_back(s);
    }

    return splats;
}

int main(int argc, char** argv) {
    std::string inputPath = "";
    std::string outSplat = "";
    std::string outSpz = "";
    std::string outGlb = "";
    float voxelSize = 0.0f;
    bool synthetic = false;
    size_t syntheticCount = 1000;
    bool jsonOutput = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--out-splat" && i + 1 < argc) {
            outSplat = argv[++i];
        } else if (arg == "--out-spz" && i + 1 < argc) {
            outSpz = argv[++i];
        } else if (arg == "--out-glb" && i + 1 < argc) {
            outGlb = argv[++i];
        } else if (arg == "--voxelize" && i + 1 < argc) {
            voxelSize = std::stof(argv[++i]);
        } else if (arg == "--synthetic") {
            synthetic = true;
        } else if (arg == "--count" && i + 1 < argc) {
            syntheticCount = std::stoul(argv[++i]);
            synthetic = true;
        } else if (arg == "--json") {
            jsonOutput = true;
        }
    }

    std::vector<GaussianSplat> splats;

    if (synthetic || inputPath.empty()) {
        splats = generateSyntheticSplats(syntheticCount);
    } else if (inputPath.ends_with(".ply")) {
        splats = readPly(inputPath);
    } else {
        auto inBytes = readBinary(inputPath);
        if (inBytes.empty()) {
            std::cerr << "Failed to read input file: " << inputPath << std::endl;
            return 1;
        }

        if (inputPath.ends_with(".spz") || GzipCodec::isGzip(inBytes.data(), inBytes.size())) {
            splats = SpzCodec::decode(inBytes.data(), inBytes.size());
        } else {
            splats = SplatCodec::decode(inBytes.data(), inBytes.size());
        }
    }

    if (voxelSize > 0.0f) {
        splats = SplatMeshBuilder::voxelize(splats, voxelSize);
    }

    size_t splatBytes = 0;
    size_t spzBytes = 0;
    size_t glbBytes = 0;

    if (!outSplat.empty()) {
        auto bytes = SplatCodec::encode(splats);
        splatBytes = bytes.size();
        writeBinary(outSplat, bytes);
    }

    if (!outSpz.empty()) {
        auto bytes = SpzCodec::encode(splats);
        spzBytes = bytes.size();
        writeBinary(outSpz, bytes);
    }

    if (!outGlb.empty()) {
        auto bytes = SplatMeshBuilder::exportToGlb(splats);
        glbBytes = bytes.size();
        writeBinary(outGlb, bytes);
    }

    // Compute bounding box
    Vec3 bMin(1e9f, 1e9f, 1e9f);
    Vec3 bMax(-1e9f, -1e9f, -1e9f);
    Vec3 centroid(0, 0, 0);

    for (const auto& s : splats) {
        bMin.x = std::min(bMin.x, s.position.x);
        bMin.y = std::min(bMin.y, s.position.y);
        bMin.z = std::min(bMin.z, s.position.z);

        bMax.x = std::max(bMax.x, s.position.x);
        bMax.y = std::max(bMax.y, s.position.y);
        bMax.z = std::max(bMax.z, s.position.z);

        centroid = centroid + s.position;
    }

    if (!splats.empty()) {
        centroid = centroid * (1.0f / static_cast<float>(splats.size()));
    }

    if (jsonOutput) {
        std::cout << "{"
                  << "\"success\":true,"
                  << "\"numSplats\":" << splats.size() << ","
                  << "\"splatBytes\":" << splatBytes << ","
                  << "\"spzBytes\":" << spzBytes << ","
                  << "\"glbBytes\":" << glbBytes << ","
                  << "\"bounds\":{"
                  << "\"min\":[" << bMin.x << "," << bMin.y << "," << bMin.z << "],"
                  << "\"max\":[" << bMax.x << "," << bMax.y << "," << bMax.z << "]"
                  << "},"
                  << "\"centroid\":[" << centroid.x << "," << centroid.y << "," << centroid.z << "]"
                  << "}" << std::endl;
    } else {
        std::cout << "Successfully processed " << splats.size() << " Gaussian Splats." << std::endl;
        std::cout << "Bounds: [" << bMin.x << ", " << bMin.y << ", " << bMin.z << "] to ["
                  << bMax.x << ", " << bMax.y << ", " << bMax.z << "]" << std::endl;
    }

    return 0;
}
