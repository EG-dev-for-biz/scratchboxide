/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_HEADLESS_REALISM_HPP
#define SCRATCHBOX_HEADLESS_REALISM_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <unordered_map>
#include <string>

namespace scratchbox {
namespace realism {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::ScratchboxMesh;
using geometry::Vertex;
using geometry::PbrMaterial;

// ============================================================================
// 1. Headless Differential Curvature Operator
// ============================================================================

struct CurvatureTensorField {
    std::vector<float> k1;               // Maximum principal curvature
    std::vector<float> k2;               // Minimum principal curvature
    std::vector<float> meanCurvature;    // H = (k1 + k2) / 2
    std::vector<float> gaussianCurvature;// K = k1 * k2
    std::vector<float> shapeIndex;       // S = 2/pi * atan((k1 + k2) / (k1 - k2)) in [-1, +1]
    std::vector<float> curvedness;       // C = sqrt((k1^2 + k2^2) / 2)
};

class HeadlessDifferentialCurvatureOperator {
public:
    /**
     * Evaluates continuous differential curvature fields on any polygon mesh topology.
     * Decoupled from material or visual representation.
     */
    static CurvatureTensorField evaluateCurvatureField(
        const ScratchboxMesh& mesh,
        float neighborhoodRadius = 0.0f
    ) {
        size_t nVerts = mesh.vertices.size();
        CurvatureTensorField field;
        field.k1.assign(nVerts, 0.0f);
        field.k2.assign(nVerts, 0.0f);
        field.meanCurvature.assign(nVerts, 0.0f);
        field.gaussianCurvature.assign(nVerts, 0.0f);
        field.shapeIndex.assign(nVerts, 0.0f);
        field.curvedness.assign(nVerts, 0.0f);

        if (nVerts == 0 || mesh.indices.size() < 3) return field;

        // Build adjacency map
        std::vector<std::vector<uint32_t>> adj(nVerts);
        for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
            uint32_t i0 = mesh.indices[i];
            uint32_t i1 = mesh.indices[i + 1];
            uint32_t i2 = mesh.indices[i + 2];
            if (i0 < nVerts && i1 < nVerts && i2 < nVerts) {
                adj[i0].push_back(i1); adj[i0].push_back(i2);
                adj[i1].push_back(i0); adj[i1].push_back(i2);
                adj[i2].push_back(i0); adj[i2].push_back(i1);
            }
        }

        for (size_t i = 0; i < nVerts; ++i) {
            const Vec3& p_i = mesh.vertices[i].position;
            const Vec3& n_i = mesh.vertices[i].normal;

            float minKappa = 1e8f;
            float maxKappa = -1e8f;
            int count = 0;

            for (uint32_t nbr : adj[i]) {
                Vec3 edge = mesh.vertices[nbr].position - p_i;
                float distSq = edge.lengthSquared();
                if (distSq < 1e-10f) continue;
                if (neighborhoodRadius > 0.0f && distSq > neighborhoodRadius * neighborhoodRadius) continue;

                // Directional normal curvature: kappa = 2 * ((p_nbr - p_i) . n_i) / ||p_nbr - p_i||^2
                float kappa = 2.0f * edge.dot(n_i) / distSq;
                minKappa = std::min(minKappa, kappa);
                maxKappa = std::max(maxKappa, kappa);
                count++;
            }

            if (count > 0) {
                float k1 = maxKappa;
                float k2 = minKappa;
                float H = 0.5f * (k1 + k2);
                float K = k1 * k2;
                float diff = k1 - k2;
                float S = 0.0f;
                if (std::abs(diff) > 1e-6f) {
                    S = (2.0f / math::PI) * std::atan((k1 + k2) / diff);
                }
                float C = std::sqrt(0.5f * (k1 * k1 + k2 * k2));

                field.k1[i] = k1;
                field.k2[i] = k2;
                field.meanCurvature[i] = H;
                field.gaussianCurvature[i] = K;
                field.shapeIndex[i] = std::clamp(S, -1.0f, 1.0f);
                field.curvedness[i] = C;
            }
        }

        return field;
    }
};

// ============================================================================
// 2. Headless Stratified Wear Operator
// ============================================================================

struct WearLayerDefinition {
    Vec4 albedo{0.8f, 0.8f, 0.8f, 1.0f};
    float metallic{0.0f};
    float roughness{0.5f};
    float clearcoat{0.0f};
};

struct WearTransferParameters {
    float convexitySensitivity{1.8f};     // Amplifies edge wear (S > 0)
    float concavityOcclusionWeight{1.2f}; // Amplifies crevice accumulation (S < 0)
    float microNoiseScale{32.0f};          // Spatial frequency of micro-chipping
    float wearExposure{0.0f};              // Continuous bias [-1.0, 1.0]
    float layerTransitionSharpness{8.0f};  // Sigmoid sharpness between tiers
    float primerThreshold{0.35f};          // Exposure boundary where topcoat chips away to primer
    float substrateThreshold{0.70f};       // Exposure boundary where primer chips away to substrate metal
};

class HeadlessStratifiedWearOperator {
public:
    /**
     * Applies parameterized multi-layer substratum wear headlessly to an arbitrary mesh.
     * Evaluates wear exposure: E = sigmoid(w_c * S + w_noise * Noise - threshold)
     * Decoupled from hardcoded scene presets.
     */
    static void applyStratifiedWear(
        ScratchboxMesh& mesh,
        const WearTransferParameters& params,
        const std::vector<WearLayerDefinition>& layers
    ) {
        if (mesh.vertices.empty() || layers.size() < 2) return;

        CurvatureTensorField curvature = HeadlessDifferentialCurvatureOperator::evaluateCurvatureField(mesh);

        for (size_t i = 0; i < mesh.vertices.size(); ++i) {
            Vertex& v = mesh.vertices[i];
            float S = curvature.shapeIndex[i]; // in [-1, 1]

            // Micro-fracture noise function based on vertex position
            float nx = std::sin(v.position.x * params.microNoiseScale * 1.3f);
            float ny = std::cos(v.position.y * params.microNoiseScale * 1.7f);
            float nz = std::sin(v.position.z * params.microNoiseScale * 2.1f);
            float microNoise = 0.333f * (nx + ny + nz); // [-1, 1]

            // Continuous wear intensity
            float convexityFactor = std::max(0.0f, S);
            float rawWear = (convexityFactor * params.convexitySensitivity)
                          + (microNoise * 0.4f)
                          + params.wearExposure;

            // Sigmoid activation
            float wearExposure = 1.0f / (1.0f + std::exp(-params.layerTransitionSharpness * (rawWear - 0.5f)));
            wearExposure = std::clamp(wearExposure, 0.0f, 1.0f);

            // Interpolate across arbitrary substratum layers
            // Layer 0: Pristine topcoat
            // Layer 1: Intermediate primer
            // Layer 2+: Base substrate metal
            Vec4 blendedAlbedo;
            float blendedMetallic = 0.0f;
            float blendedRoughness = 0.5f;

            if (layers.size() == 2) {
                float t = wearExposure;
                blendedAlbedo = layers[0].albedo * (1.0f - t) + layers[1].albedo * t;
                blendedMetallic = layers[0].metallic * (1.0f - t) + layers[1].metallic * t;
                blendedRoughness = layers[0].roughness * (1.0f - t) + layers[1].roughness * t;
            } else {
                if (wearExposure < params.primerThreshold) {
                    float t = wearExposure / std::max(1e-4f, params.primerThreshold);
                    blendedAlbedo = layers[0].albedo * (1.0f - t) + layers[1].albedo * t;
                    blendedMetallic = layers[0].metallic * (1.0f - t) + layers[1].metallic * t;
                    blendedRoughness = layers[0].roughness * (1.0f - t) + layers[1].roughness * t;
                } else {
                    float t = (wearExposure - params.primerThreshold) / std::max(1e-4f, 1.0f - params.primerThreshold);
                    t = std::clamp(t, 0.0f, 1.0f);
                    blendedAlbedo = layers[1].albedo * (1.0f - t) + layers[2].albedo * t;
                    blendedMetallic = layers[1].metallic * (1.0f - t) + layers[2].metallic * t;
                    blendedRoughness = layers[1].roughness * (1.0f - t) + layers[2].roughness * t;
                }
            }

            // Encode wear directly into vertex color (RGBA) and modulate normal micro-roughness
            v.color = blendedAlbedo;
            // Modulate normal slightly along gradient of noise
            Vec3 perturbation(
                std::cos(v.position.y * params.microNoiseScale * 2.0f),
                std::sin(v.position.z * params.microNoiseScale * 2.0f),
                std::cos(v.position.x * params.microNoiseScale * 2.0f)
            );
            v.normal = (v.normal + perturbation * (wearExposure * 0.15f)).normalized();
        }
    }
};

// ============================================================================
// 3. Headless Weighted Normal Modifier
// ============================================================================

struct HeadlessWeightedNormalOptions {
    float areaWeightPower{1.0f};        // Exponent on face area
    float angleWeightPower{1.0f};       // Exponent on face corner angle
    float thresholdAngleDeg{45.0f};     // Dihedral angle cutoff for sharp edge boundary
    bool keepSharpEdges{true};
};

class HeadlessWeightedNormalModifier {
public:
    /**
     * Pure geometric operator that recalculates vertex normals using Face-Area and Face-Angle weighting.
     * Replicates Blender's Weighted Normal modifier headlessly.
     */
    static void applyWeightedNormals(
        ScratchboxMesh& mesh,
        const HeadlessWeightedNormalOptions& options = {}
    ) {
        if (mesh.vertices.empty() || mesh.indices.size() < 3) return;

        size_t numFaces = mesh.indices.size() / 3;
        std::vector<Vec3> faceNormals(numFaces);
        std::vector<float> faceAreas(numFaces);

        float thresholdCos = std::cos(options.thresholdAngleDeg * math::DEG_TO_RAD);

        for (size_t f = 0; f < numFaces; ++f) {
            uint32_t i0 = mesh.indices[f * 3];
            uint32_t i1 = mesh.indices[f * 3 + 1];
            uint32_t i2 = mesh.indices[f * 3 + 2];

            const Vec3& p0 = mesh.vertices[i0].position;
            const Vec3& p1 = mesh.vertices[i1].position;
            const Vec3& p2 = mesh.vertices[i2].position;

            Vec3 e1 = p1 - p0;
            Vec3 e2 = p2 - p0;
            Vec3 crossProd = e1.cross(e2);
            float len = crossProd.length();

            faceAreas[f] = 0.5f * len;
            faceNormals[f] = (len > 1e-8f) ? (crossProd / len) : Vec3(0, 1, 0);
        }

        // Vertex adjacent faces
        std::vector<std::vector<size_t>> vertFaces(mesh.vertices.size());
        for (size_t f = 0; f < numFaces; ++f) {
            vertFaces[mesh.indices[f * 3]].push_back(f);
            vertFaces[mesh.indices[f * 3 + 1]].push_back(f);
            vertFaces[mesh.indices[f * 3 + 2]].push_back(f);
        }

        // Accumulate weighted normals
        for (size_t v = 0; v < mesh.vertices.size(); ++v) {
            const auto& faces = vertFaces[v];
            if (faces.empty()) continue;

            const Vec3& origNormal = mesh.vertices[v].normal;
            Vec3 accum(0, 0, 0);

            for (size_t f : faces) {
                const Vec3& fNorm = faceNormals[f];
                if (options.keepSharpEdges && origNormal.dot(fNorm) < thresholdCos) {
                    continue; // Skip faces across sharp dihedral crease
                }

                // Compute corner angle at vertex v
                uint32_t i0 = mesh.indices[f * 3];
                uint32_t i1 = mesh.indices[f * 3 + 1];
                uint32_t i2 = mesh.indices[f * 3 + 2];

                const Vec3& pV = mesh.vertices[v].position;
                Vec3 otherA = (i0 == v) ? mesh.vertices[i1].position : ((i1 == v) ? mesh.vertices[i0].position : mesh.vertices[i0].position);
                Vec3 otherB = (i2 == v) ? mesh.vertices[i1].position : ((i1 == v) ? mesh.vertices[i2].position : mesh.vertices[i2].position);

                Vec3 vA = (otherA - pV).normalized();
                Vec3 vB = (otherB - pV).normalized();
                float cornerAngle = std::acos(std::clamp(vA.dot(vB), -1.0f, 1.0f));

                float weight = std::pow(std::max(1e-6f, faceAreas[f]), options.areaWeightPower) *
                               std::pow(std::max(1e-6f, cornerAngle), options.angleWeightPower);

                accum = accum + fNorm * weight;
            }

            if (accum.lengthSquared() > 1e-8f) {
                mesh.vertices[v].normal = accum.normalized();
            }
        }
    }
};

// ============================================================================
// 4. Headless Geomorphological PDE Simulator
// ============================================================================

struct ScalarField2D {
    int width{0};
    int height{0};
    float cellSize{1.0f};
    std::vector<float> data;

    ScalarField2D() = default;
    ScalarField2D(int w, int h, float cell = 1.0f, float initVal = 0.0f)
        : width(w), height(h), cellSize(cell), data(w * h, initVal) {}

    float get(int x, int y) const {
        if (x < 0 || x >= width || y < 0 || y >= height) return 0.0f;
        return data[y * width + x];
    }

    void set(int x, int y, float val) {
        if (x >= 0 && x < width && y >= 0 && y < height) {
            data[y * width + x] = val;
        }
    }

    Vec2 computeGradient(int x, int y) const {
        float hL = get(x - 1, y);
        float hR = get(x + 1, y);
        float hD = get(x, y - 1);
        float hU = get(x, y + 1);
        return Vec2((hR - hL) / (2.0f * cellSize), (hU - hD) / (2.0f * cellSize));
    }

    float computeLaplacian(int x, int y) const {
        float hC = get(x, y);
        float hL = get(x - 1, y);
        float hR = get(x + 1, y);
        float hD = get(x, y - 1);
        float hU = get(x, y + 1);
        return (hL + hR + hD + hU - 4.0f * hC) / (cellSize * cellSize);
    }
};

struct HeadlessErosionPDEParams {
    int iterations{10};
    float erodibility{0.08f};           // K constant in Stream Power law
    float sedimentCapacity{0.12f};       // kc
    float depositionRate{0.06f};         // kd
    float diffusionRate{0.015f};         // D Laplacian diffusion
    float talusReposeAngleDeg{35.0f};    // Critical scree angle
    float talusDiffusionRate{0.05f};     // Thermal scree relaxation
};

class HeadlessGeomorphologySimulator {
public:
    /**
     * Solves the continuous Stream Power Law and Talus Scree Relaxation PDEs on arbitrary 2D heightfield data.
     * dh/dt = -K * A^m * S^n + D * laplacian(h) + ScreeRelaxation(grad(h))
     */
    static void solveErosionPDE(ScalarField2D& field, const HeadlessErosionPDEParams& params) {
        if (field.width < 3 || field.height < 3) return;

        float tanRepose = std::tan(params.talusReposeAngleDeg * math::DEG_TO_RAD);
        int w = field.width;
        int h = field.height;

        std::vector<float> buffer = field.data;

        for (int iter = 0; iter < params.iterations; ++iter) {
            for (int y = 1; y < h - 1; ++y) {
                for (int x = 1; x < w - 1; ++x) {
                    Vec2 grad = field.computeGradient(x, y);
                    float slope = grad.length();
                    float laplacian = field.computeLaplacian(x, y);

                    // 1. Stream Power Erosion & Diffusion
                    float streamPowerErosion = params.erodibility * slope * field.cellSize;
                    float diffusion = params.diffusionRate * laplacian;

                    // 2. Non-linear Thermal Scree Relaxation
                    float screeExcess = std::max(0.0f, slope - tanRepose);
                    float screeRelaxation = -params.talusDiffusionRate * screeExcess * slope;

                    float deltaH = -streamPowerErosion + diffusion + screeRelaxation;

                    int idx = y * w + x;
                    buffer[idx] += deltaH;
                }
            }
            field.data = buffer;
        }
    }
};

// ============================================================================
// 5. Headless Canopy Normal Transfer Operator
// ============================================================================

struct CanopyProjectionParams {
    Vec3 proxyCenter{0.0f, 2.0f, 0.0f};
    Vec3 proxyRadii{1.5f, 2.0f, 1.5f};
    float blendFactor{0.85f};           // Blend between original card normal and proxy normal
    float skyHemisphereBias{0.25f};      // Upward tilt for atmospheric ambient illumination
};

class HeadlessCanopyNormalTransferOperator {
public:
    /**
     * Reorients foliage or hair normals radially from an ellipsoidal bounding envelope.
     * Eliminates individual card clipping/shadow-terminator artifacts and produces soft,
     * volumetric tree canopy shading.
     */
    static void transferCanopyNormals(
        ScratchboxMesh& mesh,
        const CanopyProjectionParams& params
    ) {
        if (mesh.vertices.empty()) return;

        for (auto& v : mesh.vertices) {
            // Compute vector from proxy center to vertex
            Vec3 offset = v.position - params.proxyCenter;
            Vec3 normalizedOffset(
                offset.x / std::max(1e-4f, params.proxyRadii.x),
                offset.y / std::max(1e-4f, params.proxyRadii.y),
                offset.z / std::max(1e-4f, params.proxyRadii.z)
            );

            if (normalizedOffset.lengthSquared() < 1e-6f) {
                normalizedOffset = Vec3(0, 1, 0);
            } else {
                normalizedOffset = normalizedOffset.normalized();
            }

            // Apply upward sky hemisphere bias
            normalizedOffset.y += params.skyHemisphereBias;
            normalizedOffset = normalizedOffset.normalized();

            // Blend with original surface normal
            Vec3 finalNormal = v.normal * (1.0f - params.blendFactor) + normalizedOffset * params.blendFactor;
            v.normal = finalNormal.normalized();
        }
    }
};

// ============================================================================
// 6. Headless Thin-Film Wave Optics Solver
// ============================================================================

struct ThinFilmLayer {
    float thicknessNm{380.0f};      // Film thickness in nanometers
    float nMedium{1.0f};            // Refractive index of air
    float nFilm{1.33f};             // Refractive index of oil/soap film
    float nSubstrate{1.50f};        // Refractive index of underlying glass/metal
};

class HeadlessThinFilmOpticsSolver {
public:
    /**
     * Analytical Airy equation solving continuous spectral reflectance for RGB wavelengths
     * (lambda_R = 650nm, lambda_G = 532nm, lambda_B = 450nm) at incidence angle cosTheta.
     */
    static Vec3 evaluateAiryInterference(const ThinFilmLayer& layer, float cosThetaI) {
        float sinThetaI = std::sqrt(std::max(0.0f, 1.0f - cosThetaI * cosThetaI));
        float sinThetaT = (layer.nMedium / layer.nFilm) * sinThetaI;
        if (sinThetaT >= 1.0f) return Vec3(1.0f, 1.0f, 1.0f); // Total internal reflection

        float cosThetaT = std::sqrt(std::max(0.0f, 1.0f - sinThetaT * sinThetaT));

        // Optical path difference: delta = 2 * nFilm * d * cos(theta_t)
        float opd = 2.0f * layer.nFilm * layer.thicknessNm * cosThetaT;

        // Fresnel coefficients at interfaces
        float r12 = (layer.nMedium - layer.nFilm) / (layer.nMedium + layer.nFilm);
        float r23 = (layer.nFilm - layer.nSubstrate) / (layer.nFilm + layer.nSubstrate);

        auto computeReflectance = [&](float lambdaNm) -> float {
            float phaseShift = (2.0f * math::PI * opd) / lambdaNm;
            // Phase change on reflection if n1 < n2
            if (layer.nMedium < layer.nFilm) phaseShift += math::PI;
            if (layer.nFilm < layer.nSubstrate) phaseShift += math::PI;

            float cosDelta = std::cos(phaseShift);
            float num = r12 * r12 + r23 * r23 + 2.0f * r12 * r23 * cosDelta;
            float denom = 1.0f + r12 * r12 * r23 * r23 + 2.0f * r12 * r23 * cosDelta;
            return std::clamp(num / std::max(1e-6f, denom), 0.0f, 1.0f);
        };

        return Vec3(
            computeReflectance(650.0f), // Red
            computeReflectance(532.0f), // Green
            computeReflectance(450.0f)  // Blue
        );
    }
};

// ============================================================================
// 7. Headless Photometric & Blackbody Radiance Solver
// ============================================================================

class HeadlessPhotometricSolver {
public:
    /**
     * Evaluates continuous blackbody Planck radiation from Kelvin temperature (1000K to 25000K)
     * into normalized linear RGB. Decoupled from fixed preset tables.
     */
    static Vec3 blackbodyKelvinToLinearRgb(float kelvin) {
        float temp = std::clamp(kelvin, 1000.0f, 25000.0f) / 100.0f;
        float r, g, b;

        // Red channel
        if (temp <= 66.0f) {
            r = 1.0f;
        } else {
            float val = temp - 60.0f;
            r = 329.698727446f * std::pow(val, -0.1332047592f) / 255.0f;
            r = std::clamp(r, 0.0f, 1.0f);
        }

        // Green channel
        if (temp <= 66.0f) {
            float val = temp;
            g = (99.4708025861f * std::log(val) - 161.1195681661f) / 255.0f;
            g = std::clamp(g, 0.0f, 1.0f);
        } else {
            float val = temp - 60.0f;
            g = 288.1221695283f * std::pow(val, -0.0755148492f) / 255.0f;
            g = std::clamp(g, 0.0f, 1.0f);
        }

        // Blue channel
        if (temp >= 66.0f) {
            b = 1.0f;
        } else if (temp <= 19.0f) {
            b = 0.0f;
        } else {
            float val = temp - 10.0f;
            b = (138.5177312231f * std::log(val) - 305.0447927307f) / 255.0f;
            b = std::clamp(b, 0.0f, 1.0f);
        }

        // Linearize sRGB to linear radiometric space
        auto srgbToLinear = [](float c) {
            return (c <= 0.04045f) ? (c / 12.92f) : std::pow((c + 0.055f) / 1.055f, 2.4f);
        };

        return Vec3(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
    }

    /**
     * Evaluates continuous analytical gobo cookie attenuation.
     * mode 0: Foliage canopy shadow noise
     * mode 1: Venetian blinds harmonic grating
     */
    static float evaluateAnalyticalGobo(float u, float v, float timeSeconds, int mode = 0, float frequency = 4.0f) {
        if (mode == 0) {
            // Foliage canopy: turbulent multi-frequency wind modulation
            float windU = u + 0.04f * std::sin(timeSeconds * 1.5f + v * 3.0f);
            float windV = v + 0.03f * std::cos(timeSeconds * 1.2f + u * 2.5f);
            float n1 = 0.5f * (1.0f + std::sin(windU * frequency * 6.283f) * std::cos(windV * frequency * 6.283f));
            float n2 = 0.5f * (1.0f + std::sin(windU * frequency * 13.7f + 1.2f) * std::sin(windV * frequency * 11.3f));
            float canopy = n1 * 0.6f + n2 * 0.4f;
            return math::smoothstep(0.35f, 0.65f, canopy);
        } else {
            // Venetian blinds: periodic harmonic slit grating
            float slit = std::sin(v * frequency * 2.0f * math::PI);
            return math::smoothstep(-0.2f, 0.3f, slit);
        }
    }
};

// ============================================================================
// 8. Headless Dynamic Gravity Moisture Runoff & Capillary Advection Operator
// ============================================================================

struct MoistureRunoffParams {
    Vec3 gravityDirection = Vec3(0.0f, -1.0f, 0.0f);
    float runoffIntensity = 0.6f;
    float creviceAccumulation = 0.8f;
    float rainStreakFrequency = 14.0f;
    float wetDarkeningFactor = 0.45f;
    float specularRoughness = 0.03f;
};

struct MoistureRunoffResult {
    std::vector<float> moistureLevels;
    float averageMoisture = 0.0f;
};

class HeadlessMoistureRunoffOperator {
public:
    /**
     * Simulates gravitational moisture advection, capillary pooling in concave crevices,
     * and porous wet albedo darkening coupled with specular highlight smoothing.
     */
    static MoistureRunoffResult applyMoistureRunoff(
        ScratchboxMesh& mesh,
        const MoistureRunoffParams& params = MoistureRunoffParams()
    ) {
        MoistureRunoffResult result;
        size_t vCount = mesh.vertices.size();
        result.moistureLevels.resize(vCount, 0.0f);
        if (vCount == 0) return result;

        CurvatureTensorField curvs = HeadlessDifferentialCurvatureOperator::evaluateCurvatureField(mesh);
        Vec3 g = params.gravityDirection.normalized();
        float totalM = 0.0f;

        for (size_t i = 0; i < vCount; ++i) {
            auto& v = mesh.vertices[i];
            Vec3 n = v.normal.normalized();

            // Downward slope advection vector v_flow = g - (g . n)n
            float gDotN = g.dot(n);
            Vec3 vFlow = g - n * gDotN;
            float slopeMagnitude = vFlow.length();

            // Capillary pooling in crevices (Shape Index S < 0)
            float S = (i < curvs.shapeIndex.size()) ? curvs.shapeIndex[i] : 0.0f;
            float crevicePool = (S < 0.0f) ? (-S * params.creviceAccumulation) : 0.0f;

            // Gravitational streak harmonic modulation along surface
            Vec3 tPerp = vFlow.cross(n);
            if (tPerp.lengthSq() > 1e-6f) tPerp = tPerp.normalized();
            else tPerp = Vec3(1, 0, 0);

            float streakNoise = 0.5f * (1.0f + std::sin(v.position.dot(tPerp) * params.rainStreakFrequency) *
                                              std::cos(v.position.dot(g) * (params.rainStreakFrequency * 0.7f)));

            // Moisture scalar w in [0, 1]
            float runoffWeight = slopeMagnitude * (streakNoise * 0.4f + 0.6f) * params.runoffIntensity;
            float w = std::clamp(crevicePool + runoffWeight, 0.0f, 1.0f);
            result.moistureLevels[i] = w;
            totalM += w;

            // Albedo darkening from internal Fresnel scattering in porous wet media
            float darken = 1.0f - (w * params.wetDarkeningFactor);
            v.color.x = std::clamp(v.color.x * darken, 0.0f, 1.0f);
            v.color.y = std::clamp(v.color.y * darken, 0.0f, 1.0f);
            v.color.z = std::clamp(v.color.z * darken, 0.0f, 1.0f);
        }

        result.averageMoisture = totalM / static_cast<float>(vCount);
        return result;
    }
};

// ============================================================================
// 9. Headless Analytical Edge-Normal Fillet Bevel Operator
// ============================================================================

struct EdgeFilletBevelParams {
    float thresholdAngleDeg = 35.0f;
    float maxAngleDeg = 150.0f;
    float filletSharpness = 2.0f;
};

class HeadlessEdgeFilletBevelOperator {
public:
    /**
     * Synthesizes soft specular cylindrical fillet normal transitions on hard-surface
     * creases, catching highlights without requiring polygon subdivision.
     */
    static void applyEdgeFilletBevel(
        ScratchboxMesh& mesh,
        const EdgeFilletBevelParams& params = EdgeFilletBevelParams()
    ) {
        size_t vCount = mesh.vertices.size();
        if (vCount == 0 || mesh.indices.size() < 3) return;

        size_t triCount = mesh.indices.size() / 3;
        std::vector<Vec3> faceNormals(triCount);
        std::vector<std::vector<size_t>> vertFaces(vCount);

        for (size_t t = 0; t < triCount; ++t) {
            uint32_t i0 = mesh.indices[t * 3];
            uint32_t i1 = mesh.indices[t * 3 + 1];
            uint32_t i2 = mesh.indices[t * 3 + 2];

            if (i0 < vCount && i1 < vCount && i2 < vCount) {
                vertFaces[i0].push_back(t);
                vertFaces[i1].push_back(t);
                vertFaces[i2].push_back(t);

                Vec3 e1 = mesh.vertices[i1].position - mesh.vertices[i0].position;
                Vec3 e2 = mesh.vertices[i2].position - mesh.vertices[i0].position;
                Vec3 fn = e1.cross(e2);
                if (fn.lengthSq() > 1e-8f) fn = fn.normalized();
                else fn = Vec3(0, 1, 0);
                faceNormals[t] = fn;
            }
        }

        float cosMin = std::cos((params.maxAngleDeg * math::PI) / 180.0f);
        float cosMax = std::cos((params.thresholdAngleDeg * math::PI) / 180.0f);

        for (size_t v = 0; v < vCount; ++v) {
            const auto& faces = vertFaces[v];
            if (faces.size() < 2) continue;

            Vec3 origN = mesh.vertices[v].normal;
            Vec3 blendedN(0, 0, 0);
            float totalW = 0.0f;

            for (size_t fA : faces) {
                const Vec3& nA = faceNormals[fA];
                for (size_t fB : faces) {
                    if (fA >= fB) continue;
                    const Vec3& nB = faceNormals[fB];
                    float dotProd = std::clamp(nA.dot(nB), -1.0f, 1.0f);

                    // Check if dihedral angle falls in bevel fillet range
                    if (dotProd >= cosMin && dotProd <= cosMax) {
                        float angle = std::acos(dotProd);
                        float w = std::pow(angle, params.filletSharpness);
                        blendedN = blendedN + (nA + nB) * (0.5f * w);
                        totalW += w;
                    }
                }
            }

            if (totalW > 1e-4f && blendedN.lengthSq() > 1e-6f) {
                blendedN = blendedN.normalized();
                mesh.vertices[v].normal = blendedN;
            } else if (origN.lengthSq() > 1e-6f) {
                mesh.vertices[v].normal = origN.normalized();
            }
        }
    }
};

// ============================================================================
// 10. Headless AgX Photographic Color Management & Gamut Inset Operator
// ============================================================================

struct AgXParams {
    float exposure = 1.0f;
    float saturation = 1.0f;
    float minEv = -12.47393f;
    float maxEv = 4.026069f;
};

class HeadlessAgXTonemappingOperator {
public:
    /**
     * Blender 4.0 AgX photographic log tone reproduction curve.
     * Compresses HDR luminance via gamut inset primaries, eliminating ACES cyan highlight clipping.
     */
    static Vec3 evaluateAgX(const Vec3& linearRgb, const AgXParams& params = AgXParams()) {
        Vec3 c = linearRgb * params.exposure;
        c.x = std::max(1e-6f, c.x);
        c.y = std::max(1e-6f, c.y);
        c.z = std::max(1e-6f, c.z);

        // 1. AgX Inset Primary Matrix (Compresses Rec.709 into safe working gamut)
        Vec3 inset(
            0.842479f * c.x + 0.0784336f * c.y + 0.0792237f * c.z,
            0.0637613f * c.x + 0.878481f * c.y + 0.0577577f * c.z,
            0.0408752f * c.x + 0.0882901f * c.y + 0.870835f * c.z
        );

        // 2. AgX Log2 Encoding
        auto logEncode = [&](float val) {
            float logVal = std::log2(std::max(1e-5f, val));
            return std::clamp((logVal - params.minEv) / (params.maxEv - params.minEv), 0.0f, 1.0f);
        };

        Vec3 logRgb(logEncode(inset.x), logEncode(inset.y), logEncode(inset.z));

        // 3. Sigmoidal Tone Curve & Smooth Highlight Desaturation Roll-off
        auto agxCurve = [](float x) {
            float x2 = x * x;
            float x4 = x2 * x2;
            return 15.5f * x4 * x2 - 40.14f * x4 * x + 31.96f * x4 - 6.868f * x2 * x + 0.429f * x2 + 0.1144f * x;
        };

        Vec3 curved(
            std::clamp(agxCurve(logRgb.x), 0.0f, 1.0f),
            std::clamp(agxCurve(logRgb.y), 0.0f, 1.0f),
            std::clamp(agxCurve(logRgb.z), 0.0f, 1.0f)
        );

        // 4. AgX Outset Primary Matrix (Return to Linear Display RGB)
        Vec3 display(
            1.19688f * curved.x - 0.052897f * curved.y - 0.143983f * curved.z,
            -0.098834f * curved.x + 1.15198f * curved.y - 0.053146f * curved.z,
            -0.099701f * curved.x - 0.098863f * curved.y + 1.19856f * curved.z
        );

        // High-luminance desaturation: highlights gracefully roll off to pure white
        float luma = 0.2126f * display.x + 0.7152f * display.y + 0.0722f * display.z;
        float desatFactor = math::smoothstep(0.85f, 1.0f, luma);
        Vec3 out = display * (1.0f - desatFactor) + Vec3(luma, luma, luma) * desatFactor;

        return Vec3(
            std::clamp(out.x, 0.0f, 1.0f),
            std::clamp(out.y, 0.0f, 1.0f),
            std::clamp(out.z, 0.0f, 1.0f)
        );
    }
};

} // namespace realism
} // namespace scratchbox

#endif // SCRATCHBOX_HEADLESS_REALISM_HPP
