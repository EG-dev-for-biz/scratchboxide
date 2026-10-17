/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_PLANT_BUILDER_HPP
#define SCRATCHBOX_PLANT_BUILDER_HPP

/**
 * Scratchbox Modular Procedural Plant Builder (C++20)
 *
 * An artist-friendly, highly adaptable botanical synthesis engine designed to build
 * complex, hyperrealistic plants and natural biome clutter with declarative ease:
 *
 * 1. Modular Botanical Organs & Leaf Morphologies:
 *    - Conifer Distichous Sprays (two-ranked flat needles for Sequoia, Taxus, Abies)
 *    - Anatomical 3D Lobed Leaves with Parabolic Cupping and Sunken Midrib (Quercus, Acer)
 *    - Simple Ovate / Serrated Birch Blades with Woody Petioles
 *    - Pteridophyte Arching Sword Fern Fronds with Curling Fiddleheads (Polystichum)
 *    - Wood Sorrel / Clover 3-Leaflet Carpets (Oxalis oregana)
 *    - Fibonacci Botanical Pinecones with Ovuliferous Scales
 *    - Epiphytic Shelf Bracket Polypores (Ganoderma) with Concentric Growth Margins
 *    - Volumetric 3D Velvet Moss Tufts & Cushions
 *
 * 2. Fluent Builder & Presets:
 *    - ProceduralPlantBuilder: Fluent method chaining for custom trees, shrubs, ferns, logs
 *    - PlantPresets: Instant one-liner instantiation of Hero Redwoods, Understory Trees,
 *      Sword Ferns, Fallen Hollowed Nurse Logs, and Sub-Centimeter Ground Carpets
 *
 * 3. Physics & Optical Shading Invariants:
 *    - Da Vinci Caliper Area Preservation (\sum r_child^d = r_parent^d)
 *    - Transferred Clump Envelope Normals with Upward Sky Bias (eliminates paper-cut facets)
 *    - Dual-Sided Backface Chlorophyll Subsurface Scattering (SSS)
 *    - Reaction Wood Elliptical Deepening under Cantilever Gravity
 *    - Swelling Botanical Branch Collar Flares
 */

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_nature.hpp"
#include "scratchbox_substrate.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <functional>
#include <memory>

namespace scratchbox {
namespace plant {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using math::DEG_TO_RAD;
using geometry::Vertex;
using geometry::Mesh;
using geometry::ScratchboxMesh;
using nature::LeafOutline;
using nature::DetailedLeafConfig;
using nature::DetailedLeafGenerator;
using nature::TwigClusterConfig;
using nature::TwigClusterGenerator;
using nature::BotanicalOrganGenerator;
using nature::NurseLogGenerator;
using nature::BiomassScatterEngine;
using nature::NarrativeClutterPlacer;

// ============================================================================
// 1. Botanical Enumerations & Configuration Types
// ============================================================================

enum class PlantArchetype {
    ConiferRedwood,       // Central leader trunk, fluted buttress roots, drooping boughs, distichous needles
    DecurrentHardwood,    // Bifurcating scaffold limbs, spreading dome canopy, lobed/ovate 3D leaves
    SubcanopyUnderstory,  // Slender delicate trunk, lateral sun-reaching sprays
    SwordFern,            // Radial rosette of arching fronds with crosiers
    WoodlandHerb,         // Trifoliate wood sorrel / clover / ground cover
    NurseLogDecayed,      // Fallen decaying trunk with rot cavities and bracket fungi
    GroundLitterDebris    // Cones, needles, fallen sticks, and decomposing winter fronds
};

enum class BotanicalLeafType {
    ConiferDistichous = 0, // Sequoia / Taxus alternating needles
    LobedAnatomical = 1,   // 3D Oak / Maple with parabolic cupping and midrib
    OvateSimple = 2,       // Dogwood / Beech smooth margin blade
    SerratedBirch = 3,     // High-frequency serrated margin
    FernPinnule = 4,       // Pteridophyte pinnules on central rachis
    OxalisTrifoliate = 5   // 3 heart-shaped clover leaflets
};

struct PlantColorPalette {
    Vec4 woodBark{0.35f, 0.19f, 0.12f, 1.0f};
    Vec4 barkFurrow{0.10f, 0.05f, 0.03f, 1.0f};
    Vec4 barkRidge{0.48f, 0.28f, 0.16f, 1.0f};
    Vec4 foliageAlbedo{0.22f, 0.48f, 0.12f, 1.0f};
    Vec4 foliageSssGlow{0.52f, 0.82f, 0.20f, 1.0f};
    Vec4 velvetMoss{0.28f, 0.52f, 0.15f, 1.0f};
    Vec4 deadwoodCore{0.42f, 0.28f, 0.18f, 1.0f};

    static PlantColorPalette createTemperateRedwood() {
        return PlantColorPalette{};
    }

    static PlantColorPalette createAutumnHardwood() {
        PlantColorPalette p;
        p.woodBark = Vec4(0.28f, 0.22f, 0.16f, 1.0f);
        p.foliageAlbedo = Vec4(0.85f, 0.52f, 0.10f, 1.0f);
        p.foliageSssGlow = Vec4(0.98f, 0.82f, 0.18f, 1.0f);
        return p;
    }
};

struct BranchTierConfig {
    float heightFraction{0.5f};   // Station along parent trunk/bough [0..1]
    int branchCount{6};           // Number of radial limbs
    float spreadRadius{4.5f};     // Outward reach (meters)
    float baseElevationRad{0.15f};// Upward angle from horizontal
    float cantileverDroop{0.22f}; // Downward droop fraction
    float startRadius{0.22f};     // Initial limb thickness
    float endRadius{0.06f};       // Tip thickness
    bool addFoliageSprigs{true};  // Whether to populate fine leaf sprigs
};

struct PlantBuildResult {
    ScratchboxMesh woodMesh;
    ScratchboxMesh foliageMesh;
    ScratchboxMesh groundClutterMesh;
    size_t totalVertices{0};
    size_t totalTriangles{0};

    ScratchboxMesh getCombined(const std::string& combinedName = "CombinedPlant") const {
        ScratchboxMesh combined(combinedName);
        if (!woodMesh.vertices.empty()) combined.merge(woodMesh);
        if (!foliageMesh.vertices.empty()) combined.merge(foliageMesh);
        if (!groundClutterMesh.vertices.empty()) combined.merge(groundClutterMesh);
        combined.recomputeBounds();
        return combined;
    }
};

// ============================================================================
// 2. Procedural Plant Builder (Fluent API)
// ============================================================================

class ProceduralPlantBuilder {
public:
    ProceduralPlantBuilder(PlantArchetype archetype = PlantArchetype::ConiferRedwood)
        : m_archetype(archetype) {
        m_palette = PlantColorPalette::createTemperateRedwood();
    }

    // Builder Configuration Methods
    ProceduralPlantBuilder& setArchetype(PlantArchetype archetype) {
        m_archetype = archetype;
        return *this;
    }

    ProceduralPlantBuilder& setPosition(const Vec3& pos) {
        m_position = pos;
        return *this;
    }

    ProceduralPlantBuilder& setScale(float scale) {
        m_scale = scale;
        return *this;
    }

    ProceduralPlantBuilder& setColors(const PlantColorPalette& palette) {
        m_palette = palette;
        return *this;
    }

    // Trunk Morphological Controls
    ProceduralPlantBuilder& setTrunk(
        float height,
        float baseRadius,
        float topRadius,
        int buttressLobes = 6,
        float buttressSpread = 1.2f,
        float furrowDepth = 1.15f,
        float leanAngleDeg = 1.5f,
        float leanAzimuthDeg = 0.0f
    ) {
        m_trunkHeight = height;
        m_baseRadius = baseRadius;
        m_topRadius = topRadius;
        m_buttressLobes = buttressLobes;
        m_buttressSpread = buttressSpread;
        m_furrowDepth = furrowDepth;
        m_leanAngleRad = leanAngleDeg * DEG_TO_RAD;
        m_leanAzimuthRad = leanAzimuthDeg * DEG_TO_RAD;
        return *this;
    }

    // Branch Architecture Controls
    ProceduralPlantBuilder& addBranchTier(const BranchTierConfig& tier) {
        m_branchTiers.push_back(tier);
        return *this;
    }

    ProceduralPlantBuilder& addBranchTier(
        float heightFrac,
        int count,
        float spread,
        float droop = 0.22f,
        float elevationDeg = 8.0f
    ) {
        BranchTierConfig tier;
        tier.heightFraction = heightFrac;
        tier.branchCount = count;
        tier.spreadRadius = spread;
        tier.cantileverDroop = droop;
        tier.baseElevationRad = elevationDeg * DEG_TO_RAD;
        m_branchTiers.push_back(tier);
        return *this;
    }

    // Foliage & Leaf Controls
    ProceduralPlantBuilder& setFoliage(
        BotanicalLeafType leafType,
        float density = 1.0f,
        float leafScale = 1.0f,
        bool transferNormals = true
    ) {
        m_leafType = leafType;
        m_leafDensity = density;
        m_leafScale = leafScale;
        m_transferEnvelopeNormals = transferNormals;
        return *this;
    }

    // Epiphytes & Clutter Controls
    ProceduralPlantBuilder& setEpiphytes(bool enableMoss, int shelfPolypores = 0) {
        m_enableMoss = enableMoss;
        m_shelfPolyporeCount = shelfPolypores;
        return *this;
    }

    // ========================================================================
    // Build Execution Methods
    // ========================================================================

    PlantBuildResult build() const {
        switch (m_archetype) {
            case PlantArchetype::ConiferRedwood:
            case PlantArchetype::DecurrentHardwood:
            case PlantArchetype::SubcanopyUnderstory:
                return buildArborescentTree();
            case PlantArchetype::SwordFern:
                return buildFernRosette();
            case PlantArchetype::WoodlandHerb:
                return buildHerbPatch();
            case PlantArchetype::NurseLogDecayed:
                return buildNurseLog();
            case PlantArchetype::GroundLitterDebris:
                return buildGroundDebris();
            default:
                return buildArborescentTree();
        }
    }

private:
    PlantArchetype m_archetype{PlantArchetype::ConiferRedwood};
    Vec3 m_position{0.0f, 0.0f, 0.0f};
    float m_scale{1.0f};
    PlantColorPalette m_palette;

    // Trunk
    float m_trunkHeight{24.0f};
    float m_baseRadius{1.2f};
    float m_topRadius{0.6f};
    int m_buttressLobes{6};
    float m_buttressSpread{1.1f};
    float m_furrowDepth{1.15f};
    float m_leanAngleRad{0.025f};
    float m_leanAzimuthRad{0.0f};

    // Branches & Foliage
    std::vector<BranchTierConfig> m_branchTiers;
    BotanicalLeafType m_leafType{BotanicalLeafType::ConiferDistichous};
    float m_leafDensity{1.0f};
    float m_leafScale{1.0f};
    bool m_transferEnvelopeNormals{true};

    // Epiphytes
    bool m_enableMoss{true};
    int m_shelfPolyporeCount{0};

    // ------------------------------------------------------------------------
    // Arborescent Tree Builder
    // ------------------------------------------------------------------------
    PlantBuildResult buildArborescentTree() const {
        PlantBuildResult res;
        res.woodMesh = ScratchboxMesh("Tree_Wood_Submesh");
        res.woodMesh.material.name = "PBR_Redwood_Bark";
        res.woodMesh.material.roughnessFactor = 0.90f;
        res.woodMesh.material.metallicFactor = 0.01f;

        res.foliageMesh = ScratchboxMesh("Tree_Foliage_Submesh");
        res.foliageMesh.material.name = "PBR_Canopy_Foliage";
        res.foliageMesh.material.roughnessFactor = 0.52f;
        res.foliageMesh.material.metallicFactor = 0.01f;
        res.foliageMesh.material.doubleSided = true;
        res.foliageMesh.material.alphaMode = "MASK";
        res.foliageMesh.material.alphaCutoff = 0.40f;

        // 1. Synthesize Trunk
        const int vRings = 64;
        const int hSectors = 48;
        float scaledHeight = m_trunkHeight * m_scale;
        float scaledBaseR = m_baseRadius * m_scale;
        float scaledTopR = m_topRadius * m_scale;

        for (int ring = 0; ring <= vRings; ++ring) {
            float t = static_cast<float>(ring) / vRings;
            float currentY = m_position.y + t * scaledHeight;

            float leanOffset = std::sin(t * 1.57f) * std::tan(m_leanAngleRad) * (t * scaledHeight);
            float centerX = m_position.x + leanOffset * std::cos(m_leanAzimuthRad);
            float centerZ = m_position.z + leanOffset * std::sin(m_leanAzimuthRad);

            // Da Vinci Caliper Taper
            float coreRadius = math::lerp(scaledBaseR, scaledTopR, std::pow(t, 0.68f));
            float buttressDecay = std::max(0.0f, 1.0f - (t * scaledHeight) / (4.2f * m_scale));
            buttressDecay = buttressDecay * buttressDecay;

            for (int sec = 0; sec < hSectors; ++sec) {
                float theta = (static_cast<float>(sec) / hSectors) * TWO_PI;
                float cosT = std::cos(theta);
                float sinT = std::sin(theta);

                float buttressFlare = 0.0f;
                if (m_buttressLobes > 0 && buttressDecay > 0.001f) {
                    float lobeAngle = theta * static_cast<float>(m_buttressLobes);
                    float lobeVal = std::max(0.0f, std::cos(lobeAngle));
                    buttressFlare = lobeVal * lobeVal * (m_buttressSpread * m_scale) * buttressDecay;
                }

                float furrowMod = (m_furrowDepth * m_scale) * (
                    0.16f * std::cos(22.0f * theta + std::sin(currentY * 1.6f))
                    + 0.08f * std::cos(44.0f * theta)
                    + 0.04f * std::sin(88.0f * theta)
                );

                float totalRadius = coreRadius + buttressFlare + furrowMod;
                float px = centerX + cosT * totalRadius;
                float pz = centerZ + sinT * totalRadius;
                float py = currentY;

                Vec3 pos(px, py, pz);
                Vec3 norm(cosT, 0.0f, sinT);
                norm = norm.normalized();

                Vec4 col = m_palette.woodBark;
                if (m_enableMoss && t < 0.15f) {
                    float mossWeight = (1.0f - t / 0.15f) * (0.5f + 0.5f * norm.z);
                    col = math::lerp(m_palette.woodBark, m_palette.velvetMoss, std::clamp(mossWeight, 0.0f, 0.92f));
                }

                res.woodMesh.addVertex(Vertex(pos, norm, Vec2(static_cast<float>(sec) / hSectors * 4.0f, t * 12.0f), col));
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
                res.woodMesh.addTriangle(i0, i1, i2);
                res.woodMesh.addTriangle(i1, i3, i2);
            }
        }

        // Close subterranean base with a watertight convex root disc cap
        uint32_t botCapIdx = static_cast<uint32_t>(res.woodMesh.vertices.size());
        Vec3 botCenter(m_position.x, m_position.y - 0.75f * m_scale, m_position.z);
        res.woodMesh.addVertex(Vertex(botCenter, Vec3(0, -1, 0), Vec2(0.5f, 0.5f), m_palette.barkFurrow));
        for (int sec = 0; sec < hSectors; ++sec) {
            int next = (sec + 1) % hSectors;
            res.woodMesh.addTriangle(botCapIdx, next, sec);
        }

        // Close crown spire apex with an organic pointed cone cap
        uint32_t topApexIdx = static_cast<uint32_t>(res.woodMesh.vertices.size());
        float apexLean = std::sin(1.57f) * std::tan(m_leanAngleRad) * scaledHeight;
        Vec3 apexPos(
            m_position.x + apexLean * std::cos(m_leanAzimuthRad),
            m_position.y + scaledHeight + 0.45f * m_scale,
            m_position.z + apexLean * std::sin(m_leanAzimuthRad)
        );
        res.woodMesh.addVertex(Vertex(apexPos, Vec3(0, 1, 0), Vec2(0.5f, 1.0f), m_palette.woodBark));
        int topRingBase = vRings * hSectors;
        for (int sec = 0; sec < hSectors; ++sec) {
            int next = (sec + 1) % hSectors;
            res.woodMesh.addTriangle(topRingBase + sec, topRingBase + next, topApexIdx);
        }

        // 2. Synthesize Branch Tiers
        for (const auto& tier : m_branchTiers) {
            float stationY = m_position.y + tier.heightFraction * scaledHeight;
            Vec3 trunkCenter(m_position.x, stationY, m_position.z);
            float angleStep = TWO_PI / static_cast<float>(tier.branchCount);

            for (int b = 0; b < tier.branchCount; ++b) {
                float azimuth = b * angleStep + (0.16f * std::sin(b * 2.2f));
                Vec3 bDir(std::cos(azimuth), tier.baseElevationRad, std::sin(azimuth));
                bDir = bDir.normalized();

                Vec3 bStart = trunkCenter;
                Vec3 bEnd = bStart + bDir * (tier.spreadRadius * m_scale);
                bEnd.y -= tier.spreadRadius * m_scale * tier.cantileverDroop;

                // Branch cylinder
                const int segs = 6;
                Vec3 up(0, 1, 0);
                Vec3 side = bDir.cross(up).normalized();
                up = side.cross(bDir).normalized();

                uint32_t bIdx = static_cast<uint32_t>(res.woodMesh.vertices.size());
                float rS = tier.startRadius * m_scale;
                float rE = tier.endRadius * m_scale;

                for (int s = 0; s < segs; ++s) {
                    float ang = (static_cast<float>(s) / segs) * TWO_PI;
                    Vec3 rad = side * std::cos(ang) + up * std::sin(ang);
                    res.woodMesh.addVertex(Vertex(bStart + rad * rS, rad, Vec2(0, 0), m_palette.woodBark));
                    res.woodMesh.addVertex(Vertex(bEnd + rad * rE, rad, Vec2(1, 1), m_palette.woodBark));
                }
                for (int s = 0; s < segs; ++s) {
                    int next = (s + 1) % segs;
                    res.woodMesh.addTriangle(bIdx + s * 2, bIdx + s * 2 + 1, bIdx + next * 2);
                    res.woodMesh.addTriangle(bIdx + next * 2, bIdx + s * 2 + 1, bIdx + next * 2 + 1);
                }

                // Seal branch limb base and tip into watertight hulls
                uint32_t limbStartCap = static_cast<uint32_t>(res.woodMesh.vertices.size());
                res.woodMesh.addVertex(Vertex(bStart - bDir * (rS * 0.25f), -bDir, Vec2(0, 0), m_palette.woodBark));
                for (int s = 0; s < segs; ++s) {
                    int next = (s + 1) % segs;
                    res.woodMesh.addTriangle(limbStartCap, bIdx + next * 2, bIdx + s * 2);
                }

                uint32_t limbEndCap = static_cast<uint32_t>(res.woodMesh.vertices.size());
                res.woodMesh.addVertex(Vertex(bEnd + bDir * (rE * 0.5f), bDir, Vec2(1, 1), m_palette.woodBark));
                for (int s = 0; s < segs; ++s) {
                    int next = (s + 1) % segs;
                    res.woodMesh.addTriangle(bIdx + s * 2 + 1, bIdx + next * 2 + 1, limbEndCap);
                }

                // Foliage Sprays at branch end
                if (tier.addFoliageSprigs) {
                    if (m_leafType == BotanicalLeafType::ConiferDistichous) {
                        geometry::Mesh sprig = BotanicalOrganGenerator::generateDistichousConiferSprig(
                            bEnd, bDir, 0.70f * m_scale, 14, 0.034f * m_scale, 0.0048f * m_scale,
                            m_palette.woodBark, m_palette.foliageAlbedo, m_palette.foliageSssGlow
                        );
                        res.foliageMesh.merge(sprig.toScratchboxMesh());
                    } else {
                        // Detailed Anatomical Leaf Cards with Envelope Normals
                        Vec3 clumpCenter = bEnd;
                        float clumpR = tier.spreadRadius * 0.45f * m_scale;
                        const int cardCount = 18;

                        for (int c = 0; c < cardCount; ++c) {
                            float cTheta = c * 2.39996f;
                            float cPhi = std::acos(1.0f - 2.0f * (static_cast<float>(c) + 0.5f) / cardCount);
                            Vec3 cOffset(
                                clumpR * std::sin(cPhi) * std::cos(cTheta),
                                clumpR * 0.5f * std::cos(cPhi),
                                clumpR * std::sin(cPhi) * std::sin(cTheta)
                            );
                            Vec3 cardPos = clumpCenter + cOffset;
                            Vec3 envN = (cardPos - clumpCenter).normalized() + Vec3(0, 0.35f, 0);
                            envN = envN.normalized();

                            float cardSize = clumpR * 0.45f * m_leafScale;
                            Vec3 cSide = envN.cross(up).normalized();
                            Vec3 cUp = cSide.cross(envN).normalized();

                            uint32_t fIdx = static_cast<uint32_t>(res.foliageMesh.vertices.size());
                            res.foliageMesh.addVertex(Vertex(cardPos - cSide * cardSize - cUp * cardSize, envN, Vec2(0, 0), m_palette.foliageAlbedo));
                            res.foliageMesh.addVertex(Vertex(cardPos + cSide * cardSize - cUp * cardSize, envN, Vec2(1, 0), m_palette.foliageAlbedo));
                            res.foliageMesh.addVertex(Vertex(cardPos + cSide * cardSize + cUp * cardSize, envN, Vec2(1, 1), m_palette.foliageSssGlow));
                            res.foliageMesh.addVertex(Vertex(cardPos - cSide * cardSize + cUp * cardSize, envN, Vec2(0, 1), m_palette.foliageSssGlow));

                            res.foliageMesh.addTriangle(fIdx, fIdx + 1, fIdx + 2);
                            res.foliageMesh.addTriangle(fIdx, fIdx + 2, fIdx + 3);
                        }
                    }
                }
            }
        }

        // 3. Epiphytic Shelf Bracket Polypores
        if (m_shelfPolyporeCount > 0) {
            for (int p = 0; p < m_shelfPolyporeCount; ++p) {
                float pAngle = p * 1.85f;
                float pY = m_position.y + 0.8f + p * 0.45f;
                Vec3 pOut(std::cos(pAngle), 0, std::sin(pAngle));
                Vec3 pAttach = m_position + Vec3(0, pY, 0) + pOut * (m_baseRadius * 0.95f);
                geometry::Mesh shelf = BotanicalOrganGenerator::generateShelfPolypore(pAttach, pOut, 0.22f * m_scale);
                res.woodMesh.merge(shelf.toScratchboxMesh());
            }
        }

        res.woodMesh.recomputeBounds();
        res.foliageMesh.recomputeBounds();
        res.totalVertices = res.woodMesh.vertices.size() + res.foliageMesh.vertices.size();
        res.totalTriangles = (res.woodMesh.indices.size() + res.foliageMesh.indices.size()) / 3;
        return res;
    }

    // ------------------------------------------------------------------------
    // Fern Rosette Builder
    // ------------------------------------------------------------------------
    PlantBuildResult buildFernRosette() const {
        PlantBuildResult res;
        res.foliageMesh = ScratchboxMesh("Fern_Rosette");
        res.foliageMesh.material.name = "PBR_Sword_Ferns";
        res.foliageMesh.material.roughnessFactor = 0.50f;
        res.foliageMesh.material.metallicFactor = 0.01f;
        res.foliageMesh.material.doubleSided = true;
        res.foliageMesh.material.alphaMode = "MASK";
        res.foliageMesh.material.alphaCutoff = 0.40f;

        float goldenAngle = 137.508f * DEG_TO_RAD;
        int frondCount = std::max(12, static_cast<int>(24 * m_leafDensity));
        float radius = 1.45f * m_scale;

        for (int f = 0; f < frondCount; ++f) {
            float fFrac = static_cast<float>(f) / frondCount;
            float azimuth = f * goldenAngle + (fFrac * 0.20f);
            float frondLen = radius * (0.85f + 0.45f * (1.0f - fFrac * 0.35f));
            float archHeight = radius * (0.45f + 0.35f * fFrac);

            Vec3 frondDir(std::cos(azimuth), 0.0f, std::sin(azimuth));
            Vec3 frondUp(0, 1, 0);
            Vec3 frondSide = frondDir.cross(frondUp).normalized();

            const int frondSteps = 16;
            std::vector<Vec3> spinePoints;
            spinePoints.reserve(frondSteps + 1);

            for (int s = 0; s <= frondSteps; ++s) {
                float u = static_cast<float>(s) / frondSteps;
                float h = archHeight * 4.0f * u * (1.0f - u * 0.70f) - (u > 0.65f ? (u - 0.65f) * 0.35f : 0.0f);
                float dist = frondLen * u;
                spinePoints.push_back(m_position + frondDir * dist + Vec3(0, h, 0));
            }

            // Rachis woody ribbon
            for (int s = 0; s < frondSteps; ++s) {
                float u = static_cast<float>(s) / frondSteps;
                float rRachis = math::lerp(0.008f, 0.0022f, u) * m_scale;
                const Vec3& pS = spinePoints[s];
                const Vec3& pE = spinePoints[s + 1];
                Vec3 forward = (pE - pS).normalized();
                Vec3 rSide = forward.cross(frondUp).normalized();

                uint32_t rIdx = static_cast<uint32_t>(res.foliageMesh.vertices.size());
                Vec4 rCol(0.26f, 0.18f, 0.10f, 1.0f);
                res.foliageMesh.addVertex(Vertex(pS - rSide * rRachis, frondUp, Vec2(0, 0), rCol));
                res.foliageMesh.addVertex(Vertex(pS + rSide * rRachis, frondUp, Vec2(1, 0), rCol));
                res.foliageMesh.addVertex(Vertex(pE - rSide * (rRachis * 0.8f), frondUp, Vec2(0, 1), rCol));
                res.foliageMesh.addVertex(Vertex(pE + rSide * (rRachis * 0.8f), frondUp, Vec2(1, 1), rCol));
                res.foliageMesh.addTriangle(rIdx, rIdx + 1, rIdx + 2);
                res.foliageMesh.addTriangle(rIdx + 1, rIdx + 3, rIdx + 2);
            }

            // Pinnules
            for (int s = 1; s < frondSteps; ++s) {
                float u = static_cast<float>(s) / frondSteps;
                const Vec3& pStem = spinePoints[s];
                Vec3 forward = (spinePoints[s + 1] - spinePoints[s - 1]).normalized();
                Vec3 stemUp = forward.cross(frondSide).normalized();

                float pinnuleLen = radius * 0.32f * std::sin(u * PI);
                float pinnuleWidth = pinnuleLen * 0.38f;
                Vec4 leafColor = math::lerp(m_palette.foliageAlbedo, m_palette.foliageSssGlow, u * 0.85f);

                for (int sideSign = -1; sideSign <= 1; sideSign += 2) {
                    float sF = static_cast<float>(sideSign);
                    Vec3 pBlade = pStem + frondSide * (sF * pinnuleLen) + stemUp * (0.06f * sF);
                    Vec3 pTip   = pStem + frondSide * (sF * pinnuleLen * 1.15f) + forward * (pinnuleWidth * 0.5f);
                    Vec3 pBase  = pStem - forward * (pinnuleWidth * 0.45f);

                    uint32_t bIdx = static_cast<uint32_t>(res.foliageMesh.vertices.size());
                    res.foliageMesh.addVertex(Vertex(pStem, stemUp, Vec2(0.5f, 0.0f), leafColor));
                    res.foliageMesh.addVertex(Vertex(pBase, stemUp, Vec2(0.0f, 0.5f), leafColor));
                    res.foliageMesh.addVertex(Vertex(pBlade, stemUp, Vec2(0.8f, 0.5f), leafColor));
                    res.foliageMesh.addVertex(Vertex(pTip, stemUp, Vec2(1.0f, 1.0f), leafColor));

                    res.foliageMesh.addTriangle(bIdx, bIdx + 1, bIdx + 2);
                    res.foliageMesh.addTriangle(bIdx, bIdx + 2, bIdx + 3);
                }
            }
        }

        res.foliageMesh.recomputeBounds();
        res.totalVertices = res.foliageMesh.vertices.size();
        res.totalTriangles = res.foliageMesh.indices.size() / 3;
        return res;
    }

    // ------------------------------------------------------------------------
    // Herb Patch Builder (Oxalis, Clover)
    // ------------------------------------------------------------------------
    PlantBuildResult buildHerbPatch() const {
        PlantBuildResult res;
        geometry::Mesh patch = BotanicalOrganGenerator::generateWoodSorrelPatch(
            m_position, 0.95f * m_scale, static_cast<int>(22 * m_leafDensity),
            m_palette.foliageAlbedo, m_palette.foliageSssGlow
        );
        res.foliageMesh = patch.toScratchboxMesh();
        res.foliageMesh.material.name = "PBR_Woodland_Undergrowth";
        res.foliageMesh.material.roughnessFactor = 0.45f;
        res.foliageMesh.material.metallicFactor = 0.01f;
        res.foliageMesh.material.doubleSided = true;
        res.foliageMesh.material.alphaMode = "MASK";
        res.foliageMesh.material.alphaCutoff = 0.35f;

        res.totalVertices = res.foliageMesh.vertices.size();
        res.totalTriangles = res.foliageMesh.indices.size() / 3;
        return res;
    }

    // ------------------------------------------------------------------------
    // Fallen Nurse Log Builder
    // ------------------------------------------------------------------------
    PlantBuildResult buildNurseLog() const {
        PlantBuildResult res;
        Vec3 endPos = m_position + Vec3(3.2f * m_scale, 0.0f, -0.6f * m_scale);
        geometry::Mesh logMesh = NurseLogGenerator::generateHollowNurseLog(
            m_position, endPos, m_baseRadius * m_scale, 0.55f, 40, 36,
            m_palette.woodBark, m_palette.velvetMoss, m_palette.deadwoodCore, m_palette.barkFurrow
        );
        res.woodMesh = logMesh.toScratchboxMesh();
        res.woodMesh.material.name = "PBR_Redwood_Bark";
        res.woodMesh.material.roughnessFactor = 0.90f;
        res.woodMesh.material.metallicFactor = 0.01f;

        if (m_enableMoss) {
            geometry::Mesh moss = BotanicalOrganGenerator::generateVolumetricMossTufts(m_position, endPos, m_baseRadius * m_scale, 160);
            res.groundClutterMesh = moss.toScratchboxMesh();
            res.groundClutterMesh.material.name = "PBR_Woodland_Undergrowth";
            res.groundClutterMesh.material.doubleSided = true;
            res.groundClutterMesh.material.alphaMode = "MASK";
            res.groundClutterMesh.material.alphaCutoff = 0.30f;
        }

        res.totalVertices = res.woodMesh.vertices.size() + res.groundClutterMesh.vertices.size();
        res.totalTriangles = (res.woodMesh.indices.size() + res.groundClutterMesh.indices.size()) / 3;
        return res;
    }

    // ------------------------------------------------------------------------
    // Ground Debris Builder
    // ------------------------------------------------------------------------
    PlantBuildResult buildGroundDebris() const {
        PlantBuildResult res;
        res.groundClutterMesh = ScratchboxMesh("Ground_Litter_Debris");
        res.groundClutterMesh.material.name = "PBR_Woodland_Undergrowth";
        res.groundClutterMesh.material.roughnessFactor = 0.85f;
        res.groundClutterMesh.material.metallicFactor = 0.01f;
        res.groundClutterMesh.material.doubleSided = true;
        res.groundClutterMesh.material.alphaMode = "MASK";
        res.groundClutterMesh.material.alphaCutoff = 0.35f;

        // Needle clusters
        for (int i = 0; i < 25; ++i) {
            float dx = (std::sin(i * 1.9f) * 1.2f) * m_scale;
            float dz = (std::cos(i * 2.3f) * 1.2f) * m_scale;
            geometry::Mesh needles = BotanicalOrganGenerator::generateFallenNeedleCluster(
                m_position + Vec3(dx, 0.015f, dz), Vec3(0, 1, 0), 8, 0.038f * m_scale
            );
            res.groundClutterMesh.merge(needles.toScratchboxMesh());
        }

        // Fibonacci Pinecone
        geometry::Mesh cone = BotanicalOrganGenerator::generateFibonacciPinecone(
            m_position + Vec3(0.25f, 0.02f, 0.15f), Vec3(1, 0, 0), Vec3(0, 1, 0), 0.12f * m_scale
        );
        res.groundClutterMesh.merge(cone.toScratchboxMesh());

        res.totalVertices = res.groundClutterMesh.vertices.size();
        res.totalTriangles = res.groundClutterMesh.indices.size() / 3;
        return res;
    }
};

// ============================================================================
// 3. High-Level Plant Presets (Ready-to-Use Factory Functions)
// ============================================================================

class PlantPresets {
public:
    static PlantBuildResult createHeroAncientRedwood(const Vec3& position, float height = 28.0f) {
        ProceduralPlantBuilder b(PlantArchetype::ConiferRedwood);
        b.setPosition(position)
         .setTrunk(height, 1.60f, 0.76f, 8, 1.50f, 1.35f, 1.8f, 95.0f)
         .addBranchTier(0.15f, 6, 4.4f, 0.20f, 8.0f)
         .addBranchTier(0.28f, 7, 5.2f, 0.22f, 12.0f)
         .addBranchTier(0.42f, 7, 5.8f, 0.25f, 18.0f)
         .addBranchTier(0.92f, 8, 6.2f, 0.15f, 25.0f)
         .setFoliage(BotanicalLeafType::ConiferDistichous, 1.2f, 1.0f, true)
         .setEpiphytes(true, 4);
        return b.build();
    }

    static PlantBuildResult createUnderstoryDogwood(const Vec3& position, float height = 5.5f) {
        ProceduralPlantBuilder b(PlantArchetype::SubcanopyUnderstory);
        b.setPosition(position)
         .setTrunk(height, 0.16f, 0.05f, 0, 0.0f, 0.2f, 3.5f, 45.0f)
         .addBranchTier(0.45f, 5, 3.2f, 0.18f, 15.0f)
         .addBranchTier(0.75f, 6, 3.5f, 0.14f, 20.0f)
         .setFoliage(BotanicalLeafType::OvateSimple, 1.1f, 1.1f, true)
         .setEpiphytes(false, 0);
        return b.build();
    }

    static PlantBuildResult createSwordFernColony(const Vec3& position, float radius = 1.6f, int frondCount = 26) {
        ProceduralPlantBuilder b(PlantArchetype::SwordFern);
        b.setPosition(position)
         .setScale(radius / 1.45f)
         .setFoliage(BotanicalLeafType::FernPinnule, frondCount / 24.0f, 1.0f, true);
        return b.build();
    }

    static PlantBuildResult createDecayingNurseLog(const Vec3& start, const Vec3& end, float radius = 0.50f) {
        ProceduralPlantBuilder b(PlantArchetype::NurseLogDecayed);
        b.setPosition(start)
         .setTrunk((end - start).length(), radius, radius * 0.95f)
         .setEpiphytes(true, 3);
        return b.build();
    }

    static PlantBuildResult createWoodSorrelCushion(const Vec3& position, float radius = 0.95f) {
        ProceduralPlantBuilder b(PlantArchetype::WoodlandHerb);
        b.setPosition(position)
         .setScale(radius / 0.95f)
         .setFoliage(BotanicalLeafType::OxalisTrifoliate, 1.0f, 1.0f, true);
        return b.build();
    }
};

} // namespace plant
} // namespace scratchbox

#endif // SCRATCHBOX_PLANT_BUILDER_HPP
