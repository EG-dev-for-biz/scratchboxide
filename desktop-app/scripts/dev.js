#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Dev launcher: mints one per-launch API token and starts the backend and the
 * Vite dev server with it, so the Vite proxy can inject the token into every
 * forwarded request and the backend accepts exactly that token.
 * Automatically opens Electron once the dev server is ready.
 ********************************************************************************/

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const token = process.env.SCRATCHBOX_LAUNCH_TOKEN || crypto.randomBytes(32).toString('hex');
const webPort = process.env.SCRATCHBOX_WEB_PORT || '3030';
const apiPort = process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001';
const host = '127.0.0.1';

const env = {
    ...process.env,
    SCRATCHBOX_LAUNCH_TOKEN: token,
    NODE_ENV: 'development',
    SCRATCHBOX_ALLOW_LOCAL_IP: 'true'
};

const appDir = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const child = spawn(
    npmCmd,
    [
        'exec', '--', 'concurrently',
        '-n', 'server,vite',
        '-c', 'blue,magenta',
        '--kill-others-on-fail',
        'npm run server:dev',
        'npm run vite:dev'
    ],
    { cwd: appDir, env, stdio: 'inherit' }
);

let electronProcess = null;

function waitForHttp(url, timeoutMs = 30000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function check() {
            const req = http.get(url, (res) => {
                if (res.statusCode && res.statusCode < 500) {
                    resolve();
                } else {
                    retry();
                }
            });
            req.on('error', retry);
            req.on('timeout', () => { req.destroy(); retry(); });
            req.setTimeout(1000);
        }
        function retry() {
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`Timeout waiting for ${url}`));
            } else {
                setTimeout(check, 250);
            }
        }
        check();
    });
}

const shouldLaunchElectron = process.env.SCRATCHBOX_NO_ELECTRON !== 'true' &&
    process.env.SCRATCHBOX_HEADLESS !== 'true' &&
    process.env.CI !== 'true';

if (shouldLaunchElectron) {
    const rendererUrl = `http://${host}:${webPort}/`;
    const apiUrl = `http://${host}:${apiPort}/`;
    console.log(`[Dev] Waiting for Vite (${rendererUrl}) and API server (${apiUrl}) before opening Electron...`);
    Promise.all([
        waitForHttp(rendererUrl, 90000),
        waitForHttp(apiUrl, 90000)
    ]).then(() => {
        console.log(`\n🖥️  Launching Electron window connecting to ${rendererUrl}...\n`);
        const electronBin = path.join(appDir, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
        electronProcess = spawn(
            electronBin,
            ['.', '--remote-debugging-port=9222'],
            { cwd: appDir, env, stdio: 'inherit' }
        );

        electronProcess.on('exit', (code) => {
            console.log(`[Electron] Window closed (exit code ${code ?? 0}). Shutting down dev servers.`);
            child.kill('SIGINT');
            process.exit(code ?? 0);
        });

        electronProcess.on('error', (err) => {
            console.error('[Electron] Failed to start Electron:', err);
        });
    }).catch((err) => {
        console.warn(`[Electron] Could not reach dev servers within timeout (${err.message}). Electron not launched.`);
    });
}

child.on('exit', code => {
    if (electronProcess) {
        electronProcess.kill('SIGTERM');
    }
    process.exit(code === null ? 1 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (electronProcess) {
            electronProcess.kill(signal);
        }
        child.kill(signal);
    });
}
