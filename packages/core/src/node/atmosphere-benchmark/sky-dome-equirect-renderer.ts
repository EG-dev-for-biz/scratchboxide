/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Renders the real sky dome (createAtmosphericSkyDome) in headless Chrome as linear-light equirectangular panoramas,
 * one per config, plus the sun and hemisphere lights the dome adds to a scene. The page is bundled with esbuild into a
 * temporary directory and served from an ephemeral port; Chrome, the server and the directory are cleaned up on exit.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import type { AtmosphericScatteringConfig } from '../../browser/generative-canvas/services/atmosphere/atmosphere-types';
import type { EquirectImage } from './equirect-sky';

export interface DomeLights {
    sunIntensity: number;
    sunColor: [number, number, number];
    hemiIntensity: number;
    hemiSkyLuminance: number;
    hemiGroundLuminance: number;
    castShadow: boolean;
}

export interface DomeRender { image: EquirectImage; lights: DomeLights }

const CHROME_CANDIDATES = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
].filter((p): p is string => !!p);

function findChrome(): string {
    const found = CHROME_CANDIDATES.find(p => fs.existsSync(p));
    if (!found) throw new Error(`sky dome renderer: no Chrome/Chromium found (tried ${CHROME_CANDIDATES.join(', ')}); set CHROME_BIN`);
    return found;
}

async function bundlePage(outDir: string): Promise<void> {
    const esbuild = await import('esbuild');
    await esbuild.build({
        entryPoints: [path.join(__dirname, 'sky-dome-page.ts')],
        bundle: true,
        format: 'iife',
        outfile: path.join(outDir, 'page.js'),
        logLevel: 'error'
    });
    fs.writeFileSync(path.join(outDir, 'index.html'), '<!doctype html><meta charset="utf-8"><body><script src="page.js"></script></body>');
}

export interface RenderOptions {
    width?: number;
    height?: number;
    timeSeconds?: number;
    /** Per batch. Default 60 s. */
    timeoutMs?: number;
    /** Configs per Chrome instance. Default 10. */
    batchSize?: number;
    /** Attempts per batch (headless GPU contexts occasionally hang on the volumetric clouds). Default 3. */
    attempts?: number;
    onProgress?: (done: number, total: number) => void;
}

/**
 * Renders each config as a width x height linear equirectangular panorama, in batches of fresh Chrome instances. A
 * batch that fails every attempt fails the whole call with its config indices; nothing is dropped.
 */
export async function renderSkyDomeEquirects(configs: AtmosphericScatteringConfig[], opts: RenderOptions = {}): Promise<DomeRender[]> {
    const size = opts.batchSize ?? 10, attempts = opts.attempts ?? 3;
    const all: DomeRender[] = [];
    for (let start = 0; start < configs.length; start += size) {
        const batch = configs.slice(start, start + size);
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                all.push(...await renderBatch(batch, { ...opts, onProgress: (d) => opts.onProgress?.(start + d, configs.length) }));
                lastError = undefined;
                break;
            } catch (err) {
                lastError = err;
            }
        }
        if (lastError) throw new Error(`sky dome renderer: configs ${start}-${start + batch.length - 1} failed ${attempts} times: ${(lastError as Error).message}`);
    }
    return all;
}

async function renderBatch(configs: AtmosphericScatteringConfig[], opts: RenderOptions): Promise<DomeRender[]> {
    const width = opts.width ?? 512, height = opts.height ?? 256;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sky_dome_render_'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sky_dome_chrome_'));
    await bundlePage(dir);
    fs.writeFileSync(path.join(dir, 'specs.json'), JSON.stringify(configs.map(config => ({ config, width, height, timeSeconds: opts.timeSeconds ?? 120 }))));

    const results: Array<Partial<DomeRender>> = configs.map(() => ({}));
    let chrome: ChildProcess | undefined;
    const server = http.createServer();
    try {
        return await new Promise<DomeRender[]>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`sky dome renderer: no result within ${opts.timeoutMs ?? 60000} ms`)), opts.timeoutMs ?? 60000);
            server.on('request', (req, res) => {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                const chunks: Buffer[] = [];
                req.on('data', c => chunks.push(c));
                req.on('end', () => {
                    const body = Buffer.concat(chunks);
                    const i = Number(url.searchParams.get('i'));
                    if (req.method === 'POST' && url.pathname === '/lights') opts.onProgress?.(i + 1, configs.length);
                    if (req.method === 'POST' && url.pathname === '/result') {
                        results[i].image = { width, height, rgb: new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)) };
                    } else if (req.method === 'POST' && url.pathname === '/lights') {
                        results[i].lights = JSON.parse(body.toString('utf8'));
                    } else if (req.method === 'POST' && url.pathname === '/error') {
                        clearTimeout(timer);
                        reject(new Error(`sky dome renderer: config ${i} failed in the page: ${body.toString('utf8')}`));
                    } else if (req.method === 'POST' && url.pathname === '/done') {
                        clearTimeout(timer);
                        const missing = results.findIndex(r => !r.image || !r.lights);
                        if (missing >= 0) reject(new Error(`sky dome renderer: config ${missing} returned no panorama`));
                        else resolve(results as DomeRender[]);
                    } else if (req.method === 'GET') {
                        const file = path.join(dir, path.basename(url.pathname === '/' ? 'index.html' : url.pathname));
                        if (fs.existsSync(file)) {
                            res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.json') ? 'application/json' : 'text/html' });
                            res.end(fs.readFileSync(file));
                            return;
                        }
                        res.writeHead(404);
                        res.end();
                        return;
                    }
                    res.writeHead(200);
                    res.end();
                });
            });
            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as { port: number }).port;
                chrome = spawn(findChrome(), [
                    '--headless=new', `--user-data-dir=${profile}`, '--no-sandbox', '--no-first-run',
                    '--use-gl=angle', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
                    '--enable-unsafe-swiftshader', `http://127.0.0.1:${port}/`
                ], { stdio: 'ignore' });
                chrome.on('exit', code => { if (code) { clearTimeout(timer); reject(new Error(`sky dome renderer: Chrome exited with code ${code}`)); } });
            });
        });
    } finally {
        chrome?.kill('SIGKILL');
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
        fs.rmSync(profile, { recursive: true, force: true });
    }
}
