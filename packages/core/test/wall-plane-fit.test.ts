/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Plane-first walls (wall-plane-fit.ts) on synthetic scans: a facade that is a field of lumpy facets about one plane is fitted
 * as that plane and snapped flat (no relief); a real 1 m deep, 4 m wide recess in it is kept at its measured box and depth; a
 * setback along one footprint edge splits it into two planes and a return; the scan's lumps on a fitted wall are dropped
 * from the residual while a canopy reaching well out stays.
 */

import { describe, expect, it } from 'vitest';
import { dropWallBandResidual, findSteps, fitWallPlane, planeFirstMassing, wallSampleIndex, WALL_FIT_PARAMS, type PlaneFirstWall } from '../src/node/3d-engine/staged-location/wall-plane-fit';
import { inLoops } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';
import { massingSpecText, type Massing } from '../src/node/3d-engine/staged-location/pipeline-e/massing-spec';
import { runMassing } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A facade on the plane x = depth(z, y) (outward +x), z in [z0, z1], y in [0, h], as a triangulated grid of `step` m whose
 * every vertex is pushed along x by uniform noise of +-noise and by a few lumps (smooth bumps of +-lump m, 1 m across).
 */
function facade(opts: { z0: number; z1: number; h: number; depth: (z: number, y: number) => number; noise: number; lump: number; seed: number; step?: number }) {
    const rnd = lcg(opts.seed);
    const step = opts.step ?? 0.6;
    const nz = Math.round((opts.z1 - opts.z0) / step), ny = Math.round(opts.h / step);
    const lumps = Array.from({ length: Math.round(((opts.z1 - opts.z0) * opts.h) / 12) }, () => ({ z: opts.z0 + rnd() * (opts.z1 - opts.z0), y: rnd() * opts.h, a: (rnd() * 2 - 1) * opts.lump }));
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nz; i++) {
        const z = opts.z0 + i * step, y = j * step;
        let x = opts.depth(z, y) + (rnd() * 2 - 1) * opts.noise;
        for (const l of lumps) x += l.a * Math.exp(-((z - l.z) ** 2 + (y - l.y) ** 2) / 0.5);
        positions.push(x, y, z);
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nz; i++) {
        const a = j * (nz + 1) + i, b = a + 1, c = a + nz + 1, d = c + 1;
        indices.push(a, b, d, a, d, c);
    }
    return { positions, indices };
}

function merge(...meshes: Array<{ positions: number[]; indices: number[] }>) {
    const positions: number[] = [], indices: number[] = [];
    for (const m of meshes) { const o = positions.length / 3; positions.push(...m.positions); indices.push(...m.indices.map(i => i + o)); }
    return { positions, indices };
}

// the wall under test: the footprint edge along x = 0 from z 0 to z 20 (the building at x < 0, outward +x), 15 m tall
const wall = { a: [0, 0] as Vec2, b: [0, 20] as Vec2, outward: [1, 0] as Vec2, baseY: 0, topY: 15 };

describe('fitWallPlane', () => {
    it('fits a lumpy, faceted facade as one plane at its measured depth and snaps the lumps flat', () => {
        const scan = facade({ z0: -1, z1: 21, h: 16, depth: () => 0.8, noise: 0.15, lump: 0.35, seed: 7 });
        const ix = wallSampleIndex(scan.positions, scan.indices);
        const fit = fitWallPlane(wall, ix);
        expect(fit.status).toBe('measured');
        expect(fit.offsetM).toBeGreaterThan(0.65);
        expect(fit.offsetM).toBeLessThan(0.95);
        expect(Math.abs(fit.yawDeg)).toBeLessThan(0.5);
        expect(fit.coverage).toBeGreaterThan(0.9);
        // the lumps are the facade's roughness about the plane, reported, never relief
        expect(fit.relief).toEqual([]);
        expect(fit.rmsM).toBeGreaterThan(0.05);
        expect(fit.rmsM).toBeLessThan(0.35);
        expect(fit.topYMeasured).toBeGreaterThan(14);
    });

    it('keeps a real 1 m deep, 4 m wide recess at its box and depth, and nothing else', () => {
        // the recess: z 8 to 12, y 3 to 9, 1 m behind the facade
        const inRecess = (z: number, y: number) => z >= 8 && z <= 12 && y >= 3 && y <= 9;
        const scan = facade({ z0: -1, z1: 21, h: 16, depth: (z, y) => 0.8 - (inRecess(z, y) ? 1 : 0), noise: 0.15, lump: 0.35, seed: 11, step: 0.4 });
        const ix = wallSampleIndex(scan.positions, scan.indices);
        const fit = fitWallPlane(wall, ix);
        expect(fit.status).toBe('measured');
        expect(fit.offsetM).toBeGreaterThan(0.65);
        expect(fit.offsetM).toBeLessThan(0.95);
        expect(fit.relief).toHaveLength(1);
        const q = fit.relief[0];
        expect(q.depthM).toBeLessThan(-0.8);
        expect(q.depthM).toBeGreaterThan(-1.2);
        expect(q.s0).toBeGreaterThan(7.2); expect(q.s0).toBeLessThan(8.8);
        expect(q.s1).toBeGreaterThan(11.2); expect(q.s1).toBeLessThan(12.8);
        expect(q.t0).toBeGreaterThan(2.2); expect(q.t0).toBeLessThan(3.8);
        expect(q.t1).toBeGreaterThan(8.2); expect(q.t1).toBeLessThan(9.8);
        // the plane with its relief explains the facade to its noise
        expect(fit.rmsWithReliefM).toBeLessThan(0.4);
    });

    it('leaves a wall the scan does not see on its vector edge, and says so', () => {
        const scan = facade({ z0: 40, z1: 60, h: 16, depth: () => 0, noise: 0.1, lump: 0, seed: 3 });
        const fit = fitWallPlane(wall, wallSampleIndex(scan.positions, scan.indices));
        expect(fit.status).toBe('unseen');
        expect(fit.offsetM).toBe(0);
        expect(fit.reason).toMatch(/sees 0% of the wall/);
    });

    it('places a wall with no clean plane at the median depth of what the scan shows, labelled an estimate', () => {
        // a facade scattered over 3 m of depth: no plane holds 30% of it
        const rnd = lcg(5);
        const scan = facade({ z0: -1, z1: 21, h: 16, depth: () => 0, noise: 0, lump: 0, seed: 1, step: 0.5 });
        for (let v = 0; v < scan.positions.length; v += 3) scan.positions[v] = -1.5 + rnd() * 3;
        const fit = fitWallPlane(wall, wallSampleIndex(scan.positions, scan.indices), { ...WALL_FIT_PARAMS });
        expect(fit.status).toBe('estimated');
        expect(fit.reason).toMatch(/no clean plane/);
        expect(Math.abs(fit.offsetM)).toBeLessThan(0.75);
        expect(fit.relief).toEqual([]);
    });
});

describe('planeFirstMassing', () => {
    // a 20 x 12 m block, its footprint x in [-12, 0], z in [0, 20]; the scan's east facade (x = 0 edge) stands 0.8 m out with
    // a recess, the other three facades on their edges
    const loop: Vec2[] = [[-12, 0], [0, 0], [0, 20], [-12, 20]];
    const part = { id: 'b/e0', loops: [loop], baseY: 0, topY: 15 };
    const inRecess = (z: number, y: number) => z >= 8 && z <= 12 && y >= 3 && y <= 9;
    const east = facade({ z0: 0, z1: 20, h: 15, depth: (z, y) => 0.8 - (inRecess(z, y) ? 1 : 0), noise: 0.12, lump: 0.3, seed: 21, step: 0.4 });
    // the other facades: the same generator, rotated into place
    const rot = (m: { positions: number[]; indices: number[] }, f: (x: number, y: number, z: number) => [number, number, number]) => {
        const p: number[] = [];
        for (let v = 0; v < m.positions.length; v += 3) p.push(...f(m.positions[v], m.positions[v + 1], m.positions[v + 2]));
        return { positions: p, indices: m.indices };
    };
    const west = rot(facade({ z0: 0, z1: 20, h: 15, depth: () => 0, noise: 0.12, lump: 0.3, seed: 22 }), (x, y, z) => [-12 - x, y, z]);
    const north = rot(facade({ z0: -12, z1: 0, h: 15, depth: () => 0, noise: 0.12, lump: 0.3, seed: 23 }), (x, y, z) => [z, y, -x]);
    const south = rot(facade({ z0: -12, z1: 0, h: 15, depth: () => 0, noise: 0.12, lump: 0.3, seed: 24 }), (x, y, z) => [z, y, 20 + x]);
    const scan = merge(east, west, north, south);
    const ix = wallSampleIndex(scan.positions, scan.indices);
    const inside = (p: typeof part, x: number, z: number) => inLoops(x, z, p.loops);

    it('moves the east wall onto its measured plane, keeps the others on their edges, and hands the recess to the native tool', () => {
        const pf = planeFirstMassing([part], ix, inside);
        const out = pf.parts[0].loops[0];
        expect(out).toHaveLength(4);
        // the east corners moved out by about 0.8 m, the west ones stayed
        expect(out[1][0]).toBeGreaterThan(0.6); expect(out[1][0]).toBeLessThan(1.0);
        expect(out[2][0]).toBeGreaterThan(0.6); expect(out[2][0]).toBeLessThan(1.0);
        expect(Math.abs(out[0][0] + 12)).toBeLessThan(0.25);
        expect(Math.abs(out[3][0] + 12)).toBeLessThan(0.25);
        expect(pf.walls.filter(w => w.fit.status === 'measured')).toHaveLength(4);
        const eastWall = pf.walls.find(w => w.edge === 1)!;
        expect(eastWall.key).toBe('w:b/e0:0:1');
        expect(pf.openings).toHaveLength(1);
        expect(pf.faceSweeps).toHaveLength(0);
        const o = pf.openings[0];
        expect(o.face).toBe(eastWall.key);
        expect(o.depth).toBeGreaterThan(0.8); expect(o.depth).toBeLessThan(1.2);
        expect(o.s1 - o.s0).toBeGreaterThan(3.2); expect(o.s1 - o.s0).toBeLessThan(4.8);
        expect(o.scanned).toBe(false);
        expect(eastWall.reliefIds).toEqual([o.id]);
        expect(pf.summary.recesses).toBe(1);
    });

    it('splits an edge the scan steps along into two planes joined by a return', () => {
        // the east facade: z 0 to 9 on the edge, z 9 to 20 set back 2.5 m, over its whole height
        const stepped = facade({ z0: 0, z1: 20, h: 15, depth: z => (z < 9 ? 0 : -2.5), noise: 0.1, lump: 0.25, seed: 31, step: 0.4 });
        const ix2 = wallSampleIndex([...stepped.positions, ...west.positions, ...north.positions, ...south.positions], [...stepped.indices, ...west.indices.map(i => i + stepped.positions.length / 3), ...north.indices.map(i => i + (stepped.positions.length + west.positions.length) / 3), ...south.indices.map(i => i + (stepped.positions.length + west.positions.length + north.positions.length) / 3)]);
        const whole = fitWallPlane({ a: [0, 0], b: [0, 20], outward: [1, 0], baseY: 0, topY: 15 }, ix2, WALL_FIT_PARAMS, undefined, { keepResidual: true });
        const steps = findSteps(whole, 0, 15);
        expect(steps).toHaveLength(1);
        const pf = planeFirstMassing([part], ix2, inside);
        const out = pf.parts[0].loops[0];
        expect(out).toHaveLength(6);
        const step = pf.walls.filter(w => w.fit.status === 'step');
        expect(step).toHaveLength(1);
        // the return stands about where the scan steps, and spans the 2.5 m between the two planes
        const r = step[0];
        expect(Math.abs((r.a[1] + r.b[1]) / 2 - 9)).toBeLessThan(1.2);
        expect(Math.abs(Math.abs(r.a[0] - r.b[0]) - 2.5)).toBeLessThan(0.4);
        expect(pf.summary.steps).toBe(1);
    });

    it('drops the scan lumps standing on a fitted wall from the residual and keeps a canopy reaching well out', () => {
        const pf = planeFirstMassing([part], ix, inside);
        const node = (tris: number[][][]) => ({ kind: 'residual', positions: Float32Array.from(tris.flat(2)), indices: Uint32Array.from(tris.flatMap((_, t) => [t * 3, t * 3 + 1, t * 3 + 2])), normals: new Float32Array(tris.length * 9) });
        // a lumpy patch 0.6 to 1.6 m in front of the east wall (two triangles sharing an edge)
        const lump = node([[[1.4, 4, 5], [1.6, 4, 7], [1.5, 6, 6]], [[1.6, 4, 7], [1.5, 6, 6], [1.7, 6, 8]]]);
        // a canopy 0.5 to 6 m out from the east wall at 4 m (most of its area beyond the band)
        const canopy = node([[[0.9, 4, 2], [7, 4, 2], [7, 4, 6]], [[0.9, 4, 2], [7, 4, 6], [0.9, 4, 6]]]);
        const wallNode = { kind: 'wall', positions: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), normals: new Float32Array(9) };
        const res = dropWallBandResidual([lump, canopy, wallNode], pf.walls as PlaneFirstWall[]);
        expect(res.removedTriangles).toBe(2);
        expect(res.keptTriangles).toBe(2);
        expect(res.nodes).toHaveLength(2);
        expect(res.nodes.find(n => n.kind === 'residual')!.indices.length).toBe(6);
        expect(res.nodes.find(n => n.kind === 'residual')!.normals.length).toBe(canopy.normals.length);
    });
});

describe('relief on a wall another part splits (native, clipOpenings)', () => {
    // part a: 10 x 20 m, 12 m tall; part b: a 4 m annex against a's east wall from z 5 to z 8, which splits that wall in
    // three pieces, the middle one standing only above the annex
    const m: Pick<Massing, 'parts' | 'meshes'> = {
        parts: [
            { id: 'a', baseY: 0, topY: 12, loops: [[[0, 0], [10, 0], [10, 20], [0, 20]]], planes: [], heightSource: 'vector', heights: {} },
            { id: 'b', baseY: 0, topY: 4, loops: [[[10, 5], [16, 5], [16, 8], [10, 8]]], planes: [], heightSource: 'vector', heights: {} }
        ],
        meshes: []
    };
    // the east wall's frame: outward +x, s = -z from the edge's start at z 0; a recess and a projection from z 2 to z 14
    const items = {
        openings: [{ id: 'r', face: 'w:a:0:1', s0: -14, s1: -2, t0: 1, t1: 10, depth: 1, scanned: false, confidence: 0.8, provenance: 'plane-relief-measured' }],
        faceSweeps: [{ id: 'p', confidence: 0.8, provenance: 'plane-relief-measured', face: 'w:a:0:1', axis: 0 as const, profile: [[0.8, 1], [0.8, 10]] as Array<[number, number]>, placements: [[-14, -2, 0]] as Array<[number, number, number]> }]
    };
    const run = async (clip: number, which: 'openings' | 'faceSweeps') => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-clip-'));
        return runMassing(massingSpecText(m, { outDir: dir, params: { bake: 0, sections: 0, topdown: 0, residual: 0, clipOpenings: clip }, [which]: items[which] }), dir);
    };

    it('without clipping keeps the recess only on the pieces it fits, and clips it to every piece with it (above the annex in the middle)', async () => {
        // without clipOpenings the recess straddling the cuts is still split onto the pieces (af61b79e), but the middle
        // copy reaching below that piece's bottom (the annex roof) is rejected rather than cut into the annex
        const off = await run(0, 'openings');
        expect(off.report.rejectedOpenings).toEqual(['r:1']);
        expect(off.report.rejectedOpeningReasons?.['r:1']).toBe("below the wall's bottom");
        expect(off.report.faces.filter(f => f.openings.length).map(f => f.key).sort()).toEqual(['w:a:0:1:0', 'w:a:0:1:2']);
        const on = await run(1, 'openings');
        expect(on.report.rejectedOpenings).toEqual([]);
        const hosts = on.report.faces.filter(f => f.openings.length).map(f => f.key).sort();
        expect(hosts).toEqual(['w:a:0:1:0', 'w:a:0:1:1', 'w:a:0:1:2']);
        expect(on.nodes.filter(n => n.kind === 'opening').map(n => n.name.replace(/:\d+$/, '')).every(n => /^opening:r(:\d+)?/.test(n))).toBe(true);
        // the middle piece's recess starts above the annex's roof
        const mid = on.nodes.filter(n => n.kind === 'opening' && /:1$/.test(n.name));
        const ys = mid.flatMap(n => Array.from(n.positions).filter((_, i) => i % 3 === 1));
        expect(Math.min(...ys)).toBeGreaterThan(3.99);
    });

    it('clips a projection to every piece too, never into the annex', async () => {
        const on = await run(1, 'faceSweeps');
        expect(on.report.rejectedSweeps).toEqual([]);
        const sweeps = on.nodes.filter(n => n.kind === 'sweep');
        expect(sweeps).toHaveLength(3);
        for (const n of sweeps) {
            const P = Array.from(n.positions);
            const zs = P.filter((_, i) => i % 3 === 2), ys = P.filter((_, i) => i % 3 === 1);
            // the piece in front of the annex (z 5 to 8) starts at the annex's roof
            if (Math.min(...zs) >= 4.9 && Math.max(...zs) <= 8.1) expect(Math.min(...ys)).toBeGreaterThan(3.99);
        }
        const xs = sweeps.flatMap(n => Array.from(n.positions).filter((_, i) => i % 3 === 0));
        expect(Math.max(...xs)).toBeCloseTo(10.8, 3);
    });
});
