/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The remeshed scan cleaned before texturing (remesh-cleanup.ts): on a noisy box with a sharp corner and a loose scrap,
 * the scrap goes, the walls come out flatter, the corner stays square, no vertex moves past the cap, and a second GLB of
 * the same remesh (the textured twin) gets exactly the same edits.
 */

import { describe, expect, it } from 'vitest';
import { cleanRemesh, REMESH_CLEANUP_PARAMS } from '../src/node/3d-engine/staged-location/remesh-cleanup';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Two walls of a box meeting at a right angle along x = 0, z = 0 (each 10 m long, 8 m tall), a 0.5 m grid with noise. */
function noisyCorner(): { positions: number[]; indices: number[] } {
    const positions: number[] = [], indices: number[] = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.24;   // +-0.12 m
    const grid = (pt: (u: number, v: number) => [number, number, number], nu: number, nv: number, noisy: (u: number) => boolean) => {
        const base = positions.length / 3;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
            const [x, y, z] = pt(i * 0.5, j * 0.5);
            const n = noisy(i) && j > 0 && j < nv ? rnd() : 0;
            // the noise is across the wall: in z on wall A (z = 0), in x on wall B (x = 0)
            positions.push(z === 0 ? x : x + n, y, z === 0 ? z + n : z);
        }
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i; indices.push(a, a + 1, a + nu + 2, a, a + nu + 2, a + nu + 1); }
    };
    // wall A along +x at z = 0 (noise in z), wall B along +z at x = 0 (noise in x); the corner column (i = 0) noise-free on both
    grid((u, v) => [u, v, 0], 20, 16, i => i > 0);
    grid((u, v) => [0, v, u], 20, 16, i => i > 0);
    return { positions, indices };
}

function writeGlb(file: string, positions: number[], indices: number[]): Buffer {
    writeStagedGlbFile(file, [{ name: 'scan', positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }], {});
    return fs.readFileSync(file);
}

describe('remesh cleanup', () => {
    it('removes the scrap, flattens the walls, keeps the corner, caps the shift, edits both GLBs alike', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remesh-clean-'));
        const m = noisyCorner();
        // a loose scrap floating off the wall: one 0.8 m triangle
        const s = m.positions.length / 3;
        m.positions.push(4, 9, 2, 4.8, 9, 2, 4, 9.6, 2);
        m.indices.push(s, s + 1, s + 2);
        const clay = writeGlb(path.join(dir, 'clay.glb'), m.positions, m.indices);
        const twin = writeGlb(path.join(dir, 'twin.glb'), m.positions, m.indices);
        const r = cleanRemesh(clay, [twin]);
        expect(r.stats.piecesRemoved).toBe(1);
        expect(r.stats.trianglesRemoved).toBe(1);
        expect(r.stats.maxShiftM).toBeLessThanOrEqual(REMESH_CLEANUP_PARAMS.maxShiftM + 1e-6);
        const after = readGlbTriangles(r.clay), before = readGlbTriangles(clay), twinAfter = readGlbTriangles(r.others[0]);
        // the twin's vertices are the clay's, exactly
        expect(Array.from(twinAfter.positions)).toEqual(Array.from(after.positions));
        // flatter: the distance of wall A's interior vertices from z = 0, and wall B's from x = 0
        const rms = (p: Float32Array) => {
            let s2 = 0, n = 0;
            for (let v = 0; v < p.length / 3; v++) {
                const x = p[v * 3], z = p[v * 3 + 2];
                if (Math.abs(z) < 0.5 && x > 1 && x < 9) { s2 += z * z; n++; }
                else if (Math.abs(x) < 0.5 && z > 1 && z < 9) { s2 += x * x; n++; }
            }
            return Math.sqrt(s2 / n);
        };
        expect(rms(after.positions)).toBeLessThan(rms(before.positions) * 0.6);
        // the corner column stays where it was (within 5 cm): the right angle is not rounded
        for (let v = 0; v < after.positions.length / 3; v++) {
            const x0 = before.positions[v * 3], z0 = before.positions[v * 3 + 2];
            if (x0 === 0 && z0 === 0) expect(Math.hypot(after.positions[v * 3], after.positions[v * 3 + 2])).toBeLessThan(0.05);
        }
        // the scrap's triangle is degenerate in both
        let degenerate = 0;
        for (let t = 0; t < after.indices.length; t += 3) if (after.indices[t] === after.indices[t + 1] && after.indices[t + 1] === after.indices[t + 2]) degenerate++;
        expect(degenerate).toBe(1);
    });

    it('pulls a lone spike back (when switched on) to the surface and leaves a clean grid, a box and its edges alone', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-spike-'));
        // a flat 10 x 10 m floor on a 0.5 m grid, its centre vertex raised 1.5 m
        const flat = (spike: boolean) => {
            const positions: number[] = [], indices: number[] = [], n = 20;
            for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i * 0.5, spike && i === 10 && j === 10 ? 1.5 : 0, j * 0.5);
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; indices.push(a, a + n + 2, a + 1, a, a + n + 1, a + n + 2); }
            return { positions, indices };
        };
        const R = { ...REMESH_CLEANUP_PARAMS, spikeK: 4 };
        const spiked = flat(true), out = cleanRemesh(writeGlb(path.join(dir, 's.glb'), spiked.positions, spiked.indices), [], R);
        expect(out.stats.spikeVertices).toBe(1);
        const after = readGlbTriangles(out.clay);
        let top = -Infinity;
        for (let v = 1; v < after.positions.length; v += 3) top = Math.max(top, after.positions[v]);
        expect(top).toBeLessThan(0.15);
        // nothing to pull on a clean floor, nor on the noisy corner's two walls and their shared edge
        const clean = flat(false);
        expect(cleanRemesh(writeGlb(path.join(dir, 'c.glb'), clean.positions, clean.indices), [], R).stats.spikeVertices).toBe(0);
        const corner = noisyCorner(), c = cleanRemesh(writeGlb(path.join(dir, 'k.glb'), corner.positions, corner.indices), [], R);
        expect(c.stats.spikeVertices!).toBeLessThan(0.01 * c.stats.vertices);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
