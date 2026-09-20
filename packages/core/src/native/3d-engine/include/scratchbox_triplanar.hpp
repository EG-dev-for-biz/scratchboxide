/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_TRIPLANAR_HPP
#define SCRATCHBOX_TRIPLANAR_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <cmath>
#include <algorithm>
#include <vector>

namespace scratchbox {
namespace triplanar {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::FastNoise3D;

enum class TriplanarMaterialType {
    WOOD_OAK,
    ROCK_STRATA,
    CONCRETE_WEATHERED,
    RUST_PATINA,
    MOSS_OVERGROWTH
};

struct TriplanarSample {
    Vec3 albedo{0.8f, 0.8f, 0.8f};
    float metallic{0.0f};
    float roughness{0.5f};
    Vec3 normalPerturbation{0.0f, 0.0f, 0.0f};
    float ao{1.0f};
};

/**
 * Computes seamless triplanar blending weights from a surface normal.
 * Sharpness k in [4.0, 8.0] ensures clean transitions without visible projection seams.
 */
inline Vec3 computeTriplanarWeights(const Vec3& normal, float sharpness = 4.0f) {
    Vec3 n = normal.normalized();
    float wx = std::pow(std::abs(n.x), sharpness);
    float wy = std::pow(std::abs(n.y), sharpness);
    float wz = std::pow(std::abs(n.z), sharpness);
    float sum = wx + wy + wz;
    if (sum < 1e-6f) return {0.3333f, 0.3333f, 0.3334f};
    return {wx / sum, wy / sum, wz / sum};
}

/**
 * Reoriented Normal Mapping (RNM) for physically accurate tangent normal blending.
 */
inline Vec3 blendReorientedNormals(const Vec3& n1, const Vec3& n2) {
    Vec3 t = {n1.x, n1.y, n1.z + 1.0f};
    Vec3 u = {-n2.x, -n2.y, n2.z};
    return (t * (t.dot(u)) - u * t.z).normalized();
}

/**
 * Procedural Natural Wood Grain with concentric tree growth rings and fiber micro-waviness.
 */
inline TriplanarSample sampleProceduralWood(const Vec3& p, const Vec3& normal, float scale = 2.0f) {
    Vec3 wp = p * scale;
    Vec3 weights = computeTriplanarWeights(normal, 4.0f);

    // Side projection (longitudinal bark and wood fibers)
    auto evalSide = [](float horiz, float vert, float depth) {
        float waviness = FastNoise3D::fbm(horiz * 2.0f, vert * 0.4f, depth * 0.5f, 3, 2.0f, 0.5f, 101);
        float barkRidge = FastNoise3D::fbm((horiz + waviness * 0.25f) * 8.0f, vert * 1.5f, depth, 4, 2.0f, 0.5f, 202);
        float fineFiber = FastNoise3D::perlin(horiz * 25.0f, vert * 6.0f, depth * 2.0f, 303);

        float grain = barkRidge * 0.7f + fineFiber * 0.3f;
        Vec3 darkBark = {0.18f, 0.12f, 0.08f};    // Dark weathered oak
        Vec3 warmHeart = {0.36f, 0.25f, 0.15f};   // Warm amber wood
        Vec3 col = math::lerp(darkBark, warmHeart, std::clamp(grain, 0.0f, 1.0f));
        float rough = math::lerp(0.85f, 0.95f, grain);
        return std::make_pair(col, rough);
    };

    // End-grain projection (concentric growth rings)
    auto evalEnd = [](float u, float v, float depth) {
        float r = std::sqrt(u * u + v * v);
        float wobble = FastNoise3D::fbm(u * 2.0f, v * 2.0f, depth * 0.2f, 3, 2.0f, 0.5f, 101);
        float ringCoord = (r + wobble * 0.12f) * 16.0f;
        float ringFract = ringCoord - std::floor(ringCoord);
        float ringStripe = math::smoothstep(0.05f, 0.45f, ringFract) * (1.0f - math::smoothstep(0.55f, 0.95f, ringFract));

        Vec3 lateWoodColor = {0.24f, 0.15f, 0.09f};
        Vec3 earlyWoodColor = {0.46f, 0.32f, 0.20f};
        Vec3 col = math::lerp(earlyWoodColor, lateWoodColor, ringStripe);
        return std::make_pair(col, 0.75f);
    };

    auto [colX, roughX] = evalSide(wp.z, wp.y, wp.x);
    auto [colY, roughY] = evalEnd(wp.x, wp.z, wp.y);
    auto [colZ, roughZ] = evalSide(wp.x, wp.y, wp.z);

    TriplanarSample s;
    s.albedo = colX * weights.x + colY * weights.y + colZ * weights.z;
    s.roughness = roughX * weights.x + roughY * weights.y + roughZ * weights.z;
    s.metallic = 0.0f;
    s.ao = 1.0f;
    return s;
}

/**
 * Procedural Sedimentary Rock Strata with shale cracks and mineral deposits.
 */
inline TriplanarSample sampleProceduralRock(const Vec3& p, const Vec3& normal, float scale = 1.5f) {
    Vec3 wp = p * scale;
    Vec3 weights = computeTriplanarWeights(normal, 5.0f);

    // Geological horizontal bedding planes
    float strataNoise = FastNoise3D::fbm(wp.x * 0.4f, wp.y * 2.8f, wp.z * 0.4f, 5, 2.1f, 0.52f, 303);
    float layerPos = wp.y * 3.5f + strataNoise * 1.2f;
    float layerBand = 0.5f + 0.5f * std::sin(layerPos);

    // Micro mineral speckles and shale cracks
    float voronoiCrag = FastNoise3D::worley(wp.x * 3.0f, wp.y * 3.0f, wp.z * 3.0f, 404);
    float fineCracks = math::smoothstep(0.04f, 0.0f, voronoiCrag);

    Vec3 sandstone = {0.52f, 0.44f, 0.38f};
    Vec3 shaleSlate = {0.24f, 0.25f, 0.27f};
    Vec3 ironMineral = {0.42f, 0.28f, 0.20f};

    Vec3 col = math::lerp(sandstone, shaleSlate, layerBand);
    col = math::lerp(col, ironMineral, fineCracks * 0.6f);

    TriplanarSample s;
    s.albedo = col;
    s.roughness = math::lerp(0.82f, 0.95f, layerBand);
    s.metallic = 0.02f;
    s.ao = math::lerp(1.0f, 0.65f, fineCracks);
    return s;
}

/**
 * Procedural Weathered Concrete with aggregate gravel inclusions and porosity voids.
 */
inline TriplanarSample sampleProceduralConcrete(const Vec3& p, const Vec3& normal, float scale = 2.0f) {
    Vec3 wp = p * scale;
    float baseFbm = FastNoise3D::fbm(wp.x, wp.y, wp.z, 4, 2.0f, 0.5f, 505);
    float aggregate = FastNoise3D::worley(wp.x * 8.0f, wp.y * 8.0f, wp.z * 8.0f, 606);
    float pitMask = math::smoothstep(0.08f, 0.02f, aggregate);

    Vec3 cementPaste = {0.48f, 0.49f, 0.50f};
    Vec3 aggregateGravel = {0.28f, 0.27f, 0.25f};
    Vec3 efflorescence = {0.72f, 0.73f, 0.74f}; // Mineral salt leaching

    float saltLeak = std::clamp(FastNoise3D::perlin(wp.x * 0.8f, wp.y * 0.8f, wp.z * 0.8f, 707) * 1.8f - 0.4f, 0.0f, 1.0f);

    Vec3 col = math::lerp(cementPaste * (0.85f + 0.3f * baseFbm), aggregateGravel, pitMask * 0.75f);
    col = math::lerp(col, efflorescence, saltLeak * 0.4f);

    TriplanarSample s;
    s.albedo = col;
    s.roughness = math::lerp(0.78f, 0.96f, pitMask);
    s.metallic = 0.0f;
    s.ao = math::lerp(1.0f, 0.55f, pitMask);
    return s;
}

/**
 * Procedural Velvet Moss Overgrowth on upward-facing surfaces.
 */
inline TriplanarSample sampleProceduralMoss(const Vec3& p, const Vec3& normal, float moisture = 0.7f) {
    float upward = std::clamp(normal.normalized().y, 0.0f, 1.0f);
    float mossNoise = FastNoise3D::fbm(p.x * 2.5f, p.y * 2.5f, p.z * 2.5f, 5, 2.0f, 0.5f, 808);
    float growthProbability = upward * moisture + (mossNoise - 0.5f) * 0.6f;
    float mossMask = math::smoothstep(0.35f, 0.65f, growthProbability);

    Vec3 deepMoss = {0.10f, 0.26f, 0.06f};
    Vec3 goldenMoss = {0.32f, 0.52f, 0.12f};
    Vec3 mossCol = math::lerp(deepMoss, goldenMoss, mossNoise);

    TriplanarSample s;
    s.albedo = mossCol;
    s.roughness = 0.94f; // Soft organic diffusion
    s.metallic = 0.0f;
    s.ao = math::lerp(1.0f, 0.8f, mossMask);
    return s;
}

/**
 * Bakes triplanar procedural materials directly into mesh vertex attributes (COLOR_0 and normals).
 */
inline void applyTriplanarToMesh(geometry::Mesh& mesh, TriplanarMaterialType matType, float scale = 1.0f) {
    if (mesh.vertexColors.size() != mesh.vertices.size()) {
        mesh.vertexColors.resize(mesh.vertices.size(), {1.0f, 1.0f, 1.0f, 1.0f});
    }

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        Vec3 p = mesh.vertices[i];
        Vec3 n = (i < mesh.normals.size()) ? mesh.normals[i] : Vec3(0, 1, 0);

        TriplanarSample s;
        switch (matType) {
            case TriplanarMaterialType::WOOD_OAK:
                s = sampleProceduralWood(p, n, scale);
                break;
            case TriplanarMaterialType::ROCK_STRATA:
                s = sampleProceduralRock(p, n, scale);
                break;
            case TriplanarMaterialType::CONCRETE_WEATHERED:
                s = sampleProceduralConcrete(p, n, scale);
                break;
            case TriplanarMaterialType::MOSS_OVERGROWTH:
                s = sampleProceduralMoss(p, n, scale);
                break;
            default:
                s = sampleProceduralRock(p, n, scale);
                break;
        }

        // Pack albedo into RGB, roughness into Alpha
        mesh.vertexColors[i] = {s.albedo.x, s.albedo.y, s.albedo.z, s.roughness};
    }
}

inline void applyTriplanarToMesh(geometry::ScratchboxMesh& mesh, TriplanarMaterialType matType, float scale = 1.0f) {
    for (auto& v : mesh.vertices) {
        TriplanarSample s;
        switch (matType) {
            case TriplanarMaterialType::WOOD_OAK:
                s = sampleProceduralWood(v.position, v.normal, scale);
                break;
            case TriplanarMaterialType::ROCK_STRATA:
                s = sampleProceduralRock(v.position, v.normal, scale);
                break;
            case TriplanarMaterialType::CONCRETE_WEATHERED:
                s = sampleProceduralConcrete(v.position, v.normal, scale);
                break;
            case TriplanarMaterialType::MOSS_OVERGROWTH:
                s = sampleProceduralMoss(v.position, v.normal, scale);
                break;
            default:
                s = sampleProceduralRock(v.position, v.normal, scale);
                break;
        }
        v.color = {s.albedo.x, s.albedo.y, s.albedo.z, s.roughness};
    }
}

} // namespace triplanar
} // namespace scratchbox

#endif // SCRATCHBOX_TRIPLANAR_HPP
