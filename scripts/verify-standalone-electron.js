const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs-extra');

app.disableHardwareAcceleration();

const SCREENSHOTS_DIR = process.env.SCREENSHOTS_DIR || '/Users/eligreen/.gemini/antigravity/brain/51c0df30-018c-4541-96aa-4691dbbe88f2/screenshots';
fs.ensureDirSync(SCREENSHOTS_DIR);

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 3105;
const TOOLS_PORT = 3106;

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
            console.log(`[Standalone Electron] Backend server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
            resolve();
        });
        serverInstance.on('error', reject);
    });

    const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
    await new Promise((resolve, reject) => {
        toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
            console.log(`[Standalone Electron] Tools server listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
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
            width: 1440,
            height: 900,
            show: false,
            webPreferences: {
                preload: path.resolve(__dirname, '../desktop-app/dist-electron/desktop-app/electron/preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                additionalArguments: [
                    `--scratchbox-token=${launchToken}`,
                    `--scratchbox-api-base=${apiBase}`
                ]
            }
        });

        console.log('[Standalone Electron] Loading app from standalone server...');
        await win.loadURL(apiBase);

        console.log('[Standalone Electron] Waiting for UI to mount and hydrate...');
        await new Promise(r => setTimeout(r, 4000));

        // 1. Initial Landing Workbench
        console.log('[Standalone Electron] Capturing 01_scratchbox_landing_workbench.png...');
        const img1 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '01_scratchbox_landing_workbench.png'), img1.toPNG());

        // Check for any legacy branding leaks in DOM
        const brandingAudit = await win.webContents.executeJavaScript(`
            (() => {
                const bodyText = document.body.innerText;
                const bodyHtml = document.body.innerHTML;
                const leaks = [];
                if (/\\bcursor\\b/i.test(bodyText)) leaks.push('Visible text contains "cursor"');
                if (/\\bantigravity\\b/i.test(bodyText)) leaks.push('Visible text contains "antigravity"');
                if (bodyHtml.includes('sb-antigravity')) leaks.push('DOM classes contain "sb-antigravity"');
                return leaks;
            })()
        `);
        console.log('[Standalone Electron] Branding audit results:', brandingAudit.length === 0 ? 'CLEAN (0 leaks)' : brandingAudit);

        // Helper to launch demo by ID
        const launchDemoById = async (demoId) => {
            console.log(`[Standalone Electron] Opening Demos Modal for ${demoId}...`);
            await win.webContents.executeJavaScript(`
                (() => {
                    const launcher = document.querySelector('.sb-demos-launcher-btn') ||
                                     Array.from(document.querySelectorAll('button')).find(b => b.textContent && (b.textContent.includes('Showcase Demos') || b.textContent.includes('Demos')));
                    if (launcher) launcher.click();
                })()
            `);
            await new Promise(r => setTimeout(r, 1000));

            console.log(`[Standalone Electron] Clicking launch button for ${demoId}...`);
            const launched = await win.webContents.executeJavaScript(`
                (() => {
                    const card = document.querySelector('[data-demo-id="${demoId}"]') ||
                                 Array.from(document.querySelectorAll('.sb-demos-card')).find(c => c.textContent && c.textContent.includes('${demoId}'));
                    if (card) {
                        const btn = card.querySelector('.sb-demos-launch-btn');
                        if (btn) {
                            btn.click();
                            return true;
                        }
                    }
                    return false;
                })()
            `);
            console.log(`[Standalone Electron] Launch result for ${demoId}: ${launched}`);
            await new Promise(r => setTimeout(r, 3500));
        };

        // 2. Open Showcase Demos Modal & Capture
        console.log('[Standalone Electron] Opening Showcase Demos Modal for 02_showcase_demos_modal.png...');
        await win.webContents.executeJavaScript(`
            (() => {
                const launcher = document.querySelector('.sb-demos-launcher-btn') ||
                                 Array.from(document.querySelectorAll('button')).find(b => b.textContent && (b.textContent.includes('Showcase Demos') || b.textContent.includes('Demos')));
                if (launcher) launcher.click();
            })()
        `);
        await new Promise(r => setTimeout(r, 1200));

        console.log('[Standalone Electron] Capturing 02_showcase_demos_modal.png...');
        const img2 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '02_showcase_demos_modal.png'), img2.toPNG());

        // Close modal or proceed directly to launching Demo 1
        console.log('[Standalone Electron] Launching Demo 1: demo-3d-geospatial...');
        await win.webContents.executeJavaScript(`
            (() => {
                const card = document.querySelector('[data-demo-id="demo-3d-geospatial"]');
                if (card) {
                    const btn = card.querySelector('.sb-demos-launch-btn');
                    if (btn) btn.click();
                }
            })()
        `);
        await new Promise(r => setTimeout(r, 3500));
        console.log('[Standalone Electron] Capturing 03_demo_3d_geospatial_digital_twin.png...');
        const img3 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '03_demo_3d_geospatial_digital_twin.png'), img3.toPNG());

        // 4. Launch Demo 2: VFX Matchmove
        await launchDemoById('demo-vfx-timeline');
        console.log('[Standalone Electron] Capturing 04_demo_vfx_timeline_matchmove.png...');
        const img4 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '04_demo_vfx_timeline_matchmove.png'), img4.toPNG());

        // 5. Launch Demo 4: Retro Space Breakout Arcade
        await launchDemoById('demo-retro-breakout');
        console.log('[Standalone Electron] Capturing 05_demo_retro_breakout_sandbox.png...');
        const img5 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '05_demo_retro_breakout_sandbox.png'), img5.toPNG());

        // 6. Launch Demo 3: Autonomous Spatial AI Graph
        await launchDemoById('demo-ai-node-graph');
        console.log('[Standalone Electron] Capturing 06_demo_ai_node_graph.png...');
        const img6 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '06_demo_ai_node_graph.png'), img6.toPNG());

        // 7. Launch Demo 5: Scratchbox Studio Core Cockpit
        await launchDemoById('demo-cockpit-dashboard');
        console.log('[Standalone Electron] Capturing 07_demo_engine_telemetry_cockpit.png...');
        const img7 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(SCREENSHOTS_DIR, '07_demo_engine_telemetry_cockpit.png'), img7.toPNG());

        console.log('[Standalone Electron] All 7 verification screenshots captured successfully!');
        
        serverInstance?.close();
        toolsServerInstance?.close();
        app.quit();
    } catch (err) {
        console.error('[Standalone Electron] Error in verification script:', err);
        serverInstance?.close();
        toolsServerInstance?.close();
        app.exit(1);
    }
});
