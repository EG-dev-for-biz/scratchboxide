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
 * Guards the route names the renderer clients actually call
 * (`gemini-client.ts`, `workspace-config-client.ts`) against drift on the
 * standalone server. Each request here must reach a real handler: a 404 (or the
 * SPA fallback HTML) means the contract is broken.
 */
test('route contract: every renderer client route reaches a JSON handler', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-route-contract-'));
    process.env.SCRATCHBOX_WORKSPACE_ROOTS = os.tmpdir();
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;

    const app = createStandaloneServer({ port: 0, toolsPort: 3997 });
    const token: string = app.locals.launchToken;
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    const post = async (route: string, body: unknown): Promise<{ status: number; json: any }> => {
        const res = await fetch(`${base}${route}`, {
            method: 'POST',
            headers: { 'X-Scratchbox-Token': token, 'Connection': 'close', 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        assert.ok(!text.startsWith('<!DOCTYPE'), `${route} fell through to the SPA/404 page`);
        return { status: res.status, json: text ? JSON.parse(text) : null };
    };

    const get = async (route: string): Promise<{ status: number; json: any }> => {
        const res = await fetch(`${base}${route}`, {
            method: 'GET',
            headers: { 'X-Scratchbox-Token': token, 'Connection': 'close' }
        });
        const text = await res.text();
        assert.ok(!text.startsWith('<!DOCTYPE'), `${route} fell through to the SPA/404 page`);
        return { status: res.status, json: text ? JSON.parse(text) : null };
    };

    try {
        // gemini-client.ts: names that had drifted from the server
        const creds = await post('/gemini/save-credentials', { apiKey: '' });
        assert.strictEqual(creds.status, 400, 'save-credentials must validate input (route exists)');
        assert.strictEqual(creds.json.success, false);

        const ping = await post('/gemini/mcp/ping', { server: { id: 'x', name: 'x', url: 'http://127.0.0.1:9/', transport: 'http' } });
        assert.ok(ping.status === 200 || ping.status === 500, `mcp/ping must be routed (got ${ping.status})`);
        assert.ok(ping.json && typeof ping.json === 'object');

        // gemini-client.ts: standalone verification routes
        const verify = await post('/gemini/verify-visual', {});
        assert.strictEqual(verify.status, 400, 'verify-visual must require image + prompt');
        const repair = await post('/gemini/verify-and-repair', { request: {} });
        assert.strictEqual(repair.status, 400, 'verify-and-repair must require image + prompt');
        const tts = await post('/gemini/tts', {});
        assert.strictEqual(tts.status, 400, 'tts must require text');

        // Capability Resolution & Media Job Polling
        const cap = await post('/gemini/capability/resolve', { userGoal: 'procedural mountain terrain with SDF marching cubes' });
        assert.strictEqual(cap.status, 200, 'capability/resolve must be reachable');
        assert.strictEqual(cap.json.success, true);
        assert.strictEqual(cap.json.resolution?.canSolveNatively, true);

        const job = await get(`/gemini/jobs/missing-job-1234?workspaceRoot=${encodeURIComponent(workspaceRoot)}`);
        assert.strictEqual(job.status, 404, 'gemini/jobs/:id must route and return 404 for missing job');

        const jobWithoutRoot = await get('/gemini/jobs/missing-job-1234');
        assert.strictEqual(jobWithoutRoot.status, 404, 'gemini/jobs/:id defaults to cwd and returns 404 for missing job');

        // Standalone mounted /memories endpoint
        const directMemories = await get(`/memories?workspaceRoot=${encodeURIComponent(workspaceRoot)}`);
        assert.strictEqual(directMemories.status, 200, 'standalone /memories endpoint must be reachable');
        assert.strictEqual(directMemories.json.success, true);

        // workspace-config-client.ts
        const lens = await post('/workspace/write-lens-files', {
            workspaceRoot,
            files: { 'lens/notes.md': '# hello' }
        });
        assert.strictEqual(lens.status, 200, JSON.stringify(lens.json));
        assert.strictEqual(lens.json.success, true);
        assert.ok(fs.existsSync(path.join(workspaceRoot, 'lens', 'notes.md')), 'lens file must be written inside the workspace');

        const escape = await post('/workspace/write-lens-files', {
            workspaceRoot,
            files: { '../escape.md': 'nope' }
        });
        assert.strictEqual(escape.status, 403, 'lens writes must not escape the workspace root');
        assert.ok(!fs.existsSync(path.join(path.dirname(workspaceRoot), 'escape.md')));

        const hash = await post('/workspace/register-hash', { filePath: path.join(workspaceRoot, 'lens', 'notes.md'), hash: 'abc' });
        assert.strictEqual(hash.status, 200);
        assert.strictEqual(hash.json.success, true);
        const badHash = await post('/workspace/register-hash', { filePath: '/etc/passwd', hash: 'abc' });
        assert.strictEqual(badHash.status, 403, 'hash registration must be confined to workspace roots');

        const importEmpty = await post('/workspace/import-mcp', { workspaceRoot, servers: [] });
        assert.strictEqual(importEmpty.status, 400);
        const imported = await post('/workspace/import-mcp', {
            workspaceRoot,
            servers: [{ id: 'srv-1', name: 'Local MCP', url: 'http://127.0.0.1:9', transport: 'http', enabled: true }]
        });
        assert.strictEqual(imported.status, 200, JSON.stringify(imported.json));
        assert.strictEqual(imported.json.success, true);
        assert.strictEqual(imported.json.count, 1);
    } finally {
        (server as any).closeAllConnections?.();
        server.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
}, 120_000);
