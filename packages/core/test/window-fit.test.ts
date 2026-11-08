/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window fit (window-fit.ts) on a straightened facade photo whose grid is known: dark 1.2 x 2 m windows every 3 m along
 * the wall and every 4 m up it on a light wall, over a shopfront dark from wall to wall. The relief's grid is given as the
 * relief would read it (scripts/relief_band.cpp is exercised by the staged build); the readings, the gates and the evidence
 * are the module's own. The windows are found where they are drawn, and the shopfront gets none.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { completeLattice, Darkness, ensureReliefBandBinary, storeyColumn, fitFacadeWindows, panesOfUnitCell, panesUnlikeWall, fittedWindowUvs, fitWindowsForOrthos, maskWindows, nativeRelief, openingSegmenter, panesOfStrip, segmentSummary, WINDOW_FIT_PARAMS, type FitFrame, type ReliefGrid, type ReliefRunner, type SegmentOpeningMask, type WindowFitFile } from '../src/node/3d-engine/staged-location/window-fit';

const PX = 0.1, W = 300, H = 240; // a 30 x 24 m facade
const frame: FitFrame = { pixel: PX, orthoSMin: 0, orthoTMax: 24, texel: 0.05 };
const SHOP_M = 4; // the shopfront's height (m)
/** Windows: s in [0.9, 2.1) mod 3, t in [0.8, 2.8) mod 4, above the shopfront. */
const isWindow = (s: number, t: number) => t >= SHOP_M && s % 3 >= 0.9 && s % 3 < 2.1 && t % 4 >= 0.8 && t % 4 < 2.8;

function facade(shopfront: boolean): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (x + 0.5) * PX, t = 24 - (y + 0.5) * PX;
        const v = isWindow(s, t) || (shopfront && t < SHOP_M) ? 40 : 200;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { rgba, width: W, height: H };
}

/** The relief's reading of this facade on any band: bays every 3 m, storeys every 4 m, the windows its longest dark runs. */
const knownGrid: ReliefRunner = async (_hide, _span, _parity, bands) => bands.map(band => ({
    band, periodS: { found: true, pitch: 3 }, periodT: { found: true, pitch: 4 },
    cell: { foundS: true, foundT: true, runsS: [[0.9, 1.2]], runsT: [[0.8, 2.0]] }
}) as ReliefGrid);

function score(rects: Array<[number, number, number, number]>) {
    let tp = 0, fp = 0, fn = 0, shop = 0;
    const m = new Uint8Array(W * H);
    for (const [x0, y0, x1, y1] of rects) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * W + x] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (x + 0.5) * PX, t = 24 - (y + 0.5) * PX, w = isWindow(s, t), a = m[y * W + x];
        if (a && w) tp++; else if (a) fp++; else if (w) fn++;
        if (a && t < SHOP_M) shop++;
    }
    return { iou: tp / (tp + fp + fn), precision: tp / Math.max(1, tp + fp), shop };
}

describe('the window fit', () => {
    it('finds the windows where the photo draws them', async () => {
        const fit = await fitFacadeWindows(facade(false), undefined, frame, knownGrid);
        expect(fit.bands.some(b => b.accepted)).toBe(true);
        const s = score(fit.rects);
        expect(s.iou).toBeGreaterThan(0.7);
        expect(s.precision).toBeGreaterThan(0.9);
        // one window per drawn window: 10 bays x 5 storeys above the shopfront line
        expect(fit.rects.length).toBeGreaterThanOrEqual(40);
        expect(fit.rects.length).toBeLessThanOrEqual(55);
    });

    it('gives a shopfront dark from wall to wall no windows, and still finds the storeys above it', async () => {
        const fit = await fitFacadeWindows(facade(true), undefined, frame, knownGrid);
        const s = score(fit.rects);
        expect(s.shop).toBe(0);
        expect(s.iou).toBeGreaterThan(0.6);
        expect(s.precision).toBeGreaterThan(0.9);
    });

    it("counts the segmenter's tries on the no-pattern tail by outcome, failures with their messages", () => {
        const empty = { width: 10, height: 10, rects: [], bands: [], ms: 0 };
        const file: WindowFitFile = { version: 'test', params: {} as never, segment: 'segment-try/2', ms: 0, facades: [
            { facadeId: 0, width: 10, height: 10, rects: [[1, 1, 3, 3]], bands: [], ms: 0 },
            { facadeId: 1, ...empty, rects: [[1, 1, 3, 3]], segmentTry: { outcome: 'assisted', openingShare: 0.2, ms: 5 } },
            { facadeId: 2, ...empty, segmentTry: { outcome: 'no-windows', openingShare: 0.01, ms: 5 } },
            { facadeId: 3, ...empty, segmentTry: { outcome: 'not-found', ms: 5 } },
            { facadeId: 4, ...empty, segmentTry: { outcome: 'failed', error: 'no vision model', ms: 1 } },
            { facadeId: 5, ...empty, segmentTry: { outcome: 'failed', error: 'no vision model', ms: 1 } },
            { facadeId: 6, error: 'relief_band failed' }
        ] };
        expect(segmentSummary(file)).toEqual({ attempted: 5, assisted: 1, noWindows: 1, notFound: 1, failed: 2, errors: ['no vision model'] });
    });

    describe('the opening-mask reading (a facade the six readings left empty)', () => {
        const MW = 120, MH = 60, mf: FitFrame = { pixel: PX, orthoSMin: 0, orthoTMax: 6, texel: 0.05 };
        /** A 12 x 6 m wall of `wall` grey with dark `win` windows 1.5 x 3 m at x 10, 50, 90 px, y 15. */
        const row = (wall: number, win: number) => {
            const rgba = new Uint8Array(MW * MH * 4);
            for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
                const v = [10, 50, 90].some(a => x >= a && x < a + 15) && y >= 15 && y < 45 ? win : wall;
                rgba.set([v, v, v, 255], (y * MW + x) * 4);
            }
            return { rgba, width: MW, height: MH };
        };
        const outline = (x0: number, x1: number, y0: number, y1: number) => Uint8Array.from({ length: MW * MH }, (_, k) => ((k % MW) >= x0 && (k % MW) < x1 && Math.floor(k / MW) >= y0 && Math.floor(k / MW) < y1 ? 1 : 0));

        it("keeps the openings the photo confirms and finds their repeats: a mask of one window gives the row's three", () => {
            const r = maskWindows(row(170, 50), undefined, mf, outline(8, 27, 13, 47));
            expect(r.seeds).toBe(1);
            expect(r.repeats).toBe(2);
            expect(r.rects).toEqual([[10, 15, 25, 45], [50, 15, 65, 45], [90, 15, 105, 45]]);
            expect(r.bands[0]).toMatchObject({ accepted: true, grid: 'mask' });
        });

        it('gives a mask the photo does not confirm no windows: a blank wall, and an evenly dark wall', () => {
            const blank = maskWindows(row(150, 150), undefined, mf, outline(0, 60, 0, 60));
            expect(blank.rects).toEqual([]);
            expect(blank.bands[0]).toMatchObject({ accepted: false, why: 'the photo confirms none of the mask' });
            // on a wall this dark a small difference reads as darkness against its surround, but is no plainer than the wall
            const dark = maskWindows(row(30, 26), undefined, mf, outline(8, 27, 13, 47));
            expect(dark.rects).toEqual([]);
        });

        it('enlarges a thin photo for the segmenter and takes its mask back at the photo size, window or door', async () => {
            // a 10 x 40 px photo: enlarged 16 times (short side to 160 px); the segmenter marks x 32-95 as a window and y 0-63
            // as a door in the enlarged frame, i.e. photo columns 2-5 and rows 0-3
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opening-seg-')), file = path.join(dir, 'f.png');
            fs.writeFileSync(file, encodePng(10, 40, Buffer.alloc(10 * 40 * 4, 200), 4));
            const seen: Array<[number, number, string]> = [];
            const seg = openingSegmenter(async (_png, w, h, target) => {
                seen.push([w, h, target]);
                const m = new Uint8Array(w * h);
                for (let k = 0; k < m.length; k++) { const x = k % w, y = Math.floor(k / w); m[k] = (target.includes('window') ? x >= 32 && x < 96 : y < 64) ? 255 : 0; }
                return { mask: m };
            });
            const out = (await seg(file, 10, 40))!;
            expect(seen.map(s => s.slice(0, 2))).toEqual([[160, 640], [160, 640]]);
            for (let y = 0; y < 40; y++) for (let x = 0; x < 10; x++) expect(out[y * 10 + x]).toBe((x >= 2 && x < 6) || y < 4 ? 1 : 0);
            // neither target found: no mask
            expect(await openingSegmenter(async () => ({ mask: null }))(file, 10, 40)).toBeUndefined();
            fs.rmSync(dir, { recursive: true, force: true });
        });

        // a 3 x 30 m face: a dark column between light piers down to 26 m, light stone below; the photo reaches its top 10 m,
        // misses the next `gap` rows, and reaches the rest
        const columnFace = (gap: number) => {
            const CW = 30, CH = 300, rgba = new Uint8Array(CW * CH * 4), uncovered = new Uint8Array(CW * CH);
            for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
                const v = x >= 8 && x < 22 && y < 260 ? 60 : 180;
                rgba.set([v, v, v, 255], (y * CW + x) * 4);
                uncovered[y * CW + x] = y >= 100 && y < 100 + gap ? 1 : 0;
            }
            const mask = Uint8Array.from({ length: CW * CH }, (_, k) => ((k % CW) >= 6 && (k % CW) < 24 && Math.floor(k / CW) < 100 ? 1 : 0));
            return maskWindows({ rgba, width: CW, height: CH }, uncovered, { pixel: PX, orthoSMin: 0, orthoTMax: 30, texel: 0.05 }, mask);
        };

        it('continues a window column through photo that never reached it to where the photo shows it again, labelled generated', () => {
            // missed 12 m, then the photo shows the column for its last 4 m and the stone below it
            const r = columnFace(120);
            expect(r.seeds).toBe(1);
            expect(r.panes).toEqual([[8, 0, 22, 100]]);
            expect(r.generated).toHaveLength(1);
            const [g] = r.generated!;
            expect(g.slice(0, 3)).toEqual([8, 100, 22]);
            expect(g[3]).toBeGreaterThanOrEqual(256);
            expect(g[3]).toBeLessThanOrEqual(268);
        });

        it('does not continue a column into photo that never reached it when nothing beyond shows the column', () => {
            // missed from 10 m to the foot: no step the photo reaches shows the column below its confirmed part
            const r = columnFace(200);
            expect(r.panes).toEqual([[8, 0, 22, 100]]);
            expect(r.generated).toBeUndefined();
        });
    });

    it("hands the lattice each facade's windows in its photo's UVs", () => {
        const file: WindowFitFile = { version: 'test', params: {} as never, ms: 0, facades: [{ facadeId: 3, width: 200, height: 100, rects: [[20, 10, 60, 50]], bands: [], ms: 0 }, { facadeId: 4, error: 'relief_band failed' }, { facadeId: 6, width: 100, height: 100, rects: [], bands: [], ms: 0 }] };
        expect(fittedWindowUvs(file, 3)).toEqual([0.1, 0.1, 0.3, 0.5]);
        expect(fittedWindowUvs(file, 4)).toBeUndefined();
        expect(fittedWindowUvs(file, 5)).toBeUndefined();
        // a facade the fit placed nothing on (no grid to read): its other evidence decides
        expect(fittedWindowUvs(file, 6)).toBeUndefined();
    });

    it('splits a strip into its panes at the storey pitch: the bluer, lighter run is the glass', () => {
        // a 20 px wide strip on stone, 400 px tall; every 40 px storey: 24 px of sky-lit glass, 16 px of brown spandrel
        const Wd = 60, Hd = 400, rgba = new Uint8Array(Wd * Hd * 4), valid = new Uint8Array(Wd * Hd).fill(1);
        for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
            const inStrip = x >= 20 && x < 40, glass = (y % 40) < 24;
            rgba.set([...(inStrip ? (glass ? [150, 165, 185] : [80, 60, 50]) : [200, 190, 175]), 255], (y * Wd + x) * 4);
        }
        const panes = panesOfStrip({ rgba, width: Wd, height: Hd }, valid, [20, 0, 40, 400], 40, WINDOW_FIT_PARAMS)!;
        expect(panes.length).toBe(10);
        for (const [x0, y0, x1, y1] of panes) {
            expect([x0, x1]).toEqual([20, 40]);
            expect(y0 % 40).toBeLessThanOrEqual(2);
            expect(Math.abs((y1 - y0) - 24)).toBeLessThanOrEqual(2);
        }
        // a strip of one colour has no panes to tell apart
        const flat = Uint8Array.from(rgba);
        for (let y = 0; y < Hd; y++) for (let x = 20; x < 40; x++) flat.set([80, 60, 50, 255], (y * Wd + x) * 4);
        expect(panesOfStrip({ rgba: flat, width: Wd, height: Hd }, valid, [20, 0, 40, 400], 40, WINDOW_FIT_PARAMS)).toBeUndefined();
    });

    it("reads a narrow tower face's bay pitch: two bays across the band are enough (the relief's minPeriodsInSpan)", async () => {
        // a 14 m wide, 40 m tall face at 0.077 m texels: light piers 1.6 m wide every 5.6 m, dark bays between with a light
        // spandrel every 3.5 m; the bay pitch is more than a third of the width, so a search for three of it finds none
        const px = 0.077, w = Math.round(14 / px), h = Math.round(40 / px), rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const s = (x + 0.5) * px, t = (y + 0.5) * px, pier = s % 5.6 < 1.6, spandrel = t % 3.5 < 0.9;
            const v = pier ? 190 : spandrel ? 120 : 45;
            rgba.set([v, v, v, 255], (y * w + x) * 4);
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relief-band-'));
        const png = path.join(dir, 'facade.png');
        fs.writeFileSync(png, encodePng(w, h, Buffer.from(rgba), 4));
        const bin = await ensureReliefBandBinary();
        const [g] = await nativeRelief(bin, png, undefined, { pixel: px, orthoSMin: 0, orthoTMax: 40, texel: 2 * px })('-', 4, 0, [[0, w, 0, h]]);
        fs.rmSync(dir, { recursive: true, force: true });
        expect(g.periodS.found).toBe(true);
        expect(g.periodS.pitch).toBeCloseTo(5.6, 0);
        expect(g.periodT.found).toBe(true);
        expect(g.periodT.pitch).toBeCloseTo(3.5, 0);
    }, 600_000);

    it('offers the segmenter only the empty facades its scope admits, and fits again when the scope changes', async () => {
        // two blank walls, so the structural fit leaves both empty: a 12 x 30 m one and a 12 x 6 m strip; the scope admits
        // walls under 10 m tall, as beside a reader that reads the rest
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'segment-scope-')), px = 0.1;
        const facades = [{ facadeId: 1, h: 300 }, { facadeId: 2, h: 60 }].map(({ facadeId, h }) => {
            const w = 120, image = `facade_${facadeId}.png`;
            fs.writeFileSync(path.join(dir, image), encodePng(w, h, Buffer.alloc(w * h * 4, 170).map((v, k) => (k % 4 === 3 ? 255 : v)), 4));
            return { facadeId, image, coverage: 1, pixel: px, orthoSMin: 0, orthoTMax: h * px, texel: 2 * px };
        });
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades }));
        const asked: string[] = [];
        const segment: SegmentOpeningMask = async png => { asked.push(path.basename(png)); return undefined; };
        const short = { key: 'under-10m', includes: (p: { heightM: number }) => p.heightM < 10 };
        const r = await fitWindowsForOrthos(dir, { segment, segmentScope: short, concurrency: 1 });
        expect(asked).toEqual(['facade_2.png']);
        const tries = r.fit.facades.map(f => ('error' in f ? 'error' : f.segmentTry?.outcome));
        expect(tries).toEqual([undefined, 'not-found']);
        // the same scope: the file stands; another scope: fitted again
        expect((await fitWindowsForOrthos(dir, { segment, segmentScope: short })).cached).toBe(true);
        expect((await fitWindowsForOrthos(dir, { segment, segmentScope: { key: 'all', includes: () => true } })).cached).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    }, 600_000);


    it('completes the lattice from its repeats: a lit pane on the grid becomes a window, a site showing the wall stays wall', () => {
        // 4 columns x 4 rows of dark windows (12 x 20 px) on a light stone wall, every 30 px across and 40 px up; one site holds a
        // pane mirroring the sky (light, cool, with a dark frame), one is plain stone
        const W = 130, H = 170, rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H).fill(1);
        for (let k = 0; k < W * H; k++) rgba.set([200, 192, 178, 255], k * 4);
        const rects: Array<[number, number, number, number]> = [];
        const site = (c: number, r: number): [number, number, number, number] => [10 + c * 30, 10 + r * 40, 22 + c * 30, 30 + r * 40];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
            const q = site(c, r);
            if (c === 1 && r === 1) {
                // lit glass: a dark frame round a light cool pane
                for (let y = q[1]; y < q[3]; y++) for (let x = q[0]; x < q[2]; x++) rgba.set(x - q[0] < 2 || q[2] - x <= 2 || y - q[1] < 2 || q[3] - y <= 2 ? [40, 38, 40, 255] : [170, 190, 205, 255], (y * W + x) * 4);
                continue;
            }
            if (c === 2 && r === 2) continue; // plain stone
            for (let y = q[1]; y < q[3]; y++) for (let x = q[0]; x < q[2]; x++) rgba.set([45, 42, 44, 255], (y * W + x) * 4);
            rects.push(q);
        }
        const done = completeLattice({ rgba, width: W, height: H }, valid, rects, [0, W, 0, H]);
        expect(done.added).toBe(1);
        expect(done.stone).toBe(1);
        expect(done.rects).toContainEqual(site(1, 1));
        expect(done.rects).not.toContainEqual(site(2, 2));
        // a site outside the band is left to its own band
        expect(completeLattice({ rgba, width: W, height: H }, valid, rects, [0, W, 100, H]).added).toBe(0);
    });

    it("places a band's strip panes from their folded unit cell: glass rows at the storey pitch, split at the mullion", () => {
        // two strips 20 px wide, each two window columns (8 px glass, 4 px dark mullion between); storeys 30 px: 12 px glass, 18 px spandrel
        const W = 80, H = 120, rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H).fill(1);
        for (let k = 0; k < W * H; k++) rgba.set([200, 192, 178, 255], k * 4);
        const strips: Array<[number, number, number, number]> = [[10, 0, 30, 120], [50, 0, 70, 120]];
        for (const [xa] of strips) for (let y = 0; y < H; y++) for (let x = xa; x < xa + 20; x++) {
            const u = x - xa, glassRow = y % 30 < 12, mullion = u >= 8 && u < 12;
            rgba.set(mullion ? [50, 45, 45, 255] : glassRow ? [120, 150, 175, 255] : [70, 52, 50, 255], (y * W + x) * 4);
        }
        const r = panesOfUnitCell({ rgba, width: W, height: H }, valid, strips, [0, W, 0, H], 30);
        expect(r.groups).toBe(1);
        for (const ps of r.perStrip) {
            expect(ps).toBeDefined();
            // two panes a storey, none across the mullion, each within the glass rows
            for (const [x0, y0, x1, y1] of ps!) {
                const u0 = x0 - (x0 >= 50 ? 50 : 10), u1 = x1 - (x0 >= 50 ? 50 : 10);
                expect(u1 <= 9 || u0 >= 11).toBe(true);
                expect(y0 % 30).toBeLessThanOrEqual(1);
                expect(y1 - y0).toBeGreaterThanOrEqual(10);
                expect(y1 - y0).toBeLessThanOrEqual(14);
            }
            expect(ps!.length).toBe(8);
        }
    });

    it('keeps a pane only where it reads unlike the stone beside its window: a carved stone panel is no glass', () => {
        // limestone wall; window A holds cool grey glass, window B a panel of the same stone, a little shaded
        const W = 60, H = 30, rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H).fill(1);
        for (let k = 0; k < W * H; k++) rgba.set([200, 190, 172, 255], k * 4);
        const a: [number, number, number, number] = [5, 5, 20, 25], b: [number, number, number, number] = [35, 5, 50, 25];
        for (let y = a[1]; y < a[3]; y++) for (let x = a[0]; x < a[2]; x++) rgba.set([130, 145, 160, 255], (y * W + x) * 4);
        for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) rgba.set([188, 179, 162, 255], (y * W + x) * 4);
        const r = panesUnlikeWall({ rgba, width: W, height: H }, valid, [a, b], [a, b], [0, W, 0, H]);
        expect(r.panes).toEqual([a]);
        expect(r.dropped).toBe(1);
    });

    it('reads a narrow face as one window column from its storey rhythm, and nothing from plain stone', () => {
        // a 3 m wide, 35 m tall return face at 0.1 m: stone edges 0.6 m each side, between them a window 1.4 m tall every 3.5 m
        const px = 0.1, w = 30, h = 350, rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const inCol = x >= 6 && x < 24, win = inCol && (y * px) % 3.5 >= 1.0 && (y * px) % 3.5 < 2.4;
            rgba.set(win ? [40, 45, 55, 255] : [200, 190, 172, 255], (y * w + x) * 4);
        }
        const frame: FitFrame = { pixel: px, orthoSMin: 0, orthoTMax: 35, texel: 0.2 };
        const ctx = { f: frame, dk: Darkness.of({ rgba, width: w, height: h }, undefined, px).dk, P: WINDOW_FIT_PARAMS };
        const r = storeyColumn(ctx as never, [0, w, 0, h], 3.5)!;
        expect(r.rects.length).toBeGreaterThanOrEqual(9);
        for (const [x0, y0, x1, y1] of r.rects) {
            expect(x0).toBeGreaterThanOrEqual(5); expect(x1).toBeLessThanOrEqual(25);
            expect(((y0 * px) % 3.5)).toBeGreaterThan(0.8); expect(((y0 * px) % 3.5)).toBeLessThan(1.3);
            expect((y1 - y0) * px).toBeGreaterThan(1.1); expect((y1 - y0) * px).toBeLessThan(1.7);
        }
        const plain = new Uint8Array(w * h * 4);
        for (let k = 0; k < w * h; k++) plain.set([200, 190, 172, 255], k * 4);
        expect(storeyColumn({ ...ctx, dk: Darkness.of({ rgba: plain, width: w, height: h }, undefined, px).dk } as never, [0, w, 0, h], 3.5)).toBeUndefined();
    });

    it("continues the grid into parts the photo never reached, flanked on both axes, labelled generated; never at the grid's edge", () => {
        // 4 x 4 dark windows on light stone; the photo never reached site (1, 1) (inside) nor site (3, 3) (a corner)
        const W = 130, H = 170, rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H).fill(1);
        for (let k = 0; k < W * H; k++) rgba.set([200, 192, 178, 255], k * 4);
        const site = (c: number, r: number): [number, number, number, number] => [10 + c * 30, 10 + r * 40, 22 + c * 30, 30 + r * 40];
        const rects: Array<[number, number, number, number]> = [];
        for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
            const q = site(c, r), hole = (c === 1 && r === 1) || (c === 3 && r === 3);
            for (let y = q[1] - 3; y < q[3] + 3; y++) for (let x = q[0] - 3; x < q[2] + 3; x++) if (hole) valid[y * W + x] = 0;
            if (hole) continue;
            for (let y = q[1]; y < q[3]; y++) for (let x = q[0]; x < q[2]; x++) rgba.set([45, 42, 44, 255], (y * W + x) * 4);
            rects.push(q);
        }
        const done = completeLattice({ rgba, width: W, height: H }, valid, rects, [0, W, 0, H]);
        expect(done.generated).toEqual([site(1, 1)]);
        expect(done.rects).toContainEqual(site(1, 1));
        expect(done.rects).not.toContainEqual(site(3, 3));
    });
});
