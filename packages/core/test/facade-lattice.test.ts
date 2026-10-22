/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facades rebuilt on their photo's lines (facade-lattice.ts): a facade photo with a grid of dark windows and a noisy scan
 * in which those windows are recessed 0.3 m; the lattice finds the window edges in the photo, the windows take one recess
 * averaged over the storey (not each window's noise), the wall stays on the plane, the scan's facade triangles are made
 * degenerate and the rebuilt facade appended (textured with the facade photo in the twin).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyFacadeLattices, facadeSamples, latticeFacade, photoLattice, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbTriangles } from './helpers/clay-glb-render';

// a facade in the plane z = 0 facing +z: s along +x (0..12 m), t up (0..9 m); windows 1.2 m wide every 3 m, 1.6 m tall on 3 storeys
const PX = 0.1, W = 120, H = 90;
const f: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
const isWindow = (s: number, t: number) => { const ss = s % 3, tt = t % 3; return ss > 0.9 && ss < 2.1 && tt > 0.7 && tt < 2.3; };

function photo(): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (x + 0.5) * PX, t = 9 - (y + 0.5) * PX, v = isWindow(s, t) ? 40 : 200;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
    }
    return { rgba, width: W, height: H };
}

/** The scan: a 0.25 m grid surface at depth -0.3 in the windows and 0 elsewhere, plus +-6 cm noise, as triangle soup. */
function scan(): Float32Array {
    const out: number[] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.12;
    const z = (s: number, t: number) => (isWindow(s, t) ? -0.3 : 0) + rnd();
    for (let s = 0; s < 12; s += 0.25) for (let t = 0; t < 9; t += 0.25) {
        const a = [s, t, z(s, t)], b = [s + 0.25, t, z(s + 0.25, t)], c = [s + 0.25, t + 0.25, z(s + 0.25, t + 0.25)], d = [s, t + 0.25, z(s, t + 0.25)];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    return Float32Array.from(out);
}

describe('facades on their photo lattice', () => {
    it('finds the window edges in the photo', () => {
        const { s, t } = photoLattice(photo(), f);
        for (const edge of [0.9, 2.1, 3.9, 5.1]) expect(s.some(v => Math.abs(v - edge) <= 0.15)).toBe(true);
        for (const edge of [0.7, 2.3, 3.7, 5.3]) expect(t.some(v => Math.abs(v - edge) <= 0.15)).toBe(true);
    });

    it('gives the windows one averaged recess and keeps the wall on the plane', () => {
        const r = latticeFacade(f, photo(), facadeSamples(scan(), f))!;
        expect(r).toBeDefined();
        expect(r.measuredShare).toBeGreaterThan(0.9);
        // the cell holding the centre of the window at s 1.5, t 1.5, and a wall cell at s 0.4, t 2.8
        const cell = (sv: number, tv: number) => r.depth[r.t.findIndex((x, i) => tv >= x && tv < r.t[i + 1])][r.s.findIndex((x, i) => sv >= x && sv < r.s[i + 1])];
        expect(cell(1.5, 1.5)).toBeCloseTo(-0.3, 1);
        expect(cell(7.5, 4.5)).toBeCloseTo(-0.3, 1);
        expect(Math.abs(cell(0.4, 2.8))).toBeLessThan(0.05);
        // every window in a storey has the same depth (averaged, not each window's noise)
        const storey = [1.5, 4.5, 7.5, 10.5].map(sv => cell(sv, 1.5));
        expect(new Set(storey).size).toBe(1);
        expect(r.indices.length).toBeGreaterThan(0);
    });

    it('replaces the scan facade in the clay and the twin, the twin textured with the facade photo', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-'));
        const soup = scan();
        const file = path.join(dir, 'clay.glb');
        writeStagedGlbFile(file, [{ name: 'scan', positions: soup, indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) }], {});
        const bytes = fs.readFileSync(file);
        const r = latticeFacade(f, photo(), facadeSamples(soup, f))!;
        const png = Buffer.from('89504e470d0a1a0a', 'hex');
        const clay = applyFacadeLattices(bytes, [{ f, r }], false), twin = applyFacadeLattices(bytes, [{ f, r, png }], true);
        expect(clay.removed).toBe(soup.length / 9);
        const t = readGlbTriangles(clay.glb);
        let live = 0;
        for (let i = 0; i < t.indices.length; i += 3) if (!(t.indices[i] === t.indices[i + 1] && t.indices[i + 1] === t.indices[i + 2])) live++;
        expect(live).toBe(r.indices.length / 3);
        const tj = parseGlbBytes(twin.glb).json;
        expect(tj.materials.at(-1).name).toBe('FacadeLattice_7');
        expect(tj.images.at(-1).mimeType).toBe('image/png');
        expect(tj.nodes.at(-1).extras.sbFacadeLattice.provenance.lines).toBe('photo-inferred');
    });
});
