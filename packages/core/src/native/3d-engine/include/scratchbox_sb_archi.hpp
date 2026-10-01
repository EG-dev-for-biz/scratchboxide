/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * SB-Archi (Scratchbox Classical Architecture Parametric Engine)
 * Native C++20 Classical Vitruvian Structural Prior & Procedural Synthesizer.
 *
 * Implements 4-tiered Roman Amphitheater (Flavian Colosseum) arcade geometry:
 * - Elliptical plan curve with parametric semi-major/minor axes (a, b)
 * - 4 Classical Orders: Tuscan/Doric, Ionic, Corinthian, Attic Pilasters
 * - True semicircular Roman arches with radial voussoirs and keystones
 * - Hollow, see-through radial vomitoria barrel vaults
 * - Engaged columns on continuous plinths with entasis taper
 * - Procedural rusticated Roman travertine ashlar PBR materials
 ********************************************************************************/

#ifndef SCRATCHBOX_SB_ARCHI_HPP
#define SCRATCHBOX_SB_ARCHI_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <memory>
#include <cstdint>
#include <sstream>

namespace scratchbox {
namespace sb_archi {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Mat4;
using math::PI;
using math::TWO_PI;
using math::DEG_TO_RAD;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. CLASSICAL ROMAN ORDERS & ARCHITECTURAL TYPES
// ============================================================================

enum class RomanOrder {
    Tuscan,         // Tier 1: Robust, unadorned column with simple torus base and abacus
    Doric,          // Tier 1 Alt: Fluted or unfluted with frieze triglyphs
    Ionic,          // Tier 2: Slender column with characteristic scroll volute capital
    Corinthian,     // Tier 3: Ornate capital adorned with acanthus leaves and volutes
    AtticPilaster   // Tier 4: Flat rectangular pilasters framing small window bays
};

struct TierDefinition {
    float elevationBaseMeters = 0.0f;
    float elevationTopMeters = 10.5f;
    RomanOrder order = RomanOrder::Tuscan;
    bool hasArchOpenings = true;
    float archClearSpanMeters = 4.2f;
    float archSpringlineMeters = 4.5f;   // Height from tier base to arch springline
    float columnRadiusMeters = 0.54f;
    float columnProjectionMeters = 0.45f;
    float entablatureHeightMeters = 1.6f;
    bool hasBalustrade = false;
};

// ============================================================================
// 2. PARAMETRIC ROMAN ARCADE PARAMETERS
// ============================================================================

struct SbArchiParams {
    // Elliptical footprint dimensions (Outer facade envelope - Ring 1)
    float semiMajorAxisA = 94.0f;       // Nominal Colosseum length: 188m (a = 94m)
    float semiMinorAxisB = 78.0f;       // Nominal Colosseum width: 156m (b = 78m)
    float totalHeightMeters = 48.5f;     // Nominal Colosseum height: 48.5m
    float wallDepthMeters = 5.2f;        // Radial arcade wall thickness (pier depth)

    // Center & geodetic orientation in world ENU space
    Vec3 worldCenter{ -43.42f, 42.5f, 62.54f };
    float worldYawRad = 0.6273f;        // 35.94 degrees (Colosseum axis yaw)

    // Radial bay subdivision
    int totalBays360 = 80;               // Authentic Colosseum: 80 radial entrance arches
    float arcStartRad = 0.0f;            // Start angle in radians
    float arcEndRad = TWO_PI;            // End angle in radians (default full 360 ring)

    // Tier configuration (Authentic Colosseum 4 Tiers)
    std::vector<TierDefinition> tiers = {
        // Tier 1: Ground level (Tuscan/Doric) - 10.5m
        { 0.0f, 10.5f, RomanOrder::Tuscan, true, 4.2f, 4.5f, 0.56f, 0.48f, 1.6f, false },
        // Tier 2: Second level (Ionic) - 11.8m (10.5m to 22.3m)
        { 10.5f, 22.3f, RomanOrder::Ionic, true, 4.2f, 4.8f, 0.52f, 0.44f, 1.6f, true },
        // Tier 3: Third level (Corinthian) - 11.7m (22.3m to 34.0m)
        { 22.3f, 34.0f, RomanOrder::Corinthian, true, 4.2f, 4.8f, 0.48f, 0.40f, 1.6f, true },
        // Tier 4: Attic story (Corinthian Pilasters + Windows) - 14.5m (34.0m to 48.5m)
        { 34.0f, 48.5f, RomanOrder::AtticPilaster, false, 0.0f, 0.0f, 0.42f, 0.22f, 2.2f, false }
    };

    // Attic window & Velarium mast corbels
    int atticWindowModulo = 2;           // Windows in every 2nd bay (40 windows total)
    float atticWindowWidth = 1.8f;
    float atticWindowHeight = 2.4f;
    float atticWindowElevation = 38.5f;

    // Concentric Interior Annular Ambulatories & Cavea
    bool enableAmbulatories = true;
    float ambulatoryRing2MajorA = 82.5f;     // Intermediate ambulatory wall
    float ambulatoryRing2MinorB = 67.5f;
    float ambulatoryRing2WallDepth = 3.0f;
    float ambulatoryRing3MajorA = 70.5f;     // Inner ambulatory wall / podium substructure
    float ambulatoryRing3MinorB = 56.5f;
    float ambulatoryRing3WallDepth = 2.8f;
    float arenaSemiMajorAxis = 43.5f;        // Elliptical arena floor boundary (87m x 58m)
    float arenaSemiMinorAxis = 29.0f;
    float arenaPodiumElevation = 3.8f;       // Podium wall height from arena floor datum (y = 0.0)
    int caveaStepCount = 10;                 // Stepped seating rows from Ring 3 to arena podium

    // Subterranean Hypogeum Labyrinth
    bool enableHypogeum = true;
    float hypogeumFloorElevation = -5.8f;     // Sunk 5.8m below arena level
    float hypogeumDrainageElevation = -6.1f;  // Central drainage channel floor (-6.1m)
    float hypogeumCentralCorridorWidth = 4.0f;
    float hypogeumCrossCorridorWidth = 3.2f;
    int hypogeumConcentricWalls = 4;
    float arenaDeckExposedThresholdX = 5.0f; // Stage floor open for X <= 5.0m, planked for X > 5.0m

    // Procedural Travertine Ashlar Coursing & Voussoir Detailing
    bool enableAshlarCoursing = true;
    int ashlarCoursesPerTier = 5;            // 5 horizontal ashlar blocks per pier
    int voussoirCount = 15;                  // 15 radial voussoir wedges per arch
    float keystoneProjectionMeters = 0.15f;  // 15cm projection outward
    float keystoneVerticalFlareMeters = 0.35f; // 35cm flare above arch extrados

    // Multi-Material PBR Palette Vectors
    // Index 0: Travertine Ashlar
    Vec4 travertineColor{ 0.84f, 0.81f, 0.75f, 1.0f };
    float travertineRoughness = 0.84f;
    float travertineMetalness = 0.02f;

    // Index 1: Vault Brick / Opus Latericium
    Vec4 vaultBrickColor{ 0.62f, 0.42f, 0.35f, 1.0f };
    float vaultRoughness = 0.92f;
    float vaultMetalness = 0.01f;

    // Index 2: Hypogeum Tufa / Subterranean Brick
    Vec4 hypogeumBrickColor{ 0.55f, 0.38f, 0.32f, 1.0f };

    // Index 3: Roman Timber (Decking planks, elevator lift cages, posts)
    Vec4 timberColor{ 0.48f, 0.36f, 0.25f, 1.0f };

    // Index 4: Ambulatory Floor Paving & Cavea Treads
    Vec4 floorPavingColor{ 0.72f, 0.70f, 0.66f, 1.0f };

    // Index 5: Shadow Joints & Bevels (Mortar recesses)
    Vec4 shadowJointColor{ 0.38f, 0.36f, 0.34f, 1.0f };

    // Index 6: Monumental Flared Keystone
    Vec4 keystoneColor{ 0.88f, 0.86f, 0.81f, 1.0f };

    // Index 7: Drainage Slab & Canal Bed
    Vec4 drainageSlabColor{ 0.35f, 0.35f, 0.34f, 1.0f };

    // Quality subdivision
    int archSegments = 16;               // Semicircular arch curve segments
    int columnRadialSegments = 12;       // Cylinder segments for engaged columns
};

// ============================================================================
// 3. SB-ARCHI MODEL BUILDER
// ============================================================================

class SbArchiModelBuilder {
public:
    static ScratchboxMesh buildColosseumArcade(const SbArchiParams& params) {
        ScratchboxMesh mesh("colosseum_sb_archi_manifold");

        // PBR Materials
        PbrMaterial travertineMat("Travertine_Ashlar_PBR");
        travertineMat.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f); // Vertex colors modulate base color
        travertineMat.roughnessFactor = params.travertineRoughness;
        travertineMat.metallicFactor = params.travertineMetalness;

        mesh.material = travertineMat;

        float angleSpan = params.arcEndRad - params.arcStartRad;
        int activeBays = static_cast<int>(std::round(params.totalBays360 * (angleSpan / TWO_PI)));
        if (activeBays < 1) activeBays = 1;

        float deltaAngle = angleSpan / activeBays;

        // Build each radial bay
        for (int bayIdx = 0; bayIdx < activeBays; ++bayIdx) {
            float phiStart = params.arcStartRad + bayIdx * deltaAngle;
            float phiEnd = phiStart + deltaAngle;
            float phiMid = 0.5f * (phiStart + phiEnd);

            buildBay(mesh, params, bayIdx, phiStart, phiEnd, phiMid);
        }

        // Build continuous horizontal entablature stringcourses & attic cornice
        buildEntablaturesAndCornices(mesh, params, activeBays, deltaAngle);

        // Build interior annular ambulatories & cavea seating bowl
        if (params.enableAmbulatories) {
            buildAnnularAmbulatories(mesh, params, activeBays, deltaAngle);
        }

        // Build subterranean hypogeum maze beneath arena
        if (params.enableHypogeum) {
            buildSubterraneanHypogeum(mesh, params);
        }

        // Transform local Vitruvian geometry into metric world frame (centering, base elevation, yaw)
        float cosYaw = std::cos(params.worldYawRad);
        float sinYaw = std::sin(params.worldYawRad);
        float yBase = params.worldCenter.y - params.totalHeightMeters * 0.5f;

        for (auto& v : mesh.vertices) {
            float x = v.position.x;
            float y = v.position.y + yBase;
            float z = v.position.z;

            float rx = cosYaw * x - sinYaw * z;
            float rz = sinYaw * x + cosYaw * z;

            v.position = Vec3(rx + params.worldCenter.x, y, rz + params.worldCenter.z);

            float nx = cosYaw * v.normal.x - sinYaw * v.normal.z;
            float nz = sinYaw * v.normal.x + cosYaw * v.normal.z;
            v.normal = Vec3(nx, v.normal.y, nz);
        }

        mesh.recomputeNormals();
        return mesh;
    }

private:
    static Vec3 evalEllipse(float a, float b, float phi, float y) {
        return Vec3(a * std::cos(phi), y, b * std::sin(phi));
    }

    static Vec3 evalEllipseNormal(float a, float b, float phi) {
        // Outward normal to ellipse (x^2/a^2 + z^2/b^2 = 1) is (2x/a^2, 0, 2z/b^2) = (cos(phi)/a, 0, sin(phi)/b)
        Vec3 n(std::cos(phi) / a, 0.0f, std::sin(phi) / b);
        return math::normalize(n);
    }

    static Vec3 evalEllipseTangent(float a, float b, float phi) {
        Vec3 n = evalEllipseNormal(a, b, phi);
        return Vec3(-n.z, 0.0f, n.x);
    }

    static Vec4 getMaterialColor(const SbArchiParams& params, uint32_t matIdx) {
        switch (matIdx) {
            case 0: return params.travertineColor;
            case 1: return params.vaultBrickColor;
            case 2: return params.hypogeumBrickColor;
            case 3: return params.timberColor;
            case 4: return params.floorPavingColor;
            case 5: return params.shadowJointColor;
            case 6: return params.keystoneColor;
            case 7: return params.drainageSlabColor;
            default: return params.travertineColor;
        }
    }

    static void addQuad(ScratchboxMesh& mesh, const Vertex& v0, const Vertex& v1, const Vertex& v2, const Vertex& v3,
                        uint32_t matIdx = 0, const SbArchiParams* pParams = nullptr) {
        uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
        Vertex mv0 = v0, mv1 = v1, mv2 = v2, mv3 = v3;
        Vec4 color;
        if (pParams) {
            color = getMaterialColor(*pParams, matIdx);
        } else {
            static const Vec4 defaultPalette[8] = {
                Vec4(0.84f, 0.81f, 0.75f, 1.0f), // 0: Travertine Ashlar
                Vec4(0.62f, 0.42f, 0.35f, 1.0f), // 1: Vault Brick
                Vec4(0.55f, 0.38f, 0.32f, 1.0f), // 2: Hypogeum Brick
                Vec4(0.48f, 0.36f, 0.25f, 1.0f), // 3: Roman Timber
                Vec4(0.72f, 0.70f, 0.66f, 1.0f), // 4: Floor Paving
                Vec4(0.38f, 0.36f, 0.34f, 1.0f), // 5: Shadow Joints
                Vec4(0.88f, 0.86f, 0.81f, 1.0f), // 6: Keystone
                Vec4(0.35f, 0.35f, 0.34f, 1.0f)  // 7: Drainage Slab
            };
            color = (matIdx < 8) ? defaultPalette[matIdx] : defaultPalette[0];
        }
        mv0.color = color;
        mv1.color = color;
        mv2.color = color;
        mv3.color = color;

        mesh.vertices.push_back(mv0);
        mesh.vertices.push_back(mv1);
        mesh.vertices.push_back(mv2);
        mesh.vertices.push_back(mv3);

        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 1);
        mesh.indices.push_back(idx + 2);

        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 2);
        mesh.indices.push_back(idx + 3);
    }

    static void addTriangle(ScratchboxMesh& mesh, const Vertex& v0, const Vertex& v1, const Vertex& v2,
                           uint32_t matIdx = 0, const SbArchiParams* pParams = nullptr) {
        uint32_t idx = static_cast<uint32_t>(mesh.vertices.size());
        Vertex mv0 = v0, mv1 = v1, mv2 = v2;
        Vec4 color;
        if (pParams) {
            color = getMaterialColor(*pParams, matIdx);
        } else {
            static const Vec4 defaultPalette[8] = {
                Vec4(0.84f, 0.81f, 0.75f, 1.0f),
                Vec4(0.62f, 0.42f, 0.35f, 1.0f),
                Vec4(0.55f, 0.38f, 0.32f, 1.0f),
                Vec4(0.48f, 0.36f, 0.25f, 1.0f),
                Vec4(0.72f, 0.70f, 0.66f, 1.0f),
                Vec4(0.38f, 0.36f, 0.34f, 1.0f),
                Vec4(0.88f, 0.86f, 0.81f, 1.0f),
                Vec4(0.35f, 0.35f, 0.34f, 1.0f)
            };
            color = (matIdx < 8) ? defaultPalette[matIdx] : defaultPalette[0];
        }
        mv0.color = color;
        mv1.color = color;
        mv2.color = color;

        mesh.vertices.push_back(mv0);
        mesh.vertices.push_back(mv1);
        mesh.vertices.push_back(mv2);

        mesh.indices.push_back(idx + 0);
        mesh.indices.push_back(idx + 1);
        mesh.indices.push_back(idx + 2);
    }

    static void buildBay(ScratchboxMesh& mesh, const SbArchiParams& params, int bayIdx, float phiStart, float phiEnd, float phiMid) {
        float aOuter = params.semiMajorAxisA;
        float bOuter = params.semiMinorAxisB;
        float aInner = params.semiMajorAxisA - params.wallDepthMeters;
        float bInner = params.semiMinorAxisB - params.wallDepthMeters;

        // Iterate through all 4 architectural tiers
        for (size_t tierIdx = 0; tierIdx < params.tiers.size(); ++tierIdx) {
            const auto& tier = params.tiers[tierIdx];
            float yLo = tier.elevationBaseMeters;
            float yHi = tier.elevationTopMeters;
            float tierHeight = yHi - yLo;

            if (tier.hasArchOpenings) {
                // Tier 1, 2, 3: Classical Open Arches + Hollow Vomitoria Barrel Vaults
                buildArchBayTier(mesh, params, tier, tierIdx, phiStart, phiEnd, phiMid, aOuter, bOuter, aInner, bInner);
            } else {
                // Tier 4: Attic Wall with Corinthian Pilasters and Rectangular Windows
                buildAtticBayTier(mesh, params, tier, bayIdx, phiStart, phiEnd, phiMid, aOuter, bOuter, aInner, bInner);
            }

            // Engaged Column / Pilaster on the outer pier face
            buildEngagedColumn(mesh, params, tier, phiStart, yLo, yHi, aOuter, bOuter);
        }
    }

    static void buildAshlarPierFace(ScratchboxMesh& mesh, const SbArchiParams& params,
                                    float a, float b, float phiL, float phiR,
                                    float yLo, float yHi, bool isInner = false) {
        if (!params.enableAshlarCoursing || params.ashlarCoursesPerTier <= 1) {
            Vec3 nL = evalEllipseNormal(a, b, phiL) * (isInner ? -1.0f : 1.0f);
            Vec3 nR = evalEllipseNormal(a, b, phiR) * (isInner ? -1.0f : 1.0f);
            Vec3 pLL = evalEllipse(a, b, phiL, yLo);
            Vec3 pLR = evalEllipse(a, b, phiR, yLo);
            Vec3 pUR = evalEllipse(a, b, phiR, yHi);
            Vec3 pUL = evalEllipse(a, b, phiL, yHi);
            if (!isInner) {
                addQuad(mesh, {pLL, nL, Vec2(0,0)}, {pLR, nR, Vec2(1,0)},
                              {pUR, nR, Vec2(1,1)}, {pUL, nL, Vec2(0,1)}, 0, &params);
            } else {
                addQuad(mesh, {pLR, nR, Vec2(1,0)}, {pLL, nL, Vec2(0,0)},
                              {pUL, nL, Vec2(0,1)}, {pUR, nR, Vec2(1,1)}, 0, &params);
            }
            return;
        }

        int numCourses = params.ashlarCoursesPerTier;
        float courseHeight = (yHi - yLo) / numCourses;
        float bedJointHeight = std::min(0.04f, courseHeight * 0.08f);
        float radiusEst = 0.5f * (a + b);
        float jointAngle = 0.035f / radiusEst; // ~3.5cm vertical joint

        for (int c = 0; c < numCourses; ++c) {
            float yCourseLo = yLo + c * courseHeight;
            float yCourseHi = yLo + (c + 1) * courseHeight;
            float yStoneHi = (c < numCourses - 1) ? (yCourseHi - bedJointHeight) : yCourseHi;

            // Running bond alternation: split ratio alternates 0.52 vs 0.48
            float splitRatio = (c % 2 == 0) ? 0.52f : 0.48f;
            float phiSplit = phiL + (phiR - phiL) * splitRatio;
            float phiSplitL = std::max(phiL, phiSplit - jointAngle * 0.5f);
            float phiSplitR = std::min(phiR, phiSplit + jointAngle * 0.5f);

            // Left Block (matIdx = 0)
            {
                Vec3 p0 = evalEllipse(a, b, phiL, yCourseLo);
                Vec3 p1 = evalEllipse(a, b, phiSplitL, yCourseLo);
                Vec3 p2 = evalEllipse(a, b, phiSplitL, yStoneHi);
                Vec3 p3 = evalEllipse(a, b, phiL, yStoneHi);
                Vec3 n0 = evalEllipseNormal(a, b, phiL) * (isInner ? -1.0f : 1.0f);
                Vec3 n1 = evalEllipseNormal(a, b, phiSplitL) * (isInner ? -1.0f : 1.0f);
                if (!isInner) {
                    addQuad(mesh, {p0, n0, Vec2(0,0)}, {p1, n1, Vec2(0.5f,0)},
                                  {p2, n1, Vec2(0.5f,1)}, {p3, n0, Vec2(0,1)}, 0, &params);
                } else {
                    addQuad(mesh, {p1, n1, Vec2(0.5f,0)}, {p0, n0, Vec2(0,0)},
                                  {p3, n0, Vec2(0,1)}, {p2, n1, Vec2(0.5f,1)}, 0, &params);
                }
            }

            // Vertical Shadow Joint (matIdx = 5)
            if (phiSplitR > phiSplitL) {
                Vec3 j0 = evalEllipse(a, b, phiSplitL, yCourseLo);
                Vec3 j1 = evalEllipse(a, b, phiSplitR, yCourseLo);
                Vec3 j2 = evalEllipse(a, b, phiSplitR, yStoneHi);
                Vec3 j3 = evalEllipse(a, b, phiSplitL, yStoneHi);
                Vec3 nj0 = evalEllipseNormal(a, b, phiSplitL) * (isInner ? -1.0f : 1.0f);
                Vec3 nj1 = evalEllipseNormal(a, b, phiSplitR) * (isInner ? -1.0f : 1.0f);
                if (!isInner) {
                    addQuad(mesh, {j0, nj0, Vec2(0,0)}, {j1, nj1, Vec2(1,0)},
                                  {j2, nj1, Vec2(1,1)}, {j3, nj0, Vec2(0,1)}, 5, &params);
                } else {
                    addQuad(mesh, {j1, nj1, Vec2(1,0)}, {j0, nj0, Vec2(0,0)},
                                  {j3, nj0, Vec2(0,1)}, {j2, nj1, Vec2(1,1)}, 5, &params);
                }
            }

            // Right Block (matIdx = 0)
            {
                Vec3 p0 = evalEllipse(a, b, phiSplitR, yCourseLo);
                Vec3 p1 = evalEllipse(a, b, phiR, yCourseLo);
                Vec3 p2 = evalEllipse(a, b, phiR, yStoneHi);
                Vec3 p3 = evalEllipse(a, b, phiSplitR, yStoneHi);
                Vec3 n0 = evalEllipseNormal(a, b, phiSplitR) * (isInner ? -1.0f : 1.0f);
                Vec3 n1 = evalEllipseNormal(a, b, phiR) * (isInner ? -1.0f : 1.0f);
                if (!isInner) {
                    addQuad(mesh, {p0, n0, Vec2(0.5f,0)}, {p1, n1, Vec2(1,0)},
                                  {p2, n1, Vec2(1,1)}, {p3, n0, Vec2(0.5f,1)}, 0, &params);
                } else {
                    addQuad(mesh, {p1, n1, Vec2(1,0)}, {p0, n0, Vec2(0.5f,0)},
                                  {p3, n0, Vec2(0.5f,1)}, {p2, n1, Vec2(1,1)}, 0, &params);
                }
            }

            // Horizontal Recessed Bed Joint (matIdx = 5)
            if (c < numCourses - 1) {
                Vec3 b0 = evalEllipse(a, b, phiL, yStoneHi);
                Vec3 b1 = evalEllipse(a, b, phiR, yStoneHi);
                Vec3 b2 = evalEllipse(a, b, phiR, yCourseHi);
                Vec3 b3 = evalEllipse(a, b, phiL, yCourseHi);
                Vec3 n0 = evalEllipseNormal(a, b, phiL) * (isInner ? -1.0f : 1.0f);
                Vec3 n1 = evalEllipseNormal(a, b, phiR) * (isInner ? -1.0f : 1.0f);
                if (!isInner) {
                    addQuad(mesh, {b0, n0, Vec2(0,0)}, {b1, n1, Vec2(1,0)},
                                  {b2, n1, Vec2(1,1)}, {b3, n0, Vec2(0,1)}, 5, &params);
                } else {
                    addQuad(mesh, {b1, n1, Vec2(1,0)}, {b0, n0, Vec2(0,0)},
                                  {b3, n0, Vec2(0,1)}, {b2, n1, Vec2(1,1)}, 5, &params);
                }
            }
        }
    }

    static void buildArchBayTier(ScratchboxMesh& mesh, const SbArchiParams& params, const TierDefinition& tier,
                                 size_t tierIdx, float phiStart, float phiEnd, float phiMid,
                                 float aOuter, float bOuter, float aInner, float bInner) {
        float yLo = tier.elevationBaseMeters;
        float yHi = tier.elevationTopMeters;
        float ySpring = yLo + tier.archSpringlineMeters;

        // Radial pier boundaries vs central arch opening
        float pierFraction = 0.22f; // fraction on each side for pier mass
        float phiPierLeft = phiStart + (phiEnd - phiStart) * pierFraction;
        float phiPierRight = phiEnd - (phiEnd - phiStart) * pierFraction;

        // 1. LEFT & RIGHT PIER FACES with Ashlar Coursing & Recessed Joints (matIdx = 0 & 5)
        buildAshlarPierFace(mesh, params, aOuter, bOuter, phiStart, phiPierLeft, yLo, ySpring, false);
        buildAshlarPierFace(mesh, params, aOuter, bOuter, phiPierRight, phiEnd, yLo, ySpring, false);
        buildAshlarPierFace(mesh, params, aInner, bInner, phiStart, phiPierLeft, yLo, ySpring, true);
        buildAshlarPierFace(mesh, params, aInner, bInner, phiPierRight, phiEnd, yLo, ySpring, true);

        // 2. RADIAL PIER SIDEWALLS (Flanks of the entrance vomitorium)
        Vec3 vOL_LR = evalEllipse(aOuter, bOuter, phiPierLeft, yLo);
        Vec3 vOL_UR = evalEllipse(aOuter, bOuter, phiPierLeft, ySpring);
        Vec3 vIL_LL = evalEllipse(aInner, bInner, phiPierLeft, yLo);
        Vec3 vIL_UL = evalEllipse(aInner, bInner, phiPierLeft, ySpring);
        Vec3 nLeftSidewall(std::sin(phiPierLeft), 0.0f, -std::cos(phiPierLeft));

        Vertex vtWall_O_Lo{ vOL_LR, nLeftSidewall, Vec2(0.0f, 0.0f) };
        Vertex vtWall_I_Lo{ vIL_LL, nLeftSidewall, Vec2(1.0f, 0.0f) };
        Vertex vtWall_I_Hi{ vIL_UL, nLeftSidewall, Vec2(1.0f, 1.0f) };
        Vertex vtWall_O_Hi{ vOL_UR, nLeftSidewall, Vec2(0.0f, 1.0f) };
        addQuad(mesh, vtWall_O_Lo, vtWall_I_Lo, vtWall_I_Hi, vtWall_O_Hi, 0, &params);

        Vec3 vOR_LL = evalEllipse(aOuter, bOuter, phiPierRight, yLo);
        Vec3 vOR_UL = evalEllipse(aOuter, bOuter, phiPierRight, ySpring);
        Vec3 vIR_LR = evalEllipse(aInner, bInner, phiPierRight, yLo);
        Vec3 vIR_UR = evalEllipse(aInner, bInner, phiPierRight, ySpring);
        Vec3 nRightSidewall(-std::sin(phiPierRight), 0.0f, std::cos(phiPierRight));

        Vertex vtWallR_O_Lo{ vOR_LL, nRightSidewall, Vec2(0.0f, 0.0f) };
        Vertex vtWallR_O_Hi{ vOR_UL, nRightSidewall, Vec2(0.0f, 1.0f) };
        Vertex vtWallR_I_Hi{ vIR_UR, nRightSidewall, Vec2(1.0f, 1.0f) };
        Vertex vtWallR_I_Lo{ vIR_LR, nRightSidewall, Vec2(1.0f, 0.0f) };
        addQuad(mesh, vtWallR_O_Lo, vtWallR_O_Hi, vtWallR_I_Hi, vtWallR_I_Lo, 0, &params);

        // 3. BARREL VAULT CEILING (Vomitorium Tunnel with Opus Latericium - matIdx = 1)
        int segments = params.archSegments;
        float archRadius = (tier.archClearSpanMeters * 0.5f);
        std::vector<Vec3> outerArchPts(segments + 1);
        std::vector<Vec3> innerArchPts(segments + 1);

        for (int i = 0; i <= segments; ++i) {
            float t = static_cast<float>(i) / segments;
            float archAngle = t * PI;
            float phi = phiPierLeft + t * (phiPierRight - phiPierLeft);
            float yOffset = std::sin(archAngle) * archRadius;
            float yCurr = ySpring + yOffset;

            outerArchPts[i] = evalEllipse(aOuter, bOuter, phi, yCurr);
            innerArchPts[i] = evalEllipse(aInner, bInner, phi, yCurr);
        }

        for (int i = 0; i < segments; ++i) {
            float t0 = static_cast<float>(i) / segments;
            float t1 = static_cast<float>(i + 1) / segments;
            float archAngleMid = 0.5f * (t0 + t1) * PI;

            Vec3 normDown(0.0f, -std::sin(archAngleMid), 0.0f);
            Vertex vOut0{ outerArchPts[i], normDown, Vec2(t0, 0.0f) };
            Vertex vIn0{ innerArchPts[i], normDown, Vec2(t0, 1.0f) };
            Vertex vIn1{ innerArchPts[i + 1], normDown, Vec2(t1, 1.0f) };
            Vertex vOut1{ outerArchPts[i + 1], normDown, Vec2(t1, 0.0f) };

            addQuad(mesh, vOut0, vIn0, vIn1, vOut1, 1, &params);
        }

        // 4. RADIAL VOUSSOIRS & MONUMENTAL FLARED KEYSTONE (matIdx = 0, 5, 6)
        int numVoussoirs = params.voussoirCount;
        if (numVoussoirs < 5) numVoussoirs = 5;
        if (numVoussoirs % 2 == 0) numVoussoirs += 1; // Ensure odd count for central keystone
        int keystoneIdx = numVoussoirs / 2;

        float rIntra = archRadius;
        float rExtra = archRadius + 0.75f;
        float s = rExtra / rIntra;
        float dPhiHalf = 0.5f * (phiPierRight - phiPierLeft);

        auto evalIntraPhi = [&](float theta) {
            return phiMid - dPhiHalf * std::cos(theta);
        };
        auto evalIntraY = [&](float theta) {
            return ySpring + rIntra * std::sin(theta);
        };
        auto evalExtraPhi = [&](float theta) {
            return phiMid - dPhiHalf * s * std::cos(theta);
        };
        auto evalExtraY = [&](float theta) {
            return ySpring + rExtra * std::sin(theta);
        };

        std::vector<Vec3> extraPts(numVoussoirs + 1);
        std::vector<float> extraPhis(numVoussoirs + 1);

        for (int k = 0; k < numVoussoirs; ++k) {
            float th0 = (static_cast<float>(k) / numVoussoirs) * PI;
            float th1 = (static_cast<float>(k + 1) / numVoussoirs) * PI;
            bool isKeystone = (k == keystoneIdx);

            float phi_I0 = evalIntraPhi(th0);
            float phi_I1 = evalIntraPhi(th1);
            float y_I0 = evalIntraY(th0);
            float y_I1 = evalIntraY(th1);

            float phi_E0 = evalExtraPhi(th0);
            float phi_E1 = evalExtraPhi(th1);
            float y_E0 = evalExtraY(th0);
            float y_E1 = evalExtraY(th1);

            if (k == 0) {
                extraPts[0] = evalEllipse(aOuter, bOuter, phi_E0, y_E0);
                extraPhis[0] = phi_E0;
            }

            if (isKeystone) {
                float y_E0_k = y_E0 + params.keystoneVerticalFlareMeters;
                float y_E1_k = y_E1 + params.keystoneVerticalFlareMeters;
                extraPts[k + 1] = evalEllipse(aOuter, bOuter, phi_E1, y_E1_k);
                extraPhis[k + 1] = phi_E1;

                Vec3 pI0 = evalEllipse(aOuter, bOuter, phi_I0, y_I0);
                Vec3 pI1 = evalEllipse(aOuter, bOuter, phi_I1, y_I1);
                Vec3 pE0 = evalEllipse(aOuter, bOuter, phi_E0, y_E0_k);
                Vec3 pE1 = evalEllipse(aOuter, bOuter, phi_E1, y_E1_k);

                Vec3 nKey = evalEllipseNormal(aOuter, bOuter, phiMid);
                Vec3 projVec = nKey * params.keystoneProjectionMeters;

                Vec3 pI0_f = pI0 + projVec;
                Vec3 pI1_f = pI1 + projVec;
                Vec3 pE0_f = pE0 + projVec;
                Vec3 pE1_f = pE1 + projVec;

                // Face 1: Front projected face (matIdx = 6)
                addQuad(mesh, {pI0_f, nKey, Vec2(0,0)}, {pI1_f, nKey, Vec2(1,0)},
                              {pE1_f, nKey, Vec2(1,1)}, {pE0_f, nKey, Vec2(0,1)}, 6, &params);

                // Face 2: Left cheek (matIdx = 6)
                Vec3 nCheekL = evalEllipseNormal(aOuter, bOuter, phi_I0);
                addQuad(mesh, {pI0, nCheekL, Vec2(0,0)}, {pI0_f, nCheekL, Vec2(1,0)},
                              {pE0_f, nCheekL, Vec2(1,1)}, {pE0, nCheekL, Vec2(0,1)}, 6, &params);

                // Face 3: Right cheek (matIdx = 6)
                Vec3 nCheekR = evalEllipseNormal(aOuter, bOuter, phi_I1);
                addQuad(mesh, {pI1_f, nCheekR, Vec2(0,0)}, {pI1, nCheekR, Vec2(1,0)},
                              {pE1, nCheekR, Vec2(1,1)}, {pE1_f, nCheekR, Vec2(0,1)}, 6, &params);

                // Face 4: Bottom intrados lip (matIdx = 6)
                Vec3 nLipB(0.0f, -1.0f, 0.0f);
                addQuad(mesh, {pI0, nLipB, Vec2(0,0)}, {pI1, nLipB, Vec2(1,0)},
                              {pI1_f, nLipB, Vec2(1,1)}, {pI0_f, nLipB, Vec2(0,1)}, 6, &params);

                // Face 5: Top extrados ledge (matIdx = 6)
                Vec3 nLedgeT(0.0f, 1.0f, 0.0f);
                addQuad(mesh, {pE0_f, nLedgeT, Vec2(0,0)}, {pE1_f, nLedgeT, Vec2(1,0)},
                              {pE1, nLedgeT, Vec2(1,1)}, {pE0, nLedgeT, Vec2(0,1)}, 6, &params);
            } else {
                extraPts[k + 1] = evalEllipse(aOuter, bOuter, phi_E1, y_E1);
                extraPhis[k + 1] = phi_E1;

                // Subtle radial joint bevel margin
                float bevelMargin = 0.008f;
                float th0_b = th0 + (k > 0 ? bevelMargin : 0.0f);
                float th1_b = th1 - (k < numVoussoirs - 1 ? bevelMargin : 0.0f);

                Vec3 pI0 = evalEllipse(aOuter, bOuter, evalIntraPhi(th0_b), evalIntraY(th0_b));
                Vec3 pI1 = evalEllipse(aOuter, bOuter, evalIntraPhi(th1_b), evalIntraY(th1_b));
                Vec3 pE0 = evalEllipse(aOuter, bOuter, evalExtraPhi(th0_b), evalExtraY(th0_b));
                Vec3 pE1 = evalEllipse(aOuter, bOuter, evalExtraPhi(th1_b), evalExtraY(th1_b));

                Vec3 nMid = evalEllipseNormal(aOuter, bOuter, 0.5f * (phi_I0 + phi_I1));
                addQuad(mesh, {pI0, nMid, Vec2(0,0)}, {pI1, nMid, Vec2(1,0)},
                              {pE1, nMid, Vec2(1,1)}, {pE0, nMid, Vec2(0,1)}, 0, &params);

                // Shadow Joint between adjacent voussoirs (matIdx = 5)
                if (k < numVoussoirs - 1 && k != keystoneIdx - 1) {
                    Vec3 jI0 = pI1;
                    Vec3 jI1 = evalEllipse(aOuter, bOuter, evalIntraPhi(th1 + bevelMargin), evalIntraY(th1 + bevelMargin));
                    Vec3 jE0 = pE1;
                    Vec3 jE1 = evalEllipse(aOuter, bOuter, evalExtraPhi(th1 + bevelMargin), evalExtraY(th1 + bevelMargin));
                    addQuad(mesh, {jI0, nMid, Vec2(0,0)}, {jI1, nMid, Vec2(1,0)},
                                  {jE1, nMid, Vec2(1,1)}, {jE0, nMid, Vec2(0,1)}, 5, &params);
                }
            }
        }

        // 5. SPANDRELS (Travertine ashlar wall from voussoir extrados up to tier top yHi - matIdx = 0)
        for (int k = 0; k < numVoussoirs; ++k) {
            Vec3 pE0 = extraPts[k];
            Vec3 pE1 = extraPts[k + 1];
            float phiE0 = extraPhis[k];
            float phiE1 = extraPhis[k + 1];

            Vec3 top0 = evalEllipse(aOuter, bOuter, phiE0, yHi);
            Vec3 top1 = evalEllipse(aOuter, bOuter, phiE1, yHi);
            Vec3 n0 = evalEllipseNormal(aOuter, bOuter, phiE0);
            Vec3 n1 = evalEllipseNormal(aOuter, bOuter, phiE1);

            addQuad(mesh, {pE0, n0, Vec2(0,0)}, {pE1, n1, Vec2(1,0)},
                          {top1, n1, Vec2(1,1)}, {top0, n0, Vec2(0,1)}, 0, &params);
        }

        // Flanking pier spandrels from springline to yHi
        float phiArchL = extraPhis[0];
        float phiArchR = extraPhis[numVoussoirs];

        if (phiArchL > phiStart) {
            Vec3 f0 = evalEllipse(aOuter, bOuter, phiStart, ySpring);
            Vec3 f1 = evalEllipse(aOuter, bOuter, phiArchL, ySpring);
            Vec3 f2 = evalEllipse(aOuter, bOuter, phiArchL, yHi);
            Vec3 f3 = evalEllipse(aOuter, bOuter, phiStart, yHi);
            Vec3 n = evalEllipseNormal(aOuter, bOuter, 0.5f * (phiStart + phiArchL));
            addQuad(mesh, {f0, n, Vec2(0,0)}, {f1, n, Vec2(1,0)},
                          {f2, n, Vec2(1,1)}, {f3, n, Vec2(0,1)}, 0, &params);
        }
        if (phiEnd > phiArchR) {
            Vec3 f0 = evalEllipse(aOuter, bOuter, phiArchR, ySpring);
            Vec3 f1 = evalEllipse(aOuter, bOuter, phiEnd, ySpring);
            Vec3 f2 = evalEllipse(aOuter, bOuter, phiEnd, yHi);
            Vec3 f3 = evalEllipse(aOuter, bOuter, phiArchR, yHi);
            Vec3 n = evalEllipseNormal(aOuter, bOuter, 0.5f * (phiArchR + phiEnd));
            addQuad(mesh, {f0, n, Vec2(0,0)}, {f1, n, Vec2(1,0)},
                          {f2, n, Vec2(1,1)}, {f3, n, Vec2(0,1)}, 0, &params);
        }
    }

    static void buildAtticBayTier(ScratchboxMesh& mesh, const SbArchiParams& params, const TierDefinition& tier,
                                 int bayIdx, float phiStart, float phiEnd, float phiMid,
                                 float aOuter, float bOuter, float aInner, float bInner) {
        float yLo = tier.elevationBaseMeters;
        float yHi = tier.elevationTopMeters;

        bool hasWindow = (bayIdx % params.atticWindowModulo == 0);

        if (!hasWindow) {
            // Solid ashlar travertine wall
            Vec3 v0 = evalEllipse(aOuter, bOuter, phiStart, yLo);
            Vec3 v1 = evalEllipse(aOuter, bOuter, phiEnd, yLo);
            Vec3 v2 = evalEllipse(aOuter, bOuter, phiEnd, yHi);
            Vec3 v3 = evalEllipse(aOuter, bOuter, phiStart, yHi);

            Vertex vt0{ v0, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0.0f, 0.0f) };
            Vertex vt1{ v1, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1.0f, 0.0f) };
            Vertex vt2{ v2, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1.0f, 1.0f) };
            Vertex vt3{ v3, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0.0f, 1.0f) };
            addQuad(mesh, vt0, vt1, vt2, vt3, 0);
        } else {
            // Wall with rectangular window aperture
            float winYLo = params.atticWindowElevation;
            float winYHi = winYLo + params.atticWindowHeight;
            float winPhiHalf = (phiEnd - phiStart) * 0.18f;
            float winPhi0 = phiMid - winPhiHalf;
            float winPhi1 = phiMid + winPhiHalf;

            // Lower wall section (yLo to winYLo)
            Vec3 v0 = evalEllipse(aOuter, bOuter, phiStart, yLo);
            Vec3 v1 = evalEllipse(aOuter, bOuter, phiEnd, yLo);
            Vec3 v2 = evalEllipse(aOuter, bOuter, phiEnd, winYLo);
            Vec3 v3 = evalEllipse(aOuter, bOuter, phiStart, winYLo);
            addQuad(mesh, {v0, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,0)},
                         {v1, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,0)},
                         {v2, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,0.4f)},
                         {v3, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,0.4f)}, 0);

            // Upper wall section (winYHi to yHi)
            Vec3 vU0 = evalEllipse(aOuter, bOuter, phiStart, winYHi);
            Vec3 vU1 = evalEllipse(aOuter, bOuter, phiEnd, winYHi);
            Vec3 vU2 = evalEllipse(aOuter, bOuter, phiEnd, yHi);
            Vec3 vU3 = evalEllipse(aOuter, bOuter, phiStart, yHi);
            addQuad(mesh, {vU0, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,0.7f)},
                         {vU1, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,0.7f)},
                         {vU2, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,1.0f)},
                         {vU3, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,1.0f)}, 0);

            // Left & Right jambs
            Vec3 vJL0 = evalEllipse(aOuter, bOuter, phiStart, winYLo);
            Vec3 vJL1 = evalEllipse(aOuter, bOuter, winPhi0, winYLo);
            Vec3 vJL2 = evalEllipse(aOuter, bOuter, winPhi0, winYHi);
            Vec3 vJL3 = evalEllipse(aOuter, bOuter, phiStart, winYHi);
            addQuad(mesh, {vJL0, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,0.4f)},
                         {vJL1, evalEllipseNormal(aOuter, bOuter, winPhi0), Vec2(0.3f,0.4f)},
                         {vJL2, evalEllipseNormal(aOuter, bOuter, winPhi0), Vec2(0.3f,0.7f)},
                         {vJL3, evalEllipseNormal(aOuter, bOuter, phiStart), Vec2(0,0.7f)}, 0);

            Vec3 vJR0 = evalEllipse(aOuter, bOuter, winPhi1, winYLo);
            Vec3 vJR1 = evalEllipse(aOuter, bOuter, phiEnd, winYLo);
            Vec3 vJR2 = evalEllipse(aOuter, bOuter, phiEnd, winYHi);
            Vec3 vJR3 = evalEllipse(aOuter, bOuter, winPhi1, winYHi);
            addQuad(mesh, {vJR0, evalEllipseNormal(aOuter, bOuter, winPhi1), Vec2(0.7f,0.4f)},
                         {vJR1, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,0.4f)},
                         {vJR2, evalEllipseNormal(aOuter, bOuter, phiEnd), Vec2(1,0.7f)},
                         {vJR3, evalEllipseNormal(aOuter, bOuter, winPhi1), Vec2(0.7f,0.7f)}, 0);

            // Window reveal sill & head (opening inwards)
            float aWindowInner = aOuter - 1.2f;
            float bWindowInner = bOuter - 1.2f;
            Vec3 vSillOut0 = evalEllipse(aOuter, bOuter, winPhi0, winYLo);
            Vec3 vSillOut1 = evalEllipse(aOuter, bOuter, winPhi1, winYLo);
            Vec3 vSillIn1 = evalEllipse(aWindowInner, bWindowInner, winPhi1, winYLo);
            Vec3 vSillIn0 = evalEllipse(aWindowInner, bWindowInner, winPhi0, winYLo);
            addQuad(mesh, {vSillOut0, Vec3(0,1,0), Vec2(0,0)},
                         {vSillOut1, Vec3(0,1,0), Vec2(1,0)},
                         {vSillIn1, Vec3(0,1,0), Vec2(1,1)},
                         {vSillIn0, Vec3(0,1,0), Vec2(0,1)}, 0);
        }
    }

    static void buildEngagedColumn(ScratchboxMesh& mesh, const SbArchiParams& params, const TierDefinition& tier,
                                  float phi, float yLo, float yHi, float aOuter, float bOuter) {
        Vec3 baseCenter = evalEllipse(aOuter, bOuter, phi, yLo);
        Vec3 normal = evalEllipseNormal(aOuter, bOuter, phi);
        Vec3 tangent(-normal.z, 0.0f, normal.x);

        float rCol = tier.columnRadiusMeters;
        float colProjection = tier.columnProjectionMeters;
        int nSegs = params.columnRadialSegments;

        // Position column center protruding outward from pier face
        Vec3 colCenterLo = baseCenter + normal * colProjection;
        float hColumn = (yHi - yLo) - tier.entablatureHeightMeters;

        // Semicircular engaged cylinder protruding from wall
        for (int i = 0; i < nSegs; ++i) {
            float th0 = -PI * 0.5f + (static_cast<float>(i) / nSegs) * PI;
            float th1 = -PI * 0.5f + (static_cast<float>(i + 1) / nSegs) * PI;

            // Subtle classical entasis: 6% taper at top of shaft
            float rBase = rCol;
            float rTop = rCol * 0.94f;

            Vec3 offset0_Lo = (tangent * std::cos(th0) + normal * std::sin(th0)) * rBase;
            Vec3 offset1_Lo = (tangent * std::cos(th1) + normal * std::sin(th1)) * rBase;
            Vec3 offset0_Hi = (tangent * std::cos(th0) + normal * std::sin(th0)) * rTop;
            Vec3 offset1_Hi = (tangent * std::cos(th1) + normal * std::sin(th1)) * rTop;

            Vec3 p0_Lo = colCenterLo + offset0_Lo;
            Vec3 p1_Lo = colCenterLo + offset1_Lo;
            Vec3 p0_Hi = colCenterLo + offset0_Hi + Vec3(0.0f, hColumn, 0.0f);
            Vec3 p1_Hi = colCenterLo + offset1_Hi + Vec3(0.0f, hColumn, 0.0f);

            Vec3 n0 = math::normalize(offset0_Lo);
            Vec3 n1 = math::normalize(offset1_Lo);

            float u0 = static_cast<float>(i) / nSegs;
            float u1 = static_cast<float>(i + 1) / nSegs;

            addQuad(mesh, {p0_Lo, n0, Vec2(u0, 0.0f)},
                         {p1_Lo, n1, Vec2(u1, 0.0f)},
                         {p1_Hi, n1, Vec2(u1, 1.0f)},
                         {p0_Hi, n0, Vec2(u0, 1.0f)}, 0);
        }

        // Add capital block at top of column
        float capHeight = 0.85f;
        Vec3 capCenter = colCenterLo + Vec3(0.0f, hColumn, 0.0f);
        float rCap = rCol * 1.35f;

        // Simple projecting abacus / echinus block
        Vec3 c0 = capCenter + (-tangent * rCap + normal * (colProjection - rCap * 0.2f));
        Vec3 c1 = capCenter + (tangent * rCap + normal * (colProjection - rCap * 0.2f));
        Vec3 c2 = capCenter + (tangent * rCap + normal * (colProjection + rCap * 1.1f));
        Vec3 c3 = capCenter + (-tangent * rCap + normal * (colProjection + rCap * 1.1f));

        addQuad(mesh, {c0, normal, Vec2(0,0)},
                     {c1, normal, Vec2(1,0)},
                     {c1 + Vec3(0, capHeight, 0), normal, Vec2(1,1)},
                     {c0 + Vec3(0, capHeight, 0), normal, Vec2(0,1)}, 0);
    }

    static void buildEntablaturesAndCornices(ScratchboxMesh& mesh, const SbArchiParams& params, int activeBays, float deltaAngle) {
        float aOuter = params.semiMajorAxisA;
        float bOuter = params.semiMinorAxisB;

        // Build continuous horizontal entablature mouldings dividing each tier
        for (const auto& tier : params.tiers) {
            float yEntablature = tier.elevationTopMeters;
            float corniceProjection = 0.65f;
            float corniceHeight = 0.85f;

            for (int b = 0; b < activeBays; ++b) {
                float phi0 = params.arcStartRad + b * deltaAngle;
                float phi1 = phi0 + deltaAngle;

                Vec3 n0 = evalEllipseNormal(aOuter, bOuter, phi0);
                Vec3 n1 = evalEllipseNormal(aOuter, bOuter, phi1);

                // Projecting horizontal cornice fascia
                Vec3 p0_Lo = evalEllipse(aOuter + corniceProjection, bOuter + corniceProjection, phi0, yEntablature - corniceHeight);
                Vec3 p1_Lo = evalEllipse(aOuter + corniceProjection, bOuter + corniceProjection, phi1, yEntablature - corniceHeight);
                Vec3 p0_Hi = evalEllipse(aOuter + corniceProjection, bOuter + corniceProjection, phi0, yEntablature);
                Vec3 p1_Hi = evalEllipse(aOuter + corniceProjection, bOuter + corniceProjection, phi1, yEntablature);

                addQuad(mesh, {p0_Lo, n0, Vec2(0,0)},
                             {p1_Lo, n1, Vec2(1,0)},
                             {p1_Hi, n1, Vec2(1,1)},
                             {p0_Hi, n0, Vec2(0,1)}, 0);

                // Top ledge of cornice
                Vec3 p0_In = evalEllipse(aOuter, bOuter, phi0, yEntablature);
                Vec3 p1_In = evalEllipse(aOuter, bOuter, phi1, yEntablature);

                addQuad(mesh, {p0_Hi, Vec3(0,1,0), Vec2(0,0)},
                             {p1_Hi, Vec3(0,1,0), Vec2(1,0)},
                             {p1_In, Vec3(0,1,0), Vec2(1,1)},
                             {p0_In, Vec3(0,1,0), Vec2(0,1)}, 0);
            }
        }
    }

    static void buildAnnularAmbulatories(ScratchboxMesh& mesh, const SbArchiParams& params, int activeBays, float deltaAngle) {
        float a1_in = params.semiMajorAxisA - params.wallDepthMeters;
        float b1_in = params.semiMinorAxisB - params.wallDepthMeters;
        float a2_out = params.ambulatoryRing2MajorA;
        float b2_out = params.ambulatoryRing2MinorB;
        float a2_in = params.ambulatoryRing2MajorA - params.ambulatoryRing2WallDepth;
        float b2_in = params.ambulatoryRing2MinorB - params.ambulatoryRing2WallDepth;
        float a3_out = params.ambulatoryRing3MajorA;
        float b3_out = params.ambulatoryRing3MinorB;
        float a3_in = params.ambulatoryRing3MajorA - params.ambulatoryRing3WallDepth;
        float b3_in = params.ambulatoryRing3MinorB - params.ambulatoryRing3WallDepth;
        float a_podium = params.arenaSemiMajorAxis;
        float b_podium = params.arenaSemiMinorAxis;

        float yGround = 0.0f;
        float yVaultTier1 = params.tiers[0].elevationTopMeters; // 11.5m

        for (int b = 0; b < activeBays; ++b) {
            float phi0 = params.arcStartRad + b * deltaAngle;
            float phi1 = phi0 + deltaAngle;
            float phiMid = 0.5f * (phi0 + phi1);

            // -------------------------------------------------------------
            // Ring 1 Ambulatory Corridor (between Outer Arcade Wall and Ring 2 Wall)
            // -------------------------------------------------------------
            // Floor paving at ground datum (y = 0.0)
            Vec3 fl1_0 = evalEllipse(a1_in, b1_in, phi0, yGround);
            Vec3 fl1_1 = evalEllipse(a1_in, b1_in, phi1, yGround);
            Vec3 fl1_2 = evalEllipse(a2_out, b2_out, phi1, yGround);
            Vec3 fl1_3 = evalEllipse(a2_out, b2_out, phi0, yGround);
            addQuad(mesh, {fl1_0, Vec3(0,1,0), Vec2(0,0)},
                         {fl1_3, Vec3(0,1,0), Vec2(0,1)},
                         {fl1_2, Vec3(0,1,0), Vec2(1,1)},
                         {fl1_1, Vec3(0,1,0), Vec2(1,0)}, 4, &params);

            // Annular barrel vault ceiling overhead at Tier 1 (y = yVaultTier1)
            Vec3 cl1_0 = evalEllipse(a1_in, b1_in, phi0, yVaultTier1);
            Vec3 cl1_1 = evalEllipse(a1_in, b1_in, phi1, yVaultTier1);
            Vec3 cl1_2 = evalEllipse(a2_out, b2_out, phi1, yVaultTier1);
            Vec3 cl1_3 = evalEllipse(a2_out, b2_out, phi0, yVaultTier1);
            addQuad(mesh, {cl1_0, Vec3(0,-1,0), Vec2(0,0)},
                         {cl1_1, Vec3(0,-1,0), Vec2(1,0)},
                         {cl1_2, Vec3(0,-1,0), Vec2(1,1)},
                         {cl1_3, Vec3(0,-1,0), Vec2(0,1)}, 1, &params);

            // -------------------------------------------------------------
            // Ring 2 Intermediate Wall (Ashlar Piers & Vomitorium Arch Passages)
            // -------------------------------------------------------------
            float archPhi0 = phi0 + deltaAngle * 0.25f;
            float archPhi1 = phi1 - deltaAngle * 0.25f;
            float archSpringY = 5.5f;
            float archApexY = 8.8f;

            // Outer face left and right piers (facing outward to Ring 1)
            buildAshlarPierFace(mesh, params, a2_out, b2_out, phi0, archPhi0, yGround, yVaultTier1, false);
            buildAshlarPierFace(mesh, params, a2_out, b2_out, archPhi1, phi1, yGround, yVaultTier1, false);

            // Inner face left and right piers (facing inward to Ring 2 corridor)
            buildAshlarPierFace(mesh, params, a2_in, b2_in, phi0, archPhi0, yGround, yVaultTier1, true);
            buildAshlarPierFace(mesh, params, a2_in, b2_in, archPhi1, phi1, yGround, yVaultTier1, true);

            // Vomitorium passage side walls (tunnel jambs through 3.0m thick wall)
            Vec3 wL_out0 = evalEllipse(a2_out, b2_out, archPhi0, yGround);
            Vec3 wL_in0  = evalEllipse(a2_in,  b2_in,  archPhi0, yGround);
            Vec3 wL_in1  = evalEllipse(a2_in,  b2_in,  archPhi0, archSpringY);
            Vec3 wL_out1 = evalEllipse(a2_out, b2_out, archPhi0, archSpringY);
            Vec3 nWallL = evalEllipseTangent(a2_out, b2_out, archPhi0);
            addQuad(mesh, {wL_out0, nWallL, Vec2(0,0)},
                         {wL_in0,  nWallL, Vec2(1,0)},
                         {wL_in1,  nWallL, Vec2(1,1)},
                         {wL_out1, nWallL, Vec2(0,1)}, 0, &params);

            Vec3 wR_out0 = evalEllipse(a2_out, b2_out, archPhi1, yGround);
            Vec3 wR_in0  = evalEllipse(a2_in,  b2_in,  archPhi1, yGround);
            Vec3 wR_in1  = evalEllipse(a2_in,  b2_in,  archPhi1, archSpringY);
            Vec3 wR_out1 = evalEllipse(a2_out, b2_out, archPhi1, archSpringY);
            Vec3 nWallR = -evalEllipseTangent(a2_out, b2_out, archPhi1);
            addQuad(mesh, {wR_out0, nWallR, Vec2(0,0)},
                         {wR_out1, nWallR, Vec2(0,1)},
                         {wR_in1,  nWallR, Vec2(1,1)},
                         {wR_in0,  nWallR, Vec2(1,0)}, 0, &params);

            // Vomitorium barrel vault ceiling through Ring 2 wall
            int archSegs = 8;
            float archRadY = archApexY - archSpringY;
            for (int s = 0; s < archSegs; ++s) {
                float theta0 = (static_cast<float>(s) / archSegs) * PI;
                float theta1 = (static_cast<float>(s + 1) / archSegs) * PI;

                float frac0 = 0.5f - 0.5f * std::cos(theta0);
                float frac1 = 0.5f - 0.5f * std::cos(theta1);
                float phiS0 = archPhi0 + frac0 * (archPhi1 - archPhi0);
                float phiS1 = archPhi0 + frac1 * (archPhi1 - archPhi0);

                float yS0 = archSpringY + std::sin(theta0) * archRadY;
                float yS1 = archSpringY + std::sin(theta1) * archRadY;

                Vec3 vOut0 = evalEllipse(a2_out, b2_out, phiS0, yS0);
                Vec3 vOut1 = evalEllipse(a2_out, b2_out, phiS1, yS1);
                Vec3 vIn1  = evalEllipse(a2_in,  b2_in,  phiS1, yS1);
                Vec3 vIn0  = evalEllipse(a2_in,  b2_in,  phiS0, yS0);

                Vec3 normVault = Vec3(0, -1, 0);
                addQuad(mesh, {vOut0, normVault, Vec2(0,0)},
                             {vIn0,  normVault, Vec2(1,0)},
                             {vIn1,  normVault, Vec2(1,1)},
                             {vOut1, normVault, Vec2(0,1)}, 1, &params);
            }

            // Spandrel wall above vomitorium arch up to yVaultTier1
            Vec3 spL_out = evalEllipse(a2_out, b2_out, archPhi0, archSpringY);
            Vec3 spR_out = evalEllipse(a2_out, b2_out, archPhi1, archSpringY);
            Vec3 spTL_out = evalEllipse(a2_out, b2_out, archPhi0, yVaultTier1);
            Vec3 spTR_out = evalEllipse(a2_out, b2_out, archPhi1, yVaultTier1);
            Vec3 nSpOut = evalEllipseNormal(a2_out, b2_out, phiMid);
            addQuad(mesh, {spL_out, nSpOut, Vec2(0,0)},
                         {spR_out, nSpOut, Vec2(1,0)},
                         {spTR_out, nSpOut, Vec2(1,1)},
                         {spTL_out, nSpOut, Vec2(0,1)}, 0, &params);

            Vec3 spL_in = evalEllipse(a2_in, b2_in, archPhi0, archSpringY);
            Vec3 spR_in = evalEllipse(a2_in, b2_in, archPhi1, archSpringY);
            Vec3 spTL_in = evalEllipse(a2_in, b2_in, archPhi0, yVaultTier1);
            Vec3 spTR_in = evalEllipse(a2_in, b2_in, archPhi1, yVaultTier1);
            Vec3 nSpIn = -evalEllipseNormal(a2_in, b2_in, phiMid);
            addQuad(mesh, {spL_in, nSpIn, Vec2(0,0)},
                         {spTL_in, nSpIn, Vec2(0,1)},
                         {spTR_in, nSpIn, Vec2(1,1)},
                         {spR_in, nSpIn, Vec2(1,0)}, 0, &params);

            // -------------------------------------------------------------
            // Ring 2 Ambulatory Corridor (between Ring 2 and Ring 3)
            // -------------------------------------------------------------
            // Floor paving
            Vec3 fl2_0 = evalEllipse(a2_in, b2_in, phi0, yGround);
            Vec3 fl2_1 = evalEllipse(a2_in, b2_in, phi1, yGround);
            Vec3 fl2_2 = evalEllipse(a3_out, b3_out, phi1, yGround);
            Vec3 fl2_3 = evalEllipse(a3_out, b3_out, phi0, yGround);
            addQuad(mesh, {fl2_0, Vec3(0,1,0), Vec2(0,0)},
                         {fl2_3, Vec3(0,1,0), Vec2(0,1)},
                         {fl2_2, Vec3(0,1,0), Vec2(1,1)},
                         {fl2_1, Vec3(0,1,0), Vec2(1,0)}, 4, &params);

            // Ceiling overhead
            Vec3 cl2_0 = evalEllipse(a2_in, b2_in, phi0, yVaultTier1);
            Vec3 cl2_1 = evalEllipse(a2_in, b2_in, phi1, yVaultTier1);
            Vec3 cl2_2 = evalEllipse(a3_out, b3_out, phi1, yVaultTier1);
            Vec3 cl2_3 = evalEllipse(a3_out, b3_out, phi0, yVaultTier1);
            addQuad(mesh, {cl2_0, Vec3(0,-1,0), Vec2(0,0)},
                         {cl2_1, Vec3(0,-1,0), Vec2(1,0)},
                         {cl2_2, Vec3(0,-1,0), Vec2(1,1)},
                         {cl2_3, Vec3(0,-1,0), Vec2(0,1)}, 1, &params);

            // -------------------------------------------------------------
            // Ring 3 Wall & Cavea Seating Bowl Substructure
            // -------------------------------------------------------------
            // Ring 3 outer wall facing Ring 2 corridor
            Vec3 r3w0 = evalEllipse(a3_out, b3_out, phi0, yGround);
            Vec3 r3w1 = evalEllipse(a3_out, b3_out, phi1, yGround);
            Vec3 r3w2 = evalEllipse(a3_out, b3_out, phi1, yVaultTier1);
            Vec3 r3w3 = evalEllipse(a3_out, b3_out, phi0, yVaultTier1);
            Vec3 nR3Out = evalEllipseNormal(a3_out, b3_out, phiMid);
            addQuad(mesh, {r3w0, nR3Out, Vec2(0,0)},
                         {r3w1, nR3Out, Vec2(1,0)},
                         {r3w2, nR3Out, Vec2(1,1)},
                         {r3w3, nR3Out, Vec2(0,1)}, 0, &params);

            // Cavea Stepped Seating Rows (from Ring 3 inner wall to Arena Podium)
            int nSteps = params.caveaStepCount;
            float yPodium = params.arenaPodiumElevation; // 3.8m
            for (int s = 0; s < nSteps; ++s) {
                float tStep0 = static_cast<float>(s) / nSteps;
                float tStep1 = static_cast<float>(s + 1) / nSteps;

                float aStep0 = a3_in - tStep0 * (a3_in - a_podium);
                float aStep1 = a3_in - tStep1 * (a3_in - a_podium);
                float bStep0 = b3_in - tStep0 * (b3_in - b_podium);
                float bStep1 = b3_in - tStep1 * (b3_in - b_podium);

                float yS0 = yVaultTier1 - tStep0 * (yVaultTier1 - yPodium);
                float yS1 = yVaultTier1 - tStep1 * (yVaultTier1 - yPodium);

                // Horizontal Tread (marble seat slab) at yS0
                Vec3 tr0 = evalEllipse(aStep0, bStep0, phi0, yS0);
                Vec3 tr1 = evalEllipse(aStep0, bStep0, phi1, yS0);
                Vec3 tr2 = evalEllipse(aStep1, bStep1, phi1, yS0);
                Vec3 tr3 = evalEllipse(aStep1, bStep1, phi0, yS0);
                addQuad(mesh, {tr0, Vec3(0,1,0), Vec2(0,0)},
                             {tr3, Vec3(0,1,0), Vec2(0,1)},
                             {tr2, Vec3(0,1,0), Vec2(1,1)},
                             {tr1, Vec3(0,1,0), Vec2(1,0)}, 4, &params);

                // Vertical Riser (travertine step front) from yS1 to yS0 at inner edge
                Vec3 ris0 = evalEllipse(aStep1, bStep1, phi0, yS1);
                Vec3 ris1 = evalEllipse(aStep1, bStep1, phi1, yS1);
                Vec3 ris2 = evalEllipse(aStep1, bStep1, phi1, yS0);
                Vec3 ris3 = evalEllipse(aStep1, bStep1, phi0, yS0);
                Vec3 nRiser = -evalEllipseNormal(aStep1, bStep1, phiMid);
                addQuad(mesh, {ris0, nRiser, Vec2(0,0)},
                             {ris1, nRiser, Vec2(1,0)},
                             {ris2, nRiser, Vec2(1,1)},
                             {ris3, nRiser, Vec2(0,1)}, 0, &params);
            }

            // Arena Podium Wall (facing arena floor inward from yGround to yPodium)
            Vec3 pod0 = evalEllipse(a_podium, b_podium, phi0, yGround);
            Vec3 pod1 = evalEllipse(a_podium, b_podium, phi1, yGround);
            Vec3 pod2 = evalEllipse(a_podium, b_podium, phi1, yPodium);
            Vec3 pod3 = evalEllipse(a_podium, b_podium, phi0, yPodium);
            Vec3 nPod = -evalEllipseNormal(a_podium, b_podium, phiMid);
            addQuad(mesh, {pod0, nPod, Vec2(0,0)},
                         {pod1, nPod, Vec2(1,0)},
                         {pod2, nPod, Vec2(1,1)},
                         {pod3, nPod, Vec2(0,1)}, 0, &params);
        }
    }

    static void buildSubterraneanHypogeum(ScratchboxMesh& mesh, const SbArchiParams& params) {
        float aArena = params.arenaSemiMajorAxis; // 43.5m
        float bArena = params.arenaSemiMinorAxis; // 29.0m
        float yHypo = params.hypogeumFloorElevation; // -5.8m
        float yDrain = params.hypogeumDrainageElevation; // -6.1m
        float yGround = 0.0f; // Arena datum

        int perimeterSegs = 48;
        float dPhi = TWO_PI / perimeterSegs;

        // 1. Hypogeum Outer Perimeter Retaining Wall (from yHypo = -5.8m up to yGround = 0.0m)
        for (int i = 0; i < perimeterSegs; ++i) {
            float phi0 = i * dPhi;
            float phi1 = (i + 1) * dPhi;
            float phiMid = 0.5f * (phi0 + phi1);

            Vec3 v0 = evalEllipse(aArena, bArena, phi0, yHypo);
            Vec3 v1 = evalEllipse(aArena, bArena, phi1, yHypo);
            Vec3 v2 = evalEllipse(aArena, bArena, phi1, yGround);
            Vec3 v3 = evalEllipse(aArena, bArena, phi0, yGround);
            Vec3 nWall = -evalEllipseNormal(aArena, bArena, phiMid); // Facing inward to hypogeum
            addQuad(mesh, {v0, nWall, Vec2(0,0)},
                         {v1, nWall, Vec2(1,0)},
                         {v2, nWall, Vec2(1,1)},
                         {v3, nWall, Vec2(0,1)}, 2, &params); // matIdx = 2 (Hypogeum Tufa/Brick)
        }

        // 2. Euripus Drainage Perimeter Canal (at yDrain = -6.1m)
        // Canal width = 1.5m
        float aCanalIn = aArena - 1.5f;
        float bCanalIn = bArena - 1.5f;

        for (int i = 0; i < perimeterSegs; ++i) {
            float phi0 = i * dPhi;
            float phi1 = (i + 1) * dPhi;
            float phiMid = 0.5f * (phi0 + phi1);

            // Drainage bed slab at yDrain (-6.1m)
            Vec3 d0 = evalEllipse(aArena, bArena, phi0, yDrain);
            Vec3 d1 = evalEllipse(aArena, bArena, phi1, yDrain);
            Vec3 d2 = evalEllipse(aCanalIn, bCanalIn, phi1, yDrain);
            Vec3 d3 = evalEllipse(aCanalIn, bCanalIn, phi0, yDrain);
            addQuad(mesh, {d0, Vec3(0,1,0), Vec2(0,0)},
                         {d3, Vec3(0,1,0), Vec2(0,1)},
                         {d2, Vec3(0,1,0), Vec2(1,1)},
                         {d1, Vec3(0,1,0), Vec2(1,0)}, 7, &params); // matIdx = 7 (Drainage Slab)

            // Canal outer curb drop (from yHypo -5.8m down to yDrain -6.1m)
            Vec3 o0 = evalEllipse(aArena, bArena, phi0, yDrain);
            Vec3 o1 = evalEllipse(aArena, bArena, phi1, yDrain);
            Vec3 o2 = evalEllipse(aArena, bArena, phi1, yHypo);
            Vec3 o3 = evalEllipse(aArena, bArena, phi0, yHypo);
            Vec3 nCanalOut = -evalEllipseNormal(aArena, bArena, phiMid);
            addQuad(mesh, {o0, nCanalOut, Vec2(0,0)},
                         {o1, nCanalOut, Vec2(1,0)},
                         {o2, nCanalOut, Vec2(1,1)},
                         {o3, nCanalOut, Vec2(0,1)}, 7, &params);

            // Canal inner curb step (from yDrain -6.1m up to yHypo -5.8m)
            Vec3 c0 = evalEllipse(aCanalIn, bCanalIn, phi0, yDrain);
            Vec3 c1 = evalEllipse(aCanalIn, bCanalIn, phi1, yDrain);
            Vec3 c2 = evalEllipse(aCanalIn, bCanalIn, phi1, yHypo);
            Vec3 c3 = evalEllipse(aCanalIn, bCanalIn, phi0, yHypo);
            Vec3 nCanalIn = evalEllipseNormal(aCanalIn, bCanalIn, phiMid);
            addQuad(mesh, {c0, nCanalIn, Vec2(0,0)},
                         {c3, nCanalIn, Vec2(0,1)},
                         {c2, nCanalIn, Vec2(1,1)},
                         {c1, nCanalIn, Vec2(1,0)}, 7, &params);
        }

        // 3. Hypogeum Subterranean Floor (at yHypo = -5.8m from canal inner lip inward)
        for (int i = 0; i < perimeterSegs; ++i) {
            float phi0 = i * dPhi;
            float phi1 = (i + 1) * dPhi;

            Vec3 f0 = evalEllipse(aCanalIn, bCanalIn, phi0, yHypo);
            Vec3 f1 = evalEllipse(aCanalIn, bCanalIn, phi1, yHypo);
            Vec3 fCenter(0.0f, yHypo, 0.0f);

            // Fan to center
            addTriangle(mesh, {f0, Vec3(0,1,0), Vec2(0,0)},
                              {fCenter, Vec3(0,1,0), Vec2(0.5f, 0.5f)},
                              {f1, Vec3(0,1,0), Vec2(1,0)}, 2, &params);
        }

        // 4. Concentric Labyrinth Masonry Service Walls (The Hypogeum Maze)
        int nWalls = params.hypogeumConcentricWalls; // 4
        float wallThick = 0.75f;
        float yWallTop = -0.3f; // Wall crowns just under arena floor beams

        for (int w = 1; w <= nWalls; ++w) {
            float frac = static_cast<float>(w) / (nWalls + 1);
            float aWallOut = aCanalIn * frac;
            float bWallOut = bCanalIn * frac;
            float aWallIn = aWallOut - wallThick;
            float bWallIn = bWallOut - wallThick;
            if (aWallIn < 2.0f || bWallIn < 2.0f) continue;

            for (int i = 0; i < perimeterSegs; ++i) {
                float phi0 = i * dPhi;
                float phi1 = (i + 1) * dPhi;
                float phiMid = 0.5f * (phi0 + phi1);

                // Keep central gladiator corridor clear along major axis (Z near 0)
                // and minor axis (X near 0)
                Vec3 pMid = evalEllipse(aWallOut, bWallOut, phiMid, yHypo);
                if (std::abs(pMid.z) < (params.hypogeumCentralCorridorWidth * 0.5f)) continue;
                if (std::abs(pMid.x) < (params.hypogeumCrossCorridorWidth * 0.5f)) continue;

                // Wall outer face
                Vec3 wO0 = evalEllipse(aWallOut, bWallOut, phi0, yHypo);
                Vec3 wO1 = evalEllipse(aWallOut, bWallOut, phi1, yHypo);
                Vec3 wO2 = evalEllipse(aWallOut, bWallOut, phi1, yWallTop);
                Vec3 wO3 = evalEllipse(aWallOut, bWallOut, phi0, yWallTop);
                Vec3 nOut = evalEllipseNormal(aWallOut, bWallOut, phiMid);
                addQuad(mesh, {wO0, nOut, Vec2(0,0)},
                             {wO1, nOut, Vec2(1,0)},
                             {wO2, nOut, Vec2(1,1)},
                             {wO3, nOut, Vec2(0,1)}, 2, &params);

                // Wall inner face
                Vec3 wI0 = evalEllipse(aWallIn, bWallIn, phi0, yHypo);
                Vec3 wI1 = evalEllipse(aWallIn, bWallIn, phi1, yHypo);
                Vec3 wI2 = evalEllipse(aWallIn, bWallIn, phi1, yWallTop);
                Vec3 wI3 = evalEllipse(aWallIn, bWallIn, phi0, yWallTop);
                Vec3 nIn = -evalEllipseNormal(aWallIn, bWallIn, phiMid);
                addQuad(mesh, {wI0, nIn, Vec2(0,0)},
                             {wI3, nIn, Vec2(0,1)},
                             {wI2, nIn, Vec2(1,1)},
                             {wI1, nIn, Vec2(1,0)}, 2, &params);

                // Wall top coping
                addQuad(mesh, {wO3, Vec3(0,1,0), Vec2(0,0)},
                             {wI3, Vec3(0,1,0), Vec2(0,1)},
                             {wI2, Vec3(0,1,0), Vec2(1,1)},
                             {wO2, Vec3(0,1,0), Vec2(1,0)}, 2, &params);
            }
        }

        // 5. Beast Lift Elevator Shafts & Timber Winch Frames (28 Roman Mechanical Cages)
        int liftsPerSide = 14;
        for (int side = -1; side <= 1; side += 2) {
            for (int l = 0; l < liftsPerSide; ++l) {
                float phi = 0.25f + (static_cast<float>(l) / liftsPerSide) * (PI - 0.5f);
                if (side < 0) phi += PI;

                float liftRadiusA = aCanalIn * 0.62f;
                float liftRadiusB = bCanalIn * 0.62f;
                Vec3 centerPos = evalEllipse(liftRadiusA, liftRadiusB, phi, yHypo);

                // Shaft dimensions: 1.8m x 1.8m timber cage
                float halfW = 0.9f;
                float timberPostThick = 0.15f;

                // 4 Vertical corner posts (Roman Timber, matIdx = 3)
                float xOffsets[4] = { -halfW, halfW, halfW, -halfW };
                float zOffsets[4] = { -halfW, -halfW, halfW, halfW };

                for (int p = 0; p < 4; ++p) {
                    Vec3 postLo = centerPos + Vec3(xOffsets[p], 0.0f, zOffsets[p]);
                    Vec3 postHi = postLo + Vec3(0.0f, yGround - yHypo, 0.0f);

                    // Front face of post
                    addQuad(mesh, {postLo, Vec3(0,0,1), Vec2(0,0)},
                                 {postLo + Vec3(timberPostThick, 0, 0), Vec3(0,0,1), Vec2(1,0)},
                                 {postHi + Vec3(timberPostThick, 0, 0), Vec3(0,0,1), Vec2(1,1)},
                                 {postHi, Vec3(0,0,1), Vec2(0,1)}, 3, &params);
                }

                // Intermediate elevator cage platform (at y = -3.2m)
                float yCage = -3.2f;
                Vec3 c0 = centerPos + Vec3(-halfW, yCage - yHypo, -halfW);
                Vec3 c1 = centerPos + Vec3( halfW, yCage - yHypo, -halfW);
                Vec3 c2 = centerPos + Vec3( halfW, yCage - yHypo,  halfW);
                Vec3 c3 = centerPos + Vec3(-halfW, yCage - yHypo,  halfW);
                addQuad(mesh, {c0, Vec3(0,1,0), Vec2(0,0)},
                             {c3, Vec3(0,1,0), Vec2(0,1)},
                             {c2, Vec3(0,1,0), Vec2(1,1)},
                             {c1, Vec3(0,1,0), Vec2(1,0)}, 3, &params);
            }
        }

        // 6. Partially Reconstructed Timber Arena Deck (The Staged Floor)
        // Western half (X <= arenaDeckExposedThresholdX = 5.0m) has timber plank decking;
        // Eastern half is open to reveal the subterranean maze to the sky!
        int deckSlices = 28;
        float xMin = -aArena;
        float xMax = params.arenaDeckExposedThresholdX;
        float dx = (xMax - xMin) / deckSlices;

        for (int s = 0; s < deckSlices; ++s) {
            float x0 = xMin + s * dx;
            float x1 = x0 + dx;

            float normX0 = x0 / aArena;
            float normX1 = x1 / aArena;
            if (std::abs(normX0) >= 1.0f || std::abs(normX1) >= 1.0f) continue;

            float zHalf0 = bArena * std::sqrt(std::max(0.0f, 1.0f - normX0 * normX0));
            float zHalf1 = bArena * std::sqrt(std::max(0.0f, 1.0f - normX1 * normX1));

            // Timber deck plank top surface at yGround = 0.0m
            Vec3 p0(x0, yGround, -zHalf0);
            Vec3 p1(x1, yGround, -zHalf1);
            Vec3 p2(x1, yGround,  zHalf1);
            Vec3 p3(x0, yGround,  zHalf0);

            addQuad(mesh, {p0, Vec3(0,1,0), Vec2(0,0)},
                         {p3, Vec3(0,1,0), Vec2(0,1)},
                         {p2, Vec3(0,1,0), Vec2(1,1)},
                         {p1, Vec3(0,1,0), Vec2(1,0)}, 3, &params); // matIdx = 3 (Roman Timber)

            // Timber deck underside surface at yGround - 0.25m
            float yPlankUnder = yGround - 0.25f;
            Vec3 u0(x0, yPlankUnder, -zHalf0);
            Vec3 u1(x1, yPlankUnder, -zHalf1);
            Vec3 u2(x1, yPlankUnder,  zHalf1);
            Vec3 u3(x0, yPlankUnder,  zHalf0);

            addQuad(mesh, {u0, Vec3(0,-1,0), Vec2(0,0)},
                         {u1, Vec3(0,-1,0), Vec2(1,0)},
                         {u2, Vec3(0,-1,0), Vec2(1,1)},
                         {u3, Vec3(0,-1,0), Vec2(0,1)}, 3, &params);
        }
    }
};

} // namespace sb_archi
} // namespace scratchbox

#endif // SCRATCHBOX_SB_ARCHI_HPP
