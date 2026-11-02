/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Hyperrealistic Procedural 3D Forest Reconstruction (Astro Engine C++20)
 * Clean-Slate Master 3D Artist Architecture adhering to:
 * - .agents/skills/3d-artist/SKILL.md
 * - 70-20-10 Form Hierarchy
 * - 7-Tier Biome Stratification (Canopy -> Subcanopy -> Ferns -> Herbs -> Epiphytes -> Debris -> Substrate)
 * - Multi-Mesh glTF 2.0 Binary Output (.glb) with embedded authentic photo-derived PBR texture sets
 * - Macro-to-Micro Rule-Based Clutter Placement
 * - Every crown grown by SB-Veggie (scratchbox_sb_veggie_grove.hpp) into <output>_trees.glb beside the forest
 *
 * Run from the repository root (it reads public/textures, assets/vegetation/species and assets/textures/trees):
 *   clang++ -std=c++20 -O3 -pthread -I packages/core/src/native/3d-engine/include \
 *       scripts/generate_forest_procedural_3d.cpp -o build/3d-native/generate_forest_procedural_3d -lz
 *   build/3d-native/generate_forest_procedural_3d public/models/forest_hyperreal.glb
 * writes public/models/forest_hyperreal.glb, forest_hyperreal_trees.glb and forest_hyperreal_trees.stats.json, which
 * /forest_3d_viewer.html loads.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_infiniti.hpp"
#include "scratchbox_sb_veggie_grove.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <cmath>
#include <chrono>
#include <algorithm>
#include <limits>

using namespace scratchbox;
using namespace scratchbox::geometry;
using namespace scratchbox::botanical;
using namespace scratchbox::nature;
using namespace scratchbox::substrate;
using namespace scratchbox::infiniti;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using math::DEG_TO_RAD;

// ============================================================================
// File Loading Helper for Authentic Embedded Textures
// ============================================================================
inline std::vector<uint8_t> loadPngFile(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file.is_open()) return {};
    std::streamsize size = file.tellg();
    file.seekg(0, std::ios::beg);
    std::vector<uint8_t> buffer(size);
    if (file.read(reinterpret_cast<char*>(buffer.data()), size)) {
        return buffer;
    }
    return {};
}

// ============================================================================
// Photometrically Calibrated Forest PBR Color Palette (National Geographic Grade)
// ============================================================================
static const Vec4 COL_REDWOOD_BARK(0.35f, 0.19f, 0.12f, 1.0f);       // Deep reddish-brown heartwood bark
static const Vec4 COL_BARK_FURROW(0.10f, 0.05f, 0.03f, 1.0f);        // Crevice shadow / ambient occlusion
static const Vec4 COL_BARK_RIDGE(0.48f, 0.28f, 0.16f, 1.0f);         // Outer sun-catching bark plate
static const Vec4 COL_TRUNK_MOSS(0.28f, 0.50f, 0.15f, 1.0f);         // Damp velvet moss on lower trunk
static const Vec4 COL_FOREST_HUMUS(0.12f, 0.08f, 0.05f, 1.0f);       // Rich dark forest soil / loam (moist)
static const Vec4 COL_NEEDLE_DUFF(0.26f, 0.15f, 0.09f, 1.0f);        // Redwood fallen needle carpet (duff)
static const Vec4 COL_ORGANIC_LOAM(0.18f, 0.12f, 0.08f, 1.0f);       // Weathered soil surface
static const Vec4 COL_FLOOR_MOSS(0.24f, 0.46f, 0.12f, 1.0f);         // Velvet moss cushion around roots
static const Vec4 COL_NURSE_LOG_WOOD(0.42f, 0.28f, 0.18f, 1.0f);     // Splintered decaying wood core
static const Vec4 COL_NURSE_LOG_MOSS(0.30f, 0.60f, 0.16f, 1.0f);     // Dense sunlit moss cap on log
static const Vec4 COL_FERN_FROND(0.22f, 0.56f, 0.13f, 1.0f);         // Lush sword fern green
static const Vec4 COL_FERN_HIGHLIGHT(0.50f, 0.82f, 0.18f, 1.0f);     // Sunlit translucent fern tip (SSS)
static const Vec4 COL_SUNBEAM_GOLD(0.98f, 0.92f, 0.74f, 0.28f);      // Morning crepuscular light beam

// ============================================================================
// 1. Terrain Heightfield & Normal Telemetry (Domain-Warped Geology & Forest Bowl)
// ============================================================================
inline float getTerrainHeight(float x, float z) {
    static const WarpedTerrainConfig warpedCfg;
    float warpedGeology = DomainWarpedTerrain::sampleHeight(x, z, warpedCfg) * 0.35f;

    float macroSlope = -0.016f * x - 0.024f * z;

    float midSwells = 0.38f * std::sin(0.12f * x + 0.16f * z)
                    + 0.28f * std::cos(0.18f * x - 0.14f * z);

    float microRelief = 0.10f * std::sin(0.65f * x + 0.55f * z)
                      + 0.06f * std::cos(1.20f * x - 0.90f * z)
                      + 0.03f * std::sin(2.40f * x) * std::cos(2.10f * z);

    // Natural peripheral ridges rising gently beyond 26m
    float radial = std::sqrt(x * x + (z + 16.0f) * (z + 16.0f));
    float ridgeRise = radial > 25.0f ? std::pow((radial - 25.0f) * 0.11f, 2.0f) : 0.0f;

    return macroSlope + midSwells + microRelief + warpedGeology + ridgeRise;
}

inline Vec3 getTerrainNormal(float x, float z) {
    const float eps = 0.12f;
    float hL = getTerrainHeight(x - eps, z);
    float hR = getTerrainHeight(x + eps, z);
    float hD = getTerrainHeight(x, z - eps);
    float hU = getTerrainHeight(x, z + eps);

    Vec3 normal(-(hR - hL) / (2.0f * eps), 1.0f, -(hU - hD) / (2.0f * eps));
    return normal.normalized();
}

// ============================================================================
// 2. Woodland Floor Mesh Generator with Micro-Relief
// ============================================================================
ScratchboxMesh generateForestFloor(float minX, float maxX, float minZ, float maxZ, float step = 0.26f) {
    ScratchboxMesh mesh("Forest_Terrain_Floor");
    mesh.material.name = "PBR_Forest_Floor";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    int cols = static_cast<int>((maxX - minX) / step) + 1;
    int rows = static_cast<int>((maxZ - minZ) / step) + 1;

    // Soil Machine Sediment & Moisture Simulation (Infiniti SoilMachine)
    SoilSimulationConfig soilCfg;
    soilCfg.numParticles = 750;
    soilCfg.maxSteps = 28;
    auto soilSim = SoilMachineSedimentTracker::runSimulation(
        cols, rows, minX, minZ, step, getTerrainHeight, soilCfg
    );

    for (int r = 0; r < rows; ++r) {
        float z = minZ + r * step;
        for (int c = 0; c < cols; ++c) {
            float x = minX + c * step;
            float y = getTerrainHeight(x, z);
            Vec3 pos(x, y, z);
            Vec3 norm = getTerrainNormal(x, z);

            float moisture = soilSim.sampleMoisture(x, z, minX, minZ, step, cols, rows);
            float sediment = soilSim.sampleSediment(x, z, minX, minZ, step, cols, rows);

            float needleNoise = 0.5f + 0.5f * std::sin(x * 1.8f + z * 1.4f) * std::cos(x * 2.2f - z * 1.9f);
            float humusNoise  = 0.5f + 0.5f * std::sin(x * 3.4f - z * 2.8f) * std::cos(x * 1.2f + z * 3.1f);
            float microFbm    = 0.5f + 0.5f * std::sin(x * 4.2f + z * 4.6f) * std::cos(x * 5.1f - z * 3.3f);

            Vec4 color = math::lerp(COL_FOREST_HUMUS, COL_NEEDLE_DUFF, needleNoise * 0.70f + 0.15f);
            color = math::lerp(color, COL_ORGANIC_LOAM, humusNoise * 0.35f);

            // Soil machine moisture deepening in drainage channels
            color = math::lerp(color, Vec4(0.08f, 0.05f, 0.03f, 1.0f), moisture * 0.40f);

            if (norm.y > 0.88f && microFbm > 0.68f) {
                float mossWeight = std::clamp((microFbm - 0.68f) / 0.28f, 0.0f, 1.0f);
                color = math::lerp(color, COL_FLOOR_MOSS, mossWeight * 0.75f);
            }

            float noiseShade = 0.92f + 0.16f * microFbm;
            color = Vec4(color.x * noiseShade, color.y * noiseShade, color.z * noiseShade, 1.0f);

            Vec2 uv((x - minX) * 0.35f, (z - minZ) * 0.35f);
            mesh.addVertex(Vertex(pos, norm, uv, color));
        }
    }

    for (int r = 0; r < rows - 1; ++r) {
        for (int c = 0; c < cols - 1; ++c) {
            uint32_t i0 = r * cols + c;
            uint32_t i1 = r * cols + (c + 1);
            uint32_t i2 = (r + 1) * cols + c;
            uint32_t i3 = (r + 1) * cols + (c + 1);

            mesh.addTriangle(i0, i2, i1);
            mesh.addTriangle(i1, i2, i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

// Micro-Topographic Moss Hummock Cushion Generator
ScratchboxMesh generateMossHummock(const Vec3& center, float radiusX = 1.4f, float radiusZ = 1.1f, float height = 0.38f) {
    ScratchboxMesh mesh("Moss_Hummock");
    mesh.material.name = "PBR_Forest_Floor";
    mesh.material.roughnessFactor = 0.94f;
    mesh.material.metallicFactor = 0.01f;

    const int rings = 12;
    const int sectors = 18;
    float gy = getTerrainHeight(center.x, center.z);

    for (int r = 0; r <= rings; ++r) {
        float t = static_cast<float>(r) / static_cast<float>(rings);
        float rFrac = std::sin(t * HALF_PI);
        float h = height * (1.0f - t * t);

        for (int s = 0; s <= sectors; ++s) {
            float theta = (static_cast<float>(s) / sectors) * TWO_PI;
            float px = center.x + std::cos(theta) * radiusX * rFrac;
            float pz = center.z + std::sin(theta) * radiusZ * rFrac;
            float py = gy + h;

            Vec3 pos(px, py, pz);
            Vec3 norm(std::cos(theta) * rFrac * 0.6f, 1.0f - rFrac * 0.5f, std::sin(theta) * rFrac * 0.6f);
            norm = norm.normalized();

            Vec4 col = math::lerp(COL_FLOOR_MOSS, COL_NURSE_LOG_MOSS, 0.5f + 0.5f * std::cos(theta * 3.0f));
            mesh.addVertex(Vertex(pos, norm, Vec2(px * 0.5f, pz * 0.5f), col));
        }
    }

    for (int r = 0; r < rings; ++r) {
        int r0 = r * (sectors + 1);
        int r1 = (r + 1) * (sectors + 1);
        for (int s = 0; s < sectors; ++s) {
            uint32_t i0 = r0 + s;
            uint32_t i1 = r0 + (s + 1);
            uint32_t i2 = r1 + s;
            uint32_t i3 = r1 + (s + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 3. Ancient Redwood Trunk Generator with Fluted Buttress Roots & Cork Furrows
// ============================================================================
// The column stands vertical: its crown (section 6) is grown about the vertical through its stem, and the column is the
// leader that crown's limbs leave.
struct TrunkSpec {
    Vec3 basePos;
    float height;
    float baseRadius;
    float topRadius;
    int buttressLobes;
    float buttressSpread;
    bool hasHeroMoss;
    float furrowDepth;
};

ScratchboxMesh generateProceduralTrunk(const TrunkSpec& spec) {
    ScratchboxMesh mesh("Procedural_Tree_Trunk");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    const int vRings = 72;
    const int hSectors = 48;

    float groundY = getTerrainHeight(spec.basePos.x, spec.basePos.z);
    Vec3 rootOrigin(spec.basePos.x, groundY, spec.basePos.z);

    for (int ring = 0; ring <= vRings; ++ring) {
        float t = static_cast<float>(ring) / static_cast<float>(vRings);
        float currentY = rootOrigin.y + t * spec.height;

        float centerX = rootOrigin.x;
        float centerZ = rootOrigin.z;

        // Continuous Da Vinci taper transitioning to an organic pointed conifer spire apex
        float coreRadius = (t <= 0.72f)
            ? math::lerp(spec.baseRadius, spec.topRadius, std::pow(t, 0.68f))
            : math::lerp(spec.topRadius, 0.024f, std::pow((t - 0.72f) / 0.28f, 1.15f));

        float buttressDecay = std::max(0.0f, 1.0f - (t * spec.height) / 4.4f);
        buttressDecay = buttressDecay * buttressDecay;

        for (int sec = 0; sec < hSectors; ++sec) {
            float theta = (static_cast<float>(sec) / static_cast<float>(hSectors)) * TWO_PI;
            float cosT = std::cos(theta);
            float sinT = std::sin(theta);

            float buttressFlare = 0.0f;
            if (spec.buttressLobes > 0 && buttressDecay > 0.001f) {
                float lobeAngle = theta * static_cast<float>(spec.buttressLobes);
                float lobeVal = std::max(0.0f, std::cos(lobeAngle));
                buttressFlare = lobeVal * lobeVal * spec.buttressSpread * buttressDecay;
            }

            // Organic multi-octave anastomosing bark furrow relief (No harsh periodic zebra stripes)
            float barkFbm = 0.10f * std::sin(16.0f * theta + std::sin(currentY * 1.5f) * 1.4f)
                          + 0.05f * std::sin(32.0f * theta + currentY * 2.8f)
                          + 0.025f * std::cos(64.0f * theta);

            float furrowMod = spec.furrowDepth * barkFbm * (1.0f - t * 0.45f);

            float totalRadius = coreRadius + buttressFlare + furrowMod;
            float px = centerX + cosT * totalRadius;
            float pz = centerZ + sinT * totalRadius;

            // Anchor base vertices deeply below terrain surface so roots never float
            float py = currentY;
            if (ring == 0) {
                py = getTerrainHeight(px, pz) - 0.75f;
            }

            Vec3 pos(px, py, pz);

            Vec3 norm(cosT, 0.0f, sinT);
            float dAngle = -spec.furrowDepth * 16.0f * 0.10f * std::cos(16.0f * theta);
            norm.x += -sinT * dAngle;
            norm.z += cosT * dAngle;
            norm = norm.normalized();

            // Organic, photo-grounded redwood bark color modulation
            Vec4 color = COL_REDWOOD_BARK;
            if (barkFbm < -0.02f) {
                float tFurrow = std::clamp((-barkFbm - 0.02f) / 0.12f, 0.0f, 1.0f);
                color = math::lerp(COL_REDWOOD_BARK, COL_BARK_FURROW, tFurrow * 0.45f);
            } else if (barkFbm > 0.02f) {
                float tRidge = std::clamp((barkFbm - 0.02f) / 0.12f, 0.0f, 1.0f);
                color = math::lerp(COL_REDWOOD_BARK, COL_BARK_RIDGE, tRidge * 0.40f);
            }

            if (spec.hasHeroMoss && (currentY - rootOrigin.y) < 3.8f) {
                float mossHeightFactor = std::max(0.0f, 1.0f - (currentY - rootOrigin.y) / 3.8f);
                float aspectFacing = 0.5f + 0.5f * (norm.z * 0.65f - norm.x * 0.35f);
                float mossAmount = mossHeightFactor * (0.50f + 0.50f * aspectFacing);
                color = math::lerp(color, COL_TRUNK_MOSS, std::clamp(mossAmount, 0.0f, 0.94f));
            }

            Vec2 uv(static_cast<float>(sec) / static_cast<float>(hSectors) * 4.0f, t * (spec.height / 2.0f));
            mesh.addVertex(Vertex(pos, norm, uv, color));
        }
    }

    for (int ring = 0; ring < vRings; ++ring) {
        int r0 = ring * hSectors;
        int r1 = (ring + 1) * hSectors;

        for (int sec = 0; sec < hSectors; ++sec) {
            int next = (sec + 1) % hSectors;
            uint32_t i0 = r0 + sec;
            uint32_t i1 = r0 + next;
            uint32_t i2 = r1 + sec;
            uint32_t i3 = r1 + next;

            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    // 1. Close the subterranean trunk base with a watertight convex root disc cap (0 open boundary edges)
    uint32_t bottomCenterIdx = static_cast<uint32_t>(mesh.vertices.size());
    Vec3 bottomCenterPos(rootOrigin.x, rootOrigin.y - 0.90f, rootOrigin.z);
    mesh.addVertex(Vertex(bottomCenterPos, Vec3(0, -1, 0), Vec2(0.5f, 0.5f), COL_BARK_FURROW));
    for (int sec = 0; sec < hSectors; ++sec) {
        int next = (sec + 1) % hSectors;
        mesh.addTriangle(bottomCenterIdx, next, sec);
    }

    // 2. Close the trunk crown with a conical spire apex cap
    uint32_t apexIdx = static_cast<uint32_t>(mesh.vertices.size());
    Vec3 apexPos(rootOrigin.x, rootOrigin.y + spec.height + 0.55f, rootOrigin.z);
    mesh.addVertex(Vertex(apexPos, Vec3(0, 1, 0), Vec2(0.5f, 1.0f), COL_REDWOOD_BARK));

    int topRingBase = vRings * hSectors;
    for (int sec = 0; sec < hSectors; ++sec) {
        int next = (sec + 1) % hSectors;
        mesh.addTriangle(topRingBase + sec, topRingBase + next, apexIdx);
    }

    mesh.recomputeBounds();
    return mesh;
}

// Meandering surface root runner snaking across the forest floor
ScratchboxMesh generateSurfaceRootRunner(const Vec3& start, const Vec3& end, float rStart = 0.32f, float rEnd = 0.08f) {
    ScratchboxMesh mesh("Surface_Root_Runner");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.92f;
    mesh.material.metallicFactor = 0.01f;

    const int steps = 18;
    const int sectors = 14;

    Vec3 delta = end - start;
    float dist = delta.length();
    Vec3 dir = delta.normalized();

    for (int s = 0; s <= steps; ++s) {
        float u = static_cast<float>(s) / static_cast<float>(steps);
        float meander = std::sin(u * PI * 1.5f) * 0.28f;
        Vec3 pos = start + dir * (u * dist) + Vec3(-dir.z * meander, 0, dir.x * meander);
        float gy = getTerrainHeight(pos.x, pos.z);
        pos.y = gy + math::lerp(rStart, rEnd, u) * 0.65f;

        float r = math::lerp(rStart, rEnd, u);
        Vec3 forward = dir;
        Vec3 up = getTerrainNormal(pos.x, pos.z);
        Vec3 side = forward.cross(up).normalized();

        for (int sec = 0; sec <= sectors; ++sec) {
            float theta = (static_cast<float>(sec) / static_cast<float>(sectors)) * TWO_PI;
            Vec3 radial = (side * std::cos(theta) + up * std::sin(theta)).normalized();
            Vec3 p = pos + radial * r;
            Vec3 norm = radial;
            Vec4 col = math::lerp(COL_REDWOOD_BARK, COL_TRUNK_MOSS, std::clamp(norm.y * 0.65f + 0.35f, 0.0f, 0.88f));
            mesh.addVertex(Vertex(p, norm, Vec2(u * 2.0f, static_cast<float>(sec) / sectors), col));
        }
    }

    for (int s = 0; s < steps; ++s) {
        int r0 = s * (sectors + 1);
        int r1 = (s + 1) * (sectors + 1);
        for (int sec = 0; sec < sectors; ++sec) {
            uint32_t i0 = r0 + sec;
            uint32_t i1 = r0 + (sec + 1);
            uint32_t i2 = r1 + sec;
            uint32_t i3 = r1 + (sec + 1);
            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i1, i3, i2);
        }
    }

    // Seal both ends of surface root runner into closed watertight hulls
    uint32_t rootStartCap = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(start - dir * (rStart * 0.5f), -dir, Vec2(0, 0.5f), COL_REDWOOD_BARK));
    for (int sec = 0; sec < sectors; ++sec) {
        mesh.addTriangle(rootStartCap, sec + 1, sec);
    }

    uint32_t rootEndCap = static_cast<uint32_t>(mesh.vertices.size());
    int endRingBase = steps * (sectors + 1);
    mesh.addVertex(Vertex(end + dir * (rEnd * 0.5f), dir, Vec2(1, 0.5f), COL_REDWOOD_BARK));
    for (int sec = 0; sec < sectors; ++sec) {
        mesh.addTriangle(endRingBase + sec, endRingBase + sec + 1, rootEndCap);
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 4. Fallen Mossy Nurse Log with Decayed Cavities & Splintered Hollow Caps
// ============================================================================
ScratchboxMesh generateFallenNurseLog(const Vec3& start, const Vec3& end, float radius = 0.50f) {
    ScratchboxMesh mesh("Fallen_Nurse_Log");
    mesh.material.name = "PBR_Redwood_Bark";
    mesh.material.roughnessFactor = 0.90f;
    mesh.material.metallicFactor = 0.01f;

    geometry::Mesh hMesh = NurseLogGenerator::generateHollowNurseLog(
        start, end, radius, 0.55f, 40, 36,
        COL_REDWOOD_BARK, COL_NURSE_LOG_MOSS, COL_NURSE_LOG_WOOD, COL_BARK_FURROW
    );
    mesh.merge(hMesh.toScratchboxMesh());
    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 5. Lush Anatomical Sword Fern Clump Generator (Polystichum munitum)
// ============================================================================
ScratchboxMesh generateSwordFernClump(const Vec3& center, float clumpRadius = 1.45f, int numFronds = 24) {
    ScratchboxMesh mesh("Sword_Fern_Clump");
    mesh.material.name = "PBR_Sword_Ferns";
    mesh.material.roughnessFactor = 0.50f;
    mesh.material.metallicFactor = 0.01f;
    mesh.material.doubleSided = true;
    mesh.material.alphaMode = "MASK";
    mesh.material.alphaCutoff = 0.40f;

    float goldenAngle = 137.508f * DEG_TO_RAD;

    for (int f = 0; f < numFronds; ++f) {
        float fFrac = static_cast<float>(f) / static_cast<float>(numFronds);
        float azimuth = f * goldenAngle + (fFrac * 0.20f);

        float frondLen = clumpRadius * (0.85f + 0.45f * (1.0f - fFrac * 0.35f));
        float archHeight = clumpRadius * (0.45f + 0.35f * fFrac);

        Vec3 frondDir(std::cos(azimuth), 0.0f, std::sin(azimuth));
        Vec3 frondUp(0, 1, 0);
        Vec3 frondSide = frondDir.cross(frondUp).normalized();

        const int frondSteps = 16;
        std::vector<Vec3> spinePoints;
        spinePoints.reserve(frondSteps + 1);

        for (int s = 0; s <= frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            float h = archHeight * 4.0f * u * (1.0f - u * 0.70f) - (u > 0.65f ? (u - 0.65f) * 0.35f : 0.0f);
            float dist = frondLen * u;
            Vec3 spineP = center + frondDir * dist + Vec3(0, h, 0);
            spinePoints.push_back(spineP);
        }

        // Woody central rachis ribbon
        for (int s = 0; s < frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            float rRachis = math::lerp(0.008f, 0.0022f, u);
            const Vec3& pS = spinePoints[s];
            const Vec3& pE = spinePoints[s + 1];
            Vec3 forward = (pE - pS).normalized();
            Vec3 rSide = forward.cross(frondUp).normalized();

            uint32_t rIdx = static_cast<uint32_t>(mesh.vertices.size());
            Vec4 rCol(0.26f, 0.18f, 0.10f, 1.0f);
            mesh.addVertex(Vertex(pS - rSide * rRachis, frondUp, Vec2(0, 0), rCol));
            mesh.addVertex(Vertex(pS + rSide * rRachis, frondUp, Vec2(1, 0), rCol));
            mesh.addVertex(Vertex(pE - rSide * (rRachis * 0.8f), frondUp, Vec2(0, 1), rCol));
            mesh.addVertex(Vertex(pE + rSide * (rRachis * 0.8f), frondUp, Vec2(1, 1), rCol));
            mesh.addTriangle(rIdx, rIdx + 1, rIdx + 2);
            mesh.addTriangle(rIdx + 1, rIdx + 3, rIdx + 2);
        }

        // Alternating serrated pinnules
        for (int s = 1; s < frondSteps; ++s) {
            float u = static_cast<float>(s) / static_cast<float>(frondSteps);
            const Vec3& pStem = spinePoints[s];
            Vec3 forward = (spinePoints[s + 1] - spinePoints[s - 1]).normalized();
            Vec3 stemUp = forward.cross(frondSide).normalized();

            float pinnuleLen = clumpRadius * 0.32f * std::sin(u * PI);
            float pinnuleWidth = pinnuleLen * 0.38f;

            Vec4 leafColor = math::lerp(COL_FERN_FROND, COL_FERN_HIGHLIGHT, u * 0.85f);

            for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
                float signF = static_cast<float>(sideSign);
                Vec3 pBlade = pStem + frondSide * (signF * pinnuleLen) + stemUp * (0.06f * signF);
                Vec3 pTip   = pStem + frondSide * (signF * pinnuleLen * 1.15f) + forward * (pinnuleWidth * 0.5f);
                Vec3 pBase  = pStem - forward * (pinnuleWidth * 0.45f);

                Vec3 norm = stemUp;
                uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());

                mesh.addVertex(Vertex(pStem, norm, Vec2(0.5f, 0.0f), leafColor));
                mesh.addVertex(Vertex(pBase, norm, Vec2(0.0f, 0.5f), leafColor));
                mesh.addVertex(Vertex(pBlade, norm, Vec2(0.8f, 0.5f), leafColor));
                mesh.addVertex(Vertex(pTip, norm, Vec2(1.0f, 1.0f), leafColor));

                mesh.addTriangle(bIdx, bIdx + 1, bIdx + 2);
                mesh.addTriangle(bIdx, bIdx + 2, bIdx + 3);
            }
        }
    }

    // Emerging curling fiddleheads (crosiers) in clump center
    for (int c = 0; c < 3; ++c) {
        float cAzimuth = c * 2.1f;
        Vec3 cPos = center + Vec3(std::cos(cAzimuth) * 0.12f, 0.18f, std::sin(cAzimuth) * 0.12f);
        uint32_t cIdx = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 cUp(0, 1, 0);
        Vec4 crosierColor(0.38f, 0.62f, 0.16f, 1.0f);
        mesh.addVertex(Vertex(cPos, cUp, Vec2(0.5f, 0.5f), crosierColor));
        mesh.addVertex(Vertex(cPos + Vec3(0.08f, 0.10f, 0), cUp, Vec2(0.8f, 0.8f), crosierColor));
        mesh.addVertex(Vertex(cPos + Vec3(-0.06f, 0.12f, 0.06f), cUp, Vec2(0.2f, 0.8f), crosierColor));
        mesh.addTriangle(cIdx, cIdx + 1, cIdx + 2);
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 6. Crowns: SB-Veggie Trees Grown into Described Crowns
// ============================================================================
// Every crown is grown by SB-Veggie (scratchbox_sb_veggie_grove.hpp, the vegetation generator every 3D path uses): space
// colonisation into the crown described here in metres, SB-Veggie leaf clusters, proportions from the tree species
// library and bark from the tree texture library (each chosen by the crown's measurements and colour, never by name),
// written at four levels of detail into a GLB of its own. A redwood's crown rises from its fluted column: the grown
// tree's trunk is kept inside the column (half the column's base radius: inside its deepest furrows at the ground and
// at the crown base) and its limbs leave the column from the crown base up.

// Neighbouring crowns share the gap between their stems: a crown reaches this share of the distance to the nearest other
// stem past a reach every crown keeps, so foliage stops short of the next column.
constexpr float CROWN_GAP_SHARE = 0.62f;
constexpr float CROWN_MIN_REACH_M = 1.2f;

inline float unitHash(uint32_t a, uint32_t b) {
    uint32_t h = a * 0x9E3779B1u ^ (b + 0x7F4A7C15u) * 0x85EBCA77u;
    h ^= h >> 15; h *= 0x2C1B3C6Du; h ^= h >> 12; h *= 0x297A2D39u; h ^= h >> 15;
    return static_cast<float>(h & 0xFFFFFFu) / static_cast<float>(0x1000000u);
}

struct CrownProfile {
    float crownBaseShare;      // crown base / tree height
    float widestAt;            // share of the crown's depth where it is widest (0 its base)
    float topExponent;         // superellipse exponent of its upper profile (1 a cone, 2 a dome)
    Vec3 leafLinearRgb;        // foliage colour, linear RGB
    float colourSpread;        // +- share each tree's foliage varies by
    const char* label;         // free text carried into the GLB
};

inline tile_vegetation::DescribedTree describeCrown(const Vec3& stem, float heightM, float crownRadiusM, float trunkRadiusM,
                                                    const CrownProfile& profile, uint32_t index) {
    tile_vegetation::DescribedTree d;
    d.x = stem.x;
    d.y = getTerrainHeight(stem.x, stem.z);
    d.z = stem.z;
    d.heightM = heightM;
    d.crownRadiusXM = d.crownRadiusZM = crownRadiusM;
    d.crownBaseHeightM = profile.crownBaseShare * (0.92f + 0.16f * unitHash(index, 1)) * heightM;
    d.crownWidestAt = profile.widestAt;
    d.crownTopExponent = profile.topExponent;
    if (trunkRadiusM > 0.0f) d.trunkRadiusM = trunkRadiusM;
    const float shade = 1.0f + profile.colourSpread * (2.0f * unitHash(index, 2) - 1.0f);
    d.leafColourKnown = true;
    d.leafLinearRgb = {std::clamp(profile.leafLinearRgb.x * shade, 0.0f, 1.0f), std::clamp(profile.leafLinearRgb.y * shade, 0.0f, 1.0f),
                       std::clamp(profile.leafLinearRgb.z * shade, 0.0f, 1.0f)};
    d.label = profile.label;
    return d;
}

/** Each crown's radius: its own spread, within the gap the nearest other stem (of these crowns or `columns`) leaves it. */
inline void shareCrownGaps(std::vector<tile_vegetation::DescribedTree>& crowns, const std::vector<Vec3>& columns = {}) {
    for (size_t i = 0; i < crowns.size(); ++i) {
        double gap = std::numeric_limits<double>::infinity();
        for (size_t j = 0; j < crowns.size(); ++j) {
            if (i != j) gap = std::min(gap, std::hypot(crowns[i].x - crowns[j].x, crowns[i].z - crowns[j].z));
        }
        for (const Vec3& c : columns) gap = std::min(gap, std::hypot(crowns[i].x - c.x, crowns[i].z - c.z));
        const double r = std::min(crowns[i].crownRadiusXM, CROWN_MIN_REACH_M + CROWN_GAP_SHARE * gap);
        crowns[i].crownRadiusXM = crowns[i].crownRadiusZM = r;
    }
}

// ============================================================================
// 7. Volumetric Atmospheric Crepuscular Sunbeams (God Rays Geometry)
// ============================================================================
ScratchboxMesh generateAtmosphericGodRays(const Vec3& sunOrigin, const Vec3& focalCenter, int numRays = 56) {
    ScratchboxMesh mesh("Atmospheric_Crepuscular_Sunbeams");
    mesh.material.name = "PBR_Volumetric_GodRays";
    mesh.material.roughnessFactor = 0.99f;
    mesh.material.metallicFactor = 0.0f;
    mesh.material.alphaMode = "BLEND";
    mesh.material.doubleSided = true;

    Vec3 beamDir = (focalCenter - sunOrigin).normalized();
    Vec3 up(0, 1, 0);
    Vec3 side = beamDir.cross(up).normalized();
    up = side.cross(beamDir).normalized();

    for (int r = 0; r < numRays; ++r) {
        float rAngle = (static_cast<float>(r) / static_cast<float>(numRays)) * TWO_PI;
        float rDist = 1.0f + 3.6f * std::sin(r * 2.3f);

        Vec3 rayStart = sunOrigin + (side * std::cos(rAngle) + up * std::sin(rAngle)) * rDist;
        float beamLength = (focalCenter - sunOrigin).length() + 22.0f;
        float beamRadiusStart = 0.22f + 0.20f * (r % 4);
        float beamRadiusEnd = 2.6f + 0.85f * (r % 3);

        const int raySegments = 8;
        uint32_t bIdx = static_cast<uint32_t>(mesh.vertices.size());

        for (int i = 0; i < raySegments; ++i) {
            float theta = (static_cast<float>(i) / static_cast<float>(raySegments)) * TWO_PI;
            Vec3 radial = side * std::cos(theta) + up * std::sin(theta);

            Vec3 p0 = rayStart + radial * beamRadiusStart;
            Vec3 p1 = rayStart + beamDir * beamLength + radial * beamRadiusEnd;

            Vec4 colStart = Vec4(COL_SUNBEAM_GOLD.x, COL_SUNBEAM_GOLD.y, COL_SUNBEAM_GOLD.z, 0.025f);
            Vec4 colEnd = Vec4(COL_SUNBEAM_GOLD.x, COL_SUNBEAM_GOLD.y, COL_SUNBEAM_GOLD.z, 0.005f);

            Vec3 norm = radial;
            mesh.addVertex(Vertex(p0, norm, Vec2(0, 0), colStart));
            mesh.addVertex(Vertex(p1, norm, Vec2(1, 1), colEnd));
        }

        for (int i = 0; i < raySegments; ++i) {
            int next = (i + 1) % raySegments;
            uint32_t i0 = bIdx + i * 2;
            uint32_t i1 = bIdx + i * 2 + 1;
            uint32_t i2 = bIdx + next * 2;
            uint32_t i3 = bIdx + next * 2 + 1;

            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i2, i1, i3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

inline ScratchboxMesh generateShelfPolypores(const Vec3& attachBase, const Vec3& outwardDir, float maxRadius = 0.24f) {
    return BotanicalOrganGenerator::generateShelfPolypore(attachBase, outwardDir, maxRadius).toScratchboxMesh();
}

// ============================================================================
// Main Scene Assembly
// ============================================================================
int main(int argc, char** argv) {
    std::string outputPath = "public/models/forest_hyperreal.glb";
    if (argc > 1) {
        outputPath = argv[1];
    }

    std::cout << "================================================================\n";
    std::cout << "🌲 GENERATING HYPERREALISTIC 3D FOREST (ASTRO ENGINE C++20)\n";
    std::cout << "================================================================\n";

    auto tStart = std::chrono::high_resolution_clock::now();

    // 1. Woodland Biome Undulating Floor (Expansive 80m x 70m Natural Landscape)
    std::cout << "🌿 Synthesizing Undulating Woodland Floor with Humus & Needle Duff...\n";
    ScratchboxMesh floor = generateForestFloor(-40.0f, 40.0f, -50.0f, 20.0f, 0.48f);

    std::cout << "🌱 Modeling Micro-Topographic Moss Hummocks across the Forest Floor...\n";
    floor.merge(generateMossHummock(Vec3( 0.05f, 0, -0.55f), 1.6f, 0.55f, 0.45f));
    floor.merge(generateMossHummock(Vec3(-0.85f, 0, -0.35f), 1.1f, 0.50f, 0.40f));
    floor.merge(generateMossHummock(Vec3( 0.95f, 0, -0.65f), 1.2f, 0.50f, 0.42f));
    floor.merge(generateMossHummock(Vec3(-2.8f, 0,  0.4f), 1.5f, 1.2f, 0.42f));
    floor.merge(generateMossHummock(Vec3(-1.6f, 0,  1.2f), 1.3f, 0.9f, 0.35f));
    floor.merge(generateMossHummock(Vec3( 2.8f, 0,  0.2f), 1.6f, 1.3f, 0.45f));
    floor.merge(generateMossHummock(Vec3( 3.8f, 0, -1.2f), 1.4f, 1.0f, 0.38f));
    floor.merge(generateMossHummock(Vec3(-0.6f, 0, -3.2f), 1.8f, 0.8f, 0.32f));
    floor.merge(generateMossHummock(Vec3( 1.1f, 0, -3.5f), 1.9f, 0.9f, 0.36f));
    floor.merge(generateMossHummock(Vec3(-12.0f, 0, -8.0f), 2.2f, 1.6f, 0.45f));
    floor.merge(generateMossHummock(Vec3(-18.5f, 0, -15.0f), 2.4f, 1.8f, 0.48f));
    floor.merge(generateMossHummock(Vec3( 14.0f, 0, -6.0f), 2.0f, 1.5f, 0.42f));
    floor.merge(generateMossHummock(Vec3( 21.0f, 0, -14.0f), 2.5f, 1.7f, 0.46f));
    floor.merge(generateMossHummock(Vec3(-6.0f, 0, -26.0f), 2.1f, 1.5f, 0.40f));
    floor.merge(generateMossHummock(Vec3( 8.0f, 0, -28.0f), 2.3f, 1.6f, 0.44f));

    // 2. Redwood Columns (Forest_Trunks_And_Log); their crowns are grown in section 5
    ScratchboxMesh allTrunks("Forest_Trunks_And_Log");
    allTrunks.material.name = "PBR_Redwood_Bark";
    allTrunks.material.roughnessFactor = 0.92f;
    allTrunks.material.metallicFactor = 0.01f;

    std::cout << "🌳 Generating Hero Ancient Redwood Columns across Ecological Groves...\n";

    // Each redwood: its fluted column and the spread its crown may reach (section 6 shares it with its neighbours)
    struct Redwood {
        TrunkSpec trunk;
        float crownSpreadM;
    };

    // A. HERO FOREGROUND CORRIDOR (Framed for 1:1 National Geographic Alignment)
    std::vector<Redwood> redwoods = {
        // 1. The Monumental Monarch (Hero Ancient Redwood occupying center-right of frame at X = 0.95m, Z = -2.1m)
        { { Vec3( 0.95f, 0.0f, -2.1f), 36.0f, 1.95f, 0.88f, 10, 1.85f, true, 1.55f }, 6.5f },
        // 2. Left Sun-Facing Tree (Reaching into sunbeams)
        { { Vec3(-1.85f, 0.0f, -4.5f), 29.0f, 1.15f, 0.58f,  6, 1.15f, true, 1.25f }, 5.4f },
        // 3. Mid-Left Receding Tree 1
        { { Vec3(-3.2f,  0.0f, -6.5f), 28.0f, 0.95f, 0.50f,  5, 0.85f, true, 1.10f }, 4.8f },
        // 4. Far-Left Framing Redwood (Hugging left edge at X = -4.8m, Z = -0.5m)
        { { Vec3(-4.8f,  0.0f, -0.5f), 30.0f, 1.40f, 0.70f,  7, 1.25f, true, 1.20f }, 5.5f },
        // 5. Far-Right Foreground Framing Redwood (X = 4.8f, Z = 0.5f)
        { { Vec3( 4.8f,  0.0f,  0.5f), 30.0f, 1.45f, 0.72f,  7, 1.20f, true, 1.20f }, 5.5f }
    };

    // B. EXPANSIVE WEST & EAST GROVES AND DEEP COLONNADE (Spreading across 80m x 70m)
    std::cout << "🌲 Constructing Distributed Forest Groves across the Landscape...\n";
    const std::vector<TrunkSpec> landscapeTrees = {
        // West Grove (Spreading out to X = -35)
        { Vec3( -8.5f, 0.0f,   2.5f), 28.0f, 0.95f, 0.55f, 5, 0.85f, true, 1.05f },
        { Vec3(-11.5f, 0.0f,  -3.5f), 27.0f, 0.85f, 0.48f, 5, 0.75f, true, 0.95f },
        { Vec3(-15.0f, 0.0f,   1.0f), 28.0f, 0.90f, 0.52f, 4, 0.80f, true, 1.00f },
        { Vec3(-18.5f, 0.0f,  -6.5f), 26.0f, 0.78f, 0.45f, 4, 0.70f, true, 0.90f },
        { Vec3(-14.0f, 0.0f, -12.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, true, 0.95f },
        { Vec3(-22.0f, 0.0f, -10.5f), 25.0f, 0.75f, 0.42f, 3, 0.65f, false, 0.85f },
        { Vec3(-27.0f, 0.0f, -15.0f), 26.0f, 0.80f, 0.45f, 3, 0.70f, false, 0.85f },
        { Vec3(-19.5f, 0.0f, -20.0f), 25.0f, 0.74f, 0.42f, 3, 0.65f, false, 0.80f },
        { Vec3(-25.5f, 0.0f, -25.5f), 24.0f, 0.70f, 0.40f, 3, 0.60f, false, 0.80f },
        { Vec3(-16.0f, 0.0f, -29.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.75f },
        { Vec3(-31.0f, 0.0f, -22.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, false, 0.75f },
        { Vec3(-28.0f, 0.0f, -35.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, false, 0.70f },
        { Vec3(-20.0f, 0.0f, -39.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, false, 0.70f },
        { Vec3(-35.0f, 0.0f, -30.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, false, 0.65f },

        // East Grove (Spreading out to X = +35)
        { Vec3(  8.0f, 0.0f,   3.0f), 28.0f, 0.92f, 0.54f, 5, 0.80f, true, 1.00f },
        { Vec3( 12.0f, 0.0f,  -1.5f), 27.0f, 0.88f, 0.50f, 5, 0.75f, true, 0.95f },
        { Vec3( 16.5f, 0.0f,   2.5f), 28.0f, 0.90f, 0.52f, 4, 0.80f, true, 0.95f },
        { Vec3( 14.5f, 0.0f,  -6.5f), 26.0f, 0.80f, 0.45f, 4, 0.70f, true, 0.90f },
        { Vec3( 10.5f, 0.0f, -11.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, true, 0.95f },
        { Vec3( 18.5f, 0.0f, -10.0f), 25.0f, 0.76f, 0.42f, 3, 0.65f, false, 0.85f },
        { Vec3( 23.0f, 0.0f, -14.5f), 26.0f, 0.78f, 0.44f, 3, 0.70f, false, 0.85f },
        { Vec3( 15.5f, 0.0f, -18.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.80f },
        { Vec3( 27.0f, 0.0f, -20.0f), 24.0f, 0.70f, 0.38f, 3, 0.60f, false, 0.80f },
        { Vec3( 21.0f, 0.0f, -26.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, false, 0.75f },
        { Vec3( 17.0f, 0.0f, -31.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, false, 0.75f },
        { Vec3( 29.0f, 0.0f, -29.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, false, 0.70f },
        { Vec3( 24.0f, 0.0f, -37.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, false, 0.70f },
        { Vec3( 33.0f, 0.0f, -25.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, false, 0.65f },

        // North & Deep Background Colonnade (Z from -10 to -48 across clearing depth)
        { Vec3( -1.8f, 0.0f, -12.5f), 26.0f, 0.68f, 0.40f, 3, 0.55f, true, 0.85f },
        { Vec3(  3.2f, 0.0f, -14.5f), 25.0f, 0.65f, 0.38f, 3, 0.50f, true, 0.85f },
        { Vec3( -4.5f, 0.0f, -16.5f), 26.0f, 0.66f, 0.38f, 3, 0.50f, true, 0.80f },
        { Vec3(  1.5f, 0.0f, -18.5f), 25.0f, 0.62f, 0.36f, 3, 0.45f, true, 0.80f },
        { Vec3( -3.0f, 0.0f, -22.5f), 25.0f, 0.60f, 0.35f, 0, 0.00f, false, 0.75f },
        { Vec3(  3.8f, 0.0f, -25.0f), 24.0f, 0.58f, 0.34f, 0, 0.00f, false, 0.75f },
        { Vec3( -0.5f, 0.0f, -28.5f), 25.0f, 0.56f, 0.32f, 0, 0.00f, false, 0.70f },
        { Vec3(  2.4f, 0.0f, -33.0f), 24.0f, 0.54f, 0.30f, 0, 0.00f, false, 0.70f },
        { Vec3( -4.8f, 0.0f, -37.5f), 25.0f, 0.55f, 0.30f, 0, 0.00f, false, 0.65f },
        { Vec3(  1.2f, 0.0f, -43.0f), 24.0f, 0.50f, 0.28f, 0, 0.00f, false, 0.65f },
        { Vec3( -2.0f, 0.0f, -47.0f), 24.0f, 0.48f, 0.26f, 0, 0.00f, false, 0.60f },
        { Vec3(  4.5f, 0.0f, -48.0f), 23.0f, 0.46f, 0.25f, 0, 0.00f, false, 0.60f }
    };
    for (size_t i = 0; i < landscapeTrees.size(); ++i) {
        redwoods.push_back({ landscapeTrees[i], 3.6f + 1.2f * (static_cast<float>(i % 4) / 3.0f) });
    }

    // A redwood crown: a narrow cone from about two fifths of the height, widest low down, dark yellow-green foliage
    const CrownProfile redwoodCrown{ 0.38f, 0.18f, 1.15f, Vec3(0.040f, 0.085f, 0.030f), 0.18f, "coast redwood crown" };
    std::vector<tile_vegetation::DescribedTree> crowns;
    std::vector<Vec3> columns;
    for (size_t i = 0; i < redwoods.size(); ++i) {
        const TrunkSpec& trunk = redwoods[i].trunk;
        allTrunks.merge(generateProceduralTrunk(trunk));
        crowns.push_back(describeCrown(trunk.basePos, trunk.height + 0.55f, redwoods[i].crownSpreadM, 0.5f * trunk.baseRadius,
                                       redwoodCrown, static_cast<uint32_t>(i)));
        columns.push_back(trunk.basePos);
    }
    shareCrownGaps(crowns);

    // Root buttress runners grounding the Monarch into the humus
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3(-0.4f, 0, -0.6f), 0.42f, 0.10f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 2.3f, 0, -0.8f), 0.38f, 0.09f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 0.2f, 0, -4.2f), 0.35f, 0.08f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 2.4f, 0, -3.8f), 0.32f, 0.07f));

    // 4. Fallen Mossy Nurse Logs Spanning the Landscape
    std::cout << "🪵 Generating Massive Fallen Mossy Nurse Logs across Landscape Quadrants...\n";
    Vec3 logStart(-1.45f, 0.0f, -0.35f);
    Vec3 logEnd  ( 1.55f, 0.0f, -0.75f);
    allTrunks.merge(generateFallenNurseLog(logStart, logEnd, 0.52f));

    Vec3 log2Start(-3.8f, 0.0f, -4.5f);
    Vec3 log2End  (-1.8f, 0.0f, -6.8f);
    allTrunks.merge(generateFallenNurseLog(log2Start, log2End, 0.44f));

    Vec3 log3Start(-18.0f, 0.0f, -15.0f);
    Vec3 log3End  (-11.5f, 0.0f, -18.0f);
    allTrunks.merge(generateFallenNurseLog(log3Start, log3End, 0.52f));

    Vec3 log4Start(12.0f, 0.0f, -11.0f);
    Vec3 log4End  (17.5f, 0.0f, -14.5f);
    allTrunks.merge(generateFallenNurseLog(log4Start, log4End, 0.46f));

    Vec3 log5Start(-5.0f, 0.0f, -33.0f);
    Vec3 log5End  ( 2.0f, 0.0f, -35.5f);
    allTrunks.merge(generateFallenNurseLog(log5Start, log5End, 0.55f));

    // Epiphytic Shelf Bracket Polypores on Hero Redwood & Nurse Logs
    allTrunks.merge(generateShelfPolypores(Vec3(0.55f, getTerrainHeight(0.55f, -1.8f) + 1.2f, -1.8f), Vec3(0.2f, 0, 0.9f), 0.26f));
    allTrunks.merge(generateShelfPolypores(Vec3(0.15f, getTerrainHeight(0.15f, -2.1f) + 2.2f, -2.1f), Vec3(-0.9f, 0, 0.2f), 0.22f));
    allTrunks.merge(generateShelfPolypores(Vec3(0.85f, getTerrainHeight(0.85f, -1.9f) + 0.38f, -1.9f), Vec3(0.7f, 0.2f, 0.6f), 0.20f));
    allTrunks.merge(generateShelfPolypores(Vec3(0.4f, getTerrainHeight(0.4f, -0.6f) + 0.45f, -0.6f), Vec3(-0.4f, 0.2f, 0.9f), 0.24f));
    allTrunks.merge(generateShelfPolypores(Vec3(-14.5f, getTerrainHeight(-14.5f, -16.5f) + 0.42f, -16.5f), Vec3(0.3f, 0.2f, 0.9f), 0.28f));
    allTrunks.merge(generateShelfPolypores(Vec3( 14.2f, getTerrainHeight( 14.2f, -12.8f) + 0.40f, -12.8f), Vec3(-0.5f, 0.2f, 0.8f), 0.25f));

    // 5. Understory Subcanopy Trees, then Every Crown Grown by SB-Veggie (section 6)
    std::cout << "🌲 Describing Understory Subcanopy Crowns in the Gaps between the Columns...\n";
    // A broadleaf understory crown: a dome from a third of the height, widest at its middle, brighter green than the redwoods
    const CrownProfile understoryCrown{ 0.32f, 0.45f, 2.2f, Vec3(0.070f, 0.150f, 0.040f), 0.15f, "understory broadleaf crown" };
    struct UnderstoryTree { float x, z, heightM, spreadM; };
    const UnderstoryTree understory[] = {
        {  0.8f,  -7.5f,  5.4f, 2.2f },
        {  4.5f,  -8.2f,  5.2f, 2.1f },
        { -6.2f, -10.75f, 5.8f, 2.4f },
        {  2.4f,  -9.5f,  5.5f, 2.4f }
    };
    std::vector<tile_vegetation::DescribedTree> understoryCrowns;
    for (size_t i = 0; i < std::size(understory); ++i) {
        const UnderstoryTree& u = understory[i];
        understoryCrowns.push_back(describeCrown(Vec3(u.x, 0.0f, u.z), u.heightM, u.spreadM, 0.0f, understoryCrown,
                                                 static_cast<uint32_t>(crowns.size() + i)));
    }
    shareCrownGaps(understoryCrowns, columns);
    crowns.insert(crowns.end(), understoryCrowns.begin(), understoryCrowns.end());

    std::cout << "🌳 Growing " << crowns.size() << " Crowns with SB-Veggie (space colonisation, species & texture libraries)...\n";
    tile_vegetation::GroveOptions grove;
    grove.seed = 0x5EED0F0E57ull;
    grove.speciesIndexPath = "assets/vegetation/species/index.json";
    grove.textureIndexPath = "assets/textures/trees/index.json";
    grove.reveal = false;
    grove.label = "forest_3d_viewer crowns";
    tile_vegetation::GroveResult grown;
    try {
        grown = tile_vegetation::growDescribedTrees(crowns, grove);
    } catch (const std::exception& e) {
        std::cerr << "❌ Fatal: SB-Veggie could not grow the forest's crowns: " << e.what() << "\n";
        return 1;
    }

    // 6. Fern Colonies Mesh Group (High Density - 85+ Colonies)
    ScratchboxMesh allFerns("Forest_Sword_Ferns");
    allFerns.material.name = "PBR_Sword_Ferns";
    allFerns.material.roughnessFactor = 0.50f;
    allFerns.material.metallicFactor = 0.01f;
    allFerns.material.doubleSided = true;
    allFerns.material.alphaMode = "MASK";
    allFerns.material.alphaCutoff = 0.40f;

    std::cout << "🌿 Populating Lush Sword Fern Colonies (Polystichum munitum - 85+ Colonies)...\n";
    std::vector<Vec3> fernLocations = {
        // Foreground Left Cascading Hero Fern Bank (Dominating bottom-left corner like in photo)
        Vec3(-1.15f, 0.0f,  0.95f), Vec3(-1.65f, 0.0f,  0.75f), Vec3(-0.75f, 0.0f,  1.15f),
        Vec3(-1.45f, 0.0f,  0.35f), Vec3(-1.95f, 0.0f,  0.15f), Vec3(-0.95f, 0.0f,  0.25f),

        // Foreground Center directly in front of and flanking the Fallen Nurse Log
        Vec3(-0.45f, 0.0f,  0.25f), Vec3( 0.15f, 0.0f,  0.15f), Vec3( 0.75f, 0.0f,  0.10f),
        Vec3( 1.35f, 0.0f, -0.15f), Vec3( 1.85f, 0.0f, -0.35f), Vec3( 2.35f, 0.0f, -0.55f),

        // Flanking and surrounding the Monarch root buttresses behind the log
        Vec3( 0.05f, 0.0f, -1.25f), Vec3( 0.55f, 0.0f, -1.35f), Vec3( 1.15f, 0.0f, -1.45f),
        Vec3( 1.85f, 0.0f, -1.25f), Vec3( 2.25f, 0.0f, -1.85f), Vec3(-0.45f, 0.0f, -1.65f),

        // Midground colonnade borders
        Vec3(-1.20f, 0.0f, -3.5f), Vec3(-2.20f, 0.0f, -4.5f), Vec3( 2.80f, 0.0f, -3.2f),
        Vec3(-1.60f, 0.0f, -6.5f), Vec3(-3.20f, 0.0f, -7.5f), Vec3( 1.80f, 0.0f, -6.2f)
    };

    for (size_t f = 0; f < fernLocations.size(); ++f) {
        float fx = fernLocations[f].x;
        float fz = fernLocations[f].z;
        float fy = getTerrainHeight(fx, fz);
        // a clump's radius sets its fronds' length and arch: 1 m makes sword fern fronds 1.1-1.3 m long arching 0.6-1.1 m
        // high (the reference's ferns, below a standing eye), not 3 m fronds over the bookmarks' cameras
        float radius = (f < 6) ? 1.05f : ((f < 12) ? 0.95f : 0.85f);
        int fronds = (f < 6) ? 34 : ((f < 12) ? 26 : 20);
        allFerns.merge(generateSwordFernClump(Vec3(fx, fy, fz), radius, fronds));
    }

    std::cout << "🌿 Seeding Clustered Fern Colonies across the Landscape (Infiniti Keypoint Cluster Engine)...\n";
    ClusterScatterConfig fernClusterCfg;
    fernClusterCfg.numKeypoints = 12;
    fernClusterCfg.clusterRadius = 3.6f;
    fernClusterCfg.instancesPerCluster = 6;
    fernClusterCfg.minInstanceDistance = 0.55f;
    fernClusterCfg.maxSlopeAngleRad = 0.65f;
    fernClusterCfg.seed = 31415;

    auto scatteredFerns = KeypointClusterScatterEngine::generateClusters(
        -32.0f, 32.0f, -42.0f, 10.0f,
        getTerrainHeight, getTerrainNormal, fernClusterCfg
    );

    for (const auto& sf : scatteredFerns) {
        float rad = 0.85f * sf.scale;
        int numFronds = static_cast<int>(18 * sf.scale);
        allFerns.merge(generateSwordFernClump(sf.position, rad, std::max(10, numFronds)));
    }

    // 7. Woodland Undergrowth (Grass Clumps, Oxalis Sorrel, Nurse Log Ivy & Fallen Wood Litter)
    std::cout << "🌱 Synthesizing Botanical Undergrowth (Grass Clumps, Oxalis Sorrel, Deadwood Litter & Nurse Log Ivy)...\n";
    ScratchboxMesh allUnderstory("Forest_Woodland_Undergrowth");
    allUnderstory.material.name = "PBR_Woodland_Undergrowth";
    allUnderstory.material.roughnessFactor = 0.52f;
    allUnderstory.material.metallicFactor = 0.01f;
    allUnderstory.material.doubleSided = true;
    allUnderstory.material.alphaMode = "MASK";
    allUnderstory.material.alphaCutoff = 0.35f;

    // Wood Sorrel (Oxalis oregana) ground carpets
    std::cout << "☘️ Spreading Wood Sorrel (Oxalis) Mats around Tree Buttresses...\n";
    std::vector<Vec3> sorrelPatches = {
        Vec3(-2.8f, 0,  0.2f), Vec3(-1.8f, 0,  1.1f), Vec3(-3.4f, 0, -1.2f),
        Vec3( 2.8f, 0,  0.2f), Vec3( 3.2f, 0, -0.4f), Vec3( 2.2f, 0,  1.2f),
        Vec3(-0.8f, 0, -3.1f), Vec3( 0.6f, 0, -3.3f), Vec3( 1.4f, 0, -3.7f),
        Vec3(-0.2f, 0, -5.2f), Vec3( 0.4f, 0, -5.8f), Vec3(-1.0f, 0, -5.5f)
    };
    for (const auto& sp : sorrelPatches) {
        geometry::Mesh sorrel = BotanicalOrganGenerator::generateWoodSorrelPatch(sp, 0.95f, 22);
        allUnderstory.merge(sorrel.toScratchboxMesh());
    }

    std::cout << "☘️ Seeding Clustered Wood Sorrel Mats across Landscape (Infiniti Keypoint Cluster Engine)...\n";
    ClusterScatterConfig sorrelClusterCfg;
    sorrelClusterCfg.numKeypoints = 14;
    sorrelClusterCfg.clusterRadius = 2.4f;
    sorrelClusterCfg.instancesPerCluster = 5;
    sorrelClusterCfg.minInstanceDistance = 0.40f;
    sorrelClusterCfg.maxSlopeAngleRad = 0.70f;
    sorrelClusterCfg.seed = 27182;

    auto scatteredSorrels = KeypointClusterScatterEngine::generateClusters(
        -30.0f, 30.0f, -40.0f, 12.0f,
        getTerrainHeight, getTerrainNormal, sorrelClusterCfg
    );

    for (const auto& ss : scatteredSorrels) {
        geometry::Mesh sorrelMesh = BotanicalOrganGenerator::generateWoodSorrelPatch(ss.position, 0.85f * ss.scale, 18);
        allUnderstory.merge(sorrelMesh.toScratchboxMesh());
    }

    // Grass Clumps across the forest floor
    for (int g = 0; g < 42; ++g) {
        float gx = -12.0f + 24.0f * (static_cast<float>(g % 7) / 6.0f) + (std::sin(g * 2.3f) * 0.8f);
        float gz = -30.0f + 36.0f * (static_cast<float>(g / 7) / 5.0f) + (std::cos(g * 1.7f) * 0.8f);
        float gy = getTerrainHeight(gx, gz);

        GrassClumpConfig gCfg;
        gCfg.bladeCount = 14 + (g % 8);
        gCfg.clumpRadius = 0.22f + 0.10f * std::sin(g * 1.5f);
        gCfg.bladeHeightMin = 0.22f;
        gCfg.bladeHeightMax = 0.45f;
        gCfg.seed = 1000 + g * 37;

        geometry::Mesh grassMesh = GrassClumpGenerator::generateClump(gCfg, Vec3(gx, gy, gz));
        allUnderstory.merge(grassMesh.toScratchboxMesh());
    }

    // Creeping moss/ivy tendrils wrapping over the nurse logs
    IvyConfig logIvy1;
    logIvy1.rootPosition = Vec3(1.3f, getTerrainHeight(1.3f, -2.4f), -2.4f);
    logIvy1.obstacleMin = Vec3(0.9f, getTerrainHeight(1.1f, -1.8f) - 0.2f, -5.4f);
    logIvy1.obstacleMax = Vec3(2.9f, getTerrainHeight(2.7f, -5.2f) + 0.7f, -1.6f);
    logIvy1.maxSteps = 30;
    logIvy1.stepLength = 0.18f;
    logIvy1.clingDistance = 0.04f;
    logIvy1.leafSize = 0.14f;
    logIvy1.seed = 7771;
    geometry::Mesh ivyMesh1 = IvyGrowthGenerator::generateIvy(logIvy1);
    allUnderstory.merge(ivyMesh1.toScratchboxMesh());

    // Volumetric 3D Velvet Moss Tufts on Nurse Logs & Buttress Roots
    std::cout << "🌱 Seeding 3D Volumetric Velvet Moss Tufts on Nurse Logs & Hero Roots...\n";
    geometry::Mesh tufts1 = BotanicalOrganGenerator::generateVolumetricMossTufts(logStart, logEnd, 0.48f, 180);
    allUnderstory.merge(tufts1.toScratchboxMesh());
    geometry::Mesh tufts2 = BotanicalOrganGenerator::generateVolumetricMossTufts(log2Start, log2End, 0.44f, 150);
    allUnderstory.merge(tufts2.toScratchboxMesh());
    geometry::Mesh tufts3 = BotanicalOrganGenerator::generateVolumetricMossTufts(log3Start, log3End, 0.52f, 160);
    allUnderstory.merge(tufts3.toScratchboxMesh());
    geometry::Mesh tufts4 = BotanicalOrganGenerator::generateVolumetricMossTufts(log4Start, log4End, 0.46f, 140);
    allUnderstory.merge(tufts4.toScratchboxMesh());
    geometry::Mesh tufts5 = BotanicalOrganGenerator::generateVolumetricMossTufts(Vec3(-2.2f, 0, -0.6f), Vec3(-3.8f, 0,  1.4f), 0.26f, 90);
    allUnderstory.merge(tufts5.toScratchboxMesh());
    geometry::Mesh tufts6 = BotanicalOrganGenerator::generateVolumetricMossTufts(Vec3(-2.2f, 0, -0.6f), Vec3(-1.1f, 0,  1.6f), 0.24f, 80);
    allUnderstory.merge(tufts6.toScratchboxMesh());

    // Fallen Deadwood Branches, Pinecones, Bark Chips, Decaying Fronds & Sub-Centimeter Needle Carpet
    std::cout << "🍂 Laying Sub-Centimeter Fallen Needle Carpet & Woodland Litter...\n";
    for (int i = 0; i < 55; ++i) {
        float lx = -5.0f + 10.0f * (static_cast<float>(i % 8) / 7.0f) + (std::sin(i * 1.9f) * 1.2f);
        float lz = -12.0f + 16.0f * (static_cast<float>(i / 8) / 6.0f) + (std::cos(i * 2.7f) * 1.2f);
        float ly = getTerrainHeight(lx, lz);
        float len = 0.8f + 1.2f * std::sin(i * 3.3f);
        float ang = i * 1.8f;
        Vec3 bStart(lx, ly + 0.04f, lz);
        Vec3 bEnd(lx + std::cos(ang) * len, getTerrainHeight(lx + std::cos(ang) * len, lz + std::sin(ang) * len) + 0.04f, lz + std::sin(ang) * len);
        Vec3 dir = (bEnd - bStart).normalized();
        Vec3 up(0, 1, 0);
        Vec3 side = dir.cross(up).normalized();
        up = side.cross(dir).normalized();

        uint32_t bIdx = static_cast<uint32_t>(allUnderstory.vertices.size());
        float r = 0.035f + 0.02f * (i % 3);
        for (int s = 0; s < 4; ++s) {
            float theta = (static_cast<float>(s) / 4.0f) * TWO_PI;
            Vec3 rad = side * std::cos(theta) + up * std::sin(theta);
            Vec4 woodCol = math::lerp(COL_NURSE_LOG_WOOD, COL_BARK_FURROW, 0.40f);
            allUnderstory.addVertex(Vertex(bStart + rad * r, rad, Vec2(0, 0), woodCol));
            allUnderstory.addVertex(Vertex(bEnd + rad * (r * 0.6f), rad, Vec2(1, 1), woodCol));
        }
        for (int s = 0; s < 4; ++s) {
            int next = (s + 1) % 4;
            allUnderstory.addTriangle(bIdx + s * 2, bIdx + s * 2 + 1, bIdx + next * 2);
            allUnderstory.addTriangle(bIdx + next * 2, bIdx + s * 2 + 1, bIdx + next * 2 + 1);
        }
    }

    // 130 Fibonacci Pinecones scattered non-uniformly
    for (int i = 0; i < 130; ++i) {
        float px = -5.5f + 11.0f * (static_cast<float>(i % 13) / 12.0f) + (std::sin(i * 2.1f) * 0.85f);
        float pz = -12.5f + 17.0f * (static_cast<float>(i / 13) / 9.0f) + (std::cos(i * 1.7f) * 0.85f);
        float py = getTerrainHeight(px, pz) + 0.025f;
        float yaw = i * 1.35f;
        Vec3 dir(std::cos(yaw), 0.0f, std::sin(yaw));
        Vec3 up = getTerrainNormal(px, pz);
        geometry::Mesh cone = BotanicalOrganGenerator::generateFibonacciPinecone(Vec3(px, py, pz), dir, up, 0.11f, 0.042f, 18);
        allUnderstory.merge(cone.toScratchboxMesh());
    }

    // 38 Decaying Winter Fronds pressed to ground
    for (int f = 0; f < 38; ++f) {
        float fx = -3.8f + 7.6f * (static_cast<float>(f % 7) / 6.0f) + (std::sin(f * 2.3f) * 0.6f);
        float fz = -9.5f + 12.0f * (static_cast<float>(f / 7) / 5.0f) + (std::cos(f * 1.9f) * 0.6f);
        float fy = getTerrainHeight(fx, fz) + 0.015f;
        float yaw = f * 1.45f;
        Vec3 dir(std::cos(yaw), 0.0f, std::sin(yaw));
        Vec3 norm = getTerrainNormal(fx, fz);
        geometry::Mesh frond = BotanicalOrganGenerator::generateDecayingWinterFrond(Vec3(fx, fy, fz), dir, norm, 0.95f, 10);
        allUnderstory.merge(frond.toScratchboxMesh());
    }

    // 1400 Sub-Centimeter Fallen Needle Clusters
    for (int c = 0; c < 1400; ++c) {
        float cx = -5.2f + 10.4f * (static_cast<float>(c % 40) / 39.0f) + (std::sin(c * 2.3f) * 0.45f);
        float cz = -12.5f + 16.0f * (static_cast<float>(c / 40) / 34.0f) + (std::cos(c * 1.7f) * 0.45f);
        float cy = getTerrainHeight(cx, cz) + 0.012f;
        Vec3 groundNorm = getTerrainNormal(cx, cz);
        geometry::Mesh needles = BotanicalOrganGenerator::generateFallenNeedleCluster(Vec3(cx, cy, cz), groundNorm, 8, 0.038f, 0.0042f);
        allUnderstory.merge(needles.toScratchboxMesh());
    }

    // Macro-to-Micro Narrative Clutter Distribution in Biological Deposition Pockets
    std::cout << "📦 Distributing Macro-to-Micro Narrative Clutter into Biological Deposition Pockets...\n";
    auto pockets = NarrativeClutterPlacer::identifyPockets(
        { Vec3(-2.2f, 0, -0.6f), Vec3(2.6f, 0, -5.2f), Vec3(4.5f, 0, 0.5f), Vec3(-5.5f, 0, 1.2f), Vec3(-8.5f, 0, 2.5f), Vec3(8.0f, 0, 3.0f) },
        { { logStart, logEnd }, { log2Start, log2End }, { log3Start, log3End }, { log4Start, log4End } },
        getTerrainHeight,
        getTerrainNormal
    );
    for (const auto& p : pockets) {
        if (p.type == NarrativeClutterPlacer::PocketType::RootButtressCrotch) {
            geometry::Mesh cluster = BotanicalOrganGenerator::generateFallenNeedleCluster(p.position, p.surfaceNormal, 12);
            allUnderstory.merge(cluster.toScratchboxMesh());
        }
    }

    // 8. Volumetric Atmospheric God Rays
    std::cout << "☀️ Injecting Morning Crepuscular Sunbeams (56 Volumetric God Rays)...\n";
    Vec3 sunOrigin(3.8f, 18.0f, -14.0f);
    Vec3 focalCenter(-1.4f, 1.2f, -5.5f);
    ScratchboxMesh godRays = generateAtmosphericGodRays(sunOrigin, focalCenter, 56);

    // 9. Assemble Discrete Multi-Mesh Array for GlbWriter (the crowns are their own GLB, section 6)
    std::vector<ScratchboxMesh> subMeshes = {
        floor,          // Index 0: PBR_Forest_Floor
        allTrunks,      // Index 1: PBR_Redwood_Bark
        allFerns,       // Index 2: PBR_Sword_Ferns
        allUnderstory,  // Index 3: PBR_Woodland_Undergrowth
        godRays         // Index 4: PBR_Volumetric_GodRays
    };

    size_t totalVerts = 0, totalTris = 0;
    for (const auto& m : subMeshes) {
        totalVerts += m.vertices.size();
        totalTris += m.indices.size() / 3;
    }

    std::cout << "\n📊 Scene Multi-Mesh Telemetry:\n";
    std::cout << "   Submeshes Count: " << subMeshes.size() << "\n";
    std::cout << "   Total Vertices:  " << totalVerts << "\n";
    std::cout << "   Total Triangles: " << totalTris << "\n";
    std::cout << "   SB-Veggie Crowns: " << grown.statsJson.substr(0, grown.statsJson.find(",\"perTree\"")) << "}\n";

    // 10. Embed Authentic Photo-Derived PBR Texture Maps into GLB (the viewer draws with these; a missing map is fatal)
    std::cout << "\n🎨 Embedding Photo-Derived PBR Texture Maps into glTF Materials...\n";
    std::vector<io::EmbeddedTexture> remappedTextures;

    auto addPhotoTexture = [&](const std::string& filename, io::TextureUsage usage, int matIdx) {
        std::string fullPath = "public/textures/" + filename;
        auto bytes = loadPngFile(fullPath);
        if (bytes.empty()) {
            std::cerr << "❌ Fatal: cannot read " << fullPath << " (run from the repository root)\n";
            return false;
        }
        io::EmbeddedTexture t;
        t.name = filename;
        t.mimeType = "image/png";
        t.data = std::move(bytes);
        t.usage = usage;
        t.materialIndex = matIdx;
        remappedTextures.push_back(t);
        std::cout << "   ✅ Embedded " << filename << " into Material " << matIdx << " (" << t.data.size() << " bytes)\n";
        return true;
    };

    const struct { const char* set; int material; } photoSets[] = {
        { "photo_forest_floor", 0 },   // Material 0: PBR_Forest_Floor
        { "photo_redwood_bark", 1 },   // Material 1: PBR_Redwood_Bark
        { "photo_fern", 2 },           // Material 2: PBR_Sword_Ferns
        { "photo_moss", 3 }            // Material 3: PBR_Woodland_Undergrowth
    };
    for (const auto& ps : photoSets) {
        const std::string set = ps.set;
        if (!addPhotoTexture(set + "_albedo.png", io::TextureUsage::BASE_COLOR, ps.material) ||
            !addPhotoTexture(set + "_normal.png", io::TextureUsage::NORMAL, ps.material) ||
            !addPhotoTexture(set + "_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, ps.material)) {
            return 1;
        }
    }

    std::cout << "   Total Embedded Textures: " << remappedTextures.size() << "\n";

    // Serialize to standard Binary glTF 2.0 (.glb)
    std::cout << "\n💾 Serializing to Standard Multi-Mesh Binary glTF 2.0 (.glb)...\n";
    std::vector<uint8_t> glbData = io::GlbWriter::serializeMultiMeshToGlb(subMeshes, remappedTextures);

    if (glbData.empty()) {
        std::cerr << "❌ Fatal: GlbWriter emitted empty byte array!\n";
        return 1;
    }

    std::string dir = outputPath.substr(0, outputPath.find_last_of("/\\"));
    if (!dir.empty()) {
        std::string mkdirCmd = "mkdir -p \"" + dir + "\"";
        int sysRet = system(mkdirCmd.c_str());
        (void)sysRet;
    }

    // The crowns beside the forest: <output>_trees.glb, and what SB-Veggie grew in <output>_trees.stats.json
    const std::string stem = outputPath.size() > 4 && outputPath.substr(outputPath.size() - 4) == ".glb" ? outputPath.substr(0, outputPath.size() - 4) : outputPath;
    const std::string treesPath = stem + "_trees.glb";
    const std::string treesStatsPath = stem + "_trees.stats.json";
    const std::pair<const std::string*, const std::vector<uint8_t>*> glbs[] = { { &outputPath, &glbData }, { &treesPath, &grown.glb } };
    for (const auto& [path, bytes] : glbs) {
        std::ofstream outFile(*path, std::ios::binary);
        if (!outFile.is_open()) {
            std::cerr << "❌ Fatal: Could not open output file " << *path << "\n";
            return 1;
        }
        outFile.write(reinterpret_cast<const char*>(bytes->data()), static_cast<std::streamsize>(bytes->size()));
        std::cout << "✅ Successfully Exported: " << *path << " (" << bytes->size() << " bytes)\n";
    }
    std::ofstream statsFile(treesStatsPath);
    statsFile << grown.statsJson << "\n";

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "⏱️ Procedural Forest Generation Completed in " << ms << " ms.\n";
    std::cout << "================================================================\n";

    return 0;
}
