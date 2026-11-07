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
 * no glass asked or kept (user decision, 2026-11-05); window_fit.json takes the openings and keeps the window fit's own.
 */

import { describe, it, expect } from 'vitest';
import { windowSourceOf, WINDOW_FIT_VERSION } from '../src/node/3d-engine/staged-location/window-fit';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FACADE_READER_PARAMS, FACADE_READER_VERSION, luminanceOf, mergeReadings, parseJudgement, parseReading, parseZones, readFacade, readPlanes, tileZone, type FacadeAsk, type FacadePhoto } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { contextFor, parseBrief, planePlaces } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader-brief';
import { exemplarOf, matchExemplar } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader-template';

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
        return JSON.stringify({ rows, between: 'stone spandrels', conf: 85, notes: 'punched windows over spandrels' });
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
    it('reads the zones, tiles the unit cell down its zone at the measured pitch, two panes an opening', async () => {
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
        expect('glass' in r).toBe(false);
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
        // unguided, the doubled pitch is halved by the photo itself: windows sit between the rows read (tileZone, 1)
        expect(unguided.halved).toBe(true);
        expect(Math.abs(unguided.pitch - PITCH)).toBeLessThan(1);
        expect(guided.guided).toBe(true);
        expect(Math.abs(guided.pitch - PITCH)).toBeLessThan(0.6);
        expect(Math.abs(guided.rects.length - unguided.rects.length)).toBeLessThanOrEqual(1);
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
        expect('glass' in r).toBe(false);
    });

    it("merges a plane's reading zone by zone: the reader's openings inside the zones it drew, the window fit's kept outside them, and a merge repeated gives the same", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-merge-'));
        try {
            // the window fit read a window in the top half and one in the bottom half, and a continued (generated) one at the bottom
            const top: [number, number, number, number] = [10, 10, 30, 40], bottom: [number, number, number, number] = [10, 310, 30, 340], gen: [number, number, number, number] = [50, 310, 70, 340];
            const fit: any = { version: 'window-fit/8', params: {}, ms: 1, facades: [
                { facadeId: 7, width: 100, height: 400, rects: [top, bottom, gen], panes: [top, bottom], generated: [gen], bands: [], ms: 1 },
                { facadeId: 8, width: 100, height: 400, rects: [top], panes: [top], bands: [], ms: 1 }
            ] };
            // the reader drew only the top half of plane 7 (its bottom zone rejected), and plane 9, which the fit never saw
            const readings = [
                { facadeId: 7, width: 100, height: 400, rects: [[12, 12, 28, 38], [60, 12, 76, 38]] as Array<[number, number, number, number]>, panes: [[12, 12, 28, 38], [60, 12, 76, 38]] as Array<[number, number, number, number]>, drawn: [{ x0: 0, y0: 0, x1: 100, y1: 200 }] },
                { facadeId: 9, width: 50, height: 50, rects: [[5, 5, 15, 15]] as Array<[number, number, number, number]>, panes: [[5, 5, 15, 15]] as Array<[number, number, number, number]>, drawn: [{ x0: 0, y0: 0, x1: 50, y1: 50 }] }
            ];
            const once = mergeReadings(dir, fit, readings);
            expect(once.merged).toEqual({ planes: 2, readerWindows: 3, keptFitWindows: 2, replacedFitWindows: 1 });
            const e7: any = once.facades.find((f: any) => f.facadeId === 7);
            expect(e7.rects).toEqual([[12, 12, 28, 38], [60, 12, 76, 38], bottom, gen]);
            expect(e7.panes).toEqual([[12, 12, 28, 38], [60, 12, 76, 38], bottom]);
            expect(e7.generated).toEqual([gen]);
            expect(e7.structural.rects).toEqual([top, bottom, gen]);
            expect(e7.readerWindows).toBe(2);
            expect(windowSourceOf(once, 7)).toBe(`${FACADE_READER_VERSION}: 2 windows read from the photo (photo-inferred); ${WINDOW_FIT_VERSION}: 2 kept outside the zones it drew`);
            expect(windowSourceOf(once, 9)).toBe(`${FACADE_READER_VERSION}: 1 windows read from the photo (photo-inferred)`);
            expect(windowSourceOf(once, 8)).toBe(WINDOW_FIT_VERSION);
            // a plane the reader gave nothing for keeps the window fit's whole; a plane the fit never saw gets its own entry
            expect((once.facades.find((f: any) => f.facadeId === 8) as any).rects).toEqual([top]);
            expect((once.facades.find((f: any) => f.facadeId === 9) as any).rects).toEqual([[5, 5, 15, 15]]);
            // merged again over its own file (a cached window fit read back): the same
            const again = mergeReadings(dir, JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')), readings);
            expect((again.facades.find((f: any) => f.facadeId === 7) as any).rects).toEqual(e7.rects);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

    it("reads a narrow face beside the wide walls, tiles it at their storey pitch once they are read, and keeps the calls in flight under the limit", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-reader-schedule-'));
        try {
            const img = facade(), Wn = 30, X0 = 14;
            const narrow = new Uint8Array(Wn * H * 4);
            for (let y = 0; y < H; y++) narrow.set(img.rgba.subarray((y * W + X0) * 4, (y * W + X0 + Wn) * 4), y * Wn * 4);
            fs.writeFileSync(path.join(dir, 'f7.png'), encodePng(W, H, Uint8Array.from(img.rgba), 4));
            fs.writeFileSync(path.join(dir, 'f8.png'), encodePng(Wn, H, narrow, 4));
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [frame, { ...frame, facadeId: 8, image: 'f8.png', width: Wn }] }));
            const { ask } = standIn();
            const events: string[] = [];
            let inFlight = 0, maxInFlight = 0, wideAsked!: () => void;
            const wideStarted = new Promise<void>(resolve => { wideAsked = resolve; });
            // the wide wall answers slowly; the narrow face (3 m) at once, its reading every other storey only, once the wide
            // wall's first call is out (its photo is decoded on a codec thread, the narrow face's small one inline)
            const timed: FacadeAsk = async (png, prompt, kind, region) => {
                const isNarrow = kind === 'overview' ? region.x1 === Wn : region.x1 - region.x0 <= Wn;
                if (isNarrow) await wideStarted; else wideAsked();
                inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
                try {
                    if (!isNarrow) await new Promise(r => setTimeout(r, 40));
                    if (isNarrow && kind === 'read') {
                        const ch = region.y1 - region.y0, rows = [];
                        for (let k = 0; k < 20; k += 2) { const t = PHASE + k * PITCH; if (t >= region.y0 && t + WIN_H <= region.y1) rows.push({ y: [((t - region.y0) / ch) * 1000, ((t + WIN_H - region.y0) / ch) * 1000], openings: [[18, 30]].map(([a, c]) => ({ x: [((a - X0) / Wn) * 1000, ((c - X0) / Wn) * 1000], panes: 1 })) }); }
                        return JSON.stringify({ rows, conf: 80 });
                    }
                    return await ask(png, prompt, kind, region);
                } finally { inFlight--; events.push(`${isNarrow ? 'narrow' : 'wide'}:${kind}`); }
            };
            const r = await readPlanes(dir, timed, { params: { ...FACADE_READER_PARAMS, concurrency: 2, brief: false } });
            expect(maxInFlight).toBe(2);
            // the narrow face's reading came back while the wide wall was still being read; its judge only after the wide wall
            expect(events.indexOf('narrow:read')).toBeLessThan(events.lastIndexOf('wide:judge'));
            expect(events.lastIndexOf('narrow:judge')).toBeGreaterThan(events.lastIndexOf('wide:judge'));
            expect(Math.abs(r.records.guide!.pitchM - PITCH * PIXEL)).toBeLessThan(0.06);
            const z = r.records.facades.find(f => f.facadeId === 8)!.zones!.find(x => x.outcome === 'drawn')!;
            expect(z.fit!.guided).toBe(true);
            expect(Math.abs(z.fit!.pitchPx - PITCH)).toBeLessThan(0.6);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('reads the brief: cells mapped to their planes (an unknown or repeated cell dropped), and tells a reading its family and place', () => {
        const cells = [{ cell: 'r1c1', facadeId: 7 }, { cell: 'r1c2', facadeId: 8 }, { cell: 'r2c1', facadeId: 9 }];
        const b = parseBrief('x {"building":"A stepped Art Deco tower in limestone","families":[{"name":"shaft","cells":["R1C1","r1c2","r9c9"],"openings":"paired one-over-one windows","storeyM":3.8},{"name":"crown","cells":["r1c2","r2c1"]}],"conf":80} y', cells);
        expect(b.families).toEqual([{ name: 'shaft', planes: [7, 8], openings: 'paired one-over-one windows', storeyM: 3.8 }, { name: 'crown', planes: [9] }]);
        expect(() => parseBrief('{"families":[]}', cells)).toThrow();
        const places = planePlaces([
            { facadeId: 7, image: 'a', width: 300, height: 600, pixel: 0.1, centroid: [0, 40, 0], normal: [1, 0, 0], axisT: [0, 1, 0], tMin: -30, tMax: 30 },
            { facadeId: 8, image: 'b', width: 300, height: 600, pixel: 0.1, centroid: [0, 70, 0], normal: [0, 0, -1], axisT: [0, 1, 0], tMin: -30, tMax: 30 }
        ]);
        expect(places.get(7)).toMatchObject({ kind: 'wall', bearingDeg: 90, widthM: 30, heightM: 60, bottomM: 0, topM: 60 });
        expect(places.get(8)).toMatchObject({ bearingDeg: 0, bottomM: 30, topM: 90 });
        const told = contextFor(b, places.get(8), b.families[0]);
        expect(told).toContain('A stepped Art Deco tower');
        expect(told).toContain('facing north');
        expect(told).toContain('"shaft" (2 planes), whose openings are: paired one-over-one windows; storeys about 3.8 m');
    });

    it("finds a family's window again on a darker photo of the same wall, every one of them, and nothing on a blank wall", () => {
        const a = luminanceOf(facade()), dark = luminanceOf(facade(40, 120));
        const ex = exemplarOf({ L: a, W, H, pixel: PIXEL }, [cols[4][0], PHASE + 6 * PITCH, cols[4][1], PHASE + 6 * PITCH + WIN_H], 2, 7, 'shaft')!;
        expect(ex).toBeDefined();
        const found = matchExemplar({ L: dark, W, H, pixel: PIXEL }, ex);
        const truth = cols.flatMap(([x0, x1]) => Array.from({ length: 20 }, (_, k) => [x0, PHASE + k * PITCH, x1, PHASE + k * PITCH + WIN_H]).filter(r => r[1] >= GREY_ROWS + 6 && r[3] <= H - 6));
        // every covered window (away from the grey top and the edges) found within 2 px, and nothing that is not one
        for (const t of truth) expect(found.some(m => Math.abs(m.rect[0] - t[0]) <= 2 && Math.abs(m.rect[1] - t[1]) <= 2)).toBe(true);
        for (const m of found) expect(truth.some(t => Math.abs(m.rect[0] - t[0]) <= 3 && Math.abs(m.rect[1] - t[1]) <= 3) || m.rect[1] < GREY_ROWS + 8 || m.rect[3] > H - 8).toBe(true);
        const blank = luminanceOf(facade(190, 190));
        expect(matchExemplar({ L: blank, W, H, pixel: PIXEL }, ex)).toEqual([]);
    });

    it("reads a family's lead and draws its sibling from the lead's window with one judge call, told the building", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'facade-reader-family-'));
        try {
            fs.writeFileSync(path.join(dir, 'f7.png'), encodePng(W, H, Uint8Array.from(facade().rgba), 4));
            fs.writeFileSync(path.join(dir, 'f8.png'), encodePng(W, H, Uint8Array.from(facade(45, 150).rgba), 4));
            const geo = { centroid: [0, 30, 0], axisT: [0, 1, 0], tMin: -30, tMax: 30 };
            fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...frame, ...geo, normal: [0, 0, 1] }, { ...frame, ...geo, facadeId: 8, image: 'f8.png', coverage: 0.85, normal: [1, 0, 0] }] }));
            const { ask } = standIn();
            const calls: string[] = [], prompts: string[] = [];
            const withBrief: FacadeAsk = async (png, prompt, kind, region) => {
                calls.push(kind); prompts.push(prompt);
                if (kind === 'brief') return JSON.stringify({ building: 'A limestone office tower of punched windows', families: [{ name: 'office floors', cells: ['r1c1', 'r1c2'], openings: 'pairs of single windows in each bay' }], conf: 80 });
                return ask(png, prompt, kind as 'overview' | 'read' | 'judge', region);
            };
            const r = await readPlanes(dir, withBrief);
            expect(calls).toEqual(['brief', 'overview', 'read', 'judge', 'judge']);
            // the lead's overview and reading were told the building and its family; the judge was not
            expect(prompts[1]).toContain('A limestone office tower');
            expect(prompts[2]).toContain('"office floors"');
            expect(prompts[3]).not.toContain('Building context');
            const sib = r.records.facades.find(f => f.facadeId === 8)!;
            expect(sib.outcome).toBe('replaced');
            expect(sib.family).toBe('office floors');
            expect(sib.zones![0].template).toMatchObject({ fromPlane: 7 });
            const lead = r.records.readings.find(x => x.facadeId === 7)!, drawn = r.records.readings.find(x => x.facadeId === 8)!;
            // the sibling's windows where the lead's are, give or take the template's 2 px
            expect(drawn.rects.length).toBeGreaterThanOrEqual(lead.rects.length - cols.length);
            for (const rr of drawn.rects) expect(lead.rects.some(l => Math.abs(l[0] - rr[0]) <= 4 && Math.abs(l[1] - rr[1]) <= 4)).toBe(true);
            expect(drawn.panes.length).toBe(2 * drawn.rects.length);
            expect((r.records.brief as any).families[0].planes).toEqual([7, 8]);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it("writes the openings into window_fit.json, the window fit's own kept, and reads once", async () => {
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
            // the strip lay inside the zone the reader drew: the reader's openings stand there, the window fit's go
            expect(e.rects).not.toContainEqual(strip);
            expect(first.records.readings[0].drawn.length).toBeGreaterThan(0);
            expect(e.glass).toBeUndefined();
            expect(first.records.facades[0].outcome).toBe('replaced');
            expect(fs.readdirSync(path.join(dir, 'facade_reader'))).toContain('7_z0.png');
            const again = await readPlanes(dir, ask);
            expect(again.cached).toBe(true);
            expect(calls.length).toBe(3);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
