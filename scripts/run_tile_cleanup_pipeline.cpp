/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless 3D Photogrammetry & Tile Cleanup Pipeline CLI
 * Suitable for In-App Native Execution and Google Cloud Run Microservices.
 *
 * Performs:
 * 1. Planar Decimation (Limited Dissolve on coplanar surfaces)
 * 2. Manhattan Corner Straightening (Stepped proxy normal projection)
 * 3. Texture De-Lighting & Vegetation Masking (ExG chrominance)
 * 4. Semantic Mesh Separation (Rooftop flattening, Facades, Roadways)
 * 5. Raycast Road Elevation Conforming via BVH
 *
 * Streams binary glTF 2.0 (.glb) chunks over stdout or writes to disk.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_gltf_scene.hpp"

#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::cleanup;
using namespace scratchbox::io;
using namespace scratchbox::gltf;

int main(int argc, char* argv[]) {
    std::string outputPath = "cleaned_tile_output.glb";
    std::string rawOutputPath = "";
    std::string inputPath = "";
    std::string refinedOutputPath = "";
    bool streamStdout = false;
    float planarAngleThreshold = 4.0f;
    float cornerSnapTol = 0.85f;
    PatinaOptions patina;
    int texResolution = 1024;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--output" && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--raw-output" && i + 1 < argc) {
            rawOutputPath = argv[++i];
        } else if (arg == "--input" && i + 1 < argc) {
            inputPath = argv[++i];
        } else if (arg == "--refined-output" && i + 1 < argc) {
            refinedOutputPath = argv[++i];
        } else if (arg == "--stream") {
            streamStdout = true;
        } else if (arg == "--res" && i + 1 < argc) {
            texResolution = std::stoi(argv[++i]);
        } else if (arg == "--angle" && i + 1 < argc) {
            planarAngleThreshold = std::stof(argv[++i]);
        } else if (arg == "--snap" && i + 1 < argc) {
            cornerSnapTol = std::stof(argv[++i]);
        } else if (arg == "--age" && i + 1 < argc) {
            patina.buildingAgeYears = std::stof(argv[++i]);
        } else if (arg == "--soot" && i + 1 < argc) {
            patina.sootCavityIntensity = std::stof(argv[++i]);
        } else if (arg == "--streaks" && i + 1 < argc) {
            patina.rainStreakIntensity = std::stof(argv[++i]);
        } else if (arg == "--verdigris" && i + 1 < argc) {
            patina.copperVerdigrisIntensity = std::stof(argv[++i]);
        } else if (arg == "--abrasion" && i + 1 < argc) {
            patina.edgeAbrasionFactor = std::stof(argv[++i]);
        }
    }

    if (!streamStdout) {
        std::cout << "========================================================\n";
        std::cout << "Scratchbox IDE: 3D Photogrammetry & Tile Cleanup Pipeline\n";
        std::cout << "Headless C++20 Core (In-App / Google Cloud Run)\n";
        std::cout << "========================================================\n";
    }

    auto startTime = std::chrono::high_resolution_clock::now();

    // 1. Ingest Scanned Raw Mesh
    // There is no built-in model: the tile to clean must be given.
    if (inputPath.empty()) {
        std::cerr << "run_tile_cleanup_pipeline needs --input <tile.glb>" << std::endl;
        return 2;
    }
    GltfScene scene = GlbSceneReader::readFile(inputPath);
    if (!scene.ok) {
        std::cerr << "Failed to read input GLB: " << scene.error << std::endl;
        return 1;
    }
    ScratchboxMesh rawMesh = scene.mesh;
    std::string assetTitle = inputPath;
    if (rawMesh.indices.empty()) {
        std::cerr << "Input GLB has no triangles: " << inputPath << std::endl;
        return 1;
    }
    size_t rawTriangles = rawMesh.indices.size() / 3;
    size_t rawVertices = rawMesh.vertices.size();

    if (!rawOutputPath.empty()) {
        std::vector<uint8_t> rawGlb = GlbWriter::serializeToGlb(rawMesh);
        std::ofstream rawFile(rawOutputPath, std::ios::binary);
        if (rawFile.is_open()) {
            rawFile.write(reinterpret_cast<const char*>(rawGlb.data()), rawGlb.size());
            rawFile.close();
        }
    }

    if (!streamStdout) {
        std::cout << "[Stage 1/5] Ingested raw photogrammetry tile (" << assetTitle << "):\n";
        std::cout << "            -> Raw Triangles: " << rawTriangles << "\n";
        std::cout << "            -> Raw Vertices:  " << rawVertices << "\n";
        if (!rawOutputPath.empty()) {
            std::cout << "            -> Exported Raw Scanned Model: " << rawOutputPath << "\n";
        }
    }

    // 2. Planar Decimation (Limited Dissolve on Flat Facades/Roofs)
    PlanarDecimationOptions decOpt;
    decOpt.angleThresholdDegrees = planarAngleThreshold;
    decOpt.targetReductionRatio = 0.70f;
    ScratchboxMesh decimated = PlanarDecimator::decimate(rawMesh, decOpt);
    size_t decimatedTriangles = decimated.indices.size() / 3;

    if (!streamStdout) {
        std::cout << "[Stage 2/5] Planar Decimation completed:\n";
        std::cout << "            -> Decimated Triangles: " << decimatedTriangles << "\n";
        std::cout << "            -> Polygon Reduction:   "
                  << (100.0f * (1.0f - static_cast<float>(decimatedTriangles) / rawTriangles)) << "%\n";
    }

    // 3. Architectural Corner Straightening
    CornerStraighteningOptions cornerOpt;
    cornerOpt.snapToleranceMeters = cornerSnapTol;
    cornerOpt.stepIntervalMeters = 0.5f;
    ScratchboxMesh straightened = CornerStraightener::straighten(decimated, cornerOpt);

    if (!streamStdout) {
        std::cout << "[Stage 3/5] Corner Straightening & Manhattan alignment applied.\n";
    }

    // 4. Semantic Classification, Rooftop Greebles & Vegetation Blob Removal
    SemanticClassification semantic = SemanticMeshSeparator::classifyAndSeparate(straightened, 1.5f, 0.85f, 0.35f);

    if (!streamStdout) {
        std::cout << "[Stage 4/5] Semantic Separation & Blob Replacement:\n";
        std::cout << "            -> Facade Triangles:  " << semantic.facadeMesh.indices.size() / 3 << "\n";
        std::cout << "            -> Rooftop Triangles: " << semantic.rooftopMesh.indices.size() / 3 << "\n";
        std::cout << "            -> Ground Triangles:  " << semantic.groundMesh.indices.size() / 3 << "\n";
        std::cout << "            -> Tree Anchors:      " << semantic.treeAnchorPoints.size() << "\n";
        std::cout << "            -> Rooftop Greebles:  " << semantic.rooftopGreebleAnchors.size() << "\n";
    }

    // 5. Road Elevation Conforming via BVH Raycasting (34th Street Corridor)
    std::vector<Vec3> roadSpline = {
        Vec3(-65.0f, 0.0f, -34.0f),
        Vec3(-30.0f, 0.0f, -34.0f),
        Vec3(0.0f, 0.0f, -34.0f),
        Vec3(30.0f, 0.0f, -34.0f),
        Vec3(65.0f, 0.0f, -34.0f)
    };
    RoadConformingOptions roadOpt;
    roadOpt.roadWidthMeters = 10.0f;
    roadOpt.verticalOffsetMeters = 0.08f;
    ScratchboxMesh conformedRoad = ElevationConformer::conformRoadRibbon(roadSpline, semantic.groundMesh, roadOpt);

    if (!streamStdout) {
        std::cout << "[Stage 5/5] Raycast Elevation Road Ribbon Conformed:\n";
        std::cout << "            -> Road Triangles: " << conformedRoad.indices.size() / 3 << "\n";
    }

    // Analyze Photogrammetric Color & Fenestration Cues from the Raw Aerial Scan
    TextureInformedPalette informedPal = TextureInformedPbrSynthesizer::analyzePhotogrammetryCues(rawMesh);

    // Combine Cleaned Meshes into Single Master Output Scene
    ScratchboxMesh combinedMesh("master_cleaned_tile");
    combinedMesh.append(semantic.facadeMesh);
    combinedMesh.append(semantic.rooftopMesh);
    combinedMesh.append(semantic.groundMesh);
    combinedMesh.append(conformedRoad);

    // Add instanced procedural HVAC units on rooftop anchor points
    for (const auto& anchor : semantic.rooftopGreebleAnchors) {
        // Procedural HVAC chiller box
        float sx = 2.4f, sy = 1.6f, sz = 1.8f;
        uint32_t base = static_cast<uint32_t>(combinedMesh.vertices.size());
        Vec3 c = anchor + Vec3(0, sy * 0.5f, 0);

        Vec3 h(sx * 0.5f, sy * 0.5f, sz * 0.5f);
        Vec4 matCol(0.6f, 0.62f, 0.65f, 1.0f);

        auto addQ = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3, const Vec3& norm) {
            uint32_t b = static_cast<uint32_t>(combinedMesh.vertices.size());
            combinedMesh.addVertex({p0, norm, {0, 0}, matCol});
            combinedMesh.addVertex({p1, norm, {1, 0}, matCol});
            combinedMesh.addVertex({p2, norm, {1, 1}, matCol});
            combinedMesh.addVertex({p3, norm, {0, 1}, matCol});
            combinedMesh.addTriangle(b, b + 1, b + 2);
            combinedMesh.addTriangle(b, b + 2, b + 3);
        };

        // Front / Back
        addQ(c + Vec3(-h.x, -h.y, h.z), c + Vec3(h.x, -h.y, h.z), c + Vec3(h.x, h.y, h.z), c + Vec3(-h.x, h.y, h.z), Vec3(0, 0, 1));
        addQ(c + Vec3(h.x, -h.y, -h.z), c + Vec3(-h.x, -h.y, -h.z), c + Vec3(-h.x, h.y, -h.z), c + Vec3(h.x, h.y, -h.z), Vec3(0, 0, -1));
        // Left / Right
        addQ(c + Vec3(-h.x, -h.y, -h.z), c + Vec3(-h.x, -h.y, h.z), c + Vec3(-h.x, h.y, h.z), c + Vec3(-h.x, h.y, -h.z), Vec3(-1, 0, 0));
        addQ(c + Vec3(h.x, -h.y, h.z), c + Vec3(h.x, -h.y, -h.z), c + Vec3(h.x, h.y, -h.z), c + Vec3(h.x, h.y, h.z), Vec3(1, 0, 0));
        // Top
        addQ(c + Vec3(-h.x, h.y, h.z), c + Vec3(h.x, h.y, h.z), c + Vec3(h.x, h.y, -h.z), c + Vec3(-h.x, h.y, -h.z), Vec3(0, 1, 0));
    }

    if (!refinedOutputPath.empty()) {
        ScratchboxMesh clayRefined = combinedMesh;
        for (auto& v : clayRefined.vertices) {
            v.color = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
        }
        std::vector<uint8_t> refinedGlb = GlbWriter::serializeToGlb(clayRefined);
        std::ofstream refFile(refinedOutputPath, std::ios::binary);
        if (refFile.is_open()) {
            refFile.write(reinterpret_cast<const char*>(refinedGlb.data()), refinedGlb.size());
            refFile.close();
            if (!streamStdout) {
                std::cout << "            -> Exported Vector-Refined Clay Model: " << refinedOutputPath << "\n";
            }
        }
    }

    // Synthesize 6 dedicated multi-material PBR texture sets with biophysical patina & micro-textures
    MultiMaterialPbrResult multiPbr = TextureInformedPbrSynthesizer::synthesizeMultiMaterialSet(informedPal, patina, texResolution, texResolution);

    // Partition the cleaned mesh into 6 semantic architectural submeshes (limestone, bronze, steel, granite, bitumen, streetscape)
    std::vector<ScratchboxMesh> submeshes = TextureInformedPbrSynthesizer::partitionBuildingSubmeshes(combinedMesh, informedPal);

    // Create glTF embedded PNG textures for all 6 materials (24 maps total)
    std::vector<EmbeddedTexture> pbrTextures = TextureInformedPbrSynthesizer::createMultiMaterialGlbTextures(multiPbr);

    auto endTime = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    if (!streamStdout) {
        std::cout << "\n[Texture-Informed Multi-Material Architecture]\n";
        std::cout << "            -> Extracted Facade Albedo: RGB(" << informedPal.dominantFacadeColor.x << ", "
                  << informedPal.dominantFacadeColor.y << ", " << informedPal.dominantFacadeColor.z << ")\n";
        std::cout << "            -> Extracted Glazing Tone:  RGB(" << informedPal.windowGlassColor.x << ", "
                  << informedPal.windowGlassColor.y << ", " << informedPal.windowGlassColor.z << ")\n";
        std::cout << "            -> Window-to-Wall Ratio:    " << (informedPal.windowToWallRatio * 100.0f) << "%\n";
        std::cout << "            -> Detected Floor Spacing:  " << informedPal.detectedFloorHeightMeters << " m\n";
        std::cout << "            -> Detected Bay Spacing:    " << informedPal.detectedBayWidthMeters << " m\n";
        std::cout << "            -> Partitioned Submeshes:   " << submeshes.size() << " semantic submeshes:\n";
        for (size_t s = 0; s < submeshes.size(); ++s) {
            std::cout << "               [" << s << "] " << submeshes[s].name << " (" << (submeshes[s].indices.size() / 3) << " tris)\n";
        }
        std::cout << "            -> Texture Sets Synthesized:" << multiPbr.materials.size() << " dedicated materials @ "
                  << texResolution << "x" << texResolution << "\n";
        std::cout << "            -> Total Embedded Maps:     " << pbrTextures.size() << " PBR texture maps (Albedo, ORM, Normal, Emissive)\n";
        std::cout << "\n[Biophysical Patina & Weathering Telemetry]\n";
        std::cout << "            -> Building Historical Age: " << multiPbr.materials[0].patina.buildingAgeYears << " years (1931-vintage)\n";
        std::cout << "            -> Active Cavity Soot:      " << multiPbr.materials[0].calculatedSootCoveragePercent << "% coverage (12mm mortar & reveals)\n";
        std::cout << "            -> Rain Runoff Streaks:     " << multiPbr.materials[0].calculatedStreakDensityPercent << "% coverage (gravity sill runoff)\n";
        std::cout << "            -> Bronze Verdigris Index:  " << multiPbr.materials[0].calculatedVerdigrisIntensity << " (copper carbonate wash)\n";
        std::cout << "            -> Reoriented Normal (RNM): " << (multiPbr.materials[0].patina.enableRnmBlending ? "Enabled" : "Disabled") << " (macro slope preservation)\n";
        std::cout << "            -> Toksvig Specular AA:     " << (multiPbr.materials[0].patina.enableToksvigFiltering ? "Enabled" : "Disabled") << " (anti-shimmer)\n";
        std::cout << "\n[Micro-Texture & Multi-Material Realism]\n";
        std::cout << "            -> Mat 0 Limestone: Ashlar blocks, oolitic calcitic fossils, stylolite seams, cavity soot\n";
        std::cout << "            -> Mat 1 Bronze:    Stepped ziggurats, vertical flutes, two-tone ridge/valley relief patina\n";
        std::cout << "            -> Mat 2 Steel:     Allegheny 18-8 No. 4 vertical hairline anisotropic scratches, spire beacon\n";
        std::cout << "            -> Mat 3 Granite:   Belgian black stone matrix, quartz/feldspar crystal micro-flecks, mirror gloss\n";
        std::cout << "            -> Mat 4 Bitumen:   Rooftop mineral aggregate ballast, heat-welded seams, copper verdigris coping\n";
        std::cout << "            -> Mat 5 Street:    5ft scored concrete flags, black pitch expansion joints, granite curb, asphalt\n";
        std::cout << "\nSerialization: Writing multi-mesh binary glTF 2.0 (.glb) with " << pbrTextures.size() << " textures to " << outputPath << "...\n";
    }

    std::vector<uint8_t> glbData = GlbWriter::serializeMultiMeshToGlb(submeshes, pbrTextures);
    if (!glbData.empty()) {
        std::ofstream outFile(outputPath, std::ios::binary);
        if (outFile.is_open()) {
            outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            outFile.close();
            if (!streamStdout) {
                std::cout << "SUCCESS: Generated " << glbData.size() << " bytes multi-material glTF 2.0 binary.\n";
                std::cout << "Processing Time: " << elapsedMs << " ms\n";
            }
        }
    }

    // Stream chunk over stdout only when requested (for In-App NativeCppCompilerService and Cloud Run streaming)
    if (streamStdout) {
        GlbWriter::streamChunk("cleaned_tile_chunk", glbData);
    }

    return 0;
}
