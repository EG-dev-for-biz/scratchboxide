/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade reader (pipeline-k/facade-reader.ts), a vision agent, against a stand-in model on a synthetic facade of
 * punched windows: the overview's zones, the unit cell tiled through its zone at the measured pitch (whichever way the
 * glass is lit), the judge's rejection keeping the window fit's reading, nothing drawn where the photo never reached,
 * the glass reading kept with the zone; window_fit.json takes the openings and keeps the window fit's own.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FACADE_READER_VERSION, luminanceOf, mergeReadings, parseJudgement, parseReading, parseZones, readFacade, readPlanes, tileZone, type FacadeAsk, type FacadePhoto } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

// a 30 m x 60 m facade at 0.1 m a pixel: 5 bays, each two windows 12 px wide, storeys every 38.4 px, windows 22 px tall;
// its top 6 m never reached by the photo
const W = 300, H = 600, PITCH = 38.4, PHASE = 9, WIN_H = 22, PIXEL = 0.1, GREY_ROWS = 60;
const cols: Array<[number, number]> = [];
for (let b = 0; b < 5; b++) { const x = 18 + b * 56; cols.push([x, x + 12], [x + 20, x + 32]); }
const isWindow = (x: number, y: number) => cols.some(([a, c]) => x >= a && x < c) && (((y - PHASE) % PITCH) + PITCH) % PITCH < WIN_H;

/** The facade, each window lit its own way when `mixed` (some darker than the wall, some lighter). */
function facade(win = 70, wall = 190, mixed = false): FacadePhoto {
    const rgba = new Uint8Array(W * H * 4);
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (y < GREY_ROWS) { rgba.set([128, 128, 128, 255], p); continue; }
        const k = Math.floor((y - PHASE) / PITCH), ci = cols.findIndex(([a, c]) => x >= a && x < c);
        const lit = mixed && (k * 7 + ci * 3) % 2 === 0 ? 230 : win;
        const v = (isWindow(x, y) ? lit : wall) + Math.round((rnd() - 0.5) * 30);
        rgba.set([v, v - 5, v - 10, 255], p);
    }
    return { rgba, width: W, height: H };
}

/**
 * A stand-in model: the overview gives the covered part as one zone with openings (and the grey top as one without); the
 * reading gives the rows it is shown with every edge 3 px off, two panes an opening, and the glass; the judge says `accept`.
 */
function standIn(accept = true): { ask: FacadeAsk; calls: string[] } {
    const calls: string[] = [];
    const ask: FacadeAsk = async (_png, _prompt, kind, region) => {
        calls.push(kind);
        if (kind === 'judge') return JSON.stringify({ accept, badColumns: [], conf: 80, notes: 'stand-in' });
        if (kind === 'overview') return JSON.stringify({ zones: [{ box: [0, 0, 1000, (GREY_ROWS / H) * 1000], openings: false, label: 'not covered' }, { box: [0, (GREY_ROWS / H) * 1000, 1000, 1000], openings: true, label: 'shaft of punched windows' }], conf: 90 });
        const ch = region.y1 - region.y0, cw = region.x1 - region.x0, rows = [];
        for (let k = -2; k < 20; k++) {
            const t = PHASE + k * PITCH, b = t + WIN_H;
            if (t < region.y0 || b > region.y1) continue;
            rows.push({ y: [((t + 3 - region.y0) / ch) * 1000, ((b - 2 - region.y0) / ch) * 1000], openings: cols.map(([a, c]) => ({ x: [((a + 3 - region.x0) / cw) * 1000, ((c - 2 - region.x0) / cw) * 1000], panes: 2 })) });
        }
        return JSON.stringify({ rows, glass: { label: 'clear, slightly green', transparency: 0.7, reflectivity: 0.25, tint: '#7A8F88', opaque: false }, between: 'stone spandrels', conf: 85, notes: 'punched windows over spandrels' });
    };
    return { ask, calls };
}

const frame = { facadeId: 7, image: 'f7.png', coverage: 0.9, width: W, height: H, pixel: PIXEL, orthoSMin: 0, orthoTMax: H * PIXEL, texel: PIXEL };

/** Every opening within `tol` px of a true window, and no truly covered window missing beyond one row. */
function checkOpenings(rects: Array<[number, number, number, number]>, tol: number) {
    for (const [x0, y0, x1, y1] of rects) {
        const c = cols.find(([a, b]) => Math.abs((a + b) / 2 - (x0 + x1) / 2) < 6)!;
        expect(c).toBeDefined();
        expect(Math.abs(x0 - c[0])).toBeLessThanOrEqual(tol);
        expect(Math.abs(x1 - c[1])).toBeLessThanOrEqual(tol);
        const k = Math.round((y0 - PHASE) / PITCH);
        expect(Math.abs(y0 - (PHASE + k * PITCH))).toBeLessThanOrEqual(tol);
        expect(y0).toBeGreaterThanOrEqual(GREY_ROWS - tol);
        expect(y1 - y0).toBeGreaterThan(WIN_H - 2 * tol);
    }
    const covered = Array.from({ length: 20 }, (_, k) => PHASE + k * PITCH).filter(t => t >= GREY_ROWS && t + WIN_H <= H).length;
    expect(rects.length).toBeGreaterThanOrEqual(cols.length * (covered - 1));
}

describe('pipeline K facade reader (vision agent)', () => {
    it('reads the zones, tiles the unit cell down its zone at the measured pitch, two panes an opening, and keeps the glass', async () => {
        const { ask, calls } = standIn();
        const r = await readFacade(facade(), undefined, frame, ask);
        expect(calls).toEqual(['overview', 'read', 'judge']);
        expect(r.record.outcome).toBe('replaced');
        const z = r.record.zones!.find(x => x.outcome === 'drawn')!;
        expect(z.fit!.measured).toBe(true);
        expect(Math.abs(z.fit!.pitchPx - PITCH)).toBeLessThan(0.6);
        expect(z.fit!.columns).toBe(10);
        checkOpenings(r.rects!, 3.5);
        expect(r.panes!.length).toBe(2 * r.rects!.length);
        expect(r.glass![0].glass).toMatchObject({ transparency: 0.7, reflectivity: 0.25, tint: '#7a8f88', opaque: false });
    });

    it('tiles a facade whose windows are each lit their own way (darker and lighter than the wall) the same way', async () => {
        const r = await readFacade(facade(70, 140, true), undefined, frame, standIn().ask);
        expect(r.record.outcome).toBe('replaced');
        // the reading's own 3 px, plus the pitch measured on a mixed-lit facade drifting at most half a pixel down it
        checkOpenings(r.rects!, 4);
    });

    it("tiles a narrow face's reading that skips storeys at the building's storey pitch (the guide)", () => {
        const L = luminanceOf(facade());
        const zone = { x0: 0, x1: W, y0: GREY_ROWS, y1: H }, crop = { x0: 0, x1: W, y0: 200, y1: 440 };
        // the model saw every other storey only (rows two storeys apart)
        const rows = [] as Array<{ y: [number, number]; openings: Array<{ x: [number, number]; panes: number }> }>;
        for (let k = 0; k < 20; k += 2) { const t = PHASE + k * PITCH; if (t >= crop.y0 && t + WIN_H <= crop.y1) rows.push({ y: [((t - crop.y0) / 240) * 1000, ((t + WIN_H - crop.y0) / 240) * 1000], openings: [{ x: [(cols[0][0] / W) * 1000, (cols[0][1] / W) * 1000], panes: 1 }] }); }
        const reading = { rows, conf: 80 };
        const unguided = tileZone(L, W, zone, crop, reading);
        const guided = tileZone(L, W, zone, crop, reading, undefined, PITCH);
        if ('why' in unguided || 'why' in guided) throw new Error('no tiling');
        expect(Math.abs(unguided.pitch - 2 * PITCH)).toBeLessThan(1);
        expect(guided.guided).toBe(true);
        expect(Math.abs(guided.pitch - PITCH)).toBeLessThan(0.6);
        expect(guided.rects.length).toBeGreaterThanOrEqual(2 * unguided.rects.length - 1);
        // a single row read: tiled through the zone at the guide
        const one = tileZone(L, W, zone, crop, { rows: rows.slice(0, 1), conf: 80 }, undefined, PITCH);
        if ('why' in one) throw new Error('no tiling');
        expect(one.rows.length).toBeGreaterThan(10);
    });

    it('keeps the measured pitch inside its search however far the read rows are off (the parabola never extrapolates)', () => {
        const L = luminanceOf(facade());
        const zone = { x0: 0, x1: W, y0: 0, y1: H }, crop = { x0: 0, x1: W, y0: 100, y1: 400 };
        // three rows read `step` px apart: from 45 px on the search window sits on the repeat's straight flank, where the
        // vertex of a parabola through the best lag at the window's edge once landed near or below zero
        for (let step = 40; step <= 62; step++) {
            const rows = [0, 1, 2].map(k => { const t = 120 + k * step; return { y: [((t - 100) / 300) * 1000, ((t + WIN_H - 100) / 300) * 1000] as [number, number], openings: cols.map(([a, c]) => ({ x: [(a / W) * 1000, (c / W) * 1000] as [number, number], panes: 1 })) }; });
            const t = tileZone(L, W, zone, crop, { rows, conf: 80 });
            if ('why' in t) throw new Error(`no tiling at ${step}: ${t.why}`);
            expect(t.pitch).toBeGreaterThanOrEqual(Math.floor(step * 0.9) - 0.5);
            expect(t.pitch).toBeLessThanOrEqual(Math.ceil(step * 1.1) + 0.5);
            expect(t.rows.length).toBeLessThanOrEqual(Math.ceil(H / t.pitch) + 1);
        }
    });

    it("keeps the window fit's reading when the judge rejects the outlines", async () => {
        const r = await readFacade(facade(), undefined, frame, standIn(false).ask);
        expect(r.record.outcome).toBe('kept');
        expect(r.record.zones![0].outcome).toBe('rejected');
        expect(r.rects).toBeUndefined();
    });

    it('asks nothing of a blank wall; reads a short plane without an overview', async () => {
        const img = facade();
        const blank = { ...img, rgba: Uint8Array.from(img.rgba, (v, k) => (k % 4 === 3 ? v : Math.floor(k / (W * 4)) < GREY_ROWS ? 128 : 190)) };
        const s = standIn();
        expect((await readFacade(blank, undefined, frame, s.ask)).record.outcome).toBe('skipped');
        expect(s.calls).toEqual([]);
        // the facade's lower 24 m alone: one read crop, no overview
        const Hs = 240, short = { rgba: img.rgba.slice((H - Hs) * W * 4), width: W, height: Hs };
        const s2 = standIn();
        const r = await readFacade(short, undefined, { ...frame, height: Hs }, async (png, prompt, kind, region) => s2.ask(png, prompt, kind, { ...region, y0: region.y0 + H - Hs, y1: region.y1 + H - Hs }));
        expect(s2.calls).toEqual(['read', 'judge']);
        expect(r.record.outcome).toBe('replaced');
    });

    it('rejects malformed replies', () => {
        expect(() => parseReading('{"rows":[{"y":[10],"openings":[]}]}')).toThrow();
        expect(() => parseJudgement('{"badColumns":[]}')).toThrow();
        expect(() => parseZones('{"zones":[{"box":[0,0,1000]}]}')).toThrow();
        const r = parseReading('x {"rows":[{"y":[100,200],"openings":[{"x":[10,20],"panes":3}]}],"glass":{"transparency":4,"tint":"blue"},"conf":70} y');
        expect(r.rows[0].openings[0].panes).toBe(3);
        expect(r.glass).toEqual({ transparency: 1, reflectivity: 0.3, opaque: false });
    });

    it('reads a narrow window-column wall (3 m wide) before any roof, and leaves out a roof under 6 m', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-reader-narrow-'));
        try {
            const img = facade(), Wn = 30;
            const narrow = new Uint8Array(Wn * H * 4);
            for (let y = 0; y < H; y++) narrow.set(img.rgba.subarray((y * W + 14) * 4, (y * W + 14 + Wn) * 4), y * Wn * 4);
            fs.writeFileSync(path.join(dir, 'f7.png'), encodePng(Wn, H, narrow, 4));
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...frame, width: Wn }] }));
            // a roof 5 m across: too small to read
            fs.writeFileSync(path.join(dir, 'plane_20000.png'), encodePng(50, 50, new Uint8Array(50 * 50 * 4).fill(200), 4));
            fs.writeFileSync(path.join(dir, 'planes.json'), JSON.stringify({ planes: [{ facadeId: 20000, image: 'plane_20000.png', kind: 'roof', width: 50, height: 50, pixel: 0.1, coverage: 1, orthoSMin: 0, orthoTMax: 5, texel: 0.1 }] }));
            const seen: number[] = [];
            const { ask } = standIn();
            const r = await readPlanes(dir, async (png, prompt, kind, region) => { seen.push(region.x1 - region.x0); return ask(png, prompt, kind, region); });
            expect(r.records.facades.map(f => f.facadeId)).toEqual([7]);
            expect(r.records.facades[0].outcome).not.toBe('skipped');
            expect(seen.length).toBeGreaterThan(0);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("writes the openings and the glass into window_fit.json, the window fit's own kept, and reads once", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-reader-'));
        try {
            const img = facade();
            fs.writeFileSync(path.join(dir, 'f7.png'), encodePng(W, H, Uint8Array.from(img.rgba), 4));
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [frame] }));
            const strip: [number, number, number, number] = [18, 60, 50, 600];
            fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify({ version: 'window-fit/8', params: {}, ms: 1, facades: [{ facadeId: 7, width: W, height: H, rects: [strip], panes: [strip], bands: [], ms: 1 }] }));
            const { ask, calls } = standIn();
            const first = await readPlanes(dir, ask);
            expect(first.cached).toBe(false);
            mergeReadings(dir, JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')), first.records.readings);
            const e: any = JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')).facades[0];
            expect(e.reader).toBe(FACADE_READER_VERSION);
            expect(e.structural.rects).toEqual([strip]);
            expect(e.rects.length).toBeGreaterThan(100);
            expect(e.glass[0].glass.label).toBe('clear, slightly green');
            expect(first.records.facades[0].outcome).toBe('replaced');
            expect(fs.readdirSync(path.join(dir, 'facade_reader'))).toContain('7_z0.png');
            const again = await readPlanes(dir, ask);
            expect(again.cached).toBe(true);
            expect(calls.length).toBe(3);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
