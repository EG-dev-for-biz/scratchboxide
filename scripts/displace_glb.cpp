/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_displacement.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"

#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

using namespace scratchbox;
using Json = io::GlbJsonValue;

namespace {

float numberOr(const Json& v, float fallback) {
    return v.type == Json::Number ? static_cast<float>(v.num) : fallback;
}

bool boolOr(const Json& v, bool fallback) {
    return v.type == Json::Bool ? v.b : fallback;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::cerr << "Usage: displace_glb <input.glb> <output.glb> [options.json]" << std::endl;
        return 1;
    }

    const std::string inPath = argv[1];
    const std::string outPath = argv[2];
    std::string configPath = (argc >= 4) ? argv[3] : "";

    displacement::DisplacementOptions options;
    if (!configPath.empty()) {
        std::ifstream cf(configPath);
        if (cf.is_open()) {
            std::stringstream ss;
            ss << cf.rdbuf();
            std::string text = ss.str();
            io::GlbJsonParser parser(text.data(), text.size());
            Json json = parser.parse();

            options.tessellationFactor = static_cast<uint32_t>(numberOr(json["tessellationFactor"], 4.0f));
            options.displacementScale = numberOr(json["displacementScale"], 0.06f);
            options.midpoint = numberOr(json["midpoint"], 0.5f);
            options.enableProceduralNoise = boolOr(json["enableProceduralNoise"], true);
            options.proceduralNoiseScale = numberOr(json["proceduralNoiseScale"], 0.015f);
            options.proceduralNoiseFrequency = numberOr(json["proceduralNoiseFrequency"], 32.0f);
            options.sampleTextureHeight = boolOr(json["sampleTextureHeight"], true);
            options.textureHeightWeight = numberOr(json["textureHeightWeight"], 1.0f);
            options.recomputeSmoothNormals = boolOr(json["recomputeSmoothNormals"], true);
            options.preserveSharpEdges = boolOr(json["preserveSharpEdges"], true);
            options.sharpEdgeThresholdDeg = numberOr(json["sharpEdgeThresholdDeg"], 65.0f);
        }
    }

    const auto start = std::chrono::steady_clock::now();

    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(inPath);
    if (!scene.ok) {
        std::cerr << "{\"success\": false, \"error\": \"Failed to load " << inPath << ": " << scene.error << "\"}" << std::endl;
        return 2;
    }

    size_t origTris = scene.mesh.indices.size() / 3;
    size_t origVerts = scene.mesh.vertices.size();

    gltf::GltfScene displacedScene = displacement::DisplacementEngine::tessellateAndDisplaceScene(scene, options);

    size_t dispTris = displacedScene.mesh.indices.size() / 3;
    size_t dispVerts = displacedScene.mesh.vertices.size();

    std::vector<uint8_t> outGlb = io::GlbWriter::writeGlb(displacedScene.mesh);
    std::ofstream outF(outPath, std::ios::binary);
    if (!outF.is_open() || !outF.write(reinterpret_cast<const char*>(outGlb.data()), outGlb.size())) {
        std::cerr << "{\"success\": false, \"error\": \"Failed to write " << outPath << "\"}" << std::endl;
        return 3;
    }

    const auto end = std::chrono::steady_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(end - start).count();

    std::cout << "{\n"
              << "  \"success\": true,\n"
              << "  \"inputGlbPath\": \"" << inPath << "\",\n"
              << "  \"outputGlbPath\": \"" << outPath << "\",\n"
              << "  \"originalTriangles\": " << origTris << ",\n"
              << "  \"displacedTriangles\": " << dispTris << ",\n"
              << "  \"originalVertices\": " << origVerts << ",\n"
              << "  \"displacedVertices\": " << dispVerts << ",\n"
              << "  \"expansionRatio\": " << (dispTris / static_cast<double>(std::max<size_t>(1, origTris))) << ",\n"
              << "  \"executionMs\": " << elapsedMs << "\n"
              << "}" << std::endl;

    return 0;
}
