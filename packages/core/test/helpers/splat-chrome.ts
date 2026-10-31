/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Renders splat sets with the app's PhotorealGaussianSplatMesh in headless Chrome (WebGL via SwiftShader) and reads the
 * pixels back. The page and the splat files are served from 127.0.0.1; every other request is blocked.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { removeChromeProfile } from './chrome-profile';
import type { Requirement } from './requirements';

const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium'];
const chromePath = CHROME.find(p => fs.existsSync(p));
export const splatChrome: Requirement = chromePath ? { ok: true, reason: '' } : { ok: false, reason: `headless Chrome not found (looked in ${CHROME.join(', ')})` };

export const SPLAT_MESH_MODULE = path.resolve(__dirname, '../../src/browser/generative-canvas/services/spatial/PhotorealGaussianSplatMesh.ts');
const SCENE3D_MODULE = path.resolve(__dirname, '../../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx');

const entry = (meshModule: string, inHouse: boolean) => `
import * as THREE from 'three';
import { PhotorealGaussianSplatMesh } from ${JSON.stringify(meshModule)};
${inHouse ? `import { InHouseSplatViewer } from ${JSON.stringify(SCENE3D_MODULE)};` : 'const InHouseSplatViewer = undefined;'}
let renderer, scene, mesh, inHouse;
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function setMesh(data, opts) {
    if (inHouse) { scene.remove(inHouse.group); inHouse.dispose(); inHouse = undefined; }
    if (mesh) { scene.remove(mesh); mesh.dispose(); }
    mesh = new PhotorealGaussianSplatMesh(data, opts || {});
    scene.add(mesh);
    return { count: data.count, bounds: data.bounds, centroid: data.centroid };
}
window.sbx = {
    init(w, h, bg) {
        renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, alpha: false });
        renderer.setPixelRatio(1); renderer.setSize(w, h);
        document.body.appendChild(renderer.domElement);
        scene = new THREE.Scene(); scene.background = new THREE.Color(bg);
    },
    async loadUrl(url, format, opts) {
        const buf = await (await fetch(url)).arrayBuffer();
        const data = format === 'spz' ? await PhotorealGaussianSplatMesh.parseSpzBuffer(buf) : PhotorealGaussianSplatMesh.parseSplatBuffer(buf);
        return setMesh(data, opts);
    },
    /** Loads the splats into the Scene3D primitive's InHouseSplatViewer instead of PhotorealGaussianSplatMesh. */
    loadInHouse(d) {
        if (mesh) { scene.remove(mesh); mesh.dispose(); mesh = undefined; }
        if (inHouse) { scene.remove(inHouse.group); inHouse.dispose(); }
        inHouse = new InHouseSplatViewer();
        const g = [];
        for (let i = 0; i < d.opacities.length; i++) g.push({ position: d.positions.slice(i * 3, i * 3 + 3), scale: d.scales.slice(i * 3, i * 3 + 3),
            quaternion: d.quats.slice(i * 4, i * 4 + 4), colorRgb: d.colors.slice(i * 3, i * 3 + 3), opacity: d.opacities[i] });
        inHouse.loadSplatObservation(g);
        scene.add(inHouse.group);
        return { count: g.length };
    },
    loadInline(d, opts) {
        const data = { count: d.opacities.length, positions: new Float32Array(d.positions), scales: new Float32Array(d.scales),
            colors: new Float32Array(d.colors), opacities: new Float32Array(d.opacities), quats: new Float32Array(d.quats) };
        return setMesh(data, opts);
    },
    render(v) {
        const W = renderer.domElement.width, H = renderer.domElement.height;
        const cam = new THREE.PerspectiveCamera(v.fovDeg, W / H, v.near ?? 0.05, v.far ?? 5000);
        cam.position.fromArray(v.camPos); cam.up.fromArray(v.up ?? [0, 1, 0]); cam.lookAt(new THREE.Vector3().fromArray(v.target));
        cam.updateMatrixWorld(true);
        const t0 = performance.now();
        if (mesh) mesh.updateDepthSort(cam, true);
        if (inHouse) inHouse.updateCamera(cam);
        const sortMs = performance.now() - t0;
        renderer.render(scene, cam);
        const gl = renderer.getContext();
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { width: W, height: H, sortMs, rgba: v.readback === false ? '' : b64(px) };
    }
};
window.__ready = true;
`;

export interface SplatView { camPos: number[]; target: number[]; fovDeg: number; near?: number; far?: number; up?: number[]; readback?: boolean }
export interface InlineSplats { positions: number[]; scales: number[]; colors: number[]; opacities: number[]; quats: number[] }
export interface SplatShot { width: number; height: number; sortMs: number; rgba: Uint8Array }

export interface SplatChromeSession {
    loadInline(data: InlineSplats, options?: Record<string, unknown>): Promise<{ count: number }>;
    /** Only with `inHouseViewer: true`. */
    loadInHouse(data: InlineSplats): Promise<{ count: number }>;
    loadFile(file: string, format: 'splat' | 'spz', options?: Record<string, unknown>): Promise<{ count: number; bounds?: { min: number[]; max: number[] }; centroid?: number[] }>;
    /** Renders, optionally saves a PNG screenshot, and returns the RGBA read back (bottom-up rows, as from glReadPixels). */
    render(view: SplatView, screenshot?: string): Promise<SplatShot>;
    errors: string[];
    close(): Promise<void>;
}

export async function openSplatChrome(opts: { width: number; height: number; background?: string; meshModule?: string; inHouseViewer?: boolean }): Promise<SplatChromeSession> {
    if (!chromePath) throw new Error(splatChrome.reason);
    const { width, height } = opts;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild') as typeof import('esbuild');
    const built = await esbuild.build({ stdin: { contents: entry(opts.meshModule ?? SPLAT_MESH_MODULE, !!opts.inHouseViewer), resolveDir: __dirname, loader: 'js' }, bundle: true, write: false, format: 'iife', logLevel: 'error',
        loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
    const js = Buffer.from(built.outputFiles[0].contents);
    const page = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}</style></head><body><script src="/app.js"></script></body></html>`);
    const files = new Map<string, string>();
    const server = http.createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        if (url === '/' || url === '/app.js') {
            const body = url === '/' ? page : js;
            res.writeHead(200, { 'Content-Type': url === '/' ? 'text/html' : 'text/javascript', 'Content-Length': body.length });
            res.end(body);
            return;
        }
        const file = files.get(url);
        if (!file) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-splat-chrome-'));
    const proc = spawn(chromePath, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
        '--ignore-gpu-blocklist', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1',
        `--window-size=${width},${height}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });
    const errors: string[] = [];
    let ws: any;
    const cleanup = async () => {
        try { ws?.close(); } catch { /* closed */ }
        proc.kill('SIGKILL');
        await new Promise<void>(r => server.close(() => r()));
        removeChromeProfile(profile);
    };
    try {
        let port = '';
        for (let i = 0; i < 200 && !port; i++) {
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
        ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 1024 * 1024 * 1024 });
        await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        let id = 0;
        const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
        ws.on('message', (raw: Buffer) => {
            const msg = JSON.parse(raw.toString());
            if (msg.id !== undefined) {
                const p = pending.get(msg.id); pending.delete(msg.id);
                if (p) { if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result); }
            } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
            else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) errors.push(msg.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '));
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
            if (Date.now() - t > 30_000) throw new Error('the splat page did not load');
            await new Promise(r => setTimeout(r, 50));
        }
        await evaluate(`window.sbx.init(${width}, ${height}, ${JSON.stringify(opts.background ?? '#000000')})`);
        let fileId = 0;
        return {
            errors,
            loadInline: (data, options) => evaluate(`window.sbx.loadInline(${JSON.stringify(data)}, ${JSON.stringify(options ?? {})})`),
            loadInHouse: data => evaluate(`window.sbx.loadInHouse(${JSON.stringify(data)})`),
            loadFile: (file, format, options) => {
                const url = `/f${++fileId}.${format}`;
                files.set(url, file);
                return evaluate(`window.sbx.loadUrl(${JSON.stringify(url)}, ${JSON.stringify(format)}, ${JSON.stringify(options ?? {})})`);
            },
            render: async (view, screenshot) => {
                const r = await evaluate(`window.sbx.render(${JSON.stringify(view)})`);
                if (screenshot) {
                    const shot = await send('Page.captureScreenshot', { format: 'png' });
                    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
                    fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'));
                }
                return { width: r.width, height: r.height, sortMs: r.sortMs, rgba: new Uint8Array(Buffer.from(r.rgba, 'base64')) };
            },
            close: cleanup
        };
    } catch (err) {
        await cleanup();
        throw err;
    }
}
