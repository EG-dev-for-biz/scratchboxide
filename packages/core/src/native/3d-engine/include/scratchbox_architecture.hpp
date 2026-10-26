/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ARCHITECTURE_HPP
#define SCRATCHBOX_ARCHITECTURE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <memory>
#include <cstdint>
#include <tuple>

namespace scratchbox {
namespace architecture {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::DEG_TO_RAD;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. ROOF & ENVELOPE TYPES
// ============================================================================

enum class RoofType {
    FlatParapet,  // Flat roof enclosed by a raised perimeter parapet wall with coping
    Gable,        // Classic triangular dual-pitch roof with vertical gable end walls
    Hip,          // Quad-sloped roof with sloping ends and ridge line
    Mansard,      // Double-sloped curb roof with steep lower pitch and shallow upper pitch
    Dome,         // Continuous semi-ellipsoidal dome
    BarrelVault   // Continuous cylindrical or parabolic barrel vault
};

struct BuildingMaterials {
    PbrMaterial wall{ "Wall_PBR" };
    PbrMaterial glass{ "Glass_PBR" };
    PbrMaterial frame{ "Frame_PBR" };
    PbrMaterial roof{ "Roof_PBR" };
    PbrMaterial foundation{ "Foundation_PBR" };

    static BuildingMaterials createArchitecturalPalette() {
        BuildingMaterials mats;
        // Wall: Architectural Limestone / Concrete
        mats.wall.baseColorFactor = Vec4(0.82f, 0.80f, 0.76f, 1.0f);
        mats.wall.roughnessFactor = 0.85f;
        mats.wall.metallicFactor = 0.04f;

        // Glass: High-transmission reflective architectural glazing
        mats.glass.baseColorFactor = Vec4(0.25f, 0.35f, 0.40f, 0.85f);
        mats.glass.roughnessFactor = 0.08f;
        mats.glass.metallicFactor = 0.20f;
        mats.glass.transmissionFactor = 0.90f;
        mats.glass.ior = 1.52f;

        // Frame: Anodized Dark Bronze / Aluminum Mullions
        mats.frame.baseColorFactor = Vec4(0.18f, 0.17f, 0.16f, 1.0f);
        mats.frame.roughnessFactor = 0.35f;
        mats.frame.metallicFactor = 0.88f;

        // Roof: Slate / Architectural Shingles
        mats.roof.baseColorFactor = Vec4(0.28f, 0.30f, 0.32f, 1.0f);
        mats.roof.roughnessFactor = 0.90f;
        mats.roof.metallicFactor = 0.05f;

        // Foundation: Cast-in-place concrete plinth
        mats.foundation.baseColorFactor = Vec4(0.55f, 0.54f, 0.52f, 1.0f);
        mats.foundation.roughnessFactor = 0.92f;
        mats.foundation.metallicFactor = 0.02f;

        return mats;
    }
};

// Facade detail elements for the rectangular generator. Every element is off at its zero / empty
// value. Profiles are closed (outward, up) point lists in metres measured from the element's anchor
// line on the wall face; they are swept along the element's path with mitred corners, so any
// moulding section can be described without a closed list of moulding kinds.
struct FacadeDetails {
    std::vector<Vec2> corniceProfile;       // swept around the eave line (replaces the box cornice)
    std::vector<Vec2> stringCourseProfile;  // swept around floor lines (replaces the box belt courses)
    std::vector<int> stringCourseFloors;    // floor lines to band (1 = top of ground floor); empty = all
    std::vector<Vec2> sillProfile;          // swept under each window (replaces the box sill)
    float sillHornM{0.08f};                 // sill extension past each jamb
    std::vector<Vec2> hoodProfile;          // swept over each window (replaces the box lintel)
    float hoodPitchDeg{0.0f};               // 0 = straight hood; above 0 the hood rises to a pediment apex
    float hoodExtensionM{0.08f};            // hood extension past each jamb

    float pilasterWidthM{0.0f};             // > 0 adds pilasters at bay boundaries
    float pilasterProjectionM{0.08f};
    int pilasterBayStride{1};               // every Nth bay boundary
    float pilasterCapitalM{0.30f};          // height of the flared base and capital blocks
    float pilasterFlare{1.35f};             // base / capital width relative to the shaft

    float quoinCourseM{0.0f};               // > 0 adds corner quoins with this course height
    float quoinLongM{0.90f};
    float quoinShortM{0.50f};
    float quoinProjectionM{0.03f};
    float quoinJointM{0.02f};

    std::vector<int> balconyFloors;         // floors (1 = first above ground) with balconies
    int balconyBayStride{1};
    float balconyDepthM{0.85f};
    float balconyExtraWidthM{0.50f};        // slab width beyond the opening
    float balconySlabM{0.16f};
    float balconyRailHeightM{1.0f};
    float balusterPitchM{0.15f};
    float balusterRadiusM{0.035f};
    float balusterBulge{0.6f};              // swelling of the baluster's radial profile

    float dormerWidthM{0.0f};               // > 0 adds dormers above the eave
    float dormerHeightM{1.9f};
    float dormerDepthM{2.4f};
    float dormerRoofPitchDeg{35.0f};
    float dormerSetbackM{0.10f};            // front face distance behind the eave edge (wall face + roof overhang)
    int dormerBayStride{2};

    int chimneyCount{0};
    float chimneyWidthM{0.9f};
    float chimneyDepthM{0.6f};
    float chimneyRiseM{1.5f};               // height above the roof top
    float chimneyCapM{0.14f};
    int chimneyPotCount{2};
    float chimneyPotRadiusM{0.11f};
    float chimneyPotHeightM{0.45f};
};

// A facade override rule. Selectors pick floors, sides and bays (all must match; defaults match
// everything); overrides change what those openings get (negative / empty = keep). Rules apply in
// order, so later rules win. Indices, not style names: floor 0 is the ground floor, sides are
// 0 south (+Z, entrance), 1 north, 2 east, 3 west.
struct FacadeRule {
    int floorMin{0};
    int floorMax{1 << 20};
    std::vector<int> sides;             // empty = all sides
    int bayStride{1};                   // bays where (bay - bayOffset) % bayStride == 0
    int bayOffset{0};
    int centreSpan{-1};                 // >= 0: only bays within this many bays of the middle
    int endSpan{-1};                    // >= 0: only bays within this many bays of either end

    float windowWidthM{-1.0f};
    float windowHeightM{-1.0f};
    float sillHeightM{-1.0f};
    int opening{-1};                    // 0 = blank wall, 1 = opening
    int sill{-1};                       // 0 = no sill, 1 = sill
    int hood{-1};                       // 0 = no hood, 1 = hood
    std::vector<Vec2> sillProfile;      // replaces the details' sill profile here
    std::vector<Vec2> hoodProfile;      // replaces the details' hood profile here
    float hoodPitchDeg{-1.0f};
    int balcony{-1};                    // 0 = none, 1 = one per opening, 2 = continuous along adjacent bays
};

struct BuildingConfig {
    float width{16.0f};                 // Building width along X-axis (meters)
    float depth{12.0f};                 // Building depth along Z-axis (meters)
    int floorCount{4};                  // Total number of stories
    float floorHeight{3.4f};            // Standard upper floor height (meters)
    float groundFloorHeight{4.2f};      // Ground / retail floor height (meters)

    float plinthHeight{0.6f};           // Base plinth elevation above grade (meters)
    float plinthOffset{0.25f};          // Horizontal plinth ledge offset (meters)

    float bayWidth{3.2f};               // Rhythm period between window bays (meters)
    float windowWidth{1.8f};            // Width of individual window openings (meters)
    float windowHeight{2.0f};           // Height of window openings (meters)
    float sillHeight{0.9f};             // Height of window sill from floor level (meters)
    float windowRecessDepth{0.22f};     // Reveal / recess depth from outer wall (meters)
    float frameThickness{0.08f};        // Thickness of window frame perimeter (meters)
    float mullionThickness{0.05f};      // Center mullion division thickness (meters)

    float doorWidth{2.4f};              // Ground floor entrance door width (meters)
    float doorHeight{2.8f};             // Ground floor entrance door height (meters)

    RoofType roofType{RoofType::Hip};
    float roofPitchDegrees{32.0f};      // Slope angle for Gable, Hip, Mansard
    float roofHeight{3.5f};             // Height of roof dome/mansard/vault (meters)
    float roofOverhang{0.65f};          // Eaves overhang beyond outer wall (meters)
    float parapetHeight{1.1f};          // Height of perimeter parapet for Flat roofs (meters)
    float parapetThickness{0.35f};      // Thickness of parapet wall coping (meters)

    // Continuous Curvilinear & Parametric Manifold (ADA Continuous Invariant)
    float curvature{0.0f};              // 0.0 = rectangular, 1.0 = superellipse/elliptical
    float vaultProfileExponent{2.0f};   // Barrel vault cross-section exponent p (2 = circular, <2 pointed, >2 flat-topped)
    float superellipseExponent{10.0f};  // Lamé exponent m (2.0 = ellipse, 2.4 = squircle, 10.0 = box); a box by default so curvature 0 stays rectangular
    float twistDegrees{0.0f};           // Helical rotation across height (degrees)
    float taper{1.0f};                  // Crown scale ratio relative to base
    float bulge{0.0f};                  // Mid-height barrel swelling / entasis ratio
    int bayCount{0};                    // Radial window bays along curved perimeter (0 = auto)
    bool bakeCurvatureAO{true};         // Automatic Laplace-Beltrami vertex baking

    FacadeDetails details;

    std::vector<float> floorHeights;    // per storey from the ground floor; entries > 0 override the heights above
    float centreBayScale{1.0f};         // width of the middle bay(s) relative to the others
    float endBayScale{1.0f};            // width of the outermost bays relative to the others
    std::vector<FacadeRule> rules;      // per-floor / per-bay overrides, applied in order

    // Plan outline (x east, z south, metres) of any shape; empty = the width x depth rectangle. Holes are courtyards.
    // An outline gets one facade per edge (outer edges first, then each hole's), corners treated by their angle.
    std::vector<Vec2> footprint;
    std::vector<std::vector<Vec2>> footprintHoles;
    int entranceEdge{-1};               // edge (outline) carrying the entrance; -1 = default (longest outer edge / south), -2 = none

    BuildingMaterials materials{BuildingMaterials::createArchitecturalPalette()};
};

// ============================================================================
// 2. PROCEDURAL BUILDING GENERATOR ENGINE
// ============================================================================

/**
 * The world-metre texture frame of a face with unit normal `faceN`: u runs horizontally along the face, v up it (image
 * top = up), so a texture whose KHR_texture_transform scale is 1 / tile size in metres lays at real-world scale. Flat
 * (horizontal) faces take u along +X. Shared by the building parts and add-ons, so both tile the same way.
 */
inline void worldUvFrame(const Vec3& faceN, Vec3& tangent, Vec3& bitangent) {
    tangent = Vec3(0, 1, 0).cross(faceN);
    if (tangent.length() < 1e-4f) tangent = Vec3(1, 0, 0);
    tangent = tangent.normalized();
    bitangent = faceN.cross(tangent);
}

/**
 * A copy of `mesh` with world-metre UVs and matching tangents, for add-ons built by other operators (SDF fields, mesh
 * ops, relief) that should take the building's tiled materials. Each triangle is projected along the world axis its
 * face points most along (box projection), so neighbouring triangles of a curved or finely subdivided surface share one
 * continuous mapping and a texture changes only where the facing crosses between axes; a per-face frame would make
 * every small triangle sample an unrelated spot. Within each axis u runs horizontally and v up (or along -Z on tops), in
 * the same sense as worldUvFrame for flat faces. Positions, normals and colours are copied unchanged.
 */
inline ScratchboxMesh projectWorldUvs(const ScratchboxMesh& mesh) {
    ScratchboxMesh out(mesh.name);
    out.material = mesh.material;
    for (size_t t = 0; t + 2 < mesh.indices.size(); t += 3) {
        const Vertex* tri[3] = { &mesh.vertices[mesh.indices[t]], &mesh.vertices[mesh.indices[t + 1]], &mesh.vertices[mesh.indices[t + 2]] };
        Vec3 faceN = (tri[1]->position - tri[0]->position).cross(tri[2]->position - tri[0]->position);
        float len = faceN.length();
        if (len < 1e-12f) continue;
        const Vec3 n = faceN / len;
        // the dominant axis's own frame: the face frame of the axis-aligned plane it projects onto
        const float ax = std::abs(n.x), ay = std::abs(n.y), az = std::abs(n.z);
        const Vec3 axisN = (ay >= ax && ay >= az) ? Vec3(0, n.y >= 0 ? 1.0f : -1.0f, 0)
                         : (ax >= az) ? Vec3(n.x >= 0 ? 1.0f : -1.0f, 0, 0) : Vec3(0, 0, n.z >= 0 ? 1.0f : -1.0f);
        Vec3 tangent, bitangent;
        worldUvFrame(axisN, tangent, bitangent);
        uint32_t base = static_cast<uint32_t>(out.vertices.size());
        for (const Vertex* v : tri) {
            Vertex o = *v;
            o.uv = Vec2(v->position.dot(tangent), -v->position.dot(bitangent));
            o.tangent = Vec4(tangent.x, tangent.y, tangent.z, 1.0f);
            out.addVertex(o);
        }
        out.addTriangle(base, base + 1, base + 2);
    }
    out.recomputeBounds();
    return out;
}

class ProceduralBuildingGenerator {
public:
    /**
     * Generates a continuous curvilinear / parametric architectural building using
     * superelliptic station lofts, elevation-varying axial twist, taper, bulge,
     * surface-normal recessed fenestration bays, and automatic curvature-coupled AO shading.
     */
    static ScratchboxMesh generateCurvedBuilding(const BuildingConfig& cfg, const std::string& name = "CurvedBuilding") {
        ScratchboxMesh mesh(name);
        mesh.material = cfg.materials.wall;

        // Per-floor heights (floorHeights, else ground / typical) apply here as on the flat builder.
        float totalH = floorBaseY(cfg, std::max(1, cfg.floorCount));
        float halfW = cfg.width * 0.5f;
        float halfD = cfg.depth * 0.5f;
        float avgR = std::sqrt(0.5f * (halfW * halfW + halfD * halfD));
        float approxCircumference = 2.0f * PI * avgR;

        int bays = cfg.bayCount > 0 ? cfg.bayCount : std::max(12, static_cast<int>(approxCircumference / std::max(1.0f, cfg.bayWidth)));
        float m = cfg.superellipseExponent;
        if (cfg.curvature > 0.001f && m >= 9.9f) {
            m = 10.0f - 8.0f * std::clamp(cfg.curvature, 0.0f, 1.0f);
        }

        auto evalScale = [&](float t) -> float {
            float sLinear = (1.0f - t) + t * cfg.taper;
            float sBulge = 4.0f * cfg.bulge * t * (1.0f - t);
            return std::max(0.05f, sLinear + sBulge);
        };

        auto evalTwistRad = [&](float t) -> float {
            return cfg.twistDegrees * DEG_TO_RAD * t;
        };

        auto evalPoint = [&](float a, float b, float theta, float mVal, float y, float twistRad) -> Vec3 {
            float rotTheta = theta + twistRad;
            float cosT = std::cos(rotTheta);
            float sinT = std::sin(rotTheta);
            float sgnX = cosT >= 0.0f ? 1.0f : -1.0f;
            float sgnZ = sinT >= 0.0f ? 1.0f : -1.0f;
            float exp = 2.0f / std::max(0.05f, mVal);
            float x = a * sgnX * std::pow(std::abs(cosT), exp);
            float z = b * sgnZ * std::pow(std::abs(sinT), exp);
            return Vec3(x, y, z);
        };

        auto evalNormal = [&](float a, float b, float theta, float mVal, float twistRad) -> Vec3 {
            float rotTheta = theta + twistRad;
            float cosT = std::cos(rotTheta);
            float sinT = std::sin(rotTheta);
            float sgnX = cosT >= 0.0f ? 1.0f : -1.0f;
            float sgnZ = sinT >= 0.0f ? 1.0f : -1.0f;
            float exp = 2.0f / std::max(0.05f, mVal);
            float x = a * sgnX * std::pow(std::abs(cosT), exp);
            float z = b * sgnZ * std::pow(std::abs(sinT), exp);

            float gradX = (mVal / std::max(1e-4f, a)) * sgnX * std::pow(std::abs(x / std::max(1e-4f, a)), mVal - 1.0f);
            float gradZ = (mVal / std::max(1e-4f, b)) * sgnZ * std::pow(std::abs(z / std::max(1e-4f, b)), mVal - 1.0f);
            Vec3 n(gradX, 0.0f, gradZ);
            float len = n.length();
            return len > 1e-6f ? n / len : Vec3(cosT, 0.0f, sinT);
        };

        auto getStationPoint = [&](float t, float theta, float y, float rScale = 1.0f) -> Vec3 {
            float s = evalScale(t) * rScale;
            float tw = evalTwistRad(t);
            return evalPoint(halfW * s, halfD * s, theta, m, y, tw);
        };

        auto getStationNormal = [&](float t, float theta) -> Vec3 {
            float s = evalScale(t);
            float tw = evalTwistRad(t);
            return evalNormal(halfW * s, halfD * s, theta, m, tw);
        };

        // 1. Curved Plinth / Foundation Base
        float plinthOffsetRatio = 1.0f + (cfg.plinthOffset / std::max(1.0f, avgR));
        for (int i = 0; i < bays; ++i) {
            float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
            float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);

            Vec3 p0 = getStationPoint(0.0f, th0, 0.0f, plinthOffsetRatio);
            Vec3 p1 = getStationPoint(0.0f, th1, 0.0f, plinthOffsetRatio);
            Vec3 p2 = getStationPoint(0.0f, th1, cfg.plinthHeight, plinthOffsetRatio);
            Vec3 p3 = getStationPoint(0.0f, th0, cfg.plinthHeight, plinthOffsetRatio);

            Vec3 nMid = getStationNormal(0.0f, (th0 + th1) * 0.5f);
            addQuad(mesh, p0, p1, p2, p3, nMid, cfg.materials.foundation.baseColorFactor);

            // Plinth top horizontal reveal ledge stepping in to the building wall
            Vec3 wBase0 = getStationPoint(0.0f, th0, cfg.plinthHeight, 1.0f);
            Vec3 wBase1 = getStationPoint(0.0f, th1, cfg.plinthHeight, 1.0f);
            addQuad(mesh, p3, p2, wBase1, wBase0, Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.9f);

            // Bottom ground-contact cap (degenerate fan, matching the roof deck's own fan-cap convention below):
            // closes the plinth ring at y = 0 so the base is a manifold solid, not an open bowl.
            Vec3 groundCenter(0.0f, 0.0f, 0.0f);
            addQuad(mesh, p1, p0, groundCenter, groundCenter, Vec3(0, -1, 0), cfg.materials.foundation.baseColorFactor * 0.8f);
        }

        // 2. Stories & Facades
        float yCur = cfg.plinthHeight;
        for (int floor = 0; floor < cfg.floorCount; ++floor) {
            float fHeight = floorHeightOf(cfg, floor);
            float yNext = yCur + fHeight;
            float t0 = yCur / totalH;
            float t1 = yNext / totalH;

            // Floor slab band (horizontal architectural ledge course)
            float slabH = 0.28f;
            float slabExtend = 1.0f + (0.08f / std::max(1.0f, avgR));
            for (int i = 0; i < bays; ++i) {
                float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
                float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);

                Vec3 s0 = getStationPoint(t0, th0, yCur, slabExtend);
                Vec3 s1 = getStationPoint(t0, th1, yCur, slabExtend);
                Vec3 s2 = getStationPoint(t0, th1, yCur + slabH, slabExtend);
                Vec3 s3 = getStationPoint(t0, th0, yCur + slabH, slabExtend);
                Vec3 nMid = getStationNormal(t0, (th0 + th1) * 0.5f);

                addQuad(mesh, s0, s1, s2, s3, nMid, cfg.materials.wall.baseColorFactor * 0.95f);
            }

            // Facade bays between floor slabs
            float yWallBottom = yCur + slabH;
            float ySill = yCur + cfg.sillHeight;
            float yLintel = ySill + cfg.windowHeight;
            if (yLintel > yNext - 0.2f) yLintel = yNext - 0.2f;

            for (int i = 0; i < bays; ++i) {
                float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
                float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);
                float dTh = th1 - th0;

                // Column pier left & right angle boundaries (18% pier, 64% window opening, 18% pier)
                float thWin0 = th0 + 0.18f * dTh;
                float thWin1 = th1 - 0.18f * dTh;

                // Left Column Pier
                Vec3 lp0 = getStationPoint(t0, th0, yWallBottom);
                Vec3 lp1 = getStationPoint(t0, thWin0, yWallBottom);
                Vec3 lp2 = getStationPoint(t1, thWin0, yNext);
                Vec3 lp3 = getStationPoint(t1, th0, yNext);
                Vec3 nL = getStationNormal(t0, (th0 + thWin0) * 0.5f);
                addQuad(mesh, lp0, lp1, lp2, lp3, nL, cfg.materials.wall.baseColorFactor);

                // Right Column Pier
                Vec3 rp0 = getStationPoint(t0, thWin1, yWallBottom);
                Vec3 rp1 = getStationPoint(t0, th1, yWallBottom);
                Vec3 rp2 = getStationPoint(t1, th1, yNext);
                Vec3 rp3 = getStationPoint(t1, thWin1, yNext);
                Vec3 nR = getStationNormal(t0, (thWin1 + th1) * 0.5f);
                addQuad(mesh, rp0, rp1, rp2, rp3, nR, cfg.materials.wall.baseColorFactor);

                // Spandrel Wall below sill
                Vec3 sp0 = getStationPoint(t0, thWin0, yWallBottom);
                Vec3 sp1 = getStationPoint(t0, thWin1, yWallBottom);
                Vec3 sp2 = getStationPoint(t0, thWin1, ySill);
                Vec3 sp3 = getStationPoint(t0, thWin0, ySill);
                Vec3 nMid = getStationNormal(t0, (thWin0 + thWin1) * 0.5f);
                addQuad(mesh, sp0, sp1, sp2, sp3, nMid, cfg.materials.wall.baseColorFactor);

                // Spandrel Wall above lintel
                Vec3 top0 = getStationPoint(t1, thWin0, yLintel);
                Vec3 top1 = getStationPoint(t1, thWin1, yLintel);
                Vec3 top2 = getStationPoint(t1, thWin1, yNext);
                Vec3 top3 = getStationPoint(t1, thWin0, yNext);
                addQuad(mesh, top0, top1, top2, top3, nMid, cfg.materials.wall.baseColorFactor);

                // Recessed Window Opening
                Vec3 w0 = sp3; // bottom left outer
                Vec3 w1 = sp2; // bottom right outer
                Vec3 w2 = top1; // top right outer
                Vec3 w3 = top0; // top left outer

                Vec3 recessOff = nMid * (-cfg.windowRecessDepth);
                Vec3 rw0 = w0 + recessOff;
                Vec3 rw1 = w1 + recessOff;
                Vec3 rw2 = w2 + recessOff;
                Vec3 rw3 = w3 + recessOff;

                // Window Sill Jamb (bottom horizontal reveal face)
                addQuad(mesh, w0, w1, rw1, rw0, Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 0.9f);
                // Window Lintel Soffit (top horizontal reveal face)
                addQuad(mesh, rw3, rw2, w2, w3, Vec3(0, -1, 0), cfg.materials.wall.baseColorFactor * 0.7f);
                // Window Left Jamb (vertical side reveal)
                addQuad(mesh, w0, rw0, rw3, w3, nL, cfg.materials.wall.baseColorFactor * 0.8f);
                // Window Right Jamb (vertical side reveal)
                addQuad(mesh, rw1, w1, w2, rw2, nR, cfg.materials.wall.baseColorFactor * 0.8f);

                // Recessed Window Glazing Panel
                addQuad(mesh, rw0, rw1, rw2, rw3, nMid, cfg.materials.glass.baseColorFactor);

                // Window Frame Mullion Cross (+ shape)
                Vec3 mH0 = math::lerp(rw0, rw3, 0.5f);
                Vec3 mH1 = math::lerp(rw1, rw2, 0.5f);
                Vec3 mV0 = math::lerp(rw0, rw1, 0.5f);
                Vec3 mV1 = math::lerp(rw3, rw2, 0.5f);

                float mTh = cfg.mullionThickness * 0.5f;
                Vec3 mullionFwd = nMid * 0.04f;
                Vec3 hOff(0, mTh, 0);
                Vec3 wDir = (w1 - w0).normalized() * mTh;

                // Horizontal Mullion bar
                addQuad(mesh, mH0 - hOff + mullionFwd, mH1 - hOff + mullionFwd,
                              mH1 + hOff + mullionFwd, mH0 + hOff + mullionFwd,
                              nMid, cfg.materials.frame.baseColorFactor);
                // Vertical Mullion bar
                addQuad(mesh, mV0 - wDir + mullionFwd, mV0 + wDir + mullionFwd,
                              mV1 + wDir + mullionFwd, mV1 - wDir + mullionFwd,
                              nMid, cfg.materials.frame.baseColorFactor);
            }

            yCur = yNext;
        }

        // 3. Curved Roof System
        if (cfg.roofType == RoofType::BarrelVault) {
            // Single-axis vault sprung from the wall-top ring itself (shared positions, no crack), its axis along the
            // ring's longer extent. Each ring point moves inward across the axis by s_k and rises by
            // rise_i * (1 - s_k^p)^(1/p); rise_i scales with the point's distance from the axis, so rounded ends
            // taper back to the wall top and the vault closes itself.
            std::vector<Vec3> top(bays);
            float extX = 0.0f, extZ = 0.0f;
            for (int i = 0; i < bays; ++i) {
                top[i] = getStationPoint(1.0f, 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays), totalH, 1.0f);
                extX = std::max(extX, std::abs(top[i].x)); extZ = std::max(extZ, std::abs(top[i].z));
            }
            const bool axisX = extX >= extZ;
            const float acrossMax = std::max(1e-3f, axisX ? extZ : extX);
            const float rH = cfg.roofHeight > 0.1f ? cfg.roofHeight : acrossMax;
            const float p = std::max(0.2f, cfg.vaultProfileExponent);
            const int K = std::max(4, static_cast<int>(std::ceil(acrossMax / 0.5f)));
            auto at = [&](int i, int k) -> Vec3 {
                const Vec3& q = top[i];
                float sk = 1.0f - static_cast<float>(k) / static_cast<float>(K);
                float across = axisX ? q.z : q.x;
                float rise = rH * std::abs(across) / acrossMax * std::pow(std::max(0.0f, 1.0f - std::pow(sk, p)), 1.0f / p);
                return axisX ? Vec3(q.x, totalH + rise, q.z * sk) : Vec3(q.x * sk, totalH + rise, q.z);
            };
            ScratchboxMesh vault("vault");
            for (int k = 0; k < K; ++k) {
                for (int i = 0; i < bays; ++i) {
                    int j = (i + 1) % bays;
                    Vec3 a = at(i, k), b = at(j, k), c = at(j, k + 1), d = at(i, k + 1);
                    Vec3 qc = (a + b + c + d) * 0.25f;
                    Vec3 away = axisX ? Vec3(0.0f, qc.y - totalH, qc.z) : Vec3(qc.x, qc.y - totalH, 0.0f);
                    Vec3 n = (b - a).cross(d - a);
                    if (n.length() < 1e-9f) n = (c - b).cross(a - b);
                    if (n.dot(away) < 0.0f) { std::swap(b, d); n = n * -1.0f; }
                    float len = n.length();
                    addQuad(vault, a, b, c, d, len > 1e-9f ? n / len : Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);
                }
            }
            vault.weldVertices(1e-4f);
            uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
            for (const auto& v : vault.vertices) mesh.addVertex(v);
            for (size_t t = 0; t + 2 < vault.indices.size(); t += 3) mesh.addTriangle(base + vault.indices[t], base + vault.indices[t + 1], base + vault.indices[t + 2]);
        } else if (cfg.roofType == RoofType::Dome) {
            int rings = 8;
            float rH = cfg.roofHeight > 0.1f ? cfg.roofHeight : (std::min(halfW, halfD) * 0.65f);
            for (int r = 0; r < rings; ++r) {
                float phi0 = (PI * 0.5f) * static_cast<float>(r) / static_cast<float>(rings);
                float phi1 = (PI * 0.5f) * static_cast<float>(r + 1) / static_cast<float>(rings);

                float y0 = totalH + rH * std::sin(phi0);
                float y1 = totalH + rH * std::sin(phi1);
                float radScale0 = std::cos(phi0);
                float radScale1 = std::cos(phi1);

                for (int i = 0; i < bays; ++i) {
                    float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
                    float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);

                    Vec3 d0 = getStationPoint(1.0f, th0, y0, radScale0);
                    Vec3 d1 = getStationPoint(1.0f, th1, y0, radScale0);
                    Vec3 d2 = getStationPoint(1.0f, th1, y1, radScale1);
                    Vec3 d3 = getStationPoint(1.0f, th0, y1, radScale1);

                    Vec3 norm = (d0 + d1 + d2 + d3) * 0.25f - Vec3(0, totalH, 0);
                    addQuad(mesh, d0, d1, d2, d3, norm.normalized(), cfg.materials.roof.baseColorFactor);
                }
            }
        } else if (cfg.roofType == RoofType::Mansard) {
            float rH = cfg.roofHeight > 0.1f ? cfg.roofHeight : 3.5f;
            float yCurb = totalH + rH * 0.65f;
            float yDeck = totalH + rH;
            float curbScale = 0.70f;
            float deckScale = 0.35f;

            for (int i = 0; i < bays; ++i) {
                float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
                float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);

                // Lower steep slope
                Vec3 p0 = getStationPoint(1.0f, th0, totalH, 1.0f);
                Vec3 p1 = getStationPoint(1.0f, th1, totalH, 1.0f);
                Vec3 p2 = getStationPoint(1.0f, th1, yCurb, curbScale);
                Vec3 p3 = getStationPoint(1.0f, th0, yCurb, curbScale);
                Vec3 nMid = getStationNormal(1.0f, (th0 + th1) * 0.5f);
                addQuad(mesh, p0, p1, p2, p3, (nMid + Vec3(0, 0.6f, 0)).normalized(), cfg.materials.roof.baseColorFactor);

                // Upper shallow slope
                Vec3 q0 = p3;
                Vec3 q1 = p2;
                Vec3 q2 = getStationPoint(1.0f, th1, yDeck, deckScale);
                Vec3 q3 = getStationPoint(1.0f, th0, yDeck, deckScale);
                addQuad(mesh, q0, q1, q2, q3, (nMid + Vec3(0, 1.4f, 0)).normalized(), cfg.materials.roof.baseColorFactor * 0.9f);

                // Center deck triangle fan / quads
                Vec3 centerDeck(0, yDeck, 0);
                addQuad(mesh, q3, q2, centerDeck, centerDeck, Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor * 0.8f);
            }
        } else {
            // FlatParapet (Default): Perimeter parapet wall + flat roof deck
            float ph = cfg.parapetHeight;
            float pt = cfg.parapetThickness;
            float innerScale = 1.0f - (pt / std::max(1.0f, avgR));

            for (int i = 0; i < bays; ++i) {
                float th0 = 2.0f * PI * static_cast<float>(i) / static_cast<float>(bays);
                float th1 = 2.0f * PI * static_cast<float>(i + 1) / static_cast<float>(bays);

                // Outer parapet wall
                Vec3 op0 = getStationPoint(1.0f, th0, totalH, 1.0f);
                Vec3 op1 = getStationPoint(1.0f, th1, totalH, 1.0f);
                Vec3 op2 = getStationPoint(1.0f, th1, totalH + ph, 1.0f);
                Vec3 op3 = getStationPoint(1.0f, th0, totalH + ph, 1.0f);
                Vec3 nMid = getStationNormal(1.0f, (th0 + th1) * 0.5f);
                addQuad(mesh, op0, op1, op2, op3, nMid, cfg.materials.wall.baseColorFactor);

                // Parapet top coping cap
                Vec3 ip2 = getStationPoint(1.0f, th1, totalH + ph, innerScale);
                Vec3 ip3 = getStationPoint(1.0f, th0, totalH + ph, innerScale);
                addQuad(mesh, op3, op2, ip2, ip3, Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 1.05f);

                // Inner parapet wall
                Vec3 ip0 = getStationPoint(1.0f, th0, totalH, innerScale);
                Vec3 ip1 = getStationPoint(1.0f, th1, totalH, innerScale);
                addQuad(mesh, ip3, ip2, ip1, ip0, -nMid, cfg.materials.wall.baseColorFactor * 0.85f);

                // Roof deck disc
                Vec3 deckCenter(0, totalH, 0);
                addQuad(mesh, ip0, ip1, deckCenter, deckCenter, Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);
            }
        }

        mesh.recomputeSmoothNormals();
        if (cfg.bakeCurvatureAO) {
            mesh.computeCurvatureAO(0.72f);
        }
        // Vertex colours carry every part's colour (walls, roof, glass, AO); a white base factor keeps glTF's
        // baseColorFactor x COLOR_0 product from applying the wall colour a second time.
        mesh.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, mesh.material.baseColorFactor.w);
        mesh.recomputeBounds();
        return mesh;
    }

    /**
     * Generates a complete, multi-story architectural building with facade bays,
     * recessed window reveals, mullions, ground entrance, plinth, and procedural roof.
     * Routes automatically to curved generation when curvature or axial deformers are present.
     * Returns a unified ScratchboxMesh ready for glTF serialization.
     */
    static ScratchboxMesh generateBuilding(const BuildingConfig& config, const std::string& name = "ProceduralBuilding") {
        if (config.curvature > 0.001f || std::abs(config.twistDegrees) > 0.001f ||
            std::abs(config.taper - 1.0f) > 0.001f || std::abs(config.bulge) > 0.001f ||
            config.superellipseExponent < 8.0f ||
            config.roofType == RoofType::Dome || config.roofType == RoofType::BarrelVault) {
            if (hasOutline(config)) {
                throw std::invalid_argument("a footprint outline is built with straight walls: drop curvature, twist, taper, bulge, "
                    "superellipse_exponent < 8 and dome or barrel-vault roofs, or drop the footprint");
            }
            // The curved builder lofts its own bays and has no opening resolver: facade rules and bay
            // scales would be dropped on the floor, so they are refused rather than silently ignored.
            if (!config.rules.empty() || std::abs(config.centreBayScale - 1.0f) > 1e-4f || std::abs(config.endBayScale - 1.0f) > 1e-4f) {
                throw std::invalid_argument("facade_rules, centre_bay_scale and end_bay_scale are not applied by the curved builder "
                    "(curvature, twist, taper, bulge, superellipse_exponent < 8, dome or barrel-vault roof route to it); "
                    "floor_heights are. Build a flat plan for per-bay rules, or drop them");
            }
            return generateCurvedBuilding(config, name);
        }
        if (hasOutline(config)) return generateOutlineBuilding(normalizedOutline(config), name);

        ScratchboxMesh mesh(name);
        mesh.material = config.materials.wall;

        // 1. Plinth / Foundation Base
        generatePlinth(config, mesh);

        // 2. Vertical Wall Facades with Rhythmic Fenestration
        generateFacades(config, mesh);

        // 3. Floor Slabs & Ceilings
        generateFloorSlabs(config, mesh);

        // 4. Procedural Roof System
        generateRoof(config, mesh);

        // 5. Facade detail elements (mouldings, pilasters, quoins, balconies, dormers, chimneys)
        generateFacadeDetails(config, mesh);

        if (config.bakeCurvatureAO) {
            mesh.computeCurvatureAO(0.65f);
        }

        // Vertex colours carry every part's colour (walls, roof, glass, AO); a white base factor keeps glTF's
        // baseColorFactor x COLOR_0 product from applying the wall colour a second time.
        mesh.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, mesh.material.baseColorFactor.w);
        mesh.recomputeBounds();
        return mesh;
    }

    /** Storey height of `floor` (0 = ground), from floorHeights where given. */
    static float floorHeightOf(const BuildingConfig& cfg, int floor) {
        if (floor >= 0 && floor < static_cast<int>(cfg.floorHeights.size()) && cfg.floorHeights[floor] > 0.0f) return cfg.floorHeights[floor];
        return floor == 0 ? cfg.groundFloorHeight : cfg.floorHeight;
    }

    /** Height of the floor line under `floor` (floorCount gives the eave line). */
    static float floorBaseY(const BuildingConfig& cfg, int floor) {
        float y = cfg.plinthHeight;
        for (int f = 0; f < std::min(floor, cfg.floorCount); ++f) y += floorHeightOf(cfg, f);
        return y;
    }

    /** Bay boundaries (metres from the side's start) for a side of `length`, weighted by the bay scales. */
    static std::vector<float> bayEdges(const BuildingConfig& cfg, float length) {
        int count = std::max(1, static_cast<int>(length / cfg.bayWidth));
        std::vector<float> weights(count, 1.0f);
        float mid = (count - 1) * 0.5f;
        for (int b = 0; b < count; ++b) {
            if (count >= 3 && std::abs(b - mid) <= 0.5f) weights[b] = std::max(0.2f, cfg.centreBayScale);
            if (count >= 3 && (b == 0 || b == count - 1)) weights[b] = std::max(0.2f, cfg.endBayScale);
        }
        float total = 0.0f;
        for (float w : weights) total += w;
        std::vector<float> edges(count + 1, 0.0f);
        for (int b = 0; b < count; ++b) edges[b + 1] = edges[b] + length * weights[b] / total;
        return edges;
    }

    struct OpeningSpec {
        bool open{true};
        bool entrance{false};
        float width{0}, height{0}, sill{0};
        bool hasSill{true}, hasHood{true};
        const std::vector<Vec2>* sillProfile{nullptr};
        const std::vector<Vec2>* hoodProfile{nullptr};
        float hoodPitchDeg{0};
        int balcony{0};                 // 0 none, 1 per opening, 2 continuous
    };

    /** What the opening in bay `bay` of floor `floor` on side `side` is, after every matching rule. */
    static OpeningSpec resolveOpening(const BuildingConfig& cfg, int side, int floor, int bay, int bayCount, float bayW) {
        const FacadeDetails& d = cfg.details;
        OpeningSpec o;
        o.entrance = floor == 0 && cfg.entranceEdge != -2 && side == (hasOutline(cfg) ? cfg.entranceEdge : 0) && bay == bayCount / 2;
        o.width = o.entrance ? cfg.doorWidth : cfg.windowWidth;
        o.height = o.entrance ? cfg.doorHeight : cfg.windowHeight;
        o.sill = o.entrance ? 0.0f : cfg.sillHeight;
        o.sillProfile = &d.sillProfile;
        o.hoodProfile = &d.hoodProfile;
        o.hoodPitchDeg = d.hoodPitchDeg;
        bool balconyFloor = std::find(d.balconyFloors.begin(), d.balconyFloors.end(), floor) != d.balconyFloors.end();
        o.balcony = balconyFloor && floor > 0 && bay % std::max(1, d.balconyBayStride) == 0 ? 1 : 0;

        float mid = (bayCount - 1) * 0.5f;
        for (const FacadeRule& r : cfg.rules) {
            if (floor < r.floorMin || floor > r.floorMax) continue;
            if (!r.sides.empty() && std::find(r.sides.begin(), r.sides.end(), side) == r.sides.end()) continue;
            int stride = std::max(1, r.bayStride);
            if (((bay - r.bayOffset) % stride + stride) % stride != 0) continue;
            if (r.centreSpan >= 0 && std::abs(bay - mid) > r.centreSpan + 0.5f) continue;
            if (r.endSpan >= 0 && std::min(bay, bayCount - 1 - bay) > r.endSpan) continue;
            if (o.entrance) continue;   // the entrance keeps its door
            if (r.windowWidthM > 0) o.width = r.windowWidthM;
            if (r.windowHeightM > 0) o.height = r.windowHeightM;
            if (r.sillHeightM >= 0) o.sill = r.sillHeightM;
            if (r.opening >= 0) o.open = r.opening != 0;
            if (r.sill >= 0) o.hasSill = r.sill != 0;
            if (r.hood >= 0) o.hasHood = r.hood != 0;
            if (r.sillProfile.size() >= 3) o.sillProfile = &r.sillProfile;
            if (r.hoodProfile.size() >= 3) o.hoodProfile = &r.hoodProfile;
            if (r.hoodPitchDeg >= 0) o.hoodPitchDeg = r.hoodPitchDeg;
            if (r.balcony >= 0) o.balcony = r.balcony;
        }
        float floorH = floorHeightOf(cfg, floor);
        o.width = std::min(o.width, bayW * 0.85f);
        // The sill stays low enough for a 0.3 m opening under the 0.4 m lintel band, so a rule-set
        // sill can never push the opening through the floor above.
        o.sill = std::clamp(o.sill, 0.0f, std::max(0.0f, floorH - 0.7f));
        o.height = std::max(0.3f, std::min(o.height, floorH - o.sill - 0.4f));
        if (o.sill <= 0.001f) o.hasSill = false;
        // On an outline, an edge too short for a window between two piers is a blank return.
        if (hasOutline(cfg) && !o.entrance && bayW < 1.2f) o.open = false;
        if (o.entrance || !o.open) o.balcony = 0;
        return o;
    }

    /** Top centre of each chimney stack's masonry (below its cap), shared by the geometry and soot sources. */
    static std::vector<Vec3> chimneyStackTops(const BuildingConfig& cfg) {
        const FacadeDetails& d = cfg.details;
        std::vector<Vec3> tops;
        float totalH = floorBaseY(cfg, cfg.floorCount);
        float roofTop = totalH + std::max(cfg.roofHeight, 0.5f);
        for (int i = 0; i < d.chimneyCount; ++i) {
            float t = d.chimneyCount == 1 ? 0.5f : static_cast<float>(i) / (d.chimneyCount - 1);
            tops.emplace_back((-0.6f + 1.2f * t) * cfg.width * 0.5f, roofTop + d.chimneyRiseM,
                              (i % 2 == 0 ? 0.25f : -0.25f) * cfg.depth * 0.5f);
        }
        return tops;
    }

    /**
     * The four facade planes at ground level, in the order and orientation the facade generator lays
     * bays: (name, start corner, right direction, outward normal, length). Names follow the
     * generator's convention: south = +Z (the entrance side), north = -Z, east = +X, west = -X.
     */
    static std::vector<std::tuple<std::string, Vec3, Vec3, Vec3, float>> facadeFrames(const BuildingConfig& cfg) {
        static const char* names[4] = { "south", "north", "east", "west" };
        std::vector<std::tuple<std::string, Vec3, Vec3, Vec3, float>> out;
        const bool outline = hasOutline(cfg);
        auto sides = facadeSideFrames(outline ? normalizedOutline(cfg) : cfg, 0.0f);
        for (size_t i = 0; i < sides.size(); ++i) {
            out.emplace_back(outline ? "edge" + std::to_string(i) : std::string(names[i]), sides[i].start, sides[i].rightDir, sides[i].normal, sides[i].length);
        }
        return out;
    }

    /** Where smoke leaves each chimney (above its cap and pots), for weathering soot sources. */
    static std::vector<Vec3> chimneyTops(const BuildingConfig& cfg) {
        if (hasOutline(cfg)) return {};   // an outline building has no chimneys yet (they come with its roofs)
        std::vector<Vec3> tops = chimneyStackTops(cfg);
        for (Vec3& t : tops) t.y += cfg.details.chimneyCapM + cfg.details.chimneyPotHeightM;
        return tops;
    }

    /**
     * Generates the same building as generateBuilding, split into one sub-mesh per material slot
     * (wall, glass, frame, roof, foundation) so each can carry its own material and texture maps.
     *
     * Every surface the generator emits is coloured slot.baseColorFactor times a scalar shade, so the
     * building is generated once with each slot painted a distinct code direction and each triangle is
     * assigned to the slot whose direction its colour has; the scalar becomes a grey vertex shade that
     * multiplies the part's material (and its texture). Parts get world-metre UVs projected along each
     * face (u horizontal, v up the face, image top = up), so a texture's KHR_texture_transform scale of
     * 1 / tile size in metres lays it at real-world scale. Empty slots are omitted.
     */
    static std::vector<ScratchboxMesh> generateBuildingParts(const BuildingConfig& config, const std::string& name = "ProceduralBuilding") {
        struct Slot { const char* suffix; const PbrMaterial* material; Vec3 code; };
        const float s = 0.70710678f;
        const Slot slots[] = {
            { "wall",       &config.materials.wall,       Vec3(1, 0, 0) },
            { "glass",      &config.materials.glass,      Vec3(0, 1, 0) },
            { "frame",      &config.materials.frame,      Vec3(0, 0, 1) },
            { "roof",       &config.materials.roof,       Vec3(s, s, 0) },
            { "foundation", &config.materials.foundation, Vec3(0, s, s) },
        };
        constexpr int slotCount = 5;

        BuildingConfig coded = config;
        PbrMaterial* codedSlots[slotCount] = { &coded.materials.wall, &coded.materials.glass, &coded.materials.frame,
                                               &coded.materials.roof, &coded.materials.foundation };
        for (int i = 0; i < slotCount; ++i) {
            codedSlots[i]->baseColorFactor = Vec4(slots[i].code.x, slots[i].code.y, slots[i].code.z, 1.0f);
        }
        ScratchboxMesh codedMesh = generateBuilding(coded, name);
        // On a curved plan a per-facet planar u breaks at every facet; u then runs around the building
        // (angle times radius about the plan centre), continuous everywhere but one seam.
        const bool curvedPlan = config.curvature > 0.001f || std::abs(config.twistDegrees) > 0.001f ||
            std::abs(config.taper - 1.0f) > 0.001f || std::abs(config.bulge) > 0.001f || config.superellipseExponent < 8.0f ||
            config.roofType == RoofType::Dome || config.roofType == RoofType::BarrelVault;

        std::vector<ScratchboxMesh> parts;
        for (int i = 0; i < slotCount; ++i) {
            ScratchboxMesh part(name + "_" + slots[i].suffix);
            part.material = *slots[i].material;
            part.material.name = name + "_" + slots[i].suffix;
            parts.push_back(std::move(part));
        }

        for (size_t t = 0; t + 2 < codedMesh.indices.size(); t += 3) {
            const Vertex* tri[3] = { &codedMesh.vertices[codedMesh.indices[t]],
                                     &codedMesh.vertices[codedMesh.indices[t + 1]],
                                     &codedMesh.vertices[codedMesh.indices[t + 2]] };
            Vec3 c = (Vec3(tri[0]->color.x, tri[0]->color.y, tri[0]->color.z) +
                      Vec3(tri[1]->color.x, tri[1]->color.y, tri[1]->color.z) +
                      Vec3(tri[2]->color.x, tri[2]->color.y, tri[2]->color.z)) * (1.0f / 3.0f);
            int best = 0;
            float bestCos = -2.0f;
            float cLen = c.length();
            for (int i = 0; i < slotCount; ++i) {
                float cs = cLen > 1e-6f ? c.dot(slots[i].code) / cLen : -1.0f;
                if (cs > bestCos) { bestCos = cs; best = i; }
            }

            Vec3 faceN = (tri[1]->position - tri[0]->position).cross(tri[2]->position - tri[0]->position);
            float faceLen = faceN.length();
            if (faceLen < 1e-12f) continue;
            faceN = faceN / faceLen;
            Vec3 tangent, bitangent;
            worldUvFrame(faceN, tangent, bitangent);

            ScratchboxMesh& part = parts[best];
            uint32_t base = static_cast<uint32_t>(part.vertices.size());
            for (const Vertex* v : tri) {
                Vec3 col(v->color.x, v->color.y, v->color.z);
                // The generator's brightening (sill tops, ridge caps at 1.05 / 1.15) survives the split.
                float shade = std::clamp(col.dot(slots[best].code), 0.0f, 2.0f);
                Vertex out = *v;
                out.color = Vec4(shade, shade, shade, 1.0f);
                float u = v->position.dot(tangent);
                if (curvedPlan && std::abs(faceN.y) < 0.9f) {
                    u = std::atan2(v->position.x, v->position.z) * std::hypot(v->position.x, v->position.z);
                }
                out.uv = Vec2(u, -v->position.dot(bitangent));
                out.tangent = Vec4(tangent.x, tangent.y, tangent.z, 1.0f);
                part.addVertex(out);
            }
            part.addTriangle(base, base + 1, base + 2);
        }

        std::vector<ScratchboxMesh> nonEmpty;
        for (auto& part : parts) {
            if (part.vertices.empty()) continue;
            part.recomputeBounds();
            nonEmpty.push_back(std::move(part));
        }
        return nonEmpty;
    }

private:
    static void addQuad(
        ScratchboxMesh& mesh,
        const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
        const Vec3& normal,
        const Vec4& color = Vec4(1, 1, 1, 1),
        const Vec2& uv0 = Vec2(0, 0), const Vec2& uv1 = Vec2(1, 0),
        const Vec2& uv2 = Vec2(1, 1), const Vec2& uv3 = Vec2(0, 1)
    ) {
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        Vec4 tangent(1, 0, 0, 1);
        if (std::abs(normal.x) > 0.8f) tangent = Vec4(0, 0, 1, 1);

        mesh.addVertex(Vertex(p0, normal, uv0, color, tangent));
        mesh.addVertex(Vertex(p1, normal, uv1, color, tangent));
        mesh.addVertex(Vertex(p2, normal, uv2, color, tangent));
        mesh.addVertex(Vertex(p3, normal, uv3, color, tangent));

        // Callers give corners in either order; wind front faces towards the stated normal.
        if ((p1 - p0).cross(p2 - p0).dot(normal) >= 0.0f) {
            mesh.addTriangle(base, base + 1, base + 2);
            mesh.addTriangle(base, base + 2, base + 3);
        } else {
            mesh.addTriangle(base, base + 2, base + 1);
            mesh.addTriangle(base, base + 3, base + 2);
        }
    }

    static void addBox(
        ScratchboxMesh& mesh,
        const Vec3& minP, const Vec3& maxP,
        const Vec4& color = Vec4(1, 1, 1, 1)
    ) {
        // Front (+Z)
        addQuad(mesh,
            Vec3(minP.x, minP.y, maxP.z), Vec3(maxP.x, minP.y, maxP.z),
            Vec3(maxP.x, maxP.y, maxP.z), Vec3(minP.x, maxP.y, maxP.z),
            Vec3(0, 0, 1), color);
        // Back (-Z)
        addQuad(mesh,
            Vec3(maxP.x, minP.y, minP.z), Vec3(minP.x, minP.y, minP.z),
            Vec3(minP.x, maxP.y, minP.z), Vec3(maxP.x, maxP.y, minP.z),
            Vec3(0, 0, -1), color);
        // Left (-X)
        addQuad(mesh,
            Vec3(minP.x, minP.y, minP.z), Vec3(minP.x, minP.y, maxP.z),
            Vec3(minP.x, maxP.y, maxP.z), Vec3(minP.x, maxP.y, minP.z),
            Vec3(-1, 0, 0), color);
        // Right (+X)
        addQuad(mesh,
            Vec3(maxP.x, minP.y, maxP.z), Vec3(maxP.x, minP.y, minP.z),
            Vec3(maxP.x, maxP.y, minP.z), Vec3(maxP.x, maxP.y, maxP.z),
            Vec3(1, 0, 0), color);
        // Top (+Y)
        addQuad(mesh,
            Vec3(minP.x, maxP.y, maxP.z), Vec3(maxP.x, maxP.y, maxP.z),
            Vec3(maxP.x, maxP.y, minP.z), Vec3(minP.x, maxP.y, minP.z),
            Vec3(0, 1, 0), color);
        // Bottom (-Y)
        addQuad(mesh,
            Vec3(minP.x, minP.y, minP.z), Vec3(maxP.x, minP.y, minP.z),
            Vec3(maxP.x, minP.y, maxP.z), Vec3(minP.x, minP.y, maxP.z),
            Vec3(0, -1, 0), color);
    }

    static void generatePlinth(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        if (hasOutline(cfg)) {
            addPrismLoops(mesh, offsetLoops(outlineLoops(cfg), cfg.plinthOffset), 0.0f, cfg.plinthHeight, cfg.materials.foundation.baseColorFactor);
            return;
        }
        float hx = cfg.width * 0.5f + cfg.plinthOffset;
        float hz = cfg.depth * 0.5f + cfg.plinthOffset;
        Vec3 minP(-hx, 0.0f, -hz);
        Vec3 maxP(hx, cfg.plinthHeight, hz);
        addBox(mesh, minP, maxP, cfg.materials.foundation.baseColorFactor);
    }

    static void generateFacades(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        float yBase = cfg.plinthHeight;

        // One facade per side: on the rectangle 0 South (+Z, entrance), 1 North (-Z), 2 East (+X), 3 West (-X);
        // on an outline, one per edge.
        const std::vector<FacadeSideFrame> sides = facadeSideFrames(cfg, yBase);

        for (size_t sideIdx = 0; sideIdx < sides.size(); ++sideIdx) {
            const auto& side = sides[sideIdx];
            float currY = yBase;
            const std::vector<float> edges = bayEdges(cfg, side.length);
            const int bayCount = static_cast<int>(edges.size()) - 1;

            for (int floor = 0; floor < cfg.floorCount; ++floor) {
                float curFloorH = floorHeightOf(cfg, floor);
                float yNext = currY + curFloorH;

                for (int b = 0; b < bayCount; ++b) {
                    float u0 = edges[b];
                    float u1 = edges[b + 1];
                    float bayCenterU = (u0 + u1) * 0.5f;

                    const OpeningSpec spec = resolveOpening(cfg, static_cast<int>(sideIdx), floor, b, bayCount, u1 - u0);
                    bool isEntranceBay = spec.entrance;
                    float openW = spec.open ? spec.width : 0.0f;
                    float openH = spec.height;
                    float openSill = spec.sill;

                    float openLeft = bayCenterU - openW * 0.5f;
                    float openRight = bayCenterU + openW * 0.5f;
                    float openBottom = currY + openSill;
                    float openTop = openBottom + openH;

                    // 1. Left pier wall & 2. Right pier wall
                    Vec3 lp0 = side.start + side.rightDir * u0 + Vec3(0, currY - yBase, 0);
                    Vec3 lp1 = side.start + side.rightDir * openLeft + Vec3(0, currY - yBase, 0);
                    Vec3 lp2 = lp1 + Vec3(0, curFloorH, 0);
                    Vec3 lp3 = lp0 + Vec3(0, curFloorH, 0);

                    Vec3 rp0 = side.start + side.rightDir * openRight + Vec3(0, currY - yBase, 0);
                    Vec3 rp1 = side.start + side.rightDir * u1 + Vec3(0, currY - yBase, 0);
                    Vec3 rp2 = rp1 + Vec3(0, curFloorH, 0);
                    Vec3 rp3 = rp0 + Vec3(0, curFloorH, 0);

                    if (floor == 0) {
                        // Ground floor ashlar masonry rustication: horizontal reveal channels
                        int courseCount = 7;
                        float courseH = curFloorH / static_cast<float>(courseCount);
                        float grooveH = 0.035f;
                        Vec3 inwardGroove = -side.normal * 0.025f;

                        auto addRusticatedPier = [&](float leftU, float rightU) {
                            for (int c = 0; c < courseCount; ++c) {
                                float y0 = currY + c * courseH;
                                float y1 = y0 + courseH - grooveH;
                                Vec3 cp0 = side.start + side.rightDir * leftU + Vec3(0, y0 - yBase, 0);
                                Vec3 cp1 = side.start + side.rightDir * rightU + Vec3(0, y0 - yBase, 0);
                                Vec3 cp2 = cp1 + Vec3(0, y1 - y0, 0);
                                Vec3 cp3 = cp0 + Vec3(0, y1 - y0, 0);
                                addQuad(mesh, cp0, cp1, cp2, cp3, side.normal, cfg.materials.wall.baseColorFactor);

                                // Recessed reveal channel / groove
                                Vec3 gp0 = cp3;
                                Vec3 gp1 = cp2;
                                Vec3 gp2 = gp1 + Vec3(0, grooveH, 0);
                                Vec3 gp3 = gp0 + Vec3(0, grooveH, 0);
                                addQuad(mesh, gp0 + inwardGroove, gp1 + inwardGroove, gp2 + inwardGroove, gp3 + inwardGroove, side.normal, cfg.materials.wall.baseColorFactor * 0.72f);
                                addQuad(mesh, gp0, gp1, gp1 + inwardGroove, gp0 + inwardGroove, Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 0.82f);
                                addQuad(mesh, gp3 + inwardGroove, gp2 + inwardGroove, gp2, gp3, -Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 0.62f);
                            }
                        };
                        addRusticatedPier(u0, openLeft);
                        addRusticatedPier(openRight, u1);
                    } else {
                        addQuad(mesh, lp0, lp1, lp2, lp3, side.normal, cfg.materials.wall.baseColorFactor);
                        addQuad(mesh, rp0, rp1, rp2, rp3, side.normal, cfg.materials.wall.baseColorFactor);
                    }
                    if (!spec.open) continue;   // blank bay: the two piers already cover it

                    // 3. Spandrel below opening (if sill > 0)
                    if (openSill > 0.001f) {
                        Vec3 sp0 = side.start + side.rightDir * openLeft + Vec3(0, currY - yBase, 0);
                        Vec3 sp1 = side.start + side.rightDir * openRight + Vec3(0, currY - yBase, 0);
                        Vec3 sp2 = sp1 + Vec3(0, openSill, 0);
                        Vec3 sp3 = sp0 + Vec3(0, openSill, 0);
                        addQuad(mesh, sp0, sp1, sp2, sp3, side.normal, cfg.materials.wall.baseColorFactor);
                    }

                    // 4. Lintel above opening
                    Vec3 lt0 = side.start + side.rightDir * openLeft + Vec3(0, openTop - yBase, 0);
                    Vec3 lt1 = side.start + side.rightDir * openRight + Vec3(0, openTop - yBase, 0);
                    Vec3 lt2 = side.start + side.rightDir * openRight + Vec3(0, yNext - yBase, 0);
                    Vec3 lt3 = side.start + side.rightDir * openLeft + Vec3(0, yNext - yBase, 0);
                    addQuad(mesh, lt0, lt1, lt2, lt3, side.normal, cfg.materials.wall.baseColorFactor);

                    // 5. Inset reveals / jambs (window recess)
                    float recess = cfg.windowRecessDepth;
                    Vec3 inward = -side.normal * recess;

                    Vec3 oBL = side.start + side.rightDir * openLeft + Vec3(0, openBottom - yBase, 0);
                    Vec3 oBR = side.start + side.rightDir * openRight + Vec3(0, openBottom - yBase, 0);
                    Vec3 oTR = side.start + side.rightDir * openRight + Vec3(0, openTop - yBase, 0);
                    Vec3 oTL = side.start + side.rightDir * openLeft + Vec3(0, openTop - yBase, 0);

                    // Left jamb
                    addQuad(mesh, oBL, oBL + inward, oTL + inward, oTL, side.rightDir, cfg.materials.wall.baseColorFactor * 0.9f);
                    // Right jamb
                    addQuad(mesh, oBR + inward, oBR, oTR, oTR + inward, -side.rightDir, cfg.materials.wall.baseColorFactor * 0.9f);
                    // Top head jamb
                    addQuad(mesh, oTL, oTL + inward, oTR + inward, oTR, -Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 0.85f);
                    // Bottom sill jamb
                    if (openSill > 0.001f) {
                        addQuad(mesh, oBL + inward, oBL, oBR, oBR + inward, Vec3(0, 1, 0), cfg.materials.wall.baseColorFactor * 0.95f);
                    }

                    // 5b. Projecting Architectural Window Sill with Drop-Edge Overhang
                    if (!isEntranceBay && spec.hasSill && spec.sillProfile->size() < 3) {
                        float hornExt = 0.08f;
                        float sillProj = 0.12f;
                        float sillThick = 0.10f;
                        Vec3 sProj = side.normal * sillProj;
                        Vec3 sL = side.start + side.rightDir * (openLeft - hornExt) + Vec3(0, openBottom - yBase, 0);
                        Vec3 sR = side.start + side.rightDir * (openRight + hornExt) + Vec3(0, openBottom - yBase, 0);

                        Vec3 sTL = sL;
                        Vec3 sTR = sR;
                        Vec3 sBL = sL - Vec3(0, sillThick, 0);
                        Vec3 sBR = sR - Vec3(0, sillThick, 0);

                        Vec3 sTL_out = sTL + sProj - Vec3(0, 0.02f, 0);
                        Vec3 sTR_out = sTR + sProj - Vec3(0, 0.02f, 0);
                        Vec3 sBL_out = sBL + sProj;
                        Vec3 sBR_out = sBR + sProj;

                        // Sill Top Wash (sloping down to shed water)
                        addQuad(mesh, sTL, sTR, sTR_out, sTL_out, Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);
                        // Sill Front Nose
                        addQuad(mesh, sBL_out, sBR_out, sTR_out, sTL_out, side.normal, cfg.materials.foundation.baseColorFactor * 0.95f);
                        // Sill Underside (casts drop shadow)
                        addQuad(mesh, sBL, sBL_out, sBR_out, sBR, -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.60f);
                        // Sill Left Return Horn
                        addQuad(mesh, sBL, sTL, sTL_out, sBL_out, -side.rightDir, cfg.materials.foundation.baseColorFactor * 0.85f);
                        // Sill Right Return Horn
                        addQuad(mesh, sBR_out, sTR_out, sTR, sBR, side.rightDir, cfg.materials.foundation.baseColorFactor * 0.85f);
                    }

                    // 5c. Projecting Window Lintel / Head Cap
                    if (!isEntranceBay && spec.hasHood && spec.hoodProfile->size() < 3) {
                        float lintelExt = 0.06f;
                        float lintelProj = 0.08f;
                        float lintelH = 0.14f;
                        Vec3 lProj = side.normal * lintelProj;
                        Vec3 lL = side.start + side.rightDir * (openLeft - lintelExt) + Vec3(0, openTop - yBase, 0);
                        Vec3 lR = side.start + side.rightDir * (openRight + lintelExt) + Vec3(0, openTop - yBase, 0);
                        Vec3 lTL = lL + Vec3(0, lintelH, 0);
                        Vec3 lTR = lR + Vec3(0, lintelH, 0);

                        // Front face
                        addQuad(mesh, lL + lProj, lR + lProj, lTR + lProj, lTL + lProj, side.normal, cfg.materials.foundation.baseColorFactor);
                        // Top slope wash
                        addQuad(mesh, lTL, lTR, lTR + lProj, lTL + lProj, Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);
                        // Underside
                        addQuad(mesh, lL, lL + lProj, lR + lProj, lR, -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.70f);
                    }

                    // 6. Recessed Glazing / Door Panel
                    Vec3 gBL = oBL + inward;
                    Vec3 gBR = oBR + inward;
                    Vec3 gTR = oTR + inward;
                    Vec3 gTL = oTL + inward;

                    if (isEntranceBay) {
                        // Entrance Door: Wood/Metal frame with glass center
                        addQuad(mesh, gBL, gBR, gTR, gTL, side.normal, cfg.materials.frame.baseColorFactor);
                        // Glass insert
                        Vec3 dBL = math::lerp(gBL, gBR, 0.2f) + Vec3(0, 0.4f, 0);
                        Vec3 dBR = math::lerp(gBL, gBR, 0.8f) + Vec3(0, 0.4f, 0);
                        Vec3 dTR = math::lerp(gTL, gTR, 0.8f) - Vec3(0, 0.2f, 0);
                        Vec3 dTL = math::lerp(gTL, gTR, 0.2f) - Vec3(0, 0.2f, 0);
                        addQuad(mesh, dBL, dBR, dTR, dTL, side.normal, cfg.materials.glass.baseColorFactor);
                    } else {
                        // Window Glass Pane
                        addQuad(mesh, gBL, gBR, gTR, gTL, side.normal, cfg.materials.glass.baseColorFactor);

                        // Window Frame / Mullions
                        float mt = cfg.mullionThickness;
                        Vec3 midB = (gBL + gBR) * 0.5f;
                        Vec3 midT = (gTL + gTR) * 0.5f;

                        // Vertical Mullion
                        Vec3 m0 = midB - side.rightDir * (mt * 0.5f) + side.normal * 0.02f;
                        Vec3 m1 = midB + side.rightDir * (mt * 0.5f) + side.normal * 0.02f;
                        Vec3 m2 = midT + side.rightDir * (mt * 0.5f) + side.normal * 0.02f;
                        Vec3 m3 = midT - side.rightDir * (mt * 0.5f) + side.normal * 0.02f;
                        addQuad(mesh, m0, m1, m2, m3, side.normal, cfg.materials.frame.baseColorFactor);
                    }
                }

                currY = yNext;
            }
        }
    }

    /**
     * Sweeps a closed 2D profile (x along outDir, y along upDir) along a polyline, one frame per
     * segment, with mitred joints: each joint's ring lies on the plane bisecting its two segments,
     * so horizontal loops turn sharp building corners and pitched paths meet cleanly at an apex.
     * Open paths are capped by a fan from the profile point nearest (0, mid-height).
     */
    static void sweepProfileMitred(ScratchboxMesh& mesh, const std::vector<Vec3>& path,
                                   const std::vector<Vec3>& outDirs, const std::vector<Vec3>& upDirs,
                                   const std::vector<Vec2>& profile, bool closed, const Vec4& color) {
        const size_t n = path.size();
        const size_t segCount = closed ? n : n - 1;
        if (n < 2 || profile.size() < 3 || outDirs.size() < segCount || upDirs.size() < segCount) return;

        std::vector<Vec3> tangents(segCount);
        for (size_t sIdx = 0; sIdx < segCount; ++sIdx) {
            tangents[sIdx] = (path[(sIdx + 1) % n] - path[sIdx]).normalized();
        }

        auto ringAt = [&](size_t i) {
            bool hasIn = closed || i > 0;
            bool hasOut = closed || i + 1 < n;
            size_t segIn = (i + segCount - 1) % segCount;
            size_t seg = hasOut ? i % segCount : segIn;
            Vec3 planeN = hasIn && hasOut ? (tangents[segIn] + tangents[i % segCount]).normalized() : tangents[seg];
            std::vector<Vec3> ring;
            ring.reserve(profile.size());
            for (const Vec2& q : profile) {
                Vec3 offset = outDirs[seg] * q.x + upDirs[seg] * q.y;
                float denom = tangents[seg].dot(planeN);
                float t = std::abs(denom) > 1e-5f ? -offset.dot(planeN) / denom : 0.0f;
                ring.push_back(path[i] + offset + tangents[seg] * t);
            }
            return ring;
        };

        float area = 0.0f;
        for (size_t k = 0; k < profile.size(); ++k) {
            const Vec2& a = profile[k];
            const Vec2& b = profile[(k + 1) % profile.size()];
            area += a.x * b.y - b.x * a.y;
        }
        const float orient = area >= 0.0f ? 1.0f : -1.0f;

        std::vector<std::vector<Vec3>> rings(n);
        for (size_t i = 0; i < n; ++i) rings[i] = ringAt(i);

        for (size_t sIdx = 0; sIdx < segCount; ++sIdx) {
            const auto& r0 = rings[sIdx];
            const auto& r1 = rings[(sIdx + 1) % n];
            for (size_t k = 0; k < profile.size(); ++k) {
                size_t k1 = (k + 1) % profile.size();
                Vec2 e = profile[k1] - profile[k];
                Vec2 n2(e.y * orient, -e.x * orient);
                Vec3 nrm = (outDirs[sIdx] * n2.x + upDirs[sIdx] * n2.y).normalized();
                addQuad(mesh, r0[k], r1[k], r1[k1], r0[k1], nrm, color);
            }
        }

        if (!closed) {
            // End caps: the profile polygon triangulated by ear clipping, so a concave (multi-tier)
            // section is covered exactly, with no fan triangle outside it and no degenerate triangle.
            const auto ears = triangulatePolygon(profile);
            const size_t ends[2] = { 0, n - 1 };
            for (int e = 0; e < 2; ++e) {
                const auto& ring = rings[ends[e]];
                Vec3 nrm = e == 0 ? -tangents.front() : tangents.back();
                for (const auto& t : ears) addTri(mesh, ring[t[0]], ring[t[1]], ring[t[2]], nrm, color);
            }
        }
    }

    /** Harmonic solid of revolution about +Y: radius(t) for t in [0,1] over height, K radial facets. */
    template <typename RadiusFn>
    static void addLathe(ScratchboxMesh& mesh, const Vec3& base, float height, RadiusFn radius,
                         int rings, int facets, const Vec4& color) {
        // One direction per facet, reused for facet f + 1, so the seam closes bit for bit.
        std::vector<Vec3> dirs(facets);
        for (int f = 0; f < facets; ++f) dirs[f] = Vec3(std::cos(TWO_PI * f / facets), 0, std::sin(TWO_PI * f / facets));
        for (int r = 0; r < rings; ++r) {
            float t0 = static_cast<float>(r) / rings, t1 = static_cast<float>(r + 1) / rings;
            float r0 = radius(t0), r1 = radius(t1);
            for (int f = 0; f < facets; ++f) {
                const Vec3& d0 = dirs[f];
                const Vec3& d1 = dirs[(f + 1) % facets];
                Vec3 p00 = base + d0 * r0 + Vec3(0, t0 * height, 0), p10 = base + d1 * r0 + Vec3(0, t0 * height, 0);
                Vec3 p11 = base + d1 * r1 + Vec3(0, t1 * height, 0), p01 = base + d0 * r1 + Vec3(0, t1 * height, 0);
                Vec3 mid = (d0 + d1).normalized();
                Vec3 nrm = (mid * height / rings + Vec3(0, r0 - r1, 0)).normalized();
                addQuad(mesh, p00, p10, p11, p01, nrm, color);
            }
        }
        float rTop = radius(1.0f), rBottom = radius(0.0f);
        Vec3 top = base + Vec3(0, height, 0);
        for (int f = 0; f < facets; ++f) {
            const Vec3& d0 = dirs[f];
            const Vec3& d1 = dirs[(f + 1) % facets];
            addTri(mesh, top, top + d0 * rTop, top + d1 * rTop, Vec3(0, 1, 0), color);
            addTri(mesh, base, base + d1 * rBottom, base + d0 * rBottom, Vec3(0, -1, 0), color);
        }
    }

    /** One triangle wound towards the stated normal. */
    static void addTri(ScratchboxMesh& mesh, const Vec3& a, const Vec3& b, const Vec3& c, const Vec3& normal, const Vec4& color) {
        if ((b - a).cross(c - a).length() < 1e-14f) return;
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        Vec4 tangent(1, 0, 0, 1);
        if (std::abs(normal.x) > 0.8f) tangent = Vec4(0, 0, 1, 1);
        mesh.addVertex(Vertex(a, normal, Vec2(0, 0), color, tangent));
        mesh.addVertex(Vertex(b, normal, Vec2(1, 0), color, tangent));
        mesh.addVertex(Vertex(c, normal, Vec2(1, 1), color, tangent));
        if ((b - a).cross(c - a).dot(normal) >= 0.0f) mesh.addTriangle(base, base + 1, base + 2);
        else mesh.addTriangle(base, base + 2, base + 1);
    }

    /** Ear-clipping triangulation of a simple polygon (either orientation): index triples into `poly`. */
    static std::vector<std::array<size_t, 3>> triangulatePolygon(const std::vector<Vec2>& poly) {
        std::vector<std::array<size_t, 3>> out;
        std::vector<size_t> idx(poly.size());
        for (size_t i = 0; i < idx.size(); ++i) idx[i] = i;
        float area2 = 0.0f;
        for (size_t k = 0; k < poly.size(); ++k) {
            const Vec2& a = poly[k]; const Vec2& b = poly[(k + 1) % poly.size()];
            area2 += a.x * b.y - b.x * a.y;
        }
        const float sgn = area2 >= 0.0f ? 1.0f : -1.0f;
        auto cross2 = [](const Vec2& a, const Vec2& b, const Vec2& c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); };
        auto inside = [&](const Vec2& p, const Vec2& a, const Vec2& b, const Vec2& c) {
            return cross2(a, b, p) * sgn >= -1e-9f && cross2(b, c, p) * sgn >= -1e-9f && cross2(c, a, p) * sgn >= -1e-9f;
        };
        while (idx.size() > 3) {
            bool clipped = false;
            for (size_t i = 0; i < idx.size() && !clipped; ++i) {
                size_t ia = idx[(i + idx.size() - 1) % idx.size()], ib = idx[i], ic = idx[(i + 1) % idx.size()];
                if (cross2(poly[ia], poly[ib], poly[ic]) * sgn <= 1e-12f) continue;   // reflex or flat corner
                bool empty = true;
                for (size_t j : idx) {
                    if (j == ia || j == ib || j == ic) continue;
                    // a bridged hole repeats points: a copy of the ear's own corner does not block it
                    const Vec2& q = poly[j];
                    if ((q - poly[ia]).lengthSq() < 1e-12f || (q - poly[ib]).lengthSq() < 1e-12f || (q - poly[ic]).lengthSq() < 1e-12f) continue;
                    if (inside(q, poly[ia], poly[ib], poly[ic])) { empty = false; break; }
                }
                if (!empty) continue;
                out.push_back({ia, ib, ic});
                idx.erase(idx.begin() + static_cast<long>(i));
                clipped = true;
            }
            if (!clipped) {   // no ear (degenerate input): drop a vertex rather than loop forever
                size_t ia = idx[idx.size() - 1], ib = idx[0], ic = idx[1];
                if (std::abs(cross2(poly[ia], poly[ib], poly[ic])) > 1e-12f) out.push_back({ia, ib, ic});
                idx.erase(idx.begin());
            }
        }
        if (idx.size() == 3 && std::abs(cross2(poly[idx[0]], poly[idx[1]], poly[idx[2]])) > 1e-12f) out.push_back({idx[0], idx[1], idx[2]});
        return out;
    }

    // ---- Outline plans: a footprint polygon (x east, z south) with optional courtyard holes ----

    static bool hasOutline(const BuildingConfig& cfg) { return cfg.footprint.size() >= 3; }
    static float dot2(const Vec2& a, const Vec2& b) { return a.x * b.x + a.y * b.y; }
    static float cross2d(const Vec2& a, const Vec2& b) { return a.x * b.y - a.y * b.x; }
    static float loopArea2(const std::vector<Vec2>& l) {
        float a = 0.0f;
        for (size_t i = 0; i < l.size(); ++i) a += cross2d(l[i], l[(i + 1) % l.size()]);
        return a;
    }
    /** Outward normal of an edge running along unit `r` (loops are wound so it points away from the building). */
    static Vec2 edgeNormal2(const Vec2& r) { return Vec2(-r.y, r.x); }
    static Vec3 edgeNormal3(const Vec2& r) { return Vec3(-r.y, 0.0f, r.x); }
    /** Whether the corner from an edge along rIn to one along rOut turns inward (an inside corner). */
    static bool cornerConcave(const Vec2& rIn, const Vec2& rOut) {
        return dot2(rIn, edgeNormal2(rOut)) < -0.17f;   // more than ~10 degrees inward
    }
    static bool segmentsCross(const Vec2& a, const Vec2& b, const Vec2& c, const Vec2& d) {
        auto o = [](const Vec2& p, const Vec2& q, const Vec2& r) { return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x); };
        const float d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
        const float eps = 1e-7f;
        return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
    }
    static bool pointInLoop(const Vec2& p, const std::vector<Vec2>& l) {
        bool in = false;
        for (size_t i = 0, j = l.size() - 1; i < l.size(); j = i++) {
            if ((l[i].y > p.y) != (l[j].y > p.y) && p.x < (l[j].x - l[i].x) * (p.y - l[i].y) / (l[j].y - l[i].y) + l[i].x) in = !in;
        }
        return in;
    }

    /**
     * One loop cleaned for building: points closer than 5 cm merged, vertices turning less than 10 degrees
     * (survey noise along a straight wall) and spikes dropped, wound so edge normals point away from the
     * building: clockwise seen from above for the outer loop (as the rectangle's sides run), the reverse for holes.
     */
    static std::vector<Vec2> cleanLoop(std::vector<Vec2> l, bool hole, const char* what) {
        bool changed = true;
        while (changed && l.size() >= 3) {
            changed = false;
            for (size_t i = 0; i < l.size() && l.size() >= 3; ++i) {
                const size_t n = l.size();
                const Vec2 a = l[(i + n - 1) % n], b = l[i], c = l[(i + 1) % n];
                const Vec2 ab = b - a, bc = c - b;
                bool drop = ab.length() < 0.05f;
                if (!drop && bc.length() >= 0.05f) {
                    const Vec2 u = ab.normalized(), v = bc.normalized();
                    drop = (std::abs(cross2d(u, v)) < 0.1736f && dot2(u, v) > 0.0f) || dot2(u, v) < -0.985f;
                }
                if (drop) { l.erase(l.begin() + static_cast<long>(i)); changed = true; break; }
            }
        }
        for (size_t i = 0; i < l.size(); ++i) {
            for (size_t j = i + 2; j < l.size(); ++j) {
                if (i == 0 && j + 1 == l.size()) continue;
                if (segmentsCross(l[i], l[(i + 1) % l.size()], l[j], l[(j + 1) % l.size()])) {
                    throw std::invalid_argument(std::string(what) + " crosses itself (edges " + std::to_string(i) + " and " + std::to_string(j) + ")");
                }
            }
        }
        if (l.size() < 3 || std::abs(loopArea2(l)) < 2.0f) {
            throw std::invalid_argument(std::string(what) + " has fewer than 3 distinct corners or under 1 m2 of area after merging near-duplicate and straight-through points");
        }
        const bool clockwise = loopArea2(l) < 0.0f;   // in (x, z) with z south: negative = the rectangle's winding
        if (clockwise == hole) std::reverse(l.begin(), l.end());
        return l;
    }

    /** The config with its outline cleaned and wound, the entrance edge chosen and width / depth set to its extent. */
    static BuildingConfig normalizedOutline(const BuildingConfig& cfg) {
        BuildingConfig c = cfg;
        c.footprint = cleanLoop(cfg.footprint, false, "footprint");
        c.footprintHoles.clear();
        for (size_t h = 0; h < cfg.footprintHoles.size(); ++h) {
            const std::string what = "courtyard " + std::to_string(h);
            auto hole = cleanLoop(cfg.footprintHoles[h], true, what.c_str());
            for (const Vec2& p : hole) {
                if (!pointInLoop(p, c.footprint)) throw std::invalid_argument(what + " reaches outside the footprint");
            }
            c.footprintHoles.push_back(std::move(hole));
        }
        const size_t outerEdges = c.footprint.size();
        if (c.entranceEdge < 0) {
            float best = -1.0f;
            for (size_t i = 0; i < outerEdges; ++i) {
                float len = (c.footprint[(i + 1) % outerEdges] - c.footprint[i]).length();
                if (len > best + 1e-4f) { best = len; c.entranceEdge = static_cast<int>(i); }
            }
        }
        float x0 = 1e30f, x1 = -1e30f, z0 = 1e30f, z1 = -1e30f;
        for (const Vec2& p : c.footprint) { x0 = std::min(x0, p.x); x1 = std::max(x1, p.x); z0 = std::min(z0, p.y); z1 = std::max(z1, p.y); }
        c.width = x1 - x0;
        c.depth = z1 - z0;
        return c;
    }

    /** Outer loop then holes, as stored (normalizedOutline has already cleaned and wound them). */
    static std::vector<std::vector<Vec2>> outlineLoops(const BuildingConfig& cfg) {
        std::vector<std::vector<Vec2>> loops{ cfg.footprint };
        for (const auto& h : cfg.footprintHoles) loops.push_back(h);
        return loops;
    }

    /** Every loop moved `d` metres along its outward normals (negative = into the building), mitred at corners. */
    static std::vector<std::vector<Vec2>> offsetLoops(const std::vector<std::vector<Vec2>>& loops, float d) {
        std::vector<std::vector<Vec2>> out;
        for (const auto& l : loops) {
            std::vector<Vec2> o;
            const size_t n = l.size();
            for (size_t i = 0; i < n; ++i) {
                const Vec2 nIn = edgeNormal2((l[i] - l[(i + n - 1) % n]).normalized());
                const Vec2 nOut = edgeNormal2((l[(i + 1) % n] - l[i]).normalized());
                const float k = 1.0f / std::max(0.25f, 1.0f + dot2(nIn, nOut));   // miter length, capped at 4x
                o.push_back(l[i] + (nIn + nOut) * (d * k));
            }
            out.push_back(std::move(o));
        }
        return out;
    }

    /** The loops (outer, then holes) joined into one simple polygon by bridges from each hole, for ear clipping. */
    static std::vector<Vec2> bridgeHoles(const std::vector<std::vector<Vec2>>& loops) {
        std::vector<Vec2> merged = loops[0];
        std::vector<size_t> order;
        for (size_t h = 1; h < loops.size(); ++h) order.push_back(h);
        auto maxX = [&](size_t h) { float m = -1e30f; for (const Vec2& p : loops[h]) m = std::max(m, p.x); return m; };
        std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return maxX(a) > maxX(b); });
        for (size_t oi = 0; oi < order.size(); ++oi) {
            const auto& hole = loops[order[oi]];
            size_t hv = 0;
            for (size_t i = 1; i < hole.size(); ++i) if (hole[i].x > hole[hv].x) hv = i;
            const Vec2 hp = hole[hv];
            auto blocked = [&](const Vec2& a, const Vec2& b) {
                auto hits = [&](const std::vector<Vec2>& l) {
                    for (size_t i = 0; i < l.size(); ++i) if (segmentsCross(a, b, l[i], l[(i + 1) % l.size()])) return true;
                    return false;
                };
                if (hits(merged)) return true;
                for (size_t oj = oi; oj < order.size(); ++oj) if (hits(loops[order[oj]])) return true;
                return false;
            };
            size_t best = SIZE_MAX;
            float bestD = 1e30f;
            for (size_t i = 0; i < merged.size(); ++i) {
                const float dd = (merged[i] - hp).lengthSq();
                if (dd < bestD && !blocked(hp, merged[i])) { bestD = dd; best = i; }
            }
            if (best == SIZE_MAX) throw std::invalid_argument("a courtyard could not be joined to the footprint for triangulation");
            std::vector<Vec2> next(merged.begin(), merged.begin() + static_cast<long>(best) + 1);
            for (size_t k = 0; k <= hole.size(); ++k) next.push_back(hole[(hv + k) % hole.size()]);
            next.insert(next.end(), merged.begin() + static_cast<long>(best), merged.end());
            merged = std::move(next);
        }
        return merged;
    }

    /** A horizontal cap over the loops (holes left open) at height y, facing up or down. */
    static void addCapLoops(ScratchboxMesh& mesh, const std::vector<std::vector<Vec2>>& loops, float y, bool upward, const Vec4& color) {
        const std::vector<Vec2> poly = bridgeHoles(loops);
        const Vec3 nrm(0, upward ? 1.0f : -1.0f, 0);
        for (const auto& t : triangulatePolygon(poly)) {
            addTri(mesh, Vec3(poly[t[0]].x, y, poly[t[0]].y), Vec3(poly[t[1]].x, y, poly[t[1]].y), Vec3(poly[t[2]].x, y, poly[t[2]].y), nrm, color);
        }
    }

    /** A vertical prism over the loops from y0 to y1: walls along every edge, capped top and bottom. */
    static void addPrismLoops(ScratchboxMesh& mesh, const std::vector<std::vector<Vec2>>& loops, float y0, float y1, const Vec4& color) {
        for (const auto& l : loops) {
            for (size_t i = 0; i < l.size(); ++i) {
                const Vec2 a = l[i], b = l[(i + 1) % l.size()];
                addQuad(mesh, Vec3(a.x, y0, a.y), Vec3(b.x, y0, b.y), Vec3(b.x, y1, b.y), Vec3(a.x, y1, a.y), edgeNormal3((b - a).normalized()), color);
            }
        }
        addCapLoops(mesh, loops, y1, true, color);
        addCapLoops(mesh, loops, y0, false, color);
    }

    struct OutlineCorner { Vec2 p; Vec2 rIn; Vec2 rOut; float lenIn; float lenOut; bool convex; };

    /** Every corner of the outline turning more than 20 degrees, outside (convex) or inside. */
    static std::vector<OutlineCorner> outlineCorners(const BuildingConfig& cfg) {
        std::vector<OutlineCorner> out;
        for (const auto& l : outlineLoops(cfg)) {
            const size_t n = l.size();
            for (size_t i = 0; i < n; ++i) {
                const Vec2 a = l[(i + n - 1) % n], p = l[i], b = l[(i + 1) % n];
                const Vec2 rIn = (p - a).normalized(), rOut = (b - p).normalized();
                if (dot2(rIn, rOut) > 0.94f) continue;
                out.push_back({ p, rIn, rOut, (p - a).length(), (b - p).length(), dot2(rIn, edgeNormal2(rOut)) > 0.0f });
            }
        }
        return out;
    }

    /**
     * A block wrapping an outside corner from y0 to y1, at any corner angle: `alongIn` back along the incoming
     * wall and `alongOut` along the outgoing one, standing `proj` proud of both, mitred at the arris.
     */
    static void addCornerPrism(ScratchboxMesh& mesh, const OutlineCorner& c, float alongIn, float alongOut, float proj,
                               float y0, float y1, const Vec4& color) {
        const Vec2 nIn = edgeNormal2(c.rIn), nOut = edgeNormal2(c.rOut);
        const float denom = 1.0f + dot2(nIn, nOut);
        if (denom < 0.3f || alongIn <= 0.0f || alongOut <= 0.0f) return;   // a corner too sharp for a block
        const Vec2 q0 = c.p - c.rIn * alongIn;
        const std::vector<Vec2> poly = { q0, q0 + nIn * proj, c.p + (nIn + nOut) * (proj / denom),
                                         c.p + c.rOut * alongOut + nOut * proj, c.p + c.rOut * alongOut, c.p };
        // Faces on the wall planes (q4 -> p -> q0) are hidden against the wall and left out.
        for (size_t i = 0; i < 4; ++i) {
            const Vec2 a = poly[i], b = poly[i + 1];
            addQuad(mesh, Vec3(a.x, y0, a.y), Vec3(b.x, y0, b.y), Vec3(b.x, y1, b.y), Vec3(a.x, y1, a.y), edgeNormal3((b - a).normalized()), color);
        }
        for (const auto& t : triangulatePolygon(poly)) {
            addTri(mesh, Vec3(poly[t[0]].x, y1, poly[t[0]].y), Vec3(poly[t[1]].x, y1, poly[t[1]].y), Vec3(poly[t[2]].x, y1, poly[t[2]].y), Vec3(0, 1, 0), color);
            addTri(mesh, Vec3(poly[t[0]].x, y0, poly[t[0]].y), Vec3(poly[t[1]].x, y0, poly[t[1]].y), Vec3(poly[t[2]].x, y0, poly[t[2]].y), Vec3(0, -1, 0), color);
        }
    }

    /** generateBuilding for an outline plan (cfg already normalised): flat parapet roofs only for now. */
    static ScratchboxMesh generateOutlineBuilding(const BuildingConfig& cfg, const std::string& name) {
        if (cfg.roofType != RoofType::FlatParapet) {
            throw std::invalid_argument("a footprint outline takes roof=\"flat\" for now: pitched roofs over any outline "
                "(hip, gable, mansard) need the straight-skeleton roof, which is not built yet");
        }
        if (cfg.details.chimneyCount > 0 || cfg.details.dormerWidthM > 0.0f) {
            throw std::invalid_argument("chimneys and dormers are not placed on a footprint outline yet: set chimney_count and "
                "dormer_width_m to 0, or attach them as add-ons (write_textured_building extras)");
        }
        if (cfg.entranceEdge >= static_cast<int>(cfg.footprint.size()) || cfg.entranceEdge < -2) {
            throw std::invalid_argument("entrance_edge " + std::to_string(cfg.entranceEdge) + " is not an outer edge (the cleaned footprint has " +
                std::to_string(cfg.footprint.size()) + ")");
        }
        ScratchboxMesh mesh(name);
        mesh.material = cfg.materials.wall;
        generatePlinth(cfg, mesh);
        generateFacades(cfg, mesh);
        generateFloorSlabs(cfg, mesh);
        generateRoof(cfg, mesh);
        generateFacadeDetails(cfg, mesh);
        if (cfg.bakeCurvatureAO) mesh.computeCurvatureAO(0.65f);
        mesh.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, mesh.material.baseColorFactor.w);
        mesh.recomputeBounds();
        return mesh;
    }

    struct FacadeSideFrame {
        Vec3 start; Vec3 rightDir; Vec3 normal; float length; bool hasEntrance;
        bool concaveStart{false}, concaveEnd{false};   // an inside corner at this end (outline plans)
    };

    static std::vector<FacadeSideFrame> facadeSideFrames(const BuildingConfig& cfg, float y) {
        if (hasOutline(cfg)) {
            std::vector<FacadeSideFrame> out;
            const auto loops = outlineLoops(cfg);
            for (const auto& loop : loops) {
                const size_t n = loop.size();
                for (size_t i = 0; i < n; ++i) {
                    const Vec2 a = loop[i], b = loop[(i + 1) % n];
                    const Vec2 r = (b - a).normalized();
                    FacadeSideFrame f{ Vec3(a.x, y, a.y), Vec3(r.x, 0, r.y), edgeNormal3(r), (b - a).length(),
                                       static_cast<int>(out.size()) == cfg.entranceEdge };
                    const Vec2 rPrev = (a - loop[(i + n - 1) % n]).normalized(), rNext = (loop[(i + 2) % n] - b).normalized();
                    f.concaveStart = cornerConcave(rPrev, r);
                    f.concaveEnd = cornerConcave(r, rNext);
                    out.push_back(f);
                }
            }
            return out;
        }
        float hx = cfg.width * 0.5f, hz = cfg.depth * 0.5f;
        return {
            { Vec3(-hx, y,  hz), Vec3( 1, 0,  0), Vec3( 0, 0,  1), cfg.width, true  },
            { Vec3( hx, y, -hz), Vec3(-1, 0,  0), Vec3( 0, 0, -1), cfg.width, false },
            { Vec3( hx, y,  hz), Vec3( 0, 0, -1), Vec3( 1, 0,  0), cfg.depth, false },
            { Vec3(-hx, y, -hz), Vec3( 0, 0,  1), Vec3(-1, 0,  0), cfg.depth, false },
        };
    }

    static void addHorizontalLoop(ScratchboxMesh& mesh, const BuildingConfig& cfg, float y,
                                  const std::vector<Vec2>& profile, const Vec4& color) {
        if (hasOutline(cfg)) {
            for (const auto& loop : outlineLoops(cfg)) {
                std::vector<Vec3> path, outs, ups;
                for (size_t i = 0; i < loop.size(); ++i) {
                    const Vec2 r = (loop[(i + 1) % loop.size()] - loop[i]).normalized();
                    path.emplace_back(loop[i].x, y, loop[i].y);
                    outs.push_back(edgeNormal3(r));
                    ups.emplace_back(0, 1, 0);
                }
                sweepProfileMitred(mesh, path, outs, ups, profile, true, color);
            }
            return;
        }
        float hx = cfg.width * 0.5f, hz = cfg.depth * 0.5f;
        std::vector<Vec3> path = { Vec3(-hx, y, hz), Vec3(hx, y, hz), Vec3(hx, y, -hz), Vec3(-hx, y, -hz) };
        std::vector<Vec3> outs = { Vec3(0, 0, 1), Vec3(1, 0, 0), Vec3(0, 0, -1), Vec3(-1, 0, 0) };
        std::vector<Vec3> ups(4, Vec3(0, 1, 0));
        sweepProfileMitred(mesh, path, outs, ups, profile, true, color);
    }

    static void generateFacadeDetails(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        const FacadeDetails& d = cfg.details;
        const Vec4 trim = cfg.materials.foundation.baseColorFactor;
        const Vec4 wall = cfg.materials.wall.baseColorFactor;
        const Vec4 metal = cfg.materials.frame.baseColorFactor;
        const Vec4 roof = cfg.materials.roof.baseColorFactor;
        const Vec4 glass = cfg.materials.glass.baseColorFactor;
        const float totalH = floorBaseY(cfg, cfg.floorCount);
        const float hx = cfg.width * 0.5f, hz = cfg.depth * 0.5f;
        const Vec3 up(0, 1, 0);
        const bool outline = hasOutline(cfg);

        // Cornice and string courses.
        if (d.corniceProfile.size() >= 3) addHorizontalLoop(mesh, cfg, totalH, d.corniceProfile, trim);
        if (d.stringCourseProfile.size() >= 3) {
            for (int f = 1; f < cfg.floorCount; ++f) {
                bool wanted = d.stringCourseFloors.empty() ||
                    std::find(d.stringCourseFloors.begin(), d.stringCourseFloors.end(), f) != d.stringCourseFloors.end();
                if (wanted) addHorizontalLoop(mesh, cfg, floorBaseY(cfg, f), d.stringCourseProfile, trim);
            }
        }

        // Per-opening sills, hoods and balconies, on the same bay grid and rules as generateFacades.
        const auto sideFrames = facadeSideFrames(cfg, cfg.plinthHeight);
        for (size_t sideIdx = 0; sideIdx < sideFrames.size(); ++sideIdx) {
            const auto& side = sideFrames[sideIdx];
            const std::vector<float> edges = bayEdges(cfg, side.length);
            const int bayCount = static_cast<int>(edges.size()) - 1;
            auto at = [&](float u, float y) { return Vec3(side.start.x, 0, side.start.z) + side.rightDir * u + Vec3(0, y, 0); };

            // A balcony from u0 to u1 along the wall at floor line y: slab, lathed balusters, swept rail.
            auto emitBalcony = [&](float u0, float u1, float y) {
                // Never past the building's corners (end bays can be narrower than the slab overhang).
                const float corner = 0.12f + (d.quoinCourseM > 0.0f ? d.quoinProjectionM : 0.0f);
                // ...nor into the wall across an inside corner.
                u0 = std::max(u0, corner + (side.concaveStart ? d.balconyDepthM : 0.0f));
                u1 = std::min(u1, side.length - corner - (side.concaveEnd ? d.balconyDepthM : 0.0f));
                if (u1 - u0 < 0.3f) return;
                Vec3 n = side.normal, r = side.rightDir;
                Vec3 c0 = at((u0 + u1) * 0.5f, y);
                float half = (u1 - u0) * 0.5f;
                Vec3 a = c0 - r * half - Vec3(0, d.balconySlabM, 0), bb = c0 + r * half + n * d.balconyDepthM;
                addBox(mesh, Vec3(std::min(a.x, bb.x), a.y, std::min(a.z, bb.z)),
                       Vec3(std::max(a.x, bb.x), c0.y, std::max(a.z, bb.z)), trim);
                Vec3 corners[4] = { c0 - r * (half - 0.06f), c0 - r * (half - 0.06f) + n * (d.balconyDepthM - 0.06f),
                                    c0 + r * (half - 0.06f) + n * (d.balconyDepthM - 0.06f), c0 + r * (half - 0.06f) };
                float railBottom = 0.0f, railTop = d.balconyRailHeightM - 0.06f;   // balusters stand on the slab
                for (int e = 0; e < 3; ++e) {
                    float len = (corners[e + 1] - corners[e]).length();
                    int count = std::max(1, static_cast<int>(std::lround(len / std::max(0.05f, d.balusterPitchM))));
                    for (int k = 0; k <= count; ++k) {
                        if (e > 0 && k == 0) continue;
                        Vec3 pBase = corners[e] + (corners[e + 1] - corners[e]) * (static_cast<float>(k) / count) + Vec3(0, railBottom, 0);
                        float R = d.balusterRadiusM, bulge = d.balusterBulge;
                        addLathe(mesh, pBase, railTop - railBottom, [R, bulge](float t) {
                            float sn = std::sin(PI * std::clamp((t - 0.1f) / 0.75f, 0.0f, 1.0f));
                            return R * (0.75f + bulge * sn * sn * (1.0f - 0.35f * t));
                        }, 5, 6, metal);
                    }
                }
                std::vector<Vec3> railPath;
                for (const Vec3& c : corners) railPath.push_back(c + Vec3(0, d.balconyRailHeightM - 0.03f, 0));
                std::vector<Vec3> railOut, railUp;
                for (int k = 0; k < 3; ++k) {
                    Vec3 t = (railPath[k + 1] - railPath[k]).normalized();
                    railOut.push_back(up.cross(t).normalized());
                    railUp.push_back(up);
                }
                float rw = std::max(0.03f, d.balusterRadiusM * 1.6f);
                sweepProfileMitred(mesh, railPath, railOut, railUp,
                                   { Vec2(-rw, -0.03f), Vec2(rw, -0.03f), Vec2(rw, 0.04f), Vec2(-rw, 0.04f) }, false, metal);
            };

            for (int floor = 0; floor < cfg.floorCount; ++floor) {
                float baseY = floorBaseY(cfg, floor);
                int runStart = -1;      // first bay of the current continuous-balcony run
                float runU0 = 0.0f, runU1 = 0.0f;
                for (int b = 0; b <= bayCount; ++b) {
                    OpeningSpec spec;
                    float center = 0.0f, openW = 0.0f;
                    if (b < bayCount) {
                        spec = resolveOpening(cfg, static_cast<int>(sideIdx), floor, b, bayCount, edges[b + 1] - edges[b]);
                        center = (edges[b] + edges[b + 1]) * 0.5f;
                        openW = spec.width;
                    }
                    // Close a continuous run when this bay does not continue it.
                    if (runStart >= 0 && (b == bayCount || spec.balcony != 2)) {
                        emitBalcony(runU0, runU1, baseY);
                        runStart = -1;
                    }
                    if (b == bayCount) break;
                    if (spec.entrance || !spec.open) continue;

                    float openBottom = baseY + spec.sill;
                    float openTop = openBottom + spec.height;
                    if (spec.hasSill && spec.sillProfile->size() >= 3) {
                        std::vector<Vec3> path = { at(center - openW * 0.5f - d.sillHornM, openBottom),
                                                   at(center + openW * 0.5f + d.sillHornM, openBottom) };
                        sweepProfileMitred(mesh, path, { side.normal }, { up }, *spec.sillProfile, false, trim);
                    }
                    if (spec.hasHood && spec.hoodProfile->size() >= 3) {
                        float half = openW * 0.5f + d.hoodExtensionM;
                        std::vector<Vec3> path = { at(center - half, openTop) };
                        if (spec.hoodPitchDeg > 0.01f) path.push_back(at(center, openTop + std::tan(spec.hoodPitchDeg * DEG_TO_RAD) * half));
                        path.push_back(at(center + half, openTop));
                        std::vector<Vec3> outs, ups;
                        for (size_t k = 0; k + 1 < path.size(); ++k) {
                            Vec3 t = (path[k + 1] - path[k]).normalized();
                            outs.push_back(side.normal);
                            ups.push_back((up - t * up.dot(t)).normalized());
                        }
                        sweepProfileMitred(mesh, path, outs, ups, *spec.hoodProfile, false, trim);
                    }

                    float half = openW * 0.5f + d.balconyExtraWidthM * 0.5f;
                    if (spec.balcony == 1) {
                        emitBalcony(center - half, center + half, baseY);
                    } else if (spec.balcony == 2) {
                        if (runStart < 0) { runStart = b; runU0 = center - half; }
                        runU1 = center + half;
                    }
                }
            }

            // Pilasters at bay boundaries: shaft plus flared base and capital, each a vertical sweep.
            if (d.pilasterWidthM > 0.0f) {
                // The pier between openings, from the resolved openings (rules can widen a window).
                float gap = 1e9f;
                for (int b = 0; b < bayCount; ++b) {
                    float bw = edges[b + 1] - edges[b];
                    float widest = 0.0f;
                    for (int f = 0; f < cfg.floorCount; ++f) {
                        const OpeningSpec o = resolveOpening(cfg, static_cast<int>(sideIdx), f, b, bayCount, bw);
                        if (o.open) widest = std::max(widest, o.width);
                    }
                    gap = std::min(gap, bw - widest);
                }
                float w = std::min(d.pilasterWidthM, gap * 0.9f);
                float yTop = totalH - (d.corniceProfile.size() >= 3 ? 0.05f : 0.0f);
                for (int b = 0; b <= bayCount; b += std::max(1, d.pilasterBayStride)) {
                    if (d.quoinCourseM > 0.0f && (b == 0 || b == bayCount)) continue;
                    if (outline && (b == 0 || b == bayCount)) continue;   // outline corners: one corner block each, below
                    Vec3 foot = Vec3(side.start.x, 0, side.start.z) + side.rightDir * edges[b];
                    // A corner pilaster never hangs past the corner over nothing: on the long sides it
                    // turns the corner by its own projection (a solid corner block), on the short sides it
                    // stops at the wall plane and meets that block.
                    const bool atStart = b == 0, atEnd = b == bayCount, longSide = sideIdx < 2;
                    auto block = [&](float y0, float y1, float halfW, float proj) {
                        float lo = -halfW, hi = halfW;
                        if (atStart) lo = longSide ? -proj : 0.02f;
                        if (atEnd) hi = longSide ? proj : -0.02f;
                        std::vector<Vec3> path = { foot + Vec3(0, y0, 0), foot + Vec3(0, y1, 0) };
                        sweepProfileMitred(mesh, path, { side.normal }, { side.rightDir },
                                           { Vec2(-0.02f, lo), Vec2(proj, lo), Vec2(proj, hi), Vec2(-0.02f, hi) }, false, trim);
                    };
                    float cap = d.pilasterCapitalM;
                    block(cfg.plinthHeight, yTop, w * 0.5f, d.pilasterProjectionM);
                    block(cfg.plinthHeight, cfg.plinthHeight + cap, w * 0.5f * d.pilasterFlare, d.pilasterProjectionM * d.pilasterFlare);
                    block(yTop - cap, yTop, w * 0.5f * d.pilasterFlare, d.pilasterProjectionM * d.pilasterFlare);
                }
            }

            // Dormers above the eave on every Nth bay: only where a roof slope rises behind the eave
            // (a flat, dome or vault roof has no slope to sit in; a gable's end walls have none either).
            if (d.dormerWidthM > 0.0f) {
                const bool pitched = cfg.roofType == RoofType::Gable || cfg.roofType == RoofType::Hip || cfg.roofType == RoofType::Mansard;
                if (!pitched) throw std::invalid_argument("dormers need a pitched roof (gable, hip or mansard); this roof has no slope for them to sit in");
                const bool slopeHere = cfg.roofType != RoofType::Gable || sideIdx < 2;
                for (int b = 0; slopeHere && b < bayCount; b += std::max(1, d.dormerBayStride)) {
                    Vec3 n = side.normal, r = side.rightDir;
                    Vec3 face = Vec3(side.start.x, totalH, side.start.z) + r * ((edges[b] + edges[b + 1]) * 0.5f) + n * (cfg.roofOverhang - d.dormerSetbackM);
                    float hw = d.dormerWidthM * 0.5f, h = d.dormerHeightM, depth = d.dormerDepthM;
                    float ridge = std::tan(d.dormerRoofPitchDeg * DEG_TO_RAD) * hw;
                    Vec3 fl = face - r * hw, fr = face + r * hw;
                    Vec3 bl = fl - n * depth, br = fr - n * depth;
                    // Floor, front wall and gable, cheeks, pitched roof.
                    addQuad(mesh, bl, br, fr, fl, -up, wall);
                    addQuad(mesh, fl, fr, fr + up * h, fl + up * h, n, wall);
                    addQuad(mesh, fl + up * h, fr + up * h, face + up * (h + ridge), face + up * (h + ridge), n, wall);
                    addQuad(mesh, bl, fl, fl + up * h, bl + up * h, -r, roof);
                    addQuad(mesh, fr, br, br + up * h, fr + up * h, r, roof);
                    Vec3 eaveL = fl + up * h - r * 0.12f + n * 0.15f, eaveR = fr + up * h + r * 0.12f + n * 0.15f;
                    Vec3 ridgeF = face + up * (h + ridge) + n * 0.15f, ridgeB = face - n * depth + up * (h + ridge);
                    addQuad(mesh, eaveL, ridgeF, ridgeB, bl + up * h - r * 0.12f, (-r * std::sin(d.dormerRoofPitchDeg * DEG_TO_RAD) + up * std::cos(d.dormerRoofPitchDeg * DEG_TO_RAD)).normalized(), roof);
                    addQuad(mesh, ridgeF, eaveR, br + up * h + r * 0.12f, ridgeB, (r * std::sin(d.dormerRoofPitchDeg * DEG_TO_RAD) + up * std::cos(d.dormerRoofPitchDeg * DEG_TO_RAD)).normalized(), roof);
                    // Window: glazing proud of the face, framed by four bars.
                    float ww = d.dormerWidthM * 0.62f, wh = h * 0.68f, wy = h * 0.16f;
                    Vec3 g0 = face - r * (ww * 0.5f) + up * wy + n * 0.01f;
                    addQuad(mesh, g0, g0 + r * ww, g0 + r * ww + up * wh, g0 + up * wh, n, glass);
                    float fw = 0.06f;
                    Vec3 o = n * 0.05f;
                    addQuad(mesh, g0 + o - r * fw, g0 + o, g0 + o + up * wh, g0 + o - r * fw + up * wh, n, metal);
                    addQuad(mesh, g0 + o + r * ww, g0 + o + r * (ww + fw), g0 + o + r * (ww + fw) + up * wh, g0 + o + r * ww + up * wh, n, metal);
                    addQuad(mesh, g0 + o - r * fw - up * fw, g0 + o + r * (ww + fw) - up * fw, g0 + o + r * (ww + fw), g0 + o - r * fw, n, metal);
                    addQuad(mesh, g0 + o - r * fw + up * wh, g0 + o + r * (ww + fw) + up * wh, g0 + o + r * (ww + fw) + up * (wh + fw), g0 + o - r * fw + up * (wh + fw), n, metal);
                    addQuad(mesh, g0 + o + r * (ww * 0.5f - fw * 0.5f), g0 + o + r * (ww * 0.5f + fw * 0.5f), g0 + o + r * (ww * 0.5f + fw * 0.5f) + up * wh, g0 + o + r * (ww * 0.5f - fw * 0.5f) + up * wh, n, metal);
                }
            }
        }

        // Outline corners: quoins and corner pilasters wrap each outside corner whatever its angle; an inside
        // corner gets neither (the two walls meet in a plain return).
        if (outline) {
            const float yTop = totalH - (d.corniceProfile.size() >= 3 ? 0.05f : 0.0f);
            for (const OutlineCorner& c : outlineCorners(cfg)) {
                if (!c.convex) continue;
                if (d.quoinCourseM > 0.0f) {
                    int courses = std::max(1, static_cast<int>((totalH - cfg.plinthHeight) / d.quoinCourseM));
                    float pitch = (totalH - cfg.plinthHeight) / courses;
                    for (int k = 0; k < courses; ++k) {
                        float y0 = cfg.plinthHeight + k * pitch, y1 = y0 + pitch - d.quoinJointM;
                        float a = (k % 2 == 0) ? d.quoinLongM : d.quoinShortM, b = (k % 2 == 0) ? d.quoinShortM : d.quoinLongM;
                        addCornerPrism(mesh, c, std::min(a, c.lenIn * 0.45f), std::min(b, c.lenOut * 0.45f), d.quoinProjectionM, y0, y1, trim);
                    }
                } else if (d.pilasterWidthM > 0.0f) {
                    float hw = std::min(d.pilasterWidthM * 0.5f, 0.45f * std::min(c.lenIn, c.lenOut));
                    float cap = d.pilasterCapitalM, f = d.pilasterFlare, pr = d.pilasterProjectionM;
                    addCornerPrism(mesh, c, hw, hw, pr, cfg.plinthHeight, yTop, trim);
                    addCornerPrism(mesh, c, hw * f, hw * f, pr * f, cfg.plinthHeight, cfg.plinthHeight + cap, trim);
                    addCornerPrism(mesh, c, hw * f, hw * f, pr * f, yTop - cap, yTop, trim);
                }
            }
        }

        // Quoins: corner blocks at a course pitch, alternating long and short on the two faces.
        if (d.quoinCourseM > 0.0f && !outline) {
            const float sx[4] = { 1, 1, -1, -1 }, sz[4] = { 1, -1, -1, 1 };
            int courses = std::max(1, static_cast<int>((totalH - cfg.plinthHeight) / d.quoinCourseM));
            float pitch = (totalH - cfg.plinthHeight) / courses;
            for (int c = 0; c < 4; ++c) {
                for (int k = 0; k < courses; ++k) {
                    float y0 = cfg.plinthHeight + k * pitch, y1 = y0 + pitch - d.quoinJointM;
                    float alongX = (k % 2 == 0) ? d.quoinLongM : d.quoinShortM;
                    float alongZ = (k % 2 == 0) ? d.quoinShortM : d.quoinLongM;
                    float xIn = sx[c] * (hx - alongX), xOut = sx[c] * (hx + d.quoinProjectionM);
                    float zIn = sz[c] * (hz - alongZ), zOut = sz[c] * (hz + d.quoinProjectionM);
                    addBox(mesh, Vec3(std::min(xIn, xOut), y0, std::min(zIn, zOut)),
                           Vec3(std::max(xIn, xOut), y1, std::max(zIn, zOut)), trim);
                }
            }
        }

        // Chimneys rising through the roof, with a flared cap and lathed pots.
        if (d.chimneyCount > 0 && !outline) {
            for (const Vec3& stackTop : chimneyStackTops(cfg)) {
                float x = stackTop.x, z = stackTop.z, top = stackTop.y;
                float hw = d.chimneyWidthM * 0.5f, hd = d.chimneyDepthM * 0.5f;
                addBox(mesh, Vec3(x - hw, totalH, z - hd), Vec3(x + hw, top, z + hd), wall);
                addBox(mesh, Vec3(x - hw - 0.06f, top, z - hd - 0.06f), Vec3(x + hw + 0.06f, top + d.chimneyCapM, z + hd + 0.06f), trim);
                for (int p = 0; p < d.chimneyPotCount; ++p) {
                    float pt = d.chimneyPotCount == 1 ? 0.5f : static_cast<float>(p) / (d.chimneyPotCount - 1);
                    Vec3 pBase(x - hw * 0.55f + hw * 1.1f * pt, top + d.chimneyCapM, z);
                    float R = d.chimneyPotRadiusM;
                    addLathe(mesh, pBase, d.chimneyPotHeightM, [R](float u) {
                        return R * (1.0f - 0.25f * u + (u > 0.85f ? 0.2f : 0.0f));
                    }, 6, 12, roof);
                }
            }
        }
    }

    static void generateFloorSlabs(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        if (hasOutline(cfg)) {
            const auto loops = outlineLoops(cfg);
            const Vec4 trim = cfg.materials.foundation.baseColorFactor;
            const auto& scf = cfg.details.stringCourseFloors;
            for (int floor = 0; floor <= cfg.floorCount; ++floor) {
                const float y = floorBaseY(cfg, floor);
                addCapLoops(mesh, loops, y, true, trim * 0.8f);
                bool profiledBand = floor == cfg.floorCount
                    ? cfg.details.corniceProfile.size() >= 3
                    : cfg.details.stringCourseProfile.size() >= 3 && (scf.empty() || std::find(scf.begin(), scf.end(), floor) != scf.end());
                if (floor == 0 || profiledBand) continue;
                // The box belt course of the rectangle, as a section swept round every loop: drip face, front, wash.
                const bool cornice = floor == cfg.floorCount;
                const float proj = cornice ? 0.32f : 0.16f, h = cornice ? 0.28f : 0.16f;
                addHorizontalLoop(mesh, cfg, y, { Vec2(0.0f, -h), Vec2(proj, -h), Vec2(proj, 0.0f), Vec2(0.0f, 0.04f) }, trim);
            }
            return;
        }
        float hx = cfg.width * 0.5f;
        float hz = cfg.depth * 0.5f;
        float currY = cfg.plinthHeight;

        for (int floor = 0; floor <= cfg.floorCount; ++floor) {
            // Horizontal interior floor slab quad (ceiling of lower, floor of upper)
            Vec3 p0(-hx, currY,  hz);
            Vec3 p1( hx, currY,  hz);
            Vec3 p2( hx, currY, -hz);
            Vec3 p3(-hx, currY, -hz);

            // Upward facing
            addQuad(mesh, p0, p1, p2, p3, Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.8f);

            // Exterior projecting belt course / stringcourse moulding wrapping the perimeter
            // A profile replaces the box belt only on the floor lines it is swept on (generateFacadeDetails
            // sweeps the listed string_course_floors, or every line when none are listed).
            const auto& scf = cfg.details.stringCourseFloors;
            bool profiledBand = floor == cfg.floorCount
                ? cfg.details.corniceProfile.size() >= 3
                : cfg.details.stringCourseProfile.size() >= 3 && (scf.empty() || std::find(scf.begin(), scf.end(), floor) != scf.end());
            if (floor > 0 && !profiledBand) {
                bool isRoofCornice = (floor == cfg.floorCount);
                float beltProj = isRoofCornice ? 0.32f : 0.16f;
                float beltH = isRoofCornice ? 0.28f : 0.16f;
                float bTopY = currY;
                float bBotY = currY - beltH;

                float outX = hx + beltProj;
                float outZ = hz + beltProj;

                // 4-side exterior belt course quads:
                // Front (+Z)
                addQuad(mesh, Vec3(-outX, bBotY, outZ), Vec3(outX, bBotY, outZ), Vec3(outX, bTopY, outZ), Vec3(-outX, bTopY, outZ), Vec3(0, 0, 1), cfg.materials.foundation.baseColorFactor);
                // Back (-Z)
                addQuad(mesh, Vec3(outX, bBotY, -outZ), Vec3(-outX, bBotY, -outZ), Vec3(-outX, bTopY, -outZ), Vec3(outX, bTopY, -outZ), Vec3(0, 0, -1), cfg.materials.foundation.baseColorFactor);
                // Left (-X)
                addQuad(mesh, Vec3(-outX, bBotY, -outZ), Vec3(-outX, bBotY, outZ), Vec3(-outX, bTopY, outZ), Vec3(-outX, bTopY, -outZ), Vec3(-1, 0, 0), cfg.materials.foundation.baseColorFactor);
                // Right (+X)
                addQuad(mesh, Vec3(outX, bBotY, outZ), Vec3(outX, bBotY, -outZ), Vec3(outX, bTopY, -outZ), Vec3(outX, bTopY, outZ), Vec3(1, 0, 0), cfg.materials.foundation.baseColorFactor);

                // Top wash (slopes down from wall to outer edge)
                addQuad(mesh, Vec3(-hx, bTopY + 0.04f, hz), Vec3(hx, bTopY + 0.04f, hz), Vec3(outX, bTopY, outZ), Vec3(-outX, bTopY, outZ), Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);
                addQuad(mesh, Vec3(hx, bTopY + 0.04f, -hz), Vec3(-hx, bTopY + 0.04f, -hz), Vec3(-outX, bTopY, -outZ), Vec3(outX, bTopY, -outZ), Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);
                addQuad(mesh, Vec3(-hx, bTopY + 0.04f, -hz), Vec3(-hx, bTopY + 0.04f, hz), Vec3(-outX, bTopY, outZ), Vec3(-outX, bTopY, -outZ), Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);
                addQuad(mesh, Vec3(hx, bTopY + 0.04f, hz), Vec3(hx, bTopY + 0.04f, -hz), Vec3(outX, bTopY, -outZ), Vec3(outX, bTopY, outZ), Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 1.05f);

                // Underside drip face (casts continuous shadow onto wall below)
                addQuad(mesh, Vec3(-hx, bBotY, hz), Vec3(-outX, bBotY, outZ), Vec3(outX, bBotY, outZ), Vec3(hx, bBotY, hz), -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.60f);
                addQuad(mesh, Vec3(hx, bBotY, -hz), Vec3(outX, bBotY, -outZ), Vec3(-outX, bBotY, -outZ), Vec3(-hx, bBotY, -hz), -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.60f);
                addQuad(mesh, Vec3(-hx, bBotY, -hz), Vec3(-outX, bBotY, -outZ), Vec3(-outX, bBotY, outZ), Vec3(-hx, bBotY, hz), -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.60f);
                addQuad(mesh, Vec3(hx, bBotY, hz), Vec3(outX, bBotY, outZ), Vec3(outX, bBotY, -outZ), Vec3(hx, bBotY, -hz), -Vec3(0, 1, 0), cfg.materials.foundation.baseColorFactor * 0.60f);
            }

            if (floor < cfg.floorCount) {
                currY += floorHeightOf(cfg, floor);
            }
        }
    }

    static void generateRoof(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        float totalH = floorBaseY(cfg, cfg.floorCount);

        switch (cfg.roofType) {
            case RoofType::FlatParapet:
                generateFlatParapetRoof(cfg, totalH, mesh);
                break;
            case RoofType::Gable:
                generateGableRoof(cfg, totalH, mesh);
                break;
            case RoofType::Hip:
                generateHipRoof(cfg, totalH, mesh);
                break;
            case RoofType::Mansard:
                generateMansardRoof(cfg, totalH, mesh);
                break;
            case RoofType::Dome:
            case RoofType::BarrelVault:
            default:
                generateFlatParapetRoof(cfg, totalH, mesh);
                break;
        }
    }

    static void generateFlatParapetRoof(const BuildingConfig& cfg, float totalH, ScratchboxMesh& mesh) {
        if (hasOutline(cfg)) {
            const auto loops = outlineLoops(cfg);
            const auto inner = offsetLoops(loops, -cfg.parapetThickness);
            const float ph = cfg.parapetHeight, top = totalH + ph, deck = totalH + 0.1f;
            const Vec4 wall = cfg.materials.wall.baseColorFactor, roof = cfg.materials.roof.baseColorFactor;
            for (size_t l = 0; l < loops.size(); ++l) {
                const auto& o = loops[l];
                const auto& in = inner[l];
                const size_t n = o.size();
                for (size_t i = 0; i < n; ++i) {
                    const size_t j = (i + 1) % n;
                    const Vec3 nrm = edgeNormal3((o[j] - o[i]).normalized());
                    addQuad(mesh, Vec3(o[i].x, totalH, o[i].y), Vec3(o[j].x, totalH, o[j].y), Vec3(o[j].x, top, o[j].y), Vec3(o[i].x, top, o[i].y), nrm, wall);
                    addQuad(mesh, Vec3(o[i].x, top, o[i].y), Vec3(o[j].x, top, o[j].y), Vec3(in[j].x, top, in[j].y), Vec3(in[i].x, top, in[i].y), Vec3(0, 1, 0), roof);
                    addQuad(mesh, Vec3(in[i].x, deck, in[i].y), Vec3(in[j].x, deck, in[j].y), Vec3(in[j].x, top, in[j].y), Vec3(in[i].x, top, in[i].y), -nrm, wall * 0.9f);
                }
            }
            addCapLoops(mesh, inner, deck, true, roof * 0.75f);
            return;
        }
        float hx = cfg.width * 0.5f;
        float hz = cfg.depth * 0.5f;
        float ph = cfg.parapetHeight;
        float pt = cfg.parapetThickness;

        // Outer parapet walls
        // Front (+Z)
        addQuad(mesh,
            Vec3(-hx, totalH, hz), Vec3(hx, totalH, hz),
            Vec3(hx, totalH + ph, hz), Vec3(-hx, totalH + ph, hz),
            Vec3(0, 0, 1), cfg.materials.wall.baseColorFactor);
        // Back (-Z)
        addQuad(mesh,
            Vec3(hx, totalH, -hz), Vec3(-hx, totalH, -hz),
            Vec3(-hx, totalH + ph, -hz), Vec3(hx, totalH + ph, -hz),
            Vec3(0, 0, -1), cfg.materials.wall.baseColorFactor);
        // Left (-X)
        addQuad(mesh,
            Vec3(-hx, totalH, -hz), Vec3(-hx, totalH, hz),
            Vec3(-hx, totalH + ph, hz), Vec3(-hx, totalH + ph, -hz),
            Vec3(-1, 0, 0), cfg.materials.wall.baseColorFactor);
        // Right (+X)
        addQuad(mesh,
            Vec3(hx, totalH, hz), Vec3(hx, totalH, -hz),
            Vec3(hx, totalH + ph, -hz), Vec3(hx, totalH + ph, hz),
            Vec3(1, 0, 0), cfg.materials.wall.baseColorFactor);

        // Coping / Cap on top of parapet
        float inX = hx - pt;
        float inZ = hz - pt;
        // Top cap
        addQuad(mesh,
            Vec3(-hx, totalH + ph, hz), Vec3(hx, totalH + ph, hz),
            Vec3(inX, totalH + ph, inZ), Vec3(-inX, totalH + ph, inZ),
            Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);
        addQuad(mesh,
            Vec3(hx, totalH + ph, -hz), Vec3(-hx, totalH + ph, -hz),
            Vec3(-inX, totalH + ph, -inZ), Vec3(inX, totalH + ph, -inZ),
            Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);
        addQuad(mesh,
            Vec3(-hx, totalH + ph, -hz), Vec3(-hx, totalH + ph, hz),
            Vec3(-inX, totalH + ph, inZ), Vec3(-inX, totalH + ph, -inZ),
            Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);
        addQuad(mesh,
            Vec3(hx, totalH + ph, hz), Vec3(hx, totalH + ph, -hz),
            Vec3(inX, totalH + ph, -inZ), Vec3(inX, totalH + ph, inZ),
            Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor);

        // Inner parapet walls: close the gap between the coping's inner edge (totalH + ph) and the roof deck
        // (totalH) — each is the matching outer wall's quad, reversed and inset, so its normal faces inward.
        addQuad(mesh,
            Vec3(-inX, totalH + ph, inZ), Vec3(inX, totalH + ph, inZ),
            Vec3(inX, totalH, inZ), Vec3(-inX, totalH, inZ),
            Vec3(0, 0, -1), cfg.materials.wall.baseColorFactor * 0.85f);
        addQuad(mesh,
            Vec3(inX, totalH + ph, -inZ), Vec3(-inX, totalH + ph, -inZ),
            Vec3(-inX, totalH, -inZ), Vec3(inX, totalH, -inZ),
            Vec3(0, 0, 1), cfg.materials.wall.baseColorFactor * 0.85f);
        addQuad(mesh,
            Vec3(-inX, totalH + ph, -inZ), Vec3(-inX, totalH + ph, inZ),
            Vec3(-inX, totalH, inZ), Vec3(-inX, totalH, -inZ),
            Vec3(1, 0, 0), cfg.materials.wall.baseColorFactor * 0.85f);
        addQuad(mesh,
            Vec3(inX, totalH + ph, inZ), Vec3(inX, totalH + ph, -inZ),
            Vec3(inX, totalH, -inZ), Vec3(inX, totalH, inZ),
            Vec3(-1, 0, 0), cfg.materials.wall.baseColorFactor * 0.85f);

        // Flat roof deck surface, flush with the top floor slab (totalH) so its edges exactly match the inner
        // parapet walls' bottom edges above — manifold-connected, not a disconnected plate floating at +0.1m.
        addQuad(mesh,
            Vec3(-inX, totalH, inZ), Vec3(inX, totalH, inZ),
            Vec3(inX, totalH, -inZ), Vec3(-inX, totalH, -inZ),
            Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor * 0.75f);
    }

    static void generateGableRoof(const BuildingConfig& cfg, float totalH, ScratchboxMesh& mesh) {
        float hx = cfg.width * 0.5f + cfg.roofOverhang;
        float hz = cfg.depth * 0.5f + cfg.roofOverhang;
        float pitchRad = cfg.roofPitchDegrees * DEG_TO_RAD;
        float ridgeH = std::tan(pitchRad) * hz;
        float yRidge = totalH + ridgeH;

        // Ridge line along X-axis
        Vec3 rL(-hx, yRidge, 0.0f);
        Vec3 rR( hx, yRidge, 0.0f);

        Vec3 eFL(-hx, totalH,  hz);
        Vec3 eFR( hx, totalH,  hz);
        Vec3 eBL(-hx, totalH, -hz);
        Vec3 eBR( hx, totalH, -hz);

        // Front Slope (+Z)
        Vec3 nFront = Vec3(0, hz, ridgeH).normalized();
        addQuad(mesh, eFL, eFR, rR, rL, nFront, cfg.materials.roof.baseColorFactor);

        // Back Slope (-Z)
        Vec3 nBack = Vec3(0, hz, -ridgeH).normalized();
        addQuad(mesh, rL, rR, eBR, eBL, nBack, cfg.materials.roof.baseColorFactor);

        // Left Gable End Wall (Triangle)
        uint32_t bLeft = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 nLeft(-1, 0, 0);
        Vec4 wallCol = cfg.materials.wall.baseColorFactor;
        mesh.addVertex(Vertex(Vec3(-cfg.width * 0.5f, totalH,  cfg.depth * 0.5f), nLeft, Vec2(0, 0), wallCol, Vec4(0, 0, 1, 1)));
        mesh.addVertex(Vertex(Vec3(-cfg.width * 0.5f, totalH, -cfg.depth * 0.5f), nLeft, Vec2(1, 0), wallCol, Vec4(0, 0, 1, 1)));
        mesh.addVertex(Vertex(Vec3(-cfg.width * 0.5f, yRidge, 0.0f), nLeft, Vec2(0.5f, 1), wallCol, Vec4(0, 0, 1, 1)));
        mesh.addTriangle(bLeft, bLeft + 1, bLeft + 2);

        // Right Gable End Wall (Triangle)
        uint32_t bRight = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 nRight(1, 0, 0);
        mesh.addVertex(Vertex(Vec3(cfg.width * 0.5f, totalH, -cfg.depth * 0.5f), nRight, Vec2(0, 0), wallCol, Vec4(0, 0, -1, 1)));
        mesh.addVertex(Vertex(Vec3(cfg.width * 0.5f, totalH,  cfg.depth * 0.5f), nRight, Vec2(1, 0), wallCol, Vec4(0, 0, -1, 1)));
        mesh.addVertex(Vertex(Vec3(cfg.width * 0.5f, yRidge, 0.0f), nRight, Vec2(0.5f, 1), wallCol, Vec4(0, 0, -1, 1)));
        mesh.addTriangle(bRight, bRight + 1, bRight + 2);
    }

    static void generateHipRoof(const BuildingConfig& cfg, float totalH, ScratchboxMesh& mesh) {
        float hx = cfg.width * 0.5f + cfg.roofOverhang;
        float hz = cfg.depth * 0.5f + cfg.roofOverhang;
        float pitchRad = cfg.roofPitchDegrees * DEG_TO_RAD;

        // For a rectangular hip roof, ridge length = |width - depth|
        float halfSpan = std::min(hx, hz);
        float ridgeH = std::tan(pitchRad) * halfSpan;
        float yRidge = totalH + ridgeH;

        float ridgeOffset = std::max(0.0f, hx - hz);
        Vec3 rL(-ridgeOffset, yRidge, 0.0f);
        Vec3 rR( ridgeOffset, yRidge, 0.0f);

        Vec3 eFL(-hx, totalH,  hz);
        Vec3 eFR( hx, totalH,  hz);
        Vec3 eBL(-hx, totalH, -hz);
        Vec3 eBR( hx, totalH, -hz);

        // Front slope (Trapezoid)
        Vec3 nFront = Vec3(0, hz, ridgeH).normalized();
        addQuad(mesh, eFL, eFR, rR, rL, nFront, cfg.materials.roof.baseColorFactor);

        // Back slope (Trapezoid)
        Vec3 nBack = Vec3(0, hz, -ridgeH).normalized();
        addQuad(mesh, rL, rR, eBR, eBL, nBack, cfg.materials.roof.baseColorFactor);

        // Left hip slope (Triangle)
        uint32_t bLeft = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 nLeft = Vec3(-ridgeH, halfSpan, 0).normalized();
        mesh.addVertex(Vertex(eBL, nLeft, Vec2(0, 0), cfg.materials.roof.baseColorFactor, Vec4(0, 0, 1, 1)));
        mesh.addVertex(Vertex(eFL, nLeft, Vec2(1, 0), cfg.materials.roof.baseColorFactor, Vec4(0, 0, 1, 1)));
        mesh.addVertex(Vertex(rL,  nLeft, Vec2(0.5f, 1), cfg.materials.roof.baseColorFactor, Vec4(0, 0, 1, 1)));
        mesh.addTriangle(bLeft, bLeft + 1, bLeft + 2);

        // Right hip slope (Triangle)
        uint32_t bRight = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 nRight = Vec3(ridgeH, halfSpan, 0).normalized();
        mesh.addVertex(Vertex(eFR, nRight, Vec2(0, 0), cfg.materials.roof.baseColorFactor, Vec4(0, 0, -1, 1)));
        mesh.addVertex(Vertex(eBR, nRight, Vec2(1, 0), cfg.materials.roof.baseColorFactor, Vec4(0, 0, -1, 1)));
        mesh.addVertex(Vertex(rR,  nRight, Vec2(0.5f, 1), cfg.materials.roof.baseColorFactor, Vec4(0, 0, -1, 1)));
        mesh.addTriangle(bRight, bRight + 1, bRight + 2);
    }

    static void generateMansardRoof(const BuildingConfig& cfg, float totalH, ScratchboxMesh& mesh) {
        float hx = cfg.width * 0.5f + cfg.roofOverhang;
        float hz = cfg.depth * 0.5f + cfg.roofOverhang;

        // Stage 1: Steep curb pitch (65-75 degrees)
        float curbH = 2.4f;
        float curbInset = 1.2f;
        float yCurb = totalH + curbH;
        float curbX = hx - curbInset;
        float curbZ = hz - curbInset;

        Vec3 eFL(-hx, totalH,  hz);
        Vec3 eFR( hx, totalH,  hz);
        Vec3 eBL(-hx, totalH, -hz);
        Vec3 eBR( hx, totalH, -hz);

        Vec3 cFL(-curbX, yCurb,  curbZ);
        Vec3 cFR( curbX, yCurb,  curbZ);
        Vec3 cBL(-curbX, yCurb, -curbZ);
        Vec3 cBR( curbX, yCurb, -curbZ);

        // Steep lower slopes
        Vec3 nFront = Vec3(0, curbInset, curbH).normalized();
        Vec3 nBack = Vec3(0, curbInset, -curbH).normalized();
        Vec3 nLeft = Vec3(-curbH, curbInset, 0).normalized();
        Vec3 nRight = Vec3(curbH, curbInset, 0).normalized();

        addQuad(mesh, eFL, eFR, cFR, cFL, nFront, cfg.materials.roof.baseColorFactor);
        addQuad(mesh, eBR, eBL, cBL, cBR, nBack, cfg.materials.roof.baseColorFactor);
        addQuad(mesh, eBL, eFL, cFL, cBL, nLeft, cfg.materials.roof.baseColorFactor);
        addQuad(mesh, eFR, eBR, cBR, cFR, nRight, cfg.materials.roof.baseColorFactor);

        // Standing seam ribs along steep lower mansard slopes (zinc / copper battens)
        auto addMansardStandingSeam = [&](const Vec3& pBot, const Vec3& pTop, const Vec3& norm, const Vec3& tan) {
            float ribW = 0.045f;
            float ribH = 0.065f;
            Vec3 wOff = tan * (ribW * 0.5f);
            Vec3 hOff = norm * ribH;

            Vec3 b0 = pBot - wOff;
            Vec3 b1 = pBot + wOff;
            Vec3 t0 = pTop - wOff;
            Vec3 t1 = pTop + wOff;

            // Front cap
            addQuad(mesh, b0 + hOff, b1 + hOff, t1 + hOff, t0 + hOff, norm, cfg.materials.roof.baseColorFactor * 1.15f);
            // Flanks
            addQuad(mesh, b0, b0 + hOff, t0 + hOff, t0, -tan, cfg.materials.roof.baseColorFactor * 0.85f);
            addQuad(mesh, b1 + hOff, b1, t1, t1 + hOff, tan, cfg.materials.roof.baseColorFactor * 0.85f);
        };

        float ribStep = 1.1f;
        for (float rx = -curbX + 0.8f; rx <= curbX - 0.8f; rx += ribStep) {
            float u = (rx + hx) / (2.0f * hx);
            addMansardStandingSeam(math::lerp(eFL, eFR, u), math::lerp(cFL, cFR, u), nFront, Vec3(1, 0, 0));
            addMansardStandingSeam(math::lerp(eBL, eBR, u), math::lerp(cBL, cBR, u), nBack, Vec3(1, 0, 0));
        }
        for (float rz = -curbZ + 0.8f; rz <= curbZ - 0.8f; rz += ribStep) {
            float u = (rz + hz) / (2.0f * hz);
            addMansardStandingSeam(math::lerp(eBL, eFL, u), math::lerp(cBL, cFL, u), nLeft, Vec3(0, 0, 1));
            addMansardStandingSeam(math::lerp(eBR, eFR, u), math::lerp(cBR, cFR, u), nRight, Vec3(0, 0, 1));
        }

        // Stage 2: Shallow upper deck
        float deckH = 0.8f;
        float yDeck = yCurb + deckH;
        float deckX = curbX - 1.5f;
        float deckZ = curbZ - 1.5f;

        Vec3 dFL(-deckX, yDeck,  deckZ);
        Vec3 dFR( deckX, yDeck,  deckZ);
        Vec3 dBL(-deckX, yDeck, -deckZ);
        Vec3 dBR( deckX, yDeck, -deckZ);

        addQuad(mesh, cFL, cFR, dFR, dFL, Vec3(0, 1.5f, deckH).normalized(), cfg.materials.roof.baseColorFactor * 0.9f);
        addQuad(mesh, cBR, cBL, dBL, dBR, Vec3(0, 1.5f, -deckH).normalized(), cfg.materials.roof.baseColorFactor * 0.9f);
        addQuad(mesh, cBL, cFL, dFL, dBL, Vec3(-deckH, 1.5f, 0).normalized(), cfg.materials.roof.baseColorFactor * 0.9f);
        addQuad(mesh, cFR, cBR, dBR, dFR, Vec3(deckH, 1.5f, 0).normalized(), cfg.materials.roof.baseColorFactor * 0.9f);

        // Top flat cap
        addQuad(mesh, dFL, dFR, dBR, dBL, Vec3(0, 1, 0), cfg.materials.roof.baseColorFactor * 0.8f);
    }
};

} // namespace architecture
} // namespace scratchbox

#endif // SCRATCHBOX_ARCHITECTURE_HPP
