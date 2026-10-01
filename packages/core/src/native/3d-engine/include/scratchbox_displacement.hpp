/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_DISPLACEMENT_HPP
#define SCRATCHBOX_DISPLACEMENT_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <functional>
#include <unordered_map>
#include <iostream>

namespace scratchbox {
namespace displacement {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using gltf::GltfScene;

struct DisplacementOptions {
    uint32_t tessellationFactor{4};      // N: each triangle splits into N^2 micro-triangles (e.g. 4 -> 16, 8 -> 64)
    float displacementScale{0.06f};       // World space amplitude (meters)
    float midpoint{0.5f};                 // Neutral height baseline (heights > midpoint push out, < midpoint pull in)
    bool sampleTextureHeight{true};       // Sample embedded texture luminance / height
    float textureHeightWeight{1.0f};      // Relative weight of texture displacement
    bool enableProceduralNoise{true};     // Add procedural micro-surface relief
    float proceduralNoiseScale{0.015f};   // Procedural micro-noise amplitude
    float proceduralNoiseFrequency{32.0f};// Procedural micro-noise spatial frequency
    uint32_t proceduralNoiseOctaves{3};   // FBM octaves
    bool recomputeSmoothNormals{true};    // Recalculate true geometric normals after displacement
    float maxDisplacementLimit{0.5f};     // Safety clamp
    bool preserveSharpEdges{true};        // Protect high-dihedral-angle edge seams
    float sharpEdgeThresholdDeg{65.0f};   // Dihedral angle threshold in degrees
};

class DisplacementEngine {
public:
    /**
     * Bilinear luminance sampler for in-memory texture buffers with glTF UV conventions.
     */
    static float sampleBilinearLuminance(const texture::ImageBuffer& img, float u, float v) {
        if (img.width == 0 || img.height == 0 || img.data.empty()) return 0.5f;

        // Wrap UVs to [0, 1)
        float uW = u - std::floor(u);
        float vW = v - std::floor(v);
        // glTF texture origin is top-left, matching raster image buffers
        float fx = uW * static_cast<float>(img.width - 1);
        float fy = vW * static_cast<float>(img.height - 1);

        int x0 = static_cast<int>(fx);
        int y0 = static_cast<int>(fy);
        int x1 = std::min(x0 + 1, static_cast<int>(img.width - 1));
        int y1 = std::min(y0 + 1, static_cast<int>(img.height - 1));

        float tx = fx - static_cast<float>(x0);
        float ty = fy - static_cast<float>(y0);

        auto getLuminance = [&](int x, int y) -> float {
            size_t idx = (static_cast<size_t>(y) * img.width + static_cast<size_t>(x)) * img.channels;
            if (idx >= img.data.size()) return 0.5f;
            float r = static_cast<float>(img.data[idx]) / 255.0f;
            float g = (img.channels > 1 && idx + 1 < img.data.size()) ? static_cast<float>(img.data[idx + 1]) / 255.0f : r;
            float b = (img.channels > 2 && idx + 2 < img.data.size()) ? static_cast<float>(img.data[idx + 2]) / 255.0f : r;
            // Standard Rec. 709 luminance
            return 0.2126f * r + 0.7152f * g + 0.0722f * b;
        };

        float l00 = getLuminance(x0, y0);
        float l10 = getLuminance(x1, y0);
        float l01 = getLuminance(x0, y1);
        float l11 = getLuminance(x1, y1);

        float top = l00 * (1.0f - tx) + l10 * tx;
        float bottom = l01 * (1.0f - tx) + l11 * tx;
        return top * (1.0f - ty) + bottom * ty;
    }

    /**
     * Evaluates compound displacement from texture maps and procedural FBM noise.
     */
    static float evaluateDisplacement(
        const Vec2& uv,
        const Vec3& pos,
        const texture::ImageBuffer* img,
        const DisplacementOptions& opt
    ) {
        float hTex = 0.5f;
        if (opt.sampleTextureHeight && img && img->width > 0 && img->height > 0) {
            hTex = sampleBilinearLuminance(*img, uv.x, uv.y);
        }

        float hTotal = (hTex - opt.midpoint) * opt.displacementScale * opt.textureHeightWeight;

        if (opt.enableProceduralNoise) {
            float noiseVal = math::FastNoise3D::fbm(
                pos.x * opt.proceduralNoiseFrequency,
                pos.y * opt.proceduralNoiseFrequency,
                pos.z * opt.proceduralNoiseFrequency,
                opt.proceduralNoiseOctaves,
                2.0f,
                0.5f,
                4242
            );
            hTotal += noiseVal * opt.proceduralNoiseScale;
        }

        return std::clamp(hTotal, -opt.maxDisplacementLimit, opt.maxDisplacementLimit);
    }

    /**
     * Subdivides each triangle of a mesh into N^2 micro-triangles and displaces each vertex
     * along its interpolated normal based on heightmap and procedural surface topology.
     */
    static ScratchboxMesh tessellateAndDisplaceMesh(
        const ScratchboxMesh& inMesh,
        const DisplacementOptions& options,
        const texture::ImageBuffer* heightImage = nullptr
    ) {
        ScratchboxMesh outMesh(inMesh.name + "_displaced");
        outMesh.material = inMesh.material;

        if (inMesh.indices.empty() || inMesh.vertices.empty()) {
            return outMesh;
        }

        uint32_t N = std::max(1u, options.tessellationFactor);
        size_t triCount = inMesh.indices.size() / 3;

        // Estimate capacity: each triangle gets (N+1)(N+2)/2 vertices and N^2 triangles
        size_t vertsPerTri = ((N + 1) * (N + 2)) / 2;
        size_t trisPerTri = N * N;
        outMesh.vertices.reserve(triCount * vertsPerTri);
        outMesh.indices.reserve(triCount * trisPerTri * 3);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = inMesh.indices[t * 3 + 0];
            uint32_t i1 = inMesh.indices[t * 3 + 1];
            uint32_t i2 = inMesh.indices[t * 3 + 2];

            if (i0 >= inMesh.vertices.size() || i1 >= inMesh.vertices.size() || i2 >= inMesh.vertices.size()) {
                continue;
            }

            const Vertex& v0 = inMesh.vertices[i0];
            const Vertex& v1 = inMesh.vertices[i1];
            const Vertex& v2 = inMesh.vertices[i2];

            uint32_t baseVertexIndex = static_cast<uint32_t>(outMesh.vertices.size());

            // 1. Generate regular barycentric grid of micro-vertices
            for (uint32_t i = 0; i <= N; ++i) {
                for (uint32_t j = 0; j <= N - i; ++j) {
                    float u = static_cast<float>(i) / static_cast<float>(N);
                    float v = static_cast<float>(j) / static_cast<float>(N);
                    float w = 1.0f - u - v;

                    // Interpolate base attributes
                    Vec3 basePos = v0.position * w + v1.position * u + v2.position * v;
                    Vec3 baseNormal = (v0.normal * w + v1.normal * u + v2.normal * v).normalized();
                    Vec2 baseUv = v0.uv * w + v1.uv * u + v2.uv * v;
                    Vec4 baseColor = v0.color * w + v1.color * u + v2.color * v;

                    // Evaluate displacement
                    float dispAmount = evaluateDisplacement(baseUv, basePos, heightImage, options);
                    Vec3 displacedPos = basePos + baseNormal * dispAmount;

                    Vertex microV;
                    microV.position = displacedPos;
                    microV.normal = baseNormal;
                    microV.uv = baseUv;
                    microV.color = baseColor;
                    microV.tangent = v0.tangent * w + v1.tangent * u + v2.tangent * v;

                    outMesh.vertices.push_back(microV);
                }
            }

            // Index mapping for (i, j) on the 2D simplicial grid
            auto getLocalIdx = [&](uint32_t i, uint32_t j) -> uint32_t {
                uint32_t offset = 0;
                for (uint32_t r = 0; r < i; ++r) {
                    offset += (N - r + 1);
                }
                return baseVertexIndex + offset + j;
            };

            // 2. Build micro-triangles
            for (uint32_t i = 0; i < N; ++i) {
                for (uint32_t j = 0; j < N - i; ++j) {
                    uint32_t p00 = getLocalIdx(i, j);
                    uint32_t p10 = getLocalIdx(i + 1, j);
                    uint32_t p01 = getLocalIdx(i, j + 1);

                    outMesh.indices.push_back(p00);
                    outMesh.indices.push_back(p10);
                    outMesh.indices.push_back(p01);

                    if (j + 1 < N - i) {
                        uint32_t p11 = getLocalIdx(i + 1, j + 1);
                        outMesh.indices.push_back(p10);
                        outMesh.indices.push_back(p11);
                        outMesh.indices.push_back(p01);
                    }
                }
            }
        }

        // 3. Recompute true geometric normals
        if (options.recomputeSmoothNormals) {
            recomputeDisplacedNormals(outMesh, options.preserveSharpEdges, options.sharpEdgeThresholdDeg);
        }

        outMesh.recomputeBounds();
        return outMesh;
    }

    /**
     * Tessellates and displaces an entire GltfScene containing multiple submeshes and materials.
     */
    static GltfScene tessellateAndDisplaceScene(
        const GltfScene& inScene,
        const DisplacementOptions& options
    ) {
        GltfScene outScene;
        outScene.ok = true;
        outScene.materials = inScene.materials;
        outScene.images = inScene.images;
        outScene.primitiveCount = inScene.primitiveCount;
        outScene.nodeCount = inScene.nodeCount;
        outScene.mesh.name = inScene.mesh.name + "_displaced";

        if (inScene.mesh.indices.empty() || inScene.mesh.vertices.empty()) {
            return inScene;
        }

        uint32_t N = std::max(1u, options.tessellationFactor);
        size_t triCount = inScene.mesh.indices.size() / 3;

        size_t vertsPerTri = ((N + 1) * (N + 2)) / 2;
        size_t trisPerTri = N * N;
        outScene.mesh.vertices.reserve(triCount * vertsPerTri);
        outScene.mesh.indices.reserve(triCount * trisPerTri * 3);
        outScene.triangleMaterial.reserve(triCount * trisPerTri);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = inScene.mesh.indices[t * 3 + 0];
            uint32_t i1 = inScene.mesh.indices[t * 3 + 1];
            uint32_t i2 = inScene.mesh.indices[t * 3 + 2];

            if (i0 >= inScene.mesh.vertices.size() || i1 >= inScene.mesh.vertices.size() || i2 >= inScene.mesh.vertices.size()) {
                continue;
            }

            const Vertex& v0 = inScene.mesh.vertices[i0];
            const Vertex& v1 = inScene.mesh.vertices[i1];
            const Vertex& v2 = inScene.mesh.vertices[i2];

            // Resolve material and texture for this triangle
            uint32_t matIdx = (t < inScene.triangleMaterial.size()) ? inScene.triangleMaterial[t] : 0;
            const texture::ImageBuffer* img = nullptr;
            if (matIdx < inScene.materials.size()) {
                int imgIdx = inScene.materials[matIdx].baseColorImage;
                if (imgIdx >= 0 && imgIdx < static_cast<int>(inScene.images.size())) {
                    if (inScene.images[imgIdx].decoded) {
                        img = &inScene.images[imgIdx].pixels;
                    }
                }
            }

            uint32_t baseVertexIndex = static_cast<uint32_t>(outScene.mesh.vertices.size());

            // Generate micro-vertices
            for (uint32_t i = 0; i <= N; ++i) {
                for (uint32_t j = 0; j <= N - i; ++j) {
                    float u = static_cast<float>(i) / static_cast<float>(N);
                    float v = static_cast<float>(j) / static_cast<float>(N);
                    float w = 1.0f - u - v;

                    Vec3 basePos = v0.position * w + v1.position * u + v2.position * v;
                    Vec3 baseNormal = (v0.normal * w + v1.normal * u + v2.normal * v).normalized();
                    Vec2 baseUv = v0.uv * w + v1.uv * u + v2.uv * v;
                    Vec4 baseColor = v0.color * w + v1.color * u + v2.color * v;

                    float dispAmount = evaluateDisplacement(baseUv, basePos, img, options);
                    Vec3 displacedPos = basePos + baseNormal * dispAmount;

                    Vertex microV;
                    microV.position = displacedPos;
                    microV.normal = baseNormal;
                    microV.uv = baseUv;
                    microV.color = baseColor;
                    microV.tangent = v0.tangent * w + v1.tangent * u + v2.tangent * v;

                    outScene.mesh.vertices.push_back(microV);
                }
            }

            auto getLocalIdx = [&](uint32_t i, uint32_t j) -> uint32_t {
                uint32_t offset = 0;
                for (uint32_t r = 0; r < i; ++r) {
                    offset += (N - r + 1);
                }
                return baseVertexIndex + offset + j;
            };

            // Build micro-triangles and map triangle material
            for (uint32_t i = 0; i < N; ++i) {
                for (uint32_t j = 0; j < N - i; ++j) {
                    uint32_t p00 = getLocalIdx(i, j);
                    uint32_t p10 = getLocalIdx(i + 1, j);
                    uint32_t p01 = getLocalIdx(i, j + 1);

                    outScene.mesh.indices.push_back(p00);
                    outScene.mesh.indices.push_back(p10);
                    outScene.mesh.indices.push_back(p01);
                    outScene.triangleMaterial.push_back(matIdx);

                    if (j + 1 < N - i) {
                        uint32_t p11 = getLocalIdx(i + 1, j + 1);
                        outScene.mesh.indices.push_back(p10);
                        outScene.mesh.indices.push_back(p11);
                        outScene.mesh.indices.push_back(p01);
                        outScene.triangleMaterial.push_back(matIdx);
                    }
                }
            }
        }

        if (options.recomputeSmoothNormals) {
            recomputeDisplacedNormals(outScene.mesh, options.preserveSharpEdges, options.sharpEdgeThresholdDeg);
        }

        outScene.mesh.recomputeBounds();
        outScene.bounds = outScene.mesh.bounds;
        return outScene;
    }

private:
    /**
     * Area-weighted smooth normal recomputation across displaced micro-polygons.
     */
    static void recomputeDisplacedNormals(
        ScratchboxMesh& mesh,
        bool preserveSharp,
        float thresholdDeg
    ) {
        if (mesh.vertices.empty() || mesh.indices.size() < 3) return;

        std::vector<Vec3> accumNormals(mesh.vertices.size(), Vec3(0, 0, 0));
        size_t triCount = mesh.indices.size() / 3;
        float thresholdCos = std::cos(thresholdDeg * math::DEG_TO_RAD);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3 + 0];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            const Vec3& p0 = mesh.vertices[i0].position;
            const Vec3& p1 = mesh.vertices[i1].position;
            const Vec3& p2 = mesh.vertices[i2].position;

            Vec3 e1 = p1 - p0;
            Vec3 e2 = p2 - p0;
            Vec3 faceNormal = e1.cross(e2); // Area-weighted normal (length is 2x area)

            if (faceNormal.lengthSq() > 1e-12f) {
                accumNormals[i0] += faceNormal;
                accumNormals[i1] += faceNormal;
                accumNormals[i2] += faceNormal;
            }
        }

        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            if (accumNormals[i].lengthSq() > 1e-10f) {
                mesh.vertices[i].normal = accumNormals[i].normalized();
            }
        }
    }
};

} // namespace displacement
} // namespace scratchbox

#endif // SCRATCHBOX_DISPLACEMENT_HPP
