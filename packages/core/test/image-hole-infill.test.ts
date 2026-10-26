/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * image-hole-infill.ts: which pixels are holes, and that only hole pixels change when the answer passes the inpaint lock.
 * The image model is a local function here (it fills the magenta from the row's nearest real pixel), so nothing bills.
 */

import { describe, expect, it } from 'vitest';
import { findHoles, infillImageHoles } from '../src/node/image-hole-infill';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/texture-processing';

const W = 200, H = 150;
/** A smooth two-way gradient (a wall in soft light), a 40 x 30 white hole at (80, 60) and a 3 x 3 white speck at (10, 10). */
function wall(): RgbaImage8 {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        rgba[o] = 120 + Math.round(x * 0.2); rgba[o + 1] = 90 + Math.round(y * 0.2); rgba[o + 2] = 70; rgba[o + 3] = 255;
        const hole = (x >= 80 && x < 120 && y >= 60 && y < 90) || (x >= 10 && x < 13 && y >= 10 && y < 13);
        if (hole) { rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; }
    }
    return { width: W, height: H, rgba };
}

const isMagenta = (p: Uint8Array, o: number) => p[o] > 200 && p[o + 2] > 200 && p[o + 1] < 90;

/** Answers with the sent image, each magenta pixel replaced by the nearest real pixel to its left in the same row. */
const rowFill: EnhanceModelClient = async req => {
    const img = decodeImageInMemory(req.image.bytes);
    const p = Uint8Array.from(img.rgba);
    for (let y = 0; y < img.height; y++) {
        let last: number[] | undefined;
        for (let x = 0; x < img.width; x++) {
            const o = (y * img.width + x) * 4;
            if (isMagenta(p, o)) { if (last) p.set(last, o); }
            else last = [p[o], p[o + 1], p[o + 2]];
        }
    }
    return { bytes: new Uint8Array(encodePng(img.width, img.height, Buffer.from(p))), mimeType: 'image/png', modelUsed: 'local-row-fill', requestedModels: ['local-row-fill'], skippedModels: [], modelNote: 'local' };
};

/** Answers with the sent image unchanged: the holes stay magenta. */
const lazy: EnhanceModelClient = async req => ({ bytes: req.image.bytes, mimeType: 'image/png', modelUsed: 'local-lazy', requestedModels: ['local-lazy'], skippedModels: [], modelNote: 'local' });

describe('image hole infill', () => {
    it('finds the flat white region, not the small speck, and takes a mask as given', () => {
        const holes = findHoles(wall());
        expect(holes.reduce((a, v) => a + v, 0)).toBe(40 * 30);
        expect(holes[11 * W + 11]).toBe(0);
        expect(holes[70 * W + 100]).toBe(1);
        const mask = new Uint8Array(W * H); mask[5] = 1;
        expect(findHoles(wall(), { mask }).reduce((a, v) => a + v, 0)).toBe(1);
    });

    it('fills only the hole pixels when the answer passes the lock, and labels the fill generated', async () => {
        const src = wall();
        const res = await infillImageHoles({ image: src, client: rowFill, models: ['local-row-fill'] });
        expect(res.decision).toBe('accepted');
        expect(res.provenance?.label).toBe('generated');
        expect(res.filledPixels).toBe(res.holePixels);
        // no white left in the hole, the pixel there continues the wall
        const o = (75 * W + 100) * 4;
        expect(res.image.rgba[o + 2]).toBeLessThan(120);
        // every pixel outside the (grown) hole is the input's own
        let changedOutside = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            if (x >= 78 && x < 122 && y >= 58 && y < 92) continue;
            const q = (y * W + x) * 4;
            if (res.image.rgba[q] !== src.rgba[q] || res.image.rgba[q + 1] !== src.rgba[q + 1] || res.image.rgba[q + 2] !== src.rgba[q + 2]) changedOutside++;
        }
        expect(changedOutside).toBe(0);
    });

    it('leaves the image as it was, with the reason, when the answer keeps the holes', async () => {
        const src = wall();
        const res = await infillImageHoles({ image: src, client: lazy, models: ['local-lazy'] });
        expect(res.decision).toBe('rejected');
        expect(res.reason).toMatch(/magenta/);
        expect(res.image).toBe(src);
        expect(res.filledPixels).toBe(0);
    });

    it('says there is nothing to do when the image has no holes', async () => {
        const res = await infillImageHoles({ image: wall(), client: lazy, models: ['local-lazy'], colour: [0, 0, 255] });
        expect(res.decision).toBe('no_holes');
    });
});
