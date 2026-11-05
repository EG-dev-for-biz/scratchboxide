/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIRM_IOU, CROP_HALF_M, decideFootprint, PARTIAL_AREA_RATIO, footprintConfirmed, footprintModelUnavailable, growFootprintModel, kCutConfirmedEnabled, kFootprint, modelSeed, rasterArea, rasterIoU, runFootprintModel, MERGED_AREA_RATIO, type FootprintModelResult } from '../src/node/3d-engine/staged-location/footprint-model';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';
import { inRing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';

// Real outlines from the NYC truth benchmark (docs/processes/nyc_truth_benchmark_2026-10-31.md), in the tile frame of
// each building's query point: Google's vector footprint as the app merges it, the city's surveyed footprint, and the
// footprint model's outline on that building's tiles.
interface Case { google_ring: Vec2[]; truth_ring: Vec2[]; model: { ok: boolean; ring: Vec2[]; meanProbInside: number } }
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'footprint-model-nyc.json'), 'utf8')) as Record<string, Case>;

describe('decideFootprint', () => {
    it('keeps the vector footprint where it and the model agree (E.V. Haughwout Building)', () => {
        const c = cases['1007227'];
        const d = decideFootprint([c.google_ring], c.model);
        expect(d.use).toBe('vector');
        expect(d.iouWithVector!).toBeGreaterThan(0.7);
    });

    it('takes the model where the vector footprint merges a whole block (BIN 1002696, 13 parts, 11x the building)', () => {
        const c = cases['1002696'];
        const d = decideFootprint([c.google_ring], c.model);
        expect(d.use).toBe('model');
        expect(d.vectorAreaM2! / d.modelAreaM2!).toBeGreaterThan(MERGED_AREA_RATIO);
        // and the model is the better footprint there: compare both with the surveyed one
        const modelIoU = rasterIoU([c.truth_ring], [c.model.ring]);
        const vectorIoU = rasterIoU([c.truth_ring], [c.google_ring]);
        expect(modelIoU).toBeGreaterThan(0.7);
        expect(vectorIoU).toBeLessThan(0.2);
    });

    it('takes the model where the vector footprint covers only part of the building (BIN 1003048, unseen by the fit)', () => {
        const c = cases['1003048'];
        const d = decideFootprint([c.google_ring], c.model);
        expect(d.use).toBe('model');
        expect(d.vectorAreaM2! / d.modelAreaM2!).toBeLessThanOrEqual(PARTIAL_AREA_RATIO);
        expect(rasterIoU([c.truth_ring], [c.model.ring])).toBeGreaterThan(0.8);
        expect(rasterIoU([c.truth_ring], [c.google_ring])).toBeLessThan(0.5);
        // not on a model this unsure
        expect(decideFootprint([c.google_ring], { ...c.model, meanProbInside: 0.85 }).use).toBe('vector');
    });

    it('keeps a right vector footprint smaller than a model outline that spills past it (BIN 1008237)', () => {
        const c = cases['1008237'];
        expect(decideFootprint([c.google_ring], c.model).use).toBe('vector');
        expect(rasterIoU([c.truth_ring], [c.google_ring])).toBeGreaterThan(0.85);
    });

    it('takes the model where there is no vector footprint', () => {
        const c = cases['1003061'];
        expect(decideFootprint(undefined, c.model).use).toBe('model');
        expect(decideFootprint([], c.model).use).toBe('model');
    });

    it('never takes an unsure model reading, or none', () => {
        const c = cases['1002696'];
        expect(decideFootprint([c.google_ring], { ...c.model, meanProbInside: 0.4 }).use).toBe('vector');
        expect(decideFootprint([c.google_ring], { ok: false, ring: [], meanProbInside: 0 }).use).toBe('vector');
        // sure enough to stand where there is no vector footprint, not sure enough to replace one
        expect(decideFootprint([c.google_ring], { ...c.model, meanProbInside: 0.9 }).use).toBe('vector');
        expect(decideFootprint(undefined, { ...c.model, meanProbInside: 0.9 }).use).toBe('model');
    });
});

describe('footprintConfirmed', () => {
    it('trusts the model\'s chosen outline and a vector footprint the model closely agrees with, nothing else', () => {
        const h = cases['1007227'], m = cases['1002696'];
        expect(footprintConfirmed(decideFootprint([m.google_ring], m.model))).toBe(true);           // the model's outline
        const agree = decideFootprint([h.google_ring], h.model);
        expect(agree.iouWithVector!).toBeGreaterThanOrEqual(CONFIRM_IOU);
        expect(footprintConfirmed(agree)).toBe(true);                                               // Google, confirmed
        expect(footprintConfirmed({ use: 'vector', reason: '', iouWithVector: 0.55 })).toBe(false); // kept, not confirmed
        expect(footprintConfirmed(decideFootprint([h.google_ring], undefined))).toBe(false);        // no model reading
        expect(footprintConfirmed(undefined)).toBe(false);
    });
});

describe('kFootprint (pipeline K\'s footprint, judged against the tiles)', () => {
    const scan: Vec2[] = [[-1, -1], [51, -1], [51, 31], [-1, 31]];
    it('stands on Google\'s outline where the tiles confirm it, trusted', () => {
        const h = cases['1007227'];
        const k = kFootprint([h.google_ring], decideFootprint([h.google_ring], h.model), h.model.ring, h.model.meanProbInside, scan);
        expect(k).toMatchObject({ from: 'vector', trusted: true, loops: [h.google_ring] });
    });
    it('stands on the model\'s outline where it replaces Google\'s (merged, partial, missing), trusted', () => {
        const m = cases['1002696'], p = cases['1003048'], n = cases['1003061'];
        expect(kFootprint([m.google_ring], decideFootprint([m.google_ring], m.model), m.model.ring, m.model.meanProbInside, scan)).toMatchObject({ from: 'model', trusted: true, loops: [m.model.ring] });
        expect(kFootprint([p.google_ring], decideFootprint([p.google_ring], p.model), p.model.ring, p.model.meanProbInside, scan).from).toBe('model');
        expect(kFootprint([], decideFootprint(undefined, n.model), n.model.ring, n.model.meanProbInside, scan)).toMatchObject({ from: 'model', trusted: true });
    });
    it('falls back to the scan\'s outline where the tiles do not confirm Google\'s and the model does not replace it', () => {
        // Penn 2's case: the model's reading overlaps Google's traced outline 0.56, under CONFIRM_IOU, and does not merge or part it
        const google: Vec2[] = [[0, 0], [50, 0], [50, 30], [0, 30]];
        const model: Vec2[] = [[-8, -8], [58, -8], [58, 34], [-8, 34]];
        const d = decideFootprint([google], { ok: true, ring: model, meanProbInside: 0.87 });
        expect(d.use).toBe('vector');
        expect(d.iouWithVector!).toBeLessThan(CONFIRM_IOU);
        expect(kFootprint([google], d, model, 0.87, scan)).toMatchObject({ from: 'scan', trusted: false, loops: [scan] });
    });
    it('cuts a scan that does not fit a confirmed footprint only when asked (SCRATCHBOX_K_CUT_CONFIRMED=1)', () => {
        expect(kCutConfirmedEnabled({})).toBe(false);
        expect(kCutConfirmedEnabled({ SCRATCHBOX_K_CUT_CONFIRMED: '1' })).toBe(true);
    });
    it('keeps Google\'s outline, untrusted, without a sure model reading; the scan\'s without either', () => {
        const google: Vec2[] = [[0, 0], [50, 0], [50, 30], [0, 30]];
        expect(kFootprint([google], undefined, undefined, undefined, scan)).toMatchObject({ from: 'vector', trusted: false, loops: [google] });
        expect(kFootprint([google], decideFootprint([google], { ok: true, ring: google, meanProbInside: 0.4 }), google, 0.4, scan)).toMatchObject({ from: 'vector', trusted: false });
        expect(kFootprint([], undefined, undefined, undefined, scan)).toMatchObject({ from: 'scan', trusted: false, loops: [scan] });
    });
});

describe('modelSeed (where the model is asked)', () => {
    const L: Vec2[] = [[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]];
    it('asks at the place when it stands well inside Google\'s outline, or when there is none', () => {
        expect(modelSeed([10, 10], [L])).toEqual([10, 10]);
        expect(modelSeed([100, 100], [])).toEqual([100, 100]);
    });
    it('asks inside the outline, far from its edges, when the place is on its edge or outside it (a geocode on the kerb)', () => {
        for (const place of [[40, 10], [41, 25], [1, 1]] as Vec2[]) {
            const s = modelSeed(place, [L]);
            expect(inRing(s[0], s[1], L)).toBe(true);
            // the L's widest part: at least 8 m from every edge
            expect(Math.min(s[0], s[1], 40 - s[1], 40 - s[0])).toBeGreaterThan(8);
            expect(s[0] < 20 || s[1] < 20).toBe(true);
        }
    });
});

describe('growFootprintModel (a building larger than one window)', () => {
    // a stand-in for the model: it outlines the part of a rectangular building inside the 64 m crop around its point,
    // as the real model's outline stops at its crop; nothing outside the building
    const building = { x0: -20, z0: -10, x1: 110, z1: 40 };
    const standIn = (b = building) => async (o: { x: number; z: number }): Promise<FootprintModelResult> => {
        const x0 = Math.max(b.x0, o.x - CROP_HALF_M), x1 = Math.min(b.x1, o.x + CROP_HALF_M), z0 = Math.max(b.z0, o.z - CROP_HALF_M), z1 = Math.min(b.z1, o.z + CROP_HALF_M);
        const inside = o.x > b.x0 && o.x < b.x1 && o.z > b.z0 && o.z < b.z1;
        return inside ? { ok: true, model: 'stand-in', ring: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], areaM2: (x1 - x0) * (z1 - z0), meanProbInside: 0.9, probAtPoint: 1, wallAngleDeg: 0, groundY: 0 }
            : { ok: false, model: 'stand-in', probAtPoint: 0, wallAngleDeg: 0, groundY: 0, reason: 'no building' };
    };
    const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-grow-'));
    it('reads one window when the building fits in it, as the model was measured', async () => {
        const r = await growFootprintModel({ texturedGlb: 'unused.glb', seed: [10, 10], workDir: dir(), run: standIn({ x0: 0, z0: 0, x1: 30, z1: 20 }) });
        expect(r.windows).toHaveLength(1);
        expect(r.areaM2).toBeCloseTo(600, 0);
        expect(r.truncated).toBe(false);
    });
    it('grows past the crop window by window and joins the outlines into the whole building', async () => {
        const r = await growFootprintModel({ texturedGlb: 'unused.glb', seed: [0, 15], workDir: dir(), run: standIn() });
        expect(r.windows.length).toBeGreaterThan(1);
        expect(r.truncated).toBe(false);
        // the whole 130 x 50 m building, within a cell of its edges
        expect(r.areaM2!).toBeGreaterThan(6400);
        expect(r.areaM2!).toBeLessThan(6600);
        expect(rasterIoU([r.ring!], [[[building.x0, building.z0], [building.x1, building.z0], [building.x1, building.z1], [building.x0, building.z1]]])).toBeGreaterThan(0.98);
        expect(r.meanProbInside).toBeCloseTo(0.9, 5);
    });
    it('says when the building runs on past the windows it may read', async () => {
        const r = await growFootprintModel({ texturedGlb: 'unused.glb', seed: [0, 15], workDir: dir(), run: standIn(), maxWindows: 1 });
        expect(r.windows).toHaveLength(1);
        expect(r.truncated).toBe(true);
    });
    it('reads nothing more when there is no building at the seed', async () => {
        const r = await growFootprintModel({ texturedGlb: 'unused.glb', seed: [500, 500], workDir: dir(), run: standIn() });
        expect(r.ok).toBe(false);
        expect(r.windows).toHaveLength(1);
    });
});

describe('footprintModelUnavailable (the weight-free path)', () => {
    it('says why without its weights, and when turned off', () => {
        expect(footprintModelUnavailable({ SCRATCHBOX_FOOTPRINT_MODEL_WEIGHTS: path.join(os.tmpdir(), 'no-such-weights.pt') })).toMatch(/weights are not at/);
        expect(footprintModelUnavailable({ SCRATCHBOX_FOOTPRINT_MODEL: '0' })).toMatch(/off/);
    });
    it('throws its reason from runFootprintModel instead of reading anything', async () => {
        const prev = process.env.SCRATCHBOX_FOOTPRINT_MODEL;
        process.env.SCRATCHBOX_FOOTPRINT_MODEL = '0';
        try { await expect(runFootprintModel({ texturedGlb: 'unused.glb', x: 0, z: 0, workDir: os.tmpdir() })).rejects.toThrow(/off/); }
        finally { if (prev === undefined) delete process.env.SCRATCHBOX_FOOTPRINT_MODEL; else process.env.SCRATCHBOX_FOOTPRINT_MODEL = prev; }
    });
});

describe('rasterIoU', () => {
    it('is 1 for identical loops and 0 for disjoint ones', () => {
        const sq: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const far: Vec2[] = [[20, 20], [30, 20], [30, 30], [20, 30]];
        expect(rasterIoU([sq], [sq])).toBeCloseTo(1, 5);
        expect(rasterIoU([sq], [far])).toBe(0);
    });
    it('takes a set of overlapping loops as their union (a building\'s parts at their own heights)', () => {
        const base: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const tower: Vec2[] = [[2, 2], [8, 2], [8, 8], [2, 8]];
        expect(rasterArea([base, tower])).toBeCloseTo(100, 0);
        expect(rasterIoU([base, tower], [base])).toBeCloseTo(1, 5);
        // stacked parts are not a merged footprint
        expect(decideFootprint([base, tower], { ok: true, ring: base, meanProbInside: 0.9 }).use).toBe('vector');
    });
    it('measures a half overlap', () => {
        const a: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
        const b: Vec2[] = [[5, 0], [15, 0], [15, 10], [5, 10]];
        expect(rasterIoU([a], [b])).toBeCloseTo(1 / 3, 2);
    });
});

// End to end on real tiles: the native window tool and the model, when its weights and Python environment are here
// (the weights live in the gitignored .model-cache/; set SCRATCHBOX_FOOTPRINT_MODEL_FIXTURE to a textured tile cut
// whose origin stands inside a building). Runs locally, never bills.
const fixture = process.env.SCRATCHBOX_FOOTPRINT_MODEL_FIXTURE;
describe.skipIf(!fixture || !!footprintModelUnavailable())('runFootprintModel (real tiles)', () => {
    it('outlines the building at the cut\'s origin, with a confident model', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-'));
        const r = await runFootprintModel({ texturedGlb: fixture!, x: 0, z: 0, workDir: dir });
        expect(r.ok).toBe(true);
        expect(r.ring!.length).toBeGreaterThanOrEqual(4);
        expect(r.areaM2!).toBeGreaterThan(30);
        expect(r.meanProbInside!).toBeGreaterThan(0.6);
        expect(fs.statSync(path.join(dir, 'height.f32')).size).toBe(320 * 320 * 4);
    }, 180_000);
});
