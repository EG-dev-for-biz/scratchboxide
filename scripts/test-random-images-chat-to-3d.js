const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');

// Enable WebGL & hardware acceleration
app.commandLine.appendSwitch('enable-webgl');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('use-gl', 'angle');

const OUTPUT_DIR = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b';
fs.ensureDirSync(OUTPUT_DIR);

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 3226;
const TOOLS_PORT = 3227;

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
            console.log(`[Test Chat Image-to-3D] Standalone server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
            resolve();
        });
        serverInstance.on('error', reject);
    });

    const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
    await new Promise((resolve, reject) => {
        toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
            console.log(`[Test Chat Image-to-3D] Tools server listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
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

        console.log('[Test Chat Image-to-3D] Loading app URL:', apiBase);
        await win.loadURL(apiBase);

        console.log('[Test Chat Image-to-3D] Waiting for UI to mount...');
        await new Promise(r => setTimeout(r, 4000));

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
                        } else if (Date.now() - start > 60000) {
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
                console.warn('[Test Chat Image-to-3D] Warning: waitForGenerationComplete reached timeout or fallback.');
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

                    // 1. Locate the tab by keyword in canvas tabs strip
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

                    // 2. Try to click Open 3D button on the matching or last assistant row
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

                    // 3. Fallback to newest tab
                    if (canvasTabs.length > 0) {
                        const unselected = canvasTabs.find(t => !t.classList.contains('active'));
                        triggerClick(unselected || canvasTabs[canvasTabs.length - 1]);
                    }
                })()
            `);
            await new Promise(r => setTimeout(r, 3000));
        }

        // -------------------------------------------------------------------------
        // SCENE 1: Random Civil Highway Overpass Infrastructure Image
        // -------------------------------------------------------------------------
        const prompt1 = 'Reconstruct this supplied image into a 3D scene from scratch using native C++20 Astra: civil_highway_overpass.png';
        console.log(`[Test Chat Image-to-3D] Sending Prompt 1: "${prompt1}"...`);
        await submitPrompt(prompt1);

        console.log('[Test Chat Image-to-3D] Waiting for Scene 1 (Highway Overpass) to synthesize and render...');
        await waitForGenerationComplete(1, 95000);
        await activate3DTab('highway');

        // Scroll user message 1 to start
        await win.webContents.executeJavaScript(`
            (() => {
                const userRows = document.querySelectorAll('.sb-msg-user-row');
                if (userRows.length > 0) {
                    userRows[0].scrollIntoView({ behavior: 'instant', block: 'start' });
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 1000));

        const scene1Info = await win.webContents.executeJavaScript(`
            (() => {
                const imageCard = document.querySelector('.sb-user-attached-image-card');
                const canvas = document.querySelector('canvas');
                const title = document.querySelector('.sb-doc-header-title, .sb-surface-header-title, h1, h2')?.innerText;
                return {
                    hasImageCard: !!imageCard,
                    imageSrc: imageCard?.querySelector('img')?.src,
                    hasCanvas: !!canvas,
                    canvasWidth: canvas?.width,
                    canvasHeight: canvas?.height,
                    title
                };
            })()
        `);
        console.log('[Test Chat Image-to-3D] Scene 1 Status:', JSON.stringify(scene1Info, null, 2));

        console.log('[Test Chat Image-to-3D] Capturing screenshot 1: chat_image_to_3d_overpass.png...');
        const img1 = await win.webContents.capturePage();
        const path1 = path.join(OUTPUT_DIR, 'chat_image_to_3d_overpass.png');
        fs.writeFileSync(path1, img1.toPNG());
        console.log('[Test Chat Image-to-3D] Screenshot 1 saved to:', path1);
        await new Promise(r => setTimeout(r, 2500));

        // -------------------------------------------------------------------------
        // SCENE 2: Random Matterhorn Alpine Mountain Valley Image
        // -------------------------------------------------------------------------
        const prompt2 = 'Generate an interactive 3D terrain and valley scene matching this image: matterhorn_switzerland.jpg';
        console.log(`[Test Chat Image-to-3D] Sending Prompt 2: "${prompt2}"...`);
        await submitPrompt(prompt2);

        console.log('[Test Chat Image-to-3D] Waiting for Scene 2 (Alpine Valley) to synthesize and render...');
        await waitForGenerationComplete(2, 95000);
        await activate3DTab('alpine');

        // Scroll user message 2 to start so the user plate and prompt are at the top of the chat pane
        await win.webContents.executeJavaScript(`
            (() => {
                const userRows = document.querySelectorAll('.sb-msg-user-row');
                if (userRows.length > 1) {
                    userRows[userRows.length - 1].scrollIntoView({ behavior: 'instant', block: 'start' });
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 1200));

        const scene2Info = await win.webContents.executeJavaScript(`
            (() => {
                const imageCards = Array.from(document.querySelectorAll('.sb-user-attached-image-card'));
                const lastImageCard = imageCards[imageCards.length - 1];
                const canvas = document.querySelector('canvas');
                const title = document.querySelector('.sb-doc-header-title, .sb-surface-header-title, h1, h2')?.innerText;
                const userRows = document.querySelectorAll('.sb-msg-user-row');
                const lastUserRow = userRows[userRows.length - 1];
                const rowRect = lastUserRow?.getBoundingClientRect();
                return {
                    totalImageCards: imageCards.length,
                    lastImageSrc: lastImageCard?.querySelector('img')?.src,
                    hasCanvas: !!canvas,
                    canvasWidth: canvas?.width,
                    canvasHeight: canvas?.height,
                    title,
                    userRowTop: rowRect?.top,
                    userRowVisible: rowRect ? (rowRect.top >= 0 && rowRect.top < window.innerHeight) : false
                };
            })()
        `);
        console.log('[Test Chat Image-to-3D] Scene 2 Status:', JSON.stringify(scene2Info, null, 2));

        console.log('[Test Chat Image-to-3D] Capturing screenshot 2: chat_image_to_3d_alpine_valley.png...');
        const img2 = await win.webContents.capturePage();
        const path2 = path.join(OUTPUT_DIR, 'chat_image_to_3d_alpine_valley.png');
        fs.writeFileSync(path2, img2.toPNG());
        console.log('[Test Chat Image-to-3D] Screenshot 2 saved to:', path2);
        await new Promise(r => setTimeout(r, 2500));

        // -------------------------------------------------------------------------
        // SCENE 3: Ancient Babylonian Ziggurat Observatory (Etemenanki)
        // -------------------------------------------------------------------------
        const prompt3 = 'Reconstruct the ancient Babylonian Ziggurat Observatory (Etemenanki) with lapis lazuli terrace, gold sanctuary, and astrolabe in 3D';
        console.log(`[Test Chat Image-to-3D] Sending Prompt 3: "${prompt3}"...`);
        await submitPrompt(prompt3);

        console.log('[Test Chat Image-to-3D] Waiting for Scene 3 (Babylonian Ziggurat) to synthesize and render...');
        await waitForGenerationComplete(3, 95000);
        await activate3DTab('babylo');

        // Scroll user message 3 to start
        await win.webContents.executeJavaScript(`
            (() => {
                const userRows = document.querySelectorAll('.sb-msg-user-row');
                if (userRows.length > 2) {
                    userRows[userRows.length - 1].scrollIntoView({ behavior: 'instant', block: 'start' });
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 1200));

        const scene3Info = await win.webContents.executeJavaScript(`
            (() => {
                const canvas = document.querySelector('canvas');
                const title = document.querySelector('.sb-doc-header-title, .sb-surface-header-title, h1, h2')?.innerText;
                const userRows = document.querySelectorAll('.sb-msg-user-row');
                const lastUserRow = userRows[userRows.length - 1];
                const rowRect = lastUserRow?.getBoundingClientRect();
                return {
                    hasCanvas: !!canvas,
                    canvasWidth: canvas?.width,
                    canvasHeight: canvas?.height,
                    title,
                    userRowTop: rowRect?.top,
                    userRowVisible: rowRect ? (rowRect.top >= 0 && rowRect.top < window.innerHeight) : false
                };
            })()
        `);
        console.log('[Test Chat Image-to-3D] Scene 3 Status:', JSON.stringify(scene3Info, null, 2));

        console.log('[Test Chat Image-to-3D] Capturing screenshot 3: chat_image_to_3d_ziggurat.png...');
        const img3 = await win.webContents.capturePage();
        const path3 = path.join(OUTPUT_DIR, 'chat_image_to_3d_ziggurat.png');
        fs.writeFileSync(path3, img3.toPNG());
        console.log('[Test Chat Image-to-3D] Screenshot 3 saved to:', path3);

        console.log('[Test Chat Image-to-3D] SUCCESS! All 3 test cases completed and captured.');
        serverInstance?.close();
        toolsServerInstance?.close();
        app.quit();
    } catch (err) {
        console.error('[Test Chat Image-to-3D] Execution failed:', err);
        serverInstance?.close();
        toolsServerInstance?.close();
        app.exit(1);
    }
});
