/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LIGHTING_HPP
#define SCRATCHBOX_LIGHTING_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_pbr.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_ephemeris.hpp"
#include "scratchbox_atmosphere.hpp"
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

// ============================================================================
// 7. Cinematographic Light Path Bounces & Indirect Shaping (Blender/Cycles & Real-Time)
// ============================================================================

namespace bounce {

/**
 * Ray classification flags mimicking Blender's Light Path input node.
 */
enum RayType : uint32_t {
    RAY_CAMERA          = 1 << 0, // Direct eye / primary camera ray
    RAY_SHADOW          = 1 << 1, // Shadow testing ray
    RAY_DIFFUSE_BOUNCE  = 1 << 2, // Indirect diffuse reflection
    RAY_GLOSSY_BOUNCE   = 1 << 3, // Specular / glossy reflection
    RAY_TRANSMISSION    = 1 << 4, // Refractive transmission through dielectric
    RAY_VOLUME          = 1 << 5  // Participating media volumetric scatter
};

/**
 * Production bounce limits and diminishing returns law calculator.
 * Energy drops exponentially with diffuse bounces: E_n = E_0 * (R_avg)^n
 */
struct LightPathBounceBudget {
    int maxTotalBounces = 12;
    int diffuseBounces = 3;
    int glossyBounces = 4;
    int transmissionBounces = 12;
    int transparentBounces = 32;
    int volumeBounces = 0;

    /**
     * Calculates remaining energy ratio at bounce n for average albedo rAvg.
     */
    static float calculateRemainingEnergy(float rAvg, int bounce) {
        if (bounce <= 0) return 1.0f;
        return std::pow(std::clamp(rAvg, 0.0f, 1.0f), static_cast<float>(bounce));
    }

    static LightPathBounceBudget exteriorSunlight() {
        return { 8, 2, 4, 8, 24, 0 };
    }

    static LightPathBounceBudget interiorArchviz() {
        return { 16, 4, 5, 12, 32, 1 };
    }

    static LightPathBounceBudget studioCharacter() {
        return { 12, 3, 6, 8, 16, 0 };
    }

    static LightPathBounceBudget transmissiveGlass() {
        return { 24, 2, 6, 16, 32, 0 };
    }

    static LightPathBounceBudget foliageCanopy() {
        return { 16, 2, 4, 8, 64, 0 };
    }
};

/**
 * Albedo Decoupler (Taming Color Bleed).
 * Production hack: camera rays receive the rich base color texture,
 * while indirect diffuse rays receive an art-directed desaturated/dimmed albedo.
 * Eliminates radioactive, cartoonish neon color bleed on adjacent neutral geometry.
 */
class AlbedoDecoupler {
public:
    static Vec3 evaluatePerceivedAlbedo(
        const Vec3& baseAlbedo,
        uint32_t rayFlags,
        float indirectSaturation = 0.35f,
        float indirectAlbedoMultiplier = 0.75f
    ) {
        // Direct camera, glossy reflections, or shadow rays see true full-fidelity albedo
        if (rayFlags & (RAY_CAMERA | RAY_GLOSSY_BOUNCE)) {
            return baseAlbedo;
        }

        // Indirect diffuse bounce: desaturate and scale to prevent violent color bleeding
        if (rayFlags & RAY_DIFFUSE_BOUNCE) {
            float luma = 0.2126f * baseAlbedo.x + 0.7152f * baseAlbedo.y + 0.0722f * baseAlbedo.z;
            Vec3 gray(luma, luma, luma);
            Vec3 desaturated = gray + (baseAlbedo - gray) * std::clamp(indirectSaturation, 0.0f, 1.0f);
            return desaturated * std::clamp(indirectAlbedoMultiplier, 0.0f, 2.0f);
        }

        return baseAlbedo;
    }
};

/**
 * Architectural Glass Shadow Ray Bypass.
 * In production archviz, dielectric glass casts dark shadows unless thousands of caustics converge.
 * This evaluator sets shadow ray transmittance to 1.0 (bypassing glass absorption),
 * allowing direct exterior daylight to flood interior rooms with zero noise.
 */
class ArchitecturalGlassBypass {
public:
    static float evaluateTransmittance(
        uint32_t rayFlags,
        float physicalTransmittance = 0.90f
    ) {
        // Shadow rays see a 100% transparent void (caustic bypass)
        if (rayFlags & RAY_SHADOW) {
            return 1.0f;
        }
        // Camera and secondary bounces observe genuine dielectric transmission
        return physicalTransmittance;
    }
};

/**
 * Virtual Polyboard (Positive Bounce Card).
 * Simulates a large off-camera white reflector plane (foam-core / beadboard)
 * struck by key or environmental light to cast soft-wrap, organic fill light.
 */
struct CinematicBounceCard {
    Vec3 position;       // Center of reflector card
    Vec3 normal;         // Card surface normal pointing toward the subject
    float width = 30.0f; // Width in scene units
    float height = 20.0f;// Height in scene units
    float reflectance = 0.92f; // High diffuse albedo (non-metallic)
    Vec3 tint = Vec3(1.0f, 0.96f, 0.90f); // Warm natural bounce
    float intensity = 1.0f; // Lighting power multiplier

    /**
     * Evaluates bounced illuminance at a receiver surface point p with normal n.
     */
    Vec3 evaluateBounceIlluminance(
        const Vec3& receiverPos,
        const Vec3& receiverNormal,
        const Vec3& incidentRadiance // Direct light hitting the card
    ) const {
        Vec3 toReceiver = receiverPos - position;
        float distSq = toReceiver.lengthSquared();
        if (distSq < 0.001f) return Vec3(0.0f, 0.0f, 0.0f);

        float dist = std::sqrt(distSq);
        Vec3 dirFromCard = toReceiver / dist;

        // Card emission geometry factor: card must face the receiver
        float cosCard = std::max(0.0f, normal.dot(dirFromCard));
        if (cosCard <= 0.0f) return Vec3(0.0f, 0.0f, 0.0f);

        // Receiver absorption factor: receiver must face the card
        float cosReceiver = std::max(0.0f, receiverNormal.dot(-dirFromCard));
        if (cosReceiver <= 0.0f) return Vec3(0.0f, 0.0f, 0.0f);

        // Area of reflector
        float area = width * height;

        // Extended-source solid angle approximation with Lambertian falloff
        float geometricFormFactor = (cosCard * cosReceiver * area) / (distSq + area / PI);
        float bounceScale = (reflectance / PI) * geometricFormFactor * intensity;

        return Vec3(
            incidentRadiance.x * tint.x * bounceScale,
            incidentRadiance.y * tint.y * bounceScale,
            incidentRadiance.z * tint.z * bounceScale
        );
    }
};

/**
 * Negative Fill Card (The Sculptural Chiaroscuro Secret).
 * Simulates a large off-camera matte black velvet plane that absorbs ambient skylight
 * and multi-bounce GI on the unlit side of the subject, restoring dramatic contrast.
 */
struct NegativeFillCard {
    Vec3 position;       // Center of absorbing card
    Vec3 normal;         // Absorber normal facing the subject
    float width = 25.0f;
    float height = 25.0f;
    float absorptionStrength = 0.65f; // 0.0 = no effect, 1.0 = total ambient absorption

    /**
     * Evaluates the ambient attenuation factor (1.0 = unoccluded, < 1.0 = shadowed by negative fill).
     */
    float evaluateAmbientAttenuation(
        const Vec3& receiverPos,
        const Vec3& receiverNormal
    ) const {
        Vec3 toReceiver = receiverPos - position;
        float distSq = toReceiver.lengthSquared();
        if (distSq < 0.001f) return 1.0f;

        float dist = std::sqrt(distSq);
        Vec3 dirFromCard = toReceiver / dist;

        // Card must face receiver
        float cosCard = std::max(0.0f, normal.dot(dirFromCard));
        if (cosCard <= 0.0f) return 1.0f;

        // Receiver faces card
        float cosReceiver = std::max(0.0f, receiverNormal.dot(-dirFromCard));
        if (cosReceiver <= 0.0f) return 1.0f;

        float area = width * height;
        // Estimated solid angle fraction of hemisphere subtended by the card
        float solidAngleFraction = (cosCard * cosReceiver * area) / (TWO_PI * distSq + area);
        solidAngleFraction = std::clamp(solidAngleFraction, 0.0f, 1.0f);

        // Attenuate ambient light arriving at receiver
        return std::clamp(1.0f - (solidAngleFraction * absorptionStrength), 0.0f, 1.0f);
    }
};

/**
 * Indirect Light Clamper (Firefly Suppression).
 * Clamps high-energy indirect sample spikes without truncating direct HDR specular highlights.
 */
class IndirectLightClamper {
public:
    static Vec3 clampRadiance(
        const Vec3& radiance,
        uint32_t rayFlags,
        float directClamp = 0.0f,    // 0.0 = unclamped
        float indirectClamp = 15.0f  // Standard production indirect clamp (10.0 - 20.0)
    ) {
        if (rayFlags & (RAY_CAMERA | RAY_SHADOW)) {
            if (directClamp > 0.0f) {
                float maxComp = std::max({radiance.x, radiance.y, radiance.z});
                if (maxComp > directClamp) {
                    return radiance * (directClamp / maxComp);
                }
            }
            return radiance;
        }

        // Indirect rays (diffuse, glossy, volume)
        if (indirectClamp > 0.0f) {
            float maxComp = std::max({radiance.x, radiance.y, radiance.z});
            if (maxComp > indirectClamp) {
                return radiance * (indirectClamp / maxComp);
            }
        }
        return radiance;
    }
};

} // namespace bounce

// ============================================================================
// 8. Cinematic Shadows & Contact-Hardening PCSS (Percentage-Closer Soft Shadows)
// ============================================================================

namespace shadow {

/**
 * Physical solar angular dimensions observed from Earth surface.
 * Mean apparent solar diameter is 32 arcminutes (~0.533 degrees = 0.009308 radians).
 */
constexpr float SOLAR_ANGULAR_DIAMETER_RAD = 0.0093084f; // ~0.533 degrees
constexpr float SOLAR_ANGULAR_RADIUS_RAD   = 0.0046542f; // ~0.266 degrees

/**
 * Solar Disk Optics & Distance-Adaptive Penumbra Estimator.
 * Computes exact physical optical penumbra width as a function of caster-to-receiver distance.
 */
struct SolarDiskOptics {
    float solarAngularDiameter = SOLAR_ANGULAR_DIAMETER_RAD;

    /**
     * Computes the world-space penumbra width at the receiver.
     * Uses similar triangles formed by the solar disc and occluder:
     * w_penumbra = ((d_receiver - d_blocker) / d_blocker) * lightSize
     * 
     * @param receiverDist Distance from light source to receiver point along light ray.
     * @param blockerDist  Distance from light source to average blocker along light ray.
     * @return World-space penumbra radius (0.0 at contact, expands with distance).
     */
    float computePenumbraRadius(float receiverDist, float blockerDist) const {
        if (blockerDist <= 0.001f || receiverDist <= blockerDist) {
            return 0.0f; // Pin-sharp contact shadow
        }
        float deltaDist = receiverDist - blockerDist;
        // In directional sun light, angular diameter subtends an effective source size:
        // w_penumbra = deltaDist * tan(theta_sun)
        return deltaDist * std::tan(solarAngularDiameter);
    }

    /**
     * Converts a world-space penumbra width into shadow map UV filter radius.
     */
    float computeShadowFilterRadius(
        float penumbraRadiusWorld,
        float frustumSpanWorld,
        uint32_t shadowMapSize,
        float minRadiusTexels = 1.0f,
        float maxRadiusTexels = 24.0f
    ) const {
        if (shadowMapSize == 0 || frustumSpanWorld <= 0.001f) return minRadiusTexels;
        float texelSizeWorld = (frustumSpanWorld * 2.0f) / static_cast<float>(shadowMapSize);
        float radiusTexels = penumbraRadiusWorld / texelSizeWorld;
        return std::clamp(radiusTexels, minRadiusTexels, maxRadiusTexels);
    }
};

/**
 * Vogel Disk Low-Discrepancy Sampling Generator.
 * Distributes samples using the golden angle (2.3999632 rad) for low-discrepancy circle packing,
 * eliminating pattern banding in blocker searches and PCF filtering.
 */
struct VogelDiskSampler {
    static constexpr float GOLDEN_ANGLE = 2.399963229728653f;

    /**
     * Generates a 2D sample position on a unit disk.
     * @param sampleIndex Index of the sample (0 to sampleCount - 1).
     * @param sampleCount Total number of samples.
     * @param phi Random rotation angle in radians (interleaved gradient noise).
     */
    static Vec2 sample(int sampleIndex, int sampleCount, float phi = 0.0f) {
        if (sampleCount <= 0) return Vec2(0.0f, 0.0f);
        float r = std::sqrt((static_cast<float>(sampleIndex) + 0.5f) / static_cast<float>(sampleCount));
        float theta = static_cast<float>(sampleIndex) * GOLDEN_ANGLE + phi;
        return Vec2(std::cos(theta) * r, std::sin(theta) * r);
    }

    /**
     * Generates a full array of Vogel disk samples for GPU shader uniforms.
     */
    static std::vector<Vec2> generateKernel(int sampleCount, float phi = 0.0f) {
        std::vector<Vec2> kernel;
        kernel.reserve(sampleCount);
        for (int i = 0; i < sampleCount; ++i) {
            kernel.push_back(sample(i, sampleCount, phi));
        }
        return kernel;
    }
};

/**
 * Auto-Calibrated Zero-Acne Bias Calculator.
 * Dynamically scales depth bias and normal bias to guarantee zero shadow acne (self-shadowing moiré)
 * while minimizing peter-panning (shadow detachment).
 */
struct AutoBiasCalculator {
    /**
     * Computes the optimal normal bias in world units based on shadow frustum scale and map resolution.
     * Formula: normalBias = 1.25 * texelSizeWorld
     */
    static float computeOptimalNormalBias(float frustumSpanWorld, uint32_t shadowMapSize) {
        if (shadowMapSize == 0) return 0.05f;
        float texelSize = (frustumSpanWorld * 2.0f) / static_cast<float>(shadowMapSize);
        return std::clamp(texelSize * 1.25f, 0.01f, 0.5f);
    }

    /**
     * Computes the optimal constant depth bias for an orthographic directional light.
     */
    static float computeOptimalDepthBias(float frustumDepthFar) {
        if (frustumDepthFar <= 0.0f) return 0.00002f;
        // High-precision depth bias scaled to avoid negative self-intersection
        return std::clamp(0.00002f * (400.0f / frustumDepthFar), 0.000005f, 0.0001f);
    }

    /**
     * Slope-scaled depth bias evaluation for a triangle with normal N and light direction L.
     */
    static float computeSlopeBias(const Vec3& normal, const Vec3& lightDir, float baseBias = 0.00002f) {
        float cosTheta = std::max(0.0f, normal.dot(lightDir));
        float sinTheta = std::sqrt(std::max(0.0f, 1.0f - cosTheta * cosTheta));
        float tanTheta = (cosTheta > 0.001f) ? (sinTheta / cosTheta) : 2.0f;
        return baseBias * (1.0f + std::clamp(tanTheta, 0.0f, 3.0f));
    }
};

/**
 * Shadow Camera Frustum Fitter.
 * Tight-fits an orthographic directional light projection to the focal landmark's bounding box,
 * maximizing texel density on architectural subjects and eliminating wasted shadow resolution.
 */
struct ShadowCameraFrustum {
    float halfWidth = 140.0f;
    float halfHeight = 140.0f;
    float nearPlane = 10.0f;
    float farPlane = 450.0f;
    Vec3 lightPosition;
    Vec3 lightTarget;

    float getTexelSize(uint32_t mapSize) const {
        return (mapSize > 0) ? ((halfWidth * 2.0f) / static_cast<float>(mapSize)) : 0.1f;
    }
};

class ShadowCameraFitter {
public:
    /**
     * Fits an orthographic directional light shadow camera tightly around a target bounding box.
     * 
     * @param boxMin Minimum corner of subject bounding box (world space).
     * @param boxMax Maximum corner of subject bounding box (world space).
     * @param lightDir Normalized vector pointing FROM the light TOWARDS the scene.
     * @param lightDistance Distance of light source origin from bounding center.
     * @param paddingFactor Expansion factor to prevent clipping on boundaries (e.g. 1.15).
     */
    static ShadowCameraFrustum fitToBoundingBox(
        const Vec3& boxMin,
        const Vec3& boxMax,
        const Vec3& lightDir,
        float lightDistance = 250.0f,
        float paddingFactor = 1.15f
    ) {
        ShadowCameraFrustum frustum;
        Vec3 center = (boxMin + boxMax) * 0.5f;
        Vec3 extents = (boxMax - boxMin) * 0.5f;
        float radius = extents.length() * paddingFactor;

        // Construct light-space coordinate frame
        Vec3 forward = lightDir.normalized();
        Vec3 up = (std::abs(forward.y) > 0.99f) ? Vec3(0, 0, 1) : Vec3(0, 1, 0);
        Vec3 right = forward.cross(up).normalized();
        up = right.cross(forward).normalized();

        // 8 corners of bounding box
        Vec3 corners[8] = {
            Vec3(boxMin.x, boxMin.y, boxMin.z),
            Vec3(boxMax.x, boxMin.y, boxMin.z),
            Vec3(boxMin.x, boxMax.y, boxMin.z),
            Vec3(boxMax.x, boxMax.y, boxMin.z),
            Vec3(boxMin.x, boxMin.y, boxMax.z),
            Vec3(boxMax.x, boxMin.y, boxMax.z),
            Vec3(boxMin.x, boxMax.y, boxMax.z),
            Vec3(boxMax.x, boxMax.y, boxMax.z)
        };

        float minX = 1e9f, maxX = -1e9f;
        float minY = 1e9f, maxY = -1e9f;
        float minZ = 1e9f, maxZ = -1e9f;

        for (int i = 0; i < 8; ++i) {
            Vec3 rel = corners[i] - center;
            float px = rel.dot(right);
            float py = rel.dot(up);
            float pz = rel.dot(forward);

            minX = std::min(minX, px);
            maxX = std::max(maxX, px);
            minY = std::min(minY, py);
            maxY = std::max(maxY, py);
            minZ = std::min(minZ, pz);
            maxZ = std::max(maxZ, pz);
        }

        float spanX = std::max(std::abs(minX), std::abs(maxX)) * paddingFactor;
        float spanY = std::max(std::abs(minY), std::abs(maxY)) * paddingFactor;
        float halfSpan = std::max({spanX, spanY, 40.0f});

        frustum.halfWidth = halfSpan;
        frustum.halfHeight = halfSpan;

        float depthSpan = (maxZ - minZ) * paddingFactor;
        float actualLightDist = std::max(lightDistance, depthSpan * 1.5f);

        frustum.nearPlane = 5.0f;
        frustum.farPlane = actualLightDist + depthSpan * 2.0f;
        frustum.lightTarget = center;
        frustum.lightPosition = center - forward * actualLightDist;

        return frustum;
    }
};

/**
 * Atmospheric Rayleigh Umbra Fill.
 * Computes non-pitch-black ambient fill for shadow umbras based on solar elevation,
 * ensuring architectural cavities preserve stone texture and optical depth.
 */
struct AtmosphericUmbraFill {
    /**
     * Calculates the linear RGB umbra fill radiance given solar elevation in degrees.
     * At midday: vibrant blue Rayleigh sky fill (~0x7dd3fc).
     * At golden hour: warm amber rim fill (~0xf59e0b).
     */
    static Vec3 computeUmbraRadiance(float solarElevationDeg, float fillIntensity = 0.35f) {
        float elevNorm = std::clamp(solarElevationDeg / 90.0f, 0.0f, 1.0f);
        // Midday sky blue (0.45, 0.70, 0.95) vs golden twilight (0.85, 0.55, 0.25)
        Vec3 middaySky(0.45f, 0.70f, 0.95f);
        Vec3 goldenSky(0.85f, 0.55f, 0.25f);

        Vec3 skyTint = goldenSky * (1.0f - elevNorm) + middaySky * elevNorm;
        return skyTint * fillIntensity;
    }
};

} // namespace shadow

// ============================================================================
// 9. Unified C++20 Real-Time Diurnal Lighting, Atmosphere & Shadow System
// ============================================================================

namespace diurnal {

/**
 * Complete synchronized diurnal frame state.
 * Unified across solar/lunar ephemeris, Planckian CCT, dual-lobe atmosphere,
 * analytical cloud shadow gobos, contact PCSS shadows, stone albedo de-lighting,
 * and architectural portal lighting.
 */
struct DiurnalLightingFrame {
    // 1. Geodetic & Ephemeris Geometry
    float latitudeDeg{41.8902f};
    float longitudeDeg{12.4922f};
    int64_t unixTimestampSeconds{0};
    float solarElevationDeg{0.0f};
    float solarAzimuthDeg{0.0f};
    math::Vec3 sunDirectionENU{0.0f, 0.0f, 1.0f};
    math::Vec3 sunDirectionThreeJS{0.0f, 1.0f, 0.0f};
    
    // Diurnal Phase classification
    std::string phase{"midday"};
    std::string phaseLabel{"Midday"};
    bool isDay{true};
    bool isNight{false};
    bool isGoldenHour{false};
    bool isBlueHour{false};
    bool isTwilight{false};

    // 2. Photometrics & Planckian Radiance
    float kelvin{5800.0f};
    math::Vec3 sunColorLinearRgb{1.0f, 0.98f, 0.95f};
    float sunIlluminanceLux{95000.0f};
    float sunIntensityUnit{1.45f};       // Normalized multiplier for 3D direct lights
    math::Vec3 skyAmbientLinearRgb{0.35f, 0.45f, 0.60f};
    float skyLightIntensityUnit{1.10f};  // Normalized multiplier for ambient/hemi lights
    math::Vec3 groundBounceTint{0.30f, 0.28f, 0.24f};
    float groundBounceWarmth{0.50f};

    // 3. Volumetric Atmosphere & Clouds
    float cloudCoverage{0.15f};
    float cloudDensityScale{1.0f};
    float scatterAnisotropy1{0.82f};      // Forward Mie scattering lobe (g1)
    float scatterAnisotropy2{-0.30f};     // Backscatter glory lobe (g2)
    float scatterAnisotropyMix{0.85f};
    float powderScale{1.50f};             // Andrew Schneider powdered sugar multiple scattering
    float cloudSkyLightScale{1.0f};
    float cloudGroundBounceScale{1.0f};
    float aerialAlbedoBoost{1.10f};
    math::Vec3 aerialExtinctionCoeff{1.0f, 1.0f, 1.0f}; // Multi-spectral Beer-Lambert transmission
    float bloomIntensityScale{1.0f};

    // 4. Analytical Cloud Shadows (Atmospheric Gobo)
    float cloudShadowTransmittance{1.0f}; // 0.20 (deep cloud shadow) to 1.0 (unoccluded direct sun)
    math::Vec2 cloudShadowUvOffset{0.0f, 0.0f};

    // 5. Cinematic Shadows & Contact-Hardening PCSS
    bool castShadows{true};
    float solarDiskAngularDiameter{0.0093084f}; // 32 arcminutes (0.533 degrees)
    float normalBiasMeters{0.080f};             // Auto-calibrated zero-acne normal bias
    float depthBias{0.000020f};                 // Auto-calibrated depth bias
    float penumbraScale{1.0f};
    math::Vec3 rayleighUmbraFill{0.15f, 0.24f, 0.33f};
    shadow::ShadowCameraFrustum shadowFrustum;

    // 6. Photogrammetry Tile De-Lighting & Stone Calibration
    float shadowLift{0.60f};
    float highlightCompress{0.45f};
    math::Vec3 stoneAlbedoTint{0.86f, 0.82f, 0.78f}; // Roman Travertine default
    std::string stoneType{"travertine"};

    // 7. Architectural Interior Portal Lighting (Blender VFX Trick for Dusk/Night)
    bool architecturalPortalsActive{false};
    float architecturalPortalIntensity{0.0f};   // 0.0 at midday -> 1.85 at twilight & night
    math::Vec3 architecturalPortalColor{1.0f, 0.72f, 0.42f}; // Warm incandescent 2,850K amber

    // 8. Film Tone Mapping & Photographic Exposure Adaptation
    float toneMappingExposure{0.65f};
};

class UnifiedTimeOfDaySystem {
public:
    static math::Vec3 getStoneAlbedo(std::string_view stoneType) {
        if (stoneType == "travertine") {
            return math::Vec3(0.86f, 0.82f, 0.78f); // Roman Travertine
        } else if (stoneType == "limestone") {
            return math::Vec3(0.82f, 0.81f, 0.79f); // Portland / Indiana Limestone
        } else if (stoneType == "marble") {
            return math::Vec3(0.92f, 0.91f, 0.90f); // Carrara Marble
        } else if (stoneType == "concrete") {
            return math::Vec3(0.75f, 0.75f, 0.75f); // Grey Concrete
        }
        return math::Vec3(0.86f, 0.82f, 0.78f);
    }

    /**
     * Continuous evaluation of full diurnal lighting, atmospheric, and shadow state
     * from explicit solar elevation and azimuth degrees.
     */
    static DiurnalLightingFrame evaluateFromAngles(
        float elevDeg,
        float azDeg,
        float cloudCoverage = 0.15f,
        float turbidity = 2.2f,
        std::string_view stoneType = "travertine",
        float timeSeconds = 0.0f,
        const math::Vec3& bboxMin = math::Vec3(-94.0f, 0.0f, -78.0f),
        const math::Vec3& bboxMax = math::Vec3(94.0f, 48.0f, 78.0f)
    ) {
        DiurnalLightingFrame f;
        f.solarElevationDeg = elevDeg;
        f.solarAzimuthDeg = azDeg;
        f.cloudCoverage = std::clamp(cloudCoverage, 0.0f, 1.0f);
        f.stoneType = std::string(stoneType);
        f.stoneAlbedoTint = getStoneAlbedo(stoneType);

        float azRad = azDeg * math::DEG_TO_RAD;
        float elRad = elevDeg * math::DEG_TO_RAD;

        // Three.js solar direction (+X=East, +Y=Up, -Z=North):
        f.sunDirectionThreeJS = math::Vec3(
            std::cos(elRad) * std::sin(azRad),
            std::sin(elRad),
            -std::cos(elRad) * std::cos(azRad)
        ).normalized();

        // Local ENU solar direction (+X=East, +Y=North, +Z=Up):
        f.sunDirectionENU = math::Vec3(
            std::cos(elRad) * std::sin(azRad),
            std::cos(elRad) * std::cos(azRad),
            std::sin(elRad)
        ).normalized();

        // Diurnal Phase Segmentation & Continuous Interpolation
        if (f.cloudCoverage > 0.75f && elevDeg > 5.0f) {
            // Overcast state overrides direct sun dominance
            f.phase = "overcast";
            f.phaseLabel = "Overcast";
            f.isDay = true;
            f.isNight = false;
            f.isGoldenHour = false;
            f.isBlueHour = false;
            f.isTwilight = false;
            f.kelvin = 6500.0f;
            f.sunIntensityUnit = 0.35f * (1.0f - f.cloudCoverage * 0.6f);
            f.skyLightIntensityUnit = 1.60f;
            f.castShadows = true;
            f.penumbraScale = 2.5f; // Heavily diffused shadows
            f.toneMappingExposure = 0.60f;
            f.bloomIntensityScale = 0.15f;
            f.cloudSkyLightScale = 1.45f;
            f.cloudGroundBounceScale = 0.40f;
            f.powderScale = 0.85f;
            f.scatterAnisotropy1 = 0.75f;
            f.skyAmbientLinearRgb = math::Vec3(0.55f, 0.60f, 0.68f);
        } else if (elevDeg <= -12.0f) {
            f.phase = "deep_night";
            f.phaseLabel = "Deep Night";
            f.isDay = false;
            f.isNight = true;
            f.isGoldenHour = false;
            f.isBlueHour = false;
            f.isTwilight = false;
            f.kelvin = 15000.0f; // Starlight Kelvin
            f.sunIntensityUnit = 0.04f; // Moonlight key
            f.skyLightIntensityUnit = 0.06f;
            f.castShadows = false;
            f.toneMappingExposure = 0.32f;
            f.bloomIntensityScale = 0.0f;
            f.cloudSkyLightScale = 0.15f;
            f.cloudGroundBounceScale = 0.05f;
            f.powderScale = 0.50f;
            f.scatterAnisotropy1 = 0.75f;
            f.skyAmbientLinearRgb = math::Vec3(0.04f, 0.05f, 0.08f);
            f.architecturalPortalsActive = true;
            f.architecturalPortalIntensity = 1.85f;
        } else if (elevDeg <= -4.0f) {
            // Nautical twilight to blue hour
            float t = math::smoothstep(-12.0f, -4.0f, elevDeg);
            f.phase = "blue_hour";
            f.phaseLabel = "Blue Hour";
            f.isDay = false;
            f.isNight = false;
            f.isGoldenHour = false;
            f.isBlueHour = true;
            f.isTwilight = true;
            f.kelvin = math::lerp(15000.0f, 9500.0f, t);
            f.sunIntensityUnit = 0.0f;
            f.skyLightIntensityUnit = math::lerp(0.06f, 0.28f, t);
            f.castShadows = false;
            f.toneMappingExposure = math::lerp(0.32f, 0.42f, t);
            f.bloomIntensityScale = math::lerp(0.0f, 0.40f, t);
            f.cloudSkyLightScale = math::lerp(0.15f, 0.35f, t);
            f.cloudGroundBounceScale = math::lerp(0.05f, 0.15f, t);
            f.powderScale = 0.60f;
            f.scatterAnisotropy1 = 0.76f;
            f.skyAmbientLinearRgb = math::Vec3(0.15f, 0.20f, 0.42f); // Deep cobalt Rayleigh
            f.architecturalPortalsActive = true;
            f.architecturalPortalIntensity = math::lerp(1.85f, 1.40f, t);
        } else if (elevDeg <= 0.0f) {
            // Civil twilight
            float t = math::smoothstep(-4.0f, 0.0f, elevDeg);
            f.phase = "twilight";
            f.phaseLabel = "Civil Twilight";
            f.isDay = false;
            f.isNight = false;
            f.isGoldenHour = false;
            f.isBlueHour = false;
            f.isTwilight = true;
            f.kelvin = math::lerp(9500.0f, 3200.0f, t);
            f.sunIntensityUnit = math::lerp(0.0f, 0.25f, t);
            f.skyLightIntensityUnit = math::lerp(0.28f, 0.45f, t);
            f.castShadows = (elevDeg > -1.0f);
            f.toneMappingExposure = math::lerp(0.42f, 0.50f, t);
            f.bloomIntensityScale = math::lerp(0.40f, 0.70f, t);
            f.cloudSkyLightScale = math::lerp(0.35f, 0.55f, t);
            f.cloudGroundBounceScale = math::lerp(0.15f, 0.25f, t);
            f.powderScale = 0.65f;
            f.scatterAnisotropy1 = 0.78f;
            f.skyAmbientLinearRgb = math::Vec3(0.24f, 0.28f, 0.45f);
            f.architecturalPortalsActive = true;
            f.architecturalPortalIntensity = math::lerp(1.40f, 0.65f, t);
        } else if (elevDeg <= 10.0f) {
            // Golden Hour / Sunset / Dawn
            float t = math::smoothstep(0.0f, 10.0f, elevDeg);
            f.phase = (elevDeg <= 3.5f) ? "dawn" : "golden";
            f.phaseLabel = (elevDeg <= 3.5f) ? "Dawn" : "Golden Hour";
            f.isDay = true;
            f.isNight = false;
            f.isGoldenHour = true;
            f.isBlueHour = false;
            f.isTwilight = false;
            f.kelvin = math::lerp(2200.0f, 4200.0f, t);
            f.sunIntensityUnit = math::lerp(0.25f, 1.50f, t);
            f.skyLightIntensityUnit = math::lerp(0.45f, 0.95f, t);
            f.castShadows = true;
            f.penumbraScale = math::lerp(1.8f, 1.1f, t);
            f.toneMappingExposure = math::lerp(0.50f, 0.62f, t);
            f.bloomIntensityScale = math::lerp(0.70f, 1.25f, t);
            f.cloudSkyLightScale = math::lerp(0.55f, 1.0f, t);
            f.cloudGroundBounceScale = math::lerp(0.25f, 0.75f, t);
            f.powderScale = math::lerp(0.70f, 1.30f, t);
            f.scatterAnisotropy1 = 0.82f;
            f.skyAmbientLinearRgb = math::Vec3(0.45f, 0.38f, 0.32f); // Warm amber horizon
            f.architecturalPortalsActive = (elevDeg <= 3.0f);
            f.architecturalPortalIntensity = (elevDeg <= 3.0f) ? math::lerp(0.65f, 0.0f, elevDeg / 3.0f) : 0.0f;
        } else if (elevDeg <= 35.0f) {
            // Morning / Late Afternoon
            float t = math::smoothstep(10.0f, 35.0f, elevDeg);
            f.phase = (azDeg < 180.0f) ? "morning" : "afternoon";
            f.phaseLabel = (azDeg < 180.0f) ? "Morning" : "Afternoon";
            f.isDay = true;
            f.isNight = false;
            f.isGoldenHour = false;
            f.isBlueHour = false;
            f.isTwilight = false;
            f.kelvin = math::lerp(4200.0f, 5600.0f, t);
            f.sunIntensityUnit = math::lerp(1.50f, 1.55f, t);
            f.skyLightIntensityUnit = math::lerp(0.95f, 1.05f, t);
            f.castShadows = true;
            f.penumbraScale = 1.0f;
            f.toneMappingExposure = math::lerp(0.62f, 0.65f, t);
            f.bloomIntensityScale = 1.0f;
            f.cloudSkyLightScale = 1.0f;
            f.cloudGroundBounceScale = 1.0f;
            f.powderScale = 1.50f;
            f.scatterAnisotropy1 = 0.82f;
            f.skyAmbientLinearRgb = math::Vec3(0.35f, 0.45f, 0.60f);
            f.architecturalPortalsActive = false;
            f.architecturalPortalIntensity = 0.0f;
        } else {
            // Midday
            f.phase = "midday";
            f.phaseLabel = "Midday";
            f.isDay = true;
            f.isNight = false;
            f.isGoldenHour = false;
            f.isBlueHour = false;
            f.isTwilight = false;
            f.kelvin = 5800.0f;
            f.sunIntensityUnit = 1.55f;
            f.skyLightIntensityUnit = 1.10f;
            f.castShadows = true;
            f.penumbraScale = 1.0f;
            f.toneMappingExposure = 0.65f;
            f.bloomIntensityScale = 1.0f;
            f.cloudSkyLightScale = 1.0f;
            f.cloudGroundBounceScale = 1.0f;
            f.powderScale = 1.50f;
            f.scatterAnisotropy1 = 0.82f;
            f.skyAmbientLinearRgb = math::Vec3(0.35f, 0.45f, 0.60f);
            f.architecturalPortalsActive = false;
            f.architecturalPortalIntensity = 0.0f;
        }

        // Continuous Cloud Scattering & Direct/Diffuse Lighting Modulation
        if (f.cloudCoverage > 0.0f && f.phase != "overcast" && elevDeg > 0.0f) {
            float tauCloud = f.cloudCoverage * 0.28f * 4.5f;
            float directTransmittance = std::exp(-tauCloud);

            // Attenuate direct sunlight beam by cloud transmittance
            float sunScale = math::lerp(0.20f, 1.0f, directTransmittance);
            f.sunIntensityUnit *= sunScale;

            // Boost diffuse skylight by forward Mie inscattering from cloud deck
            float skyScatterBoost = 1.0f + 0.45f * f.cloudCoverage * (1.0f - directTransmittance);
            f.skyLightIntensityUnit *= skyScatterBoost;
            f.cloudSkyLightScale = skyScatterBoost;

            // Soften contact shadows as clouds expand effective source angle
            f.penumbraScale = std::min(2.5f, f.penumbraScale * (1.0f + 1.2f * f.cloudCoverage * (1.0f - directTransmittance)));

            // Shift ambient fill towards neutral cloud albedo
            math::Vec3 cloudAmbient(0.55f, 0.60f, 0.68f);
            f.skyAmbientLinearRgb = math::Vec3(
                math::lerp(f.skyAmbientLinearRgb.x, cloudAmbient.x, f.cloudCoverage * 0.5f),
                math::lerp(f.skyAmbientLinearRgb.y, cloudAmbient.y, f.cloudCoverage * 0.5f),
                math::lerp(f.skyAmbientLinearRgb.z, cloudAmbient.z, f.cloudCoverage * 0.5f)
            );
        }

        // Direct sunlight color from Planckian locus
        f.sunColorLinearRgb = ephemeris::EphemerisService::kelvinToRgb(f.kelvin);

        // Ground bounce warmth & tint calculation
        f.groundBounceWarmth = std::max(0.0f, std::sin(std::max(0.0f, elRad)));
        float gR = (f.sunColorLinearRgb.x * 0.25f + f.skyAmbientLinearRgb.x * 0.15f) * (0.8f + 0.4f * f.groundBounceWarmth);
        float gG = (f.sunColorLinearRgb.y * 0.22f + f.skyAmbientLinearRgb.y * 0.15f) * (0.8f + 0.4f * f.groundBounceWarmth);
        float gB = (f.sunColorLinearRgb.z * 0.18f + f.skyAmbientLinearRgb.z * 0.18f) * (0.8f + 0.4f * f.groundBounceWarmth);
        f.groundBounceTint = math::Vec3(gR, gG, gB);

        // Multi-spectral Beer-Lambert aerial perspective extinction
        f.aerialExtinctionCoeff = atmosphere::HyperrealisticAtmosphereEngine::calculateAerialPerspectiveExtinction(
            450.0f, // 450m representative viewing distance
            50.0f,
            turbidity
        );

        // Analytical ground cloud shadow (atmospheric gobo cookie)
        math::Vec3 groundCenter = (bboxMin + bboxMax) * 0.5f;
        groundCenter.y = 0.0f;
        if (f.cloudCoverage > 0.05f) {
            f.cloudShadowTransmittance = atmosphere::HyperrealisticAtmosphereEngine::calculateGroundCloudShadow(
                groundCenter,
                f.sunDirectionENU,
                timeSeconds,
                math::Vec3(8.0f, 0.0f, 4.0f),
                1500.0f,
                4500.0f,
                f.cloudCoverage,
                1.0f
            );
        } else {
            f.cloudShadowTransmittance = 1.0f;
        }

        // Contact-Hardening PCSS parameters
        f.solarDiskAngularDiameter = shadow::SOLAR_ANGULAR_DIAMETER_RAD;
        float focalFrustumSpan = 140.0f;
        f.normalBiasMeters = shadow::AutoBiasCalculator::computeOptimalNormalBias(focalFrustumSpan, 4096);
        f.depthBias = shadow::AutoBiasCalculator::computeOptimalDepthBias(400.0f);
        f.rayleighUmbraFill = shadow::AtmosphericUmbraFill::computeUmbraRadiance(elevDeg, 0.35f);
        f.shadowFrustum = shadow::ShadowCameraFitter::fitToBoundingBox(bboxMin, bboxMax, f.sunDirectionThreeJS, 250.0f, 1.15f);

        return f;
    }

    /**
     * Presets factory method for standard photoreal lighting setups.
     */
    static DiurnalLightingFrame evaluatePreset(
        std::string_view preset,
        float latitudeDeg = 41.8902f,
        float longitudeDeg = 12.4922f,
        std::string_view stoneType = "travertine",
        float timeSeconds = 0.0f
    ) {
        if (preset == "dawn") {
            // Dawn 06:00
            return evaluateFromAngles(2.5f, 75.0f, 0.15f, 2.2f, stoneType, timeSeconds);
        } else if (preset == "morning") {
            // Morning 08:30
            return evaluateFromAngles(26.0f, 115.0f, 0.15f, 2.0f, stoneType, timeSeconds);
        } else if (preset == "midday") {
            // Midday 12:30 (Calibrated to Azimuth 132.0°, Elevation 49.5°)
            return evaluateFromAngles(49.5f, 132.0f, 0.10f, 1.8f, stoneType, timeSeconds);
        } else if (preset == "afternoon") {
            // Afternoon 15:00
            return evaluateFromAngles(42.0f, 220.0f, 0.20f, 2.2f, stoneType, timeSeconds);
        } else if (preset == "golden") {
            // Golden Hour 17:30
            return evaluateFromAngles(6.5f, 248.0f, 0.15f, 2.5f, stoneType, timeSeconds);
        } else if (preset == "twilight") {
            // Civil Twilight 18:30
            return evaluateFromAngles(-1.5f, 262.0f, 0.20f, 2.8f, stoneType, timeSeconds);
        } else if (preset == "blue_hour") {
            // Blue Hour 19:30
            return evaluateFromAngles(-5.0f, 275.0f, 0.15f, 2.4f, stoneType, timeSeconds);
        } else if (preset == "overcast") {
            // Heavy Overcast 14:00
            return evaluateFromAngles(50.0f, 205.0f, 0.88f, 4.2f, stoneType, timeSeconds);
        } else if (preset == "night") {
            // Deep Night 23:00
            return evaluateFromAngles(-40.0f, 340.0f, 0.10f, 1.8f, stoneType, timeSeconds);
        }
        // Default golden
        return evaluateFromAngles(6.5f, 248.0f, 0.15f, 2.5f, stoneType, timeSeconds);
    }

    /**
     * Compute frame from NOAA Ephemeris date/time.
     */
    static DiurnalLightingFrame evaluateFromEphemeris(
        float latDeg,
        float lngDeg,
        int64_t unixSeconds,
        float cloudCoverage = 0.15f,
        float turbidity = 2.2f,
        std::string_view stoneType = "travertine",
        float timeSeconds = 0.0f,
        const math::Vec3& bboxMin = math::Vec3(-94.0f, 0.0f, -78.0f),
        const math::Vec3& bboxMax = math::Vec3(94.0f, 48.0f, 78.0f)
    ) {
        ephemeris::EphemerisResult ephem = ephemeris::EphemerisService::calculate(latDeg, lngDeg, unixSeconds);
        DiurnalLightingFrame frame = evaluateFromAngles(
            ephem.angles.elevationDeg,
            ephem.angles.azimuthDeg,
            cloudCoverage,
            turbidity,
            stoneType,
            timeSeconds,
            bboxMin,
            bboxMax
        );
        frame.latitudeDeg = latDeg;
        frame.longitudeDeg = lngDeg;
        frame.unixTimestampSeconds = unixSeconds;
        return frame;
    }
};

} // namespace diurnal

// ============================================================================
// 12. OpenUSD UsdLux & MaterialX Professional Pipeline Exporter
// ============================================================================

namespace usd {

struct UsdCameraDefinition {
    math::Vec3 position{0.0f, 5.0f, 20.0f};
    math::Vec3 target{0.0f, 5.0f, 0.0f};
    float fovDeg = 54.0f;
    float focalLengthMm = 28.0f;
    float sensorWidthMm = 36.0f;
    float sensorHeightMm = 24.0f;
    float nearClip = 0.1f;
    float farClip = 10000.0f;
};

class UsdLuxExporter {
public:
    static std::string exportDiurnalFrameToUsda(
        const diurnal::DiurnalLightingFrame& frame,
        const UsdCameraDefinition& camera = UsdCameraDefinition{},
        std::string_view assetName = "PhotometricScene"
    ) {
        std::string usda;
        usda.reserve(2048);

        usda += "#usda 1.0\n";
        usda += "(\n";
        usda += "    defaultPrim = \"" + std::string(assetName) + "\"\n";
        usda += "    metersPerUnit = 1.0\n";
        usda += "    upAxis = \"Y\"\n";
        usda += "    doc = \"Generated by Scratchbox C++20 Professional USD Engine\"\n";
        usda += ")\n\n";

        usda += "def \"" + std::string(assetName) + "\" (\n";
        usda += "    kind = \"assembly\"\n";
        usda += ")\n";
        usda += "{\n";
        usda += "    def \"World\"\n";
        usda += "    {\n";
        usda += "        def \"Lights\"\n";
        usda += "        {\n";

        // UsdLuxDistantLight (Sun Key)
        usda += "            def UsdLuxDistantLight \"SunLight\"\n";
        usda += "            {\n";
        usda += "                float inputs:angle = 0.53\n";
        usda += "                color3f inputs:color = (" + std::to_string(frame.sunColorLinearRgb.x) + ", "
             + std::to_string(frame.sunColorLinearRgb.y) + ", " + std::to_string(frame.sunColorLinearRgb.z) + ")\n";
        usda += "                float inputs:colorTemperature = " + std::to_string(frame.kelvin) + "\n";
        usda += "                bool inputs:enableColorTemperature = 1\n";
        usda += "                float inputs:intensity = " + std::to_string(frame.sunIlluminanceLux) + "\n";
        usda += "                bool inputs:normalize = 1\n";
        usda += "                float inputs:exposure = 0\n";
        usda += "                double3 xformOp:translate = (" + std::to_string(frame.sunDirectionThreeJS.x * 100.0f) + ", "
             + std::to_string(frame.sunDirectionThreeJS.y * 100.0f) + ", " + std::to_string(frame.sunDirectionThreeJS.z * 100.0f) + ")\n";
        usda += "                uniform token[] xformOpOrder = [\"xformOp:translate\"]\n";
        usda += "            }\n";

        // UsdLuxDomeLight (Sky Fill)
        usda += "            def UsdLuxDomeLight \"SkyDomeLight\"\n";
        usda += "            {\n";
        usda += "                color3f inputs:color = (" + std::to_string(frame.skyAmbientLinearRgb.x) + ", "
             + std::to_string(frame.skyAmbientLinearRgb.y) + ", " + std::to_string(frame.skyAmbientLinearRgb.z) + ")\n";
        usda += "                float inputs:colorTemperature = 7500\n";
        usda += "                bool inputs:enableColorTemperature = 1\n";
        usda += "                float inputs:intensity = 1.0\n";
        usda += "                float inputs:exposure = 0.0\n";
        usda += "            }\n";
        usda += "        }\n";

        // UsdGeomCamera
        usda += "        def Camera \"ResectedCamera\"\n";
        usda += "        {\n";
        usda += "            float2 clippingRange = (" + std::to_string(camera.nearClip) + ", " + std::to_string(camera.farClip) + ")\n";
        usda += "            float focalLength = " + std::to_string(camera.focalLengthMm) + "\n";
        usda += "            float horizontalAperture = " + std::to_string(camera.sensorWidthMm) + "\n";
        usda += "            float verticalAperture = " + std::to_string(camera.sensorHeightMm) + "\n";
        usda += "            double3 xformOp:translate = (" + std::to_string(camera.position.x) + ", "
             + std::to_string(camera.position.y) + ", " + std::to_string(camera.position.z) + ")\n";
        usda += "            uniform token[] xformOpOrder = [\"xformOp:translate\"]\n";
        usda += "        }\n";
        usda += "    }\n";
        usda += "}\n";

        return usda;
    }

    static std::string exportMaterialXDocument(
        std::string_view materialName = "CalibratedMaterial",
        const math::Vec3& baseColor = math::Vec3(0.86f, 0.82f, 0.78f),
        float roughness = 0.82f
    ) {
        std::string mtlx;
        mtlx.reserve(1024);
        mtlx += "<?xml version=\"1.0\"?>\n";
        mtlx += "<materialx version=\"1.38\">\n";
        mtlx += "  <standard_surface name=\"" + std::string(materialName) + "_surface\" type=\"surfaceshader\">\n";
        mtlx += "    <input name=\"base\" type=\"float\" value=\"1.0\" />\n";
        mtlx += "    <input name=\"base_color\" type=\"color3\" value=\"" + std::to_string(baseColor.x) + ", "
             + std::to_string(baseColor.y) + ", " + std::to_string(baseColor.z) + "\" />\n";
        mtlx += "    <input name=\"diffuse_roughness\" type=\"float\" value=\"" + std::to_string(roughness) + "\" />\n";
        mtlx += "    <input name=\"specular\" type=\"float\" value=\"0.25\" />\n";
        mtlx += "    <input name=\"specular_roughness\" type=\"float\" value=\"" + std::to_string(roughness) + "\" />\n";
        mtlx += "    <input name=\"specular_IOR\" type=\"float\" value=\"1.54\" />\n";
        mtlx += "  </standard_surface>\n\n";
        mtlx += "  <surfacematerial name=\"" + std::string(materialName) + "\" type=\"material\">\n";
        mtlx += "    <input name=\"surfaceshader\" type=\"surfaceshader\" nodename=\"" + std::string(materialName) + "_surface\" />\n";
        mtlx += "  </surfacematerial>\n";
        mtlx += "</materialx>\n";
        return mtlx;
    }
};

} // namespace usd

} // namespace lighting
} // namespace scratchbox

#endif // SCRATCHBOX_LIGHTING_HPP

