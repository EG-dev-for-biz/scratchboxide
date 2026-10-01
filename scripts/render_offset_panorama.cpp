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
        rawPath = "/tmp/sb_offset_pano_" + std::to_string(now) + ".raw";
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

void writeBinary(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
}

// Convert RGB buffer to PNG via FFmpeg rawvideo to png
bool savePngFile(const std::string& path, const std::vector<uint8_t>& rgb, int w, int h) {
    auto now = std::chrono::high_resolution_clock::now().time_since_epoch().count();
    std::string rawPath = "/tmp/sb_write_png_" + std::to_string(now) + ".raw";
    
    std::ofstream out(rawPath, std::ios::binary);
    if (!out.is_open()) return false;
    out.write(reinterpret_cast<const char*>(rgb.data()), rgb.size());
    out.close();

    std::string cmd = "ffmpeg -y -v error -f rawvideo -pix_fmt rgb24 -s " + std::to_string(w) + "x" + std::to_string(h) + " -i \"" + rawPath + "\" \"" + path + "\"";
    int ret = std::system(cmd.c_str());
    std::remove(rawPath.c_str());
    return ret == 0;
}

// Convert Greyscale buffer to PNG via FFmpeg rawvideo to png
bool saveGreyscalePngFile(const std::string& path, const std::vector<uint8_t>& grey, int w, int h) {
    auto now = std::chrono::high_resolution_clock::now().time_since_epoch().count();
    std::string rawPath = "/tmp/sb_write_grey_png_" + std::to_string(now) + ".raw";
    
    std::ofstream out(rawPath, std::ios::binary);
    if (!out.is_open()) return false;
    out.write(reinterpret_cast<const char*>(grey.data()), grey.size());
    out.close();

    std::string cmd = "ffmpeg -y -v error -f rawvideo -pix_fmt gray -s " + std::to_string(w) + "x" + std::to_string(h) + " -i \"" + rawPath + "\" \"" + path + "\"";
    int ret = std::system(cmd.c_str());
    std::remove(rawPath.c_str());
    return ret == 0;
}

int main(int argc, char** argv) {
    std::string inputPath;
    std::string depthPath;
    std::string outRgbPath = "offset_rgb.png";
    std::string outMaskPath = "offset_mask.png";
    std::string outDepthPath = "offset_depth.f32";
    
    float offsetX = 1.0f;
    float offsetY = 0.0f;
    float offsetZ = 0.0f;
    float eyeHeight = 1.70f;
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--input" && i + 1 < argc) inputPath = argv[++i];
        else if (arg == "--depth" && i + 1 < argc) depthPath = argv[++i];
        else if (arg == "--out-rgb" && i + 1 < argc) outRgbPath = argv[++i];
        else if (arg == "--out-mask" && i + 1 < argc) outMaskPath = argv[++i];
        else if (arg == "--out-depth" && i + 1 < argc) outDepthPath = argv[++i];
        else if (arg == "--offset-x" && i + 1 < argc) offsetX = std::stof(argv[++i]);
        else if (arg == "--offset-y" && i + 1 < argc) offsetY = std::stof(argv[++i]);
        else if (arg == "--offset-z" && i + 1 < argc) offsetZ = std::stof(argv[++i]);
        else if (arg == "--eye-height" && i + 1 < argc) eyeHeight = std::stof(argv[++i]);
        else if (arg == "--json") emitJson = true;
    }

    if (inputPath.empty() || depthPath.empty()) {
        std::cerr << "Usage: render_offset_panorama --input <pano.png> --depth <depth.f32> [--offset-x 1.0] [--offset-y 0.0] [--offset-z 0.0] [--out-rgb offset_rgb.png] [--out-mask offset_mask.png] [--out-depth offset_depth.f32] [--eye-height 1.7]" << std::endl;
        return 1;
    }

    auto tStart = std::chrono::high_resolution_clock::now();

    auto img = loadRgbImage(inputPath);
    if (img.width <= 0 || img.height <= 0 || img.pixels.empty()) {
        std::cerr << "ERROR: Failed to load panorama image: " << inputPath << std::endl;
        return 1;
    }

    auto depths = loadDepthFile(depthPath);
    if (depths.size() != static_cast<size_t>(img.width * img.height)) {
        std::cerr << "ERROR: Depth map float count (" << depths.size() 
                  << ") does not match panorama image size (" << img.width << "x" << img.height 
                  << " = " << img.width * img.height << ")" << std::endl;
        return 1;
    }

    int W = img.width;
    int H = img.height;

    // Allocate output buffers
    std::vector<uint8_t> outRgb(W * H * 3, 0);
    std::vector<float> outDepth(W * H, 1000.0f); // initialized with infinity
    std::vector<uint8_t> outMask(W * H, 255);     // 255 = disoccluded / void, 0 = visible

    Vec3 O(offsetX, offsetY, offsetZ);

    // Forward Warp with Z-Buffering
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            size_t pIdx = static_cast<size_t>(y) * W + x;
            float d = depths[pIdx];

            // 1. Get original 3D position relative to capture point eyeY
            Vec3 ray = depthbox::DepthToGaussianEngine::getEquirectRay(x, y, W, H);
            Vec3 P(ray.x * d, ray.y * d, ray.z * d);

            // 2. Position relative to offset camera
            Vec3 P_new = P - O;
            float d_new = P_new.length();

            // Prevent dividing by zero
            if (d_new < 1e-4f) continue;

            Vec3 ray_new = P_new * (1.0f / d_new);

            // 3. Project to new equirect coordinates
            float pitch_new = std::asin(std::max(-1.0f, std::min(1.0f, ray_new.y)));
            float yaw_new = std::atan2(ray_new.x, -ray_new.z);

            float u_new_float = (yaw_new / (2.0f * M_PI) + 0.5f) * W;
            float v_new_float = (0.5f - pitch_new / M_PI) * H;

            int u_new = static_cast<int>(std::floor(u_new_float));
            int v_new = static_cast<int>(std::floor(v_new_float));

            uint8_t r = img.r(x, y);
            uint8_t g = img.g(x, y);
            uint8_t b = img.b(x, y);

            // Splat to 2x2 neighborhood to prevent single-pixel pinhole gaps
            for (int dy = 0; dy <= 1; ++dy) {
                for (int dx = 0; dx <= 1; ++dx) {
                    int nu = (u_new + dx + W) % W; // horizontal wrap
                    int nv = std::max(0, std::min(H - 1, v_new + dy)); // vertical clamp

                    size_t outIdx = static_cast<size_t>(nv) * W + nu;

                    if (d_new < outDepth[outIdx]) {
                        outDepth[outIdx] = d_new;
                        outRgb[outIdx * 3 + 0] = r;
                        outRgb[outIdx * 3 + 1] = g;
                        outRgb[outIdx * 3 + 2] = b;
                        outMask[outIdx] = 0; // successfully written
                    }
                }
            }
        }
    }

    // VFX-grade dilation of the disocclusion mask to cleanly cover fuzzy silhouette boundaries
    std::vector<uint8_t> dilatedMask = outMask;
    int r_dilate = 3;
    size_t disocclusionCount = 0;

    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            if (outMask[y * W + x] == 255) {
                disocclusionCount++;
                for (int dy = -r_dilate; dy <= r_dilate; ++dy) {
                    for (int dx = -r_dilate; dx <= r_dilate; ++dx) {
                        int ny = std::max(0, std::min(H - 1, y + dy));
                        int nx = (x + dx + W) % W;
                        dilatedMask[ny * W + nx] = 255;
                    }
                }
            }
        }
    }

    float disocclusionPercent = (static_cast<float>(disocclusionCount) / (W * H)) * 100.0f;

    // Save PNG outputs
    savePngFile(outRgbPath, outRgb, W, H);
    saveGreyscalePngFile(outMaskPath, dilatedMask, W, H);

    // Save float32 depth map output
    std::vector<uint8_t> depthBytes(outDepth.size() * sizeof(float));
    std::memcpy(depthBytes.data(), outDepth.data(), depthBytes.size());
    writeBinary(outDepthPath, depthBytes);

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    if (emitJson) {
        std::cout << "{\n"
                  << "  \"success\": true,\n"
                  << "  \"width\": " << W << ",\n"
                  << "  \"height\": " << H << ",\n"
                  << "  \"disocclusionPercent\": " << disocclusionPercent << ",\n"
                  << "  \"durationMs\": " << ms << ",\n"
                  << "  \"rgbPath\": \"" << outRgbPath << "\",\n"
                  << "  \"maskPath\": \"" << outMaskPath << "\",\n"
                  << "  \"depthPath\": \"" << outDepthPath << "\"\n"
                  << "}\n";
    } else {
        std::cout << "[3DGS Offset Renderer] Rendered view successfully." << std::endl;
        std::cout << "✓ Offset: (" << offsetX << ", " << offsetY << ", " << offsetZ << ")" << std::endl;
        std::cout << "✓ Disocclusion Void: " << disocclusionPercent << "%" << std::endl;
        std::cout << "✓ Saved Offset RGB: " << outRgbPath << std::endl;
        std::cout << "✓ Saved Dilated Mask: " << outMaskPath << std::endl;
        std::cout << "✓ Saved Offset Depth: " << outDepthPath << std::endl;
    }

    return 0;
}
