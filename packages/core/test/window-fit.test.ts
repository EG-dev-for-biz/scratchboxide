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

import { describe, expect, it } from 'vitest';
import { fitFacadeWindows, fittedWindowUvs, panesOfStrip, WINDOW_FIT_PARAMS, type FitFrame, type ReliefGrid, type ReliefRunner, type WindowFitFile } from '../src/node/3d-engine/staged-location/window-fit';

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
});
