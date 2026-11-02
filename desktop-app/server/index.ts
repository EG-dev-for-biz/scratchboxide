/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as http from 'http';
import { createStandaloneServer, createToolsServer, resolveLaunchToken } from './app';
import { resolveRendererDist } from './renderer-dist';
import { warmNativeEngine } from '../../packages/core/src/node/3d-engine/native-warmup';
import { reportStagedSwitchProblems } from '../../packages/core/src/node/3d-engine/staged-location/staged-switches';
import type { GeminiService } from '../../packages/core/src/node/gemini-service';

const PORT = parseInt(process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001', 10);
const TOOLS_PORT = parseInt(process.env.SCRATCHBOX_TOOLS_PORT || '3002', 10);
// Loopback by default; containers set HOST=0.0.0.0 explicitly (see Dockerfile).
const HOST = process.env.HOST || '127.0.0.1';
const staticDir = resolveRendererDist(__dirname);
if (!staticDir) {
    console.warn('[Scratchbox] No built renderer found (desktop-app/dist); serving API only. Run `npm run build` or set SCRATCHBOX_STATIC_DIR.');
}
// a retired staged-build switch still set, or a value a switch does not take, is said once here
reportStagedSwitchProblems();

// Fail loudly instead of silently continuing with a half-initialised process.
process.on('unhandledRejection', (reason: unknown) => {
    console.error('[Scratchbox API] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err: Error) => {
    console.error('[Scratchbox API] Uncaught exception, exiting:', err);
    process.exit(1);
});

// One token per launch, shared with the Vite dev proxy / Electron via the environment.
process.env.SCRATCHBOX_LAUNCH_TOKEN = resolveLaunchToken();

const app = createStandaloneServer({
    port: PORT,
    staticDir,
    toolsPort: TOOLS_PORT
});
const toolsApp = createToolsServer(app.locals.exportedToolsStore);

function attachListenErrorHandler(server: http.Server, label: string, port: number): void {
    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`[Scratchbox ${label}] Port ${port} is already in use on ${HOST}. ` +
                `Stop the other process or set ${label === 'API' ? 'PORT' : 'SCRATCHBOX_TOOLS_PORT'} to a free port.`);
        } else {
            console.error(`[Scratchbox ${label}] Failed to listen on ${HOST}:${port}:`, err);
        }
        process.exit(1);
    });
}

const apiServer = app.listen(PORT, HOST, () => {
    console.log(`🚀 Scratchbox Standalone Backend API listening on http://${HOST}:${PORT}`);
    if (!app.locals.launchTokenRequired) {
        console.log(`🔓 Launch token off (SCRATCHBOX_NO_LAUNCH_TOKEN=1, loopback only): API calls need no token.`);
    } else if (staticDir) {
        // Browser mode: the token travels in the URL once, never via an API endpoint.
        console.log(`🔑 Open in a browser: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}/?token=${app.locals.launchToken}`);
    } else if (process.env.SCRATCHBOX_PRINT_LAUNCH_TOKEN === '1') {
        console.log(`[Scratchbox API] Launch token: ${app.locals.launchToken}`);
    }
    // Build the native engines a location request needs now that the server is up, so the first request finds them ready.
    void warmNativeEngine();
    // Build a first chat turn's payload once (prompt builder, tool catalogue, workspace pattern scan), so the first turn does not.
    void (app.locals.geminiService as GeminiService).warmChatPrompt();
});
attachListenErrorHandler(apiServer, 'API', PORT);

const toolsServer = toolsApp.listen(TOOLS_PORT, HOST, () => {
    console.log(`🧩 Scratchbox exported-tools origin listening on http://${HOST}:${TOOLS_PORT}`);
});
attachListenErrorHandler(toolsServer, 'Tools', TOOLS_PORT);
