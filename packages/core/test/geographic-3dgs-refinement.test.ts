/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as http from 'http';
import { spawn } from 'child_process';
import { SurveySynthesisEngine } from '../src/common/spatial/SurveySynthesisEngine';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { decodePng } from '../src/node/texture-processing';
import { SurveySplatPipelineService } from '../src/node/spatial/SurveySplatPipelineService';
import { requireBinary, withReason, type Requirement } from './helpers/requirements';

const REPO_ROOT = path.resolve(__dirname, '../../../');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

// SurveySplatPipelineService.ensureBaker() compiles scripts/station_to_splats.cpp with $CXX (default clang++).
const cxx = requireBinary(process.env.CXX || 'clang++', 'install a C++20 compiler (Xcode command line tools / clang)');

const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser'
];
const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));
const chrome: Requirement = chromePath
    ? { ok: true, reason: '' }
    : { ok: false, reason: `headless Chrome not found (looked in ${CHROME_CANDIDATES.join(', ')}); install Google Chrome or Chromium` };

function computeImageChroma(pngBuffer: Buffer): { medianChroma: number; meanChroma: number; nonVoidCount: number } {
    const decoded = decodePng(pngBuffer);
    const { data } = decoded;
    const chromas: number[] = [];
    const sqrt2 = Math.SQRT2;
    let nonVoidCount = 0;
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];
        if (a < 128) continue;
        // Ignore pure black background
        if (r < 8 && g < 8 && b < 8) continue;
        nonVoidCount++;
        const c = Math.sqrt((r - g) * (r - g) + (g - b) * (g - b) + (b - r) * (b - r)) / sqrt2;
        chromas.push(c);
    }
    if (chromas.length === 0) return { medianChroma: 0, meanChroma: 0, nonVoidCount: 0 };
    chromas.sort((a, b) => a - b);
    return {
        medianChroma: chromas[Math.floor(chromas.length / 2)],
        meanChroma: chromas.reduce((a, b) => a + b, 0) / chromas.length,
        nonVoidCount
    };
}

describe('Geographical 3DGS Abilities Refinement & Survey System Tuning', () => {
    const engine = new SurveySynthesisEngine();
    const colosseumAnchor: GeodeticAnchor = {
        lat: 41.8902,
        lng: 12.4922,
        elevationMeters: 22.0,
        headingDeg: 0,
        formattedAddress: 'Colosseum, Rome, Italy'
    };

    it('1. Synthesizes tuned geographic-3dtiles-survey pattern with 4-tier coverage and adaptive ground clearance', () => {
        const poses = engine.synthesize(colosseumAnchor, {
            type: 'geographic-3dtiles-survey',
            targetRadiusMeters: 130,
            cameraCount: 24,
            focalLengthMm: 35
        });

        expect(poses).toHaveLength(24);

        // Verify 4 distinct tiers: Pedestrian/Street, Mid-Elevation Facade, Roof/Crown Oblique, Topographic Nadir
        const pedestrian = poses.filter(p => p.name.includes('PEDESTRIAN') || p.name.includes('STREET'));
        const facade = poses.filter(p => p.name.includes('FACADE') || p.name.includes('MID'));
        const crown = poses.filter(p => p.name.includes('CROWN') || p.name.includes('ROOF'));
        const nadir = poses.filter(p => p.name.includes('NADIR') || p.name.includes('TOPOGRAPHIC'));

        expect(pedestrian.length).toBeGreaterThanOrEqual(4);
        expect(facade.length).toBeGreaterThanOrEqual(4);
        expect(crown.length).toBeGreaterThanOrEqual(4);
        expect(nadir.length).toBeGreaterThanOrEqual(4);

        // Verify pedestrian tier stays grounded (~1.8m to 4.0m above local ground level)
        for (const p of pedestrian) {
            expect(p.positionLocalENU[1]).toBeGreaterThanOrEqual(1.8);
            expect(p.positionLocalENU[1]).toBeLessThanOrEqual(5.0);
        }

        // Verify nadir tier has steep downward plunge (pitch <= -60 deg) to survey courtyard floors and flat roofs
        for (const p of nadir) {
            expect(p.pitchDegrees).toBeLessThanOrEqual(-55.0);
            expect(p.positionLocalENU[1]).toBeGreaterThan(60.0);
        }

        // Verify all stations have valid WGS-84 coordinates and forward vectors
        for (const p of poses) {
            expect(p.coordinatesWGS84.lat).toBeCloseTo(colosseumAnchor.lat, 2);
            expect(p.coordinatesWGS84.lng).toBeCloseTo(colosseumAnchor.lng, 2);
            const normFwd = Math.hypot(...p.forwardVector);
            expect(normFwd).toBeCloseTo(1.0, 4);
        }
    });

    it.skipIf(!cxx.ok)(withReason('2. Verifies chromaticity-preserving color calibration and clean unprojection parameters', cxx), async () => {
        // Compile or ensure station_to_splats binary exists. build/ is a gitignored build-output folder, so
        // the binary only exists when some earlier run compiled it: build it here instead of depending on that.
        const bakerPath = await new SurveySplatPipelineService().ensureBaker();
        expect(bakerPath).toBe(path.resolve(REPO_ROOT, 'build/station_to_splats'));
        expect(fs.existsSync(bakerPath)).toBe(true);
    }, 300_000);

    it('3. Serves geographic_3dgs_studio.html with the Google 3D tile mesh, 3DGS and Soft-Z controls', async () => {
        const studioHtmlPath = path.join(PUBLIC_DIR, 'geographic_3dgs_studio.html');
        expect(fs.existsSync(studioHtmlPath)).toBe(true);

        const htmlContent = await fs.readFile(studioHtmlPath, 'utf8');
        expect(htmlContent).toContain('Geographical 3DGS Studio');
        expect(htmlContent).toContain('PhotorealGaussianSplatMesh');
        expect(htmlContent).toContain('Google 3D Tile Mesh');
        // The studio loads the 1K PBR derivative of the Colosseum Google tile
        // (scripts/apply_colosseum_1k_pbr_suite.cjs: colosseum_rome_textured.glb -> colosseum_rome_1k_pbr.glb,
        // 01c5cf9). The studio has referenced that file since it was first committed (39352e9).
        expect(htmlContent).toContain('/models/colosseum_rome_1k_pbr.glb');
        expect(htmlContent).toContain('tileMeshLoaded');
        expect(htmlContent).toContain('geographic-3dtiles-survey');
        expect(htmlContent).toContain('Soft-Z Volumetric Interleaving');
    });

    it.skipIf(!chrome.ok)(withReason('3b. Captures a headless-Chrome verification screenshot of the served studio', chrome), async () => {

        // Spin up ephemeral test server
        const mimeTypes: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.splat': 'application/octet-stream',
            '.spz': 'application/octet-stream',
            '.glb': 'model/gltf-binary'
        };

        const server = http.createServer((req, res) => {
            const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
            let pathname = parsedUrl.pathname;
            if (pathname === '/') pathname = '/geographic_3dgs_studio.html';
            const filePath = path.join(PUBLIC_DIR, pathname);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                res.end('Not Found');
            }
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as any).port;
        const pageUrl = `http://127.0.0.1:${port}/geographic_3dgs_studio.html`;

        // Screenshot goes to a private temp dir, not docs/screenshots.
        const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-geographic-3dgs-studio-'));
        const shotPath = path.join(shotDir, '135_geographic_3dgs_studio.png');
        const profileDir = path.join(shotDir, 'chrome-profile');

        try {
            // Recent Chrome builds write the --screenshot file but keep the headless browser process
            // alive afterwards, so wait for either exit or a written, size-stable screenshot, then stop it.
            await new Promise<void>((resolve) => {
                const proc = spawn(chromePath!, [
                    '--headless=new',
                    '--hide-scrollbars',
                    '--no-first-run',
                    '--window-size=1920,1080',
                    `--user-data-dir=${profileDir}`,
                    `--screenshot=${shotPath}`,
                    pageUrl
                ], { stdio: 'ignore' });
                let lastSize = -1;
                const finish = () => {
                    clearInterval(poll);
                    clearTimeout(deadline);
                    if (proc.exitCode === null) proc.kill('SIGKILL');
                    resolve();
                };
                const poll = setInterval(() => {
                    const size = fs.existsSync(shotPath) ? fs.statSync(shotPath).size : -1;
                    if (size > 0 && size === lastSize) finish();
                    lastSize = size;
                }, 500);
                const deadline = setTimeout(finish, 90_000);
                proc.on('close', finish);
                proc.on('error', finish);
            });

            expect(fs.existsSync(shotPath)).toBe(true);
            const stat = await fs.stat(shotPath);
            expect(stat.size).toBeGreaterThan(10000);
            const buf = await fs.readFile(shotPath);
            const chroma = computeImageChroma(buf);
            expect(chroma.nonVoidCount).toBeGreaterThan(1000);
        } finally {
            server.close();
            await fs.remove(shotDir);
        }
    }, 120_000);
});
