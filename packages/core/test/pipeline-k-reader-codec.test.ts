/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader on the twin with its PNG work on the codec threads (png-codec-pool.ts) and with it all on the calling
 * thread (SCRATCHBOX_PNG_WORKERS=0: encodePng and decodePng inline, as the reader ran before): the same files, byte for
 * byte, and the same images shown to the model. The case takes every path the switch touched: the harmonised facade
 * textures and the flat scan's photos swapped and encoded (twin-reader.ts), the other planes photographed (plane-orthos.ts),
 * the brief's contact sheet, the photos and their uncovered and occlusion masks decoded, the overview and cell crops,
 * the judges' side-by-sides and a family drawn from its lead's window (facade-reader.ts); every image large enough to
 * go to a codec thread. Then the crops (regionRgba) against the per-texel loop they were drawn with before, kept here.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { encodeRgbaToJpeg } from '../src/node/image-codec-ffmpeg';
import { closePngCodecPool, INLINE_MAX_BYTES } from '../src/node/png-codec-pool';
import { readOnTwin } from '../src/node/3d-engine/staged-location/pipeline-k/twin-reader';
import { regionRgba, type FacadeAsk, type FacadePhoto, type ImageRegion } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { packGlb, quad } from './helpers/synthetic-material-scan';

const PIXEL = 0.1, FW = 300, FH = 600;
const COLS_M = [1.8, 7.4, 13, 18.6, 24.2], WIN_W_M = 1.2, PITCH_M = 4, PHASE_M = 0.9, WIN_H_M = 2.2;

/** A wall photo with seeded noise (so its PNG is large): window columns each lit their own way, every storey. */
function wall(W: number, H: number, wallV: number, winV: number, seed: number, windows = true): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    let r = seed >>> 0;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = x * PIXEL, ym = y * PIXEL, ci = COLS_M.findIndex(c => xm >= c && xm < c + WIN_W_M);
        const k = Math.floor((ym - PHASE_M) / PITCH_M), inWin = windows && ci >= 0 && ym - PHASE_M - k * PITCH_M >= 0 && ym - PHASE_M - k * PITCH_M < WIN_H_M;
        const v = (inWin ? winV - ((k + ci) % 3) * 10 : wallV) + Math.round((rnd() - 0.5) * 30);
        const p = (y * W + x) * 4;
        rgba[p] = Math.max(0, Math.min(255, v)); rgba[p + 1] = Math.max(0, Math.min(255, v - 5)); rgba[p + 2] = Math.max(0, Math.min(255, v - 11)); rgba[p + 3] = 255;
    }
    return rgba;
}

const frame = (id: number, image: string, x0: number) => ({ facadeId: id, image, width: FW, height: FH, pixel: PIXEL, texel: PIXEL, coverage: 0.95, centroid: [x0 + FW * PIXEL / 2, FH * PIXEL / 2, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -FW * PIXEL / 2, orthoTMax: FH * PIXEL / 2, sMin: -FW * PIXEL / 2, sMax: FW * PIXEL / 2, tMin: -FH * PIXEL / 2, tMax: FH * PIXEL / 2 });

/**
 * K's orthos (three walls of one family: the first with an uncovered band, the second with an occlusion mask, the third
 * with no rebuilt texture), tile_refine's flat scan (a roof, a terrace and a side wall no facade covers, their photos
 * 160 px JPEGs), and the twin: the scan's photos harmonised at indices 0-2, the first two walls' rebuilt textures at 10, 11.
 */
async function twinCase(dir: string) {
    const orthos = path.join(dir, 'relief_orthos_k_x');
    fs.mkdirSync(orthos);
    const facades = [];
    for (const [i, id] of [7, 8, 9].entries()) {
        fs.writeFileSync(path.join(orthos, `facade_${id}.png`), encodePng(FW, FH, wall(FW, FH, 190 - i * 8, 80 + i * 6, 11 + i), 4));
        facades.push(frame(id, `facade_${id}.png`, i * 40));
    }
    // facade 7's photo never reached its top 40 rows; something stood in front of facade 8's right third
    const unc = new Uint8Array(FW * FH);
    unc.fill(255, 0, FW * 40);
    fs.writeFileSync(path.join(orthos, 'facade_7_uncovered.png'), encodePng(FW, FH, unc, 1));
    const occ = new Uint8Array(FW * FH);
    for (let y = 0; y < FH; y++) for (let x = 200; x < FW; x++) occ[y * FW + x] = 210;
    fs.writeFileSync(path.join(orthos, 'facade_8_occluded.png'), encodePng(FW, FH, occ, 1));
    Object.assign(facades[0], { uncoveredMask: 'facade_7_uncovered.png' });
    Object.assign(facades[1], { occludedMask: 'facade_8_occluded.png' });
    fs.writeFileSync(path.join(orthos, 'facades.json'), JSON.stringify({ facades }));
    const T = 160, jpeg = (rgba: Uint8Array) => encodeRgbaToJpeg(rgba, T, T, { quality: 95, chroma: '444' });
    const flat = path.join(dir, 'textured.glb');
    fs.writeFileSync(flat, packGlb([
        { ...quad([0, 30, 0], [16, 30, 0], [16, 30, -16], [0, 30, -16]), image: await jpeg(wall(T, T, 120, 60, 21, false)) },
        { ...quad([20, 12, 0], [36, 12, 0], [36, 12, -16], [20, 12, -16]), image: await jpeg(wall(T, T, 140, 70, 22, false)) },
        { ...quad([-2, 0, -16], [-2, 0, 0], [-2, 16, 0], [-2, 16, -16]), image: await jpeg(wall(T, T, 170, 90, 23)) }
    ]));
    const finalImage = new Map([0, 1, 2].map(i => [i, { width: T, height: T, rgba: wall(T, T, 100 + i * 20, 50, 31 + i, i === 2) }]));
    finalImage.set(10, { width: FW, height: FH, rgba: wall(FW, FH, 160, 60, 41) });
    finalImage.set(11, { width: FW, height: FH, rgba: wall(FW, FH, 150, 70, 42) });
    const lattice = (id: number, image: number) => ({ node: { mesh: image - 10, extras: { sbFacadeLattice: { facadeId: id } } }, mesh: { primitives: [{ material: image - 10 }] }, material: { pbrMetallicRoughness: { baseColorTexture: { index: image - 10 } } }, texture: { source: image } });
    const ls = [lattice(7, 10), lattice(8, 11)];
    const twinJson = { nodes: ls.map(l => l.node), meshes: ls.map(l => l.mesh), materials: ls.map(l => l.material), textures: ls.map(l => l.texture), images: [] };
    return { orthos, flat, twinJson, finalImage };
}

/** A stand-in model: one family of the three walls; each crop's windows where they are; every judge accepts. Every image it is shown, kept. */
function standIn() {
    const shown: string[] = [];
    const ask: FacadeAsk = async (png, _prompt, kind, region, regions) => {
        const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
        shown.push(JSON.stringify([kind, region, regions ?? null, (Array.isArray(png) ? png : [png]).map(hash)]));
        if (kind === 'brief') return JSON.stringify({ building: 'A stand-in office block', families: [{ name: 'office floors', cells: ['r1c1', 'r1c2', 'r1c3'], openings: 'single windows' }], conf: 80 });
        if (kind === 'judge') return JSON.stringify({ accept: true, badColumns: [], conf: 80 });
        if (kind === 'overview') return JSON.stringify({ zones: [{ box: [0, 0, 1000, 500], openings: true, label: 'upper' }, { box: [0, 500, 1000, 1000], openings: true, label: 'lower' }], conf: 90 });
        const one = (r: typeof region) => {
            const ch = r.y1 - r.y0, cw = r.x1 - r.x0, rows = [];
            for (let k = 0; k < 20; k++) {
                const t = (PHASE_M + k * PITCH_M) / PIXEL, b = t + WIN_H_M / PIXEL;
                const openings = COLS_M.filter(c => c / PIXEL >= r.x0 && (c + WIN_W_M) / PIXEL <= r.x1).map(c => ({ x: [((c / PIXEL - r.x0) / cw) * 1000, ((c / PIXEL + WIN_W_M / PIXEL - r.x0) / cw) * 1000], panes: 2 }));
                if (t < r.y0 || b > r.y1 || !openings.length) continue;
                rows.push({ y: [((t - r.y0) / ch) * 1000, ((b - r.y0) / ch) * 1000], openings });
            }
            return { rows, conf: 80 };
        };
        if (kind === 'reads') return JSON.stringify({ zones: (regions ?? [region]).map(one) });
        if (kind === 'judges') return JSON.stringify({ zones: (regions ?? [region]).map(() => ({ accept: true, badColumns: [], conf: 80 })) });
        return JSON.stringify(one(region));
    };
    return { ask, shown };
}

/** Every file under `dir` by its path relative to it, the run times zeroed in the JSON records. */
function snapshot(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (d: string) => {
        for (const name of fs.readdirSync(d).sort()) {
            const p = path.join(d, name), rel = path.relative(dir, p);
            if (fs.statSync(p).isDirectory()) { walk(p); continue; }
            if (name.endsWith('.json')) {
                const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                if ('ms' in j) j.ms = 0;
                for (const f of j.facades ?? []) if ('ms' in f) f.ms = 0;
                out.set(rel, JSON.stringify(j));
            } else out.set(rel, fs.readFileSync(p).toString('base64'));
        }
    };
    walk(dir);
    return out;
}

/** regionRgba as it was: every output texel's source found on its own. */
function regionRgbaBefore(img: FacadePhoto, r: ImageRegion, scale: number, outlines: Array<[number, number, number, number]>, L?: Float32Array): Uint8Array {
    const W = img.width, ow = Math.max(1, Math.round((r.x1 - r.x0) * scale)), oh = Math.max(1, Math.round((r.y1 - r.y0) * scale));
    const out = new Uint8Array(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const sx = Math.min(W - 1, r.x0 + Math.floor(x / scale)), sy = Math.min(img.height - 1, r.y0 + Math.floor(y / scale)), p = (sy * W + sx) * 4, q = (y * ow + x) * 4;
        if (L && !Number.isFinite(L[sy * W + sx])) { out[q] = out[q + 1] = out[q + 2] = 128; out[q + 3] = 255; continue; }
        out[q] = img.rgba[p]; out[q + 1] = img.rgba[p + 1]; out[q + 2] = img.rgba[p + 2]; out[q + 3] = 255;
    }
    const lw = Math.max(1, Math.round(scale / 2));
    for (const [x0, y0, x1, y1] of outlines) {
        const X0 = Math.round((x0 - r.x0) * scale), X1 = Math.round((x1 - r.x0) * scale) - 1, Y0 = Math.round((y0 - r.y0) * scale), Y1 = Math.round((y1 - r.y0) * scale) - 1;
        if (Y1 < 0 || Y0 >= oh || X1 < 0 || X0 >= ow) continue;
        for (let y = Math.max(0, Y0); y <= Math.min(oh - 1, Y1); y++) for (let x = Math.max(0, X0); x <= Math.min(ow - 1, X1); x++) {
            if (x - X0 >= lw && X1 - x >= lw && y - Y0 >= lw && Y1 - y >= lw) continue;
            out.set([255, 0, 255, 255], (y * ow + x) * 4);
        }
    }
    return out;
}

afterAll(async () => { await closePngCodecPool(); });

describe('the facade reader on the codec threads', () => {
    it('writes the same files and shows the model the same images as with every PNG coded inline', async () => {
        const runs: Array<{ files: Map<string, string>; shown: string[]; planes: string; report: object }> = [];
        const before = process.env.SCRATCHBOX_PNG_WORKERS;
        try {
            for (const workers of ['0', '3']) {
                process.env.SCRATCHBOX_PNG_WORKERS = workers;
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-codec-'));
                try {
                    const c = await twinCase(dir);
                    const { ask, shown } = standIn();
                    const r = await readOnTwin({ orthosDir: c.orthos, flatGlb: c.flat, twinJson: c.twinJson, finalImage: c.finalImage, ask });
                    const { dir: readDir, ...report } = r.report;
                    runs.push({ files: snapshot(readDir), shown: shown.sort(), planes: JSON.stringify(r.records.readings), report });
                } finally { fs.rmSync(dir, { recursive: true, force: true }); }
            }
        } finally {
            if (before === undefined) delete process.env.SCRATCHBOX_PNG_WORKERS; else process.env.SCRATCHBOX_PNG_WORKERS = before;
        }
        const [inline, pooled] = runs;
        expect([...pooled.files.keys()]).toEqual([...inline.files.keys()]);
        for (const [name, bytes] of inline.files) expect(pooled.files.get(name) === bytes, name).toBe(true);
        expect(pooled.shown).toEqual(inline.shown);
        expect(pooled.planes).toBe(inline.planes);
        expect(pooled.report).toEqual(inline.report);
        // every path ran: both textures and all three scan photos swapped, the scan's three planes photographed, the brief
        // read, a family member drawn from its lead's window, the occluded third greyed; the images large enough for a thread
        expect(inline.report).toEqual({ facadesHarmonised: 2, facadesAsPhotographed: 1, photosHarmonised: 3, planes: 3 });
        const rec = JSON.parse(inline.files.get('facade_reader.json')!);
        expect(rec.brief.families[0].planes).toEqual([7, 8, 9]);
        expect(rec.facades.map((f: { outcome: string }) => f.outcome)).toEqual(Array(6).fill('replaced'));
        expect(rec.facades.filter((f: { zones?: Array<{ template?: unknown }> }) => f.zones?.some(z => z.template)).map((f: { facadeId: number }) => f.facadeId)).toEqual([8, 9]);
        expect(inline.files.has(path.join('facade_reader', 'brief_sheet.png'))).toBe(true);
        expect(inline.shown.map(s => JSON.parse(s)[0])).toEqual(expect.arrayContaining(['brief', 'overview', 'reads', 'judges', 'judge']));
        for (const name of ['facade_7.png', 'facade_8.png', 'facade_9.png']) expect(Buffer.from(inline.files.get(name)!, 'base64').length, name).toBeGreaterThan(INLINE_MAX_BYTES);
        for (const p of JSON.parse(inline.files.get('planes.json')!).planes) expect(p.width * p.height * 4, p.image).toBeGreaterThan(INLINE_MAX_BYTES);
    }, 120_000);

    it('draws the crops as the per-texel loop did: regions, scales, uncovered texels and outlines', () => {
        let seed = 5;
        const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
        const W = 230, H = 170, img = { rgba: wall(W, H, 180, 70, 3), width: W, height: H };
        const L = new Float32Array(W * H).map(() => (rnd() < 0.1 ? NaN : rnd()));
        let compared = 0;
        for (const scale of [0.37, 0.5, 1, 1.6, 2.5, 4]) for (let k = 0; k < 6; k++) {
            const x0 = Math.floor(rnd() * W * 0.6), y0 = Math.floor(rnd() * H * 0.6);
            // a region running past the photo's edge as well (its texels clamped)
            const r = { x0, y0, x1: Math.min(W + 6, x0 + 4 + Math.floor(rnd() * (W - x0))), y1: Math.min(H + 6, y0 + 4 + Math.floor(rnd() * (H - y0))) };
            const outlines = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => { const a = rnd() * W, b = rnd() * H; return [a - 10, b - 10, a + rnd() * 40, b + rnd() * 30] as [number, number, number, number]; });
            for (const lum of [undefined, L]) {
                const now = regionRgba(img, r, scale, outlines, lum), before = regionRgbaBefore(img, r, scale, outlines, lum);
                expect(Buffer.from(now.rgba).equals(Buffer.from(before)), JSON.stringify({ r, scale })).toBe(true);
                compared += before.length;
            }
        }
        expect(compared).toBeGreaterThan(1_000_000);
    });
});
