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
import { Google360PanoramaPipelineService, ModelAnswerResolutionError, expectedModelAnswerSize, imageSizeForCanvas } from '../src/node/spatial/Google360PanoramaPipelineService';
import { FalTrellisService } from '../src/node/spatial/FalTrellisService';
import { PanoramaDepthService } from '../src/node/spatial/PanoramaDepthService';
import { panoramaHandlers } from '../src/node/gemini/tools/spatial-tools';
import { MultiPerspectivePanoramaSynthesisService } from '../src/node/spatial/MultiPerspectivePanoramaSynthesisService';
import { MultiAngleTurnaroundService } from '../src/node/spatial/MultiAngleTurnaroundService';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { resolveToolTimeBudget } from '../src/node/gemini/tool-time-budgets';

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

/**
 * An image client that records each request and answers with a solid image of the given size, or (a function) of
 * the size it computes from the request, e.g. the size a model answers at for the imageSize asked for.
 */
function recordingImageClient(answerSize: [number, number] | ((req: any) => [number, number]), requests: any[] = []) {
    return {
        requests,
        client: {
            models: {
                generateContent: async (req: any) => {
                    requests.push(req);
                    const [w, h] = typeof answerSize === 'function' ? answerSize(req) : answerSize;
                    const png = solidPng(w, h, [240, 20, 20]);
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
        expect(failure.message).toBe('ENOSPC: no space left on device');
        expect(failure.mediaError).toBeUndefined(); // not classified as a model error (it would be 'transient')
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

describe('A stopped request asks no further model', () => {
    it('generateImageWithModels with a stopped signal calls no model and is not reported as a model failure', async () => {
        const asked: string[] = [];
        const client = { models: { generateContent: async ({ model }: { model: string }) => { asked.push(model); throw notServed(model); } } };
        const controller = new AbortController();
        controller.abort();
        const stopped = await generateImageWithModels(client, { models: ['a', 'b'], contents: [], signal: controller.signal }).catch(e => e);
        expect(stopped.name).toBe('AbortError');
        expect(stopped).not.toBeInstanceOf(MediaModelUnavailableError);
        expect(asked).toEqual([]);

        // Stopped while the first model is answering: the next model in the list is not asked.
        const during = new AbortController();
        const midAsked: string[] = [];
        const midClient = { models: { generateContent: async (req: any) => {
            midAsked.push(req.model);
            expect(req.config.abortSignal).toBe(during.signal);
            during.abort();
            throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        } } };
        const midStop = await generateImageWithModels(midClient, { models: ['a', 'b'], contents: [], signal: during.signal }).catch(e => e);
        expect(midStop.name).toBe('AbortError');
        expect(midStop).not.toBeInstanceOf(MediaModelUnavailableError);
        expect(midAsked).toEqual(['a']);
    });

    it('a stopped turnaround captures no further station and never reaches Trellis', async () => {
        const fake = recordingImageClient([64, 64]);
        const controller = new AbortController();
        let trellisCalls = 0;
        const service = new MultiAngleTurnaroundService({
            createClient: async () => fake.client,
            trellis: { generate3DFromImages: async () => { trellisCalls++; throw new Error('not reached'); } }
        });
        const outputDir = path.join(WORK, 'stopped-turnaround');
        const progress: string[] = [];
        const stopped = await service.execute({
            subject: 'a brass sextant', rigPreset: 'dcc-ortho-4', outputDir, downstreamTarget: 'trellis-fal', signal: controller.signal,
            onProgress: (_f, message) => { progress.push(message); controller.abort(); }
        }).catch(e => e);
        expect(stopped.name).toBe('AbortError');
        expect(fake.requests).toHaveLength(1);
        expect(progress).toHaveLength(1);
        expect(fs.readdirSync(outputDir)).toHaveLength(1);
        expect(trellisCalls).toBe(0);
    });

    it('the turnaround tool has a time budget for its serial model calls', () => {
        expect(resolveToolTimeBudget('generate_multi_angle_turnaround', {}, 5 * 60_000)).toEqual({ maxMs: 30 * 60_000, idleMs: 10 * 60_000 });
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
        const fake = recordingImageClient([224, 96]); // a 21:9 answer, 1.33x smaller than the 299x128 canvas
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const result = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(256, 128), seamWidth: 32 });

        expect(fake.requests).toHaveLength(1);
        const req = fake.requests[0];
        expect(req.config.imageConfig).toEqual({ aspectRatio: '21:9', imageSize: '1K' });
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

        expect(result.modelImage).toEqual({ requestedAspectRatio: '21:9', requestedImageSize: '1K', width: 224, height: 96, resampledWidth: 299, resampledHeight: 128 });
        expect(result.summary).toContain('The model answered at 224x96 for a 21:9, imageSize 1K request; it was resampled to 299x128 (1.33x larger).');
        expect(decodePng(result.outputBuffer).width).toBe(256);
    });

    it('refuses an answer that would have to be enlarged more than maxModelUpscale, and says how far it was enlarged when allowed', async () => {
        // Answers at the asked ratio but only 36 px tall: 7.11x smaller than a 256-px-tall canvas.
        const RATIO: Record<string, number> = { '3:4': 3 / 4, '21:9': 21 / 9 };
        const small = recordingImageClient(req => [Math.round(36 * RATIO[req.config.imageConfig.aspectRatio]), 36]);
        const service = new Google360PanoramaPipelineService(credentialsFor(small.client));
        const outputImagePath = path.join(WORK, 'soft_heal.png');
        const refused = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(512, 256), outputImagePath }).catch(e => e);
        // The model answered smaller than the size asked for: refused, and not reported as an unavailable model.
        // (The seam band is sent as a 3:4 region around it, 192x256, not as the whole frame.)
        expect(refused).toBeInstanceOf(ModelAnswerResolutionError);
        expect(refused).not.toBeInstanceOf(MediaModelUnavailableError);
        expect(refused.beforeCall).toBe(false);
        expect(refused.message).toContain('answered at 27x36 for an imageSize 1K request, which would have to be enlarged 7.11x to the 192x256 canvas (more than the allowed 2x');
        expect(fs.existsSync(outputImagePath)).toBe(false);
        // The nadir band spans the whole width, so it is sent whole (widened to 21:9).
        const inpaintRefused = await service.inpaintPanorama({ inputImageBuffer: columnCodedPanorama(512, 256), nadirOnly: true }).catch(e => e);
        expect(inpaintRefused.message).toContain('answered at 84x36 for an imageSize 1K request, which would have to be enlarged 7.11x to the 597x256 canvas');

        const allowed = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(512, 256), maxModelUpscale: 8 });
        expect(allowed.summary).toContain('resampled to 192x256 (7.11x larger)');
        await expect(service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(512, 256), maxModelUpscale: 0.5 })).rejects.toThrow(MissingInputError);
    });

    it('a generated panorama keeps the centre 2:1 of the model\'s 21:9 answer instead of squeezing it, and says so', async () => {
        const fake = recordingImageClient([420, 180]);
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const result = await service.generate360Panorama({ prompt: 'salt flats at dawn', width: 256, height: 128, healSeam: false });
        expect(fake.requests[0].config.imageConfig).toEqual({ aspectRatio: '21:9', imageSize: '1K' });
        expect(result.summary).toContain('The model answered at 420x180 for a 21:9, imageSize 1K request; it was resampled to 299x128 (1.40x smaller), and its centre 256 columns were kept (the answer is wider than the canvas; nothing was squeezed).');
        expect(result.summary).not.toContain('squeezed 14%');
    });

    it('refuses an answer at another aspect ratio instead of stretching it onto the panorama', async () => {
        const fake = recordingImageClient([64, 64]);
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const outputImagePath = path.join(WORK, 'refused_heal.png');
        const failure = await service.healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(256, 128), outputImagePath }).catch(e => e);
        expect(failure).toBeInstanceOf(ModelAnswerResolutionError);
        expect(failure.message).toContain('was asked for a 21:9 image and answered 64x64');
        expect(failure.message).toContain('would not line up');
        expect(fs.existsSync(outputImagePath)).toBe(false);

        const inpaint = await service.inpaintPanorama({ inputImageBuffer: columnCodedPanorama(256, 128), nadirOnly: true }).catch(e => e);
        expect(inpaint).toBeInstanceOf(ModelAnswerResolutionError);
        const generated = await service.generate360Panorama({ prompt: 'salt flats', width: 256, height: 128, healSeam: false }).catch(e => e);
        expect(generated).toBeInstanceOf(ModelAnswerResolutionError);
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

/** A PNG whose header says width x height (enough for the size checks, which read only the header). */
function pngHeaderOnly(width: number, height: number): Buffer {
    const buf = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    buf.writeUInt32BE(13, 8);
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    buf[24] = 8; buf[25] = 6;
    return buf;
}

describe('Panorama edits ask for an image size that covers the panorama, and refuse before calling when none can', () => {
    it('picks the smallest size tier whose answer covers the canvas within the allowed enlargement', () => {
        expect(imageSizeForCanvas(299, 128, '21:9', 2)?.imageSize).toBe('1K');
        // The review's probe: a 4096x2048 panorama is edited on a 4779x2048 canvas; 1K would need about 3x, 2K about 1.5x.
        expect(imageSizeForCanvas(4779, 2048, '21:9', 2)?.imageSize).toBe('2K');
        expect(imageSizeForCanvas(4779, 2048, '21:9', 1)?.imageSize).toBe('4K');
        expect(imageSizeForCanvas(19115, 8192, '21:9', 2)).toBeUndefined();
        expect(expectedModelAnswerSize('1K', '21:9').width).toBeLessThanOrEqual(1536);
    });

    it('a 4096x2048 nadir infill asks for imageSize 2K and succeeds at the size a model answers at', async () => {
        const fake = recordingImageClient(req => (req.config.imageConfig.imageSize === '2K' ? [3168, 1344] : [1584, 672]));
        const service = new Google360PanoramaPipelineService(credentialsFor(fake.client));
        const rgba = Buffer.alloc(4096 * 2048 * 4, 90);
        const result = await service.inpaintPanorama({ inputImageBuffer: encodePng(4096, 2048, rgba), nadirOnly: true });
        expect(fake.requests).toHaveLength(1);
        expect(fake.requests[0].config.imageConfig).toEqual({ aspectRatio: '21:9', imageSize: '2K' });
        expect(result.summary || result.modelNote).toBeDefined();
        expect(result.modelImage).toMatchObject({ requestedImageSize: '2K', width: 3168, height: 1344, resampledWidth: 4779, resampledHeight: 2048 });

        // A model that ignores the size asked for (answers at 1K) is refused after its answer, as a resolution problem.
        const ignoring = recordingImageClient([1584, 672]);
        const refused = await new Google360PanoramaPipelineService(credentialsFor(ignoring.client))
            .inpaintPanorama({ inputImageBuffer: encodePng(4096, 2048, rgba), nadirOnly: true }).catch(e => e);
        expect(refused).toBeInstanceOf(ModelAnswerResolutionError);
        expect(refused.beforeCall).toBe(false);
        expect(refused.message).toContain('for an imageSize 2K request');
    }, 60000);

    it('refuses a panorama too large for 4K at the allowed enlargement before any model call', async () => {
        const service = new Google360PanoramaPipelineService(credentialsFor(recordingImageClient([64, 64]).client));
        const failure = (() => { try { Google360PanoramaPipelineService.editImageSize(16384, 8192, 2); } catch (e) { return e as any; } })();
        expect(failure).toBeInstanceOf(ModelAnswerResolutionError);
        expect(failure.beforeCall).toBe(true);
        expect(failure.message).toContain('No model was called');
        expect(failure.message).toMatch(/Pass maxModelUpscale >= 3\.\d+/);
        expect(() => Google360PanoramaPipelineService.editImageSize(16384, 8192, 4)).not.toThrow();
        expect(service).toBeDefined();
    });

    it('panorama_to_3dgs refuses a panorama too large for the inpainting model before the depth run, and takes maxModelUpscale', async () => {
        const big = path.join(WORK, 'big_pano.png');
        fs.writeFileSync(big, pngHeaderOnly(16384, 8192));
        let depthRuns = 0;
        const original = PanoramaDepthService.prototype.generatePanoramaDepth;
        PanoramaDepthService.prototype.generatePanoramaDepth = async function () { depthRuns++; throw new Error('not reached'); } as any;
        try {
            const refused = await panoramaHandlers.panorama_to_3dgs({ inputImagePath: big }, { workspaceRoot: WORK } as any).catch(e => e);
            expect(refused).toBeInstanceOf(ModelAnswerResolutionError);
            expect(refused.beforeCall).toBe(true);
            expect(depthRuns).toBe(0);
            // With a larger allowed enlargement the check passes and the depth run starts.
            const next = await panoramaHandlers.panorama_to_3dgs({ inputImagePath: big, maxModelUpscale: 4 }, { workspaceRoot: WORK } as any).catch(e => e);
            expect(next.message).toBe('not reached');
            expect(depthRuns).toBe(1);
        } finally {
            PanoramaDepthService.prototype.generatePanoramaDepth = original;
        }
    });
});

describe('Stopped panorama, perspective and Trellis steps start no further model work', () => {
    it('a stopped seam heal and a stopped perspective rig call no model', async () => {
        const controller = new AbortController();
        controller.abort();
        const fake = recordingImageClient([224, 96]);
        const heal = await new Google360PanoramaPipelineService(credentialsFor(fake.client))
            .healPanoramaSeam({ inputImageBuffer: columnCodedPanorama(256, 128), signal: controller.signal }).catch(e => e);
        expect(heal.name).toBe('AbortError');
        expect(fake.requests).toHaveLength(0);

        // Stopped after the first view: the rest of the rig is not asked of the model.
        const during = new AbortController();
        const calls: any[] = [];
        const rigClient = { models: { generateContent: async (req: any) => {
            calls.push(req);
            during.abort();
            return { candidates: [{ content: { parts: [{ inlineData: { data: solidPng(64, 64, [1, 2, 3]).toString('base64'), mimeType: 'image/png' } }] } }] };
        } } };
        const rig = await new MultiPerspectivePanoramaSynthesisService(credentialsFor(rigClient))
            .synthesizePerspectivesWithNanoBanana(Buffer.alloc(64 * 64 * 4, 128), 64, { signal: during.signal }).catch(e => e);
        expect(rig.name).toBe('AbortError');
        expect(calls).toHaveLength(1);
    });

    it('a stopped Trellis run uploads nothing', async () => {
        const controller = new AbortController();
        controller.abort();
        const stopped = await new FalTrellisService({ falKey: 'test-key-not-used' }).generate3DFromImages({
            imageBuffers: [{ name: 'a.png', buffer: solidPng(8, 8, [1, 2, 3]) }], signal: controller.signal
        }).catch(e => e);
        expect(stopped.name).toBe('AbortError');
    });
});
