/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <cassert>
#include <fstream>

#include "scratchbox_camera_reprojector.hpp"

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::reprojector;

int main(int argc, char** argv) {
    bool runTest = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--test") {
            runTest = true;
        }
    }

    std::cout << "📦 [DepthBox Ground Truth Baker] Initialized C++20 Depth-Ray Renderer\n";

    if (runTest) {
        std::cout << "🧪 [Test Mode] Verifying Ray Map generation & Reprojection with Ray Map...\n";

        int width = 256;
        int height = 256;
        float fov = 60.0f;

        CameraIntrinsics sourceIntr(width, height, fov);
        ImageBuffer color(width, height, 4, 200);

        // Fill test pattern
        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                size_t idx = (y * width + x) * 4;
                color.data[idx] = static_cast<uint8_t>((x * 255) / width);
                color.data[idx + 1] = static_cast<uint8_t>((y * 255) / height);
                color.data[idx + 2] = 128;
                color.data[idx + 3] = 255;
            }
        }

        // Generate exact ground truth depth (planar surface at 5.0m) and ray map
        std::vector<float> metricDepths(width * height, 5.0f);
        std::vector<float> rayMap(3 * width * height);

        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                size_t pIdx = y * width + x;
                Vec3 p = sourceIntr.unproject(static_cast<float>(x), static_cast<float>(y), 1.0f);
                Vec3 rayDir = p.normalized();

                rayMap[3 * pIdx] = rayDir.x;
                rayMap[3 * pIdx + 1] = rayDir.y;
                rayMap[3 * pIdx + 2] = rayDir.z;

                // Verify unit length
                float len = rayDir.length();
                assert(std::abs(len - 1.0f) < 1e-4f);
            }
        }

        std::cout << "  ✅ Ray map unit-length verification passed (all ||r|| == 1.0).\n";

        // Test unprojection & reprojection via reprojectWithRayMap
        CameraPose targetPose = CameraPose::fromOrbit(10.0f, 5.0f, 0.0f, 5.0f);
        ReprojectionConfig config;
        config.depthNear = 1.0f;
        config.depthFar = 20.0f;

        ReprojectionOutput output = CameraSpaceReprojector::reprojectWithRayMap(
            color,
            metricDepths,
            rayMap,
            targetPose,
            sourceIntr,
            config
        );

        std::cout << "  ✅ Reprojection with Ray Map generated " << output.mesh.vertices.size()
                  << " vertices and " << output.totalTriangles << " triangles.\n";
        std::cout << "  ✅ Disocclusion percentage: " << output.disocclusionPercent << "%\n";

        assert(!output.mesh.vertices.empty());
        assert(output.totalTriangles > 0);

        std::cout << "🎉 [DepthBox Ground Truth Baker] All C++20 verification tests passed!\n";
        return 0;
    }

    std::cout << "Usage: ./generate_depthbox_groundtruth --test\n";
    return 0;
}
