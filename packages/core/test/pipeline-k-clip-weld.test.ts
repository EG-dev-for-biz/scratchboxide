/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The building clipped to its footprint (every surface cut at the outline plus the margin, at any height, attributes carried,
 * the openings closed by the infill). The tiles' seams are closed by the seam stage (tile-seam-weld.test.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { clipToFootprint, fillOpenLoops } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { BASE_CLEANUP_PARAMS, cleanBase } from '../src/node/3d-engine/staged-location/pipeline-k/base-cleanup';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { readGlbTriangles } from './helpers/clay-glb-render';

type V = [number, number, number];
const quad = (a: V, b: V, c: V, d: V): number[] => [...a, ...b, ...c, ...a, ...c, ...d];
const footprint: Array<Array<[number, number]>> = [[[0, 0], [10, 0], [10, 10], [0, 10]]];

function glbOf(soup: number[], uv?: number[]): Uint8Array {
    if (!uv) {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clip-')), 'm.glb');
        const positions = Float32Array.from(soup);
        writeStagedGlbFile(file, [{ name: 'scan', positions, indices: Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) }], {});
        return fs.readFileSync(file);
    }
    // a textured soup by hand: POSITION, TEXCOORD_0, indices
    const P = Float32Array.from(soup), U = Float32Array.from(uv), I = Uint32Array.from({ length: P.length / 3 }, (_, i) => i);
    const parts = [P, U, I].map(a => new Uint8Array(a.buffer));
    const bin = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
    let o = 0;
    const bufferViews = parts.map(b => { bin.set(b, o); const v = { buffer: 0, byteOffset: o, byteLength: b.length }; o += b.length; return v; });
    return assembleGlb({
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, mode: 4 }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: U.length / 2, type: 'VEC2' }, { bufferView: 2, componentType: 5125, count: I.length, type: 'SCALAR' }],
        bufferViews, buffers: [{ byteLength: bin.length }]
    }, bin);
}

/** Live triangles (corners) of a GLB. */
function live(bytes: Uint8Array): V[][] {
    const t = readGlbTriangles(bytes), out: V[][] = [];
    for (let i = 0; i + 2 < t.indices.length; i += 3) {
        const ids = [t.indices[i], t.indices[i + 1], t.indices[i + 2]];
        if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
        out.push(ids.map(k => [t.positions[k * 3], t.positions[k * 3 + 1], t.positions[k * 3 + 2]] as V));
    }
    return out;
}
const area = (t: V[]) => { const u = [t[1][0] - t[0][0], t[1][1] - t[0][1], t[1][2] - t[0][2]], v = [t[2][0] - t[0][0], t[2][1] - t[0][1], t[2][2] - t[0][2]]; return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2; };

describe('the building clipped to its footprint', () => {
    it('cuts a wall running past the footprint exactly at the outline plus the margin, at any height, and drops a jagged plane outside', () => {
        const m = BASE_CLEANUP_PARAMS.clipMarginM;
        // the front wall (z = 0) runs on 4 m past the footprint's right edge, up to 30 m; a flat jagged plane sticks out 3 m beyond the left edge
        const wall = quad([0, 0, 0], [14, 0, 0], [14, 30, 0], [0, 30, 0]);
        const jag = [-4, 5, 2, -1.2, 18, 7, -1.1, 2, 9];
        const r = clipToFootprint(glbOf([...wall, ...jag]), footprint, m);
        const tris = live(r.glb);
        // nothing stands past the outline plus the margin
        for (const t of tris) for (const p of t) { expect(p[0]).toBeLessThanOrEqual(10 + m + 1e-6); expect(p[0]).toBeGreaterThanOrEqual(-m - 1e-6); }
        // the wall kept up to the cut, its full height: (10 + m) x 30
        expect(tris.reduce((a, t) => a + area(t), 0)).toBeCloseTo((10 + m) * 30, 3);
        expect(r.report.cutTriangles).toBeGreaterThan(0);
        expect(r.report.removedTriangles).toBe(1);
    });

    it('carries the texture coordinates through the cut', () => {
        const wall = quad([0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]);
        // u runs with x over 0..20 m
        const uv = [0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0];
        const r = clipToFootprint(glbOf(wall, uv), footprint, 0);
        const g = parseGlbBytes(r.glb);
        let checked = 0;
        for (const mesh of g.json.meshes) for (const p of mesh.primitives) {
            if (!p.extras?.sbFootprintClip) continue;
            const P = readAccessor(g, p.attributes.POSITION).data, U = readAccessor(g, p.attributes.TEXCOORD_0).data;
            for (let i = 0; i < P.length / 3; i++) { expect(U[i * 2]).toBeCloseTo(P[i * 3] / 20, 5); checked++; }
        }
        expect(checked).toBeGreaterThan(0);
    });

    it('leaves the opening it cuts for the infill to close', () => {
        // a box 14 m long cut at x = 10: its far end goes, leaving an open rim the fill closes
        const box = [
            ...quad([0, 0, 0], [14, 0, 0], [14, 10, 0], [0, 10, 0]), ...quad([14, 0, 10], [0, 0, 10], [0, 10, 10], [14, 10, 10]),
            ...quad([0, 0, 10], [0, 0, 0], [0, 10, 0], [0, 10, 10]), ...quad([14, 0, 0], [14, 0, 10], [14, 10, 10], [14, 10, 0]),
            ...quad([0, 10, 0], [14, 10, 0], [14, 10, 10], [0, 10, 10]), ...quad([0, 0, 10], [14, 0, 10], [14, 0, 0], [0, 0, 0])
        ];
        const clipped = clipToFootprint(glbOf(box), footprint, 0).glb;
        const filled = fillOpenLoops(clipped, [], { footprint });
        expect(filled.report.openBefore).toBeGreaterThan(0);
        expect(filled.report.filled).toBeGreaterThan(0);
        expect(filled.report.openAfter).toBeLessThan(filled.report.openBefore);
    });

    it('draws no party wall by default: the openings are the infill\'s', () => {
        const soup = quad([0, 0, 0], [10, 0, 0], [10, 20, 0], [0, 20, 0]);
        const r = cleanBase(glbOf(soup), [], footprint, 0);
        expect(r.report.partyWall.areaM2).toBe(0);
    });
});
