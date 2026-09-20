/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>

using namespace scratchbox;
using namespace scratchbox::cleanup;
using namespace scratchbox::geometry;
using namespace scratchbox::math;

/**
 * Robust binary glTF 2.0 (.glb) parser to extract mesh vertices with COLOR_0.
 */
bool loadMeshFromGlb(const std::string& glbPath, ScratchboxMesh& outMesh) {
    std::ifstream file(glbPath, std::ios::binary);
    if (!file.is_open()) {
        std::cerr << "Failed to open GLB: " << glbPath << std::endl;
        return false;
    }

    uint32_t magic = 0, version = 0, length = 0;
    file.read(reinterpret_cast<char*>(&magic), 4);
    file.read(reinterpret_cast<char*>(&version), 4);
    file.read(reinterpret_cast<char*>(&length), 4);

    if (magic != 0x46546C67) { // "glTF"
        std::cerr << "Invalid GLB magic header in " << glbPath << std::endl;
        return false;
    }

    uint32_t jsonChunkLen = 0, jsonChunkType = 0;
    file.read(reinterpret_cast<char*>(&jsonChunkLen), 4);
    file.read(reinterpret_cast<char*>(&jsonChunkType), 4);

    std::string jsonStr(jsonChunkLen, ' ');
    file.read(&jsonStr[0], jsonChunkLen);

    uint32_t binChunkLen = 0, binChunkType = 0;
    file.read(reinterpret_cast<char*>(&binChunkLen), 4);
    file.read(reinterpret_cast<char*>(&binChunkType), 4);

    std::vector<uint8_t> binData(binChunkLen);
    file.read(reinterpret_cast<char*>(binData.data()), binChunkLen);

    // Simple JSON attribute finder
    auto getAccessorIndex = [&](const std::string& attrName) -> int {
        size_t pos = jsonStr.find("\"" + attrName + "\":");
        if (pos == std::string::npos) return -1;
        return std::stoi(jsonStr.substr(pos + attrName.length() + 3));
    };

    auto getAccessorInfo = [&](int accIdx) -> std::pair<size_t, size_t> {
        if (accIdx < 0) return {0, 0};
        size_t accsPos = jsonStr.find("\"accessors\":");
        if (accsPos == std::string::npos) return {0, 0};
        size_t currAcc = accsPos;
        for (int i = 0; i <= accIdx; ++i) {
            currAcc = jsonStr.find('{', currAcc + 1);
        }
        size_t countPos = jsonStr.find("\"count\":", currAcc);
        size_t countVal = (countPos != std::string::npos) ? std::stoull(jsonStr.substr(countPos + 8)) : 0;

        size_t bvPos = jsonStr.find("\"bufferView\":", currAcc);
        size_t bvIdx = (bvPos != std::string::npos) ? std::stoull(jsonStr.substr(bvPos + 13)) : 0;

        // Find bufferView
        size_t bvsPos = jsonStr.find("\"bufferViews\":");
        size_t currBv = bvsPos;
        for (size_t i = 0; i <= bvIdx; ++i) {
            currBv = jsonStr.find('{', currBv + 1);
        }
        size_t byteOffPos = jsonStr.find("\"byteOffset\":", currBv);
        size_t byteOffset = 0;
        if (byteOffPos != std::string::npos && byteOffPos < jsonStr.find('}', currBv)) {
            byteOffset = std::stoull(jsonStr.substr(byteOffPos + 13));
        }
        return {byteOffset, countVal};
    };

    int posIdx = getAccessorIndex("POSITION");
    int normIdx = getAccessorIndex("NORMAL");
    int colIdx = getAccessorIndex("COLOR_0");

    auto [posOff, posCount] = getAccessorInfo(posIdx);
    auto [normOff, normCount] = getAccessorInfo(normIdx);
    auto [colOff, colCount] = getAccessorInfo(colIdx);

    if (posCount == 0) {
        std::cerr << "No POSITION attribute found in " << glbPath << std::endl;
        return false;
    }

    outMesh.vertices.resize(posCount);
    for (size_t i = 0; i < posCount; ++i) {
        const float* p = reinterpret_cast<const float*>(binData.data() + posOff + i * 12);
        outMesh.vertices[i].position = Vec3(p[0], p[1], p[2]);

        if (normCount > i) {
            const float* n = reinterpret_cast<const float*>(binData.data() + normOff + i * 12);
            outMesh.vertices[i].normal = Vec3(n[0], n[1], n[2]);
        } else {
            outMesh.vertices[i].normal = Vec3(0.0f, 1.0f, 0.0f);
        }

        if (colCount > i) {
            const float* c = reinterpret_cast<const float*>(binData.data() + colOff + i * 16);
            outMesh.vertices[i].color = Vec4(c[0], c[1], c[2], c[3]);
        } else {
            outMesh.vertices[i].color = Vec4(0.5f, 0.5f, 0.5f, 1.0f);
        }
    }

    return true;
}

int main(int argc, char** argv) {
    std::cout << "======================================================================" << std::endl;
    std::cout << "Google 3D Tile Architectural Color Scheme & PBR Extractor (C++20)" << std::endl;
    std::cout << "======================================================================" << std::endl;

    std::string glbPath = "scripts/building_raw.glb";
    if (argc > 1) {
        glbPath = argv[1];
    }

    std::cout << "-> Loading raw photogrammetric tile model: " << glbPath << std::endl;
    ScratchboxMesh tileMesh("raw_google_tile");
    if (!loadMeshFromGlb(glbPath, tileMesh)) {
        std::cerr << "Failed to load tile mesh. Aborting." << std::endl;
        return 1;
    }

    std::cout << "-> Successfully loaded " << tileMesh.vertices.size() << " vertices from " << glbPath << std::endl;

    // Run Color Scheme Extraction
    auto colorSchema = GoogleTileColorSchemeExtractor::extractColorScheme(
        tileMesh,
        "Empire State Building (Google 3D Tile Scan)",
        glbPath
    );

    std::cout << "\n======================================================================" << std::endl;
    std::cout << "Estimated Atmospheric Solar Parameters:" << std::endl;
    std::cout << "  Sun Vector:    (" << colorSchema.estimatedSunDirection.x << ", "
              << colorSchema.estimatedSunDirection.y << ", "
              << colorSchema.estimatedSunDirection.z << ")" << std::endl;
    std::cout << "  Elevation:     " << colorSchema.estimatedSunElevationDeg << " deg" << std::endl;
    std::cout << "  Azimuth:       " << colorSchema.estimatedSunAzimuthDeg << " deg (SW Afternoon Sun)" << std::endl;
    std::cout << "======================================================================" << std::endl;

    std::cout << "\nExtracted Architectural Color Schema:" << std::endl;
    std::cout << "----------------------------------------------------------------------" << std::endl;
    for (const auto& mat : colorSchema.materials()) {
        std::cout << "[" << mat.id << "]" << std::endl;
        std::cout << "  Name:         " << mat.name << std::endl;
        std::cout << "  Role:         " << mat.architecturalRole << std::endl;
        std::cout << "  Hex Albedo:   " << mat.hex << "  (De-Lighted)" << std::endl;
        std::cout << "  Raw Sampled:  RGB(" << mat.rawSampledRgb.x << ", " << mat.rawSampledRgb.y << ", " << mat.rawSampledRgb.z << ")" << std::endl;
        std::cout << "  De-Lighted:   RGB(" << mat.delightedRgb.x << ", " << mat.delightedRgb.y << ", " << mat.delightedRgb.z << ")" << std::endl;
        std::cout << "  Roughness:    " << mat.roughness << " | Metalness: " << mat.metalness << " | F0: " << mat.f0 << std::endl;
        std::cout << "  Normal Scale: " << mat.normalScale << " | AO Intensity: " << mat.aoIntensity << std::endl;
        if (mat.emissiveIntensity > 0.0f) {
            std::cout << "  Emissive:     RGB(" << mat.emissiveRgb.x << ", " << mat.emissiveRgb.y << ", " << mat.emissiveRgb.z << ") @ " << mat.emissiveIntensity << " cd/m2" << std::endl;
        }
        std::cout << "  Coverage:     " << mat.sampleCount << " vertices (" << (mat.areaFraction * 100.0f) << "% of total scan)" << std::endl;
        std::cout << "----------------------------------------------------------------------" << std::endl;
    }

    // Export to JSON
    std::string jsonStr = GoogleTileColorSchemeExtractor::exportToJson(colorSchema);
    std::string outJsonPath = "scripts/google_map_tile_color_schema.json";
    std::ofstream outFile(outJsonPath);
    if (outFile.is_open()) {
        outFile << jsonStr;
        outFile.close();
        std::cout << "\n-> Successfully exported Color Scheme to: " << outJsonPath << " (" << jsonStr.length() << " bytes)" << std::endl;
    } else {
        std::cerr << "Failed to write output JSON to " << outJsonPath << std::endl;
        return 1;
    }

    std::cout << "\nColor extraction from Google 3D Tile complete!\n" << std::endl;
    return 0;
}
