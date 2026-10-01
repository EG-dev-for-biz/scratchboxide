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
import { spawn, execSync } from 'child_process';
import { SurveySynthesisEngine } from '../packages/core/src/common/spatial/SurveySynthesisEngine';
import { SurveyStationRenderService, type StationBlockoutRender } from '../packages/core/src/node/spatial/SurveyStationRenderService';
import { BeautifyStationService, createDefaultStationImageGenerator } from '../packages/core/src/node/spatial/BeautifyStationService';
import type { GeodeticAnchor, ColmapCameraPose } from '../packages/core/src/common/spatial/colmap-vector-reference-types';
import { encodePng, decodePng } from '../packages/core/src/node/texture-processing';

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const GLB_PATH = path.join(PUBLIC_DIR, 'models/red_rocks_amphitheatre.glb');
const OUT_DIR = path.join(PUBLIC_DIR, 'tilesets/red_rocks_flight');
const STATIONS_DIR = path.join(OUT_DIR, 'stations');
const BAKER_BIN = path.join(REPO_ROOT, 'build/station_to_splats');
const SHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots');

const HTTP_PORT = 8166;
const CDP_PORT = 9286;

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
    console.log('🚀 RUNNING END-TO-END 3DGS PIPELINE WITH 3D SPLINE FLIGHT & FULL-TEXTURED GLB');
    console.log('========================================================================');

    await fs.ensureDir(STATIONS_DIR);
    await fs.ensureDir(SHOT_DIR);

    const frameCount = parseInt(process.env.FRAME_COUNT || '48', 10);
    const width = parseInt(process.env.FRAME_WIDTH || '1280', 10);
    const height = Math.round(width * 9 / 16);

    // 1. Synthesize Continuous 6-DOF Spline Flight Poses
    console.log(`\n[Stage 1/5] Synthesizing ${frameCount} collision-free 3D spline flight poses...`);
    const engine = new SurveySynthesisEngine();
    const stations = engine.synthesize(ANCHOR, {
        type: 'continuous-flight',
        cameraCount: frameCount,
        targetRadiusMeters: 220.0,
        lookAtOffsetLocalENU: [5.2, 4.46, 0.0],
        minCameraHeightAboveGroundMeters: 1.5,
        focalLengthMm: 32
    });

    console.log(`  -> Synthesized ${stations.length} 6-DOF continuous spline flight stations.`);

    // 2. Start Headless Server & Chrome for WebGL Full-Textured .GLB Capture
    console.log('\n[Stage 2/5] Capturing full-textured .glb frames along flight path via WebGL...');
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

    // Dynamic Ephemeral Port Binding for HTTP server
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const actualHttpPort = (server.address() as any).port;
    const actualCdpPort = 9284;

    const tmpDir = fs.mkdtempSync('/tmp/chrome_spline_pipe_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-proxy-server',
        `--remote-debugging-port=${actualCdpPort}`,
        `--user-data-dir=${tmpDir}`,
        `--window-size=${width},${height}`,
        'about:blank'
    ]);

    let targetWs: string | null = null;
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 250));
        try {
            const targets: any = await new Promise((res, rej) => {
                http.get(`http://127.0.0.1:${actualCdpPort}/json`, (r) => {
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

    if (!targetWs) throw new Error(`Could not connect to Chrome CDP on port ${actualCdpPort}`);

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

    const targetUrl = `http://127.0.0.1:${actualHttpPort}/red_rocks_performer_demo.html?flightT=0.00&mode=mesh&env=google_tiles&hud=0`;
    await send('Page.navigate', { url: targetUrl });

    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        const r = await send('Runtime.evaluate', {
            expression: 'Boolean(window.__redRocksReady && typeof renderer !== "undefined" && renderer.info.render.frame > 25)'
        });
        if (r && r.result && r.result.value) break;
    }
    await new Promise(r => setTimeout(r, 2000));

    const capturedTexturedFrames: Buffer[] = [];
    for (let i = 0; i < stations.length; i++) {
        const u = i / stations.length;
        await send('Runtime.evaluate', { expression: `setFlightProgress(${u.toFixed(6)});` });
        await new Promise(r => setTimeout(r, 120));

        const shot = await send('Page.captureScreenshot', { format: 'png', quality: 100 });
        const pngBuf = Buffer.from(shot.data, 'base64');
        capturedTexturedFrames.push(pngBuf);

        const frameIdxStr = String(i + 1).padStart(3, '0');
        const texturedPath = path.join(STATIONS_DIR, `station_${frameIdxStr}_textured.png`);
        await fs.writeFile(texturedPath, pngBuf);
        process.stdout.write(`.`);
    }
    console.log(`\n  -> Captured ${capturedTexturedFrames.length} full-textured frames.`);

    ws.close();
    chromeProc.kill('SIGKILL');
    server.close();
    await fs.remove(tmpDir).catch(() => {});

    // 3. AI Beautify Draft Pass & Depth Unprojection Preparation
    console.log('\n[Stage 3/5] AI Beautify Draft Pass on Full-Textured Flight Frames...');
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
    const bakedSplatEntries: Array<{ splatPath: string; alt: number }> = [];

    for (let i = 0; i < stations.length; i++) {
        const st = stations[i];
        const sIdStr = String(i + 1).padStart(3, '0');
        const base = path.join(STATIONS_DIR, `station_${sIdStr}`);
        const beautyPath = `${base}_beautified.png`;
        const rgbPath = `${base}.rgb`;
        const depthPath = `${base}.depth.f32`;
        const posePath = `${base}.pose.json`;
        const splatPath = `${base}.splat`;

        const texturedPng = capturedTexturedFrames[i];
        const dec = decodePng(texturedPng);

        const blockoutRender = renderer.renderStationBlockout(st, { width: dec.width, height: dec.height });

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
                blockoutOverride: {
                    ...blockoutRender,
                    rgba: dec.rgba,
                    png: texturedPng
                }
            }
        );

        await fs.writeFile(beautyPath, res.imagePng);
        previousResult = res;

        // 4. Bake Flight Station into 2D EWA Gaussian Surfels
        const beautyDec = decodePng(res.imagePng);
        const rgb24 = Buffer.alloc(beautyDec.width * beautyDec.height * 3);
        for (let pIdx = 0; pIdx < beautyDec.width * beautyDec.height; pIdx++) {
            rgb24[pIdx * 3 + 0] = beautyDec.rgba[pIdx * 4 + 0];
            rgb24[pIdx * 3 + 1] = beautyDec.rgba[pIdx * 4 + 1];
            rgb24[pIdx * 3 + 2] = beautyDec.rgba[pIdx * 4 + 2];
        }
        await fs.writeFile(rgbPath, rgb24);

        const depthBuf = Buffer.from(blockoutRender.depth.buffer, blockoutRender.depth.byteOffset, blockoutRender.depth.byteLength);
        await fs.writeFile(depthPath, depthBuf);

        const dx = st.forwardVector[0], dy = st.forwardVector[1], dz = st.forwardVector[2];
        const { right, up, forward } = {
            right: [1, 0, 0] as [number, number, number],
            up: [0, 1, 0] as [number, number, number],
            forward: [dx, dy, dz] as [number, number, number]
        };
        const poseObj = {
            fx: blockoutRender.intrinsics.fx,
            fy: blockoutRender.intrinsics.fy,
            cx: blockoutRender.intrinsics.cx,
            cy: blockoutRender.intrinsics.cy,
            eye: st.positionLocalENU,
            right,
            up,
            forward,
            cameraAltitude: st.positionLocalENU[1],
            depthKind: 'camera-z'
        };
        await fs.writeJson(posePath, poseObj, { spaces: 2 });

        const bakeCmd = `"${BAKER_BIN}" --rgb "${rgbPath}" --depth "${depthPath}" --width ${beautyDec.width} --height ${beautyDec.height} --pose "${posePath}" --out-splat "${splatPath}" --stride 1 --station-altitude ${st.positionLocalENU[1]} --sigma-scale 1.05 --min-cos-incidence 0.10 --max-depth 450.0 --erode-silhouette 2 --drop-boundary-floaters --exclude-underside --2dgs --json`;
        execSync(bakeCmd, { maxBuffer: 16 * 1024 * 1024 });

        await fs.remove(rgbPath).catch(() => {});
        await fs.remove(depthPath).catch(() => {});
        bakedSplatEntries.push({ splatPath, alt: st.positionLocalENU[1] });
        process.stdout.write(`*`);
    }
    console.log(`\n  -> Baked ${bakedSplatEntries.length} 3D spline flight splat clouds.`);

    // 5. Spatial Voxel-Hash Fusion & Export to Live Demo Viewport
    console.log('\n[Stage 4/5] Multi-view Spatial Voxel-Hash Fusion & Spz Compression...');
    const listPath = path.join(OUT_DIR, 'stations_to_fuse.txt');
    await fs.writeFile(listPath, bakedSplatEntries.map(s => `${s.splatPath} ${s.alt}`).join('\n'));

    const fusedSplatPath = path.join(OUT_DIR, 'fused.splat');
    const fuseCmd = `"${BAKER_BIN}" --fuse-list "${listPath}" --voxel-size 0.08 --adaptive-voxel --min-voxel-neighbors 1 --min-views 1 --normal-prune-cos 0.25 --crop-radius 460.0 --exclude-underside --out-splat "${fusedSplatPath}" --json`;
    const fuseOut = execSync(fuseCmd, { maxBuffer: 32 * 1024 * 1024 }).toString();
    const fuseRes = JSON.parse(fuseOut.trim());
    console.log(`\n🎉 FUSION COMPLETE: ${fuseRes.fusedSplatCount.toLocaleString()} Authentic 3D Gaussians!`);
    console.log(`   Splat File: ${fusedSplatPath} (${(fs.statSync(fusedSplatPath).size / 1024 / 1024).toFixed(2)} MB)`);

    // Update public/models/red_rocks_venue.splat and .spz
    const pubModelSplat = path.join(PUBLIC_DIR, 'models/red_rocks_venue.splat');
    const pubModelSpz = path.join(PUBLIC_DIR, 'models/red_rocks_venue.spz');
    await fs.copyFile(fusedSplatPath, pubModelSplat);

    const { SplatService } = await import('../packages/core/src/node/3d-engine/splat-service');
    const splatService = new SplatService();
    const spzPath = path.join(OUT_DIR, 'fused.spz');
    await splatService.runPipeline({ inputPath: fusedSplatPath, outSpzPath: spzPath });
    if (fs.existsSync(spzPath)) {
        await fs.copyFile(spzPath, pubModelSpz);
        console.log(`   Updated live viewport models: ${pubModelSplat} and ${pubModelSpz}`);
    }

    // Update OGC 3D Tileset
    const { Splat3DTilesService } = await import('../packages/core/src/node/spatial/Splat3DTilesService');
    const splatTiler = new Splat3DTilesService();
    await splatTiler.convert({
        inputPath: fusedSplatPath,
        outDir: OUT_DIR,
        origin: { lat: 39.66555, lng: -105.20525, alt: 1932.0 },
        headingDeg: 270.0
    });

    // 6. Visual Verification Screenshot Captures
    console.log('\n[Stage 5/5] Capturing visual verification screenshots...');
    execSync('node scripts/capture_red_rocks_photoreal.cjs', { stdio: 'inherit' });

    console.log('\n========================================================================');
    console.log('✅ COMPLETE 3D SPLINE FLIGHT PIPELINE FINISHED SUCCESSFULLY!');
    console.log('========================================================================');
}

main().catch(err => {
    console.error('Pipeline error:', err);
    process.exit(1);
});
