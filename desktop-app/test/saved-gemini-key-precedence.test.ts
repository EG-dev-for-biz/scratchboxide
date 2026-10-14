/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A Gemini key saved in Settings must survive a server restart: copying secrets.json into the environment at
 * startup used to replace it with the file's (stale) key, so image generation went back to 401 after every restart.
 */
import { test, afterEach } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { preferSavedGeminiKey } from '../server/app';
import { FileKeyStore } from '../../packages/core/src/node/key-store';
import { KEY_STORE_SERVICE, KEY_STORE_GEMINI_ACCOUNT } from '../../packages/core/src/node/gemini/gemini-client';

const original = process.env.GEMINI_API_KEY;
afterEach(() => {
    if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original;
});

async function storeWith(key?: string): Promise<{ store: FileKeyStore; dir: string }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-saved-key-'));
    const store = new FileKeyStore({ filePath: path.join(dir, 'credentials.json') });
    if (key) await store.setPassword(KEY_STORE_SERVICE, KEY_STORE_GEMINI_ACCOUNT, key);
    return { store, dir };
}

test('a key saved in Settings replaces one copied in from a secrets file', async () => {
    const { store, dir } = await storeWith('saved-in-settings-key-000000');
    try {
        process.env.GEMINI_API_KEY = 'stale-secrets-file-key-0000000';
        assert.strictEqual(preferSavedGeminiKey(store), true);
        assert.strictEqual(process.env.GEMINI_API_KEY, 'saved-in-settings-key-000000');
    } finally {
        await fs.remove(dir);
    }
});

test('with nothing saved, the secrets-file key is left alone', async () => {
    const { store, dir } = await storeWith();
    try {
        process.env.GEMINI_API_KEY = 'secrets-file-key-00000000000000';
        assert.strictEqual(preferSavedGeminiKey(store), false);
        assert.strictEqual(process.env.GEMINI_API_KEY, 'secrets-file-key-00000000000000');
    } finally {
        await fs.remove(dir);
    }
});

test('a saved key is applied when no secrets file supplied one', async () => {
    const { store, dir } = await storeWith('saved-in-settings-key-111111');
    try {
        delete process.env.GEMINI_API_KEY;
        assert.strictEqual(preferSavedGeminiKey(store), true);
        assert.strictEqual(process.env.GEMINI_API_KEY, 'saved-in-settings-key-111111');
    } finally {
        await fs.remove(dir);
    }
});
