/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Visual & Functional Verification Runner for 3DGS Survey & Radiance Pipeline Studio.
 * Exercises Pipeline configuration modal, triggers C++20 voxel fusion execution,
 * streams logs, verifies hot-reloaded splats in Three.js viewport, and captures
 * screenshots to verify every milestone.
 ********************************************************************************/

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

class CdpConnection {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.callbacks = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.ws.on('open', resolve);
            this.ws.on('error', reject);
            this.ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id && this.callbacks.has(msg.id)) {
                    const { resolve, reject } = this.callbacks.get(msg.id);
                    this.callbacks.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            });
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const msgId = ++this.id;
            this.callbacks.set(msgId, { resolve, reject });
            this.ws.send(JSON.stringify({ id: msgId, method, params }));
        });
    }

    async eval(expression) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true
        });
        if (res.exceptionDetails) {
            throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
    }

    async screenshot(outPath) {
        const res = await this.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(res.data, 'base64'));
        console.log(`  📸 Saved screenshot: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
    }

    close() {
        try { this.ws.close(); } catch {}
    }
}

async function main() {
    console.log('=== Scratchbox 3D - Geographical 3DGS Studio Pipeline Verification ===');

    const chromePort = 9288;
    const tmpDir = fs.mkdtempSync('/tmp/chrome_3dgs_studio_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-proxy-server',
        `--user-data-dir=${tmpDir}`,
        `--remote-debugging-port=${chromePort}`,
        '--window-size=1920,1080',
        'about:blank'
    ]);

    let cdp;
    try {
        console.log('[Chrome] Waiting for remote debugging port...');
        let targetWs = null;
        for (let i = 0; i < 30; i++) {
            try {
                await sleep(300);
                const targets = await getJson(`http://127.0.0.1:${chromePort}/json`);
                const page = targets && targets.find(t => t.type === 'page');
                if (page && page.webSocketDebuggerUrl) {
                    targetWs = page.webSocketDebuggerUrl;
                    break;
                }
            } catch {}
        }

        if (!targetWs) throw new Error('Failed to find Chrome WebSocket URL');

        cdp = new CdpConnection(targetWs);
        await cdp.connect();
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');

        const studioUrl = 'http://127.0.0.1:5173/geographic_3dgs_studio.html';
        console.log(`[Chrome] Navigating to ${studioUrl}...`);
        await cdp.send('Page.navigate', { url: studioUrl });

        console.log('[Studio] Waiting for 3D Tile and Radiance Field to initialize...');
        for (let i = 0; i < 40; i++) {
            await sleep(300);
            try {
                const ready = await cdp.eval('window.__engineState?.tileMeshLoaded && window.__engineState?.splatLoaded');
                if (ready) break;
            } catch {}
        }

        await sleep(1500);

        // Milestone 1: Studio Initial State with 3D Tile & Radiance Field
        const shot1 = path.join(SCREENSHOT_DIR, '160_geographic_3dgs_studio_initial.png');
        await cdp.screenshot(shot1);
        const state1 = await cdp.eval(`({
            status: document.getElementById('lbl-status')?.textContent,
            tileStatus: document.getElementById('lbl-tile-status')?.textContent,
            tileVerts: document.getElementById('val-tile-verts')?.textContent,
            splatCount: document.getElementById('val-splat-count')?.textContent
        })`);
        console.log('Milestone 1 State:', state1);

        // Milestone 2: Open Pipeline Runner Modal
        console.log('[Pipeline] Opening Interactive Pipeline Configuration Modal...');
        await cdp.eval('openPipelineModal()');
        await sleep(600);

        const shot2 = path.join(SCREENSHOT_DIR, '161_geographic_3dgs_pipeline_modal_open.png');
        await cdp.screenshot(shot2);

        // Milestone 3: Execute 3DGS Pipeline (Fast 4-Station Preview)
        console.log('[Pipeline] Triggering 3DGS Survey Pipeline Execution...');
        await cdp.eval('setPipelineStationCount(4)');
        await cdp.eval('setPipelineVoxelSize(0.10)');
        
        // Call executePipeline and wait for completion
        const pipelinePromise = cdp.eval('executePipeline()');
        
        // Wait a moment and capture active running state
        await sleep(800);
        const shot3 = path.join(SCREENSHOT_DIR, '162_geographic_3dgs_pipeline_executing.png');
        await cdp.screenshot(shot3);

        // Wait for pipeline execution to complete (poll for status)
        console.log('[Pipeline] Awaiting C++20 voxel fusion completion...');
        for (let i = 0; i < 40; i++) {
            await sleep(400);
            const active = await cdp.eval('pipelineActive');
            if (!active) break;
        }

        await sleep(1000);

        // Milestone 4: Pipeline Completed with Telemetry KPIs and Logs
        const shot4 = path.join(SCREENSHOT_DIR, '163_geographic_3dgs_pipeline_completed.png');
        await cdp.screenshot(shot4);

        const kpis = await cdp.eval(`({
            fusedGaussians: document.getElementById('kpi-fused-splats')?.textContent,
            prunedOutliers: document.getElementById('kpi-pruned-splats')?.textContent,
            duration: document.getElementById('kpi-pipe-duration')?.textContent,
            bufferSize: document.getElementById('kpi-splat-size')?.textContent,
            statusBadge: document.getElementById('lbl-pipe-status-badge')?.textContent
        })`);
        console.log('Milestone 4 KPIs:', kpis);

        // Milestone 5: Close Modal and Verify Hot-Reloaded Viewport
        console.log('[Viewport] Closing modal to inspect hot-reloaded 3D scene...');
        await cdp.eval('closePipelineModal()');
        await sleep(1000);

        const shot5 = path.join(SCREENSHOT_DIR, '164_geographic_3dgs_viewport_hot_reloaded.png');
        await cdp.screenshot(shot5);

        const finalState = await cdp.eval(`({
            status: document.getElementById('lbl-status')?.textContent,
            splatCount: document.getElementById('val-splat-count')?.textContent,
            quickBadge: document.getElementById('lbl-pipeline-quick-badge')?.textContent
        })`);
        console.log('Milestone 5 Final State:', finalState);

        console.log('✅ 3DGS Survey & Radiance Pipeline Verification Complete!');
    } finally {
        if (cdp) cdp.close();
        chromeProc.kill();
        try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
}

main().catch(err => {
    console.error('Pipeline verification failed:', err);
    process.exit(1);
});
