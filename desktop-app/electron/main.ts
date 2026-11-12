/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { app, BrowserWindow, shell, ipcMain, dialog, OpenDialogOptions, SaveDialogOptions, safeStorage } from 'electron';
import { exec } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { createStandaloneServer, createToolsServer, resolveLaunchToken } from '../server/app';
import { closeScratchboxAccount } from '../../packages/core/src/node/scratchbox-account/account-service';
import { resolveRendererDist } from '../server/renderer-dist';
import { warmNativeEngine } from '../../packages/core/src/node/3d-engine/native-warmup';
import type { GeminiService } from '../../packages/core/src/node/gemini-service';

function resolveAppIconPath(): string | undefined {
    const candidates = [
        path.resolve(__dirname, '../resources/icon.png'),
        path.resolve(__dirname, '../../resources/icon.png'),
        path.resolve(__dirname, '../../desktop-app/resources/icon.png'),
        path.resolve(__dirname, '../../public/icons/ScratchboxIDE.png'),
        path.resolve(app.getAppPath(), 'resources/icon.png'),
        path.resolve(app.getAppPath(), 'public/icons/ScratchboxIDE.png')
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return undefined;
}

let mainWindow: BrowserWindow | null = null;
let serverInstance: http.Server | null = null;
let toolsServerInstance: http.Server | null = null;

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001', 10);
const TOOLS_PORT = parseInt(process.env.SCRATCHBOX_TOOLS_PORT || '3002', 10);
const DEV_RENDERER_URL = process.env.SCRATCHBOX_RENDERER_URL || `http://${BACKEND_HOST}:${process.env.SCRATCHBOX_WEB_PORT || '3030'}`;
const API_BASE = `http://${BACKEND_HOST}:${BACKEND_PORT}`;

/** True when `url` is on one of the origins the app renderer is loaded from. */
function isAppOrigin(url: string | undefined): boolean {
    if (!url) {
        return false;
    }
    try {
        const origin = new URL(url).origin;
        return origin === new URL(DEV_RENDERER_URL).origin || origin === new URL(API_BASE).origin;
    } catch {
        return false;
    }
}

const isDev = (process.env.NODE_ENV === 'development') ||
    (!app.isPackaged && process.env.NODE_ENV !== 'production' && process.env.SCRATCHBOX_STANDALONE !== 'true');

// Generate the per-launch token once; the server reads it from the environment
// and the renderer receives it through the preload (additionalArguments).
const launchToken = resolveLaunchToken();
process.env.SCRATCHBOX_LAUNCH_TOKEN = launchToken;

// The renderer can load from the internal server in every mode (dev falls back to it when the
// Vite server is down), and module scripts send an Origin header, so that origin must be allowed.
// Packaged or standalone builds may also load from file://, which Chromium reports as `Origin: null`.
{
    const existing = (process.env.SCRATCHBOX_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const needed = [`http://${BACKEND_HOST}:${BACKEND_PORT}`, `http://localhost:${BACKEND_PORT}`];
    if (app.isPackaged || process.env.NODE_ENV === 'production' || process.env.SCRATCHBOX_STANDALONE === 'true') {
        needed.push('null');
    }
    for (const n of needed) {
        if (!existing.includes(n)) existing.push(n);
    }
    process.env.SCRATCHBOX_ALLOWED_ORIGINS = existing.join(',');
}

// The DevTools port lets any local process drive the app; dev tooling (scripts/cdp_helper.js) needs it,
// shipped builds must opt in explicitly.
if (!app.isPackaged || process.env.SCRATCHBOX_REMOTE_DEBUG === '1') {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

process.on('unhandledRejection', (reason: unknown) => {
    console.error('[Electron] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err: Error) => {
    console.error('[Electron] Uncaught exception, exiting:', err);
    process.exit(1);
});

function attachListenErrorHandler(server: http.Server, label: string, port: number, onAddressInUse?: () => void): void {
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[Electron] ${label} port ${port} is already in use on ${BACKEND_HOST}. ` +
                'Continuing, assuming it was launched externally.');
            onAddressInUse?.();
        } else {
            console.error(`[Electron] ${label} failed to listen on ${BACKEND_HOST}:${port}:`, err);
            process.exit(1);
        }
    });
}

function checkPortInUse(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const client = http.get(`http://${host}:${port}/`, { timeout: 1000 }, () => {
            resolve(true);
        });
        client.on('error', () => resolve(false));
        client.on('timeout', () => {
            client.destroy();
            resolve(false);
        });
    });
}

async function startBackendServer(): Promise<void> {
    const isApiRunning = await checkPortInUse(BACKEND_PORT, BACKEND_HOST);
    if (isApiRunning) {
        console.log(`[Electron] Detected existing backend server on http://${BACKEND_HOST}:${BACKEND_PORT}. Reusing active backend.`);
        return;
    }

    const rendererDist = resolveRendererDist(__dirname);
    const serverApp = createStandaloneServer({
        port: BACKEND_PORT,
        toolsPort: TOOLS_PORT,
        staticDir: rendererDist,
        // The scratchbox.ai connection's refresh token goes in the OS keychain, never a plaintext or machine-key file.
        accountEncryption: safeStorage,
        accountDataDir: app.getPath('userData')
    });

    return new Promise((resolve) => {
        let settled = false;
        const markDone = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        };

        serverInstance = serverApp.listen(BACKEND_PORT, BACKEND_HOST, () => {
            console.log(`[Electron] Internal Backend Server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
            markDone();
            // Build the native engines a location request needs now that the server is up, so the first request finds them ready.
            void warmNativeEngine();
            // Build a first chat turn's payload once (prompt builder, tool catalogue, workspace pattern scan), so the first turn does not.
            void (serverApp.locals.geminiService as GeminiService).warmChatPrompt();
        });
        attachListenErrorHandler(serverInstance, 'API', BACKEND_PORT, markDone);

        const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
        toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
            console.log(`[Electron] Exported-tools origin listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
        });
        attachListenErrorHandler(toolsServerInstance, 'Tools', TOOLS_PORT);
    });
}

function registerIpcHandlers(): void {
    ipcMain.handle('scratchbox:get-launch-token', () => launchToken);
    // Real pixels of a region of the calling window (the sandbox or browser iframe included), for visual checks.
    ipcMain.handle('scratchbox:capture-page', async (event, rect: unknown) => {
        const r = rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        const nums = r ? [r.x, r.y, r.width, r.height] : [];
        if (nums.length !== 4 || !nums.every(n => typeof n === 'number' && Number.isFinite(n))) {
            throw new Error('capture-page needs { x, y, width, height } in page pixels');
        }
        const [x, y, width, height] = (nums as number[]).map(n => Math.round(n));
        if (width < 1 || height < 1) throw new Error('capture-page rect is empty');
        const image = await event.sender.capturePage({ x: Math.max(0, x), y: Math.max(0, y), width, height });
        if (image.isEmpty()) throw new Error('capture-page returned an empty image');
        return image.toDataURL();
    });
    ipcMain.handle('scratchbox:open-external', async (_event, url: unknown) => {
        if (typeof url !== 'string') {
            return false;
        }
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return false;
        }
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'mailto:') {
            return false;
        }
        await shell.openExternal(parsed.toString());
        return true;
    });

    ipcMain.handle('scratchbox:window-minimize', () => {
        if (mainWindow) {
            mainWindow.minimize();
            return true;
        }
        return false;
    });

    ipcMain.handle('scratchbox:window-maximize', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) {
                mainWindow.unmaximize();
            } else {
                mainWindow.maximize();
            }
            return mainWindow.isMaximized();
        }
        return false;
    });

    ipcMain.handle('scratchbox:window-close', () => {
        if (mainWindow) {
            mainWindow.close();
            return true;
        }
        return false;
    });

    ipcMain.handle('scratchbox:window-is-maximized', () => {
        return mainWindow ? mainWindow.isMaximized() : false;
    });

    ipcMain.handle('scratchbox:show-open-dialog', async (_event, options: unknown) => {
        if (!mainWindow) return { canceled: true, filePaths: [] };
        const dialogOptions = (options && typeof options === 'object') ? options : { properties: ['openDirectory'] };
        return dialog.showOpenDialog(mainWindow, dialogOptions as OpenDialogOptions);
    });

    ipcMain.handle('scratchbox:show-save-dialog', async (_event, options: unknown) => {
        if (!mainWindow) return { canceled: true, filePath: undefined };
        const dialogOptions = (options && typeof options === 'object') ? options : {};
        return dialog.showSaveDialog(mainWindow, dialogOptions as SaveDialogOptions);
    });

    ipcMain.handle('scratchbox:execute-command', async (event, command: unknown, cwd?: unknown) => {
        if (typeof command !== 'string' || !command.trim()) {
            return { stdout: '', stderr: 'Invalid command', code: 1 };
        }
        // Only the app's own top-level page may ask, never a subframe
        // (sandboxes, proxied pages) or a navigated-away document.
        const sender = event.senderFrame;
        if (!mainWindow || !sender || sender.parent !== null || !isAppOrigin(sender.url)) {
            return { stdout: '', stderr: 'Command execution is not permitted from this frame', code: 1 };
        }
        const workingDir = typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
        // A shell string from the renderer may originate in model output or
        // injected content, so the user must see and approve it every time.
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            buttons: ['Cancel', 'Run'],
            defaultId: 0,
            cancelId: 0,
            title: 'Run shell command?',
            message: 'Scratchbox wants to run this command:',
            detail: `${command}\n\nWorking directory: ${workingDir}`,
            noLink: true
        });
        if (response !== 1) {
            return { stdout: '', stderr: 'Command cancelled by user', code: 1 };
        }
        return new Promise(resolve => {
            exec(command, { cwd: workingDir, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                resolve({
                    stdout: stdout || '',
                    stderr: stderr || '',
                    code: error ? (error.code ?? 1) : 0
                });
            });
        });
    });
}

function createWindow(): void {
    const apiBase = API_BASE;
    const icon = resolveAppIconPath();
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: -100, y: -100 },
        backgroundColor: '#212121',
        show: false,
        icon: icon,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            additionalArguments: [
                `--scratchbox-token=${launchToken}`,
                `--scratchbox-api-base=${apiBase}`
            ]
        }
    });

    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        console.log(`[Renderer ${levels[level] || level}] ${message} (${path.basename(sourceId)}:${line})`);
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`[Renderer Failed Load] ${validatedURL}: ${errorDescription} (${errorCode})`);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
        console.error('[Renderer Process Gone]', details);
    });

    const rendererDist = resolveRendererDist(__dirname);
    if (isDev) {
        const loadDev = async (retries = 10) => {
            try {
                await mainWindow?.loadURL(DEV_RENDERER_URL);
            } catch (err) {
                if (retries > 0 && mainWindow && !mainWindow.isDestroyed()) {
                    setTimeout(() => loadDev(retries - 1), 600);
                } else if (rendererDist && mainWindow && !mainWindow.isDestroyed()) {
                    console.log('[Electron] Dev server not reachable at ' + DEV_RENDERER_URL + ', falling back to internal server: ' + apiBase);
                    mainWindow?.loadURL(apiBase);
                }
            }
        };
        loadDev();
    } else {
        if (!rendererDist) {
            console.error('[Electron] Built renderer not found (desktop-app/dist). Run `npm run build` first.');
            app.exit(1);
            return;
        }
        console.log('[Electron] Loading standalone renderer from internal server: ' + apiBase);
        mainWindow.loadURL(apiBase);
    }

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.webContents.setWindowOpenHandler(details => {
        try {
            const parsed = new URL(details.url);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                shell.openExternal(details.url);
            }
        } catch {
            // Ignore malformed URLs
        }
        return { action: 'deny' };
    });

    // Keep the renderer on the app origin; anything else opens in the system browser.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        const allowed = isAppOrigin(url);
        if (!allowed) {
            event.preventDefault();
            try {
                const parsed = new URL(url);
                if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                    shell.openExternal(url);
                }
            } catch {
                // Ignore malformed URLs
            }
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    registerIpcHandlers();
    await startBackendServer();
    createWindow();

    if (process.platform === 'darwin' && app.dock) {
        const iconPath = resolveAppIconPath();
        if (iconPath) {
            try {
                app.dock.setIcon(iconPath);
            } catch {
                // Ignore dock icon errors
            }
        }
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    // Stop a sign-in in progress; a settled saved connection stays.
    closeScratchboxAccount();
    serverInstance?.close();
    toolsServerInstance?.close();
});
