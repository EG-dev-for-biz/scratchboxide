/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Micro-edits on a synthetic roof with a known truth: a rough octagonal drum (its sides dented by noise, a fan photo
 * painted on its flat top: a dark disc of radius 0.75 m with five bright blades) and a square box beside it, on a flat roof
 * inside a 20 m footprint. Run after run the loop must keep one small edit each (the drum's solid, then a recess at the
 * photo's ring, then five radial sweeps), replay the earlier ones bit for bit, never propose a kept edit again, refuse
 * steps past their bounds or outside the footprint and the scanned volume, and retire the drum once a newer scan no longer
 * shows it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DirectoryCloudBucket } from '../src/node/cloud-store/cloud-bucket';
import type { TopDownCrop } from '../src/node/3d-engine/staged-location/micro-edit-evidence';
import { buildHeightMap, findRoundUnits, sampleScanPoints } from '../src/node/3d-engine/staged-location/micro-edit-evidence';
import {
    buildUnits, clampNudge, composeUnits, editKey, emptyPlan, FootprintMask, insideFootprint, keptEdits, MICRO_EDIT_PARAMS, nudgeWithinBounds, outsideBounds, replayHash, runMicroEditPass, supportDisc,
    toAnchor, type Footprint, type MicroEditPlan
} from '../src/node/3d-engine/staged-location/micro-edits';
import { loadMicroEditPlan, openPlaceStore, saveMicroEditPlan } from '../src/node/3d-engine/staged-location/place-store';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'micro-edits-'));
const FRAME = { lat: 40.7505, lng: -73.9935, ellipsoidalHeightM: 0 };
const ROOF_Y = 30;
const DRUM = { x: 3, z: -2, R: 1.04, H: 1.2 };
const BOX = { x: -4, z: 3, half: 0.8, H: 1.0 };
const BOWL_R = 0.75, BLADES = 5, BLADE_PHASE = 0.3;
const FOOTPRINT: Footprint = [[[[-10, -10], [10, -10], [10, 10], [-10, 10]]]];

/** A deterministic noise in [-1, 1]. */
function noise(i: number, seed: number): number {
    const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    return 2 * (x - Math.floor(x)) - 1;
}

/** The synthetic scan's triangles: the roof, the octagonal drum (or none), the box. */
function syntheticScan(opts: { drum?: boolean; shift?: [number, number]; seed?: number } = {}): Float32Array {
    const tris: number[] = [];
    const seed = opts.seed ?? 1;
    let k = 0;
    const tri = (a: number[], b: number[], c: number[]) => tris.push(...a, ...b, ...c);
    for (let z = -10; z < 10; z += 0.5) for (let x = -10; x < 10; x += 0.5) {
        tri([x, ROOF_Y, z], [x + 0.5, ROOF_Y, z], [x + 0.5, ROOF_Y, z + 0.5]);
        tri([x, ROOF_Y, z], [x + 0.5, ROOF_Y, z + 0.5], [x, ROOF_Y, z + 0.5]);
    }
    if (opts.drum !== false) {
        const cx = DRUM.x + (opts.shift?.[0] ?? 0), cz = DRUM.z + (opts.shift?.[1] ?? 0);
        const ring = (y: number, j: number) => Array.from({ length: 8 }, (_, s) => {
            const th = (s * Math.PI) / 4 + Math.PI / 8;
            const r = DRUM.R + 0.015 * noise(k++ + j * 31 + s, seed);
            return [cx + r * Math.cos(th), y, cz + r * Math.sin(th)];
        });
        const rows = 6;
        const rings = Array.from({ length: rows + 1 }, (_, j) => ring(ROOF_Y + (DRUM.H * j) / rows, j));
        for (let j = 0; j < rows; j++) for (let s = 0; s < 8; s++) {
            const a = rings[j][s], b = rings[j][(s + 1) % 8], c = rings[j + 1][(s + 1) % 8], d = rings[j + 1][s];
            tri(a, b, c); tri(a, c, d);
        }
        const top = rings[rows];
        const centre = [cx, ROOF_Y + DRUM.H, cz];
        for (let s = 0; s < 8; s++) {
            // the top split into rings so it is sampled as finely as the sides
            const a = top[s], b = top[(s + 1) % 8];
            const mid = (p: number[], t: number) => [centre[0] + (p[0] - centre[0]) * t, ROOF_Y + DRUM.H + 0.01 * noise(k++, seed), centre[2] + (p[2] - centre[2]) * t];
            tri(centre, mid(a, 0.5), mid(b, 0.5));
            tri(mid(a, 0.5), a, b); tri(mid(a, 0.5), b, mid(b, 0.5));
        }
    }
    const { x, z, half, H } = BOX;
    const c = [[x - half, z - half], [x + half, z - half], [x + half, z + half], [x - half, z + half]];
    for (let s = 0; s < 4; s++) {
        const [ax, az] = c[s], [bx, bz] = c[(s + 1) % 4];
        tri([ax, ROOF_Y, az], [bx, ROOF_Y, bz], [bx, ROOF_Y + H, bz]);
        tri([ax, ROOF_Y, az], [bx, ROOF_Y + H, bz], [ax, ROOF_Y + H, az]);
    }
    tri([c[0][0], ROOF_Y + H, c[0][1]], [c[1][0], ROOF_Y + H, c[1][1]], [c[2][0], ROOF_Y + H, c[2][1]]);
    tri([c[0][0], ROOF_Y + H, c[0][1]], [c[2][0], ROOF_Y + H, c[2][1]], [c[3][0], ROOF_Y + H, c[3][1]]);
    return new Float32Array(tris);
}

/** The photo straight down (luminance only): the fan on the drum's top, the box, the roof with a little texture. */
function photoAt(x: number, z: number, seed: number, drum = true): number {
    const r = Math.hypot(x - DRUM.x, z - DRUM.z);
    if (drum && r <= BOWL_R) {
        const th = Math.atan2(z - DRUM.z, x - DRUM.x);
        return r >= 0.15 && r <= 0.7 && Math.cos(BLADES * (th - BLADE_PHASE)) > 0.3 ? 190 : 40;
    }
    if (drum && r <= 1.0) return 175;
    if (Math.abs(x - BOX.x) <= BOX.half && Math.abs(z - BOX.z) <= BOX.half) return 120;
    return 150 + 5 * noise(Math.floor(x * 20) * 7919 + Math.floor(z * 20), seed);
}

function crop(cx: number, cz: number, half: number, texelM: number, seed: number, drum = true): TopDownCrop {
    const n = Math.ceil((2 * half) / texelM);
    const rgba = new Uint8Array(n * n * 4);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const v = Math.round(photoAt(cx - half + (i + 0.5) * texelM, cz - half + (j + 0.5) * texelM, seed, drum));
        rgba.set([v, v, v, 255], (j * n + i) * 4);
    }
    return { rgba, width: n, height: n, x0: cx - half, z0: cz - half, texelM };
}

/** The held-out photo on a crop's grid: the same place drawn with its own texture noise. */
const heldOut = (drum = true) => async (grid: TopDownCrop): Promise<TopDownCrop> => {
    const rgba = new Uint8Array(grid.width * grid.height * 4);
    for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) {
        const v = Math.round(photoAt(grid.x0 + (i + 0.5) * grid.texelM, grid.z0 + (j + 0.5) * grid.texelM, 9, drum));
        rgba.set([v, v, v, 255], (j * grid.width + i) * 4);
    }
    return { ...grid, rgba };
};

function pass(plan: MicroEditPlan, runId: string, opts: { drum?: boolean; held?: boolean; shift?: [number, number]; seed?: number } = {}) {
    return runMicroEditPass({
        plan, runId, frame: FRAME, scan: syntheticScan(opts), footprint: FOOTPRINT, workDir: tmp(),
        tileCrop: (cx, cz, half, texelM) => crop(cx, cz, half, texelM, opts.seed ?? 1, opts.drum !== false),
        ...(opts.held === false ? {} : { heldOut: heldOut(opts.drum !== false) }),
        now: () => 1_700_000_000_000
    });
}

describe('micro-edits: step bounds', () => {
    it('allows a nudge of at most 10 cm or 10% of the parameter, one for a count, and clamps to that bound', () => {
        expect(nudgeWithinBounds('radiusM', 1.0, 1.09)).toBeUndefined();
        expect(nudgeWithinBounds('radiusM', 1.0, 1.12)).toMatch(/more than 10\.0 cm/);
        expect(nudgeWithinBounds('radiusM', 0.5, 0.56)).toMatch(/more than 5\.0 cm/);
        expect(nudgeWithinBounds('wireRadiusM', 0.004, 0.012)).toBeUndefined(); // the 1 cm floor
        expect(nudgeWithinBounds('count', 5, 6)).toBeUndefined();
        expect(nudgeWithinBounds('count', 5, 7)).toMatch(/by one/);
        expect(nudgeWithinBounds('pitchRad', 0.4, 0.55)).toMatch(/rad/);
        expect(clampNudge('radiusM', 1.0, 1.5)).toBeCloseTo(1.1, 9);
        expect(clampNudge('heightM', 2.0, 1.0)).toBeCloseTo(1.9, 9);
        expect(clampNudge('count', 5, 9)).toBe(6);
    });

    it('refuses a part outside the footprint or above the scanned volume', () => {
        const pts = sampleScanPoints(syntheticScan(), 0.08);
        const h = buildHeightMap(pts, { x0: -11, z0: -11, x1: 11, z1: 11 });
        expect(outsideBounds([supportDisc(DRUM.x, ROOF_Y + DRUM.H, DRUM.z, 0.9)], FOOTPRINT, h)).toBeUndefined();
        expect(outsideBounds([supportDisc(9.5, ROOF_Y, 0, 1)], FOOTPRINT, h)).toMatch(/outside the footprint/);
        expect(outsideBounds([supportDisc(DRUM.x, ROOF_Y + DRUM.H + 0.3, DRUM.z, 0.5)], FOOTPRINT, h)).toMatch(/above the scan's top/);
    });
});

describe('micro-edits: the round units the scan measures', () => {
    it('finds the octagonal drum (axis and radius) and not the square box', () => {
        const pts = sampleScanPoints(syntheticScan(), 0.08);
        const h = buildHeightMap(pts, { x0: -11, z0: -11, x1: 11, z1: 11 });
        const f = findRoundUnits(pts, h, () => true);
        expect(f.units.length, JSON.stringify(f.rejected)).toBe(1);
        const u = f.units[0];
        expect(Math.hypot(u.cx - DRUM.x, u.cz - DRUM.z)).toBeLessThan(0.05);
        // an octagon with corners at 1.04 m: its sides lie between 0.96 and 1.04 m from the axis
        expect(u.r).toBeGreaterThan(0.95);
        expect(u.r).toBeLessThan(1.04);
        expect(u.topY - u.baseY).toBeGreaterThan(1.1);
        expect(f.rejected['sides not round']).toBe(1);
    });
});

/** Two hollow rings touching (each an open octagonal wall 0.9 m high, 0.3 m thick, around a floor on the roof). */
function touchingRings(): Float32Array {
    const tris: number[] = [];
    const tri = (a: number[], b: number[], c: number[]) => tris.push(...a, ...b, ...c);
    for (let z = -10; z < 10; z += 0.5) for (let x = -10; x < 10; x += 0.5) {
        tri([x, ROOF_Y, z], [x + 0.5, ROOF_Y, z], [x + 0.5, ROOF_Y, z + 0.5]);
        tri([x, ROOF_Y, z], [x + 0.5, ROOF_Y, z + 0.5], [x, ROOF_Y, z + 0.5]);
    }
    let k = 0;
    for (const [cx, cz] of [[-1.9, 0], [1.9, 0]]) {
        const wall = (r: number) => {
            const rows = 4;
            const ring = (y: number) => Array.from({ length: 8 }, (_, s) => { const th = (s * Math.PI) / 4 + Math.PI / 8, rr = r + 0.01 * noise(k++, 5); return [cx + rr * Math.cos(th), y, cz + rr * Math.sin(th)]; });
            const rs = Array.from({ length: rows + 1 }, (_, j) => ring(ROOF_Y + (0.9 * j) / rows));
            for (let j = 0; j < rows; j++) for (let s = 0; s < 8; s++) { const a = rs[j][s], b = rs[j][(s + 1) % 8], c = rs[j + 1][(s + 1) % 8], d = rs[j + 1][s]; tri(a, b, c); tri(a, c, d); }
            return rs[rows];
        };
        const outer = wall(1.9), inner = wall(1.6);
        for (let s = 0; s < 8; s++) { tri(outer[s], outer[(s + 1) % 8], inner[(s + 1) % 8]); tri(outer[s], inner[(s + 1) % 8], inner[s]); }
    }
    return new Float32Array(tris);
}

describe('micro-edits: units that touch, open tops, and a footprint of many parts', () => {
    it('finds two touching hollow rings as two units, each with its inner wall and floor measured', () => {
        const pts = sampleScanPoints(touchingRings(), 0.06);
        const h = buildHeightMap(pts, { x0: -11, z0: -11, x1: 11, z1: 11 });
        const f = findRoundUnits(pts, h, () => true);
        expect(f.units.length, JSON.stringify(f.rejected)).toBe(2);
        for (const u of f.units) {
            expect(u.found).toBe('circle-vote');
            expect(Math.abs(Math.abs(u.cx) - 1.9)).toBeLessThan(0.1);
            // an octagon with corners at 1.9 m: its outer wall lies between 1.76 and 1.9 m from the axis
            expect(u.r).toBeGreaterThan(1.7);
            expect(u.r).toBeLessThan(1.95);
            expect(u.inner!.radiusM).toBeGreaterThan(1.4);
            expect(u.inner!.radiusM).toBeLessThan(u.r - 0.1);
            expect(u.topY - u.inner!.floorY).toBeGreaterThan(0.8);
        }
    });

    it('rasterises a footprint of many parts to the same answer as the polygons, cell centre by cell centre', () => {
        const parts: Footprint = [];
        for (let i = 0; i < 40; i++) { const x = (i % 8) * 2.5, z = Math.floor(i / 8) * 2.5; parts.push([[[x, z], [x + 2, z], [x + 1, z + 2]]]); }
        parts.push([[[-5, -5], [-1, -5], [-1, -1], [-5, -1]], [[-4, -4], [-2, -4], [-2, -2], [-4, -2]]]);
        const m = new FootprintMask(parts, 0.1);
        let disagree = 0, n = 0;
        for (let z = m.z0 + 0.05; z < m.z0 + m.nz * 0.1; z += 0.1) for (let x = m.x0 + 0.05; x < m.x0 + m.nx * 0.1; x += 0.1) { n++; if (m.inside(x, z) !== insideFootprint(parts, x, z)) disagree++; }
        expect(n).toBeGreaterThan(10000);
        expect(disagree / n).toBeLessThan(0.002);
        expect(m.inside(-3, -3)).toBe(false); // the hole
        expect(m.inside(-4.5, -4.5)).toBe(true);
    });
});

describe('micro-edits: the loop, run after run', () => {
    const plans: MicroEditPlan[] = [];
    const reports: Awaited<ReturnType<typeof pass>>['report'][] = [];

    it('run 1 keeps one edit: the drum\'s solid of revolution, fitted to the scan', async () => {
        const r = await pass(emptyPlan('building/test'), 'run-1');
        plans.push(r.plan); reports.push(r.report);
        expect(r.report.run.kept.length, JSON.stringify(r.report.proposals)).toBe(1);
        const e = r.plan.edits.find(x => x.key === r.report.run.kept[0])!;
        expect(e.primitive).toBe('revolution');
        expect(e.provenance).toBe('measured');
        expect(e.paramProvenance.sinkM).toBe('generated');
        expect(e.params.radiusM).toBeGreaterThan(0.95);
        expect(e.metrics.after.scanRmsM).toBeLessThan(e.metrics.before.scanRmsM);
        expect(e.metrics.after.scanRmsM).toBeLessThan(MICRO_EDIT_PARAMS.maxFitRmsM);
        expect(e.metrics.changedAreaM2).toBeLessThanOrEqual(MICRO_EDIT_PARAMS.maxChangedAreaM2);
        expect(r.report.run.drift).toBeNull();
    });

    it('run 2 replays run 1 bit for bit and adds a recess at the photo\'s ring', async () => {
        const r = await pass(plans[0], 'run-2');
        plans.push(r.plan); reports.push(r.report);
        expect(r.report.run.replaySha).toBe(plans[0].runs[0].afterSha);
        expect(r.report.run.drift).toBe(false);
        expect(r.report.run.kept.length, JSON.stringify(r.report.proposals)).toBe(1);
        const e = r.plan.edits.find(x => x.key === r.report.run.kept[0])!;
        expect(e.primitive).toBe('revolution-recess');
        expect(Math.abs(e.params.radiusM - BOWL_R)).toBeLessThan(0.07);
        expect(e.paramProvenance.radiusM).toBe('photo-inferred');
        expect(e.metrics.scanRule).toBe('within-resolution');
        // the held-out photo: the ring's edge now drawn where the photo has it; SSIM held within its tolerance
        expect(e.metrics.after.photoGradientNcc!).toBeGreaterThan(e.metrics.before.photoGradientNcc!);
        expect(e.metrics.after.photoSsim!).toBeGreaterThanOrEqual(e.metrics.before.photoSsim! - MICRO_EDIT_PARAMS.ssimTol);
        // run 1's edit is unchanged
        expect(r.plan.edits[0]).toEqual(plans[0].edits[0]);
    });

    it('run 3 replays runs 1-2 unchanged and adds five radial sweeps at the photo\'s angular period', async () => {
        const r = await pass(plans[1], 'run-3');
        plans.push(r.plan); reports.push(r.report);
        expect(r.report.run.replaySha).toBe(plans[1].runs[1].afterSha);
        expect(r.report.run.drift).toBe(false);
        expect(r.report.run.kept.length, JSON.stringify(r.report.proposals)).toBe(1);
        const e = r.plan.edits.find(x => x.key === r.report.run.kept[0])!;
        expect(e.primitive).toBe('radial-sweeps');
        expect(e.params.count).toBe(BLADES);
        expect(e.paramProvenance.count).toBe('photo-inferred');
        expect(e.paramProvenance.pitchRad).toBe('generated');
        expect(r.plan.edits.slice(0, 2)).toEqual(plans[1].edits);
    });

    it('run 4 decides the concentric sweeps (kept or rejected with its reason) and never re-proposes what is kept', async () => {
        const r = await pass(plans[2], 'run-4');
        plans.push(r.plan); reports.push(r.report);
        expect(r.report.run.drift).toBe(false);
        const p = r.report.proposals.find(x => x.primitive === 'concentric-sweeps');
        expect(p, JSON.stringify(r.report.proposals)).toBeDefined();
        expect(['kept', 'rejected']).toContain(p!.verdict);
        expect(p!.reason.length).toBeGreaterThan(0);
        // no kept edit is proposed as new: the drum found again by the scan matches the kept solid
        expect(r.report.proposals.filter(x => x.primitive === 'revolution')).toEqual([]);
        expect(r.plan.edits.slice(0, 3)).toEqual(plans[2].edits);
    });

    it('a scan shifted by 3 cm finds the same drum: no new solid, the same keys', async () => {
        const r = await pass(plans[2], 'run-shift', { shift: [0.03, -0.02], seed: 2 });
        expect(r.report.proposals.filter(x => x.primitive === 'revolution')).toEqual([]);
        expect(keptEdits(r.plan).map(e => e.key).slice(0, 3)).toEqual(keptEdits(plans[2]).map(e => e.key));
    });
});

describe('micro-edits: replay determinism', () => {
    it('the same plan replays to the same bytes, in any run frame', async () => {
        const r = await pass(emptyPlan('building/test'), 'run-1');
        const a = await buildUnits(composeUnits(r.plan), FRAME, tmp());
        const b = await buildUnits(composeUnits(r.plan), FRAME, tmp());
        const moved = await buildUnits(composeUnits(r.plan), { ...FRAME, lat: FRAME.lat + 0.0002, ellipsoidalHeightM: 1.7 }, tmp());
        expect(replayHash(a)).toBe(replayHash(b));
        expect(replayHash(moved)).toBe(replayHash(a));
        expect(a[0].parts[0].positions).toEqual(b[0].parts[0].positions);
        // placed: the moved frame puts the same solid at the same place on the earth
        const shiftZ = moved[0].origin[2] - a[0].origin[2];
        expect(Math.abs(shiftZ - 0.0002 * 111_000)).toBeLessThan(0.5);
    });

    it('an edit key is the same for an anchor that moved a little within its rounding cell, and differs for another rung', () => {
        const anchor = toAnchor(FRAME, 3.1, ROOF_Y, -2.1);
        const k1 = editKey({ kind: 'primitive', primitive: 'revolution', rung: 0, anchor });
        const k2 = editKey({ kind: 'primitive', primitive: 'revolution', rung: 0, anchor: { ...anchor } });
        const k3 = editKey({ kind: 'primitive', primitive: 'revolution-recess', parent: k1, rung: 1, anchor });
        expect(k1).toBe(k2);
        expect(k3).not.toBe(k1);
    });
});

describe('micro-edits: rejection and expiry', () => {
    it('without a held-out photo nothing is kept; the rejection is recorded and not proposed again on the same evidence', async () => {
        const r1 = await pass(emptyPlan('building/test'), 'run-a', { held: false });
        expect(r1.report.run.kept).toEqual([]);
        expect(r1.plan.rejected[0].reason).toMatch(/no held-out photo/);
        const r2 = await pass(r1.plan, 'run-b', { held: false });
        expect(r2.report.proposals[0].verdict).toBe('skipped');
        expect(r2.report.run.proposed).toEqual([]);
    });

    it('retires the drum and every edit on it when a newer scan no longer shows it, with the reason', async () => {
        let plan = emptyPlan('building/test');
        for (const id of ['e1', 'e2']) plan = (await pass(plan, id)).plan;
        expect(keptEdits(plan).length).toBe(2);
        const r = await pass(plan, 'e3', { drum: false });
        expect(r.report.run.retired.length).toBe(2);
        expect(r.report.run.retired[0].reason).toMatch(/nothing standing here|contradicts/);
        expect(r.report.run.retired[1].reason).toMatch(/was retired/);
        expect(keptEdits(r.plan)).toEqual([]);
        expect(r.report.units).toEqual([]);
    });
});

describe('micro-edits: the plan in the place store', () => {
    it('saves and loads a plan, and refuses a write over a generation another run already replaced', async () => {
        const root = tmp();
        const store = await openPlaceStore({ key: 'test_place', bucket: new DirectoryCloudBucket(root), tmpDir: tmp() });
        const plan = emptyPlan('building/17/1/2/f3', 'test place');
        const w = await saveMicroEditPlan(store, plan.buildingId, plan);
        expect(w).not.toBe('conflict');
        const read = await loadMicroEditPlan<MicroEditPlan>(store, plan.buildingId);
        expect(read!.plan).toEqual(plan);
        const w2 = await saveMicroEditPlan(store, plan.buildingId, { ...plan, updatedAtMs: 2 }, read!.generation);
        expect(w2).not.toBe('conflict');
        expect(await saveMicroEditPlan(store, plan.buildingId, { ...plan, updatedAtMs: 3 }, read!.generation)).toBe('conflict');
    });
});
