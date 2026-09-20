/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_VOLUMETRICS_HPP
#define SCRATCHBOX_VOLUMETRICS_HPP

#include "scratchbox_math.hpp"
#include <cmath>
#include <algorithm>
#include <array>
#include <vector>

namespace scratchbox {
namespace volumetrics {

using math::Vec2;
using math::Vec3;
using math::Vec4;

/**
 * Atmospheric & Fog Medium Parameters
 */
struct VolumetricMedium {
    Vec3 scatteringColor{0.95f, 0.88f, 0.72f}; // Warm solar haze
    float density{0.035f};                     // Extinction coefficient (sigma_t)
    float scatteringAlbedo{0.90f};             // Ratio of scattering vs absorption (sigma_s / sigma_t)
    float anisotropy{0.72f};                   // Henyey-Greenstein g factor (0.7-0.8 for strong god rays)
    float groundLevel{0.0f};                   // Sea level height
    float heightScale{4.0f};                   // Exponential atmospheric scale height
};

/**
 * Single-lobe Henyey-Greenstein Phase Function.
 * g > 0: Forward scattering (sunbeams / god rays)
 * g = 0: Isotropic scattering
 * g < 0: Back-scattering
 */
inline float henyeyGreensteinPhase(float cosTheta, float g) {
    float g2 = g * g;
    float denom = 1.0f + g2 - 2.0f * g * cosTheta;
    if (denom <= 0.0f) return 0.0f;
    return (1.0f - g2) / (4.0f * math::PI * std::pow(denom, 1.5f));
}

/**
 * Rayleigh Phase Function for clean molecular atmospheric scattering (sky blue haze).
 */
inline float rayleighPhase(float cosTheta) {
    return (3.0f / (16.0f * math::PI)) * (1.0f + cosTheta * cosTheta);
}

/**
 * Dual-lobe phase function blending forward Mie scattering (aerosols/dust) with backward halo.
 */
inline float dualLobePhase(float cosTheta, float gForward = 0.75f, float gBackward = -0.25f, float blendWeight = 0.85f) {
    return blendWeight * henyeyGreensteinPhase(cosTheta, gForward) +
           (1.0f - blendWeight) * henyeyGreensteinPhase(cosTheta, gBackward);
}

/**
 * Evaluates exponential height-dependent atmospheric medium density.
 */
inline float evaluateDensityAtHeight(float y, const VolumetricMedium& medium) {
    float h = std::max(0.0f, y - medium.groundLevel);
    return medium.density * std::exp(-h / medium.heightScale);
}

/**
 * Volumetric In-Scattering Raymarcher.
 * Marches through participating media along ray (ro -> rd) towards maxDistance,
 * accumulating in-scattered light and computing optical transmittance (Beer-Lambert).
 */
struct VolumetricResult {
    Vec3 inscatteredRadiance{0, 0, 0};
    float transmittance{1.0f};
};

inline VolumetricResult marchVolumetrics(
    const Vec3& ro,
    const Vec3& rd,
    float maxDist,
    const Vec3& lightPos,
    const Vec3& lightColor,
    float lightIntensity,
    const VolumetricMedium& medium,
    int numSteps = 24
) {
    float stepSize = maxDist / static_cast<float>(numSteps);
    float cosTheta = rd.dot((lightPos - ro).normalized());
    float phase = dualLobePhase(cosTheta, medium.anisotropy, -0.2f, 0.85f);

    Vec3 accumulatedInscatter = {0, 0, 0};
    float transmittance = 1.0f;

    for (int i = 0; i < numSteps; ++i) {
        float t = (static_cast<float>(i) + 0.5f) * stepSize;
        Vec3 samplePos = ro + rd * t;

        float localDensity = evaluateDensityAtHeight(samplePos.y, medium);
        if (localDensity <= 1e-5f) continue;

        // Optical depth attenuation of the step itself
        float stepOpticalDepth = localDensity * stepSize;
        float stepTransmittance = std::exp(-stepOpticalDepth);

        // Vector to light source
        Vec3 toLight = lightPos - samplePos;
        float distToLight = toLight.length();
        Vec3 lightDir = toLight / std::max(1e-4f, distToLight);

        // Distance light attenuation
        float lightAtten = lightIntensity / (1.0f + 0.1f * distToLight * distToLight);

        // In-scattering radiance slice
        Vec3 inscatterSlice = medium.scatteringColor * lightColor * (lightAtten * phase * medium.scatteringAlbedo * localDensity);

        // Integrate via Riemann sum
        accumulatedInscatter += inscatterSlice * (transmittance * (1.0f - stepTransmittance));
        transmittance *= stepTransmittance;

        if (transmittance < 0.01f) break;
    }

    return {accumulatedInscatter, transmittance};
}

/**
 * 9-Coefficient Order-3 Spherical Harmonics for Irradiance Caching (Image-Based Lighting).
 */
struct SphericalHarmonics9 {
    std::array<Vec3, 9> coeffs;

    /**
     * Evaluates diffuse ambient irradiance for any surface normal using Ravi Ramamoorthi's formula.
     */
    Vec3 evaluateIrradiance(const Vec3& normal) const {
        Vec3 n = normal.normalized();
        float x = n.x, y = n.y, z = n.z;

        // Constant factors for L0, L1, L2 polynomials
        constexpr float c1 = 0.429043f;
        constexpr float c2 = 0.511664f;
        constexpr float c3 = 0.743125f;
        constexpr float c4 = 0.886227f;
        constexpr float c5 = 0.247708f;

        Vec3 col = coeffs[0] * c4 - coeffs[6] * c5 +
                   coeffs[6] * (c3 * z * z) +
                   (coeffs[8] * (x * x - y * y) + coeffs[4] * (2.0f * x * y) + coeffs[7] * (2.0f * x * z) + coeffs[5] * (2.0f * y * z)) * c1 +
                   (coeffs[3] * x + coeffs[1] * y + coeffs[2] * z) * (2.0f * c2);

        return {
            std::max(0.0f, col.x),
            std::max(0.0f, col.y),
            std::max(0.0f, col.z)
        };
    }
};

/**
 * Pre-calibrated Golden Hour Sky HDR Spherical Harmonics
 */
inline SphericalHarmonics9 getSkyGoldenHourSH() {
    SphericalHarmonics9 sh;
    sh.coeffs[0] = {0.79f, 0.62f, 0.45f}; // L00
    sh.coeffs[1] = {0.39f, 0.35f, 0.22f}; // L1-1
    sh.coeffs[2] = {0.21f, 0.24f, 0.30f}; // L10
    sh.coeffs[3] = {0.14f, 0.12f, 0.08f}; // L11
    sh.coeffs[4] = {0.02f, 0.02f, 0.01f}; // L2-2
    sh.coeffs[5] = {0.06f, 0.07f, 0.08f}; // L2-1
    sh.coeffs[6] = {0.12f, 0.10f, 0.06f}; // L20
    sh.coeffs[7] = {0.04f, 0.03f, 0.02f}; // L21
    sh.coeffs[8] = {0.08f, 0.06f, 0.03f}; // L22
    return sh;
}

/**
 * Pre-calibrated Overcast Forest Sky HDR Spherical Harmonics
 */
inline SphericalHarmonics9 getSkyForestCanopySH() {
    SphericalHarmonics9 sh;
    sh.coeffs[0] = {0.42f, 0.52f, 0.38f};
    sh.coeffs[1] = {0.18f, 0.25f, 0.15f};
    sh.coeffs[2] = {0.25f, 0.30f, 0.22f};
    sh.coeffs[3] = {0.08f, 0.10f, 0.07f};
    sh.coeffs[4] = {0.01f, 0.02f, 0.01f};
    sh.coeffs[5] = {0.03f, 0.04f, 0.03f};
    sh.coeffs[6] = {0.07f, 0.09f, 0.06f};
    sh.coeffs[7] = {0.02f, 0.03f, 0.02f};
    sh.coeffs[8] = {0.04f, 0.05f, 0.03f};
    return sh;
}

} // namespace volumetrics
} // namespace scratchbox

#endif // SCRATCHBOX_VOLUMETRICS_HPP
