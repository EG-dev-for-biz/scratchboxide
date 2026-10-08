/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SUBSTRATE_HPP
#define SCRATCHBOX_SUBSTRATE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_triplanar.hpp"

#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <numeric>

namespace scratchbox {
namespace substrate {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::PbrMaterial;

/**
 * PhysicalLayer represents a single stratified strata in a layered material stack.
 * Follows biophysical optical parameters.
 */
struct PhysicalLayer {
    std::string name{"Substrate"};
    
    // Core Optical Properties
    Vec3 baseColor{0.8f, 0.8f, 0.8f};
    float roughness{0.5f};
    float metallic{0.0f};
    float specularF0{0.04f};       // 0.04 for common dielectrics, 0.5-1.0 for metals
    float ior{1.5f};              // Index of refraction
    
    // Spatial Perturbations
    Vec3 normal{0.0f, 0.0f, 1.0f}; // Tangent-space normal
    float height{0.5f};            // Surface relief height [0, 1]
    float coverageMask{1.0f};      // Spatial distribution mask [0, 1]
    
    // Volumetric Absorption (Beer-Lambert Law)
    float thicknessMm{0.0f};       // Physical thickness in millimeters (0.0 = infinitely thin)
    Vec3 absorptionCoeff{0.0f, 0.0f, 0.0f}; // sigma_a per mm (e.g. for tinted glass, glaze, or water)
};

/**
 * EvaluatedBSDF encapsulates the consolidated optical parameters
 * resulting from multi-layer BSDF stratification and energy conservation.
 */
struct EvaluatedBSDF {
    Vec3 diffuseAlbedo{0.8f, 0.8f, 0.8f};
    Vec3 specularF0{0.04f, 0.04f, 0.04f};
    float roughness{0.5f};
    float metallic{0.0f};
    Vec3 normal{0.0f, 0.0f, 1.0f};
    
    // Top-layer Clearcoat/Sheen channel
    float clearcoat{0.0f};
    float clearcoatRoughness{0.05f};
    Vec3 clearcoatNormal{0.0f, 0.0f, 1.0f};
    
    // Volumetric Attenuation
    Vec3 transmissionThroughput{1.0f, 1.0f, 1.0f};
};

/**
 * HeightBlender calculates physically accurate height-modulated blending weights.
 * Crevices and valleys fill up before peaks become submerged.
 */
class HeightBlender {
public:
    static std::vector<float> computeWeights(
        const std::vector<PhysicalLayer>& layers,
        float softness = 0.1f
    ) {
        if (layers.empty()) return {};
        if (layers.size() == 1) return {1.0f};
        
        std::vector<float> scores(layers.size());
        float maxScore = -1e9f;
        
        for (size_t i = 0; i < layers.size(); ++i) {
            // Priority increases with stack index (higher layers sit on top)
            float depthBias = static_cast<float>(i) * 0.2f;
            float s = layers[i].height + layers[i].coverageMask + depthBias;
            scores[i] = s;
            if (s > maxScore) maxScore = s;
        }
        
        std::vector<float> weights(layers.size());
        float sumWeights = 0.0f;
        float delta = std::max(0.001f, softness);
        
        for (size_t i = 0; i < layers.size(); ++i) {
            float w = std::clamp((scores[i] - (maxScore - delta)) / delta, 0.0f, 1.0f);
            weights[i] = w;
            sumWeights += w;
        }
        
        if (sumWeights > 1e-6f) {
            for (float& w : weights) w /= sumWeights;
        } else {
            weights[0] = 1.0f;
        }
        
        return weights;
    }
};

/**
 * LayeredMaterialStack orchestrates multi-layer vertical stratification,
 * energy conservation (Fresnel subtraction + Beer-Lambert absorption),
 * and Reoriented Normal Mapping (RNM).
 */
class LayeredMaterialStack {
public:
    std::string name{"ArchitecturalLayeredMaterial"};
    // Layers ordered from base substrate (0) up to topcoat (N-1)
    std::vector<PhysicalLayer> layers;

    void addLayer(const PhysicalLayer& layer) {
        layers.push_back(layer);
    }

    /**
     * Evaluates the multi-layer BSDF at a given view direction.
     * Guarantees strict energy conservation:
     * Reflectance + Transmittance + Absorption <= 1.0
     */
    EvaluatedBSDF evaluate(const Vec3& viewDirTangent) const {
        if (layers.empty()) return EvaluatedBSDF{};
        
        Vec3 V = viewDirTangent.normalized();
        EvaluatedBSDF bsdf{};
        
        // 1. Height-blended layer distribution
        std::vector<float> weights = HeightBlender::computeWeights(layers, 0.08f);
        
        // 2. Stratified Vertical Evaluation (from Topcoat down to Base Substrate)
        Vec3 cumulativeNormal = layers[0].normal;
        Vec3 opticalThroughput{1.0f, 1.0f, 1.0f};
        
        // If top layer has clearcoat properties (e.g. rainwater film or varnish)
        if (layers.size() > 1 && layers.back().thicknessMm > 0.0f && layers.back().roughness < 0.15f) {
            const auto& topLayer = layers.back();
            float NdotV = std::max(0.001f, topLayer.normal.dot(V));
            
            // Schlick Fresnel for topcoat
            float F_top = topLayer.specularF0 + (1.0f - topLayer.specularF0) * std::pow(1.0f - NdotV, 5.0f);
            bsdf.clearcoat = F_top * topLayer.coverageMask;
            bsdf.clearcoatRoughness = topLayer.roughness;
            bsdf.clearcoatNormal = topLayer.normal;
            
            // Transmitted light entering substrate
            float transmittedEnergy = 1.0f - bsdf.clearcoat;
            
            // Beer-Lambert Volumetric Absorption in the top layer:
            // T = exp(-sigma_a * thickness / cos(theta_t))
            float cosThetaT = std::sqrt(std::max(0.0f, 1.0f - (1.0f / (topLayer.ior * topLayer.ior)) * (1.0f - NdotV * NdotV)));
            cosThetaT = std::max(0.05f, cosThetaT);
            float opticalPathLength = topLayer.thicknessMm / cosThetaT;
            
            Vec3 absorption = {
                std::exp(-topLayer.absorptionCoeff.x * opticalPathLength),
                std::exp(-topLayer.absorptionCoeff.y * opticalPathLength),
                std::exp(-topLayer.absorptionCoeff.z * opticalPathLength)
            };
            
            opticalThroughput = absorption * transmittedEnergy;
        }
        
        // 3. Reoriented Normal Mapping & Attribute Blending across active layers
        Vec3 blendedAlbedo{0.0f, 0.0f, 0.0f};
        float blendedRoughness = 0.0f;
        float blendedMetallic = 0.0f;
        Vec3 blendedF0{0.0f, 0.0f, 0.0f};
        
        for (size_t i = 0; i < layers.size(); ++i) {
            float w = weights[i];
            const auto& L = layers[i];
            
            blendedAlbedo += L.baseColor * w;
            blendedRoughness += L.roughness * w;
            blendedMetallic += L.metallic * w;
            blendedF0 += Vec3{L.specularF0, L.specularF0, L.specularF0} * w;
            
            if (i > 0 && w > 0.01f) {
                // Blend tangent-space normal via Reoriented Normal Mapping (RNM)
                cumulativeNormal = triplanar::blendReorientedNormals(cumulativeNormal, L.normal);
            }
        }
        
        // Apply throughput attenuation to the diffuse albedo
        bsdf.diffuseAlbedo = blendedAlbedo * opticalThroughput;
        bsdf.roughness = std::clamp(blendedRoughness, 0.04f, 1.0f);
        bsdf.metallic = std::clamp(blendedMetallic, 0.0f, 1.0f);
        bsdf.specularF0 = blendedF0;
        bsdf.normal = cumulativeNormal.normalized();
        bsdf.transmissionThroughput = opticalThroughput;
        
        return bsdf;
    }

    /**
     * Converts the evaluated layered BSDF to a standard glTF 2.0 PbrMaterial
     * with PBR Next extension properties (Clearcoat, Volume, Specular).
     */
    PbrMaterial toPbrMaterial(const Vec3& viewDirTangent = Vec3{0.0f, 0.0f, 1.0f}) const {
        EvaluatedBSDF bsdf = evaluate(viewDirTangent);
        PbrMaterial mat;
        mat.name = name;
        mat.baseColorFactor = Vec4{bsdf.diffuseAlbedo.x, bsdf.diffuseAlbedo.y, bsdf.diffuseAlbedo.z, 1.0f};
        mat.roughnessFactor = bsdf.roughness;
        mat.metallicFactor = bsdf.metallic;
        
        // Extensions
        mat.clearcoatFactor = bsdf.clearcoat;
        mat.clearcoatRoughnessFactor = bsdf.clearcoatRoughness;
        mat.ior = (layers.empty()) ? 1.5f : layers.back().ior;
        if (layers.size() > 1 && layers.back().thicknessMm > 0.0f) {
            mat.transmissionFactor = 1.0f - bsdf.clearcoat;
            mat.thicknessFactor = layers.back().thicknessMm;
            mat.attenuationColor = bsdf.transmissionThroughput;
            mat.attenuationDistance = 1.0f;
        }
        
        return mat;
    }
};

/**
 * Procedural Wear, Inverted Layer Weight Fresnel & Crevice Grime Engine
 *
 * Replicates the master Blender shader node pattern:
 * 1. Geometry Node / Vertex Pointiness (Curvature) + Bevel normal deviation.
 * 2. Ambient Occlusion (Cavity Crevices).
 * 3. Inverted Layer Weight Fresnel Mask (1.0 - N.V) accumulating dust and lint in grazing view angles.
 * 4. Gravity-Aligned Upward Plane Projection (N.Up)^gamma depositing settled dust, needle silt, and pollen.
 * 5. Mechanical Edge Wear eroding convex corners to reveal lighter, desaturated core substrate.
 */
struct WearGrimeParameters {
    float pointiness{0.0f};          // > 0 = sharp convex edge, < 0 = concave crevice
    float ambientOcclusion{1.0f};    // 0 = deeply recessed cavity, 1 = open unoccluded space
    Vec3 worldNormal{0.0f, 1.0f, 0.0f};
    Vec3 viewDirection{0.0f, 0.0f, 1.0f};
    Vec3 upAxis{0.0f, 1.0f, 0.0f};

    // Layer parameters
    float edgeWearStrength{0.75f};
    float creviceGrimeStrength{0.85f};
    float dustAccumulationStrength{0.65f};
    float invertedFresnelStrength{0.45f};
    float fresnelExponent{2.8f};
    float upwardGravityPower{3.0f}; // Sharpness of upward plane isolation

    // Physical color paletting
    Vec3 wornCoreColor{0.48f, 0.32f, 0.22f};      // Lightened, scuffed exposed core
    Vec3 creviceGrimeColor{0.08f, 0.05f, 0.03f};  // Moist dark humus / mildew crevice sludge
    Vec3 settledDustColor{0.72f, 0.68f, 0.58f};   // Microscopic spore dust, lint, and needle silt
};

struct WearGrimeResult {
    Vec3 finalAlbedo;
    float finalRoughness;
    float edgeWearMask;
    float creviceGrimeMask;
    float dustMask;
};

class ProceduralWearAndGrimeShader {
public:
    static WearGrimeResult evaluate(
        const Vec3& baseAlbedo,
        float baseRoughness,
        const WearGrimeParameters& p
    ) {
        Vec3 N = p.worldNormal.normalized();
        Vec3 V = p.viewDirection.normalized();
        Vec3 Up = p.upAxis.normalized();

        // 1. Procedural Edge Wear Mask (Pointiness > 0 and high ambient exposure)
        float convexFeature = std::max(0.0f, p.pointiness * 2.0f);
        float edgeWearMask = std::clamp(convexFeature * p.ambientOcclusion * p.edgeWearStrength, 0.0f, 1.0f);

        // 2. Crevice Grime Mask (Pointiness < 0 combined with Cavity Ambient Occlusion)
        float concaveFeature = std::max(0.0f, -p.pointiness * 2.0f);
        float aoCavity = std::clamp((1.0f - p.ambientOcclusion) * 1.5f, 0.0f, 1.0f);
        float creviceGrimeMask = std::clamp((concaveFeature * 0.45f + aoCavity * 0.75f) * p.creviceGrimeStrength, 0.0f, 1.0f);

        // 3. Gravity-driven Upward Horizontal Plane Accumulation (N . Up)^gamma
        float upDot = std::max(0.0f, N.dot(Up));
        float horizontalPlateau = std::pow(upDot, p.upwardGravityPower);

        // 4. Inverted Layer Weight Fresnel Mask: (1.0 - |N . V|)^exp
        float facing = std::clamp(std::abs(N.dot(V)), 0.0f, 1.0f);
        float invertedFresnel = std::pow(1.0f - facing, p.fresnelExponent) * p.invertedFresnelStrength;

        // Combined dust & lint mask settling on upward horizontal surfaces and grazing crevices
        float dustMask = std::clamp((horizontalPlateau * 0.75f + invertedFresnel * 0.40f) * p.dustAccumulationStrength, 0.0f, 0.85f);
        // Do not accumulate dust on high edge wear
        dustMask *= (1.0f - edgeWearMask * 0.8f);

        // 5. Stratified Compositing
        // Base -> Grime in Crevices -> Worn Edges -> Settled Dust on Top
        Vec3 albedo = baseAlbedo;
        float roughness = baseRoughness;

        // Apply crevice grime (darkens, increases roughness)
        albedo = math::lerp(albedo, p.creviceGrimeColor, creviceGrimeMask * 0.85f);
        roughness = math::lerp(roughness, 0.95f, creviceGrimeMask * 0.50f);

        // Apply edge wear (scuffs, lightens, polished contact edges have lower roughness)
        albedo = math::lerp(albedo, p.wornCoreColor, edgeWearMask);
        roughness = math::lerp(roughness, 0.38f, edgeWearMask * 0.60f);

        // Apply settled dust & lint (diffuse powdery layer)
        albedo = math::lerp(albedo, p.settledDustColor, dustMask);
        roughness = math::lerp(roughness, 0.92f, dustMask * 0.70f);

        return WearGrimeResult{albedo, roughness, edgeWearMask, creviceGrimeMask, dustMask};
    }

    /**
     * Bakes curvature-driven mechanical edge wear and cavity crevice grime
     * directly into the mesh vertex colors and materials.
     */
    static void applyWearAndGrimeToMesh(geometry::ScratchboxMesh& mesh) {
        WearGrimeParameters params;
        applyWearAndGrimeToMesh(mesh, params, Vec3(0.55f, 0.57f, 0.60f), 0.5f);
    }

    static void applyWearAndGrimeToMesh(
        geometry::ScratchboxMesh& mesh,
        const WearGrimeParameters& defaultParams,
        const Vec3& defaultAlbedo = Vec3(0.55f, 0.57f, 0.60f),
        float defaultRoughness = 0.5f
    ) {
        for (auto& v : mesh.vertices) {
            WearGrimeParameters p = defaultParams;
            // Pointiness from vertex color R channel (scaled from [0,1] normalized to [-1, 1])
            float normCurv = v.color.x;
            p.pointiness = (normCurv - 0.25f) * 2.0f;
            // Ambient occlusion cavity factor from vertex color G channel
            p.ambientOcclusion = v.color.y;
            p.worldNormal = v.normal;

            WearGrimeResult res = evaluate(defaultAlbedo, defaultRoughness, p);
            // Bake back into vertex color RGB
            v.color = Vec4(res.finalAlbedo.x, res.finalAlbedo.y, res.finalAlbedo.z, 1.0f);
        }
    }
};

} // namespace substrate
} // namespace scratchbox

#endif // SCRATCHBOX_SUBSTRATE_HPP
