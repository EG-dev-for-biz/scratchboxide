/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader's native window search (pipeline-k/native/template-match-native.ts over scratchbox_template_match.hpp)
 * against the TypeScript it translates (pipeline-k/facade-reader-template.ts matchExemplar), on synthetic planes: windows
 * each lit their own way, noise, texels the photo never reached, faint windows the grid fills, exemplars read at the
 * plane's pixel and at others (so both resamples run both ways), a blank wall and an exemplar larger than its plane.
 * Parity is exact: every match, every rectangle and correlation bit for bit, in the same order, whatever the threads.
 * Then readPlanes with the port and without it: the same records, readings and review images. Then the two timed.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { luminanceOf, readPlanes, type FacadeAsk, type FacadePhoto } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { exemplarOf, matchExemplar, type LumGrid, type TemplateMatch, type WindowExemplar } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader-template';
import { matchExemplarsNative } from '../src/node/3d-engine/staged-location/pipeline-k/native/template-match-native';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

interface PlaneSpec {
    W: number; H: number; pixel: number;
    /** Window columns' left edges and width, storey pitch, phase and window height (m). */
    colsM: number[]; winWM: number; pitchM: number; phaseM: number; winHM: number;
    wall: number; win: number; seed: number;
    /** Boxes the photo never reached (px). */
    holes?: Array<[number, number, number, number]>;
    /** Windows (column index, storey index) drawn faint: half their contrast. */
    faint?: Array<[number, number]>;
}

/** A plane photo: windows each lit their own way (some darker than the wall, some lighter), noise; deterministic. */
function plane(s: PlaneSpec): { img: FacadePhoto; uncovered: Uint8Array } {
    const { W, H, pixel } = s, rgba = new Uint8Array(W * H * 4), uncovered = new Uint8Array(W * H);
    let r = s.seed >>> 0;
    const rnd = () => ((r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = x * pixel, ym = y * pixel, ci = s.colsM.findIndex(c => xm >= c && xm < c + s.winWM);
        const k = Math.floor((ym - s.phaseM) / s.pitchM), inWin = ci >= 0 && ym - s.phaseM - k * s.pitchM < s.winHM;
        let v = s.wall;
        if (inWin) {
            const lit = (k * 7 + ci * 3) % 5 === 0 ? s.win + 40 : s.win - ((k + ci) % 3) * 10;
            v = s.faint?.some(([c, kk]) => c === ci && kk === k) ? Math.round((lit + s.wall) / 2) : lit;
        }
        v += Math.round((rnd() - 0.5) * 24);
        const p = (y * W + x) * 4;
        rgba[p] = Math.max(0, Math.min(255, v)); rgba[p + 1] = Math.max(0, Math.min(255, v - 4)); rgba[p + 2] = Math.max(0, Math.min(255, v - 9)); rgba[p + 3] = 255;
    }
    for (const [x0, y0, x1, y1] of s.holes ?? []) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) uncovered[y * W + x] = 1;
    return { img: { rgba, width: W, height: H }, uncovered };
}

const gridOf = (s: PlaneSpec): LumGrid => { const { img, uncovered } = plane(s); return { L: luminanceOf(img, uncovered), W: s.W, H: s.H, pixel: s.pixel }; };

const BASE: Omit<PlaneSpec, 'W' | 'H' | 'pixel' | 'seed'> = { colsM: [1.6, 3.0, 7.2, 8.6, 12.8, 14.2, 18.4, 19.8], winWM: 1.0, pitchM: 3.84, phaseM: 0.9, winHM: 2.1, wall: 185, win: 75 };

/** An exemplar around window (column ci, storey k) of the plane s. */
function exemplarAt(s: PlaneSpec, ci: number, k: number, fromPlane: number): WindowExemplar {
    const g = gridOf(s), x0 = BASE.colsM[ci] / s.pixel, y0 = (BASE.phaseM + k * BASE.pitchM) / s.pixel;
    const ex = exemplarOf(g, [x0, y0, x0 + BASE.winWM / s.pixel, y0 + BASE.winHM / s.pixel], 2, fromPlane, `zone ${k}`);
    if (!ex) throw new Error('the exemplar lies off the photo');
    return ex;
}

// the doubles' bits, so -0, a last-place difference and the order all count
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const bits = (v: number) => { f64[0] = v; return u64[0].toString(16); };
const exact = (sets: TemplateMatch[][]) => sets.map(ms => ms.map(m => ({ ...m, rect: m.rect.map(bits), ncc: bits(m.ncc) })));

describe("the facade reader's native window search", () => {
    const lead: PlaneSpec = { ...BASE, W: 220, H: 400, pixel: 0.1, seed: 11 };
    // the same wall, darker, at other pixels, with holes and faint windows
    const sibling: PlaneSpec = { ...BASE, W: 220, H: 420, pixel: 0.1, seed: 29, wall: 150, win: 50, holes: [[0, 0, 220, 40], [150, 200, 220, 260], [30, 330, 60, 420]], faint: [[1, 3], [4, 5], [6, 2], [2, 7], [7, 8]] };
    const fine: PlaneSpec = { ...BASE, W: 280, H: 500, pixel: 0.08, seed: 5 };
    const coarse: PlaneSpec = { ...BASE, W: 176, H: 330, pixel: 0.125, seed: 77, holes: [[100, 100, 176, 140]] };

    it("finds every exemplar's matches exactly as matchExemplar does, grid gaps and resamples included", async () => {
        const exemplars = [exemplarAt(lead, 2, 4, 7), exemplarAt(lead, 5, 6, 7), exemplarAt(fine, 3, 3, 9), exemplarAt(coarse, 6, 2, 12)];
        let peaks = 0, grid = 0;
        for (const s of [sibling, lead, fine, coarse]) {
            const g = gridOf(s);
            const ts = exemplars.map(ex => matchExemplar(g, ex));
            const native = await matchExemplarsNative(g, exemplars);
            expect(exact(native)).toStrictEqual(exact(ts));
            // and whatever the threads
            expect(exact(await matchExemplarsNative(g, exemplars, undefined, { threads: 1 }))).toStrictEqual(exact(ts));
            for (const ms of ts) for (const m of ms) if (m.grid) grid++; else peaks++;
        }
        // not vacuous: the peaks found most of every plane's windows, and the grid filled faint ones
        expect(peaks).toBeGreaterThan(400);
        expect(grid).toBeGreaterThan(5);
    });

    it('finds nothing on a blank wall, and nothing with an exemplar larger than its plane, as matchExemplar', async () => {
        const ex = exemplarAt(lead, 2, 4, 7);
        const blank = gridOf({ ...lead, colsM: [], seed: 3 });
        expect(await matchExemplarsNative(blank, [ex])).toStrictEqual([matchExemplar(blank, ex)]);
        expect(matchExemplar(blank, ex)).toEqual([]);
        const tiny = gridOf({ ...lead, W: 12, H: 20, seed: 4 });
        expect(await matchExemplarsNative(tiny, [ex, ex])).toStrictEqual([[], []]);
        expect(await matchExemplarsNative(blank, [])).toEqual([]);
    });

    it('reads a family with the port and without it to the same records, readings and review images', async () => {
        const runs: Array<{ file: string; images: Map<string, string> }> = [];
        const before = process.env.SCRATCHBOX_K_NATIVE;
        try {
            for (const native of ['template', '0']) {
                process.env.SCRATCHBOX_K_NATIVE = native;
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-match-native-'));
                try {
                    const frame = (id: number, image: string, s: PlaneSpec) => ({ facadeId: id, image, width: s.W, height: s.H, pixel: s.pixel, coverage: 0.9, centroid: [0, s.H * s.pixel / 2, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: 0, orthoTMax: s.H * s.pixel, sMin: 0, sMax: s.W * s.pixel, tMin: -s.H * s.pixel / 2, tMax: s.H * s.pixel / 2 });
                    const facades = [];
                    for (const [id, s] of [[7, lead], [8, sibling], [9, coarse]] as Array<[number, PlaneSpec]>) {
                        const { img, uncovered } = plane(s), photo = Uint8Array.from(img.rgba as Uint8Array);
                        for (let k = 0; k < uncovered.length; k++) if (uncovered[k]) photo.set([128, 128, 128], k * 4);
                        fs.writeFileSync(path.join(dir, `f${id}.png`), encodePng(s.W, s.H, photo, 4));
                        facades.push(frame(id, `f${id}.png`, s));
                    }
                    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades }));
                    // a stand-in model: one family; each crop's windows where they are; every judge accepts
                    const ask: FacadeAsk = async (_png, _prompt, kind, region) => {
                        if (kind === 'brief') return JSON.stringify({ building: 'A stand-in office block', families: [{ name: 'office floors', cells: ['r1c1', 'r1c2', 'r1c3'], openings: 'single windows in pairs' }], conf: 80 });
                        if (kind === 'judge') return JSON.stringify({ accept: true, badColumns: [], conf: 80 });
                        if (kind === 'overview') return JSON.stringify({ zones: [{ box: [0, 0, 1000, 1000], openings: true }], conf: 90 });
                        const px = lead.pixel, ch = region.y1 - region.y0, cw = region.x1 - region.x0, rows = [];
                        for (let k = 0; k < 12; k++) {
                            const t = (BASE.phaseM + k * BASE.pitchM) / px, b = t + BASE.winHM / px;
                            if (t < region.y0 || b > region.y1) continue;
                            rows.push({ y: [((t - region.y0) / ch) * 1000, ((b - region.y0) / ch) * 1000], openings: BASE.colsM.map(c => ({ x: [((c / px - region.x0) / cw) * 1000, ((c / px + BASE.winWM / px - region.x0) / cw) * 1000], panes: 2 })) });
                        }
                        return JSON.stringify({ rows, conf: 80 });
                    };
                    await readPlanes(dir, ask);
                    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'facade_reader.json'), 'utf8'));
                    rec.ms = 0;
                    for (const f of rec.facades) f.ms = 0;
                    const images = new Map<string, string>();
                    for (const name of fs.readdirSync(path.join(dir, 'facade_reader')).sort()) images.set(name, fs.readFileSync(path.join(dir, 'facade_reader', name)).toString('base64'));
                    runs.push({ file: JSON.stringify(rec), images });
                } finally { fs.rmSync(dir, { recursive: true, force: true }); }
            }
        } finally {
            if (before === undefined) delete process.env.SCRATCHBOX_K_NATIVE; else process.env.SCRATCHBOX_K_NATIVE = before;
        }
        expect(runs[0].file).toBe(runs[1].file);
        expect([...runs[0].images.keys()]).toEqual([...runs[1].images.keys()]);
        for (const [name, b64] of runs[0].images) expect(b64 === runs[1].images.get(name), name).toBe(true);
        // the siblings were drawn from the lead's window, so the search ran
        const rec = JSON.parse(runs[0].file);
        expect(rec.facades.filter((f: { zones?: Array<{ template?: unknown }> }) => f.zones?.some(z => z.template)).length).toBe(2);
        expect([...runs[0].images.keys()].filter(n => n.endsWith('_template.png'))).toHaveLength(2);
    });

    it('is timed against the TypeScript on a tower face with four exemplars', async () => {
        const tower: PlaneSpec = { ...BASE, colsM: Array.from({ length: 30 }, (_, i) => 1.2 + i * 2.1), W: 650, H: 3000, pixel: 0.1, seed: 101, holes: [[0, 0, 650, 120], [500, 1500, 650, 1700]], faint: [[3, 10], [17, 40], [25, 60]] };
        const g = gridOf(tower);
        const exemplars = [exemplarAt(lead, 2, 4, 7), exemplarAt(lead, 5, 6, 7), exemplarAt(fine, 3, 3, 9), exemplarAt(coarse, 6, 2, 12)];
        await matchExemplarsNative(gridOf(lead), exemplars.slice(0, 1));
        let t = performance.now();
        const ts = exemplars.map(ex => matchExemplar(g, ex));
        const tsMs = performance.now() - t;
        t = performance.now();
        const native = await matchExemplarsNative(g, exemplars);
        const nativeMs = performance.now() - t;
        expect(exact(native)).toStrictEqual(exact(ts));
        expect(ts.flat().length).toBeGreaterThan(1000);
        console.log(`[template-match] tower face 650 x 3000, 4 exemplars, ${ts.flat().length} matches: TypeScript ${tsMs.toFixed(0)} ms on the event loop, native ${nativeMs.toFixed(0)} ms off it`);
    }, 120_000);
});
