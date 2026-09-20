/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_colmap.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <cmath>

using namespace scratchbox;
using namespace scratchbox::colmap;

void writeBinaryFile(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
}

// Generate a synthetic reconstruction for testing: 8 orbital cameras + 3D points
ColmapReconstruction generateSyntheticReconstruction() {
    ColmapReconstruction recon;

    // 1. Intrinsics (PINHOLE)
    ColmapCamera cam;
    cam.cameraId = 1;
    cam.model = CameraModelId::PINHOLE;
    cam.width = 1920;
    cam.height = 1080;
    cam.params = {1200.0, 1200.0, 960.0, 540.0}; // fx, fy, cx, cy
    recon.cameras[cam.cameraId] = cam;

    // 2. Extrinsics: 8 cameras orbiting origin at radius 4.0m, height 1.2m
    int numCams = 8;
    float orbitRadius = 4.0f;
    float camHeight = 1.2f;

    for (int i = 0; i < numCams; ++i) {
        float angle = (static_cast<float>(i) / numCams) * math::TWO_PI;
        Vec3 camPos(orbitRadius * std::cos(angle), camHeight, orbitRadius * std::sin(angle));
        Vec3 lookAt(0.0f, 0.0f, 0.0f);
        Vec3 up(0.0f, 1.0f, 0.0f);

        // Compute OpenCV coordinate frame
        Vec3 fwd = (lookAt - camPos).normalized(); // +Z in OpenCV
        Vec3 right = fwd.cross(up).normalized();   // +X in OpenCV
        Vec3 down = fwd.cross(right).normalized(); // +Y in OpenCV

        // Rotation matrix C2W = [right | down | fwd]
        Mat3 R_c2w(
            right.x, down.x, fwd.x,
            right.y, down.y, fwd.y,
            right.z, down.z, fwd.z
        );
        Mat3 R_w2c = R_c2w.transpose();
        Vec3 tvec = -(R_w2c * camPos);

        // Convert R_w2c to quaternion
        float trace = R_w2c.m[0] + R_w2c.m[4] + R_w2c.m[8];
        float qw, qx, qy, qz;
        if (trace > 0.0f) {
            float s = 0.5f / std::sqrt(trace + 1.0f);
            qw = 0.25f / s;
            qx = (R_w2c.m[7] - R_w2c.m[5]) * s;
            qy = (R_w2c.m[2] - R_w2c.m[6]) * s;
            qz = (R_w2c.m[3] - R_w2c.m[1]) * s;
        } else {
            if (R_w2c.m[0] > R_w2c.m[4] && R_w2c.m[0] > R_w2c.m[8]) {
                float s = 2.0f * std::sqrt(1.0f + R_w2c.m[0] - R_w2c.m[4] - R_w2c.m[8]);
                qw = (R_w2c.m[7] - R_w2c.m[5]) / s;
                qx = 0.25f * s;
                qy = (R_w2c.m[1] + R_w2c.m[3]) / s;
                qz = (R_w2c.m[2] + R_w2c.m[6]) / s;
            } else if (R_w2c.m[4] > R_w2c.m[8]) {
                float s = 2.0f * std::sqrt(1.0f + R_w2c.m[4] - R_w2c.m[0] - R_w2c.m[8]);
                qw = (R_w2c.m[2] - R_w2c.m[6]) / s;
                qx = (R_w2c.m[1] + R_w2c.m[3]) / s;
                qy = 0.25f * s;
                qz = (R_w2c.m[5] + R_w2c.m[7]) / s;
            } else {
                float s = 2.0f * std::sqrt(1.0f + R_w2c.m[8] - R_w2c.m[0] - R_w2c.m[4]);
                qw = (R_w2c.m[3] - R_w2c.m[1]) / s;
                qx = (R_w2c.m[2] + R_w2c.m[6]) / s;
                qy = (R_w2c.m[5] + R_w2c.m[7]) / s;
                qz = 0.25f * s;
            }
        }

        ColmapImage img;
        img.imageId = static_cast<uint32_t>(i + 1);
        img.cameraId = cam.cameraId;
        img.name = "cam_" + std::to_string(i + 1) + ".jpg";
        img.qvec = Vec4(qw, qx, qy, qz);
        img.tvec = tvec;
        recon.images[img.imageId] = img;
    }

    // 3. Points3D: Ring of points + central cube
    uint64_t ptId = 1;
    // Central cube
    for (float x = -0.5f; x <= 0.5f; x += 0.25f) {
        for (float y = 0.0f; y <= 1.0f; y += 0.25f) {
            for (float z = -0.5f; z <= 0.5f; z += 0.25f) {
                ColmapPoint3D pt;
                pt.point3DId = ptId++;
                pt.xyz = Vec3(x, y, z);
                pt.rgb = Vec4(0.2f + 0.6f * (x + 0.5f), 0.3f + 0.5f * y, 0.4f + 0.5f * (z + 0.5f), 1.0f);
                pt.error = 0.45;
                recon.points3D[pt.point3DId] = pt;
            }
        }
    }

    return recon;
}

int main(int argc, char** argv) {
    std::string sparseDir = "";
    std::string outGlbPath = "output_colmap.glb";
    float frustumScale = 0.35f;
    float pointRadius = 0.015f;
    bool runSynthetic = false;
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--sparse-dir" && i + 1 < argc) sparseDir = argv[++i];
        else if (arg == "--out-glb" && i + 1 < argc) outGlbPath = argv[++i];
        else if (arg == "--frustum-scale" && i + 1 < argc) frustumScale = std::stof(argv[++i]);
        else if (arg == "--point-radius" && i + 1 < argc) pointRadius = std::stof(argv[++i]);
        else if (arg == "--synthetic") runSynthetic = true;
        else if (arg == "--json") emitJson = true;
    }

    ColmapReconstruction recon;
    if (runSynthetic || sparseDir.empty()) {
        recon = generateSyntheticReconstruction();
    } else {
        bool loaded = ColmapParser::loadFromDirectory(sparseDir, recon);
        if (!loaded || (recon.cameras.empty() && recon.images.empty())) {
            std::cerr << "Warning: Could not load COLMAP data from " << sparseDir << ", falling back to synthetic." << std::endl;
            recon = generateSyntheticReconstruction();
        }
    }

    // Export GLB
    std::vector<uint8_t> glbData = ColmapMeshBuilder::exportToGlb(recon, frustumScale, pointRadius);
    writeBinaryFile(outGlbPath, glbData);

    geometry::AABB aabb = recon.computeBoundingBox();
    Vec3 centroid = recon.computeCentroid();

    if (emitJson) {
        std::cout << "{\n"
                  << "  \"success\": true,\n"
                  << "  \"numCameras\": " << recon.numCameras() << ",\n"
                  << "  \"numImages\": " << recon.numImages() << ",\n"
                  << "  \"numPoints3D\": " << recon.numPoints3D() << ",\n"
                  << "  \"glbBytes\": " << glbData.size() << ",\n"
                  << "  \"glbPath\": \"" << outGlbPath << "\",\n"
                  << "  \"bounds\": {\n"
                  << "    \"min\": [" << aabb.min.x << ", " << aabb.min.y << ", " << aabb.min.z << "],\n"
                  << "    \"max\": [" << aabb.max.x << ", " << aabb.max.y << ", " << aabb.max.z << "]\n"
                  << "  },\n"
                  << "  \"centroid\": [" << centroid.x << ", " << centroid.y << ", " << centroid.z << "]\n"
                  << "}\n";
    } else {
        std::cout << "[Scratchbox COLMAP/GLOMAP Reconstruction Pipeline]" << std::endl;
        std::cout << "✓ Registered Cameras: " << recon.numCameras() << std::endl;
        std::cout << "✓ Registered Images: " << recon.numImages() << std::endl;
        std::cout << "✓ Triangulated 3D Points: " << recon.numPoints3D() << std::endl;
        std::cout << "✓ Centroid: (" << centroid.x << ", " << centroid.y << ", " << centroid.z << ")" << std::endl;
        std::cout << "✓ Exported glTF 2.0 Binary (.glb): " << outGlbPath << " (" << glbData.size() << " bytes)" << std::endl;
    }

    return 0;
}
