/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** asset-decal.ts: the prompt follows what is asked; the decal lands where it is placed, as it is coloured. No model call. */

import { describe, expect, it } from 'vitest';
import { bakeDecal, decalAsset, decalPrompt, decalTexture, DECAL_DEFAULT_DESCRIPTION } from '../src/node/3d-engine/asset-decal';
import { writeStagedGlb } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { decodeImageInMemory, readGlbChunks } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

/** A 10 x 6 x 8 m box (x 0..10, z 0..8): four walls and a roof as "box", plus a window quad "opening_0" on the south wall. */
function boxGlb(): Uint8Array {
    const x0 = 0, x1 = 10, z0 = 0, z1 = 8, h = 6;
    const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
    const box = [
        ...q([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]), ...q([x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]),
        ...q([x1, 0, z1], [x1, 0, z0], [x1, h, z0], [x1, h, z1]), ...q([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]),
        ...q([x0, h, z1], [x1, h, z1], [x1, h, z0], [x0, h, z0])
    ];
    const win = q([4, 2, z1 + 0.01], [6, 2, z1 + 0.01], [6, 4, z1 + 0.01], [4, 4, z1 + 0.01]);
    return new Uint8Array(writeStagedGlb([{ name: 'box', positions: Float32Array.from(box) }, { name: 'opening_0', positions: Float32Array.from(win) }]));
}

const solid = (r: number, g: number, b: number, a = 255) => ({ width: 8, height: 8, rgba: new Uint8Array(256).map((_, i) => [r, g, b, a][i % 4]) });

/** The decal node's UVs and its sampler, read back from the GLB. */
function decalOf(glb: Buffer) {
    const { json, bin } = readGlbChunks(new Uint8Array(glb));
    const node = json.nodes.find((n: any) => n.extras?.decal);
    const prim = json.meshes[node.mesh].primitives[0];
    const acc = json.accessors[prim.attributes.TEXCOORD_0], bv = json.bufferViews[acc.bufferView];
    const uv = new Float32Array(bin.buffer.slice(bin.byteOffset + bv.byteOffset, bin.byteOffset + bv.byteOffset + acc.count * 8));
    const mat = json.materials[prim.material];
    const tex = json.textures[mat.pbrMetallicRoughness.baseColorTexture.index];
    return { node, mat, sampler: json.samplers[tex.sampler], uv };
}

describe('asset decal', () => {
    it('paints what is described on white, from the photo when there is one, tiling only when asked', () => {
        expect(decalPrompt(50, 40)).toContain(DECAL_DEFAULT_DESCRIPTION);
        const sign = decalPrompt(4, 1, 'a gold shop sign reading ROOKERY', false);
        expect(sign).toContain('a gold shop sign reading ROOKERY');
        expect(sign).toContain('4.0 by 1.0 metres');
        expect(sign).not.toMatch(/photo/);
        expect(sign).toMatch(/does not tile/);
        expect(decalPrompt(2, 2, 'moss', true, true)).toMatch(/tiles seamlessly/);
    });

    it('takes opacity from distance to white, or from the image alpha, and colour as given or unblended from white', () => {
        const black = decodeImageInMemory(new Uint8Array(decalTexture(solid(0, 0, 0), 1).png));
        const mid = 4 * (4 * black.width + 4);
        expect(black.rgba[mid + 3]).toBe(255);
        const white = decodeImageInMemory(new Uint8Array(decalTexture(solid(255, 255, 255), 1).png));
        expect(white.rgba[mid + 3]).toBe(0);
        // a half-blend of pure red on white unblends to red at half opacity
        const pink = decodeImageInMemory(new Uint8Array(decalTexture(solid(255, 128, 128), 1).png));
        expect(pink.rgba[mid]).toBe(255); expect(pink.rgba[mid + 1]).toBeLessThan(5); expect(Math.abs(pink.rgba[mid + 3] - 127)).toBeLessThan(3);
        // an image with its own alpha keeps its colour and alpha (times strength)
        const glass = decodeImageInMemory(new Uint8Array(decalTexture(solid(0, 200, 0, 100), 0.5).png));
        expect(glass.rgba[mid + 1]).toBe(200); expect(Math.abs(glass.rgba[mid + 3] - 50)).toBeLessThan(2);
        // the border stays clear, so a clamped patch shows nothing outside itself
        expect(black.rgba[3]).toBe(0);
    });

    it('covers the walls only by default, and roofs too or only named parts when asked', () => {
        expect(bakeDecal(boxGlb(), solid(0, 0, 0)).decalTriangles).toBe(8);
        expect(bakeDecal(boxGlb(), solid(0, 0, 0), { maxNormalY: 1 }).decalTriangles).toBe(10);
        expect(bakeDecal(boxGlb(), solid(0, 0, 0), { keep: n => n.includes('nothing') }).decalTriangles).toBe(0);
    });

    it('places one patch on the faces facing a heading: its centre at the asked fractions, clamped clear outside', () => {
        // south-facing faces only (heading 180): the south wall, 10 m wide, 6 m tall; a 2 x 1 m patch centred mid-wall at 3 m
        const out = bakeDecal(boxGlb(), solid(0, 0, 0), { headingDeg: 180, patch: { centre: [0.5, 0.5], sizeM: [2, 1] }, label: 'photo-inferred', name: 'sign' });
        expect(out.decalTriangles).toBe(2);
        const d = decalOf(out.glb);
        expect(d.node.name).toBe('sign');
        expect(d.node.extras.label).toBe('photo-inferred');
        expect(d.sampler.wrapS).toBe(33071);
        // the wall's corners map far outside 0..1 (the 2 m patch on a 10 m wall), symmetric about the centre
        const us = Array.from(d.uv.filter((_, i) => i % 2 === 0));
        expect(Math.min(...us)).toBeCloseTo(-2, 5);
        expect(Math.max(...us)).toBeCloseTo(3, 5);
    });

    it('reads left to right as seen from outside, on every side', () => {
        // the patch centre at 25% across: the x (or z) where u = 0.5, from the face's corners (u is linear across the face)
        const centreAt = (headingDeg: number, axis: 0 | 2) => {
            const out = bakeDecal(boxGlb(), solid(0, 0, 0), { headingDeg, headingToleranceDeg: 10, patch: { centre: [0.25, 0.5], sizeM: [1, 1] } });
            const { json, bin } = readGlbChunks(new Uint8Array(out.glb));
            const node = json.nodes.find((n: any) => n.extras?.decal);
            const prim = json.meshes[node.mesh].primitives[0];
            const get = (a: number, n: number) => { const acc = json.accessors[a], bv = json.bufferViews[acc.bufferView]; return new Float32Array(bin.buffer.slice(bin.byteOffset + bv.byteOffset, bin.byteOffset + bv.byteOffset + acc.count * n * 4)); };
            const p = get(prim.attributes.POSITION, 3), uv = get(prim.attributes.TEXCOORD_0, 2);
            const pts = Array.from({ length: p.length / 3 }, (_, i) => [p[i * 3 + axis], uv[i * 2]]);
            const [a, b] = [pts.reduce((m, q) => (q[0] < m[0] ? q : m)), pts.reduce((m, q) => (q[0] > m[0] ? q : m))];
            return a[0] + (0.5 - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
        };
        // south face (seen from the south, west = x 0 is on the left): 25% across is x 2.5; north face: x 7.5
        expect(centreAt(180, 0)).toBeCloseTo(2.5, 3);
        expect(centreAt(0, 0)).toBeCloseTo(7.5, 3);
        // east face (seen from the east, south = z 8 on the left): z 6; west face: z 2
        expect(centreAt(90, 2)).toBeCloseTo(6, 3);
        expect(centreAt(270, 2)).toBeCloseTo(2, 3);
    });

    it('makes a decal asset: a transparent PNG cut out of the white it was painted on, with its size and provenance', () => {
        const a = decalAsset(solid(0, 0, 0), { description: 'a black stencil', sizeM: [3, 1], tiles: false, label: 'generated', method: 'test', model: 'm' });
        expect(a.meta).toMatchObject({ schema: 'scratchbox.decal/1', description: 'a black stencil', sizeM: [3, 1], tiles: false, label: 'generated', pixels: [8, 8] });
        const img = decodeImageInMemory(new Uint8Array(a.png));
        expect(img.rgba[4 * (4 * img.width + 4) + 3]).toBe(255);
        const clear = decodeImageInMemory(new Uint8Array(decalAsset(solid(255, 255, 255), { description: 'nothing', sizeM: [1, 1], tiles: false, label: 'generated', method: 'test' }).png));
        expect(clear.rgba[4 * (4 * clear.width + 4) + 3]).toBe(0);
    });

    it('repeats every tileM metres when asked', () => {
        const d = decalOf(bakeDecal(boxGlb(), solid(0, 0, 0), { headingDeg: 180, tileM: 2.5 }).glb);
        expect(d.sampler.wrapS).toBe(10497);
        expect(Math.max(...Array.from(d.uv.filter((_, i) => i % 2 === 0)))).toBeCloseTo(4, 5);
    });
});
