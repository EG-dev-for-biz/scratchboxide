/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Visual Proof & Verification Runner for 3D Tile Restructuring Studio.
 * Spawns ephemeral server, launches headless Chrome with WebGL,
 * exercises interactive prompt & style presets, and captures verification screenshots.
 ********************************************************************************/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

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
            const id = ++this.id;
            this.callbacks.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
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

async function startServer() {
    const server = http.createServer((req, res) => {
        let reqPath = decodeURI(req.url.split('?')[0]);
        if (reqPath === '/' || reqPath === '') reqPath = '/scripts/tile_restructuring_demo.html';

        const filePath = path.join(REPO_ROOT, reqPath);
        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }

        let contentType = 'text/plain';
        if (filePath.endsWith('.html')) contentType = 'text/html';
        else if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) contentType = 'application/javascript';
        else if (filePath.endsWith('.css')) contentType = 'text/css';
        else if (filePath.endsWith('.json')) contentType = 'application/json';
        else if (filePath.endsWith('.glb')) contentType = 'model/gltf-binary';
        else if (filePath.endsWith('.png')) contentType = 'image/png';

        res.writeHead(200, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        fs.createReadStream(filePath).pipe(res);
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            console.log(`[Server] Live on http://127.0.0.1:${port}`);
            resolve({ server, port });
        });
    });
}

async function main() {
    console.log('=== Scratchbox 3D - Tile Restructurer Visual Verification ===');
    const { server, port } = await startServer();

    const chromePort = 9298;
    const tmpDir = fs.mkdtempSync('/tmp/chrome_restructurer_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-proxy-server',
        `--user-data-dir=${tmpDir}`,
        `--remote-debugging-port=${chromePort}`,
        '--window-size=1440,900',
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

        const demoUrl = `http://127.0.0.1:${port}/scripts/tile_restructuring_demo.html`;
        console.log(`[Chrome] Navigating to ${demoUrl}...`);
        await cdp.send('Page.navigate', { url: demoUrl });

        // Wait for studio ready signal
        console.log('[Studio] Waiting for WebGL scene to initialize and settle...');
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            try {
                const isReady = await cdp.eval('window.__STUDIO_READY__ === true');
                if (isReady) break;
            } catch {}
        }
        await sleep(1500); // Allow shadow maps and OrbitControls to settle

        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

        // 1. Capture Colosseum Restored Brand-New in Studio Clay mode (Default Landing)
        console.log('\n[1/6] Capturing Colosseum Restored Brand-New (Studio Clay Mode)...');
        await sleep(2000);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '120_tile_restructurer_solarpunk_clay.png'));

        // 2. Select Colosseum in Clay Mode
        console.log('\n[2/6] Selecting Real 3D Tile: Colosseum, Rome in Clay Mode...');
        await cdp.eval(`window.onLandmarkSelect('colosseum')`);
        await sleep(2000);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '126_tile_restructurer_query_colosseum_clay.png'));

        // 3. Select Real 3D Tile: Empire State Building, New York in Clay Mode
        console.log('\n[3/7] Selecting Real 3D Tile: Empire State Building, New York in Clay Mode...');
        await cdp.eval(`window.onLandmarkSelect('esb')`);
        await sleep(2000);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '127_tile_restructurer_query_esb_clay.png'));

        // 4. Prompt-Driven Restructuring via Natural Language on SF Ferry Building
        console.log('\n[4/7] Executing Prompt-Driven Terraforming & Primitive Grafting via C++20 Astra Pipeline...');
        await cdp.eval(`
            window.onLandmarkSelect('sf_ferry');
            document.getElementById('prompt-input').value = 'Terrace the waterfront into 4 stepped tiers, level a wide sun plaza, and place 8 colonnade columns and a central bio-dome in studio clay';
            window.executePrompt();
        `);
        await sleep(3000);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '130_tile_restructurer_prompt_restructured_live.png'));

        // 5. Capture Brutalist Fortress
        console.log('\n[5/7] Switching to Brutalist Fortress Preset...');
        await cdp.eval(`window.selectPreset('brutalist')`);
        await sleep(2500);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '121_tile_restructurer_brutalist_citadel.png'));

        // 6. Capture Neoclassical Acropolis (Stylized PBR)
        console.log('\n[6/7] Switching to Classical Acropolis Preset in Stylized PBR...');
        await cdp.eval(`window.selectPreset('acropolis'); window.setMaterialMode('pbr');`);
        await sleep(2500);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '122_tile_restructurer_neoclassical_acropolis.png'));

        // 7. Capture Original Raw Tile Baseline
        console.log('\n[7/7] Switching to Original Raw Tile Baseline View...');
        await cdp.eval(`window.switchView('original'); window.setMaterialMode('clay');`);
        await sleep(1500);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '123_tile_restructurer_raw_baseline.png'));

        console.log('\n🎉 All 7 visual verification screenshots successfully captured!');
    } finally {
        if (cdp) cdp.close();
        try { chromeProc.kill('SIGKILL'); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        server.close();
    }
}

main().catch(err => {
    console.error('Fatal error during verification:', err);
    process.exit(1);
});
