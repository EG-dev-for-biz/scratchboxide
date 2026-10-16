/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's photometric relief only carves what the photo supports, and labels it as inferred
 * (scratchbox_photometric_relief.hpp), on a synthetic 40 m tower whose +x facade carries a painted texture:
 *  - a regular 10 x 10 window grid: carved, and the GLBs say so (asset.extras.scratchbox.relief, _RELIEF_HEIGHT per vertex);
 *  - the same lattice painted only faintly except at 3 sites: the lattice is not confirmed, nothing is carved
 *    (before the gate those 3 sites became windows);
 *  - one line casting a 0.6 m shadow band: its depth would exceed the 0.35 m clamp, so no band is made (before, it was
 *    emitted at exactly the clamp);
 *  - the grid painted with every window up to 12 cm off its floor line: the carved windows come out on common rows;
 *  - the grid with one window painted faintly and one brighter than the wall: the faint one is filled from the
 *    lattice and labelled periodic-inferred (_LATTICE_CELL 2), the bright one is not.
 * The grid tower's clay render goes to test-results/screenshots/tile_refine_relief_provenance/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, type Glb, quad, flat, writeGlb, readGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-relief-provenance');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_relief_provenance');
const BIN = path.join(WORK, 'tile_refine');

type Paint = 'grid' | 'sparse-lattice' | 'wide-shadow' | 'jitter' | 'gap';

/** The facade texture: 600 x 800 px over 30 x 40 m (5 cm), s along the facade from its -z end, t up. */
function facadeTexture(paint: Paint): Buffer {
    const TW = 600, TH = 800, PX = 0.05;
    const rgb = new Uint8Array(TW * TH * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const strong = new Set(['2,3', '6,7', '8,2']);
    for (let y = 0; y < TH; y++)
        for (let x = 0; x < TW; x++) {
            const s = x * PX, t = 40 - y * PX;
            const col = Math.floor((s - 0.8) / 3.0), sc = s - 0.8 - col * 3.0;
            const row = Math.floor((t - 1.0) / 3.6), tc = t - 1.0 - row * 3.6;
            const inWindow = col >= 0 && col < 10 && row >= 0 && row < 10 && sc < 1.4 && tc < 2.0;
            // jitter: each window painted up to 12 cm off its floor line
            const jit = (((col * 7 + row * 13) % 5) - 2) * 0.06, tj = t - 1.0 - jit - row * 3.6;
            const inJittered = col >= 0 && col < 10 && row >= 0 && row < 10 && sc < 1.4 && tj >= 0 && tj < 2.0;
            let v = 190;
            if (paint === 'wide-shadow') { if (t < 30 && t > 29.4) v = 70; }
            else if (paint === 'jitter') { if (inJittered) v = 55; }
            else if (paint === 'gap') { if (inWindow) v = col === 4 && row === 5 ? 182 : col === 6 && row === 3 ? 215 : 55; }
            else if (inWindow) v = paint === 'grid' || strong.has(`${col},${row}`) ? 55 : 172;
            v += (rnd() - 0.5) * 10;
            for (let c = 0; c < 3; c++) rgb[(y * TW + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
        }
    return encodePng(TW, TH, rgb);
}

/** The carved windows of the clay: connected recessed (x < 9.95) faces facing +x; their centres (y, z). */
function carvedWindows(file: string): { y: number; z: number }[] {
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(file), P = mesh.vertices, T = mesh.indices;
    const key = (i: number) => `${P[3 * i].toFixed(4)},${P[3 * i + 1].toFixed(4)},${P[3 * i + 2].toFixed(4)}`;
    const ids = new Map<string, number>(), parent: number[] = [];
    const id = (i: number) => { const k = key(i); if (!ids.has(k)) { ids.set(k, parent.length); parent.push(parent.length); } return ids.get(k)!; };
    const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const faces: { a: number; area: number; y: number; z: number }[] = [];
    for (let t = 0; t < T.length / 3; t++) {
        const [a, b, c] = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
        if (!(P[3 * a] < 9.95 && P[3 * b] < 9.95 && P[3 * c] < 9.95 && P[3 * a] > 9.6)) continue;
        const e1 = [0, 1, 2].map(k => P[3 * b + k] - P[3 * a + k]), e2 = [0, 1, 2].map(k => P[3 * c + k] - P[3 * a + k]);
        const nx = e1[1] * e2[2] - e1[2] * e2[1], area = 0.5 * Math.hypot(nx, e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        if (area < 1e-6 || nx / (2 * area) < 0.9) continue;
        const [ia, ib, ic] = [id(a), id(b), id(c)];
        parent[find(ib)] = find(ia); parent[find(ic)] = find(ia);
        faces.push({ a: ia, area, y: (P[3 * a + 1] + P[3 * b + 1] + P[3 * c + 1]) / 3, z: (P[3 * a + 2] + P[3 * b + 2] + P[3 * c + 2]) / 3 });
    }
    const acc = new Map<number, { w: number; y: number; z: number }>();
    for (const f of faces) {
        const r = find(f.a), e = acc.get(r) ?? { w: 0, y: 0, z: 0 };
        e.w += f.area; e.y += f.area * f.y; e.z += f.area * f.z;
        acc.set(r, e);
    }
    return [...acc.values()].filter(e => e.w > 0.5).map(e => ({ y: e.y / e.w, z: e.z / e.w }));
}

/** RMS distance of window centres from the median of their row (rows: centres within 1 m of each other). */
function rowRms(wins: { y: number }[]): number {
    const ys = wins.map(w => w.y).sort((a, b) => a - b), rows: number[][] = [];
    for (const y of ys) { if (!rows.length || y - rows[rows.length - 1][rows[rows.length - 1].length - 1] > 1.0) rows.push([]); rows[rows.length - 1].push(y); }
    let s2 = 0;
    for (const r of rows) { const m = r[Math.floor(r.length / 2)]; for (const y of r) s2 += (y - m) ** 2; }
    return Math.sqrt(s2 / ys.length);
}

function run(paint: Paint): { relief: any; clay: Glb; textured: Glb; clayPath: string } {
    const facade: Chunk = quad([10, 0, 15], [0, 0, -30], [0, 40, 0], 10, 10);  // x = 10, normal +x
    facade.uvs = [];
    for (let i = 0; i < facade.positions.length; i += 3) facade.uvs.push((15 - facade.positions[i + 2]) / 30, 1 - facade.positions[i + 1] / 40);
    facade.image = 0;
    const chunks: Chunk[] = [
        flat(-70, 70, -70, 70, 0, 20), facade,
        quad([-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 6), quad([-10, 0, 15], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -15], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -15, 15, 40, 6)
    ];
    const input = path.join(WORK, `${paint}.glb`), clay = path.join(WORK, `${paint}_clay.glb`), textured = path.join(WORK, `${paint}_textured.glb`);
    const statsPath = path.join(WORK, `${paint}_stats.json`);
    writeGlb(input, chunks, [facadeTexture(paint)]);
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--out-clay', clay, '--out-textured', textured, '--stats', statsPath, '--threads', '4'],
        { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    const pose = { x: 48, y: 22, z: 30, targetX: 10, targetY: 20, targetZ: 0, fov: 50 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, 800, 600, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.6, 0.5, 0.6] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `${paint}_clay.png`), 800, 600, img.rgba);
    return { relief: JSON.parse(fs.readFileSync(statsPath, 'utf8')).relief, clay: readGlb(clay), textured: readGlb(textured), clayPath: clay };
}

describe('tile_refine photometric relief: evidence and provenance', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
    }, 620_000);

    it('carves a confirmed window grid and labels it inferred, per vertex and per file', () => {
        const { relief, clay, textured } = run('grid');
        expect(relief.regionsTreated).toBe(1);
        expect(relief.provenance).toBe('inferred');
        expect(relief.recessArea_m2).toBeGreaterThan(150);
        expect(relief.facades[0].latticeConfirmation).toBeGreaterThan(0.8);
        for (const glb of [clay, textured]) {
            const extras = glb.json.asset.extras?.scratchbox?.relief;
            expect(extras?.provenance).toBe('inferred');
            expect(extras?.attribute).toBe('_RELIEF_HEIGHT');
            const heights = glb.attribute('_RELIEF_HEIGHT');
            expect(heights.length).toBeGreaterThan(0);
            const all = heights.flatMap(h => Array.from(h));
            const displaced = all.filter(h => h !== 0);
            expect(displaced.length).toBeGreaterThan(100);
            expect(Math.min(...displaced)).toBeGreaterThanOrEqual(relief.facades[0].minHeight_m - 1e-6);
            expect(Math.max(...all.map(Math.abs))).toBeCloseTo(extras.maxAbsHeight_m, 5);
        }
        // the clay has one vertex per (position, normal): every position the relief displaced is in it
        expect(clay.json.asset.extras.scratchbox.relief.displacedVertices).toBeGreaterThan(100);
        // one lattice on the facade plane: every window observed, none inferred; the clay labels them observed
        expect(relief.facadesFromWallPlanes).toBe(true);
        expect(relief.recessDepthSource).toBe('photo-contrast');
        const lattice = relief.lattices[0];
        expect(lattice.rows).toBe(10);
        expect(lattice.cols).toBeGreaterThanOrEqual(8);
        expect(lattice.observedCells).toBeGreaterThanOrEqual(80);
        expect(lattice.inferredCells).toBe(0);
        expect(lattice.rowResidualRms_m).toBeLessThan(0.01);
        const [cell] = clay.attribute('_LATTICE_CELL'), [height] = clay.attribute('_RELIEF_HEIGHT');
        for (let i = 0; i < cell.length; i++) expect(cell[i]).toBe(height[i] < 0 ? 1 : 0);
    }, 300_000);

    it('puts windows painted off their floor line back on common rows', () => {
        const { relief, clayPath } = run('jitter');
        const lattice = relief.lattices[0];
        expect(lattice.rows).toBe(10);
        expect(lattice.offGridCells).toBe(0);
        expect(lattice.rowResidualRms_m).toBeGreaterThan(0.03);   // the cells did move...
        expect(lattice.rowResidualMax_m).toBeLessThanOrEqual(0.25 * lattice.windowHeight_m);  // ...within the bound
        const wins = carvedWindows(clayPath);
        expect(wins.length).toBeGreaterThanOrEqual(80);
        expect(rowRms(wins)).toBeLessThan(0.01);
    }, 300_000);

    it('fills a faint window from the lattice as periodic-inferred, and not one the photo shows as wall', () => {
        const { relief, clay } = run('gap');
        const lattice = relief.lattices[0];
        expect(lattice.filled).toBe(true);
        expect(lattice.inferredCells).toBe(1);
        expect(lattice.inferredContradicted).toBeGreaterThanOrEqual(1);
        const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(path.join(WORK, 'gap_clay.glb'));
        const [cell] = clay.attribute('_LATTICE_CELL'), [height] = clay.attribute('_RELIEF_HEIGHT');
        let inferred = 0;
        for (let i = 0; i < cell.length; i++) {
            const [y, z] = [mesh.vertices[3 * i + 1], mesh.vertices[3 * i + 2]];
            if (cell[i] === 2) {
                ++inferred;
                expect(y).toBeGreaterThan(18.9); expect(y).toBeLessThan(21.1);   // window (column 4, row 5)
                expect(z).toBeGreaterThan(0.7); expect(z).toBeLessThan(2.3);
            }
            if (y > 11.8 && y < 13.8 && z > -5.2 && z < -3.8) expect(height[i]).toBe(0);  // window (6, 3) stays wall
        }
        expect(inferred).toBeGreaterThan(0);
    }, 300_000);

    it('does not carve a lattice confirmed at only 3 of its sites', () => {
        const { relief, clay } = run('sparse-lattice');
        expect(relief.latticesRejected).toBe(1);
        expect(relief.latticeFeaturesDropped).toBe(3);
        expect(relief.regionsTreated).toBe(0);
        expect(relief.recessArea_m2).toBe(0);
        expect(relief.provenance).toBe('none');
        expect(clay.json.asset.extras?.scratchbox?.relief).toBeUndefined();
        expect(clay.attribute('_RELIEF_HEIGHT')).toHaveLength(0);
    }, 300_000);

    it('drops a shadowed band whose depth would exceed the clamp instead of emitting the clamp', () => {
        const { relief, clay } = run('wide-shadow');
        expect(relief.proudClampedDropped).toBeGreaterThanOrEqual(1);
        expect(relief.proudArea_m2).toBe(0);
        expect(relief.heightMax_m).toBeLessThan(0.35 - 1e-6);
        expect(clay.attribute('_RELIEF_HEIGHT')).toHaveLength(0);
    }, 300_000);
});
