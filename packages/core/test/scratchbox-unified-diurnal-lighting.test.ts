/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Unified C++20 Real-Time Diurnal Lighting & Atmosphere Engine', () => {
    it('compiles and validates all lighting conditions, diurnal phase transitions, PCSS shadows, and stone albedo in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::lighting::diurnal;
    using namespace scratchbox::math;

    // 1. Validate Midday (12:30) - Direct Sun Dominance & Travertine Stone (Azimuth 132°, Elevation 49.5°)
    auto midday = UnifiedTimeOfDaySystem::evaluatePreset("midday", 41.8902f, 12.4922f, "travertine");
    assert(midday.phase == "midday");
    assert(midday.isDay == true);
    assert(midday.isNight == false);
    assert(midday.castShadows == true);
    assert(std::abs(midday.solarElevationDeg - 49.5f) < 0.01f);
    assert(std::abs(midday.solarAzimuthDeg - 132.0f) < 0.01f);
    assert(midday.kelvin >= 5500.0f && midday.kelvin <= 6500.0f);
    assert(midday.sunIntensityUnit >= 1.4f);
    assert(midday.toneMappingExposure >= 0.60f && midday.toneMappingExposure <= 0.70f);
    assert(midday.architecturalPortalsActive == false);
    assert(midday.architecturalPortalIntensity == 0.0f);
    // Travertine albedo check
    assert(std::abs(midday.stoneAlbedoTint.x - 0.86f) < 0.01f);
    // Midday umbra fill should be blue-dominant Rayleigh
    assert(midday.rayleighUmbraFill.z > midday.rayleighUmbraFill.x);
    // Frustum check
    assert(midday.shadowFrustum.halfWidth >= 100.0f);

    // 2. Validate Golden Hour (17:30) - Amber Horizon & Contact Hardening
    auto golden = UnifiedTimeOfDaySystem::evaluatePreset("golden", 41.8902f, 12.4922f, "travertine");
    assert(golden.phase == "golden");
    assert(golden.isGoldenHour == true);
    assert(golden.castShadows == true);
    assert(golden.kelvin <= 3800.0f && golden.kelvin >= 2500.0f); // Warm amber
    assert(golden.sunColorLinearRgb.x > golden.sunColorLinearRgb.z); // Red-amber dominance
    assert(golden.penumbraScale >= 1.0f);
    assert(golden.rayleighUmbraFill.x > golden.rayleighUmbraFill.z); // Warm amber umbra fill

    // 3. Validate Dawn (06:00) - Low Grazing Sun
    auto dawn = UnifiedTimeOfDaySystem::evaluatePreset("dawn", 41.8902f, 12.4922f, "travertine");
    assert(dawn.phase == "dawn");
    assert(dawn.isGoldenHour == true);
    assert(dawn.castShadows == true);
    assert(dawn.solarElevationDeg < 5.0f);
    assert(dawn.penumbraScale > 1.2f); // Extended penumbra at grazing angle

    // 4. Validate Civil Twilight (18:30) - Sun Below Horizon, Portals Fading In
    auto twilight = UnifiedTimeOfDaySystem::evaluatePreset("twilight", 41.8902f, 12.4922f, "travertine");
    assert(twilight.phase == "twilight");
    assert(twilight.isTwilight == true);
    assert(twilight.solarElevationDeg < 0.0f);
    assert(twilight.architecturalPortalsActive == true);
    assert(twilight.architecturalPortalIntensity > 0.0f);

    // 5. Validate Blue Hour (19:30) - Deep Cobalt Sky & Interior Architectural Glow
    auto blueHour = UnifiedTimeOfDaySystem::evaluatePreset("blue_hour", 41.8902f, 12.4922f, "travertine");
    assert(blueHour.phase == "blue_hour");
    assert(blueHour.isBlueHour == true);
    assert(blueHour.castShadows == false); // Direct shadows extinguished
    assert(blueHour.kelvin >= 9000.0f);   // Deep cool Rayleigh sky
    assert(blueHour.skyAmbientLinearRgb.z > blueHour.skyAmbientLinearRgb.x); // Cobalt blue
    assert(blueHour.architecturalPortalsActive == true);
    assert(blueHour.architecturalPortalIntensity >= 1.0f); // Bright interior illumination

    // 6. Validate Overcast (14:00) - Diffuse Dominance & Cloud Shadow Gobos
    auto overcast = UnifiedTimeOfDaySystem::evaluatePreset("overcast", 41.8902f, 12.4922f, "travertine");
    assert(overcast.phase == "overcast");
    assert(overcast.cloudCoverage > 0.8f);
    assert(overcast.skyLightIntensityUnit > overcast.sunIntensityUnit); // Sky dominates direct sun
    assert(overcast.penumbraScale >= 2.0f); // Highly diffused shadows
    assert(overcast.cloudSkyLightScale > 1.2f);

    // 7. Validate Deep Night (23:00) - Astronomical Night & Monument Illumination
    auto night = UnifiedTimeOfDaySystem::evaluatePreset("night", 41.8902f, 12.4922f, "travertine");
    assert(night.phase == "deep_night");
    assert(night.isNight == true);
    assert(night.isDay == false);
    assert(night.castShadows == false);
    assert(night.toneMappingExposure <= 0.35f);
    assert(night.architecturalPortalsActive == true);
    assert(night.architecturalPortalIntensity >= 1.8f);

    // 8. Validate NOAA Ephemeris Integration
    // Summer Solstice June 21, 2026 12:00 UTC at Rome Colosseum (41.8902, 12.4922)
    // 1782043200 = June 21 2026 12:00:00 UTC
    int64_t solstice2026Utc = 1782043200;
    auto ephemFrame = UnifiedTimeOfDaySystem::evaluateFromEphemeris(41.8902f, 12.4922f, solstice2026Utc, 0.10f);
    assert(ephemFrame.solarElevationDeg > 60.0f); // High summer sun in Rome
    assert(ephemFrame.isDay == true);
    assert(ephemFrame.sunDirectionThreeJS.y > 0.8f);

    // 9. Validate Multi-Spectral Beer-Lambert Aerial Perspective
    assert(midday.aerialExtinctionCoeff.x > 0.0f && midday.aerialExtinctionCoeff.x <= 1.0f);
    assert(midday.aerialExtinctionCoeff.y > 0.0f && midday.aerialExtinctionCoeff.y <= 1.0f);
    assert(midday.aerialExtinctionCoeff.z > 0.0f && midday.aerialExtinctionCoeff.z <= 1.0f);

    // 10. Validate Cloud Scattering Coupling with Direct Sun & Diffuse Sky
    auto middayClear = UnifiedTimeOfDaySystem::evaluateFromAngles(49.5f, 132.0f, 0.0f);
    auto middayScattered = UnifiedTimeOfDaySystem::evaluateFromAngles(49.5f, 132.0f, 0.42f);
    assert(middayScattered.sunIntensityUnit < middayClear.sunIntensityUnit); // Direct sunlight attenuated by clouds
    assert(middayScattered.skyLightIntensityUnit > middayClear.skyLightIntensityUnit); // Diffuse forward scattering in clouds boosts sky light
    assert(middayScattered.cloudSkyLightScale > 1.0f);
    assert(middayScattered.penumbraScale >= middayClear.penumbraScale); // Softened contact shadow penumbra

    std::cout << "SCRATCHBOX_UNIFIED_DIURNAL_ENGINE_VALIDATED" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource);
        if (!compileResult.success) {
            throw new Error('C++ COMPILATION FAILED:\n' + compileResult.compilerOutput);
        }
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const runResult = await compiler.executeBinary(compileResult.binaryPath!);
        if (!runResult.success) {
            console.error('BINARY FAILED! ExitCode:', runResult.exitCode, 'STDERR:', runResult.stderr, 'STDOUT:', runResult.stdout);
        }
        expect(runResult.success).toBe(true);
        expect(runResult.stdout).toContain('SCRATCHBOX_UNIFIED_DIURNAL_ENGINE_VALIDATED');
    }, 30000);
});
