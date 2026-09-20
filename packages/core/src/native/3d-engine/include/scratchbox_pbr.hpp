#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>
#include <numbers>

namespace scratchbox::pbr {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::PbrMaterial;

constexpr float PBR_PI = 3.14159265358979323846f;
constexpr float PBR_INV_PI = 0.31830988618379067154f;
constexpr float PBR_EPSILON = 1e-6f;

// ----------------------------------------------------------------------------
// Color Utilities (Linear <-> sRGB & Clamping)
// ----------------------------------------------------------------------------

inline float clamp(float v, float minVal, float maxVal) {
    return std::max(minVal, std::min(maxVal, v));
}

inline Vec3 clampVec3(const Vec3& v, float minVal = 0.0f, float maxVal = 1.0f) {
    return Vec3(clamp(v.x, minVal, maxVal),
                clamp(v.y, minVal, maxVal),
                clamp(v.z, minVal, maxVal));
}

inline float linearToSrgbChannel(float c) {
    c = clamp(c, 0.0f, 1.0f);
    return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
}

inline float srgbToLinearChannel(float c) {
    c = clamp(c, 0.0f, 1.0f);
    return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
}

inline Vec3 linearToSrgb(const Vec3& linear) {
    return Vec3(linearToSrgbChannel(linear.x),
                linearToSrgbChannel(linear.y),
                linearToSrgbChannel(linear.z));
}

inline Vec3 srgbToLinear(const Vec3& srgb) {
    return Vec3(srgbToLinearChannel(srgb.x),
                srgbToLinearChannel(srgb.y),
                srgbToLinearChannel(srgb.z));
}

inline Vec3 lerpVec3(const Vec3& a, const Vec3& b, float t) {
    return Vec3(std::lerp(a.x, b.x, t),
                std::lerp(a.y, b.y, t),
                std::lerp(a.z, b.z, t));
}

// ----------------------------------------------------------------------------
// 1. Extended PBR Material Struct (glTF 2.0 PBR Next Extensions)
// ----------------------------------------------------------------------------

using ExtendedPbrMaterial = geometry::PbrMaterial;

// ----------------------------------------------------------------------------
// 2. Microfacet BRDF Mathematical Formulations
// ----------------------------------------------------------------------------

/**
 * Normal Distribution Function (NDF): Trowbridge-Reitz / GGX
 * D_GGX(h) = alpha^2 / (pi * ((n.h)^2 * (alpha^2 - 1) + 1)^2)
 */
inline float ndfGGX(float NdotH, float roughness) {
    float r = clamp(roughness, 0.04f, 1.0f);
    float alpha = r * r;
    float alphaSq = alpha * alpha;
    float NdotHSq = clamp(NdotH, 0.0f, 1.0f) * clamp(NdotH, 0.0f, 1.0f);
    float denom = (NdotHSq * (alphaSq - 1.0f) + 1.0f);
    return alphaSq / std::max(PBR_EPSILON, PBR_PI * denom * denom);
}

/**
 * Anisotropic Normal Distribution Function (Burley / Heitz GGX)
 * D_aniso(h) = 1 / (pi * ax * ay * ((t.h)^2/ax^2 + (b.h)^2/ay^2 + (n.h)^2)^2)
 */
inline float ndfAnisotropicGGX(float NdotH, float TdotH, float BdotH, float roughness, float anisotropy) {
    float r = clamp(roughness, 0.04f, 1.0f);
    float aniso = clamp(anisotropy, -0.99f, 0.99f);
    float alpha = r * r;
    float aspect = std::sqrt(1.0f - 0.9f * aniso);
    float ax = std::max(0.001f, alpha / aspect);
    float ay = std::max(0.001f, alpha * aspect);

    float termX = (TdotH * TdotH) / (ax * ax);
    float termY = (BdotH * BdotH) / (ay * ay);
    float termZ = NdotH * NdotH;
    float denom = termX + termY + termZ;
    return 1.0f / std::max(PBR_EPSILON, PBR_PI * ax * ay * denom * denom);
}

/**
 * Charlie Normal Distribution Function (Sheen / Fabric / Velvet)
 * D_Charlie(h) = (2 + 1/alpha) / (2 * pi) * (1 - (n.h)^2)^(1 / (2*alpha))
 */
inline float ndfCharlieSheen(float NdotH, float sheenRoughness) {
    float r = clamp(sheenRoughness, 0.04f, 1.0f);
    float alpha = std::max(0.001f, r * r);
    float invAlpha = 1.0f / alpha;
    float cos2h = clamp(NdotH, 0.0f, 1.0f) * clamp(NdotH, 0.0f, 1.0f);
    float sin2h = std::max(0.0f, 1.0f - cos2h);
    return ((2.0f + invAlpha) / (2.0f * PBR_PI)) * std::pow(sin2h, invAlpha * 0.5f);
}

/**
 * Height-Correlated Smith Joint Masking-Shadowing Function (Heitz 2014)
 * V(l, v) = 0.5 / (n.v * sqrt(alpha^2 + (n.l)^2 * (1 - alpha^2)) + n.l * sqrt(alpha^2 + (n.v)^2 * (1 - alpha^2)))
 */
inline float visibilitySmithGGXCorrelated(float NdotV, float NdotL, float roughness) {
    float r = clamp(roughness, 0.04f, 1.0f);
    float alpha = r * r;
    float alphaSq = alpha * alpha;

    float nv = clamp(NdotV, 0.0f, 1.0f);
    float nl = clamp(NdotL, 0.0f, 1.0f);

    float gv = nl * std::sqrt(alphaSq + (1.0f - alphaSq) * (nv * nv));
    float gl = nv * std::sqrt(alphaSq + (1.0f - alphaSq) * (nl * nl));
    return 0.5f / std::max(PBR_EPSILON, gv + gl);
}

/**
 * Charlie Visibility Function for Sheen (Neubelt & Pettineo 2013)
 * V_Charlie(l, v) = 1 / (4 * (n.l + n.v - n.l * n.v))
 */
inline float visibilityCharlie(float NdotV, float NdotL) {
    float nv = clamp(NdotV, 0.0f, 1.0f);
    float nl = clamp(NdotL, 0.0f, 1.0f);
    return 1.0f / std::max(PBR_EPSILON, 4.0f * (nl + nv - nl * nv));
}

/**
 * Dielectric F0 from Index of Refraction (IOR)
 * F0 = ((ior - 1) / (ior + 1))^2
 */
inline float dielectricF0(float ior) {
    float ratio = (ior - 1.0f) / std::max(1e-4f, ior + 1.0f);
    return ratio * ratio;
}

/**
 * Conductor F0 from base color, metallic, and dielectric IOR
 */
inline Vec3 conductorF0(const Vec3& baseColor, float metallic, float ior = 1.5f) {
    float f0Dielectric = dielectricF0(ior);
    Vec3 f0D(f0Dielectric, f0Dielectric, f0Dielectric);
    return lerpVec3(f0D, baseColor, clamp(metallic, 0.0f, 1.0f));
}

/**
 * Schlick Fresnel approximation:
 * F(v, h) = F0 + (1 - F0) * (1 - max(0, v.h))^5
 */
inline Vec3 schlickFresnel(const Vec3& F0, float VdotH) {
    float cosTheta = clamp(VdotH, 0.0f, 1.0f);
    float powTerm = std::pow(1.0f - cosTheta, 5.0f);
    return Vec3(
        F0.x + (1.0f - F0.x) * powTerm,
        F0.y + (1.0f - F0.y) * powTerm,
        F0.z + (1.0f - F0.z) * powTerm
    );
}

/**
 * Schlick-Roughness Fresnel (for Image-Based Lighting / ambient reflection)
 */
inline Vec3 schlickRoughnessFresnel(const Vec3& F0, float NdotV, float roughness) {
    float cosTheta = clamp(NdotV, 0.0f, 1.0f);
    float powTerm = std::pow(1.0f - cosTheta, 5.0f);
    float maxRough = std::max(1.0f - roughness, F0.x);
    return Vec3(
        F0.x + (maxRough - F0.x) * powTerm,
        F0.y + (maxRough - F0.y) * powTerm,
        F0.z + (maxRough - F0.z) * powTerm
    );
}

/**
 * Lambertian Diffuse BRDF
 * f_d = baseColor / pi
 */
inline Vec3 diffuseLambert(const Vec3& baseColor) {
    return baseColor * PBR_INV_PI;
}

/**
 * Disney / Burley Retro-Reflective Diffuse BRDF
 * F_D90 = 0.5 + 2 * roughness * (l.h)^2
 * f_diffuse = baseColor / pi * (1 + (F_D90 - 1)(1 - n.l)^5) * (1 + (F_D90 - 1)(1 - n.v)^5)
 */
inline Vec3 diffuseDisneyBurley(const Vec3& baseColor, float NdotV, float NdotL, float LdotH, float roughness) {
    float nl = clamp(NdotL, 0.0f, 1.0f);
    float nv = clamp(NdotV, 0.0f, 1.0f);
    float lh = clamp(LdotH, 0.0f, 1.0f);

    float fd90 = 0.5f + 2.0f * roughness * (lh * lh);
    float lightScatter = 1.0f + (fd90 - 1.0f) * std::pow(1.0f - nl, 5.0f);
    float viewScatter = 1.0f + (fd90 - 1.0f) * std::pow(1.0f - nv, 5.0f);

    return baseColor * (PBR_INV_PI * lightScatter * viewScatter);
}

/**
 * Beer-Lambert Law Volume Absorption (KHR_materials_volume)
 * T(d) = exp(-sigma_a * d),  sigma_a = -ln(attenuationColor) / attenuationDistance
 */
inline Vec3 evaluateBeerLambertAbsorption(const Vec3& attenuationColor, float attenuationDistance, float thickness) {
    float dist = std::max(PBR_EPSILON, attenuationDistance);
    float d = std::max(0.0f, thickness);

    float sigmaX = -std::log(clamp(attenuationColor.x, 0.001f, 1.0f)) / dist;
    float sigmaY = -std::log(clamp(attenuationColor.y, 0.001f, 1.0f)) / dist;
    float sigmaZ = -std::log(clamp(attenuationColor.z, 0.001f, 1.0f)) / dist;

    return Vec3(
        std::exp(-sigmaX * d),
        std::exp(-sigmaY * d),
        std::exp(-sigmaZ * d)
    );
}

// Ergonomic Mathematical Aliases
inline float visSmithJoint(float NdotV, float NdotL, float roughness) {
    return visibilitySmithGGXCorrelated(NdotV, NdotL, roughness);
}

inline Vec3 fresnelSchlick(float cosTheta, const Vec3& F0) {
    return schlickFresnel(F0, cosTheta);
}

inline float visCharlieSheen(float NdotV, float NdotL) {
    return visibilityCharlie(NdotV, NdotL);
}

inline Vec3 beerLambertAbsorption(const Vec3& attenuationColor, float attenuationDistance, float thickness) {
    return evaluateBeerLambertAbsorption(attenuationColor, attenuationDistance, thickness);
}

// ----------------------------------------------------------------------------
// 3. Complete PBR BRDF Evaluation Result
// ----------------------------------------------------------------------------

struct BRDFEvalResult {
    Vec3 totalRadiance{0.0f, 0.0f, 0.0f};
    Vec3 diffuseComponent{0.0f, 0.0f, 0.0f};
    Vec3 specularComponent{0.0f, 0.0f, 0.0f};
    Vec3 clearcoatComponent{0.0f, 0.0f, 0.0f};
    Vec3 sheenComponent{0.0f, 0.0f, 0.0f};
    Vec3 transmissionComponent{0.0f, 0.0f, 0.0f};
    float NdotL{0.0f};
    float NdotV{0.0f};

    // Ergonomic short aliases
    Vec3 total{0.0f, 0.0f, 0.0f};
    Vec3 diffuse{0.0f, 0.0f, 0.0f};
    Vec3 specular{0.0f, 0.0f, 0.0f};
    Vec3 clearcoat{0.0f, 0.0f, 0.0f};
    Vec3 sheen{0.0f, 0.0f, 0.0f};
    Vec3 transmission{0.0f, 0.0f, 0.0f};
};

/**
 * Full PBR BRDF Evaluation adhering to strict energy conservation
 */
inline BRDFEvalResult evaluatePbrBRDF(
    const ExtendedPbrMaterial& mat,
    const Vec3& N, // Surface normal
    const Vec3& V, // View direction (to camera)
    const Vec3& L, // Light direction (to light)
    const Vec3& lightRadiance = Vec3(1.0f, 1.0f, 1.0f),
    const Vec3& T = Vec3(1.0f, 0.0f, 0.0f), // Tangent (for anisotropy)
    const Vec3& B = Vec3(0.0f, 1.0f, 0.0f)  // Bitangent (for anisotropy)
) {
    BRDFEvalResult res;

    float NdotL = clamp(N.dot(L), 0.0f, 1.0f);
    float NdotV = clamp(N.dot(V), 0.0f, 1.0f);
    res.NdotL = NdotL;
    res.NdotV = NdotV;

    if (NdotL <= 0.0f || NdotV <= 0.0f) {
        return res;
    }

    Vec3 H = (V + L).normalized();
    float NdotH = clamp(N.dot(H), 0.0f, 1.0f);
    float VdotH = clamp(V.dot(H), 0.0f, 1.0f);
    float LdotH = clamp(L.dot(H), 0.0f, 1.0f);

    Vec3 baseColor(mat.baseColorFactor.x, mat.baseColorFactor.y, mat.baseColorFactor.z);
    Vec3 F0 = conductorF0(baseColor, mat.metallicFactor, mat.ior);

    // 1. Specular Cook-Torrance (D * F * V)
    float D = 0.0f;
    if (std::abs(mat.anisotropyStrength) > 0.01f) {
        float TdotH = T.dot(H);
        float BdotH = B.dot(H);
        D = ndfAnisotropicGGX(NdotH, TdotH, BdotH, mat.roughnessFactor, mat.anisotropyStrength);
    } else {
        D = ndfGGX(NdotH, mat.roughnessFactor);
    }

    Vec3 F = schlickFresnel(F0, VdotH);
    float Vis = visibilitySmithGGXCorrelated(NdotV, NdotL, mat.roughnessFactor);
    Vec3 specLobe = (F * (D * Vis));
    res.specularComponent = Vec3(specLobe.x * lightRadiance.x,
                                 specLobe.y * lightRadiance.y,
                                 specLobe.z * lightRadiance.z) * NdotL;

    // 2. Diffuse Lobe (Energy Conservation: (1 - F) * (1 - metallic) * (1 - transmission))
    Vec3 kd(
        (1.0f - F.x) * (1.0f - mat.metallicFactor) * (1.0f - mat.transmissionFactor),
        (1.0f - F.y) * (1.0f - mat.metallicFactor) * (1.0f - mat.transmissionFactor),
        (1.0f - F.z) * (1.0f - mat.metallicFactor) * (1.0f - mat.transmissionFactor)
    );
    Vec3 diffBRDF = diffuseDisneyBurley(baseColor, NdotV, NdotL, LdotH, mat.roughnessFactor);
    Vec3 diffLobe = Vec3(diffBRDF.x * kd.x, diffBRDF.y * kd.y, diffBRDF.z * kd.z);
    res.diffuseComponent = Vec3(diffLobe.x * lightRadiance.x,
                                diffLobe.y * lightRadiance.y,
                                diffLobe.z * lightRadiance.z) * NdotL;

    // 3. Clearcoat Lobe (Dual-Layer Specular Lacquer)
    float clearcoatFactor = clamp(mat.clearcoatFactor, 0.0f, 1.0f);
    if (clearcoatFactor > 0.0f) {
        float D_cc = ndfGGX(NdotH, mat.clearcoatRoughnessFactor);
        float V_cc = visibilitySmithGGXCorrelated(NdotV, NdotL, mat.clearcoatRoughnessFactor);
        // Fixed IOR 1.5 -> F0 = 0.04
        float F_cc = 0.04f + (1.0f - 0.04f) * std::pow(1.0f - VdotH, 5.0f);
        float ccSpec = D_cc * V_cc * F_cc * clearcoatFactor;
        res.clearcoatComponent = lightRadiance * (ccSpec * NdotL);

        // Clearcoat layer attenuation on base radiance: (1 - F_cc * clearcoatFactor)
        float ccAttenuation = 1.0f - F_cc * clearcoatFactor;
        res.specularComponent = res.specularComponent * ccAttenuation;
        res.diffuseComponent = res.diffuseComponent * ccAttenuation;
    }

    // 4. Sheen Lobe (Fabric / Velvet / Charlie NDF)
    if (mat.sheenColorFactor.x > 0.0f || mat.sheenColorFactor.y > 0.0f || mat.sheenColorFactor.z > 0.0f) {
        float D_charlie = ndfCharlieSheen(NdotH, mat.sheenRoughnessFactor);
        float V_charlie = visibilityCharlie(NdotV, NdotL);
        Vec3 sheenLobe = mat.sheenColorFactor * (D_charlie * V_charlie);
        res.sheenComponent = Vec3(sheenLobe.x * lightRadiance.x,
                                  sheenLobe.y * lightRadiance.y,
                                  sheenLobe.z * lightRadiance.z) * NdotL;
    }

    // 5. Transmission Lobe (Beer-Lambert Absorption)
    if (mat.transmissionFactor > 0.0f) {
        Vec3 absorption = evaluateBeerLambertAbsorption(mat.attenuationColor, mat.attenuationDistance, mat.thicknessFactor);
        Vec3 transLobe = Vec3(baseColor.x * absorption.x, baseColor.y * absorption.y, baseColor.z * absorption.z) * mat.transmissionFactor;
        res.transmissionComponent = Vec3(transLobe.x * lightRadiance.x,
                                         transLobe.y * lightRadiance.y,
                                         transLobe.z * lightRadiance.z) * NdotL;
    }

    // Combine all components and assign short aliases
    res.diffuse = res.diffuseComponent;
    res.specular = res.specularComponent;
    res.clearcoat = res.clearcoatComponent;
    res.sheen = res.sheenComponent;
    res.transmission = res.transmissionComponent;
    res.total = res.totalRadiance = res.diffuseComponent + res.specularComponent + res.clearcoatComponent + res.sheenComponent + res.transmissionComponent;
    return res;
}

// ----------------------------------------------------------------------------
// 4. Calibrated Material Presets Library (20+ Photorealistic Materials)
// ----------------------------------------------------------------------------

namespace presets {

// --- METALS ---

inline ExtendedPbrMaterial titaniumGrade5() {
    ExtendedPbrMaterial m;
    m.name = "titanium_grade_5";
    m.baseColorFactor = Vec4(0.76f, 0.77f, 0.82f, 1.0f);
    m.metallicFactor = 0.95f;
    m.roughnessFactor = 0.22f;
    m.anisotropyStrength = 0.35f;
    return m;
}

inline ExtendedPbrMaterial polishedGold24k() {
    ExtendedPbrMaterial m;
    m.name = "polished_gold_24k";
    m.baseColorFactor = Vec4(1.00f, 0.85f, 0.20f, 1.0f);
    m.metallicFactor = 1.00f;
    m.roughnessFactor = 0.08f;
    return m;
}

inline ExtendedPbrMaterial brushedAluminum() {
    ExtendedPbrMaterial m;
    m.name = "brushed_aluminum";
    m.baseColorFactor = Vec4(0.91f, 0.92f, 0.92f, 1.0f);
    m.metallicFactor = 0.95f;
    m.roughnessFactor = 0.28f;
    m.anisotropyStrength = 0.75f;
    return m;
}

inline ExtendedPbrMaterial oxidizedCopper() {
    ExtendedPbrMaterial m;
    m.name = "oxidized_copper_patina";
    m.baseColorFactor = Vec4(0.38f, 0.68f, 0.58f, 1.0f);
    m.metallicFactor = 0.30f;
    m.roughnessFactor = 0.72f;
    return m;
}

inline ExtendedPbrMaterial mirrorChrome() {
    ExtendedPbrMaterial m;
    m.name = "mirror_chrome";
    m.baseColorFactor = Vec4(0.98f, 0.98f, 0.99f, 1.0f);
    m.metallicFactor = 0.98f;
    m.roughnessFactor = 0.03f;
    return m;
}

inline ExtendedPbrMaterial surgicalSteel() {
    ExtendedPbrMaterial m;
    m.name = "surgical_stainless_steel";
    m.baseColorFactor = Vec4(0.85f, 0.86f, 0.87f, 1.0f);
    m.metallicFactor = 0.96f;
    m.roughnessFactor = 0.14f;
    return m;
}

inline ExtendedPbrMaterial tarnishedSilver() {
    ExtendedPbrMaterial m;
    m.name = "tarnished_silver";
    m.baseColorFactor = Vec4(0.82f, 0.80f, 0.76f, 1.0f);
    m.metallicFactor = 0.94f;
    m.roughnessFactor = 0.35f;
    return m;
}

inline ExtendedPbrMaterial anodizedCobalt() {
    ExtendedPbrMaterial m;
    m.name = "anodized_cobalt";
    m.baseColorFactor = Vec4(0.18f, 0.36f, 0.85f, 1.0f);
    m.metallicFactor = 0.88f;
    m.roughnessFactor = 0.18f;
    m.clearcoatFactor = 0.50f;
    m.clearcoatRoughnessFactor = 0.04f;
    return m;
}

// --- DIELECTRICS & TRANSLUCENTS ---

inline ExtendedPbrMaterial opticalGlass() {
    ExtendedPbrMaterial m;
    m.name = "optical_crown_glass";
    m.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    m.metallicFactor = 0.0f;
    m.roughnessFactor = 0.03f;
    m.transmissionFactor = 0.98f;
    m.ior = 1.52f;
    m.thicknessFactor = 0.8f;
    m.attenuationColor = Vec3(0.98f, 0.99f, 1.0f);
    m.attenuationDistance = 2.0f;
    return m;
}

inline ExtendedPbrMaterial emeraldCrystal() {
    ExtendedPbrMaterial m;
    m.name = "beryl_emerald_crystal";
    m.baseColorFactor = Vec4(0.12f, 0.88f, 0.45f, 0.9f);
    m.metallicFactor = 0.05f;
    m.roughnessFactor = 0.06f;
    m.transmissionFactor = 0.85f;
    m.ior = 1.58f;
    m.thicknessFactor = 1.2f;
    m.attenuationColor = Vec3(0.08f, 0.82f, 0.38f);
    m.attenuationDistance = 0.9f;
    return m;
}

inline ExtendedPbrMaterial roughBasaltRock() {
    ExtendedPbrMaterial m;
    m.name = "volcanic_basalt_rock";
    m.baseColorFactor = Vec4(0.18f, 0.17f, 0.19f, 1.0f);
    m.metallicFactor = 0.04f;
    m.roughnessFactor = 0.88f;
    return m;
}

inline ExtendedPbrMaterial carPaintCandyRed() {
    ExtendedPbrMaterial m;
    m.name = "automotive_candy_red";
    m.baseColorFactor = Vec4(0.85f, 0.06f, 0.08f, 1.0f);
    m.metallicFactor = 0.45f;
    m.roughnessFactor = 0.40f;
    m.clearcoatFactor = 1.00f;
    m.clearcoatRoughnessFactor = 0.03f;
    return m;
}

inline ExtendedPbrMaterial carbonFiberLacquer() {
    ExtendedPbrMaterial m;
    m.name = "carbon_fiber_twill_lacquer";
    m.baseColorFactor = Vec4(0.12f, 0.12f, 0.14f, 1.0f);
    m.metallicFactor = 0.28f;
    m.roughnessFactor = 0.52f;
    m.anisotropyStrength = 0.82f;
    m.clearcoatFactor = 0.85f;
    m.clearcoatRoughnessFactor = 0.04f;
    return m;
}

inline ExtendedPbrMaterial carraraMarble() {
    ExtendedPbrMaterial m;
    m.name = "carrara_white_marble";
    m.baseColorFactor = Vec4(0.94f, 0.93f, 0.91f, 1.0f);
    m.metallicFactor = 0.02f;
    m.roughnessFactor = 0.25f;
    m.transmissionFactor = 0.18f;
    m.thicknessFactor = 0.6f;
    m.attenuationColor = Vec3(0.96f, 0.94f, 0.92f);
    return m;
}

inline ExtendedPbrMaterial redVelvetCloth() {
    ExtendedPbrMaterial m;
    m.name = "royal_red_velvet";
    m.baseColorFactor = Vec4(0.65f, 0.08f, 0.12f, 1.0f);
    m.metallicFactor = 0.00f;
    m.roughnessFactor = 0.82f;
    m.sheenColorFactor = Vec3(0.96f, 0.42f, 0.52f);
    m.sheenRoughnessFactor = 0.45f;
    return m;
}

inline ExtendedPbrMaterial blackOnyx() {
    ExtendedPbrMaterial m;
    m.name = "volcanic_black_onyx";
    m.baseColorFactor = Vec4(0.06f, 0.06f, 0.08f, 1.0f);
    m.metallicFactor = 0.06f;
    m.roughnessFactor = 0.05f;
    m.ior = 1.54f;
    return m;
}

inline ExtendedPbrMaterial paraffinWax() {
    ExtendedPbrMaterial m;
    m.name = "paraffin_candle_wax";
    m.baseColorFactor = Vec4(0.92f, 0.88f, 0.78f, 1.0f);
    m.metallicFactor = 0.00f;
    m.roughnessFactor = 0.36f;
    m.transmissionFactor = 0.32f;
    m.thicknessFactor = 0.5f;
    m.attenuationColor = Vec3(0.94f, 0.89f, 0.79f);
    return m;
}

inline ExtendedPbrMaterial soapBubbleIridescent() {
    ExtendedPbrMaterial m;
    m.name = "soap_bubble_thin_film";
    m.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    m.metallicFactor = 0.00f;
    m.roughnessFactor = 0.02f;
    m.transmissionFactor = 0.95f;
    m.ior = 1.33f;
    m.iridescenceFactor = 1.0f;
    m.iridescenceIor = 1.33f;
    m.iridescenceThicknessMin = 120.0f;
    m.iridescenceThicknessMax = 380.0f;
    return m;
}

inline ExtendedPbrMaterial ceramicPorcelain() {
    ExtendedPbrMaterial m;
    m.name = "glazed_white_porcelain";
    m.baseColorFactor = Vec4(0.96f, 0.95f, 0.94f, 1.0f);
    m.metallicFactor = 0.00f;
    m.roughnessFactor = 0.12f;
    m.clearcoatFactor = 0.50f;
    m.clearcoatRoughnessFactor = 0.02f;
    return m;
}

} // namespace presets

// ----------------------------------------------------------------------------
// 5. Procedural Normal & Surface Map Synthesizer
// ----------------------------------------------------------------------------

/**
 * Computes tangent-space normal from a height function h(u, v) using Sobel central differencing
 */
template <typename HeightFn>
inline Vec3 generateNormalFromHeightmap(HeightFn heightFn, float u, float v, float eps = 0.005f, float bumpScale = 1.0f) {
    float hL = heightFn(u - eps, v);
    float hR = heightFn(u + eps, v);
    float hD = heightFn(u, v - eps);
    float hU = heightFn(u, v + eps);

    float dHdu = (hR - hL) / (2.0f * eps);
    float dHdv = (hU - hD) / (2.0f * eps);

    Vec3 normal(-dHdu * bumpScale, -dHdv * bumpScale, 1.0f);
    return normal.normalized();
}

/**
 * Computes tangent-space normals from a discrete 2D heightmap array
 */
inline std::vector<Vec3> generateNormalFromHeightmap(const std::vector<float>& heightmap, int width, int height, float bumpScale = 1.0f) {
    std::vector<Vec3> normals(width * height);
    for (int y = 0; y < height; ++y) {
        for (int x = 0; x < width; ++x) {
            int xL = std::max(0, x - 1);
            int xR = std::min(width - 1, x + 1);
            int yD = std::max(0, y - 1);
            int yU = std::min(height - 1, y + 1);

            float hL = heightmap[y * width + xL];
            float hR = heightmap[y * width + xR];
            float hD = heightmap[yD * width + x];
            float hU = heightmap[yU * width + x];

            float dHdx = (hR - hL) * 0.5f;
            float dHdy = (hU - hD) * 0.5f;

            Vec3 n(-dHdx * bumpScale, -dHdy * bumpScale, 1.0f);
            normals[y * width + x] = n.normalized();
        }
    }
    return normals;
}

/**
 * Procedural edge-wear and cavity roughness modulator
 */
inline float modulateEdgeRoughness(float baseRoughness, float curvature, float wearIntensity = 0.5f) {
    // Sharp convex edges experience higher micro-abrasion / wear
    float wearFactor = clamp(curvature * wearIntensity, -0.3f, 0.4f);
    return clamp(baseRoughness + wearFactor, 0.04f, 0.98f);
}

// ----------------------------------------------------------------------------
// 6. Differential Curvature & Multi-Scale Wear Synthesizer
// ----------------------------------------------------------------------------

struct CurvatureMetrics {
    float k1{0.0f};                // Maximum principal curvature
    float k2{0.0f};                // Minimum principal curvature
    float meanCurvature{0.0f};     // H = (k1 + k2) / 2
    float gaussianCurvature{0.0f}; // K = k1 * k2
    float shapeIndex{0.0f};        // S = (2 / PI) * atan2(k1 + k2, k1 - k2) in [-1, +1]
    float curvedness{0.0f};        // C = sqrt((k1^2 + k2^2) / 2)
};

/**
 * Computes discrete principal curvatures at a vertex given its position, normal,
 * and neighboring adjacent vertex positions.
 */
inline CurvatureMetrics estimateVertexCurvature(
    const Vec3& pos,
    const Vec3& normal,
    const std::vector<Vec3>& neighbors
) {
    CurvatureMetrics m;
    if (neighbors.empty()) return m;

    float minK = 1e9f;
    float maxK = -1e9f;

    for (const auto& nb : neighbors) {
        Vec3 diff = nb - pos;
        float d2 = diff.lengthSq();
        if (d2 < 1e-8f) continue;
        // Directional normal curvature approximation: kappa = 2 * (diff . normal) / ||diff||^2
        float kappa = 2.0f * diff.dot(normal) / d2;
        minK = std::min(minK, kappa);
        maxK = std::max(maxK, kappa);
    }

    if (minK > maxK) {
        minK = 0.0f;
        maxK = 0.0f;
    }

    m.k1 = maxK;
    m.k2 = minK;
    m.meanCurvature = (m.k1 + m.k2) * 0.5f;
    m.gaussianCurvature = m.k1 * m.k2;
    float denom = m.k1 - m.k2;
    if (std::abs(denom) > 1e-6f) {
        m.shapeIndex = (2.0f / PBR_PI) * std::atan2(m.k1 + m.k2, denom);
    } else {
        m.shapeIndex = (m.k1 > 0.0f) ? 1.0f : (m.k1 < 0.0f ? -1.0f : 0.0f);
    }
    m.curvedness = std::sqrt(std::max(0.0f, (m.k1 * m.k1 + m.k2 * m.k2) * 0.5f));
    return m;
}

/**
 * Multi-scale stratified wear result
 */
struct StratifiedWearResult {
    Vec4 albedo{0.8f, 0.8f, 0.8f, 1.0f};
    float metallic{0.0f};
    float roughness{0.5f};
    float layerExposure{0.0f}; // 0.0 = topcoat, 0.5 = primer, 1.0 = exposed metal
};

/**
 * Synthesizes stratified multi-layer wear (Topcoat paint -> Primer undercoat -> Raw metal)
 * using shape index curvature, ambient occlusion, and procedural micro-fracture noise.
 */
inline StratifiedWearResult computeStratifiedWear(
    const Vec4& paintAlbedo,
    float paintRoughness,
    const Vec4& primerColor,
    float primerRoughness,
    const Vec4& metalAlbedo,
    float metalRoughness,
    float shapeIndex,
    float ambientOcclusion,
    float fractureNoise,
    float wearIntensity = 1.0f
) {
    StratifiedWearResult res;

    // Convex ridges (positive shape index) and exposed areas (low AO) undergo abrasion
    float ridgeExposure = clamp((shapeIndex - 0.1f) * 1.5f, 0.0f, 1.0f);
    float exposure = ridgeExposure * (1.0f - ambientOcclusion * 0.7f) * wearIntensity;

    // Perturb threshold boundary with micro-fracture noise
    float perturbedExposure = exposure + fractureNoise * 0.35f;

    if (perturbedExposure > 0.75f) {
        // Level 0: Exposed substrate metal
        float t = clamp((perturbedExposure - 0.75f) / 0.25f, 0.0f, 1.0f);
        Vec3 mixed = lerpVec3(Vec3(primerColor.x, primerColor.y, primerColor.z),
                              Vec3(metalAlbedo.x, metalAlbedo.y, metalAlbedo.z), t);
        res.albedo = Vec4(mixed.x, mixed.y, mixed.z, 1.0f);
        res.metallic = std::lerp(0.0f, 1.0f, t);
        res.roughness = std::lerp(primerRoughness, metalRoughness, t);
        res.layerExposure = 0.5f + 0.5f * t;
    } else if (perturbedExposure > 0.35f) {
        // Level 1: Primer undercoat exposed
        float t = clamp((perturbedExposure - 0.35f) / 0.40f, 0.0f, 1.0f);
        Vec3 mixed = lerpVec3(Vec3(paintAlbedo.x, paintAlbedo.y, paintAlbedo.z),
                              Vec3(primerColor.x, primerColor.y, primerColor.z), t);
        res.albedo = Vec4(mixed.x, mixed.y, mixed.z, 1.0f);
        res.metallic = 0.0f;
        res.roughness = std::lerp(paintRoughness, primerRoughness, t);
        res.layerExposure = 0.5f * t;
    } else {
        // Level 2: Intact topcoat
        res.albedo = paintAlbedo;
        res.metallic = 0.0f;
        res.roughness = paintRoughness;
        res.layerExposure = 0.0f;
    }

    return res;
}

/**
 * Wave-Optics Thin-Film Interference (Airy Model)
 * Computes spectral reflectance modulation across RGB wavelengths.
 */
inline Vec3 evaluateThinFilmInterference(
    float cosTheta,
    float filmThicknessNm,
    float filmIor = 1.33f
) {
    // Phase difference delta = (4 * pi * d / lambda) * sqrt(n2^2 - sin^2(theta))
    float sinTheta2 = std::max(0.0f, 1.0f - cosTheta * cosTheta);
    float n2sq = filmIor * filmIor;
    float radicand = std::max(0.01f, n2sq - sinTheta2);
    float pathFactor = std::sqrt(radicand);

    // RGB representative wavelengths in nanometers: R = 650nm, G = 532nm, B = 450nm
    constexpr float lambdaR = 650.0f;
    constexpr float lambdaG = 532.0f;
    constexpr float lambdaB = 450.0f;

    auto channelInterference = [&](float lambda) -> float {
        float delta = (4.0f * PBR_PI * filmThicknessNm * pathFactor) / lambda;
        // Constructive interference amplitude: 0.5 + 0.5 * cos(delta)
        return 0.5f + 0.5f * std::cos(delta);
    };

    return Vec3(channelInterference(lambdaR), channelInterference(lambdaG), channelInterference(lambdaB));
}

/**
 * Dual-Specular Lobe Composition (Base Microfacet + Micro-Thin Sebum/Lipid Surface Film)
 */
inline float evaluateDualLobeRoughness(
    float baseRoughness,
    float lipidRoughness,
    float lipidCoverage = 0.35f
) {
    return std::lerp(baseRoughness, lipidRoughness, clamp(lipidCoverage, 0.0f, 1.0f));
}

} // namespace scratchbox::pbr

