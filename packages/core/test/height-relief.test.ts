/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Real height (height-displace-native.ts over scratchbox_height_displace.hpp, and height-relief.ts on a GLB): a surface
 * tessellated where its material's relief needs it and moved inward by exactly that relief, its border closed by risers,
 * within a triangle limit; and on a GLB, only the surfaces that carry a relief, only the band asked, the surface's own
 * triangles all kept, the displaced cells added as labelled child nodes.
 */

import { describe, expect, it } from 'vitest';
import { displaceByHeight, type ReliefTile } from '../src/node/3d-engine/height-displace-native';
import { applyHeightRelief, HEIGHT_RELIEF_PARAMS, heightReliefAsked, heightReliefProvenance } from '../src/node/3d-engine/height-relief';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { BUILD_STEPS, TOGGLEABLE_STEPS } from '../src/common/staged-build-steps';

const DEPTH = 0.03;
/** A tile of 1 m: a groove 1/8 of the tile wide down its middle, 0.6 of the depth deep; the rest the surface. */
function grooveTile(): ReliefTile {
    const S = 64, values = new Uint8Array(S * S).fill(255);
    for (let y = 0; y < S; y++) for (let x = 28; x < 36; x++) values[y * S + x] = Math.round(255 * 0.4);
    return { width: S, height: S, values, sizeM: [1, 1] };
}
/** A wall in the plane z = 0 facing +z, w x h metres, its UVs spanning it (v down). */
function wall(w: number, h: number, y0 = 0) {
    return {
        positions: new Float32Array([0, y0, 0, w, y0, 0, w, y0 + h, 0, 0, y0 + h, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3])
    };
}
const recessAt = (t: ReliefTile, u: number, uvM: number) => {
    // bilinear between texel centres, repeating: what the kernel and the viewer's sampler read
    const fx = ((u * uvM) / t.sizeM[0]) * t.width - 0.5, x0 = Math.floor(fx), a = fx - x0, wrap = (i: number) => ((i % t.width) + t.width) % t.width;
    return DEPTH * (1 - (t.values[wrap(x0)] * (1 - a) + t.values[wrap(x0 + 1)] * a) / 255);
};

describe('height displacement kernel', () => {
    it('moves every vertex inward by its material\'s relief, and nothing outward', async () => {
        const tile = grooveTile(), w = 2, h = 1;
        const r = await displaceByHeight({ tiles: [tile], classMaps: [], patches: [{ ...wall(w, h), constClass: 0, uvMetres: [w, h] }], depthM: DEPTH, edgeMinM: 0.01, edgeMaxM: 0.25, toleranceM: 0.001, maxTriangles: 200000 });
        const p = r.patches[0];
        expect(p.surfaceTriangles).toBeGreaterThan(200);
        expect(p.maxRecessM).toBeCloseTo(DEPTH * 0.6, 3);
        let deepest = 0;
        for (let v = 0; v < p.positions.length / 3; v++) {
            const z = p.positions[v * 3 + 2];
            expect(z).toBeLessThanOrEqual(1e-6);
            deepest = Math.max(deepest, -z);
            // each vertex sits at the plane (a riser's top) or at the relief under its UV
            const want = recessAt(tile, p.uvs[v * 2], w);
            expect(Math.min(Math.abs(-z - want), Math.abs(z))).toBeLessThan(1e-4);
            // and never leaves its place in the plane
            expect(Math.abs(p.positions[v * 3] - p.uvs[v * 2] * w)).toBeLessThan(1e-4);
        }
        expect(deepest).toBeCloseTo(DEPTH * 0.6, 3);
    });

    it('spends its triangles on the relief: a flat class stays as it was, a groove is resolved', async () => {
        const tile = grooveTile();
        const flat = await displaceByHeight({ tiles: [undefined], classMaps: [], patches: [{ ...wall(1, 1), constClass: 0, uvMetres: [1, 1] }], depthM: DEPTH, edgeMinM: 0.01, edgeMaxM: 2, toleranceM: 0.001, maxTriangles: 200000 });
        expect(flat.patches[0].surfaceTriangles).toBe(2);
        expect(flat.patches[0].riserTriangles).toBe(0);
        expect(flat.patches[0].maxRecessM).toBe(0);
        // by a class map: the left half grooved, the right half without relief
        const map = { width: 2, height: 1, classes: Uint8Array.from([0, 1]) };
        const both = await displaceByHeight({ tiles: [tile, undefined], classMaps: [map], patches: [{ ...wall(2, 1), classMap: 0, uvMetres: [2, 1] }], depthM: DEPTH, edgeMinM: 0.01, edgeMaxM: 0.25, toleranceM: 0.001, maxTriangles: 200000 });
        const p = both.patches[0];
        let left = 0, right = 0;
        for (let t = 0; t < p.surfaceTriangles; t++) { const u = (p.uvs[p.indices[t * 3] * 2] + p.uvs[p.indices[t * 3 + 1] * 2] + p.uvs[p.indices[t * 3 + 2] * 2]) / 3; if (u < 0.5) left++; else right++; }
        expect(left).toBeGreaterThan(right * 3);
        for (let v = 0; v < p.positions.length / 3; v++) if (p.uvs[v * 2] > 0.55) expect(Math.abs(p.positions[v * 3 + 2])).toBeLessThan(1e-6);
    });

    it('closes its border with risers back to where the edge stood', async () => {
        // the groove runs out through the top and bottom edges: the border is recessed there
        const r = await displaceByHeight({ tiles: [grooveTile()], classMaps: [], patches: [{ ...wall(1, 1), constClass: 0, uvMetres: [1, 1] }], depthM: DEPTH, edgeMinM: 0.01, edgeMaxM: 0.25, toleranceM: 0.001, maxTriangles: 200000 });
        const p = r.patches[0];
        expect(p.riserTriangles).toBeGreaterThan(0);
        expect(p.indices.length / 3).toBe(p.surfaceTriangles + p.riserTriangles);
        // every recessed vertex on the outline has a twin at the plane
        const atPlane = new Set<string>();
        for (let v = 0; v < p.positions.length / 3; v++) if (Math.abs(p.positions[v * 3 + 2]) < 1e-6) atPlane.add(`${p.positions[v * 3].toFixed(4)},${p.positions[v * 3 + 1].toFixed(4)}`);
        for (let v = 0; v < p.positions.length / 3; v++) {
            const x = p.positions[v * 3], y = p.positions[v * 3 + 1], z = p.positions[v * 3 + 2];
            if (z < -1e-4 && (y < 1e-6 || y > 1 - 1e-6)) expect(atPlane.has(`${x.toFixed(4)},${y.toFixed(4)}`)).toBe(true);
        }
    });

    it('keeps every patch within the triangle limit by raising the least edge for all', async () => {
        const req = { tiles: [grooveTile()], classMaps: [], patches: [0, 1, 2].map(() => ({ ...wall(3, 2), constClass: 0, uvMetres: [3, 2] as [number, number] })), depthM: DEPTH, edgeMaxM: 0.25, toleranceM: 0.0005 };
        const fine = await displaceByHeight({ ...req, edgeMinM: 0.005, maxTriangles: 5_000_000 });
        const total = (r: typeof fine) => r.patches.reduce((a, p) => a + p.surfaceTriangles + p.riserTriangles, 0);
        const limit = Math.round(total(fine) / 4);
        const capped = await displaceByHeight({ ...req, edgeMinM: 0.005, maxTriangles: limit });
        expect(total(capped)).toBeLessThanOrEqual(limit);
        expect(capped.edgeMinM).toBeGreaterThan(0.005);
        expect(fine.edgeMinM).toBe(0.005);
    });
});

/** A GLB of two walls (a low one and one 10 m up) with a relief material, and a scan piece without one. */
function reliefGlb(): Uint8Array {
    const tile = grooveTile(), bin: Uint8Array[] = [];
    let len = 0;
    const json: any = { asset: { version: '2.0', extras: {} }, scene: 0, scenes: [{ nodes: [0, 1, 2] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [{}], accessors: [], bufferViews: [], buffers: [] };
    const view = (b: Uint8Array) => { while (len % 4) { bin.push(new Uint8Array(1)); len++; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.length }); bin.push(b); len += b.length; return json.bufferViews.length - 1; };
    const texture = (w: number, h: number, grey: Uint8Array) => { const rgba = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) rgba.set([grey[i], grey[i], grey[i], 255], i * 4); json.images.push({ mimeType: 'image/png', bufferView: view(encodePng(w, h, rgba, 4)) }); json.textures.push({ source: json.images.length - 1, sampler: 0 }); return json.textures.length - 1; };
    const photo = texture(2, 2, Uint8Array.from([200, 200, 200, 200]));
    const classes = texture(2, 1, Uint8Array.from([0, 1]));
    json.asset.extras.sbMaterialRelief = { depthM: DEPTH, tiles: [{ class: 0, set: 'Test', texture: texture(tile.width, tile.height, tile.values), sizeM: tile.sizeM }, null] };
    json.materials.push({ name: 'FacadeLattice_0', pbrMetallicRoughness: { baseColorTexture: { index: photo } }, extras: { sbMaterial: { relief: { classTexture: classes, uvMetres: [8, 3] } } } });
    json.materials.push({ name: 'scan', pbrMetallicRoughness: { baseColorTexture: { index: photo } } });
    const mesh = (name: string, m: ReturnType<typeof wall>, material: number, extras?: object) => {
        const acc = (a: Float32Array | Uint32Array, type: string, componentType: number) => { json.accessors.push({ bufferView: view(new Uint8Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength))), componentType, count: a.length / ({ VEC3: 3, VEC2: 2, SCALAR: 1 } as Record<string, number>)[type], type }); return json.accessors.length - 1; };
        json.meshes.push({ name, primitives: [{ attributes: { POSITION: acc(m.positions, 'VEC3', 5126), NORMAL: acc(m.normals, 'VEC3', 5126), TEXCOORD_0: acc(m.uvs, 'VEC2', 5126) }, indices: acc(m.indices, 'SCALAR', 5125), material, mode: 4 }] });
        json.nodes.push({ name: name.replace('facade_lattice_', 'FacadeLattice_'), mesh: json.meshes.length - 1, ...(extras ? { extras } : {}) });
    };
    mesh('facade_lattice_0', wall(8, 3), 0, { sbFacadeLattice: {} });
    mesh('facade_lattice_1', wall(8, 3, 10), 0, { sbFacadeLattice: {} });
    mesh('scan_piece', wall(8, 3), 1);
    json.buffers = [{ byteLength: len }];
    const out = new Uint8Array(len);
    let o = 0;
    for (const b of bin) { out.set(b, o); o += b.length; }
    return assembleGlb(json, out);
}

describe('height relief on a GLB', () => {
    it('displaces the band of the surfaces that carry a relief, keeps their own triangles, and labels what it adds', async () => {
        const glb = reliefGlb();
        const { glb: out, report } = await applyHeightRelief(glb, { ...HEIGHT_RELIEF_PARAMS, bandM: 4, cellM: 4 });
        expect(report.skipped).toBeUndefined();
        expect(report.surfaces).toBe(2);
        // only the low wall stands in the band: its two triangles fall in two cells (by centroid), each reaching the grooved half
        expect(report.displacedSurfaces).toBe(1);
        expect(report.cells).toBe(2);
        expect(report.nearTriangles).toBeGreaterThan(report.baseTriangles);
        expect(report.maxRecessM).toBeCloseTo(DEPTH * 0.6, 3);
        expect(report.label).toBe('generated');
        const g = parseGlbBytes(out), json: any = g.json;
        const base = json.nodes[0];
        expect(base.extras.sbHeightRelief.role).toBe('base');
        expect(base.extras.sbFacadeLattice).toBeDefined();
        const cells = base.extras.sbHeightRelief.cells;
        expect(cells.length).toBe(2);
        // the surface's own triangles are all still there (in another order), each cell's run at the end
        const before = Array.from(readAccessor(parseGlbBytes(glb), 3).data), after = Array.from(readAccessor(g, json.meshes[0].primitives[0].indices).data);
        const tris = (a: number[]) => Array.from({ length: a.length / 3 }, (_, t) => a.slice(t * 3, t * 3 + 3).join(',')).sort();
        expect(tris(after)).toEqual(tris(before));
        expect(cells[0].start).toBe(0);
        expect(cells[1].start + cells[1].count).toBe(after.length);
        // the displaced copy: a child node, labelled, with the surface's material marked displaced
        const near = json.nodes[base.children[0]];
        expect(near.name).toBe(cells[0].near);
        expect(near.extras.sbHeightRelief).toMatchObject({ role: 'near', label: 'generated', of: 'FacadeLattice_0' });
        const mat = json.materials[json.meshes[near.mesh].primitives[0].material];
        expect(mat.extras.sbMaterial.relief.displaced).toBe(true);
        expect(json.materials[0].extras.sbMaterial.relief.displaced).toBeUndefined();
        const pos = readAccessor(g, json.meshes[near.mesh].primitives[0].attributes.POSITION).data;
        for (let v = 0; v < pos.length; v += 3) expect(pos[v + 2]).toBeLessThanOrEqual(1e-6);
        // the wall above the band and the scan piece are as they were
        expect(json.nodes[1].extras.sbHeightRelief).toBeUndefined();
        expect(json.nodes[2].extras).toBeUndefined();
        expect(json.asset.extras.sbHeightRelief.cells).toBe(2);
        expect(heightReliefProvenance(report, 100)).toMatchObject({ source: 'height-relief', label: 'generated' });
    });

    it('displaces the whole surface without a band, and leaves a model without a relief untouched with the reason', async () => {
        const glb = reliefGlb();
        const whole = await applyHeightRelief(glb, { ...HEIGHT_RELIEF_PARAMS, bandM: undefined });
        expect(whole.report.displacedSurfaces).toBe(2);
        const g = parseGlbBytes(glb), json: any = JSON.parse(JSON.stringify(g.json));
        delete json.asset.extras.sbMaterialRelief;
        const plain = assembleGlb(json, g.bin);
        const r = await applyHeightRelief(plain);
        expect(r.report.skipped).toMatch(/no material relief/);
        expect(r.glb).toBe(plain);
    });

    it('is a step of a single building\'s twin, off for a district unless asked', () => {
        const prior = process.env.SCRATCHBOX_K_HEIGHT_RELIEF;
        delete process.env.SCRATCHBOX_K_HEIGHT_RELIEF;
        try {
            expect(heightReliefAsked(undefined)).toBe(true);
            expect(heightReliefAsked(undefined, { district: true })).toBe(false);
            expect(heightReliefAsked({ 'twin.heightRelief': false })).toBe(false);
            expect(heightReliefAsked({ 'twin.heightRelief': true }, { district: true })).toBe(true);
            process.env.SCRATCHBOX_K_HEIGHT_RELIEF = '0';
            expect(heightReliefAsked(undefined)).toBe(false);
            process.env.SCRATCHBOX_K_HEIGHT_RELIEF = '1';
            expect(heightReliefAsked(undefined, { district: true })).toBe(true);
        } finally {
            if (prior === undefined) delete process.env.SCRATCHBOX_K_HEIGHT_RELIEF; else process.env.SCRATCHBOX_K_HEIGHT_RELIEF = prior;
        }
        expect(BUILD_STEPS.find(s => s.key === 'twin.heightRelief')?.stage).toBe('textures');
        expect(TOGGLEABLE_STEPS.has('twin.heightRelief')).toBe(true);
    });
});
