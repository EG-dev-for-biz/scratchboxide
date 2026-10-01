/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_IBL_HPP
#define SCRATCHBOX_IBL_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <cmath>
#include <algorithm>

namespace scratchbox {
namespace ibl {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;

// ============================================================================
// 1. Order-3 (9-Coefficient) Spherical Harmonics Diffuse Irradiance
// ============================================================================

/**
 * 9 RGB coefficients representing order-3 Spherical Harmonics (L <= 2)
 * for real-time diffuse environment irradiance (Ramamoorthi & Hanrahan 2001).
 * Convolved with the cosine lobe: A_0 = pi, A_1 = 2*pi/3, A_2 = pi/4.
 */
struct SphericalHarmonics9 {
    Vec3 L[9]; // L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22

    SphericalHarmonics9() {
        for (int i = 0; i < 9; ++i) L[i] = Vec3(0, 0, 0);
    }

    /**
     * Evaluates diffuse irradiance E(n) for a unit surface normal vector n = (x, y, z).
     * Returns linear HDR irradiance.
     */
    Vec3 evaluateIrradiance(const Vec3& normal) const {
        Vec3 n = normal.normalized();
        float x = n.x;
        float y = n.y;
        float z = n.z;

        // Polynomial constants from Ramamoorthi & Hanrahan
        constexpr float c1 = 0.429043f;
        constexpr float c2 = 0.511664f;
        constexpr float c3 = 0.743125f;
        constexpr float c4 = 0.886227f;
        constexpr float c5 = 0.247708f;

        Vec3 irradiance =
            L[8] * (c1 * (x * x - y * y)) +
            L[6] * (c3 * z * z) +
            L[0] * c4 -
            L[6] * c5 +
            (L[4] * (x * y) + L[7] * (x * z) + L[5] * (y * z)) * (2.0f * c1) +
            (L[3] * x + L[1] * y + L[2] * z) * (2.0f * c2);

        return Vec3(
            std::max(0.0f, irradiance.x),
            std::max(0.0f, irradiance.y),
            std::max(0.0f, irradiance.z)
        );
    }

    // Calibrated atmospheric physical environment presets
    static SphericalHarmonics9 goldenHour() {
        SphericalHarmonics9 sh;
        sh.L[0] = Vec3(0.95f, 0.65f, 0.45f);  // L00: Warm ambient
        sh.L[1] = Vec3(0.12f, 0.10f, 0.20f);  // L1-1: Up-down sky gradient
        sh.L[2] = Vec3(0.05f, 0.04f, 0.08f);  // L10: Horizon fill
        sh.L[3] = Vec3(0.65f, 0.38f, 0.15f);  // L11: Low sun azimuth
        sh.L[4] = Vec3(0.08f, 0.05f, 0.02f);  // L2-2
        sh.L[5] = Vec3(0.04f, 0.03f, 0.02f);  // L2-1
        sh.L[6] = Vec3(0.18f, 0.12f, 0.06f);  // L20
        sh.L[7] = Vec3(0.15f, 0.09f, 0.04f);  // L21
        sh.L[8] = Vec3(0.10f, 0.06f, 0.02f);  // L22
        return sh;
    }

    static SphericalHarmonics9 clearDaylight() {
        SphericalHarmonics9 sh;
        sh.L[0] = Vec3(0.75f, 0.85f, 1.05f);  // L00: Azure sky dome
        sh.L[1] = Vec3(0.40f, 0.45f, 0.60f);  // L1-1: High zenith luminance
        sh.L[2] = Vec3(0.08f, 0.08f, 0.10f);  // L10
        sh.L[3] = Vec3(0.35f, 0.35f, 0.28f);  // L11: Solar key direction
        sh.L[4] = Vec3(0.05f, 0.06f, 0.08f);  // L2-2
        sh.L[5] = Vec3(0.04f, 0.05f, 0.07f);  // L2-1
        sh.L[6] = Vec3(0.12f, 0.14f, 0.18f);  // L20
        sh.L[7] = Vec3(0.08f, 0.09f, 0.11f);  // L21
        sh.L[8] = Vec3(0.06f, 0.07f, 0.09f);  // L22
        return sh;
    }

    static SphericalHarmonics9 overcastStudio() {
        SphericalHarmonics9 sh;
        sh.L[0] = Vec3(0.80f, 0.82f, 0.85f);
        sh.L[1] = Vec3(0.20f, 0.21f, 0.22f);
        sh.L[2] = Vec3(0.02f, 0.02f, 0.02f);
        sh.L[3] = Vec3(0.05f, 0.05f, 0.06f);
        sh.L[4] = Vec3(0.02f, 0.02f, 0.02f);
        sh.L[5] = Vec3(0.01f, 0.01f, 0.01f);
        sh.L[6] = Vec3(0.08f, 0.08f, 0.09f);
        sh.L[7] = Vec3(0.03f, 0.03f, 0.03f);
        sh.L[8] = Vec3(0.02f, 0.02f, 0.02f);
        return sh;
    }

    static SphericalHarmonics9 cyberpunkNeon() {
        SphericalHarmonics9 sh;
        sh.L[0] = Vec3(0.40f, 0.20f, 0.60f);  // Neon purple ambient
        sh.L[1] = Vec3(-0.30f, 0.15f, 0.45f); // Violet up-vector
        sh.L[2] = Vec3(0.10f, 0.40f, 0.60f);  // Cyan horizon
        sh.L[3] = Vec3(0.60f, 0.10f, 0.50f);  // Hot magenta side key
        sh.L[4] = Vec3(0.15f, 0.05f, 0.20f);
        sh.L[5] = Vec3(-0.10f, 0.20f, 0.15f);
        sh.L[6] = Vec3(0.12f, 0.08f, 0.25f);
        sh.L[7] = Vec3(0.20f, 0.05f, 0.18f);
        sh.L[8] = Vec3(0.18f, 0.12f, 0.22f);
        return sh;
    }

    /**
     * Filament cmgen-style analytical projection:
     * Projects any equirectangular HDR/linear RGB radiance map into 9 Spherical Harmonic coefficients.
     * Integrates over the sphere using solid angle dOmega = sin(theta) * dTheta * dPhi.
     */
    static SphericalHarmonics9 projectEquirectangular(
        const float* rgbData,
        int width,
        int height,
        int channels = 3
    ) {
        SphericalHarmonics9 sh;
        if (!rgbData || width <= 0 || height <= 0) return sh;

        constexpr float PI = 3.14159265358979323846f;
        float dTheta = PI / static_cast<float>(height);
        float dPhi = (2.0f * PI) / static_cast<float>(width);

        for (int v = 0; v < height; ++v) {
            float theta = (static_cast<float>(v) + 0.5f) * dTheta;
            float sinTheta = std::sin(theta);
            float cosTheta = std::cos(theta);
            float dOmega = sinTheta * dTheta * dPhi;

            for (int u = 0; u < width; ++u) {
                float phi = (static_cast<float>(u) + 0.5f) * dPhi;
                float sinPhi = std::sin(phi);
                float cosPhi = std::cos(phi);

                // Cartesian direction vector (Y-up convention)
                float x = -sinTheta * sinPhi;
                float y = cosTheta;
                float z = -sinTheta * cosPhi;

                // Spherical harmonics basis functions Y_lm for L <= 2 (Ramamoorthi & Hanrahan / Filament cmgen)
                float Y[9];
                Y[0] = 0.282095f;                               // Y00
                Y[1] = 0.488603f * y;                           // Y1-1
                Y[2] = 0.488603f * z;                           // Y10
                Y[3] = 0.488603f * x;                           // Y11
                Y[4] = 1.092548f * x * y;                       // Y2-2
                Y[5] = 1.092548f * y * z;                       // Y2-1
                Y[6] = 0.315392f * (3.0f * z * z - 1.0f);       // Y20
                Y[7] = 1.092548f * x * z;                       // Y21
                Y[8] = 0.546274f * (x * x - y * y);             // Y22

                int idx = (v * width + u) * channels;
                Vec3 radiance(rgbData[idx], rgbData[idx + 1], rgbData[idx + 2]);

                Vec3 weightedRadiance = radiance * dOmega;
                for (int i = 0; i < 9; ++i) {
                    sh.L[i] = sh.L[i] + weightedRadiance * Y[i];
                }
            }
        }

        return sh;
    }
};

// ============================================================================
// 2. Brian Karis / Epic Games Split-Sum Specular Environment Approximation
// ============================================================================

/**
 * Analytical approximation of the 2D Environment BRDF LUT by Brian Karis (Epic Games / UE4/UE5).
 * Maps (NdotV, roughness) to (scale, bias) where specular reflection = prefilteredColor * (F0 * scale + bias).
 */
inline Vec2 integrateBRDF(float NdotV, float roughness) {
    const Vec4 c0(-1.0f, -0.0275f, -0.572f, 0.022f);
    const Vec4 c1(1.0f, 0.0425f, 1.04f, -0.04f);
    Vec4 r = Vec4(
        roughness * c0.x + c1.x,
        roughness * c0.y + c1.y,
        roughness * c0.z + c1.z,
        roughness * c0.w + c1.w
    );
    float a004 = std::min(r.x * r.x, std::exp2(-9.28f * NdotV)) * r.x + r.y;
    Vec2 AB = Vec2(-1.04f, 1.04f) * a004 + Vec2(r.z, r.w);
    return Vec2(std::clamp(AB.x, 0.0f, 1.0f), std::clamp(AB.y, 0.0f, 1.0f));
}

/**
 * Evaluates split-sum specular environment lighting from reflection vector R,
 * view angle NdotV, surface roughness, and dielectric/metallic F0.
 */
inline Vec3 evaluateSplitSumSpecular(
    const Vec3& N,
    const Vec3& V,
    float roughness,
    const Vec3& F0,
    const SphericalHarmonics9& envSH,
    float envIntensity = 1.0f
) {
    float NdotV = std::max(0.001f, N.dot(V));
    Vec3 R = (N * (2.0f * NdotV) - V).normalized();

    // Sample prefiltered radiance in reflection direction R, convolved by roughness
    Vec3 prefilteredRadiance = envSH.evaluateIrradiance(R) * envIntensity;

    // Convolve with roughness: smooth surfaces retain sharp directional peaks
    float sharpness = (1.0f - roughness);
    prefilteredRadiance = prefilteredRadiance * (1.0f + sharpness * 0.8f);

    Vec2 envBrdf = integrateBRDF(NdotV, roughness);
    Vec3 specular = prefilteredRadiance * (F0 * envBrdf.x + Vec3(envBrdf.y, envBrdf.y, envBrdf.y));

    return specular;
}

// ============================================================================
// 3. ACES Filmic Tonemapping Curve & Optical Post-Processing
// ============================================================================

/**
 * Academy Color Encoding System (ACES) filmic tonemapping curve (Krzysztof Narkowicz 2015 fit).
 * Preserves high specular dynamic range, prevents color clipping/blowout, and ensures cinematic contrast.
 */
inline Vec3 acesFilmic(const Vec3& color, float exposure = 1.0f) {
    Vec3 x = color * exposure;
    constexpr float a = 2.51f;
    constexpr float b = 0.03f;
    constexpr float c = 2.43f;
    constexpr float d = 0.59f;
    constexpr float e = 0.14f;

    auto curve = [a, b, c, d, e](float v) -> float {
        return std::clamp((v * (a * v + b)) / (v * (c * v + d) + e), 0.0f, 1.0f);
    };

    return Vec3(curve(x.x), curve(x.y), curve(x.z));
}

/**
 * Optical lens vignette falloff towards screen borders.
 */
inline Vec3 applyVignette(const Vec3& color, const Vec2& uv, float intensity = 0.35f) {
    Vec2 centered = (uv - Vec2(0.5f, 0.5f)) * 2.0f;
    float distSq = centered.x * centered.x + centered.y * centered.y;
    float vignette = 1.0f - distSq * intensity;
    vignette = std::clamp(vignette, 0.0f, 1.0f);
    return color * vignette;
}

} // namespace ibl
} // namespace scratchbox

#endif // SCRATCHBOX_IBL_HPP
