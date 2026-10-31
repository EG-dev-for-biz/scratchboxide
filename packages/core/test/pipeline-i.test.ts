/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { registerToFootprint, applyRootTransform, stripMaterials } from '../src/node/3d-engine/staged-location/pipeline-i/register';
import { planSheetStations } from '../src/node/3d-engine/staged-location/pipeline-i/sheet-stations';
import { createFalTrellisClient, resolveFalKey, TRELLIS_MODEL, type ModelClient } from '../src/node/3d-engine/staged-location/pipeline-i/fal-trellis';
import { colourMatchGlb, measureSwatch, rgbToLab } from '../src/node/3d-engine/staged-location/pipeline-i/swatch';
import { decodeImageToRgbaSync } from '../src/node/image-codec-ffmpeg';
import { runPipelineI, MODEL_VIEW_PX } from '../src/node/3d-engine/staged-location/pipeline-i/pipeline-i';
import { parseGlbBytes, readPositionsExact, nodeWorldMatrices, transformPoint } from '../src/node/3d-engine/staged-location/glb-bytes';
import { readGlbScene, sceneToRenderMesh } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { StationImageGenerator } from '../src/node/spatial/BeautifyStationService';
import { decodePng, encodePng } from '../src/node/texture-processing';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-pipeline-i-'));
afterAll(() => fs.removeSync(WORK));
const ANCHOR = { lat: 40.7218, lng: -73.9995, elevationMeters: 0, headingDeg: 0, formattedAddress: 'test' };

type V3 = [number, number, number];
/** Surface of axis-aligned boxes, every face gridded at `step` (a dense mesh, like a generated model's), as positions + indices. */
function boxesSurface(boxes: Array<{ min: V3; max: V3 }>, step = 0.5): { pos: number[]; idx: number[] } {
    const pos: number[] = [], idx: number[] = [];
    const face = (o: V3, u: V3, v: V3, nu: number, nv: number) => {
        const base = pos.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) pos.push(o[0] + u[0] * i / nu + v[0] * j / nv, o[1] + u[1] * i / nu + v[1] * j / nv, o[2] + u[2] * i / nu + v[2] * j / nv);
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i; idx.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1); }
    };
    for (const { min: [x0, y0, z0], max: [x1, y1, z1] } of boxes) {
        const nx = Math.max(1, Math.round((x1 - x0) / step)), ny = Math.max(1, Math.round((y1 - y0) / step)), nz = Math.max(1, Math.round((z1 - z0) / step));
        face([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], nx, ny); face([x1, y0, z0], [x0 - x1, 0, 0], [0, y1 - y0, 0], nx, ny);
        face([x1, y0, z1], [0, 0, z0 - z1], [0, y1 - y0, 0], nz, ny); face([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], nz, ny);
        face([x0, y1, z1], [x1 - x0, 0, 0], [0, 0, z0 - z1], nx, nz);
    }
    return { pos, idx };
}

/** A GLB with one textured mesh (base-colour PNG, UVs) under a node with the given matrix. */
function texturedGlb(pos: number[], idx: number[], matrix?: number[]): Buffer {
    const P = Buffer.from(new Float32Array(pos).buffer), n = pos.length / 3;
    const uv: number[] = []; for (let i = 0; i < n; i++) uv.push((i % 7) / 7, (i % 5) / 5);
    const U = Buffer.from(new Float32Array(uv).buffer), I = Buffer.from(new Uint32Array(idx).buffer);
    const png = encodePng(2, 2, Buffer.from([200, 60, 40, 255, 190, 70, 50, 255, 180, 80, 60, 255, 170, 90, 70, 255]));
    const pad = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
    const parts = [P, U, I, png].map(pad); let off = 0;
    const views = parts.map((b, k) => { const v = { buffer: 0, byteOffset: off, byteLength: [P, U, I, png][k].length }; off += b.length; return v; });
    const min = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), max = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'model', mesh: 0, ...(matrix ? { matrix } : {}) }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
        accessors: [{ bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min, max }, { bufferView: 1, componentType: 5126, count: n, type: 'VEC2' }, { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' }],
        bufferViews: views, buffers: [{ byteLength: off }]
    };
    let js = Buffer.from(JSON.stringify(json)); js = js.length % 4 ? Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)]) : js;
    const bin = Buffer.concat(parts);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([h, jh, js, bh, bin]);
}

// the truth: an L-shaped structure 24 m tall in the tile frame, and its footprint cells
const L_BOXES: Array<{ min: V3; max: V3 }> = [{ min: [10, 0, -5], max: [30, 24, 5] }, { min: [10, 0, 5], max: [18, 24, 17] }];
const L_CELLS = new Set<string>();
for (const b of L_BOXES) for (let x = b.min[0]; x < b.max[0]; x++) for (let z = b.min[2]; z < b.max[2]; z++) L_CELLS.add(`${x},${z}`);
/** The L as a generator would hand it back: its own frame (unit height, mirrored, yawed), standing on a base slab. */
function generatedL(yawDeg: number, mirror: boolean): { pos: number[]; idx: number[] } {
    const local = boxesSurface([...L_BOXES.map(b => ({ min: [b.min[0] - 20, 0, b.min[2] - 6] as V3, max: [b.max[0] - 20, 24, b.max[2] - 6] as V3 })), { min: [-14, -1, -15], max: [14, 0, 15] }]);
    const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), k = 1 / 25;
    const pos: number[] = [];
    for (let i = 0; i < local.pos.length; i += 3) { const x = local.pos[i], y = local.pos[i + 1], z = local.pos[i + 2]; pos.push(k * (mirror ? -1 : 1) * (c * x + s * z), k * y, k * (-s * x + c * z)); }
    return { pos, idx: local.idx };
}

describe('pipeline I: fitting a generated model onto the scan', () => {
    for (const [yaw, mirror] of [[37, false], [212, true]] as Array<[number, boolean]>) {
        it(`recovers a model handed back at its own scale, yawed ${yaw} deg${mirror ? ' and mirrored' : ''}, on a base slab`, () => {
            const g = generatedL(yaw, mirror);
            const fit = registerToFootprint(g.pos, { cells: L_CELLS, groundY: 2, heightM: 24 });
            expect(fit.planIoU).toBeGreaterThan(0.8);
            expect(fit.overflowShare).toBeLessThan(0.2);
            expect(fit.coverage).toBeGreaterThan(0.8);
            expect(fit.mirrored).toBe(mirror);
            // the fitted model's base sits on the ground and its plan on the footprint
            const tops: number[] = [];
            let inside = 0, n = 0;
            for (let i = 0; i < g.pos.length; i += 3) {
                const m = fit.matrix, x = g.pos[i], y = g.pos[i + 1], z = g.pos[i + 2];
                const X = m[0] * x + m[4] * y + m[8] * z + m[12], Y = m[1] * x + m[5] * y + m[9] * z + m[13], Z = m[2] * x + m[6] * y + m[10] * z + m[14];
                tops.push(Y);
                if (Y > 3) { n++; if (L_CELLS.has(`${Math.floor(X)},${Math.floor(Z)}`)) inside++; }
            }
            expect(Math.min(...tops)).toBeCloseTo(2, 1);
            expect(inside / n).toBeGreaterThan(0.85);
        });
    }

    it('applies the fit as one root node and keeps the mesh bytes; the clay twin has the same positions and no materials', () => {
        const g = generatedL(37, false), glb = texturedGlb(g.pos, g.idx);
        const fit = registerToFootprint(g.pos, { cells: L_CELLS, groundY: 0, heightM: 24 });
        const fitted = applyRootTransform(glb, fit.matrix), clay = stripMaterials(fitted);
        const a = parseGlbBytes(glb), b = parseGlbBytes(fitted), c = parseGlbBytes(clay);
        expect(b.json.scenes[0].nodes).toEqual([1]);
        expect(b.json.nodes[1]).toMatchObject({ name: 'pipeline_i_fit', matrix: fit.matrix, children: [0] });
        expect(Buffer.from(readPositionsExact(b, 0).buffer)).toEqual(Buffer.from(readPositionsExact(a, 0).buffer));
        expect(Buffer.from(readPositionsExact(c, 0).buffer)).toEqual(Buffer.from(readPositionsExact(b, 0).buffer));
        expect(c.json.materials).toBeUndefined(); expect(c.json.images).toBeUndefined();
        expect(c.json.meshes[0].primitives[0].material).toBeUndefined();
        expect(c.json.nodes.map((x: any) => x.name)).toEqual(b.json.nodes.map((x: any) => x.name));
        // world positions through the new root are the fitted ones
        const w = nodeWorldMatrices(b.json)[0];
        const p = transformPoint(w, g.pos[0], g.pos[1], g.pos[2]), m = fit.matrix;
        expect(p[0]).toBeCloseTo(m[0] * g.pos[0] + m[4] * g.pos[1] + m[8] * g.pos[2] + m[12], 4);
    });

    it('recovers coverage when the model\'s footprint-to-height proportion is far off (Empire State Building, 2026-10-25: a +-10% scale search around the height-derived scale alone left a slimmer-than-real Trellis model stuck at 16% footprint coverage)', () => {
        // the same L, but generated at half the plan size its height implies: a +-10% scale search around the
        // height-derived scale could never reach it, since the true horizontal scale is ~2x that guess
        const yawDeg = 37, k = 1 / 25;
        const local = boxesSurface([...L_BOXES.map(b => ({ min: [b.min[0] - 20, 0, b.min[2] - 6] as V3, max: [b.max[0] - 20, 24, b.max[2] - 6] as V3 })), { min: [-14, -1, -15], max: [14, 0, 15] }]);
        const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const pos: number[] = [];
        for (let i = 0; i < local.pos.length; i += 3) {
            const x = local.pos[i] * 0.5, y = local.pos[i + 1], z = local.pos[i + 2] * 0.5; // plan halved, height untouched
            pos.push(k * (c * x + s * z), k * y, k * (-s * x + c * z));
        }
        const fit = registerToFootprint(pos, { cells: L_CELLS, groundY: 0, heightM: 24 });
        expect(fit.coverage).toBeGreaterThan(0.8);
        expect(fit.planIoU).toBeGreaterThan(0.8);
        expect(fit.heightRatio).toBeCloseTo(1, 1);
    });
});

describe('pipeline I: the four sheet stations', () => {
    it('faces the two adjacent scanned walls (not an unscanned party wall), their corner and an aerial, framing the whole structure', () => {
        // a 20 x 30 x 12 m block whose +x wall the scan never saw (removed)
        const box = boxesSurface([{ min: [-10, 0, -6], max: [10, 30, 6] }], 1);
        const keep: number[] = [];
        for (let t = 0; t < box.idx.length; t += 3) {
            const xs = [0, 1, 2].map(k => box.pos[box.idx[t + k] * 3]);
            if (!xs.every(x => Math.abs(x - 10) < 1e-6)) keep.push(box.idx[t], box.idx[t + 1], box.idx[t + 2]);
        }
        const plan = planSheetStations({ vertices: box.pos, indices: keep }, 0, ANCHOR);
        expect(plan.stations.map(s => s.id)).toEqual([1, 2, 3, 4]);
        const faceDirs = plan.stations.slice(0, 2).map(s => [Math.round(-s.forwardVector[0]), Math.round(-s.forwardVector[2])]);
        expect(faceDirs).not.toContainEqual([1, 0]);          // nobody looks at the wall the scan never saw
        expect(plan.heightM).toBeGreaterThan(29);
        for (const s of plan.stations.slice(0, 3)) expect(Math.abs(s.pitchDegrees)).toBeLessThan(1);
        expect(plan.stations[3].pitchDegrees).toBeLessThan(-20);
        // far enough out: the 30 m height fits the 24 mm lens's vertical field with the margin
        const vHalf = Math.atan(Math.tan(Math.atan(18 / 24)) / (16 / 9));
        const d = Math.hypot(plan.stations[0].positionLocalENU[0] - 0, plan.stations[0].positionLocalENU[2] - 0);
        expect(Math.tan(vHalf) * (d - 10)).toBeGreaterThan(15);
    });
});

describe('pipeline I: the Fal Trellis client', () => {
    const fakeFal = (opts: { failStatus?: boolean; notGlb?: boolean; neverDone?: boolean } = {}) => {
        const calls: Array<{ url: string; body?: any }> = [];
        const polls = new Map<string, number>();
        let jobs = 0;
        const fetch = async (url: string, init?: any) => {
            calls.push({ url, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
            const json = (v: any, ok = true, status = 200) => ({ ok, status, json: async () => v, arrayBuffer: async () => new ArrayBuffer(0) });
            if (url.endsWith('/storage/upload/initiate')) return json({ upload_url: `https://up/${calls.length}`, file_url: `https://cdn/view_${calls.length}.png` });
            if (url.startsWith('https://up/')) return json({});
            if (url === `https://queue.fal.run/${TRELLIS_MODEL}`) { const j = ++jobs; return json({ request_id: `req${j}`, status_url: `https://q/status/${j}`, response_url: `https://q/response/${j}` }); }
            if (url.startsWith('https://q/status/')) { const n = (polls.get(url) ?? 0) + 1; polls.set(url, n); return json({ status: !opts.neverDone && n >= 2 ? 'COMPLETED' : 'IN_PROGRESS' }); }
            if (url.startsWith('https://q/response/')) return opts.failStatus ? json({ detail: 'bad' }, false, 422) : json({ model_mesh: { url: 'https://cdn/model.glb' } });
            if (url === 'https://cdn/model.glb') { const b = opts.notGlb ? Buffer.from('<html>') : texturedGlb([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]); return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }
            throw new Error(`unexpected ${url}`);
        };
        return { calls, fetch };
    };
    const png = encodePng(2, 2, Buffer.alloc(16, 255));

    it('sends the views with the tested settings and the seed, uploads them once for every seed, and returns each GLB', async () => {
        const f = fakeFal();
        const c = createFalTrellisClient({ falKey: 'k', fetch: f.fetch, sleep: async () => {} });
        const views = [png, png, png, png];
        const [a, b] = await Promise.all([c.generate(views, { timeoutMs: 60_000, seed: 7 }), c.generate(views, { timeoutMs: 60_000, seed: 11 })]);
        expect([a.seed, b.seed]).toEqual([7, 11]);
        expect(a.glb.readUInt32LE(0)).toBe(0x46546c67);
        expect(f.calls.filter(x => x.url.endsWith('/storage/upload/initiate'))).toHaveLength(4);
        const submits = f.calls.filter(x => x.url.includes('queue.fal.run'));
        expect(submits.map(x => x.body.seed).sort((p, q) => p - q)).toEqual([7, 11]);
        expect(submits[0].body.image_urls).toHaveLength(4);
        // fal rejects texture_size as a string: it must go as a number
        expect(submits[0].body).toMatchObject({ multiimage_algo: 'multidiffusion', ss_sampling_steps: 25, slat_sampling_steps: 25, texture_size: 2048 });
        expect(typeof submits[0].body.texture_size).toBe('number');
    });

    it('fails with the reason: no key, a failed job, a non-GLB answer, a job past its time', async () => {
        expect(() => createFalTrellisClient({ falKey: '', fetch: fakeFal().fetch })).toThrow(/FAL_KEY/);
        await expect(createFalTrellisClient({ falKey: 'k', fetch: fakeFal({ failStatus: true }).fetch, sleep: async () => {} }).generate([png], { timeoutMs: 60_000 })).rejects.toThrow(/HTTP 422/);
        await expect(createFalTrellisClient({ falKey: 'k', fetch: fakeFal({ notGlb: true }).fetch, sleep: async () => {} }).generate([png], { timeoutMs: 60_000 })).rejects.toThrow(/not a binary glTF/);
        const slow = createFalTrellisClient({ falKey: 'k', fetch: fakeFal({ neverDone: true }).fetch, sleep: async () => {} });
        const realNow = Date.now; let fake = realNow();
        Date.now = () => (fake += 30_000);
        try { await expect(slow.generate([png], { timeoutMs: 60_000 })).rejects.toThrow(/did not finish/); } finally { Date.now = realNow; }
    });

    it('reads FAL_KEY from the environment first, else a secrets.json', () => {
        const f = path.join(WORK, 'secrets.json'); fs.writeFileSync(f, JSON.stringify({ FAL_KEY: 'from-file' }));
        expect(resolveFalKey({ FAL_KEY: 'from-env' }, [f])).toBe('from-env');
        expect(resolveFalKey({}, [f])).toBe('from-file');
        expect(resolveFalKey({}, [path.join(WORK, 'none.json')])).toBeUndefined();
    });
});

describe('pipeline I: the colour swatch', () => {
    it('measures the structure on white, and moves a model\'s texture onto it without touching the mesh', () => {
        const brick = (w: number, h: number, rgb: number[]) => { const b = Buffer.alloc(w * h * 4, 255); for (let i = 0; i < w * h; i++) if (i % w > w / 4 && i % w < (3 * w) / 4) { b[4 * i] = rgb[0] + (i % 7); b[4 * i + 1] = rgb[1]; b[4 * i + 2] = rgb[2] + (i % 5); } return encodePng(w, h, b); };
        const sw = measureSwatch([brick(64, 64, [150, 60, 55]), brick(64, 64, [140, 55, 50])]);
        const red = rgbToLab(145, 57, 55);
        expect(sw.mean[0]).toBeCloseTo(red[0], -0.5); expect(sw.mean[1]).toBeGreaterThan(25);
        // a model whose texture is orange-brown
        const g = boxesSurface([{ min: [0, 0, 0], max: [1, 1, 1] }], 0.5), glb = texturedGlb(g.pos, g.idx);
        const out = colourMatchGlb(glb, sw);
        const json = parseGlbBytes(out.glb).json;
        const img = json.images[0], bv = json.bufferViews[img.bufferView], bin = parseGlbBytes(out.glb).bin;
        const px = decodeImageToRgbaSync(Buffer.from(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength));
        const lab = rgbToLab(px.rgba[0], px.rgba[1], px.rgba[2]);
        expect(Math.abs(lab[0] - sw.mean[0])).toBeLessThan(Math.abs(out.before[0].mean[0] - sw.mean[0]) + 1e-6);
        expect(Buffer.from(readPositionsExact(parseGlbBytes(out.glb), 0).buffer)).toEqual(Buffer.from(readPositionsExact(parseGlbBytes(glb), 0).buffer));
    });
});

/** The isolated scan as a stand-in: a dense 10 x 20 x 10 m block on its street apron (4 m round it, as an isolate keeps), textured. */
function scanGlb(): Buffer {
    const g = boxesSurface([{ min: [-5, 0, -5], max: [5, 20, 5] }, { min: [-9, -0.2, -9], max: [9, 0, 9] }], 1);
    return texturedGlb(g.pos, g.idx);
}

/** A stand-in Trellis: the block, rotated, at its own scale; seed 11 hands back the wrong shape (a thin slab), seed 23 fails. */
function fakeTrellis(sent: Array<{ images: Buffer[]; seed?: number }>): ModelClient {
    return {
        model: TRELLIS_MODEL,
        async generate(images, { seed }) {
            sent.push({ images, seed });
            if (seed === 23) throw new Error('fal: job failed');
            const box = seed === 11 ? { min: [-12, 0, -1] as V3, max: [12, 20, 1] as V3 } : { min: [-5, 0, -5] as V3, max: [5, 20, 5] as V3 };
            const g = boxesSurface([box, { min: [-9, -0.5, -9], max: [9, 0, 9] }], 0.5);
            const a = 30 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), pos: number[] = [];
            for (let i = 0; i < g.pos.length; i += 3) pos.push((c * g.pos[i] + s * g.pos[i + 2]) / 20, g.pos[i + 1] / 20, (-s * g.pos[i] + c * g.pos[i + 2]) / 20);
            return { glb: texturedGlb(pos, g.idx), requestId: `req-${seed}`, seconds: 1, model: TRELLIS_MODEL, seed };
        }
    };
}

describe('pipeline I end to end (stand-in image model and Trellis)', () => {
    it('plans, draws and checks the sheet, runs every seed, keeps the one that fits the sheet and the scan, colour-matches and places it', async () => {
        const scan = path.join(WORK, 'scan.glb');
        fs.writeFileSync(scan, scanGlb());
        const cells = new Set<string>(); for (let x = -5; x < 5; x++) for (let z = -5; z < 5; z++) cells.add(`${x},${z}`);
        // the image model hands the reference sheet back (a sheet that holds to the scan exactly)
        const generator: StationImageGenerator = { name: 'sheet-echo', async generate(args) { expect(args.imageSize).toBe('4K'); return { png: args.blockoutPng, modelUsed: 'gemini-3.1-flash-image' }; } };
        const sent: Array<{ images: Buffer[]; seed?: number }> = [];
        const out = await runPipelineI({ texturedGlb: scan, clayGlb: scan, footprint: { cells, groundY: 0, heightM: 20 }, anchor: ANCHOR, place: 'Test Box', dir: path.join(WORK, 'run'), generator, model: fakeTrellis(sent), seeds: [7, 11, 23], budgetMs: 600_000, panelWidth: 320, renderMode: 'clay' });
        expect(sent.map(x => x.seed).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([7, 11, 23]);
        for (const { images } of sent) {
            expect(images).toHaveLength(4);
            const d = decodePng(images[0]);
            expect([d.width, d.height]).toEqual([MODEL_VIEW_PX, MODEL_VIEW_PX]);
            expect(Array.from(d.rgba.subarray(0, 3))).toEqual([255, 255, 255]);      // white ground around the structure
        }
        // the slab (seed 11) loses to the block (seed 7) on silhouette and plan; the failed seed is reported, not fatal
        expect(out.model.seed).toBe(7);
        const by = Object.fromEntries(out.candidates.map(c => [c.seed, c]));
        expect(by[7].score!.score).toBeGreaterThan(by[11].score!.score);
        expect(by[7].score!.meanSilhouetteIoU).toBeGreaterThan(0.5);
        expect(by[23].error).toMatch(/job failed/);
        expect(out.fit.planIoU).toBeGreaterThan(0.75);
        expect(out.fit.heightRatio).toBeGreaterThan(0.85);
        expect(out.swatch.before).toHaveLength(1);
        expect(out.steps.map(s => s.step)).toEqual(['stations', 'character sheet', 'model', 'colour and fit']);
        for (const f of [out.files.texturedGlb, out.files.clayGlb, out.files.modelGlb, out.files.sheetPng, out.files.sheetReferencePng]) expect(await fs.pathExists(f)).toBe(true);
        // the committed GLB stands on the scan: its fitted plan lies on the footprint
        const mesh = sceneToRenderMesh(readGlbScene(out.files.clayGlb));
        let inside = 0, n = 0;
        for (let i = 0; i < mesh.vertices.length; i += 3) if (mesh.vertices[i + 1] > 2) { n++; if (cells.has(`${Math.floor(mesh.vertices[i])},${Math.floor(mesh.vertices[i + 2])}`)) inside++; }
        expect(inside / n).toBeGreaterThan(0.8);
    });

    it('fails with every seed\'s reason when no model comes back', async () => {
        const scan = path.join(WORK, 'scan3.glb'); fs.writeFileSync(scan, scanGlb());
        const cells = new Set<string>(); for (let x = -5; x < 5; x++) for (let z = -5; z < 5; z++) cells.add(`${x},${z}`);
        const generator: StationImageGenerator = { name: 'sheet-echo', async generate(args) { return args.blockoutPng; } };
        await expect(runPipelineI({ texturedGlb: scan, clayGlb: scan, footprint: { cells, groundY: 0, heightM: 20 }, anchor: ANCHOR, place: 'Test Box', dir: path.join(WORK, 'run3'), generator, model: fakeTrellis([]), seeds: [23], budgetMs: 600_000, panelWidth: 320, renderMode: 'clay' })).rejects.toThrow(/no fal-ai\/trellis\/multi model came back: seed 23: fal: job failed/);
    });

    it('stops before the model when the sheet does not hold to the scan', async () => {
        const scan = path.join(WORK, 'scan2.glb');
        fs.writeFileSync(scan, scanGlb());
        const cells = new Set<string>(); for (let x = -5; x < 5; x++) for (let z = -5; z < 5; z++) cells.add(`${x},${z}`);
        // an image model that paints the whole sheet one flat colour: nothing of the scan survives
        const generator: StationImageGenerator = { name: 'flat', async generate(args) { return encodePng(args.width, args.height, Buffer.alloc(args.width * args.height * 4, 90)); } };
        const sent: Array<{ images: Buffer[]; seed?: number }> = [];
        await expect(runPipelineI({ texturedGlb: scan, clayGlb: scan, footprint: { cells, groundY: 0, heightM: 20 }, anchor: ANCHOR, place: 'Test Box', dir: path.join(WORK, 'run2'), generator, model: fakeTrellis(sent), budgetMs: 600_000, panelWidth: 320, renderMode: 'clay' })).rejects.toThrow(/did not hold to the scan/);
        expect(sent).toHaveLength(0);
    });
});
