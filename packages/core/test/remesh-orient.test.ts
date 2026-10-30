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
import { findInwardTriangles, orientRemesh } from '../src/node/3d-engine/staged-location/remesh-orient';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';

/** A 10 x 30 x 10 m box wound outward, each side a 1 m grid; the +x side wound inward when `inward`. */
function box(inward: boolean): Float32Array {
    const out: number[] = [];
    // a side: origin o, axes a and b (a x b points outward), sizes na x nb metres
    const side = (o: number[], a: number[], b: number[], na: number, nb: number, flip: boolean) => {
        for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
            const p = (x: number, y: number) => [0, 1, 2].map(k => o[k] + a[k] * x + b[k] * y);
            const q = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
            const tris = flip ? [[0, 2, 1], [0, 3, 2]] : [[0, 1, 2], [0, 2, 3]];
            for (const t of tris) for (const v of t) out.push(...q[v]);
        }
    };
    side([10, 0, 0], [0, 0, -1], [0, 1, 0], 10, 30, inward); // +x: (0,0,-1) x (0,1,0) = (1,0,0)
    side([0, 0, -10], [0, 0, 1], [0, 1, 0], 10, 30, false); // -x
    side([0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 30, false); // +z
    side([10, 0, -10], [-1, 0, 0], [0, 1, 0], 10, 30, false); // -z
    side([0, 30, 0], [1, 0, 0], [0, 0, -1], 10, 10, false); // top
    side([0, 0, -10], [1, 0, 0], [0, 0, 1], 10, 10, false); // bottom
    return Float32Array.from(out);
}

function glb(soup: Float32Array): Buffer {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orient-')), 'scan.glb');
    writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
    return fs.readFileSync(file);
}

/** The +x side's triangles' outward component of their winding normal, all of them. */
function plusXFacing(bytes: Uint8Array): number[] {
    const g = parseGlbBytes(bytes), p = g.json.meshes[0].primitives[0];
    const P = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
    const out: number[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
        const v = [I[t], I[t + 1], I[t + 2]].map(i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
        if (!v.every(c => Math.abs(c[0] - 10) < 1e-6)) continue;
        const u = [0, 1, 2].map(k => v[1][k] - v[0][k]), w = [0, 1, 2].map(k => v[2][k] - v[0][k]);
        out.push(u[1] * w[2] - u[2] * w[1]);
    }
    return out;
}

describe('remesh turned to face outward', () => {
    it('turns the side wound inward and only it, in the clay and the twin alike, leaving nothing to turn', () => {
        const bytes = glb(box(true));
        const { keys, stats } = findInwardTriangles(bytes);
        expect(stats.turned).toBe(600);
        expect(keys.size).toBe(600);
        const o = orientRemesh(bytes, [bytes]);
        for (const out of [o.clay, o.others[0]]) {
            const fx = plusXFacing(out);
            expect(fx).toHaveLength(600);
            expect(fx.every(x => x > 0)).toBe(true);
            expect(findInwardTriangles(out).stats.turned).toBe(0);
        }
    });

    it('leaves a closed outward box as it is, and a free sheet seen from both sides', () => {
        expect(findInwardTriangles(glb(box(false))).stats.turned).toBe(0);
        // a 10 x 10 m sheet standing alone: its front seen from one side, its back from the other
        const sheet: number[] = [];
        for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) sheet.push(i, j, 0, i + 1, j, 0, i + 1, j + 1, 0, i, j, 0, i + 1, j + 1, 0, i, j + 1, 0);
        expect(findInwardTriangles(glb(Float32Array.from(sheet))).stats.turned).toBe(0);
    });

    it('leaves a surface seen only from behind that faces open air (an overhang\'s underside, a hole\'s far side)', () => {
        // a 10 x 10 m sheet at 20 m facing straight down: the views from above see only its back, the way it faces is open
        const under: number[] = [];
        for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) under.push(i, 20, j, i + 1, 20, j, i + 1, 20, j + 1, i, 20, j, i + 1, 20, j + 1, i, 20, j + 1);
        const r = findInwardTriangles(glb(Float32Array.from(under)));
        expect(r.stats.turned).toBe(0);
        expect(r.stats.facingOut).toBeGreaterThan(0);
    });

    it("leaves the infill's caps out: a cap lying on an inward side neither hides it nor is turned with it", () => {
        // the inward +x side, and an outward cap (sbSeal) over its lower cells, 1 cm proud
        const cap: number[] = [];
        for (let i = 0; i < 10; i++) for (let j = 0; j < 5; j++) {
            const p = (a: number, b: number) => [10.01, b, -a];
            const q = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
            for (const t of [[0, 1, 2], [0, 2, 3]]) for (const v of t) cap.push(...q[v]);
        }
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orient-')), 'scan.glb');
        const box1 = box(true);
        writeStagedGlbFile(file, [
            { name: 'scan', positions: box1, indices: Uint32Array.from({ length: box1.length / 3 }, (_, i) => i) },
            { name: 'Seal', positions: Float32Array.from(cap), indices: Uint32Array.from({ length: cap.length / 3 }, (_, i) => i), extras: { sbSeal: { version: 'test' } } }
        ], {});
        const r = findInwardTriangles(fs.readFileSync(file));
        // every cell of the inward side is found, the capped ones too
        expect(r.stats.turned).toBe(600);
    });
});
