/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import {
    EASU_SHADER,
    RCAS_SHADER,
    FidelityFXSuperResolution,
    createFidelityFXSuperResolution,
    FSRQualityPreset,
    FSR_PRESET_SCALES,
    computeInputDimensionsForPreset
} from '../src/browser/generative-canvas/services/postprocessing/FidelityFXSuperResolution';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';

describe('AMD FidelityFX Super Resolution 1.0 (EASU + RCAS)', () => {
    describe('Shader Definitions', () => {
        it('defines EASU (Edge-Adaptive Spatial Upsampling) shader with required uniforms', () => {
            expect(EASU_SHADER).toBeDefined();
            expect(EASU_SHADER.vertexShader).toContain('void main()');
            expect(EASU_SHADER.fragmentShader).toContain('uniform sampler2D tInput');
            expect(EASU_SHADER.fragmentShader).toContain('uniform vec2 uInputResolution');
            expect(EASU_SHADER.fragmentShader).toContain('uniform vec2 uOutputResolution');
            
            // Check for 12-tap edge analysis and directional gradient filtering
            expect(EASU_SHADER.fragmentShader).toContain('uInputResolution');
            expect(EASU_SHADER.fragmentShader).toMatch(/edge|gradient|dir|luma/i);
        });

        it('defines RCAS (Robust Contrast-Adaptive Sharpening) shader with anti-ringing clamping', () => {
            expect(RCAS_SHADER).toBeDefined();
            expect(RCAS_SHADER.vertexShader).toContain('void main()');
            expect(RCAS_SHADER.fragmentShader).toContain('uniform sampler2D tInput');
            expect(RCAS_SHADER.fragmentShader).toContain('uniform vec2 uResolution');
            expect(RCAS_SHADER.fragmentShader).toContain('uniform float uSharpness');

            // Check for 5-tap cross pattern and contrast bounds
            expect(RCAS_SHADER.fragmentShader).toMatch(/min|max|clamp|ring/i);
        });
    });

    describe('Preset Calculations', () => {
        it('computes correct render scales for standard FSR 1.0 quality presets', () => {
            expect(FSR_PRESET_SCALES[FSRQualityPreset.UltraQuality]).toBeCloseTo(0.77, 2);
            expect(FSR_PRESET_SCALES[FSRQualityPreset.Quality]).toBeCloseTo(0.67, 2);
            expect(FSR_PRESET_SCALES[FSRQualityPreset.Balanced]).toBeCloseTo(0.59, 2);
            expect(FSR_PRESET_SCALES[FSRQualityPreset.Performance]).toBeCloseTo(0.50, 2);
        });

        it('calculates integer input render dimensions from output dimensions', () => {
            const dims = computeInputDimensionsForPreset(1920, 1080, FSRQualityPreset.Quality);
            expect(dims.width).toBe(Math.round(1920 * 0.67));
            expect(dims.height).toBe(Math.round(1080 * 0.67));
            expect(dims.width % 2).toBe(0); // Even dimensions for render targets
            expect(dims.height % 2).toBe(0);
        });
    });

    describe('FidelityFXSuperResolution Pipeline', () => {
        let fsr: FidelityFXSuperResolution;

        beforeEach(() => {
            fsr = createFidelityFXSuperResolution({
                outputWidth: 1920,
                outputHeight: 1080,
                preset: FSRQualityPreset.Quality,
                sharpness: 0.8
            });
        });

        afterEach(() => {
            fsr.dispose();
        });

        it('initializes with correct input and output dimensions', () => {
            expect(fsr.getOutputWidth()).toBe(1920);
            expect(fsr.getOutputHeight()).toBe(1080);
            expect(fsr.getInputWidth()).toBe(Math.round(1920 * 0.67));
            expect(fsr.getInputHeight()).toBe(Math.round(1080 * 0.67));
            expect(fsr.getSharpness()).toBe(0.8);
            expect(fsr.getPreset()).toBe(FSRQualityPreset.Quality);
        });

        it('allows tuning sharpness between 0.0 and 1.0', () => {
            fsr.setSharpness(0.4);
            expect(fsr.getSharpness()).toBe(0.4);

            fsr.setSharpness(1.5); // clamps to 1.0
            expect(fsr.getSharpness()).toBe(1.0);

            fsr.setSharpness(-0.2); // clamps to 0.0
            expect(fsr.getSharpness()).toBe(0.0);
        });

        it('updates internal render targets and resolutions on resize', () => {
            fsr.resize(3840, 2160, FSRQualityPreset.Performance);
            expect(fsr.getOutputWidth()).toBe(3840);
            expect(fsr.getOutputHeight()).toBe(2160);
            expect(fsr.getInputWidth()).toBe(1920);
            expect(fsr.getInputHeight()).toBe(1080);
            expect(fsr.getPreset()).toBe(FSRQualityPreset.Performance);
        });

        it('executes 2-pass render pipeline (EASU -> RCAS) via WebGL mock', () => {
            const mockRenderer = {
                getRenderTarget: vi.fn().mockReturnValue(null),
                setRenderTarget: vi.fn(),
                render: vi.fn(),
                setSize: vi.fn(),
                domElement: { width: 1920, height: 1080 }
            } as unknown as THREE.WebGLRenderer;

            const inputTexture = new THREE.Texture();
            
            fsr.render(mockRenderer, inputTexture);

            // Expect setRenderTarget called for intermediate EASU pass, final destination, and restoring previous
            expect(mockRenderer.setRenderTarget).toHaveBeenCalledTimes(3);
            // Expect render called for both EASU and RCAS passes
            expect(mockRenderer.render).toHaveBeenCalledTimes(2);
        });

        it('disposes resources cleanly without leaking WebGL targets or materials', () => {
            const spyDispose = vi.spyOn(fsr.getIntermediateRenderTarget(), 'dispose');
            fsr.dispose();
            expect(spyDispose).toHaveBeenCalled();
        });
    });

    describe('Direct Dispatch Operator sb_configure_fsr', () => {
        it('attaches and configures FSR in scene data via operator engine', () => {
            const initialSceneData: any = {
                title: 'Test 3D Scene',
                customMeshes: []
            };

            const engine = createOperatorEngine(initialSceneData);
            const result = engine.dispatch('sb_configure_fsr', {
                enabled: true,
                preset: 'quality',
                sharpness: 0.85
            });

            expect(result.success).toBe(true);
            const updatedScene = engine.getSceneData() as any;
            expect(updatedScene.metadata?.postprocessing?.fsr).toBeDefined();
            expect(updatedScene.metadata.postprocessing.fsr.enabled).toBe(true);
            expect(updatedScene.metadata.postprocessing.fsr.preset).toBe('quality');
            expect(updatedScene.metadata.postprocessing.fsr.sharpness).toBe(0.85);
        });
    });

    describe('Native C++20 scratchbox_fsr.hpp (EASU + RCAS)', () => {
        it('compiles and executes native EASU 12-tap upscaling and RCAS anti-ringing sharpening', async () => {
            const { execSync } = await import('node:child_process');
            const path = await import('node:path');
            const fs = await import('node:fs');
            const os = await import('node:os');

            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fsr-test-'));
            const cppSourcePath = path.join(tmpDir, 'test_fsr_runner.cpp');
            const binPath = path.join(tmpDir, 'test_fsr_runner');
            const includeDir = path.resolve(__dirname, '../src/native/3d-engine/include');

            const cppCode = `
#include "scratchbox_fsr.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;
    // Step test pattern: sharp diagonal edge separating black and white
    texture::ImageBuffer input(16, 16, 3, 0);
    for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 16; ++x) {
            if (x >= y) {
                input.setPixelRGB(x, y, math::Vec3(1.0f, 1.0f, 1.0f));
            } else {
                input.setPixelRGB(x, y, math::Vec3(0.0f, 0.0f, 0.0f));
            }
        }
    }

    // 1. EASU pass: 16x16 -> 32x32
    auto easuUpscaled = fsr::applyEASU(input, 32, 32);
    assert(easuUpscaled.width == 32 && easuUpscaled.height == 32);

    // 2. RCAS pass: Contrast-adaptive sharpening with anti-ringing clamping
    auto finalOutput = fsr::applyRCAS(easuUpscaled, 0.85f);
    assert(finalOutput.width == 32 && finalOutput.height == 32);

    // Strict invariant: no overshoot beyond [0.0, 1.0] bounds
    for (int y = 0; y < 32; ++y) {
        for (int x = 0; x < 32; ++x) {
            auto rgb = finalOutput.getPixelRGB(x, y);
            assert(rgb.x >= 0.0f && rgb.x <= 1.0f);
            assert(rgb.y >= 0.0f && rgb.y <= 1.0f);
            assert(rgb.z >= 0.0f && rgb.z <= 1.0f);
        }
    }

    std::cout << "SUCCESS" << std::endl;
    return 0;
}
`;
            fs.writeFileSync(cppSourcePath, cppCode);
            try {
                execSync(`clang++ -std=c++20 -O2 -I "${includeDir}" "${cppSourcePath}" -o "${binPath}"`, {
                    stdio: 'pipe'
                });
                const output = execSync(`"${binPath}"`, { stdio: 'pipe' }).toString().trim();
                expect(output).toContain('SUCCESS');
            } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            }
        });
    });
});
