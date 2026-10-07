const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = 9335;
const APP_URL = 'http://127.0.0.1:3030';
const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/97b137e8-ad3d-47ff-a3ae-59e570b58f77';
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, 'benthic_probe_frontend_ui_verification.png');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
            });
        }).on('error', reject);
    });
}

async function main() {
    console.log(`[Frontend UI Verification] Launching Chrome on CDP port ${CDP_PORT}...`);
    const tmpDir = fs.mkdtempSync('/tmp/chrome_frontend_verify_cdp_');
    const chromeProc = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
        '--headless=new',
        '--no-sandbox',
        '--use-gl=angle',
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--remote-allow-origins=*',
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${tmpDir}`,
        '--window-size=1680,1050',
        'about:blank'
    ]);

    let targetWs = null;
    for (let i = 0; i < 40; i++) {
        try {
            await sleep(250);
            const targets = await getJson(`http://127.0.0.1:${CDP_PORT}/json`);
            const pageTarget = targets && targets.find(t => t.type === 'page');
            if (pageTarget && pageTarget.webSocketDebuggerUrl) {
                targetWs = pageTarget.webSocketDebuggerUrl;
                break;
            }
        } catch (e) {}
    }

    if (!targetWs) {
        chromeProc.kill('SIGKILL');
        throw new Error(`Could not connect to Chrome on port ${CDP_PORT}`);
    }

    console.log('[Frontend UI Verification] Connected to Chrome DevTools WebSocket: ' + targetWs);
    const ws = new WebSocket(targetWs);

    await new Promise(resolve => ws.on('open', resolve));

    let idCounter = 1;
    function sendCdp(method, params = {}) {
        return new Promise((resolve, reject) => {
            const msgId = idCounter++;
            const handler = (data) => {
                const msg = JSON.parse(data);
                if (msg.id === msgId) {
                    ws.off('message', handler);
                    if (msg.error) reject(msg.error);
                    else resolve(msg.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id: msgId, method, params }));
        });
    }

    // Enable domains
    await sendCdp('Page.enable');
    await sendCdp('Runtime.enable');
    await sendCdp('DOM.enable');

    console.log(`[Frontend UI Verification] Navigating to ${APP_URL}...`);
    await sendCdp('Page.navigate', { url: APP_URL });

    // Wait for page to load and studio to initialize
    console.log('[Frontend UI Verification] Waiting for Scratchbox IDE UI to initialize...');
    let ready = false;
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        const evalRes = await sendCdp('Runtime.evaluate', {
            expression: 'typeof window.__scratchbox_send_prompt === "function" || document.querySelector(".sb-cursor-composer-textarea") !== null'
        });
        if (evalRes?.result?.value === true) {
            ready = true;
            console.log(`[Frontend UI Verification] Scratchbox IDE UI initialized (attempt ${i + 1})`);
            break;
        }
    }

    if (!ready) {
        console.warn('[Frontend UI Verification] Warning: __scratchbox_send_prompt not detected directly, checking textarea...');
    }

    // Prompt to test
    const userPrompt = 'Design an autonomous deep-trench benthic probe with dual rotary coring drills, multi-segment hydraulic manipulator limbs, and isoparametric heat-sink fluting in grey clay';
    console.log(`[Frontend UI Verification] Dispatching prompt: "${userPrompt}"`);

    const dispatchResult = await sendCdp('Runtime.evaluate', {
        expression: `
            (function() {
                if (typeof window.__scratchbox_send_prompt === 'function') {
                    window.__scratchbox_send_prompt(${JSON.stringify(userPrompt)});
                    return { dispatched: true, method: '__scratchbox_send_prompt' };
                }
                const textarea = document.querySelector('.sb-cursor-composer-textarea');
                if (textarea) {
                    textarea.value = ${JSON.stringify(userPrompt)};
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    return { dispatched: true, method: 'textarea_enter' };
                }
                return { dispatched: false, error: 'no_input_found' };
            })()
        `,
        returnByValue: true
    });

    console.log('[Frontend UI Verification] Dispatch result:', JSON.stringify(dispatchResult.result.value));

    // Wait for the 3D scene artifact to appear and GLB to be rendered in Three.js
    console.log('[Frontend UI Verification] Waiting for Gemini backend & 3D Python runner to complete...');
    let generationStarted = false;
    let artifactReady = false;

    for (let i = 0; i < 240; i++) {
        await sleep(1000);
        const stateRes = await sendCdp('Runtime.evaluate', {
            expression: `
                (function() {
                    const isGen = !!window.__scratchbox_is_generating;
                    const art = window.__scratchbox_active_artifact;
                    const canvas = document.querySelector('canvas');
                    const thinkingEl = document.querySelector('.sb-thinking, [class*="thinking"]');
                    return {
                        isGenerating: isGen,
                        hasArtifact: !!art,
                        artifactType: art ? art.type : null,
                        artifactTitle: art ? art.title : null,
                        hasGlb: !!(art && art.data && art.data.pythonGenerator && art.data.pythonGenerator.glbBase64),
                        hasCanvas: !!canvas,
                        canvasWidth: canvas ? canvas.width : 0,
                        canvasHeight: canvas ? canvas.height : 0,
                        thinkingText: thinkingEl ? thinkingEl.innerText.slice(0, 100) : '',
                        lastMsg: (function() {
                            const msgs = document.querySelectorAll('[class*="message"], [class*="chat"]');
                            return msgs.length > 0 ? msgs[msgs.length - 1].innerText.replace(/\n+/g, ' ').slice(0, 150) : '';
                        })()
                    };
                })()
            `,
            returnByValue: true
        });

        const state = stateRes?.result?.value;
        if (state) {
            if (state.isGenerating) {
                generationStarted = true;
                if ((i + 1) % 5 === 0) {
                    console.log(`[Frontend UI Verification] Generating in progress (${i + 1}s elapsed)... thinking: ${state.thinkingText || 'active'}`);
                }
            }
            if (generationStarted && !state.isGenerating) {
                console.log(`\n[Frontend UI Verification] Generation finished! Artifact: "${state.artifactTitle}", GLB present: ${state.hasGlb} (elapsed: ${i + 1}s)`);
                console.log(`[Frontend UI Verification] Latest message preview: ${state.lastMsg}`);
                artifactReady = true;
                break;
            }
        }
    }

    console.log('[Frontend UI Verification] Settling Three.js viewport render...');
    await sleep(5000);

    const sceneStatsRes = await sendCdp('Runtime.evaluate', {
        expression: `
            (function() {
                const art = window.__scratchbox_active_artifact;
                return {
                    title: art ? art.title : 'None',
                    type: art ? art.type : 'None',
                    renderMode: art && art.data ? art.data.renderMode : 'None',
                    hasGlb: !!(art && art.data && art.data.pythonGenerator && art.data.pythonGenerator.glbBase64),
                    glbLength: (art && art.data && art.data.pythonGenerator && art.data.pythonGenerator.glbBase64) ? art.data.pythonGenerator.glbBase64.length : 0
                };
            })()
        `,
        returnByValue: true
    });
    console.log('[Frontend UI Verification] Active 3D Artifact details:', JSON.stringify(sceneStatsRes.result.value, null, 2));

    console.log('[Frontend UI Verification] Capturing full UI screenshot...');
    const screenshot = await sendCdp('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false
    });

    const buffer = Buffer.from(screenshot.data, 'base64');
    fs.writeFileSync(SCREENSHOT_PATH, buffer);
    console.log(`[Frontend UI Verification] Full UI screenshot saved: ${SCREENSHOT_PATH} (${(buffer.length / 1024).toFixed(1)} KB)`);

    // Also capture viewport canvas clip if available
    const VIEWPORT_PATH = path.resolve('/Users/eligreen/.gemini/antigravity/brain/97b137e8-ad3d-47ff-a3ae-59e570b58f77/benthic_probe_viewport_only.png');
    const canvasBoxRes = await sendCdp('Runtime.evaluate', {
        expression: `
            (function() {
                const canvas = document.querySelector('canvas');
                if (!canvas) return null;
                const rect = canvas.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            })()
        `,
        returnByValue: true
    });
    const clipBox = canvasBoxRes?.result?.value;
    if (clipBox && clipBox.width > 50 && clipBox.height > 50) {
        const vpScreenshot = await sendCdp('Page.captureScreenshot', {
            format: 'png',
            clip: {
                x: clipBox.x,
                y: clipBox.y,
                width: clipBox.width,
                height: clipBox.height,
                scale: 1
            }
        });
        const vpBuffer = Buffer.from(vpScreenshot.data, 'base64');
        fs.writeFileSync(VIEWPORT_PATH, vpBuffer);
        console.log(`[Frontend UI Verification] Viewport screenshot saved: ${VIEWPORT_PATH} (${(vpBuffer.length / 1024).toFixed(1)} KB)`);
    }

    // Clean up
    ws.close();
    chromeProc.kill('SIGKILL');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}

    console.log('[Frontend UI Verification] Verification run complete!');
}

main().catch(err => {
    console.error('[Frontend UI Verification] Fatal error:', err);
    process.exit(1);
});
