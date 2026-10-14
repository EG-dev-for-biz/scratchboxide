/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { test } from 'vitest';
import * as assert from 'assert';
import * as fs from 'fs';
import http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createStandaloneServer } from '../server/app';

/** POST /3d/tiles/refine: token gate, workspace-root allowlist, path confinement and request validation. */
test('tile refine route: auth and request validation on the standalone server', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tile-refine-route-'));
    process.env.SCRATCHBOX_WORKSPACE_ROOTS = os.tmpdir();
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;

    const app = createStandaloneServer({ port: 0, toolsPort: 3997 });
    const token: string = app.locals.launchToken;
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };

    const post = async (body: unknown, withToken = true): Promise<{ status: number; json: any }> => {
        const res = await fetch(`http://127.0.0.1:${port}/3d/tiles/refine`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Connection: 'close', ...(withToken ? { 'X-Scratchbox-Token': token } : {}) },
            body: JSON.stringify(body)
        });
        return { status: res.status, json: await res.json() };
    };

    try {
        assert.strictEqual((await post({ tilePath: 'public/tiles/a.glb', workspaceRoot }, false)).status, 401);

        const traversal = await post({ tilePath: '../../../etc/passwd.glb', workspaceRoot });
        assert.strictEqual(traversal.status, 403, JSON.stringify(traversal.json));

        const badRoot = await post({ tilePath: 'hosts.glb', workspaceRoot: '/etc' });
        assert.strictEqual(badRoot.status, 403, JSON.stringify(badRoot.json));

        const missingPath = await post({ workspaceRoot });
        assert.strictEqual(missingPath.status, 400, JSON.stringify(missingPath.json));
        assert.strictEqual(missingPath.json.error, 'bad_request');

        const missingTile = await post({ tilePath: 'public/tiles/missing.glb', workspaceRoot });
        assert.strictEqual(missingTile.status, 404, JSON.stringify(missingTile.json));
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});
