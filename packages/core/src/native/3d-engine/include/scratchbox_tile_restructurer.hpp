/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_TILE_RESTRUCTURER_HPP
#define SCRATCHBOX_TILE_RESTRUCTURER_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_tiles.hpp"
#include "scratchbox_io.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <unordered_map>
#include <iostream>
#include <iomanip>
#include <sstream>

namespace scratchbox {
namespace restructurer {

namespace tiles = scratchbox::tiles;

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::AABB;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// 1. Data Contracts & Enums
// ============================================================================

enum class TileStyle {
    SolarpunkCitadel,
    NeoclassicalMonument,
    BrutalistFortress,
    GothicCathedral,
    SciFiOutpost,
    Custom
};

inline const char* getTileStyleName(TileStyle style) {
    switch (style) {
        case TileStyle::SolarpunkCitadel:     return "SolarpunkCitadel";
        case TileStyle::NeoclassicalMonument: return "NeoclassicalMonument";
        case TileStyle::BrutalistFortress:    return "BrutalistFortress";
        case TileStyle::GothicCathedral:      return "GothicCathedral";
        case TileStyle::SciFiOutpost:         return "SciFiOutpost";
        case TileStyle::Custom:
        default:                              return "Custom";
    }
}

inline TileStyle parseTileStyle(const std::string& name) {
    std::string lower = name;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower.find("solarpunk") != std::string::npos) return TileStyle::SolarpunkCitadel;
    if (lower.find("neoclassical") != std::string::npos || lower.find("roman") != std::string::npos || lower.find("classical") != std::string::npos) return TileStyle::NeoclassicalMonument;
    if (lower.find("brutalist") != std::string::npos || lower.find("fortress") != std::string::npos) return TileStyle::BrutalistFortress;
    if (lower.find("gothic") != std::string::npos || lower.find("cathedral") != std::string::npos) return TileStyle::GothicCathedral;
    if (lower.find("scifi") != std::string::npos || lower.find("sci_fi") != std::string::npos || lower.find("outpost") != std::string::npos || lower.find("cyber") != std::string::npos) return TileStyle::SciFiOutpost;
    return TileStyle::Custom;
}

enum class RestructureMaterialMode {
    StylizedPbr,
    StudioClay,
    HybridPhotogrammetric
};

inline RestructureMaterialMode parseMaterialMode(const std::string& mode) {
    std::string lower = mode;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    if (lower.find("clay") != std::string::npos) return RestructureMaterialMode::StudioClay;
    if (lower.find("hybrid") != std::string::npos) return RestructureMaterialMode::HybridPhotogrammetric;
    return RestructureMaterialMode::StylizedPbr;
}

struct TerraformingOp {
    std::string type{"terrace"}; // terrace, plateau_level, crater_basin, trench_moat, ridge_ramp
    Vec3 center{0.0f, 0.0f, 0.0f};
    float radius{15.0f};
    float targetElevation{0.0f};
    float stepHeight{3.0f};
    int stepCount{3};
    float depth{4.0f};
    float blendRadius{4.0f};
};

struct PrimitiveGraft {
    std::string type{"obelisk"}; // obelisk, column_colonnade, dome, gothic_portal, stepped_pyramid, pylon_gate, buttress
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 scale{1.0f, 1.0f, 1.0f};
    float rotationYDeg{0.0f};
    int count{1};
    float radius{6.0f};
    std::string anchor{"custom"}; // custom, corners, apex, plaza, center, perimeter, entrance
    bool adaptToTerrain{true};
};

struct TileRestructureConfig {
    TileStyle style{TileStyle::SolarpunkCitadel};
    RestructureMaterialMode materialMode{RestructureMaterialMode::StylizedPbr};
    std::string clayPreset{"ArchitecturalWhite"};
    std::vector<TerraformingOp> terraforming;
    std::vector<PrimitiveGraft> primitives;
    float weldEpsilon{0.02f};
    bool computeCurvature{true};
};

struct TileTopography {
    AABB bounds;
    float reliefDeltaY{0.0f};
    Vec3 apex{0.0f, 0.0f, 0.0f};
    Vec3 basin{0.0f, 0.0f, 0.0f};
    Vec3 centerPlaza{0.0f, 0.0f, 0.0f};
    Vec3 focalCenter{0.0f, 0.0f, 0.0f};
    std::vector<Vec3> corners; // 4 ground corners: [SW, SE, NE, NW]
    float averageElevation{0.0f};
    float averageSlopeDeg{0.0f};
    float tileScaleFactor{1.0f};
};

// ============================================================================
// 2. Tile Topography Analysis
// ============================================================================

class TopographyAnalyzer {
public:
    static TileTopography analyze(const ScratchboxMesh& mesh) {
        TileTopography topo;
        if (mesh.vertices.empty()) return topo;

        topo.bounds = mesh.bounds;
        topo.reliefDeltaY = topo.bounds.max.y - topo.bounds.min.y;

        float maxElevation = -1e9f;
        float minElevation = 1e9f;
        Vec3 sumPos(0, 0, 0);

        for (const auto& v : mesh.vertices) {
            sumPos += v.position;
            if (v.position.y > maxElevation) {
                maxElevation = v.position.y;
                topo.apex = v.position;
            }
            if (v.position.y < minElevation) {
                minElevation = v.position.y;
                topo.basin = v.position;
            }
        }

        topo.averageElevation = sumPos.y / static_cast<float>(mesh.vertices.size());

        float spanX = topo.bounds.max.x - topo.bounds.min.x;
        float spanZ = topo.bounds.max.z - topo.bounds.min.z;
        float midX = (topo.bounds.min.x + topo.bounds.max.x) * 0.5f;
        float midZ = (topo.bounds.min.z + topo.bounds.max.z) * 0.5f;

        // 1. Detect focal landmark center: centroid of high-relief / prominent architectural vertices
        float highReliefThreshold = topo.bounds.min.y + topo.reliefDeltaY * 0.40f;
        Vec3 focalSum(0, 0, 0);
        int focalCount = 0;
        AABB landmarkBounds;

        for (const auto& v : mesh.vertices) {
            if (v.position.y >= highReliefThreshold) {
                focalSum += v.position;
                focalCount++;
                landmarkBounds.expand(v.position);
            }
        }

        Vec3 focalCenter = (focalCount > 20) ? (focalSum * (1.0f / static_cast<float>(focalCount))) : Vec3(midX, topo.averageElevation, midZ);
        topo.focalCenter = focalCenter;

        // Center plaza: sample elevation near focal center
        float radiusLimit = 20.0f;
        float centerElevationSum = 0.0f;
        int centerCount = 0;

        for (const auto& v : mesh.vertices) {
            float dx = v.position.x - focalCenter.x;
            float dz = v.position.z - focalCenter.z;
            if (std::sqrt(dx * dx + dz * dz) <= radiusLimit) {
                centerElevationSum += v.position.y;
                centerCount++;
            }
        }

        float plazaY = centerCount > 0 ? centerElevationSum / centerCount : topo.averageElevation;
        topo.centerPlaza = Vec3(focalCenter.x, plazaY, focalCenter.z);

        // Compute 4 bounding perimeter corners with sampled surface elevation
        auto sampleCorner = [&](float targetX, float targetZ) -> Vec3 {
            float closestDist = 1e9f;
            float bestY = topo.bounds.min.y;
            for (const auto& v : mesh.vertices) {
                float dx = v.position.x - targetX;
                float dz = v.position.z - targetZ;
                float d = dx * dx + dz * dz;
                if (d < closestDist) {
                    closestDist = d;
                    bestY = v.position.y;
                }
            }
            return Vec3(targetX, bestY, targetZ);
        };

        // When the tile is a wide metropolitan district (span > 80m), place corners framing the focal landmark
        if (focalCount > 20 && (spanX > 80.0f || spanZ > 80.0f) && (landmarkBounds.min.x <= landmarkBounds.max.x)) {
            float lmHalfW = (landmarkBounds.max.x - landmarkBounds.min.x) * 0.5f + 18.0f;
            float lmHalfD = (landmarkBounds.max.z - landmarkBounds.min.z) * 0.5f + 18.0f;
            topo.corners.push_back(sampleCorner(focalCenter.x - lmHalfW, focalCenter.z - lmHalfD));
            topo.corners.push_back(sampleCorner(focalCenter.x + lmHalfW, focalCenter.z - lmHalfD));
            topo.corners.push_back(sampleCorner(focalCenter.x + lmHalfW, focalCenter.z + lmHalfD));
            topo.corners.push_back(sampleCorner(focalCenter.x - lmHalfW, focalCenter.z + lmHalfD));
            topo.tileScaleFactor = std::clamp(std::max(lmHalfW, lmHalfD) * 2.0f / 36.0f, 1.0f, 4.0f);
        } else {
            float margin = spanX * 0.08f;
            topo.corners.push_back(sampleCorner(topo.bounds.min.x + margin, topo.bounds.min.z + margin));
            topo.corners.push_back(sampleCorner(topo.bounds.max.x - margin, topo.bounds.min.z + margin));
            topo.corners.push_back(sampleCorner(topo.bounds.max.x - margin, topo.bounds.max.z - margin));
            topo.corners.push_back(sampleCorner(topo.bounds.min.x + margin, topo.bounds.max.z - margin));
            topo.tileScaleFactor = std::clamp(std::max(spanX, spanZ) / 36.0f, 1.0f, 6.0f);
        }

        return topo;
    }

    static float getTerrainHeightAt(const ScratchboxMesh& mesh, float x, float z, float defaultY = 0.0f) {
        float closestDistSq = 1e9f;
        float bestY = defaultY;
        for (const auto& v : mesh.vertices) {
            float dx = v.position.x - x;
            float dz = v.position.z - z;
            float d2 = dx * dx + dz * dz;
            if (d2 < closestDistSq) {
                closestDistSq = d2;
                bestY = v.position.y;
                if (closestDistSq < 0.04f) break;
            }
        }
        return bestY;
    }
};

// ============================================================================
// 3. Terraforming Operators
// ============================================================================

class TerraformingEngine {
public:
    static void apply(ScratchboxMesh& mesh, const std::vector<TerraformingOp>& ops, const TileTopography& topo) {
        if (ops.empty() || mesh.vertices.empty()) return;

        for (const auto& op : ops) {
            Vec3 center = op.center;
            if (center.x == 0.0f && center.z == 0.0f && (op.type == "plateau_level" || op.type == "crater_basin")) {
                center = topo.centerPlaza;
            }

            if (op.type == "terrace") {
                applyTerracing(mesh, op, topo);
            } else if (op.type == "plateau_level") {
                applyPlateauLeveling(mesh, op, center, topo);
            } else if (op.type == "crater_basin") {
                applyCraterBasin(mesh, op, center, topo);
            } else if (op.type == "trench_moat") {
                applyTrenchMoat(mesh, op, center, topo);
            } else if (op.type == "ridge_ramp") {
                applyRidgeRamp(mesh, op, center, topo);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

private:
    static void applyTerracing(ScratchboxMesh& mesh, const TerraformingOp& op, const TileTopography& topo) {
        float minY = topo.bounds.min.y;
        float stepH = std::max(0.5f, op.stepHeight * (topo.tileScaleFactor > 2.0f ? 1.6f : 1.0f));
        int steps = std::max(2, op.stepCount);
        float totalH = stepH * steps;

        for (auto& v : mesh.vertices) {
            float normalized = (v.position.y - minY);
            if (normalized < 0.0f || normalized > totalH * 1.5f) continue;

            float stepIdx = std::floor(normalized / stepH);
            float remainder = normalized - (stepIdx * stepH);
            float frac = remainder / stepH;

            // Architectural terrace profile: steep riser (20%), flat tread (80%)
            float shaped = 0.0f;
            if (frac < 0.80f) {
                shaped = (frac / 0.80f) * 0.15f * stepH; // nearly flat tread
            } else {
                float riserFrac = (frac - 0.80f) / 0.20f;
                shaped = (0.15f + 0.85f * (riserFrac * riserFrac * (3.0f - 2.0f * riserFrac))) * stepH; // smooth hermite riser
            }

            float newY = minY + stepIdx * stepH + shaped;
            v.position.y = std::lerp(v.position.y, newY, 0.85f);
        }
    }

    static void applyPlateauLeveling(ScratchboxMesh& mesh, const TerraformingOp& op, const Vec3& center, const TileTopography& topo) {
        float r = op.radius > 0.0f ? op.radius : (15.0f * topo.tileScaleFactor);
        float blend = op.blendRadius > 0.0f ? op.blendRadius : (4.0f * topo.tileScaleFactor);
        float targetY = op.targetElevation;
        if (targetY == 0.0f && op.center.y != 0.0f) targetY = op.center.y;
        if (targetY == 0.0f) targetY = center.y;

        for (auto& v : mesh.vertices) {
            float dx = v.position.x - center.x;
            float dz = v.position.z - center.z;
            float dist = std::sqrt(dx * dx + dz * dz);

            if (dist < r) {
                float weight = 1.0f;
                if (dist > (r - blend)) {
                    float t = (dist - (r - blend)) / blend;
                    weight = 1.0f - (t * t * (3.0f - 2.0f * t));
                }
                v.position.y = std::lerp(v.position.y, targetY, weight * 0.92f);
            }
        }
    }

    static void applyCraterBasin(ScratchboxMesh& mesh, const TerraformingOp& op, const Vec3& center, const TileTopography& topo) {
        float r = op.radius > 0.0f ? op.radius : (14.0f * topo.tileScaleFactor);
        float depth = op.depth > 0.0f ? op.depth : (4.5f * (topo.tileScaleFactor > 2.0f ? 1.5f : 1.0f));

        for (auto& v : mesh.vertices) {
            float dx = v.position.x - center.x;
            float dz = v.position.z - center.z;
            float dist = std::sqrt(dx * dx + dz * dz);

            if (dist < r) {
                float normDist = dist / r;
                // Cosine depression profile with rim uplift
                float factor = std::cos(normDist * PI * 0.5f);
                float rimUplift = std::sin(normDist * PI) * 0.25f * depth;
                v.position.y -= (factor * depth - rimUplift);
            }
        }
    }

    static void applyTrenchMoat(ScratchboxMesh& mesh, const TerraformingOp& op, const Vec3& center, const TileTopography& topo) {
        float moatRadius = op.radius > 0.0f ? op.radius : (20.0f * topo.tileScaleFactor);
        float moatWidth = 4.5f * topo.tileScaleFactor;
        float depth = op.depth > 0.0f ? op.depth : 4.0f;

        for (auto& v : mesh.vertices) {
            float dx = v.position.x - center.x;
            float dz = v.position.z - center.z;
            float dist = std::sqrt(dx * dx + dz * dz);
            float dMoat = std::abs(dist - moatRadius);

            if (dMoat < moatWidth) {
                float t = dMoat / moatWidth;
                float falloff = 1.0f - (t * t * (3.0f - 2.0f * t));
                v.position.y -= depth * falloff;
            }
        }
    }

    static void applyRidgeRamp(ScratchboxMesh& mesh, const TerraformingOp& op, const Vec3& center, const TileTopography& topo) {
        float rampLength = op.radius > 0.0f ? op.radius : (18.0f * topo.tileScaleFactor);
        float rampWidth = 3.5f * topo.tileScaleFactor;
        float uplift = op.depth > 0.0f ? op.depth : (3.0f * topo.tileScaleFactor);

        for (auto& v : mesh.vertices) {
            float dx = v.position.x - center.x;
            float dz = v.position.z - center.z;
            if (std::abs(dz) < rampLength && std::abs(dx) < rampWidth) {
                float lateralFalloff = 1.0f - std::abs(dx) / rampWidth;
                float longiFalloff = 1.0f - std::abs(dz) / rampLength;
                v.position.y += uplift * lateralFalloff * longiFalloff;
            }
        }
    }
};

// ============================================================================
// 4. Primitive Generation & Foundation-Conformal Grafting
// ============================================================================

class PrimitiveGraftingEngine {
public:
    static ScratchboxMesh createPrimitiveMesh(
        const PrimitiveGraft& graft,
        const ScratchboxMesh& baseTerrain,
        const TileTopography& topo,
        RestructureMaterialMode matMode,
        TileStyle style,
        const Vec3& anchorPos
    ) {
        ScratchboxMesh prim;
        float sf = topo.tileScaleFactor;

        if (graft.type == "obelisk") {
            prim = createObelisk(8.0f * graft.scale.y * sf, 1.4f * graft.scale.x * sf, style);
        } else if (graft.type == "column_colonnade") {
            prim = createColonnade(graft.count > 0 ? graft.count : 8, (graft.radius > 0 ? graft.radius : 6.0f) * graft.scale.x * sf, 6.0f * graft.scale.y * sf, style);
        } else if (graft.type == "dome") {
            prim = createDome((graft.radius > 0 ? graft.radius : 6.0f) * graft.scale.x * sf, 16, style);
        } else if (graft.type == "stepped_pyramid") {
            prim = createSteppedPyramid(14.0f * graft.scale.x * sf, 4, 1.2f * graft.scale.y * sf, style);
        } else if (graft.type == "gothic_portal") {
            prim = createGothicPortal(5.0f * graft.scale.x * sf, 7.5f * graft.scale.y * sf, 1.8f * graft.scale.z * sf, style);
        } else if (graft.type == "pylon_gate") {
            prim = createPylonGate(10.0f * graft.scale.x * sf, 8.0f * graft.scale.y * sf, 2.5f * graft.scale.z * sf, style);
        } else {
            // Default Monument Pylon
            prim = createObelisk(6.0f * graft.scale.y * sf, 1.2f * graft.scale.x * sf, style);
        }

        // Apply rotation around Y
        if (std::abs(graft.rotationYDeg) > 0.01f) {
            float rad = graft.rotationYDeg * (PI / 180.0f);
            float cosA = std::cos(rad);
            float sinA = std::sin(rad);
            for (auto& v : prim.vertices) {
                float rx = cosA * v.position.x - sinA * v.position.z;
                float rz = sinA * v.position.x + cosA * v.position.z;
                v.position.x = rx;
                v.position.z = rz;
            }
        }

        // Translate to anchor position
        float baseY = anchorPos.y;
        for (auto& v : prim.vertices) {
            v.position.x += anchorPos.x;
            v.position.y += baseY;
            v.position.z += anchorPos.z;
        }

        // Foundation-conformal ground adaptation: snap/extend bottom vertices to terrain
        if (graft.adaptToTerrain) {
            float lowestPrimitiveY = baseY;
            for (auto& v : prim.vertices) {
                if (v.position.y <= lowestPrimitiveY + 0.35f) {
                    float groundY = TopographyAnalyzer::getTerrainHeightAt(baseTerrain, v.position.x, v.position.z, baseY);
                    // Extend downward to eliminate floating seams
                    v.position.y = std::min(v.position.y, groundY);
                }
            }
        }

        prim.recomputeSmoothNormals();
        prim.recomputeBounds();
        return prim;
    }

    static void graftAll(
        ScratchboxMesh& mesh,
        const std::vector<PrimitiveGraft>& grafts,
        const TileTopography& topo,
        RestructureMaterialMode matMode,
        TileStyle style
    ) {
        if (grafts.empty()) return;

        for (const auto& graft : grafts) {
            std::vector<Vec3> placementPoints;

            if (graft.anchor == "corners") {
                // Place at 4 perimeter corners
                placementPoints = topo.corners;
            } else if (graft.anchor == "apex") {
                placementPoints.push_back(topo.apex);
            } else if (graft.anchor == "plaza" || graft.anchor == "center") {
                placementPoints.push_back(topo.centerPlaza);
            } else if (graft.anchor == "entrance") {
                // Placed at southern center entrance
                float midX = (topo.bounds.min.x + topo.bounds.max.x) * 0.5f;
                float minZ = topo.bounds.min.z + (topo.bounds.max.z - topo.bounds.min.z) * 0.12f;
                float entranceY = TopographyAnalyzer::getTerrainHeightAt(mesh, midX, minZ, topo.averageElevation);
                placementPoints.push_back(Vec3(midX, entranceY, minZ));
            } else {
                // Custom or explicit position
                Vec3 pos = graft.position;
                if (pos.y == 0.0f) {
                    pos.y = TopographyAnalyzer::getTerrainHeightAt(mesh, pos.x, pos.z, topo.averageElevation);
                }
                placementPoints.push_back(pos);
            }

            for (const auto& point : placementPoints) {
                ScratchboxMesh prim = createPrimitiveMesh(graft, mesh, topo, matMode, style, point);
                mesh.merge(prim);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
    }

private:
    static ScratchboxMesh createObelisk(float height, float baseWidth, TileStyle style) {
        ScratchboxMesh ob("obelisk");
        float halfW = baseWidth * 0.5f;
        float shaftH = height * 0.85f;
        float tipW = baseWidth * 0.28f;
        float halfTipW = tipW * 0.5f;

        Vec4 stoneColor = getStyleStoneColor(style);
        Vec4 capColor = (style == TileStyle::SolarpunkCitadel) ? Vec4(0.95f, 0.82f, 0.25f, 1.0f) : stoneColor; // Gold cap for solarpunk

        // Base to shaft top (4 faces)
        auto addTrapezoid = [&](const Vec3& b0, const Vec3& b1, const Vec3& t1, const Vec3& t0, const Vec3& n, const Vec4& col) {
            uint32_t start = static_cast<uint32_t>(ob.vertices.size());
            ob.addVertex({b0, n, {0, 0}, col});
            ob.addVertex({b1, n, {1, 0}, col});
            ob.addVertex({t1, n, {1, 1}, col});
            ob.addVertex({t0, n, {0, 1}, col});
            ob.addTriangle(start, start + 1, start + 2);
            ob.addTriangle(start, start + 2, start + 3);
        };

        // 4 shaft sides
        Vec3 bSW(-halfW, 0, -halfW), bSE(halfW, 0, -halfW), bNE(halfW, 0, halfW), bNW(-halfW, 0, halfW);
        Vec3 tSW(-halfTipW, shaftH, -halfTipW), tSE(halfTipW, shaftH, -halfTipW);
        Vec3 tNE(halfTipW, shaftH, halfTipW), tNW(-halfTipW, shaftH, halfTipW);

        addTrapezoid(bSW, bSE, tSE, tSW, Vec3(0, 0, -1), stoneColor);
        addTrapezoid(bSE, bNE, tNE, tSE, Vec3(1, 0, 0), stoneColor);
        addTrapezoid(bNE, bNW, tNW, tNE, Vec3(0, 0, 1), stoneColor);
        addTrapezoid(bNW, bSW, tSW, tNW, Vec3(-1, 0, 0), stoneColor);

        // Pyramidion top cap
        Vec3 apexPoint(0, height, 0);
        auto addTri = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& n, const Vec4& col) {
            uint32_t start = static_cast<uint32_t>(ob.vertices.size());
            ob.addVertex({p0, n, {0, 0}, col});
            ob.addVertex({p1, n, {1, 0}, col});
            ob.addVertex({p2, n, {0.5f, 1}, col});
            ob.addTriangle(start, start + 1, start + 2);
        };

        addTri(tSW, tSE, apexPoint, Vec3(0, 0.4f, -1).normalized(), capColor);
        addTri(tSE, tNE, apexPoint, Vec3(1, 0.4f, 0).normalized(), capColor);
        addTri(tNE, tNW, apexPoint, Vec3(0, 0.4f, 1).normalized(), capColor);
        addTri(tNW, tSW, apexPoint, Vec3(-1, 0.4f, 0).normalized(), capColor);

        return ob;
    }

    static ScratchboxMesh createColonnade(int count, float radius, float colHeight, TileStyle style) {
        ScratchboxMesh colonnade("colonnade");
        float colR = 0.40f;
        Vec4 stoneColor = getStyleStoneColor(style);

        for (int i = 0; i < count; ++i) {
            float angle = (static_cast<float>(i) / count) * TWO_PI;
            float px = std::cos(angle) * radius;
            float pz = std::sin(angle) * radius;

            // Create single fluted column
            ScratchboxMesh col = ScratchboxMesh::createCylinder(colR * 0.85f, colR, colHeight, 16, stoneColor);
            for (auto& v : col.vertices) {
                v.position.x += px;
                v.position.y += colHeight * 0.5f;
                v.position.z += pz;
            }
            colonnade.merge(col);
        }

        // Continuous circular entablature architrave on top
        int ringSegs = count * 4;
        float ringThick = 0.5f;
        float ringH = 0.45f;
        for (int j = 0; j < ringSegs; ++j) {
            float a0 = (static_cast<float>(j) / ringSegs) * TWO_PI;
            float a1 = (static_cast<float>(j + 1) / ringSegs) * TWO_PI;
            float rInner = radius - ringThick * 0.5f;
            float rOuter = radius + ringThick * 0.5f;

            Vec3 i0(std::cos(a0) * rInner, colHeight, std::sin(a0) * rInner);
            Vec3 o0(std::cos(a0) * rOuter, colHeight, std::sin(a0) * rOuter);
            Vec3 i1(std::cos(a1) * rInner, colHeight, std::sin(a1) * rInner);
            Vec3 o1(std::cos(a1) * rOuter, colHeight, std::sin(a1) * rOuter);

            Vec3 i0Top(i0.x, colHeight + ringH, i0.z);
            Vec3 o0Top(o0.x, colHeight + ringH, o0.z);
            Vec3 i1Top(i1.x, colHeight + ringH, i1.z);
            Vec3 o1Top(o1.x, colHeight + ringH, o1.z);

            uint32_t baseIdx = static_cast<uint32_t>(colonnade.vertices.size());
            colonnade.addVertex({o0Top, {0, 1, 0}, {0, 0}, stoneColor});
            colonnade.addVertex({o1Top, {0, 1, 0}, {1, 0}, stoneColor});
            colonnade.addVertex({i1Top, {0, 1, 0}, {1, 1}, stoneColor});
            colonnade.addVertex({i0Top, {0, 1, 0}, {0, 1}, stoneColor});
            colonnade.addTriangle(baseIdx, baseIdx + 1, baseIdx + 2);
            colonnade.addTriangle(baseIdx, baseIdx + 2, baseIdx + 3);
        }

        return colonnade;
    }

    static ScratchboxMesh createDome(float radius, int sectors, TileStyle style) {
        ScratchboxMesh dome("dome");
        int rings = sectors / 2;
        Vec4 color = (style == TileStyle::SolarpunkCitadel) ? Vec4(0.35f, 0.75f, 0.90f, 0.85f) : getStyleStoneColor(style);

        for (int r = 0; r <= rings; ++r) {
            float phi = (static_cast<float>(r) / rings) * HALF_PI; // hemisphere
            float y = std::sin(phi) * radius;
            float cosPhi = std::cos(phi);

            for (int s = 0; s <= sectors; ++s) {
                float theta = (static_cast<float>(s) / sectors) * TWO_PI;
                float x = std::cos(theta) * cosPhi * radius;
                float z = std::sin(theta) * cosPhi * radius;

                Vec3 norm(x, y, z);
                norm = norm.normalized();
                dome.addVertex({Vec3(x, y, z), norm, {static_cast<float>(s)/sectors, static_cast<float>(r)/rings}, color});
            }
        }

        for (int r = 0; r < rings; ++r) {
            for (int s = 0; s < sectors; ++s) {
                uint32_t i0 = r * (sectors + 1) + s;
                uint32_t i1 = (r + 1) * (sectors + 1) + s;
                uint32_t i2 = (r + 1) * (sectors + 1) + (s + 1);
                uint32_t i3 = r * (sectors + 1) + (s + 1);

                dome.addTriangle(i0, i1, i2);
                dome.addTriangle(i0, i2, i3);
            }
        }

        return dome;
    }

    static ScratchboxMesh createSteppedPyramid(float baseSize, int tiers, float tierHeight, TileStyle style) {
        ScratchboxMesh pyr("stepped_pyramid");
        Vec4 stoneColor = getStyleStoneColor(style);
        float sizeStep = (baseSize * 0.65f) / tiers;

        for (int t = 0; t < tiers; ++t) {
            float tierSize = baseSize - t * sizeStep;
            float currentY = t * tierHeight;
            ScratchboxMesh box = ScratchboxMesh::createBox(Vec3(tierSize, tierHeight, tierSize), stoneColor);
            for (auto& v : box.vertices) {
                v.position.y += currentY + tierHeight * 0.5f;
            }
            pyr.merge(box);
        }

        return pyr;
    }

    static ScratchboxMesh createGothicPortal(float width, float height, float depth, TileStyle style) {
        ScratchboxMesh portal("gothic_portal");
        Vec4 stoneColor = getStyleStoneColor(style);
        float pierW = width * 0.22f;

        // Left jamb pier
        ScratchboxMesh leftPier = ScratchboxMesh::createBox(Vec3(pierW, height, depth), stoneColor);
        for (auto& v : leftPier.vertices) {
            v.position.x -= (width * 0.5f - pierW * 0.5f);
            v.position.y += height * 0.5f;
        }
        portal.merge(leftPier);

        // Right jamb pier
        ScratchboxMesh rightPier = ScratchboxMesh::createBox(Vec3(pierW, height, depth), stoneColor);
        for (auto& v : rightPier.vertices) {
            v.position.x += (width * 0.5f - pierW * 0.5f);
            v.position.y += height * 0.5f;
        }
        portal.merge(rightPier);

        // Pointed arch lintel (spanned across piers)
        float archH = height * 0.35f;
        ScratchboxMesh archLintel = ScratchboxMesh::createBox(Vec3(width, archH, depth * 1.1f), stoneColor);
        for (auto& v : archLintel.vertices) {
            v.position.y += (height + archH * 0.5f);
        }
        portal.merge(archLintel);

        return portal;
    }

    static ScratchboxMesh createPylonGate(float width, float height, float depth, TileStyle style) {
        ScratchboxMesh gate("pylon_gate");
        Vec4 stoneColor = getStyleStoneColor(style);
        float pylonW = width * 0.32f;

        // Left pylon (tapered)
        ScratchboxMesh leftPylon = ScratchboxMesh::createBox(Vec3(pylonW, height, depth), stoneColor);
        for (auto& v : leftPylon.vertices) {
            v.position.x -= (width * 0.5f - pylonW * 0.5f);
            v.position.y += height * 0.5f;
            if (v.position.y > height * 0.6f) {
                v.position.x *= 0.88f; // subtle brutalist inward batter
            }
        }
        gate.merge(leftPylon);

        // Right pylon (tapered)
        ScratchboxMesh rightPylon = ScratchboxMesh::createBox(Vec3(pylonW, height, depth), stoneColor);
        for (auto& v : rightPylon.vertices) {
            v.position.x += (width * 0.5f - pylonW * 0.5f);
            v.position.y += height * 0.5f;
            if (v.position.y > height * 0.6f) {
                v.position.x *= 0.88f;
            }
        }
        gate.merge(rightPylon);

        // Massive bridging lintel
        float lintelH = height * 0.22f;
        ScratchboxMesh bridge = ScratchboxMesh::createBox(Vec3(width * 1.05f, lintelH, depth * 1.15f), stoneColor);
        for (auto& v : bridge.vertices) {
            v.position.y += (height - lintelH * 0.5f);
        }
        gate.merge(bridge);

        return gate;
    }

    static Vec4 getStyleStoneColor(TileStyle style) {
        switch (style) {
            case TileStyle::SolarpunkCitadel:
                return Vec4(0.88f, 0.86f, 0.82f, 1.0f); // Clean sun-bleached travertine limestone
            case TileStyle::NeoclassicalMonument:
                return Vec4(0.92f, 0.90f, 0.86f, 1.0f); // Imperial marble
            case TileStyle::BrutalistFortress:
                return Vec4(0.55f, 0.56f, 0.58f, 1.0f); // Formwork exposed concrete
            case TileStyle::GothicCathedral:
                return Vec4(0.48f, 0.49f, 0.52f, 1.0f); // Weathered ashlar slate
            case TileStyle::SciFiOutpost:
                return Vec4(0.72f, 0.74f, 0.78f, 1.0f); // Matte titanium alloy
            case TileStyle::Custom:
            default:
                return Vec4(0.82f, 0.82f, 0.85f, 1.0f);
        }
    }
};

// ============================================================================
// 5. Material & Surface Styling Engine
// ============================================================================

class MaterialStylingEngine {
public:
    static void apply(ScratchboxMesh& mesh, const TileRestructureConfig& config, const TileTopography& topo) {
        if (config.materialMode == RestructureMaterialMode::StudioClay) {
            applyStudioClay(mesh, config.clayPreset);
        } else if (config.materialMode == RestructureMaterialMode::StylizedPbr) {
            applyStylizedPbr(mesh, config.style);
        } else {
            // Hybrid photogrammetric: keep existing textures where untouched
            applyHybrid(mesh, config.style);
        }

        if (config.computeCurvature) {
            mesh.computeCurvatureAO(0.82f);
        }
    }

private:
    static void applyStudioClay(ScratchboxMesh& mesh, const std::string& presetName) {
        std::string lower = presetName;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

        tiles::ClayPreset preset = tiles::ClayPreset::ARCHITECTURAL_WHITE;
        if (lower.find("sandstone") != std::string::npos) preset = tiles::ClayPreset::SANDSTONE;
        else if (lower.find("terracotta") != std::string::npos) preset = tiles::ClayPreset::WARM_TERRACOTTA;
        else if (lower.find("concrete") != std::string::npos || lower.find("brutalist") != std::string::npos) preset = tiles::ClayPreset::CONCRETE_BRUTALIST;
        else if (lower.find("slate") != std::string::npos) preset = tiles::ClayPreset::SLATE_GREY;

        mesh.material = tiles::getClayMaterial(preset);

        Vec4 clayColor = mesh.material.baseColorFactor;
        for (auto& v : mesh.vertices) {
            v.color = clayColor;
        }
    }

    static void applyStylizedPbr(ScratchboxMesh& mesh, TileStyle style) {
        mesh.material = PbrMaterial::stoneLimestone();

        if (style == TileStyle::SolarpunkCitadel) {
            mesh.material.name = "Solarpunk_Travertine";
            mesh.material.baseColorFactor = Vec4(0.88f, 0.86f, 0.80f, 1.0f);
            mesh.material.roughnessFactor = 0.68f;
            mesh.material.metallicFactor = 0.08f;
        } else if (style == TileStyle::NeoclassicalMonument) {
            mesh.material.name = "Neoclassical_Marble";
            mesh.material.baseColorFactor = Vec4(0.92f, 0.91f, 0.88f, 1.0f);
            mesh.material.roughnessFactor = 0.45f;
            mesh.material.metallicFactor = 0.04f;
        } else if (style == TileStyle::BrutalistFortress) {
            mesh.material.name = "Brutalist_Concrete";
            mesh.material.baseColorFactor = Vec4(0.58f, 0.60f, 0.62f, 1.0f);
            mesh.material.roughnessFactor = 0.88f;
            mesh.material.metallicFactor = 0.05f;
        } else if (style == TileStyle::GothicCathedral) {
            mesh.material.name = "Gothic_DarkAshlar";
            mesh.material.baseColorFactor = Vec4(0.45f, 0.46f, 0.48f, 1.0f);
            mesh.material.roughnessFactor = 0.78f;
            mesh.material.metallicFactor = 0.12f;
        } else if (style == TileStyle::SciFiOutpost) {
            mesh.material.name = "SciFi_TitaniumComposite";
            mesh.material.baseColorFactor = Vec4(0.72f, 0.75f, 0.80f, 1.0f);
            mesh.material.roughnessFactor = 0.35f;
            mesh.material.metallicFactor = 0.65f;
        }

        // Color coding by slope & elevation for rich procedural realism
        for (auto& v : mesh.vertices) {
            float slope = 1.0f - std::max(0.0f, v.normal.y);
            Vec4 baseCol = mesh.material.baseColorFactor;
            if (slope > 0.45f) {
                // Steep rock face/crevice
                v.color = Vec4(baseCol.x * 0.75f, baseCol.y * 0.75f, baseCol.z * 0.78f, 1.0f);
            } else {
                v.color = baseCol;
            }
        }
    }

    static void applyHybrid(ScratchboxMesh& mesh, TileStyle style) {
        mesh.material.roughnessFactor = 0.72f;
        mesh.material.metallicFactor = 0.05f;
    }
};

// ============================================================================
// 6. Synthetic Benchmark Tile Generators (for Headless Testing & Demos)
// ============================================================================

class BenchmarkTileBuilder {
public:
    static ScratchboxMesh createHillsideMonumentBenchmark(float width = 36.0f, float depth = 36.0f, int res = 32) {
        ScratchboxMesh mesh("HillsideMonumentTile");
        mesh.material = PbrMaterial::stoneLimestone();

        float dx = width / static_cast<float>(res - 1);
        float dz = depth / static_cast<float>(res - 1);
        float halfW = width * 0.5f;
        float halfD = depth * 0.5f;

        for (int z = 0; z < res; ++z) {
            float wz = -halfD + z * dz;
            for (int x = 0; x < res; ++x) {
                float wx = -halfW + x * dx;
                float u = static_cast<float>(x) / (res - 1);
                float v = static_cast<float>(z) / (res - 1);

                // Natural sloped hillside with crest and amphitheater depression
                float hillSlope = (wz + halfD) * 0.35f;
                float crest = 4.0f * std::exp(-((wx * wx + wz * wz) / 120.0f));
                float noise = 0.8f * std::sin(wx * 0.3f) * std::cos(wz * 0.3f);
                float elevation = hillSlope + crest + noise;

                Vec3 pos(wx, elevation, wz);
                Vec3 norm(0, 1, 0); // recomputed later
                mesh.addVertex({pos, norm, {u, v}, Vec4(0.82f, 0.80f, 0.76f, 1.0f)});
            }
        }

        int rowStride = res;
        for (int z = 0; z < res - 1; ++z) {
            for (int x = 0; x < res - 1; ++x) {
                uint32_t i0 = z * rowStride + x;
                uint32_t i1 = z * rowStride + (x + 1);
                uint32_t i2 = (z + 1) * rowStride + (x + 1);
                uint32_t i3 = (z + 1) * rowStride + x;

                mesh.indices.push_back(i0);
                mesh.indices.push_back(i3);
                mesh.indices.push_back(i2);
                mesh.indices.push_back(i0);
                mesh.indices.push_back(i2);
                mesh.indices.push_back(i1);
            }
        }

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }

    static ScratchboxMesh createCityDistrictBenchmark(float width = 40.0f, float depth = 40.0f) {
        ScratchboxMesh mesh = createHillsideMonumentBenchmark(width, depth, 24);
        mesh.name = "CityDistrictTile";

        // Add 2 massing blocks simulating existing photogrammetric buildings
        ScratchboxMesh b1 = ScratchboxMesh::createBox(Vec3(8, 14, 8), Vec4(0.72f, 0.74f, 0.76f, 1.0f));
        for (auto& v : b1.vertices) {
            v.position.x -= 8.0f;
            v.position.y += 7.0f;
            v.position.z -= 6.0f;
        }
        mesh.merge(b1);

        ScratchboxMesh b2 = ScratchboxMesh::createBox(Vec3(10, 18, 10), Vec4(0.70f, 0.72f, 0.75f, 1.0f));
        for (auto& v : b2.vertices) {
            v.position.x += 7.0f;
            v.position.y += 9.0f;
            v.position.z += 8.0f;
        }
        mesh.merge(b2);

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

// ============================================================================
// 7. Full Tile Restructuring Facade
// ============================================================================

class TileRestructurePipeline {
public:
    static ScratchboxMesh execute(ScratchboxMesh mesh, const TileRestructureConfig& config) {
        // Step 1: Topography analysis
        TileTopography topo = TopographyAnalyzer::analyze(mesh);

        // Step 2: Terraforming
        TerraformingEngine::apply(mesh, config.terraforming, topo);

        // Re-analyze topography after terraforming
        topo = TopographyAnalyzer::analyze(mesh);

        // Step 3: Primitive grafting
        PrimitiveGraftingEngine::graftAll(mesh, config.primitives, topo, config.materialMode, config.style);

        // Step 4: Material & Surface Styling
        MaterialStylingEngine::apply(mesh, config, topo);

        mesh.recomputeSmoothNormals();
        mesh.recomputeBounds();
        return mesh;
    }
};

} // namespace restructurer
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_RESTRUCTURER_HPP
