/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_camera_reprojector.hpp"
#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <memory>
#include <cmath>

using namespace scratchbox;
using namespace scratchbox::reprojector;
using texture::ImageBuffer;
using texture::encodePng;
using io::GlbWriter;

// Zero-dependency PPM reader for quick binary testing
ImageBuffer loadPpm(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) return {};
    std::string magic;
    file >> magic;
    if (magic != "P6") return {};
    int w, h, maxVal;
    file >> w >> h >> maxVal;
    file.get(); // skip single whitespace
    ImageBuffer img(w, h, 3);
    file.read(reinterpret_cast<char*>(img.data.data()), w * h * 3);
    return img;
}

// Zero-dependency raw RGBA binary reader (w, h as uint32_t header + raw bytes)
ImageBuffer loadRawRgba(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) return {};
    uint32_t w = 0, h = 0;
    file.read(reinterpret_cast<char*>(&w), 4);
    file.read(reinterpret_cast<char*>(&h), 4);
    if (w == 0 || h == 0 || w > 8192 || h > 8192) return {};
    ImageBuffer img(w, h, 4);
    file.read(reinterpret_cast<char*>(img.data.data()), w * h * 4);
    return img;
}

void writeBinaryFile(const std::string& path, const std::vector<uint8_t>& bytes) {
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    }
}

ImageBuffer generateSyntheticScene(int w, int h, ImageBuffer& outDepth) {
    ImageBuffer color(w, h, 3);
    outDepth = ImageBuffer(w, h, 1);

    for (int y = 0; y < h; ++y) {
        float ny = static_cast<float>(y) / h;
        for (int x = 0; x < w; ++x) {
            float nx = static_cast<float>(x) / w;

            // Background wall (depth ~ 4.0m)
            Vec3 col(0.2f + 0.1f * std::sin(nx * 12.0f), 0.25f + 0.1f * std::cos(ny * 12.0f), 0.35f);
            float d = 4.0f;

            // Foreground pillar (depth ~ 1.5m)
            if (nx > 0.35f && nx < 0.65f && ny > 0.2f && ny < 0.8f) {
                col = Vec3(0.85f, 0.45f, 0.2f); // Orange foreground monument
                d = 1.5f;
            }

            color.setPixelRGB(x, y, col);
            float normD = (d - 1.0f) / (5.0f - 1.0f);
            size_t idx = static_cast<size_t>(y * w + x);
            outDepth.data[idx] = static_cast<uint8_t>(normD * 255.0f);
        }
    }
    return color;
}

int main(int argc, char** argv) {
    float yaw = 15.0f;
    float pitch = 5.0f;
    float roll = 0.0f;
    float distance = 2.5f;
    float fov = 60.0f;
    float tau = 0.075f;
    int step = 2; // Grid downsample for responsive 3D mesh
    bool testSynthetic = false;

    std::string imagePath = "";
    std::string depthPath = "";
    std::string outGlbPath = "camera_reprojected.glb";
    std::string outReprojectedPath = "camera_reprojected.png";
    std::string outMaskPath = "camera_disocclusion_mask.png";
    std::string outNormalPath = "camera_normal_map.png";
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--test-synthetic") testSynthetic = true;
        else if (arg == "--yaw" && i + 1 < argc) yaw = std::stof(argv[++i]);
        else if (arg == "--pitch" && i + 1 < argc) pitch = std::stof(argv[++i]);
        else if (arg == "--roll" && i + 1 < argc) roll = std::stof(argv[++i]);
        else if (arg == "--dist" && i + 1 < argc) distance = std::stof(argv[++i]);
        else if (arg == "--fov" && i + 1 < argc) fov = std::stof(argv[++i]);
        else if (arg == "--tau" && i + 1 < argc) tau = std::stof(argv[++i]);
        else if (arg == "--step" && i + 1 < argc) step = std::stoi(argv[++i]);
        else if (arg == "--image" && i + 1 < argc) imagePath = argv[++i];
        else if (arg == "--depth" && i + 1 < argc) depthPath = argv[++i];
        else if (arg == "--out-glb" && i + 1 < argc) outGlbPath = argv[++i];
        else if (arg == "--out-reprojected" && i + 1 < argc) outReprojectedPath = argv[++i];
        else if (arg == "--out-mask" && i + 1 < argc) outMaskPath = argv[++i];
        else if (arg == "--out-normal" && i + 1 < argc) outNormalPath = argv[++i];
        else if (arg == "--json") emitJson = true;
    }

    ImageBuffer color;
    ImageBuffer depth;

    if (testSynthetic || imagePath.empty()) {
        int w = 256;
        int h = 256;
        color = generateSyntheticScene(w, h, depth);
    } else {
        // Attempt load
        if (imagePath.ends_with(".raw")) {
            color = loadRawRgba(imagePath);
        } else if (imagePath.ends_with(".ppm")) {
            color = loadPpm(imagePath);
        }

        if (color.empty()) {
            std::cerr << "Warning: Failed to load raw/ppm image from " << imagePath << ", generating synthetic fallback." << std::endl;
            color = generateSyntheticScene(256, 256, depth);
        } else {
            if (!depthPath.empty() && depthPath.ends_with(".raw")) {
                depth = loadRawRgba(depthPath);
            } else {
                depth = CameraSpaceReprojector::estimateDepthFromLuminance(color, 1.0f, 6.0f);
            }
        }
    }

    int w = color.width;
    int h = color.height;

    CameraIntrinsics srcIntr = CameraIntrinsics::fromFov(fov, w, h);
    CameraIntrinsics dstIntr = CameraIntrinsics::fromFov(fov, w, h);
    CameraPose targetPose = CameraPose::fromOrbit(yaw, pitch, roll, distance, Vec3(0, 0, -2.5f));

    ReprojectionConfig config;
    config.edgeDiscontinuityThreshold = tau;
    config.gridStep = step;
    config.severEdges = true;
    config.guidedFilterRadius = 2;

    ReprojectionOutput output = CameraSpaceReprojector::reproject(color, depth, targetPose, srcIntr, dstIntr, config);

    // Save GLB binary mesh
    std::vector<uint8_t> glbData = GlbWriter::writeGlb(output.mesh);
    writeBinaryFile(outGlbPath, glbData);

    // Save Output PNGs
    std::vector<uint8_t> reproPng = encodePng(output.reprojectedRgba);
    writeBinaryFile(outReprojectedPath, reproPng);

    std::vector<uint8_t> maskPng = encodePng(output.disocclusionMask);
    writeBinaryFile(outMaskPath, maskPng);

    std::vector<uint8_t> normalPng = encodePng(output.normalBuffer);
    writeBinaryFile(outNormalPath, normalPng);

    if (emitJson) {
        std::cout << "{\n"
                  << "  \"success\": true,\n"
                  << "  \"yaw\": " << yaw << ",\n"
                  << "  \"pitch\": " << pitch << ",\n"
                  << "  \"roll\": " << roll << ",\n"
                  << "  \"distance\": " << distance << ",\n"
                  << "  \"fov\": " << fov << ",\n"
                  << "  \"tau\": " << tau << ",\n"
                  << "  \"totalTriangles\": " << output.totalTriangles << ",\n"
                  << "  \"severedTriangles\": " << output.severedTriangles << ",\n"
                  << "  \"retainedTriangles\": " << output.mesh.indices.size() / 3 << ",\n"
                  << "  \"disocclusionPercent\": " << output.disocclusionPercent << ",\n"
                  << "  \"glbBytes\": " << glbData.size() << ",\n"
                  << "  \"glbPath\": \"" << outGlbPath << "\",\n"
                  << "  \"reprojectedPath\": \"" << outReprojectedPath << "\",\n"
                  << "  \"maskPath\": \"" << outMaskPath << "\",\n"
                  << "  \"normalPath\": \"" << outNormalPath << "\"\n"
                  << "}\n";
    } else {
        std::cout << "[Scratchbox Camera Space Tool]" << std::endl;
        std::cout << "✓ Reprojected View (Yaw=" << yaw << "°, Pitch=" << pitch << "°, Dist=" << distance << ")" << std::endl;
        std::cout << "✓ Total Triangles: " << output.totalTriangles << std::endl;
        std::cout << "✓ Severed Discontinuity Triangles: " << output.severedTriangles << std::endl;
        std::cout << "✓ Retained Triangles: " << output.mesh.indices.size() / 3 << std::endl;
        std::cout << "✓ Disocclusion Hole Ratio: " << output.disocclusionPercent << "%" << std::endl;
        std::cout << "✓ Saved glTF 2.0 Binary: " << outGlbPath << " (" << glbData.size() << " bytes)" << std::endl;
        std::cout << "✓ Saved Reprojected PNG: " << outReprojectedPath << " (" << reproPng.size() << " bytes)" << std::endl;
        std::cout << "✓ Saved Disocclusion Mask: " << outMaskPath << " (" << maskPng.size() << " bytes)" << std::endl;
        std::cout << "✓ Saved Normal Map: " << outNormalPath << " (" << normalPng.size() << " bytes)" << std::endl;
    }

    return 0;
}
