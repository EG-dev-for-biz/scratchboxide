/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_BOTANICAL_PIPELINE_HPP
#define SCRATCHBOX_BOTANICAL_PIPELINE_HPP

/**
 * Scratchbox Unified Botanical & Vegetation Synthesis Pipeline (C++20)
 *
 * Combines Stages 11 through 15 into a single coherent engine pipeline:
 * - Stage 11: Excess Green (ExG) Separation, Ground Anchor Pinning, Envelope
 *             Normal Transfer, Facade Clinging Ivy (IvyGen), Streetscape Replacement
 * - Stage 12: Anatomical 3D Leaves (OvateSimple, SerratedBirch, LobedOakMaple)
 *             with Midrib Furrow, Cupping, Margin Serration & Fibonacci Twig Sprays
 * - Stage 13: Strategy B: Direct Mesh-Conformal Attractor Seeding, Allometric
 *             Caliper Laws (Leonardo da Vinci), and Tree vs. Shrub Arborescent Bifurcation
 * - Stage 14: Blob-Informed Foliage Density & Multi-Tier Leaf Architecture
 *             (Apical, Distal Lateral, and Bilateral Opposing Sprays)
 * - Stage 15: Outward-Arching Branch Architecture: Runions Forward Perception Cone,
 *             Centrifugal Outward Radial Momentum, 120-deg Scaffold Limbs, Cantilever Droop,
 *             and Basal Flare Fluting Isolation
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_tile_cleanup.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <chrono>
#include <stdexcept>
#include <iostream>
#include <iomanip>
#include <algorithm>

namespace scratchbox {
namespace nature {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::Mesh;

enum class BotanicalPipelineMode {
    Tree = 0,                  // Conformal arborescent street/park tree
    Shrub = 1,                 // Multi-stem dense hedge or shrub
    AutoDetect = 2,            // Auto-detect from scan telemetry (clear trunk vs multi-stem)
    IntegratedStreetscape = 3  // Full streetscape replacement (street + sidewalk + tree collar + ivy + tree)
};

struct BotanicalPipelineOptions {
    BotanicalPipelineMode mode{BotanicalPipelineMode::AutoDetect};
    LeafOutline leafOutline{1.95f, 0.45f, 0.55f, 14.0f, 0.0f, 0.42f, 5.0f, 0.0f};
    float leafSize{0.32f};
    Vec4 leafColor{0.18f, 0.44f, 0.12f, 1.0f};
    Vec4 woodColor{0.30f, 0.20f, 0.14f, 1.0f};
    float voxelResolution{0.28f};
    float leafDensityScale{1.0f};
    bool useDetailedLeaves{true};
    bool useTwigSprays{true};
    bool spawnLateralTwigs{true};
    bool transferEnvelopeNormals{true};
    bool enableIvy{false};
    IvyConfig ivyConfig;
    bool includeGhostOverlay{false};
    uint32_t seed{2026};
};

struct BotanicalPipelineTelemetry {
    float totalHeight{0.0f};
    float clearTrunkHeight{0.0f};
    float crownBaseHeight{0.0f};
    float crownHeight{0.0f};
    Vec3 crownCentroid{0, 0, 0};
    Vec3 crownExtents{0, 0, 0};
    float volumetricDensity{0.0f};
    float suggestedBaseCaliper{0.0f};
    int suggestedLeavesPerTip{0};
    bool isShrub{false};
    size_t attractorCount{0};
    size_t outputVertices{0};
    size_t outputTriangles{0};
    double elapsedMs{0.0};

    void printSummary() const {
        std::cout << "\n======================================================================\n";
        std::cout << "  SCRATCHBOX BOTANICAL & VEGETATION PIPELINE TELEMETRY\n";
        std::cout << "======================================================================\n";
        std::cout << "  Vegetation Type:         " << (isShrub ? "Multi-Stem Shrub / Hedge" : "Arborescent Street/Park Tree") << "\n";
        std::cout << "  Total Height:            " << std::fixed << std::setprecision(2) << totalHeight << " m\n";
        std::cout << "  Clear Trunk Height:      " << clearTrunkHeight << " m\n";
        std::cout << "  Crown Base Height:       " << crownBaseHeight << " m\n";
        std::cout << "  Crown Height:            " << crownHeight << " m\n";
        std::cout << "  Crown Centroid:          (" << crownCentroid.x << ", " << crownCentroid.y << ", " << crownCentroid.z << ")\n";
        std::cout << "  Crown Extents:           (" << crownExtents.x << ", " << crownExtents.y << ", " << crownExtents.z << ")\n";
        std::cout << "  Volumetric Density:      " << volumetricDensity << "\n";
        std::cout << "  Suggested Base Caliper:  " << (suggestedBaseCaliper * 2.0f * 100.0f) << " cm dia (" << suggestedBaseCaliper << " m radius)\n";
        std::cout << "  Suggested Leaf Count:    " << suggestedLeavesPerTip << " leaves/spray\n";
        std::cout << "  Conformal Attractors:    " << attractorCount << " points\n";
        std::cout << "  Generated Mesh Size:     " << outputVertices << " vertices, " << outputTriangles << " triangles\n";
        std::cout << "  Synthesis Runtime:       " << elapsedMs << " ms\n";
        std::cout << "======================================================================\n";
    }
};

struct BotanicalPipelineResult {
    ScratchboxMesh treeMesh;
    ScratchboxMesh ivyMesh;
    ScratchboxMesh combinedMesh;
    BotanicalBlobTelemetry blobTelemetry;
    BotanicalPipelineTelemetry telemetry;
};

class BotanicalSynthesisPipeline {
public:
    /**
     * Executes the Unified Botanical Pipeline from an input raw scan or photogrammetric blob.
     * Combines stages 11 to 15: ExG detection, Strategy B conformal seeding, outward-arching
     * space colonization, Da Vinci caliper, detailed multi-tier foliage, and normal transfer.
     */
    static BotanicalPipelineResult runPipeline(
        const ScratchboxMesh& inputScan,
        const BotanicalPipelineOptions& options = {}
    ) {
        auto tStart = std::chrono::high_resolution_clock::now();
        BotanicalPipelineResult result;

        // --------------------------------------------------------------------
        // Stage 11 & 13: ExG Vegetation Detection & Telemetry Extraction
        // --------------------------------------------------------------------
        std::vector<bool> isVeg = cleanup::TileTextureDeLighter::detectVegetationVertices(inputScan, 0.12f);
        size_t vegCount = 0;
        for (bool b : isVeg) if (b) vegCount++;

        // Vegetation is what the scan's colours say it is; a scan without vegetation is an error, never a guessed canopy.
        if (vegCount == 0) {
            throw std::runtime_error("the scan has no vertex-coloured vegetation (excess green); nothing to rebuild");
        }
        BotanicalBlobTelemetry tel = cleanup::BotanicalTelemetryExtractor::extractTelemetry(inputScan, isVeg, options.voxelResolution);

        result.blobTelemetry = tel;

        // --------------------------------------------------------------------
        // Stage 13 & 15: Conformal Space Colonization Configuration
        // --------------------------------------------------------------------
        SpaceColonizationConfig cfg = SpaceColonizationConfig::fromBlobTelemetry(tel);
        cfg.seed = options.seed;
        cfg.leafOutline = options.leafOutline;
        cfg.leafSize = options.leafSize;
        cfg.leafColor = options.leafColor;
        cfg.woodColor = options.woodColor;
        cfg.useDetailedLeaves = options.useDetailedLeaves;
        cfg.useTwigSprays = options.useTwigSprays;
        cfg.spawnLateralTwigs = options.spawnLateralTwigs;
        cfg.leavesPerTip = std::max(2, static_cast<int>(tel.suggestedLeavesPerTip * options.leafDensityScale));

        // Mode overrides
        if (options.mode == BotanicalPipelineMode::Shrub) {
            cfg.isShrub = true;
            cfg.clearTrunkHeight = std::min(cfg.clearTrunkHeight, 0.18f);
        } else if (options.mode == BotanicalPipelineMode::Tree) {
            cfg.isShrub = false;
            if (cfg.clearTrunkHeight < 1.4f) cfg.clearTrunkHeight = 2.0f;
        }

        // --------------------------------------------------------------------
        // Stage 12, 14, 15: Tree Generation Execution
        // (Includes Runions perception cone, centrifugal outward push, 120-deg
        //  scaffold boughs, Da Vinci pipe law, and multi-tier Fibonacci twigs)
        // --------------------------------------------------------------------
        Mesh treeMeshGeom = SpaceColonizationTreeGenerator::generateTree(cfg);
        treeMeshGeom.name = cfg.isShrub ? "ConformalShrub" : "ConformalTree";
        treeMeshGeom.material.roughnessFactor = 0.55f;
        treeMeshGeom.material.metallicFactor = 0.02f;
        treeMeshGeom.material.doubleSided = true; // Stage 14 single-sided PBR fix

        result.treeMesh = treeMeshGeom.toScratchboxMesh();
        result.combinedMesh = result.treeMesh;

        // --------------------------------------------------------------------
        // Stage 11: Facade Clinging Ivy Generation (IvyGen)
        // --------------------------------------------------------------------
        if (options.enableIvy) {
            Mesh ivyGeom = IvyGrowthGenerator::generateIvy(options.ivyConfig);
            ivyGeom.name = "ClingingIvy";
            ivyGeom.material.roughnessFactor = 0.50f;
            ivyGeom.material.doubleSided = true;
            result.ivyMesh = ivyGeom.toScratchboxMesh();

            uint32_t baseOffset = static_cast<uint32_t>(result.combinedMesh.vertices.size());
            for (const auto& v : result.ivyMesh.vertices) result.combinedMesh.addVertex(v);
            for (uint32_t idx : result.ivyMesh.indices) result.combinedMesh.indices.push_back(baseOffset + idx);
        }

        // --------------------------------------------------------------------
        // Stage 13: Optional Ghost Scan Overlay for Alignment Verification
        // --------------------------------------------------------------------
        if (options.includeGhostOverlay && !inputScan.vertices.empty()) {
            uint32_t ghostOffset = static_cast<uint32_t>(result.combinedMesh.vertices.size());
            for (size_t i = 0; i < inputScan.vertices.size(); ++i) {
                Vertex v = inputScan.vertices[i];
                v.color = Vec4(0.88f, 0.22f, 0.45f, 0.45f); // High-contrast contour
                result.combinedMesh.addVertex(v);
            }
            for (uint32_t idx : inputScan.indices) {
                result.combinedMesh.indices.push_back(ghostOffset + idx);
            }
        }

        auto tEnd = std::chrono::high_resolution_clock::now();
        double elapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

        // --------------------------------------------------------------------
        // Populate Telemetry
        // --------------------------------------------------------------------
        result.telemetry.totalHeight = tel.totalHeight;
        result.telemetry.clearTrunkHeight = tel.clearTrunkHeight;
        result.telemetry.crownBaseHeight = tel.crownBaseHeight;
        result.telemetry.crownHeight = tel.crownHeight;
        result.telemetry.crownCentroid = tel.crownCentroid;
        result.telemetry.crownExtents = tel.crownExtents;
        result.telemetry.volumetricDensity = tel.volumetricDensity;
        result.telemetry.suggestedBaseCaliper = tel.suggestedBaseRadius;
        result.telemetry.suggestedLeavesPerTip = cfg.leavesPerTip;
        result.telemetry.isShrub = cfg.isShrub;
        result.telemetry.attractorCount = tel.conformalAttractors.size();
        result.telemetry.outputVertices = result.combinedMesh.vertices.size();
        result.telemetry.outputTriangles = result.combinedMesh.indices.size() / 3;
        result.telemetry.elapsedMs = elapsedMs;

        return result;
    }

    /**
     * Replaces photogrammetric vegetation blobs in an entire streetscape with clean
     * procedural geometry, tree pit collars, and facade ivy.
     */
    static BotanicalPipelineResult synthesizeStreetscape(
        const ScratchboxMesh& streetscapeScan,
        const BotanicalPipelineOptions& options = {}
    ) {
        auto tStart = std::chrono::high_resolution_clock::now();
        std::vector<bool> isVeg = cleanup::TileTextureDeLighter::detectVegetationVertices(streetscapeScan, 0.12f);

        // Run botanical synthesis on the isolated vegetation blob
        BotanicalPipelineOptions treeOpt = options;
        treeOpt.mode = BotanicalPipelineMode::Tree;
        BotanicalPipelineResult treeResult = runPipeline(streetscapeScan, treeOpt);

        // Build rectified streetscape (pavement, sidewalk, building facade)
        ScratchboxMesh integratedStreet("RectifiedStreetscapeWithTree");
        integratedStreet.material.roughnessFactor = 0.85f;

        std::vector<int32_t> remap(streetscapeScan.vertices.size(), -1);
        for (size_t t = 0; t + 2 < streetscapeScan.indices.size(); t += 3) {
            uint32_t i0 = streetscapeScan.indices[t];
            uint32_t i1 = streetscapeScan.indices[t + 1];
            uint32_t i2 = streetscapeScan.indices[t + 2];

            if (!isVeg[i0] && !isVeg[i1] && !isVeg[i2]) {
                uint32_t ni[3];
                uint32_t orig[3] = {i0, i1, i2};
                for (int k = 0; k < 3; ++k) {
                    if (remap[orig[k]] < 0) {
                        remap[orig[k]] = static_cast<int32_t>(integratedStreet.vertices.size());
                        Vertex v = streetscapeScan.vertices[orig[k]];
                        if (v.position.z < -5.0f) {
                            v.color = Vec4(0.82f, 0.80f, 0.78f, 1.0f); // Clean limestone facade
                        } else if (v.position.z > 0.0f) {
                            v.color = Vec4(0.24f, 0.24f, 0.26f, 1.0f); // Clean asphalt roadway
                        } else {
                            v.color = Vec4(0.70f, 0.70f, 0.72f, 1.0f); // Clean concrete sidewalk
                        }
                        integratedStreet.addVertex(v);
                    }
                    ni[k] = static_cast<uint32_t>(remap[orig[k]]);
                }
                integratedStreet.addTriangle(ni[0], ni[1], ni[2]);
            }
        }

        // Add cobblestone tree pit collar around ground anchor
        Vec3 anchor = treeResult.blobTelemetry.groundAnchor;
        float pitRInner = 0.50f;
        float pitROuter = 0.75f;
        for (int k = 0; k < 16; ++k) {
            float a0 = (k / 16.0f) * math::TWO_PI;
            float a1 = ((k + 1) / 16.0f) * math::TWO_PI;
            Vec3 pIn0 = anchor + Vec3(std::cos(a0) * pitRInner, 0.04f, std::sin(a0) * pitRInner);
            Vec3 pIn1 = anchor + Vec3(std::cos(a1) * pitRInner, 0.04f, std::sin(a1) * pitRInner);
            Vec3 pOut0 = anchor + Vec3(std::cos(a0) * pitROuter, 0.06f, std::sin(a0) * pitROuter);
            Vec3 pOut1 = anchor + Vec3(std::cos(a1) * pitROuter, 0.06f, std::sin(a1) * pitROuter);
            Vec4 curbCol(0.45f, 0.42f, 0.38f, 1.0f);

            uint32_t cb = static_cast<uint32_t>(integratedStreet.vertices.size());
            integratedStreet.addVertex(Vertex(pIn0, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
            integratedStreet.addVertex(Vertex(pOut0, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
            integratedStreet.addVertex(Vertex(pOut1, Vec3(0, 1, 0), Vec2(0, 0), curbCol));
            integratedStreet.addVertex(Vertex(pIn1, Vec3(0, 1, 0), Vec2(0, 0), curbCol));

            integratedStreet.addTriangle(cb, cb + 1, cb + 2);
            integratedStreet.addTriangle(cb, cb + 2, cb + 3);
        }

        // Plant procedural tree at treeAnchor
        uint32_t treeBase = static_cast<uint32_t>(integratedStreet.vertices.size());
        for (size_t i = 0; i < treeResult.treeMesh.vertices.size(); ++i) {
            Vertex v = treeResult.treeMesh.vertices[i];
            v.position = v.position + anchor;
            integratedStreet.addVertex(v);
        }
        for (uint32_t idx : treeResult.treeMesh.indices) {
            integratedStreet.indices.push_back(treeBase + idx);
        }

        // Add ivy if enabled
        if (options.enableIvy && !treeResult.ivyMesh.vertices.empty()) {
            uint32_t ivyBase = static_cast<uint32_t>(integratedStreet.vertices.size());
            for (size_t i = 0; i < treeResult.ivyMesh.vertices.size(); ++i) {
                Vertex v = treeResult.ivyMesh.vertices[i];
                integratedStreet.addVertex(v);
            }
            for (uint32_t idx : treeResult.ivyMesh.indices) {
                integratedStreet.indices.push_back(ivyBase + idx);
            }
        }

        auto tEnd = std::chrono::high_resolution_clock::now();
        double elapsedMs = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

        BotanicalPipelineResult streetResult = treeResult;
        streetResult.combinedMesh = integratedStreet;
        streetResult.telemetry.outputVertices = integratedStreet.vertices.size();
        streetResult.telemetry.outputTriangles = integratedStreet.indices.size() / 3;
        streetResult.telemetry.elapsedMs = elapsedMs;

        return streetResult;
    }
};

} // namespace nature
} // namespace scratchbox

#endif // SCRATCHBOX_BOTANICAL_PIPELINE_HPP
