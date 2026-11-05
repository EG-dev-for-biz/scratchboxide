/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Shell fit (scripts/shell_fit.cpp over scratchbox_shell_fit.hpp) on a synthetic scan with a known answer: a stepped
 * block (a 20 x 20 x 10 m base with a 10 x 10 x 10 m tower on one corner), scanned as 1 m triangles with 3 cm of noise,
 * open at the bottom, with a 3 x 3 m hole in one wall and a thin round mast on the tower that no plane explains.
 * The solver must return one closed solid of the right volume, label the floor it closed as generated and the walls as
 * measured, report the hole as unsupported area, and keep the mast as residual scan. The closed mesh is checked again
 * here from the written GLB, by code that shares nothing with the solver.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { readGlbTriangles } from './helpers/clay-glb-render';

const REPO = path.resolve(__dirname, '..', '..', '..');
const INCLUDE = path.join(REPO, 'packages', 'core', 'src', 'native', '3d-engine', 'include');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-fit-'));

type V = [number, number, number];

/** A deterministic value in [-1, 1] from a lattice position. */
function noise(x: number, y: number, z: number, salt: number): number {
    let h = (Math.round(x * 8) * 73856093) ^ (Math.round(y * 8) * 19349663) ^ (Math.round(z * 8) * 83492791) ^ (salt * 2654435761);
    h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); h ^= h >>> 16;
    return ((h >>> 0) / 4294967295) * 2 - 1;
}

class ScanBuilder {
    private readonly ids = new Map<string, number>();
    readonly positions: number[] = [];
    readonly indices: number[] = [];
    constructor(private readonly noiseM: number) {}
    private vertex(p: V): number {
        const key = p.map(v => Math.round(v * 1000)).join(',');
        let id = this.ids.get(key);
        if (id === undefined) {
            id = this.positions.length / 3;
            this.ids.set(key, id);
            this.positions.push(p[0] + this.noiseM * noise(p[0], p[1], p[2], 1), p[1] + this.noiseM * noise(p[0], p[1], p[2], 2), p[2] + this.noiseM * noise(p[0], p[1], p[2], 3));
        }
        return id;
    }
    tri(a: V, b: V, c: V): void { this.indices.push(this.vertex(a), this.vertex(b), this.vertex(c)); }
    /** A rectangle o + s*u + t*v in 1 m cells, facing u x v; `skip(s, t)` leaves a cell out. */
    rect(o: V, u: V, nu: number, v: V, nv: number, skip?: (s: number, t: number) => boolean): void {
        const at = (s: number, t: number): V => [o[0] + u[0] * s + v[0] * t, o[1] + u[1] * s + v[1] * t, o[2] + u[2] * s + v[2] * t];
        for (let s = 0; s < nu; s++) for (let t = 0; t < nv; t++) {
            if (skip?.(s, t)) continue;
            this.tri(at(s, t), at(s + 1, t), at(s + 1, t + 1));
            this.tri(at(s, t), at(s + 1, t + 1), at(s, t + 1));
        }
    }
    glb(): Buffer {
        const pos = new Float32Array(this.positions);
        const idx = new Uint32Array(this.indices);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i++) { min[i % 3] = Math.min(min[i % 3], pos[i]); max[i % 3] = Math.max(max[i % 3], pos[i]); }
        const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
        return assembleGlb({
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
                { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' },
            ],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }],
            buffers: [{ byteLength: bin.length }],
        }, bin);
    }
}

/** The stepped block: every face wound to face out, no floor. */
function steppedBlock(opts: { hole: boolean; mast: boolean }): ScanBuilder {
    const b = new ScanBuilder(0.03);
    // base walls (y 0..10)
    b.rect([0, 0, 0], [0, 0, 1], 20, [0, 1, 0], 10);                                   // x = 0, faces -x
    b.rect([20, 0, 0], [0, 1, 0], 10, [0, 0, 1], 20, (s, t) => opts.hole && s >= 4 && s < 7 && t >= 8 && t < 11);   // x = 20, faces +x; the hole: y 4..7, z 8..11
    b.rect([0, 0, 0], [0, 1, 0], 10, [1, 0, 0], 20);                                   // z = 0, faces -z
    b.rect([0, 0, 20], [1, 0, 0], 20, [0, 1, 0], 10);                                  // z = 20, faces +z
    // base roof (y = 10) around the tower
    b.rect([0, 10, 0], [0, 0, 1], 20, [1, 0, 0], 20, (s, t) => s < 10 && t < 10);      // faces +y
    // tower walls (y 10..20) and top
    b.rect([0, 10, 0], [0, 0, 1], 10, [0, 1, 0], 10);                                  // x = 0
    b.rect([10, 10, 0], [0, 1, 0], 10, [0, 0, 1], 10);                                 // x = 10
    b.rect([0, 10, 0], [0, 1, 0], 10, [1, 0, 0], 10);                                  // z = 0
    b.rect([0, 10, 10], [1, 0, 0], 10, [0, 1, 0], 10);                                 // z = 10
    b.rect([0, 20, 0], [0, 0, 1], 10, [1, 0, 0], 10);                                  // top
    if (opts.mast) {
        // a round mast, radius 0.4 m, 6 m tall, on the tower: 12 facets of 0.2 m, far too small to be planes
        const n = 12, r = 0.4, cx = 5, cz = 5;
        const ring = (y: number): V[] => Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), y, cz + r * Math.sin((2 * Math.PI * i) / n)] as V);
        for (let y = 20; y < 26; y++) {
            const lo = ring(y), hi = ring(y + 1);
            for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.tri(lo[i], hi[i], hi[j]); b.tri(lo[i], hi[j], lo[j]); }
        }
        const top = ring(26);
        for (let i = 0; i < n; i++) b.tri([cx, 26, cz], top[(i + 1) % n], top[i]);
    }
    return b;
}

let binary = '';

function run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
        execFile(binary, args, { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) reject(new Error(`shell_fit failed: ${stdout || stderr || err.message}`)); else resolve(JSON.parse(stdout));
        });
    });
}

/** Edge uses and volume of a triangle list after welding equal positions: an independent closedness check. */
function closedness(positions: Float32Array, indices: Uint32Array, first: number, count: number): { boundary: number; nonManifold: number; volume: number; area: number } {
    const ids = new Map<string, number>();
    const id = (i: number) => {
        const k = `${Math.round(positions[i * 3] * 1e4)},${Math.round(positions[i * 3 + 1] * 1e4)},${Math.round(positions[i * 3 + 2] * 1e4)}`;
        let v = ids.get(k);
        if (v === undefined) { v = ids.size; ids.set(k, v); }
        return v;
    };
    const uses = new Map<string, number>();
    let volume = 0, area = 0;
    for (let t = first; t < first + count; t++) {
        const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
        const [ia, ib, ic] = [id(a), id(b), id(c)];
        const p = (i: number): V => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        const [pa, pb, pc] = [p(a), p(b), p(c)];
        const cr: V = [(pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]), (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]), (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0])];
        area += 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
        volume += (pa[0] * cr[0] + pa[1] * cr[1] + pa[2] * cr[2]) / 6;
        if (ia === ib || ib === ic || ia === ic) continue;
        for (const [x, y] of [[ia, ib], [ib, ic], [ic, ia]]) { const k = x < y ? `${x}_${y}` : `${y}_${x}`; uses.set(k, (uses.get(k) ?? 0) + 1); }
    }
    let boundary = 0, nonManifold = 0;
    for (const n of uses.values()) { if (n === 1) boundary++; else if (n !== 2) nonManifold++; }
    return { boundary, nonManifold, volume, area };
}

describe('shell fit: one closed solid from a scan with gaps', () => {
    beforeAll(async () => {
        const built = await compileNativeCached({ sourcePath: path.join(REPO, 'scripts', 'shell_fit.cpp'), includeDirs: [INCLUDE], flags: defaultNativeFlags(), libs: ['-lz'], name: 'shell_fit', timeoutMs: 600_000 });
        binary = built.binaryPath;
    }, 660_000);
    afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

    it('closes a stepped block with a hole in a wall: no open edge, the right volume, the floor generated, the mast kept as scan', async () => {
        const scanPath = path.join(TMP, 'stepped.glb'), shellPath = path.join(TMP, 'stepped_shell.glb'), combinedPath = path.join(TMP, 'stepped_combined.glb'), reportPath = path.join(TMP, 'stepped.json');
        fs.writeFileSync(scanPath, steppedBlock({ hole: true, mast: true }).glb());
        const out = await run(['--input', scanPath, '--out-shell', shellPath, '--out-combined', combinedPath, '--report', reportPath, '--threads', '2']);
        expect(out.ok).toBe(true);
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        const m = report.metrics;

        // closed by construction, and manifold
        expect(m.boundaryEdges).toBe(0);
        expect(m.nonManifoldEdges).toBe(0);
        // the solid: 20 x 20 x 10 + 10 x 10 x 10 = 5000 m3; its surface 2000 m2 with the 400 m2 floor
        expect(Math.abs(m.shellVolumeM3 - 5000) / 5000).toBeLessThan(0.02);
        expect(Math.abs(m.shellAreaM2 - 2000) / 2000).toBeLessThan(0.02);
        // the floor is the only face labelled generated; the 9 m2 hole is unsupported area inside a measured wall
        expect(Math.abs(m.generatedAreaM2 - 400)).toBeLessThan(12);
        expect(Math.abs(m.groundClosureAreaM2 - 400)).toBeLessThan(12);
        expect(m.unsupportedAreaM2).toBeGreaterThan(400 + 4);
        expect(m.unsupportedAreaM2).toBeLessThan(400 + 9 + 30);
        // the scan lies on the shell, but for the mast
        expect(m.scanWithin05Share).toBeGreaterThan(0.985);
        expect(m.explainedRmsM).toBeLessThan(0.12);   // the skin the shell stands for
        expect(m.scanRmsM).toBeLessThan(0.6);         // all of it, the mast's 6 m included
        // the mast (15 m2 of 0.2 m facets) is no plane: kept as residual scan above the first metre over the roof
        expect(m.residualAreaM2).toBeGreaterThan(9);
        expect(m.residualAreaM2).toBeLessThan(16.5);
        expect(m.buriedAreaM2).toBe(0);

        // every face row: a unit plane, a share in [0, 1], a label that follows the share; generated rows give a reason
        // nine planes bound the block: the floor, the base roof, the top, and six walls (x = 0 and z = 0 serve base and tower alike)
        expect(report.faces.length).toBe(9);
        for (const f of report.faces) {
            expect(Math.abs(Math.hypot(f.plane[0], f.plane[1], f.plane[2]) - 1)).toBeLessThan(1e-6);
            expect(f.supportShare).toBeGreaterThanOrEqual(0);
            expect(f.supportShare).toBeLessThanOrEqual(1);
            expect(f.label).toBe(f.supportShare >= 0.5 ? 'measured' : 'generated');
            if (f.label === 'generated') expect(typeof f.reason).toBe('string');
        }
        const floor = report.faces.find((f: any) => f.label === 'generated' && f.plane[1] < -0.99);
        expect(floor, 'a generated face facing down').toBeDefined();
        const holed = report.faces.find((f: any) => f.plane[0] > 0.99 && f.areaM2 > 150);
        expect(holed, 'the x = 20 wall').toBeDefined();
        expect(holed.label).toBe('measured');
        expect(holed.supportShare).toBeGreaterThan(0.9);
        expect(holed.supportShare).toBeLessThan(0.99);

        // the written GLB, read independently: magic, nodes with their labels, and the welded shell closed with the same volume
        const shellBytes = fs.readFileSync(shellPath);
        expect(shellBytes.readUInt32LE(0)).toBe(0x46546c67);
        const shell = readGlbTriangles(shellBytes);
        const names = shell.nodeRanges.map(r => r.name).sort();
        expect(names).toEqual(['shell_generated', 'shell_measured']);
        for (const r of shell.nodeRanges) {
            expect(r.extras.sb.provenance.label).toBe(r.name === 'shell_measured' ? 'measured' : 'generated');
            expect(r.extras.sb.provenance.measuredGeometry).toBe(r.name === 'shell_measured');
        }
        expect(shell.indices.length / 3).toBe(m.shellTriangles);
        const c = closedness(shell.positions, shell.indices, 0, shell.indices.length / 3);
        expect(c.boundary).toBe(0);
        expect(c.nonManifold).toBe(0);
        expect(Math.abs(c.volume - 5000) / 5000).toBeLessThan(0.02);
        expect(shell.json.extras.shellFit.faces.length).toBe(report.faces.length);

        // shell + residual: the same shell, plus the mast as a measured node
        const combined = readGlbTriangles(fs.readFileSync(combinedPath));
        const residual = combined.nodeRanges.find(r => r.name === 'residual_scan');
        expect(residual).toBeDefined();
        expect(residual!.extras.sb.provenance.label).toBe('measured');
        expect(residual!.triangleCount).toBe(m.residualTriangles);
        // nothing of the block itself is left over as residual: every residual vertex is on the mast (0.4 m round the axis, above the top)
        let lowest = Infinity, farthest = 0;
        for (let t = residual!.firstTriangle; t < residual!.firstTriangle + residual!.triangleCount; t++) for (let k = 0; k < 3; k++) {
            const v = combined.indices[t * 3 + k] * 3;
            lowest = Math.min(lowest, combined.positions[v + 1]);
            farthest = Math.max(farthest, Math.hypot(combined.positions[v] - 5, combined.positions[v + 2] - 5));
        }
        expect(lowest).toBeGreaterThan(19.9);
        expect(farthest).toBeLessThan(0.5);
    }, 180_000);

    it('a clean block needs no residual and no gap closing beyond its floor', async () => {
        const scanPath = path.join(TMP, 'clean.glb'), reportPath = path.join(TMP, 'clean.json');
        fs.writeFileSync(scanPath, steppedBlock({ hole: false, mast: false }).glb());
        const out = await run(['--input', scanPath, '--report', reportPath, '--threads', '2']);
        const m = out.metrics;
        expect(m.boundaryEdges).toBe(0);
        expect(m.nonManifoldEdges).toBe(0);
        expect(Math.abs(m.shellVolumeM3 - 5000) / 5000).toBeLessThan(0.02);
        expect(m.residualTriangles).toBe(0);
        expect(Math.abs(m.unsupportedAreaM2 - 400)).toBeLessThan(25);
        expect(m.scanWithin05Share).toBeGreaterThan(0.999);
    }, 60_000);
});
