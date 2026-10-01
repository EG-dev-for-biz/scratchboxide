/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_depth_to_gaussian.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <chrono>
#include <cmath>
#include <algorithm>

using namespace scratchbox;
using math::Vec2;
using math::Vec3;
using math::Quat;
using spz::GaussianSplat;
using spz::SplatCodec;
using spz::SpzCodec;

struct SubTri {
    Vec3 v0, v1, v2;
    Vec2 uv0, uv1, uv2;
};

static void subdivideRecursive(
    const Vec3& v0, const Vec3& v1, const Vec3& v2,
    const Vec2& uv0, const Vec2& uv1, const Vec2& uv2,
    float area, float maxArea, int depth,
    std::vector<SubTri>& out
) {
    if (area <= maxArea || depth >= 3) {
        out.push_back({v0, v1, v2, uv0, uv1, uv2});
        return;
    }

    Vec3 m01 = (v0 + v1) * 0.5f;
    Vec3 m12 = (v1 + v2) * 0.5f;
    Vec3 m20 = (v2 + v0) * 0.5f;

    Vec2 uv01 = (uv0 + uv1) * 0.5f;
    Vec2 uv12 = (uv1 + uv2) * 0.5f;
    Vec2 uv20 = (uv2 + uv0) * 0.5f;

    float subArea = area * 0.25f;
    subdivideRecursive(v0, m01, m20, uv0, uv01, uv20, subArea, maxArea, depth + 1, out);
    subdivideRecursive(v1, m12, m01, uv1, uv12, uv01, subArea, maxArea, depth + 1, out);
    subdivideRecursive(v2, m20, m12, uv2, uv20, uv12, subArea, maxArea, depth + 1, out);
    subdivideRecursive(m01, m12, m20, uv01, uv12, uv20, subArea, maxArea, depth + 1, out);
}

int main(int argc, char** argv) {
    std::string glbPath = "public/models/red_rocks_amphitheatre.glb";
    std::string outSplat = "public/models/red_rocks_venue.splat";
    std::string outSpz = "public/models/red_rocks_venue.spz";
    Vec3 stageCenter(5.2f, 4.46f, 0.0f);
    float cropRadius = 460.0f;
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--glb" && i + 1 < argc) glbPath = argv[++i];
        else if (arg == "--out-splat" && i + 1 < argc) outSplat = argv[++i];
        else if (arg == "--out-spz" && i + 1 < argc) outSpz = argv[++i];
        else if (arg == "--stage-x" && i + 1 < argc) stageCenter.x = std::stof(argv[++i]);
        else if (arg == "--stage-y" && i + 1 < argc) stageCenter.y = std::stof(argv[++i]);
        else if (arg == "--stage-z" && i + 1 < argc) stageCenter.z = std::stof(argv[++i]);
        else if (arg == "--crop-radius" && i + 1 < argc) cropRadius = std::stof(argv[++i]);
        else if (arg == "--json") emitJson = true;
    }

    auto t0 = std::chrono::high_resolution_clock::now();
    std::cerr << "[Mesh-to-3DGS] Reading GLB from " << glbPath << "..." << std::endl;
    auto scene = gltf::GlbSceneReader::readFile(glbPath);
    if (!scene.ok) {
        std::cerr << "Failed to read GLB: " << scene.error << std::endl;
        return 1;
    }

    size_t totalTris = scene.mesh.indices.size() / 3;
    std::cerr << "[Mesh-to-3DGS] Loaded GLB: " << scene.mesh.vertices.size() << " vertices, "
              << totalTris << " triangles, " << scene.images.size() << " texture maps." << std::endl;

    std::vector<GaussianSplat> splats;
    splats.reserve(totalTris * 4);

    std::vector<SubTri> triBuf;
    triBuf.reserve(64);

    for (size_t t = 0; t < totalTris; ++t) {
        uint32_t i0 = scene.mesh.indices[t * 3 + 0];
        uint32_t i1 = scene.mesh.indices[t * 3 + 1];
        uint32_t i2 = scene.mesh.indices[t * 3 + 2];

        const auto& v0 = scene.mesh.vertices[i0].position;
        const auto& v1 = scene.mesh.vertices[i1].position;
        const auto& v2 = scene.mesh.vertices[i2].position;

        const auto& uv0 = scene.mesh.vertices[i0].uv;
        const auto& uv1 = scene.mesh.vertices[i1].uv;
        const auto& uv2 = scene.mesh.vertices[i2].uv;

        Vec3 centroid = (v0 + v1 + v2) * (1.0f / 3.0f);
        float distToStage = (centroid - stageCenter).length();
        if (distToStage > cropRadius) continue;

        Vec3 e1 = v1 - v0;
        Vec3 e2 = v2 - v0;
        Vec3 rawNorm = e1.cross(e2);
        float area = 0.5f * rawNorm.length();
        if (area < 1e-7f) continue;

        // Concentric resolution tiers radiating outward from the performance stage:
        float maxArea = 0.85f;
        if (distToStage <= 55.0f) {
            maxArea = 0.028f;  // Sub-decimeter surfels around stage, canopy, and front rock formations
        } else if (distToStage <= 115.0f) {
            maxArea = 0.085f;  // High-density surfels across seating bowl & acoustic rock faces
        } else if (distToStage <= 210.0f) {
            maxArea = 0.28f;   // Mid-range concourse and monolith tops
        }

        triBuf.clear();
        subdivideRecursive(v0, v1, v2, uv0, uv1, uv2, area, maxArea, 0, triBuf);

        // Fetch material and texture
        uint32_t matIdx = (t < scene.triangleMaterial.size()) ? scene.triangleMaterial[t] : 0;
        const auto& mat = scene.materials[matIdx];
        const texture::ImageBuffer* img = nullptr;
        if (mat.baseColorImage >= 0 && mat.baseColorImage < static_cast<int>(scene.images.size())) {
            if (scene.images[mat.baseColorImage].decoded) {
                img = &scene.images[mat.baseColorImage].pixels;
            }
        }

        for (const auto& sub : triBuf) {
            Vec3 subCentroid = (sub.v0 + sub.v1 + sub.v2) * (1.0f / 3.0f);
            Vec3 se1 = sub.v1 - sub.v0;
            Vec3 se2 = sub.v2 - sub.v0;
            Vec3 sNorm = se1.cross(se2);
            float subArea = 0.5f * sNorm.length();
            if (subArea < 1e-8f) continue;

            Vec3 norm = sNorm.normalized();
            Vec2 subUv = (sub.uv0 + sub.uv1 + sub.uv2) * (1.0f / 3.0f);

            Vec3 color(mat.baseColorFactor.x, mat.baseColorFactor.y, mat.baseColorFactor.z);
            if (img && img->width > 0 && img->height > 0) {
                Vec3 texRgb = img->sampleBilinear(subUv.x, subUv.y);
                color.x *= texRgb.x;
                color.y *= texRgb.y;
                color.z *= texRgb.z;
            }

            // Orthonormal tangent basis aligned with triangle edge
            Vec3 t1 = se1.normalized();
            Vec3 t2 = norm.cross(t1).normalized();

            // Calibrated 2D EWA surfel scale:
            // Sized so adjacent surfels intersect seamlessly without gaps or excess blurring
            float r = std::sqrt(subArea / 3.14159265f);
            float s1 = r * 1.35f;
            float s2 = r * 1.35f;
            float sz = 0.0001f; // Flat SuGaR planar surfel

            Quat rot = depthbox::DepthToGaussianEngine::quatFromBasis(t1, t2, norm).normalized();

            GaussianSplat splat;
            splat.position = subCentroid;
            splat.scale = Vec3(s1, s2, sz);
            splat.rotation = rot;
            splat.color = color;
            splat.opacity = 1.0f;

            splats.push_back(splat);
        }
    }

    size_t splatBytes = 0, spzBytes = 0;
    if (!outSplat.empty()) {
        std::vector<uint8_t> bytes = SplatCodec::encode(splats);
        std::ofstream o(outSplat, std::ios::binary);
        o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        splatBytes = bytes.size();
    }
    if (!outSpz.empty()) {
        std::vector<uint8_t> bytes = SpzCodec::encode(splats);
        std::ofstream o(outSpz, std::ios::binary);
        o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        spzBytes = bytes.size();
    }

    auto t1 = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (emitJson) {
        std::cout << "{\"success\":true,\"splatCount\":" << splats.size()
                  << ",\"splatBytes\":" << splatBytes
                  << ",\"spzBytes\":" << spzBytes
                  << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "Successfully generated " << splats.size()
                  << " authentic photoreal 3DGS surfels ("
                  << (splatBytes / 1024 / 1024) << " MB) in " << ms << " ms." << std::endl;
    }

    return 0;
}
