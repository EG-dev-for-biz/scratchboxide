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
import { ChildProcess, spawn } from 'child_process';
import { afterAll, beforeAll, describe, test } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECRET_MARKER = 'FAKE-SECRET-serve-public-cjs-do-not-serve';

/** Raw HTTP request: Node's client sends the path verbatim, so `../` reaches the server un-normalized. */
function rawRequest(port: number, opts: { path: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: opts.path, headers: opts.headers }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function write(root: string, rel: string, content: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function assertBlocked(res: { status: number; body: string }, label: string): void {
    assert.ok(res.status === 403 || res.status === 404, `${label}: expected 403/404, got ${res.status}`);
    assert.ok(!res.body.includes(SECRET_MARKER), `${label}: response leaked secret content`);
}

// Runs a copy of scripts/serve_public.cjs inside a temp repo layout whose secrets are fakes,
// so the real secrets.json / .env are never read.
describe('serve_public.cjs path containment and CORS', () => {
    let root: string;
    let child: ChildProcess;
    let port = 0;

    beforeAll(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-cjs-')));
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'serve_public.cjs'), path.join(root, 'scripts', 'serve_public.cjs'));
        write(root, 'secrets.json', JSON.stringify({ apiKey: SECRET_MARKER }));
        write(root, '.env', `GEMINI_API_KEY=${SECRET_MARKER}\n`);
        write(root, 'service-account.json', JSON.stringify({ private_key: SECRET_MARKER }));
        write(root, 'package.json', JSON.stringify({ name: SECRET_MARKER }));
        write(root, 'node_modules/three/build/three.module.js', 'export const REVISION = "test";\n');
        write(root, 'node_modules/three/.env', `KEY=${SECRET_MARKER}\n`);
        write(root, 'node_modules/other-pkg/index.js', `export const x = "${SECRET_MARKER}";\n`);
        write(root, 'docs/screenshots/proof.png', 'png-bytes');
        write(root, 'docs/notes.md', SECRET_MARKER);
        write(root, 'public/index.html', '<!doctype html><title>hub</title>');
        write(root, 'public/demos/showcase/some_demo.html', '<!doctype html><title>demo</title>');
        write(root, 'public/tilesets/jobs/rerun-abc123-def45.json', JSON.stringify({ id: 'rerun-abc123-def45', status: 'running' }));

        child = spawn(process.execPath, [path.join(root, 'scripts', 'serve_public.cjs')], {
            cwd: root,
            env: { PATH: process.env.PATH || '', PORT: '0' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        port = await new Promise<number>((resolve, reject) => {
            let out = '';
            const timer = setTimeout(() => reject(new Error(`serve_public.cjs did not report a port: ${out}`)), 15000);
            child.stdout!.on('data', chunk => {
                out += chunk;
                const m = out.match(/Running at http:\/\/127\.0\.0\.1:(\d+)\//);
                if (m) { clearTimeout(timer); resolve(Number(m[1])); }
            });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`serve_public.cjs exited (${code}): ${out}`)); });
        });
    }, 20000);

    afterAll(() => {
        child?.kill();
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    test('binds an ephemeral port when PORT=0', () => {
        assert.ok(port > 0);
    });

    test('repo-root secrets and dotfiles are not served', async () => {
        for (const p of ['/secrets.json', '/.env', '/service-account.json', '/package.json', '/docs/notes.md',
            '/node_modules/three/.env', '/node_modules/other-pkg/index.js']) {
            assertBlocked(await rawRequest(port, { path: p }), p);
        }
    });

    test('raw and encoded ../ traversal cannot escape public/', async () => {
        for (const p of ['/../secrets.json', '/../../secrets.json', '/%2e%2e/secrets.json', '/demos/../../secrets.json',
            '/..%2fsecrets.json', '/public/../secrets.json']) {
            assertBlocked(await rawRequest(port, { path: p }), p);
        }
    });

    test('survey job ids are validated', async () => {
        for (const p of ['/api/3d/survey/jobs/..%2f..%2f..%2fsecrets', '/api/3d/survey/jobs/../../../secrets',
            '/api/3d/survey/jobs/%2e%2e/%2e%2e/%2e%2e/secrets']) {
            assertBlocked(await rawRequest(port, { path: p }), p);
        }
        const ok = await rawRequest(port, { path: '/api/3d/survey/jobs/rerun-abc123-def45' });
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(JSON.parse(ok.body).job.id, 'rerun-abc123-def45');
    });

    test('public/ files and the allowlisted repo-root directories still load', async () => {
        assert.strictEqual((await rawRequest(port, { path: '/' })).status, 200);
        assert.strictEqual((await rawRequest(port, { path: '/some_demo' })).status, 200);
        assert.strictEqual((await rawRequest(port, { path: '/public/index.html' })).status, 200);
        assert.strictEqual((await rawRequest(port, { path: '/docs/screenshots/proof.png' })).status, 200);
        const three = await rawRequest(port, { path: '/node_modules/three/build/three.module.js' });
        assert.strictEqual(three.status, 200);
        assert.ok(three.body.includes('REVISION'));
    });

    test('CORS is echoed only for this server\'s loopback origins', async () => {
        const plain = await rawRequest(port, { path: '/index.html' });
        assert.strictEqual(plain.headers['access-control-allow-origin'], undefined);
        const foreign = await rawRequest(port, { path: '/index.html', headers: { Origin: 'https://evil.example' } });
        assert.strictEqual(foreign.headers['access-control-allow-origin'], undefined);
        const otherPort = await rawRequest(port, { path: '/index.html', headers: { Origin: `http://localhost:${port + 1}` } });
        assert.strictEqual(otherPort.headers['access-control-allow-origin'], undefined);
        const self = await rawRequest(port, { path: '/index.html', headers: { Origin: `http://localhost:${port}` } });
        assert.strictEqual(self.headers['access-control-allow-origin'], `http://localhost:${port}`);
    });

    test('a malformed URL gets 400 and the server keeps running', async () => {
        assert.strictEqual((await rawRequest(port, { path: '/%E0%A4%A' })).status, 400);
        assert.strictEqual((await rawRequest(port, { path: '/index.html' })).status, 200);
    });
});
