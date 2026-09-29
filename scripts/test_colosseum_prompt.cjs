const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

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
        console.log(`📸 Saved screenshot: ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
    }
    close() {
        try { this.ws.close(); } catch {}
    }
}

async function run() {
    const { spawn } = require('child_process');
    const chromePort = 9295;
    const tmpDir = fs.mkdtempSync('/tmp/chrome_colosseum_test_');
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

    try {
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
        if (!targetWs) throw new Error('Failed to find Chrome WebSocket');

        const cdp = new CdpConnection(targetWs);
        await cdp.connect();
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');

        await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/tile_restructuring_demo.html' });
        await sleep(2500);

        console.log('1. Selecting Colosseum in demo...');
        await cdp.eval(`window.onLandmarkSelect('colosseum')`);
        await sleep(2500);

        console.log('2. Entering prompt "Restructure this tile as the colosseum is brand-new" and executing...');
        await cdp.eval(`
            document.getElementById('prompt-input').value = 'Restructure this tile as the colosseum is brand-new';
            window.executePrompt();
        `);
        await sleep(4000);

        const outScreenshot = path.resolve(__dirname, '../docs/screenshots/131_colosseum_brand_new_restructured.png');
        await cdp.screenshot(outScreenshot);
        cdp.close();
    } finally {
        try { chromeProc.kill('SIGKILL'); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

run().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
