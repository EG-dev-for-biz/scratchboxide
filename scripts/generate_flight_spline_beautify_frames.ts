/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import * as http from 'http';
import WebSocket from 'ws';
import { spawn } from 'child_process';
import { SurveySynthesisEngine } from '../packages/core/src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService, type StationBlockoutRender } from '../packages/core/src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../packages/core/src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor } from '../packages/core/src/common/spatial/colmap-vector-reference-types';
import { encodePng, decodePng } from '../packages/core/src/node/texture-processing';

const REPO_ROOT = path.resolve(__dirname, '..');
const GLB_PATH = path.join(REPO_ROOT, 'public/models/red_rocks_amphitheatre.glb');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const OUT_DIR = path.join(PUBLIC_DIR, 'flight_frames');
const SHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots');

const HTTP_PORT = 8165;
const CDP_PORT = 9285;

const ANCHOR: GeodeticAnchor = {
    lat: 39.66555,
    lng: -105.20525,
    elevationMeters: 1932.0,
    headingDeg: 270.0,
    formattedAddress: 'Red Rocks Amphitheatre, Morrison, Colorado'
};

const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json',
    '.glb': 'model/gltf-binary', '.splat': 'application/octet-stream', '.spz': 'application/octet-stream'
};

async function main() {
    console.log('========================================================================');
    console.log('🎬 GENERATING 3D SPLINE FLIGHT FRAMES FROM FULL TEXTURED .GLB');
    console.log('========================================================================');

    await fs.ensureDir(OUT_DIR);
    await fs.ensureDir(SHOT_DIR);

    const frameCount = parseInt(process.env.FRAME_COUNT || '12', 10);
    const width = parseInt(process.env.FRAME_WIDTH || '1280', 10);
    const height = Math.round(width * 9 / 16);

    console.log(`\n[Step 1/4] Synthesizing ${frameCount} collision-free 3D spline flight poses...`);
    const engine = new SurveySynthesisEngine();
    const stations = engine.synthesize(ANCHOR, {
        type: 'continuous-flight',
        cameraCount: frameCount,
        targetRadiusMeters: 180.0,
        lookAtOffsetLocalENU: [5.2, 4.46, 0.0],
        minCameraHeightAboveGroundMeters: 1.5,
        focalLengthMm: 35
    });

    console.log(`  -> Synthesized ${stations.length} 6-DOF spline waypoints.`);

    // Start static HTTP server for headless Chrome
    const server = http.createServer((req, res) => {
        let reqPath = decodeURI((req.url || '/').split('?')[0]);
        if (reqPath === '/' || reqPath === '') reqPath = '/red_rocks_performer_demo.html';
        const filePath = path.join(PUBLIC_DIR, reqPath);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            res.writeHead(404); res.end('Not found'); return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
    });

    await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r));

    const tmpDir = fs.mkdtempSync('/tmp/chrome_textured_spline_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new', '--no-sandbox', '--use-gl=angle', '--enable-webgl',
        `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${tmpDir}`,
        `--window-size=${width},${height}`, 'about:blank'
    ]);

    let targetWs: string | null = null;
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
            const targets: any = await new Promise((res, rej) => {
                http.get(`http://127.0.0.1:${CDP_PORT}/json`, (r) => {
                    let d = ''; r.on('data', c => d += c); r.on('end', () => {
                        try { res(JSON.parse(d)); } catch (e) { rej(e); }
                    });
                }).on('error', rej);
            });
            if (Array.isArray(targets)) {
                const pt = targets.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
                if (pt) { targetWs = pt.webSocketDebuggerUrl; break; }
            }
        } catch (_) {}
    }

    if (!targetWs) throw new Error('Could not connect to Chrome CDP');

    const ws = new WebSocket(targetWs);
    let cdpId = 1;
    const send = (method: string, params: any = {}) => new Promise<any>(res => {
        const curId = cdpId++;
        const handler = (data: any) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === curId) { ws.off('message', handler); res(msg.result); }
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await new Promise(r => ws.on('open', r));
    await send('Page.enable');
    await send('Runtime.enable');

    console.log('\n[Step 2/4] Loading authentic full-textured Google 3D Tiles in WebGL (zero HUD)...');
    const targetUrl = `http://127.0.0.1:${HTTP_PORT}/red_rocks_performer_demo.html?flightT=0.00&mode=mesh&env=google_tiles&hud=0`;
    await send('Page.navigate', { url: targetUrl });

    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const r = await send('Runtime.evaluate', {
            expression: 'Boolean(window.__redRocksReady && typeof renderer !== "undefined" && renderer.info.render.frame > 25)'
        });
        if (r && r.result && r.result.value) break;
    }
    await new Promise(r => setTimeout(r, 2000));

    console.log('\n[Step 3/4] Capturing full-textured .glb frames along 3D spline flight path...');
    const capturedTexturedFrames: Buffer[] = [];

    for (let i = 0; i < stations.length; i++) {
        const u = i / stations.length;
        await send('Runtime.evaluate', { expression: `setFlightProgress(${u.toFixed(6)});` });
        await new Promise(r => setTimeout(r, 150));

        const shot = await send('Page.captureScreenshot', { format: 'png', quality: 100 });
        const pngBuf = Buffer.from(shot.data, 'base64');
        capturedTexturedFrames.push(pngBuf);

        const frameIdxStr = String(i + 1).padStart(3, '0');
        const texturedPath = path.join(OUT_DIR, `flight_frame_${frameIdxStr}_textured.png`);
        await fs.writeFile(texturedPath, pngBuf);

        console.log(`  [Textured Frame ${i + 1}/${stations.length}] progress u = ${u.toFixed(3)} -> saved (${(pngBuf.length / 1024).toFixed(1)} KB)`);
    }

    // Clean up browser & static server
    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
    await fs.remove(tmpDir).catch(() => {});

    console.log('\n[Step 4/4] Passing full textured frames into AI Beautify draft mode...');
    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(GLB_PATH);

    const generator = createDefaultStationImageGenerator({
        workspaceRoot: REPO_ROOT,
        allowProceduralGenerator: true,
        fidelity: 'draft',
        imageSize: '1K'
    });

    const beautifier = new BeautifyStationService(renderer, generator);

    let previousResult: any = undefined;
    const finalFrames: Array<{ frameIndex: number; texturedPath: string; beautyPath: string }> = [];

    for (let i = 0; i < stations.length; i++) {
        const st = stations[i];
        const frameIdxStr = String(i + 1).padStart(3, '0');
        const texturedPath = path.join(OUT_DIR, `flight_frame_${frameIdxStr}_textured.png`);
        const beautyPath = path.join(OUT_DIR, `flight_frame_${frameIdxStr}_beauty.png`);

        const texturedPng = capturedTexturedFrames[i];
        const dec = decodePng(texturedPng);

        // Build station blockout render from full textured capture
        const blockoutRender: StationBlockoutRender = {
            stationId: st.id,
            width: dec.width,
            height: dec.height,
            rgba: dec.rgba,
            png: texturedPng,
            depth: renderer.renderStationBlockout(st, { width: dec.width, height: dec.height }).depth,
            depthKind: 'camera-z',
            silhouette: new Uint8Array(dec.width * dec.height).fill(255),
            intrinsics: renderer.renderStationBlockout(st, { width: dec.width, height: dec.height }).intrinsics,
            cameraPose: {
                x: st.positionLocalENU[0],
                y: st.positionLocalENU[1],
                z: st.positionLocalENU[2],
                yaw: st.yawDegrees,
                pitch: st.pitchDegrees,
                roll: st.rollDegrees,
                fov: st.fovDegrees
            }
        };

        const t0 = Date.now();
        const res = await beautifier.beautify(
            st,
            {
                locationName: 'Red Rocks Amphitheatre',
                architecturalStyle: 'Fountain Formation Sandstone Natural Amphitheatre',
                moodPromptContext: 'Crisp morning daylight with natural Colorado sun shadows',
                styleSuffix: '' // Draft mode empty suffix
            },
            {
                width: dec.width,
                height: dec.height,
                draft: true,
                maxRerolls: 0,
                reference: previousResult,
                blockoutOverride: blockoutRender
            }
        );

        await fs.writeFile(beautyPath, res.imagePng);

        const warpCoverage = res.warp ? `${(res.warp.coveredFraction * 100).toFixed(1)}% warped` : 'keyframe base';
        console.log(`  [AI Beautify Frame ${i + 1}/${stations.length}] ${st.name} | ${warpCoverage} in ${Date.now() - t0}ms`);

        previousResult = res;
        finalFrames.push({ frameIndex: i + 1, texturedPath, beautyPath });
    }

    // Composite 50/50 Side-by-Side: Left = Full Textured .glb, Right = AI Beautify Draft Output
    console.log('\nCompositing 50/50 comparison plates (Full Textured .GLB vs AI Beautify)...');
    const sampleIndices = [1, Math.min(4, frameCount), Math.min(8, frameCount), frameCount];

    for (const sIdx of sampleIndices) {
        const entry = finalFrames[sIdx - 1];
        if (!entry) continue;

        const tDec = decodePng(await fs.readFile(entry.texturedPath));
        const bDec = decodePng(await fs.readFile(entry.beautyPath));

        const compW = tDec.width;
        const compH = tDec.height;
        const compRgba = Buffer.alloc(compW * compH * 4);
        const splitX = Math.floor(compW * 0.5);

        for (let y = 0; y < compH; y++) {
            for (let x = 0; x < compW; x++) {
                const idx = (y * compW + x) * 4;
                if (x === splitX || x === splitX - 1) {
                    compRgba[idx + 0] = 255;
                    compRgba[idx + 1] = 255;
                    compRgba[idx + 2] = 255;
                    compRgba[idx + 3] = 255;
                } else if (x < splitX) {
                    compRgba[idx + 0] = tDec.rgba[idx + 0];
                    compRgba[idx + 1] = tDec.rgba[idx + 1];
                    compRgba[idx + 2] = tDec.rgba[idx + 2];
                    compRgba[idx + 3] = 255;
                } else {
                    compRgba[idx + 0] = bDec.rgba[idx + 0];
                    compRgba[idx + 1] = bDec.rgba[idx + 1];
                    compRgba[idx + 2] = bDec.rgba[idx + 2];
                    compRgba[idx + 3] = 255;
                }
            }
        }

        const compShotName = `92_flight_frame_${String(sIdx).padStart(2, '0')}_split_full_textured_vs_beautify.png`;
        const compOutPath = path.join(SHOT_DIR, compShotName);
        await fs.writeFile(compOutPath, encodePng(compW, compH, compRgba));
        console.log(`  -> Saved comparison plate: ${compShotName}`);
    }

    console.log('\n========================================================================');
    console.log('✅ ALL FULL-TEXTURED FLIGHT FRAMES & BEAUTIFY PLATES COMPLETED!');
    console.log(`   Saved ${finalFrames.length} frames to ${OUT_DIR}`);
    console.log('========================================================================');
}

main().catch(err => {
    console.error('Fatal flight beautify error:', err);
    process.exit(1);
});
