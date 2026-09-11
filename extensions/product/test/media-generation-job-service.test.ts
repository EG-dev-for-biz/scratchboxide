/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
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

runMediaGenerationJobServiceTests().catch(error => {
    console.error('❌ Media generation job state test failed:', error);
    process.exit(1);
});
