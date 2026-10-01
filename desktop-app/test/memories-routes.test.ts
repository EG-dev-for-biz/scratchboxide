/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { test } from 'vitest';
import { createStandaloneServer } from '../server/app';

/**
 * The renderer's `UserMemoriesClient` (packages/core/src/browser/generative-canvas/user-memories-client.ts)
 * talks to `/gemini/memories/*`. These routes used to live only in the deleted Theia
 * endpoint, so the standalone server must expose the same contract.
 *
 * All mutations use `scope: 'workspace'` against a tmpdir so the user's real
 * `~/.scratchbox-ide/memories.json` is never written.
 */
test('memories routes: full client contract on the standalone server', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-memories-'));
    process.env.SCRATCHBOX_WORKSPACE_ROOTS = os.tmpdir();
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;

    const app = createStandaloneServer({ port: 0, toolsPort: 3998 });
    const token: string = app.locals.launchToken;
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}/gemini/memories`;

    const call = async (route: string, body?: unknown): Promise<{ status: number; json: any }> => {
        const res = await fetch(`${base}${route}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                'X-Scratchbox-Token': token,
                'Connection': 'close',
                ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, json: await res.json() };
    };
    const ws = `?workspaceRoot=${encodeURIComponent(workspaceRoot)}`;

    try {
        // create (client calls /create, not POST /memories)
        const created = await call('/create', { category: 'coding-preferences', key: 'indent', value: '4 spaces', scope: 'workspace', workspaceRoot });
        assert.strictEqual(created.status, 200, JSON.stringify(created.json));
        assert.strictEqual(created.json.success, true);
        const id: string = created.json.memory.id;
        assert.ok(id, 'created memory must have an id');

        // validation
        const bad = await call('/create', { key: 'x', scope: 'workspace', workspaceRoot });
        assert.strictEqual(bad.status, 400);

        // list
        const listed = await call(`${ws}&scope=workspace`);
        assert.strictEqual(listed.status, 200);
        assert.ok(listed.json.memories.some((m: any) => m.id === id), 'listed memories must include the created one');

        // update
        const updated = await call('/update', { id, value: '2 spaces', workspaceRoot });
        assert.strictEqual(updated.status, 200, JSON.stringify(updated.json));
        assert.strictEqual(updated.json.memory.value, '2 spaces');
        const missing = await call('/update', { id: 'nope', value: 'x', workspaceRoot });
        assert.strictEqual(missing.status, 404);

        // writing profiles
        const profile = await call('/writing-profiles', { action: 'create', name: 'Terse', stylePrompt: 'Short sentences.', scope: 'workspace', workspaceRoot });
        assert.strictEqual(profile.status, 200, JSON.stringify(profile.json));
        const profileId: string = profile.json.profile.id;
        const activated = await call('/writing-profiles', { action: 'set-active', id: profileId, workspaceRoot });
        assert.strictEqual(activated.json.success, true);
        const profiles = await call(`/writing-profiles${ws}`);
        assert.strictEqual(profiles.status, 200);
        assert.ok(profiles.json.profiles.some((p: any) => p.id === profileId));
        assert.strictEqual(profiles.json.activeProfile?.id, profileId, 'active profile must be reported');
        const badProfile = await call('/writing-profiles', { action: 'bogus', workspaceRoot });
        assert.strictEqual(badProfile.status, 400);

        // style preferences
        const pref = await call('/style-preferences', { action: 'create', name: 'Film grain', stylePrompt: 'subtle film grain', category: 'image', scope: 'workspace', workspaceRoot });
        assert.strictEqual(pref.status, 200, JSON.stringify(pref.json));
        const prefId: string = pref.json.preference.id;
        const prefs = await call(`/style-preferences${ws}&category=image`);
        assert.ok(prefs.json.preferences.some((p: any) => p.id === prefId));
        const prefDeleted = await call('/style-preferences', { action: 'delete', id: prefId, workspaceRoot });
        assert.strictEqual(prefDeleted.json.success, true);

        // config (read-only here; writes would touch the real global store)
        const config = await call('/config');
        assert.strictEqual(config.status, 200);
        assert.ok(config.json.config && typeof config.json.config === 'object');

        // clear-category + delete
        const cleared = await call('/clear-category', { category: 'coding-preferences', workspaceRoot });
        assert.strictEqual(cleared.status, 200);
        assert.ok(cleared.json.clearedCount >= 1, 'clear-category must report the cleared count');
        const deleted = await call('/delete', { id, workspaceRoot });
        assert.strictEqual(deleted.status, 200);

        // workspace roots outside the allowlist are refused
        const outside = await call('/create', { category: 'c', key: 'k', value: 'v', scope: 'workspace', workspaceRoot: '/etc' });
        assert.strictEqual(outside.status, 403);

        // no token → 401
        const anon = await fetch(`${base}/config`, { headers: { Connection: 'close' } });
        assert.strictEqual(anon.status, 401);
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
}, 120_000);
