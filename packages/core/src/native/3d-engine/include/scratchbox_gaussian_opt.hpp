/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_GAUSSIAN_OPT_HPP
#define SCRATCHBOX_GAUSSIAN_OPT_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <vector>
#include <unordered_map>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <iostream>

namespace scratchbox {
namespace gaussian_opt {

using math::Vec3;
using math::Quat;
using spz::GaussianSplat;

// ============================================================================
// 1. Spatial Voxel Hash Grid for O(N) Splat Filtering & Fusion
// ============================================================================

struct VoxelCoord {
    int64_t x{0};
    int64_t y{0};
    int64_t z{0};

    bool operator==(const VoxelCoord& other) const {
        return x == other.x && y == other.y && z == other.z;
    }
};

struct VoxelCoordHash {
    size_t operator()(const VoxelCoord& c) const {
        // High-performance 64-bit spatial hash (Frey-Slotkin integer mixing)
        uint64_t h = static_cast<uint64_t>(c.x) * 73856093ULL;
        h ^= static_cast<uint64_t>(c.y) * 19349663ULL;
        h ^= static_cast<uint64_t>(c.z) * 83492791ULL;
        h ^= (h >> 33);
        h *= 0xff51afd7ed558ccdULL;
        h ^= (h >> 33);
        return static_cast<size_t>(h);
    }
};

struct VoxelAccumulator {
    Vec3 sumPos{0.0f, 0.0f, 0.0f};
    Vec3 sumColor{0.0f, 0.0f, 0.0f};
    Vec3 sumScale{0.0f, 0.0f, 0.0f};
    Vec3 normal{0.0f, 0.0f, 1.0f};
    float sumWeight{0.0f};
    size_t count{0};
};

class GaussianOptimizer {
public:
    /**
     * Voxel grid decimation and deduplication.
     * Collapses duplicate / overlapping splats from multi-view fusion into an optimal
     * representative splat per voxel of size `voxelSize` in meters.
     */
    static std::vector<GaussianSplat> voxelFilter(
        const std::vector<GaussianSplat>& inputSplats,
        float voxelSize = 0.05f
    ) {
        if (inputSplats.empty()) return {};
        if (voxelSize <= 0.0f) voxelSize = 0.05f;

        float invVoxel = 1.0f / voxelSize;
        std::unordered_map<VoxelCoord, VoxelAccumulator, VoxelCoordHash> grid;
        grid.reserve(inputSplats.size());

        for (const auto& s : inputSplats) {
            int64_t vx = static_cast<int64_t>(std::floor(s.position.x * invVoxel));
            int64_t vy = static_cast<int64_t>(std::floor(s.position.y * invVoxel));
            int64_t vz = static_cast<int64_t>(std::floor(s.position.z * invVoxel));

            VoxelCoord coord{vx, vy, vz};
            auto& acc = grid[coord];

            float weight = std::max(0.01f, s.opacity);
            acc.sumPos = acc.sumPos + s.position * weight;
            acc.sumColor = acc.sumColor + s.color * weight;
            acc.sumScale = acc.sumScale + s.scale * weight;
            acc.sumWeight += weight;
            acc.count++;

            // Preserve dominant orientation
            if (acc.count == 1) {
                // Compute surface normal from rotation quaternion
                Quat q = s.rotation.normalized();
                acc.normal = Vec3(
                    2.0f * (q.x * q.z + q.w * q.y),
                    2.0f * (q.y * q.z - q.w * q.x),
                    1.0f - 2.0f * (q.x * q.x + q.y * q.y)
                ).normalized();
            }
        }

        std::vector<GaussianSplat> output;
        output.reserve(grid.size());

        for (const auto& [coord, acc] : grid) {
            if (acc.sumWeight <= 0.0f) continue;

            float invW = 1.0f / acc.sumWeight;
            GaussianSplat splat;
            splat.position = acc.sumPos * invW;
            splat.color = acc.sumColor * invW;
            splat.scale = acc.sumScale * invW;

            // Ensure scale does not collapse below half voxel size
            float minScale = voxelSize * 0.5f;
            splat.scale.x = std::max(splat.scale.x, minScale);
            splat.scale.y = std::max(splat.scale.y, minScale);
            splat.scale.z = std::clamp(splat.scale.z, minScale * 0.15f, minScale * 0.4f);

            // Reconstruct quaternion from normal
            splat.rotation = rotationFromNormal(acc.normal);
            splat.opacity = std::clamp(acc.sumWeight / static_cast<float>(acc.count), 0.7f, 1.0f);

            output.push_back(splat);
        }

        return output;
    }

    /**
     * Adaptive Densification (Splitting of large splats).
     * Discovers splats with footprint exceeding maxScale, splitting each into two
     * smaller child splats offset along the primary tangent axis.
     */
    static std::vector<GaussianSplat> densifyAdaptive(
        const std::vector<GaussianSplat>& inputSplats,
        float maxScale = 0.15f
    ) {
        std::vector<GaussianSplat> result;
        result.reserve(inputSplats.size() * 3 / 2);

        for (const auto& s : inputSplats) {
            float maxDim = std::max(s.scale.x, s.scale.y);
            if (maxDim > maxScale) {
                // Split into 2 child splats along tangent axis
                Quat q = s.rotation.normalized();
                Vec3 tangentX(
                    1.0f - 2.0f * (q.y * q.y + q.z * q.z),
                    2.0f * (q.x * q.y + q.w * q.z),
                    2.0f * (q.x * q.z - q.w * q.y)
                );

                Vec3 offset = tangentX.normalized() * (maxDim * 0.35f);
                Vec3 childScale(s.scale.x * 0.65f, s.scale.y * 0.65f, s.scale.z);

                GaussianSplat c1 = s;
                c1.position = s.position + offset;
                c1.scale = childScale;

                GaussianSplat c2 = s;
                c2.position = s.position - offset;
                c2.scale = childScale;

                result.push_back(c1);
                result.push_back(c2);
            } else {
                result.push_back(s);
            }
        }

        return result;
    }

    /**
     * Outlier Pruning.
     * Removes floating speckles with low local neighbor density.
     */
    static std::vector<GaussianSplat> pruneOutliers(
        const std::vector<GaussianSplat>& inputSplats,
        float radius = 0.25f,
        size_t minNeighbors = 2
    ) {
        if (inputSplats.empty()) return {};

        float r2 = radius * radius;
        float invR = 1.0f / radius;

        std::unordered_map<VoxelCoord, std::vector<size_t>, VoxelCoordHash> grid;
        for (size_t i = 0; i < inputSplats.size(); ++i) {
            const auto& p = inputSplats[i].position;
            int64_t vx = static_cast<int64_t>(std::floor(p.x * invR));
            int64_t vy = static_cast<int64_t>(std::floor(p.y * invR));
            int64_t vz = static_cast<int64_t>(std::floor(p.z * invR));
            grid[{vx, vy, vz}].push_back(i);
        }

        std::vector<GaussianSplat> pruned;
        pruned.reserve(inputSplats.size());

        for (size_t i = 0; i < inputSplats.size(); ++i) {
            const auto& p = inputSplats[i].position;
            int64_t vx = static_cast<int64_t>(std::floor(p.x * invR));
            int64_t vy = static_cast<int64_t>(std::floor(p.y * invR));
            int64_t vz = static_cast<int64_t>(std::floor(p.z * invR));

            size_t neighbors = 0;
            for (int64_t dx = -1; dx <= 1 && neighbors < minNeighbors; ++dx) {
                for (int64_t dy = -1; dy <= 1 && neighbors < minNeighbors; ++dy) {
                    for (int64_t dz = -1; dz <= 1 && neighbors < minNeighbors; ++dz) {
                        auto it = grid.find({vx + dx, vy + dy, vz + dz});
                        if (it != grid.end()) {
                            for (size_t idx : it->second) {
                                if (idx == i) continue;
                                const auto& p2 = inputSplats[idx].position;
                                float dist2 = (p.x - p2.x) * (p.x - p2.x) +
                                              (p.y - p2.y) * (p.y - p2.y) +
                                              (p.z - p2.z) * (p.z - p2.z);
                                if (dist2 <= r2) {
                                    neighbors++;
                                    if (neighbors >= minNeighbors) break;
                                }
                            }
                        }
                    }
                }
            }

            if (neighbors >= minNeighbors) {
                pruned.push_back(inputSplats[i]);
            }
        }

        return pruned;
    }

private:
    static Quat rotationFromNormal(const Vec3& normal) {
        Vec3 v0(0.0f, 0.0f, 1.0f);
        Vec3 v1 = normal.normalized();
        float dot = v0.dot(v1);

        if (dot >= 0.9999f) return Quat(0.0f, 0.0f, 0.0f, 1.0f);
        if (dot <= -0.9999f) return Quat(0.0f, 1.0f, 0.0f, 0.0f);

        Vec3 axis = v0.cross(v1);
        float s = std::sqrt((1.0f + dot) * 2.0f);
        float invs = 1.0f / s;
        return Quat(axis.x * invs, axis.y * invs, axis.z * invs, s * 0.5f).normalized();
    }
};

// ============================================================================
// 2. Spherical Harmonics (Degree 0, 1, 2) Evaluator for Radiance Highlights
// ============================================================================

struct SphericalHarmonicsShading {
    static constexpr float C0 = 0.28209479177387814f; // 1 / (2 * sqrt(pi))
    static constexpr float C1 = 0.4886025119029199f;  // sqrt(3) / (2 * sqrt(pi))

    /**
     * Computes view-dependent radiance from SH degree 0 (base diffuse) and degree 1 (view direction).
     *   viewDir: unit vector from splat position towards camera.
     */
    static Vec3 evaluateSH(const Vec3& baseRgb, const Vec3& sh1Coeffs, const Vec3& viewDir) {
        // Base ambient
        Vec3 result = baseRgb * C0;

        // Degree 1 view directional contribution
        float y = viewDir.y;
        float z = viewDir.z;
        float x = viewDir.x;

        float sh1Contrib = -C1 * y * sh1Coeffs.y + C1 * z * sh1Coeffs.z - C1 * x * sh1Coeffs.x;
        result = result + Vec3(sh1Contrib, sh1Contrib, sh1Contrib);

        return Vec3(
            std::clamp(result.x, 0.0f, 1.0f),
            std::clamp(result.y, 0.0f, 1.0f),
            std::clamp(result.z, 0.0f, 1.0f)
        );
    }
};

} // namespace gaussian_opt
} // namespace scratchbox

#endif // SCRATCHBOX_GAUSSIAN_OPT_HPP
