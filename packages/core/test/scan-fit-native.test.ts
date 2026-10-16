/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan fitter (scratchbox_scan_fit.hpp behind scripts/scan_fit.cpp, compiled with clang++ and run through ScanFitService):
 *
 * - six synthetic scans with known truth (segmental arch, three-bay arcade, L plan with a cornice band, triangular plan, two
 *   blocks around a plaza, a block with a tree crown against it) fit within centimetres of the truth they were built from;
 * - the real Washington Square Arch, as tile_refine isolates it (skipped, with a reason, when the tile data is absent);
 * - a refit by parameter index keeps every id, labels the corrected primitive photo-corrected and moves the geometry;
 * - the same scan in two caches gives the same bytes; a second call is a cache hit; an unreadable scan fails the same way twice;
 * - flatten moves wall vertices onto their planes (within a millimetre) and no vertex further than its band.
 *
 * Every suite writes clay renders of the fit over the scan to test-results/screenshots/staged/ (gitignored) and asserts they
 * are not blank.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitError, ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { validateContract, type StructureFit } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';
import { writeGlb } from './helpers/synthetic-scan-glb';
import { findArchData } from './helpers/real-arch-data';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { saveClayShot } from './helpers/staged-shots';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };

let work: string;
let svc: ScanFitService;
const scenes: Record<string, S.SyntheticScan> = {};

const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = (f: string) => path.relative(work, f);

async function fit(scan: S.SyntheticScan, anchor = scan.anchor): Promise<StructureFit> {
    const r = await svc.fit({ scanGlb: rel(scan.glb), anchor: { x: anchor[0], z: anchor[1] }, sourceLimits: LIMITS });
    return r.value;
}

/** A primitive's fitParams by index. */
const param = (p: StructureFit['primitives'][number], i: number) => p.fitParams.find(f => f.index === i)!.value;

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fit-native-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
    fs.mkdirSync(path.join(work, 'scenes'));
    const dir = path.join(work, 'scenes');
    for (const sc of [S.segmentalArch(dir), S.arcade(dir), S.lPlan(dir), S.triangle(dir), S.plaza(dir), S.treeTouching(dir)]) scenes[path.basename(sc.glb, '.glb').replace('synthetic_', '')] = sc;
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('scan_fit on synthetic scans with known truth', () => {
    it('recovers a segmental arch: span, springing, rise, depth and the piers, and publishes the parameter that photos may correct', async () => {
        const sc = scenes.arch;
        const r = await svc.fit({ scanGlb: rel(sc.glb), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS });
        const f = r.value;
        expect(validateContract('StructureFit', f)).toEqual([]);
        expect(f.accepted).toBe(true);
        const body = f.primitives.find(p => p.fitParams.length === 7)!;
        expect(body).toBeDefined();
        expect(param(body, 0)).toBeCloseTo(8.0, 1);                     // span, within 5 cm
        expect(Math.abs(param(body, 1) - 8.0)).toBeLessThan(0.12);       // springing height
        expect(Math.abs(param(body, 2) - 3.0)).toBeLessThan(0.12);       // rise
        expect(Math.abs(param(body, 4) - 5.0)).toBeLessThan(0.06);       // depth along the passage
        expect(Math.abs(param(body, 6) - 0.375)).toBeLessThan(0.02);     // rise over span
        // the plan: 14.4 x 5. The passage is open at both ends, so it is no hole in it: the roof over the opening is in the footprint
        expect(f.footprint.areaM2).toBeCloseTo(72, 0);
        expect(f.footprint.holes ?? []).toHaveLength(0);
        // photos may move the arch's rise/span within the scan's own residual curve: it includes a semicircle (0.5) here
        const c = body.correctable.find(x => x.param === 6)!;
        expect(c.min).toBeLessThanOrEqual(0.375);
        expect(c.max).toBeGreaterThanOrEqual(0.5);
        expect(c.residualCurve.length).toBeGreaterThan(30);
        expect(c.toleranceM).toBeLessThanOrEqual(0.31 + 1e-9);
        // the metrics and the gates
        expect(f.metrics.scanToFit.rmsM).toBeLessThan(0.04);
        expect(f.metrics.fitToScan.rmsM).toBeLessThan(0.04);
        expect(f.metrics.coverage).toBeGreaterThan(0.9);
        expect(f.gates.every(g => g.passed)).toBe(true);
        // the alternatives the fit weighed are recorded with their residual
        expect(body.alternatives.length).toBeGreaterThanOrEqual(1);
        // every face has a support fraction, and a rebuild the scan backs everywhere has no unobserved face
        for (const s of f.surfaces) { expect(s.supportFraction).toBeGreaterThanOrEqual(0); expect(s.supportFraction).toBeLessThanOrEqual(1); }
        expect(f.surfaces.filter(s => s.visibleFraction > 0.3 && s.supportFraction < 0.5)).toHaveLength(0);
        // the fit's own time, measured
        expect(Object.values(f.timingsMs).reduce((a, b) => a + b, 0)).toBeLessThan(1500);
        // slots carry stable ids and bounds from their hosts
        expect(f.slots.length).toBeGreaterThan(3);
        expect(f.slots.some(s => 'edge' in s.host)).toBe(true);
        const shot = saveClayShot('scan_fit_synthetic_arch', [{ file: sc.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 215, elevationDeg: 20 });
        expect(shot.covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('recovers an L plan with a cornice band: the plan, each band\'s heights and the projecting band\'s plan', async () => {
        const f = await fit(scenes.lplan);
        expect(f.accepted).toBe(true);
        const bands = f.primitives.filter(p => p.fitParams.length === 3).sort((a, b) => param(a, 0) - param(b, 0));
        expect(bands).toHaveLength(3);
        // [y0, y1, plan area]: the body to the cornice's underside (9 m), the cornice (9 to 9.4 m, the plan grown 0.8 m), the upper body
        expect(param(bands[0], 0)).toBeCloseTo(0, 1);
        expect(Math.abs(param(bands[0], 1) - 9.0)).toBeLessThan(0.05);
        expect(Math.abs(param(bands[1], 1) - 9.4)).toBeLessThan(0.05);
        expect(Math.abs(param(bands[2], 1) - 14.0)).toBeLessThan(0.07);
        expect(Math.abs(param(bands[0], 2) - 300)).toBeLessThan(3);
        expect(Math.abs(param(bands[2], 2) - 300)).toBeLessThan(3);
        // the cornice band's plan is larger by the projection all round: 0.8 m on every side of the 300 m2 L (366.6 m2 by hand)
        expect(param(bands[1], 2)).toBeGreaterThan(355);
        expect(param(bands[1], 2)).toBeLessThan(375);
        // the L's footprint has six vertices (a bulge segment would make it more)
        expect(f.footprint.outer.length).toBeGreaterThanOrEqual(6);
        expect(f.footprint.areaM2).toBeCloseTo(300, -1);
        expect(saveClayShot('scan_fit_synthetic_lplan', [{ file: scenes.lplan.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 200, elevationDeg: 25 }).covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('recovers a triangular plan, where no wall stands at a right angle to another', async () => {
        const f = await fit(scenes.triangle);
        expect(f.accepted).toBe(true);
        const body = f.primitives[0];
        expect(Math.abs(param(body, 1) - 11)).toBeLessThan(0.1);
        expect(Math.abs(param(body, 2) - (scenes.triangle.truth.areaM2 as number))).toBeLessThan(2);
        // three walls, so three side faces and a roof
        expect(f.surfaces.filter(s => 'plane' in s.chart && Math.abs(s.chart.plane.normal[1]) < 0.1)).toHaveLength(3);
        expect(saveClayShot('scan_fit_synthetic_triangle', [{ file: scenes.triangle.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 200, elevationDeg: 25 }).covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('groups the columns of an arcade at an equal pitch into one replicated primitive (operator 3 over operator 2)', async () => {
        const f = await fit(scenes.arcade);
        expect(f.accepted).toBe(true);
        const rep = f.primitives.find(p => (p.spec as any).operator === 'replicate')!;
        expect(rep).toBeDefined();
        const along = (rep.spec as any).replicate.domain.along;
        expect(along.count).toBe(4);
        expect(Math.abs(along.pitchM - 3.6)).toBeLessThan(0.05);
        const seed = (rep.spec as any).replicate.seed;
        expect(seed.operator).toBe('revolve');
        expect(seed.revolve.lobes).toBe(0);
        const radii = seed.revolve.profile.map((q: number[]) => q[0]);
        expect(Math.abs(Math.max(...radii) - 0.45)).toBeLessThan(0.03);
        expect(rep.surfaceIds).toHaveLength(4);
        expect(f.primitives.filter(p => (p.spec as any).operator === 'revolve')).toHaveLength(0);
        // the slab over them is a band of its own: 5.0 to 5.6 m
        const slab = f.primitives.find(p => p.fitParams.length === 3)!;
        expect(Math.abs(param(slab, 0) - 5.0)).toBeLessThan(0.08);
        expect(Math.abs(param(slab, 1) - 5.6)).toBeLessThan(0.08);
        expect(saveClayShot('scan_fit_synthetic_arcade', [{ file: scenes.arcade.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 200, elevationDeg: 22 }).covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('fits the block nearest the anchor in a scan that holds two, and says which it left out', async () => {
        // the geocoded point stands in the plaza; the probe's seed is the east block's own cell
        const east = await fit(scenes.plaza, [10.5, 0]);
        expect(east.accepted).toBe(true);
        expect(Math.abs(param(east.primitives[0], 1) - 12)).toBeLessThan(0.1);
        expect(Math.abs(param(east.primitives[0], 2) - 168)).toBeLessThan(2);
        expect(east.input.anchor).toEqual([10.5, 0]);
        // anchored in the west block it is the other one
        const west = await fit(scenes.plaza, [-9, 0]);
        expect(Math.abs(param(west.primitives[0], 1) - 18)).toBeLessThan(0.1);
        expect(Math.abs(param(west.primitives[0], 2) - 256)).toBeLessThan(3);
        expect(east.buildingId).not.toBe(west.buildingId);
        expect(saveClayShot('scan_fit_synthetic_plaza_east', [{ file: scenes.plaza.glb, color: [0.7, 0.72, 0.75] }, { file: east.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 200, elevationDeg: 25 }).covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('keeps a tree crown against the wall out of the footprint', async () => {
        const f = await fit(scenes.tree);
        expect(f.accepted).toBe(true);
        expect(Math.abs(param(f.primitives[0], 2) - 140)).toBeLessThan(4);
        expect(Math.abs(param(f.primitives[0], 1) - 10)).toBeLessThan(0.1);
        expect(saveClayShot('scan_fit_synthetic_tree', [{ file: scenes.tree.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 120, elevationDeg: 25 }).covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('a refit by parameter index keeps every id, labels the corrected primitive photo-corrected, and moves the geometry', async () => {
        const sc = scenes.arch;
        const orig = await svc.fit({ scanGlb: rel(sc.glb), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS });
        const body = orig.value.primitives.find(p => p.fitParams.length === 7)!;
        const re = await svc.refit({ fitPath: rel(orig.path), scanGlb: rel(sc.glb), set: [{ primitiveId: body.id, param: 6, value: 0.5 }] });
        const f = re.value;
        expect(validateContract('StructureFit', f)).toEqual([]);
        expect(f.primitives.map(p => p.id)).toEqual(orig.value.primitives.map(p => p.id));
        expect(f.surfaces.map(s => s.id)).toEqual(orig.value.surfaces.map(s => s.id));
        expect(f.slots.map(s => s.id)).toEqual(orig.value.slots.map(s => s.id));
        const moved = f.primitives.find(p => p.id === body.id)!;
        expect(moved.provenance.label).toBe('photo-corrected');
        expect(moved.provenance.measuredGeometry).toBe(false);
        expect(param(moved, 6)).toBeCloseTo(0.5, 6);
        expect(param(moved, 2)).toBeGreaterThan(param(body, 2) + 0.5);       // the arch rose from 3.0 m to a semicircle's 4.0 m
        expect(f.input.refitOf).toMatch(/^[0-9a-f]{64}$/);
        // the others are as they were
        for (const p of f.primitives.filter(q => q.id !== body.id)) expect(p.provenance.label).not.toBe('photo-corrected');
        // the geometry moved: the fitted surfaces differ
        expect(sha(f.outputs.fittedGlb)).not.toBe(sha(orig.value.outputs.fittedGlb));
        // an override for a parameter or a primitive the fit does not have is refused, not ignored
        await expect(svc.refit({ fitPath: rel(orig.path), scanGlb: rel(sc.glb), set: [{ primitiveId: 'p99', param: 6, value: 0.5 }] })).rejects.toBeInstanceOf(ScanFitError);
        await expect(svc.refit({ fitPath: rel(orig.path), scanGlb: rel(sc.glb), set: [{ primitiveId: body.id, param: 0, value: 9 }] })).rejects.toBeInstanceOf(ScanFitError);
        const shot = saveClayShot('scan_fit_synthetic_arch_refit', [{ file: sc.glb, color: [0.7, 0.72, 0.75] }, { file: f.outputs.fittedGlb, color: [0.3, 0.6, 0.9] }], { bearingDeg: 215, elevationDeg: 20 });
        expect(shot.covered).toBeGreaterThan(0.03);
    }, 300_000);

    it('is deterministic, hits its cache, and a scan with no structure fails the same way twice', async () => {
        const sc = scenes.lplan;
        const a = await svc.fit({ scanGlb: rel(sc.glb), anchor: { x: 5, z: 0 }, sourceLimits: LIMITS });
        const again = await svc.fit({ scanGlb: rel(sc.glb), anchor: { x: 5, z: 0 }, sourceLimits: LIMITS });
        expect(again.cached).toBe(true);
        expect(again.key).toBe(a.key);
        // the same scan in a second workspace (its own cache) gives the same bytes
        const work2 = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fit-native-2-')));
        try {
            fs.copyFileSync(sc.glb, path.join(work2, 'scan.glb'));
            const second = await new ScanFitService({ workspaceRoot: work2, repoRoot: REPO }).fit({ scanGlb: 'scan.glb', anchor: { x: 5, z: 0 }, sourceLimits: LIMITS });
            expect(second.cached).toBe(false);
            expect(sha(second.value.outputs.fittedGlb)).toBe(sha(a.value.outputs.fittedGlb));
            expect(sha(second.value.outputs.outlinesGlb)).toBe(sha(a.value.outputs.outlinesGlb));
            const strip = (x: StructureFit) => JSON.stringify({ ...x, timingsMs: 0, outputs: 0, input: { ...x.input, scanSource: 0 } });
            expect(strip(second.value)).toBe(strip(a.value));
        } finally {
            fs.rmSync(work2, { recursive: true, force: true });
        }
        // only ground: no structure, not transient, and the second call does not run the binary
        const flat = path.join(work, 'scenes', 'only_ground.glb');
        writeGlb(flat, [{ positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10], indices: [0, 2, 1, 0, 3, 2] }]);
        const err1 = await svc.fit({ scanGlb: rel(flat), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS }).catch(e => e);
        expect(err1).toBeInstanceOf(ScanFitError);
        expect(err1.code).toBe('no_structure');
        expect(err1.transient).toBe(false);
        const t0 = Date.now();
        const err2 = await svc.fit({ scanGlb: rel(flat), anchor: { x: 0, z: 0 }, sourceLimits: LIMITS }).catch(e => e);
        expect(err2.code).toBe('no_structure');
        expect(Date.now() - t0).toBeLessThan(200);
    }, 300_000);

    it('stops a run it is told to stop, and says so', async () => {
        const ac = new AbortController();
        ac.abort();
        const err = await svc.fit({ scanGlb: rel(scenes.arch.glb), anchor: { x: 0, z: 1 }, sourceLimits: LIMITS, signal: ac.signal }).catch(e => e);
        expect(err).toBeInstanceOf(ScanFitError);
        expect(err.code).toBe('aborted');
        expect(err.transient).toBe(true);
    });
});

describe('scan_fit flatten', () => {
    it('moves wall vertices onto their planes (within a millimetre) and no vertex further than its band', async () => {
        const sc = scenes.tree;
        const r = await svc.flatten({ inputGlb: rel(sc.glb), bandM: 0.1 });
        expect(validateContract('FlattenStats', r.value)).toEqual([]);
        expect(r.value.movedVertices).toBeGreaterThan(5);
        expect(r.value.maxMoveM).toBeLessThanOrEqual(0.1 + 1e-6);
        expect(r.value.p95MoveM).toBeLessThanOrEqual(r.value.maxMoveM);
        const before = readGlbTriangles(fs.readFileSync(sc.glb));
        const after = readGlbTriangles(fs.readFileSync(r.glb));
        // nothing added or removed
        expect(after.indices.length).toBe(before.indices.length);
        // the building's -x wall (x = -7), away from the tree crown: its interior vertices (every triangle at one is that wall's) must all
        // end on one plane; an edge vertex, shared with another plane, stays where it was. The same vertices before and after.
        const wall: number[] = [];
        for (let v = 0; v < before.positions.length / 3; v++) {
            const x = before.positions[3 * v], y = before.positions[3 * v + 1], z = Math.abs(before.positions[3 * v + 2]);
            if (Math.abs(x + 7) < 0.1 && y > 0.3 && y < 9.8 && z < 4.8) wall.push(v);
        }
        expect(wall.length).toBeGreaterThan(3);
        // each one's counterpart after the flatten: the nearest vertex, which can be at most one band away
        const nearest = (v: number) => {
            let best = -1, bd = Infinity;
            for (let w = 0; w < after.positions.length / 3; w++) {
                const d = Math.hypot(after.positions[3 * w] - before.positions[3 * v], after.positions[3 * w + 1] - before.positions[3 * v + 1], after.positions[3 * w + 2] - before.positions[3 * v + 2]);
                if (d < bd) { bd = d; best = w; }
            }
            expect(bd).toBeLessThanOrEqual(0.1 + 1e-6);
            return best;
        };
        // all of them on one plane to within a millimetre afterwards (x = a + b y + c z by least squares: the wall faces -x), where the scan's
        // own noise left them centimetres off it
        const planeResidual = (get: (v: number) => [number, number, number]): number => {
            const P = wall.map(get);
            const n = P.length;
            const sums = { y: 0, z: 0, yy: 0, yz: 0, zz: 0, x: 0, xy: 0, xz: 0 };
            for (const [x, y, z] of P) { sums.y += y; sums.z += z; sums.yy += y * y; sums.yz += y * z; sums.zz += z * z; sums.x += x; sums.xy += x * y; sums.xz += x * z; }
            const A = [[n, sums.y, sums.z], [sums.y, sums.yy, sums.yz], [sums.z, sums.yz, sums.zz]], rhs = [sums.x, sums.xy, sums.xz];
            const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            const D = det3(A);
            const col = (c: number) => det3(A.map((row, r) => row.map((val, k) => (k === c ? rhs[r] : val))));
            const [a, b, c] = [col(0) / D, col(1) / D, col(2) / D];
            return Math.max(...P.map(([x, y, z]) => Math.abs(x - (a + b * y + c * z))));
        };
        expect(planeResidual(v => [before.positions[3 * v], before.positions[3 * v + 1], before.positions[3 * v + 2]])).toBeGreaterThan(0.01);
        expect(planeResidual(v => { const w = nearest(v); return [after.positions[3 * w], after.positions[3 * w + 1], after.positions[3 * w + 2]]; })).toBeLessThan(0.001);
        // isolating by a footprint keeps whole triangles within the footprint grown by 4 m and drops the rest
        const iso = await svc.flatten({ inputGlb: rel(scenes.plaza.glb), footprint: [[8, -8], [26, -8], [26, 8], [8, 8]], bandM: 0.1 });
        expect(iso.value.isolate!.droppedTriangles).toBeGreaterThan(100);
        expect(iso.value.keptTriangles + iso.value.isolate!.droppedTriangles).toBe(iso.value.inputTriangles);
        const kept = readGlbTriangles(fs.readFileSync(iso.glb));
        let minX = Infinity;
        for (let v = 0; v < kept.positions.length / 3; v++) minX = Math.min(minX, kept.positions[3 * v]);
        expect(minX).toBeGreaterThan(8 - 4 - 4.5);   // within the dilation, plus a triangle's own reach
        expect(saveClayShot('scan_fit_flatten_tree', [{ file: r.glb, color: [0.7, 0.72, 0.75] }], { bearingDeg: 200, elevationDeg: 25 }).covered).toBeGreaterThan(0.03);
    }, 300_000);
});

const arch = findArchData();
describe.skipIf(!arch)('scan_fit on the real Washington Square Arch' + (arch ? '' : ' [skipped: no tile_refine isolate of the arch found: set SCRATCHBOX_ARCH_DIR to a directory holding raw_clay.glb, clay.glb and textured.glb]'), () => {
    const real = (name: string) => path.join(work, 'real', name);
    let result: Awaited<ReturnType<ScanFitService['fit']>>;

    beforeAll(async () => {
        fs.mkdirSync(path.join(work, 'real'), { recursive: true });
        fs.copyFileSync(arch!.rawClay, real('raw_clay.glb'));
        fs.copyFileSync(arch!.remeshClay, real('clay.glb'));
        fs.copyFileSync(arch!.texturedIsolated, real('textured.glb'));
        result = await svc.fit({ scanGlb: 'real/raw_clay.glb', texturedGlb: 'real/textured.glb', remeshGlb: 'real/clay.glb', anchor: { x: 0, z: 0 }, sourceLimits: { ...LIMITS, texelM: 0 } });
    }, 300_000);

    it('is accepted with its gates measured: the arch is the fit, the rest stays as scanned', () => {
        const f = result.value;
        expect(validateContract('StructureFit', f)).toEqual([]);
        expect(f.accepted).toBe(true);
        expect(f.gates.map(g => g.gate)).toEqual(expect.arrayContaining(['accepted body primitives']));
        // the measured numbers: scan to fit+scanned within the design's 4 cm, the backed rebuild within 6 cm
        expect(f.metrics.scanToFitPlusPassThrough.rmsM).toBeLessThanOrEqual(0.04);
        expect(f.metrics.fitToScan.rmsM).toBeLessThanOrEqual(0.06);
        expect(f.metrics.coverage).toBeGreaterThan(0.7);
        // the remesh moved the scan more than the fit did, and the fit reports how much
        expect(f.metrics.remeshToScan).toBeDefined();
        expect(f.metrics.remeshToScan!.maxM).toBeGreaterThanOrEqual(0.15);
        expect(f.passThrough.areaM2).toBeLessThan(200);
    });

    it('measures the arch: span 9.73 m, rise over span, a segmental opening; the scan alone cannot rule out a semicircle, so the photo may correct it', () => {
        const f = result.value;
        const body = f.primitives.find(p => p.fitParams.length === 7)!;
        expect(Math.abs(param(body, 0) - 9.73)).toBeLessThan(0.06);        // span
        expect(param(body, 4)).toBeGreaterThan(5.2);                        // depth along the passage
        expect(param(body, 4)).toBeLessThan(5.5);
        // the circle through the soffit is not a semicircle: rise/span 0.34 against 0.5
        expect(param(body, 6)).toBeGreaterThan(0.3);
        expect(param(body, 6)).toBeLessThan(0.4);
        const c = body.correctable.find(x => x.param === 6)!;
        const semi = body.alternatives.find(a => /semicircle/.test(a.why))!;
        expect(semi).toBeDefined();
        // the semicircle fits the soffit worse than the fitted circle (the scan's residual is lowest at the fit), yet by centimetres:
        // the tile's soffit (a 0.69 m mesh) cannot rule it out, so the scan does not forbid a photo from correcting to it
        const best = Math.min(...c.residualCurve.map(r => r[1]));
        expect(semi.fit.rmsM).toBeGreaterThan(best + 0.01);
        expect(semi.fit.rmsM).toBeLessThan(0.31);
        expect(Math.abs(c.residualCurve.reduce((a, r) => (r[1] < a[1] ? r : a), c.residualCurve[0])[0] - param(body, 6))).toBeLessThanOrEqual(0.05);
        // the photo may move rise/span within what the scan tolerates (0.31 m): 0.5 is inside it
        expect(c.toleranceM).toBeLessThanOrEqual(0.31 + 1e-9);
        expect(c.min).toBeLessThan(param(body, 6));
        expect(c.max).toBeGreaterThanOrEqual(0.5);
        // the cornice band stands proud: a band wider than the body below it, projecting about a metre
        const bands = f.primitives.filter(p => p.fitParams.length === 3);
        const plans = bands.map(b => param(b, 2)).sort((a, b) => b - a);
        expect(plans[0]).toBeGreaterThan(plans[plans.length - 1]);
    });

    it('measures the piers (3.79 m each, either side of the opening) and the keystone that stands proud of the soffit\'s crown', () => {
        const f = result.value;
        const body = f.primitives.find(p => p.fitParams.length === 7)!;
        // the elevation of the body: its feet are the vertices at the ground, in order: pier start, opening's left, opening's right, pier end
        const profile = (body.spec as any).sweep.profile.outer as Array<[number, number]>;
        const feet = profile.filter(q => q[1] < 0.05).map(q => q[0]).sort((a, b) => a - b);
        expect(feet.length).toBeGreaterThanOrEqual(4);
        const [sMin, sL, sR, sMax] = [feet[0], feet[1], feet[feet.length - 2], feet[feet.length - 1]];
        expect(Math.abs((sL - sMin) - 3.79)).toBeLessThan(0.05);
        expect(Math.abs((sMax - sR) - 3.79)).toBeLessThan(0.05);
        expect(sR - sL).toBeCloseTo(param(body, 0), 2);
        // the keystone: a box measured proud of the face, about 1.1 m wide and 0.9 m tall, 0.44 m out (design: within 3 cm), at the crown's height
        const crownY = param(body, 1) + param(body, 2);
        const boxes = f.primitives.filter(p => p.fitParams.length === 6 && p.fitParams[1].value > 5);
        const keystone = boxes.find(b => Math.abs(b.fitParams[1].value - (crownY - 0.2)) < 1.5 || (b.fitParams[1].value < crownY && b.fitParams[4].value > crownY - 1));
        expect(keystone, `a box at the crown (y ${crownY.toFixed(2)}) among ${boxes.map(b => b.fitParams.map(x => x.value.toFixed(2)).join(' ')).join(' | ')}`).toBeDefined();
        const [x0, y0, z0, x1, y1, z1] = keystone!.fitParams.map(x => x.value);
        expect(Math.abs((x1 - x0) - 1.1)).toBeLessThan(0.15);
        expect(Math.abs((y1 - y0) - 0.9)).toBeLessThan(0.15);
        expect(Math.abs(Math.abs(z1 - z0) - 0.44)).toBeLessThan(0.05);
        expect(keystone!.provenance.label).toBe('fitted');
        expect(keystone!.fit.rmsM).toBeLessThan(0.1);
    });

    it('reports the faces the scan does not back as such, with their area', () => {
        const f = result.value;
        const unobserved = f.surfaces.filter(s => s.visibleFraction > 0.3 && s.supportFraction < 0.5);
        for (const s of unobserved) {
            expect(s.provenance.label).toBe('fitted-unobserved');
            expect(s.provenance.measuredGeometry).toBe(false);
            expect(s.provenance.confidence).toBeCloseTo(s.supportFraction, 2);
        }
        for (const s of f.surfaces.filter(x => x.supportFraction >= 0.5)) expect(['fitted', 'photo-corrected']).toContain(s.provenance.label);
    });

    it('lays the tile photo on every visible face as an ortho, with the photo\'s own texel, and draws the slots on it', () => {
        const f = result.value;
        expect(f.outputs.orthos.length).toBeGreaterThan(10);
        const big = f.outputs.orthos.sort((a, b) => b.widthPx * b.heightPx - a.widthPx * a.heightPx)[0];
        expect(Math.abs(big.texelM - 0.154)).toBeLessThan(0.02);            // the photo's texel on the arch, 0.154 m
        expect(big.gsdM).toBeCloseTo(0.05, 6);
        expect(big.slotsDrawn.length).toBeGreaterThanOrEqual(1);
        expect(f.sourceLimits.photoResolvableM).toBeGreaterThan(0.29);
        expect(f.sourceLimits.photoResolvableM).toBeLessThan(0.33);
        const png = fs.readFileSync(big.path);
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(crypto.createHash('sha256').update(png).digest('hex')).toBe(big.sha256);
        fs.mkdirSync(path.join(work, 'shots'), { recursive: true });
        fs.mkdirSync(path.dirname(path.join(REPO, 'test-results/screenshots/staged/x')), { recursive: true });
        fs.copyFileSync(big.path, path.join(REPO, 'test-results/screenshots/staged/scan_fit_arch_ortho_largest.png'));
    });

    it('fits within the time the design asks of it, measured', () => {
        const total = Object.values(result.value.timingsMs).reduce((a, b) => a + b, 0);
        expect(total).toBeLessThan(1500);
    });

    it('draws the fitted body, its outlines coloured by fit error, and what stays as scanned', () => {
        const f = result.value;
        const base = [{ file: real('raw_clay.glb'), color: [0.72, 0.74, 0.77] as [number, number, number] }];
        const a = saveClayShot('scan_fit_arch_fitted', [...base, { file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }], { bearingDeg: 215, elevationDeg: 20 });
        const b = saveClayShot('scan_fit_arch_fitted_back', [{ file: f.outputs.fittedGlb, color: [0.9, 0.5, 0.3] }, ...(f.outputs.passThroughGlb ? [{ file: f.outputs.passThroughGlb, color: [0.3, 0.45, 0.8] as [number, number, number] }] : [])], { bearingDeg: 30, elevationDeg: 20 });
        expect(a.covered).toBeGreaterThan(0.03);
        expect(b.covered).toBeGreaterThan(0.03);
        const c = saveClayShot('scan_fit_arch_remesh_for_comparison', [{ file: real('clay.glb'), color: [0.72, 0.74, 0.77] }], { bearingDeg: 215, elevationDeg: 20 });
        expect(c.covered).toBeGreaterThan(0.03);
    });

    it('flattens the raw scan\'s facades (the remesh rung) with no vertex moved further than its band', async () => {
        const fp = await svc.flatten({ inputGlb: 'real/textured.glb', footprint: [[-11.5, -10.9], [9.5, -10.9], [9.5, 6.06], [-11.5, 6.06]], bandM: 0.1 });
        expect(fp.value.planes).toBeGreaterThan(20);
        expect(fp.value.maxMoveM).toBeLessThanOrEqual(0.1 + 1e-6);
        expect(fp.value.movedVertices).toBeGreaterThan(100);
        const shot = saveClayShot('scan_fit_arch_flatten_rung', [{ file: fp.glb, color: [0.72, 0.74, 0.77] }], { bearingDeg: 215, elevationDeg: 20 });
        expect(shot.covered).toBeGreaterThan(0.03);
    }, 120_000);
});
