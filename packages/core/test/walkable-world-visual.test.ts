/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Visual regression gate for the panorama-to-3DGS viewer.
 *
 * Renders public/spatial_photoreal_3dgs_demo.html in headless Chrome (real GPU via ANGLE),
 * captures screenshots at the capture point and 1.25 m off-center, and asserts against the
 * exact defect classes found during visual review:
 *   - void / black viewport (asset failed to decode or shader NaN)
 *   - a missing splat column (atan(0,0) NaN artifact)
 *   - horizontal scanline gaps on the floor (missing foreshortening compensation)
 *   - pointillist wall (quad narrower than the Gaussian falloff)
 *
 * Screenshots are persisted to docs/screenshots/ as review artifacts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import { decodePng } from '../src/node/texture-processing';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const SHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots');

const CHROME_CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
].filter((p): p is string => !!p);

const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.spz': 'application/octet-stream',
    '.splat': 'application/octet-stream', '.glb': 'model/gltf-binary'
};

function findChrome(): string | null {
    return CHROME_CANDIDATES.find(p => fs.existsSync(p)) ?? null;
}

function startStaticServer(root: string): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
            const filePath = path.join(root, urlPath);
            if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
                res.writeHead(404); res.end('not found'); return;
            }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
        server.on('error', reject);
        // Ephemeral port avoids collisions with dev servers and concurrent test runs
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') return reject(new Error('no address'));
            resolve({ server, port: addr.port });
        });
    });
}

function captureHeadless(chrome: string, url: string, outPng: string, timeoutMs = 90000): Promise<void> {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
        const proc = spawn(chrome, [
            '--headless=new', '--hide-scrollbars', '--window-size=1920,1080',
            '--virtual-time-budget=15000', `--screenshot=${outPng}`, url
        ], { stdio: 'ignore' });
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`headless chrome timed out after ${timeoutMs}ms`)); }, timeoutMs);
        proc.on('exit', () => {
            clearTimeout(timer);
            fs.existsSync(outPng) ? resolve() : reject(new Error('headless chrome produced no screenshot'));
        });
        proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
}

interface Lum { w: number; h: number; L: Float32Array }

function toLuminance(png: Buffer): Lum {
    const dec = decodePng(png);
    const L = new Float32Array(dec.width * dec.height);
    for (let i = 0; i < L.length; i++) {
        L[i] = 0.299 * dec.rgba[i * 4] + 0.587 * dec.rgba[i * 4 + 1] + 0.114 * dec.rgba[i * 4 + 2];
    }
    return { w: dec.width, h: dec.height, L };
}

function regionMean(img: Lum, x0: number, y0: number, x1: number, y1: number): number {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += img.L[y * img.w + x]; n++; }
    return s / Math.max(1, n);
}

/** Fraction of columns in [x0,x1) that are near-black for > half the rows in [y0,y1). */
function blackColumnFraction(img: Lum, x0: number, y0: number, x1: number, y1: number): number {
    let bad = 0;
    for (let x = x0; x < x1; x++) {
        let dark = 0;
        for (let y = y0; y < y1; y++) if (img.L[y * img.w + x] < 8) dark++;
        if (dark > (y1 - y0) * 0.5) bad++;
    }
    return bad / Math.max(1, x1 - x0);
}

/**
 * Periodic-gap detector. Averages luminance along one axis to get a 1-D profile, removes the
 * low-frequency trend with a 15-tap box filter, and returns residual std / mean.
 *   axis 'y': row profile  -> horizontal scanline gaps on floors (missing foreshortening comp.)
 *   axis 'x': column profile -> pointillist splat columns on walls (quad narrower than falloff)
 * Calibration on real captures: scanline frame 0.15, dotted-wall frame 0.54, fixed frames <= 0.005.
 */
function periodicOscillation(img: Lum, x0: number, y0: number, x1: number, y1: number, axis: 'x' | 'y'): number {
    const n = axis === 'y' ? (y1 - y0) : (x1 - x0);
    const prof = new Float64Array(n);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            prof[axis === 'y' ? y - y0 : x - x0] += img.L[y * img.w + x];
        }
    }
    const per = axis === 'y' ? (x1 - x0) : (y1 - y0);
    let mean = 0;
    for (let i = 0; i < n; i++) { prof[i] /= per; mean += prof[i]; }
    mean /= n;
    const k = 15, half = 7;
    let sq = 0, m = 0;
    for (let i = k; i < n - k; i++) {
        let s = 0;
        for (let j = -half; j <= half; j++) s += prof[i + j];
        const r = prof[i] - s / k;
        sq += r * r; m++;
    }
    return Math.sqrt(sq / Math.max(1, m)) / Math.max(1.0, mean);
}

describe('Walkable 3DGS viewer: headless visual regression gate', () => {
    const chrome = findChrome();
    // public/ is gitignored in this repo; the viewer and its .spz assets are generated locally.
    const assetsPresent = fs.existsSync(path.join(PUBLIC_DIR, 'spatial_photoreal_3dgs_demo.html'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'models/pantheon_atrium_360.spz'));
    const canRun = !!chrome && assetsPresent;
    let server: http.Server | null = null;
    let base = '';

    beforeAll(async () => {
        if (!canRun) return;
        const s = await startStaticServer(PUBLIC_DIR);
        server = s.server;
        base = `http://127.0.0.1:${s.port}/spatial_photoreal_3dgs_demo.html`;
        fs.mkdirSync(SHOT_DIR, { recursive: true });
    });

    afterAll(async () => {
        if (server) await new Promise<void>(r => server!.close(() => r()));
    });

    const itIfChrome = canRun ? it : it.skip;

    itIfChrome('renders the capture-point view without void, missing columns, scanlines or pointillism', async () => {
        const out = path.join(SHOT_DIR, '28_walkable_3dgs_pantheon_capture_point.png');
        await captureHeadless(chrome!, `${base}?hud=0&lod=full`, out);
        const img = toLuminance(fs.readFileSync(out));
        expect(img.w).toBe(1920);

        // Analysis windows (fractions of frame): wall band above horizon, floor band below it
        const cx0 = Math.floor(img.w * 0.2), cx1 = Math.floor(img.w * 0.8);
        const wallY0 = Math.floor(img.h * 0.15), wallY1 = Math.floor(img.h * 0.45);
        const floorY0 = Math.floor(img.h * 0.62), floorY1 = Math.floor(img.h * 0.95);

        const wallMean = regionMean(img, cx0, wallY0, cx1, wallY1);
        const floorMean = regionMean(img, cx0, floorY0, cx1, floorY1);
        const blackCols = blackColumnFraction(img, cx0, wallY0, cx1, wallY1);
        const floorScanlines = periodicOscillation(img, cx0, floorY0, cx1, floorY1, 'y');
        const wallDots = periodicOscillation(img, cx0, wallY0, cx1, wallY1, 'x');

        console.log(`[visual] wallMean=${wallMean.toFixed(1)} floorMean=${floorMean.toFixed(1)} blackCols=${blackCols.toFixed(4)} floorRowOsc=${floorScanlines.toFixed(4)} wallColOsc=${wallDots.toFixed(4)}`);

        expect(wallMean).toBeGreaterThan(60);      // not a void and not a dark dotted wall (defect frame: 43)
        expect(floorMean).toBeGreaterThan(60);
        expect(blackCols).toBe(0);                  // no NaN-collapsed splat column (defect frame: 0.0063)
        expect(floorScanlines).toBeLessThan(0.02);  // no periodic row gaps (defect frame: 0.15)
        expect(wallDots).toBeLessThan(0.02);        // no pointillist columns (defect frame: 0.54)
    }, 120000);

    itIfChrome('renders a hole-free view 1.25 m off the capture point (disocclusion coverage)', async () => {
        const out = path.join(SHOT_DIR, '29_walkable_3dgs_pantheon_walk_1p25m.png');
        await captureHeadless(chrome!, `${base}?hud=0&lod=full&walk=1.25,0`, out);
        const img = toLuminance(fs.readFileSync(out));

        const cx0 = Math.floor(img.w * 0.2), cx1 = Math.floor(img.w * 0.8);
        const y0 = Math.floor(img.h * 0.15), y1 = Math.floor(img.h * 0.95);

        // Count near-black pixels in the central window: holes read as background clear color
        let dark = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = cx0; x < cx1; x++) { if (img.L[y * img.w + x] < 8) dark++; n++; }
        const holeFraction = dark / n;
        const floorScanlines = periodicOscillation(img, cx0, Math.floor(img.h * 0.62), cx1, y1, 'y');

        console.log(`[visual] walk holeFraction=${holeFraction.toFixed(5)} floorRowOsc=${floorScanlines.toFixed(4)}`);

        expect(holeFraction).toBeLessThan(0.002);
        expect(floorScanlines).toBeLessThan(0.02);
    }, 120000);
});
