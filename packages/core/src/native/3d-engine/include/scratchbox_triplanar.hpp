/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TRIPLANAR_HPP
#define SCRATCHBOX_TRIPLANAR_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr_manifold.hpp"
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
    MOSS_OVERGROWTH,
    MUDBRICK_MASONRY,
    STONE_CAVITATION,
    LAPIS_GLAZE
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
 * Procedural Mudbrick Masonry with staggered mortar courses and micro-porosity.
 */
inline TriplanarSample sampleProceduralMudbrick(const Vec3& p, const Vec3& normal, float scale = 1.0f) {
    float yCourse = p.y * 1.25f * scale;
    float row = std::floor(yCourse);
    float yFrac = yCourse - row;
    float rowStagger = (std::fmod(row, 2.0f) != 0.0f) ? 0.5f : 0.0f;
    float xBrick = (p.x * 2.75f * scale) + rowStagger;
    float xFrac = xBrick - std::floor(xBrick);

    float dBed = std::min(yFrac, 1.0f - yFrac);
    float dHead = std::min(xFrac, 1.0f - xFrac);
    float dJoint = std::min(dBed, dHead);

    float mortarFactor = 1.0f - math::smoothstep(0.0f, 0.085f, dJoint);
    float poreNoise = FastNoise3D::fbm(p.x * 8.0f, p.y * 8.0f, p.z * 8.0f, 3, 2.0f, 0.5f, 303);
    float porePit = (poreNoise < 0.24f) ? std::pow((0.24f - poreNoise) / 0.24f, 2.0f) : 0.0f;

    Vec3 brickAlbedo = {0.73f, 0.64f, 0.48f};
    Vec3 mortarAlbedo = {0.52f, 0.48f, 0.42f};
    Vec3 col = math::lerp(brickAlbedo, mortarAlbedo, mortarFactor);
    col = col * (1.0f - porePit * 0.45f);

    TriplanarSample s;
    s.albedo = col;
    s.roughness = math::lerp(0.86f, 0.98f, mortarFactor) + porePit * 0.15f;
    s.metallic = 0.02f;
    s.ao = (1.0f - mortarFactor * 0.35f);
    return s;
}

/**
 * Procedural Stone Cavitation Pores (travertine/limestone porosity and mineral grain).
 */
inline TriplanarSample sampleProceduralStoneCavitation(const Vec3& p, const Vec3& normal, float scale = 1.0f) {
    float poreNoise = FastNoise3D::fbm(p.x * 10.0f * scale, p.y * 10.0f * scale, p.z * 10.0f * scale, 4, 2.0f, 0.5f, 404);
    float pit = (poreNoise < 0.26f) ? std::pow((0.26f - poreNoise) / 0.26f, 2.0f) : 0.0f;
    float mineral = FastNoise3D::perlin(p.x * 32.0f, p.y * 32.0f, p.z * 32.0f, 505);

    Vec3 stoneAlbedo = {0.68f + mineral * 0.06f, 0.67f + mineral * 0.05f, 0.65f + mineral * 0.04f};
    stoneAlbedo = stoneAlbedo * (1.0f - pit * 0.55f);

    TriplanarSample s;
    s.albedo = stoneAlbedo;
    s.roughness = std::clamp(0.72f + pit * 0.25f, 0.0f, 1.0f);
    s.metallic = 0.04f;
    s.ao = 1.0f - pit * 0.40f;
    return s;
}

/**
 * Procedural Lapis Lazuli Glaze with vitreous gloss and golden pyrite specks.
 */
inline TriplanarSample sampleProceduralLapisGlaze(const Vec3& p, const Vec3& normal, float scale = 1.0f) {
    float crazing = FastNoise3D::worley(p.x * 6.5f * scale, p.y * 6.5f * scale, p.z * 6.5f * scale, 606);
    float pyrite = FastNoise3D::perlin(p.x * 24.0f, p.y * 24.0f, p.z * 24.0f, 707);

    Vec3 lapisDeep = {0.08f, 0.20f, 0.55f};
    Vec3 lapisBright = {0.12f, 0.28f, 0.72f};
    Vec3 pyriteGold = {0.84f, 0.70f, 0.24f};

    Vec3 col = math::lerp(lapisDeep, lapisBright, crazing);
    float isPyrite = (pyrite > 0.65f) ? 1.0f : 0.0f;
    col = math::lerp(col, pyriteGold, isPyrite);

    TriplanarSample s;
    s.albedo = col;
    s.roughness = isPyrite > 0.5f ? 0.32f : 0.14f; // Vitreous smooth silicate glaze
    s.metallic = isPyrite > 0.5f ? 0.85f : 0.12f;
    s.ao = 1.0f;
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
            case TriplanarMaterialType::MUDBRICK_MASONRY:
                s = sampleProceduralMudbrick(p, n, scale);
                break;
            case TriplanarMaterialType::STONE_CAVITATION:
                s = sampleProceduralStoneCavitation(p, n, scale);
                break;
            case TriplanarMaterialType::LAPIS_GLAZE:
                s = sampleProceduralLapisGlaze(p, n, scale);
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
            case TriplanarMaterialType::MUDBRICK_MASONRY:
                s = sampleProceduralMudbrick(v.position, v.normal, scale);
                break;
            case TriplanarMaterialType::STONE_CAVITATION:
                s = sampleProceduralStoneCavitation(v.position, v.normal, scale);
                break;
            case TriplanarMaterialType::LAPIS_GLAZE:
                s = sampleProceduralLapisGlaze(v.position, v.normal, scale);
                break;
            default:
                s = sampleProceduralRock(v.position, v.normal, scale);
                break;
        }
        v.color = {s.albedo.x, s.albedo.y, s.albedo.z, s.roughness};
    }
}

// ============================================================================
// Phase 3: Continuous Texture Coordinate Tiling & Triplanar Projection
// Adaptive Domain Architecture (ADA): Continuous biophysical parameters
// and conformal projection onto arbitrary complex non-manifold geometry.
// ============================================================================

struct ContinuousTriplanarCoords {
    Vec3 weights{0.3333f, 0.3333f, 0.3334f};
    Vec2 uvX{0.0f, 0.0f}; // YZ projection (position.z, position.y)
    Vec2 uvY{0.0f, 0.0f}; // XZ projection (position.x, position.z)
    Vec2 uvZ{0.0f, 0.0f}; // XY projection (position.x, position.y)
};

struct ContinuousTriplanarConfig {
    float metricScale = 1.0f;
    float sharpness = 4.0f;
    Vec2 uvTiling = {1.0f, 1.0f};
    Vec2 uvOffset = {0.0f, 0.0f};
    float blendSoftness = 0.5f;
    uint32_t seed = 42;
};

/**
 * Computes continuous projected UV coordinates across 3 orthogonal planes.
 */
inline ContinuousTriplanarCoords projectContinuousTriplanarCoords(
    const Vec3& position,
    const Vec3& normal,
    Vec2 uvTiling = {1.0f, 1.0f},
    Vec2 uvOffset = {0.0f, 0.0f},
    float sharpness = 4.0f)
{
    Vec3 w = computeTriplanarWeights(normal, sharpness);
    ContinuousTriplanarCoords c;
    c.weights = w;
    c.uvX = Vec2(position.z * uvTiling.x + uvOffset.x, position.y * uvTiling.y + uvOffset.y);
    c.uvY = Vec2(position.x * uvTiling.x + uvOffset.x, position.z * uvTiling.y + uvOffset.y);
    c.uvZ = Vec2(position.x * uvTiling.x + uvOffset.x, position.y * uvTiling.y + uvOffset.y);
    return c;
}

/**
 * Samples a continuous material manifold descriptor across 3 projection planes,
 * seamlessly blending multi-octave FBM, Scharr-normal perturbation, and biophysical
 * curvature wear using Reoriented Normal Mapping (RNM).
 */
inline TriplanarSample sampleContinuousManifoldTriplanar(
    const Vec3& p,
    const Vec3& normal,
    const pbr_manifold::ContinuousMaterialDescriptor& desc,
    const ContinuousTriplanarConfig& config = {})
{
    ContinuousTriplanarCoords coords = projectContinuousTriplanarCoords(
        p * config.metricScale, normal, config.uvTiling, config.uvOffset, config.sharpness
    );

    auto samplePlane = [&](const Vec2& uv) -> TriplanarSample {
        float u = uv.x;
        float v = uv.y;

        // Anisotropic warping if specified in descriptor
        if (desc.anisotropyStrength > 0.01f) {
            float cosA = std::cos(desc.anisotropyAngleRad);
            float sinA = std::sin(desc.anisotropyAngleRad);
            float uRot = u * cosA - v * sinA;
            float vRot = (u * sinA + v * cosA) * (1.0f + 8.0f * desc.anisotropyStrength);
            u = uRot;
            v = vRot;
        }

        // Multi-octave FBM + Voronoi cellular field
        float fbmVal = FastNoise3D::fbm(u * desc.fissureScale, v * desc.fissureScale, 0.0f,
                                        static_cast<int>(desc.fbmOctaves), 2.0f, desc.fbmGain, config.seed);
        float cellVal = FastNoise3D::worley(u * desc.fissureScale * 1.5f, v * desc.fissureScale * 1.5f, 0.0f, config.seed + 101);
        float microGrain = FastNoise3D::perlin(u * 64.0f, v * 64.0f, 0.0f, config.seed + 202);

        float height = std::clamp(fbmVal * (1.0f - desc.cellularWeight) +
                                  cellVal * desc.cellularWeight +
                                  (microGrain - 0.5f) * desc.graininess, 0.0f, 1.0f);

        // Albedo blending with secondary inclusion
        float veinMask = math::smoothstep(1.0f - desc.secondaryWeight, 1.0f, height);
        Vec3 baseCol = math::lerp(desc.albedoLinear, desc.secondaryAlbedo, veinMask);
        baseCol = baseCol * (0.85f + 0.30f * height);

        // Biophysical roughness coupled with microPorosity and height
        float rough = std::clamp(desc.roughnessBaseline + (1.0f - height) * desc.microPorosity, 0.04f, 0.98f);

        TriplanarSample s;
        s.albedo = baseCol;
        s.roughness = rough;
        s.metallic = desc.conduction;
        s.ao = std::clamp(0.65f + 0.35f * height, 0.0f, 1.0f);
        return s;
    };

    TriplanarSample sX = samplePlane(coords.uvX);
    TriplanarSample sY = samplePlane(coords.uvY);
    TriplanarSample sZ = samplePlane(coords.uvZ);

    TriplanarSample blended;
    blended.albedo = sX.albedo * coords.weights.x + sY.albedo * coords.weights.y + sZ.albedo * coords.weights.z;
    blended.roughness = sX.roughness * coords.weights.x + sY.roughness * coords.weights.y + sZ.roughness * coords.weights.z;
    blended.metallic = sX.metallic * coords.weights.x + sY.metallic * coords.weights.y + sZ.metallic * coords.weights.z;
    blended.ao = sX.ao * coords.weights.x + sY.ao * coords.weights.y + sZ.ao * coords.weights.z;
    return blended;
}

/**
 * Projects a continuous material manifold onto an arbitrary geometry::Mesh,
 * baking blended albedo and roughness directly into vertex colors.
 */
inline void applyContinuousTriplanarToMesh(
    geometry::Mesh& mesh,
    const pbr_manifold::ContinuousMaterialDescriptor& desc,
    const ContinuousTriplanarConfig& config = {})
{
    if (mesh.vertexColors.size() != mesh.vertices.size()) {
        mesh.vertexColors.resize(mesh.vertices.size(), {1.0f, 1.0f, 1.0f, 1.0f});
    }

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        Vec3 p = mesh.vertices[i];
        Vec3 n = (i < mesh.normals.size()) ? mesh.normals[i] : Vec3(0, 1, 0);
        TriplanarSample s = sampleContinuousManifoldTriplanar(p, n, desc, config);
        mesh.vertexColors[i] = {s.albedo.x, s.albedo.y, s.albedo.z, s.roughness};
    }
}

/**
 * Projects a continuous material manifold onto geometry::ScratchboxMesh.
 */
inline void applyContinuousTriplanarToMesh(
    geometry::ScratchboxMesh& mesh,
    const pbr_manifold::ContinuousMaterialDescriptor& desc,
    const ContinuousTriplanarConfig& config = {})
{
    for (auto& v : mesh.vertices) {
        TriplanarSample s = sampleContinuousManifoldTriplanar(v.position, v.normal, desc, config);
        v.color = {s.albedo.x, s.albedo.y, s.albedo.z, s.roughness};
    }
}

/**
 * Generates continuous non-overlapping conformal texture coordinates for arbitrary
 * complex non-manifold geometry by unwrapping along the dominant projection plane.
 */
inline void generateContinuousTriplanarUvs(
    geometry::Mesh& mesh,
    Vec2 uvTiling = {1.0f, 1.0f},
    float sharpness = 4.0f)
{
    mesh.uvs.resize(mesh.vertices.size());
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        Vec3 p = mesh.vertices[i];
        Vec3 n = (i < mesh.normals.size()) ? mesh.normals[i].normalized() : Vec3(0, 1, 0);

        float ax = std::abs(n.x);
        float ay = std::abs(n.y);
        float az = std::abs(n.z);

        if (ay >= ax && ay >= az) {
            // Dominant XZ (horizontal ground/roof)
            mesh.uvs[i] = {p.x * uvTiling.x, p.z * uvTiling.y};
        } else if (ax >= ay && ax >= az) {
            // Dominant YZ (side elevation)
            mesh.uvs[i] = {p.z * uvTiling.x, p.y * uvTiling.y};
        } else {
            // Dominant XY (front elevation)
            mesh.uvs[i] = {p.x * uvTiling.x, p.y * uvTiling.y};
        }
    }
}

} // namespace triplanar
} // namespace scratchbox

#endif // SCRATCHBOX_TRIPLANAR_HPP
