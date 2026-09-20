/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_DEPTH_TO_GAUSSIAN_HPP
#define SCRATCHBOX_DEPTH_TO_GAUSSIAN_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <vector>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <algorithm>
#include <unordered_map>
#include <iostream>

namespace scratchbox {
namespace depthbox {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat3;
using math::Mat4;
using spz::GaussianSplat;

// ============================================================================
// 1. Camera Intrinsics & Extrinsics
// ============================================================================

struct PinholeCamera {
    uint32_t width{640};
    uint32_t height{480};
    float fx{500.0f};
    float fy{500.0f};
    float cx{320.0f};
    float cy{240.0f};

    static PinholeCamera fromFov(uint32_t w, uint32_t h, float fovDegrees) {
        PinholeCamera cam;
        cam.width = w;
        cam.height = h;
        cam.cx = static_cast<float>(w) * 0.5f;
        cam.cy = static_cast<float>(h) * 0.5f;
        float fovRad = fovDegrees * (3.14159265358979323846f / 180.0f);
        float f = 0.5f * static_cast<float>(h) / std::tan(0.5f * fovRad);
        cam.fx = f;
        cam.fy = f;
        return cam;
    }

    inline Vec3 unprojectPixelToRay(float u, float v) const {
        float rx = (u - cx) / fx;
        float ry = (v - cy) / fy;
        float rz = 1.0f;
        float invLen = 1.0f / std::sqrt(rx * rx + ry * ry + rz * rz);
        return Vec3(rx * invLen, ry * invLen, rz * invLen);
    }
};

struct CameraPose {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Quat rotation{0.0f, 0.0f, 0.0f, 1.0f}; // Camera to World quaternion

    Vec3 transformPoint(const Vec3& p) const {
        // q * p * q^-1 + position
        Vec3 qv(rotation.x, rotation.y, rotation.z);
        Vec3 uv = qv.cross(p);
        Vec3 uuv = qv.cross(uv);
        return position + p + ((uv * rotation.w) + uuv) * 2.0f;
    }

    Quat transformQuat(const Quat& q) const {
        // World rotation = CameraRotation * LocalRotation
        return rotation * q;
    }
};

// ============================================================================
// 2. Conversion Configuration Options
// ============================================================================

struct DepthToGaussianOptions {
    float edgeSeveranceTau{0.08f}; // Maximum relative depth delta before severing splats
    float minDepth{0.1f};
    float maxDepth{250.0f};
    uint32_t stride{1};            // Pixel sub-sampling step (1 = full res, 2 = 1/4 count)
    float splatScaleMultiplier{2.10f}; // Radius multiplier to ensure gapless coverage
    float splatThicknessRatio{0.22f};  // Thickness along normal vs tangent radius
    bool computeSH1Radiance{true};     // Compute degree-1 spherical harmonics coefficients
};

// ============================================================================
// 3. Core 2D Depth-to-Gaussian Engine
// ============================================================================

class DepthToGaussianEngine {
public:
    /**
     * Converts a single 2D image (RGB + Metric Depth) into 3D Gaussian Splats.
     */
    static std::vector<GaussianSplat> convertSingleImage(
        const PinholeCamera& cam,
        const uint8_t* rgbBytes,       // width * height * 3 (or 4) bytes
        size_t channels,               // 3 (RGB) or 4 (RGBA)
        const float* metricDepths,     // width * height floats
        const DepthToGaussianOptions& options = DepthToGaussianOptions(),
        const CameraPose& pose = CameraPose()
    ) {
        std::vector<GaussianSplat> splats;
        uint32_t W = cam.width;
        uint32_t H = cam.height;
        uint32_t step = std::max(1u, options.stride);

        splats.reserve((W / step) * (H / step));

        for (uint32_t y = 0; y < H; y += step) {
            for (uint32_t x = 0; x < W; x += step) {
                size_t idx = y * W + x;
                float d = metricDepths[idx];

                if (std::isnan(d) || d < options.minDepth || d > options.maxDepth) {
                    continue;
                }

                Vec3 ray = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(y));
                Vec3 pLocal = ray * d;

                // Color extraction
                size_t cIdx = idx * channels;
                float r = static_cast<float>(rgbBytes[cIdx + 0]) / 255.0f;
                float g = static_cast<float>(rgbBytes[cIdx + 1]) / 255.0f;
                float b = static_cast<float>(rgbBytes[cIdx + 2]) / 255.0f;
                float alpha = channels >= 4 ? (static_cast<float>(rgbBytes[cIdx + 3]) / 255.0f) : 1.0f;

                if (alpha < 0.05f) continue;

                // 4-connected spatial neighbor sampling for surface normal estimation
                uint32_t xNext = std::min(W - 1, x + step);
                uint32_t xPrev = (x >= step) ? (x - step) : 0;
                uint32_t yNext = std::min(H - 1, y + step);
                uint32_t yPrev = (y >= step) ? (y - step) : 0;

                float dRight = metricDepths[y * W + xNext];
                float dLeft  = metricDepths[y * W + xPrev];
                float dDown  = metricDepths[yNext * W + x];
                float dUp    = metricDepths[yPrev * W + x];

                // Relative depth step edge check
                float maxDx = std::max(1e-4f, std::max(dRight, dLeft));
                float maxDy = std::max(1e-4f, std::max(dDown, dUp));
                float deltaX = std::abs(dRight - dLeft) / maxDx;
                float deltaY = std::abs(dDown - dUp) / maxDy;

                bool isEdge = (deltaX > options.edgeSeveranceTau) || (deltaY > options.edgeSeveranceTau);

                // 3D neighbor positions
                Vec3 pRight = cam.unprojectPixelToRay(static_cast<float>(xNext), static_cast<float>(y)) * dRight;
                Vec3 pLeft  = cam.unprojectPixelToRay(static_cast<float>(xPrev), static_cast<float>(y)) * dLeft;
                Vec3 pDown  = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(yNext)) * dDown;
                Vec3 pUp    = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(yPrev)) * dUp;

                Vec3 tx = pRight - pLeft;
                Vec3 ty = pDown - pUp;

                Vec3 normal = tx.cross(ty);
                float normalLen = normal.length();

                if (normalLen > 1e-6f) {
                    normal = normal * (1.0f / normalLen);
                } else {
                    normal = -ray;
                }

                // Ensure surface normal faces camera (dot(n, ray) < 0)
                if (normal.dot(ray) > 0.0f) {
                    normal = -normal;
                }

                // Orientation quaternion from (0, 0, 1) to normal
                Quat qLocal = quatFromUnitVectors(Vec3(0.0f, 0.0f, 1.0f), normal);

                // Anisotropic scale calculation
                float pixelFootprint = (static_cast<float>(step) * d / cam.fx) * options.splatScaleMultiplier;

                float sx = pixelFootprint;
                float sy = pixelFootprint;
                float sz = pixelFootprint * options.splatThicknessRatio;

                // Sever edges to eliminate stretching artifacts
                if (isEdge) {
                    sx *= 0.45f;
                    sy *= 0.45f;
                    alpha *= 0.85f;
                }

                // Transform to world coordinates via camera pose
                Vec3 pWorld = pose.transformPoint(pLocal);
                Quat qWorld = pose.transformQuat(qLocal);

                GaussianSplat splat;
                splat.position = pWorld;
                splat.scale = Vec3(sx, sy, sz);
                splat.rotation = qWorld;
                splat.color = Vec3(r, g, b);
                splat.opacity = alpha;

                splats.push_back(splat);
            }
        }

        return splats;
    }

    /**
     * Multi-View Splat Fusion with 3D Voxel Hash Decimation.
     * Merges splat sets from multiple camera perspectives, removing redundant
     * overlapping splats and maintaining balanced density.
     */
    static std::vector<GaussianSplat> fuseMultiViewSplats(
        const std::vector<std::vector<GaussianSplat>>& viewSplats,
        float voxelSize = 0.04f
    ) {
        if (viewSplats.empty()) return {};
        if (viewSplats.size() == 1) return viewSplats[0];

        struct VoxelKey {
            int64_t x, y, z;
            bool operator==(const VoxelKey& o) const {
                return x == o.x && y == o.y && z == o.z;
            }
        };

        struct VoxelKeyHash {
            size_t operator()(const VoxelKey& k) const {
                return (static_cast<size_t>(k.x) * 73856093) ^
                       (static_cast<size_t>(k.y) * 19349663) ^
                       (static_cast<size_t>(k.z) * 83492791);
            }
        };

        std::unordered_map<VoxelKey, GaussianSplat, VoxelKeyHash> grid;
        float invVoxel = 1.0f / std::max(0.001f, voxelSize);

        for (const auto& list : viewSplats) {
            for (const auto& s : list) {
                VoxelKey key{
                    static_cast<int64_t>(std::floor(s.position.x * invVoxel)),
                    static_cast<int64_t>(std::floor(s.position.y * invVoxel)),
                    static_cast<int64_t>(std::floor(s.position.z * invVoxel))
                };

                auto it = grid.find(key);
                if (it == grid.end()) {
                    grid[key] = s;
                } else {
                    // Blend splat with higher resolution / smaller scale
                    float currentVol = s.scale.x * s.scale.y * s.scale.z;
                    float existingVol = it->second.scale.x * it->second.scale.y * it->second.scale.z;
                    if (currentVol < existingVol) {
                        it->second = s;
                    } else {
                        // Smooth color blending
                        it->second.color = (it->second.color + s.color) * 0.5f;
                        it->second.opacity = std::max(it->second.opacity, s.opacity);
                    }
                }
            }
        }

        std::vector<GaussianSplat> result;
        result.reserve(grid.size());
        for (const auto& pair : grid) {
            result.push_back(pair.second);
        }

        return result;
    }

    /**
     * Serializes GaussianSplat vector to standard binary .splat file format (32 bytes / splat).
     */
    static bool saveToSplatFile(const std::string& filepath, const std::vector<GaussianSplat>& splats) {
        std::ofstream out(filepath, std::ios::binary);
        if (!out.is_open()) return false;

        const size_t BYTES_PER_SPLAT = 32;
        std::vector<uint8_t> buffer(splats.size() * BYTES_PER_SPLAT);

        for (size_t i = 0; i < splats.size(); ++i) {
            const auto& s = splats[i];
            size_t offset = i * BYTES_PER_SPLAT;

            // Position (3 x float32 LE)
            std::memcpy(&buffer[offset + 0], &s.position.x, 4);
            std::memcpy(&buffer[offset + 4], &s.position.y, 4);
            std::memcpy(&buffer[offset + 8], &s.position.z, 4);

            // Scale (3 x float32 LE)
            std::memcpy(&buffer[offset + 12], &s.scale.x, 4);
            std::memcpy(&buffer[offset + 16], &s.scale.y, 4);
            std::memcpy(&buffer[offset + 20], &s.scale.z, 4);

            // Color (3 x uint8 RGBA)
            uint8_t r = static_cast<uint8_t>(std::clamp(std::round(s.color.x * 255.0f), 0.0f, 255.0f));
            uint8_t g = static_cast<uint8_t>(std::clamp(std::round(s.color.y * 255.0f), 0.0f, 255.0f));
            uint8_t b = static_cast<uint8_t>(std::clamp(std::round(s.color.z * 255.0f), 0.0f, 255.0f));
            uint8_t a = static_cast<uint8_t>(std::clamp(std::round(s.opacity * 255.0f), 0.0f, 255.0f));

            buffer[offset + 24] = r;
            buffer[offset + 25] = g;
            buffer[offset + 26] = b;
            buffer[offset + 27] = a;

            // Quaternion (4 x uint8 mapped from [-1, 1] to [0, 255])
            uint8_t qx = static_cast<uint8_t>(std::clamp(std::round((s.rotation.x * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
            uint8_t qy = static_cast<uint8_t>(std::clamp(std::round((s.rotation.y * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
            uint8_t qz = static_cast<uint8_t>(std::clamp(std::round((s.rotation.z * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));
            uint8_t qw = static_cast<uint8_t>(std::clamp(std::round((s.rotation.w * 0.5f + 0.5f) * 255.0f), 0.0f, 255.0f));

            buffer[offset + 28] = qx;
            buffer[offset + 29] = qy;
            buffer[offset + 30] = qz;
            buffer[offset + 31] = qw;
        }

        out.write(reinterpret_cast<const char*>(buffer.data()), buffer.size());
        return out.good();
    }

    /**
     * Converts a single 2D image with Multi-Layer Occlusion Inpainting.
     * Identifies foreground depth silhouettes (depth step delta > tau) and synthesizes
     * an occluded background Gaussian layer behind foreground objects, eliminating
     * hollow back-face voids when orbiting the camera.
     */
    static std::vector<GaussianSplat> convertSingleImageWithOcclusionInpainting(
        const PinholeCamera& cam,
        const uint8_t* rgbBytes,
        size_t channels,
        const float* metricDepths,
        const DepthToGaussianOptions& options = DepthToGaussianOptions(),
        const CameraPose& pose = CameraPose()
    ) {
        // 1. Generate primary front-facing layer
        std::vector<GaussianSplat> splats = convertSingleImage(cam, rgbBytes, channels, metricDepths, options, pose);

        uint32_t W = cam.width;
        uint32_t H = cam.height;
        uint32_t step = std::max(1u, options.stride);

        // 2. Identify silhouette pixels and synthesize background infill layer
        std::vector<GaussianSplat> inpaintSplats;
        inpaintSplats.reserve(splats.size() / 4);

        for (uint32_t y = 0; y < H; y += step) {
            for (uint32_t x = 0; x < W; x += step) {
                size_t idx = y * W + x;
                float d = metricDepths[idx];
                if (std::isnan(d) || d < options.minDepth || d > options.maxDepth) continue;

                uint32_t xNext = std::min(W - 1, x + step);
                uint32_t xPrev = (x >= step) ? (x - step) : 0;
                uint32_t yNext = std::min(H - 1, y + step);
                uint32_t yPrev = (y >= step) ? (y - step) : 0;

                float dRight = metricDepths[y * W + xNext];
                float dLeft  = metricDepths[y * W + xPrev];
                float dDown  = metricDepths[yNext * W + x];
                float dUp    = metricDepths[yPrev * W + x];

                // Detect if current pixel is a foreground object occluding deeper background
                float bgDepth = 0.0f;
                int bgCount = 0;
                float fgBgRatio = 1.0f + options.edgeSeveranceTau * 1.5f;

                Vec3 bgAccumColor(0.0f, 0.0f, 0.0f);

                auto checkNeighbor = [&](uint32_t nx, uint32_t ny, float nd) {
                    if (!std::isnan(nd) && nd > d * fgBgRatio) {
                        bgDepth += nd;
                        size_t nIdx = (ny * W + nx) * channels;
                        bgAccumColor.x += static_cast<float>(rgbBytes[nIdx + 0]) / 255.0f;
                        bgAccumColor.y += static_cast<float>(rgbBytes[nIdx + 1]) / 255.0f;
                        bgAccumColor.z += static_cast<float>(rgbBytes[nIdx + 2]) / 255.0f;
                        bgCount++;
                    }
                };

                checkNeighbor(xNext, y, dRight);
                checkNeighbor(xPrev, y, dLeft);
                checkNeighbor(x, yNext, dDown);
                checkNeighbor(x, yPrev, dUp);

                // If this is a foreground silhouette occluding background
                if (bgCount > 0) {
                    float avgBgDepth = (bgDepth / static_cast<float>(bgCount)) * 1.04f; // Push slightly back
                    Vec3 avgBgColor = bgAccumColor * (1.0f / static_cast<float>(bgCount));

                    Vec3 ray = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(y));
                    Vec3 pLocal = ray * avgBgDepth;

                    // Surface normal facing camera
                    Vec3 normal = -ray;
                    Quat qLocal = quatFromUnitVectors(Vec3(0.0f, 0.0f, 1.0f), normal);

                    float pixelFootprint = (static_cast<float>(step) * avgBgDepth / cam.fx) * options.splatScaleMultiplier * 1.4f;
                    float sx = pixelFootprint;
                    float sy = pixelFootprint;
                    float sz = pixelFootprint * options.splatThicknessRatio;

                    Vec3 pWorld = pose.transformPoint(pLocal);
                    Quat qWorld = pose.transformQuat(qLocal);

                    GaussianSplat s;
                    s.position = pWorld;
                    s.scale = Vec3(sx, sy, sz);
                    s.rotation = qWorld;
                    s.color = avgBgColor;
                    s.opacity = 0.88f; // Soft background infill

                    inpaintSplats.push_back(s);
                }
            }
        }

        splats.insert(splats.end(), inpaintSplats.begin(), inpaintSplats.end());
        return splats;
    }

    // ========================================================================
    // 4. Physics Collider Mesh (.GLB) Generation (Depthbox Dual Output)
    // ========================================================================

    struct BoxCollider {
        Vec3 center;
        Vec3 extents; // half-widths along x, y, z
        std::string label;
    };

    struct PhysicsColliderData {
        std::vector<Vec3> positions;
        std::vector<Vec3> normals;
        std::vector<uint32_t> indices;
        std::vector<BoxCollider> boundingBoxes;
        float groundElevation{-1.6f};
    };

    /**
     * Extracts low-poly physics colliders (navigable ground plane + obstacle bounding boxes)
     * matching the spatial dimensions of the generated 3DGS world.
     */
    static PhysicsColliderData extractPhysicsColliders(
        const PinholeCamera& cam,
        const float* metricDepths,
        const CameraPose& pose = CameraPose(),
        float minDepth = 0.5f,
        float maxDepth = 150.0f
    ) {
        PhysicsColliderData col;
        uint32_t W = cam.width;
        uint32_t H = cam.height;

        // 1. Identify Ground Elevation from bottom 25% of image
        float groundYSum = 0.0f;
        int groundSamples = 0;
        float groundZMin = 1e6f, groundZMax = -1e6f;
        float groundXMin = 1e6f, groundXMax = -1e6f;

        for (uint32_t y = static_cast<uint32_t>(H * 0.75f); y < H; y += 4) {
            for (uint32_t x = 0; x < W; x += 4) {
                float d = metricDepths[y * W + x];
                if (std::isnan(d) || d < minDepth || d > maxDepth) continue;

                Vec3 ray = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(y));
                Vec3 p = pose.transformPoint(ray * d);

                groundYSum += p.y;
                groundSamples++;
                groundXMin = std::min(groundXMin, p.x);
                groundXMax = std::max(groundXMax, p.x);
                groundZMin = std::min(groundZMin, p.z);
                groundZMax = std::max(groundZMax, p.z);
            }
        }

        float groundY = (groundSamples > 0) ? (groundYSum / groundSamples) : -1.6f;
        col.groundElevation = groundY;

        // Ground Plane Quad (Navigable mesh)
        float gWidth = std::max(40.0f, (groundXMax - groundXMin) * 1.5f);
        float gDepth = std::max(50.0f, std::abs(groundZMax - groundZMin) * 1.5f);
        float gCenterX = (groundXMin + groundXMax) * 0.5f;
        float gCenterZ = (groundZMin + groundZMax) * 0.5f;

        uint32_t baseIdx = static_cast<uint32_t>(col.positions.size());
        col.positions.push_back(Vec3(gCenterX - gWidth * 0.5f, groundY, gCenterZ - gDepth * 0.5f));
        col.positions.push_back(Vec3(gCenterX + gWidth * 0.5f, groundY, gCenterZ - gDepth * 0.5f));
        col.positions.push_back(Vec3(gCenterX + gWidth * 0.5f, groundY, gCenterZ + gDepth * 0.5f));
        col.positions.push_back(Vec3(gCenterX - gWidth * 0.5f, groundY, gCenterZ + gDepth * 0.5f));

        for (int i = 0; i < 4; ++i) col.normals.push_back(Vec3(0.0f, 1.0f, 0.0f));

        col.indices.push_back(baseIdx + 0);
        col.indices.push_back(baseIdx + 1);
        col.indices.push_back(baseIdx + 2);
        col.indices.push_back(baseIdx + 0);
        col.indices.push_back(baseIdx + 2);
        col.indices.push_back(baseIdx + 3);

        // 2. Segment Left, Center, and Right Obstacle Bounding Boxes
        auto buildBoxCollider = [&](uint32_t xStart, uint32_t xEnd, const std::string& label) {
            float minX = 1e6f, maxX = -1e6f;
            float minY = 1e6f, maxY = -1e6f;
            float minZ = 1e6f, maxZ = -1e6f;
            int count = 0;

            for (uint32_t y = static_cast<uint32_t>(H * 0.15f); y < static_cast<uint32_t>(H * 0.85f); y += 4) {
                for (uint32_t x = xStart; x < xEnd; x += 4) {
                    float d = metricDepths[y * W + x];
                    if (std::isnan(d) || d < minDepth || d > maxDepth * 0.7f) continue;

                    Vec3 ray = cam.unprojectPixelToRay(static_cast<float>(x), static_cast<float>(y));
                    Vec3 p = pose.transformPoint(ray * d);

                    minX = std::min(minX, p.x);
                    maxX = std::max(maxX, p.x);
                    minY = std::min(minY, p.y);
                    maxY = std::max(maxY, p.y);
                    minZ = std::min(minZ, p.z);
                    maxZ = std::max(maxZ, p.z);
                    count++;
                }
            }

            if (count > 20 && maxX > minX && maxY > minY && maxZ > minZ) {
                BoxCollider box;
                box.center = Vec3((minX + maxX) * 0.5f, (minY + maxY) * 0.5f, (minZ + maxZ) * 0.5f);
                box.extents = Vec3((maxX - minX) * 0.5f, (maxY - minY) * 0.5f, (maxZ - minZ) * 0.5f);
                box.label = label;
                col.boundingBoxes.push_back(box);

                // Add 12 triangles (6 faces) to collider mesh
                uint32_t bIdx = static_cast<uint32_t>(col.positions.size());
                Vec3 c = box.center;
                Vec3 e = box.extents;

                // 8 corners
                col.positions.push_back(Vec3(c.x - e.x, c.y - e.y, c.z - e.z));
                col.positions.push_back(Vec3(c.x + e.x, c.y - e.y, c.z - e.z));
                col.positions.push_back(Vec3(c.x + e.x, c.y + e.y, c.z - e.z));
                col.positions.push_back(Vec3(c.x - e.x, c.y + e.y, c.z - e.z));
                col.positions.push_back(Vec3(c.x - e.x, c.y - e.y, c.z + e.z));
                col.positions.push_back(Vec3(c.x + e.x, c.y - e.y, c.z + e.z));
                col.positions.push_back(Vec3(c.x + e.x, c.y + e.y, c.z + e.z));
                col.positions.push_back(Vec3(c.x - e.x, c.y + e.y, c.z + e.z));

                for (int i = 0; i < 8; ++i) col.normals.push_back(Vec3(0.0f, 1.0f, 0.0f));

                // 6 box faces
                uint32_t faceIndices[36] = {
                    0, 2, 1, 0, 3, 2, // Front
                    4, 5, 6, 4, 6, 7, // Back
                    0, 1, 5, 0, 5, 4, // Bottom
                    3, 6, 2, 3, 7, 6, // Top
                    0, 4, 7, 0, 7, 3, // Left
                    1, 2, 6, 1, 6, 5  // Right
                };
                for (int i = 0; i < 36; ++i) {
                    col.indices.push_back(bIdx + faceIndices[i]);
                }
            }
        };

        buildBoxCollider(0, W / 3, "collider_monolith_left");
        buildBoxCollider(W / 3, (2 * W) / 3, "collider_monolith_center");
        buildBoxCollider((2 * W) / 3, W, "collider_monolith_right");

        return col;
    }

    /**
     * Serializes Physics Collider Mesh into standard binary glTF 2.0 (.glb) container.
     */
    static std::vector<uint8_t> serializeColliderToGlb(const PhysicsColliderData& col) {
        if (col.positions.empty() || col.indices.empty()) {
            return {};
        }

        // Align helper
        auto align4 = [](size_t n) { return (n + 3) & ~3; };

        size_t posBytes = col.positions.size() * sizeof(Vec3);
        size_t normBytes = col.normals.size() * sizeof(Vec3);
        size_t idxBytes = col.indices.size() * sizeof(uint32_t);

        size_t idxOffset = 0;
        size_t posOffset = align4(idxOffset + idxBytes);
        size_t normOffset = align4(posOffset + posBytes);
        size_t totalBinBytes = align4(normOffset + normBytes);

        std::vector<uint8_t> binBuffer(totalBinBytes, 0);
        std::memcpy(binBuffer.data() + idxOffset, col.indices.data(), idxBytes);
        std::memcpy(binBuffer.data() + posOffset, col.positions.data(), posBytes);
        std::memcpy(binBuffer.data() + normOffset, col.normals.data(), normBytes);

        // Compute AABB
        Vec3 minP(1e9f, 1e9f, 1e9f), maxP(-1e9f, -1e9f, -1e9f);
        for (const auto& p : col.positions) {
            minP.x = std::min(minP.x, p.x); minP.y = std::min(minP.y, p.y); minP.z = std::min(minP.z, p.z);
            maxP.x = std::max(maxP.x, p.x); maxP.y = std::max(maxP.y, p.y); maxP.z = std::max(maxP.z, p.z);
        }

        std::stringstream ss;
        ss << "{\n"
           << "  \"asset\": {\"version\": \"2.0\", \"generator\": \"DepthBox C++20 Physics Collider Baker\"},\n"
           << "  \"scene\": 0,\n"
           << "  \"scenes\": [{\"nodes\": [0]}],\n"
           << "  \"nodes\": [{\"mesh\": 0, \"name\": \"Depthbox_Physics_Collider\"}],\n"
           << "  \"meshes\": [{\n"
           << "    \"name\": \"PhysicsColliderMesh\",\n"
           << "    \"primitives\": [{\n"
           << "      \"attributes\": {\"POSITION\": 1, \"NORMAL\": 2},\n"
           << "      \"indices\": 0,\n"
           << "      \"material\": 0\n"
           << "    }]\n"
           << "  }],\n"
           << "  \"materials\": [{\n"
           << "    \"name\": \"ColliderWireframeMat\",\n"
           << "    \"pbrMetallicRoughness\": {\n"
           << "      \"baseColorFactor\": [0.22, 0.74, 0.97, 0.65],\n"
           << "      \"metallicFactor\": 0.1,\n"
           << "      \"roughnessFactor\": 0.9\n"
           << "    }\n"
           << "  }],\n"
           << "  \"accessors\": [\n"
           << "    {\"bufferView\": 0, \"byteOffset\": 0, \"componentType\": 5125, \"count\": " << col.indices.size() << ", \"type\": \"SCALAR\"},\n"
           << "    {\"bufferView\": 1, \"byteOffset\": 0, \"componentType\": 5126, \"count\": " << col.positions.size() << ", \"type\": \"VEC3\", \"min\": [" << minP.x << "," << minP.y << "," << minP.z << "], \"max\": [" << maxP.x << "," << maxP.y << "," << maxP.z << "]},\n"
           << "    {\"bufferView\": 2, \"byteOffset\": 0, \"componentType\": 5126, \"count\": " << col.normals.size() << ", \"type\": \"VEC3\"}\n"
           << "  ],\n"
           << "  \"bufferViews\": [\n"
           << "    {\"buffer\": 0, \"byteOffset\": " << idxOffset << ", \"byteLength\": " << idxBytes << ", \"target\": 34963},\n"
           << "    {\"buffer\": 0, \"byteOffset\": " << posOffset << ", \"byteLength\": " << posBytes << ", \"target\": 34962},\n"
           << "    {\"buffer\": 0, \"byteOffset\": " << normOffset << ", \"byteLength\": " << normBytes << ", \"target\": 34962}\n"
           << "  ],\n"
           << "  \"buffers\": [{\"byteLength\": " << totalBinBytes << "}]\n"
           << "}";

        std::string jsonStr = ss.str();
        size_t paddedJsonLen = align4(jsonStr.size());
        while (jsonStr.size() < paddedJsonLen) jsonStr.push_back(' ');

        size_t totalGlbLen = 12 + 8 + paddedJsonLen + 8 + totalBinBytes;
        std::vector<uint8_t> glb(totalGlbLen, 0);

        // Header
        uint32_t magic = 0x46546C67; // 'glTF'
        uint32_t version = 2;
        uint32_t totalLenU32 = static_cast<uint32_t>(totalGlbLen);
        std::memcpy(glb.data() + 0, &magic, 4);
        std::memcpy(glb.data() + 4, &version, 4);
        std::memcpy(glb.data() + 8, &totalLenU32, 4);

        // JSON Chunk
        uint32_t jsonLen = static_cast<uint32_t>(paddedJsonLen);
        uint32_t jsonType = 0x4E4F534A; // 'JSON'
        std::memcpy(glb.data() + 12, &jsonLen, 4);
        std::memcpy(glb.data() + 16, &jsonType, 4);
        std::memcpy(glb.data() + 20, jsonStr.data(), jsonStr.size());

        // BIN Chunk
        size_t binHeaderOffset = 20 + paddedJsonLen;
        uint32_t binLen = static_cast<uint32_t>(totalBinBytes);
        uint32_t binType = 0x004E4942; // 'BIN\0'
        std::memcpy(glb.data() + binHeaderOffset, &binLen, 4);
        std::memcpy(glb.data() + binHeaderOffset + 4, &binType, 4);
        std::memcpy(glb.data() + binHeaderOffset + 8, binBuffer.data(), totalBinBytes);

        return glb;
    }

private:
    // Right-handed orthonormal basis (T, B, N) with T x B = N -> unit quaternion (Shepperd's method).
    static Quat quatFromBasis(const Vec3& T, const Vec3& B, const Vec3& N) {
        float trace = T.x + B.y + N.z;
        Quat q;
        if (trace > 0.0f) {
            float s = 0.5f / std::sqrt(trace + 1.0f);
            q.w = 0.25f / s;
            q.x = (B.z - N.y) * s;
            q.y = (N.x - T.z) * s;
            q.z = (T.y - B.x) * s;
        } else if (T.x > B.y && T.x > N.z) {
            float s = 2.0f * std::sqrt(std::max(1e-4f, 1.0f + T.x - B.y - N.z));
            q.w = (B.z - N.y) / s;
            q.x = 0.25f * s;
            q.y = (T.y + B.x) / s;
            q.z = (N.x + T.z) / s;
        } else if (B.y > N.z) {
            float s = 2.0f * std::sqrt(std::max(1e-4f, 1.0f + B.y - T.x - N.z));
            q.w = (N.x - T.z) / s;
            q.x = (T.y + B.x) / s;
            q.y = 0.25f * s;
            q.z = (B.z + N.y) / s;
        } else {
            float s = 2.0f * std::sqrt(std::max(1e-4f, 1.0f + N.z - T.x - B.y));
            q.w = (T.y - B.x) / s;
            q.x = (N.x + T.z) / s;
            q.y = (B.z + N.y) / s;
            q.z = 0.25f * s;
        }
        return q.normalized();
    }

    static Quat quatFromUnitVectors(const Vec3& from, const Vec3& to) {
        float dot = from.dot(to);
        if (dot >= 0.999999f) {
            return Quat(0.0f, 0.0f, 0.0f, 1.0f);
        }
        if (dot <= -0.999999f) {
            // 180 degree rotation around arbitrary orthogonal axis
            Vec3 axis = Vec3(1.0f, 0.0f, 0.0f).cross(from);
            if (axis.length() < 0.01f) {
                axis = Vec3(0.0f, 1.0f, 0.0f).cross(from);
            }
            axis = axis.normalized();
            return Quat(axis.x, axis.y, axis.z, 0.0f);
        }

        Vec3 cross = from.cross(to);
        Quat q(cross.x, cross.y, cross.z, 1.0f + dot);
        return q.normalized();
    }

public:
    struct AtmosphereEnvironment {
        Vec3 sunDirection{0.4f, 0.8f, -0.4f};
        Vec3 sunColor{1.0f, 0.95f, 0.85f};
        float sunIntensity{1.2f};
        Vec3 skyAmbient{0.25f, 0.40f, 0.65f};
        Vec3 groundAmbient{0.12f, 0.10f, 0.08f};
        Vec3 fogColor{0.65f, 0.75f, 0.88f};
        float fogDensity{0.015f};
    };

    static inline void evaluateGaussianLighting(
        const GaussianSplat& splat,
        const AtmosphereEnvironment& env,
        float relightingMix,
        Vec3& outRgb
    ) {
        float qx = splat.rotation.x, qy = splat.rotation.y, qz = splat.rotation.z, qw = splat.rotation.w;
        Vec3 normal(
            2.0f * (qx * qz + qw * qy),
            2.0f * (qy * qz - qw * qx),
            1.0f - 2.0f * (qx * qx + qy * qy)
        );
        normal = normal.normalized();
        Vec3 sunDir = env.sunDirection.normalized();
        float nDotL = std::max(0.0f, normal.dot(sunDir));

        float hemi = normal.y * 0.5f + 0.5f;
        Vec3 ambient(
            env.groundAmbient.x * (1.0f - hemi) + env.skyAmbient.x * hemi,
            env.groundAmbient.y * (1.0f - hemi) + env.skyAmbient.y * hemi,
            env.groundAmbient.z * (1.0f - hemi) + env.skyAmbient.z * hemi
        );

        Vec3 albedo(splat.color.x, splat.color.y, splat.color.z);
        Vec3 lit(
            albedo.x * (ambient.x + env.sunColor.x * nDotL * env.sunIntensity),
            albedo.y * (ambient.y + env.sunColor.y * nDotL * env.sunIntensity),
            albedo.z * (ambient.z + env.sunColor.z * nDotL * env.sunIntensity)
        );

        outRgb.x = albedo.x * (1.0f - relightingMix) + lit.x * relightingMix;
        outRgb.y = albedo.y * (1.0f - relightingMix) + lit.y * relightingMix;
        outRgb.z = albedo.z * (1.0f - relightingMix) + lit.z * relightingMix;
    }

    static inline Vec3 getEquirectRay(int x, int y, int width, int height) {
        float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(width);
        float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(height);
        float pitch = (0.5f - v) * static_cast<float>(M_PI);
        float cosPitch = std::cos(pitch);
        float sinPitch = std::sin(pitch);
        float yaw = (u * 2.0f - 1.0f) * static_cast<float>(M_PI);
        return Vec3(std::sin(yaw) * cosPitch, sinPitch, -std::cos(yaw) * cosPitch);
    }

    /**
     * Converts a 360-degree Equirectangular Panoramic Image into a complete
     * omnidirectional 3D Gaussian Splatting radiance world.
     */
    static std::vector<GaussianSplat> convertEquirectangularToGaussianSplats(
        const uint8_t* rgbBuffer,
        int width,
        int height,
        int channels = 3,
        const float* optionalMetricDepths = nullptr,
        const uint8_t* optionalMask = nullptr,
        int stride = 2,
        float eyeHeight = 1.70f,
        float maxRadius = 80.0f,
        float edgeSeveranceTau = 0.08f,
        // Scale is the Gaussian sigma. Calibrated against an independent renderer (gaussian-splat-lite,
        // 2.83 sigma kernel, no low-pass dilation): 0.65 leaves a visible row lattice on thin disc
        // splats; 0.95 halves it while keeping edge detail. Our own viewer adds a small depth-scaled
        // low-pass, so it is gapless at either value.
        float splatScaleMultiplier = 0.95f,
        float splatThicknessRatio = 0.22f,
        bool inpaintOcclusion = true
    ) {
        std::vector<GaussianSplat> splats;
        if (!rgbBuffer || width <= 0 || height <= 0) return splats;

        int step = std::max(1, stride);
        splats.reserve((width / step) * (height / step));

        std::vector<GaussianSplat> inpaintSplats;

        for (int y = 0; y < height; y += step) {
            float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(height);
            float pitch = (0.5f - v) * static_cast<float>(M_PI);
            float cosPitch = std::cos(pitch);
            float sinPitch = std::sin(pitch);

            // Equal-area sampling: scale horizontal stride relative to latitude cos(pitch)
            int x_step = std::max(1, static_cast<int>(std::round(step / std::max(0.1f, cosPitch))));

            for (int x = 0; x < width; x += x_step) {
                size_t pIdx = static_cast<size_t>(y) * width + x;
                if (optionalMask != nullptr && optionalMask[pIdx] < 128) {
                    continue;
                }

                float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(width);
                float yaw = (u * 2.0f - 1.0f) * static_cast<float>(M_PI);

                Vec3 ray = getEquirectRay(x, y, width, height);

                size_t cIdx = pIdx * channels;

                uint8_t r = rgbBuffer[cIdx];
                uint8_t g = rgbBuffer[cIdx + 1];
                uint8_t b = rgbBuffer[cIdx + 2];
                float lum = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f;

                float depth = 0.0f;
                if (optionalMetricDepths != nullptr) {
                    depth = optionalMetricDepths[pIdx];
                } else {
                    if (ray.y < -0.04f) {
                        float tFloor = -eyeHeight / ray.y;
                        depth = std::min(tFloor, maxRadius);
                    } else {
                        float baseD = maxRadius * 0.65f;
                        float relief = (1.0f - lum) * (maxRadius * 0.25f);
                        depth = std::min(maxRadius, baseD + relief);
                    }
                }

                if (depth < 0.2f) depth = 0.2f;

                Vec3 pos(
                    ray.x * depth,
                    eyeHeight + ray.y * depth,
                    ray.z * depth
                );

                Vec3 normal = (-ray).normalized();
                bool isEdge = false;
                float alpha = 1.0f;

                // 4-connected neighbor sampling for depth gradient normals and edge severance
                if (optionalMetricDepths != nullptr) {
                    int xNext = (x + step) % width;
                    int xPrev = (x - step + width) % width;
                    int yNext = std::min(height - 1, y + step);
                    int yPrev = std::max(0, y - step);

                    float dRight = optionalMetricDepths[y * width + xNext];
                    float dLeft  = optionalMetricDepths[y * width + xPrev];
                    float dDown  = optionalMetricDepths[yNext * width + x];
                    float dUp    = optionalMetricDepths[yPrev * width + x];

                    float maxDx = std::max(1e-4f, std::max(dRight, dLeft));
                    float maxDy = std::max(1e-4f, std::max(dDown, dUp));
                    float deltaX = std::abs(dRight - dLeft) / maxDx;
                    float deltaY = std::abs(dDown - dUp) / maxDy;

                    isEdge = (deltaX > edgeSeveranceTau) || (deltaY > edgeSeveranceTau);

                    Vec3 pRight = getEquirectRay(xNext, y, width, height) * dRight;
                    Vec3 pLeft  = getEquirectRay(xPrev, y, width, height) * dLeft;
                    Vec3 pDown  = getEquirectRay(x, yNext, width, height) * dDown;
                    Vec3 pUp    = getEquirectRay(x, yPrev, width, height) * dUp;

                    Vec3 tx = pRight - pLeft;
                    Vec3 ty = pDown - pUp;
                    Vec3 gradNorm = tx.cross(ty);
                    float gradNormLen = gradNorm.length();

                    if (gradNormLen > 1e-6f) {
                        normal = gradNorm * (1.0f / gradNormLen);
                        if (normal.dot(ray) > 0.0f) {
                            normal = -normal;
                        }
                    }

                    // Multilayer disocclusion inpainting synthesis
                    if (inpaintOcclusion) {
                        float bgDepthSum = 0.0f;
                        int bgCount = 0;
                        float fgBgRatio = 1.0f + edgeSeveranceTau * 1.5f;
                        Vec3 bgAccumColor(0.0f, 0.0f, 0.0f);

                        auto checkNeighbor = [&](int nx, int ny, float nd) {
                            if (nd > depth * fgBgRatio) {
                                bgDepthSum += nd;
                                size_t nIdx = (static_cast<size_t>(ny) * width + nx) * channels;
                                bgAccumColor.x += rgbBuffer[nIdx + 0] / 255.0f;
                                bgAccumColor.y += rgbBuffer[nIdx + 1] / 255.0f;
                                bgAccumColor.z += rgbBuffer[nIdx + 2] / 255.0f;
                                bgCount++;
                            }
                        };

                        checkNeighbor(xNext, y, dRight);
                        checkNeighbor(xPrev, y, dLeft);
                        checkNeighbor(x, yNext, dDown);
                        checkNeighbor(x, yPrev, dUp);

                        if (bgCount > 0) {
                            float avgBgDepth = (bgDepthSum / static_cast<float>(bgCount)) * 1.04f;
                            Vec3 avgBgColor = bgAccumColor * (1.0f / static_cast<float>(bgCount));

                            Vec3 bgPos(
                                ray.x * avgBgDepth,
                                eyeHeight + ray.y * avgBgDepth,
                                ray.z * avgBgDepth
                            );

                            Vec3 bgNormal = -ray;
                            Vec3 bgZAxis(0.0f, 0.0f, 1.0f);
                            Vec3 bgAxis = bgZAxis.cross(bgNormal);
                            float bgDot = bgZAxis.dot(bgNormal);
                            Quat bgRot;
                            if (bgDot < -0.9999f) {
                                bgRot = Quat(0.0f, 1.0f, 0.0f, 0.0f);
                            } else {
                                bgRot = Quat(bgAxis.x, bgAxis.y, bgAxis.z, 1.0f + bgDot).normalized();
                            }

                            float deltaYaw = (2.0f * static_cast<float>(M_PI) * x_step) / static_cast<float>(width);
                            float arc = avgBgDepth * deltaYaw * std::max(0.1f, cosPitch) * splatScaleMultiplier * 1.35f;
                            arc = std::max(0.02f, std::min(arc, 4.0f));
                            Vec3 bgScale(arc, arc, arc * splatThicknessRatio);

                            GaussianSplat bgSplat;
                            bgSplat.position = bgPos;
                            bgSplat.scale = bgScale;
                            bgSplat.rotation = bgRot;
                            bgSplat.color = avgBgColor;
                            bgSplat.opacity = 0.85f;
                            inpaintSplats.push_back(bgSplat);
                        }
                    }
                }

                // Tangential scale proportional to angular subtended arc
                float deltaYaw = (2.0f * static_cast<float>(M_PI) * x_step) / static_cast<float>(width);
                float arc = depth * deltaYaw * std::max(0.1f, cosPitch) * splatScaleMultiplier;
                arc = std::max(0.02f, std::min(arc, 4.0f));

                // Sever edges to eliminate stretching artifacts
                if (isEdge) {
                    arc *= 0.45f;
                    alpha *= 0.85f;
                }

                // Foreshortening compensation: at grazing incidence the surface footprint of one
                // pixel row is arc / |n.ray| along the ray's tangent-plane projection. Build an
                // explicit (T_perp, T_fore, N) basis so the splat can be elongated only along the
                // foreshortened direction (prevents scanline gaps on floors/ceilings/walls).
                float cosInc = std::abs(normal.dot(ray));
                // Clamp to 2x: enough to close grazing-row gaps at 3 sigma, without smearing the
                // floor into radial streaks when the viewer walks off the capture point.
                float elongation = 1.0f / std::max(0.5f, cosInc);
                Vec3 tFore = ray - normal * normal.dot(ray);
                float tForeLen = tFore.length();
                Quat rot;
                Vec3 scale;
                if (tForeLen > 1e-4f && elongation > 1.05f) {
                    tFore = tFore * (1.0f / tForeLen);
                    Vec3 tPerp = normal.cross(tFore).normalized();
                    rot = quatFromBasis(tPerp, tFore, normal);
                    scale = Vec3(arc, arc * elongation, arc * splatThicknessRatio);
                } else {
                    Vec3 zAxis(0.0f, 0.0f, 1.0f);
                    Vec3 axis = zAxis.cross(normal);
                    float dot = zAxis.dot(normal);
                    if (dot < -0.9999f) {
                        rot = Quat(0.0f, 1.0f, 0.0f, 0.0f); // 180 deg around Y
                    } else {
                        rot = Quat(axis.x, axis.y, axis.z, 1.0f + dot).normalized();
                    }
                    scale = Vec3(arc, arc, arc * splatThicknessRatio);
                }

                GaussianSplat s;
                s.position = pos;
                s.scale = scale;
                s.rotation = rot;
                s.color = Vec3(r / 255.0f, g / 255.0f, b / 255.0f);
                s.opacity = alpha;

                splats.push_back(s);
            }
        }

        // Insert inpainted disocclusion background layer
        if (!inpaintSplats.empty()) {
            splats.insert(splats.end(), inpaintSplats.begin(), inpaintSplats.end());
        }

        return splats;
    }
};

} // namespace depthbox
} // namespace scratchbox

#endif // SCRATCHBOX_DEPTH_TO_GAUSSIAN_HPP
