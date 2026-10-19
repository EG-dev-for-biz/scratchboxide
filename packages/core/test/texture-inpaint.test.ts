/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The last rung for occluded texels (texture-inpaint.ts): only texels an occluder hid and nothing real covers are sent, the
 * answer is kept only when it reproduces the real texels and joins them, and what it writes is labelled generated at the
 * generated rung. Stand-in image models (no network): one that fills well, one that leaves the hole, one that repaints all.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { packConfidenceTexel, unpackConfidenceTexel, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { inpaintMaskedTexels, INPAINT_RUNG } from '../src/node/3d-engine/staged-location/texture-inpaint';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import type { LaidOutUvAtlas } from '../src/node/3d-engine/staged-location/texture-uv';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/texture-processing';
import { facadeAtlas, facadeAlbedo } from './helpers/texture-pass-fixtures';

const SIDE = 64;
const inHole = (x: number, y: number) => x >= 24 && x < 40 && y >= 20 && y < 44;

/** The atlas as one rect; real texels (the facade colour) everywhere but the hole; every texel some view saw occluded. */
function scene(): { atlas: LaidOutUvAtlas; planes: BakedTexturePlanes; masked: Uint8Array } {
    const a = facadeAtlas(SIDE);
    const atlas = { ...a, layout: { rects: [{ x: 0, y: 0, width: SIDE, height: SIDE, kind: 'chart', mapIndex: 0 }] } } as unknown as LaidOutUvAtlas;
    const N = SIDE * SIDE, albedo = new Uint8Array(N * 4), conf = { width: SIDE, height: SIDE, data: new Uint8Array(N * 4) };
    for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) {
        if (inHole(x, y)) continue;
        const i = y * SIDE + x, c = facadeAlbedo((x + 0.5) / SIDE * 10, (1 - (y + 0.5) / SIDE) * 6);
        albedo.set([c[0], c[1], c[2], 255], i * 4);
        packConfidenceTexel(conf, i, 0, 0.5, 2);
    }
    return { atlas, planes: { layerKey: 'l2', width: SIDE, height: SIDE, albedo, confidence: conf, provenance: [{ source: 'tile-photo-transfer', label: 'photo-inferred', method: 't', coverage: 1 }], degradations: [] }, masked: new Uint8Array(N).fill(1) };
}

/** A stand-in model: `edit` gets the sent image (RGBA) and changes it in place. */
const model = (edit: (img: { width: number; height: number; rgba: Uint8Array }) => void): EnhanceModelClient => async req => {
    const img = decodeImageInMemory(req.image.bytes);
    edit(img);
    return { bytes: new Uint8Array(encodePng(img.width, img.height, Buffer.from(img.rgba))), modelUsed: req.models[0] } as any;
};
const isMagenta = (r: Uint8Array, i: number) => r[i * 4] > 200 && r[i * 4 + 2] > 200 && r[i * 4 + 1] < 90;

describe('inpainting the texels an occluder hid', () => {
    it('fills the hole when the answer keeps and joins the real texels, labelled generated; refuses one that leaves the hole or repaints it all', async () => {
        const s = scene();
        // fills each magenta pixel with the colour of the nearest non-magenta pixel in its row (a continuation of the surface)
        const good = model(img => {
            for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
                const i = y * img.width + x;
                if (!isMagenta(img.rgba, i)) continue;
                for (let d = 1; d < img.width; d++) {
                    const j = [x - d, x + d].map(xx => y * img.width + xx).find((jj, k) => { const xx = k ? x + d : x - d; return xx >= 0 && xx < img.width && !isMagenta(img.rgba, jj); });
                    if (j !== undefined) { img.rgba.set(img.rgba.subarray(j * 4, j * 4 + 3), i * 4); break; }
                }
            }
        });
        const r = await inpaintMaskedTexels({ ...s, client: good, models: ['nano-banana-lite-stand-in'] });
        expect(r.targetTexels).toBe(16 * 24);
        expect(r.filledTexels, JSON.stringify(r.records)).toBe(16 * 24);
        expect(r.records[0]).toMatchObject({ decision: 'accepted' });
        expect(r.records[0].metrics!.rimMedianDeltaE!).toBeLessThan(12);
        expect(r.planes!.provenance[0]).toMatchObject({ source: 'generated-inpaint', label: 'generated' });
        for (let i = 0; i < SIDE * SIDE; i++) {
            const inside = inHole(i % SIDE, (i / SIDE) | 0);
            expect(r.planes!.albedo[i * 4 + 3]).toBe(inside ? 255 : 0); // only the hole is written
            if (inside) expect(unpackConfidenceTexel(r.planes!.confidence, i).rung).toBe(INPAINT_RUNG);
        }
        // texels nobody saw occluded are never inpainted
        const none = await inpaintMaskedTexels({ ...s, masked: new Uint8Array(SIDE * SIDE), client: good, models: ['m'] });
        expect(none.targetTexels).toBe(0);
        expect(none.planes).toBeUndefined();

        const lazy = await inpaintMaskedTexels({ ...s, client: model(() => undefined), models: ['m'] });
        expect(lazy.filledTexels).toBe(0);
        expect(lazy.records[0].reason).toMatch(/magenta/);
        expect(lazy.degradations[0]).toMatchObject({ reasonCode: 'inpaint_not_filled' });
        const repaint = await inpaintMaskedTexels({ ...s, client: model(img => { for (let i = 0; i < img.width * img.height; i++) img.rgba.set([40, 90, 200], i * 4); }), models: ['m'] });
        expect(repaint.filledTexels).toBe(0);
        expect(repaint.records[0].reason).toMatch(/changed the real texels/);

        const out = path.resolve(__dirname, '../../../test-results/screenshots');
        fs.mkdirSync(out, { recursive: true });
        const merged = Uint8Array.from(s.planes.albedo);
        for (let i = 0; i < SIDE * SIDE; i++) if (r.planes!.albedo[i * 4 + 3]) merged.set(r.planes!.albedo.subarray(i * 4, i * 4 + 4), i * 4);
        fs.writeFileSync(path.join(out, 'texture_inpaint_masked.png'), encodePng(SIDE, SIDE, Buffer.from(merged)));
    });
});
