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

// POST /api/geobox/resect runs the real GeoBoxPrecisionResectionService, loaded both ways serve_public.cjs loads it:
// from the TypeScript source through ts-node (a dev checkout) and from the CommonJS that `npm run build:serve-public`
// compiles (Dockerfile.inference). Google Places and the Elevation API are answered by a fetch stub preloaded into the server process, so no
// billed call is made; the stub logs every URL it is asked for.

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FAKE_KEY = 'FAKE-MAPS-KEY-serve-public-geobox';
const PLACE = { name: 'Test Plaza', address: '1 Test Plaza, New York', lat: 40.7645, lng: -73.9744, ground: 18.25 };

interface RawResponse { status: number; body: string; json: any }

function postRaw(port: number, body: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, method: 'POST', path: '/api/geobox/resect',
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }
        }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let json: any;
                try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode || 0, body: text, json });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

const post = (port: number, payload: unknown) => postRaw(port, JSON.stringify(payload));

function getJson(port: number, route: string): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: route }, res => {
            let text = '';
            res.on('data', c => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode || 0, body: text, json: JSON.parse(text) }));
        }).on('error', reject);
    });
}

describe.each(['ts-node source', 'build:serve-public output'])('serve_public.cjs /api/geobox/resect runs GeoBoxPrecisionResectionService (%s)', mode => {
    let root: string;
    let child: ChildProcess;
    let port = 0;
    let fetchLog: string;
    let stderr = '';

    const fetchedUrls = (): string[] => fs.existsSync(fetchLog) ? fs.readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean) : [];

    beforeAll(async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-geobox-')));
        fs.mkdirSync(path.join(root, 'scripts'));
        fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'serve_public.cjs'), path.join(root, 'scripts', 'serve_public.cjs'));
        fs.mkdirSync(path.join(root, 'packages', 'core'), { recursive: true });
        fs.symlinkSync(path.join(REPO_ROOT, 'packages', 'core', 'src'), path.join(root, 'packages', 'core', 'src'));
        fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));
        if (mode === 'build:serve-public output') {
            fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(root, 'package.json'));
            execFileSync('npm', ['run', '-s', 'build:serve-public'], { cwd: root, stdio: 'pipe' });
            // The compiled modules need no npm packages: without node_modules (as in the image) they still load.
            fs.unlinkSync(path.join(root, 'node_modules'));
            assert.ok(fs.existsSync(path.join(root, 'build/serve-public-core/node/spatial/GeoBoxPrecisionResectionService.js')));
        }
        fs.mkdirSync(path.join(root, 'public', 'test_images'), { recursive: true });
        fs.writeFileSync(path.join(root, 'public', 'test_images', 'plaza.jpg'), 'jpg-bytes');

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

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-serve-public-geobox-home-'));
        child = spawn(process.execPath, ['--require', stub, path.join(root, 'scripts', 'serve_public.cjs')], {
            cwd: root,
            env: { PATH: process.env.PATH || '', HOME: home, PORT: '0', GOOGLE_MAPS_API_KEY: FAKE_KEY },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        child.stderr!.on('data', c => { stderr += c; });
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
    }, 60000);

    afterAll(() => {
        child?.kill();
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    test('health reports the resection server', async () => {
        const res = await getJson(port, '/api/geobox/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.json.status, 'ok');
    });

    test('a place name with a stated heading, pitch and standoff resolves through Places and Elevation', async () => {
        const res = await post(port, {
            hint: 'Test Plaza', imagePath: '/test_images/plaza.jpg',
            headingDeg: 200, pitchDeg: -10, standoffDistanceMeters: 120, extract3DTiles: false
        });
        assert.strictEqual(res.status, 200, res.body + stderr);
        const r = res.json.result;
        assert.strictEqual(res.json.success, true);
        assert.strictEqual(res.json.uploadUrl, '/test_images/plaza.jpg');
        assert.strictEqual(r.landmark.resolvedFrom, 'google_places');
        assert.ok(r.landmark.name.includes(PLACE.name) || r.landmark.name.includes(PLACE.address), r.landmark.name);
        assert.strictEqual(r.landmark.coordinates.lat, PLACE.lat);
        assert.strictEqual(r.landmark.coordinates.lng, PLACE.lng);
        assert.strictEqual(r.cameraOpticalCenter.groundElevationMeters, PLACE.ground);
        assert.strictEqual(r.cameraOpticalCenter.standoffDistanceMeters, 120);
        // Looking down 10 degrees from 120 m back: the camera is 120 sin(10 deg) above the target ground.
        assert.ok(Math.abs(r.cameraOpticalCenter.elevationMslMeters - (PLACE.ground + 120 * Math.sin(10 * Math.PI / 180))) < 0.05,
            String(r.cameraOpticalCenter.elevationMslMeters));
        // Heading 200 (looking south-southwest) puts the camera north-northeast of the target.
        assert.ok(r.cameraOpticalCenter.lat > PLACE.lat && r.cameraOpticalCenter.lng > PLACE.lng);
        assert.strictEqual(r.cameraAttitude.headingDeg, 200);
        assert.strictEqual(r.poseSource, 'stated heading, stated pitch and stated standoff distance');
        assert.strictEqual(r.imageAnalysed, false);
        assert.strictEqual(res.json.google_map_tiles_3d.heading, 200);
        assert.strictEqual(res.json.google_map_tiles_3d.tilt, 80);
        assert.strictEqual(res.json.three_d_object, null);
        assert.match(res.json.three_d_object_error, /extract3DTiles: false/);
        // Nothing the removed Python pipeline produced: no millimetre residuals, landmark dictionary or pano ids.
        assert.ok(!/_mm"|residual_mm|fallback_|metrology/i.test(res.body), res.body);

        const urls = fetchedUrls();
        assert.ok(urls.some(u => u.startsWith('https://places.googleapis.com/v1/places:searchText')), urls.join('\n'));
        assert.ok(urls.some(u => u.startsWith('https://maps.googleapis.com/maps/api/elevation/json?locations=40.7645,-73.9744')), urls.join('\n'));
        assert.ok(!fs.readFileSync(fetchLog, 'utf8').includes(FAKE_KEY));
    });

    test('point correspondences are resected with solvePnP and the focal length is reported as fixed', async () => {
        const points3D = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0], [0, 0, 0]];
        const focal = (26 / 36) * 1920;
        const points2D = points3D.map(([x, y]) => [960 + (x * focal) / 50, 540 + (y * focal) / 50]);
        const before = fetchedUrls().length;
        const res = await post(port, {
            targetCoords: { lat: 34.0522, lng: -118.2437, alt: 75 },
            points2D, points3D, imageWidthPx: 1920, imageHeightPx: 1080, sensorFocalMm: 26, extract3DTiles: false
        });
        assert.strictEqual(res.status, 200, res.body + stderr);
        const r = res.json.result;
        assert.strictEqual(r.landmark.resolvedFrom, 'targetCoords');
        assert.ok(Math.abs(r.cameraOpticalCenter.standoffDistanceMeters - 50) < 0.1, String(r.cameraOpticalCenter.standoffDistanceMeters));
        assert.match(r.poseSource, /^solvePnP from 5 point correspondences/);
        assert.match(r.poseSource, /focal length held fixed at 1386\.7 px from a 26 mm lens on a 36 mm sensor, not recovered/);
        assert.strictEqual(fetchedUrls().length, before, 'stated target coordinates and altitude need no Google call');
    });

    test('missing input is a typed 400', async () => {
        for (const [payload, arg] of [
            [{}, /targetCoords, targetLandmarkName or promptHint/],
            [{ imagePath: '/test_images/plaza.jpg' }, /targetCoords, targetLandmarkName or promptHint/],
            [{ targetCoords: { lat: 40.7645, lng: -73.9744, alt: 18 } }, /only the target location is known/],
            [{ targetCoords: { lat: 40.7645, lng: -73.9744, alt: 18 }, headingDeg: 90 }, /pitchDeg/],
            [{ targetCoords: { lat: 40.7645, lng: -73.9744, alt: 18 }, points2D: [[1, 1], [2, 2], [3, 3], [4, 4]], points3D: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] }, /imageWidthPx and imageHeightPx/]
        ] as Array<[Record<string, unknown>, RegExp]>) {
            const res = await post(port, payload);
            assert.strictEqual(res.status, 400, `${JSON.stringify(payload)}: ${res.body}`);
            assert.strictEqual(res.json.success, false);
            assert.strictEqual(res.json.code, 'missing_input');
            assert.match(res.json.error, arg);
            assert.strictEqual(res.json.result, undefined);
        }
        const bad = await postRaw(port, '{not json');
        assert.strictEqual(bad.status, 400);
        assert.strictEqual(bad.json.code, 'invalid_request');
    });

    test('a place that cannot be resolved is a typed 422', async () => {
        for (const payload of [
            { hint: 'Nowhere in particular', headingDeg: 10, pitchDeg: 0, standoffDistanceMeters: 50 },
            { targetCoords: { lat: 0, lng: 0, alt: 0 }, headingDeg: 10, pitchDeg: 0, standoffDistanceMeters: 50 },
            { targetCoords: { lat: 95, lng: 10, alt: 0 }, headingDeg: 10, pitchDeg: 0, standoffDistanceMeters: 50 }
        ]) {
            const res = await post(port, payload);
            assert.strictEqual(res.status, 422, `${JSON.stringify(payload)}: ${res.body}`);
            assert.strictEqual(res.json.success, false);
            assert.strictEqual(res.json.code, 'location_unresolved');
            assert.strictEqual(res.json.result, undefined);
        }
    });
});
