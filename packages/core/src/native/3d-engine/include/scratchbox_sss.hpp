/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SSS_HPP
#define SCRATCHBOX_SSS_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <cmath>
#include <algorithm>
#include <vector>

namespace scratchbox {
namespace sss {

using math::Vec2;
using math::Vec3;
using math::Vec4;

/**
 * Physical Subsurface Scattering Material Profiles
 */
struct SSSProfile {
    const char* name;
    Vec3 surfaceAlbedo;    // Unscattered surface reflectance
    Vec3 scatterRadius;    // Mean Free Path (d) in mm / scene units per RGB channel
    Vec3 transmissionTint; // Deep tissue transmission absorption color
    float scatteringWeight;// Weight blend [0, 1] between standard diffuse and SSS
    float anisotropy;      // Phase function eccentricity (-1 to 1)
};

inline const SSSProfile PROFILE_HUMAN_SKIN = {
    "Human Skin",
    {0.84f, 0.65f, 0.55f},
    {3.67f, 1.37f, 0.68f},
    {0.92f, 0.28f, 0.15f}, // Rich red hemoglobin sub-dermis
    0.85f,
    0.70f
};

inline const SSSProfile PROFILE_GREEN_LEAF = {
    "Translucent Foliage",
    {0.32f, 0.68f, 0.18f},
    {0.85f, 2.80f, 0.45f},
    {0.48f, 0.88f, 0.12f}, // Bright backlit chlorophyll glow
    0.90f,
    0.65f
};

inline const SSSProfile PROFILE_WHITE_MARBLE = {
    "Translucent Marble",
    {0.88f, 0.88f, 0.86f},
    {2.19f, 1.88f, 1.32f},
    {0.95f, 0.92f, 0.88f},
    0.75f,
    0.30f
};

inline const SSSProfile PROFILE_CANDLE_WAX = {
    "Paraffin Candle Wax",
    {0.90f, 0.86f, 0.76f},
    {3.12f, 2.42f, 1.48f},
    {0.98f, 0.75f, 0.35f}, // Warm golden interior glow
    0.95f,
    0.80f
};

inline const SSSProfile PROFILE_JADE = {
    "Imperial Green Jade",
    {0.45f, 0.78f, 0.52f},
    {0.35f, 1.25f, 0.55f},
    {0.25f, 0.85f, 0.40f},
    0.88f,
    0.50f
};

/**
 * Burley (Disney) Normalized Diffusion Dipole profile R(r).
 * Produces smooth subsurface falloff with physically plausible energy conservation.
 */
inline Vec3 evaluateBurleyDiffusion(float r, const Vec3& d, const Vec3& albedo) {
    auto evalChannel = [](float dist, float meanFreePath, float A) {
        if (meanFreePath < 1e-4f || dist < 1e-5f) return A;
        float s = dist / meanFreePath;
        // Burley 2015 Normalized Diffusion: R(r) = A / (8*pi*r*d) * (e^-s + e^(-s/3))
        float profile = (std::exp(-s) + std::exp(-s / 3.0f)) / (8.0f * math::PI * dist * meanFreePath);
        return A * profile;
    };

    return {
        evalChannel(r, d.x, albedo.x),
        evalChannel(r, d.y, albedo.y),
        evalChannel(r, d.z, albedo.z)
    };
}

/**
 * Forward Translucency & Back-Scattering for thin geometry (leaves, ears, marble fins).
 * Evaluates light entering the back of a surface and diffusing forward toward the camera.
 */
inline Vec3 evaluateBackscatterTranslucency(
    const Vec3& L,           // Light vector (towards light source)
    const Vec3& V,           // View vector (towards camera)
    const Vec3& N,           // Surface normal
    float thickness,         // Local geometric thickness
    const SSSProfile& profile,
    float distortion = 0.25f
) {
    // Distort normal along view vector to simulate internal refraction
    Vec3 backNormal = -(N + V * distortion).normalized();
    float forwardScatterDot = std::max(0.0f, L.dot(backNormal));

    // Henyey-Greenstein forward phase concentration
    float g = profile.anisotropy;
    float phase = (1.0f - g * g) / (4.0f * math::PI * std::pow(1.0f + g * g - 2.0f * g * forwardScatterDot, 1.5f));

    // Beer-Lambert exponential depth attenuation per color channel
    auto evalTransmission = [](float thick, float d) {
        float effectiveD = std::max(0.01f, d * 0.5f);
        return std::exp(-thick / effectiveD);
    };

    Vec3 attenuation = {
        evalTransmission(thickness, profile.scatterRadius.x),
        evalTransmission(thickness, profile.scatterRadius.y),
        evalTransmission(thickness, profile.scatterRadius.z)
    };

    return profile.transmissionTint * (attenuation * (forwardScatterDot * phase * profile.scatteringWeight * 2.5f));
}

/**
 * Combined Subsurface Scattering Radiance Calculator.
 * Blends standard Lambertian diffuse reflectance with internal diffusion and backscatter translucency.
 */
inline Vec3 evaluateSubsurfaceRadiance(
    const Vec3& L,
    const Vec3& V,
    const Vec3& N,
    const Vec3& lightRadiance,
    float thickness,
    const SSSProfile& profile
) {
    float NdotL = std::max(0.0f, N.dot(L));

    // Standard surface diffuse
    Vec3 surfaceDiffuse = profile.surfaceAlbedo * (NdotL / math::PI);

    // Front-scatter wrap lighting (diffuse softening in shadow terminator)
    float wrap = 0.35f;
    float wrapNdotL = std::clamp((N.dot(L) + wrap) / ((1.0f + wrap) * (1.0f + wrap)), 0.0f, 1.0f);
    Vec3 frontScatter = profile.surfaceAlbedo * profile.transmissionTint * (wrapNdotL * profile.scatteringWeight);

    // Back-scatter transmission through thin sections
    Vec3 backScatter = evaluateBackscatterTranslucency(L, V, N, thickness, profile);

    Vec3 combinedScattering = math::lerp(surfaceDiffuse, frontScatter + backScatter, profile.scatteringWeight);
    return lightRadiance * combinedScattering;
}

/**
 * Estimates per-vertex thickness for a mesh using centroid distance and local curvature.
 */
inline std::vector<float> estimateMeshThickness(const geometry::Mesh& mesh, float defaultThickness = 0.25f) {
    std::vector<float> thicknesses(mesh.vertices.size(), defaultThickness);
    if (mesh.vertices.empty()) return thicknesses;

    Vec3 centroid = {0, 0, 0};
    for (const auto& v : mesh.vertices) centroid += v;
    centroid /= static_cast<float>(mesh.vertices.size());

    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        float distToCentroid = (mesh.vertices[i] - centroid).length();
        // Thin extremities (leaves/edges) have higher distance from bulk center
        float t = std::clamp(defaultThickness * (1.2f / (1.0f + distToCentroid * 0.5f)), 0.02f, 1.0f);
        thicknesses[i] = t;
    }

    return thicknesses;
}

/**
 * Evaluates Thin-Wall Dual-Sided Subsurface Scattering for plant and foliage cards.
 * Implements the Blender Principled BSDF "Thin Wall" model, allowing sunlight striking
 * the back of paper-thin leaves to illuminate through to the front with saturated chlorophyl glow.
 */
inline Vec3 evaluateThinWallTransmission(
    const Vec3& L,                 // Direction towards light
    const Vec3& V,                 // Direction towards camera
    const Vec3& N,                 // Shading normal (e.g. transferred clump normal)
    const Vec3& lightRadiance,     // Incident light radiance
    const SSSProfile& profile,     // Optical profile (e.g. PROFILE_GREEN_LEAF)
    float wrapFactor = 0.35f,      // Diffuse wrap to soften terminator
    float transmissionWeight = 1.0f// Subsurface transmission weight
) {
    // 1. Soft Wrapped Front Diffuse
    float NdotL = N.dot(L);
    float frontDiffuse = std::max(0.0f, (NdotL + wrapFactor) / ((1.0f + wrapFactor) * (1.0f + wrapFactor)));
    Vec3 frontCol = profile.surfaceAlbedo * (frontDiffuse / math::PI);

    // 2. Dual-Sided Back-face Transmission (Light striking reverse side)
    float backDotL = -NdotL;
    float backDiffuse = std::max(0.0f, (backDotL + wrapFactor * 0.5f) / ((1.0f + wrapFactor * 0.5f) * (1.0f + wrapFactor * 0.5f)));
    Vec3 backCol = profile.transmissionTint * (backDiffuse * transmissionWeight / math::PI);

    // 3. View-dependent forward solar peak (looking through leaf directly at sun)
    float viewSolarDot = std::max(0.0f, -V.dot(L));
    float forwardGlow = std::pow(viewSolarDot, 4.0f) * 1.8f * transmissionWeight;
    Vec3 rimCol = profile.transmissionTint * forwardGlow;

    return lightRadiance * (frontCol + backCol + rimCol);
}

} // namespace sss
} // namespace scratchbox

#endif // SCRATCHBOX_SSS_HPP
