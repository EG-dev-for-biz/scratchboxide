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
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
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

describe('facade lattices on a district-sized remesh', () => {
    it('edits a GLB whose binary chunk is larger than a plain JS array can hold (~134 M elements)', () => {
        // one triangle, then 140 MB of other data in the same buffer (a district remesh's positions, normals and textures)
        const N = 140 * 1024 * 1024;
        const bin = new Uint8Array(N);
        const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        bin.set(new Uint8Array(pos.buffer), 0);
        bin.set(new Uint8Array(new Uint32Array([0, 1, 2]).buffer), 36);
        bin[N - 1] = 7;
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
            buffers: [{ byteLength: N }],
            bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: N - 48 }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }, { bufferView: 1, componentType: 5125, count: 3, type: 'SCALAR' }]
        };
        const r = { s: [0, 0.5], t: [0, 0.5], positions: new Float32Array([0, 0, 0.01, 0.5, 0, 0.01, 0, 0.5, 0.01]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uv: new Float32Array(6), indices: new Uint32Array([0, 1, 2]), cells: 1, measuredShare: 1 };
        const out = applyFacadeLattices(assembleGlb(json as never, bin), [{ f, r: r as never }], false);
        expect(out.removed).toBe(1);                                   // the scan's triangle in the facade, made degenerate
        const back = parseGlbBytes(out.glb);
        expect(back.bin.length).toBeGreaterThanOrEqual(N + 36 + 36 + 12);
        expect(back.bin[N - 1]).toBe(7);                                // the original bytes kept, the rebuilt facade after them
        expect(back.json.meshes).toHaveLength(2);
        const idx = new Uint32Array(back.bin.buffer.slice(back.bin.byteOffset + 36, back.bin.byteOffset + 48));
        expect(Array.from(idx)).toEqual([0, 0, 0]);
    });
});

