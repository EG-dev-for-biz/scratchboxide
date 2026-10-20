/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * generate_image: the in-app agent's picture tool. No test reaches a model: the Google Gen AI client is a fake
 * injected at the SDK boundary (GoogleMediaCredentialsService.createClient), recording the requests it gets and
 * answering fixed PNG bytes. The tests check the request the model would receive, the files written (real PNG
 * bytes), the paths and URLs returned, the visible model fallback, and that nothing is written on failure.
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleMediaCredentialsService } from '../src/node/google-media-credentials-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { ALL_TOOL_PACKS } from '../src/node/gemini/domain-tool-packs';
import {
    FAST_IMAGE_MODEL,
    GENERATED_IMAGES_DIR,
    GENERATED_IMAGES_ROUTE,
    GENERATE_IMAGE_MAX_COUNT,
    IMAGE_GENERATION_TOOL_DECLARATIONS,
    imageGenerationHandlers,
    servedGeneratedImageUrl
} from '../src/node/gemini/tools/nano-banana-tools';
import { IMAGE_MODEL_PRIORITY } from '../src/common/media-generation-protocol';
import { encodePng } from '../src/node/texture-processing';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A fake SDK client: records every generateContent request and answers `answer(request)`. */
function fakeClient(answer: (req: any) => any, vertexai = false): { client: any; requests: any[] } {
    const requests: any[] = [];
    const client = {
        vertexai,
        models: {
            generateContent: async (req: any) => {
                requests.push(req);
                return answer(req);
            }
        }
    };
    return { client, requests };
}

function imageAnswer(png: Buffer, modelVersion?: string) {
    return {
        ...(modelVersion ? { modelVersion } : {}),
        candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }]
    };
}

function notServed(model: string): Error {
    return Object.assign(new Error(`models/${model} is not found for API version v1beta`), { status: 404 });
}

describe('generate_image', () => {
    const modelPng = encodePng(16, 9, Buffer.alloc(16 * 9 * 4, 120));
    let tmpDir: string;
    let outDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'generate_image_'));
        outDir = path.join(tmpDir, 'out');
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.remove(tmpDir);
    });

    function install(fake: { client: any }): void {
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockResolvedValue(fake.client);
    }

    it('is registered, offered in the core workspace pack, and declares its parameters', () => {
        const registry = createDefaultToolRegistry();
        expect(registry.has('generate_image')).toBe(true);
        expect(typeof registry.get('generate_image')?.handler).toBe('function');
        expect(ALL_TOOL_PACKS.core_workspace.toolNames).toContain('generate_image');
        expect(ALL_TOOL_PACKS.core_workspace.declarations.some(d => d.name === 'generate_image')).toBe(true);
        const decl = IMAGE_GENERATION_TOOL_DECLARATIONS.find(d => d.name === 'generate_image')!;
        expect(decl.parameters?.required).toEqual(['prompt']);
        expect(Object.keys(decl.parameters?.properties || {}).sort()).toEqual(
            ['aspectRatio', 'count', 'fast', 'model', 'name', 'outputDir', 'prompt', 'referenceImages'].sort()
        );
    });

    it('sends the prompt, aspect ratio and reference images to the default model and writes real PNG files it serves by URL', async () => {
        const fake = fakeClient(() => imageAnswer(modelPng, 'gemini-3.1-flash-image-2026-09'));
        install(fake);
        const referencePath = path.join(tmpDir, 'ref.png');
        await fs.writeFile(referencePath, encodePng(4, 4, Buffer.alloc(4 * 4 * 4, 10)));

        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch('generate_image', {
            prompt: 'A cinematic film still of a lighthouse keeper at dawn on a wet granite jetty.',
            aspectRatio: '21:9',
            referenceImages: ['ref.png'],
            name: 'storyboard_frame_01_opening',
            count: 2,
            outputDir: outDir
        }, { workspaceRoot: tmpDir } as any);

        expect(outcome.exec.status, JSON.stringify(outcome.resultPayload)).toBe('completed');
        const payload = outcome.resultPayload as any;

        // One billed call per image, each carrying the prompt, the reference bytes and the aspect ratio.
        expect(fake.requests).toHaveLength(2);
        for (const req of fake.requests) {
            expect(req.model).toBe(IMAGE_MODEL_PRIORITY[0]);
            expect(req.contents[0]).toEqual({ text: 'A cinematic film still of a lighthouse keeper at dawn on a wet granite jetty.' });
            expect(req.contents[1].inlineData.mimeType).toBe('image/png');
            expect(Buffer.from(req.contents[1].inlineData.data, 'base64').subarray(0, 8)).toEqual(PNG_MAGIC);
            expect(req.config.imageConfig).toEqual({ aspectRatio: '21:9' });
            expect(req.config.responseModalities).toContain('IMAGE');
        }

        // Real files with the model's bytes, named from the caller's stem with an index.
        expect(payload.images).toHaveLength(2);
        expect(payload.count).toBe(2);
        for (const [i, image] of payload.images.entries()) {
            expect(image.index).toBe(i + 1);
            expect(path.dirname(image.path)).toBe(outDir);
            expect(path.basename(image.path)).toMatch(new RegExp(`^storyboard_frame_01_opening_\\d+_${i + 1}\\.png$`));
            const bytes = await fs.readFile(image.path);
            expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
            expect(bytes.equals(modelPng)).toBe(true);
            expect(image.width).toBe(16);
            expect(image.height).toBe(9);
            expect(image.byteLength).toBe(modelPng.length);
            expect(image.modelUsed).toBe(IMAGE_MODEL_PRIORITY[0]);
            expect(image.modelVersion).toBe('gemini-3.1-flash-image-2026-09');
            expect(image.skippedModels).toEqual([]);
            // A folder the app does not serve has no URL: the result says so rather than inventing one.
            expect(image.url).toBeUndefined();
        }
        expect(payload.provenance).toBe('generated');
        expect(payload.credential).toBe('api-key');
        expect(payload.modelUsed).toBe(IMAGE_MODEL_PRIORITY[0]);
        expect(payload.modelNote).toBe(`Generated with ${IMAGE_MODEL_PRIORITY[0]}.`);
        expect(payload.aspectRatio).toBe('21:9');
        expect(payload.referenceImages).toEqual(['ref.png']);
        expect(payload.markdown).toBe('');
        expect(outcome.exec.summaryResult).toContain(`with ${IMAGE_MODEL_PRIORITY[0]} via api-key`);
        expect(outcome.exec.summaryResult).toContain(`outside ${GENERATED_IMAGES_DIR}`);
    });

    it('writes to the served generated-images folder by default and returns the URL the app serves it at', async () => {
        const fake = fakeClient(() => imageAnswer(modelPng));
        install(fake);
        const outcome = await imageGenerationHandlers.generate_image({ prompt: 'A red kite over a chalk down', aspectRatio: '4:3' }, { workspaceRoot: tmpDir } as any);
        const payload = outcome.resultPayload as any;
        const image = payload.images[0];
        try {
            expect(fs.existsSync(image.path)).toBe(true);
            expect((await fs.readFile(image.path)).subarray(0, 8)).toEqual(PNG_MAGIC);
            expect(path.dirname(image.path).replace(/\\/g, '/').endsWith(GENERATED_IMAGES_DIR)).toBe(true);
            expect(path.basename(image.path)).toMatch(/^a_red_kite_over_a_chalk_\d+\.png$/);
            expect(image.url).toBe(`${GENERATED_IMAGES_ROUTE}${path.basename(image.path)}`);
            expect(payload.markdown).toBe(`![A red kite over a chalk down](${image.url})`);
            expect(fake.requests[0].config.imageConfig).toEqual({ aspectRatio: '4:3' });
        } finally {
            await fs.remove(image.path);
        }
    });

    it('maps only files inside the generated-images folder to URLs', () => {
        const root = path.join(tmpDir, 'repo');
        expect(servedGeneratedImageUrl(path.join(root, GENERATED_IMAGES_DIR, 'a b.png'), root)).toBe(`${GENERATED_IMAGES_ROUTE}a%20b.png`);
        expect(servedGeneratedImageUrl(path.join(root, GENERATED_IMAGES_DIR, 'session', 'frame_1.png'), root)).toBe(`${GENERATED_IMAGES_ROUTE}session/frame_1.png`);
        expect(servedGeneratedImageUrl(path.join(root, 'build', 'elsewhere.png'), root)).toBeUndefined();
        expect(servedGeneratedImageUrl(path.join(root, GENERATED_IMAGES_DIR, '..', 'escape.png'), root)).toBeUndefined();
    });

    it('asks the given model only, and Nano Banana Lite first when fast is set', async () => {
        const fake = fakeClient(() => imageAnswer(modelPng));
        install(fake);
        const named = await imageGenerationHandlers.generate_image({ prompt: 'x', model: 'nano-banana-pro', outputDir: outDir }, {} as any);
        expect((named.resultPayload as any).requestedModels).toEqual(['gemini-3-pro-image']);
        expect(fake.requests.at(-1).model).toBe('gemini-3-pro-image');

        const fast = await imageGenerationHandlers.generate_image({ prompt: 'x', fast: true, outputDir: outDir }, {} as any);
        expect((fast.resultPayload as any).requestedModels).toEqual([FAST_IMAGE_MODEL, ...IMAGE_MODEL_PRIORITY]);
        expect(fake.requests.at(-1).model).toBe('gemini-3.1-flash-lite-image');
        expect((fast.resultPayload as any).modelUsed).toBe('gemini-3.1-flash-lite-image');
    });

    it('reports a visible fallback: the model that answered and why the first one was skipped', async () => {
        const fake = fakeClient(req => {
            if (req.model === IMAGE_MODEL_PRIORITY[0]) throw notServed(req.model);
            return imageAnswer(modelPng);
        }, true);
        install(fake);
        const outcome = await imageGenerationHandlers.generate_image({ prompt: 'A steel footbridge in fog', outputDir: outDir }, {} as any);
        const payload = outcome.resultPayload as any;
        expect(payload.credential).toBe('vertex-ai');
        expect(payload.modelUsed).toBe(IMAGE_MODEL_PRIORITY[1]);
        expect(payload.skippedModels).toHaveLength(1);
        expect(payload.skippedModels[0].model).toBe(IMAGE_MODEL_PRIORITY[0]);
        expect(payload.skippedModels[0].code).toBe('unsupported');
        expect(payload.modelNote).toContain(`Generated with ${IMAGE_MODEL_PRIORITY[1]}, not the requested ${IMAGE_MODEL_PRIORITY[0]}`);
        expect(outcome.summaryResult).toContain(payload.modelNote);
        expect((await fs.readFile(payload.images[0].path)).equals(modelPng)).toBe(true);
    });

    it('fails with a typed error, writing nothing, when no credential or no model is available', async () => {
        vi.spyOn(GoogleMediaCredentialsService.prototype, 'createClient').mockRejectedValue(new Error('no credentials configured'));
        const registry = createDefaultToolRegistry();
        const noCredential = await registry.dispatch('generate_image', { prompt: 'x', outputDir: outDir }, {} as any);
        expect(noCredential.exec.status).toBe('failed');
        expect(noCredential.resultPayload.error).toContain('Google media credentials are not available (no credentials configured)');
        expect(noCredential.resultPayload.error).toContain(`Media model ${IMAGE_MODEL_PRIORITY[0]} is unavailable`);
        expect(fs.existsSync(outDir)).toBe(false);

        vi.restoreAllMocks();
        const fake = fakeClient(req => { throw notServed(req.model); });
        install(fake);
        const noModel = await imageGenerationHandlers.generate_image({ prompt: 'x', outputDir: outDir }, {} as any).catch(e => e);
        expect(noModel).toBeInstanceOf(Error);
        expect(noModel.name).toBe('MediaModelUnavailableError');
        for (const model of IMAGE_MODEL_PRIORITY) expect(noModel.message).toContain(model);
        expect(await fs.readdir(outDir)).toEqual([]);

        const quota = fakeClient(() => { throw Object.assign(new Error('Resource exhausted'), { status: 429 }); });
        vi.restoreAllMocks();
        install(quota);
        const exhausted = await imageGenerationHandlers.generate_image({ prompt: 'x', outputDir: outDir }, {} as any).catch(e => e);
        expect(exhausted.name).toBe('MediaModelUnavailableError');
        expect(quota.requests).toHaveLength(1);
        expect(await fs.readdir(outDir)).toEqual([]);
    });

    it('refuses a missing prompt, an aspect ratio the models reject, a bad count and an unreadable reference', async () => {
        const fake = fakeClient(() => imageAnswer(modelPng));
        install(fake);
        const run = (args: Record<string, unknown>) => imageGenerationHandlers.generate_image({ outputDir: outDir, ...args }, { workspaceRoot: tmpDir } as any).catch(e => e);

        const noPrompt = await run({});
        expect(noPrompt.name).toBe('MissingInputError');
        expect(noPrompt.message).toContain('generate_image needs prompt');

        const badRatio = await run({ prompt: 'x', aspectRatio: '640:480' });
        expect(badRatio.name).toBe('InvalidInputError');
        expect(badRatio.message).toContain('640:480');
        expect(badRatio.message).toContain('16:9');

        const tooMany = await run({ prompt: 'x', count: GENERATE_IMAGE_MAX_COUNT + 1 });
        expect(tooMany.name).toBe('InvalidInputError');
        expect(tooMany.message).toContain(`1 to ${GENERATE_IMAGE_MAX_COUNT}`);
        const fraction = await run({ prompt: 'x', count: 1.5 });
        expect(fraction.name).toBe('InvalidInputError');

        const noReference = await run({ prompt: 'x', referenceImages: ['absent.png'] });
        expect(noReference.name).toBe('MissingInputError');
        expect(noReference.message).toContain('referenceImages');
        expect(noReference.message).toContain(path.join(tmpDir, 'absent.png'));

        expect(fake.requests).toHaveLength(0);
        expect(fs.existsSync(outDir)).toBe(false);
    });
});
