const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_PATH = path.join(REPO_ROOT, 'docs/screenshots/130_sbhuman_canonical_neutral_standard.png');

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

    async eval(expr) {
        const res = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        return res.result ? res.result.value : undefined;
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
        if (reqPath === '/' || reqPath === '') reqPath = '/public/sbhuman_visual_proof.html';
        else if (!reqPath.startsWith('/public/') && !reqPath.startsWith('/models/')) reqPath = '/public' + reqPath;

        let filePath = path.join(REPO_ROOT, reqPath);
        if (!fs.existsSync(filePath)) {
            // Also check under public directly
            filePath = path.join(REPO_ROOT, 'public', decodeURI(req.url.split('?')[0]));
        }

        if (!fs.existsSync(filePath)) {
            res.writeHead(404);
            res.end('Not found: ' + req.url);
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
    console.log('=== SB-Human Visual Proof & Verification ===');
    const { server, port } = await startServer();

    const chromePort = 9312;
    const tmpDir = fs.mkdtempSync('/tmp/chrome_sbhuman_');
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
        await sleep(1500);
        const versionInfo = await getJson(`http://127.0.0.1:${chromePort}/json/version`);
        console.log(`[Chrome] Connected via CDP (${versionInfo['Browser']})`);

        const targets = await getJson(`http://127.0.0.1:${chromePort}/json/list`);
        const pageTarget = targets.find(t => t.type === 'page') || targets[0];
        cdp = new CdpConnection(pageTarget.webSocketDebuggerUrl);
        await cdp.connect();

        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');

        const studioUrl = `http://127.0.0.1:${port}/public/sbhuman_visual_proof.html`;
        console.log(`[Navigate] Loading ${studioUrl}...`);
        await cdp.send('Page.navigate', { url: studioUrl });

        console.log('[Wait] Awaiting __MODEL_LOADED__ signal...');
        let loaded = false;
        for (let i = 0; i < 40; i++) {
            await sleep(250);
            loaded = await cdp.eval('window.__MODEL_LOADED__ === true');
            if (loaded) break;
        }

        if (!loaded) {
            const status = await cdp.eval('document.getElementById("status-indicator")?.textContent');
            console.warn('[Warning] Model load timeout, status:', status);
        } else {
            console.log('✓ Model loaded into WebGL scene');
        }

        // Allow OrbitControls & rendering to settle
        await sleep(1000);

        await cdp.screenshot(SCREENSHOT_PATH);
        console.log('✓ Verification screenshot complete!');
    } finally {
        if (cdp) cdp.close();
        chromeProc.kill('SIGTERM');
        server.close();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
