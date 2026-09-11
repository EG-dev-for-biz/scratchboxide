/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import {
    IMAGE_MODEL_PRIORITY,
    VIDEO_MODEL_PRIORITY,
    MediaGenerationRequest,
    classifyMediaGenerationError,
    validateMediaGenerationRequest
} from '../src/common/media-generation-protocol';

function runMediaGenerationProtocolTests(): void {
    console.log('🧪 Running media generation protocol tests...');

    assert.strictEqual(IMAGE_MODEL_PRIORITY[0], 'gemini-3.1-flash-image');
    assert.strictEqual(VIDEO_MODEL_PRIORITY[0], 'veo-3.1-fast-generate-preview');
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

runMediaGenerationProtocolTests();
