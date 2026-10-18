/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Visual regression gate for the walkable 3DGS viewer (public/demos/showcase/walkable_3dgs_viewer.html),
 * which renders splats with the app's own PhotorealGaussianSplatMesh.
 *
 * Renders the Red Rocks fused capture (public/tilesets/red_rocks/fused.splat, ~865k splats) in
 * headless Chrome and checks what the viewer itself must get right: it draws the capture (no void),
 * walking moves the view, and the crop box discards splats outside it. The capture is a survey
 * fusion of projected station images, so these checks are about the renderer, not photorealism.
 *
 * Screenshots are persisted to docs/screenshots/ as review artifacts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { spawn } from 'child_process';
import * as os from 'os';
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
        const HOLD_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        const server = http.createServer((req, res) => {
            const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
            if (urlPath === '/__hold') {
                // Deferred 1x1 GIF: keeps the page's load event pending for ?ms= milliseconds
                const ms = Math.min(60000, Math.max(0, Number(new URL(req.url || '/', 'http://x').searchParams.get('ms')) || 0));
                setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/gif' }); res.end(HOLD_GIF); }, ms);
                return;
            }
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

function captureHeadless(chrome: string, url: string, outPng: string, timeoutMs = 90000, realTime = false): Promise<void> {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
        // virtual-time-budget fast-forwards timers (fine for our single-threaded viewer); pages that
        // depend on Web Workers / WASM must wait in real time and defer `load` via the /__hold hook.
        const timing = realTime ? [`--timeout=${timeoutMs - 5000}`] : ['--virtual-time-budget=15000'];
        const tmpBase = path.join(REPO_ROOT, '.tmp_chrome_vis');
        fs.mkdirSync(tmpBase, { recursive: true });
        const tmpDir = fs.mkdtempSync(path.join(tmpBase, 'vis_'));
        const proc = spawn(chrome, [
            '--headless=new', '--hide-scrollbars', '--window-size=1920,1080',
            // Keychain-free: under an empty HOME (credential-guarded runs) Chrome otherwise blocks on the keychain.
            '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
            `--user-data-dir=${tmpDir}`,
            ...timing, `--screenshot=${outPng}`, url
        ], { stdio: 'ignore' });
        const cleanup = () => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        };
        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            cleanup();
            reject(new Error(`headless chrome timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Done once the screenshot exists and has stopped growing (sparse frames compress small).
        let lastSize = -1;
        const check = setInterval(() => {
            const size = fs.existsSync(outPng) ? fs.statSync(outPng).size : 0;
            const settled = size > 0 && size === lastSize;
            lastSize = size;
            if (settled) {
                clearInterval(check);
                clearTimeout(timer);
                proc.kill('SIGKILL');
                cleanup();
                resolve();
            }
        }, 500);
        proc.on('exit', () => {
            clearInterval(check);
            clearTimeout(timer);
            cleanup();
            fs.existsSync(outPng) ? resolve() : reject(new Error('headless chrome produced no screenshot'));
        });
        proc.on('error', (e) => {
            clearInterval(check);
            clearTimeout(timer);
            cleanup();
            reject(e);
        });
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

describe('Walkable 3DGS viewer: headless visual regression gate', () => {
    const chrome = findChrome();
    // public/ media is gitignored; the viewer bundle and the capture are built or fetched locally.
    const assetsPresent = fs.existsSync(path.join(PUBLIC_DIR, 'demos/showcase/walkable_3dgs_viewer.html'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'js/walkable_3dgs_viewer.js'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'tilesets/red_rocks/fused.splat'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'tilesets/red_rocks/tileset.meta.json'));
    const canRun = !!chrome && assetsPresent;
    let server: http.Server | null = null;
    let base = '';
    const BG = 22; // luminance of the viewer's clear colour #14171c

    beforeAll(async () => {
        if (!canRun) return;
        const s = await startStaticServer(PUBLIC_DIR);
        server = s.server;
        base = `http://127.0.0.1:${s.port}/demos/showcase/walkable_3dgs_viewer.html?hud=0&hold=12000`;
        fs.mkdirSync(SHOT_DIR, { recursive: true });
    });

    afterAll(async () => {
        if (server) await new Promise<void>(r => server!.close(() => r()));
    });

    const itIfReady = canRun ? it : it.skip;

    /** Fraction of pixels in the window that differ from the clear colour, i.e. drawn splats. */
    function coverage(img: Lum, x0: number, y0: number, x1: number, y1: number): number {
        let drawn = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (Math.abs(img.L[y * img.w + x] - BG) > 10) drawn++; n++; }
        return drawn / Math.max(1, n);
    }

    async function shoot(name: string, query: string): Promise<Lum> {
        const out = path.join(SHOT_DIR, name);
        await captureHeadless(chrome!, `${base}&${query}`, out, 90000, true);
        return toLuminance(fs.readFileSync(out));
    }

    const AERIAL = 'cam=-10,55,95&target=0,10,0';

    itIfReady('draws the capture from the aerial overview (no void, no NaN-collapsed columns)', async () => {
        const img = await shoot('50_walkable_3dgs_red_rocks_aerial.png', AERIAL);
        expect(img.w).toBe(1920);
        const cx0 = Math.floor(img.w * 0.3), cx1 = Math.floor(img.w * 0.7);
        const y0 = Math.floor(img.h * 0.3), y1 = Math.floor(img.h * 0.7);
        const cov = coverage(img, cx0, y0, cx1, y1);
        const mean = regionMean(img, cx0, y0, cx1, y1);
        const blackCols = blackColumnFraction(img, cx0, y0, cx1, y1);
        console.log(`[visual] aerial coverage=${cov.toFixed(3)} mean=${mean.toFixed(1)} blackCols=${blackCols.toFixed(4)}`);
        expect(cov).toBeGreaterThan(0.85);
        expect(mean).toBeGreaterThan(60);
        expect(blackCols).toBe(0);
    }, 120000);

    itIfReady('starts at the first capture station and walking moves the view', async () => {
        const station = await shoot('51_walkable_3dgs_red_rocks_station_1.png', 'station=1');
        const walked = await shoot('52_walkable_3dgs_red_rocks_walk_8m.png', 'station=1&walk=0,8');
        const upper = (img: Lum) => coverage(img, 0, 0, img.w, Math.floor(img.h * 0.6));
        let diff = 0, n = 0;
        for (let y = 0; y < station.h; y += 8) for (let x = 0; x < station.w; x += 8) { diff += Math.abs(station.L[y * station.w + x] - walked.L[y * walked.w + x]); n++; }
        console.log(`[visual] station coverage=${upper(station).toFixed(3)} walked coverage=${upper(walked).toFixed(3)} meanAbsDiff=${(diff / n).toFixed(2)}`);
        expect(upper(station)).toBeGreaterThan(0.25);
        expect(upper(walked)).toBeGreaterThan(0.25);
        expect(diff / n).toBeGreaterThan(5);
    }, 200000);

    itIfReady('the crop box discards splats outside it', async () => {
        const full = await shoot('50_walkable_3dgs_red_rocks_aerial.png', AERIAL);
        // Keep only x < -10 m: the right of the overview (positive x) must fall back to the clear colour.
        const cropped = await shoot('53_walkable_3dgs_red_rocks_crop.png', `${AERIAL}&crop=-80,-5,-80,-10,60,80`);
        const right = (img: Lum) => coverage(img, Math.floor(img.w * 0.6), Math.floor(img.h * 0.3), Math.floor(img.w * 0.85), Math.floor(img.h * 0.7));
        const left = (img: Lum) => coverage(img, Math.floor(img.w * 0.05), Math.floor(img.h * 0.3), Math.floor(img.w * 0.3), Math.floor(img.h * 0.7));
        console.log(`[visual] crop right ${right(full).toFixed(3)} -> ${right(cropped).toFixed(3)}, left ${left(full).toFixed(3)} -> ${left(cropped).toFixed(3)}`);
        expect(right(full)).toBeGreaterThan(0.5);
        expect(right(cropped)).toBeLessThan(0.02);
        expect(left(cropped)).toBeGreaterThan(0.2);
    }, 200000);

    it('sorts a capture-sized splat set within a 30 FPS frame budget', () => {
        // Radix bucket sort over the fused capture's splat count, as the viewer does per camera move.
        const count = 864933;
        const dists = new Float32Array(count);
        for (let i = 0; i < count; i++) dists[i] = (i * 1.618) % 300.0;
        const BUCKETS = 16384;
        const counts = new Uint32Array(BUCKETS);
        const starts = new Uint32Array(BUCKETS);
        const sortedIndices = new Int32Array(count);
        function radixSort() {
            counts.fill(0);
            let minDist = Infinity, maxDist = -Infinity;
            for (let i = 0; i < count; i++) { const d = dists[i]; if (d < minDist) minDist = d; if (d > maxDist) maxDist = d; }
            const normFactor = (BUCKETS - 1) / (maxDist - minDist || 1.0);
            for (let i = 0; i < count; i++) counts[((dists[i] - minDist) * normFactor) | 0]++;
            starts[BUCKETS - 1] = 0;
            for (let i = BUCKETS - 2; i >= 0; i--) starts[i] = starts[i + 1] + counts[i + 1];
            for (let i = 0; i < count; i++) sortedIndices[starts[((dists[i] - minDist) * normFactor) | 0]++] = i;
        }
        for (let w = 0; w < 3; w++) radixSort();
        const t0 = performance.now();
        radixSort();
        const sortDuration = performance.now() - t0;
        console.log(`[perf] ${count} splat sort: ${sortDuration.toFixed(2)}ms (budget 33.3ms)`);
        expect(sortDuration).toBeLessThan(33.3);
    });
});
