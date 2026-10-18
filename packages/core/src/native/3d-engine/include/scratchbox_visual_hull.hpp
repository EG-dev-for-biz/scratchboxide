/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_VISUAL_HULL_HPP
#define SCRATCHBOX_VISUAL_HULL_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <array>
#include <vector>
#include <string>
#include <fstream>
#include <sstream>
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <iostream>

namespace scratchbox {
namespace visual_hull {

using math::Vec3;
using math::Quat;
using math::Mat4;
using spz::GaussianSplat;

// Canonical Performer 4DGS & Nerfstudio defaults
constexpr float DEFAULT_VISUAL_HULL_HALF_EXTENT = 1.25f; // 2.5m bounding cube
constexpr float DEFAULT_VISUAL_HULL_VOXEL_SIZE = 0.02f;   // 2cm voxel resolution
constexpr uint8_t NERFSTUDIO_MASK_THRESHOLD = 128;

/**
 * Pinhole camera observation for visual-hull space carving.
 */
struct VisualHullCamera {
    uint32_t width{0};
    uint32_t height{0};
    float fx{0.0f};
    float fy{0.0f};
    float cx{0.0f};
    float cy{0.0f};

    // World-to-Camera 4x4 matrix (OpenCV convention: +X right, +Y down, +Z forward)
    // Transforms world point [X, Y, Z, 1]^T into camera-space coordinates.
    std::array<float, 16> w2c{
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    };

    // Grayscale or alpha foreground mask (width * height bytes, >= 128 is foreground)
    std::vector<uint8_t> mask;

    // RGB buffer (width * height * 3 bytes)
    std::vector<uint8_t> rgb;
};

/**
 * Options controlling volumetric voxel carving.
 */
struct VisualHullOptions {
    Vec3 center{0.0f, 0.9f, 0.0f};           // Metric center of bounding cube
    float halfExtent{DEFAULT_VISUAL_HULL_HALF_EXTENT}; // Half size of bounding cube (meters)
    float voxelSize{DEFAULT_VISUAL_HULL_VOXEL_SIZE};   // Step size for voxel evaluation (meters)
    uint8_t maskThreshold{NERFSTUDIO_MASK_THRESHOLD};  // Strict boolean boundary
    uint32_t minForegroundViews{2};          // Minimum cameras that must observe voxel as foreground
    size_t maxPoints{350000};                 // Upper bound on emitted point count
    bool computeNormals{true};                // Compute local gradient or radial normal
};

/**
 * High-performance C++20 Visual-Hull Voxel Carver.
 */
class VisualHullCarver {
public:
    /**
     * Carves a 3D bounding volume against multi-camera silhouette masks and
     * averages foreground RGB observations across valid lines of sight.
     *
     * The whole volume is always carved: when the hull at voxelSize holds more than maxPoints voxels, it is carved
     * again on a coarser grid (never cut off part way through the scan, which used to drop the top of the subject).
     */
    static std::vector<GaussianSplat> carve(
        const std::vector<VisualHullCamera>& cameras,
        const VisualHullOptions& options = VisualHullOptions()
    ) {
        if (cameras.empty() || options.maxPoints == 0) return {};
        float step = std::max(0.005f, options.voxelSize);
        std::vector<GaussianSplat> results = carveAtStep(cameras, options, step);
        while (results.size() > options.maxPoints) {
            step *= static_cast<float>(std::cbrt(static_cast<double>(results.size()) / static_cast<double>(options.maxPoints)) * 1.02);
            results = carveAtStep(cameras, options, step);
        }
        return results;
    }

    /**
     * Every voxel of the grid at `step` inside the hull, in z, y, x scan order. Blocks of 8x8x8 voxels whose
     * projection holds no foreground pixel in enough cameras are skipped without testing their voxels (a voxel's
     * projection lies within the projection of its block's corners), so the result equals testing every voxel.
     */
    static std::vector<GaussianSplat> carveAtStep(
        const std::vector<VisualHullCamera>& cameras,
        const VisualHullOptions& options,
        float step,
        bool blockCulling = true
    ) {
        std::vector<GaussianSplat> results;
        if (cameras.empty()) return results;

        const float minX = options.center.x - options.halfExtent;
        const float maxX = options.center.x + options.halfExtent;
        const float minY = options.center.y - options.halfExtent;
        const float maxY = options.center.y + options.halfExtent;
        const float minZ = options.center.z - options.halfExtent;
        const float maxZ = options.center.z + options.halfExtent;

        // Precompute camera count
        const size_t numCams = cameras.size();
        const uint32_t requiredViews = std::min(static_cast<uint32_t>(numCams), std::max(1u, options.minForegroundViews));

        // The sample coordinates, accumulated exactly as a z/y/x stepping loop does.
        auto axis = [&](float lo, float hi) { std::vector<float> v; for (float t = lo; t <= hi; t += step) v.push_back(t); return v; };
        const std::vector<float> xs = axis(minX, maxX), ys = axis(minY, maxY), zs = axis(minZ, maxZ);
        if (xs.empty() || ys.empty() || zs.empty()) return results;

        constexpr size_t B = 8;
        const size_t bx = (xs.size() + B - 1) / B, by = (ys.size() + B - 1) / B, bz = (zs.size() + B - 1) / B;
        std::vector<uint8_t> blockLive(bx * by * bz, 1);
        if (blockCulling) {
            // Summed-area table of foreground pixels per camera (cameras whose mask is short are never ruled out).
            std::vector<std::vector<uint32_t>> sat(numCams);
            for (size_t c = 0; c < numCams; ++c) {
                const auto& cam = cameras[c];
                if (cam.width == 0 || cam.height == 0 || cam.mask.empty()) continue;
                if (cam.mask.size() < static_cast<size_t>(cam.width) * cam.height) continue;
                auto& S = sat[c];
                S.assign(static_cast<size_t>(cam.width + 1) * (cam.height + 1), 0);
                for (uint32_t y = 0; y < cam.height; ++y) {
                    uint32_t row = 0;
                    for (uint32_t x = 0; x < cam.width; ++x) {
                        row += cam.mask[static_cast<size_t>(y) * cam.width + x] >= options.maskThreshold ? 1u : 0u;
                        S[static_cast<size_t>(y + 1) * (cam.width + 1) + x + 1] = S[static_cast<size_t>(y) * (cam.width + 1) + x + 1] + row;
                    }
                }
            }
            for (size_t kz = 0; kz < bz; ++kz)
                for (size_t ky = 0; ky < by; ++ky)
                    for (size_t kx = 0; kx < bx; ++kx) {
                        const float x0 = xs[kx * B], x1 = xs[std::min(xs.size(), kx * B + B) - 1];
                        const float y0 = ys[ky * B], y1 = ys[std::min(ys.size(), ky * B + B) - 1];
                        const float z0 = zs[kz * B], z1 = zs[std::min(zs.size(), kz * B + B) - 1];
                        uint32_t possible = 0;
                        for (size_t c = 0; c < numCams && possible < requiredViews; ++c) {
                            const auto& cam = cameras[c];
                            if (cam.width == 0 || cam.height == 0 || cam.mask.empty()) continue;
                            if (sat[c].empty()) { ++possible; continue; }
                            float uLo = 1e30f, uHi = -1e30f, vLo = 1e30f, vHi = -1e30f;
                            bool behind = false;
                            for (int corner = 0; corner < 8 && !behind; ++corner) {
                                const float x = (corner & 1) ? x1 : x0, y = (corner & 2) ? y1 : y0, z = (corner & 4) ? z1 : z0;
                                const float xc = cam.w2c[0]*x + cam.w2c[1]*y + cam.w2c[2]*z + cam.w2c[3];
                                const float yc = cam.w2c[4]*x + cam.w2c[5]*y + cam.w2c[6]*z + cam.w2c[7];
                                const float zc = cam.w2c[8]*x + cam.w2c[9]*y + cam.w2c[10]*z + cam.w2c[11];
                                if (zc <= 0.05f) { behind = true; break; }
                                const float u = cam.fx * (xc / zc) + cam.cx, v = cam.fy * (yc / zc) + cam.cy;
                                uLo = std::min(uLo, u); uHi = std::max(uHi, u); vLo = std::min(vLo, v); vHi = std::max(vHi, v);
                            }
                            if (behind) { ++possible; continue; } // part of the block is behind the camera: not ruled out
                            // one pixel of margin either side covers rounding differences between corners and voxels
                            const long iu0 = std::max(0L, std::lround(std::floor(uLo)) - 1), iu1 = std::min(static_cast<long>(cam.width) - 1, std::lround(std::ceil(uHi)) + 1);
                            const long iv0 = std::max(0L, std::lround(std::floor(vLo)) - 1), iv1 = std::min(static_cast<long>(cam.height) - 1, std::lround(std::ceil(vHi)) + 1);
                            if (iu0 > iu1 || iv0 > iv1) continue;
                            const auto& S = sat[c];
                            const size_t W1 = cam.width + 1;
                            const uint32_t fg = S[(iv1 + 1) * W1 + iu1 + 1] - S[iv0 * W1 + iu1 + 1] - S[(iv1 + 1) * W1 + iu0] + S[iv0 * W1 + iu0];
                            if (fg > 0) ++possible;
                        }
                        if (possible < requiredViews) blockLive[(kz * by + ky) * bx + kx] = 0;
                    }
        }

        for (size_t iz = 0; iz < zs.size(); ++iz) {
            const float z = zs[iz];
            for (size_t iy = 0; iy < ys.size(); ++iy) {
                const float y = ys[iy];
                for (size_t ix = 0; ix < xs.size(); ++ix) {
                    if (!blockLive[((iz / B) * by + iy / B) * bx + ix / B]) continue;
                    const float x = xs[ix];

                    uint32_t fgCount = 0;
                    uint32_t testedViews = 0;
                    float sumR = 0.0f;
                    float sumG = 0.0f;
                    float sumB = 0.0f;

                    for (size_t c = 0; c < numCams; ++c) {
                        const auto& cam = cameras[c];
                        if (cam.width == 0 || cam.height == 0 || cam.mask.empty()) continue;

                        // World to camera transform
                        const float xc = cam.w2c[0]*x + cam.w2c[1]*y + cam.w2c[2]*z + cam.w2c[3];
                        const float yc = cam.w2c[4]*x + cam.w2c[5]*y + cam.w2c[6]*z + cam.w2c[7];
                        const float zc = cam.w2c[8]*x + cam.w2c[9]*y + cam.w2c[10]*z + cam.w2c[11];

                        // Must be in front of camera
                        if (zc <= 0.05f) continue;
                        testedViews++;

                        // Perspective projection
                        const float u = cam.fx * (xc / zc) + cam.cx;
                        const float v = cam.fy * (yc / zc) + cam.cy;

                        const int iu = static_cast<int>(std::round(u));
                        const int iv = static_cast<int>(std::round(v));

                        if (iu < 0 || iu >= static_cast<int>(cam.width) ||
                            iv < 0 || iv >= static_cast<int>(cam.height)) {
                            // Point falls outside this camera's frustum
                            continue;
                        }

                        const size_t pixelIdx = static_cast<size_t>(iv) * cam.width + static_cast<size_t>(iu);
                        if (pixelIdx >= cam.mask.size()) continue;

                        if (cam.mask[pixelIdx] >= options.maskThreshold) {
                            fgCount++;
                            if (!cam.rgb.empty() && (pixelIdx * 3 + 2) < cam.rgb.size()) {
                                sumR += static_cast<float>(cam.rgb[pixelIdx * 3 + 0]);
                                sumG += static_cast<float>(cam.rgb[pixelIdx * 3 + 1]);
                                sumB += static_cast<float>(cam.rgb[pixelIdx * 3 + 2]);
                            }
                        }
                    }

                    // Check if candidate voxel satisfies visual-hull intersection
                    if (fgCount >= requiredViews && testedViews >= requiredViews) {
                        GaussianSplat s;
                        s.position = Vec3(x, y, z);
                        s.scale = Vec3(step * 0.75f, step * 0.75f, step * 0.75f);
                        s.rotation = Quat(0.0f, 0.0f, 0.0f, 1.0f);
                        s.opacity = 1.0f;

                        if (fgCount > 0 && (sumR > 0.0f || sumG > 0.0f || sumB > 0.0f)) {
                            s.color = Vec3(
                                std::clamp((sumR / fgCount) / 255.0f, 0.0f, 1.0f),
                                std::clamp((sumG / fgCount) / 255.0f, 0.0f, 1.0f),
                                std::clamp((sumB / fgCount) / 255.0f, 0.0f, 1.0f)
                            );
                        } else {
                            s.color = Vec3(0.72f, 0.72f, 0.72f); // Studio neutral grey
                        }

                        results.push_back(s);
                    }
                }
            }
        }

        return results;
    }

    /**
     * Serializes a vector of Gaussian Splats into Nerfstudio standard `sparse_pcd.ply` format.
     */
    static bool writeSparsePcdPly(
        const std::string& filePath,
        const std::vector<GaussianSplat>& splats,
        bool binaryFormat = false
    ) {
        std::ofstream out(filePath, binaryFormat ? (std::ios::binary | std::ios::out) : std::ios::out);
        if (!out.is_open()) return false;

        const size_t count = splats.size();

        // PLY Header matching Nerfstudio / Splatfacto expectations
        out << "ply\n";
        if (binaryFormat) {
            out << "format binary_little_endian 1.0\n";
        } else {
            out << "format ascii 1.0\n";
        }
        out << "element vertex " << count << "\n";
        out << "property float x\n";
        out << "property float y\n";
        out << "property float z\n";
        out << "property float nx\n";
        out << "property float ny\n";
        out << "property float nz\n";
        out << "property uchar red\n";
        out << "property uchar green\n";
        out << "property uchar blue\n";
        out << "end_header\n";

        if (binaryFormat) {
            for (const auto& s : splats) {
                float pos[3] = { s.position.x, s.position.y, s.position.z };
                float norm[3] = { 0.0f, 1.0f, 0.0f }; // Upward normal default
                uint8_t rgb[3] = {
                    static_cast<uint8_t>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f)),
                    static_cast<uint8_t>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f)),
                    static_cast<uint8_t>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f))
                };
                out.write(reinterpret_cast<const char*>(pos), sizeof(pos));
                out.write(reinterpret_cast<const char*>(norm), sizeof(norm));
                out.write(reinterpret_cast<const char*>(rgb), sizeof(rgb));
            }
        } else {
            for (const auto& s : splats) {
                const int r = static_cast<int>(std::clamp(s.color.x * 255.0f, 0.0f, 255.0f));
                const int g = static_cast<int>(std::clamp(s.color.y * 255.0f, 0.0f, 255.0f));
                const int b = static_cast<int>(std::clamp(s.color.z * 255.0f, 0.0f, 255.0f));
                out << s.position.x << " " << s.position.y << " " << s.position.z << " "
                    << "0.0 1.0 0.0 "
                    << r << " " << g << " " << b << "\n";
            }
        }

        out.close();
        return true;
    }
};

} // namespace visual_hull
} // namespace scratchbox

#endif // SCRATCHBOX_VISUAL_HULL_HPP
