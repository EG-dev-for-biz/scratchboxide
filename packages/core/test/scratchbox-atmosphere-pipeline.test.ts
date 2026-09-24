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

describe('Hyperrealistic Atmosphere & Volumetric Cloud C++20 Pipeline', () => {
    it('compiles and executes Schneider/Wrenninge cloud raymarching and NOAA ephemeris coupling in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::atmosphere;
    using namespace scratchbox::math;
    using namespace scratchbox::ephemeris;

    // 1. Verify Phase Functions (Dual-Lobe Henyey-Greenstein)
    float forwardPhase = HyperrealisticAtmosphereEngine::dualLobePhase(0.95f, 0.82f, -0.30f);
    float backPhase = HyperrealisticAtmosphereEngine::dualLobePhase(-0.95f, 0.82f, -0.30f);
    float sidePhase = HyperrealisticAtmosphereEngine::dualLobePhase(0.0f, 0.82f, -0.30f);
    float peakPhase = HyperrealisticAtmosphereEngine::dualLobePhase(0.99f, 0.82f, -0.30f);

    assert(forwardPhase > backPhase);
    assert(forwardPhase > sidePhase);
    assert(peakPhase > 1.0f); // High forward diffraction peak near sun center

    // 2. Altitude Bound Invariants (1500m - 4500m)
    Vec3 belowCloud(0.0f, 800.0f, 0.0f);
    Vec3 aboveCloud(0.0f, 5000.0f, 0.0f);
    assert(HyperrealisticAtmosphereEngine::sampleCloudDensity(belowCloud) == 0.0f);
    assert(HyperrealisticAtmosphereEngine::sampleCloudDensity(aboveCloud) == 0.0f);

    // Mid-troposphere sampling
    Vec3 midCloud(100.0f, 2500.0f, 200.0f);
    float d = HyperrealisticAtmosphereEngine::sampleCloudDensity(midCloud, 0.0f);
    assert(d >= 0.0f);

    // 3. Ephemeris Integration & Cloud Raymarching
    EphemerisResult ephemeris;
    ephemeris.latitude = 41.8902f;
    ephemeris.longitude = 12.4922f; // Rome
    ephemeris.sunDirectionENU = Vec3(0.5f, 0.707f, 0.5f).normalized();
    ephemeris.sunColorRgb = Vec3(1.0f, 0.92f, 0.84f);
    ephemeris.directSunIntensity = 1.0f;

    Vec3 rayOrigin(0.0f, 0.0f, 0.0f);
    Vec3 rayDir = Vec3(0.1f, 0.9f, 0.1f).normalized();
    CloudLightingResult res = HyperrealisticAtmosphereEngine::renderCloudRay(rayOrigin, rayDir, 6000.0f, ephemeris, 0.0f);

    assert(res.transmittance >= 0.0f && res.transmittance <= 1.0f);
    assert(res.inscatteredRadiance.x >= 0.0f);
    assert(res.inscatteredRadiance.y >= 0.0f);
    assert(res.inscatteredRadiance.z >= 0.0f);

    // 4. Ground Cloud Shadows across Coverage Levels
    Vec3 groundPos(50.0f, 15.0f, 50.0f);
    float clearGroundShadow = HyperrealisticAtmosphereEngine::calculateGroundCloudShadow(groundPos, ephemeris.sunDirectionENU, 0.0f, Vec3(8.0f, 0.0f, 4.0f), 1500.0f, 4500.0f, 0.0f);
    assert(clearGroundShadow == 1.0f); // 100% full direct sunlight with 0% clouds

    float scatteredGroundShadow = HyperrealisticAtmosphereEngine::calculateGroundCloudShadow(groundPos, ephemeris.sunDirectionENU, 0.0f, Vec3(8.0f, 0.0f, 4.0f), 1500.0f, 4500.0f, 0.42f);
    assert(scatteredGroundShadow >= 0.20f && scatteredGroundShadow <= 1.0f);

    // 5. Line-of-sight Transmittance
    Vec3 camPos(0.0f, 20.0f, 0.0f);
    float clearLos = HyperrealisticAtmosphereEngine::calculateSunLineOfSightTransmittance(camPos, ephemeris.sunDirectionENU, 0.0f, Vec3(8.0f, 0.0f, 4.0f), 1500.0f, 4500.0f, 0.0f);
    assert(clearLos == 1.0f);

    float scatteredLos = HyperrealisticAtmosphereEngine::calculateSunLineOfSightTransmittance(camPos, ephemeris.sunDirectionENU, 0.0f, Vec3(8.0f, 0.0f, 4.0f), 1500.0f, 4500.0f, 0.42f);
    assert(scatteredLos >= 0.0f && scatteredLos <= 1.0f);

    std::cout << "SUCCESS_ATMOSPHERE_RAYMARCH" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource);
        if (!compileResult.success) {
            console.error('Compiler error:', compileResult.errorMessage);
        }
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        if (execResult.exitCode !== 0) {
            console.error('Binary execution failed. Stderr:', execResult.stderr, 'Stdout:', execResult.stdout);
        }
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS_ATMOSPHERE_RAYMARCH');
    }, 30000);
});
