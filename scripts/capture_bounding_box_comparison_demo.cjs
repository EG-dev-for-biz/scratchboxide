/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Visual Proof & Verification Runner for 3D Bounding Box Metrology Comparison Demo.
 * Spawns an ephemeral server, launches headless Chrome with WebGL,
 * exercises Side-by-Side Dual Viewport, Combined Overlay Mode, and Benchmark
 * Presets, and captures verification screenshots.
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
        if (reqPath === '/' || reqPath === '') reqPath = '/public/demos/bounding_box_comparison_demo.html';

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
    console.log('=== Scratchbox 3D - Bounding Box Comparison Demo Visual Verification ===');
    const { server, port } = await startServer();

    const chromePort = 9299;
    const tmpDir = fs.mkdtempSync('/tmp/chrome_bbox_comparison_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-proxy-server',
        `--user-data-dir=${tmpDir}`,
        `--remote-debugging-port=${chromePort}`,
        '--window-size=1600,1000',
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

        const demoUrl = `http://127.0.0.1:${port}/public/demos/bounding_box_comparison_demo.html`;
        console.log(`[Chrome] Navigating to ${demoUrl}...`);
        await cdp.send('Page.navigate', { url: demoUrl });

        console.log('[Demo] Waiting for WebGL scenes to initialize...');
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            try {
                const initialized = await cdp.eval('typeof rendererAABB !== "undefined" && rendererAABB !== null');
                if (initialized) break;
            } catch {}
        }

        // Allow WebGL context to paint
        await sleep(1500);

        // Turn off auto-rotate for clean reproducible screenshots
        await cdp.eval('if (autoRotate) toggleAutoRotate();');
        await sleep(500);

        // 1. Capture Side-by-Side Dual Viewport (Arch of Constantine)
        console.log('[1/4] Capturing Side-by-Side Dual Viewport (Arch of Constantine: Loose AABB vs Tight OBB)...');
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '131_bbox_comparison_side_by_side_constantine.png'));

        // 2. Capture Combined Overlay Mode (Arch of Constantine)
        console.log('[2/4] Switching to Combined Superimposed Overlay Viewport...');
        await cdp.eval('setViewMode("overlay");');
        await sleep(800);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '132_bbox_comparison_overlay_constantine.png'));

        // 3. Capture Synthetic 45° Box Benchmark
        console.log('[3/4] Switching to Synthetic 45° Rotated Prismatic Benchmark...');
        await cdp.eval('selectBenchmark(0); setViewMode("split");');
        await sleep(800);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '133_bbox_comparison_synthetic_45deg.png'));

        // 4. Capture Botanical Umbrella Stone Pine
        console.log('[4/4] Switching to Mediterranean Umbrella Stone Pine Benchmark...');
        await cdp.eval('selectBenchmark(3);');
        await sleep(800);
        await cdp.screenshot(path.join(SCREENSHOT_DIR, '134_bbox_comparison_stone_pine.png'));

        console.log('\n🎉 All 4 Bounding Box Comparison screenshots successfully captured!');
    } finally {
        if (cdp) cdp.close();
        chromeProc.kill('SIGKILL');
        server.close();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

main().catch(err => {
    console.error('Fatal error during execution:', err);
    process.exit(1);
});
