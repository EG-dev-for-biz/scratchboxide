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

describe('VFX-Grade Physical Camera Lens Shader (C++20 Pipeline)', () => {
    it('compiles and executes Brown-Conrady distortion, Newton-Raphson inversion, chromatic dispersion, halation, and STMap in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>
#include <vector>

// Version 2: ThinLensDoF cache bust
int main() {
    using namespace scratchbox::optics;
    using namespace scratchbox::math;

    // 1. Hollywood Presets Verification
    LensConfig cooke = LensConfig::presetCookeAnamorphic40mm();
    assert(cooke.anamorphicSqueeze == 2.0f);
    assert(cooke.k1 < 0.0f); // Barrel distortion
    assert(cooke.chromaticAberration > 0.003f);

    LensConfig arri = LensConfig::presetArriMasterPrime35mm();
    assert(arri.anamorphicSqueeze == 1.0f);
    assert(std::abs(arri.k1) < std::abs(cooke.k1)); // Master prime is cleaner

    // 2. Dynamic Lens Breathing Verification
    float k1Inf = -0.040f;
    float k1Near = PhysicalLensShader::calculateBreathingK1(k1Inf, 0.5f, 0.004f);
    float k1Far = PhysicalLensShader::calculateBreathingK1(k1Inf, 20.0f, 0.004f);
    assert(k1Near > k1Far); // Noticeable optical expansion on close focus

    // 3. Brown-Conrady Forward Distortion & Newton-Raphson Jacobian Inversion
    LensConfig testCfg;
    testCfg.k1 = -0.055f;
    testCfg.k2 = 0.012f;
    testCfg.p1 = 0.0003f;
    testCfg.p2 = -0.0002f;

    std::vector<Vec2> testPoints = {
        Vec2(0.0f, 0.0f),
        Vec2(0.2f, 0.15f),
        Vec2(-0.35f, 0.25f),
        Vec2(0.42f, -0.38f),
        Vec2(-0.48f, -0.48f)
    };

    for (const auto& pt : testPoints) {
        Vec2 distorted = PhysicalLensShader::distortCoords(pt, testCfg);
        Vec2 restored = PhysicalLensShader::undistortCoords(distorted, testCfg);

        float errX = std::abs(pt.x - restored.x);
        float errY = std::abs(pt.y - restored.y);
        assert(errX < 1e-5f);
        assert(errY < 1e-5f);
    }

    // 4. Catmull-Rom Bicubic Sub-Pixel Reconstruction
    int imgW = 16;
    int imgH = 16;
    std::vector<float> testImg(imgW * imgH * 4, 0.0f);
    // Fill with a linear gradient
    for (int y = 0; y < imgH; ++y) {
        for (int x = 0; x < imgW; ++x) {
            int idx = (y * imgW + x) * 4;
            testImg[idx + 0] = static_cast<float>(x) / static_cast<float>(imgW);
            testImg[idx + 1] = static_cast<float>(y) / static_cast<float>(imgH);
            testImg[idx + 2] = 0.5f;
            testImg[idx + 3] = 1.0f;
        }
    }

    Vec4 sampledMid = PhysicalLensShader::sampleBicubic(testImg.data(), imgW, imgH, 0.5f, 0.5f);
    assert(std::abs(sampledMid.x - 0.5f) < 0.05f);
    assert(std::abs(sampledMid.y - 0.5f) < 0.05f);
    assert(std::abs(sampledMid.z - 0.5f) < 0.01f);
    assert(sampledMid.w == 1.0f);

    // 5. Multi-Threaded Full Lens Shader Pass
    std::vector<float> outputImg(imgW * imgH * 4, 0.0f);
    PhysicalLensShader::applyLensShader(testImg.data(), outputImg.data(), imgW, imgH, cooke);

    // Optical Vignetting Invariant: Corner illumination must be darker than center
    int centerIdx = ((imgH / 2) * imgW + (imgW / 2)) * 4;
    int cornerIdx = 0;
    // Blue channel was constant 0.5f, so compare corner blue vs center blue
    float centerB = outputImg[centerIdx + 2];
    float cornerB = outputImg[cornerIdx + 2];
    assert(cornerB < centerB); // Natural optical cos^4 vignetting

    // 6. STMap Generation (Nuke / DaVinci Resolve Interchange)
    auto stMap = PhysicalLensShader::generateSTMap(32, 32, testCfg);
    assert(stMap.size() == 32 * 32 * 4);
    // Center pixel should be close to (0.5, 0.5)
    int stCenterIdx = (16 * 32 + 16) * 4;
    assert(std::abs(stMap[stCenterIdx + 0] - 0.5f) < 0.05f);
    assert(std::abs(stMap[stCenterIdx + 1] - 0.5f) < 0.05f);
    assert(stMap[stCenterIdx + 2] == 0.0f);
    assert(stMap[stCenterIdx + 3] == 1.0f);

    // 7. Thin-Lens Optical Depth of Field & Circle of Confusion (CoC)
    // At focus plane (z == dF), CoC must be exactly zero (tack sharp)
    float cocAtFocus = ThinLensDoF::calculateCircleOfConfusionMm(50.0f, 1.4f, 155.0f, 155.0f);
    assert(cocAtFocus < 1e-5f);

    // Foreground object at 20m with focus at 155m must have strong blur
    float cocNear = ThinLensDoF::calculateCircleOfConfusionMm(50.0f, 1.4f, 155.0f, 20.0f);
    assert(cocNear > 0.05f);

    // Off aperture (fNumber <= 0.05) must yield 0 CoC (sharp pinhole)
    float cocOff = ThinLensDoF::calculateCircleOfConfusionMm(50.0f, 0.0f, 155.0f, 20.0f);
    assert(cocOff == 0.0f);

    // Hyperfocal distance calculation for 50mm @ f/1.4 with 0.035mm CoC:
    // H = (0.050^2) / (1.4 * 0.000035) + 0.050 ≈ 51.07m
    float H = ThinLensDoF::calculateHyperfocalDistance(50.0f, 1.4f, 0.035f);
    assert(H > 50.0f && H < 53.0f);

    // When focused at H, far limit must be infinity
    float farLimitAtH = ThinLensDoF::calculateFarDofLimit(50.0f, 1.4f, H, 0.035f);
    assert(std::isinf(farLimitAtH));

    // Screen space blur radius clamp
    float blurRadius = ThinLensDoF::calculateScreenSpaceBlurRadius(cocNear, 36.0f, 1.0f, 0.045f);
    assert(blurRadius > 0.0f && blurRadius <= 0.045f);

    // 8. Sensor Formats and In-Focus Detection
    auto s35 = ThinLensDoF::getSensorDimensions(SensorFormat::Super35Cinema);
    assert(s35.widthMm == 24.89f);
    assert(s35.heightMm == 18.66f);
    assert(s35.permissibleCocMm == 0.020f);

    auto ff = ThinLensDoF::getSensorDimensions(SensorFormat::FullFrame35mm);
    assert(ff.widthMm == 36.0f);
    assert(ff.heightMm == 24.0f);

    // Total DoF span test
    float dofSpan = ThinLensDoF::calculateTotalDofSpan(50.0f, 1.4f, 10.0f, 0.035f);
    assert(dofSpan > 0.0f && dofSpan < 10.0f);

    // In-focus acceptability check
    assert(ThinLensDoF::isWithinAcceptableDof(10.0f, 10.0f, 50.0f, 1.4f, 0.035f));
    assert(!ThinLensDoF::isWithinAcceptableDof(2.0f, 10.0f, 50.0f, 1.4f, 0.035f));

    // Optical FOV check (50mm on full frame 35mm sensor has ~27.0 deg V-FOV, ~39.6 deg H-FOV)
    float vFov = ThinLensDoF::calculateVerticalFovDegrees(50.0f, 24.0f);
    assert(vFov > 26.0f && vFov < 28.0f);
    float hFov = ThinLensDoF::calculateHorizontalFovDegrees(50.0f, 36.0f);
    assert(hFov > 38.5f && hFov < 40.5f);

    std::cout << "SUCCESS_PHYSICAL_LENS_SHADER_CPP20" << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource, { optimization: '-O2' });
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
        expect(execResult.stdout).toContain('SUCCESS_PHYSICAL_LENS_SHADER_CPP20');
    }, 90000);
});
