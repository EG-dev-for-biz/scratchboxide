/**
 * scripts/capture_final_verified_demo_views.cjs
 *
 * Captures pixel-perfect screenshots of omnispatial_synthesis_demo.html:
 * 1. Dual Split Mode: Left = Stage 1 (Clay), Right = Stage 3 (De-Lighted PBR Master)
 * 2. Wipe Slider Mode: 50% split comparing Stage 1 Clay to Stage 3 De-Lighted Master
 * 3. 3D Orbit Mode: Full interactive 3D model-viewer of Stage 3 Master
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('[Capture] Connecting to Chrome CDP...');
    const targets = await new Promise((res, rej) => {
        http.get('http://127.0.0.1:9222/json', r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res(JSON.parse(d)));
        }).on('error', rej);
    });

    const pageTarget = targets.find(t => t.type === 'page');
    if (!pageTarget) throw new Error('No page target found');

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));

    let msgId = 1;
    function sendCdp(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = msgId++;
            const timeout = setTimeout(() => {
                ws.off('message', onMsg);
                reject(new Error(`CDP ${method} timed out`));
            }, 30000);

            function onMsg(raw) {
                const data = JSON.parse(raw);
                if (data.id === id) {
                    clearTimeout(timeout);
                    ws.off('message', onMsg);
                    if (data.error) reject(new Error(data.error.message));
                    else resolve(data.result);
                }
            }
            ws.on('message', onMsg);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    console.log('[Capture] Navigating to omnispatial_synthesis_demo.html...');
    await sendCdp('Page.navigate', { url: 'http://127.0.0.1:3030/omnispatial_synthesis_demo.html' });
    await sleep(2500);

    // Disable auto-advance timers and set fresh image cache busters
    await sendCdp('Runtime.evaluate', {
        expression: `
            if (typeof clearPipelineTimeouts === 'function') clearPipelineTimeouts();
            window.__autoAdvance = false;
            
            // Force cache busting on stage images
            const t = Date.now();
            locationDatasets['colosseum'].stages[1].beauty = '/renders/colosseum/clean_stage1_clay.png?t=' + t;
            locationDatasets['colosseum'].stages[2].beauty = '/renders/colosseum/clean_stage2_vector.png?t=' + t;
            locationDatasets['colosseum'].stages[3].beauty = '/renders/colosseum/clean_stage3_master.png?t=' + t;
            
            document.getElementById('imgStage1').src = '/renders/colosseum/clean_stage1_clay.png?t=' + t;
            document.getElementById('imgStage3').src = '/renders/colosseum/clean_stage3_master.png?t=' + t;
            document.getElementById('imgWipeBase').src = '/renders/colosseum/clean_stage1_clay.png?t=' + t;
            document.getElementById('imgWipeOverlay').src = '/renders/colosseum/clean_stage3_master.png?t=' + t;

            const mv = document.getElementById('mainModelViewer');
            if (mv) {
                mv.setAttribute('interaction-prompt', 'none');
            }
        `
    });
    await sleep(1500);

    // 1. Dual Split Mode
    console.log('[Capture] Capturing Dual Split View (Left: Clay, Right: Master PBR)...');
    await sendCdp('Runtime.evaluate', {
        expression: `
            setViewMode('split');
            selectStage(3);
        `
    });
    await sleep(2000);

    let shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    let buf = Buffer.from(shot.data, 'base64');
    const dualPath = path.resolve('public/screenshots/colosseum_final_verified_dual_split.png');
    fs.writeFileSync(dualPath, buf);
    console.log(`     ✅ Dual Split saved: ${dualPath} (${(buf.length / 1024).toFixed(1)} KB)`);

    // 2. Wipe Slider Mode
    console.log('[Capture] Capturing Wipe Slider View (50% Clay vs Master PBR)...');
    await sendCdp('Runtime.evaluate', {
        expression: `
            setViewMode('wipe');
            const slider = document.getElementById('wipeSlider');
            if (slider) {
                slider.value = 50;
                slider.dispatchEvent(new Event('input'));
            }
        `
    });
    await sleep(2000);

    shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    buf = Buffer.from(shot.data, 'base64');
    const wipePath = path.resolve('public/screenshots/colosseum_final_verified_wipe_slider.png');
    fs.writeFileSync(wipePath, buf);
    console.log(`     ✅ Wipe Slider saved: ${wipePath} (${(buf.length / 1024).toFixed(1)} KB)`);

    // 3. 3D Orbit Mode with Stage 3 Master
    console.log('[Capture] Capturing 3D Orbit Mode (Master PBR with excised arch, de-lighted cavea & vector roads)...');
    await sendCdp('Runtime.evaluate', {
        expression: `
            setViewMode('orbit-3d');
            const mv = document.getElementById('mainModelViewer');
            if (mv) {
                mv.src = '/models/colosseum_stage3_master_pbr.glb';
                mv.removeAttribute('poster');
                mv.setAttribute('interaction-prompt', 'none');
                mv.setAttribute('camera-orbit', '-38deg 58deg 540m');
                mv.setAttribute('camera-target', '0m 10m 0m');
                mv.setAttribute('field-of-view', '32deg');
            }
        `
    });
    // Wait for WebGL PBR pipeline to compile shaders
    await sleep(4000);

    shot = await sendCdp('Page.captureScreenshot', { format: 'png', quality: 100 });
    buf = Buffer.from(shot.data, 'base64');
    const orbitPath = path.resolve('public/screenshots/colosseum_final_verified_3d_orbit.png');
    fs.writeFileSync(orbitPath, buf);
    console.log(`     ✅ 3D Orbit saved: ${orbitPath} (${(buf.length / 1024).toFixed(1)} KB)`);

    ws.close();
    console.log('[Capture] All final verified screenshots successfully generated!');
}

main().catch(err => {
    console.error('[Capture] Error:', err);
    process.exit(1);
});
