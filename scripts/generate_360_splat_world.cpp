/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_360_gaussian.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>

using namespace scratchbox;
using namespace scratchbox::gaussian360;
using namespace scratchbox::spz;

int main(int argc, char** argv) {
    std::string world = "san_marco";
    size_t yawSteps = 1024;
    size_t pitchSteps = 512;
    std::string outSplatPath = "public/models/world_360_san_marco.splat";
    bool jsonOutput = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--world" && i + 1 < argc) world = argv[++i];
        else if (arg == "--yaw-steps" && i + 1 < argc) yawSteps = std::stoul(argv[++i]);
        else if (arg == "--pitch-steps" && i + 1 < argc) pitchSteps = std::stoul(argv[++i]);
        else if (arg == "--out-splat" && i + 1 < argc) outSplatPath = argv[++i];
        else if (arg == "--json") jsonOutput = true;
    }

    auto tStart = std::chrono::high_resolution_clock::now();

    std::vector<GaussianSplat> splats;
    if (world == "cyber_shibuya" || world == "shibuya") {
        splats = Gaussian360Generator::generateCyberShibuyaWorld(yawSteps, pitchSteps);
    } else {
        splats = Gaussian360Generator::generateSanMarcoWorld(yawSteps, pitchSteps);
    }

    std::vector<uint8_t> encodedBytes = SplatCodec::encode(splats);

    // Write binary .splat file
    std::ofstream out(outSplatPath, std::ios::binary);
    if (!out.is_open()) {
        std::cerr << "Failed to open output path: " << outSplatPath << std::endl;
        return 1;
    }
    out.write(reinterpret_cast<const char*>(encodedBytes.data()), encodedBytes.size());
    out.close();

    auto tEnd = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    // Compute bounding box
    Vec3 minB(1e9f, 1e9f, 1e9f);
    Vec3 maxB(-1e9f, -1e9f, -1e9f);
    Vec3 sumPos(0.0f, 0.0f, 0.0f);
    for (const auto& s : splats) {
        minB.x = std::min(minB.x, s.position.x);
        minB.y = std::min(minB.y, s.position.y);
        minB.z = std::min(minB.z, s.position.z);
        maxB.x = std::max(maxB.x, s.position.x);
        maxB.y = std::max(maxB.y, s.position.y);
        maxB.z = std::max(maxB.z, s.position.z);
        sumPos = sumPos + s.position;
    }
    Vec3 centroid = sumPos * (1.0f / static_cast<float>(std::max<size_t>(1, splats.size())));

    if (jsonOutput) {
        std::cout << "{\"success\":true,\"world\":\"" << world << "\",\"numSplats\":" << splats.size()
                  << ",\"splatBytes\":" << encodedBytes.size()
                  << ",\"splatPath\":\"" << outSplatPath << "\""
                  << ",\"elapsedMs\":" << elapsedMs
                  << ",\"bounds\":{\"min\":[" << minB.x << "," << minB.y << "," << minB.z << "]"
                  << ",\"max\":[" << maxB.x << "," << maxB.y << "," << maxB.z << "]}"
                  << ",\"centroid\":[" << centroid.x << "," << centroid.y << "," << centroid.z << "]}"
                  << std::endl;
    } else {
        std::cout << "[Gaussian360] World: " << world << " | Generated " << splats.size()
                  << " splats (" << (encodedBytes.size() / (1024 * 1024.0f)) << " MB) in "
                  << elapsedMs << " ms -> " << outSplatPath << std::endl;
    }

    return 0;
}
