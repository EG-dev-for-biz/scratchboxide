/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_CORE_HPP
#define SCRATCHBOX_CORE_HPP

#include "scratchbox_engine.hpp"
#include "scratchbox_infinigen.hpp"
#include "scratchbox_sb_archi.hpp"
#include "scratchbox_tectonics.hpp"
#include "scratchbox_plant_builder.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_io.hpp"

#include <string>
#include <vector>
#include <memory>
#include <functional>

namespace scratchbox {
namespace core {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

enum class RomanOrder {
    Tuscan,
    Doric,
    Ionic,
    Corinthian,
    Composite,
    AtticPilaster
};

// ============================================================================
// 1. GEOMORPH: Geological Terrain Synthesis & Hydrological Sediment
// ============================================================================

struct TerrainOptions {
    float extentX{250.0f};
    float extentZ{250.0f};
    int resolution{160}; // 160x160 = 25,600 vertices (satisfies GeometricComplexityGate >= 25k)
    std::string archetype{"alpine_karst"};
    float domainWarpScale{1.85f};
    int hydraulicErosionSteps{35};
    uint32_t seed{1337};
};

struct TerrainSurface {
    ScratchboxMesh mesh;
    TerrainOptions options;
    infinigen::WarpedTerrainConfig config;
    infinigen::SoilSimulationResult soil;

    float sampleHeight(float x, float z) const {
        return infinigen::DomainWarpedTerrain::sampleHeight(x, z, config);
    }

    Vec3 sampleNormal(float x, float z) const {
        return infinigen::DomainWarpedTerrain::sampleNormal(x, z, config);
    }

    float sampleSlopeDegrees(float x, float z) const {
        Vec3 n = sampleNormal(x, z);
        float cosTheta = std::clamp(n.y, -1.0f, 1.0f);
        return std::acos(cosTheta) * (180.0f / math::PI);
    }
};

/**
 * Synthesizes Princeton Infinigen-grounded domain-warped terrain with
 * soil machine hydraulic erosion sediment and moisture tracking.
 */
TerrainSurface generateGeologicalTerrain(const TerrainOptions& opts);

// ============================================================================
// 2. ARCHIMORPH: Classical Architecture with Vitruvian Grammar
// ============================================================================

struct TempleOptions {
    std::string archetype{"roman_peripteral"};
    RomanOrder order{RomanOrder::Corinthian};
    float footprintLength{42.0f};
    float footprintWidth{24.0f};
    int columnCountX{8};
    int columnCountY{14};
    float columnHeight{7.5f};
    float plinthHeight{1.4f};
    Vec4 stoneColor{0.86f, 0.83f, 0.78f, 1.0f};
    uint32_t seed{1337};
};

/**
 * Constructs an authentic Vitruvian Classical Temple (peripteral colonnade,
 * stepped stylobate podium, fluted columns with entasis, entablature,
 * pediment gable roof, and interior cella).
 */
ScratchboxMesh buildClassicalTemple(const TempleOptions& opts);

// ============================================================================
// 3. SENSOR PASSES: Headless Multimodal Verification (RGB, Depth, Normal)
// ============================================================================

struct SensorPassesOptions {
    int width{512};
    int height{512};
    Vec3 cameraPosition{0.0f, 25.0f, 65.0f};
    Vec3 cameraTarget{0.0f, 6.0f, 0.0f};
    float fovDegrees{45.0f};
    int samplesPerPixel{1};
    uint32_t seed{42};
};

struct SensorPassesResult {
    int width{0};
    int height{0};
    std::vector<float> rgbBeauty;      // width * height * 3 floats in [0, 1]
    std::vector<float> linearDepth;    // width * height floats (metric meters)
    std::vector<float> surfaceNormals; // width * height * 3 floats in [-1, 1]
    float geometryCoverage{0.0f};
    double renderMs{0.0};
    size_t triangleCount{0};
    size_t vertexCount{0};
    float groundElevationContactMin{0.0f};
    float groundElevationContactMax{0.0f};
};

/**
 * Renders the 3 canonical sensor validation passes (RGB Beauty, Linear Metric Depth, Surface Normals)
 * via high-performance CPU BVH pathtracing for multimodal visual critic inspection.
 */
SensorPassesResult renderSensorPasses(
    const ScratchboxMesh& sceneMesh,
    const SensorPassesOptions& opts = {}
);

} // namespace core
} // namespace scratchbox

#endif // SCRATCHBOX_CORE_HPP
