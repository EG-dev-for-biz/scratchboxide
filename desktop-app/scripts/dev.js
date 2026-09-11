#!/usr/bin/env node
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * SPDX-License-Identifier: MIT
 *
 * Dev launcher: mints one per-launch API token and starts the backend and the
 * Vite dev server with it, so the Vite proxy can inject the token into every
 * forwarded request and the backend accepts exactly that token.
 ********************************************************************************/

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const token = process.env.SCRATCHBOX_LAUNCH_TOKEN || crypto.randomBytes(32).toString('hex');

const env = {
    ...process.env,
    SCRATCHBOX_LAUNCH_TOKEN: token,
    NODE_ENV: process.env.NODE_ENV || 'development'
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

child.on('exit', code => {
    process.exit(code === null ? 1 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        child.kill(signal);
    });
}
