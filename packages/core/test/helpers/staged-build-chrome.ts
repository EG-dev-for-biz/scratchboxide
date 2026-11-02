/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Drives the staged-build harness (fixtures/staged-build/harness.ts) in headless Chrome with real WebGL, over the
 * DevTools protocol: bundles the real Scene3DPrimitive with esbuild, serves it and the layer GLBs from 127.0.0.1,
 * blocks every other host (no Google request can leave the page), and gives the test frame stepping on a controlled
 * clock, evaluation, screenshots (test-results/screenshots/staged/, gitignored) and mouse input.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { removeChromeProfile } from './chrome-profile';
import { REPO_ROOT, type Requirement } from './requirements';

const CHROME_CANDIDATES = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
];
const chromePath = CHROME_CANDIDATES.find(p => fs.existsSync(p));

export const stagedChrome: Requirement = chromePath
    ? { ok: true, reason: '' }
    : { ok: false, reason: `headless Chrome not found (looked in ${CHROME_CANDIDATES.join(', ')})` };

export const SHOT_DIR = path.join(REPO_ROOT, 'test-results', 'screenshots', 'staged');
const WORK_DIR = path.join(REPO_ROOT, 'test-results', 'staged-build');

let bundlePromise: Promise<{ js: string; css: string }> | undefined;

/** Bundles the harness (and with it the real Scene3DPrimitive) once per test process. */
export function buildHarnessBundle(): Promise<{ js: string; css: string }> {
    bundlePromise ??= (async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const esbuild = require('esbuild') as typeof import('esbuild');
        const outdir = path.join(WORK_DIR, 'bundle');
        fs.mkdirSync(outdir, { recursive: true });
        await esbuild.build({
            entryPoints: [path.join(REPO_ROOT, 'packages', 'core', 'test', 'fixtures', 'staged-build', 'harness.ts')],
            bundle: true,
            platform: 'browser',
            format: 'iife',
            outdir,
            entryNames: 'harness',
            loader: { '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
            define: { 'process.env.NODE_ENV': '"production"' },
            banner: { js: 'window.process = window.process || { env: {} }; window.global = window;' },
            logLevel: 'silent',
            sourcemap: false
        });
        return { js: path.join(outdir, 'harness.js'), css: path.join(outdir, 'harness.css') };
    })();
    return bundlePromise;
}

export interface StagedPageOptions {
    width?: number;
    height?: number;
    /** Frames run only when the test steps them, on a clock the test advances (deterministic reveals). */
    manualFrames?: boolean;
    reducedMotion?: boolean;
    /** Where screenshots go (default test-results/screenshots/staged). */
    shotDir?: string;
    /**
     * Device pixels per CSS pixel (default 1). The viewport draws at window.devicePixelRatio, so 0.5 renders a quarter of
     * the pixels at the same CSS layout: a GPU-less host (Linux CI's software WebGL) renders each frame about 4x faster.
     */
    deviceScaleFactor?: number;
}

export interface StagedPage {
    origin: string;
    /** Serves `body` at `/models/<name>`; a held file answers only when its release() is called. */
    serve(name: string, body: Buffer | string, opts?: { hold?: boolean; contentType?: string }): { url: string; release: () => void };
    eval<T = unknown>(expression: string): Promise<T>;
    waitFor(expression: string, timeoutMs?: number, what?: string): Promise<void>;
    /** Runs n frames, advancing the clock dt ms before each, then lets React flush. */
    step(n?: number, dtMs?: number): Promise<void>;
    screenshot(name: string): Promise<string>;
    drag(from: [number, number], to: [number, number], steps?: number): Promise<void>;
    key(key: string, code?: string, opts?: { shift?: boolean }): Promise<void>;
    /** A primary-button click at page coordinates (press and release in place); alt holds the Alt key. */
    click(x: number, y: number, opts?: { alt?: boolean }): Promise<void>;
    consoleErrors(): string[];
    blockedRequests(): string[];
    close(): Promise<void>;
}

const MANUAL_FRAMES = `
<script>
(function () {
    var clock = { now: 1000 };
    window.__sbClock = clock;
    performance.now = function () { return clock.now; };
    var queue = [], nextId = 1;
    window.requestAnimationFrame = function (cb) { var id = nextId++; queue.push({ id: id, cb: cb }); return id; };
    window.cancelAnimationFrame = function (id) { for (var i = 0; i < queue.length; i++) if (queue[i].id === id) { queue.splice(i, 1); return; } };
    window.__sbStep = function (n, dt) {
        for (var k = 0; k < n; k++) {
            clock.now += dt;
            var batch = queue.splice(0);
            for (var j = 0; j < batch.length; j++) { try { batch[j].cb(clock.now); } catch (e) { console.error(e); } }
        }
    };
})();
</script>`;

export async function openStagedPage(opts: StagedPageOptions = {}): Promise<StagedPage> {
    if (!chromePath) throw new Error(stagedChrome.reason);
    const width = opts.width ?? 1100, height = opts.height ?? 720, scale = opts.deviceScaleFactor ?? 1;
    const bundle = await buildHarnessBundle();
    const files = new Map<string, { body: Buffer; type: string; held?: Promise<void> }>();
    const page = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css">
<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#111}#root{position:relative;width:${width}px;height:${height}px}</style>
${opts.manualFrames ? MANUAL_FRAMES : ''}</head><body><div id="root"></div><script src="/harness.js"></script></body></html>`;
    files.set('/index.html', { body: Buffer.from(page), type: 'text/html' });
    files.set('/harness.js', { body: fs.readFileSync(bundle.js), type: 'text/javascript' });
    if (fs.existsSync(bundle.css)) files.set('/harness.css', { body: fs.readFileSync(bundle.css), type: 'text/css' });

    const server = http.createServer(async (req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        const f = files.get(url);
        if (!f) { res.writeHead(404); res.end(); return; }
        if (f.held) await f.held;
        res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'no-store' });
        res.end(f.body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-chrome-'));
    const proc: ChildProcess = spawn(chromePath, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
        '--ignore-gpu-blocklist', '--enable-webgl', `--force-device-scale-factor=${scale}`, '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        `--window-size=${width},${height}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });

    let port = '';
    for (let i = 0; i < 200 && !port; i++) {
        await new Promise(r => setTimeout(r, 50));
        try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
    }
    if (!port) { proc.kill('SIGKILL'); server.close(); throw new Error('Chrome did not open its DevTools port'); }
    const targets: Array<{ type: string; webSocketDebuggerUrl: string }> = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json`, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
    });
    const target = targets.find(t => t.type === 'page');
    if (!target) { proc.kill('SIGKILL'); server.close(); throw new Error('no page target'); }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws');
    const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    let nextId = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    const errors: string[] = [];
    const blocked: string[] = [];
    ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== undefined) {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`${msg.error.message}`)); else p.resolve(msg.result);
        } else if (msg.method === 'Runtime.exceptionThrown') {
            errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? 'exception');
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            errors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
        } else if (msg.method === 'Network.loadingFailed' && msg.params.blockedReason) {
            blocked.push(msg.params.requestId);
        }
    });
    const send = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');
    // Only this harness's own origin is reachable: no tile, Street View or model request can leave the page.
    await send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.com/*', 'http://*.googleapis.com/*', 'http://localhost*'] });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // Always set, never inherited: a host with Reduce Motion on (GitHub's macOS runners) would otherwise show every reveal's end state at once.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: opts.reducedMotion ? 'reduce' : 'no-preference' }] });
    await send('Page.navigate', { url: `${origin}/index.html` });

    const evaluate = async <T>(expression: string): Promise<T> => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value as T;
    };
    const waitFor = async (expression: string, timeoutMs = 30_000, what = expression): Promise<void> => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            try { if (await evaluate<boolean>(`!!(${expression})`)) return; } catch { /* page still loading */ }
            await new Promise(r => setTimeout(r, 40));
        }
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    };
    await waitFor('window.sbHarness', 30_000, 'the harness bundle');

    return {
        origin,
        serve(name, body, o = {}) {
            let release = () => undefined as void;
            const held = o.hold ? new Promise<void>(r => { release = r; }) : undefined;
            files.set(`/models/${name}`, { body: typeof body === 'string' ? Buffer.from(body) : body, type: o.contentType ?? (name.endsWith('.json') ? 'application/json' : 'model/gltf-binary'), held });
            return { url: `/models/${name}`, release: () => release() };
        },
        eval: evaluate,
        waitFor,
        async step(n = 1, dtMs = 16) {
            // One frame per task, so fetches, the loader and React effects interleave with frames as they would live.
            await evaluate(`(async () => { for (let i = 0; i < ${n}; i++) { if (window.__sbStep) window.__sbStep(1, ${dtMs}); await new Promise(r => setTimeout(r, 0)); } await new Promise(r => setTimeout(r, 0)); })()`);
        },
        async screenshot(name) {
            fs.mkdirSync(opts.shotDir ?? SHOT_DIR, { recursive: true });
            const r = await send('Page.captureScreenshot', { format: 'png' });
            const file = path.join(opts.shotDir ?? SHOT_DIR, `${name}.png`);
            fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
            return file;
        },
        async drag(from, to, steps = 12) {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from[0], y: from[1] });
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from[0], y: from[1], button: 'left', clickCount: 1 });
            for (let i = 1; i <= steps; i++) {
                const x = from[0] + ((to[0] - from[0]) * i) / steps, y = from[1] + ((to[1] - from[1]) * i) / steps;
                await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
            }
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to[0], y: to[1], button: 'left', clickCount: 1 });
        },
        async key(key, code = key, o = {}) {
            const vk = key === 'Escape' ? 27 : key === 'Enter' ? 13 : key === ' ' ? 32 : key === 'Tab' ? 9 : 0;
            const modifiers = o.shift ? 8 : 0;
            // Enter and Space carry text so the page sees the keypress that activates a focused button.
            const text = key === 'Enter' ? '\r' : key === ' ' ? ' ' : undefined;
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
        },
        async click(x, y, o = {}) {
            const modifiers = o.alt ? 1 : 0;
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers });
        },
        consoleErrors: () => [...errors],
        blockedRequests: () => [...blocked],
        async close() {
            try { ws.close(); } catch { /* closed */ }
            const exited = new Promise<void>(r => { if (proc.exitCode !== null || proc.signalCode !== null) r(); else proc.once('exit', () => r()); });
            proc.kill('SIGKILL');
            await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
            await new Promise<void>(r => server.close(() => r()));
            removeChromeProfile(profile);
        }
    };
}

/** Stages the fixture layer GLBs (and the L1 order sidecar) on the page's server. */
export function serveFixture(page: StagedPage, glbs: Record<string, Buffer>, objectIdOf: (l: any) => string, sidecar?: Record<string, number>, held: string[] = []): Record<string, { url: string; release: () => void }> {
    const out: Record<string, { url: string; release: () => void }> = {};
    for (const [l, buf] of Object.entries(glbs)) out[l] = page.serve(`${objectIdOf(l)}.glb`, buf, { hold: held.includes(l) });
    if (sidecar) out.sidecar = page.serve(`${objectIdOf('l1')}.order.json`, JSON.stringify(sidecar), { hold: held.includes('sidecar') });
    return out;
}
