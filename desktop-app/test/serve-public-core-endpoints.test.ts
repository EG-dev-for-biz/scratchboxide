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
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { afterAll, beforeAll, describe, test } from 'vitest';

// The /api/lighting/* endpoints of scripts/serve_public.cjs run the real PhotometricUsdBridgeService, loaded both
// ways serve_public.cjs loads core services: the TypeScript source through ts-node (a dev checkout) and the CommonJS
// that `npm run build:serve-public` compiles (Dockerfile.inference). The build case runs with packages/core/src and
// the repo node_modules removed, and only the two npm packages the image installs beside the build (three, jpeg-js),
// so nothing else can satisfy the load. Google Places is answered by a fetch stub preloaded into the server process,
// so no billed call is made. A second suite checks SERVE_PUBLIC_HOST and that a wide bind keeps the Host/Origin guard.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_KEY = 'FAKE-MAPS-KEY-serve-public-core';
const PLACE = { name: 'Test Plaza', address: '1 Test Plaza, New York', lat: 40.7645, lng: -73.9744, ground: 18.25 };
const PHOTO = 'public/test_images/the_plaza_hotel_user_photo.jpg';
// The capture the photometric suite uses for this photo: the sun comes from NOAA ephemeris at the stated place/time.
const CAPTURE = { geodeticCoords: { lat: 40.7646, lng: -73.9743 }, timestampIso: '2026-03-10T17:00:00Z', cameraHeadingDeg: 215.3, cameraPitchDeg: 5.2 };

interface RawResponse { status: number; body: string; json: any }

function request(port: number, opts: { method?: string; path: string; headers?: Record<string, string>; body?: string; host?: string }): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { ...opts.headers };
        if (opts.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(opts.body));
        const req = http.request({ host: opts.host || '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json: any;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode || 0, body: text, json });
            });
        });
        req.on('error', reject);
        req.end(opts.body);
    });
}

const post = (port: number, route: string, payload: unknown) =>
    request(port, { method: 'POST', path: route, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

/** Spawn serve_public.cjs and resolve with the address and port from its "Running at" line. */
function startServer(root: string, env: Record<string, string>, nodeArgs: string[] = []): Promise<{ child: ChildProcess; address: string; port: number; stderr: () => string }> {
    const child = spawn(process.execPath, [...nodeArgs, path.join(root, 'scripts', 'serve_public.cjs')], {
        cwd: root,
        env: { PATH: process.env.PATH || '', PORT: '0', ...env },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr!.on('data', c => { stderr += c; });
    return new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error(`serve_public.cjs did not report a port: ${out}${stderr}`)), 15000);
        child.stdout!.on('data', chunk => {
            out += chunk;
            const m = out.match(/Running at http:\/\/(\[[^\]]+\]|[^:/]+):(\d+)\//);
            if (m) { clearTimeout(timer); resolve({ child, address: m[1], port: Number(m[2]), stderr: () => stderr }); }
        });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`serve_public.cjs exited (${code}): ${out}${stderr}`)); });
    });
}

function makeRoot(prefix: string): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'serve_public.cjs'), path.join(root, 'scripts', 'serve_public.cjs'));
    return root;
}

const sampleRig = {
    rigId: 'rig_test', name: 'Test Rig', style: 'daylight', keyToFillRatio: 3.5, keyToFillStops: 1.8,
    ambientSphericalHarmonics: Array.from({ length: 9 }, (_, i) => (i === 0 ? [0.28, 0.32, 0.38] : [0, 0, 0])),
    lights: [
        { id: 'key_sun', name: 'Key', type: 'directional', role: 'key', position: [56, 100, 80], direction: [-0.35, -0.72, -0.59],
            cctKelvin: 5200, colorLinearRgb: [1, 0.92, 0.82], intensityLux: 82000, penumbraSoftness: 0.22, castShadow: true },
        { id: 'fill_sky', name: 'Fill', type: 'area_rect', role: 'fill', position: [-40, 50, -30], direction: [0.35, -0.65, 0.55],
            cctKelvin: 7200, colorLinearRgb: [0.72, 0.85, 1], intensityLux: 23400, penumbraSoftness: 0.95, castShadow: false }
    ]
};

describe.each(['ts-node source', 'build:serve-public output'])('serve_public.cjs /api/lighting/* run PhotometricUsdBridgeService (%s)', mode => {
    let root: string;
    let home: string;
    let server: Awaited<ReturnType<typeof startServer>>;
    let fetchLog: string;

    const fetchedUrls = (): string[] => fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean) : [];

    beforeAll(async () => {
        root = makeRoot('sb-serve-public-core-');
        fs.mkdirSync(path.join(root, 'packages', 'core'), { recursive: true });
        fs.symlinkSync(path.join(REPO_ROOT, 'packages', 'core', 'src'), path.join(root, 'packages', 'core', 'src'));
        fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
        if (mode === 'build:serve-public output') {
            fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
            execFileSync('npm', ['run', '-s', 'build:serve-public'], { cwd: root, stdio: 'pipe' });
            // As in the image: the compiled output with three and jpeg-js beside it, no source and no repo node_modules.
            const coreModules = path.join(root, 'build', 'serve-public-core', 'node_modules');
            fs.mkdirSync(coreModules, { recursive: true });
            for (const pkg of ['three', 'jpeg-js']) {
                fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, 'node_modules', pkg)), path.join(coreModules, pkg));
            }
            fs.unlinkSync(path.join(root, 'node_modules'));
            fs.unlinkSync(path.join(root, 'packages', 'core', 'src'));
            assert.ok(fs.existsSync(path.join(root, 'build/serve-public-core/node/spatial/PhotometricUsdBridgeService.js')));
        }
        fs.mkdirSync(path.join(root, path.dirname(PHOTO)), { recursive: true });
        fs.copyFileSync(path.join(REPO_ROOT, PHOTO), path.join(root, PHOTO));

        fetchLog = path.join(root, 'fetch.log');
        const stub = path.join(root, 'fetch-stub.cjs');
        fs.writeFileSync(stub, [
            `const fs = require('fs');`,
            `const PLACE = ${JSON.stringify(PLACE)};`,
            `const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });`,
            `globalThis.fetch = async (input, init) => {`,
            `    const url = String(input && input.url ? input.url : input);`,
            `    fs.appendFileSync(${JSON.stringify(fetchLog)}, url.replace(/key=[^&]*/, 'key=REDACTED') + '\\n');`,
            `    if (url.startsWith('https://places.googleapis.com/v1/places:searchText')) {`,
            `        const { textQuery } = JSON.parse(init.body);`,
            `        if (!/plaza/i.test(textQuery)) return json(200, {});`,
            `        return json(200, { places: [{ id: 'test-place', displayName: { text: PLACE.name }, formattedAddress: PLACE.address,`,
            `            location: { latitude: PLACE.lat, longitude: PLACE.lng }, userRatingCount: 10 }] });`,
            `    }`,
            `    if (url.startsWith('https://maps.googleapis.com/maps/api/elevation/json')) {`,
            `        return json(200, { status: 'OK', results: [{ elevation: PLACE.ground }] });`,
            `    }`,
            `    throw new Error('fetch-stub: unexpected request ' + url);`,
            `};`
        ].join('\n'));

        home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-core-home-'));
        server = await startServer(root, { HOME: home, GOOGLE_MAPS_API_KEY: FAKE_KEY }, ['--require', stub]);
    }, 90000);

    afterAll(() => {
        server?.child.kill();
        for (const dir of [root, home]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    test('match-reference solves the rig from the photo at the stated place and time and writes OpenUSD + MaterialX', async () => {
        const res = await post(server.port, '/api/lighting/match-reference', { imagePath: '/test_images/the_plaza_hotel_user_photo.jpg', ...CAPTURE });
        assert.strictEqual(res.status, 200, res.body + server.stderr());
        assert.strictEqual(res.json.success, true);
        assert.strictEqual(res.json.imageRelUrl, '/test_images/the_plaza_hotel_user_photo.jpg');
        assert.ok(res.json.rig.lights.length >= 2);
        const key = res.json.rig.lights.find((l: any) => l.role === 'key');
        assert.ok(key.cctKelvin > 2500 && key.cctKelvin < 9000, String(key.cctKelvin));
        assert.ok(res.json.rig.keyToFillRatio > 1);
        assert.match(res.json.summary, /noaa-ephemeris/);
        assert.strictEqual(res.json.usdDownloadUrl, '/data/matched_lighting_rig.usda');
        assert.strictEqual(res.json.mtlxDownloadUrl, '/data/matched_lighting_rig.mtlx');
        const usda = fs.readFileSync(path.join(root, 'public/data/matched_lighting_rig.usda'), 'utf8');
        assert.ok(usda.startsWith('#usda 1.0'), usda.slice(0, 40));
        assert.match(usda, /def UsdLuxDistantLight "/);
        assert.ok(usda.includes(`float inputs:colorTemperature = ${key.cctKelvin}`), 'the measured key CCT is in the USD');
        assert.match(fs.readFileSync(path.join(root, 'public/data/matched_lighting_rig.mtlx'), 'utf8'), /<materialx version="1\.38">/);
        assert.deepStrictEqual(fetchedUrls(), [], 'stated coordinates need no Google call');
    }, 60000);

    test('match-reference with a place name only resolves it through Google Places', async () => {
        const res = await post(server.port, '/api/lighting/match-reference', {
            imagePath: PHOTO, landmarkName: 'Test Plaza', timestampIso: CAPTURE.timestampIso
        });
        assert.strictEqual(res.status, 200, res.body + server.stderr());
        assert.strictEqual(res.json.location.coords.lat, PLACE.lat);
        assert.strictEqual(res.json.location.coords.lng, PLACE.lng);
        assert.ok(res.json.lightingRig.lights.length >= 2);
        assert.ok(fetchedUrls().some(u => u.startsWith('https://places.googleapis.com/v1/places:searchText')), fetchedUrls().join('\n'));
        assert.ok(!fs.readFileSync(fetchLog, 'utf8').includes(FAKE_KEY));
    }, 60000);

    test('match-reference without an image, or an unresolvable place, is a typed error', async () => {
        const none = await post(server.port, '/api/lighting/match-reference', { ...CAPTURE });
        assert.strictEqual(none.status, 400, none.body);
        assert.match(none.json.error, /imagePath .* or imageBase64 is required/);

        const nowhere = await post(server.port, '/api/lighting/match-reference', { imagePath: PHOTO, landmarkName: 'Nowhere in particular', timestampIso: CAPTURE.timestampIso });
        assert.strictEqual(nowhere.status, 422, nowhere.body);
        assert.strictEqual(nowhere.json.code, 'location_unresolved');
    }, 60000);

    test('export-usd writes the given rig as OpenUSD and MaterialX under public/data', async () => {
        const res = await post(server.port, '/api/lighting/export-usd', { rig: sampleRig, assetName: 'TestScene', outputPath: 'public/data/test_rig.usda' });
        assert.strictEqual(res.status, 200, res.body + server.stderr());
        assert.strictEqual(res.json.usdaUrl, '/data/test_rig.usda');
        assert.strictEqual(res.json.mtlxUrl, '/data/test_rig.mtlx');
        const usda = fs.readFileSync(path.join(root, 'public/data/test_rig.usda'), 'utf8');
        assert.strictEqual(usda, res.json.usdaContent);
        assert.match(usda, /def UsdLuxDistantLight "key_sun"/);
        assert.match(usda, /inputs:colorTemperature = 5200/);
        assert.match(usda, /def UsdLuxRectLight "fill_sky"/);
        assert.match(fs.readFileSync(path.join(root, 'public/data/test_rig.mtlx'), 'utf8'), /standard_surface/);

        const noRig = await post(server.port, '/api/lighting/export-usd', { assetName: 'TestScene' });
        assert.strictEqual(noRig.status, 400, noRig.body);
        assert.match(noRig.json.error, /rig with a lights array/);
    });

    test('the removed /api/geobox/calibrate route writes nothing', async () => {
        const res = await post(server.port, '/api/geobox/calibrate', { landmark: 'x', cameraPosition: [0, 0, 0] });
        assert.strictEqual(res.status, 404, res.body);
        assert.ok(!fs.existsSync(path.join(root, 'public/data/learned_resections.json')));
    });
});

describe('serve_public.cjs SERVE_PUBLIC_HOST', () => {
    let root: string;
    const servers: ChildProcess[] = [];

    /** A non-loopback IPv4 address of this machine, if it has one. */
    const lanAddress = (): string | undefined => Object.values(os.networkInterfaces()).flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)?.address;

    beforeAll(() => {
        root = makeRoot('sb-serve-public-host-');
        fs.mkdirSync(path.join(root, 'public'));
        fs.writeFileSync(path.join(root, 'public', 'index.html'), '<!doctype html><title>hub</title>');
    });

    afterAll(() => {
        for (const child of servers) child.kill();
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    test('defaults to loopback only', async () => {
        const s = await startServer(root, {});
        servers.push(s.child);
        assert.strictEqual(s.address, '127.0.0.1');
        const lan = lanAddress();
        if (lan) {
            await assert.rejects(request(s.port, { host: lan, path: '/api/geobox/health', headers: { Host: `127.0.0.1:${s.port}` } }), /ECONNREFUSED/);
        }
    });

    test('SERVE_PUBLIC_HOST=0.0.0.0 binds all interfaces and keeps the Host and Origin allowlists', async () => {
        const s = await startServer(root, { SERVE_PUBLIC_HOST: '0.0.0.0', SERVE_PUBLIC_ALLOWED_HOSTS: 'scratchbox.example.run.app' });
        servers.push(s.child);
        assert.strictEqual(s.address, '0.0.0.0');
        const health = (headers: Record<string, string>, host?: string) => request(s.port, { host, path: '/api/geobox/health', headers });

        assert.strictEqual((await health({ Host: `127.0.0.1:${s.port}` })).status, 200);
        assert.strictEqual((await health({ Host: `localhost:${s.port}` })).status, 200);
        assert.strictEqual((await health({ Host: 'scratchbox.example.run.app' })).status, 200);
        const lan = lanAddress();
        if (lan) {
            // Reachable on a non-loopback interface now; the Host header still decides admission.
            assert.strictEqual((await health({ Host: `127.0.0.1:${s.port}` }, lan)).status, 200);
            assert.strictEqual((await health({ Host: `${lan}:${s.port}` }, lan)).status, 421);
        }
        for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, `0.0.0.0:${s.port}`]) {
            assert.strictEqual((await health({ Host: host })).status, 421, host);
        }
        const foreign = await health({ Host: `127.0.0.1:${s.port}`, Origin: 'https://evil.example' });
        assert.strictEqual(foreign.status, 403);
        assert.strictEqual(foreign.json.error, 'Origin not allowed');
    });
});
