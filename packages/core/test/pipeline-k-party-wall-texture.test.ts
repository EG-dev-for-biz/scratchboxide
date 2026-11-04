/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's closed side (pipeline-k/party-wall-texture.ts): a twin with a photo-textured wall (one flat colour) on x = 0
 * from the ground to 20 m, facing -x, and on x = 10, facing +x (the other way), a party wall or a flat infill patch with no
 * photo (the Seal node's route 0); the straightened photo of the x = 0 wall in an orthos folder.
 *  - With bays in that photo (2 m piers), the party wall and the infill patch take whole bays of it, repeated along them and
 *    mapped up their storeys, labelled generated as carried over, with no image model call.
 *  - With a featureless photo (no bay to repeat), the party wall falls to the image model: a fake client (no model is
 *    reached) answers with grey stripes, tinted to the measured wall colour and repeated at 4 m; with no client the twin
 *    stays as it was, with the reason.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { partyWallPrompt, texturePartyWall } from '../src/node/3d-engine/staged-location/pipeline-k/party-wall-texture';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import type { EnhanceModelRequest } from '../src/node/3d-engine/staged-location/texture-enhance';

const WALL_SRGB = [200, 180, 160];

function solidPng(w: number, h: number, c: number[]): Uint8Array {
    const px = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) px.set(c, i * 3);
    return encodePng(w, h, px, 3);
}

/** A 100 x 200 px photo (0.1 m a pixel) with 2 m bays: a dark 1 m pier then 1 m of the wall colour. */
function bayPng(): Uint8Array {
    const px = new Uint8Array(100 * 200 * 3);
    for (let y = 0; y < 200; y++) for (let x = 0; x < 100; x++) px.set(x % 20 < 10 ? [60, 55, 50] : WALL_SRGB, (y * 100 + x) * 3);
    return encodePng(100, 200, px, 3);
}

/** The twin: the photo wall (x = 0, facing -x, a 10 x 20 m grid of 1 m quads, one flat-colour image) and the party wall (x = 10, facing +x, 10 x 20 m). */
function twin(closed: 'party' | 'seal' = 'party'): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{}], materials: [], textures: [], images: [], samplers: [{}] };
    const chunks: Uint8Array[] = [];
    let len = 0;
    const view = (b: Uint8Array, target?: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.byteLength, ...(target ? { target } : {}) }); chunks.push(b); len += b.byteLength; return json.bufferViews.length - 1; };
    const f32 = (a: number[]) => new Uint8Array(Float32Array.from(a).buffer), u32 = (a: number[]) => new Uint8Array(Uint32Array.from(a).buffer);
    // the photo wall: x = 0, z in 0..10, y in 0..20, wound to face -x
    const P: number[] = [], U: number[] = [], I: number[] = [];
    for (let j = 0; j < 20; j++) for (let i = 0; i < 10; i++) {
        const b = P.length / 3;
        P.push(0, j, i, 0, j, i + 1, 0, j + 1, i + 1, 0, j + 1, i);
        U.push(0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9);
        I.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    json.images.push({ bufferView: view(solidPng(8, 8, WALL_SRGB)), mimeType: 'image/png' });
    json.textures.push({ source: 0, sampler: 0 });
    json.materials.push({ name: 'photo', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    json.accessors.push({ bufferView: view(f32(P), 34962), componentType: 5126, count: P.length / 3, type: 'VEC3', min: [0, 0, 0], max: [0, 20, 10] });
    json.accessors.push({ bufferView: view(f32(U), 34962), componentType: 5126, count: U.length / 2, type: 'VEC2' });
    json.accessors.push({ bufferView: view(u32(I), 34963), componentType: 5125, count: I.length, type: 'SCALAR' });
    json.meshes.push({ name: 'scan', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0, mode: 4 }] });
    json.nodes.push({ name: 'scan', mesh: 0 });
    if (closed === 'party') {
        // the party wall: one quad, x = 10, wound to face +x (as base-cleanup.ts writes it), labelled generated
        const Q = [10, 0, 10, 10, 0, 0, 10, 20, 0, 10, 20, 10];
        json.materials.push({ name: 'PartyWall', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1] }, doubleSided: true });
        json.accessors.push({ bufferView: view(f32(Q), 34962), componentType: 5126, count: 4, type: 'VEC3', min: [10, 0, 0], max: [10, 20, 10] });
        json.accessors.push({ bufferView: view(u32([0, 1, 2, 0, 2, 3]), 34963), componentType: 5125, count: 6, type: 'SCALAR' });
        json.meshes.push({ name: 'party_wall', primitives: [{ attributes: { POSITION: 3 }, indices: 4, material: 1, mode: 4 }] });
        json.nodes.push({ name: 'PartyWall', mesh: 1, extras: { sbBaseSkirt: { provenance: { label: 'generated', method: 'a wall on the footprint\'s wall line' } } } });
    } else {
        // the infill: a 10 x 20 m patch on x = 10 with no photo (route 0, clay), wound either way, and one small piece on a rebuilt wall (route 1)
        const T = [10, 0, 0, 10, 20, 10, 10, 0, 10, 10, 0, 0, 10, 20, 0, 10, 20, 10, 10, 5, 5, 10, 6, 5, 10, 6, 6];
        json.materials.push({ name: 'Seal', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1] }, doubleSided: true });
        json.accessors.push({ bufferView: view(f32(T), 34962), componentType: 5126, count: 9, type: 'VEC3', min: [10, 0, 0], max: [10, 20, 10] });
        json.accessors.push({ bufferView: view(f32([0, 0, 0, 0, 0, 0, 1, 1, 1]), 34962), componentType: 5126, count: 9, type: 'SCALAR' });
        json.accessors.push({ bufferView: view(u32([0, 1, 2, 3, 4, 5, 6, 7, 8]), 34963), componentType: 5125, count: 9, type: 'SCALAR' });
        json.meshes.push({ name: 'Seal', primitives: [{ attributes: { POSITION: 3, _PROVENANCE: 4 }, indices: 5, material: 1, mode: 4 }] });
        json.nodes.push({ name: 'Seal', mesh: 1, extras: { sbSeal: { provenance: { label: 'generated', method: 'the shell closed' }, clay: 2, cornerTextured: 0, wallInfill: 1, routes: [{ code: 0, label: 'clay', pieces: 2 }, { code: 1, label: 'wall', pieces: 1 }, { code: 2, label: 'corner', pieces: 0 }] } } });
    }
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers[0].byteLength = len;
    return assembleGlb(json, bin);
}

/** An orthos folder with the photo wall's straightened photo (1 px = 0.1 m, 100 x 200 px, its top at y = 20). */
function orthos(photo: Uint8Array = solidPng(100, 200, WALL_SRGB)): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthos-'));
    fs.writeFileSync(path.join(dir, 'facade_0.png'), photo);
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ facadeId: 0, image: 'facade_0.png', centroid: [0, 10, 5], normal: [-1, 0, 0], axisS: [0, 0, 1], axisT: [0, 1, 0], sMin: -5, sMax: 5, tMin: -10, tMax: 10, pixel: 0.1, width: 100, height: 200, orthoSMin: -5, orthoTMax: 10, coverage: 1 }] }));
    return dir;
}

const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));

describe('pipeline K closed side: the building\'s own facade carried over', () => {
    const noModel = async (): Promise<never> => { throw new Error('the image model must not be called when a facade can be carried over'); };

    it('carries whole bays of the facade facing the other way onto the party wall, its storeys at their height', async () => {
        const out = await texturePartyWall(twin('party'), { client: noModel, models: ['fake-image-model'], orthosDir: orthos(bayPng()) });
        expect(out.report.skipped).toBeUndefined();
        expect(out.report.model).toBeUndefined();
        const b = out.report.borrowed!;
        expect(b.length).toBe(1);
        expect(b[0]).toMatchObject({ onto: 'party wall', source: 'facade_0.png', facadeId: 0, opposite: true });
        expect(b[0].bayM).toBeCloseTo(2, 1);
        // whole bays only: as many as fit in the 10 m photo at the measured bay
        expect(b[0].bays).toBe(Math.floor(10 / b[0].bayM));
        expect(b[0].covered).toBe(1);
        const g = parseGlbBytes(out.glb);
        const node = g.json.nodes.find((n: any) => n.name === 'PartyWall');
        expect(node.extras.sbBaseSkirt.provenance.label).toBe('generated');
        expect(node.extras.sbBaseSkirt.provenance.method).toMatch(/carried over from facade 0's straightened photo .*\d whole bays of [12]\.\d\d m.*a guess, the scan never saw this wall/);
        const prims = g.json.meshes[node.mesh].primitives;
        expect(prims.length).toBe(1);
        const tex = g.json.textures[g.json.materials[prims[0].material].pbrMetallicRoughness.baseColorTexture.index];
        // repeating along the wall, clamped up it
        expect(g.json.samplers[tex.sampler]).toMatchObject({ wrapS: 10497, wrapT: 33071 });
        // the crop is exactly those bays wide and the 200 rows of the storeys 0..20 m
        const bv = g.json.bufferViews[g.json.images[tex.source].bufferView];
        const img = decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength));
        expect([img.width, img.height]).toEqual([Math.round(b[0].bays * b[0].bayM * 10), 200]);
        // the wall (its lighter half) tinted to the measured colour: the wall columns keep it, the piers stay darker
        expect(Math.abs(img.rgba[15 * 4] - WALL_SRGB[0])).toBeLessThanOrEqual(2);
        expect(img.rgba[5 * 4]).toBeLessThan(100);
        // UVs: 10 m along the wall is 10 m over the crop's width in bays; v runs 0 at 20 m to 1 at the ground
        const UV = readAccessor(g, prims[0].attributes.TEXCOORD_0).data, X = readAccessor(g, prims[0].attributes.POSITION).data;
        const us = Array.from(UV).filter((_, i) => i % 2 === 0);
        expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(10 / (b[0].bays * b[0].bayM), 2);
        for (let v = 0; v < X.length / 3; v++) expect(UV[v * 2 + 1]).toBeCloseTo((20 - X[v * 3 + 1]) / 20, 5);
    });

    it('moves the infill\'s flat patch without a photo onto the carried-over facade (route 4), its other pieces kept', async () => {
        const out = await texturePartyWall(twin('seal'), { models: [], orthosDir: orthos(bayPng()) });
        expect(out.report.patches).toBe(1);
        expect(out.report.borrowed).toEqual([expect.objectContaining({ onto: 'infill', triangles: 2, areaM2: 200, source: 'facade_0.png', opposite: true })]);
        const g = parseGlbBytes(out.glb);
        const node = g.json.nodes.find((n: any) => n.name === 'Seal');
        const prims = g.json.meshes[node.mesh].primitives;
        // the original keeps only the route-1 piece; the new primitive has the two patch triangles at route 4, textured
        expect(readAccessor(g, prims[0].indices).data.length).toBe(3);
        expect(prims.length).toBe(2);
        expect(Array.from(readAccessor(g, prims[1].attributes._PROVENANCE).data)).toEqual([4, 4, 4, 4, 4, 4]);
        expect(prims[1].attributes.TEXCOORD_0).toBeDefined();
        // its normals face out (+x), whichever way the cap was wound
        const N = readAccessor(g, prims[1].attributes.NORMAL).data;
        for (let v = 0; v < 6; v++) expect(N[v * 3]).toBeCloseTo(1, 5);
        const sb = node.extras.sbSeal;
        expect(sb.clay).toBe(0);
        expect(sb.routes.find((r: any) => r.code === 0).pieces).toBe(0);
        expect(sb.routes.find((r: any) => r.code === 4)).toMatchObject({ pieces: 2 });
        expect(sb.provenance.label).toBe('generated');
        expect(sb.provenance.method).toMatch(/2 pieces in 1 flat patch without a photo carried over from facade 0/);
    });

    it('draws the party wall by the image model when no facade has a bay to carry over', async () => {
        const calls: EnhanceModelRequest[] = [];
        // grey stripes, 64 px, as the fake model's answer
        const stripes = new Uint8Array(64 * 64 * 3);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) stripes.set(y % 8 < 4 ? [90, 90, 90] : [140, 140, 140], (y * 64 + x) * 3);
        const client = async (r: EnhanceModelRequest) => { calls.push(r); return { bytes: encodePng(64, 64, stripes, 3), mimeType: 'image/png', modelUsed: 'fake-image-model', requestedModels: r.models, skippedModels: [], modelNote: 'fake' }; };
        const out = await texturePartyWall(twin(), { client, models: ['fake-image-model'], orthosDir: orthos() });
        expect(calls.length).toBe(1);
        expect(calls[0].prompt).toBe(partyWallPrompt(4));
        expect(calls[0].image.width).toBe(calls[0].image.height);
        // the reference: the facade photo cropped to the party wall's storeys (0..20 m: the whole 200 px), shrunk to fit 1024
        const ref = decodeImageInMemory(calls[0].image.bytes);
        expect([ref.width, ref.height]).toEqual([100, 200]);
        expect(out.report.model).toBe('fake-image-model');
        expect(out.report.references).toEqual(['facade_0.png']);
        expect(out.report.samples).toBeGreaterThanOrEqual(50);
        const g = parseGlbBytes(out.glb);
        const node = g.json.nodes.find((n: any) => n.name === 'PartyWall');
        expect(node.extras.sbBaseSkirt.provenance.label).toBe('generated');
        expect(node.extras.sbBaseSkirt.provenance.method).toMatch(/drawn by fake-image-model/);
        const prim = g.json.meshes[node.mesh].primitives[0];
        const mat = g.json.materials[prim.material];
        const tex = g.json.textures[mat.pbrMetallicRoughness.baseColorTexture.index];
        expect(g.json.samplers[tex.sampler]).toMatchObject({ wrapS: 10497, wrapT: 10497 });
        // the tile tinted so its mean is the wall's colour (linear), within rounding
        const bv = g.json.bufferViews[g.json.images[tex.source].bufferView];
        const tile = decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength));
        for (let k = 0; k < 3; k++) {
            let m = 0;
            for (let i = 0; i < tile.width * tile.height; i++) m += lin(tile.rgba[i * 4 + k]);
            expect(m / (tile.width * tile.height)).toBeCloseTo(lin(WALL_SRGB[k]), 2);
        }
        // planar UVs: 10 m along the wall and 20 m up are 2.5 and 5 tiles
        const UV = readAccessor(g, prim.attributes.TEXCOORD_0).data;
        expect(Math.max(...Array.from(UV).filter((_, i) => i % 2 === 0)) - Math.min(...Array.from(UV).filter((_, i) => i % 2 === 0))).toBeCloseTo(2.5, 5);
        expect(Math.max(...Array.from(UV).filter((_, i) => i % 2 === 1)) - Math.min(...Array.from(UV).filter((_, i) => i % 2 === 1))).toBeCloseTo(5, 5);
    });

    it('leaves the party wall as it was, with the reason, when there is no image client', async () => {
        const bytes = twin();
        const out = await texturePartyWall(bytes, { models: ['fake-image-model'], orthosDir: orthos() });
        expect(out.report.skipped).toMatch(/no image model client/);
        expect(Buffer.compare(out.glb, bytes)).toBe(0);
    });
});
