/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { app, BrowserWindow, shell, ipcMain } from 'electron';
import * as http from 'http';
import * as path from 'path';
import { createStandaloneServer, createToolsServer, resolveLaunchToken } from '../server/app';

let mainWindow: BrowserWindow | null = null;
let serverInstance: http.Server | null = null;
let toolsServerInstance: http.Server | null = null;

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = parseInt(process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001', 10);
const TOOLS_PORT = parseInt(process.env.SCRATCHBOX_TOOLS_PORT || '3002', 10);
const DEV_RENDERER_URL = 'http://127.0.0.1:3000';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Generate the per-launch token once; the server reads it from the environment
// and the renderer receives it through the preload (additionalArguments).
const launchToken = resolveLaunchToken();
process.env.SCRATCHBOX_LAUNCH_TOKEN = launchToken;

// Packaged builds load index.html from file://, which Chromium reports as `Origin: null`.
if (app.isPackaged) {
    const existing = (process.env.SCRATCHBOX_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!existing.includes('null')) {
        process.env.SCRATCHBOX_ALLOWED_ORIGINS = [...existing, 'null'].join(',');
    }
}

process.on('unhandledRejection', (reason: unknown) => {
    console.error('[Electron] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err: Error) => {
    console.error('[Electron] Uncaught exception, exiting:', err);
    process.exit(1);
});

function attachListenErrorHandler(server: http.Server, label: string, port: number): void {
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[Electron] ${label} port ${port} is already in use on ${BACKEND_HOST}. ` +
                'Quit the other Scratchbox instance or set PORT / SCRATCHBOX_TOOLS_PORT.');
        } else {
            console.error(`[Electron] ${label} failed to listen on ${BACKEND_HOST}:${port}:`, err);
        }
        app.exit(1);
    });
}

function startBackendServer(): void {
    const serverApp = createStandaloneServer({ port: BACKEND_PORT, toolsPort: TOOLS_PORT });
    serverInstance = serverApp.listen(BACKEND_PORT, BACKEND_HOST, () => {
        console.log(`[Electron] Internal Backend Server listening on http://${BACKEND_HOST}:${BACKEND_PORT}`);
    });
    attachListenErrorHandler(serverInstance, 'API', BACKEND_PORT);

    const toolsApp = createToolsServer(serverApp.locals.exportedToolsStore);
    toolsServerInstance = toolsApp.listen(TOOLS_PORT, BACKEND_HOST, () => {
        console.log(`[Electron] Exported-tools origin listening on http://${BACKEND_HOST}:${TOOLS_PORT}`);
    });
    attachListenErrorHandler(toolsServerInstance, 'Tools', TOOLS_PORT);
}

function registerIpcHandlers(): void {
    ipcMain.handle('scratchbox:get-launch-token', () => launchToken);
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
}

function createWindow(): void {
    const apiBase = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
    mainWindow = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: '#212121',
        show: false,
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

    if (isDev) {
        mainWindow.loadURL(DEV_RENDERER_URL);
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
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
        const allowed = isDev ? url.startsWith(DEV_RENDERER_URL) : url.startsWith('file://');
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

app.whenReady().then(() => {
    registerIpcHandlers();
    startBackendServer();
    createWindow();

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
    serverInstance?.close();
    toolsServerInstance?.close();
});
