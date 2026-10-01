/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_MATERIAL_HPP
#define SCRATCHBOX_MATERIAL_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_texture.hpp"

#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <unordered_map>
#include <numeric>
#include <string>

namespace scratchbox {
namespace material {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using texture::ImageBuffer;

// ============================================================================
// 1. MATERIAL ENUM & PER-FACE STRUCTURES
// ============================================================================

enum class MaterialClassId : uint8_t {
    UNCLASSIFIED = 0,
    FOLIAGE = 1,
    WATER = 2,
    ROAD = 3,
    BUILDING_FACADE = 4,
    BUILDING_ROOF = 5,
    PAVEMENT_GROUND = 6
};

inline const char* getMaterialClassName(MaterialClassId id) {
    switch (id) {
        case MaterialClassId::FOLIAGE: return "Foliage";
        case MaterialClassId::WATER: return "Water";
        case MaterialClassId::ROAD: return "Road";
        case MaterialClassId::BUILDING_FACADE: return "BuildingFacade";
        case MaterialClassId::BUILDING_ROOF: return "BuildingRoof";
        case MaterialClassId::PAVEMENT_GROUND: return "PavementGround";
        default: return "Unclassified";
    }
}

struct PerFaceSignals {
    Vec3 normal{0.0f, 1.0f, 0.0f};
    Vec3 centroid{0.0f, 0.0f, 0.0f};
    float heightAboveGround{0.0f};
    float planarityVariance{0.0f}; // Normal variance of adjacent faces (0 = flat, >0.1 = chaotic foliage)
    Vec3 meanColor{0.5f, 0.5f, 0.5f};
    float luminance{0.5f};
    float saturation{0.0f};
    float excessGreen{0.0f};      // 2*G - R - B
    float waterIndex{0.0f};       // B - max(R, G)
    bool insideBuildingFootprint{false};
    bool insideRoadCorridor{false};
    bool insideWaterBoundary{false};
};

struct PerFacePbrMaterial {
    MaterialClassId classId{MaterialClassId::UNCLASSIFIED};
    float roughness{0.80f};
    float metalness{0.00f};
    float specular{0.50f};
    Vec3 albedoTint{1.0f, 1.0f, 1.0f};
};

struct MapVectorPolygons {
    std::vector<std::vector<Vec2>> buildingFootprints;
    std::vector<std::vector<Vec2>> roadCorridors;
    std::vector<std::vector<Vec2>> waterBoundaries;
};

// ============================================================================
// 2. 2D GEOMETRY UTILITIES (JORDAN CURVE POINT-IN-POLYGON)
// ============================================================================

inline bool isPointInPolygon2D(const Vec2& pt, const std::vector<Vec2>& poly) {
    if (poly.size() < 3) return false;
    bool inside = false;
    size_t n = poly.size();
    for (size_t i = 0, j = n - 1; i < n; j = i++) {
        const Vec2& pi = poly[i];
        const Vec2& pj = poly[j];

        if (((pi.y > pt.y) != (pj.y > pt.y)) &&
            (pt.x < (pj.x - pi.x) * (pt.y - pi.y) / ((pj.y - pi.y) + 1e-7f) + pi.x)) {
            inside = !inside;
        }
    }
    return inside;
}

// ============================================================================
// 3. PER-FACE MULTI-SIGNAL EXTRACTOR
// ============================================================================

class PerFaceSignalExtractor {
public:
    static std::vector<PerFaceSignals> extractSignals(
        const ScratchboxMesh& mesh,
        const ImageBuffer& texture = ImageBuffer(),
        const MapVectorPolygons& mapData = {}
    ) {
        std::vector<PerFaceSignals> signals;
        if (mesh.vertices.empty() || mesh.indices.empty()) return signals;

        size_t triCount = mesh.indices.size() / 3;
        signals.resize(triCount);

        // 1. Compute face normals, centroids, and UV centroids
        std::vector<Vec3> faceNormals(triCount);
        std::vector<Vec3> faceCentroids(triCount);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            Vec3 e1 = v1.position - v0.position;
            Vec3 e2 = v2.position - v0.position;
            Vec3 fn = e1.cross(e2);
            float len = fn.length();
            Vec3 n = (len > 1e-6f) ? (fn * (1.0f / len)) : Vec3(0, 1, 0);
            Vec3 vn = v0.normal + v1.normal + v2.normal;
            if (vn.lengthSquared() > 1e-4f && n.dot(vn) < 0.0f) {
                n = n * -1.0f;
            }
            faceNormals[t] = n;
            faceCentroids[t] = (v0.position + v1.position + v2.position) * (1.0f / 3.0f);
        }

        // 2. Determine ground elevation datum (5th percentile of horizontal vertices)
        std::vector<float> horizontalElevations;
        horizontalElevations.reserve(triCount);
        for (size_t t = 0; t < triCount; ++t) {
            if (faceNormals[t].y > 0.70f) {
                horizontalElevations.push_back(faceCentroids[t].y);
            }
        }

        float groundDatum = 0.0f;
        if (!horizontalElevations.empty()) {
            std::sort(horizontalElevations.begin(), horizontalElevations.end());
            size_t p5Idx = static_cast<size_t>(horizontalElevations.size() * 0.05f);
            groundDatum = horizontalElevations[p5Idx];
        }

        // 3. Build vertex-to-face adjacency for planarity variance computation
        std::unordered_map<uint32_t, std::vector<uint32_t>> vertexToFaces;
        vertexToFaces.reserve(mesh.vertices.size());
        for (size_t t = 0; t < triCount; ++t) {
            vertexToFaces[mesh.indices[t * 3]].push_back(static_cast<uint32_t>(t));
            vertexToFaces[mesh.indices[t * 3 + 1]].push_back(static_cast<uint32_t>(t));
            vertexToFaces[mesh.indices[t * 3 + 2]].push_back(static_cast<uint32_t>(t));
        }

        // 4. Extract per-face signals
        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            const auto& v0 = mesh.vertices[i0];
            const auto& v1 = mesh.vertices[i1];
            const auto& v2 = mesh.vertices[i2];

            PerFaceSignals& sig = signals[t];
            sig.normal = faceNormals[t];
            sig.centroid = faceCentroids[t];
            sig.heightAboveGround = sig.centroid.y - groundDatum;

            // Compute planarity / normal variance with neighboring faces
            Vec3 avgNormal = sig.normal;
            int neighborCount = 1;

            auto accumulateNeighbors = [&](uint32_t vertIdx) {
                auto it = vertexToFaces.find(vertIdx);
                if (it != vertexToFaces.end()) {
                    for (uint32_t neighborTri : it->second) {
                        if (neighborTri != t) {
                            avgNormal = avgNormal + faceNormals[neighborTri];
                            neighborCount++;
                        }
                    }
                }
            };
            accumulateNeighbors(i0);
            accumulateNeighbors(i1);
            accumulateNeighbors(i2);

            avgNormal = avgNormal * (1.0f / neighborCount);
            float avgLen = avgNormal.length();
            sig.planarityVariance = std::clamp(1.0f - avgLen, 0.0f, 1.0f);

            // Sample radiometric color statistics from texture or vertex colors
            Vec3 rgb(0.5f, 0.5f, 0.5f);
            if (!texture.empty()) {
                Vec2 uvCentroid = (v0.uv + v1.uv + v2.uv) * (1.0f / 3.0f);
                rgb = texture.sampleBilinear(uvCentroid.x, uvCentroid.y);
            } else {
                // Use vertex colors
                rgb = (Vec3(v0.color.x, v0.color.y, v0.color.z) +
                       Vec3(v1.color.x, v1.color.y, v1.color.z) +
                       Vec3(v2.color.x, v2.color.y, v2.color.z)) * (1.0f / 3.0f);
            }

            sig.meanColor = rgb;
            sig.luminance = 0.2126f * rgb.x + 0.7152f * rgb.y + 0.0722f * rgb.z;

            float maxC = std::max({rgb.x, rgb.y, rgb.z});
            float minC = std::min({rgb.x, rgb.y, rgb.z});
            sig.saturation = (maxC > 1e-4f) ? ((maxC - minC) / maxC) : 0.0f;

            // Normalized Excess Green Index: 2*G - R - B
            sig.excessGreen = 2.0f * rgb.y - rgb.x - rgb.z;

            // Water Index: Blue dominance over Red and Green
            sig.waterIndex = rgb.z - std::max(rgb.x, rgb.y);

            // Vector map 2D polygon checks (XZ coordinates)
            Vec2 xz(sig.centroid.x, sig.centroid.z);

            for (const auto& poly : mapData.buildingFootprints) {
                if (isPointInPolygon2D(xz, poly)) {
                    sig.insideBuildingFootprint = true;
                    break;
                }
            }
            for (const auto& poly : mapData.roadCorridors) {
                if (isPointInPolygon2D(xz, poly)) {
                    sig.insideRoadCorridor = true;
                    break;
                }
            }
            for (const auto& poly : mapData.waterBoundaries) {
                if (isPointInPolygon2D(xz, poly)) {
                    sig.insideWaterBoundary = true;
                    break;
                }
            }
        }

        return signals;
    }
};

// ============================================================================
// 4. PER-FACE MATERIAL CLASSIFIER & PBR ASSIGNER
// ============================================================================

class PerFaceMaterialClassifier {
public:
    /**
     * Deterministic multi-signal classification replacing simple color guessing.
     * Combines face normal, height above ground, planarity, radiometric statistics,
     * and vector map outlines, outputting continuous physical PBR properties.
     */
    static std::vector<PerFacePbrMaterial> classifyAndAssignPbr(
        const std::vector<PerFaceSignals>& signals
    ) {
        std::vector<PerFacePbrMaterial> materials;
        materials.resize(signals.size());

        for (size_t i = 0; i < signals.size(); ++i) {
            const PerFaceSignals& sig = signals[i];
            PerFacePbrMaterial& mat = materials[i];

            bool isHorizontalUp = (sig.normal.y >= 0.70f);
            bool isVertical = (std::abs(sig.normal.y) <= 0.35f);
            bool isSloped = (sig.normal.y > 0.35f && sig.normal.y < 0.70f);
            bool isSoffit = (sig.normal.y <= -0.30f);

            // 1. Water Classification
            if ((sig.insideWaterBoundary || (sig.waterIndex > 0.05f && sig.luminance < 0.30f && sig.meanColor.z > sig.meanColor.x * 1.3f)) &&
                isHorizontalUp && sig.heightAboveGround <= 0.8f && sig.planarityVariance <= 0.02f) {
                mat.classId = MaterialClassId::WATER;
                mat.roughness = std::clamp(0.04f + 0.5f * sig.planarityVariance, 0.04f, 0.08f);
                mat.metalness = 0.02f;
                mat.specular = 0.25f; // Water n=1.33, F0=0.02
                continue;
            }

            // 2. Foliage Classification (trees, bushes, hedges)
            // Organic chaotic geometry (high normal variance) + botanical green signature
            float greenRatio = sig.meanColor.y / std::max({sig.meanColor.x, sig.meanColor.z, 0.01f});
            if ((sig.planarityVariance > 0.08f || !sig.insideBuildingFootprint) &&
                (sig.excessGreen > 0.06f || (greenRatio > 1.12f && sig.meanColor.y > 0.12f && sig.meanColor.x < 0.55f)) &&
                !isSoffit) {
                mat.classId = MaterialClassId::FOLIAGE;
                mat.roughness = std::clamp(0.85f + 1.2f * sig.planarityVariance, 0.88f, 0.98f);
                mat.metalness = 0.00f; // Dielectric cuticle
                mat.specular = 0.40f;
                continue;
            }

            // 3. Road / Asphalt Classification
            // Low height, horizontal, high planarity, low saturation, dark/medium luminance
            if (isHorizontalUp && sig.heightAboveGround <= 1.5f && sig.planarityVariance <= 0.04f &&
                (sig.insideRoadCorridor || (sig.saturation <= 0.18f && sig.luminance >= 0.06f && sig.luminance <= 0.45f))) {
                mat.classId = MaterialClassId::ROAD;
                // Physical measured asphalt roughness
                mat.roughness = std::clamp(0.70f + 3.0f * sig.planarityVariance, 0.72f, 0.88f);
                mat.metalness = 0.00f;
                mat.specular = 0.45f;
                continue;
            }

            // 4. Building Roof Classification
            // High elevation, horizontal or sloped, enclosed within building footprint or high above ground
            if ((isHorizontalUp || isSloped) && sig.heightAboveGround > 3.0f &&
                (sig.insideBuildingFootprint || sig.planarityVariance <= 0.05f)) {
                mat.classId = MaterialClassId::BUILDING_ROOF;
                mat.roughness = std::clamp(0.65f + 2.0f * sig.planarityVariance, 0.65f, 0.85f);
                mat.metalness = (sig.insideBuildingFootprint && sig.luminance > 0.65f && sig.saturation < 0.08f) ? 0.60f : 0.00f;
                mat.specular = 0.50f;
                continue;
            }

            // 5. Building Facade Classification
            // Vertical wall surfaces, elevated, masonry/stone/concrete/glass
            if (isVertical && (sig.insideBuildingFootprint || sig.heightAboveGround > 1.2f || sig.planarityVariance <= 0.08f)) {
                mat.classId = MaterialClassId::BUILDING_FACADE;
                mat.roughness = std::clamp(0.75f + 1.5f * sig.planarityVariance, 0.75f, 0.92f);
                // Modern glass/metal panel detection
                bool isGlassOrMetal = (sig.luminance > 0.75f && sig.saturation < 0.10f && sig.planarityVariance < 0.015f);
                mat.metalness = isGlassOrMetal ? 0.85f : 0.00f;
                mat.specular = isGlassOrMetal ? 0.65f : 0.50f;
                continue;
            }

            // 6. Pavement Ground Classification
            if (isHorizontalUp && sig.heightAboveGround <= 1.8f) {
                mat.classId = MaterialClassId::PAVEMENT_GROUND;
                mat.roughness = std::clamp(0.78f + 1.5f * sig.planarityVariance, 0.75f, 0.90f);
                mat.metalness = 0.00f;
                mat.specular = 0.48f;
                continue;
            }

            // Fallback: Default architectural stone
            mat.classId = MaterialClassId::UNCLASSIFIED;
            mat.roughness = std::clamp(0.80f + 1.5f * sig.planarityVariance, 0.70f, 0.95f);
            mat.metalness = 0.00f;
            mat.specular = 0.50f;
        }

        return materials;
    }
};

} // namespace material
} // namespace scratchbox

#endif // SCRATCHBOX_MATERIAL_HPP
