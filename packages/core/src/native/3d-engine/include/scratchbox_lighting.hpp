/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_LIGHTING_HPP
#define SCRATCHBOX_LIGHTING_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_geometry.hpp"
#include <vector>
#include <string>
#include <cmath>
#include <algorithm>
#include <string_view>
#include <numbers>

namespace scratchbox {
namespace lighting {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::PI;
using math::TWO_PI;
using math::HALF_PI;

// ============================================================================
// 1. Color Science & Blackbody Kelvin Temperature Radiometry
// ============================================================================

/**
 * Standard photographic and cinematic correlated color temperatures (CCT in Kelvin).
 */
constexpr float KELVIN_CANDLE = 1850.0f;
constexpr float KELVIN_TUNGSTEN = 2800.0f;
constexpr float KELVIN_STUDIO_HALOGEN = 3200.0f;
constexpr float KELVIN_MOONLIGHT = 4100.0f;
constexpr float KELVIN_HORIZON_DAYLIGHT = 5000.0f;
constexpr float KELVIN_FILM_DAYLIGHT = 5600.0f;
constexpr float KELVIN_D65_NOON = 6500.0f;
constexpr float KELVIN_OVERCAST = 7000.0f;
constexpr float KELVIN_COOL_SKY = 7500.0f;
constexpr float KELVIN_ARCTIC_HAZE = 9500.0f;

/**
 * Converts a blackbody temperature in Kelvin (1000K to 15000K) to linear HDR RGB.
 * Uses the analytic Planckian locus polynomial approximation (Kang et al. / Tanner Helland).
 */
inline Vec3 kelvinToLinearRgb(float kelvin) {
    float k = std::clamp(kelvin, 1000.0f, 15000.0f) / 100.0f;

    float r = 0.0f;
    float g = 0.0f;
    float b = 0.0f;

    // Red Channel
    if (k <= 66.0f) {
        r = 1.0f;
    } else {
        r = 329.698727446f * std::pow(k - 60.0f, -0.1332047592f) / 255.0f;
    }

    // Green Channel
    if (k <= 66.0f) {
        g = (99.4708025861f * std::log(k) - 161.1195681661f) / 255.0f;
    } else {
        g = 288.1221695283f * std::pow(k - 60.0f, -0.0755148492f) / 255.0f;
    }

    // Blue Channel
    if (k >= 66.0f) {
        b = 1.0f;
    } else if (k <= 19.0f) {
        b = 0.0f;
    } else {
        b = (138.5177312231f * std::log(k - 10.0f) - 305.0447927307f) / 255.0f;
    }

    r = std::clamp(r, 0.0f, 1.0f);
    g = std::clamp(g, 0.0f, 1.0f);
    b = std::clamp(b, 0.0f, 1.0f);

    // Convert sRGB curve to Linear RGB (approx gamma 2.2 / sRGB inverse transfer)
    auto toLinear = [](float c) -> float {
        return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
    };

    return Vec3(toLinear(r), toLinear(g), toLinear(b));
}

/**
 * Photometric Unit Conversions
 */
inline float lumensToCandela(float lumens) {
    // For an isotropic point light: 1 candela = 1 lumen / 4pi steradians
    return lumens / (4.0f * PI);
}

inline float candelaToLumens(float candela) {
    return candela * (4.0f * PI);
}

inline float luxToFootCandles(float lux) {
    return lux * 0.092903f;
}

// ============================================================================
// 2. Physical Light Entities & Mathematical Attenuation
// ============================================================================

enum class LightType {
    DIRECTIONAL = 0,
    POINT = 1,
    SPOT = 2,
    RECT_AREA = 3
};

struct Light {
    std::string name{"Light"};
    LightType type{LightType::POINT};
    Vec3 position{0.0f, 3.0f, 0.0f};
    Vec3 direction{0.0f, -1.0f, 0.0f}; // Direction for directional, spot, area lights
    Vec3 color{1.0f, 1.0f, 1.0f};      // Linear RGB color
    float intensity{1.0f};             // Lux (directional) or Candela (point/spot)
    float range{20.0f};                // Maximum influence radius in meters
    float innerConeAngle{0.25f};       // Spot inner beam half-angle in radians
    float outerConeAngle{0.55f};       // Spot outer penumbra half-angle in radians
    float areaWidth{1.0f};             // Rect area width
    float areaHeight{1.0f};            // Rect area height
    bool castShadows{true};
    float shadowSoftness{1.0f};
    float kelvin{5600.0f};

    // Helper to assign physical Kelvin temperature
    void setKelvin(float k) {
        kelvin = k;
        color = kelvinToLinearRgb(k);
    }
};

/**
 * Windowed Inverse-Square Attenuation (Karis / Frostbite standard).
 * Prevents singularity at d -> 0 and smoothly attenuates to 0 at d = radius.
 * f_window(d, r) = [max(0, 1 - (d/r)^4)]^2
 * f_att(d) = 1 / max(d^2, 0.0001) * f_window(d, r)
 */
inline float evaluateDistanceAttenuation(float distance, float range) {
    if (range <= 0.0f) {
        return 1.0f / std::max(distance * distance, 0.0001f);
    }

    float d = std::max(0.0f, distance);
    float dOverR = d / range;
    float dOverR4 = dOverR * dOverR * dOverR * dOverR;
    float window = std::clamp(1.0f - dOverR4, 0.0f, 1.0f);
    float windowSq = window * window;

    return (1.0f / std::max(d * d, 0.0001f)) * windowSq;
}

/**
 * Spot Light Angular Cone Attenuation with smoothstep penumbra.
 * cosTheta: cosine of angle between -lightDir and lightToSurface
 */
inline float evaluateSpotAngularFalloff(float cosTheta, float cosInner, float cosOuter) {
    if (cosInner <= cosOuter) return 0.0f;
    float t = std::clamp((cosTheta - cosOuter) / (cosInner - cosOuter), 0.0f, 1.0f);
    // Cubic Hermite smoothstep penumbra
    return t * t * (3.0f - 2.0f * t);
}

/**
 * Evaluates direct unoccluded incident radiance and light vector L from any Light.
 */
struct DirectIllumination {
    Vec3 L{0.0f, 1.0f, 0.0f}; // Direction from surface to light
    Vec3 incidentRadiance{0.0f, 0.0f, 0.0f}; // E_i (lux/irradiance at surface)
    float distance{0.0f};
    bool valid{false};
};

inline DirectIllumination evaluateLightIncident(const Light& light, const Vec3& surfacePos) {
    DirectIllumination direct;

    if (light.type == LightType::DIRECTIONAL) {
        direct.L = (-light.direction).normalized();
        direct.distance = 1e6f;
        direct.incidentRadiance = light.color * light.intensity;
        direct.valid = true;
        return direct;
    }

    Vec3 toLight = light.position - surfacePos;
    float distSq = toLight.lengthSq();
    float dist = std::sqrt(distSq);
    direct.distance = dist;

    if (dist <= 1e-5f) return direct;
    direct.L = toLight / dist;

    // Distance attenuation
    float distAtten = evaluateDistanceAttenuation(dist, light.range);
    float angularAtten = 1.0f;

    if (light.type == LightType::SPOT) {
        Vec3 spotDir = light.direction.normalized();
        float cosTheta = (-direct.L).dot(spotDir);
        float cosInner = std::cos(light.innerConeAngle);
        float cosOuter = std::cos(light.outerConeAngle);
        angularAtten = evaluateSpotAngularFalloff(cosTheta, cosInner, cosOuter);
    }

    float totalAtten = distAtten * angularAtten;
    if (totalAtten <= 1e-6f) return direct;

    direct.incidentRadiance = light.color * (light.intensity * totalAtten);
    direct.valid = true;
    return direct;
}

// ============================================================================
// 3. Cinematic & Studio Lighting Rigs
// ============================================================================

struct LightingRig {
    std::string name{"StudioRig"};
    std::vector<Light> lights;
    Vec3 ambientColor{0.04f, 0.05f, 0.08f}; // Subtle ambient baseline
    float exposure{1.0f};

    void addLight(const Light& l) {
        lights.push_back(l);
    }
};

/**
 * Factory for calibrated cinematic and studio lighting rigs.
 */
class LightingRigFactory {
public:
    /**
     * 1. Classic 3-Point Studio Rig (Key, Fill, Rim/Kicker, plus Floor Bounce).
     * Standard commercial, portrait, and industrial design showcase rig.
     */
    static LightingRig createThreePointStudioRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f,
        float keyKelvin = 5600.0f,
        float fillRatio = 0.35f,
        float rimIntensity = 2.4f
    ) {
        LightingRig rig;
        rig.name = "cinematic_3point_studio";
        rig.exposure = 1.0f;

        // Key Light: 45° azimuth, 35° elevation, daylight balanced
        Light key;
        key.name = "Key_Light";
        key.type = LightType::POINT;
        key.position = Vec3(center.x + scale * 0.707f, center.y + scale * 0.65f, center.z + scale * 0.707f);
        key.setKelvin(keyKelvin);
        key.intensity = 18.0f * (scale * scale * 0.04f);
        key.range = scale * 3.5f;
        key.castShadows = true;
        rig.addLight(key);

        // Fill Light: -60° azimuth, 15° elevation, cool sky tint
        Light fill;
        fill.name = "Fill_Light";
        fill.type = LightType::POINT;
        fill.position = Vec3(center.x - scale * 0.85f, center.y + scale * 0.35f, center.z + scale * 0.50f);
        fill.setKelvin(KELVIN_COOL_SKY);
        fill.intensity = key.intensity * fillRatio;
        fill.range = scale * 4.0f;
        fill.castShadows = false; // Soft fill does not cast hard secondary shadows
        rig.addLight(fill);

        // Rim / Kicker Light: 150° azimuth (behind), 45° elevation
        Light rim;
        rim.name = "Rim_Kicker";
        rim.type = LightType::POINT;
        rim.position = Vec3(center.x - scale * 0.30f, center.y + scale * 0.80f, center.z - scale * 0.90f);
        rim.color = Vec3(0.95f, 0.98f, 1.0f);
        rim.intensity = key.intensity * (rimIntensity / 1.8f);
        rim.range = scale * 3.0f;
        rim.castShadows = true;
        rig.addLight(rim);

        // Floor Bounce: Warm ambient bounce from below
        Light bounce;
        bounce.name = "Floor_Bounce";
        bounce.type = LightType::POINT;
        bounce.position = Vec3(center.x, center.y - scale * 0.40f, center.z);
        bounce.setKelvin(KELVIN_TUNGSTEN);
        bounce.intensity = key.intensity * 0.15f;
        bounce.range = scale * 2.5f;
        bounce.castShadows = false;
        rig.addLight(bounce);

        return rig;
    }

    /**
     * 2. Rembrandt Chiaroscuro Rig.
     * Steep 45° angle high key light producing the iconic inverted triangle of illumination
     * on the shadowed side of the subject, with rich, painterly shadows.
     */
    static LightingRig createRembrandtRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f,
        float keyKelvin = 4200.0f,
        bool highContrast = true
    ) {
        LightingRig rig;
        rig.name = "rembrandt_chiaroscuro";
        rig.ambientColor = Vec3(0.015f, 0.018f, 0.025f); // Deep dark chiaroscuro ambient

        // Key Spot: Steep 45° lateral, 45° elevation, focused spot with penumbra
        Light key;
        key.name = "Rembrandt_Key_Spot";
        key.type = LightType::SPOT;
        key.position = Vec3(center.x + scale * 0.85f, center.y + scale * 0.90f, center.z + scale * 0.85f);
        key.direction = (center - key.position).normalized();
        key.setKelvin(keyKelvin);
        key.intensity = 35.0f * (scale * scale * 0.04f);
        key.range = scale * 3.5f;
        key.innerConeAngle = 0.28f;
        key.outerConeAngle = 0.58f;
        key.castShadows = true;
        key.shadowSoftness = 0.65f; // Crisp shadow definition for triangle cheek edge
        rig.addLight(key);

        // Very subtle fill or passive bounce
        Light fill;
        fill.name = "Rembrandt_Shadow_Fill";
        fill.type = LightType::POINT;
        fill.position = Vec3(center.x - scale * 0.9f, center.y + scale * 0.2f, center.z + scale * 0.4f);
        fill.setKelvin(KELVIN_COOL_SKY);
        fill.intensity = key.intensity * (highContrast ? 0.08f : 0.16f);
        fill.range = scale * 3.5f;
        fill.castShadows = false;
        rig.addLight(fill);

        // Subtle background separation edge
        Light edge;
        edge.name = "Rembrandt_Hair_Edge";
        edge.type = LightType::POINT;
        edge.position = Vec3(center.x - scale * 0.4f, center.y + scale * 1.1f, center.z - scale * 0.8f);
        edge.color = Vec3(0.9f, 0.85f, 0.75f);
        edge.intensity = key.intensity * 0.45f;
        edge.range = scale * 2.8f;
        edge.castShadows = true;
        rig.addLight(edge);

        return rig;
    }

    /**
     * 3. Paramount / Butterfly Glamour Rig.
     * Symmetrical high frontal key directly in front, casting a butterfly-shaped shadow
     * directly under facial/geometric prominences, with a soft clamshell bounce from below.
     */
    static LightingRig createParamountGlamourRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f
    ) {
        LightingRig rig;
        rig.name = "paramount_glamour";

        // High Frontal Key
        Light key;
        key.name = "Butterfly_High_Key";
        key.type = LightType::SPOT;
        key.position = Vec3(center.x, center.y + scale * 1.15f, center.z + scale * 1.0f);
        key.direction = (center - key.position).normalized();
        key.setKelvin(5400.0f);
        key.intensity = 26.0f * (scale * scale * 0.04f);
        key.range = scale * 3.5f;
        key.innerConeAngle = 0.35f;
        key.outerConeAngle = 0.65f;
        key.castShadows = true;
        rig.addLight(key);

        // Clamshell Reflector Bounce from Below
        Light clamshell;
        clamshell.name = "Clamshell_Reflector";
        clamshell.type = LightType::POINT;
        clamshell.position = Vec3(center.x, center.y - scale * 0.35f, center.z + scale * 0.85f);
        clamshell.color = Vec3(1.0f, 0.98f, 0.95f);
        clamshell.intensity = key.intensity * 0.32f;
        clamshell.range = scale * 3.0f;
        clamshell.castShadows = false;
        rig.addLight(clamshell);

        // Dual Left & Right Hair Highlights
        for (float side : {-1.0f, 1.0f}) {
            Light hair;
            hair.name = side < 0 ? "Left_Hair_Rim" : "Right_Hair_Rim";
            hair.type = LightType::POINT;
            hair.position = Vec3(center.x + side * scale * 0.7f, center.y + scale * 0.9f, center.z - scale * 0.7f);
            hair.setKelvin(6500.0f);
            hair.intensity = key.intensity * 0.40f;
            hair.range = scale * 2.5f;
            hair.castShadows = true;
            rig.addLight(hair);
        }

        return rig;
    }

    /**
     * 4. Film Noir / Razor Split Rig.
     * High-contrast lateral 90° key dividing the subject exactly down the middle,
     * with deep velvety shadows and dramatic Venetian-blind / hard-shadow aesthetic.
     */
    static LightingRig createFilmNoirSplitRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f
    ) {
        LightingRig rig;
        rig.name = "film_noir_split";
        rig.ambientColor = Vec3(0.008f, 0.008f, 0.012f); // Pitch black ambient

        // Hard Lateral 90° Key
        Light key;
        key.name = "Noir_Split_Key";
        key.type = LightType::SPOT;
        key.position = Vec3(center.x + scale * 1.25f, center.y + scale * 0.25f, center.z);
        key.direction = (center - key.position).normalized();
        key.color = Vec3(1.0f, 0.97f, 0.92f);
        key.intensity = 42.0f * (scale * scale * 0.04f);
        key.range = scale * 3.5f;
        key.innerConeAngle = 0.22f;
        key.outerConeAngle = 0.48f;
        key.castShadows = true;
        key.shadowSoftness = 0.3f; // Razor sharp shadows
        rig.addLight(key);

        // Weak cold back rim
        Light rim;
        rim.name = "Noir_Back_Kicker";
        rim.type = LightType::POINT;
        rim.position = Vec3(center.x - scale * 0.8f, center.y + scale * 0.7f, center.z - scale * 0.9f);
        rim.setKelvin(9000.0f);
        rim.intensity = key.intensity * 0.18f;
        rim.range = scale * 3.0f;
        rim.castShadows = true;
        rig.addLight(rim);

        return rig;
    }

    /**
     * 5. Golden Hour & Diurnal Sunset Rig.
     * Low-elevation warm solar key (2400K) with long casting shadows,
     * azure sky dome fill, and warm ambient bounce.
     */
    static LightingRig createGoldenHourSunsetRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f,
        float sunAzimuthDeg = 250.0f,
        float sunElevationDeg = 8.0f
    ) {
        LightingRig rig;
        rig.name = "golden_hour_sunset";
        rig.ambientColor = Vec3(0.08f, 0.09f, 0.18f); // Twilight indigo sky ambient

        float azRad = sunAzimuthDeg * (PI / 180.0f);
        float elRad = sunElevationDeg * (PI / 180.0f);

        Vec3 sunDir(
            std::cos(elRad) * std::sin(azRad),
            std::sin(elRad),
            std::cos(elRad) * std::cos(azRad)
        );

        // Low-elevation Solar Key
        Light sun;
        sun.name = "Golden_Hour_Sun";
        sun.type = LightType::DIRECTIONAL;
        sun.direction = -sunDir;
        sun.setKelvin(2400.0f);
        sun.intensity = 8.5f; // Lux
        sun.castShadows = true;
        sun.shadowSoftness = 1.4f; // Solar disk penumbra
        rig.addLight(sun);

        // Sky Dome Zenith Fill
        Light skyFill;
        skyFill.name = "Azure_Sky_Dome_Fill";
        skyFill.type = LightType::DIRECTIONAL;
        skyFill.direction = Vec3(0.0f, -1.0f, 0.0f);
        skyFill.setKelvin(8500.0f);
        skyFill.intensity = 1.6f;
        skyFill.castShadows = false;
        rig.addLight(skyFill);

        // Warm Earth/Ground Bounce
        Light groundBounce;
        groundBounce.name = "Terrain_Warm_Bounce";
        groundBounce.type = LightType::POINT;
        groundBounce.position = Vec3(center.x, center.y - scale * 0.5f, center.z);
        groundBounce.color = Vec3(0.65f, 0.38f, 0.18f);
        groundBounce.intensity = 4.0f;
        groundBounce.range = scale * 4.0f;
        groundBounce.castShadows = false;
        rig.addLight(groundBounce);

        return rig;
    }

    /**
     * 6. Cyberpunk Dual-Rim Neon Rig.
     * Opposing high-intensity electric cyan and astral magenta/amethyst rims
     * with dark moody navy ambient.
     */
    static LightingRig createCyberpunkDualRimRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f
    ) {
        LightingRig rig;
        rig.name = "cyberpunk_dual_rim";
        rig.ambientColor = Vec3(0.015f, 0.02f, 0.04f); // Deep navy ambient

        // Left Rim: Electric Cyan (#00f3ff)
        Light cyanRim;
        cyanRim.name = "Electric_Cyan_Kicker";
        cyanRim.type = LightType::SPOT;
        cyanRim.position = Vec3(center.x - scale * 0.95f, center.y + scale * 0.75f, center.z - scale * 0.8f);
        cyanRim.direction = (center - cyanRim.position).normalized();
        cyanRim.color = Vec3(0.0f, 0.95f, 1.0f);
        cyanRim.intensity = 32.0f * (scale * scale * 0.04f);
        cyanRim.range = scale * 3.5f;
        cyanRim.innerConeAngle = 0.32f;
        cyanRim.outerConeAngle = 0.65f;
        cyanRim.castShadows = true;
        rig.addLight(cyanRim);

        // Right Rim: Astral Magenta / Amethyst (#ff00aa)
        Light magentaRim;
        magentaRim.name = "Astral_Magenta_Kicker";
        magentaRim.type = LightType::SPOT;
        magentaRim.position = Vec3(center.x + scale * 0.95f, center.y + scale * 0.75f, center.z - scale * 0.8f);
        magentaRim.direction = (center - magentaRim.position).normalized();
        magentaRim.color = Vec3(1.0f, 0.05f, 0.65f);
        magentaRim.intensity = 32.0f * (scale * scale * 0.04f);
        magentaRim.range = scale * 3.5f;
        magentaRim.innerConeAngle = 0.32f;
        magentaRim.outerConeAngle = 0.65f;
        magentaRim.castShadows = true;
        rig.addLight(magentaRim);

        // Center Low Key: Subtle Cool White Fill
        Light key;
        key.name = "Cyberpunk_Key_Fill";
        key.type = LightType::POINT;
        key.position = Vec3(center.x, center.y + scale * 0.4f, center.z + scale * 0.9f);
        key.color = Vec3(0.75f, 0.85f, 1.0f);
        key.intensity = 8.0f * (scale * scale * 0.04f);
        key.range = scale * 2.8f;
        key.castShadows = false;
        rig.addLight(key);

        return rig;
    }

    /**
     * 7. Torchlight & Campfire Rig.
     * Warm 1850K flame with flickering position, cold midnight moonlight fill.
     */
    static LightingRig createTorchlightCampfireRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f,
        float flickerIntensity = 1.0f
    ) {
        LightingRig rig;
        rig.name = "torchlight_campfire";
        rig.ambientColor = Vec3(0.01f, 0.015f, 0.035f); // Night cave / wilderness ambient

        // Flame Point Light
        Light torch;
        torch.name = "Torch_Flame_Key";
        torch.type = LightType::POINT;
        torch.position = Vec3(center.x + 0.15f, center.y - scale * 0.1f, center.z + scale * 0.45f);
        torch.setKelvin(KELVIN_CANDLE);
        torch.intensity = 22.0f * flickerIntensity * (scale * scale * 0.04f);
        torch.range = scale * 2.8f;
        torch.castShadows = true;
        rig.addLight(torch);

        // Cold Moonlight Overhead Fill
        Light moon;
        moon.name = "Cold_Moonlight_Fill";
        moon.type = LightType::DIRECTIONAL;
        moon.direction = Vec3(0.3f, -0.9f, 0.2f).normalized();
        moon.setKelvin(KELVIN_MOONLIGHT);
        moon.intensity = 0.75f;
        moon.castShadows = true;
        rig.addLight(moon);

        return rig;
    }

    /**
     * 8. High-Key Product Commercial Rig.
     * Clean, even, shadowless wrap lighting designed for product design and clean technical viewing.
     */
    static LightingRig createHighKeyProductRig(
        const Vec3& center = Vec3(0, 1.0f, 0),
        float scale = 5.0f
    ) {
        LightingRig rig;
        rig.name = "high_key_product";
        rig.ambientColor = Vec3(0.25f, 0.25f, 0.25f); // Bright clean ambient

        // 3 Large Diffused Wrap Lights surrounding subject
        for (int i = 0; i < 3; ++i) {
            float angle = static_cast<float>(i) * (TWO_PI / 3.0f);
            Light wrap;
            wrap.name = "High_Key_Wrap_" + std::to_string(i + 1);
            wrap.type = LightType::POINT;
            wrap.position = Vec3(
                center.x + std::sin(angle) * scale * 1.1f,
                center.y + scale * 0.65f,
                center.z + std::cos(angle) * scale * 1.1f
            );
            wrap.setKelvin(5800.0f);
            wrap.intensity = 14.0f * (scale * scale * 0.04f);
            wrap.range = scale * 3.5f;
            wrap.castShadows = (i == 0); // Only 1 key casts soft shadow
            rig.addLight(wrap);
        }

        return rig;
    }
};

// ============================================================================
// 4. Multi-Light PBR Direct Illumination Solver
// ============================================================================

/**
 * Evaluates complete multi-light PBR direct illumination across a surface point.
 * Integrates Cook-Torrance GGX specular, Disney-Burley diffuse, and Charlie sheen.
 */
inline pbr::BRDFEvalResult evaluateRigPbrIllumination(
    const LightingRig& rig,
    const geometry::PbrMaterial& material,
    const Vec3& surfacePos,
    const Vec3& surfaceNormal,
    const Vec3& viewDir,
    float shadowFactor = 1.0f
) {
    pbr::BRDFEvalResult totalRes;
    Vec3 N = surfaceNormal.normalized();
    Vec3 V = viewDir.normalized();

    for (const auto& light : rig.lights) {
        DirectIllumination direct = evaluateLightIncident(light, surfacePos);
        if (!direct.valid) continue;

        float shadow = light.castShadows ? shadowFactor : 1.0f;
        Vec3 lightRadiance = direct.incidentRadiance * shadow;

        pbr::BRDFEvalResult lightRes = pbr::evaluatePbrBRDF(
            material,
            N,
            V,
            direct.L,
            lightRadiance
        );

        totalRes.diffuseComponent += lightRes.diffuseComponent;
        totalRes.specularComponent += lightRes.specularComponent;
        totalRes.clearcoatComponent += lightRes.clearcoatComponent;
        totalRes.sheenComponent += lightRes.sheenComponent;
        totalRes.transmissionComponent += lightRes.transmissionComponent;
    }

    // Add ambient baseline
    Vec3 baseColor(material.baseColorFactor.x, material.baseColorFactor.y, material.baseColorFactor.z);
    Vec3 ambient = baseColor * rig.ambientColor;
    totalRes.diffuseComponent += ambient;

    totalRes.totalRadiance = totalRes.diffuseComponent +
                             totalRes.specularComponent +
                             totalRes.clearcoatComponent +
                             totalRes.sheenComponent +
                             totalRes.transmissionComponent;
    totalRes.total = totalRes.totalRadiance;
    totalRes.diffuse = totalRes.diffuseComponent;
    totalRes.specular = totalRes.specularComponent;
    totalRes.clearcoat = totalRes.clearcoatComponent;
    totalRes.sheen = totalRes.sheenComponent;
    totalRes.transmission = totalRes.transmissionComponent;

    return totalRes;
}

// ============================================================================
// 5. Lightweight Scene Budgeting & Optimization Engine
// ============================================================================

struct ScenePerformanceMetrics {
    size_t totalVertices{0};
    size_t totalTriangles{0};
    size_t activeLights{0};
    size_t shadowCastingLights{0};
    size_t estimatedDrawCalls{1};
    size_t estimatedMemoryBytes{0};
    float estimatedFrameTimeMs{0.0f}; // Target: < 16.6ms for 60 FPS
    bool withinWebBudget{true};
    std::vector<std::string> optimizationRecommendations;
};

class SceneBudgetAnalyzer {
public:
    /**
     * Evaluates a scene against lightweight WebGL / mobile real-time performance budgets.
     */
    static ScenePerformanceMetrics analyze(
        size_t vertexCount,
        size_t triangleCount,
        const std::vector<Light>& lights,
        size_t instanceCount = 1,
        size_t uniqueMaterials = 1
    ) {
        ScenePerformanceMetrics metrics;
        metrics.totalVertices = vertexCount;
        metrics.totalTriangles = triangleCount;
        metrics.activeLights = lights.size();

        for (const auto& l : lights) {
            if (l.castShadows) metrics.shadowCastingLights++;
        }

        // Draw call estimation: 1 per unique material + shadow map passes
        metrics.estimatedDrawCalls = uniqueMaterials + (metrics.shadowCastingLights * 2);
        if (instanceCount > 1) {
            // Hardware instancing keeps draw call to 1 per instanced batch
            metrics.estimatedDrawCalls = std::max(size_t{1}, metrics.estimatedDrawCalls);
        }

        // Memory estimate: 32 bytes per vertex + 6 bytes per triangle index + textures
        metrics.estimatedMemoryBytes = (vertexCount * 32) + (triangleCount * 6);

        // Frame time empirical model (WebGL on average hardware):
        // 0.00015ms per triangle + 0.5ms per shadow-casting light + 0.1ms per draw call + 1.2ms base overhead
        float triMs = static_cast<float>(triangleCount) * 0.00015f;
        float shadowMs = static_cast<float>(metrics.shadowCastingLights) * 0.85f;
        float drawCallMs = static_cast<float>(metrics.estimatedDrawCalls) * 0.12f;
        metrics.estimatedFrameTimeMs = 1.5f + triMs + shadowMs + drawCallMs;

        // Web budget threshold: 60 FPS = 16.67ms
        metrics.withinWebBudget = (metrics.estimatedFrameTimeMs <= 16.67f) && (triangleCount <= 100000);

        // Generate tailored optimization suggestions
        if (triangleCount > 50000) {
            metrics.optimizationRecommendations.push_back("Decimate distant geometry with Garland-Heckbert QEM LOD pyramids.");
        }
        if (metrics.shadowCastingLights > 2) {
            metrics.optimizationRecommendations.push_back("Disable shadow casting on secondary fill and bounce lights to reduce shadow passes.");
        }
        if (instanceCount > 8) {
            metrics.optimizationRecommendations.push_back("Consolidate scattered props into EXT_mesh_gpu_instancing single-draw-call batches.");
        }
        if (metrics.estimatedMemoryBytes > 8 * 1024 * 1024) {
            metrics.optimizationRecommendations.push_back("Quantize vertex attributes (KHR_mesh_quantization) to reduce bandwidth by ~65%.");
        }

        return metrics;
    }
};

// ============================================================================
// 6. Photometric Presets & Gobo/Cookie Attenuation
// ============================================================================

namespace photometric {

/**
 * Standard photographic illuminance presets in Lux (lumens / m^2)
 */
constexpr float LUX_DIRECT_SUNLIGHT     = 100000.0f;
constexpr float LUX_DAYLIGHT_OVERCAST   = 15000.0f;
constexpr float LUX_GOLDEN_HOUR_HORIZON = 1000.0f;
constexpr float LUX_INTERIOR_STUDIO     = 750.0f;
constexpr float LUX_INTERIOR_OFFICE     = 450.0f;
constexpr float LUX_INTERIOR_DIM        = 100.0f;
constexpr float LUX_CANDLELIGHT_1M      = 1.0f;
constexpr float LUX_FULL_MOONLIGHT      = 0.25f;
constexpr float LUX_STARLIGHT_CLEAR     = 0.001f;

inline Light createSunlight(const Vec3& dir, float lux = LUX_DIRECT_SUNLIGHT, float kelvin = KELVIN_D65_NOON) {
    Light l;
    l.name = "PhotometricSun";
    l.type = LightType::DIRECTIONAL;
    l.direction = dir.normalized();
    l.intensity = lux;
    l.setKelvin(kelvin);
    l.castShadows = true;
    return l;
}

inline Light createStudioKey(const Vec3& pos, const Vec3& target, float lumens = 12000.0f, float kelvin = KELVIN_STUDIO_HALOGEN) {
    Light l;
    l.name = "StudioKey";
    l.type = LightType::SPOT;
    l.position = pos;
    l.direction = (target - pos).normalized();
    l.intensity = lumensToCandela(lumens);
    l.setKelvin(kelvin);
    l.innerConeAngle = 0.35f;
    l.outerConeAngle = 0.65f;
    l.castShadows = true;
    return l;
}

} // namespace photometric

class GoboProjector {
public:
    /**
     * Evaluates procedural shadow cookie / gobo attenuation.
     * Simulates sunlight filtered through swaying tree canopies or venetian window blinds.
     */
    static float evaluateCanopyCookie(const Vec3& worldPos, float time = 0.0f, float scale = 0.8f) {
        float cx = worldPos.x * scale + std::sin(time * 0.5f) * 0.1f;
        float cz = worldPos.z * scale + std::cos(time * 0.4f) * 0.1f;
        float n1 = math::FastNoise3D::perlin(cx * 2.0f, 0.0f, cz * 2.0f, 42);
        float n2 = math::FastNoise3D::perlin(cx * 5.0f, 0.0f, cz * 5.0f, 84);
        float foliageDensity = std::clamp(n1 * 0.6f + n2 * 0.4f + 0.3f, 0.0f, 1.0f);
        // Soft dappled light transmission
        return math::smoothstep(0.35f, 0.75f, foliageDensity);
    }

    static float evaluateVenetianBlinds(const Vec3& worldPos, float slatSpacing = 0.15f, float slatOpenRatio = 0.6f) {
        float y = worldPos.y / slatSpacing;
        float frac = y - std::floor(y);
        return math::smoothstep(1.0f - slatOpenRatio - 0.05f, 1.0f - slatOpenRatio + 0.05f, frac);
    }
};

} // namespace lighting
} // namespace scratchbox

#endif // SCRATCHBOX_LIGHTING_HPP
