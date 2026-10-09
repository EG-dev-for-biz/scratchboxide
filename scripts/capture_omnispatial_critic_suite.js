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

        // Wait for page and images to load
        console.log('[Critic Suite] Waiting 2.5s for initial layout & plates...');
        await sleep(2500);

        // 1. Capture Default Dual Split View (Stage 1 Clay vs Stage 3 Street View PBR)
        console.log('[Critic Suite] Capturing Default Dual Split (Stage 1 vs Stage 3)...');
        await capture('omnispatial_critic_v3_dual_split.png');

        // 2. Select Stage 2 (Vector Refined Geometry)
        console.log('[Critic Suite] Selecting Stage 2 (Vector Refined)...');
        await evaluate("selectStage(2)");
        await sleep(800);
        await capture('omnispatial_critic_v3_stage2_vector_refined.png');

        // 3. Switch to Interactive Wipe Split Slider Mode
        console.log('[Critic Suite] Switching to Wipe Split Slider Mode...');
        await evaluate("setViewMode('wipe'); selectStage(3);");
        await sleep(800);
        await capture('omnispatial_critic_v3_wipe_slider.png');

        // 4. Switch to Normal Pass
        console.log('[Critic Suite] Switching to Surface Normals Buffer Pass...');
        await evaluate("setViewMode('side-by-side'); setRenderPass('normal'); selectStage(3);");
        await sleep(800);
        await capture('omnispatial_critic_v3_normal_pass.png');

        // 5. Switch to Depth Pass
        console.log('[Critic Suite] Switching to Metric Depth Buffer Pass...');
        await evaluate("setRenderPass('depth');");
        await sleep(800);
        await capture('omnispatial_critic_v3_depth_pass.png');

        // 6. Test Address / Location Query Prompt Box Execution
        console.log('[Critic Suite] Testing Address Query Prompt Box with Rockefeller Center...');
        await evaluate("loadLocation('45 Rockefeller Plaza, New York, NY 10111 (Rockefeller Center)'); setRenderPass('beauty');");
        await sleep(1500);
        await capture('omnispatial_critic_v3_address_query.png');

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
