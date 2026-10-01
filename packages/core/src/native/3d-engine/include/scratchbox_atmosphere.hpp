/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_ATMOSPHERE_HPP
#define SCRATCHBOX_ATMOSPHERE_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_ephemeris.hpp"
#include <vector>
#include <cmath>
#include <algorithm>

namespace scratchbox {
namespace atmosphere {

using math::Vec3;
using math::FastNoise3D;
using ephemeris::EphemerisService;
using ephemeris::EphemerisResult;

struct CloudLightingResult {
    Vec3 inscatteredRadiance{0.0f, 0.0f, 0.0f}; // Light scattered toward camera
    float transmittance{1.0f};                  // 0.0 = fully opaque cloud, 1.0 = clear sky
};

/**
 * Hyperrealistic Atmospheric & Volumetric Cloud Engine (Schneider/Wrenninge Two-Tier Model)
 *
 * Simulates participating media raymarching through physical atmospheric physics:
 * 1. Tier 1 Macro Cumulus: 3D low-frequency Perlin-Worley noise defining cloud towers & billows.
 * 2. Tier 2 Micro Erosion: 3D high-frequency Worley noise eroding boundaries into cauliflower vapor curls.
 * 3. Dual-Lobe Henyey-Greenstein Phase Function: Intense forward solar silver-lining glare + backward glory.
 * 4. Andrew Schneider Powdered Sugar Multiple-Scattering Approximation: Inverted exponential optical depth
 *    coupling preventing ink-black overcast cores.
 * 5. Analytical Ground Cloud Shadows & Crepuscular Raymarcher: Dynamic shadows projected onto terrain/city.
 */
class HyperrealisticAtmosphereEngine {
public:
    // Single-Lobe Henyey-Greenstein Phase Function
    static float hgPhase(float cosTheta, float g) {
        float g2 = g * g;
        float denom = 1.0f + g2 - 2.0f * g * cosTheta;
        if (denom <= 0.0f) return 0.0f;
        return (1.0f - g2) / (4.0f * math::PI * std::pow(denom, 1.5f));
    }

    // Dual-lobe phase for realistic silver-lining + backward glory
    static float dualLobePhase(float cosTheta, float gForward = 0.82f, float gBack = -0.30f, float weight = 0.85f) {
        return weight * hgPhase(cosTheta, gForward) + (1.0f - weight) * hgPhase(cosTheta, gBack);
    }

    // Cloud density sampler at world point P (Schneider/Wrenninge Two-Tier Noise)
    static float sampleCloudDensity(
        const Vec3& p,
        float timeSeconds = 0.0f,
        const Vec3& wind = Vec3(8.0f, 0.0f, 4.0f),
        float cloudBaseMeters = 1500.0f,
        float cloudTopMeters = 4500.0f,
        float cloudCoverage = 0.42f,
        float densityScale = 1.0f
    ) {
        if (p.y < cloudBaseMeters || p.y > cloudTopMeters) return 0.0f;
        if (cloudCoverage <= 0.005f) return 0.0f;

        // Altitude profile: flat base, puffy rounded top
        float hNorm = (p.y - cloudBaseMeters) / (cloudTopMeters - cloudBaseMeters);
        float altMask = math::smoothstep(0.0f, 0.20f, hNorm) * math::smoothstep(1.0f, 0.70f, hNorm);

        // Wind advection
        Vec3 advectedP = p + wind * timeSeconds;

        // Tier 1: Macro Cumulus Shape (Low-frequency Perlin-Worley)
        float macro = FastNoise3D::fbm(advectedP.x * 0.0003f, advectedP.y * 0.0003f, advectedP.z * 0.0003f, 4);
        float worley = FastNoise3D::worley(advectedP.x * 0.0006f, advectedP.y * 0.0006f, advectedP.z * 0.0006f, 1337);
        
        // Dynamic coverage threshold (matching sky dome shader and real atmospheric deck)
        float threshold = 1.0f - std::clamp(cloudCoverage, 0.0f, 0.98f) * 0.75f;
        float baseCloud = std::clamp((macro * (1.0f - worley * 0.5f) * altMask - threshold) / (1.0f - threshold + 1e-4f), 0.0f, 1.0f);

        if (baseCloud <= 0.0f) return 0.0f;

        // Tier 2: Micro-erosion (High-frequency Worley vapor curls)
        float microWorley = FastNoise3D::worley(advectedP.x * 0.003f, advectedP.y * 0.003f, advectedP.z * 0.003f, 42);
        float finalDensity = std::clamp(baseCloud - microWorley * 0.22f, 0.0f, 1.0f);

        return finalDensity * 0.045f * densityScale; // Absorption density coefficient
    }

    // Full In-Scattering Cloud Raymarcher
    static CloudLightingResult renderCloudRay(
        const Vec3& rayOrigin,
        const Vec3& rayDir,
        float maxDistance,
        const EphemerisResult& sunEphemeris,
        float timeSeconds = 0.0f,
        const Vec3& wind = Vec3(8.0f, 0.0f, 4.0f)
    ) {
        CloudLightingResult result;
        Vec3 sunDir = sunEphemeris.sunDirectionENU.normalized();
        Vec3 sunColor = sunEphemeris.sunColorRgb * sunEphemeris.directSunIntensity;

        float cosTheta = rayDir.dot(sunDir);
        float phase = dualLobePhase(cosTheta);

        // Ambient sky light from zenith
        Vec3 ambientSky = Vec3(0.35f, 0.55f, 0.85f) * 0.45f;

        float t = 0.0f;
        float stepSize = 45.0f; // 45m primary ray step
        int maxSteps = std::min(128, static_cast<int>(maxDistance / stepSize));

        for (int i = 0; i < maxSteps; ++i) {
            Vec3 pos = rayOrigin + rayDir * t;
            float density = sampleCloudDensity(pos, timeSeconds, wind);

            if (density > 1e-4f) {
                // Secondary raymarch towards the Sun to evaluate optical depth (shadowing)
                float sunOpticalDepth = 0.0f;
                float sunStepSize = 65.0f;
                for (int s = 1; s <= 6; ++s) {
                    Vec3 sunSamplePos = pos + sunDir * (s * sunStepSize);
                    sunOpticalDepth += sampleCloudDensity(sunSamplePos, timeSeconds, wind) * sunStepSize;
                }

                // Direct transmission with Powder Sugar Multiple-Scattering
                float directTransmittance = std::exp(-sunOpticalDepth);
                float powderSugar = 1.0f - std::exp(-2.0f * sunOpticalDepth);
                float cloudTransmittance = directTransmittance * (1.0f + powderSugar * 1.5f);

                // Combined In-scattering at this step
                Vec3 stepLighting = sunColor * (cloudTransmittance * phase) + ambientSky;
                float stepExtinction = density * stepSize;

                // Accumulate radiance along ray
                result.inscatteredRadiance += stepLighting * (density * result.transmittance * stepSize);
                result.transmittance *= std::exp(-stepExtinction);

                // Early ray termination if cloud is completely opaque
                if (result.transmittance < 0.01f) {
                    result.transmittance = 0.0f;
                    break;
                }
            }

            t += stepSize;
            if (t >= maxDistance) break;
        }

        return result;
    }

    // Analytical Ground Cloud Shadow Integrator
    // Projects dynamic cloud shadows across terrain and architectural cityscapes
    static float calculateGroundCloudShadow(
        const Vec3& groundPos,
        const Vec3& sunDirENU,
        float timeSeconds = 0.0f,
        const Vec3& wind = Vec3(8.0f, 0.0f, 4.0f),
        float cloudBaseMeters = 1500.0f,
        float cloudTopMeters = 4500.0f,
        float cloudCoverage = 0.42f,
        float densityScale = 1.0f
    ) {
        if (cloudCoverage <= 0.005f) return 1.0f; // Clear sky: full sun
        if (sunDirENU.y <= 0.05f) return 0.2f; // Low sun / dusk default ambient shadow

        float totalOpticalDepth = 0.0f;
        int shadowSteps = 12;
        float hStep = (cloudTopMeters - cloudBaseMeters) / static_cast<float>(shadowSteps);

        for (int i = 0; i < shadowSteps; ++i) {
            float ySample = cloudBaseMeters + (i + 0.5f) * hStep;
            float deltaY = ySample - groundPos.y;
            float tRay = deltaY / sunDirENU.y;

            Vec3 cloudSamplePoint = groundPos + sunDirENU * tRay;
            float density = sampleCloudDensity(cloudSamplePoint, timeSeconds, wind, cloudBaseMeters, cloudTopMeters, cloudCoverage, densityScale);
            totalOpticalDepth += density * (hStep / sunDirENU.y);
        }

        // Beer-Lambert transmittance with soft ambient floor (0.20)
        float directShadowTransmittance = std::exp(-totalOpticalDepth);
        return 0.20f + 0.80f * directShadowTransmittance;
    }

    // Direct Sun-to-Camera Line-of-Sight Transmittance
    // Evaluates cloud occlusion along direct solar ray for transmittance-coupled sun bloom
    static float calculateSunLineOfSightTransmittance(
        const Vec3& cameraPos,
        const Vec3& sunDirENU,
        float timeSeconds = 0.0f,
        const Vec3& wind = Vec3(8.0f, 0.0f, 4.0f),
        float cloudBaseMeters = 1500.0f,
        float cloudTopMeters = 4500.0f,
        float cloudCoverage = 0.42f,
        float densityScale = 1.0f
    ) {
        if (cloudCoverage <= 0.005f) return 1.0f; // Clear sky: 100% transmittance
        if (sunDirENU.y <= 0.01f) return 0.0f; // Sun below or at horizon

        // Intersect ray with cloud deck slab [cloudBase, cloudTop]
        float t0 = (cloudBaseMeters - cameraPos.y) / sunDirENU.y;
        float t1 = (cloudTopMeters - cameraPos.y) / sunDirENU.y;
        if (t0 > t1) std::swap(t0, t1);
        t0 = std::max(0.0f, t0);
        if (t1 <= t0) return 1.0f; // Camera is above cloud deck pointing up

        float slabThickness = t1 - t0;
        int steps = 16;
        float stepSize = slabThickness / static_cast<float>(steps);
        float opticalDepth = 0.0f;

        for (int i = 0; i < steps; ++i) {
            float t = t0 + (i + 0.5f) * stepSize;
            Vec3 pos = cameraPos + sunDirENU * t;
            float density = sampleCloudDensity(pos, timeSeconds, wind, cloudBaseMeters, cloudTopMeters, cloudCoverage, densityScale);
            opticalDepth += density * stepSize;
        }

        return std::clamp(std::exp(-opticalDepth), 0.0f, 1.0f);
    }

    // Physical Beer-Lambert Aerial Perspective Multi-Spectral Extinction
    static Vec3 calculateAerialPerspectiveExtinction(
        float distanceMeters,
        float altitudeMeters = 50.0f,
        float turbidity = 2.2f
    ) {
        // Rayleigh scattering coefficients at sea level (440nm, 550nm, 680nm)
        Vec3 betaRayleigh(5.8e-6f, 13.5e-6f, 33.1e-6f);
        float rayleighScaleHeight = 8000.0f;
        float rayleighDensity = std::exp(-std::max(0.0f, altitudeMeters) / rayleighScaleHeight);

        // Aerosol Mie scattering coefficients
        float mieScaleHeight = 1200.0f;
        float mieDensity = std::exp(-std::max(0.0f, altitudeMeters) / mieScaleHeight);
        Vec3 betaMie = Vec3(2.1e-5f, 2.1e-5f, 2.1e-5f) * (turbidity * 0.45f);

        Vec3 betaTotal = betaRayleigh * rayleighDensity + betaMie * mieDensity;
        Vec3 opticalDepth = betaTotal * distanceMeters;

        return Vec3(
            std::exp(-opticalDepth.x),
            std::exp(-opticalDepth.y),
            std::exp(-opticalDepth.z)
        );
    }
};

} // namespace atmosphere
} // namespace scratchbox

#endif // SCRATCHBOX_ATMOSPHERE_HPP
