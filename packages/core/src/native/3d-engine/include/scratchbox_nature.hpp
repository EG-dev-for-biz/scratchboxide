/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_NATURE_HPP
#define SCRATCHBOX_NATURE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <cmath>
#include <algorithm>
#include <array>
#include <vector>
#include <random>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <limits>
#include <queue>

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

/** UVs of a branch cylinder in texture tiles: u = turn share x `around` tiles, v from vStart (start ring) to vEnd (end ring). */
struct BranchUv {
    float around{1.0f};
    float vStart{0.0f}, vEnd{1.0f};
};

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
    int segments = 6,
    bool roundEnd = false,
    float startExtend = 0.0f,   // the tube runs this much past its ends along its own axis, to cover the wedge a bend opens
    float endExtend = 0.0f,     // against the next tube (a joint of two tubes at an angle)
    const BranchUv* tiled = nullptr  // texture-tile UVs instead of the legacy cylindrical ones
) {
    Vec3 dir = end - start;
    float len = dir.length();
    if (len < 1e-4f) return;
    dir = dir / len;
    const Vec3 start0 = start;
    (void)start0;

    // Build orthonormal frame
    Vec3 up = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
    Vec3 side = dir.cross(up).normalized();
    up = side.cross(dir).normalized();

    uint32_t baseIndex = static_cast<uint32_t>(mesh.vertices.size());

    // Generate rings for start and end with duplicated seam (i <= segments) for seamless [0, 1] cylindrical UVs
    for (int i = 0; i <= segments; ++i) {
        float u = static_cast<float>(i) / static_cast<float>(segments);
        float angle = u * math::TWO_PI;
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);
        Vec3 ringRadial = side * cosA + up * sinA;

        // Bottom vertex
        mesh.vertices.push_back((start - dir * startExtend) + ringRadial * rStart);
        mesh.normals.push_back(ringRadial);
        mesh.vertexColors.push_back(woodColor);
        mesh.uvs.push_back(tiled ? Vec2(u * tiled->around, tiled->vStart) : Vec2(u * 2.0f, start.y * 1.5f));

        // Top vertex
        mesh.vertices.push_back((end + dir * endExtend) + ringRadial * rEnd);
        mesh.normals.push_back(ringRadial);
        mesh.vertexColors.push_back(woodColor);
        mesh.uvs.push_back(tiled ? Vec2(u * tiled->around, tiled->vEnd) : Vec2(u * 2.0f, end.y * 1.5f));
    }

    // Connect quads as triangles
    for (int i = 0; i < segments; ++i) {
        uint32_t b0 = baseIndex + i * 2;
        uint32_t t0 = baseIndex + i * 2 + 1;
        uint32_t b1 = baseIndex + (i + 1) * 2;
        uint32_t t1 = baseIndex + (i + 1) * 2 + 1;

        mesh.indices.push_back(b0);
        mesh.indices.push_back(t0);
        mesh.indices.push_back(b1);

        mesh.indices.push_back(b1);
        mesh.indices.push_back(t0);
        mesh.indices.push_back(t1);
    }

    // a branch that ends here (nothing continues from this node) closes with a cone, one triangle a side, instead of an open cut
    if (roundEnd) {
        // two apex vertices at one point (alternate triangles use each), so a cylinder still adds an even number of vertices, in
        // start/end pairs, as the growth order of its vertices assumes
        const uint32_t apex = static_cast<uint32_t>(mesh.vertices.size());
        for (int k = 0; k < 2; ++k) {
            mesh.vertices.push_back(end + dir * (endExtend + 0.9f * std::max(rEnd, 1e-3f)));
            mesh.normals.push_back(dir);
            mesh.vertexColors.push_back(woodColor);
            mesh.uvs.push_back(tiled ? Vec2(0.5f * tiled->around, tiled->vEnd) : Vec2(1.0f, end.y * 1.5f));
        }
        for (int i = 0; i < segments; ++i) {
            mesh.indices.push_back(baseIndex + (i + 1) * 2 + 1);
            mesh.indices.push_back(baseIndex + i * 2 + 1);
            mesh.indices.push_back(apex + static_cast<uint32_t>(i & 1));
        }
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

                mesh.uvs.push_back(Vec2(0.5f, 0.0f));
                mesh.uvs.push_back(Vec2(1.0f, 0.5f));
                mesh.uvs.push_back(Vec2(0.5f, 1.0f));
                mesh.uvs.push_back(Vec2(0.0f, 0.5f));

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
        mesh.uvs.push_back(Vec2(0.5f, 0.0f));
        mesh.uvs.push_back(Vec2(1.0f, 0.5f));
        mesh.uvs.push_back(Vec2(0.5f, 1.0f));
        mesh.uvs.push_back(Vec2(0.0f, 0.5f));

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
// 5. Detailed Botanical Leaf & Twig Generator (Infiniti / Sapling / MTree)
// ============================================================================

/**
 * The outline of a leaf blade as continuous numbers: the half-width along the blade is
 *   gain * widthRatio * length * t^rise * (1 - t)^fall   (t = 0 at the base, 1 at the tip),
 * times a tooth term 1 + serrationDepth sin(2 pi serrationCount t) and a lobe term 1 + lobeDepth sin(pi lobeHalfCycles t) sin(pi t),
 * blended by `cordate` (0..1) toward a heart-shaped base. Any blade a tree can carry lies somewhere in this space;
 * nothing branches on a name for it.
 */
struct LeafOutline {
    float gain{2.2f};
    float riseExponent{0.55f};
    float fallExponent{0.75f};
    float serrationCount{14.0f};      // Teeth along the margin
    float serrationDepth{0.0f};       // Tooth depth modulation
    float lobeDepth{0.0f};            // Lobe depth modulation
    float lobeHalfCycles{5.0f};       // Half cycles of the lobe term along the blade
    float cordate{0.0f};              // 0 tapered base .. 1 heart-shaped base with a pointed tip
};

struct DetailedLeafConfig {
    LeafOutline outline;
    float length{0.22f};              // Leaf blade length (meters)
    float widthRatio{0.55f};          // Width-to-length ratio
    float petioleLength{0.05f};       // Stalk length (meters)
    float petioleRadius{0.0035f};     // Stalk radius (meters)
    float midribDepth{0.010f};        // Sunken furrow depth at midrib
    float laminaCupping{0.022f};      // Upward parabolic curl of leaf blade edges
    float droopCurvature{0.028f};     // Downward parabolic droop along the spine
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

            const LeafOutline& o = cfg.outline;
            const float tc = std::max(0.001f, t), tr = std::max(0.001f, 1.0f - t);
            const float teeth = 1.0f + o.serrationDepth * std::sin(o.serrationCount * math::TWO_PI * t);
            const float lobes = 1.0f + o.lobeDepth * std::sin(o.lobeHalfCycles * math::PI * t) * std::sin(math::PI * t);
            const float tapered = leafLen * cfg.widthRatio * o.gain * std::pow(tc, o.riseExponent) * std::pow(tr, o.fallExponent) * std::max(0.2f, teeth) * std::max(0.2f, lobes);
            const float heart = leafLen * cfg.widthRatio * 2.0f * (1.1f - t * 0.35f) * std::sin(math::PI * std::pow(tc, 0.45f));
            w0 = tapered + (heart - tapered) * std::clamp(o.cordate, 0.0f, 1.0f);

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
    LeafOutline leafOutline;
    float leafSize{0.42f};
    int leavesPerTip{4};
    Vec4 woodColor{0.28f, 0.20f, 0.14f, 1.0f};
    Vec4 leafColor{0.18f, 0.45f, 0.12f, 1.0f};
    uint32_t seed{1337};
    // The budgeted wood's UVs in bark-texture tiles (both > 0): u around a branch, an integer number of tiles round (the
    // nearest to its circumference over barkTileAroundM, at least one, so the seam meets), v along the path from the root
    // over barkTileAlongM. Otherwise the UVs are the legacy cylindrical ones.
    float barkTileAroundM{0.0f};
    float barkTileAlongM{0.0f};

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
    float scaffoldAngleFromLeaderRad{0.80795f}; // Mean angle of a scaffold limb from the leader (atan2(0.68, 0.65): the outward : up direction it always had)
    float scaffoldAngleSpreadRad{0.0f};  // Spread of that angle between limbs (uniform, +/-); 0 draws nothing from the random stream
    float trunkLeanShare{0.28f};         // Share of the way to trunkLeanToward (or crownCenter) the trunk has leaned by the crown's height
    Vec3 trunkLeanToward{std::numeric_limits<float>::quiet_NaN(), 0.0f, 0.0f}; // When finite, the trunk leans towards this point (a measured apex) instead of crownCenter

    // Triangle budget (continuous). 0 = unbounded (the meshing above). When > 0 the grown skeleton is meshed so wood
    // plus foliage stay at or below this many triangles: branch tubes get a side count that scales with radius,
    // twigs thinner than a radius found by bisection are pruned into foliage, and foliage becomes clumped leaf masses
    // spread over the pruned twigs. baseRadius then sets the trunk radius above the root flare.
    float triangleBudget{0.0f};
    float woodBudgetShare{0.4f};         // share of the budget the wood may use; foliage takes the rest

    // Measured crowns (customAttractors). The trunk stops at clearTrunkHeight, or just above the lowest attractor; when
    // the crown starts higher than that by more than perceptionRadius, no attractor can see the trunk and nothing grows.
    // With trunkSeeksCrown the trunk keeps growing from there towards the nearest attractor until one lies within
    // perceptionRadius of its tip (and its forward cone), so colonisation starts where the measured crown begins.
    bool trunkSeeksCrown{false};
    // Measured crowns (customAttractors). Leaf nodes are the tips and the twigs thinner than kTwigRadiusShare of the
    // trunk (at the budgeted meshing's pruning radius, more). With leavesOnCrownBranches every branch node that came
    // within the kill reach of an attractor (a branch that grew through the measured crown) is a leaf node too, at any
    // budget. At the budgets trees are meshed within, the pruning makes most of those nodes leaf nodes anyway, so the
    // delivered leaf masses barely change; what it changes is the leaf nodes counted at the finest pruning
    // (foliageAnchors), which tile regrowth counts to judge whether a tree grew into its crown.
    bool leavesOnCrownBranches{false};
    // Colonisation stops once this many iterations in a row reached no attractor (0: it runs to maxIterations). The
    // attractors left by then are ones no branch converges on (a node that keeps sprouting towards an attractor it never
    // reaches), so further iterations only add nodes.
    int stallIterations{0};
    // Budgeted meshing (triangleBudget > 0) of a measured crown: the crown surface the scan measured. Leaf masses go
    // first, on the grown tree's leaf nodes, where they bring every one of these points within foliageSurfaceReach of
    // a leaf mass (fewest masses first), and the masses the budget has left fill the rest of the tree; without it every
    // leaf mass is the centroid of the leaf nodes in one voxel. TreeBudgetReport::surfaceMasses says how many went on
    // the surface; what the delivered foliage reaches is measured on the mesh (scratchbox_tile_vegetation.hpp).
    std::vector<Vec3> foliageSurface;
    float foliageSurfaceReach{0.0f};
    // ... and the crown's measured top, when it is higher than the highest of those points (they are voxel means of the
    // measured surface; its highest cell lies above them): the leaf masses may rise to it
    float foliageTop{std::numeric_limits<float>::quiet_NaN()};

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

/** What the budgeted meshing produced for one tree (triangleBudget > 0). */
struct TreeBudgetReport {
    size_t woodTriangles{0};
    size_t foliageTriangles{0};
    size_t skeletonNodes{0};
    size_t woodSegments{0};
    float prunedBelowRadius{0.0f};  // twigs thinner than this became foliage
    size_t foliageClumps{0};
    float clumpSpacing{0.0f};       // voxel size the foliage clumps were gathered at (m)
    int trianglesPerClump{0};
    size_t surfaceMassesNeeded{0};  // leaf masses it takes to bring every surface point the leaf nodes can reach within reach
    size_t surfaceMasses{0};        // ... how many the budget held (the first ones in the foliage mesh)
    size_t surfacePointsCovered{0}; // ... and the surface points those bring within reach (by their inner balls)
};

/**
 * When each vertex of a budgeted tree mesh grew (meshWithinBudget), in the skeleton's real growth order: node ids are
 * appended in creation order (trunk, scaffold limbs, then each colonisation iteration's new nodes), so a node's id over
 * max(1, nodes - 1) is how far through the growth it appeared. A wood segment's start ring takes its start node's value
 * and its end ring its end node's, so a branch grows along its length; a leaf mass takes the largest value among the leaf
 * nodes it holds (within its hold radius; the nearest leaf node when it holds none), so it appears once the last of them
 * has grown. One value per vertex of the wood and foliage meshes, each in [0, 1].
 */
struct MeshGrowth {
    std::vector<float> wood, foliage;
    /** A wood segment the budget's pruning dropped (the thinner twigs): the skeleton nodes it joins and their meshed radii (m). */
    struct PrunedSegment { int a{0}, b{0}; float radiusA{0}, radiusB{0}; };
    std::vector<PrunedSegment> pruned;
};

/** How colonisation went (growSkeleton). `stop` is a diagnostic label; nothing branches on it. */
struct ColonizationReport {
    int iterations{0};              // colonisation iterations run
    std::string stop;               // all_attractors_reached | no_attractor_within_perception | stalled | iteration_cap | (string)
    size_t attractors{0};           // attractors at the start
    size_t attractorsReached{0};    // attractors a node came within the kill radius of
    int trunkNodes{0};              // nodes from the root to the crown break (the scaffold limbs start there)
    float trunkTopY{0.0f};
    int trunkSeekSteps{0};          // trunk steps grown past clearTrunkHeight to reach the crown (trunkSeeksCrown)
};

class SpaceColonizationTreeGenerator {
public:
    /**
     * Grows the branch skeleton (attractors, trunk, scaffold limbs, colonisation, da Vinci radii, root flare).
     * `rng` is seeded by the caller and keeps its state for the meshing that follows. `report` (optional) says how the
     * colonisation went. Each attractor keeps its nearest seeing node as nodes are added (through a grid over the
     * attractors), which picks the node a scan over every node would (the nearest, ties to the lowest id): the skeleton is
     * the one the plain O(attractors x nodes) search per iteration grows.
     */
    static std::vector<ColonizationNode> growSkeleton(const SpaceColonizationConfig& cfg, std::mt19937& rng, ColonizationReport* report = nullptr) {
        std::uniform_real_distribution<float> distMinus1To1(-1.0f, 1.0f);
        std::uniform_real_distribution<float> dist0To1(0.0f, 1.0f);
        ColonizationReport localReport;
        ColonizationReport& rep = report ? *report : localReport;
        rep = ColonizationReport{};

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
        rep.attractors = attractors.size();

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
            const Vec3 leanTo = std::isfinite(cfg.trunkLeanToward.x) ? cfg.trunkLeanToward : cfg.crownCenter;
            Vec3 leanOffset = (leanTo - cfg.rootAnchor) * (tLean * cfg.trunkLeanShare);
            Vec3 targetPos = cfg.rootAnchor + Vec3(leanOffset.x, nextY - cfg.rootAnchor.y, leanOffset.z);
            Vec3 stepDir = (targetPos - nodes.back().position).normalized();

            nextNode.position = nodes.back().position + stepDir * cfg.branchStepLength;
            nextNode.growthDir = stepDir;
            nodes.back().children.push_back(nextNode.id);
            nodes.push_back(nextNode);
        }

        float perceptionSq = cfg.perceptionRadius * cfg.perceptionRadius;
        // what a node sees: an attractor within the perception radius, ahead of it or to the side (the forward cone:
        // dot >= -0.2 * length prevents 180-degree backward turns)
        auto sees = [&](const ColonizationNode& node, const Vec3& attr, float& d2) {
            const Vec3 toAttr = attr - node.position;
            d2 = toAttr.lengthSquared();
            return d2 < perceptionSq && toAttr.dot(node.growthDir) >= -0.20f * std::sqrt(d2);
        };

        // The measured crown may begin higher (or further out) than the trunk stopped: grow on towards the nearest
        // attractor until one is in sight, never downwards, at most as many steps as that attractor is away.
        if (cfg.trunkSeeksCrown && !cfg.isShrub && !cfg.customAttractors.empty() && !attractors.empty() && cfg.branchStepLength > 0.0f) {
            auto inSight = [&]() {
                float d2 = 0.0f;
                for (const auto& a : attractors) if (sees(nodes.back(), a, d2)) return true;
                return false;
            };
            float nearestD = 1e30f;
            for (const auto& a : attractors) nearestD = std::min(nearestD, (a - nodes.back().position).length());
            const int maxSteps = static_cast<int>(std::ceil(nearestD / cfg.branchStepLength)) + 2;
            while (!inSight() && rep.trunkSeekSteps < maxSteps) {
                const Vec3 tip = nodes.back().position;
                Vec3 nearest = attractors.front();
                float best = 1e30f;
                for (const auto& a : attractors) {
                    const float d2 = (a - tip).lengthSquared();
                    if (d2 < best) { best = d2; nearest = a; }
                }
                Vec3 dir = nearest - tip;
                if (dir.y < 0.0f) dir.y = 0.0f;
                if (dir.lengthSquared() < 1e-12f) break;
                dir = dir.normalized();
                ColonizationNode nextNode;
                nextNode.id = static_cast<int>(nodes.size());
                nextNode.parentId = nodes.back().id;
                nextNode.position = tip + dir * cfg.branchStepLength;
                nextNode.growthDir = dir;
                nodes.back().children.push_back(nextNode.id);
                nodes.push_back(nextNode);
                ++rep.trunkSeekSteps;
            }
        }
        rep.trunkNodes = static_cast<int>(nodes.size());
        rep.trunkTopY = nodes.back().position.y;

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
                float fromLeader = cfg.scaffoldAngleFromLeaderRad;
                if (cfg.scaffoldAngleSpreadRad > 0.0f) fromLeader += (dist0To1(rng) * 2.0f - 1.0f) * cfg.scaffoldAngleSpreadRad;
                Vec3 scaffoldDir(std::cos(angle) * std::sin(fromLeader), std::cos(fromLeader), std::sin(angle) * std::sin(fromLeader));
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
        // Each attractor keeps the nearest node that sees it. Only nodes added since can change that (an older node was
        // already compared), and only they can come within the kill reach of an attractor still alive, so each new node
        // is compared with the attractors in the 27 grid cells around it (cell size >= the perception radius and the kill
        // reach). Ties keep the lower node id, as a scan over every node in id order would: the skeleton is the one the
        // plain O(attractors x nodes) search per iteration grows.
        const float effectiveKill = cfg.killRadius * 1.25f;
        const float effectiveKillSq = effectiveKill * effectiveKill;
        const float gridCell = std::max({cfg.perceptionRadius, effectiveKill, 1e-3f});
        auto cellOf = [&](const Vec3& p) {
            return std::array<int64_t, 3>{static_cast<int64_t>(std::floor(p.x / gridCell)), static_cast<int64_t>(std::floor(p.y / gridCell)),
                                          static_cast<int64_t>(std::floor(p.z / gridCell))};
        };
        auto packKey = [](int64_t a, int64_t b, int64_t c) {
            return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
        };
        const size_t A = attractors.size();
        std::unordered_map<uint64_t, std::vector<uint32_t>> attractorGrid;
        for (uint32_t i = 0; i < A; ++i) {
            const auto k = cellOf(attractors[i]);
            attractorGrid[packKey(k[0], k[1], k[2])].push_back(i);
        }
        std::vector<uint8_t> alive(A, 1);
        std::vector<float> bestD2(A, perceptionSq);
        std::vector<int> bestNode(A, -1);
        size_t aliveCount = A;
        auto forAttractorsNear = [&](const Vec3& p, auto&& visit) {
            const auto k = cellOf(p);
            for (int64_t dz = -1; dz <= 1; ++dz) {
                for (int64_t dy = -1; dy <= 1; ++dy) {
                    for (int64_t dx = -1; dx <= 1; ++dx) {
                        auto it = attractorGrid.find(packKey(k[0] + dx, k[1] + dy, k[2] + dz));
                        if (it == attractorGrid.end()) continue;
                        for (uint32_t i : it->second) {
                            if (alive[i]) visit(i);
                        }
                    }
                }
            }
        };
        // nearest seeing node per attractor, over the nodes from `from` on (in id order: a tie keeps the earlier node)
        auto compareNodes = [&](size_t from) {
            for (size_t n = from; n < nodes.size(); ++n) {
                const ColonizationNode& node = nodes[n];
                forAttractorsNear(node.position, [&](uint32_t i) {
                    float d2 = 0.0f;
                    if (sees(node, attractors[i], d2) && d2 < bestD2[i]) {
                        bestD2[i] = d2;
                        bestNode[i] = node.id;
                    }
                });
            }
        };
        // attractors within the kill reach of the nodes from `from` on die; returns how many
        auto killNear = [&](size_t from) {
            size_t killed = 0;
            for (size_t n = from; n < nodes.size(); ++n) {
                const Vec3 p = nodes[n].position;
                forAttractorsNear(p, [&](uint32_t i) {
                    if ((attractors[i] - p).lengthSquared() < effectiveKillSq) {
                        alive[i] = 0;
                        ++killed;
                    }
                });
            }
            aliveCount -= killed;
            return killed;
        };
        compareNodes(0);
        size_t killChecked = 0;  // nodes from here on have not been kill-checked yet (the first check takes the trunk too)

        rep.stop = "iteration_cap";
        int sinceReached = 0;
        for (int iter = 0; iter < cfg.maxIterations; ++iter) {
            if (aliveCount == 0) { rep.stop = "all_attractors_reached"; break; }

            // Map each node to accumulated attraction direction and count
            std::unordered_map<int, Vec3> nodeAttractionDir;
            std::unordered_map<int, int> nodeAttractionCount;

            // Each attractor pulls its nearest seeing node (in attractor order, as the sums are taken)
            for (size_t i = 0; i < A; ++i) {
                if (!alive[i] || bestNode[i] < 0) continue;
                Vec3 dir = (attractors[i] - nodes[bestNode[i]].position).normalized();
                nodeAttractionDir[bestNode[i]] += dir;
                nodeAttractionCount[bestNode[i]]++;
            }

            if (nodeAttractionDir.empty()) { rep.stop = "no_attractor_within_perception"; break; }

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

            const size_t firstNew = nodes.size();
            for (const auto& n : newNodes) {
                nodes[n.parentId].children.push_back(n.id);
                nodes.push_back(n);
            }
            rep.iterations = iter + 1;

            if (newNodes.empty()) break;

            // Prune attractors inside kill radius of any node, then let the survivors see the new nodes
            const size_t killed = killNear(killChecked);
            killChecked = nodes.size();
            compareNodes(firstNew);
            sinceReached = killed > 0 ? 0 : sinceReached + 1;
            if (cfg.stallIterations > 0 && sinceReached >= cfg.stallIterations) { rep.stop = "stalled"; break; }
        }
        if (aliveCount == 0) rep.stop = "all_attractors_reached";
        rep.attractorsReached = A - aliveCount;

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
        return nodes;
    }

    /**
     * Meshes a skeleton growSkeleton grew from `cfg` within cfg.triangleBudget (> 0): the same meshes
     * generateTreeComponents gives for that budget, without growing the skeleton again.
     */
    static std::pair<geometry::Mesh, geometry::Mesh> meshGrownSkeleton(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& nodes, TreeBudgetReport* report = nullptr,
                                                                       MeshGrowth* growth = nullptr) {
        geometry::Mesh woodMesh("Tree_Wood");
        woodMesh.material = geometry::PbrMaterial::roughWood();
        woodMesh.material.name = "PBR_Redwood_Bark";
        woodMesh.material.roughnessFactor = 0.92f;
        woodMesh.material.metallicFactor = 0.02f;
        geometry::Mesh foliageMesh("Tree_Foliage");
        foliageMesh.material.name = "PBR_Canopy_Foliage";
        foliageMesh.material.roughnessFactor = 0.58f;
        foliageMesh.material.metallicFactor = 0.01f;
        foliageMesh.material.doubleSided = true;
        foliageMesh.material.alphaMode = "MASK";
        foliageMesh.material.alphaCutoff = 0.45f;
        TreeBudgetReport local;
        if (cfg.triangleBudget > 0.0f) meshWithinBudget(cfg, nodes, woodMesh, foliageMesh, report ? *report : local, growth);
        for (const auto& v : woodMesh.vertices) woodMesh.bounds.expand(v);
        for (const auto& v : foliageMesh.vertices) foliageMesh.bounds.expand(v);
        return {woodMesh, foliageMesh};
    }

    /** Share of the trunk radius below which a branch carries leaves at any budget (budgeted meshing). */
    static constexpr float kTwigRadiusShare = 0.12f;

    /**
     * The leaf nodes the budgeted meshing has at any budget: every tip, and every twig thinner than kTwigRadiusShare of
     * the trunk, above the crown break (rootAnchor.y + 0.85 clearTrunkHeight), and with leavesOnCrownBranches every
     * branch node that grew through the measured crown. A smaller budget prunes more wood, so it has these and more.
     * The leaf masses sit on (or between) leaf nodes and are kept inside the crown, so they need not cover every leaf
     * node: what the delivered masses reach is measured on the mesh (scratchbox_tile_vegetation.hpp measureFoliage).
     */
    static std::vector<Vec3> foliageAnchors(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g) {
        std::vector<Vec3> pts;
        if (g.size() < 2) return pts;
        const std::vector<uint8_t> leafy = leafyNodes(cfg, g, kTwigRadiusShare * trunkReferenceRadius(cfg, g));
        for (size_t i = 0; i < g.size(); ++i) {
            if (leafy[i]) pts.push_back(g[i].position);
        }
        return pts;
    }

    /**
     * Nodes that carry leaves at a twig radius: above the crown break, every tip and every twig thinner than
     * `twigRadius` (in `radii`, the meshing's scaled radii, when given; else the skeleton's own), and with
     * leavesOnCrownBranches every node within the kill reach of an attractor.
     */
    static std::vector<uint8_t> leafyNodes(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g, float twigRadius,
                                           const std::vector<float>* radii = nullptr) {
        std::vector<uint8_t> leafy(g.size(), 0);
        const float crownBottom = cfg.rootAnchor.y + cfg.clearTrunkHeight * 0.85f;
        for (size_t i = 0; i < g.size(); ++i) {
            if (g[i].position.y < crownBottom) continue;
            const float r = radii ? (*radii)[i] : g[i].radius;
            if (g[i].children.empty() || r < twigRadius) leafy[i] = 1;
        }
        if (!cfg.leavesOnCrownBranches || cfg.customAttractors.empty()) return leafy;
        const float reach = std::max(1e-3f, cfg.killRadius * 1.25f);
        const float reachSq = reach * reach;
        auto pack = [&](const Vec3& p, int dx, int dy, int dz) {
            const int64_t a = static_cast<int64_t>(std::floor(p.x / reach)) + dx, b = static_cast<int64_t>(std::floor(p.y / reach)) + dy, c = static_cast<int64_t>(std::floor(p.z / reach)) + dz;
            return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
        };
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        for (uint32_t i = 0; i < cfg.customAttractors.size(); ++i) grid[pack(cfg.customAttractors[i], 0, 0, 0)].push_back(i);
        for (size_t i = 0; i < g.size(); ++i) {
            if (leafy[i] || g[i].position.y < crownBottom) continue;
            const Vec3 p = g[i].position;
            for (int dz = -1; dz <= 1 && !leafy[i]; ++dz) {
                for (int dy = -1; dy <= 1 && !leafy[i]; ++dy) {
                    for (int dx = -1; dx <= 1 && !leafy[i]; ++dx) {
                        auto it = grid.find(pack(p, dx, dy, dz));
                        if (it == grid.end()) continue;
                        for (uint32_t a : it->second) {
                            if ((cfg.customAttractors[a] - p).lengthSquared() < reachSq) { leafy[i] = 1; break; }
                        }
                    }
                }
            }
        }
        return leafy;
    }

    /** The skeleton radius the meshing scales to cfg.baseRadius: the trunk's, above its root flare. */
    static float trunkRadiusReference(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g) { return trunkReferenceRadius(cfg, g); }

    static std::pair<geometry::Mesh, geometry::Mesh> generateTreeComponents(const SpaceColonizationConfig& cfg, TreeBudgetReport* report = nullptr) {
        geometry::Mesh woodMesh("Tree_Wood");
        woodMesh.material = geometry::PbrMaterial::roughWood();
        woodMesh.material.name = "PBR_Redwood_Bark";
        woodMesh.material.roughnessFactor = 0.92f;
        woodMesh.material.metallicFactor = 0.02f;

        geometry::Mesh foliageMesh("Tree_Foliage");
        foliageMesh.material.name = "PBR_Canopy_Foliage";
        foliageMesh.material.roughnessFactor = 0.58f;
        foliageMesh.material.metallicFactor = 0.01f;
        foliageMesh.material.doubleSided = true;
        foliageMesh.material.alphaMode = "MASK";
        foliageMesh.material.alphaCutoff = 0.45f;
        std::mt19937 rng(cfg.seed);
        std::uniform_real_distribution<float> dist0To1(0.0f, 1.0f);

        const std::vector<ColonizationNode> nodes = growSkeleton(cfg, rng);

        if (cfg.triangleBudget > 0.0f) return meshGrownSkeleton(cfg, nodes, report);

        // 5. Build Branch Cylinder Meshes
        for (const auto& node : nodes) {
            if (node.parentId >= 0) {
                const auto& parent = nodes[node.parentId];
                float rStart = parent.radius;
                float rEnd = node.radius;

                // Buttress root flare: expand trunk diameter exponentially near ground anchor
                if (parent.position.y <= cfg.rootAnchor.y + 0.9f) {
                    float relY = std::max(0.0f, parent.position.y - cfg.rootAnchor.y);
                    float flareFactor = 1.0f + 1.25f * std::exp(-relY / 0.40f);
                    rStart *= flareFactor;
                }
                if (node.position.y <= cfg.rootAnchor.y + 0.9f) {
                    float relY = std::max(0.0f, node.position.y - cfg.rootAnchor.y);
                    float flareFactor = 1.0f + 1.25f * std::exp(-relY / 0.40f);
                    rEnd *= flareFactor;
                }

                appendBranchCylinder(
                    woodMesh,
                    parent.position, node.position,
                    rStart, rEnd,
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
                lCfg.outline = cfg.leafOutline;
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
                            TwigClusterGenerator::appendTwigCluster(foliageMesh, node.position, branchDir, tCfg);
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
                                    TwigClusterGenerator::appendTwigCluster(foliageMesh, node.position, lateralDir, lateralTCfg);

                                    // For dense vegetative blobs (rho > 0.55), sprout second bilateral lateral spray
                                    if (cfg.volumetricDensity > 0.55f && fDist(fRng) < (cfg.volumetricDensity - 0.25f)) {
                                        Vec3 branchTangent = node.growthDir.normalized();
                                        Vec3 binormal = branchTangent.cross(Vec3(0, 1, 0));
                                        if (binormal.lengthSquared() < 0.01f) binormal = branchTangent.cross(Vec3(1, 0, 0));
                                        binormal = binormal.normalized();
                                        Vec3 oppDir = (branchTangent * 0.35f + binormal * 0.55f + outward * 0.45f + Vec3(0, 0.18f, 0)).normalized();
                                        TwigClusterGenerator::appendTwigCluster(foliageMesh, node.position, oppDir, lateralTCfg);
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
                            DetailedLeafGenerator::appendDetailedLeaf(foliageMesh, pos, leafDir, leafNorm, scale, lCfg);
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

                        // Create three intersecting rosette quads (60-degree offsets) for volumetric fullness
                        for (int q = 0; q < 3; ++q) {
                            float qAngle = angle + (q * (math::PI / 3.0f));
                            Vec3 right(std::cos(qAngle) * cfg.leafSize * scale * 0.5f, 0, std::sin(qAngle) * cfg.leafSize * scale * 0.5f);
                            Vec3 up(0, cfg.leafSize * scale * 0.5f, 0);

                            uint32_t bIdx = static_cast<uint32_t>(foliageMesh.vertices.size());
                            foliageMesh.vertices.push_back(leafCenter - right - up);
                            foliageMesh.vertices.push_back(leafCenter + right - up);
                            foliageMesh.vertices.push_back(leafCenter + right + up);
                            foliageMesh.vertices.push_back(leafCenter - right + up);

                            // Subtle natural chlorophyll variation per card
                            float shadeJitter = 0.92f + dist0To1(rng) * 0.16f;
                            Vec4 cardColor = Vec4(cfg.leafColor.x * shadeJitter, cfg.leafColor.y * shadeJitter, cfg.leafColor.z * shadeJitter, 1.0f);

                            Vec3 n = right.cross(up).normalized();
                            for (int k = 0; k < 4; ++k) {
                                foliageMesh.normals.push_back(n);
                                foliageMesh.vertexColors.push_back(cardColor);
                            }
                            foliageMesh.uvs.push_back(Vec2(0.5f, 0.0f));
                            foliageMesh.uvs.push_back(Vec2(1.0f, 0.5f));
                            foliageMesh.uvs.push_back(Vec2(0.5f, 1.0f));
                            foliageMesh.uvs.push_back(Vec2(0.0f, 0.5f));

                            foliageMesh.indices.push_back(bIdx);
                            foliageMesh.indices.push_back(bIdx + 1);
                            foliageMesh.indices.push_back(bIdx + 2);

                            foliageMesh.indices.push_back(bIdx);
                            foliageMesh.indices.push_back(bIdx + 2);
                            foliageMesh.indices.push_back(bIdx + 3);
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
            transferFoliageNormals(foliageMesh, foliageHelpers, 0.85f, 0.25f);
        }

        for (const auto& v : woodMesh.vertices) woodMesh.bounds.expand(v);
        for (const auto& v : foliageMesh.vertices) foliageMesh.bounds.expand(v);
        return {woodMesh, foliageMesh};
    }

    static geometry::Mesh generateTree(const SpaceColonizationConfig& cfg) {
        auto [woodMesh, foliageMesh] = generateTreeComponents(cfg);
        geometry::Mesh combined = woodMesh;
        if (!foliageMesh.vertices.empty()) {
            uint32_t offset = static_cast<uint32_t>(combined.vertices.size());
            combined.vertices.insert(combined.vertices.end(), foliageMesh.vertices.begin(), foliageMesh.vertices.end());
            combined.normals.insert(combined.normals.end(), foliageMesh.normals.begin(), foliageMesh.normals.end());
            combined.uvs.insert(combined.uvs.end(), foliageMesh.uvs.begin(), foliageMesh.uvs.end());
            combined.vertexColors.insert(combined.vertexColors.end(), foliageMesh.vertexColors.begin(), foliageMesh.vertexColors.end());
            for (uint32_t idx : foliageMesh.indices) {
                combined.indices.push_back(offset + idx);
            }
            combined.bounds.expand(foliageMesh.bounds.min);
            combined.bounds.expand(foliageMesh.bounds.max);
        }
        return combined;
    }

private:
    /** Deterministic value in [0, 1) from a seed and two indices (no shared RNG state, so meshing order is free). */
    static float hashUnit(uint32_t seed, uint32_t a, uint32_t b) {
        uint64_t h = (static_cast<uint64_t>(seed) << 32) ^ (static_cast<uint64_t>(a) * 0x9E3779B97F4A7C15ull) ^ (static_cast<uint64_t>(b) * 0xC2B2AE3D27D4EB4Full);
        h ^= h >> 33; h *= 0xff51afd7ed558ccdull; h ^= h >> 33; h *= 0xc4ceb9fe1a85ec53ull; h ^= h >> 33;
        return static_cast<float>((h >> 40) & 0xFFFFFF) / 16777216.0f;
    }

    /** Unit icosphere: level 0 = 12 vertices / 20 triangles, level 1 = 42 / 80 (outward winding). */
    static void unitIcosphere(int level, std::vector<Vec3>& verts, std::vector<uint32_t>& tris) {
        const float t = (1.0f + std::sqrt(5.0f)) * 0.5f;
        verts = {Vec3(-1, t, 0), Vec3(1, t, 0), Vec3(-1, -t, 0), Vec3(1, -t, 0), Vec3(0, -1, t), Vec3(0, 1, t),
                 Vec3(0, -1, -t), Vec3(0, 1, -t), Vec3(t, 0, -1), Vec3(t, 0, 1), Vec3(-t, 0, -1), Vec3(-t, 0, 1)};
        for (auto& v : verts) v = v.normalized();
        tris = {0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
                3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1};
        for (int l = 0; l < level; ++l) {
            std::unordered_map<uint64_t, uint32_t> mid;
            auto midpoint = [&](uint32_t a, uint32_t b) {
                const uint64_t key = a < b ? (static_cast<uint64_t>(a) << 32 | b) : (static_cast<uint64_t>(b) << 32 | a);
                auto it = mid.find(key);
                if (it != mid.end()) return it->second;
                verts.push_back(((verts[a] + verts[b]) * 0.5f).normalized());
                const uint32_t id = static_cast<uint32_t>(verts.size() - 1);
                mid.emplace(key, id);
                return id;
            };
            std::vector<uint32_t> next;
            for (size_t i = 0; i < tris.size(); i += 3) {
                const uint32_t a = tris[i], b = tris[i + 1], c = tris[i + 2];
                const uint32_t ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
                next.insert(next.end(), {a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca});
            }
            tris = std::move(next);
        }
    }

    /** Trunk radius reference: the first trunk node above the root flare (or the last one before the crown break). */
    static float trunkReferenceRadius(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g) {
        float trunkRef = g[0].radius;
        size_t n = 0;
        while (g[n].children.size() == 1) {
            n = static_cast<size_t>(g[n].children[0]);
            trunkRef = g[n].radius;
            if (g[n].position.y >= cfg.rootAnchor.y + cfg.rootFlareHeight) break;
        }
        return trunkRef;
    }

    // Leaf masses (budgeted meshing): a unit icosphere squashed in y by kLeafSquash, each vertex moved radially by
    // 1 -+ kLeafJitterAmp / 2 of the mass's size.
    static constexpr float kLeafJitterAmp = 0.48f;
    static constexpr float kLeafSquash = 0.82f;
    static constexpr float kLeafJitterMax = 1.0f + 0.5f * kLeafJitterAmp;
    static constexpr float kLeafJitterMin = 1.0f - 0.5f * kLeafJitterAmp;
    static constexpr int kFootprintSectors = 16;

    /**
     * Where a tree's leaf masses may go: all of each mass inside its crown, so a coarse budget does not grow the tree
     * past the crown it was fitted to. With a measured surface (cfg.foliageSurface) the crown is its footprint (the
     * farthest surface point from the trunk in each of 16 sectors, a mass kept within its centre's sector's) up to its
     * highest surface point (or cfg.foliageTop); without one, an elliptic cylinder of radii crownExtents.x/z around
     * crownCenter up to crownCenter.y + crownExtents.y. Its bottom is crownCenter.y - crownExtents.y either way, and a
     * mass is never larger than the crown's smallest extent.
     */
    struct LeafEnvelope {
        bool measured{false};
        std::array<float, kFootprintSectors> footprint{};
        Vec3 axis{0, 0, 0}, center{0, 0, 0}, extents{1, 1, 1};
        float top{0}, bottom{0}, sizeCap{1};

        static int sector(float dx, float dz) {
            return static_cast<int>(std::floor((std::atan2(dz, dx) + math::PI) / math::TWO_PI * kFootprintSectors)) & (kFootprintSectors - 1);
        }
        static LeafEnvelope of(const SpaceColonizationConfig& cfg) {
            LeafEnvelope e;
            e.axis = cfg.rootAnchor;
            e.center = cfg.crownCenter;
            e.extents = cfg.crownExtents;
            e.bottom = cfg.crownCenter.y - cfg.crownExtents.y;
            e.top = cfg.crownCenter.y + cfg.crownExtents.y;
            e.sizeCap = std::max(1e-3f, std::min({cfg.crownExtents.x, cfg.crownExtents.y / kLeafSquash, cfg.crownExtents.z}) / kLeafJitterMax);
            e.measured = !cfg.foliageSurface.empty() && cfg.foliageSurfaceReach > 0.0f;
            if (!e.measured) return e;
            e.top = -std::numeric_limits<float>::infinity();
            for (const auto& s : cfg.foliageSurface) {
                const float dx = s.x - e.axis.x, dz = s.z - e.axis.z;
                float& f = e.footprint[static_cast<size_t>(sector(dx, dz))];
                f = std::max(f, std::sqrt(dx * dx + dz * dz));
                e.top = std::max(e.top, s.y);
            }
            if (std::isfinite(cfg.foliageTop)) e.top = std::max(e.top, cfg.foliageTop);
            // a sector with no surface point takes its neighbours' (the footprint is measured; a gap in it is not a hole)
            for (int pass = 0; pass < 2; ++pass) {
                for (int s = 0; s < kFootprintSectors; ++s) {
                    float& f = e.footprint[static_cast<size_t>(s)];
                    if (f > 0.0f) continue;
                    const float a = e.footprint[static_cast<size_t>((s + kFootprintSectors - 1) % kFootprintSectors)];
                    const float b = e.footprint[static_cast<size_t>((s + 1) % kFootprintSectors)];
                    if (a > 0.0f || b > 0.0f) f = (a > 0.0f && b > 0.0f) ? 0.5f * (a + b) : std::max(a, b);
                }
            }
            return e;
        }
        /** A centre for a mass of this size, moved in from the crown's edge (towards its axis) until all of it is inside. */
        Vec3 keepIn(Vec3 c, float size) const {
            const float reachH = size * kLeafJitterMax, reachV = size * kLeafSquash * kLeafJitterMax;
            c.y = std::clamp(c.y, bottom + reachV, std::max(bottom + reachV, top - reachV));
            if (measured) {
                const float dx = c.x - axis.x, dz = c.z - axis.z;
                const float limit = std::max(0.0f, footprint[static_cast<size_t>(sector(dx, dz))] - reachH);
                const float r = std::sqrt(dx * dx + dz * dz);
                if (r > limit) {
                    const float k = r > 1e-6f ? limit / r : 0.0f;
                    c.x = axis.x + dx * k;
                    c.z = axis.z + dz * k;
                }
                return c;
            }
            const float ax = std::max(1e-3f, extents.x - reachH), az = std::max(1e-3f, extents.z - reachH);
            const float dx = c.x - center.x, dz = c.z - center.z;
            const float q = std::sqrt((dx * dx) / (ax * ax) + (dz * dz) / (az * az));
            if (q > 1.0f) {
                c.x = center.x + dx / q;
                c.z = center.z + dz / q;
            }
            return c;
        }
    };

    /** The size of a leaf mass: 0.85..1.15 of its nominal size (drawn for its place ci in the mesh), never over sizeCap. */
    static float leafMassSize(const SpaceColonizationConfig& cfg, const LeafEnvelope& env, size_t ci, float nominal) {
        return std::min(env.sizeCap, nominal * (0.85f + 0.3f * hashUnit(cfg.seed ^ 0xA5A5A5A5u, static_cast<uint32_t>(ci), 0u)));
    }

    /**
     * Nominal size of the leaf masses on a measured surface (see surfaceMassCentres). Kept inside the crown, a mass of
     * size s sits up to 1.24 s in from its side and 1.02 s down from its top, so 1.6 s from a point on its upper edge,
     * which its inner ball (0.49 s) and the reach must span: 0.6 of the reach leaves a third of the reach to spare.
     */
    static float surfaceMassNominal(const SpaceColonizationConfig& cfg, const LeafEnvelope& env) {
        return std::min(env.sizeCap, 0.6f * cfg.foliageSurfaceReach);
    }

    /**
     * The leaf masses that bring the measured crown surface (cfg.foliageSurface) within cfg.foliageSurfaceReach, in the
     * order they go into the mesh, each with the surface points it newly brings within reach.
     *
     * A mass of size s is a star around its centre whose faces all lie beyond the planes of the unit sphere's faces
     * scaled by kLeafJitterMin (squashed by kLeafSquash), so it holds the ball of radius
     *   inner(s) = kLeafSquash * kLeafJitterMin * (nearest face plane of the 20-face unit icosphere, 0.79) * s,
     * and a point within inner + reach of its centre lies inside it or within reach of it (finer masses hold a larger
     * ball). These masses are smaller than the reach (surfaceMassNominal): kept inside the crown, a larger one sits too
     * far in from its edge and top to reach the surface points there. Candidate centres are the leaf nodes `pts` (one
     * per cell of a fifth of that cover radius), each moved into the crown as the largest such mass is. The first mass
     * goes on the candidate nearest the crown's highest point, when one reaches it; the rest go, greedily, where they
     * bring the most points not yet within reach (ties to the lower candidate), until every point a candidate reaches is.
     */
    static std::vector<std::pair<Vec3, size_t>> surfaceMassCentres(const SpaceColonizationConfig& cfg, const LeafEnvelope& env, const std::vector<Vec3>& pts) {
        std::vector<std::pair<Vec3, size_t>> out;
        if (!env.measured || pts.empty()) return out;
        std::vector<Vec3> sphere;
        std::vector<uint32_t> sphereTris;
        unitIcosphere(0, sphere, sphereTris);
        float facePlane = 1.0f;
        for (size_t t = 0; t + 2 < sphereTris.size(); t += 3) {
            const Vec3 a = sphere[sphereTris[t]], b = sphere[sphereTris[t + 1]], c = sphere[sphereTris[t + 2]];
            facePlane = std::min(facePlane, std::abs((b - a).cross(c - a).normalized().dot(a)));
        }
        const float nominal = surfaceMassNominal(cfg, env);
        const float sizeLo = std::min(env.sizeCap, 0.85f * nominal), sizeHi = std::min(env.sizeCap, 1.15f * nominal);
        const float cover = kLeafSquash * kLeafJitterMin * facePlane * sizeLo + cfg.foliageSurfaceReach;
        const std::vector<Vec3>& S = cfg.foliageSurface;
        auto key3 = [](const Vec3& p, float cell, int dx, int dy, int dz) {
            const int64_t a = static_cast<int64_t>(std::floor(p.x / cell)) + dx, b = static_cast<int64_t>(std::floor(p.y / cell)) + dy, c = static_cast<int64_t>(std::floor(p.z / cell)) + dz;
            return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
        };
        std::vector<Vec3> cand;
        {
            std::unordered_map<uint64_t, uint8_t> taken;
            const float cc = std::max(1e-3f, 0.2f * cover);
            for (const auto& p : pts) {
                if (taken.emplace(key3(p, cc, 0, 0, 0), 1).second) cand.push_back(env.keepIn(p, sizeHi));
            }
        }
        std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
        for (uint32_t i = 0; i < S.size(); ++i) grid[key3(S[i], cover, 0, 0, 0)].push_back(i);
        std::vector<std::vector<uint32_t>> reaches(cand.size());
        const float cover2 = cover * cover;
        for (size_t k = 0; k < cand.size(); ++k) {
            for (int dz = -1; dz <= 1; ++dz) {
                for (int dy = -1; dy <= 1; ++dy) {
                    for (int dx = -1; dx <= 1; ++dx) {
                        auto it = grid.find(key3(cand[k], cover, dx, dy, dz));
                        if (it == grid.end()) continue;
                        for (uint32_t i : it->second) if ((S[i] - cand[k]).lengthSquared() <= cover2) reaches[k].push_back(i);
                    }
                }
            }
        }
        std::vector<uint8_t> reached(S.size(), 0);
        // the crown's highest point first (the tree's height is what a budget must never cut): the candidate nearest it
        {
            size_t apex = 0;
            for (size_t i = 1; i < S.size(); ++i) if (S[i].y > S[apex].y) apex = i;
            long best = -1;
            float bestD2 = std::numeric_limits<float>::infinity();
            for (size_t k = 0; k < cand.size(); ++k) {
                const float d2 = (cand[k] - S[apex]).lengthSquared();
                if (d2 <= cover2 && d2 < bestD2) { bestD2 = d2; best = static_cast<long>(k); }
            }
            if (best >= 0) {
                for (uint32_t i : reaches[static_cast<size_t>(best)]) reached[i] = 1;
                out.push_back({cand[static_cast<size_t>(best)], reaches[static_cast<size_t>(best)].size()});
            }
        }
        // then lazy greedy (a candidate's gain only falls as points are reached)
        auto worse = [](const std::pair<size_t, uint32_t>& a, const std::pair<size_t, uint32_t>& b) { return a.first < b.first || (a.first == b.first && a.second > b.second); };
        std::priority_queue<std::pair<size_t, uint32_t>, std::vector<std::pair<size_t, uint32_t>>, decltype(worse)> heap(worse);
        for (uint32_t k = 0; k < cand.size(); ++k) if (!reaches[k].empty()) heap.push({reaches[k].size(), k});
        while (!heap.empty()) {
            const auto [gain, k] = heap.top();
            heap.pop();
            size_t now = 0;
            for (uint32_t i : reaches[k]) now += reached[i] ? 0 : 1;
            if (now == 0) continue;
            if (now < gain) { heap.push({now, k}); continue; }
            for (uint32_t i : reaches[k]) reached[i] = 1;
            out.push_back({cand[k], now});
        }
        return out;
    }

public:
    /**
     * How many leaf masses the budgeted meshing puts on cfg.foliageSurface before any other: as many as it takes to bring
     * every surface point the tree's leaf nodes can reach within cfg.foliageSurfaceReach (0 without a surface). The
     * meshing holds them all when its foliage (the budget less the wood, at least 1 - woodBudgetShare of it) holds that
     * many 20-triangle masses. Counted from the leaf nodes every budget has (foliageAnchors).
     */
    static size_t surfaceMassesNeeded(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g) {
        const LeafEnvelope env = LeafEnvelope::of(cfg);
        return surfaceMassCentres(cfg, env, foliageAnchors(cfg, g)).size();
    }

private:
    /**
     * Meshes a grown skeleton within cfg.triangleBudget. Wood: chains of single-child nodes are simplified
     * (Douglas-Peucker, tolerance a fraction of the local radius), each kept segment is a tube whose side count grows
     * with sqrt(radius), and segments that start thinner than a bisected radius are pruned; the trunk chain is always
     * kept. Foliage: the leaf nodes (the pruned twigs, the remaining tips, and with leavesOnCrownBranches the branches
     * that grew through the measured crown) carry the leaf masses. With a measured surface the first masses go where
     * they bring it within reach (surfaceMassCentres), as many as the budget holds; the rest of the leaf nodes are
     * gathered into voxels, the smallest that fit the masses left, each voxel one mass at its nodes' centroid. Every
     * mass is kept inside the crown (LeafEnvelope).
     */
    static void meshWithinBudget(const SpaceColonizationConfig& cfg, const std::vector<ColonizationNode>& g,
                                 geometry::Mesh& wood, geometry::Mesh& foliage, TreeBudgetReport& rep, MeshGrowth* growth = nullptr) {
        const size_t N = g.size();
        rep = TreeBudgetReport{};
        rep.skeletonNodes = N;
        if (growth) { growth->wood.clear(); growth->foliage.clear(); growth->pruned.clear(); }
        if (N < 2) return;
        // a node's place in the growth: its id (creation order) over max(1, nodes - 1)
        const float growthDen = static_cast<float>(std::max<size_t>(1, N - 1));
        const size_t budget = static_cast<size_t>(std::max(0.0f, cfg.triangleBudget));
        auto node = [&](int i) -> const ColonizationNode& { return g[static_cast<size_t>(i)]; };

        const float trunkRef = trunkReferenceRadius(cfg, g);
        const float scale = (cfg.baseRadius > 0.0f && trunkRef > 1e-6f) ? cfg.baseRadius / trunkRef : 1.0f;
        std::vector<float> radius(N);
        for (size_t i = 0; i < N; ++i) radius[i] = g[i].radius * scale;
        auto rad = [&](int i) { return radius[static_cast<size_t>(i)]; };
        const float rRef = std::max(1e-4f, trunkRef * scale);
        const float treeHeight = std::max(0.5f, cfg.crownCenter.y + cfg.crownExtents.y - cfg.rootAnchor.y);

        // Chains: from the root and from every branching node, following single-child links.
        std::vector<std::vector<int>> chains;
        std::vector<int> starts{0};
        for (size_t i = 1; i < N; ++i) {
            if (g[i].children.size() >= 2) starts.push_back(static_cast<int>(i));
        }
        for (int s : starts) {
            const auto& kids = node(s).children;
            if (s == 0 && kids.size() == 1) {
                std::vector<int> c{0};
                int n = 0;
                while (node(n).children.size() == 1) { n = node(n).children[0]; c.push_back(n); }
                chains.push_back(std::move(c));
                continue;
            }
            for (int k : kids) {
                std::vector<int> c{s, k};
                int n = k;
                while (node(n).children.size() == 1) { n = node(n).children[0]; c.push_back(n); }
                chains.push_back(std::move(c));
            }
        }
        // Douglas-Peucker on each chain; the first chain from a single-child root is the trunk.
        struct Seg { int a, b; bool trunk; float rA; };   // rA: the radius the segment starts with
        std::vector<Seg> segs;
        for (size_t ci = 0; ci < chains.size(); ++ci) {
            const auto& c = chains[ci];
            std::vector<uint8_t> keep(c.size(), 0);
            keep.front() = 1;
            keep.back() = 1;
            std::vector<std::pair<size_t, size_t>> stack{{0, c.size() - 1}};
            while (!stack.empty()) {
                const auto [lo, hi] = stack.back();
                stack.pop_back();
                if (hi <= lo + 1) continue;
                const Vec3 A = node(c[lo]).position, B = node(c[hi]).position;
                const Vec3 AB = B - A;
                const float len2 = std::max(1e-12f, AB.lengthSquared());
                float worst = -1.0f;
                size_t at = lo;
                for (size_t m = lo + 1; m < hi; ++m) {
                    const Vec3 P = node(c[m]).position;
                    const float tt = std::clamp((P - A).dot(AB) / len2, 0.0f, 1.0f);
                    const float d = (P - (A + AB * tt)).length();
                    if (d > worst) { worst = d; at = m; }
                }
                const float tol = std::max(0.02f, 0.35f * rad(c[lo]));
                if (worst > tol) {
                    keep[at] = 1;
                    stack.push_back({lo, at});
                    stack.push_back({at, hi});
                }
            }
            const bool trunk = ci == 0 && g[0].children.size() == 1;
            int prev = -1;
            for (size_t m = 0; m < c.size(); ++m) {
                if (!keep[m]) continue;
                // pipe model: the branch that leaves a fork carries its own radius from the fork on (the fork node's radius is
                // its parent's, the sum of its children's), so a child chain starts as thick as the child, not as the limb it leaves
                if (prev >= 0) segs.push_back({prev, c[m], trunk, (prev == c[0] && c.size() > 1 && node(c[0]).children.size() >= 2) ? rad(c[1]) : rad(prev)});
                prev = c[m];
            }
        }

        auto sides = [&](float r, int sidesMax) {
            return std::clamp(static_cast<int>(std::lround(sidesMax * std::sqrt(std::max(0.0f, r) / rRef))), 3, sidesMax);
        };
        // a kept segment whose end node starts no kept segment is a branch end: it is closed with a cone (one triangle a side)
        std::vector<std::vector<uint32_t>> startsAt(N);
        for (size_t k = 0; k < segs.size(); ++k) startsAt[static_cast<size_t>(segs[k].a)].push_back(static_cast<uint32_t>(k));
        auto isKept = [&](const Seg& s, float rMin) { return s.trunk || s.rA >= rMin; };
        auto endsHere = [&](const Seg& s, float rMin) {
            for (uint32_t k : startsAt[static_cast<size_t>(s.b)]) if (isKept(segs[k], rMin)) return false;
            return true;
        };
        auto woodTris = [&](float rMin, int sidesMax) {
            size_t t = 0;
            for (const auto& s : segs) {
                if (!isKept(s, rMin)) continue;
                const size_t n = static_cast<size_t>(sides(s.rA, sidesMax));
                t += 2 * n + (endsHere(s, rMin) ? n : 0);
            }
            return t;
        };
        const size_t woodBudget = static_cast<size_t>(std::floor(static_cast<double>(budget) * std::clamp(cfg.woodBudgetShare, 0.0f, 1.0f)));
        float rMax = 0.0f;
        for (float r : radius) rMax = std::max(rMax, r);
        const float beyond = rMax * 2.0f + 1.0f;
        int sidesMax = 8;
        while (sidesMax > 3 && woodTris(beyond, sidesMax) > woodBudget) --sidesMax;
        float rMin = 0.0f;
        if (woodTris(0.0f, sidesMax) > woodBudget) {
            float lo = 0.0f, hi = beyond;
            for (int it = 0; it < 48; ++it) {
                const float m = 0.5f * (lo + hi);
                if (woodTris(m, sidesMax) > woodBudget) lo = m; else hi = m;
            }
            rMin = hi;
        }
        // joints: a kept segment continuing into exactly one other kept segment bends at its end node; both tubes run on past the node by
        // r tan(half the bend) so the wedge the bend opens on the outside is covered (what read as ring joints)
        std::vector<int> keptIn(N, -1), keptInCount(N, 0);
        for (size_t k = 0; k < segs.size(); ++k) {
            if (!isKept(segs[k], rMin)) continue;
            const size_t bnode = static_cast<size_t>(segs[k].b);
            keptIn[bnode] = static_cast<int>(k);
            ++keptInCount[bnode];
        }
        auto jointExtend = [&](const Seg& s, bool atEnd) -> float {
            const Seg* other = nullptr;
            if (atEnd) {
                int count = 0;
                for (uint32_t k : startsAt[static_cast<size_t>(s.b)]) if (isKept(segs[k], rMin)) { other = &segs[k]; ++count; }
                if (count != 1) return 0.0f;
            } else {
                const size_t an = static_cast<size_t>(s.a);
                if (keptInCount[an] != 1 || startsAt[an].size() != 1) return 0.0f;
                other = &segs[static_cast<size_t>(keptIn[an])];
            }
            const Vec3 d0 = (node(s.b).position - node(s.a).position).normalized();
            const Vec3 d1 = (node(other->b).position - node(other->a).position).normalized();
            const float c = std::clamp(d0.dot(d1), -1.0f, 1.0f);
            const float halfBend = 0.5f * std::acos(c);
            const float r = atEnd ? rad(s.b) : s.rA;
            const float len = (node(s.b).position - node(s.a).position).length();
            return std::min({r * std::tan(std::min(halfBend, 1.2f)), r, 0.45f * len});
        };
        // bark-tile UVs: v is the path length from the root (nodes are created after their parents)
        const bool tiledUv = cfg.barkTileAroundM > 0.0f && cfg.barkTileAlongM > 0.0f;
        std::vector<float> arc(tiledUv ? N : 0, 0.0f);
        if (tiledUv) {
            for (size_t i = 0; i < N; ++i) {
                const int p = g[i].parentId;
                if (p >= 0 && static_cast<size_t>(p) < i) arc[i] = arc[static_cast<size_t>(p)] + (g[i].position - g[static_cast<size_t>(p)].position).length();
            }
        }
        for (const auto& s : segs) {
            if (!s.trunk && s.rA < rMin) {
                if (growth) growth->pruned.push_back({s.a, s.b, s.rA, rad(s.b)});
                continue;
            }
            const size_t before = wood.vertices.size();
            const bool ends = endsHere(s, rMin);
            BranchUv tile;
            if (tiledUv) {
                tile.around = std::max(1.0f, std::round(math::TWO_PI * s.rA / cfg.barkTileAroundM));
                tile.vStart = arc[static_cast<size_t>(s.a)] / cfg.barkTileAlongM;
                tile.vEnd = arc[static_cast<size_t>(s.b)] / cfg.barkTileAlongM;
            }
            appendBranchCylinder(wood, node(s.a).position, node(s.b).position, s.rA, rad(s.b), cfg.woodColor, sides(s.rA, sidesMax), ends,
                                 jointExtend(s, false), jointExtend(s, true), tiledUv ? &tile : nullptr);
            if (growth) {
                // the cylinder's vertices alternate start ring, end ring (a closing cone's two apex vertices are the end's)
                const float ga = static_cast<float>(s.a) / growthDen, gb = static_cast<float>(s.b) / growthDen;
                const size_t rings = wood.vertices.size() - before - (ends && wood.vertices.size() > before ? 2 : 0);
                for (size_t v = before; v < wood.vertices.size(); ++v) growth->wood.push_back((v - before < rings && (v - before) % 2 == 0) ? ga : gb);
            }
            ++rep.woodSegments;
        }
        rep.woodTriangles = wood.indices.size() / 3;
        rep.prunedBelowRadius = rMin;

        // Foliage: twigs thinner than the pruning radius (or than a small share of the trunk) and every tip above the
        // crown break (and, with leavesOnCrownBranches, the branches that grew through the measured crown).
        const float twigRadius = std::max(rMin, kTwigRadiusShare * rRef);
        std::vector<Vec3> pts;
        std::vector<uint32_t> ptsNode;  // the leaf node each point is (its id: when it grew)
        const std::vector<uint8_t> leafy = leafyNodes(cfg, g, twigRadius, &radius);
        for (size_t i = 0; i < N; ++i) {
            if (leafy[i]) { pts.push_back(g[i].position); ptsNode.push_back(static_cast<uint32_t>(i)); }
        }
        const size_t foliageBudget = budget > rep.woodTriangles ? budget - rep.woodTriangles : 0;
        if (pts.empty() || foliageBudget < 20) return;
        const LeafEnvelope env = LeafEnvelope::of(cfg);
        // the masses that bring the measured surface within reach, all of them (the budget may hold fewer)
        const std::vector<std::pair<Vec3, size_t>> surface = surfaceMassCentres(cfg, env, pts);
        rep.surfaceMassesNeeded = surface.size();
        // finer masses (80 triangles) once the budget holds at least 24 of them, and every surface mass
        const int level = foliageBudget / 80 >= std::max<size_t>(24, surface.size()) ? 1 : 0;
        std::vector<Vec3> sphere;
        std::vector<uint32_t> sphereTris;
        unitIcosphere(level, sphere, sphereTris);
        const size_t tpc = sphereTris.size() / 3;
        const size_t massesHeld = foliageBudget / tpc;

        struct Cell { Vec3 sum{0, 0, 0}; uint32_t n{0}; };
        auto gather = [&](const std::vector<Vec3>& from, float v, std::vector<Cell>& out) {
            std::unordered_map<uint64_t, size_t> index;
            out.clear();
            for (const auto& p : from) {
                const int64_t a = static_cast<int64_t>(std::floor(p.x / v));
                const int64_t b = static_cast<int64_t>(std::floor(p.y / v));
                const int64_t c = static_cast<int64_t>(std::floor(p.z / v));
                const uint64_t key = (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
                auto it = index.find(key);
                if (it == index.end()) {
                    index.emplace(key, out.size());
                    out.push_back({p, 1});
                } else {
                    out[it->second].sum += p;
                    out[it->second].n++;
                }
            }
        };
        if (massesHeld == 0) return;
        // the masses' nominal size: the smallest voxel at which all the leaf nodes gather into no more masses than the
        // budget holds (masses of 0.62 of it overlap their neighbours), no larger than the tree
        std::vector<Cell> cells;
        float v = std::max(0.15f, 0.012f * treeHeight);
        gather(pts, v, cells);
        for (int it = 0; it < 400 && cells.size() > massesHeld && v < 2.0f * treeHeight; ++it) {
            v *= 1.08f;
            gather(pts, v, cells);
        }
        rep.clumpSpacing = v;
        rep.trianglesPerClump = static_cast<int>(tpc);
        const float clumpRadius = 0.62f * v;

        struct Mass { Vec3 center; float size; };
        std::vector<Mass> masses;
        // the surface masses (their centres were moved into the crown for the largest size they may be drawn)
        const float surfaceNominal = surfaceMassNominal(cfg, env);
        for (size_t k = 0; k < surface.size() && masses.size() < massesHeld; ++k) {
            masses.push_back({surface[k].first, leafMassSize(cfg, env, masses.size(), surfaceNominal)});
            rep.surfacePointsCovered += surface[k].second;
        }
        rep.surfaceMasses = masses.size();
        // the masses left: the leaf nodes no surface mass holds, a mass at the centroid of those in each voxel (the voxel
        // grown until they fit), kept inside the crown
        const size_t left = massesHeld - masses.size();
        if (left > 0) {
            std::vector<Vec3> rest;
            if (masses.empty()) {
                rest = pts;
            } else {
                for (const auto& p : pts) {
                    bool held = false;
                    for (const auto& m : masses) {
                        const float hold = m.size * kLeafJitterMax;
                        if ((p - m.center).lengthSquared() <= hold * hold) { held = true; break; }
                    }
                    if (!held) rest.push_back(p);
                }
            }
            if (!rest.empty()) {
                float w = v;
                gather(rest, w, cells);
                for (int it = 0; it < 400 && cells.size() > left; ++it) {
                    w *= 1.08f;
                    gather(rest, w, cells);
                }
                if (cells.size() <= left) {
                    for (const auto& c : cells) {
                        const float size = leafMassSize(cfg, env, masses.size(), clumpRadius);
                        masses.push_back({env.keepIn(c.sum / static_cast<float>(c.n), size), size});
                    }
                }
            }
        }

        for (size_t ci = 0; ci < masses.size(); ++ci) {
            const uint32_t base = static_cast<uint32_t>(foliage.vertices.size());
            for (size_t k = 0; k < sphere.size(); ++k) {
                const float jitter = 1.0f + kLeafJitterAmp * (hashUnit(cfg.seed, static_cast<uint32_t>(ci), static_cast<uint32_t>(k)) - 0.5f);
                const Vec3 d = sphere[k];
                foliage.vertices.push_back(masses[ci].center + Vec3(d.x, d.y * kLeafSquash, d.z) * (masses[ci].size * jitter));
                foliage.normals.push_back(Vec3(d.x, d.y / kLeafSquash, d.z).normalized());
                foliage.uvs.push_back(Vec2(0.5f + 0.5f * d.x, 0.5f + 0.5f * d.z));
                foliage.vertexColors.push_back(cfg.leafColor);
            }
            for (uint32_t idx : sphereTris) foliage.indices.push_back(base + idx);
        }
        rep.foliageClumps = masses.size();
        rep.foliageTriangles = foliage.indices.size() / 3;
        if (growth && !masses.empty()) {
            // each mass appears once the last leaf node it holds has grown (the nearest leaf node when it holds none)
            float cell = 1e-3f;
            for (const auto& m : masses) cell = std::max(cell, m.size * kLeafJitterMax);
            auto key = [&](const Vec3& p, int dx, int dy, int dz) {
                const int64_t a = static_cast<int64_t>(std::floor(p.x / cell)) + dx, b = static_cast<int64_t>(std::floor(p.y / cell)) + dy, c = static_cast<int64_t>(std::floor(p.z / cell)) + dz;
                return (static_cast<uint64_t>(a & 0x1FFFFF) << 42) | (static_cast<uint64_t>(b & 0x1FFFFF) << 21) | static_cast<uint64_t>(c & 0x1FFFFF);
            };
            std::unordered_map<uint64_t, std::vector<uint32_t>> grid;
            for (uint32_t k = 0; k < pts.size(); ++k) grid[key(pts[k], 0, 0, 0)].push_back(k);
            growth->foliage.reserve(foliage.vertices.size());
            for (const auto& m : masses) {
                const float hold2 = (m.size * kLeafJitterMax) * (m.size * kLeafJitterMax);
                long held = -1;
                for (int dz = -1; dz <= 1; ++dz) for (int dy = -1; dy <= 1; ++dy) for (int dx = -1; dx <= 1; ++dx) {
                    auto it = grid.find(key(m.center, dx, dy, dz));
                    if (it == grid.end()) continue;
                    for (uint32_t k : it->second) {
                        if ((pts[k] - m.center).lengthSquared() <= hold2) held = std::max(held, static_cast<long>(ptsNode[k]));
                    }
                }
                if (held < 0) {
                    float best = std::numeric_limits<float>::infinity();
                    for (uint32_t k = 0; k < pts.size(); ++k) {
                        const float d2 = (pts[k] - m.center).lengthSquared();
                        if (d2 < best) { best = d2; held = static_cast<long>(ptsNode[k]); }
                    }
                }
                const float value = static_cast<float>(held) / growthDen;
                growth->foliage.insert(growth->foliage.end(), sphere.size(), value);
            }
        }
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
    int segmentsPerBlade{7};             // Spine segments for smooth Bézier curvature (at least minSegments)
    int minSegments{4};                  // Fewest spine segments allowed (1-2 for distant blades whose curve is not seen)
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

        int validSegments = std::max(std::max(1, cfg.minSegments), cfg.segmentsPerBlade);

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

// ============================================================================
// 8. General Biomass & Micro-Detail Engine (Nanite-Level Ecosystem Synthesis)
// ============================================================================

/**
 * BotanicalOrganGenerator provides general, algorithmic generators for individual
 * micro-botanical organs (pinecones, needle sprigs, shelf fungi, clover mats, and ground carpets).
 */
class BotanicalOrganGenerator {
public:
    /**
     * Generates a Fibonacci Conifer Cone (Pinus / Sequoia) with golden-ratio spiral phyllotaxis.
     */
    static geometry::Mesh generateFibonacciPinecone(
        const Vec3& pos,
        const Vec3& dirNorm,
        const Vec3& upRef = Vec3(0, 1, 0),
        float coneLength = 0.12f,
        float maxConeRadius = 0.045f,
        int scaleCount = 18,
        const Vec4& baseColor = Vec4(0.12f, 0.07f, 0.04f, 1.0f),
        const Vec4& tipColor = Vec4(0.44f, 0.26f, 0.15f, 1.0f)
    ) {
        geometry::Mesh mesh("FibonacciPinecone");
        Vec3 dir = dirNorm.normalized();
        Vec3 up = (upRef - dir * upRef.dot(dir)).normalized();
        if (up.lengthSquared() < 0.01f) {
            Vec3 alt = std::abs(dir.y) < 0.99f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
            up = (alt - dir * alt.dot(dir)).normalized();
        }
        Vec3 side = dir.cross(up).normalized();

        // 1. Spindle axis cylinder
        Vec3 tip = pos + dir * coneLength;
        uint32_t cBase = static_cast<uint32_t>(mesh.vertices.size());
        for (int s = 0; s < 4; ++s) {
            float ang = (static_cast<float>(s) / 4.0f) * math::TWO_PI;
            Vec3 radial = side * std::cos(ang) + up * std::sin(ang);
            mesh.vertices.push_back(pos + radial * (maxConeRadius * 0.25f));
            mesh.normals.push_back(radial);
            mesh.uvs.push_back(Vec2(0, 0));
            mesh.vertexColors.push_back(baseColor);

            mesh.vertices.push_back(tip + radial * (maxConeRadius * 0.10f));
            mesh.normals.push_back(radial);
            mesh.uvs.push_back(Vec2(1, 1));
            mesh.vertexColors.push_back(baseColor);
        }
        for (int s = 0; s < 4; ++s) {
            int next = (s + 1) % 4;
            mesh.indices.push_back(cBase + s * 2);
            mesh.indices.push_back(cBase + s * 2 + 1);
            mesh.indices.push_back(cBase + next * 2);

            mesh.indices.push_back(cBase + next * 2);
            mesh.indices.push_back(cBase + s * 2 + 1);
            mesh.indices.push_back(cBase + next * 2 + 1);
        }

        // 2. Fibonacci Ovuliferous Scales
        const float goldenAngle = 137.507764f * math::DEG_TO_RAD;
        for (int k = 0; k < scaleCount; ++k) {
            float t = static_cast<float>(k + 1) / (scaleCount + 1);
            Vec3 sp = pos + dir * (coneLength * t);
            float r = maxConeRadius * std::sin(t * math::PI);
            float phi = k * goldenAngle;

            Vec3 rad = (side * std::cos(phi) + up * std::sin(phi)).normalized();
            Vec3 scaleTangent = dir.cross(rad).normalized();

            Vec3 p0 = sp - dir * 0.008f;
            Vec3 p1 = sp + rad * r + dir * 0.016f;
            Vec3 p2 = sp + rad * (r * 0.70f) + scaleTangent * (r * 0.40f) + dir * 0.006f;
            Vec3 p3 = sp + rad * (r * 0.70f) - scaleTangent * (r * 0.40f) + dir * 0.006f;

            Vec3 sNorm = (rad + dir * 0.4f).normalized();

            uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.vertices.push_back(p0); mesh.normals.push_back(sNorm); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(baseColor);
            mesh.vertices.push_back(p2); mesh.normals.push_back(sNorm); mesh.uvs.push_back(Vec2(0.0f, 0.7f)); mesh.vertexColors.push_back(tipColor);
            mesh.vertices.push_back(p1); mesh.normals.push_back(sNorm); mesh.uvs.push_back(Vec2(0.5f, 1.0f)); mesh.vertexColors.push_back(tipColor);
            mesh.vertices.push_back(p3); mesh.normals.push_back(sNorm); mesh.uvs.push_back(Vec2(1.0f, 0.7f)); mesh.vertexColors.push_back(tipColor);

            mesh.indices.push_back(bIdx);
            mesh.indices.push_back(bIdx + 1);
            mesh.indices.push_back(bIdx + 2);

            mesh.indices.push_back(bIdx);
            mesh.indices.push_back(bIdx + 2);
            mesh.indices.push_back(bIdx + 3);
        }

        return mesh;
    }

    /**
     * Generates a Two-Ranked Distichous Conifer Needle Sprig (Sequoia, Taxus, Abies).
     */
    static geometry::Mesh generateDistichousConiferSprig(
        const Vec3& basePos,
        const Vec3& sprayDir,
        float sprayLength = 0.65f,
        int needlePairs = 14,
        float needleLength = 0.032f,
        float needleWidth = 0.0045f,
        const Vec4& woodColor = Vec4(0.32f, 0.20f, 0.14f, 1.0f),
        const Vec4& needleBase = Vec4(0.22f, 0.48f, 0.12f, 1.0f),
        const Vec4& needleTip = Vec4(0.52f, 0.82f, 0.20f, 1.0f)
    ) {
        geometry::Mesh mesh("DistichousSprig");
        Vec3 dir = sprayDir.normalized();
        Vec3 up(0, 1, 0);
        Vec3 side = dir.cross(up).normalized();
        if (side.lengthSquared() < 0.01f) {
            side = Vec3(1, 0, 0);
        }
        up = side.cross(dir).normalized();

        // Woody shoot axis
        Vec3 tip = basePos + dir * sprayLength;
        uint32_t cBase = static_cast<uint32_t>(mesh.vertices.size());
        for (int s = 0; s < 4; ++s) {
            float ang = (static_cast<float>(s) / 4.0f) * math::TWO_PI;
            Vec3 radial = side * std::cos(ang) + up * std::sin(ang);
            mesh.vertices.push_back(basePos + radial * 0.008f);
            mesh.normals.push_back(radial);
            mesh.uvs.push_back(Vec2(0, 0));
            mesh.vertexColors.push_back(woodColor);

            mesh.vertices.push_back(tip + radial * 0.0025f);
            mesh.normals.push_back(radial);
            mesh.uvs.push_back(Vec2(1, 1));
            mesh.vertexColors.push_back(woodColor);
        }
        for (int s = 0; s < 4; ++s) {
            int next = (s + 1) % 4;
            mesh.indices.push_back(cBase + s * 2);
            mesh.indices.push_back(cBase + s * 2 + 1);
            mesh.indices.push_back(cBase + next * 2);

            mesh.indices.push_back(cBase + next * 2);
            mesh.indices.push_back(cBase + s * 2 + 1);
            mesh.indices.push_back(cBase + next * 2 + 1);
        }

        // Alternating needle blades
        for (int i = 0; i < needlePairs; ++i) {
            float frac = static_cast<float>(i + 1) / (needlePairs + 1);
            Vec3 node = basePos + dir * (sprayLength * frac);
            float nLen = needleLength * (1.0f - frac * 0.35f);

            for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
                float s = static_cast<float>(sideSign);
                Vec3 nDir = (side * s * 0.92f + dir * 0.38f).normalized();

                Vec3 p0 = node;
                Vec3 p1 = node + nDir * nLen + dir * (needleWidth * 0.5f);
                Vec3 p2 = node + nDir * (nLen * 1.15f);
                Vec3 p3 = node + nDir * nLen - dir * (needleWidth * 0.5f);

                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(p0); mesh.normals.push_back(up); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(needleBase);
                mesh.vertices.push_back(p1); mesh.normals.push_back(up); mesh.uvs.push_back(Vec2(0.0f, 0.8f)); mesh.vertexColors.push_back(needleTip);
                mesh.vertices.push_back(p2); mesh.normals.push_back(up); mesh.uvs.push_back(Vec2(0.5f, 1.0f)); mesh.vertexColors.push_back(needleTip);
                mesh.vertices.push_back(p3); mesh.normals.push_back(up); mesh.uvs.push_back(Vec2(1.0f, 0.8f)); mesh.vertexColors.push_back(needleTip);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 1);
                mesh.indices.push_back(bIdx + 2);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 2);
                mesh.indices.push_back(bIdx + 3);
            }
        }

        return mesh;
    }

    /**
     * Generates Epiphytic Bracket Shelf Polypores (Ganoderma applanatum).
     */
    static geometry::Mesh generateShelfPolypore(
        const Vec3& attachBase,
        const Vec3& outwardDir,
        float maxRadius = 0.24f,
        int tiers = 3,
        const Vec4& capColor = Vec4(0.38f, 0.24f, 0.14f, 1.0f),
        const Vec4& marginColor = Vec4(0.88f, 0.84f, 0.72f, 1.0f),
        const Vec4& poreColor = Vec4(0.72f, 0.68f, 0.56f, 1.0f)
    ) {
        geometry::Mesh mesh("ShelfPolypore");
        Vec3 outN = outwardDir.normalized();
        Vec3 up(0, 1, 0);
        Vec3 side = outN.cross(up).normalized();

        for (int t = 0; t < tiers; ++t) {
            float tFrac = static_cast<float>(t) / tiers;
            float radius = maxRadius * (1.0f - tFrac * 0.35f);
            Vec3 shelfCenter = attachBase + Vec3(0, t * 0.16f, 0);

            const int sectors = 12;
            uint32_t centerTop = static_cast<uint32_t>(mesh.vertices.size());
            mesh.vertices.push_back(shelfCenter); mesh.normals.push_back(up); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(capColor);

            uint32_t centerBot = static_cast<uint32_t>(mesh.vertices.size());
            mesh.vertices.push_back(shelfCenter - Vec3(0, 0.025f, 0)); mesh.normals.push_back(-up); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(poreColor);

            for (int s = 0; s <= sectors; ++s) {
                float theta = -math::HALF_PI + (static_cast<float>(s) / sectors) * math::PI;
                float cosT = std::cos(theta);
                float sinT = std::sin(theta);

                Vec3 edgeRadial = outN * cosT + side * sinT;
                float rDist = radius * (1.0f + 0.08f * std::sin(theta * 5.0f));

                Vec3 pTop = shelfCenter + edgeRadial * rDist;
                Vec3 pBot = shelfCenter + edgeRadial * (rDist * 0.96f) - Vec3(0, 0.025f, 0);
                Vec3 rimNorm = (edgeRadial + Vec3(0, 0.25f, 0)).normalized();

                mesh.vertices.push_back(pTop); mesh.normals.push_back(rimNorm); mesh.uvs.push_back(Vec2(0.5f + 0.5f * sinT, cosT)); mesh.vertexColors.push_back(marginColor);
                mesh.vertices.push_back(pBot); mesh.normals.push_back(-up); mesh.uvs.push_back(Vec2(0.5f + 0.5f * sinT, cosT)); mesh.vertexColors.push_back(poreColor);
            }

            for (int s = 0; s < sectors; ++s) {
                uint32_t topA = centerTop + 2 + s * 2;
                uint32_t topB = centerTop + 2 + (s + 1) * 2;
                mesh.indices.push_back(centerTop);
                mesh.indices.push_back(topA);
                mesh.indices.push_back(topB);

                uint32_t botA = centerTop + 3 + s * 2;
                uint32_t botB = centerTop + 3 + (s + 1) * 2;
                mesh.indices.push_back(centerBot);
                mesh.indices.push_back(botB);
                mesh.indices.push_back(botA);

                // Rim quad
                mesh.indices.push_back(topA);
                mesh.indices.push_back(botA);
                mesh.indices.push_back(topB);

                mesh.indices.push_back(topB);
                mesh.indices.push_back(botA);
                mesh.indices.push_back(botB);
            }
        }

        return mesh;
    }

    /**
     * Generates Wood Sorrel / Redwood Clover (Oxalis oregana) patches with 3 heart-shaped leaflets per plant.
     */
    static geometry::Mesh generateWoodSorrelPatch(
        const Vec3& center,
        float patchRadius = 0.95f,
        int plantCount = 20,
        const Vec4& baseColor = Vec4(0.32f, 0.68f, 0.16f, 1.0f),
        const Vec4& tipColor = Vec4(0.48f, 0.82f, 0.22f, 1.0f)
    ) {
        geometry::Mesh mesh("WoodSorrelPatch");
        for (int p = 0; p < plantCount; ++p) {
            float r = patchRadius * std::sqrt((static_cast<float>(p) + 0.5f) / static_cast<float>(plantCount));
            float theta = p * 2.39996f;
            float px = center.x + r * std::cos(theta);
            float pz = center.z + r * std::sin(theta);
            float py = center.y + 0.04f + 0.02f * (p % 3);

            Vec3 plantPos(px, py, pz);
            float plantScale = 0.08f + 0.04f * ((p * 7) % 5);

            for (int lobe = 0; lobe < 3; ++lobe) {
                float lobeAngle = theta + lobe * (math::TWO_PI / 3.0f);
                Vec3 lobeDir(std::cos(lobeAngle), 0.10f, std::sin(lobeAngle));
                Vec3 lobeSide(-lobeDir.z, 0.0f, lobeDir.x);
                Vec3 lobeUp(0, 1, 0);

                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                Vec3 p0 = plantPos;
                Vec3 p1 = plantPos + lobeDir * plantScale + lobeSide * (plantScale * 0.55f);
                Vec3 p2 = plantPos + lobeDir * (plantScale * 1.25f);
                Vec3 p3 = plantPos + lobeDir * plantScale - lobeSide * (plantScale * 0.55f);

                mesh.vertices.push_back(p0); mesh.normals.push_back(lobeUp); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(baseColor);
                mesh.vertices.push_back(p1); mesh.normals.push_back(lobeUp); mesh.uvs.push_back(Vec2(0.0f, 0.8f)); mesh.vertexColors.push_back(tipColor);
                mesh.vertices.push_back(p2); mesh.normals.push_back(lobeUp); mesh.uvs.push_back(Vec2(0.5f, 1.0f)); mesh.vertexColors.push_back(tipColor);
                mesh.vertices.push_back(p3); mesh.normals.push_back(lobeUp); mesh.uvs.push_back(Vec2(1.0f, 0.8f)); mesh.vertexColors.push_back(tipColor);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 1);
                mesh.indices.push_back(bIdx + 2);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 2);
                mesh.indices.push_back(bIdx + 3);
            }
        }
        return mesh;
    }

    /**
     * Generates a sub-centimeter fallen needle cluster tangential to the ground plane.
     */
    static geometry::Mesh generateFallenNeedleCluster(
        const Vec3& center,
        const Vec3& groundNormal,
        int needlesInCluster = 8,
        float needleLen = 0.038f,
        float needleWidth = 0.0042f,
        const Vec4& colA = Vec4(0.26f, 0.15f, 0.09f, 1.0f),
        const Vec4& colB = Vec4(0.10f, 0.05f, 0.03f, 1.0f)
    ) {
        geometry::Mesh mesh("NeedleCluster");
        Vec3 tangent = std::abs(groundNormal.y) < 0.99f ? groundNormal.cross(Vec3(0, 1, 0)).normalized() : Vec3(1, 0, 0);
        Vec3 bitangent = groundNormal.cross(tangent).normalized();

        for (int n = 0; n < needlesInCluster; ++n) {
            float nAngle = n * 0.85f;
            float nLen = needleLen * (0.85f + 0.30f * (n % 3));
            Vec3 dir = (tangent * std::cos(nAngle) + bitangent * std::sin(nAngle)).normalized();
            Vec3 side = groundNormal.cross(dir).normalized();

            Vec3 p0 = center - side * (needleWidth * 0.5f);
            Vec3 p1 = center + side * (needleWidth * 0.5f);
            Vec3 p2 = center + dir * nLen + side * (needleWidth * 0.5f);
            Vec3 p3 = center + dir * nLen - side * (needleWidth * 0.5f);

            Vec4 col = (n % 2 == 0) ? colA : colB;
            uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
            mesh.vertices.push_back(p0); mesh.normals.push_back(groundNormal); mesh.uvs.push_back(Vec2(0, 0)); mesh.vertexColors.push_back(col);
            mesh.vertices.push_back(p1); mesh.normals.push_back(groundNormal); mesh.uvs.push_back(Vec2(1, 0)); mesh.vertexColors.push_back(col);
            mesh.vertices.push_back(p2); mesh.normals.push_back(groundNormal); mesh.uvs.push_back(Vec2(1, 1)); mesh.vertexColors.push_back(col);
            mesh.vertices.push_back(p3); mesh.normals.push_back(groundNormal); mesh.uvs.push_back(Vec2(0, 1)); mesh.vertexColors.push_back(col);

            mesh.indices.push_back(bIdx);
            mesh.indices.push_back(bIdx + 1);
            mesh.indices.push_back(bIdx + 2);

            mesh.indices.push_back(bIdx);
            mesh.indices.push_back(bIdx + 2);
            mesh.indices.push_back(bIdx + 3);
        }
        return mesh;
    }

    /**
     * Generates a decaying ground-pressed winter fern frond.
     */
    static geometry::Mesh generateDecayingWinterFrond(
        const Vec3& rootPos,
        const Vec3& dirNorm,
        const Vec3& normalNorm,
        float length = 1.0f,
        int steps = 10,
        const Vec4& colA = Vec4(0.24f, 0.14f, 0.08f, 0.95f),
        const Vec4& colB = Vec4(0.14f, 0.08f, 0.05f, 0.95f)
    ) {
        geometry::Mesh mesh("DecayingWinterFrond");
        Vec3 dir = dirNorm.normalized();
        Vec3 norm = normalNorm.normalized();
        Vec3 side = dir.cross(norm).normalized();

        for (int s = 0; s < steps; ++s) {
            float u = static_cast<float>(s) / steps;
            Vec3 spineP = rootPos + dir * (length * u);
            float pinnuleLen = 0.12f * std::sin(u * math::PI);
            Vec4 col = math::lerp(colA, colB, u * 0.65f);

            for (int sign = -1; sign <= 1; sign += 2) {
                float sF = static_cast<float>(sign);
                Vec3 p0 = spineP;
                Vec3 p1 = spineP + side * (sF * pinnuleLen) + dir * 0.035f;
                Vec3 p2 = spineP + side * (sF * pinnuleLen * 1.1f);
                Vec3 p3 = spineP - dir * 0.025f;

                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(p0); mesh.normals.push_back(norm); mesh.uvs.push_back(Vec2(0.5f, 0.0f)); mesh.vertexColors.push_back(col);
                mesh.vertices.push_back(p1); mesh.normals.push_back(norm); mesh.uvs.push_back(Vec2(1.0f, 0.8f)); mesh.vertexColors.push_back(col);
                mesh.vertices.push_back(p2); mesh.normals.push_back(norm); mesh.uvs.push_back(Vec2(0.5f, 1.0f)); mesh.vertexColors.push_back(col);
                mesh.vertices.push_back(p3); mesh.normals.push_back(norm); mesh.uvs.push_back(Vec2(0.0f, 0.5f)); mesh.vertexColors.push_back(col);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 1);
                mesh.indices.push_back(bIdx + 2);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 2);
                mesh.indices.push_back(bIdx + 3);
            }
        }
        return mesh;
    }

    /**
     * Generates 3D Volumetric Velvet Moss Tufts on curved trunks or logs.
     */
    static geometry::Mesh generateVolumetricMossTufts(
        const Vec3& start,
        const Vec3& end,
        float logRadius,
        int tuftCount = 140,
        const Vec4& colBase = Vec4(0.30f, 0.60f, 0.16f, 1.0f),
        const Vec4& colTip = Vec4(0.24f, 0.46f, 0.12f, 1.0f)
    ) {
        geometry::Mesh mesh("VolumetricMossTufts");
        Vec3 axis = end - start;
        float len = axis.length();
        Vec3 dir = axis.normalized();
        Vec3 up(0, 1, 0);
        Vec3 side = dir.cross(up).normalized();

        for (int t = 0; t < tuftCount; ++t) {
            float u = static_cast<float>(t) / tuftCount;
            Vec3 corePos = start + dir * (u * len);
            float crestAngle = std::sin(t * 1.7f) * 0.45f;
            Vec3 radial = (up * std::cos(crestAngle) + side * std::sin(crestAngle)).normalized();
            Vec3 tuftRoot = corePos + radial * (logRadius * 0.98f);
            float tuftHeight = 0.045f + 0.025f * (t % 4);

            for (int b = 0; b < 3; ++b) {
                float bYaw = b * (math::PI / 3.0f) + (t * 0.8f);
                Vec3 bDir(std::cos(bYaw), 0, std::sin(bYaw));
                Vec3 bSide = radial.cross(bDir).normalized();

                Vec3 p0 = tuftRoot - bSide * 0.012f;
                Vec3 p1 = tuftRoot + bSide * 0.012f;
                Vec3 p2 = tuftRoot + radial * tuftHeight + bDir * 0.015f + bSide * 0.008f;
                Vec3 p3 = tuftRoot + radial * tuftHeight + bDir * 0.015f - bSide * 0.008f;

                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());
                mesh.vertices.push_back(p0); mesh.normals.push_back(radial); mesh.uvs.push_back(Vec2(0, 0)); mesh.vertexColors.push_back(colBase);
                mesh.vertices.push_back(p1); mesh.normals.push_back(radial); mesh.uvs.push_back(Vec2(1, 0)); mesh.vertexColors.push_back(colBase);
                mesh.vertices.push_back(p2); mesh.normals.push_back(radial); mesh.uvs.push_back(Vec2(1, 1)); mesh.vertexColors.push_back(colTip);
                mesh.vertices.push_back(p3); mesh.normals.push_back(radial); mesh.uvs.push_back(Vec2(0, 1)); mesh.vertexColors.push_back(colTip);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 1);
                mesh.indices.push_back(bIdx + 2);

                mesh.indices.push_back(bIdx);
                mesh.indices.push_back(bIdx + 2);
                mesh.indices.push_back(bIdx + 3);
            }
        }
        return mesh;
    }
};

/**
 * NurseLogGenerator builds decaying fallen nurse logs with rot indentations and hollowed splintered ends.
 */
class NurseLogGenerator {
public:
    static geometry::Mesh generateHollowNurseLog(
        const Vec3& start,
        const Vec3& end,
        float radius = 0.50f,
        float cavityDepthRatio = 0.55f,
        int lRings = 40,
        int sectors = 36,
        const Vec4& barkColor = Vec4(0.35f, 0.19f, 0.12f, 1.0f),
        const Vec4& mossColor = Vec4(0.30f, 0.60f, 0.16f, 1.0f),
        const Vec4& woodRotColor = Vec4(0.42f, 0.28f, 0.18f, 1.0f),
        const Vec4& furrowColor = Vec4(0.10f, 0.05f, 0.03f, 1.0f)
    ) {
        geometry::Mesh mesh("HollowNurseLog");
        Vec3 axis = end - start;
        float length = axis.length();
        Vec3 dir = axis.normalized();

        Vec3 up(0, 1, 0);
        Vec3 side = dir.cross(up).normalized();
        up = side.cross(dir).normalized();

        for (int r = 0; r <= lRings; ++r) {
            float t = static_cast<float>(r) / static_cast<float>(lRings);
            Vec3 ringCenter = start + dir * (t * length);
            float currentRadius = radius * (1.08f - 0.16f * t + 0.05f * std::sin(t * 14.0f));

            float cavityFactor = 0.0f;
            if (t > 0.28f && t < 0.72f) {
                float cWindow = std::sin((t - 0.28f) / 0.44f * math::PI);
                cavityFactor = cWindow * cWindow;
            }

            for (int s = 0; s <= sectors; ++s) {
                float theta = (static_cast<float>(s) / static_cast<float>(sectors)) * math::TWO_PI;
                float cosT = std::cos(theta);
                float sinT = std::sin(theta);
                Vec3 radial = (side * cosT + up * sinT).normalized();

                float rotIndent = 0.0f;
                if (sinT > 0.4f && cavityFactor > 0.01f) {
                    float angleWeight = (sinT - 0.4f) / 0.6f;
                    rotIndent = angleWeight * cavityFactor * (currentRadius * cavityDepthRatio);
                }

                float radEff = std::max(currentRadius * 0.35f, currentRadius - rotIndent);
                Vec3 pos = ringCenter + radial * (radEff + 0.035f * std::cos(14.0f * theta + t * 8.0f));

                Vec3 norm = radial;
                if (rotIndent > 0.01f) {
                    norm = (-radial * 0.5f + up * 0.5f).normalized();
                }

                Vec4 color = barkColor;
                if (rotIndent > 0.03f) {
                    color = math::lerp(woodRotColor, furrowColor, 0.65f);
                } else if (radial.y > 0.06f) {
                    float mossWeight = std::clamp((radial.y - 0.06f) / 0.75f, 0.0f, 1.0f);
                    color = math::lerp(barkColor, mossColor, mossWeight * 0.96f);
                } else if (radial.y < -0.2f) {
                    color = math::lerp(barkColor, furrowColor, 0.70f);
                }

                mesh.vertices.push_back(pos);
                mesh.normals.push_back(norm);
                mesh.uvs.push_back(Vec2(static_cast<float>(s) / static_cast<float>(sectors) * 2.0f, t * 6.0f));
                mesh.vertexColors.push_back(color);
            }
        }

        for (int r = 0; r < lRings; ++r) {
            int r0 = r * (sectors + 1);
            int r1 = (r + 1) * (sectors + 1);
            for (int s = 0; s < sectors; ++s) {
                uint32_t i0 = r0 + s;
                uint32_t i1 = r0 + (s + 1);
                uint32_t i2 = r1 + s;
                uint32_t i3 = r1 + (s + 1);
                mesh.indices.push_back(i0); mesh.indices.push_back(i1); mesh.indices.push_back(i2);
                mesh.indices.push_back(i1); mesh.indices.push_back(i3); mesh.indices.push_back(i2);
            }
        }

        // Hollow Splintered End Caps
        auto addCap = [&](const Vec3& capCenter, const Vec3& capNormal, bool flip) {
            uint32_t outerStart = static_cast<uint32_t>(mesh.vertices.size());
            for (int s = 0; s <= sectors; ++s) {
                float theta = (static_cast<float>(s) / static_cast<float>(sectors)) * math::TWO_PI;
                float cosT = std::cos(theta);
                float sinT = std::sin(theta);
                Vec3 radial = (side * cosT + up * sinT).normalized();
                float outerR = radius * (0.90f + 0.15f * std::sin(theta * 9.0f));
                Vec3 p = capCenter + radial * outerR + capNormal * (0.08f * std::sin(theta * 11.0f));
                mesh.vertices.push_back(p);
                mesh.normals.push_back(capNormal);
                mesh.uvs.push_back(Vec2(0.5f + 0.5f * cosT, 0.5f + 0.5f * sinT));
                mesh.vertexColors.push_back(woodRotColor);
            }

            uint32_t innerStart = static_cast<uint32_t>(mesh.vertices.size());
            for (int s = 0; s <= sectors; ++s) {
                float theta = (static_cast<float>(s) / static_cast<float>(sectors)) * math::TWO_PI;
                float cosT = std::cos(theta);
                float sinT = std::sin(theta);
                Vec3 radial = (side * cosT + up * sinT).normalized();
                float innerR = radius * (0.42f + 0.08f * std::cos(theta * 7.0f));
                Vec3 p = capCenter + radial * innerR - capNormal * 0.35f;
                mesh.vertices.push_back(p);
                mesh.normals.push_back(-radial);
                mesh.uvs.push_back(Vec2(0.5f + 0.25f * cosT, 0.5f + 0.25f * sinT));
                mesh.vertexColors.push_back(furrowColor);
            }

            for (int s = 0; s < sectors; ++s) {
                uint32_t o0 = outerStart + s;
                uint32_t o1 = outerStart + (s + 1);
                uint32_t in0 = innerStart + s;
                uint32_t in1 = innerStart + (s + 1);

                if (flip) {
                    mesh.indices.push_back(o0); mesh.indices.push_back(o1); mesh.indices.push_back(in0);
                    mesh.indices.push_back(o1); mesh.indices.push_back(in1); mesh.indices.push_back(in0);
                } else {
                    mesh.indices.push_back(o0); mesh.indices.push_back(in0); mesh.indices.push_back(o1);
                    mesh.indices.push_back(o1); mesh.indices.push_back(in0); mesh.indices.push_back(in1);
                }
            }
        };

        addCap(start, -dir, false);
        addCap(end, dir, true);

        return mesh;
    }
};

/**
 * Stratified Biomass Scatter Engine
 * Implements biological distribution rules (Poisson-disk spacing, slope masking,
 * altitude stratification, mean curvature masks, and multi-scale procedural noise)
 * across any terrain surface, mirroring advanced Geometry Nodes nature scattering.
 */
class BiomassScatterEngine {
public:
    /**
     * Rule-based scattering criteria driving non-uniform biological distribution.
     */
    struct ScatterCriteria {
        // 1. Altitude Masking (Stratification)
        float minAltitude{-100.0f};
        float maxAltitude{100.0f};

        // 2. Slope Angle Masking (Normal Dot with Gravity Up [0, 1, 0])
        float minSlopeDot{0.75f};       // Flat to moderate slope (1.0 = horizontal, 0.0 = sheer vertical)
        float maxSlopeDot{1.0f};

        // 3. Curvature Masking (Concave hollows vs Convex ridges)
        // kappa < 0 = concave depression (moisture trap, humus, moss)
        // kappa > 0 = convex ridge/hummock (dry needles, cones, windswept grass)
        float minCurvature{-10.0f};
        float maxCurvature{10.0f};

        // 4. Multi-Scale Procedural Noise Modulation
        float macroNoiseFrequency{0.08f}; // Macro biome clumping scale (12.5m wavelengths)
        float mesoNoiseFrequency{0.45f};  // Meso colony dispersal scale (2.2m wavelengths)
        float noiseThreshold{0.32f};      // Minimum noise probability cutoff

        // 5. Poisson-Disk Anti-Clustering Spacing
        float minDistance{0.25f};       // Poisson disk radius (meters)

        // 6. Proximity Masking (Nurse Log / Boulder / Stream Proximity)
        float nurseRadius{2.2f};
        float nurseWeight{0.0f};        // 0.0 = ignore nurse log, 1.0 = strictly require nurse log
        bool requireNurseLog{false};

        uint32_t targetCount{100};
        uint32_t seed{42};
    };

    /**
     * Analytically computes Mean Curvature kappa = 0.5 * (H_xx + H_zz) from the heightfield.
     */
    static float computeCurvature(
        float x,
        float z,
        const std::function<float(float, float)>& heightFunc,
        float eps = 0.15f
    ) {
        float hC = heightFunc(x, z);
        float hL = heightFunc(x - eps, z);
        float hR = heightFunc(x + eps, z);
        float hD = heightFunc(x, z - eps);
        float hU = heightFunc(x, z + eps);

        float d2x = (hR - 2.0f * hC + hL) / (eps * eps);
        float d2z = (hU - 2.0f * hC + hD) / (eps * eps);

        return 0.5f * (d2x + d2z);
    }

    /**
     * Evaluates multi-scale procedural noise probability at coordinate (x, z).
     */
    static float evaluateMultiScaleNoise(
        float x,
        float z,
        float macroFreq,
        float mesoFreq,
        uint32_t seed
    ) {
        float seedF = static_cast<float>(seed % 1000) * 1.37f;
        // Macro noise (large biological groves)
        float macro = 0.5f + 0.5f * std::sin(x * macroFreq + seedF) * std::cos(z * macroFreq * 1.15f - seedF * 0.7f);

        // Meso noise (local colony clusters)
        float meso = 0.5f + 0.5f * std::sin(x * mesoFreq * 1.2f - z * mesoFreq * 0.8f + seedF * 2.1f)
                           * std::cos(x * mesoFreq * 0.7f + z * mesoFreq * 1.3f + seedF * 1.4f);

        // Combined multi-scale density
        return macro * 0.60f + meso * 0.40f;
    }

    /**
     * Distributes candidate sample points across a bounds area meeting biological criteria.
     */
    static std::vector<Vec3> samplePoints(
        const Vec2& boundsMin,
        const Vec2& boundsMax,
        const std::function<float(float, float)>& heightFunc,
        const std::function<Vec3(float, float)>& normalFunc,
        const std::vector<Vec3>& nursePositions,
        const ScatterCriteria& criteria
    ) {
        std::vector<Vec3> points;
        points.reserve(criteria.targetCount);

        std::mt19937 rng(criteria.seed);
        std::uniform_real_distribution<float> distX(boundsMin.x, boundsMax.x);
        std::uniform_real_distribution<float> distZ(boundsMin.y, boundsMax.y);
        std::uniform_real_distribution<float> distProb(0.0f, 1.0f);

        int maxAttempts = static_cast<int>(criteria.targetCount) * 45;
        float minDistSq = criteria.minDistance * criteria.minDistance;

        for (int i = 0; i < maxAttempts && points.size() < criteria.targetCount; ++i) {
            float x = distX(rng);
            float z = distZ(rng);
            float y = heightFunc(x, z);

            // 1. Altitude Filter
            if (y < criteria.minAltitude || y > criteria.maxAltitude) {
                continue;
            }

            // 2. Slope Angle Filter
            Vec3 norm = normalFunc(x, z);
            if (norm.y < criteria.minSlopeDot || norm.y > criteria.maxSlopeDot) {
                continue;
            }

            // 3. Curvature Filter (Concavity vs Convexity)
            float curvature = computeCurvature(x, z, heightFunc);
            if (curvature < criteria.minCurvature || curvature > criteria.maxCurvature) {
                continue;
            }

            // 4. Multi-Scale Noise Mask
            float noiseProb = evaluateMultiScaleNoise(x, z, criteria.macroNoiseFrequency, criteria.mesoNoiseFrequency, criteria.seed);
            if (noiseProb < criteria.noiseThreshold) {
                continue;
            }

            // 5. Nurse Proximity Weighting
            if (criteria.requireNurseLog && !nursePositions.empty()) {
                bool nearNurse = false;
                for (const auto& np : nursePositions) {
                    float dx = x - np.x;
                    float dz = z - np.z;
                    if (dx * dx + dz * dz < criteria.nurseRadius * criteria.nurseRadius) {
                        nearNurse = true;
                        break;
                    }
                }
                if (!nearNurse) continue;
            }

            // 6. Poisson-Disk Distance Test
            bool tooClose = false;
            for (const auto& p : points) {
                float dx = x - p.x;
                float dz = z - p.z;
                if (dx * dx + dz * dz < minDistSq) {
                    tooClose = true;
                    break;
                }
            }

            if (!tooClose) {
                points.push_back(Vec3(x, y, z));
            }
        }

        return points;
    }
};

/**
 * NarrativeClutterPlacer (Macro-to-Micro Ecosystem Storytelling)
 *
 * Implements narrative clutter placement:
 * 1. Root Buttress Crotches: Acute concave angle between trunk flutes where needles,
 *    cones, and twigs naturally accumulate from wind and gravity shedding.
 * 2. Nurse Log Crevices: Rotten wood hollows and upper shelf zones collecting velvet moss
 *    and shelf polypore fungi.
 * 3. Moisture Depressions: Negative curvature terrain basins hosting Wood Sorrel (Oxalis)
 *    and decaying winter fronds.
 * 4. Animal / Pedestrian Corridor: Center clearing maintained with low-lying needle silt
 *    and clover margins, avoiding impassable debris.
 */
class NarrativeClutterPlacer {
public:
    enum class PocketType {
        RootButtressCrotch,
        NurseLogCavity,
        MoistureDepression,
        TrailEdge
    };

    struct ClutterPocket {
        Vec3 position;
        Vec3 surfaceNormal;
        PocketType type;
        float radius{0.5f};
        float moistureRating{0.5f};
        float gravitySettlingWeight{1.0f};
    };

    /**
     * Identifies biological gathering zones around trees and nurse logs.
     */
    static std::vector<ClutterPocket> identifyPockets(
        const std::vector<Vec3>& treeBases,
        const std::vector<std::pair<Vec3, Vec3>>& nurseLogs,
        const std::function<float(float, float)>& heightFunc,
        const std::function<Vec3(float, float)>& normalFunc
    ) {
        std::vector<ClutterPocket> pockets;

        // 1. Root Buttress Crotches (Around ancient tree trunks)
        for (const auto& tb : treeBases) {
            for (int i = 0; i < 6; ++i) {
                float angle = static_cast<float>(i) * (math::TWO_PI / 6.0f) + 0.35f;
                float rDist = 1.45f + 0.35f * (i % 2);
                float px = tb.x + std::cos(angle) * rDist;
                float pz = tb.z + std::sin(angle) * rDist;
                float py = heightFunc(px, pz);

                ClutterPocket cp;
                cp.position = Vec3(px, py, pz);
                cp.surfaceNormal = normalFunc(px, pz);
                cp.type = PocketType::RootButtressCrotch;
                cp.radius = 0.65f;
                cp.moistureRating = 0.70f;
                cp.gravitySettlingWeight = 1.35f;
                pockets.push_back(cp);
            }
        }

        // 2. Nurse Log Cavities & Flanking Accumulation
        for (const auto& log : nurseLogs) {
            Vec3 dir = (log.second - log.first).normalized();
            Vec3 side(-dir.z, 0.0f, dir.x);
            float len = (log.second - log.first).length();

            for (int k = 1; k <= 4; ++k) {
                float frac = static_cast<float>(k) / 5.0f;
                Vec3 pLog = log.first + dir * (len * frac);
                
                // Flanking pocket on shaded side
                Vec3 pPocket = pLog + side * 0.75f;
                pPocket.y = heightFunc(pPocket.x, pPocket.z);

                ClutterPocket cp;
                cp.position = pPocket;
                cp.surfaceNormal = normalFunc(pPocket.x, pPocket.z);
                cp.type = PocketType::NurseLogCavity;
                cp.radius = 0.75f;
                cp.moistureRating = 0.85f;
                cp.gravitySettlingWeight = 1.50f;
                pockets.push_back(cp);
            }
        }

        return pockets;
    }
};

} // namespace nature
} // namespace scratchbox

#endif // SCRATCHBOX_NATURE_HPP




