/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
    Google360PanoramaPipelineService,
    healPanoramaSeam,
    inpaintPanorama,
    generate360Panorama,
    buildEquirectangularStructuredPrompt,
    EquirectangularStructuredPrompt,
    upscalePanorama16K,
    auditPanoramaQuality,
    extractZenithRectilinearPatch,
    reprojectZenithRectilinearPatch,
    reprojectZenithPanorama
} from '../src/node/spatial/Google360PanoramaPipelineService';
import { encodePng } from '../src/node/texture-processing';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

const service = new Google360PanoramaPipelineService();

describe('Google 360 Panorama Pipeline Service', () => {

    it('shifts image horizontally by 50% and perfectly reverses back (invertibility test)', () => {
        const width = 64;
        const height = 32;
        const totalBytes = width * height * 4;
        const original = Buffer.alloc(totalBytes);

        // Fill buffer with distinct coordinate pattern
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                original[idx] = x % 256;
                original[idx + 1] = y % 256;
                original[idx + 2] = (x * 3 + y * 7) % 256;
                original[idx + 3] = 255;
            }
        }

        const shifted = service.shiftImageHorizontally(original, width, height, 0.5, false);
        expect(shifted.length).toBe(original.length);

        // Verify pixel at x=0 moved to x=width/2
        const origPixel0 = [original[0], original[1], original[2], original[3]];
        const shiftedMidIdx = (width / 2) * 4;
        const shiftedPixelMid = [shifted[shiftedMidIdx], shifted[shiftedMidIdx + 1], shifted[shiftedMidIdx + 2], shifted[shiftedMidIdx + 3]];
        expect(shiftedPixelMid).toEqual(origPixel0);

        // Reverse shift back
        const reversed = service.shiftImageHorizontally(shifted, width, height, 0.5, true);
        expect(reversed.length).toBe(original.length);

        // Invertibility must be 100% bit-exact across every single byte
        expect(Buffer.compare(original, reversed)).toBe(0);
    });

    it('creates quadratic gradient seam mask with peak at center and zero at edges', () => {
        const width = 128;
        const height = 64;
        const seamWidth = 32;
        const { alphaMap, maskPng } = service.createSeamMask(width, height, seamWidth);

        expect(alphaMap.length).toBe(width);
        expect(maskPng.length).toBeGreaterThan(0);

        // Check center of seam (x = width / 2)
        const centerIdx = Math.floor(width / 2);
        expect(alphaMap[centerIdx]).toBeGreaterThan(0.95);

        // Check outside the seam band: should be 0.0
        const outsideIdxLeft = centerIdx - Math.floor(seamWidth / 2) - 5;
        const outsideIdxRight = centerIdx + Math.floor(seamWidth / 2) + 5;
        expect(alphaMap[outsideIdxLeft]).toBe(0);
        expect(alphaMap[outsideIdxRight]).toBe(0);

        // Values must be monotonic from left edge to center
        for (let x = outsideIdxLeft; x < centerIdx; x++) {
            expect(alphaMap[x]).toBeLessThanOrEqual(alphaMap[x + 1]);
        }
    });

    it('creates nadir mask covering south polar region with smooth gradient falloff', () => {
        const width = 64;
        const height = 64;
        const nadirRatio = 0.25;
        const { alphaMap, maskPng } = service.createNadirMask(width, height, nadirRatio);

        expect(alphaMap.length).toBe(height);
        expect(maskPng.length).toBeGreaterThan(0);

        // Top of panorama (sky/zenith) must have 0.0 mask weight
        expect(alphaMap[0]).toBe(0);
        expect(alphaMap[10]).toBe(0);
        expect(alphaMap[Math.floor(height * 0.5)]).toBe(0);

        // Bottom of panorama (ground/nadir) must reach 1.0
        expect(alphaMap[height - 1]).toBe(1.0);
        expect(alphaMap[height - 2]).toBe(1.0);

        // Values must be monotonic non-decreasing down to nadir
        for (let y = 0; y < height - 1; y++) {
            expect(alphaMap[y]).toBeLessThanOrEqual(alphaMap[y + 1]);
        }
    });

    it('blends images preserving 100% bit-exact pixels outside alpha mask', () => {
        const width = 32;
        const height = 16;
        const original = Buffer.alloc(width * height * 4, 100);
        const inpainted = Buffer.alloc(width * height * 4, 200);

        const alphaMap = new Float32Array(width);
        // Mark center 4 columns as alpha 1.0, everything else 0.0
        alphaMap[14] = 0.5;
        alphaMap[15] = 1.0;
        alphaMap[16] = 1.0;
        alphaMap[17] = 0.5;

        const blended = service.blendImageAlpha(original, inpainted, alphaMap, width, height, true);

        // Non-seam pixels must be exactly 100 (original)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < 14; x++) {
                const idx = (y * width + x) * 4;
                expect(blended[idx]).toBe(100);
            }
            for (let x = 18; x < width; x++) {
                const idx = (y * width + x) * 4;
                expect(blended[idx]).toBe(100);
            }
            // Fully inpainted pixels must be exactly 200
            const midIdx = (y * width + 15) * 4;
            expect(blended[midIdx]).toBe(200);
        }
    });

    it('heals 360 panorama seam in mock execution mode and exports valid PNG', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-pano-'));
        const inputPath = path.join(tempDir, 'test_input.png');
        const outputPath = path.join(tempDir, 'test_healed.png');

        // Generate synthetic initial equirectangular panorama
        await service.generate360Panorama({
            prompt: 'Serene mountain landscape at sunset',
            width: 512,
            height: 256,
            healSeam: false,
            mockExecution: true,
            outputImagePath: inputPath
        });

        expect(fs.existsSync(inputPath)).toBe(true);

        const healResult = await service.healPanoramaSeam({
            inputImagePath: inputPath,
            outputImagePath: outputPath,
            seamWidth: 64,
            mockExecution: true
        });

        expect(healResult.success).toBe(true);
        expect(healResult.width).toBe(512);
        expect(healResult.height).toBe(256);
        expect(healResult.seamWidth).toBe(64);
        expect(healResult.outputImagePath).toBe(outputPath);
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(fs.statSync(outputPath).size).toBeGreaterThan(1000);
        expect(healResult.summary).toContain('seam healed successfully across 64px boundary');

        await fs.remove(tempDir);
    });

    it('inpaints nadir camera rig from 360 panorama in mock execution mode', async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-pano-nadir-'));
        const inputPath = path.join(tempDir, 'pano_with_rig.png');
        const outputPath = path.join(tempDir, 'pano_rig_removed.png');

        await service.generate360Panorama({
            prompt: 'Urban rooftop 360 view',
            width: 256,
            height: 128,
            healSeam: false,
            mockExecution: true,
            outputImagePath: inputPath
        });

        const inpaintResult = await inpaintPanorama({
            inputImagePath: inputPath,
            nadirOnly: true,
            nadirRatio: 0.15,
            prompt: 'Clean concrete floor matching rooftop texture',
            outputImagePath: outputPath,
            mockExecution: true
        });

        expect(inpaintResult.success).toBe(true);
        expect(inpaintResult.width).toBe(256);
        expect(inpaintResult.height).toBe(128);
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(inpaintResult.summary).toContain('inpainting completed successfully');

        await fs.remove(tempDir);
    });

    it('inverts spherical curvature concavely towards user at edges', () => {
        const width = 64;
        const height = 32;
        const rgba = Buffer.alloc(width * height * 4);

        // Fill with gradient test pattern
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                rgba[idx] = x * 4;
                rgba[idx + 1] = y * 8;
                rgba[idx + 2] = 128;
                rgba[idx + 3] = 255;
            }
        }

        const warped = Google360PanoramaPipelineService.invertSphericalCurvature(rgba, width, height);
        expect(warped).toBeInstanceOf(Buffer);
        expect(warped.length).toBe(rgba.length);

        // Center pixel should remain near center
        const centerIdx = ((height / 2) * width + (width / 2)) * 4;
        expect(Math.abs(warped[centerIdx] - rgba[centerIdx])).toBeLessThan(20);
    });

    it('preserves high-frequency texture micro-contrast and equalizes illumination using Laplacian 2-Band seam healing', () => {
        const width = 128;
        const height = 32;
        const rgba = Buffer.alloc(width * height * 4);

        // Fill with distinct textures on left vs right half:
        // Left half (x < 64): High illumination (~200) + high-frequency square grating (amplitude +/- 30)
        // Right half (x >= 64): Lower illumination (~80) + high-frequency square grating (amplitude +/- 20)
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const isLeft = x < width / 2;
                const baseIllum = isLeft ? 200 : 80;
                const grating = (x % 2 === 0) ? 25 : -25;
                const val = baseIllum + grating;

                rgba[idx]     = val;
                rgba[idx + 1] = val;
                rgba[idx + 2] = val;
                rgba[idx + 3] = 255;
            }
        }

        // Shift 50% so boundary is at centerX = 64
        const shifted = service.shiftImageHorizontally(rgba, width, height, 0.5, false);

        // Execute Laplacian 2-Band healing
        const healedLaplacian = Google360PanoramaPipelineService.proceduralSeamHeal(shifted, width, height, 16, 'laplacian_2band');
        // Execute Legacy smoothstep healing
        const healedLegacy = Google360PanoramaPipelineService.proceduralSeamHeal(shifted, width, height, 16, 'smoothstep_legacy');

        // Measure high-frequency contrast near the seam (x in [centerX - 10, centerX - 2])
        // In legacy smoothstep, interpolating between constants collapses high-frequency grating contrast.
        // In Laplacian 2-Band, the grating contrast is preserved!
        let contrastLaplacian = 0;
        let contrastLegacy = 0;
        const centerX = Math.floor(width / 2);
        const y = Math.floor(height / 2);

        for (let x = centerX - 10; x <= centerX - 2; x++) {
            const idxA = (y * width + x) * 4;
            const idxB = (y * width + (x + 1)) * 4;
            contrastLaplacian += Math.abs(healedLaplacian[idxB] - healedLaplacian[idxA]);
            contrastLegacy += Math.abs(healedLegacy[idxB] - healedLegacy[idxA]);
        }

        // Laplacian 2-Band MUST preserve high-frequency grating micro-contrast (> 3x higher than legacy smeared cross-fade)
        expect(contrastLaplacian).toBeGreaterThan(contrastLegacy * 2);

        // Low-frequency illumination at the cut (centerX - 1 vs centerX) must be smoothly continuous
        const leftCutIdx = (y * width + (centerX - 1)) * 4;
        const rightCutIdx = (y * width + centerX) * 4;
        const cutStep = Math.abs(healedLaplacian[rightCutIdx] - healedLaplacian[leftCutIdx]);
        // The step between adjacent pixels across the seam must not have the original 120-unit jump
        expect(cutStep).toBeLessThan(40);
    });

    it('adds cyclic boundary pre-padding and perfectly unpads back to exact dimensions', () => {
        const width = 64;
        const height = 32;
        const margin = 8;
        const original = Buffer.alloc(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                original[idx] = x;
                original[idx + 1] = y;
                original[idx + 2] = 128;
                original[idx + 3] = 255;
            }
        }

        const padded = Google360PanoramaPipelineService.addCyclicBoundaryPadding(original, width, height, margin);
        expect(padded.paddedWidth).toBe(width + margin * 2);
        expect(padded.paddedHeight).toBe(height);

        // Verify left margin wraps from right flank: column 0 of padded is column width - margin of original
        const leftPaddedIdx = (0 * padded.paddedWidth + 0) * 4;
        const rightOrigIdx = (0 * width + (width - margin)) * 4;
        expect(padded.paddedRgba[leftPaddedIdx]).toBe(original[rightOrigIdx]);

        // Verify unpad extracts exact original buffer
        const unpadded = Google360PanoramaPipelineService.removeCyclicBoundaryPadding(padded.paddedRgba, padded.paddedWidth, padded.paddedHeight, margin);
        expect(unpadded.width).toBe(width);
        expect(unpadded.height).toBe(height);
        expect(Buffer.compare(original, unpadded.rgba)).toBe(0);
    });

    it('upscales 4x with 360 horizontal cyclic wrap awareness', () => {
        const width = 32;
        const height = 16;
        const original = Buffer.alloc(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                original[idx] = (x < 16) ? 200 : 50;
                original[idx + 1] = 100;
                original[idx + 2] = 50;
                original[idx + 3] = 255;
            }
        }

        const upscaled = Google360PanoramaPipelineService.upscalePanorama4x(original, width, height);
        expect(upscaled.width).toBe(128);
        expect(upscaled.height).toBe(64);
        expect(upscaled.rgba.length).toBe(128 * 64 * 4);
    });

    it('executes complete opinionated 16K pipeline in order: 4K base -> cyclic padding -> 4x upscale -> unpad to 16K -> Laplacian 2-band seam heal', async () => {
        const testWidth = 64;
        const testHeight = 32;
        const testRgba = Buffer.alloc(testWidth * testHeight * 4);

        // Introduce a sharp discontinuity at the boundary (x = 0 vs x = 63)
        for (let y = 0; y < testHeight; y++) {
            for (let x = 0; x < testWidth; x++) {
                const idx = (y * testWidth + x) * 4;
                testRgba[idx] = (x < 32) ? 40 : 220; // 180-unit step
                testRgba[idx + 1] = 120;
                testRgba[idx + 2] = 180;
                testRgba[idx + 3] = 255;
            }
        }

        const testPng = encodePng(testWidth, testHeight, testRgba);
        const result = await service.upscalePanorama16K({
            inputImageBuffer: testPng,
            mockExecution: true,
            seamWidth: 32
        });

        expect(result.success).toBe(true);
        expect(result.outputWidth).toBe(16384);
        expect(result.outputHeight).toBe(8192);
        expect(result.seamHealed).toBe(true);
        expect(result.outputBuffer).toBeInstanceOf(Buffer);
        expect(result.outputBuffer.length).toBeGreaterThan(0);
        expect(result.summary).toContain('16K Ultra-Res 360 Panorama synthesized (16384x8192, 134.2 MP)');
    });
});

describe('Gemini Agent Tools for 360 Panorama', () => {
    it('registers panorama_heal_seam, panorama_inpaint, panorama_generate_360, panorama_reproject_zenith, and panorama_extract_zenith tools', () => {
        const registry = createDefaultToolRegistry();
        const tools = registry.declarations();
        const toolNames = tools.map(t => t.name);

        expect(toolNames).toContain('panorama_heal_seam');
        expect(toolNames).toContain('panorama_inpaint');
        expect(toolNames).toContain('panorama_generate_360');
        expect(toolNames).toContain('panorama_reproject_zenith');
        expect(toolNames).toContain('panorama_extract_zenith');

        const healDecl = tools.find(t => t.name === 'panorama_heal_seam');
        expect(healDecl?.description).toContain('vertical boundary seam');
        expect(healDecl?.parameters.required).toContain('inputImagePath');

        const inpaintDecl = tools.find(t => t.name === 'panorama_inpaint');
        expect(inpaintDecl?.description).toContain('nadir camera rigs');

        const genDecl = tools.find(t => t.name === 'panorama_generate_360');
        expect(genDecl?.description).toContain('equirectangular');
        expect(genDecl?.parameters.required).toContain('prompt');

        const reprojectDecl = tools.find(t => t.name === 'panorama_reproject_zenith');
        expect(reprojectDecl?.description).toContain('rectilinear');
        expect(reprojectDecl?.parameters.required).toContain('baseImagePath');
        expect(reprojectDecl?.parameters.required).toContain('patchImagePath');

        const extractDecl = tools.find(t => t.name === 'panorama_extract_zenith');
        expect(extractDecl?.description).toContain('zenith');
        expect(extractDecl?.parameters.required).toContain('inputImagePath');
    });

    it('dispatches panorama_generate_360 via tool registry in mock mode', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'panorama_generate_360',
            {
                prompt: 'Golden hour desert dunes 360 panorama',
                width: 256,
                height: 128,
                healSeam: true,
                mockExecution: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.width).toBe(256);
        expect(payload.height).toBe(128);
        expect(payload.seamHealed).toBe(true);
        expect(payload.summary).toContain('360 panorama generated successfully');
    });

    it('dispatches panorama_generate_360 with structuredPrompt object via tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const structured = buildEquirectangularStructuredPrompt('Tokyo Shibuya neon night street crossing', {
            lighting: 'Vibrant neon reflections with wet asphalt sheen'
        });

        const outcome = await registry.dispatch(
            'panorama_generate_360',
            {
                prompt: 'Tokyo Shibuya neon crossing',
                structuredPrompt: structured,
                width: 256,
                height: 128,
                mockExecution: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.structuredPrompt).toBeDefined();
        expect(payload.structuredPrompt.image_meta.type).toBe('360-degree Equirectangular Panorama');
        expect(payload.structuredPrompt.image_meta.projection).toBe('Full spherical equirectangular');
        expect(payload.structuredPrompt.image_meta.aspect_ratio).toBe('2:1');
        expect(payload.structuredPrompt.scene_context.description).toBe('Tokyo Shibuya neon night street crossing');
        expect(payload.structuredPrompt.rendering_style.lighting).toBe('Vibrant neon reflections with wet asphalt sheen');
    });
});

describe('Structured 360 Equirectangular Prompt Format (User Specification)', () => {
    it('buildEquirectangularStructuredPrompt produces exact canonical JSON structure', () => {
        const promptObj = buildEquirectangularStructuredPrompt('Ancient Roman Colosseum under sunset golden hour');

        expect(promptObj).toEqual({
            image_meta: {
                type: '360-degree Equirectangular Panorama',
                projection: 'Full spherical equirectangular',
                aspect_ratio: '2:1',
                resolution: 'Ultra-high resolution panoramic capture'
            },
            scene_context: {
                description: 'Ancient Roman Colosseum under sunset golden hour',
                projection_behavior: 'Correct equirectangular distortion near poles',
                depth_of_field: 'Infinite focus (deep focus across entire panorama)'
            },
            rendering_style: {
                stitching: 'Seamless 360-degree panorama stitching, no visible seams. The far-left and far-right edges MUST match perfectly for cyclic continuity.',
                lighting: 'Maintain consistent lighting and shadows from the input image.'
            },
            constraints: {
                must_keep: [
                    'Spherical equirectangular perspective',
                    'Consistent lighting and weather',
                    'Mathematically identical edges (left and right columns)'
                ],
                avoid: [
                    'Blurriness',
                    'Overlaps',
                    'Vertical seams',
                    'Distorted horizons',
                    'Folds in the view'
                ]
            }
        });
    });

    it('buildEquirectangularStructuredPrompt allows custom override of lighting, resolution, and constraints', () => {
        const customPrompt = buildEquirectangularStructuredPrompt('Alpine glacier lake in Norway', {
            lighting: 'Clear crisp morning sunlight with specular water bounce',
            resolution: '8K HDR Master',
            avoid: ['Lens flare', 'Artifacts', 'Stitching seams']
        });

        expect(customPrompt.image_meta.resolution).toBe('8K HDR Master');
        expect(customPrompt.rendering_style.lighting).toBe('Clear crisp morning sunlight with specular water bounce');
        expect(customPrompt.constraints.avoid).toContain('Lens flare');
        expect(customPrompt.constraints.must_keep).toContain('Spherical equirectangular perspective');
    });

    it('generate360Panorama automatically parses JSON string prompt into structured format', async () => {
        const structured = buildEquirectangularStructuredPrompt('Cyberpunk floating sky station above clouds');
        const jsonString = JSON.stringify(structured);

        const result = await generate360Panorama({
            prompt: jsonString,
            width: 256,
            height: 128,
            healSeam: false,
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.structuredPrompt).toBeDefined();
        expect(result.structuredPrompt?.image_meta.type).toBe('360-degree Equirectangular Panorama');
        expect(result.structuredPrompt?.scene_context.description).toBe('Cyberpunk floating sky station above clouds');
        expect(result.structuredPrompt?.constraints.must_keep).toContain('Mathematically identical edges (left and right columns)');
    });

    it('generate360Panorama accepts structured prompt object directly and populates result', async () => {
        const structured: EquirectangularStructuredPrompt = {
            image_meta: {
                type: '360-degree Equirectangular Panorama',
                projection: 'Full spherical equirectangular',
                aspect_ratio: '2:1',
                resolution: 'Ultra-high resolution panoramic capture'
            },
            scene_context: {
                description: 'Panoramic view from the top of the Empire State Building',
                projection_behavior: 'Correct equirectangular distortion near poles',
                depth_of_field: 'Infinite focus (deep focus across entire panorama)'
            },
            rendering_style: {
                stitching: 'Seamless 360-degree panorama stitching, no visible seams. The far-left and far-right edges MUST match perfectly for cyclic continuity.',
                lighting: 'Maintain consistent lighting and shadows from the input image.'
            },
            constraints: {
                must_keep: [
                    'Spherical equirectangular perspective',
                    'Consistent lighting and weather',
                    'Mathematically identical edges (left and right columns)'
                ],
                avoid: [
                    'Blurriness',
                    'Overlaps',
                    'Vertical seams',
                    'Distorted horizons',
                    'Folds in the view'
                ]
            }
        };

        const result = await generate360Panorama({
            prompt: structured,
            width: 256,
            height: 128,
            healSeam: true,
            mockExecution: true
        });

        expect(result.success).toBe(true);
        expect(result.seamHealed).toBe(true);
        expect(result.structuredPrompt).toEqual(structured);
    });

    describe('Google Street View & Photo Sphere (GPano) Mathematics', () => {
        it('maps zenith and nadir spherical angles to exact Cartesian unit vectors', () => {
            // Zenith (+90 deg elevation): ray must point directly up along +Y
            const zenithRay = Google360PanoramaPipelineService.sphericalToCartesian(0, Math.PI / 2);
            expect(Math.abs(zenithRay.x)).toBeLessThan(1e-6);
            expect(zenithRay.y).toBeCloseTo(1.0, 5);
            expect(Math.abs(zenithRay.z)).toBeLessThan(1e-6);

            // Nadir (-90 deg elevation): ray must point directly down along -Y
            const nadirRay = Google360PanoramaPipelineService.sphericalToCartesian(0, -Math.PI / 2);
            expect(Math.abs(nadirRay.x)).toBeLessThan(1e-6);
            expect(nadirRay.y).toBeCloseTo(-1.0, 5);
            expect(Math.abs(nadirRay.z)).toBeLessThan(1e-6);

            // Horizon front (0 deg elevation, 0 azimuth): ray must point along +Z
            const frontRay = Google360PanoramaPipelineService.sphericalToCartesian(0, 0);
            expect(Math.abs(frontRay.x)).toBeLessThan(1e-6);
            expect(Math.abs(frontRay.y)).toBeLessThan(1e-6);
            expect(frontRay.z).toBeCloseTo(1.0, 5);

            // Roundtrip back to spherical angles
            const spherical = Google360PanoramaPipelineService.cartesianToSpherical(frontRay.x, frontRay.y, frontRay.z);
            expect(spherical.theta).toBeCloseTo(0, 5);
            expect(spherical.phi).toBeCloseTo(0, 5);
        });

        it('verifies mathematical invertibility of Google Equi-Angular Cubemap (EAC) warp', () => {
            const testCoordinates = [-0.95, -0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75, 0.95];
            for (const s of testCoordinates) {
                // Forward EAC warp: s_eac = (4/pi) * atan(s)
                const sEac = (4.0 / Math.PI) * Math.atan(s);
                // Inverse EAC warp: s_recovered = tan(s_eac * pi / 4)
                const sRecovered = Math.tan((sEac * Math.PI) / 4.0);
                expect(sRecovered).toBeCloseTo(s, 6);
            }
        });

        it('projects rays to top and bottom cubemap faces without polar singularities', () => {
            // Ray pointing straight up at Zenith (+Y)
            const topProj = Google360PanoramaPipelineService.cartesianToCubemapFace(0, 1, 0, true);
            expect(topProj.face).toBe('top');
            expect(topProj.u).toBeCloseTo(0.5, 3); // center of top face
            expect(topProj.v).toBeCloseTo(0.5, 3);

            // Ray pointing straight down at Nadir (-Y)
            const bottomProj = Google360PanoramaPipelineService.cartesianToCubemapFace(0, -1, 0, true);
            expect(bottomProj.face).toBe('bottom');
            expect(bottomProj.u).toBeCloseTo(0.5, 3); // center of bottom face
            expect(bottomProj.v).toBeCloseTo(0.5, 3);

            // Unprojecting center of top face recovers (0, 1, 0)
            const unprojectedTop = Google360PanoramaPipelineService.cubemapFaceToCartesian('top', 0.5, 0.5, true);
            expect(unprojectedTop.x).toBeCloseTo(0, 5);
            expect(unprojectedTop.y).toBeCloseTo(1, 5);
            expect(unprojectedTop.z).toBeCloseTo(0, 5);
        });

        it('converts equirectangular panorama to 6 Street View cubemap faces (EAC) and back', () => {
            const width = 64;
            const height = 32;
            const inputRgba = Buffer.alloc(width * height * 4);

            // Fill with a gradient test pattern
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    inputRgba[idx] = (x * 4) % 256;       // R
                    inputRgba[idx + 1] = (y * 8) % 256;   // G
                    inputRgba[idx + 2] = 128;             // B
                    inputRgba[idx + 3] = 255;             // A
                }
            }

            const cubemap = Google360PanoramaPipelineService.equirectangularToStreetViewCubemap(
                inputRgba,
                width,
                height,
                32, // 32x32 per face for test
                true // EAC
            );

            expect(cubemap.right.length).toBe(32 * 32 * 4);
            expect(cubemap.left.length).toBe(32 * 32 * 4);
            expect(cubemap.top.length).toBe(32 * 32 * 4);
            expect(cubemap.bottom.length).toBe(32 * 32 * 4);
            expect(cubemap.front.length).toBe(32 * 32 * 4);
            expect(cubemap.back.length).toBe(32 * 32 * 4);

            // Top face (zenith sky) and bottom face (nadir ground) must contain valid non-zero data
            expect(cubemap.top[3]).toBe(255);
            expect(cubemap.bottom[3]).toBe(255);

            // Reproject back to equirectangular
            const reprojected = Google360PanoramaPipelineService.streetViewCubemapToEquirectangular(
                cubemap,
                width,
                height,
                true
            );
            expect(reprojected.length).toBe(width * height * 4);
            expect(reprojected[3]).toBe(255);
        });

        it('applies Street View polar caps guaranteeing zero rotational variance at row 0 and row H-1', () => {
            const width = 64;
            const height = 32;
            const inputRgba = Buffer.alloc(width * height * 4);

            // Intentionally construct a high-frequency polar pattern with different colors across columns
            // (simulating the cause of the starburst pinhole singularity)
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    inputRgba[idx] = (x * 37) % 256;      // R: violently oscillates across columns
                    inputRgba[idx + 1] = (x * 71) % 256;  // G: oscillates
                    inputRgba[idx + 2] = (x * 113) % 256; // B: oscillates
                    inputRgba[idx + 3] = 255;
                }
            }

            const capped = Google360PanoramaPipelineService.applyStreetViewPolarCaps(
                inputRgba,
                width,
                height,
                { zenithRatio: 0.2, nadirRatio: 0.2, smoothExponent: 2.0, azimuthalBlurRadius: 16 }
            );

            // In row 0 (zenith apex), every single column MUST have the exact same color (variance = 0)
            const zenR = capped[0];
            const zenG = capped[1];
            const zenB = capped[2];
            for (let x = 0; x < width; x++) {
                const idx = x * 4;
                expect(capped[idx]).toBe(zenR);
                expect(capped[idx + 1]).toBe(zenG);
                expect(capped[idx + 2]).toBe(zenB);
            }

            // In row H-1 (nadir floor), every single column MUST have the exact same color (variance = 0)
            const botOffset = (height - 1) * width * 4;
            const nadR = capped[botOffset];
            const nadG = capped[botOffset + 1];
            const nadB = capped[botOffset + 2];
            for (let x = 0; x < width; x++) {
                const idx = botOffset + x * 4;
                expect(capped[idx]).toBe(nadR);
                expect(capped[idx + 1]).toBe(nadG);
                expect(capped[idx + 2]).toBe(nadB);
            }
        });
    });

    describe('Inward Perspective Projection (Gnomonic) & Polar Infill', () => {
        it('projects a 2D rectilinear photograph inward into the forward equirectangular frustum', () => {
            const pWidth = 100;
            const pHeight = 100;
            const perspectiveRgba = Buffer.alloc(pWidth * pHeight * 4, 0);

            // Mark center pixel red
            const centerIdx = (50 * pWidth + 50) * 4;
            perspectiveRgba[centerIdx] = 255;
            perspectiveRgba[centerIdx + 3] = 255;

            // Fill entire photo with green
            for (let i = 0; i < pWidth * pHeight; i++) {
                perspectiveRgba[i * 4 + 1] = 200; // G
                perspectiveRgba[i * 4 + 3] = 255; // A
            }

            const panoWidth = 256;
            const panoHeight = 128;
            const result = service.projectPerspectiveImageInward(
                perspectiveRgba,
                pWidth,
                pHeight,
                panoWidth,
                panoHeight,
                90.0
            );

            expect(result.validPixelCount).toBeGreaterThan(0);
            expect(result.coverageRatio).toBeGreaterThan(0.05);
            expect(result.coverageRatio).toBeLessThan(0.40); // natural forward cone

            // The exact center of the equirectangular map (x = panoWidth/2, y = panoHeight/2)
            // must correspond to the center of the photo
            const panoCenterIdx = (Math.floor(panoHeight / 2) * panoWidth + Math.floor(panoWidth / 2)) * 4;
            expect(result.panoRgba[panoCenterIdx + 1]).toBeGreaterThan(150); // Green photo content
            expect(result.maskRgba[panoCenterIdx]).toBe(255); // Fully valid in mask

            // The opposite side (rear, x=0) must be 0 (unprojected / empty for infill)
            const panoRearIdx = (Math.floor(panoHeight / 2) * panoWidth + 0) * 4;
            expect(result.maskRgba[panoRearIdx]).toBe(0);
        });

        it('synthesizes smooth quadratic ceiling and polar masks for generative infill', () => {
            const width = 64;
            const height = 32;

            // Ceiling mask test
            const ceiling = service.createCeilingMask(width, height, 0.25);
            expect(ceiling.alphaMap[0]).toBe(1.0); // Apex zenith 100% masked
            expect(ceiling.alphaMap[1]).toBeGreaterThan(0.5); // Smooth quadratic feather
            expect(ceiling.alphaMap[16]).toBe(0.0); // Horizon / lower region unmasked

            // Dual polar mask test (both ceiling and nadir)
            const polar = service.createPolarMask(width, height, 0.20, 0.20);
            expect(polar.alphaMap[0]).toBe(1.0); // Zenith 100% masked
            expect(polar.alphaMap[height - 1]).toBe(1.0); // Nadir 100% masked
            expect(polar.alphaMap[Math.floor(height / 2)]).toBe(0.0); // Equator 0% masked
        });

        it('inpaints ceiling (sky/zenith) and dual polar regions in mock execution mode', async () => {
            const width = 64;
            const height = 32;
            const initialRgba = Buffer.alloc(width * height * 4, 128); // mid-grey initial image
            const initialPng = encodePng(width, height, initialRgba);

            // Ceiling-only inpaint
            const ceilingResult = await service.inpaintPanorama({
                inputImageBuffer: initialPng,
                ceilingOnly: true,
                ceilingRatio: 0.25,
                mockExecution: true
            });

            expect(ceilingResult.success).toBe(true);
            expect(ceilingResult.modelUsed).toContain('ceiling');
            expect(ceilingResult.width).toBe(width);
            expect(ceilingResult.height).toBe(height);

            // Dual polar inpaint (both ceiling and floor)
            const polarResult = await service.inpaintPanorama({
                inputImageBuffer: initialPng,
                inpaintBothPolar: true,
                ceilingRatio: 0.20,
                nadirRatio: 0.20,
                mockExecution: true
            });

            expect(polarResult.success).toBe(true);
            expect(polarResult.modelUsed).toContain('polar');
            expect(polarResult.width).toBe(width);
            expect(polarResult.height).toBe(height);
        });

        it('generates a full 360 equirectangular panorama from an input 2D image with infill and polar filtering', async () => {
            const pWidth = 120;
            const pHeight = 80;
            const inputRgba = Buffer.alloc(pWidth * pHeight * 4, 180); // perspective 2D image
            const inputPng = encodePng(pWidth, pHeight, inputRgba);

            const result = await service.generatePanoramaFromImage({
                inputImageBuffer: inputPng,
                width: 128,
                height: 64,
                hfovDeg: 90.0,
                infillCeiling: true,
                infillFloor: true,
                healSeam: true,
                mockExecution: true
            });

            expect(result.success).toBe(true);
            expect(result.width).toBe(128);
            expect(result.height).toBe(64);
            expect(result.coverageRatio).toBeGreaterThan(0.05);
            expect(result.outputBuffer.length).toBeGreaterThan(0);
            expect(result.summary).toContain('360 panorama generated from perspective image successfully');
        });

        it('projects an input image concavely around the user with linear elevation mapping (zero cos(lambda) pinch)', () => {
            const pWidth = 100;
            const pHeight = 50;
            const pRgba = Buffer.alloc(pWidth * pHeight * 4, 0);

            // Draw a distinct horizontal stripe at rows 24, 25, 26 (elevation phi ~ 0, horizon)
            for (let py = 24; py <= 26; py++) {
                for (let px = 0; px < pWidth; px++) {
                    const idx = (py * pWidth + px) * 4;
                    pRgba[idx] = 255;
                    pRgba[idx + 1] = 255;
                    pRgba[idx + 2] = 255;
                    pRgba[idx + 3] = 255;
                }
            }

            const panoWidth = 128;
            const panoHeight = 64;
            const proj = Google360PanoramaPipelineService.projectAroundUserPanorama(
                pRgba,
                pWidth,
                pHeight,
                panoWidth,
                panoHeight,
                140.0,
                { infillSurrounds: false, healSeam: false }
            );

            // Check that in the forward sector, the horizontal stripe stays on horizon rows (31 and 32)
            // across all azimuths and does NOT pinch/curve vertically like gnomonic projection
            let horizonHitCount = 0;
            for (let x = 32; x < 96; x++) {
                const idx31 = (31 * panoWidth + x) * 4;
                const idx32 = (32 * panoWidth + x) * 4;
                if (proj.panoRgba[idx31] > 100 || proj.panoRgba[idx32] > 100) {
                    horizonHitCount++;
                }
            }
            // Linear elevation mapping preserves horizontal lines across all longitudes
            expect(horizonHitCount).toBeGreaterThanOrEqual(45);
        });

        it('synthesizes 100% full 360x180 surround with all perspectives infilled and polar cap invariance', () => {
            const pWidth = 80;
            const pHeight = 60;
            const pRgba = Buffer.alloc(pWidth * pHeight * 4, 100);

            const panoWidth = 64;
            const panoHeight = 32;
            const proj = Google360PanoramaPipelineService.projectAroundUserPanorama(
                pRgba,
                pWidth,
                pHeight,
                panoWidth,
                panoHeight,
                140.0,
                { infillSurrounds: true, healSeam: true }
            );

            expect(proj.coverageRatio).toBe(1.0);
            expect(proj.validPixelCount).toBeGreaterThan(0);

            // Verify all pixels are filled (alpha = 255)
            for (let y = 0; y < panoHeight; y++) {
                for (let x = 0; x < panoWidth; x++) {
                    const a = proj.panoRgba[(y * panoWidth + x) * 4 + 3];
                    expect(a).toBe(255);
                }
            }

            // Verify rotational invariance at zenith (row 0)
            const zenithR0 = proj.panoRgba[0];
            const zenithG0 = proj.panoRgba[1];
            const zenithB0 = proj.panoRgba[2];
            for (let x = 1; x < panoWidth; x++) {
                const idx = x * 4;
                expect(proj.panoRgba[idx]).toBe(zenithR0);
                expect(proj.panoRgba[idx + 1]).toBe(zenithG0);
                expect(proj.panoRgba[idx + 2]).toBe(zenithB0);
            }
        });

        it('always executes boundary seam heal automatically by default when options are omitted', () => {
            const pWidth = 80;
            const pHeight = 60;
            const pRgba = Buffer.alloc(pWidth * pHeight * 4, 150);

            const panoWidth = 64;
            const panoHeight = 32;
            // Call without options or with empty options - healSeam must default to true
            const projDefault = Google360PanoramaPipelineService.projectAroundUserPanorama(
                pRgba,
                pWidth,
                pHeight,
                panoWidth,
                panoHeight,
                140.0
            );

            expect(projDefault.coverageRatio).toBe(1.0);
            expect(projDefault.validPixelCount).toBeGreaterThan(0);

            // Boundary continuity: verify left edge (x=0) and right edge (x=panoWidth-1) transition smoothly without discontinuity
            for (let y = 8; y < panoHeight - 8; y++) {
                const leftIdx = (y * panoWidth + 0) * 4;
                const rightIdx = (y * panoWidth + (panoWidth - 1)) * 4;
                const diffR = Math.abs(projDefault.panoRgba[leftIdx] - projDefault.panoRgba[rightIdx]);
                const diffG = Math.abs(projDefault.panoRgba[leftIdx + 1] - projDefault.panoRgba[rightIdx + 1]);
                const diffB = Math.abs(projDefault.panoRgba[leftIdx + 2] - projDefault.panoRgba[rightIdx + 2]);
                expect(diffR).toBeLessThan(10);
                expect(diffG).toBeLessThan(10);
                expect(diffB).toBeLessThan(10);
            }
        });
    });
});

describe('Task Capability Resolver - 360 Panorama Routing', () => {
    it('classifies 360 panorama seam healing as Tier 1 native Google Models', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Heal the vertical boundary seam on my 360 equirectangular panorama using Google Imagen 3 inpainting',
            { domainHint: '3d' }
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
        expect(resolution.tier1Assessment.rationale).toMatch(/panorama|seam/i);
    });

    it('classifies nadir rig inpainting as Tier 1 native Google Models', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Inpaint and remove the nadir camera tripod rig from this 360 panorama',
            { domainHint: 'generative' }
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
    });

    it('preserves Tier 2 ComfyUI fallback for neural novel view synthesis or video restyling', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Generate novel views from single image using Trellis image-to-3D diffusion model',
            { domainHint: '3d' }
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier2-comfyui');
        expect(resolution.tier2Fallback.recommendedPipelineCategory).toBe('image-to-3d');
    });
});

describe('Google 360 Panorama Pipeline Service - Automated Quality Control (QC) Gate', () => {
    it('detects boundary meridian seams and polar variance on unhealed panoramas', () => {
        const width = 128;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                // Left side is bright red, right side is dark blue -> huge boundary discontinuity
                if (x < width / 2) {
                    rgba[idx] = 250;
                    rgba[idx + 1] = 20;
                    rgba[idx + 2] = 20;
                } else {
                    rgba[idx] = 10;
                    rgba[idx + 1] = 20;
                    rgba[idx + 2] = 240;
                }
                rgba[idx + 3] = 255;
            }
        }

        // Add alternating high variance to zenith apex row 0
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            rgba[idx] = (x % 2 === 0) ? 255 : 0;
            rgba[idx + 1] = (x % 2 === 0) ? 255 : 0;
            rgba[idx + 2] = (x % 2 === 0) ? 255 : 0;
        }

        const audit = Google360PanoramaPipelineService.auditPanoramaQuality(rgba, width, height);
        expect(audit.pass).toBe(false);
        expect(audit.qualityScore).toBeLessThan(50);
        expect(audit.metrics.meridianRms).toBeGreaterThan(100);
        expect(audit.metrics.zenithStdDev).toBeGreaterThan(50);
        expect(audit.violations.length).toBeGreaterThanOrEqual(2);
        expect(audit.remediationHints.some(h => h.includes('applyStreetViewPolarCaps'))).toBe(true);
        expect(audit.remediationHints.some(h => h.includes('enforceBitExactBoundarySeam'))).toBe(true);
    });

    it('certifies 100/100 score and pass:true after polar caps and bit-exact boundary enforcement', () => {
        const width = 128;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                rgba[idx] = 120 + Math.round(30 * Math.sin((x / width) * Math.PI * 2));
                rgba[idx + 1] = 140;
                rgba[idx + 2] = 180;
                rgba[idx + 3] = 255;
            }
        }

        // Apply polar caps & bit-exact boundary seam
        const polarCapped = Google360PanoramaPipelineService.applyStreetViewPolarCaps(rgba, width, height, {
            zenithRatio: 0.15,
            nadirRatio: 0.15,
            smoothExponent: 2.0
        });
        const seamless = Google360PanoramaPipelineService.enforceBitExactBoundarySeam(polarCapped, width, height, 8);

        const audit = Google360PanoramaPipelineService.auditPanoramaQuality(seamless, width, height);
        expect(audit.pass).toBe(true);
        expect(audit.qualityScore).toBe(100);
        expect(audit.metrics.meridianRms).toBe(0);
        expect(audit.metrics.meridianMaxDelta).toBe(0);
        expect(audit.metrics.zenithStdDev).toBe(0);
        expect(audit.metrics.nadirStdDev).toBe(0);
        expect(audit.violations.length).toBe(0);
    });

    it('mathematically detects focal architectural apex in upper hemisphere', () => {
        const width = 128;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4);

        // Fill background with darker shade (coffers/ceiling)
        for (let i = 0; i < width * height; i++) {
            rgba[i * 4] = 60;
            rgba[i * 4 + 1] = 50;
            rgba[i * 4 + 2] = 40;
            rgba[i * 4 + 3] = 255;
        }

        // Place a bright circular oculus at pitch = +45°, yaw = +45°
        // y in [0, H-1]: pitch = (0.5 - y/H)*180 = 45 => y = H * (0.5 - 45/180) = 64 * 0.25 = 16
        // x in [0, W-1]: yaw = (x/W - 0.5)*360 = 45 => x = W * (0.5 + 45/360) = 128 * 0.625 = 80
        const targetX = 80;
        const targetY = 16;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                if (dx * dx + dy * dy <= 4) {
                    const idx = ((targetY + dy) * width + (targetX + dx)) * 4;
                    rgba[idx] = 255;
                    rgba[idx + 1] = 250;
                    rgba[idx + 2] = 220;
                }
            }
        }

        const apex = Google360PanoramaPipelineService.detectEquirectangularApex(rgba, width, height);
        expect(apex.centroid.x).toBeCloseTo(targetX, 0);
        expect(apex.centroid.y).toBeCloseTo(targetY, 0);
        expect(apex.pitchDeg).toBeGreaterThan(40);
        expect(apex.pitchDeg).toBeLessThan(50);
        expect(apex.yawDeg).toBeGreaterThan(40);
        expect(apex.yawDeg).toBeLessThan(50);
        expect(apex.angularOffsetDeg).toBeCloseTo(90 - apex.pitchDeg, 1);
        expect(apex.method).toBe('photometric_centroid');
    });

    it('rotates equirectangular panorama via SO(3) to align detected apex to zenith', () => {
        const width = 128;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4);

        // Dark background
        for (let i = 0; i < width * height; i++) {
            rgba[i * 4] = 50;
            rgba[i * 4 + 1] = 50;
            rgba[i * 4 + 2] = 50;
            rgba[i * 4 + 3] = 255;
        }

        // Place bright spot at pitch = +45°, yaw = 0°
        // y = 64 * 0.25 = 16, x = 128 * 0.5 = 64
        const targetX = 64;
        const targetY = 16;
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                if (dx * dx + dy * dy <= 4) {
                    const idx = ((targetY + dy) * width + (targetX + dx)) * 4;
                    rgba[idx] = 255;
                    rgba[idx + 1] = 255;
                    rgba[idx + 2] = 255;
                }
            }
        }

        const initialApex = Google360PanoramaPipelineService.detectEquirectangularApex(rgba, width, height);
        expect(initialApex.pitchDeg).toBeCloseTo(45, 1);

        // Rotate using SO(3) to align initialApex to zenith
        const rotated = Google360PanoramaPipelineService.rotateEquirectangularSO3(rgba, width, height, {
            targetApex: { yawDeg: initialApex.yawDeg, pitchDeg: initialApex.pitchDeg },
            healSeam: true
        });

        const rotatedApex = Google360PanoramaPipelineService.detectEquirectangularApex(rotated, width, height);
        // After rotating to zenith, the bright apex should be at pitch > 75° (approaching 90° zenith)
        expect(rotatedApex.pitchDeg).toBeGreaterThan(75);
        expect(rotatedApex.angularOffsetDeg).toBeLessThan(15);
    });

    it('preserves architectural details at row 0 when adaptive polar capping is enabled', () => {
        const width = 128;
        const height = 64;
        const rgba = Buffer.alloc(width * height * 4);

        // Create high-variance alternating pattern on row 0 (e.g. coffered masonry)
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            const val = (x % 4 < 2) ? 200 : 50;
            rgba[idx] = val;
            rgba[idx + 1] = val;
            rgba[idx + 2] = val;
            rgba[idx + 3] = 255;
        }

        // Fill remaining rows
        for (let y = 1; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                rgba[idx] = 100;
                rgba[idx + 1] = 100;
                rgba[idx + 2] = 100;
                rgba[idx + 3] = 255;
            }
        }

        // Test with adaptive: true -> should PRESERVE the variance at row 0
        const adaptiveCapped = Google360PanoramaPipelineService.applyStreetViewPolarCaps(rgba, width, height, {
            adaptive: true,
            zenithRatio: 0.15
        });

        // Compute row 0 standard deviation in adaptive result
        let sum = 0, sumSq = 0;
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            const lum = 0.299 * adaptiveCapped[idx] + 0.587 * adaptiveCapped[idx + 1] + 0.114 * adaptiveCapped[idx + 2];
            sum += lum;
            sumSq += lum * lum;
        }
        const mean = sum / width;
        const stdAdaptive = Math.sqrt(Math.max(0, (sumSq / width) - (mean * mean)));
        expect(stdAdaptive).toBeGreaterThan(50); // Preserved authentic masonry coffer variance!

        // Test with adaptive: false -> should WIPE OUT row 0 to a flat solid color disc
        const flatCapped = Google360PanoramaPipelineService.applyStreetViewPolarCaps(rgba, width, height, {
            adaptive: false,
            zenithRatio: 0.15
        });

        let sumFlat = 0, sumSqFlat = 0;
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            const lum = 0.299 * flatCapped[idx] + 0.587 * flatCapped[idx + 1] + 0.114 * flatCapped[idx + 2];
            sumFlat += lum;
            sumSqFlat += lum * lum;
        }
        const meanFlat = sumFlat / width;
        const stdFlat = Math.sqrt(Math.max(0, (sumSqFlat / width) - (meanFlat * meanFlat)));
        expect(stdFlat).toBeCloseTo(0, 1); // Zero variance Street View disc
    });
});

describe('Option A: Adaptive Two-Pass Zenith Reprojection', () => {
    it('extracts a 1:1 rectilinear patch looking directly up at zenith (+Y)', () => {
        const width = 128;
        const height = 64;
        const base = Buffer.alloc(width * height * 4, 100);

        // Put a distinctive color gradient in the polar cap
        for (let y = 0; y < 16; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                base[idx] = 200;
                base[idx + 1] = 150;
                base[idx + 2] = 50 + y * 5;
                base[idx + 3] = 255;
            }
        }

        const patchRes = 64;
        const patch = Google360PanoramaPipelineService.extractZenithRectilinearPatch(base, width, height, {
            patchResolution: patchRes,
            fovDegrees: 90
        });

        expect(patch.length).toBe(patchRes * patchRes * 4);
        // Center pixel of the patch corresponds to exact zenith (y=0 in equirectangular)
        const centerIdx = ((patchRes / 2) * patchRes + (patchRes / 2)) * 4;
        expect(patch[centerIdx]).toBe(200);
        expect(patch[centerIdx + 1]).toBe(150);
        expect(patch[centerIdx + 3]).toBe(255);
    });

    it('reprojects a 1:1 rectilinear patch onto equirectangular panorama and eliminates polar pinch (std dev 0.00)', () => {
        const width = 128;
        const height = 64;
        const base = Buffer.alloc(width * height * 4, 120);

        // Create a synthetic pinched polar cap in row 0
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            base[idx] = (x % 2 === 0) ? 50 : 250; // High pinching variance in row 0
        }

        // Create a pristine 1:1 rectilinear patch with uniform center
        const patchRes = 64;
        const patch = Buffer.alloc(patchRes * patchRes * 4, 180);
        // Concentric circular pattern
        for (let py = 0; py < patchRes; py++) {
            for (let px = 0; px < patchRes; px++) {
                const dx = (px + 0.5) / patchRes - 0.5;
                const dy = (py + 0.5) / patchRes - 0.5;
                const r = Math.sqrt(dx * dx + dy * dy);
                const idx = (py * patchRes + px) * 4;
                patch[idx] = Math.round(180 + 40 * Math.cos(r * 20));
                patch[idx + 1] = 160;
                patch[idx + 2] = 140;
                patch[idx + 3] = 255;
            }
        }

        const reprojected = Google360PanoramaPipelineService.reprojectZenithRectilinearPatch(
            base,
            width,
            height,
            patch,
            patchRes,
            {
                fovDegrees: 90,
                innerBlendRadius: 0.65,
                outerBlendRadius: 0.95,
                matchIllumination: false
            }
        );

        // Check row 0: all pixels in row 0 must map to center of patch (s~0, t~0) -> smooth variance ~ 0
        let sum = 0, sumSq = 0;
        const firstPixelR = reprojected[0];
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            const r = reprojected[idx];
            expect(Math.abs(r - firstPixelR)).toBeLessThanOrEqual(1); // Row 0 is smooth with minimal rounding jitter
            sum += r;
            sumSq += r * r;
        }
        const mean = sum / width;
        const stdRow0 = Math.sqrt(Math.max(0, (sumSq / width) - (mean * mean)));
        expect(stdRow0).toBeLessThan(1.0); // Polar pinch variance eliminated! (Base was std 100, now < 1.0)
    });

    it('strictly preserves identity in the lower hemisphere and outside blend radius', () => {
        const width = 128;
        const height = 64;
        const base = Buffer.alloc(width * height * 4);
        for (let i = 0; i < base.length; i++) {
            base[i] = (i * 17 + 3) % 256;
        }

        const patchRes = 32;
        const patch = Buffer.alloc(patchRes * patchRes * 4, 255);

        const reprojected = Google360PanoramaPipelineService.reprojectZenithRectilinearPatch(
            base,
            width,
            height,
            patch,
            patchRes,
            {
                fovDegrees: 90,
                innerBlendRadius: 0.65,
                outerBlendRadius: 0.95
            }
        );

        // Equator and lower hemisphere (y >= 32) must be bit-for-bit identical to base
        for (let y = 32; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                expect(reprojected[idx]).toBe(base[idx]);
                expect(reprojected[idx + 1]).toBe(base[idx + 1]);
                expect(reprojected[idx + 2]).toBe(base[idx + 2]);
                expect(reprojected[idx + 3]).toBe(base[idx + 3]);
            }
        }
    });

    it('balances ring illumination between patch and base canvas', () => {
        const width = 128;
        const height = 64;
        // Base canvas is brighter (200)
        const base = Buffer.alloc(width * height * 4, 200);

        // Patch is darker (100)
        const patchRes = 64;
        const patch = Buffer.alloc(patchRes * patchRes * 4, 100);

        const reprojectedWithMatch = Google360PanoramaPipelineService.reprojectZenithRectilinearPatch(
            base,
            width,
            height,
            patch,
            patchRes,
            {
                fovDegrees: 90,
                innerBlendRadius: 0.6,
                outerBlendRadius: 0.9,
                matchIllumination: true
            }
        );

        // Inside the apex cap, luminance should have been shifted upward toward base illumination (close to 200)
        const apexR = reprojectedWithMatch[0];
        expect(apexR).toBeGreaterThan(180); // Exposure-matched to base canvas
    });

    it('capability resolver routes zenith polar pinch reprojection to Tier 1 native', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'reproject 1:1 rectilinear ceiling patch to eliminate dome polar pinch in 360 panorama',
            { domainHint: '3d' }
        );

        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
        expect(resolution.tier1Assessment.rationale).toMatch(/zenith|polar|pinch|dome/i);
    });
});


