/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Runs a browser entry (bundled with esbuild, with the repo's three) in headless Chrome with real WebGL and returns the
 * JSON it posts to `result` (or the error it posts to `error`). For GPU passes tested on their own pixels, without the
 * app's viewport around them.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { removeChromeProfile } from './chrome-profile';

const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
];

export const webglChromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));

export async function runWebglPage<T>(entry: string, timeoutMs = 60000): Promise<T> {
    if (!webglChromePath) throw new Error(`headless Chrome not found (looked in ${CHROME_CANDIDATES.join(', ')})`);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webgl_page_'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'webgl_page_chrome_'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild') as typeof import('esbuild');
    await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(dir, 'page.js'), logLevel: 'error' });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="page.js"></script></body>');
    const server = http.createServer();
    let chrome: ChildProcess | undefined;
    try {
        return await new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`webgl page: no result within ${timeoutMs} ms`)), timeoutMs);
            server.on('request', (req, res) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                const chunks: Buffer[] = [];
                req.on('data', c => chunks.push(c));
                req.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (req.method === 'POST' && url.pathname === '/result') { clearTimeout(timer); resolve(JSON.parse(body) as T); }
                    else if (req.method === 'POST' && url.pathname === '/error') { clearTimeout(timer); reject(new Error(`webgl page: ${body}`)); }
                    else if (req.method === 'GET') {
                        const file = path.join(dir, path.basename(url.pathname === '/' ? 'index.html' : url.pathname));
                        if (fs.existsSync(file)) {
                            res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
                            res.end(fs.readFileSync(file));
                            return;
                        }
                        res.writeHead(404); res.end(); return;
                    }
                    res.writeHead(200); res.end();
                });
            });
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as { port: number }).port;
                chrome = spawn(webglChromePath, [
                    '--headless=new', `--user-data-dir=${profile}`, '--no-sandbox', '--no-first-run',
                    '--use-gl=angle', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
                    '--enable-unsafe-swiftshader', `http://127.0.0.1:${port}/`
                ], { stdio: 'ignore' });
                chrome.on('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`webgl page: Chrome exited with code ${code}`)); } });
            });
        });
    } finally {
        chrome?.kill('SIGKILL');
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        removeChromeProfile(profile);
    }
}
