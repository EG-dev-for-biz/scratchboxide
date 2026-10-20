/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
    LensDistortionEffect,
    BrownConradyLensDistortionPass,
    LENS_DISTORTION_SHADER,
    LENS_OPTICAL_PRESETS,
    computeBrownConradyUV,
    calculateBrownConradyFromFocalLength
} from '../src/browser/generative-canvas/services/optics/LensDistortionEffect';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('Brown-Conrady Optical Lens Distortion Shader Engine & API', () => {

    describe('GLSL Shader Definition', () => {
        it('exports vertex and fragment shaders with full Brown-Conrady uniform set', () => {
            expect(LENS_DISTORTION_SHADER.vertexShader).toContain('vUv = uv;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform sampler2D tDiffuse;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float k1;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float k2;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float p1;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float p2;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform vec2 opticalCenter;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float aspectRatio;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float chromaticAberration;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform float anamorphicSqueeze;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform vec4 letterboxColor;');
            expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('uniform bool enabled;');
        });

        it('contains radial, tangential, and chromatic dispersion calculations in fragment GLSL', () => {
            const frag = LENS_DISTORTION_SHADER.fragmentShader;
            expect(frag).toContain('float radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6 + k4 * r8;');
            expect(frag).toContain('2.0 * p1 * coord.x * coord.y');
            expect(frag).toContain('chromaticAberration * r2');
            expect(frag).toContain('gl_FragColor = letterboxColor;');
        });
    });

    describe('LensDistortionEffect Post-Processing Pass', () => {
        it('initializes with default smartphone 26mm parameters', () => {
            const effect = new LensDistortionEffect();
            const config = effect.getConfig();

            expect(config.k1).toBeCloseTo(-0.038, 3);
            expect(config.k2).toBeCloseTo(0.008, 3);
            expect(config.p1).toBe(0.0);
            expect(config.p2).toBe(0.0);
            expect(config.enabled).toBe(true);
            expect(config.aspectRatio).toBeCloseTo(16 / 9, 3);

            const mat = effect.getMaterial();
            expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
            expect(mat.depthTest).toBe(false);
            expect(mat.depthWrite).toBe(false);

            effect.dispose();
        });

        it('supports BrownConradyLensDistortionPass alias', () => {
            expect(BrownConradyLensDistortionPass).toBe(LensDistortionEffect);
            const pass = new BrownConradyLensDistortionPass();
            expect(pass).toBeInstanceOf(LensDistortionEffect);
            pass.dispose();
        });

        it('updates uniforms fluently via setter methods', () => {
            const effect = new LensDistortionEffect();

            effect.setDistortion(-0.08, 0.02, 0.001, -0.001)
                .setOpticalCenter(0.48, 0.52)
                .setChromaticAberration(0.0035)
                .setAspectRatio(2.39)
                .setAnamorphicSqueeze(1.33)
                .setEnabled(false)
                .setLetterboxColor(0.1, 0.2, 0.3, 1.0);

            const mat = effect.getMaterial();
            expect(mat.uniforms.k1.value).toBe(-0.08);
            expect(mat.uniforms.k2.value).toBe(0.02);
            expect(mat.uniforms.p1.value).toBe(0.001);
            expect(mat.uniforms.p2.value).toBe(-0.001);
            expect((mat.uniforms.opticalCenter.value as THREE.Vector2).x).toBe(0.48);
            expect((mat.uniforms.opticalCenter.value as THREE.Vector2).y).toBe(0.52);
            expect(mat.uniforms.chromaticAberration.value).toBe(0.0035);
            expect(mat.uniforms.aspectRatio.value).toBe(2.39);
            expect(mat.uniforms.anamorphicSqueeze.value).toBe(1.33);
            expect(mat.uniforms.enabled.value).toBe(false);

            const config = effect.getConfig();
            expect(config.k1).toBe(-0.08);
            expect(config.enabled).toBe(false);

            effect.dispose();
        });

        it('applies validated optical profile presets', () => {
            const effect = new LensDistortionEffect();

            effect.applyProfile('ultrawide_14mm');
            expect(effect.getConfig().k1).toBeCloseTo(-0.095, 3);
            expect(effect.getConfig().chromaticAberration).toBeCloseTo(0.0042, 4);

            effect.applyProfile('action_cam_fisheye');
            expect(effect.getConfig().k1).toBeCloseTo(-0.220, 3);

            effect.applyProfile('cinema_anamorphic_2x');
            expect(effect.getConfig().anamorphicSqueeze).toBeCloseTo(2.0, 2);

            effect.applyProfile('telephoto_portrait_85mm');
            expect(effect.getConfig().k1).toBeGreaterThan(0); // Pincushion

            expect(() => effect.applyProfile('non_existent_profile')).toThrow(/Unknown lens optical profile/);

            effect.dispose();
        });
    });

    describe('Analytical CPU Coordinate Displacement (computeBrownConradyUV)', () => {
        it('preserves the optical center invariant under distortion', () => {
            const center: [number, number] = [0.5, 0.5];
            const distorted = computeBrownConradyUV(center, {
                k1: -0.05,
                k2: 0.01,
                p1: 0.001,
                p2: -0.001,
                opticalCenter: [0.5, 0.5]
            }, 16 / 9);

            expect(distorted[0]).toBeCloseTo(0.5, 6);
            expect(distorted[1]).toBeCloseTo(0.5, 6);
        });

        it('displaces peripheral coordinates according to radial barrel coefficients', () => {
            const corner: [number, number] = [0.9, 0.9];
            const undistorted = computeBrownConradyUV(corner, {
                k1: 0.0,
                k2: 0.0
            }, 1.0);
            expect(undistorted[0]).toBeCloseTo(0.9, 6);
            expect(undistorted[1]).toBeCloseTo(0.9, 6);

            // Barrel distortion (k1 < 0) displaces outward coordinates
            const barrel = computeBrownConradyUV(corner, {
                k1: -0.1,
                k2: 0.02
            }, 1.0);
            expect(barrel[0]).toBeLessThan(0.9);
            expect(barrel[1]).toBeLessThan(0.9);

            // Pincushion distortion (k1 > 0) expands outward coordinates
            const pincushion = computeBrownConradyUV(corner, {
                k1: 0.1,
                k2: 0.0
            }, 1.0);
            expect(pincushion[0]).toBeGreaterThan(0.9);
            expect(pincushion[1]).toBeGreaterThan(0.9);
        });

        it('respects aspect ratio in radial symmetry', () => {
            const params = { k1: -0.05, k2: 0.01 };
            const uv1: [number, number] = [0.7, 0.5]; // offset X by 0.2
            const uv2: [number, number] = [0.5, 0.7]; // offset Y by 0.2

            // Square aspect ratio: displacement magnitudes should match
            const resSquare1 = computeBrownConradyUV(uv1, params, 1.0);
            const resSquare2 = computeBrownConradyUV(uv2, params, 1.0);
            expect(Math.abs(resSquare1[0] - 0.5)).toBeCloseTo(Math.abs(resSquare2[1] - 0.5), 5);

            // Widescreen 16:9 aspect ratio: horizontal displacement scaled by aspect
            const resWide1 = computeBrownConradyUV(uv1, params, 16 / 9);
            expect(resWide1[0]).not.toBeCloseTo(resSquare1[0], 4);
        });
    });

    describe('Focal Length Calibration & Optical Presets', () => {
        it('computes realistic coefficients for various focal lengths', () => {
            const ultraWide = calculateBrownConradyFromFocalLength(14.0);
            expect(ultraWide.k1).toBeLessThan(-0.08);
            expect(ultraWide.chromaticAberration).toBeGreaterThan(0.003);

            const wide = calculateBrownConradyFromFocalLength(26.0);
            expect(wide.k1).toBeLessThan(0);
            expect(wide.k1).toBeGreaterThan(-0.06);

            const normal = calculateBrownConradyFromFocalLength(50.0);
            expect(Math.abs(normal.k1 ?? 0)).toBeLessThan(0.01);

            const telephoto = calculateBrownConradyFromFocalLength(85.0);
            expect(telephoto.k1).toBeGreaterThan(0); // Pincushion
        });

        it('defines all major real-world optical presets', () => {
            const expectedPresets = [
                'smartphone_wide_26mm',
                'ultrawide_14mm',
                'action_cam_fisheye',
                'cinema_anamorphic_2x',
                'standard_prime_50mm',
                'telephoto_portrait_85mm',
                'drone_surveying_lens'
            ];

            for (const id of expectedPresets) {
                const preset = LENS_OPTICAL_PRESETS[id];
                expect(preset).toBeDefined();
                expect(preset.id).toBe(id);
                expect(preset.name.length).toBeGreaterThan(0);
                expect(preset.description.length).toBeGreaterThan(0);
                expect(preset.config.k1).toBeDefined();
            }
        });
    });

    describe('Gemini Agent Tool (optics_configure_lens_distortion)', () => {
        it('registers and executes optics_configure_lens_distortion in ToolRegistry', async () => {
            const registry = createDefaultToolRegistry();
            const names = registry.declarations().map(d => d.name);
            expect(names).toContain('optics_configure_lens_distortion');

            const outcome = await registry.dispatch(
                'optics_configure_lens_distortion',
                {
                    focalLengthMm: 24.0,
                    sampleUvs: [
                        [0.5, 0.5],
                        [0.1, 0.1],
                        [0.9, 0.9]
                    ],
                    includeGlslShader: true
                },
                {} as any
            );

            expect(outcome.exec.status).toBe('completed');
            expect(outcome.exec.summaryResult).toMatch(/^NOT applied: computed only. Brown-Conrady lens distortion k1 /);
            const payload = outcome.resultPayload as any;
            expect(payload.applied).toBe(false);
            expect(payload.notApplied).toMatch(/no 3D scene is open/);
            expect(payload.config).toBeDefined();
            expect(payload.distortedSamples).toHaveLength(3);
            expect(payload.distortedSamples[0].distortedUv[0]).toBeCloseTo(0.5, 5);
            expect(payload.shader.vertexShader).toBeDefined();
            expect(payload.shader.fragmentShader).toContain('uniform float k1;');
        });

        it('configures distortion by preset ID via agent tool', async () => {
            const registry = createDefaultToolRegistry();
            const outcome = await registry.dispatch(
                'optics_configure_lens_distortion',
                {
                    presetId: 'action_cam_fisheye'
                },
                {} as any
            );

            expect(outcome.exec.status).toBe('completed');
            const payload = outcome.resultPayload as any;
            expect(payload.config.k1).toBeCloseTo(-0.220, 3);
            expect(payload.availablePresets).toContain('action_cam_fisheye');
        });

        it('fails instead of assuming a smartphone lens when no lens is given', async () => {
            const registry = createDefaultToolRegistry();
            for (const tool of ['optics_configure_lens_distortion', 'optics_export_lens_distortion']) {
                const missing = await registry.dispatch(tool, { format: 'nuke', sampleUvs: [[0.1, 0.1]] }, {} as any);
                expect(missing.exec.status).toBe('failed');
                expect(missing.exec.summaryResult).toContain('no default lens is assumed');

                const unknown = await registry.dispatch(tool, { format: 'nuke', presetId: 'not_a_lens' }, {} as any);
                expect(unknown.exec.status).toBe('failed');
                expect(unknown.exec.summaryResult).toContain('not_a_lens');
            }
        });

        it('accepts explicit coefficients alone as the lens', async () => {
            const registry = createDefaultToolRegistry();
            const outcome = await registry.dispatch(
                'optics_configure_lens_distortion',
                { customParams: { k1: -0.05 }, sampleUvs: [[0.9, 0.5]] },
                {} as any
            );
            expect(outcome.exec.status).toBe('completed');
            const payload = outcome.resultPayload as any;
            // explicit coefficients are in normalized camera coordinates; config is the same lens in frame-height
            // units of the viewport's default 45 degree frame: k1' = k1 (2 tan(22.5 deg))^2
            expect(payload.sceneDistortion).toEqual({ k1: -0.05, k2: 0, k3: 0, p1: 0, p2: 0 });
            expect(payload.config.k1).toBeCloseTo(-0.05 * (2 * Math.tan(Math.PI / 8)) ** 2, 10);
            // Barrel distortion pulls an off-centre sample toward the optical centre
            expect(payload.distortedSamples[0].distortedUv[0]).toBeLessThan(0.9);
        });
    });

    describe('TaskCapabilityResolver Integration', () => {
        it('routes lens shader and optical distortion tasks to Tier 1 native capabilities', () => {
            const resolution = TaskCapabilityResolver.resolveTaskCapability(
                'Implement a Brown-Conrady optical lens distortion shader pass with chromatic dispersion in Three.js'
            );

            expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.primaryNativeEngine).toBe('threejs-webgl');
            expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('LensDistortionEffect'))).toBe(true);
            expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('LensDistortionEffect');
        });

        it('routes barrel and pincushion optical correction tasks to native engine', () => {
            const resolution = TaskCapabilityResolver.resolveTaskCapability(
                'Apply barrel distortion and anamorphic squeeze post-processing to the video camera render'
            );

            expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
            expect(resolution.tier1Assessment.primaryNativeEngine).toBe('threejs-webgl');
            expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('LENS_DISTORTION_SHADER'))).toBe(true);
        });
    });
});
