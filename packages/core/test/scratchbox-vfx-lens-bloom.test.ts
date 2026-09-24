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

describe('VFX-Grade Atmospheric Lighting, Sun Bloom & Lens Shading Pipeline (C++20)', () => {
    it('compiles and executes Hollywood anamorphic flare, Fraunhofer diffraction, and transmittance coupling in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::optics;
    using namespace scratchbox::atmosphere;
    using namespace scratchbox::math;

    // 1. Hollywood Presets Verification
    LensConfig cooke = LensConfig::presetCookeAnamorphic40mm();
    assert(cooke.anamorphicStreakIntensity > 0.5f);
    assert(cooke.anamorphicStreakTint.z > cooke.anamorphicStreakTint.x); // Blue streak
    assert(cooke.apertureBlades == 8);

    LensConfig kowa = LensConfig::presetVintageKowaAnamorphic();
    assert(kowa.anamorphicStreakIntensity > 0.8f);
    assert(kowa.apertureBlades == 6);
    assert(kowa.k1 < -0.08f);

    LensConfig arri = LensConfig::presetArriMasterPrime35mm();
    assert(arri.anamorphicStreakIntensity <= 0.1f);
    assert(arri.apertureBlades == 9);

    // 2. Direct Sun-to-Camera Line-of-Sight Transmittance
    Vec3 camPos(0.0f, 10.0f, 0.0f);
    Vec3 sunDirLow(0.8f, 0.05f, 0.2f); // Low sun near horizon
    sunDirLow = sunDirLow.normalized();
    float transClear = HyperrealisticAtmosphereEngine::calculateSunLineOfSightTransmittance(camPos, sunDirLow, 0.0f);
    assert(transClear >= 0.0f && transClear <= 1.0f);

    // 3. Beer-Lambert Aerial Perspective Extinction
    Vec3 extNear = HyperrealisticAtmosphereEngine::calculateAerialPerspectiveExtinction(100.0f, 20.0f);
    Vec3 extFar = HyperrealisticAtmosphereEngine::calculateAerialPerspectiveExtinction(10000.0f, 20.0f);
    assert(extNear.x > extFar.x); // Greater transmittance close up
    assert(extNear.z > extFar.z); // Blue scatters more over 10km than red

    // 4. VFX Sun Bloom & Hollywood Anamorphic Flare Evaluation
    Vec2 sunPos(0.5f, 0.4f);
    Vec2 sunCenterPixel(0.5f, 0.4f);
    Vec2 offsetPixel(0.6f, 0.4f); // Horizontal offset for anamorphic streak check
    Vec2 spikePixel(0.52f, 0.42f); // Diagonal offset

    // Full direct sun visibility (clear sky)
    Vec3 bloomCenter = PhysicalLensShader::calculateSunBloomAndGlare(sunCenterPixel, sunPos, 1.0f, cooke);
    assert(bloomCenter.x > 1.0f); // High intensity white-hot core
    assert(bloomCenter.y > 1.0f);
    assert(bloomCenter.z > 1.0f);

    // Anamorphic horizontal streak
    Vec3 bloomStreak = PhysicalLensShader::calculateSunBloomAndGlare(offsetPixel, sunPos, 1.0f, cooke);
    assert(bloomStreak.z > bloomStreak.x); // Cooke blue streak tint manifests horizontally

    // Cloud-occluded sun visibility (transmittance = 0.20)
    Vec3 bloomCloudy = PhysicalLensShader::calculateSunBloomAndGlare(sunCenterPixel, sunPos, 0.20f, cooke);
    assert(bloomCloudy.x < bloomCenter.x); // Direct core bloom is attenuated by cloud
    assert(bloomCloudy.x > 0.0f); // Soft forward-scattered silver lining remains

    std::cout << "SUCCESS_VFX_ATMOSPHERE_LENS_BLOOM_CPP20" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource);
        if (!compileResult.success) {
            console.error('Compiler error:', compileResult.compilerOutput);
        }
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        if (execResult.exitCode !== 0) {
            console.error('Execution failed:', execResult.stderr, execResult.stdout);
        }
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS_VFX_ATMOSPHERE_LENS_BLOOM_CPP20');
    }, 45000);
});
