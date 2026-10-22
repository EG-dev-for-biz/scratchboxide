/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Generated surface textures (surface-texture-generator.ts) and their index (surface-texture-library.ts): an image that does
 * not tile is quilted onto itself until its wrap is no different from its interior; a depth reading of a receding plane
 * with bumps on it gives the bumps as relief, not the plane; the fine band of a reading is scale-free; a whole generation
 * with stand-in models (no model is called) yields maps that tile and an entry the index accepts, labelled generated.
 */

import { describe, expect, it } from 'vitest';
import { fineReliefBand, generateSurfaceTexture, tileScaleContrast, parseSurfaceReading, quiltToTile, reliefFromDepth, wrapMismatch, wrapPad, type SurfaceTextureModels } from '../src/node/3d-engine/surface-texture-generator';
import { rankSurfaceTextures, surfaceTint, validateSurfaceTextureIndex, SURFACE_TEXTURE_SCHEMA, type SurfaceTextureEntry } from '../src/common/spatial/surface-texture-library';

/** A deterministic non-tiling image: bricks whose rows drift and whose colour ramps left to right. */
function bricks(w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const row = Math.floor(y / 16), xs = x + row * 11 + y * 0.3;
        const joint = y % 16 < 2 || xs % 40 < 3;
        const i = (y * w + x) * 4, base = joint ? 200 : 120 + (x / w) * 60 + ((row * 37) % 23);
        out[i] = base; out[i + 1] = joint ? 200 : base * 0.5; out[i + 2] = joint ? 200 : base * 0.4; out[i + 3] = 255;
    }
    return out;
}

describe('surface texture generation', () => {
    it('quilts an image that does not tile until its wrap is like its interior, the same cut applied to every map', () => {
        const w = 200, h = 160, img = bricks(w, h), other = img.map((v, i) => (i % 4 === 3 ? 255 : 255 - v));
        expect(wrapMismatch(img, w, h)).toBeGreaterThan(3);
        const q = quiltToTile([img, other], w, h, 0.12, 2);
        expect(q.width).toBe(w - Math.round(0.12 * w));
        expect(q.height).toBe(h - Math.round(0.12 * h));
        expect(wrapMismatch(q.maps[0], q.width, q.height)).toBeLessThan(2);
        // the second map took the same cut: it is still the first's inverse
        for (let i = 0; i < q.maps[0].length; i += 4) expect(Math.abs(q.maps[1][i] - (255 - q.maps[0][i]))).toBeLessThanOrEqual(1);
    });

    it('reads relief from a depth reading of a receding plane: the bumps stay, the plane goes', () => {
        const n = 64, pad = 16, m = n + 2 * pad;
        const depth = new Float32Array(m * m);
        // a plane receding upward (larger depth at the top) plus a bump every 16 px (nearer, so higher)
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
            const bx = ((x - pad) % 16 + 16) % 16, by = ((y - pad) % 16 + 16) % 16;
            depth[y * m + x] = 5 + 3 * (1 - y / m) - (bx >= 4 && bx < 12 && by >= 4 && by < 12 ? 0.2 : 0);
        }
        const h = reliefFromDepth(depth, n, pad, 0.25);
        const at = (x: number, y: number) => h[y * n + x];
        // a bump near the top and one near the bottom stand equally high; the gaps between are low
        expect(Math.abs(at(8, 8) - at(8, 56))).toBeLessThan(0.15);
        expect(at(8, 8)).toBeGreaterThan(at(1, 8) + 0.4);
        expect(at(8, 56)).toBeGreaterThan(at(1, 56) + 0.4);
    });

    it('keeps a reading\'s fine band and drops its scale', () => {
        const size = 32, pad = 8, m = size + 2 * pad;
        const a = new Float32Array(m * m), b = new Float32Array(m * m);
        for (let i = 0; i < a.length; i++) { const x = i % m, y = Math.floor(i / m); a[i] = 2 + Math.sin(x * 1.3) * Math.cos(y * 1.1) + y * 0.05; b[i] = 10 * a[i]; }
        const fa = fineReliefBand(a, size, pad, 3), fb = fineReliefBand(b, size, pad, 3);
        for (let i = 0; i < fa.length; i++) expect(fb[i]).toBeCloseTo(fa[i], 4);
        expect(Math.abs(fa.reduce((s, v) => s + v, 0) / fa.length)).toBeLessThan(0.2);
    });

    it('generates maps that tile and an entry the index accepts, labelled generated (stand-in models, nothing called)', async () => {
        const calls: string[] = [];
        const models: SurfaceTextureModels = {
            async paint(prompt, aspect) { calls.push(`paint ${aspect}`); expect(prompt).toMatch(/brick/); return { rgba: bricks(300, 300), width: 300, height: 300, model: 'stand-in-image' }; },
            async depth(img) {
                calls.push('depth');
                const d = new Float32Array(img.width * img.height);
                for (let i = 0; i < d.length; i++) d[i] = 1 + (255 - img.rgba[i * 4 + 1]) / 255;   // mortar (pale) reads nearer
                return { depths: d, model: 'stand-in-depth' };
            },
            async read() { calls.push('read'); return JSON.stringify({ spanM: [1.4, 1.4], reliefM: 0.01, roughness: 0.85, metallic: 0, appearance: 'red brick in stretcher bond' }); },
            resize: (rgba, w, h, size) => {
                const out = new Uint8Array(size * size * 4);
                for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out.set(rgba.subarray((Math.floor(y * h / size) * w + Math.floor(x * w / size)) * 4, (Math.floor(y * h / size) * w + Math.floor(x * w / size)) * 4 + 4), (y * size + x) * 4);
                return out;
            }
        };
        const g = await generateSurfaceTexture({ id: 'brick_test', prompt: 'a red brick wall', realSizeM: [1.4, 1.4] }, models, { sizePx: 128, quiltBand: 0.12, quiltFeatherPx: 2, maxTileScaleContrast: 1, paintAttempts: 3, depthPad: 0.25, reliefHighPass: 0.125, fineBandFrac: 0.03, fineWeight: 0.6, hollowRoughness: 0.12 });
        expect(calls).toEqual(['paint 1:1', 'depth', 'depth', 'depth', 'depth', 'depth', 'read']);
        expect(g.wrapBefore).toBeGreaterThan(g.wrapAfter);
        expect(g.wrapAfter).toBeLessThan(2.5);
        expect(g.color.length).toBe(128 * 128 * 4);
        expect(g.entry.provenance).toBe('generated');
        expect(g.entry.source).toMatchObject({ model: 'stand-in-image', heightModel: 'stand-in-depth' });
        expect(g.entry.surface.normalSlopeMean).toBeGreaterThan(0);
        expect(g.entry.surface.roughnessMean).toBeGreaterThan(0.8);
        const entry: SurfaceTextureEntry = { ...g.entry, maps: { color: 'brick_test/color.jpg', normal: 'brick_test/normal.jpg', roughness: 'brick_test/roughness.jpg' } };
        expect(validateSurfaceTextureIndex({ schema: SURFACE_TEXTURE_SCHEMA, about: 'x', conventions: {}, surfaces: [entry] })).toEqual([]);
        expect(validateSurfaceTextureIndex({ schema: SURFACE_TEXTURE_SCHEMA, about: 'x', conventions: {}, surfaces: [{ ...entry, source: undefined }] })[0]).toMatch(/names its model/);
        // tinting lands the mean on a measured colour; ranking puts a near colour first
        const tint = surfaceTint(entry, [0.2, 0.1, 0.05]);
        tint.forEach((k, i) => expect(entry.colour.meanLinearRgb[i] * k).toBeCloseTo([0.2, 0.1, 0.05][i], 3));
        const grey: SurfaceTextureEntry = { ...entry, id: 'grey', colour: { ...entry.colour, meanLab: [50, 0, 0] } };
        const index = { schema: SURFACE_TEXTURE_SCHEMA, about: 'x', conventions: {}, surfaces: [grey, entry] } as const;
        expect(rankSurfaceTextures(index as never, { meanLab: entry.colour.meanLab })[0].id).toBe('brick_test');
    });

    it('parses the surface reading and refuses a reply without its numbers', () => {
        expect(parseSurfaceReading('```json\n{"spanM":[2,2],"reliefM":0.01,"roughness":0.9,"metallic":0,"appearance":"asphalt"}\n```')).toMatchObject({ spanM: [2, 2], roughness: 0.9 });
        expect(parseSurfaceReading('{"spanM":[2],"reliefM":0.01,"roughness":0.9,"metallic":0,"appearance":"x"}')).toBeUndefined();
        expect(wrapPad(new Uint8Array([1, 2, 3, 4]), 1, 1).length).toBe(9 * 4);
    });
    it('scores a tile with a large stain as repeating and a fine pattern as not', () => {
        // bricks with no tile-scale ramp (bricks() ramps its colour across the image, which is tile-scale variation)
        const n = 128, fine = new Uint8Array(n * n * 4);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const row = Math.floor(y / 16), joint = y % 16 < 2 || (x + row * 16) % 32 < 3, v = joint ? 200 : 130 + ((row * 37 + Math.floor((x + row * 16) / 32) * 11) % 23);
            fine.set([v, joint ? 200 : v * 0.5, joint ? 200 : v * 0.4, 255], (y * n + x) * 4);
        }
        const stained = Uint8Array.from(fine);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (Math.hypot(x - 40, y - 60) < 18) for (let c = 0; c < 3; c++) stained[(y * n + x) * 4 + c] *= 0.55;
        expect(tileScaleContrast(fine, n)).toBeLessThan(0.09);
        expect(tileScaleContrast(stained, n)).toBeGreaterThan(0.09);
    });
});

