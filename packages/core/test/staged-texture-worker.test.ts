/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture stage's worker threads (texture-worker-pool.ts): the same bytes as the main-thread pass, a main thread that
 * keeps answering while a layer bakes, a stop that terminates the thread, a crash that comes back typed.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { monitorEventLoopDelay } from 'perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import type { ProjectionView } from '../src/common/spatial/texture-pass-contracts';
import { decodePng } from '../src/node/texture-processing';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { textureLayer, type PaletteFace, type TextureLayerOutcome, type TexturePassSources } from '../src/node/3d-engine/staged-location/texture-pass';
import { prepareTextureSources } from '../src/node/3d-engine/staged-location/texture-sources';
import { TextureWorkerCrashError, TextureWorkerPool } from '../src/node/3d-engine/staged-location/texture-worker-pool';
import { loadTileSurface } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { eventLoopStats } from '../src/node/3d-engine/staged-location/event-loop-stats';
import { FACADE, facadeViews } from './helpers/texture-pass-fixtures';
import { buildTileGlb, facadeTileSheet } from './helpers/tile-photo-glb';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/texture_worker');

function clayFacade(): { glb: Buffer; surfaces: Array<{ id: string; chart: any }> } {
    const nx = 10, ny = 6, pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) pos.push((FACADE.widthM * i) / nx, (FACADE.heightM * j) / ny, 0);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
    }
    const glb = writeStagedGlb([{ name: 's00', positions: Float32Array.from(pos), indices: Uint32Array.from(idx), extras: { sb: { schema: 'scratchbox.staged-node/2', stage: 'fit', ids: { surfaceId: 's00' } } } }], { rootExtras: { sb: { stage: 'fit' } } });
    const surfaces = [{ id: 's00', chart: { plane: { origin: FACADE.origin, u: FACADE.u, v: FACADE.v, normal: FACADE.normal, extentUv: [[0, 0], [FACADE.widthM, 0], [FACADE.widthM, FACADE.heightM], [0, FACADE.heightM]] } } }];
    return { glb, surfaces };
}

const occluder = () => {
    const nx = 10, ny = 6, v: number[] = [], i: number[] = [];
    for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) v.push((FACADE.widthM * x) / nx, (FACADE.heightM * y) / ny, 0);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const a = y * (nx + 1) + x; i.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2); }
    return { vertices: Float32Array.from(v), indices: Uint32Array.from(i) };
};

const views = (): ProjectionView[] => facadeViews().map(v => ({ ...v, poseQuality: 1, poseSigmaPx: 0 }));
const PALETTE: PaletteFace[] = [{ headingDeg: 180, colours: [{ srgb: [182, 170, 150] as Vec3, share: 0.7 }, { srgb: [90, 80, 70] as Vec3, share: 0.3 }] }];
/** A deterministic model: answers with the crop it was sent. */
const echo: EnhanceModelClient = async req => ({ bytes: Uint8Array.from(req.image.bytes), mimeType: 'image/png', modelUsed: 'stub-image-model', requestedModels: req.models, skippedModels: [], modelNote: 'stub' });

function sources(over: Partial<TexturePassSources> = {}): TexturePassSources {
    const tileGlb = buildTileGlb([facadeTileSheet(0.05)]);
    return { views: views(), occluder: occluder(), context: occluder(), tile: loadTileSurface(tileGlb), palette: PALETTE, densityTexelsPerMeter: 8, maxSide: 256, ...over };
}

const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

/** Wall-clock fields the twin records (the UV layout's own `ms`): not part of the result. */
const withoutClock = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === 'ms' ? undefined : x)));

/**
 * The twin's binary chunk hashed, its JSON hashed without the clock fields, and each embedded image's decoded pixels
 * hashed (the baked albedo and confidence planes).
 */
function fingerprint(out: TextureLayerOutcome): { bin: string; json: string; planes: string[] } {
    const g = parseGlbBytes(out.glb);
    const planes = (g.json.images ?? []).map((img: any) => {
        const bv = g.json.bufferViews[img.bufferView];
        const png = Buffer.from(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
        const d = decodePng(png);
        return `${d.width}x${d.height}:${sha(d.rgba)}`;
    });
    return { bin: sha(g.bin), json: sha(Buffer.from(JSON.stringify(withoutClock(g.json)))), planes };
}

function comparable(out: TextureLayerOutcome): unknown {
    const { glb: _g, measureLoo: _m, timingsMs: _t, projection, ...rest } = out as TextureLayerOutcome & { release?: unknown };
    delete (rest as { release?: unknown }).release;
    const p = projection ? { ...projection, timingsMs: undefined } : undefined;
    return withoutClock({ ...rest, projection: p });
}

function saveAlbedo(out: TextureLayerOutcome, name: string): void {
    const g = parseGlbBytes(out.glb);
    const img = g.json.images?.[0];
    if (!img) return;
    const bv = g.json.bufferViews[img.bufferView];
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)));
}

const pools: TextureWorkerPool[] = [];
const pool = (size = 2, entry?: string) => { const p = new TextureWorkerPool({ size, ...(entry ? { entry } : {}) }); pools.push(p); return p; };
afterAll(() => { for (const p of pools) p.close(); });

describe('texture worker pool', () => {
    it('bakes a layer bit-identical to the main-thread pass (GLB, albedo and confidence planes, report), the enhancement and the leave-one-pano-out job included', async () => {
        const c = clayFacade();
        const src = sources({ enhance: { client: echo, models: ['stub-image-model'] } });
        const inline = await textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, src);
        const p = pool();
        const progress: string[] = [];
        const worker = await p.textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, { ...src, onProgress: m => progress.push(m) });
        const a = fingerprint(inline), b = fingerprint(worker);
        expect(a.planes.length).toBeGreaterThanOrEqual(2);
        expect(b).toEqual(a);
        expect(comparable(worker)).toEqual(comparable(inline));
        expect(worker.enhance?.charts).toBeGreaterThan(0);
        expect(progress.some(m => m.includes('laying out the UV atlas'))).toBe(true);
        expect(inline.measureLoo && worker.measureLoo).toBeTruthy();
        const [looA, looB] = [await inline.measureLoo!(), await worker.measureLoo!()];
        expect(withoutClock(looB)).toEqual(withoutClock(looA));
        saveAlbedo(worker, 'test_worker_albedo');
        saveAlbedo(inline, 'test_inline_albedo');
    }, 180_000);

    it('prepares the stage sources the same in a thread as inline (tile samples, meshes, tile hash)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_tex_worker_'));
        try {
            const tileFile = path.join(dir, 'tile.glb');
            fs.writeFileSync(tileFile, buildTileGlb([facadeTileSheet(0.05)]));
            const clayFile = path.join(dir, 'clay.glb');
            fs.writeFileSync(clayFile, clayFacade().glb);
            // three grounding JPEGs decoded under a registration (a Map of corrections crosses the thread too)
            const images = facadeViews().map((v, k) => ({
                view: { panoId: v.panoId, eye: v.camera.eye, headingDeg: 180 + (k - 1) * 20, pitchDeg: 2, fovDeg: 70, facadeHeadingDeg: 180 } as any,
                bytes: Buffer.from(jpegJs.encode({ width: v.image.width, height: v.image.height, data: Buffer.from(v.image.rgba) }, 92).data),
                widthPx: v.image.width, heightPx: v.image.height
            }));
            const registration = { corrections: new Map([[images[0].view.panoId, { dx: 0.2, dy: 0, dz: 0, dyawDeg: 0.5, dpitchDeg: 0, drollDeg: 0 }]]), perPano: [], setAside: [], pairs: [], beforeRmsM: 1, afterRmsM: 0.4, used: 3, rejected: 0 } as any;
            const input = { images, wide: images.slice(0, 1), registration, texturedGlb: tileFile, occluderFiles: [clayFile], contextFiles: [clayFile, path.join(dir, 'missing.glb')] };
            const inline = prepareTextureSources(input);
            const worker = await pool(1).prepare(input);
            expect(worker.tileSha).toBe(inline.tileSha);
            expect(inline.views.length).toBe(3);
            const viewKey = (v: ProjectionView) => ({ ...v, image: { width: v.image.width, height: v.image.height, rgba: sha(v.image.rgba) } });
            expect(worker.views.map(viewKey)).toEqual(inline.views.map(viewKey));
            expect(worker.wideViews.map(viewKey)).toEqual(inline.wideViews.map(viewKey));
            expect(worker.views[0].image.rgba.buffer instanceof SharedArrayBuffer).toBe(true);
            expect(worker.tile && inline.tile).toBeTruthy();
            expect(worker.tile!.texelSizeM).toBe(inline.tile!.texelSizeM);
            expect(worker.occluder.vertices).toEqual(inline.occluder.vertices);
            expect(worker.context.indices).toEqual(inline.context.indices);
            expect((worker.occluder.vertices as Float32Array).buffer instanceof SharedArrayBuffer).toBe(true);
            for (let k = 0; k < 400; k++) {
                const P: Vec3 = [(k % 20) * 0.5, Math.floor(k / 20) * 0.3, -0.02];
                expect(worker.tile!.sample(P, [0, 0, -1], 0.5)).toEqual(inline.tile!.sample(P, [0, 0, -1], 0.5));
            }
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);

    it('keeps the main thread answering while a layer bakes: a 20 ms timer is never more than 100 ms late (inline it is seconds)', async () => {
        const c = clayFacade();
        const heavy = sources({ densityTexelsPerMeter: 160, maxSide: 2048 });
        const p = pool(1);
        // the thread loaded first, so the measurement is of the bake alone
        await p.warm(1);
        const watch = async (work: () => Promise<unknown>) => {
            const h = monitorEventLoopDelay({ resolution: 5 });
            let worst = 0, last = performance.now();
            const tick = setInterval(() => { const t = performance.now(); worst = Math.max(worst, t - last - 20); last = t; }, 20);
            h.enable();
            const t0 = performance.now();
            await work();
            const ms = performance.now() - t0;
            h.disable();
            clearInterval(tick);
            return { worstLateMs: Math.round(worst), ms: Math.round(ms), ...eventLoopStats(h) };
        };
        const inWorker = await watch(() => p.textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, heavy));
        const inline = await watch(() => textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, heavy));
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'test_event_loop.json'), JSON.stringify({ worker: inWorker, inline }, null, 1));
        expect(inWorker.worstLateMs).toBeLessThan(100);
        expect(inWorker.eventLoopMaxMs).toBeLessThan(100);
        // inline the same bake holds the thread for seconds (the timer's lateness; vitest runs this file in a worker
        // thread, where the histogram does not see that thread's own blocks)
        expect(inline.worstLateMs).toBeGreaterThan(1_000);
    }, 300_000);

    it('a stop rejects at once with the signal\'s reason and terminates the thread', async () => {
        const c = clayFacade();
        const p = pool(1);
        const ctl = new AbortController();
        const job = p.textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources({ densityTexelsPerMeter: 160, maxSide: 2048, signal: ctl.signal, onProgress: m => { if (m.includes('projecting')) ctl.abort(Object.assign(new Error('the user stopped the build'), { name: 'AbortError' })); } }));
        const t0 = Date.now();
        await expect(job).rejects.toMatchObject({ name: 'AbortError', message: 'the user stopped the build' });
        expect(Date.now() - t0).toBeLessThan(120_000);
        expect(p.threads).toBe(0);
        // the thread is really gone: its exit is observed (terminated after the grace at the latest)
        await new Promise(r => setTimeout(r, 1_500));
        expect(p.exited().length).toBe(1);
        // the pool still works after a stop
        const again = await p.textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources());
        expect(again.glb.readUInt32LE(0)).toBe(0x46546c67);
    }, 300_000);

    it('a thread that dies rejects its job with TextureWorkerCrashError', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb_tex_crash_'));
        const entry = path.join(dir, 'crash-worker.js');
        fs.writeFileSync(entry, "const { parentPort } = require('worker_threads'); parentPort.postMessage({ type: 'ready' }); parentPort.on('message', () => process.exit(7));");
        try {
            const p = pool(1, entry);
            const c = clayFacade();
            const err = await p.textureLayer({ layerKey: 'l3b', clayGlb: c.glb, surfaces: c.surfaces }, sources()).catch(e => e);
            expect(err).toBeInstanceOf(TextureWorkerCrashError);
            expect((err as TextureWorkerCrashError).exitCode).toBe(7);
            expect(p.threads).toBe(0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 60_000);
});
