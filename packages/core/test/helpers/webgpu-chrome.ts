/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Runs a bundled browser entry in a real Chrome with WebGPU and drives it over the DevTools
 * protocol. The page and its assets are served from 127.0.0.1; every other request is blocked.
 *
 * WebGPU needs a real (or SwiftShader) adapter and, for canvas presentation, a windowed browser:
 * in headless Linux Chrome presenting a WebGPU canvas loses the device ("A valid external Instance
 * reference no longer exists"). On Linux without a DISPLAY this helper therefore starts its own
 * Xvfb server and runs Chrome windowed on it.
 */

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { removeChromeProfile } from './chrome-profile';
import type { Requirement } from './requirements';

function findChrome(): string | undefined {
    const fixed = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium'
    ];
    const playwright = (process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers');
    let bundled: string[] = [];
    try {
        bundled = fs.readdirSync(playwright)
            .filter(d => /^chromium-\d+$/.test(d))
            .sort()
            .reverse()
            .map(d => path.join(playwright, d, 'chrome-linux', 'chrome'));
    } catch { /* no playwright browsers */ }
    return [process.env.SCRATCHBOX_CHROME, ...fixed, ...bundled].find((p): p is string => Boolean(p) && fs.existsSync(p!));
}

const chromePath = findChrome();
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const xvfbPath = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].find(p => fs.existsSync(p));

export const webgpuChrome: Requirement = !chromePath
    ? { ok: false, reason: 'Chrome/Chromium not found (set SCRATCHBOX_CHROME or install Chrome)' }
    : needsXvfb && !xvfbPath
        ? { ok: false, reason: 'no DISPLAY and no Xvfb: WebGPU canvas presentation needs a windowed Chrome on Linux (apt install xvfb)' }
        : { ok: true, reason: '' };

export interface WebGpuPage {
    evaluate: (expression: string) => Promise<any>;
    screenshot: (file: string) => Promise<void>;
    errors: string[];
}

async function startXvfb(): Promise<{ display: string; proc: ChildProcess }> {
    for (let n = 90 + Math.floor(Math.random() * 400); ; n++) {
        if (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) continue;
        const proc = spawn(xvfbPath!, [`:${n}`, '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
        for (let i = 0; i < 100; i++) {
            await new Promise(r => setTimeout(r, 30));
            if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, proc };
            if (proc.exitCode !== null) break;
        }
        proc.kill('SIGKILL');
    }
}

/**
 * Serves `files` (path -> body) plus `/` and `/app.js` (the bundled `entry`), opens the page in
 * Chrome with WebGPU enabled, waits for `window.__ready`, then hands `run` a page handle.
 */
export async function withWebGpuPage<T>(
    entry: { contents: string; resolveDir: string },
    files: Record<string, Buffer>,
    viewport: { width: number; height: number },
    run: (page: WebGpuPage) => Promise<T>
): Promise<T> {
    if (!webgpuChrome.ok) throw new Error(webgpuChrome.reason);
    const { width, height } = viewport;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild') as typeof import('esbuild');
    const built = await esbuild.build({ stdin: { contents: entry.contents, resolveDir: entry.resolveDir, loader: 'ts' }, bundle: true, write: false, format: 'iife', logLevel: 'error' });
    const js = Buffer.from(built.outputFiles[0].contents);
    const page = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}</style></head><body><script src="/app.js"></script></body></html>`);
    const server = http.createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        const body = url === '/' ? page : url === '/app.js' ? js : files[url];
        if (!body) { res.writeHead(404); res.end(); return; }
        const type = url === '/' ? 'text/html' : url === '/app.js' ? 'text/javascript' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
        // Two writes so the browser sees the body arrive as a stream, not one chunk.
        const half = Math.floor(body.length / 2);
        res.write(body.subarray(0, half));
        setTimeout(() => res.end(body.subarray(half)), 5);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-webgpu-chrome-'));
    const xvfb = needsXvfb ? await startXvfb() : null;
    const flags = [
        '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
        '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1',
        ...(process.platform === 'linux' ? ['--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--no-sandbox'] : []),
        ...(xvfb || process.platform !== 'linux' ? [] : ['--headless=new']),
        `--window-size=${width},${height}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ];
    const proc = spawn(chromePath!, flags, { stdio: 'ignore', env: { ...process.env, ...(xvfb ? { DISPLAY: xvfb.display } : {}) } });
    const errors: string[] = [];
    let ws: any;
    try {
        let port = '';
        for (let i = 0; i < 300 && !port; i++) {
            await new Promise(r => setTimeout(r, 50));
            try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
        }
        if (!port) throw new Error('Chrome did not open its DevTools port');
        const targets: Array<{ type: string; webSocketDebuggerUrl: string }> = await new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/json`, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
        });
        const target = targets.find(t => t.type === 'page');
        if (!target) throw new Error('no page target');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const WebSocket = require('ws');
        ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        let id = 0;
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
        ws.on('message', (raw: Buffer) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id !== undefined) {
                const p = pending.get(msg.id); pending.delete(msg.id);
                if (p) { if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
            } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
            else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
        });
        const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
        await send('Runtime.enable');
        await send('Network.enable');
        await send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.com/*', 'http://localhost*'] });
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await send('Page.navigate', { url: `${origin}/` });
        const evaluate = async (expression: string): Promise<any> => {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
            return r.result.value;
        };
        for (let t = Date.now(); !(await evaluate('!!window.__ready').catch(() => false)); ) {
            if (Date.now() - t > 30_000) throw new Error('the test page did not load');
            await new Promise(r => setTimeout(r, 50));
        }
        const screenshot = async (file: string) => {
            const shot = await send('Page.captureScreenshot', { format: 'png' });
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        };
        return await run({ evaluate, screenshot, errors });
    } finally {
        try { ws?.close(); } catch { /* closed */ }
        proc.kill('SIGKILL');
        xvfb?.proc.kill('SIGKILL');
        await new Promise<void>(r => server.close(() => r()));
        removeChromeProfile(profile);
    }
}
