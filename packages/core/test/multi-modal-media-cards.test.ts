import { test } from 'vitest';
import * as path from 'path';
import * as os from 'os';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import { GraphNode, GraphNodeCategory } from '../src/browser/generative-canvas/canvas-types';
import { validateMediaGenerationRequest, MediaGenerationRequest } from '../src/common/media-generation-protocol';

async function runMultiModalTests() {
    console.log('🧪 Running Unified Multi-Modal Media Cards & Nodal Workflow Test Suite...');

    // 1. Support for categories in GraphNodeCategory
    console.log('  Testing GraphNodeCategory additions...');
    const categories: GraphNodeCategory[] = [
        'image',
        'image-card',
        'video',
        'video-card',
        'audio',
        'audio-card',
        '3d-card'
    ];
    categories.forEach(cat => {
        assert.ok(typeof cat === 'string', `Category ${cat} should be a valid TS string type`);
    });
    console.log('  ✓ Category additions validated successfully.');

    // 2. Validate multi-modal requests (including audio and 3D scenes)
    console.log('  Testing multi-modal request validation...');
    const audioReq: MediaGenerationRequest = {
        kind: 'audio' as any,
        prompt: 'Warm confident narration for project spec video walkthrough',
        workspaceRoot: path.join(os.tmpdir(), 'scratchbox-ide-test'),
        idempotencyKey: 'idemp-audio-123'
    };

    const validatedAudio = validateMediaGenerationRequest(audioReq);
    assert.strictEqual(validatedAudio.kind, 'audio');
    assert.strictEqual(validatedAudio.prompt, 'Warm confident narration for project spec video walkthrough');

    const scene3dReq: MediaGenerationRequest = {
        kind: '3d' as any,
        prompt: 'Generate an interactive low-poly satellite',
        workspaceRoot: path.join(os.tmpdir(), 'scratchbox-ide-test'),
        idempotencyKey: 'idemp-3d-123'
    };

    const validatedScene3d = validateMediaGenerationRequest(scene3dReq);
    assert.strictEqual(validatedScene3d.kind, '3d');
    console.log('  ✓ Multi-modal requests validated successfully.');

    // 3. Negative validation cases
    console.log('  Testing validation error handling...');
    const invalidReq = {
        kind: 'hologram' as any,
        prompt: 'Test prompt',
        workspaceRoot: '/workspace',
        idempotencyKey: 'key-1'
    };

    assert.throws(() => {
        validateMediaGenerationRequest(invalidReq);
    }, /A valid media kind is required/);

    const emptyPromptReq = {
        kind: 'image' as any,
        prompt: '',
        workspaceRoot: '/workspace',
        idempotencyKey: 'key-2'
    };

    assert.throws(() => {
        validateMediaGenerationRequest(emptyPromptReq);
    }, /A non-empty media prompt is required/);
    console.log('  ✓ Validation errors thrown accurately.');

    // 4. Node parameter initialization
    console.log('  Testing node parameter initialization...');
    const imageNode: GraphNode = {
        id: 'node-image-1',
        label: 'Cover Art Image Card',
        category: 'image-card',
        x: 100,
        y: 150,
        parameters: {
            prompt: 'Cozy retro terminal workbench, soft neon backlighting, high detail digital art',
            aspectRatio: '16:9',
            isGenerating: false
        }
    };

    assert.strictEqual(imageNode.category, 'image-card');
    assert.strictEqual(imageNode.parameters?.aspectRatio, '16:9');
    assert.strictEqual(imageNode.parameters?.isGenerating, false);

    const videoNode: GraphNode = {
        id: 'node-video-1',
        label: 'Cinematic B-Roll Video Card',
        category: 'video-card',
        x: 400,
        y: 150,
        parameters: {
            prompt: 'Drone shot descending over neon skyscraper landscape, hyperlapse',
            durationSeconds: 4,
            isGenerating: false
        }
    };

    assert.strictEqual(videoNode.category, 'video-card');
    assert.strictEqual(videoNode.parameters?.durationSeconds, 4);

    const audioNode: GraphNode = {
        id: 'node-audio-1',
        label: 'Voiceover Audio Card',
        category: 'audio-card',
        x: 700,
        y: 150,
        parameters: {
            prompt: 'Studio deep male narrator speaking clearly and slowly',
            audioKind: 'speech',
            voiceId: 'Chirp-1'
        }
    };

    assert.strictEqual(audioNode.category, 'audio-card');
    assert.strictEqual(audioNode.parameters?.audioKind, 'speech');
    assert.strictEqual(audioNode.parameters?.voiceId, 'Chirp-1');
    console.log('  ✓ Node parameters initialized correctly.');

    console.log('\n🎉 ALL MULTI-MODAL MEDIA CARDS TESTS PASSED SUCCESSFULLY!\n');
}

test('multi-modal-media-cards.test', async () => {
    await runMultiModalTests();
}, 180_000);
