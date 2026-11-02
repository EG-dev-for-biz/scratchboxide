#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Dev launcher: takes the API token (kept for 30 days across launches,
 * launch-token.js) and starts the backend and the Vite dev server with it, so
 * the Vite proxy can inject the token into every forwarded request and the
 * backend accepts exactly that token.
 * Automatically opens Electron once the dev server is ready.
 ********************************************************************************/

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { persistentLaunchToken } = require('./launch-token');

/**
 * The backend needs Node 22.13 or newer: the durable asset store, which keeps every chat's models across checkouts,
 * indexes them with node:sqlite. On an older Node (nvm's default here is 20) the backend and Vite run on a newer
 * installed one instead: SCRATCHBOX_NODE (a node binary), else the newest nvm install of the repository's .nvmrc major.
 * With none, the app starts on this Node and says the store is off.
 */
const MIN_NODE = [22, 13];
const atLeast = (version, min) => {
    const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
    return major > min[0] || (major === min[0] && minor >= min[1]);
};
function newerNodeBinDir() {
    if (atLeast(process.versions.node, MIN_NODE)) return undefined;
    const explicit = process.env.SCRATCHBOX_NODE;
    if (explicit && fs.existsSync(explicit)) return path.dirname(explicit);
    let major = MIN_NODE[0];
    try {
        major = Math.max(major, parseInt(fs.readFileSync(path.resolve(__dirname, '..', '..', '.nvmrc'), 'utf8'), 10) || 0);
    } catch { /* no .nvmrc: the minimum's major */ }
    const versionsDir = path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'versions', 'node');
    let installed = [];
    try {
        installed = fs.readdirSync(versionsDir).filter(v => /^v\d+\.\d+\.\d+$/.test(v));
    } catch { /* no nvm */ }
    const parts = v => v.slice(1).split('.').map(Number);
    const best = installed
        .filter(v => parts(v)[0] === major && atLeast(v, MIN_NODE))
        .sort((a, b) => parts(b)[0] - parts(a)[0] || parts(b)[1] - parts(a)[1] || parts(b)[2] - parts(a)[2])[0];
    return best ? path.join(versionsDir, best, 'bin') : undefined;
}
const nodeBinDir = newerNodeBinDir();
if (nodeBinDir) {
    console.log(`[dev] Node ${process.versions.node} is too old for the asset store; the backend and Vite run on ${nodeBinDir}`);
} else if (!atLeast(process.versions.node, MIN_NODE)) {
    console.warn(`[dev] Node ${process.versions.node}: the asset store is off (it needs Node ${MIN_NODE.join('.')}+). Install Node ${MIN_NODE[0]} (nvm install ${MIN_NODE[0]}) or set SCRATCHBOX_NODE to a node binary; saved chats then keep models built in other checkouts.`);
}

const { token, expiresAtMs } = persistentLaunchToken();
if (expiresAtMs) console.log(`[dev] launch token kept until ${new Date(expiresAtMs).toISOString().slice(0, 10)} (launch-token.js)`);
const webPort = process.env.SCRATCHBOX_WEB_PORT || '3030';
const apiPort = process.env.PORT || process.env.SCRATCHBOX_API_PORT || '3001';
const host = '127.0.0.1';

// No token in the browser by default (the server honours it on loopback only); SCRATCHBOX_NO_LAUNCH_TOKEN=0 turns it back on.
const noLaunchToken = process.env.SCRATCHBOX_NO_LAUNCH_TOKEN !== '0';

const env = {
    ...process.env,
    SCRATCHBOX_LAUNCH_TOKEN: token,
    SCRATCHBOX_NO_LAUNCH_TOKEN: noLaunchToken ? '1' : '0',
    NODE_ENV: 'development',
    SCRATCHBOX_ALLOW_LOCAL_IP: 'true',
    ...(nodeBinDir ? { PATH: `${nodeBinDir}${path.delimiter}${process.env.PATH || ''}` } : {})
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
        function retry(err) {
            if (err && (err.code === 'EPERM' || err.code === 'EACCES')) {
                if (Date.now() - start > 2000) {
                    resolve();
                    return;
                }
            }
            if (Date.now() - start > timeoutMs) {
                reject(new Error(`Timeout waiting for ${url}`));
            } else {
                setTimeout(check, 250);
            }
        }
        check();
    });
}

// Browser access (outside Electron) needs the token in the URL once; the
// renderer strips it from the address bar. The API never hands it out.
waitForHttp(`http://${host}:${webPort}/`, 90000).then(() => {
    console.log(noLaunchToken
        ? `\n🔓 Open in a browser: http://${host}:${webPort}/\n`
        : `\n🔑 Open in a browser: http://${host}:${webPort}/?token=${token}\n`);
}).catch(() => undefined);

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
            // CDP lets any local process drive the renderer (and its token), so it is opt-in.
            process.env.SCRATCHBOX_REMOTE_DEBUG === '1' ? ['.', '--remote-debugging-port=9222'] : ['.'],
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
