/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Cinematic Shadows & Contact-Hardening PCSS (C++20)', () => {
    it('compiles and validates solar disk optics, Vogel disk sampling, auto-bias scaling, and shadow frustum fitting in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::lighting::shadow;
    using namespace scratchbox::math;

    // 1. Validate Solar Disk Optics & Distance-Adaptive Penumbra
    SolarDiskOptics optics;
    assert(std::abs(optics.solarAngularDiameter - 0.0093084f) < 0.0001f);

    // Contact point: receiverDist == blockerDist -> penumbra must be 0.0 (pin-sharp)
    float penumbraContact = optics.computePenumbraRadius(50.0f, 50.0f);
    assert(penumbraContact == 0.0f);

    // Distant occluder: receiverDist = 100m, blockerDist = 50m (delta = 50m)
    // w_penumbra = 50m * tan(0.0093084) ≈ 0.465m
    float penumbraDistant = optics.computePenumbraRadius(100.0f, 50.0f);
    assert(penumbraDistant > 0.45f && penumbraDistant < 0.48f);

    // Filter kernel radius calculation:
    // With 140m frustum span and 4096 map size, texel size is 280/4096 = 0.068m
    // 0.465m / 0.068m ≈ 6.8 texels
    float filterRadius = optics.computeShadowFilterRadius(penumbraDistant, 140.0f, 4096);
    assert(filterRadius >= 6.0f && filterRadius <= 8.0f);

    // 2. Validate Vogel Disk Low-Discrepancy Sampling Kernel
    auto kernel16 = VogelDiskSampler::generateKernel(16);
    assert(kernel16.size() == 16);
    // All samples must lie inside unit circle (length <= 1.0)
    for (const auto& sample : kernel16) {
        float r = sample.length();
        assert(r >= 0.0f && r <= 1.0f);
    }
    // First sample is near origin, last sample is near boundary
    assert(kernel16[0].length() < kernel16[15].length());

    // 3. Validate Auto-Calibrated Zero-Acne Bias
    // With 140m span and 2048 map: texelSize = 280/2048 = 0.1367m -> normalBias ≈ 0.17m
    float normalBias2k = AutoBiasCalculator::computeOptimalNormalBias(140.0f, 2048);
    assert(normalBias2k >= 0.15f && normalBias2k <= 0.20f);

    // With 140m span and 4096 map: texelSize = 280/4096 = 0.068m -> normalBias ≈ 0.085m
    float normalBias4k = AutoBiasCalculator::computeOptimalNormalBias(140.0f, 4096);
    assert(normalBias4k >= 0.07f && normalBias4k <= 0.10f);

    // Depth bias must scale inversely with far plane depth to avoid negative bias
    float depthBias = AutoBiasCalculator::computeOptimalDepthBias(400.0f);
    assert(depthBias >= 0.00001f && depthBias <= 0.00005f);

    // 4. Validate Tight Shadow Camera Frustum Fitter
    // Colosseum metric box: ~[-94, 94] x [0, 48] x [-78, 78]
    Vec3 boxMin(-94.0f, 0.0f, -78.0f);
    Vec3 boxMax(94.0f, 48.0f, 78.0f);
    Vec3 sunDir(0.6f, -0.7f, 0.4f); // Angled sun

    ShadowCameraFrustum frustum = ShadowCameraFitter::fitToBoundingBox(boxMin, boxMax, sunDir, 250.0f, 1.15f);
    // Frustum span should be tight (~120m to 160m), NOT diluted to 1000m+!
    assert(frustum.halfWidth >= 110.0f && frustum.halfWidth <= 160.0f);
    assert(frustum.farPlane >= 200.0f && frustum.farPlane <= 1200.0f);

    // 5. Validate Atmospheric Umbra Fill
    Vec3 middayFill = AtmosphericUmbraFill::computeUmbraRadiance(65.0f, 0.35f);
    // Midday sky should have strong blue component
    assert(middayFill.z > middayFill.x);

    Vec3 sunsetFill = AtmosphericUmbraFill::computeUmbraRadiance(5.0f, 0.35f);
    // Sunset sky should have strong warm/red component
    assert(sunsetFill.x > sunsetFill.z);

    std::cout << "SCRATCHBOX_CINEMATIC_SHADOWS_VALIDATED" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource);
        if (!compileResult.success) {
            throw new Error('C++ COMPILATION FAILED:\n' + compileResult.compilerOutput);
        }
        expect(compileResult.success).toBe(true);
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        if (execResult.exitCode !== 0) {
            throw new Error(`C++ EXECUTION FAILED (exit code ${execResult.exitCode}):\nSTDERR: ${execResult.stderr}\nSTDOUT: ${execResult.stdout}`);
        }
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SCRATCHBOX_CINEMATIC_SHADOWS_VALIDATED');
    }, 60000);
});
