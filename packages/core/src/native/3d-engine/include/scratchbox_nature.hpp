/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_NATURE_HPP
#define SCRATCHBOX_NATURE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <cmath>
#include <algorithm>
#include <vector>
#include <random>

namespace scratchbox {
namespace nature {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;
using geometry::Mesh;
using geometry::ScratchboxMesh;

/**
 * Parameters for Stochastic L-System Tree Generation
 */
struct LSystemTreeParams {
    int maxDepth{4};
    float initialLength{3.2f};
    float initialRadius{0.32f};
    float branchAngleMin{24.0f * math::DEG_TO_RAD};
    float branchAngleMax{38.0f * math::DEG_TO_RAD};
    float lengthDecay{0.72f};
    float gravityDroop{0.08f};
    int childrenPerNode{3};
    bool generateLeaves{true};
    bool useDetailedFoliageCards{true};
    bool transferSmoothNormals{true};
    float normalTransferMixFactor{1.0f};
    float leafSize{0.45f};
    uint32_t seed{42};
};

/**
 * Helper volume representing a foliage cluster envelope (bounding sphere or ellipsoid).
 * Used for transferring smooth shading normals to leaf cards, mirroring the
 * Blender "Data Transfer" modifier on foliage card helper meshes.
 */
struct FoliageClumpHelper {
    Vec3 center{0, 0, 0};
    float radius{1.0f};
    Vec3 eccentricity{1.0f, 1.0f, 1.0f};
    uint32_t clumpId{0};
};

/**
 * Transfers smooth shading directions from helper envelope volumes onto foliage mesh vertices.
 * Solves the harsh, paper-cut, faceted look of raw foliage cards by bending their normals
 * radially outwards from the clump/envelope center (Blender Data Transfer technique).
 */
inline void transferFoliageNormals(
    geometry::Mesh& mesh,
    const std::vector<FoliageClumpHelper>& helpers,
    float mixFactor = 1.0f,
    float upwardBias = 0.20f
) {
    if (helpers.empty() || mesh.vertices.empty()) return;

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        const Vec3& p = mesh.vertices[i];

        // Find nearest helper envelope
        float minDistSq = 1e9f;
        size_t bestHelper = 0;

        for (size_t h = 0; h < helpers.size(); ++h) {
            Vec3 diff = p - helpers[h].center;
            diff.x /= std::max(0.01f, helpers[h].eccentricity.x);
            diff.y /= std::max(0.01f, helpers[h].eccentricity.y);
            diff.z /= std::max(0.01f, helpers[h].eccentricity.z);
            float d2 = diff.lengthSquared();
            if (d2 < minDistSq) {
                minDistSq = d2;
                bestHelper = h;
            }
        }

        // Radial vector from helper center to vertex + upward sky bias for ambient catch
        Vec3 radial = (p - helpers[bestHelper].center).normalized();
        Vec3 targetNormal = (radial + Vec3(0, upwardBias, 0)).normalized();

        // Blend with original normal
        Vec3 blended = math::lerp(mesh.normals[i], targetNormal, std::clamp(mixFactor, 0.0f, 1.0f)).normalized();
        mesh.normals[i] = blended;
    }
}

/**
 * Generates procedural cylindrical branch segments between two 3D points.
 */
inline void appendBranchCylinder(
    geometry::Mesh& mesh,
    const Vec3& start,
    const Vec3& end,
    float rStart,
    float rEnd,
    const Vec4& woodColor,
    int segments = 6
) {
    Vec3 dir = end - start;
    float len = dir.length();
    if (len < 1e-4f) return;
    dir = dir / len;

    // Build orthonormal frame
    Vec3 up = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 side = dir.cross(up).normalized();
    up = side.cross(dir).normalized();

    uint32_t baseIndex = static_cast<uint32_t>(mesh.vertices.size());

    // Generate rings for start and end
    for (int i = 0; i < segments; ++i) {
        float angle = (static_cast<float>(i) / static_cast<float>(segments)) * math::TWO_PI;
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);
        Vec3 ringRadial = side * cosA + up * sinA;

        // Bottom vertex
        mesh.vertices.push_back(start + ringRadial * rStart);
        mesh.normals.push_back(ringRadial);
        mesh.vertexColors.push_back(woodColor);

        // Top vertex
        mesh.vertices.push_back(end + ringRadial * rEnd);
        mesh.normals.push_back(ringRadial);
        mesh.vertexColors.push_back(woodColor);
    }

    // Connect quads as triangles
    for (int i = 0; i < segments; ++i) {
        int next = (i + 1) % segments;
        uint32_t b0 = baseIndex + i * 2;
        uint32_t t0 = baseIndex + i * 2 + 1;
        uint32_t b1 = baseIndex + next * 2;
        uint32_t t1 = baseIndex + next * 2 + 1;

        mesh.indices.push_back(b0);
        mesh.indices.push_back(t0);
        mesh.indices.push_back(b1);

        mesh.indices.push_back(b1);
        mesh.indices.push_back(t0);
        mesh.indices.push_back(t1);
    }
}

/**
 * Appends high-fidelity multi-tier foliage cards with realistic leaf morphology:
 * - Central petiole twig stem.
 * - Staggered alternating/opposite leaf blades.
 * - Automatic transferred clump normals for soft, organic canopy shading.
 * - Vertex colors with chlorophyl base, young leaf tip variation, and clump ambient occlusion.
 */
inline void appendDetailedFoliageCards(
    geometry::Mesh& mesh,
    const Vec3& tipPos,
    const Vec3& branchDir,
    float clusterRadius,
    const FoliageClumpHelper& helper,
    uint32_t& randState,
    int numTwigs = 4
) {
    Vec3 up = std::abs(branchDir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 side = branchDir.cross(up).normalized();
    up = side.cross(branchDir).normalized();

    float angleStep = math::TWO_PI / static_cast<float>(numTwigs);

    for (int t = 0; t < numTwigs; ++t) {
        randState = randState * 1664525u + 1013904223u;
        float r1 = static_cast<float>(randState & 0xFFFF) / 65535.0f;
        randState = randState * 1664525u + 1013904223u;
        float r2 = static_cast<float>(randState & 0xFFFF) / 65535.0f;

        float azimuth = static_cast<float>(t) * angleStep + (r1 - 0.5f) * 0.4f;
        float elevation = 0.2f + r2 * 0.55f;

        Vec3 twigDir = (side * std::cos(azimuth) + up * std::sin(azimuth) + branchDir * elevation).normalized();
        Vec3 twigNormal = twigDir.cross(up).normalized();
        if (twigNormal.lengthSquared() < 0.01f) twigNormal = side;
        Vec3 twigUp = twigNormal.cross(twigDir).normalized();

        // 3-4 leaf pairs along each twig
        int leavesAlongTwig = 3;
        float twigLen = clusterRadius * (0.85f + 0.4f * r1);

        for (int l = 0; l < leavesAlongTwig; ++l) {
            float frac = static_cast<float>(l + 1) / static_cast<float>(leavesAlongTwig);
            Vec3 nodePos = tipPos + twigDir * (twigLen * frac);
            float leafScale = clusterRadius * 0.42f * (1.1f - frac * 0.25f);

            // Left and right leaf blades
            for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
                Vec3 leafDir = (twigNormal * static_cast<float>(sideSign) * 0.85f + twigDir * 0.45f + Vec3(0, 0.2f, 0)).normalized();
                Vec3 leafCross = leafDir.cross(twigUp).normalized();

                uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

                // 4-vertex diamond/lobed leaf blade
                Vec3 p0 = nodePos;
                Vec3 p1 = nodePos + leafDir * (leafScale * 0.5f) + leafCross * (leafScale * 0.32f);
                Vec3 p2 = nodePos + leafDir * (leafScale * 1.15f);
                Vec3 p3 = nodePos + leafDir * (leafScale * 0.5f) - leafCross * (leafScale * 0.32f);

                mesh.vertices.push_back(p0);
                mesh.vertices.push_back(p1);
                mesh.vertices.push_back(p2);
                mesh.vertices.push_back(p3);

                // Compute transferred envelope normal from clump helper
                Vec3 norm0 = (p0 - helper.center).normalized();
                Vec3 norm1 = (p1 - helper.center).normalized();
                Vec3 norm2 = (p2 - helper.center).normalized();
                Vec3 norm3 = (p3 - helper.center).normalized();

                mesh.normals.push_back((norm0 + Vec3(0, 0.2f, 0)).normalized());
                mesh.normals.push_back((norm1 + Vec3(0, 0.2f, 0)).normalized());
                mesh.normals.push_back((norm2 + Vec3(0, 0.2f, 0)).normalized());
                mesh.normals.push_back((norm3 + Vec3(0, 0.2f, 0)).normalized());

                // Color gradient: leaf base is deep emerald, tip is luminous yellow-green
                // Alpha channel encodes clump depth AO
                float distFromClump = (p2 - helper.center).length();
                float clumpAO = std::clamp(distFromClump / std::max(0.1f, helper.radius), 0.35f, 1.0f);

                Vec4 colBase = {0.18f, 0.48f, 0.12f, clumpAO * 0.85f};
                Vec4 colMid  = {0.26f, 0.62f, 0.16f, clumpAO};
                Vec4 colTip  = {0.36f, 0.74f, 0.18f, clumpAO * 1.1f};

                mesh.vertexColors.push_back(colBase);
                mesh.vertexColors.push_back(colMid);
                mesh.vertexColors.push_back(colTip);
                mesh.vertexColors.push_back(colMid);

                // Triangulation (two-sided cards)
                mesh.indices.push_back(baseIdx);
                mesh.indices.push_back(baseIdx + 1);
                mesh.indices.push_back(baseIdx + 2);

                mesh.indices.push_back(baseIdx);
                mesh.indices.push_back(baseIdx + 2);
                mesh.indices.push_back(baseIdx + 3);
            }
        }
    }
}

/**
 * Appends a cluster of translucent foliage leaf diamonds at a branch tip.
 */
inline void appendLeafCluster(
    geometry::Mesh& mesh,
    const Vec3& tipPos,
    const Vec3& branchDir,
    float leafSize,
    const Vec4& leafColor,
    int numLeaves = 4
) {
    Vec3 up = std::abs(branchDir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 side = branchDir.cross(up).normalized();
    up = side.cross(branchDir).normalized();

    for (int i = 0; i < numLeaves; ++i) {
        float angle = (static_cast<float>(i) / static_cast<float>(numLeaves)) * math::TWO_PI;
        Vec3 leafNormal = (side * std::cos(angle) + up * std::sin(angle) + Vec3(0, 0.4f, 0)).normalized();
        Vec3 leafTangent = leafNormal.cross(branchDir).normalized();

        uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

        // Quad leaf
        mesh.vertices.push_back(tipPos);
        mesh.vertices.push_back(tipPos + leafNormal * leafSize + leafTangent * (leafSize * 0.5f));
        mesh.vertices.push_back(tipPos + leafNormal * (leafSize * 1.8f));
        mesh.vertices.push_back(tipPos + leafNormal * leafSize - leafTangent * (leafSize * 0.5f));

        for (int k = 0; k < 4; ++k) {
            mesh.normals.push_back(Vec3(0, 1, 0)); // Point upward for lush ambient lighting
            mesh.vertexColors.push_back(leafColor);
        }

        mesh.indices.push_back(baseIdx);
        mesh.indices.push_back(baseIdx + 1);
        mesh.indices.push_back(baseIdx + 2);

        mesh.indices.push_back(baseIdx);
        mesh.indices.push_back(baseIdx + 2);
        mesh.indices.push_back(baseIdx + 3);
    }
}

/**
 * Recursive L-System Branch Builder using Leonardo da Vinci area preservation.
 */
inline void buildLSystemNode(
    geometry::Mesh& mesh,
    const Vec3& startPos,
    const Vec3& dir,
    float length,
    float radius,
    int depth,
    const LSystemTreeParams& params,
    uint32_t& randState,
    std::vector<FoliageClumpHelper>* outHelpers = nullptr
) {
    if (depth <= 0 || length < 0.1f) {
        if (params.generateLeaves) {
            if (params.useDetailedFoliageCards) {
                FoliageClumpHelper helper{startPos, params.leafSize * 2.2f};
                if (outHelpers) outHelpers->push_back(helper);
                appendDetailedFoliageCards(mesh, startPos, dir, params.leafSize * 1.4f, helper, randState, 4);
            } else {
                Vec4 leafColor = {0.26f, 0.65f, 0.16f, 0.95f};
                appendLeafCluster(mesh, startPos, dir, params.leafSize, leafColor, 5);
            }
        }
        return;
    }

    // Apply gravity droop
    Vec3 endPos = startPos + (dir + Vec3(0, -params.gravityDroop * (5 - depth), 0)).normalized() * length;

    // Bark color (dark rich umber)
    Vec4 woodColor = {0.32f, 0.22f, 0.14f, 0.85f}; // Bark with roughness in alpha

    // Da Vinci radius conservation: r_child = r_parent / sqrt(N)
    float childRadius = radius / std::sqrt(static_cast<float>(params.childrenPerNode));
    appendBranchCylinder(mesh, startPos, endPos, radius, childRadius, woodColor, 6);

    // Orthonormal basis for child branch distribution
    Vec3 up = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 side = dir.cross(up).normalized();
    up = side.cross(dir).normalized();

    float angleStep = math::TWO_PI / static_cast<float>(params.childrenPerNode);

    for (int i = 0; i < params.childrenPerNode; ++i) {
        // Pseudo-random jitter
        randState = randState * 1664525u + 1013904223u;
        float rVal1 = static_cast<float>(randState & 0xFFFF) / 65535.0f;
        randState = randState * 1664525u + 1013904223u;
        float rVal2 = static_cast<float>(randState & 0xFFFF) / 65535.0f;

        float azimuth = static_cast<float>(i) * angleStep + (rVal1 - 0.5f) * 0.45f;
        float pitch = params.branchAngleMin + (params.branchAngleMax - params.branchAngleMin) * rVal2;

        Vec3 radialDir = (side * std::cos(azimuth) + up * std::sin(azimuth)).normalized();
        Vec3 childDir = (dir * std::cos(pitch) + radialDir * std::sin(pitch)).normalized();

        float childLength = length * params.lengthDecay * (0.85f + 0.3f * rVal1);

        buildLSystemNode(
            mesh,
            endPos,
            childDir,
            childLength,
            childRadius,
            depth - 1,
            params,
            randState,
            outHelpers
        );
    }
}

/**
 * Synthesizes a complete procedural tree mesh with trunk, branches, and foliage.
 * When transferSmoothNormals is enabled, automatically transfers normals from
 * foliage cluster envelopes to achieve soft, voluminous organic lighting.
 */
inline geometry::Mesh generateProceduralTree(
    const Vec3& rootPos,
    const LSystemTreeParams& params = LSystemTreeParams(),
    std::vector<FoliageClumpHelper>* outHelpers = nullptr
) {
    geometry::Mesh treeMesh;
    uint32_t randState = params.seed;
    Vec3 trunkDir = {0, 1, 0};

    std::vector<FoliageClumpHelper> localHelpers;
    std::vector<FoliageClumpHelper>* helperPtr = outHelpers ? outHelpers : &localHelpers;

    buildLSystemNode(
        treeMesh,
        rootPos,
        trunkDir,
        params.initialLength,
        params.initialRadius,
        params.maxDepth,
        params,
        randState,
        helperPtr
    );

    if (params.transferSmoothNormals && !helperPtr->empty()) {
        transferFoliageNormals(treeMesh, *helperPtr, params.normalTransferMixFactor);
    }

    return treeMesh;
}

/**
 * Stratified Biome Terrain Generator.
 * Generates an organic terrain mesh where vertex colors encode material blending masks:
 * - Red (R): Exposed Rock Crags (Slope > 38 degrees)
 * - Green (G): Lush Grass & Moss (Gentle slope, high moisture)
 * - Blue (B): Scree & Weathered Gravel
 * - Alpha (A): Cavity Occlusion & Moisture depth
 */
struct BiomeTerrainParams {
    float width{18.0f};
    float depth{18.0f};
    int resolution{48};
    float maxElevation{3.8f};
    float rockSlopeThreshold{35.0f}; // Degrees
    uint32_t seed{123};
};

inline geometry::Mesh generateBiomeTerrain(const BiomeTerrainParams& params = BiomeTerrainParams()) {
    geometry::Mesh mesh;
    int res = params.resolution;
    float dx = params.width / static_cast<float>(res - 1);
    float dz = params.depth / static_cast<float>(res - 1);
    float halfW = params.width * 0.5f;
    float halfD = params.depth * 0.5f;

    // Generate grid vertices with multi-octave FBM elevation
    mesh.vertices.resize(res * res);
    mesh.normals.resize(res * res, {0, 1, 0});
    mesh.vertexColors.resize(res * res, {0, 0, 0, 1});

    for (int z = 0; z < res; ++z) {
        for (int x = 0; x < res; ++x) {
            float wx = -halfW + static_cast<float>(x) * dx;
            float wz = -halfD + static_cast<float>(z) * dz;

            // Multi-frequency terrain elevation
            float macro = FastNoise3D::fbm(wx * 0.12f, 0.0f, wz * 0.12f, 4, 2.0f, 0.5f, params.seed);
            float ridge = std::abs(FastNoise3D::perlin(wx * 0.25f, 0.0f, wz * 0.25f, params.seed + 11));
            float micro = FastNoise3D::fbm(wx * 0.8f, 0.0f, wz * 0.8f, 3, 2.0f, 0.5f, params.seed + 22);

            // Elevated cliff terrace plateau
            float elevation = (macro * 0.65f + (1.0f - ridge) * 0.45f + micro * 0.12f) * params.maxElevation;

            int idx = z * res + x;
            mesh.vertices[idx] = {wx, elevation, wz};
        }
    }

    // Compute indices
    for (int z = 0; z < res - 1; ++z) {
        for (int x = 0; x < res - 1; ++x) {
            uint32_t i0 = static_cast<uint32_t>(z * res + x);
            uint32_t i1 = static_cast<uint32_t>(z * res + (x + 1));
            uint32_t i2 = static_cast<uint32_t>((z + 1) * res + x);
            uint32_t i3 = static_cast<uint32_t>((z + 1) * res + (x + 1));

            mesh.indices.push_back(i0);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i1);

            mesh.indices.push_back(i1);
            mesh.indices.push_back(i2);
            mesh.indices.push_back(i3);
        }
    }

    // Compute smooth normals and slope biome masks
    for (size_t i = 0; i < mesh.indices.size(); i += 3) {
        uint32_t i0 = mesh.indices[i];
        uint32_t i1 = mesh.indices[i + 1];
        uint32_t i2 = mesh.indices[i + 2];

        Vec3 v0 = mesh.vertices[i0];
        Vec3 v1 = mesh.vertices[i1];
        Vec3 v2 = mesh.vertices[i2];

        Vec3 fn = (v1 - v0).cross(v2 - v0);
        mesh.normals[i0] += fn;
        mesh.normals[i1] += fn;
        mesh.normals[i2] += fn;
    }

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        mesh.normals[i] = mesh.normals[i].normalized();

        // Slope angle relative to vertical world up (0, 1, 0)
        float cosSlope = std::clamp(mesh.normals[i].y, 0.0f, 1.0f);
        float slopeDegrees = std::acos(cosSlope) * math::RAD_TO_DEG;

        // Biome blending masks
        float rockFactor = math::smoothstep(params.rockSlopeThreshold - 6.0f, params.rockSlopeThreshold + 8.0f, slopeDegrees);
        float grassFactor = 1.0f - rockFactor;

        // Moisture runoff in depressions
        float moisture = std::clamp(1.0f - mesh.vertices[i].y / params.maxElevation, 0.0f, 1.0f);

        // Pack: R = Rock Strata, G = Grass/Moss, B = Scree Gravel, A = Moisture/AO
        mesh.vertexColors[i] = {
            rockFactor,
            grassFactor * (1.0f - moisture * 0.4f),
            moisture * grassFactor,
            0.85f // Baseline roughness
        };
    }

    return mesh;
}

// ============================================================================
// 4. Geomorphological Erosion Simulators (Hydraulic Stream Power & Thermal Scree)
// ============================================================================

struct HydraulicErosionParams {
    int numDroplets{3000};
    int maxDropletLifetime{25};
    float inertia{0.05f};
    float sedimentCapacityFactor{4.0f};
    float minSedimentCapacity{0.01f};
    float erodeSpeed{0.3f};
    float depositSpeed{0.3f};
    float evaporateSpeed{0.01f};
    float gravity{4.0f};
    float initialWaterVolume{1.0f};
    float initialSpeed{1.0f};
    uint32_t seed{1337};
};

/**
 * Simulates physical hydraulic erosion using kinetic virtual raindrops (Stream Power law).
 * Modulates heightmap by carving stream ravines, transporting silt, and depositing alluvial fans.
 */
inline void simulateHydraulicErosion(
    std::vector<float>& heightmap,
    int width,
    int height,
    const HydraulicErosionParams& params = {}
) {
    if (width < 2 || height < 2 || heightmap.size() != static_cast<size_t>(width * height)) return;

    std::mt19937 rng(params.seed);
    std::uniform_real_distribution<float> distDistX(0.0f, static_cast<float>(width - 2));
    std::uniform_real_distribution<float> distDistY(0.0f, static_cast<float>(height - 2));

    auto sampleHeight = [&](float px, float py) -> float {
        int x0 = std::clamp(static_cast<int>(px), 0, width - 2);
        int y0 = std::clamp(static_cast<int>(py), 0, height - 2);
        float u = px - static_cast<float>(x0);
        float v = py - static_cast<float>(y0);

        float h00 = heightmap[y0 * width + x0];
        float h10 = heightmap[y0 * width + (x0 + 1)];
        float h01 = heightmap[(y0 + 1) * width + x0];
        float h11 = heightmap[(y0 + 1) * width + (x0 + 1)];

        return (1.0f - u) * (1.0f - v) * h00 + u * (1.0f - v) * h10 +
               (1.0f - u) * v * h01 + u * v * h11;
    };

    auto computeGradient = [&](float px, float py) -> Vec2 {
        int x0 = std::clamp(static_cast<int>(px), 0, width - 2);
        int y0 = std::clamp(static_cast<int>(py), 0, height - 2);
        float u = px - static_cast<float>(x0);
        float v = py - static_cast<float>(y0);

        float h00 = heightmap[y0 * width + x0];
        float h10 = heightmap[y0 * width + (x0 + 1)];
        float h01 = heightmap[(y0 + 1) * width + x0];
        float h11 = heightmap[(y0 + 1) * width + (x0 + 1)];

        float gx = (1.0f - v) * (h10 - h00) + v * (h11 - h01);
        float gy = (1.0f - u) * (h01 - h00) + u * (h11 - h10);
        return Vec2(gx, gy);
    };

    for (int d = 0; d < params.numDroplets; ++d) {
        float posX = distDistX(rng);
        float posY = distDistY(rng);
        Vec2 dir(0.0f, 0.0f);
        float speed = params.initialSpeed;
        float water = params.initialWaterVolume;
        float sediment = 0.0f;

        for (int step = 0; step < params.maxDropletLifetime; ++step) {
            int nodeX = static_cast<int>(posX);
            int nodeY = static_cast<int>(posY);
            if (nodeX < 0 || nodeX >= width - 1 || nodeY < 0 || nodeY >= height - 1) break;

            Vec2 grad = computeGradient(posX, posY);
            dir = dir * params.inertia - grad * (1.0f - params.inertia);
            float len = dir.length();
            if (len < 1e-5f) break;
            dir = dir / len;

            float newPosX = posX + dir.x;
            float newPosY = posY + dir.y;
            if (newPosX < 0.0f || newPosX >= static_cast<float>(width - 1) ||
                newPosY < 0.0f || newPosY >= static_cast<float>(height - 1)) {
                break;
            }

            float hOld = sampleHeight(posX, posY);
            float hNew = sampleHeight(newPosX, newPosY);
            float deltaH = hNew - hOld;

            // Compute carrying capacity
            float c = std::max(-deltaH, params.minSedimentCapacity) * speed * water * params.sedimentCapacityFactor;

            int idx = nodeY * width + nodeX;
            if (sediment > c || deltaH > 0.0f) {
                // Deposit sediment
                float amountToDeposit = (deltaH > 0.0f) ? std::min(deltaH, sediment) : (sediment - c) * params.depositSpeed;
                sediment -= amountToDeposit;
                heightmap[idx] += amountToDeposit;
            } else {
                // Erode bedrock
                float amountToErode = std::min((c - sediment) * params.erodeSpeed, -deltaH);
                sediment += amountToErode;
                heightmap[idx] -= amountToErode;
            }

            speed = std::sqrt(std::max(0.0f, speed * speed + deltaH * params.gravity));
            water *= (1.0f - params.evaporateSpeed);
            posX = newPosX;
            posY = newPosY;
        }
    }
}

/**
 * Simulates thermal weathering scree erosion based on talus slope angle of repose.
 * Collapses slopes steeper than talusReposeAngleDegrees downhill.
 */
inline void simulateThermalErosion(
    std::vector<float>& heightmap,
    int width,
    int height,
    float talusReposeAngleDegrees = 35.0f,
    float cellSpacing = 1.0f,
    int iterations = 10,
    float transferRate = 0.5f
) {
    if (width < 2 || height < 2 || heightmap.size() != static_cast<size_t>(width * height)) return;

    float maxSlopeDiff = cellSpacing * std::tan(talusReposeAngleDegrees * math::DEG_TO_RAD);

    for (int iter = 0; iter < iterations; ++iter) {
        std::vector<float> delta(heightmap.size(), 0.0f);

        for (int y = 0; y < height; ++y) {
            for (int x = 0; x < width; ++x) {
                int currIdx = y * width + x;
                float currH = heightmap[currIdx];

                // 4-neighborhood
                const int dx[4] = {1, -1, 0, 0};
                const int dy[4] = {0, 0, 1, -1};

                for (int n = 0; n < 4; ++n) {
                    int nx = x + dx[n];
                    int ny = y + dy[n];
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

                    int nbIdx = ny * width + nx;
                    float diff = currH - heightmap[nbIdx];

                    if (diff > maxSlopeDiff) {
                        float excess = (diff - maxSlopeDiff) * transferRate * 0.25f;
                        delta[currIdx] -= excess;
                        delta[nbIdx] += excess;
                    }
                }
            }
        }

        for (size_t i = 0; i < heightmap.size(); ++i) {
            heightmap[i] += delta[i];
        }
    }
}

// ============================================================================
// 5. Detailed Botanical Leaf & Twig Generator (Infinigen / Sapling / MTree)
// ============================================================================

enum class LeafMorphology {
    OvateSimple,      // Beech, Elm, Magnolia: superelliptic smooth boundary
    SerratedBirch,    // Birch, Cherry, Hornbeam: high-frequency tooth serrations
    LobedOakMaple,    // Oak, Maple, Liquidambar: 5-point lobed margin
    CordateLinden     // Linden, Catalpa: heart-shaped base with pointed tip
};

struct DetailedLeafConfig {
    LeafMorphology morphology{LeafMorphology::OvateSimple};
    float length{0.22f};              // Leaf blade length (meters)
    float widthRatio{0.55f};          // Width-to-length ratio
    float petioleLength{0.05f};       // Stalk length (meters)
    float petioleRadius{0.0035f};     // Stalk radius (meters)
    float midribDepth{0.010f};        // Sunken furrow depth at midrib
    float laminaCupping{0.022f};      // Upward parabolic curl of leaf blade edges
    float droopCurvature{0.028f};     // Downward parabolic droop along the spine
    float serrationFrequency{14.0f};  // Teeth count along leaf margin
    float serrationAmplitude{0.09f};  // Tooth depth modulation
    int lobeCount{5};                 // Lobes for LobedOakMaple
    int lengthSubdivs{5};             // Longitudinal quad resolution along spine
    int widthSubdivs{4};              // Transverse quad resolution across blade
    bool doubleSidedTriangles{false}; // glTF materials use doubleSided=true; avoid duplicate backfaces

    // PBR Vertex Colors
    Vec4 petioleColor{0.32f, 0.44f, 0.18f, 1.0f}; // Woody greenish-brown stem
    Vec4 veinColor{0.44f, 0.74f, 0.22f, 1.0f};    // Luminous yellowish-green midrib & ribs
    Vec4 laminaColor{0.14f, 0.46f, 0.10f, 1.0f};  // Deep rich chlorophyll green
    Vec4 marginColor{0.24f, 0.62f, 0.18f, 1.0f};  // Lighter translucent margin
};

class DetailedLeafGenerator {
public:
    static geometry::Mesh generateLeafMesh(const DetailedLeafConfig& cfg) {
        geometry::Mesh mesh("DetailedLeaf");
        appendDetailedLeaf(mesh, Vec3(0, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, 1), 1.0f, cfg);
        return mesh;
    }

    static void appendDetailedLeaf(
        geometry::Mesh& targetMesh,
        const Vec3& attachPoint,
        const Vec3& growDir,
        const Vec3& normalDir,
        float scale,
        const DetailedLeafConfig& cfg
    ) {
        Vec3 Y = growDir.normalized();
        Vec3 Z = (normalDir - Y * normalDir.dot(Y)).normalized();
        if (Z.lengthSquared() < 1e-4f) {
            Vec3 alt = std::abs(Y.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            Z = (alt - Y * alt.dot(Y)).normalized();
        }
        Vec3 X = Y.cross(Z).normalized();

        int N = std::max(4, cfg.lengthSubdivs);
        int M = std::max(2, (cfg.widthSubdivs / 2) * 2); // Ensure even width count
        int jc = M / 2;

        float leafLen = cfg.length * scale;
        float petLen = cfg.petioleLength * scale;
        float petRad = cfg.petioleRadius * scale;
        float midDepth = cfg.midribDepth * scale;
        float lamCup = cfg.laminaCupping * scale;
        float droop = cfg.droopCurvature * scale;

        // 1. Append Petiole stem if length > 0
        Vec3 laminaBasePos = attachPoint + Y * petLen;
        if (petLen > 1e-4f) {
            int petSegments = 6;
            appendBranchCylinder(targetMesh, attachPoint, laminaBasePos, petRad, petRad * 0.70f, cfg.petioleColor, petSegments);
        }

        uint32_t baseIdx = static_cast<uint32_t>(targetMesh.vertices.size());

        // 2. Build vertices grid
        std::vector<Vec3> localPositions;
        localPositions.reserve((N + 1) * (M + 1));
        std::vector<Vec3> localNormals;
        localNormals.reserve((N + 1) * (M + 1));
        std::vector<Vec4> colors;
        colors.reserve((N + 1) * (M + 1));
        std::vector<Vec2> uvs;
        uvs.reserve((N + 1) * (M + 1));

        for (int i = 0; i <= N; ++i) {
            float t = static_cast<float>(i) / static_cast<float>(N);
            float w0 = 0.0f;

            if (cfg.morphology == LeafMorphology::OvateSimple) {
                w0 = leafLen * cfg.widthRatio * 2.2f * std::pow(std::max(0.001f, t), 0.55f) * std::pow(std::max(0.001f, 1.0f - t), 0.75f);
            } else if (cfg.morphology == LeafMorphology::SerratedBirch) {
                float base = leafLen * cfg.widthRatio * 2.1f * std::pow(std::max(0.001f, t), 0.50f) * std::pow(std::max(0.001f, 1.0f - t), 0.70f);
                float teeth = 1.0f + cfg.serrationAmplitude * std::sin(cfg.serrationFrequency * math::TWO_PI * t);
                w0 = base * std::max(0.2f, teeth);
            } else if (cfg.morphology == LeafMorphology::LobedOakMaple) {
                float base = leafLen * cfg.widthRatio * 1.95f * std::pow(std::max(0.001f, t), 0.45f) * std::pow(std::max(0.001f, 1.0f - t), 0.55f);
                float lobeMod = 1.0f + 0.42f * std::sin(5.0f * math::PI * t) * std::sin(math::PI * t);
                w0 = base * std::max(0.2f, lobeMod);
            } else { // CordateLinden
                float base = leafLen * cfg.widthRatio * 2.0f * (1.1f - t * 0.35f) * std::sin(math::PI * std::pow(std::max(0.001f, t), 0.45f));
                w0 = base;
            }

            if (i == N) w0 = 0.0f; // Apex closes to sharp tip
            if (i == 0) w0 = std::min(w0, petRad * 2.2f); // Base matches petiole

            float zDroop = -droop * (t * t);

            for (int j = 0; j <= M; ++j) {
                float u = static_cast<float>(j - jc) / static_cast<float>(jc); // -1 to 1
                float xLocal = u * (w0 * 0.5f);
                float yLocal = t * leafLen;

                // Sunken midrib groove + parabolic lamina cupping
                float midribFurrow = -midDepth * std::exp(-(u * u) / (2.0f * 0.22f * 0.22f)) * (1.0f - t * 0.5f);
                float laminaCup = lamCup * (u * u);
                float zLocal = zDroop + midribFurrow + laminaCup;

                localPositions.push_back(Vec3(xLocal, yLocal, zLocal));

                // Color gradient
                float midribWeight = std::exp(-(u * u) / (2.0f * 0.22f * 0.22f));
                float marginWeight = std::pow(std::abs(u), 1.6f);
                float laminaWeight = std::max(0.0f, 1.0f - midribWeight - marginWeight);

                Vec4 col = cfg.veinColor * midribWeight + cfg.laminaColor * laminaWeight + cfg.marginColor * marginWeight;
                if (t > 0.85f) {
                    float tipBlend = (t - 0.85f) / 0.15f;
                    col = math::lerp(col, cfg.marginColor, tipBlend * 0.4f);
                }
                colors.push_back(col);
                uvs.push_back(Vec2((u + 1.0f) * 0.5f, t));
            }
        }

        // Compute local normals via central differences
        for (int i = 0; i <= N; ++i) {
            for (int j = 0; j <= M; ++j) {
                int iPrev = std::max(0, i - 1);
                int iNext = std::min(N, i + 1);
                int jPrev = std::max(0, j - 1);
                int jNext = std::min(M, j + 1);

                Vec3 dY = localPositions[iNext * (M + 1) + j] - localPositions[iPrev * (M + 1) + j];
                Vec3 dX = localPositions[i * (M + 1) + jNext] - localPositions[i * (M + 1) + jPrev];

                Vec3 norm = dX.cross(dY).normalized();
                if (norm.z < 0.0f) norm = norm * -1.0f; // Ensure upper facing
                localNormals.push_back(norm);
            }
        }

        // Transform into target world coordinates
        for (size_t k = 0; k < localPositions.size(); ++k) {
            const Vec3& lp = localPositions[k];
            Vec3 worldP = laminaBasePos + X * lp.x + Y * lp.y + Z * lp.z;
            const Vec3& ln = localNormals[k];
            Vec3 worldN = (X * ln.x + Y * ln.y + Z * ln.z).normalized();

            targetMesh.vertices.push_back(worldP);
            targetMesh.normals.push_back(worldN);
            targetMesh.vertexColors.push_back(colors[k]);
            targetMesh.uvs.push_back(uvs[k]);
        }

        // Triangulate grid with front-facing faces (and optional back-faces if enabled)
        for (int i = 0; i < N; ++i) {
            for (int j = 0; j < M; ++j) {
                uint32_t v00 = baseIdx + i * (M + 1) + j;
                uint32_t v10 = baseIdx + (i + 1) * (M + 1) + j;
                uint32_t v11 = baseIdx + (i + 1) * (M + 1) + (j + 1);
                uint32_t v01 = baseIdx + i * (M + 1) + (j + 1);

                // Front face
                targetMesh.indices.push_back(v00);
                targetMesh.indices.push_back(v10);
                targetMesh.indices.push_back(v11);

                targetMesh.indices.push_back(v00);
                targetMesh.indices.push_back(v11);
                targetMesh.indices.push_back(v01);

                if (cfg.doubleSidedTriangles) {
                    // Back face
                    targetMesh.indices.push_back(v00);
                    targetMesh.indices.push_back(v11);
                    targetMesh.indices.push_back(v10);

                    targetMesh.indices.push_back(v00);
                    targetMesh.indices.push_back(v01);
                    targetMesh.indices.push_back(v11);
                }
            }
        }
    }
};

enum class PhyllotaxisPattern {
    GoldenSpiral137,
    AlternateDistichous,
    OppositeDecussate
};

struct TwigClusterConfig {
    float twigLength{0.36f};
    float twigRadiusStart{0.008f};
    float twigRadiusEnd{0.0025f};
    int leafCount{10};
    PhyllotaxisPattern phyllotaxis{PhyllotaxisPattern::GoldenSpiral137};
    float leafScale{1.0f};
    float insertionAngle{42.0f * math::DEG_TO_RAD};
    Vec4 twigColor{0.32f, 0.24f, 0.16f, 1.0f};
    DetailedLeafConfig leafConfig;
};

class TwigClusterGenerator {
public:
    static geometry::Mesh generateTwigCluster(const TwigClusterConfig& cfg) {
        geometry::Mesh mesh("TwigCluster");
        appendTwigCluster(mesh, Vec3(0, 0, 0), Vec3(0, 1, 0), cfg);
        return mesh;
    }

    static void appendTwigCluster(
        geometry::Mesh& targetMesh,
        const Vec3& basePos,
        const Vec3& twigDir,
        const TwigClusterConfig& cfg
    ) {
        Vec3 dir = twigDir.normalized();
        Vec3 up = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        Vec3 side = dir.cross(up).normalized();
        up = side.cross(dir).normalized();

        // 1. Build main micro-twig branch cylinder
        Vec3 endPos = basePos + dir * cfg.twigLength - Vec3(0, cfg.twigLength * 0.12f, 0);
        appendBranchCylinder(targetMesh, basePos, endPos, cfg.twigRadiusStart, cfg.twigRadiusEnd, cfg.twigColor, 6);

        // 2. Attach leaves along the twig
        for (int k = 0; k < cfg.leafCount; ++k) {
            float frac = static_cast<float>(k + 1) / static_cast<float>(cfg.leafCount + 1);
            Vec3 attachP = basePos + dir * (cfg.twigLength * frac) - Vec3(0, cfg.twigLength * 0.12f * (frac * frac), 0);

            // Phyllotactic angle
            float angle = 0.0f;
            if (cfg.phyllotaxis == PhyllotaxisPattern::GoldenSpiral137) {
                angle = static_cast<float>(k) * 137.507764f * math::DEG_TO_RAD;
            } else if (cfg.phyllotaxis == PhyllotaxisPattern::AlternateDistichous) {
                angle = static_cast<float>(k) * math::PI;
            } else { // OppositeDecussate
                angle = static_cast<float>(k / 2) * math::HALF_PI + static_cast<float>(k % 2) * math::PI;
            }

            Vec3 radial = (side * std::cos(angle) + up * std::sin(angle)).normalized();
            Vec3 leafDir = (radial * std::sin(cfg.insertionAngle) + dir * std::cos(cfg.insertionAngle) + Vec3(0, 0.18f, 0)).normalized();
            Vec3 leafNormal = (radial + Vec3(0, 0.45f, 0)).normalized();

            float leafScale = cfg.leafScale * (1.0f - 0.22f * frac);
            DetailedLeafGenerator::appendDetailedLeaf(targetMesh, attachP, leafDir, leafNormal, leafScale, cfg.leafConfig);
        }
    }
};

// ============================================================================
// 6. Space Colonization Tree Generator (Runions et al. 2007 / Mtree)
// ============================================================================

struct BotanicalBlobTelemetry {
    Vec3 groundAnchor{0.0f, 0.0f, 0.0f};
    Vec3 crownCentroid{0.0f, 0.0f, 0.0f};
    Vec3 crownExtents{1.0f, 1.0f, 1.0f}; // (rx, ry, rz)
    float totalHeight{0.0f};
    float crownBaseHeight{0.0f};
    float clearTrunkHeight{0.0f};
    float crownHeight{0.0f};
    float vegetativeSurfaceArea{0.0f};
    float boundingVolume{0.0f};
    float volumetricDensity{0.0f};        // rho in [0, 1]
    int suggestedAttractorCount{500};
    float suggestedBaseRadius{0.25f};
    int suggestedLeavesPerTip{4};
    bool isShrub{false};                  // true if low height or branching from ground
    std::vector<Vec3> conformalAttractors; // Voxel-downsampled vegetative points inside real scanned crown
};

struct SpaceColonizationConfig {
    Vec3 crownCenter{0.0f, 5.5f, 0.0f};
    Vec3 crownExtents{3.2f, 3.8f, 3.2f}; // Ellipsoid radii
    int attractorCount{500};
    float perceptionRadius{2.6f};
    float killRadius{0.65f};
    float branchStepLength{0.45f};
    int maxIterations{100};

    float baseRadius{0.32f};
    float tipRadius{0.025f};
    float daVinciExponent{2.2f};        // r_parent^p = sum(r_child^p)
    float rootFlareMultiplier{1.75f};   // Trunk flare at ground level
    float rootFlareHeight{0.8f};

    bool generateLeaves{true};
    bool useDetailedLeaves{false};
    bool useTwigSprays{false};
    LeafMorphology leafMorphology{LeafMorphology::OvateSimple};
    float leafSize{0.42f};
    int leavesPerTip{4};
    Vec4 woodColor{0.28f, 0.20f, 0.14f, 1.0f};
    Vec4 leafColor{0.18f, 0.45f, 0.12f, 1.0f};
    uint32_t seed{1337};

    // Strategy B: Direct Mesh-Conformal Attractor Seeding
    std::vector<Vec3> customAttractors; // If populated, overrides synthetic ellipsoid
    Vec3 rootAnchor{0.0f, 0.0f, 0.0f};  // Ground contact / root collar position
    float clearTrunkHeight{1.8f};       // Height where branching first starts
    bool isShrub{false};                // If true, multi-stem low-branching shrub

    // Volumetric foliage density controls informed by blob telemetry
    float volumetricDensity{0.65f};     // Extracted density rho from photogrammetric blob
    bool spawnLateralTwigs{true};       // Spawns lateral foliage along distal crown boughs
    float foliageBranchRadiusThreshold{0.075f}; // Max branch radius that supports foliage
    float lateralTwigProbability{0.85f}; // Probability of sprouting a lateral twig per eligible distal node

    // Botanical Outward-Arching and Momentum Controls
    float outwardArchFactor{0.45f};      // Centrifugal outward radial push preventing cage-like inward turning
    float growthMomentumFactor{0.38f};   // Directional inertia along previous branch heading (0 = erratic, 1 = straight)
    float inwardTurnResistance{0.65f};   // Attenuation of attraction vectors pulling back toward the trunk/canopy axis
    float cantileverDroop{0.12f};        // Gravitational downward droop for distal cantilevered branches
    int scaffoldBranchCount{3};          // Number of primary scaffold limbs sprouted at crown break

    static SpaceColonizationConfig fromBlobTelemetry(const BotanicalBlobTelemetry& tel) {
        SpaceColonizationConfig cfg;
        cfg.customAttractors = tel.conformalAttractors;
        cfg.rootAnchor = tel.groundAnchor;
        cfg.crownCenter = tel.crownCentroid;
        cfg.crownExtents = tel.crownExtents;
        cfg.attractorCount = static_cast<int>(tel.conformalAttractors.size());
        cfg.baseRadius = tel.suggestedBaseRadius;
        cfg.clearTrunkHeight = tel.clearTrunkHeight;
        cfg.isShrub = tel.isShrub;
        cfg.volumetricDensity = tel.volumetricDensity;
        cfg.leavesPerTip = tel.suggestedLeavesPerTip;
        cfg.useDetailedLeaves = true;
        cfg.useTwigSprays = true;
        cfg.spawnLateralTwigs = true;
        cfg.foliageBranchRadiusThreshold = tel.isShrub ? 0.055f : 0.075f;
        cfg.lateralTwigProbability = 0.85f;
        cfg.leafSize = tel.isShrub ? 0.20f : 0.36f;
        cfg.perceptionRadius = tel.isShrub ? 1.4f : 2.4f;
        cfg.killRadius = tel.isShrub ? 0.28f : 0.42f;
        cfg.branchStepLength = tel.isShrub ? 0.20f : 0.32f;
        cfg.outwardArchFactor = tel.isShrub ? 0.35f : 0.45f;
        cfg.growthMomentumFactor = 0.38f;
        cfg.inwardTurnResistance = 0.65f;
        cfg.cantileverDroop = tel.isShrub ? 0.06f : 0.12f;
        cfg.scaffoldBranchCount = tel.isShrub ? 4 : 3;
        return cfg;
    }
};

struct ColonizationNode {
    int id{0};
    int parentId{-1};
    Vec3 position{0, 0, 0};
    Vec3 growthDir{0, 1, 0};
    float radius{0.025f};
    std::vector<int> children;
};

class SpaceColonizationTreeGenerator {
public:
    static geometry::Mesh generateTree(const SpaceColonizationConfig& cfg) {
        geometry::Mesh treeMesh;
        std::mt19937 rng(cfg.seed);
        std::uniform_real_distribution<float> distMinus1To1(-1.0f, 1.0f);
        std::uniform_real_distribution<float> dist0To1(0.0f, 1.0f);

        // 1. Gather or scatter attractor points inside crown envelope
        std::vector<Vec3> attractors;
        if (!cfg.customAttractors.empty()) {
            attractors = cfg.customAttractors;
        } else {
            attractors.reserve(cfg.attractorCount);
            while (attractors.size() < static_cast<size_t>(cfg.attractorCount)) {
                Vec3 p(
                    distMinus1To1(rng) * cfg.crownExtents.x,
                    distMinus1To1(rng) * cfg.crownExtents.y,
                    distMinus1To1(rng) * cfg.crownExtents.z
                );
                // Check inside ellipsoid: (x/rx)^2 + (y/ry)^2 + (z/rz)^2 <= 1
                float normD2 = (p.x * p.x) / (cfg.crownExtents.x * cfg.crownExtents.x)
                             + (p.y * p.y) / (cfg.crownExtents.y * cfg.crownExtents.y)
                             + (p.z * p.z) / (cfg.crownExtents.z * cfg.crownExtents.z);
                if (normD2 <= 1.0f) {
                    attractors.push_back(cfg.crownCenter + p);
                }
            }
        }

        // 2. Initialize tree with base root and grow trunk upward toward crown
        std::vector<ColonizationNode> nodes;
        ColonizationNode root;
        root.id = 0;
        root.parentId = -1;
        root.position = cfg.rootAnchor;
        root.growthDir = Vec3(0, 1, 0);
        nodes.push_back(root);

        // Find lowest attractor elevation
        float lowestAttractorY = 1e9f;
        for (const auto& a : attractors) {
            if (a.y < lowestAttractorY) lowestAttractorY = a.y;
        }

        float trunkKillY;
        if (cfg.isShrub) {
            // Shrubs branch almost immediately above the root collar (e.g. 0.15m)
            trunkKillY = cfg.rootAnchor.y + 0.15f;
        } else if (!cfg.customAttractors.empty()) {
            // For conformal tree, advance trunk toward lowest foliage
            float targetTrunkY = cfg.rootAnchor.y + cfg.clearTrunkHeight;
            trunkKillY = std::min(targetTrunkY, lowestAttractorY + 0.2f);
        } else {
            trunkKillY = cfg.crownCenter.y - cfg.crownExtents.y + 0.4f;
        }

        while (nodes.back().position.y < trunkKillY) {
            ColonizationNode nextNode;
            nextNode.id = static_cast<int>(nodes.size());
            nextNode.parentId = nodes.back().id;
            float currentY = nodes.back().position.y;
            float nextY = currentY + cfg.branchStepLength;

            // Organic phototropic trunk lean toward crown centroid
            float tLean = 0.0f;
            if (cfg.crownCenter.y > cfg.rootAnchor.y + 0.5f) {
                tLean = std::clamp((nextY - cfg.rootAnchor.y) / (cfg.crownCenter.y - cfg.rootAnchor.y), 0.0f, 1.0f);
            }
            Vec3 leanOffset = (cfg.crownCenter - cfg.rootAnchor) * (tLean * 0.28f);
            Vec3 targetPos = cfg.rootAnchor + Vec3(leanOffset.x, nextY - cfg.rootAnchor.y, leanOffset.z);
            Vec3 stepDir = (targetPos - nodes.back().position).normalized();

            nextNode.position = nodes.back().position + stepDir * cfg.branchStepLength;
            nextNode.growthDir = stepDir;
            nodes.back().children.push_back(nextNode.id);
            nodes.push_back(nextNode);
        }

        if (cfg.isShrub) {
            int baseNodeId = nodes.back().id;
            // Sprout 4 basal outward radial shoots angled ~35-50 degrees
            for (int k = 0; k < 4; ++k) {
                float angle = (k / 4.0f) * math::TWO_PI + dist0To1(rng) * 0.4f;
                Vec3 radialDir(std::cos(angle) * 0.707f, 0.45f, std::sin(angle) * 0.707f);
                radialDir = radialDir.normalized();
                ColonizationNode stemNode;
                stemNode.id = static_cast<int>(nodes.size());
                stemNode.parentId = baseNodeId;
                stemNode.position = nodes[baseNodeId].position + radialDir * cfg.branchStepLength;
                stemNode.growthDir = radialDir;
                nodes[baseNodeId].children.push_back(stemNode.id);
                nodes.push_back(stemNode);
            }
        } else if (cfg.scaffoldBranchCount >= 2) {
            // For trees: Sprout primary scaffold limbs that flare outward into distinct crown sectors
            int crownBaseNodeId = nodes.back().id;
            for (int k = 0; k < cfg.scaffoldBranchCount; ++k) {
                float angle = (static_cast<float>(k) / static_cast<float>(cfg.scaffoldBranchCount)) * math::TWO_PI + dist0To1(rng) * 0.35f;
                // Scaffold limb diverges upward and outward at ~50 degrees elevation
                Vec3 scaffoldDir(std::cos(angle) * 0.68f, 0.65f, std::sin(angle) * 0.68f);
                scaffoldDir = scaffoldDir.normalized();
                ColonizationNode scaffoldNode;
                scaffoldNode.id = static_cast<int>(nodes.size());
                scaffoldNode.parentId = crownBaseNodeId;
                scaffoldNode.position = nodes[crownBaseNodeId].position + scaffoldDir * cfg.branchStepLength;
                scaffoldNode.growthDir = scaffoldDir;
                nodes[crownBaseNodeId].children.push_back(scaffoldNode.id);
                nodes.push_back(scaffoldNode);
            }
        }

        // 3. Iterative Space Colonization Growth
        float perceptionSq = cfg.perceptionRadius * cfg.perceptionRadius;
        float killSq = cfg.killRadius * cfg.killRadius;

        for (int iter = 0; iter < cfg.maxIterations; ++iter) {
            if (attractors.empty()) break;

            // Map each node to accumulated attraction direction and count
            std::unordered_map<int, Vec3> nodeAttractionDir;
            std::unordered_map<int, int> nodeAttractionCount;

            // Find closest tree node for each attractor
            for (const auto& attr : attractors) {
                float bestDistSq = perceptionSq;
                int bestNode = -1;

                for (const auto& node : nodes) {
                    Vec3 toAttr = attr - node.position;
                    float d2 = toAttr.lengthSquared();
                    if (d2 < bestDistSq) {
                        // Forward perception cone: node only sees attractors ahead or laterally
                        // (dot product >= -0.2 * length prevents 180-degree backward turns)
                        float toAttrLen = std::sqrt(d2);
                        if (toAttr.dot(node.growthDir) >= -0.20f * toAttrLen) {
                            bestDistSq = d2;
                            bestNode = node.id;
                        }
                    }
                }

                if (bestNode >= 0) {
                    Vec3 dir = (attr - nodes[bestNode].position).normalized();
                    nodeAttractionDir[bestNode] += dir;
                    nodeAttractionCount[bestNode]++;
                }
            }

            if (nodeAttractionDir.empty()) break;

            // Sprout new nodes
            std::vector<ColonizationNode> newNodes;
            for (const auto& pair : nodeAttractionDir) {
                int nodeId = pair.first;
                Vec3 avgDir = pair.second / static_cast<float>(nodeAttractionCount[nodeId]);
                if (avgDir.lengthSquared() > 0.0001f) {
                    avgDir = avgDir.normalized();
                } else {
                    avgDir = nodes[nodeId].growthDir;
                }

                // Reference trunk/canopy axis at node elevation
                float tAxis = 0.0f;
                if (cfg.crownCenter.y > cfg.rootAnchor.y + 0.1f) {
                    tAxis = std::clamp((nodes[nodeId].position.y - cfg.rootAnchor.y) / (cfg.crownCenter.y - cfg.rootAnchor.y), 0.0f, 1.0f);
                }
                Vec3 axisPt = cfg.rootAnchor + (cfg.crownCenter - cfg.rootAnchor) * tAxis;
                Vec3 radialVec(nodes[nodeId].position.x - axisPt.x, 0.0f, nodes[nodeId].position.z - axisPt.z);
                float rDist = std::sqrt(radialVec.x * radialVec.x + radialVec.z * radialVec.z);
                Vec3 radialDir = (rDist > 0.05f) ? (radialVec / rDist) : Vec3(1, 0, 0);

                // Blend attraction direction with previous growth momentum
                Vec3 prevDir = nodes[nodeId].growthDir;
                Vec3 combinedDir = prevDir * cfg.growthMomentumFactor + avgDir * (1.0f - cfg.growthMomentumFactor);

                // Outward centrifugal arching push
                float maxCrownR = std::max(0.5f, std::max(cfg.crownExtents.x, cfg.crownExtents.z));
                float normR = std::clamp(rDist / maxCrownR, 0.0f, 1.0f);

                Vec3 outwardPush = radialDir * cfg.outwardArchFactor;
                Vec3 phototropism(0, 0.10f, 0);

                // Cantilever arching droop (gravity causes outer boughs to gracefully arch downward at perimeter)
                Vec3 cantileverDroop(0, -cfg.cantileverDroop * normR, 0);

                Vec3 finalDir = (combinedDir + outwardPush + phototropism + cantileverDroop).normalized();

                ColonizationNode child;
                child.id = static_cast<int>(nodes.size() + newNodes.size());
                child.parentId = nodeId;
                child.position = nodes[nodeId].position + finalDir * cfg.branchStepLength;
                child.growthDir = finalDir;
                newNodes.push_back(child);
            }

            for (const auto& n : newNodes) {
                nodes[n.parentId].children.push_back(n.id);
                nodes.push_back(n);
            }

            if (newNodes.empty()) break;

            // Prune attractors inside kill radius of any node
            float effectiveKillSq = (cfg.killRadius * 1.25f) * (cfg.killRadius * 1.25f);
            std::vector<Vec3> remainingAttractors;
            remainingAttractors.reserve(attractors.size());
            for (const auto& attr : attractors) {
                bool killed = false;
                for (const auto& node : nodes) {
                    if ((attr - node.position).lengthSquared() < effectiveKillSq) {
                        killed = true;
                        break;
                    }
                }
                if (!killed) {
                    remainingAttractors.push_back(attr);
                }
            }
            attractors = std::move(remainingAttractors);
        }

        // 4. Propagate Branch Radii via Leonardo da Vinci's Rule: r_parent^p = sum(r_child^p)
        for (int i = static_cast<int>(nodes.size()) - 1; i >= 0; --i) {
            if (nodes[i].children.empty()) {
                nodes[i].radius = cfg.tipRadius;
            } else {
                float sumPow = 0.0f;
                for (int childId : nodes[i].children) {
                    sumPow += std::pow(nodes[childId].radius, cfg.daVinciExponent);
                }
                nodes[i].radius = std::pow(sumPow, 1.0f / cfg.daVinciExponent);
            }
        }

        // Root flare exponential fluting (only applied to the primary basal trunk)
        float maxFlareH = cfg.isShrub ? std::min(0.20f, cfg.clearTrunkHeight + 0.05f) : cfg.rootFlareHeight;
        for (int i = 0; i < static_cast<int>(nodes.size()); ++i) {
            if (nodes[i].position.y < (cfg.rootAnchor.y + maxFlareH) && nodes[i].position.y >= cfg.rootAnchor.y) {
                Vec3 radialOffset = nodes[i].position - cfg.rootAnchor;
                radialOffset.y = 0.0f;
                // Only flare nodes centered on the trunk core, not drooping outer limbs
                if (radialOffset.length() <= cfg.baseRadius * 1.6f) {
                    float t = 1.0f - std::clamp((nodes[i].position.y - cfg.rootAnchor.y) / maxFlareH, 0.0f, 1.0f);
                    float flare = 1.0f + (cfg.rootFlareMultiplier - 1.0f) * (t * t);
                    nodes[i].radius *= flare;
                }
            }
        }

        // 5. Build Branch Cylinder Meshes
        for (const auto& node : nodes) {
            if (node.parentId >= 0) {
                const auto& parent = nodes[node.parentId];
                appendBranchCylinder(
                    treeMesh,
                    parent.position, node.position,
                    parent.radius, node.radius,
                    cfg.woodColor,
                    8
                );
            }
        }

        // 6. Spawn Foliage (Cards or Detailed Leaves / Twig Clusters) at Tip Nodes
        if (cfg.generateLeaves) {
            std::vector<FoliageClumpHelper> foliageHelpers;
            Vec3 helperCenter = cfg.crownCenter;
            Vec3 helperExtents = cfg.crownExtents;
            if (!cfg.customAttractors.empty()) {
                Vec3 aMin(1e9f, 1e9f, 1e9f), aMax(-1e9f, -1e9f, -1e9f);
                for (const auto& a : cfg.customAttractors) {
                    aMin.x = std::min(aMin.x, a.x); aMax.x = std::max(aMax.x, a.x);
                    aMin.y = std::min(aMin.y, a.y); aMax.y = std::max(aMax.y, a.y);
                    aMin.z = std::min(aMin.z, a.z); aMax.z = std::max(aMax.z, a.z);
                }
                helperCenter = (aMin + aMax) * 0.5f;
                helperExtents = (aMax - aMin) * 0.5f;
                helperExtents.x = std::max(helperExtents.x, 0.5f);
                helperExtents.y = std::max(helperExtents.y, 0.5f);
                helperExtents.z = std::max(helperExtents.z, 0.5f);
            }
            foliageHelpers.push_back({helperCenter, helperExtents.x, helperExtents, 0});

            float crownBottom = cfg.rootAnchor.y + cfg.clearTrunkHeight * 0.85f;

            if (cfg.useDetailedLeaves) {
                DetailedLeafConfig lCfg;
                lCfg.morphology = cfg.leafMorphology;
                lCfg.length = cfg.leafSize;
                lCfg.widthRatio = 0.55f;
                lCfg.petioleLength = cfg.leafSize * 0.22f;
                lCfg.petioleRadius = cfg.leafSize * 0.016f;
                lCfg.laminaColor = cfg.leafColor;
                lCfg.veinColor = Vec4(cfg.leafColor.x * 1.55f, cfg.leafColor.y * 1.35f, cfg.leafColor.z * 1.6f, 1.0f);
                lCfg.marginColor = Vec4(cfg.leafColor.x * 1.25f, cfg.leafColor.y * 1.20f, cfg.leafColor.z * 1.3f, 1.0f);

                if (cfg.useTwigSprays) {
                    TwigClusterConfig tCfg;
                    tCfg.twigLength = cfg.leafSize * 1.60f;
                    tCfg.leafCount = std::max(6, cfg.leavesPerTip);
                    tCfg.twigColor = cfg.woodColor;
                    tCfg.leafConfig = lCfg;

                    // 1. Apical twig clusters on all terminal tips
                    for (const auto& node : nodes) {
                        if (nodes[node.id].children.empty()) {
                            Vec3 branchDir = (node.growthDir + Vec3(0, 0.12f, 0)).normalized();
                            TwigClusterGenerator::appendTwigCluster(treeMesh, node.position, branchDir, tCfg);
                        }
                    }

                    // 2. Lateral twig sprays along distal branch boughs
                    if (cfg.spawnLateralTwigs) {
                        std::mt19937 fRng(cfg.seed + 999);
                        std::uniform_real_distribution<float> fDist(0.0f, 1.0f);
                        float prob = std::clamp(cfg.lateralTwigProbability * cfg.volumetricDensity, 0.25f, 1.0f);

                        TwigClusterConfig lateralTCfg = tCfg;
                        lateralTCfg.twigLength = cfg.leafSize * 1.35f;
                        lateralTCfg.leafCount = std::max(6, static_cast<int>(cfg.leavesPerTip * 0.75f));

                        for (const auto& node : nodes) {
                            if (!nodes[node.id].children.empty() && node.position.y >= crownBottom && node.radius <= cfg.foliageBranchRadiusThreshold) {
                                if (fDist(fRng) < prob) {
                                    // Sprout lateral twig outward from crown centroid with upward phototropic bias
                                    Vec3 outward = (node.position - cfg.crownCenter).normalized();
                                    Vec3 lateralDir = (node.growthDir * 0.40f + outward * 0.72f + Vec3(0, 0.22f, 0)).normalized();
                                    TwigClusterGenerator::appendTwigCluster(treeMesh, node.position, lateralDir, lateralTCfg);

                                    // For dense vegetative blobs (rho > 0.55), sprout second bilateral lateral spray
                                    if (cfg.volumetricDensity > 0.55f && fDist(fRng) < (cfg.volumetricDensity - 0.25f)) {
                                        Vec3 branchTangent = node.growthDir.normalized();
                                        Vec3 binormal = branchTangent.cross(Vec3(0, 1, 0));
                                        if (binormal.lengthSquared() < 0.01f) binormal = branchTangent.cross(Vec3(1, 0, 0));
                                        binormal = binormal.normalized();
                                        Vec3 oppDir = (branchTangent * 0.35f + binormal * 0.55f + outward * 0.45f + Vec3(0, 0.18f, 0)).normalized();
                                        TwigClusterGenerator::appendTwigCluster(treeMesh, node.position, oppDir, lateralTCfg);
                                    }
                                }
                            }
                        }
                    }
                } else {
                    auto appendLeafRosette = [&](const Vec3& pos, const Vec3& dir, int count, float scale) {
                        Vec3 branchDir = dir.normalized();
                        Vec3 up = std::abs(branchDir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
                        Vec3 side = branchDir.cross(up).normalized();
                        up = side.cross(branchDir).normalized();

                        for (int l = 0; l < count; ++l) {
                            float angle = (static_cast<float>(l) / static_cast<float>(count)) * math::TWO_PI;
                            Vec3 leafDir = (side * std::cos(angle) + up * std::sin(angle) + branchDir * 0.45f).normalized();
                            Vec3 leafNorm = (leafDir + Vec3(0, 0.4f, 0)).normalized();
                            DetailedLeafGenerator::appendDetailedLeaf(treeMesh, pos, leafDir, leafNorm, scale, lCfg);
                        }
                    };

                    for (const auto& node : nodes) {
                        if (nodes[node.id].children.empty()) {
                            appendLeafRosette(node.position, node.growthDir, cfg.leavesPerTip, 1.0f);
                        } else if (cfg.spawnLateralTwigs && node.position.y >= crownBottom && node.radius <= cfg.foliageBranchRadiusThreshold) {
                            int latCount = std::max(3, static_cast<int>(cfg.leavesPerTip * 0.65f));
                            Vec3 outward = (node.position - cfg.crownCenter).normalized();
                            Vec3 latDir = (node.growthDir * 0.45f + outward * 0.65f + Vec3(0, 0.2f, 0)).normalized();
                            appendLeafRosette(node.position, latDir, latCount, 0.85f);
                        }
                    }
                }
            } else {
                auto appendCardClump = [&](const Vec3& pos, int count, float scale) {
                    for (int l = 0; l < count; ++l) {
                        float angle = (static_cast<float>(l) / static_cast<float>(count)) * math::TWO_PI;
                        Vec3 cardOffset(std::cos(angle) * cfg.leafSize * scale * 0.6f, (dist0To1(rng) - 0.5f) * 0.2f, std::sin(angle) * cfg.leafSize * scale * 0.6f);
                        Vec3 leafCenter = pos + cardOffset;

                        // Create two intersecting crossed quads
                        for (int q = 0; q < 2; ++q) {
                            float qAngle = angle + (q * math::HALF_PI);
                            Vec3 right(std::cos(qAngle) * cfg.leafSize * scale * 0.5f, 0, std::sin(qAngle) * cfg.leafSize * scale * 0.5f);
                            Vec3 up(0, cfg.leafSize * scale * 0.5f, 0);

                            uint32_t bIdx = static_cast<uint32_t>(treeMesh.vertices.size());
                            treeMesh.vertices.push_back(leafCenter - right - up);
                            treeMesh.vertices.push_back(leafCenter + right - up);
                            treeMesh.vertices.push_back(leafCenter + right + up);
                            treeMesh.vertices.push_back(leafCenter - right + up);

                            Vec3 n = right.cross(up).normalized();
                            for (int k = 0; k < 4; ++k) {
                                treeMesh.normals.push_back(n);
                                treeMesh.vertexColors.push_back(cfg.leafColor);
                            }

                            treeMesh.indices.push_back(bIdx);
                            treeMesh.indices.push_back(bIdx + 1);
                            treeMesh.indices.push_back(bIdx + 2);

                            treeMesh.indices.push_back(bIdx);
                            treeMesh.indices.push_back(bIdx + 2);
                            treeMesh.indices.push_back(bIdx + 3);
                        }
                    }
                };

                for (const auto& node : nodes) {
                    if (nodes[node.id].children.empty()) {
                        appendCardClump(node.position, cfg.leavesPerTip, 1.0f);
                    } else if (cfg.spawnLateralTwigs && node.position.y >= crownBottom && node.radius <= cfg.foliageBranchRadiusThreshold) {
                        int latCount = std::max(3, static_cast<int>(cfg.leavesPerTip * 0.65f));
                        appendCardClump(node.position, latCount, 0.85f);
                    }
                }
            }

            // Transfer lush smooth radial normals
            transferFoliageNormals(treeMesh, foliageHelpers, 0.85f, 0.25f);
        }

        return treeMesh;
    }
};

// ============================================================================
// 7. Obstacle-Clinging Ivy Growth Generator (Thomas Luft / IvyGen)
// ============================================================================

struct IvyConfig {
    Vec3 rootPosition{0.0f, 0.0f, 0.0f};
    Vec3 obstacleMin{-4.0f, 0.0f, -4.0f};
    Vec3 obstacleMax{ 4.0f, 6.0f,  4.0f};
    int maxSteps{60};
    float stepLength{0.25f};
    float clingDistance{0.18f};
    float upwardBias{0.70f};
    float wanderWeight{0.30f};
    float branchProbability{0.15f};
    int maxBranches{12};
    float stemRadius{0.022f};
    float leafSize{0.24f};
    Vec4 stemColor{0.24f, 0.18f, 0.12f, 1.0f};
    Vec4 leafColor{0.16f, 0.46f, 0.11f, 1.0f};
    uint32_t seed{4242};
};

class IvyGrowthGenerator {
public:
    static geometry::Mesh generateIvy(const IvyConfig& cfg) {
        geometry::Mesh ivyMesh;
        std::mt19937 rng(cfg.seed);
        std::uniform_real_distribution<float> distMinus1To1(-1.0f, 1.0f);
        std::uniform_real_distribution<float> dist0To1(0.0f, 1.0f);

        struct IvyBranch {
            Vec3 currentPos;
            Vec3 currentDir;
            int stepCount{0};
            bool alive{true};
        };

        std::vector<IvyBranch> branches;
        branches.push_back({cfg.rootPosition, Vec3(0, 1, 0), 0, true});

        auto projectToObstacleSurface = [&](const Vec3& p) -> std::pair<Vec3, Vec3> {
            // Clamps point to nearest face of obstacle AABB
            Vec3 clamped(
                std::clamp(p.x, cfg.obstacleMin.x, cfg.obstacleMax.x),
                std::clamp(p.y, cfg.obstacleMin.y, cfg.obstacleMax.y),
                std::clamp(p.z, cfg.obstacleMin.z, cfg.obstacleMax.z)
            );

            // Compute distance to each of the 6 planes
            float dLeft = std::abs(p.x - cfg.obstacleMin.x);
            float dRight = std::abs(p.x - cfg.obstacleMax.x);
            float dBack = std::abs(p.z - cfg.obstacleMin.z);
            float dFront = std::abs(p.z - cfg.obstacleMax.z);

            float minD = std::min({dLeft, dRight, dBack, dFront});
            Vec3 surfacePos = clamped;
            Vec3 surfaceNormal(0, 0, 1);

            if (minD == dFront) {
                surfacePos.z = cfg.obstacleMax.z;
                surfaceNormal = Vec3(0, 0, 1);
            } else if (minD == dBack) {
                surfacePos.z = cfg.obstacleMin.z;
                surfaceNormal = Vec3(0, 0, -1);
            } else if (minD == dLeft) {
                surfacePos.x = cfg.obstacleMin.x;
                surfaceNormal = Vec3(-1, 0, 0);
            } else {
                surfacePos.x = cfg.obstacleMax.x;
                surfaceNormal = Vec3(1, 0, 0);
            }

            return {surfacePos, surfaceNormal};
        };

        for (int step = 0; step < cfg.maxSteps; ++step) {
            size_t branchCount = branches.size();
            for (size_t b = 0; b < branchCount; ++b) {
                if (!branches[b].alive) continue;

                Vec3 prevPos = branches[b].currentPos;
                auto [surfPos, surfNorm] = projectToObstacleSurface(prevPos);

                // Guide direction: upward + surface adherence + stochastic wander
                Vec3 wander(distMinus1To1(rng), distMinus1To1(rng) * 0.5f, distMinus1To1(rng));
                Vec3 targetDir = (Vec3(0, cfg.upwardBias, 0) + wander * cfg.wanderWeight).normalized();

                // Project targetDir onto obstacle surface tangent plane
                targetDir = (targetDir - surfNorm * targetDir.dot(surfNorm)).normalized();

                Vec3 nextPos = surfPos + targetDir * cfg.stepLength + surfNorm * cfg.clingDistance;
                branches[b].currentPos = nextPos;
                branches[b].currentDir = targetDir;
                branches[b].stepCount++;

                // Append stem cylinder segment
                appendBranchCylinder(
                    ivyMesh,
                    prevPos, nextPos,
                    cfg.stemRadius, cfg.stemRadius * 0.95f,
                    cfg.stemColor,
                    6
                );

                // Spawn ivy leaf cards adhering to surface
                if (dist0To1(rng) > 0.35f) {
                    Vec3 leafRight = surfNorm.cross(targetDir).normalized() * (cfg.leafSize * 0.5f);
                    Vec3 leafUp = targetDir * (cfg.leafSize * 0.5f);
                    Vec3 leafCenter = nextPos + surfNorm * 0.02f;

                    uint32_t baseIdx = static_cast<uint32_t>(ivyMesh.vertices.size());
                    ivyMesh.vertices.push_back(leafCenter - leafRight - leafUp);
                    ivyMesh.vertices.push_back(leafCenter + leafRight - leafUp);
                    ivyMesh.vertices.push_back(leafCenter + leafRight + leafUp);
                    ivyMesh.vertices.push_back(leafCenter - leafRight + leafUp);

                    for (int k = 0; k < 4; ++k) {
                        ivyMesh.normals.push_back(surfNorm);
                        ivyMesh.vertexColors.push_back(cfg.leafColor);
                    }

                    ivyMesh.indices.push_back(baseIdx);
                    ivyMesh.indices.push_back(baseIdx + 1);
                    ivyMesh.indices.push_back(baseIdx + 2);

                    ivyMesh.indices.push_back(baseIdx);
                    ivyMesh.indices.push_back(baseIdx + 2);
                    ivyMesh.indices.push_back(baseIdx + 3);
                }

                // Check branching
                if (branches.size() < static_cast<size_t>(cfg.maxBranches) && dist0To1(rng) < cfg.branchProbability) {
                    Vec3 branchDir = (targetDir + wander * 0.8f).normalized();
                    branches.push_back({nextPos, branchDir, branches[b].stepCount, true});
                }

                if (nextPos.y > cfg.obstacleMax.y + 0.5f) {
                    branches[b].alive = false;
                }
            }
        }

        return ivyMesh;
    }
};

/**
 * Configuration parameters for generating a realistic grass clump / tuft.
 * Implements botanical morphogenesis with folded V-keel cross sections,
 * gravitropic Bézier spine curvature, radial clump splay, and biological senescence gradients.
 */
struct GrassClumpConfig {
    int bladeCount{36};                  // Number of individual grass blades per clump
    float clumpRadius{0.32f};            // Radius of root dispersion from clump anchor (meters)
    float bladeHeightMin{0.45f};         // Minimum blade length (meters)
    float bladeHeightMax{0.80f};         // Maximum blade length (meters)
    float bladeWidthBase{0.032f};        // Width at basal sheath
    float bladeWidthMid{0.038f};         // Width at mid-lamina flare
    float keelDepth{0.014f};             // V-creased cross-section depth (splits specular highlights)
    int segmentsPerBlade{7};             // Spine segments for smooth Bézier curvature (minimum 4)
    float gravityDroop{0.45f};           // Gravitropic droop factor bending tips toward ground
    float radialSplay{0.65f};            // Outward flaring factor for peripheral blades
    float curlStochasticity{0.25f};      // Stochastic axial curl and twist along blade spine
    float centerHeightBias{0.35f};       // Additional height boost for central blades vs peripheral
    Vec4 rootColor{0.72f, 0.82f, 0.40f, 1.0f};  // Basal sheath pale yellow-green
    Vec4 midColor{0.18f, 0.52f, 0.10f, 1.0f};   // Photosynthetic chlorophyll green
    Vec4 tipColor{0.65f, 0.55f, 0.22f, 1.0f};   // Senescent straw/sun-bleached tip
    float clumpNormalBlend{0.35f};       // Blend factor between geometric facet normal and spherical envelope normal
    uint32_t seed{1337};
};

/**
 * Configuration for scattering multiple grass clumps across a terrain landscape.
 */
struct GrassFieldConfig {
    int clumpCount{24};                  // Total clumps to scatter
    Vec2 areaMin{-3.0f, -3.0f};          // Terrain bounds min (X, Z)
    Vec2 areaMax{3.0f, 3.0f};            // Terrain bounds max (X, Z)
    float minClumpDistance{0.45f};       // Minimum Poisson-disk separation between clump centers
    float heightVariationMin{0.80f};     // Global clump scale min
    float heightVariationMax{1.25f};     // Global clump scale max
    uint32_t seed{4242};
};

/**
 * Procedural Grass Clump & Field Generator.
 * Abstraction of state-of-the-art botanical grass modeling:
 * 1. Folded V-keel cross-section creating dual specular highlight facets.
 * 2. Gravitropic Bézier spine bending under self-weight.
 * 3. Radial clump splay where outer blades tilt away from clump anchor.
 * 4. Senescence color gradients (basal sheath -> emerald lamina -> dry tip).
 * 5. Analytical normal calculation with envelope normal transfer.
 */
class GrassClumpGenerator {
public:
    /**
     * Generates a single detailed grass clump/tuft centered at the specified anchor point.
     */
    static geometry::Mesh generateClump(const GrassClumpConfig& cfg, const Vec3& center = Vec3(0, 0, 0)) {
        geometry::Mesh mesh;
        std::mt19937 rng(cfg.seed);
        std::uniform_real_distribution<float> dist0To1(0.0f, 1.0f);
        std::uniform_real_distribution<float> distMinus1To1(-1.0f, 1.0f);

        int validSegments = std::max(4, cfg.segmentsPerBlade);

        for (int b = 0; b < cfg.bladeCount; ++b) {
            // 1. Root dispersion inside clump using uniform disk sampling
            float u1 = dist0To1(rng);
            float u2 = dist0To1(rng);
            float r = cfg.clumpRadius * std::sqrt(u1);
            float theta = u2 * 2.0f * math::PI;

            Vec3 rootPos = center + Vec3(r * std::cos(theta), 0.0f, r * std::sin(theta));
            float radRatio = (cfg.clumpRadius > 0.001f) ? (r / cfg.clumpRadius) : 0.0f;

            // Outward radial unit vector
            Vec3 uRadial = (r > 0.001f) ? Vec3(std::cos(theta), 0.0f, std::sin(theta)) : Vec3(1, 0, 0);

            // 2. Blade height with central dominance
            float baseH = math::lerp(cfg.bladeHeightMin, cfg.bladeHeightMax, dist0To1(rng));
            float bladeHeight = baseH * (1.0f + (1.0f - radRatio) * cfg.centerHeightBias);

            // 3. Splay and stochastic curl vectors
            Vec3 splayVec = uRadial * (radRatio * cfg.radialSplay);
            float curlAngle = distMinus1To1(rng) * math::PI;
            Vec3 curlVec = Vec3(std::cos(curlAngle), 0.0f, std::sin(curlAngle)) * cfg.curlStochasticity;

            // 4. Bézier control points
            Vec3 P0 = rootPos;
            Vec3 P1 = rootPos + Vec3(0.0f, bladeHeight * 0.50f, 0.0f) + splayVec * (bladeHeight * 0.30f);
            Vec3 P2 = rootPos + Vec3(0.0f, bladeHeight * 0.95f, 0.0f) + (splayVec + curlVec) * (bladeHeight * 0.80f)
                      - Vec3(0.0f, bladeHeight * cfg.gravityDroop, 0.0f);

            // We generate (validSegments) rows of 3 vertices, followed by 1 tip vertex
            // Total vertices for this blade = validSegments * 3 + 1
            std::vector<uint32_t> leftIndices(validSegments);
            std::vector<uint32_t> centerIndices(validSegments);
            std::vector<uint32_t> rightIndices(validSegments);
            uint32_t tipIndex = 0;

            for (int seg = 0; seg < validSegments; ++seg) {
                float t = static_cast<float>(seg) / static_cast<float>(validSegments);

                // Quadratic Bézier position: P(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2
                float oneMinusT = 1.0f - t;
                Vec3 Pt = P0 * (oneMinusT * oneMinusT) + P1 * (2.0f * oneMinusT * t) + P2 * (t * t);

                // Derivative for tangent: T(t) = 2(1-t)(P1 - P0) + 2t(P2 - P1)
                Vec3 T = (P1 - P0) * (2.0f * oneMinusT) + (P2 - P1) * (2.0f * t);
                Vec3 tanNorm = (T.lengthSquared() > 1e-6f) ? T.normalized() : Vec3(0, 1, 0);

                // Reference Up vector
                Vec3 upRef(0, 1, 0);
                if (std::abs(tanNorm.dot(upRef)) > 0.95f) {
                    upRef = uRadial;
                }

                // Width axis (Binormal) and Keel axis (Upward normal perpendicular to spine)
                Vec3 binormal = tanNorm.cross(upRef).normalized();
                Vec3 keelNormal = binormal.cross(tanNorm).normalized();

                // Width profile: subtle flare at t = 0.25, smooth taper to tip
                float width = (t < 0.25f)
                    ? math::lerp(cfg.bladeWidthBase, cfg.bladeWidthMid, t / 0.25f)
                    : cfg.bladeWidthMid * std::max(0.0f, 1.0f - (t - 0.25f) / 0.75f);

                // Keel crease depth
                float keel = cfg.keelDepth * (1.0f - t * 0.85f) * (width / std::max(1e-4f, cfg.bladeWidthMid));

                // 3 cross-section positions: Left margin, Recessed center crease, Right margin
                Vec3 pLeft = Pt - binormal * (width * 0.5f) + keelNormal * (keel * 0.5f);
                Vec3 pCenter = Pt - keelNormal * (keel * 0.5f);
                Vec3 pRight = Pt + binormal * (width * 0.5f) + keelNormal * (keel * 0.5f);

                // Biological color gradient
                Vec4 col;
                if (t < 0.20f) {
                    col = math::lerp(cfg.rootColor, cfg.midColor, t / 0.20f);
                } else if (t < 0.75f) {
                    col = cfg.midColor;
                } else {
                    col = math::lerp(cfg.midColor, cfg.tipColor, (t - 0.75f) / 0.25f);
                }

                // Analytical normals for left and right facet
                Vec3 nLeft = (keelNormal + binormal * 0.5f).normalized();
                Vec3 nRight = (keelNormal - binormal * 0.5f).normalized();
                Vec3 nCenter = keelNormal;

                // Spherical envelope blend
                if (cfg.clumpNormalBlend > 0.0f) {
                    Vec3 envNormLeft = (pLeft - center).normalized();
                    Vec3 envNormRight = (pRight - center).normalized();
                    Vec3 envNormCenter = (pCenter - center).normalized();

                    nLeft = math::lerp(nLeft, envNormLeft, cfg.clumpNormalBlend).normalized();
                    nRight = math::lerp(nRight, envNormRight, cfg.clumpNormalBlend).normalized();
                    nCenter = math::lerp(nCenter, envNormCenter, cfg.clumpNormalBlend).normalized();
                }

                uint32_t idxL = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(pLeft);
                mesh.normals.push_back(nLeft);
                mesh.uvs.push_back(Vec2(0.0f, t));
                mesh.vertexColors.push_back(col);
                leftIndices[seg] = idxL;

                uint32_t idxC = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(pCenter);
                mesh.normals.push_back(nCenter);
                mesh.uvs.push_back(Vec2(0.5f, t));
                mesh.vertexColors.push_back(col);
                centerIndices[seg] = idxC;

                uint32_t idxR = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(pRight);
                mesh.normals.push_back(nRight);
                mesh.uvs.push_back(Vec2(1.0f, t));
                mesh.vertexColors.push_back(col);
                rightIndices[seg] = idxR;
            }

            // Tip vertex (t = 1.0)
            tipIndex = static_cast<uint32_t>(mesh.vertices.size());
            mesh.vertices.push_back(P2);
            Vec3 tipNorm = (P2 - P1).normalized();
            if (cfg.clumpNormalBlend > 0.0f) {
                tipNorm = math::lerp(tipNorm, (P2 - center).normalized(), cfg.clumpNormalBlend).normalized();
            }
            mesh.normals.push_back(tipNorm);
            mesh.uvs.push_back(Vec2(0.5f, 1.0f));
            mesh.vertexColors.push_back(cfg.tipColor);

            // Connect quads along the spine
            for (int seg = 0; seg < validSegments - 1; ++seg) {
                uint32_t L0 = leftIndices[seg];
                uint32_t C0 = centerIndices[seg];
                uint32_t R0 = rightIndices[seg];

                uint32_t L1 = leftIndices[seg + 1];
                uint32_t C1 = centerIndices[seg + 1];
                uint32_t R1 = rightIndices[seg + 1];

                // Left facet quad (L0, C0, C1, L1) -> 2 triangles
                mesh.indices.push_back(L0);
                mesh.indices.push_back(C0);
                mesh.indices.push_back(C1);

                mesh.indices.push_back(L0);
                mesh.indices.push_back(C1);
                mesh.indices.push_back(L1);

                // Right facet quad (C0, R0, R1, C1) -> 2 triangles
                mesh.indices.push_back(C0);
                mesh.indices.push_back(R0);
                mesh.indices.push_back(R1);

                mesh.indices.push_back(C0);
                mesh.indices.push_back(R1);
                mesh.indices.push_back(C1);
            }

            // Connect final segment to single tip vertex
            uint32_t lastL = leftIndices[validSegments - 1];
            uint32_t lastC = centerIndices[validSegments - 1];
            uint32_t lastR = rightIndices[validSegments - 1];

            mesh.indices.push_back(lastL);
            mesh.indices.push_back(lastC);
            mesh.indices.push_back(tipIndex);

            mesh.indices.push_back(lastC);
            mesh.indices.push_back(lastR);
            mesh.indices.push_back(tipIndex);
        }

        return mesh;
    }

    /**
     * Generates a field of scattered grass clumps across a terrain region.
     */
    static geometry::Mesh generateField(
        const GrassFieldConfig& fieldCfg,
        const GrassClumpConfig& baseClumpCfg
    ) {
        geometry::Mesh combinedMesh;
        std::mt19937 rng(fieldCfg.seed);
        std::uniform_real_distribution<float> distX(fieldCfg.areaMin.x, fieldCfg.areaMax.x);
        std::uniform_real_distribution<float> distZ(fieldCfg.areaMin.y, fieldCfg.areaMax.y);
        std::uniform_real_distribution<float> distScale(fieldCfg.heightVariationMin, fieldCfg.heightVariationMax);
        std::uniform_int_distribution<uint32_t> distSeed(1, 100000);

        std::vector<Vec3> clumpCenters;
        clumpCenters.reserve(fieldCfg.clumpCount);

        int maxAttempts = fieldCfg.clumpCount * 25;
        for (int attempt = 0; attempt < maxAttempts && clumpCenters.size() < static_cast<size_t>(fieldCfg.clumpCount); ++attempt) {
            Vec3 candidate(distX(rng), 0.0f, distZ(rng));

            bool tooClose = false;
            for (const auto& existing : clumpCenters) {
                if ((candidate - existing).lengthSquared() < fieldCfg.minClumpDistance * fieldCfg.minClumpDistance) {
                    tooClose = true;
                    break;
                }
            }

            if (!tooClose) {
                clumpCenters.push_back(candidate);
            }
        }

        for (size_t c = 0; c < clumpCenters.size(); ++c) {
            GrassClumpConfig clumpCfg = baseClumpCfg;
            float scale = distScale(rng);
            clumpCfg.bladeHeightMin *= scale;
            clumpCfg.bladeHeightMax *= scale;
            clumpCfg.clumpRadius *= (0.85f + 0.30f * (scale - 1.0f));
            clumpCfg.seed = distSeed(rng);

            geometry::Mesh clumpMesh = generateClump(clumpCfg, clumpCenters[c]);

            // Append into combinedMesh
            uint32_t baseIdx = static_cast<uint32_t>(combinedMesh.vertices.size());
            combinedMesh.vertices.insert(combinedMesh.vertices.end(), clumpMesh.vertices.begin(), clumpMesh.vertices.end());
            combinedMesh.normals.insert(combinedMesh.normals.end(), clumpMesh.normals.begin(), clumpMesh.normals.end());
            combinedMesh.uvs.insert(combinedMesh.uvs.end(), clumpMesh.uvs.begin(), clumpMesh.uvs.end());
            combinedMesh.vertexColors.insert(combinedMesh.vertexColors.end(), clumpMesh.vertexColors.begin(), clumpMesh.vertexColors.end());

            for (uint32_t idx : clumpMesh.indices) {
                combinedMesh.indices.push_back(baseIdx + idx);
            }
        }

        return combinedMesh;
    }
};

} // namespace nature
} // namespace scratchbox

#endif // SCRATCHBOX_NATURE_HPP


