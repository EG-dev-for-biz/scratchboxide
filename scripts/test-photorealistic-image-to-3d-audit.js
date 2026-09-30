const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Enable WebGL & hardware acceleration
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('use-gl', 'angle');

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b';
fs.ensureDirSync(ARTIFACT_DIR);

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 3236;
const TOOLS_PORT = 3237;

process.env.SCRATCHBOX_ALLOWED_ORIGINS = `http://${BACKEND_HOST}:${BACKEND_PORT},http://localhost:${BACKEND_PORT}`;

let serverInstance = null;
let toolsServerInstance = null;

async function startServer() {
    const { createStandaloneServer, createToolsServer, resolveLaunchToken } = require('../desktop-app/dist-electron/desktop-app/server/app');
    const launchToken = resolveLaunchToken();
    process.env.SCRATCHBOX_LAUNCH_TOKEN = launchToken;

    const staticDir = path.resolve(__dirname, '../desktop-app/dist');
    const serverApp = createStandaloneServer({
        port: BACKEND_PORT,
        staticDir,
        toolsPort: TOOLS_PORT
    });

    await new Promise((resolve, reject) => {
        serverInstance = serverApp.listen(BACKEND_PORT, BACKEND_HOST, () => {
            console.log(`[Audit Runner] Standalone server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
            resolve();
        });
        serverInstance.on('error', reject);
    });

    const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
    await new Promise((resolve, reject) => {
        toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
            console.log(`[Audit Runner] Tools server listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
            resolve();
        });
        toolsServerInstance.on('error', reject);
    });

    return launchToken;
}

app.whenReady().then(async () => {
    try {
        const launchToken = await startServer();
        const apiBase = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

        ipcMain.handle('scratchbox:get-launch-token', () => launchToken);

        const win = new BrowserWindow({
            width: 1600,
            height: 1000,
            show: false,
            webPreferences: {
                preload: path.resolve(__dirname, '../desktop-app/dist-electron/desktop-app/electron/preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: false,
                additionalArguments: [
                    `--scratchbox-token=${launchToken}`,
                    `--scratchbox-api-base=${apiBase}`
                ]
            }
        });

        win.webContents.on('console-message', (e, level, msg, line, src) => {
            console.log(`[Browser Console] ${msg}`);
        });

        console.log('[Audit Runner] Loading app URL:', apiBase);
        await win.loadURL(apiBase);

        console.log('[Audit Runner] Waiting for UI to mount...');
        await new Promise(r => setTimeout(r, 4500));

        // Helper to mount an artifact directly via window.dispatchEvent or IDE canvas store
        async function mountDirectScene(sceneData) {
            return await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                    const sceneId = 'scene-audit-' + Date.now();
                    const artifact = {
                        id: sceneId,
                        type: '3d-scene',
                        title: ${JSON.stringify(sceneData.title || '3D Scene Audit')},
                        data: ${JSON.stringify(sceneData)},
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };

                    // Dispatch custom event that Canvas Studio or Redux listens to
                    window.dispatchEvent(new CustomEvent('scratchbox:mount-artifact', { detail: { artifact } }));
                    
                    // Also attempt to push directly to generative canvas store if exposed
                    if (window.__scratchboxCanvasStore && window.__scratchboxCanvasStore.mountArtifact) {
                        window.__scratchboxCanvasStore.mountArtifact(artifact);
                    }

                    setTimeout(() => resolve(true), 1500);
                })
            `);
        }

        // Helper to submit via chat if direct event isn't hooked
        async function submitPrompt(promptText) {
            await win.webContents.executeJavaScript(`
                new Promise((resolve, reject) => {
                    const start = Date.now();
                    const interval = setInterval(() => {
                        const textarea = document.querySelector('textarea.sb-composer-main-input, textarea');
                        if (textarea && !textarea.disabled) {
                            clearInterval(interval);
                            
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                            nativeInputValueSetter.call(textarea, ${JSON.stringify(promptText)});
                            textarea.dispatchEvent(new Event('input', { bubbles: true }));
                            textarea.dispatchEvent(new Event('change', { bubbles: true }));

                            setTimeout(() => {
                                const sendBtn = document.querySelector('.sb-composer-send-circle') ||
                                                Array.from(document.querySelectorAll('button')).find(b => b.title && b.title.includes('Send'));
                                if (sendBtn) {
                                    sendBtn.click();
                                } else {
                                    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                                }
                                resolve(true);
                            }, 500);
                        } else if (Date.now() - start > 45000) {
                            clearInterval(interval);
                            reject(new Error('Timeout waiting for composer textarea'));
                        }
                    }, 500);
                })
            `);
        }

        async function waitForGenerationComplete(expectedAssistantIndex, timeoutMs = 95000) {
            const completed = await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                    const start = Date.now();
                    const interval = setInterval(() => {
                        const textarea = document.querySelector('textarea.sb-composer-main-input, textarea');
                        const isGenerating = textarea ? textarea.disabled : false;
                        const hasRunningStepper = !!document.querySelector('.sb-streaming-bubble, .sb-agent-stepper-generating, .sb-ide-msg-thinking');
                        const assistantRows = Array.from(document.querySelectorAll('.sb-msg-assistant-row')).filter(r => !r.querySelector('.sb-ide-msg-thinking') && !r.classList.contains('sb-ide-msg-thinking'));
                        const lastAssistantRow = assistantRows[assistantRows.length - 1];
                        
                        const hasCount = assistantRows.length >= ${expectedAssistantIndex};
                        const hasChip = lastAssistantRow && !!lastAssistantRow.querySelector('.sb-chat-artifact-chip');
                        const hasText = lastAssistantRow && /(?:Executed|Procedural|3D|Synthesiz|Generat|Reconstruct|Model|Render|Build|Scene|Astra)/i.test(lastAssistantRow.innerText);
                        const hasFinished = lastAssistantRow && (hasChip || hasText);

                        if (hasCount && !isGenerating && !hasRunningStepper && hasFinished) {
                            clearInterval(interval);
                            resolve(true);
                        } else if (Date.now() - start > ${timeoutMs}) {
                            clearInterval(interval);
                            resolve(false);
                        }
                    }, 500);
                })
            `);
            if (!completed) {
                console.warn('[Audit Runner] Warning: waitForGenerationComplete reached timeout or fallback.');
            }
        }

        async function activate3DTab(sceneKeyword) {
            await win.webContents.executeJavaScript(`
                (() => {
                    function triggerClick(el) {
                        if (!el) return;
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                        el.click();
                    }

                    const canvasTabs = Array.from(document.querySelectorAll('.sb-canvas-tab'));
                    const kw = ${JSON.stringify(sceneKeyword || '')}.toLowerCase();
                    let targetTab = null;
                    if (kw && canvasTabs.length > 0) {
                        targetTab = canvasTabs.find(t => (t.innerText || '').toLowerCase().includes(kw) || (t.title || '').toLowerCase().includes(kw));
                    }
                    if (targetTab) {
                        triggerClick(targetTab);
                        return;
                    }

                    const assistantRows = Array.from(document.querySelectorAll('.sb-msg-assistant-row')).filter(r => !r.querySelector('.sb-ide-msg-thinking'));
                    const lastRow = assistantRows[assistantRows.length - 1];
                    if (lastRow) {
                        const openBtn = lastRow.querySelector('.sb-chip-action-btn') || Array.from(lastRow.querySelectorAll('button')).find(b => b.innerText && b.innerText.includes('Open 3D'));
                        if (openBtn) {
                            triggerClick(openBtn);
                            return;
                        }
                        const chip = lastRow.querySelector('.sb-chat-artifact-chip');
                        if (chip) {
                            triggerClick(chip);
                            return;
                        }
                    }

                    if (canvasTabs.length > 0) {
                        const unselected = canvasTabs.find(t => !t.classList.contains('active'));
                        triggerClick(unselected || canvasTabs[canvasTabs.length - 1]);
                    }
                })()
            `);
            await new Promise(r => setTimeout(r, 2500));
        }

        // =========================================================================
        // CASE A: Parametric Procedural PBR Mudbrick Ziggurat (with Auto-Framing)
        // =========================================================================
        console.log('[Audit Runner] --- Testing Case A: Parametric Procedural PBR Ziggurat ---');
        const promptA = 'Reconstruct the ancient Babylonian Ziggurat Observatory (Etemenanki) with mudbrick base, lapis lazuli tier, gold sanctuary, astrolabe rings, and sunset lighting in 3D: scene_2_photorealistic_final.png';
        console.log(`[Audit Runner] Sending Prompt A: "${promptA}"...`);
        await submitPrompt(promptA);
        await waitForGenerationComplete(1, 95000);
        await activate3DTab('babylo');

        await new Promise(r => setTimeout(r, 3000));
        const diagA = await win.webContents.executeJavaScript(`
            (() => {
                const s = window.__SB_3D_SCENE__;
                const c = window.__SB_3D_CAMERA__;
                if (!s || !c) return { error: 'No scene or camera' };
                return {
                    camPos: [c.position.x, c.position.y, c.position.z],
                    camNear: c.near,
                    camFar: c.far,
                    childCount: s.children.length,
                    children: s.children.map(ch => ({
                        name: ch.name || ch.type,
                        visible: ch.visible,
                        pos: [ch.position.x, ch.position.y, ch.position.z]
                    }))
                };
            })()
        `);
        console.log('[Audit Runner] Case A Diag:', JSON.stringify(diagA, null, 2));

        console.log('[Audit Runner] Capturing Screenshot Case A: screenshot_case_a_procedural_pbr_ziggurat.png...');
        const imgA = await win.webContents.capturePage();
        const pathA = path.join(ARTIFACT_DIR, 'screenshot_case_a_procedural_pbr_ziggurat.png');
        fs.writeFileSync(pathA, imgA.toPNG());
        console.log('[Audit Runner] Saved Screenshot Case A to:', pathA);

        // =========================================================================
        // CASE B: 3DGS Gaussian Splat Pipeline Tool Ingestion
        // =========================================================================
        console.log('[Audit Runner] --- Testing Case B: 3DGS Single Image Reconstruction ---');
        const promptB = 'Load and display the 3D Gaussian Splat reconstruction for the Babylonian Ziggurat from /splats/scene_2_photorealistic_final.splat in a 3D scene';
        console.log(`[Audit Runner] Sending Prompt B: "${promptB}"...`);
        await submitPrompt(promptB);
        await waitForGenerationComplete(2, 95000);
        await activate3DTab('splat');

        await new Promise(r => setTimeout(r, 4000));
        const diagB = await win.webContents.executeJavaScript(`
            (() => {
                const s = window.__SB_3D_SCENE__;
                const c = window.__SB_3D_CAMERA__;
                if (!s || !c) return { error: 'No scene or camera' };
                return {
                    camPos: [c.position.x, c.position.y, c.position.z],
                    camNear: c.near,
                    camFar: c.far,
                    childCount: s.children.length,
                    children: s.children.map(ch => ({
                        name: ch.name || ch.type,
                        visible: ch.visible,
                        pos: [ch.position.x, ch.position.y, ch.position.z]
                    }))
                };
            })()
        `);
        console.log('[Audit Runner] Case B Diag:', JSON.stringify(diagB, null, 2));

        console.log('[Audit Runner] Capturing Screenshot Case B: screenshot_case_b_3dgs_splat_ziggurat.png...');
        const imgB = await win.webContents.capturePage();
        const pathB = path.join(ARTIFACT_DIR, 'screenshot_case_b_3dgs_splat_ziggurat.png');
        fs.writeFileSync(pathB, imgB.toPNG());
        console.log('[Audit Runner] Saved Screenshot Case B to:', pathB);

        // =========================================================================
        // CASE C: Viewport Camera Orbit to Test Parallax & Boundaries
        // =========================================================================
        console.log('[Audit Runner] --- Orbiting camera to test 3D parallax & perspective ---');
        await win.webContents.executeJavaScript(`
            (() => {
                const canvas = document.querySelector('canvas');
                if (canvas) {
                    const rect = canvas.getBoundingClientRect();
                    const startX = rect.left + rect.width * 0.5;
                    const startY = rect.top + rect.height * 0.5;
                    const endX = startX + 180;
                    const endY = startY - 40;

                    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY, button: 0 }));
                    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: endX, clientY: endY, button: 0 }));
                    canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endX, clientY: endY, button: 0 }));
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 2000));

        console.log('[Audit Runner] Capturing Screenshot Case C: screenshot_case_c_3dgs_orbit_parallax.png...');
        const imgC = await win.webContents.capturePage();
        const pathC = path.join(ARTIFACT_DIR, 'screenshot_case_c_3dgs_orbit_parallax.png');
        fs.writeFileSync(pathC, imgC.toPNG());
        console.log('[Audit Runner] Saved Screenshot Case C to:', pathC);

        console.log('[Audit Runner] COMPLETE! All audit screenshots captured successfully.');
        serverInstance?.close();
        toolsServerInstance?.close();
        app.quit();
    } catch (err) {
        console.error('[Audit Runner] Error during execution:', err);
        serverInstance?.close();
        toolsServerInstance?.close();
        app.exit(1);
    }
});
