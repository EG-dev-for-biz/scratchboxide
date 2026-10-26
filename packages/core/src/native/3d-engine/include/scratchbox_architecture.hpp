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

namespace scratchbox {
namespace architecture {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
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
    float superellipseExponent{10.0f};  // Lamé exponent m (2.0 = ellipse, 2.4 = squircle, 10.0 = box); a box by default so curvature 0 stays rectangular
    float twistDegrees{0.0f};           // Helical rotation across height (degrees)
    float taper{1.0f};                  // Crown scale ratio relative to base
    float bulge{0.0f};                  // Mid-height barrel swelling / entasis ratio
    int bayCount{0};                    // Radial window bays along curved perimeter (0 = auto)
    bool bakeCurvatureAO{true};         // Automatic Laplace-Beltrami vertex baking

    BuildingMaterials materials{BuildingMaterials::createArchitecturalPalette()};
};

// ============================================================================
// 2. PROCEDURAL BUILDING GENERATOR ENGINE
// ============================================================================

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

        float totalH = cfg.plinthHeight + cfg.groundFloorHeight + cfg.floorHeight * static_cast<float>(std::max(1, cfg.floorCount - 1));
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
        }

        // 2. Stories & Facades
        float yCur = cfg.plinthHeight;
        for (int floor = 0; floor < cfg.floorCount; ++floor) {
            float fHeight = (floor == 0 ? cfg.groundFloorHeight : cfg.floorHeight);
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
        if (cfg.roofType == RoofType::Dome) {
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
            return generateCurvedBuilding(config, name);
        }

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


        if (config.bakeCurvatureAO) {
            mesh.computeCurvatureAO(0.65f);
        }

        // Vertex colours carry every part's colour (walls, roof, glass, AO); a white base factor keeps glTF's
        // baseColorFactor x COLOR_0 product from applying the wall colour a second time.
        mesh.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, mesh.material.baseColorFactor.w);
        mesh.recomputeBounds();
        return mesh;
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

        std::vector<ScratchboxMesh> parts;
        for (int i = 0; i < slotCount; ++i) {
            ScratchboxMesh part(name + "_" + slots[i].suffix);
            part.material = *slots[i].material;
            part.material.name = name + "_" + slots[i].suffix;
            parts.push_back(std::move(part));
        }

        const Vec3 up(0, 1, 0);
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
            Vec3 tangent = up.cross(faceN);
            if (tangent.length() < 1e-4f) tangent = Vec3(1, 0, 0);
            tangent = tangent.normalized();
            Vec3 bitangent = faceN.cross(tangent);

            ScratchboxMesh& part = parts[best];
            uint32_t base = static_cast<uint32_t>(part.vertices.size());
            for (const Vertex* v : tri) {
                Vec3 col(v->color.x, v->color.y, v->color.z);
                float shade = std::clamp(col.dot(slots[best].code), 0.0f, 1.0f);
                Vertex out = *v;
                out.color = Vec4(shade, shade, shade, 1.0f);
                out.uv = Vec2(v->position.dot(tangent), -v->position.dot(bitangent));
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
        float hx = cfg.width * 0.5f + cfg.plinthOffset;
        float hz = cfg.depth * 0.5f + cfg.plinthOffset;
        Vec3 minP(-hx, 0.0f, -hz);
        Vec3 maxP(hx, cfg.plinthHeight, hz);
        addBox(mesh, minP, maxP, cfg.materials.foundation.baseColorFactor);
    }

    static void generateFacades(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        float hx = cfg.width * 0.5f;
        float hz = cfg.depth * 0.5f;
        float yBase = cfg.plinthHeight;

        // Build each facade side:
        // 0: South (+Z), 1: North (-Z), 2: East (+X), 3: West (-X)
        struct SideInfo {
            Vec3 start;
            Vec3 rightDir;
            Vec3 normal;
            float length;
            bool hasEntrance;
        };

        std::vector<SideInfo> sides = {
            { Vec3(-hx, yBase,  hz), Vec3(1, 0, 0), Vec3(0, 0,  1), cfg.width, true  }, // South (front entrance)
            { Vec3( hx, yBase, -hz), Vec3(-1, 0, 0), Vec3(0, 0, -1), cfg.width, false }, // North
            { Vec3( hx, yBase,  hz), Vec3(0, 0, -1), Vec3(1, 0,  0), cfg.depth, false }, // East
            { Vec3(-hx, yBase, -hz), Vec3(0, 0,  1), Vec3(-1, 0,  0), cfg.depth, false }  // West
        };

        for (const auto& side : sides) {
            float currY = yBase;

            for (int floor = 0; floor < cfg.floorCount; ++floor) {
                float curFloorH = (floor == 0) ? cfg.groundFloorHeight : cfg.floorHeight;
                float yNext = currY + curFloorH;

                // Calculate rhythmic window bays
                int bayCount = std::max(1, static_cast<int>(side.length / cfg.bayWidth));
                float actualBayW = side.length / static_cast<float>(bayCount);

                for (int b = 0; b < bayCount; ++b) {
                    float u0 = static_cast<float>(b) * actualBayW;
                    float u1 = u0 + actualBayW;
                    float bayCenterU = (u0 + u1) * 0.5f;

                    // Check if this bay has the ground floor entrance
                    bool isEntranceBay = (floor == 0 && side.hasEntrance && b == bayCount / 2);

                    float openW = isEntranceBay ? cfg.doorWidth : cfg.windowWidth;
                    float openH = isEntranceBay ? cfg.doorHeight : cfg.windowHeight;
                    float openSill = isEntranceBay ? 0.0f : cfg.sillHeight;

                    // Ensure opening fits inside bay
                    openW = std::min(openW, actualBayW * 0.85f);
                    openH = std::min(openH, curFloorH - openSill - 0.4f);

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
                    if (!isEntranceBay && openSill > 0.001f) {
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
                    if (!isEntranceBay) {
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

    static void generateFloorSlabs(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
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
            if (floor > 0) {
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
                float curFloorH = (floor == 0) ? cfg.groundFloorHeight : cfg.floorHeight;
                currY += curFloorH;
            }
        }
    }

    static void generateRoof(const BuildingConfig& cfg, ScratchboxMesh& mesh) {
        float totalH = cfg.plinthHeight + cfg.groundFloorHeight + cfg.floorHeight * static_cast<float>(cfg.floorCount - 1);

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

        // Flat roof deck surface
        addQuad(mesh,
            Vec3(-inX, totalH + 0.1f, inZ), Vec3(inX, totalH + 0.1f, inZ),
            Vec3(inX, totalH + 0.1f, -inZ), Vec3(-inX, totalH + 0.1f, -inZ),
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
