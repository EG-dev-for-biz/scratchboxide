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
     */
    static std::vector<GaussianSplat> carve(
        const std::vector<VisualHullCamera>& cameras,
        const VisualHullOptions& options = VisualHullOptions()
    ) {
        std::vector<GaussianSplat> results;
        if (cameras.empty()) return results;

        const float minX = options.center.x - options.halfExtent;
        const float maxX = options.center.x + options.halfExtent;
        const float minY = options.center.y - options.halfExtent;
        const float maxY = options.center.y + options.halfExtent;
        const float minZ = options.center.z - options.halfExtent;
        const float maxZ = options.center.z + options.halfExtent;

        const float step = std::max(0.005f, options.voxelSize);

        // Precompute camera count
        const size_t numCams = cameras.size();
        const uint32_t requiredViews = std::min(static_cast<uint32_t>(numCams), std::max(1u, options.minForegroundViews));

        for (float z = minZ; z <= maxZ; z += step) {
            for (float y = minY; y <= maxY; y += step) {
                for (float x = minX; x <= maxX; x += step) {
                    if (results.size() >= options.maxPoints) {
                        return results;
                    }

                    uint32_t fgCount = 0;
                    uint32_t testedViews = 0;
                    float sumR = 0.0f;
                    float sumG = 0.0f;
                    float sumB = 0.0f;

                    for (size_t c = 0; c < numCams; ++c) {
                        const auto& cam = cameras[c];
                        if (cam.width == 0 || cam.height == 0 || cam.mask.empty()) continue;

                        // World to camera transform
                        // X_cam = w2c[0]*x + w2c[1]*y + w2c[2]*z + w2c[3]
                        // Y_cam = w2c[4]*x + w2c[5]*y + w2c[6]*z + w2c[7]
                        // Z_cam = w2c[8]*x + w2c[9]*y + w2c[10]*z + w2c[11]
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
