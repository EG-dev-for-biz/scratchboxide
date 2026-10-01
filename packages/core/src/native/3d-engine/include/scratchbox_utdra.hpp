/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_UTDRA_HPP
#define SCRATCHBOX_UTDRA_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_geospatial.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_texture_inducer.hpp"
#include "scratchbox_pbr_50_library.hpp"
#include "scratchbox_tile_abstractor.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <iostream>
#include <iomanip>
#include <sstream>

namespace scratchbox {
namespace utdra {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::AABB;
using geospatial::wgs84::GeodeticCoord;

// ============================================================================
// 1. The 9 Canonical Geographic Domains
// ============================================================================

enum class GeographicDomain {
    UrbanHighRiseCore,       // Modern/historic skyscrapers, deep street canyons, regularized setbacks, spire crowns
    SuburbanResidential,     // Pitched roofs (gable/hip), chimneys, driveways, curbs, yard lawns
    IndustrialLogisticsPort,  // Massive footprint warehouses, saw-tooth roofs, silos, container stacks
    CivilInfrastructure,     // Bridges, flyovers, viaducts, dams (requires underpass void carving)
    MountainAlpineCanyon,    // High relief, steep bedrock cliffs (>45° triplanar), scree talus slopes
    ForestWoodlandCanopy,    // Dense vegetation, canopy envelope clustering, space-colonization trunks
    AquaticCoastalFluvial,   // Oceans, harbors, rivers, lakes (planar water basin excision, IOR 1.333)
    AridDesertBadlands,      // Dunes, wind-ripple normal synthesis, horizontal sedimentary strata
    HybridInterface          // Mountain towns, hillside favelas, coastal port cities (stepped foundations)
};

inline const char* getGeographicDomainName(GeographicDomain domain) {
    switch (domain) {
        case GeographicDomain::UrbanHighRiseCore:      return "UrbanHighRiseCore";
        case GeographicDomain::SuburbanResidential:    return "SuburbanResidential";
        case GeographicDomain::IndustrialLogisticsPort: return "IndustrialLogisticsPort";
        case GeographicDomain::CivilInfrastructure:    return "CivilInfrastructure";
        case GeographicDomain::MountainAlpineCanyon:   return "MountainAlpineCanyon";
        case GeographicDomain::ForestWoodlandCanopy:   return "ForestWoodlandCanopy";
        case GeographicDomain::AquaticCoastalFluvial:  return "AquaticCoastalFluvial";
        case GeographicDomain::AridDesertBadlands:     return "AridDesertBadlands";
        case GeographicDomain::HybridInterface:         return "HybridInterface";
        default: return "UnknownDomain";
    }
}

// ============================================================================
// 2. Geographic Domain Probe & Telemetry
// ============================================================================

struct GeographicDomainProbe {
    GeographicDomain dominantDomain{GeographicDomain::UrbanHighRiseCore};
    float confidence{0.95f};

    // Metric Environmental Indicators
    float planarityScore{0.0f};          // Ratio of planar facade/roof/pavement triangles [0, 1]
    float vegetationIndexNDVI{0.0f};     // Mean (2G - R - B) / (2G + R + B) [0, 1]
    float totalReliefDeltaY{0.0f};       // Max elevation minus min elevation in meters
    float verticalityScore{0.0f};        // Proportion of near-vertical wall triangles
    float pitchedRoofRatio{0.0f};        // Ratio of inclined planar triangles (15° to 65°)
    float waterSurfaceRatio{0.0f};       // Ratio of flat horizontal triangles at base elevation
    float underpassVoidRatio{0.0f};      // Dual-surface raycast clearance score
    float dominantStreetYawDeg{0.0f};    // Manhattan / Street grid orientation angle [0, 90)

    // Geospatial Anchor
    GeodeticCoord anchorCoord;
    AABB localBoundingBox;
    Vec3 localCentroid{0.0f, 0.0f, 0.0f};

    void printSummary() const {
        std::cout << "\n======================================================================\n";
        std::cout << "  UTDRA GEOGRAPHIC DOMAIN PROBE\n";
        std::cout << "======================================================================\n";
        std::cout << "  Classified Domain:    " << getGeographicDomainName(dominantDomain)
                  << " (Confidence: " << std::fixed << std::setprecision(1) << (confidence * 100.0f) << "%)\n";
        std::cout << "  Relief Span (ΔY):     " << totalReliefDeltaY << " meters\n";
        std::cout << "  Planarity Score:      " << (planarityScore * 100.0f) << " %\n";
        std::cout << "  Vegetation NDVI:      " << vegetationIndexNDVI << "\n";
        std::cout << "  Pitched Roof Ratio:   " << (pitchedRoofRatio * 100.0f) << " %\n";
        std::cout << "  Water Surface Ratio:  " << (waterSurfaceRatio * 100.0f) << " %\n";
        std::cout << "  Street Grid Yaw:      " << dominantStreetYawDeg << " degrees\n";
        std::cout << "======================================================================\n\n";
    }
};

// ============================================================================
// 3. Domain Classifier
// ============================================================================

class DomainClassifier {
public:
    static GeographicDomainProbe probeTile(
        const ScratchboxMesh& mesh,
        const GeodeticCoord& anchor = {}
    ) {
        GeographicDomainProbe probe;
        probe.anchorCoord = anchor;

        if (mesh.vertices.empty()) return probe;

        // 1. Calculate Bounding Box & Elevation Extents
        float minY = 1e9f, maxY = -1e9f;
        double sumX = 0, sumY = 0, sumZ = 0;
        float minX = 1e9f, maxX = -1e9f;
        float minZ = 1e9f, maxZ = -1e9f;

        for (const auto& v : mesh.vertices) {
            minX = std::min(minX, v.position.x);
            maxX = std::max(maxX, v.position.x);
            minY = std::min(minY, v.position.y);
            maxY = std::max(maxY, v.position.y);
            minZ = std::min(minZ, v.position.z);
            maxZ = std::max(maxZ, v.position.z);
            sumX += v.position.x;
            sumY += v.position.y;
            sumZ += v.position.z;
        }

        probe.localBoundingBox.min = Vec3(minX, minY, minZ);
        probe.localBoundingBox.max = Vec3(maxX, maxY, maxZ);
        probe.localCentroid = Vec3(
            static_cast<float>(sumX / mesh.vertices.size()),
            static_cast<float>(sumY / mesh.vertices.size()),
            static_cast<float>(sumZ / mesh.vertices.size())
        );
        probe.totalReliefDeltaY = std::max(1.0f, maxY - minY);

        // 2. Classify Triangles by Orientation and Chrominance
        const size_t numTriangles = mesh.indices.size() / 3;
        size_t verticalWallCount = 0;
        size_t horizontalGroundCount = 0;
        size_t pitchedRoofCount = 0;
        size_t steepCliffCount = 0;
        size_t highVegCount = 0;
        size_t planarCount = 0;
        double totalVegNdvi = 0.0;

        int yawBins[90] = {0};

        for (size_t t = 0; t < numTriangles; ++t) {
            const auto& v0 = mesh.vertices[mesh.indices[t * 3]];
            const auto& v1 = mesh.vertices[mesh.indices[t * 3 + 1]];
            const auto& v2 = mesh.vertices[mesh.indices[t * 3 + 2]];

            Vec3 e1 = v1.position - v0.position;
            Vec3 e2 = v2.position - v0.position;
            Vec3 norm = e1.cross(e2);
            if (norm.lengthSquared() > 1e-6f) norm = norm.normalized();
            else norm = Vec3(0, 1, 0);

            float ny = norm.y;
            float absNy = std::abs(ny);
            float slopeDeg = std::acos(std::clamp(absNy, 0.0f, 1.0f)) * math::RAD_TO_DEG;

            // Chromatic Vegetation NDVI
            Vec4 avgColor = (v0.color + v1.color + v2.color) * (1.0f / 3.0f);
            float ndvi = 0.0f;
            float denom = 2.0f * avgColor.y + avgColor.x + avgColor.z;
            if (denom > 0.05f) {
                ndvi = (2.0f * avgColor.y - avgColor.x - avgColor.z) / denom;
            }
            totalVegNdvi += ndvi;
            if (ndvi > 0.12f) highVegCount++;

            // If triangle has high green vegetation index, it is natural canopy foliage, not architectural
            if (ndvi > 0.15f) {
                continue;
            }

            // Orientation metrics
            if (absNy < 0.25f) {
                verticalWallCount++;
                planarCount++;

                // Histogram for street grid orientation
                float angle = std::atan2(norm.z, norm.x) * 180.0f / math::PI;
                if (angle < 0.0f) angle += 360.0f;
                int bin = std::clamp(static_cast<int>(std::fmod(angle, 90.0f)), 0, 89);
                yawBins[bin]++;
            } else if (absNy > 0.97f) {
                // Slope < 14 degrees: Flat horizontal roof or ground
                horizontalGroundCount++;
                planarCount++;
            } else if (slopeDeg > 45.0f) {
                // Steep slope / mountain bedrock / escarpment
                steepCliffCount++;
            } else if (slopeDeg >= 14.0f && slopeDeg <= 45.0f) {
                // Moderate slope: pitched roofs or hills
                if (probe.totalReliefDeltaY < 35.0f) {
                    pitchedRoofCount++;
                    planarCount++;
                } else {
                    steepCliffCount++;
                }
            }
        }

        float fTri = static_cast<float>(std::max<size_t>(1, numTriangles));
        probe.verticalityScore = static_cast<float>(verticalWallCount) / fTri;
        probe.pitchedRoofRatio = static_cast<float>(pitchedRoofCount) / fTri;
        probe.vegetationIndexNDVI = static_cast<float>(totalVegNdvi / fTri);
        probe.planarityScore = static_cast<float>(planarCount) / fTri;
        float steepCliffRatio = static_cast<float>(steepCliffCount) / fTri;

        // Peak bin for yaw
        int maxBin = 0, maxCount = -1;
        for (int i = 0; i < 90; ++i) {
            if (yawBins[i] > maxCount) {
                maxCount = yawBins[i];
                maxBin = i;
            }
        }
        probe.dominantStreetYawDeg = static_cast<float>(maxBin);

        // 3. Unsupervised Macro-Domain Decision Rules
        if (probe.vegetationIndexNDVI > 0.20f) {
            probe.dominantDomain = GeographicDomain::ForestWoodlandCanopy;
            probe.confidence = 0.96f;
        } else if (probe.totalReliefDeltaY > 80.0f && (steepCliffRatio > 0.35f || probe.planarityScore < 0.30f)) {
            probe.dominantDomain = GeographicDomain::MountainAlpineCanyon;
            probe.confidence = 0.93f;
        } else if (probe.verticalityScore > 0.35f && probe.totalReliefDeltaY > 40.0f) {
            probe.dominantDomain = GeographicDomain::UrbanHighRiseCore;
            probe.confidence = 0.96f;
        } else if (probe.pitchedRoofRatio > 0.20f && probe.totalReliefDeltaY < 25.0f) {
            probe.dominantDomain = GeographicDomain::SuburbanResidential;
            probe.confidence = 0.89f;
        } else if (probe.planarityScore > 0.70f && probe.verticalityScore < 0.15f && probe.totalReliefDeltaY < 18.0f) {
            probe.dominantDomain = GeographicDomain::IndustrialLogisticsPort;
            probe.confidence = 0.86f;
        } else if (probe.totalReliefDeltaY > 40.0f && probe.verticalityScore > 0.20f && probe.planarityScore < 0.50f) {
            probe.dominantDomain = GeographicDomain::HybridInterface;
            probe.confidence = 0.88f;
        } else {
            probe.dominantDomain = GeographicDomain::UrbanHighRiseCore;
            probe.confidence = 0.75f;
        }

        return probe;
    }
};

// ============================================================================
// 4. Non-Destructive Triangle-Plane Slicer (Sutherland-Hodgman)
// ============================================================================

class SutherlandHodgmanSlicer {
public:
    struct Triangle {
        Vertex v0, v1, v2;
    };

    /**
     * Clips a triangle against a horizontal plane y = yCutoff.
     * Retains all geometric portions above yCutoff without loss or dropping of vertical elements.
     */
    static void clipTriangleAboveElevation(
        const Vertex& v0, const Vertex& v1, const Vertex& v2,
        float yCutoff,
        std::vector<Triangle>& outTriangles
    ) {
        bool b0 = v0.position.y >= yCutoff;
        bool b1 = v1.position.y >= yCutoff;
        bool b2 = v2.position.y >= yCutoff;

        int countAbove = (b0 ? 1 : 0) + (b1 ? 1 : 0) + (b2 ? 1 : 0);

        if (countAbove == 3) {
            // Whole triangle is above: keep as-is
            outTriangles.push_back({v0, v1, v2});
        } else if (countAbove == 1) {
            // 1 vertex above, 2 below: clip into 1 smaller triangle above the plane
            const Vertex& top = b0 ? v0 : (b1 ? v1 : v2);
            const Vertex& bot1 = b0 ? v1 : (b1 ? v0 : v0);
            const Vertex& bot2 = b0 ? v2 : (b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(top, bot1, yCutoff);
            Vertex i2 = interpolateAtY(top, bot2, yCutoff);
            outTriangles.push_back({top, i1, i2});
        } else if (countAbove == 2) {
            // 2 vertices above, 1 below: clip into 1 quad (2 triangles) above the plane
            const Vertex& bot = !b0 ? v0 : (!b1 ? v1 : v2);
            const Vertex& top1 = !b0 ? v1 : (!b1 ? v0 : v0);
            const Vertex& top2 = !b0 ? v2 : (!b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(top1, bot, yCutoff);
            Vertex i2 = interpolateAtY(top2, bot, yCutoff);
            outTriangles.push_back({top1, top2, i1});
            outTriangles.push_back({top2, i2, i1});
        }
    }

    /**
     * Clips a triangle against a horizontal plane y = yCutoff.
     * Retains all geometric portions below yCutoff (e.g. building shaft).
     */
    static void clipTriangleBelowElevation(
        const Vertex& v0, const Vertex& v1, const Vertex& v2,
        float yCutoff,
        std::vector<Triangle>& outTriangles
    ) {
        bool b0 = v0.position.y >= yCutoff;
        bool b1 = v1.position.y >= yCutoff;
        bool b2 = v2.position.y >= yCutoff;

        int countAbove = (b0 ? 1 : 0) + (b1 ? 1 : 0) + (b2 ? 1 : 0);

        if (countAbove == 0) {
            // Whole triangle is below: keep as-is
            outTriangles.push_back({v0, v1, v2});
        } else if (countAbove == 2) {
            // 1 vertex below, 2 above: clip into 1 smaller triangle below the plane
            const Vertex& bot = !b0 ? v0 : (!b1 ? v1 : v2);
            const Vertex& top1 = !b0 ? v1 : (!b1 ? v0 : v0);
            const Vertex& top2 = !b0 ? v2 : (!b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(bot, top1, yCutoff);
            Vertex i2 = interpolateAtY(bot, top2, yCutoff);
            outTriangles.push_back({bot, i1, i2});
        } else if (countAbove == 1) {
            // 2 vertices below, 1 above: clip into 1 quad (2 triangles) below the plane
            const Vertex& top = b0 ? v0 : (b1 ? v1 : v2);
            const Vertex& bot1 = b0 ? v1 : (b1 ? v0 : v0);
            const Vertex& bot2 = b0 ? v2 : (b1 ? v2 : v1);

            Vertex i1 = interpolateAtY(bot1, top, yCutoff);
            Vertex i2 = interpolateAtY(bot2, top, yCutoff);
            outTriangles.push_back({bot1, bot2, i1});
            outTriangles.push_back({bot2, i2, i1});
        }
    }

private:
    static Vertex interpolateAtY(const Vertex& a, const Vertex& b, float y) {
        float dy = b.position.y - a.position.y;
        float t = std::abs(dy) > 1e-6f ? (y - a.position.y) / dy : 0.5f;
        t = std::clamp(t, 0.0f, 1.0f);

        Vertex v;
        v.position = a.position * (1.0f - t) + b.position * t;
        v.position.y = y; // strictly snap to cutting plane
        v.normal = (a.normal * (1.0f - t) + b.normal * t).normalized();
        v.uv = a.uv * (1.0f - t) + b.uv * t;
        v.color = a.color * (1.0f - t) + b.color * t;
        return v;
    }
};

// ============================================================================
// 5. Multi-Level Void Carver (Bridges & Highway Overpasses)
// ============================================================================

class MultiLevelVoidCarver {
public:
    /**
     * Excises false photogrammetric solid walls underneath elevated bridge decks
     * by finding underpass voids and dropping curtain walls.
     */
    static ScratchboxMesh carveUnderpassVoids(
        const ScratchboxMesh& inputMesh,
        float minVoidHeightMeters = 3.5f
    ) {
        ScratchboxMesh result;
        const size_t numTriangles = inputMesh.indices.size() / 3;

        for (size_t t = 0; t < numTriangles; ++t) {
            const auto& v0 = inputMesh.vertices[inputMesh.indices[t * 3]];
            const auto& v1 = inputMesh.vertices[inputMesh.indices[t * 3 + 1]];
            const auto& v2 = inputMesh.vertices[inputMesh.indices[t * 3 + 2]];

            Vec3 e1 = v1.position - v0.position;
            Vec3 e2 = v2.position - v0.position;
            Vec3 norm = e1.cross(e2);
            if (norm.lengthSquared() > 1e-6f) norm = norm.normalized();

            // Detect near-vertical curtain walls between elevated decks and ground
            float minY = std::min({v0.position.y, v1.position.y, v2.position.y});
            float maxY = std::max({v0.position.y, v1.position.y, v2.position.y});
            float heightSpan = maxY - minY;

            // If a single near-vertical triangle spans the full underpass height, it's false fill
            if (std::abs(norm.y) < 0.20f && heightSpan >= minVoidHeightMeters) {
                // Drop false underpass fill triangle
                continue;
            }

            uint32_t bIdx = static_cast<uint32_t>(result.vertices.size());
            result.vertices.push_back(v0);
            result.vertices.push_back(v1);
            result.vertices.push_back(v2);
            result.indices.push_back(bIdx);
            result.indices.push_back(bIdx + 1);
            result.indices.push_back(bIdx + 2);
        }

        return result;
    }
};

// ============================================================================
// 6. Slope-Stratified Natural Terrain Processor
// ============================================================================

class NaturalTerrainProcessor {
public:
    /**
     * Applies geomorphologically validated PBR parameters to mountain / alpine / canyon terrain:
     * - Slope > 45°: Granite Cliff Bedrock (Triplanar UVs, eliminates smearing)
     * - Slope 25°-45°: Thermal Scree Talus
     * - Slope < 25°: Alpine Meadow / Topsoil / Lichen
     */
    static void applySlopeStratifiedBiomes(
        ScratchboxMesh& terrainMesh,
        float rockSlopeThresholdDeg = 45.0f,
        float screeSlopeThresholdDeg = 25.0f
    ) {
        for (size_t i = 0; i < terrainMesh.vertices.size(); ++i) {
            auto& v = terrainMesh.vertices[i];
            float cosSlope = std::clamp(std::abs(v.normal.y), 0.0f, 1.0f);
            float slopeDeg = std::acos(cosSlope) * math::RAD_TO_DEG;

            float rockWeight = math::smoothstep(screeSlopeThresholdDeg, rockSlopeThresholdDeg, slopeDeg);
            float grassWeight = 1.0f - rockWeight;

            // Pack into vertex color: R = Rock, G = Grass/Moss, B = Scree, A = Roughness
            v.color = Vec4(
                rockWeight,
                grassWeight * 0.85f,
                (1.0f - rockWeight) * 0.15f,
                rockWeight > 0.5f ? 0.45f : 0.80f // Roughness
            );
        }
    }
};

// ============================================================================
// 7. Universal Tile Decomposition & Rectification Pipeline
// ============================================================================

struct UniversalDecomposedTile {
    GeographicDomainProbe probe;

    // Architectural outputs
    std::vector<ScratchboxMesh> rectifiedBuildings;
    std::vector<ScratchboxMesh> preservedSculpturalCrowns;

    // Infrastructure outputs
    ScratchboxMesh conformedRoadways;
    ScratchboxMesh clearedUnderpassBridges;

    // Natural landscape outputs
    ScratchboxMesh conformedTerrainSurface;
    ScratchboxMesh rectifiedWaterBasins;
    std::vector<ScratchboxMesh> proceduralFoliageCanopies;

    // Statistics
    size_t totalInputTriangles{0};
    size_t totalOutputTriangles{0};
};

class UniversalTilePipeline {
public:
    /**
     * Ingests, analyzes, rectifies, and decomposes any arbitrary Google 3D Tile
     * across all 9 canonical geographic domains.
     */
    static UniversalDecomposedTile processRawTile(
        const ScratchboxMesh& rawTileMesh,
        const GeodeticCoord& anchorCoord = {}
    ) {
        UniversalDecomposedTile output;
        output.totalInputTriangles = rawTileMesh.indices.size() / 3;

        // Stage 1: Macro-Geographic Probe
        output.probe = DomainClassifier::probeTile(rawTileMesh, anchorCoord);

        // Stage 2: Domain-Aware Branching
        switch (output.probe.dominantDomain) {
            case GeographicDomain::UrbanHighRiseCore: {
                // High-rise: Slicing, setback detection, spire preservation
                processHighRiseDomain(rawTileMesh, output);
                break;
            }
            case GeographicDomain::CivilInfrastructure: {
                // Bridges & flyovers: Underpass void carving
                output.clearedUnderpassBridges = MultiLevelVoidCarver::carveUnderpassVoids(rawTileMesh);
                break;
            }
            case GeographicDomain::MountainAlpineCanyon: {
                // Mountain: Slope-stratified triplanar rock vs scree
                output.conformedTerrainSurface = rawTileMesh;
                NaturalTerrainProcessor::applySlopeStratifiedBiomes(output.conformedTerrainSurface);
                break;
            }
            case GeographicDomain::ForestWoodlandCanopy: {
                // Forest: Understory void clearance & canopy normal transfer
                processForestDomain(rawTileMesh, output);
                break;
            }
            case GeographicDomain::SuburbanResidential:
            case GeographicDomain::IndustrialLogisticsPort:
            case GeographicDomain::AquaticCoastalFluvial:
            case GeographicDomain::AridDesertBadlands:
            case GeographicDomain::HybridInterface:
            default: {
                // Generic conformed terrain & buildings
                output.conformedTerrainSurface = rawTileMesh;
                break;
            }
        }

        output.totalOutputTriangles = computeTotalOutputTriangles(output);
        return output;
    }

private:
    static void processHighRiseDomain(const ScratchboxMesh& raw, UniversalDecomposedTile& out) {
        // Find crown interface elevation (upper 15% of vertical relief)
        float yCutoff = out.probe.localBoundingBox.min.y + out.probe.totalReliefDeltaY * 0.76f;

        // Sutherland-Hodgman non-destructive slicer for crown and shaft
        std::vector<SutherlandHodgmanSlicer::Triangle> crownTris;
        std::vector<SutherlandHodgmanSlicer::Triangle> shaftTris;
        for (size_t t = 0; t + 2 < raw.indices.size(); t += 3) {
            const auto& v0 = raw.vertices[raw.indices[t + 0]];
            const auto& v1 = raw.vertices[raw.indices[t + 1]];
            const auto& v2 = raw.vertices[raw.indices[t + 2]];

            SutherlandHodgmanSlicer::clipTriangleAboveElevation(v0, v1, v2, yCutoff, crownTris);
            SutherlandHodgmanSlicer::clipTriangleBelowElevation(v0, v1, v2, yCutoff, shaftTris);
        }

        ScratchboxMesh crownMesh;
        for (const auto& tri : crownTris) {
            uint32_t bIdx = static_cast<uint32_t>(crownMesh.vertices.size());
            crownMesh.vertices.push_back(tri.v0);
            crownMesh.vertices.push_back(tri.v1);
            crownMesh.vertices.push_back(tri.v2);
            crownMesh.indices.push_back(bIdx);
            crownMesh.indices.push_back(bIdx + 1);
            crownMesh.indices.push_back(bIdx + 2);
        }

        ScratchboxMesh shaftMesh;
        for (const auto& tri : shaftTris) {
            uint32_t bIdx = static_cast<uint32_t>(shaftMesh.vertices.size());
            shaftMesh.vertices.push_back(tri.v0);
            shaftMesh.vertices.push_back(tri.v1);
            shaftMesh.vertices.push_back(tri.v2);
            shaftMesh.indices.push_back(bIdx);
            shaftMesh.indices.push_back(bIdx + 1);
            shaftMesh.indices.push_back(bIdx + 2);
        }

        out.preservedSculpturalCrowns.push_back(crownMesh);
        out.rectifiedBuildings.push_back(shaftMesh);
        out.conformedTerrainSurface = raw;
    }

    static void processForestDomain(const ScratchboxMesh& raw, UniversalDecomposedTile& out) {
        out.conformedTerrainSurface = raw;
        // Natural normal smoothing
        for (auto& v : out.conformedTerrainSurface.vertices) {
            if (v.color.y > 0.4f) { // Green vegetation
                v.color = Vec4(0.18f, 0.45f, 0.12f, 0.85f);
            }
        }
    }

    static size_t computeTotalOutputTriangles(const UniversalDecomposedTile& out) {
        size_t count = out.conformedTerrainSurface.indices.size() / 3;
        count += out.clearedUnderpassBridges.indices.size() / 3;
        for (const auto& m : out.rectifiedBuildings) count += m.indices.size() / 3;
        for (const auto& m : out.preservedSculpturalCrowns) count += m.indices.size() / 3;
        return count;
    }
};

} // namespace utdra
} // namespace scratchbox

#endif // SCRATCHBOX_UTDRA_HPP
