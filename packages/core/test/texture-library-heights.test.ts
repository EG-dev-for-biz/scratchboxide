/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The texture library's height maps (texture-library-heights.ts, pipeline-k/material-height.ts): the real depth estimated
 * from a set's own normal map and tile size, recovered on a surface of known depth in either normal convention and
 * refused where the two maps disagree; the index's height role; and the recess map a class's set is drawn with (inward
 * only, capped, scaled as the grain is).
 */

import { describe, expect, it } from 'vitest';
import { estimateHeightDepth, withHeightDepth, type LibraryHeights } from '../src/node/3d-engine/texture-library-heights';
import { mapRole } from '../src/node/3d-engine/texture-library';
import { HEIGHT_RELIEF, heightRecessMap } from '../src/node/3d-engine/staged-location/pipeline-k/material-height';
import type { TextureLibraryEntry } from '../src/common/spatial/texture-library-index';

const S = 256;
/** A seamless surface of `depthM` over a tile of `size` metres: its height map (0..255) and the normal map of exactly that surface. */
function surface(depthM: number, size: [number, number], green: 1 | -1) {
    const h = (x: number, y: number) => 0.5 + 0.25 * Math.sin((2 * Math.PI * 3 * x) / S) + 0.2 * Math.cos((2 * Math.PI * 5 * y) / S + (2 * Math.PI * 2 * x) / S);
    const height = { width: S, height: S, rgba: new Uint8Array(S * S * 4) }, normal = { width: S, height: S, rgba: new Uint8Array(S * S * 4) };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const k = (y * S + x) * 4, v = Math.round(h(x, y) * 255);
        height.rgba.set([v, v, v, 255], k);
        // metres per metre: x right, y up (image rows run down)
        const sx = (depthM * (h(x + 0.5, y) - h(x - 0.5, y)) * S) / size[0], sy = (depthM * (h(x, y - 0.5) - h(x, y + 0.5)) * S) / size[1];
        const l = Math.hypot(sx, sy, 1), n = [-sx / l, (green * -sy) / l, 1 / l];
        normal.rgba.set([Math.round((n[0] * 0.5 + 0.5) * 255), Math.round((n[1] * 0.5 + 0.5) * 255), Math.round((n[2] * 0.5 + 0.5) * 255), 255], k);
    }
    return { height, normal };
}

describe('texture library height maps', () => {
    it('indexes the publishers\' height maps as their own role, and nothing else new', () => {
        expect(mapRole('Bricks008/Bricks008_8K-PNG_Displacement.png')).toBe('height');
        expect(mapRole('aerial_asphalt_01/aerial_asphalt_01_disp_8k.png')).toBe('height');
        expect(mapRole('Bricks008/Bricks008_8K-PNG_NormalDX.png')).toBeUndefined();
        expect(mapRole('Bricks008/Bricks008_8K-PNG_NormalGL.png')).toBe('normal');
    });

    it('recovers a known depth from the normal map and the tile size, in either green convention', () => {
        for (const green of [1, -1] as const) for (const [depth, size] of [[0.012, [1.65, 1.65]], [0.04, [2, 3]]] as Array<[number, [number, number]]>) {
            const { height, normal } = surface(depth, size, green);
            const est = estimateHeightDepth(height, normal, size);
            if ('error' in est) throw new Error(est.error);
            expect(Math.abs(est.depthM - depth) / depth).toBeLessThan(0.08);
            expect(est.fit).toBeGreaterThan(0.9);
            expect(est.green).toBe(green);
        }
    });

    it('gives no depth where the height map is flat, unrelated to the normal map, or implausibly deep', () => {
        const { height, normal } = surface(0.01, [1, 1], 1);
        const flat = { ...height, rgba: new Uint8Array(height.rgba.length).fill(128) };
        expect(estimateHeightDepth(flat, normal, [1, 1])).toHaveProperty('error');
        // a height map of another surface: seeded noise
        let s = 7;
        const noise = { ...height, rgba: new Uint8Array(height.rgba.length) };
        for (let i = 0; i < S * S; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const v = s >>> 24; noise.rgba.set([v, v, v, 255], i * 4); }
        expect(estimateHeightDepth(noise, normal, [1, 1])).toHaveProperty('error');
        const deep = surface(0.5, [1, 1], 1);
        expect(estimateHeightDepth(deep.height, deep.normal, [1, 1])).toHaveProperty('error');
        expect(estimateHeightDepth(height, normal, [0, 1])).toHaveProperty('error');
    });

    it('labels an estimated depth as an estimate, and lets a publisher\'s depth win', () => {
        const entry = { id: 'A', publisher: 'ambientCG', maps: { color: 'c', height: 'h' }, downloadMB: 1, realSizeM: [1, 1], sizeSource: 'ambientCG metadata', appearance: '', tags: [], provenance: 'library' } as TextureLibraryEntry;
        const doc = { schema: 'scratchbox.texture-library-heights/1', version: 1, about: '', measuredAt: '', sets: { A: { depthM: 0.011, fit: 0.8, spread: 0.2, green: -1 }, B: { error: 'flat' } } } as LibraryHeights;
        const out = withHeightDepth(entry, doc);
        expect(out.heightDepthM).toBe(0.011);
        expect(out.heightDepthSource).toMatch(/estimated.*generated/);
        expect(withHeightDepth({ ...entry, heightDepthM: 0.02, heightDepthSource: 'ambientCG metadata' }, doc).heightDepthM).toBe(0.02);
        expect(withHeightDepth({ ...entry, id: 'B' }, doc).heightDepthM).toBeUndefined();
        expect(withHeightDepth({ ...entry, maps: { color: 'c' } }, doc).heightDepthM).toBeUndefined();
        expect(withHeightDepth({ ...entry, sizeSource: 'estimated from its preview by a vision model' }, doc).heightDepthSource).toMatch(/itself an estimate/);
    });
});

describe('pipeline K material height', () => {
    const { height } = surface(0.02, [1, 1], 1);

    it('draws the set\'s height as a recess below the surface: inward only, at its real depth', () => {
        const r = heightRecessMap(height, 0.02, 1, 'test')!;
        expect([r.map.width, r.map.height]).toEqual([S, S]);
        let min = 255, max = 0;
        for (let k = 0; k < S * S; k++) { min = Math.min(min, r.map.rgba[k * 4]); max = Math.max(max, r.map.rgba[k * 4]); }
        expect(max).toBe(255);
        // the surface spans about 0.9 of the black-to-white range: about 18 mm of 20 below its top
        expect(r.drawn.maxRecessM).toBeGreaterThan(0.015);
        expect(r.drawn.maxRecessM).toBeLessThanOrEqual(0.02);
        expect(min).toBe(Math.round(255 * (1 - r.drawn.maxRecessM / HEIGHT_RELIEF.capM)));
        expect(r.drawn.label).toBe('generated');
    });

    it('scales with the share of the grain drawn, caps at a few centimetres, and draws nothing too flat to show', () => {
        const full = heightRecessMap(height, 0.02, 1, 'test')!, half = heightRecessMap(height, 0.02, 0.5, 'test')!;
        expect(half.drawn.maxRecessM).toBeCloseTo(full.drawn.maxRecessM / 2, 3);
        const deep = heightRecessMap(height, 0.5, 1, 'test')!;
        expect(deep.drawn.maxRecessM).toBe(HEIGHT_RELIEF.capM);
        let min = 255;
        for (let k = 0; k < S * S; k++) min = Math.min(min, deep.map.rgba[k * 4]);
        expect(min).toBe(0);
        expect(heightRecessMap(height, 0.02, 0, 'test')).toBeUndefined();
        expect(heightRecessMap(height, 0.0002, 1, 'test')).toBeUndefined();
        expect(heightRecessMap(height, 0, 1, 'test')).toBeUndefined();
    });
});
