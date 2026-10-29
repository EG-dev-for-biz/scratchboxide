/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tile-only material harvest: texture energy measured at the tile's texel (bands it cannot resolve left out), a library
 * set measured as the tiles would show it, and appearance classes read from the wall alone (fitted windows left out) with
 * their texture.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { libraryTextureEnergy, TEXTURE_BANDS_M, textureDistance } from '../src/node/3d-engine/staged-location/pipeline-k/material-harvest';
import { readRegionClasses } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

/** A set's colour map: grey stone with 8 cm dark joints every `jointM` metres over a tile `sizeM` metres square (1024 px). */
function stone(sizeM: number, jointM: number): RgbaImage8 {
    const W = 1024, rgba = new Uint8Array(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const xm = (x / W) * sizeM, ym = (y / W) * sizeM;
        const joint = xm % jointM < 0.08 || ym % jointM < 0.08;
        const v = joint ? 90 : 180;
        rgba.set([v, v, v - 8, 255], (y * W + x) * 4);
    }
    return { width: W, height: W, rgba };
}

describe('texture energy at the tile texel', () => {
    it('reads a fine-jointed stone with more fine-band energy than a coarse-jointed one, and leaves out bands under two texels', () => {
        const fine = libraryTextureEnergy(stone(2.4, 0.3), [2.4, 2.4], 0.077), coarse = libraryTextureEnergy(stone(2.4, 1.2), [2.4, 2.4], 0.077);
        expect(fine.energy).toHaveLength(TEXTURE_BANDS_M.length);
        expect(fine.energy.every(Number.isFinite)).toBe(true);
        // the 0.3 m band: the fine joints show, the coarse joints barely
        expect(fine.energy[0]).toBeGreaterThan(coarse.energy[0] * 1.5);
        // at a 0.3 m texel the 0.3 m band is not resolved
        expect(Number.isNaN(libraryTextureEnergy(stone(2.4, 0.3), [2.4, 2.4], 0.3).energy[0])).toBe(true);
    });

    it('measures distances on the bands both resolve', () => {
        expect(textureDistance([0.01, 0.02, 0.04], [0.01, 0.02, 0.04])).toBe(0);
        expect(textureDistance([0.01, 0.02, 0.04], [0.02, 0.02, 0.04])).toBeCloseTo(Math.log(2) / 3, 3);
        expect(textureDistance([NaN, 0.02, 0.04], [0.5, 0.02, 0.04])).toBe(0);
        expect(Number.isNaN(textureDistance([NaN], [0.1]))).toBe(true);
    });
});

describe('appearance classes from the wall alone', () => {
    // a 20 x 30 m facade at 0.1 m texels: light stone with a fine grain, dark windows (fitted) on a regular grid
    const PX = 0.1, W = 200, H = 300;
    const isWindow = (x: number, y: number) => (x * PX) % 4 >= 1.5 && (x * PX) % 4 < 3 && (y * PX) % 3.5 >= 1 && (y * PX) % 3.5 < 2.8;
    function photo(): RgbaImage8 {
        const rgba = new Uint8Array(W * H * 4);
        let s = 9;
        const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const v = isWindow(x, y) ? 25 : Math.round(170 + (rnd() - 0.5) * 50);
            rgba.set(isWindow(x, y) ? [v, v + 5, v + 15, 255] : [v, v - 4, v - 12, 255], (y * W + x) * 4);
        }
        return { width: W, height: H, rgba };
    }
    function scene(): { json: any; g: ReturnType<typeof parseGlbBytes>; img: RgbaImage8 } {
        const img = photo();
        const windows: number[] = [];
        // in the photo's UVs, v down from its top (as the photo's rows run)
        for (let y0 = 1; y0 < 30; y0 += 3.5) for (let x0 = 1.5; x0 < 20; x0 += 4) windows.push(x0 / 20, y0 / 30, (x0 + 1.5) / 20, Math.min(30, y0 + 1.8) / 30);
        const P = new Float32Array([0, 30, 0, 0, 0, 0, 20, 0, 0, 20, 30, 0]), UV = new Float32Array([0, 0, 0, 1, 1, 1, 1, 0]), I = new Uint32Array([0, 1, 2, 0, 2, 3]);
        const png = new Uint8Array(encodePng(W, H, Buffer.from(img.rgba), 4));
        const parts = [new Uint8Array(P.buffer), new Uint8Array(UV.buffer), new Uint8Array(I.buffer), png];
        const views: any[] = [];
        let o = 0;
        const bin = new Uint8Array(parts.reduce((a, b) => a + b.length + 4, 0));
        for (const b of parts) { bin.set(b, o); views.push({ buffer: 0, byteOffset: o, byteLength: b.length }); o += b.length; o += (4 - (o % 4)) % 4; }
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
            nodes: [{ mesh: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: windows, label: 'photo-inferred', source: 'test' } } } }],
            meshes: [{ name: 'facade_lattice_1', primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0, mode: 4 }] }],
            materials: [{ name: 'm0', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
            accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' }, { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' }],
            bufferViews: views, buffers: [{ byteLength: bin.length }]
        };
        const g = parseGlbBytes(assembleGlb(json as never, bin));
        return { json: g.json, g, img };
    }

    it('leaves the fitted windows out and measures each class\'s texture at the facade\'s texel; the colour-only reading keeps them', () => {
        const { json, g, img } = scene();
        const images = new Map([[0, { ...img, rgba: img.rgba.slice() }]]);
        const plain = readRegionClasses(json, images)!;
        const harvested = readRegionClasses(json, images, undefined, { g })!;
        // the windows (L about 10) are a class of the colour-only reading, and none of the harvest's
        expect(Math.min(...plain.map(c => c.meanLab[0]))).toBeLessThan(20);
        expect(Math.min(...harvested.map(c => c.meanLab[0]))).toBeGreaterThan(50);
        const wall = harvested.find(c => c.wall)!;
        expect(wall.texture!.texelM).toBeCloseTo(PX, 3);
        expect(wall.texture!.energy.some(Number.isFinite)).toBe(true);
        expect(wall.facades).toBe(1);
        expect(plain.every(c => c.texture === undefined)).toBe(true);
    });
});
