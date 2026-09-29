const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const http = require('http');

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

async function run() {
    console.log('🚀 Launching Chrome CDP for Nanite Google 3D Tiles Visual Verification...');
    const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const remotePort = 9239;

    const chromeProc = spawn(chromePath, [
        '--headless',
        '--disable-gpu-sandbox',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        `--remote-debugging-port=${remotePort}`,
        '--window-size=1600,1000'
    ]);

    let targets = null;
    let targetWs = null;
    for (let i = 0; i < 30; i++) {
        await sleep(250);
        try {
            targets = await getJson(`http://127.0.0.1:${remotePort}/json`);
            const page = targets && targets.find(t => t.type === 'page');
            if (page && page.webSocketDebuggerUrl) {
                targetWs = page.webSocketDebuggerUrl;
                break;
            }
        } catch {}
    }

    if (!targetWs) {
        console.error('Failed to find Chrome page target');
        chromeProc.kill();
        process.exit(1);
    }

    const cdp = new CdpConnection(targetWs);
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    console.log('Navigating to Nanite Meshlets Studio (loading Rome Colosseum Google 3D Tile)...');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/nanite_meshlet_pathtracing_studio.html' });

    // Wait for studio ready and Colosseum partitioned
    console.log('Waiting for WebGL studio and 170.8K Colosseum tile to settle...');
    for (let i = 0; i < 40; i++) {
        await sleep(350);
        try {
            const ready = await cdp.eval('window.__STUDIO_READY__ === true && clusters.length > 1000');
            if (ready) break;
        } catch {}
    }
    await sleep(2000);

    // 1. Rome Colosseum Full Meshlet Clusters
    console.log('Capture 1: Rome Colosseum Google 3D Tile in 1,370+ Meshlet Clusters...');
    await cdp.eval(`
        camera.position.set(-34, 25, 42);
        controls.target.set(0, 6, 0);
        controls.update();
        updateLODCut();
    `);
    await sleep(800);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '63_colosseum_meshlets_full_glbtile.png'));

    // 2. Exploded Meshlets in 3D Space
    console.log('Capture 2: Exploded Meshlets Slider (4.5m radial displacement)...');
    await cdp.eval(`
        document.getElementById('explode-slider').value = '4.5';
        document.getElementById('explode-slider').dispatchEvent(new Event('input'));
    `);
    await sleep(800);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '64_colosseum_exploded_clusters.png'));

    // Collapse explode back to 0
    await cdp.eval(`
        document.getElementById('explode-slider').value = '0';
        document.getElementById('explode-slider').dispatchEvent(new Event('input'));
    `);
    await sleep(500);

    // 3. Google Photogrammetric Texture Mode with Meshlet Wireframe Overlay
    console.log('Capture 3: Google Photogrammetric Texture Mode on Rome Colosseum...');
    await cdp.eval(`
        document.querySelector('[data-mode="texture"]').click();
        document.getElementById('lighting-preset').value = 'golden';
        document.getElementById('lighting-preset').dispatchEvent(new Event('change'));
    `);
    await sleep(1000);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '65_colosseum_google_texture_mode.png'));

    // 4. Rome Colosseum in Progressive Path-Traced GI
    console.log('Capture 4: Rome Colosseum in Progressive Path-Traced GI...');
    await cdp.eval(`
        document.querySelector('[data-mode="pathtrace"]').click();
    `);
    await sleep(1500);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '66_colosseum_pathtraced_gi_golden.png'));

    // 4b. Interactive 50/50 Comparison Wipe
    console.log('Capture 4b: Interactive 50/50 Comparison Wipe (Traditional B3DM vs Nanite)...');
    await cdp.eval(`
        if (!splitViewActive) document.getElementById('btn-split-view').click();
    `);
    await sleep(1000);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '68_split_screen_comparison_wipe.png'));

    // 4c. Automated Flyby LOD Stability Test
    console.log('Capture 4c: Automated Flyby LOD Stability Test...');
    await cdp.eval(`
        if (!flybyActive) document.getElementById('btn-flyby-test').click();
    `);
    await sleep(1800);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '69_split_screen_flyby_dolly.png'));
    await cdp.eval(`
        if (flybyActive) document.getElementById('btn-flyby-test').click();
        if (splitViewActive) document.getElementById('btn-split-view').click();
    `);
    await sleep(500);

    // 5. NYC Grand Army Plaza Real Google 3D Tile
    console.log('Capture 5: NYC Grand Army Plaza Real Google 3D Tile (91.8K Tris, 760+ Clusters)...');
    await cdp.eval(`
        document.getElementById('model-select').value = 'grand_army_plaza';
        loadPreset('grand_army_plaza');
    `);
    await sleep(3000); // Allow loading and partitioning
    await cdp.eval(`
        document.querySelector('[data-mode="meshlets"]').click();
        camera.position.set(-30, 28, 48);
        controls.target.set(0, 10, 0);
        controls.update();
        updateLODCut();
    `);
    await sleep(1000);
    await cdp.screenshot(path.join(SCREENSHOT_DIR, '67_nyc_grand_army_plaza_clusters.png'));

    cdp.close();
    chromeProc.kill();
    console.log('✅ Finished capturing all 5 Nanite Google 3D Tile visual verification screenshots!');
}

run().catch(err => {
    console.error('Runner error:', err);
    process.exit(1);
});
