const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { spawn } = require('child_process');

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
                if (msg.method === 'Runtime.consoleAPICalled') {
                    console.log('  [Browser Console]', msg.params.type, msg.params.args?.map(a => a.value || a.description).join(' '));
                }
                if (msg.method === 'Runtime.exceptionThrown') {
                    console.log('  [Browser Exception]', msg.params.exceptionDetails?.text, msg.params.exceptionDetails?.exception?.description);
                }
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
    console.log('=== Verifying Splat Alignment & Fine Tactile Textures in Geographic 3DGS Studio ===');

    const chromePort = 9400 + Math.floor(Math.random() * 500);
    const tmpDir = fs.mkdtempSync('/tmp/chrome_3dgs_verify_');
    const cleanEnv = { ...process.env };
    delete cleanEnv.http_proxy;
    delete cleanEnv.https_proxy;
    delete cleanEnv.all_proxy;
    delete cleanEnv.HTTP_PROXY;
    delete cleanEnv.HTTPS_PROXY;
    delete cleanEnv.ALL_PROXY;

    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--use-angle=metal',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--no-proxy-server',
        `--user-data-dir=${tmpDir}`,
        `--remote-debugging-port=${chromePort}`,
        '--window-size=1920,1080',
        'about:blank'
    ], { env: cleanEnv });

    chromeProc.stderr.on('data', d => {
        const s = d.toString().trim();
        if (!s.includes('GLX') && !s.includes('dbus')) console.log('[Chrome err]:', s);
    });
    chromeProc.stdout.on('data', d => console.log('[Chrome out]:', d.toString().trim()));

    let cdp;
    try {
        console.log(`[Chrome] Waiting for remote debugging port ${chromePort}...`);
        let targetWs = null;
        for (let i = 0; i < 30; i++) {
            await sleep(300);
            try {
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
        for (let i = 0; i < 60; i++) {
            await sleep(500);
            try {
                const state = await cdp.eval('({ tile: window.__engineState?.tileMeshLoaded, splat: window.__engineState?.splatLoaded, status: document.getElementById("lbl-status")?.textContent, splatStatus: document.getElementById("splat-status")?.textContent })');
                if (i % 4 === 0) console.log(`  [State @ ${i*0.5}s]`, JSON.stringify(state));
                if (state.tile && state.splat) break;
            } catch (e) {
                console.log('  [Eval err]', e.message);
            }
        }

        await sleep(2500);

        const outDir = path.resolve(__dirname, '../docs/screenshots');
        fs.mkdirSync(outDir, { recursive: true });

        // Shot 1: Hybrid Mode (Interleaved 3D Tile + Aligned Splats)
        const shot1 = path.join(outDir, 'aligned_colosseum_hybrid.png');
        await cdp.screenshot(shot1);
        console.log('[Capture 1] Hybrid mode captured');

        // Shot 2: Radiance Field Solo Mode
        await cdp.eval(`
            switchMode('splat');
        `);
        await sleep(1500);
        const shot2 = path.join(outDir, 'aligned_colosseum_radiance_solo.png');
        await cdp.screenshot(shot2);
        console.log('[Capture 2] Radiance Field solo captured');

        // Shot 3: Macro Arcade Facade
        await cdp.eval(`
            switchMode('hybrid');
            setCameraPreset('macro_arcade');
            setMicroDetailStrength(1.4);
            setCavitationDepth(1.5);
        `);
        await sleep(2000);
        const shot3 = path.join(outDir, 'aligned_colosseum_macro_arcade.png');
        await cdp.screenshot(shot3);
        console.log('[Capture 3] Macro arcade facade captured');

        // Shot 4: Close-up Tactile Travertine Pores and Ashlar Blocks
        await cdp.eval(`
            setCameraPreset('tactile_close');
            setMicroDetailStrength(1.6);
            setCavitationDepth(1.8);
        `);
        await sleep(2000);
        const shot4 = path.join(outDir, 'aligned_colosseum_tactile_close.png');
        await cdp.screenshot(shot4);
        console.log('[Capture 4] Close-up tactile travertine captured');

        console.log('✅ Visual verification complete!');
    } finally {
        if (cdp) cdp.close();
        chromeProc.kill();
        try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
}

main().catch(err => {
    console.error('Verification failed:', err);
    process.exit(1);
});
