/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import {
    MultiPerspectivePanoramaSynthesisService,
    generate360Perspectives,
    PanoramaPerspective
} from '../src/node/spatial/MultiPerspectivePanoramaSynthesisService';
import { Google360PanoramaPipelineService } from '../src/node/spatial/Google360PanoramaPipelineService';
import { encodePng } from '../src/node/texture-processing';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

// Image model ids the Gemini API and Vertex AI answer to; the fake client 404s anything else, as both backends do.
const SERVED_IMAGE_MODEL_IDS = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];

/** Credentials whose client answers served ids with a flat 24x24 PNG of `level`, records every model asked, and 404s the rest. */
function fakeImageCredentials(calls: string[], answer: 'image' | 'empty' = 'image', level = 90): any {
    const png = encodePng(24, 24, Buffer.alloc(24 * 24 * 4, level));
    return {
        createClient: async () => ({
            models: {
                generateContent: async ({ model }: { model: string }) => {
                    calls.push(model);
                    if (!SERVED_IMAGE_MODEL_IDS.includes(model)) {
                        throw Object.assign(new Error(`models/${model} is not found`), { status: 404 });
                    }
                    const parts = answer === 'image' ? [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] : [];
                    return { candidates: [{ finishReason: 'STOP', content: { parts } }] };
                }
            }
        })
    };
}

describe('Multi-Perspective 360° & Zenith/Nadir Synthesis Service', () => {

    it('defines complete 6-camera canonical cube rig covering full sphere', () => {
        const cameras = MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS;
        const expectedFaces: PanoramaPerspective[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];

        for (const face of expectedFaces) {
            expect(cameras[face]).toBeDefined();
            expect(cameras[face].fovDeg).toBe(90.0);
            expect(cameras[face].aspectRatio).toBe(1.0);
        }

        expect(cameras.front.yawDeg).toBe(0.0);
        expect(cameras.front.pitchDeg).toBe(0.0);

        expect(cameras.right.yawDeg).toBe(90.0);
        expect(cameras.right.pitchDeg).toBe(0.0);

        expect(cameras.back.yawDeg).toBe(180.0);
        expect(cameras.back.pitchDeg).toBe(0.0);

        expect(cameras.left.yawDeg).toBe(-90.0);
        expect(cameras.left.pitchDeg).toBe(0.0);

        expect(cameras.top.pitchDeg).toBe(90.0);
        expect(cameras.bottom.pitchDeg).toBe(-90.0);
    });

    it('extracts all 6 rectilinear perspective cameras from an equirectangular panorama', () => {
        const panoW = 128;
        const panoH = 64;
        const panoRgba = Buffer.alloc(panoW * panoH * 4);

        // Fill equirectangular panorama with distinctive gradient
        for (let y = 0; y < panoH; y++) {
            for (let x = 0; x < panoW; x++) {
                const idx = (y * panoW + x) * 4;
                panoRgba[idx] = Math.round((x / panoW) * 255);
                panoRgba[idx + 1] = Math.round((y / panoH) * 255);
                panoRgba[idx + 2] = 128;
                panoRgba[idx + 3] = 255;
            }
        }

        const faceRes = 32;
        const frontPlate = MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
            panoRgba, panoW, panoH, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.front, faceRes, faceRes
        );

        expect(frontPlate.width).toBe(faceRes);
        expect(frontPlate.height).toBe(faceRes);
        expect(frontPlate.rgba.length).toBe(faceRes * faceRes * 4);
        expect(frontPlate.isSynthesized).toBe(false);
        expect(frontPlate.cameraConfig.name).toBe('front');

        const topPlate = MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
            panoRgba, panoW, panoH, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.top, faceRes, faceRes
        );
        expect(topPlate.cameraConfig.pitchDeg).toBe(90.0);

        const bottomPlate = MultiPerspectivePanoramaSynthesisService.extractPerspectiveFromEquirectangular(
            panoRgba, panoW, panoH, MultiPerspectivePanoramaSynthesisService.CANONICAL_CAMERAS.bottom, faceRes, faceRes
        );
        expect(bottomPlate.cameraConfig.pitchDeg).toBe(-90.0);
    });

    it('synthesizes all 5 missing perspective plates (Right, Left, Back, Top, Bottom) from a single 2D image', () => {
        const res = 64;
        const frontRgba = Buffer.alloc(res * res * 4);

        // Synthesize an architectural facade with sky on top, ground on bottom
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const idx = (y * res + x) * 4;
                if (y < res * 0.35) {
                    // Sky
                    frontRgba[idx] = 135;
                    frontRgba[idx + 1] = 190;
                    frontRgba[idx + 2] = 245;
                } else if (y > res * 0.75) {
                    // Pavement
                    frontRgba[idx] = 50;
                    frontRgba[idx + 1] = 55;
                    frontRgba[idx + 2] = 60;
                } else {
                    // Facade
                    frontRgba[idx] = 180;
                    frontRgba[idx + 1] = 150;
                    frontRgba[idx + 2] = 120;
                }
                frontRgba[idx + 3] = 255;
            }
        }

        const perspectives = MultiPerspectivePanoramaSynthesisService.synthesizeMissingPerspectivesFromFront(
            frontRgba,
            res,
            { styleHint: 'urban sunset street' }
        );

        expect(perspectives.front).toBeDefined();
        expect(perspectives.right).toBeDefined();
        expect(perspectives.back).toBeDefined();
        expect(perspectives.left).toBeDefined();
        expect(perspectives.top).toBeDefined();
        expect(perspectives.bottom).toBeDefined();

        expect(perspectives.front.isSynthesized).toBe(false);
        expect(perspectives.right.isSynthesized).toBe(true);
        expect(perspectives.back.isSynthesized).toBe(true);
        expect(perspectives.left.isSynthesized).toBe(true);
        expect(perspectives.top.isSynthesized).toBe(true);
        expect(perspectives.bottom.isSynthesized).toBe(true);

        // Verify boundary edge continuity:
        // 1. Right flank left edge (x=0) must match front right edge (x=res-1)
        for (let y = 0; y < res; y++) {
            const frontRightIdx = (y * res + (res - 1)) * 4;
            const rightLeftIdx = (y * res + 0) * 4;

            expect(perspectives.right.rgba[rightLeftIdx]).toBeCloseTo(perspectives.front.rgba[frontRightIdx], -1);
            expect(perspectives.right.rgba[rightLeftIdx + 1]).toBeCloseTo(perspectives.front.rgba[frontRightIdx + 1], -1);
            expect(perspectives.right.rgba[rightLeftIdx + 2]).toBeCloseTo(perspectives.front.rgba[frontRightIdx + 2], -1);
        }

        // 2. Left flank right edge (x=res-1) must match front left edge (x=0)
        for (let y = 0; y < res; y++) {
            const frontLeftIdx = (y * res + 0) * 4;
            const leftRightIdx = (y * res + (res - 1)) * 4;

            expect(perspectives.left.rgba[leftRightIdx]).toBeCloseTo(perspectives.front.rgba[frontLeftIdx], -1);
            expect(perspectives.left.rgba[leftRightIdx + 1]).toBeCloseTo(perspectives.front.rgba[frontLeftIdx + 1], -1);
            expect(perspectives.left.rgba[leftRightIdx + 2]).toBeCloseTo(perspectives.front.rgba[frontLeftIdx + 2], -1);
        }

        // 3. Zenith (top) apex center must be smooth and valid RGB
        const halfRes = res / 2;
        const zenithApexIdx = (halfRes * res + halfRes) * 4;
        expect(perspectives.top.rgba[zenithApexIdx + 3]).toBe(255);

        // 4. Nadir (bottom) center must be smooth and valid RGB
        const nadirCenterIdx = (halfRes * res + halfRes) * 4;
        expect(perspectives.bottom.rgba[nadirCenterIdx + 3]).toBe(255);
    });

    it('stitches the 6 perspectives into a 360 equirectangular panorama and verifies coverage', () => {
        const res = 32;
        const frontRgba = Buffer.alloc(res * res * 4, 180);

        const perspectives = MultiPerspectivePanoramaSynthesisService.synthesizeMissingPerspectivesFromFront(frontRgba, res);
        const stitched = MultiPerspectivePanoramaSynthesisService.stitchPerspectivesToEquirectangular(
            perspectives,
            128,
            64,
            true
        );

        expect(stitched.panoRgba.length).toBe(128 * 64 * 4);
        expect(stitched.pngBuffer).toBeInstanceOf(Buffer);
        expect(stitched.pngBuffer.length).toBeGreaterThan(100);

        // Verify cubemap faces contain all 6 directions
        expect(stitched.cubemapFaces.front).toBeDefined();
        expect(stitched.cubemapFaces.right).toBeDefined();
        expect(stitched.cubemapFaces.back).toBeDefined();
        expect(stitched.cubemapFaces.left).toBeDefined();
        expect(stitched.cubemapFaces.top).toBeDefined();
        expect(stitched.cubemapFaces.bottom).toBeDefined();
    });

    it('runs end-to-end generate360Perspectives from image buffer and saves perspective plates', async () => {
        const tmpDir = path.join(os.tmpdir(), `test_perspectives_${Date.now()}`);
        await fs.ensureDir(tmpDir);

        const imgW = 64;
        const imgH = 48; // perspective 4:3 image
        const imgRgba = Buffer.alloc(imgW * imgH * 4);

        for (let y = 0; y < imgH; y++) {
            for (let x = 0; x < imgW; x++) {
                const idx = (y * imgW + x) * 4;
                imgRgba[idx] = Math.round((x / imgW) * 200);
                imgRgba[idx + 1] = Math.round((y / imgH) * 200);
                imgRgba[idx + 2] = 220;
                imgRgba[idx + 3] = 255;
            }
        }
        const imgPng = encodePng(imgW, imgH, imgRgba);

        const calls: string[] = [];
        const service = new MultiPerspectivePanoramaSynthesisService(fakeImageCredentials(calls));
        const result = await service.generate360Perspectives({
            inputImageBuffer: imgPng,
            faceResolution: 32,
            equirectangularWidth: 128,
            equirectangularHeight: 64,
            outputDir: tmpDir
        });

        expect(result.success).toBe(true);
        expect(calls).toEqual(Array(5).fill('gemini-3.1-flash-image'));
        expect(result.modelUsed).toBe('gemini-3.1-flash-image');
        expect(result.coverageAngleDegrees.horizontal).toBe(360.0);
        expect(result.coverageAngleDegrees.vertical).toBe(180.0);
        expect(result.perspectivesSynthesized).toContain('top');
        expect(result.perspectivesSynthesized).toContain('bottom');

        // Check written perspective files
        const faces: PanoramaPerspective[] = ['front', 'right', 'back', 'left', 'top', 'bottom'];
        for (const face of faces) {
            const filePath = path.join(tmpDir, `perspective_${face}.png`);
            expect(await fs.pathExists(filePath)).toBe(true);
            const stat = await fs.stat(filePath);
            expect(stat.size).toBeGreaterThan(50);
        }

        const panoPath = path.join(tmpDir, 'stitched_360_equirectangular.png');
        expect(await fs.pathExists(panoPath)).toBe(true);

        await fs.remove(tmpDir);
    });

    it('dispatches panorama_generate_perspectives tool through Gemini tool registry', async () => {
        const tmpDir = path.join(os.tmpdir(), `test_tool_persp_${Date.now()}`);
        await fs.ensureDir(tmpDir);

        const inputPath = path.join(tmpDir, 'input_street.png');
        const imgW = 40, imgH = 30;
        const buf = Buffer.alloc(imgW * imgH * 4, 120);
        await fs.writeFile(inputPath, encodePng(imgW, imgH, buf));

        // No test reaches a real model: the tool's client is a fake.
        const calls: string[] = [];
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(await fakeImageCredentials(calls).createClient());
        try {
            const registry = createDefaultToolRegistry();
            const tool = registry.get('panorama_generate_perspectives');
            expect(tool).toBeDefined();
            expect(tool?.name).toBe('panorama_generate_perspectives');
            expect(Object.keys(tool?.declaration.parameters.properties || {})).not.toContain('mockExecution');

            // The user asked for procedural perspectives: no model call, and the summary says so.
            const procedural = await registry.dispatch('panorama_generate_perspectives', {
                inputImagePath: inputPath,
                faceResolution: 32,
                equirectangularWidth: 128,
                equirectangularHeight: 64,
                useNanoBanana: false,
                outputDir: tmpDir
            }, {} as any);

            expect(procedural.exec.summaryResult).toContain('360°x180°');
            expect(procedural.exec.summaryResult).toContain('useNanoBanana: false');
            expect(procedural.exec.summaryResult).toContain('no model call');
            expect(procedural.exec.summaryResult).toContain('TOP');
            expect(procedural.exec.summaryResult).toContain('BOTTOM');
            expect(calls).toEqual([]);

            // A model-supplied mockExecution is no longer honoured: the image model makes the views and is named.
            const generated = await registry.dispatch('panorama_generate_perspectives', {
                inputImagePath: inputPath,
                faceResolution: 32,
                equirectangularWidth: 128,
                equirectangularHeight: 64,
                mockExecution: true
            }, {} as any);
            expect(generated.exec.status).toBe('completed');
            expect(calls).toEqual(Array(5).fill('gemini-3.1-flash-image'));
            expect(generated.exec.summaryResult).toContain('Generated with gemini-3.1-flash-image.');
        } finally {
            vi.restoreAllMocks();
            await fs.remove(tmpDir);
        }
    });

    it('builds specialized Nano Banana 2 prompts for all 5 missing perspective views', () => {
        const perspectives: PanoramaPerspective[] = ['right', 'back', 'left', 'top', 'bottom'];
        const options = {
            locationName: 'Shibuya Crossing, Tokyo',
            prompt: 'vibrant neon-lit urban intersection at twilight'
        };

        for (const p of perspectives) {
            const prompt = MultiPerspectivePanoramaSynthesisService.buildNanoBananaPerspectivePrompt(p, options);
            expect(prompt).toContain('1:1 square aspect ratio rectilinear perspective (90° x 90° FoV)');
            expect(prompt).toContain('Shibuya Crossing, Tokyo');
            expect(prompt).toContain('vibrant neon-lit urban intersection at twilight');

            if (p === 'right') {
                expect(prompt).toContain('+90° yaw clockwise rotation');
                expect(prompt).toContain('left boundary of this image connects seamlessly to the right boundary of the front reference image');
            } else if (p === 'back') {
                expect(prompt).toContain('180° yaw rotation');
                expect(prompt).toContain('opposing vista directly behind the camera vantage point');
            } else if (p === 'left') {
                expect(prompt).toContain('-90° yaw counter-clockwise rotation');
                expect(prompt).toContain('right boundary of this image connects seamlessly to the left boundary of the front reference image');
            } else if (p === 'top') {
                expect(prompt).toContain('celestial zenith perspective looking straight up (+90° vertical pitch)');
                expect(prompt).toContain('bottom boundary of this image welds seamlessly to the top boundary of the front reference image');
            } else if (p === 'bottom') {
                expect(prompt).toContain('nadir ground perspective looking straight down (-90° vertical pitch)');
                expect(prompt).toContain('Strictly zero tripod legs, zero camera rigs, zero equipment shadows');
            }
        }
    });

    it('synthesizes 5 perspective views using Nano Banana 2 mock conditioning with seamless boundary welding', async () => {
        const res = 32;
        const frontRgba = Buffer.alloc(res * res * 4);
        for (let y = 0; y < res; y++) {
            for (let x = 0; x < res; x++) {
                const idx = (y * res + x) * 4;
                frontRgba[idx] = 120 + x * 2;
                frontRgba[idx + 1] = 140 + y * 2;
                frontRgba[idx + 2] = 200;
                frontRgba[idx + 3] = 255;
            }
        }

        const service = new MultiPerspectivePanoramaSynthesisService();
        const { perspectives, modelUsed } = await service.synthesizePerspectivesWithNanoBanana(
            frontRgba,
            res,
            {
                model: 'nano-banana-2',
                prompt: 'cyberpunk street corner with holographic displays',
                locationName: 'Neo Shibuya',
                mockExecution: true
            }
        );

        expect(modelUsed).toBe('gemini-3.1-flash-image mock: procedural copies, no model call');
        expect(perspectives.front.isSynthesized).toBe(false);
        expect(perspectives.right.isSynthesized).toBe(true);
        expect(perspectives.back.isSynthesized).toBe(true);
        expect(perspectives.left.isSynthesized).toBe(true);
        expect(perspectives.top.isSynthesized).toBe(true);
        expect(perspectives.bottom.isSynthesized).toBe(true);

        // Verify boundary welding on right face (left edge x=0 matches front right edge x=res-1)
        for (let y = 0; y < res; y++) {
            const frontRightIdx = (y * res + (res - 1)) * 4;
            const rightLeftIdx = (y * res + 0) * 4;
            expect(perspectives.right.rgba[rightLeftIdx]).toBe(perspectives.front.rgba[frontRightIdx]);
            expect(perspectives.right.rgba[rightLeftIdx + 1]).toBe(perspectives.front.rgba[frontRightIdx + 1]);
            expect(perspectives.right.rgba[rightLeftIdx + 2]).toBe(perspectives.front.rgba[frontRightIdx + 2]);
        }

        // Verify boundary welding on left face (right edge x=res-1 matches front left edge x=0)
        for (let y = 0; y < res; y++) {
            const frontLeftIdx = (y * res + 0) * 4;
            const leftRightIdx = (y * res + (res - 1)) * 4;
            expect(perspectives.left.rgba[leftRightIdx]).toBe(perspectives.front.rgba[frontLeftIdx]);
            expect(perspectives.left.rgba[leftRightIdx + 1]).toBe(perspectives.front.rgba[frontLeftIdx + 1]);
            expect(perspectives.left.rgba[leftRightIdx + 2]).toBe(perspectives.front.rgba[frontLeftIdx + 2]);
        }

        // Verify boundary welding on top face (bottom edge y=res-1 matches front top edge y=0)
        for (let x = 0; x < res; x++) {
            const frontTopIdx = x * 4;
            const topBottomIdx = ((res - 1) * res + x) * 4;
            expect(perspectives.top.rgba[topBottomIdx]).toBe(perspectives.front.rgba[frontTopIdx]);
            expect(perspectives.top.rgba[topBottomIdx + 1]).toBe(perspectives.front.rgba[frontTopIdx + 1]);
            expect(perspectives.top.rgba[topBottomIdx + 2]).toBe(perspectives.front.rgba[frontTopIdx + 2]);
        }

        // Verify boundary welding on bottom face (top edge y=0 matches front bottom edge y=res-1)
        for (let x = 0; x < res; x++) {
            const frontBottomIdx = ((res - 1) * res + x) * 4;
            const bottomTopIdx = x * 4;
            expect(perspectives.bottom.rgba[bottomTopIdx]).toBe(perspectives.front.rgba[frontBottomIdx]);
            expect(perspectives.bottom.rgba[bottomTopIdx + 1]).toBe(perspectives.front.rgba[frontBottomIdx + 1]);
            expect(perspectives.bottom.rgba[bottomTopIdx + 2]).toBe(perspectives.front.rgba[frontBottomIdx + 2]);
        }
    });

    it('runs end-to-end generate360Perspectives with Nano Banana 2 model option', async () => {
        const tmpDir = path.join(os.tmpdir(), `test_nb2_persp_${Date.now()}`);
        await fs.ensureDir(tmpDir);

        const imgW = 48, imgH = 48;
        const imgRgba = Buffer.alloc(imgW * imgH * 4, 150);
        const imgPng = encodePng(imgW, imgH, imgRgba);

        const service = new MultiPerspectivePanoramaSynthesisService();
        const result = await service.generate360Perspectives({
            inputImageBuffer: imgPng,
            faceResolution: 32,
            equirectangularWidth: 128,
            equirectangularHeight: 64,
            model: 'nano-banana-2',
            prompt: 'historical stone plaza in Florence',
            mockExecution: true,
            outputDir: tmpDir
        });

        expect(result.success).toBe(true);
        expect(result.modelUsed).toBe('gemini-3.1-flash-image mock: procedural copies, no model call');
        expect(result.summary).toContain('gemini-3.1-flash-image mock: procedural copies, no model call');
        expect(result.perspectivesSynthesized).toHaveLength(5);

        await fs.remove(tmpDir);
    });

    it('sends the API model id for a product name and builds every perspective from the model answer', async () => {
        const imgPng = encodePng(48, 36, Buffer.alloc(48 * 36 * 4, 200));
        const calls: string[] = [];
        const service = new MultiPerspectivePanoramaSynthesisService(fakeImageCredentials(calls, 'image', 90));
        const result = await service.generate360Perspectives({
            inputImageBuffer: imgPng,
            faceResolution: 16,
            equirectangularWidth: 64,
            equirectangularHeight: 32,
            model: 'nano-banana-2'
        });

        expect(calls).toEqual(Array(5).fill('gemini-3.1-flash-image'));
        expect(result.modelUsed).toBe('gemini-3.1-flash-image');
        // The model answered a flat level-90 image; away from the welded seam the back face is that answer, not a copy of the level-200 input.
        const back = result.perspectives.back.rgba;
        const center = (8 * 16 + 8) * 4;
        expect([back[center], back[center + 1], back[center + 2]]).toEqual([90, 90, 90]);
    });

    it('reports a failed or empty model answer instead of returning procedural copies', async () => {
        const imgPng = encodePng(48, 36, Buffer.alloc(48 * 36 * 4, 200));
        const options = { inputImageBuffer: imgPng, faceResolution: 16, equirectangularWidth: 64, equirectangularHeight: 32 };

        // A named model that is not served fails the run; no other model is asked in its place.
        const unservedCalls: string[] = [];
        const unserved = new MultiPerspectivePanoramaSynthesisService(fakeImageCredentials(unservedCalls));
        const failed = await unserved.generate360Perspectives({ ...options, model: 'unserved-image-model' }).catch((e: Error) => e);
        expect(failed).toBeInstanceOf(MediaModelUnavailableError);
        expect((failed as Error).message).toContain('unserved-image-model (not served:');
        expect(unservedCalls).toEqual(['unserved-image-model']);

        // A model answering with no image, after the retries, is an error, not procedural copies.
        const emptyCalls: string[] = [];
        const empty = new MultiPerspectivePanoramaSynthesisService(fakeImageCredentials(emptyCalls, 'empty'));
        await expect(empty.generate360Perspectives(options))
            .rejects.toThrow(/returned no image \(STOP\).*right perspective/);
        expect(emptyCalls.filter(m => m === 'gemini-3.1-flash-image').length).toBe(3);

        // Any other model error ends the run.
        const broken = new MultiPerspectivePanoramaSynthesisService({ createClient: async () => ({ models: { generateContent: async () => { throw Object.assign(new Error('quota exceeded'), { status: 429 }); } } }) } as any);
        await expect(broken.generate360Perspectives(options)).rejects.toThrow(/gemini-3.1-flash-image is unavailable: quota exceeded \(on the right perspective\)/);

        const unconfigured = new MultiPerspectivePanoramaSynthesisService({
            createClient: async () => { throw new Error('Google media credentials are not configured'); }
        } as any);
        await expect(unconfigured.generate360Perspectives(options))
            .rejects.toThrow(/Google media credentials are not available \(Google media credentials are not configured\)/);
    });

    it('with no model named, walks the default list past an unserved model, asks again after an empty answer, and says which model answered', async () => {
        const png = encodePng(24, 24, Buffer.alloc(24 * 24 * 4, 90));
        const calls: string[] = [];
        let emptiesLeft = 1; // the first answer has no image part (finish STOP), as image models sometimes do
        const credentials: any = {
            createClient: async () => ({
                models: {
                    generateContent: async ({ model }: { model: string }) => {
                        calls.push(model);
                        if (model === 'gemini-3.1-flash-image') throw Object.assign(new Error(`models/${model} is not found`), { status: 404 });
                        if (emptiesLeft-- > 0) return { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] };
                        return { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
                    }
                }
            })
        };
        const service = new MultiPerspectivePanoramaSynthesisService(credentials);
        const result = await service.generate360Perspectives({
            inputImageBuffer: encodePng(48, 36, Buffer.alloc(48 * 36 * 4, 200)),
            faceResolution: 16, equirectangularWidth: 64, equirectangularHeight: 32
        });
        expect(result.success).toBe(true);
        // right: gemini-3.1-flash-image 404s once, gemini-3-pro-image answers empty and is asked again; the other four views go straight to it
        expect(calls).toEqual(['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-3-pro-image', ...Array(4).fill('gemini-3-pro-image')]);
        expect(result.modelUsed).toBe('gemini-3-pro-image');
        expect(result.skippedModels?.map(s => s.model)).toEqual(['gemini-3.1-flash-image']);
        expect(result.summary).toContain('Generated with gemini-3-pro-image, not the requested gemini-3.1-flash-image');
    });
});
