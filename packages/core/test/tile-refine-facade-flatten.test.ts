/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's facade flatten (scratchbox_tile_refine.hpp, facadeFlatten) on a synthetic scan with a known answer: a
 * 60 m tower whose +x facade (the plane x = 10) is crinkled like a photogrammetric wall, 0.3 m wide vertical sliver
 * strips whose vertices sit a deterministic pseudo-random -6..+6 cm off the plane. In front of it stand a 0.25 m deep
 * pilaster, a 0.6 m belt course and a 1.2 m cornice, all deeper than the 0.10 m band. The flattened facade must be one
 * plane with no folds left, the features must stay where they are, and nothing may flip or open. The same scan with
 * --no-flatten keeps its crinkle, so the checks see the pass's own work. Clay renders go to
 * test-results/screenshots/tile_refine_facade_flatten/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, quad, flat, writeGlb, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-facade-flatten');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_facade_flatten');
const BIN = path.join(WORK, 'tile_refine');

/** A closed axis-aligned box, every face wound outward. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n = 2): Chunk[] {
    const h = y1 - y0;
    return [
        quad([x1, y0, z1], [0, 0, z0 - z1], [0, h, 0], n, n),  // +x
        quad([x0, y0, z0], [0, 0, z1 - z0], [0, h, 0], n, n),  // -x
        quad([x0, y0, z1], [x1 - x0, 0, 0], [0, h, 0], n, n),  // +z
        quad([x1, y0, z0], [x0 - x1, 0, 0], [0, h, 0], n, n),  // -z
        flat(x0, x1, z0, z1, y1, n),                           // +y
        quad([x0, y0, z0], [x1 - x0, 0, 0], [0, 0, z1 - z0], n, n)  // -y
    ];
}

/** The crinkled facade: x = 10 + noise over z -10..10 in 0.3 m columns and rows at 0, 19, 38, 57, 60 (normal +x). */
function crinkled(): Chunk {
    const zs: number[] = [];
    for (let z = -10; z < 10 - 1e-9; z += 0.3) zs.push(z);
    zs.push(10);
    const ys = [0, 19, 38, 57, 60];
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const positions: number[] = [], indices: number[] = [];
    for (let j = 0; j < ys.length; j++)
        for (let k = 0; k < zs.length; k++) {
            const edge = k === 0 || k === zs.length - 1;  // the corner columns stay on the box so the side walls meet them
            positions.push(10 + (edge ? 0 : (rnd() - 0.5) * 0.12), ys[j], zs[k]);
        }
    const W = zs.length;
    for (let j = 0; j + 1 < ys.length; j++)
        for (let k = 0; k + 1 < W; k++) {
            const a = j * W + k, b = a + 1, c = a + W, d = c + 1;
            indices.push(a, d, b, a, c, d);
        }
    return { positions, indices };
}

function scan(): Chunk[] {
    const ground = flat(-70, 70, -70, 70, 0, 70);
    const tower = [
        quad([-10, 0, -10], [0, 0, 20], [0, 60, 0], 6, 6),   // -x
        quad([-10, 0, 10], [20, 0, 0], [0, 60, 0], 6, 6),    // +z
        quad([10, 0, -10], [-20, 0, 0], [0, 60, 0], 6, 6),   // -z
        flat(-10, 10, -10, 10, 60, 6),
        crinkled()
    ];
    const pilaster = box(10.0, 10.25, 0, 57, 2, 4);
    const belt = box(10.0, 10.6, 20, 20.5, -10, 10);
    const cornice = box(10.0, 11.2, 58, 58.6, -10.5, 10.5);
    return [ground, ...tower, ...pilaster, ...belt, ...cornice];
}

interface Mesh { vertices: Float32Array; indices: Uint32Array }

function run(name: string, extra: string[]): { stats: any; clay: Mesh; raw: Mesh } {
    const input = path.join(WORK, `${name}.glb`), clay = path.join(WORK, `${name}_clay.glb`), raw = path.join(WORK, `${name}_raw_clay.glb`);
    const statsPath = path.join(WORK, `${name}_stats.json`);
    writeGlb(input, scan());
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--out-clay', clay, '--out-raw-clay', raw, '--stats', statsPath,
        '--threads', '4', '--no-relief', ...extra], { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    // grazing light along the facade shows every fold
    const p = { x: 40, y: 38, z: 34, targetX: 10, targetY: 30, targetZ: 0, fov: 50 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, p, 800, 600, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.15, 0.3, 0.94] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `${name}_clay.png`), 800, 600, img.rgba);
    return { stats: JSON.parse(fs.readFileSync(statsPath, 'utf8')), clay: mesh, raw: HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(raw) };
}

/**
 * The crinkled field (faces turned less than 25 degrees from +x near x = 10, away from the pilaster, the belt and the
 * cornice): the largest residual of its vertices from their least-squares plane x = a y + b z + c, and the length of
 * its interior edges folded between 2 and 30 degrees.
 */
function field(mesh: Mesh): { faces: number; maxPlaneResidual: number; foldLength: number } {
    const P = mesh.vertices, T = mesh.indices;
    const cosLimit = Math.cos(25 * Math.PI / 180);
    const faces: number[] = [], normals = new Map<number, [number, number, number]>();
    for (let t = 0; t < T.length / 3; t++) {
        const [a, b, c] = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
        const e1 = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
        const e2 = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
        const n: [number, number, number] = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const l = Math.hypot(...n);
        if (l < 2e-6) continue;
        const cx = (P[3 * a] + P[3 * b] + P[3 * c]) / 3, cy = (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3, cz = (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3;
        const inField = n[0] / l > cosLimit && cx > 9.85 && cx < 10.15 && cy > 1 && cy < 56.5 && !(cy > 19.5 && cy < 21) &&
            ((cz > -9.7 && cz < 1.7) || (cz > 4.3 && cz < 9.7));
        if (!inField) continue;
        faces.push(t);
        normals.set(t, [n[0] / l, n[1] / l, n[2] / l]);
    }
    const key = (i: number) => `${P[3 * i]},${P[3 * i + 1]},${P[3 * i + 2]}`;
    const edges = new Map<string, { faces: number[]; length: number }>();
    const fv: number[][] = [];
    for (const t of faces)
        for (let j = 0; j < 3; j++) {
            const a = T[3 * t + j], b = T[3 * t + (j + 1) % 3];
            fv.push([P[3 * a], P[3 * a + 1], P[3 * a + 2]]);
            const ka = key(a), kb = key(b), k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
            const e = edges.get(k) ?? { faces: [], length: Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]) };
            e.faces.push(t);
            edges.set(k, e);
        }
    let foldLength = 0;
    for (const e of edges.values()) {
        if (e.faces.length !== 2) continue;
        const [n1, n2] = [normals.get(e.faces[0])!, normals.get(e.faces[1])!];
        const angle = Math.acos(Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]))) * 180 / Math.PI;
        if (angle >= 2 && angle <= 30) foldLength += e.length;
    }
    // least squares x = a y + b z + c (Cramer's rule on the normal equations)
    let Syy = 0, Syz = 0, Szz = 0, Sy = 0, Sz = 0, Sx = 0, Sxy = 0, Sxz = 0;
    for (const [x, y, z] of fv) { Syy += y * y; Syz += y * z; Szz += z * z; Sy += y; Sz += z; Sx += x; Sxy += x * y; Sxz += x * z; }
    const A = [[Syy, Syz, Sy], [Syz, Szz, Sz], [Sy, Sz, fv.length]], rhs = [Sxy, Sxz, Sx];
    const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(A);
    const [pa, pb, pc] = [0, 1, 2].map(c => det3(A.map((r, ri) => r.map((v, ci) => (ci === c ? rhs[ri] : v)))) / D);
    const maxPlaneResidual = Math.max(...fv.map(([x, y, z]) => Math.abs(x - (pa * y + pb * z + pc))));
    return { faces: faces.length, maxPlaneResidual, foldLength };
}

/** The largest x among the output vertices that pass the test (the front of a feature). */
function front(mesh: Mesh, test: (x: number, y: number, z: number) => boolean): number {
    let m = -Infinity;
    for (let i = 0; i < mesh.vertices.length; i += 3) if (test(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2])) m = Math.max(m, mesh.vertices[i]);
    return m;
}

describe('tile_refine facade flatten', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
    }, 620_000);

    it('flattens a crinkled facade onto one plane and keeps the features in front of it', () => {
        const off = run('crinkled_tower_no_flatten', ['--no-flatten']);
        const on = run('crinkled_tower', []);
        const raw = field(on.raw), before = field(off.clay), after = field(on.clay);

        // the scan is crinkled and the rest of the pipeline leaves it so
        expect(raw.faces).toBeGreaterThan(250);
        expect(raw.maxPlaneResidual).toBeGreaterThan(0.05);
        expect(before.maxPlaneResidual).toBeGreaterThan(0.03);
        expect(before.foldLength).toBeGreaterThan(0.5 * raw.foldLength);
        expect(off.stats.flatten).toBeUndefined();

        // flattened: one plane, no folds
        const f = on.stats.flatten;
        expect(f.band_m).toBeCloseTo(0.1, 9);
        expect(f.planes).toBeGreaterThanOrEqual(4);
        expect(f.movedGroups).toBeGreaterThan(300);
        expect(f.displacement_m.max).toBeLessThanOrEqual(2 * 0.1 + 1e-6);
        expect(after.faces).toBeGreaterThan(0.9 * raw.faces);
        expect(after.maxPlaneResidual).toBeLessThan(0.002);
        expect(after.foldLength).toBeLessThan(0.02 * raw.foldLength);

        // features deeper than the band stay
        expect(front(on.clay, (x, y, z) => z > 2.2 && z < 3.8 && y > 27 && y < 30)).toBeCloseTo(10.25, 2);
        expect(front(on.clay, (x, y, z) => y > 20.1 && y < 20.4 && Math.abs(z) < 9)).toBeCloseTo(10.6, 2);
        expect(front(on.clay, (x, y, z) => y > 58.1 && y < 58.5 && Math.abs(z) < 9)).toBeCloseTo(11.2, 2);

        // nothing flips or opens
        expect(f.guardSettled).toBe(true);
        expect(f.flipsVsRaw).toBe(0);
        expect(f.flipsVsRectified).toBe(0);
        expect(f.openEdgesAfter.newBoundaryEdges).toBe(0);
        expect(on.stats.rectify.flips).toBe(0);
        expect(on.stats.openEdges.final.newBoundaryEdges).toBe(0);
    }, 300_000);
});
