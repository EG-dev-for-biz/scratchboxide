/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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

static std::string jsonEscape(const std::string& in) {
    std::string out;
    for (char c : in) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c == '\n') out += "\\n";
        else out += c;
    }
    return out;
}

static int fail(bool emitJson, const std::string& message) {
    if (emitJson) {
        std::cout << "{\n  \"success\": false,\n  \"error\": \"" << jsonEscape(message) << "\"\n}\n";
    } else {
        std::cerr << "Error: " << message << std::endl;
    }
    return 1;
}

int main(int argc, char** argv) {
    std::string sparseDir = "";
    std::string outGlbPath = "output_colmap.glb";
    float frustumScale = 0.35f;
    float pointRadius = 0.015f;
    bool emitJson = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--sparse-dir" && i + 1 < argc) sparseDir = argv[++i];
        else if (arg == "--out-glb" && i + 1 < argc) outGlbPath = argv[++i];
        else if (arg == "--frustum-scale" && i + 1 < argc) frustumScale = std::stof(argv[++i]);
        else if (arg == "--point-radius" && i + 1 < argc) pointRadius = std::stof(argv[++i]);
        else if (arg == "--json") emitJson = true;
    }

    // A COLMAP sparse model (cameras/images/points3D) is required; there is no built-in sample scene.
    if (sparseDir.empty()) {
        return fail(emitJson, "--sparse-dir <COLMAP sparse model directory> is required");
    }
    ColmapReconstruction recon;
    bool loaded = ColmapParser::loadFromDirectory(sparseDir, recon);
    if (!loaded || (recon.cameras.empty() && recon.images.empty())) {
        return fail(emitJson, "could not load a COLMAP sparse model (cameras.txt/images.txt/points3D.txt or .bin) from " + sparseDir);
    }

    // Export GLB
    std::vector<uint8_t> glbData = ColmapMeshBuilder::exportToGlb(recon, frustumScale, pointRadius);
    if (glbData.empty()) {
        return fail(emitJson, "GLB export produced no data for " + sparseDir);
    }
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
                  << "  \"glbPath\": \"" << jsonEscape(outGlbPath) << "\",\n"
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
