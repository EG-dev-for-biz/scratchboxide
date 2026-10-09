const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/bec1637c-d213-4e3f-82c8-d1ddd168b931';
const PORT = 9225;
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TARGET_URL = 'http://127.0.0.1:3001/omnispatial_synthesis_demo.html';

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitForCdp(port, retries = 25) {
    for (let i = 0; i < retries; i++) {
        try {
            const list = await new Promise((resolve, reject) => {
                const req = http.get(`http://127.0.0.1:${port}/json/list`, res => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => resolve(JSON.parse(d)));
                });
                req.on('error', reject);
                req.setTimeout(1000, () => req.abort());
            });
            if (list && list.length > 0) return list;
        } catch {}
        await sleep(400);
    }
    throw new Error('CDP port failed to respond in time');
}

async function main() {
    console.log('[Critic Suite] Spawning Headless Chrome on CDP port', PORT);
    const chrome = spawn(CHROME_PATH, [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1920,1080',
        '--disable-gpu-shader-disk-cache',
        TARGET_URL
    ], { stdio: 'ignore' });

    chrome.on('exit', code => {
        console.log('[Critic Suite] Chrome exited with code', code);
    });

    try {
        const pages = await waitForCdp(PORT);
        const page = pages.find(p => p.type === 'page') || pages[0];
        console.log('[Critic Suite] Connected to page:', page.url);

        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => ws.on('open', r));

        let idCounter = 1;
        const call = (method, params = {}) => new Promise((resolve, reject) => {
            const id = idCounter++;
            const handler = msg => {
                const data = JSON.parse(msg);
                if (data.id === id) {
                    ws.off('message', handler);
                    if (data.error) reject(data.error);
                    else resolve(data.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });

        await call('Page.enable');
        await call('Runtime.enable');

        const evaluate = async (expr) => {
            const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
            return res.result ? res.result.value : null;
        };

        const capture = async (filename) => {
            const outPath = path.join(ARTIFACT_DIR, filename);
            const shot = await call('Page.captureScreenshot', { format: 'png' });
            const buf = Buffer.from(shot.data, 'base64');
            fs.writeFileSync(outPath, buf);
            console.log(`[Critic Suite] Captured ${filename} (${buf.length} bytes)`);
            return outPath;
        };

        // Wait for WebGL scene and 3D GLB models to fully mount
        console.log('[Critic Suite] Waiting 4.5s for initial GLB meshes and textures...');
        await sleep(4500);

        // 1. Capture Corner Orthogonality Zoom
        console.log('[Critic Suite] Switching to Corner Orthogonality Zoom...');
        await evaluate("setCameraView('corner')");
        await sleep(1500);
        await capture('omnispatial_critic_1_corner_ortho.png');

        // 2. Capture Fenestration 3D Inset Loupe
        console.log('[Critic Suite] Switching to Fenestration 3D Inset Loupe...');
        await evaluate("setCameraView('window')");
        await sleep(1500);
        await capture('omnispatial_critic_2_fenestration_inset.png');

        // 3. Capture Skyline Aerial Orbit View
        console.log('[Critic Suite] Switching to Skyline Aerial Orbit...');
        await evaluate("setCameraView('skyline')");
        await sleep(1500);
        await capture('omnispatial_critic_3_skyline_aerial.png');

        // 4. Toggle SpatialVectorDataService Cadastral Vector Intelligence
        console.log('[Critic Suite] Toggling Cadastral Vector Intelligence...');
        await evaluate("toggleVectorIntelligence()");
        await sleep(1200);
        await capture('omnispatial_critic_4_vector_cadastral.png');

        // 5. ADA Open-Domain Test: Alien Planet Test Query
        console.log('[Critic Suite] Executing ADA Open-Domain Query (Alien Planet Test)...');
        await evaluate("document.getElementById('location-query-input').value = 'Bioluminescent Mycelium Spire, Asteroid Ceti-Alpha'; executeLocationQuery();");
        // Wait for animated synthesis modal (5 steps x ~350ms + loading)
        await sleep(5000);
        await capture('omnispatial_critic_5_alien_planet_synthesis.png');

        ws.close();
        console.log('[Critic Suite] All critic captures completed successfully!');
    } finally {
        chrome.kill('SIGKILL');
    }
}

main().catch(err => {
    console.error('[Critic Suite Error]', err);
    process.exit(1);
});
