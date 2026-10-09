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

// Generates the Empire State Building raw photogrammetric scan with realistic aerial sensor noise and melted corners
ScratchboxMesh createEmpireStateBuildingRawScan() {
    ScratchboxMesh mesh("empire_state_building_raw_photogrammetric_tile");
    mesh.material = PbrMaterial::stoneLimestone();

    // Helper to generate a noisy grid face simulating aerial photogrammetric scan artifacts
    auto addNoisyFace = [&](
        const Vec3& origin, const Vec3& uDir, const Vec3& vDir,
        float uSize, float vSize, int uSteps, int vSteps,
        const Vec3& normal, bool isRoofFace = false, bool isMooringMast = false, bool isSpire = false
    ) {
        uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

        for (int j = 0; j <= vSteps; ++j) {
            float v = static_cast<float>(j) / vSteps;
            for (int i = 0; i <= uSteps; ++i) {
                float u = static_cast<float>(i) / uSteps;
                Vec3 pos = origin + uDir * (u * uSize) + vDir * (v * vSize);

                // Add aerial photogrammetry sensor waviness (±0.045m on flat walls, wavy corners ±0.14m)
                float jitter = std::sin(pos.x * 0.45f) * std::cos(pos.y * 0.35f + pos.z * 0.45f) * 0.045f;
                bool isCorner = (u < 0.07f || u > 0.93f);
                if (isCorner && !isRoofFace) {
                    jitter += std::sin(pos.y * 0.25f) * 0.14f; // Melted corner rounding
                }
                if (isRoofFace) {
                    jitter += std::sin(u * 3.14159f) * std::sin(v * 3.14159f) * 0.08f; // Rooftop terrace sag
                }
                pos += normal * jitter;

                // Baked directional afternoon sunlight simulation (sun from South-West)
                Vec3 sunDir = Vec3(0.55f, 0.70f, 0.45f).normalized();
                float sunShadow = std::clamp(normal.dot(sunDir), 0.26f, 1.0f);
                Vec4 col(0.84f * sunShadow, 0.81f * sunShadow, 0.76f * sunShadow, 1.0f); // Indiana Limestone

                // Authentic fenestration: periodic dark window bays (floor height 3.6m, bay width 2.5m)
                if (!isRoofFace && !isMooringMast && !isSpire && std::abs(normal.y) < 0.35f && pos.y > 2.5f) {
                    float floorPhase = std::fmod(pos.y, 3.6f);
                    float bayPhase = std::fmod(u * uSize, 2.5f);
                    bool isWindow = (floorPhase > 0.95f && floorPhase < 2.85f) && (bayPhase > 0.50f && bayPhase < 2.00f);
                    if (isWindow) {
                        col = Vec4(0.12f * sunShadow + 0.02f, 0.16f * sunShadow + 0.03f, 0.22f * sunShadow + 0.04f, 1.0f);
                    }
                }

                // Mooring Mast tone (cast aluminum / stainless steel)
                if (isMooringMast) {
                    col = Vec4(0.70f * sunShadow + 0.05f, 0.72f * sunShadow + 0.05f, 0.75f * sunShadow + 0.06f, 1.0f);
                }

                // Spire tone (stainless steel) & red beacon at tip
                if (isSpire) {
                    col = Vec4(0.88f * sunShadow + 0.08f, 0.90f * sunShadow + 0.08f, 0.92f * sunShadow + 0.08f, 1.0f);
                    if (pos.y > 218.0f) {
                        col = Vec4(1.0f, 0.15f, 0.05f, 1.0f); // Red aircraft warning beacon
                    }
                }

                // Setback rooftop gravel ballast / tar
                if (isRoofFace && pos.y > 2.0f) {
                    col = Vec4(0.34f, 0.33f, 0.32f, 1.0f);
                }

                // Ground / asphalt & concrete sidewalk
                if (pos.y <= 0.5f) {
                    float distFromCenter = std::max(std::abs(pos.x), std::abs(pos.z));
                    if (distFromCenter > 32.0f) {
                        col = Vec4(0.22f, 0.22f, 0.24f, 1.0f); // Asphalt street
                    } else {
                        col = Vec4(0.68f, 0.67f, 0.65f, 1.0f); // Scored concrete sidewalk
                    }
                }

                // Street perimeter vegetation blob
                if (pos.y < 3.0f && std::abs(normal.y) < 0.35f && (static_cast<int>(pos.x + pos.z) % 8 == 0)) {
                    col = Vec4(0.18f, 0.58f, 0.22f, 1.0f);
                }

                mesh.addVertex({pos, normal, {u, v}, col});
            }
        }

        int rowStride = uSteps + 1;
        for (int j = 0; j < vSteps; ++j) {
            for (int i = 0; i < uSteps; ++i) {
                uint32_t i0 = baseIdx + j * rowStride + i;
                uint32_t i1 = baseIdx + j * rowStride + (i + 1);
                uint32_t i2 = baseIdx + (j + 1) * rowStride + (i + 1);
                uint32_t i3 = baseIdx + (j + 1) * rowStride + i;

                mesh.addTriangle(i0, i1, i2);
                mesh.addTriangle(i0, i2, i3);
            }
        }
    };

    auto addTierBox = [&](const Vec3& center, const Vec3& size, int stepsU, int stepsV, int stepsW, bool hasRoof, bool isMooringMast = false, bool isSpire = false) {
        Vec3 h = size * 0.5f;
        float w = size.x;
        float hgt = size.y;
        float d = size.z;
        // Front (+Z)
        addNoisyFace(center + Vec3(-h.x, -h.y, h.z), Vec3(1, 0, 0), Vec3(0, 1, 0), w, hgt, stepsU, stepsV, Vec3(0, 0, 1), false, isMooringMast, isSpire);
        // Back (-Z)
        addNoisyFace(center + Vec3(h.x, -h.y, -h.z), Vec3(-1, 0, 0), Vec3(0, 1, 0), w, hgt, stepsU, stepsV, Vec3(0, 0, -1), false, isMooringMast, isSpire);
        // Right (+X)
        addNoisyFace(center + Vec3(h.x, -h.y, h.z), Vec3(0, 0, -1), Vec3(0, 1, 0), d, hgt, stepsW, stepsV, Vec3(1, 0, 0), false, isMooringMast, isSpire);
        // Left (-X)
        addNoisyFace(center + Vec3(-h.x, -h.y, -h.z), Vec3(0, 0, 1), Vec3(0, 1, 0), d, hgt, stepsW, stepsV, Vec3(-1, 0, 0), false, isMooringMast, isSpire);
        if (hasRoof) {
            addNoisyFace(center + Vec3(-h.x, h.y, -h.z), Vec3(1, 0, 0), Vec3(0, 0, 1), w, d, stepsU, stepsW, Vec3(0, 1, 0), true, isMooringMast, isSpire);
        }
    };

    auto addSetbackRoof = [&](float wOuter, float dOuter, float wInner, float dInner, float yElev, int steps) {
        float hwo = wOuter * 0.5f, hdo = dOuter * 0.5f;
        float hwi = wInner * 0.5f, hdi = dInner * 0.5f;
        // North / South strips
        addNoisyFace(Vec3(-hwo, yElev, hdi), Vec3(1, 0, 0), Vec3(0, 0, 1), wOuter, hdo - hdi, steps, 3, Vec3(0, 1, 0), true);
        addNoisyFace(Vec3(-hwo, yElev, -hdo), Vec3(1, 0, 0), Vec3(0, 0, 1), wOuter, hdo - hdi, steps, 3, Vec3(0, 1, 0), true);
        // East / West strips
        addNoisyFace(Vec3(-hwo, yElev, -hdi), Vec3(1, 0, 0), Vec3(0, 0, 1), hwo - hwi, dInner, 3, steps, Vec3(0, 1, 0), true);
        addNoisyFace(Vec3(hwi, yElev, -hdi), Vec3(1, 0, 0), Vec3(0, 0, 1), hwo - hwi, dInner, 3, steps, Vec3(0, 1, 0), true);
    };

    // Tier 1: Base Podium (0m - 24m)
    addTierBox(Vec3(0, 12, 0), Vec3(54, 24, 36), 24, 12, 16, false);
    addSetbackRoof(54, 36, 42, 28, 24.0f, 16);

    // Tier 2: Lower Transition Shaft (24m - 52m)
    addTierBox(Vec3(0, 38, 0), Vec3(42, 28, 28), 18, 14, 14, false);
    addSetbackRoof(42, 28, 30, 20, 52.0f, 14);

    // Tier 3: Main Tower Shaft (52m - 140m)
    addTierBox(Vec3(0, 96, 0), Vec3(30, 88, 20), 14, 36, 10, false);
    addSetbackRoof(30, 20, 18, 13, 140.0f, 10); // 86th Floor Observation Deck!

    // Tier 4: Upper Tower & Observation Deck (140m - 168m)
    addTierBox(Vec3(0, 154, 0), Vec3(18, 28, 13), 10, 14, 8, false);
    addSetbackRoof(18, 13, 9, 9, 168.0f, 8); // 102nd Floor Observation Deck!

    // Tier 5: Mooring Mast (168m - 196m)
    addTierBox(Vec3(0, 182, 0), Vec3(9, 28, 9), 8, 14, 8, false, true, false);
    addSetbackRoof(9, 9, 1.6f, 1.6f, 196.0f, 4);

    // Tier 6: Spire & Lightning Mast (196m - 220m)
    addTierBox(Vec3(0, 208, 0), Vec3(1.6f, 24, 1.6f), 4, 12, 4, true, false, true);

    // Surrounding Ground & Streetscape (140m x 140m)
    addNoisyFace(Vec3(-70.0f, 0.0f, -70.0f), Vec3(1, 0, 0), Vec3(0, 0, 1), 140.0f, 140.0f, 28, 28, Vec3(0, 1, 0), true);

    // Street trees / vegetation photogrammetry blobs along sidewalk (5th Ave & 34th St)
    auto addTreeBlob = [&](const Vec3& center, float radius) {
        int segs = 6;
        Vec4 vegColor(0.16f, 0.54f, 0.18f, 1.0f);
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex({center + Vec3(0, radius * 1.2f, 0), Vec3(0, 1, 0), {0.5f, 0.5f}, vegColor});
        for (int i = 0; i < segs; ++i) {
            float th = (float)i / segs * 6.28318f;
            float px = center.x + std::cos(th) * radius;
            float pz = center.z + std::sin(th) * radius;
            float py = center.y + 0.2f;
            Vec3 pos(px, py, pz);
            Vec3 n = (pos - center).normalized();
            mesh.addVertex({pos, n, {0.5f + 0.5f * std::cos(th), 0.5f + 0.5f * std::sin(th)}, vegColor});
            uint32_t cur = base + 1 + i;
            uint32_t next = base + 1 + ((i + 1) % segs);
            mesh.addTriangle(base, cur, next);
        }
    };

    addTreeBlob(Vec3(-38.0f, 0.0f, -22.0f), 2.2f);
    addTreeBlob(Vec3(-38.0f, 0.0f, 0.0f), 2.2f);
    addTreeBlob(Vec3(-38.0f, 0.0f, 22.0f), 2.2f);
    addTreeBlob(Vec3(38.0f, 0.0f, -22.0f), 2.2f);
    addTreeBlob(Vec3(38.0f, 0.0f, 0.0f), 2.2f);
    addTreeBlob(Vec3(38.0f, 0.0f, 22.0f), 2.2f);

    mesh.recomputeNormals();
    return mesh;
}

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
    ScratchboxMesh rawMesh;
    std::string assetTitle = "Empire State Building Procedural Scan";
    if (!inputPath.empty()) {
        GltfScene scene = GlbSceneReader::readFile(inputPath);
        if (!scene.ok) {
            std::cerr << "Failed to read input GLB: " << scene.error << std::endl;
            return 1;
        }
        rawMesh = scene.mesh;
        assetTitle = inputPath;
    } else {
        rawMesh = createEmpireStateBuildingRawScan();
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
