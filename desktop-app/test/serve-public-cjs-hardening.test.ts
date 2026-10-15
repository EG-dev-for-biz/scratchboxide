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
const ESCAPE_NAME = `sb-escape-${process.pid}-${Date.now().toString(36)}`;
const PLAZA_VIDEO = 'public/videos/plaza_hotel_omni_15s_720p.mp4';
const PLAZA_PHOTO = 'public/test_images/the_plaza_hotel_user_photo.jpg';

interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

/** Raw HTTP request: Node's client sends the path verbatim, so `../` reaches the server un-normalized. */
function rawRequest(port: number, opts: { path: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const headers = { ...opts.headers };
        if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
        const req = http.request({ host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end(opts.body);
    });
}

function postJson(port: number, route: string, payload: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
    return rawRequest(port, { path: route, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}

/** Minimal binary glTF: 12-byte header with the 'glTF' magic, version 2 and total length. */
function glbBytes(): Buffer {
    const buf = Buffer.alloc(20);
    buf.write('glTF', 0, 'ascii');
    buf.writeUInt32LE(2, 4);
    buf.writeUInt32LE(buf.length, 8);
    return buf;
}

function postGlb(port: number, file: string, body: Buffer | string = glbBytes(), contentType = 'model/gltf-binary'): Promise<RawResponse> {
    return rawRequest(port, { path: `/api/save_glb?file=${encodeURIComponent(file)}`, method: 'POST', headers: { 'Content-Type': contentType }, body });
}

function write(root: string, rel: string, content: string): void {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/** Executable Node script, so the server's execFile() can run it as ffmpeg / python. */
function writeExecutable(file: string, source: string): void {
    fs.writeFileSync(file, `#!${process.execPath}\n${source}`);
    fs.chmodSync(file, 0o755);
}

function readLog(file: string): string[][] {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Every file, directory and symlink under `root` except public/, with size and mtime for files. */
function snapshotOutsidePublic(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            const rel = path.relative(root, abs);
            if (rel === 'public') continue;
            const st = fs.lstatSync(abs);
            if (st.isDirectory()) {
                out.set(rel, 'dir');
                walk(abs);
            } else {
                out.set(rel, `${st.size}:${st.mtimeMs}`);
            }
        }
    };
    walk(root);
    return out;
}

function assertBlocked(res: { status: number; body: string }, label: string): void {
    assert.ok(res.status === 403 || res.status === 404, `${label}: expected 403/404, got ${res.status}`);
    assert.ok(!res.body.includes(SECRET_MARKER), `${label}: response leaked secret content`);
}

function assertRejected(res: RawResponse, status: number, label: string): void {
    assert.strictEqual(res.status, status, `${label}: expected ${status}, got ${res.status} ${res.body}`);
    assert.ok(!res.body.includes(SECRET_MARKER), `${label}: response leaked secret content`);
}

// Runs a copy of scripts/serve_public.cjs inside a temp repo layout whose secrets are fakes,
// so the real secrets.json / .env are never read. ffmpeg, the GeoBox Python pipeline and the
// compiled PhotometricUsdBridgeService are stand-ins that log which file they were handed.
describe('serve_public.cjs path containment and CORS', () => {
    let root: string;
    let toolsDir: string;
    let child: ChildProcess;
    let port = 0;
    let baseline: Map<string, string>;
    let ffmpegLog: string;
    let pythonLog: string;
    let usdLog: string;

    const realPublic = (rel: string): string => fs.realpathSync(path.join(root, rel));

    function assertNothingWrittenOutsidePublic(label: string): void {
        assert.deepStrictEqual(snapshotOutsidePublic(root), baseline, `${label}: files outside public/ changed`);
        for (const ext of ['.glb', '.usda', '.mtlx']) {
            assert.ok(!fs.existsSync(path.join(path.dirname(root), ESCAPE_NAME + ext)), `${label}: wrote ${ESCAPE_NAME}${ext} beside the repo`);
        }
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8')).apiKey, SECRET_MARKER);
    }

    beforeAll(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-cjs-')));
        toolsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-cjs-tools-')));
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'serve_public.cjs'), path.join(root, 'scripts', 'serve_public.cjs'));
        write(root, 'secrets.json', JSON.stringify({ apiKey: SECRET_MARKER }));
        write(root, '.env', `GEMINI_API_KEY=${SECRET_MARKER}\n`);
        write(root, 'service-account.json', JSON.stringify({ private_key: SECRET_MARKER }));
        write(root, 'package.json', JSON.stringify({ name: SECRET_MARKER }));
        write(root, 'outside.mp4', SECRET_MARKER);
        write(root, 'node_modules/three/build/three.module.js', 'export const REVISION = "test";\n');
        write(root, 'node_modules/three/.env', `KEY=${SECRET_MARKER}\n`);
        write(root, 'node_modules/other-pkg/index.js', `export const x = "${SECRET_MARKER}";\n`);
        write(root, 'docs/screenshots/proof.png', 'png-bytes');
        write(root, 'docs/notes.md', SECRET_MARKER);
        write(root, 'public/index.html', '<!doctype html><title>hub</title>');
        write(root, 'public/demos/showcase/some_demo.html', '<!doctype html><title>demo</title>');
        write(root, 'public/tilesets/jobs/rerun-abc123-def45.json', JSON.stringify({ id: 'rerun-abc123-def45', status: 'running' }));
        write(root, PLAZA_VIDEO, 'mp4-bytes');
        write(root, PLAZA_PHOTO, 'jpg-bytes');
        write(root, 'public/uploads/pipeline_frame.jpg', 'jpg-bytes');
        // Symlinks inside public/ that point back out of it.
        fs.symlinkSync(path.join(root, 'outside.mp4'), path.join(root, 'public/videos/linked_outside.mp4'));
        fs.mkdirSync(path.join(root, 'public/models'), { recursive: true });
        fs.mkdirSync(path.join(root, 'public/tiles'), { recursive: true });
        fs.mkdirSync(path.join(root, 'outside_dir'));
        fs.symlinkSync(path.join(root, 'linked_target.glb'), path.join(root, 'public/models/linked.glb'));
        fs.symlinkSync(path.join(root, 'outside_dir'), path.join(root, 'public/tiles/linked_dir'));

        ffmpegLog = path.join(toolsDir, 'ffmpeg.log');
        pythonLog = path.join(toolsDir, 'python.log');
        usdLog = path.join(toolsDir, 'usd.log');
        writeExecutable(path.join(toolsDir, 'ffmpeg'), [
            `const fs = require('fs');`,
            `const args = process.argv.slice(2);`,
            `fs.appendFileSync(${JSON.stringify(ffmpegLog)}, JSON.stringify(args) + '\\n');`,
            `fs.writeFileSync(args[args.length - 1], 'fake-ffmpeg-output');`
        ].join('\n'));
        writeExecutable(path.join(toolsDir, 'python'), [
            `const fs = require('fs');`,
            `const args = process.argv.slice(2);`,
            `fs.appendFileSync(${JSON.stringify(pythonLog)}, JSON.stringify(args) + '\\n');`,
            `process.stdout.write('---GEOBOX_JSON_START---' + JSON.stringify({ stage: 'fake' }) + '---GEOBOX_JSON_END---');`
        ].join('\n'));
        write(root, 'packages/core/dist/node/spatial/PhotometricUsdBridgeService.js', [
            `const fs = require('fs');`,
            `const path = require('path');`,
            `const log = ${JSON.stringify(usdLog)};`,
            `async function matchLightingToReference(opts) {`,
            `    fs.appendFileSync(log, JSON.stringify(['match', opts.imagePath]) + '\\n');`,
            `    return { success: true };`,
            `}`,
            `exports.matchLightingToReference = matchLightingToReference;`,
            `exports.matchImageAndLightingToLocation = matchLightingToReference;`,
            `exports.PhotometricUsdBridgeService = {`,
            `    exportToUsd(rig, options) {`,
            `        fs.appendFileSync(log, JSON.stringify(['export', options.outputPath]) + '\\n');`,
            `        fs.mkdirSync(path.dirname(options.outputPath), { recursive: true });`,
            `        fs.writeFileSync(options.outputPath, '#usda 1.0\\n');`,
            `        return { usdaFilePath: options.outputPath, usdaContent: '#usda 1.0\\n' };`,
            `    }`,
            `};`
        ].join('\n'));

        child = spawn(process.execPath, [path.join(root, 'scripts', 'serve_public.cjs')], {
            cwd: root,
            env: { PATH: process.env.PATH || '', PORT: '0', FFMPEG_PATH: path.join(toolsDir, 'ffmpeg'), PYTHON_BIN: path.join(toolsDir, 'python') },
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
        baseline = snapshotOutsidePublic(root);
    }, 20000);

    afterAll(() => {
        child?.kill();
        for (const dir of [root, toolsDir]) {
            if (dir) fs.rmSync(dir, { recursive: true, force: true });
        }
        for (const ext of ['.glb', '.usda', '.mtlx']) {
            if (root) fs.rmSync(path.join(path.dirname(root), ESCAPE_NAME + ext), { force: true });
        }
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

    test('a non-loopback Host header gets 421 (DNS rebinding)', async () => {
        for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`]) {
            assertRejected(await rawRequest(port, { path: '/index.html', headers: { Host: host } }), 421, `Host ${host}`);
        }
        assert.strictEqual((await rawRequest(port, { path: '/index.html', headers: { Host: `localhost:${port}` } })).status, 200);
        assert.strictEqual((await rawRequest(port, { path: '/index.html', headers: { Host: `127.0.0.1:${port}` } })).status, 200);
    });

    test('a foreign or null Origin gets 403; the server\'s own origin passes', async () => {
        for (const origin of ['https://evil.example', 'null', `http://localhost:${port + 1}`, `https://127.0.0.1:${port}`]) {
            assertRejected(await rawRequest(port, { path: '/index.html', headers: { Origin: origin } }), 403, `GET Origin ${origin}`);
            const res = await rawRequest(port, {
                path: '/api/save_glb?file=public%2Fmodels%2Forigin_probe.glb', method: 'POST',
                headers: { Origin: origin, 'Content-Type': 'model/gltf-binary' }, body: glbBytes()
            });
            assertRejected(res, 403, `POST Origin ${origin}`);
            assert.strictEqual(res.headers['access-control-allow-origin'], undefined);
        }
        assert.ok(!fs.existsSync(path.join(root, 'public/models/origin_probe.glb')), 'foreign-origin save_glb wrote a file');

        const own = await postGlb(port, 'public/models/origin_probe.glb');
        assert.strictEqual(own.status, 200);
        const ownWithOrigin = await rawRequest(port, {
            path: '/api/save_glb?file=public%2Fmodels%2Forigin_probe.glb', method: 'POST',
            headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'model/gltf-binary' }, body: glbBytes()
        });
        assert.strictEqual(ownWithOrigin.status, 200);
        assert.strictEqual(ownWithOrigin.headers['access-control-allow-origin'], `http://127.0.0.1:${port}`);
    });

    test('cross-site Sec-Fetch-Site requests to /api/ get 403', async () => {
        const job = '/api/3d/survey/jobs/rerun-abc123-def45';
        for (const site of ['cross-site', 'same-site']) {
            assertRejected(await rawRequest(port, { path: job, headers: { 'Sec-Fetch-Site': site } }), 403, `Sec-Fetch-Site ${site}`);
            assertRejected(await rawRequest(port, {
                path: '/api/save_glb?file=public%2Fmodels%2Fcross_site_probe.glb', method: 'POST',
                headers: { 'Sec-Fetch-Site': site, 'Content-Type': 'model/gltf-binary' }, body: glbBytes()
            }), 403, `POST Sec-Fetch-Site ${site}`);
        }
        assert.ok(!fs.existsSync(path.join(root, 'public/models/cross_site_probe.glb')), 'cross-site save_glb wrote a file');
        for (const site of ['same-origin', 'none']) {
            assert.strictEqual((await rawRequest(port, { path: job, headers: { 'Sec-Fetch-Site': site } })).status, 200, site);
        }
        // Static pages are not API routes and still load for cross-site navigations.
        assert.strictEqual((await rawRequest(port, { path: '/index.html', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200);
    });

    test('"simple" text/plain, form and untyped POSTs to /api/ get 415', async () => {
        const body = JSON.stringify({ rig: { lights: [] } });
        for (const contentType of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
            const headers: Record<string, string> = contentType ? { 'Content-Type': contentType } : {};
            assertRejected(await rawRequest(port, { path: '/api/lighting/export-usd', method: 'POST', headers, body }), 415, `export-usd ${contentType}`);
            assertRejected(await rawRequest(port, { path: '/api/3d/pbr/colosseum-recipe/rerun', method: 'POST', headers, body: '{}' }), 415, `recipe rerun ${contentType}`);
            assertRejected(await rawRequest(port, { path: '/api/save_glb?file=public%2Fmodels%2Fsimple_probe.glb', method: 'POST', headers, body: glbBytes() }), 415, `save_glb ${contentType}`);
        }
        assertRejected(await postGlb(port, 'public/models/simple_probe.glb', glbBytes(), 'application/json'), 415, 'save_glb application/json');
        assert.ok(!fs.existsSync(path.join(root, 'public/data/scene_lighting_export.usda')), 'a simple POST reached export-usd');
        assert.ok(!fs.existsSync(path.join(root, 'public/models/simple_probe.glb')), 'a simple POST reached save_glb');
        assert.deepStrictEqual(readLog(usdLog), []);
    });

    test('save_glb writes only .glb files under public/models or public/tiles', async () => {
        for (const file of [`../${ESCAPE_NAME}.glb`, `../../${ESCAPE_NAME}.glb`, 'secrets.json', `${ESCAPE_NAME}.glb`,
            path.join(root, `${ESCAPE_NAME}.glb`), path.join(root, 'public/models/absolute.glb'),
            'public/models/../../pwned.glb', 'public/models/../index.glb', 'public/index.glb', 'public/uploads/x.glb',
            'public/models/evil.html', 'public/models/model.glb.html', 'public/models/.hidden.glb', 'public/models/.git/x.glb',
            'public/models', 'public/models/linked.glb', 'public/tiles/linked_dir/x.glb', 'public/models/x.glb\0.html']) {
            assertRejected(await postGlb(port, file), 400, `save_glb ${file}`);
        }
        assertRejected(await postGlb(port, 'public/models/not_a_glb.glb', '<script>alert(1)</script>'), 400, 'non-glTF body');
        assert.ok(!fs.existsSync(path.join(root, 'public/models/not_a_glb.glb')));
        assert.ok(!fs.existsSync(path.join(root, 'linked_target.glb')), 'write followed a symlink out of public/models');
        assert.deepStrictEqual(fs.readdirSync(path.join(root, 'outside_dir')), [], 'write followed a symlinked directory');
        assertNothingWrittenOutsidePublic('save_glb');

        // The camera_space_visualizer demo posts its Blob (model/gltf-binary) to public/tiles/.
        const tile = await postGlb(port, 'public/tiles/camera_reprojected_orbit_yaw0.glb');
        assert.strictEqual(tile.status, 200, tile.body);
        assert.ok(fs.readFileSync(path.join(root, 'public/tiles/camera_reprojected_orbit_yaw0.glb')).equals(glbBytes()));
        const model = await postGlb(port, '/public/models/nested/esb_raw.glb', glbBytes(), 'application/octet-stream');
        assert.strictEqual(model.status, 200, model.body);
        assert.ok(fs.readFileSync(path.join(root, 'public/models/nested/esb_raw.glb')).equals(glbBytes()));
    });

    test('lighting export writes only .usda files under public/data', async () => {
        for (const outputPath of [`../${ESCAPE_NAME}.usda`, `${ESCAPE_NAME}.usda`, path.join(root, 'public/data/absolute.usda'),
            'public/outside.usda', 'public/models/rig.usda', 'public/data/../../outside.usda', 'public/data/evil.html',
            'public/data/.hidden.usda', 'scripts/serve_public.cjs']) {
            assertRejected(await postJson(port, '/api/lighting/export-usd', { rig: {}, outputPath }), 400, `export-usd ${outputPath}`);
        }
        assert.deepStrictEqual(readLog(usdLog), [], 'an escaping outputPath reached the exporter');
        assertNothingWrittenOutsidePublic('export-usd');

        // geobox_demo.html sends no outputPath; the default lands in public/data.
        const demo = await postJson(port, '/api/lighting/export-usd', { rig: {}, assetName: 'ThePlazaHotel' }, { Origin: `http://127.0.0.1:${port}` });
        assert.strictEqual(demo.status, 200, demo.body);
        assert.strictEqual(JSON.parse(demo.body).usdaUrl, '/data/scene_lighting_export.usda');
        assert.ok(fs.existsSync(path.join(root, 'public/data/scene_lighting_export.usda')));
        const custom = await postJson(port, '/api/lighting/export-usd', { rig: {}, outputPath: 'public/data/custom_rig.usda' });
        assert.strictEqual(custom.status, 200, custom.body);
        assert.ok(fs.existsSync(path.join(root, 'public/data/custom_rig.usda')));
    });

    test('video-branch routes read only videos inside public/', async () => {
        const escapes = [path.join(root, 'outside.mp4'), 'outside.mp4', '../outside.mp4', 'public/../outside.mp4', '/../outside.mp4',
            'videos/linked_outside.mp4', '/etc/hosts', 'secrets.json', { path: 'x' }];
        for (const route of ['/api/video-branch/extract-frame', '/api/video-branch/render-branch']) {
            for (const videoPath of escapes) {
                assertRejected(await postJson(port, route, { videoPath, timestampSec: 1, forkTimeSec: 1 }), 400, `${route} ${JSON.stringify(videoPath)}`);
            }
        }
        assert.deepStrictEqual(readLog(ffmpegLog), [], 'an escaping videoPath reached ffmpeg');
        assertNothingWrittenOutsidePublic('video-branch');

        const plaza = realPublic(PLAZA_VIDEO);
        // video_branching_studio.html sends the <video> src attribute (/videos/...).
        const frame = await postJson(port, '/api/video-branch/extract-frame', { videoPath: '/videos/plaza_hotel_omni_15s_720p.mp4', timestampSec: 2 });
        assert.strictEqual(frame.status, 200, frame.body);
        assert.ok(fs.existsSync(path.join(root, 'public', JSON.parse(frame.body).frameUrl)));
        // ...or its fallback, the repo-relative default.
        const branch = await postJson(port, '/api/video-branch/render-branch', { videoPath: PLAZA_VIDEO, forkTimeSec: 4, totalDurationSec: 15 });
        assert.strictEqual(branch.status, 200, branch.body);
        assert.ok(fs.existsSync(path.join(root, 'public', JSON.parse(branch.body).branchVideoUrl)));
        const defaulted = await postJson(port, '/api/video-branch/render-branch', {});
        assert.strictEqual(defaulted.status, 200, defaulted.body);

        const inputs = readLog(ffmpegLog).map(args => args[args.indexOf('-i') + 1]);
        assert.deepStrictEqual(inputs, [plaza, plaza, plaza]);
    });

    test('geobox resect reads media only inside public/', async () => {
        for (const field of ['imagePath', 'videoPath', 'mediaPath']) {
            for (const target of [path.join(root, 'secrets.json'), 'secrets.json', '../secrets.json', 'public/../secrets.json',
                path.join(root, 'outside.mp4'), 'videos/linked_outside.mp4', '/etc/hosts']) {
                assertRejected(await postJson(port, '/api/geobox/resect', { [field]: target }), 400, `resect ${field}=${target}`);
            }
        }
        assert.deepStrictEqual(readLog(pythonLog), [], 'an escaping media path reached the pipeline');
        assertNothingWrittenOutsidePublic('resect');

        // geobox_demo.html sample photo / sample video, and an absolute path the pipeline returned under public/uploads.
        const cases: Array<[Record<string, string>, string, string]> = [
            [{ imagePath: '/test_images/the_plaza_hotel_user_photo.jpg', hint: 'The Plaza Hotel' }, PLAZA_PHOTO, '/test_images/the_plaza_hotel_user_photo.jpg'],
            [{ videoPath: '/videos/plaza_hotel_omni_15s_720p.mp4' }, PLAZA_VIDEO, '/videos/plaza_hotel_omni_15s_720p.mp4'],
            [{ imagePath: path.join(root, 'public/uploads/pipeline_frame.jpg') }, 'public/uploads/pipeline_frame.jpg', '/uploads/pipeline_frame.jpg']
        ];
        for (const [payload, rel, url] of cases) {
            const res = await postJson(port, '/api/geobox/resect', payload);
            assert.strictEqual(res.status, 200, res.body);
            assert.strictEqual(JSON.parse(res.body).uploadUrl, url);
            const args = readLog(pythonLog).pop()!;
            assert.strictEqual(args[args.indexOf('--image') + 1], realPublic(rel));
        }
    }, 30000);

    test('lighting match-reference reads images only inside public/', async () => {
        for (const imagePath of [path.join(root, 'secrets.json'), 'secrets.json', '../secrets.json', 'public/../secrets.json',
            'test_images/../../secrets.json', path.join(root, 'outside.mp4'), 'videos/linked_outside.mp4', 'public/test_images/missing.jpg']) {
            assertRejected(await postJson(port, '/api/lighting/match-reference', { imagePath }), 400, `match-reference ${imagePath}`);
        }
        assert.deepStrictEqual(readLog(usdLog).filter(([kind]) => kind === 'match'), [], 'an escaping imagePath reached the matcher');
        assertNothingWrittenOutsidePublic('match-reference');

        // geobox_demo.html's default image, the pipeline's absolute image_path, and no imagePath at all.
        for (const [imagePath, rel, url] of [
            [PLAZA_PHOTO, PLAZA_PHOTO, '/test_images/the_plaza_hotel_user_photo.jpg'],
            [path.join(root, 'public/uploads/pipeline_frame.jpg'), 'public/uploads/pipeline_frame.jpg', '/uploads/pipeline_frame.jpg'],
            [undefined, PLAZA_PHOTO, '/test_images/the_plaza_hotel_user_photo.jpg']
        ] as Array<[string | undefined, string, string]>) {
            const res = await postJson(port, '/api/lighting/match-reference', { imagePath });
            assert.strictEqual(res.status, 200, res.body);
            assert.strictEqual(JSON.parse(res.body).imageRelUrl, url);
            assert.deepStrictEqual(readLog(usdLog).filter(([kind]) => kind === 'match').pop(), ['match', realPublic(rel)]);
        }
    });
});
