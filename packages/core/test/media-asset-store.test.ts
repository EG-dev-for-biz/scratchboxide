import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { MediaAssetStore } from '../src/node/media-asset-store';

async function runMediaAssetStoreTests(): Promise<void> {
    console.log('🧪 Running media asset store tests...');
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scratchbox-media-assets-'));

    try {
        const store = new MediaAssetStore();
        const bytes = Buffer.from('deterministic image bytes');
        const first = await store.put(workspaceRoot, bytes, 'image/png');
        const second = await store.put(workspaceRoot, bytes, 'image/png');

        assert.strictEqual(first.contentHash, second.contentHash);
        assert.strictEqual(first.relativePath, second.relativePath);
        assert.strictEqual(first.uri, `scratchbox-media://${first.contentHash}`);
        assert.strictEqual(first.byteLength, bytes.length);

        const resolved = store.resolve(workspaceRoot, first);
        assert.ok(resolved.startsWith(path.join(workspaceRoot, '.scratchbox', 'media')));
        assert.deepStrictEqual(await fs.readFile(resolved), bytes);

        assert.throws(() => store.resolve(workspaceRoot, {
            ...first,
            relativePath: '../service-account.json'
        }), /outside|invalid/i);
        await assert.rejects(() => store.put(workspaceRoot, bytes, 'text/html'), /mime/i);
    } finally {
        await fs.remove(workspaceRoot);
    }

    console.log('🎉 MEDIA ASSET STORE TESTS PASSED');
}

test('media-asset-store.test', async () => {
    await runMediaAssetStoreTests();
}, 180_000);
