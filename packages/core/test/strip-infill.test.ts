/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree strip's caps refilled by the surface infill (strip-infill.ts) on a synthetic devegetated tile: a gravel path
 * (its PNG photo, the kept scan) with a cap the strip closed where it cut a crown (its own fill material, flat grey, as the
 * strip colours a piece with no photographed neighbour). The cap's texels are painted again from the gravel around it, its
 * geometry is left as the strip laid it, and its mesh's provenance is rewritten from the infill's labels.
 */

import { describe, expect, it } from 'vitest';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory, readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { refillStripPieces, stripFillPieces } from '../src/node/3d-engine/staged-location/strip-infill';
import { gravelPark, HALF, luma, STEP, TEX } from './surface-infill-fixtures';

const CAP = { x0: -1.5, x1: 1.5, z0: -1, z1: 1 };

/** The gravel path's grid mesh (photo-textured) and the cap the strip laid over a cut crown (its own grey fill material). */
function devegetated(): Buffer {
    const s = gravelPark;
    const parts: Buffer[] = [];
    const views: any[] = [];
    let off = 0;
    const add = (b: Buffer, target?: number) => { const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b); off += b.length; return views.length - 1; };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const accessors: any[] = [];
    const prim = (pos: number[], uv: number[], idx: number[]) => {
        const nor = pos.map((_, j) => (j % 3 === 1 ? 1 : 0));
        const ys = pos.filter((_, j) => j % 3 === 1), xs = pos.filter((_, j) => j % 3 === 0), zs = pos.filter((_, j) => j % 3 === 2);
        accessors.push({ bufferView: add(f32(pos), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] });
        accessors.push({ bufferView: add(f32(nor), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3' });
        accessors.push({ bufferView: add(f32(uv), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC2' });
        accessors.push({ bufferView: add(Buffer.from(new Uint32Array(idx).buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        const b = accessors.length - 4;
        return { attributes: { POSITION: b, NORMAL: b + 1, TEXCOORD_0: b + 2 }, indices: b + 3, mode: 4 };
    };
    // the ground: the gravel's grid, its hole under the cap left out (the strip removed the crown's triangles there)
    const n = Math.round((2 * HALF) / STEP) + 1, pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) { const x = -HALF + i * STEP, z = -HALF + k * STEP; pos.push(x, s.ground(x, z), z); uv.push((x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF)); }
    for (let k = 0; k + 1 < n; k++) for (let i = 0; i + 1 < n; i++) {
        const x = -HALF + (i + 0.5) * STEP, z = -HALF + (k + 0.5) * STEP;
        if (x > CAP.x0 && x < CAP.x1 && z > CAP.z0 && z < CAP.z1) continue;
        const a = k * n + i, b = a + 1, c = a + n, d = c + 1; idx.push(a, c, b, b, c, d);
    }
    const ground = prim(pos, uv, idx);
    // the cap: a grid over the hole at the ground's height, its own grey texture
    const cp: number[] = [], cu: number[] = [], ci: number[] = [];
    const cn = 13, cm = 9;
    for (let k = 0; k < cm; k++) for (let i = 0; i < cn; i++) { const x = CAP.x0 + ((CAP.x1 - CAP.x0) * i) / (cn - 1), z = CAP.z0 + ((CAP.z1 - CAP.z0) * k) / (cm - 1); cp.push(x, s.ground(x, z), z); cu.push(i / (cn - 1), k / (cm - 1)); }
    for (let k = 0; k + 1 < cm; k++) for (let i = 0; i + 1 < cn; i++) { const a = k * cn + i, b = a + 1, c = a + cn, d = c + 1; ci.push(a, c, b, b, c, d); }
    const cap = prim(cp, cu, ci);
    const rgba = new Uint8Array(TEX * TEX * 4);
    for (let k = 0; k < TEX; k++) for (let i = 0; i < TEX; i++) { const c = s.truth(-HALF + ((i + 0.5) / TEX) * 2 * HALF, -HALF + ((k + 0.5) / TEX) * 2 * HALF); rgba.set([c[0], c[1], c[2], 255], (k * TEX + i) * 4); }
    const grey = new Uint8Array(64 * 64 * 4).map((_, j) => (j % 4 === 3 ? 255 : 128));
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 1 }],
        meshes: [{ name: 'tile', primitives: [{ ...ground, material: 0 }] }, { name: 'VegetationFill_cap_unsourced', primitives: [{ ...cap, material: 1 }], extras: { scratchbox: { stripFill: { kind: 'cap', pieces: 1, provenance: { label: 'generated', method: "the tile's mean photo colour" } } } } }],
        materials: [
            { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } },
            { name: 'VegetationFill', pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0, roughnessFactor: 1 }, extras: { scratchbox: { photoInferredFill: true } } }
        ],
        accessors, bufferViews: views
    };
    const v0 = add(encodePng(TEX, TEX, rgba, 4)), v1 = add(encodePng(64, 64, grey, 4));
    json.images = [{ bufferView: v0, mimeType: 'image/png' }, { bufferView: v1, mimeType: 'image/png' }];
    json.samplers = [{ magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }];
    json.textures = [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }];
    json.buffers = [{ byteLength: off }];
    return assembleGlb(json, Buffer.concat(parts));
}

describe('the tree strip refilled by the surface infill', () => {
    it('finds the cap as one piece of the fill, a cap by its normal', () => {
        const pieces = stripFillPieces(readTileTriangles(devegetated()));
        expect(pieces).toHaveLength(1);
        expect(pieces[0].kind).toBe('cap');
        expect(pieces[0].areaM2).toBeCloseTo(6, 1);
    });

    it("paints the cap from the gravel around it, keeps its geometry, and rewrites its provenance", async () => {
        const before = devegetated();
        const { glb, report, regions } = await refillStripPieces(before);
        expect(report.refilled.cap).toBe(1);
        expect(report.paintedTexels).toBeGreaterThan(1000);
        expect(regions[0].attempts.some(a => a.accepted)).toBe(true);
        // the geometry is the strip's own
        const g0 = parseGlbBytes(before), g1 = parseGlbBytes(glb);
        expect(Array.from(readAccessor(g1, 4).data)).toEqual(Array.from(readAccessor(g0, 4).data));
        // the cap's texture: no longer flat grey, the gravel's colour and grain
        const view = g1.json.bufferViews[g1.json.images[1].bufferView];
        const img = decodeImageInMemory(g1.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
        const lum: number[] = [], m = [0, 0, 0];
        for (let p = 0; p < img.width * img.height; p++) { lum.push(luma(img.rgba, p * 4)); for (let j = 0; j < 3; j++) m[j] += img.rgba[p * 4 + j] / (img.width * img.height); }
        const mean = lum.reduce((s, v) => s + v, 0) / lum.length, sd = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length);
        expect(sd).toBeGreaterThan(6);
        const truth = [0, 0, 0];
        let c = 0;
        for (let z = -3; z < 3; z += 0.05) for (let x = -3; x < 3; x += 0.05) { const t = gravelPark.truth(x, z); for (let j = 0; j < 3; j++) truth[j] += t[j]; c++; }
        const lab = (v: number[]) => Colour.srgbToLab(v[0], v[1], v[2]);
        expect(Colour.calculateDeltaE00(lab(m), lab(truth.map(v => v / c)))).toBeLessThan(5);
        // the provenance: the mesh's from the infill, the root's report beside sbInfill
        const sf = g1.json.meshes[1].extras.scratchbox.stripFill;
        expect(sf.refilledBy).toMatch(/strip-infill/);
        expect(sf.provenance.method).toMatch(/surface infill/);
        expect(g1.json.extras.sbStripInfill.refilled.cap).toBe(1);
        expect(g1.json.extras.sbInfill.regions).toHaveLength(1);
    }, 300_000);
});
