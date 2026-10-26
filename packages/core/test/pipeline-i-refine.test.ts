/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageToRgbaSync } from '../src/node/image-codec-ffmpeg';
import { encodePng } from '../src/node/texture-processing';
import { PLATE_PIXEL_M, type Plate } from '../src/node/3d-engine/staged-location/pipeline-g/plates';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { registerToFootprint } from '../src/node/3d-engine/staged-location/pipeline-i/register';
import {
    compareFacade, fineShiftToParts, footprintFromParts, projectable, projectPlatesOntoGlb
} from '../src/node/3d-engine/staged-location/pipeline-i/refine';

/** A rectangular part, x0..x1 by z0..z1, from groundY 0 to topY. */
const part = (x0: number, x1: number, z0: number, z1: number, topY: number) => ({ id: 'p', baseY: 0, topY, loops: [[[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as Array<[number, number]>] });

/** A box model's vertices (x, y, z flat): a dense grid on its four walls and its roof, w x d x h, centred at the origin. */
function boxPoints(w: number, d: number, h: number): number[] {
    const out: number[] = [];
    for (let y = 0; y <= h; y += 0.5) {
        for (let x = -w / 2; x <= w / 2; x += 0.25) out.push(x, y, -d / 2, x, y, d / 2);
        for (let z = -d / 2; z <= d / 2; z += 0.25) out.push(-w / 2, y, z, w / 2, y, z);
    }
    for (let x = -w / 2; x <= w / 2; x += 0.5) for (let z = -d / 2; z <= d / 2; z += 0.5) out.push(x, h, z);
    return out;
}

/** A plate of the face with `fill` deciding each texel's colour and relief (undefined: unseen). */
function plate(face: number, key: string, wM: number, hM: number, fill: (x: number, y: number) => { rgb: [number, number, number]; relief: number } | undefined): Plate {
    const w = Math.round(wM / PLATE_PIXEL_M), h = Math.round(hM / PLATE_PIXEL_M);
    const rgb = new Uint8Array(w * h * 3).fill(128), relief = new Float32Array(w * h).fill(NaN);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = fill(x, y);
        if (!v) continue;
        rgb.set(v.rgb, (y * w + x) * 3); relief[y * w + x] = v.relief;
    }
    return { face, key, w, h, widthM: wM, heightM: hM, rgb, relief, coverage: 1, stations: [1] };
}

/** Windows: dark 1 x 1.5 m openings on a 3 m grid, the rest a light wall. */
const windows = (dx = 0) => (x: number, y: number) => {
    const u = ((x * PLATE_PIXEL_M - dx) % 3 + 3) % 3, v = (y * PLATE_PIXEL_M) % 3;
    return { rgb: (u > 1 && u < 2 && v > 0.75 && v < 2.25 ? [30, 30, 40] : [200, 120, 90]) as [number, number, number], relief: 0 };
};

describe('pipeline I + H refinement', () => {
    it('rasterises the massing parts as the fit target, holes subtracted, height from the tallest part', () => {
        const withHole = { ...part(0, 10, 0, 10, 20), loops: [...part(0, 10, 0, 10, 20).loops, [[4, 4], [6, 4], [6, 6], [4, 6]] as Array<[number, number]>] };
        const fp = footprintFromParts([withHole, part(10, 14, 0, 4, 32)], 2);
        expect(fp.cells.size).toBe(100 - 4 + 16);
        expect(fp.cells.has('4,4')).toBe(false);
        expect(fp.cells.has('12,2')).toBe(true);
        expect(fp.heightM).toBe(30);
    });

    it('shifts the 1 m fit onto the massing walls on a 0.25 m grid', () => {
        // a 12 x 8 m box against a 12 x 8 m part offset by half a metre: the coarse fit is out by up to 0.5 m
        const pts = boxPoints(12, 8, 20);
        const parts = [part(0.5, 12.5, 0.5, 8.5, 20)];
        const coarse = registerToFootprint(pts, footprintFromParts(parts, 0));
        const fine = fineShiftToParts(pts, coarse, parts);
        expect(fine.wallDistanceM[1]).toBeLessThan(0.2);
        // a corner of the box lands on the part's corner within the grid step
        const m = fine.fit.matrix, c = [-6, 10, -4];
        const x = m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12], z = m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14];
        const corners = [[0.5, 0.5], [12.5, 0.5], [12.5, 8.5], [0.5, 8.5]];
        expect(Math.min(...corners.map(([px, pz]) => Math.hypot(x - px, z - pz)))).toBeLessThan(0.5);
        expect(fine.fit.matrix[12] - coarse.matrix[12]).toBeCloseTo(fine.shift[0], 9);
    });

    it('scores a model facade against the scan plate: in place beats displaced; relief gates the projection', () => {
        const scan = plate(0, 'w0', 12, 9, windows());
        const same = compareFacade(scan, plate(0, 'w0', 12, 9, windows()));
        const off = compareFacade(scan, plate(0, 'w0', 12, 9, windows(1.2)));
        expect(same.f).toBeGreaterThan(0.95);
        expect(off.f).toBeLessThan(same.f - 0.3);
        expect(same.overlap).toBe(1);
        expect(projectable(same)).toBe(true);

        const proud = compareFacade(scan, plate(0, 'w0', 12, 9, (x, y) => ({ ...windows()(x, y), relief: 1.2 })));
        expect(proud.modelReliefM).toBeCloseTo(1.2, 5);
        expect(projectable(proud)).toBe(false);
        const halfSeen = compareFacade(scan, plate(0, 'w0', 12, 9, (x, y) => (y < 20 ? windows()(x, y) : undefined)));
        expect(halfSeen.overlap).toBeLessThan(0.25);
        expect(projectable(halfSeen)).toBe(false);
    });

    it('bakes the plate colours into the model texture where its triangles lie on the face, and nowhere else', () => {
        // a wall quad in the plane z = 0 facing +z (10 x 10 m) plus a roof quad, one 64 x 64 texture split between them
        const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 10, 0, 10, 10, 0, 10, 10, -10, 0, 10, -10]);
        const uvs = new Float32Array([0, 1, 0.5, 1, 0.5, 0, 0, 0, 0.5, 1, 1, 1, 1, 0, 0.5, 0]);
        const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]);
        const tex = Buffer.alloc(64 * 64 * 4);
        for (let i = 0; i < tex.length; i += 4) tex.set([0, 255, 0, 255], i);
        const png = encodePng(64, 64, tex);
        const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
        const parts = [Buffer.from(positions.buffer), Buffer.from(uvs.buffer), pad(Buffer.from(indices.buffer)), pad(png)];
        const offs = parts.reduce<number[]>((a, p, i) => [...a, i ? a[i - 1] + parts[i - 1].length : 0], []);
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
            meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0 }] }],
            materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 3, mimeType: 'image/png' }],
            buffers: [{ byteLength: parts.reduce((a, p) => a + p.length, 0) }],
            bufferViews: [{ buffer: 0, byteOffset: offs[0], byteLength: 96 }, { buffer: 0, byteOffset: offs[1], byteLength: 64 }, { buffer: 0, byteOffset: offs[2], byteLength: 24 }, { buffer: 0, byteOffset: offs[3], byteLength: png.length }],
            accessors: [
                { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, -10], max: [10, 10, 0] },
                { bufferView: 1, componentType: 5126, count: 8, type: 'VEC2' },
                { bufferView: 2, componentType: 5123, count: 12, type: 'SCALAR' }
            ]
        };
        const glb = assembleGlb(json, Buffer.concat(parts));
        const face = { index: 0, key: 'w0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0], sMin: 0, sMax: 10, tMin: 0, tMax: 10, tBottom: 0, area: 100, pixel: 0.05, orthoSMin: 0, orthoTMax: 10, width: 200, height: 200, coverage: 1, openings: [], top: [] } as unknown as MassingFace;
        // the plate saw only its left half (red); the right half is unseen
        const pl = plate(0, 'w0', 10, 10, x => (x < 100 ? { rgb: [255, 0, 0], relief: 0 } : undefined));
        const out = projectPlatesOntoGlb(glb, [{ face, plate: pl }]);

        const { json: j2, bin } = parseGlbBytes(out.glb);
        const bv = j2.bufferViews[j2.images[0].bufferView];
        const img = decodeImageToRgbaSync(Buffer.from(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength));
        const at = (x: number, y: number) => Array.from(img.rgba.subarray((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
        expect(at(4, 32)).toEqual([255, 0, 0]);   // wall, seen half: the plate's colour
        expect(at(28, 32)).toEqual([0, 255, 0]);  // wall, unseen half: the model's own
        expect(at(48, 32)).toEqual([0, 255, 0]);  // roof: normal disagrees, untouched
        expect(out.perFace.w0).toBe(out.texels);
        expect(out.texels).toBeGreaterThan(400);
        expect(out.texels).toBeLessThan(32 * 64);
    });
});
