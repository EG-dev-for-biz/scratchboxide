/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_depth_to_gaussian.hpp"
#include "scratchbox_spz.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <cstdlib>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::depthbox;
using namespace scratchbox::spz;

struct RgbImage {
    int width{0};
    int height{0};
    std::vector<uint8_t> pixels; // 3 bytes per pixel RGB

    uint8_t r(int x, int y) const { return pixels[(y * width + x) * 3 + 0]; }
    uint8_t g(int x, int y) const { return pixels[(y * width + x) * 3 + 1]; }
    uint8_t b(int x, int y) const { return pixels[(y * width + x) * 3 + 2]; }
};

// Lossless image loading using FFmpeg rawvideo rgb24 or direct raw file
RgbImage loadRgbImage(const std::string& path) {
    std::string rawPath = path;
    bool isTemp = false;

    bool needsConversion = path.ends_with(".png") || path.ends_with(".jpg") || 
                           path.ends_with(".jpeg") || path.ends_with(".bmp") || 
                           path.ends_with(".webp");

    if (needsConversion) {
        auto now = std::chrono::high_resolution_clock::now().time_since_epoch().count();
        rawPath = "/tmp/sb_pano_" + std::to_string(now) + ".raw";
        std::string cmd = "ffmpeg -y -v error -i \"" + path + "\" -pix_fmt rgb24 -f rawvideo \"" + rawPath + "\"";
        int ret = std::system(cmd.c_str());
        if (ret != 0) {
            std::cerr << "FFmpeg conversion failed for: " << path << std::endl;
            return {};
        }
        isTemp = true;
    }

    std::ifstream f(rawPath, std::ios::binary | std::ios::ate);
    if (!f.is_open()) {
        std::cerr << "Failed to open raw image: " << rawPath << std::endl;
        return {};
    }

    std::streamsize fileSize = f.tellg();
    f.seekg(0, std::ios::beg);

    int w = 0, h = 0;
    if (fileSize == 4096 * 2048 * 3) { w = 4096; h = 2048; }
    else if (fileSize == 2048 * 1024 * 3) { w = 2048; h = 1024; }
    else if (fileSize == 8192 * 4096 * 3) { w = 8192; h = 4096; }
    else {
        h = static_cast<int>(std::round(std::sqrt(fileSize / (2.0 * 3.0))));
        w = 2 * h;
    }

    RgbImage img;
    img.width = w;
    img.height = h;
    img.pixels.resize(fileSize);
    f.read(reinterpret_cast<char*>(img.pixels.data()), fileSize);
    f.close();

    if (isTemp) {
        std::remove(rawPath.c_str());
    }

    return img;
}

std::vector<float> loadDepthFile(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f.is_open()) return {};
    std::streamsize size = f.tellg();
    f.seekg(0, std::ios::beg);
    std::vector<float> depths(size / sizeof(float));
    f.read(reinterpret_cast<char*>(depths.data()), size);
    f.close();
    return depths;
}

std::vector<uint8_t> loadMaskFile(const std::string& path, size_t expectedSize) {
    std::string rawPath = path;
    bool isTemp = false;
    if (path.ends_with(".png") || path.ends_with(".jpg") || path.ends_with(".jpeg")) {
        auto now = std::chrono::high_resolution_clock::now().time_since_epoch().count();
        rawPath = "/tmp/sb_mask_read_" + std::to_string(now) + ".raw";
        std::string cmd = "ffmpeg -y -v error -i \"" + path + "\" -f rawvideo -pix_fmt gray \"" + rawPath + "\"";
        int ret = std::system(cmd.c_str());
        if (ret == 0) {
            isTemp = true;
        } else {
            rawPath = path;
        }
    }

    std::ifstream f(rawPath, std::ios::binary | std::ios::ate);
    if (!f.is_open()) return {};
    std::streamsize size = f.tellg();
    f.seekg(0, std::ios::beg);
    std::vector<uint8_t> mask(size);
    f.read(reinterpret_cast<char*>(mask.data()), size);
    f.close();

    if (isTemp) {
        std::remove(rawPath.c_str());
    }

    if (mask.size() != expectedSize) {
        std::cerr << "WARNING: Loaded mask size (" << mask.size() << ") does not match expected size (" << expectedSize << "). Mask ignored." << std::endl;
        return {};
    }
    return mask;
}

void writeBinary(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
}

int main(int argc, char** argv) {
    std::string inputPath;
    std::string outSpzPath;
    std::string outSplatPath;
    std::string depthPath;
    std::string maskPath;
    std::string profile = "adaptive";
    int stride = 4; // Stride 4 on 4096x2048 = 1024x512 = 524,288 splats
    float eyeHeight = 1.70f;
    float sigmaScale = 0.8f; // Gaussian sigma as a fraction of the sample spacing (see convertEquirectangularToGaussianSplats)

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) inputPath = argv[++i];
        else if (arg == "--out-spz" && i + 1 < argc) outSpzPath = argv[++i];
        else if (arg == "--out-splat" && i + 1 < argc) outSplatPath = argv[++i];
        else if (arg == "--depth" && i + 1 < argc) depthPath = argv[++i];
        else if (arg == "--mask" && i + 1 < argc) maskPath = argv[++i];
        else if (arg == "--profile" && i + 1 < argc) profile = argv[++i];
        else if (arg == "--stride" && i + 1 < argc) stride = std::stoi(argv[++i]);
        else if (arg == "--eye-height" && i + 1 < argc) eyeHeight = std::stof(argv[++i]);
        else if (arg == "--sigma-scale" && i + 1 < argc) sigmaScale = std::stof(argv[++i]);
    }

    if (inputPath.empty() || (outSpzPath.empty() && outSplatPath.empty())) {
        std::cerr << "Usage: panorama_to_3dgs_spz --input <panorama.png|bmp|raw> [--out-spz <out.spz>] [--out-splat <out.splat>] [--depth <depth.f32>] [--mask <mask.png>] [--stride 4] [--eye-height 1.7]" << std::endl;
        return 1;
    }

    auto tStart = std::chrono::high_resolution_clock::now();

    auto img = loadRgbImage(inputPath);
    if (img.width <= 0 || img.height <= 0 || img.pixels.empty()) {
        std::cerr << "ERROR: Failed to load panorama image: " << inputPath << std::endl;
        return 1;
    }

    std::vector<float> depths;
    if (!depthPath.empty()) {
        depths = loadDepthFile(depthPath);
        if (depths.size() != static_cast<size_t>(img.width * img.height)) {
            std::cerr << "WARNING: Depth file float count (" << depths.size() 
                      << ") does not match image dimensions (" << img.width << "x" << img.height 
                      << " = " << img.width * img.height << "). Depth map ignored." << std::endl;
            depths.clear();
        } else {
            std::cout << "[3DGS] Loaded metric depth map: " << depthPath << std::endl;
        }
    }

    std::vector<uint8_t> mask;
    if (!maskPath.empty()) {
        mask = loadMaskFile(maskPath, static_cast<size_t>(img.width * img.height));
        if (!mask.empty()) {
            std::cout << "[3DGS] Loaded mask-gating PNG: " << maskPath << " (only generating splats in masked region)" << std::endl;
        }
    }

    std::cout << "[3DGS] Loaded 360 Panorama: " << inputPath << " (" << img.width << "x" << img.height << ")" << std::endl;

    // Convert Equirectangular 360 Panorama to continuous 3D Gaussian Splats using native C++ Core
    const float* depthPtr = depths.empty() ? nullptr : depths.data();
    const uint8_t* maskPtr = mask.empty() ? nullptr : mask.data();
    
    std::vector<GaussianSplat> splats = depthbox::DepthToGaussianEngine::convertEquirectangularToGaussianSplats(
        img.pixels.data(),
        img.width,
        img.height,
        3, // channels
        depthPtr,
        maskPtr,
        stride,
        eyeHeight,
        80.0f,
        0.08f,
        sigmaScale
    );

    std::cout << "[3DGS] Generated " << splats.size() << " Continuous 3D Gaussian Splats." << std::endl;

    size_t splatBytes = 0;
    size_t spzBytes = 0;

    if (!outSplatPath.empty()) {
        auto rawSplat = SplatCodec::encode(splats);
        splatBytes = rawSplat.size();
        writeBinary(outSplatPath, rawSplat);
        std::cout << "[3DGS] Wrote standard .splat: " << outSplatPath << " (" << (splatBytes / (1024.0 * 1024.0)) << " MB)" << std::endl;
    }

    if (!outSpzPath.empty()) {
        auto rawSpz = SpzCodec::encode(splats);
        spzBytes = rawSpz.size();
        writeBinary(outSpzPath, rawSpz);
        float compressionRatio = splatBytes > 0 ? (1.0f - (float)spzBytes / splatBytes) * 100.0f : 0.0f;
        std::cout << "[3DGS] Wrote compressed .spz: " << outSpzPath << " (" << (spzBytes / (1024.0 * 1024.0)) << " MB, "
                  << compressionRatio << "% compression)" << std::endl;
    }

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "{\"success\":true,\"numSplats\":" << splats.size()
              << ",\"splatBytes\":" << splatBytes
              << ",\"spzBytes\":" << spzBytes
              << ",\"durationMs\":" << ms
              << "}" << std::endl;

    return 0;
}
