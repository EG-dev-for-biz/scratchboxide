/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's seal textures its fill (pipeline-k/lattice-stitch.ts fillOpenLoops): a closed 10 m cube, 1 m grid, with a
 * 2 m x 2 m hole in its front face (z = 0). When the front face is a rebuilt facade (a FacadeLattice node mapped onto its
 * ortho), the hole's fill takes that facade's photo through the wall's own planar mapping. When the front is scan, the fill
 * takes its corners' UVs only where they are a plain copy of its shape: a sheared mapping (the photo from the wrong angle)
 * leaves it clay.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { ensureRemeshPolishBinary } from '../src/node/3d-engine/staged-location/remesh-polish-native';
import { fillOpenLoops, foldIntoRepeats, repeatPitch } from '../src/node/3d-engine/staged-location/pipeline-k/lattice-stitch';
import { readGlbTriangles } from './helpers/clay-glb-render';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';

type V = [number, number, number];
type UvOf = (p: V) => [number, number];

/** A 10 m face as a 1 m grid: origin, the two in-plane steps, cells skipped by `hole`. Wound outward by `flip`. */
function face(o: V, a: V, b: V, flip: boolean, hole: (i: number, j: number) => boolean = () => false): V[] {
    const at = (i: number, j: number): V => [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
    const out: V[] = [];
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) {
        if (hole(i, j)) continue;
        const q = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        out.push(...(flip ? [q[0], q[2], q[1], q[0], q[3], q[2]] : [q[0], q[1], q[2], q[0], q[2], q[3]]));
    }
    return out;
}

const hole = (i: number, j: number) => i >= 4 && i < 6 && j >= 4 && j < 6;
const front = () => face([0, 0, 0], [1, 0, 0], [0, 1, 0], true, hole);
// the front split at x = 5: the left half rebuilt, the right half still scan, the hole straddling both
const frontLeft = () => face([0, 0, 0], [1, 0, 0], [0, 1, 0], true, (i, j) => hole(i, j) || i >= 5);
const frontRight = () => face([0, 0, 0], [1, 0, 0], [0, 1, 0], true, (i, j) => hole(i, j) || i < 5);
const rest = () => [
    ...face([0, 0, 10], [1, 0, 0], [0, 1, 0], false), ...face([0, 0, 0], [0, 0, 1], [0, 1, 0], false),
    ...face([10, 0, 0], [0, 0, 1], [0, 1, 0], true), ...face([0, 0, 0], [1, 0, 0], [0, 0, 1], false), ...face([0, 10, 0], [1, 0, 0], [0, 0, 1], true)
];

/** One GLB: named nodes of triangle soup; textured ones carry TEXCOORD_0 from their mapping and a photo material. */
function glb(parts: Array<{ name: string; tris: V[]; uv?: UvOf; facadeId?: number }>): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{}], materials: [], textures: [], images: [], samplers: [{}] };
    const chunks: Uint8Array[] = [];
    let len = 0;
    const view = (a: Float32Array | Uint32Array, target: number) => { json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: a.byteLength, target }); chunks.push(new Uint8Array(a.buffer)); len += a.byteLength; return json.bufferViews.length - 1; };
    for (const p of parts) {
        const P = Float32Array.from(p.tris.flat()), I = Uint32Array.from(p.tris.map((_, i) => i));
        const min = [0, 1, 2].map(k => Math.min(...p.tris.map(v => v[k]))), max = [0, 1, 2].map(k => Math.max(...p.tris.map(v => v[k])));
        json.accessors.push({ bufferView: view(P, 34962), componentType: 5126, count: p.tris.length, type: 'VEC3', min, max });
        const attributes: Record<string, number> = { POSITION: json.accessors.length - 1 };
        let material: number | undefined;
        if (p.uv) {
            json.accessors.push({ bufferView: view(Float32Array.from(p.tris.flatMap(v => p.uv!(v))), 34962), componentType: 5126, count: p.tris.length, type: 'VEC2' });
            attributes.TEXCOORD_0 = json.accessors.length - 1;
            json.images.push({ uri: `${p.name}.png` }); json.textures.push({ source: json.images.length - 1, sampler: 0 });
            json.materials.push({ name: p.name, pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 } } });
            material = json.materials.length - 1;
        }
        json.accessors.push({ bufferView: view(I, 34963), componentType: 5125, count: I.length, type: 'SCALAR' });
        json.meshes.push({ name: p.name, primitives: [{ attributes, indices: json.accessors.length - 1, mode: 4, ...(material !== undefined ? { material } : {}) }] });
        json.nodes.push({ name: p.name, mesh: json.meshes.length - 1, ...(p.facadeId !== undefined ? { extras: { sbFacadeLattice: { facadeId: p.facadeId } } } : {}) });
        json.scenes[0].nodes.push(json.nodes.length - 1);
    }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers[0].byteLength = len;
    return assembleGlb(json, bin);
}

/** The seal's triangles in the textured output, with their material's name and UVs, and its node's extras. */
function sealOf(bytes: Buffer) {
    const g = parseGlbBytes(bytes);
    const node = g.json.nodes.find((n: any) => n.name === 'Seal');
    const tris: Array<{ p: V[]; material: string; uv?: number[][] }> = [];
    for (const pr of g.json.meshes[node.mesh].primitives) {
        const X = readAccessor(g, pr.attributes.POSITION).data, U = pr.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, pr.attributes.TEXCOORD_0).data : undefined, I = readAccessor(g, pr.indices).data;
        for (let t = 0; t < I.length; t += 3) tris.push({
            p: [0, 1, 2].map(k => [X[I[t + k] * 3], X[I[t + k] * 3 + 1], X[I[t + k] * 3 + 2]] as V),
            material: g.json.materials[pr.material].name,
            ...(U ? { uv: [0, 1, 2].map(k => [U[I[t + k] * 2], U[I[t + k] * 2 + 1]]) } : {})
        });
    }
    return { tris, extras: node.extras.sbSeal };
}

const inHole = (t: { p: V[] }) => t.p.every(v => v[2] === 0 && v[0] >= 4 && v[0] <= 6 && v[1] >= 4 && v[1] <= 6);

// the fill runs natively unless SCRATCHBOX_K_NATIVE leaves `infill` out: its binary built first (remesh-polish-native.ts)
beforeAll(async () => { await ensureRemeshPolishBinary(); }, 900_000);

describe('pipeline K seal: fill textured as the surface it closes', () => {
    it('fills a hole in a rebuilt facade from that facade\'s own photo, through its planar mapping', () => {
        // the facade's ortho: u along x, v down y, over a 12 m x 12 m frame starting 1 m out
        const wallUv: UvOf = p => [(p[0] + 1) / 12, (11 - p[1]) / 12];
        const scanUv: UvOf = p => [p[0] / 10 * 0.5 + p[2] / 20, p[1] / 10 * 0.5];
        // the hole's corners at x = 4 are the wall's only, at x = 6 the scan's only: no one photo is at all three corners
        const clay = glb([{ name: 'FacadeLattice_3', tris: frontLeft(), facadeId: 3 }, { name: 'scan', tris: [...frontRight(), ...rest()] }]);
        const tex = glb([{ name: 'FacadeLattice_3', tris: frontLeft(), uv: wallUv, facadeId: 3 }, { name: 'scan', tris: [...frontRight(), ...rest()], uv: scanUv }]);
        const out = fillOpenLoops(clay, [tex]);
        expect(out.report.openAfter).toBe(0);
        const seal = sealOf(out.others[0]);
        const fill = seal.tris.filter(inHole);
        // the 2 m x 2 m hole: 8 m of loop, closed by 6 triangles covering 4 m²
        expect(fill.length).toBe(6);
        const area = fill.reduce((s, t) => { const a = t.p[0], b = t.p[1], c = t.p[2]; return s + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2; }, 0);
        expect(area).toBeCloseTo(4, 6);
        for (const t of fill) {
            expect(t.material).toBe('FacadeLattice_3');
            t.p.forEach((v, k) => { expect(t.uv![k][0]).toBeCloseTo(wallUv(v)[0], 5); expect(t.uv![k][1]).toBeCloseTo(wallUv(v)[1], 5); });
        }
        expect(seal.extras.wallInfill).toBe(6);
        expect(seal.extras.provenance.label).toBe('generated');
    });

    it('takes the corners\' UVs on the scan only where they copy the shape plainly; a sheared mapping stays clay', () => {
        const clay = glb([{ name: 'front', tris: front() }, { name: 'scan', tris: rest() }]);
        const plain: UvOf = p => [p[0] / 10, p[1] / 10];
        // the same texels per metre but sheared: u runs 1.5x as far along y as along x
        const sheared: UvOf = p => [p[0] / 10 + p[1] * 0.15, p[1] / 30];
        for (const [uv, textured] of [[plain, true], [sheared, false]] as Array<[UvOf, boolean]>) {
            const tex = glb([{ name: 'front', tris: front(), uv }, { name: 'scan', tris: rest(), uv: plain }]);
            const fill = sealOf(fillOpenLoops(clay, [tex]).others[0]).tris.filter(inHole);
            expect(fill.length).toBe(6);
            for (const t of fill) {
                if (textured) {
                    expect(t.material).toBe('front');
                    t.p.forEach((v, k) => { expect(t.uv![k][0]).toBeCloseTo(uv(v)[0], 5); expect(t.uv![k][1]).toBeCloseTo(uv(v)[1], 5); });
                } else expect(t.uv).toBeUndefined();
            }
        }
    });
});

describe('pipeline K infill where no photo reached', () => {
    it("continues the nearest rebuilt facade facing the same way across it, that facade's photo repeating, labelled generated", () => {
        // the front (z = 0) is a rebuilt facade with its photo; the back (z = 10) is scan no photo reached, with a hole
        const wallUv: UvOf = p => [(p[0] + 1) / 12, (11 - p[1]) / 12];
        const frontAll = () => face([0, 0, 0], [1, 0, 0], [0, 1, 0], true);
        const back = () => face([0, 0, 10], [1, 0, 0], [0, 1, 0], false, hole);
        const sides = () => [...face([0, 0, 0], [0, 0, 1], [0, 1, 0], false), ...face([10, 0, 0], [0, 0, 1], [0, 1, 0], true), ...face([0, 0, 0], [1, 0, 0], [0, 0, 1], false), ...face([0, 10, 0], [1, 0, 0], [0, 0, 1], true)];
        const clay = glb([{ name: 'FacadeLattice_3', tris: frontAll(), facadeId: 3 }, { name: 'scan', tris: [...back(), ...sides()] }]);
        const tex = glb([{ name: 'FacadeLattice_3', tris: frontAll(), uv: wallUv, facadeId: 3 }, { name: 'scan', tris: [...back(), ...sides()] }]);
        const out = fillOpenLoops(clay, [tex]);
        const seal = sealOf(out.others[0]);
        const fill = seal.tris.filter(t => t.p.every(v => v[2] === 10 && v[0] >= 4 && v[0] <= 6 && v[1] >= 4 && v[1] <= 6));
        expect(fill.length).toBe(6);
        for (const t of fill) {
            expect(t.material).toBe('FacadeLattice_3_continued');
            t.p.forEach((v, k) => { expect(t.uv![k][0]).toBeCloseTo(wallUv(v)[0], 5); expect(t.uv![k][1]).toBeCloseTo(wallUv(v)[1], 5); });
        }
        expect(seal.extras.continued).toBe(6);
        expect(seal.extras.provenance.label).toBe('generated');
        // each piece carries its route and confidence; the front has no fitted windows, so no repeat cell: the lower confidence
        const cont = seal.extras.routes.find((r: any) => r.code === 3);
        expect(cont.pieces).toBe(6);
        expect(cont.meanConfidence).toBeGreaterThan(0);
        expect(cont.meanConfidence).toBeLessThanOrEqual(0.25);
        // the continued material repeats its photo past its edges
        const g = parseGlbBytes(out.others[0]);
        const mat = g.json.materials.find((m: any) => m.name === 'FacadeLattice_3_continued');
        const sampler = g.json.samplers[g.json.textures[mat.pbrMetallicRoughness.baseColorTexture.index].sampler];
        expect([sampler.wrapS, sampler.wrapT]).toEqual([10497, 10497]);
    });
});

describe('pipeline K seal: continued infill from the facade\'s own repeat cell', () => {
    it('reads the bay and storey pitch from the fitted windows', () => {
        // a 5 x 4 grid of windows, 0.1 apart in u and 0.2 in v
        const uv: number[] = [];
        for (let a = 0; a < 5; a++) for (let b = 0; b < 4; b++) uv.push(0.1 + a * 0.1, 0.1 + b * 0.2, 0.15 + a * 0.1, 0.2 + b * 0.2);
        const p = repeatPitch(uv);
        expect(p.pu).toBeCloseTo(0.1, 6);
        expect(p.pv).toBeCloseTo(0.2, 6);
        expect(repeatPitch(uv.slice(0, 8))).toEqual({});
    });

    it('moves a piece past the photo by whole repeat cells into the nearest repeats, not by whole photos', () => {
        const uv = [[1.23, 0.5], [1.27, 0.5], [1.25, 0.55]];
        const f = foldIntoRepeats(uv, 0.1, 0.2);
        // three bays back: inside the photo, at the same place in its bay
        f.forEach((q, k) => { expect(q[0]).toBeCloseTo(uv[k][0] - 0.3, 6); expect(q[1]).toBeCloseTo(uv[k][1], 6); });
        expect(Math.max(...f.map(q => q[0]))).toBeLessThanOrEqual(1);
        // below the photo by less than a storey: one storey up
        const g = foldIntoRepeats([[0.5, -0.05], [0.55, -0.05], [0.5, -0.01]], 0.1, 0.2);
        g.forEach(q => expect(q[1]).toBeGreaterThanOrEqual(0.149));
        // no pitch: folded by whole photos
        expect(foldIntoRepeats([[1.2, 0.5], [1.3, 0.5], [1.25, 0.6]])[0][0]).toBeCloseTo(0.2, 6);
    });
});

describe('pipeline K seal: closed where it is safe', () => {
    it('faces every cap out of the building, by where the building lies, whichever way the surface around it is wound', () => {
        // the front (z = 0, outward -z) has a 2 m x 2 m hole; the box wound outward, then wound inward throughout
        for (const inward of [false, true]) {
            const flipAll = (t: V[]) => { const o: V[] = []; for (let i = 0; i < t.length; i += 3) o.push(t[i], t[i + 2], t[i + 1]); return o; };
            const tris = [...front(), ...rest()];
            const out = fillOpenLoops(glb([{ name: 'scan', tris: inward ? flipAll(tris) : tris }]), []);
            const r = readGlbTriangles(out.clay), seal = r.nodeRanges.find(x => x.name === 'Seal')!;
            expect(seal.triangleCount).toBeGreaterThan(0);
            for (let t = seal.firstTriangle; t < seal.firstTriangle + seal.triangleCount; t++) {
                const P = [0, 1, 2].map(k => { const v = r.indices[t * 3 + k]; return [r.positions[v * 3], r.positions[v * 3 + 1], r.positions[v * 3 + 2]]; });
                const nz = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
                expect(Math.sign(nz)).toBe(-1);
            }
        }
    });

    it('caps a flat hole, and leaves open a hole whose rim bends around a corner', () => {
        // the front's flat 2 m x 2 m hole, and a 1 m x 1 m hole on each side of the front-right corner, meeting at it: one loop
        // bent through 90 degrees (its rim 0.35 m off its own best plane, its cap 1.4 m²)
        const frontCut = (i: number, j: number) => hole(i, j) || (i === 9 && j === 1);
        const sideCut = (i: number, j: number) => i === 0 && j === 1;
        const tris = [
            ...face([0, 0, 0], [1, 0, 0], [0, 1, 0], true, frontCut), ...face([0, 0, 10], [1, 0, 0], [0, 1, 0], false),
            ...face([0, 0, 0], [0, 0, 1], [0, 1, 0], false), ...face([10, 0, 0], [0, 0, 1], [0, 1, 0], true, sideCut),
            ...face([0, 0, 0], [1, 0, 0], [0, 0, 1], false), ...face([0, 10, 0], [1, 0, 0], [0, 0, 1], true)
        ];
        const out = fillOpenLoops(glb([{ name: 'scan', tris }]), []);
        expect(out.report.refusedCaps).toBe(1);
        expect(out.report.refusedCapM2).toBeGreaterThanOrEqual(1);
        // the bent loop's 6 edges stay open; the flat hole is closed
        expect(out.report.openAfter).toBe(6);
        const g = parseGlbBytes(out.clay), node = g.json.nodes.find((n: any) => n.name === 'Seal');
        const X = readAccessor(g, g.json.meshes[node.mesh].primitives[0].attributes.POSITION).data;
        const pts = Array.from({ length: X.length / 3 }, (_, i) => [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
        expect(pts.length).toBe(18);
        expect(pts.every(p => p[2] === 0 && p[0] >= 4 && p[0] <= 6 && p[1] >= 4 && p[1] <= 6)).toBe(true);
    });

    it('leaves a hole a rebuilt wall stands in for: no cap drawn back over the recessed rebuild', () => {
        // the front's 2 m x 2 m hole with a rebuilt cell 0.3 m behind it (inside the box), wound like the front
        const rebuilt = face([3, 3, 0.3], [1, 0, 0], [0, 1, 0], true, (i, j) => i >= 4 || j >= 4);
        const out = fillOpenLoops(glb([{ name: 'scan', tris: [...front(), ...rest()] }, { name: 'wall', tris: rebuilt, facadeId: 1 }]), []);
        expect(out.report.droppedCoveredM2).toBeGreaterThanOrEqual(3);
        const g = parseGlbBytes(out.clay), node = g.json.nodes.find((n: any) => n.name === 'Seal');
        const X = node ? readAccessor(g, g.json.meshes[node.mesh].primitives[0].attributes.POSITION).data : new Float32Array();
        const pts = Array.from({ length: X.length / 3 }, (_, i) => [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]);
        expect(pts.filter(p => p[2] === 0 && p[0] >= 4 && p[0] <= 6 && p[1] >= 4 && p[1] <= 6)).toHaveLength(0);
        // without the wall the same hole is capped
        expect(fillOpenLoops(glb([{ name: 'scan', tris: [...front(), ...rest()] }]), []).report.droppedCoveredM2).toBe(0);
    });
});
