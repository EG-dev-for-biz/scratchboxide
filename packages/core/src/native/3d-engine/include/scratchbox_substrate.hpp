/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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

} // namespace substrate
} // namespace scratchbox

#endif // SCRATCHBOX_SUBSTRATE_HPP
