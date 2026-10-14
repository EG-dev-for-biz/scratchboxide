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
import { MediaGenerationJobService } from '../src/node/media-generation-job-service';

async function runMediaGenerationJobServiceTests(): Promise<void> {
    console.log('🧪 Running media generation job state tests...');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-media-jobs-'));
    const transitions: string[] = [];

    const generator: any = {
        generateImage: async () => ({
            modelUsed: 'gemini-3.1-flash-image',
            asset: {
                uri: 'scratchbox-media://abc',
                contentHash: 'abc',
                mimeType: 'image/png',
                byteLength: 3,
                relativePath: '.scratchbox/media/abc.png'
            }
        }),
        generateVideo: async () => {
            throw Object.assign(new Error('Quota exhausted'), { status: 429 });
        }
    };

    try {
        const service = new MediaGenerationJobService(generator);
        service.onDidChange(job => transitions.push(job.status));

        const created = await service.create({
            kind: 'image',
            prompt: 'Generate',
            workspaceRoot,
            idempotencyKey: 'same-request'
        });
        const duplicate = await service.create({
            kind: 'image',
            prompt: 'Generate',
            workspaceRoot,
            idempotencyKey: 'same-request'
        });
        assert.strictEqual(created.id, duplicate.id, 'Idempotent create must reuse the existing job');
        assert.strictEqual(created.status, 'queued');

        const completed = await service.process(created.id, workspaceRoot);
        assert.strictEqual(completed.status, 'completed');
        assert.strictEqual(completed.result?.asset.contentHash, 'abc');
        assert.ok(transitions.includes('submitting'));
        assert.ok(transitions.includes('running'));
        assert.ok(transitions.includes('completed'));

        const reloaded = new MediaGenerationJobService(generator);
        const persisted = await reloaded.get(created.id, workspaceRoot);
        assert.strictEqual(persisted?.status, 'completed');
        assert.strictEqual((persisted as any).request.workspaceRoot, undefined, 'Workspace paths must not be persisted in request payload');

        const video = await service.create({
            kind: 'video',
            prompt: 'Generate video',
            workspaceRoot,
            idempotencyKey: 'quota-video'
        });
        const failed = await service.process(video.id, workspaceRoot);
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(failed.error?.code, 'quota');
        assert.strictEqual(failed.error?.retryable, true);

        // Kinds without a generator must fail explicitly, never "complete" with a fabricated asset
        for (const kind of ['audio', '3d'] as const) {
            const unsupported = await service.create({
                kind,
                prompt: `Generate ${kind}`,
                workspaceRoot,
                idempotencyKey: `unsupported-${kind}`
            } as any);
            const unsupportedResult = await service.process(unsupported.id, workspaceRoot);
            assert.strictEqual(unsupportedResult.status, 'failed', `${kind} jobs must fail, not succeed with mock media`);
            assert.strictEqual(unsupportedResult.error?.code, 'unsupported');
            assert.strictEqual(unsupportedResult.error?.retryable, false);
            assert.match(unsupportedResult.error?.message || '', new RegExp(`kind '${kind}' is not supported`));
            assert.strictEqual(unsupportedResult.result, undefined, 'No asset may be attached to an unsupported-kind job');
        }

        const queued = await service.create({
            kind: 'image',
            prompt: 'Cancel this',
            workspaceRoot,
            idempotencyKey: 'cancel-image'
        });
        const cancelled = await service.cancel(queued.id, workspaceRoot);
        assert.strictEqual(cancelled.status, 'cancelled');
    } finally {
        await fs.remove(workspaceRoot);
    }

    console.log('🎉 MEDIA GENERATION JOB STATE TESTS PASSED');
}

test('media-generation-job-service.test', async () => {
    await runMediaGenerationJobServiceTests();
}, 180_000);
