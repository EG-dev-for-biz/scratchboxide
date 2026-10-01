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
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <chrono>

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
    float luminance(int x, int y) const {
        return (0.299f * r(x, y) + 0.587f * g(x, y) + 0.114f * b(x, y)) / 255.0f;
    }
};

RgbImage loadBmp(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return {};

    uint8_t header[54];
    f.read(reinterpret_cast<char*>(header), 54);
    if (header[0] != 'B' || header[1] != 'M') return {};

    int width = *reinterpret_cast<int*>(&header[18]);
    int height = *reinterpret_cast<int*>(&header[22]);
    uint16_t bpp = *reinterpret_cast<uint16_t*>(&header[28]);
    int dataOffset = *reinterpret_cast<int*>(&header[10]);

    bool flipY = true;
    if (height < 0) {
        height = -height;
        flipY = false;
    }

    f.seekg(dataOffset, std::ios::beg);
    RgbImage img;
    img.width = width;
    img.height = height;
    img.pixels.resize(width * height * 3);

    int rowSize = ((width * (bpp / 8) + 3) / 4) * 4;
    std::vector<uint8_t> rowBuffer(rowSize);

    for (int y = 0; y < height; ++y) {
        f.read(reinterpret_cast<char*>(rowBuffer.data()), rowSize);
        int targetY = flipY ? (height - 1 - y) : y;
        for (int x = 0; x < width; ++x) {
            int srcIdx = x * (bpp / 8);
            uint8_t b = rowBuffer[srcIdx];
            uint8_t g = rowBuffer[srcIdx + 1];
            uint8_t r = rowBuffer[srcIdx + 2];
            int dstIdx = (targetY * width + x) * 3;
            img.pixels[dstIdx + 0] = r;
            img.pixels[dstIdx + 1] = g;
            img.pixels[dstIdx + 2] = b;
        }
    }
    return img;
}

// Compute quaternion rotation from source vector (0, 0, 1) to target normal n
Quat rotationFromNormal(const Vec3& normal) {
    Vec3 v0(0.0f, 0.0f, 1.0f);
    Vec3 v1 = normal.normalized();
    float dot = v0.dot(v1);

    if (dot >= 0.9999f) {
        return Quat(0.0f, 0.0f, 0.0f, 1.0f); // Identity
    }
    if (dot <= -0.9999f) {
        return Quat(0.0f, 1.0f, 0.0f, 0.0f); // 180 deg around Y
    }

    Vec3 axis = v0.cross(v1);
    float s = std::sqrt((1.0f + dot) * 2.0f);
    float invs = 1.0f / s;
    return Quat(axis.x * invs, axis.y * invs, axis.z * invs, s * 0.5f).normalized();
}

int main(int argc, char** argv) {
    std::string bmpPath = "build/test_esb_facade.bmp";
    std::string outSplatPath = "public/models/esb_calibrated_3dgs.splat";
    int stride = 2; // 320x320 = 102,400 primary splats (+ inpaint splats)
    float fovDeg = 55.0f;
    float tau = 0.075f;
    bool enableInpaint = true;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--bmp" && i + 1 < argc) bmpPath = argv[++i];
        else if (arg == "--out" && i + 1 < argc) outSplatPath = argv[++i];
        else if (arg == "--stride" && i + 1 < argc) stride = std::stoi(argv[++i]);
        else if (arg == "--fov" && i + 1 < argc) fovDeg = std::stof(argv[++i]);
        else if (arg == "--tau" && i + 1 < argc) tau = std::stof(argv[++i]);
        else if (arg == "--no-inpaint") enableInpaint = false;
    }

    auto tStart = std::chrono::high_resolution_clock::now();

    RgbImage img = loadBmp(bmpPath);
    if (img.width == 0 || img.height == 0) {
        std::cerr << "Failed to load BMP from: " << bmpPath << std::endl;
        return 1;
    }

    const int W = img.width;
    const int H = img.height;
    std::cout << "[ESB-3DGS] Loaded " << W << "x" << H << " image from " << bmpPath << std::endl;

    // Camera Intrinsics
    const float fovRad = fovDeg * (3.14159265358979323846f / 180.0f);
    const float f = (static_cast<float>(H) / 2.0f) / std::tan(fovRad / 2.0f);
    const float cx = static_cast<float>(W) / 2.0f;
    const float cy = static_cast<float>(H) / 2.0f;

    // Gemini-Calibrated Multi-Planar Geometric Model:
    // In OpenGL / Three.js camera coordinates:
    // +X is Right, +Y is UP, -Z is Forward along camera optical axis
    // Ray for pixel (x, y):
    // rx = (x - cx) / f
    // ry = -(y - cy) / f (image y goes down, camera Y goes up)
    // rz = -1.0f
    //
    // Plane Equations: n_x * X + n_y * Y + n_z * Z = d
    // For ray point P = t * (rx, ry, -1.0f):
    // (n_x * rx + n_y * ry - n_z) * t = d
    // denom = n_x * rx + n_y * ry - n_z

    // 1. Ground Pavement: Flat horizontal street rising into distance
    // In camera space (pitched ~22 deg down relative to building, i.e. looking up):
    // Ground plane normal has strong +Y (up) component and -Z component (tilted away)
    Vec3 nGround(0.0f, 0.927f, -0.375f);
    float dGround = -2.21f; // Plane is below camera origin

    // 2. Facade Right (5th Avenue): Extends along the avenue receding to the right
    // Normal faces somewhat left (+X) and towards camera (+Z)
    Vec3 nRight(-0.60f, -0.34f, 0.825f);
    float dRight = 3.05f;

    // 3. Facade Left (34th Street): Extends to the left receding
    Vec3 nLeft(0.60f, -0.34f, 0.895f);
    float dLeft = 3.05f;

    const float cornerUNorm = 0.445f;
    const float cornerX = cornerUNorm * static_cast<float>(W);

    std::vector<float> metricDepth(W * H, 0.0f);
    std::vector<Vec3> surfaceNormals(W * H, Vec3(0, 0, 1));
    std::vector<uint8_t> isSkyMap(W * H, 0);

    for (int y = 0; y < H; ++y) {
        float ny = static_cast<float>(y) / H;
        float ry = -(static_cast<float>(y) - cy) / f; // Up is +Y

        for (int x = 0; x < W; ++x) {
            float nx = static_cast<float>(x) / W;
            float rx = (static_cast<float>(x) - cx) / f;  // Right is +X
            int idx = y * W + x;

            float r = img.r(x, y) / 255.0f;
            float g = img.g(x, y) / 255.0f;
            float b = img.b(x, y) / 255.0f;
            float lum = img.luminance(x, y);

            // Sky detection (upper left quadrant, overcast clouds & blue sky dome)
            bool isSky = (ny < 0.48f && nx < 0.42f) && (
                lum > 0.60f ||
                (b > r + 0.02f) ||
                (b > 0.65f && g > 0.65f)
            );

            if (isSky) {
                isSkyMap[idx] = 1;
                metricDepth[idx] = 12.0f;
                surfaceNormals[idx] = Vec3(0.0f, 0.0f, 1.0f);
                continue;
            }

            // Ground analytical ray-plane depth
            float denomG = nGround.x * rx + nGround.y * ry - nGround.z;
            float zGround = (denomG > 0.02f) ? (dGround / denomG) : 999.0f;

            // Facade analytical ray-plane depth
            float zFacade = 999.0f;
            Vec3 nPlane = nRight;
            if (static_cast<float>(x) >= cornerX) {
                float denomR = nRight.x * rx + nRight.y * ry - nRight.z;
                if (denomR > 0.02f) zFacade = dRight / denomR;
                nPlane = nRight;
            } else {
                float denomL = nLeft.x * rx + nLeft.y * ry - nLeft.z;
                if (denomL > 0.02f) zFacade = dLeft / denomL;
                nPlane = nLeft;
            }

            // Continuous Ground / Facade intersection
            float chosenZ;
            Vec3 chosenNormal;
            if (ry < -0.10f && zGround < zFacade && zGround > 0.5f && zGround < 10.0f) {
                chosenZ = std::clamp(zGround, 1.8f, 8.0f);
                chosenNormal = nGround;
            } else {
                float microRelief = (0.5f - lum) * 0.012f;
                chosenZ = std::clamp(zFacade + microRelief, 1.8f, 9.0f);
                chosenNormal = nPlane;
            }

            metricDepth[idx] = chosenZ;
            surfaceNormals[idx] = chosenNormal;
        }
    }

    // Synthesize Primary Gaussian Splats
    std::vector<GaussianSplat> splats;
    splats.reserve((W / stride) * (H / stride) * 2);

    for (int y = 0; y < H; y += stride) {
        float ry = -(static_cast<float>(y) - cy) / f;
        for (int x = 0; x < W; x += stride) {
            float rx = (static_cast<float>(x) - cx) / f;
            int idx = y * W + x;

            if (isSkyMap[idx]) continue; // Let 3D atmospheric sky dome shine through

            float z = metricDepth[idx];
            if (z <= 0.1f || std::isnan(z)) continue;

            // OpenGL Camera Coordinates: X = rx * z, Y = ry * z, Z = -z
            Vec3 pos(rx * z, ry * z, -z);

            Vec3 norm = surfaceNormals[idx].normalized();
            Quat quat = rotationFromNormal(norm);

            // Anisotropic footprint sized to seamlessly tile adjacent surfels
            float pixelFootprint = static_cast<float>(stride) * z / f;
            float scaleX = pixelFootprint * 1.45f;
            float scaleY = pixelFootprint * 1.45f;
            float scaleZ = pixelFootprint * 0.20f; // Thin disk along normal

            GaussianSplat s;
            s.position = pos;
            s.scale = Vec3(scaleX, scaleY, scaleZ);
            s.rotation = quat;
            s.color = Vec3(img.r(x, y) / 255.0f, img.g(x, y) / 255.0f, img.b(x, y) / 255.0f);
            s.opacity = 0.99f;

            splats.push_back(s);
        }
    }

    std::cout << "[ESB-3DGS] Synthesized " << splats.size() << " primary 3D Gaussians" << std::endl;

    // Multi-Layer Occlusion Inpainting for Silhouettes
    if (enableInpaint) {
        std::vector<GaussianSplat> inpaintSplats;
        inpaintSplats.reserve(splats.size() / 3);

        for (int y = 0; y < H; y += stride) {
            for (int x = 0; x < W; x += stride) {
                int idx = y * W + x;
                float d = metricDepth[idx];
                if (isSkyMap[idx]) continue;

                int xNext = std::min(W - 1, x + stride);
                int xPrev = std::max(0, x - stride);
                int yNext = std::min(H - 1, y + stride);
                int yPrev = std::max(0, y - stride);

                float dRight = metricDepth[y * W + xNext];
                float dLeft  = metricDepth[y * W + xPrev];
                float dDown  = metricDepth[yNext * W + x];
                float dUp    = metricDepth[yPrev * W + x];

                float bgDepth = 0.0f;
                int bgCount = 0;
                float fgBgRatio = 1.0f + tau * 1.5f;

                Vec3 bgAccumColor(0.0f, 0.0f, 0.0f);

                auto checkNeighbor = [&](int nx, int ny, float nd) {
                    if (isSkyMap[ny * W + nx]) return; // Do not inpaint sky colors into geometry voids
                    if (nd > d * fgBgRatio && nd < 15.0f) {
                        bgDepth += nd;
                        bgAccumColor.x += img.r(nx, ny) / 255.0f;
                        bgAccumColor.y += img.g(nx, ny) / 255.0f;
                        bgAccumColor.z += img.b(nx, ny) / 255.0f;
                        bgCount++;
                    }
                };

                checkNeighbor(xNext, y, dRight);
                checkNeighbor(xPrev, y, dLeft);
                checkNeighbor(x, yNext, dDown);
                checkNeighbor(x, yPrev, dUp);

                if (bgCount > 0) {
                    float avgBgDepth = (bgDepth / static_cast<float>(bgCount)) * 1.04f;
                    Vec3 avgBgColor = bgAccumColor * (1.0f / static_cast<float>(bgCount));

                    float rx = (static_cast<float>(x) - cx) / f;
                    float ry = -(static_cast<float>(y) - cy) / f;

                    Vec3 pos(rx * avgBgDepth, ry * avgBgDepth, -avgBgDepth);
                    Vec3 norm(0.0f, 0.0f, 1.0f); // Facing camera
                    Quat quat = rotationFromNormal(norm);

                    float footprint = static_cast<float>(stride) * avgBgDepth / f * 1.85f;
                    GaussianSplat inpaintSplat;
                    inpaintSplat.position = pos;
                    inpaintSplat.scale = Vec3(footprint, footprint, footprint * 0.25f);
                    inpaintSplat.rotation = quat;
                    inpaintSplat.color = avgBgColor;
                    inpaintSplat.opacity = 0.88f; // Soft background infill

                    inpaintSplats.push_back(inpaintSplat);
                }
            }
        }

        std::cout << "[ESB-3DGS] Synthesized " << inpaintSplats.size() << " occluded background inpaint splats" << std::endl;
        splats.insert(splats.end(), inpaintSplats.begin(), inpaintSplats.end());
    }

    // Serialize to standard 32-byte .splat
    std::cout << "[ESB-3DGS] Writing " << splats.size() << " total splats to " << outSplatPath << "..." << std::endl;
    std::ofstream out(outSplatPath, std::ios::binary);
    if (!out.is_open()) {
        std::cerr << "Failed to open output path: " << outSplatPath << std::endl;
        return 1;
    }

    const size_t BYTES_PER_SPLAT = 32;
    std::vector<uint8_t> buffer(splats.size() * BYTES_PER_SPLAT);

    for (size_t i = 0; i < splats.size(); ++i) {
        const auto& s = splats[i];
        size_t off = i * BYTES_PER_SPLAT;

        // Position (float32 x 3)
        std::memcpy(&buffer[off + 0], &s.position.x, 4);
        std::memcpy(&buffer[off + 4], &s.position.y, 4);
        std::memcpy(&buffer[off + 8], &s.position.z, 4);

        // Scale (float32 x 3)
        std::memcpy(&buffer[off + 12], &s.scale.x, 4);
        std::memcpy(&buffer[off + 16], &s.scale.y, 4);
        std::memcpy(&buffer[off + 20], &s.scale.z, 4);

        // Color RGBA (uint8 x 4)
        uint8_t r = static_cast<uint8_t>(std::clamp(std::round(s.color.x * 255.0f), 0.0f, 255.0f));
        uint8_t g = static_cast<uint8_t>(std::clamp(std::round(s.color.y * 255.0f), 0.0f, 255.0f));
        uint8_t b = static_cast<uint8_t>(std::clamp(std::round(s.color.z * 255.0f), 0.0f, 255.0f));
        uint8_t a = static_cast<uint8_t>(std::clamp(std::round(s.opacity * 255.0f), 0.0f, 255.0f));

        buffer[off + 24] = r;
        buffer[off + 25] = g;
        buffer[off + 26] = b;
        buffer[off + 27] = a;

        // Rotation Quaternion (uint8 x 4 mapped [-1, 1] -> [0, 255])
        uint8_t qx = static_cast<uint8_t>(std::clamp(std::round((s.rotation.x * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
        uint8_t qy = static_cast<uint8_t>(std::clamp(std::round((s.rotation.y * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
        uint8_t qz = static_cast<uint8_t>(std::clamp(std::round((s.rotation.z * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
        uint8_t qw = static_cast<uint8_t>(std::clamp(std::round((s.rotation.w * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));

        buffer[off + 28] = qx;
        buffer[off + 29] = qy;
        buffer[off + 30] = qz;
        buffer[off + 31] = qw;
    }

    out.write(reinterpret_cast<const char*>(buffer.data()), buffer.size());
    out.close();

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "SUCCESS: Generated " << splats.size() << " 3D Gaussian Splats ("
              << buffer.size() << " bytes) in " << ms << " ms." << std::endl;

    return 0;
}
