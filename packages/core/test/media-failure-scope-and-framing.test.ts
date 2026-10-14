/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Model failures are reported as model failures and nothing else is: a bug or a local write failure keeps its own
 * error. Panorama edits are sent at an aspect ratio the image models accept and refused when the answer would not
 * line up. A 360 rig never stitches a view that was not generated. Every client here is a fake: no model is called.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleMediaGenerationService, generateImageWithModels, withMediaFailureContext } from '../src/node/google-media-generation-service';
import { MediaGenerationJobService } from '../src/node/media-generation-job-service';
import { MediaAssetStore } from '../src/node/media-asset-store';
import { MediaModelUnavailableError, MissingInputError } from '../src/common/errors/pipeline-errors';
import { Google360PanoramaPipelineService } from '../src/node/spatial/Google360PanoramaPipelineService';
import { MultiPerspectivePanoramaSynthesisService } from '../src/node/spatial/MultiPerspectivePanoramaSynthesisService';
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
import { decodePng, encodePng } from '../src/node/texture-processing';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-media-scope-'));
afterAll(() => fs.removeSync(WORK));

const notServed = (model: string) => Object.assign(new Error(`models/${model} is not found`), { status: 404 });
const quota = () => Object.assign(new Error('Resource exhausted'), { status: 429 });

function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
    }
    return encodePng(w, h, rgba);
}

/** A panorama whose every column has a distinct red value, so wrapped columns can be recognised. */
function columnCodedPanorama(w: number, h: number): Buffer {
    const rgba = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            rgba[i] = x % 256; rgba[i + 1] = Math.floor(x / 256) * 40; rgba[i + 2] = 60; rgba[i + 3] = 255;
        }
    }
    return encodePng(w, h, rgba);
}

/** An image client that records each request and answers with a solid image of the given size. */
function recordingImageClient(answerSize: [number, number], requests: any[] = []) {
    return {
        requests,
        client: {
            models: {
                generateContent: async (req: any) => {
                    requests.push(req);
                    const png = solidPng(answerSize[0], answerSize[1], [240, 20, 20]);
                    return { candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
                }
            }
        }
    };
}

const credentialsFor = (client: unknown) => ({ createClient: async () => client }) as any;

describe('Only model failures are reported as a model being unavailable', () => {
    it('a local write failure after a video model answered propagates as itself, and no other model is tried', async () => {
        const asked: string[] = [];
        const client = {
            models: {
                generateVideos: async ({ model }: { model: string }) => { asked.push(model); return { name: `operations/${model}`, done: true, response: { generatedVideos: [{ video: { videoBytes: Buffer.from('mp4').toString('base64'), mimeType: 'video/mp4' } }] } }; }
            },
            operations: { getVideosOperation: async ({ operation }: any) => operation }
        };
        class FullDiskStore extends MediaAssetStore {
            async put(): Promise<any> { throw new Error('ENOSPC: no space left on device'); }
        }
        const service = new GoogleMediaGenerationService(new FullDiskStore(), async () => client as any, { pollIntervalMs: 0 });
        const failure = await service.generateVideo({
            kind: 'video', prompt: 'a tide pool', workspaceRoot: WORK, idempotencyKey: 'disk-full',
            modelPriority: ['veo-a', 'veo-b']
        }).catch(e => e);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(MediaModelUnavailableError);
        expect(failure.message).toContain('ENOSPC');
        expect(asked).toEqual(['veo-a']);
    });

    it('a failed job keeps the models skipped before the failing one in its error', async () => {
        const client = {
            models: {
                generateContent: async ({ model }: { model: string }) => {
                    if (model === 'model-a') throw notServed(model);
                    throw quota();
                }
            }
        };
        const jobs = new MediaGenerationJobService(new GoogleMediaGenerationService(new MediaAssetStore(), async () => client as any));
        const job = await jobs.create({ kind: 'image', prompt: 'a lantern', workspaceRoot: WORK, idempotencyKey: 'skip-detail', modelPriority: ['model-a', 'model-b'] });
        const done = await jobs.process(job.id, WORK);
        expect(done.status).toBe('failed');
        expect(done.error?.code).toBe('quota');
        expect(done.error?.message).toContain('Resource exhausted');
        expect(done.error?.message).toContain('after skipping model-a');
    });

    it('withMediaFailureContext adds where a model failed and leaves any other error untouched', async () => {
        const bug = new TypeError("Cannot read properties of undefined (reading 'toString')");
        expect(withMediaFailureContext(bug, 'station front')).toBe(bug);

        const modelFailure = await generateImageWithModels({ models: { generateContent: async () => { throw quota(); } } }, { models: ['model-x'], contents: [] }).catch(e => e);
        const annotated = withMediaFailureContext(modelFailure, 'station front') as any;
        expect(annotated).toBeInstanceOf(MediaModelUnavailableError);
        expect(annotated.message).toContain('(station front)');
        expect(annotated.mediaError.code).toBe('quota');
        expect(annotated.mediaError.message).toContain('(station front)');
    });

    it('a turnaround whose model is over quota fails with the station named and the classified error kept', async () => {
        const service = new MultiAngleTurnaroundService({ createClient: async () => ({ models: { generateContent: async () => { throw quota(); } } }) });
        const failure: any = await service.execute({ subject: 'a brass sextant', rigPreset: 'dcc-ortho-4', outputDir: path.join(WORK, 'turnaround') }).catch(e => e);
        expect(failure).toBeInstanceOf(MediaModelUnavailableError);
        expect(failure.message).toMatch(/\(station \w+\)/);
        expect(failure.mediaError?.code).toBe('quota');
    });
});

describe('A 360 rig stitches only views that were generated', () => {
    it('refuses a subset of the surrounding views before calling any model', async () => {
        const calls: any[] = [];
        const fake = recordingImageClient([64, 64], calls);
        const service = new MultiPerspectivePanoramaSynthesisService(credentialsFor(fake.client));
        const failure = await service.generate360Perspectives({
            inputImageBuffer: solidPng(64, 64, [90, 120, 150]),
            faceResolution: 64, equirectangularWidth: 128, equirectangularHeight: 64,
            synthesizePerspectives: ['right', 'left']
        }).catch(e => e);
        expect(failure).toBeInstanceOf(MissingInputError);
        expect(failure.message).toContain('back, top, bottom');
        expect(calls).toHaveLength(0);
    });

    it('returns only the input view and the views it generated, never procedural stand-ins for the rest', async () => {
        const calls: any[] = [];
        const fake = recordingImageClient([64, 64], calls);
        const service = new MultiPerspectivePanoramaSynthesisService(credentialsFor(fake.client));
        const outcome = await service.synthesizePerspectivesWithNanoBanana(Buffer.alloc(64 * 64 * 4, 128), 64, { perspectivesToGenerate: ['right'] });
        expect(Object.keys(outcome.perspectives).sort()).toEqual(['front', 'right']);
        expect(outcome.perspectives.right?.generatedBy).toBe('gemini-3.1-flash-image');
        expect(calls).toHaveLength(1);
    });

    it('says no view was synthesized when all six come out of an input panorama', async () => {
        const service = new MultiPerspectivePanoramaSynthesisService(credentialsFor({}));
        const result = await service.generate360Perspectives({
            inputImageBuffer: columnCodedPanorama(128, 64), faceResolution: 32, equirectangularWidth: 128, equirectangularHeight: 64
        });
        expect(result.perspectivesSynthesized).toEqual([]);
    });
});

describe('Panorama edits are sent at a ratio the model accepts and checked before blending', () => {
    it('a 2:1 seam heal goes out on a 21:9 canvas that repeats the panorama\'s left edge, with a matching mask', async () => {
        const fake = recordingImageClient([84, 36]); // the 21:9 answer size, scaled down
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const result = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(256, 128), seamWidth: 32 });

        expect(fake.requests).toHaveLength(1);
        const req = fake.requests[0];
        expect(req.config.imageConfig).toEqual({ aspectRatio: '21:9' });
        const sent = decodePng(Buffer.from(req.contents[1].inlineData.data, 'base64'));
        const mask = decodePng(Buffer.from(req.contents[2].inlineData.data, 'base64'));
        expect(sent.width).toBe(Math.round(128 * 21 / 9));
        expect(sent.height).toBe(128);
        expect([mask.width, mask.height]).toEqual([sent.width, sent.height]);
        // Column 256 of the widened canvas is column 0 of the (rolled) panorama again.
        const at = (img: { rgba: Buffer; width: number }, x: number, y: number) => img.rgba[(y * img.width + x) * 4];
        expect(at(sent, 256, 10)).toBe(at(sent, 0, 10));
        expect(at(sent, sent.width - 1, 10)).toBe(at(sent, sent.width - 1 - 256, 10));
        expect(req.contents[0].text).toContain('21:9');

        expect(result.modelImage).toEqual({ requestedAspectRatio: '21:9', width: 84, height: 36 });
        expect(result.summary).toContain('The model answered at 84x36 for a 21:9 request.');
        expect(decodePng(result.outputBuffer).width).toBe(256);
    });

    it('refuses an answer at another aspect ratio instead of stretching it onto the panorama', async () => {
        const fake = recordingImageClient([64, 64]);
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const outputImagePath = path.join(WORK, 'refused_heal.png');
        const failure = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(256, 128), outputImagePath }).catch(e => e);
        expect(failure).toBeInstanceOf(MediaModelUnavailableError);
        expect(failure.message).toContain('asked for a 21:9 image, the model answered 64x64');
        expect(failure.message).toContain('would not line up');
        expect(fs.existsSync(outputImagePath)).toBe(false);

        const inpaint = await service.inpaintPanorama({ inputImageBuffer: columnCodedPanorama(256, 128), nadirOnly: true }).catch(e => e);
        expect(inpaint).toBeInstanceOf(MediaModelUnavailableError);
        const generated = await service.generate360Panorama({ prompt: 'salt flats', width: 256, height: 128, healSeam: false }).catch(e => e);
        expect(generated).toBeInstanceOf(MediaModelUnavailableError);
    });

    it('rejects a custom mask of another size and a panorama wider than any accepted ratio', async () => {
        const fake = recordingImageClient([84, 36]);
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const failure = await service.inpaintPanorama({ inputImageBuffer: columnCodedPanorama(256, 128), maskImageBuffer: solidPng(128, 128, [255, 255, 255]) }).catch(e => e);
        expect(failure).toBeInstanceOf(MissingInputError);
        expect(failure.message).toContain('the mask is 128x128, the panorama 256x128');
        expect(fake.requests).toHaveLength(0);

        expect(() => Google360PanoramaPipelineService.panoramaEditCanvas(1000, 100)).toThrow(MissingInputError);
        expect(Google360PanoramaPipelineService.panoramaEditCanvas(1024, 1024)).toEqual({ aspectRatio: '1:1', canvasWidth: 1024 });
        expect(Google360PanoramaPipelineService.panoramaEditCanvas(1600, 900)).toEqual({ aspectRatio: '16:9', canvasWidth: 1600 });
    });
});
