/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building's system (pipeline-k/building-system.ts), read from the whole structure by a stand-in vision agent, and
 * laid on each face region by region by the window array (pipeline-k/window-array.ts): synthetic faces of one building on
 * the same floors (dark 1.2 x 2 m windows every 3 m across, 4 m storeys): a face read by nothing taking its neighbour's
 * array; a base of openings that do not repeat under an array shaft; a building with no arrays; an array the photo
 * contradicts; an unsure answer; grouped bays (windows in threes, a wider pier between the groups) the photo shows where
 * the model read one window per bay.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { parseSystem, readBuildingSystem, systemOnFace, type BuildingSystem } from '../src/node/3d-engine/staged-location/pipeline-k/building-system';
import type { FacadeAsk } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { arrayFacadeFirstPass, bayWarp, describeWindowArrays, groupedBay, inferWindowArrays, inferWindowArraysOnThreads, lightnessProfiles } from '../src/node/3d-engine/staged-location/pipeline-k/window-array';
import { WINDOW_FIT_PARAMS, WINDOW_FIT_VERSION, type WindowFitFile, type WindowRect } from '../src/node/3d-engine/staged-location/window-fit';

const PX = 0.1, W = 300, H = 600, COL = 30, ROW = 40, BW = 12, BH = 20;
const site = (i: number, j: number): WindowRect => { const cx = COL / 2 + i * COL, cy = ROW / 2 + j * ROW; return [Math.round(cx - BW / 2), Math.round(cy - BH / 2), Math.round(cx + BW / 2), Math.round(cy + BH / 2)]; };
function photo(windows: WindowRect[]): Uint8Array {
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (let k = 0; k < W * H; k++) rgba.set([200, 200, 200], k * 4);
    for (const [x0, y0, x1, y1] of windows) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([40, 40, 40], (y * W + x) * 4);
    return rgba;
}
const truth: WindowRect[] = []; for (let j = 0; j < 15; j++) for (let i = 0; i < 10; i++) truth.push(site(i, j));
// both faces 60 m tall from the ground (world Y = centroid.y + (orthoTMax - y px), orthoTMax = tMax: the ground at Y 0), facing two ways
const frame = (id: number, normal: number[]) => ({ facadeId: id, image: `facade_${id}.png`, width: W, height: H, pixel: PX, coverage: 1, orthoSMin: 0, orthoTMax: H * PX / 2, texel: PX, centroid: [0, H * PX / 2, 0], normal, axisT: [0, 1, 0], tMin: -H * PX / 2, tMax: H * PX / 2 });
const SHAFT = { name: 'punched', repeats: true, storeyM: 4, bayM: 3, windowsPerBay: 1, windowWidthM: 1.2, windowHeightM: 2, sillM: 1 };
/** An answer: every face listed with one region per band [bottomM, topM, pattern]. */
const ANSWER = (cells: Record<number, string>, bands: Record<number, Array<[number, number, string | null]>>, patterns: unknown[] = [SHAFT], conf = 80) => JSON.stringify({
    building: 'a slab of punched windows', conf, patterns,
    regions: Object.entries(bands).flatMap(([id, bs]) => bs.map(([bottomM, topM, pattern]) => ({ cell: cells[Number(id)], bottomM, topM, pattern })))
});

function setup(faces: Array<{ id: number; windows: WindowRect[]; boxes: WindowRect[] }>): { dir: string; fit: WindowFitFile } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'building-system-'));
    for (const f of faces) fs.writeFileSync(path.join(dir, `facade_${f.id}.png`), encodePng(W, H, photo(f.windows), 4));
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: faces.map((f, k) => frame(f.id, k ? [1, 0, 0] : [0, 0, -1])) }));
    const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: faces.map(f => ({ facadeId: f.id, width: W, height: H, rects: f.boxes, panes: [], bands: [], ms: 0 })) };
    fs.writeFileSync(path.join(dir, 'window_fit.json'), JSON.stringify(fit));
    return { dir, fit };
}
/** A stand-in agent that answers from the sheet's cell list (cell names by facade id read from the prompt). */
function standIn(build: (cells: Record<number, string>) => string): { ask: FacadeAsk; prompts: string[] } {
    const prompts: string[] = [];
    const ask: FacadeAsk = async (_png, prompt) => {
        prompts.push(prompt);
        const cells: Record<number, string> = {};
        // the cells are listed in the sheet's order (largest first); both faces are the same size, so facades.json order
        const names = [...prompt.matchAll(/^- (r\d+c\d+):/gm)].map(m => m[1]);
        names.forEach((n, k) => { cells[k + 1] = n; });
        return build(cells);
    };
    return { ask, prompts };
}

describe('the building system', () => {
    it('parses patterns and each face\'s regions by the sheet\'s cells, an array with its measures or openings that do not repeat, and refuses one out of range', () => {
        const cells = [{ cell: 'r1c1', facadeId: 4 }, { cell: 'r1c2', facadeId: 9 }];
        const s = parseSystem(ANSWER({ 4: 'r1c1', 9: 'r1c2' }, { 4: [[0, 8, 'shops'], [8, 60, 'punched']], 9: [[0, 60, null]] }, [SHAFT, { name: 'shops', repeats: false }]), cells);
        expect(s.patterns).toEqual([{ ...SHAFT }, { name: 'shops', repeats: false }]);
        expect(s.regions).toEqual([{ facadeId: 4, pattern: 'shops', bottomM: 0, topM: 8 }, { facadeId: 4, pattern: 'punched', bottomM: 8, topM: 60 }, { facadeId: 9, pattern: null, bottomM: 0, topM: 60 }]);
        expect(() => parseSystem(ANSWER({ 4: 'r1c1' }, { 4: [[0, 60, 'punched']] }, [{ ...SHAFT, storeyM: 40 }]), cells)).toThrow(/out of range/);
        expect(() => parseSystem(ANSWER({ 4: 'r1c1' }, { 4: [[0, 60, 'nowhere']] }), cells)).toThrow(/no known pattern/);
        expect(() => parseSystem('no json', cells)).toThrow(/no JSON/);
    });

    it('lays a face\'s regions in its pixels: each band\'s rows, and an array\'s pane pitch, storey and window centre line', () => {
        const sys: BuildingSystem = { version: 'v', building: '', patterns: [{ ...SHAFT, bayM: 6, windowsPerBay: 2 }, { name: 'shops', repeats: false }], regions: [{ facadeId: 1, pattern: 'shops', bottomM: 0, topM: 8 }, { facadeId: 1, pattern: 'punched', bottomM: 8, topM: 60 }], conf: 80, groundY: 0, sheet: '', reused: false };
        const rs = systemOnFace(sys, frame(1, [0, 0, -1]));
        expect(rs.map(r => [r.y0, r.y1, r.repeats])).toEqual([[0, 520, true], [520, 600, false]]);
        const lat = rs[0].lattice!;
        expect(lat.col.pitch).toBeCloseTo(30, 5); expect(lat.col.size).toBeCloseTo(12, 5);
        expect(lat.row.pitch).toBeCloseTo(40, 5); expect(lat.row.size).toBeCloseTo(20, 5);
        // the shaft's first window centre 10 m up (8 + sill 1 + half of 2): y = (60 - 10) / 0.1 = 500 px, modulo 40 = 20
        expect(lat.row.phase).toBeCloseTo(20, 5);
        expect(systemOnFace(sys, frame(2, [1, 0, 0]))).toEqual([]);
    });

    it('lays the system the same, byte for byte, with each facade\'s first pass on other threads', async () => {
        const a = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: truth, boxes: [] }]);
        const b = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: truth, boxes: [] }]);
        const { ask } = standIn(c => ANSWER(c, { 1: [[0, 60, 'punched']], 2: [[0, 60, 'punched']] }));
        const r = await readBuildingSystem(a.dir, ask, { readings: { store: memoryReadingStore(), model: 'stand-in' } });
        const here = inferWindowArrays(a.dir, a.fit, undefined, { system: r.system! });
        const there = await inferWindowArraysOnThreads(b.dir, b.fit, async jobs => jobs.map(j => structuredClone(arrayFacadeFirstPass(structuredClone(j)))), undefined, { system: r.system! });
        expect(here.facades.find(f => f.facadeId === 2)!.source).toBe('system');
        expect({ ...there, ms: 0 }).toEqual({ ...here, ms: 0 });
        expect(fs.readFileSync(path.join(b.dir, 'window_fit.json'), 'utf8')).toBe(fs.readFileSync(path.join(a.dir, 'window_fit.json'), 'utf8'));
    });

    it('gives a face read by nothing the array its neighbour shows, from one model reading of the whole building, kept for the next build', async () => {
        const { dir, fit } = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: truth, boxes: [] }]);
        const store = memoryReadingStore();
        const { ask, prompts } = standIn(c => ANSWER(c, { 1: [[0, 60, 'punched']], 2: [[0, 60, 'punched']] }));
        const r = await readBuildingSystem(dir, ask, { readings: { store, model: 'stand-in' } });
        expect(r.reason).toBeUndefined(); expect(r.calls).toBe(1);
        expect(prompts[0]).toContain('columns repeat every 3 m');
        expect(prompts[0]).toMatch(/have NO array/);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        const f2 = rep.facades.find(f => f.facadeId === 2)!;
        expect(f2.reason).toBeUndefined(); expect(f2.source).toBe('system');
        expect(f2.system!.regions).toHaveLength(1); expect(f2.system!.regions![0].windows).toBe(150);
        const e2 = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[1] as Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }>;
        expect(e2.rects).toHaveLength(150);
        expect(rep.system).toMatchObject({ arrayRegions: 2, laid: 2, refused: 0 });
        expect(describeWindowArrays(rep)).toContain("the building's system read from the whole structure");
        const again = await readBuildingSystem(dir, ask, { readings: { store, model: 'stand-in' } });
        expect(again.calls).toBe(0); expect(again.reused).toBe(1); expect(prompts).toHaveLength(1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('changes pattern by region: a base of openings that do not repeat keeps its boxes as read under an array shaft that is filled', async () => {
        // the shaft's windows above 8 m; the base (below 8 m, the photo's lowest 80 rows) has three odd openings read
        const shaft = truth.filter(r => r[3] <= 520), odd: WindowRect[] = [[20, 540, 70, 590], [130, 550, 150, 590], [200, 535, 280, 580]];
        const { dir, fit } = setup([{ id: 1, windows: [...shaft, ...odd], boxes: [...shaft.filter((_, k) => k % 3), ...odd] }, { id: 2, windows: truth, boxes: truth }]);
        const r = await readBuildingSystem(dir, standIn(c => ANSWER(c, { 1: [[0, 8, 'shops'], [8, 60, 'punched']], 2: [[0, 60, 'punched']] }, [SHAFT, { name: 'shops', repeats: false }])).ask);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        const f1 = rep.facades.find(f => f.facadeId === 1)!;
        expect(f1.reason).toBeUndefined();
        // top to bottom, as the photo's rows run
        expect(f1.system!.regions!.map(x => [x.pattern, x.repeats])).toEqual([['punched', true], ['shops', false]]);
        const e1 = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0] as Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }>;
        // the shaft complete (13 storeys x 10), the three odd openings exactly as read, nothing else in the base
        for (const o of odd) expect(e1.rects).toContainEqual(o);
        expect(e1.rects.filter(x => (x[1] + x[3]) / 2 >= 520)).toHaveLength(3);
        expect(e1.rects.filter(x => (x[1] + x[3]) / 2 < 520)).toHaveLength(shaft.length);
        expect(rep.system).toMatchObject({ notArray: 1 });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('leaves a building with no arrays as read, refuses an array the photo contradicts, and does not use an unsure answer', async () => {
        // no arrays anywhere: the boxes stay exactly as read, however periodic the photo
        const { dir, fit } = setup([{ id: 1, windows: truth, boxes: truth.filter((_, k) => k % 2) }, { id: 2, windows: truth, boxes: [] }]);
        const r = await readBuildingSystem(dir, standIn(c => ANSWER(c, { 1: [[0, 60, 'scattered']], 2: [[0, 60, null]] }, [{ name: 'scattered', repeats: false }])).ask);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        for (const f of rep.facades) { expect(f.reason).toMatch(/no array on this face/); expect(f.added).toBe(0); }
        expect(rep.system).toMatchObject({ arrayRegions: 0, notArray: 1, noOpenings: 1 });
        const kept = JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile;
        expect((kept.facades[0] as { rects: WindowRect[] }).rects).toHaveLength(75);
        // an array read on a plain wall: the photo refuses it
        const { dir: d2, fit: fit2 } = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: [], boxes: [] }]);
        const r2 = await readBuildingSystem(d2, standIn(c => ANSWER(c, { 1: [[0, 60, 'punched']], 2: [[0, 60, 'punched']] })).ask);
        const rep2 = inferWindowArrays(d2, fit2, undefined, { system: r2.system! });
        const f2 = rep2.facades.find(f => f.facadeId === 2)!;
        expect(f2.reason).toMatch(/did not confirm/); expect(f2.system!.regions![0].reason).toMatch(/shows no window/);
        expect(rep2.system).toMatchObject({ arrayRegions: 2, laid: 1, refused: 1 });
        const unsure = await readBuildingSystem(d2, standIn(c => ANSWER(c, { 1: [[0, 60, 'punched']] }, [SHAFT], 20)).ask);
        expect(unsure.system).toBeUndefined(); expect(unsure.reason).toMatch(/unsure/);
        fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
    });

    it('reads grouped bays from the photo where the model read evenly spaced windows: the threes laid whole, each window at its own width', () => {
        // windows in threes 3 m apart on an 11 m bay (a 5 m pier between the groups), 1.2 x 2 m, 4 m storeys, six bays
        const GW = 660, BAY = 110, OFF = [25, 55, 85];
        const g: WindowRect[] = []; for (let j = 0; j < 15; j++) for (let b = 0; b < 6; b++) for (const o of OFF) { const cx = b * BAY + o, cy = ROW / 2 + j * ROW; g.push([cx - BW / 2, cy - BH / 2, cx + BW / 2, cy + BH / 2]); }
        const rgba = new Uint8Array(GW * H * 4); for (let k = 0; k < GW * H; k++) rgba.set([200, 200, 200, 255], k * 4);
        for (const [x0, y0, x1, y1] of g) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([40, 40, 40], (y * GW + x) * 4);
        // the photo alone shows the bay: three windows at 25, 55 and 85 px of each 110 px
        const valid = new Uint8Array(GW * H).fill(1);
        const bay = groupedBay(lightnessProfiles({ rgba, width: GW, height: H }, valid).col, 29, 12)!;
        expect(bay.bay).toBeCloseTo(BAY, 0);
        bay.offsets.forEach((o, k) => expect(Math.abs(o - OFF[k])).toBeLessThanOrEqual(1)); // within a texel (the bay measured to a fraction of one)
        // the warp spaces them evenly and keeps each window's width
        const wp = bayWarp(bay, GW);
        expect(wp.pitch).toBeCloseTo(BAY / 3, 0);
        for (const o of OFF) { expect(wp.fwd(o + 6) - wp.fwd(o - 6)).toBeCloseTo(12, 0); expect(wp.inv(wp.fwd(o + 0.3))).toBeCloseTo(o + 0.3, 6); }
        // evenly spaced windows are not bays
        expect(groupedBay(lightnessProfiles({ rgba: photo(truth), width: W, height: H }, new Uint8Array(W * H).fill(1)).col, 30, 12)).toBeUndefined();
        // through the system: the model read a 2.9 m pitch, one window per bay; a third of the boxes read
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'building-system-bays-'));
        fs.writeFileSync(path.join(dir, 'facade_1.png'), encodePng(GW, H, rgba, 4));
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...frame(1, [0, 0, -1]), width: GW }] }));
        const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: GW, height: H, rects: g.filter((_, k) => k % 3 === 0), panes: [], bands: [], ms: 0 }] };
        const sys: BuildingSystem = { version: 'v', building: '', patterns: [{ ...SHAFT, bayM: 2.9 }], regions: [{ facadeId: 1, pattern: 'punched', bottomM: 0, topM: 60 }], conf: 80, groundY: 0, sheet: '', reused: false };
        const rep = inferWindowArrays(dir, fit, undefined, { system: sys });
        const reg = rep.facades[0].system!.regions![0];
        expect(reg.source).toBe('system');
        expect(reg.bay).toMatchObject({ windows: 3 }); expect(reg.bay!.pitchM).toBeCloseTo(11, 1);
        const out = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0] as { rects: WindowRect[] };
        expect(out.rects).toHaveLength(g.length);
        // every window found within 2 px of its place, at its own width
        for (const t of g) expect(out.rects.some(r => Math.abs((r[0] + r[2]) / 2 - (t[0] + t[2]) / 2) <= 2 && Math.abs((r[1] + r[3]) / 2 - (t[1] + t[3]) / 2) <= 2 && Math.abs(r[2] - r[0] - BW) <= 2)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('takes the window size from the boxes read on the system\'s sites, not the model\'s, so read and added windows match', async () => {
        // the model reads a 0.8 x 1.2 m window; the photo and two boxes in three show 1.2 x 2 m
        const { dir, fit } = setup([{ id: 1, windows: truth, boxes: truth.filter((_, k) => k % 3 !== 0) }, { id: 2, windows: truth, boxes: truth }]);
        const small = { ...SHAFT, windowWidthM: 0.8, windowHeightM: 1.2 };
        const r = await readBuildingSystem(dir, standIn(c => ANSWER(c, { 1: [[0, 60, 'punched']], 2: [[0, 60, 'punched']] }, [small])).ask);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        const f1 = rep.facades.find(f => f.facadeId === 1)!;
        expect(f1.system!.regions![0].reason).toBeUndefined();
        expect(f1.system!.regions![0].source).toBe('system');
        const e1 = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0] as { rects: WindowRect[] };
        expect(e1.rects).toHaveLength(150);
        // every window, read or added, at the boxes' size
        for (const q of e1.rects) { expect(q[2] - q[0]).toBeCloseTo(BW, -0.5); expect(q[3] - q[1]).toBeCloseTo(BH, -0.5); }
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('reads windows paired about a pier on a bay exactly two windows wide, where the model read two to a bay, and keeps the read boxes on their pairs', () => {
        // pairs 2 m apart on a 6 m bay (a 4 m pier between pairs: the bay is exactly two windows' even spacing, yet they are grouped)
        const GW = 600, BAY = 60, OFF = [20, 40];
        const g: WindowRect[] = []; for (let j = 0; j < 15; j++) for (let b = 0; b < 10; b++) for (const o of OFF) { const cx = b * BAY + o, cy = ROW / 2 + j * ROW; g.push([cx - 6, cy - BH / 2, cx + 6, cy + BH / 2]); }
        const rgba = new Uint8Array(GW * H * 4); for (let k = 0; k < GW * H; k++) rgba.set([200, 200, 200, 255], k * 4);
        for (const [x0, y0, x1, y1] of g) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) rgba.set([40, 40, 40], (y * GW + x) * 4);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'building-system-pairs-'));
        fs.writeFileSync(path.join(dir, 'facade_1.png'), encodePng(GW, H, rgba, 4));
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...frame(1, [0, 0, -1]), width: GW }] }));
        const read = g.filter((_, k) => k % 3 !== 0);
        const fit: WindowFitFile = { version: WINDOW_FIT_VERSION, params: WINDOW_FIT_PARAMS, ms: 0, facades: [{ facadeId: 1, width: GW, height: H, rects: read, panes: [], bands: [], ms: 0 }] };
        const sys: BuildingSystem = { version: 'v', building: '', patterns: [{ ...SHAFT, bayM: 6, windowsPerBay: 2 }], regions: [{ facadeId: 1, pattern: 'punched', bottomM: 0, topM: 60 }], conf: 80, groundY: 0, sheet: '', reused: false };
        const rep = inferWindowArrays(dir, fit, undefined, { system: sys });
        const reg = rep.facades[0].system!.regions![0];
        expect(reg.source).toBe('system');
        expect(reg.bay).toMatchObject({ windows: 2 }); expect(reg.bay!.pitchM).toBeCloseTo(6, 1);
        const out = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[0] as { rects: WindowRect[] };
        expect(out.rects).toHaveLength(g.length);
        // every window at its own place in its pair, none moved to an even half-bay
        for (const t of g) expect(out.rects.some(r => Math.abs((r[0] + r[2]) / 2 - (t[0] + t[2]) / 2) <= 2 && Math.abs((r[1] + r[3]) / 2 - (t[1] + t[3]) / 2) <= 2)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });

});
