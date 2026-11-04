/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Steps and ramps as geometry (ground-steps.ts) on synthetic scans: a flight of ten 15 cm by 35 cm steps the scan resolves
 * (counted from the scan), the same flight melted into a smooth incline (counted by Street View, else estimated), a 1:12
 * ramp, a flight with a landing, a long street on a hill and an incline under a canopy (no flight each), the replicated rebuild,
 * and the scan carved under it.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import { scanHeightIndex, frontBevelM } from '../src/node/3d-engine/staged-location/road-kerbs';
import { buildStepsMesh, measureSteps, writeStepsGlb, GROUND_STEPS_PARAMS, type FlightModel } from '../src/node/3d-engine/staged-location/ground-steps';
import { combineStepCounts, parseStepCountReply } from '../src/node/3d-engine/staged-location/step-count-streetview';
import { carveUnderRoads, prepareFootprint } from '../src/node/3d-engine/staged-location/road-carve';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-steps-'));
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

/** A scan of a height function on a triangulated grid over x0..x1, z0..z1 at `step` m, written as a textured GLB. */
function scanOf(name: string, f: (x: number, z: number) => number, x0: number, x1: number, z0: number, z1: number, step: number) {
    const nx = Math.round((x1 - x0) / step) + 1, nz = Math.round((z1 - z0) / step) + 1;
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2), idx: number[] = [];
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) { const x = x0 + i * step, z = z0 + k * step; pos.set([x, f(x, z), z], (k * nx + i) * 3); uv.set([i / (nx - 1), k / (nz - 1)], (k * nx + i) * 2); }
    for (let k = 0; k + 1 < nz; k++) for (let i = 0; i + 1 < nx; i++) { const a = k * nx + i; idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1); }
    const file = path.join(WORK, `${name}.glb`);
    const photo = jpegJs.encode({ data: Buffer.alloc(64, 128), width: 4, height: 4 }, 90).data;
    writeStagedGlbFile(file, [{ positions: pos, indices: Uint32Array.from(idx), uv }], { texture: { bytes: photo, mimeType: 'image/jpeg' } });
    const scan = loadScanMesh(file);
    return { file, scan, h: scanHeightIndex(scan, 1) };
}

const RISE = 0.15, RUN = 0.35, N = 10, TOP = RISE * N, LEN = RUN * N;
/** Ten steps up along +x from x = 0, 6 m wide (|z| < 3) between cheek walls at the top's level; a plinth at the top beyond. */
const steps = (x: number, z: number) => {
    if (x < 0) return 0;
    if (x >= LEN || Math.abs(z) > 3) return TOP;
    return RISE * Math.min(N, Math.floor(x / RUN) + 1);
};
/** The same flight as the tiles melt it: a smooth incline from foot to top. */
const melted = (x: number, z: number) => (x < 0 ? 0 : x >= LEN || Math.abs(z) > 3 ? TOP : (x / LEN) * TOP);

const only = (flights: FlightModel[]) => { expect(flights.length).toBe(1); return flights[0]; };

describe('a flight the scan resolves', () => {
    const s = scanOf('resolved', steps, -4, 8, -5, 5, 0.05);
    it('is found, its pitch measured, and counted from the scan', async () => {
        const f = only((await measureSteps(s.scan, s.h)).flights);
        expect(f.kind).toBe('steps');
        expect(f.countSource).toBe('measured');
        expect(f.count).toBe(N);
        expect(Math.abs(f.riseM! - RISE)).toBeLessThan(0.01);
        expect(Math.abs(f.runEachM! - RUN)).toBeLessThan(0.03);
        // uphill along +x, measured foot and top, 6 m wide
        expect(f.ux).toBeGreaterThan(0.95);
        expect(Math.abs(f.footY)).toBeLessThan(0.03);
        expect(Math.abs(f.topY - TOP)).toBeLessThan(0.03);
        expect(Math.abs(f.bMax - f.bMin - 6)).toBeLessThan(1);
        expect(f.countNote).toMatch(/pitch repeats/);
    });
});

describe('a flight the scan melts', () => {
    const s = scanOf('melted', melted, -4, 8, -5, 5, 0.25);
    it('is counted by Street View where a counter is given, its steps photo-inferred', async () => {
        let asked = 0;
        const f = only((await measureSteps(s.scan, s.h, { counter: async () => { asked++; return { count: N, views: 2, note: 'counts 10, 10' }; } })).flights);
        expect(asked).toBe(1);
        expect(f.kind).toBe('steps');
        expect(f.countSource).toBe('photo-inferred');
        expect(f.count).toBe(N);
        expect(Math.abs(f.riseM! - RISE)).toBeLessThan(0.01);
        expect(f.countNote).toMatch(/Street View/);
    });

    it('is estimated at a plausible rise with no count, and says so', async () => {
        const f = only((await measureSteps(s.scan, s.h, { counter: async () => ({ reason: 'no Street View pano within 45 m sees the flight' }) })).flights);
        expect(f.countSource).toBe('generated');
        expect(f.count).toBe(Math.round(TOP / GROUND_STEPS_PARAMS.estimateRiseM));
        expect(f.countNote).toMatch(/no Street View pano/);
    });
});

describe('a ramp, a landing, a street on a hill', () => {
    it('reads a 1:12 incline as a ramp through its measured slope', async () => {
        const s = scanOf('ramp', (x, z) => (x < 0 ? 0 : x >= 6 || Math.abs(z) > 1 ? 0.5 : (x / 6) * 0.5), -3, 9, -3, 3, 0.25);
        const f = only((await measureSteps(s.scan, s.h)).flights);
        expect(f.kind).toBe('ramp');
        expect(Math.abs(f.slope - 0.5 / 6)).toBeLessThan(0.01);
        expect(Math.abs(f.sTop - f.sFoot - 6)).toBeLessThan(0.3);
    });

    it('finds the landing between two runs of a melted flight', async () => {
        // five steps' rise over 1.75 m, a 1.5 m landing, five more
        const lf = (x: number, z: number) => {
            if (x < 0) return 0;
            if (Math.abs(z) > 3 || x >= 5) return 1.5;
            if (x < 1.75) return (x / 1.75) * 0.75;
            if (x < 3.25) return 0.75;
            return 0.75 + ((x - 3.25) / 1.75) * 0.75;
        };
        const s = scanOf('landing', lf, -4, 9, -5, 5, 0.25);
        const f = only((await measureSteps(s.scan, s.h)).flights);
        expect(f.landings.length).toBe(1);
        expect(Math.abs(f.landings[0].y - 0.75)).toBeLessThan(0.05);
        expect(Math.abs(f.landings[0].s1 - f.landings[0].s0 - 1.5)).toBeLessThan(0.35);
        // the rebuild puts it there, level, between the two runs
        const mesh = buildStepsMesh([f]);
        expect(mesh.parts.has('landing:measured')).toBe(true);
    });

    it('leaves an incline alone when what stands past its top is no top: a canopy over it, a rise unlike its own', async () => {
        // the melted flight, but a canopy 12 m up starts 0.3 m past its top: the scan's top surface there is the canopy, level, and
        // read as the flight's top it would make a 12 m flight of the 1.5 m incline
        const s = scanOf('canopy', (x, z) => (x >= LEN + 0.3 && x < LEN + 8 ? 12 : melted(x, z)), -3, LEN + 10, -5, 5, 0.05);
        const r = await measureSteps(s.scan, s.h);
        expect(r.inclines).toBe(1);
        expect(r.flights.length).toBe(0);
        expect(r.refused[0].reason).toMatch(/rise as the incline itself does/);
    });

    it('leaves a long street on a hill alone (the road\'s own)', async () => {
        const s = scanOf('hill', x => 0.08 * x, -30, 30, -4, 4, 0.5);
        const r = await measureSteps(s.scan, s.h);
        expect(r.flights.length).toBe(0);
        expect(r.refused.length).toBeGreaterThan(0);
    });
});

describe('the rebuild and the carve', () => {
    const s = scanOf('melted2', melted, -4, 8, -5, 5, 0.25);
    it('repeats one step profile at the pitch: risers face downhill, treads up, the nosing by the bevel rule', async () => {
        const f = only((await measureSteps(s.scan, s.h, { counter: async () => ({ count: N, views: 1, note: 'stub' }) })).flights);
        const mesh = buildStepsMesh([f]);
        const risers = mesh.parts.get('riser:photo-inferred')!, treads = mesh.parts.get('tread:photo-inferred')!;
        expect(risers.indices.length / 6).toBe(N);
        expect(mesh.stats.steps).toBe(N);
        const tri = (p: { positions: Float32Array; indices: Uint32Array }, t: number) => {
            const v = (i: number) => [p.positions[p.indices[t + i] * 3], p.positions[p.indices[t + i] * 3 + 1], p.positions[p.indices[t + i] * 3 + 2]];
            const [a, b, c] = [v(0), v(1), v(2)], u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        };
        for (let t = 0; t < risers.indices.length; t += 3) expect(tri(risers, t)[0]).toBeLessThan(0);
        for (let t = 0; t < treads.indices.length; t += 3) expect(tri(treads, t)[1]).toBeGreaterThan(0);
        // the treads at the foot level plus a whole number of rises
        const ys = new Set<number>();
        for (let i = 1; i < treads.positions.length; i += 3) ys.add(Math.round((treads.positions[i] - f.footY) / f.riseM! * 1000) / 1000);
        for (const y of ys) expect(Math.abs(y - Math.round(y))).toBeLessThan(1e-3);
        // the nosing: 1.5 % of the flight's smallest dimension (its rise, 1.5 m), clamped to 1-5 cm
        const nos = mesh.parts.get('nosing:generated')!;
        let dy = 0;
        for (let t = 0; t < nos.indices.length; t += 3) { const ys3 = [0, 1, 2].map(k => nos.positions[nos.indices[t + k] * 3 + 1]); dy = Math.max(dy, Math.max(...ys3) - Math.min(...ys3)); }
        expect(Math.abs(dy - frontBevelM(Math.min(f.topY - f.footY, f.sTop - f.sFoot, f.bMax - f.bMin)))).toBeLessThan(1e-4);
        // labels on every node
        const file = path.join(WORK, 'steps.glb');
        writeStepsGlb(file, mesh, { flights: 1 });
        const g = parseGlbBytes(fs.readFileSync(file));
        expect(g.json.nodes.find((n: any) => n.name === 'riser_photo-inferred').extras.method).toMatch(/Street View/);
        expect(g.json.nodes.find((n: any) => n.name === 'nosing_generated').extras.provenance).toBe('generated');
    });

    it('carves the melted incline under the flight, its rim set onto the flight\'s outline', async () => {
        const f = only((await measureSteps(s.scan, s.h, { counter: async () => ({ count: N, views: 1, note: 'stub' }) })).flights);
        const mesh = buildStepsMesh([f]);
        const { glb, report } = carveUnderRoads(fs.readFileSync(s.file), prepareFootprint(mesh.footprint));
        expect(report.removed).toBeGreaterThan(100);
        expect(report.pinned).toBeGreaterThan(10);
        // no triangle of the melted incline is left inside the flight's plan
        const g = parseGlbBytes(glb);
        let inside = 0;
        for (const m of g.json.meshes) for (const p of m.primitives) {
            const X = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
            for (let t = 0; t < I.length; t += 3) {
                if (I[t] === I[t + 1] || I[t + 1] === I[t + 2] || I[t] === I[t + 2]) continue;
                const cx = (X[I[t] * 3] + X[I[t + 1] * 3] + X[I[t + 2] * 3]) / 3, cz = (X[I[t] * 3 + 2] + X[I[t + 1] * 3 + 2] + X[I[t + 2] * 3 + 2]) / 3;
                if (cx > 0.2 && cx < LEN - 0.2 && Math.abs(cz) < 2.5) inside++;
            }
        }
        expect(inside).toBe(0);
    });
});

describe('the Street View count', () => {
    it('reads the model\'s reply and combines the views', () => {
        expect(parseStepCountReply('{"risers": 12, "confidence": 0.8}')).toEqual({ risers: 12, confidence: 0.8 });
        expect(parseStepCountReply('```json\n{"risers": null}\n```')).toEqual({});
        expect(parseStepCountReply('no json')).toEqual({});
        expect(combineStepCounts([12])).toBe(12);
        expect(combineStepCounts([12, 13])).toBe(13);
        expect(combineStepCounts([9, 13])).toBeUndefined();
        expect(combineStepCounts([9, 12, 13])).toBe(12);
        expect(combineStepCounts([])).toBeUndefined();
    });
});
