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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { Router } from 'express';
import { createVideoRouter } from '../server/routes/mediaVideoRoutes';
import { createGitRouter } from '../server/routes/workspaceRoutes';
import { isPathError, RouteContext } from '../server/routes/types';
import { assertWorkspaceRoot } from '../../packages/core/src/node/security/path-guard';
import { HeadlessVideoCompositorService } from '../../packages/core/src/node';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function invokeRouter(
    router: Router,
    method: 'GET' | 'POST',
    url: string,
    options: { query?: Record<string, any>; body?: Record<string, any> } = {}
): Promise<{ status: number; json: any }> {
    return new Promise((resolve) => {
        const req: any = { method, url, query: options.query || {}, body: options.body || {}, headers: {} };
        const res: any = {
            statusCode: 200,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: any) { resolve({ status: this.statusCode, json: payload }); }
        };
        router(req, res, (err?: any) => resolve({ status: err ? 500 : 404, json: { error: err?.message || 'Not found' } }));
    });
}

function makeContext(root: string): RouteContext {
    const allowedWorkspaceRoots = [root];
    return {
        allowedWorkspaceRoots,
        requireWorkspaceRoot: (candidate: unknown) =>
            assertWorkspaceRoot(typeof candidate === 'string' && candidate.trim() ? candidate.trim() : root, allowedWorkspaceRoots),
        sendError: (res: any, err: any, fallbackStatus = 500) => {
            if (isPathError(err)) {
                res.status(403).json({ success: false, error: 'workspace_root_not_allowed', message: err.message });
                return;
            }
            res.status(fallbackStatus).json({ success: false, error: err?.message || 'Internal server error' });
        },
        isPathError
    };
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs = 15000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) return false;
        const ok = await new Promise<boolean>(resolve => {
            const sock = net.connect(port, '127.0.0.1');
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', () => resolve(false));
        });
        if (ok) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

/** Raw HTTP request so tests can set Host / Origin headers that fetch() forbids. */
function rawRequest(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, any>; body: string }> {
    const http = require('http') as typeof import('http');
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            method: opts.method || 'GET',
            path: opts.path,
            headers: { Host: `127.0.0.1:${port}`, ...(opts.headers || {}) }
        }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
    });
}

describe('workspace git routes reject option injection', () => {
    test('checkout and diff refuse values starting with "-"', async () => {
        const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-git-sec-')));
        try {
            const router = createGitRouter(makeContext(root));
            const checkout = await invokeRouter(router, 'POST', '/checkout', { body: { workspaceRoot: root, branch: '--orphan=pwn' } });
            assert.strictEqual(checkout.status, 400);
            const checkoutShort = await invokeRouter(router, 'POST', '/checkout', { body: { workspaceRoot: root, branch: '-b' } });
            assert.strictEqual(checkoutShort.status, 400);
            const diff = await invokeRouter(router, 'GET', '/diff', { query: { workspaceRoot: root, commit: '--output=/tmp/pwn' } });
            assert.strictEqual(diff.status, 400);
        } finally {
            await fs.remove(root);
        }
    });
});

describe('video composite route confines output and inputs', () => {
    let root: string;
    let router: Router;
    const timeline = (url?: string) => ({
        id: 't', version: '1.0.0', duration: 2, fps: 24, currentTime: 0,
        tracks: [{
            id: 'v1', name: 'V1', type: 'video', visible: true,
            elements: [{ id: 'clip-1', name: 'c', type: 'video', startTime: 0, duration: 2, trimStart: 0, trimEnd: 2, ...(url ? { url } : {}) }]
        }]
    });

    beforeAll(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-video-sec-')));
        await fs.writeFile(path.join(root, 'clip.mp4'), 'x');
        router = createVideoRouter(new HeadlessVideoCompositorService(), makeContext(root));
    });
    afterAll(async () => { await fs.remove(root); });

    test('outputPath traversal is rejected even without workspaceRoot', async () => {
        const res = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline(), outputPath: '/etc/scratchbox_pwn.mp4', dryRun: true }
        });
        assert.strictEqual(res.status, 403);
        const rel = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline(), outputPath: '../escape.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(rel.status, 403);
    });

    test('inputs outside the workspace and non-http protocols are rejected', async () => {
        const outside = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline('/etc/passwd'), outputPath: 'out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(outside.status, 403);
        const custom = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline(), customInputs: { 'clip-1': '../../etc/hosts' }, outputPath: 'out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(custom.status, 403);
        const concat = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline('concat:/etc/passwd|/etc/hosts'), outputPath: 'out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(concat.status, 400);
    });

    test('confined local input and http(s) URL pass with a protocol whitelist', async () => {
        const local = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline('clip.mp4'), outputPath: 'renders/out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(local.status, 200);
        assert.strictEqual(local.json.success, true);
        assert.strictEqual(local.json.outputPath, path.join(root, 'renders/out.mp4'));
        assert.ok(local.json.ffmpegCommand.includes('-protocol_whitelist file,http,https,tcp,tls'));
        assert.ok(local.json.ffmpegCommand.includes(`file:${path.join(root, 'clip.mp4')}`));

        const remote = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: timeline('https://example.com/clip.mp4'), outputPath: 'out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(remote.status, 200);
        assert.ok(remote.json.ffmpegCommand.includes('https://example.com/clip.mp4'));
    });

    test('a timeline with no duration is measured from its clips, and one with nothing to measure is refused (422)', async () => {
        const measured = await invokeRouter(router, 'POST', '/filtergraph', { body: { timeline: { ...timeline(), duration: 0 } } });
        assert.strictEqual(measured.status, 200);
        assert.strictEqual(measured.json.graph.durationSec, 2);
        const empty = { ...timeline(), duration: 0, tracks: [] };
        const graph = await invokeRouter(router, 'POST', '/filtergraph', { body: { timeline: empty } });
        assert.strictEqual(graph.status, 422);
        assert.strictEqual(graph.json.code, 'missing_input');
        const composite = await invokeRouter(router, 'POST', '/composite', {
            body: { timeline: empty, outputPath: 'out.mp4', workspaceRoot: root, dryRun: true }
        });
        assert.strictEqual(composite.status, 422);
        assert.match(composite.json.error, /video composite needs timeline\.duration/);
    });

    test('filtergraph strings cannot be smuggled through ids or numeric fields', () => {
        const svc = new HeadlessVideoCompositorService();
        const evil: any = timeline();
        evil.tracks[0].elements[0].id = 'x];movie=/etc/passwd[y';
        evil.tracks[0].elements[0].startTime = '0);movie=/etc/passwd;(';
        evil.tracks[0].elements[0].keying = { enabled: true, keyColor: 'a;b[c]' };
        const { filterComplex } = svc.buildFilterGraph(evil, { width: 640, height: 360 });
        assert.ok(!filterComplex.includes('movie='));
        assert.ok(filterComplex.includes('chromakey=color=0x00FF00'));
    });
});

describe('serve_public.js origin / host / path hardening', () => {
    let child: ChildProcess;
    let port: number;
    let started = false;

    beforeAll(async () => {
        port = await freePort();
        child = spawn(process.execPath, [path.join(REPO_ROOT, 'scripts/serve_public.js'), String(port)], {
            cwd: REPO_ROOT,
            env: { ...process.env, SERVE_PUBLIC_SKIP_HYDRATE: '1', SCRATCHBOX_ALLOWED_ORIGINS: '', SERVE_PUBLIC_ALLOWED_ORIGINS: '', SERVE_PUBLIC_ALLOWED_HOSTS: '' },
            stdio: 'ignore'
        });
        started = await waitForPort(port, child);
    }, 20000);
    afterAll(() => { child?.kill(); });

    test('server starts', () => {
        assert.ok(started, 'serve_public.js did not start');
    });

    test('foreign Origin is rejected and never receives the Maps key', async () => {
        const res = await rawRequest(port, { path: '/api/google_maps_config', headers: { Origin: 'https://evil.example' } });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
        assert.ok(!res.body.includes('apiKey'));
    });

    test('same-origin requests work and only loopback origins are echoed', async () => {
        const plain = await rawRequest(port, { path: '/api/google_maps_config' });
        assert.strictEqual(plain.status, 200);
        assert.strictEqual(plain.headers['access-control-allow-origin'], undefined);
        assert.strictEqual(plain.headers['access-control-allow-private-network'], undefined);
        const self = await rawRequest(port, { path: '/api/google_maps_config', headers: { Origin: `http://localhost:${port}` } });
        assert.strictEqual(self.status, 200);
        assert.strictEqual(self.headers['access-control-allow-origin'], `http://localhost:${port}`);
    });

    test('non-loopback Host (DNS rebinding) is rejected', async () => {
        const res = await rawRequest(port, { path: '/api/google_maps_config', headers: { Host: `attacker.example:${port}` } });
        assert.strictEqual(res.status, 421);
    });

    test('cross-site subresource loads of API routes are rejected', async () => {
        const res = await rawRequest(port, { path: '/api/google_maps_config', headers: { 'Sec-Fetch-Site': 'cross-site' } });
        assert.strictEqual(res.status, 403);
    });

    test('text/plain "simple" POSTs to API routes are rejected', async () => {
        const res = await rawRequest(port, {
            method: 'POST',
            path: '/api/3d/tiles/restructure',
            headers: { 'Content-Type': 'text/plain' },
            body: JSON.stringify({ prompt: 'x' })
        });
        assert.strictEqual(res.status, 415);
    });

    test('landmark path traversal is rejected', async () => {
        const res = await rawRequest(port, {
            method: 'POST',
            path: '/api/3dgs/run-pipeline',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ landmark: '../../../tmp/sb_pwn' })
        });
        // 400 when the native binary exists; 500 "binary not found" happens before any write otherwise.
        assert.ok(res.status === 400 || /binary not found/.test(res.body), `unexpected ${res.status} ${res.body}`);
        assert.ok(!fs.existsSync(path.resolve(REPO_ROOT, 'public', '../../../tmp/sb_pwn')));
    });

    test('the tile restructure route is gone (the feature was a keyword-driven taxonomy and is deleted)', async () => {
        const res = await rawRequest(port, {
            method: 'POST',
            path: '/api/3d/tiles/restructure',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ inputGlb: '../package.json' })
        });
        assert.strictEqual(res.status, 404);
    });

    test('404 page escapes the reflected request path', async () => {
        const res = await rawRequest(port, { path: '/nope%3Cscript%3Ealert(1)%3C/script%3E' });
        assert.strictEqual(res.status, 404);
        assert.ok(!res.body.includes('<script>alert(1)'));
    });
});

describe('vertex_proxy.mjs auth and model validation', () => {
    let child: ChildProcess;
    let port: number;
    let started = false;
    const token = 'test-proxy-token-123456';

    let sandbox: string;

    beforeAll(async () => {
        // The proxy reads <script dir>/../.env, so run a copy against a fake service account:
        // no request here ever reaches Google (auth/model checks happen before token minting).
        sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-vertex-proxy-')));
        await fs.ensureDir(path.join(sandbox, 'scripts'));
        await fs.copy(path.join(REPO_ROOT, 'scripts/vertex_proxy.mjs'), path.join(sandbox, 'scripts/vertex_proxy.mjs'));
        await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'));
        const fakeCreds = { type: 'service_account', project_id: 'fake-proj', client_email: 'x@fake-proj.iam.gserviceaccount.com', private_key: 'fake' };
        await fs.writeFile(path.join(sandbox, '.env'), `GOOGLE_SERVICE_ACCOUNT_JSON=${JSON.stringify(fakeCreds)}\n`);
        port = await freePort();
        child = spawn(process.execPath, [path.join(sandbox, 'scripts/vertex_proxy.mjs')], {
            cwd: sandbox,
            env: { ...process.env, VERTEX_PROXY_PORT: String(port), VERTEX_PROXY_TOKEN: token },
            stdio: 'ignore'
        });
        started = await waitForPort(port, child);
    }, 20000);
    afterAll(async () => {
        child?.kill();
        if (sandbox) await fs.remove(sandbox);
    });

    test('requires the proxy token and rejects path-injecting model ids', async () => {
        assert.ok(started, 'vertex_proxy.mjs did not start');
        const unauth = await rawRequest(port, { path: '/v1/models' });
        assert.strictEqual(unauth.status, 401);
        assert.strictEqual(unauth.headers['access-control-allow-origin'], undefined);

        const wrong = await rawRequest(port, { path: '/v1/models', headers: { Authorization: 'Bearer nope' } });
        assert.strictEqual(wrong.status, 401);

        const ok = await rawRequest(port, { path: '/v1/models', headers: { Authorization: `Bearer ${token}` } });
        assert.strictEqual(ok.status, 200);

        for (const model of ['claude-x/../../../endpoints/1:predict', 'claude-3?alt=x', 'claude..x']) {
            const bad = await rawRequest(port, {
                method: 'POST',
                path: '/v1/chat/completions',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, stream: false, messages: [{ role: 'user', content: 'hi' }] })
            });
            assert.strictEqual(bad.status, 400, `model ${model} should be rejected`);
        }
    });
});
