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
import http from 'http';
import { createStandaloneServer, createToolsServer } from '../server/app';

async function listen(app: any): Promise<{ server: http.Server; baseUrl: string }> {
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as { port: number };
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function close(server: http.Server): void {
    (server as any).closeAllConnections?.();
    server.close();
}

test('server-auth: launch token, CORS allowlist and open endpoints', async () => {
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;
    const app = createStandaloneServer({ port: 0 });
    const token: string = app.locals.launchToken;
    assert.ok(typeof token === 'string' && token.length >= 64, 'createStandaloneServer must generate a 32-byte hex launch token');

    const { server, baseUrl } = await listen(app);
    try {
        // Open endpoints
        const health = await fetch(`${baseUrl}/health`);
        assert.strictEqual(health.status, 200, '/health must be open');
        const healthBody = await health.json();
        assert.strictEqual(healthBody.ok, true);

        const browserStatus = await fetch(`${baseUrl}/api/browser/status`);
        assert.strictEqual(browserStatus.status, 200, '/api/browser/status must be open');

        // No token → 401 JSON
        const noToken = await fetch(`${baseUrl}/gemini/models`);
        assert.strictEqual(noToken.status, 401, 'missing token must be rejected');
        const noTokenBody = await noToken.json();
        assert.strictEqual(noTokenBody.error, 'unauthorized');

        const noTokenPost = await fetch(`${baseUrl}/gemini/credentials`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: 'AIzaSyFakeFakeFakeFakeFakeFakeFakeFake' })
        });
        assert.strictEqual(noTokenPost.status, 401, 'credential writes must require the token');

        // Wrong token → 401
        const wrongBearer = await fetch(`${baseUrl}/gemini/models`, { headers: { Authorization: 'Bearer nope' } });
        assert.strictEqual(wrongBearer.status, 401);
        const wrongHeader = await fetch(`${baseUrl}/gemini/models`, { headers: { 'X-Scratchbox-Token': `${token}x` } });
        assert.strictEqual(wrongHeader.status, 401);

        // Right token via Bearer and via X-Scratchbox-Token
        const bearer = await fetch(`${baseUrl}/gemini/models`, { headers: { Authorization: `Bearer ${token}` } });
        assert.strictEqual(bearer.status, 200, 'bearer token must be accepted');
        const header = await fetch(`${baseUrl}/gemini/models`, { headers: { 'X-Scratchbox-Token': token } });
        assert.strictEqual(header.status, 200, 'X-Scratchbox-Token must be accepted');

        // Query token only works for the SSE/EventSource GET
        const sseController = new AbortController();
        const sse = await fetch(`${baseUrl}/workspace/events/file-change?token=${token}`, { signal: sseController.signal });
        assert.strictEqual(sse.status, 200, 'query token must work for SSE GET');
        assert.ok((sse.headers.get('content-type') || '').includes('text/event-stream'));
        sseController.abort();

        const queryOnJson = await fetch(`${baseUrl}/gemini/models?token=${token}`);
        assert.strictEqual(queryOnJson.status, 401, 'query token must not work for non-SSE routes');

        // CORS: disallowed origin → 403 even with a valid token
        const badOrigin = await fetch(`${baseUrl}/gemini/models`, {
            headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` }
        });
        assert.strictEqual(badOrigin.status, 403, 'disallowed Origin must be rejected');

        const badOriginPreflight = await fetch(`${baseUrl}/gemini/models`, {
            method: 'OPTIONS',
            headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' }
        });
        assert.strictEqual(badOriginPreflight.status, 403, 'disallowed Origin preflight must be rejected');

        // Allowed origins pass and are echoed
        const goodOrigin = await fetch(`${baseUrl}/gemini/models`, {
            headers: { Origin: 'http://localhost:3000', Authorization: `Bearer ${token}` }
        });
        assert.strictEqual(goodOrigin.status, 200);
        assert.strictEqual(goodOrigin.headers.get('access-control-allow-origin'), 'http://localhost:3000');

        // Open endpoints stay open even with a bad origin? No — CORS applies first.
        const healthBadOrigin = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://evil.example' } });
        assert.strictEqual(healthBadOrigin.status, 403);

        // Exported tools are no longer served from the API origin
        const toolFromApi = await fetch(`${baseUrl}/tools/some-tool`, { headers: { Authorization: `Bearer ${token}` } });
        assert.notStrictEqual(toolFromApi.status, 200, '/tools must not be mounted on the API app');
    } finally {
        close(server);
    }
});

test('server-auth: SCRATCHBOX_LAUNCH_TOKEN and SCRATCHBOX_ALLOWED_ORIGINS are honoured', async () => {
    process.env.SCRATCHBOX_LAUNCH_TOKEN = 'fixed-token-from-env';
    process.env.SCRATCHBOX_ALLOWED_ORIGINS = 'http://localhost:5173, http://127.0.0.1:5173';
    try {
        const app = createStandaloneServer({ port: 0 });
        assert.strictEqual(app.locals.launchToken, 'fixed-token-from-env');
        const { server, baseUrl } = await listen(app);
        try {
            const ok = await fetch(`${baseUrl}/gemini/models`, {
                headers: { Origin: 'http://localhost:5173', 'X-Scratchbox-Token': 'fixed-token-from-env' }
            });
            assert.strictEqual(ok.status, 200);
            assert.strictEqual(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
        } finally {
            close(server);
        }
    } finally {
        delete process.env.SCRATCHBOX_LAUNCH_TOKEN;
        delete process.env.SCRATCHBOX_ALLOWED_ORIGINS;
    }
});

test('server-auth: workspace roots outside the allowlist are rejected', async () => {
    delete process.env.SCRATCHBOX_LAUNCH_TOKEN;
    const app = createStandaloneServer({ port: 0 });
    const token: string = app.locals.launchToken;
    const { server, baseUrl } = await listen(app);
    const authed = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    try {
        const config = await fetch(`${baseUrl}/workspace/config?root=${encodeURIComponent('/etc')}`, { headers: authed });
        assert.strictEqual(config.status, 403, 'GET /workspace/config with a foreign root must be rejected');

        const saveConfig = await fetch(`${baseUrl}/workspace/config`, {
            method: 'POST', headers: authed, body: JSON.stringify({ workspaceRoot: '/etc', settings: {} })
        });
        assert.strictEqual(saveConfig.status, 403);

        const sync = await fetch(`${baseUrl}/workspace/sync-artifact`, {
            method: 'POST', headers: authed,
            body: JSON.stringify({ workspaceRoot: '/tmp/definitely-not-allowed-root', artifact: { type: 'markdown-document', title: 'x', data: {} } })
        });
        assert.strictEqual(sync.status, 403);

        const artifacts = await fetch(`${baseUrl}/workspace/project-artifacts?root=${encodeURIComponent('/etc')}`, { headers: authed });
        assert.strictEqual(artifacts.status, 403);

        const create = await fetch(`${baseUrl}/workspace/create`, {
            method: 'POST', headers: authed, body: JSON.stringify({ name: 'evil', path: '/etc/scratchbox-evil' })
        });
        assert.strictEqual(create.status, 403, 'workspace creation outside allowed roots must be rejected');

        const mediaJob = await fetch(`${baseUrl}/media/jobs/some-id?workspaceRoot=${encodeURIComponent('/etc')}`, { headers: authed });
        assert.strictEqual(mediaJob.status, 403);

        const memories = await fetch(`${baseUrl}/gemini/memories?workspaceRoot=${encodeURIComponent('/etc')}`, { headers: authed });
        assert.strictEqual(memories.status, 403);

        // cwd is always allowed
        const okConfig = await fetch(`${baseUrl}/workspace/config?root=${encodeURIComponent(process.cwd())}`, { headers: authed });
        assert.strictEqual(okConfig.status, 200);
    } finally {
        close(server);
    }
});

test('tools server serves exported tools on its own origin with a sandboxing CSP', async () => {
    const store = new Map<string, { id: string; title: string; html: string; updatedAt: number }>();
    store.set('tool-1', { id: 'tool-1', title: 'T', html: '<!doctype html><html><body>hello tool</body></html>', updatedAt: Date.now() });
    const toolsApp = createToolsServer(store);
    const { server, baseUrl } = await listen(toolsApp);
    try {
        const res = await fetch(`${baseUrl}/tool-1`);
        assert.strictEqual(res.status, 200);
        const csp = res.headers.get('content-security-policy') || '';
        assert.ok(csp.includes('sandbox allow-scripts'), `CSP must sandbox the tool document (got: ${csp})`);
        assert.ok(csp.includes("default-src 'self'"), 'CSP must restrict default-src');
        assert.strictEqual(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
        assert.strictEqual(res.headers.get('x-frame-options'), null, 'tools must remain embeddable (no X-Frame-Options)');
        assert.ok((await res.text()).includes('hello tool'));

        const missing = await fetch(`${baseUrl}/nope`);
        assert.strictEqual(missing.status, 404);
    } finally {
        close(server);
    }
});
