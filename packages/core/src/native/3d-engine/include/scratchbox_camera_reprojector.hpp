/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_CAMERA_REPROJECTOR_HPP
#define SCRATCHBOX_CAMERA_REPROJECTOR_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_io.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <string>
#include <iostream>
#include <fstream>
#include <sstream>
#include <memory>
#include <cstdint>
#include <cstring>

namespace scratchbox {
namespace reprojector {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat3;
using math::Mat4;
using math::PI;
using math::DEG_TO_RAD;
using math::RAD_TO_DEG;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;
using texture::ImageBuffer;

// ============================================================================
// 1. Camera Intrinsics and Extrinsics Formulation
// ============================================================================

struct CameraIntrinsics {
    float fx{500.0f};
    float fy{500.0f};
    float cx{256.0f};
    float cy{256.0f};
    int width{512};
    int height{512};
    float fovYDegrees{60.0f};

    static CameraIntrinsics fromFov(float fovDeg, int w, int h) {
        CameraIntrinsics intr;
        intr.width = w;
        intr.height = h;
        intr.fovYDegrees = fovDeg;
        float rad = fovDeg * 0.5f * DEG_TO_RAD;
        intr.fy = (static_cast<float>(h) * 0.5f) / std::tan(rad);
        intr.fx = intr.fy; // Assume square pixels
        intr.cx = static_cast<float>(w) * 0.5f;
        intr.cy = static_cast<float>(h) * 0.5f;
        return intr;
    }

    // Unproject pixel (u, v) with depth Z into 3D camera space (OpenGL: -Z forward, +Y up, +X right)
    Vec3 unproject(float u, float v, float z) const {
        float x = (u - cx) * z / fx;
        float y = -(v - cy) * z / fy; // Invert Y for screen to 3D convention
        return {x, y, -z};
    }

    // Project 3D camera space point into 2D pixel coordinates (u, v) and positive depth
    bool project(const Vec3& p, float& u, float& v, float& zOut) const {
        if (p.z >= -1e-4f) return false; // Behind or on camera plane
        float z = -p.z;
        u = (fx * p.x / z) + cx;
        v = cy - (fy * p.y / z);
        zOut = z;
        return true;
    }
};

struct CameraPose {
    Vec3 position{0.0f, 0.0f, 2.5f};
    Vec3 target{0.0f, 0.0f, 0.0f};
    Vec3 up{0.0f, 1.0f, 0.0f};

    float yawDeg{0.0f};      // Horizontal orbit
    float pitchDeg{0.0f};    // Vertical elevation
    float rollDeg{0.0f};     // Barrel roll
    float distance{2.5f};

    static CameraPose fromOrbit(float yaw, float pitch, float roll, float dist, const Vec3& tgt = {0, 0, 0}) {
        CameraPose pose;
        pose.yawDeg = yaw;
        pose.pitchDeg = pitch;
        pose.rollDeg = roll;
        pose.distance = dist;
        pose.target = tgt;

        float yawRad = yaw * DEG_TO_RAD;
        float pitchRad = pitch * DEG_TO_RAD;

        float cp = std::cos(pitchRad);
        float sp = std::sin(pitchRad);
        float cy = std::cos(yawRad);
        float sy = std::sin(yawRad);

        // Spherical coordinates around target
        pose.position = tgt + Vec3(dist * cp * sy, dist * sp, dist * cp * cy);

        // Compute up vector accounting for roll
        Vec3 forward = (tgt - pose.position).normalized();
        Vec3 worldUp(0.0f, 1.0f, 0.0f);
        if (std::abs(forward.dot(worldUp)) > 0.99f) {
            worldUp = Vec3(0.0f, 0.0f, -1.0f);
        }
        Vec3 right = forward.cross(worldUp).normalized();
        Vec3 camUp = right.cross(forward).normalized();

        if (std::abs(roll) > 1e-4f) {
            float rollRad = roll * DEG_TO_RAD;
            float cr = std::cos(rollRad);
            float sr = std::sin(rollRad);
            pose.up = (camUp * cr + right * sr).normalized();
        } else {
            pose.up = camUp;
        }

        return pose;
    }

    // World to Camera transformation matrix (View Matrix)
    Mat4 getViewMatrix() const {
        Vec3 forward = (target - position).normalized();
        Vec3 right = forward.cross(up).normalized();
        Vec3 trueUp = right.cross(forward).normalized();

        Mat4 v = Mat4::identity();
        v.m[0] = right.x;     v.m[4] = right.y;     v.m[8]  = right.z;     v.m[12] = -right.dot(position);
        v.m[1] = trueUp.x;    v.m[5] = trueUp.y;    v.m[9]  = trueUp.z;    v.m[13] = -trueUp.dot(position);
        v.m[2] = -forward.x;  v.m[6] = -forward.y;  v.m[10] = -forward.z;  v.m[14] = forward.dot(position);
        v.m[3] = 0.0f;        v.m[7] = 0.0f;        v.m[11] = 0.0f;        v.m[15] = 1.0f;
        return v;
    }
};

// ============================================================================
// 2. Depth Map & Discontinuity Configuration
// ============================================================================

struct ReprojectionConfig {
    float edgeDiscontinuityThreshold{0.075f}; // Relative jump |Za - Zb| / max(Za, Zb)
    int guidedFilterRadius{2};                // Smoothing radius
    float guidedEpsilon{0.001f};              // Guided filter regularization
    float depthNear{0.8f};                    // Metres near
    float depthFar{8.0f};                     // Metres far
    int gridStep{1};                          // Pixel downsampling for mesh (1 = full res, 2 = half res)
    bool severEdges{true};                    // Enable discontinuity clipping
    float surfelScale{1.15f};                 // EWA surfel splat radius multiplier
};

struct ReprojectionOutput {
    ImageBuffer reprojectedRgba;
    ImageBuffer disocclusionMask;  // 255 = hole (requires inpainting), 0 = valid
    ImageBuffer normalBuffer;      // RGB normal map
    ScratchboxMesh mesh;
    int totalTriangles{0};
    int severedTriangles{0};
    float disocclusionPercent{0.0f};
    Mat4 viewMatrix;
};

// ============================================================================
// 3. Image & Depth Processing Algorithms
// ============================================================================

class CameraSpaceReprojector {
public:
    /**
     * Estimates a realistic pseudo-monocular depth map from luminance gradients
     * when an external depth map is not provided.
     */
    static ImageBuffer estimateDepthFromLuminance(const ImageBuffer& color, float nearD = 1.0f, float farD = 6.0f) {
        int w = color.width;
        int h = color.height;
        ImageBuffer depth(w, h, 1);

        for (int y = 0; y < h; ++y) {
            float vNorm = static_cast<float>(y) / static_cast<float>(h);
            float verticalDepth = std::lerp(nearD, farD, std::pow(1.0f - vNorm, 1.4f));

            for (int x = 0; x < w; ++x) {
                float lum = color.getLuminance(x, y);
                float nx = (static_cast<float>(x) / w) - 0.5f;
                float ny = (static_cast<float>(y) / h) - 0.5f;
                float radial = std::sqrt(nx * nx + ny * ny);

                float d = verticalDepth + (1.0f - lum) * 0.45f + radial * 0.35f;
                float clamped = std::clamp(d, nearD, farD);
                float normalized = (clamped - nearD) / (farD - nearD);

                size_t idx = static_cast<size_t>(y * w + x);
                depth.data[idx] = static_cast<uint8_t>(normalized * 255.0f + 0.5f);
            }
        }

        return depth;
    }

    /**
     * Color-Guided Depth Filtering (He et al., ECCV / TPAMI).
     * Snaps depth discontinuities strictly to high-contrast RGB edges while
     * eliminating quantization stair-stepping.
     */
    static ImageBuffer applyGuidedFilter(
        const ImageBuffer& depth,
        const ImageBuffer& guideColor,
        int radius,
        float eps = 0.002f
    ) {
        int w = depth.width;
        int h = depth.height;
        ImageBuffer filtered(w, h, 1);

        std::vector<float> I(w * h);
        std::vector<float> p(w * h);
        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                size_t idx = static_cast<size_t>(y * w + x);
                I[idx] = guideColor.getLuminance(x, y);
                p[idx] = static_cast<float>(depth.data[idx]) / 255.0f;
            }
        }

        auto boxFilter = [&](const std::vector<float>& src, int r) {
            std::vector<float> dst(w * h, 0.0f);
            for (int y = 0; y < h; ++y) {
                for (int x = 0; x < w; ++x) {
                    float sum = 0.0f;
                    int count = 0;
                    for (int dy = -r; dy <= r; ++dy) {
                        int ny = std::clamp(y + dy, 0, h - 1);
                        for (int dx = -r; dx <= r; ++dx) {
                            int nx = std::clamp(x + dx, 0, w - 1);
                            sum += src[ny * w + nx];
                            count++;
                        }
                    }
                    dst[y * w + x] = sum / static_cast<float>(count);
                }
            }
            return dst;
        };

        std::vector<float> mean_I = boxFilter(I, radius);
        std::vector<float> mean_p = boxFilter(p, radius);

        std::vector<float> II(w * h);
        std::vector<float> Ip(w * h);
        for (size_t i = 0; i < I.size(); ++i) {
            II[i] = I[i] * I[i];
            Ip[i] = I[i] * p[i];
        }

        std::vector<float> mean_II = boxFilter(II, radius);
        std::vector<float> mean_Ip = boxFilter(Ip, radius);

        std::vector<float> a(w * h);
        std::vector<float> b(w * h);
        for (size_t i = 0; i < I.size(); ++i) {
            float var_I = mean_II[i] - mean_I[i] * mean_I[i];
            float cov_Ip = mean_Ip[i] - mean_I[i] * mean_p[i];
            a[i] = cov_Ip / (var_I + eps);
            b[i] = mean_p[i] - a[i] * mean_I[i];
        }

        std::vector<float> mean_a = boxFilter(a, radius);
        std::vector<float> mean_b = boxFilter(b, radius);

        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                size_t idx = static_cast<size_t>(y * w + x);
                float q = mean_a[idx] * I[idx] + mean_b[idx];
                filtered.data[idx] = static_cast<uint8_t>(std::clamp(q, 0.0f, 1.0f) * 255.0f + 0.5f);
            }
        }

        return filtered;
    }

    /**
     * Computes surface normals via central difference tangent cross-products.
     */
    static Vec3 computeTangentNormal(
        int x, int y,
        const std::vector<Vec3>& points3D,
        int w, int h
    ) {
        int xPrev = std::max(0, x - 1);
        int xNext = std::min(w - 1, x + 1);
        int yPrev = std::max(0, y - 1);
        int yNext = std::min(h - 1, y + 1);

        const Vec3& pLeft = points3D[y * w + xPrev];
        const Vec3& pRight = points3D[y * w + xNext];
        const Vec3& pDown = points3D[yPrev * w + x];
        const Vec3& pUp = points3D[yNext * w + x];

        Vec3 tangentX = pRight - pLeft;
        Vec3 tangentY = pUp - pDown;

        Vec3 normal = tangentX.cross(tangentY).normalized();
        if (normal.lengthSq() < 1e-6f || std::isnan(normal.x)) {
            return {0.0f, 0.0f, 1.0f};
        }
        return normal;
    }

    /**
     * Main Camera Reprojection Engine.
     * Takes source image + depth, executes discontinuity-aware geometry severance,
     * reprojects to target camera pose, and renders dual buffers (reprojected RGB + disocclusion mask).
     */
    /**
     * Renders pre-unprojected 3D geometry into the target camera view.
     */
    static ReprojectionOutput renderUnprojectedGeometry(
        const ImageBuffer& sourceColor,
        const std::vector<Vec3>& points3D,
        const std::vector<float>& depths,
        int sw, int sh,
        const CameraPose& targetPose,
        const CameraIntrinsics& targetIntrinsics,
        const ReprojectionConfig& config
    ) {
        ReprojectionOutput output;
        int tw = targetIntrinsics.width;
        int th = targetIntrinsics.height;

        output.reprojectedRgba = ImageBuffer(tw, th, 4, 0);
        output.disocclusionMask = ImageBuffer(tw, th, 1, 255); // Default to hole (255)
        output.normalBuffer = ImageBuffer(tw, th, 3, 128);
        output.viewMatrix = targetPose.getViewMatrix();

        // Build Mesh with Discontinuity Severance
        output.mesh = ScratchboxMesh("camera_reprojected_mesh");
        output.mesh.material = PbrMaterial();
        output.mesh.material.roughnessFactor = 0.65f;
        output.mesh.material.metallicFactor = 0.05f;

        // Add Vertices
        int step = std::max(1, config.gridStep);
        std::vector<int> vertexIndices(sw * sh, -1);
        int vCount = 0;

        for (int y = 0; y < sh; y += step) {
            for (int x = 0; x < sw; x += step) {
                size_t idx = static_cast<size_t>(y * sw + x);
                const Vec3& pt = points3D[idx];
                Vec3 norm = computeTangentNormal(x, y, points3D, sw, sh);
                Vec3 col = sourceColor.getPixelRGB(x, y);

                Vertex vert;
                vert.position = pt;
                vert.normal = norm;
                vert.uv = Vec2(static_cast<float>(x) / sw, 1.0f - static_cast<float>(y) / sh);
                vert.color = Vec4(col.x, col.y, col.z, 1.0f);
                vert.tangent = Vec4(1.0f, 0.0f, 0.0f, 1.0f);

                output.mesh.addVertex(vert);
                vertexIndices[idx] = vCount++;
            }
        }

        // Add Triangles with Edge Discontinuity Check
        auto isEdgeSevered = [&](int idxA, int idxB) {
            if (!config.severEdges) return false;
            float zA = depths[idxA];
            float zB = depths[idxB];
            float maxZ = std::max(zA, zB);
            if (maxZ < 1e-4f) return false;
            float relDiff = std::abs(zA - zB) / maxZ;
            return relDiff > config.edgeDiscontinuityThreshold;
        };

        for (int y = 0; y < sh - step; y += step) {
            for (int x = 0; x < sw - step; x += step) {
                int i00 = y * sw + x;
                int i10 = y * sw + (x + step);
                int i01 = (y + step) * sw + x;
                int i11 = (y + step) * sw + (x + step);

                int v00 = vertexIndices[i00];
                int v10 = vertexIndices[i10];
                int v01 = vertexIndices[i01];
                int v11 = vertexIndices[i11];

                if (v00 < 0 || v10 < 0 || v01 < 0 || v11 < 0) continue;

                // Triangle 1: (v00, v01, v10)
                output.totalTriangles++;
                if (isEdgeSevered(i00, i01) || isEdgeSevered(i01, i10) || isEdgeSevered(i10, i00)) {
                    output.severedTriangles++;
                } else {
                    output.mesh.addTriangle(v00, v01, v10);
                }

                // Triangle 2: (v10, v01, v11)
                output.totalTriangles++;
                if (isEdgeSevered(i10, i01) || isEdgeSevered(i01, i11) || isEdgeSevered(i11, i10)) {
                    output.severedTriangles++;
                } else {
                    output.mesh.addTriangle(v10, v01, v11);
                }
            }
        }

        // 4. Software Z-Buffer Rasterization into Target Camera Sensor
        Mat4 viewMat = output.viewMatrix;
        std::vector<float> zBuffer(tw * th, 1e9f);
        int renderedPixels = 0;

        // Transform vertices to Target Camera Space
        std::vector<Vec3> camSpaceVerts(output.mesh.vertices.size());
        std::vector<Vec2> screenVerts(output.mesh.vertices.size());
        std::vector<bool> validVerts(output.mesh.vertices.size());

        for (size_t i = 0; i < output.mesh.vertices.size(); ++i) {
            Vec3 worldP = output.mesh.vertices[i].position;
            Vec3 camP = viewMat.transformPoint(worldP);
            camSpaceVerts[i] = camP;

            float u, v, z;
            if (targetIntrinsics.project(camP, u, v, z)) {
                screenVerts[i] = Vec2(u, v);
                validVerts[i] = true;
            } else {
                validVerts[i] = false;
            }
        }

        // Rasterize triangles
        auto edgeFunction = [](const Vec2& a, const Vec2& b, const Vec2& c) {
            return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
        };

        for (size_t t = 0; t + 2 < output.mesh.indices.size(); t += 3) {
            uint32_t i0 = output.mesh.indices[t];
            uint32_t i1 = output.mesh.indices[t + 1];
            uint32_t i2 = output.mesh.indices[t + 2];

            if (!validVerts[i0] || !validVerts[i1] || !validVerts[i2]) continue;

            const Vec2& v0 = screenVerts[i0];
            const Vec2& v1 = screenVerts[i1];
            const Vec2& v2 = screenVerts[i2];

            float area = edgeFunction(v0, v1, v2);
            if (area <= 0.0f) continue; // Back-face or degenerate

            int minX = std::max(0, static_cast<int>(std::floor(std::min({v0.x, v1.x, v2.x}))));
            int maxX = std::min(tw - 1, static_cast<int>(std::ceil(std::max({v0.x, v1.x, v2.x}))));
            int minY = std::max(0, static_cast<int>(std::floor(std::min({v0.y, v1.y, v2.y}))));
            int maxY = std::min(th - 1, static_cast<int>(std::ceil(std::max({v0.y, v1.y, v2.y}))));

            float z0 = -camSpaceVerts[i0].z;
            float z1 = -camSpaceVerts[i1].z;
            float z2 = -camSpaceVerts[i2].z;

            const Vec4& col0 = output.mesh.vertices[i0].color;
            const Vec4& col1 = output.mesh.vertices[i1].color;
            const Vec4& col2 = output.mesh.vertices[i2].color;

            Vec3 n0 = viewMat.transformDirection(output.mesh.vertices[i0].normal).normalized();
            Vec3 n1 = viewMat.transformDirection(output.mesh.vertices[i1].normal).normalized();
            Vec3 n2 = viewMat.transformDirection(output.mesh.vertices[i2].normal).normalized();

            for (int py = minY; py <= maxY; ++py) {
                for (int px = minX; px <= maxX; ++px) {
                    Vec2 p(static_cast<float>(px) + 0.5f, static_cast<float>(py) + 0.5f);
                    float w0 = edgeFunction(v1, v2, p);
                    float w1 = edgeFunction(v2, v0, p);
                    float w2 = edgeFunction(v0, v1, p);

                    if (w0 >= 0.0f && w1 >= 0.0f && w2 >= 0.0f) {
                        w0 /= area;
                        w1 /= area;
                        w2 /= area;

                        // Perspective-correct depth interpolation
                        float z = 1.0f / (w0 / z0 + w1 / z1 + w2 / z2);
                        size_t pIdx = static_cast<size_t>(py * tw + px);

                        if (z < zBuffer[pIdx]) {
                            zBuffer[pIdx] = z;

                            // Interpolate Color
                            Vec3 col = (Vec3(col0.x, col0.y, col0.z) * w0 +
                                        Vec3(col1.x, col1.y, col1.z) * w1 +
                                        Vec3(col2.x, col2.y, col2.z) * w2);

                            // Interpolate Normal
                            Vec3 norm = (n0 * w0 + n1 * w1 + n2 * w2).normalized();

                            // Write RGBA
                            size_t cIdx = pIdx * 4;
                            output.reprojectedRgba.data[cIdx] = static_cast<uint8_t>(std::clamp(col.x, 0.0f, 1.0f) * 255.0f);
                            output.reprojectedRgba.data[cIdx + 1] = static_cast<uint8_t>(std::clamp(col.y, 0.0f, 1.0f) * 255.0f);
                            output.reprojectedRgba.data[cIdx + 2] = static_cast<uint8_t>(std::clamp(col.z, 0.0f, 1.0f) * 255.0f);
                            output.reprojectedRgba.data[cIdx + 3] = 255;

                            // Mark Disocclusion Mask as Visible (0 = non-hole)
                            output.disocclusionMask.data[pIdx] = 0;

                            // Write Normal Map
                            size_t nIdx = pIdx * 3;
                            output.normalBuffer.data[nIdx] = static_cast<uint8_t>((norm.x * 0.5f + 0.5f) * 255.0f);
                            output.normalBuffer.data[nIdx + 1] = static_cast<uint8_t>((norm.y * 0.5f + 0.5f) * 255.0f);
                            output.normalBuffer.data[nIdx + 2] = static_cast<uint8_t>((norm.z * 0.5f + 0.5f) * 255.0f);

                            renderedPixels++;
                        }
                    }
                }
            }
        }

        // Calculate disocclusion hole percentage
        int totalTargetPixels = tw * th;
        int holes = 0;
        for (int i = 0; i < totalTargetPixels; ++i) {
            if (output.disocclusionMask.data[i] > 0) {
                holes++;
            }
        }
        output.disocclusionPercent = (static_cast<float>(holes) / static_cast<float>(totalTargetPixels)) * 100.0f;

        return output;
    }

    /**
     * Standard Camera Reprojection Engine using pinhole intrinsics unprojection.
     */
    static ReprojectionOutput reproject(
        const ImageBuffer& sourceColor,
        const ImageBuffer& sourceDepth,
        const CameraPose& targetPose,
        const CameraIntrinsics& sourceIntrinsics,
        const CameraIntrinsics& targetIntrinsics,
        const ReprojectionConfig& config
    ) {
        int sw = sourceColor.width;
        int sh = sourceColor.height;

        ImageBuffer cleanDepth = sourceDepth;
        if (config.guidedFilterRadius > 0) {
            cleanDepth = applyGuidedFilter(sourceDepth, sourceColor, config.guidedFilterRadius, config.guidedEpsilon);
        }

        std::vector<Vec3> points3D(sw * sh);
        std::vector<float> depths(sw * sh);

        for (int y = 0; y < sh; ++y) {
            for (int x = 0; x < sw; ++x) {
                size_t idx = static_cast<size_t>(y * sw + x);
                float normD = static_cast<float>(cleanDepth.data[idx]) / 255.0f;
                float z = std::lerp(config.depthNear, config.depthFar, normD);
                depths[idx] = z;
                points3D[idx] = sourceIntrinsics.unproject(static_cast<float>(x), static_cast<float>(y), z);
            }
        }

        return renderUnprojectedGeometry(sourceColor, points3D, depths, sw, sh, targetPose, targetIntrinsics, config);
    }

    /**
     * DepthBox Reprojection Engine using direct Depth-Ray field: P = d(u,v) * r(u,v).
     * Bypasses pinhole camera matrix requirements; unprojects along exact predicted rays.
     */
    static ReprojectionOutput reprojectWithRayMap(
        const ImageBuffer& sourceColor,
        const std::vector<float>& metricDepths,
        const std::vector<float>& rayMap,
        const CameraPose& targetPose,
        const CameraIntrinsics& targetIntrinsics,
        const ReprojectionConfig& config
    ) {
        int sw = sourceColor.width;
        int sh = sourceColor.height;

        std::vector<Vec3> points3D(sw * sh);
        std::vector<float> depths(sw * sh);

        for (int y = 0; y < sh; ++y) {
            for (int x = 0; x < sw; ++x) {
                size_t idx = static_cast<size_t>(y * sw + x);
                float z = (idx < metricDepths.size()) ? metricDepths[idx] : config.depthNear;
                depths[idx] = z;
                size_t rIdx = 3 * idx;
                if (rIdx + 2 < rayMap.size()) {
                    points3D[idx] = Vec3(rayMap[rIdx] * z, rayMap[rIdx + 1] * z, rayMap[rIdx + 2] * z);
                } else {
                    points3D[idx] = Vec3(0.0f, 0.0f, z);
                }
            }
        }

        return renderUnprojectedGeometry(sourceColor, points3D, depths, sw, sh, targetPose, targetIntrinsics, config);
    }
};

// ============================================================================
// 6. COLMAP / GLOMAP Multi-View Epipolar Warper
// ============================================================================
/**
 * Warps secondary registered camera views into the primary camera's disocclusion
 * holes before triggering generative inpainting.
 * When multiple images are registered via GLOMAP / COLMAP, any surface visible in
 * Camera B that was occluded in Camera A is back-projected through depth Z
 * and reprojected into Camera A's screen space, eliminating generative uncertainty.
 */
struct MultiViewWarpResult {
    ImageBuffer infilledRgba;
    ImageBuffer residualMask;
    float multiViewRecoveredPercent{0.0f};
    float remainingDisocclusionPercent{0.0f};
    int pixelsRecovered{0};
};

class MultiViewWarper {
public:
    static MultiViewWarpResult warpEpipolar(
        const ImageBuffer& primaryRgba,
        const ImageBuffer& primaryDisocclusionMask,
        const std::vector<float>& depthBuffer,
        const CameraIntrinsics& kPrimary,
        const Mat4& primaryViewMat,
        const ImageBuffer& secondaryRgba,
        const CameraIntrinsics& kSecondary,
        const Mat4& secondaryViewMat
    ) {
        int w = primaryRgba.width;
        int h = primaryRgba.height;
        MultiViewWarpResult res;
        res.infilledRgba = primaryRgba;
        res.residualMask = primaryDisocclusionMask;

        Mat4 invPrimaryView = primaryViewMat.inverseRigid();
        int initialHoles = 0;
        int recovered = 0;

        for (int y = 0; y < h; ++y) {
            for (int x = 0; x < w; ++x) {
                size_t pIdx = static_cast<size_t>(y * w + x);
                if (primaryDisocclusionMask.data[pIdx] == 0) continue; // Already valid
                initialHoles++;

                float z = (pIdx < depthBuffer.size()) ? depthBuffer[pIdx] : 0.0f;
                if (z <= 0.01f || z >= 999.0f) continue;

                // 1. Unproject primary pixel to camera space
                Vec3 pCam = kPrimary.unproject(static_cast<float>(x), static_cast<float>(y), z);
                // 2. Transform to world space
                Vec3 pWorld = invPrimaryView.transformPoint(pCam);
                // 3. Transform to secondary camera space
                Vec3 pSecCam = secondaryViewMat.transformPoint(pWorld);

                // 4. Project into secondary camera screen
                float uSec, vSec, zSec;
                if (kSecondary.project(pSecCam, uSec, vSec, zSec)) {
                    int secX = static_cast<int>(std::round(uSec));
                    int secY = static_cast<int>(std::round(vSec));

                    if (secX >= 0 && secX < secondaryRgba.width && secY >= 0 && secY < secondaryRgba.height) {
                        size_t sIdx = static_cast<size_t>(secY * secondaryRgba.width + secX) * 4;
                        size_t dIdx = pIdx * 4;

                        res.infilledRgba.data[dIdx] = secondaryRgba.data[sIdx];
                        res.infilledRgba.data[dIdx + 1] = secondaryRgba.data[sIdx + 1];
                        res.infilledRgba.data[dIdx + 2] = secondaryRgba.data[sIdx + 2];
                        res.infilledRgba.data[dIdx + 3] = 255;

                        // Mark pixel as recovered by multi-view geometry
                        res.residualMask.data[pIdx] = 0;
                        recovered++;
                    }
                }
            }
        }

        res.pixelsRecovered = recovered;
        res.multiViewRecoveredPercent = initialHoles > 0 ? (static_cast<float>(recovered) / static_cast<float>(initialHoles)) * 100.0f : 0.0f;
        int remaining = initialHoles - recovered;
        res.remainingDisocclusionPercent = (static_cast<float>(remaining) / static_cast<float>(w * h)) * 100.0f;
        return res;
    }
};

} // namespace reprojector
} // namespace scratchbox

#endif // SCRATCHBOX_CAMERA_REPROJECTOR_HPP
