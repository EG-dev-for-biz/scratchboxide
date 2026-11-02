/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Renders a textured GLB in headless Chrome with three.js's own GLTFLoader (so the browser decodes the embedded PNGs,
 * independently of the test's decoder) and saves a screenshot. The page and the GLB are served from 127.0.0.1; every
 * other request is blocked. Used by the texture-pass UV tests.
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
export const twinChrome: Requirement = chromePath ? { ok: true, reason: '' } : { ok: false, reason: `headless Chrome not found (looked in ${CHROME.join(', ')})` };

const ENTRY = `
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
window.renderGlb = async (url, view) => {
    const W = view.width, H = view.height;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(view.background);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(0.4, 1, 0.6); scene.add(sun);
    const gltf = await new GLTFLoader().loadAsync(url);
    scene.add(gltf.scene);
    const box = new THREE.Box3().setFromObject(gltf.scene), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2;
    const cam = new THREE.PerspectiveCamera(40, W / H, r / 100, r * 20);
    const b = view.bearingDeg * Math.PI / 180, e = view.elevationDeg * Math.PI / 180, d = r / Math.sin(20 * Math.PI / 180) * (view.distanceScale ?? 1);
    cam.position.set(c.x + d * Math.cos(e) * Math.sin(b), c.y + d * Math.sin(e), c.z + d * Math.cos(e) * Math.cos(b));
    cam.lookAt(c);
    const images = [], textured = [];
    gltf.scene.traverse(o => {
        if (!o.isMesh) return;
        const m = o.material;
        textured.push({ name: o.name, hasUv: !!o.geometry.attributes.uv, map: !!(m && m.map) });
        if (m && m.map && m.map.image && !images.some(i => i.uuid === m.map.uuid)) images.push({ uuid: m.map.uuid, width: m.map.image.width, height: m.map.image.height });
    });
    renderer.render(scene, cam);
    const px = new Uint8Array(4); const gl = renderer.getContext();
    gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { images, textured, centre: Array.from(px), materials: gltf.parser.json.materials.map(m => m.name) };
};
window.__ready = true;
`;

export interface TwinShot { file: string; images: Array<{ width: number; height: number }>; textured: Array<{ name: string; hasUv: boolean; map: boolean }>; materials: string[]; errors: string[] }

export async function renderTwinInChrome(glb: Buffer, file: string, view: { width?: number; height?: number; bearingDeg: number; elevationDeg: number; distanceScale?: number; background?: string }): Promise<TwinShot> {
    if (!chromePath) throw new Error(twinChrome.reason);
    const width = view.width ?? 1100, height = view.height ?? 760;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const esbuild = require('esbuild') as typeof import('esbuild');
    const built = await esbuild.build({ stdin: { contents: ENTRY, resolveDir: __dirname, loader: 'js' }, bundle: true, write: false, format: 'iife', logLevel: 'error' });
    const js = Buffer.from(built.outputFiles[0].contents);
    const page = Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body><script src="/app.js"></script></body></html>`);
    const server = http.createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0];
        const body = url === '/' ? page : url === '/app.js' ? js : url === '/twin.glb' ? glb : undefined;
        if (!body) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': url === '/' ? 'text/html' : url === '/app.js' ? 'text/javascript' : 'model/gltf-binary', 'Content-Length': body.length });
        res.end(body);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-twin-chrome-'));
    const proc = spawn(chromePath, [
        '--headless=new', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
        '--ignore-gpu-blocklist', '--enable-webgl', '--enable-unsafe-swiftshader', '--force-device-scale-factor=1',
        `--window-size=${width},${height}`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });
    const errors: string[] = [];
    let ws: any;
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
            if (Date.now() - t > 30_000) throw new Error('the three.js page did not load');
            await new Promise(r => setTimeout(r, 50));
        }
        const result = await evaluate(`window.renderGlb('/twin.glb', ${JSON.stringify({ width, height, background: view.background ?? '#b0b8c4', bearingDeg: view.bearingDeg, elevationDeg: view.elevationDeg, distanceScale: view.distanceScale })})`);
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return { file, images: result.images, textured: result.textured, materials: result.materials, errors };
    } finally {
        try { ws?.close(); } catch { /* closed */ }
        proc.kill('SIGKILL');
        await new Promise<void>(r => server.close(() => r()));
        removeChromeProfile(profile);
    }
}
