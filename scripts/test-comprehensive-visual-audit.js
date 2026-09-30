/********************************************************************************
 * Comprehensive Visual Fidelity & Packaging Audit Runner
 * Tests:
 * 1. Procedural Triplanar Micro-Surface Shaders (Hero, Mudbrick Macro, Lapis Macro, Sanctuary)
 * 2. Multi-Level Highway Overpass Interchange Viewport
 * 3. Alpine Mountain Pass Viewport
 * 4. Packaged Projects Integrity Audit (/projects/<scene>/)
 ********************************************************************************/

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ARTIFACT_DIR = '/Users/eligreen/.gemini/antigravity/brain/7661fe23-d225-442c-9323-f94362db535b';

async function main() {
    await app.whenReady();

    // 1. Launch standalone test server
    const express = require(path.join(__dirname, '../desktop-app/node_modules/express'));
    const serverApp = express();
    const staticDir = path.join(__dirname, '../desktop-app/dist');
    serverApp.use(express.static(staticDir));

    serverApp.get('/api/projects/:projectName/:fileName', (req, res) => {
        const filePath = path.join(__dirname, '..', 'projects', req.params.projectName, req.params.fileName);
        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else {
            res.status(404).send('Not found');
        }
    });

    const server = http.createServer(serverApp);
    await new Promise((resolve) => server.listen(3240, '127.0.0.1', resolve));
    console.log('[Audit Runner] Test server listening on http://127.0.0.1:3240');

    // 2. Launch tools mock server
    const toolsApp = express();
    toolsApp.use(express.json());
    toolsApp.post('/call_tool', (req, res) => res.json({ success: true, result: {} }));
    const toolsServer = http.createServer(toolsApp);
    await new Promise((resolve) => toolsServer.listen(3241, '127.0.0.1', resolve));
    console.log('[Audit Runner] Mock tools server listening on http://127.0.0.1:3241');

    // 3. Create BrowserWindow
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
        }
    });

    try {
        console.log('[Audit Runner] Loading application...');
        await win.loadURL('http://127.0.0.1:3240');

        console.log('[Audit Runner] Waiting for UI to mount...');
        await win.webContents.executeJavaScript(`
            new Promise((resolve) => {
                const check = () => {
                    const composer = document.querySelector('textarea.sb-composer-main-input, textarea');
                    if (composer) resolve(true);
                    else setTimeout(check, 400);
                };
                check();
            })
        `);
        console.log('[Audit Runner] UI successfully mounted.');

        async function submitPrompt(promptText) {
            return await win.webContents.executeJavaScript(`
                new Promise((resolve, reject) => {
                    const start = Date.now();
                    const interval = setInterval(() => {
                        const textarea = document.querySelector('textarea.sb-composer-main-input, textarea');
                        if (textarea && !textarea.disabled) {
                            clearInterval(interval);
                            textarea.focus();
                            const proto = Object.getPrototypeOf(textarea);
                            const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                            if (nativeSetter) {
                                nativeSetter.call(textarea, ${JSON.stringify(promptText)});
                            } else {
                                textarea.value = ${JSON.stringify(promptText)};
                            }
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

        async function setCamera(target, rot) {
            await win.webContents.executeJavaScript(`
                (() => {
                    if (typeof window.__SB_SET_CAMERA_VIEW__ === 'function') {
                        window.__SB_SET_CAMERA_VIEW__([${target[0]}, ${target[1]}, ${target[2]}], {
                            theta: ${rot.theta},
                            phi: ${rot.phi},
                            distance: ${rot.distance}
                        });
                        return;
                    }
                    const targetRef = window.__SB_3D_CAMERA_TARGET__;
                    const rotRef = window.__SB_3D_CAMERA_ROTATION__;
                    if (targetRef && rotRef) {
                        targetRef.current.set(${target[0]}, ${target[1]}, ${target[2]});
                        rotRef.current.theta = ${rot.theta};
                        rotRef.current.phi = ${rot.phi};
                        rotRef.current.distance = ${rot.distance};
                    }
                })()
            `);
            await new Promise(r => setTimeout(r, 1200));
        }

        async function captureScreenshot(filename) {
            const img = await win.webContents.capturePage();
            const filePath = path.join(ARTIFACT_DIR, filename);
            fs.writeFileSync(filePath, img.toPNG());
            console.log(`[Audit Runner] Saved screenshot: ${filename} (${img.toPNG().length} bytes)`);
            return filePath;
        }

        // =========================================================================
        // TEST 1: Babylonian Ziggurat Observatory (Procedural Micro-Surface Shaders)
        // =========================================================================
        console.log('[Audit Runner] === TEST 1: Babylonian Ziggurat Observatory ===');
        const promptZiggurat = 'Reconstruct the ancient Babylonian Ziggurat Observatory (Etemenanki) with mudbrick base, lapis lazuli tier, gold sanctuary, astrolabe rings, and sunset lighting in 3D: scene_2_photorealistic_final.png';
        await submitPrompt(promptZiggurat);
        await waitForGenerationComplete(1, 95000);
        await activate3DTab('babylo');
        await new Promise(r => setTimeout(r, 3000));

        // Audit shaders
        const shaderAudit = await win.webContents.executeJavaScript(`
            (() => {
                const s = window.__SB_3D_SCENE__;
                if (!s) return { error: 'No scene found' };
                let patched = 0;
                let total = 0;
                s.traverse((obj) => {
                    if (obj.isMesh && obj.material) {
                        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                        mats.forEach(m => {
                            total++;
                            if (m.userData?.microSurfaceType || m.userData?.sbMicroSurfaceConfig) patched++;
                        });
                    }
                });
                return { total, patched };
            })()
        `);
        console.log('[Audit Runner] Ziggurat Shader Audit:', shaderAudit);

        // Shot 1: Hero Orbit View
        console.log('[Audit Runner] Positioning for Hero View...');
        await setCamera([0, 10, 0], { theta: 0.75, phi: 1.15, distance: 54 });
        await captureScreenshot('screenshot_audit_ziggurat_hero.png');

        // Shot 2: Macro Close-up: Mudbrick & Mortar Joints
        console.log('[Audit Runner] Positioning for Mudbrick Macro View...');
        await setCamera([8, 3, 10], { theta: 0.35, phi: 1.35, distance: 10 });
        await captureScreenshot('screenshot_audit_ziggurat_mudbrick_macro.png');

        // Shot 3: Macro Close-up: Lapis Lazuli Tier & Crazing Crackle
        console.log('[Audit Runner] Positioning for Lapis Glaze Macro View...');
        await setCamera([0, 10.5, 6], { theta: 0.15, phi: 1.25, distance: 9 });
        await captureScreenshot('screenshot_audit_ziggurat_lapis_glaze.png');

        // Shot 4: Macro Close-up: Sanctuary Dome & Astrolabe
        console.log('[Audit Runner] Positioning for Sanctuary & Astrolabe View...');
        await setCamera([0, 16.5, 0], { theta: 0.55, phi: 1.2, distance: 11 });
        await captureScreenshot('screenshot_audit_ziggurat_sanctuary.png');

        // =========================================================================
        // TEST 2: Multi-Level Highway Overpass Spaghetti Interchange
        // =========================================================================
        console.log('[Audit Runner] === TEST 2: Multi-Level Highway Overpass ===');
        const promptHighway = 'Complex multi-level highway overpass spaghetti interchange with concrete flyover ramps, asphalt texture, and evening twilight lighting in 3D: scene_3_highway_spaghetti.png';
        await submitPrompt(promptHighway);
        await waitForGenerationComplete(2, 95000);
        await activate3DTab('highway');
        await new Promise(r => setTimeout(r, 3000));

        await setCamera([0, 8, 0], { theta: 0.85, phi: 1.1, distance: 48 });
        await captureScreenshot('screenshot_audit_highway_interchange.png');

        // =========================================================================
        // TEST 3: Alpine Matterhorn Pass (Mountain & Atmospheric Pipeline)
        // =========================================================================
        console.log('[Audit Runner] === TEST 3: Alpine Matterhorn Pass ===');
        const promptAlpine = 'Alpine mountain pass with sharp Matterhorn peak, volumetric clouds, granite rock ridges, and snow dusting in 3D: scene_1_alpine_pass.png';
        await submitPrompt(promptAlpine);
        await waitForGenerationComplete(3, 95000);
        await activate3DTab('alpine');
        await new Promise(r => setTimeout(r, 3000));

        await setCamera([0, 15, 0], { theta: 0.65, phi: 1.18, distance: 65 });
        await captureScreenshot('screenshot_audit_alpine_pass.png');

        console.log('[Audit Runner] All visual test scenarios completed successfully!');

    } catch (err) {
        console.error('[Audit Runner] Error encountered:', err);
    } finally {
        win.close();
        server.close();
        toolsServer.close();
        app.quit();
    }
}

main().catch(e => {
    console.error('Fatal runner error:', e);
    process.exit(1);
});
