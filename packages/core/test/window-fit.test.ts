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
import { completeLattice, ensureReliefBandBinary, fitFacadeWindows, fittedPlanesOf, panesOfUnitCell, panesUnlikeWall, fittedWindowUvs, nativeRelief, panesOfStrip, WINDOW_FIT_PARAMS, type FitFrame, type ReliefGrid, type ReliefRunner, type WindowFitFile } from '../src/node/3d-engine/staged-location/window-fit';

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

    it('reads every fitted plane with its frame, its windows and panes; a plane with no windows or a size mismatch is left out', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitted-planes-'));
        const frame = (facadeId: number, width: number) => ({ facadeId, image: `facade_${facadeId}.png`, centroid: [0, 10, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -5, orthoTMax: 10, pixel: 0.1, width, height: 200, coverage: 0.4 });
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [frame(1, 100), frame(2, 100), frame(3, 100)] }));
        const fit: WindowFitFile = { version: 'v', params: WINDOW_FIT_PARAMS, ms: 0, facades: [
            { facadeId: 1, width: 100, height: 200, rects: [[10, 10, 20, 30]], panes: [[10, 10, 20, 18]], bands: [], ms: 0 },
            { facadeId: 2, width: 100, height: 200, rects: [], bands: [], ms: 0 },
            { facadeId: 3, width: 90, height: 200, rects: [[1, 1, 2, 2]], bands: [], ms: 0 }
        ] };
        fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify(fit));
        const planes = fittedPlanesOf(dir);
        fs.rmSync(dir, { recursive: true, force: true });
        expect(planes.map(p => p.facadeId)).toEqual([1]);
        expect(planes[0].windows).toEqual([[10, 10, 20, 30]]);
        expect(planes[0].panes).toEqual([[10, 10, 20, 18]]);
        expect(planes[0].orthoTMax).toBe(10);
        expect(fittedPlanesOf(path.join(os.tmpdir(), 'no-such-orthos'))).toEqual([]);
    });

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
});
