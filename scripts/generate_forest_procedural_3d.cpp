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
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_botanical_texture.hpp"
#include "scratchbox_infiniti.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <cmath>
#include <chrono>
#include <algorithm>

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
static const Vec4 COL_CANOPY_FOLIAGE(0.22f, 0.48f, 0.12f, 0.96f);     // High canopy foliage
static const Vec4 COL_CANOPY_SUNLIT(0.52f, 0.82f, 0.20f, 1.0f);      // SSS transmitted foliage glow
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
struct TrunkSpec {
    Vec3 basePos;
    float height;
    float baseRadius;
    float topRadius;
    int buttressLobes;
    float buttressSpread;
    float leanAngleRad;
    float leanAzimuthRad;
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

        float leanOffset = std::sin(t * 1.57f) * std::tan(spec.leanAngleRad) * (t * spec.height);
        float centerX = rootOrigin.x + leanOffset * std::cos(spec.leanAzimuthRad);
        float centerZ = rootOrigin.z + leanOffset * std::sin(spec.leanAzimuthRad);

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
    float apexLean = std::sin(1.57f) * std::tan(spec.leanAngleRad) * spec.height;
    Vec3 apexPos(
        rootOrigin.x + apexLean * std::cos(spec.leanAzimuthRad),
        rootOrigin.y + spec.height + 0.55f,
        rootOrigin.z + apexLean * std::sin(spec.leanAzimuthRad)
    );
    mesh.addVertex(Vertex(apexPos, Vec3(0, 1, 0), Vec2(0.5f, 1.0f), COL_REDWOOD_BARK));

    int topRingBase = vRings * hSectors;
    for (int sec = 0; sec < hSectors; ++sec) {
        int next = (sec + 1) % hSectors;
        mesh.addTriangle(topRingBase + sec, topRingBase + next, apexIdx);
    }

    mesh.recomputeBounds();
    return mesh;
}

inline void appendVolumetricNeedleDirect(
    ScratchboxMesh& mesh,
    const Vec3& origin,
    const Vec3& direction,
    float length,
    float baseRadius,
    float tipRadius,
    const Vec4& baseColor,
    const Vec4& tipColor
) {
    Vec3 dir = direction.normalized();
    Vec3 refUp = std::abs(dir.y) > 0.92f ? Vec3(1, 0, 0) : Vec3(0, 1, 0);
    Vec3 side = dir.cross(refUp).normalized();
    Vec3 up = side.cross(dir).normalized();

    Vec3 baseCenter = origin;
    Vec3 tipCenter = origin + dir * length;
    Vec3 apex = tipCenter + dir * (length * 0.08f);

    const int segs = 4;
    uint32_t baseIdx = static_cast<uint32_t>(mesh.vertices.size());

    for (int i = 0; i < segs; ++i) {
        float angle = (static_cast<float>(i) / static_cast<float>(segs)) * math::TWO_PI;
        Vec3 radial = side * std::cos(angle) + up * std::sin(angle);
        mesh.addVertex(Vertex(baseCenter + radial * baseRadius, radial, Vec2(0.5f, 0.5f), baseColor));
    }

    uint32_t tipIdx = static_cast<uint32_t>(mesh.vertices.size());
    for (int i = 0; i < segs; ++i) {
        float angle = (static_cast<float>(i) / static_cast<float>(segs)) * math::TWO_PI;
        Vec3 radial = side * std::cos(angle) + up * std::sin(angle);
        mesh.addVertex(Vertex(tipCenter + radial * tipRadius, radial, Vec2(0.5f, 0.5f), tipColor));
    }

    uint32_t apexIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(apex, dir, Vec2(0.5f, 0.5f), tipColor));

    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        uint32_t b0 = baseIdx + i;
        uint32_t b1 = baseIdx + next;
        uint32_t t0 = tipIdx + i;
        uint32_t t1 = tipIdx + next;

        mesh.addTriangle(b0, t0, b1);
        mesh.addTriangle(b1, t0, t1);
        mesh.addTriangle(t0, apexIdx, t1);
    }
}

// Dense Conifer Needle Fan Limb Generator
// Populates 100% independent 3D conifer needle blades along both sides of every limb
inline void appendConiferNeedleFanLimb(
    const Vec3& boughStart,
    const Vec3& boughEnd,
    const Vec3& boughDir,
    float spreadRadius,
    float profileT,
    ScratchboxMesh& outWood,
    ScratchboxMesh& outFoliage,
    bool isHero
) {
    Vec3 up(0, 1, 0);
    Vec3 side = boughDir.cross(up).normalized();
    if (side.lengthSquared() < 0.01f) side = Vec3(1, 0, 0);
    up = side.cross(boughDir).normalized();

    // 1. Main bough wood cylinder
    const int segs = 5;
    float rStart = math::lerp(0.15f, 0.06f, profileT);
    float rEnd = 0.022f;
    uint32_t bIdx = static_cast<uint32_t>(outWood.vertices.size());
    for (int i = 0; i < segs; ++i) {
        float ang = (static_cast<float>(i) / static_cast<float>(segs)) * TWO_PI;
        Vec3 radial = side * std::cos(ang) + up * std::sin(ang);
        outWood.addVertex(Vertex(boughStart + radial * rStart, radial, Vec2(0, 0), COL_REDWOOD_BARK));
        outWood.addVertex(Vertex(boughEnd + radial * rEnd, radial, Vec2(1, 1), COL_REDWOOD_BARK));
    }
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        outWood.addTriangle(bIdx + i * 2, bIdx + i * 2 + 1, bIdx + next * 2);
        outWood.addTriangle(bIdx + next * 2, bIdx + i * 2 + 1, bIdx + next * 2 + 1);
    }

    // Seal bough limb base (internal trunk anchor) and bough limb tip into closed watertight manifolds
    uint32_t startCapIdx = static_cast<uint32_t>(outWood.vertices.size());
    outWood.addVertex(Vertex(boughStart - boughDir * 0.02f, -boughDir, Vec2(0, 0), COL_REDWOOD_BARK));
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        outWood.addTriangle(startCapIdx, bIdx + next * 2, bIdx + i * 2);
    }

    uint32_t endCapIdx = static_cast<uint32_t>(outWood.vertices.size());
    outWood.addVertex(Vertex(boughEnd + boughDir * (rEnd * 0.5f), boughDir, Vec2(1, 1), COL_REDWOOD_BARK));
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        outWood.addTriangle(bIdx + i * 2 + 1, bIdx + next * 2 + 1, endCapIdx);
    }

    // 2. Lateral Conifer Branchlets & Dense Needles along the branch
    int numStations = isHero ? 7 : 5;
    for (int st = 0; st < numStations; ++st) {
        float frac = 0.20f + 0.76f * (static_cast<float>(st + 1) / static_cast<float>(numStations));
        Vec3 stationPos = math::lerp(boughStart, boughEnd, frac);

        // Emit lateral shoots on left and right
        for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
            float s = static_cast<float>(sideSign);
            float shootAngle = 1.05f + 0.15f * std::sin(st * 2.3f);
            Vec3 shootDir = (boughDir * 0.42f + side * (s * std::sin(shootAngle)) + up * 0.08f).normalized();
            float shootLen = (spreadRadius * 0.38f) * (1.15f - frac * 0.38f) * (0.85f + 0.28f * (st % 2));

            // Fine twig axis
            Vec3 shootEnd = stationPos + shootDir * shootLen;
            shootEnd.y -= shootLen * 0.12f; // Slight downward cantilever droop

            uint32_t tIdx = static_cast<uint32_t>(outFoliage.vertices.size());
            outFoliage.addVertex(Vertex(stationPos, up, Vec2(0.5f, 0.5f), COL_REDWOOD_BARK));
            outFoliage.addVertex(Vertex(shootEnd, up, Vec2(0.5f, 0.5f), COL_REDWOOD_BARK));
            outFoliage.addVertex(Vertex(shootEnd + side * 0.008f, up, Vec2(0.5f, 0.5f), COL_REDWOOD_BARK));
            outFoliage.addTriangle(tIdx, tIdx + 1, tIdx + 2);

            // Populating 10 to 14 pairs of distinct, independent conifer needles along the shoot
            int needlePairs = isHero ? 14 : 9;
            float nLenBase = 0.115f; // 11.5 cm needle length (visible, lush evergreen needle foliage)
            float nWidthBase = 0.018f; // 1.8 cm needle width

            for (int n = 0; n < needlePairs; ++n) {
                float nFrac = static_cast<float>(n + 1) / (needlePairs + 1);
                Vec3 nodePos = math::lerp(stationPos, shootEnd, nFrac);
                float curLen = nLenBase * (1.10f - nFrac * 0.32f);
                float curWidth = nWidthBase * (1.05f - nFrac * 0.28f);

                for (int nSideSign = -1; nSideSign <= 1; nSideSign += 2) {
                    float ns = static_cast<float>(nSideSign);
                    // Needle orientation: radiating outward from shoot axis with forward sweep and slight droop
                    Vec3 nDir = (shootDir * 0.32f + side * (ns * 0.90f) - up * (0.08f + 0.06f * nFrac)).normalized();

                    Vec3 p0 = nodePos;
                    Vec3 p1 = nodePos + nDir * (curLen * 0.55f) + shootDir * (curWidth * 0.5f);
                    Vec3 p2 = nodePos + nDir * curLen;
                    Vec3 p3 = nodePos + nDir * (curLen * 0.55f) - shootDir * (curWidth * 0.5f);

                    // Transferred envelope normal with upward sky bias for soft natural SSS illumination
                    Vec3 envNorm = (nDir * 0.40f + Vec3(0, 0.85f, 0)).normalized();

                    uint32_t vBase = static_cast<uint32_t>(outFoliage.vertices.size());
                    outFoliage.addVertex(Vertex(p0, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                    outFoliage.addVertex(Vertex(p1, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                    outFoliage.addVertex(Vertex(p2, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_SUNLIT));
                    outFoliage.addVertex(Vertex(p3, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));

                    outFoliage.addTriangle(vBase, vBase + 1, vBase + 2);
                    outFoliage.addTriangle(vBase, vBase + 2, vBase + 3);
                }
            }

            // Radiating pine needle fascicle (cluster of 4 needles) at shoot tip
            for (int f = 0; f < 4; ++f) {
                float fTheta = f * (TWO_PI / 4.0f);
                Vec3 fDir = (shootDir * 0.82f + side * std::cos(fTheta) * 0.45f + up * std::sin(fTheta) * 0.35f).normalized();
                appendVolumetricNeedleDirect(
                    outFoliage, shootEnd, fDir, 0.095f, 0.0055f, 0.0010f,
                    COL_CANOPY_FOLIAGE, COL_CANOPY_SUNLIT
                );
            }
        }
    }

    // 3. Terminal Fanning Conifer Needle Spray at Bough End
    for (int t = -1; t <= 1; ++t) {
        float tAngle = t * 0.38f;
        Vec3 tDir = (boughDir * 0.85f + side * std::sin(tAngle) * 0.48f + up * 0.10f).normalized();
        float tLen = 0.85f;
        Vec3 tEnd = boughEnd + tDir * tLen;

        int tipPairs = isHero ? 14 : 9;
        for (int n = 0; n < tipPairs; ++n) {
            float nFrac = static_cast<float>(n + 1) / (tipPairs + 1);
            Vec3 nodePos = math::lerp(boughEnd, tEnd, nFrac);
            float curLen = 0.12f * (1.10f - nFrac * 0.35f);
            float curWidth = 0.018f;

            for (int nSideSign = -1; nSideSign <= 1; nSideSign += 2) {
                float ns = static_cast<float>(nSideSign);
                Vec3 nDir = (tDir * 0.35f + side * (ns * 0.90f) + up * 0.05f).normalized();

                Vec3 p0 = nodePos;
                Vec3 p1 = nodePos + nDir * (curLen * 0.55f) + tDir * (curWidth * 0.5f);
                Vec3 p2 = nodePos + nDir * curLen;
                Vec3 p3 = nodePos + nDir * (curLen * 0.55f) - tDir * (curWidth * 0.5f);

                Vec3 envNorm = (nDir * 0.35f + Vec3(0, 0.88f, 0)).normalized();
                uint32_t vBase = static_cast<uint32_t>(outFoliage.vertices.size());
                outFoliage.addVertex(Vertex(p0, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                outFoliage.addVertex(Vertex(p1, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                outFoliage.addVertex(Vertex(p2, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_SUNLIT));
                outFoliage.addVertex(Vertex(p3, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));

                outFoliage.addTriangle(vBase, vBase + 1, vBase + 2);
                outFoliage.addTriangle(vBase, vBase + 2, vBase + 3);
            }
        }
    }
}

// Multi-Tier Botanical Branch Scaffold and Living Conifer Crown Generator
void appendConiferBranchesAndCrown(
    const TrunkSpec& trunkSpec,
    ScratchboxMesh& outWood,
    ScratchboxMesh& outFoliage,
    int numTiers = 10,
    float crownBaseFrac = 0.28f,
    float maxSpread = 5.2f,
    bool isHero = false
) {
    float groundY = getTerrainHeight(trunkSpec.basePos.x, trunkSpec.basePos.z);
    Vec3 rootOrigin(trunkSpec.basePos.x, groundY, trunkSpec.basePos.z);

    // 1. Lower deadwood stubs (old-growth natural self-pruned branch snags)
    int snagCount = isHero ? 4 : 2;
    for (int s = 0; s < snagCount; ++s) {
        float tSnag = 0.16f + 0.08f * (static_cast<float>(s) / snagCount);
        float lean = std::sin(tSnag * 1.57f) * std::tan(trunkSpec.leanAngleRad) * (tSnag * trunkSpec.height);
        Vec3 snagPos(
            rootOrigin.x + lean * std::cos(trunkSpec.leanAzimuthRad),
            rootOrigin.y + tSnag * trunkSpec.height,
            rootOrigin.z + lean * std::sin(trunkSpec.leanAzimuthRad)
        );
        float snagAzim = s * 2.39996f + 0.7f;
        Vec3 snagDir(std::cos(snagAzim), -0.12f, std::sin(snagAzim));
        snagDir = snagDir.normalized();
        float snagLen = 0.45f + 0.35f * (s % 2);

        Vec3 up(0, 1, 0);
        Vec3 side = snagDir.cross(up).normalized();
        up = side.cross(snagDir).normalized();
        uint32_t sIdx = static_cast<uint32_t>(outWood.vertices.size());
        Vec3 endPos = snagPos + snagDir * snagLen;
        float rStart = 0.11f, rEnd = 0.04f;
        for (int i = 0; i < 4; ++i) {
            float ang = (static_cast<float>(i) / 4.0f) * TWO_PI;
            Vec3 rad = side * std::cos(ang) + up * std::sin(ang);
            Vec4 snagCol = math::lerp(COL_REDWOOD_BARK, COL_BARK_FURROW, 0.45f);
            outWood.addVertex(Vertex(snagPos + rad * rStart, rad, Vec2(0, 0), snagCol));
            outWood.addVertex(Vertex(endPos + rad * rEnd, rad, Vec2(1, 1), snagCol));
        }
        for (int i = 0; i < 4; ++i) {
            int next = (i + 1) % 4;
            outWood.addTriangle(sIdx + i * 2, sIdx + i * 2 + 1, sIdx + next * 2);
            outWood.addTriangle(sIdx + next * 2, sIdx + i * 2 + 1, sIdx + next * 2 + 1);
        }

        // Close snag deadwood base and cut terminal cap
        uint32_t snagStartCapIdx = static_cast<uint32_t>(outWood.vertices.size());
        outWood.addVertex(Vertex(snagPos - snagDir * 0.02f, -snagDir, Vec2(0, 0), COL_REDWOOD_BARK));
        for (int i = 0; i < 4; ++i) {
            int next = (i + 1) % 4;
            outWood.addTriangle(snagStartCapIdx, sIdx + next * 2, sIdx + i * 2);
        }

        uint32_t snagEndCapIdx = static_cast<uint32_t>(outWood.vertices.size());
        outWood.addVertex(Vertex(endPos + snagDir * 0.015f, snagDir, Vec2(1, 1), math::lerp(COL_REDWOOD_BARK, COL_BARK_FURROW, 0.60f)));
        for (int i = 0; i < 4; ++i) {
            int next = (i + 1) % 4;
            outWood.addTriangle(sIdx + i * 2 + 1, sIdx + next * 2 + 1, snagEndCapIdx);
        }
    }

    // 2. Multi-tier radiating living branch limbs with dense conifer needle fronds
    for (int tier = 0; tier < numTiers; ++tier) {
        float tTier = crownBaseFrac + (0.96f - crownBaseFrac) * (static_cast<float>(tier) / static_cast<float>(numTiers));
        float profileT = (tTier - crownBaseFrac) / (1.0f - crownBaseFrac); // 0 at crown base, 1 at apex

        float lean = std::sin(tTier * 1.57f) * std::tan(trunkSpec.leanAngleRad) * (tTier * trunkSpec.height);
        Vec3 tierCenter(
            rootOrigin.x + lean * std::cos(trunkSpec.leanAzimuthRad),
            rootOrigin.y + tTier * trunkSpec.height,
            rootOrigin.z + lean * std::sin(trunkSpec.leanAzimuthRad)
        );

        // Branch count: 3 to 5 limbs per tier
        int limbsInTier = (profileT > 0.85f) ? 3 : (isHero ? 5 : 4);
        float tierAzimOffset = tier * 2.39996f; // Golden ratio spiral distribution
        float spreadRadius = maxSpread * (1.12f - 0.80f * profileT); // Full conical crown taper

        float baseElevation = (profileT < 0.35f) ? -0.05f : (profileT > 0.75f ? 0.28f : 0.08f);
        float droopAmt = (profileT < 0.50f) ? (spreadRadius * 0.22f) : (spreadRadius * 0.08f);

        for (int b = 0; b < limbsInTier; ++b) {
            float azimuth = tierAzimOffset + b * (TWO_PI / limbsInTier) + (0.12f * std::sin(b * 1.8f));
            Vec3 boughDir(std::cos(azimuth), baseElevation, std::sin(azimuth));
            boughDir = boughDir.normalized();

            Vec3 boughStart = tierCenter;
            Vec3 boughEnd = boughStart + boughDir * (spreadRadius * (0.88f + 0.24f * (b % 3)));
            boughEnd.y -= droopAmt; // Cantilever droop under gravity

            // Phototropic tip upturn
            if (profileT < 0.65f) {
                boughEnd.y += 0.16f;
            }

            // Append main limb wood cylinder and dense conifer needle fronds
            appendConiferNeedleFanLimb(
                boughStart, boughEnd, boughDir, spreadRadius, profileT,
                outWood, outFoliage, isHero
            );
        }
    }

    // 3. Spire crown terminal leader shoots pointing skyward with dense needles
    float apexLean = std::sin(1.57f) * std::tan(trunkSpec.leanAngleRad) * trunkSpec.height;
    Vec3 apexTip(
        rootOrigin.x + apexLean * std::cos(trunkSpec.leanAzimuthRad),
        rootOrigin.y + trunkSpec.height + 0.50f,
        rootOrigin.z + apexLean * std::sin(trunkSpec.leanAzimuthRad)
    );

    for (int t = 0; t < 5; ++t) {
        float tAngle = t * (TWO_PI / 5.0f);
        Vec3 shootDir(0.20f * std::cos(tAngle), 0.95f, 0.20f * std::sin(tAngle));
        shootDir = shootDir.normalized();
        Vec3 sideDir(-shootDir.z, 0, shootDir.x);
        Vec3 upDir = sideDir.cross(shootDir).normalized();

        float shootLen = 0.90f;
        Vec3 sEnd = apexTip + shootDir * shootLen;

        for (int n = 0; n < 14; ++n) {
            float nFrac = static_cast<float>(n + 1) / 15.0f;
            Vec3 nodePos = math::lerp(apexTip, sEnd, nFrac);
            float nLen = 0.12f * (1.0f - nFrac * 0.3f);
            float nWidth = 0.015f;

            for (int sign = -1; sign <= 1; sign += 2) {
                float s = static_cast<float>(sign);
                Vec3 nDir = (shootDir * 0.40f + sideDir * (s * 0.88f) + upDir * 0.15f).normalized();
                Vec3 p0 = nodePos;
                Vec3 p1 = nodePos + nDir * (nLen * 0.55f) + shootDir * (nWidth * 0.5f);
                Vec3 p2 = nodePos + nDir * nLen;
                Vec3 p3 = nodePos + nDir * (nLen * 0.55f) - shootDir * (nWidth * 0.5f);

                Vec3 envNorm = (nDir * 0.35f + Vec3(0, 0.88f, 0)).normalized();
                uint32_t vBase = static_cast<uint32_t>(outFoliage.vertices.size());
                outFoliage.addVertex(Vertex(p0, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                outFoliage.addVertex(Vertex(p1, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));
                outFoliage.addVertex(Vertex(p2, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_SUNLIT));
                outFoliage.addVertex(Vertex(p3, envNorm, Vec2(0.5f, 0.5f), COL_CANOPY_FOLIAGE));

                outFoliage.addTriangle(vBase, vBase + 1, vBase + 2);
                outFoliage.addTriangle(vBase, vBase + 2, vBase + 3);
            }
        }
    }
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
// 6. Multi-Tier Spreading Boughs & Transferred-Normal Canopy Foliage
// ============================================================================
ScratchboxMesh generateCanopyBoughs(
    const Vec3& origin,
    float spreadRadius = 5.2f,
    int numBoughs = 6,
    float baseElevation = 0.15f,
    bool droopLimb = true
) {
    ScratchboxMesh foliage("Canopy_Boughs_Foliage");
    foliage.material.name = "PBR_Canopy_Foliage";
    foliage.material.roughnessFactor = 0.52f;
    foliage.material.metallicFactor = 0.01f;
    foliage.material.doubleSided = true;
    foliage.material.alphaMode = "MASK";
    foliage.material.alphaCutoff = 0.45f;

    ScratchboxMesh wood("Canopy_Boughs_Wood");
    wood.material.name = "PBR_Redwood_Bark";

    float angleStep = TWO_PI / static_cast<float>(numBoughs);
    for (int b = 0; b < numBoughs; ++b) {
        float azimuth = b * angleStep + (0.18f * std::sin(b * 2.4f));
        float elevation = baseElevation + 0.12f * (b % 2) - (droopLimb ? 0.08f : 0.0f);

        Vec3 boughDir(std::cos(azimuth), elevation, std::sin(azimuth));
        boughDir = boughDir.normalized();

        Vec3 boughStart = origin - Vec3(0, (b % 3) * 0.4f, 0);
        Vec3 boughEnd = boughStart + boughDir * (spreadRadius * (0.88f + 0.24f * (b % 3)));
        if (droopLimb) {
            boughEnd.y -= spreadRadius * 0.22f;
        }

        appendConiferNeedleFanLimb(
            boughStart, boughEnd, boughDir, spreadRadius, 0.4f,
            wood, foliage, true
        );
    }

    foliage.merge(wood);
    foliage.recomputeBounds();
    return foliage;
}

// Understory Subcanopy Trees (Pacific Dogwoods / Hemlocks with 3D Anatomical Leaves)
ScratchboxMesh generateUnderstoryTree(const Vec3& basePos, float height = 5.5f, float spread = 3.2f) {
    ScratchboxMesh mesh("Understory_Subcanopy_Tree");
    mesh.material.name = "PBR_Canopy_Foliage";
    mesh.material.roughnessFactor = 0.58f;
    mesh.material.metallicFactor = 0.01f;
    mesh.material.doubleSided = true;
    mesh.material.alphaMode = "MASK";
    mesh.material.alphaCutoff = 0.45f;

    float gy = getTerrainHeight(basePos.x, basePos.z);
    Vec3 root(basePos.x, gy, basePos.z);
    Vec3 tip = root + Vec3(0.35f, height, -0.25f);

    const int segs = 6;
    Vec3 dir = (tip - root).normalized();
    Vec3 up(0, 1, 0);
    Vec3 side = dir.cross(up).normalized();
    up = side.cross(dir).normalized();

    uint32_t tIdx = static_cast<uint32_t>(mesh.vertices.size());
    for (int i = 0; i < segs; ++i) {
        float a = (static_cast<float>(i) / segs) * TWO_PI;
        Vec3 rad = side * std::cos(a) + up * std::sin(a);
        mesh.addVertex(Vertex(root + rad * 0.16f, rad, Vec2(0, 0), COL_REDWOOD_BARK));
        mesh.addVertex(Vertex(tip + rad * 0.05f, rad, Vec2(1, 1), COL_REDWOOD_BARK));
    }
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        mesh.addTriangle(tIdx + i * 2, tIdx + i * 2 + 1, tIdx + next * 2);
        mesh.addTriangle(tIdx + next * 2, tIdx + i * 2 + 1, tIdx + next * 2 + 1);
    }

    // Seal understory tree trunk root base and tip into a closed solid hull
    uint32_t rootCapIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(root - Vec3(0, 0.35f, 0), Vec3(0, -1, 0), Vec2(0, 0), COL_REDWOOD_BARK));
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        mesh.addTriangle(rootCapIdx, tIdx + next * 2, tIdx + i * 2);
    }

    uint32_t tipCapIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(tip + dir * 0.08f, dir, Vec2(1, 1), COL_REDWOOD_BARK));
    for (int i = 0; i < segs; ++i) {
        int next = (i + 1) % segs;
        mesh.addTriangle(tIdx + i * 2 + 1, tIdx + next * 2 + 1, tipCapIdx);
    }

    mesh.merge(generateCanopyBoughs(tip, spread, 5, 0.10f, true));

    geometry::Mesh twigs("SubcanopyTwigs");
    TwigClusterConfig twigCfg;
    twigCfg.twigLength = 0.65f;
    twigCfg.leafCount = 7;
    twigCfg.leafScale = 1.10f;
    twigCfg.phyllotaxis = PhyllotaxisPattern::GoldenSpiral137;
    twigCfg.leafConfig.outline = LeafOutline{};
    twigCfg.leafConfig.laminaCupping = 0.018f;
    twigCfg.leafConfig.midribDepth = 0.010f;
    twigCfg.leafConfig.droopCurvature = 0.024f;
    twigCfg.leafConfig.laminaColor = COL_CANOPY_FOLIAGE;
    twigCfg.leafConfig.marginColor = COL_CANOPY_SUNLIT;

    for (int b = 0; b < 6; ++b) {
        float azimuth = b * (TWO_PI / 6.0f) + 0.25f;
        Vec3 bDir = (Vec3(std::cos(azimuth), 0.15f, std::sin(azimuth))).normalized();
        Vec3 bAttach = root + Vec3(0, height * (0.45f + 0.08f * b), 0) + bDir * (spread * 0.42f);
        TwigClusterGenerator::appendTwigCluster(twigs, bAttach, bDir, twigCfg);
    }
    mesh.merge(twigs.toScratchboxMesh());

    mesh.recomputeBounds();
    return mesh;
}

// Overhanging Foreground Canopy Boughs
ScratchboxMesh generateOverhangingForegroundCanopy() {
    ScratchboxMesh foliage("Overhanging_Foreground_Canopy");
    foliage.material.name = "PBR_Canopy_Foliage";
    foliage.material.roughnessFactor = 0.52f;
    foliage.material.metallicFactor = 0.01f;
    foliage.material.doubleSided = true;
    foliage.material.alphaMode = "MASK";
    foliage.material.alphaCutoff = 0.45f;

    ScratchboxMesh wood("Overhanging_Foreground_Wood");
    wood.material.name = "PBR_Redwood_Bark";

    // 1. Left foreground framing limb dipping into view (Y = 2.4m to 3.4m, Z = 0.4m to 1.8m)
    appendConiferNeedleFanLimb(
        Vec3(-2.4f, 3.5f, 0.4f), Vec3(-0.4f, 2.5f, 1.8f), Vec3(0.85f, -0.35f, 0.50f).normalized(),
        3.2f, 0.35f, wood, foliage, true
    );
    // 2. Right foreground framing limb dipping into view
    appendConiferNeedleFanLimb(
        Vec3(3.2f, 3.6f, 0.2f), Vec3(0.5f, 2.6f, 1.6f), Vec3(-0.85f, -0.30f, 0.45f).normalized(),
        3.0f, 0.35f, wood, foliage, true
    );
    // 3. Central overhead drape
    appendConiferNeedleFanLimb(
        Vec3(-0.3f, 4.2f, 0.8f), Vec3(0.1f, 3.1f, 2.2f), Vec3(0.15f, -0.55f, 0.82f).normalized(),
        2.6f, 0.40f, wood, foliage, true
    );
    // 4. Low mid-left needle spray reaching into sunlight right above ferns
    appendConiferNeedleFanLimb(
        Vec3(-1.9f, 2.4f, 0.8f), Vec3(-0.6f, 2.0f, 1.4f), Vec3(0.90f, -0.25f, 0.35f).normalized(),
        2.2f, 0.30f, wood, foliage, true
    );
    // 5. Low mid-right needle spray
    appendConiferNeedleFanLimb(
        Vec3(2.4f, 2.6f, 0.6f), Vec3(0.9f, 2.1f, 1.2f), Vec3(-0.88f, -0.22f, 0.38f).normalized(),
        2.2f, 0.30f, wood, foliage, true
    );

    foliage.merge(wood);
    foliage.recomputeBounds();
    return foliage;
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

    // 2. Trunks & Tree Architecture Mesh Group
    ScratchboxMesh allTrunks("Forest_Trunks_And_Log");
    allTrunks.material.name = "PBR_Redwood_Bark";
    allTrunks.material.roughnessFactor = 0.92f;
    allTrunks.material.metallicFactor = 0.01f;

    // Canopy Foliage Mesh Group
    ScratchboxMesh allFoliage("Forest_Canopy_Foliage");
    allFoliage.material.name = "PBR_Canopy_Foliage";
    allFoliage.material.roughnessFactor = 0.58f;
    allFoliage.material.metallicFactor = 0.01f;
    allFoliage.material.doubleSided = true;
    allFoliage.material.alphaMode = "MASK";
    allFoliage.material.alphaCutoff = 0.45f;

    std::cout << "🌳 Generating Hero Ancient Redwood & Oak Trunks across Ecological Groves...\n";

    // A. HERO FOREGROUND CORRIDOR (Framed for 1:1 National Geographic Alignment)

    // 1. The Monumental Monarch (Hero Ancient Redwood occupying center-right of frame at X = 0.95m, Z = -2.1m)
    TrunkSpec heroMonarch;
    heroMonarch.basePos = Vec3(0.95f, 0.0f, -2.1f);
    heroMonarch.height = 36.0f;
    heroMonarch.baseRadius = 1.95f;
    heroMonarch.topRadius = 0.88f;
    heroMonarch.buttressLobes = 10;
    heroMonarch.buttressSpread = 1.85f;
    heroMonarch.leanAngleRad = 1.2f * DEG_TO_RAD;
    heroMonarch.leanAzimuthRad = -35.0f * DEG_TO_RAD;
    heroMonarch.hasHeroMoss = true;
    heroMonarch.furrowDepth = 1.55f;
    allTrunks.merge(generateProceduralTrunk(heroMonarch));
    appendConiferBranchesAndCrown(heroMonarch, allTrunks, allFoliage, 18, 0.06f, 6.5f, true);

    // Root buttress runners grounding the Monarch into the humus
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3(-0.4f, 0, -0.6f), 0.42f, 0.10f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 2.3f, 0, -0.8f), 0.38f, 0.09f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 0.2f, 0, -4.2f), 0.35f, 0.08f));
    allTrunks.merge(generateSurfaceRootRunner(Vec3(0.95f, 0, -2.1f), Vec3( 2.4f, 0, -3.8f), 0.32f, 0.07f));

    // 2. Left Sun-Facing Tree (Reaching into sunbeams with low graceful boughs)
    TrunkSpec leftSunBoughTree;
    leftSunBoughTree.basePos = Vec3(-1.85f, 0.0f, -4.5f);
    leftSunBoughTree.height = 29.0f;
    leftSunBoughTree.baseRadius = 1.15f;
    leftSunBoughTree.topRadius = 0.58f;
    leftSunBoughTree.buttressLobes = 6;
    leftSunBoughTree.buttressSpread = 1.15f;
    leftSunBoughTree.leanAngleRad = 1.5f * DEG_TO_RAD;
    leftSunBoughTree.leanAzimuthRad = 45.0f * DEG_TO_RAD;
    leftSunBoughTree.hasHeroMoss = true;
    leftSunBoughTree.furrowDepth = 1.25f;
    allTrunks.merge(generateProceduralTrunk(leftSunBoughTree));
    appendConiferBranchesAndCrown(leftSunBoughTree, allTrunks, allFoliage, 16, 0.05f, 5.4f, true);

    // 3. Mid-Left Receding Tree 1
    TrunkSpec midLeft1;
    midLeft1.basePos = Vec3(-3.2f, 0.0f, -6.5f);
    midLeft1.height = 28.0f;
    midLeft1.baseRadius = 0.95f;
    midLeft1.topRadius = 0.50f;
    midLeft1.buttressLobes = 5;
    midLeft1.buttressSpread = 0.85f;
    midLeft1.leanAngleRad = 1.2f * DEG_TO_RAD;
    midLeft1.leanAzimuthRad = 30.0f * DEG_TO_RAD;
    midLeft1.hasHeroMoss = true;
    midLeft1.furrowDepth = 1.10f;
    allTrunks.merge(generateProceduralTrunk(midLeft1));
    appendConiferBranchesAndCrown(midLeft1, allTrunks, allFoliage, 14, 0.06f, 4.8f, true);

    // 4. Far-Left Framing Redwood (Hugging left edge at X = -4.8m, Z = -0.5m)
    TrunkSpec farLeft;
    farLeft.basePos = Vec3(-4.8f, 0.0f, -0.5f);
    farLeft.height = 30.0f;
    farLeft.baseRadius = 1.40f;
    farLeft.topRadius = 0.70f;
    farLeft.buttressLobes = 7;
    farLeft.buttressSpread = 1.25f;
    farLeft.leanAngleRad = 1.8f * DEG_TO_RAD;
    farLeft.leanAzimuthRad = 85.0f * DEG_TO_RAD;
    farLeft.hasHeroMoss = true;
    farLeft.furrowDepth = 1.20f;
    allTrunks.merge(generateProceduralTrunk(farLeft));
    appendConiferBranchesAndCrown(farLeft, allTrunks, allFoliage, 16, 0.065f, 5.5f, true);

    // 5. Far-Right Foreground Framing Redwood (X = 4.8f, Z = 0.5f)
    TrunkSpec farRight;
    farRight.basePos = Vec3(4.8f, 0.0f, 0.5f);
    farRight.height = 30.0f;
    farRight.baseRadius = 1.45f;
    farRight.topRadius = 0.72f;
    farRight.buttressLobes = 7;
    farRight.buttressSpread = 1.20f;
    farRight.leanAngleRad = 2.2f * DEG_TO_RAD;
    farRight.leanAzimuthRad = -110.0f * DEG_TO_RAD;
    farRight.hasHeroMoss = true;
    farRight.furrowDepth = 1.20f;
    allTrunks.merge(generateProceduralTrunk(farRight));
    appendConiferBranchesAndCrown(farRight, allTrunks, allFoliage, 16, 0.065f, 5.5f, true);

    // B. EXPANSIVE WEST & EAST GROVES AND DEEP COLONNADE (Spreading across 80m x 70m)
    std::cout << "🌲 Constructing Distributed Forest Groves across the Landscape...\n";
    std::vector<TrunkSpec> landscapeTrees = {
        // West Grove (Spreading out to X = -35)
        { Vec3( -8.5f, 0.0f,   2.5f), 28.0f, 0.95f, 0.55f, 5, 0.85f, 1.4f * DEG_TO_RAD,  60.0f * DEG_TO_RAD, true, 1.05f },
        { Vec3(-11.5f, 0.0f,  -3.5f), 27.0f, 0.85f, 0.48f, 5, 0.75f, 1.2f * DEG_TO_RAD,  45.0f * DEG_TO_RAD, true, 0.95f },
        { Vec3(-15.0f, 0.0f,   1.0f), 28.0f, 0.90f, 0.52f, 4, 0.80f, 1.8f * DEG_TO_RAD,  70.0f * DEG_TO_RAD, true, 1.00f },
        { Vec3(-18.5f, 0.0f,  -6.5f), 26.0f, 0.78f, 0.45f, 4, 0.70f, 1.0f * DEG_TO_RAD,  30.0f * DEG_TO_RAD, true, 0.90f },
        { Vec3(-14.0f, 0.0f, -12.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, 1.5f * DEG_TO_RAD,  55.0f * DEG_TO_RAD, true, 0.95f },
        { Vec3(-22.0f, 0.0f, -10.5f), 25.0f, 0.75f, 0.42f, 3, 0.65f, 2.0f * DEG_TO_RAD,  85.0f * DEG_TO_RAD, false, 0.85f },
        { Vec3(-27.0f, 0.0f, -15.0f), 26.0f, 0.80f, 0.45f, 3, 0.70f, 1.2f * DEG_TO_RAD,  40.0f * DEG_TO_RAD, false, 0.85f },
        { Vec3(-19.5f, 0.0f, -20.0f), 25.0f, 0.74f, 0.42f, 3, 0.65f, 1.4f * DEG_TO_RAD,  60.0f * DEG_TO_RAD, false, 0.80f },
        { Vec3(-25.5f, 0.0f, -25.5f), 24.0f, 0.70f, 0.40f, 3, 0.60f, 1.6f * DEG_TO_RAD,  75.0f * DEG_TO_RAD, false, 0.80f },
        { Vec3(-16.0f, 0.0f, -29.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, 1.1f * DEG_TO_RAD,  35.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3(-31.0f, 0.0f, -22.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, 1.8f * DEG_TO_RAD,  90.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3(-28.0f, 0.0f, -35.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, 1.2f * DEG_TO_RAD,  50.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3(-20.0f, 0.0f, -39.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, 1.0f * DEG_TO_RAD,  20.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3(-35.0f, 0.0f, -30.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, 1.5f * DEG_TO_RAD,  80.0f * DEG_TO_RAD, false, 0.65f },

        // East Grove (Spreading out to X = +35)
        { Vec3(  8.0f, 0.0f,   3.0f), 28.0f, 0.92f, 0.54f, 5, 0.80f, 1.6f * DEG_TO_RAD, -60.0f * DEG_TO_RAD, true, 1.00f },
        { Vec3( 12.0f, 0.0f,  -1.5f), 27.0f, 0.88f, 0.50f, 5, 0.75f, 1.4f * DEG_TO_RAD, -45.0f * DEG_TO_RAD, true, 0.95f },
        { Vec3( 16.5f, 0.0f,   2.5f), 28.0f, 0.90f, 0.52f, 4, 0.80f, 1.8f * DEG_TO_RAD, -75.0f * DEG_TO_RAD, true, 0.95f },
        { Vec3( 14.5f, 0.0f,  -6.5f), 26.0f, 0.80f, 0.45f, 4, 0.70f, 1.2f * DEG_TO_RAD, -30.0f * DEG_TO_RAD, true, 0.90f },
        { Vec3( 10.5f, 0.0f, -11.0f), 27.0f, 0.82f, 0.46f, 4, 0.75f, 1.5f * DEG_TO_RAD, -55.0f * DEG_TO_RAD, true, 0.95f },
        { Vec3( 18.5f, 0.0f, -10.0f), 25.0f, 0.76f, 0.42f, 3, 0.65f, 2.0f * DEG_TO_RAD, -80.0f * DEG_TO_RAD, false, 0.85f },
        { Vec3( 23.0f, 0.0f, -14.5f), 26.0f, 0.78f, 0.44f, 3, 0.70f, 1.5f * DEG_TO_RAD, -65.0f * DEG_TO_RAD, false, 0.85f },
        { Vec3( 15.5f, 0.0f, -18.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, 1.1f * DEG_TO_RAD, -40.0f * DEG_TO_RAD, false, 0.80f },
        { Vec3( 27.0f, 0.0f, -20.0f), 24.0f, 0.70f, 0.38f, 3, 0.60f, 1.8f * DEG_TO_RAD, -85.0f * DEG_TO_RAD, false, 0.80f },
        { Vec3( 21.0f, 0.0f, -26.0f), 25.0f, 0.72f, 0.40f, 3, 0.65f, 1.3f * DEG_TO_RAD, -50.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3( 17.0f, 0.0f, -31.0f), 24.0f, 0.68f, 0.38f, 0, 0.00f, 1.0f * DEG_TO_RAD, -30.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3( 29.0f, 0.0f, -29.0f), 25.0f, 0.70f, 0.40f, 0, 0.00f, 1.6f * DEG_TO_RAD, -70.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3( 24.0f, 0.0f, -37.0f), 24.0f, 0.66f, 0.36f, 0, 0.00f, 1.2f * DEG_TO_RAD, -45.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3( 33.0f, 0.0f, -25.0f), 23.0f, 0.64f, 0.35f, 0, 0.00f, 1.7f * DEG_TO_RAD, -85.0f * DEG_TO_RAD, false, 0.65f },

        // North & Deep Background Colonnade (Z from -10 to -48 across clearing depth)
        { Vec3( -1.8f, 0.0f, -12.5f), 26.0f, 0.68f, 0.40f, 3, 0.55f, 1.2f * DEG_TO_RAD,  20.0f * DEG_TO_RAD, true, 0.85f },
        { Vec3(  3.2f, 0.0f, -14.5f), 25.0f, 0.65f, 0.38f, 3, 0.50f, 1.5f * DEG_TO_RAD, -35.0f * DEG_TO_RAD, true, 0.85f },
        { Vec3( -4.5f, 0.0f, -16.5f), 26.0f, 0.66f, 0.38f, 3, 0.50f, 1.4f * DEG_TO_RAD,  30.0f * DEG_TO_RAD, true, 0.80f },
        { Vec3(  1.5f, 0.0f, -18.5f), 25.0f, 0.62f, 0.36f, 3, 0.45f, 1.0f * DEG_TO_RAD, -15.0f * DEG_TO_RAD, true, 0.80f },
        { Vec3( -3.0f, 0.0f, -22.5f), 25.0f, 0.60f, 0.35f, 0, 0.00f, 1.2f * DEG_TO_RAD,  25.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3(  3.8f, 0.0f, -25.0f), 24.0f, 0.58f, 0.34f, 0, 0.00f, 1.4f * DEG_TO_RAD, -40.0f * DEG_TO_RAD, false, 0.75f },
        { Vec3( -0.5f, 0.0f, -28.5f), 25.0f, 0.56f, 0.32f, 0, 0.00f, 0.9f * DEG_TO_RAD,  10.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3(  2.4f, 0.0f, -33.0f), 24.0f, 0.54f, 0.30f, 0, 0.00f, 1.1f * DEG_TO_RAD, -25.0f * DEG_TO_RAD, false, 0.70f },
        { Vec3( -4.8f, 0.0f, -37.5f), 25.0f, 0.55f, 0.30f, 0, 0.00f, 1.3f * DEG_TO_RAD,  30.0f * DEG_TO_RAD, false, 0.65f },
        { Vec3(  1.2f, 0.0f, -43.0f), 24.0f, 0.50f, 0.28f, 0, 0.00f, 0.8f * DEG_TO_RAD, -10.0f * DEG_TO_RAD, false, 0.65f },
        { Vec3( -2.0f, 0.0f, -47.0f), 24.0f, 0.48f, 0.26f, 0, 0.00f, 0.7f * DEG_TO_RAD,   5.0f * DEG_TO_RAD, false, 0.60f },
        { Vec3(  4.5f, 0.0f, -48.0f), 23.0f, 0.46f, 0.25f, 0, 0.00f, 1.2f * DEG_TO_RAD, -30.0f * DEG_TO_RAD, false, 0.60f }
    };

    for (size_t i = 0; i < landscapeTrees.size(); ++i) {
        allTrunks.merge(generateProceduralTrunk(landscapeTrees[i]));
        float spread = 3.6f + 1.2f * (static_cast<float>(i % 4) / 3.0f);
        int tiers = 8 + (i % 3);
        appendConiferBranchesAndCrown(landscapeTrees[i], allTrunks, allFoliage, tiers, 0.09f, spread, false);
    }

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

    // 5. Understory Subcanopy Trees & Overhanging Archway
    std::cout << "🌲 Sprouting Understory Subcanopy Trees...\n";
    allFoliage.merge(generateUnderstoryTree(Vec3(-1.2f, 0, -4.5f), 5.4f, 3.2f));
    allFoliage.merge(generateUnderstoryTree(Vec3( 1.5f, 0, -5.2f), 5.2f, 3.0f));
    allFoliage.merge(generateUnderstoryTree(Vec3(-3.2f, 0, -8.0f), 5.8f, 3.5f));
    allFoliage.merge(generateUnderstoryTree(Vec3( 2.4f, 0, -9.5f), 5.5f, 3.4f));

    std::cout << "🌿 Weaving Overhanging Foreground Canopy Archway...\n";
    allFoliage.merge(generateOverhangingForegroundCanopy());

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
        float radius = (f < 6) ? 2.35f : ((f < 12) ? 1.85f : 1.45f);
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
        float rad = 1.35f * sf.scale;
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

    // 9. Assemble Discrete Multi-Mesh Array for GlbWriter
    std::vector<ScratchboxMesh> subMeshes = {
        floor,          // Index 0: PBR_Forest_Floor
        allTrunks,      // Index 1: PBR_Redwood_Bark
        allFoliage,     // Index 2: PBR_Canopy_Foliage
        allFerns,       // Index 3: PBR_Sword_Ferns
        allUnderstory,  // Index 4: PBR_Woodland_Undergrowth
        godRays         // Index 5: PBR_Volumetric_GodRays
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

    // 10. Embed Authentic Photo-Derived PBR Texture Maps into GLB
    std::cout << "\n🎨 Embedding Photo-Derived PBR Texture Maps into glTF Materials...\n";
    std::vector<io::EmbeddedTexture> remappedTextures;

    auto addPhotoTexture = [&](const std::string& filename, io::TextureUsage usage, int matIdx) {
        std::string fullPath = "public/textures/" + filename;
        auto bytes = loadPngFile(fullPath);
        if (!bytes.empty()) {
            io::EmbeddedTexture t;
            t.name = filename;
            t.mimeType = "image/png";
            t.data = std::move(bytes);
            t.usage = usage;
            t.materialIndex = matIdx;
            remappedTextures.push_back(t);
            std::cout << "   ✅ Embedded " << filename << " into Material " << matIdx << " (" << t.data.size() << " bytes)\n";
        }
    };

    // Material 0: PBR_Forest_Floor
    addPhotoTexture("photo_forest_floor_albedo.png", io::TextureUsage::BASE_COLOR, 0);
    addPhotoTexture("photo_forest_floor_normal.png", io::TextureUsage::NORMAL, 0);
    addPhotoTexture("photo_forest_floor_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, 0);

    // Material 1: PBR_Redwood_Bark
    addPhotoTexture("photo_redwood_bark_albedo.png", io::TextureUsage::BASE_COLOR, 1);
    addPhotoTexture("photo_redwood_bark_normal.png", io::TextureUsage::NORMAL, 1);
    addPhotoTexture("photo_redwood_bark_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, 1);

    // Material 2: PBR_Canopy_Foliage
    addPhotoTexture("photo_canopy_albedo.png", io::TextureUsage::BASE_COLOR, 2);
    addPhotoTexture("photo_canopy_normal.png", io::TextureUsage::NORMAL, 2);
    addPhotoTexture("photo_canopy_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, 2);

    // Material 3: PBR_Sword_Ferns
    addPhotoTexture("photo_fern_albedo.png", io::TextureUsage::BASE_COLOR, 3);
    addPhotoTexture("photo_fern_normal.png", io::TextureUsage::NORMAL, 3);
    addPhotoTexture("photo_fern_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, 3);

    // Material 4: PBR_Woodland_Undergrowth
    addPhotoTexture("photo_moss_albedo.png", io::TextureUsage::BASE_COLOR, 4);
    addPhotoTexture("photo_moss_normal.png", io::TextureUsage::NORMAL, 4);
    addPhotoTexture("photo_moss_orm.png", io::TextureUsage::METALLIC_ROUGHNESS, 4);

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

    std::ofstream outFile(outputPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "❌ Fatal: Could not open output file " << outputPath << "\n";
        return 1;
    }

    outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    outFile.close();

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "✅ Successfully Exported: " << outputPath << " (" << glbData.size() << " bytes)\n";
    std::cout << "⏱️ Procedural Forest Generation Completed in " << ms << " ms.\n";
    std::cout << "================================================================\n";

    return 0;
}
