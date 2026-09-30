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
const BACKEND_PORT = 3238;
const TOOLS_PORT = 3239;

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
            console.log(`[MicroSurface Runner] Standalone server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
            resolve();
        });
        serverInstance.on('error', reject);
    });

    const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
    await new Promise((resolve, reject) => {
        toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
            console.log(`[MicroSurface Runner] Tools server listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
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
            if (msg.includes('Shader') || msg.includes('Three') || msg.includes('MicroSurface') || msg.includes('WebGL') || level >= 2) {
                console.log(`[Browser Console] ${msg}`);
            }
        });

        console.log('[MicroSurface Runner] Loading app URL:', apiBase);
        await win.loadURL(apiBase);

        console.log('[MicroSurface Runner] Waiting for UI to mount...');
        await new Promise(r => setTimeout(r, 4500));

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
                console.warn('[MicroSurface Runner] Warning: waitForGenerationComplete reached timeout or fallback.');
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
        // Render Babylonian Ziggurat Observatory with Micro-Surface Shaders
        // =========================================================================
        console.log('[MicroSurface Runner] --- Testing Procedural Triplanar Micro-Surface Shaders ---');
        const prompt = 'Reconstruct the ancient Babylonian Ziggurat Observatory (Etemenanki) with mudbrick base, lapis lazuli tier, gold sanctuary, astrolabe rings, and sunset lighting in 3D: scene_2_photorealistic_final.png';
        console.log(`[MicroSurface Runner] Sending Prompt: "${prompt}"...`);
        await submitPrompt(prompt);
        await waitForGenerationComplete(1, 95000);
        await activate3DTab('babylo');

        await new Promise(r => setTimeout(r, 3500));

        // Audit WebGL materials in the active Three.js scene
        const materialAudit = await win.webContents.executeJavaScript(`
            (() => {
                const s = window.__SB_3D_SCENE__;
                if (!s) return { error: 'No scene found' };
                const materials = [];
                s.traverse((obj) => {
                    if (obj.isMesh && obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        mats.forEach(m => {
                            materials.push({
                                meshName: obj.name,
                                matName: m.name,
                                matType: m.type,
                                roughness: m.roughness,
                                metalness: m.metalness,
                                hasShaderPatcher: !!(m.userData?.microSurfaceType || m.userData?.sbMicroSurfaceConfig)
                            });
                        });
                    }
                });
                return { totalMeshes: materials.length, sampleMaterials: materials.slice(0, 10) };
            })()
        `);
        console.log('[MicroSurface Runner] Material Audit:', JSON.stringify(materialAudit, null, 2));

        // 1. Overall View Screenshot
        console.log('[MicroSurface Runner] Positioning camera for Overall View...');
        await win.webContents.executeJavaScript(`
            (() => {
                const targetRef = window.__SB_3D_CAMERA_TARGET__;
                const rotRef = window.__SB_3D_CAMERA_ROTATION__;
                if (targetRef && rotRef) {
                    targetRef.current.set(0.0, 10.0, 0.0);
                    rotRef.current = { theta: 0.75, phi: 1.15, distance: 52.0 };
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 2000));

        console.log('[MicroSurface Runner] Capturing Screenshot: screenshot_procedural_microsurface_ziggurat.png...');
        const imgOverall = await win.webContents.capturePage();
        const pathOverall = path.join(ARTIFACT_DIR, 'screenshot_procedural_microsurface_ziggurat.png');
        fs.writeFileSync(pathOverall, imgOverall.toPNG());
        console.log('[MicroSurface Runner] Saved Overall Screenshot to:', pathOverall);

        // 2. Close-up Dolly to inspect Sobel mortar deepening & lapis glaze crackle
        console.log('[MicroSurface Runner] Adjusting camera to inspect micro-surface details close-up...');
        await win.webContents.executeJavaScript(`
            (() => {
                const targetRef = window.__SB_3D_CAMERA_TARGET__;
                const rotRef = window.__SB_3D_CAMERA_ROTATION__;
                if (targetRef && rotRef) {
                    // Position camera close to the lower buttress mudbrick & second lapis tier
                    targetRef.current.set(4.0, 9.0, 2.0);
                    rotRef.current = { theta: 0.65, phi: 1.25, distance: 16.0 };
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 2000));

        console.log('[MicroSurface Runner] Capturing Screenshot: screenshot_procedural_microsurface_closeup.png...');
        const imgCloseup = await win.webContents.capturePage();
        const pathCloseup = path.join(ARTIFACT_DIR, 'screenshot_procedural_microsurface_closeup.png');
        fs.writeFileSync(pathCloseup, imgCloseup.toPNG());
        console.log('[MicroSurface Runner] Saved Closeup Screenshot to:', pathCloseup);

        console.log('[MicroSurface Runner] SUCCESS! All micro-surface viewport audits captured.');
        serverInstance?.close();
        toolsServerInstance?.close();
        app.quit();
    } catch (err) {
        console.error('[MicroSurface Runner] Error during execution:', err);
        serverInstance?.close();
        toolsServerInstance?.close();
        app.exit(1);
    }
});
