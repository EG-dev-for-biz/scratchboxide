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

async function waitForCdp(port, retries = 30) {
    for (let i = 0; i < retries; i++) {
        try {
            const list = await new Promise((resolve, reject) => {
                const req = http.get({
                    host: '127.0.0.1',
                    port: port,
                    path: '/json/list',
                    timeout: 1000
                }, res => {
                    let d = '';
                    res.on('data', c => d += c);
                    res.on('end', () => {
                        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.abort(); reject(new Error('timeout')); });
            });
            if (list && list.length > 0) return list;
        } catch {}
        await sleep(500);
    }
    throw new Error('CDP port failed to respond in time');
}

async function main() {
    console.log('[Critic Suite] Spawning Headless Chrome on CDP port', PORT);
    const chrome = spawn(CHROME_PATH, [
        '--headless=new',
        '--no-sandbox',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--user-data-dir=/tmp/cdp_chrome_omnispatial',
        `--remote-debugging-port=${PORT}`,
        '--window-size=1920,1080',
        TARGET_URL
    ], { stdio: 'inherit' });

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

        ws.on('message', msg => {
            const data = JSON.parse(msg);
            if (data.method === 'Console.messageAdded') {
                console.log('[Browser Console]', data.params.message.text);
            } else if (data.method === 'Runtime.exceptionThrown') {
                console.log('[Browser Exception]', data.params.exceptionDetails.text);
            }
        });

        await call('Page.enable');
        await call('Runtime.enable');
        await call('Console.enable');

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
        console.log('[Critic Suite] Waiting 3.5s for initial layout & plates...');
        await sleep(3500);

        // 1. Capture Default Dual Split View (Stage 1 Clay vs Stage 3 De-Lighted PBR)
        console.log('[Critic Suite] Capturing Default Dual Split (Stage 1 vs Stage 3)...');
        await evaluate("setViewMode('side-by-side'); selectStage(3); setRenderPass('beauty');");
        await sleep(1000);
        await capture('omnispatial_enhancement_dual_split.png');

        // 2. Select Stage 2 (Vector Refined Geometry)
        console.log('[Critic Suite] Selecting Stage 2 (Vector Refined)...');
        await evaluate("selectStage(2)");
        await sleep(1000);
        await capture('omnispatial_enhancement_stage2_vector.png');

        // 3. Switch to Interactive Wipe Split Slider Mode
        console.log('[Critic Suite] Switching to Wipe Split Slider Mode...');
        await evaluate("setViewMode('wipe'); selectStage(3);");
        await sleep(1000);
        await capture('omnispatial_enhancement_wipe_slider.png');

        // 4. Switch to Albedo Pass (De-Lighted Diffuse)
        console.log('[Critic Suite] Switching to Albedo Pass (De-Lighted Diffuse)...');
        await evaluate("setViewMode('side-by-side'); setRenderPass('albedo'); selectStage(3);");
        await sleep(1000);
        await capture('omnispatial_enhancement_delighted_albedo.png');

        // 5. Switch to Normal Pass
        console.log('[Critic Suite] Switching to Surface Normals Buffer Pass...');
        await evaluate("setRenderPass('normal');");
        await sleep(1000);
        await capture('omnispatial_enhancement_normals_pass.png');

        // 6. Switch to Depth Pass
        console.log('[Critic Suite] Switching to Metric Depth Buffer Pass...');
        await evaluate("setRenderPass('depth');");
        await sleep(1000);
        await capture('omnispatial_enhancement_depth_pass.png');

        // 7. Test Elevation Stratification Slider
        console.log('[Critic Suite] Testing Elevation Stratification Slider...');
        await evaluate("setRenderPass('beauty'); document.getElementById('stratSlider').value = 28; updateStratHeight(28);");
        await sleep(1000);
        await capture('omnispatial_enhancement_elevation_stratification.png');

        // 8. Test Interactive 3D Orbit Viewport (<model-viewer> Zero Three.js)
        console.log('[Critic Suite] Testing Interactive 3D Orbit Viewport (<model-viewer>)...');
        await evaluate("setViewMode('orbit-3d'); switchOrbitModel(3);");
        await sleep(4000); // Give model-viewer time to stream GLB
        const mvStatus = await evaluate(`
            const mv = document.getElementById('mainModelViewer');
            ({
                defined: !!window.customElements.get('model-viewer'),
                loaded: mv ? mv.loaded : false,
                src: mv ? mv.src : null,
                modelIsVisible: mv ? mv.modelIsVisible : false
            })
        `);
        console.log('[Critic Suite] ModelViewer status:', JSON.stringify(mvStatus));
        await capture('omnispatial_enhancement_3d_orbit.png');

        // 9. Test Detail Loupe Mode (2.5x Magnification)
        console.log('[Critic Suite] Testing Detail Loupe Mode...');
        await evaluate(`
            setViewMode('loupe');
            selectStage(3);
            setRenderPass('beauty');
            const glass = document.getElementById('loupeGlass');
            const rect = document.getElementById('imgLoupeBase').getBoundingClientRect();
            const x = rect.width * 0.52;
            const y = rect.height * 0.45;
            glass.style.display = 'block';
            glass.style.left = x + 'px';
            glass.style.top = y + 'px';
            glass.style.backgroundImage = 'url(' + document.getElementById('imgLoupeBase').src + ')';
            glass.style.backgroundSize = (rect.width * 2.5) + 'px ' + (rect.height * 2.5) + 'px';
            glass.style.backgroundPosition = '-' + (x * 2.5 - 140) + 'px -' + (y * 2.5 - 140) + 'px';
        `);
        await sleep(1500);
        await capture('omnispatial_enhancement_detail_loupe.png');

        // 10. Test Macro 1:1 Ground-Truth Facade View
        console.log('[Critic Suite] Testing 1:1 Macro Facade Dual Split...');
        await evaluate("setViewMode('side-by-side'); selectStage(3); setRenderPass('beauty'); toggleCameraFraming();");
        await sleep(1000);
        await capture('omnispatial_enhancement_macro_1to1.png');

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
