/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Standalone Headless SB-Veggie Parametric Botanical Synthesis & Inversion CLI.
 * Suitable for In-App Native Execution, Service Pipelines, and Cloud Run.
 *
 * Streams binary glTF 2.0 (.glb) chunks or writes to disk.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_sb_veggie_optimizer.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>
#include <sstream>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::sb_veggie;
using namespace scratchbox::botanical;
using namespace scratchbox::io;

// Helper to create a synthetic noisy photogrammetry tree blob for benchmark fitting
static ScratchboxMesh createBenchmarkTreeBlob() {
    ScratchboxMesh blob("benchmark_raw_tree_blob");

    // Ellipsoidal canopy blob centered at y=6.0m
    int uSteps = 16, vSteps = 12;
    float rx = 3.6f, ry = 2.8f, rz = 3.4f;
    Vec3 center(0.0f, 6.0f, 0.0f);

    for (int v = 0; v <= vSteps; ++v) {
        float theta = static_cast<float>(v) / vSteps * PI;
        for (int u = 0; u < uSteps; ++u) {
            float phi = static_cast<float>(u) / uSteps * TWO_PI;

            // Add surface photogrammetry noise
            float noise = std::sin(phi * 3.0f) * std::cos(theta * 4.0f) * 0.25f;
            Vec3 pos(
                center.x + (rx + noise) * std::sin(theta) * std::cos(phi),
                center.y + (ry + noise) * std::cos(theta),
                center.z + (rz + noise) * std::sin(theta) * std::sin(phi)
            );
            blob.addVertex(Vertex{pos, Vec3(0, 1, 0), Vec2(0, 0), Vec4(0.22f, 0.40f, 0.18f, 1.0f)});
        }
    }

    // Cylindrical trunk blob
    int tRings = 8, tRad = 8;
    for (int r = 0; r <= tRings; ++r) {
        float y = static_cast<float>(r) / tRings * 4.0f;
        float radius = 0.55f * (1.0f - y * 0.08f);
        for (int s = 0; s < tRad; ++s) {
            float a = static_cast<float>(s) / tRad * TWO_PI;
            Vec3 pos(std::cos(a) * radius, y, std::sin(a) * radius);
            blob.addVertex(Vertex{pos, Vec3(std::cos(a), 0, std::sin(a)), Vec2(0, 0), Vec4(0.28f, 0.20f, 0.14f, 1.0f)});
        }
    }

    return blob;
}

int main(int argc, char** argv) {
    std::string outputPath = "sb_veggie_output.glb";
    std::string fitScanPath = "";
    std::string archetypeStr = "decurrent";
    bool exportOverlay = false;
    bool sideBySide = false;
    bool runFitBenchmark = false;
    bool generateLeaves = true;
    SbVeggieParams params = SbVeggieParams::createNeutral();
    bool userSeasonSpecified = false;
    float userSeason = 1.0f;
    bool userDensitySpecified = false;
    float userDensity = 1.0f;
    bool enablePbrTextures = true;
    int textureRes = 512;
    bool userColorInfluenceSpecified = false;

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if ((arg == "--output" || arg == "-o" || arg == "--out") && i + 1 < argc) {
            outputPath = argv[++i];
        } else if (arg == "--archetype" && i + 1 < argc) {
            archetypeStr = argv[++i];
        } else if ((arg == "--fit-scan" || arg == "--fitScan" || arg == "--fit" || arg == "--scan") && i + 1 < argc) {
            fitScanPath = argv[++i];
        } else if (arg == "--mode" && i + 1 < argc) {
            std::string mode = argv[++i];
            if (mode == "side-by-side") {
                sideBySide = true;
            } else if (mode == "ghost-overlay") {
                exportOverlay = true;
            } else if (mode == "fitted-summer") {
                userSeasonSpecified = true;
                userSeason = 1.0f;
                params.psi_season = 1.0f;
            } else if (mode == "fitted-autumn") {
                userSeasonSpecified = true;
                userSeason = 0.45f;
                params.psi_season = 0.45f;
            } else if (mode == "winter-manifold" || mode == "winter") {
                generateLeaves = false;
            }
        } else if (arg == "--benchmark-fit" || arg == "--benchmarkFit") {
            runFitBenchmark = true;
        } else if (arg == "--no-leaves" || arg == "--noLeaves" || arg == "--bare") {
            generateLeaves = false;
        } else if (arg == "--pbr-textures" || arg == "--pbrTextures") {
            enablePbrTextures = true;
        } else if (arg == "--no-textures" || arg == "--noTextures") {
            enablePbrTextures = false;
        } else if ((arg == "--texture-res" || arg == "--textureRes") && i + 1 < argc) {
            textureRes = std::stoi(argv[++i]);
        } else if (arg == "--export-overlay" || arg == "--overlay" || arg == "--exportOverlay" || arg == "--overlay-scan") {
            exportOverlay = true;
        } else if (arg == "--side-by-side" || arg == "--sideBySide") {
            sideBySide = true;
        } else if ((arg == "--season" || arg == "--psi") && i + 1 < argc) {
            userSeasonSpecified = true;
            userSeason = std::stof(argv[++i]);
            params.psi_season = userSeason;
        } else if ((arg == "--leaf-density" || arg == "--leafDensity") && i + 1 < argc) {
            userDensitySpecified = true;
            userDensity = std::stof(argv[++i]);
            params.psi_leafDensity = userDensity;
        } else if (arg == "--leaf-morphology" && i + 1 < argc) {
            params.leafMorphology = std::stoi(argv[++i]);
        } else if (arg == "--leaf-cupping" && i + 1 < argc) {
            params.leafCupping = std::stof(argv[++i]);
        } else if (arg == "--branch-curvature" && i + 1 < argc) {
            params.branchCurvature = std::stof(argv[++i]);
        } else if (arg == "--collar-flare" && i + 1 < argc) {
            params.collarFlare = std::stof(argv[++i]);
        } else if (arg == "--wind-x" && i + 1 < argc) {
            params.windVector.x = std::stof(argv[++i]);
        } else if (arg == "--wind-z" && i + 1 < argc) {
            params.windVector.z = std::stof(argv[++i]);
        } else if (arg == "--wind-time" && i + 1 < argc) {
            params.windTimeSeconds = std::stof(argv[++i]);
        } else if ((arg == "--color-influence" || arg == "--colorInfluence") && i + 1 < argc) {
            userColorInfluenceSpecified = true;
            params.colorInfluenceWeight = std::stof(argv[++i]);
        } else if ((arg == "--color-mode" || arg == "--colorMode") && i + 1 < argc) {
            params.colorInfluenceMode = std::stoi(argv[++i]);
        } else if ((arg == "--saturation" || arg == "--sat" || arg == "--saturation-scale" || arg == "--saturationScale") && i + 1 < argc) {
            params.saturationScale = std::stof(argv[++i]);
        } else if (arg.rfind("--beta", 0) == 0 && i + 1 < argc) {
            int modeIdx = std::stoi(arg.substr(6));
            if (modeIdx >= 0 && modeIdx < 16) {
                params.beta[modeIdx] = std::stof(argv[++i]);
            }
        }
    }

    SbVeggieArchetype archetype = SbVeggieArchetype::DecurrentHardwood;
    if (archetypeStr == "conifer") archetype = SbVeggieArchetype::ExcurrentConifer;
    else if (archetypeStr == "palmate") archetype = SbVeggieArchetype::Palmate;
    else if (archetypeStr == "columnar") archetype = SbVeggieArchetype::FastigiateColumnar;

    // 1. Build Canonical Model Template
    auto startBuild = std::chrono::high_resolution_clock::now();
    SbVeggieTemplate tmpl = SbVeggieModelBuilder::buildCanonicalTemplate(archetype);
    auto endBuild = std::chrono::high_resolution_clock::now();
    double buildTimeMs = std::chrono::duration<double, std::milli>(endBuild - startBuild).count();

    SbVeggieOptimizerResult optResult;
    bool didOptimize = false;
    ScratchboxMesh rawScanMesh;
    Vec3 harvestedAnchor(0.0f, 0.0f, 0.0f);
    bool hasExplicitAnchor = false;

    // 2. Perform Inversion Solver if requested
    if (!fitScanPath.empty() || runFitBenchmark) {
        std::vector<Vec3> scanPoints;
        if (!fitScanPath.empty() && fs::exists(fitScanPath)) {
            rawScanMesh = GlbReader::readGlb(fitScanPath);
            std::vector<Vec3> vegPoints;
            float minY = 1e9f;
            Vec3 vegCentroid(0.0f, 0.0f, 0.0f);

            for (const auto& v : rawScanMesh.vertices) {
                const Vec4& c = v.color;
                float sum = c.x + c.y + c.z + 1e-4f;
                float rNorm = c.x / sum, gNorm = c.y / sum, bNorm = c.z / sum;
                float exg = 2.0f * gNorm - rNorm - bNorm;
                if (exg > 0.12f && c.y > c.x * 1.05f) {
                    vegPoints.push_back(v.position);
                    vegCentroid += v.position;
                    if (v.position.y < minY) minY = v.position.y;
                }
            }

            if (vegPoints.size() > 20) {
                scanPoints = vegPoints;
                vegCentroid = vegCentroid * (1.0f / static_cast<float>(vegPoints.size()));
                harvestedAnchor = Vec3(vegCentroid.x, 0.0f, vegCentroid.z);
                hasExplicitAnchor = true;
                std::cout << "[SB-Veggie] Harvested vegetation anchor from scan: (" 
                          << harvestedAnchor.x << ", " << harvestedAnchor.y << ", " << harvestedAnchor.z << ")" << std::endl;
            } else {
                for (const auto& v : rawScanMesh.vertices) {
                    scanPoints.push_back(v.position);
                }
            }
        } else {
            rawScanMesh = createBenchmarkTreeBlob();
            for (const auto& v : rawScanMesh.vertices) {
                scanPoints.push_back(v.position);
            }
        }

        SbVeggieOptimizerOptions opt;
        opt.maxIterations = 25;
        optResult = SbVeggieOptimizer::fitToScan(scanPoints, tmpl, opt, hasExplicitAnchor ? &harvestedAnchor : nullptr);
        int savedMorphology = params.leafMorphology;
        float savedCupping = params.leafCupping;
        float savedCurvature = params.branchCurvature;
        float savedCollar = params.collarFlare;
        float savedColorInfluence = params.colorInfluenceWeight;
        int savedColorMode = params.colorInfluenceMode;
        params = optResult.fittedParams;
        params.leafMorphology = savedMorphology;
        params.leafCupping = savedCupping;
        params.branchCurvature = savedCurvature;
        params.collarFlare = savedCollar;
        params.colorInfluenceWeight = savedColorInfluence;
        params.colorInfluenceMode = savedColorMode;
        if (userSeasonSpecified) {
            params.psi_season = userSeason;
        }
        if (userDensitySpecified) {
            params.psi_leafDensity = userDensity;
        }
        didOptimize = true;
    }

    // 2B. Build Spatial Color Field from Scan if Fitting
    SbVeggieSpatialColorField scanColorField;
    if (didOptimize && rawScanMesh.vertices.size() > 0) {
        Vec3 scanAnchorOffset = hasExplicitAnchor ? Vec3(harvestedAnchor.x, 0.0f, harvestedAnchor.z) : Vec3(0.0f, 0.0f, 0.0f);
        scanColorField.buildFromScan(rawScanMesh, scanAnchorOffset);
        if (!userColorInfluenceSpecified) {
            params.colorInfluenceWeight = 0.85f; // Default 85% photogrammetric color grounding when fitting to a scan
        }
        std::cout << "[SB-Veggie] Built 3D Spatial Color Field from scan (" 
                  << scanColorField.positions.size() << " samples, weight=" 
                  << params.colorInfluenceWeight << ", mode=" 
                  << params.colorInfluenceMode << ")" << std::endl;
    }

    // For standalone models (not overlay/sideBySide), center the fitted tree at origin
    if (!exportOverlay && !sideBySide && hasExplicitAnchor) {
        params.translation = Vec3(0.0f, 0.0f, 0.0f);
    }

    // 3. Evaluate Posed & Shaped Botanical Mesh
    auto startEval = std::chrono::high_resolution_clock::now();
    auto decomposed = SbVeggieEvaluator::evaluateDecomposed(tmpl, params, generateLeaves, &scanColorField);
    ScratchboxMesh finalMesh = decomposed.getCombined();
    auto endEval = std::chrono::high_resolution_clock::now();
    double evalTimeMs = std::chrono::duration<double, std::milli>(endEval - startEval).count();

    // 3B. Synthesize Procedural PBR Textures (Bark & Leaves)
    std::vector<EmbeddedTexture> embeddedTextures;
    if (enablePbrTextures) {
        bool useNeutralAlbedo = (params.colorInfluenceWeight > 0.20f && scanColorField.positions.size() > 0);
        embeddedTextures = BotanicalPbrTextureSynthesizer::createBotanicalEmbeddedTextures(
            textureRes, textureRes, params.psi_season, 42, useNeutralAlbedo
        );
    }

    // 3C. Handle Overlay or Side-by-Side Presentation
    std::vector<uint8_t> glbBytes;
    if (didOptimize && (exportOverlay || sideBySide)) {
        Vec3 centerOffset = hasExplicitAnchor ? Vec3(harvestedAnchor.x, 0.0f, harvestedAnchor.z) : Vec3(0.0f, 0.0f, 0.0f);

        // Find scan horizontal extent for side-by-side spacing
        float maxScanRadius = 3.5f;
        for (const auto& v : rawScanMesh.vertices) {
            float dx = v.position.x - centerOffset.x;
            float dz = v.position.z - centerOffset.z;
            float r = std::sqrt(dx * dx + dz * dz);
            if (r > maxScanRadius) maxScanRadius = r;
        }
        float sideShift = std::max(5.0f, maxScanRadius * 0.95f + 1.5f);
        bool isIsolatedBlob = rawScanMesh.vertices.size() < 3000;

        if (sideBySide) {
            std::string atlasPath = "public/models/botanical_tests/tree_tile_atlas.jpg";
            bool hasScanTexture = false;
            std::vector<uint8_t> scanAtlasJpg;
            if (fs::exists(atlasPath)) {
                std::ifstream f(atlasPath, std::ios::binary | std::ios::ate);
                if (f.is_open()) {
                    std::streamsize sz = f.tellg();
                    f.seekg(0, std::ios::beg);
                    scanAtlasJpg.resize(static_cast<size_t>(sz));
                    if (f.read(reinterpret_cast<char*>(scanAtlasJpg.data()), sz)) {
                        hasScanTexture = true;
                    }
                }
            }

            ScratchboxMesh rawScanTree("RawPhotogrammetryScan");
            rawScanTree.material.name = "material_raw_photogrammetry_scan";
            rawScanTree.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f); // Authentic photogrammetry colors
            rawScanTree.material.roughnessFactor = 0.95f;
            rawScanTree.material.metallicFactor = 0.0f;

            for (size_t t = 0; t + 2 < rawScanMesh.indices.size(); t += 3) {
                uint32_t i0 = rawScanMesh.indices[t];
                uint32_t i1 = rawScanMesh.indices[t+1];
                uint32_t i2 = rawScanMesh.indices[t+2];
                if (i0 >= rawScanMesh.vertices.size() || i1 >= rawScanMesh.vertices.size() || i2 >= rawScanMesh.vertices.size()) continue;

                const auto& v0 = rawScanMesh.vertices[i0];
                const auto& v1 = rawScanMesh.vertices[i1];
                const auto& v2 = rawScanMesh.vertices[i2];

                Vec3 centroid = (v0.position + v1.position + v2.position) * (1.0f / 3.0f);
                float dx = centroid.x - centerOffset.x;
                float dz = centroid.z - centerOffset.z;
                float dist2d = std::sqrt(dx * dx + dz * dz);

                if (isIsolatedBlob || (dist2d < maxScanRadius && centroid.y > 0.05f)) {
                    uint32_t baseIdx = static_cast<uint32_t>(rawScanTree.vertices.size());
                    Vertex nv0 = v0, nv1 = v1, nv2 = v2;
                    nv0.position = (nv0.position - centerOffset) + Vec3(-sideShift, 0.0f, 0.0f);
                    nv1.position = (nv1.position - centerOffset) + Vec3(-sideShift, 0.0f, 0.0f);
                    nv2.position = (nv2.position - centerOffset) + Vec3(-sideShift, 0.0f, 0.0f);
                    
                    // If authentic scan texture atlas is present, use neutral 1.0 color so texture is 100% authentic
                    if (hasScanTexture) {
                        nv0.color = nv1.color = nv2.color = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
                    } else if (v0.color.w > 0.5f && (v0.color.x != 1.0f || v0.color.y != 1.0f || v0.color.z != 1.0f)) {
                        nv0.color = v0.color;
                        nv1.color = v1.color;
                        nv2.color = v2.color;
                    } else {
                        nv0.color = nv1.color = nv2.color = Vec4(0.88f, 0.45f, 0.32f, 1.0f);
                    }
                    rawScanTree.addVertex(nv0);
                    rawScanTree.addVertex(nv1);
                    rawScanTree.addVertex(nv2);
                    rawScanTree.indices.push_back(baseIdx);
                    rawScanTree.indices.push_back(baseIdx + 1);
                    rawScanTree.indices.push_back(baseIdx + 2);
                }
            }

            // Create fitted wood submesh shifted by +sideShift
            ScratchboxMesh fittedWood = decomposed.woodMesh;
            fittedWood.name = "FittedTreeWood";
            for (auto& v : fittedWood.vertices) {
                v.position = (v.position - centerOffset) + Vec3(+sideShift, 0.0f, 0.0f);
            }

            // Create fitted foliage submesh shifted by +sideShift
            ScratchboxMesh fittedFoliage = decomposed.foliageMesh;
            fittedFoliage.name = "FittedTreeFoliage";
            for (auto& v : fittedFoliage.vertices) {
                v.position = (v.position - centerOffset) + Vec3(+sideShift, 0.0f, 0.0f);
            }

            std::vector<ScratchboxMesh> exportSubmeshes;
            exportSubmeshes.push_back(fittedWood);    // Submesh 0 -> Bark material
            if (!fittedFoliage.vertices.empty()) {
                exportSubmeshes.push_back(fittedFoliage); // Submesh 1 -> Foliage material
            }
            int scanSubmeshIdx = static_cast<int>(exportSubmeshes.size());
            exportSubmeshes.push_back(rawScanTree);   // Submesh 2 -> Authentic photogrammetry scan
            
            if (hasScanTexture && !scanAtlasJpg.empty()) {
                EmbeddedTexture scanTex;
                scanTex.usage = TextureUsage::BASE_COLOR;
                scanTex.materialIndex = scanSubmeshIdx;
                scanTex.mimeType = "image/jpeg";
                scanTex.data = std::move(scanAtlasJpg);
                embeddedTextures.push_back(scanTex);
                std::cout << "[run_sb_veggie] Attached authentic tile texture atlas (" 
                          << (scanTex.data.size() / 1024) << " KB) to RawPhotogrammetryScan (material " 
                          << scanSubmeshIdx << ")\n";
            }

            glbBytes = GlbWriter::serializeMultiMeshToGlb(exportSubmeshes, embeddedTextures);
        } else if (exportOverlay) {
            // Ghost overlay: Center both fitted tree and ghost scan at origin
            ScratchboxMesh ghostScan("GhostScanEnvelope");
            ghostScan.material.name = "material_ghost_scan";
            ghostScan.material.baseColorFactor = Vec4(0.92f, 0.20f, 0.45f, 0.45f); // Translucent magenta
            ghostScan.material.roughnessFactor = 0.80f;

            for (size_t t = 0; t + 2 < rawScanMesh.indices.size(); t += 3) {
                uint32_t i0 = rawScanMesh.indices[t];
                uint32_t i1 = rawScanMesh.indices[t+1];
                uint32_t i2 = rawScanMesh.indices[t+2];
                if (i0 >= rawScanMesh.vertices.size() || i1 >= rawScanMesh.vertices.size() || i2 >= rawScanMesh.vertices.size()) continue;

                const auto& v0 = rawScanMesh.vertices[i0];
                const auto& v1 = rawScanMesh.vertices[i1];
                const auto& v2 = rawScanMesh.vertices[i2];

                Vec3 centroid = (v0.position + v1.position + v2.position) * (1.0f / 3.0f);
                float dx = centroid.x - centerOffset.x;
                float dz = centroid.z - centerOffset.z;
                float dist2d = std::sqrt(dx * dx + dz * dz);

                if (isIsolatedBlob || (dist2d < maxScanRadius && centroid.y > 0.05f)) {
                    uint32_t baseIdx = static_cast<uint32_t>(ghostScan.vertices.size());
                    Vertex nv0 = v0, nv1 = v1, nv2 = v2;
                    nv0.position = nv0.position - centerOffset;
                    nv1.position = nv1.position - centerOffset;
                    nv2.position = nv2.position - centerOffset;
                    nv0.color = nv1.color = nv2.color = Vec4(0.92f, 0.20f, 0.45f, 0.45f);
                    ghostScan.addVertex(nv0);
                    ghostScan.addVertex(nv1);
                    ghostScan.addVertex(nv2);
                    ghostScan.indices.push_back(baseIdx);
                    ghostScan.indices.push_back(baseIdx + 1);
                    ghostScan.indices.push_back(baseIdx + 2);
                }
            }

            ScratchboxMesh fittedWood = decomposed.woodMesh;
            fittedWood.name = "FittedTreeWood";
            for (auto& v : fittedWood.vertices) {
                v.position = v.position - centerOffset;
            }

            ScratchboxMesh fittedFoliage = decomposed.foliageMesh;
            fittedFoliage.name = "FittedTreeFoliage";
            for (auto& v : fittedFoliage.vertices) {
                v.position = v.position - centerOffset;
            }

            std::vector<ScratchboxMesh> exportSubmeshes;
            exportSubmeshes.push_back(fittedWood);    // Submesh 0 -> Bark material
            if (!fittedFoliage.vertices.empty()) {
                exportSubmeshes.push_back(fittedFoliage); // Submesh 1 -> Foliage material
            }
            exportSubmeshes.push_back(ghostScan);     // Submesh 2 -> Ghost scan
            glbBytes = GlbWriter::serializeMultiMeshToGlb(exportSubmeshes, embeddedTextures);
        }
    }

    // 4. Export Binary glTF 2.0 (.glb)
    auto parentDir = fs::path(outputPath).parent_path();
    if (!parentDir.empty()) {
        fs::create_directories(parentDir);
    }

    if (glbBytes.empty()) {
        if (!decomposed.foliageMesh.vertices.empty()) {
            // Multi-mesh export with distinct Bark and Foliage PBR materials
            glbBytes = GlbWriter::serializeMultiMeshToGlb({decomposed.woodMesh, decomposed.foliageMesh}, embeddedTextures);
        } else {
            glbBytes = GlbWriter::writeGlb(decomposed.woodMesh, embeddedTextures);
        }
    }

    std::ofstream outFile(outputPath, std::ios::binary);
    if (outFile.is_open()) {
        outFile.write(reinterpret_cast<const char*>(glbBytes.data()), static_cast<std::streamsize>(glbBytes.size()));
        outFile.close();
    }

    // 5. Output Telemetry
    std::cout << "\n======================================================================\n";
    std::cout << "  SCRATCHBOX SB-VEGGIE BOTANICAL SYNTHESIS TELEMETRY\n";
    std::cout << "======================================================================\n";
    std::cout << "  Archetype:               " << archetypeStr << "\n";
    std::cout << "  Canonical Template:      " << tmpl.name << " (" << tmpl.canonicalVertices.size() << " verts, " << tmpl.skeleton.size() << " joints)\n";
    std::cout << "  Template Build Time:     " << buildTimeMs << " ms\n";
    std::cout << "  Evaluator Render Time:   " << evalTimeMs << " ms\n";
    std::cout << "  Wood Vertices / Tris:    " << decomposed.woodMesh.vertices.size() << " / " << (decomposed.woodMesh.indices.size() / 3) << "\n";
    if (!decomposed.foliageMesh.vertices.empty()) {
        std::cout << "  Foliage Vertices / Tris: " << decomposed.foliageMesh.vertices.size() << " / " << (decomposed.foliageMesh.indices.size() / 3) << "\n";
    }
    std::cout << "  Total Output Vertices:   " << finalMesh.vertices.size() << "\n";
    std::cout << "  Total Output Triangles:  " << (finalMesh.indices.size() / 3) << "\n";
    std::cout << "  Embedded PBR Textures:   " << embeddedTextures.size() << " maps (" << (enablePbrTextures ? "ENABLED" : "DISABLED") << ")\n";
    std::cout << "  Saturation Scale:        " << params.saturationScale << (params.saturationScale < 1.0f ? " (muted)" : "") << "\n";
    std::cout << "  Output File:             " << outputPath << " (" << glbBytes.size() << " bytes)\n";

    if (didOptimize) {
        std::cout << "----------------------------------------------------------------------\n";
        std::cout << "  SB-Veggie Inversion Solver Results:\n";
        std::cout << "  Initial Chamfer Error:   " << optResult.initialChamferMeters << " m\n";
        std::cout << "  Final Chamfer Error:     " << optResult.finalChamferMeters << " m\n";
        std::cout << "  Error Reduction:         " << optResult.chamferReductionPercent << " %\n";
        std::cout << "  Iterations Run:          " << optResult.iterationsRun << "\n";
        std::cout << "  Solver Runtime:          " << optResult.solveTimeMs << " ms\n";
        std::cout << "  Fitted Beta[0] (DBH):    " << params.beta[0] << "\n";
        std::cout << "  Fitted Beta[1] (Height): " << params.beta[1] << "\n";
        std::cout << "  Fitted Beta[2] (Spread): " << params.beta[2] << "\n";
        std::cout << "  Asymmetric Bough IK Scaffold Solution (8 Scaffolds):\n";
        for (int i = 0; i < 8; ++i) {
            std::cout << "    Scaffold " << i << ": Yaw=" << optResult.scaffoldAzimuthDeg[i]
                      << " deg, Pitch=" << optResult.scaffoldElevationDeg[i]
                      << " deg, Reach=" << optResult.scaffoldReachScale[i] << "x\n";
        }
    }

    std::cout << "STATUS: SUCCESS\n";
    return 0;
}
