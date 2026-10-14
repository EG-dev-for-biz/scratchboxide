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
import {
    IMAGE_MODEL_ALIASES,
    IMAGE_MODEL_PRIORITY,
    IMAGE_MODEL_PRIORITY_DRAFT,
    VIDEO_MODEL_PRIORITY,
    describeModelUsed,
    describeNoModelAnswered,
    resolveImageModelId,
    resolveRequestedModels,
    MediaGenerationRequest,
    classifyMediaGenerationError,
    validateMediaGenerationRequest
} from '../src/common/media-generation-protocol';

function runMediaGenerationProtocolTests(): void {
    console.log('🧪 Running media generation protocol tests...');

    assert.strictEqual(IMAGE_MODEL_PRIORITY[0], 'gemini-3.1-flash-image');
    assert.ok(IMAGE_MODEL_PRIORITY.includes('gemini-3.1-flash-image'));
    assert.strictEqual(VIDEO_MODEL_PRIORITY[0], 'google/omni-1.1');
    assert.ok(VIDEO_MODEL_PRIORITY.includes('veo-3.1-fast-generate-preview'));
    assert.ok(!VIDEO_MODEL_PRIORITY.some(model => model.includes('veo-2.0')));

    const imageRequest: MediaGenerationRequest = {
        kind: 'image',
        prompt: 'A restrained editorial illustration',
        workspaceRoot: '/tmp/project',
        idempotencyKey: 'image-once',
        aspectRatio: '16:9',
        imageSize: '2K'
    };
    assert.deepStrictEqual(validateMediaGenerationRequest(imageRequest), imageRequest);

    assert.throws(() => validateMediaGenerationRequest({
        ...imageRequest,
        prompt: ''
    }), /prompt/i);
    assert.throws(() => validateMediaGenerationRequest({
        ...imageRequest,
        workspaceRoot: ''
    }), /workspace/i);

    const quota = classifyMediaGenerationError({ status: 429, message: 'Resource exhausted' });
    assert.strictEqual(quota.code, 'quota');
    assert.strictEqual(quota.retryable, true);

    const safety = classifyMediaGenerationError({ message: 'The prompt was blocked by safety filters' });
    assert.strictEqual(safety.code, 'safety_filtered');
    assert.strictEqual(safety.retryable, false);

    const unsupported = classifyMediaGenerationError({ status: 404, message: 'Model not found' }, 'old-model');
    assert.strictEqual(unsupported.code, 'unsupported');
    assert.strictEqual(unsupported.model, 'old-model');

    console.log('🎉 MEDIA GENERATION PROTOCOL TESTS PASSED');
}

test('media-generation-protocol.test', async () => {
    await runMediaGenerationProtocolTests();
}, 180_000);

// Image model ids the Gemini API and Vertex AI answer to (product names such as nano-banana-2 404 on both).
const SERVED_IMAGE_MODEL_IDS = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];

test('image model lists hold API model ids, and product names resolve to them', () => {
    for (const model of [...IMAGE_MODEL_PRIORITY, ...IMAGE_MODEL_PRIORITY_DRAFT]) {
        assert.ok(SERVED_IMAGE_MODEL_IDS.includes(model), `${model} is not a served image model id`);
    }
    for (const [name, id] of Object.entries(IMAGE_MODEL_ALIASES)) {
        assert.ok(SERVED_IMAGE_MODEL_IDS.includes(id), `${name} maps to ${id}, which is not a served image model id`);
        assert.ok(!SERVED_IMAGE_MODEL_IDS.includes(name), `${name} is an API id, not an alias`);
    }

    assert.strictEqual(resolveImageModelId('nano-banana-2'), 'gemini-3.1-flash-image');
    assert.strictEqual(resolveImageModelId('Nano-Banana-2'), 'gemini-3.1-flash-image');
    assert.strictEqual(resolveImageModelId('google/nano-banana-pro'), 'gemini-3-pro-image');
    assert.strictEqual(resolveImageModelId('nano-banana-lite'), 'gemini-3.1-flash-lite-image');
    // An Imagen id names another model family: it is sent as given, never swapped for a Gemini image model.
    assert.strictEqual(resolveImageModelId('imagen-3.0-generate-002'), 'imagen-3.0-generate-002');
    assert.strictEqual(resolveImageModelId('gemini-2.5-flash-image'), 'gemini-2.5-flash-image');
    assert.strictEqual(resolveImageModelId('veo-3.1-generate-preview'), 'veo-3.1-generate-preview');
    assert.strictEqual(resolveImageModelId('constructor'), 'constructor', 'object prototype keys are not aliases');
});

test('a caller that names models gets exactly those models; the defaults are only for callers that name none', () => {
    assert.deepStrictEqual(resolveRequestedModels(['nano-banana-lite'], IMAGE_MODEL_PRIORITY), ['gemini-3.1-flash-lite-image']);
    assert.deepStrictEqual(resolveRequestedModels('gemini-3-pro-image', IMAGE_MODEL_PRIORITY), ['gemini-3-pro-image']);
    assert.deepStrictEqual(resolveRequestedModels(['nano-banana-2', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image'], IMAGE_MODEL_PRIORITY),
        ['gemini-3.1-flash-image', 'gemini-2.5-flash-image'], 'product names resolve, repeats collapse, nothing is appended');
    assert.deepStrictEqual(resolveRequestedModels(undefined, IMAGE_MODEL_PRIORITY), IMAGE_MODEL_PRIORITY);
    assert.deepStrictEqual(resolveRequestedModels(['', '  '], IMAGE_MODEL_PRIORITY), IMAGE_MODEL_PRIORITY, 'blank names are not names');
    assert.deepStrictEqual(resolveRequestedModels(['google/omni-1.1'], VIDEO_MODEL_PRIORITY), ['google/omni-1.1'], 'an Omni request is not widened to Veo');
});

test('the model note names the model that answered and why each earlier one was skipped', () => {
    assert.strictEqual(describeModelUsed('gemini-3.1-flash-image'), 'Generated with gemini-3.1-flash-image.');
    const note = describeModelUsed('gemini-3-pro-image', [
        { model: 'gemini-3.1-flash-lite-image', code: 'unsupported', reason: 'not served: models/gemini-3.1-flash-lite-image is not found' }
    ]);
    assert.ok(note.startsWith('Generated with gemini-3-pro-image, not the requested gemini-3.1-flash-lite-image'), note);
    assert.ok(note.includes('not served: models/gemini-3.1-flash-lite-image is not found'), note);
    assert.ok(describeNoModelAnswered('image', [{ model: 'a', code: 'unsupported', reason: 'not served: 404' }]).includes('a (not served: 404)'));
});

test('only "model not served" moves on to another model; an option a model rejects is an invalid request', () => {
    assert.strictEqual(classifyMediaGenerationError({ status: 400, message: 'imageSize 4K is not supported' }).code, 'invalid_request');
    assert.strictEqual(classifyMediaGenerationError({ status: 400, message: 'Model gemini-x is not supported for generateContent' }).code, 'unsupported');
    assert.strictEqual(classifyMediaGenerationError({ status: 404, message: 'Not Found' }).code, 'unsupported');
});
