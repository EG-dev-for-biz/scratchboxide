import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { GoogleMediaGenerationService } from '../src/node/google-media-generation-service';
import { MediaAssetStore } from '../src/node/media-asset-store';
import { IMAGE_MODEL_PRIORITY, IMAGE_MODEL_PRIORITY_DRAFT } from '../src/common/media-generation-protocol';

// Image model ids the Gemini API and Vertex AI answer to; the fake clients 404 anything else, as both backends do.
const SERVED_IMAGE_MODEL_IDS = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];
const notFound = (model: string) => Object.assign(new Error(`models/${model} is not found`), { status: 404 });

async function runGoogleMediaGenerationServiceTests(): Promise<void> {
    console.log('🧪 Running Google media generation adapter tests...');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-google-media-'));
    const attemptedModels: string[] = [];
    const videoModels: string[] = [];
    let polled = false;

    const fakeClient: any = {
        models: {
            get: async ({ model }: { model: string }) => {
                if (!SERVED_IMAGE_MODEL_IDS.includes(model)) {
                    throw notFound(model);
                }
                return {
                    name: model,
                    supportedActions: ['generateContent', 'predictLongRunning']
                };
            },
            generateContent: async ({ model }: { model: string }) => {
                attemptedModels.push(model);
                if (!SERVED_IMAGE_MODEL_IDS.includes(model)) {
                    throw notFound(model);
                }
                return {
                    modelVersion: model,
                    candidates: [{
                        content: {
                            parts: [{
                                inlineData: {
                                    data: Buffer.from('generated png').toString('base64'),
                                    mimeType: 'image/png'
                                }
                            }]
                        }
                    }]
                };
            },
            generateVideos: async ({ model }: { model: string }) => {
                videoModels.push(model);
                return {
                    name: `operations/${model}`,
                    done: false
                };
            }
        },
        operations: {
            getVideosOperation: async ({ operation }: any) => {
                polled = true;
                return {
                    ...operation,
                    done: true,
                    response: {
                        generatedVideos: [{
                            video: {
                                videoBytes: Buffer.from('generated mp4').toString('base64'),
                                mimeType: 'video/mp4'
                            }
                        }]
                    }
                };
            }
        },
        files: {
            download: async () => {
                throw new Error('download should not be used when videoBytes are present');
            }
        }
    };

    try {
        const service = new GoogleMediaGenerationService(
            new MediaAssetStore(),
            async () => fakeClient,
            { pollIntervalMs: 1, maxPollAttempts: 3 }
        );

        const capabilities = await service.detectCapabilities(['missing-image', 'gemini-3.1-flash-image']);
        assert.strictEqual(capabilities.models['missing-image'].available, false);
        assert.strictEqual(capabilities.models['gemini-3.1-flash-image'].available, true);

        const image = await service.generateImage({
            kind: 'image',
            prompt: 'Generate an image',
            workspaceRoot,
            idempotencyKey: 'image-test',
            modelPriority: ['missing-image', 'gemini-3.1-flash-image']
        });
        assert.strictEqual(image.modelUsed, 'gemini-3.1-flash-image');
        assert.deepStrictEqual(attemptedModels, ['missing-image', 'gemini-3.1-flash-image']);
        assert.ok(await fs.pathExists(path.join(workspaceRoot, image.asset.relativePath)));

        const video = await service.generateVideo({
            kind: 'video',
            prompt: 'Generate a video',
            workspaceRoot,
            idempotencyKey: 'video-test',
            modelPriority: ['veo-3.1-fast-generate-preview'],
            durationSeconds: 4
        });
        assert.strictEqual(video.modelUsed, 'veo-3.1-fast-generate-preview');
        assert.strictEqual(video.operationName, 'operations/veo-3.1-fast-generate-preview');
        assert.strictEqual(polled, true);
        assert.ok(await fs.pathExists(path.join(workspaceRoot, video.asset.relativePath)));

        // Default priority: the first image model is one the backends serve, so no call is spent on a 404
        attemptedModels.length = 0;
        const defaultImage = await service.generateImage({
            kind: 'image',
            prompt: 'Render sunset',
            workspaceRoot,
            idempotencyKey: 'default-image'
        });
        assert.strictEqual(defaultImage.modelUsed, 'gemini-3.1-flash-image');
        assert.deepStrictEqual(attemptedModels, ['gemini-3.1-flash-image'], 'the default image call goes straight to a served model');

        attemptedModels.length = 0;
        const draftImage = await service.generateImage({
            kind: 'image',
            prompt: 'Render sunset quickly',
            workspaceRoot,
            idempotencyKey: 'draft-image',
            fidelity: 'draft'
        });
        assert.strictEqual(draftImage.modelUsed, 'gemini-2.5-flash-image');
        assert.deepStrictEqual(attemptedModels, ['gemini-2.5-flash-image'], 'the draft image call goes straight to a served model');

        videoModels.length = 0;
        const defaultVideo = await service.generateVideo({
            kind: 'video',
            prompt: 'Render ocean waves',
            workspaceRoot,
            idempotencyKey: 'default-video'
        });
        assert.strictEqual(defaultVideo.modelUsed, 'google/omni-1.1');
        assert.strictEqual(videoModels[0], 'google/omni-1.1', 'google/omni-1.1 must be #1 priority video route');
    } finally {
        await fs.remove(workspaceRoot);
    }

    console.log('🎉 GOOGLE MEDIA GENERATION ADAPTER TESTS PASSED');
}

test('google-media-generation-service.test', async () => {
    await runGoogleMediaGenerationServiceTests();
}, 180_000);

test('an image model that answers without an image is asked again before the request fails', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-google-media-empty-'));
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const empty = { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] };
    const withImage = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
    const run = async (answers: any[]) => {
        let calls = 0;
        const client: any = { models: { generateContent: async () => answers[Math.min(calls++, answers.length - 1)] } };
        const service = new GoogleMediaGenerationService(new MediaAssetStore(), async () => client);
        const result = await service.generateImage({
            kind: 'image', prompt: 'station', workspaceRoot, idempotencyKey: `empty-${answers.length}`, modelPriority: ['gemini-3.1-flash-image']
        }).catch((e: Error) => e);
        return { result, calls };
    };
    try {
        const recovered = await run([empty, empty, withImage]);
        assert.ok(!(recovered.result instanceof Error), String(recovered.result));
        assert.strictEqual(recovered.calls, 3);
        const bytes = await fs.readFile(path.join(workspaceRoot, (recovered.result as any).asset.relativePath));
        assert.ok(bytes.equals(png), 'stored asset is the image from the third answer');

        const exhausted = await run([empty]);
        assert.ok(exhausted.result instanceof Error && /returned no image \(STOP\)/.test(exhausted.result.message), String(exhausted.result));
        assert.strictEqual(exhausted.calls, 3, 'gives up after three empty answers');
    } finally {
        await fs.remove(workspaceRoot);
    }
});

test('image product names are sent as their API model ids, followed by the defaults without repeats', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-google-media-alias-'));
    const attempted: string[] = [];
    const rejected: string[] = [];
    let serving = true;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const client: any = {
        models: {
            generateContent: async ({ model }: { model: string }) => {
                attempted.push(model);
                if (!serving || !SERVED_IMAGE_MODEL_IDS.includes(model)) {
                    rejected.push(model);
                    throw notFound(model);
                }
                return { modelVersion: model, candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64'), mimeType: 'image/png' } }] } }] };
            }
        }
    };
    const service = new GoogleMediaGenerationService(new MediaAssetStore(), async () => client);
    const priority = (requested: string[], defaults: string[]): string[] => (service as any).modelPriority(requested, defaults);
    try {
        assert.deepStrictEqual(priority(['nano-banana-2'], IMAGE_MODEL_PRIORITY), ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']);
        assert.deepStrictEqual(priority(['google/nano-banana-pro'], IMAGE_MODEL_PRIORITY), ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image']);
        assert.deepStrictEqual(priority(['nano-banana-lite'], IMAGE_MODEL_PRIORITY_DRAFT), ['gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-image']);
        assert.deepStrictEqual(priority(['imagen-3.0-generate-002', 'nano-banana-2'], IMAGE_MODEL_PRIORITY), ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']);

        const image = await service.generateImage({
            kind: 'image', prompt: 'station', workspaceRoot, idempotencyKey: 'alias-image', modelPriority: ['nano-banana-2']
        });
        assert.strictEqual(image.modelUsed, 'gemini-3.1-flash-image');
        assert.deepStrictEqual(attempted, ['gemini-3.1-flash-image']);
        assert.deepStrictEqual(rejected, [], 'no request is spent on a product name');

        // When no model serves, each id is tried once, in priority order, and the failure is reported.
        serving = false;
        attempted.length = 0;
        const failed = await service.generateImage({
            kind: 'image', prompt: 'station', workspaceRoot, idempotencyKey: 'alias-none', modelPriority: ['nano-banana-2', 'gemini-3.1-flash-image']
        }).catch((e: Error) => e);
        assert.ok(failed instanceof Error && (failed as any).mediaError?.code === 'unsupported', String(failed));
        assert.deepStrictEqual(attempted, ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']);
    } finally {
        await fs.remove(workspaceRoot);
    }
});
