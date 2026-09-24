/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_LENS_SHADER_HPP
#define SCRATCHBOX_LENS_SHADER_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <thread>
#include <future>
#include <string>
#include <limits>

namespace scratchbox {
namespace optics {

using math::Vec2;
using math::Vec3;
using math::Vec4;

/**
 * Optical Lens Configuration (Brown-Conrady Distortion & Physical Camera Glass)
 */
struct LensConfig {
    // 1. Brown-Conrady Radial Distortion Coefficients
    float k1{-0.042f};               // Barrel (< 0) or Pincushion (> 0)
    float k2{0.009f};                // 4th-order radial curvature
    float k3{0.0f};                  // 6th-order radial curvature (mustache distortion)
    
    // 2. Tangential Decentering Coefficients (tilt/misalignment of glass elements)
    float p1{0.0002f};               // Tangential decentering X
    float p2{-0.0001f};              // Tangential decentering Y
    
    // 3. Anamorphic & Optical Setup
    float anamorphicSqueeze{1.0f};   // 1.0 = Spherical, 1.33x, 1.5x, 2.0x = Anamorphic
    float chromaticAberration{0.0035f}; // Lateral spectral dispersion (Cauchy's law)
    float naturalVignette{0.65f};    // cos^4 theta optical illumination falloff intensity
    float halationRadius{3.5f};      // Red glow around bright highlights
    float halationIntensity{0.18f};  // Film halation bloom strength
    float veilingGlare{0.012f};      // Optical black-level lift from internal element scatter
    
    // 4. VFX Sun Bloom, Anamorphic Glare & Fraunhofer Diffraction
    float anamorphicStreakIntensity{0.45f}; // Horizontal anamorphic flare intensity
    float anamorphicStreakWidth{0.035f};    // Vertical streak width falloff
    Vec3 anamorphicStreakTint{0.15f, 0.45f, 1.0f}; // Classic cinematic blue streak tint
    int apertureBlades{6};                  // Polygonal iris blade count (6 or 8)
    float starburstIntensity{0.35f};        // Fraunhofer aperture diffraction spike strength
    float starburstApertureAngle{0.15f};    // Aperture rotation angle (radians)
    float solarCoronaIntensity{0.65f};      // Broad solar corona / silver-lining halo strength
    float sunBloomThreshold{0.80f};         // Luminance threshold for optical bloom

    // 5. Physical Geometry & Focal Mechanics
    Vec2 opticalCenter{0.5f, 0.5f};  // Principal point (normalized UV, usually 0.5, 0.5)
    float focalLengthMm{35.0f};      // Physical lens focal length in mm
    float sensorWidthMm{36.0f};      // Sensor gate width (36mm for Full Frame 35mm)
    float focusDistanceMeters{10.0f}; // Current focus plane distance (for lens breathing)
    float breathingCoeff{0.004f};    // Focal length expansion factor during focus pulling

    // Hollywood Optical Glass Presets
    static LensConfig presetCookeAnamorphic40mm() {
        LensConfig cfg;
        cfg.k1 = -0.065f;
        cfg.k2 = 0.015f;
        cfg.p1 = 0.0004f;
        cfg.p2 = -0.0002f;
        cfg.anamorphicSqueeze = 2.0f;
        cfg.chromaticAberration = 0.0052f;
        cfg.naturalVignette = 0.78f;
        cfg.halationIntensity = 0.24f;
        cfg.anamorphicStreakIntensity = 0.65f;
        cfg.anamorphicStreakWidth = 0.030f;
        cfg.anamorphicStreakTint = Vec3(0.12f, 0.52f, 1.0f); // Iconic Cooke blue streak
        cfg.apertureBlades = 8;
        cfg.starburstIntensity = 0.30f;
        cfg.solarCoronaIntensity = 0.75f;
        cfg.focalLengthMm = 40.0f;
        return cfg;
    }

    static LensConfig presetArriMasterPrime35mm() {
        LensConfig cfg;
        cfg.k1 = -0.016f;
        cfg.k2 = 0.002f;
        cfg.p1 = 0.0f;
        cfg.p2 = 0.0f;
        cfg.anamorphicSqueeze = 1.0f;
        cfg.chromaticAberration = 0.0010f;
        cfg.naturalVignette = 0.40f;
        cfg.halationIntensity = 0.08f;
        cfg.anamorphicStreakIntensity = 0.05f; // Very clean spherical prime
        cfg.anamorphicStreakTint = Vec3(0.75f, 0.85f, 0.95f);
        cfg.apertureBlades = 9;
        cfg.starburstIntensity = 0.18f;
        cfg.solarCoronaIntensity = 0.55f;
        cfg.focalLengthMm = 35.0f;
        return cfg;
    }

    static LensConfig presetLeicaSummicron50mm() {
        LensConfig cfg;
        cfg.k1 = -0.011f;
        cfg.k2 = 0.001f;
        cfg.p1 = 0.0f;
        cfg.p2 = 0.0f;
        cfg.anamorphicSqueeze = 1.0f;
        cfg.chromaticAberration = 0.0008f;
        cfg.naturalVignette = 0.35f;
        cfg.halationIntensity = 0.06f;
        cfg.anamorphicStreakIntensity = 0.08f;
        cfg.anamorphicStreakTint = Vec3(1.0f, 0.92f, 0.80f); // Warm natural glow
        cfg.apertureBlades = 7;
        cfg.starburstIntensity = 0.22f;
        cfg.solarCoronaIntensity = 0.60f;
        cfg.focalLengthMm = 50.0f;
        return cfg;
    }

    static LensConfig presetVintageKowaAnamorphic() {
        LensConfig cfg;
        cfg.k1 = -0.092f;
        cfg.k2 = 0.026f;
        cfg.p1 = 0.0008f;
        cfg.p2 = -0.0005f;
        cfg.anamorphicSqueeze = 2.0f;
        cfg.chromaticAberration = 0.0085f;
        cfg.naturalVignette = 0.88f;
        cfg.halationIntensity = 0.38f;
        cfg.veilingGlare = 0.025f;
        cfg.anamorphicStreakIntensity = 0.88f;
        cfg.anamorphicStreakWidth = 0.040f;
        cfg.anamorphicStreakTint = Vec3(0.04f, 0.38f, 1.0f); // Intense vintage blue streak
        cfg.apertureBlades = 6;
        cfg.starburstIntensity = 0.55f;
        cfg.solarCoronaIntensity = 0.85f;
        cfg.focalLengthMm = 40.0f;
        return cfg;
    }

    static LensConfig presetSuper35Wide18mm() {
        LensConfig cfg;
        cfg.k1 = -0.115f;
        cfg.k2 = 0.038f;
        cfg.p1 = 0.0005f;
        cfg.p2 = -0.0003f;
        cfg.anamorphicSqueeze = 1.0f;
        cfg.chromaticAberration = 0.0065f;
        cfg.naturalVignette = 0.85f;
        cfg.halationIntensity = 0.15f;
        cfg.anamorphicStreakIntensity = 0.15f;
        cfg.apertureBlades = 7;
        cfg.starburstIntensity = 0.38f;
        cfg.solarCoronaIntensity = 0.70f;
        cfg.focalLengthMm = 18.0f;
        cfg.sensorWidthMm = 24.89f; // Super 35 sensor gate
        return cfg;
    }
};

/**
 * VFX-Grade Physical Lens Shader (Modern C++20)
 *
 * Implements:
 * 1. Brown-Conrady Forward Geometric Distortion (Radial k1..k3, Tangential p1..p2)
 * 2. 2D Newton-Raphson Jacobian Inversion (Sub-pixel undistortion)
 * 3. Lateral Chromatic Aberration via Cauchy's Dispersion
 * 4. Natural cos^4(theta) Vignetting & Mechanical Entrance Pupil Falloff
 * 5. Catmull-Rom Bicubic Sub-Pixel Reconstruction Filter
 * 6. Film Halation & Veiling Glare
 * 7. Multi-threaded Frame Processing & Nuke/Resolve STMap Generation
 */
class PhysicalLensShader {
public:
    // Dynamic Focus Breathing: calculates effective k1 at given focus distance
    static float calculateBreathingK1(float k1Infinity, float focusDistanceMeters, float breathCoeff = 0.004f) {
        float d = std::max(0.15f, focusDistanceMeters);
        return k1Infinity + breathCoeff * (1.0f / d);
    }

    // Brown-Conrady Forward Distortion (Rectilinear Ideal -> Distorted Sensor)
    static Vec2 distortCoords(const Vec2& coord, const LensConfig& cfg) {
        float r2 = coord.x * coord.x + coord.y * coord.y;
        float r4 = r2 * r2;
        float r6 = r4 * r2;
        
        float radial = 1.0f + cfg.k1 * r2 + cfg.k2 * r4 + cfg.k3 * r6;
        Vec2 tangential(
            2.0f * cfg.p1 * coord.x * coord.y + cfg.p2 * (r2 + 2.0f * coord.x * coord.x),
            cfg.p1 * (r2 + 2.0f * coord.y * coord.y) + 2.0f * cfg.p2 * coord.x * coord.y
        );
        
        return coord * radial + tangential;
    }

    // 2D Newton-Raphson Jacobian Inversion (Distorted Sensor -> Rectilinear Ideal)
    // Converges with sub-pixel precision (< 1e-6 error tolerance)
    static Vec2 undistortCoords(const Vec2& target, const LensConfig& cfg) {
        Vec2 p = target;
        for (int iter = 0; iter < 8; ++iter) {
            float r2 = p.x * p.x + p.y * p.y;
            float r4 = r2 * r2;
            float r6 = r4 * r2;
            
            float radial = 1.0f + cfg.k1 * r2 + cfg.k2 * r4 + cfg.k3 * r6;
            Vec2 tang(
                2.0f * cfg.p1 * p.x * p.y + cfg.p2 * (r2 + 2.0f * p.x * p.x),
                cfg.p1 * (r2 + 2.0f * p.y * p.y) + 2.0f * cfg.p2 * p.x * p.y
            );
            
            Vec2 f = p * radial + tang;
            Vec2 residual = f - target;
            if (residual.lengthSq() < 1e-12f) break;
            
            // Analytic Jacobian derivatives
            float dRad = 2.0f * (cfg.k1 + 2.0f * cfg.k2 * r2 + 3.0f * cfg.k3 * r4);
            float j00 = radial + p.x * p.x * dRad + 2.0f * cfg.p1 * p.y + 6.0f * cfg.p2 * p.x;
            float j01 = p.x * p.y * dRad + 2.0f * cfg.p1 * p.x + 2.0f * cfg.p2 * p.y;
            float j10 = p.y * p.x * dRad + 2.0f * cfg.p1 * p.x + 2.0f * cfg.p2 * p.y;
            float j11 = radial + p.y * p.y * dRad + 6.0f * cfg.p1 * p.y + 2.0f * cfg.p2 * p.x;
            
            float det = j00 * j11 - j01 * j10;
            if (std::abs(det) < 1e-7f) break;
            
            p.x -= (j11 * residual.x - j01 * residual.y) / det;
            p.y -= (-j10 * residual.x + j00 * residual.y) / det;
        }
        return p;
    }

    // Catmull-Rom Bicubic Sub-Pixel Filter (prevents aliasing blur and ring artifacting)
    static Vec4 sampleBicubic(const float* src, int w, int h, float u, float v) {
        float x = u * static_cast<float>(w) - 0.5f;
        float y = v * static_cast<float>(h) - 0.5f;
        int px = static_cast<int>(std::floor(x));
        int py = static_cast<int>(std::floor(y));
        float fx = x - static_cast<float>(px);
        float fy = y - static_cast<float>(py);

        auto getPixel = [&](int ix, int iy) -> Vec4 {
            ix = std::clamp(ix, 0, w - 1);
            iy = std::clamp(iy, 0, h - 1);
            int idx = (iy * w + ix) * 4;
            return Vec4(src[idx], src[idx + 1], src[idx + 2], src[idx + 3]);
        };

        auto catmullRom = [](float f, const Vec4& p0, const Vec4& p1, const Vec4& p2, const Vec4& p3) {
            return p1 + (p2 - p0) * (0.5f * f) +
                   (p0 * 2.0f - p1 * 5.0f + p2 * 4.0f - p3) * (0.5f * f * f) +
                   (p1 * 3.0f - p0 - p2 * 3.0f + p3) * (0.5f * f * f * f);
        };

        Vec4 col[4];
        for (int m = 0; m < 4; ++m) {
            col[m] = catmullRom(fx,
                getPixel(px - 1, py - 1 + m),
                getPixel(px + 0, py - 1 + m),
                getPixel(px + 1, py - 1 + m),
                getPixel(px + 2, py - 1 + m));
        }
        return catmullRom(fy, col[0], col[1], col[2], col[3]);
    }

    // Full Multi-Threaded Physical Lens Shader Pass
    // Distorts an ideal CGI plate into authentic optical camera glass footage
    static void applyLensShader(
        const float* srcRgba,
        float* dstRgba,
        int width,
        int height,
        const LensConfig& cfg
    ) {
        float aspect = static_cast<float>(width) / static_cast<float>(height);
        float sensorDiagMm = std::sqrt(cfg.sensorWidthMm * cfg.sensorWidthMm * (1.0f + 1.0f / (aspect * aspect)));
        float fOverD = cfg.focalLengthMm / (sensorDiagMm * 0.5f);

        int numThreads = std::clamp(static_cast<int>(std::thread::hardware_concurrency()), 1, 16);
        std::vector<std::future<void>> futures;
        int rowsPerThread = height / numThreads;

        for (int t = 0; t < numThreads; ++t) {
            int yStart = t * rowsPerThread;
            int yEnd = (t == numThreads - 1) ? height : yStart + rowsPerThread;

            futures.push_back(std::async(std::launch::async, [=, &cfg]() {
                for (int y = yStart; y < yEnd; ++y) {
                    float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(height);

                    for (int x = 0; x < width; ++x) {
                        float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(width);

                        // 1. Convert UV to optical normalized coordinate centered at optical center
                        Vec2 coord(u - cfg.opticalCenter.x, v - cfg.opticalCenter.y);
                        coord.x *= aspect;
                        coord.x /= std::max(cfg.anamorphicSqueeze, 0.001f);

                        // 2. Optical Vignetting: cos^4(theta) falloff
                        float rNorm = coord.length();
                        float cosTheta = fOverD / std::sqrt(fOverD * fOverD + rNorm * rNorm);
                        float vignette = std::pow(cosTheta, 4.0f * cfg.naturalVignette);

                        // 3. Newton-Raphson Reverse Distortion
                        Vec2 distortedCoord = undistortCoords(coord, cfg);
                        distortedCoord.x *= cfg.anamorphicSqueeze;
                        distortedCoord.x /= aspect;

                        // 4. Lateral Chromatic Dispersion (Cauchy's Law)
                        float r2 = coord.x * coord.x + coord.y * coord.y;
                        Vec2 redUv   = cfg.opticalCenter + distortedCoord * (1.0f + cfg.chromaticAberration * r2);
                        Vec2 greenUv = cfg.opticalCenter + distortedCoord;
                        Vec2 blueUv  = cfg.opticalCenter + distortedCoord * (1.0f - cfg.chromaticAberration * r2);

                        // 5. Catmull-Rom Bicubic Sub-Pixel Sampling per color channel
                        float r = sampleBicubic(srcRgba, width, height, redUv.x, redUv.y).x;
                        float g = sampleBicubic(srcRgba, width, height, greenUv.x, greenUv.y).y;
                        float b = sampleBicubic(srcRgba, width, height, blueUv.x, blueUv.y).z;
                        float a = sampleBicubic(srcRgba, width, height, greenUv.x, greenUv.y).w;

                        // 6. Film Halation (warm crimson bloom on high specular highlights)
                        float luminance = 0.2126f * r + 0.7152f * g + 0.0722f * b;
                        if (luminance > 0.85f && cfg.halationIntensity > 0.0f) {
                            float excess = (luminance - 0.85f) * cfg.halationIntensity;
                            r += excess * 1.4f;
                            g += excess * 0.3f;
                        }

                        // 7. Veiling Glare (diffuse internal scatter lifting deep shadows)
                        if (cfg.veilingGlare > 0.0f) {
                            r += cfg.veilingGlare;
                            g += cfg.veilingGlare;
                            b += cfg.veilingGlare;
                        }

                        // 8. Apply Vignetting & Write Output
                        int dstIdx = (y * width + x) * 4;
                        dstRgba[dstIdx + 0] = r * vignette;
                        dstRgba[dstIdx + 1] = g * vignette;
                        dstRgba[dstIdx + 2] = b * vignette;
                        dstRgba[dstIdx + 3] = a;
                    }
                }
            }));
        }

        for (auto& f : futures) f.get();
    }

    // Industry-Standard STMap Generator (32-bit floating point RG displacement grid)
    // Drag-and-drop into The Foundry Nuke (STMap node) or DaVinci Resolve
    static std::vector<float> generateSTMap(
        int width,
        int height,
        const LensConfig& cfg,
        bool undistort = false
    ) {
        std::vector<float> stMap(width * height * 4);
        float aspect = static_cast<float>(width) / static_cast<float>(height);

        for (int y = 0; y < height; ++y) {
            float v = (static_cast<float>(y) + 0.5f) / static_cast<float>(height);
            for (int x = 0; x < width; ++x) {
                float u = (static_cast<float>(x) + 0.5f) / static_cast<float>(width);

                Vec2 coord(u - cfg.opticalCenter.x, v - cfg.opticalCenter.y);
                coord.x *= aspect;
                coord.x /= std::max(cfg.anamorphicSqueeze, 0.001f);

                Vec2 mappedCoord = undistort ? distortCoords(coord, cfg) : undistortCoords(coord, cfg);
                mappedCoord.x *= cfg.anamorphicSqueeze;
                mappedCoord.x /= aspect;

                Vec2 sampleUv = cfg.opticalCenter + mappedCoord;
                int idx = (y * width + x) * 4;
                stMap[idx + 0] = sampleUv.x;
                stMap[idx + 1] = sampleUv.y;
                stMap[idx + 2] = 0.0f;
                stMap[idx + 3] = 1.0f;
            }
        }
        return stMap;
    }

    // VFX Sun Bloom & Hollywood Anamorphic Flare Evaluator (C++20)
    // Evaluates multi-spectral core bloom, Fraunhofer aperture diffraction spikes,
    // anamorphic horizontal streak flare, and cloud transmittance modulation.
    static Vec3 calculateSunBloomAndGlare(
        const Vec2& screenUv,
        const Vec2& sunScreenPos,
        float sunVisibility,
        const LensConfig& cfg,
        float aspect = 1.777778f
    ) {
        if (sunVisibility <= 0.001f) return Vec3(0.0f, 0.0f, 0.0f);

        // Aspect-corrected offset vector from sun position to pixel
        Vec2 delta(
            (screenUv.x - sunScreenPos.x) * aspect,
            screenUv.y - sunScreenPos.y
        );
        float dist = delta.length();
        if (dist > 1.8f) return Vec3(0.0f, 0.0f, 0.0f);

        // 1. Core Sun Glow (white-hot core)
        float coreRadius = 0.035f;
        float coreGlow = std::exp(-dist / coreRadius);

        // 2. Broad Solar Corona / Silver-Lining Halo
        float corona = cfg.solarCoronaIntensity / (1.0f + dist * 14.0f + dist * dist * 45.0f);

        // 3. Fraunhofer Polygonal Iris Aperture Diffraction Starburst
        float starburst = 0.0f;
        if (cfg.starburstIntensity > 0.0f && dist > 0.008f && cfg.apertureBlades >= 4) {
            float angle = std::atan2(delta.y, delta.x) - cfg.starburstApertureAngle;
            float bladeStep = math::PI / static_cast<float>(cfg.apertureBlades);
            
            // Find angular distance to nearest aperture spike
            float normAngle = std::fmod(angle + math::PI * 4.0f, bladeStep);
            float diff = std::abs(normAngle - bladeStep * 0.5f);
            float spikeWidth = 0.038f;
            float spikeShape = std::exp(- (diff * diff) / (spikeWidth * spikeWidth));
            float spikeFalloff = 1.0f / (std::pow(dist + 0.04f, 1.35f));
            starburst = spikeShape * spikeFalloff * cfg.starburstIntensity * 0.15f;
        }

        // 4. Hollywood Anamorphic Horizontal Streak Flare
        float streak = 0.0f;
        if (cfg.anamorphicStreakIntensity > 0.0f) {
            float dy = std::abs(screenUv.y - sunScreenPos.y);
            float dx = std::abs((screenUv.x - sunScreenPos.x) * aspect);
            float vertFalloff = std::exp(-dy / std::max(0.002f, cfg.anamorphicStreakWidth));
            float horizFalloff = 1.0f / (1.0f + dx * (6.0f / std::max(1.0f, cfg.anamorphicSqueeze)));
            streak = vertFalloff * horizFalloff * cfg.anamorphicStreakIntensity;
        }

        // 5. Transmittance-Coupled Blending
        // Direct rays (core, starburst, streak) are directly scaled by sunVisibility.
        // Corona retains a forward-scattered silver-lining glow even when partially obscured.
        float directFactor = sunVisibility;
        float scatterFactor = sunVisibility * 0.4f + (1.0f - sunVisibility) * 0.75f;

        Vec3 sunWhite(1.0f, 0.96f, 0.90f);
        Vec3 bloomRgb = sunWhite * (coreGlow * directFactor * 1.8f + corona * scatterFactor);
        bloomRgb = bloomRgb + sunWhite * (starburst * directFactor);
        bloomRgb = bloomRgb + cfg.anamorphicStreakTint * (streak * directFactor);

        return bloomRgb;
    }
};

enum class SensorFormat {
    FullFrame35mm,    // 36.0mm x 24.0mm (standard 35mm film / full frame digital)
    Super35Cinema,    // 24.89mm x 18.66mm (Hollywood 35mm motion picture cinema standard)
    LargeFormatIMAX,  // 53.7mm x 40.4mm (Large format / IMAX 65mm motion picture gate)
    MicroFourThirds   // 17.3mm x 13.0mm (Micro 4/3 digital standard)
};

struct SensorDimensions {
    float widthMm;
    float heightMm;
    float permissibleCocMm;
    const char* name;
};

/**
 * Physical Thin-Lens Optical Depth of Field & Circle of Confusion (CoC)
 * 
 * Implements:
 * 1. Gaussian thin-lens equation: 1/f = 1/d_o + 1/d_i
 * 2. Exact Circle of Confusion (CoC) diameter on sensor plane:
 *    c = |(f^2 / (N * (d_focus - f))) * ((z - d_focus) / z)|
 * 3. Hyperfocal distance: H = f^2 / (N * c_max) + f
 * 4. Depth of field limits: Near and Far focus planes
 * 5. Screen-space pixel blur radius conversion with anamorphic aspect ratio scaling
 */
struct ThinLensDoF {
    float focalLengthMm{50.0f};          // Lens focal length in millimeters
    float fNumber{2.8f};                 // Lens aperture f-stop (0.0 = sharp pinhole)
    float focusDistanceMeters{10.0f};    // Distance to critical plane of focus in meters
    float sensorWidthMm{36.0f};          // Sensor gate width (36mm for Full Frame 35mm)
    float maxCocDiameterMm{0.035f};      // Standard 35mm permissible circle of confusion limit (~0.030-0.035mm)
    float anamorphicSqueeze{1.0f};       // 1.0 = Spherical, 2.0 = Hollywood Anamorphic (oval bokeh)
    int apertureBlades{8};               // Number of polygonal iris blades

    // Exact Circle of Confusion (CoC) diameter on sensor plane in millimeters
    static float calculateCircleOfConfusionMm(
        float focalLengthMm,
        float fNumber,
        float focusDistanceMeters,
        float fragDepthMeters
    ) {
        if (fNumber <= 0.05f || fragDepthMeters <= 0.001f || focusDistanceMeters <= 0.001f) {
            return 0.0f;
        }

        float fM = focalLengthMm * 0.001f;
        float dF = std::max(fM + 0.001f, focusDistanceMeters);
        float z = std::max(0.001f, fragDepthMeters);

        // Lens entrance pupil aperture diameter A = f / N
        float apertureDiameterM = fM / fNumber;

        // Exact thin-lens formula:
        // c = A * |z - dF| / z * (f / (dF - f))
        float cocM = apertureDiameterM * (std::abs(z - dF) / z) * (fM / (dF - fM));
        return cocM * 1000.0f; // Return in mm
    }

    // Optical Hyperfocal Distance in meters:
    // Beyond this focus distance, everything from H/2 to infinity is acceptably sharp.
    static float calculateHyperfocalDistance(
        float focalLengthMm,
        float fNumber,
        float permissibleCocMm = 0.035f
    ) {
        if (fNumber <= 0.05f || permissibleCocMm <= 0.0001f) return 1e6f;
        float fM = focalLengthMm * 0.001f;
        float cM = permissibleCocMm * 0.001f;
        return (fM * fM) / (fNumber * cM) + fM;
    }

    // Near Depth-of-Field limit in meters
    static float calculateNearDofLimit(
        float focalLengthMm,
        float fNumber,
        float focusDistanceMeters,
        float permissibleCocMm = 0.035f
    ) {
        float H = calculateHyperfocalDistance(focalLengthMm, fNumber, permissibleCocMm);
        float den = H + focusDistanceMeters;
        return (den > 0.001f) ? ((H * focusDistanceMeters) / den) : 0.0f;
    }

    // Far Depth-of-Field limit in meters (returns +infinity if focus is at or beyond H)
    static float calculateFarDofLimit(
        float focalLengthMm,
        float fNumber,
        float focusDistanceMeters,
        float permissibleCocMm = 0.035f
    ) {
        float H = calculateHyperfocalDistance(focalLengthMm, fNumber, permissibleCocMm);
        if (focusDistanceMeters >= H) {
            return std::numeric_limits<float>::infinity();
        }
        float den = H - focusDistanceMeters;
        if (den <= 0.001f) return std::numeric_limits<float>::infinity();
        return (H * focusDistanceMeters) / den;
    }

    // Sensor dimensions lookup by format
    static SensorDimensions getSensorDimensions(SensorFormat format) {
        switch (format) {
            case SensorFormat::FullFrame35mm:
                return { 36.0f, 24.0f, 0.030f, "Full Frame 35mm" };
            case SensorFormat::Super35Cinema:
                return { 24.89f, 18.66f, 0.020f, "Super 35 Cinema" };
            case SensorFormat::LargeFormatIMAX:
                return { 53.7f, 40.4f, 0.050f, "Large Format 65mm / IMAX" };
            case SensorFormat::MicroFourThirds:
                return { 17.3f, 13.0f, 0.015f, "Micro Four Thirds" };
            default:
                return { 36.0f, 24.0f, 0.030f, "Full Frame 35mm" };
        }
    }

    // Total Depth-of-Field span in meters (or +infinity if far limit is infinity)
    static float calculateTotalDofSpan(
        float focalLengthMm,
        float fNumber,
        float focusDistanceMeters,
        float permissibleCocMm = 0.035f
    ) {
        float nearLim = calculateNearDofLimit(focalLengthMm, fNumber, focusDistanceMeters, permissibleCocMm);
        float farLim = calculateFarDofLimit(focalLengthMm, fNumber, focusDistanceMeters, permissibleCocMm);
        if (std::isinf(farLim)) return std::numeric_limits<float>::infinity();
        return std::max(0.0f, farLim - nearLim);
    }

    // Check whether a given surface depth falls within the acceptable focus band (c <= permissibleCocMm)
    static bool isWithinAcceptableDof(
        float fragDepthMeters,
        float focusDistanceMeters,
        float focalLengthMm,
        float fNumber,
        float permissibleCocMm = 0.035f
    ) {
        if (fNumber <= 0.05f) return true; // Pin-hole: infinite focus
        float coc = calculateCircleOfConfusionMm(focalLengthMm, fNumber, focusDistanceMeters, fragDepthMeters);
        return coc <= permissibleCocMm;
    }

    // Optical Vertical Field of View (FOV) in degrees
    static float calculateVerticalFovDegrees(float focalLengthMm, float sensorHeightMm = 24.0f) {
        if (focalLengthMm <= 0.1f) return 60.0f;
        return 2.0f * std::atan(sensorHeightMm / (2.0f * focalLengthMm)) * (180.0f / 3.14159265358979323846f);
    }

    // Optical Horizontal Field of View (FOV) in degrees
    static float calculateHorizontalFovDegrees(float focalLengthMm, float sensorWidthMm = 36.0f) {
        if (focalLengthMm <= 0.1f) return 75.0f;
        return 2.0f * std::atan(sensorWidthMm / (2.0f * focalLengthMm)) * (180.0f / 3.14159265358979323846f);
    }

    // Normalized screen-space blur radius [0.0, maxRadius]
    static float calculateScreenSpaceBlurRadius(
        float cocMm,
        float sensorWidthMm,
        float dofStrength = 1.0f,
        float maxRadius = 0.045f
    ) {
        if (cocMm <= 0.0001f || sensorWidthMm <= 0.001f) return 0.0f;
        float normRadius = (cocMm / sensorWidthMm) * dofStrength * 0.5f;
        return std::clamp(normRadius, 0.0f, maxRadius);
    }
};

} // namespace optics
} // namespace scratchbox

#endif // SCRATCHBOX_LENS_SHADER_HPP
