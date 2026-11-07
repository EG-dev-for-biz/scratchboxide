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
 * laid on each face by the window array (pipeline-k/window-array.ts): two synthetic faces of one building on the same
 * floors (dark 1.2 x 2 m windows every 3 m across, 4 m storeys), one fully read and one read by nothing; a blank face;
 * and a system the photo contradicts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { parseSystem, readBuildingSystem, systemOnFace, type BuildingSystem } from '../src/node/3d-engine/staged-location/pipeline-k/building-system';
import type { FacadeAsk } from '../src/node/3d-engine/staged-location/pipeline-k/facade-reader';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { describeWindowArrays, inferWindowArrays } from '../src/node/3d-engine/staged-location/pipeline-k/window-array';
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
const ANSWER = (cells: Record<number, string>, blank: number[] = [], over: Record<string, number> = {}) => JSON.stringify({
    building: 'a slab of punched windows', conf: 80,
    tiers: [{ name: 'shaft', bottomM: 0, topM: 60, storeyM: over.storeyM ?? 4, storeys: 15 }],
    families: [{ name: 'punched', cells: [cells[1], cells[2]].filter(Boolean), tier: 'shaft', bayM: over.bayM ?? 3, windowsPerBay: 1, windowWidthM: 1.2, windowHeightM: 2, sillM: 1 }],
    blank: blank.map(b => cells[b])
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
    it('parses an answer into tiers, families and blank faces by the sheet\'s cells, and refuses one out of range', () => {
        const cells = [{ cell: 'r1c1', facadeId: 4 }, { cell: 'r1c2', facadeId: 9 }];
        const s = parseSystem(ANSWER({ 1: 'r1c1' }, [2], {}).replace('"blank":[null]', '"blank":["r1c2"]'), cells);
        expect(s.tiers).toEqual([{ name: 'shaft', bottomM: 0, topM: 60, storeyM: 4, storeys: 15 }]);
        expect(s.families[0]).toMatchObject({ planes: [4], bayM: 3, windowsPerBay: 1, windowWidthM: 1.2, windowHeightM: 2, sillM: 1 });
        expect(s.blank).toEqual([9]);
        expect(() => parseSystem(ANSWER({ 1: 'r1c1' }, [], { storeyM: 40 }), cells)).toThrow(/tier is malformed/);
        expect(() => parseSystem('no json', cells)).toThrow(/no JSON/);
    });

    it('lays the system on a face in its pixels: the pane pitch across, the storey and the window\'s centre line up', () => {
        const sys: BuildingSystem = { version: 'v', building: '', tiers: [{ name: 'shaft', bottomM: 0, topM: 60, storeyM: 4, storeys: 15 }], families: [{ name: 'punched', planes: [1], bayM: 6, windowsPerBay: 2, windowWidthM: 1.2, windowHeightM: 2, sillM: 1 }], blank: [], conf: 80, groundY: 0, sheet: '', reused: false };
        const fs1 = systemOnFace(sys, frame(1, [0, 0, -1]))!;
        expect(fs1.col.pitch).toBeCloseTo(30, 5); expect(fs1.col.size).toBeCloseTo(12, 5);
        expect(fs1.row.pitch).toBeCloseTo(40, 5); expect(fs1.row.size).toBeCloseTo(20, 5);
        // the first floor's window centre 2 m up (sill 1 m + half of 2 m): y = (60 - 2) / 0.1 = 580 px, modulo 40 = 20
        expect(fs1.row.phase).toBeCloseTo(20, 5);
        expect(systemOnFace(sys, frame(2, [1, 0, 0]))).toBeUndefined();
    });

    it('gives a face read by nothing the array its neighbour shows, from one model reading of the whole building, kept for the next build', async () => {
        const { dir, fit } = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: truth, boxes: [] }]);
        const store = memoryReadingStore();
        const { ask, prompts } = standIn(c => ANSWER(c));
        const r = await readBuildingSystem(dir, ask, { readings: { store, model: 'stand-in' } });
        expect(r.reason).toBeUndefined(); expect(r.calls).toBe(1);
        expect(prompts[0]).toContain('columns repeat every 3 m');
        expect(r.system!.families[0].planes.sort()).toEqual([1, 2]);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        const f2 = rep.facades.find(f => f.facadeId === 2)!;
        expect(f2.reason).toBeUndefined();
        expect(f2.source).toBe('system'); expect(f2.system!.family).toBe('punched');
        expect(f2.system!.phaseMoved!).toBeLessThan(0.05);
        const e2 = (JSON.parse(fs.readFileSync(path.join(dir, 'window_fit.json'), 'utf8')) as WindowFitFile).facades[1] as Extract<WindowFitFile['facades'][number], { rects: WindowRect[] }>;
        expect(e2.rects).toHaveLength(150);
        expect(describeWindowArrays(rep)).toContain("the building's system read from the whole structure");
        // the next build: the kept answer, no call
        const again = await readBuildingSystem(dir, ask, { readings: { store, model: 'stand-in' } });
        expect(again.calls).toBe(0); expect(again.reused).toBe(1); expect(prompts).toHaveLength(1);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses the system on a face whose photo contradicts it, and leaves a face it calls blank as fitted', async () => {
        // face 2's photo is a plain wall: the system's lattice folds to nothing there
        const { dir, fit } = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: [], boxes: [] }]);
        const r = await readBuildingSystem(dir, standIn(c => ANSWER(c)).ask);
        const rep = inferWindowArrays(dir, fit, undefined, { system: r.system! });
        const f2 = rep.facades.find(f => f.facadeId === 2)!;
        expect(f2.reason).toBeDefined(); expect(f2.system!.refused).toMatch(/shows no window/);
        // the same building with face 2 called blank
        const { dir: d2, fit: fit2 } = setup([{ id: 1, windows: truth, boxes: truth }, { id: 2, windows: truth, boxes: [] }]);
        const r2 = await readBuildingSystem(d2, standIn(c => JSON.stringify({ ...JSON.parse(ANSWER(c)), families: [{ ...JSON.parse(ANSWER(c)).families[0], cells: [c[1]] }], blank: [c[2]] })).ask);
        const rep2 = inferWindowArrays(d2, fit2, undefined, { system: r2.system! });
        expect(rep2.facades.find(f => f.facadeId === 2)!.reason).toMatch(/^blank/);
        // and an unsure model is not used
        const unsure = await readBuildingSystem(d2, standIn(c => JSON.stringify({ ...JSON.parse(ANSWER(c)), conf: 20 })).ask);
        expect(unsure.system).toBeUndefined(); expect(unsure.reason).toMatch(/unsure/);
        fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
    });
});
