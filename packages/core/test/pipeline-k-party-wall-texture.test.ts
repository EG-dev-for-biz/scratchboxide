/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's party wall drawn by the image model (pipeline-k/party-wall-texture.ts): a twin with a photo-textured wall
 * (one flat colour) on x = 0 from the ground to 20 m and a party wall on x = 10 over the same storeys; the straightened
 * facade photo of the wall beside it in an orthos folder. A fake image client (no model is reached) answers with grey
 * stripes. The party wall gets that tile tinted to the measured wall colour, repeated at 4 m, labelled generated
 * with the model; without a client it stays as it was, with the reason.
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

/** The twin: the photo wall (x = 0, facing -x, a 10 x 20 m grid of 1 m quads, one flat-colour image) and the party wall (x = 10, facing +x, 10 x 20 m). */
function twin(): Buffer {
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
    // the party wall: one quad, x = 10, wound to face +x (as base-cleanup.ts writes it), labelled generated
    const Q = [10, 0, 0, 10, 0, 10, 10, 20, 10, 10, 20, 0];
    json.materials.push({ name: 'PartyWall', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1] }, doubleSided: true });
    json.accessors.push({ bufferView: view(f32(Q), 34962), componentType: 5126, count: 4, type: 'VEC3', min: [10, 0, 0], max: [10, 20, 10] });
    json.accessors.push({ bufferView: view(u32([0, 2, 1, 0, 3, 2]), 34963), componentType: 5125, count: 6, type: 'SCALAR' });
    json.meshes.push({ name: 'party_wall', primitives: [{ attributes: { POSITION: 3 }, indices: 4, material: 1, mode: 4 }] });
    json.nodes.push({ name: 'PartyWall', mesh: 1, extras: { sbBaseSkirt: { provenance: { label: 'generated', method: 'a wall on the footprint\'s wall line' } } } });
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers[0].byteLength = len;
    return assembleGlb(json, bin);
}

/** An orthos folder with the photo wall's straightened photo (1 px = 0.1 m, 100 x 200 px, its top at y = 20). */
function orthos(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthos-'));
    fs.writeFileSync(path.join(dir, 'facade_0.png'), solidPng(100, 200, WALL_SRGB));
    fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ facadeId: 0, image: 'facade_0.png', centroid: [0, 10, 5], normal: [-1, 0, 0], axisS: [0, 0, 1], axisT: [0, 1, 0], sMin: -5, sMax: 5, tMin: -10, tMax: 10, pixel: 0.1, width: 100, height: 200, orthoSMin: -5, orthoTMax: 10, coverage: 1 }] }));
    return dir;
}

const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));

describe('pipeline K party wall: the building\'s masonry continued by the image model', () => {
    it('draws the party wall from the facade photos, tinted to the wall colour, repeated at 4 m, labelled generated', async () => {
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
