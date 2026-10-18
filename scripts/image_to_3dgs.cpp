/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_depth_to_gaussian.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>

using namespace scratchbox;
using namespace scratchbox::depthbox;
using namespace scratchbox::spz;

int main(int argc, char** argv) {
    std::string outSplatPath = "public/models/image_to_3dgs_test.splat";
    std::string outColliderPath = "";
    uint32_t width = 640;
    uint32_t height = 480;
    float fov = 65.0f;
    uint32_t stride = 1;
    float edgeTau = 0.08f;
    bool enableInpaint = false;
    std::string sceneType = "architectural_facade"; // or "multi_view_corner"

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--out-splat" || arg == "--out") && i + 1 < argc) outSplatPath = argv[++i];
        else if (arg == "--out-collider-glb" && i + 1 < argc) outColliderPath = argv[++i];
        else if (arg == "--inpaint-occlusion") enableInpaint = true;
        else if (arg == "--width" && i + 1 < argc) width = std::stoul(argv[++i]);
        else if (arg == "--height" && i + 1 < argc) height = std::stoul(argv[++i]);
        else if (arg == "--fov" && i + 1 < argc) fov = std::stof(argv[++i]);
        else if (arg == "--stride" && i + 1 < argc) stride = std::stoul(argv[++i]);
        else if (arg == "--scene" && i + 1 < argc) sceneType = argv[++i];
    }

    auto tStart = std::chrono::high_resolution_clock::now();

    PinholeCamera cam = PinholeCamera::fromFov(width, height, fov);
    DepthToGaussianOptions opts;
    opts.stride = stride;
    opts.edgeSeveranceTau = edgeTau;
    opts.minDepth = 0.5f;
    opts.maxDepth = 150.0f;

    std::vector<GaussianSplat> finalSplats;
    std::vector<float> singleDepths;

    if (sceneType == "multi_view_corner") {
        // Multi-view synthesis: 3 camera perspectives of an urban plaza corner
        std::vector<std::vector<GaussianSplat>> views;

        // View 1: Center Front
        {
            std::vector<uint8_t> rgb(width * height * 3);
            std::vector<float> depths(width * height);
            for (uint32_t y = 0; y < height; ++y) {
                float ny = static_cast<float>(y) / height;
                for (uint32_t x = 0; x < width; ++x) {
                    float nx = static_cast<float>(x) / width;
                    size_t idx = y * width + x;
                    // Ground vs facade
                    if (ny > 0.65f) {
                        depths[idx] = 3.0f + (1.0f - ny) * 12.0f;
                        rgb[idx * 3 + 0] = 70;
                        rgb[idx * 3 + 1] = 75;
                        rgb[idx * 3 + 2] = 85;
                    } else {
                        depths[idx] = 16.0f + std::sin(nx * 12.0f) * 0.4f;
                        rgb[idx * 3 + 0] = static_cast<uint8_t>(180 + std::sin(nx * 10.0f) * 40.0f);
                        rgb[idx * 3 + 1] = 160;
                        rgb[idx * 3 + 2] = 140;
                    }
                }
            }
            CameraPose poseFront;
            poseFront.position = Vec3(0, 0, 0);
            views.push_back(DepthToGaussianEngine::convertSingleImage(cam, rgb.data(), 3, depths.data(), opts, poseFront));
        }

        // View 2: Left 30-deg angle
        {
            std::vector<uint8_t> rgb(width * height * 3);
            std::vector<float> depths(width * height);
            for (uint32_t y = 0; y < height; ++y) {
                float ny = static_cast<float>(y) / height;
                for (uint32_t x = 0; x < width; ++x) {
                    size_t idx = y * width + x;
                    depths[idx] = (ny > 0.65f) ? (3.0f + (1.0f - ny) * 10.0f) : (14.0f + static_cast<float>(x) / width * 4.0f);
                    rgb[idx * 3 + 0] = 200;
                    rgb[idx * 3 + 1] = 140;
                    rgb[idx * 3 + 2] = 110;
                }
            }
            CameraPose poseLeft;
            poseLeft.position = Vec3(-4.0f, 0.2f, 2.0f);
            float angle = 0.45f; // ~26 deg
            poseLeft.rotation = Quat(0.0f, std::sin(angle * 0.5f), 0.0f, std::cos(angle * 0.5f));
            views.push_back(DepthToGaussianEngine::convertSingleImage(cam, rgb.data(), 3, depths.data(), opts, poseLeft));
        }

        // Fuse multi-view splats with voxel decimation
        splatprune::FloaterPruneReport floaters;
        finalSplats = DepthToGaussianEngine::fuseMultiViewSplats(views, 0.05f, {}, &floaters);
        std::cout << "Floater pruning: removed " << floaters.pruned << " of " << floaters.input
                  << " fused splats (kNN isolation > " << floaters.threshold << ", k=" << floaters.k << ")" << std::endl;
    } else if (sceneType == "equirectangular_360") {
        // Full 360-degree equirectangular panorama synthesis (e.g., San Marco Piazza 360)
        std::vector<uint8_t> rgb(width * height * 3);
        singleDepths.resize(width * height);

        for (uint32_t y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (uint32_t x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;
                size_t idx = y * width + x;

                if (v > 0.55f) {
                    // Paved plaza floor
                    rgb[idx * 3 + 0] = 90;
                    rgb[idx * 3 + 1] = 95;
                    rgb[idx * 3 + 2] = 105;
                } else if (v > 0.35f) {
                    // Historic architectural perimeter
                    float archPattern = std::sin(u * 28.0f * static_cast<float>(M_PI));
                    rgb[idx * 3 + 0] = archPattern > 0.0f ? 210 : 160;
                    rgb[idx * 3 + 1] = archPattern > 0.0f ? 190 : 145;
                    rgb[idx * 3 + 2] = archPattern > 0.0f ? 165 : 125;
                } else {
                    // Sky gradient
                    rgb[idx * 3 + 0] = 110;
                    rgb[idx * 3 + 1] = 160;
                    rgb[idx * 3 + 2] = 230;
                }
            }
        }

        finalSplats = DepthToGaussianEngine::convertEquirectangularToGaussianSplats(
            rgb.data(), width, height, 3, nullptr, stride, 1.70f, 65.0f
        );
    } else if (sceneType == "cyber_shibuya_360") {
        // Cyber Shibuya 360: Neon high-rises and wet asphalt
        std::vector<uint8_t> rgb(width * height * 3);
        singleDepths.resize(width * height);

        for (uint32_t y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (uint32_t x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;
                size_t idx = y * width + x;

                if (v > 0.52f) {
                    // Wet reflective asphalt with neon reflection
                    float neonGleam = std::sin(u * 16.0f * static_cast<float>(M_PI));
                    rgb[idx * 3 + 0] = neonGleam > 0.3f ? 180 : 30;
                    rgb[idx * 3 + 1] = neonGleam > 0.3f ? 40 : 32;
                    rgb[idx * 3 + 2] = neonGleam > 0.3f ? 220 : 45;
                } else if (v > 0.18f) {
                    // Soaring cyber towers with glowing signage ribbons
                    float towerStripe = std::sin(u * 32.0f * static_cast<float>(M_PI));
                    float vertSign = std::sin(v * 48.0f * static_cast<float>(M_PI));
                    if (towerStripe > 0.5f && vertSign > 0.2f) {
                        rgb[idx * 3 + 0] = 30;
                        rgb[idx * 3 + 1] = 230;
                        rgb[idx * 3 + 2] = 255;
                    } else if (towerStripe < -0.4f) {
                        rgb[idx * 3 + 0] = 255;
                        rgb[idx * 3 + 1] = 40;
                        rgb[idx * 3 + 2] = 160;
                    } else {
                        rgb[idx * 3 + 0] = 20;
                        rgb[idx * 3 + 1] = 25;
                        rgb[idx * 3 + 2] = 38;
                    }
                } else {
                    // Midnight sky with atmospheric glow
                    rgb[idx * 3 + 0] = 15;
                    rgb[idx * 3 + 1] = 18;
                    rgb[idx * 3 + 2] = 35;
                }
            }
        }

        finalSplats = DepthToGaussianEngine::convertEquirectangularToGaussianSplats(
            rgb.data(), width, height, 3, nullptr, stride, 1.70f, 90.0f
        );
    } else if (sceneType == "alpine_basin_360") {
        // Alpine Basin 360: 360-degree mountain amphitheater
        std::vector<uint8_t> rgb(width * height * 3);
        singleDepths.resize(width * height);

        for (uint32_t y = 0; y < height; ++y) {
            float v = static_cast<float>(y) / height;
            for (uint32_t x = 0; x < width; ++x) {
                float u = static_cast<float>(x) / width;
                size_t idx = y * width + x;

                if (v > 0.55f) {
                    // Alpine meadow and scree
                    rgb[idx * 3 + 0] = 75;
                    rgb[idx * 3 + 1] = 95;
                    rgb[idx * 3 + 2] = 55;
                } else if (v > 0.30f) {
                    // Snowcapped jagged granite peaks
                    float mountainRidges = std::abs(std::sin(u * 12.0f * static_cast<float>(M_PI)) * 0.15f + 0.38f - v);
                    if (mountainRidges < 0.05f) {
                        rgb[idx * 3 + 0] = 245;
                        rgb[idx * 3 + 1] = 248;
                        rgb[idx * 3 + 2] = 255;
                    } else {
                        rgb[idx * 3 + 0] = 110;
                        rgb[idx * 3 + 1] = 115;
                        rgb[idx * 3 + 2] = 130;
                    }
                } else {
                    // Crisp mountain sky
                    rgb[idx * 3 + 0] = 80;
                    rgb[idx * 3 + 1] = 140;
                    rgb[idx * 3 + 2] = 240;
                }
            }
        }

        finalSplats = DepthToGaussianEngine::convertEquirectangularToGaussianSplats(
            rgb.data(), width, height, 3, nullptr, stride, 1.70f, 120.0f
        );
    } else {
        // Single 2D architectural image synthesis
        std::vector<uint8_t> rgb(width * height * 3);
        singleDepths.resize(width * height);

        for (uint32_t y = 0; y < height; ++y) {
            float ny = static_cast<float>(y) / height;
            for (uint32_t x = 0; x < width; ++x) {
                float nx = static_cast<float>(x) / width;
                size_t idx = y * width + x;

                if (ny > 0.68f) {
                    // Paved foreground plaza floor
                    float t = (ny - 0.68f) / 0.32f;
                    singleDepths[idx] = 2.5f + (1.0f - t) * 14.0f;
                    rgb[idx * 3 + 0] = static_cast<uint8_t>(60 + (x % 30 < 2 ? 80 : 0));
                    rgb[idx * 3 + 1] = 65;
                    rgb[idx * 3 + 2] = 75;
                } else if (ny > 0.22f) {
                    // Classical colonnade facade with arched windows and pillars
                    float facadeDepth = 18.0f;
                    bool isColumn = std::fmod(nx * 14.0f, 1.0f) < 0.25f;
                    if (isColumn) facadeDepth -= 1.8f; // Distinct foreground depth discontinuity
                    singleDepths[idx] = facadeDepth;
                    rgb[idx * 3 + 0] = isColumn ? 225 : 190;
                    rgb[idx * 3 + 1] = isColumn ? 210 : 175;
                    rgb[idx * 3 + 2] = isColumn ? 180 : 150;
                } else {
                    // Sky background
                    singleDepths[idx] = 85.0f;
                    rgb[idx * 3 + 0] = 70;
                    rgb[idx * 3 + 1] = 130;
                    rgb[idx * 3 + 2] = 220;
                }
            }
        }

        if (enableInpaint) {
            finalSplats = DepthToGaussianEngine::convertSingleImageWithOcclusionInpainting(
                cam, rgb.data(), 3, singleDepths.data(), opts);
        } else {
            finalSplats = DepthToGaussianEngine::convertSingleImage(cam, rgb.data(), 3, singleDepths.data(), opts);
        }
    }

    bool ok = DepthToGaussianEngine::saveToSplatFile(outSplatPath, finalSplats);
    if (!ok) {
        std::cerr << "Failed to save splats to " << outSplatPath << std::endl;
        return 1;
    }

    // Export companion physics collider mesh (.GLB) if requested
    if (!outColliderPath.empty() && !singleDepths.empty()) {
        auto collider = DepthToGaussianEngine::extractPhysicsColliders(cam, singleDepths.data());
        auto glbBytes = DepthToGaussianEngine::serializeColliderToGlb(collider);
        if (!glbBytes.empty()) {
            std::ofstream glbFile(outColliderPath, std::ios::binary);
            glbFile.write(reinterpret_cast<const char*>(glbBytes.data()), glbBytes.size());
            std::cout << "SUCCESS: Exported Physics Collider GLB (" << glbBytes.size()
                      << " bytes, " << collider.boundingBoxes.size() << " box colliders) to "
                      << outColliderPath << std::endl;
        }
    }

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "SUCCESS: Generated " << finalSplats.size() << " 3D Gaussian Splats in "
              << ms << " ms (" << outSplatPath << ")" << std::endl;

    return 0;
}
