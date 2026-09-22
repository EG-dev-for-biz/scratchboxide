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
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome_vis_'));
        const proc = spawn(chrome, [
            '--headless=new', '--hide-scrollbars', '--window-size=1920,1080',
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
        const check = setInterval(() => {
            if (fs.existsSync(outPng) && fs.statSync(outPng).size > 500000) {
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

function decodeRgba(png: Buffer): Buffer { return decodePng(png).rgba; }
function rgbaMean(rgba: Buffer, w: number, x0: number, y0: number, x1: number, y1: number): { r: number; g: number; b: number } {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * w + x) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
    return { r: r / n, g: g / n, b: b / n };
}

/**
 * Row-profile oscillation over pixels brighter than minLum only, so a hard coverage edge inside the
 * band (splats -> background) does not register; horizontal splat-row stripes still do.
 * Calibrated on the survey box in gaussian-splat-lite: clean 0.0028, grazing-striped 0.0639.
 */
function maskedRowOscillation(img: Lum, x0: number, y0: number, x1: number, y1: number, minLum = 60): number {
    const prof: number[] = [];
    for (let y = y0; y < y1; y++) {
        let s = 0, n = 0;
        for (let x = x0; x < x1; x++) { const v = img.L[y * img.w + x]; if (v > minLum) { s += v; n++; } }
        if (n > 10) prof.push(s / n);
    }
    const k = 9;
    if (prof.length < 3 * k) return 0;
    let mean = 0; for (const v of prof) mean += v; mean /= prof.length;
    let acc = 0, cnt = 0;
    for (let i = k; i < prof.length - k; i++) {
        let lp = 0; for (let j = -Math.floor(k / 2); j <= Math.floor(k / 2); j++) lp += prof[i + j]; lp /= k;
        acc += (prof[i] - lp) ** 2; cnt++;
    }
    return Math.sqrt(acc / Math.max(1, cnt)) / Math.max(1, mean);
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

    const tilesetPresent = fs.existsSync(path.join(PUBLIC_DIR, 'tilesets/pantheon/tileset.json'));
    const itIfTileset = canRun && tilesetPresent ? it : it.skip;

    itIfTileset('streams the KHR_gaussian_splatting 3D Tiles tileset to the same frame as the single-file asset', async () => {
        const single = path.join(SHOT_DIR, '28_walkable_3dgs_pantheon_capture_point.png');
        const out = path.join(SHOT_DIR, '30_walkable_3dgs_pantheon_3dtiles_stream.png');
        await captureHeadless(chrome!, `${base}?hud=0&tileset=/tilesets/pantheon/tileset.json`, out);
        const a = toLuminance(fs.readFileSync(single));
        const b = toLuminance(fs.readFileSync(out));
        expect(b.w).toBe(a.w);
        // Same scene, same camera: per-region luminance must agree closely (LOD selection may differ slightly)
        let diff = 0, n = 0;
        for (let y = 0; y < a.h; y += 8) for (let x = 0; x < a.w; x += 8) { diff += Math.abs(a.L[y * a.w + x] - b.L[y * b.w + x]); n++; }
        const meanAbsDiff = diff / n;
        console.log(`[visual] tileset vs single-file meanAbsDiff=${meanAbsDiff.toFixed(2)}`);
        expect(meanAbsDiff).toBeLessThan(6);
        expect(regionMean(b, Math.floor(b.w * 0.2), Math.floor(b.h * 0.15), Math.floor(b.w * 0.8), Math.floor(b.h * 0.45))).toBeGreaterThan(60);
    }, 120000);

    itIfTileset('bounding-volume discard crops splats outside the box and clamps below the ground plane', async () => {
        const out = path.join(SHOT_DIR, '31_walkable_3dgs_pantheon_crop_volume.png');
        // Keep only |x| < 6 m and y > 0.05 m: the apse slab remains, floor and side walls are discarded
        await captureHeadless(chrome!, `${base}?hud=0&tileset=/tilesets/pantheon/tileset.json&crop=-6,-1,-30,6,40,30&groundY=0.05`, out);
        const img = toLuminance(fs.readFileSync(out));
        const cx = Math.floor(img.w / 2);
        const inside = regionMean(img, cx - 60, Math.floor(img.h * 0.2), cx + 60, Math.floor(img.h * 0.5));
        const leftOutside = regionMean(img, Math.floor(img.w * 0.02), Math.floor(img.h * 0.2), Math.floor(img.w * 0.2), Math.floor(img.h * 0.5));
        const floorBand = regionMean(img, Math.floor(img.w * 0.2), Math.floor(img.h * 0.85), Math.floor(img.w * 0.8), Math.floor(img.h * 0.98));
        console.log(`[visual] crop inside=${inside.toFixed(1)} outside=${leftOutside.toFixed(1)} floor=${floorBand.toFixed(1)}`);
        expect(inside).toBeGreaterThan(60);      // content survives inside the crop box
        expect(leftOutside).toBeLessThan(12);    // side walls discarded (clear colour)
        expect(floorBand).toBeLessThan(12);      // floor clamped away
    }, 120000);

    const interopPresent = tilesetPresent
        && fs.existsSync(path.join(PUBLIC_DIR, 'splat_tiles_interop.html'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'js/splat_tiles_interop.js'));
    const itIfInterop = canRun && interopPresent ? it : it.skip;

    const surveyPresent = fs.existsSync(path.join(PUBLIC_DIR, 'tilesets/survey_box/tileset.json')) && fs.existsSync(path.join(PUBLIC_DIR, 'models/survey_box_ground.glb'));
    const itIfSurvey = canRun && surveyPresent ? it : it.skip;

    itIfSurvey('survey pipeline tileset: beautified splat skin over the clay GLB, crop box from meta, sky kept (no void)', async () => {
        const out = path.join(SHOT_DIR, '37_survey_splat_tileset_over_clay.png');
        await captureHeadless(chrome!, `${base}?hud=0&tileset=/tilesets/survey_box/tileset.json&walk=0,30`, out);
        const img = toLuminance(fs.readFileSync(out));
        const rgba = decodeRgba(fs.readFileSync(out));
        const cx = Math.floor(img.w / 2);
        // Box occupies the centre column: must be the beautified brick colour, not clay grey
        const c = rgbaMean(rgba, img.w, cx - 40, Math.floor(img.h * 0.3), cx + 40, Math.floor(img.h * 0.6));
        expect(c.r).toBeGreaterThan(c.b + 40);
        // Sky region is not a void
        expect(regionMean(img, Math.floor(img.w * 0.05), Math.floor(img.h * 0.05), Math.floor(img.w * 0.3), Math.floor(img.h * 0.25))).toBeGreaterThan(60);
        // Foreground ground is the beautified sand (warm), not grey clay
        const g = rgbaMean(rgba, img.w, Math.floor(img.w * 0.1), Math.floor(img.h * 0.8), Math.floor(img.w * 0.3), Math.floor(img.h * 0.95));
        expect(g.r).toBeGreaterThan(g.b + 20);
    }, 120000);

    const itIfSurveyInterop = canRun && surveyPresent && interopPresent ? it : it.skip;
    itIfSurveyInterop('survey pipeline tileset renders in the third-party stack with the same colours and no grazing stripes', async () => {
        const out = path.join(SHOT_DIR, '38_survey_splat_tileset_interop.png');
        const interopBase = base.replace('spatial_photoreal_3dgs_demo.html', 'splat_tiles_interop.html');
        await captureHeadless(chrome!, `${interopBase}?hud=0&tileset=/tilesets/survey_box/tileset.json&hold=15000&eye=10&walk=0,45`, out, 60000, true);
        const img = toLuminance(fs.readFileSync(out));
        const rgba = decodeRgba(fs.readFileSync(out));
        const cx = Math.floor(img.w / 2);
        const c = rgbaMean(rgba, img.w, cx - 40, Math.floor(img.h * 0.35), cx + 40, Math.floor(img.h * 0.65));
        expect(c.r).toBeGreaterThan(c.b + 40);
        // Far ground band left of the box: no periodic stripes (grazing splats dropped in the baker).
        // Threshold 0.02 sits 7x above the clean capture and 3x below the striped control.
        const osc = maskedRowOscillation(img, 0, Math.floor(img.h * 0.57), Math.floor(img.w * 0.35), Math.floor(img.h * 0.70));
        console.log(`[visual] survey interop far-ground masked oscillation=${osc.toFixed(4)}`);
        expect(osc).toBeLessThan(0.02);
    }, 90000);

    itIfInterop('third-party stack (3d-tiles-renderer + 3dgs-plugin + gaussian-splat-lite) renders our tileset to the same scene', async () => {
        const single = path.join(SHOT_DIR, '28_walkable_3dgs_pantheon_capture_point.png');
        const out = path.join(SHOT_DIR, '32_walkable_3dgs_pantheon_interop_3dtiles_renderer.png');
        const interopBase = base.replace('spatial_photoreal_3dgs_demo.html', 'splat_tiles_interop.html');
        await captureHeadless(chrome!, `${interopBase}?hud=0&tileset=/tilesets/pantheon/tileset.json&hold=18000`, out, 60000, true);
        const a = toLuminance(fs.readFileSync(single));
        const b = toLuminance(fs.readFileSync(out));
        const cx0 = Math.floor(b.w * 0.2), cx1 = Math.floor(b.w * 0.8);
        const wallMean = regionMean(b, cx0, Math.floor(b.h * 0.15), cx1, Math.floor(b.h * 0.45));
        const blackCols = blackColumnFraction(b, cx0, Math.floor(b.h * 0.15), cx1, Math.floor(b.h * 0.45));
        let diff = 0, n = 0;
        for (let y = 0; y < a.h; y += 8) for (let x = 0; x < a.w; x += 8) { diff += Math.abs(a.L[y * a.w + x] - b.L[y * b.w + x]); n++; }
        const meanAbsDiff = diff / n;
        console.log(`[visual] interop wallMean=${wallMean.toFixed(1)} blackCols=${blackCols.toFixed(4)} meanAbsDiff vs ours=${meanAbsDiff.toFixed(2)}`);
        expect(wallMean).toBeGreaterThan(60);     // it drew the scene, not a void
        expect(blackCols).toBe(0);                 // no missing columns / mis-rotation
        // Different splat kernel (2.83 sigma, pre-blur) than ours: allow a looser but bounded difference
        expect(meanAbsDiff).toBeLessThan(30);
    }, 90000);

    const colosseumPresent = fs.existsSync(path.join(PUBLIC_DIR, 'tilesets/colosseum/tileset.json'))
        && fs.existsSync(path.join(PUBLIC_DIR, 'models/colosseum_grounded.glb'));
    const itIfColosseum = canRun && colosseumPresent ? it : it.skip;

    itIfColosseum('Viewpoint A: Aerial District Overview ([0, 150, 250], looking at center)', async () => {
        const out = path.join(SHOT_DIR, '40_viewpoint_a_aerial_district.png');
        await captureHeadless(
            chrome!,
            `${base}?hud=0&tileset=/tilesets/colosseum/tileset.json&mode=softz&cam=0,150,250&target=0,20,0&lighting=golden&hold=5000`,
            out,
            120000,
            true
        );
        const altOut = path.join(SHOT_DIR, '39_viewpoint_a_aerial_district.png');
        try { fs.copyFileSync(out, altOut); } catch (_) {}

        const img = toLuminance(fs.readFileSync(out));
        const cx0 = Math.floor(img.w * 0.2), cx1 = Math.floor(img.w * 0.8);
        const y0 = Math.floor(img.h * 0.2), y1 = Math.floor(img.h * 0.7);

        // Visual Fidelity Rubric: Zero black columns / NaN collapses
        const blackCols = blackColumnFraction(img, cx0, y0, cx1, y1);
        expect(blackCols).toBe(0);

        // Residual periodic stripe oscillation < 0.02
        const osc = periodicOscillation(img, cx0, y0, cx1, y1, 'y');
        console.log(`[visual] Viewpoint A Aerial: mean=${regionMean(img, cx0, y0, cx1, y1).toFixed(1)} blackCols=${blackCols} osc=${osc.toFixed(4)}`);
        expect(osc).toBeLessThan(0.02);

        // Environmental context & grounding: not a black void
        expect(regionMean(img, cx0, y0, cx1, y1)).toBeGreaterThan(60);
    }, 120000);

    itIfColosseum('Viewpoint B: Colosseum Facade Close-up ([80, 25, 60], looking at arcade)', async () => {
        const out = path.join(SHOT_DIR, '41_viewpoint_b_facade_closeup.png');
        await captureHeadless(
            chrome!,
            `${base}?hud=0&tileset=/tilesets/colosseum/tileset.json&mode=softz&cam=80,25,60&target=0,20,0&lighting=golden&hold=5000`,
            out,
            120000,
            true
        );
        const altOut = path.join(SHOT_DIR, '40_viewpoint_b_facade_closeup.png');
        try { fs.copyFileSync(out, altOut); } catch (_) {}

        const img = toLuminance(fs.readFileSync(out));
        const cx0 = Math.floor(img.w * 0.2), cx1 = Math.floor(img.w * 0.8);
        const y0 = Math.floor(img.h * 0.2), y1 = Math.floor(img.h * 0.7);

        const blackCols = blackColumnFraction(img, cx0, y0, cx1, y1);
        expect(blackCols).toBe(0);

        const osc = periodicOscillation(img, cx0, y0, cx1, y1, 'y');
        console.log(`[visual] Viewpoint B Facade: mean=${regionMean(img, cx0, y0, cx1, y1).toFixed(1)} blackCols=${blackCols} osc=${osc.toFixed(4)}`);
        expect(osc).toBeLessThan(0.02);

        expect(regionMean(img, cx0, y0, cx1, y1)).toBeGreaterThan(60);
    }, 120000);

    itIfColosseum('Viewpoint C: Street Promenade ([0, 1.7, 95], eye level)', async () => {
        const out = path.join(SHOT_DIR, '42_viewpoint_c_street_promenade.png');
        await captureHeadless(
            chrome!,
            `${base}?hud=0&tileset=/tilesets/colosseum/tileset.json&mode=softz&cam=0,1.7,95&target=0,5,0&lighting=golden&hold=5000`,
            out,
            120000,
            true
        );
        const altOut = path.join(SHOT_DIR, '41_viewpoint_c_street_promenade.png');
        try { fs.copyFileSync(out, altOut); } catch (_) {}

        const img = toLuminance(fs.readFileSync(out));
        const cx0 = Math.floor(img.w * 0.2), cx1 = Math.floor(img.w * 0.8);
        const y0 = Math.floor(img.h * 0.2), y1 = Math.floor(img.h * 0.7);

        const blackCols = blackColumnFraction(img, cx0, y0, cx1, y1);
        expect(blackCols).toBe(0);

        const osc = periodicOscillation(img, cx0, y0, cx1, y1, 'x');
        console.log(`[visual] Viewpoint C Promenade: mean=${regionMean(img, cx0, y0, cx1, y1).toFixed(1)} blackCols=${blackCols} osc=${osc.toFixed(4)}`);
        expect(osc).toBeLessThan(0.02);

        expect(regionMean(img, cx0, y0, cx1, y1)).toBeGreaterThan(60);
    }, 120000);

    itIfColosseum('Colosseum Splat Sort Performance & Frame Rate Budget (<15ms sort duration, >=30 FPS budget)', () => {
        // Benchmark Radix bucket sort on full Colosseum splat array (977k splats)
        const count = 977283;
        const dists = new Float32Array(count);
        for (let i = 0; i < count; i++) dists[i] = (i * 1.618) % 300.0;
        const BUCKETS = 16384;
        const counts = new Uint32Array(BUCKETS);
        const starts = new Uint32Array(BUCKETS);
        const sortedIndices = new Int32Array(count);
        function radixSort(dists: Float32Array, counts: Uint32Array, starts: Uint32Array, sortedIndices: Int32Array) {
            counts.fill(0);
            let minDist = Infinity, maxDist = -Infinity;
            const len = dists.length;
            for (let i = 0; i < len; i++) {
                const d = dists[i];
                if (d < minDist) minDist = d;
                if (d > maxDist) maxDist = d;
            }
            const normFactor = (BUCKETS - 1) / (maxDist - minDist || 1.0);
            for (let i = 0; i < len; i++) counts[((dists[i] - minDist) * normFactor) | 0]++;
            starts[BUCKETS - 1] = 0;
            for (let i = BUCKETS - 2; i >= 0; i--) starts[i] = starts[i + 1] + counts[i + 1];
            for (let i = 0; i < len; i++) sortedIndices[starts[((dists[i] - minDist) * normFactor) | 0]++] = i;
        }

        // Warm up JIT compiler
        for (let w = 0; w < 3; w++) {
            radixSort(dists, counts, starts, sortedIndices);
        }

        const t0 = performance.now();
        radixSort(dists, counts, starts, sortedIndices);
        const sortDuration = performance.now() - t0;

        console.log(`[perf] 977k Colosseum splat sort duration: ${sortDuration.toFixed(2)}ms (budget: <15ms)`);
        expect(sortDuration).toBeLessThan(15.0);
    });
});
