/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Node side of the tree level-of-detail checks: bundles harness.ts with esbuild, writes a synthetic trees GLB at realistic
 * triangle counts, starts headless Chrome on a throwaway profile (killed hard at the end), and drives window.H over the
 * devtools protocol. No server: the page and the GLB are read from disk (file:// with file access allowed).
 */

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { buildScaledTreesGltf } from '../helpers/synthetic-trees-lod-scaled';
import { writeTreesLodGlb } from '../helpers/synthetic-trees-lod-glb';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const chromeAvailable = (): boolean => fs.existsSync(CHROME);

export interface Harness {
    /** Evaluates an expression in the page (awaiting a returned promise) and returns its JSON value. */
    eval<T = unknown>(expr: string): Promise<T>;
    /** Saves the page as a PNG. */
    screenshot(file: string): Promise<void>;
    close(): void;
}

export async function openHarness(opts: { trees?: number; areaM?: number; dir?: string; width?: number; height?: number; /** a trees GLB to load instead of the synthetic park */ glbFile?: string } = {}): Promise<{ h: Harness; init: { trees: number; ms: number } }> {
    const here = __dirname;
    const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sb-tree-lod-'));
    fs.mkdirSync(dir, { recursive: true });
    await build({ entryPoints: [path.join(here, 'harness.ts')], bundle: true, format: 'iife', outfile: path.join(dir, 'harness.bundle.js'), logLevel: 'error', target: 'chrome120' });
    fs.copyFileSync(path.join(here, 'harness.html'), path.join(dir, 'harness.html'));
    if (opts.glbFile) fs.copyFileSync(opts.glbFile, path.join(dir, 'trees.glb'));
    else writeTreesLodGlb(path.join(dir, 'trees.glb'), buildScaledTreesGltf({ trees: opts.trees ?? 1000, areaM: opts.areaM }));

    const port = 9300 + Math.floor(Math.random() * 400);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chrome-'));
    // Chrome will not start with an empty HOME (the guarded test runner blanks it): give it a throwaway one with the folders it expects.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-chrome-home-'));
    for (const d of ['Application Support', 'Caches', 'Logs']) fs.mkdirSync(path.join(home, 'Library', d), { recursive: true });
    const chrome: ChildProcess = spawn(CHROME, [
        '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--allow-file-access-from-files', '--no-first-run',
        '--no-default-browser-check', '--use-mock-keychain', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--ignore-gpu-blocklist', `--window-size=${opts.width ?? 1280},${opts.height ?? 800}`, 'about:blank'
    ], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: os.tmpdir() } });
    const close = () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } };
    try {
        let targets: Array<{ type: string; webSocketDebuggerUrl: string }> = [];
        for (let i = 0; i < 100 && targets.length === 0; i++) {
            try { targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as typeof targets).filter(t => t.type === 'page'); } catch { /* not up yet */ }
            if (targets.length === 0) await new Promise(r => setTimeout(r, 100));
        }
        if (targets.length === 0) throw new Error('Chrome did not start');
        const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
        await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('devtools socket')); });
        let id = 0;
        const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
        ws.onmessage = ev => {
            const m = JSON.parse(String(ev.data));
            if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
        };
        const send = (method: string, params: object = {}) => new Promise<any>((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
        await send('Page.enable');
        await send('Page.navigate', { url: 'file://' + path.join(dir, 'harness.html') });
        for (let i = 0; i < 100; i++) {
            const r = await send('Runtime.evaluate', { expression: 'typeof window.H', returnByValue: true });
            if (r.result.value === 'object') break;
            await new Promise(r2 => setTimeout(r2, 100));
        }
        const evaluate = async <T,>(expr: string): Promise<T> => {
            const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 600000 });
            if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
            return r.result.value as T;
        };
        const h: Harness = {
            eval: evaluate,
            async screenshot(file: string) {
                const r = await send('Page.captureScreenshot', { format: 'png' });
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
            },
            close: () => { try { ws.close(); } catch { /* ignore */ } close(); }
        };
        const init = await evaluate<{ trees: number; ms: number }>(`window.H.init('trees.glb')`);
        return { h, init };
    } catch (e) { close(); throw e; }
}
